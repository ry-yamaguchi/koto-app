// tests/claudeQueryOptionsWiring.test.ts — Claude 頭脳モードの「守り」が、SDK の query() に**実際に渡っている**ことを固定する。
//
// ── なぜ要るか（2026-09-30）────────────────────────────────────────────────
// 以前の agent.ts は allowedTools に Edit/Write/Bash を名前だけで入れ、permissionMode を 'acceptEdits' にしていた。
// SDK は canUseTool を呼ぶ**前**に自動許可するので、Koto の守り（危険コマンドの拒否・守るパスへの書き込みの拒否・
// 「✋ 毎回確認」）は一度も効いていなかった。直した形は claudeToolGatingOptions()（agent.ts）で、
// startClaudeChat が query() の options へ `...claudeToolGatingOptions()` と展開している。
//
// ところが tests/w-chat-claudeApproval.test.ts が見ているのは claudeToolGatingOptions() の**返り値だけ**で、
// **それが query() へ渡っていること**を見るテストは0件だった。その1行を消しても、後ろのキーで
// allowedTools／permissionMode を上書きしても、全部通る。「守りの関数は正しいのに呼ばれていない」と
// 同じ形が、その修理自身に残っていた（掟10）。
//
// startClaudeChat は本物の SDK を動的 import（new Function の native import）で読むので、これまで
// 振る舞いのテストにできなかった。agent.ts に**テスト専用の省略可能な第2引数（sdkOverride）**を足したので、
// ここでは偽の SDK（query／tool／createSdkMcpServer）を渡し、**偽の SDK が受け取った options そのもの**を検査する。
//   - makeCanUseTool を直接は呼ばない。偽の SDK が受け取った canUseTool を呼ぶ
//   - 委譲・資料検索のツールも、偽の SDK が受け取った MCP サーバのツールから呼ぶ
//   - 本番の経路（第2引数なし＝動的 import）を変えていないことは、呼び出し側の引数の数（構文木）で固定する
//
// 偽物にするのは SDK と、通信に触れる部品（AI Engine・Web取得）だけ。tools.ts・approvalStore・rag/client.ts・
// 一時フォルダは本物。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as ts from 'typescript'

const ai = vi.hoisted(() => ({
  content: '',
  calls: 0,
  /** 立っている間、AI Engine の応答は返らない（応答待ちの再現）。null なら即返す。 */
  gate: null as Promise<void> | null,
}))
vi.mock('../src/main/ipc/sakura', () => ({
  sakuraClient: () => ({
    chat: {
      completions: {
        create: async () => {
          ai.calls += 1
          if (ai.gate) await ai.gate
          return {
            choices: [{ finish_reason: 'stop', message: { content: ai.content } }],
            usage: { prompt_tokens: 11, completion_tokens: 22 },
          }
        },
      },
    },
  }),
  isContextLimitError: () => false,
  safeMaxTokens: () => null,
}))
vi.mock('../src/main/ipc/web', () => ({ fetchUrlPage: async () => { throw new Error('このテストでは使わない') } }))

import { startClaudeChat, type ClaudeSdkModule, type StartClaudeChatParams, type ClaudeChatHandle } from '../src/main/claude/agent'
import { IDE_MCP_SERVER_NAME, summarizeDelegateStopped } from '../src/main/claude/toolText'
import type { UiEvent } from '../src/main/claude/events'
import {
  setApprovalListener, answerApproval, listPending, resetApprovalsForTest, cancelApprovalsForTurn,
} from '../src/main/chat/approvalStore'
import { RAG_API_BASE } from '../src/main/rag/client'
import { writeDenialMessage } from '../src/shared/approvalPlan'
import type { WriteMode } from '../src/shared/approvalPlan'

const ROOT = path.join(__dirname, '..')
const SNAPSHOT_ID = '2026-09-30T00-00-00-000Z'

let projectDir = ''
let writeRoot = '' // 作業フォルダ（public/）。projectDir（退避先・承認ダイアログの出し先）とは別のフォルダにしてある
let fetchCalls: string[] = []

beforeEach(() => {
  resetApprovalsForTest()
  setApprovalListener(null)
  ai.calls = 0
  ai.gate = null
  ai.content = ''
  fetchCalls = []
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-claude-query-wiring-'))
  writeRoot = path.join(projectDir, 'public')
  fs.mkdirSync(writeRoot, { recursive: true })
  // search_docs の通信先（rag/client.ts は本物・fetch だけ偽物）。呼ばれた URL を記録する。
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    fetchCalls.push(String(url))
    const body = { results: [{ content: '抜粋の本文です', document: { id: 'd1', name: '手引き.md', status: 'available' } }] }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) } as any
  }))
})
afterEach(() => {
  setApprovalListener(null)
  vi.unstubAllGlobals()
  fs.rmSync(projectDir, { recursive: true, force: true })
})

// ══ 偽の SDK ═══════════════════════════════════════════════════════════════════
// startClaudeChat が SDK から使うのは query／tool／createSdkMcpServer の3つだけ（agent.ts の ClaudeSdkModule）。
// 本物と同じ形で受け取り、受け取ったものを記録する。query() は結果1件を流して終わる（＝1ターンが正常終了する）。

type QueryArg = { prompt: unknown; options: Record<string, any> }
type ToolDef = { name: string; description: string; schema: unknown; handler: (args: any) => Promise<{ content: { text: string }[] }> }

function makeFakeSdk() {
  const queries: QueryArg[] = []
  const sdk = {
    query: (arg: QueryArg) => {
      queries.push(arg)
      return (async function* () {
        yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, duration_ms: 1 }
      })()
    },
    tool: (name: string, description: string, schema: unknown, handler: ToolDef['handler']): ToolDef => ({ name, description, schema, handler }),
    // 本物の createSdkMcpServer は { type:'sdk', name, instance } を返す。ここでは渡された tools も持たせる。
    createSdkMcpServer: (opts: { name: string; version: string; tools: ToolDef[] }) => ({ type: 'sdk', name: opts.name, instance: {}, tools: opts.tools }),
  }
  return { sdk: sdk as unknown as ClaudeSdkModule, queries }
}

type Run = {
  handle: ClaudeChatHandle
  events: UiEvent[]
  /** 偽の SDK の query() が受け取った options（＝実際に SDK へ渡ったもの）。 */
  options: Record<string, any>
  queries: QueryArg[]
  onOpenPreview: ReturnType<typeof vi.fn>
  onDelegated: ReturnType<typeof vi.fn>
  onFileWritten: ReturnType<typeof vi.fn>
  ragBudgetCheck: ReturnType<typeof vi.fn>
}

/** startClaudeChat を偽の SDK で1ターン走らせ、終端イベント（result/error）が出るまで待つ。 */
async function runChat(over: Partial<StartClaudeChatParams> = {}): Promise<Run> {
  const fake = makeFakeSdk()
  const events: UiEvent[] = []
  let finish!: () => void
  const finished = new Promise<void>(r => { finish = r })
  const onOpenPreview = vi.fn()
  const onDelegated = vi.fn()
  const onFileWritten = vi.fn()
  const ragBudgetCheck = vi.fn(() => ({ allowed: true }))
  const handle = startClaudeChat({
    projectDir, writeRoot, apiKey: 'test-anthropic-key', writeMode: 'auto', aiEngineKey: 'test-ai-engine-key',
    prompt: 'ページを作って', images: [], snapshotId: SNAPSHOT_ID, resumeSessionId: null, model: '',
    onEvent: e => { events.push(e); if (e.kind === 'result' || e.kind === 'error') finish() },
    onOpenPreview, ragBudgetCheck, onDelegated, onFileWritten,
    ...over,
  }, fake.sdk)
  await finished
  if (fake.queries.length !== 1) throw new Error(`偽の SDK の query() が ${fake.queries.length} 回呼ばれた（1回のはず）。events=${JSON.stringify(events)}`)
  return { handle, events, options: fake.queries[0].options, queries: fake.queries, onOpenPreview, onDelegated, onFileWritten, ragBudgetCheck }
}

/** 偽の SDK が受け取った MCP サーバのツールを名前で取る（SDK が実際に呼ぶのと同じ口）。 */
function sdkTool(run: Run, name: string): ToolDef['handler'] {
  const server = run.options.mcpServers?.[IDE_MCP_SERVER_NAME]
  if (!server) throw new Error(`options.mcpServers に ${IDE_MCP_SERVER_NAME} が渡っていない`)
  const t = (server.tools as ToolDef[]).find(x => x.name === name)
  if (!t) throw new Error(`SDK が受け取ったツールに ${name} が無い（あるのは ${(server.tools as ToolDef[]).map(x => x.name).join(', ')}）`)
  return t.handler
}

/** 偽の SDK が受け取った canUseTool を、SDK が呼ぶのと同じ形（toolName, input, {signal}）で呼ぶ。 */
function callCanUseTool(run: Run, toolName: string, input: Record<string, unknown>): Promise<{ behavior: string; message?: string }> {
  const fn = run.options.canUseTool
  if (typeof fn !== 'function') throw new Error('query() の options に canUseTool が渡っていない')
  return fn(toolName, input, { signal: new AbortController().signal })
}

const tick = () => new Promise<void>(r => setTimeout(r, 0))
const text = (r: { content: { text: string }[] }) => r.content[0].text
const exists = (rel: string) => fs.existsSync(path.join(writeRoot, rel))
const inWriteRoot = (rel: string) => path.join(writeRoot, rel)

// ══ 1. allowedTools / permissionMode / settingSources ══════════════════════════════

describe('query() へ実際に渡った options: allowedTools・permissionMode・settingSources（守りが canUseTool を迂回しない）', () => {
  it('前提: 偽の SDK の query() は1回呼ばれ、1ターンが result で終わる（テストが空回りしていない）', async () => {
    const run = await runChat()
    expect(run.queries).toHaveLength(1)
    expect(run.events.some(e => e.kind === 'result')).toBe(true)
    expect(run.options.cwd).toBe(writeRoot) // 作業フォルダ（退避先の projectDir ではない）
  })

  it('★★★ allowedTools は配列で渡っており、Edit／Write／Bash が名前だけ（括弧の絞り込み無し）で入っていない', async () => {
    const { options } = await runChat()
    expect(Array.isArray(options.allowedTools)).toBe(true)
    const bare = (options.allowedTools as string[]).filter(t => !t.includes('('))
    expect(bare).not.toContain('Edit')
    expect(bare).not.toContain('Write')
    expect(bare).not.toContain('Bash')
  })

  it('★★ allowedTools は「読み取り専用の3つ」＋「IDE の MCP ツール」だけ（ほかに自動許可を増やしていない）', async () => {
    const { options } = await runChat()
    const tools = options.allowedTools as string[]
    // 読み取り専用は確認なしのままでよい（渡っていなければ、毎回 canUseTool を通るだけで安全側だが、意図した形を固定する）
    expect(tools).toContain('Read')
    expect(tools).toContain('Glob')
    expect(tools).toContain('Grep')
    // それ以外はすべて IDE の MCP ツール（mcp__ide__…）。Edit/Write/Bash 以外の書き込み系（NotebookEdit 等）も入れない
    const others = tools.filter(t => !['Read', 'Glob', 'Grep'].includes(t))
    expect(others.length).toBeGreaterThan(0)
    for (const t of others) expect(t.startsWith(`mcp__${IDE_MCP_SERVER_NAME}__`), t).toBe(true)
  })

  it('★★★ permissionMode は \'default\'（acceptEdits でも bypassPermissions でもない）・危険な許可のスキップも付いていない', async () => {
    const { options } = await runChat()
    expect(options.permissionMode).toBe('default')
    expect(options.permissionMode).not.toBe('acceptEdits')
    expect(options.permissionMode).not.toBe('bypassPermissions')
    expect(options.allowDangerouslySkipPermissions).toBeFalsy()
  })

  it('★★ settingSources は空配列（利用者の ~/.claude の許可ルールで、上の守りが上書きされない）', async () => {
    const { options } = await runChat()
    expect(options.settingSources).toEqual([])
  })

  it('★ resume の自己修復リトライ（2回目の query）でも同じ守りが渡る（runOptions は options の写し）', async () => {
    // resume を指定して1回目の query() が開始直後に失敗 → resume 無しでやり直す。その2回目にも守りが付いていること。
    const queries: QueryArg[] = []
    const sdk = {
      query: (arg: QueryArg) => {
        queries.push(arg)
        if (queries.length === 1) return (async function* () { throw new Error('session not found') })()
        return (async function* () { yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, duration_ms: 1 } })()
      },
      tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
      createSdkMcpServer: (opts: any) => ({ type: 'sdk', name: opts.name, instance: {}, tools: opts.tools }),
    } as unknown as ClaudeSdkModule
    let finish!: () => void
    const finished = new Promise<void>(r => { finish = r })
    startClaudeChat({
      projectDir, writeRoot, apiKey: 'k', writeMode: 'confirm', aiEngineKey: null,
      prompt: 'こんにちは', images: [], snapshotId: SNAPSHOT_ID, resumeSessionId: 'old-session', model: '',
      onEvent: e => { if (e.kind === 'result' || e.kind === 'error') finish() },
      onOpenPreview: () => {}, ragBudgetCheck: () => ({ allowed: true }), onDelegated: () => {}, onFileWritten: () => {},
    }, sdk)
    await finished
    expect(queries).toHaveLength(2)
    expect(queries[0].options.resume).toBe('old-session')
    expect(queries[1].options.resume).toBeUndefined()
    for (const q of queries) {
      expect(q.options.permissionMode).toBe('default')
      expect((q.options.allowedTools as string[]).filter(t => !t.includes('('))).not.toContain('Bash')
      expect(typeof q.options.canUseTool).toBe('function')
      expect(q.options.settingSources).toEqual([])
    }
  })
})

// ══ 2. canUseTool（偽の SDK が受け取ったものを、そのまま呼ぶ）═══════════════════════════

describe('query() へ実際に渡った canUseTool: 危険コマンド・守るパス・「✋ 毎回確認」', () => {
  for (const mode of ['confirm', 'auto'] as const) {
    it(`★★★ ${mode}: 危険なコマンド（rm -rf /）の Bash は deny（確認するまでもなく拒否・帳簿にも積まない）`, async () => {
      const run = await runChat({ writeMode: mode })
      const r = await callCanUseTool(run, 'Bash', { command: 'rm -rf /' })
      expect(r.behavior).toBe('deny')
      expect(r.message).toContain('危険')
      expect(listPending()).toEqual([])
    })

    it(`★★★ ${mode}: 守るパス（.git/hooks/x）への Write は deny（承認では守れない領域なので、聞きもしない）`, async () => {
      const run = await runChat({ writeMode: mode })
      const r = await callCanUseTool(run, 'Write', { file_path: inWriteRoot('.git/hooks/x'), content: 'x' })
      expect(r.behavior).toBe('deny')
      expect(listPending()).toEqual([])
      expect(exists('.git/hooks/x')).toBe(false)
    })

    it(`${mode}: 守るパス（.sakuraide-backup）への Edit も deny`, async () => {
      const run = await runChat({ writeMode: mode })
      const r = await callCanUseTool(run, 'Edit', { file_path: inWriteRoot('.sakuraide-backup/a/b.txt'), old_string: 'a', new_string: 'b' })
      expect(r.behavior).toBe('deny')
      expect(listPending()).toEqual([])
    })
  }

  it('★★★ confirm（✋ 毎回確認）: 普通の Write は承認を求めて駐機する。許可すると allow', async () => {
    const run = await runChat({ writeMode: 'confirm' })
    const p = callCanUseTool(run, 'Write', { file_path: inWriteRoot('index.html'), content: '<html></html>' })
    await tick()
    expect(listPending()).toHaveLength(1)
    // 文面は作業フォルダ基準の相対パス・出し先は退避先（projectDir）。引数の取り違え（scopeDir⇔writeRoot）も検知する
    expect(listPending()[0].label).toBe('✏️ ファイルの保存（index.html）')
    expect(listPending()[0].dir).toBe(projectDir)
    expect(answerApproval(listPending()[0].id, true)).toBe(true)
    expect(await p).toEqual({ behavior: 'allow' })
  })

  it('★★★ confirm: 承認を拒否すると deny（さくらのAI Engine 経路と同じ拒否文面）', async () => {
    const run = await runChat({ writeMode: 'confirm' })
    const p = callCanUseTool(run, 'Write', { file_path: inWriteRoot('index.html'), content: 'x' })
    await tick()
    answerApproval(listPending()[0].id, false)
    const r = await p
    expect(r.behavior).toBe('deny')
    expect(r.message).toBe(writeDenialMessage('write_file', JSON.stringify({ path: 'index.html' })))
  })

  it('★★ confirm: Bash も承認を求める（安全そうな ls でも、✋ 毎回確認なら聞く）', async () => {
    const run = await runChat({ writeMode: 'confirm' })
    const p = callCanUseTool(run, 'Bash', { command: 'ls' })
    await tick()
    expect(listPending()).toHaveLength(1)
    expect(listPending()[0].label).toContain('ls')
    answerApproval(listPending()[0].id, false)
    expect((await p).behavior).toBe('deny')
  })

  it('★★ auto（おまかせ）: 普通の Write は駐機せず allow', async () => {
    const run = await runChat({ writeMode: 'auto' })
    expect(await callCanUseTool(run, 'Write', { file_path: inWriteRoot('index.html'), content: 'x' })).toEqual({ behavior: 'allow' })
    expect(listPending()).toEqual([])
  })

  it('★ 承認待ちの束ね先は handle.turnId（⏹ 相当の cancelApprovalsForTurn(handle.turnId) で拒否として解ける）', async () => {
    const run = await runChat({ writeMode: 'confirm' })
    const p = callCanUseTool(run, 'Write', { file_path: inWriteRoot('index.html'), content: 'x' })
    await tick()
    expect(listPending()).toHaveLength(1)
    expect(cancelApprovalsForTurn('別のターン')).toBe(0) // 他のターンには触らない
    expect(cancelApprovalsForTurn(run.handle.turnId)).toBe(1)
    expect((await p).behavior).toBe('deny')
    expect(listPending()).toEqual([])
  })

  it('有効化していないツール（WebFetch）は deny', async () => {
    const run = await runChat()
    const r = await callCanUseTool(run, 'WebFetch', { url: 'https://example.com' })
    expect(r.behavior).toBe('deny')
  })

  it('⏹ の印: options.abortController は handle.abort() で止まる（ipc/claude.ts の claude:chatCancel が呼ぶもの）', async () => {
    const run = await runChat()
    const ac = run.options.abortController as AbortController
    expect(ac.signal.aborted).toBe(false)
    run.handle.abort()
    expect(ac.signal.aborted).toBe(true)
  })
})

// ══ 3. IDE ツール（偽の SDK が受け取った MCP サーバのツールを呼ぶ）══════════════════════

describe('query() へ実際に渡った MCP サーバのツール: 登録・isStopped・writeMode・turnId・ragBudgetCheck・onOpenPreview', () => {
  const toolNames = (run: Run) => (run.options.mcpServers[IDE_MCP_SERVER_NAME].tools as ToolDef[]).map(t => t.name).sort()

  it('AI Engine のキーがあれば4つ（fetch_url・search_docs・open_preview・delegate_implementation）、無ければ delegate_implementation を除く3つ', async () => {
    expect(toolNames(await runChat({ aiEngineKey: 'k' }))).toEqual(['delegate_implementation', 'fetch_url', 'open_preview', 'search_docs'])
    expect(toolNames(await runChat({ aiEngineKey: null }))).toEqual(['fetch_url', 'open_preview', 'search_docs'])
  })

  // ── ragBudgetCheck（W-85）──
  it('★★ search_docs: 渡した ragBudgetCheck が上限超えを返せば、fetch は1回も呼ばれず、止めた文が返る', async () => {
    const check = vi.fn(() => ({ allowed: false, message: '今月の上限に達しています' }))
    const run = await runChat({ ragBudgetCheck: check })
    const r = await sdkTool(run, 'search_docs')({ query: 'これは何ですか' })
    expect(check).toHaveBeenCalledTimes(1) // agent.ts が握りつぶさず・作り替えず、渡された口をそのまま通す
    expect(fetchCalls).toHaveLength(0) // ★お金の歯止め
    expect(text(r)).toContain('今月の上限に達しています')
  })

  it('search_docs: 上限内（allowed:true）なら fetch が1回・抜粋が返る（対照）', async () => {
    const run = await runChat() // 既定の ragBudgetCheck は常に許可
    const r = await sdkTool(run, 'search_docs')({ query: 'これは何ですか' })
    expect(run.ragBudgetCheck).toHaveBeenCalledTimes(1)
    expect(fetchCalls).toEqual([`${RAG_API_BASE}/v1/documents/query/`])
    expect(text(r)).toContain('抜粋の本文です')
  })

  // ── open_preview ──
  it('open_preview: 渡した onOpenPreview が呼ばれる（相対パスで）', async () => {
    const run = await runChat()
    await sdkTool(run, 'open_preview')({ path: 'index.html' })
    expect(run.onOpenPreview).toHaveBeenCalledWith('index.html')
  })

  // ── delegate_implementation: isStopped ──
  function aiReplies(files: { path: string; content: string }[]) {
    ai.content = JSON.stringify({ files, notes: '' })
  }
  /** AI Engine へ依頼が飛んだところまで進める（＝応答待ちに入った）。 */
  async function waitAiCalled() {
    for (let i = 0; i < 50 && ai.calls < 1; i++) await tick()
    expect(ai.calls).toBe(1)
  }
  function holdAiEngine(): { open: () => void } {
    let open!: () => void
    ai.gate = new Promise<void>(r => { open = r })
    return { open }
  }

  for (const mode of ['confirm', 'auto'] as const) {
    it(`★★★ delegate_implementation（${mode}）: AI Engine の応答待ちの最中に handle.abort()（⏹）→ 応答が返っても、聞かず・書かない（isStopped が abortController を見ている）`, async () => {
      aiReplies([{ path: 'index.html', content: 'AFTER-STOP' }])
      let asked = 0
      setApprovalListener(list => { if (list.length) { asked += 1; answerApproval(list[0].id, true) } }) // 聞かれたら即「許可」。聞いたこと自体を捕まえる
      const hold = holdAiEngine()
      const run = await runChat({ writeMode: mode })
      const p = sdkTool(run, 'delegate_implementation')({ task: 'ページを作る' })
      await waitAiCalled()
      run.handle.abort() // ⏹（ipc/claude.ts の claude:chatCancel: abort() → cancelApprovalsForTurn）
      cancelApprovalsForTurn(run.handle.turnId)
      hold.open()
      const r = await p
      expect(asked).toBe(0)
      expect(listPending()).toEqual([])
      expect(exists('index.html')).toBe(false)
      expect(fs.existsSync(path.join(projectDir, '.sakuraide-backup'))).toBe(false)
      expect(run.onFileWritten).not.toHaveBeenCalled()
      expect(text(r)).toBe(summarizeDelegateStopped([], ['index.html'], { promptTokens: 11, completionTokens: 22 }))
    })
  }

  it('★ 対照（auto）: ⏹ を押していなければ、同じ流れで書く（onFileWritten・onDelegated も渡した関数が呼ばれる）', async () => {
    aiReplies([{ path: 'index.html', content: 'OK' }])
    const run = await runChat({ writeMode: 'auto' })
    const r = await sdkTool(run, 'delegate_implementation')({ task: 'ページを作る' })
    expect(fs.readFileSync(inWriteRoot('index.html'), 'utf8')).toBe('OK')
    expect(run.onFileWritten).toHaveBeenCalledWith('public/index.html') // エディタの開きタブはプロジェクト直下からの相対パス
    expect(run.onDelegated).toHaveBeenCalledWith({ model: expect.any(String), promptTokens: 11, completionTokens: 22 })
    expect(text(r)).toContain('委譲が完了しました')
  })

  // ── delegate_implementation: writeMode・turnId ──
  it('★★ delegate_implementation（confirm）: 書く前に承認を求める（dir は projectDir）。許可すると書く', async () => {
    aiReplies([{ path: 'index.html', content: 'OK' }])
    const run = await runChat({ writeMode: 'confirm' })
    const p = sdkTool(run, 'delegate_implementation')({ task: 'ページを作る' })
    for (let i = 0; i < 50 && listPending().length < 1; i++) await tick()
    expect(listPending()).toHaveLength(1)
    expect(listPending()[0].dir).toBe(projectDir)
    expect(exists('index.html')).toBe(false) // 聞いている間は書いていない
    answerApproval(listPending()[0].id, true)
    await p
    expect(fs.readFileSync(inWriteRoot('index.html'), 'utf8')).toBe('OK')
  })

  it('★★ delegate_implementation（confirm）: 承認待ちは handle.turnId で束ねられ、⏹ 相当の cancelApprovalsForTurn で拒否として解け、書かない', async () => {
    aiReplies([{ path: 'index.html', content: 'NO' }])
    const run = await runChat({ writeMode: 'confirm' })
    const p = sdkTool(run, 'delegate_implementation')({ task: 'ページを作る' })
    for (let i = 0; i < 50 && listPending().length < 1; i++) await tick()
    expect(listPending()).toHaveLength(1)
    expect(cancelApprovalsForTurn(run.handle.turnId)).toBe(1) // makeCanUseTool と同じ turnId
    await p
    expect(exists('index.html')).toBe(false)
    expect(run.onFileWritten).not.toHaveBeenCalled()
  })
})

// ══ 4. 本番の経路を変えていない（第2引数 sdkOverride は、本番のどの呼び出し元も渡さない）═══════

type StartCall = { file: string; line: number; argCount: number }
type StartScan = { calls: StartCall[]; escapes: { file: string; line: number }[] }

/** ソース1本を構文木で読み、startClaudeChat の呼び出し（引数の数つき）と、呼び出し以外の参照を拾う。 */
function scanStartClaudeChat(file: string, source: string): StartScan {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2020, true, kind)
  const out: StartScan = { calls: [], escapes: [] }
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n) && n.text === 'startClaudeChat') {
      const p = n.parent
      const isImport = ts.isImportSpecifier(p)
      const isDecl = ts.isFunctionDeclaration(p) && p.name === n
      const isCall = ts.isCallExpression(p) && p.expression === n
      if (isCall) out.calls.push({ file, line: lineOf(n), argCount: (p as ts.CallExpression).arguments.length })
      else if (!isImport && !isDecl) out.escapes.push({ file, line: lineOf(n) }) // 別名・引数として持ち回る・再 export など
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

function listSrcFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) out.push(...listSrcFiles(full))
    else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

describe('本番の経路（sdkOverride を渡さない＝動的 import のまま）を変えていない', () => {
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

  it('★★ src の全 .ts/.tsx のうち startClaudeChat を呼ぶのは ipc/claude.ts の1か所だけで、引数は1つ（第2引数の sdkOverride を渡していない）', () => {
    const calls: StartCall[] = []
    const escapes: { file: string; line: number }[] = []
    for (const f of listSrcFiles(path.join(ROOT, 'src'))) {
      const r = scanStartClaudeChat(path.relative(ROOT, f), fs.readFileSync(f, 'utf8'))
      calls.push(...r.calls)
      escapes.push(...r.escapes)
    }
    expect(escapes).toEqual([]) // 呼び出さずに持ち回る形は、引数の数を数え漏らすので許さない
    expect(calls.map(c => `${c.file} 引数${c.argCount}`)).toEqual(['src/main/ipc/claude.ts 引数1'])
  })

  it('スキャナ自体: 2引数の呼び出し・別名・引数渡しを拾い、定義・import・コメント・文字列は数えない', () => {
    const two = scanStartClaudeChat('x.ts', `startClaudeChat({ a: 1 }, fakeSdk)`)
    expect(two.calls.map(c => c.argCount)).toEqual([2])
    const one = scanStartClaudeChat('x.ts', `const h = startClaudeChat({ a: 1 })`)
    expect(one.calls.map(c => c.argCount)).toEqual([1])
    const alias = scanStartClaudeChat('x.ts', [`const f = startClaudeChat`, `run(startClaudeChat)`, `export { startClaudeChat }`].join('\n'))
    expect(alias.escapes).toHaveLength(3)
    expect(alias.calls).toEqual([])
    const quiet = scanStartClaudeChat('x.ts', [
      `import { startClaudeChat } from './agent'`,
      `export function startClaudeChat(p: number) { return p }`,
      `// startClaudeChat(a, b)`,
      `const s = "startClaudeChat(a, b)"`,
    ].join('\n'))
    expect(quiet.calls).toEqual([])
    expect(quiet.escapes).toEqual([])
  })

  it('agent.ts: 第2引数は省略可能（?）で、SDK は「渡されていなければ従来どおり動的 import」で読む（呼び出しの形ごと固定）', () => {
    const agent = read('src/main/claude/agent.ts')
    expect(agent).toContain('export function startClaudeChat(params: StartClaudeChatParams, sdkOverride?: ClaudeSdkModule): ClaudeChatHandle {')
    expect(agent).toContain("      sdk = sdkOverride ?? await dynamicImportSdk('@anthropic-ai/claude-agent-sdk')\n")
    // 動的 import の呼び出しは、この1か所だけ（定義は `const dynamicImportSdk = new Function(...)` で `(` が続かない）
    expect(agent.split('dynamicImportSdk(').length - 1).toBe(1)
    // 直す前の形（override を見ない）に戻っていない
    expect(agent).not.toContain("      sdk = await dynamicImportSdk('@anthropic-ai/claude-agent-sdk')\n")
  })
})
