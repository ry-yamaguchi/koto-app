// opWord.ts — 記録の op（'作成' | '削除' | '公開'）と公開先から、画面で言う操作の言葉を決める（純関数）。
//
// ── なぜ要るか（0.6.22-rc.3 の実機・2026-10-20）──────────────────────────────────────────
// main の記録（projectOps.ts の ProjectOp）は、共用型・HANAMII の「破棄」も専有型の「削除」も、同じ '削除' で持つ。
// 画面がその記録の op をそのまま文にすると、共用型の破棄のあとの【公開】の結果カードが
// 「さくらのAppRunの削除は終わりましたが…」と出て、破棄の流れ（確認・進み具合・結果）の「破棄」と言葉が割れる。
// 0.6.22 の決定 D3: 共用型・HANAMII は「破棄」、専有型は「削除」。1回の流れの中は1つの言葉。
// 記録の op を画面の文にするときは、必ずここを通す（`${rec.op}` を文に埋めない）。
//
// ── 破棄の流れの仕様との関係 ────────────────────────────────────────────────────────────
// 破棄の流れの言葉は src/renderer/teardown/targets/{shared,hanamii,dedicated}.ts の words.verb が持つ。ここはそれと同じ答えを返す
// （tests/opWord.test.ts が3つの公開先で突き合わせる）。公開先が増えたら、下の表（Record は全キーを要求する）に足さないと型エラーになる。
//
// ⚠️ node の path/fs/electron は import しない（画面からも main からも import される shared）。
import type { PublishTargetKind } from './publishMeta'

/** 公開先ごとの、「削除」の操作を画面で何と言うか。共用型・HANAMII は破棄、それ以外（専有型・レンタルサーバ・Vercel）は削除。 */
const DELETE_WORD: Readonly<Record<PublishTargetKind, '破棄' | '削除'>> = {
  'sakura-apprun': '破棄',
  hanamii: '破棄',
  'sakura-apprun-dedicated': '削除',
  'sakura-rental': '削除',
  vercel: '削除',
}

/**
 * 記録の op と公開先から、画面で言う操作の言葉を返す。
 * '削除' だけが公開先で変わる（共用型・HANAMII は '破棄'、専有型・そのほかの公開先・公開先が分からないときは '削除'）。
 * '公開'・'作成' ほか、知らない op はそのまま返す。
 */
export function opWordFor(op: string, target?: string | null): string {
  if (op !== '削除') return op
  return typeof target === 'string' && Object.prototype.hasOwnProperty.call(DELETE_WORD, target)
    ? DELETE_WORD[target as PublishTargetKind]
    : '削除'
}
