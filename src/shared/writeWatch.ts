// writeWatch.ts — 1回のターンで AI が書いたファイルを控えておき、ターンの終わりに、残っている問題だけを1つにまとめる。
//
// 書く前の内容（before）は、そのターンで初めて渡されたときだけ覚える。終わりには「いまの内容」を読み直して比べるので、
// ターンの途中で AI 自身が直した分は出ない。読めないファイルや大きすぎるファイルは、何も言わずに飛ばす
// （「問題なし」とは言わない）。値そのものは、どこにも持たない・返さない。

import { findingsInWrite } from './writeCheck'
import { writeCheckNotice, type WriteCheckNotice, type WriteFinding } from './securityFindings'
import { WRITE_CHECK_MAX_CHARS, WRITE_CHECK_MAX_FILES } from './writeCheckLimits'

export interface WriteWatchOptions {
  /** 表示するパスの基準にするフォルダ（絶対パス）。 */
  displayRoot: string
  /** 絶対パスのファイルの、いまの内容。読めなければ null。 */
  read(absPath: string): Promise<string | null>
  /** 1回のターンで控えるファイルの数。 */
  maxFiles?: number
  /** これより長いファイルは見ない。 */
  maxChars?: number
}

export interface WriteWatch {
  /** 書く直前に呼ぶ。absPath は絶対パス。before は旧内容（新しいファイルは null）。 */
  touch(absPath: string, before: string | null): void
  /** 控えたファイルを読み直して点検する。問題が無ければ null。終わると控えは空に戻る。 */
  finish(): Promise<WriteCheckNotice | null>
}

function displayPath(root: string, abs: string): string {
  const base = root.replace(/\/+$/, '')
  if (base && abs.startsWith(base + '/')) return abs.slice(base.length + 1)
  const name = abs.split('/').filter(Boolean).pop()
  return name ?? abs
}

export function createWriteWatch(opts: WriteWatchOptions): WriteWatch {
  const maxFiles = opts.maxFiles ?? WRITE_CHECK_MAX_FILES
  const maxChars = opts.maxChars ?? WRITE_CHECK_MAX_CHARS
  let seen = new Map<string, string | null>()

  return {
    touch(absPath, before) {
      if (seen.has(absPath)) return
      if (seen.size >= maxFiles) return
      seen.set(absPath, before)
    },
    async finish() {
      const entries = [...seen.entries()]
      seen = new Map()
      const items: { file: string; findings: WriteFinding[] }[] = []
      for (const [abs, before] of entries) {
        try {
          const after = await opts.read(abs)
          if (after === null || after.length > maxChars) continue
          const file = displayPath(opts.displayRoot, abs)
          const findings = findingsInWrite({ path: file, before, after })
          if (findings.length > 0) items.push({ file, findings })
        } catch {
          // 読めない・点検できないファイルは、何も言わずに飛ばす
        }
      }
      return writeCheckNotice(items)
    },
  }
}
