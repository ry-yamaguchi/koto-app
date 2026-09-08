import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  loadZones, clearZonesCache, primeZonesCache, resetZonesCacheForTest,
} from '../src/renderer/zonesCache'

// roadmap #28・2026-09-08 Ryosuke さん依頼: 「起動時に一度だけ取得して、使い回す」キャッシュ。
// 専有型パネル（AppRunDedicatedPanel）・共用型 AppRun（AppRunPanel）の両方がここを通す。
//
// vitest.config.ts は environment: 'node'（jsdom無し）なので、window は自前の最小モックで
// 用意する。addEventListener は「登録されたハンドラを覚えて、後から手で発火できる」だけの
// 素朴な実装（学習キャッシュ側テストの window モックと同じ考え方・tests/learningMirror.test.ts）。

function fakeWindow(overrides: { loadKey: any; zones: any }) {
  const listeners: Record<string, Array<() => void>> = {}
  return {
    addEventListener: (evt: string, cb: () => void) => { (listeners[evt] ??= []).push(cb) },
    removeEventListener: () => {},
    // テストからイベントを手で起こすためのヘルパ（本物の window には無い）。
    __fire: (evt: string) => { for (const cb of listeners[evt] ?? []) cb() },
    electronAPI: {
      cloud: { loadKey: overrides.loadKey },
      apprunDedicated: { zones: overrides.zones },
    },
  }
}

const OK_DATA = { Zones: [{ Name: 'tk1a', Description: '東京第1ゾーン', IsDummy: false, DisplayOrder: 20021001 }] }

beforeEach(() => {
  resetZonesCacheForTest()
})
afterEach(() => {
  delete (globalThis as any).window
})

describe('loadZones: キーが未登録なら、APIを呼ばずに ok:false を返す', () => {
  it('cloud.loadKey() が null を返すとき、apprunDedicated.zones は一度も呼ばれない', async () => {
    const loadKey = vi.fn().mockResolvedValue(null)
    const zones = vi.fn()
    ;(globalThis as any).window = fakeWindow({ loadKey, zones })

    const r = await loadZones()
    expect(r.ok).toBe(false)
    expect(r.rows).toEqual([])
    expect(typeof r.message).toBe('string')
    expect(zones).not.toHaveBeenCalled()
  })

  it('token/secret が空文字でも未登録扱い（APIを呼ばない）', async () => {
    const loadKey = vi.fn().mockResolvedValue({ token: '', secret: '' })
    const zones = vi.fn()
    ;(globalThis as any).window = fakeWindow({ loadKey, zones })

    const r = await loadZones()
    expect(r.ok).toBe(false)
    expect(zones).not.toHaveBeenCalled()
  })
})

describe('loadZones: 成功したら結果を保持し、以後は即返す', () => {
  it('2回目以降は apprunDedicated.zones を叩き直さず、キャッシュを返す', async () => {
    const loadKey = vi.fn().mockResolvedValue({ token: 't', secret: 's' })
    const zones = vi.fn().mockResolvedValue({ ok: true, data: OK_DATA })
    ;(globalThis as any).window = fakeWindow({ loadKey, zones })

    const r1 = await loadZones()
    expect(r1.ok).toBe(true)
    expect(r1.rows.map(z => z.name)).toEqual(['tk1a'])
    expect(zones).toHaveBeenCalledTimes(1)

    const r2 = await loadZones()
    expect(r2).toEqual(r1)
    expect(zones).toHaveBeenCalledTimes(1) // 叩き直していない
  })

  it('force=true は成功済みキャッシュがあっても取り直す', async () => {
    const loadKey = vi.fn().mockResolvedValue({ token: 't', secret: 's' })
    const zones = vi.fn().mockResolvedValue({ ok: true, data: OK_DATA })
    ;(globalThis as any).window = fakeWindow({ loadKey, zones })

    await loadZones()
    expect(zones).toHaveBeenCalledTimes(1)
    await loadZones(true)
    expect(zones).toHaveBeenCalledTimes(2)
  })

  it('失敗はキャッシュされない: 次の呼び出し（forceなし）が取り直す', async () => {
    const loadKey = vi.fn().mockResolvedValue({ token: 't', secret: 's' })
    const zones = vi.fn()
      .mockResolvedValueOnce({ ok: false, message: '一時的なエラー' })
      .mockResolvedValueOnce({ ok: true, data: OK_DATA })
    ;(globalThis as any).window = fakeWindow({ loadKey, zones })

    const r1 = await loadZones()
    expect(r1.ok).toBe(false)
    const r2 = await loadZones() // force無しでも、前回が失敗なら取り直す
    expect(r2.ok).toBe(true)
    expect(zones).toHaveBeenCalledTimes(2)
  })
})

describe('loadZones: 同時に呼んでも1回しか叩かない（取得中の Promise を共有する）', () => {
  it('2つの呼び出しが同じ Promise を共有し、apprunDedicated.zones は1回だけ呼ばれる', async () => {
    const loadKey = vi.fn().mockResolvedValue({ token: 't', secret: 's' })
    let resolveZones: (v: unknown) => void = () => {}
    const zones = vi.fn(() => new Promise(res => { resolveZones = res }))
    ;(globalThis as any).window = fakeWindow({ loadKey, zones })

    const p1 = loadZones()
    const p2 = loadZones(true) // force を付けても、取得中なら同じ Promise を共有する
    // loadKey() の解決（マイクロタスク）を挟んでから zones() が呼ばれるので、1tick 待つ。
    await new Promise(r => setImmediate(r))
    expect(zones).toHaveBeenCalledTimes(1)

    resolveZones({ ok: true, data: OK_DATA })
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toEqual(r2)
    expect(r1.ok).toBe(true)
  })
})

describe("primeZonesCache: 'sakura:credentials-changed' でキャッシュを捨てる", () => {
  it('credentials-changed の後は、次の loadZones が取り直す（前のキーの結果を引きずらない）', async () => {
    const loadKey = vi.fn().mockResolvedValue({ token: 't1', secret: 's1' })
    const zones = vi.fn().mockResolvedValue({ ok: true, data: OK_DATA })
    const fw = fakeWindow({ loadKey, zones })
    ;(globalThis as any).window = fw

    primeZonesCache() // 起動時の1回目（fire-and-forget）を投げる
    await new Promise(r => setImmediate(r))
    expect(zones).toHaveBeenCalledTimes(1)

    await loadZones() // キャッシュ済みなので叩かない
    expect(zones).toHaveBeenCalledTimes(1)

    fw.__fire('sakura:credentials-changed')
    await loadZones()
    expect(zones).toHaveBeenCalledTimes(2) // 捨てられたので取り直した
  })

  it('取得の途中で credentials-changed が来た場合、その（古い鍵の）結果はキャッシュへ書き込まれない', async () => {
    const loadKey = vi.fn().mockResolvedValue({ token: 't1', secret: 's1' })
    let resolveFirst: (v: unknown) => void = () => {}
    const zones = vi.fn()
      .mockImplementationOnce(() => new Promise(res => { resolveFirst = res })) // 1回目: 保留
      .mockResolvedValueOnce({ ok: true, data: OK_DATA }) // 2回目（credentials-changed後の取り直し）
    const fw = fakeWindow({ loadKey, zones })
    ;(globalThis as any).window = fw

    primeZonesCache()
    // 1回目はまだ保留中。ここで鍵が変わる。
    fw.__fire('sakura:credentials-changed')

    // 鍵が変わった後の呼び出しは、保留中の Promise を共有せず新しく取りに行く
    // （inflight も credentials-changed でクリアされているため）。
    const r2 = await loadZones()
    expect(r2.ok).toBe(true)
    expect(zones).toHaveBeenCalledTimes(2)

    // 1回目（古い鍵）が遅れて成功しても、キャッシュ（新しい鍵の結果）を上書きしない。
    resolveFirst({ ok: true, data: { Zones: [{ Name: 'tk1v', Description: 'Sandbox', IsDummy: true, DisplayOrder: 1 }] } })
    await new Promise(r => setImmediate(r))
    const r3 = await loadZones() // まだ叩き直さず、r2 と同じキャッシュを返すはず
    expect(r3.rows.map(z => z.name)).toEqual(['tk1a'])
    expect(zones).toHaveBeenCalledTimes(2) // 3回目は呼ばれていない（キャッシュのまま）
  })

  it('primeZonesCache を2回呼んでも初回取得は1回だけ（primed ガード）。credentials-changed も引き続き効く', async () => {
    const loadKey = vi.fn().mockResolvedValue({ token: 't', secret: 's' })
    const zones = vi.fn().mockResolvedValue({ ok: true, data: OK_DATA })
    const fw = fakeWindow({ loadKey, zones })
    ;(globalThis as any).window = fw

    primeZonesCache()
    primeZonesCache() // 2回目は primed により何もしない（起動時の1回だけ、の約束）
    await new Promise(r => setImmediate(r))
    expect(zones).toHaveBeenCalledTimes(1) // 初回取得も1回だけ

    fw.__fire('sakura:credentials-changed')
    await loadZones()
    expect(zones).toHaveBeenCalledTimes(2) // credentials-changed 後は取り直す
  })
})

describe('clearZonesCache: 直接呼んでも同じ効果', () => {
  it('clearZonesCache() の後、次の loadZones は取り直す', async () => {
    const loadKey = vi.fn().mockResolvedValue({ token: 't', secret: 's' })
    const zones = vi.fn().mockResolvedValue({ ok: true, data: OK_DATA })
    ;(globalThis as any).window = fakeWindow({ loadKey, zones })

    await loadZones()
    expect(zones).toHaveBeenCalledTimes(1)
    clearZonesCache()
    await loadZones()
    expect(zones).toHaveBeenCalledTimes(2)
  })
})

describe('loadZones: window / electronAPI が無い環境（node のテスト）では何もしない', () => {
  it('window 未定義でも例外を投げず、ok:false を返す', async () => {
    const r = await loadZones()
    expect(r.ok).toBe(false)
    expect(r.rows).toEqual([])
  })

  it('primeZonesCache() も window 未定義なら何もしない（例外を投げない）', () => {
    expect(() => primeZonesCache()).not.toThrow()
  })
})
