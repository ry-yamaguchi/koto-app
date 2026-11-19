// 「何がどこへ送られるか」の一文（画面と案内が同じ文を使うための定数。文の書き換えはここだけ）。
// 保持期間・学習への利用など、確かめていないことは書かない。

/** さくらのAI Engine へ送るもの（ようこその APIキー登録の画面）。 */
export const AI_ENGINE_SEND_NOTE = 'ファイルの内容と指示が、さくらのAI Engine に送られます。'

/** Web 検索のカード（Tavily・Brave へ送るもの）。 */
export const WEB_SEARCH_SEND_NOTE = '質問から作った検索語が、Tavily または Brave に送られます。'

/** ライブラリの脆弱性の照会（🛡 の節・設定）。 */
export const OSV_SEND_NOTE = 'ライブラリの名前とバージョンが、脆弱性データベース OSV.dev に送られます。'
