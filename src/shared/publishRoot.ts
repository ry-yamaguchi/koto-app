// publishRoot.ts — 公開されるものを入れるフォルダ（`public`）がどこかを決める、たった1つの場所。
//
// ── なぜ1箇所にするか（2026-08-20 Ryosuke と設計）──────────────────────
// この製品は「公開経路の一部だけ直して穴が空く」事故を**3回**起こしている
// （2026-08-05 `.sakuraide` 流出 / 2026-08-09 `.env` 流出 / 2026-08-14 `.sakuraide.json` 焼き込み）。
// いずれも「一元化したモジュールがあるのに、呼ぶ側が部分的に使った」形だった（掟10）。
//
// 公開の根を変える今回は、同じ形の事故がいちばん起きやすい。だから
// **公開・実行・検査のすべての起点をこの関数に通し、
//   「全経路が同じ根を見ている」ことをテストで固定してから**中身を移す。
//
// ── 名前について（2026-08-20 に2度変えた）──────────────────────────────
// ① `公開されるもの` … 「誰でも読める」と読めるので不可。`Dockerfile` は
//    **サーバーへ行くが読まれてほしくない**（0.3.38 で配信から外した）。
//    画面の見出し「公開されるもの／公開されないもの」とも入れ子になって意味不明。
// ② `サーバーに置くもの` … 意味は良いが**日本語**。Ryosuke の懸念どおり、
//    手でシェルを叩くときに面倒で、将来ツールを増やしたときの地雷が残る
//    （実測では NFC で `===` も通り、Koto の中では壊れなかった。
//     ZIP・rsync・イメージは**フォルダの中で**動くので日本語は `cd` にしか出ない。
//     それでも「安全なほうを選べる場面で選ばない理由が無い」と判断した）。
// ③ **`public`** … ASCII で完全に安全。そして**Koto には既に `public/` の約束がある**
//    （レンタルサーバ経路は `public/` があればそこを `~/www` へ送る／
//     新規プロジェクトの指示にも「サイト一式を public/ に置く」と書いてある）。
//    別名を作ると**同じ意味のものが2つ**になるので、こちらへ一本化した。
//
// **利用者が読むのは日本語のまま。** 画面には「公開されるもの／公開されないもの」と出す。
// 相棒の `素材（公開しません）` は既に配られているのでそのまま（改名は別の移行になる）。
//
// ── 後方互換 ──────────────────────────────────────────────────────────
// フォルダが無ければ**プロジェクト直下**を根として扱う（＝移行前のプロジェクト）。
// これを外すと、しばらく開いていないプロジェクトが公開できなくなる。
// 新旧の違いは**この関数の中の1分岐**に封じ込める。

/** 公開されるものを入れるフォルダ名。**ASCII にすること**（上のコメント参照）。 */
export const PUBLISH_DIR = 'public'

/**
 * **画面に出すときの言い方。**
 *
 * フォルダ名は ASCII（`public`）だが、**利用者が読むのは日本語**（掟: UI文言は日本語）。
 * 名前そのものより「何のフォルダか」が伝わるほうが大事なので、意味を先に置く。
 * **AI へ渡す指示には使わないこと**——AI はパスを書くので、`PUBLISH_DIR` の生の名前が要る。
 */
export const PUBLISH_DIR_LABEL = `公開されるもの（${PUBLISH_DIR}）`

/**
 * 公開・実行・検査の起点（プロジェクト直下からの相対パス）。
 * `''` は「プロジェクト直下そのもの」を意味する（移行前）。
 *
 * @param hasPublishDir `<project>/public` が存在するか（呼び出し側が調べて渡す）
 */
export function publishRootRel(hasPublishDir: boolean): string {
  return hasPublishDir ? PUBLISH_DIR : ''
}

/**
 * 公開・実行・検査の起点（絶対パス）。
 *
 * @param projectDir     プロジェクトの絶対パス
 * @param hasPublishDir  `<project>/public` が存在するか
 * @param sep            パス区切り（既定 `/`。Windows 対応の余地を残すためだけ）
 */
export function publishRoot(projectDir: string, hasPublishDir: boolean, sep = '/'): string {
  const base = String(projectDir ?? '').replace(/[/\\]+$/, '')
  if (!base) return ''
  return hasPublishDir ? `${base}${sep}${PUBLISH_DIR}` : base
}

/** すでに移行済みか（＝根がプロジェクト直下ではないか）。 */
export function isMigrated(projectDir: string, hasPublishDir: boolean): boolean {
  return publishRoot(projectDir, hasPublishDir) !== String(projectDir ?? '').replace(/[/\\]+$/, '')
}

/**
 * 移行で`public/` へ移す対象か。
 *
 * **公開されるものだけを移す。** 素材・Koto の内部・README などは直下に残す。
 * 判定そのものは publishExclude.ts の `isPublished` に任せる（**手で並べ直さない**・掟10）。
 *
 * @param isPublishedName `isPublished(name, isDir)` の結果
 */
export function shouldMove(name: string, isPublishedName: boolean): boolean {
  if (!name || name === PUBLISH_DIR) return false // 自分自身は移さない
  return isPublishedName
}

/** 相対パスのいちばん上の段（`public/index.html` → `public`）。 */
export function topSegment(relPath: string): string {
  const clean = String(relPath ?? '').replace(/^\.?\//, '').replace(/\\/g, '/')
  return clean.split('/')[0] ?? ''
}

/**
 * 新しく作るファイルを、根の中に置くか外に置くか。
 *
 * **移行（shouldMove）とまったく同じ判断を使う。** 別々に書くと必ずずれて、
 * 「新しく作ったプロジェクトだけ形が違う」ことになる（掟10）。
 *
 * @param relPath          プロジェクト直下からの相対パス
 * @param isPublishedTop   いちばん上の段について `isPublished()` を評価した結果
 */
export function placeInProject(relPath: string, isPublishedTop: boolean): string {
  const clean = String(relPath ?? '').replace(/^\.?\//, '').replace(/\\/g, '/')
  if (!clean) return ''
  return shouldMove(topSegment(clean), isPublishedTop) ? `${PUBLISH_DIR}/${clean}` : clean
}
