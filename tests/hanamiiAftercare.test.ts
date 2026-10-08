import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── なぜこのテストが要るか（2026-09-29・作者の決定 ②・HANAMII の公開の後始末を main へ）────────────
// HANAMII は、公開の依頼が通ったあとの後始末を**画面（HanamiiPanel の setInterval）**が担っていた:
//   「READY になったか確かめる → URL を記録に書く → 古い保存場所の鍵を片づける」。
// **ダイアログを閉じるとこれが行われず**、古い鍵が残り、記録の url が null のままになった。
// いまは main の hanamii:publish の後段が、画面に依らずに最後まで行う。ここはその**振る舞い**を、
// 偽の HANAMII（fetch）と偽の保存場所に実際に流して固定する（ソースの文字列は読まない・掟10）。
// **画面（renderer）はこのテストに1度も出てこない**——ダイアログを閉じた状態と同じ。
//
// いちばん大事なのは、CLAUDE.md 掟10「切り替わる前に、古いほうの足元を外さない」（2026-08-14 の 403 事故）:
//   古い保存場所の鍵を消してよいのは、**新しい版が READY になったと確かめてから**だけ。
//   READY にならなかったとき（ERROR・時間切れ・状態を取れない・前の版の READY を見ただけ）は**消さない**。
// 消し損ねは次の「動いた」公開で片づくが、消しすぎは動いているアプリを 403 で落とす。
//
// 原本（HANAMII 公式 API リファレンス・2026-09-29 に取得）:
//   ・latestDeployment は { id, readyState, errorCode } で、「現在稼働中」ではなく「直近の deployment 試行」
//   ・再デプロイに失敗しても、前回成功版は稼働中のまま
//   だから「新しい版が動いた」は、latestDeployment.id が**今回の deployment の id と一致**し、かつ READY のとき。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  /** 出来事を順序どおりに積む（HANAMII への状態の問い合わせ・保存場所の操作）。順序の検査に使う。 */
  events: [] as string[],
  /** GET /projects/:id が返す応答（先頭から1つずつ。最後の1つは繰り返す）。 */
  detailQueue: [] as Array<{ status: number; body: unknown }>,
  /** 最初の状態問い合わせを止める（後段が「待っている最中」を作る）。 */
  blockDetail: false,
  entered: null as null | (() => void),
  release: (() => {}) as () => void,
  /** createProject / redeploy が返す deployment の id（null なら deployment を返さない）。 */
  deploymentId: 'dpl_new' as string | null,
  permissions: [] as { id: string; displayName: string }[],
  listThrows: false,
  deleted: [] as string[],
  storageCalls: [] as string[],
  hasCreds: true,
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test', on: () => {} },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {} },
  dialog: {},
}))

vi.mock('../src/main/cloud/auth', async (importOriginal) => {
  const real = await importOriginal<any>()
  return { ...real, loadCredentials: () => (h.hasCreds ? { token: 'tok', secret: 'sec' } : null) }
})

// 偽の保存場所。**実物の判断（storageKeys.ts → permissionsToCleanUp）はそのまま動かす。**
vi.mock('../src/main/cloud/storageAdapter', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    createStorageAdapter: async () => {
      h.storageCalls.push('connect')
      return {
        siteInfo: () => ({ s3Endpoint: 's3.isk01.sakurastorage.jp', region: 'jp-north-1' }),
        async isSiteReady() { return true },
        async ensureBucket() {},
        async putMarker() {},
        async listAllKeys() { return [] },
        async deleteKeys() {},
        async deleteBucket() {},
        async deletePermission(id: string) {
          h.events.push(`deletePermission ${id}`)
          h.storageCalls.push(`deletePermission ${id}`)
          h.deleted.push(id)
        },
        async issueKey() {
          h.events.push('issueKey')
          h.storageCalls.push('issueKey')
          return { accessKey: 'AKIA-X', secretKey: 'S3CRET-X', permissionId: 'perm-new' }
        },
        async listPermissions() {
          h.storageCalls.push('listPermissions')
          if (h.listThrows) throw new Error('鍵の一覧を取得できませんでした（テスト）')
          return h.permissions
        },
        async dispose() {},
      }
    },
  }
})

import { registerHanamiiHandlers } from '../src/main/ipc/hanamii'
import { registerProjectOpsHandlers } from '../src/main/ipc/projectOps'
import { registerPublishMetaHandlers } from '../src/main/ipc/publishMeta'
import { resetProjectOpsForTests } from '../src/main/projectOps'
import { hanamiiWaitTuning } from '../src/main/hanamii/aftercare'
import { projectBusyMessage } from '../src/main/projectLock'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'

registerHanamiiHandlers({} as any)
registerPublishMetaHandlers()
registerProjectOpsHandlers({ getMainWindow: () => null } as any)

const TOKEN = 'hnm_AFTERCARE-TOKEN-0123456789'
const BASE = 'https://hanamii.jp'
const UPLOAD_URL = 'https://upload.example.test/put'
const PROJECT_ID = 'prj_1'
const NEW = 'dpl_new'
const OLD = 'dpl_old'
const MINE = 'koto-myapp-hanamii'
const URL_LIVE = 'https://app-xxxx.ingress.apprun.sakura.ne.jp'

let projectDir = ''
let realFetch: typeof globalThis.fetch
/** 偽の HANAMII が受けた要求（順序込み）。 */
let reqs: string[] = []

const jsonRes = (status: number, data: unknown) => ({ ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(data) } })

/** GET /projects/:id の応答（公式 API リファレンスの例と同じ形: project.latestDeployment = { id, readyState, errorCode }）。 */
const detail = (latestId: string | null, readyState: string, more: { url?: string; errorCode?: string } = {}) => ({
  status: 200,
  body: {
    project: {
      id: PROJECT_ID, status: 'healthy', url: more.url ?? URL_LIVE,
      latestDeployment: { ...(latestId ? { id: latestId } : {}), readyState, errorCode: more.errorCode ?? null },
    },
  },
})

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-hnm-after-'))
  reqs = []
  h.events = []
  h.detailQueue = []
  h.blockDetail = false
  h.entered = null
  h.release = () => {}
  h.deploymentId = NEW
  h.permissions = [{ id: 'perm-old', displayName: MINE }, { id: 'perm-new', displayName: MINE }]
  h.listThrows = false
  h.deleted = []
  h.storageCalls = []
  h.hasCreds = true
  resetProjectOpsForTests()
  registerProjectOpsHandlers({ getMainWindow: () => null } as any)
  hanamiiWaitTuning.intervalMs = 0
  hanamiiWaitTuning.maxPolls = 4
  realFetch = globalThis.fetch
  // **偽の HANAMII。** 実物の HanamiiClient をそのまま動かし、出た要求だけを見る。実ネットワークへは出ない。
  globalThis.fetch = (async (input: unknown, init: any) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    reqs.push(`${method} ${url}`)
    if (method === 'POST' && url === `${BASE}/api/v1/uploads`) return jsonRes(200, { upload: { uploadUrl: UPLOAD_URL, id: 'up-1' } })
    if (method === 'PUT' && url === UPLOAD_URL) return jsonRes(200, {})
    if (method === 'POST' && url === `${BASE}/api/v1/uploads/up-1/check`) return jsonRes(200, { result: { canDeploy: true, checkId: 'chk-1' } })
    if (method === 'POST' && url === `${BASE}/api/v1/projects`) return jsonRes(200, { project: { id: PROJECT_ID }, ...(h.deploymentId ? { deployment: { id: h.deploymentId } } : {}) })
    if (method === 'POST' && url === `${BASE}/api/v1/projects/${PROJECT_ID}/deploy`) return jsonRes(200, { project: { id: PROJECT_ID }, ...(h.deploymentId ? { deployment: { id: h.deploymentId } } : {}) })
    if (method === 'PATCH' || method === 'PUT') return jsonRes(200, {})
    if (method === 'GET' && url === `${BASE}/api/v1/projects/${PROJECT_ID}`) {
      h.events.push('GET project')
      if (h.blockDetail) {
        h.blockDetail = false
        const gate = new Promise<void>(open => { h.release = open })
        h.entered?.()
        await gate
      }
      const item = h.detailQueue.length > 1 ? h.detailQueue.shift()! : h.detailQueue[0]
      if (!item) return jsonRes(404, {})
      h.events.push(`state ${JSON.stringify((item.body as any)?.project?.latestDeployment ?? item.status)}`)
      return jsonRes(item.status, item.body)
    }
    return jsonRes(404, { error: { message: `想定外の要求: ${method} ${url}` } })
  }) as unknown as typeof fetch
})
afterEach(() => {
  h.release()
  globalThis.fetch = realFetch
  hanamiiWaitTuning.intervalMs = 3000
  hanamiiWaitTuning.maxPolls = 100
  fs.rmSync(projectDir, { recursive: true, force: true })
})

const handler = (channel: string) => h.handlers.get(channel)!
const getOps = (dir: string): Promise<{ running: any; last: any; earlier: any[] }> => handler('projectOps:get')({}, dir)
const readMeta = (): any => JSON.parse(fs.readFileSync(path.join(projectDir, '.sakuraide.json'), 'utf-8'))

/** 公開できるプロジェクト（言語マニフェストあり）。保存場所は既定で同意済み。 */
function setupProject(opts: { storage?: boolean } = {}) {
  const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: false })
  spec.persistence = {
    objectStorage: opts.storage === false ? [] : [{ bucket: 'koto-data-x', prefix: 'projects/myapp/', shared: true, consentedAt: '2026-08-14T00:00:00.000Z' }],
  } as any
  fs.mkdirSync(path.join(projectDir, '.sakura-cloud'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), JSON.stringify(spec, null, 2), 'utf-8')
  fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'myapp', version: '1.0.0' }), 'utf-8')
  fs.writeFileSync(path.join(projectDir, 'index.html'), '<html><body>hi</body></html>', 'utf-8')
}

/** 再公開（既存プロジェクトへ）。保存場所の鍵を発行して渡す。 */
const republish = (over: Record<string, unknown> = {}) => {
  // main は、画面が渡した projectId が**このプロジェクトの記録が指すものと一致するときだけ**使う（2026-09-30 検分・掟11）。
  // 「すでに公開してある」プロジェクトの記録（publish.hanamii.projectId）を、まだ無ければ置く。
  const metaPath = path.join(projectDir, '.sakuraide.json')
  if (!fs.existsSync(metaPath)) fs.writeFileSync(metaPath, JSON.stringify({ publish: { hanamii: { projectId: PROJECT_ID } } }, null, 2), 'utf-8')
  return handler('hanamii:publish')({}, projectDir, {
    token: TOKEN, workspaceId: 'ws-1', projectId: PROJECT_ID, name: 'myapp', envs: [], withStorage: true, ...over,
  })
}
/** 初回の公開（プロジェクトを新しく作る）。 */
const firstPublish = (over: Record<string, unknown> = {}) => handler('hanamii:publish')({}, projectDir, {
  token: TOKEN, workspaceId: 'ws-1', name: 'myapp', envs: [], withStorage: false, ...over,
})
const stateGets = () => reqs.filter(r => r === `GET ${BASE}/api/v1/projects/${PROJECT_ID}`).length

describe('★★★ 新しい版が READY になったと確かめてから、古い鍵を片づける（画面なしで最後まで）', () => {
  it('★ 再公開: BUILDING → READY を待ち、URL を記録に書き、そのあとで古い鍵だけを消す。新しい鍵は残す', async () => {
    setupProject()
    h.detailQueue = [detail(NEW, 'BUILDING'), detail(NEW, 'BUILDING'), detail(NEW, 'READY')]
    let publishedAtAtAccept: string | null = null
    const inner = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init: any) => {
      // 最初の状態問い合わせの時点（＝依頼が受け付けられた直後）の公開記録を控える
      if ((init?.method ?? 'GET') === 'GET' && String(input) === `${BASE}/api/v1/projects/${PROJECT_ID}` && publishedAtAtAccept === null) {
        publishedAtAtAccept = readMeta().publish.targets.hanamii.publishedAt
        expect(readMeta().publish.targets.hanamii.url, '動いたと確かめる前に url を書いている').toBeNull()
      }
      return (inner as any)(input, init)
    }) as unknown as typeof fetch

    const r = await republish()

    expect(r.ok).toBe(true)
    expect(r.deployState).toBe('ready')
    expect(r.readyState).toBe('READY')
    expect(r.url).toBe(URL_LIVE)
    // 新しい鍵（perm-new）は残し、古い鍵（perm-old）だけを消した
    expect(h.deleted).toEqual(['perm-old'])
    // **順序**: 鍵を発行 → 状態を3回確かめる（最後が READY）→ そのあとで古い鍵を消す
    const readyAt = h.events.findIndex(e => e.startsWith('state') && e.includes('"READY"'))
    const deleteAt = h.events.indexOf('deletePermission perm-old')
    expect(readyAt).toBeGreaterThan(-1)
    expect(deleteAt, '古い鍵を READY を確かめる前に消している（2026-08-14 の 403 事故と同じ形）').toBeGreaterThan(readyAt)
    expect(h.events.indexOf('issueKey')).toBeLessThan(h.events.indexOf('GET project'))
    expect(stateGets()).toBe(3)
    // URL は記録に書かれ、公開日時は依頼を受け付けたときのまま
    const rec = readMeta().publish.targets.hanamii
    expect(rec.url).toBe(URL_LIVE)
    expect(rec.publishedAt).toBe(publishedAtAtAccept)
    // 片づけ済みなので、旧い画面が使う「鍵の識別子」は返さない（画面がもう一度片づけに走らない）
    expect(r.storagePermissionId).toBeUndefined()
    expect(r.storageProjectName).toBeUndefined()
    expect(r.warnings).toBeUndefined()
  })

  it('★ ダイアログを閉じていても同じ: 結果と進み具合は、開き直した画面が projectOps:get で読める', async () => {
    setupProject()
    h.detailQueue = [detail(NEW, 'BUILDING'), detail(NEW, 'READY')]
    await republish()

    const snap = await getOps(projectDir)
    expect(snap.running).toBeNull()
    expect(snap.last).toMatchObject({ op: '公開', target: 'hanamii', handler: 'hanamii:publish', running: false, seen: false })
    expect(snap.last.result).toMatchObject({ ok: true, url: URL_LIVE, warnings: [] })
    expect(snap.last.result.extra).toMatchObject({ deployState: 'ready', readyState: 'READY', projectId: PROJECT_ID, deploymentId: NEW })
    // 鍵の識別子は記録に写らない
    expect(JSON.stringify(snap)).not.toContain('perm-new')
    expect(JSON.stringify(snap)).not.toContain('storagePermissionId')
    expect(JSON.stringify(snap)).not.toContain(TOKEN)
  })

  it('★ 初回の公開（プロジェクトを新しく作る）も、READY を確かめて URL を書く。保存場所を使わなければ鍵には一切触れない', async () => {
    setupProject({ storage: false })
    h.detailQueue = [detail(NEW, 'READY')]
    const r = await firstPublish()

    expect(r.ok).toBe(true)
    expect(r.deployState).toBe('ready')
    expect(reqs.filter(x => x === `POST ${BASE}/api/v1/projects`)).toHaveLength(1)
    expect(readMeta().publish.targets.hanamii.url).toBe(URL_LIVE)
    expect(readMeta().publish.hanamii.projectId).toBe(PROJECT_ID)
    expect(h.storageCalls, '保存場所を使わない公開が鍵に触れた').toEqual([])
  })

  it('前の版の READY を「新しい版が動いた」と読まない: 前の deployment が latest のあいだは待ち、新しいものが READY になってから消す', async () => {
    setupProject()
    // 再デプロイ直後は、前の版（dpl_old）が latest で READY のまま（公式 API リファレンス: latestDeployment は直近の試行）
    h.detailQueue = [detail(OLD, 'READY'), detail(OLD, 'READY'), detail(NEW, 'BUILDING'), detail(NEW, 'READY')]
    hanamiiWaitTuning.maxPolls = 6
    const r = await republish()

    expect(r.deployState).toBe('ready')
    expect(stateGets()).toBe(4)
    const newReadyAt = h.events.findIndex(e => e.startsWith('state') && e.includes(NEW) && e.includes('"READY"'))
    expect(h.events.indexOf('deletePermission perm-old')).toBeGreaterThan(newReadyAt)
    // 前の版の READY を見た時点では、まだ消していない
    const firstOldReadyAt = h.events.findIndex(e => e.startsWith('state') && e.includes(OLD))
    expect(h.events.indexOf('deletePermission perm-old')).toBeGreaterThan(firstOldReadyAt)
    expect(h.deleted).toEqual(['perm-old'])
  })
})

describe('★★★ READY を確かめられなかったときは、古い鍵を消さない（結果に正直に載せる）', () => {
  it('前の版が latest のまま READY（新しい版がまだ切り替わらない）→ 時間切れ: 消さず、「確かめられなかった」と載せる', async () => {
    setupProject()
    h.detailQueue = [detail(OLD, 'READY')]
    const r = await republish()

    expect(r.ok).toBe(true)                    // 依頼は受け付けられた（設定を保存する条件）
    expect(r.deployState).toBe('pending')
    expect(h.deleted, '前の版の READY を見て古い鍵を消した').toEqual([])
    expect(r.url).toBeUndefined()
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toContain('確かめられませんでした')
    expect(r.warnings[0]).toContain('古い鍵は、動いたと確かめられるまで消さずに残しています')
    // 消し損ねた鍵の識別子は返る（旧い画面の互換。使わない）
    expect(r.storagePermissionId).toBe('perm-new')
    // url は記録に書かない
    expect(readMeta().publish.targets.hanamii.url).toBeNull()
  })

  it('新しい版がずっと BUILDING → 時間切れ: 「まだ動いていません（状態: BUILDING）」と載せて消さない', async () => {
    setupProject()
    h.detailQueue = [detail(NEW, 'BUILDING')]
    const r = await republish()

    expect(r.ok).toBe(true)
    expect(r.deployState).toBe('pending')
    expect(r.readyState).toBe('BUILDING')
    expect(h.deleted).toEqual([])
    expect(r.warnings[0]).toContain('まだ動いていません')
    expect(r.warnings[0]).toContain('状態: BUILDING')
    // 記録にも警告が載る（開き直した画面が読む）
    const res = (await getOps(projectDir)).last.result
    expect(res.ok).toBe(true)
    expect(res.warnings[0]).toContain('まだ動いていません')
    expect(res.extra.deployState).toBe('pending')
  })

  it('★★ 新しい版が ERROR: 消さない。前の版が動き続けている場合があると伝え、記録は「うまくいっていない」', async () => {
    setupProject()
    h.detailQueue = [detail(NEW, 'BUILDING'), detail(NEW, 'ERROR', { errorCode: 'BUILD_FAILED' })]
    const r = await republish()

    expect(r.ok).toBe(true)                    // 依頼は通った。projectId 等を画面が保存できるように ok は true のまま
    expect(r.deployState).toBe('error')
    expect(r.errorCode).toBe('BUILD_FAILED')
    expect(h.deleted, 'ERROR の版のために、動いている前の版の鍵を消した').toEqual([])
    expect(r.message).toContain('起動できませんでした')
    expect(r.message).toContain('BUILD_FAILED')
    expect(r.message).toContain('前の版が動き続けている場合があります')
    expect(readMeta().publish.targets.hanamii.url).toBeNull()

    const res = (await getOps(projectDir)).last.result
    expect(res.ok).toBe(false)
    expect(res.message).toContain('BUILD_FAILED')
    expect(res.extra).toMatchObject({ deployState: 'error', errorCode: 'BUILD_FAILED' })
  })

  it('初回の公開が ERROR のときは、「前の版が動き続けている」とは言わない（前の版が無い）', async () => {
    setupProject({ storage: false })
    h.detailQueue = [detail(NEW, 'ERROR', { errorCode: 'BUILD_FAILED' })]
    const r = await firstPublish()
    expect(r.deployState).toBe('error')
    expect(r.message).not.toContain('前の版')
  })

  it('★ 状態を取れない（404・権限）: 待たずに打ち切り、消さず、理由を載せる', async () => {
    setupProject()
    h.detailQueue = [{ status: 404, body: { error: { message: 'not found' } } }]
    const r = await republish()

    expect(r.ok).toBe(true)
    expect(r.deployState).toBe('unknown')
    expect(stateGets()).toBe(1)                // 何度聞いても同じ答えなので、繰り返さない
    expect(h.deleted).toEqual([])
    expect(r.warnings[0]).toContain('HTTP 404')
    expect(r.warnings[0]).toContain('古い鍵は、動いたと確かめられるまで消さずに残しています')
  })

  it('状態の取得が続けて失敗（5xx）: 5回で打ち切り、消さない', async () => {
    setupProject()
    hanamiiWaitTuning.maxPolls = 10
    h.detailQueue = [{ status: 503, body: {} }]
    const r = await republish()

    expect(r.deployState).toBe('unknown')
    expect(stateGets()).toBe(5)
    expect(h.deleted).toEqual([])
    expect(r.warnings[0]).toContain('HTTP 503')
  })

  it('通信の例外でも落ちない（続けて失敗したら unknown）', async () => {
    setupProject()
    hanamiiWaitTuning.maxPolls = 10
    const inner = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init: any) => {
      if ((init?.method ?? 'GET') === 'GET' && String(input) === `${BASE}/api/v1/projects/${PROJECT_ID}`) throw new Error(`fetch failed (${TOKEN})`)
      return (inner as any)(input, init)
    }) as unknown as typeof fetch
    const r = await republish()

    expect(r.deployState).toBe('unknown')
    expect(h.deleted).toEqual([])
    expect(JSON.stringify(await getOps(projectDir))).not.toContain(TOKEN)
  })

  it('依頼の応答から deployment の id を読めない → どの版か分からないので、状態を問い合わせず、消さない', async () => {
    setupProject()
    h.deploymentId = null
    h.detailQueue = [detail(NEW, 'READY')]
    const r = await republish()

    expect(r.ok).toBe(true)
    expect(r.deployState).toBe('unknown')
    expect(stateGets()).toBe(0)
    expect(h.deleted).toEqual([])
    expect(r.warnings[0]).toContain('今回の公開の番号')
  })

  it('latestDeployment に id が無い応答は、READY でも「新しい版が動いた」と確かめられない → 消さない', async () => {
    setupProject()
    h.detailQueue = [detail(null, 'READY')]
    const r = await republish()
    expect(r.deployState).toBe('pending')
    expect(h.deleted).toEqual([])
  })

  it('★ 動いたと確かめたあと、古い鍵の片づけに失敗しても公開は成功のまま。鍵の識別子と警告が残る（次の公開で片づく）', async () => {
    setupProject()
    h.detailQueue = [detail(NEW, 'READY')]
    h.listThrows = true
    const r = await republish()

    expect(r.ok).toBe(true)
    expect(r.deployState).toBe('ready')
    expect(r.url).toBe(URL_LIVE)
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toContain('古い鍵を片づけられませんでした')
    expect(r.warnings[0]).toContain('動いていることは確かめられています')
    expect(r.storagePermissionId).toBe('perm-new')
    // URL は記録に書かれている
    expect(readMeta().publish.targets.hanamii.url).toBe(URL_LIVE)
    expect((await getOps(projectDir)).last.result.warnings[0]).toContain('古い鍵を片づけられませんでした')
  })
})

describe('★★ 後段も鍵（withProjectLock）の中: 待っている間は、ほかの公開・破棄を断り、進み具合が読める', () => {
  it('新しい版の起動待ちの最中: projectOps:get は running と待っている旨を返し、2回目の公開は外部の要求を1件も出さずに断られる', async () => {
    setupProject()
    h.detailQueue = [detail(NEW, 'BUILDING'), detail(NEW, 'READY')]
    h.blockDetail = true
    const entered = new Promise<void>(resolve => { h.entered = resolve })
    const first = republish()
    await entered

    // 開き直した画面が読む
    const snap = await getOps(projectDir)
    expect(snap.last).toBeNull()
    expect(snap.running).toMatchObject({ op: '公開', target: 'hanamii', running: true })
    expect(snap.running.progress.label).toContain('起動するのを待っています')
    expect(await handler('publishMeta:runningOp')({}, projectDir)).toBe('公開')

    // 待っている間の2回目は断られる。**古い鍵を消す側（この公開の後段）と、新しく鍵を発行する側が交錯しない**
    const before = [...reqs]
    const eventsBefore = [...h.events]
    const second = await republish()
    expect(second.ok).toBe(false)
    expect(second.message).toBe(projectBusyMessage('公開'))
    expect(reqs).toEqual(before)
    expect(h.events).toEqual(eventsBefore)
    expect(h.deleted).toEqual([])

    h.release()
    const r = await first
    expect(r.deployState).toBe('ready')
    expect(h.deleted).toEqual(['perm-old'])
    expect(await handler('publishMeta:runningOp')({}, projectDir)).toBeNull()
  })

  it('依頼が通らなかった公開は、後段へ進まない（状態を問い合わせない・鍵に触れない）', async () => {
    setupProject()
    const inner = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init: any) => {
      if (String(input) === `${BASE}/api/v1/uploads`) { reqs.push('POST uploads'); return jsonRes(500, { error: { message: '失敗' } }) }
      return (inner as any)(input, init)
    }) as unknown as typeof fetch
    const r = await republish({ withStorage: false })
    expect(r.ok).toBe(false)
    expect(stateGets()).toBe(0)
    expect(h.deleted).toEqual([])
    expect(r.deployState).toBeUndefined()
  })
})
