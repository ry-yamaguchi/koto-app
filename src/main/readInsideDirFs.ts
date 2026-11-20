// readInsideDirFs.ts — フォルダの中だけを読む口（main 側）。
// リンクで外を指していても読まない。ふつうのファイルで、上限以下のときだけ読む。

import * as fs from 'fs'
import * as path from 'path'

export type InsideDirRead = { state: 'text'; content: string } | { state: 'missing' } | { state: 'unreadable' }

type Inside = { state: 'ok'; real: string; st: fs.Stats } | { state: 'missing' } | { state: 'unreadable' }

/** dir の中の rel が、根の中にあるふつうのファイルかを確かめる（閉じ込めの判断はここだけ）。 */
function resolveInside(dir: string, rel: string): Inside {
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
  if (!st.isFile()) return { state: 'unreadable' }
  return { state: 'ok', real, st }
}

/** dir の中の rel を読む。リンクで外を指していれば読まない。ふつうのファイルで、limitBytes 以下のときだけ読む。 */
export function readTextInsideDirFs(dir: string, rel: string, limitBytes: number): InsideDirRead {
  try {
    const r = resolveInside(dir, rel)
    if (r.state !== 'ok') return { state: r.state }
    if (r.st.size > limitBytes) return { state: 'unreadable' }
    return { state: 'text', content: fs.readFileSync(r.real, 'utf-8') }
  } catch {
    return { state: 'unreadable' }
  }
}

export type ScanFileRead =
  | { state: 'text'; content: string; bytes: number }
  | { state: 'missing' }
  | { state: 'too-large' }
  | { state: 'binary' }
  | { state: 'unreadable' }

/** dir の中の rel を点検用に読む。リンクで外を指していれば読まない。大きさは limitBytes まで。先頭 sniffBytes に NUL があればバイナリ。 */
export function readScanFileInsideDirFs(dir: string, rel: string, limitBytes: number, sniffBytes: number): ScanFileRead {
  try {
    const r = resolveInside(dir, rel)
    if (r.state !== 'ok') return { state: r.state }
    if (r.st.size > limitBytes) return { state: 'too-large' }
    const fd = fs.openSync(r.real, 'r')
    try {
      const head = Buffer.alloc(Math.min(sniffBytes, r.st.size))
      const n = fs.readSync(fd, head, 0, head.length, 0)
      if (head.subarray(0, n).includes(0)) return { state: 'binary' }
    } finally {
      fs.closeSync(fd)
    }
    const buf = fs.readFileSync(r.real)
    if (buf.length > limitBytes) return { state: 'too-large' }
    return { state: 'text', content: buf.toString('utf-8'), bytes: buf.length }
  } catch {
    return { state: 'unreadable' }
  }
}
