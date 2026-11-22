// 公開前セキュリティチェック：プロジェクトの主要ファイルをAIがレビューし、
// 秘密情報の直書き・XSS・公開すべきでないファイル等を公開前に検出する。
// （開発時の「作りながら担保」を補完する、節目のチェック）
//
// 入口は2つ（公開の直前の自動実行と、公開フローの 🛡 節＝SecurityCheckSection）。
// **実体はこの runSecurityCheck ただ1つ**（掟10: 入口が増えても実装は増やさない）。
//
// ── サイトとアプリで観点を変える（2026-08-21 Ryosuke 提案）────────────────
// 静的サイトは「置いたファイルが全部そのまま見える」ので、露出（秘密・個人情報・
// 送信先）が主な危険。Node アプリは「サーバーでコードが実行される」ので、
// 訪問者の入力の悪用（命令の混入・パス遡り・認証の無い操作）が主な危険。
// どちらとして検査するかは runtimeDetect が自動で決める（利用者には選ばせない）。

import { checkBeforeRequest, recordUsage, estimateTokens, getDefaultModel } from './usage'
import { looksSecretByName } from '../shared/publishExclude'
import { LOCKFILE_RE, ASSET_FILE_RE, isKotoBuildConfig } from '../shared/publishScanTargets'
import { maskSecretShapes } from '../shared/secretShapes'
import { capList } from '../shared/capList'
import { checkpointsFor, pieceHeader, buildAiCheckPrompt, AI_CHECK_SYSTEM, OTHERS_PROMPT_LIMIT, SECRET_PROMPT_LIMIT } from '../shared/aiCheckPrompt'
import { parseAiReply, type SentPiece, type SentName } from '../shared/aiCheckReply'
import type { AiFinding } from '../shared/aiCheckFindings'
import { isServedPath } from '../shared/securityFindings'
import { mergeCheckResults, publishedSecretFiles, type BatchResult } from './aiCheckMerge'
import { detectRuntime } from '../shared/runtimeDetect'
import { resolvePublishRoot } from './publishRootRenderer'
import { failureText } from '../shared/failureText'
import { NOTHING_TO_CHECK_REPORT, OVER_LIMIT_REPORT } from './aiCheckEstimate'
import { wrapFailureText } from '../shared/failureDetail'

/** どちらとして検査するか。 */
export type CheckMode = 'static' | 'node'

/**
 * 前回の確認の記録（**最新の1件だけ**・2026-08-21 Ryosuke 提案）。
 *
 * 公開の画面を閉じると結果が消えるので、**最後にいつ確認したのか分からなくなる**。
 * 古い「問題なし」が残っていること自体が判断の材料になるので、日時を残す。
 * 残すのは日時と判定だけ（指摘の中身は残さない）。
 */
export type CheckRecord = { at: string; verdict: 'ok' | 'warn' }

/** 記録の置き場所（プロジェクトごと）。**直書きしない**ための1箇所。 */
export function checkRecordKey(projectDir: string): string {
  return `koto_seccheck:${projectDir}`
}

/** 記録を見出しの1行にする（純関数）。記録が無い・壊れているときは null。 */
export function formatCheckRecord(rec: CheckRecord | null | undefined): string | null {
  if (!rec || (rec.verdict !== 'ok' && rec.verdict !== 'warn')) return null
  const d = new Date(rec.at)
  if (Number.isNaN(d.getTime())) return null
  const when = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return rec.verdict === 'ok'
    ? `前回の AI の確認: ${when} ✅ 問題なし`
    : `前回の AI の確認: ${when} ⚠️ 要確認`
}

/**
 * 結果の文の1かたまり。**AI が書いた行（ai: true）と、Koto が組み立てた行（ai: false）を分けて持つ**。
 * Koto の行にはファイル名が入る。AI の文と同じに解釈すると、名前の中の ** や ` が太字・コードになり、
 * 実在しない名前に見える。画面は ai: true だけを太字・箇条書きに描き、ai: false は文字のまま出す。
 */
export interface ReportPart {
  text: string
  ai: boolean
  /** 付いている行は、続くものをまとめて閉じた <details> に入れて描く。この文が <summary> になる。 */
  fold?: string
}

export interface SecurityCheckResult {
  verdict: 'ok' | 'warn' | 'skip' // 問題なし / 要確認 / チェック未実施
  /** 全文（コピー・「AIに修正させる」に渡す元の文）。parts を改行でつないだもの。 */
  report: string
  /**
   * report を AI の行と Koto の行に分けたもの（画面で描き分ける用）。
   * 無いとき（Koto が返す一言だけの結果）は、report 全体を Koto の文として扱う（reportParts）。
   */
  parts?: ReportPart[]
  /** どちらとして検査したか（skip のときは無い）。 */
  mode?: CheckMode
  /** AI の指摘（全部）。「AIに修正させる」の材料。 */
  findings?: AiFinding[]
}

/** 画面に描くための分け方。parts が無ければ report 全体を Koto の文（解釈しない）として返す。 */
export function reportParts(result: { report: string; parts?: readonly ReportPart[] }): ReportPart[] {
  return result.parts && result.parts.length ? [...result.parts] : [{ text: result.report, ai: false }]
}

// ── 全部を見る（2026-08-21 rc.5 の設計見直し・Ryosuke 指摘）──────────────
// 以前は「先頭8ファイル・各6000文字」だけを1回で送っていた。つまり
// **9個目以降のファイルと、6000文字を超える部分は、何度押しても一度も見られない**。
// 実測（landingTEST）では menu.html 9,309文字のうち 3,309文字（36%）が対象外で、
// AI が「後半が確認できない」と指摘していたのは正しかった。
// いまは全ファイル・全文を、AIが一度に読める大きさに分けて**複数回**確認する。
/** 1つのかたまりの上限（長いファイルはここで分ける）。 */
const CHUNK_CHARS = 6000
/** 1回の問い合わせで送る合計の上限。従来の実績（約30,000文字/回）より控えめに取る。 */
const BATCH_CHARS = 24000
/** 問い合わせの回数の上限。**利用量が青天井にならないための歯止め**。 */
const MAX_BATCHES = 6

// ── 一覧取得の上限（roadmap #17 追補・2026-09-03 Ryosuke「200件で打ち切るのは正しいのか」）──
// fs:projectFilesInfo の既定 maxFiles=200 は「AIへ構成を伝える用途」の値で、この用途には
// そのまま流用してよい値ではなかった。コストが高いのは**中身をAIへ送る**ほうで、そこは
// 上の MAX_BATCHES × BATCH_CHARS が別に歯止めを持っている。**名前だけの走査**は数千件でも
// 安価なので、チェック用途では上限を実質撤廃する（5,000件。無制限にしないのは、極端に
// 巨大なフォルダで走査そのものが固まらないための最後の歯止め）。
const SECURITY_CHECK_MAX_FILES = 5000
// チェック対象（コード・設定ファイルを優先）
// md・txt・svg を含める（2026-09-03 Ryosuke 決定・案1）: どれもテキストなのでAIが読める。
// README.md やメモに個人情報・接続情報が書かれる実例があり、対象外のままでは警告できない。
// svg はXMLテキストでスクリプト混入がありうるため、同じ理由で中身を読む対象にする。
const TARGET_RE = /\.(html?|php|js|mjs|cjs|css|json|ya?ml|sh|md|txt|svg)$|(^|\/)(Dockerfile|\.htaccess)$/i
// 中身を読むまでもなく公開NGなファイル名の判定は publishExclude.ts の looksSecretByName（唯一の定義）。
// 依存の一覧（ロックファイル）・Koto のビルド設定・素材の拡張子の定義は shared/publishScanTargets.ts の1か所

/**
 * チェックにかけるファイルを選ぶ（純関数）。
 *
 * ── 秘密ファイルの中身は絶対にAIへ送らない（2026-08-09 の総点検で発覚）──────
 * 以前は TARGET_RE が `.env` にマッチしており、**`.env` の中身（APIキーやDBパスワード）が
 * さくらのAI Engine へ送信されていた**。名前だけで「公開NG」と判定できる（それが
 * secretFiles の役目）ので、中身を送る必要はまったく無い。
 *
 * 戻り値の targets は中身を読んで送るもの、secretFiles は**名前だけ**を伝えるもの。
 *
 * **件数では絞らない**（絞ると、その先は何度押しても見られない）。量の調整は
 * かたまりに分けて複数回に回すことで行う（packBatches）。
 *
 * @param entry アプリの入口ファイル（server.js 等）。**サーバーコードこそ検査の本丸**なので先頭に置く。
 */
export function pickCheckTargets(files: readonly string[], entry?: string | null): { targets: string[]; secretFiles: string[] } {
  const secretFiles = files.filter(f => looksSecretByName(f) && f !== '.sakuraide.json')
  let targets = files.filter(f => TARGET_RE.test(f) && !looksSecretByName(f) && !LOCKFILE_RE.test(f) && !isKotoBuildConfig(f))
  if (entry && files.includes(entry) && !looksSecretByName(entry)) {
    targets = [entry, ...targets.filter(f => f !== entry)]
  }
  return { targets, secretFiles }
}

// ── 名前一覧の肥大防止（roadmap #17 追補・2026-09-03）──────────────────────
// projectFilesInfo の上限を 200 → 5,000 へ引き上げた（下記 SECURITY_CHECK_MAX_FILES）ため、
// dataLike・others（名前しか使わない一覧）をそのまま依頼文・報告文に埋め込むと、
// 数千件規模のプロジェクトで文言が際限なく膨らむ。**件数そのものでは絞らない**
// （絞ると、それらのファイルの存在自体が利用者に伝わらなくなる＝黙って落とすのと同じ）。
// 表示件数だけを capList で抑え、超過分は「ほかN件」で必ず件数を残す。
// AIへの依頼文に載せる others・secretFiles の上限（OTHERS_PROMPT_LIMIT・SECRET_PROMPT_LIMIT）は shared にある。
// 名前一覧の切り方（capList）の定義は shared にある。呼び元は変えず、同じ名前で出し直す。
export { capList }

// ── 対象外ファイルの「素通り」をふさぐ（roadmap #17・2026-09-03 Ryosuke 発見・案2）───
// pickCheckTargets は拡張子の許可リストだけで検査対象を選ぶため、txt/csv/sql/db/bak/log/zip/py 等の
// **対象外ファイルは、公開されるのに検査もされず「確認していない」ことすら報告されていなかった**
// （実測: customers.csv・dump.sql・app.db・backup.zip・server.py が完全素通り。名前すらAIに渡らない）。
// 「量が多くて飛ばした」（packBatches の skipped）だけは正直に書く仕組みがあるのに、
// 「種類の対象外」は黙って落ちる——2026-08-21 rc.5 で直した「黙って落とさない」と同じ形の穴。

/**
 * 「公開先で丸見えになると危険度が高い」データ・残骸っぽい拡張子（一元定義）。
 *
 * ── 止めすぎない（CLAUDE.md 掟10）────────────────────────────────────────
 * `.md` `.txt` はここに入れない。README.md やメモは普通に置かれるものであり、
 * 毎回警告すると狼少年になる（「止めすぎも害」）。ここに入れるのは、公開されると
 * 中身がまるごと・構造化された形で丸見えになる危険度が明確なものだけ。
 * （md/txt は TARGET_RE 側に入っており、中身はAIが読んで確認する。2026-09-03 追記）
 */
export const DATA_FILE_RE = /\.(sql|db|sqlite|sqlite3|csv|tsv|bak|old|log|dump|zip|tar|gz|tgz|7z)$|~$|\.orig$/i

// ── 対象外ファイルを3分類にする（2026-09-03 Ryosuke 決定・案1）───────────────
// 実機 v0.6.1 で、画像が「※ 中身を確認していないファイル」に名指しで並ぶ違和感が
// 指摘された。画像はそもそもテキストとして中身を確認する対象になり得ない「表示用の
// 資産」であり、残骸の疑いがある others と同じ袋に入れると混乱の元になる。そこで
// assets を独立させ、名指しせず件数だけを伝える（mergeCheckResults）。

// 表示用の資産ファイルの定義は shared/publishScanTargets.ts の1か所（ここからも使えるよう再公開する）
export { ASSET_FILE_RE }

/**
 * 検査対象（targets）にも、名前だけで公開NGと分かるもの（secretFiles）にも入らなかった
 * 残りを、dataLike（機械的に警告する）／assets（表示用の資産・名指ししない）／
 * others（名前だけAIに判定させる）の3つへ分ける（純関数）。
 * 判定順は dataLike → assets → others（先勝ち。DATA_FILE_RE に合致すればそちらを優先する）。
 *
 * Koto 自身のビルド設定（Dockerfile 等）は targets と同じ理由でここでも除く
 * （利用者には直せない・Koto の設計と矛盾する助言になるため。2026-08-21 rc.2 決定）。
 */
export function classifyUnchecked(
  files: readonly string[],
  targets: readonly string[],
  secretFiles: readonly string[],
): { dataLike: string[]; assets: string[]; others: string[] } {
  const checked = new Set<string>([...targets, ...secretFiles])
  const dataLike: string[] = []
  const assets: string[] = []
  const others: string[] = []
  for (const f of files) {
    if (checked.has(f) || isKotoBuildConfig(f)) continue
    if (DATA_FILE_RE.test(f)) dataLike.push(f)
    else if (ASSET_FILE_RE.test(f)) assets.push(f)
    else others.push(f)
  }
  return { dataLike, assets, others }
}

/** AIへ渡すかたまり。長いファイルは複数に分かれる。 */
export type Piece = {
  file: string
  part: number
  total: number
  /** 伏せたあとの全文の中での、このかたまりの最初の行の番号（1 始まり）。行番号は text に混ぜない。 */
  startLine: number
  text: string
}

/**
 * 1ファイルを、AI へ送れる大きさのかたまりに分ける（純関数）。
 * できるだけ行の切れ目で分ける（途中で切ると、その行が読めなくなる）。
 *
 * ── 秘密に見える値は、**分ける前に**ファイル全体で伏せる（外へ送る前の唯一の関所）──────
 * かたまり（Piece）はここでしか作らないので、送る本文はみな伏せ字を通る。分けたあとにかけると、
 * かたまりの境目で複数行の秘密鍵が BEGIN と END に泣き別れ、伏せ字に当たらず本体がそのまま送られる。
 * 行数は変わらない（`maskSecretShapes` は既定で行数を保つ）。伏せ字は完全ではない
 * （形に当たらない固定の文字列は、そのまま残りうる）。
 */
export function splitIntoPieces(file: string, content: string, chunkChars = CHUNK_CHARS): Piece[] {
  const texts: string[] = []
  let rest = maskSecretShapes(content)
  while (rest.length > chunkChars) {
    const window = rest.slice(0, chunkChars)
    const nl = window.lastIndexOf('\n')
    const cut = nl > chunkChars / 2 ? nl + 1 : chunkChars // 行頭が遠すぎるときは諦めて切る
    texts.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  texts.push(rest)
  // 行の途中で切れたかたまり（改行の無い長い行）は、次のかたまりが同じ行の番号から始まる
  let line = 1
  return texts.map((text, i) => {
    const piece: Piece = { file, part: i + 1, total: texts.length, startLine: line, text }
    line += text.split('\n').length - 1
    return piece
  })
}

/** 1つのかたまりを依頼文に入れたときの本文の字数（各行の頭に付ける「行番号| 」を含む）。 */
function numberedSize(p: Piece): number {
  const lines = p.text.split('\n')
  const count = lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
  let n = p.text.length
  for (let i = 0; i < count; i++) n += String(p.startLine + i).length + 2
  return n
}

/**
 * かたまりを、1回ぶんずつの束に詰める（純関数）。
 *
 * 上限（maxBatches）を超えたぶんは **`skipped` に入れて、確認していないと明示する**。
 * 黙って落とさない（それが今回の元凶だった）。
 */
export function packBatches(
  pieces: readonly Piece[],
  batchChars = BATCH_CHARS,
  maxBatches = MAX_BATCHES,
): { batches: Piece[][]; skipped: string[]; partial: string[] } {
  const batches: Piece[][] = []
  let cur: Piece[] = []
  let size = 0
  for (const p of pieces) {
    const w = numberedSize(p)
    if (cur.length && size + w > batchChars) { batches.push(cur); cur = []; size = 0 }
    cur.push(p)
    size += w
  }
  if (cur.length) batches.push(cur)
  const kept = batches.slice(0, maxBatches)
  const dropped = batches.slice(maxBatches).flat()
  const keptFiles = new Set(kept.flat().map(p => p.file))
  const droppedFiles = [...new Set(dropped.map(p => p.file))]
  // 1つも束に入らなかったファイル（一部でも入ったファイルは、ここには入れない）
  const skipped = droppedFiles.filter(f => !keptFiles.has(f))
  // かたまりの一部だけが束に入り、残りが落ちたファイル（途中までしか送っていない）
  const partial = droppedFiles.filter(f => keptFiles.has(f))
  return { batches: kept, skipped, partial }
}

/**
 * 詰める順（純関数）。入口のファイルは先頭のまま、残りは送る量（かたまりの numberedSize の合計）が小さい順。
 * 同じ量なら、もとの並び（名前の順）を保つ。大きな1つのファイルが上限を使い切って、小さいファイルが
 * 1つも送られなくなるのを防ぐ。
 */
export function orderPiecesForPacking(pieces: readonly Piece[], entry: string | null): Piece[] {
  const files: string[] = []
  const size = new Map<string, number>()
  const byFile = new Map<string, Piece[]>()
  for (const p of pieces) {
    if (!size.has(p.file)) { files.push(p.file); byFile.set(p.file, []) }
    size.set(p.file, (size.get(p.file) ?? 0) + numberedSize(p))
    byFile.get(p.file)!.push(p)
  }
  const first = entry !== null && size.has(entry) && files[0] === entry ? [entry] : []
  const rest = files.filter(f => !first.includes(f))
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (size.get(a.f)! - size.get(b.f)!) || (a.i - b.i))
    .map(x => x.f)
  const order = [...first, ...rest]
  return order.flatMap(f => byFile.get(f) ?? [])
}

// 依頼文の見出し・検査の観点は shared にある。呼び元は変えず、同じ名前で出し直す。
export { checkpointsFor, pieceHeader }
export { mergeCheckResults, publishedSecretFiles }
export type { BatchResult }

/**
 * 計画（読むだけ）。通信しない・利用量を見ない・キーを受け取らない。
 * 実行（runAiCheck）は、この計画のとおりに送る。
 */
export interface AiCheckPlan {
  root: string
  mode: CheckMode
  entry: string | null
  /** 中身を送るファイルの数（読めなかったもの・量が多くて送らないものは数えない）。 */
  files: number
  batches: Piece[][]
  skipped: string[]
  /** 一部だけを送るファイル（量が多くて、かたまりの残りを送れない）。files には数える。 */
  partial: string[]
  secretFiles: string[]
  dataLike: string[]
  assets: string[]
  others: string[]
  truncated: boolean
  unreadable: string[]
  split: boolean
  /** 点検する対象が1つも無い。 */
  nothing: boolean
  /** 実行で送る依頼文（user の本文）の文字数の合計。 */
  promptChars: number
  /** 送る回数。 */
  requests: number
}

/** 1回ぶんの依頼文（user の本文）。計画の数え方と、実行の送り方が、ここ1か所を通る。 */
function promptForBatch(plan: Pick<AiCheckPlan, 'mode' | 'entry' | 'split' | 'secretFiles' | 'others'>, batch: readonly Piece[]): string {
  return buildAiCheckPrompt({
    mode: plan.mode,
    entry: plan.entry,
    split: plan.split,
    // 秘密ファイル・対象外ファイルの名前は**毎回**載せる。1回目だけにすると、1回目の返事を読めなかったとき、
    // 名前が一度もAIに届かない。同じ指摘が回ごとに並んでも、同じ行は合成で1つになる
    secretFiles: plan.secretFiles,
    others: plan.others,
    pieces: [...batch],
  })
}

/** 計画を立てる（根の解決 → 一覧 → 種別 → 選別 → 読み込み → 分割 → 束ね）。ここでは通信しない。 */
export async function planAiCheck(projectDir: string, onProgress?: (msg: string) => void): Promise<AiCheckPlan> {
  // 見るのは**実際に公開されるもの**（`public/`。無ければプロジェクト直下）。
  // ここがずれると「チェックは通ったのに、公開すると別の中身」になる。
  const root = (await resolvePublishRoot(projectDir)) || projectDir

  onProgress?.('「公開されるもの」を調べています…')
  let files: string[] = []
  // truncated: SECURITY_CHECK_MAX_FILES（5,000件）を超えた、または走査の深さ上限に
  // 実在するフォルダが引っかかった等で、一覧そのものが途中までしか取れていないか。
  // 部分検査が完全検査の顔をしないよう、正直に報告へ回す（roadmap #17・案2、追補で上限緩和）。
  let truncated = false
  try {
    // publishView: true で、除外規則を「公開と同じ定義」に揃える（roadmap #17 追補）。
    // 既定の走査は dist/build/out 等の非ドットフォルダやドット始まりフォルダを丸ごと
    // 飛ばすため、実際の公開経路（vercel/client.ts の collectDeployFiles・imageBuild.ts の
    // copyTree）が拾う中身がチェックの視界に入っていなかった（dist の sourcemap 等がすり抜けの典型）。
    const info = await window.electronAPI.fs.projectFilesInfo(root, { maxFiles: SECURITY_CHECK_MAX_FILES, publishView: true })
    files = info.files
    truncated = info.truncated
  } catch { /* 取得失敗は下で対象なしになる */ }

  // サイトかアプリかを自動で決める（判定は runtimeDetect に一元化。ここで独自に見ない）。
  // 「package.json はあるのに入口が見つからない」（unsupported）は作りかけのアプリと
  // みなし、観点が多いアプリ側で検査する（安全側）。
  let packageJson: unknown | null = null
  try { packageJson = JSON.parse(await window.electronAPI.fs.readFile(`${root}/package.json`)) } catch { /* 無ければ静的 */ }
  const choice = detectRuntime({ packageJson, fileNames: files.filter(f => !f.includes('/')) })
  const mode: CheckMode = choice.kind === 'static' ? 'static' : 'node'
  const entry = choice.kind === 'node' ? choice.entry : null

  // 機械的に分かる危険（.env等）は名前だけを指摘に含める。**中身は送らない。**
  const { targets, secretFiles } = pickCheckTargets(files, entry)
  // 対象外の残り（拡張子の許可リストに合わないもの）を「素通り」させない（roadmap #17・案2）。
  // dataLike は機械的に警告、others は名前だけAIに判定させる（中身は渡さない）。
  const { dataLike, assets, others } = classifyUnchecked(files, targets, secretFiles)
  const nothing = !targets.length && !secretFiles.length && !dataLike.length && !others.length

  const empty = (): AiCheckPlan => ({
    root, mode, entry, files: 0, batches: [], skipped: [], partial: [], secretFiles, dataLike, assets, others,
    truncated, unreadable: [], split: false, nothing, promptChars: 0, requests: 0,
  })
  if (nothing) return empty()

  onProgress?.(`${targets.length}個のファイルを読んでいます…`)
  const pieces: Piece[] = []
  // 読めなかったファイルは捨てずに控え、報告に「確認していない」と書く（黙って消さない）
  const unreadable: string[] = []
  for (const f of targets) {
    try {
      // プロジェクトの中のふつうのファイルだけを読む（リンクで外を指すものは読まず、読めなかった扱い）
      const r = await window.electronAPI.fs.readForWriteFix(root, f)
      if (r.state === 'text') pieces.push(...splitIntoPieces(f, r.content))
      else unreadable.push(f)
    } catch { unreadable.push(f) }
  }
  const { batches, skipped, partial } = packBatches(orderPiecesForPacking(pieces, entry))
  // 読む中身が無くても、secretFiles・others の「名前だけ」をAIへ見せたいことがある
  // （例: プロジェクトが customers.csv・server.py だけで、コードとして読む対象が無い）。
  // その場合も最低1回はAIに渡す（そうしないと、それらの指摘が一度もAIの目に触れない）。
  if (!batches.length && (secretFiles.length || others.length)) batches.push([])
  const split = pieces.some(p => p.total > 1) || batches.length > 1

  const plan: AiCheckPlan = {
    root, mode, entry,
    files: targets.length - unreadable.length - skipped.length,
    batches, skipped, partial, secretFiles, dataLike, assets, others, truncated, unreadable,
    split, nothing: false, promptChars: 0, requests: batches.length,
  }
  plan.promptChars = batches.reduce((n, b) => n + promptForBatch(plan, b).length, 0)
  return plan
}

/** 利用量の確かめ（全体予算のブロック）。呼ぶのはここ1か所。 */
export function aiCheckBudget(apiKey: string) {
  const budget = checkBeforeRequest(apiKey)
  return budget
}

/** 送る・読む・合成する間の、中止の置き場（この検査ぜんぶで1つ・掟10）。 */
interface StopControl {
  stopped: boolean
  abortCurrent: (() => void) | null
}

const STOPPED_REPORT = '簡易セキュリティチェックを中止しました。最後まで確認していません。'
const NO_KEY_REPORT = 'APIキーが未設定のため、セキュリティチェックを省略しました。'
const UNREADABLE_REPLY_REPORT = 'AI の返事を読み取れませんでした。もう一度試すか、設定で別のモデルを選んでください。'

async function executeAiCheck(
  plan: AiCheckPlan,
  apiKey: string,
  onProgress: ((msg: string) => void) | undefined,
  ctl: StopControl,
  warning?: string,
): Promise<SecurityCheckResult> {
  const { mode, batches } = plan
  const model = getDefaultModel()
  const results: BatchResult[] = []
  // 利用量の歯止めは**全体予算のブロック（checkBeforeRequest）に一本化**する
  // （2026-08-21 Ryosuke 指定）。この機能だけが回ごとに独自の判断を持つと、
  // 「どこで止まるのか」が場所ごとに違ってしまう。開始時に1度見れば足りる。
  for (let i = 0; i < batches.length; i++) {
    // 中止されたら、残りのかたまりへは進まない（1回あたり最悪およそ600秒あるので、
    // ここで抜けないと「中止したのに何分も終わらない」になる）。
    if (ctl.stopped) break
    // 実測で1分を超えることもある（2026-08-21 Ryosuke）。**短く言い切らない**
    const nth = batches.length > 1 ? `（${i + 1}/${batches.length}回目・少々時間がかかります）` : '（少々時間がかかります）'
    onProgress?.(mode === 'node'
      ? `AIがアプリとして確認しています…${nth}`
      : `AIがサイトとして確認しています…${nth}`)
    const batch = batches[i]
    const userPrompt = promptForBatch(plan, batch)
    // この回で送ったファイル。返事を読めなかったとき、確認できていないファイルとして報告に載せる
    const sentFiles = [...new Set(batch.map(p => p.file))]
    // 送ったものの控え。返事の照合は、この控えだけを根拠にする
    const sentPieces: SentPiece[] = batch.map(p => {
      const lines = p.text.split('\n')
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
      return { file: p.file, startLine: p.startLine, lines, served: isServedPath(mode, p.file) }
    })
    // 公開から外れる秘密らしい名前（.env など）は、AI が指摘しても取り上げない（中身を誰も見ていない）
    const published = new Set(publishedSecretFiles(plan.secretFiles))
    const sentNames: SentName[] = [
      ...plan.secretFiles.slice(0, SECRET_PROMPT_LIMIT).map(file => ({ file, served: isServedPath(mode, file), ignore: !published.has(file) })),
      ...plan.others.slice(0, OTHERS_PROMPT_LIMIT).map(file => ({ file, served: isServedPath(mode, file) })),
    ]
    try {
      // ★ 第2引数（onStart）を**必ず渡す**（2026-09-25 検分の指摘6）。
      //   preload の chat は invoke より先にこれを呼ぶので、返事が一度も返ってこない
      //   相手でも中断が届く。ここは sakura.chat の呼び出し元2つのうちの片方で、
      //   直前まで渡していなかった（もう片方は useAiChat.ts の chatOnce）。
      const res = await window.electronAPI.sakura.chat({
        apiKey,
        model,
        messages: [
          { role: 'system', content: AI_CHECK_SYSTEM },
          { role: 'user', content: userPrompt },
        ],
        // 推論型モデル（gpt-oss / Kimi 等）は考えるだけで上限を使い切り、
        // 判定を書き始める前に打ち切られる（800→2048 でも rc.1 実機で再発）。
        // 🗂 まとめ（v0.3.37）と同じく 4096 まで確保する。
        maxTokens: 4096,
        temperature: 0.2,
      }, (abort) => { ctl.abortCurrent = abort })
      const raw = (res.content ?? '').trim()
      recordUsage(apiKey, model, res.usage?.prompt_tokens ?? estimateTokens(userPrompt), res.usage?.completion_tokens ?? estimateTokens(raw))
      const parsed = parseAiReply(raw, { pieces: sentPieces, names: sentNames })
      results.push(parsed.state === 'ok'
        ? { state: 'ok', findings: parsed.findings, malformed: parsed.malformed, cut: parsed.cut, files: sentFiles }
        : { state: 'failed', report: UNREADABLE_REPLY_REPORT, files: sentFiles })
    } catch (e: any) {
      // 中止で切れた通信は「失敗」として数えない（押した本人に失敗を報告しない）。
      if (ctl.stopped) break
      // チェック失敗で公開を止めない（skip扱い。ユーザーには表示する）
      results.push({ state: 'failed', report: wrapFailureText(failureText(e, { readOnly: true }), t => `チェックに失敗しました（${t.replace(/。$/, '')}）。`), files: sentFiles })
    } finally {
      ctl.abortCurrent = null
    }
  }

  // 中止されたときは、途中までの結果を「確認できた」ことにしない（部分検査が
  // 完全検査の顔をしない・truncated と同じ考え方）。
  if (ctl.stopped) return { verdict: 'skip', report: STOPPED_REPORT, mode }

  const merged = mergeCheckResults(results, {
    files: plan.files,
    batches: batches.length,
    skipped: plan.skipped,
    partial: plan.partial,
    dataLike: plan.dataLike,
    assets: plan.assets,
    others: plan.others,
    truncated: plan.truncated,
    secretFiles: plan.secretFiles,
    unreadable: plan.unreadable,
    mode,
    warning,
  })
  return { ...merged, mode }
}

/** 計画のとおりに送り、返事を読み、結果にまとめる。 */
export async function runAiCheck(
  plan: AiCheckPlan,
  apiKey: string,
  onProgress?: (msg: string) => void,
  onAbortReady?: (abort: () => void) => void,
): Promise<SecurityCheckResult> {
  const ctl: StopControl = { stopped: false, abortCurrent: null }
  onAbortReady?.(() => { ctl.stopped = true; ctl.abortCurrent?.() })
  // 直に呼ばれても、キーが無い・上限に達しているときは1件も送らない（runSecurityCheck と同じ確かめ・同じ文）
  if (!apiKey) return { verdict: 'skip', report: NO_KEY_REPORT }
  const budget = aiCheckBudget(apiKey)
  if (!budget.allowed) return { verdict: 'skip', report: OVER_LIMIT_REPORT }
  return executeAiCheck(plan, apiKey, onProgress, ctl, budget.warning)
}

export async function runSecurityCheck(
  projectDir: string,
  apiKey: string,
  /** 実況（何をしているか）。時間がかかるので、待つ側に見せる（2026-08-21 Ryosuke 指摘）。 */
  onProgress?: (msg: string) => void,
  /**
   * 「中止」用の関数を受け取る（sakura.chat の onStart と同じ形・2026-09-25 検分の指摘6）。
   *
   * ⚠️ **この受け口は、止め方を画面に出すときに必ず繋ぐこと。**
   * 繋がないと、この検査は最悪で「NON_STREAM_TIMEOUT_MS × 再試行 × かたまりの数」
   * （既定でおよそ600秒 × 最大6回）のあいだ、利用者にはどうやっても止められない。
   * ipc/sakura.ts の activeChats に書いた戒めと同じ型の事故（＝口が2つあるのに
   * 片方しか配線しない）を、ここで繰り返さないための口である。
   *
   * 渡された関数は**いつ呼んでもよい**（要求を送る前でも、待っている最中でも）。
   * 呼ぶと、いま待っている問い合わせを切り、**残りのかたまりへ進まずに**戻る。
   *
   * 本番の呼び出し元（増えたら数え直す: `grep -rn 'runSecurityCheck(' src`）:
   *   (1) src/renderer/securityCheckFlow.ts の runAiFlow（【AIに確認してもらう】を押したときだけ）
   *      → 確認中に出る「⏹ 中止する」が、ここで受けた関数を呼ぶ
   */
  onAbortReady?: (abort: () => void) => void,
): Promise<SecurityCheckResult> {
  // ── 中止の置き場（この検査ぜんぶで1つ・掟10）──────────────────────────
  // ここで作って**最初の await より前に**渡す。あとから渡すと、いちばん止めたい
  // 「返ってこない」場面（要求は出たが返事が来ない）で空振りする
  // （engine.ts / preload.ts の「先に中断関数を渡す」と同じ理由）。
  const ctl: StopControl = { stopped: false, abortCurrent: null }
  onAbortReady?.(() => { ctl.stopped = true; ctl.abortCurrent?.() })

  if (!apiKey) return { verdict: 'skip', report: NO_KEY_REPORT }
  const budget = aiCheckBudget(apiKey)
  if (!budget.allowed) return { verdict: 'skip', report: OVER_LIMIT_REPORT }

  const plan = await planAiCheck(projectDir, onProgress)
  // W-12: 画面の呼び名「🛡 簡易セキュリティチェック」に揃える（「公開前チェック」との揺れを解消）。
  if (ctl.stopped) return { verdict: 'skip', report: STOPPED_REPORT, mode: plan.mode }
  if (plan.nothing) return { verdict: 'skip', report: NOTHING_TO_CHECK_REPORT }
  return executeAiCheck(plan, apiKey, onProgress, ctl, budget.warning)
}
