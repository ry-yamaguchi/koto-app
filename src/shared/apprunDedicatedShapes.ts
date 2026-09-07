// apprunDedicatedShapes.ts — さくらのAppRun 専有型APIの応答の形を読む、唯一の場所（掟10）。
//
// ── なぜこのモジュールが要るか ──────────────────────────────────────────
// 2026-09-07、段階①の画面（AppRunDedicatedPanel.tsx）と段階②の下請け
// （apprunDedicatedApply.ts）が、応答の形を**推測**していた（「よくあるキーを順に試す」）。
// 実物は原本（OpenAPI v1.4.0）どおりの決まった形なのに、推測したキーがどれも当たらず、
// 実 API では制限もプラン一覧も「取得できませんでした」になり、上限チェックも黙って
// 素通りし、作成応答からIDを取り出せずに「資源はできたが記録されない」という、
// 常時課金サービスとして最悪の事故が起きるところだった（v0.6.8 で配布済み・
// docs/apprun-dedicated-plan.md 5-8 参照）。
//
// **方針（事故の再発を防ぐための決まり）**:
//   形が違えば null / 空配列を返す。呼び出し側が「取得できませんでした」と正直に出す。
//   **別のキーを当てにいく後方互換の推測を足さない。** 推測こそが今回の事故の原因だから。
//   原本の形が変わったときは、このファイルを直す（原本を読み直してから・掟1）。
//
// electron 非依存・DOM非依存の純関数のみ（renderer からも import されるため node の
// path/fs は禁止。appChatDirs.ts と同じ理由。tests/appChatDirs.test.ts が src/shared 全体に
// 対してこれを固定している）。

// ── GET /limits ──────────────────────────────────────────────────────
// 成功時: { "limit": { "clusterCount": 3, "autoScalingGroupCount": 6, … } } ← 入れ子。
// 呼び出し側（AppRunDedicatedPanel.tsx の LIMIT_FIELDS）が使う項目名をそのまま key として渡す。
export function readLimits(data: unknown): Record<string, number | null> {
  const out: Record<string, number | null> = {}
  const limit = (data as any)?.limit
  if (!limit || typeof limit !== 'object' || Array.isArray(limit)) return out
  for (const [k, v] of Object.entries(limit as Record<string, unknown>)) {
    out[k] = typeof v === 'number' ? v : null
  }
  return out
}

// ── プラン一覧の行の形（呼び出し側と共通） ───────────────────────────────
export type ApprunDedicatedPlanRow = { name: string | null; nodeCount: number | null; path: string | null }

function toPlanRow(item: unknown): ApprunDedicatedPlanRow {
  const d = item as any
  return {
    name: typeof d?.name === 'string' ? d.name : null,
    nodeCount: typeof d?.nodeCount === 'number' ? d.nodeCount : null,
    path: typeof d?.path === 'string' ? d.path : null,
  }
}

// ── GET /service_classes/worker ──────────────────────────────────────
// 成功時: { "workerServiceClasses": [ { "name", "path" } ] }
export function readWorkerClasses(data: unknown): ApprunDedicatedPlanRow[] {
  const list = (data as any)?.workerServiceClasses
  if (!Array.isArray(list)) return []
  return list.map(toPlanRow)
}

// ── GET /service_classes/lb ──────────────────────────────────────────
// 成功時: { "lbServiceClasses": [ { "name", "nodeCount", "path" } ] }
export function readLbClasses(data: unknown): ApprunDedicatedPlanRow[] {
  const list = (data as any)?.lbServiceClasses
  if (!Array.isArray(list)) return []
  return list.map(toPlanRow)
}

// ── GET /clusters ────────────────────────────────────────────────────
// 成功時: { "clusters": [ … ] }
export function readClusters(data: unknown): unknown[] {
  const list = (data as any)?.clusters
  return Array.isArray(list) ? list : []
}

// ── 作成応答からのID取り出し ──────────────────────────────────────────
// POST /clusters               → { "cluster": { "clusterID": "…" } }
// POST …/asg                   → { "autoScalingGroup": { "autoScalingGroupID": "…" } }
// POST …/load_balancers        → { "loadBalancer": { "loadBalancerID": "…" } }
// **形が違えば null。他のキー（id/ID/nested.id 等）を当てにいかない。**
export function readClusterId(data: unknown): string | null {
  const v = (data as any)?.cluster?.clusterID
  return typeof v === 'string' ? v : null
}
export function readAsgId(data: unknown): string | null {
  const v = (data as any)?.autoScalingGroup?.autoScalingGroupID
  return typeof v === 'string' ? v : null
}
export function readLoadBalancerId(data: unknown): string | null {
  const v = (data as any)?.loadBalancer?.loadBalancerID
  return typeof v === 'string' ? v : null
}

// ── GET /zone（さくらのクラウド API v1.1「設備関連API」・roadmap #28） ──────────────
// 成功時の実物の形（2026-09-07 実測。src/main/cloud/zones.ts が呼ぶ）:
//   { "From":0, "Count":6, "Total":6,
//     "Zones": [ { "Index":0, "ID":21001, "DisplayOrder":20021001, "Name":"tk1a",
//       "Description":"東京第1ゾーン", "IsDummy":false, "Region": {...} }, … ] }
// VNCProxy / FTPServer / Settings / CreatedAt 等、表に無い他のキーは使わない（5-8 と同じ方針）。
// ただし **実測できたのは Total=6 件中、先頭3件（tk1a/tk1b/is1a）だけ**（旧 probe-zones.mjs が
// 生JSONを4000字で切っていたため。docs/apprun-dedicated-plan.md 5-9）。残り3件の IsDummy が
// 実際どんな形で返るかは**未実測**。だからこそ「boolean でなければ分からない」という
// 下の読み方が要る（2026-09-08 検分で発見・修理。それまでは boolean でなければ false＝本物に
// 倒しており、応答の形が変われば Sandbox 等の見せかけのゾーンが選択式の既定になり得た）。
export type ZoneRow = { name: string; description: string | null; isDummy: boolean | null; displayOrder: number | null }

/**
 * data.Zones から読む。**配列でなければ空配列**（推測で他のキー（小文字の zones 等）を探さない）。
 * 各行は Name（string）が無ければ捨てる。Description/DisplayOrder は型が違えば null にする。
 * **IsDummy は boolean のときだけその値。それ以外（欠落・文字列・数値など）は `null`＝分からない**
 * にする（「分からないものを本物（false）に倒さない」。並べ替え・フィルタはしない。
 * 「本物だと分かっているものだけ選ばせる」判断は使う側＝selectableZones が行う）。
 */
export function readZones(data: unknown): ZoneRow[] {
  const list = (data as any)?.Zones
  if (!Array.isArray(list)) return []
  const out: ZoneRow[] = []
  for (const item of list) {
    const d = item as any
    if (typeof d?.Name !== 'string') continue
    out.push({
      name: d.Name,
      description: typeof d?.Description === 'string' ? d.Description : null,
      isDummy: typeof d?.IsDummy === 'boolean' ? d.IsDummy : null,
      displayOrder: typeof d?.DisplayOrder === 'number' ? d.DisplayOrder : null,
    })
  }
  return out
}

// ── 失敗時の応答: { "status": …, "title": … } ─────────────────────────
// title があれば返す（呼び出し側がエラーメッセージに添える）。無ければ null。
// **生の応答本文の表示はそのまま残す**（掟10「確かめられないときは生の応答を載せる」）。
// これは「添える」ためのものであって、生本文の代わりではない。
export function readApiErrorTitle(data: unknown): string | null {
  const v = (data as any)?.title
  return typeof v === 'string' ? v : null
}
