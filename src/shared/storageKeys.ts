// storageKeys.ts — 保存場所の鍵（パーミッション）を、いつ・どれを片づけるかの判断（純ロジック）。
//
// ── なぜ要るか（2026-08-14 実機で発覚）────────────────────────────────
// 公開のたびに新しい鍵を発行し、**デプロイAPIが 200 を返したその場で古い鍵を消して**
// いた。だが AppRun のデプロイは非同期で、新しいコンテナが立ち上がるまで
// **古いコンテナが動き続ける**。その古いコンテナは、たったいま消された鍵を使う。
//
//   公開 → 新しい鍵を載せる → 200 → **古い鍵を消す** → 古いコンテナが 403 → 落ちる
//
// 新しい版の起動に失敗すれば、そのまま壊れ続ける。実際そうなった。
// **「動いた」と確かめてから消す。**（v0.3.15 の起動確認をそのまま使う）
//
// ── もう一つの症状: 鍵がたまる ────────────────────────────────────────
// 片づけるのは「記録している1件」だけなので、記録がずれると孤児が残る。
// 実機では5件たまり、**消えたバケット向けのもの**や**権限が空のもの**まであった。
// 鍵が残るということは、**消したはずの保存場所へ届く鍵が生き続ける**ということでもある。

/** さくらのパーミッション（片づけの判断に要る分だけ）。 */
export type StoragePermission = {
  id: string
  /** Koto が付ける名前（`koto-<プロジェクト名>`）。 */
  displayName: string
}

/** このプロジェクトの鍵に付ける名前。**他のプロジェクトのものを消さないための目印。** */
export function permissionNameFor(projectName: string): string {
  return `koto-${projectName}`
}

/**
 * 片づけてよい鍵を選ぶ（純関数）。
 *
 * **他のプロジェクトのものには絶対に触れない。** 名前が一致するものだけを対象にし、
 * さらに**いま使っている1件は必ず残す**。ここを間違えると、動いているアプリを
 * 自分の手で壊すことになる（2026-08-09 のレジストリ取り違えと同じ轍）。
 *
 * @param keepId いま使っている鍵。**null のときは何も消さない**
 *   （どれが現役か分からない状態で消すのは、いちばん危ない）
 */
export function permissionsToCleanUp(opts: {
  all: readonly StoragePermission[]
  projectName: string
  keepId: string | null
}): string[] {
  if (!opts.keepId) return []
  const mine = permissionNameFor(opts.projectName)
  return (opts.all ?? [])
    .filter(p => p && p.displayName === mine && String(p.id) !== String(opts.keepId))
    .map(p => String(p.id))
}

/** 応答から鍵の一覧を読む（形が違っても落ちない）。 */
export function parsePermissions(data: unknown): StoragePermission[] {
  const d = (data ?? {}) as Record<string, unknown>
  const rows = Array.isArray(d.data) ? d.data : []
  return rows
    .map((r: any) => ({ id: String(r?.id ?? ''), displayName: String(r?.display_name ?? '') }))
    .filter(p => p.id.length > 0)
}
