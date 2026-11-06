import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// ── 0.6.26 移動の前に聞く口（project:moveCheck）──────────────────────────────────────────
// 画面は、確認を出す前にこの口へ聞く。断りの理由は、実際に動かす前の検証（planMoveFiles）が全部持つ。
// 見るのは次の4つ（本物の一時フォルダと、偽の ipcMain から IPC 名で呼ぶ。moveWorkspaceGuard.test.ts と同じ形）。
//   1. 断る場合: moveCheck の答えは `ok:false` で、文は実際の moveFiles と同じ。聞いてもディスクは1つも動かない。
//   2. 通す場合: `ok:true` で、`renamed` の予告は実際の moveFiles の結果と一致する。聞くだけでは何も作らない。
//   3. 形違い・予期しない例外は断る側（不明値を「できる」に倒さない）。
//   4. 実行（moveFiles）は聞いたことを信じない。聞いたあとに状況が変わっても、実行が自分で検証して断る。
//   5. 聞くのは断りの規則だけ。書き込めない場所などの失敗は実行で起き、ok:true のあとでも移動が失敗することがある（動かさずに ok:false）。
// 変異: ①moveFilesToFs が検証の断りを無視する ②保護パスの判断（isProtectedWritePath）を通さない
//       ③検証の失敗や形違いを ok に倒す（catch・配列の確かめ・移動先の確かめ） ④調べられないフォルダ（unknown）を通す
//       ⑤検証の前にディスクを動かす（順序の入れ替え）⑥同じ指定の重複を1件にまとめない（new Set を外す）。

const m = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { m.handlers.set(channel, fn) } },
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test' },
  dialog: {},
  shell: {},
}))

import { moveFilesToFs, moveCheckFs, planMoveFiles, registerUnusedHandlers } from '../src/main/ipc/unused'
import { FS_MOVE_MESSAGES } from '../src/main/ipc/fsTrash'
import { MATERIALS_DIR } from '../src/shared/publishExclude'
import { PUBLISH_DIR } from '../src/shared/publishRoot'

let ws = ''
const lockedDirs: string[] = []
beforeEach(() => {
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koto-movecheck-')))
  m.handlers.clear()
  registerUnusedHandlers()
})
afterEach(() => {
  for (const d of lockedDirs.splice(0)) { try { fs.chmodSync(d, 0o755) } catch { /* 無い */ } }
  fs.rmSync(ws, { recursive: true, force: true })
})

function put(rel: string, content = 'x'): void {
  const full = path.join(ws, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf-8')
}
/** ディスクの前後比較用。フォルダとファイル（中身つき）を全部書き出す。読めないフォルダはその旨を書く。 */
function tree(dir = ws, rel = ''): string[] {
  const out: string[] = []
  let names: string[]
  try { names = fs.readdirSync(path.join(dir, rel)).sort() } catch { return [`${rel || '.'}/ <読めない>`] }
  for (const n of names) {
    const r = rel ? `${rel}/${n}` : n
    const st = fs.lstatSync(path.join(dir, r))
    if (st.isDirectory()) { out.push(`${r}/`); out.push(...tree(dir, r)) } else out.push(`${r} = ${fs.readFileSync(path.join(dir, r), 'utf-8')}`)
  }
  return out
}
const call = async (channel: string, ...args: unknown[]) => m.handlers.get(channel)!({}, ...args)
const check = (files: unknown, dest: unknown, dir: unknown = ws) => call('project:moveCheck', dir, files, dest)
const run = (files: unknown, dest: unknown, dir: unknown = ws) => call('project:moveFiles', dir, files, dest)
const rootIsMe = typeof process.getuid === 'function' && process.getuid() === 0

/** ふつうの1つのプロジェクト: 直下に記録・.git・.env、ふつうのファイルとフォルダ。 */
function project(): void {
  put('.sakuraide.json', '{"target":"hanamii"}'); put('.sakuraide-backup/1/a.json', '{"b":1}'); put('.sakura-cloud/state.json', '{"s":1}')
  put('.git/config', '[core]'); put('.git/hooks/pre-commit', '#!/bin/sh'); put('.env', 'KEY=1'); put('.env.local', 'KEY=2'); put('config/.env.production', 'KEY=3')
  put('index.html', '<p>top</p>'); put('images/logo.png', 'PNG'); put('images/photo.png', 'PHOTO'); put('photos/photo.png', 'OTHER'); put('readme.txt', 'ふつうのファイル')
  put('docs/a.txt', 'docs の中'); put('docs/b.txt', 'b')
}
/** 作業場所を開いた形: 子のプロジェクト proj・projB（記録は大文字小文字違い）・中に入れ子のプロジェクトがあるフォルダ clients、ふつうのファイル・フォルダ。 */
function workspace(): void {
  put('proj/.sakuraide.json', '{"target":"hanamii"}'); put('proj/index.html', '<p>proj</p>'); put('proj/.sakura-cloud/state.json', '{"s":1}')
  put('projB/.SAKURAIDE.JSON', '{"B":1}'); put('projB/index.html', '<p>B</p>')
  put('clients/acme/.sakuraide.json', '{"a":1}'); put('clients/acme/index.html', '<p>acme</p>')
  put('sub/deep/.sakuraide-backup/1/a.json', '{"b":1}')
  put('readme.txt', 'ふつうのファイル'); put('plainfolder/a.txt', 'ふつうのフォルダの中'); put('plainfolder/b.txt', 'b')
}

type Dest = 'materials' | 'publish'
const DESTS: Dest[] = ['materials', 'publish']
const destDir = (d: Dest) => (d === 'publish' ? PUBLISH_DIR : MATERIALS_DIR)
const PROTECTED = 'Koto が管理する領域は移動できません'
const SELF = 'プロジェクトのフォルダそのものは移動できません'

/** 断る場合の共通の確かめ: 聞いても・実行しても `ok:false` で、文は同じ。ディスクは聞く前・聞いた後・実行した後で変わらない。 */
async function expectRefused(files: string[], dest: Dest, message: string, label: string): Promise<void> {
  const before = tree()
  const c = await check(files, dest)
  expect(c, `check ${label}`).toEqual({ ok: false, message })
  expect(tree(), `check のあと ${label}`).toEqual(before)
  const r = await run(files, dest)
  expect(r, `run ${label}`).toMatchObject({ ok: false, moved: [], snapshotOk: false, message })
  expect(r.message, `run と check の文は同じ ${label}`).toBe(c.message)
  expect(tree(), `run のあと ${label}`).toEqual(before)
}

describe('★★★ project:moveCheck（ふつうのプロジェクト）: 記録・.git・.env・プロジェクトのフォルダ自身は ok:false。文は実際の moveFiles と同じで、ディスクは動かない', () => {
  it.each(DESTS)('★★★ [%s] 記録（.sakuraide.json・.sakuraide-backup・.sakura-cloud の中）は断る', async dest => {
    project()
    for (const rel of ['.sakuraide.json', '.sakuraide-backup', '.sakuraide-backup/1/a.json', '.sakura-cloud/state.json', '.sakura-cloud']) {
      await expectRefused([rel], dest, `${PROTECTED}: ${rel}`, rel)
    }
  })

  it.each(DESTS)('★★★ [%s] .git（フックを含む）と .env 系（階層の途中でも）は断る', async dest => {
    project()
    for (const rel of ['.git', '.git/config', '.git/hooks/pre-commit', '.env', '.env.local', 'config/.env.production']) {
      await expectRefused([rel], dest, `${PROTECTED}: ${rel}`, rel)
    }
  })

  it.each(DESTS)('★★★ [%s] `..` を通した記録・.env も、正規化してから守りに当てて断る', async dest => {
    project()
    for (const rel of ['docs/../.sakuraide.json', './.sakuraide.json', 'docs/../.env', 'docs/../.git/config']) {
      await expectRefused([rel], dest, `${PROTECTED}: ${rel}`, rel)
    }
  })

  it.each(DESTS)('★★ [%s] プロジェクトのフォルダそのもの（. と a/..）・プロジェクトの外・絶対パスは断る', async dest => {
    project()
    await expectRefused(['.'], dest, `${SELF}: .`, '.')
    await expectRefused(['docs/..'], dest, `${SELF}: docs/..`, 'docs/..')
    await expectRefused(['../outside.txt'], dest, '不正なパスです（プロジェクトの外は操作できません）', '../outside.txt')
    await expectRefused(['/etc/hosts'], dest, '不正なパスです（絶対パスは指定できません）', '/etc/hosts')
  })

  it.each(DESTS)('★★★ [%s] 1件でも断れば全体が ok:false（ふつうのファイルも動かない・履歴も移動先も作らない）', async dest => {
    project()
    const before = tree()
    const c = await check(['readme.txt', 'docs', '.env'], dest)
    expect(c).toEqual({ ok: false, message: `${PROTECTED}: .env` })
    const r = await run(['readme.txt', 'docs', '.env'], dest)
    expect(r).toMatchObject({ ok: false, moved: [], message: c.message })
    expect(tree()).toEqual(before)
    expect(fs.existsSync(path.join(ws, destDir(dest)))).toBe(false)
    expect(fs.existsSync(path.join(ws, '.sakuraide-backup', 'index'))).toBe(false)
  })
})

describe('★★★ project:moveCheck（作業場所を開いた形）: 子のプロジェクトの記録・フォルダ・中にプロジェクトがあるフォルダは断る', () => {
  it.each(DESTS)('★★★ [%s] 子の記録（大文字小文字違い・.sakura-cloud の中・入れ子の .sakuraide-backup）は record の文', async dest => {
    workspace()
    for (const rel of ['proj/.sakuraide.json', 'projB/.SAKURAIDE.JSON', 'proj/.sakura-cloud/state.json', 'proj/.sakura-cloud', 'sub/deep/.sakuraide-backup/1/a.json', 'sub/deep/.sakuraide-backup']) {
      await expectRefused([rel], dest, `${FS_MOVE_MESSAGES.record}: ${rel}`, rel)
    }
  })

  it.each(DESTS)('★★★ [%s] 子のプロジェクトのフォルダそのもの（proj・projB・proj/・./proj）は project の文', async dest => {
    workspace()
    for (const rel of ['proj', 'projB', 'proj/', './proj']) {
      await expectRefused([rel], dest, `${FS_MOVE_MESSAGES.project}: ${rel}`, rel)
    }
  })

  it.each(DESTS)('★★★ [%s] 中にプロジェクトがあるフォルダ（clients）は workspace の文', async dest => {
    workspace()
    await expectRefused(['clients'], dest, `${FS_MOVE_MESSAGES.workspace}: clients`, 'clients')
  })

  it.skipIf(rootIsMe).each(DESTS)('★★★ [%s] 調べられないフォルダ（権限なし）は unknown の文で断る。通さない', async dest => {
    workspace()
    fs.mkdirSync(path.join(ws, 'locked')); fs.writeFileSync(path.join(ws, 'locked', 'secret.txt'), 's')
    fs.chmodSync(path.join(ws, 'locked'), 0o000); lockedDirs.push(path.join(ws, 'locked'))
    await expectRefused(['locked'], dest, `${FS_MOVE_MESSAGES.unknown}: locked`, 'locked')
  })
})

describe('★★★ project:moveCheck（通す場合）: ok:true で、renamed の予告は実際の moveFiles の結果と一致する。聞くだけでは何も作らない', () => {
  it.each(DESTS)('★★ [%s] ふつうのファイル・フォルダ: renamed は空。聞いても何も作らず、そのあと移せる', async dest => {
    project()
    const before = tree()
    const c = await check(['readme.txt', 'docs', 'docs/../index.html'], dest)
    expect(c).toEqual({ ok: true, renamed: [] })
    expect(tree()).toEqual(before) // 移動先の置き場も 🕘 履歴も、聞いただけでは作られない
    const r = await run(['readme.txt', 'docs', 'docs/../index.html'], dest)
    expect(r).toMatchObject({ ok: true, moved: ['readme.txt', 'docs', 'docs/../index.html'], renamed: c.renamed })
    expect(fs.readFileSync(path.join(ws, destDir(dest), 'readme.txt'), 'utf-8')).toBe('ふつうのファイル')
    expect(fs.readFileSync(path.join(ws, destDir(dest), 'docs', 'a.txt'), 'utf-8')).toBe('docs の中')
    expect(fs.existsSync(path.join(ws, 'readme.txt'))).toBe(false)
  })

  it.each(DESTS)('★★★ [%s] 移動先に同名があるとき: 予告の改名が、実際の moveFiles の renamed と一致する', async dest => {
    project()
    put(`${destDir(dest)}/readme.txt`, '先にあるもの')
    const before = tree()
    const c = await check(['readme.txt'], dest)
    expect(c).toEqual({ ok: true, renamed: [{ from: 'readme.txt', to: 'readme-2.txt' }] })
    expect(tree()).toEqual(before)
    const r = await run(['readme.txt'], dest)
    expect(r.ok).toBe(true)
    expect(r.renamed).toEqual(c.renamed)
    expect(fs.readFileSync(path.join(ws, destDir(dest), 'readme.txt'), 'utf-8')).toBe('先にあるもの') // 既存は動かない
    expect(fs.readFileSync(path.join(ws, destDir(dest), 'readme-2.txt'), 'utf-8')).toBe('ふつうのファイル')
  })

  it.each(DESTS)('★★ [%s] 同じ一括の中で basename が重複するとき（images/photo.png と photos/photo.png）も一致する', async dest => {
    project()
    const c = await check(['images/photo.png', 'photos/photo.png'], dest)
    expect(c).toEqual({ ok: true, renamed: [{ from: 'photos/photo.png', to: 'photo-2.png' }] })
    const r = await run(['images/photo.png', 'photos/photo.png'], dest)
    expect(r.ok).toBe(true)
    expect(r.renamed).toEqual(c.renamed)
    expect(fs.readFileSync(path.join(ws, destDir(dest), 'photo.png'), 'utf-8')).toBe('PHOTO')
    expect(fs.readFileSync(path.join(ws, destDir(dest), 'photo-2.png'), 'utf-8')).toBe('OTHER')
  })

  it.each(DESTS)('★★★ [%s] 同じ指定が重複しても1件として数える（予告に別名を出さず、実行も1回だけ動かして成功する）', async dest => {
    project()
    const files = ['readme.txt', 'docs', 'readme.txt', 'docs', 'readme.txt']
    const plan = planMoveFiles(ws, files, dest)
    expect(plan).toMatchObject({ ok: true, renamed: [] })
    expect((plan as { targets: { rel: string }[] }).targets.map(t => t.rel)).toEqual(['readme.txt', 'docs'])
    const before = tree()
    const c = await check(files, dest)
    expect(c).toEqual({ ok: true, renamed: [] }) // readme-2.txt への改名を予告しない
    expect(tree()).toEqual(before)
    const r = await run(files, dest)
    expect(r).toMatchObject({ ok: true, moved: ['readme.txt', 'docs'], renamed: [] })
    expect(r.renamed).toEqual(c.renamed)
    expect(fs.readdirSync(path.join(ws, destDir(dest))).sort()).toEqual(['docs', 'readme.txt'])
    expect(fs.readFileSync(path.join(ws, destDir(dest), 'readme.txt'), 'utf-8')).toBe('ふつうのファイル')
    expect(fs.existsSync(path.join(ws, 'readme.txt'))).toBe(false)
    expect(fs.existsSync(path.join(ws, 'docs'))).toBe(false)
  })

  it('★ 0件は ok:true で renamed は空（moveFiles の 0件と同じ）', async () => {
    project()
    const before = tree()
    expect(await check([], 'materials')).toEqual({ ok: true, renamed: [] })
    expect(await check(['', 7, null], 'publish')).toEqual({ ok: true, renamed: [] })
    expect(await run([], 'materials')).toMatchObject({ ok: true, moved: [] })
    expect(tree()).toEqual(before)
  })
})

describe('★★★ project:moveCheck: 形違い・予期しない例外は断る側へ倒す（不明値を「できる」にしない）。実行も同じく断る', () => {
  it('★★★ projectDir が文字列でない・空・相対パスなら断る', async () => {
    project()
    const before = tree()
    for (const bad of [undefined, null, 123, {}, '', 'relative/dir']) {
      // 既定値の引数に落ちないよう、IPC 名から直接呼ぶ（undefined もそのまま渡る）
      const c = await call('project:moveCheck', bad, ['readme.txt'], 'materials')
      expect(c, String(bad)).toEqual({ ok: false, message: 'プロジェクトフォルダのパスが不正です' })
      expect(await call('project:moveFiles', bad, ['readme.txt'], 'materials'), String(bad)).toMatchObject({ ok: false, moved: [], message: 'プロジェクトフォルダのパスが不正です' })
    }
    expect(tree()).toEqual(before)
  })

  it('★★★ files が配列でない（文字列・null・undefined・オブジェクト）なら断る。「0件だから ok」にしない', async () => {
    project()
    const before = tree()
    for (const bad of ['readme.txt', null, undefined, { 0: 'readme.txt', length: 1 }, 7]) {
      const c = await check(bad, 'materials')
      expect(c, String(bad)).toEqual({ ok: false, message: 'ファイルの指定が不正です' })
      expect(await run(bad, 'materials'), String(bad)).toMatchObject({ ok: false, moved: [], snapshotOk: false, message: 'ファイルの指定が不正です' })
    }
    expect(tree()).toEqual(before)
  })

  it('★★★ dest が materials・publish 以外なら断る（既定の置き場へ倒さない）。実行も動かさない', async () => {
    project()
    const before = tree()
    for (const bad of ['elsewhere', 'PUBLISH', '', undefined, null, 1]) {
      const c = await check(['readme.txt'], bad)
      expect(c, String(bad)).toEqual({ ok: false, message: '移動先の指定が不正です' })
      expect(await run(['readme.txt'], bad), String(bad)).toMatchObject({ ok: false, moved: [], message: '移動先の指定が不正です' })
    }
    expect(tree()).toEqual(before)
  })

  it('★★★ 検証の途中で予期しない例外が出ても、投げずに ok:false で答える（IPC の外へ例外を出さない）', async () => {
    project()
    const before = tree()
    const hostile = () => new Proxy([] as string[], { get() { throw new Error('想定外の失敗') } })
    const c = await check(hostile(), 'materials')
    expect(c).toEqual({ ok: false, message: '想定外の失敗' })
    expect(await run(hostile(), 'materials')).toMatchObject({ ok: false, moved: [], snapshotOk: false })
    expect(moveCheckFs(ws, hostile(), 'publish')).toMatchObject({ ok: false })
    expect(tree()).toEqual(before)
  })
})

describe('★★★ 実行の砦: moveFiles は聞いたことを信じない。聞いたあとに状況が変わっても、自分で検証して断る', () => {
  it.each(DESTS)('★★★ [%s] moveCheck が ok:true だったあとで docs が子のプロジェクトになったら、moveFiles は断り、ディスクは動かない', async dest => {
    workspace()
    expect(await check(['plainfolder'], dest)).toEqual({ ok: true, renamed: [] })
    put('plainfolder/.sakuraide.json', '{"became":"project"}')
    const before = tree()
    const r = await run(['plainfolder'], dest)
    expect(r).toMatchObject({ ok: false, moved: [], snapshotOk: false, message: `${FS_MOVE_MESSAGES.project}: plainfolder` })
    expect(await check(['plainfolder'], dest)).toEqual({ ok: false, message: `${FS_MOVE_MESSAGES.project}: plainfolder` })
    expect(tree()).toEqual(before)
    expect(fs.existsSync(path.join(ws, destDir(dest)))).toBe(false)
  })

  it('★★★ moveFilesToFs の直呼び（moveCheck も IPC も通らない）でも、記録・.env・.git・子のプロジェクトは動かない', () => {
    workspace(); put('.env', 'KEY=1'); put('.git/config', '[core]')
    const before = tree()
    for (const rel of ['proj', 'clients', 'proj/.sakuraide.json', '.env', '.git/config', '.']) {
      for (const dest of DESTS) expect(moveFilesToFs(ws, [rel], dest), `${rel} ${dest}`).toMatchObject({ ok: false, moved: [], snapshotOk: false })
    }
    expect(tree()).toEqual(before)
  })

  it('★★ 答えは同じ関数が作る: moveCheckFs と moveFilesToFs の断りの文は、状態が変わらないかぎり同じ', () => {
    project(); workspace()
    for (const rel of ['.env', '.git', '.', '../x', 'proj', 'clients', 'projB/.SAKURAIDE.JSON']) {
      for (const dest of DESTS) {
        const c = moveCheckFs(ws, [rel], dest)
        const r = moveFilesToFs(ws, [rel], dest)
        expect(c.ok, `${rel} ${dest}`).toBe(false)
        expect(r.ok, `${rel} ${dest}`).toBe(false)
        expect((c as { message: string }).message, `${rel} ${dest}`).toBe(r.message)
      }
    }
  })
})

describe('★★ moveCheck が見るのは断りの規則だけ。書き込めるかは見ないので、ok:true のあとで移動が失敗することがある（動かさずに ok:false）', () => {
  it.skipIf(rootIsMe).each(DESTS)('★★ [%s] 移動元のフォルダに書き込めない: moveCheck は ok:true、moveFiles は ok:false で、ファイルは元の場所に残る', async dest => {
    project()
    put('ro/a.txt', 'もと')
    fs.chmodSync(path.join(ws, 'ro'), 0o555); lockedDirs.push(path.join(ws, 'ro'))
    const c = await check(['ro/a.txt'], dest)
    expect(c).toEqual({ ok: true, renamed: [] }) // 断りの規則には当たらない
    const r = await run(['ro/a.txt'], dest)
    expect(r).toMatchObject({ ok: false, moved: [] }) // 実行で失敗する（確認のあとにも起こりうる）
    expect(typeof r.message).toBe('string')
    expect(fs.readFileSync(path.join(ws, 'ro', 'a.txt'), 'utf-8')).toBe('もと')
    expect(fs.existsSync(path.join(ws, destDir(dest), 'a.txt'))).toBe(false)
  })
})

describe('3点セットと配線（呼び出しの形ごと固定する。直す前の形は not.toContain で禁じる）', () => {
  const ROOT = path.join(__dirname, '..')
  // コメントでの言及だけを拾って誤検知しないよう、コメント行を除く（unusedWiring.test.ts と同じ）。
  const stripped = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8').split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
  const bodyOf = (src: string, from: string, to: string) => {
    const a = src.indexOf(from); const b = src.indexOf(to, a + from.length)
    expect(a, from).toBeGreaterThan(-1); expect(b, to).toBeGreaterThan(a)
    return src.slice(a, b)
  }

  it('main: project:moveCheck を moveCheckFs に配線している（project:moveFiles の配線も残っている）', () => {
    const src = stripped('src/main/ipc/unused.ts')
    expect(src).toContain("ipcMain.handle('project:moveCheck', (_, projectDir: string, files: string[], dest: MoveDestKind) => moveCheckFs(projectDir, files, dest))")
    expect(src).toContain("ipcMain.handle('project:moveFiles', (_, projectDir: string, files: string[], dest: MoveDestKind) => moveFilesToFs(projectDir, files, dest))")
  })

  it('preload: fs.moveCheck が project:moveCheck を、moveFiles と同じ引数で呼ぶ（別の channel に繋いでいない）', () => {
    const src = stripped('src/main/preload.ts')
    expect(src).toContain("moveCheck: (projectDir: string, files: string[], dest: 'materials' | 'publish') =>\n      ipcRenderer.invoke('project:moveCheck', projectDir, files, dest),")
    expect(src.split("ipcRenderer.invoke('project:moveCheck'").length - 1).toBe(1)
  })

  it('global.d.ts: moveCheck の型は ok:true / ok:false の2択（ok:boolean にしていない）', () => {
    const src = stripped('src/renderer/global.d.ts')
    expect(src).toContain("moveCheck(projectDir: string, files: string[], dest: 'materials' | 'publish'): Promise<")
    expect(src).toContain('{ ok: true; renamed: { from: string; to: string }[] } | { ok: false; message: string }')
  })

  it('moveFilesToFs は最初に planMoveFiles を呼び、ok:true でなければ動かさない。検証をここへ書き直していない', () => {
    const body = bodyOf(stripped('src/main/ipc/unused.ts'), 'export function moveFilesToFs(', 'export function moveToMaterialsFs(')
    expect(body).toContain('const plan = planMoveFiles(projectDir, files, dest)')
    expect(body).toContain('if (plan.ok !== true) return { ok: false, moved: [], snapshotOk: false, message: plan.message }')
    // ディスクに触る前に呼ぶ（順序）
    expect(body.indexOf('const plan = planMoveFiles(')).toBeLessThan(body.indexOf('fs.mkdirSync('))
    expect(body.indexOf('const plan = planMoveFiles(')).toBeLessThan(body.indexOf('snapshotBeforeChange('))
    expect(body.indexOf('const plan = planMoveFiles(')).toBeLessThan(body.indexOf('fs.renameSync('))
    // 検証は planMoveFiles の1か所だけ（実行の側に自前の検証を持たない）
    expect(body).not.toContain('moveRefusalFor(')
    expect(body).not.toContain('isProtectedWritePath(')
    expect(body).not.toContain('confineToProject(projectDir, rel)')
    expect(body).not.toContain('(files ?? [])')
  })

  it('moveCheckFs は planMoveFiles の答えを ok === true のときだけ ok として返す（!== false で肯定に倒していない）', () => {
    const body = bodyOf(stripped('src/main/ipc/unused.ts'), 'export function moveCheckFs(', 'export function moveFilesToFs(')
    expect(body).toContain('const plan = planMoveFiles(projectDir, files, dest)')
    expect(body).toContain('return plan.ok === true ? { ok: true, renamed: plan.renamed } : { ok: false, message: plan.message }')
    expect(body).not.toContain('!== false')
    // 自分では何も動かさない・調べない（読むだけの口）
    expect(body).not.toContain('fs.')
  })

  it('planMoveFiles は形違いを断り、守り（保護パス・記録の判断）を移動元・移動先に当てる。予期しない例外は ok:false に倒す', () => {
    const body = bodyOf(stripped('src/main/ipc/unused.ts'), 'export function planMoveFiles(', 'export function moveCheckFs(')
    expect(body).toContain('if (!Array.isArray(files)) return')
    expect(body).toContain("if (dest !== 'materials' && dest !== 'publish') return")
    expect(body).toContain('if (isProtectedWritePath(relNorm)) throw')
    expect(body).toContain('if (isProtectedWritePath(destRel)) throw')
    expect(body).toContain('const refusal = moveRefusalFor(fromFull, rel)')
    expect(body).toContain("return { ok: false, message: failureText(e, { readOnly: true }) }")
    expect(body).not.toContain('return { ok: true, renamed: [], targets: [], destDirName }\n  }')
    // ディスクを動かす呼び出しを持たない（読むだけ）
    for (const w of ['fs.renameSync(', 'fs.mkdirSync(', 'fs.writeFileSync(', 'fs.rmdirSync(', 'fs.rmSync(', 'snapshotBeforeChange(']) expect(body, w).not.toContain(w)
  })
})
