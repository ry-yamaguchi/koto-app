// tests/claudeTurnIpc.test.ts — claude:chatStart / claude:chatCancel の回の扱い（main）。
//
// 偽にするのは electron と startClaudeChat だけ。ipc/claude.ts は本物。
// 見るのは、画面の送り先（sender.send）へ届いた (channel, 中身) の一覧と、偽の startClaudeChat・abort が呼ばれた回数。
import { describe, it, expect, beforeEach, vi } from 'vitest'

type Sent = { channel: string; payload: any }
type Started = {
  params: Record<string, any>
  abort: ReturnType<typeof vi.fn>
}

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  started: [] as any[],
  throwNext: false,
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => '/nonexistent-koto-test-userdata' },
}))
vi.mock('../src/main/claude/agent', () => ({
  startClaudeChat: (params: Record<string, any>) => {
    if (h.throwNext) { h.throwNext = false; throw new Error('start failed') }
    const abort = vi.fn()
    h.started.push({ params, abort })
    return { abort, turnId: `claude-test-${h.started.length}` }
  },
}))

import { registerClaudeHandlers } from '../src/main/ipc/claude'

const A = '/work/project-a'
const B = '/work/project-b'

const started = (): Started[] => h.started
const makeSender = () => {
  const sent: Sent[] = []
  return { sent, sender: { send: (channel: string, payload: any) => { sent.push({ channel, payload }) } } }
}
const streamOf = (s: Sent[]) => s.filter(x => x.channel === 'claude:stream').map(x => x.payload)

function start(sender: unknown, projectDir: string, turn: unknown) {
  return h.handlers.get('claude:chatStart')!({ sender }, projectDir, 'k', 'p', [], 'snap', null, null, '', 'auto', null, turn)
}
const cancel = (turn: unknown) => h.handlers.get('claude:chatCancel')!({}, turn)

beforeEach(() => {
  h.throwNext = false
  h.started = []
  h.handlers.clear()
  registerClaudeHandlers({} as any)
})

// 前のテストの回を残さない（main の回はモジュールに1つ）。
async function drainActive() {
  for (const t of ['t-a1', 't-a2', 't-b1']) await cancel(t)
}
beforeEach(drainActive)

describe('送る出来事の全部に、chatStart に渡した印が載る', () => {
  it('onEvent の出来事・onDelegated・onFileWritten・open_preview の知らせ', async () => {
    const { sent, sender } = makeSender()
    expect(await start(sender, A, 't-a1')).toEqual({ ok: true })
    const p = started()[0].params
    p.onEvent({ kind: 'session', sessionId: 's' })
    p.onEvent({ kind: 'text', text: 'こんにちは' })
    p.onEvent({ kind: 'tool', name: 'Read', detail: 'x' })
    p.onDelegated({ kind: 'delegated', model: 'm', promptTokens: 1, completionTokens: 2 })
    p.onFileWritten('a.html')
    void p.onOpenPreview('index.html')
    p.onEvent({ kind: 'result', costUsd: 0, durationMs: 1, isError: false })
    const events = streamOf(sent)
    expect(events.map(e => e.kind)).toEqual(['session', 'text', 'tool', 'delegated', 'fileWritten', 'openPreview', 'result'])
    for (const e of events) expect(e.turn).toBe('t-a1')
    expect(sent.every(x => x.channel === 'claude:stream')).toBe(true)
  })

  it('onDelegated が info に kind を含まない形で来ても、delegated として送る', async () => {
    const { sent, sender } = makeSender()
    await start(sender, A, 't-a1')
    started()[0].params.onDelegated({ model: 'm', promptTokens: 1, completionTokens: 2 })
    expect(streamOf(sent)).toEqual([{ kind: 'delegated', model: 'm', promptTokens: 1, completionTokens: 2, turn: 't-a1' }])
  })
})

describe('回を始めた窓がもう無いとき（だれも受け取らない回）は、断り続けない', () => {
  it('A の送り先が壊れていれば、B の chatStart は通り、A の回は止まる', async () => {
    const a = makeSender()
    let gone = false
    const aSender = { ...a.sender, isDestroyed: () => gone }
    const b = makeSender()
    await start(aSender, A, 't-a1')
    // 窓があるうちは断る
    expect(await start(b.sender, B, 't-b1')).toEqual({ ok: false, busy: true })
    expect(started()).toHaveLength(1)
    // 窓が無くなったあとは、止めて先へ進む
    gone = true
    expect(await start(b.sender, B, 't-b1')).toEqual({ ok: true })
    expect(started()).toHaveLength(2)
    expect(started()[0].abort).toHaveBeenCalledTimes(1)
    // A の回の遅れた出来事は、B の送り先へ入らない
    started()[0].params.onEvent({ kind: 'text', text: 'late' })
    expect(streamOf(b.sent)).toEqual([])
    started()[1].params.onEvent({ kind: 'text', text: 'b' })
    expect(streamOf(b.sent).map(e => [e.kind, e.turn])).toEqual([['text', 't-b1']])
  })
})

describe('ほかのプロジェクトの回が走っている間は、前の回を止めずに断る', () => {
  it('A で走っている間に B の chatStart → busy・A は止まらない・2回目は始まらない・A の送り先に何も増えない', async () => {
    const a = makeSender()
    const b = makeSender()
    await start(a.sender, A, 't-a1')
    const p = started()[0].params
    p.onEvent({ kind: 'text', text: 'x' })
    const before = a.sent.length
    expect(await start(b.sender, B, 't-b1')).toEqual({ ok: false, busy: true })
    expect(started()).toHaveLength(1)
    expect(started()[0].abort).not.toHaveBeenCalled()
    expect(a.sent).toHaveLength(before)
    expect(b.sent).toEqual([])
    // A の出来事は今までどおり A の印で流れる
    p.onEvent({ kind: 'text', text: 'y' })
    expect(streamOf(a.sent).map(e => [e.kind, e.turn])).toEqual([['text', 't-a1'], ['text', 't-a1']])
    // 断られた B の印の ⏹ は、A の回を止めない
    expect(await cancel('t-b1')).toEqual({ ok: true, stopped: false })
    expect(started()[0].abort).not.toHaveBeenCalled()
  })

  it('A の result（成功）で回が閉じたあとは、B の chatStart が通る', async () => {
    const a = makeSender()
    const b = makeSender()
    await start(a.sender, A, 't-a1')
    started()[0].params.onEvent({ kind: 'result', costUsd: 0, durationMs: 1, isError: false })
    expect(await start(b.sender, B, 't-b1')).toEqual({ ok: true })
    expect(started()).toHaveLength(2)
  })

  it('失敗の回は result（isError）→ error の両方が送られ、error のあとで閉じる', async () => {
    const a = makeSender()
    const b = makeSender()
    await start(a.sender, A, 't-a1')
    const p = started()[0].params
    p.onEvent({ kind: 'result', costUsd: 0.1, durationMs: 1, isError: true })
    // result の時点では閉じていない（ほかのプロジェクトはまだ断られる）
    expect(await start(b.sender, B, 't-b1')).toEqual({ ok: false, busy: true })
    p.onEvent({ kind: 'error', message: 'x' })
    expect(streamOf(a.sent).map(e => e.kind)).toEqual(['result', 'error'])
    expect(await start(b.sender, B, 't-b1')).toEqual({ ok: true })
  })

  it('error だけで終わる回も閉じる', async () => {
    const a = makeSender()
    const b = makeSender()
    await start(a.sender, A, 't-a1')
    started()[0].params.onEvent({ kind: 'error', message: 'x' })
    expect(await start(b.sender, B, 't-b1')).toEqual({ ok: true })
  })
})

describe('同じプロジェクトでの新しい送信は、前の回を止める', () => {
  it('abort が1回・superseded が前の印で1回・前の回の遅れた出来事は送られない・新しい回は新しい印', async () => {
    const a = makeSender()
    await start(a.sender, A, 't-a1')
    const first = started()[0]
    first.params.onEvent({ kind: 'text', text: '1' })
    const n = a.sent.length
    expect(await start(a.sender, A, 't-a2')).toEqual({ ok: true })
    expect(first.abort).toHaveBeenCalledTimes(1)
    const afterStart = streamOf(a.sent).slice(n)
    expect(afterStart).toEqual([{ kind: 'superseded', turn: 't-a1' }])
    // 止めたあとに SDK から遅れて来た出来事
    first.params.onEvent({ kind: 'text', text: '遅れた' })
    first.params.onDelegated({ model: 'm', promptTokens: 1, completionTokens: 1 })
    first.params.onFileWritten('x')
    first.params.onEvent({ kind: 'result', costUsd: 0, durationMs: 1, isError: false })
    expect(streamOf(a.sent).slice(n)).toHaveLength(1)
    // 遅れた result は、新しい回を閉じない（B がまだ断られる）
    expect(await start(makeSender().sender, B, 't-b1')).toEqual({ ok: false, busy: true })
    // 新しい回の出来事は新しい印で流れる
    started()[1].params.onEvent({ kind: 'text', text: '2' })
    expect(streamOf(a.sent).slice(-1)).toEqual([{ kind: 'text', text: '2', turn: 't-a2' }])
  })

  it('superseded は、前の回を始めた送り先へ届く', async () => {
    const first = makeSender()
    const second = makeSender()
    await start(first.sender, A, 't-a1')
    await start(second.sender, A, 't-a2')
    expect(streamOf(first.sent)).toEqual([{ kind: 'superseded', turn: 't-a1' }])
    expect(second.sent).toEqual([])
  })
})

describe('claude:chatCancel は印が合うときだけ止める', () => {
  it('合わない印 → 止めない・stopped:false', async () => {
    const a = makeSender()
    await start(a.sender, A, 't-a1')
    expect(await cancel('t-zzz')).toEqual({ ok: true, stopped: false })
    expect(started()[0].abort).not.toHaveBeenCalled()
  })

  it('合う印 → abort・stopped:true・そのあとの出来事は送られない', async () => {
    const a = makeSender()
    await start(a.sender, A, 't-a1')
    expect(await cancel('t-a1')).toEqual({ ok: true, stopped: true })
    expect(started()[0].abort).toHaveBeenCalledTimes(1)
    const n = a.sent.length
    started()[0].params.onEvent({ kind: 'text', text: 'x' })
    expect(a.sent).toHaveLength(n)
    // 止めたあとは、ほかのプロジェクトも始められる
    expect(await start(makeSender().sender, B, 't-b1')).toEqual({ ok: true })
  })

  it('印なし（undefined）・数 → 何もしない', async () => {
    const a = makeSender()
    await start(a.sender, A, 't-a1')
    expect(await cancel(undefined)).toEqual({ ok: true, stopped: false })
    expect(await cancel(1)).toEqual({ ok: true, stopped: false })
    expect(started()[0].abort).not.toHaveBeenCalled()
  })

  it('走っている回が無いとき → stopped:false', async () => {
    expect(await cancel('t-a1')).toEqual({ ok: true, stopped: false })
  })
})

describe('印の形が不正なら、何も始めない', () => {
  for (const [name, bad] of [['空', ''], ['65字', 'a'.repeat(65)], ['空白を含む', 'a b'], ['数', 1], ['undefined', undefined]] as const) {
    it(`${name} → ok:false・startClaudeChat は呼ばれない・走っている回に触れない`, async () => {
      const a = makeSender()
      await start(a.sender, A, 't-a1')
      const n = a.sent.length
      expect(await start(a.sender, A, bad)).toEqual({ ok: false, message: '送信の印が不正です' })
      expect(started()).toHaveLength(1)
      expect(started()[0].abort).not.toHaveBeenCalled()
      expect(a.sent).toHaveLength(n)
    })
  }

  it('64字は通る', async () => {
    expect(await start(makeSender().sender, A, 'a'.repeat(64))).toEqual({ ok: true })
    await cancel('a'.repeat(64))
  })
})

describe('始められなかった回は残さない', () => {
  it('startClaudeChat が同期で例外を投げても、ほかのプロジェクトの送信を断り続けない', async () => {
    const a = makeSender()
    h.throwNext = true
    expect(() => start(a.sender, A, 't-a1')).toThrow('start failed')
    const b = makeSender()
    expect(await start(b.sender, B, 't-b1')).toEqual({ ok: true })
    expect(started()).toHaveLength(1)
  })
})
