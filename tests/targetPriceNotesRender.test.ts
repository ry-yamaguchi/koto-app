import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'

// ── HANAMII・Vercel の画面の冒頭に出す料金の案内を、画面を実際に描いて確かめる（0.6.26）────────────────
// 2つの画面は、冒頭の説明の次の行に「料金は〜の公式サイトでご確認ください。」を出し、その下に公式サイトへのリンクを置く。
// 金額は書かない（原本で確かめていない。推測しない）。選択カード側は tests/ops-modal-behavior.test.ts が描いて確かめている。
// ソースの文字列を読むだけのテスト（tests/targetPriceNotes.test.ts）は、行を `{false && …}` で包んでも通る。
// ここは偽の React で画面を本当に動かし、出ている行を読む（掟10）。偽の main は tests/ops-hanamiiVercel-harness.ts の
// 本物の記録・鍵の上に作ってある。

vi.mock('react', async () => (await import('./ops-hanamiiVercel-harness')).reactModule)
vi.mock('react/jsx-runtime', async () => (await import('./ops-hanamiiVercel-harness')).jsxRuntimeModule)
vi.mock('react/jsx-dev-runtime', async () => (await import('./ops-hanamiiVercel-harness')).jsxDevRuntimeModule)
vi.mock('../src/renderer/components/SecurityCheckSection', () => ({ default: () => null }))
vi.mock('../src/renderer/components/UnusedFilesSection', () => ({ default: () => null }))
vi.mock('../src/renderer/components/AccessKeySection', () => ({ default: () => null }))
vi.mock('../src/renderer/components/CredentialsModal', () => ({
  getHanamiiToken: async () => 'test-only-placeholder-token',
  getHanamiiTokenById: async () => 'test-only-placeholder-token',
  listHanamiiTokenEntries: async () => ({ tokens: [{ id: 't1', label: 'テスト用' }], activeId: 't1' }),
  getVercelToken: async () => 'test-only-placeholder-token',
  getVercelTokenById: async () => 'test-only-placeholder-token',
  getVercelTeamId: async () => null,
  getVercelTeamIdById: async () => null,
  listVercelTokenEntries: async () => ({ tokens: [{ id: 't1', label: 'テスト用' }], activeId: 't1' }),
}))

import HanamiiPanel from '../src/renderer/components/HanamiiPanel'
import VercelPanel from '../src/renderer/components/VercelPanel'
import { otherTargetPriceNote } from '../src/shared/cloudCost'
import { getTargetProfile } from '../src/renderer/targetProfiles'
import {
  makeWorld, installWindow, resetMain, mount, settle,
  type World, type Mounted,
} from './ops-hanamiiVercel-harness'

const onUnhandled = () => {}
process.on('unhandledRejection', onUnhandled)
afterAll(() => { process.off('unhandledRejection', onUnhandled) })

const DIR = '/tmp/koto-ops-test/projPrice'

let world: World
let live: Mounted[] = []
beforeEach(() => {
  resetMain()
  world = makeWorld(DIR)
  installWindow(world)
  live = []
})
afterEach(() => {
  for (const m of live) m.unmount()
  live = []
  resetMain()
})

const open = (Panel: unknown): Mounted => {
  const m = mount(Panel as any, { apiKey: 'k', projectDir: DIR, onOpenCredentials: () => {} })
  live.push(m)
  return m
}

describe.each([
  ['hanamii', 'HANAMII', HanamiiPanel],
  ['vercel', 'Vercel', VercelPanel],
] as const)('%s の画面の冒頭の料金の案内', (target, serviceName, Panel) => {
  const note = otherTargetPriceNote(target)

  it(`★★★ 画面を開くと、「料金は ${serviceName} の公式サイトでご確認ください。」の行が出る（金額は言わない）`, async () => {
    const m = open(Panel)
    await settle()
    expect(m.lines()).toContain(note)
    expect(m.count(note)).toBe(1)
    expect(note).toBe(`料金は ${serviceName} の公式サイトでご確認ください。`)
    expect(note).not.toMatch(/\d+\s?円|月額|税込/)
  })

  it('料金の行は、冒頭の説明の次・公式サイトのリンクの前に出る（押すと開くパネルに同じ文とリンクが並ぶ）', async () => {
    const m = open(Panel)
    await settle()
    const lines = m.lines()
    const at = lines.indexOf(note)
    const link = lines.findIndex(l => l.includes('公式サイトを見る'))
    expect(at).toBeGreaterThan(0)
    expect(link).toBe(at + 1)
    expect(getTargetProfile(target).serviceUrl).toBeTruthy()
  })

  it('公開済みの記録があっても、料金の行は出たまま', async () => {
    world.meta.publish.targets = { [target]: { publishedAt: '2026-09-29T00:00:00.000Z', url: 'https://old.example.test' } }
    const m = open(Panel)
    await settle()
    expect(m.lines()).toContain(note)
  })
})
