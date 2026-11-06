// 壊れて読めなかった記録（chat.json など）の読み方と、その写しの作り方（0.6.26）。
// electron に依存しない（本物の一時フォルダで直接テストできる）。
//
// 読めなかった記録を「無い」と同じに返すと、呼び出し側は空の会話から始め、最初の保存で壊れた
// 元のファイルを置き換えてしまう。そこで、読み込んだ時点で元のファイルを
// `<元の名前>.broken-<日時>` へ写してから先へ進む。写すだけで、元のファイルは消さず、名前も
// 変えない（元は次の書き込みまでその場に残る）。
import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'

/** ファイルを読んだ結果。「無い」と見なすのは ENOENT だけ。それ以外の失敗は「読めない」。 */
export type FileState =
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'bytes'; bytes: Buffer }

/** 読み込みで投げられた例外が「ファイルが無い」ことを表すか（例外の文面は読まず、code だけを見る）。 */
export function isMissingError(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** ファイルを読んで、無い／読めない／中身の3つに分ける。 */
export function readFileState(filePath: string): FileState {
  try {
    return { kind: 'bytes', bytes: fs.readFileSync(filePath) }
  } catch (e) {
    return isMissingError(e) ? { kind: 'missing' } : { kind: 'unreadable' }
  }
}

/** 写しの結果。作れなかった（書けないフォルダなど）ときは backupName が null。 */
export type BrokenCopy = { backupName: string | null }

// このプロセスで写しを作った（見つけた）ファイル。key はファイルのパス。同じ中身を読むたびに
// フォルダを調べ直さないための記憶で、中身が変われば（hash が違えば）使わない。
const remembered = new Map<string, { hash: string; name: string }>()

/** テスト用: 記憶を空にする（アプリを再起動した状態にする）。 */
export function resetBrokenCopyMemory(): void {
  remembered.clear()
}

/** 同じフォルダにある、このファイルの写し（`<元の名前>.broken-…`）の名前。並べ替え済み。フォルダが無い・読めないときは空。 */
export function listBrokenCopies(filePath: string): string[] {
  const prefix = `${path.basename(filePath)}.broken-`
  try {
    return fs.readdirSync(path.dirname(filePath)).filter((n) => n.startsWith(prefix)).sort()
  } catch {
    return []
  }
}

/** 写しの名前に付ける日時（ローカル時刻。ファイル名に使えない文字を避けて `20261103-142530` の形）。 */
function stampOf(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
}

/** 同じフォルダに、同じ中身の写しがすでにあればその名前を返す（再起動のあとに写しを増やさないため）。 */
function findSameCopy(dir: string, prefix: string, bytes: Buffer): string | null {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return null
  }
  for (const name of names.filter((n) => n.startsWith(prefix)).sort()) {
    try {
      const p = path.join(dir, name)
      if (fs.statSync(p).size !== bytes.length) continue
      if (fs.readFileSync(p).equals(bytes)) return name
    } catch {
      // 読めない候補は飛ばす
    }
  }
  return null
}

/**
 * 読んだ中身（bytes）を、元のファイルと同じフォルダの `<元の名前>.broken-<日時>` へ写す。
 * 同じ中身の写しがあれば（このプロセスで作った分も、前の起動で作った分も）新しく作らず、その名前を返す。
 * 同じ秒に別の中身の写しがあれば `-2` `-3` を付ける。既にあるファイルには上書きしない。
 * 作れなかったときは `{ backupName: null }`（呼び出し側はこの会話への書き込みを止める）。
 */
export function copyBrokenOnce(filePath: string, bytes: Buffer, now: Date = new Date()): BrokenCopy {
  const dir = path.dirname(filePath)
  const prefix = `${path.basename(filePath)}.broken-`
  const hash = createHash('sha256').update(bytes).digest('hex')

  const known = remembered.get(filePath)
  if (known && known.hash === hash && fs.existsSync(path.join(dir, known.name))) {
    return { backupName: known.name }
  }

  const same = findSameCopy(dir, prefix, bytes)
  if (same) {
    remembered.set(filePath, { hash, name: same })
    return { backupName: same }
  }

  const stamp = stampOf(now)
  for (let n = 1; n <= 50; n++) {
    const name = n === 1 ? `${prefix}${stamp}` : `${prefix}${stamp}-${n}`
    const dest = path.join(dir, name)
    try {
      // 読んだ中身をそのまま、無いときだけ作る形（'wx'）で書く。元のファイルには触れない。
      fs.writeFileSync(dest, bytes, { flag: 'wx' })
      remembered.set(filePath, { hash, name })
      return { backupName: name }
    } catch (e) {
      if ((e as NodeJS.ErrnoException | null)?.code === 'EEXIST') continue
      // 書き始めてから失敗したときに、半端な写しを残さない（ここで消すのはいま自分が作った写しだけ）
      try { fs.rmSync(dest, { force: true }) } catch { /* 消せなくても先へ進む */ }
      return { backupName: null }
    }
  }
  return { backupName: null }
}
