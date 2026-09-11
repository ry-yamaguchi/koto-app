// publishLabels.ts — 公開ボタンの文言を1箇所に決める（委譲仕様 UX-E・判断8）。
//
// これまで HANAMII は「再公開する」、AppRun 共用型は「公開する（作成・更新）」、
// Vercel・AppRun 専有型は「公開する」と、同じ操作（公開する）に別々の言い方をしていた。
// **全パネルの主ボタンは「🚀 公開する」に揃え、既に公開済み（今回は更新になる）ときだけ
// 「（更新）」を付ける。** 専有型の⑤「クラスタを作成する」はクラスタの作成であって
// 公開（アプリケーションの公開）ではないため、この関数の対象外（呼び出さない）。
export function publishButtonLabel(published: boolean): string {
  return published ? '🚀 公開する（更新）' : '🚀 公開する'
}
