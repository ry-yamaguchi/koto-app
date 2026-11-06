// feedback.ts — A-2: フィードバック導線（ヘルプメニュー「フィードバックを送る…」）で開く
// GitHub Issues の新規作成URLを組み立てる純粋ロジック（electron/fs 非依存。Vitest で単体テスト可能）。
// APIキー等の秘密情報は一切含めない（バージョン・OSの種別のみを環境情報として自動挿入する）。

// ── 宛先は**公開リポジトリ**（2026-09-16・Ryosuke さんの実機で 404 が出た）────────
// 以前は `ry-yamaguchi/koto`（**非公開**）を指しており、権限の無い人には GitHub が
// 「存在しない」ものとして扱うため **404** になっていた（非公開の存在を隠す作りなので 403 ではない）。
// 配布した Koto を使う人は全員 404 で、フィードバックが1件も届かない状態だった。
// 実測（2026-09-16・匿名で HTTP を叩いた）: `ry-yamaguchi/koto` → 404 ／ `ry-yamaguchi/koto-app` → 302。
// **ここは配布物（koto-app）と同じ、公開されている側でなければならない。**
const FEEDBACK_REPO_URL = 'https://github.com/ry-yamaguchi/koto-app'

// 宛先が公開リポジトリなので、投稿は誰でも読める。書く前に目に入るよう、冒頭の案内文の次の段落に置く。
// 英語の key・token・secret・password は本文に入れない（秘密の形に見える語を雛形に出さない）。
const FEEDBACK_PUBLIC_NOTICE = '※ この投稿は誰でも読めます。パスワード・APIキー・お客様の情報は書かないでください。'

/**
 * Issue本文。冒頭の案内文・公開される旨の注意の下に、区切り線を挟んで環境情報（バージョン・OS）を自動挿入する。
 * `osVersion` は macOS の版（Electron の `process.getSystemVersion()`）。`os.release()` は Darwin のカーネルの版なので渡さない。
 */
export function buildFeedbackBody(version: string, osVersion: string, arch: string): string {
  const envInfo = `Koto v${version} / macOS ${osVersion} (${arch})`
  return `（お気づきの点・不具合・要望をご記入ください）\n\n${FEEDBACK_PUBLIC_NOTICE}\n\n---\n${envInfo}\n`
}

/** GitHub Issues の新規作成URL（body は URLエンコード済み・既定ブラウザで開く想定）。 */
export function buildFeedbackUrl(version: string, osVersion: string, arch: string): string {
  return `${FEEDBACK_REPO_URL}/issues/new?body=${encodeURIComponent(buildFeedbackBody(version, osVersion, arch))}`
}
