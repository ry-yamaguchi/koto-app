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
import { teardownPlanFor, keepMarkerKey, storageEnvVars, containsSecretEnv, consentedBuckets, STORAGE_ENV } from '../../shared/objectStorage'
import { permissionNameFor } from '../../shared/storageKeys'

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

/**
 * 永続データ（オブジェクトストレージ）の操作。**注入で受け取る**（electron 非依存を保つため）。
 *
 * ここに無い操作は apply からは行わない。とくに**削除の判断はここでしない**
 * （shared/objectStorage.ts に集約。掟10）。apply は「一覧を取り、判断を仰ぎ、
 * 言われたとおりに消す」だけ。
 */
export interface StorageClientLike {
  /** サイトの利用が始まっているか。**始まっていなければ課金が発生するので勝手に始めない。** */
  isSiteReady(): Promise<boolean>
  /** バケットを用意する（すでにあれば何もしない）。 */
  ensureBucket(bucket: string): Promise<void>
  /** バケットの中身をすべて一覧する（途中で打ち切らない）。 */
  listAllKeys(bucket: string): Promise<string[]>
  /** 目印を置く（「用意しただけで空のプロジェクト」を一覧に出すため）。 */
  putMarker(bucket: string, key: string): Promise<void>
  /** キーをまとめて消す。 */
  deleteKeys(bucket: string, keys: string[]): Promise<void>
  /** バケットごと消す。**呼ぶ前に必ず判断を通すこと。** */
  deleteBucket(bucket: string): Promise<void>
  /**
   * 読み書き用のキーを発行する。**シークレットはこの戻り値でしか読めない。**
   * 公開のたびに新しく発行し、その場でデプロイ本文へ渡し切る（どこにも保存しない）。
   */
  issueKey(bucket: string, displayName: string): Promise<{ accessKey: string; secretKey: string; permissionId: string }>
  /** 古い権限を片づける（キーも一緒に無効になる）。 */
  deletePermission(permissionId: string): Promise<void>
  /**
   * いまある権限の一覧。**片づける対象を選ぶため。**
   * 判断は shared/storageKeys.ts に集約してあり、ここは一覧を渡すだけ。
   */
  listPermissions(): Promise<{ id: string; displayName: string }[]>
  /** S3 のエンドポイントとリージョン（アプリに渡す）。 */
  siteInfo(): { s3Endpoint: string; region: string }
}

/**
 * 実行の順番を決める（純関数）。**保存場所の作成を、アプリのデプロイより先にする。**
 *
 * アプリには保存場所の鍵を環境変数で渡すが、その鍵は**バケットが存在しないと効かない**。
 * 初回公開では「アプリ作成 → バケット作成」の順に並ぶことがあり、先に発行した鍵が
 * 使えず `403 AccessDenied` になった（2026-08-14 実機）。
 *
 * 削除の順番は変えない（アプリを止めてから保存場所を消す。逆にすると、
 * 動いているアプリの足元でデータが消える）。
 */
export function orderForApply<T extends { kind: string; type: string }>(actions: readonly T[]): T[] {
  const rank = (a: T): number => (a.kind === 'bucket' && a.type === 'create' ? 0 : 1)
  return [...actions].sort((x, y) => rank(x) - rank(y))
}

/** applyPlan の入力。 */
export type ApplyOptions = {
  plan: Plan
  spec: EnvSpec
  state: EnvState
  client: CloudClientLike
  /**
   * 永続データの操作（任意）。渡されないときはバケットの処理を飛ばす
   * （これまでどおりの動作。既存の呼び出し元を壊さない）。
   */
  storage?: StorageClientLike
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
  const { plan, spec, client, storage, confirmed, registryAuth } = opts
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

  // 3-0. 永続データを使うプロジェクトなら、**公開のたびに新しいキーを発行**する。
  //
  // シークレットは発行の応答でしか読めないので、受け取ってそのままデプロイ本文へ
  // 載せる。**env.json にもディスクにも書かない。**
  // 古い権限は新しいデプロイが成功してから消す（失敗時に戻れるように）。
  //
  // ── 発行は「バケットができてから」（2026-08-14 実機で 403）────────────
  // 以前はここでまとめて発行していたが、**初回公開ではバケットがまだ無い**。
  // 存在しないバケットに対する権限は効かず、あとで目印を書くところで
  // `403 AccessDenied` になった。だから**必要になった時に初めて発行する**形にし、
  // バケットを作る操作を先に済ませる（下の並べ替え）。
  let runtimeEnv: Array<{ key: string; value: string }> = []
  let newPermissionId: string | null = null
  // **同意済みのものだけ。** 同意の無い定義（古い env.json の既定値）に鍵を発行しない
  const storageBucket = consentedBuckets(spec.persistence?.objectStorage)[0]

  /** アプリへ渡す保存場所の設定を用意する（初回だけ発行し、以後は使い回す）。 */
  const ensureRuntimeEnv = async (): Promise<string | null> => {
    if (!storage || !storageBucket || newPermissionId) return null
    const site = storage.siteInfo()
    // 名前は**片づけの目印**。手で組み立てると、ずれた瞬間に孤児になる（掟10）
    const issued = await storage.issueKey(storageBucket.bucket, permissionNameFor(spec.name))
    newPermissionId = issued.permissionId
    const publicVars = storageEnvVars({
      bucket: storageBucket.bucket,
      prefix: storageBucket.prefix ?? '',
      s3Endpoint: site.s3Endpoint,
      region: site.region,
      accessKey: issued.accessKey,
    })
    // **最後の砦。** 秘密でない側に秘密が紛れていないか確かめる
    if (containsSecretEnv(publicVars)) {
      return '内部エラー: 秘密でない設定に秘密が混ざっています。公開を中止しました。'
    }
    runtimeEnv = [
      ...publicVars.map(v => ({ key: v.name, value: v.value })),
      { key: STORAGE_ENV.secretKey, value: issued.secretKey },
    ]
    return null
  }

  // 3. 通常実行。アクションを順に処理する。
  // resources をキーで引けるようにしておく（delete 時の id 解決用）。
  //
  // **バケットの作成だけは先に回す。** アプリのデプロイには保存場所の鍵が要り、
  // その鍵はバケットができていないと効かない（2026-08-14 実機で 403）。
  // 削除の順序は変えない（アプリを消してから保存場所を消す）。
  for (const a of orderForApply(plan.actions)) {
    if (a.type === 'noop') continue

    // ── apprun-app ──
    if (a.kind === 'apprun-app') {
      if (a.type === 'create' || a.type === 'update') {
        // **バケットができてから鍵を発行する。** ここまで来ていれば作成済み
        try {
          const problem = await ensureRuntimeEnv()
          if (problem) return { ok: false, state, executed, skipped, message: problem }
        } catch (e: any) {
          return { ok: false, state, executed, skipped, message: `保存場所の鍵を用意できませんでした: ${e?.message ?? e}` }
        }
      }
      if (a.type === 'create') {
        // dockerfile ソースはイメージ未ビルドのため段階2aでは実行しない。
        if (spec.service.source.type !== 'image') {
          skipped.push(`${a.description}: 段階3（イメージのビルド/プッシュ）で対応`)
          continue
        }
        await client.ensureUser()
        const res = await client.createApp(buildCreateBody(spec, registryAuth, runtimeEnv))
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
        const res = await client.patchApp(id, buildPatchBody(spec, registryAuth, runtimeEnv))
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

    // ── bucket（永続データ＝オブジェクトストレージ。2026-08-13 実装） ──
    if (a.kind === 'bucket') {
      if (!storage) {
        skipped.push(`${a.description}: 保存場所の操作が使えません（設定を確認してください）`)
        continue
      }

      if (a.type === 'create') {
        // **サイトの利用開始は課金の始まり**なので、apply からは勝手に行わない。
        // 利用者の同意を取ったうえで、呼び出し側が先に済ませておく約束にしてある。
        if (!(await storage.isSiteReady())) {
          skipped.push(`${a.description}: 保存場所の利用開始がまだです（費用の確認が要ります）`)
          continue
        }
        const prefix = bucketPrefixOf(spec, a.name)
        try {
          await storage.ensureBucket(a.name)
          // 目印を置く。**これが無いと「用意しただけで空のプロジェクト」が一覧に出ず、
          // 別のプロジェクトの破棄で巻き込まれて消える**（2026-08-13）。
          if (prefix) await storage.putMarker(a.name, keepMarkerKey(prefix))
        } catch (e: any) {
          return { ok: false, state, executed, skipped, message: `保存場所『${a.name}』を用意できませんでした: ${e?.message ?? e}` }
        }
        state.resources.push({ kind: 'bucket', id: a.name, stateful: true, key: `bucket:${a.name}`, prefix })
        executed.push(a.description)
        continue
      }

      if (a.type === 'delete') {
        // **消す前に必ず一覧して確かめる。** 判断は shared/objectStorage.ts に集約。
        const prefix = bucketPrefixOf(spec, a.name) || stateBucketPrefix(state, a.name)
        let allKeys: string[]
        try {
          allKeys = await storage.listAllKeys(a.name)
        } catch (e: any) {
          // 確かめられないなら消さない。**「たぶん空」で消すのがいちばん危ない。**
          return { ok: false, state, executed, skipped, message: `保存場所『${a.name}』の中身を確認できないため、削除を中止しました: ${e?.message ?? e}` }
        }
        const placement = { bucket: a.name, prefix, shared: isSharedBucket(spec, a.name) }
        const decision = teardownPlanFor(placement, allKeys)
        try {
          if (decision.deletePrefix) {
            const mine = allKeys.filter(k => k.startsWith(decision.deletePrefix as string))
            if (mine.length > 0) await storage.deleteKeys(a.name, mine)
          }
          if (decision.deleteBucket) await storage.deleteBucket(a.name)
        } catch (e: any) {
          return { ok: false, state, executed, skipped, message: `保存場所『${a.name}』の削除に失敗しました: ${e?.message ?? e}` }
        }
        if (decision.deleteBucket) {
          state.resources = state.resources.filter(r => !(r.kind === 'bucket' && r.id === a.name))
        }
        // 鍵も無効にする。残すと、消したはずの保存場所へ届く鍵が生き続ける
        const permId = state.meta?.storagePermissionId
        if (permId) {
          try { await storage.deletePermission(permId) } catch { skipped.push('保存場所の鍵を無効にできませんでした') }
          state.meta = { ...state.meta, storagePermissionId: undefined }
        }
        executed.push(`${a.description} — ${decision.note}`)
        continue
      }

      skipped.push(`${a.description}: この操作には対応していません`)
      continue
    }

    // ── registry / image（コンテナレジストリ・イメージ＝段階3） ──
    if (a.kind === 'registry' || a.kind === 'image') {
      skipped.push(`${a.description}: 段階3で対応`)
      continue
    }
  }

  // 3-9. 新しい鍵で公開できたので、**古い鍵を無効にする**。
  //
  // 順序が大事。先に消すと、デプロイに失敗したとき古い版も動かなくなる。
  // ここで失敗しても公開そのものは成功しているので、止めずに知らせるだけにする。
  if (storage && newPermissionId) {
    // **古い鍵はここで消さない。**（2026-08-14 実機で発覚）
    // デプロイのAPIが 200 を返しても、新しいコンテナはまだ立ち上がっていない。
    // その間**古いコンテナが動き続ける**ので、ここで古い鍵を消すと、
    // いま動いているアプリが 403 で落ちる。新しい版の起動に失敗すれば
    // そのまま壊れ続ける（実際そうなった）。
    // **片づけは「動いた」と確かめてから**（呼び出し側が起動確認のあとに行う）。
    state.meta = { ...state.meta, storagePermissionId: newPermissionId }
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

/** spec からこのバケットのプレフィックスを引く（共有バケットのときだけ意味を持つ）。 */
function bucketPrefixOf(spec: EnvSpec, bucket: string): string {
  const b = (spec.persistence?.objectStorage ?? []).find(x => x.bucket === bucket)
  return b?.prefix ?? ''
}

/** spec からこのバケットが共有かを引く。**分からないときは共有として扱う**（消さない側に倒す）。 */
function isSharedBucket(spec: EnvSpec, bucket: string): boolean {
  const b = (spec.persistence?.objectStorage ?? []).find(x => x.bucket === bucket)
  return b?.shared !== false
}

/** spec から引けないとき（すでに spec から消えている破棄時）に state から拾う。 */
function stateBucketPrefix(state: EnvState, bucket: string): string {
  const r = state.resources.find(x => x.kind === 'bucket' && x.id === bucket)
  return r?.prefix ?? ''
}
