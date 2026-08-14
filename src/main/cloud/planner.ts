// planner.ts — spec（あるべき姿）と state（現状）の差分から実行計画(Plan)を算出する純ロジック。
//
// ※重要・最重要: このモジュールは electron に依存しない純関数である（IO・API呼び出し無し）。
//   computePlan(spec, state) は同じ入力に対し常に同じ Plan を返す。
//
// ※ステートフル資源（bucket 等）の削除の扱い（2026-07-04 方針確定）:
//   spec に残っている限り delete は生成しない（差分は update/再構成に留める）。
//   spec から取り除かれた場合は delete を「提案」する（spec編集だけでバケットを消せる柔軟さを残す）。
//   その際 hasStatefulDelete を true にし、下流（AppRunPanel の警告表示・apply の確認ダイアログ
//   「データは失われます」）が必ず明示確認を挟む。自動では実行されない。

import type { EnvSpec } from './spec'
import { consentedBuckets } from '../../shared/objectStorage'
import type { EnvState, ResourceKind, ResourceRef } from './state'
import { isStateful } from './state'

/** 計画上の1アクション。 */
export type PlanAction = {
  type: 'create' | 'update' | 'delete' | 'noop'
  kind: ResourceKind
  name: string
  /** この資源がステートフルか（bucket 等）。 */
  stateful: boolean
  /** 破壊的操作か（delete は true）。 */
  destructive: boolean
  /** 人間向けの日本語説明。 */
  description: string
}

/** 実行計画。 */
export type Plan = {
  actions: PlanAction[]
  /** 1つでも破壊的（delete）なアクションを含むか。 */
  hasDestructive: boolean
  /** ステートフル資源の削除を含むか。true のとき下流のUIは強い警告＋明示確認を必ず挟む。 */
  hasStatefulDelete: boolean
}

/** spec が要求する1リソース（論理表現）。 */
type DesiredResource = {
  kind: ResourceKind
  name: string
  key: string
}

/**
 * spec が要求するリソース集合を算出する（AppRunバックエンド・MVP）。
 * - apprun-app は常に1つ（name=spec.name）。
 * - persistence.objectStorage の各 bucket。
 * - service.source.type==='dockerfile' のときのみ registry / image が必要。
 */
function desiredResources(spec: EnvSpec): DesiredResource[] {
  const out: DesiredResource[] = []

  // Dockerfile ビルド時のみ、コンテナレジストリとビルド済みイメージが必要。
  if (spec.service.source.type === 'dockerfile') {
    out.push({ kind: 'registry', name: spec.name, key: `registry:${spec.name}` })
    out.push({ kind: 'image', name: spec.name, key: `image:${spec.name}` })
  }

  // AppRunアプリは常に1つ。
  out.push({ kind: 'apprun-app', name: spec.name, key: `apprun-app:${spec.name}` })

  // 各バケット（ステートフル）。**同意済みのものだけ**を要求する。
  // 同意の無いものまで要求すると、公開しただけで月額が発生する（2026-08-14）。
  for (const b of consentedBuckets(spec.persistence.objectStorage)) {
    out.push({ kind: 'bucket', name: b.bucket, key: `bucket:${b.bucket}` })
  }

  return out
}

/**
 * apprun-app に設定差分があるかを判定する。
 * MVPでは「port / env / scale / image（=source）」のいずれかが変わったら update とみなす。
 *
 * 注: state 側は作成時のスペックを直接保持しない設計のため、ここでは保守的に
 *     「state に記録された apprun-app の key と spec の要求 key が一致していれば設定一致(=noop)、
 *      そうでなければ update」とは判定できない（key は name ベースで一致してしまう）。
 *     そこで spec のハッシュ的な差分は将来 state にスナップショットを持たせて比較する前提とし、
 *     本MVPでは「資源が既に存在する＝noop」を既定にしつつ、image（ソース）依存の差分のみ
 *     detect できるよう関数として分離しておく（段階2でスナップショット比較に拡張）。
 */
function apprunNeedsUpdate(_spec: EnvSpec, _existing: ResourceRef): boolean {
  // 段階2: 既存の apprun-app は「再デプロイ（update）」として扱う。
  // 理由: AppRun のイメージはタグ（例 :latest）が同じでも中身が変わり得るため、spec の
  //   フィールド差分だけでは「コードが変わったか」を検出できない。よって既存アプリへの
  //   再公開は常に PATCH 更新（新バージョン投入・公開URLは維持）とし、利用者の
  //   「公開＝最新を反映する」という期待に合わせる。非破壊的（destructive:false）。
  return true
}

function createDescription(kind: ResourceKind, name: string): string {
  switch (kind) {
    case 'registry':
      return `コンテナレジストリ『${name}』を作成`
    case 'image':
      return `コンテナイメージ『${name}』をビルド・登録`
    case 'apprun-app':
      return `AppRunアプリ『${name}』を作成`
    case 'bucket':
      return `バケット『${name}』を作成`
  }
}

function updateDescription(kind: ResourceKind, name: string): string {
  switch (kind) {
    case 'registry':
      return `コンテナレジストリ『${name}』を更新`
    case 'image':
      return `コンテナイメージ『${name}』を再ビルド・更新`
    case 'apprun-app':
      return `AppRunアプリ『${name}』を再デプロイ（最新の内容を反映・公開URLは維持）`
    case 'bucket':
      return `バケット『${name}』を再構成（データは保持）`
  }
}

function deleteDescription(kind: ResourceKind, name: string, stateful: boolean): string {
  if (stateful) {
    return `バケット『${name}』を削除（データが消えます）`
  }
  switch (kind) {
    case 'registry':
      return `コンテナレジストリ『${name}』を削除`
    case 'image':
      return `コンテナイメージ『${name}』を削除`
    case 'apprun-app':
      return `AppRunアプリ『${name}』を削除`
    case 'bucket':
      return `バケット『${name}』を削除（データが消えます）`
  }
}

/**
 * computePlan — spec（あるべき姿）と state（現状）から Plan を算出する純関数。
 *
 * 差分ロジック:
 *  1. spec が要求するリソース集合を算出（desiredResources）。
 *  2. state に無い要求リソース → create。
 *  3. state にあり要求からも来る → 設定差分があれば update、なければ noop。
 *  4. state にあり要求に無い → delete（destructive:true）。
 *     ただし kind がステートフル（bucket）の場合は「spec に残っているか」で判定済みであり、
 *     ここに来る時点で spec から消えている＝意図的な削除のみ。
 *
 * ステートフル維持の保証:
 *  - ステートフル資源が spec に残っている限り、その key は desired 側に含まれるため
 *    「要求に無い→delete」の分岐に入らない。よって update/再構成はしても delete は生成されない。
 *  - これにより「specに残っているステートフル資源は決して削除されない」ことがロジックで担保される。
 */
export function computePlan(spec: EnvSpec, state: EnvState): Plan {
  const desired = desiredResources(spec)
  const desiredByKey = new Map<string, DesiredResource>()
  for (const d of desired) desiredByKey.set(d.key, d)

  const stateByKey = new Map<string, ResourceRef>()
  for (const r of state.resources) stateByKey.set(r.key, r)

  const actions: PlanAction[] = []

  // 2 & 3: 要求リソースごとに create / update / noop を決める。
  for (const d of desired) {
    const stateful = isStateful(d.kind)
    const existing = stateByKey.get(d.key)
    if (!existing) {
      // state に無い → create
      actions.push({
        type: 'create',
        kind: d.kind,
        name: d.name,
        stateful,
        destructive: false,
        description: createDescription(d.kind, d.name),
      })
      continue
    }
    // state にあり要求からも来る → 設定差分で update / noop
    let needsUpdate = false
    if (d.kind === 'apprun-app') {
      needsUpdate = apprunNeedsUpdate(spec, existing)
    }
    // ステートフル資源（bucket）は spec に残っている限りここに来る＝update/再構成はあっても delete はしない。
    actions.push(
      needsUpdate
        ? {
            type: 'update',
            kind: d.kind,
            name: d.name,
            stateful,
            destructive: false,
            description: updateDescription(d.kind, d.name),
          }
        : {
            type: 'noop',
            kind: d.kind,
            name: d.name,
            stateful,
            destructive: false,
            description: `${d.name}（${d.kind}）は変更なし`,
          },
    )
  }

  // 4: state にあり要求に無い → delete
  let hasStatefulDelete = false
  for (const r of state.resources) {
    if (desiredByKey.has(r.key)) continue
    const stateful = isStateful(r.kind)
    if (stateful) hasStatefulDelete = true
    actions.push({
      type: 'delete',
      kind: r.kind,
      name: nameFromKey(r.key, r.kind),
      stateful,
      destructive: true,
      description: deleteDescription(r.kind, nameFromKey(r.key, r.kind), stateful),
    })
  }

  const hasDestructive = actions.some(a => a.destructive)
  return { actions, hasDestructive, hasStatefulDelete }
}

/** key（例 'bucket:foo-data'）から表示用の name を取り出す。失敗時は key をそのまま返す。 */
function nameFromKey(key: string, kind: ResourceKind): string {
  const prefix = `${kind}:`
  return key.startsWith(prefix) ? key.slice(prefix.length) : key
}
