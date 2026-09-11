import { describe, it, expect } from 'vitest'
import { applyPlan, type CloudClientLike } from '../src/main/cloud/apply'
import { defaultSpec } from '../src/main/cloud/spec'
import { emptyState } from '../src/main/cloud/state'
import type { Plan } from '../src/main/cloud/planner'

// 委譲仕様: 再公開のときの「起動のしかた（min_scale）」の食い違いを、黙って上書きせず聞く
// （Ryosuke さん決定・案②・2026-09-10）。applyPlan の update アクションを、偽 client に
// 実際に流して確かめる（掟10:「呼ばれた要求の一覧」を見る。文字列 grep だけにしない）。

const updatePlan: Plan = {
  actions: [{ type: 'update', kind: 'apprun-app', name: 'myapp', stateful: false, description: 'アプリを再デプロイ' } as any],
  hasDestructive: false,
  hasStatefulDelete: false,
}

/** min:0（既定）の image ソース spec。呼び出しごとに独立させる（複製しない・掟10）。 */
function imageSpec(min: number) {
  const s = defaultSpec({ name: 'myapp', hasDockerfile: false })
  s.service.source = { type: 'image', ref: 'example.jp/myapp:latest' } as any
  s.service.scale = { min, max: Math.max(min, 1) }
  return s
}

function stateWithApp() {
  const state = emptyState('myapp', 'sakura-apprun')
  state.resources.push({ kind: 'apprun-app', id: 'app-1', stateful: false, key: 'apprun-app:myapp' })
  return state
}

/** 呼ばれた要求を記録する偽 client。getApp は actual を返す（null なら「確認できない」を再現）。 */
function fakeClient(actual: number | null, opts: { getAppFails?: boolean } = {}) {
  const calls = { getApp: [] as string[], patchApp: [] as { id: string; body: any }[] }
  const client: CloudClientLike = {
    dryRun: false,
    async ensureUser() { return { ok: true, dryRun: false } },
    async listApps() { return { ok: true, dryRun: false, data: { data: [] } } },
    async getApp(id: string) {
      calls.getApp.push(id)
      if (opts.getAppFails) throw new Error('network error')
      if (actual === null) return { ok: false, dryRun: false, status: 500, data: null }
      return { ok: true, dryRun: false, data: { min_scale: actual } }
    },
    async createApp() { return { ok: true, dryRun: false } },
    async patchApp(id: string, body: unknown) {
      calls.patchApp.push({ id, body })
      return { ok: true, dryRun: false }
    },
    async deleteApp() { return { ok: true, dryRun: false } },
  }
  return { client, calls }
}

describe('applyPlan: 起動のしかたが食い違ったら、黙って上書きせず止めて聞く', () => {
  it('(a) 実物1・記録0・decision無し → patchApp は一度も呼ばれない・needsScaleDecision が {recorded:0, actual:1}', async () => {
    const { client, calls } = fakeClient(1)
    const r = await applyPlan({ plan: updatePlan, spec: imageSpec(0), state: stateWithApp(), client, confirmed: true })
    expect(r.ok).toBe(false)
    expect(calls.patchApp).toEqual([])
    expect(r.needsScaleDecision).toEqual({ appId: 'app-1', recorded: 0, actual: 1 })
  })

  it("(b) decision:'koto' → patchApp の body の min_scale が 0（Koto の設定を通す）", async () => {
    const { client, calls } = fakeClient(1)
    const r = await applyPlan({ plan: updatePlan, spec: imageSpec(0), state: stateWithApp(), client, confirmed: true, scaleDecision: 'koto' })
    expect(r.ok).toBe(true)
    expect(calls.patchApp).toHaveLength(1)
    expect((calls.patchApp[0].body as any).min_scale).toBe(0)
    expect(r.adoptedScaleMin).toBeUndefined()
  })

  it("(c) decision:'sakura' → body の min_scale が 1・adoptedScaleMin === 1（さくら側の実物を取り込む）", async () => {
    const { client, calls } = fakeClient(1)
    const r = await applyPlan({ plan: updatePlan, spec: imageSpec(0), state: stateWithApp(), client, confirmed: true, scaleDecision: 'sakura' })
    expect(r.ok).toBe(true)
    expect(calls.patchApp).toHaveLength(1)
    expect((calls.patchApp[0].body as any).min_scale).toBe(1)
    expect(r.adoptedScaleMin).toBe(1)
  })

  it('(d) 実物0・記録0 → PATCH が普通に飛び、needsScaleDecision 無し（一致・普段どおり）', async () => {
    const { client, calls } = fakeClient(0)
    const r = await applyPlan({ plan: updatePlan, spec: imageSpec(0), state: stateWithApp(), client, confirmed: true })
    expect(r.ok).toBe(true)
    expect(calls.patchApp).toHaveLength(1)
    expect((calls.patchApp[0].body as any).min_scale).toBe(0)
    expect(r.needsScaleDecision).toBeUndefined()
    // 一致しているときは黙る（ℹ️ の執行記録を積まない）
    expect(r.executed.some(x => x.includes('ℹ️'))).toBe(false)
  })

  it('(e) getApp が失敗 → PATCH は Koto の値で飛び、executed に「確認できませんでした」の行がある', async () => {
    const { client, calls } = fakeClient(null, { getAppFails: true })
    const r = await applyPlan({ plan: updatePlan, spec: imageSpec(0), state: stateWithApp(), client, confirmed: true })
    expect(r.ok).toBe(true)
    expect(calls.patchApp).toHaveLength(1)
    expect((calls.patchApp[0].body as any).min_scale).toBe(0)
    expect(r.executed.some(x => x.includes('確認できませんでした'))).toBe(true)
  })

  it('食い違い・decision 無しのとき、getApp は呼ばれるが patchApp は一切呼ばれない（fetch はするが PATCH はしない）', async () => {
    const { client, calls } = fakeClient(5)
    const r = await applyPlan({ plan: updatePlan, spec: imageSpec(2), state: stateWithApp(), client, confirmed: true })
    expect(calls.getApp).toEqual(['app-1'])
    expect(calls.patchApp).toEqual([])
    expect(r.needsScaleDecision).toEqual({ appId: 'app-1', recorded: 2, actual: 5 })
  })
})
