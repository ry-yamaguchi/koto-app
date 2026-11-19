// tests/claudeWriteCheck.test.ts — Claude の経路で AI が書いたファイルの点検（ターンの終わりの ⚠️ の吹き出し）。
//
// 成功で終わるターンの終わりに、残っている問題だけを writeCheck の出来事1つで出す（result の前・値は含まない）。
// 失敗・⏹ の回は出さない（控えは resume のやり直しへ持ち越す）。書き込みは止めない・AI へは返さない。
//
// 偽の SDK は書く前のフックを呼ばないので、試験が query() の options から PreToolUse のフックを取り出して
// 直接呼び、そのあと試験自身がファイルを書く（SDK が実際にする順と同じ）。
// 見本のキーは文字列の連結で組み立てる（実在しない値）。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const ai = vi.hoisted(() => ({ content: '', touchThrows: false }))
vi.mock('../src/main/ipc/sakura', () => ({
  sakuraClient: () => ({
    chat: {
      completions: {
        create: async () => ({
          choices: [{ finish_reason: 'stop', message: { content: ai.content } }],
          usage: { prompt_tokens: 1, completion_tokens: 2 },
        }),
      },
    },
  }),
  isContextLimitError: () => false,
  safeMaxTokens: () => null,
}))
vi.mock('../src/main/ipc/web', () => ({ fetchUrlPage: async () => { throw new Error('このテストでは使わない') } }))

vi.mock('../src/shared/writeWatch', async (orig) => {
  const mod = await orig<typeof import('../src/shared/writeWatch')>()
  return {
    ...mod,
    createWriteWatch: (o: Parameters<typeof mod.createWriteWatch>[0]) => {
      const w = mod.createWriteWatch(o)
      return { ...w, touch: (a: string, b: string | null) => { if (ai.touchThrows) throw new Error('控えの失敗'); w.touch(a, b) } }
    },
  }
})

import { startClaudeChat, type ClaudeSdkModule } from '../src/main/claude/agent'
import { IDE_MCP_SERVER_NAME, IDE_TOOL_BARE_NAMES } from '../src/main/claude/toolText'
import { writeDelegatedFiles } from '../src/main/claude/tools'
import type { UiEvent } from '../src/main/claude/events'

const GH_BODY = 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
const GH = 'gh' + 'p_' + GH_BODY
const BAD_LINE = `const token = "${GH}"`
const OLD_SESSION = 'f3d3a705-0000-4000-8000-000000000001'

let projectDir = ''
let writeRoot = ''
let outsideDir = ''
beforeEach(() => {
  ai.content = ''
  ai.touchThrows = false
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-claude-writecheck-'))
  writeRoot = path.join(projectDir, 'public')
  fs.mkdirSync(writeRoot, { recursive: true })
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-claude-writecheck-out-'))
})
afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true })
  fs.rmSync(outsideDir, { recursive: true, force: true })
})

// ── SDK のメッセージ ──────────────────────────────────────────────────────────
const initMsg = (id: string) => ({ type: 'system', subtype: 'init', session_id: id })
const textMsg = (t: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } })
const okResult = () => ({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, duration_ms: 5 })
const errResult = (message: string) => ({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [message], total_cost_usd: 0, duration_ms: 0 })
const notFoundText = `No conversation found with session ID: ${OLD_SESSION}`

type Options = Record<string, any>
type Script = (arg: { options: Options }) => AsyncGenerator<unknown>

function makeSdk(scripts: Script[]) {
  const queries: { options: Options }[] = []
  const sdk = {
    query: (arg: { options: Options }) => {
      const script = scripts[queries.length]
      queries.push(arg)
      if (!script) throw new Error(`query() が想定より多く呼ばれた（${queries.length} 回目）`)
      return script(arg)
    },
    tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
    createSdkMcpServer: (opts: any) => ({ type: 'sdk', name: opts.name, instance: {}, tools: opts.tools }),
  } as unknown as ClaudeSdkModule
  return { sdk, queries }
}

const tick = () => new Promise<void>(r => setTimeout(r, 0))
async function settle(n = 8) { for (let i = 0; i < n; i++) await tick() }

async function run(
  scripts: Script[],
  opts: { resume?: string | null; over?: Record<string, unknown>; onHandle?: (h: { abort: () => void }) => void } = {},
) {
  const fake = makeSdk(scripts)
  const events: UiEvent[] = []
  let terminal = false
  const handle = startClaudeChat({
    projectDir, writeRoot, apiKey: 'k', writeMode: 'auto', aiEngineKey: null,
    prompt: 'ページを作って', images: [], snapshotId: '2026-11-18T00-00-00-000Z', resumeSessionId: opts.resume ?? null, model: '',
    onEvent: e => { events.push(e); if (e.kind === 'result' || e.kind === 'error') terminal = true },
    onOpenPreview: async () => '', ragBudgetCheck: () => ({ allowed: true }), onDelegated: () => {}, onFileWritten: () => {},
    ...(opts.over ?? {}),
  } as any, fake.sdk)
  opts.onHandle?.(handle)
  for (let i = 0; i < 400 && !terminal; i++) await tick()
  await settle()
  return { events, queries: fake.queries, handle }
}

/** SDK が書く前に呼ぶフックを、options から取り出して呼ぶ。 */
async function preHook(options: Options, tool: 'Write' | 'Edit', file: string): Promise<unknown> {
  const group = options.hooks.PreToolUse[0]
  expect(group.matcher).toBe('Edit|Write')
  return group.hooks[0]({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: file } }, undefined, { signal: new AbortController().signal })
}

/** 書く前のフック → 書く、を SDK と同じ順で行う。 */
async function claudeWrites(options: Options, tool: 'Write' | 'Edit', file: string, content: string) {
  const r = await preHook(options, tool, file)
  expect(r).toEqual({ continue: true })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
}

const kinds = (events: UiEvent[]) => events.map(e => e.kind)
const checks = (events: UiEvent[]) => events.filter((e): e is Extract<UiEvent, { kind: 'writeCheck' }> => e.kind === 'writeCheck')
const file = (rel: string) => path.join(writeRoot, rel)

describe('Claude の経路: 書いたファイルの点検', () => {
  it('★★★ Write で見本のキー入りのファイル → 成功の result の前に writeCheck が1つ。値はどこにも無い', async () => {
    const { events } = await run([async function* ({ options }) {
      yield initMsg('s1')
      await claudeWrites(options, 'Write', file('app.js'), `${BAD_LINE}\n`)
      yield okResult()
    }])
    expect(kinds(events)).toEqual(['session', 'writeCheck', 'result'])
    const [c] = checks(events)
    expect(c.text.startsWith('⚠️')).toBe(true)
    expect(c.text).toContain('public/app.js')
    expect(c.marks).toEqual([{ file: 'public/app.js', kind: 'known-key', line: 1 }])
    expect(c.projectDir).toBe(projectDir)
    expect(JSON.stringify(events)).not.toContain(GH_BODY)
  })

  it('★★ Edit でも同じ（書く前に無かった行だけ）。前からあった行は出ない', async () => {
    fs.writeFileSync(file('a.js'), `${BAD_LINE}\nconst a = 1\n`)
    fs.writeFileSync(file('b.js'), 'const b = 1\n')
    const { events } = await run([async function* ({ options }) {
      yield initMsg('s1')
      await claudeWrites(options, 'Edit', file('a.js'), `${BAD_LINE}\nconst a = 2\n`) // 前からある行
      await claudeWrites(options, 'Edit', file('b.js'), `const b = 1\n${BAD_LINE}\n`) // 新しく増えた行
      yield okResult()
    }])
    const [c] = checks(events)
    expect(checks(events)).toHaveLength(1)
    expect(c.marks).toEqual([{ file: 'public/b.js', kind: 'known-key', line: 2 }])
    expect(JSON.stringify(events)).not.toContain(GH_BODY)
  })

  it('ターンの中で書き直して直った分は出ない／問題が無ければ出ない', async () => {
    const { events } = await run([async function* ({ options }) {
      yield initMsg('s1')
      await claudeWrites(options, 'Write', file('app.js'), `${BAD_LINE}\n`)
      await claudeWrites(options, 'Write', file('app.js'), 'const token = process.env.TOKEN\n')
      await claudeWrites(options, 'Write', file('ok.js'), 'const a = 1\n')
      yield okResult()
    }])
    expect(kinds(events)).toEqual(['session', 'result'])
  })

  it('ターンの中で result が2回来ても、writeCheck は1回だけ', async () => {
    const { events } = await run([async function* ({ options }) {
      yield initMsg('s1')
      await claudeWrites(options, 'Write', file('app.js'), `${BAD_LINE}\n`)
      yield okResult()
      yield okResult()
    }])
    expect(checks(events)).toHaveLength(1)
  })

  it('★★★ 失敗の result・error で終わる回は出ない', async () => {
    const { events } = await run([async function* ({ options }) {
      yield initMsg('s1')
      await claudeWrites(options, 'Write', file('app.js'), `${BAD_LINE}\n`)
      yield errResult('Credit balance is too low')
    }])
    expect(checks(events)).toEqual([])
    expect(kinds(events)).toEqual(['session', 'result', 'error'])
  })

  it('★★★ 途中で失敗があったのに result が成功の形で来ても、失敗の回として出さない', async () => {
    const { events } = await run([async function* ({ options }) {
      yield initMsg('s1')
      await claudeWrites(options, 'Write', file('app.js'), `${BAD_LINE}\n`)
      yield { type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'Invalid API key' }] } }
      yield okResult()
    }])
    expect(checks(events)).toEqual([])
  })

  it('★★★ ⏹（中断）の回は出ない', async () => {
    let abort!: () => void
    const { events } = await run([async function* ({ options }) {
      yield initMsg('s1')
      await claudeWrites(options, 'Write', file('app.js'), `${BAD_LINE}\n`)
      abort()
      yield okResult()
    }], { onHandle: h => { abort = h.abort } })
    expect(checks(events)).toEqual([])
  })

  it('プロジェクトの外のパスは控えない', async () => {
    const outside = path.join(outsideDir, 'leak.js')
    const { events } = await run([async function* ({ options }) {
      yield initMsg('s1')
      await claudeWrites(options, 'Write', outside, `${BAD_LINE}\n`)
      yield okResult()
    }])
    expect(checks(events)).toEqual([])
  })

  it('控えが失敗してもフックは continue を返す（書き込みを止めない）', async () => {
    const { events } = await run([async function* ({ options }) {
      yield initMsg('s1')
      // 読めない・存在しない相手でも投げずに返る
      expect(await preHook(options, 'Write', file('no/such/dir/new.js'))).toEqual({ continue: true })
      expect(await preHook(options, 'Edit', writeRoot)).toEqual({ continue: true }) // フォルダは読めない
      yield okResult()
    }])
    expect(checks(events)).toEqual([])
  })
})

describe('Claude の経路: 控えそのものの失敗', () => {
  it('touch が投げてもフックは continue を返し、writeCheck は出ない', async () => {
    ai.touchThrows = true
    const { events } = await run([async function* ({ options }) {
      yield initMsg('s1')
      expect(await preHook(options, 'Write', file('app.js'))).toEqual({ continue: true })
      fs.writeFileSync(file('app.js'), `${BAD_LINE}\n`)
      yield okResult()
    }])
    expect(checks(events)).toEqual([])
    expect(kinds(events)).toContain('result')
  })
})

describe('Claude の経路: resume つきの回', () => {
  it('★★★ 出来事の順（会話の中身 → writeCheck → result）が保たれる', async () => {
    const { events } = await run([async function* ({ options }) {
      yield initMsg(OLD_SESSION)
      yield textMsg('書きます')
      await claudeWrites(options, 'Write', file('app.js'), `${BAD_LINE}\n`)
      yield okResult()
    }], { resume: OLD_SESSION })
    expect(kinds(events)).toEqual(['session', 'text', 'writeCheck', 'result'])
  })

  it('会話の中身より先に書いて終わる回でも、writeCheck → result の順で届く', async () => {
    const { events } = await run([async function* ({ options }) {
      await claudeWrites(options, 'Write', file('app.js'), `${BAD_LINE}\n`)
      yield okResult()
    }], { resume: OLD_SESSION })
    expect(kinds(events)).toEqual(['writeCheck', 'result'])
  })

  it('貯めた失敗の扱いは変わらない: 失敗の回は writeCheck なしで result → error', async () => {
    const { events } = await run([async function* ({ options }) {
      yield initMsg(OLD_SESSION)
      await claudeWrites(options, 'Write', file('app.js'), `${BAD_LINE}\n`)
      yield errResult('Credit balance is too low')
    }], { resume: OLD_SESSION })
    expect(kinds(events)).toEqual(['session', 'result', 'error'])
  })

  it('★★ 会話が見つからずやり直した回: 1回目の控えがやり直しの終わりに点検される（控えは1つを使い回す）', async () => {
    const { events, queries } = await run([
      async function* ({ options }) {
        await claudeWrites(options, 'Write', file('app.js'), `${BAD_LINE}\n`)
        yield errResult(notFoundText)
      },
      async function* () {
        yield initMsg('new-1')
        yield okResult()
      },
    ], { resume: OLD_SESSION })
    expect(queries).toHaveLength(2)
    expect(kinds(events)).toEqual(['session', 'writeCheck', 'result'])
    expect(JSON.stringify(events)).not.toContain(GH_BODY)
  })
})

describe('任せるツールの書き込み: noteWrite', () => {
  const ctx = (noteWrite: (p: string, b: string | null) => void, over: Record<string, unknown> = {}) => ({
    projectDir, writeRoot, snapshotId: 's', snapshotLabel: 'l', onFileWritten: () => {}, writeMode: 'auto' as const,
    turnId: 't', isStopped: () => false, noteWrite, ...over,
  })

  it('★★★ 既存のファイルは旧内容・新しいファイルは null で、1ファイルにつき1回呼ばれる（書く前に）', async () => {
    fs.writeFileSync(file('old.js'), 'OLD')
    const calls: { p: string; b: string | null; onDisk: string | null }[] = []
    await writeDelegatedFiles([
      { path: 'old.js', content: 'NEW' },
      { path: 'sub/new.js', content: 'NEW2' },
    ], ctx((p, b) => calls.push({ p, b, onDisk: fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null })))
    expect(calls).toEqual([
      { p: file('old.js'), b: 'OLD', onDisk: 'OLD' }, // 呼んだ時点ではまだ書いていない
      { p: file('sub/new.js'), b: null, onDisk: null },
    ])
    expect(fs.readFileSync(file('old.js'), 'utf8')).toBe('NEW')
  })

  it('断られたファイルでは呼ばれない（守るパス）', async () => {
    const calls: string[] = []
    const r = await writeDelegatedFiles([{ path: '.git/hooks/pre-commit', content: 'x' }], ctx(p => calls.push(p)))
    expect(r.denied?.path).toBe('.git/hooks/pre-commit')
    expect(calls).toEqual([])
  })

  it('noteWrite が投げても書かれる', async () => {
    const r = await writeDelegatedFiles([{ path: 'a.js', content: 'A' }], ctx(() => { throw new Error('控えの失敗') }))
    expect(r.written).toEqual([{ path: 'a.js', bytes: 1 }])
    expect(fs.readFileSync(file('a.js'), 'utf8')).toBe('A')
  })

  it('★★★ agent.ts が buildIdeToolsServer へ渡す noteWrite は、集め役へ繋がっている（任せたファイルが終わりの点検に出る）', async () => {
    ai.content = JSON.stringify({ files: [{ path: 'gen.js', content: `${BAD_LINE}\n` }], notes: '' })
    const { events } = await run([async function* ({ options }) {
      yield initMsg('s1')
      const tools = options.mcpServers[IDE_MCP_SERVER_NAME].tools as { name: string; handler: (a: any) => Promise<unknown> }[]
      const t = tools.find(x => x.name === 'delegate_implementation')!
      await t.handler({ task: 'ページを作る' })
      yield okResult()
    }], { over: { aiEngineKey: 'test-key', offeredIdeTools: IDE_TOOL_BARE_NAMES } })
    expect(kinds(events)).toEqual(['session', 'writeCheck', 'result'])
    expect(checks(events)[0].marks).toEqual([{ file: 'public/gen.js', kind: 'known-key', line: 1 }])
    expect(JSON.stringify(events)).not.toContain(GH_BODY)
  })
})

describe('型と運び口: writeCheck', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
  const LINE = "| { kind: 'writeCheck'; text: string; marks:"

  it('events.ts と global.d.ts の writeCheck の行が同じ形（印の型も同じもの）', () => {
    const pick = (s: string) => {
      const l = s.split('\n').find(x => x.includes("kind: 'writeCheck'"))!
      expect(l).toBeTruthy()
      return l.trim()
    }
    const a = pick(read('src/main/claude/events.ts'))
    const b = pick(read('src/renderer/global.d.ts'))
    expect(a.startsWith(LINE)).toBe(true)
    expect(b.startsWith(LINE)).toBe(true)
    expect(a).toContain('marks: WriteFixMark[]; projectDir: string }')
    expect(b).toContain("marks: import('../shared/securityFindings').WriteFixMark[]; projectDir: string; turn: string }")
  })

  it('ipc/claude.ts の onEvent は種類を絞らずに claude:stream へ送る', () => {
    const s = read('src/main/ipc/claude.ts')
    expect(s).toContain("try { event.sender.send('claude:stream', { ...uiEvent, turn } satisfies TurnTaggedUiEvent) }")
    expect(s).toContain('onEvent: uiEvent => {\n            sendTurn(uiEvent)')
    expect(s).not.toContain("uiEvent.kind === 'writeCheck'")
  })

  it('★★ 受け手: Claude のストリームの case writeCheck が、toolNote の吹き出しに ev.text と ev.marks を出す', () => {
    const s = read('src/renderer/hooks/useAiChat.ts')
    expect(s).toContain("            case 'writeCheck':")
    expect(s).toContain("appendBubble({ role: 'assistant', toolNote: true, content: ev.text, writeFix: ev.marks })")
    // 直す前の形（setMessages などで直接画面に触る）は禁じる
    expect(s).not.toMatch(/case 'writeCheck':[\s\S]{0,200}setMessages/)
  })
})
