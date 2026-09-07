import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { checkUnusedFiles, moveToMaterialsFs } from '../src/main/ipc/unused'
import { listSnapshotSummaries } from '../src/main/backup/store'
import { MATERIALS_DIR } from '../src/shared/publishExclude'

// src/main/ipc/unused.ts はトップレベルで 'electron' を import しているが、
// **import されるだけでは electron の実体には触れない**（tests/fs.test.ts / tests/portOpen.test.ts
// と同じ事情）。checkUnusedFiles / moveToMaterialsFs 自体は fs/path しか使わないので、
// electron 非依存のまま本物の一時フォルダで実駆動できる。

// ── ロールバック検証用の fs.renameSync フック ────────────────────────────
// ESM では `vi.spyOn(fs, 'renameSync')` が使えない（モジュール名前空間は書き換え不可）。
// 代わりに 'fs' モジュール自体を「既定では本物へそのまま委譲するラッパー」に差し替え、
// renameSync だけをテストごとに差し替え可能にする。既定（impl:null）では本物の
// fs.renameSync がそのまま動くので、他のテストの実駆動には影響しない。
const renameHook = vi.hoisted(() => ({
  impl: null as null | ((from: fs.PathLike, to: fs.PathLike) => void),
  real: null as null | ((from: fs.PathLike, to: fs.PathLike) => void),
}))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  renameHook.real = actual.renameSync
  return {
    ...actual,
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      if (renameHook.impl) return renameHook.impl(from, to)
      return actual.renameSync(from, to)
    },
  }
})

let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-unused-'))
})
afterEach(() => {
  renameHook.impl = null
  fs.rmSync(dir, { recursive: true, force: true })
})

function write(rel: string, content = 'x'): void {
  const full = path.join(dir, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf-8')
}
const exists = (rel: string) => fs.existsSync(path.join(dir, rel))
const read = (rel: string) => fs.readFileSync(path.join(dir, rel), 'utf-8')

describe('checkUnusedFiles: 対応範囲（roadmap #22・静的サイト／Node／PHP）', () => {
  it('静的サイト（package.json 無し）は supported:true・runtime:static で未使用ファイルを返す', () => {
    write('index.html', '<a href="menu.html">メニュー</a>')
    write('menu.html', '<p>メニュー</p>')
    write('old.html', '<p>古い</p>') // どこからも参照されていない
    const r = checkUnusedFiles(dir)
    expect(r.supported).toBe(true)
    expect(r.runtime).toBe('static')
    expect(r.unused).toContain('old.html')
    expect(r.unused).not.toContain('menu.html')
    expect(r.unused).not.toContain('index.html') // ALWAYS_USED
  })

  it('Node アプリ（package.json + server.js）は supported:true・runtime:dynamic で検出する（roadmap #22で対象外を廃止）', () => {
    write('package.json', JSON.stringify({ scripts: { start: 'node server.js' } }))
    write('server.js', 'require("http").createServer().listen(3000)')
    write('old.html', '<p>古い</p>') // どこからも参照されていない
    const r = checkUnusedFiles(dir)
    expect(r.supported).toBe(true)
    expect(r.runtime).toBe('dynamic')
    expect(r.unused).toContain('old.html')
    // package.json は NODE_ALWAYS_USED_RE で守られ、未使用に出ない
    expect(r.unused).not.toContain('package.json')
    // server.js は package.json の scripts.start（文字列）から参照が見つかるため未使用に出ない
    expect(r.unused).not.toContain('server.js')
  })

  it('public/ があれば、その中を根として見る（resolvePublishRoot と同じ判断）', () => {
    write('README.md', 'これは直下。無視される') // public/ の外
    write('public/index.html', '<a href="menu.html">メニュー</a>')
    write('public/menu.html', '<p>メニュー</p>')
    write('public/old.html', '<p>古い</p>')
    const r = checkUnusedFiles(dir)
    expect(r.supported).toBe(true)
    expect(r.runtime).toBe('static')
    expect(r.unused).toEqual(['old.html']) // public/ からの相対パスで返る
  })

  it('存在しないプロジェクトフォルダは supported:true（例外を投げない）', () => {
    const r = checkUnusedFiles(path.join(dir, 'no-such-dir'))
    expect(r.supported).toBe(true) // package.json が読めない＝静的として扱う
    expect(r.runtime).toBe('static')
    expect(r.unused).toEqual([])
  })

  it('絶対パスでない projectDir は supported:false', () => {
    const r = checkUnusedFiles('not-absolute')
    expect(r).toEqual({ supported: false, unused: [], runtime: 'static' })
  })
})

describe('checkUnusedFiles: 実機の再現（Express アプリ・roadmap #22・2026-09-06）', () => {
  // 実機で見つかった Express アプリの構成をそのまま再現する:
  //   Koto の公開の根（<project>/public/）の中に Express アプリ本体
  //   （server.js・package.json・package-lock.json・README.md・Dockerfile）があり、
  //   さらにその中に、そのアプリが express.static() で配信する静的フォルダ
  //   （たまたま同じ名前の public/）があって、そこに test001・test002 が紛れ込んでいる。
  // 「express.static() の配下を丸ごと使用中扱いにする」案は採らない（実測で否定済み。
  // 静的配信ディレクトリの中こそ test001/test002 のような未参照ファイルが溜まる場所）。
  function writeExpressApp() {
    write('public/package.json', JSON.stringify({
      name: 'scheduleapp',
      main: 'server.js',
      scripts: { start: 'node server.js' },
      dependencies: { express: '^4.19.2' },
    }))
    write('public/package-lock.json', '{}')
    write('public/README.md', '# アプリの説明')
    write('public/Dockerfile', 'FROM node:20\nCOPY . .\nCMD ["node", "server.js"]')
    write('public/server.js', "const express = require('express')\nexpress().listen(3000)")
    write('public/public/index.html', '<link rel="stylesheet" href="style.css"><script src="app.js"></script>')
    write('public/public/app.js', 'console.log("app")')
    write('public/public/style.css', 'body { color: red; }')
    write('public/public/test001', 'どこからも参照されていない')
    write('public/public/test002', 'これも参照されていない')
  }

  it('test001・test002 だけが未使用として出て、package.json 等は出ない。runtime:dynamic', () => {
    writeExpressApp()
    const r = checkUnusedFiles(dir)
    expect(r.supported).toBe(true)
    expect(r.runtime).toBe('dynamic')
    expect(r.unused.sort()).toEqual(['public/test001', 'public/test002'])
  })
})

describe('checkUnusedFiles: PHP プロジェクト（roadmap #22）', () => {
  it('.php は URLで直接叩かれうるため、参照が無くても未使用に出ない。composer.json も守られる', () => {
    write('composer.json', JSON.stringify({ require: {} }))
    write('index.php', '<?php echo "top"; ?>')
    write('app/models/User.php', '<?php class User {} ?>') // どこからも require/include されない
    write('images/unused.png', 'バイナリのふり') // 孤立ファイル（.php ではない）
    const r = checkUnusedFiles(dir)
    expect(r.supported).toBe(true)
    expect(r.runtime).toBe('dynamic')
    expect(r.unused).not.toContain('composer.json')
    expect(r.unused).not.toContain('index.php')
    expect(r.unused).not.toContain('app/models/User.php')
    expect(r.unused).toContain('images/unused.png') // .php ではない孤立ファイルは従来どおり検出する
  })
})

describe('moveToMaterialsFs: 実際に動かす', () => {
  it('未使用ファイルを MATERIALS_DIR の直下へ移す（サブフォルダのファイルは basename で直下へ）', () => {
    write('old.html', '古い')
    write('images/unused.jpg', 'バイナリのふり')
    const r = moveToMaterialsFs(dir, ['old.html', 'images/unused.jpg'])
    expect(r.ok).toBe(true)
    expect(r.moved.sort()).toEqual(['images/unused.jpg', 'old.html'])
    expect(exists('old.html')).toBe(false)
    expect(exists('images/unused.jpg')).toBe(false)
    expect(exists(`${MATERIALS_DIR}/old.html`)).toBe(true)
    expect(exists(`${MATERIALS_DIR}/unused.jpg`)).toBe(true)
    expect(read(`${MATERIALS_DIR}/old.html`)).toBe('古い')
  })

  it('移動元の親フォルダが空になったら片づける', () => {
    write('images/unused.jpg', 'x')
    const r = moveToMaterialsFs(dir, ['images/unused.jpg'])
    expect(r.ok).toBe(true)
    expect(exists('images')).toBe(false) // 空になった images/ ごと消える
  })

  it('移動元の親フォルダに他のファイルが残っていれば片づけない', () => {
    write('images/unused.jpg', 'x')
    write('images/kept.jpg', 'y')
    const r = moveToMaterialsFs(dir, ['images/unused.jpg'])
    expect(r.ok).toBe(true)
    expect(exists('images')).toBe(true)
    expect(exists('images/kept.jpg')).toBe(true)
  })

  it('0件の呼び出しは何もせず ok:true', () => {
    const r = moveToMaterialsFs(dir, [])
    expect(r).toEqual({ ok: true, moved: [], snapshotOk: true })
  })

  it('public/ 配下からの相対パスでも、実ファイルは projectDir 直下から正しく動かす', () => {
    write('public/old.html', '古い')
    // checkUnusedFiles が返す形（public/ からの相対）をそのまま渡す
    const r = moveToMaterialsFs(dir, ['old.html'])
    expect(r.ok).toBe(true)
    expect(exists('public/old.html')).toBe(false)
    expect(exists(`${MATERIALS_DIR}/old.html`)).toBe(true)
  })
})

describe('moveToMaterialsFs: 同名衝突は拒否せず、空いている名前を自動で採る（2026-09-04 実機の修理）', () => {
  // 以前は「素材置き場に既に同名がある」「一括内で basename が重複する」のどちらも
  // throw で全体を拒否していた。実機では、以前 Koto で移動した test002 が素材置き場に
  // 残っているというだけで、新しい test002 を二度と移動できなくなっていた。

  it('①素材置き場に既に同名があれば、拒否せず改名して移動し renamed が返る', () => {
    write('test002', '新しい方')
    write(`${MATERIALS_DIR}/test002`, '前に移動した方')
    const r = moveToMaterialsFs(dir, ['test002'])
    expect(r.ok).toBe(true)
    expect(r.moved).toEqual(['test002'])
    expect(exists('test002')).toBe(false)
    expect(exists(`${MATERIALS_DIR}/test002`)).toBe(true) // 前に移動した方はそのまま
    expect(read(`${MATERIALS_DIR}/test002`)).toBe('前に移動した方')
    expect(exists(`${MATERIALS_DIR}/test002-2`)).toBe(true) // 新しい方は改名して移動
    expect(read(`${MATERIALS_DIR}/test002-2`)).toBe('新しい方')
    expect(r.renamed).toEqual([{ from: 'test002', to: 'test002-2' }])
  })

  it('②一括内で basename が重複しても両方移動する（images/a.png と photos/a.png → a.png と a-2.png）', () => {
    write('images/a.png', '画像側')
    write('photos/a.png', '写真側')
    const r = moveToMaterialsFs(dir, ['images/a.png', 'photos/a.png'])
    expect(r.ok).toBe(true)
    expect(r.moved.sort()).toEqual(['images/a.png', 'photos/a.png'])
    expect(exists(`${MATERIALS_DIR}/a.png`)).toBe(true)
    expect(exists(`${MATERIALS_DIR}/a-2.png`)).toBe(true)
    expect(read(`${MATERIALS_DIR}/a.png`)).toBe('画像側') // 先に処理された方はそのままの名前
    expect(read(`${MATERIALS_DIR}/a-2.png`)).toBe('写真側') // 後の方が改名される
    expect(r.renamed).toEqual([{ from: 'photos/a.png', to: 'a-2.png' }])
  })

  it('③🕘 退避（スナップショット）の移動先側は、採った名前で残る', () => {
    write('test002', '新しい方')
    write(`${MATERIALS_DIR}/test002`, '前に移動した方')
    const r = moveToMaterialsFs(dir, ['test002'])
    expect(r.ok).toBe(true)
    const { snapshots } = listSnapshotSummaries(dir)
    expect(snapshots).toHaveLength(1)
    const paths = snapshots[0].files.map(f => f.path).sort()
    // 採った名前（test002-2）で残る。前に移動した方（素の test002）は触っていないので記録されない
    expect(paths).toEqual(['test002', `${MATERIALS_DIR}/test002-2`].sort())
    const byPath = Object.fromEntries(snapshots[0].files.map(f => [f.path, f.action]))
    expect(byPath['test002']).toBe('overwrite') // 移動元は内容があった＝退避
    expect(byPath[`${MATERIALS_DIR}/test002-2`]).toBe('create') // 移動先はまだ無かった
  })
})

describe('moveToMaterialsFs: 保護パス拒否（isProtectedWritePath）', () => {
  it('移動元が保護パス（.env）なら拒否する', () => {
    write('.env', 'SECRET=1')
    const r = moveToMaterialsFs(dir, ['.env'])
    expect(r.ok).toBe(false)
    expect(r.moved).toEqual([])
    expect(exists('.env')).toBe(true) // 触られていない
  })

  it('移動元が Koto の管理領域（.sakuraide-backup 配下）なら拒否する', () => {
    write('.sakuraide-backup/whatever.json', '{}')
    const r = moveToMaterialsFs(dir, ['.sakuraide-backup/whatever.json'])
    expect(r.ok).toBe(false)
    expect(exists('.sakuraide-backup/whatever.json')).toBe(true)
  })

  it('.. を含む相対パスは脱出として拒否する（プロジェクトの外は操作できない）', () => {
    const r = moveToMaterialsFs(dir, ['../outside.txt'])
    expect(r.ok).toBe(false)
    expect(r.moved).toEqual([])
  })
})

describe('moveToMaterialsFs: 🕘 履歴（移動元・移動先の両方を退避する）', () => {
  it('移動元（内容退避）・移動先（まだ無かった印）の両方がスナップショットに記録される', () => {
    write('old.html', '古い内容')
    const r = moveToMaterialsFs(dir, ['old.html'])
    expect(r.ok).toBe(true)
    expect(r.snapshotOk).toBe(true)
    const { snapshots } = listSnapshotSummaries(dir)
    expect(snapshots).toHaveLength(1)
    const paths = snapshots[0].files.map(f => f.path).sort()
    expect(paths).toEqual(['old.html', `${MATERIALS_DIR}/old.html`].sort())
    const byPath = Object.fromEntries(snapshots[0].files.map(f => [f.path, f.action]))
    expect(byPath['old.html']).toBe('overwrite') // 内容があった＝退避
    expect(byPath[`${MATERIALS_DIR}/old.html`]).toBe('create') // まだ無かった
  })

  it('その時点へ戻すと、移動そのものが取り消される形になる（restoreToSnapshot と組み合わせ）', async () => {
    const { restoreToSnapshot } = await import('../src/main/backup/store')
    write('old.html', '古い内容')
    const r = moveToMaterialsFs(dir, ['old.html'])
    const snapshotId = listSnapshotSummaries(dir).snapshots[0].id
    const restored = restoreToSnapshot(dir, snapshotId)
    expect(restored.ok).toBe(true)
    expect(exists('old.html')).toBe(true)
    expect(read('old.html')).toBe('古い内容')
    expect(exists(`${MATERIALS_DIR}/old.html`)).toBe(false) // 先（移動先）は無かった扱いなので削除される
    void r
  })
})

describe('moveToMaterialsFs: 途中失敗のロールバック', () => {
  it('2件目の移動が失敗したら、1件目も元へ戻す（半分だけ動いた状態を残さない）', () => {
    write('a.html', 'A')
    write('b.html', 'B')

    // 事前検証（存在チェック）はすべて通したうえで、実際の rename 実行段だけを
    // 2回目に失敗させる（1回目・ロールバックの巻き戻しは本物の fs.renameSync を通す）。
    let calls = 0
    renameHook.impl = (from, to) => {
      calls++
      if (calls === 2) throw new Error('わざと失敗させた')
      return renameHook.real!(from, to)
    }

    const r = moveToMaterialsFs(dir, ['a.html', 'b.html'])

    expect(r.ok).toBe(false)
    expect(r.moved).toEqual([])
    // 1件目（a.html）は動いたあと、元へ戻っている
    expect(exists('a.html')).toBe(true)
    expect(exists(`${MATERIALS_DIR}/a.html`)).toBe(false)
    // 2件目（b.html）はそもそも動いていない
    expect(exists('b.html')).toBe(true)
    expect(exists(`${MATERIALS_DIR}/b.html`)).toBe(false)
  })
})
