// stageEstimate.ts — 段ごとの「目安」（この Mac の記録の中央値 → 開発時の実測 → 無し）と、記録の持ち方（純関数）。
//
// ── 作者の決定（2026-10-07・Ryosuke さん）────────────────────────────────────────
// 目安は、**最初は開発時の実測**（測った段だけ。**測っていない段には目安を出さない**。推測の数字を作らない）。
// **この Mac で一度でも測れたら、その段の最近5回の中央値**（成功した回だけ数える）に切り替える。
// 記録はこの Mac の Koto の中だけ（段の内部名・かかった時間・日付・Koto の版・ゾーン）。秘密は入れない。外へ送らない。
// ゾーンでは分けない（記録はしておく）。
//
// 「成功した回だけ数える」の実装（2026-10-07 検分）: 保存するのは `ok:true` の操作の、**flow が `unmeasured` の印を付けなかった段だけ**
// （projectOps.ts の finishOp。印の定義は shared/stageTiming.ts の `StageMark`）。`ok:true` でも、IP が付かなかった・前回の続きだった・
// 既に消えていた段は、ふつうにかかる時間の測定ではないので数えない（1件の悪い記録が開発時の実測を押しのけて目安を誤らせないため）。
//
// ここは**ファイルに触らない**純関数だけ（保存は main/stageTimingStore.ts。テストが直接呼べる）。

import { ALL_STAGES, STAGE, isStageIdShape, type StageTimingRow } from './stageTiming'

/** 目安に使う件数（段ごとに、この Mac の記録の新しい順に数えて）。 */
export const ESTIMATE_RECENT = 5
/** 段ごとに持つ記録の上限（超えたら古いものから捨てる）。 */
export const KEEP_PER_STAGE = 10

/** 1回ぶんの記録。秘密は入れない。 */
export type StageSample = {
  /** かかった時間（ミリ秒）。 */
  ms: number
  /** 終わった日時（ISO 8601）。 */
  at: string
  /** そのときの Koto の版。 */
  version: string
  /** そのときのゾーン（分からなければ null）。目安はゾーンで分けない（記録だけしておく）。 */
  zone: string | null
}

export type StageTimingStore = { v: 1; stages: Record<string, StageSample[]> }

export function emptyStore(): StageTimingStore {
  return { v: 1, stages: {} }
}

const MAX_STAGE_KEYS = 200
const MAX_MS = 7 * 24 * 60 * 60 * 1000
const MAX_TEXT = 64

const atOf = (s: StageSample): number => Date.parse(s.at)

function cleanSample(x: unknown): StageSample | null {
  if (!x || typeof x !== 'object') return null
  const r = x as Record<string, unknown>
  if (typeof r.ms !== 'number' || !Number.isFinite(r.ms) || r.ms < 0 || r.ms > MAX_MS) return null
  if (typeof r.at !== 'string' || Number.isNaN(Date.parse(r.at))) return null
  return {
    ms: Math.round(r.ms),
    at: r.at.slice(0, 40),
    version: typeof r.version === 'string' ? r.version.slice(0, MAX_TEXT) : '',
    zone: typeof r.zone === 'string' && r.zone ? r.zone.slice(0, MAX_TEXT) : null,
  }
}

/** 古い順に並べ、段ごとの上限（新しいほうを残す）に収める。 */
function capSamples(samples: StageSample[], keep: number): StageSample[] {
  const sorted = samples
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (atOf(a.s) - atOf(b.s)) || (a.i - b.i))
    .map(x => x.s)
  return sorted.length > keep ? sorted.slice(sorted.length - keep) : sorted
}

/**
 * ファイルから読んだ値を、使える形にする（純関数）。**壊れた JSON・形の違う中身でも落ちず、空として扱う**
 * （次の書き込みで上書きされて直る）。形の合わない記録だけを捨て、使えるものは残す。
 */
export function sanitizeStore(x: unknown): StageTimingStore {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return emptyStore()
  const rawStages = (x as Record<string, unknown>).stages
  if (!rawStages || typeof rawStages !== 'object' || Array.isArray(rawStages)) return emptyStore()
  const stages: Record<string, StageSample[]> = {}
  for (const [id, list] of Object.entries(rawStages as Record<string, unknown>).slice(0, MAX_STAGE_KEYS)) {
    if (!isStageIdShape(id) || !Array.isArray(list)) continue
    const samples = capSamples(list.map(cleanSample).filter((s): s is StageSample => s !== null), KEEP_PER_STAGE)
    if (samples.length > 0) stages[id] = samples
  }
  return { v: 1, stages }
}

/** 1回の操作が終わったときに足す記録（成功した操作の、終わった段だけ）。 */
export type StageTimingEntry = {
  at: string
  version: string
  zone: string | null
  stages: readonly StageTimingRow[]
}

/**
 * 記録を足す（純関数。元の store は変えない）。段ごとに `KEEP_PER_STAGE` 件まで、古いものから捨てる。
 * 形の合わない行（段の名前・時間）は足さない。
 */
export function appendSamples(store: StageTimingStore, entry: StageTimingEntry, keep: number = KEEP_PER_STAGE): StageTimingStore {
  const next: Record<string, StageSample[]> = {}
  for (const [id, list] of Object.entries(store.stages)) next[id] = [...list]
  for (const row of entry.stages) {
    if (!isStageIdShape(row.stage)) continue
    const sample = cleanSample({ ms: row.ms, at: entry.at, version: entry.version, zone: entry.zone })
    if (!sample) continue
    const current = Object.prototype.hasOwnProperty.call(next, row.stage) ? next[row.stage] : []
    next[row.stage] = capSamples([...current, sample], keep)
  }
  return { v: 1, stages: next }
}

/** 中央値（空なら null）。偶数件のときは真ん中の2つの平均（ミリ秒に丸める）。 */
export function medianOf(values: readonly number[]): number | null {
  const xs = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b)
  if (xs.length === 0) return null
  const mid = Math.floor(xs.length / 2)
  return xs.length % 2 === 1 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2)
}

/** 新しいほうから `n` 件（古い順に並べて返す）。 */
export function recentSamples(samples: readonly StageSample[], n: number = ESTIMATE_RECENT): StageSample[] {
  return capSamples([...samples], n)
}

// ── 開発時の実測 ──────────────────────────────────────────────────────────────

/**
 * 開発時の実測（**原本に数字がある段だけ**）。ここに無い段には、この Mac で測れるまで目安を出さない。
 * 数字は推測で足さない——足すなら、原本（docs/apprun-dedicated-plan.md・docs/roadmap.md）の該当箇所を `source` に書く。
 *
 * ・`teardown.lb`: 5-11（2026-09-10 実測・1回）。LB の DELETE は 204 を返しても一覧に `deleting:true` で残り、
 *   23:35 頃に 204 → 23:44 頃に消滅（「LB は約9分で消滅」）。
 * ・`teardown.asg`: 5-11（2026-09-10 実測・1回）。「ASG を削除（削除中が数分）」。分数は測っていない＝**数字にせず、原本の言葉のまま「数分」**。
 * ・`publish.lb-address`: 5-13（2026-09-16 実測・1回）。クラスタ作成の約2分後は空・「数分後には付いていた」。
 *   付くまでの分数は測っていない＝**数字にせず、原本の言葉のまま「数分」**と言う。
 *   **ただし原本の観測は「クラスタを作ってからの経過」で、この段だけの所要時間ではない**（クラスタを作ったあとに公開すれば、
 *   この段に入る時点で数分のうちの一部は過ぎている。付いていれば数秒で終わる）。`basis` に残してある。
 *
 * ── 採るか採らないかの決め（2026-10-07 検分の指摘 5・実装担当の判断。作者が覆してよい）──────────────────
 *   採る: `teardown.lb`（数字あり）・`teardown.asg`（「数分」。段の削除中の期間を直接観測した記述）・`publish.lb-address`（「数分」。
 *         basis に「クラスタ作成からの経過」と明記。**待っている最中にだけ出る目安**で、待ちが起きるのは IP がまだ空のときなので、
 *         「空だったら数分かかった」という観測とは合っている）。
 *   採らない: クラスタの削除（原本は「通った」とだけ。時間の記述が無い）・作成の3段（作成全体「所要は数分」〔5-11〕は
 *         段に分けられない）・削除全体「約9分」〔2026-09-16〕（段に紐づかない）。
 *   同じ「数分」でも、段の期間を直接言っているもの（teardown.asg）と、別の起点からの経過（publish.lb-address）が混ざっている。
 *   後者を外すなら、`DEV_MEASURES` から1行消すだけでよい（画面・テストは「表にある段だけ」を見ている）。
 */
export type DevMeasure = {
  /** 分（数字があるときだけ）。 */
  minutes?: number
  /** 数字が無いときの言葉（原本のまま）。 */
  note?: string
  /** 実測した日（出典の日付）。 */
  date: string
  /** 出典（原本の場所）。 */
  source: string
  /** その数字が**何を測ったものか**（画面には出さない。段の所要時間そのものか、別の起点からの経過かを取り違えないための注記）。 */
  basis: string
}

export const DEV_MEASURES: Readonly<Record<string, DevMeasure>> = {
  [STAGE.teardownLb]: {
    minutes: 9, date: '2026-09-10', source: 'docs/apprun-dedicated-plan.md 5-11',
    basis: 'LB の DELETE が 204 を返してから、一覧から消えるまで（23:35 頃 → 23:44 頃）',
  },
  [STAGE.teardownAsg]: {
    note: '数分', date: '2026-09-10', source: 'docs/apprun-dedicated-plan.md 5-11',
    basis: 'LB が消えたあと ASG を削除してから、消えるまで（原本は「削除中が数分」とだけ。分数は測っていない）',
  },
  [STAGE.publishLbAddress]: {
    note: '数分', date: '2026-09-16', source: 'docs/apprun-dedicated-plan.md 5-13',
    basis: 'クラスタ作成からの経過（約2分後は空・数分後には付いていた）。この段だけの所要時間ではない',
  },
}

// ── 目安 ──────────────────────────────────────────────────────────────────────

export type StageEstimate =
  | { kind: 'local'; ms: number; count: number }
  | { kind: 'dev'; ms: number | null; note: string | null; date: string }

/**
 * 段の目安（純関数）。
 *  1. この Mac の記録が1件以上あれば、**最近5件の中央値**（件数つき）
 *  2. 無ければ、開発時の実測（出典の日付つき）
 *  3. どちらも無ければ null（**測っていない段に目安を作らない**）
 */
export function estimateForStage(
  stage: string, store: StageTimingStore, dev: Readonly<Record<string, DevMeasure>> = DEV_MEASURES,
): StageEstimate | null {
  const own = Object.prototype.hasOwnProperty.call(store.stages, stage) ? store.stages[stage] : undefined
  const recent = recentSamples(Array.isArray(own) ? own : [], ESTIMATE_RECENT)
  if (recent.length > 0) {
    const ms = medianOf(recent.map(s => s.ms))
    if (ms !== null) return { kind: 'local', ms, count: recent.length }
  }
  const d = Object.prototype.hasOwnProperty.call(dev, stage) ? dev[stage] : undefined
  if (d) {
    if (typeof d.minutes === 'number' && Number.isFinite(d.minutes) && d.minutes > 0) {
      return { kind: 'dev', ms: Math.round(d.minutes * 60000), note: null, date: d.date }
    }
    if (d.note) return { kind: 'dev', ms: null, note: d.note, date: d.date }
  }
  return null
}

/** 目安のある段だけを集める（画面が1回の問い合わせで読む）。 */
export function estimatesFor(
  store: StageTimingStore, stageIds: readonly string[] = ALL_STAGES.map(s => s.id),
  dev: Readonly<Record<string, DevMeasure>> = DEV_MEASURES,
): Record<string, StageEstimate> {
  const out: Record<string, StageEstimate> = {}
  for (const id of stageIds) {
    const e = estimateForStage(id, store, dev)
    if (e) out[id] = e
  }
  return out
}

/** 「約8分」のような、おおよその時間（純関数）。1分未満は秒、1時間以上は時間と分。 */
export function approxDurationText(ms: number): string {
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `約${Math.max(1, sec)}秒`
  const min = Math.round(ms / 60000)
  if (min < 60) return `約${min}分`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m === 0 ? `約${h}時間` : `約${h}時間${m}分`
}

/**
 * 画面に出す目安の一文（純関数）。出典を必ず添える（どこから来た数字か分かるように）。
 *   「目安 約8分（この Mac での最近3回の中央値）」
 *   「目安 約9分（開発時の実測・2026-09-10）」
 *   「目安 数分（開発時の実測・2026-09-16）」
 * この Mac の記録が1件だけのときは「中央値」と言わず「前回の実測」と言う。
 */
export function estimateText(e: StageEstimate): string {
  if (e.kind === 'local') {
    const src = e.count === 1 ? 'この Mac での前回の実測' : `この Mac での最近${e.count}回の中央値`
    return `目安 ${approxDurationText(e.ms)}（${src}）`
  }
  const amount = e.ms !== null ? approxDurationText(e.ms) : (e.note ?? '')
  return `目安 ${amount}（開発時の実測・${e.date}）`
}

/** 画面が受け取った値を信用しないための読み取り（IPC の返り値）。形が合わなければ null。 */
export function readEstimate(x: unknown): StageEstimate | null {
  if (!x || typeof x !== 'object') return null
  const r = x as Record<string, unknown>
  if (r.kind === 'local' && typeof r.ms === 'number' && Number.isFinite(r.ms) && r.ms >= 0
    && typeof r.count === 'number' && Number.isInteger(r.count) && r.count >= 1) {
    return { kind: 'local', ms: r.ms, count: r.count }
  }
  if (r.kind === 'dev' && typeof r.date === 'string' && r.date) {
    const ms = typeof r.ms === 'number' && Number.isFinite(r.ms) && r.ms >= 0 ? r.ms : null
    const note = typeof r.note === 'string' && r.note ? r.note : null
    if (ms !== null || note) return { kind: 'dev', ms, note, date: r.date }
  }
  return null
}

/**
 * 画面が待っている段（`stage`）の目安の一文を、IPC で受け取った一覧（`raw`）から引く（純関数）。
 * 段が分からない・一覧に無い・形が合わない → null（**何も出さない**。測っていない段に目安を作らない）。
 */
export function estimateLineFor(stage: string | null | undefined, raw: unknown): string | null {
  if (typeof stage !== 'string' || !stage) return null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!Object.prototype.hasOwnProperty.call(raw, stage)) return null
  const e = readEstimate((raw as Record<string, unknown>)[stage])
  return e ? estimateText(e) : null
}
