import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// ── 0.6.24 E-4（U8）: ファイル一覧の削除・新規ファイルの配線（Sidebar → fileEntryOps.ts）と、プロジェクトの削除の口 ─────────────────
// 振る舞い（振り分け・順序・同名）は tests/fileEntryOps.test.ts が偽の口で固定する。ここは、Sidebar・ダイアログが**その口へ正しく繋がっているか**をソースで見る。
// 当て先は呼び出しの形ごと一意に指す（定義と呼び出しが同じ文字列に当たらないように、`export async function` と `{`・`(entry` まで書く）。
//   1. ファイル一覧の削除は、deleteFileEntry の 1 か所。口は fs.trashCheck → fs.trash（Sidebar の deps の 1 行ずつ）。プロジェクトの根は削除の画面を開く
//   2. プロジェクトのフォルダを移す口 fs.trashProject は、ダイアログの deps の 1 か所だけ（confirmed: true つき）。fs.trash は Sidebar と AppRunPanel だけ
//   3. 新規ファイルは createNewFile を通る（writeFile を直に呼ばない）
//   4. 消したことの知らせ sakura:file-deleted は fileEntryOps.ts が定義し、Sidebar は announceFileDeleted だけを通す（afterProjectDeleted と deleteFileEntry の口）

const ROOT = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')
const code = (rel: string) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ''))
  .replace(/(^|\s)\/\/[^\n]*/g, (_m, lead: string) => lead)
/** 空白の並びを 1 つにまとめた本文（複数行の呼び出しを 1 本の文字列で指すため）。 */
const flat = (rel: string) => code(rel).replace(/\s+/g, ' ')
const count = (text: string, needle: string) => text.split(needle).length - 1
const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel)
  }
  return out.sort()
}
const SRC = walk('src')
const hits = (needle: string) => SRC.filter(f => code(f).includes(needle))

const SIDEBAR = 'src/renderer/components/Sidebar.tsx'
const DIALOG = 'src/renderer/components/ProjectDeleteDialog.tsx'
const OPS = 'src/renderer/fileEntryOps.ts'
const APP = 'src/renderer/App.tsx'
const APPRUN = 'src/renderer/components/AppRunPanel.tsx'

describe('ファイル一覧の削除は deleteFileEntry の 1 か所。先に fs.trashCheck で聞く', () => {
  it('見張りの前提: 対象のファイルが実在する', () => {
    for (const f of [SIDEBAR, DIALOG, OPS, APP, APPRUN]) expect(SRC, f).toContain(f)
  })

  it('★★★ Sidebar の deleteEntry は、deleteFileEntry に口（deps）を渡す 1 本だけ。聞く口は fs.trashCheck、移す口は fs.trash、プロジェクトの根は削除の画面（setConfirmProjDelete）', () => {
    const s = flat(SIDEBAR)
    expect(count(s, 'deleteFileEntry(')).toBe(1)
    expect(s).toContain(
      'const deleteEntry = (entry: FileEntry) => deleteFileEntry(entry, { '
      + 'trashCheck: p => window.electronAPI.fs.trashCheck(p), '
      + 'trash: p => window.electronAPI.fs.trash(p), '
      + 'confirm, '
      + 'openProjectDelete: dir => setConfirmProjDelete(dir), '
      + 'alert: m => window.alert(m), '
      + 'announceDeleted: announceFileDeleted, '
      + '})',
    )
    expect(s).toContain('onDelete={entry => deleteEntry(entry)}')
    expect(count(s, 'const deleteEntry =')).toBe(1)
  })

  it('★★★ 直に `fs.trash(entry.path)` を呼ぶ旧い形・汎用の確認だけで移す形は、Sidebar にも fileEntryOps.ts にも無い。fileEntryOps.ts は electron にも window.confirm にも触れない', () => {
    expect(code(SIDEBAR)).not.toContain('fs.trash(entry.path)')
    const ops = code(OPS)
    for (const w of ['electronAPI', 'window.confirm(', 'window.alert(', 'fs.trash(', "from 'react'", 'ipcRenderer']) expect(ops, w).not.toContain(w)
    expect(count(ops, 'export async function deleteFileEntry(')).toBe(1)
    // 順序は deleteFileEntry の中で: 聞く → 確認 → 移す（振る舞いは tests/fileEntryOps.test.ts が呼ばれた順の一覧で固定する）
    const body = ops.slice(ops.indexOf('export async function deleteFileEntry('), ops.indexOf('export async function createNewFile('))
    expect(body.indexOf('deps.trashCheck(')).toBeGreaterThan(0)
    expect(body.indexOf('deps.trashCheck(')).toBeLessThan(body.indexOf('deps.confirm('))
    expect(body.indexOf('deps.confirm(')).toBeLessThan(body.indexOf('deps.trash('))
  })

  it('★★★ 呼び口の一覧: fs.trashCheck( は Sidebar だけ、fs.trash( は Sidebar と AppRunPanel（使われていないファイルの削除）だけ、fs.trashProject( はダイアログだけ', () => {
    expect(hits('fs.trashCheck(')).toEqual([SIDEBAR])
    expect(hits('fs.trash(')).toEqual([SIDEBAR, APPRUN].sort())
    expect(hits('fs.trashProject(')).toEqual([DIALOG])
    expect(count(code(SIDEBAR), 'fs.trash(')).toBe(1)
    expect(count(code(SIDEBAR), 'fs.trashCheck(')).toBe(1)
  })

  it('★★ Sidebar の window.alert( は、ファイル操作の 5 か所だけ（移動 3・削除の口 1・新規ファイル／名前の変更の口 1）', () => {
    expect(count(code(SIDEBAR), 'window.alert(')).toBe(5)
  })
})

describe('プロジェクトのフォルダを移す口 fs.trashProject は、ダイアログの deps の 1 か所だけ（確認の印つき）', () => {
  it('★★★ ダイアログの trash は fs.trashProject(p, { confirmed: true, skippedForTwins })（R2-e）。ok が true でなければ投げる（覆う複製が見つからなくなった断りは TwinsGoneError）。汎用の fs.trash( は無い', () => {
    const d = flat(DIALOG)
    expect(count(d, 'fs.trashProject(')).toBe(1)
    expect(d).toContain("trash: async (p, skippedForTwins) => { const r = await window.electronAPI.fs.trashProject(p, { confirmed: true, skippedForTwins }) if (r?.ok === true) return if (r?.reason === 'twins-gone') throw new TwinsGoneError(r.message) throw new Error(r?.message ?? ")
    expect(d).not.toContain('fs.trash(')
    expect(d).toContain('exists: p => window.electronAPI.fs.exists(p), trash: async (p, skippedForTwins) => {')
  })
})

describe('新規ファイル・名前の変更は submitFileNameDialog を通る（同名があれば作らない・断りは英語の頭を取って出す）', () => {
  it('★★★ Sidebar の submitNameDialog は submitFileNameDialog(nameDialog, nameInput, { rename, exists, writeFile, openFile, announceRenamed, alert }) の 1 本だけ。writeFile を直に呼ばない', () => {
    const s = flat(SIDEBAR)
    expect(count(s, 'submitFileNameDialog(')).toBe(1)
    expect(s).toContain(
      'const ok = await submitFileNameDialog(nameDialog, nameInput, { '
      + 'rename: (p, n) => window.electronAPI.fs.rename(p, n), '
      + 'exists: p => window.electronAPI.fs.exists(p), '
      + 'writeFile: (p, c) => window.electronAPI.fs.writeFile(p, c), '
      + 'openFile: onOpenFile, '
      + "announceRenamed: (from, to) => { window.dispatchEvent(new CustomEvent('sakura:file-renamed', { detail: { from, to } })) }, "
      + 'alert: m => window.alert(m), '
      + '}) if (ok) setNameDialog(null)',
    )
    expect(count(s, 'createNewFile(')).toBe(0) // 作るのは fileEntryOps.ts の中（下）
    expect(count(s, 'fs.writeFile(')).toBe(1)
    expect(s).not.toContain("fs.writeFile(full, '')")
    // 旧い形（断りを `e?.message` のまま出す catch）は無い。英語の頭を取るのは fileEntryOps.ts の cleanRemoteError（振る舞いは tests/fileEntryOps.test.ts）
    expect(s).not.toContain('window.alert(e?.message ?? String(e))')
  })

  it('★★★ fileEntryOps.ts の断りは、3か所（削除の聞く・削除の移す・名前の決定）すべて cleanRemoteError(e) を通す。`e?.message` のまま出す形は無い', () => {
    const ops = code(OPS)
    expect(ops).toContain("import { cleanRemoteError } from './remoteError'")
    expect(count(ops, 'cleanRemoteError(e)')).toBe(3)
    expect(ops).toContain('deps.alert(`削除できませんでした: ${cleanRemoteError(e)}`)')
    expect(ops).toContain('catch (e: unknown) { deps.alert(`削除できませんでした: ${cleanRemoteError(e)}`) }')
    expect(flat(OPS)).toContain('} catch (e: unknown) { deps.alert(cleanRemoteError(e)) return false }')
    expect(ops).not.toContain('e?.message')
  })

  it('★★ createNewFile は、確かめる（exists）→ 作る（writeFile）の順。同名なら writeFile の前に投げる', () => {
    const body = code(OPS).slice(code(OPS).indexOf('export async function createNewFile('), code(OPS).indexOf('export type NameDialogDeps'))
    expect(body.indexOf('deps.exists(')).toBeGreaterThan(0)
    expect(body.indexOf('deps.exists(')).toBeLessThan(body.indexOf('deps.writeFile('))
    expect(body.indexOf('throw new Error(NEW_FILE_EXISTS_MESSAGE)')).toBeLessThan(body.indexOf('deps.writeFile('))
  })

  it('★★ submitFileNameDialog の中で作るのは createNewFile（writeFile を直に呼ばない）', () => {
    const ops = code(OPS)
    const body = ops.slice(ops.indexOf('export async function submitFileNameDialog('), ops.indexOf('export const FILE_DELETED_EVENT'))
    expect(body).toContain('createNewFile(dialog.targetPath, name, deps)')
    expect(body).not.toContain('deps.writeFile(')
  })
})

describe('消したことの知らせ（sakura:file-deleted）: 定義は fileEntryOps.ts の 1 か所。親フォルダを開いて消したプロジェクトのタブも閉じる', () => {
  it('★★★ 文字列 `sakura:file-deleted` を持つのは fileEntryOps.ts（定義）と App.tsx（聞く側）だけ。Sidebar は直に dispatch しない', () => {
    expect(hits("'sakura:file-deleted'")).toEqual([APP, OPS].sort())
    expect(code(SIDEBAR)).not.toContain('sakura:file-deleted') // （Sidebar の dispatchEvent は sakura:file-renamed の分。消した知らせは announceFileDeleted だけ）
    expect(code(OPS)).toContain("export const FILE_DELETED_EVENT = 'sakura:file-deleted'")
    expect(code(APP)).toContain("window.addEventListener('sakura:file-deleted', onDeleted)")
  })

  it('★★★ afterProjectDeleted は announceFileDeleted(path) を呼ぶ（Sidebar で呼ぶのはここの 1 か所）。一覧から外す・未オープンへ戻すより前', () => {
    const s = code(SIDEBAR)
    expect(count(s, 'announceFileDeleted(')).toBe(1)
    const from = s.indexOf('const afterProjectDeleted = async (path: string) => {')
    expect(from).toBeGreaterThan(0)
    const to = s.indexOf('await loadWorkspaceProjects()', from)
    const body = s.slice(from, to)
    expect(body).toContain('announceFileDeleted(path)')
    expect(body.indexOf('announceFileDeleted(path)')).toBeLessThan(body.indexOf('setWorkspaceProjects('))
    expect(body.indexOf('announceFileDeleted(path)')).toBeLessThan(body.indexOf('onSetDir(null)'))
  })
})

describe('大きさ', () => {
  it('★ 切り出したモジュールとこの試験は、各 400 行以下', () => {
    for (const rel of [OPS, 'tests/fileEntryOps.test.ts', 'tests/fileEntryOpsWiring.test.ts']) {
      expect(read(rel).split('\n').length, rel).toBeLessThanOrEqual(400)
    }
  })
})
