import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import type { Server } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── なぜこのテストが要るか（2026-09-23 検分）──────────────────────────────
// ③公開の画面は「保存場所を用意すると、データが残るようになります」と約束している。
// ところが鍵（KOTO_STORAGE_*）を実際に渡していたのは HANAMII と AppRun 共用型だけで、
// **AppRun 専有型は0件**だった。専有型もコンテナなので、渡さなければ再公開のたびに
// 中身ごと作り直され、**利用者は「残る」と思ったままデータを失う**。
//
// ここは**ソースの文字列を読まない**（掟10「お金・破壊の歯止めは振る舞いで固定する」）。
// 偽のサーバへ実際に流し、**送られた要求の本文**に何が載ったかを見る。
// 過去に文字列一致のテストが変異を素通りしている。

/** 偽サーバの URL・偽ストレージの記録。vi.mock の工場から触るので hoisted で持つ。 */
const h = vi.hoisted(() => ({
  baseUrl: '',
  handlers: new Map<string, (...args: any[]) => any>(),
  /** loadCredentials が返す値。null にすると「APIキーが未登録」＝鍵を発行できない状態。 */
  creds: null as null | { token: string; secret: string },
  /** createStorageAdapter が throw するか（鍵を発行できないもう一つの形）。 */
  adapterThrows: false,
  issuedNames: [] as string[],
  deletedPermissions: [] as string[],
  permissions: [] as { id: string; displayName: string }[],
  /** prepareAppImage（レジストリへの push＝書き込み）が呼ばれた回数。 */
  imageCalls: 0,
  /** prepareAppImage が失敗するか（イメージの組み立てで止まる道）。 */
  imageFails: false,
  /**
   * verify 段の偽の応答（2026-09-23 検分の指摘1・2・3）。
   * 既定は 200＝応答している。503 にすると `no-backend`＝**アプリがまだ応答していない**。
   */
  probeStatus: 200,
}))

const ISSUED = { accessKey: 'AKIA-NEW-ONE', secretKey: 'S3CRET-NEW-ONE', permissionId: 'perm-new' }
const SITE = { s3Endpoint: 's3.isk01.sakurastorage.jp', region: 'jp-north-1' }

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => '/tmp', getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {} },
  dialog: {},
}))

// 認証情報は「登録されているか」だけを差し替える（掟4: 実キーは使わない）。
vi.mock('../src/main/cloud/auth', async (importOriginal) => {
  const real = await importOriginal<any>()
  return { ...real, loadCredentials: () => h.creds }
})

// 偽のストレージ。**何を発行し、何を消したか**を記録するだけ。
vi.mock('../src/main/cloud/storageAdapter', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    createStorageAdapter: async () => {
      if (h.adapterThrows) throw new Error('保存場所に接続できません（テスト）')
      return {
        siteInfo: () => SITE,
        async issueKey(_bucket: string, displayName: string) { h.issuedNames.push(displayName); return ISSUED },
        async listPermissions() { return h.permissions },
        async deletePermission(id: string) { h.deletedPermissions.push(id) },
        async dispose() { /* 一時キーは使っていない */ },
      }
    },
  }
})

// イメージの組み立て（docker/crane・レジストリへの push）は動かさない。
// **呼ばれたかどうか**は数える——鍵を渡せないときは、ここへ入る前に止まってほしい。
vi.mock('../src/main/cloud/imagePublish', () => ({
  prepareAppImage: async () => {
    h.imageCalls++
    if (h.imageFails) return { ok: false, message: 'イメージの組み立てに失敗しました（テスト）' }
    return {
      ok: true,
      ref: 'jp1.sakuracr.jp/example/myapp:v1',
      server: 'jp1.sakuracr.jp',
      registryAuth: { server: 'jp1.sakuracr.jp', username: 'reg-user', password: 'reg-pass' },
      tag: 'v1',
      image: 'myapp',
      runtimeKind: 'node',
    }
  },
}))

// 公開の本体は**実物**を動かす。偽サーバへ向けるため baseUrl だけを足し、
// verify 段が実ネットワークへ出ないよう偽の probe と待たない sleep を入れる。
vi.mock('../src/main/cloud/apprunDedicatedAppApply', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    publishAppFlow: (auth: any, dir: string, input: any, opts: any) => real.publishAppFlow(
      auth, dir, input,
      { ...opts, probeMarker: async () => ({ reached: true, status: h.probeStatus, body: '' }), sleep: async () => {} },
      h.baseUrl,
    ),
  }
})

import { registerApprunDedicatedHandlers } from '../src/main/ipc/apprunDedicated'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'
import { writeApprunDedicatedRecordFs } from '../src/main/publishMetaFs'
import { permissionsToCleanUp } from '../src/shared/storageKeys'
import { STORAGE_ENV } from '../src/shared/objectStorage'

registerApprunDedicatedHandlers({} as any)
const publishApp = h.handlers.get('apprunDedicated:publishApp')!
/** 画面へ流れた進捗の文言（検分の指摘13: 無言の時間を作らない）。 */
let progressMsgs: string[] = []
const EVENT = { sender: { send: (_channel: string, msg: string) => { progressMsgs.push(msg) } } }
const AUTH = { token: 'tok', secret: 'sec' }
const INPUT = { host: 'app.example.com', cpu: 500, memory: 512, fixedScale: 1 }

let server: Server | null = null
let projectDir = ''

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-dedicated-storage-'))
  h.baseUrl = ''
  h.creds = { token: 'tok', secret: 'sec' }
  h.adapterThrows = false
  h.issuedNames = []
  h.deletedPermissions = []
  h.permissions = []
  h.imageCalls = 0
  h.imageFails = false
  h.probeStatus = 200
  progressMsgs = []
})
afterEach(() => {
  if (server) { server.close(); server = null }
  fs.rmSync(projectDir, { recursive: true, force: true })
})

// ── 下ごしらえ ────────────────────────────────────────────────────────

type Route = { status: number; body: unknown }

function listen(handler: http.RequestListener): Promise<string> {
  return new Promise((resolve, reject) => {
    server = http.createServer(handler)
    server.listen(0, () => {
      const addr = server?.address()
      if (addr && typeof addr === 'object') resolve(`http://127.0.0.1:${addr.port}/`)
      else reject(new Error('サーバのポートを取得できませんでした'))
    })
  })
}

/** `METHOD /path` をキーにしたルーティング表（tests/apprunDedicatedAppApply.test.ts と同じ形）。 */
function routedServer(routes: Record<string, Route | Route[]>, calls: string[], onBody?: (key: string, body: any) => void): http.RequestListener {
  const seen = new Map<string, number>()
  return (req, res) => {
    const key = `${req.method} ${req.url}`
    calls.push(key)
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      if (onBody) { try { onBody(key, raw ? JSON.parse(raw) : null) } catch { onBody(key, raw) } }
      const entry = routes[key]
      const n = seen.get(key) ?? 0
      seen.set(key, n + 1)
      const route = Array.isArray(entry) ? entry[Math.min(n, entry.length - 1)] : entry
      const status = route?.status ?? 404
      if (status === 204) { res.writeHead(204); res.end(); return }
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(route?.body ?? { error: `test router: 未定義のルート ${key}` }))
    })
  }
}

const LB_NODES_KEY = 'GET /clusters/cluster-x/asg/asg-y/load_balancers/lb-z/load_balancer_nodes?maxItems=20'

/** 公開が最後まで通る応答（apprunDedicatedAppApply.test.ts の正常系をそのまま）。 */
function okRoutes(): Record<string, Route | Route[]> {
  return {
    'GET /clusters/cluster-x': { status: 200, body: { cluster: { clusterID: 'cluster-x', hasLetsEncryptEmail: true, ports: [{ port: 80, protocol: 'http' }, { port: 443, protocol: 'https' }] } } },
    'GET /applications?clusterID=cluster-x&maxItems=20': { status: 200, body: { applications: [] } },
    'POST /applications': { status: 200, body: { application: { applicationID: 'app-1' } } },
    'POST /applications/app-1/versions': { status: 200, body: { applicationVersion: { version: 2 } } },
    'GET /applications/app-1': [
      { status: 200, body: { application: { applicationID: 'app-1', name: 'myapp', clusterID: 'cluster-x', activeVersion: 1 } } },
      { status: 200, body: { application: { applicationID: 'app-1', name: 'myapp', clusterID: 'cluster-x', activeVersion: 2 } } },
    ],
    'PUT /applications/app-1': { status: 204, body: {} },
    'GET /applications/app-1/versions?maxItems=20': { status: 200, body: { versions: [{ version: 1, image: 'x', activeNodeCount: 0, created: 1 }, { version: 2, image: 'x', activeNodeCount: 1, created: 2 }] } },
    [LB_NODES_KEY]: {
      status: 200,
      body: { loadBalancerNodes: [{ loadBalancerNodeID: 'lbn-1', resourceID: 'res-1', status: 'healthy', interfaces: [{ interfaceIndex: 0, addresses: [{ address: '59.106.222.212/24', vip: false }] }], archiveVersion: 'v1', created: 1 }] },
    },
  }
}

const CONSENTED_BUCKET = { bucket: 'koto-data-x', prefix: 'projects/myapp/', shared: true, consentedAt: '2026-08-14T00:00:00.000Z' }

/** `.sakura-cloud/env.json` と、⑤で作られたクラスタの記録を置く。 */
function setupProject(opts: { storage?: boolean; env?: { name: string; value: string }[] } = {}) {
  const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: false })
  if (opts.env) spec.service.env = opts.env
  if (opts.storage !== false) spec.persistence = { objectStorage: [CONSENTED_BUCKET] }
  fs.mkdirSync(path.join(projectDir, '.sakura-cloud'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), JSON.stringify(spec, null, 2), 'utf-8')
  writeApprunDedicatedRecordFs(projectDir, { clusterID: 'cluster-x', asgID: 'asg-y', loadBalancerID: 'lb-z' })
  return spec
}

/** 実際に公開を流し、送られた本文と呼ばれた要求を返す。 */
async function runPublish(routes: Record<string, Route | Route[]> = okRoutes()) {
  const calls: string[] = []
  const bodies: Record<string, any> = {}
  h.baseUrl = await listen(routedServer(routes, calls, (key, body) => { bodies[key] = body }))
  const result = await publishApp(EVENT, projectDir, AUTH, INPUT, { confirmed: true })
  return { result, calls, bodies, versionEnv: (bodies['POST /applications/app-1/versions']?.env ?? []) as { key: string; value: string; secret: boolean }[] }
}

const storageEnvOf = (env: { key: string }[]) => env.filter(e => e.key.startsWith('KOTO_STORAGE_'))

// ── 1. 保存場所があるとき、公開の本文に鍵が載る ──────────────────────────

describe('AppRun 専有型: 保存場所の鍵を公開の本文へ載せる', () => {
  it('★ 保存場所があるとき、送られた本文に KOTO_STORAGE_* の6件が入る', async () => {
    setupProject()
    const { result, versionEnv } = await runPublish()

    expect(result.ok).toBe(true)
    const byKey = Object.fromEntries(versionEnv.map(e => [e.key, e.value]))
    expect(storageEnvOf(versionEnv)).toHaveLength(6)
    expect(byKey[STORAGE_ENV.bucket]).toBe('koto-data-x')
    expect(byKey[STORAGE_ENV.endpoint]).toBe('https://s3.isk01.sakurastorage.jp')
    expect(byKey[STORAGE_ENV.region]).toBe('jp-north-1')
    expect(byKey[STORAGE_ENV.prefix]).toBe('projects/myapp/')
    expect(byKey[STORAGE_ENV.accessKey]).toBe(ISSUED.accessKey)
    expect(byKey[STORAGE_ENV.secretKey]).toBe(ISSUED.secretKey)
    // 鍵は**この公開先の名前**で発行する（片づけの目印・掟11）
    expect(h.issuedNames).toEqual(['koto-myapp_apprun-dedicated'])
  })

  it('★ 秘密キーだけ secret:true、ほかは secret:false', async () => {
    setupProject()
    const { versionEnv } = await runPublish()

    const secrets = versionEnv.filter(e => e.secret === true).map(e => e.key)
    expect(secrets).toEqual([STORAGE_ENV.secretKey])
    for (const e of versionEnv) {
      if (e.key !== STORAGE_ENV.secretKey) expect(e.secret).toBe(false)
    }
  })

  it('宣言済みの環境変数と、保存場所の分が**両方**渡る（片方が消えない）', async () => {
    setupProject({ env: [{ name: 'NODE_ENV', value: 'production' }, { name: 'GREETING', value: 'こんにちは' }] })
    const { versionEnv } = await runPublish()

    const byKey = Object.fromEntries(versionEnv.map(e => [e.key, e.value]))
    expect(byKey['NODE_ENV']).toBe('production')
    expect(byKey['GREETING']).toBe('こんにちは')
    expect(storageEnvOf(versionEnv)).toHaveLength(6)
    expect(versionEnv).toHaveLength(8)
  })

  it('同じ名前が env.json に手で書かれていても、いま発行した鍵を渡す（古い値で上書きされない）', async () => {
    setupProject({ env: [{ name: STORAGE_ENV.bucket, value: 'ふるいバケット' }, { name: 'NODE_ENV', value: 'production' }] })
    const { versionEnv } = await runPublish()

    expect(versionEnv.filter(e => e.key === STORAGE_ENV.bucket)).toEqual([
      { key: STORAGE_ENV.bucket, value: 'koto-data-x', secret: false },
    ])
  })
})

// ── 2. 用意していないとき・渡せないとき ─────────────────────────────────

describe('AppRun 専有型: 保存場所が無いとき・鍵を渡せないとき', () => {
  it('★ 保存場所を用意していないときは1件も足さない（勝手に課金しない）', async () => {
    setupProject({ storage: false })
    const { result, versionEnv } = await runPublish()

    expect(result.ok).toBe(true)
    expect(storageEnvOf(versionEnv)).toEqual([])
    // 鍵の発行そのものが起きない＝バケットにも触れない
    expect(h.issuedNames).toEqual([])
    // 宣言済みの環境変数は従来どおり渡る
    expect(versionEnv.map(e => e.key)).toEqual(['NODE_ENV'])
  })

  it('★ 鍵を発行できないときは公開を止める（要求が1件も飛ばない・イメージも作らない）', async () => {
    setupProject()
    h.creds = null // さくらのクラウドのAPIキーが未登録
    const { result, calls } = await runPublish()

    expect(result.ok).toBe(false)
    expect(calls).toEqual([])
    expect(h.imageCalls).toBe(0)
    expect(result.message).toContain('公開を中止しました')
  })

  it('★ 保存場所に接続できないときも、同じく公開を止める', async () => {
    setupProject()
    h.adapterThrows = true
    const { result, calls } = await runPublish()

    expect(result.ok).toBe(false)
    expect(calls).toEqual([])
    expect(h.imageCalls).toBe(0)
    expect(result.message).toContain('公開を中止しました')
  })

  it('止めるときの文は、何が起きたか・どうすればよいかが分かる日本語（内部用語を並べない）', async () => {
    setupProject()
    h.creds = null
    const { result } = await runPublish()

    expect(result.message).toBe(
      'このアプリはデータの保存を使いますが、さくらのクラウドのAPIキーが未登録のため保存場所の設定を渡せません。'
      + '「認証情報」でAPIキーを登録してください。\n'
      + 'このまま公開すると、アプリに入力されたデータが公開のたびに消えてしまうため、公開を中止しました。',
    )
    expect(result.message).not.toContain('KOTO_STORAGE')
    expect(result.message).not.toContain('permission')
  })

  it('環境変数が上限を超えるときは、黙って切り落とさずに伝えて止める', async () => {
    const many = Array.from({ length: 45 }, (_, i) => ({ name: `VAR_${i}`, value: String(i) }))
    setupProject({ env: many })
    const { result, calls } = await runPublish()

    expect(result.ok).toBe(false)
    expect(calls).toEqual([])
    expect(result.message).toContain('51件')
    expect(result.message).toContain('50件')
    expect(result.message).toContain('1件減らして')
    expect(result.message).toContain('データの保存に使う設定（6件）')
  })

  // ── 検分の指摘4・10: 件数の確認は**鍵を発行する前**に ───────────────────────
  // 発行してから止めると、バケットへ読み書きできる本物の鍵が残る。片づけは成功した公開でしか
  // 走らないので、env.json を直すまで押すたびに1本ずつ増える（実機で5件・storageKeys.ts 冒頭）。
  it('★ 上限を超えるときは、そもそも鍵を発行しない（孤児の鍵を増やさない）', async () => {
    const many = Array.from({ length: 45 }, (_, i) => ({ name: `VAR_${i}`, value: String(i) }))
    setupProject({ env: many })
    const { result } = await runPublish()

    expect(result.ok).toBe(false)
    expect(h.issuedNames).toEqual([])
    expect(h.deletedPermissions).toEqual([])
    expect(h.imageCalls).toBe(0)
  })

  // ── 検分の指摘6・8・11: 保存場所を使っていない人に「データの保存に使う設定（0件）」と言わない ──
  it('★ 保存場所を使っていないときの上限超過は、保存場所の話を混ぜない文になる', async () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ name: `VAR_${i}`, value: String(i) }))
    setupProject({ storage: false, env: many })
    const { result, calls } = await runPublish()

    expect(result.ok).toBe(false)
    expect(calls).toEqual([])
    expect(result.message).toBe(
      '環境変数が多すぎます。51件あり、この公開先で指定できる上限（50件）を超えます。'
      + '公開の設定（env.json）の環境変数を1件減らしてから、もう一度お試しください',
    )
    expect(result.message).not.toContain('データの保存に使う設定')
  })

  // ── 検分の指摘12: 見出しを「入力の検証」にしない ───────────────────────────
  it('★ 鍵を渡せずに止めたときの段は storage（利用者の入力の誤りではない）', async () => {
    setupProject()
    h.creds = null
    const { result } = await runPublish()

    expect(result.ok).toBe(false)
    expect(result.stage).toBe('storage')
  })
})

// ── 3. 古い鍵の片づけ ──────────────────────────────────────────────────

describe('AppRun 専有型: 古い鍵の片づけ', () => {
  /** 共用型・HANAMII・専有型（古い）・他プロジェクトの鍵が並んでいる状態。 */
  function permissionsAll() {
    h.permissions = [
      { id: 'perm-apprun', displayName: 'koto-myapp' },                       // 共用型（現役）
      { id: 'perm-hanamii', displayName: 'koto-myapp-hanamii' },              // HANAMII（現役）
      { id: 'perm-old-dedicated', displayName: 'koto-myapp_apprun-dedicated' }, // 専有型の古い鍵
      { id: 'perm-other', displayName: 'koto-ほかのプロジェクト' },             // 他プロジェクト
      { id: 'perm-new', displayName: 'koto-myapp_apprun-dedicated' },          // いま発行した鍵
    ]
  }

  it('★ 専有型の片づけは、共用型・HANAMII・他プロジェクトの鍵を消さない（掟11）', async () => {
    setupProject()
    permissionsAll()
    const { result } = await runPublish()

    expect(result.ok).toBe(true)
    expect(h.deletedPermissions).toEqual(['perm-old-dedicated'])
  })

  it('★ 逆も同じ: 共用型の片づけは、専有型の鍵を消さない（純ロジック）', () => {
    const all = [
      { id: 'perm-apprun-old', displayName: 'koto-myapp' },
      { id: 'perm-dedicated', displayName: 'koto-myapp_apprun-dedicated' },
      { id: 'perm-hanamii', displayName: 'koto-myapp-hanamii' },
    ]
    expect(permissionsToCleanUp({ all, projectName: 'myapp', keepId: 'perm-apprun-now', target: 'apprun' }))
      .toEqual(['perm-apprun-old'])
    expect(permissionsToCleanUp({ all, projectName: 'myapp', keepId: 'perm-ded-now', target: 'apprun-dedicated' }))
      .toEqual(['perm-dedicated'])
  })

  // ── 検分の指摘1・2・3 ───────────────────────────────────────────────────
  // publishAppFlow は verify が no-backend（503）でも ok:true, stage:'done' を返す
  // （公開の手続き自体は通っているため）。**それは「動いた」の証拠ではない。**
  // 2026-09-16 の実機事故（LB が『no available server』・コンテナが EACCES で再起動）と
  // 同じ場面で古い鍵を消すと、まだ動いている古いコンテナが 403 で落ちる。
  it('★ アプリが応答していない（503）ときは、公開が ok でも古い鍵を1件も消さない', async () => {
    setupProject()
    permissionsAll()
    h.probeStatus = 503 // ロードバランサは 503 ＝ no-backend
    const { result } = await runPublish()

    expect(result.ok).toBe(true)
    expect(result.verify).toBe('no-backend')
    expect(h.deletedPermissions).toEqual([])
  })

  it('★ 応答がエラー（404）のときも消さない（届いてはいるが、開けない）', async () => {
    setupProject()
    permissionsAll()
    h.probeStatus = 404
    const { result } = await runPublish()

    expect(result.ok).toBe(true)
    expect(result.verify).toBe('error-status')
    expect(h.deletedPermissions).toEqual([])
  })

  it('★ 応答を確かめられたときだけ消す（200 ＝ responding）', async () => {
    setupProject()
    permissionsAll()
    const { result } = await runPublish()

    expect(result.verify).toBe('responding')
    expect(h.deletedPermissions).toEqual(['perm-old-dedicated'])
  })

  it('★ 確認をとばしたとき（LBのIPが取れず verify が付かない）も消さない', async () => {
    setupProject()
    permissionsAll()
    const routes = okRoutes()
    routes[LB_NODES_KEY] = { status: 200, body: { loadBalancerNodes: [] } }
    const { result } = await runPublish(routes)

    expect(result.ok).toBe(true)
    expect(result.verify).toBeUndefined()
    expect(h.deletedPermissions).toEqual([])
  })

  it('★ 公開が失敗したら、古い鍵を消さない（古いコンテナがまだ動いている）', async () => {
    setupProject()
    permissionsAll()
    // 有効化のあとに読み直しても activeVersion が新版にならない＝ stage:'activate' で失敗する
    const routes = okRoutes()
    routes['GET /applications/app-1'] = { status: 200, body: { application: { applicationID: 'app-1', name: 'myapp', clusterID: 'cluster-x', activeVersion: 1 } } }
    const { result } = await runPublish(routes)

    expect(result.ok).toBe(false)
    expect(result.stage).toBe('activate')
    expect(h.deletedPermissions).toEqual([])
  })
})

// ── 3-b. 途中で止まったときの後始末（検分の指摘5・10） ──────────────────
//
// 鍵の発行はイメージの組み立てより前に置いてある（渡せないと分かったら、レジストリへ
// 書き込む前に止めるため）。そのぶん、**あとの段で止まると発行済みの鍵が残る**。
// 片づけは成功した公開でしか走らないので、押した回数だけ溜まっていく。

describe('AppRun 専有型: 公開が途中で止まったとき、いま発行した鍵を残さない', () => {
  it('★ イメージの組み立てで止まったら、いま発行した鍵を取り消す（古い鍵には触れない）', async () => {
    setupProject()
    h.permissions = [
      { id: 'perm-old-dedicated', displayName: 'koto-myapp_apprun-dedicated' },
      { id: 'perm-new', displayName: 'koto-myapp_apprun-dedicated' },
    ]
    h.imageFails = true
    const { result } = await runPublish()

    expect(result.ok).toBe(false)
    expect(result.stage).toBe('image')
    // 消えるのは「いま発行した1件」だけ。古い鍵（まだ動いているアプリが使う）は残る
    expect(h.deletedPermissions).toEqual([ISSUED.permissionId])
  })

  it('★ 版が作られたかもしれない段（activate）では取り消さない（動き出した瞬間に 403 になる）', async () => {
    setupProject()
    const routes = okRoutes()
    routes['GET /applications/app-1'] = { status: 200, body: { application: { applicationID: 'app-1', name: 'myapp', clusterID: 'cluster-x', activeVersion: 1 } } }
    const { result } = await runPublish(routes)

    expect(result.ok).toBe(false)
    expect(result.stage).toBe('activate')
    expect(h.deletedPermissions).toEqual([])
  })

  it('保存場所を使っていないときは、そもそも取り消すものが無い（余計な要求を出さない）', async () => {
    setupProject({ storage: false })
    h.imageFails = true
    const { result } = await runPublish()

    expect(result.ok).toBe(false)
    expect(h.deletedPermissions).toEqual([])
  })
})

// ── 3-c. 画面に無言の時間を作らない（検分の指摘13） ─────────────────────
//
// 鍵の発行はさくらへの要求（認証情報の復号とアダプタの接続を含む）で数秒止まることがあり、
// 片づけも同じ。専有型の公開は各段の頭で1回ずつ進捗を出す作りなので、ここだけ無言にしない。

describe('AppRun 専有型: 鍵の用意と片づけを画面に伝える', () => {
  it('★ 鍵を用意する前と、古い鍵を片づける前に、進捗を出す', async () => {
    setupProject()
    h.permissions = [{ id: 'perm-old-dedicated', displayName: 'koto-myapp_apprun-dedicated' }]
    await runPublish()

    expect(progressMsgs).toContain('🔑 保存場所の鍵を用意しています…')
    expect(progressMsgs).toContain('🧹 古い鍵を片づけています…')
    // 鍵の用意は「イメージの組み立て」より前（渡せないと分かったら push の前に止める）
    expect(progressMsgs.indexOf('🔑 保存場所の鍵を用意しています…'))
      .toBeLessThan(progressMsgs.indexOf('🧹 古い鍵を片づけています…'))
  })

  it('保存場所を使っていないときは、鍵の話を出さない', async () => {
    setupProject({ storage: false })
    await runPublish()

    expect(progressMsgs).not.toContain('🔑 保存場所の鍵を用意しています…')
    expect(progressMsgs).not.toContain('🧹 古い鍵を片づけています…')
  })

  it('アプリが応答していないときは、片づけの進捗も出ない（そもそも片づけない）', async () => {
    setupProject()
    h.probeStatus = 503
    await runPublish()

    expect(progressMsgs).toContain('🔑 保存場所の鍵を用意しています…')
    expect(progressMsgs).not.toContain('🧹 古い鍵を片づけています…')
  })
})

// ── 4. 秘密をディスクに書かない（掟4） ──────────────────────────────────

describe('AppRun 専有型: 発行した秘密をディスクに残さない', () => {
  it('★ 公開のあと、.sakura-cloud/env.json にもプロジェクトのどのファイルにも秘密が無い', async () => {
    setupProject()
    const { result } = await runPublish()
    expect(result.ok).toBe(true)

    const envJson = fs.readFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), 'utf-8')
    expect(envJson).not.toContain(ISSUED.secretKey)
    expect(envJson).not.toContain(STORAGE_ENV.secretKey)

    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
      .flatMap(d => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]))
    for (const file of walk(projectDir)) {
      expect(fs.readFileSync(file, 'utf-8')).not.toContain(ISSUED.secretKey)
    }
  })
})
