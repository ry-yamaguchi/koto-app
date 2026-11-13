// 認証情報の窓: 接続テストにかけた値と、保存されている値の比べ方（メモリの中だけ。値は表示も記録もしない）。
// 「まだ保存していません」は、窓全体の未保存（dirty）ではなく、**テストにかけた値がその項目の保存済みの値と違うか**で決める。

/** 比べるための形。トークンとチームIDのように複数あるときは並べる（前後の空白は無視）。 */
export function testedKey(...parts: string[]): string { return parts.map(p => p.trim()).join('\u0000') }

type EntryLike = { id: string; values: Record<string, string> }

/** 項目ごとの値の写し。読み込み時と保存の完了時に、そのときの store から取り直す。 */
export function snapshotValues(store: Record<string, { entries?: EntryLike[] } | undefined>): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  for (const st of Object.values(store)) for (const e of st?.entries ?? []) out[e.id] = { ...e.values }
  return out
}

/** その項目の保存されている値（testedKey と同じ形）。一度も保存していない項目は null。 */
export function savedKeyFor(snapshot: Record<string, Record<string, string>>, entryId: string, keys: string[]): string | null {
  const v = snapshot[entryId]
  return v ? testedKey(...keys.map(k => v[k] ?? '')) : null
}
