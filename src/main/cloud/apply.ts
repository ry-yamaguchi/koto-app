// apply.ts — Plan（あるべき差分）を実クラウドへ適用する実行層（純ロジック）。
//
// ※重要・最重要: このモジュールは electron に依存しない（import しない）。
//   クラウドクライアントは CloudClientLike インターフェースとして「注入」で受け取る。
//   これにより esbuild 単体でテスト可能になる（client.ts は SakuraCloudClient がこの
//   インターフェースを満たすように作ってある）。
//
// 安全規約:
//   - 破壊的アクション（delete 等）を含むのに confirmed!==true なら一切実行しない。
//   - dryRun（client.dryRun===true）のときは一切実行せず、各アクションを skipped に積む。
//   - 返す state は常に新しいオブジェクト（入力の state を破壊しない）。

import type { EnvSpec } from './spec'
import type { EnvState, ResourceRef } from './state'
import type { Plan } from './planner'
import { buildCreateBody, buildPatchBody, apiErrorMessage, type RegistryAuth } from './client'

/**
 * apply が必要とするクラウドクライアントの最小インターフェース。
 * client.ts の SakuraCloudClient がこれを満たす（dryRun は読み取り、各メソッドは Promise）。
 * 戻り値は any（DryRunResult | ApiResult 双方を許容。ここでは形に依存せず id 抽出のみ行う）。
 */
export interface CloudClientLike {
  readonly dryRun: boolean
  ensureUser(): Promise<any>
  listApps(): Promise<any>
  createApp(body: unknown): Promise<any>
  patchApp(id: string, body: unknown): Promise<any>
  deleteApp(id: string): Promise<any>
}

/** applyPlan の入力。 */
export type ApplyOptions = {
  plan: Plan
  spec: EnvSpec
  state: EnvState
  client: CloudClientLike
  /** 破壊的操作を許可する明示確認フラグ（レンダラ＝段階2bから渡す）。 */
  confirmed: boolean
  /**
   * プライベートレジストリの認証情報（段階3b）。dockerfile ソースをビルド/プッシュ後に
   * main 側が渡す。あれば apprun-app 作成時の container_registry に載せる。
   * ※electron 非依存は維持（型は client.ts の純粋型）。
   */
  registryAuth?: RegistryAuth
}

/** applyPlan の結果。 */
export type ApplyResult = {
  ok: boolean
  /** 適用後の新しい state（入力は破壊しない）。 */
  state: EnvState
  /** 実際に実行したアクションの人間可読な説明。 */
  executed: string[]
  /** 実行しなかった（スキップした）アクションの人間可読な説明。 */
  skipped: string[]
  /** 失敗時・確認待ち時などのメッセージ。 */
  message?: string
}

/** API応答（dryRunでない）から作成リソースのIDらしき値を取り出す。無ければ null。 */
function extractId(res: any): string | null {
  // ApiResult: { dryRun:false, ok, status, data }。data の形は実APIで確定。
  // ※実APIキーでの疎通時に要確認: ID を格納するフィールド名（id / uuid 等）。
  const data = res && typeof res === 'object' && 'data' in res ? res.data : res
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>
    if (typeof d.id === 'string') return d.id
    if (typeof d.id === 'number') return String(d.id)
    if (typeof d.uuid === 'string') return d.uuid
    if (typeof (d as any).application?.id === 'string') return (d as any).application.id
  }
  return null
}

/** state を浅くクローンして resources を新配列にする（破壊しないため）。 */
function cloneState(state: EnvState): EnvState {
  return {
    name: state.name,
    backend: state.backend,
    resources: state.resources.map(r => ({ ...r })),
    ...(state.meta ? { meta: { ...state.meta } } : {}),
  }
}

/**
 * applyPlan — Plan を実クラウドへ適用する（純ロジック・クライアント注入）。
 *
 * 分岐の優先順位:
 *  1. 破壊的アクションを含むのに confirmed!==true → 何も実行せず ok:false を返す。
 *  2. dryRun（client.dryRun===true）→ 何も実行せず、各アクションを skipped に「(ドライラン)」付きで積む。
 *  3. 通常実行: アクション種別ごとに処理（下記）。
 */
export async function applyPlan(opts: ApplyOptions): Promise<ApplyResult> {
  const { plan, spec, client, confirmed, registryAuth } = opts
  const state = cloneState(opts.state)
  const executed: string[] = []
  const skipped: string[] = []

  // 1. 破壊的操作の確認ガード。
  if (plan.hasDestructive && confirmed !== true) {
    return {
      ok: false,
      state,
      executed,
      skipped,
      message: '破壊的な操作を含むため確認が必要です',
    }
  }

  // 2. ドライラン: 実行せず skipped に積むだけ。
  if (client.dryRun === true) {
    for (const a of plan.actions) {
      if (a.type === 'noop') continue
      skipped.push(`${a.description}（ドライラン）`)
    }
    return { ok: true, state, executed, skipped, message: 'ドライラン（実行していません）' }
  }

  // 3. 通常実行。アクションを順に処理する。
  // resources をキーで引けるようにしておく（delete 時の id 解決用）。
  for (const a of plan.actions) {
    if (a.type === 'noop') continue

    // ── apprun-app ──
    if (a.kind === 'apprun-app') {
      if (a.type === 'create') {
        // dockerfile ソースはイメージ未ビルドのため段階2aでは実行しない。
        if (spec.service.source.type !== 'image') {
          skipped.push(`${a.description}: 段階3（イメージのビルド/プッシュ）で対応`)
          continue
        }
        await client.ensureUser()
        const res = await client.createApp(buildCreateBody(spec, registryAuth))
        if (res && res.dryRun === false && res.ok === false) {
          // 失敗。中断して結果を返す（部分適用は state に反映済み分のみ残る）。
          // 「HTTP <status>」だけでは原因不明なため、APIエラー応答から人間可読な文言を取り出して付加する
          // （src/main/ipc/cloud.ts の他ハンドラと同じ apiErrorMessage 併記パターン）。
          const detail = apiErrorMessage(res.data)
          return {
            ok: false,
            state,
            executed,
            skipped,
            message: `AppRunアプリ『${a.name}』の作成に失敗しました（HTTP ${res.status}）${detail ? ' — ' + detail : ''}`,
          }
        }
        const id = extractId(res) ?? a.name
        state.resources.push({
          kind: 'apprun-app',
          id,
          stateful: false,
          key: `apprun-app:${a.name}`,
        })
        executed.push(a.description)
        continue
      }
      if (a.type === 'delete') {
        const ref = findRef(state, 'apprun-app', a.name)
        const id = ref?.id ?? a.name
        const res = await client.deleteApp(id)
        if (res && res.dryRun === false && res.ok === false && res.status !== 404) {
          return {
            ok: false,
            state,
            executed,
            skipped,
            message: `AppRunアプリ『${a.name}』の削除に失敗しました（HTTP ${res.status}）`,
          }
        }
        removeRef(state, 'apprun-app', a.name)
        executed.push(a.description)
        continue
      }
      if (a.type === 'update') {
        // 既存アプリへ最新イメージを再デプロイ（PATCH）。公開URLは維持され、新バージョンが作られる。
        // dockerfile ソースは create と同様、main 側でビルド/プッシュ後に image ソースへ差し替え済みのはず。
        if (spec.service.source.type !== 'image') {
          skipped.push(`${a.description}: イメージのビルド/プッシュ後に再デプロイします`)
          continue
        }
        const ref = findRef(state, 'apprun-app', a.name)
        const id = ref?.id
        if (!id) {
          skipped.push(`${a.description}: 対象アプリのIDが state に無く再デプロイできません（一度破棄して作り直してください）`)
          continue
        }
        await client.ensureUser()
        const res = await client.patchApp(id, buildPatchBody(spec, registryAuth))
        if (res && res.dryRun === false && res.ok === false) {
          return {
            ok: false,
            state,
            executed,
            skipped,
            message: `AppRunアプリ『${a.name}』の再デプロイ（更新）に失敗しました（HTTP ${res.status}）`,
          }
        }
        // アプリIDは不変。state の ref はそのまま維持する。
        executed.push(a.description)
        continue
      }
    }

    // ── bucket（オブジェクトストレージ＝別API。段階2aでは実行しない） ──
    if (a.kind === 'bucket') {
      skipped.push(`${a.description}: バケットのプロビジョニングは後続対応`)
      continue
    }

    // ── registry / image（コンテナレジストリ・イメージ＝段階3） ──
    if (a.kind === 'registry' || a.kind === 'image') {
      skipped.push(`${a.description}: 段階3で対応`)
      continue
    }
  }

  return { ok: true, state, executed, skipped }
}

/** state から (kind, name) に対応する ResourceRef を探す（key は `${kind}:${name}`）。 */
function findRef(state: EnvState, kind: ResourceRef['kind'], name: string): ResourceRef | undefined {
  const key = `${kind}:${name}`
  return state.resources.find(r => r.key === key || (r.kind === kind && r.id === name))
}

/** state から (kind, name) に対応する ResourceRef を取り除く（in place、state は既にクローン済み）。 */
function removeRef(state: EnvState, kind: ResourceRef['kind'], name: string): void {
  const key = `${kind}:${name}`
  state.resources = state.resources.filter(r => !(r.key === key || (r.kind === kind && r.id === name)))
}
