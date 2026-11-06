// updateLog.ts — 更新ログの組み立て（純粋ロジック）。
//
// ── なぜ要るか（2026-08-11）────────────────────────────────────────────
// 自動更新は **失敗しても画面が静かなまま**である。配信元に届かなければ
// 「更新を確認できませんでした」と一行出るだけで、なぜ届かなかったかは残らない。
// 実際、v0.3.2 の時点で Ryosuke が「何も発生しない」と感じた状態がそれで、
// **私の側にも調べる手段が無かった**（electron-updater は既定でどこにも書かない）。
//
// 利用者は非エンジニアなので、「ログを見てください」では通じない。
// **ファイルに残し、設定画面のボタンから開けるようにする**のがここの目的。
//
// ── 守りとしての性質（掟10）──────────────────────────────────────────
// ログは**利用者が私に送ってくるもの**である。つまり、ここに秘密が混ざると
// 秘密が外へ出る。electron-updater は URL を記録するので、将来 private 配信
// （PAT 付きURL）へ切り替えたときに素通しになる。**書く前に必ず落とす。**

import { maskSecretShapes } from './secretShapes'
import { maskHomePath } from './homePath'

/** ログの深刻度。electron-updater の Logger インターフェースに合わせる。 */
export type UpdateLogLevel = 'info' | 'warn' | 'error' | 'debug'

/**
 * ログに書いてはいけないものを伏せる（純関数）。
 *
 * **「消しすぎ」より「漏らす」ほうが害が大きい**ので、迷ったら伏せる。
 * ただし、調べるのに要る情報（URL のホストとパス・版番号・ファイル名・
 * sha512 のようなハッシュ）は**残す**。全部伏せたらログの意味が無くなる。
 */
export function redactSecrets(text: string): string {
  // **順序が意味を持つ。** 汎用の「名前つきパラメータ」を先に走らせると、
  // `key: -----BEGIN RSA PRIVATE KEY-----` の BEGIN 行だけを潰してしまい、
  // 鍵の本体がそのまま残る（テストで実際に捕まえた）。
  // 具体的な形のものから順に落とし、いちばん粗いルールを最後に置く。
  //
  // 形で分かるもの（秘密鍵・既知のキー・Bearer・URL の資格情報）は、秘密の形の唯一の定義
  // （shared/secretShapes.ts）から伏せる。ここに同じ正規表現を持たない（掟10）。
  // ログは1行にまとめるので行数は保たず、名前を見て決める形は下の(4)が受け持つ。
  return maskSecretShapes(String(text ?? ''), { keepLines: false, byName: false })
    // (4) 名前つきのパラメータ（?token=… / "api_key": "…"）。いちばん粗いので最後
    .replace(/((?:access_|api[-_]?|auth|private[-_]?)?(?:token|key|secret|password|passwd|pwd)["'\s]*[:=]["'\s]*)([^\s"'&,}]{8,})/gi, '$1***')
}

/**
 * ログ1行を組み立てる（純関数）。
 * 改行は空白に潰す。1件＝1行でないと、後ろから行単位で捨てられなくなる。
 * 秘密を伏せたうえで、ホームのパス（利用者名）を `~` にする（ログは利用者が作者へ送るもので、貼り付け先が公開の場所のこともある）。
 * `home` は実行している環境のホーム（`os.homedir()`）。渡さなくても `/Users/<名前>` は `~` になる。
 */
export function formatLogLine(level: UpdateLogLevel, message: unknown, now: Date, home?: string): string {
  const body = message instanceof Error
    ? `${message.message}${message.stack ? ` | ${message.stack}` : ''}`
    : typeof message === 'string' ? message : JSON.stringify(message)
  const flat = maskHomePath(redactSecrets(body), home).replace(/\s*\n\s*/g, ' ⏎ ').trim()
  return `${now.toISOString()} [${level}] ${flat}`
}

/**
 * ログが際限なく育たないように、古い行から捨てる（純関数）。
 *
 * **行の途中で切らない。** 途中で切ると壊れた行が残り、読む人を混乱させる。
 * 上限を超えていなければ、そのまま返す（無駄に書き換えない）。
 */
export function trimLog(existing: string, maxBytes: number): string {
  const buf = Buffer.from(existing, 'utf8')
  if (buf.length <= maxBytes) return existing
  // 末尾 maxBytes を残し、最初の改行までを捨てて行の境界に揃える
  const tail = buf.subarray(buf.length - maxBytes).toString('utf8')
  const nl = tail.indexOf('\n')
  return nl < 0 ? tail : tail.slice(nl + 1)
}
