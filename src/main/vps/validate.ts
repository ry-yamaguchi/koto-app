// validate.ts — さくらのVPS 公開機能: スクリプト/コマンドへ埋め込む値の厳格検証（純粋関数のみ・electron非依存）。
// docs/vps-plan.md §2.5 準拠: 「埋め込みパラメータは厳格な正規表現で検証（コマンドインジェクション根絶）」。
// ここを通った値だけが scripts.ts のテンプレートへ埋め込まれる（掟: 無検証でユーザー入力を文字列連結しない）。

// IPv4 または FQDN（ラベルごとに英数字始まり・英数字終わり・中間はハイフン可・63文字以内）。
// 指示書に明記された正規表現をそのまま使用する。
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i

// Linuxユーザー名の慣習的な制約: 小文字英字/アンダースコア始まり、以降は小文字英数字/アンダースコア/ハイフン、
// 先頭込みで最大32文字（useradd のデフォルト上限に合わせる）。
const USERNAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/

/**
 * ホスト名（FQDN）または IPv4 アドレスとして妥当か。
 * 空白・引用符・セミコロン・バッククォート・改行等を含むものは正規表現に一致せず、すべて false になる。
 */
export function isValidHost(s: unknown): s is string {
  if (typeof s !== 'string') return false
  if (s.length === 0 || s.length > 253) return false
  // 改行・NUL等の制御文字は明示的にも弾く（$ の挙動に依存しない防御的チェック）。
  if (/[\x00-\x1f\x7f]/.test(s)) return false
  return HOST_PATTERN.test(s)
}

/** 1〜65535 の整数のみ許可（文字列・小数・範囲外はすべて false）。 */
export function isValidPort(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65535
}

/** Linuxユーザー名として妥当か（`sakura-admin` / `deploy` 等・小文字始まり最大32文字）。 */
export function isValidUsername(s: unknown): s is string {
  if (typeof s !== 'string') return false
  return USERNAME_PATTERN.test(s)
}

/**
 * `ssh-ed25519 AAAA...` 形式の公開鍵のみ許可（他の鍵種別・不正な形式はすべて false）。
 * コメント（3つ目のフィールド）は付けてもよいが、英数字・`.`・`_`・`-`・`@` のみに限定する
 * （シェルメタ文字や空白混じりの自由記述コメントは許可しない。IDEが自身で生成する鍵は
 * コメント固定 'koto-vps' のため、この制限で実用上困ることはない）。
 */
export function isValidPublicKey(s: unknown): s is string {
  if (typeof s !== 'string') return false
  if (s.length === 0 || s.length > 1024) return false
  if (/[\x00-\x1f\x7f]/.test(s)) return false // 改行・NUL等の制御文字を含むものは拒否
  if (s.trim() !== s) return false // 前後の空白があれば拒否（呼び出し側で trim 済みの値を渡す前提）

  const fields = s.split(' ')
  if (fields.length < 2 || fields.length > 3) return false
  const [type, body, comment] = fields
  if (type !== 'ssh-ed25519') return false
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return false
  // ed25519公開鍵のbase64本体は68文字前後。極端に短い値（typo・別鍵種別の混入等）は安全側で弾く。
  if (body.length < 60) return false
  if (comment !== undefined) {
    if (comment.length === 0) return false
    if (!/^[A-Za-z0-9_.@-]+$/.test(comment)) return false
  }
  return true
}

// シェルへ渡す直前の最終防衛で検出する危険文字（制御文字＋シェルメタ文字＋引用符）。
// isValidHost/isValidUsername/isValidPublicKey を通った正常な値はこの集合に一切マッチしない
// （＝二重の安全網。上記関数の実装ミスや将来の変更に対する保険として存在する）。
const UNSAFE_SHELL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f;&|`$(){}<>\\!'"\n\r]/

/**
 * 上記の検証を通った値であっても、シェル（スクリプトテンプレート）へ埋め込む直前に
 * 最終防衛として危険文字を検出したら例外を投げる。呼び出し側は必ずこれを通してから埋め込むこと。
 */
export function assertSafeForShell(s: string): void {
  if (typeof s !== 'string') throw new Error('シェルへ渡す値が文字列ではありません')
  if (UNSAFE_SHELL_CHARS.test(s)) {
    throw new Error(`安全でない文字が含まれる値が検出されました: ${JSON.stringify(s.slice(0, 120))}`)
  }
}
