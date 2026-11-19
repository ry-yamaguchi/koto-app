// writeFixRead.ts — 「🛠 AIに修正させる」が、印のファイルをいまの内容で読む口。
// プロジェクトの中だけを読む（リンクで外を指していても読まない）。大きいファイル・ふつうでないファイルは読まない。

import { readTextInsideDirFs, type InsideDirRead } from './readInsideDirFs'
import { WRITE_CHECK_READ_LIMIT_BYTES } from '../shared/writeCheckLimits'

/** これより大きいファイルは読まない（確かめられない扱い）。上限の定義は shared/writeCheckLimits.ts。 */
export const WRITE_FIX_READ_LIMIT_BYTES = WRITE_CHECK_READ_LIMIT_BYTES

export type WriteFixRead = InsideDirRead

export function readForWriteFixFs(projectDir: string, rel: string): WriteFixRead {
  return readTextInsideDirFs(projectDir, rel, WRITE_FIX_READ_LIMIT_BYTES)
}
