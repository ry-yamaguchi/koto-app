// Claude の回の印と、ほかのプロジェクトの作業にぶつかる送信の判断。
//
// Claude は同時に1つの作業しか持てない（main の回はグローバルに1つ）。画面が送信ごとに印を作り、
// main が出来事へ載せて返すので、画面は自分の回の出来事だけを当てる。
import { loadingKeys } from './chatTurnRegistry'

/** 送信ごとの回の印を作る。main の形の確かめ（英数・_・- の1〜64字）を通る。 */
export function newClaudeTurn(): string {
  const rand = Math.random().toString(36).slice(2).padEnd(8, '0').slice(0, 8)
  return `ct-${Date.now().toString(36)}-${rand}`
}

/** ほかのプロジェクトで AI が作業中のため、送らなかったときの一言。 */
export const CLAUDE_OTHER_BUSY_NOTE = 'ℹ️ ほかのプロジェクトで AI が作業中です。終わってから、もう一度送ってください。'

// いま走っている Claude の回の印（モジュールに1つ）。どのプロジェクトの、どの回か。
let running: { projectDir: string; turn: string } | null = null

/**
 * Claude の回を始めたと印を立てる。同じプロジェクトの前の印と、もう応答していないプロジェクトの印は上書きする。
 * ほかのプロジェクトの回がまだ応答中なら、その印は上書きしない（確認を待っている間に、ほかのプロジェクトの回が
 * 始まった送信に当たる。この送信は main が断る。断られた回の終わりで、走っている回の印を消さないため）。
 */
export function markClaudeTurnStarted(projectDir: string, turn: string, keys: readonly string[] = loadingKeys()): void {
  if (running && running.projectDir !== projectDir && keys.includes(running.projectDir)) return
  running = { projectDir, turn }
}

/** 印の回が同じ turn のときだけ下ろす（止められた古い回の終わりが、新しい回の印を下ろさない）。 */
export function markClaudeTurnEnded(turn: string): void {
  if (running && running.turn === turn) running = null
}

/** いまの印を読む（試験用）。 */
export function runningClaudeTurn(): { projectDir: string; turn: string } | null {
  return running
}

/** 印を消す（試験用）。 */
export function resetClaudeTurnForTest(): void {
  running = null
}

/**
 * Claude へ送ると、ほかのプロジェクトで走っている Claude の回にぶつかるか（Claude は同時に1つの回しか持てない）。
 * 真になるのは、印があり・印のプロジェクトが送り先と違い・そのプロジェクトがまだ応答中のときだけ。
 * さくらのAI Engine の応答中は断らない。
 */
export function claudeSendBlocked(projectDir: string | null | undefined, keys: readonly string[] = loadingKeys()): boolean {
  if (!running) return false
  if (running.projectDir === projectDir) return false
  return keys.includes(running.projectDir)
}
