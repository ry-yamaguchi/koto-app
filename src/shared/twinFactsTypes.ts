// twinFactsTypes.ts — 読むだけの口 `cloud:twinFacts` の引数と返り値の型。型だけで、実行時には何も持たない。
// main の `cloud/twinFacts.ts` と、renderer の `global.d.ts` の宣言が、同じこの形を使う（形を2か所で書かない）。
//
// `cloud:twinFacts` は、破棄を押す前に、同じ親フォルダの別のフォルダ（複製）について次の2つを記録から読んで返す。
//   ・公開先の断り（`refusal`）… 同じ公開の記録を持つフォルダがいれば、公開先の破棄は何も消さずに断られる
//   ・保存場所ごとの「消さずに残す」（`keep`）… 同じデータ（同じ保存場所の同じ prefix）を使うフォルダがいる、
//     または複製かどうか確かめられないときは、破棄は保存場所のデータにも保存場所そのものにも手を付けない
// どちらも、破棄の本体が実際に下す判断と同じ関数で決める。この口は読むだけで、何も消さず、何も書かない。

/** 複製を数える公開先。 */
export type TwinFactsTarget = 'hanamii' | 'sakura-apprun' | 'sakura-apprun-dedicated'

/** 確かめたい保存場所1件（名前と prefix の組。prefix が無いものは `''`）。 */
export type TwinFactsPlacementInput = { bucket: string; prefix: string }

/** `cloud:twinFacts` の第2引数。 */
export type TwinFactsArgs = { target: TwinFactsTarget; placements: TwinFactsPlacementInput[] }

/**
 * 公開先の断り。
 *   ・`twin` … 同じ公開の記録を持つ別のフォルダがいる（`folders` はそのフォルダ名・文字コード順。1件以上）
 *   ・`unknown` … 複製がいるか確かめられなかった（親フォルダの一覧を読めない）
 */
export type TwinRefusal = { kind: 'twin'; folders: string[] } | { kind: 'unknown' }

/**
 * 保存場所を消さずに残す理由。
 *   ・`twin` … 同じ保存場所の同じ prefix を記録に持つ別のフォルダがいる（`folders` はそのフォルダ名・文字コード順。1件以上）
 *   ・`unread` … 複製かどうか確かめられなかった（`folders` は記録を読めなかったフォルダ名。名前を挙げられないときは空）
 */
export type PlacementKeep = { risk: 'twin' | 'unread'; folders: string[] }

/** 保存場所1件の答え。`keep` が `null` なら、確かめられて、複製はいない。 */
export type TwinFactsPlacement = { bucket: string; prefix: string; keep: PlacementKeep | null }

/**
 * `cloud:twinFacts` の返り値。
 *   ・`refusal` が `null` … 同じ公開の記録を持つ別のフォルダはいない（確かめられた）
 *   ・`placements` … 渡された保存場所と同じ並び・同じ件数
 *   ・`{ ok: false }` … 引数が正しくない（呼び手は「読めなかった」として扱う）
 */
export type TwinFactsResult =
  | { ok: true; refusal: TwinRefusal | null; placements: TwinFactsPlacement[] }
  | { ok: false }
