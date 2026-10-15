// stageTimingStore.ts — 段ごとの所要時間の記録（この Mac の Koto の保存領域の小さな JSON）の持ち主。
//
// ── 何を持つか（2026-10-07・作者の決定）─────────────────────────────────────────────
// うまくいった操作の、終わった段の所要時間だけ。段ごとに最近10件まで（古いものから捨てる）。
// 中身は `{ ms, at, version, zone }` だけ（段の内部名・かかった時間・日付・Koto の版・ゾーン）。**秘密は入れない**
// （プロジェクトの場所・ID・名前も入れない）。**外へ送らない**——この Mac の Koto の中だけで使う。
//
// ── 作法（learningStore.ts・usageStore.ts と同じ）─────────────────────────────────────
// ・保存先は app.getPath('userData') の `stage-timings.json`。**テストでは `initStageTimingStore(dir)` で差し替える**
//   （利用者の保存領域を使わない。本番のコードはこれを呼ばない）
// ・書き込みは一時ファイル → rename（途中で落ちても、壊れた JSON を残さない）
// ・**壊れた JSON・読めないファイルでも落ちない**: 空として扱い、次の書き込みで上書きされて直る
// ・判断（件数の上限・形の検査・中央値）は shared/stageEstimate.ts の純関数。ここは読み書きだけ
//
// 毎回ファイルから読む（メモリに持たない）。操作は何分もかかるものばかりで、書き込みは1操作に1回なので十分速く、
// 別の部品（テスト・将来の別プロセス）が書いても古い写しで上書きしない。
import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { appendSamples, emptyStore, sanitizeStore, type StageTimingEntry, type StageTimingStore } from '../shared/stageEstimate'

const FILE = 'stage-timings.json'

/** テスト用に差し替える保存先ディレクトリ。null なら app.getPath('userData')（本番）。 */
let dirOverride: string | null = null

/**
 * テスト用: 保存先ディレクトリを差し替える。dir に null を渡すと本番の app.getPath('userData') へ戻る。
 * 本番コード（main.ts・ipc/stageTiming.ts）はこれを呼ばない。
 */
export function initStageTimingStore(dir: string | null): void {
  dirOverride = dir
}

export function stageTimingFilePath(): string {
  return path.join(dirOverride ?? app.getPath('userData'), FILE)
}

/** 読む。無い・読めない・壊れている → 空（落ちない）。 */
export function loadStageTimings(): StageTimingStore {
  try {
    return sanitizeStore(JSON.parse(fs.readFileSync(stageTimingFilePath(), 'utf-8')))
  } catch {
    return emptyStore()
  }
}

/**
 * 1回の操作の記録を足して書く（一時ファイル → rename）。書けなければ false（操作の結果は変えない）。
 * 戻り値の true は「書けた」。
 */
export function recordStageTimings(entry: StageTimingEntry): boolean {
  const file = stageTimingFilePath()
  try {
    const next = appendSamples(loadStageTimings(), entry)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next), 'utf-8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}
