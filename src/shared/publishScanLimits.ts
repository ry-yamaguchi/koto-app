// publishScanLimits.ts — 公開されるファイルの点検（Koto が自分で読む部分）の上限。上限の定義はここだけ。

export const PUBLISH_SCAN_MAX_FILES = 5000 // 一覧に入れるファイルの数の上限
export const PUBLISH_SCAN_FILE_LIMIT_BYTES = 1_000_000 // これより大きいファイルは点検しない
export const PUBLISH_SCAN_TOTAL_LIMIT_BYTES = 20_000_000 // 1回の点検で読む合計の上限
export const PUBLISH_SCAN_SNIFF_BYTES = 8192 // バイナリかを見る先頭の長さ
export const PUBLISH_SCAN_FINDINGS_LIMIT = 500 // 画面へ返す指摘の数の上限（件数は別に返す）
export const PUBLISH_SCAN_LIST_LIMIT = 20 // 画面に並べる指摘の行の上限
export const PUBLISH_SCAN_NAME_LIMIT = 5 // 注記に並べるファイル名の上限
export const PUBLISH_SCAN_YIELD_BYTES = 1_000_000 // 読んだ量がこれを超えるたびに、main の手を休める
