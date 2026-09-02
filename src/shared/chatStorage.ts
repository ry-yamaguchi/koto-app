// chatStorage.ts（shared）— 保存用にメッセージを整える純粋ロジック（renderer/main 共通・electron非依存）。
//
// ── なぜここに（B'-3c）─────────────────────────────────────────────
// 会話データの持ち主が renderer から main（src/main/chat/convStore.ts）へ移った。
// convStore.ts（プロジェクト別チャット・単独チャットの両方が経由する。B'-3e-a）が
// 保存直前にこれを通し、「thinking（推論モデルの思考）は保存しない」規則を1箇所に集約している。
//
// 推論モデルの「思考」は表示専用で、本文の何倍にもなることがあるため保存しない
// （2026-08-03 の決まり。保存すると chat.json が肥大し、読み込み・GitHub保存にも響く）。
export function forStorage<M extends { thinking?: string }>(messages: M[]): M[] {
  return (messages ?? []).map(m => {
    if (!m || m.thinking === undefined) return m
    const { thinking, ...rest } = m
    return rest as M
  })
}
