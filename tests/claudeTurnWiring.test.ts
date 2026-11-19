// tests/claudeTurnWiring.test.ts — 回の印の配線を、ソースの文字列で固定する。
// 動きは claudeTurnIpc.test.ts（main）と claudeTurnIsolation.test.ts（画面）が固定する。ここは、当て先が別の行に出ないことの歯止め。
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.join(__dirname, '..')
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(l => (l.trim().startsWith('//') || l.trim().startsWith('*') ? '' : l.replace(/\s\/\/ .*$/, '')))
    .join('\n')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
const code = (rel: string) => stripComments(read(rel))
const count = (s: string, needle: string) => s.split(needle).length - 1

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}

describe('src/main/ipc/claude.ts', () => {
  const s = code('src/main/ipc/claude.ts')
  it(".send('claude:stream' は、送る口の関数の中と、superseded を送る所の2か所だけ", () => {
    expect(count(s, ".send('claude:stream'")).toBe(2)
    const i = s.indexOf('const sendTurn =')
    expect(i).toBeGreaterThan(0)
    const body = s.slice(i, s.indexOf('\n      }\n', i))
    expect(body).toContain(".send('claude:stream', { ...uiEvent, turn }")
    expect(body).toContain('if (active !== run) return')
    const sup = s.split('\n').filter(l => l.includes(".send('claude:stream'") && l.includes("kind: 'superseded'"))
    expect(sup).toHaveLength(1)
  })
  it('4か所の送り口（橋・onEvent・onDelegated・onFileWritten）は sendTurn を通る', () => {
    expect(s).toContain('send: notice => sendTurn(notice)')
    expect(s).toMatch(/onEvent: uiEvent => \{\s*sendTurn\(uiEvent\)/)
    expect(s).toContain("onDelegated: info => sendTurn({ kind: 'delegated', ...info })")
    expect(s).toContain("onFileWritten: relPath => sendTurn({ kind: 'fileWritten', path: relPath })")
  })
  it('claude:chatCancel のハンドラは turn を受ける', () => {
    expect(s).toContain("ipcMain.handle('claude:chatCancel', (_, turn: string) =>")
  })
  it('chatStart は最後の引数に turn を受け、形を確かめる', () => {
    expect(s).toMatch(/rag: \{ tags\?: unknown \} \| null, turn: string\) =>/)
    expect(s).toContain('/^[A-Za-z0-9_-]{1,64}$/.test(turn)')
  })
})

describe('preload.ts・global.d.ts（3点セット）', () => {
  const preload = code('src/main/preload.ts')
  const dts = code('src/renderer/global.d.ts')
  it('preload: chatStart の最後の引数は turn・chatCancel(turn)', () => {
    expect(preload).toContain("rag: { tags: string[] } | null, turn: string) =>")
    expect(preload).toContain("'claude:chatStart', projectDir, apiKey, prompt, images, snapshotId, resumeSessionId, aiEngineKey, model, writeMode, rag, turn)")
    expect(preload).toContain("chatCancel: (turn: string) => ipcRenderer.invoke('claude:chatCancel', turn)")
  })
  it('global.d.ts: chatStart の最後の引数は turn・chatCancel(turn)', () => {
    expect(dts).toContain('rag: { tags: string[] } | null, turn: string): Promise<{ ok: boolean; busy?: boolean; message?: string }>')
    expect(dts).toContain('chatCancel(turn: string): Promise<{ ok: boolean; stopped?: boolean }>')
  })
  it('ClaudeUiEvent の全部の種類に turn: string', () => {
    const start = dts.indexOf('type ClaudeUiEvent =')
    const body = dts.slice(start, dts.indexOf('type BackupFileAction', start))
    const variants = body.split('\n').filter(l => l.trim().startsWith('| {'))
    expect(variants.length).toBe(10)
    for (const v of variants) expect(v).toContain('turn: string }')
  })
  it('main の TurnTaggedUiEvent', () => {
    expect(code('src/main/claude/events.ts')).toContain("export type TurnTaggedUiEvent = (UiEvent | { kind: 'superseded' }) & { turn: string }")
  })
})

describe('useAiChat.ts', () => {
  const s = code('src/renderer/hooks/useAiChat.ts')
  it('if (ev.turn !== turn) return がちょうど1回で、onStream のコールバックの最初の文', () => {
    expect(count(s, 'if (ev.turn !== turn) return')).toBe(1)
    const head = 'window.electronAPI.claude.onStream((ev: ClaudeUiEvent) => {\n'
    expect(count(s, head)).toBe(1)
    const i = s.indexOf(head) + head.length
    expect(s.slice(i).trimStart().startsWith('if (ev.turn !== turn) return')).toBe(true)
    expect(s.indexOf('if (ev.turn !== turn) return')).toBeLessThan(s.indexOf('updateTurn(key, { lastActivityAt', i))
  })
  it('ev.projectDir の絞り込みを持たない（同じ判断を2か所に持たない）', () => {
    expect(s).not.toContain('ev.projectDir !== projectDir')
  })
  it('chatCancel(turn) がちょうど1回・引数なしの chatCancel() が無い', () => {
    expect(count(s, 'claude.chatCancel(turn)')).toBe(1)
    expect(s).not.toContain('chatCancel()')
  })
  it('回の印: chatStart の前に立て、finally の中で下ろす（呼び出しは1回ずつ）', () => {
    expect(count(s, 'markClaudeTurnStarted(projectDir, turn)')).toBe(1)
    expect(count(s, 'markClaudeTurnEnded(turn)')).toBe(1)
    const start = s.indexOf('markClaudeTurnStarted(projectDir, turn)')
    const call = s.indexOf('window.electronAPI.claude.chatStart(')
    expect(start).toBeGreaterThan(s.indexOf('const turn = newClaudeTurn()'))
    expect(start).toBeLessThan(call)
    const fin = s.indexOf('    } finally {\n      markClaudeTurnEnded(turn)\n')
    expect(fin).toBeGreaterThan(call)
    expect(fin).toBeLessThan(s.indexOf('emit({ kind: \'loading\', value: false })', fin))
    // 印を立てるのは、sendViaClaude の try の直前
    expect(s.slice(start, call)).toContain('try {')
  })
  it('Claude へ送る判断は、同意の確認より前', () => {
    const gate = s.indexOf('claudeSendBlocked(toolsProjectDir)')
    expect(gate).toBeGreaterThan(0)
    expect(gate).toBeLessThan(s.indexOf('let consented = hasClaudeConsent()'))
    expect(gate).toBeLessThan(s.indexOf('appendBubble(requestBubbleOf(rawText, images))', gate))
  })
})

describe('ChatPanel.tsx', () => {
  it('足した守りは、空と応答中の確かめの直後・setInput(\'\') より前', () => {
    const s = code('src/renderer/components/ChatPanel.tsx')
    const guard = s.indexOf('claudeActive && claudeSendBlocked(projectDir)')
    const clear = s.indexOf("setInput('')", s.indexOf('const send = useCallback(async () => {'))
    expect(guard).toBeGreaterThan(0)
    expect(guard).toBeLessThan(clear)
    const pre = s.slice(s.indexOf('const send = useCallback(async () => {'), guard)
    expect(pre).toContain('|| isLoading) return')
    expect(count(s, 'claudeSendBlocked(')).toBe(1)
  })
})

describe('src/renderer の入口', () => {
  const files = walk(path.join(ROOT, 'src/renderer'))
  const users = (needle: string) => files.filter(f => stripComments(fs.readFileSync(f, 'utf-8')).includes(needle)).map(f => path.relative(ROOT, f))
  it('claude.chatStart( を呼ぶのは useAiChat.ts だけ', () => {
    expect(users('claude.chatStart(')).toEqual(['src/renderer/hooks/useAiChat.ts'])
  })
  it('claude.chatCancel( を呼ぶのは useAiChat.ts だけ', () => {
    expect(users('claude.chatCancel(')).toEqual(['src/renderer/hooks/useAiChat.ts'])
  })
})
