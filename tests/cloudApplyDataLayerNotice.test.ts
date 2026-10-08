import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── なぜこのテストが要るか（2026-09-25 検分の指摘13）──────────────────────
//
// 公開の3経路（Vercel・共用型 AppRun・HANAMII）はどれも `ensureDataLayer` の
// **戻り値を捨てて**呼んでいた。前の回で Vercel だけが直り、共用型（`cloud:apply`）は
// 手つかずのまま残った——しかも
//
//     // **既にあれば触らないので、何度呼んでも安全。**
//
// という**嘘のコメント**が付いたままだった。ensureDataLayer は 2026-09-24 から
// 「印（`// koto-data-template:`）が付いていて版が古いファイル」を**上書きする**。
// つまり「公開する」を押しただけで利用者の koto-data が差し替わるのに、画面にも
// 🕘 履歴にも何も出ない。退避（.sakuraide-backup）も通らないので「前の状態に戻す」でも
// 戻せない。dataLayer.ts 自身が禁じていた事故そのものである。
//
// ここは**ソースの文字列を読まない**（掟10）。偽の さくら（applyPlan・prepareAppImage を
// 差し替えたもの）へ実際に流し、**ファイルが実際にどうなったか**と
// **結果に何が載ったか**で固定する。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  /** loadCredentials が返す値（実キーは使わない・掟4）。 */
  creds: { token: 'TEST-TOKEN', secret: 'TEST-SECRET' } as null | { token: string; secret: string },
  /** イメージの組み立てを失敗させるか（公開が途中で止まる道）。 */
  imageFails: false,
  /** applyPlan が返す結果の ok。 */
  applyOk: true,
  /** 組み立てのとき、手元の koto-data がどうなっていたか（**集める前に置いたか**を見る）。 */
  atImageBuild: undefined as string | null | undefined,
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {} },
  dialog: {},
}))

vi.mock('../src/main/cloud/auth', async (importOriginal) => {
  const real = await importOriginal<any>()
  return { ...real, loadCredentials: () => h.creds }
})

// 像の組み立て（レジストリへの push）。**実ネットワークへは出ない。**
vi.mock('../src/main/cloud/imagePublish', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    prepareAppImage: async (opts: any) => {
      const f = path.join(opts.projectDir, 'koto-data.js')
      h.atImageBuild = fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : null
      if (h.imageFails) return { ok: false, message: 'イメージを組み立てられませんでした（テスト）' }
      return {
        ok: true,
        tag: 'test-tag',
        image: 'koto-test',
        ref: 'registry.example/koto-test:test-tag',
        runtimeKind: 'static',
        registryAuth: { server: 'registry.example', username: 'u', password: 'p' },
      }
    },
  }
})

// さくらへの反映。**resources を空にして返す**ので、このあとの疎通確認・ログ設定・
// タグの数え上げ（どれも appId が要る）には一切入らない＝通信は起きない。
vi.mock('../src/main/cloud/apply', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    applyPlan: async (opts: any) => ({
      ok: h.applyOk,
      state: { name: opts.spec.name, backend: opts.spec.backend, resources: [] },
      executed: ['✅ AppRun アプリを作成（テスト）'],
      skipped: [],
      ...(h.applyOk ? {} : { message: '反映に失敗しました（テスト）' }),
    }),
  }
})

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'

registerCloudHandlers({} as any)
const apply = h.handlers.get('cloud:apply')!
const EVENT = { sender: { send: () => {} } }

const TEMPLATE_ESM = fs.readFileSync(path.join(process.cwd(), 'templates', 'koto-data.js'), 'utf-8')

let projectDir = ''

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-cloud-datalayer-'))
  h.creds = { token: 'TEST-TOKEN', secret: 'TEST-SECRET' }
  h.imageFails = false
  h.applyOk = true
  h.atImageBuild = undefined
})
afterEach(() => {
  try { fs.rmSync(projectDir, { recursive: true, force: true }) } catch { /* 消せなくてもよい */ }
})

/** 公開できるプロジェクト（保存場所は使わない＝鍵まわりには入らない）。 */
function setupProject() {
  const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: false })
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

describe('共用型 AppRun の公開: koto-data を差し替えたら、黙らない（指摘13）', () => {
  it('★★★ 古い版を差し替えたら、公開の結果（実行の一覧）に1行が載る', async () => {
    setupProject()
    const old = placeOldDataLayer()
    const r = await apply(EVENT, projectDir, { confirmed: true })

    expect(r.ok).toBe(true)
    // 実際に差し替わっている（＝黙って書き換える操作が起きている）
    expect(dataLayerText()).toBe(TEMPLATE_ESM)
    expect(dataLayerText()).not.toBe(old)
    // **その事実が利用者に届く**（画面は executed を「実行（executed）」として並べる）
    const executed = (r.executed ?? []).join('\n')
    expect(executed, '差し替えたのに黙っている（指摘13 が残っている）').toContain('差し替えました')
    expect(executed).toContain('koto-data.js')
    // もとの実行の記録は落とさない
    expect(executed).toContain('AppRun アプリを作成（テスト）')
  })

  it('★★★ 差し替えは、像を組み立てる前に済んでいる（古い版を公開物に入れない）', async () => {
    setupProject()
    placeOldDataLayer()
    await apply(EVENT, projectDir, { confirmed: true })
    expect(h.atImageBuild, '組み立ての時点でまだ古い版だった').toBe(TEMPLATE_ESM)
  })

  it('★★ 公開が途中で止まっても、差し替えたことは黙らない（像の組み立てで失敗）', async () => {
    setupProject()
    placeOldDataLayer()
    h.imageFails = true
    const r = await apply(EVENT, projectDir, { confirmed: true })

    expect(r.ok).toBe(false)
    expect(String(r.message)).toContain('差し替えました')
    expect(String(r.message)).toContain('koto-data.js')
    // 失敗の理由も落とさない（差し替えの1行で上書きしない）
    expect(String(r.message)).toContain('イメージを組み立てられませんでした')
  })

  it('★★ APIキーが無くて止まった回も、差し替えたことは黙らない', async () => {
    // ensureDataLayer は APIキーの確認より**前**にあるので、ここで止まってもファイルは既に変わっている。
    setupProject()
    const old = placeOldDataLayer()
    h.creds = null
    const r = await apply(EVENT, projectDir, { confirmed: true })

    expect(r.ok).toBe(false)
    expect(dataLayerText()).toBe(TEMPLATE_ESM)
    expect(dataLayerText()).not.toBe(old)
    expect(String(r.message)).toContain('APIキー未登録')
    expect(String(r.message), '差し替えたのに黙っている').toContain('差し替えました')
  })

  it('★ 差し替えていない回は、余計なお知らせを出さない', async () => {
    setupProject()
    fs.writeFileSync(path.join(projectDir, 'koto-data.js'), TEMPLATE_ESM, 'utf-8')   // 既に新しい版
    const r = await apply(EVENT, projectDir, { confirmed: true })
    expect(r.ok).toBe(true)
    expect((r.executed ?? []).join('\n')).not.toContain('差し替えました')
  })

  it('★ 初めて置いただけの回も、差し替えの知らせは出さない（書き換えていない）', async () => {
    setupProject()                                   // koto-data.js はまだ無い
    const r = await apply(EVENT, projectDir, { confirmed: true })
    expect(r.ok).toBe(true)
    expect(dataLayerText()).toBe(TEMPLATE_ESM)       // 約束どおり置く
    expect((r.executed ?? []).join('\n')).not.toContain('差し替えました')
  })

  // ★ ここを踏み外すと、データベース版に差し替えた利用者の仕事を消す
  it('★ Koto が置いた印の無いファイルは、触らない', async () => {
    setupProject()
    const mine = "// 自分で作り直した版\nexport const list = async () => []\nexport const save = async () => ({})\n"
    fs.writeFileSync(path.join(projectDir, 'koto-data.js'), mine, 'utf-8')
    const r = await apply(EVENT, projectDir, { confirmed: true })

    expect(r.ok).toBe(true)
    expect(dataLayerText()).toBe(mine)
    expect((r.executed ?? []).join('\n')).not.toContain('差し替えました')
  })
})
