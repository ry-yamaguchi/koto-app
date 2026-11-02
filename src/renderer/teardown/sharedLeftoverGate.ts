// teardown/sharedLeftoverGate.ts — プロジェクトの削除が、共用型の記録の残りを破棄する段（'sakura-apprun'。共用型の行が無い回）を走らせるかの「門」（純関数）。
//
// 門は1つ（掟10。二重に書かない）。次の2か所が同じこの関数を通る。
//   ・開いたときに、段を足すか（projectDeletePlan.ts の sharedLeftoverStepOf。記録だけで決まる）
//   ・走らせる直前に、読み直した記録へかけ直す（projectDelete.ts の teardownPublished → flow の hasWork。同じ押しで済んだ段の分も引く）
// 外から来る値（読み直した記録・同じ押しの結果）は、形が読めなければ**走らせる側**に倒す（飛ばせるのは、全部の条件が読めて満たされたときだけ）。

import { isKeptPlacement } from '../../shared/keptDataNote'
import { sharedLeftoverNoun, sharedRegistryCounted } from './targets/shared'
import type { ShownPlacement } from './types'
import type { SharedLeftover } from './projectDeletePlan'

/** 門に渡す、記録の外の事実。渡さない回は記録だけで決まる（開いたときの plan）。 */
export type SharedLeftoverGateOptions = {
  /**
   * 同じ押しで、HANAMII の段が `ok:true` で済ませた保存場所（確認で見せた名前と prefix の組）。HANAMII が202・失敗・キャンセル・例外だった回は渡さない。
   * HANAMII の `ok:true` は、確認で見せた組の全部を処理した（見せていない組があれば main は ok:false で止まる）ことを言う。
   */
  handled?: readonly ShownPlacement[]
  /** 読み直した記録の `keyRecorded`。**false のときだけ**、鍵の片づけが要らない（無効化は共用型の段にしかできない）。 */
  keyRecorded?: boolean
  /** 読み直した記録の `stateOnlyBuckets`（設定から外した保存場所）。空の配列のときだけ、無いと読む。 */
  stateOnlyBuckets?: readonly string[]
}

/**
 * 残りの段を飛ばしてよいか: 同じ押しで HANAMII が済ませた保存場所だけが残りで、ほかに仕事が無いとき。次の**すべて**を満たすときだけ true。
 *  ・HANAMII が済ませた組（handled）が1件以上ある（空＝保存場所の設定を読めなかった回は、飛ばさない）
 *  ・アプリが無い・数えるレジストリが無い
 *  ・記録の鍵が残っていない（keyRecorded が false。欠け・不明は残っている側）
 *  ・設定から外した保存場所が無い（stateOnlyBuckets が空の配列。配列でなければ、ある側）
 *  ・記録の保存場所の全部が、handled のどれかと名前と prefix の**両方**で一致する（名前だけで比べると、同じバケットの別の prefix の残りを飛ばす）
 */
function onlyHandledStorageRemains(left: Pick<SharedLeftover, 'appNames' | 'placements'>, registryCounted: boolean, options: SharedLeftoverGateOptions | undefined): boolean {
  const handled = options?.handled
  if (!Array.isArray(handled) || handled.length === 0) return false
  if (left.appNames.length > 0 || registryCounted) return false
  if (options?.keyRecorded !== false) return false
  if (!Array.isArray(options.stateOnlyBuckets) || options.stateOnlyBuckets.length > 0) return false
  return left.placements.every(p => !!p && handled.some(h => !!h && h.bucket === p.bucket && h.prefix === p.prefix))
}

/**
 * 残りが、**全部「消さずに残す」保存場所だけ**か（アプリが無く・数えるレジストリが無く・保存場所が1件以上で、全件に `keep` がある）。
 * 1件でも `keep` の無い保存場所があれば偽（混在は消す保存場所があるので段を足す）。`keep` が無い・形が読めない値は「消す側」に読む
 * （`keep` は `cloud:twinFacts` が読めた回にだけ付き、付かなければ今までどおり段を足す）。
 */
function allStorageKept(left: Pick<SharedLeftover, 'appNames' | 'placements'>, registryCounted: boolean): boolean {
  if (left.appNames.length > 0 || registryCounted || left.placements.length === 0) return false
  return left.placements.every(p => isKeptPlacement(p))
}

/**
 * 門の、**記録（共用型の記録の残り）と、同じ押しで済んだ段**で決まる部分: 残りの段を走らせるなら、残りの呼び名を返す。走らせない回は null。
 * 走らせるのは、次の**すべて**を満たすとき。
 *  ・appNames・placements が配列（形が読めない値は走らせる側に倒さない）
 *  ・残りに、アプリ・保存場所・**数えるレジストリ**（sharedRegistryCounted。借り手のいるレジストリだけが残る回は足さない）のどれかがある
 *  ・保存場所が**全部「消さずに残す」**（`keep` がある。同じデータを使うフォルダがいる・確かめられない）だけが残りではない（allStorageKept）。
 *    アプリも数えるレジストリも無く、保存場所が全部 `keep` なら、破棄の段は何も消さないので足さない（赤い箱が「残ります」と言い、フォルダはそのまま移る）。
 *    一部だけ `keep` なら足す（消す保存場所がある）。`keep` は読めた回だけ付くので、読めなかった回（付かない）は足す側に倒れる
 *  ・同じ押しで HANAMII が済ませた保存場所だけが残りではない（onlyHandledStorageRemains。options を渡した回だけ）
 * **同じこの1つを、2か所が使う**（上の冒頭）。options を渡さない呼び方は、記録だけで決まる。
 */
export function sharedLeftoverGateOf(
  left: Pick<SharedLeftover, 'appNames' | 'placements' | 'registryName' | 'registryUsers'>,
  options?: SharedLeftoverGateOptions,
): { noun: string | null } | null {
  if (!Array.isArray(left.appNames) || !Array.isArray(left.placements)) return null
  const counted = sharedRegistryCounted(left)
  if (left.appNames.length === 0 && left.placements.length === 0 && !counted) return null
  if (allStorageKept(left, counted)) return null
  if (onlyHandledStorageRemains(left, counted, options)) return null
  return { noun: sharedLeftoverNoun(left, counted) }
}
