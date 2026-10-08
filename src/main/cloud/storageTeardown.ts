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

import { teardownPlanFor, type StoragePlacement } from '../../shared/objectStorage'

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

export type StorageTeardownOutcome =
  | {
      ok: true
      /** バケットごと消したか（呼び出し側が記録から外すのに使う）。 */
      deletedBucket: boolean
      /** 利用者に見せる説明（`teardownPlanFor` が返したもの）。 */
      note: string
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
 * 5 が最後なのは、鍵を先に無効にすると 3・4 が 403 で失敗するため
 * （中身を消せないままバケットだけ残り、課金が続く）。
 *
 * `permissionId` が無い（古いプロジェクトで記録していない）ときは、
 * **鍵の無効化だけ飛ばして片づけは続ける**。
 */
export async function teardownStorage(opts: {
  storage: StorageTeardownClientLike
  placement: StoragePlacement
  permissionId?: string | null
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

  const decision = teardownPlanFor(opts.placement, allKeys)
  try {
    if (decision.deletePrefix) {
      const mine = allKeys.filter(k => k.startsWith(decision.deletePrefix as string))
      if (mine.length > 0) await opts.storage.deleteKeys(bucket, mine)
    }
    if (decision.deleteBucket) await opts.storage.deleteBucket(bucket)
  } catch (e: any) {
    return { ok: false, message: `保存場所『${bucket}』の削除に失敗しました: ${e?.message ?? e}` }
  }

  // 鍵も無効にする。残すと、消したはずの保存場所へ届く鍵が生き続ける。
  const warnings: string[] = []
  if (opts.permissionId) {
    try { await opts.storage.deletePermission(opts.permissionId) }
    catch { warnings.push('保存場所の鍵を無効にできませんでした') }
  }

  return { ok: true, deletedBucket: decision.deleteBucket, note: decision.note, warnings }
}
