// nameConflict.ts — 公開名の衝突（重複）検出と代替名の提案（純粋関数・IO無し・Vitest対象）。
// HANAMII（HanamiiPanel）と さくらのAppRun（AppRunPanel）の両公開パネルで共有する。
//
// 前例: src/main/ipc/cloud.ts の cloud:ensureRegistry ハンドラ（コンテナレジストリの衝突対処）が
//   既存レジストリを再利用 → 衝突検知（/利用されて|exist|重複|conflict/i）→ ランダムhex付与で自動再試行、
//   という流れを実装済み。本モジュールは同じ考え方を「公開名」（HANAMIIプロジェクト名 / AppRunスペック名）
//   にも適用し、UI側でワンクリック再試行できるようにするためのもの。

/** 衝突（重複）を示す典型的な文言。cloud.ts の既存衝突検知パターンを踏襲（英語/日本語の双方）。
 *  duplicat・既に を追加（ユーザー指摘 2026-07-12）。裸の exist は「does not exist」等に誤反応するため
 *  含めない（already exists / application exists のような具体的な語順のみ拾う）。 */
const CONFLICT_PATTERN = /already exists|application exists|使われて|利用されて|重複|conflict|既に|duplicat/i

/** IPC層のエラーメッセージに埋め込まれる「（HTTP 409）」「(HTTP 409)」表記の検出（全角/半角括弧の双方に対応）。
 *  409 の前後に別の数字が続く場合（例: 「HTTP 4090」「HTTP 1409」）は反応しない。 */
const HTTP_409_PATTERN = /[（(]\s*HTTP\s*409\s*[）)]/i

/**
 * isNameConflictError — エラーメッセージ（と分かればHTTPステータス）から「名前の衝突（重複）」かを判定する。
 * - status が 409 なら無条件で衝突とみなす。
 * - message に「（HTTP 409）」のような埋め込み表記があればそれも衝突とみなす
 *   （呼び出し元の IPC は多くの場合 status を文字列メッセージへ吸収してしまう（例:
 *    「公開に失敗しました（HTTP 409）: {...}」）ため、status 引数が渡らないことが多い）。
 * - それ以外は message の文言でパターンマッチする。
 */
export function isNameConflictError(message: string, status?: number): boolean {
  if (status === 409) return true
  if (typeof message !== 'string' || !message) return false
  if (HTTP_409_PATTERN.test(message)) return true
  return CONFLICT_PATTERN.test(message)
}

/** AppRun のアプリ作成上限（アカウント単位）を示す文言。
 *  実例（2026-07-12 ユーザー報告）: HTTP 400 で
 *  {"reason":"violates application restriction","message":"Creation limit reached."} */
const CREATION_LIMIT_PATTERN = /creation limit|violates application restriction|上限に達し/i

/**
 * isCreationLimitError — エラーメッセージから「アカウントのアプリ作成上限」かを判定する。
 * 名前を変えても解決しない失敗のため、代替名の提案ではなく「不要なアプリの削除」への誘導を出す。
 */
export function isCreationLimitError(message: string): boolean {
  if (typeof message !== 'string' || !message) return false
  return CREATION_LIMIT_PATTERN.test(message)
}

/** 代替名の接尾辞に使う文字集合。紛らわしい文字（0/O・1/I/l・o）を除いた英数字小文字のみ。 */
const SUFFIX_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789'
const SUFFIX_LEN = 4

/** 既定の乱数源（0以上1未満）。Math.random ではなく Web Crypto の暗号学的乱数を使う。
 *  renderer（ブラウザ）・Node（Vitest）のどちらでも globalThis.crypto.getRandomValues が使える。 */
function cryptoRandom(): number {
  const arr = new Uint32Array(1)
  globalThis.crypto.getRandomValues(arr)
  return arr[0] / 0x100000000 // 2^32 で割り [0,1) に正規化
}

/**
 * suggestAlternativeName — 公開名が衝突したときのワンクリック代替名を作る純関数。
 * base の末尾ハイフンを除去しつつ、`-<4文字のランダム英数字>` を付けても maxLen に収まるよう切り詰める。
 *
 * 注記: プロジェクト名のハッシュ（決定的な値）ではなく毎回ランダムにする理由＝同じプロジェクト名を
 * 使っている他ユーザーと同じ接尾辞になって再度衝突するのを避けるため（ユーザー指摘 2026-07-11）。
 * src/main/ipc/cloud.ts の cloud:ensureRegistry ハンドラ（コンテナレジストリの衝突対処）が
 * randomBytes(2).toString('hex') で再試行しているのと同じ方式。
 *
 * @param base   元になる名前（現在の公開名など）。
 * @param maxLen 生成する名前の最大文字数。
 * @param random 乱数源（0以上1未満を返す関数）を注入できる（テスト用。既定は上記の暗号学的乱数）。
 */
export function suggestAlternativeName(base: string, maxLen: number, random: () => number = cryptoRandom): string {
  let suffix = ''
  for (let i = 0; i < SUFFIX_LEN; i++) {
    const idx = Math.min(SUFFIX_CHARS.length - 1, Math.max(0, Math.floor(random() * SUFFIX_CHARS.length)))
    suffix += SUFFIX_CHARS[idx]
  }
  // '-' + suffix の分（1 + SUFFIX_LEN）を差し引いた残りが base に使える文字数。
  const room = Math.max(1, maxLen - 1 - SUFFIX_LEN)
  const trimmedBase = (base || '').replace(/-+$/, '').slice(0, room).replace(/-+$/, '')
  return `${trimmedBase || 'app'}-${suffix}`
}
