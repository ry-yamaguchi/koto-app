// ── AppRun 系パネルの「折りたたみ」判断の一元化（判断6・7・利用者目線レビュー・2026-09-11）──
//
// AppRunPanel.tsx の③「事前チェック」は、全項目✅なら <details> で1行に畳み、1つでも
// 要確認があれば畳まずに並べる（`preflight.checks.every(c => c.status === 'ok')`）。
// この画面はこの型を「同じ型を横展開する」よう指示された（新しいUI部品は作らない）——
// ④セキュリティチェック・⑤未使用ファイル・ビルド方式のトグル・②公開の設定の要約、いずれも
// 判断そのものは③と同じ形（全部✅／既定のまま／常時表示する項目、を1箇所で決める）。
//
// 判断を各コンポーネント（SecurityCheckSection.tsx・UnusedFilesSection.tsx・
// AppRunPanel.tsx）に別々に書くと、片方だけ直されて食い違う事故が起きる（掟10）。
// ここに集め、tests/appRunFolding.test.ts で固定する。

/** ④セキュリティチェックの判定（SecurityCheckResult.verdict の最小形）。 */
export type FoldSecurityInput = { verdict: 'ok' | 'warn' | 'skip' } | null | undefined

/**
 * ④セキュリティチェックを1行に畳んでよいか。
 *
 * 全部✅（verdict==='ok'）のときだけ畳む。要確認（'warn'）はもちろん、
 * 実施できなかった（'skip'）ときも畳まない——「畳む」は「安心して読み飛ばしてよい」の意味なので、
 * 確認できていないものを畳むと見落としにつながる。未実行（null/undefined）も同様に畳まない
 * （そもそも結果が無いので「従来どおり」＝何も出さない）。
 */
export function foldSecurity(result: FoldSecurityInput): boolean {
  return !!result && result.verdict === 'ok'
}

/** ⑤未使用ファイルの検出結果（最小形）。 */
export type FoldUnusedInput = { supported: boolean; unused: readonly string[] } | null | undefined

/**
 * ⑤未使用ファイルの節を1行に畳んでよいか。
 *
 * 対象外（supported===false）・未実行（null/undefined）のときは畳まない（従来どおり、
 * 理由をそのまま出す）。未使用ファイルが1件でもあれば（＝要確認）畳まない。
 * 0件（＝問題なし）のときだけ畳む——④と同じ「全部✅→畳む」の判断。
 */
export function foldUnused(result: FoldUnusedInput): boolean {
  if (!result || !result.supported) return false
  return result.unused.length === 0
}

/** ⑥ビルド方式（標準／Docker）。env.json が読めていない等で分からないときは 'builtin' 扱い（安全側）。 */
export type BuildMode = 'builtin' | 'docker' | null | undefined

/**
 * ビルド方式の節を畳んでよいか。
 *
 * 既定（標準＝builtin）のときは畳む（「詳細: ビルド方式（標準）」の1行）。
 * Docker を選んでいるときは、Dockerfile の有無など確かめてほしい情報が増えるため展開したまま
 * にする。分からないとき（null/undefined）は既定（標準）と同じ扱いにする——
 * 「Docker を選んでいる」と確信できないものを展開側（＝手間が増える側）に倒さない。
 */
export function foldBuildMode(mode: BuildMode): boolean {
  return mode !== 'docker'
}

/**
 * ②公開の設定（SpecSummary）で、常時表示する項目名とその順序。
 *
 * 残り（実行環境・地域・サービス設定・ポート等）は「詳細を見る」の <details> に入れる。
 * ここを1箇所にしておくことで、「どれを常時表示にするか」を JSX 側と切り離してテストできる
 * （tests/appRunFolding.test.ts の変異試験(c): この配列から「保存場所」を落とすと検知する）。
 */
export function specSummaryPrimaryKeys(): readonly string[] {
  return ['公開名', '起動のしかた', '保存場所', '期限']
}
