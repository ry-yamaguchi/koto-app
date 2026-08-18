// runtimeDetect.ts — プロジェクトを「どう起動するか」を判断する（純ロジック）。
//
// ── なぜ要るか（2026-08-14 実機で発覚）────────────────────────────────
// 内蔵ビルダーは長らく `static` 決め打ちだった。中身は python の http.server で、
// **ファイルを配るだけ**。`server.js` を書いたアプリを公開すると、実行されずに
// ソースの一覧がブラウザに出る。実機でそうなった。
//
// これは永続データ（S-1）の土台を欠いている、という話でもある。`koto-data.js` は
// Node のモジュールなので、**サーバーが動かなければデータの保存は成立しない**。
// 保存場所を用意する導線だけ作っても、それを使えるアプリを公開できなければ意味がない。
//
// ── いまの範囲（2026-08-14）──────────────────────────────────────────
// **依存パッケージの無い Node アプリ**まで。`node_modules` をイメージへ入れる手段が
// まだ無いので、`dependencies` があるものは**動かないと正直に断る**。
// 黙って static で公開すると、また「ソースが丸見え」が起きる。

/** 判断の結果。`unsupported` は「この公開方法では動かせない」＝理由を必ず伝える。 */
export type RuntimeChoice =
  /** 静的配信（HTML/CSS/JS をそのまま配る）。 */
  | { kind: 'static' }
  /** Node で実行する。`entry` は起動するファイル。 */
  | { kind: 'node'; entry: string }
  /** この公開方法では動かせない。`reason` をそのまま画面に出す。 */
  | { kind: 'unsupported'; reason: string }

/** `node ○○.js` の形の start スクリプトから、起動するファイルを取り出す。 */
function entryFromStartScript(script: unknown): string | null {
  if (typeof script !== 'string') return null
  // `node server.js` / `node ./src/index.js` を拾う。`nodemon` や `&&` を含むものは見ない
  const m = /^\s*node\s+([^\s&|;]+)\s*$/.exec(script)
  return m ? m[1].replace(/^\.\//, '') : null
}

/** よくある起動ファイルの名前（この順に探す）。 */
const COMMON_ENTRIES = ['server.js', 'index.js', 'app.js', 'main.js'] as const

/**
 * プロジェクトの見た目から、起動方法を決める（純関数）。
 *
 * @param packageJson 解析済みの package.json（無ければ null）
 * @param fileNames   プロジェクト直下のファイル名
 */
export function detectRuntime(opts: { packageJson: unknown | null; fileNames: readonly string[] }): RuntimeChoice {
  const pkg = opts.packageJson
  const files = new Set(opts.fileNames ?? [])

  // package.json が無ければ、これまでどおり静的配信
  if (!pkg || typeof pkg !== 'object') return { kind: 'static' }
  const p = pkg as Record<string, unknown>

  // ── 依存ライブラリは持っていける（改善案 1-5・2026-08-18）──────────────
  // 以前はここで断っていた（node_modules を入れる手段が無かった）。いまは
  // **手元で用意して層に含める**（main/cloud/npmInstall.ts）。
  // ただし**その場で機械語に翻訳される部品**は Linux で動かないので、
  // 入れたあとに見つけて断る（判断は shared/deps.ts）。ここでは分からない。

  // 起動するファイルを決める: scripts.start → main → よくある名前
  const scripts = p.scripts && typeof p.scripts === 'object' ? (p.scripts as Record<string, unknown>) : {}
  const fromStart = entryFromStartScript(scripts.start)
  const fromMain = typeof p.main === 'string' ? p.main.replace(/^\.\//, '') : null
  const candidates = [fromStart, fromMain, ...COMMON_ENTRIES].filter((x): x is string => !!x)
  const entry = candidates.find(c => files.has(c))

  if (!entry) {
    // package.json はあるのに起動できるファイルが見つからない。**静的だと決めつけない**
    // （決めつけると、また「ソースが丸見え」になる）
    return {
      kind: 'unsupported',
      reason: 'package.json はありますが、起動するファイルが見つかりませんでした。'
        + 'package.json の scripts.start に「node ファイル名」を書くか、server.js を用意してください。',
    }
  }
  return { kind: 'node', entry }
}
