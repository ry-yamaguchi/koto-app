// readPathHint.ts — read_file が「見つからない」で失敗したとき、頭の public/ を外せば届くかを判断する（純関数・P-131）。
//
// 0.6.38-rc.1 の実機で、GLM が「a.js を読んで」に最初 public/a.js と付けて失敗した。
// 読み替えて読むことはしない（AI に正しい書き方を伝えるだけ）。書き込みでは使わない。

import { PUBLISH_DIR } from './publishRoot'

/**
 * 失敗の文に添える一文。添えないときは null。
 * 条件: 渡されたパスが `public/` で始まる・作業フォルダの名前が `public`・
 * 頭の `public/` を外したパスが作業フォルダの中に在る。
 */
export function publicPrefixHint(rel: string, rootName: string, strippedExists: boolean): string | null {
  if (rootName !== PUBLISH_DIR) return null
  const prefix = `${PUBLISH_DIR}/`
  if (!rel.startsWith(prefix)) return null
  if (!strippedExists) return null
  const stripped = rel.slice(prefix.length)
  if (!stripped) return null
  return `パスは作業フォルダ（${PUBLISH_DIR}）からの相対です。${prefix} を外して ${stripped} を指定してください`
}
