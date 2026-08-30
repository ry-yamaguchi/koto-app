// applyEdit（edit_file ツールの置換ロジック）の実体は shared へ移した（B'-3d-2a）。
// 呼び出し側（旧: aiTools.ts。現在は shared/toolExecCore.ts）を壊さないよう re-export だけ残す
// （B'-3d-1a の usage.ts と同じ作法）。
export { applyEdit, type ApplyEditResult } from '../shared/editFile'
