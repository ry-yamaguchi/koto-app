// storageSelection.ts — 破棄が消す保存場所を、「確認で見せたもの」だけに絞る（0.6.24 F-3。main の純関数・electron に依存しない）。
//
// ── なぜ要るか ───────────────────────────────────────────────────────────────
// 破棄の確認は、記録（env.json・state.json）から読んだ保存場所の名前を並べて「消えます」と言う。そのあとで記録が変わる
// （確認が開いている間に保存場所が足された・確認が名前を挙げられなかった）と、確認で見せていない保存場所まで消えてしまう。
// 保存場所の削除は元に戻せないデータと月額に直結するので、「見せたものだけ消す」を main の1か所で決める（掟10）。
// 画面は見せた保存場所の組（バケット名と prefix）を運ぶだけ（renderer/teardown/flow.ts の shownPlacementsOf）。
//
// ── 突き合わせは「名前と prefix の組」──────────────────────────────────────────
// 実際に消すのは prefix の配下（storageTeardown.ts）。名前だけで突き合わせると、同じバケットの別の prefix
// （別のプロジェクトのデータ）まで「見せた」ことになる。
//
// ── 安全側 ───────────────────────────────────────────────────────────────────
// 渡された値の形が違う・名前が来ない・空のときは、**1件も見せていない**として扱う（消さない）。「全部見せた」に倒さない。

import { bucketNamesText } from '../../shared/teardownSupport'

/**
 * 画面が確認で見せた保存場所1件（名前と prefix の組）。prefix が無いものは画面が `''` にして運ぶ。
 * `keepData: true` は、確認が「消しません」と言った保存場所（同じデータを使うフォルダがいる・確かめられなかった）にだけ付く。付いていれば、main は記録がいま何と言っていても
 * データにもバケットにも鍵にも触れずに残す（`mustKeepDataOf`）。付かない保存場所は今までどおり、`teardownPlanFor` が決める。
 */
export type ShownPlacement = { bucket: string; prefix: string; keepData?: true }

/** 消さなかった理由。`changed` … 見せた一覧はあるが、いまの記録の保存場所がその中に無い（確認のあとで記録が変わった）。`unnamed` … 見せた一覧が空（名前を挙げられなかった）。 */
export type SkipReason = 'changed' | 'unnamed'

/**
 * renderer から渡された値（IPC の引数。形は信用しない）を、見せた保存場所の一覧に読む。
 * 配列で、どの要素も `bucket` と `prefix` が文字列のときだけ通す。**それ以外は `null`**（「1件も見せていない」と扱う）。
 * 空の配列は `[]`（見せたものが無い）。要素は `{ bucket, prefix }` に作り直す（余計な項目は運ばない）。
 * 運ぶ項目は `keepData` だけで、**`=== true` のときだけ** `keepData: true` を付ける（`false`・無いものは付けない＝キーも作らない）。
 * `keepData` が真偽値でも無くもない値（`1`・`'true'`・オブジェクトなど）は壊れた値として、全体を `null` にする（消さない側。読めない印を「消してよい」に倒さない）。
 */
export function parseShownPlacements(x: unknown): ShownPlacement[] | null {
  if (!Array.isArray(x)) return null
  const out: ShownPlacement[] = []
  // `every` は空き要素を飛ばすので使わない（空き要素は壊れた値＝通さない）
  for (let i = 0; i < x.length; i++) {
    const e: unknown = x[i]
    if (!e || typeof e !== 'object') return null
    const { bucket, prefix, keepData } = e as { bucket?: unknown; prefix?: unknown; keepData?: unknown }
    if (typeof bucket !== 'string' || typeof prefix !== 'string') return null
    if (keepData !== undefined && typeof keepData !== 'boolean') return null
    out.push(keepData === true ? { bucket, prefix, keepData: true } : { bucket, prefix })
  }
  return out
}

/**
 * この保存場所は、確認が「消しません」と言ったものか（見せた組の中に、名前と prefix の**両方**が一致して `keepData: true` のものが1件でもある）。
 * 同じ組が2回あり片方だけ `keepData` のときも、残す側に倒す。`shown` が `null`（形が違う）なら false（そもそも見せていないので、消す前に `selectShown` が飛ばす）。
 * 消す側には働かない: false は「画面は何も言っていない」であり、消してよいことを言わない（消すかは今までどおり `teardownPlanFor` が決める）。
 */
export function mustKeepDataOf(shown: readonly ShownPlacement[] | null, p: { bucket: string; prefix: string }): boolean {
  return (shown ?? []).some(s => s.keepData === true && s.bucket === p.bucket && s.prefix === p.prefix)
}

/**
 * いまの保存場所（`current`）を、見せたもの（`tear`）と見せていないもの（`skipped`）に分ける。
 * 突き合わせは名前と prefix の**両方が一致**したときだけ（並びは `current` のまま。`shared` などの項目は `current` のものを使う＝画面からは変えられない）。
 * `shown` が `null`（形が違う）なら、見せた一覧が空と同じ。
 *
 * `why` は、飛ばしたものがあるときだけ付く: 見せた一覧が空なら `'unnamed'`、空でなければ `'changed'`。飛ばしたものが無ければ `null`。
 */
export function selectShown<P extends ShownPlacement>(
  current: readonly P[],
  shown: readonly ShownPlacement[] | null,
): { tear: P[]; skipped: P[]; why: SkipReason | null } {
  const list = shown ?? []
  const tear: P[] = []
  const skipped: P[] = []
  for (const p of current) {
    if (list.some(s => s.bucket === p.bucket && s.prefix === p.prefix)) tear.push(p)
    else skipped.push(p)
  }
  const why: SkipReason | null = skipped.length === 0 ? null : list.length === 0 ? 'unnamed' : 'changed'
  return { tear, skipped, why }
}

/** バケット名の一覧（重ならない・先に出たものが先）。同じバケットの別の prefix は1つにまとめる。 */
export function uniqueBuckets(list: ReadonlyArray<{ bucket: string }>): string[] {
  return Array.from(new Set(list.map(p => p.bucket)))
}

/** 見せていない保存場所を消さなかった理由の文。続く「…が残っています」と押し直しの案内は、呼び手の既存の文が足す。 */
export function skippedBucketsMessage(skipped: ReadonlyArray<{ bucket: string }>, why: SkipReason): string {
  const names = bucketNamesText(uniqueBuckets(skipped))
  return why === 'unnamed'
    ? `確認で保存場所の名前を挙げられなかったため、保存場所${names}は削除していません。`
    : `確認のあとで保存場所の記録が変わったため、保存場所${names}は削除していません。`
}
