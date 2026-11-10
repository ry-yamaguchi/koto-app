import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── このテストが固定すること（HANAMII の破棄の自動の続き hanamii:resumeTeardown。次に Koto を開いたとき、受け付けの印があるプロジェクトだけが続く）──────
// **本物の main** を呼び、偽の HANAMII サーバ（GET と DELETE を別々の台本で答える fetch）と偽の保存場所に実際に流して、出た要求の並びと記録を見る。
//   ・印が無い・印の形が壊れている・印の projectId が記録と違う・渡した projectId が違う・複製がいる・トークンが無い → HANAMII へも保存場所へも**要求0件**で断る
//     （確認の印〔confirmed〕も shownPlacements も、画面が渡した値では進まない）
//   ・印あり・GET 404・DELETE 404 → **最初の要求は GET**（DELETE は送らない）。印の shownPlacements だけを消し、記録の行が消える
//   ・印の shownPlacements に無い保存場所は消さない（`keepData` の保存場所も消さない）
//   ・トークンは渡されたものだけ（Authorization）／IPC が返ったあとに要求は増えない／待っている間は busy
//   ・待ち切れなかった回は印を残し、保存場所へ触れない。requiresReview の印でも続けて試みる（済めば片づき、済まなければまた印を残して「確認が要る」と言う）
//   ・続きで済んだ回は、前の「受け付けただけ」（途中）を上部から外す（projectOps）

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
import { HANAMII_DELETION_ACCEPTED_WARNING, HANAMII_DELETION_REVIEW_WARNING, HANAMII_RESUME_NO_MARK_MESSAGE } from '../src/shared/teardownResult'
import { PROJECT_MISMATCH_TEARDOWN } from '../src/main/ipc/hanamiiTeardown'
import { twinsRefusedMessage, runTeardownShell } from '../src/main/cloud/teardownShell'
import { HANAMII_RESUME_SHELL } from '../src/main/ipc/hanamiiResumeTeardown'
import { ACCEPTED_OPERATION_ID, deleteProjectReplyText, fastHanamiiDeletionWait, routedHanamiiFetch } from './hanamiiTeardownFixtures'
import { isolatedProjectDir, workspaceDirOf } from './isolatedProject'
import { writeHanamiiProjectIdFs, writePublishRecordFs } from '../src/main/publishMetaFs'

registerHanamiiHandlers({} as any)
registerCloudTeardownHandlers()
const resume = h.handlers.get('hanamii:resumeTeardown')!
const teardown = h.handlers.get('hanamii:teardown')!

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


const MARK = (over: Record<string, unknown> = {}) => ({
  projectId: PROJECT_ID,
  acceptedAt: '2026-11-09T01:00:00.000Z',
  shownPlacements: [{ bucket: BUCKET, prefix: PREFIX }],
  requiresReview: false,
  operationId: ACCEPTED_OPERATION_ID,
  ...over,
})
/** 記録（行・projectId）に、受け付けの印を足す（印の中身の形は、本物の main が書くものと同じ）。 */
function putMark(mark: unknown = MARK()): void {
  const m = readMeta()
  m.publish.hanamii.deletionAccepted = mark
  fs.writeFileSync(path.join(projectDir, '.sakuraide.json'), JSON.stringify(m, null, 2), 'utf-8')
}
/** 保存場所を、バケット名の並びで置き直す。 */
function putBuckets(buckets: string[]): void {
  const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: false })
  spec.persistence = { objectStorage: buckets.map(bucket => ({ bucket, prefix: PREFIX, shared: true, consentedAt: '2026-08-14T00:00:00.000Z' })) } as any
  fs.writeFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), JSON.stringify(spec, null, 2), 'utf-8')
}
const call = (over: { dir?: unknown; auth?: unknown; opts?: unknown } = {}) =>
  resume(EVENT, 'dir' in over ? over.dir : projectDir, 'auth' in over ? over.auth : { token: TOKEN }, 'opts' in over ? over.opts : { projectId: PROJECT_ID })
const OPTS = { projectId: PROJECT_ID }

describe('★★★ 歯止め: 印が無い・合わない回は、HANAMII へも保存場所へも要求を1件も出さずに断る', () => {
  it('★★★ 受け付けの印が無い → 要求0件。HANAMII_RESUME_NO_MARK_MESSAGE。記録も env.json も変わらない。画面が confirmed・shownPlacements を渡しても進まない', async () => {
    install([404], [404])
    const beforeMeta = metaText()
    const beforeEnv = envText()
    for (const opts of [OPTS, { ...OPTS, confirmed: true }, { ...OPTS, confirmed: true, shownPlacements: [{ bucket: BUCKET, prefix: PREFIX }] }]) {
      const r = await call({ opts })
      expect(r).toEqual({ ok: false, message: HANAMII_RESUME_NO_MARK_MESSAGE })
    }
    expect(h.calls, '印が無いのに外へ要求が出た').toEqual([])
    expect(metaText()).toBe(beforeMeta)
    expect(envText()).toBe(beforeEnv)
  })

  it.each([
    ['印の projectId が記録と違う', MARK({ projectId: 'hnm-proj-other' })],
    ['印の中身が壊れている（shownPlacements が配列でない）', MARK({ shownPlacements: 'all' })],
    ['印の requiresReview が真偽値でない', MARK({ requiresReview: 'false' })],
    ['印の acceptedAt が無い', MARK({ acceptedAt: undefined })],
    ['印が文字列', 'accepted'],
    ['印が配列', []],
    ['印の保存場所の組が壊れている（keepData が真偽値でない）', MARK({ shownPlacements: [{ bucket: BUCKET, prefix: PREFIX, keepData: 'yes' }] })],
  ])('★★★ %s → 要求0件で断る', async (_name, mark) => {
    putMark(mark)
    install([404], [404])
    const r = await call()
    expect(r.ok).toBe(false)
    expect(r.message).toBe(HANAMII_RESUME_NO_MARK_MESSAGE)
    expect(h.calls).toEqual([])
  })

  it('★★ 印が無い・projectId が合わない断りは、処理の記録を作らない（自動の続きは押したものではない。断りを失敗のカードとして画面に出さない）', async () => {
    install([404], [404])
    const noRecord = () => {
      const snap = getOps(projectDir)
      expect(snap.running, '走っている記録ができた').toBeFalsy()
      expect([snap.last, ...snap.earlier].filter(Boolean), '断りが処理の記録に残った').toEqual([])
    }
    // 印が無い（手で押した破棄や「一覧から削除」で、候補を読んだあとに外れた）
    expect(await call()).toEqual({ ok: false, message: HANAMII_RESUME_NO_MARK_MESSAGE })
    noRecord()
    // 印はあるが、渡した projectId が記録と違う
    putMark()
    expect(await call({ opts: { projectId: 'hnm-proj-other' } })).toEqual({ ok: false, message: PROJECT_MISMATCH_TEARDOWN })
    noRecord()
    // 印の projectId が記録と違う
    putMark(MARK({ projectId: 'hnm-proj-other' }))
    expect(await call()).toEqual({ ok: false, message: HANAMII_RESUME_NO_MARK_MESSAGE })
    noRecord()
    expect(h.calls).toEqual([])
  })

  it('★★★ 鍵の中の確かめ（歯止めの本体）: 下見を通らずに骨へ来ても、印が無い・合わない回は要求0件で断る', async () => {
    // 下見（resumePrecheck）と鍵の中の間に印が外れる回と同じ。ハンドラは下見で先に断るので、骨を直接呼んで鍵の中を見る。
    install([404], [404])
    const viaShell = (opts: unknown = OPTS) => runTeardownShell(HANAMII_RESUME_SHELL, { projectDir, auth: { token: TOKEN }, opts })
    expect(await viaShell()).toEqual({ ok: false, message: HANAMII_RESUME_NO_MARK_MESSAGE })
    putMark(MARK({ projectId: 'hnm-proj-other' }))
    expect(await viaShell()).toEqual({ ok: false, message: HANAMII_RESUME_NO_MARK_MESSAGE })
    putMark()
    expect(await viaShell({ projectId: 'hnm-proj-other' })).toEqual({ ok: false, message: PROJECT_MISMATCH_TEARDOWN })
    expect(h.calls, '印が無いのに外へ要求が出た').toEqual([])
  })

  it('★★★ 渡した projectId が空・記録と違う → 要求0件（PROJECT_MISMATCH）', async () => {
    putMark()
    install([404], [404])
    for (const projectId of [undefined, '', 'hnm-proj-other', 7]) {
      const r = await call({ opts: { projectId } })
      expect(r, String(projectId)).toEqual({ ok: false, message: PROJECT_MISMATCH_TEARDOWN })
    }
    expect((await call({ opts: undefined })).ok).toBe(false)
    expect(h.calls).toEqual([])
  })

  it('★★★ 複製（同じ projectId の記録を持つ兄弟のフォルダ）がいる → 要求0件で断る。印があっても', async () => {
    putMark()
    const twin = path.join(workspaceDirOf(projectDir), 'myapp-copy')
    fs.mkdirSync(twin, { recursive: true })
    fs.writeFileSync(path.join(twin, '.sakuraide.json'), JSON.stringify({ publish: { hanamii: { projectId: PROJECT_ID } } }), 'utf-8')
    install([404], [404])
    const r = await call()
    expect(r).toEqual({ ok: false, message: twinsRefusedMessage(['myapp-copy']) })
    expect(h.calls).toEqual([])
    expect(markOf(), '断った回が印を外した').toBeTruthy()
  })

  it('★★★ 印が残ったあと、同じプロジェクトへ公開し直して成功したら（公開の成功が書く2つ）、続きは要求0件で断る。公開し直した新しい意思を、古い確認で上書きしない', async () => {
    putMark(MARK({ requiresReview: true }))
    writeHanamiiProjectIdFs(projectDir, PROJECT_ID)
    writePublishRecordFs(projectDir, 'hanamii', { publishedAt: '2026-11-09T02:00:00.000Z', url: null })
    install([200], [{ status: 200, text: JSON.stringify({ project: { id: PROJECT_ID, deleted: true } }) }])
    const r = await call()
    expect(r).toEqual({ ok: false, message: HANAMII_RESUME_NO_MARK_MESSAGE })
    expect(h.calls, '公開し直したあとの続きが、生きたプロジェクトへ要求を出した').toEqual([])
    expect(readMeta().publish.hanamii.projectId).toBe(PROJECT_ID)
  })

  it('★★ トークンが無い・projectDir が不正 → 要求0件', async () => {
    putMark()
    install([404], [404])
    for (const auth of [undefined, null, {}, { token: '' }, { token: 5 }, 'x']) expect((await call({ auth })).ok, JSON.stringify(auth)).toBe(false)
    for (const dir of [undefined, null, '', 0]) expect((await call({ dir })).ok, String(dir)).toBe(false)
    expect(h.calls).toEqual([])
  })
})

describe('★★★ 印あり: GET から始め（DELETE は送らない）、済んだと確かめたら、印の shownPlacements だけを消す', () => {
  it('★★★ GET 404 → 確かめの DELETE 404 → 保存場所の段 → 記録の行が消える。最初の要求は GET（DELETE を先に送らない）', async () => {
    putMark()
    install([404], [404])
    const r = await call()
    expect(r.ok).toBe(true)
    expect(r.appDeleted).toBe(true)
    expect(h.calls[0]).toBe(GET_CALL)
    expect(h.calls[1]).toBe(DELETE_CALL)
    expect(h.calls.filter(c => c === DELETE_CALL)).toHaveLength(1)
    expect(h.calls.findIndex(c => !isHanamiiCall(c))).toBeGreaterThan(1)
    expect(h.calls).toContain(`deleteBucket ${BUCKET}`)
    const meta = readMeta()
    expect(meta.publish.targets?.hanamii, '済んだのに 📡 の行が残った').toBeUndefined()
    expect(meta.publish.hanamii.projectId).toBeNull()
    expect(meta.publish.hanamii.deletionAccepted).toBeUndefined()
  })

  it('★★★ 印の shownPlacements に無い保存場所は消さない（見せていない分は残り、残りの印へ引き継ぐ。受け付けの印は外れる）', async () => {
    const B2 = 'koto-data-other'
    putBuckets([BUCKET, B2])
    putMark(MARK({ shownPlacements: [{ bucket: BUCKET, prefix: PREFIX }] }))
    install([404], [404])
    const r = await call()
    expect(h.calls).toContain(`deleteBucket ${BUCKET}`)
    expect(h.calls.some(c => c.includes(B2)), '見せていない保存場所に触れた').toBe(false)
    expect(r.ok).toBe(false)
    expect(r.skippedBuckets).toEqual([B2])
    const meta = readMeta()
    expect(meta.publish.hanamii.storageLeftoverBuckets).toEqual([B2])
    expect(meta.publish.hanamii.deletionAccepted).toBeUndefined()
    expect(meta.publish.targets.hanamii, '保存場所が残ったので行は残る').toBeTruthy()
  })

  it('★★★ 画面が shownPlacements を渡しても使わない: 消すのは印の組だけ（画面の組にだけ入っている保存場所は、中身にもバケットにも触れない）', async () => {
    const B2 = 'koto-data-other'
    putBuckets([BUCKET, B2])
    putMark(MARK({ shownPlacements: [{ bucket: BUCKET, prefix: PREFIX }] }))
    install([404], [404])
    const r = await call({ opts: { projectId: PROJECT_ID, confirmed: true, shownPlacements: [{ bucket: BUCKET, prefix: PREFIX }, { bucket: B2, prefix: PREFIX }] } })
    expect(h.calls).toContain(`deleteBucket ${BUCKET}`)
    expect(h.calls.filter(c => c.includes(B2)), '画面の組で、確認で見せていない保存場所に触れた').toEqual([])
    expect(r.ok).toBe(false)
    expect(r.skippedBuckets).toEqual([B2])
  })

  it('★★★ 印が見せた保存場所が空（確認が何も見せていない）→ 保存場所は1件も消さない', async () => {
    putMark(MARK({ shownPlacements: [] }))
    install([404], [404])
    const r = await call()
    expect(h.calls.filter(c => c.startsWith('deleteBucket') || c.startsWith('deleteKeys')), '見せていないのに消した').toEqual([])
    expect(r.ok).toBe(false)
    expect(r.skippedBuckets).toEqual([BUCKET])
  })

  it('★★★ 印の keepData:true の保存場所は、データにもバケットにも触れない', async () => {
    putMark(MARK({ shownPlacements: [{ bucket: BUCKET, prefix: PREFIX, keepData: true }] }))
    install([404], [404])
    await call()
    expect(h.calls.filter(c => c.startsWith('deleteBucket') || c.startsWith('deleteKeys') || c.startsWith('list '))).toEqual([])
  })

  it('★★★ 保存場所の段が済まない（一覧できない）→ 残りの印へ引き継ぐ。受け付けの印は外れ、行と projectId は残る', async () => {
    h.listThrows = true
    putMark()
    install([404], [404])
    const r = await call()
    expect(r.ok).toBe(false)
    expect(r.appDeleted).toBe(true)
    const meta = readMeta()
    expect(meta.publish.hanamii.storageLeftoverBuckets).toEqual([BUCKET])
    expect(meta.publish.hanamii.deletionAccepted).toBeUndefined()
    expect(meta.publish.hanamii.projectId).toBe(PROJECT_ID)
  })

  it('★★★ トークンは渡されたものだけ: すべての GET・DELETE の Authorization が一致する', async () => {
    putMark()
    install([200, 404], [404])
    await call({ auth: { token: 'hnm_resume_token' } })
    expect(auths.length).toBeGreaterThanOrEqual(3)
    expect([...new Set(auths)]).toEqual(['Bearer hnm_resume_token'])
  })

  it('★★★ IPC が返ったあとは、時間が経っても fetch は1本も増えない', async () => {
    putMark()
    install([200], [202])
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

  it('★★ 続きの進み具合: 「…続きを確かめています…」から始まり、待つ文と「N秒経過」が出る。トークンは伏せられている', async () => {
    const labels: string[] = []
    setProjectOpsListener((_d: string, snap: any) => { const l = snap?.running?.progress?.label; if (l && labels[labels.length - 1] !== l) labels.push(l) })
    putMark()
    install([200, 404], [404])
    await call()
    expect(labels.some(l => l.includes('HANAMII の削除の続きを確かめています')), JSON.stringify(labels)).toBe(true)
    expect(labels).toContain('⏳ HANAMII がプロジェクトを削除し終えるのを待っています…')
    expect(JSON.stringify(labels)).not.toContain(TOKEN)
    expect(getOps(projectDir).last?.handler).toBe('hanamii:resumeTeardown')
  })

  it('★★ 待っている間は、同じプロジェクトの続き・破棄が busy で断られ、要求は増えない', async () => {
    putMark()
    let release: () => void = () => {}
    const gate = new Promise<void>(open => { release = open })
    let entered: () => void = () => {}
    const inWait = new Promise<void>(open => { entered = open })
    install([200, 404], [404], { onRequest: async (m, n) => { if (m === 'GET' && n === 0) { entered(); await gate } } })
    const first = call()
    await inWait
    expect(runningOp(projectDir)).toBe('削除')
    const before = [...h.calls]
    const busy = projectBusyMessage('削除', 'hanamii')
    const second = await call()
    const third = await teardown(EVENT, projectDir, { token: TOKEN }, { confirmed: true, projectId: PROJECT_ID, shownPlacements: [] })
    for (const r of [second, third]) expect(r).toMatchObject({ ok: false, message: busy })
    expect(h.calls).toEqual(before)
    release()
    expect((await first).ok).toBe(true)
  })
})

describe('★★★ 続きでも済まない回: 印を残し、保存場所にも記録の行にも触れない', () => {
  it('★★★ 時間切れ（GET が 200 のまま・最後の DELETE も 202）→ 受け付けの警告。印はそのまま・env.json もそのまま・保存場所0件。DELETE は1本も送らない（続きは起動のたびに走るので、確認待ちのプロジェクトへ送り続けない）', async () => {
    putMark()
    install([200], [202])
    const beforeMeta = metaText()
    const beforeEnv = envText()
    const r = await call()
    expect(r).toEqual({ ok: false, appDeleted: false, deletionAccepted: true, message: HANAMII_DELETION_ACCEPTED_WARNING })
    expect(storageCalls()).toEqual([])
    expect(h.calls[0]).toBe(GET_CALL)
    expect(h.calls.filter(c => c === DELETE_CALL), '続きの回が、GET が 200 のままのプロジェクトへ DELETE を送った').toHaveLength(0)
    expect(metaText()).toBe(beforeMeta)
    expect(envText()).toBe(beforeEnv)
  })

  it('★★★ requiresReview の印でも続きを試みる（GET が 404 になるまで待つ）。済めば片づく', async () => {
    putMark(MARK({ requiresReview: true }))
    install([200, 404], [404])
    const r = await call()
    expect(r.ok).toBe(true)
    expect(h.calls[0]).toBe(GET_CALL)
    expect(readMeta().publish.targets?.hanamii).toBeUndefined()
  })

  it('★★★ requiresReview の印で、まだ済んでいない → 「確認が要る」の文（deletionReview:true）。印は残る。保存場所に触れない', async () => {
    putMark(MARK({ requiresReview: true }))
    install([200], [202])
    const before = metaText()
    const r = await call()
    expect(r).toEqual({ ok: false, appDeleted: false, deletionAccepted: true, deletionReview: true, message: HANAMII_DELETION_REVIEW_WARNING })
    expect(h.calls.filter(c => c === DELETE_CALL)).toHaveLength(0)
    expect(storageCalls()).toEqual([])
    expect(metaText()).toBe(before)
  })

  it('★★ 確かめられない（GET が 403）→ 詳細つきの文。印は残り、保存場所に触れない', async () => {
    putMark()
    install([403], [404])
    const r = await call()
    expect(r.message).toBe(`${HANAMII_DELETION_ACCEPTED_WARNING}\n詳細: HTTP 403（operationId: ${ACCEPTED_OPERATION_ID}）`)
    expect(h.calls).toEqual([GET_CALL])
    expect(markOf()?.projectId).toBe(PROJECT_ID)
  })
})

describe('★★★ 最初の破棄 → 待ち切れず → 次に開いたとき自動の続き（つながり）', () => {
  it('★★★ 最初の破棄が時間切れ → 印が書かれる → 続きが GET 404・DELETE 404 で、最初の確認で見せた保存場所だけを消して行が消える', async () => {
    install([200], [accepted(), 202])
    const first = await teardown(EVENT, projectDir, { token: TOKEN }, { confirmed: true, projectId: PROJECT_ID, shownPlacements: [{ bucket: BUCKET, prefix: PREFIX }] })
    expect(first.deletionAccepted).toBe(true)
    expect(storageCalls()).toEqual([])
    expect(markOf()?.shownPlacements).toEqual([{ bucket: BUCKET, prefix: PREFIX }])
    // Koto を起動し直したつもり: 続き
    h.calls = []
    install([404], [404])
    const second = await call()
    expect(second.ok).toBe(true)
    expect(h.calls[0]).toBe(GET_CALL)
    expect(h.calls).toContain(`deleteBucket ${BUCKET}`)
    expect(readMeta().publish.targets?.hanamii).toBeUndefined()
  })

  it('★★★ 前の「受け付けただけ」（途中）は、続きで済んだ回が終わると、見られていない記録から外れる。別の記録は残る', async () => {
    install([200], [accepted(), 202])
    await teardown(EVENT, projectDir, { token: TOKEN }, { confirmed: true, projectId: PROJECT_ID, shownPlacements: [{ bucket: BUCKET, prefix: PREFIX }] })
    expect(getOps(projectDir).last?.result?.extra?.deletionAccepted).toBe(true)
    install([404], [404])
    expect((await call()).ok).toBe(true)
    const snap = getOps(projectDir)
    expect(snap.last?.result?.ok, '最新は済んだ回').toBe(true)
    const all = [snap.last, ...snap.earlier]
    expect(all.filter(r => r?.result?.extra?.deletionAccepted === true), '前の「途中」が上部に残っている').toEqual([])
  })
})
