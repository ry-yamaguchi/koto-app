import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── なぜこのテストが要るか（2026-09-25 検分）──────────────────────────────
//
// AI への説明文（aiContext.ts の DATA_RULE）は「koto-data のファイルは Koto が用意します
// （『② 試す』『③ 公開』を押した直前に置きます）」と**言い切っている**。
// 共用型 AppRun・HANAMII・Vercel・レンタルサーバ・② 試す はそのとおりにしていたが、
// **AppRun 専有型の⑧「アプリを公開する」だけが通っていなかった**。
//
// その結果:
//   ① AI が約束どおり書いた `require('./koto-data.cjs')` の読み込み先がイメージに入らず、
//      コンテナが `Cannot find module` で起動しない（2026-09-23 に共用型・HANAMII で
//      起きた事故と同じ形が、専有型にだけ残っていた）。しかも専有型は常時課金の
//      クラスタの上なので、原因不明の起動失敗を追う間ずっとお金がかかる
//   ② ensureDataLayer は「古い koto-data を新しい版へ差し替える」唯一の自動経路でもある。
//      専有型に公開したアプリにだけ、koto-data の直し（429 のやり直し・同時更新の検知）が
//      いつまでも届かない
//
// ここは**ソースの文字列を読まない**（掟10）。偽の client に実際に流し、
// **prepareAppImage（＝公開物を組み立てる段）に入った時点でファイルがあるか**を見る。
// 「置く呼び出しが書いてあるか」ではなく「組み立てる前に置かれているか」を固定する。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  creds: null as null | { token: string; secret: string },
  /** prepareAppImage が呼ばれた時点のプロジェクトの様子（**順番を見るための記録**）。 */
  atImage: null as null | { cjs: boolean; js: boolean; cjsText: string | null },
  imageCalls: 0,
  imageFails: false,
  /** publishAppFlow に渡った引数（公開の本文）。 */
  flowCalls: 0,
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

// 保存場所は使わない設定で流すので、鍵の発行は起きない。念のため偽物にしておく
// （実ネットワークへ出さない）。
vi.mock('../src/main/cloud/storageAdapter', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    createStorageAdapter: async () => ({
      siteInfo: () => ({ s3Endpoint: 's3.isk01.sakurastorage.jp', region: 'jp-north-1' }),
      async issueKey() { return { accessKey: 'AKIA-X', secretKey: 'S3CRET-X', permissionId: 'perm-new' } },
      async listPermissions() { return [] },
      async deletePermission() { /* このテストでは使わない */ },
      async dispose() { /* 一時キーは使っていない */ },
    }),
  }
})

// イメージの組み立て（レジストリへの push）は動かさない。**入った瞬間のプロジェクトを写す**
// ——これが「組み立てる前に置いたか」を見る唯一の目。
let projectDir = ''
vi.mock('../src/main/cloud/imagePublish', () => ({
  prepareAppImage: async () => {
    h.imageCalls++
    const cjs = path.join(projectDir, 'koto-data.cjs')
    const js = path.join(projectDir, 'koto-data.js')
    h.atImage = {
      cjs: fs.existsSync(cjs),
      js: fs.existsSync(js),
      cjsText: fs.existsSync(cjs) ? fs.readFileSync(cjs, 'utf-8') : null,
    }
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

// 公開の本体（さくらへの要求）は流さない。**このテストで見たいのは、その前の段**。
vi.mock('../src/main/cloud/apprunDedicatedAppApply', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    publishAppFlow: async () => {
      h.flowCalls++
      return { ok: true, stage: 'done', message: '公開しました', applicationID: 'app-1', version: 2, url: 'https://app.example.com' }
    },
  }
})

import { registerApprunDedicatedHandlers } from '../src/main/ipc/apprunDedicated'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'
import { writeApprunDedicatedRecordFs } from '../src/main/publishMetaFs'
import { dataLayerStamp } from '../src/main/dataLayer'

registerApprunDedicatedHandlers({} as any)
const publishApp = h.handlers.get('apprunDedicated:publishApp')!
const EVENT = { sender: { send: () => {} } }
const AUTH = { token: 'tok', secret: 'sec' }
const INPUT = { host: 'app.example.com', cpu: 500, memory: 512, fixedScale: 1 }

const TEMPLATE_CJS = fs.readFileSync(path.join(process.cwd(), 'templates', 'koto-data.cjs'), 'utf-8')

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-dedicated-datalayer-'))
  h.creds = { token: 'tok', secret: 'sec' }
  h.atImage = null
  h.imageCalls = 0
  h.imageFails = false
  h.flowCalls = 0
})
afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true })
})

/**
 * `.sakura-cloud/env.json` と⑤のクラスタの記録を置く。
 *
 * `usesData` は「アプリが koto-data を読み込んでいる」状態（AI が説明文どおりに書いた直後の形）。
 * **保存場所（バケット）は使わない**——ここで見たいのは鍵ではなく、置かれるファイルのほう。
 */
function setupProject(opts: { usesData?: boolean } = {}) {
  const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: false })
  fs.mkdirSync(path.join(projectDir, '.sakura-cloud'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), JSON.stringify(spec, null, 2), 'utf-8')
  fs.writeFileSync(path.join(projectDir, 'index.html'), '<html><body>hi</body></html>', 'utf-8')
  if (opts.usesData !== false) {
    // require のアプリ（package.json に type を書かない＝CommonJS）
    fs.writeFileSync(
      path.join(projectDir, 'server.js'),
      "const { list, save } = require('./koto-data.cjs')\nrequire('http').createServer(async (_q, s) => s.end(JSON.stringify(await list('entries')))).listen(8080)\n",
      'utf-8',
    )
    fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'myapp', main: 'server.js' }, null, 2), 'utf-8')
  }
  writeApprunDedicatedRecordFs(projectDir, { clusterID: 'cluster-x', asgID: 'asg-y', loadBalancerID: 'lb-z' })
}

const run = () => publishApp(EVENT, projectDir, AUTH, INPUT, { confirmed: true })

/** 古い版の koto-data.cjs（Koto が置いた印はあるが、版が古い）を置く。 */
function placeOldDataLayer(): string {
  const old = TEMPLATE_CJS
    .replace(/^\/\/ koto-data-template: .*$/m, '// koto-data-template: 2026-01-01.0')
    .replace('module.exports', '// 古い版の目印（差し替えられたら消える）\nmodule.exports')
  fs.writeFileSync(path.join(projectDir, 'koto-data.cjs'), old, 'utf-8')
  return old
}

// ── 1. 公開の直前に置く（ほか4経路と同じ約束）────────────────────────────

describe('AppRun 専有型の⑧公開: 公開の直前に koto-data を置く', () => {
  it('★ イメージを組み立てる段に入った時点で、koto-data.cjs がもう置かれている', async () => {
    setupProject()
    const r = await run()

    expect(r.ok).toBe(true)
    expect(h.imageCalls).toBe(1)                         // 組み立ての段は確かに通っている
    expect(h.atImage?.cjs).toBe(true)                    // **その時点で**ファイルがある（順番が本丸）
    expect(h.atImage?.cjsText).toBe(TEMPLATE_CJS)        // 中身は Koto のテンプレートそのもの
    // 置いたあとも残る（あとで消していない）
    expect(fs.existsSync(path.join(projectDir, 'koto-data.cjs'))).toBe(true)
  })

  it('★ require のアプリに import 版（koto-data.js）を置かない', async () => {
    setupProject()
    await run()
    expect(h.atImage?.js).toBe(false)
  })

  it('koto-data を使っていないアプリには、置かない（要らないファイルを増やさない）', async () => {
    setupProject({ usesData: false })
    const r = await run()
    expect(r.ok).toBe(true)
    expect(h.atImage?.cjs).toBe(false)
    expect(h.atImage?.js).toBe(false)
  })
})

// ── 2. 古い版の差し替えと、その知らせ（2026-09-25 検分）──────────────────
//
// ensureDataLayer は「印があって版が古いもの」を**上書きする**。公開ボタンを押しただけで
// 利用者のファイルが変わるので、**黙って済ませない**（Vercel と同じ守り）。

describe('AppRun 専有型の⑧公開: 古い koto-data を差し替えたら、黙らない', () => {
  it('★ 古い版は新しい版へ差し替わり、その1行が公開の結果に載る', async () => {
    setupProject()
    const old = placeOldDataLayer()
    const r = await run()

    expect(r.ok).toBe(true)
    // 組み立てる段に入った時点で、もう新しい版になっている
    expect(h.atImage?.cjsText).toBe(TEMPLATE_CJS)
    expect(h.atImage?.cjsText).not.toBe(old)
    // **画面に出る形で知らせる**（warnings は⑧の結果の枠に出る）
    const note = (r.warnings ?? []).join('\n')
    expect(note).toContain('koto-data.cjs')
    expect(note).toContain('差し替えました')
  })

  it('★ 差し替えていない回は、余計な知らせを出さない', async () => {
    setupProject()
    fs.writeFileSync(path.join(projectDir, 'koto-data.cjs'), TEMPLATE_CJS, 'utf-8')   // 既に新しい版
    const r = await run()
    expect(r.ok).toBe(true)
    expect((r.warnings ?? []).join('\n')).not.toContain('差し替えました')
  })

  // ★ ここを踏み外すと、データベース版に差し替えた利用者の仕事を消す
  it('★ Koto が置いた印の無いファイルは、触らない（作り替えたものを元に戻さない）', async () => {
    setupProject()
    const mine = "// 自分で作り直した版\nmodule.exports = { list: async () => [], save: async () => ({}) }\n"
    fs.writeFileSync(path.join(projectDir, 'koto-data.cjs'), mine, 'utf-8')
    const r = await run()

    expect(r.ok).toBe(true)
    expect(h.atImage?.cjsText).toBe(mine)                                                  // 組み立てにも自分の版が入る
    expect(fs.readFileSync(path.join(projectDir, 'koto-data.cjs'), 'utf-8')).toBe(mine)
    expect(dataLayerStamp(mine)).toBe(null)
  })

  it('★ 公開が途中で止まっても、差し替えたことは黙らない', async () => {
    setupProject()
    placeOldDataLayer()
    h.imageFails = true
    const r = await run()

    expect(r.ok).toBe(false)
    expect(h.flowCalls).toBe(0)                       // 公開そのものは進んでいない
    expect(String(r.message)).toContain('koto-data.cjs')
    expect(String(r.message)).toContain('差し替えました')
  })
})
