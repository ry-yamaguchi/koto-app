// dedicatedGoldenCases.ts — 「手本（専有型・0.6.21）の出力の写し（golden）」の材料。**定義はこの1か所**（設計書 10.11.12）。
//
// 3B で専有型を共通の部品へ載せ替えるとき、0.6.21 で直した文と振る舞いを黙って失わないために、
// 手本の関数が**いま**返す文を `tests/fixtures/dedicated-teardown-golden.json` に書き出して固定する。
//   ・書き出す試験 … tests/dedicatedGoldenCapture.test.ts があった（手本を呼んだ。手本が消えた 3B-7 でファイルごと消した）
//   ・比べる試験   … tests/teardownFlowCommon.test.ts の「手本の出力の写しとの比べ」（確認の文・3B-0 で向け直し）、
//                    tests/dedicatedTeardownGolden.test.ts（結果欄・知らせ・材料。3B-4）
// 材料を2か所に書くと、片方だけ古くなって比べる意味が無くなる。だから**材料はここだけ**に置き、2つの試験が同じ定義を読む。
//
// このファイルは**手本を import しない**（材料と、材料を window に載せる小さな部品だけ）。
//
// 書き直し方: 手本は 3B-7 で消えたので、いまは書き直せない。書き直す必要が出たら、タグ v0.6.21 の手本を呼ぶ試験を一時的に作って取り直し、
// その差分をレビューする。**新しい部品の出力で書き直してはいけない**（比べる意味が無くなる）。

import fs from 'node:fs'
import path from 'node:path'
import { summarizeResult, type OpResult } from '../src/main/projectOps'

// ── 写し（JSON）の置き場と型 ────────────────────────────────────────────────────────

export const GOLDEN_JSON_PATH = path.join(__dirname, 'fixtures', 'dedicated-teardown-golden.json')

export type GoldenFile = {
  about: string
  /** 画面の文の定数（手順6のキー未登録の文・📡 のキー未登録の文・幽霊の行の案内・窓を閉じる警告に出る活動の名前）。 */
  constants: { activityLabel: string; nothingToDelete: string; listKeyMissing: string; panelKeyMissing: string }
  /** 材料の名前 → 手本が作った確認ダイアログの文。 */
  confirm: Record<string, { title: string; confirmLabel: string; danger: boolean; body: string }>
  /** 材料の名前 → 手本の結果欄を描いた HTML の文だけ（markupText）。 */
  result: Record<string, string>
  /** 材料の名前 → 手本の `resumedNoteOf`（時刻は端末の時計に依るので、終わった時刻があったかだけ）。 */
  notes: Record<string, { kind: string; ok: boolean; finished: boolean; headline: string; message: string; warnings: string[] }>
  /** 材料の名前 → 手本の `loadDedicatedTeardownFacts` の返り値（JSON）。 */
  facts: Record<string, Record<string, unknown>>
}

/** 写しを読む。 */
export function readGolden(): GoldenFile {
  return JSON.parse(fs.readFileSync(GOLDEN_JSON_PATH, 'utf-8')) as GoldenFile
}

// ── 共通の小さな材料 ────────────────────────────────────────────────────────────────

export type GoldenPlacement = { bucket: string; prefix: string; shared: boolean }
export const GOLDEN_A: GoldenPlacement = { bucket: 'koto-a', prefix: 'projects/myapp/', shared: true }
export const GOLDEN_B: GoldenPlacement = { bucket: 'koto-b', prefix: 'projects/myapp/', shared: true }
export const GOLDEN_OWN: GoldenPlacement = { bucket: 'koto-own', prefix: 'projects/x/', shared: false }

/** 専有型の記録（`apprunDedicated:state` の返り値のうち、確認が読むもの）。 */
export type GoldenRecord = {
  applicationID?: string; applicationName?: string; loadBalancerID?: string; asgID?: string; clusterID?: string
  storageLeftoverBucket?: string
}
export const GOLDEN_FULL_RECORD: GoldenRecord = { applicationID: 'app1', applicationName: 'myapp', loadBalancerID: 'l1', asgID: 'a1', clusterID: 'c1' }

/** ロードバランサの削除の目安の一文（shared/stageEstimate.ts の出力。数字はここで決め打ちにして、開発時の実測が変わっても golden を動かさない）。 */
export const GOLDEN_LB_LINE = '目安 約9分（開発時の実測・2026-09-10）'

/** 見た目の部品を描いた HTML から、文だけを取り出す。段落・行・ボタンの切れ目は改行にし、ほかのタグは落とす。 */
export function markupText(html: string): string {
  return html
    .replace(/<\/?(p|li|ul|ol|div|button|a|summary|details|h[1-6]|pre|br)\b[^>]*>/g, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .split('\n').map(l => l.trim()).filter(l => l.length > 0).join('\n')
}

// ── 確認の文（buildDedicatedTeardownConfirm）──────────────────────────────────────────

export type GoldenConfirmCase = {
  name: string
  record?: GoldenRecord
  placements?: GoldenPlacement[]
  otherTargets?: string[]
  placementsUnreadable?: boolean
  cause?: 'settings' | 'call' | null
  otherTargetsUnreadable?: boolean
  estimate?: string | null
}

export const GOLDEN_CONFIRM_CASES: GoldenConfirmCase[] = [
  // 先頭の16通り（tests/teardownFlowCommon.test.ts の「手本との比べ」にあったもの。名前も変えない）
  { name: '保存場所なし' },
  { name: '保存場所1件', placements: [GOLDEN_A] },
  { name: '保存場所2件', placements: [GOLDEN_A, GOLDEN_B] },
  { name: '保存場所1件（shared:false）', placements: [GOLDEN_OWN] },
  { name: '保存場所1件＋ほかの公開先2つ', placements: [GOLDEN_A], otherTargets: ['HANAMII', 'Vercel'] },
  { name: '保存場所2件＋ほかの公開先', placements: [GOLDEN_A, GOLDEN_B], otherTargets: ['HANAMII'] },
  { name: '保存場所なし＋ほかの公開先（段落は出ない）', otherTargets: ['HANAMII'] },
  { name: '設定を読めなかった（settings）', placementsUnreadable: true, cause: 'settings' },
  { name: '設定を問い合わせられなかった（call・ほかの公開先なし）', placementsUnreadable: true, cause: 'call' },
  { name: '理由が null の読めなかった回（call と同じ）', placementsUnreadable: true, cause: null },
  { name: 'ほかの公開先の記録を読めなかった', otherTargetsUnreadable: true },
  { name: 'settings とほかの公開先の記録の両方', placementsUnreadable: true, cause: 'settings', otherTargetsUnreadable: true },
  { name: 'call とほかの公開先の記録の両方', placementsUnreadable: true, cause: 'call', otherTargetsUnreadable: true },
  { name: 'ロードバランサの目安あり', placements: [GOLDEN_A], estimate: GOLDEN_LB_LINE },
  { name: 'ロードバランサが記録に無い（目安は出ない）', record: { clusterID: 'c1' }, estimate: GOLDEN_LB_LINE },
  { name: '記録が空（名前を挙げられるものが無い）', record: {} },
  // 設計書 10.11.12 が挙げる材料のうち、上の16通りに無かったもの
  { name: 'アプリだけ', record: { applicationID: 'app1', applicationName: 'myapp' } },
  { name: 'アプリが消えたあとの押し直し（ID だけ・アプリ名なし）', record: { loadBalancerID: 'l1', asgID: 'a1', clusterID: 'c1' }, placements: [GOLDEN_A], estimate: GOLDEN_LB_LINE },
  { name: '保存場所だけ残った印だけ（押し直し）', record: { storageLeftoverBucket: 'koto-a' }, placements: [GOLDEN_A] },
  // 'call' の回でほかの公開先の名前を読めているとき（写しは名前を挙げる1段落を足す＝V4。表は tests/teardownFlowCommon.test.ts）
  { name: 'call＋ほかの公開先を読めている', placementsUnreadable: true, cause: 'call', otherTargets: ['HANAMII', 'Vercel'] },
  { name: '理由が null＋ほかの公開先を読めている（call と同じ扱い）', placementsUnreadable: true, cause: null, otherTargets: ['HANAMII'] },
  { name: 'settings＋ほかの公開先を読めている（足さない）', placementsUnreadable: true, cause: 'settings', otherTargets: ['HANAMII'] },
]

// ── 意図して違う文の表（確認の文）───────────────────────────────────────────────────────
// 2つの比べが同じ表を読む（tests/teardownFlowCommon.test.ts は共通の部品の機械を、偽の仕様書で。tests/dedicatedTeardownGolden.test.ts は本物の専有型の仕様書で）。
// 本物の仕様書だけが足す違い（D10 の1行・V2）は、後者がこの表の後ろに足す。
// 写しの文（旧）に当てると、新しい部品の文（新）になる置き換え。**この表に無い違いは落ちる**（載せ替えの誤り）。
// 行を足すとき: id は設計書 10.11.12 の V の番号、why は理由、count は当たる材料の数（表と実物がずれたら落ちる）。
// 3B-3 で、「読めなかった」注意の例（V5）・T161（V6）の行を足した（3B-4 で、この表を2つの試験が読むようにここへ移した）。
export type IntendedConfirmDifference = {
  id: string
  why: string
  count: number
  apply: (goldenBody: string, c: GoldenConfirmCase) => string
}

export const CALL_CAUTION_HEAD = '⚠️ 保存場所の設定を問い合わせられなかったため'
export const ADDED_SENTENCE = (names: string) =>
  `⚠️ このプロジェクトが保存場所を使っていて、それをほかの公開先（${names}）も使っていれば、そちらで公開中のアプリのデータも消えます（アプリ自体は消えません）。`

export const OLD_EXAMPLE = '保存場所をほかの公開先（HANAMII・共用型など）が使っていれば'
export const NEW_EXAMPLE = '保存場所をほかの公開先（HANAMII・Vercel・共用型など）が使っていれば'
export const T161_NEW = 'でも使っているため、そちらで公開中のアプリのデータも消えます'

export const INTENDED_CONFIRM_DIFFERENCES: IntendedConfirmDifference[] = [
  {
    id: 'V4',
    why: "'call' の回（保存場所を問い合わせられなかった）で、ほかの公開先の名前を読めているとき、その名前を挙げる1段落を足す（設計書 10.6.2 の6・10.11.20 の D。手本は名前を出さない）。'settings' の回は足さない",
    count: 2,
    apply: (body, c) => {
      if (!c.placementsUnreadable || c.cause === 'settings' || (c.otherTargets ?? []).length === 0) return body
      const paragraphs = body.split('\n\n')
      const at = paragraphs.findIndex(p => p.startsWith(CALL_CAUTION_HEAD))
      if (at < 0) throw new Error(`'call' の注意の段落が写しに無い: ${c.name}`)
      paragraphs.splice(at + 1, 0, ADDED_SENTENCE((c.otherTargets ?? []).join('・')))
      return paragraphs.join('\n\n')
    },
  },
  {
    id: 'V5',
    why: '「ほかの公開先の記録を読めなかった」注意の例が「HANAMII・共用型など」→「HANAMII・Vercel・共用型など」（例は保存場所を使いうる公開先の唯一の定義 PUBLISH_TARGETS_USING_STORAGE から作る。設計書 10.11.7 (3)）',
    count: 3,
    apply: body => body.replace(OLD_EXAMPLE, NEW_EXAMPLE),
  },
  {
    id: 'V6',
    why: '「でも使っています。{名前} で公開中のアプリのデータも消えます」→「でも使っているため、そちらで公開中のアプリのデータも消えます」（T161。名前を2回並べない。作者の決定「全部採る」2026-10-09）',
    count: 2,
    apply: (body, c) => {
      const others = (c.otherTargets ?? []).join('・')
      return others ? body.replace(`でも使っています。${others} で公開中のアプリのデータも消えます`, T161_NEW) : body
    },
  },
]

// ── 結果欄（DedicatedTeardownResultView）──────────────────────────────────────────────

/** `apprunDedicated:teardown` の返り値（手本の結果欄が読む形）。 */
export type GoldenReply = {
  ok: boolean; executed: string[]; message: string
  remaining: { applicationID?: string; loadBalancerID?: string; asgID?: string; clusterID?: string; storageBucket?: string }
  inProgress?: { applicationID?: string; loadBalancerID?: string; asgID?: string; clusterID?: string }
  appDeleted?: boolean
  keptBucketName?: string; keptBucketNames?: string[]
  stageTimings?: { totalMs: number; stages: Array<{ stage: string; ms: number }> }
}

export const STEP6_KEY_MISSING = 'さくらのクラウドAPIキーが未登録です。手順1で登録してください。'
export const LIST_KEY_MISSING = 'さくらのクラウドの API キーが未登録です。「認証情報」で登録してから、もう一度お試しください。'

const OK: GoldenReply = {
  ok: true,
  executed: ['アプリケーション『app1』を削除しました（消えたことを確認）', 'クラスタ『c1』を削除しました'],
  message: '削除の要求はすべて受け付けられました。', remaining: {},
}
const ALL_LEFT: GoldenReply = {
  ok: false, executed: [], message: 'ロードバランサの削除に失敗しました',
  remaining: { applicationID: 'app1', loadBalancerID: 'l1', asgID: 'a1', clusterID: 'c1', storageBucket: 'koto-data-x' },
}
const APP_LEFT: GoldenReply = { ok: false, executed: [], message: 'アプリの削除に失敗しました', remaining: { applicationID: 'app1' } }
const IN_PROGRESS: GoldenReply = {
  ok: false, executed: [], message: '待ち切れませんでした', remaining: { loadBalancerID: 'l1' }, inProgress: { loadBalancerID: 'l1', asgID: 'a1', clusterID: 'c1' },
}
const STORAGE_ONLY: GoldenReply = {
  ok: false, executed: ['アプリケーション『app1』を削除しました（消えたことを確認）'], message: '保存場所を削除できませんでした',
  remaining: { storageBucket: 'koto-data-x' }, appDeleted: true,
}
const HINT = 'もう一度削除するには、下の「このプロジェクトを開く」から手順6を押してください（テスト用の文）'
const NOTE = {
  kind: 'teardown' as const, startedAt: 1, finishedAt: 2, ok: true,
  headline: '🔔 手順6 すべて削除の結果です。', message: '', warnings: ['⚠️ 保存場所『x』は残しました。月額が続きます'],
}
export type GoldenNote = typeof NOTE

export type GoldenResultCase = {
  name: string
  result: GoldenReply | null
  retryHint: string
  notes?: GoldenNote[]
  /** 「🤖 AIに相談する」を出す入口（手順6）か。 */
  askAi?: boolean
  storageRetryHint?: string
  /** 「このプロジェクトを開く」のボタンを渡す入口（📡）か。 */
  storageRetryAction?: boolean
}

const STEP6 = '手順6'
const LIST = 'この一覧の 🗑 破棄'
export const GOLDEN_RESULT_CASES: GoldenResultCase[] = [
  { name: '全部消えた（手順6）', result: OK, retryHint: STEP6 },
  { name: '全部消えた（message が空）', result: { ...OK, message: '' }, retryHint: STEP6 },
  { name: '全部消えた＋かかった時間つき', result: { ...OK, stageTimings: { totalMs: 600000, stages: [{ stage: 'teardown.lb', ms: 540000 }, { stage: 'teardown.cluster', ms: 30000 }] } }, retryHint: STEP6 },
  { name: '途中で止まった（手順6）', result: IN_PROGRESS, retryHint: STEP6 },
  { name: '途中で止まった（📡 の押し直しの呼び方）', result: IN_PROGRESS, retryHint: LIST },
  { name: '残った（アプリ・ロードバランサ・ASG・クラスタ・保存場所）', result: ALL_LEFT, retryHint: STEP6 },
  { name: '残った（アプリだけ・保存場所なし）', result: APP_LEFT, retryHint: STEP6 },
  { name: '残った＋AIに相談する（手順6）', result: ALL_LEFT, retryHint: STEP6, askAi: true },
  { name: '保存場所だけ残った（手順6・案内なし）', result: STORAGE_ONLY, retryHint: STEP6 },
  { name: '保存場所だけ残った（📡・案内とボタンつき）', result: STORAGE_ONLY, retryHint: LIST, storageRetryHint: HINT, storageRetryAction: true },
  { name: '保存場所以外が残った（📡・案内は出ない）', result: APP_LEFT, retryHint: LIST, storageRetryHint: HINT, storageRetryAction: true },
  {
    name: '鍵の ⚠️ の行つき（全部消えた）',
    result: {
      ...OK,
      executed: [...OK.executed, '保存場所『koto-data-x』のデータを削除しました — このプロジェクト専用の保存場所ごと削除します。', '⚠️ 保存場所のアクセスキーを無効にできませんでした'],
    },
    retryHint: STEP6,
  },
  {
    name: '残した保存場所つき（全部消えた）',
    result: {
      ...OK,
      executed: [...OK.executed, "保存場所『koto-data-x』のデータを削除しました — このプロジェクトのデータだけを削除します。保存場所はほかの1件のプロジェクトが使っているため残します。"],
      keptBucketName: 'koto-data-x', keptBucketNames: ['koto-data-x'],
    },
    retryHint: STEP6,
  },
  {
    name: '保存場所2件・1件目で止まった（今の手本は止まった1件だけ返す）',
    result: { ...STORAGE_ONLY, message: "保存場所『koto-a』の削除に失敗しました: 403", remaining: { storageBucket: 'koto-a' } },
    retryHint: STEP6,
  },
  { name: '何も始まっていない失敗（別の操作が走っていた）', result: { ok: false, executed: [], message: 'いま別の操作（公開）を実行中です。終わってからもう一度お試しください。', remaining: {} }, retryHint: STEP6 },
  { name: 'キーが無い（手順6の文）', result: { ok: false, executed: [], message: STEP6_KEY_MISSING, remaining: {} }, retryHint: STEP6 },
  { name: 'キーが無い（📡 の文）', result: { ok: false, executed: [], message: LIST_KEY_MISSING, remaining: {} }, retryHint: LIST },
  { name: '知らせつき（開き直したあと）', result: OK, retryHint: STEP6, notes: [NOTE] },
  { name: '知らせだけ（結果なし）', result: null, retryHint: STEP6, notes: [NOTE] },
  { name: '結果も知らせも無い', result: null, retryHint: STEP6 },
]

// ── 開き直したときの知らせ（resumedNoteOf の削除の記録）────────────────────────────────

export type GoldenNoteCase = {
  name: string
  startedAt: number
  /** 端末の時計で「10:32」になる時刻にする（clockText が端末の時刻で書くので、時計が違う環境でも同じ文になるように）。無ければ「終わりました」を言わない。 */
  finishedAt?: number
  /** 手本の main が返す文を、本物の summarizeResult で記録の形にしたもの。 */
  reply?: GoldenReply & { warnings?: string[] }
  /** 返り値を通さず、記録の結果を直接書く（記録に結果が無い・残ったものが無いのに「残っています」の知らせがある、など）。null は「結果が無い記録」。 */
  result?: OpResult | null
}

/** 端末の時計で 2026-10-16 10:32 になる時刻（epoch ミリ秒）。 */
export const GOLDEN_FINISHED_AT = new Date(2026, 9, 16, 10, 32).getTime()

export const GOLDEN_NOTE_CASES: GoldenNoteCase[] = [
  { name: '残った（ID つき・保存場所つき）', startedAt: 100, finishedAt: GOLDEN_FINISHED_AT, reply: ALL_LEFT },
  { name: '止まった（待ち切れず）', startedAt: 100, finishedAt: GOLDEN_FINISHED_AT, reply: IN_PROGRESS },
  {
    name: '警告つき（保存場所だけ残り、設定の記録も残した）', startedAt: 100, finishedAt: GOLDEN_FINISHED_AT,
    reply: {
      ...STORAGE_ONLY,
      executed: [...STORAGE_ONLY.executed, '⚠️ 保存場所の記録（公開の設定）は残しています。次に公開する前に、【公開】の「保存場所を用意する」からやり直してください'],
      message: '保存場所を片づけられませんでした: 403',
    },
  },
  { name: '全部消えた（警告なし）', startedAt: 100, finishedAt: GOLDEN_FINISHED_AT, reply: OK },
  {
    name: '全部消えたが鍵の警告つき', startedAt: 100, finishedAt: GOLDEN_FINISHED_AT,
    reply: { ...OK, executed: [...OK.executed, '⚠️ 保存場所のアクセスキーを無効にできませんでした'] },
  },
  { name: '終わった時刻が無い', startedAt: 100, reply: OK },
  { name: '記録に結果が無い', startedAt: 100, finishedAt: GOLDEN_FINISHED_AT, result: null },
  {
    name: '残ったものの ID が1つも無いのに「残っています」の知らせがある（落とさない）', startedAt: 100, finishedAt: GOLDEN_FINISHED_AT,
    result: { ok: false, message: '失敗', lines: [], warnings: ['削除できずに残っているものがあります。残っている間は課金が続きます（別の知らせ）'], extra: {} },
  },
]

/** 知らせの材料を、記録（ProjectOpRecord と同じ形）にする。 */
export function recordOfNoteCase(c: GoldenNoteCase) {
  const result: OpResult | undefined = c.result === null ? undefined : (c.result ?? summarizeResult(c.reply))
  return {
    op: '削除' as const, target: 'sakura-apprun-dedicated' as const, handler: 'apprunDedicated:teardown',
    startedAt: c.startedAt, running: false, progress: {}, seen: false,
    ...(c.finishedAt !== undefined ? { finishedAt: c.finishedAt } : {}),
    ...(result ? { result } : {}),
  }
}

// ── 確認の材料（loadDedicatedTeardownFacts）─────────────────────────────────────────

/** 材料を読む口になる偽の window の差し替え。 */
export type FactsWindowOver = {
  placement?: () => Promise<unknown>
  readFile?: (p: string) => Promise<string>
  exists?: (p: string) => Promise<boolean>
  estimates?: () => Promise<unknown>
}

/** 偽の window を `globalThis` に置く。呼び出し側が `afterEach` で `delete (globalThis as any).window` する。 */
export function installFactsWindow(over: FactsWindowOver = {}): void {
  ;(globalThis as any).window = {
    electronAPI: {
      storage: { placement: over.placement ?? (async () => ({ ok: true, placement: null, placements: [] })) },
      fs: {
        readFile: over.readFile ?? (async () => JSON.stringify({ publish: { targets: { 'sakura-apprun-dedicated': { publishedAt: 't' }, vercel: { publishedAt: 't' } } } })),
        // 既定: .sakuraide.json だけがある（旧い共用型の記録 state.json は無い。D9=2）。
        exists: over.exists ?? (async (p: string) => String(p).endsWith('/.sakuraide.json')),
      },
      stageTiming: { estimates: over.estimates ?? (async () => ({ stages: 'x' })) },
    },
  }
}

export const GOLDEN_FACTS_DIR = '/work/myapp'
export const GOLDEN_FACTS_RECORD = { id: 'r1' }

/**
 * `v3: true` は、**新しい部品が読み口を変える材料**（設計書 10.11.12 の V3: 旧い記録だけの公開先も名前で言う・レンタルサーバは挙げない）。
 * 手本は `publish.targets` だけを読んで保存場所を使わない公開先も挙げるので、手本と新しい部品を直接比べる試験
 * （tests/teardownFactsCommon.test.ts の「手本と、同じ窓の上で同じ材料になる」）には入れない。写しには入れる。
 */
export const GOLDEN_FACTS_CASES: Array<{ name: string; over: FactsWindowOver; v3?: boolean }> = [
  { name: '保存場所2件・ほかの公開先あり', over: { placement: async () => ({ ok: true, placement: GOLDEN_A, placements: [GOLDEN_A, GOLDEN_B] }) } },
  { name: 'placements 無し（古い応答）', over: { placement: async () => ({ ok: true, placement: GOLDEN_A }) } },
  { name: '保存場所なし', over: { placement: async () => ({ ok: true, placement: null, placements: [] }) } },
  { name: '設定を読めない（ok:false）', over: { placement: async () => ({ ok: false, message: '壊れています' }) } },
  { name: '問い合わせが失敗（reject）', over: { placement: async () => { throw new Error('IPC 失敗') } } },
  { name: 'ほかの公開先の記録を読めない', over: { readFile: async () => { throw new Error('ENOENT') } } },
  { name: '記録が壊れた JSON', over: { readFile: async () => '{ 壊れた' } },
  { name: '目安が読めない', over: { estimates: async () => { throw new Error('目安なし') } } },
  { name: 'ロードバランサの目安が読める', over: { estimates: async () => ({ 'teardown.lb': { kind: 'dev', ms: 540000, note: null, date: '2026-09-10' } }) } },
  {
    name: 'ほかの公開先にレンタルサーバがある（手本は挙げる）', v3: true,
    over: { readFile: async () => JSON.stringify({ publish: { targets: { 'sakura-apprun-dedicated': { publishedAt: 't' }, 'sakura-rental': { publishedAt: 't' }, vercel: { publishedAt: 't' } } } }) },
  },
  {
    name: '旧い記録だけの公開先がある（HANAMII の projectId・共用型の state.json。手本は数えない）', v3: true,
    over: {
      readFile: async (p: string) => String(p).endsWith('/.sakuraide.json')
        ? JSON.stringify({ publish: { targets: { 'sakura-apprun-dedicated': { publishedAt: 't' } }, hanamii: { projectId: 'prj-1' } } })
        : JSON.stringify({ resources: [{ kind: 'apprun-app', id: 'app-1' }] }),
      exists: async () => true,
    },
  },
]
