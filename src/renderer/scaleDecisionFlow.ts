// scaleDecisionFlow.ts — 画面（AppRunPanel）が、選択カードのボタンを押したあと
// `cloud.apply` を**呼び直す**ときの opts を決める純関数（純ロジック・IO無し）。
//
// 「起動のしかた」がさくら側と Koto の設定で食い違ったとき、applyPlan は
// PATCH を呼ばずに止めて聞く（`needsScaleDecision`）。画面は選択カードを出し、
// 選んだ方（'koto' / 'sakura'）を `scaleDecision` に載せて**同じ confirmed で**
// もう一度呼び直す（Ryosuke さん決定・案②・2026-09-10）。

import type { ScaleDecision } from '../shared/scaleDecision'

/**
 * nextApplyOpts — 選び直すときに `cloud.apply(projectDir, opts)` へ渡す opts。
 * `confirmed` は最初の呼び出しと**同じ値をそのまま引き継ぐ**（改めて確認を求めない。
 * 破壊的操作の確認は既に済んでいる想定のため）。
 */
export function nextApplyOpts(prev: { confirmed: boolean }, choice: ScaleDecision): { confirmed: boolean; scaleDecision: ScaleDecision } {
  return { confirmed: prev.confirmed, scaleDecision: choice }
}
