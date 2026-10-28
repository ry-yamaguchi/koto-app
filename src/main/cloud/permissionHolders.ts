// permissionHolders.ts — ある保存場所の鍵（権限 ID）を、ほかのプロジェクトが記録に持っているか。**記録から読む**（読むだけ・外へ要求を出さない・何も書かない・electron に依存しない）。
// 0.6.24 R2-i（7章の申し送り・U6 の報告）。
//
// ── なぜ要るか ──────────────────────────────────────────────────────────────────────
// 記録の鍵（共用型の `state.meta.storagePermissionId`・専有型の記録の `storagePermissionId`）は、破棄・公開の apply の削除が、保存場所を片づけたあとに無効にする。
// 複製が**保存場所の設定を外して、記録の鍵の ID だけを写した**形（保存場所0件・記録の鍵あり）だと、`placementsHaveTwinRisk`（R1-c。保存場所の prefix で複製を見る）は
// 何も見つけられず、複製の側の破棄が、元の現役の鍵（元のアプリがいま保存場所へ読み書きに使っているもの）を無効にしてしまう。
// そこで、**鍵の ID そのもの**を、同じ親フォルダの兄弟の記録から探す。
//
// ── 読む記録（書き下す）──────────────────────────────────────────────────────────────
//   ・共用型 … 兄弟の `.sakura-cloud/state.json` の `meta.storagePermissionId`
//   ・専有型 … 兄弟の `.sakuraide.json` の `publish.apprunDedicated.storagePermissionId`
// HANAMII は鍵の ID を記録に残していない（hanamiiTeardown.ts の注）ので、読むものは無い。
//
// ── 答え ──────────────────────────────────────────────────────────────────────────────
//   ・`true` … 兄弟のどれかが同じ ID を持つ（ほかが読めなくても、見つかった事実は動かない）
//   ・`'unknown'` … 持つ兄弟は見つからず、確かめられなかったものがある（親フォルダの一覧を読めない・たどれないリンク・兄弟の記録が読めない／壊れている／形が違う）。
//     **K3 と同じ向き**: 確かめられないものは、持っていないと読まない（呼び手は鍵を無効にしない）。`twinsOf`（複製の判断）が読めない兄弟を数えないのとは違う:
//     あちらは数え間違えても止まる側（何も消さない）、こちらは数え間違えると現役の鍵が切れる
//   ・`false` … 全部の兄弟を読み終え、どれも持たない
// 自分（同じフォルダ。リンク・大文字小文字・NFC/NFD の違いを含む）・隠しフォルダ・ファイルは兄弟に数えない（`bucketUsers.ts` と同じ歩き方・同じ `isSameDirFs`）。**投げない。**
import * as fs from 'fs'
import * as path from 'path'
import { CLOUD_DIR, CLOUD_STATE_FILE } from './specStore'
import { entryKind, readRecord, isSameDirFs, type RecordRead } from './bucketUsers'
import { readMetaFs } from '../publishMetaFs'

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 1つの記録の読み結果から、`id` を持つかを言う。ファイルが無い（ENOENT）は持たない。読めない・オブジェクトでない値は `'unknown'`。 */
function holds(read: RecordRead, id: string, pick: (v: Record<string, unknown>) => unknown): boolean | 'unknown' {
  if (read.kind === 'missing') return false
  if (read.kind === 'unreadable' || !isObject(read.value)) return 'unknown'
  return pick(read.value) === id
}

/**
 * `projectDir` 以外の、同じ親フォルダの兄弟のどれかが、鍵 `id` を記録に持つか。上のファイルの冒頭のとおり（`true`・`'unknown'`・`false`）。
 * 絶対パスでない・`id` が空の文字列でないときも `'unknown'`（親フォルダが決まらない・何を探すか分からない）。
 */
export function permissionHeldByOthersFs(projectDir: string, id: string): boolean | 'unknown' {
  try {
    if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir) || typeof id !== 'string' || id === '') return 'unknown'
    const self = path.resolve(projectDir)
    const workspace = path.dirname(self)
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(workspace, { withFileTypes: true }) } catch { return 'unknown' } // 親フォルダの一覧を読めない
    let unknown = false
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const dir = path.join(workspace, e.name)
      if (dir === self || isSameDirFs(dir, self)) continue
      const kind = entryKind(workspace, e)
      if (kind === 'other') continue
      if (kind === 'unknown') { unknown = true; continue } // たどれないリンク。持っているか分からない
      const sharedKey = holds(readRecord(path.join(dir, CLOUD_DIR, CLOUD_STATE_FILE)), id, v => (isObject(v.meta) ? v.meta.storagePermissionId : undefined))
      const dedicatedKey = holds(readMetaFs(dir), id, v => {
        const rec = isObject(v.publish) ? v.publish.apprunDedicated : undefined
        return isObject(rec) ? rec.storagePermissionId : undefined
      })
      if (sharedKey === true || dedicatedKey === true) return true
      if (sharedKey === 'unknown' || dedicatedKey === 'unknown') unknown = true
    }
    return unknown ? 'unknown' : false
  } catch {
    return 'unknown' // 想定外の例外。確かめられていない
  }
}
