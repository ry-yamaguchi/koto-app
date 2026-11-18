// open_preview（プレビューを開く道具）を、さくらのAI Engine 側と同じ堅さにする歯止め（P42-3）。
//  - 開けるのは .html・.htm だけ（拡張子の絞りは shared/toolExecCore.ts の1か所。3つの経路に共通）
//  - 存在を確かめる
//  - Claude の道具は、renderer が確かめて開いた結果が返るまで「開きました」と言わない
//  - 開く先は送信時のプロジェクト（知らせが届いた時点で見ているプロジェクトではない）
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/main/ipc/sakura', () => ({
  sakuraClient: () => ({}),
  isContextLimitError: () => false,
  safeMaxTokens: () => null,
}))
vi.mock('../src/main/ipc/web', () => ({ fetchUrlPage: async () => { throw new Error('このテストでは使わない') } }))

import { executeToolCore, type CoreToolContext, type ToolIo } from '../src/shared/toolExecCore'
import { startClaudeChat, type ClaudeSdkModule } from '../src/main/claude/agent'
import { IDE_MCP_SERVER_NAME } from '../src/main/claude/toolText'
import { createOpenPreviewBridge, answerOpenPreview, OPEN_PREVIEW_UNCONFIRMED, type OpenPreviewNotice } from '../src/main/claude/openPreviewBridge'
import { handleOpenPreviewNotice } from '../src/renderer/claudeOpenPreview'
import { toolsFor } from '../src/shared/aiToolsCore'

function makeIo(over: Partial<ToolIo> = {}): ToolIo & { opened: string[]; existsCalls: string[] } {
  const opened: string[] = []
  const existsCalls: string[] = []
  const io: any = {
    exists: async (p: string) => { existsCalls.push(p); return true },
    openPath: async (p: string) => { opened.push(p) },
    ...over,
    opened, existsCalls,
  }
  return io
}
const ctx: CoreToolContext = { writeRoot: '/w' }
const run = (io: ToolIo, p?: string) => executeToolCore('open_preview', JSON.stringify(p === undefined ? {} : { path: p }), ctx, io)

describe('open_preview（共通の本体）: 拡張子の絞り', () => {
  it.each(['a.html', 'sub/b.htm', 'C.HTML', 'd.Htm'])('%s は開く', async p => {
    const io = makeIo()
    expect(await run(io, p)).toContain('を開きました')
    expect(io.opened).toEqual([`/w/${p}`])
  })
  it('省略時は index.html を開く', async () => {
    const io = makeIo()
    await run(io)
    expect(io.opened).toEqual(['/w/index.html'])
  })
  it.each(['a.txt', 'run.command', 'x.app', 'page.html.exe', 'noext', 'a.js', 'dir/.htm.sh'])('%s は開かず、存在の確認にも進まない', async p => {
    const io = makeIo()
    const r = await run(io, p)
    expect(r).toMatch(/^エラー: /)
    expect(r).toContain('HTML')
    expect(io.opened).toEqual([])
    expect(io.existsCalls).toEqual([])
  })
})

describe('open_preview（共通の本体）: 存在の確認', () => {
  it('無いファイルは開かずエラー', async () => {
    const io = makeIo({ exists: async () => false })
    const r = await run(io, 'none.html')
    expect(r).toBe('エラー: ファイルがありません（none.html）')
    expect(io.opened).toEqual([])
  })
})

// ── Claude の道具（偽の SDK に実際に流す）──────────────────────────────
type ToolDef = { name: string; description: string; handler: (a: any) => Promise<{ content: { text: string }[] }> }

async function openPreviewTool(onOpenPreview: (rel: string) => Promise<string>): Promise<ToolDef> {
  const queries: any[] = []
  const sdk = {
    query: (arg: any) => { queries.push(arg); return (async function* () { yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, duration_ms: 1 } })() },
    tool: (name: string, description: string, _s: unknown, handler: ToolDef['handler']): ToolDef => ({ name, description, handler }),
    createSdkMcpServer: (o: any) => ({ type: 'sdk', name: o.name, instance: {}, tools: o.tools }),
  } as unknown as ClaudeSdkModule
  await new Promise<void>(resolve => {
    startClaudeChat({
      projectDir: '/tmp/p', writeRoot: '/tmp/p/public', apiKey: 'k', writeMode: 'auto', aiEngineKey: null, rag: null,
      prompt: 'x', images: [], snapshotId: 's', resumeSessionId: null, model: '',
      onEvent: e => { if (e.kind === 'result' || e.kind === 'error') resolve() },
      onOpenPreview, ragBudgetCheck: () => ({ allowed: true }), onDelegated: () => {}, onFileWritten: () => {},
    }, sdk)
  })
  const t = (queries[0].options.mcpServers[IDE_MCP_SERVER_NAME].tools as ToolDef[]).find(x => x.name === 'open_preview')
  if (!t) throw new Error('open_preview が登録されていない')
  return t
}

describe('open_preview（Claude の道具）', () => {
  it('結果が返るまで返事をしない。失敗の結果はそのまま返す（「開きました」と言わない）', async () => {
    let answer!: (s: string) => void
    const t = await openPreviewTool(() => new Promise<string>(r => { answer = r }))
    let settled = false
    const p = t.handler({ path: 'x.html' }).then(r => { settled = true; return r })
    await new Promise(r => setTimeout(r, 5))
    expect(settled).toBe(false)
    answer('エラー: ファイルがありません（x.html）')
    const r = await p
    expect(r.content[0].text).toBe('エラー: ファイルがありません（x.html）')
    expect(r.content[0].text).not.toContain('開きました')
  })
  it('成功の結果の文もそのまま返る', async () => {
    const t = await openPreviewTool(async rel => `ブラウザで ${rel} を開きました。`)
    expect((await t.handler({ path: './a.html' })).content[0].text).toBe('ブラウザで a.html を開きました。')
  })
  it('不正なパスは renderer へ依頼しない', async () => {
    const onOpen = vi.fn(async () => 'x')
    const t = await openPreviewTool(onOpen)
    expect((await t.handler({ path: '../a.html' })).content[0].text).toContain('不正なパス')
    expect(onOpen).not.toHaveBeenCalled()
  })
  it('道具の説明に、開けるのは HTML だけと書いてある（Claude の道具・さくらのAI Engine の道具の両方）', async () => {
    const t = await openPreviewTool(async () => '')
    expect(t.description).toContain('HTML 以外のファイルは開けない')
    const twin = (toolsFor('/p', false, false) as any[]).find(x => x.function.name === 'open_preview')
    expect(twin.function.description).toBe(t.description)
    expect(twin.function.parameters.properties.path.description).toContain('.html')
  })
})

// ── 橋（main）と受け口（renderer）──────────────────────────────────────
describe('openPreviewBridge', () => {
  it('知らせに id と送信時のプロジェクトを載せ、返事で解ける', async () => {
    const sent: OpenPreviewNotice[] = []
    const b = createOpenPreviewBridge({ projectDir: '/p/A', writeRoot: '/p/A/public', send: n => sent.push(n) })
    const p = b.request('a.html')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ kind: 'openPreview', path: 'a.html', projectDir: '/p/A', writeRoot: '/p/A/public' })
    expect(answerOpenPreview(sent[0].id, 'OK')).toBe(true)
    expect(await p).toBe('OK')
    expect(answerOpenPreview(sent[0].id, 'again')).toBe(false)
    expect(answerOpenPreview('unknown', 'x')).toBe(false)
  })
  it('返事が来なければ待ち切って「確かめられませんでした」を返す', async () => {
    const b = createOpenPreviewBridge({ projectDir: '/p', writeRoot: '/p', send: () => {}, timeoutMs: 10 })
    expect(await b.request('a.html')).toBe(OPEN_PREVIEW_UNCONFIRMED)
  })
  it('送れなければ確かめられなかった扱い。中断で待ちが解ける', async () => {
    const bad = createOpenPreviewBridge({ projectDir: '/p', writeRoot: '/p', send: () => { throw new Error('gone') } })
    expect(await bad.request('a.html')).toBe(OPEN_PREVIEW_UNCONFIRMED)
    const b = createOpenPreviewBridge({ projectDir: '/p', writeRoot: '/p', send: () => {} })
    const p = b.request('a.html')
    b.cancelAll()
    expect(await p).toMatch(/^エラー: /)
  })
})

describe('handleOpenPreviewNotice（renderer）', () => {
  it('知らせに載った送信時のプロジェクトで実行し、結果を id つきで返す', async () => {
    const calls: any[] = []
    const replies: any[] = []
    await handleOpenPreviewNotice(
      { id: 'i1', path: 'a.html', projectDir: '/p/A', writeRoot: '/p/A/public' },
      {
        execute: async (name, args, c) => { calls.push({ name, args, c }); return '結果' },
        reply: (id, r) => { replies.push([id, r]) },
      },
    )
    expect(calls).toEqual([{ name: 'open_preview', args: JSON.stringify({ path: 'a.html' }), c: { writeRoot: '/p/A/public', projectRoot: '/p/A' } }])
    expect(replies).toEqual([['i1', '結果']])
  })
  it('実行が例外でも、失敗の文を返す', async () => {
    const replies: any[] = []
    await handleOpenPreviewNotice(
      { id: 'i2', path: 'a.html', projectDir: '/p', writeRoot: '/p' },
      { execute: async () => { throw new Error('boom') }, reply: (id, r) => { replies.push([id, r]) } },
    )
    expect(replies[0][0]).toBe('i2')
    expect(replies[0][1]).toMatch(/^エラー: .*boom/)
  })
})
