// apprunDedicatedApply.ts — さくらのAppRun 専有型（roadmap #23）段階(2)「作る」＋(4)「破棄」の段取り。
//
// ※ src/main/cloud/{planner,apply,state}.ts を下敷きにしている（複製ではない）:
//   - orderForApply と同じ考え方で「依存の順序」を明示的に固定する（2026-08-14「作る順番は
//     機能の一部」）。作る順はクラスタ→ASG→LB、壊す順はその逆（LB→ASG→クラスタ・5-7）。
//   - stateToSave と同じ考え方で「実際に何が起きたか」を必ず記録する（2026-08-14「失敗しても、
//     途中まで起きたことは記録する」）。各段が成功した直後に publishMetaFs へ書く。
//
// **この段では作らない・扱わない**: `/applications` `/applications/{id}/versions`（roadmap #23の
// (5)独自ドメイン相当）。ここで扱うのはクラスタ・ASG・ロードバランサの3資源のみ
// （docs/apprun-dedicated-plan.md 5-7 の常時課金3点）。
//
// electron 非依存ではない: publishMetaFs.ts 経由で `.sakuraide.json` を直接読み書きする
// （publishMetaFs.ts 自体は fs/path のみに依存し electron を import しないため、
// vitest から実ファイルで直接テストできる。tests/publishMetaFs.test.ts と同じ方針）。

import type { CloudCredentials } from './auth'
import {
  getLimits, listClusters, createCluster, getCluster, deleteCluster,
  createAsg, getAsg, deleteAsg, createLoadBalancer, deleteLoadBalancer,
  listAsg, listLoadBalancers, listApplications, deleteApplication,
  getApplication, updateApplication, listApplicationContainers, type ApprunDedicatedResult,
} from './apprunDedicated'
import { readApprunDedicatedFs, writeApprunDedicatedRecordFs } from '../publishMetaFs'
import type { ApprunDedicatedRecord } from '../../shared/publishMeta'
import {
  readLimits, readClusters, readClusterId, readAsgId, readLoadBalancerId,
  readClusterRows, readClusterIDs, readAsgRows, readAsgIDs, readAsgIdRows, readLoadBalancerRows, readLoadBalancerIDs, readLoadBalancerIdRows,
  readApplicationRows, readApplicationIDs, readApplication, readApiErrorTitle,
  readRunningContainerCount,
} from '../../shared/apprunDedicatedShapes'
import {
  buildActiveVersionBody, appDeleteRetryable, appDeleteNeedsReDeactivation, appDeleteExhaustedMessage,
  appDeleteTransientFailure, appDeleteTransientExhaustedMessage, lowerResourceExhaustedMessage,
} from '../../shared/apprunDedicatedApp'
// サービスプリンシパルIDの形（12桁の数字）の唯一の定義。画面（手順2の「形は合っています」）・候補集めと同じものを使う
// （以前はここに `/^\d{12}$/` を別に持っていて、画面は「12文字」で通すのにここで拒否される食い違いがあった・2026-10-06）。
import { isServicePrincipalId } from '../../shared/servicePrincipalCandidates'
// 段の内部名（どこにどれくらい時間がかかったかを記録するための名前。定義は shared/stageTiming.ts の1か所・2026-10-07）。
import { STAGE, type StageMark, UNMEASURED } from '../../shared/stageTiming'

// ── 入力の形 ──────────────────────────────────────────────────────────

/** クラスタの公開ポート（5-2）。5950-5959 は予約で指定できない（呼び出し側＝画面が弾く）。 */
export type ApprunDedicatedPort = { port: number; protocol: 'http' | 'https' }

/** createClusterFlow への入力（画面の手順5の入力項目そのまま・5-2/5-5/5-6）。 */
export type ApprunDedicatedClusterSpec = {
  /** クラスタ・ASG・LB に共通で使う名前（1〜20文字・英数字と `_` `-`）。 */
  name: string
  ports: ApprunDedicatedPort[]
  servicePrincipalID: string
  // F-1（2026-09-16）: Let's Encrypt メールの欄はここから外した（手順5のフォームから削除・手順8に一本化）。
  // 手順8の経路（main/ipc/apprunDedicated.ts の AppPublishInput）はそのまま残る。
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
  if (typeof spec.servicePrincipalID !== 'string' || !isServicePrincipalId(spec.servicePrincipalID)) {
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
  opts: {
    confirmed: boolean
    /**
     * 段の切り替わりを知らせる口（2026-10-07・どこにどれくらい時間がかかったかの記録）。**画面に出す文は変えない**
     * ——作成は進み具合の文を1つしか出さないので、文とは別に段だけを渡す。作る資源ごと（クラスタ → ASG → LB）に1回ずつ。
     * （作成は `ok:true` になるまで全部の資源を作って確かめるので、`unmeasured` の印を付ける場面は無い。）
     */
    onStage?: (stage: string, mark?: StageMark) => void
  },
  baseUrl?: string,
): Promise<CreateClusterFlowResult> {
  // 0. 確認ダイアログを通ったか。**ここより先で fetch を一切呼ばない。**
  if (opts.confirmed !== true) {
    return { ok: false, stage: 'consent', message: '確認ダイアログを通っていません' }
  }

  // 1. 同意の確認（費用への同意＝consentedAt。confirmedとは別の意味）。
  const record = readApprunDedicatedFs(projectDir)
  if (!record.consentedAt) {
    return { ok: false, stage: 'consent', message: '費用の同意が記録されていません。手順4で同意してから作成してください。' }
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
      message: `このプロジェクトには作られたものの記録があります（クラスタID『${record.clusterID ?? '(記録なし)'}』）。手順6で削除してから作成してください。`,
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

  // 2. 上限の確認。（ここから最初の段。上限の確認も、クラスタを作る段の時間に含める）
  opts.onStage?.(STAGE.createCluster)
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
    // A（2026-09-17）: 応答の形が想定と違いIDを読めなかった。POSTは2xxで返っているため、
    // 上の「!ok」の枝（応答が取れなかった場合）より存在は確実——同じく一覧を名前で探し、
    // 見つかれば記録する。記録が無いままだと専有型には取り込みの導線が無く、
    // このクラスタはKotoから永久に破棄できなくなる。
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
        message: `クラスタを作成しましたが、応答からIDを取り出せませんでした。同じ名前のクラスタが見つかったので記録しました（ID『${found.clusterID}』）。`,
        clusterID: found.clusterID,
      }
    }
    return {
      ok: false, stage: 'cluster-create',
      message: `クラスタを作成しましたが、応答からIDを取り出せませんでした。作成の要求は通っているため、課金が始まっている可能性があります。さくらのクラウドのコントロールパネルで『${spec.name}』を確認し、不要なら削除してください。`,
    }
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
  opts.onStage?.(STAGE.createAsg)
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
      // A（2026-09-17）: クラスタは既にclusterIDとして記録済み（手順6の節は出る）。ここは
      // 名前探しを足さず、課金への言及だけを加える（経路を増やさないほうが安全。仕様書参照）。
      message: `オートスケーリンググループを作成しましたが、応答からIDを取り出せませんでした。作成の要求は通っているため、課金が始まっている可能性があります。さくらのクラウドのコントロールパネルで『${spec.name}』を確認し、不要なら削除してください。`,
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
  opts.onStage?.(STAGE.createLb)
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
      // A（2026-09-17）: クラスタ・ASGは既に記録済み（手順6の節は出る）。ここも名前探しは足さず、
      // 課金への言及だけを加える（経路を増やさないほうが安全。仕様書参照）。
      message: `ロードバランサを作成しましたが、応答からIDを取り出せませんでした。作成の要求は通っているため、課金が始まっている可能性があります。さくらのクラウドのコントロールパネルで『${spec.name}』を確認し、不要なら削除してください。`,
      clusterID, asgID,
    }
  }
  const lbWriteStop = recordOrStop(projectDir, { loadBalancerID }, 'ロードバランサ', loadBalancerID, { clusterID, asgID, loadBalancerID })
  if (lbWriteStop) return lbWriteStop

  // 3-f. 実在確認（M）。LBには単体取得APIが無いため、一覧にIDがあるかで確かめる
  // （クラスタ・ASGの verify と同じ扱いに揃える。記録は残したまま——POSTは成功しているため）。
  // M-1（2026-09-17）: 在否の判定に名前は要らない。name の無い行も拾う readLoadBalancerIDs を使う
  // （readLoadBalancerRows は名前探し用で、name の無い行を捨てるため「消えた」誤判定を招く）。
  const verifyLbListRes = await listLoadBalancers(auth, clusterID, asgID, undefined, baseUrl)
  const lbFound = verifyLbListRes.ok && readLoadBalancerIDs(verifyLbListRes.data).includes(loadBalancerID)
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
// 資源は一覧に `deleting:true` のまま数分〜十数分残り続け、その間 (1)削除中のIDへ再度
// DELETE すると 404 (2)まだ残っている下位資源（LB）を抱えたまま上位（ASG）を消そうとすると
// 409（title に `Cannot delete Auto Scaling Group because it has associated Load Balancers: <id>`）
// が返る。v0.6.16 の旧実装は 204/404 の直後に一覧を1回だけ見て「deleting:true なら消えた扱い」
// にしていたため、(1) ASG が 409 で止まり (2) LB の ID が記録から外れて Koto から押し直せない、
// が同時に起きた（CLAUDE.md 掟10「削除の 204 は『消えた』ではない」）。
// → 各段は **一覧から ID が完全に消えるまで待ってから** 次の段へ進む（waitUntilGone）。
//
// ── C（D-19・2026-09-16）: 消えた資源の IP を記録に残さない ───────────────────────────
// 記録の `lbAddresses` は「いまのクラスタのロードバランサの IP」である。ロードバランサや
// クラスタが消えれば、**その IP はもう存在しない**——残しておくと、次に作ったクラスタの
// 画面（手順8）が**前のクラスタの IP を「DNS の A レコード」として出す**ことになり、利用者は
// 間違った先へ DNS を向ける。アプリの段（attemptDeleteApplication の clearAppRecord）は
// 既に `lbAddresses: null` を含んでいたが、**アプリを公開していないプロジェクト**（手順5で
// クラスタだけ作り、「🔄 IP を再取得」を押した場合）はその段を通らないため、
// **ロードバランサの段とクラスタの段でも消す**（どの道から破棄しても確実に消えるように）。

export type TeardownFlowResult = {
  /** 記録にあったものが全部消せたか。1つでも残れば false。 */
  ok: boolean
  /** 起きたことの説明（画面向け。削除の完了だけでなく、記録への書き戻し等も含む）。 */
  executed: string[]
  message: string
  /**
   * 消せずに残ったID（無ければキー自体が無い＝最初から記録に無かった/消せた）。
   *
   * `storageBucket` は保存場所（オブジェクトストレージ）だけ毛色が違う——IDではなくバケット名で、
   * 立てるのは `ipc/apprunDedicatedTeardown.ts` の保存場所の片づけ（2026-09-24 検分の指摘5）。
   * **ここが空のまま ok:false を返すと、画面の「残っている間は課金が続きます」の下に
   * 1件も出ない**＝何が残っているのか分からないまま放置させることになる。
   */
  remaining: { applicationID?: string; loadBalancerID?: string; asgID?: string; clusterID?: string; storageBucket?: string }
  /**
   * **計算資源（アプリ・LB・ASG・クラスタ）は消し切れたか**（2026-09-24 検分の指摘4・9・13）。
   *
   * `ok` は保存場所の片づけまで含めた総合判定なので、「アプリは消えたが保存場所だけ失敗」で
   * false になる。そのとき、アプリが消えたことは `appDeleted` が言う（結果欄の管理画面への導線などが使う）。
   * **公開記録（📡 の行）を消すかには使わない**（D1=1・0.6.22 段階3B-1。消すのは保存場所まで片づいた `ok` の回だけ。
   * 保存場所だけ残った回は行を残し、📡 から押し直せる）。
   * 立てるのは保存場所の片づけ（teardownFlow 自身は `ok` と同じ意味なので触らない）。
   */
  appDeleted?: boolean
  /**
   * 削除は受け付けられた（204、または404+`deleting:true`）が、**待ち切れず（timeout）に
   * 止まった**ときだけ立つ（#39）。画面はこれを見て「削除中です。しばらくして手順6をもう一度
   * 押してください」の黄色い注意を出す（残っています＝失敗、の赤い表示とは区別する）。
   */
  inProgress?: { applicationID?: string; loadBalancerID?: string; asgID?: string; clusterID?: string }
  /**
   * **片づけたのに、バケットごとは消さなかった**保存場所（利用者が自分で置いたファイルがある・ほかのプロジェクトが
   * 使っている）の名前。先頭の1件。**残れば月額も続く**（共用型の `cloud:teardown` の `keptBucketName` と同じ事実）。
   * `remaining.storageBucket`（**片づけに失敗して**残ったもの）とは別。立てるのは `ipc/apprunDedicatedTeardown.ts` の保存場所の片づけ。
   * これが無いと、この回は ok:true のまま executed に「残します（月額の課金は続きます）」の1行が入るだけで、警告にならなかった。
   */
  keptBucketName?: string
  /** 同じ事実の全件（複数の保存場所を片づけたとき、名前が出なかった分の月額が黙って続かないように）。 */
  keptBucketNames?: string[]
  /** 残した保存場所のうち、ほかのプロジェクトも使っているため残したもの（`teardownPlanFor` の `keptReasons`）。結果の警告が「消すと、そのプロジェクトのデータも消える」と言う材料。 */
  keptBucketsUsedByOthers?: string[]
  /** 残した保存場所のうち、Koto が作ったのではないファイルがあるため残したもの。 */
  keptBucketsWithOwnFiles?: string[]
  /**
   * 保存場所が2件以上で途中で止まった回の、**残りの全件**（HANAMII の `remainingBuckets` と同じ。0.6.22 段階3B-2・立てるのは
   * `ipc/apprunDedicatedTeardown.ts` の保存場所の片づけ。3点セット〔main・preload・global.d.ts〕は同じ形）。
   * 先頭は止まった1件で、`remaining.storageBucket` と同じ（そちらは止まった1件のまま）。無い回は全部片づいた回・保存場所に触れなかった回。
   */
  remainingBuckets?: string[]
}

/**
 * 手順6の破棄のあと、公開記録（publish.targets['sakura-apprun-dedicated']＝📡 の行）を片づけるか（純関数）。
 *
 * **判断の基準は「保存場所まで片づいたか」**（`ok`。D1=1・0.6.22 段階3B-1）。アプリが消えても保存場所だけ残った回
 * （`ok:false`・`appDeleted:true`）は、**行を残す**＝📡 の行の「🗑 削除」を押し直すと、残った保存場所だけを削除する
 * （HANAMII・共用型と同じ）。以前は `appDeleted ?? ok` で、保存場所だけ残っても行が消え、プロジェクトを開いて
 * 手順6から消すしかなかった。
 *
 * **「消す公開記録があったか」は、破棄の前に公開記録（行）があったか（`hadPublishRecord`）で決める**
 * （2026-10-08 検分。以前は「破棄前の記録に applicationID があったか」で決めていた）。applicationID は、アプリが消えた
 * 時点で記録から外れる。だから途中で止まった削除（ロードバランサの待ち切れなど。実測約9分に対して待ちの上限は約10分で、
 * 現実に起きる）を押し直して全部消せても、2回目は applicationID が無く、行が永久に残った（幽霊の行）。
 * 行そのものがあったかを見れば、1回目で止まった行も、資源の記録が失われた幽霊の行も、全部消せた回に消える。
 * 途中で止まった回（`ok:false`）は、アプリが消えていても消えていなくても行を残す＝押し直す 🗑 を残す。
 *
 * **公開記録を消すのは main のこの1か所だけ**（画面は消さない）。以前は画面だけが破棄の後始末として公開記録を
 * 消していたが、手順6のダイアログを閉じると窓が持つ後始末は走らず、破棄は最後まで進むのに存在しないアプリの
 * 公開記録が残った（2026-09-29 に main へ移した）。2026-10-08 に画面側の規則（shouldClearPublishRecord）も消し、
 * 手順6からも 📡 の 🗑 からも、この規則だけが働く（tests/ops-dedicated-teardown.test.ts が真理値表と
 * 「画面は消さない」を固定する）。
 */
export function shouldForgetPublishRecord(s: {
  hadPublishRecord: boolean
  result: { ok: boolean; appDeleted?: boolean } | null | undefined
}): boolean {
  if (!s.hadPublishRecord || !s.result) return false
  // `appDeleted` は見ない（D1=1）。`ok === true` だけ: 計算資源も保存場所も片づいた回。
  return s.result.ok === true
}

export type TeardownFlowOpts = {
  confirmed: boolean
  /**
   * 進捗メッセージ（「〜の削除を待っています（N分経過）…」を30秒ごとに1回。ただしアプリの削除を400で断られて
   * 待ち直すとき、ASG・クラスタの削除を409で断られて下位の反映を待ち直すときは、待つたびに＝`deleteRetryIntervalMs`
   * （既定15秒）おきに出る）。画面へ流すのに使う（IPCハンドラが `apprunDedicated:teardown-progress` で event.sender.send する）。省略可。
   */
  progress?: (msg: string) => void
  /** waitUntilGone のポーリング間隔（既定5秒）。テストで短縮せず、代わりに `sleep` を偽物にする。 */
  intervalMs?: number
  /**
   * waitUntilGone の最長待ち時間（既定10分）。アプリの削除を400で断られたときのやり直しの合計の上限も、これと同じ値で数える
   * （その合計には、やり直しの中の無効化の確認の待ち・コンテナの待ちも入る。それぞれの待ちは「合計の残り」までしか待たない）。
   * ASG・クラスタの削除を409で断られ、下位の一覧が空のときの反映待ちの合計の上限も同じ（2026-10-08）。
   */
  timeoutMs?: number
  /**
   * アプリの削除（DELETE）が「まだコンテナが止まっていない」などの400（や、待ち直しの途中の 5xx・通信の切れ）で断られたとき、
   * ASG・クラスタの削除が409で断られて下位の一覧が空のときに、**やり直す前に待つ間隔**（既定15秒）。
   * 下限は1秒（0以下・数でない値を渡しても、休みなく DELETE を打ち続けない）。
   * テストでは短縮せず、代わりに `sleep` を偽物にする（waitUntilGone と同じ作法）。
   */
  deleteRetryIntervalMs?: number
  /**
   * waitUntilGone がポーリングの合間に待つのに使う関数（既定は実際の setTimeout）。アプリの削除を400で断られたときの
   * 待ち直し（`deleteRetryIntervalMs`）と、その中の無効化の確認・コンテナの待ち、ASG・クラスタの409の反映待ちにも、同じ関数を使う。
   * **テストではここへ即時に解決する偽物を渡し、実際には待たずにループを回す**（#39のテスト方針）。
   */
  sleep?: (ms: number) => Promise<void>
  /**
   * 段の切り替わりを知らせる口（2026-10-07・どこにどれくらい時間がかかったかの記録）。**画面に出す文は変えない**。
   * アプリ → LB → ASG → クラスタ の各段の頭で呼ぶ（待ちがほとんどの時間を占める）。409 の回復で下位の資源を待ち直すときは、
   * その資源の段へ移って、戻ったらもとの段へ戻る（同じ段に戻ったときは時間を足し合わせる）。
   *
   * **第2引数 `{ unmeasured: true }` は「この段の時間は、ふつうにやったらこれだけかかる、の測定になっていない」の印**
   * （shared/stageTiming.ts の `StageMark`。時間は結果に載せるが保存しない）。付ける場面（2026-10-07 検分の指摘）:
   *   ・DELETE が 404 で、一覧に `deleting:true` で残っていた＝**前回の続き**（前回は待ち切れず止まった）。測れたのは残りの待ちだけ
   *   ・DELETE が 404 で、一覧にも無かった＝**既に消えていた**（ほぼ 0 ミリ秒）
   *   ・409 の回復で、すでに削除中だった下位の資源を待ち直した（残りの待ちだけ）
   *   ・アプリの段で、コンテナが止まるのを待ち切れず時間切れでそのまま進んだ（上限の待ちを含む）
   *   ・アプリの段で、アプリがさくら側にすでに無かった（取得・無効化が 404 → DELETE も 404 で、一覧にも無い）。上の「既に消えていた」と同じ
   *   ・ASG・クラスタの 409 で、下位の一覧が空のまま**反映されるのを待った**（ASG の段／クラスタの段。反映のずれの待ちは、ふつうの時間ではない・2026-10-08 検分 J）
   *   ・アプリの削除の待ち直しの途中で、DELETE が 5xx・通信の切れになり**障害が直るのを待った**（アプリの段・2026-10-08 検分 L）
   *
   * **付けない場面**: アプリの削除を 400（まだコンテナが止まっていない・有効なバージョンが残っている）で断られて、待ち直したとき。
   * コンテナが止まるのを待つのは「アプリの削除」にふつうに含まれる時間なので、待ち直しだけでは印を付けない。待ち直しが合計の上限
   * （`timeoutMs`）まで続いて止まった回は ok:false で終わり、失敗した操作の時間は保存されない（projectOps.ts）。
   */
  onStage?: (stage: string, mark?: StageMark) => void
}

export type WaitUntilGoneResult = { ok: true } | { ok: false; reason: 'timeout' }

/** 「この段の時間は保存しない」の印（`TeardownFlowOpts.onStage` の第2引数。理由は shared/stageTiming.ts の `StageMark`）。 */
// UNMEASURED は shared/stageTiming.ts の1か所で定義（掟10）

const WAIT_UNTIL_GONE_DEFAULT_INTERVAL_MS = 5000
const WAIT_UNTIL_GONE_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000 // 10分
const PROGRESS_INTERVAL_MS = 30 * 1000 // 30秒ごとに進捗を出す
/** アプリの削除が400（コンテナがまだ止まっていない等）で断られたとき、やり直すまで待つ既定の間隔。 */
const APP_DELETE_RETRY_DEFAULT_INTERVAL_MS = 15 * 1000
/**
 * 待ち直しの間隔の下限。0以下・NaN を渡されても、合計の待ち時間が増えずに上限へ届かないまま DELETE を休みなく打ち続ける
 * （お金・破壊に関わる処理が無制限になる）ことのないようにする。
 */
const APP_DELETE_RETRY_MIN_INTERVAL_MS = 1000

/** 実際に待つ関数（`opts.sleep` が無いときの既定）。 */
const realSleep = (ms: number): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, ms))

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
  const sleep = opts.sleep ?? realSleep
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

/** ロードバランサを待つときの資源名。待ち始めにも一文を出す相手（30秒後の最初の進捗まで、無言の時間を作らない）を見分けるのに使う。 */
const LB_WAIT_LABEL = 'ロードバランサ'

/**
 * 削除待ちの進み具合の一文（純関数）。`elapsedMs` が 0 なら経過は書かない（待ち始めの一文）。
 *
 * **文に目安は入れない**（2026-10-07 作者の決定）。以前は LB の待ちだけ「実測ではおよそ9分でした（目安です）」を文に
 * 焼き込んでいたが、目安は**段の内部名から引く仕組み**（shared/stageEstimate.ts の estimateForStage。この Mac で測れたら
 * 最近5回の中央値・それまでは開発時の実測）に一本化し、画面が待っている段の横に出す（同じ数字を2か所に持たない）。
 */
export function deleteWaitProgressMessage(label: string, elapsedMs: number): string {
  const elapsed = elapsedMs > 0 ? `（${formatElapsedMinutes(elapsedMs)}）` : ''
  return `${label}の削除を待っています${elapsed}…`
}

/** 待ち直しの進み具合に添える「（N分経過）」。30秒に満たないうちは書かない（15秒おきに「1分経過」と出すと、実際より長く待ったように見えるため）。 */
function waitElapsedSuffix(elapsedMs: number): string {
  return elapsedMs >= PROGRESS_INTERVAL_MS ? `（${formatElapsedMinutes(elapsedMs)}）` : ''
}

/**
 * アプリの削除を400「currently running」で断られて、コンテナが止まるのを待つときの進み具合の一文（純関数）。
 * 言い方は `deleteWaitProgressMessage`（ロードバランサの待ち）に揃える。`elapsedMs` が30秒に満たないうちは経過を書かない。
 */
export function appStopWaitProgressMessage(elapsedMs: number): string {
  return `アプリのコンテナが止まるのを待っています${waitElapsedSuffix(elapsedMs)}…`
}

/**
 * アプリの削除を400「active version」で断られて、**無効化が反映されるのを**待つときの進み具合の一文（純関数・2026-10-08 検分 K）。
 * 待っている理由はコンテナではない（有効なバージョンがまだ付いて見える）ので、`appStopWaitProgressMessage`（コンテナ）とは別の文にする。
 * 使い分けは `appDeleteNeedsReDeactivation(title)`（「active version」のときだけ true）。
 */
export function appDeactivateWaitProgressMessage(elapsedMs: number): string {
  return `アプリの無効化が反映されるのを待っています${waitElapsedSuffix(elapsedMs)}…`
}

/**
 * アプリの削除の要求（DELETE）が 5xx・通信の切れで通らなかったため、待ってからやり直すときの進み具合の一文（純関数・2026-10-08 検分 L）。
 */
export function appDeleteTransientWaitProgressMessage(elapsedMs: number): string {
  return `アプリの削除の要求が通らなかったため、待ってからやり直しています${waitElapsedSuffix(elapsedMs)}…`
}

/**
 * ASG・クラスタの削除を 409 で断られたのに、下位（ロードバランサ／オートスケーリンググループ）の一覧が空のとき——
 * 一覧には出ていないが、削除する側にはまだ残って見えている——に、**反映されるのを**待つ進み具合の一文（純関数・2026-10-08 検分 J）。
 * `lowerLabel` は待っている相手の名前（「ロードバランサ」「オートスケーリンググループ」）。
 */
export function lowerResourceSettleWaitProgressMessage(lowerLabel: string, elapsedMs: number): string {
  return `${lowerLabel}の削除が反映されるのを待っています${waitElapsedSuffix(elapsedMs)}…`
}

/**
 * 「待ってからやり直す」ための時計（アプリの削除・ASG の削除・クラスタの削除が共有する。2026-10-08 検分 J）。
 *
 * アプリの削除（rc.7 の形）が最初に持っていたものを、ASG・クラスタの 409 の待ち直しでも同じ作法で使えるように切り出した:
 *   ・待ち間隔は `opts.deleteRetryIntervalMs`（既定15秒・下限1秒。数でない値は既定に戻す）。
 *   ・合計の上限は `opts.timeoutMs`（既定は waitUntilGone と同じ10分。数でない値は既定に戻す）。回数の上限は設けない
 *     （休みなく打ち直す形を残さない）。経過は実時間ではなく**待った回数 × 間隔**で数える（waitUntilGone と同じ。
 *     テストで sleep を偽物にすれば、実際には待たずに動きを確かめられる）。
 *   ・`countedSleep` は待った分を合算する。無効化の確認の待ち・コンテナの待ちも同じ `countedSleep` を使い、それぞれの待ちの上限は
 *     「合計の残り」（`optsNow()` が引き直す）にする——やり直しのたびに10分をまるごと使わせない。
 * 間隔・合計の上限が 0以下／NaN／Infinity でも、ループが終わらなくならないようにする（回数の上限を置かない作りの安全弁）。
 */
function makeRetryClock(opts: TeardownFlowOpts) {
  const requestedRetryMs = opts.deleteRetryIntervalMs
  const retryIntervalMs = typeof requestedRetryMs === 'number' && Number.isFinite(requestedRetryMs)
    ? Math.max(APP_DELETE_RETRY_MIN_INTERVAL_MS, requestedRetryMs)
    : APP_DELETE_RETRY_DEFAULT_INTERVAL_MS
  const totalTimeoutMs = typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs)
    ? Math.max(0, opts.timeoutMs)
    : WAIT_UNTIL_GONE_DEFAULT_TIMEOUT_MS
  const baseSleep = opts.sleep ?? realSleep
  let waitedMs = 0
  const countedSleep = async (ms: number): Promise<void> => { await baseSleep(ms); waitedMs += ms }
  return {
    retryIntervalMs,
    totalTimeoutMs,
    countedSleep,
    /** この段で待った合計（ms）。 */
    waited: () => waitedMs,
    /** 合計の上限に達したか。 */
    exhausted: () => waitedMs >= totalTimeoutMs,
    /** 合計の残り（ms）。 */
    remaining: () => Math.max(0, totalTimeoutMs - waitedMs),
    /** 無効化の確認の待ちなどへ渡す opts（sleep は合算つき・上限は合計の残り。呼び出しのたびに引き直す）。 */
    optsNow: (): TeardownFlowOpts => ({ ...opts, sleep: countedSleep, timeoutMs: Math.max(0, totalTimeoutMs - waitedMs) }),
  }
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
  // ロードバランサは待ち始めにも一文を出す（30秒後の最初の進捗まで、無言の時間を作らない）。
  if (label === LB_WAIT_LABEL) opts.progress?.(deleteWaitProgressMessage(label, 0))
  const wait = await waitUntilGone(listFn, isPresent, {
    intervalMs: opts.intervalMs,
    timeoutMs: opts.timeoutMs,
    sleep: opts.sleep,
    onProgress: ms => opts.progress?.(deleteWaitProgressMessage(label, ms)),
  })
  if (wait.ok) return null
  return {
    ok: false, executed,
    message: `${label}の削除を受け付けましたが、まだ削除中です。しばらくして手順6をもう一度押してください`,
    remaining, inProgress,
  }
}

/**
 * アプリケーションの削除は「有効なバージョン（activeVersion）を持ったままでは 400 になる」
 * （2026-09-16 実機実測: `{"status":400,"title":"Cannot delete application because it has
 * active version"}`）。DELETE より前に、有効なバージョンを無効化してから確かめる（この関数）。
 *
 * 1. `getApplication` でいまの `activeVersion` を見る。**取れなくても（応答が失敗・形が読めない）
 *    ここで止めない**——「分からない」を「無効化不要」に倒さず、無効化を試みてから戻る。
 * 2. `activeVersion` が null（＝確認できて、かつ無効）のときだけ何もせず ok:true で戻る。
 *    それ以外（数値だった・分からなかった）は `updateApplication` で null に更新する。
 *    更新そのものが失敗したら、生の応答を message に載せて ok:false。
 * 3. 更新後、`getApplication` を **`waitUntilGone` と同じ「消えるまで待つ」ループ**で引き直し、
 *    `activeVersion` が null になったことを確かめてから戻る（読めない／まだ非nullは「まだ残って
 *    いる」扱いで待ち続ける——確かめられないことを成功に倒さない）。待ち切ってもnullにならなければ
 *    ok:false。
 *
 * 成功したら `executed` に「バージョンを無効にしました」の1行を足す（呼ばれた＝実際に無効化の
 * 要求を出した、という意味。既に null だった場合は何も足さない）。
 */
async function ensureApplicationDeactivated(
  auth: CloudCredentials, applicationID: string, opts: TeardownFlowOpts, baseUrl: string | undefined, executed: string[],
): Promise<{ ok: true } | { ok: false; message: string }> {
  // 1. いまの activeVersion を見る。取れない・形が読めないときは undefined（＝分からない）。
  const getRes = await getApplication(auth, applicationID, baseUrl)
  // さくら側でアプリがすでに無い（GET が 404）なら、無効化はできないし要らない。DELETE へ進め、
  // **DELETE の 404 の枝（一覧で確かめてから記録を外す）に最終の判断を任せる**——「分からない」を
  // 成功に倒すのではない（一覧にまだあれば、そこで止まる）。ここで止めると、押し直しても先へ進めず、
  // クラスタなどを Koto から消せなくなる（課金を止められない・2026-10-07 検分）。
  if (!getRes.ok && getRes.status === 404) return { ok: true }
  const app = getRes.ok ? readApplication(getRes.data) : null
  const activeVersion: number | null | undefined = app ? app.activeVersion : undefined

  // 確認できて、かつ null（＝有効なバージョン無し）なら何もしない。
  if (activeVersion === null) return { ok: true }

  // 2. 無効化する（分からない場合も含めて試みる）。
  const updateRes = await updateApplication(auth, applicationID, buildActiveVersionBody(null), baseUrl)
  if (!updateRes.ok) {
    // GET と PUT のあいだに消えた（404）ときも同じ。判断は DELETE の 404 の枝（一覧で確かめる）に任せる
    if (updateRes.status === 404) return { ok: true }
    return {
      ok: false,
      message: `アプリケーションのバージョンを無効化できませんでした: ${updateRes.message}`,
    }
  }

  // 3. null になったことを確かめてから戻る。確かめられない・まだ非nullなら待ってから引き直す
  // （waitUntilGone と同じループ。isPresent＝「まだ有効なバージョンが残っているか」）。
  const wait = await waitUntilGone(
    () => getApplication(auth, applicationID, baseUrl),
    data => {
      const a = readApplication(data)
      return a ? a.activeVersion !== null : true
    },
    { intervalMs: opts.intervalMs, timeoutMs: opts.timeoutMs, sleep: opts.sleep },
  )
  if (!wait.ok) {
    return {
      ok: false,
      message: 'アプリケーションのバージョンを無効化しましたが、無効になったことを確認できませんでした（待機がタイムアウトしました）。コントロールパネルで確認してください。',
    }
  }

  executed.push(`アプリケーション『${applicationID}』のバージョンを無効にしました`)
  return { ok: true }
}

/**
 * アプリケーションを削除し、一覧から消えるまで待つ。成功（次へ進んでよい）なら null（D-2b-2）。
 * **LB/ASG/クラスタより先に呼ぶ**（12-2-7・12-1「破棄の順序はアプリ→LB→ASG→クラスタ」）。
 * `attemptDeleteLoadBalancer` と同じ作り（DELETE→ok なら一覧から消えるまで waitOrStop・
 * 404 は一覧で確かめる）。**ただし readApplicationRows には `deleting` が無い**（原本にこの
 * フィールドは無い・未確認。5-8 と同じ「推測でキーを足さない」方針）ため、404後の分岐は
 * `attemptDeleteCluster`（同じく `deleting` を持たない資源）と同じ形にする——一覧にまだ
 * あれば断定的な「残っています」で止め、無ければ消えた扱いにする。
 *
 * **DELETE の前に `ensureApplicationDeactivated` で有効なバージョンを無効化し、さらに
 * `listApplicationContainers` でコンテナが0件になるまで待つ**（2026-09-16 実機実測:
 * 有効なバージョンを持ったままでは 400「active version」、無効化直後はコンテナがまだ
 * 止まりきっていなくて 400「currently running」になる——どちらも「受け付けられた≠完了した」
 * という同じ形）。
 *
 * ── DELETE が 400 で断られたとき（2026-10-07 実機実測・0.6.20-rc.6）──────────────────────
 * 文言が `appDeleteRetryable`（`src/shared/apprunDedicatedApp.ts`・1か所）に当たる400なら、
 * **待ってからやり直す**。以前は「間を置かずに無効化からやり直し・最大3回」だったため、
 * コンテナの停止が終わっていないと**1〜2秒のうちに3回とも400になり、すぐ失敗した**
 * （📡 の🗑 を押してすぐ「コンテナの停止が終わりません」になった）。
 *   ・待ち間隔は `opts.deleteRetryIntervalMs`（既定15秒・下限1秒）。
 *   ・合計の上限は `opts.timeoutMs`（既定は waitUntilGone と同じ10分。数でない値は既定に戻す）。回数の上限は設けない
 *     （「3回で即失敗」の形を残さない）。経過は実時間ではなく**待った回数 × 間隔**で数える
 *     （waitUntilGone と同じ。テストで sleep を偽物にすれば、実際には待たずに動きを確かめられる）。
 *     コンテナの待ち・無効化の確認の待ちも同じ数え方で合算し、それぞれの待ちの上限は「合計の残り」にする
 *     （やり直しのたびに10分をまるごと使わせない）。
 *   ・待つたびに進み具合を出す。待っている理由で文を分ける（2026-10-08 検分 K）: 「currently running」は
 *     `appStopWaitProgressMessage`（コンテナが止まるのを待っています）、「active version」は `appDeactivateWaitProgressMessage`
 *     （アプリの無効化が反映されるのを待っています。理由はコンテナではない）。分け方は `appDeleteNeedsReDeactivation(title)`。
 *   ・「active version」で断られたら、**無効化からやり直す**（無効化がまだ効いていないことがあるため）。
 *     「currently running」のときは無効化を打ち直さず、待ってDELETEだけをやり直す
 *     （原本の updateApplication の説明は「activeVersion を null にすると非アクティブ状態になる」までで、
 *     すでに null のものへ繰り返し送って安全かは書かれていない。確かめられないものは打ち直さない）。
 *   ・待ち直しの途中で DELETE が 5xx・通信の切れで通らなかったときも、そこで止めずに待ち直す（合計の上限まで・2026-10-08 検分 L）。
 *     4xx（404・400 の既知のもの以外）は従来どおり止める。止まるときは「しばらくしてから、もう一度押してください」を添える
 *     （`appDeleteTransientExhaustedMessage`）。最初の DELETE が 5xx のときは、待ち直しの途中ではないので従来どおり止まる。
 *   ・上限に達したら止まる。**記録（applicationID）は消さない**＝もう一度押せば続きから進む。
 *     `inProgress` は立てない（`inProgress` は「削除を**受け付けられた**が待ち切れなかった」の意味で、
 *     画面の結果欄はそれを見ると黄色の「削除中です」に差し替えて生の応答を捨てる。ここは受け付けられていない）。
 *
 * **コンテナの一覧が読めないとき（取得の失敗・形が読めない）は、待たずにそのまま DELETE する**
 * （読めないことを理由に破棄を止めると、課金が止まらないほうへ倒れる）。**これは最初の確認だけでなく、待ちの中でも同じ向き**
 * （待っている間に読めなくなったら、そこで待ちをやめて DELETE へ進む。2026-10-08 検分の再指摘: 待ちの中だけ「読めない → まだ残っている」
 * だと、一部のノードの containersStats が null の応答で、コンテナが全部止まったあとも合計の上限まで待ち、続く DELETE が 400 でも
 * 待ち直しの余地が無く 1 回で止まった）。上の待ち直しは、一覧が読めるかどうかに関わらず効く（DELETE の400そのものを見て待つため）。
 *
 * **コンテナの停止待ちの判定**（2026-10-08 検分 I）: 動いているコンテナが0件になるまで待つ。「動いている」の数え方は
 * `readRunningContainerCount`（shared/apprunDedicatedShapes.ts。中で `countRunningContainers` を使う）で、止まっていると言い切れる
 * state（exited・dead）以外は動いている側。一覧の読み方（`readContainerStates`）を原本の形に直したのも 2026-10-08 で、それまでは
 * 本物の応答が常に「読めない」になり、この停止待ちは一度も効いていなかった。実際の応答はまだ誰も見ていない（読み方の注意は shapes を参照）。
 */
// ⚠️ export はテストが**アプリの段だけ**を取り出して確かめるため（tests/apprunDedicatedApply.test.ts の appStageOnly）。
// 本番の呼び出しは teardownFlow の1か所だけ（アプリだけを消す口は 2026-10-08 に廃止した）。
export async function attemptDeleteApplication(
  auth: CloudCredentials, projectDir: string, clusterID: string, applicationID: string,
  opts: TeardownFlowOpts, baseUrl: string | undefined, executed: string[],
): Promise<TeardownFlowResult | null> {
  const remaining = { applicationID }
  opts.onStage?.(STAGE.teardownApp)
  // 記録の app 系の欄をすべて null に戻す（D-2b-2 仕様書どおりの欄）。
  const clearAppRecord = () => writeApprunDedicatedRecordFs(projectDir, {
    applicationID: null, applicationName: null, activeVersion: null, imageRef: null,
    hosts: null, lbAddresses: null, appPublishedAt: null,
    appPort: null, appCpu: null, appMemory: null, appFixedScale: null,
  })

  // ── 待ちの数え方 ─────────────────────────────────────────────────────────────
  // この段で待った合計（ms）。sleep を1か所で包み、無効化の確認・コンテナの待ち・DELETE のやり直しの待ちをすべて合算する
  // （経過は回数 × 間隔。実時間は使わない）。ASG・クラスタの 409 の待ち直しも同じ時計（makeRetryClock）を使う。
  const clock = makeRetryClock(opts)

  // 無効化から始める。やり直しで「無効化し直す」のは、400の理由が「active version」のときだけ。
  let deactivateFirst = true
  // 待ち直しの途中か（400／一時的な失敗で、待ってから DELETE をやり直したことがあるか）。途中で DELETE が 5xx・通信の切れになったときの扱いを変える（L）。
  let retrying = false

  for (;;) {
    if (deactivateFirst) {
      // 無効化を試みる（既に null なら何もしない）。
      const deactivated = await ensureApplicationDeactivated(auth, applicationID, clock.optsNow(), baseUrl, executed)
      if (!deactivated.ok) {
        return { ok: false, executed, message: deactivated.message, remaining }
      }
      deactivateFirst = false
    }

    // ── D-10（2026-09-16 実機実測）: 無効化しても、動いているコンテナは即座には消えない ──────
    // 無効化の「要求が通った」ことと、コンテナが「実際に止まった」ことは別。間を置かずDELETEを
    // 撃つと、まだ動いているコンテナに当たって 400「currently running」になる。DELETEの前に、
    // コンテナが0件になるまで待つ（waitUntilGone を再利用。新しい待ちループは書かない）。
    const containersRes = await listApplicationContainers(auth, applicationID, baseUrl)
    const initialRunning = containersRes.ok ? readRunningContainerCount(containersRes.data) : null
    // **読めなかった（一覧の取得自体が失敗／応答の形が読めない）ときは、待ちを理由に止めない。
    // 0件と読み替えもせず、そのままDELETEを試す**（読めないことを理由に破棄を止めると、
    // 課金が止まらないほうへ倒れる）。
    //
    // 「動いているコンテナが何件か」は readRunningContainerCount（shared/apprunDedicatedShapes.ts）で数える。
    // 止まっていると言い切れる state は exited・dead だけで、それ以外・知らない値は動いている側（2026-10-08 検分 I）。
    // 注意: 一覧の読み方を原本の形に直したのは 2026-10-08。それまでは本物の応答が常に「読めない」になり、この待ちは一度も効いていなかった
    // （実際の応答はまだ誰も見ていない。読み方は shared/apprunDedicatedShapes.ts の注意を参照）。
    if (initialRunning !== null && initialRunning > 0) {
      opts.progress?.('コンテナが止まるのを待っています…')
      // ── 待ちの中でも、読めなかった（null）ときは**最初の確認と同じ向き**＝待ちをやめて DELETE へ進む（2026-10-08 検分の再指摘）──
      // 直した直後の版は、最初の確認では「読めない → 待たずに DELETE」、待ちの中では「読めない → まだ残っている」と向きが逆だった。
      // すると、どれかのノードの containersStats が null（原本で許される値）で、ほかのノードに読めたコンテナが無い応答のとき、
      // コンテナが全部止まったあとも合計の上限（既定10分）まで待ち、続く DELETE が 400 になっても、時計を使い切っていて待ち直しの余地が無かった。
      // この待ちは関門ではない（時間切れでも DELETE に進む）。まだ動いているコンテナに DELETE が当たれば 400「currently running」で、
      // その待ち直し（2026-10-07 に実機で確かめた形）が最終の判定をする——だから、読めないときは早めに DELETE へ進んでも害は無い。
      // 取得の失敗（HTTP の失敗）も同じ「分からない」。waitUntilGone は失敗を「まだ残っている」と扱うので、ここで「分からない」へ読み替える。
      const containersWait = await waitUntilGone(
        async () => {
          const r = await listApplicationContainers(auth, applicationID, baseUrl)
          return r.ok ? r : { ok: true as const, data: null }
        },
        data => (readRunningContainerCount(data) ?? 0) > 0,
        // 上限は「この段の合計」から、すでに待った分を引いた残り。
        { intervalMs: opts.intervalMs, timeoutMs: clock.remaining(), sleep: clock.countedSleep },
      )
      if (!containersWait.ok) {
        // 時間切れでも関門にはしない。待ちは成功率を上げるためのものなので、そのままDELETEを試す。
        opts.onStage?.(STAGE.teardownApp, UNMEASURED) // 上限まで待った時間を含む＝ふつうにかかる時間ではない
        executed.push(`アプリケーション『${applicationID}』のコンテナが止まるのを待ちましたが、時間切れになりました。そのまま削除を試みます。`)
      }
    }

    const res = await deleteApplication(auth, applicationID, baseUrl)
    if (res.ok) {
      const stop = await waitOrStop(
        'アプリケーション',
        () => listApplications(auth, clusterID, undefined, baseUrl),
        // M-1（2026-09-17）: 在否の判定に名前は要らない。name/clusterID の無い行も拾う
        // readApplicationIDs を使う（readApplicationRows は名前探し用で、それらの無い行を
        // 捨てるため「消えた」誤判定を招く）。
        data => readApplicationIDs(data).includes(applicationID),
        opts, executed, remaining, { applicationID },
      )
      if (stop) return stop
      clearAppRecord()
      executed.push(`アプリケーション『${applicationID}』を削除しました（消えたことを確認）`)
      return null
    }
    if (res.status === 404) {
      const listRes = await listApplications(auth, clusterID, undefined, baseUrl)
      if (!listRes.ok) {
        return {
          ok: false, executed,
          message: `アプリケーションの削除に失敗しました（404）。一覧でも確認できなかったため、残っていて課金が続いている可能性があります: ${listRes.message}`,
          remaining,
        }
      }
      // M-1（2026-09-17）: 同上。name/clusterID の無い行も在否判定に含める。
      const present = readApplicationIDs(listRes.data).includes(applicationID)
      if (present) {
        return {
          ok: false, executed,
          message: `アプリケーションの削除に失敗しました。残っている間は課金が続きます: ${res.message}`,
          remaining,
        }
      }
      opts.onStage?.(STAGE.teardownApp, UNMEASURED) // 既に消えていた（時間は測れていない）
      clearAppRecord()
      executed.push(`アプリケーション『${applicationID}』は既に存在しませんでした（記録から外しました）`)
      return null
    }
    if (res.status === 400) {
      const title = readApiErrorTitle(safeParseJson(res.detail))
      if (appDeleteRetryable(title)) {
        // 合計の上限に達したら止まる。記録（remaining.applicationID・ディスク上の applicationID）は消さない
        // ＝もう一度押せば、ここから続きを進める。どちらの理由で止まったかによって文面を変える（嘘にならないように）。
        if (clock.exhausted()) {
          return {
            ok: false, executed,
            message: appDeleteExhaustedMessage(title, res.message),
            remaining,
          }
        }
        // 待ってからやり直す（以前は間を置かずに3回打ち、1〜2秒で失敗していた）。
        // 待っている理由で進み具合の文を分ける: 「active version」は無効化が反映されるのを、「currently running」はコンテナが止まるのを待つ（K）。
        const needsReDeactivation = appDeleteNeedsReDeactivation(title)
        opts.progress?.(needsReDeactivation ? appDeactivateWaitProgressMessage(clock.waited()) : appStopWaitProgressMessage(clock.waited()))
        await clock.countedSleep(clock.retryIntervalMs)
        deactivateFirst = needsReDeactivation
        retrying = true
        continue
      }
    }
    // L（2026-10-08）: 待ち直しの途中で、DELETE が 5xx・通信の切れで通らなかった——一時的な失敗なので、そこで止めずに待ち直しの対象にする
    // （合計の上限まで。何分も待ったあとの一時的な失敗で、最初からの押し直しにしない）。4xx（404・既知の400以外）は従来どおり下で止める。
    // 無効化は、直前の400「active version」で打ち直した回のものが効いているはずなので、ここでは打ち直さない。
    if (retrying && appDeleteTransientFailure(res.status)) {
      if (clock.exhausted()) {
        return {
          ok: false, executed,
          message: appDeleteTransientExhaustedMessage(res.status, res.message),
          remaining,
        }
      }
      opts.progress?.(appDeleteTransientWaitProgressMessage(clock.waited()))
      opts.onStage?.(STAGE.teardownApp, UNMEASURED) // 5xx・通信の切れ（障害）を待った時間は、ふつうにかかる時間ではない（測定にしない）
      await clock.countedSleep(clock.retryIntervalMs)
      deactivateFirst = false
      continue
    }
    return {
      ok: false, executed,
      message: `アプリケーションの削除に失敗しました。残っている間は課金が続きます: ${res.message}`,
      remaining,
    }
  }
}

/** ロードバランサを削除し、一覧から消えるまで待つ。成功（次へ進んでよい）なら null。 */
async function attemptDeleteLoadBalancer(
  auth: CloudCredentials, projectDir: string, clusterID: string, asgID: string, loadBalancerID: string,
  opts: TeardownFlowOpts, baseUrl: string | undefined, executed: string[],
): Promise<TeardownFlowResult | null> {
  const remaining = { loadBalancerID, asgID, clusterID }
  opts.onStage?.(STAGE.teardownLb)
  const res = await deleteLoadBalancer(auth, clusterID, asgID, loadBalancerID, baseUrl)
  if (res.ok) {
    const stop = await waitOrStop(
      LB_WAIT_LABEL,
      () => listLoadBalancers(auth, clusterID, asgID, undefined, baseUrl),
      // M-1（2026-09-17）: 在否の判定に名前は要らない。name の無い行も拾う readLoadBalancerIDs
      // を使う（readLoadBalancerRows は名前探し用で、name の無い行を捨てるため「消えた」誤判定を招く）。
      data => readLoadBalancerIDs(data).includes(loadBalancerID),
      opts, executed, remaining, { loadBalancerID },
    )
    if (stop) return stop
    writeApprunDedicatedRecordFs(projectDir, { loadBalancerID: null, lbAddresses: null })
    executed.push(`ロードバランサ『${loadBalancerID}』を削除しました（消えたことを確認）`)
    return null
  }
  if (res.status === 404) {
    const listRes = await listLoadBalancers(auth, clusterID, asgID, undefined, baseUrl)
    if (!listRes.ok) {
      return {
        ok: false, executed,
        message: `ロードバランサの削除に失敗しました（404）。一覧でも確認できなかったため、残っていて課金が続いている可能性があります: ${listRes.message}`,
        remaining,
      }
    }
    // M-1（2026-09-17）: **在否は ID だけで見る。** readLoadBalancerRows は名前探し用で
    // name の無い行を捨てるため、これで「無い」と判断すると**消えていないのに記録から外す**
    // ことになり、Koto から破棄できなくなって課金が止まらない。
    if (!readLoadBalancerIDs(listRes.data).includes(loadBalancerID)) {
      opts.onStage?.(STAGE.teardownLb, UNMEASURED) // 既に消えていた（時間は測れていない）
      writeApprunDedicatedRecordFs(projectDir, { loadBalancerID: null, lbAddresses: null })
      executed.push(`ロードバランサ『${loadBalancerID}』は既に存在しませんでした（記録から外しました）`)
      return null
    }
    // ここから先は「まだある」と分かっている。`deleting` を読むために行そのものを引く
    // （読めなければ「削除中とは分からない」＝下の失敗の枝へ倒す。分からないものを進行中に倒さない）。
    const row = readLoadBalancerRows(listRes.data).find(r => r.loadBalancerID === loadBalancerID)
    if (row?.deleting === true) {
      opts.onStage?.(STAGE.teardownLb, UNMEASURED) // 前回の続き（削除は前に受け付けていた）。測れるのは残りの待ちだけ
      const stop = await waitOrStop(
        LB_WAIT_LABEL,
        () => listLoadBalancers(auth, clusterID, asgID, undefined, baseUrl),
        // M-1（2026-09-17）: 同上。name の無い行も在否判定に含める。
        data => readLoadBalancerIDs(data).includes(loadBalancerID),
        opts, executed, remaining, { loadBalancerID },
      )
      if (stop) return stop
      writeApprunDedicatedRecordFs(projectDir, { loadBalancerID: null, lbAddresses: null })
      executed.push(`ロードバランサ『${loadBalancerID}』を削除しました（消えたことを確認）`)
      return null
    }
    return {
      ok: false, executed,
      message: `ロードバランサの削除に失敗しました。残っている間は課金が続きます: ${res.message}`,
      remaining,
    }
  }
  return {
    ok: false, executed,
    message: `ロードバランサの削除に失敗しました。残っている間は課金が続きます: ${res.message}`,
    remaining,
  }
}

/**
 * ASGを削除し、一覧から消えるまで待つ。成功（次へ進んでよい）なら null。
 * **409（本文の title に `Load Balancers` を含む）**＝LBがまだ残っているとき（#39 5-11実測）は、
 * LBの一覧を引き直して見つかったIDを記録に戻し、`deleting:true` なら消えるまで待ってから
 * ASGのDELETEを再試行する（`for` ループで戻る）。回復にも上限（5回）を設け、想定外の繰り返しでは止める（無限ループの防止）。
 *
 * **LBの一覧が空のとき**（一覧には出ていないが、ASG の削除にはまだ残って見えている＝反映のずれ）は、
 * 間を置かずに打ち直さず、**待ってからやり直す**（2026-10-08 検分 J。以前は間を置かずに最大5回打って、同じ 409 のまま止まっていた）。
 * アプリの削除（rc.7）と同じ作法: 間隔は `opts.deleteRetryIntervalMs`（既定15秒）、合計の上限は `opts.timeoutMs`（既定10分）、
 * 経過は待った回数 × 間隔（`makeRetryClock`・`countedSleep`）。このときの回数は「回復の上限（5回）」に数えない。
 * 上限に達したら止まる（記録は消さない＝押し直せば続きから進む）。
 */
async function attemptDeleteAsg(
  auth: CloudCredentials, projectDir: string, clusterID: string, asgID: string,
  opts: TeardownFlowOpts, baseUrl: string | undefined, executed: string[],
): Promise<TeardownFlowResult | null> {
  const remaining = { asgID, clusterID }
  const clock = makeRetryClock(opts)
  let recoveries = 0 // 残っていた LB を見つけて待ち直した回数（反映待ちの回数は数えない）
  for (;;) {
    opts.onStage?.(STAGE.teardownAsg) // LB の残りを待ち直して戻ってきたときも、ここでASGの段へ戻る
    if (recoveries >= 5) {
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
        // M-1（2026-09-17）: 在否の判定に名前は要らない。name の無い行も拾う readAsgIDs を使う
        // （readAsgRows は名前探し用で、name の無い行を捨てるため「消えた」誤判定を招く）。
        data => readAsgIDs(data).includes(asgID),
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
          message: `オートスケーリンググループの削除に失敗しました（404）。一覧でも確認できなかったため、残っていて課金が続いている可能性があります: ${listRes.message}`,
          remaining,
        }
      }
      // M-1（2026-09-17）: **在否は ID だけで見る**（ロードバランサの段と同じ理由）。
      if (!readAsgIDs(listRes.data).includes(asgID)) {
        opts.onStage?.(STAGE.teardownAsg, UNMEASURED) // 既に消えていた（時間は測れていない）
        writeApprunDedicatedRecordFs(projectDir, { asgID: null })
        executed.push(`オートスケーリンググループ『${asgID}』は既に存在しませんでした（記録から外しました）`)
        return null
      }
      const row = readAsgRows(listRes.data).find(r => r.asgID === asgID)
      if (row?.deleting === true) {
        opts.onStage?.(STAGE.teardownAsg, UNMEASURED) // 前回の続き（削除は前に受け付けていた）。測れるのは残りの待ちだけ
        const stop = await waitOrStop(
          'オートスケーリンググループ',
          () => listAsg(auth, clusterID, undefined, baseUrl),
          // M-1（2026-09-17）: 同上。name の無い行も在否判定に含める。
          data => readAsgIDs(data).includes(asgID),
          opts, executed, remaining, { asgID },
        )
        if (stop) return stop
        writeApprunDedicatedRecordFs(projectDir, { asgID: null })
        executed.push(`オートスケーリンググループ『${asgID}』を削除しました（消えたことを確認）`)
        return null
      }
      return {
        ok: false, executed,
        message: `オートスケーリンググループの削除に失敗しました。残っている間は課金が続きます: ${res.message}`,
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
        // 一覧が空かは**ID だけで**見る（name の無い行も残っているものとして数え、一覧の形が読めないときは「空」にしない・J の再指摘）。
        const lbRows = readLoadBalancerIdRows(listRes.data)
        if (lbRows === null) {
          return {
            ok: false, executed,
            message: 'オートスケーリンググループの削除に失敗しました（ロードバランサが残っているようです）。'
              + 'ロードバランサの一覧の形が想定と違うため、残っているかどうか確かめられませんでした。'
              + `コントロールパネルで確認してください（残っている間は課金が続きます）: ${res.message}`,
            remaining,
          }
        }
        const found = lbRows[0]
        if (!found) {
          // 一覧には無い（反映のずれとみられる）。間を置かずに打ち直すと同じ 409 が続くので、待ってからASGのDELETEをやり直す（J）。
          if (clock.exhausted()) {
            return {
              ok: false, executed,
              message: lowerResourceExhaustedMessage('オートスケーリンググループ', 'ロードバランサ', res.message),
              remaining,
            }
          }
          opts.progress?.(lowerResourceSettleWaitProgressMessage('ロードバランサ', clock.waited()))
          opts.onStage?.(STAGE.teardownAsg, UNMEASURED) // 反映のずれを待った時間は、ふつうにかかる時間ではない（測定にしない）
          await clock.countedSleep(clock.retryIntervalMs)
          continue
        }
        writeApprunDedicatedRecordFs(projectDir, { loadBalancerID: found.loadBalancerID })
        executed.push(`ロードバランサ『${found.loadBalancerID}』がまだ残っていたため、記録に戻しました`)
        if (found.deleting === true) {
          // 残っていた LB を待つ時間は、LB の段に数える。ただし**削除中だった LB の残りの待ち**なので保存はしない。
          opts.onStage?.(STAGE.teardownLb, UNMEASURED)
          const stop = await waitOrStop(
            LB_WAIT_LABEL,
            () => listLoadBalancers(auth, clusterID, asgID, undefined, baseUrl),
            // M-1（2026-09-17）: 同上。name の無い行も在否判定に含める。
            data => readLoadBalancerIDs(data).includes(found.loadBalancerID),
            opts, executed, { loadBalancerID: found.loadBalancerID, asgID, clusterID }, { loadBalancerID: found.loadBalancerID },
          )
          if (stop) return stop
          writeApprunDedicatedRecordFs(projectDir, { loadBalancerID: null, lbAddresses: null })
          executed.push(`ロードバランサ『${found.loadBalancerID}』を削除しました（消えたことを確認）`)
          recoveries++
          continue // LBが消えた。ASGのDELETEを再試行する。
        }
        return {
          ok: false, executed,
          message: 'ロードバランサが残っているため削除できません。手順6をもう一度押すと、そこから削除します',
          remaining: { loadBalancerID: found.loadBalancerID, asgID, clusterID },
        }
      }
      return {
        ok: false, executed,
        message: `オートスケーリンググループの削除に失敗しました。残っている間は課金が続きます: ${res.message}`,
        remaining,
      }
    }
    return {
      ok: false, executed,
      message: `オートスケーリンググループの削除に失敗しました。残っている間は課金が続きます: ${res.message}`,
      remaining,
    }
  }
}

/**
 * クラスタを削除し、一覧から消えるまで待つ。成功（次へ進んでよい）なら null。
 * **409（本文の title に `Auto Scaling Group` を含む）**＝ASGがまだ残っているときは、ASGの
 * 一覧を引き直して見つかったIDを記録に戻し、`deleting:true` なら消えるまで待ってから
 * クラスタのDELETEを再試行する（attemptDeleteAsg と同じ形。#39）。ASG の一覧が空のとき（反映のずれ）は、
 * 間を置かずに打ち直さず、待ってからやり直す（attemptDeleteAsg と同じ。2026-10-08 検分 J）。
 * クラスタ一覧には `deleting` が無い（原本の形・5-8）ため、404で一覧にまだあれば
 * （新しい「deleting:trueなら待つ」枝には入らず）従来どおり「残っています」で止める。
 */
async function attemptDeleteCluster(
  auth: CloudCredentials, projectDir: string, clusterID: string,
  opts: TeardownFlowOpts, baseUrl: string | undefined, executed: string[],
): Promise<TeardownFlowResult | null> {
  const remaining = { clusterID }
  const clock = makeRetryClock(opts)
  let recoveries = 0 // 残っていた ASG を見つけて待ち直した回数（反映待ちの回数は数えない）
  for (;;) {
    opts.onStage?.(STAGE.teardownCluster) // ASG の残りを待ち直して戻ってきたときも、ここでクラスタの段へ戻る
    if (recoveries >= 5) {
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
        // C（2026-09-17）: 在否の判定に名前は要らない。name の無い行も拾う readClusterIDs を使う
        // （readClusterRows は名前探し用で、name の無い行を捨てるため「消えた」誤判定を招く）。
        data => readClusterIDs(data).includes(clusterID),
        opts, executed, remaining, { clusterID },
      )
      if (stop) return stop
      writeApprunDedicatedRecordFs(projectDir, { clusterID: null, name: null, zone: null, workerServiceClassPath: null, lbServiceClassPath: null, createdAt: null, lbAddresses: null })
      executed.push(`クラスタ『${clusterID}』を削除しました（消えたことを確認）`)
      return null
    }
    if (res.status === 404) {
      const listRes = await listClusters(auth, baseUrl)
      if (!listRes.ok) {
        return {
          ok: false, executed,
          message: `クラスタの削除に失敗しました（404）。一覧でも確認できなかったため、残っていて課金が続いている可能性があります: ${listRes.message}`,
          remaining,
        }
      }
      // C（2026-09-17）: 同上。name の無い行も在否判定に含める。
      const present = readClusterIDs(listRes.data).includes(clusterID)
      if (present) {
        return {
          ok: false, executed,
          message: `クラスタの削除に失敗しました。残っている間は課金が続きます: ${res.message}`,
          remaining,
        }
      }
      opts.onStage?.(STAGE.teardownCluster, UNMEASURED) // 既に消えていた（時間は測れていない）
      writeApprunDedicatedRecordFs(projectDir, { clusterID: null, name: null, zone: null, workerServiceClassPath: null, lbServiceClassPath: null, createdAt: null, lbAddresses: null })
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
        // 一覧が空かは**ID だけで**見る（ロードバランサの段と同じ・J の再指摘）。
        const asgRows = readAsgIdRows(listRes.data)
        if (asgRows === null) {
          return {
            ok: false, executed,
            message: 'クラスタの削除に失敗しました（オートスケーリンググループが残っているようです）。'
              + 'オートスケーリンググループの一覧の形が想定と違うため、残っているかどうか確かめられませんでした。'
              + `コントロールパネルで確認してください（残っている間は課金が続きます）: ${res.message}`,
            remaining,
          }
        }
        const found = asgRows[0]
        if (!found) {
          // 一覧には無い（反映のずれとみられる）。間を置かずに打ち直すと同じ 409 が続くので、待ってからクラスタのDELETEをやり直す（J）。
          if (clock.exhausted()) {
            return {
              ok: false, executed,
              message: lowerResourceExhaustedMessage('クラスタ', 'オートスケーリンググループ', res.message),
              remaining,
            }
          }
          opts.progress?.(lowerResourceSettleWaitProgressMessage('オートスケーリンググループ', clock.waited()))
          opts.onStage?.(STAGE.teardownCluster, UNMEASURED) // 反映のずれを待った時間は、ふつうにかかる時間ではない（測定にしない）
          await clock.countedSleep(clock.retryIntervalMs)
          continue
        }
        writeApprunDedicatedRecordFs(projectDir, { asgID: found.asgID })
        executed.push(`オートスケーリンググループ『${found.asgID}』がまだ残っていたため、記録に戻しました`)
        if (found.deleting === true) {
          // 残っていた ASG を待つ時間は、ASG の段に数える。ただし**削除中だった ASG の残りの待ち**なので保存はしない。
          opts.onStage?.(STAGE.teardownAsg, UNMEASURED)
          const stop = await waitOrStop(
            'オートスケーリンググループ',
            () => listAsg(auth, clusterID, undefined, baseUrl),
            // M-1（2026-09-17）: 同上。name の無い行も在否判定に含める。
            data => readAsgIDs(data).includes(found.asgID),
            opts, executed, { asgID: found.asgID, clusterID }, { asgID: found.asgID },
          )
          if (stop) return stop
          writeApprunDedicatedRecordFs(projectDir, { asgID: null })
          executed.push(`オートスケーリンググループ『${found.asgID}』を削除しました（消えたことを確認）`)
          recoveries++
          continue // ASGが消えた。クラスタのDELETEを再試行する。
        }
        return {
          ok: false, executed,
          message: 'オートスケーリンググループが残っているため削除できません。手順6をもう一度押すと、そこから削除します',
          remaining: { asgID: found.asgID, clusterID },
        }
      }
      return {
        ok: false, executed,
        message: `クラスタの削除に失敗しました。残っている間は課金が続きます: ${res.message}`,
        remaining,
      }
    }
    return {
      ok: false, executed,
      message: `クラスタの削除に失敗しました。残っている間は課金が続きます: ${res.message}`,
      remaining,
    }
  }
}

/**
 * アプリケーションの段（`attemptDeleteApplication`）が失敗／時間切れで返した `TeardownFlowResult`
 * に、記録上の下位資源（LB/ASG/クラスタ）のIDを合流させる（B-3・2026-09-17）。
 *
 * 下位資源は一度も触っていないが、画面の「残っています」に載せて存在を示すため。
 * 2026-10-08: アプリだけを消す専用の口は廃止した。手順6も 📡 の 🗑 も同じ流れなので、
 * 合流させない場合は無くなった。
 */
function mergeLowerResourcesIntoAppStop(
  stop: TeardownFlowResult, record: ApprunDedicatedRecord,
): TeardownFlowResult {
  const lower = {
    loadBalancerID: record.loadBalancerID ?? undefined,
    asgID: record.asgID ?? undefined,
    clusterID: record.clusterID ?? undefined,
  }
  return {
    ...stop,
    remaining: { ...stop.remaining, ...lower },
    ...(stop.inProgress ? { inProgress: { ...stop.inProgress, ...lower } } : {}),
  }
}

/**
 * 記録にある ID だけを、**アプリケーション → LB → ASG → クラスタ の順**で削除する
 * （D-2b-2・12-1「破棄はアプリ→LB→ASG→クラスタで組む」・5-7の逆順の先頭にアプリを足したもの）。
 * 記録に無い資源は触らない。ある段が失敗したら、そこで止める（それより下＝LB/ASG/クラスタ側は
 * 触らない——アプリが残ったままLB/ASGを消せる保証がAPI仕様上どこにも無いため、順序を厳密に守る）。
 * **各段は、DELETEの応答（204/404）を受け取ったあと、一覧からIDが完全に
 * 消えるのを確認してから次の段へ進む**（waitUntilGone・#39）。消せたものは記録から外す
 * （＝nullに戻す）。消せなかった・待ち切れなかったものは記録に残す。
 *
 * **`opts.confirmed !== true` なら、API を一切呼ばずに中止する**（2026-09-10 レビューの修理・A・
 * 掟10の3点セット）。
 *
 * 手順6「すべて削除する」も 📡 公開したもの一覧の「🗑 削除」も、**この1つの流れ**を通る
 * （2026-10-08 作者の決定: アプリだけを消す専用の口は廃止した）。
 *
 * 各段の内訳は `attemptDeleteApplication` / `attemptDeleteLoadBalancer` / `attemptDeleteAsg` /
 * `attemptDeleteCluster` に分けてある（204→待ち／404→一覧で確認→（LB/ASGは）deleting:trueなら
 * 待ち・無ければ記録から外す／409→下位資源を記録に戻して待つか止める、をそれぞれ担う）。
 */
export async function teardownFlow(
  auth: CloudCredentials, projectDir: string, opts: TeardownFlowOpts, baseUrl?: string,
): Promise<TeardownFlowResult> {
  const record = readApprunDedicatedFs(projectDir)
  const executed: string[] = []

  const hasApplication = !!record.applicationID
  const hasCluster = !!record.clusterID
  const hasAsg = !!record.asgID
  const hasLb = !!record.loadBalancerID

  // 確認ダイアログを通ったか。**ここより先で fetch を一切呼ばない。**
  if (opts.confirmed !== true) {
    return {
      ok: false, executed: [], message: '確認ダイアログを通っていません',
      remaining: {
        applicationID: record.applicationID ?? undefined,
        loadBalancerID: record.loadBalancerID ?? undefined,
        asgID: record.asgID ?? undefined,
        clusterID: record.clusterID ?? undefined,
      },
    }
  }

  if (!hasApplication && !hasCluster && !hasAsg && !hasLb) {
    return { ok: true, executed, message: '記録がありません（このプロジェクトでは何も作られていません）。', remaining: {} }
  }

  // ── アプリケーション（D-2b-2・12-1「破棄の順序はアプリ→LB→ASG→クラスタ」。LB/ASG/クラスタより先） ──
  if (hasApplication) {
    if (!hasCluster) {
      // 親のIDが記録に無いと一覧を引けない（本来起きない想定だが、最後の砦として検知する）。
      return {
        ok: false, executed,
        message: `アプリケーション『${record.applicationID}』の削除に必要なクラスタのIDが記録にありません。コントロールパネルで確認してください。`,
        remaining: { applicationID: record.applicationID as string, clusterID: record.clusterID ?? undefined },
      }
    }
    const stop = await attemptDeleteApplication(
      auth, projectDir, record.clusterID as string, record.applicationID as string, opts, baseUrl, executed,
    )
    // B-3（2026-09-17）: 記録上のLB/ASG/クラスタのIDを合流させて返す
    // （下位資源は一度も触っていないが、画面の「残っています」に載せて存在を示すため）。
    if (stop) return mergeLowerResourcesIntoAppStop(stop, record)
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
