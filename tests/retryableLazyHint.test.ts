import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRetryableLazy } from '../src/renderer/retryableLazy'
import { createHintTimer } from '../src/renderer/hintTimer'

afterEach(() => { vi.useRealTimers() })

// lazy の偽物: 渡された読み込み関数をそのまま持つ（本物は失敗を覚えて返し続けるので、差し替わったかを型の同一性で見る）
const fakeLazy = (f: any) => ({ factory: f }) as any

describe('createRetryableLazy: 失敗した読み込みは、読み込み直すと import をやり直す', () => {
  it('★★★ 1回目は失敗 → 次の描画は新しい lazy → その中で import が再び呼ばれ、成功する（呼び出しの一覧）', async () => {
    const calls: string[] = []
    let n = 0
    const Comp = createRetryableLazy<any>(() => { calls.push('import'); return ++n === 1 ? Promise.reject(new Error('chunk')) : Promise.resolve({ default: () => null }) }, fakeLazy)
    const first = (Comp as any)({}).type
    await expect(first.factory()).rejects.toThrow('chunk')
    const second = (Comp as any)({}).type
    expect(second).not.toBe(first) // 失敗を覚えた lazy は使い回さない
    await expect(second.factory()).resolves.toBeTruthy()
    expect(calls).toEqual(['import', 'import'])
  })

  it('★★ 失敗していなければ同じ lazy を使い続ける', () => {
    const Comp = createRetryableLazy<any>(() => Promise.resolve({ default: () => null }), fakeLazy)
    expect((Comp as any)({}).type).toBe((Comp as any)({}).type)
  })

  it('★★ App.tsx の EditorPanel は createRetryableLazy で作り、素の lazy(() => import(EditorPanel)) は無い', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/renderer/App.tsx'), 'utf8')
    expect(src).toContain("const EditorPanel = createRetryableLazy(() => import('./components/EditorPanel'))")
    expect(src).not.toContain("lazy(() => import('./components/EditorPanel'))\n")
  })
})

describe('createHintTimer: 案内が続けて出ても、先の時計が後の案内を早く消さない', () => {
  it('★★★ t=0 に案内A → t=10 に案内B → t=12 でもBは残り、t=22 で消える（出した文の一覧）', () => {
    vi.useFakeTimers()
    const seen: (string | null)[] = []
    const show = createHintTimer(t => seen.push(t), 12000)
    show('A')
    vi.advanceTimersByTime(10000)
    show('B')
    vi.advanceTimersByTime(2000)
    expect(seen).toEqual(['A', 'B'])
    vi.advanceTimersByTime(9999)
    expect(seen).toEqual(['A', 'B'])
    vi.advanceTimersByTime(1)
    expect(seen).toEqual(['A', 'B', null])
  })

  it('★★ Sidebar は案内を showDropHint（hintTimer）で出し、素の setTimeout で消さない', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/renderer/components/Sidebar.tsx'), 'utf8')
    expect(src).toContain('showHint: showDropHint,')
    expect(src).toContain('createHintTimer(setDropHint, 12000)')
    expect(src).not.toContain('setTimeout(() => setDropHint(null)')
  })
})
