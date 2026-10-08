// dataLayer.ts — プロジェクトに koto-data（.js / .cjs）を用意する（main 側の IO）。
//
// **アプリの形に合う方を置く**（2026-09-23）。import を使うアプリには
// `koto-data.js`、require を使うアプリには `koto-data.cjs`。見分けは純関数
// `moduleKindOf`（src/shared/objectStorage.ts）に集めてある（掟10）。
//
// ── なぜ自動で置くのか（2026-08-13）──────────────────────────────────
// AI には「データの保存には koto-data を使う」と伝えてある（aiContext.ts の
// DATA_RULE）。だが**ファイルが無ければ import が失敗し、「② 試す」で落ちる**。
// 非エンジニアにとって「試すと壊れる」は致命的なので、**参照された時点で置く**。
//
// ── 上書きの決まり（重要・2026-09-24 に改めた）────────────────────────
// この層は「あとでデータベース版に差し替える」ことを想定して作ってある
// （roadmap S-1）。差し替えたものを Koto が黙って元に戻すと、**利用者のデータの
// 読み書きが突然オブジェクトストレージへ戻る**。だから何でも上書きはしない。
//
// 一方で、直しの出発点は「**いま公開中のアプリ**が壊れている」ことであり、
// そのアプリは**すべて既にファイルを持っている**。「既にあれば触らない」だけでは、
// いちばん効く直しがいちばん必要なところに届かない。
//
// そこでテンプレートに**版の印**（`// koto-data-template: …`）を入れ、
// **印があって版が古いものだけ**を差し替える。印が無いもの・作り替えられたものは
// 触らず、`needsUpdate` で画面に知らせて利用者に選ばせる。
// 判断は純関数 `dataLayerPlacement` の1か所（掟10）。

import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import {
  usesDataLayer, fileWriteLines, moduleKindForDataLayer, dataLayerFileFor,
  DATA_LAYER_FILES, DATA_LAYER_LOCAL_DIR, type FileWriteSite, type ModuleKind,
} from '../shared/objectStorage'
import { memoryKeepLines, looksLikeServerCode, localImportSpecs, serverReachableFiles, type ScannedSource } from '../shared/memoryKeep'
import { serverListens } from '../shared/vercelFit'

/** 走査を打ち切る条件（envDetect.ts と同じ考え方）。 */
// `.koto-data`（手元のデータ置き場）の名前は objectStorage.ts の一元定義を使う（掟10）。
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'out', DATA_LAYER_LOCAL_DIR, '.sakuraide', '.sakuraide-backup', '.sakura-cloud', 'vendor', '__pycache__'])
const EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py'])
const MAX_FILES = 2000
const MAX_BYTES = 512 * 1024

/** 同梱しているテンプレートの場所。開発時とパッケージ版の両方に対応する。 */
function templatePath(file: string): string {
  const candidates = [
    path.join(app.getAppPath(), 'templates', file),
    path.join(process.cwd(), 'templates', file),
  ]
  for (const p of candidates) if (fs.existsSync(p)) return p
  throw new Error(`${file} のテンプレートが見つかりません`)
}

/** 上へたどる段数の上限（実運用では 1〜2 段。暴走止め）。 */
const PACKAGE_JSON_MAX_LEVELS = 8

/**
 * package.json の中身を**近い順**に集める（無い階層は null）。
 *
 * ── なぜ上へたどるのか（2026-09-23 検分）──────────────────────────────
 * Node は「そのファイルにいちばん近い package.json」を**上の階層まで探しに行く**。
 * 公開の根（`public/`）に package.json が無く、プロジェクト直下に
 * `"type": "module"` があるプロジェクトでは、根だけを見ると require のアプリと
 * 誤り、`koto-data.cjs` を置いて `require` を勧めてしまう。ところが
 * `② 試す` は `public/` の中で `node server.js` を走らせるので、Node は直下の
 * package.json を見て ESM として扱い、
 * `ReferenceError: require is not defined in ES module scope` で落ちる。
 *
 * **探す範囲を決めるのもここ**（`stopAt` を超えて上へは出ない）。渡されなければ
 * 従来どおり `fromDir` の1枚だけを見る。
 */
function packageJsonChain(fromDir: string, stopAt?: string): (string | null)[] {
  const texts: (string | null)[] = []
  if (!fromDir) return texts
  const stop = stopAt ? path.resolve(stopAt) : ''
  let cur = path.resolve(fromDir)
  for (let i = 0; i < PACKAGE_JSON_MAX_LEVELS; i++) {
    let text: string | null = null
    try { text = fs.readFileSync(path.join(cur, 'package.json'), 'utf8') } catch { text = null }
    texts.push(text)
    if (!stop || cur === stop) break
    const parent = path.dirname(cur)
    if (parent === cur) break
    // stop（プロジェクト直下）の外へは出ない
    if (parent !== stop && !parent.startsWith(stop + path.sep)) break
    cur = parent
  }
  return texts
}

/**
 * このプロジェクトが import と require のどちらを使う形か。
 *
 * **判定そのものは純関数（`moduleKindForDataLayer`）に集めてある**（掟10）。
 * ここは**材料を探して読むだけ**: ①読み込む側のファイル（拡張子が決め手になる）
 * ②近い順の package.json。
 *
 * @param publishRootDir 公開の根（`public/` があればその中）
 * @param opts.projectDir プロジェクト直下。渡すと、根に package.json が無いとき
 *   ここまで上へたどる。渡さなければ根の1枚だけを見る（従来どおり）。
 * @param opts.targets koto-data を読み込むことになるファイル（根からの相対パス）
 */
export function projectModuleKind(
  publishRootDir: string,
  opts?: { projectDir?: string; targets?: readonly string[] },
): ModuleKind {
  return moduleKindForDataLayer({
    targets: opts?.targets,
    packageJsonTexts: packageJsonChain(publishRootDir, opts?.projectDir),
  })
}

export type DataLayerScan = {
  /** koto-data を使っているファイル（相対パス）。 */
  usedBy: string[]
  /**
   * 自分でファイルに書き込んでいる場所（相対パスと行番号）。**静かに壊れる形。**
   *
   * **行番号まで持つ**のは、AI への依頼文と「書き直せたか確かめる」で
   * **場所を名指しする**ため（2026-09-23）。名指しできないと、AI の
   * 「完了しました」と画面の「まだです」の間で利用者が立ち往生する。
   */
  writesFiles: FileWriteSite[]
  /**
   * 入力されたデータを、**メモリ（変数・配列）だけに持っている**と思われる場所（相対パスと行番号・
   * 2026-10-01 rc.5 の実機）。`writesFiles` と同じ形で、行番号は**書き換えている行**。
   *
   * ファイルにも koto-data にも書かないので、`writesFiles` にも `usedBy` にも載らず、
   * これまでは何の案内も出なかった（再起動・公開し直しで消える）。
   * 判定の正は `memoryKeepLines`（src/shared/memoryKeep.ts）。**サーバー側のコードらしい
   * ファイルだけ**が対象で、ブラウザ側の JS は載らない。推定である点は画面でも断定しない。
   */
  keepsInMemory: FileWriteSite[]
  /**
   * 自分でポートを待ち受けているファイル（相対パス）。
   *
   * Vercel の確認で使う（2026-08-15）。**歩き回る処理を二つ持たない**ため、
   * ここで一緒に集める（同じファイルを二度読まない）。
   */
  listens: string[]
  /**
   * **全部は見られなかった**か（2026-09-23 検分）。
   *
   * 走査は 2000ファイル・512KB・深さ8 で打ち切る。打ち切られたのに
   * 「見つかりませんでした」と断定すると、**調べていないだけ**のものを
   * 「済んだ」に倒すことになる。確かめていないことを断定しないために運ぶ。
   *
   * 走査の対象外（node_modules などのフォルダ、`.js`/`.py` 以外の拡張子）は
   * **打ち切りに数えない**。あれは初めから見ないと決めた範囲であって、
   * 数えると常に true になり、この印そのものが意味を失う。
   */
  truncated: boolean
  /** 打ち切りで見送ったファイル・フォルダの数（0 なら全部見られた）。 */
  skipped: number
}

/** プロジェクトを走査して、データの扱いを調べる。 */
export function scanDataUsage(projectDir: string): DataLayerScan {
  const usedBy: string[] = []
  const writesFiles: FileWriteSite[] = []
  const keepsInMemory: FileWriteSite[] = []
  // メモリの判定は、**歩き終わってから**（サーバーの印の無いファイルは、印のあるファイルから
  // 読み込まれているときだけ数える・memoryKeep.ts の `serverReachableFiles`）。歩く処理は1つのまま
  const sources: ScannedSource[] = []
  const memoryCandidates = new Map<string, number[]>()
  const listens: string[] = []
  let scanned = 0
  let skipped = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > 8 || scanned >= MAX_FILES) { skipped++; return }
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { skipped++; return }
    for (const e of entries) {
      if (scanned >= MAX_FILES) { skipped++; return }
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1)
        continue
      }
      if (!EXTS.has(path.extname(e.name))) continue
      // 層そのものは対象外（`.js` も `.cjs` も。**片方だけ外すと、require 版の
      // 中にある fs.writeFile が「利用者が書いた書き込み」として警告に出る**）
      if (DATA_LAYER_FILES.includes(e.name)) continue
      let text: string
      try {
        if (fs.statSync(full).size > MAX_BYTES) { skipped++; continue }
        text = fs.readFileSync(full, 'utf8')
      } catch { skipped++; continue }
      scanned++
      const rel = path.relative(projectDir, full)
      // **koto-data を使っているかと、自分で書いているかは別の観点**（2026-09-23 検分）。
      // else にすると、AI が import を1行足しただけのファイルが検査から外れ、
      // 残っている fs.writeFileSync を**1件も拾えなくなる**。そのまま
      // 「✅ 書き直せています」と断定してしまい、利用者は公開してデータを失う。
      // **両方に載る＝書き直しが途中**、が正しい状態である
      if (usesDataLayer(text)) usedBy.push(rel)
      const lines = fileWriteLines(text)
      if (lines.length > 0) writesFiles.push({ file: rel, lines })
      // **メモリだけに持つ形も、同じ歩きの中で拾う**（2026-10-01）。除外（SKIP_DIRS・
      // koto-data.js/.cjs など Koto が置くもの）は、ここへ来る前の上の段で既に効いており、
      // `writesFiles` と**同じ名簿・同じ場所**になる（歩く処理を二つ持たない・掟10）。
      // これも koto-data を使っているかとは別の観点なので else にしない。
      // **サーバーの印を問わず、まず候補を集める**（`lib/store.ts` のように、入れ物だけを
      // 別のファイルに分けた形は、そのファイル自身にはサーバーの印が無い・2026-10-01 検分）
      sources.push({ file: rel, server: looksLikeServerCode(text), imports: localImportSpecs(text) })
      const memoryLines = memoryKeepLines(text, { assumeServer: true })
      if (memoryLines.length > 0) memoryCandidates.set(rel, memoryLines)
      // **これは別の観点**（データの扱いではなく起動の形）なので else にしない
      if (serverListens(text)) listens.push(rel)
    }
  }
  walk(projectDir, 0)
  // 候補のうち、**サーバー側のファイル**（印がある、または印のあるファイルから読み込まれている）だけ
  if (memoryCandidates.size > 0) {
    const serverSide = serverReachableFiles(sources)
    for (const [file, lines] of memoryCandidates) {
      if (serverSide.has(file)) keepsInMemory.push({ file, lines })
    }
  }
  return { usedBy, writesFiles, keepsInMemory, listens, truncated: skipped > 0, skipped }
}

/** `ensureDataLayer` の結果。**「置いたか」と「使える状態か」は別。** */
export type EnsureDataLayerResult = {
  /** 今回このプロジェクトへ置いたか（既にあった・要らなかったときは false）。 */
  placed: boolean
  /**
   * **読み込み先のファイルが、いま実際にあるか。**
   *
   * AI へ「このファイルから読み込む形に書き直して」と頼んでよいかは、
   * 「置いたか」ではなく**これ**で決める（既にあるなら置かないが、頼んでよい）。
   */
  ready: boolean
  /** 置いた／既にあるファイルの名前。要らなかったときは null。 */
  file: string | null
  /** このアプリの形（import か require か）。 */
  moduleKind: ModuleKind
  /** 既にあったものを、新しい版へ**差し替えた**か（印が一致したときだけ）。 */
  replaced: boolean
  /**
   * **既にあるものが古いのに、Koto が差し替えられなかったか。**
   *
   * 印（`koto-data-template:`）が無い＝Koto が置いたままだと確かめられないもの。
   * 黙って上書きすると、データベース版に差し替えた利用者の仕事を消してしまう。
   * **触らずに画面へ知らせる**ための印。
   */
  needsUpdate: boolean
}

/** テンプレートに入れてある「Koto が置いた版」の印。 */
const TEMPLATE_STAMP_RE = /^\/\/ koto-data-template: ([0-9A-Za-z._-]+)[ \t]*$/m

/** 印を読む（無ければ null）。**純関数**。 */
export function dataLayerStamp(text: string | null | undefined): string | null {
  const m = TEMPLATE_STAMP_RE.exec(String(text ?? ''))
  return m ? m[1] : null
}

/**
 * 版の印を**数として**比べる（純関数）。`a` が新しければ正、古ければ負、同じなら 0。
 *
 * ── なぜ文字列比較ではいけないか（2026-09-25 検分の指摘27）──────────────
 * 印は `2026-09-24.2` のように「日付.連番」で、以前はこれを文字列のまま
 * `next > now` で比べていた。文字列では桁数を見ないので
 * `'2026-09-24.9' > '2026-09-24.10'` が **true** になる——つまり同じ日の
 * 10版目以降を配ると、利用者の手元にある `.9` のファイルが「もう新しい」と
 * 判定され、**差し替えが黙って止まる**。画面にも何も出ない（needsUpdate も立たない）。
 * 混み合ったときのやり直しも同時更新の検知も入らないまま、公開中のアプリが動き続ける。
 *
 * 数字のかたまりごとに数として比べる（`2026-09-24.10` → 2026, 9, 24, 10）。
 * 数字が1つも無い印どうしは「同じ」＝**差し替えない**（分からないときは触らない側へ倒す）。
 */
export function compareDataLayerStamp(a: string, b: string): number {
  const parts = (s: string): number[] =>
    String(s ?? '').split(/[^0-9]+/).filter(x => x.length > 0).map(x => Number(x))
  const pa = parts(a)
  const pb = parts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0 // 読めない印では動かさない
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/**
 * **既にあるファイルをどうするか**（純関数・掟10で1か所にまとめてある）。
 *
 * ── なぜ要るのか（2026-09-24 検分）──────────────────────────────────
 * 直すきっかけは「**いま公開中のアプリ**が 429 で真っ白になる／後勝ちで消える」
 * ことだった。ところがその対象は**すべて既に koto-data を持っている**ので、
 * 「既にあれば触らない」だけでは、いちばん効く直しがいちばん必要なアプリに届かない。
 *
 * かといって黙って上書きはできない。この層は「あとでデータベース版に差し替える」
 * ことを想定しているので（roadmap S-1）、**差し替えたものを元に戻したら事故**である。
 *
 * そこでテンプレートに**版の印**を入れ、**印があって版が古いものだけ**差し替える。
 * 印が無いもの（印を入れる前に置かれたもの・作り替えられたもの）は**触らない**。
 */
export type DataLayerPlacement = 'place' | 'up-to-date' | 'replace' | 'leave-alone'

export function dataLayerPlacement(existing: string | null, template: string): DataLayerPlacement {
  if (existing === null) return 'place'
  const now = dataLayerStamp(existing)
  const next = dataLayerStamp(template)
  if (now === null || next === null) return 'leave-alone' // Koto が置いたままだと確かめられない
  if (now === next) return 'up-to-date'
  // 新しい版のときだけ差し替える（古い版を配って、直したものを巻き戻さない）。
  // **文字列で比べないこと**（`'2026-09-24.9' > '2026-09-24.10'` は true になる）
  return compareDataLayerStamp(next, now) > 0 ? 'replace' : 'up-to-date'
}

/**
 * データ層のファイルが要るなら置く。**既にあるものは、Koto が置いた印が付いていて
 * 版が古いときだけ差し替える**（印が無ければ触らず `needsUpdate` で知らせる）。
 *
 * ── 置く条件（2026-09-23 に直した。実機でアプリが起動しなくなった件）──────
 * 以前は「**すでに** koto-data を使っているファイルがあるか」だけを見ていた。
 * だが Koto がこれを置くのは、**これから**「koto-data を使う形に書き直して」と
 * AI に頼む直前である。その時点で使っている箇所は当然0件なので、**必ず素通りし、
 * ファイルは一度も置かれなかった**。AI は存在しないファイルからの読み込みを
 * 頼まれ、書き直しを完了できないまま「完了しました」と答え続けた。
 *
 * だから条件を「**もう使っている（usedBy）か、これから要る（writesFiles）か**」
 * に変える。自分でファイルに書き込んでいるアプリは、書き直し先がこれである。
 *
 * **メモリだけに持つアプリ（keepsInMemory）も「これから要る」側に数える**（2026-10-01）。
 * ③公開の「AIに書き直してもらう」は、ここが `ready` を返さないと依頼文を送らない
 * （askAiRewritePlan）。数えないと、メモリの警告は出るのに、直す導線のボタンだけが
 * 「保存の部品を用意できませんでした」で必ず失敗する。
 *
 * @param publishRootDir 公開の根（`public/` があればその中）。ここへ置く。
 * @param projectDir プロジェクト直下。**渡すと package.json をここまで上へ探す**
 *   （`public/` に package.json が無い構成で形を誤らないため・2026-09-23 検分）。
 */
export function ensureDataLayer(publishRootDir: string, projectDir?: string): EnsureDataLayerResult {
  const none = (kind: ModuleKind): EnsureDataLayerResult =>
    ({ placed: false, ready: false, file: null, moduleKind: kind, replaced: false, needsUpdate: false })
  if (!publishRootDir) return none('cjs')
  // **形を決める前に走査する。** 読み込む側のファイル（`server.mjs` 等）の
  // 拡張子が決め手になることがあり、それを知らずに置くと読み込めない（2026-09-23 検分）
  const scan = scanDataUsage(publishRootDir)
  const targets = [...scan.usedBy, ...scan.writesFiles.map(w => w.file), ...scan.keepsInMemory.map(w => w.file)]
  // **アプリの形に合う方を置く。** require のアプリに import 版を置いても
  // 読み込めず、AI が package.json を書き換えて起動しなくなる（2026-09-23 実機）
  const moduleKind = projectModuleKind(publishRootDir, { projectDir, targets })
  const file = dataLayerFileFor(moduleKind)
  const dest = path.join(publishRootDir, file)
  const source = templatePath(file)
  // **勝手には上書きしない**（差し替えられている可能性がある）。印が一致する＝
  // Koto が置いたままのものだけ、新しい版へ差し替える（判断は dataLayerPlacement）
  if (fs.existsSync(dest)) {
    const decision = dataLayerPlacement(readTextOrNull(dest), readTextOrNull(source) ?? '')
    if (decision !== 'replace') {
      return { placed: false, ready: true, file, moduleKind, replaced: false, needsUpdate: decision === 'leave-alone' }
    }
    // 置いたファイルには書き込み権限が無いことがある（下で読み取りだけを足しているため）
    try { fs.chmodSync(dest, (fs.statSync(dest).mode & 0o7777) | 0o200) } catch { /* 変えられなくても試す */ }
    try {
      copyTemplate(source, dest)
    } catch {
      // 差し替えられなくても、読み込み先はある。**画面に知らせて利用者に選ばせる**
      return { placed: false, ready: true, file, moduleKind, replaced: false, needsUpdate: true }
    }
    return { placed: true, ready: true, file, moduleKind, replaced: true, needsUpdate: false }
  }
  if (targets.length === 0) return none(moduleKind)
  copyTemplate(source, dest)
  return { placed: true, ready: true, file, moduleKind, replaced: false, needsUpdate: false }
}

/** 読めなければ null（**「無い」と「読めない」を同じに扱う**）。 */
function readTextOrNull(file: string): string | null {
  try { return fs.readFileSync(file, 'utf-8') } catch { return null }
}

/**
 * テンプレートを複製して、**読み取りだけを足す。**
 *
 * copyFileSync は元の権限を引き継ぐため、アプリの中の（asar 内の）テンプレートに
 * よっては 0600 で置かれる。それがそのままコンテナへ入ると、Node が自分のファイルを
 * 読めず `EACCES: permission denied, open '/app/koto-data.js'` で起動に失敗する
 * （2026-08-14 実機。原因が容器の中にあるので、症状から辿るのが非常に難しい）。
 * 書き込み権限は与えない。ここは利用者のプロジェクト内のファイルなので、
 * **必要な分だけ**にする（Ryosuke の点検・2026-08-14）。
 */
function copyTemplate(source: string, dest: string): void {
  fs.copyFileSync(source, dest)
  try {
    const mode = fs.statSync(dest).mode & 0o7777
    if ((mode & 0o444) !== 0o444) fs.chmodSync(dest, mode | 0o444)
  } catch { /* 権限を変えられなくても置けてはいる */ }
}
