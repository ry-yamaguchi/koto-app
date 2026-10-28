// fsTrash.ts — ファイル一覧の「ゴミ箱へ移す」「名前を変える」と、プロジェクトのフォルダの「ゴミ箱へ移す」（electron に依存しない）。
// 0.6.24 E-2。fs.ts の IPC（fs:trash・fs:rename・fs:trashCheck・fs:trashProject）は、ここを呼ぶだけ（ゴミ箱へ送る口 `trashItem` と home は呼び手が渡す）。
//
// ── 守るもの ────────────────────────────────────────────────────────────────────────────
// ・Koto の記録（`.sakura-cloud`・`.sakuraide.json` など）は、ここからは移さない・名前を変えない。公開の記録が無くなると、公開したものを Koto から破棄できず月額が続く
// ・プロジェクトのフォルダは、プロジェクトの 🗑（破棄 → 確認 → 移す）を通さずに移さない。通った回だけ `trashProjectFs` が移す
// ・中にプロジェクトがあるフォルダも、まとめては移さない。調べられなかった回は断る（ふつうのものと読まない）
// 判断は shared/trashGuard.ts の `fileOpVerdict`（純関数）。判断のためにフォルダを読むのは、下の `fsProbe` だけ（ENOENT 以外の失敗は 'unknown'）。
// **どの道も、判断が先・`trashItem`・`renameSync` は最後**（断った回は、ディスクを1つも動かさない）。
import * as fs from 'fs'
import * as path from 'path'
import { canTrash, fileOpVerdict, isRecordName, type FileOpProbe, type FileOpVerdict } from '../../shared/trashGuard'
import { dedicatedTeardownHasWork } from '../../shared/teardownSupport'
import { isConfirmed, NOT_CONFIRMED_MESSAGE } from '../cloud/teardownShell'
import { recordCoverFs, TWIN_TARGETS } from '../cloud/recordTwins'
import type { PublishTargetKind } from '../../shared/publishMeta'
import { isSameDirFs, readRecord } from '../cloud/bucketUsers'
import { CLOUD_DIR, CLOUD_STATE_FILE } from '../cloud/specStore'
import { readApprunDedicatedFs, readMetaFs } from '../publishMetaFs'
import { runningOpEntryAt } from '../projectLock'

/** 断りの文（仕様 E-5）。画面にそのまま出る。 */
export const FS_TRASH_MESSAGES = {
  record: 'Koto の記録のファイルなので、ここからは削除できません。',
  project: 'プロジェクトのフォルダは、プロジェクトの 🗑 から削除してください。',
  workspace: '中にプロジェクトがあるフォルダは、まとめて削除できません。プロジェクトごとに削除してください。',
  unknown: 'フォルダの中を確かめられないため、削除していません。',
  renameRecord: 'Koto の記録のファイルなので、名前を変えられません。',
  renameProject: 'プロジェクトのフォルダの名前は変えられません。',
  renameWorkspace: '中にプロジェクトがあるフォルダは、名前を変えられません。',
  renameUnknown: 'フォルダの中を確かめられないため、名前を変えていません。',
  running: 'このプロジェクトで処理が進んでいます。終わってから、もう一度削除してください。',
  dedicated: 'さくらのAppRun 専有型のリソースが残っているため、フォルダを移していません。',
  metaUnreadable: '公開の記録（.sakuraide.json）を読めないため、移していません。記録を直してから、もう一度削除してください。',
  /** `.sakura-cloud/state.json` が ENOENT 以外で読めない・壊れている（R3-d。`metaUnreadable` の双子）。 */
  stateUnreadable: '公開の記録（.sakura-cloud/state.json）を読めないため、移していません。記録を直してから、もう一度削除してください。',
  /** 破棄を外した公開先（`skippedForTwins`）の、覆う複製が見つからなくなった（R2-e）。画面は材料を読み直して plan を作り直す（`reason: 'twins-gone'`）。 */
  twinsGone: '同じ公開の記録を持つフォルダが見つからなくなったため、移していません。もう一度「ゴミ箱に移動」を押すと、破棄から始めます。',
  /** 覆う複製を確かめられなかった（読み直しが `'unknown'`。親フォルダの一覧・自分の記録を読めない）。「見つからなくなった」とは言わず、「破棄から始めます」も言わない（R3-e）。`reason` は `twinsGone` と同じ。 */
  twinsUnknown: '同じ公開の記録を持つフォルダを確かめられないため、移していません。',
  /** `skippedForTwins` が配列でない・知らない公開先の名前を含む（画面は必ず正しい形で渡すので、通常は出ない）。 */
  skippedInvalid: '削除の指定が正しくないため、移していません。',
  noPlace: '場所が指定されていません',
} as const

/** `fs:trashCheck` の答え。`kind` は断った理由（`'denied'` はホームの深さの守り〔canTrash〕）。画面はこれで振り分ける（U8）。 */
export type TrashCheckResult = { ok: true } | { ok: false; kind: 'denied' | Exclude<FileOpVerdict, 'plain'>; message: string }
/** `reason: 'twins-gone'` は、覆う複製が見つからなくなった断り、または確かめられなかった断り（R2-e・R3-e。文は言い分ける）。画面はこれで材料を読み直す。 */
export type TrashProjectResult = { ok: true } | { ok: false; message: string; reason?: 'twins-gone' }
type TrashDeps = { home: string; trashItem: (absPath: string) => Promise<void> }

const enoent = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code === 'ENOENT'

/** 実フォルダで `target` を調べる口（`fileOpVerdict` の probe）。**投げない**。ENOENT は「無い」、それ以外の失敗は 'unknown'。ここが fs を読む唯一の場所。 */
export function fsProbe(target: string): FileOpProbe {
  /**
   * `dir` の直下に `.sakuraide.json`（ファイル）か `.sakura-cloud`（フォルダ）があるか。**名前は大文字小文字によらず比べる**（記録の名前の判定 `isRecordName` と同じ）。
   * 名前を決め打ちで stat すると、大文字小文字を区別するディスク（Linux の CI・区別する形式の APFS）で `.SAKURAIDE.JSON` を見落とす（0.6.24-rc.1 の CI で実際に落ちた）。
   */
  const marker = (dir: string): boolean | 'unknown' => {
    let names: string[]
    try { names = fs.readdirSync(dir) } catch (e) { return enoent(e) ? false : 'unknown' }
    for (const [lower, isWanted] of [
      ['.sakuraide.json', (s: fs.Stats) => s.isFile()],
      ['.sakura-cloud', (s: fs.Stats) => s.isDirectory()],
    ] as const) {
      for (const name of names.filter(n => n.toLowerCase() === lower)) {
        try {
          if (isWanted(fs.statSync(path.join(dir, name)))) return true
        } catch (e) {
          if (!enoent(e)) return 'unknown'
        }
      }
    }
    return false
  }
  return {
    kindOfSelf: () => {
      try { return fs.lstatSync(target).isDirectory() ? 'dir' : 'other' } catch (e) { return enoent(e) ? 'missing' : 'unknown' }
    },
    hasProjectMarker: child => marker(child === undefined ? target : path.join(target, child)),
    childDirs: () => {
      try { return fs.readdirSync(target, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) } catch { return 'unknown' }
    },
  }
}

/** `abs`（絶対パス）が何か。 */
export function verdictOf(abs: string): FileOpVerdict {
  return fileOpVerdict({ segments: abs.split(path.sep).filter(Boolean), probe: fsProbe(abs) })
}

/**
 * 移動（`project:moveFiles`・`project:moveToMaterials`）の断りの文の頭（R2-a）。`: {相対パス}` は `moveRefusalFor` が足す。
 * 記録の文は、プロジェクト直下の保護パス（`isProtectedWritePath`）の断りと同じ文。
 */
export const FS_MOVE_MESSAGES = {
  record: 'Koto が管理する領域は移動できません',
  project: 'プロジェクトのフォルダは移動できません',
  workspace: '中にプロジェクトがあるフォルダは移動できません',
  unknown: 'フォルダの中を確かめられないため、移動していません',
} as const

/**
 * 移す元 `abs` を、`fs:trash` と同じ判断（`verdictOf`）にかける。**`'plain'` 以外は断りの文を返す**（調べられなかった回も断る）。
 * 開いたフォルダが作業場所などの親フォルダのとき、直下の保護パス（`isProtectedWritePath`）だけでは、子のプロジェクトの記録やフォルダそのものを守れない。
 */
export function moveRefusalFor(abs: string, rel: string): string | null {
  const v = verdictOf(abs)
  return v === 'plain' ? null : `${FS_MOVE_MESSAGES[v]}: ${rel}`
}

/** 絶対パスの文字列だけを通す（空・相対は、cwd へ読み替えない）。 */
const absOf = (p: unknown): string | null => (typeof p === 'string' && p !== '' && path.isAbsolute(p) ? path.resolve(p) : null)

/** ゴミ箱の共通の守り: ホームの深さ（canTrash）→ 何か（fileOpVerdict）。`'plain'` と、`allow` に挙げた判定だけ通す。 */
function checkTrash(p: unknown, home: string, allow: readonly FileOpVerdict[]): { ok: true; abs: string } | Extract<TrashCheckResult, { ok: false }> {
  const abs = absOf(p)
  if (!abs) return { ok: false, kind: 'denied', message: FS_TRASH_MESSAGES.noPlace }
  const depth = canTrash(home, abs, path.sep)
  if (!depth.ok) return { ok: false, kind: 'denied', message: depth.reason }
  const v = verdictOf(abs)
  if (v === 'plain' || allow.includes(v)) return { ok: true, abs }
  return { ok: false, kind: v, message: FS_TRASH_MESSAGES[v] }
}

/** `fs:trashCheck`: ファイル一覧の削除を始める前に、移してよいか聞く（読むだけ・何も動かさない）。`fs:trash` と同じ判断。 */
export function trashCheckFs(p: unknown, deps: { home: string }): TrashCheckResult {
  const r = checkTrash(p, deps.home, [])
  return r.ok ? { ok: true } : r
}

/** `fs:trash`（ファイル一覧の削除）: ふつうのファイル・フォルダだけ移す。断るときは理由の文で投げる（呼び手との約束は今のまま）。 */
export async function trashFs(p: unknown, deps: TrashDeps): Promise<void> {
  const r = checkTrash(p, deps.home, [])
  if (!r.ok) throw new Error(r.message)
  await deps.trashItem(r.abs)
}

/** `fs:rename`（同じフォルダの中での名前の変更）: 記録・プロジェクトのフォルダ・中にプロジェクトがあるフォルダ・調べられないものは変えない。新しい名前が記録の名前でも断る。 */
export function renameFs(oldPath: unknown, newName: unknown): string {
  if (typeof newName !== 'string' || !newName || newName.includes('/') || newName.includes('..')) throw new Error('不正なファイル名です')
  const abs = absOf(oldPath)
  if (!abs) throw new Error(FS_TRASH_MESSAGES.noPlace)
  if (isRecordName(newName)) throw new Error(FS_TRASH_MESSAGES.renameRecord)
  const v = verdictOf(abs)
  if (v === 'record') throw new Error(FS_TRASH_MESSAGES.renameRecord)
  if (v === 'project') throw new Error(FS_TRASH_MESSAGES.renameProject)
  if (v === 'workspace') throw new Error(FS_TRASH_MESSAGES.renameWorkspace)
  if (v === 'unknown') throw new Error(FS_TRASH_MESSAGES.renameUnknown)
  const newPath = path.join(path.dirname(abs), newName)
  if (fs.existsSync(newPath)) throw new Error('同名のファイルが既に存在します')
  fs.renameSync(abs, newPath)
  return newPath
}

/**
 * `skippedForTwins`（画面の plan が、覆う複製があるために破棄を外した公開先）を読む。**配列で、どの要素も複製を数える公開先（`TWIN_TARGETS`）のときだけ**返す。
 * 配列でない・知らない名前を含む・値が無いときは null（呼び手は断る。**必須**なので、渡し忘れた呼び出しも通さない）。
 */
function skippedForTwinsOf(opts: unknown): PublishTargetKind[] | null {
  const v = (opts as { skippedForTwins?: unknown } | null)?.skippedForTwins
  if (!Array.isArray(v)) return null
  const known = TWIN_TARGETS as readonly string[]
  return v.every(t => typeof t === 'string' && known.includes(t)) ? (v as PublishTargetKind[]) : null
}

/**
 * `fs:trashProject`（プロジェクトの削除が、最後にフォルダを移す口）。順に確かめ、全部通った回だけ移す。
 *  1. 確認を通った（`confirmed: true`）  2. ホームの深さ  3. 記録・中にプロジェクトがある・調べられない、でない（プロジェクトの根・ふつうのフォルダは通す）
 *  4. このプロジェクトで処理（公開・破棄・作成）が走っていない
 *  5. 公開の記録（`.sakuraide.json`・`.sakura-cloud/state.json`）が読めないのでない（R2-h・R3-d）。専有型の残りが分からないまま移すと、読めない記録ごと移り、月額が止まらない。ENOENT（記録が無い）は通す
 *  6. `skippedForTwins`（**必須**。画面の plan が、覆う複製があるために破棄を外した公開先）が正しい形。移す直前に、その公開先それぞれで覆う複製（`recordCoverFs`）を**読み直し**、
 *     1つでも覆う兄弟が無くなっていれば（確かめられない `'unknown'` を含む）移さずに断る（`reason: 'twins-gone'`。開いたあとに複製を消すと、画面の判断は古い。R2-e）。
 *     文は言い分ける（R3-e）: 1つでも確かめられなかった（`'unknown'`）なら「確かめられないため」（言い切れない側の文）、すべて確かめられて無かったなら「見つからなくなった」
 *  7. 専有型のリソースが残っていない（月額が止まらない）。**ただし、`skippedForTwins` に専有型があり、かつ覆う複製がいまもあるときだけ通す**（複製からは破棄を断るので、複製を消せる道を残す・I-3・R2-d・R2-e）
 * 保存場所などの残りでは止めない（チェックを外すのは利用者の選び）。
 */
export async function trashProjectFs(dir: unknown, opts: unknown, deps: TrashDeps): Promise<TrashProjectResult> {
  if (!isConfirmed(opts)) return { ok: false, message: NOT_CONFIRMED_MESSAGE }
  const r = checkTrash(dir, deps.home, ['project'])
  if (!r.ok) return { ok: false, message: r.message }
  // 走っている操作は、文字列でなく実体で比べる（大文字小文字だけ違うパス・リンク経由のパスでも、同じフォルダなら走っているとする。R2-b）
  if (runningOpEntryAt(r.abs, isSameDirFs)) return { ok: false, message: FS_TRASH_MESSAGES.running }
  // 読めない・壊れている `.sakuraide.json` を「専有型の残りなし」と読まない（R2-h。K3 と同じ向き）。無い（ENOENT）は通す。
  if (readMetaFs(r.abs).kind === 'unreadable') return { ok: false, message: FS_TRASH_MESSAGES.metaUnreadable }
  // `.sakura-cloud/state.json`（共用型の記録）も同じ（R3-d。双子）。ENOENT（記録が無い）は通す。読み口は兄弟の記録を読むのと同じ `readRecord`（ENOENT を見分ける1つ）。
  if (readRecord(path.join(r.abs, CLOUD_DIR, CLOUD_STATE_FILE)).kind === 'unreadable') return { ok: false, message: FS_TRASH_MESSAGES.stateUnreadable }
  const skipped = skippedForTwinsOf(opts)
  if (skipped === null) return { ok: false, message: FS_TRASH_MESSAGES.skippedInvalid }
  // 覆う複製がいまもあるか（読み直す。確かめられない 'unknown' は、いないのと同じ側＝断る）。**文は言い分ける**（R3-e）: 1つでも確かめられなかったなら「確かめられない」
  // （「見つからなくなった」と断定しない）。確かめられたうえで1つでも無いなら「見つからなくなった」。どちらも `reason: 'twins-gone'`（画面は材料を読み直す）。
  const reads = skipped.map(t => recordCoverFs(r.abs, t))
  if (reads.includes('unknown')) return { ok: false, message: FS_TRASH_MESSAGES.twinsUnknown, reason: 'twins-gone' }
  if (!reads.every(c => c.length > 0)) return { ok: false, message: FS_TRASH_MESSAGES.twinsGone, reason: 'twins-gone' }
  // 専有型の止めを外すのは、画面が外したと言い（skippedForTwins に専有型がある）、かつ覆う複製がいまもあるときだけ（両方そろったときだけ）。
  // 後ろの条件は、すぐ上の読み直しが skippedForTwins のすべてについて確かめ済み（専有型があれば、覆う複製がいまもある）。
  if (dedicatedTeardownHasWork(readApprunDedicatedFs(r.abs)) && !skipped.includes('sakura-apprun-dedicated')) {
    return { ok: false, message: FS_TRASH_MESSAGES.dedicated }
  }
  try {
    await deps.trashItem(r.abs)
  } catch (e) {
    return { ok: false, message: (e as Error | null)?.message ?? String(e) }
  }
  return { ok: true }
}
