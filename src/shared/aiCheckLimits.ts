// aiCheckLimits.ts — 「AI の確認」の上限の定義（ここだけ）。

/** 1回の返事から採る指摘の数。 */
export const AI_FINDINGS_PER_BATCH = 10
/** AI の言う行の前後、何行までを「近い」と見るか。 */
export const AI_QUOTE_NEAR_LINES = 2
/** これより短い引用は、照合に使わない。 */
export const AI_QUOTE_MIN_CHARS = 6
/** 指摘の説明（note）の長さの上限。 */
export const AI_NOTE_MAX_CHARS = 200
/** 引用（quote）の長さの上限。 */
export const AI_QUOTE_MAX_CHARS = 160
/** これより長い返事は、後ろのこの長さだけを見る。 */
export const AI_REPLY_MAX_CHARS = 200000
/** JSON を探すとき、後ろから数えて、いくつの「{」まで試すか。 */
export const AI_JSON_SCAN_LIMIT = 400
/** 画面に出す指摘の数。超えた分は「・ほかN件」にまとめる。 */
export const AI_FINDINGS_SHOWN = 30
/** 指摘が空の塊の前と後ろに、それぞれ付いてよい文字の数（空白・囲みの印を除く）。両方が超えたら、問題なしと読まない。 */
export const AI_EMPTY_AROUND_MAX_CHARS = 20
