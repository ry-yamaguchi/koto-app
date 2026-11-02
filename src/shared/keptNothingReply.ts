// keptNothingReply.ts — 何も消さないと分かっている回に、確認も IPC も出さず、画面が組む結果（純関数）。
//
// 保存場所が全部「消さずに残す」（同じデータを使うフォルダがいる・確かめられない。cloud:twinFacts の答え）で、消す資源（アプリ・コンテナレジストリ・計算資源）も無い回は、
// 破棄を押しても何も消えない。main は同じ入力で、データにもバケットにも触れず、保存場所ごとに「残しました」の行と残した事実を返す。
// 画面は main を呼ばず、同じ形の結果を、main と同じ文の作り手（storageTeardownDoneLine・keptDataReasonNote・keptOnlyField）から組む。
// 行の文・黄色の月額の警告・見出しは、この結果を `toTeardownView`（shared/teardownResult.ts）に通して決まる（main の返り値と同じ道）。ここに文を足さない。
//
// electron にも React にも依存しない。
import { isTwinKeep, keptDataReasonNote } from './keptDataNote'
import { keptOnlyField } from './keptOnly'
import { storageTeardownDoneLine } from './teardownSupport'

/** 残す保存場所1件。`keep` は `cloud:twinFacts` の答え（形の読めない値にも耐える緩い型で受ける）。 */
export type KeptNothingPlacement = { bucket: string; keep?: { risk?: unknown; folders?: unknown } | null }

/** 画面が組む結果。共用型・専有型・HANAMII の返り値のうち、保存場所を残した回の項目だけを持つ（どの公開先の返り値にも載る形）。 */
export type KeptNothingReply = {
  ok: true
  executed: string[]
  keptBucketName: string
  keptBucketNames: string[]
  /** ほかのフォルダが同じデータを使っているため残した保存場所（消すと、そのプロジェクトのデータも消える）。無ければキーごと付けない。 */
  keptBucketsUsedByOthers?: string[]
  /** 何も消していないことの印（判断は keptOnlyOf の1つ）。 */
  keptOnly?: true
}

/**
 * 残す保存場所（1件以上）から、結果を組む。並びと件数は渡された保存場所のまま（main は保存場所ごとに1行・1つの名前を返す）。
 * `appDeleted` は付けない（この回、アプリは何も消していない）。
 */
export function keptNothingReplyOf(placements: readonly [KeptNothingPlacement, ...KeptNothingPlacement[]]): KeptNothingReply {
  const names = placements.map(p => p.bucket)
  const usedByOthers = placements.filter(p => isTwinKeep(p.keep)).map(p => p.bucket)
  return {
    ok: true,
    executed: placements.map(p => storageTeardownDoneLine(p.bucket, keptDataReasonNote(p.keep), true)),
    keptBucketName: names[0],
    keptBucketNames: names,
    ...(usedByOthers.length > 0 ? { keptBucketsUsedByOthers: usedByOthers } : {}),
    ...keptOnlyField({ ok: true, removedApp: false, removedRegistry: false, storage: placements.map(() => ({ keptData: true })) }),
  }
}
