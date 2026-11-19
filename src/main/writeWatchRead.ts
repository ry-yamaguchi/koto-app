// writeWatchRead.ts — 書いたあとの点検（writeWatch）のために、ファイルをいまの内容で読む。
// さくらのAI Engine の経路と Claude の経路が同じ読み方を使う（読み方の定義はここだけ・上限は shared/writeCheckLimits.ts の1か所）。

import * as fs from 'fs'
import { WRITE_CHECK_READ_LIMIT_BYTES } from '../shared/writeCheckLimits'

/** これより大きいファイルは読まない（点検しない）。上限の定義は shared/writeCheckLimits.ts。 */
export const WATCH_READ_LIMIT_BYTES = WRITE_CHECK_READ_LIMIT_BYTES

/** 点検のためにファイルを読む。読めない・大きすぎるときは null（点検しない）。 */
export async function readForWatch(absPath: string): Promise<string | null> {
  try {
    if (fs.statSync(absPath).size > WATCH_READ_LIMIT_BYTES) return null
    return fs.readFileSync(absPath, 'utf-8')
  } catch {
    return null
  }
}
