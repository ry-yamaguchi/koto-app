// readInsideDirFs.ts — フォルダの中だけを読む口（main 側）。
// リンクで外を指していても読まない。ふつうのファイルで、上限以下のときだけ読む。

import * as fs from 'fs'
import * as path from 'path'

export type InsideDirRead = { state: 'text'; content: string } | { state: 'missing' } | { state: 'unreadable' }

/** dir の中の rel を読む。リンクで外を指していれば読まない。ふつうのファイルで、limitBytes 以下のときだけ読む。 */
export function readTextInsideDirFs(dir: string, rel: string, limitBytes: number): InsideDirRead {
  try {
    if (typeof dir !== 'string' || !dir || typeof rel !== 'string' || !rel) return { state: 'unreadable' }
    if (path.isAbsolute(rel)) return { state: 'unreadable' }
    const full = path.normalize(path.join(dir, rel))
    if (!full.startsWith(dir + path.sep)) return { state: 'unreadable' }
    let real: string
    try {
      real = fs.realpathSync(full)
    } catch (e) {
      return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable' }
    }
    const root = fs.realpathSync(dir)
    if (!real.startsWith(root + path.sep)) return { state: 'unreadable' }
    const st = fs.statSync(real)
    if (!st.isFile() || st.size > limitBytes) return { state: 'unreadable' }
    return { state: 'text', content: fs.readFileSync(real, 'utf-8') }
  } catch {
    return { state: 'unreadable' }
  }
}
