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
import { keepMarkerKey, storageEnvVars, containsSecretEnv, consentedBuckets, STORAGE_ENV } from '../../shared/objectStorage'
import { teardownStorage } from './storageTeardown'
import { permissionNameFor } from '../../shared/storageKeys'
import { readActualMinScale, judgeScale, type ScaleDecision } from '../../shared/scaleDecision'

/**
 * apply が必要とするクラウドクライアントの最小インターフェース。
 * client.ts の SakuraCloudClient がこれを満たす（dryRun は読み取り、各メソッドは Promise）。
 * 戻り値は any（DryRunResult | ApiResult 双方を許容。ここでは形に依存せず id 抽出のみ行う）。
 */
export interface CloudClientLike {
  readonly dryRun: boolean
  ensureUser(): Promise<any>
  listApps(): Promise<any>
  getApp(id: string): Promise<any>
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
  /**
   * 「起動のしかた（min_scale）」がさくら側と食い違ったとき、どちらで公開するか
   * （画面の選択カードから、確認をやり直すときだけ渡す。未指定＝食い違えば ask で止まる）。
   */
  scaleDecision?: ScaleDecision
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
  /**
   * 「起動のしかた」がさくら側と食い違い、`scaleDecision` 未指定で止まったときだけ載る。
   * **この場合 PATCH は呼んでいない**（呼び出し側が選び直して再度呼ぶ）。
   */
  needsScaleDecision?: { appId: string; recorded: number; actual: number }
  /**
   * `scaleDecision:'sakura'` で、さくら側の実物の値を採用して公開したときだけ載る。
   * 呼び出し側（main）がこの値で env.json の `service.scale.min` を書き戻す。
   */
  adoptedScaleMin?: number
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
  // 「起動のしかた」が食い違い、decision:'sakura' で実物の値を採用したときだけ入る
  // （main が env.json へ書き戻すため。update アクションの中で設定する）。
  let adoptedScaleMin: number | undefined

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

  /**
   * いま発行した鍵が、**どれかの版に載ったか**（create / patch が通ったか）。
   * 載ったあとに取り消すと、これから立ち上がるコンテナが 403 で落ちる（2026-08-14 実機）。
   */
  let keyDelivered = false

  /**
   * 公開が途中で止まったときに、**いま発行したばかりの鍵だけ**を取り消す（2026-09-25 検分）。
   *
   * 片づけ（`cleanUpOldKeysFor`）は**成功した公開のときにしか走らない**ので、ここで取り消さないと
   * 「バケットへ読み書きできる本物の鍵」が、押した回数だけ溜まる（**実機で5件たまったのは
   * この共用型**・storageKeys.ts 冒頭）。しかも早期 return では `state.meta` にも載らないため、
   * ⑥の破棄からも辿れない孤児になる。専有型（`revokeJustIssuedKey`）・Vercel と同じ形を揃える。
   *
   * **取り消すのはいま発行した1件だけ。古い鍵には触れない**ので、動いているアプリは落ちない。
   * **どの版にも載っていないと言い切れるときだけ**（`keyDelivered` が false のときだけ）呼ぶ。
   * 後始末の失敗で公開の結果は変えない（共用型・HANAMII の片づけと同じ扱い）。
   */
  const revokeJustIssuedKey = async (): Promise<void> => {
    if (!storage || !newPermissionId || keyDelivered) return
    const id = newPermissionId
    // 記録にも残さない（早期 return では state.meta に載らないまま消える鍵になる）
    newPermissionId = null
    try { await storage.deletePermission(id) } catch { /* 後始末の失敗で結果を変えない */ }
  }

  /** 途中で止めるときの返し方。**返す前に、いま発行した鍵を取り消す。** */
  const stopped = async (message: string, extra?: Partial<ApplyResult>): Promise<ApplyResult> => {
    await revokeJustIssuedKey()
    return { ok: false, state, executed, skipped, message, ...extra }
  }

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
          // 鍵は発行済みで、まだどの版にも載っていない＝ここで取り消す（2026-09-25 検分）
          if (problem) return await stopped(problem)
        } catch (e: any) {
          return await stopped(`保存場所の鍵を用意できませんでした: ${e?.message ?? e}`)
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
          // アプリが作られていない＝いま発行した鍵はどの版にも載っていない（2026-09-25 検分）
          return await stopped(`AppRunアプリ『${a.name}』の作成に失敗しました（HTTP ${res.status}）${detail ? ' — ' + detail : ''}`)
        }
        // **ここから先は取り消さない。** 鍵はこの版に載って動き出す（2026-08-14 の 403 事故）
        keyDelivered = true
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
          return await stopped(`AppRunアプリ『${a.name}』の削除に失敗しました（HTTP ${res.status}）`)
        }
        removeRef(state, 'apprun-app', a.name)
        executed.push(a.description)
        continue
      }
      if (a.type === 'update') {
        // 既存アプリへ最新イメージを再デプロイ（PATCH）。公開URLは維持され、新バージョンが作られる。
        // dockerfile ソースは create と同様、main 側でビルド/プッシュ後に image ソースへ差し替え済みのはず。
        if (spec.service.source.type !== 'image') {
          skipped.push(`${a.description}: イメージのビルド/プッシュ後に更新（公開し直し）します`)
          continue
        }
        const ref = findRef(state, 'apprun-app', a.name)
        const id = ref?.id
        if (!id) {
          skipped.push(`${a.description}: 対象アプリのIDが state に無く更新（公開し直し）できません（一度破棄して作り直してください）`)
          continue
        }

        // ── 「起動のしかた（min_scale）」の食い違い判定（Ryosuke さん決定・案②・2026-09-10） ──
        // buildPatchBody は毎回 min_scale を送るので、さくら側で直接変えていても
        // 黙って Koto の設定で上書きしてしまう（#31）。PATCH の**前**に実物を読み、
        // 食い違えば止めて聞く（歯止めは main 側の純関数・掟10の基準）。
        let actualMinScale: number | null = null
        try {
          const detail = await client.getApp(id)
          if (detail && detail.dryRun === false && detail.ok) {
            actualMinScale = readActualMinScale(detail.data)
          }
        } catch {
          // 確認できなかっただけ。actualMinScale は null のまま
          // （judgeScale が「分からないときは Koto の設定で進める」に倒す）。
        }
        const judged = judgeScale({ recorded: spec.service.scale.min, actual: actualMinScale, decision: opts.scaleDecision })
        if (judged.kind === 'ask') {
          // **PATCH を呼ばない。** それまでに実行した分の state はそのまま返す
          // （記録は「実際に起きたこと」・掟10）。
          // **PATCH を呼んでいない＝どの版にも載っていない**ので、いま発行した鍵は取り消す
          // （選び直して押し直すたびに、使われない鍵が1本ずつ増えていた・2026-09-25 検分）。
          return await stopped(
            '起動のしかたが、さくら側と Koto の設定で違います。どちらで公開するか選んでください。',
            { needsScaleDecision: { appId: id, recorded: judged.recorded, actual: judged.actual } },
          )
        }
        // spec そのものは書き換えない。複製に決定した min を差し込んで渡す。
        const patchSpec = judged.min === spec.service.scale.min
          ? spec
          : { ...spec, service: { ...spec.service, scale: { ...spec.service.scale, min: judged.min } } }
        if (opts.scaleDecision === 'sakura') adoptedScaleMin = judged.min

        await client.ensureUser()
        const res = await client.patchApp(id, buildPatchBody(patchSpec, registryAuth, runtimeEnv))
        if (res && res.dryRun === false && res.ok === false) {
          // 新しい版は作られていない（いま動いている版は**古い鍵**で動き続ける）ので、
          // いま発行した鍵を取り消す。古い鍵には触れないので 403 にはならない。
          return await stopped(`AppRunアプリ『${a.name}』の更新（公開し直し）に失敗しました（HTTP ${res.status}）`)
        }
        // **ここから先は取り消さない。** 鍵はこの版に載って動き出す（2026-08-14 の 403 事故）
        keyDelivered = true
        // アプリIDは不変。state の ref はそのまま維持する。
        executed.push(a.description)
        // 黙らない。「分からないので Koto の設定で進めた」ことを執行記録に残す。
        if (judged.note) executed.push(`ℹ️ ${judged.note}`)
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
          return await stopped(`保存場所『${a.name}』を用意できませんでした: ${e?.message ?? e}`)
        }
        state.resources.push({ kind: 'bucket', id: a.name, stateful: true, key: `bucket:${a.name}`, prefix })
        executed.push(a.description)
        continue
      }

      if (a.type === 'delete') {
        // **消す前に必ず一覧して確かめる。** 手順そのものは cloud/storageTeardown.ts に集約してある
        // （2026-09-24。専有型の⑥破棄も**同じ1つ**を通る＝案2「共用型と同じにする」）。
        // 判断（何を消してよいか）は、その先の shared/objectStorage.ts。ここでは書かない。
        const prefix = bucketPrefixOf(spec, a.name) || stateBucketPrefix(state, a.name)
        const placement = { bucket: a.name, prefix, shared: isSharedBucket(spec, a.name) }
        // 鍵も無効にする。残すと、消したはずの保存場所へ届く鍵が生き続ける
        const permId = state.meta?.storagePermissionId
        const outcome = await teardownStorage({ storage, placement, permissionId: permId })
        if (!outcome.ok) {
          return await stopped(outcome.message)
        }
        if (outcome.deletedBucket) {
          state.resources = state.resources.filter(r => !(r.kind === 'bucket' && r.id === a.name))
        }
        // **無効にできたときだけ記録から外す**（2026-09-24 検分の指摘11。専有型
        // src/main/ipc/apprunDedicated.ts と同じ判断）。deletePermission が失敗すると
        // `outcome.warnings` に「保存場所の鍵を無効にできませんでした」が積まれる。その状態で
        // ID を消すと、**消したはずの保存場所へ読み書きできる鍵が、どこからも辿れないまま生き残る**
        // （objectStorage.ts の冒頭が「実機で起きた」と書いている形そのもの）。
        if (permId && outcome.warnings.length === 0) state.meta = { ...state.meta, storagePermissionId: undefined }
        skipped.push(...outcome.warnings)
        executed.push(`${a.description} — ${outcome.note}`)
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

  return { ok: true, state, executed, skipped, ...(adoptedScaleMin !== undefined ? { adoptedScaleMin } : {}) }
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
