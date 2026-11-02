// teardown/keptNothing.ts — 「何も消さないと分かっている回」の門（純関数。React に依存しない）。
//
// 破棄を押しても何も消えない回（保存場所が全部「消さずに残す」で、消す資源も無い）は、確認を出さず、IPC も呼ばず、結果を画面が組む（flow.ts）。
// 門は1つ。共用型・HANAMII・専有型の3つの仕様書が、同じこの関数を通る（共用型だけの門を作らない）。
//
// 決める材料は、確認が「何も消さない」と言う判断（confirm.ts の confirmDestroysNothing）と同じもの。判断を二重に書かず、その関数を呼ぶ:
//   ・消す保存場所（`keep` の無いもの）が無く、残す保存場所（`keep` のあるもの）が1件以上ある
//   ・名前を挙げて消すものが無い（仕様書の `targets` が空。共用型はアプリ・コンテナレジストリ、HANAMII はプロジェクト、専有型は資源の記録がある回は空でない）。
//     保存場所だけが残った回（`leftoverNote`）は、公開先のものは無い扱い
//   ・記録に保存場所の鍵が残っていない（仕様書の `keyRecorded`。鍵を記録に持つ公開先だけが持つ）。鍵が残る回は、main が鍵を無効にしなかった警告を足すことがあり、
//     画面は同じ結果を組めないので、確認へ進めて main に任せる
// `keep` は `cloud:twinFacts` が読めた回にだけ付く。読めなかった回（`twinFactsUnreadable`）・保存場所の設定を読めなかった回は、門を通さない（確認へ進む。main が実行時に同じ判断を下す）。
import type { KeptNothingPlacement } from '../../shared/keptNothingReply'
import { confirmDestroysNothing, namedPlacementsOf } from './confirm'
import type { TargetSpec, TeardownFacts } from './types'

/**
 * 何も消さない回なら、残す保存場所（名前のあるもの・1件以上）を返す。そうでなければ null（今までどおり確認へ進む）。
 * 不明は肯定に倒さない: 読めなかった（`twinFactsUnreadable`・`placementsUnreadable`）回は、保存場所に `keep` が付かないので、門を通らない。
 * 鍵の有無も同じ向き: 仕様書が `keyRecorded` を持つなら、`false` と言い切れる回だけ通す（`false` 以外の答えは鍵が残る側）。
 */
export function keptNothingPlacements<R>(
  spec: Pick<TargetSpec<R, unknown, unknown>, 'targets' | 'leftoverNote' | 'keyRecorded'>,
  facts: Pick<TeardownFacts<R>, 'record' | 'placements' | 'placementsUnreadable' | 'twinFactsUnreadable'>,
): [KeptNothingPlacement, ...KeptNothingPlacement[]] | null {
  if (facts.placementsUnreadable || facts.twinFactsUnreadable === true) return null
  if (spec.keyRecorded !== undefined && spec.keyRecorded(facts.record) !== false) return null
  const leftoverNote = spec.leftoverNote?.(facts.record, facts.placements) ?? undefined
  const nothing = confirmDestroysNothing({
    placements: facts.placements,
    targets: spec.targets(facts.record, facts.placements),
    leftoverNote,
  })
  if (!nothing) return null
  const [first, ...rest] = namedPlacementsOf(facts.placements)
  return first === undefined ? null : [first, ...rest]
}
