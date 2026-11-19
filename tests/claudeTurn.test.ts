// tests/claudeTurn.test.ts — 回の印の作り方と、ほかのプロジェクトの作業にぶつかる送信の判断。
import { describe, it, expect, beforeEach } from 'vitest'
import { newClaudeTurn, claudeSendBlocked, markClaudeTurnStarted, markClaudeTurnEnded, runningClaudeTurn, resetClaudeTurnForTest, CLAUDE_OTHER_BUSY_NOTE } from '../src/renderer/claudeTurn'
import { CHAT_APP_KEY } from '../src/renderer/chatTurnRegistry'

describe('newClaudeTurn', () => {
  it('形は ct-<時刻>-<乱数8桁>。main の形の確かめを通る', () => {
    for (let i = 0; i < 50; i++) {
      const t = newClaudeTurn()
      expect(t).toMatch(/^ct-[a-z0-9]+-[a-z0-9]{8}$/)
      expect(t).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    }
  })
  it('2回呼ぶと違う値', () => {
    const seen = new Set(Array.from({ length: 200 }, () => newClaudeTurn()))
    expect(seen.size).toBe(200)
  })
})

describe('claudeSendBlocked は、Claude の回の印だけを見る', () => {
  const A = '/work/a'
  const B = '/work/b'
  beforeEach(() => resetClaudeTurnForTest())

  it('印が無ければ、ほかのプロジェクトが応答中でも断らない（さくらのAI Engine の応答中）', () => {
    expect(claudeSendBlocked(A, [B])).toBe(false)
    expect(claudeSendBlocked(A, [A, B])).toBe(false)
  })
  it('印がほかのプロジェクトで、そのプロジェクトが応答中なら断る', () => {
    markClaudeTurnStarted(B, 't1')
    expect(claudeSendBlocked(A, [B])).toBe(true)
    expect(claudeSendBlocked(A, [A, B])).toBe(true)
  })
  it('印が自分のプロジェクトなら断らない', () => {
    markClaudeTurnStarted(A, 't1')
    expect(claudeSendBlocked(A, [A])).toBe(false)
    expect(claudeSendBlocked(A, [A, B])).toBe(false)
  })
  it('印がほかのプロジェクトでも、応答中の記録に無ければ断らない（残った印）', () => {
    markClaudeTurnStarted(B, 't1')
    expect(claudeSendBlocked(A, [])).toBe(false)
    expect(claudeSendBlocked(A, [CHAT_APP_KEY, `${CHAT_APP_KEY}:s1`])).toBe(false)
    expect(claudeSendBlocked(A, [A])).toBe(false)
  })
  it('プロジェクト未選択でも、ほかのプロジェクトの回が走っていれば断る', () => {
    markClaudeTurnStarted(B, 't1')
    expect(claudeSendBlocked(null, [B])).toBe(true)
  })
})

describe('回の印の立て下ろし', () => {
  const A = '/work/a'
  const B = '/work/b'
  beforeEach(() => resetClaudeTurnForTest())

  it('同じ回の終わりで下りる', () => {
    markClaudeTurnStarted(B, 't1')
    markClaudeTurnEnded('t1')
    expect(runningClaudeTurn()).toBeNull()
    expect(claudeSendBlocked(A, [B])).toBe(false)
  })
  it('回が違えば下ろさない（古い回の終わりが、新しい回の印を下ろさない）', () => {
    markClaudeTurnStarted(B, 't1')
    markClaudeTurnStarted(B, 't2')
    markClaudeTurnEnded('t1')
    expect(runningClaudeTurn()).toEqual({ projectDir: B, turn: 't2' })
    expect(claudeSendBlocked(A, [B])).toBe(true)
  })
  it('もう応答していないプロジェクトの印は、立て直すと上書きされる', () => {
    markClaudeTurnStarted(B, 't1', [])
    markClaudeTurnStarted(A, 't2', [A])
    expect(runningClaudeTurn()).toEqual({ projectDir: A, turn: 't2' })
  })
  it('ほかのプロジェクトの回がまだ応答中なら、その印を上書きしない。断られた回の終わりでも、走っている回の印は残る', () => {
    const C = '/work/c'
    markClaudeTurnStarted(A, 't1', [A])
    // B の送信が、確認を待っている間に下見を抜けてここへ来た（A はまだ応答中）
    markClaudeTurnStarted(B, 't2', [A, B])
    expect(runningClaudeTurn()).toEqual({ projectDir: A, turn: 't1' })
    // B は main に断られて終わる
    markClaudeTurnEnded('t2')
    expect(runningClaudeTurn()).toEqual({ projectDir: A, turn: 't1' })
    expect(claudeSendBlocked(C, [A])).toBe(true)
    expect(claudeSendBlocked(B, [A])).toBe(true)
  })
  it('印が無いときの終わりは何も起こさない', () => {
    markClaudeTurnEnded('t1')
    expect(runningClaudeTurn()).toBeNull()
  })
})

describe('CLAUDE_OTHER_BUSY_NOTE', () => {
  it('文面', () => {
    expect(CLAUDE_OTHER_BUSY_NOTE).toBe('ℹ️ ほかのプロジェクトで AI が作業中です。終わってから、もう一度送ってください。')
  })
})
