import { describe, it, expect } from 'vitest'
import { planRun, type RunPlanIo } from '../src/renderer/runPlan'

// 「② 試す」の実行方法の判定（2026-09-01・Ryosuke の調査依頼から）。
// かつては静的優先（index.html が server.js より先）で、server.js＋index.html を持つ
// Node アプリがサーバー起動されず file:// で開かれていた。ここでは
// **「サーバーの実体があればサーバー優先」**の順序と、package.json の scripts.start 条件を固定する。

function io(files: Record<string, string | true>): RunPlanIo {
  return {
    exists: async (rel) => rel in files,
    readFile: async (rel) => {
      const v = files[rel]
      if (v === undefined || v === true) throw new Error('no file')
      return v
    },
  }
}

describe('planRun: サーバーの実体があればサーバー優先', () => {
  it('★★ server.js＋index.html の Node アプリは node-server（旧: index.html を file:// で開いて API が全滅していた）', async () => {
    expect(await planRun(io({ 'server.js': true, 'index.html': true, 'package.json': '{}' }))).toEqual({ kind: 'node-server', needsInstall: false })
  })

  it('★★ scripts.start 持ちの package.json＋index.html は npm-start', async () => {
    expect(await planRun(io({ 'package.json': JSON.stringify({ scripts: { start: 'node app.js' } }), 'index.html': true })))
      .toEqual({ kind: 'npm-start', needsInstall: false })
  })

  it('★★ 静的サイト（index.html のみ）は従来どおりブラウザで開く', async () => {
    expect(await planRun(io({ 'index.html': true }))).toEqual({ kind: 'open', rel: 'index.html' })
    expect(await planRun(io({ 'public/index.html': true }))).toEqual({ kind: 'open', rel: 'public/index.html' })
  })

  it('★★ start の無い package.json が転がっていても npm start に化けない（静的判定へ落ちる）', async () => {
    expect(await planRun(io({ 'package.json': '{}', 'index.html': true }))).toEqual({ kind: 'open', rel: 'index.html' })
  })

  it('★ 壊れた package.json は「start 無し」として安全側に落ちる', async () => {
    expect(await planRun(io({ 'package.json': '{壊れたJSON', 'index.html': true }))).toEqual({ kind: 'open', rel: 'index.html' })
  })

  it('★ Python アプリ: main.py が app.py より優先。ブラウザ自動オープンは無し（entry だけ返す）', async () => {
    expect(await planRun(io({ 'main.py': true, 'app.py': true }))).toEqual({ kind: 'python', entry: 'main.py' })
    expect(await planRun(io({ 'app.py': true }))).toEqual({ kind: 'python', entry: 'app.py' })
  })

  it('★ PHP: public/index.php が index.php より優先（レンタルサーバ向け構成）', async () => {
    expect(await planRun(io({ 'public/index.php': true, 'index.php': true }))).toEqual({ kind: 'php', docroot: 'publish' })
    expect(await planRun(io({ 'index.php': true }))).toEqual({ kind: 'php', docroot: 'root' })
  })

  it('★ server.js は npm-start より優先（明示のエントリが最強の証拠）', async () => {
    expect(await planRun(io({ 'server.js': true, 'package.json': JSON.stringify({ scripts: { start: 'x' } }) })))
      .toEqual({ kind: 'node-server', needsInstall: false })
  })

  it('★ PHP は静的より優先・サーバー系（node/python/npm）より後', async () => {
    expect(await planRun(io({ 'index.php': true, 'index.html': true }))).toEqual({ kind: 'php', docroot: 'root' })
    expect(await planRun(io({ 'server.js': true, 'index.php': true }))).toEqual({ kind: 'node-server', needsInstall: false })
  })

  it('★ 何も無ければ none（ヒント表示）', async () => {
    expect(await planRun(io({}))).toEqual({ kind: 'none' })
    expect(await planRun(io({ 'package.json': '{}' }))).toEqual({ kind: 'none' })
  })
})

describe('planRun: needsInstall（2026-09-01 実機・ScheduleAPP で helmet が node_modules に無く node server.js が即クラッシュした件）', () => {
  it('★★ dependencies の一つが node_modules に無ければ true（実機の再現: express はあるが helmet が無い）', async () => {
    const plan = await planRun(io({
      'server.js': true,
      'package.json': JSON.stringify({ dependencies: { express: '^4.0.0', helmet: '^7.0.0' } }),
      'node_modules/express': true,
      // helmet だけ node_modules に無い
    }))
    expect(plan).toEqual({ kind: 'node-server', needsInstall: true })
  })

  it('★★ dependencies が全部 node_modules に揃っていれば false', async () => {
    const plan = await planRun(io({
      'server.js': true,
      'package.json': JSON.stringify({ dependencies: { express: '^4.0.0', helmet: '^7.0.0' } }),
      'node_modules/express': true,
      'node_modules/helmet': true,
    }))
    expect(plan).toEqual({ kind: 'node-server', needsInstall: false })
  })

  it('★ node_modules が丸ごと無ければ true', async () => {
    const plan = await planRun(io({
      'server.js': true,
      'package.json': JSON.stringify({ dependencies: { express: '^4.0.0' } }),
    }))
    expect(plan).toEqual({ kind: 'node-server', needsInstall: true })
  })

  it('★ package.json が無い server.js 単体は false（依存を確認しようがない）', async () => {
    expect(await planRun(io({ 'server.js': true }))).toEqual({ kind: 'node-server', needsInstall: false })
  })

  it('★ 壊れた package.json は false（安全側・hasNpmStart と同じ流儀）', async () => {
    expect(await planRun(io({ 'server.js': true, 'package.json': '{壊れたJSON' })))
      .toEqual({ kind: 'node-server', needsInstall: false })
  })

  it('★ dependencies が無い/空の package.json は false', async () => {
    expect(await planRun(io({ 'server.js': true, 'package.json': '{}' }))).toEqual({ kind: 'node-server', needsInstall: false })
    expect(await planRun(io({ 'server.js': true, 'package.json': JSON.stringify({ dependencies: {} }) })))
      .toEqual({ kind: 'node-server', needsInstall: false })
  })

  it('★ devDependencies は見ない（本体には無関係）', async () => {
    const plan = await planRun(io({
      'server.js': true,
      'package.json': JSON.stringify({ devDependencies: { vitest: '^1.0.0' } }),
      // devDependencies にしか無いパッケージは node_modules に無くても無関係
    }))
    expect(plan).toEqual({ kind: 'node-server', needsInstall: false })
  })

  it('★ スコープ付きパッケージ（@scope/name）も node_modules/@scope/name として確認する', async () => {
    const missing = await planRun(io({
      'server.js': true,
      'package.json': JSON.stringify({ dependencies: { '@scope/pkg': '^1.0.0' } }),
    }))
    expect(missing).toEqual({ kind: 'node-server', needsInstall: true })

    const present = await planRun(io({
      'server.js': true,
      'package.json': JSON.stringify({ dependencies: { '@scope/pkg': '^1.0.0' } }),
      'node_modules/@scope/pkg': true,
    }))
    expect(present).toEqual({ kind: 'node-server', needsInstall: false })
  })

  it('★ npm-start でも同じ判定が効く', async () => {
    const plan = await planRun(io({
      'package.json': JSON.stringify({ scripts: { start: 'node app.js' }, dependencies: { express: '^4.0.0' } }),
    }))
    expect(plan).toEqual({ kind: 'npm-start', needsInstall: true })
  })
})
