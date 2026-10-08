// memoryKeep.ts — 「入力されたデータを、メモリ（変数・配列）だけに持つ形」を見つける（純ロジック）。
//
// ── なぜ要るのか（2026-10-01 rc.5 の実機）──────────────────────────────
// 「名前を入れると一覧に出る簡単なアプリを作って」と頼んで公開したところ、AI が作った
// server.js は、トップレベルの `const names = []` に `names.push(...)` で入力を持つだけ
// だった（ファイルにも koto-data にも書かない）。再起動や公開し直しで名前が消えるのに、
// ③公開の画面には保存場所の案内が**一切出なかった**。
// 判定（storageNeed.ts）は「koto-data を使う」「ファイルに書く」の2つしか見ておらず、
// メモリだけに持つ形は何も無い扱い（kind 'none'）になっていたため。
//
// ── 判定の中身 ────────────────────────────────────────────────────────
// 次の2つが**同じファイルに揃ったときだけ**拾う（宣言だけ・読むだけは拾わない）。
//   (1) サーバー側のコードらしいファイルである（`looksLikeServerCode`。印の無いファイルでも、
//       印のあるファイルから読み込まれていればサーバー側・下の「数えないもの」の3つ目）
//   (2) トップレベル（字下げなし）に `const|let|var 名前 = [ … | { … | new Map|Set|Array` があり
//       （**空でなくてもよい**。見本データ入りの配列・`{ cat: 0, dog: 0 }` のような入れ物も同じ）、
//       **同じ名前を書き換える箇所**（`.push(` `.unshift(` `.splice(` `.set(` `.add(`／
//       `名前[…] =`／`名前.x =`／`名前[…]++`／`let`・`var` の再代入）がある（`memoryKeepLines`）
//
// ブラウザ側の JS はサーバーの印が無いので拾わない（画面の中の配列は、そもそも
// 公開先のサーバーが持つデータではない）。
//
// ── 数えないもの（2026-10-01 検分で足した）──────────────────────────────
// ・**起動時に1度だけ走る書き換え**（字下げの無い行で、関数の境目 `=>` / `function` を含まないもの。
//   `settings.port = …`・`allowedOrigins.push(…)` のような設定の組み立て）
// ・**名前が「持たせるデータ」ではないと分かるもの**（`cache`・`rate`・`limit`・`clients`・
//   `connections`・`sockets`・`timers` など。回数制限・キャッシュ・接続の一覧は、消えてよい）
// ・サーバーの印の無いファイルは、**サーバーの印のあるファイルから読み込まれていないかぎり**
//   サーバー側とみなさない（読み込まれていれば数える。`lib/store.ts` に入れ物を分けた形。
//   この判断は走査側・`serverReachableFiles`。`memoryKeepLines` は `assumeServer` を渡されたときだけ印を問わない）
//
// ── 誤検知の扱い（writesFilesDirectly と同じ手法に揃える）────────────────
// コメントの中・文字列の中は**取り除かず、本文全体に正規表現を当てる**（fileWriteLines と同じ）。
// 字下げなしの行だけを宣言として見るので、`// const a = []` のようなコメントは宣言に数えない。
// 「推定」である前提で、画面は断定せず「持っているようです」と言う（storageNeed.ts）。
//
// ── どこが使うか ──────────────────────────────────────────────────────
// 走査は main の `scanDataUsage`（src/main/dataLayer.ts）。**ファイルを歩く処理は1つだけ**で、
// 除外（node_modules・koto-data.js/.cjs・.koto-data・Koto が置くファイル）は
// 既存の writesFiles と**同じ名簿・同じ場所**で効く。ここは本文を読むだけ。

/** サーバー側の部品の名前（読み込みの文字列として現れるもの）。 */
const SERVER_MODULE = String.raw`(?:node:)?(?:express|http|https|http2|fastify|koa|hono(?:\/[\w-]+)?|@hono\/node-server|ws|socket\.io)`

/**
 * 「サーバー側のコードらしい」印。**1つでも当たればサーバー側とみなす。**
 *
 * ・フレームワーク／http の読み込み（import・require・動的 import）
 * ・`createServer(`・`.listen(`（待ち受け）
 * ・Vercel のサーバーレス関数の形（`export default function handler`、`export async function GET|POST …`）
 * ・Next.js の Server Actions（ファイルの先頭の `'use server'`）
 * ・WebSocket サーバー（`new WebSocketServer(`・`ws` / `socket.io` の読み込み）
 */
const SERVER_MARKERS: readonly RegExp[] = [
  new RegExp(String.raw`\bfrom\s+['"]${SERVER_MODULE}['"]`),
  new RegExp(String.raw`\brequire\(\s*['"]${SERVER_MODULE}['"]\s*\)`),
  new RegExp(String.raw`\bimport\(\s*['"]${SERVER_MODULE}['"]\s*\)`),
  /\bcreateServer\s*\(/,
  /\.\s*listen\s*\(/,
  // Vercel のサーバーレス関数（Node 形式・Web 標準形式）
  /\bexport\s+default\s+(?:async\s+)?function\s+handler\b/,
  /\bexport\s+default\s+(?:async\s+)?(?:function\b[^(\n]*)?\(\s*(?:req|request)\b/,
  /\bexport\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(/,
  /\bexport\s+const\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*=/,
  /\bmodule\s*\.\s*exports\s*=\s*(?:async\s+)?(?:function\b[^(\n]*)?\(\s*req\b/,
  // Next.js の Server Actions（ファイルの先頭の指示。二重引用符も）
  /^\s*['"]use server['"]/m,
  /\bnew\s+WebSocketServer\s*\(/,
]

/** このソースは、サーバー側のコードらしいか（純関数）。 */
export function looksLikeServerCode(sourceText: string): boolean {
  const t = String(sourceText ?? '')
  if (t.length === 0) return false
  return SERVER_MARKERS.some(re => re.test(t))
}

/**
 * トップレベル（字下げなし）の宣言。`const|let|var 名前 = [ … | { … | new Map|Set|Array`。
 *
 * **中身は問わない**（2026-10-01 検分）。空の `[]` だけに絞ると、AI がよく書く
 * 見本データ入りの配列（`let todos = [{ id: 1, … }]`）・入れ物（`const db = { users: [], posts: [] }`）・
 * 投票の数（`const votes = { cat: 0, dog: 0 }`）・初期値つきの Map を、再起動で消えるのに拾えない。
 * 宣言だけでは拾わない（同じ名前の書き換えが要る）ので、広げても読むだけのものは警告しない。
 *
 * TypeScript の型注釈（`: Item[]`）と総称（`new Map<string, number>()`）も読む。
 * `export` が付いていてもトップレベルである。
 */
const TOP_LEVEL_DECL =
  /^(?:export\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:\[|\{|new\s+(?:Map|Set|Array)\b)/gm

/** 代入の演算子（`=` `+=` `||=` など）。`==` `===` `=>` は含めない。 */
const ASSIGN = String.raw`(?:[-+*/%&|^]|\*\*|<<|>>>?|&&|\|\||\?\?)?=(?![=>])`

/** 正規表現に埋め込む名前の逃がし（`$` を含む識別子がありうる）。 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 持ち物をたどる1歩（`.x` または `[…]`）。`db.posts[0].title` のように何歩でも続く。 */
const PATH_STEP = String.raw`(?:\s*\.\s*[A-Za-z_$][\w$]*|\s*\[[^\]\n]*\])`

/**
 * 名前の中に現れると「**持たせるデータではない**」と分かる言葉（小文字・語単位）。
 *
 * 回数制限の記録・キャッシュ・接続の一覧は、再起動で消えてよい（むしろ消えるのが普通）。
 * これを「入力されたデータがメモリだけにある」と数えると、**保存の要らないアプリに
 * 「データが消えます」と言い、AI に書き直させて壊す**（SSE の接続 `res` を保存しようとする、など）。
 * 名前で当てる**弱い策**だが、誤検知の害（月額の保存場所の案内まで出る）が大きい側を抑える。
 * `memo` `sessions` `queue` は入れない（メモ帳アプリの本体・ログイン状態・待ち行列は消えると困る）。
 */
const NON_DATA_WORDS: ReadonlySet<string> = new Set([
  'cache', 'caches', 'cached', 'rate', 'ratelimit', 'ratelimits', 'ratelimiter', 'limit', 'limits', 'limiter',
  'hits', 'connections', 'sockets', 'timers',
])

/**
 * `clients` は2つの意味で使われる。SSE・WebSocket の**接続の一覧**（`const clients = new Set()` に `.add(res)`）と、
 * **顧客の一覧**（`const clients = []` に `.push({ name, company })`）。後者は消えると困るので、
 * NON_DATA_WORDS には入れず、**`new Set()` で宣言したときだけ**接続の一覧として外す（2026-10-01 検分2巡目）。
 */
const CONNECTION_SET_WORDS: ReadonlySet<string> = new Set(['clients'])

/** 識別子を語に割る（`rateLimitMap` → rate / limit / map、`SSE_CLIENTS` → sse / clients）。 */
function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(w => w.length > 0)
    .map(w => w.toLowerCase())
}

/** この名前は「持たせるデータ」ではないか（キャッシュ・回数制限・接続の一覧など・純関数）。 */
export function isNotUserDataName(name: string): boolean {
  return wordsOf(String(name ?? '')).some(w => NON_DATA_WORDS.has(w))
}

/**
 * ある名前を**書き換える**形の正規表現を作る。
 *
 * ・`名前.push(` `.unshift(` `.splice(` `.set(` `.add(`（入れ子の持ち物 `db.posts.push(` も）
 * ・`名前[…] = …`・`名前.x = …`（`名前.x[…].y = …` のように、何歩たどっても）
 * ・`名前[…]++`・`名前.x--`・`++名前[…]`（投票の数を増やす形。`=` が無い）
 * ・`let`・`var` で宣言した名前への再代入 `名前 = …`（`const` は再代入できないので見ない）
 *
 * `(?<![\w$.])` は「別の名前の一部」「別の物の持ち物（`this.names` など）」を除く。
 * 再代入では、宣言そのもの（`let 名前 = []`）を書き換えと数えないよう、直前の
 * `const|let|var` も除く。
 */
function writePatterns(name: string, canReassign: boolean): RegExp[] {
  const n = escapeRe(name)
  const id = String.raw`(?<![\w$.])${n}(?![\w$])`
  const ps = [
    String.raw`${id}${PATH_STEP}*\s*\.\s*(?:push|unshift|splice|set|add)\s*\(`,
    String.raw`${id}${PATH_STEP}+\s*${ASSIGN}`,
    String.raw`${id}${PATH_STEP}+\s*(?:\+\+|--)`,
    String.raw`(?:\+\+|--)\s*${id}${PATH_STEP}+`,
  ]
  if (canReassign) ps.push(String.raw`(?<!\b(?:const|let|var)\s+)${id}\s*${ASSIGN}`)
  return ps.map(p => new RegExp(p, 'g'))
}

/**
 * 起動時に1度だけ走る行か（純関数）。**書き換えの数に入れない。**
 *
 * 字下げが無く、関数の境目（`=>`・`function`）も含まない行は、リクエストのたびに走る処理の中ではなく、
 * ファイルの読み込み時に1度だけ走る文である。`settings.port = process.env.PORT`・
 * `if (process.env.FRONTEND_URL) allowedOrigins.push(…)` のような**設定の組み立て**を
 * 「入力されたデータをメモリに持っている」と数えない（入力ではないので、消えても困らない）。
 * 1行に書いたハンドラ（`app.post('/', (req, res) => { names.push(…) })`）は `=>` があるので数える。
 */
function runsOnlyAtStartup(lineText: string): boolean {
  return !/^\s/.test(lineText) && !/=>|\bfunction\b/.test(lineText)
}

/**
 * 入力をメモリだけに持っていそうな箇所の行番号（**1始まり**・書き換えている行）を返す
 * （純関数）。無ければ空配列。**サーバー側のコードらしくないものは、既定では空。**
 *
 * @param opts.assumeServer 真なら、サーバーの印の有無を問わず判定する。**走査側だけが使う**——
 *   サーバーの印のあるファイルから読み込まれている別のファイル（`lib/store.ts`・`store.js`）は、
 *   自分に印が無くてもサーバー側なので（`serverReachableFiles`）、その判断を走査が下してから呼ぶ。
 *
 * 行番号は `fileWriteLines`（objectStorage.ts）と同じく「一致の開始位置の行」。
 */
export function memoryKeepLines(sourceText: string, opts?: { assumeServer?: boolean }): number[] {
  const t = String(sourceText ?? '')
  if (t.length === 0) return []
  if (opts?.assumeServer !== true && !looksLikeServerCode(t)) return []

  // 宣言を集める（同じ名前を2回宣言していたら、どれかが let/var なら再代入を見る）
  const decls = new Map<string, { canReassign: boolean }>()
  const declRe = new RegExp(TOP_LEVEL_DECL.source, TOP_LEVEL_DECL.flags)
  let m: RegExpExecArray | null
  while ((m = declRe.exec(t)) !== null) {
    const name = m[2]
    if (m.index === declRe.lastIndex) declRe.lastIndex++
    // キャッシュ・回数制限・接続の一覧は、消えてよい（NON_DATA_WORDS）
    if (isNotUserDataName(name)) continue
    if (/=\s*new\s+Set\b/.test(m[0]) && wordsOf(name).some(w => CONNECTION_SET_WORDS.has(w))) continue
    const canReassign = m[1] !== 'const'
    const prev = decls.get(name)
    decls.set(name, { canReassign: canReassign || prev?.canReassign === true })
  }
  if (decls.size === 0) return []

  // 行頭の位置の表（一致の位置 → 行番号を、本文を何度も数え直さずに出す）
  const lineStarts: number[] = [0]
  for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 10) lineStarts.push(i + 1)
  const lineOf = (index: number): number => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= index) lo = mid
      else hi = mid - 1
    }
    return lo + 1 // 1始まり
  }
  const lineTextOf = (line: number): string =>
    t.slice(lineStarts[line - 1], line < lineStarts.length ? lineStarts[line] - 1 : t.length)

  const found = new Set<number>()
  for (const [name, { canReassign }] of decls) {
    for (const re of writePatterns(name, canReassign)) {
      let w: RegExpExecArray | null
      while ((w = re.exec(t)) !== null) {
        if (w.index === re.lastIndex) re.lastIndex++ // 空一致で止まらないように
        const line = lineOf(w.index)
        if (runsOnlyAtStartup(lineTextOf(line))) continue // 起動時の設定の組み立て
        found.add(line)
      }
    }
  }
  return [...found].sort((a, b) => a - b)
}

// ── サーバーの印が無いファイルの扱い（2026-10-01 検分）──────────────────────────
// データの入れ物を別のファイル（`lib/store.ts`・`store.js`・`routes.js`）に分けると、そのファイルには
// サーバーの印（express の読み込み・`.listen(`）が無いので、ファイルごとの判定では拾えない。
// Next.js の `lib/data.ts` に入れ物を置く形は、AI が Next.js を書くときの定番である。
// **サーバーの印のあるファイルから（直接・間接に）読み込まれているファイルは、サーバー側**とみなす。
// 歩く処理は走査（src/main/dataLayer.ts）の1つだけで、ここは読み込みの解決だけを持つ（純関数）。

/** 走査したファイル1つぶん（相対パス・サーバーの印があるか・読み込んでいる先の書き方）。 */
export type ScannedSource = { file: string; server: boolean; imports: readonly string[] }

const IMPORT_SPEC_RES: readonly RegExp[] = [
  /\bfrom\s+['"]([^'"\n]+)['"]/g,
  /\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /^\s*import\s+['"]([^'"\n]+)['"]/gm,
]

/**
 * ソースが読み込んでいる**自分のプロジェクトのファイル**の書き方（`./store`・`../lib/store`・
 * `@/lib/store`・`~/lib/store`）を集める（純関数）。パッケージ名（`express` など）は含めない。
 */
export function localImportSpecs(sourceText: string): string[] {
  const t = String(sourceText ?? '')
  const out = new Set<string>()
  if (t.length === 0) return []
  for (const re0 of IMPORT_SPEC_RES) {
    const re = new RegExp(re0.source, re0.flags)
    let m: RegExpExecArray | null
    while ((m = re.exec(t)) !== null) {
      if (/^(?:\.{1,2}(?:\/|$)|[@~]\/)/.test(m[1])) out.add(m[1])
    }
  }
  return [...out]
}

const RESOLVE_EXTS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'] as const

/** `dir` からの相対 `rel` をたどる。プロジェクトの外へ出たら null。 */
function joinWithin(dir: readonly string[], rel: string): string | null {
  const parts = [...dir]
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else {
      parts.push(seg)
    }
  }
  return parts.join('/')
}

/**
 * 読み込みの書き方（`spec`）が、走査したどのファイルを指すかを決める（純関数）。見つからなければ null。
 *
 * ・`./x` `../x` は、読み込む側のファイルの場所から
 * ・`@/x` `~/x`（Next.js の別名）は、プロジェクトの直下か `src/` から
 * 拡張子の省略（`./store`）・`index` の省略（`./lib`）・TypeScript で `.js` と書いて `.ts` を指す形を読む。
 *
 * @param known 走査したファイル（正規化した相対パス → 走査で使った相対パス）
 */
export function resolveLocalImport(fromFile: string, spec: string, known: ReadonlyMap<string, string>): string | null {
  const bases: string[] = []
  if (spec.startsWith('.')) {
    const dir = fromFile.replace(/\\/g, '/').split('/').slice(0, -1)
    const b = joinWithin(dir, spec)
    if (b !== null) bases.push(b)
  } else if (spec.startsWith('@/') || spec.startsWith('~/')) {
    const rest = spec.slice(2)
    for (const root of [[], ['src']]) {
      const b = joinWithin(root, rest)
      if (b !== null) bases.push(b)
    }
  }
  for (const base of bases) {
    const stem = base.replace(/\.(?:m|c)?jsx?$/, '') // './store.js' と書いて store.ts を指す形
    const tries = [
      base,
      ...RESOLVE_EXTS.map(e => base + e),
      ...RESOLVE_EXTS.map(e => stem + e),
      ...RESOLVE_EXTS.map(e => `${base}/index${e}`),
    ]
    for (const c of tries) {
      const hit = known.get(c)
      if (hit !== undefined) return hit
    }
  }
  return null
}

/**
 * サーバー側とみなすファイルの集まり（純関数）。**サーバーの印のあるファイル自身と、そこから
 * 直接・間接に読み込まれているファイル。**（印の無いファイルのメモリの判定を、走査が通してよいか）
 */
export function serverReachableFiles(files: readonly ScannedSource[]): Set<string> {
  const known = new Map<string, string>()
  const byFile = new Map<string, ScannedSource>()
  for (const f of files) {
    known.set(f.file.replace(/\\/g, '/'), f.file)
    byFile.set(f.file, f)
  }
  const reached = new Set<string>()
  const queue: string[] = []
  for (const f of files) {
    if (f.server) {
      reached.add(f.file)
      queue.push(f.file)
    }
  }
  while (queue.length > 0) {
    const cur = byFile.get(queue.pop() as string)
    if (!cur) continue
    for (const spec of cur.imports) {
      const hit = resolveLocalImport(cur.file, spec, known)
      if (hit !== null && !reached.has(hit)) {
        reached.add(hit)
        queue.push(hit)
      }
    }
  }
  return reached
}
