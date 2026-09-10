import { describe, it, expect } from 'vitest'
import { collectAppRunApps, collectDedicatedClusters, type AppRunInventoryClient, type ListClustersFn } from '../src/main/cloud/inventoryCollect'
import type { RequestResult } from '../src/main/cloud/client'

// roadmap #31 検分の修理: GET /applications（一覧）には min_scale が無い（原本
// apprun-shared-api.json v1.5.0 で確認済み）。min_scale は GET /applications/{id}（詳細）
// にしか無いため、収集そのものを electron 非依存の純関数へ切り出し、偽 client で確かめる。
//
// 併せて roadmap 検分（2026-09-10）で見つかった「専有型のクラスタ（常時課金）が棚卸しに
// 一切出ない」穴の修理（collectDedicatedClusters）も、同じ形の純関数として置く。

function ok(data: unknown): RequestResult {
  return { dryRun: false, ok: true, status: 200, data }
}
function fail(status: number, data: unknown = {}): RequestResult {
  return { dryRun: false, ok: false, status, data }
}

describe('collectAppRunApps: 一覧に無い min_scale を、詳細（getApp）から読む', () => {
  it('★ 一覧は原本どおり min_scale を持たない。詳細の min_scale:1 が scaleMin に乗る', async () => {
    const calls: string[] = []
    const client: AppRunInventoryClient = {
      async listApps() {
        calls.push('listApps')
        // 原本どおり: 一覧の各行は id/name/status/public_url/created_at だけ
        // （掟1: min_scale を偽データの一覧側に入れない）。
        return ok({
          data: [{ id: 'app-1', name: 'my-app', status: 'healthy', public_url: 'https://x.example', created_at: '2026-01-01T00:00:00Z' }],
        })
      },
      async getApp(id: string) {
        calls.push(`getApp:${id}`)
        return ok({ id, min_scale: 1 })
      },
    }
    const r = await collectAppRunApps(client)
    expect(r.failed).toBe(false)
    expect(r.actual).toEqual([{ kind: 'apprun-app', id: 'app-1', name: 'my-app', scaleMin: 1 }])
    expect(calls).toContain('listApps')
    expect(calls).toContain('getApp:app-1')
  })

  it('★ 詳細の取得が失敗（!ok）した行は scaleMin: null（0 と決めつけない）', async () => {
    const client: AppRunInventoryClient = {
      async listApps() { return ok({ data: [{ id: 'app-1', name: 'my-app' }] }) },
      async getApp() { return fail(500, {}) },
    }
    const r = await collectAppRunApps(client)
    expect(r.actual).toEqual([{ kind: 'apprun-app', id: 'app-1', name: 'my-app', scaleMin: null }])
    expect(r.failed).toBe(false) // 一覧自体は読めているので、全体を諦めない
  })

  it('詳細の取得が例外を投げても、その行は scaleMin: null のまま積む（他のアプリを巻き添えにしない）', async () => {
    const client: AppRunInventoryClient = {
      async listApps() { return ok({ data: [{ id: 'app-1', name: 'my-app' }] }) },
      async getApp() { throw new Error('network error') },
    }
    const r = await collectAppRunApps(client)
    expect(r.actual).toEqual([{ kind: 'apprun-app', id: 'app-1', name: 'my-app', scaleMin: null }])
  })

  it('複数アプリの詳細をそれぞれ読む（一括で1つの値に潰さない）', async () => {
    const client: AppRunInventoryClient = {
      async listApps() { return ok({ data: [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }] }) },
      async getApp(id: string) { return ok({ id, min_scale: id === 'a' ? 1 : 0 }) },
    }
    const r = await collectAppRunApps(client)
    expect(r.actual.find(x => x.id === 'a')?.scaleMin).toBe(1)
    expect(r.actual.find(x => x.id === 'b')?.scaleMin).toBe(0)
  })

  it('★ 一覧の取得自体が失敗 → failed:true・actual は空（黙って0件にしない）', async () => {
    const client: AppRunInventoryClient = {
      async listApps() { return fail(500, {}) },
      async getApp() { throw new Error('unreachable') },
    }
    const r = await collectAppRunApps(client)
    expect(r).toEqual({ actual: [], failed: true })
  })

  it('id の無い行は積まない（推測でIDを作らない）', async () => {
    const client: AppRunInventoryClient = {
      async listApps() { return ok({ data: [{ name: 'no-id' }] }) },
      async getApp() { throw new Error('unreachable（呼ばれないはず）') },
    }
    const r = await collectAppRunApps(client)
    expect(r.actual).toEqual([])
  })
})

describe('collectDedicatedClusters: 専有型のクラスタを棚卸しする（collectAppRunApps と同じ純関数の形）', () => {
  it('★ 原本の形（{ clusters: [{ clusterID, created, name }] }）を読む', async () => {
    const listClusters: ListClustersFn = async () => ({
      ok: true,
      data: { clusters: [{ clusterID: 'cl-1', created: 1700000000, name: 'my-cluster' }] },
    })
    const r = await collectDedicatedClusters(listClusters)
    expect(r).toEqual({ actual: [{ kind: 'dedicated-cluster', id: 'cl-1', name: 'my-cluster' }], failed: false })
  })

  it('name が無ければ id をそのまま名前として使う', async () => {
    const listClusters: ListClustersFn = async () => ({ ok: true, data: { clusters: [{ clusterID: 'cl-1' }] } })
    const r = await collectDedicatedClusters(listClusters)
    expect(r.actual[0]).toEqual({ kind: 'dedicated-cluster', id: 'cl-1', name: 'cl-1' })
  })

  it('複数件を積む', async () => {
    const listClusters: ListClustersFn = async () => ({
      ok: true, data: { clusters: [{ clusterID: 'cl-1', name: 'a' }, { clusterID: 'cl-2', name: 'b' }] },
    })
    const r = await collectDedicatedClusters(listClusters)
    expect(r.actual.map(a => a.id)).toEqual(['cl-1', 'cl-2'])
  })

  it('★ 失敗（ok:false） → failed:true・actual は空（黙って0件にしない）', async () => {
    const listClusters: ListClustersFn = async () => ({ ok: false, message: 'boom' })
    const r = await collectDedicatedClusters(listClusters)
    expect(r).toEqual({ actual: [], failed: true })
  })

  it('clusters が配列でない（形が違う）→ failed:true（未対応と決めつけず、引けなかった扱いにする）', async () => {
    const listClusters: ListClustersFn = async () => ({ ok: true, data: {} })
    const r = await collectDedicatedClusters(listClusters)
    expect(r).toEqual({ actual: [], failed: true })
  })

  it('clusterID の無い行は積まない（推測でIDを作らない）', async () => {
    const listClusters: ListClustersFn = async () => ({ ok: true, data: { clusters: [{ name: 'no-id' }] } })
    const r = await collectDedicatedClusters(listClusters)
    expect(r.actual).toEqual([])
  })
})
