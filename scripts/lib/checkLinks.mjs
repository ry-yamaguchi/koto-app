// checkLinks.mjs — リンク切れ検査（scripts/check-links.mjs）の判断部分。ネットワークには出ない純関数だけを置く。
//
// ⚠️ 抽出0件で黙って通さない（P-148）:
//   読み先のファイルの形が変わって URL が1件も読めなくなったとき、「切れたリンクは無い」と
//   緑で終わると見張りが止まったことに誰も気づけない。
//   抽出0件は読み先がずれたと見なして失敗にする（料金の見張りと同じ考え。終了コードは 1）。
//   Link Check の失敗として知らせれば足りるので 1 のまま。check-links.mjs の読み込みの失敗（catch）は
//   別物として 2 にしてある（1 = 検査の結果が失敗、2 = 検査そのものができなかった）。

/** 読み先が空だったときの文（check-links.mjs が表示する） */
export const NO_URLS_MESSAGE =
  'serviceUrl が見つかりませんでした（targetProfiles.ts / ragPacks.ts の形が変わり、読み先がずれた可能性があります）。'

/**
 * 2つのファイルの中身から検査対象の URL を重複なしで拾う。
 * @param {string} profilesSrc targetProfiles.ts の中身（serviceUrl: '...'）
 * @param {string} ragSrc ragPacks.ts の中身（url: '...'）
 * @returns {string[]}
 */
export function extractServiceUrls(profilesSrc, ragSrc) {
  const urls = [...String(profilesSrc ?? '').matchAll(/serviceUrl:\s*'([^']+)'/g)].map((m) => m[1])
  const ragUrls = [...String(ragSrc ?? '').matchAll(/url:\s*'([^']+)'/g)].map((m) => m[1])
  return [...new Set([...urls, ...ragUrls])]
}

/**
 * 終了コードを決める。0件 → 1（読み先ずれ）・結果の件数が urls と違う → 1・1件でも ok でない（通信失敗 status null を含む）→ 1・全部 ok → 0。
 * @param {{ urls: string[], results: { ok: boolean }[] }} input
 * @returns {0 | 1}
 */
export function exitCodeForLinks({ urls, results }) {
  if (urls.length === 0) return 1
  // 調べ切れていない（結果が足りない・空）のに成功にしない
  if (results.length !== urls.length) return 1
  return results.every((r) => r.ok === true) ? 0 : 1
}
