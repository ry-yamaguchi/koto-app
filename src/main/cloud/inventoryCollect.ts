// inventoryCollect.ts — 棚卸し（cloud:inventory）の収集部を、electron 非依存の純関数として
// 切り出す（掟10: main/ipc/cloud.ts に IO と判断を混ぜない）。
//
// ── なぜ切り出したか（1. AppRunアプリの min_scale・roadmap #31 検分で修理）────────────
// 原本 apprun-shared-api.json v1.5.0 で確認済み: **GET /applications（一覧）の各行は
// id/name/status/public_url/created_at だけで min_scale は無い。** min_scale は
// GET /applications/{id}（詳細。`client.getApp(id)` が既にある）にだけある。
// 旧実装は一覧の `a?.min_scale` を読んでいたため常に null（不明）になり、
// roadmap #31 の「常時動く」表示が実物で一度も効かなかった。
// ここで一覧から id を取り、各 id を getApp で引いて min_scale を読む形に直す。
//
// ── 2. 専有型のクラスタ（常時課金・2026-09-10 レビューの修理）───────────────────────
// `cloud:inventory` は listApps／listContainerRegistries／listBuckets の3種しか引いて
// おらず、**専有型のクラスタ（常時課金）が棚卸しに一切出なかった**（月2万円超が
// 「見つかりませんでした」になる穴）。GET /clusters（`apprunDedicated.ts` の
// `listClusters`。原本の形は `{ clusters: [{ clusterID, created, name }] }`）を読むだけ
// で使い、金額は不明のまま（0円と決めつけない）棚卸しの行として積む。
//
// どちらも electron に依存しないので、偽 client／偽 listClusters を渡すだけで
// 確かめられる（tests/inventoryCollect.test.ts）。

import type { RequestResult } from './client'
import type { ApprunDedicatedResult } from './apprunDedicated'
import { readClusters } from '../../shared/apprunDedicatedShapes'
import type { ActualResource } from '../../shared/inventory'

/** 収集の結果（純関数の戻り値）。失敗したかどうかは呼び出し側が `failed` 配列へ積む材料にする。 */
export type CollectResult = { actual: ActualResource[]; failed: boolean }

/** collectAppRunApps が必要とするクライアントの最小の形（実体は SakuraCloudClient）。 */
export type AppRunInventoryClient = {
  listApps(): Promise<RequestResult>
  getApp(id: string): Promise<RequestResult>
}

/**
 * 公開したアプリを棚卸しする。
 *
 * 一覧（`listApps`）で id を取り、各 id を `getApp`（詳細）で引いて、
 * `min_scale` が数で返ってくればそれを、取れなければ null を `scaleMin` にする
 * （**0 と決めつけない**・roadmap #31 の教訓）。詳細の取得は `Promise.all` で並行に行う
 * （上限は設けない）。個別の詳細取得が失敗しても、そのアプリの行自体は
 * `scaleMin: null` として積む（他のアプリの棚卸しまで巻き添えにしない）。
 */
export async function collectAppRunApps(client: AppRunInventoryClient): Promise<CollectResult> {
  const list = await client.listApps()
  if (!(list.dryRun === false && list.ok)) return { actual: [], failed: true }
  const rows = Array.isArray((list.data as any)?.data) ? ((list.data as any).data as any[]) : []

  const actual = await Promise.all(rows.map(async (a): Promise<ActualResource | null> => {
    const id = String(a?.id ?? '')
    if (!id) return null
    const name = String(a?.name ?? id)
    let scaleMin: number | null = null
    try {
      const detail = await client.getApp(id)
      if (detail.dryRun === false && detail.ok) {
        const min = (detail.data as any)?.min_scale
        scaleMin = typeof min === 'number' ? min : null
      }
    } catch {
      // 個別の詳細取得の失敗は、このアプリの scaleMin を null（不明）のままにするだけ
      // （0 と決めつけない。他のアプリの棚卸しは続ける）。
    }
    return { kind: 'apprun-app', id, name, scaleMin }
  }))

  return { actual: actual.filter((x): x is ActualResource => x !== null), failed: false }
}

/** collectDedicatedClusters が必要とする listClusters の形（実体は apprunDedicated.ts の listClusters を部分適用したもの）。 */
export type ListClustersFn = () => Promise<ApprunDedicatedResult>

/**
 * 専有型のクラスタを棚卸しする（常時課金）。
 *
 * 原本の形（GET /clusters?maxItems=20）: `{ clusters: [{ clusterID, created, name }] }`。
 * 金額は不明のまま返す（呼び出し側・costNote が「常時課金（金額はプラン次第）」と表示する。
 * 0円と決めつけない）。
 */
export async function collectDedicatedClusters(listClusters: ListClustersFn): Promise<CollectResult> {
  const r = await listClusters()
  if (!r.ok) return { actual: [], failed: true }
  // 応答の形は shared/apprunDedicatedShapes.ts が唯一の読み手（掟10・5-8 の事故の再発防止）。
  // `clusters` 配列そのものが無い（形が違う）ときは「成功・0件」に倒さず失敗にする。
  if (!Array.isArray((r.data as any)?.clusters)) return { actual: [], failed: true }

  // 棚卸しは「課金される実体を漏らさない」のが目的なので、name が無い行でも clusterID があれば
  // 積む（名前は id で代用）。名前で探す createClusterFlow 側（readClusterRows）とは要件が違う。
  const actual: ActualResource[] = []
  for (const c of readClusters(r.data) as any[]) {
    const id = typeof c?.clusterID === 'string' ? c.clusterID : ''
    if (!id) continue
    actual.push({ kind: 'dedicated-cluster', id, name: typeof c?.name === 'string' && c.name ? c.name : id })
  }
  return { actual, failed: false }
}
