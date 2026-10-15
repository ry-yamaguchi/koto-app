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
// 成功時: { "clusters": [ { "clusterID": string, "created": integer, "name": string } ], "nextCursor": … }
export function readClusters(data: unknown): unknown[] {
  const list = (data as any)?.clusters
  return Array.isArray(list) ? list : []
}

/**
 * GET /clusters の行を { clusterID, name } に絞って読む（バッチ1・D: 作成応答が取れなかったとき
 * 名前で探すのに使う）。**readClusters と同じ配列（data.clusters）を見る**——別のキーを当てない。
 * clusterID/name のどちらかが無い行は捨てる（形が違えば黙って拾わない）。
 */
export function readClusterRows(data: unknown): { clusterID: string; name: string }[] {
  const out: { clusterID: string; name: string }[] = []
  for (const item of readClusters(data)) {
    const d = item as any
    if (typeof d?.clusterID === 'string' && typeof d?.name === 'string') {
      out.push({ clusterID: d.clusterID, name: d.name })
    }
  }
  return out
}

/**
 * クラスタの ID だけを集める（純関数）。**名前が無い行も落とさない。**（C・2026-09-17）
 * 在否の判定（消えたかどうか）に名前は要らない——`readClusterRows` は名前で探す用途
 * （D）のため name が無い行を捨てるが、そのリーダーを在否判定に流用すると、原本が
 * 仕様逸脱で name を欠いた行を返したとき「その行は無かった」ことにされ、実際には
 * 残っているクラスタを「消えた」と誤判定してしまう。clusterID が文字列の行だけを拾う。
 */
export function readClusterIDs(data: unknown): string[] {
  const out: string[] = []
  for (const item of readClusters(data)) {
    const d = item as any
    if (typeof d?.clusterID === 'string') {
      out.push(d.clusterID)
    }
  }
  return out
}

// ── GET /clusters/{id}/asg ───────────────────────────────────────────
// 成功時: { "autoScalingGroups": [ { "autoScalingGroupID", "name", "deleting", "minNodes",
//   "maxNodes", "workerServiceClassPath", "zone", … } ], "nextCursor": … }
/**
 * asgID/name のどちらかが無い行は捨てる。**deleting は boolean のときだけその値、それ以外は
 * null（分からない）**——readZones の IsDummy と同じ方針（分からないものを本物/削除済みに倒さない）。
 */
export function readAsgRows(data: unknown): { asgID: string; name: string; deleting: boolean | null }[] {
  const list = (data as any)?.autoScalingGroups
  if (!Array.isArray(list)) return []
  const out: { asgID: string; name: string; deleting: boolean | null }[] = []
  for (const item of list) {
    const d = item as any
    if (typeof d?.autoScalingGroupID === 'string' && typeof d?.name === 'string') {
      out.push({
        asgID: d.autoScalingGroupID,
        name: d.name,
        deleting: typeof d?.deleting === 'boolean' ? d.deleting : null,
      })
    }
  }
  return out
}

/**
 * ASG の ID だけを集める（純関数）。**名前が無い行も落とさない。**（M-1・2026-09-17）
 * 在否の判定（消えたかどうか）に名前は要らない——`readAsgRows` は表示用に name も持たせる
 * ため name が無い行を捨てるが、そのリーダーを在否判定に流用すると、原本が仕様逸脱で name を
 * 欠いた行を返したとき「その行は無かった」ことにされ、実際には残っている ASG を「消えた」と
 * 誤判定してしまう（readClusterIDs と同じ理由）。autoScalingGroupID が文字列の行だけを拾う。
 */
export function readAsgIDs(data: unknown): string[] {
  const list = (data as any)?.autoScalingGroups
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const item of list) {
    const d = item as any
    if (typeof d?.autoScalingGroupID === 'string') {
      out.push(d.autoScalingGroupID)
    }
  }
  return out
}

/**
 * ASG の一覧を、**ID と deleting だけ**で読む（名前は要らない）。**一覧の形が読めなければ `null`**（空配列とは別の意味）。
 * （2026-10-08 検分・J の再指摘）クラスタの削除を 409 で断られたあと、「ASG の一覧が空か」を見て、空なら反映のずれとして待ち直す。
 * その「空」を `readAsgRows`（name の無い行を捨てる・形が読めなくても `[]`）で見ると、実際には残っている ASG や、一覧の形が
 * 違うだけの応答まで「空＝反映のずれ」と扱い、10分待っても押し直しても同じ行き止まりになる。ここでは:
 *   ・`[]` … 一覧は読めて、ASG が1件も無かった（＝反映のずれとみてよい）
 *   ・`null` … 読めなかった（`autoScalingGroups` が配列でない／要素があるのに autoScalingGroupID を1つも読めない）
 *   ・行 … autoScalingGroupID が文字列の行（name が無くても拾う）。deleting は boolean のときだけその値、それ以外は null（分からない）
 */
export function readAsgIdRows(data: unknown): { asgID: string; deleting: boolean | null }[] | null {
  const list = (data as any)?.autoScalingGroups
  if (!Array.isArray(list)) return null
  const out: { asgID: string; deleting: boolean | null }[] = []
  for (const item of list) {
    const d = item as any
    if (typeof d?.autoScalingGroupID === 'string') {
      out.push({ asgID: d.autoScalingGroupID, deleting: typeof d?.deleting === 'boolean' ? d.deleting : null })
    }
  }
  if (list.length > 0 && out.length === 0) return null
  return out
}

// ── GET /clusters/{id}/asg/{asgId}/load_balancers ───────────────────
// 成功時: { "loadBalancers": [ { "loadBalancerID", "name", "deleting", "created",
//   "serviceClassPath" } ], "nextCursor": … }
/** loadBalancerID/name のどちらかが無い行は捨てる。deleting は boolean のときだけその値、それ以外は null。 */
export function readLoadBalancerRows(data: unknown): { loadBalancerID: string; name: string; deleting: boolean | null }[] {
  const list = (data as any)?.loadBalancers
  if (!Array.isArray(list)) return []
  const out: { loadBalancerID: string; name: string; deleting: boolean | null }[] = []
  for (const item of list) {
    const d = item as any
    if (typeof d?.loadBalancerID === 'string' && typeof d?.name === 'string') {
      out.push({
        loadBalancerID: d.loadBalancerID,
        name: d.name,
        deleting: typeof d?.deleting === 'boolean' ? d.deleting : null,
      })
    }
  }
  return out
}

/**
 * ロードバランサの ID だけを集める（純関数）。**名前が無い行も落とさない。**（M-1・2026-09-17）
 * 在否の判定（消えたかどうか）に名前は要らない——`readLoadBalancerRows` は表示用に name も
 * 持たせるため name が無い行を捨てるが、そのリーダーを在否判定に流用すると、原本が仕様逸脱で
 * name を欠いた行を返したとき「その行は無かった」ことにされ、実際には残っているロードバランサを
 * 「消えた」と誤判定してしまう（readClusterIDs と同じ理由）。loadBalancerID が文字列の行だけを拾う。
 */
export function readLoadBalancerIDs(data: unknown): string[] {
  const list = (data as any)?.loadBalancers
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const item of list) {
    const d = item as any
    if (typeof d?.loadBalancerID === 'string') {
      out.push(d.loadBalancerID)
    }
  }
  return out
}

/**
 * ロードバランサの一覧を、**ID と deleting だけ**で読む（名前は要らない）。**一覧の形が読めなければ `null`**（空配列とは別の意味）。
 * （2026-10-08 検分・J の再指摘）ASG の削除を 409 で断られたあと、「ロードバランサの一覧が空か」を見て、空なら反映のずれとして
 * 待ち直す。その「空」を `readLoadBalancerRows`（name の無い行を捨てる・形が読めなくても `[]`）で見ると、実際には残っている
 * ロードバランサや、一覧の形が違うだけの応答まで「空＝反映のずれ」と扱い、10分待っても押し直しても同じ行き止まりになる
 * （そのロードバランサの ID は記録に戻らず、課金が続く）。ここでは:
 *   ・`[]` … 一覧は読めて、ロードバランサが1件も無かった（＝反映のずれとみてよい）
 *   ・`null` … 読めなかった（`loadBalancers` が配列でない／要素があるのに loadBalancerID を1つも読めない）
 *   ・行 … loadBalancerID が文字列の行（name が無くても拾う）。deleting は boolean のときだけその値、それ以外は null（分からない）
 */
export function readLoadBalancerIdRows(data: unknown): { loadBalancerID: string; deleting: boolean | null }[] | null {
  const list = (data as any)?.loadBalancers
  if (!Array.isArray(list)) return null
  const out: { loadBalancerID: string; deleting: boolean | null }[] = []
  for (const item of list) {
    const d = item as any
    if (typeof d?.loadBalancerID === 'string') {
      out.push({ loadBalancerID: d.loadBalancerID, deleting: typeof d?.deleting === 'boolean' ? d.deleting : null })
    }
  }
  if (list.length > 0 && out.length === 0) return null
  return out
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

// ── GET /clusters/{id}（段階③⑤・D-2b: publishAppFlow の lets-encrypt 段が使う） ──────────
// 原本 v1.4.0 の ReadCluster は `hasLetsEncryptEmail: boolean`（必須）を持つ（メールの値そのものは返さない）。
// 応答: { "cluster": { "clusterID", "name", "created", "hasLetsEncryptEmail", "ports", "servicePrincipalID" } }
// boolean でなければ null（「分からない」を true にも false にも倒さない・掟10）。
/** GET /clusters/{id} の応答から hasLetsEncryptEmail を読む。boolean 以外は null。 */
export function readHasLetsEncryptEmail(data: unknown): boolean | null {
  const v = (data as any)?.cluster?.hasLetsEncryptEmail
  return typeof v === 'boolean' ? v : null
}

// ── A（2026-09-17）: ⑧の公開の流れが、載せる先のクラスタの公開ポートを確かめる ──────────
// 同じ GET /clusters/{id} の応答（cluster.ports）から読む。専有型は useLetsEncrypt:true・
// loadBalancerPort:443 固定（apprunDedicatedApp.ts の buildVersionCreateBody）なので、
// 80/http が無ければ証明書は永久に発行されない。**配列でなければ null**（0件と読み替えない・
// 掟10）——応答の形が違うだけなのか、本当に0件なのかを呼び出し側が区別できるようにする
// （readContainerStates と同じ方針）。要素は port が数値・protocol が文字列のものだけ拾う
// （readAsgRows などと同じ作法。形が違う要素は黙って捨てる。全部落ちれば空配列＝0件）。
export function readClusterPorts(data: unknown): { port: number; protocol: string }[] | null {
  const list = (data as any)?.cluster?.ports
  if (!Array.isArray(list)) return null
  const out: { port: number; protocol: string }[] = []
  for (const item of list) {
    const d = item as any
    if (typeof d?.port === 'number' && typeof d?.protocol === 'string') {
      out.push({ port: d.port, protocol: d.protocol })
    }
  }
  return out
}

// ── GET /zone（さくらのクラウド API v1.1「設備関連API」・roadmap #28） ──────────────
// 成功時の実物の形（2026-09-07 実測。src/main/cloud/zones.ts が呼ぶ）:
//   { "From":0, "Count":6, "Total":6,
//     "Zones": [ { "Index":0, "ID":21001, "DisplayOrder":20021001, "Name":"tk1a",
//       "Description":"東京第1ゾーン", "IsDummy":false, "Region": {...} }, … ] }
// VNCProxy / FTPServer / Settings / CreatedAt 等、表に無い他のキーは使わない（5-8 と同じ方針）。
// 2026-09-08 に6件すべて実測（docs/apprun-dedicated-plan.md 5-9）。tk1v（Sandbox）のみ
// IsDummy:true。boolean 以外を null にするのは将来形が変わったときの安全側
// （2026-09-08 検分で発見・修理。それまでは boolean でなければ false＝本物に倒しており、
// 応答の形が変われば Sandbox 等の見せかけのゾーンが選択式の既定になり得た）。
export type ZoneRow = { name: string; description: string | null; isDummy: boolean | null; displayOrder: number | null }

/**
 * data.Zones から読む。**配列でなければ空配列**（推測で他のキー（小文字の zones 等）を探さない）。
 * 各行は Name（string）が無ければ捨てる。Description/DisplayOrder は型が違えば null にする。
 * **IsDummy は boolean のときだけその値。それ以外（欠落・文字列・数値など）は `null`＝分からない**
 * にする（「分からないものを本物（false）に倒さない」。並べ替え・フィルタはしない。
 * 「本物だと分かっているものだけ選ばせる」判断は使う側＝selectableZones が行う）。
 */
/**
 * data が「GET /zone の成功応答の形」かどうか（O・2026-09-10 レビューの修理・バッチ3）。
 * `Zones` が配列で、かつ `Count`/`Total`（どちらか一方でよい）が数値であることを見る。
 * **200 が返っても、この形でなければ readZones は空配列を返すだけ**——呼び出し側
 * （zonesCache.ts）はそれを「取得できたが0件」と区別できず、無言で自由入力に戻っていた。
 * ここで形そのものを判定できるようにし、呼び出し側が「取得失敗（形が想定と違う）」を
 * 正直に出せるようにする（推測で0件に倒さない・掟1と同じ方針）。
 */
export function isZonesShape(data: unknown): boolean {
  const d = data as any
  if (!d || typeof d !== 'object') return false
  if (!Array.isArray(d.Zones)) return false
  if (typeof d.Count !== 'number' && typeof d.Total !== 'number') return false
  return true
}

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

// ── 一覧応答の続きキー（N・2026-09-10 レビューの修理・バッチ3） ─────────────────────
// 原本（OpenAPI v1.4.0）の一覧応答（GET /clusters・…/asg・…/load_balancers）の続きキーは
// **`nextCursor` だけ**。呼び出し側（AppRunDedicatedPanel.tsx）が `nextCursor ?? cursor ?? next`
// と複数のキーを順に試していた——これは 5-8 の事故（推測キーで応答を読む）とまったく同じ形の
// 危うさなので、他の一元化した読み手と同じくここへ集約する。**`nextCursor` 以外は一切見ない。**
/** data.nextCursor が非空の文字列のときだけそれを返す。それ以外（欠落・空文字・別の型）は null（続きなし扱い）。 */
export function readNextCursor(data: unknown): string | null {
  const v = (data as any)?.nextCursor
  return typeof v === 'string' && v.length > 0 ? v : null
}

// ── D-1（土台）: アプリケーション・バージョン・ノードのアドレス（roadmap #23 ⑤・12-1） ───────
// 原本（OpenAPI v1.4.0）の該当スキーマから決め打つ（推測しない・掟10と同じ方針）。
// docs/apprun-dedicated-plan.md 12-1 の表と、原本 ReadApplication / ApplicationVersionSummary /
// WorkerNodeSummary / LoadBalancerNode の該当箇所で裏を取った（実 API での実測はまだ・未確認）。

// ── GET /applications?clusterID=… ────────────────────────────────────
// 成功時: { "applications": [ ReadApplication… ], "nextCursor": … }
// ReadApplication は { applicationID, name, clusterID, activeVersion, clusterName, desiredCount,
// enoughResources, scalingCooldownSeconds } を持つ（原本）。Koto が使うのは先頭4つだけ。
/**
 * 一覧の各行を { applicationID, name, clusterID, activeVersion } に絞って読む。
 * applicationID/name/clusterID のどれか無い行は捨てる。activeVersion は number のときだけその値、
 * それ以外（欠落・null＝有効バージョン無し・型違い）は null。
 */
export function readApplicationRows(data: unknown): { applicationID: string; name: string; clusterID: string; activeVersion: number | null }[] {
  const list = (data as any)?.applications
  if (!Array.isArray(list)) return []
  const out: { applicationID: string; name: string; clusterID: string; activeVersion: number | null }[] = []
  for (const item of list) {
    const d = item as any
    if (typeof d?.applicationID === 'string' && typeof d?.name === 'string' && typeof d?.clusterID === 'string') {
      out.push({
        applicationID: d.applicationID,
        name: d.name,
        clusterID: d.clusterID,
        activeVersion: typeof d?.activeVersion === 'number' ? d.activeVersion : null,
      })
    }
  }
  return out
}

/**
 * アプリケーションの ID だけを集める（純関数）。**name/clusterID が無い行も落とさない。**
 *（M-1・2026-09-17）在否の判定（消えたかどうか）に名前は要らない——`readApplicationRows` は
 * 表示用に name/clusterID も持たせるためどちらか無い行を捨てるが、そのリーダーを在否判定に
 * 流用すると、原本が仕様逸脱でそれらを欠いた行を返したとき「その行は無かった」ことにされ、
 * 実際には残っているアプリケーションを「消えた」と誤判定してしまう（readClusterIDs と同じ理由）。
 * applicationID が文字列の行だけを拾う。
 */
export function readApplicationIDs(data: unknown): string[] {
  const list = (data as any)?.applications
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const item of list) {
    const d = item as any
    if (typeof d?.applicationID === 'string') {
      out.push(d.applicationID)
    }
  }
  return out
}

// ── POST /applications ───────────────────────────────────────────────
// 成功時: { "application": { "applicationID": "…" } }（原本 CreateApplicationResponse・ApplicationIdentifier）
/** 作成応答から applicationID を読む。形が違えば null（他のキーを当てにいかない）。 */
export function readApplicationId(data: unknown): string | null {
  const v = (data as any)?.application?.applicationID
  return typeof v === 'string' ? v : null
}

// ── GET /applications/{id} ───────────────────────────────────────────
// 成功時: { "application": { applicationID, name, clusterID, activeVersion, desiredCount,
//   enoughResources: { cpu, memory }, clusterName, scalingCooldownSeconds } }（原本 ReadApplicationResponse）
export type ApprunDedicatedApplication = {
  applicationID: string
  name: string
  clusterID: string
  activeVersion: number | null
  desiredCount: number | null
  enoughResources: { cpu: boolean | null; memory: boolean | null }
}

/**
 * GET /applications/{id} の応答を読む。applicationID/name/clusterID のいずれか無ければ**形が無い**
 * として null を返す（一覧の readApplicationRows は行単位で捨てるが、こちらは単一オブジェクトなので
 * 丸ごと null にする——readApplication/readCluster 系の既存の方針と同じ）。
 * activeVersion/desiredCount は number のときだけその値（null は「有効バージョン/デプロイ数なし」の
 * 正常値でもあるため、型違いも含めてどちらも null にまとめる）。enoughResources.cpu/memory は
 * boolean のときだけその値、それ以外は null（原本でも nullable＝「不明」の意味）。
 */
export function readApplication(data: unknown): ApprunDedicatedApplication | null {
  const a = (data as any)?.application
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null
  if (typeof a.applicationID !== 'string' || typeof a.name !== 'string' || typeof a.clusterID !== 'string') return null
  const er = a.enoughResources
  return {
    applicationID: a.applicationID,
    name: a.name,
    clusterID: a.clusterID,
    activeVersion: typeof a.activeVersion === 'number' ? a.activeVersion : null,
    desiredCount: typeof a.desiredCount === 'number' ? a.desiredCount : null,
    enoughResources: {
      cpu: typeof er?.cpu === 'boolean' ? er.cpu : null,
      memory: typeof er?.memory === 'boolean' ? er.memory : null,
    },
  }
}

// ── GET /applications/{id}/containers（D-8・2026-09-16 ／ 読み方を原本に合わせた 2026-10-08・R6-2） ─────
//
// ■ 原本（OpenAPI v1.4.0 の ListApplicationContainersResponse・2026-10-08 に原本そのものを取得して確かめた。掟1）
//   {
//     "nodes": [                                  … WorkerNodeContainerPlacement（nodeID・containersStats・desired の3つが必須）
//       {
//         "nodeID": "<uuid>",
//         "containersStats": null                  … nullable
//                          | { "collectedAtSec": 1721203200,        … ApplicationCurrentContainers（2つとも必須）
//                              "containers": [ { "id", "image", "state", "status", "cpuUsagePercent",
//                                                "applicationID", "applicationVersion" } ] },   … ApplicationCurrentContainer（7つとも必須）
//         "desired": null | { "containers": [ { applicationID, applicationVersion, cpuMillis, memoryMB, image } ] }
//       }
//     ]
//   }
//   state は文字列。原本の説明: 「コンテナのステート（created、running、restarting、removing、paused、exited、dead のうちいずれか）」。
//   このエンドポイントのパラメータは path の applicationID だけ（maxItems などは無い）。
//
// ■ 以前の読み方の誤り
//   最初の実装（2026-09-16）は `containersStats` を**配列**と決めて読んでいた。原本では containersStats は
//   `{ collectedAtSec, containers: [...] }` の**オブジェクト**（か null）なので、本物の応答は常に「読めない（null）」になっていた。
//   その結果、削除前のコンテナの停止待ち（D-10）と手順8のコンテナ表示は、**一度も効いていなかった**。
//   （違っていたのは応答ではなく Koto の読み方。原本の形のままのテストが無かったため気づけなかった。）
//
// ■ ⚠️ 実際の応答は、まだ誰も見ていない（2026-10-08 時点）
//   ここは原本の example／スキーマに合わせただけで、実機の生の応答では確かめていない。null の意味（回収前か、コンテナ無しか）や、
//   停止したコンテナが一覧から消えるのか exited のまま残るのかも、原本には書かれていない。だから:
//   ・読めないものは推測で埋めず null（「0件」に倒さない）
//   ・値は原本のまま返す（日本語へ言い換えない）
//   ・「止まっている」と数える state は、書いてある7つのうち確実な2つ（exited・dead）だけ。それ以外・知らない値は「動いている」側（下の isContainerStopped）
//   実機で一度、生の応答を見たら、この注意を更新すること（tests/apprunDedicatedShapes.test.ts の「原本の example」の形もその時に実測へ差し替える）。
//
//   ■ 実機で生の応答を見るときの確認項目（2026-10-08 検分。原本には書かれていないこと）
//     1. containersStats が null になるのは、どんなときか（収集前か、コンテナが無いときか。複数ノードで1ノードだけ null が続くことがあるか）。
//        いまの読み方は、null のノードからは何も読まず、ほかのノードに読めたコンテナが1件も無ければ全体を null（読めない）にする。
//        使う側（削除前の停止待ち）は null を「分からない → 待たず DELETE へ」と扱う（apprunDedicatedApply.ts の attemptDeleteApplication）。
//     2. **コンテナごとの applicationID で絞っていない**。原本の example にも、このアプリのものとは限らない ID が入っている
//        （containersStats 側が f47ac10b…、desired 側が 9c858901…）。ノード上のほかのアプリのコンテナが一覧に混ざるのか、混ざらないのか。
//        混ざるなら、削除前の停止待ちはそのコンテナが止まらないかぎり時間切れまで待ち、手順8はほかのアプリのコンテナをこのアプリの状態として出す。
//        いまは絞り込みを足さない（ID の書き方が違ったときに「動いているのに 0 件」へ倒れ、まだ動いているアプリの削除に進むため）。
//     3. 停止したコンテナが一覧から消えるのか、exited のまま残るのか（残るなら isContainerStopped の exited・dead の扱いが効く）。
//
// 2026-09-16 実機: 公開の verify が 503（no-backend）になったとき、Koto は「アプリがまだ
// 応答していません。ランタイムログを見てください」としか言えなかった。実際にはコンテナが
// `/app/data` を作れずに1分ごとに再起動を繰り返していた（docs/apprun-dedicated-plan.md 5-13）。
// **いまのコンテナの様子が分かれば、利用者はログを開く前に「動いていない」と気づける。**
/** 読んだコンテナ1件（値は原本のまま）。 */
export type ContainerStateRow = { state: string; status: string }

/**
 * `nodes[].containersStats` を平らにして、各コンテナの `{ state, status }` だけ読む。
 * **値は原本のまま返す。日本語へ言い換えない**（全ての値を実測していないため・掟1）。
 *
 * ── 読める形（どれも `nodes` は配列）──────────────────────────────────────────────
 *   ・原本の形: `containersStats` が `{ collectedAtSec, containers: [...] }`（`containers` が配列であること）
 *   ・古い形: `containersStats` が配列そのもの（最初の実装が想定していた形。読めるなら読む）
 *   ・`containersStats` が null: そのノードは「現在のコンテナ情報が無い」（原本で nullable）。そのノードからは何も読まない。
 *     ただし**他に読めたコンテナが1件も無いとき**は null を返す（「0件」とは言えない——回収前かもしれない。下の ── 戻り値 ── 参照）
 *
 * ── 戻り値は「読めた配列」か `null`（読めなかった＝未確認）────────────────────────
 * **空配列と `null` は別の意味**である:
 *   ・`[]` ＝ **原本の形で読めた結果、コンテナが1件も無かった**（＝1つも動いていない）
 *   ・`null` ＝ **読めなかった**（何台動いているかは分からない）
 *
 * 最初の実装は形が違うときも `[]` を返していた。すると呼び出し側は「0件」として扱い、画面は
 * 「コンテナが1つも動いていません。」と**断定**する。**HTTP が 200 でも、応答の形が原本と
 * 違えば分かることは何も無い**。分からないものを事実として出すのは D-7 で反省した
 * `unknown-read-as-ok` と同じ形なので、**読めなかったときは `null` に倒し、呼び出し側は「取得できなかった」側で扱う**
 * （手順8は `containerStates` を付けない＝画面はコンテナの状態を出さない／削除前の停止待ちは、最初の確認でも待ちの中でも
 * 待たずに DELETE へ進み、400 の待ち直しに任せる・掟10。`readRunningContainerCount` 参照）。
 *
 * 読めない、と判断するのは次のいずれか（推測で埋めない）:
 *   ・`nodes` が配列でない（キーが無い・別のキーだった）
 *   ・`nodes` の要素がオブジェクトでない
 *   ・`containersStats` のキーが無い／配列でも `{ containers: 配列 }` でもない／null でもない
 *   ・コンテナの `state`／`status` が文字列でない
 *   ・読めたコンテナが1件も無く、`containersStats` が null のノードがある（0件とは言い切れない）
 * `nodes: []`・`containers: []` は**形としては読めている**ので `[]`（＝0件）を返す。
 */
export function readContainerStates(data: unknown): ContainerStateRow[] | null {
  const nodes = (data as any)?.nodes
  if (!Array.isArray(nodes)) return null
  const out: ContainerStateRow[] = []
  let nodesWithoutStats = 0
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null
    const stats = (node as any).containersStats
    let list: unknown
    if (stats === null) {
      nodesWithoutStats++
      continue
    } else if (Array.isArray(stats)) {
      list = stats // 古い形
    } else if (stats && typeof stats === 'object' && Array.isArray((stats as any).containers)) {
      list = (stats as any).containers // 原本の形
    } else {
      return null
    }
    for (const c of list as unknown[]) {
      const d = c as any
      if (!d || typeof d !== 'object' || typeof d.state !== 'string' || typeof d.status !== 'string') return null
      out.push({ state: d.state, status: d.status })
    }
  }
  // コンテナ情報の無いノードがあって、他にも読めたコンテナが無い＝「0件」とは言い切れない（回収前かもしれない）
  if (out.length === 0 && nodesWithoutStats > 0) return null
  return out
}

/**
 * 原本が挙げる `state` の7つ（created・running・restarting・removing・paused・exited・dead）のうち、
 * **確実に「止まっている」と言えるもの**。ここに無い値——running・restarting・paused・created・removing と、原本に無い値——は
 * すべて「動いている」側に倒す（止まったと思い込んで、まだ動いているアプリの削除に進まないため・掟10）。
 *   ・exited … 終了している
 *   ・dead   … 動かせない状態で残っている
 *   （Docker のコンテナ状態の名前と同じ。原本の説明は7つの名前を挙げるだけで、意味までは書いていない。）
 * 実機の応答をまだ誰も見ていない（上の注意）ので、増やすなら実測してから。
 */
const STOPPED_CONTAINER_STATES: readonly string[] = ['exited', 'dead']

/** そのコンテナは止まっているか（純関数）。原本の値で exited／dead のときだけ true。知らない値・空文字は false＝動いている側。 */
export function isContainerStopped(state: string): boolean {
  return STOPPED_CONTAINER_STATES.includes(state.trim().toLowerCase())
}

/** 動いている（止まっていると言い切れない）コンテナの数。削除前の「コンテナが止まるのを待つ」はこれが 0 になるまで待つ。 */
export function countRunningContainers(rows: readonly ContainerStateRow[]): number {
  return rows.filter(r => !isContainerStopped(r.state)).length
}

/**
 * 応答（GET /applications/{id}/containers の本文）から**動いているコンテナの数**を読む。**読めなければ `null`**（0 とは別の意味）。
 * `readContainerStates` で読み、読めたときだけ `countRunningContainers` で数える。削除前のコンテナの停止待ちは、最初の確認も待ちの中も
 * この1つを使う（2026-10-08 検分の再指摘。向きが逆だった——最初の確認は「読めない → 待たず DELETE へ」、待ちの中は「読めない →
 * まだ残っている」と別々に判断していた）。使う側は **`null` を「分からない → 待ちを理由に止めない（DELETE へ進み、400 の待ち直しに任せる）」**
 * として扱う。
 */
export function readRunningContainerCount(data: unknown): number | null {
  const rows = readContainerStates(data)
  return rows === null ? null : countRunningContainers(rows)
}

// ── POST /applications/{id}/versions ─────────────────────────────────
// 成功時: { "applicationVersion": { "version": 3 } }（原本 CreateApplicationVersionResponse・ApplicationVersionIdentifier）
/** 作成応答から version（整数）を読む。形が違えば null。 */
export function readVersionNumber(data: unknown): number | null {
  const v = (data as any)?.applicationVersion?.version
  return typeof v === 'number' ? v : null
}

// ── GET /applications/{id}/versions ──────────────────────────────────
// 成功時: { "versions": [ { version, image, activeNodeCount, created } ], "nextCursor": … }
// （原本 ListApplicationVersionsResponse・ApplicationVersionSummary。4つとも必須）
export type ApprunDedicatedVersionRow = { version: number; image: string; activeNodeCount: number; created: number }

/** 一覧の各行を読む。4つの必須キーのどれか型が違う行は捨てる（推測で埋めない）。 */
export function readVersionRows(data: unknown): ApprunDedicatedVersionRow[] {
  const list = (data as any)?.versions
  if (!Array.isArray(list)) return []
  const out: ApprunDedicatedVersionRow[] = []
  for (const item of list) {
    const d = item as any
    if (
      typeof d?.version === 'number' && typeof d?.image === 'string' &&
      typeof d?.activeNodeCount === 'number' && typeof d?.created === 'number'
    ) {
      out.push({ version: d.version, image: d.image, activeNodeCount: d.activeNodeCount, created: d.created })
    }
  }
  return out
}

// ── GET /clusters/{c}/asg/{a}/worker_nodes ───────────────────────────
// 成功時: { "workerNodes": [ { workerNodeID, status, networkInterfaces: [ { interfaceIndex,
//   addresses: [ { address } ] } ], … } ], "nextCursor": … }（原本 ListWorkerNodesResponse・WorkerNodeSummary）
export type ApprunDedicatedWorkerNodeRow = { workerNodeID: string; status: string | null; addresses: string[] }

/**
 * ワーカノードの行を { workerNodeID, status, addresses } に絞って読む
 * （networkInterfaces[].addresses[].address をすべて平らに集めたもの）。
 * workerNodeID が無い行は捨てる。status は string のときだけその値、それ以外は null。
 * networkInterfaces / addresses が配列でなければ、その行の addresses は空配列。
 */
export function readWorkerNodeAddresses(data: unknown): ApprunDedicatedWorkerNodeRow[] {
  const list = (data as any)?.workerNodes
  if (!Array.isArray(list)) return []
  const out: ApprunDedicatedWorkerNodeRow[] = []
  for (const item of list) {
    const d = item as any
    if (typeof d?.workerNodeID !== 'string') continue
    const addresses: string[] = []
    const ifaces = Array.isArray(d?.networkInterfaces) ? d.networkInterfaces : []
    for (const iface of ifaces) {
      const addrs = (iface as any)?.addresses
      if (!Array.isArray(addrs)) continue
      for (const a of addrs) {
        if (typeof (a as any)?.address === 'string') addresses.push((a as any).address)
      }
    }
    out.push({ workerNodeID: d.workerNodeID, status: typeof d?.status === 'string' ? d.status : null, addresses })
  }
  return out
}

// ── GET …/load_balancers/{id}/load_balancer_nodes ────────────────────
// 成功時: { "loadBalancerNodes": [ { loadBalancerNodeID, status, interfaces: [ { interfaceIndex,
//   addresses: [ { address, vip } ] } ], … } ], "nextCursor": … }（原本 ListLoadBalancerNodesResponse・LoadBalancerNode）
export type ApprunDedicatedLoadBalancerNodeRow = {
  loadBalancerNodeID: string
  status: string | null
  addresses: { address: string; vip: boolean | null }[]
}

/**
 * LBノードの行を読む（DNSのAレコードに書くアドレス。12-1）。
 * loadBalancerNodeID が無い行は捨てる。status は string のときだけその値、それ以外は null。
 * interfaces[].addresses[] の各要素は address が string のものだけ拾い、vip は boolean の
 * ときだけその値（それ以外は null＝分からない。readZones の IsDummy と同じ方針）。
 */
export function readLoadBalancerNodeAddresses(data: unknown): ApprunDedicatedLoadBalancerNodeRow[] {
  const list = (data as any)?.loadBalancerNodes
  if (!Array.isArray(list)) return []
  const out: ApprunDedicatedLoadBalancerNodeRow[] = []
  for (const item of list) {
    const d = item as any
    if (typeof d?.loadBalancerNodeID !== 'string') continue
    const addresses: { address: string; vip: boolean | null }[] = []
    const ifaces = Array.isArray(d?.interfaces) ? d.interfaces : []
    for (const iface of ifaces) {
      const addrs = (iface as any)?.addresses
      if (!Array.isArray(addrs)) continue
      for (const a of addrs) {
        const ad = a as any
        if (typeof ad?.address === 'string') {
          addresses.push({ address: ad.address, vip: typeof ad?.vip === 'boolean' ? ad.vip : null })
        }
      }
    }
    out.push({ loadBalancerNodeID: d.loadBalancerNodeID, status: typeof d?.status === 'string' ? d.status : null, addresses })
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
