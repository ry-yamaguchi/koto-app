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
// ・断りは window.alert ではなく notify（窓の上の通知。題＋本文）で出す。
// ・断りの文は、**英語の頭（`Error invoking remote method 'fs:rename': Error: `）を取って**文だけを出す（`failureText`。R2-g）。
//   名前の変更・新規ファイル・削除の3か所すべてが、main の日本語の文を投げ直されて受ける（頭つきで出ると、利用者に英語の部分が見える）。
//   権限・空き・見つからないなどの手元のファイルの失敗は、日本語の文＋詳細（原文）にする。日本語の断りの文はそのまま出る
// ・ファイルの移動（公開するもの／素材置き場）も同じ形（0.6.26）: **先に main へ聞く**（`project:moveCheck`）→ 断りなら notify だけ（確認も moveFiles も出さない）
//   → 確認 → `moveFiles`。答えは `ok === true` だけ確認へ進む（形違い・投げた回は断る）。同名があって別の名前で移す分（`renamed`）は、確認の本文で先に言う。
//   実行時に名前が変わった回（聞いたあとで同名ができた）だけ、あとから帯で知らせる。
// 振り分けは純関数 `fileEntryDeleteAction`・`fileEntryMoveAction`。順序（聞く → 確認 → 移す）は tests/fileEntryOps.test.ts が、呼ばれた順の一覧で固定する。
import type { ConfirmOptions, NotifyOptions } from './useConfirm'
import { failureText } from '../shared/failureText'
import { MATERIALS_DIR } from '../shared/publishExclude'
import { PUBLISH_DIR, PUBLISH_DIR_LABEL } from '../shared/publishRoot'

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

/** 削除の断り・失敗の通知の題。 */
export const DELETE_FAILED_TITLE = '削除できませんでした'
/** 名前の変更・新規ファイルの断りの通知の題。 */
export function nameFailedTitle(mode: 'new' | 'rename'): string {
  return mode === 'rename' ? '名前を変えられませんでした' : 'ファイルを作れませんでした'
}

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
  /** 断り・失敗の通知（useConfirm の notify）。 */
  notify: (options: NotifyOptions) => void
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
    deps.notify({ title: DELETE_FAILED_TITLE, body: failureText(e, { readOnly: true }) })
    return
  }
  const action = fileEntryDeleteAction(answer)
  if (action.kind === 'projectDelete') { deps.openProjectDelete(entry.path); return }
  if (action.kind === 'refuse') { deps.notify({ title: DELETE_FAILED_TITLE, body: action.message }); return }
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
  } catch (e: unknown) { deps.notify({ title: DELETE_FAILED_TITLE, body: failureText(e, { checkAt: 'ファイル一覧' }) }) }
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
  notify: (options: NotifyOptions) => void
}

/**
 * 名前の入力ダイアログ（名前の変更・新規ファイル）の「決定」。成功したときだけ `true`（呼び手がダイアログを閉じる）。
 * 名前が不正なら、main へ聞かずに断る。main が断った・投げた回は、**英語の頭を取った文だけ**を出す（`failureText`・R2-g）。ダイアログは開いたまま（`false`）。
 */
export async function submitFileNameDialog(
  dialog: { mode: 'new' | 'rename'; targetPath: string }, rawName: string, deps: NameDialogDeps,
): Promise<boolean> {
  const name = rawName.trim()
  if (!name || name.includes('/') || name.includes('..')) {
    deps.notify({ title: nameFailedTitle(dialog.mode), body: '不正なファイル名です' })
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
    deps.notify({ title: nameFailedTitle(dialog.mode), body: failureText(e, { checkAt: 'ファイル一覧' }) })
    return false
  }
}

/** `project:moveCheck` の答え（main の `MoveCheckResult` と同じ形）。 */
export type MoveCheckAnswer =
  | { ok: true; renamed: { from: string; to: string }[] }
  | { ok: false; message: string }

/** ファイルを移そうとしたとき、画面が何をするか。`renamedTo` は、同名があって別の名前で移す予告（無ければ未定義）。 */
export type FileEntryMoveAction =
  | { kind: 'confirm'; renamedTo?: string }
  | { kind: 'refuse'; message: string }

/** 移動の断り・失敗の通知の題。 */
export const MOVE_FAILED_TITLE = '移動できませんでした'
/** main の答えが読めなかった回の文（読めない答えは「移してよい」と読まない）。 */
export const MOVE_CHECK_UNREADABLE_MESSAGE = '移動してよいか確かめられないため、移動していません。'
/** 移動の失敗に main の文が付いてこなかった回の文。 */
export const MOVE_FAILED_FALLBACK_MESSAGE = '原因不明'

/** ファイル移動の確認文（W-23）。`willCreatePublishDir`（この移動で初めて `public/` ができる）ときと、同名で別の名前になる（`renamedTo`）ときだけ、先にその旨を言う。 */
export function moveConfirmBody(entryName: string, destLabel: string, willCreatePublishDir: boolean, renamedTo?: string): string {
  const warn = willCreatePublishDir
    ? `「${destLabel}」フォルダができるため、いま「公開されるもの」に並んでいるほかのファイルは公開されなくなります。`
    : ''
  const renamed = renamedTo ? `移動先に同じ名前があるため、「${renamedTo}」にします。` : ''
  return `「${entryName}」を「${destLabel}」へ移動します。${warn}${renamed}よろしいですか？\n\n🕘 元に戻すで戻せます。`
}

/** `project:moveCheck` の答えから、画面の動きを決める（純関数）。**`ok` が `true` のときだけ確認へ進む**。形の違う答えは断る側。 */
export function fileEntryMoveAction(answer: unknown, rel: string): FileEntryMoveAction {
  const a = answer as { ok?: unknown; renamed?: unknown; message?: unknown } | null | undefined
  if (a?.ok === true) {
    const hit = Array.isArray(a.renamed)
      ? (a.renamed as { from?: unknown; to?: unknown }[]).find(x => x?.from === rel && typeof x.to === 'string' && x.to !== '')
      : undefined
    return { kind: 'confirm', renamedTo: hit?.to as string | undefined }
  }
  if (a?.ok === false && typeof a.message === 'string' && a.message !== '') return { kind: 'refuse', message: a.message }
  return { kind: 'refuse', message: MOVE_CHECK_UNREADABLE_MESSAGE }
}

export type FileEntryMoveDeps = {
  /** 開いているプロジェクトのフォルダ（無ければ何もしない）。 */
  projectDir: string | null
  /** プロジェクト直下に `public/` が既にあるか（無いと、この移動で初めてできる）。 */
  hasPublishDir: boolean
  /** `window.electronAPI.fs.moveCheck`。 */
  moveCheck: (projectDir: string, files: string[], dest: 'materials' | 'publish') => Promise<unknown>
  /** `window.electronAPI.fs.moveFiles`。 */
  moveFiles: (projectDir: string, files: string[], dest: 'materials' | 'publish') => Promise<unknown>
  confirm: (options: ConfirmOptions) => Promise<boolean>
  /** 断り・失敗の通知。 */
  notify: (options: NotifyOptions) => void
  /** 移したあと、ファイルツリーを今すぐ読み直させる。 */
  refreshTree: () => void
  /** 移したあと、開いているタブが古いパスを指したままにならないように知らせる。 */
  announceRenamed: (from: string, to: string) => void
  /** 実行時に名前が変わった回の保険（既存の帯に出す）。 */
  showHint: (text: string) => void
}

/**
 * ファイル一覧の行の「公開する／しない側へ移動」。順に: `moveCheck`（何も変えない）→ 振り分け → 確認 → `moveFiles` → 画面とタブへ知らせる。
 * `published` は右クリックを開いた瞬間の向き（公開される側にいれば素材置き場へ、それ以外は公開されるものへ・W-23）。
 * 断りでは、確認も `moveFiles` も出さない。ディレクトリ・プロジェクト外のパスは、ここでも防御的に弾く（多層防御）。
 */
export async function moveFileEntry(
  entry: { name: string; path: string; isDir: boolean }, published: boolean, deps: FileEntryMoveDeps,
): Promise<void> {
  const dir = deps.projectDir
  if (!dir || entry.isDir) return
  const prefix = dir.endsWith('/') ? dir : `${dir}/`
  if (!entry.path.startsWith(prefix)) return // 想定外（プロジェクト外のパス）は何もしない
  const rel = entry.path.slice(prefix.length)
  const dest: 'materials' | 'publish' = published ? 'materials' : 'publish'
  const destDirName = dest === 'publish' ? PUBLISH_DIR : MATERIALS_DIR
  const destLabel = dest === 'publish' ? PUBLISH_DIR_LABEL : MATERIALS_DIR
  let answer: unknown
  try {
    answer = await deps.moveCheck(dir, [rel], dest)
  } catch (e: unknown) {
    deps.notify({ title: MOVE_FAILED_TITLE, body: failureText(e, { readOnly: true }) })
    return
  }
  const action = fileEntryMoveAction(answer, rel)
  if (action.kind === 'refuse') { deps.notify({ title: MOVE_FAILED_TITLE, body: action.message }); return }
  // public/ がまだ無いプロジェクトで初めて「公開するものへ移動」すると、public/ ができて
  // ほかの直下ファイルが一斉に「公開されないもの」へ移る（isPublishedTop の仕様）。その影響を移動前に伝える。
  const willCreatePublishDir = dest === 'publish' && !deps.hasPublishDir
  const ok = await deps.confirm({
    title: 'ファイルを移動します',
    body: moveConfirmBody(entry.name, destLabel, willCreatePublishDir, action.renamedTo),
    confirmLabel: '移動する',
  })
  if (!ok) return
  try {
    const r = await deps.moveFiles(dir, [rel], dest) as { ok?: unknown; renamed?: { from?: unknown; to?: unknown }[]; message?: unknown } | null | undefined
    if (r?.ok !== true) {
      deps.notify({ title: MOVE_FAILED_TITLE, body: typeof r?.message === 'string' && r.message !== '' ? r.message : MOVE_FAILED_FALLBACK_MESSAGE })
      return
    }
    deps.refreshTree() // fs.watchDir の自動反映を待たず、その場で反映する
    const renamedTo = Array.isArray(r.renamed) ? r.renamed.find(x => x?.from === rel && typeof x.to === 'string')?.to as string | undefined : undefined
    // 開いているタブが古いパスを指したままだと、次のオートセーブで消したはずのファイルを復活させてしまう（削除・名前変更と同じ理由）。
    deps.announceRenamed(entry.path, `${dir}/${destDirName}/${renamedTo ?? entry.name}`)
    // 聞いたときに予告しなかった名前変更（聞いたあとで同名ができた）だけ、あとから知らせる。
    if (renamedTo && renamedTo !== action.renamedTo) deps.showHint(`「${entry.name}」と同じ名前が移動先にあったため、「${renamedTo}」にしました。`)
  } catch (e: unknown) {
    deps.notify({ title: MOVE_FAILED_TITLE, body: failureText(e, { checkAt: 'ファイル一覧' }) })
  }
}

/** 「ファイル・フォルダを消した」ことの知らせ（App が開いているタブを閉じる。閉じないと、自動保存が消したファイルを書き戻す）。 */
export const FILE_DELETED_EVENT = 'sakura:file-deleted'
export function announceFileDeleted(path: string): void {
  window.dispatchEvent(new CustomEvent(FILE_DELETED_EVENT, { detail: path }))
}
