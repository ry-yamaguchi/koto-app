// scaleDecision.ts — 再公開のとき「起動のしかた（min_scale）」が、さくら側の実物と
// Koto の設定（env.json の service.scale.min）で食い違っていたら、黙って上書きせず
// どちらにするかを聞くための判断（純関数・IO無し・掟10）。
//
// ── なぜ要るか ────────────────────────────────────────────────────────
// 再公開（`applyPlan` の `update` アクション）は `buildPatchBody(spec)` で
// **`min_scale: spec.service.scale.min` を毎回送る**（v0.6.15〜・#31）。そのため、
// 利用者がさくらのコントロールパネルで直接「最小スケール」を変えていても、次の
// 再公開で **Koto の設定で黙って上書き**される。逆も同じ。課金に関わる値
// （min≥1 は常時課金）なので「黙って」が問題（Ryosuke さん決定・案②・2026-09-10）。
//
// **決めたこと（案②）**: 普段（一致・未公開）は何も出ない。**食い違ったときだけ止めて聞く**。
// 歯止めは main 側（`applyPlan`）に置く（掟10の基準: renderer の確認だけに頼らない）。

/**
 * GET /applications/{id} の応答から `min_scale` を読む。
 * **number でなければ null**（他のキーを当てにいかない・掟1「形が違えば推測しない」）。
 */
export function readActualMinScale(data: unknown): number | null {
  const v = (data as any)?.min_scale
  return typeof v === 'number' ? v : null
}

/** どちらの値で公開するかの選択。'koto'＝Koto の設定（記録）／'sakura'＝さくら側の実物。 */
export type ScaleDecision = 'koto' | 'sakura'

/** judgeScale の判断結果。ask のときは PATCH を呼ばず、利用者に選んでもらう。 */
export type ScaleJudgement =
  | { kind: 'proceed'; min: number; note: string | null }
  | { kind: 'ask'; recorded: number; actual: number }

/**
 * judgeScale — 記録（Koto の設定）と実物（さくら側）を突き合わせ、公開してよいかを判断する。
 *
 * - `actual === null`（確認できない）→ **proceed・Koto の設定（recorded）で進める**。
 *   確かめられなかっただけで公開できないのは「壊れている」のと同じ、という preflight の
 *   方針（`summarizePreflight` の「迷ったら通す側に倒す」）に合わせる。ただし黙らず note に残す。
 * - `actual === recorded` → proceed・note なし（一致・普段どおり。何も言わない）。
 * - 食い違い・`decision` 未指定 → **ask**（fetch も PATCH もしない。呼び出し側が止める）。
 * - `decision === 'koto'` → proceed・recorded を採用。
 * - `decision === 'sakura'` → proceed・actual を採用。
 */
export function judgeScale(input: { recorded: number; actual: number | null; decision?: ScaleDecision }): ScaleJudgement {
  const { recorded, actual, decision } = input
  if (actual === null) {
    return {
      kind: 'proceed',
      min: recorded,
      note: `さくら側の起動のしかたを確認できませんでした。Koto の設定（${scaleLabel(recorded)}）で公開します`,
    }
  }
  if (actual === recorded) {
    return { kind: 'proceed', min: recorded, note: null }
  }
  if (decision === 'koto') return { kind: 'proceed', min: recorded, note: null }
  if (decision === 'sakura') return { kind: 'proceed', min: actual, note: null }
  return { kind: 'ask', recorded, actual }
}

/**
 * scaleLabel — min から画面の言葉を作る。
 * `AppRunPanel.tsx` の `scaleDisplay` と同じ言葉（0＝最初のアクセスが遅くてもよい・1以上＝すぐ返す）。
 */
export function scaleLabel(min: number): string {
  return min >= 1 ? 'すぐ返す（常時動かす）' : '最初のアクセスが遅くてもよい（安い）'
}
