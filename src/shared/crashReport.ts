// crashReport.ts — 画面の例外から「診断情報」の文を組み立てる（純関数）。
//
// 利用者が作者へ送るもので、公開の Issue に貼られることもある。入れるのは、版・OS・エラー名・メッセージ・
// スタックの先頭だけ。localStorage の中身や設定は入れない（掟4）。
// 書く直前に、秘密（redactSecrets）とホームのパス（利用者名→`~`）を必ず落とす。

import { redactSecrets } from './updateLog'
import { maskHomePath } from './homePath'

/** スタックは先頭だけ（全部は長く、パスも多い）。 */
const STACK_LINES = 6

export interface CrashReportInput {
  version?: string
  platform?: string
  error: unknown
  /** 実行している環境のホーム（分かれば）。渡さなくても `/Users/<名前>` は `~` になる。 */
  home?: string
}

/** 例外から名前・メッセージ・スタックを取り出す（Error でない値が投げられても落ちない）。 */
function describeError(error: unknown): { name: string; message: string; stack: string } {
  if (error && typeof error === 'object') {
    const e = error as { name?: unknown; message?: unknown; stack?: unknown }
    return {
      name: typeof e.name === 'string' && e.name ? e.name : 'Error',
      message: typeof e.message === 'string' ? e.message : String(error),
      stack: typeof e.stack === 'string' ? e.stack : '',
    }
  }
  return { name: 'Error', message: String(error ?? ''), stack: '' }
}

/** 診断情報の本文を作る。 */
export function buildCrashReport(input: CrashReportInput): string {
  const { name, message, stack } = describeError(input.error)
  const stackHead = stack.split('\n').slice(0, STACK_LINES).join('\n')
  const text = [
    `Koto ${input.version || '不明'}`,
    `OS: ${input.platform || '不明'}`,
    `エラー: ${name}`,
    `メッセージ: ${message}`,
    stackHead ? `スタック（先頭）:\n${stackHead}` : '',
  ].filter(Boolean).join('\n')
  // 秘密を伏せてから、ホームのパスを `~` にする（どちらも書く直前）
  return maskHomePath(redactSecrets(text), input.home)
}
