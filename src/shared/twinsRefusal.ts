// twinsRefusal.ts — 公開先の破棄を「複製があるため」断るときの文（純関数・定数）。
//
// main の破棄の骨（main/cloud/teardownShell.ts）が断りの結果に書く文と、画面（renderer/teardown/flow.ts）が確認を出す前に返す結果の文は、同じここのもの
// （同じことを言う文を2か所で書かない）。骨は、ここから import して再エクスポートする。
//
// 断る理由は2つ（型は twinFactsTypes.ts の TwinRefusal）。
//   ・同じ公開の記録を持つ別のフォルダがある（`twin`）… 複製から破棄すると、元が公開している動いているアプリが消える
//   ・同じ公開の記録を持つフォルダがあるか確かめられなかった（`unknown`）… 確かめられないまま破棄しない
// どちらも、外へ1本も要求を出さず、公開の記録も消さない。

import { folderNamesText } from './keptDataNote'
import type { TwinRefusal } from './twinFactsTypes'

/**
 * 複製があるために破棄しなかったときの文。フォルダ名の並べ方は、同じフォルダを言うほかの文（`keptDataNote.ts` の folderNamesText。『A』・『B』）と同じ。
 * 次の一手（要らないほうを削除する）を言う。
 */
export function twinsRefusedMessage(twins: readonly string[]): string {
  return `${folderNamesText(twins)}にも同じ公開の記録があるため、何も破棄していません。要らないほうのフォルダを削除すると、残ったほうから破棄できます。`
}

/** 複製があるか確かめられなかったとき（親フォルダの一覧を読めない・確かめる関数が投げた・形の違う答え）の断り。確かめられないまま破棄しない（安全側）。 */
export const TWINS_UNKNOWN_MESSAGE = '同じ公開の記録を持つフォルダがあるか確かめられなかったため、何も破棄していません。'

/**
 * 断りの理由から、結果に書く文を決める。`twin`（フォルダ名が1件以上）だけが複製の文で、ほかは全部「確かめられなかった」の文
 * （読めない値を、複製の名前を挙げる側へ倒さない）。
 */
export function twinsRefusalMessage(refusal: TwinRefusal): string {
  // 型の上は twin だけが folders を持つが、実行時は信用しない（形の違う値は「確かめられなかった」側）。
  const r = refusal as { kind?: unknown; folders?: unknown }
  const names = (Array.isArray(r.folders) ? r.folders : []).filter((f): f is string => typeof f === 'string' && f.length > 0)
  return r.kind === 'twin' && names.length > 0 ? twinsRefusedMessage(names) : TWINS_UNKNOWN_MESSAGE
}
