// newProjectClose.ts — 新規プロジェクトの窓が「閉じてほしい」と言われたとき、閉じてよいかの判断（純関数）。
//
// ・背景クリックでは閉じない（入力の途中で、うっかり押して消えるのを防ぐ）。
// ・Esc は ✕・キャンセルと同じ守りを通す。作成中・インポート中は閉じない（処理は続くので、画面だけ消さない）。

import type { ModalCloseReason } from './ui/Modal'

export function shouldCloseNewProject(reason: ModalCloseReason, busy: boolean, importBusy: boolean): boolean {
  if (reason === 'backdrop') return false
  return !busy && !importBusy
}
