// guard.ts — Bash実行前の危険コマンド判定（main側）。C2a: agent.ts の canUseTool から呼ぶ。
//
// isDangerousCommand の実体は src/shared/commandGuard.ts に一本化済み
//（旧: src/renderer/aiTools.ts と同じ正規表現をここに複製しており「要相互追随」の危険な状態だったが解消した）。
// ここでは main 側の既存 import 元（./guard からの import）を壊さないよう re-export のみ行う。

export { isDangerousCommand } from '../../shared/commandGuard'
