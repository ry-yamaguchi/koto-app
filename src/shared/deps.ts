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
//
// ── `.node` の有無だけでは判定できない（2026-09-16・502 で実際にすり抜けた）──
// `npm install --ignore-scripts` は「素性の分からないコードを走らせない」守りだが、
// **組み立てそのものを止めている**。組み立てを止めているのだから、組み立て済みの
// `.node` が1つも無いのは当たり前で、「`.node` が無い＝安全」は成り立たない。
// だから、入れたあとに `.node` があるかに加えて、**そのライブラリが「組み立てが要る」
// と自分で宣言しているか**（`binding.gyp` の有無・`gypfile`・install 系スクリプトが
// 組み立て道具を呼ぶか）も見る（`declaresNativeBuild`）。

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
 * ネイティブ部品のパスから、**持ち主のライブラリのフォルダ**を取り出す（純関数）。
 *
 * ── なぜ名前ではなくフォルダで持つか（検分の指摘・2026-09-17）────────────
 * npm は版が食い違う依存を**入れ子の node_modules に別コピー**として置く。
 * `node_modules/bar` と `node_modules/foo/node_modules/bar` は**別物**で、
 * 中身も違う（片方だけが公開先用の部品を同梱していることがある）。名前だけを
 * キーにして集計すると2つが合流し、「どちらかに公開先用があれば通す」という
 * **通しすぎ**になる。だから集計はフォルダ単位で行い、名前は表示のときに作る。
 *
 * 例: `node_modules/foo/node_modules/bar/build/Release/x.node`
 *   → `node_modules/foo/node_modules/bar`
 *
 * 持ち主の**名前**の決め方（スコープ付きは2つ分）は `packageOfNative` にしかない
 * （掟10・一元定義）。ここはその名前をフォルダの並びに戻すだけ。
 */
export function packageDirOfNative(relPath: string): string {
  const rel = String(relPath ?? '')
  const parts = rel.split('/')
  const i = parts.lastIndexOf('node_modules')
  if (i === -1 || i + 1 >= parts.length) return rel
  return parts.slice(0, i + 1).concat(packageOfNative(rel).split('/')).join('/')
}

/**
 * 手元で組み立てが要る部品を呼ぶ道具の名前。
 * 導入スクリプトにこれが出てきたら、そのライブラリは**組み立ててはじめて動く**。
 */
export const NATIVE_BUILD_TOOLS = [
  'node-gyp', 'prebuild-install', 'node-pre-gyp', 'prebuildify',
  'cmake-js', 'neon', 'node-gyp-build',
] as const

// ── 本物のライブラリでの実測（2026-09-16・Koto と同じ導入コマンドで確かめた）──────────
//
//   ライブラリ        .node の数   binding.gyp   `.node` を探す守り   この関数
//   ───────────────────────────────────────────────────────────────────────────
//   better-sqlite3         0          あり        **素通り**            断る
//   sqlite3                0          あり        **素通り**            断る
//   bcrypt                10          あり          断る                断る
//   pg（純 JS・対照）      0          なし          通す                通す
//
// **`.node` を探すだけでは、よく使われる SQLite のライブラリが2つとも素通りしていた。**
// 一方で純 JS の `pg` は、この関数でも通る（止めすぎていない）。
//
// なお `sharp` は `.node` が入るが、**その中身は公開先で動く Linux 用**である。
// 2026-09-17（改善案 1-7・案3）から、`.node` の**種類まで見分けて**
// 公開先で動くものだけ通すようにした（`nativeBinaryKind`・`blockReasonForPackage`）。

/**
 * そのライブラリは「パソコンごとに組み立てが要る部品」を持っていると宣言しているか（純関数）。
 *
 * `--ignore-scripts` は組み立てを止める守りだが、止めている以上「組み立て済みの `.node`
 * が無い」のは当たり前になり、`.node` の有無だけでは安全と判断できない（上のコメント参照）。
 * そこで **`.node` そのものではなく、ライブラリ自身の宣言** を見る。
 *
 * 判定（この順でどれか1つでも当たれば true）:
 * 1. `hasBindingGyp === true`
 * 2. `pkgJson.gypfile === true`
 * 3. `scripts` の `preinstall` / `install` / `postinstall` のいずれかに
 *    `NATIVE_BUILD_TOOLS` のどれかが含まれる（部分一致でよい）
 *
 * **誤検知はしない**（これを外すと、動くアプリまで断ってしまう）。`core-js` の
 * `postinstall`（`node -e "try{require('./postinstall')}catch(e){}"`）や `esbuild` の
 * `postinstall`（`node install.js`）は、組み立て道具を呼んでいないので false。
 *
 * @param pkgJson       そのライブラリの package.json（壊れていてもよい）
 * @param hasBindingGyp そのライブラリのフォルダ直下に binding.gyp があるか
 */
export function declaresNativeBuild(pkgJson: unknown, hasBindingGyp: boolean): boolean {
  if (hasBindingGyp) return true
  const p = (pkgJson ?? {}) as Record<string, unknown>
  if (p.gypfile === true) return true
  const scripts = p.scripts
  if (!scripts || typeof scripts !== 'object') return false
  const s = scripts as Record<string, unknown>
  for (const key of ['preinstall', 'install', 'postinstall']) {
    const v = s[key]
    if (typeof v === 'string' && NATIVE_BUILD_TOOLS.some(tool => v.includes(tool))) return true
  }
  return false
}

// ── ネイティブ部品の「種類」を見分ける（改善案 1-7・案3）────────────────────
//
// `.node` があるだけで断るのは**止めすぎ**だった。Koto は `npm install` に
// `--os=linux --cpu=x64 --libc=musl` を渡しているので、**入ってくる `.node` が
// 最初から公開先で動くもの**であることがある（例: sharp）。
//
// 実測（2026-09-17・このリポジトリで確かめた）:
//
//   種類                        先頭4バイト        libc の参照
//   ─────────────────────────────────────────────────────────────────
//   macOS 用（Mach-O 64bit）    cf fa ed fe        —
//   Linux・glibc 向け           7f 45 4c 46（ELF） libc.so.6
//   Linux・musl 向け（公開先）  7f 45 4c 46（ELF） libc.musl-x86_64.so.1
//
// **ELF ヘッダだけでは glibc と musl を区別できない**（どちらも class=02・
// data=01・e_machine=0x3E）。**`libc` の参照名で分かれる。**
// 公開先は `node:22-alpine`（musl・amd64）である（imageBuild.ts の土台イメージ）。

/** ネイティブ部品の種類。**通してよいのは linux-musl-x64 だけ。** */
export type NativeBinaryKind =
  /** 公開先（Alpine / amd64）で動く。 */
  | 'linux-musl-x64'
  /** Linux 用だが、公開先（Alpine）では動かない。 */
  | 'linux-glibc-x64'
  /** ELF だが 64bit x86-64 でない。 */
  | 'linux-other'
  /** macOS 用。 */
  | 'macho'
  /** 判別できない。 */
  | 'unknown'

/** 中身に ASCII の目印が含まれるか（Buffer に頼らない・renderer からも使える）。 */
function includesAscii(buf: Uint8Array, needle: string): boolean {
  const n = needle.length
  if (n === 0 || buf.length < n) return false
  const first = needle.charCodeAt(0)
  const last = buf.length - n
  outer: for (let i = 0; i <= last; i++) {
    if (buf[i] !== first) continue
    for (let j = 1; j < n; j++) if (buf[i + j] !== needle.charCodeAt(j)) continue outer
    return true
  }
  return false
}

/** その4バイトが Mach-O（macOS 用）の目印か。 */
function isMachOMagic(b: Uint8Array): boolean {
  if (b.length < 4) return false
  const m = [b[0], b[1], b[2], b[3]].join(',')
  return m === '207,250,237,254'   // cf fa ed fe（64bit・リトルエンディアン）
    || m === '206,250,237,254'     // ce fa ed fe（32bit・リトルエンディアン）
    || m === '254,237,250,207'     // fe ed fa cf（ビッグエンディアン）
    || m === '254,237,250,206'     // fe ed fa ce（ビッグエンディアン）
}

/**
 * 部品の中身から種類を見分ける（純関数）。**ファイルの中身（Buffer）を受け取る。**
 * ファイルを読むのは呼び出し側（main）の仕事（テストしやすさのため）。
 *
 * 判定の順序（**この順**）:
 * 1. 先頭4バイトが ELF（7f 45 4c 46）でなければ、Mach-O の目印なら `'macho'`・それ以外は `'unknown'`
 * 2. ELF のとき、class が 64bit でない、または e_machine が x86-64 でなければ `'linux-other'`
 * 3. `libc.musl-x86_64.so.1` があれば `'linux-musl-x64'`
 * 4. `libc.so.6` があれば `'linux-glibc-x64'`
 * 5. どちらも無ければ `'unknown'`（**musl と決めつけない。分からないものを通さない**）
 *
 * 3 を 4 より先に見ること（`libc.so.6` は glibc 向けにしか出ない目印だが、
 * 順序を決めておかないと将来どちらも含む形で誤判定しうる）。
 */
export function nativeBinaryKind(buf: Uint8Array): NativeBinaryKind {
  const b = buf ?? new Uint8Array(0)
  const isElf = b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46
  if (!isElf) return isMachOMagic(b) ? 'macho' : 'unknown'
  // ELF: 5バイト目が class（02 = 64bit）、オフセット 0x12 の2バイトが e_machine（LE・0x3E = x86-64）
  if (b.length < 0x14) return 'linux-other'
  const machine = b[0x12] | (b[0x13] << 8)
  if (b[4] !== 0x02 || machine !== 0x3e) return 'linux-other'
  if (includesAscii(b, 'libc.musl-x86_64.so.1')) return 'linux-musl-x64'
  if (includesAscii(b, 'libc.so.6')) return 'linux-glibc-x64'
  return 'unknown'
}

/** 公開先で動く種類か（純関数）。**linux-musl-x64 だけ true。** */
export function runsOnPublishTarget(kind: NativeBinaryKind): boolean {
  return kind === 'linux-musl-x64'
}

/** 持っていけない理由（文面を書き分けるために使う）。 */
export type NativeBlockReason =
  /** 組み立てが要るのに、組み立てられていない。 */
  | 'needs-build'
  /** お使いのパソコン用の部品しか入っていない。 */
  | 'macho-only'
  /** Linux 用だが、公開先とは種類が違う。 */
  | 'other-linux'
  /** 種類を確かめられなかった。 */
  | 'unknown'

/**
 * そのライブラリを持っていけるか（純関数・**判定はここ1か所**・掟10）。
 *
 * **ファイル単位で断らない。** `node-gyp-build` を使うライブラリは各OS用の部品を
 * 全部同梱して実行時に選ぶので、macOS 用が入っていても**公開先用が同梱されていれば動く**。
 *
 * 順序（**`.node` の有無を先に見る**。binding.gyp を持ちつつ公開先用の部品を同梱している
 * ライブラリを、組み立て前と誤判定しないため）:
 * 1. `.node` があるとき: 1つでも公開先で動く種類があれば通す。無ければ断る（理由は中身から）
 * 2. `.node` が無いとき: 「組み立てが要る」と宣言していれば断る（`'needs-build'`）
 *
 * @param kinds         そのライブラリで見つかった `.node` の種類（順不同・重複可）
 * @param declaresBuild そのライブラリが「組み立てが要る」と宣言しているか
 * @returns 断る理由。持っていけるなら null
 */
export function blockReasonForPackage(
  kinds: readonly NativeBinaryKind[],
  declaresBuild: boolean,
): NativeBlockReason | null {
  const list = kinds ?? []
  if (list.length > 0) {
    if (list.some(runsOnPublishTarget)) return null
    if (list.every(k => k === 'macho')) return 'macho-only'
    if (list.some(k => k === 'linux-glibc-x64' || k === 'linux-other')) return 'other-linux'
    return 'unknown'
  }
  return declaresBuild ? 'needs-build' : null
}

/** 理由を並べる順（断定できるものを先に、いちばん情報の少ない `'unknown'` を最後に）。 */
const REASON_ORDER: readonly NativeBlockReason[] = ['needs-build', 'macho-only', 'other-linux', 'unknown']

/**
 * 理由が混ざったときに、どれを先に書くか（純関数）。
 *
 * 同じライブラリの別コピーが別の理由で引っかかったとき（入れ子の node_modules）や、
 * 文面を理由ごとに並べるときの**順序の定義**もここ1か所（掟10）。
 */
export function primaryBlockReason(reasons: readonly NativeBlockReason[]): NativeBlockReason {
  for (const r of REASON_ORDER) if ((reasons ?? []).includes(r)) return r
  return 'needs-build'
}

/** 持っていけないライブラリ1件（名前と理由）。 */
export type BlockedPackage = { name: string; reason: NativeBlockReason }

/**
 * 持っていけないライブラリを、利用者に伝える文面（純関数）。
 *
 * **どうすればよいかまで書く。** 「動きません」だけでは、そこで終わってしまう。
 *
 * **パスではなく、名前の配列を受け取る**（掟10・一元定義）。組み立て済みの `.node` が
 * あるとき（`packageOfNative` でパス→名前）と、組み立てが要ると宣言しているだけで
 * まだ `.node` が無いとき（`declaresNativeBuild`）の**両方**が呼び出し側から名前で渡ってくる。
 *
 * **理由ごとに書き分ける**（改善案 1-7）。「パソコンごとに組み立てが必要」は、
 * 公開先とは別の種類の Linux 用の部品が入っている場合には**当てはまらない**。
 * 専門用語（ELF・musl・glibc・Mach-O）は画面に出さない。
 *
 * @param names  持っていけないライブラリの名前（重複・順不同でよい）
 * @param reason 断る理由（既定は「組み立てられていない」）
 */
export function nativeDepsMessage(
  names: readonly string[],
  reason: NativeBlockReason = 'needs-build',
): string {
  return blockSentence(names, reason) + NEXT_STEP
}

/** 次の一手（どの理由でも同じ。**最後に1回だけ**添える）。 */
const NEXT_STEP = 'AIに「このライブラリを使わない作りに直して」と頼むか、'
  + '公開先を「エキスパート（自分の Dockerfile）」に切り替えてください。'

/** 理由1つぶんの文（名前の並び＋その理由の説明）。 */
function blockSentence(names: readonly string[], reason: NativeBlockReason): string {
  const uniq = Array.from(new Set(names ?? [])).sort()
  const head = uniq.slice(0, 3).join('、') + (uniq.length > 3 ? ` ほか${uniq.length - 3}件` : '')
  const lead = `このアプリが使っているライブラリ（${head}）`
  return reason === 'macho-only'
    ? `${lead}には、お使いのパソコン用の部品しか入っていません。`
      + '公開先（Linux）で動く部品が無いため、このまま公開しても起動しません。'
    : reason === 'other-linux'
      ? `${lead}に入っているのは、公開先とは別の種類の Linux 用の部品です。`
        + '公開先ではこの部品を読み込めないため、このまま公開しても起動しません。'
      : reason === 'unknown'
        ? `${lead}に入っている部品は、種類を確かめられませんでした。`
          + '公開先で動くかどうか分からないため、念のためこのまま公開しません。'
        : `${lead}は、パソコンごとに組み立てが必要な部品を含んでいます。`
          + '公開先（Linux）で動く形にできないため、このまま公開しても起動しません。'
}

/**
 * 持っていけないライブラリを、**理由ごとにまとめて**伝える文面（純関数）。
 *
 * ── なぜ理由を1つに畳まないか（検分の指摘・2026-09-17）────────────────
 * 理由を1つに畳んで名前を全部並べると、**当てはまらない理由を告げる**ことになる。
 * 例えば `better-sqlite3`（組み立てが要る）と、お使いのパソコン用の部品しか
 * 入っていないライブラリが同時に引っかかると、両方の名前を並べたうえで
 * 「パソコンごとに組み立てが必要」と出てしまい、後者の持ち主は
 * 「組み立てを待てば直る」と原因を取り違える。
 * そこで**理由ごとに名前をまとめ、理由の数だけ文を並べる**。次の一手は最後に1回。
 *
 * 並べる順は `primaryBlockReason` と同じ（`REASON_ORDER`・掟10・一元定義）。
 *
 * @param blocked 持っていけないライブラリと、それぞれの理由（順不同でよい）
 */
export function nativeDepsMessageForBlocked(blocked: readonly BlockedPackage[]): string {
  const byReason = new Map<NativeBlockReason, string[]>()
  for (const b of blocked ?? []) {
    if (!b || typeof b.name !== 'string') continue
    const list = byReason.get(b.reason) ?? []
    list.push(b.name)
    byReason.set(b.reason, list)
  }
  const reasons = REASON_ORDER.filter(r => byReason.has(r))
  // 理由が1つも無い（呼び出し側が空で呼んだ）ときも、黙って空文字を返さない。
  if (reasons.length === 0) return nativeDepsMessage([])
  return reasons.map(r => blockSentence(byReason.get(r) ?? [], r)).join('\n') + NEXT_STEP
}

/** 用意にかかる時間の目安（純関数・件数から）。 */
export function installTimeNote(count: number): string {
  if (count <= 0) return ''
  if (count <= 5) return '少し時間がかかります（1分ほど）'
  return `時間がかかります（${Math.min(10, Math.ceil(count / 5))}分ほど）`
}
