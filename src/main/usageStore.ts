// usageStore.ts — 予算設定（sakura_budget_settings）・利用実績（sakura_usage_by_month）の
// 唯一の持ち主（B'-3d-1b）。
//
// ── なぜ（B'-3d の第二歩）────────────────────────────────────────────
// これまでの持ち主は renderer の localStorage で、main のループ（turnRunner.ts）からは
// ask（main→renderer の問い合わせ）で読み書きしていた（usage.check・usage.record）。
// ask はウィンドウが生きていることが前提なので、「窓を閉じても作業が続く」（B'-3d）の障害の
// 一つだった。ここからは main がメモリ＋ファイル（userData/usage.json）で持ち、保存の
// デバウンスも main が行う（src/main/learningStore.ts＝学習キャッシュの持ち主・B'-3d-1a と
// 同じ作法）。renderer は起動時に読み込む写し（src/renderer/usageMirror.ts）＋変更イベントを
// 持つだけ。electron の `app` は「保存先ディレクトリ」を得るためだけに使う。それ以外
// （判定ロジック・サニタイズ）は shared/usageBudget.ts の純関数（node のテストからも直接呼べる）。
//
// ── 課金データなので「1度きり」の移行（学習キャッシュとの違い）─────────────────
// learningStore.ts の mergeMigration は「新しい at だけ勝つ」ため何度呼んでも安全だったが、
// 利用実績はタイムスタンプの無い**加算カウンタ**なので、同じやり方では2度目の移行で
// 二重計上になる。ここでは migrated フラグをファイルへ永続化し、**true になったあとは
// mergeMigration を何度呼んでも何もしない**（usageMirror.ts の primeUsageMirror が起動の
// たび呼んでも安全）。
//
// APIキーは main に一切渡らない・保存しない（掟4）。すべて指紋（fp = hashKey(apiKey)）ベース。
import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import {
  DEFAULT_SETTINGS, sanitizeSettings, sanitizeMonths, thisMonth, applyRecord,
  checkBeforeRequestOf,
  type BudgetSettings, type UsageStore, type KeyBucket, type ModelUsage,
} from '../shared/usageBudget'

/** renderer へ渡す読み取り用の写し（usage:get の返り値・usage:changed の中身）。 */
export type UsageSnapshot = { settings: BudgetSettings; months: UsageStore }

/** 保存のデバウンス（learningStore.ts と同じ間隔）。 */
const DEBOUNCE_MS = 1500

/** テスト用に差し替える保存先ディレクトリ。null なら app.getPath('userData')（本番）。 */
let dirOverride: string | null = null

/** メモリ上の状態。読み込み前は未確定（loaded=false）。 */
let loaded = false
let settings: BudgetSettings = { ...DEFAULT_SETTINGS, perKeyLimits: {} }
let months: UsageStore = {}
/** 旧localStorageからの移行が済んだか。true になったら mergeMigration は何もしない
 *  （課金データの二重計上防止・仕様書の核心）。 */
let migrated = false
let saveTimer: ReturnType<typeof setTimeout> | null = null

/** 変更のたび呼ばれる通知先（ipc/usage.ts が usage:changed として renderer へ配線する）。 */
let listener: ((snapshot: UsageSnapshot) => void) | null = null
export function setUsageListener(fn: ((snapshot: UsageSnapshot) => void) | null): void {
  listener = fn
}

/**
 * テスト用: 保存先ディレクトリを差し替え、メモリ上の状態を空にリセットする。
 * dir に null を渡すと本番の app.getPath('userData') へ戻る。
 * 本番コード（main.ts・ipc/usage.ts）はこれを呼ばない。
 */
export function initUsageStore(dir: string | null): void {
  dirOverride = dir
  loaded = false
  settings = { ...DEFAULT_SETTINGS, perKeyLimits: {} }
  months = {}
  migrated = false
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
}

function usageFilePath(): string {
  return path.join(dirOverride ?? app.getPath('userData'), 'usage.json')
}

/** 未読み込みなら、ファイルから読む（壊れたJSON・無い場合は既定値として扱う）。 */
function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = fs.readFileSync(usageFilePath(), 'utf-8')
    const parsed = JSON.parse(raw)
    settings = sanitizeSettings(parsed?.settings)
    months = sanitizeMonths(parsed?.months)
    migrated = parsed?.migrated === true
  } catch {
    // ファイルが無い・JSONとして壊れている → 既定値として扱う（掟1: 推測せず安全側へ倒す）。
    settings = { ...DEFAULT_SETTINGS, perKeyLimits: {} }
    months = {}
    migrated = false
  }
}

function cloneSettings(s: BudgetSettings): BudgetSettings {
  return { ...s, perKeyLimits: { ...s.perKeyLimits } }
}

function cloneMonths(src: UsageStore): UsageStore {
  const out: UsageStore = {}
  for (const [month, bucket] of Object.entries(src)) {
    const keys: Record<string, KeyBucket> = {}
    for (const [fp, kb] of Object.entries(bucket.keys)) {
      const modelsOut: Record<string, ModelUsage> = {}
      for (const [model, u] of Object.entries(kb.models)) modelsOut[model] = { ...u }
      keys[fp] = { models: modelsOut }
    }
    out[month] = { keys }
  }
  return out
}

/** 呼び出し側が内部の state を直接書き換えられないようコピーを返す
 *  （learningStore.ts の snapshot() と同じ理由。months は深いネストなので深く複製する）。 */
function snapshot(): UsageSnapshot {
  return { settings: cloneSettings(settings), months: cloneMonths(months) }
}

function notify(): void {
  listener?.(snapshot())
}

function saveNow(): void {
  const file = usageFilePath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, migrated, settings, months }), 'utf-8')
    fs.renameSync(tmp, file) // クラッシュ時の破損防止（learningStore.ts と同じ作法）
  } catch {
    // 保存できなくても致命的ではない（次回の変更でまた保存を試みる）
  }
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveNow()
  }, DEBOUNCE_MS)
}

/** 読み取り用スナップショット（usage:get・renderer 起動時のミラー初期化に使う）。 */
export function getUsageSnapshot(): UsageSnapshot {
  ensureLoaded()
  return snapshot()
}

/**
 * 1回のAPI利用を記録する（fp = hashKey(apiKey)。生キーは main に渡らない）。
 * fp/model が空文字や非文字列なら無視する（IPC 越し・main のターン双方からの不正値を
 * 静かに弾く・掟10 の守り）。
 */
export function recordUsage(fp: string, model: string, promptTokens: number, completionTokens: number): void {
  if (typeof fp !== 'string' || fp === '' || typeof model !== 'string' || model === '') return
  ensureLoaded()
  months = applyRecord(months, thisMonth(), fp, model, promptTokens, completionTokens)
  scheduleSave()
  notify()
}

/** リクエスト前のチェック（現在の設定・実績で判定するだけ。shared の純関数を呼ぶ）。 */
export function checkBeforeRequest(fp: string): { allowed: boolean; message?: string } {
  ensureLoaded()
  return checkBeforeRequestOf(settings, months, thisMonth(), fp)
}

/** 予算設定を丸ごと置き換える（サニタイズを通す）。 */
export function setSettings(raw: unknown): void {
  ensureLoaded()
  settings = sanitizeSettings(raw)
  scheduleSave()
  notify()
}

/**
 * キー個別の上限だけを書き換える（perKeyLimits のマージ。**全置換にしない**）。
 *
 * ── なぜ setSettings を使わずここだけマージするか（掟10）───────────────────
 * 「画面が持っている写しは、いつでも古い」（CLAUDE.md 掟10）。CredentialsModal は
 * 開いた時点の設定の写しを持って丸ごと書き戻す（setSettings）ことがあり、その裏で
 * 別のモーダル（SettingsModal）がキー上限だけを変えていると、丸ごと書き戻しに巻き込まれて
 * 消える。perKeyLimits はここで**現在の main の状態**にマージすることで、他キーの上限を
 * 失わない。
 *
 * limit === undefined は IPC では表現が曖昧（省略と undefined を渡すことの区別が付きにくい）
 * ため使わない。「消す」は明示的に `{ clear: true }` を渡す（ipc/usage.ts の注記）。
 */
export function setKeyLimit(fp: string, limit: number | null | { clear: true }): void {
  if (typeof fp !== 'string' || fp === '') return
  ensureLoaded()
  const perKeyLimits = { ...settings.perKeyLimits }
  if (limit !== null && typeof limit === 'object') {
    if (limit.clear === true) delete perKeyLimits[fp]
    else return // 不正な形は無視（掟10）
  } else if (limit === null) {
    perKeyLimits[fp] = null
  } else if (typeof limit === 'number' && Number.isFinite(limit)) {
    perKeyLimits[fp] = limit
  } else {
    return // 不正な値は無視
  }
  settings = { ...settings, perKeyLimits }
  scheduleSave()
  notify()
}

/** 今月分の利用量をリセット */
export function resetThisMonth(): void {
  ensureLoaded()
  const months2 = { ...months }
  delete months2[thisMonth()]
  months = months2
  scheduleSave()
  notify()
}

/** src < dst へ、キー・モデルごとにトークン数・課金額を**加算**する（新しい at だけ勝つ、ではない。
 *  課金データは重複計上できないため常に加算＝mergeMigration からしか呼ばれない前提）。 */
function mergeMonthsAdditive(dst: UsageStore, src: UsageStore): UsageStore {
  for (const [month, bucket] of Object.entries(src)) {
    const dstBucket = dst[month] ?? { keys: {} }
    for (const [fp, kb] of Object.entries(bucket.keys)) {
      const dstKb = dstBucket.keys[fp] ?? { models: {} }
      for (const [model, u] of Object.entries(kb.models)) {
        const dstU = dstKb.models[model] ?? { promptTokens: 0, completionTokens: 0, costYen: 0 }
        dstU.promptTokens += u.promptTokens
        dstU.completionTokens += u.completionTokens
        dstU.costYen += u.costYen
        dstKb.models[model] = dstU
      }
      dstBucket.keys[fp] = dstKb
    }
    dst[month] = dstBucket
  }
  return dst
}

/**
 * 旧 renderer/localStorage からの片道移行。**migrated が true なら何もしない**
 * （usageMirror.ts の primeUsageMirror が起動のたび呼んでも、2度目以降は完全な no-op＝
 * 課金データを二重計上しない。学習キャッシュ（learningStore.ts）の「新しい at だけ勝つ」は
 * ここでは使えない——利用実績はタイムスタンプの無い加算カウンタなので、2度取り込むと
 * そのまま2倍になる）。
 *
 * settings は payload にあるときだけ sanitize して全置換（渡ってこなければ既存のまま）。
 * months は sanitize（旧 {models} 形式の正規化＝normalizeMonth を内包）してから加算マージする。
 * 旧localStorageのキー自体は消さない（renderer 側の責務・戻せる保険）。
 */
export function mergeMigration(payload: { settings?: unknown; months?: unknown }): void {
  ensureLoaded()
  if (migrated) return // 課金データの二重計上防止（仕様の核心）
  if (payload && Object.prototype.hasOwnProperty.call(payload, 'settings') && payload.settings !== undefined) {
    settings = sanitizeSettings(payload.settings)
  }
  const incoming = sanitizeMonths(payload?.months)
  months = mergeMonthsAdditive(months, incoming)
  migrated = true
  scheduleSave()
  notify()
}

/** 保存待ちを即座に書き切る（quit 時・テスト用）。保存待ちが無ければ何もしない。 */
export function flushUsageNow(): void {
  if (!saveTimer) return
  clearTimeout(saveTimer)
  saveTimer = null
  saveNow()
}
