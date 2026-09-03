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
import { isSecretFile, BUILD_CONFIG_FILES } from '../shared/publishExclude'
import { detectRuntime } from '../shared/runtimeDetect'
import { resolvePublishRoot } from './publishRootRenderer'

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
    ? `前回の確認: ${when} ✅ 問題なし`
    : `前回の確認: ${when} ⚠️ 要確認（修正の提案あり）`
}

export interface SecurityCheckResult {
  verdict: 'ok' | 'warn' | 'skip' // 問題なし / 要確認 / チェック未実施
  report: string
  /** どちらとして検査したか（skip のときは無い）。 */
  mode?: CheckMode
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
const TARGET_RE = /\.(html?|php|js|mjs|cjs|css|json|ya?ml|sh)$|(^|\/)(Dockerfile|\.htaccess)$/i
// 中身を読むまでもなく公開NGなファイル名。判定の中心は publishExclude.ts の isSecretFile
// （公開から除外する定義と同じものを使う）。名前に credentials / secret を含むものも足す。
const SECRET_HINT_RE = /credentials|secret/i

/**
 * Koto が管理するビルド設定か。**ユーザーの作成物ではないので検査しない。**
 *
 * rc.2 実機（2026-08-21 Ryosuke 指摘）で、AI がビルド設定に「COPY . は全ファイルを
 * 公開してしまう」と指摘した。だがそれは Koto 自身の責任範囲で、そのまま配信される
 * 公開先には入れない（publishExclude.ts・v0.3.38 で 404 を実測済み）。利用者には
 * 直せない上に Koto の設計と矛盾する助言になるため、対象から外す。名簿は一元定義を使う。
 */
function isKotoBuildConfig(relPath: string): boolean {
  const base = relPath.split('/').pop() ?? relPath
  return (BUILD_CONFIG_FILES as readonly string[]).includes(base)
}

/** そのファイルが「名前だけで公開NGと分かる」ものか。中身は読まない。 */
function looksSecret(relPath: string): boolean {
  const base = relPath.split('/').pop() ?? relPath
  return isSecretFile(base) || SECRET_HINT_RE.test(relPath)
}

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
  const secretFiles = files.filter(f => looksSecret(f) && f !== '.sakuraide.json')
  let targets = files.filter(f => TARGET_RE.test(f) && !looksSecret(f) && !isKotoBuildConfig(f))
  if (entry && files.includes(entry) && !looksSecret(entry)) {
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
/** AIへの依頼文に載せる others の上限。 */
const OTHERS_PROMPT_LIMIT = 80
/** 報告末尾「中身を確認していないファイル」に載せる上限（dataLike + others 合算）。 */
const UNCHECKED_NOTE_LIMIT = 50
/** 報告先頭の dataLike 固定文に載せる上限。 */
const DATA_LIKE_NOTE_LIMIT = 20

/**
 * 名前一覧を先頭 n 件に切り、超過分は「ほかN件」の1行にまとめる（純関数）。
 * 上限以下ならそのまま返す（「ほか0件」のような無意味な注記は付けない）。
 */
export function capList(names: readonly string[], n: number): string[] {
  if (names.length <= n) return [...names]
  return [...names.slice(0, n), `ほか${names.length - n}件`]
}

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
 */
export const DATA_FILE_RE = /\.(sql|db|sqlite|sqlite3|csv|tsv|bak|old|log|dump|zip|tar|gz|tgz|7z)$|~$|\.orig$/i

/**
 * 検査対象（targets）にも、名前だけで公開NGと分かるもの（secretFiles）にも入らなかった
 * 残りを、危険度で dataLike（機械的に警告する）／others（名前だけAIに判定させる）へ分ける（純関数）。
 *
 * Koto 自身のビルド設定（Dockerfile 等）は targets と同じ理由でここでも除く
 * （利用者には直せない・Koto の設計と矛盾する助言になるため。2026-08-21 rc.2 決定）。
 */
export function classifyUnchecked(
  files: readonly string[],
  targets: readonly string[],
  secretFiles: readonly string[],
): { dataLike: string[]; others: string[] } {
  const checked = new Set<string>([...targets, ...secretFiles])
  const dataLike: string[] = []
  const others: string[] = []
  for (const f of files) {
    if (checked.has(f) || isKotoBuildConfig(f)) continue
    ;(DATA_FILE_RE.test(f) ? dataLike : others).push(f)
  }
  return { dataLike, others }
}

/** AIへ渡すかたまり。長いファイルは複数に分かれる。 */
export type Piece = { file: string; part: number; total: number; text: string }

/**
 * 1ファイルを、送れる大きさのかたまりに分ける（純関数）。
 * できるだけ行の切れ目で分ける（途中で切ると、その行が読めなくなる）。
 */
export function splitIntoPieces(file: string, content: string, chunkChars = CHUNK_CHARS): Piece[] {
  const texts: string[] = []
  let rest = content
  while (rest.length > chunkChars) {
    const window = rest.slice(0, chunkChars)
    const nl = window.lastIndexOf('\n')
    const cut = nl > chunkChars / 2 ? nl + 1 : chunkChars // 行頭が遠すぎるときは諦めて切る
    texts.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  texts.push(rest)
  return texts.map((text, i) => ({ file, part: i + 1, total: texts.length, text }))
}

/** かたまりの見出し。分かれているファイルは何分割目かを書く。 */
export function pieceHeader(p: Piece): string {
  return p.total > 1 ? `--- ${p.file}（${p.part}/${p.total}）---` : `--- ${p.file} ---`
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
): { batches: Piece[][]; skipped: string[] } {
  const batches: Piece[][] = []
  let cur: Piece[] = []
  let size = 0
  for (const p of pieces) {
    if (cur.length && size + p.text.length > batchChars) { batches.push(cur); cur = []; size = 0 }
    cur.push(p)
    size += p.text.length
  }
  if (cur.length) batches.push(cur)
  const kept = batches.slice(0, maxBatches)
  const dropped = batches.slice(maxBatches).flat()
  const skipped = [...new Set(dropped.map(p => p.file))]
    // 一部でも確認できたファイルは「確認していない」とは言わない
    .filter(f => !kept.flat().some(p => p.file === f))
  return { batches: kept, skipped }
}

/**
 * 複数回の結果を1つにまとめる（純関数）。
 *
 * 判定は**安全側**（1回でも「要確認」なら全体で「要確認」）。
 * 本文は、その判定に対応する回のものだけを集める（「要確認」の中に
 * 「問題ありませんでした」を混ぜない）。同じ指摘の重複も落とす。
 *
 * ── 対象外ファイルの正直化を合成する（roadmap #17・案2）───────────────────
 * `dataLike`（machine 判定・classifyUnchecked）が1件でもあれば、**AIの判定に
 * 関わらず**全体を「要確認」に倒す（安全側・「迷ったら警告」・CLAUDE.md 掟10）。
 * `truncated`（ファイル一覧そのものが打ち切られていた）も同様に要確認へ倒す。
 * 中身を確認していない事実（dataLike・others）は、判定に関わらず必ず末尾へ書く
 * （黙って落とさない。packBatches の skipped と同じ形）。
 */
export function mergeCheckResults(
  results: readonly { verdict: 'ok' | 'warn' | 'skip'; report: string }[],
  info: {
    files: number
    batches: number
    skipped: readonly string[]
    /** 中身を確認していない「データっぽい」ファイル（classifyUnchecked）。1件でもあれば要確認に倒す。 */
    dataLike?: readonly string[]
    /** 中身を確認していない、データっぽくもないその他のファイル（名前だけAIに判定させる対象）。 */
    others?: readonly string[]
    /** ファイル一覧そのものが打ち切られていたか（fs:projectFilesInfo の truncated）。あれば要確認に倒す。 */
    truncated?: boolean
  },
): { verdict: 'ok' | 'warn' | 'skip'; report: string } {
  const dataLike = info.dataLike ?? []
  const others = info.others ?? []
  const truncated = info.truncated ?? false
  const forceWarn = dataLike.length > 0 || truncated

  const aiVerdict: 'ok' | 'warn' | 'skip' =
    results.some(r => r.verdict === 'warn') ? 'warn'
      : results.some(r => r.verdict === 'ok') ? 'ok' : 'skip'
  const verdict: 'ok' | 'warn' | 'skip' = forceWarn ? 'warn' : aiVerdict

  if (verdict === 'skip') {
    return { verdict, report: results[0]?.report ?? 'チェックを実施できませんでした。' }
  }

  // AIが未実施（機械的な理由だけで要確認に格上げされた）ときは、AIの本文を混ぜない
  const bodies = aiVerdict === 'skip'
    ? []
    : results.filter(r => r.verdict === aiVerdict).map(r => r.report.split('\n').slice(1).join('\n').trim())
  const lines: string[] = []
  for (const b of bodies) for (const line of b.split('\n')) {
    const s = line.trim()
    if (s && !lines.includes(s)) lines.push(s)
  }
  const head = verdict === 'warn' ? '判定: 要確認' : '判定: 問題なし'
  const note = aiVerdict === 'skip'
    ? null // AIは未実施なので「N個のファイルを確認しました」とは書かない（嘘になる）
    : info.batches > 1
      ? `（${info.files}個のファイルを${info.batches}回に分けて確認しました）`
      : `（${info.files}個のファイルを確認しました）`
  const skipNote = info.skipped.length
    ? [`※ 量が多いため、次のファイルは確認していません: ${info.skipped.join(', ')}`]
    : []
  // 指摘欄の先頭に固定文で入れる（AIの指摘より前・件数や打ち切り注記より後）。
  // 件数の肥大防止は capList（上限を超えても件数そのものは「ほかN件」で必ず残す）。
  const dataLikeNote = dataLike.length
    ? [`${capList(dataLike, DATA_LIKE_NOTE_LIMIT).join('、')}: 公開するとデータの中身が丸見えになる種類のファイルです（中身は確認していません）。公開が不要なら公開されるフォルダから移動してください`]
    : []
  const truncatedNote = truncated
    ? ['※ ファイルが多いため一覧は途中までです。チェックも全体の一部にとどまります']
    : []
  const uncheckedFiles = [...dataLike, ...others]
  const uncheckedNote = uncheckedFiles.length
    ? [`※ 中身を確認していないファイル: ${capList(uncheckedFiles, UNCHECKED_NOTE_LIMIT).join(', ')}`]
    : []
  return {
    verdict,
    report: [head, ...(note ? [note] : []), ...skipNote, ...dataLikeNote, ...lines, ...truncatedNote, ...uncheckedNote].join('\n'),
  }
}

/**
 * 検査の観点（純関数）。共通＋種別ごと。
 *
 * XSS は「HTML を返す」以上どちらにもあるので共通に置く。
 * アプリ専用の観点をサイトに混ぜない（的外れな指摘は利用者を混乱させる）。
 */
export function checkpointsFor(mode: CheckMode): string[] {
  const common = [
    'APIキー・パスワード・トークン等の秘密情報の直書き',
    '公開すべきでないファイルや個人情報の混入',
    'XSS（ユーザー入力をエスケープせずHTMLへ出力 等）',
  ]
  const byMode = mode === 'node'
    ? [
        '訪問者の入力を、そのままコマンド・ファイルパス・データの問い合わせに使っていないか（命令の混入・パス遡り）',
        '誰でも呼べてしまう管理・削除などの危険な操作が無いか（認証・確認の無い変更系の口）',
        'エラー時にスタックトレースや内部のパス等をそのまま返していないか',
      ]
    : [
        'フォームの送信先・外部スクリプトの読み込み元が安全か',
      ]
  return [...common, ...byMode, 'その他、公開して問題になりうる点']
}

/** AIへ送る依頼文を組み立てる（純関数）。 */
export function buildCheckPrompt(opts: {
  mode: CheckMode
  entry?: string | null
  secretFiles: readonly string[]
  parts: readonly string[]
  /** 分けて渡しているか。AIに伝えて「途中で切れている」と指摘させない。 */
  split?: boolean
  /**
   * 検査対象にも secretFiles にも入らなかった、その他のファイル名（classifyUnchecked の others）。
   * **中身は絶対に渡さない**（2026-08-09 の .env 事故の原則）。名前だけを見せ、
   * 名前から疑いがあるものだけを指摘させる。
   */
  others?: readonly string[]
}): string {
  const intro = opts.mode === 'node'
    ? `以下は公開予定のアプリ（サーバーで実行される Node.js。入口は ${opts.entry ?? '不明'}）のファイルです。公開前のセキュリティチェックをしてください。`
    : '以下は公開予定の静的Webサイト（ファイルがそのまま配信される）のファイルです。公開前のセキュリティチェックをしてください。'
  return (
    intro + '\n\n' +
    '観点：\n' +
    checkpointsFor(opts.mode).map(c => `- ${c}`).join('\n') + '\n\n' +
    '出力形式（厳守）：\n' +
    '1行目: 「判定: 問題なし」または「判定: 要確認」\n' +
    '2行目以降: 指摘の箇条書き（最大5件、各行「ファイル名: 内容と対処」。問題なしの場合は確認した観点を1〜2行で）\n' +
    // rc.3 実機で、問題の無い確認結果まで箇条書きに混ざり、体裁の助言（type属性 等）も
    // 並んでいた。**指摘欄には問題だけ**を書かせる（2026-08-21 Ryosuke 報告）
    '- 「要確認」のときは、指摘欄には**問題がある項目だけ**を書く（問題の無い確認結果は書かない）\n' +
    '- セキュリティに関係しない指摘（体裁・表記・リンク切れ・属性の書き方など）は書かない\n' +
    '- 報告以外の文章（思考の経過・英語のメモ）は書かない\n\n' +
    // 切ったのは Koto の都合。**それを指摘として書かせない**（rc.3 実機で
    // 「全文を取得して確認すること」が指摘欄を埋めていた）
    (opts.split
      ? '※ ファイルは複数回に分けてお渡ししています（見出しの（1/2）等がその印）。**渡された範囲だけで判断し、「途中で切れている」「全文を確認せよ」とは書かないでください**（こちらの都合です。ほかの部分は別の回に確認します）。\n\n'
      : '') +
    (opts.secretFiles.length ? `※ 次のファイルは名前からして公開NGの可能性が高い: ${opts.secretFiles.join(', ')}\n\n` : '') +
    // 対象外ファイルの「素通り」対策（roadmap #17・案2）。中身はコードとして確認しないが、
    // 名前だけは渡し、そこから疑わしいものがあれば拾わせる（中身は絶対に渡さない）。
    // 件数の肥大防止は capList（上限を超えても件数そのものは「ほかN件」で必ず残す）。
    (opts.others?.length ? `※ 次のファイルは公開されますが、中身はコードとして確認していません。名前から個人情報・秘密・残骸（不要なバックアップ等）の疑いがあるものだけ指摘してください（中身は見なくてよい）: ${capList(opts.others, OTHERS_PROMPT_LIMIT).join(', ')}\n\n` : '') +
    opts.parts.join('\n\n')
  )
}

/**
 * AIの生の応答から、報告の部分だけを取り出す（純関数）。
 *
 * 推論型モデルは maxTokens を推論が使い切ると本文が空になり、IPC 側
 * （chatContent.ts の pickContent）が推論の文章で代替する。それをそのまま
 * 見せると**英語の思考が結果として表示される**（2026-08-21 rc.1 実機・
 * Ryosuke 報告。🗂 まとめ（v0.3.37）とまったく同じ形）。
 * まとめと同じ「目印方式」で、「判定:」の**最後の出現**以降だけを受理する。
 * 目印が無い応答（思考だけで切れた等）は不採用にする。
 */
export function extractCheckReport(raw: string): string | null {
  const i = Math.max(raw.lastIndexOf('判定:'), raw.lastIndexOf('判定：'))
  if (i === -1) return null
  // **後ろ側も切る**（2026-08-21 rc.3 実機・Ryosuke 報告）。報告を書いたあとに
  // 思考へ戻る応答があり、`Wait, the bullet format for no issues?…` が
  // 利用者向けの文の末尾にぶら下がっていた。前だけ切っても足りない。
  const lines = raw.slice(i).split('\n')
  const kept: string[] = []
  for (let n = 0; n < lines.length; n++) {
    if (n > 0 && !looksLikeReportLine(lines[n])) break
    kept.push(lines[n])
  }
  const report = kept.join('\n').trim()
  return report || null
}

/**
 * 報告として読める行か（純関数）。思考の続きを見分けるために使う。
 *
 * 報告は「判定:」「箇条書き」「番号」「日本語で始まる行」「ファイル名: …」の
 * どれか。それ以外の英文（`Wait, …` `We need …`）は思考なので、そこで切る。
 */
function looksLikeReportLine(line: string): boolean {
  const s = line.trim()
  if (!s) return true                                   // 空行は報告の一部として通す
  if (/^[-*・●]/.test(s)) return true                    // 箇条書き
  if (/^\d+[.)]/.test(s)) return true                   // 番号付き
  if (/^[^\x00-\x7F]/.test(s)) return true             // 日本語などで始まる
  if (/^[\w./@-]+\.[A-Za-z0-9]+\s*[:：]/.test(s)) return true  // 「ファイル名: …」
  return false
}

/**
 * AIの回答1行目から判定を決める（純関数）。
 *
 * **「要確認」を優先する。** 以前は `includes('問題なし')` だけを見ていたため、
 * 「判定: 要確認（一部は問題なし）」のような書き方をされると **ok** になっていた。
 * 迷ったら警告側に倒すのが、この種の判定の正しい既定である。
 */
export function judgeVerdict(report: string): 'ok' | 'warn' {
  const firstLine = report.split('\n')[0] ?? ''
  if (firstLine.includes('要確認')) return 'warn'
  return firstLine.includes('問題なし') ? 'ok' : 'warn'
}

export async function runSecurityCheck(
  projectDir: string,
  apiKey: string,
  /** 実況（何をしているか）。時間がかかるので、待つ側に見せる（2026-08-21 Ryosuke 指摘）。 */
  onProgress?: (msg: string) => void,
): Promise<SecurityCheckResult> {
  // 見るのは**実際に公開されるもの**（`public/`。無ければプロジェクト直下）。
  // ここがずれると「チェックは通ったのに、公開すると別の中身」になる。
  projectDir = (await resolvePublishRoot(projectDir)) || projectDir
  if (!apiKey) return { verdict: 'skip', report: 'APIキーが未設定のため、セキュリティチェックを省略しました。' }
  const budget = checkBeforeRequest(apiKey)
  if (!budget.allowed) return { verdict: 'skip', report: 'AI利用上限に達しているため、セキュリティチェックを省略しました。' }

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
    const info = await window.electronAPI.fs.projectFilesInfo(projectDir, { maxFiles: SECURITY_CHECK_MAX_FILES, publishView: true })
    files = info.files
    truncated = info.truncated
  } catch { /* 取得失敗は下でskip */ }

  // サイトかアプリかを自動で決める（判定は runtimeDetect に一元化。ここで独自に見ない）。
  // 「package.json はあるのに入口が見つからない」（unsupported）は作りかけのアプリと
  // みなし、観点が多いアプリ側で検査する（安全側）。
  let packageJson: unknown | null = null
  try { packageJson = JSON.parse(await window.electronAPI.fs.readFile(`${projectDir}/package.json`)) } catch { /* 無ければ静的 */ }
  const choice = detectRuntime({ packageJson, fileNames: files.filter(f => !f.includes('/')) })
  const mode: CheckMode = choice.kind === 'static' ? 'static' : 'node'
  const entry = choice.kind === 'node' ? choice.entry : null

  // 機械的に分かる危険（.env等）は名前だけを指摘に含める。**中身は送らない。**
  const { targets, secretFiles } = pickCheckTargets(files, entry)
  // 対象外の残り（拡張子の許可リストに合わないもの）を「素通り」させない（roadmap #17・案2）。
  // dataLike は機械的に警告、others は名前だけAIに判定させる（中身は渡さない）。
  const { dataLike, others } = classifyUnchecked(files, targets, secretFiles)
  if (!targets.length && !secretFiles.length && !dataLike.length && !others.length) {
    return { verdict: 'skip', report: 'チェック対象のコードファイルが見つかりませんでした。' }
  }

  onProgress?.(`${targets.length}個のファイルを読んでいます…`)
  const pieces: Piece[] = []
  for (const f of targets) {
    try {
      pieces.push(...splitIntoPieces(f, await window.electronAPI.fs.readFile(`${projectDir}/${f}`)))
    } catch { /* 読めないファイルはスキップ */ }
  }
  const { batches, skipped } = packBatches(pieces)
  // 読む中身が無くても、secretFiles・others の「名前だけ」をAIへ見せたいことがある
  // （例: プロジェクトが customers.csv・server.py だけで、コードとして読む対象が無い）。
  // その場合も最低1回はAIに渡す（そうしないと、それらの指摘が一度もAIの目に触れない）。
  if (!batches.length && (secretFiles.length || others.length)) batches.push([])
  const split = pieces.some(p => p.total > 1) || batches.length > 1

  const model = getDefaultModel()
  const results: { verdict: 'ok' | 'warn' | 'skip'; report: string }[] = []
  // 利用量の歯止めは**全体予算のブロック（checkBeforeRequest）に一本化**する
  // （2026-08-21 Ryosuke 指定）。この機能だけが回ごとに独自の判断を持つと、
  // 「どこで止まるのか」が場所ごとに違ってしまう。開始時に1度見れば足りる。
  for (let i = 0; i < batches.length; i++) {
    // 実測で1分を超えることもある（2026-08-21 Ryosuke）。**短く言い切らない**
    const nth = batches.length > 1 ? `（${i + 1}/${batches.length}回目・少々時間がかかります）` : '（少々時間がかかります）'
    onProgress?.(mode === 'node'
      ? `AIがアプリとして確認しています…${nth}`
      : `AIがサイトとして確認しています…${nth}`)
    // 秘密ファイル・対象外ファイルの名前は1回目にだけ載せる（毎回載せると同じ指摘が並ぶ）
    const userPrompt = buildCheckPrompt({
      mode, entry, split,
      secretFiles: i === 0 ? secretFiles : [],
      others: i === 0 ? others : [],
      parts: batches[i].map(p => `${pieceHeader(p)}\n${p.text}`),
    })
    try {
      const res = await window.electronAPI.sakura.chat({
        apiKey,
        model,
        messages: [
          { role: 'system', content: 'あなたはWebセキュリティのレビュアーです。日本語のみで、指定された出力形式に厳密に従ってください。' },
          { role: 'user', content: userPrompt },
        ],
        // 推論型モデル（gpt-oss / Kimi 等）は考えるだけで上限を使い切り、
        // 判定を書き始める前に打ち切られる（800→2048 でも rc.1 実機で再発）。
        // 🗂 まとめ（v0.3.37）と同じく 4096 まで確保する。
        maxTokens: 4096,
        temperature: 0.2,
      })
      const raw = (res.content ?? '').trim()
      recordUsage(apiKey, model, res.usage?.prompt_tokens ?? estimateTokens(userPrompt), res.usage?.completion_tokens ?? estimateTokens(raw))
      // 目印方式: 「判定:」の最後の出現以降だけを受理。推論の文章を利用者に見せない
      const report = raw ? extractCheckReport(raw) : null
      results.push(report
        ? { verdict: judgeVerdict(report), report }
        : { verdict: 'skip', report: 'AIの応答から判定を読み取れませんでした（考える量が多すぎた可能性があります）。もう一度お試しください。' })
    } catch (e: any) {
      // チェック失敗で公開を止めない（skip扱い。ユーザーには表示する）
      results.push({ verdict: 'skip', report: `チェックに失敗しました（${e?.message ?? e}）。` })
    }
  }

  const merged = mergeCheckResults(results, {
    files: targets.length,
    batches: batches.length,
    skipped,
    dataLike,
    others,
    truncated,
  })
  return { ...merged, mode }
}
