// writeFixRead.ts — 「🛠 AIに修正させる」が、印のファイルをいまの内容で読む口。
// プロジェクトの中だけを読む（リンクで外を指していても読まない）。大きいファイル・ふつうでないファイルは読まない。

import * as fs from 'fs'
import * as path from 'path'

import { WRITE_CHECK_READ_LIMIT_BYTES } from '../shared/writeCheckLimits'

/** これより大きいファイルは読まない（確かめられない扱い）。上限の定義は shared/writeCheckLimits.ts。 */
export const WRITE_FIX_READ_LIMIT_BYTES = WRITE_CHECK_READ_LIMIT_BYTES

export type WriteFixRead =
  | { state: 'text'; content: string }
  | { state: 'missing' }
  | { state: 'unreadable' }

export function readForWriteFixFs(projectDir: string, rel: string): WriteFixRead {
  try {
    if (typeof projectDir !== 'string' || !projectDir || typeof rel !== 'string' || !rel) return { state: 'unreadable' }
    if (path.isAbsolute(rel)) return { state: 'unreadable' }
    const full = path.normalize(path.join(projectDir, rel))
    if (!full.startsWith(projectDir + path.sep)) return { state: 'unreadable' }
    let real: string
    try {
      real = fs.realpathSync(full)
    } catch (e) {
      return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable' }
    }
    const root = fs.realpathSync(projectDir)
    if (!real.startsWith(root + path.sep)) return { state: 'unreadable' }
    const st = fs.statSync(real)
    if (!st.isFile() || st.size > WRITE_FIX_READ_LIMIT_BYTES) return { state: 'unreadable' }
    return { state: 'text', content: fs.readFileSync(real, 'utf-8') }
  } catch {
    return { state: 'unreadable' }
  }
}
