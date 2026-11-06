// writeIfUnchangedFs.ts — 「ディスクが覚えていたとおりのときだけ書く」口の実体（electron に依存しない）。
// `fs:writeFileIfUnchanged`（ipc/fs.ts）は、ここを呼ぶだけ。
//
// 外で書き換わったファイルを、古い中身で上書きしない。画面で読み直して比べると、読んでから書くまでの間に
// 隙ができるので、**歯止めは main に置く**（読む → 比べる → 書く を同じ処理の中で続ける）。
// 比べる表は shared/editorSync.ts の `mayWriteTab` の1つ（ここで独自に決めない）。
import * as fs from 'fs'
import * as path from 'path'
import { mayWriteTab, type WriteIfUnchangedResult } from '../shared/editorSync'

/** ディスクを読んだ結果。 */
export type DiskRead = { kind: 'text'; text: string } | { kind: 'missing' } | { kind: 'unreadable' }

/**
 * 読めなかった理由の分類。**ファイルが無い（ENOENT）だけを `missing`**、ほかはすべて `unreadable`（権限・フォルダ・I/O など）。
 * 例外の文面は読まない（エラーコードだけを見る）。迷ったら書かない側（`unreadable`）に倒す。
 */
export function classifyReadFailure(e: unknown): 'missing' | 'unreadable' {
  return (e as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? 'missing' : 'unreadable'
}

/** `filePath` を読む。**投げない**。読めたら中身、読めなければ `classifyReadFailure` の分類。 */
export function readDiskFs(filePath: string): DiskRead {
  try {
    return { kind: 'text', text: fs.readFileSync(filePath, 'utf-8') }
  } catch (e) {
    return { kind: classifyReadFailure(e) }
  }
}

/**
 * 読めるかを聞く（読むだけ。`fs:readCheck`）。読み直しに失敗した画面が、消えたのか読めないのかを言い分けるのに使う。
 * 保存の口と同じ `readDiskFs` を通るので、分類は1つ（ファイルが無い `ENOENT` だけが `missing`）。
 */
export function readCheckFs(filePath: string): 'readable' | 'missing' | 'unreadable' {
  const read = readDiskFs(filePath)
  return read.kind === 'text' ? 'readable' : read.kind
}

/**
 * 書く直前に読み、`expected` と同じときだけ `content` を書く。
 *   ・`expected` が文字列 … ディスクがそれと同じなら書く。外で変わっていれば書かず `changed`（`disk` に今の中身）。
 *     ファイルが無ければ書かず `missing`。読めなければ書かず `unreadable`。
 *   ・`expected` が null … 「無いときだけ作る」。無ければ作る（親フォルダも掘る）。あれば書かず `changed`。読めなければ `unreadable`。
 *   ・ディスクがすでに `content` と同じ中身のときは、書かずに ok を返す（書いても同じ）。
 * 指定が正しくない回（`expected` が文字列でも null でもない、など）は、書かずに投げる（不明な値を「同じ」と読まない）。
 * 書くのに失敗したとき（権限・空き容量）は、`fs:writeFile` と同じく例外のまま投げる。ただし書きかけのファイルは残さない
 * （途中で切れた中身を、次の保存が「外で書き換えられた」と読んでしまうため）: 読んでいた中身へ戻し、無かったファイルは消す。
 */
export function writeFileIfUnchangedFs(filePath: string, content: string, expected: string | null): WriteIfUnchangedResult {
  if (typeof filePath !== 'string' || !filePath || typeof content !== 'string' || (expected !== null && typeof expected !== 'string')) {
    throw new Error('保存の指定が正しくないため、書いていません。')
  }
  const read = readDiskFs(filePath)
  if (read.kind === 'unreadable') return { ok: false, reason: 'unreadable' }
  const disk = read.kind === 'text' ? read.text : null

  const verdict = mayWriteTab({ baseline: expected, content, disk })
  if (verdict === 'skip') return { ok: true } // ディスクがすでに書きたい中身と同じ
  if (verdict === 'conflict') {
    if (disk === null) return { ok: false, reason: 'missing' } // expected が文字列なのに、ファイルが無い
    return { ok: false, reason: 'changed', disk }
  }
  if (disk === null) fs.mkdirSync(path.dirname(filePath), { recursive: true }) // 作り直す回（親フォルダも消えていてよい）
  try {
    fs.writeFileSync(filePath, content, 'utf-8')
  } catch (e) {
    try {
      if (disk === null) fs.rmSync(filePath, { force: true })
      else fs.writeFileSync(filePath, disk, 'utf-8')
    } catch { /* 戻せなくても、元の失敗をそのまま伝える */ }
    throw e
  }
  return { ok: true }
}
