// usageMirror.ts — 予算設定・利用実績の、renderer 側の写し（B'-3d-1b）。
// 持ち主は main の src/main/usageStore.ts（userData/usage.json）。
//
// ── なぜ写し（ミラー）にしたか（learningMirror.ts と同じ理由）───────────────
// checkBeforeRequest / getUsage 等（renderer/usage.ts）は、送信前チェック・設定画面の表示から
// **同期**で呼ばれる。main へ毎回 IPC 往復していては同期のままでは書けない。そこで、
// モジュールレベルの変数（mirror）に main の内容を写し、判定・計算はこの写しに対して行う
// （判定ロジック自体は shared/usageBudget.ts の純関数・store を引数に取る形）。
//
// ── 楽観更新（learningMirror.ts の setMirrorEntry 等と同じ考え方）───────────
// recordUsage・setSettings・setKeyLimit・resetThisMonth は main への IPC 応答を待たず、
// その場でミラーへ反映してから fire-and-forget で main へも送る（renderer/usage.ts 側）。
// 送信前チェックが「たった今記録した分」を正しく見られるようにするため（read-after-write）。
//
// ── 起動時の非同期プライムで足りる理由 ───────────────────────────────────
// 読みが必要になるのは①送信前チェック②設定画面の表示③CredentialsModal のキー別上限、
// いずれも利用者の操作（アプリ起動直後ではない）の後に発生する。mirror が既定値のまま
// 最初の数十ms レンダーされても実害は無く（判定は「上限 ¥500・既定」という安全側の既定値）、
// primeUsageMirror() が usage:get の応答を受け取り次第すぐに実体で上書きされる。
import {
  DEFAULT_SETTINGS, sanitizeSettings, sanitizeMonths, applyRecord, thisMonth,
  type BudgetSettings, type UsageStore, type KeyBucket, type ModelUsage,
} from '../shared/usageBudget'

type Mirror = { settings: BudgetSettings; months: UsageStore }

function emptySettings(): BudgetSettings {
  return { ...DEFAULT_SETTINGS, perKeyLimits: {} }
}

let mirror: Mirror = { settings: emptySettings(), months: {} }

/** renderer/usage.ts が判定・表示に使う、現在の写し（読み取り専用の利用を前提にする。
 *  書き換えは applyRecordToMirror 等の楽観更新ヘルパーを必ず経由する）。 */
export function getUsageMirror(): Mirror {
  return mirror
}

/** months だけの深い複製（学習キャッシュと違い values が入れ子のため、浅いコピーでは
 *  「新オブジェクトを作って差し替え」にならない＝applyRecord が既存の入れ子を直接書き換えて
 *  しまう前に複製する）。 */
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

function fireChanged(): void {
  window.dispatchEvent(new Event('sakura-usage-changed'))
}

/** 楽観更新: main への usage:record の返事を待たずに、その場で写しへ反映する
 *  （renderer/usage.ts の recordUsage から呼ぶ・fire-and-forget の一部）。数式は
 *  shared/usageBudget.ts の applyRecord をそのまま使う（複製しない・掟10）。 */
export function applyRecordToMirror(fp: string, model: string, promptTokens: number, completionTokens: number): void {
  const months = applyRecord(cloneMonths(mirror.months), thisMonth(), fp, model, promptTokens, completionTokens)
  mirror = { ...mirror, months }
  fireChanged()
}

/** 楽観更新: main への usage:setSettings の返事を待たずに写しへ反映する。
 *  sanitizeSettings を通す（renderer 発でも形は必ず検証する・IPC/ファイル由来と同じ扱い）。 */
export function setSettingsInMirror(raw: unknown): void {
  mirror = { ...mirror, settings: sanitizeSettings(raw) }
  fireChanged()
}

/** 楽観更新: main への usage:setKeyLimit の返事を待たずに perKeyLimits だけを書き換える。
 *  limit === undefined は「消す」（renderer/usage.ts の setKeyLimit 呼び出し規約と同じ。
 *  main への IPC 送信時だけ { clear: true } に変換する）。 */
export function setKeyLimitInMirror(fp: string, limit: number | null | undefined): void {
  const perKeyLimits = { ...mirror.settings.perKeyLimits }
  if (limit === undefined) delete perKeyLimits[fp]
  else perKeyLimits[fp] = limit
  mirror = { ...mirror, settings: { ...mirror.settings, perKeyLimits } }
  fireChanged()
}

/** 楽観更新: 今月分の利用量を写しから消す（main への usage:reset と対になる）。 */
export function resetMonthInMirror(): void {
  const months = { ...mirror.months }
  delete months[thisMonth()]
  mirror = { ...mirror, months }
  fireChanged()
}

/** usage:get の初回応答・usage:changed の通知を写しへ反映する（main が正）。 */
function applySnapshot(snapshot: { settings: unknown; months: unknown }): void {
  mirror = { settings: sanitizeSettings(snapshot?.settings), months: sanitizeMonths(snapshot?.months) }
  fireChanged()
}

// ── 片道移行（旧 localStorage → main の usage.json）─────────────────────
//
// 値そのものは renderer/usage.ts の旧実装が使っていたキー名と同じ（互換の要・1文字も変えない）。
// ここで import すると usage.ts との循環importになるため、値をそのまま複製する
// （移行専用の一度きりの処理であり、一致していることは tests/usageMirror.test.ts で固定する）。
const LEGACY_SETTINGS_KEY = 'sakura_budget_settings'
const LEGACY_USAGE_KEY = 'sakura_usage_by_month'

function readLegacy(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return undefined
    return JSON.parse(raw)
  } catch {
    return undefined // 壊れたJSONは無視する（main 側の sanitize もどのみち弾く）
  }
}

/**
 * 旧 localStorage の中身を main（usage.json）へ送る。**消さない**（learningMirror.ts と同じ
 * 判断: 「壊れたら戻せる保険」を残す）。main 側の mergeMigration は「migrated なら何もしない」
 * ため、起動のたび呼んでも安全（2回目以降は完全な no-op＝二重計上しない）。
 */
function migrateLegacyOnce(): void {
  const settings = readLegacy(LEGACY_SETTINGS_KEY)
  const months = readLegacy(LEGACY_USAGE_KEY)
  if (settings === undefined && months === undefined) return
  window.electronAPI.usage.migrate({ settings, months }).catch(() => { /* 次回起動時にまた試す */ })
}

let primed = false

/**
 * 起動時に1度だけ呼ぶ（App.tsx のマウント時 effect・primeLearningMirror と並べて呼ぶ）。
 * usage:get で写しを初期化し、usage:changed を購読して以後の変更を反映する。window が無い
 * 環境（node のテスト）では何もしない（mirror は既定値のまま＝安全側の既定＝上限 ¥500 で
 * enforce=true のまま動く）。
 */
export function primeUsageMirror(): void {
  if (typeof window === 'undefined' || !window.electronAPI?.usage) return
  if (primed) return
  primed = true

  migrateLegacyOnce()

  window.electronAPI.usage.get()
    .then(applySnapshot)
    .catch(() => { /* 読めなくても mirror は既定値のまま続く */ })

  window.electronAPI.usage.onChanged(applySnapshot)
}

/** テスト用: モジュール内の状態（mirror・primed）をリセットする。 */
export function resetUsageMirrorForTest(): void {
  mirror = { settings: emptySettings(), months: {} }
  primed = false
}
