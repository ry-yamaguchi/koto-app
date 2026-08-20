// registryTrouble.ts — 「この失敗はレジストリを整え直せば直るか」を判断する（純ロジック）。
//
// ── なぜ要るか（2026-08-14 実機）────────────────────────────────────────
// コンテナレジストリをコントロールパネルで削除したあと公開すると、
// 「アプリの組み立てに失敗しました」とだけ出て、**回復のボタンが出なかった**。
// 「レジストリを設定し直す」導線は用意してあったのに、それを出す印（hint）を
// **エキスパート（Docker）の経路にしか付けていなかった**。標準（Docker不要）の
// 経路には無く、既定の使い方をしている人だけが袋小路に入る形だった。
//
// 掟10「一元化したことと、全経路が実際にそこを通っていることは別」。

/** レジストリが原因らしいログの印。押し付けがましくならないよう、確度の高いものだけ。 */
const MARKERS: readonly RegExp[] = [
  // さくらのレジストリが消えているときの、いちばんはっきりした印（2026-08-14 実機ログ）:
  //   GET https://auth.sakuracr.jp/token/?...&service=data-test-cd35.sakuracr.jp:
  //   unexpected status code 404 Not Found: {"error": "unknown service"}
  /unknown service/i,
  /401|403/,
  /unauthorized|authentication|denied/i,
  /no such host|not found|NAME_UNKNOWN|does not exist/i,
  /x509|certificate/i,
]

/**
 * 組み立て・push の失敗ログが、レジストリの不調（消えた・認証が古い）を示しているか。
 *
 * **判定を広げすぎないこと。** 本当にコードが悪いときに「レジストリを直せ」と
 * 案内すると、利用者は関係のない操作をさせられる（止めすぎも害である）。
 */
export function looksLikeRegistryProblem(log: string): boolean {
  const t = String(log ?? '')
  if (t.length === 0) return false
  return MARKERS.some(re => re.test(t))
}

/**
 * 「権限が足りない」応答か（2026-08-19）。
 *
 * ── なぜ分けて見るのか ────────────────────────────────────────────────
 * さくらの公式マニュアルは、レジストリの利用者権限をこう定めている:
 *   All        … 新規追加・変更・**削除**・取得・イメージ一覧・イメージ詳細・タグ一覧の取得
 *   Push & Pull… 変更・取得
 *   Pullのみ   … 取得のみ
 *   https://manual.sakura.ad.jp/cloud/appliance/container-registry/index.html
 * Koto が自動作成する push 用ユーザーは **`readwrite`（Push & Pull）** なので、
 * 古いイメージの片づけは**権限不足で断られる可能性が高い**。
 * そのときに「よく分からない失敗」で終わらせず、直し方（コントロールパネルで
 * 権限を All にする）を出せるよう、ほかの失敗と区別する。
 */
export function looksLikePermissionProblem(log: string): boolean {
  const t = String(log ?? '').toLowerCase()
  if (t.length === 0) return false
  return /\b401\b|\b403\b|unauthorized|denied|forbidden|insufficient[_ ]scope/.test(t)
}

/**
 * 「この操作に対応していない」応答か（2026-08-19）。
 *
 * レジストリによっては、イメージの削除そのものを受け付けない設定がある
 * （Docker のレジストリは削除を無効にできる）。権限の問題と取り違えると、
 * 直しようのない案内（権限を上げてください）を出し続けることになる。
 */
export function looksLikeUnsupported(log: string): boolean {
  const t = String(log ?? '').toLowerCase()
  if (t.length === 0) return false
  return /\b405\b|unsupported|not implemented|method not allowed/.test(t)
}
