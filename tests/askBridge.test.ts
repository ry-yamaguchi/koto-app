import { describe, it, expect } from 'vitest'
import { createAskBridge } from '../src/main/chat/askBridge'
import type { TurnAsk } from '../src/shared/chatTurnRpc'

// askBridge: main → renderer への問い合わせ（ask）の帳簿（B'-3b）。electron 非依存の純粋ロジック
// なので、実物の IPC を介さず node でそのまま駆動できる。

describe('createAskBridge', () => {
  it('ask は send を呼び、answer(ok:true) で resolve する', async () => {
    const sent: TurnAsk[] = []
    const bridge = createAskBridge((a) => sent.push(a))
    const p = bridge.ask('getHistory', [])
    expect(sent).toHaveLength(1)
    expect(sent[0].path).toBe('getHistory')
    expect(sent[0].args).toEqual([])
    const ok = bridge.answer({ callId: sent[0].callId, ok: true, result: ['あ', 'い'] })
    expect(ok).toBe(true)
    await expect(p).resolves.toEqual(['あ', 'い'])
  })

  it('answer(ok:false) で reject する（error がそのままメッセージになる）', async () => {
    const sent: TurnAsk[] = []
    const bridge = createAskBridge((a) => sent.push(a))
    const p = bridge.ask('buildSystemPrompt', [])
    bridge.answer({ callId: sent[0].callId, ok: false, error: 'だめでした' })
    await expect(p).rejects.toThrow('だめでした')
  })

  it('args がそのまま send に渡る', () => {
    const sent: TurnAsk[] = []
    const bridge = createAskBridge((a) => sent.push(a))
    bridge.ask('executeTool', ['write_file', '{"path":"a.txt"}', { projectDir: '/p' }])
    expect(sent[0].args).toEqual(['write_file', '{"path":"a.txt"}', { projectDir: '/p' }])
  })

  it('知らない callId への answer は false を返し、何も変えない（掟10: ミューテーション試験対象）', () => {
    const bridge = createAskBridge(() => {})
    expect(bridge.answer({ callId: 'no-such-call-id', ok: true, result: 1 })).toBe(false)
    expect(bridge.pendingCount()).toBe(0)
  })

  it('二重回答は無視する: 2回目は false を返し、1回目の resolve 結果のまま変わらない（掟10: ミューテーション試験対象）', async () => {
    const sent: TurnAsk[] = []
    const bridge = createAskBridge((a) => sent.push(a))
    const p = bridge.ask('getHistory', [])
    const { callId } = sent[0]
    expect(bridge.answer({ callId, ok: true, result: 'さいしょ' })).toBe(true)
    // 2回目（成功でも失敗でも）は無視される
    expect(bridge.answer({ callId, ok: false, error: 'あとから' })).toBe(false)
    await expect(p).resolves.toBe('さいしょ')
  })

  it('rejectAll は未解決の ask を全部 reject し、pendingCount が 0 になる（掟10: ミューテーション試験対象）', async () => {
    const bridge = createAskBridge(() => {})
    const p1 = bridge.ask('getHistory', [])
    const p2 = bridge.ask('buildSystemPrompt', [])
    const p3 = bridge.ask('compactWarnOnce', [])
    expect(bridge.pendingCount()).toBe(3)
    bridge.rejectAll('画面が閉じられました')
    expect(bridge.pendingCount()).toBe(0)
    await expect(p1).rejects.toThrow('画面が閉じられました')
    await expect(p2).rejects.toThrow('画面が閉じられました')
    await expect(p3).rejects.toThrow('画面が閉じられました')
  })

  it('rejectAll のあとに answer が来ても false（帳簿から既に消えている）', async () => {
    const sent: TurnAsk[] = []
    const bridge = createAskBridge((a) => sent.push(a))
    const p = bridge.ask('getHistory', [])
    const { callId } = sent[0]
    bridge.rejectAll('終了')
    await expect(p).rejects.toThrow('終了') // rejectAll 自身の reject を確実に処理する（未処理rejection防止）
    expect(bridge.answer({ callId, ok: true, result: 'おそい' })).toBe(false)
  })

  it('pendingCount は ask で増え、answer のたびに1つずつ減る', async () => {
    const sent: TurnAsk[] = []
    const bridge = createAskBridge((a) => sent.push(a))
    expect(bridge.pendingCount()).toBe(0)
    const p1 = bridge.ask('getHistory', [])
    const p2 = bridge.ask('buildSystemPrompt', [])
    expect(bridge.pendingCount()).toBe(2)
    bridge.answer({ callId: sent[0].callId, ok: true, result: 1 })
    expect(bridge.pendingCount()).toBe(1)
    bridge.answer({ callId: sent[1].callId, ok: true, result: 2 })
    expect(bridge.pendingCount()).toBe(0)
    await Promise.all([p1, p2])
  })

  it('callId は ask のたびに異なる（衝突しない）', () => {
    const sent: TurnAsk[] = []
    const bridge = createAskBridge((a) => sent.push(a))
    bridge.ask('getHistory', [])
    bridge.ask('getHistory', [])
    bridge.ask('getHistory', [])
    const ids = sent.map((a) => a.callId)
    expect(new Set(ids).size).toBe(3)
  })

  it('answer に result が無くても ok:true なら undefined で resolve する', async () => {
    const sent: TurnAsk[] = []
    const bridge = createAskBridge((a) => sent.push(a))
    const p = bridge.ask('usage.check', [])
    bridge.answer({ callId: sent[0].callId, ok: true })
    await expect(p).resolves.toBeUndefined()
  })

  it('answer に error が無くても ok:false なら既定のエラーメッセージで reject する', async () => {
    const sent: TurnAsk[] = []
    const bridge = createAskBridge((a) => sent.push(a))
    const p = bridge.ask('compactWarnOnce', [])
    bridge.answer({ callId: sent[0].callId, ok: false })
    await expect(p).rejects.toThrow()
  })
})
