// apprunDedicatedApply.ts — さくらのAppRun 専有型（roadmap #23）段階②「作る」＋④「破棄」の段取り。
//
// ※ src/main/cloud/{planner,apply,state}.ts を下敷きにしている（複製ではない）:
//   - orderForApply と同じ考え方で「依存の順序」を明示的に固定する（2026-08-14「作る順番は
//     機能の一部」）。作る順はクラスタ→ASG→LB、壊す順はその逆（LB→ASG→クラスタ・5-7）。
//   - stateToSave と同じ考え方で「実際に何が起きたか」を必ず記録する（2026-08-14「失敗しても、
//     途中まで起きたことは記録する」）。各段が成功した直後に publishMetaFs へ書く。
//
// **この段では作らない・扱わない**: `/applications` `/applications/{id}/versions`（roadmap #23の
// ⑤独自ドメイン相当）。ここで扱うのはクラスタ・ASG・ロードバランサの3資源のみ
// （docs/apprun-dedicated-plan.md 5-7 の常時課金3点）。
//
// electron 非依存ではない: publishMetaFs.ts 経由で `.sakuraide.json` を直接読み書きする
// （publishMetaFs.ts 自体は fs/path のみに依存し electron を import しないため、
// vitest から実ファイルで直接テストできる。tests/publishMetaFs.test.ts と同じ方針）。

import type { CloudCredentials } from './auth'
import {
  getLimits, listClusters, createCluster, getCluster, deleteCluster,
  createAsg, getAsg, deleteAsg, createLoadBalancer, deleteLoadBalancer,
} from './apprunDedicated'
import { readApprunDedicatedFs, writeApprunDedicatedRecordFs } from '../publishMetaFs'
import type { ApprunDedicatedRecord } from '../../shared/publishMeta'
import { readLimits, readClusters, readClusterId, readAsgId, readLoadBalancerId } from '../../shared/apprunDedicatedShapes'

// ── 入力の形 ──────────────────────────────────────────────────────────

/** クラスタの公開ポート（5-2）。5950-5959 は予約で指定できない（呼び出し側＝画面が弾く）。 */
export type ApprunDedicatedPort = { port: number; protocol: 'http' | 'https' }

/** createClusterFlow への入力（画面 ⑤ の入力項目そのまま・5-2/5-5/5-6）。 */
export type ApprunDedicatedClusterSpec = {
  /** クラスタ・ASG・LB に共通で使う名前（1〜20文字・英数字と `_` `-`）。 */
  name: string
  ports: ApprunDedicatedPort[]
  servicePrincipalID: string
  /** 独自ドメインを使うときだけ必須（Let's Encrypt発行に要る）。 */
  letsEncryptEmail?: string
  zone: string
  workerServiceClassPath: string
  minNodes: number
  maxNodes: number
  lbServiceClassPath: string
}

// ── 予約ポート（5-5・入力チェックは画面側でも行うが、ここでも最後の砦として持つ） ──────────
export const RESERVED_PORT_RANGE: readonly [number, number] = [5950, 5959]
export function isReservedPort(port: number): boolean {
  return port >= RESERVED_PORT_RANGE[0] && port <= RESERVED_PORT_RANGE[1]
}

// ── リクエスト本文の組み立て（純関数。テスト対象） ──────────────────────────────

/**
 * ASG/LBの `interfaces[0]`。**ネットワークは共有セグメント（`upstream:'shared'`）に固定**
 * （roadmap #23・画面には出さない）。5-5: `upstream:'shared'` のときは
 * `ipPool`/`netmaskLen`/`defaultGateway` を**指定できない**（送ると400になる実測前提）。
 * だからこの関数はそれらのキーを**一切**足さない——将来 'shared' 以外を扱うようになっても、
 * この関数（このオブジェクトリテラル）を変えない限り紛れ込まない。
 */
function sharedAsgInterface(): Record<string, unknown> {
  return { interfaceIndex: 0, upstream: 'shared', connectsToLB: true }
}
function sharedLbInterface(): Record<string, unknown> {
  return { interfaceIndex: 0, upstream: 'shared' }
}

/** POST /clusters の本文を組み立てる（5-2）。 */
export function buildClusterCreateBody(spec: ApprunDedicatedClusterSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    ports: spec.ports.map(p => ({ port: p.port, protocol: p.protocol })),
    servicePrincipalID: spec.servicePrincipalID,
  }
  if (spec.letsEncryptEmail) body.letsEncryptEmail = spec.letsEncryptEmail
  return body
}

/** POST /clusters/{id}/asg の本文を組み立てる（5-5）。ASG名はクラスタ名をそのまま使う（クラスタ内で一意）。 */
export function buildAsgCreateBody(spec: ApprunDedicatedClusterSpec): Record<string, unknown> {
  return {
    name: spec.name,
    zone: spec.zone,
    workerServiceClassPath: spec.workerServiceClassPath,
    minNodes: spec.minNodes,
    maxNodes: spec.maxNodes,
    interfaces: [sharedAsgInterface()],
  }
}

/** POST /clusters/{id}/asg/{asgId}/load_balancers の本文を組み立てる（5-6）。LB名もクラスタ名をそのまま使う（ASG内で一意）。 */
export function buildLbCreateBody(spec: ApprunDedicatedClusterSpec): Record<string, unknown> {
  return {
    name: spec.name,
    serviceClassPath: spec.lbServiceClassPath,
    interfaces: [sharedLbInterface()],
  }
}

// ── API応答からID・件数を取り出す ────────────────────────────────────────
// 応答の形は src/shared/apprunDedicatedShapes.ts に集約してある（掟10・5-8の事故を受けて）。
// クラスタ作成の応答からASGのIDを読む、といった取り違えを型で防ぐため、資源ごとに専用の
// リーダを分けて使う（readClusterId / readAsgId / readLoadBalancerId を混同しない）。

/** GET /clusters の応答から既存クラスタ数を数える。 */
export function countClusters(data: unknown): number {
  return readClusters(data).length
}

// ── createClusterFlow ────────────────────────────────────────────────

export type CreateClusterFlowStage =
  | 'consent' | 'limits' | 'cluster-create' | 'cluster-verify' | 'asg-create' | 'asg-verify' | 'lb-create' | 'done'

export type CreateClusterFlowResult = {
  ok: boolean
  /** どの段で終わったか（画面の進捗表示・エラー説明に使う）。 */
  stage: CreateClusterFlowStage
  message: string
  clusterID?: string | null
  asgID?: string | null
  loadBalancerID?: string | null
}

/**
 * クラスタ→ASG→LB の順で作り、各段が成功した直後に `.sakuraide.json` へ記録する。
 *
 * 安全規約:
 *  1. **同意（consentedAt）が記録に無ければ、API を一度も呼ばずに中止する。**
 *  2. `GET /limits` と現在のクラスタ数を突き合わせ、上限に達していれば作る前に止める。
 *  3. クラスタ作成 → `getCluster` で実在確認 → ASG作成 → `getAsg` で実在確認 → LB作成、の順。
 *     POST が成功してIDを取れた時点で**確認を待たずに記録する**——`getCluster`/`getAsg` は
 *     「次の段へ進んでよいか」のゲートであって、「記録してよいか」のゲートではない。POSTが
 *     成功した以上、実際には資源ができている可能性があるため、確認が取れなくても記録は残す
 *     （2026-08-14「成功と読んだ応答は結果を確かめるまで成功ではない」の逆側——**確認できない
 *     ことは「作られていない」の証明にもならない**。記録しない方が課金を見失う危険が大きい）。
 *  4. 途中で失敗しても**自動では巻き戻さない**（呼び出し側＝画面が、記録された分の破棄を促す）。
 */
export async function createClusterFlow(
  auth: CloudCredentials, projectDir: string, spec: ApprunDedicatedClusterSpec, baseUrl?: string,
): Promise<CreateClusterFlowResult> {
  // 1. 同意の確認。**ここより先で fetch を一切呼ばない。**
  const record = readApprunDedicatedFs(projectDir)
  if (!record.consentedAt) {
    return { ok: false, stage: 'consent', message: '費用の同意が記録されていません。④で同意してから作成してください。' }
  }

  // 2. 上限の確認。
  const limitsRes = await getLimits(auth, baseUrl)
  if (!limitsRes.ok) {
    return { ok: false, stage: 'limits', message: `上限を確認できませんでした: ${limitsRes.message}` }
  }
  const clusterLimit = readLimits(limitsRes.data).clusterCount
  if (typeof clusterLimit === 'number') {
    const listRes = await listClusters(auth, baseUrl)
    if (!listRes.ok) {
      return { ok: false, stage: 'limits', message: `既存クラスタ数を確認できませんでした: ${listRes.message}` }
    }
    const current = countClusters(listRes.data)
    if (current >= clusterLimit) {
      return {
        ok: false, stage: 'limits',
        message: `クラスタは最大${clusterLimit}個です。いま${current}個あります。`,
      }
    }
  }

  // 3-a. クラスタ作成。
  const clusterRes = await createCluster(auth, buildClusterCreateBody(spec), baseUrl)
  if (!clusterRes.ok) {
    return { ok: false, stage: 'cluster-create', message: `クラスタの作成に失敗しました: ${clusterRes.message}` }
  }
  const clusterID = readClusterId(clusterRes.data)
  if (!clusterID) {
    return { ok: false, stage: 'cluster-create', message: 'クラスタを作成しましたが、応答からIDを取り出せませんでした（手動で確認してください）。' }
  }
  // POSTが成功しIDが取れた時点で記録する（getClusterの結果を待たない。上のコメント参照）。
  const nowIso = new Date().toISOString()
  writeApprunDedicatedRecordFs(projectDir, {
    clusterID,
    name: spec.name,
    zone: spec.zone,
    workerServiceClassPath: spec.workerServiceClassPath,
    lbServiceClassPath: spec.lbServiceClassPath,
    createdAt: nowIso,
  })

  // 3-b. 実在確認。確認できるまで「次の段（ASG作成）」へは進まない。
  const verifyClusterRes = await getCluster(auth, clusterID, baseUrl)
  if (!verifyClusterRes.ok) {
    return {
      ok: false, stage: 'cluster-verify',
      message: `クラスタの作成を確認できませんでした（作成のAPI応答は成功でした。クラスタID『${clusterID}』は記録済みです）: ${verifyClusterRes.message}`,
      clusterID,
    }
  }

  // 3-c. ASG作成。
  const asgRes = await createAsg(auth, clusterID, buildAsgCreateBody(spec), baseUrl)
  if (!asgRes.ok) {
    return {
      ok: false, stage: 'asg-create',
      message: `オートスケーリンググループの作成に失敗しました: ${asgRes.message}`,
      clusterID,
    }
  }
  const asgID = readAsgId(asgRes.data)
  if (!asgID) {
    return {
      ok: false, stage: 'asg-create',
      message: 'オートスケーリンググループを作成しましたが、応答からIDを取り出せませんでした（手動で確認してください）。',
      clusterID,
    }
  }
  writeApprunDedicatedRecordFs(projectDir, { asgID })

  // 3-d. 実在確認。
  const verifyAsgRes = await getAsg(auth, clusterID, asgID, baseUrl)
  if (!verifyAsgRes.ok) {
    return {
      ok: false, stage: 'asg-verify',
      message: `オートスケーリンググループの作成を確認できませんでした（作成のAPI応答は成功でした。ASG ID『${asgID}』は記録済みです）: ${verifyAsgRes.message}`,
      clusterID, asgID,
    }
  }

  // 3-e. LB作成。**クラスタとは別資源（5-6）。ここまで来ないと存在しない。**
  const lbRes = await createLoadBalancer(auth, clusterID, asgID, buildLbCreateBody(spec), baseUrl)
  if (!lbRes.ok) {
    return {
      ok: false, stage: 'lb-create',
      message: `ロードバランサの作成に失敗しました: ${lbRes.message}`,
      clusterID, asgID,
    }
  }
  const loadBalancerID = readLoadBalancerId(lbRes.data)
  if (!loadBalancerID) {
    return {
      ok: false, stage: 'lb-create',
      message: 'ロードバランサを作成しましたが、応答からIDを取り出せませんでした（手動で確認してください）。',
      clusterID, asgID,
    }
  }
  writeApprunDedicatedRecordFs(projectDir, { loadBalancerID })

  return { ok: true, stage: 'done', message: '作成できました。', clusterID, asgID, loadBalancerID }
}

// ── teardownFlow ─────────────────────────────────────────────────────

export type TeardownFlowResult = {
  /** 記録にあったものが全部消せたか。1つでも残れば false。 */
  ok: boolean
  /** 消せたものの説明（画面向け）。 */
  executed: string[]
  message: string
  /** 消せずに残ったID（無ければキー自体が無い＝最初から記録に無かった/消せた）。 */
  remaining: { loadBalancerID?: string; asgID?: string; clusterID?: string }
}

/**
 * 記録にある ID だけを、**LB → ASG → クラスタ の順**で削除する（5-7・逆順）。
 * 記録に無い資源は触らない。ある段が失敗したら、そこで止める（それより下＝クラスタ側は
 * 触らない——LBが残ったままASGを消せる保証がAPI仕様上どこにも無いため、5-7の順序を厳密に守る）。
 * 各段の成否を即座に記録へ反映する（消せたものは記録から外す＝nullに戻す。消せなかったものは残す）。
 */
export async function teardownFlow(
  auth: CloudCredentials, projectDir: string, baseUrl?: string,
): Promise<TeardownFlowResult> {
  const record = readApprunDedicatedFs(projectDir)
  const executed: string[] = []

  const hasCluster = !!record.clusterID
  const hasAsg = !!record.asgID
  const hasLb = !!record.loadBalancerID

  if (!hasCluster && !hasAsg && !hasLb) {
    return { ok: true, executed, message: '記録がありません（このプロジェクトでは何も作られていません）。', remaining: {} }
  }

  // ── LB ──
  if (hasLb) {
    if (!hasCluster || !hasAsg) {
      // 親のIDが記録に無いと URL を組み立てられない（本来起きない想定だが、最後の砦として検知する）。
      return {
        ok: false, executed,
        message: `ロードバランサ『${record.loadBalancerID}』の削除に必要なクラスタ/ASGのIDが記録にありません。コントロールパネルで確認してください。`,
        remaining: { loadBalancerID: record.loadBalancerID as string, asgID: record.asgID ?? undefined, clusterID: record.clusterID ?? undefined },
      }
    }
    const res = await deleteLoadBalancer(auth, record.clusterID as string, record.asgID as string, record.loadBalancerID as string, baseUrl)
    if (!res.ok) {
      return {
        ok: false, executed,
        message: `ロードバランサの削除に失敗しました。残っています＝課金が続きます: ${res.message}`,
        remaining: { loadBalancerID: record.loadBalancerID as string, asgID: record.asgID as string, clusterID: record.clusterID as string },
      }
    }
    writeApprunDedicatedRecordFs(projectDir, { loadBalancerID: null })
    executed.push(`ロードバランサ『${record.loadBalancerID}』を削除しました`)
  }

  // ── ASG ──
  if (hasAsg) {
    if (!hasCluster) {
      return {
        ok: false, executed,
        message: `ASG『${record.asgID}』の削除に必要なクラスタのIDが記録にありません。コントロールパネルで確認してください。`,
        remaining: { asgID: record.asgID as string, clusterID: record.clusterID ?? undefined },
      }
    }
    const res = await deleteAsg(auth, record.clusterID as string, record.asgID as string, baseUrl)
    if (!res.ok) {
      return {
        ok: false, executed,
        message: `オートスケーリンググループの削除に失敗しました。残っています＝課金が続きます: ${res.message}`,
        remaining: { asgID: record.asgID as string, clusterID: record.clusterID as string },
      }
    }
    writeApprunDedicatedRecordFs(projectDir, { asgID: null })
    executed.push(`オートスケーリンググループ『${record.asgID}』を削除しました`)
  }

  // ── クラスタ ──
  if (hasCluster) {
    const res = await deleteCluster(auth, record.clusterID as string, baseUrl)
    if (!res.ok) {
      return {
        ok: false, executed,
        message: `クラスタの削除に失敗しました。残っています＝課金が続きます: ${res.message}`,
        remaining: { clusterID: record.clusterID as string },
      }
    }
    writeApprunDedicatedRecordFs(projectDir, { clusterID: null, name: null, zone: null, workerServiceClassPath: null, lbServiceClassPath: null, createdAt: null })
    executed.push(`クラスタ『${record.clusterID}』を削除しました`)
  }

  return { ok: true, executed, message: 'すべて削除できました。課金は止まっています。', remaining: {} }
}

export type { ApprunDedicatedRecord }
