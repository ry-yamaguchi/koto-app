// leftoverData.ts — 書き直したあとに残る「いま入っているデータ」の判定と文面（純ロジック）。
//
// ── なぜ要るか（2026-09-23 実機・ScheduleAPP）──────────────────────────
// AI がアプリを koto-data へ書き直すと、**それまでに入力されたデータは引き継がれない**。
// 実機では合言葉が 2D88A8 → 8FC36D に変わった（アプリが古い保存を見つけられず作り直した
// ＝**配った合言葉が通じなくなる**）。中身が空だったので実害は無かったが、参加者が
// 入っていれば見えなくなっていた。
//
// ── なぜ「書き直したあと」に聞くのか（2026-09-24 Ryosuke さん決定）───────────
// 押した時点（書き直しを頼むとき）では、Koto は古いデータを見つけられない。保存先は
// コードの中で組み立てられており（path.join(DATA_DIR, 'schedule.json')）、文字列として
// 辿るのは当てにならない。中身が空かどうかも読めない。
// **書き直したあとなら確実に分かる。** 古いファイルはどのコードからも参照されなくなるので、
// 既にある「使われていないファイルの確認」（shared/unusedFiles.ts の findUnusedFiles）が
// 見つけられる。中身も読めるので、空か否かを見分けられる。
//
// ── ⚠️ 「中身がある」を件数だけで判断しない（作者の指摘・2026-09-23 夜）──────────
// 実機の古い保存は { "joinCode": "2D88A8", "dates": [], "entries": [] } だった。
// **日程0件・参加者0件で、合言葉だけ**が入っている。一覧の件数だけを見ると
// 「空だから知らせなくてよい」に倒れるが、**合言葉のような小さな設定は、消えると
// 利用者が困る**。空の配列・空のオブジェクト・空文字を除いて、中身のある値が
// 1つでもあれば知らせる。
//
// **画面には素のテキストとして出る。Markdown 記法は使わない**（v0.2.98 の教訓）。
// **画面にファイル名を出さない**（作者の指摘・2026-09-23。利用者はファイルを意識して
// いない。意識しているのは「自分が入れたデータ」である）。ファイル名を使ってよいのは
// **AI への依頼文だけ**——Koto が知っている事実を渡さないと、AI は記憶で答えて嘘をつく。

import type { ModuleKind } from './objectStorage'
import { dataLayerUsageLine, rewriteCheckDone, KEEP_SHAPE, type RewriteScan } from './storageNoticeText'

/**
 * 「データらしきファイル」の拡張子（**一元定義**・掟10）。
 *
 * ── なぜ securityCheck.ts の DATA_FILE_RE を使い回さないか ────────────────
 * あちらは「**公開すると丸見えになると危険**なデータ・残骸」の定義で、
 * .zip / .log / .bak / ~ まで含む一方、**.json を含まない**（設定ファイルとして
 * 普通に置かれるため）。ここで聞きたいのは「利用者が入力したデータが残っているか」で、
 * 中心にあるのはまさに .json である。目的が違う定義を兼用すると、
 * **公開の安全判定を動かした瞬間にこの問いが壊れる**ので、別に持つ。
 */
export const LEFTOVER_DATA_TEXT_EXTS = ['json', 'ndjson', 'csv', 'tsv'] as const
/** 中身をテキストとして読めない保存（大きさだけで判断する）。 */
export const LEFTOVER_DATA_BINARY_EXTS = ['db', 'sqlite', 'sqlite3'] as const

/** 拡張子（小文字・ドット無し）。無ければ空文字。 */
function extOf(rel: string): string {
  const base = String(rel ?? '').split('/').pop() ?? ''
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}

/** ファイル名だけ（小文字）。 */
function baseOf(rel: string): string {
  return (String(rel ?? '').split('/').pop() ?? '').toLowerCase()
}

/**
 * **設定ファイルは「利用者が入れたデータ」ではない**（2026-09-24 検分）。
 *
 * ここは拡張子だけを見ていたので、どこからも名前で参照されない設定
 * （`.eslintrc.json` のようなドット始まり、`vite.config.json`、`package.json` 等）が
 * 未使用の一覧に出ると、そのまま「💾 いま入っているデータをどうしますか」が出ていた。
 * 押されると依頼文がその設定ファイルを名指しして「中身を読み取って koto-data の保存へ」
 * と頼むことになり、**利用者から見て意味の分からない変更**が残る（元は消さないので
 * 被害は限定的だが、無駄な1往復になる）。
 *
 * **判定はここ1か所だけ**に置き、テストで固定する（掟10）。
 */
const LEFTOVER_CONFIG_NAMES = [
  'package.json', 'package-lock.json', 'composer.json', 'composer.lock',
  'tsconfig.json', 'jsconfig.json', 'manifest.json', 'vercel.json', 'now.json',
  'app.json', 'jest.config.json', 'renovate.json',
] as const

/** そのファイルは「設定」か（＝利用者が入れたデータではない）。 */
export function isLeftoverConfigFile(rel: string): boolean {
  const base = baseOf(rel)
  if (!base) return false
  // `.eslintrc.json` `.prettierrc.json` … ドット始まりは設定・道具の持ち物
  if (base.startsWith('.')) return true
  if ((LEFTOVER_CONFIG_NAMES as readonly string[]).includes(base)) return true
  // `vite.config.json` / `tsconfig.build.json` / `eslintrc.json`
  if (/\.config\.json$/.test(base)) return true
  if (/^tsconfig\..+\.json$/.test(base)) return true
  if (/rc\.json$/.test(base)) return true
  return false
}

/** そのファイルは「データらしきもの」か。 */
export function isLeftoverDataFile(rel: string): boolean {
  if (isLeftoverConfigFile(rel)) return false
  const ext = extOf(rel)
  return (LEFTOVER_DATA_TEXT_EXTS as readonly string[]).includes(ext)
    || (LEFTOVER_DATA_BINARY_EXTS as readonly string[]).includes(ext)
}

/** テキストとして読むべきファイルか（読めないものは大きさで見る）。 */
export function isLeftoverTextFile(rel: string): boolean {
  return (LEFTOVER_DATA_TEXT_EXTS as readonly string[]).includes(extOf(rel))
}

/** 中身を読む上限。これを超えるものは読まない（大きい＝中身があるのは明らかなので困らない）。 */
export const LEFTOVER_MAX_READ_BYTES = 2 * 1024 * 1024

/**
 * 読めない保存（.db / .sqlite）を「中身なし」と見なす大きさの上限（2026-09-24 検分）。
 *
 * ── なぜ `size > 0` ではいけないか ───────────────────────────────────
 * SQLite は **表を作った時点で**（行が1件も無くても）1ページぶんの大きさになる。
 * 既定のページの大きさが 4096 バイトで、実機に残っていた `data/schedule.db` も
 * まさに 4096 バイトだった。`size > 0` で見ると、**データが1件も入っていない
 * アプリでも必ず**「💾 いま入っているデータをどうしますか」が出る。仕様の
 * 「古いデータが無いときは出さない（空振りの問い合わせをしない）」に反するうえ、
 * 存在しないデータを AI に移させ、「移しました」と答えさせる余地を作る。
 *
 * **1ページ（＝定義だけ）までは中身なしに倒す。** 行が1件でも入れば、表のページが
 * 別に要るので 2ページ目（8192 バイト）以上になる。**倒す向きを選んだ理由**:
 * ここで取りこぼすのは「空の保存に気づかない」ことだけで、失うデータは無い。
 * 逆に倒すと、毎回必ず空振りの問いが出る。
 */
export const SQLITE_EMPTY_MAX_BYTES = 4096

/**
 * その値に「中身」があるか（純関数）。
 *
 * **空の配列・空のオブジェクト・空文字・null は「無い」。** それ以外（合言葉のような
 * 文字列1つ、数値、true/false）は「ある」。配列・オブジェクトは中を見て、
 * 1つでも中身のある値があれば「ある」。
 *
 * ── なぜ `0` や `false` を「ある」とするのか（理由・2026-09-24 検分）──────────
 * `0` は「0人が参加」、`false` は「まだ締め切っていない」という**利用者が入れた答え**で
 * あって、空欄ではない。JavaScript の falsy でまとめて落とすと、この2つだけが
 * 黙って消える（合言葉が消えたのと同じ形の事故になる）。**書かれていないこと
 * （null / undefined / 空文字）とだけ区別する。**
 */
export function hasMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'boolean') return true
  if (Array.isArray(value)) return value.some(hasMeaningfulValue)
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).some(hasMeaningfulValue)
  return false
}

/** 見つけた古いデータ1件。**file は AI への依頼文にだけ使う（画面には出さない）。** */
export type LeftoverDataFile = {
  /** ファイル（見た根からの相対パス）。 */
  file: string
  /** 中身の手がかり（「joinCode あり、dates 0件」など）。依頼文に入れる。 */
  detail: string
}

/** 依頼文に並べる件数の上限。多すぎると読めなくなる。 */
const MAX_FILES = 5
/** 1ファイルあたりに並べる項目の上限。 */
const MAX_KEYS = 5

/** JSON の中身を「joinCode あり、dates 0件」の形にする（純関数）。 */
function describeJsonValue(parsed: unknown): string {
  if (Array.isArray(parsed)) return `${parsed.length}件`
  if (parsed && typeof parsed === 'object') {
    const entries = Object.entries(parsed as Record<string, unknown>)
    const shown = entries.slice(0, MAX_KEYS).map(([k, v]) => {
      if (Array.isArray(v)) return `${k} ${v.length}件`
      if (v && typeof v === 'object') return `${k} ${Object.keys(v as object).length}項目`
      return hasMeaningfulValue(v) ? `${k} あり` : `${k} なし`
    })
    const rest = entries.length - shown.length
    return shown.join('、') + (rest > 0 ? `、ほか${rest}項目` : '')
  }
  return '中身あり'
}

/**
 * 1件のファイルを見て、「中身のある古いデータ」なら説明を返す（純関数）。無ければ null。
 *
 * @param input.file ファイル（見た根からの相対パス）
 * @param input.text テキストとして読めた中身（読めない・読まなかったときは null）
 * @param input.size ファイルの大きさ（バイト）
 */
export function describeLeftoverData(input: {
  file: string
  text: string | null
  size: number
}): LeftoverDataFile | null {
  const file = typeof input?.file === 'string' ? input.file : ''
  if (!file || !isLeftoverDataFile(file)) return null
  const size = Number.isFinite(input?.size) ? Number(input.size) : 0
  const text = typeof input?.text === 'string' ? input.text : null

  // テキストとして読めなかった（保存の実体・大きすぎる）。**大きさだけで見る。**
  // ただし `size > 0` では倒しすぎる（下の SQLITE_EMPTY_MAX_BYTES の理由を参照）
  if (text === null) return size > SQLITE_EMPTY_MAX_BYTES ? { file, detail: `${size}バイト` } : null

  if (text.trim().length === 0) return null
  if (isLeftoverTextFile(file) && extOf(file) === 'json') {
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch {
      // 壊れた JSON でも、中身が書かれているなら知らせる（勝手に捨てない）
      return { file, detail: `${text.trim().split('\n').length}行` }
    }
    // ★ 件数だけで判断しない。合言葉だけでも「中身がある」
    if (!hasMeaningfulValue(parsed)) return null
    return { file, detail: describeJsonValue(parsed) }
  }
  return { file, detail: `${text.trim().split('\n').length}行` }
}

/** 見つけた場所を並べる（**AI への依頼文専用**。画面には出さない）。 */
export function describeLeftoverSites(files: readonly LeftoverDataFile[]): string {
  const list = (files ?? []).filter((f): f is LeftoverDataFile => !!f && typeof f.file === 'string' && f.file.length > 0)
  const shown = list.slice(0, MAX_FILES).map(f => (f.detail ? `${f.file}（${f.detail}）` : f.file))
  const rest = list.length - shown.length
  return shown.join('、') + (rest > 0 ? `、ほか${rest}件` : '')
}

// ── 画面に出す文（**作者が2回直して確定したもの。変えないこと**）─────────────
export const LEFTOVER_DATA_HEADING = '💾 いま入っているデータをどうしますか'
export const LEFTOVER_DATA_MOVE_LABEL = '一緒に移してもらう'
export const LEFTOVER_DATA_MOVE_NOTE = 'これまでのデータがそのまま使えます'
export const LEFTOVER_DATA_SKIP_LABEL = '移さない'
export const LEFTOVER_DATA_SKIP_NOTE = '空の状態から始めます'

/**
 * 「一緒に移してもらう」を押すと何が起きるかの1行（2026-09-24 検分）。
 *
 * 押すとチャットに文面が入るだけで、**送信するのは利用者**である。この案内は
 * 書き直しの枠（warn）の中にしか無く、書き直し済みのこの場面では出ていなかった。
 * 押した人が「いま何が起きたのか分からないまま画面が閉じる」のを防ぐ。
 * 言い回しは書き直しの枠と揃える（同じことは同じ言葉で言う）。
 */
export const LEFTOVER_DATA_ASK_AI_NOTE = 'チャットに AI へのお願いが入ります（中身は AI 向けの指示です）。送信すると AI が作業を始めます。'

/**
 * 「移さない」の側に添える1行（2026-09-24 検分）。
 *
 * 「移さない」はプロジェクトごとに覚えるので、この問いは二度と出ない。押し間違えた人・
 * あとで気が変わった人に、**戻る道があること**だけは伝える（古いファイルは消していない
 * ので、チャットから頼めばいつでも移せる）。**ファイル名は出さない**（作者の指摘）。
 */
export const LEFTOVER_DATA_SKIP_LATER_NOTE = 'あとでチャットから頼むこともできます。'

/**
 * この問いを出すか（純関数・掟10）。
 *
 * - `rewritten`: 「🔎 書き直せたか確かめる」が ✅ を返したか。**まず書き直しが先。**
 * - `files`: 見つかった「中身のある古いデータ」。**無ければ聞かない**（空振りをしない）
 * - `answered`: もう選んだか。**選んだあとは出し直さない**（毎回聞かれると鬱陶しい）
 */
export function shouldAskLeftoverData(state: {
  rewritten?: boolean
  files?: readonly LeftoverDataFile[] | null
  answered?: boolean
}): boolean {
  if (state?.rewritten !== true) return false
  if (state?.answered === true) return false
  return (state?.files ?? []).length > 0
}

/** 「移さない」を選んだことを覚えておく置き場（プロジェクトごと）。 */
export function leftoverDataAnsweredKey(projectDir: string): string {
  return `koto_leftover_data_answered_${String(projectDir ?? '')}`
}

/**
 * 「一緒に移してもらう」で AI へ渡す依頼文（純関数）。
 *
 * - **Koto が見つけた場所（ファイル名と件数）をそのまま入れる。** 渡さないと
 *   AI は自分の記憶で答える（2026-09-23 の教訓）
 * - **移したあと、読み直して確かめてから完了と答えてもらう。** 2026-09-23 の事故は
 *   これが無かったために起きた
 * - **古いファイルは消させない。** Koto の片づけは全部「移動・戻せる」で統一してある
 * - **読み込み方（import / require）と「package.json の type を変えない」を必ず添える。**
 *   書き直しの依頼文（storageNoticeText.ts の askAiRewriteText）と**同じ形**にする。
 *   添えないと、移行を書く AI が同じ読み込みの壁にぶつかって `"type": "module"` を足し、
 *   **アプリが起動しなくなる**（2026-09-23 実機）。しかもデータを移している最中なので、
 *   起動しないアプリと移りかけのデータが同時に残る（2026-09-24 検分）
 *
 * ── ⚠️ 手元で移しても、公開したアプリには届かない（2026-09-24 検分）────────────
 * 以前のこの文は「koto-data の保存へ移してください」とだけ頼んでいた。AI は手元の
 * プロジェクトで作業するが、そのとき `KOTO_STORAGE_*` は与えられていない（渡すのは
 * 公開のときだけ）。環境変数が無ければ koto-data は手元の `.koto-data/` へ書き、
 * そこは公開から除外されている（publishExclude.ts の KOTO_INTERNAL_DIRS）ので、
 * **バケットへ運ぶ経路はどこにも無い**。つまり AI が正しく作業して「確かめました」と
 * 答えても、次に公開したアプリは空のまま始まる＝合言葉が変わる。この機能が防ごうと
 * した事故が、「移したのに直っていない」という**より分かりにくい形**で残る。
 *
 * **だから移すのは「手元のスクリプト」ではなく「アプリ自身」に頼む。** 古いファイルは
 * 公開物に含まれる（`.koto-data` と違い除外されていない）ので、公開したアプリが
 * 起動時に読み取って koto-data へ入れれば、**公開先の保存に届く**。手元で動かした
 * ときも同じコードが `.koto-data` を埋めるので、確かめ方も変わらない。
 * **空のときだけ**入れる形にして、二度目以降の起動で上書きさせない。
 *
 * @param kind 実際に置いた koto-data の形（分からなければ渡さない側に倒す＝
 *             askAiMoveDataPlan が送らない）
 */
export function askAiMoveDataText(files: readonly LeftoverDataFile[], kind: ModuleKind = 'esm'): string {
  const where = describeLeftoverSites(files)
  const at = where.length > 0
    ? `これまでのデータは ${where} に残っています。`
    : 'これまでのデータが、もう読まれなくなったファイルに残っています。'
  return 'これまでアプリに入っていたデータを、koto-data の保存へ引き継いでください。'
    + at
    + 'アプリはデータの保存を koto-data に切り替えたので、この古いファイルはもう読まれません。'
    // **手元で移すスクリプトを書かせない。** 手元の保存と公開先の保存は別の場所で、
    // 手元へ移したぶんは公開したアプリには届かない（上のコメントの理由）
    + '手元で移すスクリプトを書いて動かすのではなく、アプリ自身が起動したときに一度だけ取り込む形にしてください。'
    + 'koto-data の保存にまだ1件も入っていないときだけ、古いファイルの中身を読み取って、'
    + '同じ名前と同じ値のまま koto-data へ入れてください。1件でも入っていれば、何もしないでください。'
    // ── ⚠️ ここで「id を自分で決めてください」と頼んではいけない（2026-09-25）────────
    // 親が一度、二重取り込みを防ぐつもりで「元の並び順から決まる名前を毎回付けてください」
    // と書き足し、検分で取り消した。**Koto が AI へ送っている規則（aiContext.ts）が
    // 「id は自分で決めないこと（Koto が付けます）」と言っている**ので、正面から食い違う。
    // 食い違う指示を同時に渡すと、AI は辻褄を合わせようとして嘘をつく——
    // この機能そのものが、まさにそれを防ぐために作られた（2026-09-23 の事故）。
    //
    // **元のデータが id を持っていれば、頼まなくても引き継がれる。** save() は
    // 渡されたレコードに id があればそれを使うので（templates/koto-data.js の isNew）、
    // 二度取り込んでも同じ場所へ上書きされるだけで増えない。だから「捨てないでください」
    // とだけ言う。これは規則の但し書き「読んだレコードの id をそのまま使って更新するのは
    // 構いません」と同じ筋で、AI を板挟みにしない。
    //
    // 元のデータが id を持たないとき（追記だけの記録など）は、入れ物が2つ同時に
    // 立ち上がると同じデータが2組できる余地が残る。**塞いでいないことを docs/roadmap.md に
    // 書いてある**（塞ぐには koto-data 側に「1回だけ」の仕掛けが要り、この機能の範囲を超える）。
    + '元のデータが id を持っているときは、その id を捨てずにそのまま渡してください。'
    + `読み込み方は次の1行のとおりにしてください: ${dataLayerUsageLine(kind)}。`
    + KEEP_SHAPE
    + '形が分からないところを勝手に捨てたり、作り直したりしないでください。'
    + '古いファイルは消さないでください（公開したアプリが起動時に読み取るので、そのまま残してください）。'
    + '入れたあと、実際に koto-data から読み直して、同じ内容が入っていることを確かめてから、完了と答えてください。'
}

/**
 * 「一緒に移してもらう」を押したときに、**送ってよいか**を決める（純関数）。
 *
 * 書き直しの `askAiRewritePlan` と**同じ作法**にする（2026-09-24 検分）。
 * 読み込み先の koto-data が用意できていない状態で頼むと、移行を書く AI は
 * 読み込めるようにしようとして package.json を触りにいく余地が残る。
 * **用意できなければ送らない。**
 */
export function askAiMoveDataPlan(
  files: readonly LeftoverDataFile[],
  layer: { ok?: boolean; ready?: boolean; moduleKind?: ModuleKind; message?: string } | null | undefined,
): { send: true; text: string } | { send: false; error: string } {
  if (!layer || layer.ok !== true || layer.ready !== true) {
    const detail = typeof layer?.message === 'string' && layer.message.length > 0 ? `（${layer.message}）` : ''
    return {
      send: false,
      error: '保存の部品を用意できませんでした' + detail
        + '。この状態でデータの引き継ぎをお願いすると、読み込み先が無いために失敗します。'
        + '少し待ってから、もう一度お試しください。',
    }
  }
  return { send: true, text: askAiMoveDataText(files, layer.moduleKind === 'esm' ? 'esm' : 'cjs') }
}

/**
 * 古いデータを探しに行くか（純関数・2026-09-24 検分）。
 *
 * ── なぜ「その場の recheck」に依存させないか ──────────────────────────
 * 問いを出す引き金は長らく「🔎 書き直せたか確かめる」を押した結果だけだった。
 * ところが書き直しが成功すると `storageNeedFor` は 'declared' を返すので warn が
 * 下り、**その 🔎 ボタンごと消える**。おまけに ③公開のモーダルは閉じるたびに
 * 作り直されるので、状態も捨てられる。つまり「AI に書き直してもらう → モーダルが
 * 閉じる → AI が直す → ③公開を開き直す」という**いちばん自然な流れ**では、
 * 問いが一度も出ない。**移した／移さないを選ぶまでは、③公開を開けば必ず出す。**
 *
 * @param scan     開いた時点（またはその場）の走査結果
 * @param answered もう選んだか（選んだあとは探しに行かない）
 */
export function shouldLookForLeftoverData(
  scan: RewriteScan | null | undefined,
  answered?: boolean,
): boolean {
  if (answered === true) return false
  return rewriteCheckDone(scan)
}

/**
 * 古いデータを探した結果について、画面に出す1行（純関数）。出すものが無ければ空文字。
 *
 * ── なぜ要るか（2026-09-24 検分）──────────────────────────────────────
 * 画面は `ok` も `truncated` も `referenced` も捨てて「見つからなかった」と同じ扱いにしていた。
 * **調べられなかったときと、本当に無かったときが、まったく同じ見え方**になる。
 * 仕様の「『中身なし』に倒して黙って知らせないのがいちばん悪い」に真っ向から反する。
 * `rewriteCheckLine` が truncated のときに断定を避けているのと**同じ作法**に揃える。
 *
 * `message` は内部の言い回しなので、そのままは出さず括弧書きの補足にとどめる。
 */
export function leftoverScanLine(
  result: {
    ok?: boolean
    truncated?: boolean
    referenced?: number
    /**
     * 見つかった「中身のある古いデータ」。
     * **この1行を出すかどうかは、ここを見ない**（指摘V8。下の ⚠️ を読むこと）——
     * 一覧が空のときこそ取りこぼしを知らせたいので、門を一覧の有無で開け閉めしない。
     * 呼ぶ側が storage:leftoverData の戻り値をそのまま渡せるように受け口だけ残してある。
     */
    files?: readonly { file?: string }[] | null
    message?: string
  } | null | undefined,
): string {
  if (!result || result.ok !== true) {
    const detail = typeof result?.message === 'string' && result.message.length > 0 ? `（${result.message}）` : ''
    return 'ℹ️ いま入っているデータを確かめられませんでした' + detail
      + '。少し待ってから、もう一度お試しください。'
  }
  if (result.truncated === true) {
    // **断定しない。** ここに出ていない古いデータがあるかもしれない、とだけ言う
    // （見つかった件数によらず正しい文にする）
    return 'ℹ️ 全部は調べられませんでした（大きなファイルや深いフォルダは見ていません）。'
      + 'ここに出ていない古いデータが残っていることがあります。'
  }
  // ── 取りこぼした件数（referenced）を捨てない（2026-09-24 検分）──────────────
  // 探す側（main/ipc/unused.ts）は「取りこぼしうる件数を返り値に載せて隠さない。
  // 0件を『見つかりませんでした』と断定しないのは呼ぶ側の責務」と書いて渡している。
  // その責務がここ。読まなければ、**確かめられなかった**と**本当に無かった**が
  // まったく同じ「無言」になる（2026-09-23 ScheduleAPP の結末そのもの）。
  //
  // 取りこぼしは、AI が書き直しのついでに「旧: … はもう使いません」と1行メモを
  // 残すだけで起きる（名前がどこかに出ていれば「使用中」に倒れる）。
  //
  // **件数は出さない。** 多い・少ないによらず正しい文にする（truncated と同じ作法）。
  // **ファイル名も出さない**（作者の指摘）。`truncated` と重なったときは上の行を優先する
  // （「全部は調べられませんでした」のほうが広い）。
  //
  // ── ⚠️ 一覧が空かどうかで門を開け閉めしない（2026-09-25 検分の指摘V8）───────────
  // 一度「見つかった一覧があるときだけ出す（found > 0）」にしたことがある。**門の向きが逆**だった。
  // 探しに行くのは `shouldLookForLeftoverData`（＝書き直せている）ときだけなので、
  // 一覧が空でなければ「💾 いま入っているデータをどうしますか」が同じ枠に必ず出ている。
  // つまりその形は、**問いが出ている場面でだけ喋り、問いが出ない場面では黙る**——
  // 黙ってはいけないほうで黙っていた。取りこぼし（探す側が `files: []` を返す形）は
  // まさに**一覧が空のまま起きる**のだから、そこで黙れば利用者に確かめる手立てが残らない。
  //
  // 「毎回出る注意書きになる」という心配は本物だったが、それは**数え方の問題**であって
  // 門の向きの問題ではなかった。探す側（src/main/ipc/unused.ts の checkUnusedFiles）が
  // `referenced` を「**覚え書きや説明にだけ名前が残っていたせいで隠れたもの**」に絞った
  // （コメントと .md / .txt を抜いた参照コーパスで同じ判定をもう一度流す）。
  // アプリが正規に読んでいる .json / .csv はもう数に入らないので、**1 以上なら本当に
  // 知らせるべき場面**である。だから一覧の有無によらず出す。
  //
  // **件数は出さない。** 多い・少ないによらず正しい文にする（truncated と同じ作法）。
  // **ファイル名も出さない**（作者の指摘）。`truncated` と重なったときは上の行を優先する。
  // 文面も一覧に寄りかからない言い方にする（「この一覧には出していません」は一覧が空だと
  // 座りが悪い）。**断定しない**のは変わらない。
  const missed = Number(result.referenced ?? 0)
  if (Number.isFinite(missed) && missed > 0) {
    return 'ℹ️ 古いデータかもしれないものが残っていました。'
      + '覚え書きや説明の中にだけ名前が出ているので、いま使われているのかどうかは、はっきり分かりませんでした。'
      + '心当たりがあれば、チャットから引き継ぎを頼んでください。'
  }
  return ''
}
