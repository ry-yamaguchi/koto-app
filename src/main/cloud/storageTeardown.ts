// storageTeardown.ts — 保存場所（オブジェクトストレージ）を片づける手順を1箇所に集める。
//
// ── なぜこのファイルが要るのか（2026-09-24 Ryosuke 決定「①は案2・一貫性が重要」）─────
// 保存場所を片づける手順は、これまで共用型 AppRun の `apply.ts` の中にしか無かった。
// 専有型（`apprunDedicatedApply.ts`）は 2026-09-23 まで保存場所を使っていなかったので
// 無害だったが、同日の修理（`ipc/apprunDedicated.ts` が鍵を発行するようになった）で
// **保存場所を使う専有型のプロジェクト**が生まれた。それを⑥で破棄すると、
// バケットもプレフィックスも鍵も残る——**消したはずの保存場所へ届く鍵が生き続ける。**
//
// そこで手順そのものをここへ出し、共用型・専有型の**両方がこの1つを通る**ようにする
// （掟10「一元定義＋テスト」。写して2つにすると、片方だけ直る日が必ず来る）。
//
// ── ここでやらないこと ────────────────────────────────────────────────
// **何を消してよいかの判断は書かない。** 判断は `shared/objectStorage.ts` の
// `teardownPlanFor` に集約してあり、ここは「一覧を取り、判断を仰ぎ、言われたとおりに
// 消す」だけ。ここに条件を1つでも書くと、判断が2箇所になる。
//
// ── いちばん大事な守り ────────────────────────────────────────────────
// **消す前に必ず一覧して確かめる。一覧できなければ1件も消さずに中止する。**
// 「たぶん空」で消すのがいちばん危ない（利用者のデータがそこにある）。
// **キーの一覧だけでは、ほかのプロジェクトは見えない**（2026-10-21 実機）。保存場所を用意しただけ・目印が消えたプロジェクトは一覧に出ない。
// だから**ほかのプロジェクトの記録も読んで**（`bucketUsersFromRecords`）判断に渡す。読めなければ「わからない」＝バケットは消さない。
// バケットを消す道は、ここ（`teardownStorage`）の1か所だけ。共用型・HANAMII・専有型の3つの破棄（`teardownStorageForProject` 経由）と、
// 公開の apply の削除は、すべてここを通る。

import { teardownPlanFor, twinRiskOf, type StoragePlacement, type StorageTeardown } from '../../shared/objectStorage'
import { bucketUsersFromRecords } from './bucketUsers'
import { permissionHeldByOthersFs } from './permissionHolders'

/**
 * 片づけに要るストレージ操作だけを切り出したもの（注入で受け取る＝electron 非依存を保つ）。
 * `apply.ts` の `StorageClientLike` も `storageAdapter.ts` の `StorageAdapter` もこれを満たす。
 */
export type StorageTeardownClientLike = {
  /** バケットの中身をすべて一覧する（途中で打ち切らない）。 */
  listAllKeys(bucket: string): Promise<string[]>
  /** キーをまとめて消す。 */
  deleteKeys(bucket: string, keys: string[]): Promise<void>
  /** バケットごと消す。**呼ぶ前に必ず判断（teardownPlanFor）を通すこと。** */
  deleteBucket(bucket: string): Promise<void>
  /** 権限（＝鍵）を無効にする。 */
  deletePermission(permissionId: string): Promise<void>
}

/**
 * この破棄で消す保存場所のうち、**1件でも**複製（または複製かもしれないもの）がいるか（0.6.24 R1-c）。いれば、記録の鍵にも、名前での鍵の一括の無効化にも触れてはいけない
 * （複製は元の env.json の名前と記録の鍵 ID を写すので、触ると**元の現役の鍵が切れる**）。判断は `twinRiskOf` の1つ（ここで二重に定義しない）。
 * 共用型・HANAMII・専有型の破棄（`teardownStorageForProject` が**ループの前に**これで確かめる。ループの途中で分かってからでは、先に回った1件で記録の鍵が切れている）と、
 * 公開の apply の削除（`apply.ts`）が、同じこれを通る。
 */
export function placementsHaveTwinRisk(projectDir: string, placements: readonly StoragePlacement[]): boolean {
  return placements.some(p => twinRiskOf(bucketUsersFromRecords(projectDir, p.bucket, p.prefix)) !== null)
}

/**
 * 記録の鍵（`permissionId`）を、**無効にしてはいけない**か（0.6.24 R2-i）。同じ親フォルダの兄弟が同じ鍵の ID を記録に持つ（`true`）か、確かめられなかった（`'unknown'`。親フォルダの一覧・
 * 兄弟の記録を読めない）とき true。複製が保存場所の設定を外して**記録の鍵の ID だけを写した**形は、保存場所の prefix で見る `placementsHaveTwinRisk` には見えないので、鍵の ID そのもので見る
 * （無効にすると、元の現役の鍵が切れる）。鍵が無い（null・空）なら false（無効にするものが無い）。
 * 記録の鍵を無効にする3か所——共用型・HANAMII・専有型の破棄（`teardownStorageForProject` の**ループの前**）・共用型の保存場所0件の鍵の無効化（`cloudTeardownStorage.ts` の `runStorageStage`）・
 * 公開の apply の削除（`apply.ts`）——が、同じこれを通る。true のときは鍵を無効にせず、記録の ID も外さない（`permissionRevoked` が false のまま）。名前での鍵の一括の無効化（`sweepKeysFor`）も、
 * 同じ名前の現役の鍵まで切るので、この回は行わない。
 */
export function recordedKeyAtRisk(projectDir: string, permissionId: string | null | undefined): boolean {
  return recordedKeyRisk(projectDir, permissionId) !== null
}

/** 記録の鍵を無効にしなかった理由（0.6.24 R3-c）。`held` … 同じ鍵の ID をほかのフォルダの記録が持つ。`unknown` … ほかのフォルダの記録を確かめられなかった。 */
export type KeyKeptReason = 'held' | 'unknown'

/**
 * `recordedKeyAtRisk` の理由つきの答え。無効にしてよいときは null（鍵が無い・持つ兄弟がいない）。**判断は `permissionHeldByOthersFs` の1つ**（`recordedKeyAtRisk` はこれの `!== null`）。
 * 無効にしなかった回の警告（`keyKeptWarning`）を、結果のどこかに出すのに使う（R3-c。黙って残すと、元の現役の鍵を守ったことも、鍵が残っていることも利用者に見えない）。
 */
export function recordedKeyRisk(projectDir: string, permissionId: string | null | undefined): KeyKeptReason | null {
  if (typeof permissionId !== 'string' || permissionId === '') return null
  const held = permissionHeldByOthersFs(projectDir, permissionId)
  if (held === false) return null
  return held === true ? 'held' : 'unknown'
}

/** 記録の鍵を無効にしなかった回の警告の文（R3-c。文は仕様 9章のとおり）。 */
export const KEY_KEPT_HELD_WARNING = '保存場所のアクセスキーは、ほかのフォルダの記録も同じものを使っているため、無効にしていません。'
export const KEY_KEPT_UNKNOWN_WARNING = '保存場所のアクセスキーは、ほかのフォルダの記録を確かめられないため、無効にしていません。'
const KEY_KEPT_WARNINGS: readonly string[] = [KEY_KEPT_HELD_WARNING, KEY_KEPT_UNKNOWN_WARNING]

/**
 * 記録の鍵を無効にしなかった回に、結果へ足す警告（`teardownStorageForProject` の `warnings`・保存場所0件の段・`apply.ts` の3か所。0.6.24 R3-c）。
 * 表示の行にするのは `keyWarningLines`（各行を `⚠️ ` で始める）。
 */
export function keyKeptWarning(reason: KeyKeptReason): string {
  return reason === 'held' ? KEY_KEPT_HELD_WARNING : KEY_KEPT_UNKNOWN_WARNING
}

/** 記録の鍵を無効にできなかったときの警告の文。呼び手（共用型の破棄）が「鍵の記録を残すか」を決めるのに使う。 */
export const KEY_REVOKE_FAILED_WARNING = '保存場所のアクセスキーを無効にできませんでした'

/**
 * 鍵の警告（`teardownStorageForProject` の `warnings` など）を、結果に出す行にする。各行を `⚠️ ` で始め、
 * **最後の1行にだけ** `guide`（`keyRevokeGuide`）を足す（同じ案内を何度も言わない）。空なら []。
 * ただし、無効にしていない警告（`keyKeptWarning`。R3-c）は「最後の1行」に数えず、案内も足さない（下の注）。
 *
 * ここで案内を足すのは、**表示の行を作るとき**だけ。生の `warnings` と `KEY_REVOKE_FAILED_WARNING` の文は変えない
 * （共用型の `ipc/cloudTeardownStorage.ts` の `revokeRecordedKey` が同じ文を使う）。記録から鍵の ID を外すかは、警告の有無ではなく `permissionRevoked`（実際に無効にできたか）だけで決める（0.6.24 R1-c）。
 * 案内の中の名前（`koto-<名前>`）は公開先とプロジェクトで決まり、定数は名前を知らないので、定数には足さない。
 */
export function keyWarningLines(warnings: readonly string[], guide: string): string[] {
  // 案内を足すのは「無効にできなかった」警告の最後の1行だけ。**無効にしていない警告（R3-c）には足さない**: 案内は「パーミッションを削除してください」で、
  // ほかのフォルダが使っている現役の鍵（無効にしなかった理由そのもの）を、利用者に削除させてしまう。
  const last = warnings.map(w => KEY_KEPT_WARNINGS.includes(w)).lastIndexOf(false)
  return warnings.map((w, i) => (i === last ? `⚠️ ${w}${w.endsWith('。') ? '' : '。'}${guide}` : `⚠️ ${w}`))
}

/**
 * 破棄の返り値へ足す、**残した保存場所の理由**（共用型・HANAMII・専有型の3つの破棄と、公開〔apply.ts〕の保存場所の削除が、同じこれを通る）。
 * 結果の警告（`teardownRemainingWarnings`）は、これで残した理由を言い分け、「後で消す場合は」を言ってよいかを決める。
 *   ・`keptBucketsUsedByOthers` … ほかのプロジェクトも使っているため残した保存場所（消すと、そのプロジェクトのデータも消える）
 *   ・`keptBucketsWithOwnFiles` … Koto が作ったのではないファイルがあるため残した保存場所（消す前に中身を確かめる）
 * 理由が分からない回（旧い返り値・`keptReasons` の無い `done`）は、どちらにも入れない（言う側が「分からない」の文に倒す）。
 * バケットごと消した保存場所は入れない。
 */
export function keptBucketReasonFields(
  done: ReadonlyArray<{ bucket: string; deletedBucket: boolean; keptReasons?: StorageTeardown['keptReasons'] }>,
): { keptBucketsUsedByOthers?: string[]; keptBucketsWithOwnFiles?: string[] } {
  const kept = done.filter(b => !b.deletedBucket)
  const usedByOthers = kept.filter(b => b.keptReasons?.usedByOthers === true).map(b => b.bucket)
  const withOwnFiles = kept.filter(b => b.keptReasons?.ownFiles === true).map(b => b.bucket)
  return {
    ...(usedByOthers.length > 0 ? { keptBucketsUsedByOthers: usedByOthers } : {}),
    ...(withOwnFiles.length > 0 ? { keptBucketsWithOwnFiles: withOwnFiles } : {}),
  }
}

export type StorageTeardownOutcome =
  | {
      ok: true
      /** バケットごと消したか（呼び出し側が記録から外すのに使う）。 */
      deletedBucket: boolean
      /** 利用者に見せる説明（`teardownPlanFor` が返したもの）。 */
      note: string
      /** バケットごとは消さなかった理由（`teardownPlanFor` が返したもの。バケットごと消した回は無い）。結果の警告が、残した保存場所の言い分けに使う。 */
      keptReasons?: StorageTeardown['keptReasons']
      /**
       * このプロジェクトのデータにも手を付けなかった回だけ true（同じ prefix を記録に持つ複製がいる・`teardownPlanFor` の `keptData`）。
       * 結果の行が「データを削除しました」ではなく「データは残しました」と言うのに使う（`storageTeardownDoneLine`）。
       */
      keptData?: true
      /**
       * このよびだしで、記録の鍵（`permissionId`）を**実際に無効にできた**ときだけ true。渡されていない・データを残した回（`keptData`。鍵には触れない）・無効にできなかった回は false。
       * 呼び手が「記録から鍵の ID を外すか」を決めるのは、これだけ（警告の件数などで決めない。0.6.24 R1-c）。
       */
      permissionRevoked: boolean
      /** 片づけ切れなかったこと（失敗ではないが黙らない）。 */
      warnings: string[]
    }
  | { ok: false; message: string }

/**
 * 保存場所を片づける。**順序を守ること**:
 *   1. 一覧して確かめる（できなければ**1件も消さずに中止**）
 *   2. `teardownPlanFor` に判断を仰ぐ
 *   3. このプロジェクトのプレフィックスの中身を消す
 *   4. 計画が言うときだけ、バケットごと消す
 *   5. **そのあとで**鍵を無効にする
 *
 * 2 の前に、ほかのプロジェクトの記録を読む（同じ親フォルダの兄弟の env.json・state.json。読めなければ「わからない」＝バケットは消さない）。
 * このとき**このプロジェクトの prefix も渡す**: 兄弟が同じバケットの同じ prefix を記録に持つ（複製）なら、`teardownPlanFor` はデータにもバケットにも手を付けない
 * （3・4 を飛ばす。`keptData` を返す）。複製から元のデータを消さない（0.6.24 I-1）。
 *
 * 5 が最後なのは、鍵を先に無効にすると 3・4 が 403 で失敗するため
 * （中身を消せないままバケットだけ残り、課金が続く）。
 *
 * `permissionId` が無い（古いプロジェクトで記録していない）ときは、
 * **鍵の無効化だけ飛ばして片づけは続ける**。
 *
 * **データを残した回（`decision.keptData`＝複製かもしれない）は、鍵も無効にしない**（0.6.24 R1-c）。複製は元の記録の鍵 ID を写すので、無効にすると元の現役の鍵が切れる。
 * 複数の保存場所を順に回すときの「1件でも複製なら鍵に触らない」は、呼び手が `placementsHaveTwinRisk` で先に確かめて `permissionId` を渡さない形で守る。
 */
export async function teardownStorage(opts: {
  storage: StorageTeardownClientLike
  placement: StoragePlacement
  permissionId?: string | null
  /**
   * このプロジェクトのフォルダ（絶対パス）。**必須**——ほかのプロジェクトの記録を読む起点（親フォルダの兄弟）。
   * 渡し忘れ・絶対パスでない値は「わからない」と読まれ、バケットは消されない（消さない側に倒れる）。
   */
  projectDir: string
}): Promise<StorageTeardownOutcome> {
  const bucket = opts.placement.bucket

  // **消す前に必ず一覧して確かめる。**
  let allKeys: string[]
  try {
    allKeys = await opts.storage.listAllKeys(bucket)
  } catch (e: any) {
    // 確かめられないなら消さない。**「たぶん空」で消すのがいちばん危ない。**
    return { ok: false, message: `保存場所『${bucket}』の中身を確認できないため、削除を中止しました: ${e?.message ?? e}` }
  }

  // **ほかのプロジェクトの記録も見る**（一覧に出ない利用者がいる）。バケットごと消すかの判断だけに使う。
  const recordUsers = bucketUsersFromRecords(opts.projectDir, bucket, opts.placement.prefix)
  const decision = teardownPlanFor(opts.placement, allKeys, recordUsers)
  try {
    if (decision.deletePrefix) {
      const mine = allKeys.filter(k => k.startsWith(decision.deletePrefix as string))
      if (mine.length > 0) await opts.storage.deleteKeys(bucket, mine)
    }
    if (decision.deleteBucket) await opts.storage.deleteBucket(bucket)
  } catch (e: any) {
    return { ok: false, message: `保存場所『${bucket}』の削除に失敗しました: ${e?.message ?? e}` }
  }

  // 鍵も無効にする。残すと、消したはずの保存場所へ届く鍵が生き続ける。**データを残した回（複製かもしれない）は無効にしない**（元の現役の鍵が切れる）。
  const warnings: string[] = []
  let permissionRevoked = false
  if (opts.permissionId && !decision.keptData) {
    try { await opts.storage.deletePermission(opts.permissionId); permissionRevoked = true }
    catch { warnings.push(KEY_REVOKE_FAILED_WARNING) }
  }

  return {
    ok: true, deletedBucket: decision.deleteBucket, note: decision.note, permissionRevoked, warnings,
    ...(!decision.deleteBucket && decision.keptReasons ? { keptReasons: decision.keptReasons } : {}),
    ...(decision.keptData ? { keptData: true as const } : {}),
  }
}
