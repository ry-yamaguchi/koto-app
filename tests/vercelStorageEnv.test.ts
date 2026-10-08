import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── なぜこのテストが要るか（2026-09-24）────────────────────────────────
// Vercel は「保存場所の設定を渡す仕組みが無い」として、データを使うアプリの公開を
// 止めていた。制約は Vercel 側ではなく Koto 側だったので、渡せるようにして止めるのをやめた。
// ここで固定するのは**お金と破壊の歯止め**（掟10）:
//   ・用意していない保存場所を勝手に作らない（＝勝手に課金しない）＝1件も送らない
//   ・用意してあるのに渡せないなら公開を止める（利用者が「残る」と思ったまま失わない）
//   ・ほかの公開先（AppRun 共用型・専有型・HANAMII）の鍵に触れない（掟11）
//
// **ソースの文字列は読まない。** 偽の client（fetch を差し替えたもの）へ実際に流し、
// **送られた要求の URL と本文**を見る。過去に文字列一致のテストが変異を素通りしている。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  /** loadCredentials が返す値。null にすると「APIキーが未登録」＝鍵を発行できない。 */
  creds: null as null | { token: string; secret: string },
  issuedNames: [] as string[],
  deletedPermissions: [] as string[],
  permissions: [] as { id: string; displayName: string }[],
}))

/** 発行される鍵（**実キーは使わない**・掟4）。 */
const ISSUED = { accessKey: 'AKIA-VERCEL-ONE', secretKey: 'S3CRET-VERCEL-ONE', permissionId: 'perm-new' }
const SITE = { s3Endpoint: 's3.isk01.sakurastorage.jp', region: 'jp-north-1' }

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
  return { ...real, loadCredentials: () => h.creds }
})

// 偽のストレージ。**何を発行し、何を消したか**を記録するだけ。
vi.mock('../src/main/cloud/storageAdapter', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    createStorageAdapter: async () => ({
      siteInfo: () => SITE,
      async issueKey(_bucket: string, displayName: string) { h.issuedNames.push(displayName); return ISSUED },
      async listPermissions() { return h.permissions },
      async deletePermission(id: string) { h.deletedPermissions.push(id) },
      async dispose() { /* 一時キーは使っていない */ },
    }),
  }
})

import { registerVercelHandlers } from '../src/main/ipc/vercel'
import { cleanUpOldKeysFor } from '../src/main/cloud/storageForTarget'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'
import { STORAGE_ENV } from '../src/shared/objectStorage'
import { permissionNameFor } from '../src/shared/storageKeys'

registerVercelHandlers({} as any)
const publish = h.handlers.get('vercel:publish')!
const EVENT = { sender: { send: () => {} } }
const OPTS = { token: 'tok-test', teamId: 'team-test', name: 'myapp' }

/** 偽の client が受け取った要求（**これが検査の対象**）。 */
type Sent = { method: string; url: string; body: any }
let sent: Sent[] = []
/**
 * `/env` の応答を**呼ばれた順に**差し替える（2026-09-24 検分の指摘9・15）。
 *
 * 初回公開は「1回目は 404（Vercel 側にまだプロジェクトが無い）→ 公開 → 2回目で置き直す」
 * という**いちばん壊れやすい分岐**を通る。1つの数字しか持てないと、この経路を一度も踏めない。
 * 足りなくなったら**最後の値を繰り返す**（回数を数え間違えてもテストが嘘をつかない）。
 */
let envStatuses: number[] = [200]
let envCalls = 0
const nextEnvStatus = () => envStatuses[Math.min(envCalls++, envStatuses.length - 1)]
/** デプロイ作成の応答を差し替えたいときに使う（失敗経路で鍵を取り消すかを見る）。 */
let deployStatus = 200
let projectDir = ''
let realFetch: typeof globalThis.fetch

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-vercel-storage-'))
  h.creds = { token: 'tok', secret: 'sec' }
  h.issuedNames = []
  h.deletedPermissions = []
  h.permissions = []
  sent = []
  envStatuses = [200]
  envCalls = 0
  deployStatus = 200
  realFetch = globalThis.fetch
  // **偽の client。** 実ネットワークへは一切出さない（出ようとしたら落とす）。
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input)
    const method = String(init?.method ?? 'GET')
    let body: any = init?.body
    if (typeof body === 'string') { try { body = JSON.parse(body) } catch { /* そのまま */ } }
    else if (body !== undefined) body = '<binary>'
    sent.push({ method, url, body })
    if (!url.startsWith('https://api.vercel.com/')) throw new Error(`テスト外への通信: ${url}`)
    const reply = (status: number, data: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(data),
    })
    if (url.includes('/env')) {
      const st = nextEnvStatus()
      return reply(st, st === 200 ? { created: [] } : { error: { message: 'no' } })
    }
    if (url.includes('/v2/files')) return reply(200, {})
    if (url.includes('/v13/deployments')) {
      return deployStatus === 200
        ? reply(200, { id: 'dpl-1', url: 'myapp.vercel.app', readyState: 'READY' })
        : reply(deployStatus, { error: { message: 'deploy-ng' } })
    }
    return reply(404, { error: { message: `未定義: ${url}` } })
  }) as any
})

afterEach(() => {
  globalThis.fetch = realFetch
  fs.rmSync(projectDir, { recursive: true, force: true })
})

const CONSENTED_BUCKET = { bucket: 'koto-data-x', prefix: 'projects/myapp/', shared: true, consentedAt: '2026-08-14T00:00:00.000Z' }

/**
 * `.sakura-cloud/env.json` と、公開できるファイルを1つ置く。
 *
 * `usesData: true` は「アプリが koto-data を使っている」状態にする（2026-09-24 検分の指摘1）。
 * **保存場所の有無とは別の軸**——この2つの組み合わせが「用意していないのにデータを使う」
 * という、いちばん静かに壊れる形を作る。
 */
function setupProject(opts: { storage?: boolean; usesData?: boolean } = {}) {
  const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: false })
  if (opts.storage !== false) spec.persistence = { objectStorage: [CONSENTED_BUCKET] }
  fs.mkdirSync(path.join(projectDir, '.sakura-cloud'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), JSON.stringify(spec, null, 2), 'utf-8')
  fs.writeFileSync(path.join(projectDir, 'index.html'), '<html><body>hi</body></html>', 'utf-8')
  if (opts.usesData) {
    fs.mkdirSync(path.join(projectDir, 'api'), { recursive: true })
    fs.writeFileSync(
      path.join(projectDir, 'api', 'save.js'),
      "import { get, set } from '../koto-data.js'\nexport default async () => set('k', await get('k'))\n",
      'utf-8',
    )
  }
}

const envRequests = () => sent.filter(s => s.url.includes('/env'))
const envVars = () => (envRequests()[0]?.body ?? []) as { key: string; value: string; type: string; target: string[] }[]

// ── 1. 渡している（データが残る）──────────────────────────────────────

describe('Vercel: 保存場所の設定を渡す', () => {
  it('★ 保存場所があるとき、KOTO_STORAGE_* の6件が1回で送られる', async () => {
    setupProject()
    const r = await publish(EVENT, projectDir, OPTS)
    expect(r.ok).toBe(true)
    expect(envRequests()).toHaveLength(1)   // **6件を1回で**（1件ずつ6回ではない）
    const keys = envVars().map(v => v.key).sort()
    expect(keys).toEqual([
      STORAGE_ENV.accessKey, STORAGE_ENV.bucket, STORAGE_ENV.endpoint,
      STORAGE_ENV.prefix, STORAGE_ENV.region, STORAGE_ENV.secretKey,
    ].sort())
    expect(envVars().find(v => v.key === STORAGE_ENV.bucket)!.value).toBe('koto-data-x')
    expect(envVars().find(v => v.key === STORAGE_ENV.secretKey)!.value).toBe(ISSUED.secretKey)
  })

  it('★ 秘密キーだけ sensitive、ほかは plain', async () => {
    setupProject()
    await publish(EVENT, projectDir, OPTS)
    const sensitive = envVars().filter(v => v.type === 'sensitive').map(v => v.key)
    expect(sensitive).toEqual([STORAGE_ENV.secretKey])
    expect(envVars().filter(v => v.type === 'plain')).toHaveLength(5)
    expect(envVars().every(v => v.type === 'plain' || v.type === 'sensitive')).toBe(true)
  })

  it('★ upsert=true が付く（付かないと2回目の公開が 403 で通らない）', async () => {
    setupProject()
    await publish(EVENT, projectDir, OPTS)
    const req = envRequests()[0]
    expect(req.method).toBe('POST')
    expect(req.url).toContain('/v10/projects/myapp/env')
    expect(req.url).toContain('upsert=true')
    expect(req.url).toContain('teamId=team-test')   // teamId はクエリ
  })

  it('★ 環境変数はデプロイを作る前に送る（作成時点の設定が焼き付くため）', async () => {
    setupProject()
    await publish(EVENT, projectDir, OPTS)
    const envAt = sent.findIndex(s => s.url.includes('/env'))
    const depAt = sent.findIndex(s => s.url.includes('/v13/deployments'))
    expect(envAt).toBeGreaterThanOrEqual(0)
    expect(envAt).toBeLessThan(depAt)
  })
})

// ── 2. 勝手に課金しない・黙って失わない ────────────────────────────────

describe('Vercel: 用意していないものは作らない／渡せないなら止める', () => {
  it('★ 保存場所を用意していないときは、環境変数を1件も送らない', async () => {
    setupProject({ storage: false })
    const r = await publish(EVENT, projectDir, OPTS)
    expect(r.ok).toBe(true)             // 保存場所を使わないアプリは、そのまま公開できる
    expect(envRequests()).toHaveLength(0)
    expect(h.issuedNames).toEqual([])   // 鍵も発行しない
  })

  it('★ 鍵を発行できないときは公開を止める（Vercel へ要求が1件も飛ばない）', async () => {
    setupProject()
    h.creds = null                       // さくらのクラウドのAPIキーが未登録＝渡せない
    const r = await publish(EVENT, projectDir, OPTS)
    expect(r.ok).toBe(false)
    expect(sent).toHaveLength(0)         // ファイルのアップロードもデプロイも起きない
    expect(String(r.message)).toContain('公開を中止しました')
  })

  it('★ 設定を渡せなかったら公開を止め、生のエラーを画面へ出さない', async () => {
    setupProject()
    envStatuses = [403]
    const r = await publish(EVENT, projectDir, OPTS)
    expect(r.ok).toBe(false)
    expect(sent.some(s => s.url.includes('/v13/deployments'))).toBe(false)
    expect(String(r.message)).toContain('公開を中止しました')
    expect(String(r.message)).not.toContain(ISSUED.secretKey)
  })
})

// ── 2b. 初回公開（Vercel 側にまだプロジェクトが無い＝404）────────────────
//
// 2026-09-24 検分の指摘9・15。ここは「先送り→公開→置き直し」と分岐が3つ重なるのに、
// テストが1件も無かった（偽 client は 200 と 403 しか流していなかった）。
// **書き換えてもどのテストも落ちない**状態だったので、振る舞いで固定する。

describe('Vercel: 初回公開（/env が 404）', () => {
  it('★ 404 でも公開は止まらず、READY のあとに /env をもう一度送る', async () => {
    setupProject()
    envStatuses = [404, 200]
    const r = await publish(EVENT, projectDir, OPTS)
    expect(r.ok).toBe(true)
    expect(envRequests()).toHaveLength(2)
    // 2回目は**デプロイのあと**（プロジェクトができてから置き直す）
    const depAt = sent.findIndex(s => s.url.includes('/v13/deployments'))
    const envIdx = sent.map((s, i) => (s.url.includes('/env') ? i : -1)).filter(i => i >= 0)
    expect(envIdx[0]).toBeLessThan(depAt)
    expect(envIdx[1]).toBeGreaterThan(depAt)
    // **この版にはまだ効かない**ことを黙らない
    expect(String(r.notice)).toContain('もう一度')
    expect(String(r.notice)).not.toContain(ISSUED.secretKey)
  })

  it('★ 置き直しに失敗したら、理由と直し方を伝える（403 は押し直しても直らない）', async () => {
    setupProject()
    envStatuses = [404, 403]
    const r = await publish(EVENT, projectDir, OPTS)
    expect(r.ok).toBe(true)                                  // 公開そのものは済んでいる
    expect(String(r.notice)).toContain('認証情報')            // 直し方（検分の指摘11・14）
    expect(String(r.notice)).toContain('403')
    // 初回公開に「公開を中止しました」は**嘘**になる（検分の指摘14）
    expect(String(r.notice)).not.toContain('公開を中止しました')
    expect(String(r.notice)).not.toContain(ISSUED.secretKey)
  })

  it('★ 置き直しに失敗したときは、古い鍵を片づけない（検分の指摘10）', async () => {
    setupProject()
    envStatuses = [404, 403]
    h.permissions = [
      { id: 'p-vercel-old', displayName: permissionNameFor('myapp', 'vercel') },
      { id: ISSUED.permissionId, displayName: permissionNameFor('myapp', 'vercel') },
    ]
    const r = await publish(EVENT, projectDir, OPTS)
    expect(r.ok).toBe(true)
    // 設定が1件も載っていないデプロイのために古い鍵を消すと、
    // **前の名前で生きている Vercel のデプロイ**がデータの読み書きで 403 になる
    expect(h.deletedPermissions).toEqual([])
  })

  it('★ 置き直しに成功したときは、古い鍵を片づける', async () => {
    setupProject()
    envStatuses = [404, 200]
    h.permissions = [
      { id: 'p-vercel-old', displayName: permissionNameFor('myapp', 'vercel') },
      { id: ISSUED.permissionId, displayName: permissionNameFor('myapp', 'vercel') },
    ]
    const r = await publish(EVENT, projectDir, OPTS)
    expect(r.ok).toBe(true)
    expect(h.deletedPermissions).toEqual(['p-vercel-old'])
  })
})

// ── 2c. 途中で止めたら、いま発行した鍵を取り消す（検分の指摘5・6・7）──────
//
// 片づけ（cleanUpOldKeysFor）は**成功した公開でしか走らない**。取り消さないと、
// 「公開する」を押した回数だけ、バケットへ読み書きできる鍵が溜まる
// （storageKeys.ts 冒頭の「実機で5件たまった」と同じ形）。

describe('Vercel: 途中で止めたときの鍵の後始末', () => {
  it('★ 環境変数を渡せず中止したとき、いま発行した鍵を取り消す', async () => {
    setupProject()
    envStatuses = [403]
    const r = await publish(EVENT, projectDir, OPTS)
    expect(r.ok).toBe(false)
    expect(h.issuedNames).toHaveLength(1)
    expect(h.deletedPermissions).toEqual([ISSUED.permissionId])   // 消すのは**いま出した1件だけ**
  })

  it('★ デプロイの作成に失敗したときも、いま発行した鍵を取り消す', async () => {
    setupProject()
    deployStatus = 500
    const r = await publish(EVENT, projectDir, OPTS)
    expect(r.ok).toBe(false)
    expect(h.deletedPermissions).toEqual([ISSUED.permissionId])
  })

  it('★ 古い鍵には触れない（動いているアプリを 403 で落とさない）', async () => {
    setupProject()
    envStatuses = [403]
    h.permissions = [
      { id: 'p-vercel-old', displayName: permissionNameFor('myapp', 'vercel') },
      { id: 'p-apprun', displayName: permissionNameFor('myapp', 'apprun') },
      { id: ISSUED.permissionId, displayName: permissionNameFor('myapp', 'vercel') },
    ]
    await publish(EVENT, projectDir, OPTS)
    expect(h.deletedPermissions).toEqual([ISSUED.permissionId])
  })
})

// ── 2d. 保存場所が未用意なのに、データを使っている（検分の指摘1）──────────

describe('Vercel: 保存場所が未用意のまま公開したとき', () => {
  it('★ データを使うアプリなら、公開の結果に「データは残りません」が付く', async () => {
    setupProject({ storage: false, usesData: true })
    const r = await publish(EVENT, projectDir, OPTS)
    expect(r.ok).toBe(true)                 // 公開は止めない（勝手に課金しない）
    expect(envRequests()).toHaveLength(0)   // 環境変数は1件も渡らない
    expect(h.issuedNames).toEqual([])       // 鍵も発行しない
    expect(String(r.notice)).toContain('残りません')
    expect(String(r.notice)).toContain('保存場所を用意する')
  })

  it('★ データを使っていないアプリには、余計なお知らせを出さない', async () => {
    setupProject({ storage: false })
    const r = await publish(EVENT, projectDir, OPTS)
    expect(r.ok).toBe(true)
    expect(r.notice).toBeUndefined()
  })
})

// ── 3. ほかの公開先の鍵に触れない（掟11）────────────────────────────────

describe('Vercel: ほかの公開先の鍵を消さない', () => {
  const others = () => [
    { id: 'p-apprun', displayName: permissionNameFor('myapp', 'apprun') },
    { id: 'p-dedicated', displayName: permissionNameFor('myapp', 'apprun-dedicated') },
    { id: 'p-hanamii', displayName: permissionNameFor('myapp', 'hanamii') },
    { id: 'p-other-project', displayName: permissionNameFor('otherapp', 'vercel') },
  ]

  it('★ Vercel の片づけは、AppRun・専有型・HANAMII・他プロジェクトの鍵を消さない', async () => {
    setupProject()
    h.permissions = [
      ...others(),
      { id: 'p-vercel-old', displayName: permissionNameFor('myapp', 'vercel') },
      { id: ISSUED.permissionId, displayName: permissionNameFor('myapp', 'vercel') },
    ]
    const r = await publish(EVENT, projectDir, OPTS)
    expect(r.ok).toBe(true)
    expect(h.deletedPermissions).toEqual(['p-vercel-old'])   // 消えるのは Vercel の古い1件だけ
  })

  it('★ 逆も同じ — AppRun の片づけが Vercel の鍵を消さない', async () => {
    h.permissions = [
      { id: 'p-apprun-old', displayName: permissionNameFor('myapp', 'apprun') },
      { id: 'p-apprun-now', displayName: permissionNameFor('myapp', 'apprun') },
      { id: 'p-vercel', displayName: permissionNameFor('myapp', 'vercel') },
    ]
    await cleanUpOldKeysFor({ projectName: 'myapp', target: 'apprun', keepId: 'p-apprun-now' })
    expect(h.deletedPermissions).toEqual(['p-apprun-old'])
  })

  it('★ 発行する鍵の名前が、ほかの公開先と重ならない', async () => {
    setupProject()
    await publish(EVENT, projectDir, OPTS)
    expect(h.issuedNames).toHaveLength(1)
    for (const t of ['apprun', 'apprun-dedicated', 'hanamii'] as const) {
      expect(h.issuedNames[0]).not.toBe(permissionNameFor('myapp', t))
    }
  })
})

// ── 4. 秘密はディスクに残さない（掟4）──────────────────────────────────

describe('Vercel: 秘密の扱い', () => {
  it('★ シークレットがプロジェクトのどのファイルにも書かれない', async () => {
    setupProject()
    const r = await publish(EVENT, projectDir, OPTS)
    expect(r.ok).toBe(true)
    // 送ってはいる（渡さなければデータが読めない）
    expect(JSON.stringify(envVars())).toContain(ISSUED.secretKey)
    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else files.push(p)
      }
    }
    walk(projectDir)
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      expect(fs.readFileSync(f, 'utf-8')).not.toContain(ISSUED.secretKey)
    }
  })
})
