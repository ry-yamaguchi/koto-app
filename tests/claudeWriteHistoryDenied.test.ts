// tests/claudeWriteHistoryDenied.test.ts — P-143: Claude の Write/Edit のうち Koto の canUseTool が必ず断るもの
// （file_path 無し・プロジェクトの外・管理領域）は、書かれないので 🕘履歴の退避も writeWatch の控えもしない。
// それ以外（ふつうの場所。✋ で利用者が拒否するものを含む）は今までどおり書く前に必ず退避する。
// 偽物にするのは退避（backup/store）と承認だけ。hook と canUseTool を直接呼び、同じ入力で判断が一致することを見る。
import { describe, it, expect, beforeEach, vi } from 'vitest'

const snaps = vi.hoisted(() => ({ writes: [] as string[], changes: [] as string[] }))
vi.mock('../src/main/backup/store', () => ({
  snapshotBeforeWrite: (_d: string, _id: string, rel: string) => { snaps.writes.push(rel) },
  snapshotBeforeChange: (_d: string, _id: string, rel: string) => { snaps.changes.push(rel) },
}))
vi.mock('../src/main/chat/approvalStore', () => ({ requestApproval: async () => true }))

import { makePreToolUseHook, makePostToolUseHook, makeCanUseTool, claudeWriteDenialOf } from '../src/main/claude/agent'

const PROJECT = '/Users/someone/proj'

async function runHook(writeRoot: string, tool: 'Write' | 'Edit', file_path: unknown) {
  const touched: string[] = []
  const hook = makePreToolUseHook(PROJECT, writeRoot, 'snap', 'label', { touch: (p: string) => { touched.push(p) } } as any)
  const input = { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path, content: 'x', old_string: 'a', new_string: 'b' } }
  const r = await hook(input as any, undefined, { signal: new AbortController().signal } as any)
  return { r, touched }
}

const DENIED: [string, unknown][] = [
  ['.git/hooks/x', `${PROJECT}/.git/hooks/x`],
  ['.sakuraide-backup/x', `${PROJECT}/.sakuraide-backup/x`],
  ['.sakuraide.json', `${PROJECT}/.sakuraide.json`],
  ['プロジェクトの外（絶対）', '/Users/someone/.zshrc'],
  ['プロジェクトの外（..）', '../outside.txt'],
  ['file_path が空', ''],
  ['file_path が無い', undefined],
]

describe('P-143: 必ず断る書き込みは hook が退避も控えもしない', () => {
  beforeEach(() => { snaps.writes.length = 0; snaps.changes.length = 0 })

  for (const tool of ['Write', 'Edit'] as const) {
    for (const [name, p] of DENIED) {
      it(`${tool}: ${name} は退避も touch もしない・書き込み自体は止めない`, async () => {
        const { r, touched } = await runHook(PROJECT, tool, p)
        expect(r).toEqual({ continue: true })
        expect(snaps.writes).toEqual([])
        expect(snaps.changes).toEqual([])
        expect(touched).toEqual([])
      })
    }
  }

  it('ふつうの場所は今までどおり退避して touch する（Write は snapshotBeforeWrite・Edit は snapshotBeforeChange）', async () => {
    const w = await runHook(PROJECT, 'Write', `${PROJECT}/src/a.ts`)
    expect(snaps.writes).toEqual(['src/a.ts'])
    expect(w.touched).toEqual([`${PROJECT}/src/a.ts`])
    const e = await runHook(PROJECT, 'Edit', `${PROJECT}/src/b.ts`)
    expect(snaps.changes).toEqual(['src/b.ts'])
    expect(e.touched).toEqual([`${PROJECT}/src/b.ts`])
  })

  it('作業フォルダが public/ のとき、相対パスは作業フォルダ基準で解いて退避する', async () => {
    await runHook(`${PROJECT}/public`, 'Write', 'index.html')
    expect(snaps.writes).toEqual(['public/index.html'])
  })

  it('canUseTool と hook は同じ判断: canUseTool が必ず断る入力だけ hook が退避しない', async () => {
    const cases: unknown[] = [...DENIED.map(d => d[1]), `${PROJECT}/src/ok.ts`, `${PROJECT}/server.js`, 'rel.txt']
    for (const p of cases) {
      snaps.writes.length = 0
      const canUseTool = makeCanUseTool(PROJECT, PROJECT, 'auto', 't')
      const res = await canUseTool('Write', { file_path: p, content: 'x' } as any, {} as any)
      await runHook(PROJECT, 'Write', p)
      expect(res.behavior === 'deny').toBe(snaps.writes.length === 0)
      expect(claudeWriteDenialOf(PROJECT, PROJECT, p) !== null).toBe(res.behavior === 'deny')
      if (res.behavior === 'deny') expect((res as any).message).toBe(claudeWriteDenialOf(PROJECT, PROJECT, p))
    }
  })
})

describe('P-143: Post の hook も Pre と同じ解き方で通知する（退避先と通知先がずれない）', () => {
  async function runPost(writeRoot: string, file_path: unknown) {
    const notified: string[] = []
    const hook = makePostToolUseHook(PROJECT, writeRoot, (r) => { notified.push(r) })
    const input = { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path } }
    await hook(input as any, undefined, { signal: new AbortController().signal } as any)
    return notified
  }

  it('作業フォルダが public/ のとき、相対の index.html は public/index.html として通知する', async () => {
    expect(await runPost(`${PROJECT}/public`, 'index.html')).toEqual(['public/index.html'])
  })
  it('絶対パスはそのまま相対にして通知する', async () => {
    expect(await runPost(PROJECT, `${PROJECT}/src/a.ts`)).toEqual(['src/a.ts'])
  })
  it('プロジェクトの外・管理領域・file_path 無しは通知しない', async () => {
    expect(await runPost(PROJECT, '/Users/someone/.zshrc')).toEqual([])
    expect(await runPost(PROJECT, `${PROJECT}/.git/hooks/x`)).toEqual([])
    expect(await runPost(PROJECT, undefined)).toEqual([])
  })
  it('Pre が退避した相対パスと Post が通知する相対パスは同じ', async () => {
    snaps.writes.length = 0
    await runHook(`${PROJECT}/public`, 'Write', 'index.html')
    expect(await runPost(`${PROJECT}/public`, 'index.html')).toEqual(snaps.writes)
  })
})
