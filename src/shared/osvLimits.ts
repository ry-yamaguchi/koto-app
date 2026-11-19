// ライブラリの脆弱性の照会の上限（定義はここだけ）
export const LOCKFILE_READ_LIMIT_BYTES = 16_000_000 // これより大きい package-lock.json は読まない
export const MANIFEST_READ_LIMIT_BYTES = 1_000_000 // これより大きい package.json は読まない
export const OSV_BATCH_SIZE = 500 // 1回の照会に入れる件数（OSV.dev の今の上限は 1,000）
export const OSV_MAX_PACKAGES = 5000 // 1回の操作で照会する件数の上限
export const OSV_MAX_PAGE_ROUNDS = 3 // 続きを取りに行く回数の上限
export const OSV_DETAIL_LIMIT = 30 // 詳細を取る弱点の数の上限
export const OSV_DETAIL_CONCURRENCY = 6 // 詳細を同時に取る本数
export const OSV_BATCH_TIMEOUT_MS = 20_000 // 照会1回の待ち時間
export const OSV_DETAIL_TIMEOUT_MS = 10_000 // 詳細1件の待ち時間
export const OSV_BATCH_REPLY_LIMIT_BYTES = 8_000_000 // 照会の応答の大きさの上限
export const OSV_DETAIL_REPLY_LIMIT_BYTES = 2_000_000 // 詳細の応答の大きさの上限
export const OSV_EXAMPLE_COUNT = 2 // 確認の窓に見せる例の数
