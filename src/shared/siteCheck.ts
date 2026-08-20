// siteCheck.ts — 作ったページの「押す前に分かる落とし穴」を見つける（純ロジック）。
//
// ── なぜ要るか（2026-08-19 実機・Ryosuke 報告）──────────────────────────
// 公開したページのヒーローが**タイル表示**になっていた。記録を辿ると、
// 背景画像を入れてから `background-size: cover` が足されるまで25分あり、
// **その間のページは本当にタイル表示だった**（AI の作りかけ）。
//
// 「見た目が良いか」は人が見て決めることで、機械には向かない。
// だが**決まった落とし穴**は、押す前に機械で見つけられる:
//
//   ・背景画像に大きさ・繰り返しの指定が無い（＝敷き詰められる）
//   ・参照している画像が**無い**、または**大文字小文字が違う**
//     （macOS は同じ扱いだが、公開先の Linux は別物として 404 になる）
//
// 判定はここに集め、ファイルを読むのは呼び出し側（IO）が行う。

/** 落とし穴の種類。 */
export type SiteIssueKind =
  /** 背景画像に大きさの指定が無い（タイル状に敷き詰められる）。 */
  | 'background'
  /** 参照している画像・CSS・JS が無い。 */
  | 'missing'
  /** 名前の大文字小文字が違う（公開先の Linux で 404）。 */
  | 'miscased'
  /** リンク先のページが無い。 */
  | 'link'
  /** スマホ用の指定（viewport）が無い。 */
  | 'viewport'
  /** `<img>` に大きさの指定が無い（原寸で飛び出す）。 */
  | 'imgSize'
  /** どこからも使われていない画像。 */
  | 'unused'
  /** 画像が大きすぎる（表示が遅い）。 */
  | 'heavy'

/** 見つかった落とし穴の1件。 */
export type SiteIssue = {
  kind: SiteIssueKind
  /** どのファイルの話か（プロジェクト相対）。 */
  file: string
  /** 場所や対象（セレクタ・ファイル名など）。 */
  detail: string
  /** 利用者に見せる説明（**どうなるか**まで書く）。 */
  note: string
}

/**
 * AI が直せる種類か（純関数）。
 *
 * **直せないものを「直させる」ボタンに混ぜない。** 画像を消すことも、
 * 写真を軽くすることも AI にはできない（道具を持たせていない）。
 * それらは利用者に伝えるだけにする。
 */
export function aiFixable(kind: SiteIssueKind): boolean {
  return kind !== 'unused' && kind !== 'heavy'
}

/** 外部のもの（拾わない）。 */
function isExternal(ref: string): boolean {
  return /^(https?:)?\/\//.test(ref) || /^(data|mailto|tel|javascript):/i.test(ref) || ref.startsWith('#')
}

/**
 * HTML/CSS から、プロジェクト内のファイルへの参照を拾う（純関数）。
 *
 * `src="images/a.png"` / `url('images/a.png')` / `url(images/a.png)` を拾い、
 * 外部URL・data URL・アンカーは拾わない。`?v=1` や `#x` は落とす。
 */
export function localRefs(text: string): string[] {
  const out: string[] = []
  const push = (raw: string) => {
    const ref = raw.trim().replace(/^['"]|['"]$/g, '').split(/[?#]/)[0]
    if (!ref || isExternal(ref)) return
    out.push(ref.replace(/^\.\//, ''))
  }
  for (const m of String(text ?? '').matchAll(/\bsrc\s*=\s*("[^"]*"|'[^']*')/gi)) push(m[1])
  for (const m of String(text ?? '').matchAll(/url\(\s*([^)]*)\)/gi)) push(m[1])
  return Array.from(new Set(out))
}

/**
 * 参照が実在するか（純関数）。
 *
 * **大文字小文字まで見る。** macOS では通り、公開先（Linux）でだけ 404 になる
 * ため、手元では絶対に気づけない。
 *
 * @param actual プロジェクトにある全ファイル（プロジェクト相対パス）
 */
export function checkRefs(refs: readonly string[], actual: readonly string[]): {
  missing: string[]
  miscased: Array<{ ref: string; actual: string }>
} {
  const exact = new Set(actual)
  const lower = new Map<string, string>()
  for (const a of actual) lower.set(a.toLowerCase(), a)
  const missing: string[] = []
  const miscased: Array<{ ref: string; actual: string }> = []
  for (const ref of refs) {
    if (exact.has(ref)) continue
    const same = lower.get(ref.toLowerCase())
    if (same) miscased.push({ ref, actual: same })
    else missing.push(ref)
  }
  return { missing, miscased }
}

/** その塊に、背景画像の大きさの指定があるか（純関数）。 */
function hasSizing(block: string): boolean {
  // 個別指定、または一括指定の中の `center/cover` のような書き方
  return /background-size\s*:/i.test(block) || /background\s*:[^;]*\/\s*(cover|contain)/i.test(block)
}

/** その塊が背景画像を指定しているか（純関数）。 */
function hasBackgroundImage(block: string): boolean {
  return /background(-image)?\s*:[^;]*url\(/i.test(block)
}

/**
 * CSS の中で「大きさの指定がある」クラス名を集める（純関数）。
 *
 * ── なぜ要るか（2026-08-19 実物で確認）────────────────────────────────
 * 今回のページは **HTML に背景画像・CSS に大きさ**、と**2つのファイルに
 * またがって**書かれていた。片方だけ見て判断すると、正しいページを
 * 「指定漏れ」と騒いでしまう。**騒ぐ検査は使われなくなる。**
 */
export function sizedClassNames(css: string): Set<string> {
  const out = new Set<string>()
  for (const m of String(css ?? '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!hasSizing(m[2])) continue
    for (const c of m[1].matchAll(/\.([A-Za-z0-9_-]+)/g)) out.add(c[1])
  }
  return out
}

/**
 * 背景画像の指定漏れを探す（純関数）。
 *
 * **大きさの指定が無ければ、画像は原寸で敷き詰められる**（今回の症状）。
 *
 * @param sized CSS 側で大きさを指定しているクラス名（sizedClassNames の結果）
 * @returns 見つけた場所の名前（セレクタ、またはインラインの目印）
 */
export function backgroundImageIssues(text: string, sized: ReadonlySet<string> = new Set()): string[] {
  const found: string[] = []
  const src = String(text ?? '')
  // CSS のブロック（`セレクタ { ... }`）
  for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim().replace(/\s+/g, ' ')
    if (!hasBackgroundImage(m[2]) || hasSizing(m[2])) continue
    // 同じクラスが別の場所で大きさを指定していれば、それで効いている
    const classes = Array.from(selector.matchAll(/\.([A-Za-z0-9_-]+)/g)).map(c => c[1])
    if (classes.some(c => sized.has(c))) continue
    found.push(selector)
  }
  // HTML のインライン指定（**その要素の class も見る**）
  for (const m of src.matchAll(/<[a-zA-Z][^>]*>/g)) {
    const tag = m[0]
    const style = /style\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? ''
    if (!hasBackgroundImage(style) || hasSizing(style)) continue
    const cls = /class\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? ''
    if (cls.split(/\s+/).some(c => c && sized.has(c))) continue
    found.push(cls ? `class="${cls}"` : `style="${style.trim().slice(0, 40)}…"`)
  }
  return Array.from(new Set(found))
}

/**
 * ページ内リンクの行き先を拾う（純関数）。
 *
 * `href="menu.html"` のような**同じプロジェクトの中のページ**だけ。
 * 外部URL・`#`・`mailto:`・`tel:` は拾わない。
 */
export function localLinks(html: string): string[] {
  const out: string[] = []
  for (const m of String(html ?? '').matchAll(/\bhref\s*=\s*("[^"]*"|'[^']*')/gi)) {
    const ref = m[1].slice(1, -1).trim().split(/[?#]/)[0]
    if (!ref || isExternal(ref)) continue
    out.push(ref.replace(/^\.\//, ''))
  }
  return Array.from(new Set(out))
}

/**
 * スマホ用の指定があるか（純関数）。
 *
 * 無いと**スマホで文字が極小**になる（PC幅のまま縮小表示される）。
 * お店のページでは致命的なので、有無だけを見る（誤検知の余地が無い）。
 */
export function hasViewportMeta(html: string): boolean {
  return /<meta[^>]+name\s*=\s*["']viewport["']/i.test(String(html ?? ''))
}

/**
 * `<img>` に大きさの指定が無いものを探す（純関数）。
 *
 * **控えめに見る。** width/height 属性・インラインの width/max-width・
 * CSS 側で大きさを決めているクラス、のいずれも無いものだけを挙げる。
 * ここを厳しくすると正しいページまで騒ぐ（騒ぐ検査は使われなくなる）。
 *
 * @param sizedImg CSS で幅を決めているクラス名（sizedImageClassNames の結果）
 */
export function imgWithoutSizing(html: string, sizedImg: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = []
  for (const m of String(html ?? '').matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0]
    if (/\b(width|height)\s*=/i.test(tag)) continue
    const style = /style\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? ''
    if (/(max-)?width\s*:/i.test(style)) continue
    const cls = (/class\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? '').split(/\s+/).filter(Boolean)
    if (cls.some(c => sizedImg.has(c))) continue
    const src = /src\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? ''
    out.push(src || tag.slice(0, 40))
  }
  return Array.from(new Set(out))
}

/** CSS で幅を決めているクラス名を集める（純関数）。 */
export function sizedImageClassNames(css: string): Set<string> {
  const out = new Set<string>()
  for (const m of String(css ?? '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/(max-)?width\s*:/i.test(m[2])) continue
    for (const c of m[1].matchAll(/\.([A-Za-z0-9_-]+)/g)) out.add(c[1])
  }
  return out
}

/** 画像として扱う拡張子。 */
const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|avif)$/i

/**
 * どこからも使われていない画像を探す（純関数）。
 *
 * 入れ替えを繰り返すと古い画像が残り、**公開物に混ざって重くなる**。
 * 消すかどうかは人が決めること（AI に消す道具は持たせていない）。
 */
export function unusedImages(allFiles: readonly string[], referenced: readonly string[]): string[] {
  const used = new Set(referenced)
  return allFiles.filter(f => IMAGE_RE.test(f) && !used.has(f))
}

/** 大きすぎる画像の目安（バイト）。これを超えると表示が目に見えて遅くなる。 */
export const HEAVY_IMAGE_BYTES = 1_000_000

/**
 * 大きすぎる画像を探す（純関数）。**使われているものだけ**を見る。
 *
 * ── なぜ絞るか（2026-08-19 実機・Ryosuke 指摘）────────────────────────
 * 「直前まで画像の大きいファイルがあるので対応しろと言われているのに、
 *   実際には使われていなくて削除されている、という状況になるのは困ります」
 *
 * どこからも使われていない画像は**ページを重くしない**（読み込まれない）。
 * それを「対応してください」と言うのは筋が通らないし、片づけると勝手に
 * 消えて「なぜ？」となる。使われている画像だけが、表示の速さに効く。
 *
 * @param used 参照されているファイル（プロジェクト相対）
 */
export function heavyImages(
  files: readonly { path: string; bytes: number }[],
  used: readonly string[],
  limit: number = HEAVY_IMAGE_BYTES,
): Array<{ path: string; bytes: number }> {
  const inUse = new Set(used)
  return files.filter(f => IMAGE_RE.test(f.path) && inUse.has(f.path) && f.bytes > limit)
}

/** 読みやすい大きさ表記（純関数）。 */
export function humanBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)}MB`
  return `${Math.max(1, Math.round(bytes / 1000))}KB`
}

/** 画面に出す一言（純関数）。**どうなるかまで書く。** */
export function siteIssueNote(kind: SiteIssueKind, detail: string): string {
  switch (kind) {
    case 'missing':
      return `参照しているファイルが見つかりません: ${detail}（公開すると、その場所が空白になります）`
    case 'miscased':
      return `名前の大文字小文字が違います: ${detail}（手元では表示されますが、**公開先では表示されません**）`
    case 'background':
      return `背景画像に大きさの指定がありません: ${detail}（画像が敷き詰められ、タイル状に並んで見えます）`
    case 'link':
      return `リンク先のページがありません: ${detail}（押すと「見つかりません」になります）`
    case 'viewport':
      return 'スマホ用の指定（viewport）がありません（スマホで文字が極端に小さく表示されます）'
    case 'imgSize':
      return `画像に大きさの指定がありません: ${detail}（原寸のまま表示され、画面からはみ出すことがあります）`
    // ── ファイル名を繰り返さない（2026-08-19 実機・Ryosuke 指摘）──────────
    // 画面は「・<ファイル名>: <この文>」の形で出す。ここに同じ名前を書くと
    // 「・images/a.jpg: どこからも使われていません: images/a.jpg」と2回出る。
    // 片づけのボタンも隣にあるので、「ファイル一覧から削除できます」も要らない。
    case 'unused':
      return 'ページから使われていません（このままだと公開物に混ざります）'
    case 'heavy':
      // **どうすればよいかまで書く。** 画像を軽くする道具は Koto にも AI にも無い。
      return `大きすぎます（${detail}）。読み込みに時間がかかるので、`
        + '小さい画像を用意して、チャットに落として【📁 画像を使う】から差し替えてください'
  }
}

/**
 * まとめの見出し（純関数）。**次にどうすればよいかまで書く。**
 *
 * 2026-08-19 Ryosuke 指定の言い回し:
 *   「◯◯に問題があります。AIに修正させてから公開させることをおすすめします」
 */
export function siteCheckSummary(issues: readonly SiteIssue[]): string {
  if (issues.length === 0) return ''
  const fixable = issues.filter(i => aiFixable(i.kind)).length
  // ── 「問題」と「片づけ」を分ける（2026-08-19 実機・Ryosuke 指摘）──────────
  // 使っていない画像は**ページの問題ではない**。置いたままになっているだけで、
  // 見た目も動きも壊れていない。「問題があります・直してから公開を」と言うのは
  // 大げさで、直しようもない（AI には消せない）。言葉を分ける。
  //
  // 項目名がすでに「見た目」なので、本文の頭でそれを繰り返さない。
  if (fixable === 0) {
    return `使っていない画像などが ${issues.length} 件あります（公開はできます）。`
  }
  const rest = issues.length - fixable
  const head = `作ったページに問題があります（${fixable}件）。AIに修正させてから公開することをおすすめします。`
  return rest > 0 ? `${head}ほかに、使っていない画像などが ${rest} 件あります。` : head
}

/**
 * AI に渡す修正の指示（純関数）。
 *
 * **直せるものだけを渡す**（画像を消す・写真を軽くするは AI にはできない）。
 * どこを・どう直すかまで書く（「直して」だけでは、また手順の説明が返ってくる）。
 */
export function fixInstruction(issues: readonly SiteIssue[]): string {
  const targets = issues.filter(i => aiFixable(i.kind))
  if (targets.length === 0) return ''
  const how: Record<SiteIssueKind, string> = {
    background: '背景画像を指定している場所に `background-size: cover;` `background-position: center;` `background-repeat: no-repeat;` を追加してください（`background:` の一括指定より**あと**に書くこと）',
    missing: '参照先を実在するファイルに直すか、その参照を消してください',
    miscased: '参照している名前を、実際のファイル名と**大文字小文字まで同じ**に直してください',
    link: 'リンク先を実在するページに直すか、そのページを作ってください',
    viewport: '`<head>` に `<meta name="viewport" content="width=device-width, initial-scale=1.0">` を追加してください',
    imgSize: 'その画像に CSS で `max-width: 100%;` と `height: auto;`（必要なら `object-fit: cover;`）を指定してください',
    unused: '',
    heavy: '',
  }
  const lines = targets.map(i => `・${i.file}${i.detail ? `（${i.detail}）` : ''}: ${how[i.kind]}`)
  return [
    '公開する前の確認で、見た目の問題が見つかりました。**実際にファイルを直してください**（説明だけで終わらせないこと）。',
    ...lines,
    '直したら、何をどう変えたかを2〜3行で教えてください。',
  ].join('\n')
}
