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
