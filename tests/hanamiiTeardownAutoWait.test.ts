import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── このテストが固定すること（HANAMII が削除を受け付けた〔202〕あと、Koto が自分で完了を確かめて破棄を終える）──────────────
// **本物の main（registerHanamiiHandlers が登録するハンドラ）**を呼び、偽の HANAMII サーバ（fetch。GET と DELETE を別々の台本で答える）と
// 偽の保存場所に実際に流して、**どんな要求が・どの順で出たか**と、記録（.sakuraide.json）の中身を見る（ソースの文字列は読まない・掟10）。
//   ・202 → GET 200 → GET 404 → DELETE 404: 保存場所への最初の要求は、確かめの DELETE より**後**。ok:true で 📡 の行と projectId が消える
//   ・受け付けの印（publish.hanamii.deletionAccepted）: 待ち始める**前**に書かれ（中身は一字一句）、待ち切れなかった・確かめられなかった・確認が要る回は残る。
//     保存場所の段が済まなければ「保存場所が残った」印へ引き継がれ（受け付けの印は外れる）、済めば行ごと消える
//   ・待ち切れた回: 保存場所への要求0件・.sakuraide.json（印を除く）と env.json はそのまま・返り値は完全一致
//   ・requiresReview:true は待たず、要求は DELETE の1件だけ（'true' の文字列・項目の欠落は待つ）
//   ・D8: すべての GET・DELETE の Authorization は渡したトークン／掟4: IPC が返ったあとに要求は増えない／掟11: 待っている間は同じプロジェクトだけが busy
//   ・待っている間の進み具合は、そのプロジェクトの記録にだけ出て、トークンは伏せられている

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  /** HANAMII へ出た要求と、保存場所へ出た要求を、**1本の並び**で積む。 */
  calls: [] as string[],
  listThrows: false,
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => '/tmp', getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {} },
  dialog: {},
}))

vi.mock('../src/main/cloud/auth', async (importOriginal) => {
  const real = await importOriginal<any>()
  return { ...real, loadCredentials: () => ({ token: 'tok', secret: 'sec' }) }
})

vi.mock('../src/main/cloud/storageAdapter', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    createStorageAdapter: async () => {
      h.calls.push('storage connect')
      return {
        siteInfo: () => ({ s3Endpoint: 's3.isk01.sakurastorage.jp', region: 'jp-north-1' }),
        async isSiteReady() { return true },
        async ensureBucket() {},
        async putMarker() {},
        async listAllKeys(bucket: string) {
          h.calls.push(`list ${bucket}`)
          if (h.listThrows) throw new Error('一覧を取得できませんでした（テスト）')
          return [`${PREFIX}a.txt`]
        },
        async deleteKeys(bucket: string) { h.calls.push(`deleteKeys ${bucket}`) },
        async deleteBucket(bucket: string) { h.calls.push(`deleteBucket ${bucket}`) },
        async deletePermission(id: string) { h.calls.push(`deletePermission ${id}`) },
        async issueKey() { return { accessKey: 'AKIA-X', secretKey: 'S3CRET-X', permissionId: 'perm-tmp' } },
        async listPermissions() { h.calls.push('listPermissions'); return [{ id: 'perm-hanamii', displayName: 'koto-myapp-hanamii' }] },
        async dispose() {},
      }
    },
  }
})

import { registerHanamiiHandlers } from '../src/main/ipc/hanamii'
import { registerCloudTeardownHandlers } from '../src/main/ipc/cloudTeardown'
import { runningOp, projectBusyMessage } from '../src/main/projectLock'
import { getOps, resetProjectOpsForTests, setProjectOpsListener } from '../src/main/projectOps'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'
import { HANAMII_DELETION_ACCEPTED_WARNING, HANAMII_DELETION_REVIEW_WARNING, HANAMII_DELETION_WAIT_PROGRESS, HANAMII_ACCEPTED_MARK_FAILED_LINE } from '../src/shared/teardownResult'
import { STORAGE_TEARDOWN_PROGRESS } from '../src/shared/teardownSupport'
import { hanamiiDeletionAcceptedOf } from '../src/shared/publishMeta'
import { ACCEPTED_OPERATION_ID, deleteProjectReplyText, fastHanamiiDeletionWait, routedHanamiiFetch } from './hanamiiTeardownFixtures'
import { isolatedProjectDir } from './isolatedProject'
import { shownTeardown } from './shownFromEnv'

registerHanamiiHandlers({} as any)
registerCloudTeardownHandlers()
const teardown = shownTeardown(h.handlers.get('hanamii:teardown')!) // 画面の代わりに、確認で見せた保存場所（env.json の記録）を渡す

const EVENT = {}
const TOKEN = 'hnm_test_token'
const PROJECT_ID = 'hnm-proj-1'
const BUCKET = 'koto-data-x'
const PREFIX = 'projects/myapp/'
const DELETE_CALL = `DELETE https://hanamii.jp/api/v1/projects/${PROJECT_ID}`
const GET_CALL = `GET https://hanamii.jp/api/v1/projects/${PROJECT_ID}`
const isHanamiiCall = (c: string) => c.startsWith('DELETE https://') || c.startsWith('GET https://')

let projectDir = ''
let wait: ReturnType<typeof fastHanamiiDeletionWait>
const realFetch = globalThis.fetch

const readMeta = (): any => JSON.parse(fs.readFileSync(path.join(projectDir, '.sakuraide.json'), 'utf-8'))
const envText = () => fs.readFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), 'utf-8')
const metaText = () => fs.readFileSync(path.join(projectDir, '.sakuraide.json'), 'utf-8')
const markOf = () => readMeta().publish?.hanamii?.deletionAccepted
const storageCalls = () => h.calls.filter(c => !isHanamiiCall(c))
let auths: string[] = []

function install(get: Array<number | { status: number; text?: string }>, del: Array<number | { status: number; text?: string }>, extra: { onRequest?: (m: 'GET' | 'DELETE', n: number) => void | Promise<void> } = {}) {
  globalThis.fetch = routedHanamiiFetch({ projectId: PROJECT_ID, get, del, calls: h.calls, auths, ...extra })
}
/** 受け付け（202）の本文だけを差し替える。 */
const accepted = (opts: { requiresReview?: unknown; omitReview?: boolean } = {}) => ({ status: 202, text: deleteProjectReplyText(202, PROJECT_ID, opts) })
const call = (dir: string = projectDir, token: string = TOKEN) => teardown(EVENT, dir, { token }, { confirmed: true, projectId: PROJECT_ID })

beforeEach(() => {
  wait = fastHanamiiDeletionWait() // 待ちは偽の時計で回す（本物の sleep で待たない）
  resetProjectOpsForTests()
  projectDir = isolatedProjectDir('koto-hanamii-autowait-')
  h.calls = []
  h.listThrows = false
  auths = []
  const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: false })
  spec.persistence = { objectStorage: [{ bucket: BUCKET, prefix: PREFIX, shared: true, consentedAt: '2026-08-14T00:00:00.000Z' }] } as any
  fs.mkdirSync(path.join(projectDir, '.sakura-cloud'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), JSON.stringify(spec, null, 2), 'utf-8')
  fs.writeFileSync(path.join(projectDir, '.sakuraide.json'), JSON.stringify({
    publish: { hanamii: { projectId: PROJECT_ID }, targets: { hanamii: { publishedAt: '2026-09-29T00:00:00.000Z', url: null } } },
  }, null, 2), 'utf-8')
})
afterEach(() => {
  wait.restore()
  globalThis.fetch = realFetch
  setProjectOpsListener(null)
  fs.rmSync(projectDir, { recursive: true, force: true })
})

describe('★★★ 202 のあと、Koto が済むまで待ち、済んだと確かめてから保存場所へ進む', () => {
  it('★★★ 202 → GET 200 → GET 404 → DELETE 404: 保存場所への最初の要求は、確かめの DELETE より後。ok:true で 📡 の行と projectId が消える', async () => {
    install([200, 404], [accepted(), 404])
    const r = await call()
    expect(r.ok).toBe(true)
    expect(r.appDeleted).toBe(true)
    expect(r.deletionAccepted).toBeUndefined()
    const firstStorage = h.calls.findIndex(c => !isHanamiiCall(c))
    const deletes = h.calls.map((c, i) => (c === DELETE_CALL ? i : -1)).filter(i => i >= 0)
    expect(deletes, '最初の DELETE と確かめの DELETE の2本').toHaveLength(2)
    expect(firstStorage, '保存場所へ進んでいない').toBeGreaterThan(deletes[1])
    expect(h.calls[0]).toBe(DELETE_CALL)
    expect(h.calls.slice(1, deletes[1]).every(c => c === GET_CALL)).toBe(true)
    expect(h.calls).toContain(`deleteBucket ${BUCKET}`)
    const meta = readMeta()
    expect(meta.publish.targets?.hanamii, '全部済んだのに 📡 の行が残った').toBeUndefined()
    expect(meta.publish.hanamii.projectId).toBeNull()
    expect(meta.publish.hanamii.deletionAccepted, '受け付けの印が残った').toBeUndefined()
  })

  it('★★★ 受け付けの印は、待ち始める前（最初の GET より前）に書かれる。中身は一字一句（確認で見せた保存場所・requiresReview・operationId）', async () => {
    let atFirstGet: any = null
    install([404], [accepted(), 404], { onRequest: (m, n) => { if (m === 'GET' && n === 0) atFirstGet = markOf() } })
    const before = Date.now()
    await call()
    expect(atFirstGet, '最初の GET の時点で印が書かれていない').not.toBeNull()
    expect(Object.keys(atFirstGet).sort()).toEqual(['acceptedAt', 'operationId', 'projectId', 'requiresReview', 'shownPlacements'])
    expect(atFirstGet.projectId).toBe(PROJECT_ID)
    expect(atFirstGet.requiresReview).toBe(false)
    expect(atFirstGet.operationId).toBe(ACCEPTED_OPERATION_ID)
    expect(atFirstGet.shownPlacements).toEqual([{ bucket: BUCKET, prefix: PREFIX }])
    expect(new Date(atFirstGet.acceptedAt).toISOString(), 'ISO の時刻').toBe(atFirstGet.acceptedAt)
    expect(Date.parse(atFirstGet.acceptedAt)).toBeGreaterThanOrEqual(before - 1)
    // 読み手（shared）が同じ印として読める
    expect(hanamiiDeletionAcceptedOf({ publish: { hanamii: { deletionAccepted: atFirstGet } } })).toEqual(atFirstGet)
  })

  it('★★★ 印を書かなかった回（待っている間に記録の projectId が替わった: marked:false）は、書けなかった回と同じく「続きを自動で確かめる印を書けませんでした」を言う。続きの根拠が無いのに「自動で続ける」だけを言わない', async () => {
    install([200], [accepted(), 202], { onRequest: (m, n) => {
      if (m === 'DELETE' && n === 0) fs.writeFileSync(path.join(projectDir, '.sakuraide.json'), JSON.stringify({ publish: { hanamii: { projectId: 'hnm-proj-other' } } }), 'utf-8')
    } })
    const r = await call()
    expect(r.ok).toBe(false)
    expect(r.deletionAccepted).toBe(true)
    expect(r.executed?.some(l => l.startsWith(HANAMII_ACCEPTED_MARK_FAILED_LINE)), JSON.stringify(r.executed)).toBe(true)
    expect(markOf(), '別のプロジェクトの記録に印を書いた').toBeUndefined()
  })

  it('★★★ gone でも保存場所の段が済まなければ（一覧できない）、「保存場所が残った」印へ引き継ぐ: 受け付けの印は外れ、行と projectId は残る', async () => {
    h.listThrows = true
    install([404], [accepted(), 404])
    const r = await call()
    expect(r.ok).toBe(false)
    expect(r.appDeleted).toBe(true)
    expect(r.remainingBuckets).toEqual([BUCKET])
    const meta = readMeta()
    expect(meta.publish.hanamii.storageLeftoverBuckets).toEqual([BUCKET])
    expect(meta.publish.hanamii.deletionAccepted, '引き継いだのに受け付けの印が残った').toBeUndefined()
    expect(meta.publish.hanamii.projectId).toBe(PROJECT_ID)
    expect(meta.publish.targets.hanamii).toBeTruthy()
  })

  it('★★★ 受け付けではない回（200 deleted:true・404）は印を書かない（待ちも通らない）', async () => {
    for (const status of [200, 404]) {
      h.calls = []
      let atFirst: unknown = 'unset'
      globalThis.fetch = routedHanamiiFetch({ projectId: PROJECT_ID, get: [200], del: [status], calls: h.calls, auths, onRequest: () => { atFirst = markOf() } })
      const r = await call()
      expect(r.ok, String(status)).toBe(true)
      expect(atFirst === 'unset' || atFirst === undefined, String(status)).toBe(true)
      expect(h.calls.filter(c => c === GET_CALL), String(status)).toEqual([])
      // 次の回のために記録を戻す
      fs.writeFileSync(path.join(projectDir, '.sakuraide.json'), JSON.stringify({ publish: { hanamii: { projectId: PROJECT_ID }, targets: { hanamii: { publishedAt: '2026-09-29T00:00:00.000Z', url: null } } } }), 'utf-8')
    }
  })
})

describe('★★★ 待ち切れなかった回・確かめられなかった回: 保存場所にも記録の行にも触れず、印を残す', () => {
  it('★★★ 時間切れ（GET が 200 のまま）: 保存場所への要求0件・env.json は1バイトも変わらず・.sakuraide.json は印を足しただけ・「保存場所が残った」印も無い。返り値は完全一致', async () => {
    install([200], [accepted(), 202])
    const beforeMeta = JSON.parse(metaText())
    const beforeEnv = envText()
    const r = await call()
    expect(r).toEqual({ ok: false, appDeleted: false, deletionAccepted: true, message: HANAMII_DELETION_ACCEPTED_WARNING })
    expect(storageCalls(), '待ち切れなかったのに保存場所へ進んだ').toEqual([])
    expect(envText()).toBe(beforeEnv)
    const after = readMeta()
    expect(after.publish.hanamii.storageLeftoverBuckets).toBeUndefined()
    expect(hanamiiDeletionAcceptedOf(after)?.projectId, '印が残っていない').toBe(PROJECT_ID)
    delete after.publish.hanamii.deletionAccepted
    expect(after).toEqual(beforeMeta)
  })

  it('★★★ 待ち切れなかった回の、最後の確かめの DELETE が 404 なら済んだと読む（保険）', async () => {
    install([200], [accepted(), 404])
    const r = await call()
    expect(r.ok).toBe(true)
    expect(h.calls.filter(c => c === DELETE_CALL)).toHaveLength(2)
  })

  it('★★★ 確かめられなかった（GET が 503 を続けた）: 文の下に「詳細: HTTP 503」と operationId。印は残り、保存場所に触れない', async () => {
    install([503], [accepted()])
    const r = await call()
    expect(r).toEqual({
      ok: false, appDeleted: false, deletionAccepted: true,
      message: `${HANAMII_DELETION_ACCEPTED_WARNING}\n詳細: HTTP 503（operationId: ${ACCEPTED_OPERATION_ID}）`,
    })
    expect(storageCalls()).toEqual([])
    expect(markOf()?.projectId).toBe(PROJECT_ID)
  })

  it('★★ 確かめられなかった（GET が 403）: すぐ止まる。DELETE は最初の1本だけ', async () => {
    install([403], [accepted()])
    const r = await call()
    expect(r.deletionAccepted).toBe(true)
    expect(r.message).toContain('詳細: HTTP 403')
    expect(h.calls.filter(c => c === DELETE_CALL)).toHaveLength(1)
    expect(storageCalls()).toEqual([])
  })

  it('★★ 受け付けの印を書けなかった回（記録が読み取り専用）は、続きの自動の確かめが効かないことを executed の ⚠️ で言う', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return // root は書けてしまう
    install([200], [accepted(), 202])
    fs.chmodSync(path.join(projectDir, '.sakuraide.json'), 0o444)
    try {
      const r = await call()
      expect(r.deletionAccepted).toBe(true)
      expect(r.executed?.[0]?.startsWith(`${HANAMII_ACCEPTED_MARK_FAILED_LINE}: `), '原因が付いていない').toBe(true)
      expect(r.executed?.[0]?.length).toBeGreaterThan(HANAMII_ACCEPTED_MARK_FAILED_LINE.length + 2)
      expect(r.executed?.[0]).not.toContain('印')
    } finally {
      fs.chmodSync(path.join(projectDir, '.sakuraide.json'), 0o644)
    }
  })
})

describe('★★★ requiresReview: 待たずに止める', () => {
  it('★★★ requiresReview:true → 要求は DELETE の1件だけ。deletionReview:true。保存場所・env.json・行は触れず、印は残る（requiresReview:true・operationId つき）', async () => {
    install([404], [accepted({ requiresReview: true })])
    const beforeEnv = envText()
    const r = await call()
    expect(r).toEqual({ ok: false, appDeleted: false, deletionAccepted: true, deletionReview: true, message: HANAMII_DELETION_REVIEW_WARNING })
    expect(h.calls, '確認が要るのに待った・保存場所へ進んだ').toEqual([DELETE_CALL])
    expect(envText()).toBe(beforeEnv)
    expect(markOf()).toMatchObject({ projectId: PROJECT_ID, requiresReview: true, operationId: ACCEPTED_OPERATION_ID })
    expect(readMeta().publish.targets.hanamii).toBeTruthy()
  })

  it.each([['文字列 "true"', 'true'], ['数値 1', 1], ['null', null]])('★★ requiresReview が %s → 偽として待つ（GET が出る）', async (_n, value) => {
    install([404], [accepted({ requiresReview: value }), 404])
    const r = await call()
    expect(r.ok).toBe(true)
    expect(h.calls).toContain(GET_CALL)
  })

  it('★★ requiresReview の項目が無い → 偽として待つ', async () => {
    install([404], [accepted({ omitReview: true }), 404])
    const r = await call()
    expect(r.ok).toBe(true)
    expect(h.calls).toContain(GET_CALL)
    expect(markOf()).toBeUndefined() // 済んだので印は行ごと消えた
  })
})

describe('★★★ トークン（D8）・IPC のあとの要求（掟4）・鍵（掟11）・進み具合', () => {
  it('★★★ すべての GET・DELETE の Authorization は、渡したトークンだけ', async () => {
    install([200, 404], [accepted(), 404])
    await call()
    expect(auths.length).toBeGreaterThanOrEqual(4)
    expect([...new Set(auths)]).toEqual([`Bearer ${TOKEN}`])
  })

  it('★★★ IPC が返ったあとは、時計を進めても、時間が経っても、fetch は1本も増えない（トークンを IPC の外へ持ち出していない）', async () => {
    install([200], [accepted(), 202])
    // 呼ぶ前に偽のタイマーを入れる: 呼んでいる間に main が仕掛けたタイマー（返ったあとに出る要求）を、時計を進めて捕まえる
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    try {
      await call()
      const n = h.calls.length
      expect(vi.getTimerCount(), '返ったあとにタイマーが残っている').toBe(0)
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(h.calls).toHaveLength(n)
    } finally { vi.useRealTimers() }
  })

  it('★★★ 最初の DELETE から20秒あけて、確かめの DELETE を送る（本物の main が deleteJustSent を渡す。すぐ 404 でも DELETE が数ミリ秒の間に2本続かない）', async () => {
    const at: number[] = []
    install([404], [accepted(), 404], { onRequest: m => { if (m === 'DELETE') at.push(wait.now()) } })
    const r = await call()
    expect(r.ok).toBe(true)
    expect(at).toHaveLength(2)
    expect(at[1] - at[0], 'DELETE の間隔が20秒未満').toBeGreaterThanOrEqual(20_000)
  })

  it('★★★ 待っている間は、同じプロジェクトの hanamii:publish・hanamii:teardown・cloud:teardown が busy で断られ、要求は増えない。別のプロジェクトは断られない', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(open => { release = open })
    let entered: () => void = () => {}
    const inWait = new Promise<void>(open => { entered = open })
    install([200, 404], [accepted(), 404], { onRequest: async (m, n) => { if (m === 'GET' && n === 0) { entered(); await gate } } })
    const first = call()
    await inWait
    expect(runningOp(projectDir)).toBe('削除')
    const before = [...h.calls]
    const busy = projectBusyMessage('削除', 'hanamii')
    const publish = await h.handlers.get('hanamii:publish')!({}, projectDir, { token: TOKEN, workspaceId: 'ws-1', name: 'myapp' })
    const again = await call()
    const cloud = await h.handlers.get('cloud:teardown')!({}, projectDir, { heldByMain: true }, { confirmed: true, deleteRegistry: false, registryName: null })
    for (const r of [publish, again, cloud]) {
      expect(r.ok).toBe(false)
      expect(r.message).toBe(busy)
    }
    expect(h.calls, '待っている間の断りが、外へ要求を出した').toEqual(before)
    // 別のプロジェクトは断られない（掟11。記録が無いので中身の照合で断られるが、busy ではない）
    const other = isolatedProjectDir('koto-hanamii-autowait-other-')
    const o = await call(other)
    expect(o.message).not.toBe(busy)
    release()
    expect((await first).ok).toBe(true)
    expect(runningOp(projectDir) ?? null).toBeNull()
  })

  it('★★★ 進み具合は、そのプロジェクトの記録にだけ「⏳ …待っています…」と「N秒経過」が出て、トークンは伏せられている', async () => {
    const seen: Array<{ label: string; detail: string }> = []
    setProjectOpsListener((_dir: string, snap: any) => { if (snap?.running?.progress) seen.push({ label: snap.running.progress.label, detail: snap.running.progress.detail }) })
    install([200, 200, 404], [accepted(), 404])
    await call()
    const waits = seen.filter(s => s.label === HANAMII_DELETION_WAIT_PROGRESS)
    expect(waits.length).toBeGreaterThanOrEqual(2)
    expect(waits[0].detail).toBe('0秒経過')
    expect(waits.every(s => /^\d+秒経過$/.test(s.detail))).toBe(true)
    expect(seen.some(s => s.label === STORAGE_TEARDOWN_PROGRESS), '済んだあとに保存場所の文へ移る').toBe(true)
    expect(JSON.stringify(seen)).not.toContain(TOKEN)
    // 別のプロジェクトの記録には、待ちの文が出ない
    const other = isolatedProjectDir('koto-hanamii-autowait-other2-')
    expect(getOps(other).running).toBeNull()
    expect(getOps(other).last).toBeNull()
  })

  it('★★ 待ちの末尾の記録（結果の extra）に deletionAccepted が載り、途中の結果として読める（待っている間は途中の結果を出さない）', async () => {
    install([200], [accepted(), 202])
    await call()
    const last = getOps(projectDir).last
    expect(last?.result?.ok).toBe(false)
    expect(last?.result?.extra?.deletionAccepted).toBe(true)
  })
})
