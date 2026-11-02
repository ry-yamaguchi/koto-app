// keptDataNote.ts — 保存場所のデータに手を付けない（「消しません」「残ります」）ときの文の作り手（純関数）。
//
// 破棄の本体（objectStorage.ts の teardownPlanFor）が結果に書く理由の文と、確認・削除の画面・手順6の行が言う「残ります」の文は、
// ここの関数だけが作る（同じことを言う文を2か所で書かない）。受け取る `keep` の形は twinFactsTypes.ts の PlacementKeep（読めない値にも耐える緩い型で受ける）。
//
// このファイルは他の shared のファイルを import しない（teardownSupport.ts・objectStorage.ts の両方がここを使うので、循環させない）。
// 保存場所の名前を『』で並べる整形は teardownSupport.ts の bucketNamesText の1つだけなので、ここは並べ済みの文字列を受け取る。

/**
 * 同じ公開の記録・同じデータを持つ、ほかのフォルダの名前を文に並べる（`フォルダ『A』・『B』`）。複製の断りの文・データを残した文・
 * プロジェクトの削除の赤い箱の文が、同じこれを通る（`『』` で囲む整形を、複製の話で3つ書かない）。
 */
export function folderNamesText(names: readonly string[]): string {
  return `フォルダ${names.map(n => `『${n}』`).join('・')}`
}

/**
 * 消さずに残す保存場所か。`keep` が真（値のあるもの）なら残す側。`keep` が無い・null・偽は消す側（今までどおり）。
 * 形の読めない値（オブジェクトでない真の値）も残す側に数える——消すと言い切る側へ倒さない。
 * 引数は、`keep` を持つかもしれないどんな形の保存場所でもよい（確認の材料・削除の画面の材料・共用型の記録）。
 */
export function isKeptPlacement(p: unknown): boolean {
  return !!(p as { keep?: unknown } | null | undefined)?.keep
}

/**
 * 同じデータを使うフォルダがいると確かめられた `keep` か（理由が `twin` で、フォルダ名が1件以上）。それ以外（確かめられなかった・読めない値）は偽。
 * 理由の文（keptDataReasonNote）と、「ほかのプロジェクトも使っているため残した」の事実（keptNothingReply.ts の `keptBucketsUsedByOthers`）が、同じこの1つで決める。
 */
export function isTwinKeep(keep: { risk?: unknown; folders?: unknown } | null | undefined): boolean {
  return keep?.risk === 'twin' && Array.isArray(keep.folders) && keep.folders.length > 0
}

/**
 * 保存場所を消さずに残す理由の文（`teardownPlanFor` が結果の note に書く文と、確認・削除の画面が言う文は、同じこれ）。
 *   ・`twin` … 「フォルダ『A』も同じデータを使っています。」
 *   ・`unread` … 「フォルダ『A』の記録を読めないため、同じデータを使っているか確かめられませんでした。」
 *     （フォルダが分からないときは「ほかのフォルダの記録を読めないため、…」）
 * 理由が読めない値（twin でフォルダが無い・知らない種類）は、確かめられなかった側の文にする（使っていると言い切らない）。
 */
export function keptDataReasonNote(keep: { risk?: unknown; folders?: unknown } | null | undefined): string {
  const folders: readonly string[] = Array.isArray(keep?.folders) ? keep.folders : []
  if (isTwinKeep(keep)) return `${folderNamesText(folders)}も同じデータを使っています。`
  return folders.length > 0
    ? `${folderNamesText(folders)}の記録を読めないため、同じデータを使っているか確かめられませんでした。`
    : 'ほかのフォルダの記録を読めないため、同じデータを使っているか確かめられませんでした。'
}

/**
 * 「残ります」の1文。`names` は、保存場所の名前を並べ済みの文字列（teardownSupport.ts の bucketNamesText の答え）。
 * `monthly` が真なら括弧で月額が続くことを言う。確認は費用の行が月額を1回だけ言うので、確認では偽にする。
 * `reason` は理由の文（keptDataReasonNote）。理由の無い回（公開先が保存場所を片づけない）は空。
 * 保存場所を片づけない公開先の「残ります」の文（teardownSupport.ts）も、この1つから作る。
 */
export function keptDataLine(names: string, reason: string, monthly: boolean): string {
  return `保存場所${names}とその中のデータは残ります${monthly ? '（消すまで月額が続きます）' : ''}。${reason}`
}

/**
 * 残す保存場所を、理由の文が同じもの同士でまとめる（並びは最初に出た順。同じ名前は1つ）。
 * 理由が違うもの（別のフォルダが使っているものと、確かめられなかったもの）は別の文にして、どの保存場所の話かを取り違えない。
 */
export function keptDataGroups(
  placements: ReadonlyArray<{ bucket: string; keep?: { risk?: unknown; folders?: unknown } | null }>,
): Array<{ buckets: string[]; reason: string }> {
  const groups: Array<{ buckets: string[]; reason: string }> = []
  for (const p of placements) {
    const reason = keptDataReasonNote(p.keep)
    const group = groups.find(g => g.reason === reason)
    if (!group) groups.push({ buckets: [p.bucket], reason })
    else if (!group.buckets.includes(p.bucket)) group.buckets.push(p.bucket)
  }
  return groups
}

/**
 * 名前だけで言う保存場所（記録の「残っている保存場所」など）のうち、消す側のものだけを返す。
 * その名前の保存場所（`placements` の `bucket` が同じもの）が1件以上あり、全部 `keep` のものは、消さずに残すので入れない。
 * 材料に載っていない名前・材料が無い回は消す側に数える（今までどおり）。並びは `names` のまま。
 * 「残っている保存場所を削除します」の名前と、手順6の 🗄️「もう一度押すと削除します」の名前が、同じこれを通る（消さない保存場所の名前を、削除の文に入れない）。
 */
export function bucketsNotKept(
  names: readonly string[],
  placements: ReadonlyArray<{ bucket?: unknown; keep?: unknown } | null | undefined> | null | undefined,
): string[] {
  return names.filter(name => {
    const mine = (placements ?? []).filter(p => !!p && p.bucket === name)
    return !(mine.length > 0 && mine.every(p => isKeptPlacement(p)))
  })
}

/**
 * 前回の破棄・削除で保存場所だけが残った回の、先頭の一文（保存場所を消さない回。「削除します」と言わず、事実だけを言う）。
 * `verb` は流れの言葉（共用型・HANAMII は「破棄」、専有型は「削除」）。
 */
export function storageOnlyLeftoverNote(verb: '破棄' | '削除'): string {
  return `前回の${verb}で、保存場所だけが残っています。`
}
