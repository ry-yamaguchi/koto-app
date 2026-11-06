// renderer 発の書き換え（Claude の応答・start の reject の失敗の吹き出しなど）は、ターンを始めた
// プロジェクトの会話へ書く。ターン中に別のプロジェクトへ切り替えても、切り替え先の会話に書かない（掟11）。
//
//   A. opRouteOf: 行き先の判断（純粋）
//   B. applyOpToConversation: 見ていないプロジェクトの会話へ main へ送る。dir ごとに順序を守る（偽の electronAPI）
//   C. 配線: ChatPanel の onMessageEvent は、その render（＝送信した瞬間）のプロジェクトを行き先に持つ

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { opRouteOf, applyOpToConversation, type Op } from '../src/renderer/chatConvClient'

const ROOT = path.join(__dirname, '..')

describe('A. opRouteOf', () => {
  it('★ 始めたプロジェクトが、いま見ているものと同じなら viewing・違えば turn', () => {
    expect(opRouteOf('/p/a', '/p/a')).toBe('viewing')
    expect(opRouteOf('/p/a', '/p/b')).toBe('turn')
    // 切り替え先を読み込み中（見ているものがまだ定まらない）でも、始めたプロジェクトの会話へ送る
    expect(opRouteOf('/p/a', null)).toBe('turn')
  })

  it('★ A→B→A: 同じプロジェクトでも、読み込み中（client が無い間）は turn。読み込み済みなら viewing', () => {
    // A のターン中に B へ移り、A へ戻った。A を読み直している間に届いた A のターンの書き換えは main へ送る
    expect(opRouteOf('/p/a', '/p/a', false)).toBe('turn')
    expect(opRouteOf('/p/a', '/p/a', true)).toBe('viewing')
    expect(opRouteOf('/p/a', '/p/a')).toBe('viewing')
  })

  it('始めたプロジェクトが分からない（null）ときは、これまでどおり viewing', () => {
    expect(opRouteOf(null, '/p/a')).toBe('viewing')
    expect(opRouteOf(null, null)).toBe('viewing')
  })
})

describe('B. applyOpToConversation', () => {
  let calls: { dir: string; ops: Op[] }[]
  let releases: Array<() => void>

  beforeEach(() => {
    calls = []
    releases = []
    vi.stubGlobal('window', {
      electronAPI: {
        chat: {
          // 返事を手動で返す（前の送信が済むまで次を送らないこと＝順序を守ることを見る）
          ops: (dir: string, ops: Op[]) => new Promise(resolve => {
            calls.push({ dir, ops })
            releases.push(() => resolve({ ok: true }))
          }),
        },
      },
    })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  const append = (content: string): Op => ({ kind: 'append', msg: { role: 'assistant', content } })
  const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

  it('★ 始めたプロジェクトの dir へ、書き換え1件ずつ送る（ほかの dir へは送らない）', async () => {
    applyOpToConversation('/p/route-a', append('失敗しました'))
    await tick()
    expect(calls).toEqual([{ dir: '/p/route-a', ops: [append('失敗しました')] }])
  })

  it('★ 同じ dir への書き換えは前の送信が済んでから（順序を守る）。別の dir は待たない', async () => {
    applyOpToConversation('/p/route-b', append('1つ目'))
    applyOpToConversation('/p/route-b', append('2つ目'))
    applyOpToConversation('/p/route-c', append('別の会話'))
    await tick()
    // b の1つ目と c が送られ、b の2つ目は1つ目の返事を待っている
    expect(calls.map(c => `${c.dir}:${(c.ops[0] as any).msg.content}`)).toEqual(['/p/route-b:1つ目', '/p/route-c:別の会話'])
    releases[0]()
    await tick()
    expect(calls.map(c => `${c.dir}:${(c.ops[0] as any).msg.content}`)).toEqual([
      '/p/route-b:1つ目', '/p/route-c:別の会話', '/p/route-b:2つ目',
    ])
  })

  it('送信が失敗しても投げない（会話全体は壊れない）', async () => {
    ;(window as any).electronAPI.chat.ops = () => Promise.reject(new Error('IPC failed (test)'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => applyOpToConversation('/p/route-d', append('x'))).not.toThrow()
    await tick()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

// ── C. 配線 ───────────────────────────────────────────────────────────────
const readCode = (rel: string): string =>
  fs.readFileSync(path.join(ROOT, rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => { const t = line.trim(); return !t.startsWith('//') && !t.startsWith('*') })
    .join('\n')

describe('C. 配線（ChatPanel.tsx）', () => {
  const src = readCode('src/renderer/components/ChatPanel.tsx')

  it('★ onMessageEvent は、その render のプロジェクトを行き先に持つ。いま見ているものを行き先にする形へ戻さない', () => {
    expect(src).toContain('onMessageEvent: (ev) => applyOpOfTurn(ev, projectDir ?? null),')
    expect(src).not.toContain('onMessageEvent: (ev) => applyOp(ev),')
  })

  it('行き先の判断は opRouteOf の1つ。違うプロジェクトなら applyOpToConversation、同じなら従来の applyOp', () => {
    expect(src).toContain(
      "if (turnDir !== null && opRouteOf(turnDir, viewingDirRef.current, clientRef.current !== null) === 'turn') applyOpToConversation(turnDir, op)\n    else applyOp(op)",
    )
    expect(src).toContain('opRouteOf(turnDir, viewingDirRef.current, clientRef.current !== null)')
    expect(src).not.toContain('opRouteOf(turnDir, viewingDirRef.current) ===')
    // 読み込み中に届いた main の通知は画面に当てず、読み込みが済んだらストアから読み直す（抜けも二重も残さない）
    expect(src).toContain('if (!clientRef.current) { appliedDuringLoadRef.current = true; return }')
    expect(src).toContain('if (appliedDuringLoadRef.current) {')
    expect(src).toContain('useEffect(() => { viewingDirRef.current = projectDir ?? null }, [projectDir])')
    expect(src).toContain("import { loadConversationView, loadConversationChecked, makeConvClient, opRouteOf, applyOpToConversation, type Op } from '../chatConvClient'")
  })

  it('単独チャット（ChatApp）は、セッションを閉じ込めた applyOp のまま（変えない）', () => {
    const app = readCode('src/renderer/components/ChatApp.tsx')
    expect(app).toContain('onMessageEvent: (ev) => applyOp(ev),')
    expect(app).toContain('const applyOp = useCallback((op: Op) => {\n    const client = getConvClient(activeId)')
  })
})
