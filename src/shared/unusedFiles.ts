// unusedFiles.ts — 「どこからも参照されていないファイル」を見つける（純ロジック）。roadmap #18。
//
// ── 設計判断: なぜ参照グラフではなく「出現判定」か（2026-09-03 Ryosuke と合意） ─────────
// これは「ファイルを動かす」提案の土台になる判定なので、**誤る方向をどちらに倒すか**が
// 何より大事である。真の到達グラフ（HTMLのhref/src・CSSのurl()・JSのimportだけを厳密に
// 辿る）は精度が高そうに見えて、実際には次のような正当な参照を取りこぼしやすい:
//
//   ・JS がテンプレート文字列やフレームワークの書き方でパスを組み立てる（`img/${name}.png`）
//   ・CSS の `@import` やフォントの `src: url()` の書き方の揺れ
//   ・コメント・設定ファイル・README からしか指されていない「今は外している資材」
//
// 取りこぼすと「使っているファイルを使っていないと言い張る」ことになり、利用者が押すと
// **壊れる**。逆に「本当は使っていないのに使用中と言う」誤りは、単に片づけの提案が
// 1件減るだけで実害が無い。だから**控えめな判定**（そのファイルへの参照らしき文字列が
// テキスト系ファイルのどこかに1回でも出現すれば「使用中」）を採用し、誤検知は
// 「未使用と言いすぎない」側にだけ倒す。真の到達グラフは将来の改善余地として残す。
//
// このモジュールは fs/electron/DOM に依存しない純粋な定義のみ（renderer からも main からも使える）。

/**
 * 参照が無くても要る慣習ファイル（常に「使用中」扱いにする）。
 *
 * ブラウザ・検索エンジン・OS がファイル名の**約束**として直接探しにいくもの
 * （`index.html` はどの階層でも・`favicon.ico`・`robots.txt` 等）や、
 * ビルド・デプロイの設定として実体はあってもコードから参照されないもの
 * （`Dockerfile`・`nginx.conf`・`.htaccess`）を含む。`.well-known/` 配下は
 * 各種サービス連携（Apple Pay・ドメイン所有確認等）が既定のパスとして直接読むため、
 * 中身のファイル名を問わず配下すべてを対象にする。
 */
// 2026-09-04 追加: 検索エンジンのサイト所有確認ファイル（google<英数>.html・BingSiteAuth.xml）と
// 広告の管理ファイル（ads.txt / app-ads.txt）。いずれも「コードからは参照されないが、
// 外部のクローラーが決まった名前で直接読みにくる」正当なファイル。こうした慣習ファイルは
// 種類が有限なので、利用者に「外部利用マーク」のような新しい概念を課すのではなく、
// この許可リストで吸収する（Ryosuke と合意）。
export const ALWAYS_USED_RE =
  /(^|\/)(index\.html|404\.html|favicon\.ico|robots\.txt|sitemap\.xml|manifest\.json|apple-touch-icon[^/]*|og[^/]*\.(?:png|jpe?g)|CNAME|\.htaccess|nginx\.conf|Dockerfile|\.dockerignore|ads\.txt|app-ads\.txt|google[0-9a-z]+\.html|BingSiteAuth\.xml)$|(^|\/)\.well-known\//i

/** 中身を「参照コーパス」に使うテキスト系の拡張子（バイナリは読まない）。 */
const TEXT_EXTS = new Set([
  'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'json', 'svg', 'md', 'txt', 'xml', 'webmanifest',
])

/** 相対パスの最後の段（ファイル名だけ）。 */
function basenameOf(rel: string): string {
  const parts = String(rel ?? '').split('/')
  return parts[parts.length - 1] ?? rel
}

/** 拡張子（小文字・ドット無し）。無ければ空文字。 */
function extOf(rel: string): string {
  const base = basenameOf(rel)
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}

/**
 * そのファイルを指すときにコード上へ現れうる形（小文字化済み・重複は除く）。
 *
 * 相対パスそのもの・ファイル名（basename）、そしてそれぞれの `encodeURI` /
 * `encodeURIComponent` 形を候補にする。**日本語ファイル名は URL エンコードされて
 * 書かれることが多い**ため（`encodeURI` は `/` を残すので相対パス側で特に効く）、
 * ここを見ないと日本語ファイル名の参照を軒並み「未使用」と誤判定してしまう。
 */
function referenceForms(rel: string): string[] {
  const base = basenameOf(rel)
  const forms = new Set<string>()
  for (const s of [rel, base]) {
    forms.add(s)
    try { forms.add(encodeURI(s)) } catch { /* エンコードできない文字はそのまま無視 */ }
    try { forms.add(encodeURIComponent(s)) } catch { /* 同上 */ }
  }
  return Array.from(forms, f => f.toLowerCase())
}

/**
 * どこからも参照されていなさそうなファイルを探す。
 *
 * @param files    候補ファイル（プロジェクト相対パス。走査済みの一覧をそのまま渡す）
 * @param readText テキスト系ファイルの中身を返す（読めない・バイナリ等は null）。
 *                 呼び出し側（IO）が実際の読み込みを行う。
 * @returns 未使用と判定したファイル（`files` の並び順を保つ）
 */
export function findUnusedFiles(
  files: readonly string[],
  readText: (rel: string) => string | null,
): string[] {
  // 参照コーパスはファイルごとに持つ（1本の文字列へ結合しない）。
  // **自分自身の中身は、自分の使用判定に使わない**（自分の名前を含むコメント等で
  // 「自分自身に使われている」という無意味な使用中判定になるのを防ぐ）ため、
  // 判定のたびに「自分以外」を対象にする必要があり、ファイル単位で持つのが自然。
  const texts: { rel: string; lower: string }[] = []
  for (const rel of files) {
    if (!TEXT_EXTS.has(extOf(rel))) continue
    const content = readText(rel)
    if (content == null) continue
    texts.push({ rel, lower: content.toLowerCase() })
  }

  const unused: string[] = []
  for (const rel of files) {
    if (ALWAYS_USED_RE.test(rel)) continue
    const forms = referenceForms(rel)
    const used = texts.some(t => t.rel !== rel && forms.some(f => t.lower.includes(f)))
    if (!used) unused.push(rel)
  }
  return unused
}

/** 拡張子を最後のドットで分ける（nextFreeMaterialName 専用）。
 *  先頭にしかドットが無い名前（`.htaccess` 等）・末尾がドットの名前（`foo.`）は、
 *  「ドットの後ろ」を切り出すと空文字や不自然な分割になるため、全体を stem として扱う。 */
function splitExt(name: string): { stem: string; ext: string } {
  const i = name.lastIndexOf('.')
  if (i <= 0 || i === name.length - 1) return { stem: name, ext: '' }
  return { stem: name.slice(0, i), ext: name.slice(i) }
}

/**
 * 素材置き場（MATERIALS_DIR）へ移すときの、空いているファイル名を1つ選ぶ。
 *
 * ── なぜ要るか（2026-09-04 実機で判明・未使用ファイルの移動が一括で失敗する不具合） ──────
 * 移動先は MATERIALS_DIR 直下の平置き。以前の ipc/unused.ts は
 *   ①素材置き場に既に同名がある ②同じ一括の中で basename が重複する
 * のどちらも throw で**一括全体を拒否**していた（migrate.ts の「同名衝突は全体を中止する」
 * 方針をそのまま踏襲したもの）。ところが実機では、以前 Koto で移動した test002 が
 * 素材置き場に残っているというだけで、**新しい test002 を二度と移動できなくなった**
 * （しかも他の対象まで巻き添えで拒否される）。migrate.ts の「取り込み前のプロジェクトを
 * 壊さない」場面と違い、ここは Koto 自身が用意した置き場所への移動なので、
 * 全体を止めるのではなく**空いている名前を自動で採る**ほうが利用者の意図（未使用ファイルを
 * どかしたい）に合う。
 *
 * base をそのまま試し、埋まっていれば「stem-2.ext」「stem-3.ext」… と最初に空いている名前を
 * 返す。呼び出し側（ipc/unused.ts）はこれで採った名前を移動先に使い、base と違えば
 * 利用者に「改名しました」と伝える。
 *
 * @param base    素材置き場に置きたいファイル名（basename。拡張子込み）
 * @param isTaken その候補名が既に使われているか（呼び出し側が、同じ一括内で予約済みの名前と
 *                実ディスクの両方を見て判定する）
 * @returns 実際に採用する名前（衝突が無ければ base そのまま）
 * @throws 999件試しても空きが無いとき（実運用では起こらない想定。決定性のため
 *         `Date.now()` などのフォールバックは使わない——同じ入力なら常に同じ結果にする）
 */
export function nextFreeMaterialName(base: string, isTaken: (name: string) => boolean): string {
  const LIMIT = 999
  const { stem, ext } = splitExt(base)
  for (let n = 1; n <= LIMIT; n++) {
    const candidate = n === 1 ? base : `${stem}-${n}${ext}`
    if (!isTaken(candidate)) return candidate
  }
  throw new Error(`「${base}」の空いている名前が見つかりませんでした（${LIMIT}件まで試しました）`)
}
