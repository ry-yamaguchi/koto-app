// fileEntryOps.ts — ファイル一覧（Sidebar）の「削除」「新規ファイル」と、フォルダを消したあとのタブへの知らせ（react・electron に依存しない）。
// 0.6.24 E-4（U8）。Sidebar.tsx（巨大ファイル）から、触った節を切り出した。window.electronAPI を直接は触らず、呼び手が口（deps）を渡す。
//
// ── 守るもの ────────────────────────────────────────────────────────────────────────────
// ・ファイル一覧の削除は、**先に main へ聞く**（`fs.trashCheck`）。聞かずに確認を出さない・聞けなかったら（投げた・形が違う）移さない（不明は断る側）
//   - 'project'（プロジェクトの根）→ プロジェクトの削除の画面を開く。汎用の確認も `fs.trash` も出さない（公開の破棄・走っている操作の確認を通さずに移せてしまう）
//   - ほかの断り（記録・中にプロジェクトがある・調べられない・ホームの深さ）→ main の文をそのまま出すだけ。確認は出さない
//   - 'plain'（ok:true）だけ、今までの確認 → `fs.trash`
//   main の `fs:trash` も同じ判断で断る（最後の砦）。ここは「利用者に無駄な確認を出さず、正しい画面へ案内する」ための振り分け。
// ・新規ファイルは、同名のファイルが**既にあれば作らない**（`fs.writeFile(path, '')` は既存のファイルを空にする。`state.json` などを空にできてしまう）。
//   既にあるか確かめられなかったときも作らない。
// ・断りの文は、**英語の頭（`Error invoking remote method 'fs:rename': Error: `）を取って**文だけを出す（`cleanRemoteError`。R2-g）。
//   名前の変更・新規ファイル・削除の3か所すべてが、main の日本語の文を投げ直されて受ける（頭つきで出ると、利用者に英語の部分が見える）
// 振り分けは純関数 `fileEntryDeleteAction`。順序（聞く → 確認 → 移す）は tests/fileEntryOps.test.ts が、呼ばれた順の一覧で固定する。
import type { ConfirmOptions } from './useConfirm'
import { cleanRemoteError } from './remoteError'

/** `fs.trashCheck` の答え（main の `TrashCheckResult` と同じ形。renderer は main を import しないので、ここに写す）。 */
export type TrashCheckAnswer =
  | { ok: true }
  | { ok: false; kind: 'denied' | 'record' | 'project' | 'workspace' | 'unknown'; message: string }

/** ファイル一覧の行を削除しようとしたとき、画面が何をするか。 */
export type FileEntryDeleteAction =
  | { kind: 'confirm' }
  | { kind: 'projectDelete' }
  | { kind: 'refuse'; message: string }

/** main の答えが読めなかった回の文（読めない答えは「移してよい」と読まない）。 */
export const TRASH_CHECK_UNREADABLE_MESSAGE = '削除してよいか確かめられないため、削除していません。'
/** 新規ファイルの名前が既にあった回（作らない）。 */
export const NEW_FILE_EXISTS_MESSAGE = '同名のファイルが既にあります'

/** `fs.trashCheck` の答えから、画面の動きを決める（純関数）。**`ok` が `true` のときだけ確認へ進む**。形の違う答えは断る側。 */
export function fileEntryDeleteAction(answer: unknown): FileEntryDeleteAction {
  const a = answer as { ok?: unknown; kind?: unknown; message?: unknown } | null | undefined
  if (a?.ok === true) return { kind: 'confirm' }
  if (a?.ok === false && a.kind === 'project') return { kind: 'projectDelete' }
  if (a?.ok === false && typeof a.message === 'string' && a.message !== '') return { kind: 'refuse', message: a.message }
  return { kind: 'refuse', message: TRASH_CHECK_UNREADABLE_MESSAGE }
}

export type FileEntryDeleteDeps = {
  /** `window.electronAPI.fs.trashCheck`。 */
  trashCheck: (path: string) => Promise<unknown>
  /** `window.electronAPI.fs.trash`（ふつうのものだけがここへ来る）。 */
  trash: (path: string) => Promise<void>
  /** ConfirmModal（useConfirm の confirm）。 */
  confirm: (options: ConfirmOptions) => Promise<boolean>
  /** プロジェクトの削除の画面を開く（Sidebar の setConfirmProjDelete）。 */
  openProjectDelete: (dir: string) => void
  alert: (message: string) => void
  /** 移したあと、開いているタブを閉じさせる知らせ（`announceFileDeleted`）。 */
  announceDeleted: (path: string) => void
}

/**
 * ファイル一覧の行の「🗑 削除（ゴミ箱へ）」。順に: `trashCheck`（読むだけ）→ 振り分け → ふつうのものだけ 確認 → `trash` → タブへ知らせる。
 * 聞けなかったときは、確認も `trash` も出さない。
 */
export async function deleteFileEntry(entry: { name: string; path: string }, deps: FileEntryDeleteDeps): Promise<void> {
  let answer: unknown
  try {
    answer = await deps.trashCheck(entry.path)
  } catch (e: unknown) {
    deps.alert(`削除できませんでした: ${cleanRemoteError(e)}`)
    return
  }
  const action = fileEntryDeleteAction(answer)
  if (action.kind === 'projectDelete') { deps.openProjectDelete(entry.path); return }
  if (action.kind === 'refuse') { deps.alert(action.message); return }
  const ok = await deps.confirm({
    title: 'ファイルをゴミ箱へ移します',
    body: `「${entry.name}」をゴミ箱に移動します。よろしいですか？`,
    confirmLabel: 'ゴミ箱へ移す',
    danger: true,
  })
  if (!ok) return
  try {
    await deps.trash(entry.path)
    deps.announceDeleted(entry.path)
  } catch (e: unknown) { deps.alert(`削除できませんでした: ${cleanRemoteError(e)}`) }
}

/**
 * 新規ファイル（空）を作る。`<dir>/<name>` が既にあれば作らず、`NEW_FILE_EXISTS_MESSAGE` で投げる（呼び手の catch が画面に出す）。
 * 既にあるか確かめられなかった（`exists` が投げた・boolean で答えなかった）ときも作らない。作ったパスを返す。
 */
export async function createNewFile(
  dir: string, name: string, deps: { exists: (path: string) => Promise<boolean>; writeFile: (path: string, content: string) => Promise<void> },
): Promise<string> {
  const full = `${dir}/${name}`
  if ((await deps.exists(full)) !== false) throw new Error(NEW_FILE_EXISTS_MESSAGE)
  await deps.writeFile(full, '')
  return full
}

export type NameDialogDeps = {
  /** `window.electronAPI.fs.rename`（新しいパスを返す。断るときは日本語の文で投げる）。 */
  rename: (path: string, name: string) => Promise<string>
  exists: (path: string) => Promise<boolean>
  writeFile: (path: string, content: string) => Promise<void>
  /** 作ったファイルをエディタで開く。 */
  openFile: (path: string) => void
  /** 名前を変えたことの知らせ（開いているタブが古いパスを指したままにならないように）。 */
  announceRenamed: (from: string, to: string) => void
  alert: (message: string) => void
}

/**
 * 名前の入力ダイアログ（名前の変更・新規ファイル）の「決定」。成功したときだけ `true`（呼び手がダイアログを閉じる）。
 * 名前が不正なら、main へ聞かずに断る。main が断った・投げた回は、**英語の頭を取った文だけ**を出す（`cleanRemoteError`・R2-g）。ダイアログは開いたまま（`false`）。
 */
export async function submitFileNameDialog(
  dialog: { mode: 'new' | 'rename'; targetPath: string }, rawName: string, deps: NameDialogDeps,
): Promise<boolean> {
  const name = rawName.trim()
  if (!name || name.includes('/') || name.includes('..')) {
    deps.alert('不正なファイル名です')
    return false
  }
  try {
    if (dialog.mode === 'rename') {
      const newPath = await deps.rename(dialog.targetPath, name)
      deps.announceRenamed(dialog.targetPath, newPath)
    } else {
      // 同名のファイルが既にあれば作らない（writeFile は既存のファイルを空にする）
      deps.openFile(await createNewFile(dialog.targetPath, name, deps))
    }
    return true
  } catch (e: unknown) {
    deps.alert(cleanRemoteError(e))
    return false
  }
}

/** 「ファイル・フォルダを消した」ことの知らせ（App が開いているタブを閉じる。閉じないと、自動保存が消したファイルを書き戻す）。 */
export const FILE_DELETED_EVENT = 'sakura:file-deleted'
export function announceFileDeleted(path: string): void {
  window.dispatchEvent(new CustomEvent(FILE_DELETED_EVENT, { detail: path }))
}
