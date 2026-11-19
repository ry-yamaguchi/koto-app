// writeCheckLimits.ts — 書いた中身の点検の上限（定義はここだけ）。
//
// ⚠️ の吹き出しを出す側（返事の終わりの点検）と、「🛠 AIに修正させる」を押した時点の読み直しが、
// 同じ上限を使う。別々に持つと、⚠️ は出るのに押した時点では確かめられない（またはその逆）ずれが黙って起きる。

/** これより大きいファイルは読まない（点検しない・確かめられない扱い）。バイト数。 */
export const WRITE_CHECK_READ_LIMIT_BYTES = 4_000_000

/** これより長い（文字数の）ファイルは点検しない。 */
export const WRITE_CHECK_MAX_CHARS = 1_000_000

/** 1回の返事で点検のために控えるファイルの数。超えた分は点検しない。 */
export const WRITE_CHECK_MAX_FILES = 100

/** 危ない書き方（訪問者の入力）を見る1行の長さの上限。これより長い行は見ない（迷う形は通す）。 */
export const WRITE_CHECK_MAX_LINE_CHARS = 5000
