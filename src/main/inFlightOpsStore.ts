// inFlightOpsStore.ts — 途中で止まった回の記録（この Mac の Koto の保存領域の小さな JSON）の持ち主。設計書 10.13.3。
//
// ── 何を持つか（2026-10-12・設計書 10.13）────────────────────────────────────────────
// 走っている操作の段の時刻（running）と、止まった回（stopped）。中身の形・整え方・上限は shared/inFlightOps.ts
// （sanitizeInFlightFile）。**進み具合の文・結果・URL・資源の ID・秘密は入れない**（形に合わないものは整えるときに捨てる）。
// プロジェクトの場所は鍵（絶対パス）の中にだけある。**外へ送らない**——この Mac の Koto の中だけで使う。
//
// ── 作法（stageTimingStore.ts と同じ）─────────────────────────────────────────────────
// ・保存先は app.getPath('userData') の `in-flight-ops.json`。**テストでは `initInFlightOpsStore(dir)` で差し替える**
//   （利用者の保存領域を使わない。本番のコードはこれを呼ばない）
// ・書き込みは**同期**で、一時ファイル → rename（途中で落ちても壊れた JSON を残さない。終了の直前＝will-quit にも間に合わせる）
// ・**書けなければ false を返して黙って続ける**（例外を外へ出さない・処理は止めない）
// ・**読めない・壊れている・形が違う → 空**として扱い、次に書くとき上書きされて直る
// ・**1MB を超えるファイルは読まずに空**として扱う（正しい中身は上限どおりでも 400KB 足らず。壊れて膨らんだファイルを
//   起動のたびに読まない。次に書くとき上書きされて直る）
//
// 毎回ファイルから読む（メモリに持たない）。メモリの正は projectOps.ts で、ここは読み書きだけ。
import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { emptyInFlightFile, sanitizeInFlightFile, type InFlightFile } from '../shared/inFlightOps'

const FILE = 'in-flight-ops.json'

/** これを超えるファイルは読まない（ちょうどこの大きさまでは読む）。 */
export const IN_FLIGHT_FILE_MAX_BYTES = 1024 * 1024

/** テスト用に差し替える保存先ディレクトリ。null なら app.getPath('userData')（本番）。 */
let dirOverride: string | null = null

/**
 * テスト用: 保存先ディレクトリを差し替える。dir に null を渡すと本番の app.getPath('userData') へ戻る。
 * 本番コード（main.ts・inFlightOpsArm.ts）はこれを呼ばない。
 */
export function initInFlightOpsStore(dir: string | null): void {
  dirOverride = dir
}

export function inFlightOpsFilePath(): string {
  return path.join(dirOverride ?? app.getPath('userData'), FILE)
}

/** 読む。無い・読めない・壊れている・形が違う・1MB を超える → 空（落ちない）。読んだ中身は整えて返す。 */
export function loadInFlightOps(): InFlightFile {
  try {
    const file = inFlightOpsFilePath()
    if (fs.statSync(file).size > IN_FLIGHT_FILE_MAX_BYTES) return emptyInFlightFile()
    return sanitizeInFlightFile(JSON.parse(fs.readFileSync(file, 'utf-8')))
  } catch {
    return emptyInFlightFile()
  }
}

/**
 * ファイルの中身を丸ごと書く（同期・一時ファイル → rename）。書き出す前に整える（`sanitizeInFlightFile`）ので、
 * 決まった形に合わないものは1つも書かれない。書けなければ false（例外を出さない）。戻り値の true は「書けた」。
 */
export function writeInFlightOps(file: InFlightFile): boolean {
  try {
    const target = inFlightOpsFilePath()
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const tmp = `${target}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(sanitizeInFlightFile(file)), 'utf-8')
    fs.renameSync(tmp, target)
    return true
  } catch {
    return false
  }
}
