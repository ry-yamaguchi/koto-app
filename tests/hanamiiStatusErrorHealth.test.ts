import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 【公開】の状態欄 ERROR の説明は、公開した版の記録（publish.hanamii.healthCheck）で決める（2026-11-11）──
// フォームのチェック（編集中の値）で決めると、失敗のあとにチェックを入れ替えるだけで、同じ失敗の説明が変わる。

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
}))

import HanamiiPanel from '../src/renderer/components/HanamiiPanel'
import { HEALTH_CHECK_ALSO_SENTENCE } from '../src/shared/hanamiiErrorCode'
import { makeWorld, installWindow, resetMain, mount, settle, type World, type Mounted } from './ops-hanamiiVercel-harness'

const DIR = '/tmp/koto-ops-test/projHc'
let world: World
let live: Mounted[] = []
beforeEach(() => { resetMain(); world = makeWorld(DIR); installWindow(world); live = [] })
afterEach(() => { for (const m of live) m.unmount(); live = []; resetMain() })

async function openFailed(recordedEnabled: boolean): Promise<Mounted> {
  world.meta.publish.hanamii.projectId = 'prj_test1'
  world.meta.publish.hanamii.healthCheck = { enabled: recordedEnabled, path: '/health' }
  world.statusReply = { ok: true, url: null, readyState: 'ERROR', errorCode: 'deploy_error', runtime: null }
  const m = mount(HanamiiPanel as any, { apiKey: 'k', projectDir: DIR, onOpenCredentials: () => {} })
  live.push(m)
  await settle()
  return m
}

describe('★★★ 状態欄の deploy_error: 一文は「公開した版の記録」で決まり、フォームのチェックには左右されない', () => {
  it('記録が「有効」なら一文が出る。フォームのチェックを外しても消えない', async () => {
    const m = await openFailed(true)
    expect(m.count(HEALTH_CHECK_ALSO_SENTENCE)).toBe(1)
    expect(m.setCheckbox('ヘルスチェックを有効にする', false)).toBe(true)
    await settle()
    expect(m.count(HEALTH_CHECK_ALSO_SENTENCE), 'チェックを外したら説明が変わった').toBe(1)
    m.unmount()
  })
  it('記録が「無効」なら一文は出ない。フォームのチェックを入れても出ない', async () => {
    const m = await openFailed(false)
    expect(m.has(HEALTH_CHECK_ALSO_SENTENCE)).toBe(false)
    expect(m.setCheckbox('ヘルスチェックを有効にする', true)).toBe(true)
    await settle()
    expect(m.has(HEALTH_CHECK_ALSO_SENTENCE), 'チェックを入れたら説明が変わった').toBe(false)
    m.unmount()
  })
  it('公開し直して記録が変わったら、説明もその記録に従う（無効→有効にして公開）', async () => {
    const m = await openFailed(false)
    expect(m.has(HEALTH_CHECK_ALSO_SENTENCE)).toBe(false)
    expect(m.setCheckbox('ヘルスチェックを有効にする', true)).toBe(true)
    await settle()
    expect(m.has(HEALTH_CHECK_ALSO_SENTENCE), '公開する前は記録のまま').toBe(false)
    world.publishReply = { ok: true, projectId: 'prj_test1', deploymentId: 'dpl_x', deployState: 'error', readyState: 'ERROR', errorCode: 'deploy_error' }
    m.button('🚀 公開する')!.click()
    await settle()
    const sent = (world.calls.hanamiiPublish.at(-1) as any).healthCheck
    expect(sent.enabled, '送った設定').toBe(true)
    expect(m.count(HEALTH_CHECK_ALSO_SENTENCE), '送った設定が記録になり、説明がそれに従う').toBe(1)
    m.unmount()
  })
  it('★ 状態欄は記録の値（recordedHcEnabled）を渡す（フォームの hcEnabled を渡さない）', () => {
    const panel = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/components/HanamiiPanel.tsx'), 'utf-8')
    expect(panel).toContain('describeErrorCode(status.errorCode, { healthCheckEnabled: recordedHcEnabled })')
    expect(panel).not.toContain('{ healthCheckEnabled: hcEnabled }')
  })
})
