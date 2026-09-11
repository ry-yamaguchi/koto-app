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
  listAsg, listLoadBalancers, type ApprunDedicatedResult,
} from './apprunDedicated'
import { readApprunDedicatedFs, writeApprunDedicatedRecordFs } from '../publishMetaFs'
import type { ApprunDedicatedRecord } from '../../shared/publishMeta'
import {
  readLimits, readClusters, readClusterId, readAsgId, readLoadBalancerId,
  readClusterRows, readAsgRows, readLoadBalancerRows, readApiErrorTitle,
} from '../../shared/apprunDedicatedShapes'

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

// ── L（2026-09-10 レビューの修理・バッチ3）: 入力検証を「最後の砦」として本当に働かせる ─────
// `isReservedPort` は「最後の砦」と書かれていたのに createClusterFlow から呼ばれていなかった。
// main の IPC ハンドラ（apprunDedicated.ts の isClusterSpec）も ports の中身や minNodes/maxNodes
// の範囲を見ていない——つまり画面の入力チェックを迂回して IPC を直接叩けば、不正な値のまま
// fetch まで届いていた。ここに純関数として検証をまとめ、createClusterFlow の入口
// （confirmed・consentedAt の判定の後、fetch の前）で呼ぶ。違反があれば fetch を一切呼ばない。
const CLUSTER_NAME_RE = /^[A-Za-z0-9_-]{1,20}$/
const SERVICE_PRINCIPAL_ID_RE = /^\d{12}$/

export type ClusterSpecValidation = { ok: true } | { ok: false; message: string }

/** createClusterFlow への入力を検証する（画面側の入力チェックと同じ基準・5-2/5-5/5-6）。 */
export function validateClusterSpec(spec: ApprunDedicatedClusterSpec): ClusterSpecValidation {
  if (typeof spec.name !== 'string' || !CLUSTER_NAME_RE.test(spec.name)) {
    return { ok: false, message: `クラスタ名は1〜20文字の英数字・_・- で指定してください（受け取った値: ${JSON.stringify(spec.name)}）` }
  }
  if (!Array.isArray(spec.ports) || spec.ports.length === 0) {
    return { ok: false, message: '公開ポートを1つ以上指定してください' }
  }
  for (const p of spec.ports) {
    if (!p || !Number.isInteger(p.port) || p.port < 1 || p.port > 65535) {
      return { ok: false, message: `ポート番号は1〜65535の整数で指定してください（受け取った値: ${JSON.stringify(p?.port)}）` }
    }
    if (p.protocol !== 'http' && p.protocol !== 'https') {
      return { ok: false, message: `protocol は 'http' か 'https' のみです（受け取った値: ${JSON.stringify(p.protocol)}）` }
    }
    if (isReservedPort(p.port)) {
      return { ok: false, message: `ポート ${RESERVED_PORT_RANGE[0]}-${RESERVED_PORT_RANGE[1]} は予約されており使えません（指定値: ${p.port}）` }
    }
  }
  if (!Number.isInteger(spec.minNodes) || spec.minNodes < 1 || spec.minNodes > 10) {
    return { ok: false, message: `ノード数（min）は1〜10の整数で指定してください（受け取った値: ${JSON.stringify(spec.minNodes)}）` }
  }
  if (!Number.isInteger(spec.maxNodes) || spec.maxNodes < 1 || spec.maxNodes > 10) {
    return { ok: false, message: `ノード数（max）は1〜10の整数で指定してください（受け取った値: ${JSON.stringify(spec.maxNodes)}）` }
  }
  if (spec.minNodes > spec.maxNodes) {
    return { ok: false, message: `ノード数は min ≦ max にしてください（min:${spec.minNodes} > max:${spec.maxNodes}）` }
  }
  if (typeof spec.servicePrincipalID !== 'string' || !SERVICE_PRINCIPAL_ID_RE.test(spec.servicePrincipalID)) {
    return { ok: false, message: 'servicePrincipalID は12桁の数字で指定してください' }
  }
  if (typeof spec.zone !== 'string' || !spec.zone.trim()) {
    return { ok: false, message: 'ゾーンを指定してください' }
  }
  return { ok: true }
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
  | 'consent' | 'invalid' | 'existing' | 'record' | 'limits'
  | 'cluster-create' | 'cluster-verify' | 'asg-create' | 'asg-verify' | 'lb-create' | 'lb-verify' | 'done'

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
 * 記録への書き込みを試み、失敗したら「作られたのに記録できなかった」失敗結果を作る
 * （2026-09-10 レビューの修理・C: 記録の書き込み失敗で止まる。記録なしで課金資源を増やさない）。
 * 成功すれば null（呼び出し側はそのまま続けてよい）。
 */
function recordOrStop(
  projectDir: string,
  patch: Partial<ApprunDedicatedRecord>,
  label: string,
  id: string,
  ids: { clusterID?: string | null; asgID?: string | null; loadBalancerID?: string | null },
): CreateClusterFlowResult | null {
  const wrote = writeApprunDedicatedRecordFs(projectDir, patch)
  if (wrote) return null
  return {
    ok: false, stage: 'record',
    message: `${label}は作成されました（ID『${id}』）が、記録に書き込めませんでした。このIDを控えて、コントロールパネルで確認してください。`,
    ...ids,
  }
}

/**
 * クラスタ→ASG→LB の順で作り、各段が成功した直後に `.sakuraide.json` へ記録する。
 *
 * 安全規約:
 *  0. **`opts.confirmed !== true` なら、API を一切呼ばずに中止する**（2026-09-10 レビューの修理・A・
 *     掟10「お金・破壊の歯止めは振る舞いで固定する」の3点セット。confirmed＝「今回の操作の確認
 *     ダイアログを通ったか」。consentedAt（下の1.）＝「費用に同意したか」とは意味が違うので、
 *     両方のゲートを独立に持つ）。
 *  1. **同意（consentedAt）が記録に無ければ、API を一度も呼ばずに中止する。**
 *  1.2 **入力を `validateClusterSpec` で検証する**（2026-09-10 レビューの修理・L。画面の入力
 *      チェックを迂回して IPC を直接叩かれても、ここが「最後の砦」として fetch を止める）。
 *  1.5 **記録に既に何か（clusterID/asgID/loadBalancerID のいずれか）があれば、新規作成させない**
 *      （2026-09-10 レビューの修理・B。先に作ったクラスタが記録から上書きされて消える事故を防ぐ）。
 *  1.8 **`.sakuraide.json` へ書き込めるかを、最初のPOSTより前に確かめる**（2026-09-10 レビューの
 *      修理・C。ここまでは fetch を一切呼んでいない）。
 *  2. `GET /limits` と現在のクラスタ数を突き合わせ、上限に達していれば作る前に止める。
 *     **`clusterCount` が数値で読めなければ、上限チェックを飛ばさず止める**（2026-09-10 レビューの
 *     修理・F。「分からない」を「大丈夫」に倒さない）。
 *  3. クラスタ作成 → `getCluster` で実在確認 → ASG作成 → `getAsg` で実在確認 → LB作成、の順。
 *     POST が成功してIDを取れた時点で**確認を待たずに記録する**——`getCluster`/`getAsg` は
 *     「次の段へ進んでよいか」のゲートであって、「記録してよいか」のゲートではない。POSTが
 *     成功した以上、実際には資源ができている可能性があるため、確認が取れなくても記録は残す
 *     （2026-08-14「成功と読んだ応答は結果を確かめるまで成功ではない」の逆側——**確認できない
 *     ことは「作られていない」の証明にもならない**。記録しない方が課金を見失う危険が大きい）。
 *     **記録の書き込みそのものが失敗したら、その場で止める**（recordOrStop・C）。
 *  3.5 **作成POSTの応答が取れなかったときは、一覧を名前で探す**（2026-09-10 レビューの修理・D）。
 *      見つかればそのIDを記録して失敗を返す（「分からない」を「未作成」に倒さない）。見つからない・
 *      一覧も失敗なら、断定しない文言（「確認できませんでした」）で失敗を返す。
 *  3.8 **LB作成後も、クラスタ・ASGと同じく実在確認する**（2026-09-10 レビューの修理・M）。
 *      LBには `getLoadBalancer` 相当の単体取得APIが無いため、`listLoadBalancers` を引いて
 *      そのIDが一覧にあるかで確かめる。無ければ `stage:'lb-verify'` で「確認できませんでした」
 *      （記録は残したまま。クラスタ・ASGの verify と同じ方針）。
 *  4. 途中で失敗しても**自動では巻き戻さない**（呼び出し側＝画面が、記録された分の破棄を促す）。
 */
export async function createClusterFlow(
  auth: CloudCredentials, projectDir: string, spec: ApprunDedicatedClusterSpec,
  opts: { confirmed: boolean }, baseUrl?: string,
): Promise<CreateClusterFlowResult> {
  // 0. 確認ダイアログを通ったか。**ここより先で fetch を一切呼ばない。**
  if (opts.confirmed !== true) {
    return { ok: false, stage: 'consent', message: '確認ダイアログを通っていません' }
  }

  // 1. 同意の確認（費用への同意＝consentedAt。confirmedとは別の意味）。
  const record = readApprunDedicatedFs(projectDir)
  if (!record.consentedAt) {
    return { ok: false, stage: 'consent', message: '費用の同意が記録されていません。④で同意してから作成してください。' }
  }

  // 1.2. 入力検証（L・2026-09-10 レビューの修理・バッチ3）。画面側でも同じ基準で検証しているが、
  // ここは「最後の砦」——IPCを直接叩かれても、ここを通らなければ fetch は一切呼ばれない。
  const validation = validateClusterSpec(spec)
  if (!validation.ok) {
    return { ok: false, stage: 'invalid', message: validation.message }
  }

  // 1.5. 既に記録があれば新規作成させない。
  if (record.clusterID || record.asgID || record.loadBalancerID) {
    return {
      ok: false, stage: 'existing',
      message: `このプロジェクトには作られたものの記録があります（クラスタID『${record.clusterID ?? '(記録なし)'}』）。⑥で破棄してから作成してください。`,
      clusterID: record.clusterID ?? null,
      asgID: record.asgID ?? null,
      loadBalancerID: record.loadBalancerID ?? null,
    }
  }

  // 1.8. 記録ファイルへ書き込めるかを、最初のPOSTより前に確かめる（fetchはまだ一切呼んでいない）。
  if (!writeApprunDedicatedRecordFs(projectDir, {})) {
    return {
      ok: false, stage: 'record',
      message: '記録ファイル（.sakuraide.json）に書き込めないため作成を始めません。フォルダの権限を確認してください。',
    }
  }

  // 2. 上限の確認。
  const limitsRes = await getLimits(auth, baseUrl)
  if (!limitsRes.ok) {
    return { ok: false, stage: 'limits', message: `上限を確認できませんでした: ${limitsRes.message}` }
  }
  const clusterLimit = readLimits(limitsRes.data).clusterCount
  if (typeof clusterLimit !== 'number') {
    return {
      ok: false, stage: 'limits',
      message: `上限（clusterCount）を応答から読み取れませんでした（応答の形が想定と違います）。生の応答: ${JSON.stringify(limitsRes.data)}`,
    }
  }
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

  // 3-a. クラスタ作成。
  const clusterRes = await createCluster(auth, buildClusterCreateBody(spec), baseUrl)
  if (!clusterRes.ok) {
    // 応答が取れなかった。一覧を名前で探し、見つかれば記録する（D）。
    const foundListRes = await listClusters(auth, baseUrl)
    const found = foundListRes.ok ? readClusterRows(foundListRes.data).find(r => r.name === spec.name) : null
    if (found) {
      const stop = recordOrStop(projectDir, {
        clusterID: found.clusterID, name: spec.name, zone: spec.zone,
        workerServiceClassPath: spec.workerServiceClassPath, lbServiceClassPath: spec.lbServiceClassPath,
        createdAt: new Date().toISOString(),
      }, 'クラスタ', found.clusterID, { clusterID: found.clusterID })
      if (stop) return stop
      return {
        ok: false, stage: 'cluster-create',
        message: `クラスタ作成の応答を受け取れませんでしたが、同じ名前のクラスタが見つかったので記録しました（ID『${found.clusterID}』）。元のエラー: ${clusterRes.message}`,
        clusterID: found.clusterID,
      }
    }
    return {
      ok: false, stage: 'cluster-create',
      message: `クラスタの作成に失敗しました: ${clusterRes.message}\n作られたかどうか確認できませんでした。コントロールパネルで『${spec.name}』が無いことを確認してください。`,
    }
  }
  const clusterID = readClusterId(clusterRes.data)
  if (!clusterID) {
    return { ok: false, stage: 'cluster-create', message: 'クラスタを作成しましたが、応答からIDを取り出せませんでした（手動で確認してください）。' }
  }
  // POSTが成功しIDが取れた時点で記録する（getClusterの結果を待たない。上のコメント参照）。
  const nowIso = new Date().toISOString()
  const clusterWriteStop = recordOrStop(projectDir, {
    clusterID,
    name: spec.name,
    zone: spec.zone,
    workerServiceClassPath: spec.workerServiceClassPath,
    lbServiceClassPath: spec.lbServiceClassPath,
    createdAt: nowIso,
  }, 'クラスタ', clusterID, { clusterID })
  if (clusterWriteStop) return clusterWriteStop

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
    const foundListRes = await listAsg(auth, clusterID, undefined, baseUrl)
    const found = foundListRes.ok ? readAsgRows(foundListRes.data).find(r => r.name === spec.name) : null
    if (found) {
      const stop = recordOrStop(projectDir, { asgID: found.asgID }, 'オートスケーリンググループ', found.asgID, { clusterID, asgID: found.asgID })
      if (stop) return stop
      return {
        ok: false, stage: 'asg-create',
        message: `オートスケーリンググループ作成の応答を受け取れませんでしたが、同じ名前のASGが見つかったので記録しました（ID『${found.asgID}』）。元のエラー: ${asgRes.message}`,
        clusterID, asgID: found.asgID,
      }
    }
    return {
      ok: false, stage: 'asg-create',
      message: `オートスケーリンググループの作成に失敗しました: ${asgRes.message}\n作られたかどうか確認できませんでした。コントロールパネルで『${spec.name}』が無いことを確認してください。`,
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
  const asgWriteStop = recordOrStop(projectDir, { asgID }, 'オートスケーリンググループ', asgID, { clusterID, asgID })
  if (asgWriteStop) return asgWriteStop

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
    const foundListRes = await listLoadBalancers(auth, clusterID, asgID, undefined, baseUrl)
    const found = foundListRes.ok ? readLoadBalancerRows(foundListRes.data).find(r => r.name === spec.name) : null
    if (found) {
      const stop = recordOrStop(
        projectDir, { loadBalancerID: found.loadBalancerID }, 'ロードバランサ', found.loadBalancerID,
        { clusterID, asgID, loadBalancerID: found.loadBalancerID },
      )
      if (stop) return stop
      return {
        ok: false, stage: 'lb-create',
        message: `ロードバランサ作成の応答を受け取れませんでしたが、同じ名前のロードバランサが見つかったので記録しました（ID『${found.loadBalancerID}』）。元のエラー: ${lbRes.message}`,
        clusterID, asgID, loadBalancerID: found.loadBalancerID,
      }
    }
    return {
      ok: false, stage: 'lb-create',
      message: `ロードバランサの作成に失敗しました: ${lbRes.message}\n作られたかどうか確認できませんでした。コントロールパネルで『${spec.name}』が無いことを確認してください。`,
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
  const lbWriteStop = recordOrStop(projectDir, { loadBalancerID }, 'ロードバランサ', loadBalancerID, { clusterID, asgID, loadBalancerID })
  if (lbWriteStop) return lbWriteStop

  // 3-f. 実在確認（M）。LBには単体取得APIが無いため、一覧にIDがあるかで確かめる
  // （クラスタ・ASGの verify と同じ扱いに揃える。記録は残したまま——POSTは成功しているため）。
  const verifyLbListRes = await listLoadBalancers(auth, clusterID, asgID, undefined, baseUrl)
  const lbFound = verifyLbListRes.ok && readLoadBalancerRows(verifyLbListRes.data).some(r => r.loadBalancerID === loadBalancerID)
  if (!lbFound) {
    return {
      ok: false, stage: 'lb-verify',
      message: `ロードバランサの作成を確認できませんでした（作成のAPI応答は成功でした。ID『${loadBalancerID}』は記録済みです）${verifyLbListRes.ok ? '' : `: ${verifyLbListRes.message}`}`,
      clusterID, asgID, loadBalancerID,
    }
  }

  return { ok: true, stage: 'done', message: '作成できました。', clusterID, asgID, loadBalancerID }
}

// ── teardownFlow ─────────────────────────────────────────────────────
//
// #39（2026-09-10 実測・5-11）: 専有型の DELETE は 204/404 いずれでも**削除は非同期**。
// 資源は一覧に `deleting:true` のまま数分〜十数分残り続け、その間 ①削除中のIDへ再度
// DELETE すると 404 ②まだ残っている下位資源（LB）を抱えたまま上位（ASG）を消そうとすると
// 409（title に `Cannot delete Auto Scaling Group because it has associated Load Balancers: <id>`）
// が返る。v0.6.16 の旧実装は 204/404 の直後に一覧を1回だけ見て「deleting:true なら消えた扱い」
// にしていたため、(1) ASG が 409 で止まり (2) LB の ID が記録から外れて Koto から押し直せない、
// が同時に起きた（CLAUDE.md 掟10「削除の 204 は『消えた』ではない」）。
// → 各段は **一覧から ID が完全に消えるまで待ってから** 次の段へ進む（waitUntilGone）。

export type TeardownFlowResult = {
  /** 記録にあったものが全部消せたか。1つでも残れば false。 */
  ok: boolean
  /** 起きたことの説明（画面向け。削除の完了だけでなく、記録への書き戻し等も含む）。 */
  executed: string[]
  message: string
  /** 消せずに残ったID（無ければキー自体が無い＝最初から記録に無かった/消せた）。 */
  remaining: { loadBalancerID?: string; asgID?: string; clusterID?: string }
  /**
   * 削除は受け付けられた（204、または404+`deleting:true`）が、**待ち切れず（timeout）に
   * 止まった**ときだけ立つ（#39）。画面はこれを見て「削除中です。しばらくして⑥をもう一度
   * 押してください」の黄色い注意を出す（残っています＝失敗、の赤い表示とは区別する）。
   */
  inProgress?: { loadBalancerID?: string; asgID?: string; clusterID?: string }
}

export type TeardownFlowOpts = {
  confirmed: boolean
  /**
   * 進捗メッセージ（「〜の削除を待っています（N分経過）…」を30秒ごとに1回）。画面へ流すのに使う
   * （IPCハンドラが `apprunDedicated:teardown-progress` で event.sender.send する）。省略可。
   */
  progress?: (msg: string) => void
  /** waitUntilGone のポーリング間隔（既定5秒）。テストで短縮せず、代わりに `sleep` を偽物にする。 */
  intervalMs?: number
  /** waitUntilGone の最長待ち時間（既定10分）。 */
  timeoutMs?: number
  /**
   * waitUntilGone がポーリングの合間に待つのに使う関数（既定は実際の setTimeout）。
   * **テストではここへ即時に解決する偽物を渡し、実際には待たずにループを回す**（#39のテスト方針）。
   */
  sleep?: (ms: number) => Promise<void>
}

export type WaitUntilGoneResult = { ok: true } | { ok: false; reason: 'timeout' }

const WAIT_UNTIL_GONE_DEFAULT_INTERVAL_MS = 5000
const WAIT_UNTIL_GONE_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000 // 10分
const PROGRESS_INTERVAL_MS = 30 * 1000 // 30秒ごとに進捗を出す

/**
 * 一覧から ID が消える（`isPresent` が false を返す）のを待つ、純粋なループ（#39）。
 * `listFn` を呼び、`isPresent(data)` で「まだ残っているか」を判定する。
 *
 * **一覧の取得そのものが失敗したときは「まだ残っている」とみなして待ち続ける**——DELETE自体は
 * 204（またはdeleting:trueの404）で受理済みのため、一覧の一時的な失敗だけで「消えた」と
 * 決めつけない（分からないものを都合よく倒さない・掟1と同じ方針。2026-08-14「成功と読んだ
 * 応答は結果を確かめるまで成功ではない」の逆側でもある——確認できないことは「消えた」の
 * 証明にもならない）。
 *
 * **経過時間は実時間（Date.now）ではなく、ループを回した回数 × intervalMs で数える。**
 * これにより、テストで `sleep` を即時に解決する偽物へ差し替えれば、実際には1ミリ秒も
 * 待たずに「5秒おき・最長10分」のループの動きをそのまま確かめられる（#39のテスト方針）。
 */
export async function waitUntilGone(
  listFn: () => Promise<ApprunDedicatedResult>,
  isPresent: (data: unknown) => boolean,
  opts: {
    intervalMs?: number
    timeoutMs?: number
    sleep?: (ms: number) => Promise<void>
    /** 経過時間(ms)が30秒の倍数を跨ぐたびに1回呼ばれる（画面への進捗表示用）。省略可。 */
    onProgress?: (elapsedMs: number) => void
  } = {},
): Promise<WaitUntilGoneResult> {
  const intervalMs = opts.intervalMs ?? WAIT_UNTIL_GONE_DEFAULT_INTERVAL_MS
  const timeoutMs = opts.timeoutMs ?? WAIT_UNTIL_GONE_DEFAULT_TIMEOUT_MS
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  let elapsedMs = 0
  let lastProgressMs = 0
  for (;;) {
    const res = await listFn()
    const present = res.ok ? isPresent(res.data) : true
    if (!present) return { ok: true }
    if (elapsedMs >= timeoutMs) return { ok: false, reason: 'timeout' }
    await sleep(intervalMs)
    elapsedMs += intervalMs
    if (opts.onProgress && elapsedMs - lastProgressMs >= PROGRESS_INTERVAL_MS) {
      lastProgressMs = elapsedMs
      opts.onProgress(elapsedMs)
    }
  }
}

/** 経過時間(ms)を「N分経過」に丸める（画面向けの進捗文言・#39）。30秒→「1分経過」に丸まる。 */
function formatElapsedMinutes(ms: number): string {
  return `${Math.max(1, Math.round(ms / 60000))}分経過`
}

/** JSON文字列を安全にパースする（失敗すれば null）。ApprunDedicatedResult.detail は生の応答本文（JSON文字列）。 */
function safeParseJson(text: string | undefined): unknown {
  if (!text) return null
  try { return JSON.parse(text) } catch { return null }
}

/**
 * `waitUntilGone` を呼び、timeout なら `TeardownFlowResult`（ok:false・inProgress付き）を返す。
 * 消えたのが確認できたら `null`（呼び出し側はそのまま続けてよい）。204・404+deleting:true・
 * 409回復のいずれからも同じ形で使う共通部分（#39）。
 */
async function waitOrStop(
  label: string,
  listFn: () => Promise<ApprunDedicatedResult>,
  isPresent: (data: unknown) => boolean,
  opts: TeardownFlowOpts,
  executed: string[],
  remaining: TeardownFlowResult['remaining'],
  inProgress: TeardownFlowResult['inProgress'],
): Promise<TeardownFlowResult | null> {
  const wait = await waitUntilGone(listFn, isPresent, {
    intervalMs: opts.intervalMs,
    timeoutMs: opts.timeoutMs,
    sleep: opts.sleep,
    onProgress: ms => opts.progress?.(`${label}の削除を待っています（${formatElapsedMinutes(ms)}）…`),
  })
  if (wait.ok) return null
  return {
    ok: false, executed,
    message: `${label}の削除を受け付けましたが、まだ削除中です。しばらくして⑥をもう一度押してください`,
    remaining, inProgress,
  }
}

/** ロードバランサを削除し、一覧から消えるまで待つ。成功（次へ進んでよい）なら null。 */
async function attemptDeleteLoadBalancer(
  auth: CloudCredentials, projectDir: string, clusterID: string, asgID: string, loadBalancerID: string,
  opts: TeardownFlowOpts, baseUrl: string | undefined, executed: string[],
): Promise<TeardownFlowResult | null> {
  const remaining = { loadBalancerID, asgID, clusterID }
  const res = await deleteLoadBalancer(auth, clusterID, asgID, loadBalancerID, baseUrl)
  if (res.ok) {
    const stop = await waitOrStop(
      'ロードバランサ',
      () => listLoadBalancers(auth, clusterID, asgID, undefined, baseUrl),
      data => readLoadBalancerRows(data).some(r => r.loadBalancerID === loadBalancerID),
      opts, executed, remaining, { loadBalancerID },
    )
    if (stop) return stop
    writeApprunDedicatedRecordFs(projectDir, { loadBalancerID: null })
    executed.push(`ロードバランサ『${loadBalancerID}』を削除しました（消えたことを確認）`)
    return null
  }
  if (res.status === 404) {
    const listRes = await listLoadBalancers(auth, clusterID, asgID, undefined, baseUrl)
    if (!listRes.ok) {
      return {
        ok: false, executed,
        message: `ロードバランサの削除に失敗しました（404）。一覧でも確かめられませんでした＝課金が続きます: ${listRes.message}`,
        remaining,
      }
    }
    const row = readLoadBalancerRows(listRes.data).find(r => r.loadBalancerID === loadBalancerID)
    if (!row) {
      writeApprunDedicatedRecordFs(projectDir, { loadBalancerID: null })
      executed.push(`ロードバランサ『${loadBalancerID}』は既に存在しませんでした（記録から外しました）`)
      return null
    }
    if (row.deleting === true) {
      const stop = await waitOrStop(
        'ロードバランサ',
        () => listLoadBalancers(auth, clusterID, asgID, undefined, baseUrl),
        data => readLoadBalancerRows(data).some(r => r.loadBalancerID === loadBalancerID),
        opts, executed, remaining, { loadBalancerID },
      )
      if (stop) return stop
      writeApprunDedicatedRecordFs(projectDir, { loadBalancerID: null })
      executed.push(`ロードバランサ『${loadBalancerID}』を削除しました（消えたことを確認）`)
      return null
    }
    return {
      ok: false, executed,
      message: `ロードバランサの削除に失敗しました。残っています＝課金が続きます: ${res.message}`,
      remaining,
    }
  }
  return {
    ok: false, executed,
    message: `ロードバランサの削除に失敗しました。残っています＝課金が続きます: ${res.message}`,
    remaining,
  }
}

/**
 * ASGを削除し、一覧から消えるまで待つ。成功（次へ進んでよい）なら null。
 * **409（本文の title に `Load Balancers` を含む）**＝LBがまだ残っているとき（#39 5-11実測）は、
 * LBの一覧を引き直して見つかったIDを記録に戻し、`deleting:true` なら消えるまで待ってから
 * ASGのDELETEを再試行する（`for` ループで戻る）。見つからなければレースで解消したとみて
 * 即座に再試行。回復にも上限（5回）を設け、想定外の繰り返しでは止める（無限ループの防止）。
 */
async function attemptDeleteAsg(
  auth: CloudCredentials, projectDir: string, clusterID: string, asgID: string,
  opts: TeardownFlowOpts, baseUrl: string | undefined, executed: string[],
): Promise<TeardownFlowResult | null> {
  const remaining = { asgID, clusterID }
  for (let attempt = 0; ; attempt++) {
    if (attempt >= 5) {
      return {
        ok: false, executed,
        message: 'オートスケーリンググループの削除を繰り返し試みましたが完了しませんでした。コントロールパネルで確認してください。',
        remaining,
      }
    }
    const res = await deleteAsg(auth, clusterID, asgID, baseUrl)
    if (res.ok) {
      const stop = await waitOrStop(
        'オートスケーリンググループ',
        () => listAsg(auth, clusterID, undefined, baseUrl),
        data => readAsgRows(data).some(r => r.asgID === asgID),
        opts, executed, remaining, { asgID },
      )
      if (stop) return stop
      writeApprunDedicatedRecordFs(projectDir, { asgID: null })
      executed.push(`オートスケーリンググループ『${asgID}』を削除しました（消えたことを確認）`)
      return null
    }
    if (res.status === 404) {
      const listRes = await listAsg(auth, clusterID, undefined, baseUrl)
      if (!listRes.ok) {
        return {
          ok: false, executed,
          message: `オートスケーリンググループの削除に失敗しました（404）。一覧でも確かめられませんでした＝課金が続きます: ${listRes.message}`,
          remaining,
        }
      }
      const row = readAsgRows(listRes.data).find(r => r.asgID === asgID)
      if (!row) {
        writeApprunDedicatedRecordFs(projectDir, { asgID: null })
        executed.push(`オートスケーリンググループ『${asgID}』は既に存在しませんでした（記録から外しました）`)
        return null
      }
      if (row.deleting === true) {
        const stop = await waitOrStop(
          'オートスケーリンググループ',
          () => listAsg(auth, clusterID, undefined, baseUrl),
          data => readAsgRows(data).some(r => r.asgID === asgID),
          opts, executed, remaining, { asgID },
        )
        if (stop) return stop
        writeApprunDedicatedRecordFs(projectDir, { asgID: null })
        executed.push(`オートスケーリンググループ『${asgID}』を削除しました（消えたことを確認）`)
        return null
      }
      return {
        ok: false, executed,
        message: `オートスケーリンググループの削除に失敗しました。残っています＝課金が続きます: ${res.message}`,
        remaining,
      }
    }
    if (res.status === 409) {
      const title = readApiErrorTitle(safeParseJson(res.detail))
      if (title && title.includes('Load Balancers')) {
        const listRes = await listLoadBalancers(auth, clusterID, asgID, undefined, baseUrl)
        if (!listRes.ok) {
          return {
            ok: false, executed,
            message: `オートスケーリンググループの削除に失敗しました（ロードバランサが残っています）。ロードバランサの一覧でも確かめられませんでした: ${listRes.message}`,
            remaining,
          }
        }
        const found = readLoadBalancerRows(listRes.data)[0]
        if (!found) continue // 一覧には無い（レースで解消したとみられる）。ASGのDELETEを再試行する。
        writeApprunDedicatedRecordFs(projectDir, { loadBalancerID: found.loadBalancerID })
        executed.push(`ロードバランサ『${found.loadBalancerID}』がまだ残っていたため、記録に戻しました`)
        if (found.deleting === true) {
          const stop = await waitOrStop(
            'ロードバランサ',
            () => listLoadBalancers(auth, clusterID, asgID, undefined, baseUrl),
            data => readLoadBalancerRows(data).some(r => r.loadBalancerID === found.loadBalancerID),
            opts, executed, { loadBalancerID: found.loadBalancerID, asgID, clusterID }, { loadBalancerID: found.loadBalancerID },
          )
          if (stop) return stop
          writeApprunDedicatedRecordFs(projectDir, { loadBalancerID: null })
          executed.push(`ロードバランサ『${found.loadBalancerID}』を削除しました（消えたことを確認）`)
          continue // LBが消えた。ASGのDELETEを再試行する。
        }
        return {
          ok: false, executed,
          message: 'ロードバランサが残っているため削除できません。⑥をもう一度押すと、そこから削除します',
          remaining: { loadBalancerID: found.loadBalancerID, asgID, clusterID },
        }
      }
      return {
        ok: false, executed,
        message: `オートスケーリンググループの削除に失敗しました。残っています＝課金が続きます: ${res.message}`,
        remaining,
      }
    }
    return {
      ok: false, executed,
      message: `オートスケーリンググループの削除に失敗しました。残っています＝課金が続きます: ${res.message}`,
      remaining,
    }
  }
}

/**
 * クラスタを削除し、一覧から消えるまで待つ。成功（次へ進んでよい）なら null。
 * **409（本文の title に `Auto Scaling Group` を含む）**＝ASGがまだ残っているときは、ASGの
 * 一覧を引き直して見つかったIDを記録に戻し、`deleting:true` なら消えるまで待ってから
 * クラスタのDELETEを再試行する（attemptDeleteAsg と同じ形。#39）。
 * クラスタ一覧には `deleting` が無い（原本の形・5-8）ため、404で一覧にまだあれば
 * （新しい「deleting:trueなら待つ」枝には入らず）従来どおり「残っています」で止める。
 */
async function attemptDeleteCluster(
  auth: CloudCredentials, projectDir: string, clusterID: string,
  opts: TeardownFlowOpts, baseUrl: string | undefined, executed: string[],
): Promise<TeardownFlowResult | null> {
  const remaining = { clusterID }
  for (let attempt = 0; ; attempt++) {
    if (attempt >= 5) {
      return {
        ok: false, executed,
        message: 'クラスタの削除を繰り返し試みましたが完了しませんでした。コントロールパネルで確認してください。',
        remaining,
      }
    }
    const res = await deleteCluster(auth, clusterID, baseUrl)
    if (res.ok) {
      const stop = await waitOrStop(
        'クラスタ',
        () => listClusters(auth, baseUrl),
        data => readClusterRows(data).some(r => r.clusterID === clusterID),
        opts, executed, remaining, { clusterID },
      )
      if (stop) return stop
      writeApprunDedicatedRecordFs(projectDir, { clusterID: null, name: null, zone: null, workerServiceClassPath: null, lbServiceClassPath: null, createdAt: null })
      executed.push(`クラスタ『${clusterID}』を削除しました（消えたことを確認）`)
      return null
    }
    if (res.status === 404) {
      const listRes = await listClusters(auth, baseUrl)
      if (!listRes.ok) {
        return {
          ok: false, executed,
          message: `クラスタの削除に失敗しました（404）。一覧でも確かめられませんでした＝課金が続きます: ${listRes.message}`,
          remaining,
        }
      }
      const present = readClusterRows(listRes.data).some(r => r.clusterID === clusterID)
      if (present) {
        return {
          ok: false, executed,
          message: `クラスタの削除に失敗しました。残っています＝課金が続きます: ${res.message}`,
          remaining,
        }
      }
      writeApprunDedicatedRecordFs(projectDir, { clusterID: null, name: null, zone: null, workerServiceClassPath: null, lbServiceClassPath: null, createdAt: null })
      executed.push(`クラスタ『${clusterID}』は既に存在しませんでした（記録から外しました）`)
      return null
    }
    if (res.status === 409) {
      const title = readApiErrorTitle(safeParseJson(res.detail))
      if (title && title.includes('Auto Scaling Group')) {
        const listRes = await listAsg(auth, clusterID, undefined, baseUrl)
        if (!listRes.ok) {
          return {
            ok: false, executed,
            message: `クラスタの削除に失敗しました（オートスケーリンググループが残っています）。一覧でも確かめられませんでした: ${listRes.message}`,
            remaining,
          }
        }
        const found = readAsgRows(listRes.data)[0]
        if (!found) continue // 一覧には無い（レースで解消したとみられる）。クラスタのDELETEを再試行する。
        writeApprunDedicatedRecordFs(projectDir, { asgID: found.asgID })
        executed.push(`オートスケーリンググループ『${found.asgID}』がまだ残っていたため、記録に戻しました`)
        if (found.deleting === true) {
          const stop = await waitOrStop(
            'オートスケーリンググループ',
            () => listAsg(auth, clusterID, undefined, baseUrl),
            data => readAsgRows(data).some(r => r.asgID === found.asgID),
            opts, executed, { asgID: found.asgID, clusterID }, { asgID: found.asgID },
          )
          if (stop) return stop
          writeApprunDedicatedRecordFs(projectDir, { asgID: null })
          executed.push(`オートスケーリンググループ『${found.asgID}』を削除しました（消えたことを確認）`)
          continue // ASGが消えた。クラスタのDELETEを再試行する。
        }
        return {
          ok: false, executed,
          message: 'オートスケーリンググループが残っているため削除できません。⑥をもう一度押すと、そこから削除します',
          remaining: { asgID: found.asgID, clusterID },
        }
      }
      return {
        ok: false, executed,
        message: `クラスタの削除に失敗しました。残っています＝課金が続きます: ${res.message}`,
        remaining,
      }
    }
    return {
      ok: false, executed,
      message: `クラスタの削除に失敗しました。残っています＝課金が続きます: ${res.message}`,
      remaining,
    }
  }
}

/**
 * 記録にある ID だけを、**LB → ASG → クラスタ の順**で削除する（5-7・逆順）。
 * 記録に無い資源は触らない。ある段が失敗したら、そこで止める（それより下＝クラスタ側は
 * 触らない——LBが残ったままASGを消せる保証がAPI仕様上どこにも無いため、5-7の順序を厳密に守る）。
 * **各段は、DELETEの応答（204/404+deleting:true）を受け取ったあと、一覧からIDが完全に
 * 消えるのを確認してから次の段へ進む**（waitUntilGone・#39）。消せたものは記録から外す
 * （＝nullに戻す）。消せなかった・待ち切れなかったものは記録に残す。
 *
 * **`opts.confirmed !== true` なら、API を一切呼ばずに中止する**（2026-09-10 レビューの修理・A・
 * 掟10の3点セット）。
 *
 * 各段の内訳は `attemptDeleteLoadBalancer` / `attemptDeleteAsg` / `attemptDeleteCluster` に
 * 分けてある（204→待ち／404→一覧で確認→deleting:trueなら待ち・無ければ記録から外す／
 * 409→下位資源を記録に戻して待つか止める、をそれぞれ担う）。
 */
export async function teardownFlow(
  auth: CloudCredentials, projectDir: string, opts: TeardownFlowOpts, baseUrl?: string,
): Promise<TeardownFlowResult> {
  const record = readApprunDedicatedFs(projectDir)
  const executed: string[] = []

  const hasCluster = !!record.clusterID
  const hasAsg = !!record.asgID
  const hasLb = !!record.loadBalancerID

  // 確認ダイアログを通ったか。**ここより先で fetch を一切呼ばない。**
  if (opts.confirmed !== true) {
    return {
      ok: false, executed: [], message: '確認ダイアログを通っていません',
      remaining: {
        loadBalancerID: record.loadBalancerID ?? undefined,
        asgID: record.asgID ?? undefined,
        clusterID: record.clusterID ?? undefined,
      },
    }
  }

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
    const stop = await attemptDeleteLoadBalancer(
      auth, projectDir, record.clusterID as string, record.asgID as string, record.loadBalancerID as string,
      opts, baseUrl, executed,
    )
    if (stop) return stop
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
    const stop = await attemptDeleteAsg(auth, projectDir, record.clusterID as string, record.asgID as string, opts, baseUrl, executed)
    if (stop) return stop
  }

  // ── クラスタ ──
  if (hasCluster) {
    const stop = await attemptDeleteCluster(auth, projectDir, record.clusterID as string, opts, baseUrl, executed)
    if (stop) return stop
  }

  return {
    ok: true, executed,
    message: '削除の要求はすべて受け付けられ、一覧から消えたことを確認しました。コントロールパネルでもご確認ください。',
    remaining: {},
  }
}

export type { ApprunDedicatedRecord }
