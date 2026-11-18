// tests/claudeSearchDocsRag.test.ts — Claude のモードの search_docs（資料を探す道具）は、画面の「📚 資料を使う／使わない」に従う。
//
// 背景: 以前は「資料を使わない」でも、さくらのAI Engine のキーがあれば search_docs が登録され、呼ばれれば検索が走って
// 抜粋が Anthropic へ送られた。画面の切替（ChatPanel の ragEnabled）を main へ運び、
// 登録の判断をさくらのAI Engine の経路と同じ関数（shared/aiToolsCore.ts の ragToolEnabled）に通す。
//
// 偽にするのは SDK・AI Engine・Web取得・electron・fetch だけ。agent.ts・tools.ts・rag/client.ts・ipc/claude.ts は本物。
// 見るのは、偽の SDK が受け取った道具の一覧と、偽の fetch へ飛んだ通信の件数。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  /** ipc/claude.ts が startClaudeChat へ渡した引数。 */
  started: null as null | Record<string, any>,
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => '/nonexistent-koto-test-userdata' },
}))
// 第2引数（偽の SDK）が付くときは本物の startClaudeChat を動かす。ipc/claude.ts は付けないので、そちらは引数だけ記録して止める。
vi.mock('../src/main/claude/agent', async () => {
  const actual = await vi.importActual<typeof import('../src/main/claude/agent')>('../src/main/claude/agent')
  return {
    ...actual,
    startClaudeChat: (params: Record<string, any>, sdk?: any) => {
      h.started = params
      return sdk ? actual.startClaudeChat(params as any, sdk) : { abort: () => {}, turnId: 'claude-test-turn' }
    },
  }
})
vi.mock('../src/main/ipc/sakura', () => ({
  sakuraClient: () => { throw new Error('このテストでは使わない') },
  isContextLimitError: () => false,
  safeMaxTokens: () => null,
}))
vi.mock('../src/main/ipc/web', () => ({
  fetchUrlPage: async () => { throw new Error('このテストでは使わない') },
  webSearch: async () => { throw new Error('このテストでは使わない') },
}))

import { startClaudeChat, type ClaudeSdkModule, type StartClaudeChatParams } from '../src/main/claude/agent'
import { registerClaudeHandlers } from '../src/main/ipc/claude'
import { IDE_MCP_SERVER_NAME } from '../src/main/claude/toolText'
import { ragToolEnabled } from '../src/shared/aiToolsCore'
import { RAG_API_BASE } from '../src/main/rag/client'

let projectDir = ''
let fetchBodies: { url: string; body: any }[] = []

beforeEach(() => {
  h.started = null
  fetchBodies = []
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-claude-rag-'))
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    let body: any = null
    try { body = init?.body ? JSON.parse(String(init.body)) : null } catch { /* 形は問わない */ }
    fetchBodies.push({ url: String(url), body })
    const res = { results: [{ content: '抜粋の本文です', document: { id: 'd1', name: '手引き.md', status: 'available' } }] }
    return { ok: true, status: 200, text: async () => JSON.stringify(res) } as any
  }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  fs.rmSync(projectDir, { recursive: true, force: true })
})

type ToolDef = { name: string; handler: (args: any) => Promise<{ content: { text: string }[] }> }

/** 偽の SDK で1ターン走らせ、SDK が受け取った options を返す。 */
async function run(over: Partial<StartClaudeChatParams>) {
  const queries: { options: Record<string, any> }[] = []
  const sdk = {
    query: (arg: { options: Record<string, any> }) => {
      queries.push(arg)
      return (async function* () { yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, duration_ms: 1 } })()
    },
    tool: (name: string, _d: string, _s: unknown, handler: ToolDef['handler']): ToolDef => ({ name, handler }),
    createSdkMcpServer: (opts: { name: string; tools: ToolDef[] }) => ({ type: 'sdk', name: opts.name, instance: {}, tools: opts.tools }),
  } as unknown as ClaudeSdkModule
  let finish!: () => void
  const finished = new Promise<void>(r => { finish = r })
  startClaudeChat({
    projectDir, writeRoot: projectDir, apiKey: 'anthropic-key', writeMode: 'auto',
    aiEngineKey: 'ai-engine-key', rag: { tags: [] },
    prompt: '資料を見て', images: [], snapshotId: 'snap', resumeSessionId: null, model: '',
    onEvent: e => { if (e.kind === 'result' || e.kind === 'error') finish() },
    onOpenPreview: () => {}, ragBudgetCheck: () => ({ allowed: true }), onDelegated: () => {}, onFileWritten: () => {},
    ...over,
  }, sdk)
  await finished
  const options = queries[0].options
  const tools = ((options.mcpServers?.[IDE_MCP_SERVER_NAME]?.tools ?? []) as ToolDef[])
  return { options, tools, names: tools.map(t => t.name).sort() }
}

const allowedHasSearchDocs = (options: Record<string, any>) => (options.allowedTools as string[]).includes(`mcp__${IDE_MCP_SERVER_NAME}__search_docs`)

describe('ragToolEnabled（さくらのAI Engine の経路と Claude の経路が同じ判断を通る）', () => {
  it('資料を使う かつ キーあり、のときだけ true', () => {
    expect(ragToolEnabled(true, true)).toBe(true)
    expect(ragToolEnabled(true, false)).toBe(false)
    expect(ragToolEnabled(false, true)).toBe(false)
    expect(ragToolEnabled(false, false)).toBe(false)
  })
})

describe('Claude のモード: search_docs は「📚 資料を使う」に従う', () => {
  it('★★ 使わない（rag: null）なら、キーがあっても、道具が一覧にも許可にも無く、検索の通信は0件', async () => {
    const r = await run({ rag: null })
    expect(r.names).not.toContain('search_docs')
    expect(allowedHasSearchDocs(r.options)).toBe(false)
    expect(r.names).toEqual(['fetch_url', 'open_preview'])
    expect(fetchBodies).toHaveLength(0)
  })

  it('★★ 渡し忘れ（undefined）・形の読めない値でも、使わない側に倒れ、search_docs は登録されない', async () => {
    for (const bad of [undefined, 'yes', 1, {}, { tags: 'a' }, []]) {
      const r = await run({ rag: bad as any })
      expect(r.names, String(bad)).not.toContain('search_docs')
      expect(allowedHasSearchDocs(r.options), String(bad)).toBe(false)
    }
    expect(fetchBodies).toHaveLength(0)
  })

  it('使う でも AI Engine のキーが無ければ、道具は無い', async () => {
    const r = await run({ rag: { tags: [] }, aiEngineKey: null })
    expect(r.names).not.toContain('search_docs')
    expect(allowedHasSearchDocs(r.options)).toBe(false)
    expect(fetchBodies).toHaveLength(0)
  })

  it('★★ 使う＋キーあり: 道具が一覧と許可にあり、呼ぶと検索が1回走る。タグは画面から受けたものを使う', async () => {
    const r = await run({ rag: { tags: ['手引き'] } })
    expect(r.names).toEqual(['fetch_url', 'open_preview', 'search_docs'])
    expect(allowedHasSearchDocs(r.options)).toBe(true)
    const out = await r.tools.find(t => t.name === 'search_docs')!.handler({ query: 'これは何ですか' })
    expect(fetchBodies).toHaveLength(1)
    expect(fetchBodies[0].url).toBe(`${RAG_API_BASE}/v1/documents/query/`)
    expect(JSON.stringify(fetchBodies[0].body)).toContain('手引き')
    expect(out.content[0].text).toContain('抜粋の本文です')
  })

  it('★★ 使う＋キーあり でも、月の上限の確認が止めれば、通信は0件（既存の確認を通る）', async () => {
    const check = vi.fn(() => ({ allowed: false, message: '今月の上限に達しています' }))
    const r = await run({ rag: { tags: [] }, ragBudgetCheck: check })
    const out = await r.tools.find(t => t.name === 'search_docs')!.handler({ query: 'これは何ですか' })
    expect(check).toHaveBeenCalledTimes(1)
    expect(fetchBodies).toHaveLength(0)
    expect(out.content[0].text).toContain('今月の上限に達しています')
  })
})

describe('ipc/claude.ts: 画面から来た rag を startClaudeChat へ運ぶ（形の読めない値は「使わない」）', () => {
  function start(rag: unknown) {
    h.started = null
    registerClaudeHandlers({} as any)
    const fn = h.handlers.get('claude:chatStart')!
    fn({ sender: { send: () => {} } }, projectDir, 'anthropic-key', 'こんにちは', [], 'snap', null, 'ai-engine-key', '', 'auto', rag)
    return h.started!
  }
  it('{ tags } はそのまま、null は null', () => {
    expect(start({ tags: ['a', 'b'] }).rag).toEqual({ tags: ['a', 'b'] })
    expect(start({ tags: [] }).rag).toEqual({ tags: [] })
    expect(start(null).rag).toBeNull()
  })
  it('渡し忘れ（undefined）・形が違う値・文字列でないタグは、使わない／除く側に倒れる', () => {
    expect(start(undefined).rag).toBeNull()
    expect(start({}).rag).toBeNull()
    expect(start('yes').rag).toBeNull()
    expect(start({ tags: ['a', 1, null] }).rag).toEqual({ tags: ['a'] })
  })
})

describe('ipc/claude.ts: 新しい送信が始まるとき、前のターンの待っているプレビューの橋を取り消す', () => {
  it('前のターンの open_preview の待ちが「中断されました」で解かれる', async () => {
    registerClaudeHandlers({} as any)
    const fn = h.handlers.get('claude:chatStart')!
    const sender = { send: () => {} }
    h.started = null
    fn({ sender }, projectDir, 'k', 'a', [], 'snap', null, null, '', 'auto', null)
    const first = h.started!
    const waiting = first.onOpenPreview('index.html') as Promise<string>
    let settled = false
    waiting.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    fn({ sender }, projectDir, 'k', 'b', [], 'snap', null, null, '', 'auto', null)
    expect(await waiting).toBe('エラー: 中断されました')
  })
})
