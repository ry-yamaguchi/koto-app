// registryProvision.ts — コンテナレジストリの作成に「分類」（Description/Tags）を添える処理を
// 一元化する（roadmap #36）。ipcMain ハンドラ（src/main/ipc/cloud.ts の cloud:ensureRegistry）から
// 呼べる形にしつつ、client を差し替え可能にして純粋にテストできるようにする
// （B'-3a/3d-2a と同じ「io ports」方式・掟10）。
//
// ⚠️ Description/Tags を「作成時に設定できるか」は未確認（掟1）。推測で「できる」と実装しない。
// ここでやること:
//   1. まず Description/Tags を付けて作成を試す（呼び出し側が既に「対応していない」と
//      分かっていれば、最初から付けずに試す＝毎回は試さない）
//   2. 名前が予約済み（重複）で失敗したら、サフィックスを付けて作り直す
//   3. Description/Tags が原因（かもしれない）失敗のときは、それを外して再試行する
//      （分類は「あれば嬉しい」もので、公開そのものを止める理由にはしない）
//   4. 作成が成功しても、それだけで「付いた」と思わない。分類を付けたまま作成が
//      通った場合だけ、読み直して実際に反映されているかを確かめる
//      （「成功」と読んだ応答は結果を確かめるまで成功ではない・掟10）
//
// ⚠️ 2と3は「どちらが先に起きるか分からない」（2026-09-09 検分・指摘1で実害と判明）。
// 分類つきの作成が名前衝突と無関係な理由（例: 400「Description is not allowed」）で失敗し、
// **分類を外した再試行が同じ label のまま**行われると、そこで初めて名前衝突（409）が
// 表面化することがある。直す前のコードは「衝突の作り直し」を分類フォールバックより前の
// 1回きりの分岐にしていたため、この順で失敗すると打ち止めになり、**公開そのものが
// 止まっていた**（破棄した直後の名前再利用クールダウンと重なると特に起きやすい）。
// いまは「衝突なら作り直す」「分類が疑わしければ外す」を、それぞれ**1回だけ使える
// 回復手段（エスケープハッチ）**としてループで扱う。どちらが先に尽きても、残っている
// 方の手段で回復できる。両方使い切って（＝作り直した名前・分類なしでも）失敗したら、
// それ以上は試さない。

import { randomBytes } from 'crypto'
import {
  buildRegistryMeta,
  extractRegistryId,
  extractRegistryMetaApplied,
  apiErrorMessage,
  type RegistryMeta,
  type RequestResult,
} from './client'

/** この処理が必要とするクライアントの最小の形（実体は SakuraCloudClient。テストでは偽物を渡す）。 */
export type RegistryProvisionClient = {
  createContainerRegistry(zone: string, opts: { name: string; subdomainLabel: string; meta?: RegistryMeta }): Promise<RequestResult>
  getContainerRegistry(zone: string, id: string): Promise<RequestResult>
}

export type RegistryProvisionResult =
  | {
      ok: true
      id: string
      /** 実際に作成に使われた名前（衝突回避でサフィックスが付くことがある）。 */
      label: string
      /**
       * 分類（Description/Tags）が実際に反映されていると確認できたか。
       * - true: 読み直して確認できた
       * - false: 分類を付けずに作成し、それが「最初から」だった（metaKnownUnsupported）、
       *   または読み直して**実際に付いていなかった**——「分かっている」ときだけ false にする
       * - null: 次のどちらか。次回また試してよい「不明」のまま（呼び出し側は state を
       *   上書きしないこと。指摘3: 分からないものを断定しない）
       *   (a) 分類つきの作成が失敗して外した（＝「反映されない」と確認できたわけではない。
       *       500等、分類と無関係な理由で落ちた可能性がある）
       *   (b) 分類は付けたが、読み直し（GET）自体が失敗して確認できなかった
       */
      metaSupported: boolean | null
    }
  | { ok: false; message: string }

/** 名前の予約衝突（作り直せば通る）っぽいメッセージかどうか。cloud.ts の既存判定と同じ正規表現。 */
function looksLikeNameConflict(data: unknown): boolean {
  return /利用されて|exist|重複|conflict/i.test(apiErrorMessage(data))
}

/**
 * コンテナレジストリを作成する（分類つき・フォールバック・検証込み）。
 *
 * @param metaKnownUnsupported 過去に「分類は反映されない（または作成が失敗する）」と
 *   確認済みなら true を渡す。渡すと、最初から Description/Tags を付けずに作成する
 *   （roadmap #36「次回以降は分かっている前提で振る舞う」）。省略時は毎回まず試す。
 */
export async function provisionRegistryWithMeta(
  client: RegistryProvisionClient,
  region: string,
  baseLabel: string,
  projectName: string,
  metaKnownUnsupported: boolean = false,
): Promise<RegistryProvisionResult> {
  const meta = buildRegistryMeta(projectName)
  const attemptMeta = !metaKnownUnsupported
  let label = baseLabel

  const create = (withMeta: boolean): Promise<RequestResult> =>
    client.createContainerRegistry(
      region,
      withMeta ? { name: label, subdomainLabel: label, meta } : { name: label, subdomainLabel: label },
    )

  let metaIncluded = attemptMeta
  // 分類つきの作成に一度でも失敗して外したか（＝「反映されないと分かった」のではなく
  // 「今回は外さざるを得なかった」）。metaKnownUnsupported で最初から付けなかった場合とは
  // 区別する（指摘3: 「不明」を「未対応」と書かない）。
  let metaDroppedAfterFailure = false
  // 名前の作り直し（サフィックス付与）を、まだ使っていないか。
  let suffixAvailable = true

  let r = await create(metaIncluded)

  // 「衝突なら作り直す」「分類が疑わしければ外す」を、それぞれ1回だけ使える回復手段として
  // ループで扱う（指摘1）。どちらが先に尽きても、残っている方の手段で回復できる:
  //   例: 分類つきで400（分類と無関係かもしれない理由）→ 分類を外して再試行 → 外した先で
  //       初めて409（名前衝突）が表面化 → まだ使っていないサフィックス作り直しで拾う。
  // 両方使い切って（＝作り直した名前・分類なしでも）失敗したら、それ以上は試さない。
  while (r.dryRun === false && !r.ok) {
    if (suffixAvailable && looksLikeNameConflict(r.data)) {
      // 例: flatearth が予約中 → flatearth-a1b2 で作り直す（削除後の名前再利用クールダウン回避）。
      suffixAvailable = false
      label = label.slice(0, 22).replace(/-+$/, '') + '-' + randomBytes(2).toString('hex')
      r = await create(metaIncluded)
      continue
    }
    if (metaIncluded) {
      // Description/Tags が原因（かもしれない）失敗。外して同じ label のまま再試行する
      // （roadmap #36。公開そのものを壊さない）。
      metaIncluded = false
      metaDroppedAfterFailure = true
      r = await create(metaIncluded)
      continue
    }
    // 両方の回復手段を使い切った。これ以上は試さない。
    break
  }

  if (!(r.dryRun === false && r.ok)) {
    const detail = r.dryRun === false ? apiErrorMessage(r.data) : ''
    return {
      ok: false,
      message:
        r.dryRun === false
          ? `レジストリ作成に失敗しました（HTTP ${r.status}）${detail ? ' — ' + detail : ''}`
          : '予期しないドライラン応答',
    }
  }

  const id = extractRegistryId(r.data)
  if (!id) return { ok: false, message: 'レジストリのIDを取得できませんでした（レスポンス形を要確認）' }

  if (!metaIncluded) {
    // 分類を付けずに作成した。
    // - metaDroppedAfterFailure（分類つきの作成が失敗して外した）: 「反映されない」と
    //   確認できたわけではない。次回また試せるよう null（不明）のままにする（指摘3）。
    // - それ以外（metaKnownUnsupported で最初から付けなかった）: 従来どおり false。
    return { ok: true, id, label, metaSupported: metaDroppedAfterFailure ? null : false }
  }

  // 成功しても、それだけで「付いた」と思わない。読み直して確かめる（掟10）。
  const check = await client.getContainerRegistry(region, id)
  if (!(check.dryRun === false && check.ok)) {
    // 読み直し自体が失敗した＝分かっていない。次回また試せるよう「不明」のままにする。
    return { ok: true, id, label, metaSupported: null }
  }
  return { ok: true, id, label, metaSupported: extractRegistryMetaApplied(check.data, meta) }
}
