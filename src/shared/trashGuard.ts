// trashGuard.ts — 「ゴミ箱へ送ってよい場所か」の判断（純ロジック）。
//
// ── なぜ要るか（2026-08-20 セキュリティ点検）──────────────────────────
// `fs:trash` は**どんな絶対パスでも**ゴミ箱へ送れる作りだった。
// いまは画面側の守り（contextIsolation / sandbox / dangerouslySetInnerHTML なし /
// eval なし）が固いので**到達する道は無い**が、1枚目の守りに頼り切らない。
//
// ── 決めごと ────────────────────────────────────────────────────────
// ・ホームフォルダの**外**は送れない（`/` や `/Applications` を守る）
// ・ホーム直下（深さ1）も送れない（`~/Library` `~/Documents`、作業フォルダ自体を守る）
// ・深さ2以上なら送れる（`~/SAKURAIDE/プロジェクト` とその中身が対象）
//
// 消せる範囲を狭めすぎないこと。**プロジェクトごと削除**する機能があるので、
// 「いま開いているプロジェクトの中だけ」には狭められない。

/** 判断の結果。ダメなときは**理由をそのまま画面に出せる文**にする。 */
export type TrashCheck = { ok: true } | { ok: false; reason: string }

/**
 * その場所をゴミ箱へ送ってよいか（純関数）。
 *
 * @param home ホームフォルダの絶対パス
 * @param target 送ろうとしている絶対パス
 * @param sep パス区切り（既定 '/'）
 */
export function canTrash(home: string, target: string, sep = '/'): TrashCheck {
  const h = String(home ?? '').replace(new RegExp(`${sep}+$`), '')
  const t = String(target ?? '').replace(new RegExp(`${sep}+$`), '')
  if (!h || !t) return { ok: false, reason: '場所が指定されていません' }
  // `..` を含む道は受けない（正規化前に弾く）
  if (t.split(sep).includes('..')) return { ok: false, reason: '不正な場所です' }
  if (t === h || !t.startsWith(h + sep)) {
    return { ok: false, reason: 'ゴミ箱へ送れるのは、ホームフォルダの中のものだけです' }
  }
  const depth = t.slice(h.length + 1).split(sep).filter(Boolean).length
  if (depth < 2) {
    return { ok: false, reason: 'ホームフォルダの直下は、まとめてゴミ箱へ送れません（中のファイルやプロジェクトを選んでください）' }
  }
  return { ok: true }
}
