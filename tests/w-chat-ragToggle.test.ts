// tests/w-chat-ragToggle.test.ts — W-44 固定: 📚 資料トグル（ChatPanel.tsx の toggleRag）が
// 「さくらのAI Engine のキーの有無」を、保存済みの ragSettings.enabled より先に見ること
// （検分の指摘8・2026-09-27）。
//
// ⚠️ 直した人自身が最初に足した修正は `if (next && !apiKey)` で、next（=!storedEnabled）を
// 先に求めていた。キーが無いまま一度でも enabled:true が保存されたことがある人
// （このバグ自体が起こしうる状態）は storedEnabled===true なので next=false になり、
// 「キーが無い」の案内を出す if (next && !apiKey) を素通りして false を黙って上書き保存する
// だけになる（＝押しても表示は変わらない。直す前と同じ「押しても何も起きない」に戻る）。
// 判定を shared/aiToolsCore.ts の decideRagToggleAction（純関数）に一元化し、ここで固定する。

import { describe, it, expect } from 'vitest'
import { decideRagToggleAction } from '../src/shared/aiToolsCore'

describe('W-44: decideRagToggleAction はキーの有無を保存状態より先に見る', () => {
  it('★★★ キーが無く、保存済み設定が enabled:true（このバグが起こしうる状態）でも needsKey を返す（false を上書き保存しない）', () => {
    expect(decideRagToggleAction(false, true)).toEqual({ kind: 'needsKey' })
  })

  it('キーが無く、保存済み設定が enabled:false のときも needsKey を返す', () => {
    expect(decideRagToggleAction(false, false)).toEqual({ kind: 'needsKey' })
  })

  it('キーがあり、いまオフ → オンにする（next: true）', () => {
    expect(decideRagToggleAction(true, false)).toEqual({ kind: 'toggle', next: true })
  })

  it('キーがあり、いまオン → オフにする（next: false）', () => {
    expect(decideRagToggleAction(true, true)).toEqual({ kind: 'toggle', next: false })
  })
})
