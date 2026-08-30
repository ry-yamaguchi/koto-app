// B'-3d-1b: 予算設定・利用実績の持ち主を main へ移す（src/main/usageStore.ts）。
// tests/learningStore.test.ts と同じ流儀: 実ファイル（一時フォルダ）で record → 読み直し・
// デバウンス後のファイル内容・atomic 書き込み・setKeyLimit のマージ・壊れた usage.json を検証する。
// 加えて、ここは**課金データ**なので mergeMigration が「1度きり」であることを重点的に確かめる
// （学習キャッシュの「新しい at だけ勝つ」方式と違い、2度混ぜると二重計上になる）。
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  initUsageStore, getUsageSnapshot, recordUsage, checkBeforeRequest, setSettings, setKeyLimit,
  resetThisMonth, mergeMigration, flushUsageNow, setUsageListener, type UsageSnapshot,
} from '../src/main/usageStore'
import { hashKey, PRICING, DEFAULT_SETTINGS } from '../src/shared/usageBudget'

let tmpDirs: string[] = []
function mkTmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-usagestore-'))
  tmpDirs.push(d)
  return d
}

let dir: string
beforeEach(() => {
  tmpDirs = []
  dir = mkTmpDir()
  initUsageStore(dir) // メモリをリセットし、以後この一時フォルダへ read/write する
})
afterEach(() => {
  setUsageListener(null)
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})

const usageJsonPath = () => path.join(dir, 'usage.json')
const KEY_A = 'sk-aaaaaaaaaaaaaaaa'
const KEY_B = 'sk-bbbbbbbbbbbbbbbb'
const FP_A = hashKey(KEY_A)
const FP_B = hashKey(KEY_B)
const MODEL = Object.keys(PRICING)[0]

describe('usageStore: getUsageSnapshot（未保存）', () => {
  it('ファイルが無ければ既定値', () => {
    const s = getUsageSnapshot()
    expect(s.settings).toEqual({ ...DEFAULT_SETTINGS, perKeyLimits: {} })
    expect(s.months).toEqual({})
  })
})

describe('usageStore: recordUsage ⇄ getUsageSnapshot（記録の往復）', () => {
  it('記録すると読み戻せる（指紋ベース・キーごとに分離）', () => {
    recordUsage(FP_A, MODEL, 1000, 500)
    recordUsage(FP_B, MODEL, 1, 1)
    const s = getUsageSnapshot()
    const month = Object.keys(s.months)[0]
    expect(s.months[month].keys[FP_A].models[MODEL]).toEqual(expect.objectContaining({ promptTokens: 1000, completionTokens: 500 }))
    expect(s.months[month].keys[FP_B].models[MODEL]).toEqual(expect.objectContaining({ promptTokens: 1, completionTokens: 1 }))
  })

  it('複数回の記録が積み上がる', () => {
    recordUsage(FP_A, MODEL, 1000, 500)
    recordUsage(FP_A, MODEL, 1000, 500)
    const s = getUsageSnapshot()
    const month = Object.keys(s.months)[0]
    expect(s.months[month].keys[FP_A].models[MODEL].promptTokens).toBe(2000)
  })

  it('fp が空文字・非文字列なら無視する（掟10の守り）', () => {
    recordUsage('', MODEL, 1000, 500)
    recordUsage(undefined as any, MODEL, 1000, 500)
    expect(getUsageSnapshot().months).toEqual({})
  })

  it('model が空文字・非文字列なら無視する', () => {
    recordUsage(FP_A, '', 1000, 500)
    recordUsage(FP_A, undefined as any, 1000, 500)
    expect(getUsageSnapshot().months).toEqual({})
  })

  it('getUsageSnapshot が返すのは写し（呼び出し側が書き換えても内部状態は壊れない）', () => {
    recordUsage(FP_A, MODEL, 1000, 500)
    const s1 = getUsageSnapshot()
    const month = Object.keys(s1.months)[0]
    ;(s1.months[month].keys[FP_A].models[MODEL] as any).promptTokens = 999999
    const s2 = getUsageSnapshot()
    expect(s2.months[month].keys[FP_A].models[MODEL].promptTokens).toBe(1000)
  })
})

describe('usageStore: checkBeforeRequest（settings・実績の両方を見る）', () => {
  it('enforce オフなら通す', () => {
    setSettings({ ...DEFAULT_SETTINGS, enforce: false, monthlyLimitYen: 1 })
    recordUsage(FP_A, MODEL, 100_000_000, 100_000_000)
    expect(checkBeforeRequest(FP_A).allowed).toBe(true)
  })

  it('上限に達したら止める', () => {
    setSettings({ ...DEFAULT_SETTINGS, enforce: true, monthlyLimitYen: 1 })
    recordUsage(FP_A, MODEL, 100_000_000, 0)
    const r = checkBeforeRequest(FP_A)
    expect(r.allowed).toBe(false)
    expect(r.message).toContain('上限')
  })

  it('キーごとに独立している', () => {
    setSettings({ ...DEFAULT_SETTINGS, enforce: true, monthlyLimitYen: 1 })
    recordUsage(FP_A, MODEL, 100_000_000, 0)
    expect(checkBeforeRequest(FP_A).allowed).toBe(false)
    expect(checkBeforeRequest(FP_B).allowed).toBe(true)
  })
})

describe('usageStore: setSettings（全置換・サニタイズを通す）', () => {
  it('壊れた形は既定値へ倒れる', () => {
    setSettings({ monthlyLimitYen: 'abc', enforce: 'yes', perKeyLimits: 'not-an-object' } as any)
    const s = getUsageSnapshot().settings
    expect(s.monthlyLimitYen).toBe(DEFAULT_SETTINGS.monthlyLimitYen)
    expect(s.enforce).toBe(DEFAULT_SETTINGS.enforce)
    expect(s.perKeyLimits).toEqual({})
  })

  it('危険なキー（__proto__ 等）は弾く', () => {
    const raw = JSON.parse(`{"perKeyLimits": {"__proto__": 999, "${FP_A}": 10}}`)
    setSettings(raw)
    expect(getUsageSnapshot().settings.perKeyLimits).toEqual({ [FP_A]: 10 })
  })
})

describe('usageStore: setKeyLimit（perKeyLimits だけを main 側でマージ・全置換にしない）', () => {
  it('個別上限を設定できる', () => {
    setKeyLimit(FP_A, 10)
    expect(getUsageSnapshot().settings.perKeyLimits[FP_A]).toBe(10)
  })

  it('null（無制限）を設定できる', () => {
    setKeyLimit(FP_A, null)
    expect(getUsageSnapshot().settings.perKeyLimits[FP_A]).toBeNull()
  })

  it('{ clear: true } で消せる', () => {
    setKeyLimit(FP_A, 10)
    setKeyLimit(FP_A, { clear: true })
    expect(Object.prototype.hasOwnProperty.call(getUsageSnapshot().settings.perKeyLimits, FP_A)).toBe(false)
  })

  it('★ 全置換にしない: 他キーの上限を消さずにマージする', () => {
    setKeyLimit(FP_A, 10)
    setKeyLimit(FP_B, 20)
    expect(getUsageSnapshot().settings.perKeyLimits).toEqual({ [FP_A]: 10, [FP_B]: 20 })
  })

  it('★ setSettings の丸ごと書き戻しと衝突しても、直前の setKeyLimit を失わない', () => {
    // CredentialsModal 相当（setSettings で丸ごと書き戻す）と SettingsModal 相当
    // （setKeyLimit でキー個別だけ変える）が入れ替わって呼ばれても、後勝ちの setKeyLimit が
    // 効くこと（掟10: 「画面が持っている写しは、いつでも古い」の再発防止）。
    setSettings({ ...DEFAULT_SETTINGS, perKeyLimits: { [FP_B]: 5 } })
    setKeyLimit(FP_A, 10)
    expect(getUsageSnapshot().settings.perKeyLimits).toEqual({ [FP_B]: 5, [FP_A]: 10 })
  })

  it('fp が空文字なら無視する', () => {
    setKeyLimit('', 10)
    expect(getUsageSnapshot().settings.perKeyLimits).toEqual({})
  })
})

describe('usageStore: resetThisMonth', () => {
  it('今月分だけ消える', () => {
    recordUsage(FP_A, MODEL, 1000, 500)
    resetThisMonth()
    expect(getUsageSnapshot().months).toEqual({})
  })
})

describe('usageStore: 保存（デバウンス・quit時フラッシュ・atomic書き込み・ファイルの形）', () => {
  it('record 直後はまだファイルへ書かれない（1.5秒デバウンス）', () => {
    recordUsage(FP_A, MODEL, 1000, 500)
    expect(fs.existsSync(usageJsonPath())).toBe(false)
  })

  it('flushUsageNow でデバウンスを待たずに書かれる。形は { v:1, migrated, settings, months }', () => {
    recordUsage(FP_A, MODEL, 1000, 500)
    flushUsageNow()
    expect(fs.existsSync(usageJsonPath())).toBe(true)
    const raw = JSON.parse(fs.readFileSync(usageJsonPath(), 'utf-8'))
    expect(raw.v).toBe(1)
    expect(raw.migrated).toBe(false)
    expect(raw.settings).toEqual({ ...DEFAULT_SETTINGS, perKeyLimits: {} })
    const month = Object.keys(raw.months)[0]
    expect(raw.months[month].keys[FP_A].models[MODEL]).toEqual(expect.objectContaining({ promptTokens: 1000, completionTokens: 500 }))
  })

  it('.tmp ファイルが残らない（atomic write）', () => {
    recordUsage(FP_A, MODEL, 1000, 500)
    flushUsageNow()
    expect(fs.existsSync(`${usageJsonPath()}.tmp`)).toBe(false)
  })

  it('書いたファイルを読み直せる（メモリを空にしてから）', () => {
    recordUsage(FP_A, MODEL, 1000, 500)
    flushUsageNow()
    initUsageStore(dir) // メモリだけリセット（同じディレクトリ）→ 次回アクセスでファイルから読み直す
    const month = Object.keys(getUsageSnapshot().months)[0]
    expect(getUsageSnapshot().months[month].keys[FP_A].models[MODEL].promptTokens).toBe(1000)
  })

  it('保留が無ければ flushUsageNow は何もしない（ファイルを作らない）', () => {
    flushUsageNow()
    expect(fs.existsSync(usageJsonPath())).toBe(false)
  })

  it('デバウンスタイマーで実際に書かれる', async () => {
    vi.useFakeTimers()
    try {
      recordUsage(FP_A, MODEL, 1000, 500)
      expect(fs.existsSync(usageJsonPath())).toBe(false)
      vi.advanceTimersByTime(1500)
      expect(fs.existsSync(usageJsonPath())).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('usageStore: 壊れた usage.json', () => {
  it('壊れたJSONは既定値として扱われる（例外を投げない）', () => {
    fs.writeFileSync(usageJsonPath(), '{not valid json', 'utf-8')
    expect(() => getUsageSnapshot()).not.toThrow()
    const s = getUsageSnapshot()
    expect(s.settings).toEqual({ ...DEFAULT_SETTINGS, perKeyLimits: {} })
    expect(s.months).toEqual({})
  })

  it('想定外の形（配列）でも既定値として扱われる', () => {
    fs.writeFileSync(usageJsonPath(), JSON.stringify(['not', 'an', 'object']), 'utf-8')
    const s = getUsageSnapshot()
    expect(s.settings).toEqual({ ...DEFAULT_SETTINGS, perKeyLimits: {} })
    expect(s.months).toEqual({})
  })

  it('壊れたファイルの上から記録すると、正常なJSONで上書きされる', () => {
    fs.writeFileSync(usageJsonPath(), '{not valid json', 'utf-8')
    recordUsage(FP_A, MODEL, 1000, 500)
    flushUsageNow()
    const raw = JSON.parse(fs.readFileSync(usageJsonPath(), 'utf-8'))
    const month = Object.keys(raw.months)[0]
    expect(raw.months[month].keys[FP_A].models[MODEL].promptTokens).toBe(1000)
  })

  it('不正な月キー・負のカウンタは sanitize で弾かれる／0に丸められる', () => {
    fs.writeFileSync(usageJsonPath(), JSON.stringify({
      v: 1,
      migrated: false,
      settings: DEFAULT_SETTINGS,
      months: {
        'not-a-month': { keys: { [FP_A]: { models: { [MODEL]: { promptTokens: 1, completionTokens: 1, costYen: 1 } } } } },
        '2026-08': { keys: { [FP_A]: { models: { [MODEL]: { promptTokens: -5, completionTokens: NaN, costYen: 1 } } } } },
      },
    }), 'utf-8')
    const s = getUsageSnapshot()
    expect(Object.keys(s.months)).toEqual(['2026-08'])
    expect(s.months['2026-08'].keys[FP_A].models[MODEL]).toEqual({ promptTokens: 0, completionTokens: 0, costYen: 1 })
  })
})

describe('usageStore: mergeMigration（旧localStorageからの片道移行・課金データなので1度きり）', () => {
  it('main 側に無いキー・モデルは加算で取り込まれる', () => {
    mergeMigration({ months: { '2026-08': { keys: { [FP_A]: { models: { [MODEL]: { promptTokens: 100, completionTokens: 50, costYen: 1.5 } } } } } } })
    const s = getUsageSnapshot()
    expect(s.months['2026-08'].keys[FP_A].models[MODEL]).toEqual({ promptTokens: 100, completionTokens: 50, costYen: 1.5 })
  })

  it('★ main 側に既にある実績とは加算する（新しい at だけ勝つ、ではない＝タイムスタンプが無いため）', () => {
    recordUsage(FP_A, MODEL, 1000, 500) // 今月に main 側の実績を作る
    const s0 = getUsageSnapshot()
    const month = Object.keys(s0.months)[0]
    mergeMigration({ months: { [month]: { keys: { [FP_A]: { models: { [MODEL]: { promptTokens: 100, completionTokens: 50, costYen: 1 } } } } } } })
    const s = getUsageSnapshot()
    expect(s.months[month].keys[FP_A].models[MODEL].promptTokens).toBe(1100)
    expect(s.months[month].keys[FP_A].models[MODEL].completionTokens).toBe(550)
  })

  it('★★ 二重に呼んでも二重計上しない（migrated フラグで2回目以降は完全な no-op）', () => {
    const payload = { months: { '2026-08': { keys: { [FP_A]: { models: { [MODEL]: { promptTokens: 100, completionTokens: 50, costYen: 1.5 } } } } } } }
    mergeMigration(payload)
    const once = getUsageSnapshot()
    mergeMigration(payload) // 2回目
    const twice = getUsageSnapshot()
    expect(twice).toEqual(once)
    expect(twice.months['2026-08'].keys[FP_A].models[MODEL].promptTokens).toBe(100) // 200 になっていない
  })

  it('migrated フラグがファイルへ保存される', () => {
    mergeMigration({ months: {} })
    flushUsageNow()
    const raw = JSON.parse(fs.readFileSync(usageJsonPath(), 'utf-8'))
    expect(raw.migrated).toBe(true)
  })

  it('settings は payload にあるときだけ sanitize して置換される', () => {
    mergeMigration({ settings: { ...DEFAULT_SETTINGS, monthlyLimitYen: 999, enforce: false } })
    expect(getUsageSnapshot().settings.monthlyLimitYen).toBe(999)
    expect(getUsageSnapshot().settings.enforce).toBe(false)
  })

  it('settings が payload に無ければ既存の設定を保つ', () => {
    setSettings({ ...DEFAULT_SETTINGS, monthlyLimitYen: 42 })
    mergeMigration({ months: {} })
    expect(getUsageSnapshot().settings.monthlyLimitYen).toBe(42)
  })

  it('旧 {models} 形式（normalizeMonth の移行元）も取り込める', () => {
    mergeMigration({ months: { '2026-08': { models: { [MODEL]: { promptTokens: 10, completionTokens: 20, costYen: 1 } } } } })
    const s = getUsageSnapshot()
    expect(s.months['2026-08'].keys['(以前の利用)'].models[MODEL]).toEqual({ promptTokens: 10, completionTokens: 20, costYen: 1 })
  })

  it('壊れた形（配列・boolean欠落等）は sanitize で弾かれ、例外を投げない', () => {
    expect(() => mergeMigration({ months: ['not', 'valid'] as any })).not.toThrow()
    expect(getUsageSnapshot().months).toEqual({})
  })

  it('payload が空でも例外を投げない（migrated にはなる）', () => {
    expect(() => mergeMigration({})).not.toThrow()
    flushUsageNow()
    const raw = JSON.parse(fs.readFileSync(usageJsonPath(), 'utf-8'))
    expect(raw.migrated).toBe(true)
  })
})

describe('usageStore: setUsageListener（変更のたび呼ばれる押し出し口）', () => {
  it('record・setSettings・setKeyLimit・reset・migrate のたびに最新スナップショットで呼ばれる', () => {
    const calls: UsageSnapshot[] = []
    setUsageListener((s) => calls.push(s))
    recordUsage(FP_A, MODEL, 1000, 500)
    setSettings({ ...DEFAULT_SETTINGS, monthlyLimitYen: 1 })
    setKeyLimit(FP_A, 10)
    resetThisMonth()
    mergeMigration({ months: {} })
    expect(calls).toHaveLength(5)
  })

  it('setUsageListener(null) で外せる（以後は呼ばれない）', () => {
    let called = 0
    setUsageListener(() => { called++ })
    setUsageListener(null)
    recordUsage(FP_A, MODEL, 1000, 500)
    expect(called).toBe(0)
  })
})
