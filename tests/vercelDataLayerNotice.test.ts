import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── なぜこのテストが要るか（2026-09-25 検分）──────────────────────────────
//
// 公開の経路は `ensureDataLayer` の**戻り値を捨てて**呼んでいた。
// ところが ensureDataLayer は 2026-09-24 から「既にあれば触らない」をやめ、
// **印（`// koto-data-template:`）が付いていて版が古いファイルを上書きする**ようになった。
//
// つまり「公開する」を押しただけで利用者の koto-data が差し替わるのに、
// 画面にも 🕘 履歴にも何も出ない。退避（.sakuraide-backup）も通らないので
// 「前の状態に戻す」でも戻せない。これは dataLayer.ts 自身が
// 「差し替えたものを Koto が黙って元に戻すと、利用者のデータの読み書きが突然
// オブジェクトストレージへ戻る」と書いて禁じていた事故そのものである。
//
// ここは**ソースの文字列を読まない**（掟10）。偽の client（fetch を差し替えたもの）へ
// 実際に流し、**ファイルが実際にどうなったか**と**結果に何が載ったか**で固定する。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  creds: null as null | { token: string; secret: string },
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
  return { ...real, loadCredentials: () => h.creds }
})

import { registerVercelHandlers } from '../src/main/ipc/vercel'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'

registerVercelHandlers({} as any)
const publish = h.handlers.get('vercel:publish')!
const EVENT = { sender: { send: () => {} } }
const OPTS = { token: 'tok-test', name: 'myapp' }

const TEMPLATE_ESM = fs.readFileSync(path.join(process.cwd(), 'templates', 'koto-data.js'), 'utf-8')

let projectDir = ''
let realFetch: typeof globalThis.fetch
/** 最初の要求が飛んだ時点の koto-data.js（**集める前に置いたか**を見るため）。 */
let atFirstRequest: string | null | undefined
let deployStatus = 200

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-vercel-datalayer-'))
  h.creds = { token: 'tok', secret: 'sec' }
  atFirstRequest = undefined
  deployStatus = 200
  realFetch = globalThis.fetch
  // **偽の client。** 実ネットワークへは一切出さない（出ようとしたら落とす）。
  globalThis.fetch = (async (input: any) => {
    const url = String(input)
    if (atFirstRequest === undefined) {
      const f = path.join(projectDir, 'koto-data.js')
      atFirstRequest = fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : null
    }
    if (!url.startsWith('https://api.vercel.com/')) throw new Error(`テスト外への通信: ${url}`)
    const reply = (status: number, data: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(data),
    })
    if (url.includes('/env')) return reply(200, { created: [] })
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

/**
 * 公開できるプロジェクト。**保存場所（バケット）は使わない**——ここで見たいのは
 * 鍵ではなく、置かれる／差し替えられるファイルのほう。
 */
function setupProject(opts?: { storage?: boolean }) {
  const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: false })
  // **同意済みの保存場所**（実キーは使わない・掟4）。これがあると `issueStorageEnvFor` は
  // 「渡すべき鍵がある」と判断するので、APIキーが無い回は公開を中止する道へ入る。
  if (opts?.storage) {
    spec.persistence = { objectStorage: [{ bucket: 'koto-data-x', prefix: 'projects/myapp/', shared: true, consentedAt: '2026-08-14T00:00:00.000Z' }] as any }
  }
  fs.mkdirSync(path.join(projectDir, '.sakura-cloud'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), JSON.stringify(spec, null, 2), 'utf-8')
  fs.writeFileSync(path.join(projectDir, 'index.html'), '<html><body>hi</body></html>', 'utf-8')
  fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'myapp', type: 'module' }, null, 2), 'utf-8')
  fs.writeFileSync(
    path.join(projectDir, 'app.js'),
    "import { list, save } from './koto-data.js'\nexport const run = async () => save('entries', await list('entries'))\n",
    'utf-8',
  )
}

/** 古い版の koto-data.js（Koto が置いた印はあるが、版が古い）を置く。 */
function placeOldDataLayer(): string {
  const old = TEMPLATE_ESM
    .replace(/^\/\/ koto-data-template: .*$/m, '// koto-data-template: 2026-01-01.0')
    .replace('export', '// 古い版の目印（差し替えられたら消える）\nexport')
  fs.writeFileSync(path.join(projectDir, 'koto-data.js'), old, 'utf-8')
  return old
}

const dataLayerText = () => {
  const f = path.join(projectDir, 'koto-data.js')
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : null
}

describe('Vercel の公開: koto-data を差し替えたら、黙らない', () => {
  it('★ 古い版を差し替えたら、公開の結果（お知らせ）に1行が載る', async () => {
    setupProject()
    const old = placeOldDataLayer()
    const r = await publish(EVENT, projectDir, OPTS)

    expect(r.ok).toBe(true)
    // 実際に差し替わっている（＝黙って書き換える操作が起きている）
    expect(dataLayerText()).toBe(TEMPLATE_ESM)
    expect(dataLayerText()).not.toBe(old)
    // **その事実が利用者に届く**（画面は notice を出す）
    expect(String(r.notice)).toContain('koto-data.js')
    expect(String(r.notice)).toContain('差し替えました')
  })

  it('★ 差し替えは、ファイルを集める前に済んでいる（公開物に古い版を送らない）', async () => {
    setupProject()
    placeOldDataLayer()
    await publish(EVENT, projectDir, OPTS)
    // 最初の要求（アップロード）が飛んだ時点で、もう新しい版になっている
    expect(atFirstRequest).toBe(TEMPLATE_ESM)
  })

  it('★ 差し替えていない回は、余計なお知らせを出さない', async () => {
    setupProject()
    fs.writeFileSync(path.join(projectDir, 'koto-data.js'), TEMPLATE_ESM, 'utf-8')   // 既に新しい版
    const r = await publish(EVENT, projectDir, OPTS)
    expect(r.ok).toBe(true)
    // （保存場所が未用意のお知らせは別の話なので、差し替えの1行だけを見る）
    expect(String(r.notice ?? '')).not.toContain('差し替えました')
  })

  it('★ 初めて置いただけの回も、差し替えの知らせは出さない（書き換えていない）', async () => {
    setupProject()                                   // koto-data.js はまだ無い
    const r = await publish(EVENT, projectDir, OPTS)
    expect(r.ok).toBe(true)
    expect(dataLayerText()).toBe(TEMPLATE_ESM)       // 約束どおり置く
    expect(String(r.notice ?? '')).not.toContain('差し替えました')
  })

  // ★ ここを踏み外すと、データベース版に差し替えた利用者の仕事を消す
  it('★ Koto が置いた印の無いファイルは、触らない', async () => {
    setupProject()
    const mine = "// 自分で作り直した版\nexport const list = async () => []\nexport const save = async () => ({})\n"
    fs.writeFileSync(path.join(projectDir, 'koto-data.js'), mine, 'utf-8')
    const r = await publish(EVENT, projectDir, OPTS)

    expect(r.ok).toBe(true)
    expect(dataLayerText()).toBe(mine)
    expect(atFirstRequest).toBe(mine)
    expect(String(r.notice ?? '')).not.toContain('差し替えました')
  })

  it('★ 公開が途中で止まっても、差し替えたことは黙らない', async () => {
    setupProject()
    placeOldDataLayer()
    deployStatus = 500
    const r = await publish(EVENT, projectDir, OPTS)

    expect(r.ok).toBe(false)
    expect(String(r.message)).toContain('koto-data.js')
    expect(String(r.message)).toContain('差し替えました')
  })

  // ── 2026-09-25 検分の指摘12 ────────────────────────────────────────────
  // 「ensureDataLayer 以降のすべての return を通した」はずが、**その17行下の return だけ**が
  // 素の object のまま残っていた（鍵を用意できずに中止する道）。この道は通信の失敗でも通るので
  // 塞がっていない。**ファイルは既に書き換わっているのに、画面は差し替えを一言も言わない。**
  it('★★★ 鍵を用意できずに止まった回も、差し替えたことは黙らない（指摘12）', async () => {
    setupProject({ storage: true })    // 同意済みの保存場所あり
    h.creds = null                     // ＝APIキー未登録（issueStorageEnvFor が reason:'error'）
    const old = placeOldDataLayer()
    const r = await publish(EVENT, projectDir, OPTS)

    expect(r.ok).toBe(false)
    // 中止の理由はそのまま出る
    expect(String(r.message)).toContain('公開を中止しました')
    // **その回に起きた書き換えも、同じ画面で伝える**（ファイルは実際に差し替わっている）
    expect(dataLayerText()).toBe(TEMPLATE_ESM)
    expect(dataLayerText()).not.toBe(old)
    expect(String(r.message), '差し替えたのに黙っている（指摘12 が残っている）').toContain('差し替えました')
    expect(String(r.message)).toContain('koto-data.js')
  })

  // ── 2026-09-25 検分の指摘35 ────────────────────────────────────────────
  // お知らせの並び。既存の notice は「保存場所が無いのでデータは残りません」という
  // **失うものの警告**で、片づけの報告（差し替えました）より先に読ませる。
  it('★★ 失うものの警告を、片づけの報告より先に出す（指摘35）', async () => {
    setupProject()                     // 保存場所は未用意（＝データが残らない警告が出る）
    placeOldDataLayer()
    const r = await publish(EVENT, projectDir, OPTS)

    expect(r.ok).toBe(true)
    const notice = String(r.notice ?? '')
    const warn = notice.indexOf('データは残りません')
    const replaced = notice.indexOf('差し替えました')
    expect(warn, 'データが残らない警告が消えている').toBeGreaterThan(-1)
    expect(replaced, '差し替えの知らせが消えている').toBeGreaterThan(-1)
    expect(warn, '片づけの報告が、失うものの警告より上に来ている').toBeLessThan(replaced)
  })
})
