// deps.ts — 依存ライブラリを持っていけるかを判断する（純ロジック）。
//
// ── なぜ要るか（改善案 1-5）──────────────────────────────────────────
// いままでは `dependencies` があると**正直に断って**いた。だが AI に
// 「フォームを作って」と頼めば `express` を使うコードが出てくるのが自然で、
// **断られた利用者はそこで終わる**。作れないのと同じである。
//
// 内蔵ビルダーは Docker を使わず、`node:22-alpine` の上に**プロジェクトの
// ファイルを1層足す**だけ。だから `npm install` を手元で済ませ、その
// `node_modules` ごと持っていけばよい。
//
// ── 持っていけないもの（正直に断る）────────────────────────────────
// **その場で機械語に翻訳される部品（ネイティブモジュール）は持っていけない。**
// 手元は macOS、公開先は Linux なので、翻訳結果が合わない。黙って持っていくと
// 「公開はできたのに起動しない」になる（今日まで何度も直してきた形）。
// 入れたあとに `.node` ファイルがあれば、それが目印になる。

/** package.json から依存ライブラリの名前を取り出す（純関数）。 */
export function listDependencies(packageJson: unknown): string[] {
  const p = (packageJson ?? {}) as Record<string, unknown>
  const deps = p.dependencies
  if (!deps || typeof deps !== 'object') return []
  return Object.keys(deps as object).filter(n => typeof n === 'string' && n.length > 0).sort()
}

/** 依存ライブラリの扱い。 */
export type DepsPlan =
  /** 依存ライブラリが無い（そのまま持っていける）。 */
  | { kind: 'none' }
  /** 手元で用意してから持っていく。 */
  | { kind: 'install'; names: string[] }

export function planDependencies(packageJson: unknown): DepsPlan {
  const names = listDependencies(packageJson)
  return names.length === 0 ? { kind: 'none' } : { kind: 'install', names }
}

/**
 * そのファイルは「その場で機械語に翻訳された部品」か（純関数）。
 *
 * macOS で作られたものは Linux では動かない。**見つけたら持っていかない。**
 */
export function isNativeBinary(relPath: string): boolean {
  return /\.node$/i.test(String(relPath ?? ''))
}

/** ネイティブ部品のパスから、持ち主のライブラリ名を推測する（純関数）。 */
export function packageOfNative(relPath: string): string {
  const parts = String(relPath ?? '').split('/')
  const i = parts.lastIndexOf('node_modules')
  if (i === -1 || i + 1 >= parts.length) return relPath
  // スコープ付き（@scope/name）は2つ分
  return parts[i + 1].startsWith('@') && i + 2 < parts.length
    ? `${parts[i + 1]}/${parts[i + 2]}`
    : parts[i + 1]
}

/**
 * 持っていけないライブラリを、利用者に伝える文面（純関数）。
 *
 * **どうすればよいかまで書く。** 「動きません」だけでは、そこで終わってしまう。
 */
export function nativeDepsMessage(nativePaths: readonly string[]): string {
  const names = Array.from(new Set((nativePaths ?? []).map(packageOfNative))).sort()
  const head = names.slice(0, 3).join('、') + (names.length > 3 ? ` ほか${names.length - 3}件` : '')
  return `このアプリが使っているライブラリ（${head}）は、お使いのパソコン専用に作られた部品を含んでいます。`
    + '公開先（Linux）ではそのままでは動きません。'
    + 'AIに「このライブラリを使わない作りに直して」と頼むか、'
    + '公開先を「エキスパート（自分の Dockerfile）」に切り替えてください。'
}

/** 用意にかかる時間の目安（純関数・件数から）。 */
export function installTimeNote(count: number): string {
  if (count <= 0) return ''
  if (count <= 5) return '少し時間がかかります（1分ほど）'
  return `時間がかかります（${Math.min(10, Math.ceil(count / 5))}分ほど）`
}
