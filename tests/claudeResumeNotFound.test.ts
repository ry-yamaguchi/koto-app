// tests/claudeResumeNotFound.test.ts — resume した会話が SDK に無いとき、resume 無しで1回やり直す。
//
// 実機（2026-10-24・rc.1）: 1回目の依頼が請求の誤りで失敗した。そのとき SDK が出した session を renderer が覚え、
// 以後の依頼は毎回 resume でその番号を渡す。会話は保存されていないので、いまの SDK（0.3.220）はこう返して終わる
// （例外ではなく、ストリームの中の誤りの結果。終了時にさらに例外 "Claude Code returned an error result: …"）:
//   error "No conversation found with session ID: …" → result(isError) → error "Claude Code returned an error result: …"
// 従来の自己修復は「何も出来事を出す前の例外」だけが対象で、これは emittedAny=true になり、やり直しが効かなかった。
//
// ここでは偽の SDK（claudeQueryOptionsWiring.test.ts と同じ sdkOverride の口）に**本物と同じ形のメッセージ**を流し、
// onEvent に何が届くか・query() が何回・どんな resume で呼ばれたかを検査する。
// resume のとき貯めるのは error と result だけ。session は終わりを待たずにすぐ届く
// （貯めると、「会話をクリア」や別のプロジェクトへの切り替えのあとに、遅れて届いた古い番号が書き戻される）。
//   (a) resume あり→「会話が見つからない」で終わる → error/result は届かず、session（あれば）とやり直し（resume 無し）の出来事が届く
//   (c) resume あり→請求の誤りだけ → やり直さず（query 1回）その誤りが届く
//   (d) resume あり→text が先に来てから誤り → やり直さず全部届く
//   (e) 待ち方: resume なしは何も貯めない／resume ありは session がすぐ届き、error/result は終わりまで貯まる

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../src/main/ipc/sakura', () => ({
  sakuraClient: () => ({ chat: { completions: { create: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '' } }], usage: { prompt_tokens: 0, completion_tokens: 0 } }) } } }),
  isContextLimitError: () => false,
  safeMaxTokens: () => null,
}))
vi.mock('../src/main/ipc/web', () => ({ fetchUrlPage: async () => { throw new Error('このテストでは使わない') } }))

import { startClaudeChat, type ClaudeSdkModule } from '../src/main/claude/agent'
import type { UiEvent } from '../src/main/claude/events'

let projectDir = ''
let writeRoot = ''
beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-claude-resume-'))
  writeRoot = path.join(projectDir, 'public')
  fs.mkdirSync(writeRoot, { recursive: true })
})
afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true })
})

// ── SDK のメッセージ（実物と同じ形）──────────────────────────────────────────
const OLD_SESSION = 'f3d3a705-0000-4000-8000-000000000001'
const notFoundText = (id = OLD_SESSION) => `No conversation found with session ID: ${id}`
const initMsg = (id: string) => ({ type: 'system', subtype: 'init', session_id: id })
const textMsg = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
const toolMsg = () => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/p/a.txt' } }] } })
const okResult = () => ({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, duration_ms: 5 })
const errResult = (message: string) => ({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [message], total_cost_usd: 0, duration_ms: 0 })
const thrown = (message: string) => new Error(`Claude Code returned an error result: ${message}`)

type Script = (arg: { options: Record<string, any> }) => AsyncGenerator<unknown>

/** 呼ばれた順に script を1本ずつ使う偽の SDK。 */
function makeSdk(scripts: Script[]) {
  const queries: { options: Record<string, any> }[] = []
  const sdk = {
    query: (arg: { options: Record<string, any> }) => {
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
async function waitUntil(cond: () => boolean, label: string) {
  for (let i = 0; i < 400; i++) { if (cond()) return; await tick() }
  throw new Error(`時間切れ: ${label}`)
}

/** 1ターン走らせる。expectCount 件の出来事が届いたら、さらに数 tick 待って余計な出来事が来ないことも確かめられるようにする。 */
async function run(scripts: Script[], opts: { resume: string | null; expectCount: number }) {
  const fake = makeSdk(scripts)
  const events: UiEvent[] = []
  startClaudeChat({
    projectDir, writeRoot, apiKey: 'k', writeMode: 'auto', aiEngineKey: null,
    prompt: 'ページを作って', images: [], snapshotId: '2026-10-24T00-00-00-000Z', resumeSessionId: opts.resume, model: '',
    onEvent: e => { events.push(e) },
    onOpenPreview: () => {}, ragBudgetCheck: () => ({ allowed: true }), onDelegated: () => {}, onFileWritten: () => {},
  }, fake.sdk)
  await waitUntil(() => events.length >= opts.expectCount, `出来事が ${opts.expectCount} 件届く（いま ${events.length} 件: ${JSON.stringify(events)}）`)
  await settle()
  return { events, queries: fake.queries }
}

const errorMessages = (events: UiEvent[]) => events.filter((e): e is Extract<UiEvent, { kind: 'error' }> => e.kind === 'error').map(e => e.message)

// 2回目（resume 無し）の成功: session・text・result
const secondRunOk: Script = async function* () {
  yield initMsg('new-session-1')
  yield textMsg('できました')
  yield okResult()
}

// ══ (a) 会話の続きが見つからない → 貯めた分を捨てて、resume 無しで1回やり直す ═══════════════════

describe('resume あり→「No conversation found」で終わる: error/result は届かず、session（あれば）とやり直しの出来事が届く', () => {
  const variants: { name: string; first: Script; /** 1回目（失敗した回）から先に届く出来事（session だけ） */ firstDelivered: UiEvent[] }[] = [
    {
      name: '実測どおり（誤りの結果を流したあと、終了時に例外）',
      first: async function* () { yield errResult(notFoundText()); throw thrown(notFoundText()) },
      firstDelivered: [],
    },
    {
      name: '例外なしで終わる',
      first: async function* () { yield errResult(notFoundText()) },
      firstDelivered: [],
    },
    {
      name: '大文字小文字・番号が違っても同じ扱い',
      first: async function* () { yield errResult('NO CONVERSATION FOUND WITH SESSION ID: zzz-123'); throw thrown('NO CONVERSATION FOUND WITH SESSION ID: zzz-123') },
      firstDelivered: [],
    },
    {
      name: '先に session が来ていたら、その session は届く（error/result は届かない）',
      first: async function* () { yield initMsg(OLD_SESSION); yield errResult(notFoundText()); throw thrown(notFoundText()) },
      firstDelivered: [{ kind: 'session', sessionId: OLD_SESSION }],
    },
    {
      name: '誤りの結果が無く、例外の文だけが「No conversation found」',
      first: async function* () { throw new Error(notFoundText()) },
      firstDelivered: [],
    },
    {
      name: '先に session が来て、誤りの結果も無く、例外の文だけが「No conversation found」',
      first: async function* () { yield initMsg(OLD_SESSION); throw new Error(notFoundText()) },
      firstDelivered: [{ kind: 'session', sessionId: OLD_SESSION }],
    },
  ]
  for (const v of variants) {
    it(`★★★ ${v.name}`, async () => {
      const { events, queries } = await run([v.first, secondRunOk], { resume: OLD_SESSION, expectCount: 3 + v.firstDelivered.length })
      // 「No conversation found」は利用者に届かない
      expect(errorMessages(events).filter(m => /no conversation found/i.test(m))).toEqual([])
      // error と result は1回目のものは1件も届かない
      expect(events.filter(e => e.kind === 'error')).toEqual([])
      expect(events.filter(e => e.kind === 'result')).toEqual([{ kind: 'result', costUsd: 0.01, durationMs: 5, isError: false }])
      // 届いたのは、1回目の session（あれば）→ 2回目の出来事（session・text・result）
      expect(events).toEqual([
        ...v.firstDelivered,
        { kind: 'session', sessionId: 'new-session-1' },
        { kind: 'text', text: 'できました' },
        { kind: 'result', costUsd: 0.01, durationMs: 5, isError: false },
      ])
      // query は2回。1回目は resume あり、2回目は resume なし
      expect(queries).toHaveLength(2)
      expect(queries[0].options.resume).toBe(OLD_SESSION)
      expect(queries[1].options.resume).toBeUndefined()
    })
  }

  it('やり直しも失敗したときは、2回目の誤りだけが届く（1回目の誤りは届かない）', async () => {
    const second: Script = async function* () { yield errResult('Credit balance is too low'); throw thrown('Credit balance is too low') }
    const first: Script = async function* () { yield errResult(notFoundText()); throw thrown(notFoundText()) }
    const { events, queries } = await run([first, second], { resume: OLD_SESSION, expectCount: 3 })
    expect(queries).toHaveLength(2) // やり直しは1回だけ（3回目は無い）
    expect(errorMessages(events).some(m => /no conversation found/i.test(m))).toBe(false)
    expect(errorMessages(events)).toEqual(['Credit balance is too low', 'Claude Code returned an error result: Credit balance is too low'])
  })

  it('1回目が session を流してから「No conversation found」・やり直しが session より前に失敗 → 届くのは古い session と2回目の誤りだけ（番号は次の依頼で自己修復される）', async () => {
    const first: Script = async function* () { yield initMsg(OLD_SESSION); yield errResult(notFoundText()); throw thrown(notFoundText()) }
    const second: Script = async function* () { throw new Error('起動に失敗しました') }
    const { events, queries } = await run([first, second], { resume: OLD_SESSION, expectCount: 2 })
    expect(queries).toHaveLength(2)
    expect(queries[1].options.resume).toBeUndefined()
    expect(events).toEqual([
      { kind: 'session', sessionId: OLD_SESSION },
      { kind: 'error', message: '起動に失敗しました' },
    ])
  })

  it('従来の自己修復はそのまま: 何も出さずに例外で失敗 → resume 無しでやり直す（文言は問わない）', async () => {
    const first: Script = async function* () { throw new Error('session not found') }
    const { events, queries } = await run([first, secondRunOk], { resume: OLD_SESSION, expectCount: 3 })
    expect(events.map(e => e.kind)).toEqual(['session', 'text', 'result'])
    expect(queries).toHaveLength(2)
    expect(queries[1].options.resume).toBeUndefined()
  })
})

// ══ (c) 別の誤り（請求・429 など）→ 会話の続きを勝手に捨てない ═════════════════════════════

describe('resume あり→中身なしで別の誤りで終わる: やり直さず（query 1回）その誤りがそのまま届く', () => {
  it('★★★ 請求の誤り（結果の errors → 終了時に例外）', async () => {
    const first: Script = async function* () { yield errResult('Credit balance is too low'); throw thrown('Credit balance is too low') }
    const { events, queries } = await run([first], { resume: OLD_SESSION, expectCount: 3 })
    expect(queries).toHaveLength(1)
    expect(queries[0].options.resume).toBe(OLD_SESSION)
    expect(events).toEqual([
      { kind: 'error', message: 'Credit balance is too low' },
      { kind: 'result', costUsd: 0, durationMs: 0, isError: true },
      { kind: 'error', message: 'Claude Code returned an error result: Credit balance is too low' },
    ])
  })

  it('請求の誤り（例外なしで終わる）', async () => {
    const first: Script = async function* () { yield errResult('Credit balance is too low') }
    const { events, queries } = await run([first], { resume: OLD_SESSION, expectCount: 2 })
    expect(queries).toHaveLength(1)
    expect(events).toEqual([
      { kind: 'error', message: 'Credit balance is too low' },
      { kind: 'result', costUsd: 0, durationMs: 0, isError: true },
    ])
  })

  it('先に session が来ていても、誤りが別なら session はすぐ・error/result は順どおりそのまま届く（session → error → result → error）', async () => {
    const first: Script = async function* () { yield initMsg(OLD_SESSION); yield errResult('rate limit'); throw thrown('rate limit') }
    const { events, queries } = await run([first], { resume: OLD_SESSION, expectCount: 4 })
    expect(queries).toHaveLength(1)
    expect(events.map(e => e.kind)).toEqual(['session', 'error', 'result', 'error'])
    expect(events[0]).toEqual({ kind: 'session', sessionId: OLD_SESSION })
  })

  it('assistant の billing_error（本文つき）も、やり直さずそのまま届く', async () => {
    const first: Script = async function* () {
      yield { type: 'assistant', error: 'billing_error', message: { content: [{ type: 'text', text: 'Credit balance is too low' }] } }
      yield okResult()
    }
    const { events, queries } = await run([first], { resume: OLD_SESSION, expectCount: 3 })
    expect(queries).toHaveLength(1)
    expect(events.map(e => e.kind)).toEqual(['error', 'text', 'result'])
  })
})

// ══ (d) 中身が先に来た → もう会話は始まっている。やり直さない ═══════════════════════════════

describe('resume あり→text が先に来てから誤りで終わる: やり直さず全部届く', () => {
  it('★★★ 誤りの文が「No conversation found」でも、中身（text）が先に来ていればやり直さない', async () => {
    const first: Script = async function* () {
      yield initMsg(OLD_SESSION)
      yield textMsg('途中まで書きました')
      throw thrown(notFoundText())
    }
    const { events, queries } = await run([first], { resume: OLD_SESSION, expectCount: 3 })
    expect(queries).toHaveLength(1)
    expect(events).toEqual([
      { kind: 'session', sessionId: OLD_SESSION },
      { kind: 'text', text: '途中まで書きました' },
      { kind: 'error', message: `Claude Code returned an error result: ${notFoundText()}` },
    ])
  })

  it('tool が先に来てから請求の誤り → 全部届く・query 1回', async () => {
    const first: Script = async function* () {
      yield initMsg(OLD_SESSION)
      yield toolMsg()
      yield errResult('Credit balance is too low')
      throw thrown('Credit balance is too low')
    }
    const { events, queries } = await run([first], { resume: OLD_SESSION, expectCount: 5 })
    expect(queries).toHaveLength(1)
    expect(events.map(e => e.kind)).toEqual(['session', 'tool', 'error', 'result', 'error'])
  })
})

// ══ (e) 貯める・貯めないの境目 ═════════════════════════════════════════════════════════

describe('貯めるのは resume を渡したときだけ（待ち方の振る舞い）', () => {
  it('★★ resume なし: session も text も、中身・終わりを待たずにすぐ届く', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    let release0!: () => void
    const gate0 = new Promise<void>(r => { release0 = r })
    let reachedEnd = false
    const only: Script = async function* () {
      yield initMsg('s1')
      await gate0 // session だけが先に来て、中身はまだ。resume なしなら session は貯めずにすぐ届く
      yield textMsg('いま届くはず')
      await gate
      reachedEnd = true
      yield okResult()
    }
    const fake = makeSdk([only])
    const events: UiEvent[] = []
    startClaudeChat({
      projectDir, writeRoot, apiKey: 'k', writeMode: 'auto', aiEngineKey: null,
      prompt: 'p', images: [], snapshotId: 's', resumeSessionId: null, model: '',
      onEvent: e => { events.push(e) },
      onOpenPreview: () => {}, ragBudgetCheck: () => ({ allowed: true }), onDelegated: () => {}, onFileWritten: () => {},
    }, fake.sdk)
    await waitUntil(() => events.length >= 1, 'session が、中身を待たずに届く')
    expect(events.map(e => e.kind)).toEqual(['session']) // 貯めていれば、ここは空のまま
    release0()
    await waitUntil(() => events.length >= 2, 'text が、終わりを待たずに届く')
    expect(reachedEnd).toBe(false)
    expect(events.map(e => e.kind)).toEqual(['session', 'text'])
    release()
    await waitUntil(() => events.length >= 3, 'result が届く')
    expect(fake.queries).toHaveLength(1)
    expect(fake.queries[0].options.resume).toBeUndefined()
  })

  it('★★★ resume あり: session は中身も終わりも待たずにすぐ届き、error/result は終わりまで貯まる', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const only: Script = async function* () {
      yield initMsg(OLD_SESSION)
      yield errResult('Credit balance is too low') // 中身（text・tool）が来る前の誤りの結果は、終わりまで貯める
      await gate
      throw thrown('Credit balance is too low')
    }
    const fake = makeSdk([only])
    const events: UiEvent[] = []
    startClaudeChat({
      projectDir, writeRoot, apiKey: 'k', writeMode: 'auto', aiEngineKey: null,
      prompt: 'p', images: [], snapshotId: 's', resumeSessionId: OLD_SESSION, model: '',
      onEvent: e => { events.push(e) },
      onOpenPreview: () => {}, ragBudgetCheck: () => ({ allowed: true }), onDelegated: () => {}, onFileWritten: () => {},
    }, fake.sdk)
    await waitUntil(() => events.length >= 1, 'session が、中身を待たずに届く')
    await settle()
    expect(events).toEqual([{ kind: 'session', sessionId: OLD_SESSION }]) // error/result はまだ貯まっている
    release()
    await waitUntil(() => events.length >= 4, '貯めた error・result と終了時の error が順に届く')
    expect(events.map(e => e.kind)).toEqual(['session', 'error', 'result', 'error'])
    expect(fake.queries).toHaveLength(1) // 別の誤りなのでやり直さない
  })

  it('★★★ resume あり・「No conversation found」: session は終わりを待たずに届き、error/result は届かず、やり直しが続く', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const first: Script = async function* () {
      yield initMsg(OLD_SESSION)
      await gate
      yield errResult(notFoundText())
      throw thrown(notFoundText())
    }
    const fake = makeSdk([first, secondRunOk])
    const events: UiEvent[] = []
    startClaudeChat({
      projectDir, writeRoot, apiKey: 'k', writeMode: 'auto', aiEngineKey: null,
      prompt: 'p', images: [], snapshotId: 's', resumeSessionId: OLD_SESSION, model: '',
      onEvent: e => { events.push(e) },
      onOpenPreview: () => {}, ragBudgetCheck: () => ({ allowed: true }), onDelegated: () => {}, onFileWritten: () => {},
    }, fake.sdk)
    await waitUntil(() => events.length >= 1, 'session が、終わりを待たずに届く')
    await settle()
    expect(events).toEqual([{ kind: 'session', sessionId: OLD_SESSION }])
    expect(fake.queries).toHaveLength(1) // まだ1回目の途中
    release()
    await waitUntil(() => events.length >= 4, 'やり直しの session・text・result が届く')
    await settle()
    expect(events).toEqual([
      { kind: 'session', sessionId: OLD_SESSION },
      { kind: 'session', sessionId: 'new-session-1' }, // 新しい番号が、失敗した回の番号を上書きする
      { kind: 'text', text: 'できました' },
      { kind: 'result', costUsd: 0.01, durationMs: 5, isError: false },
    ])
    expect(fake.queries).toHaveLength(2)
    expect(fake.queries[1].options.resume).toBeUndefined()
  })

  it('resume あり: 中身（text）が来た時点で、貯めた error が先に届き、そのあとは貯めずに流れる', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const only: Script = async function* () {
      yield initMsg(OLD_SESSION)
      // 本文つきの billing_error は error → text の順に出る（events.ts）。text が来た時点で error が流れる
      yield { type: 'assistant', error: 'billing_error', message: { content: [{ type: 'text', text: '本文' }] } }
      await gate
      yield okResult()
    }
    const fake = makeSdk([only])
    const events: UiEvent[] = []
    startClaudeChat({
      projectDir, writeRoot, apiKey: 'k', writeMode: 'auto', aiEngineKey: null,
      prompt: 'p', images: [], snapshotId: 's', resumeSessionId: OLD_SESSION, model: '',
      onEvent: e => { events.push(e) },
      onOpenPreview: () => {}, ragBudgetCheck: () => ({ allowed: true }), onDelegated: () => {}, onFileWritten: () => {},
    }, fake.sdk)
    await waitUntil(() => events.length >= 3, 'session・error・text が終わりを待たずに届く')
    expect(events.map(e => e.kind)).toEqual(['session', 'error', 'text'])
    release()
    await waitUntil(() => events.length >= 4, 'result が届く')
    expect(events.map(e => e.kind)).toEqual(['session', 'error', 'text', 'result'])
  })

  it('resume あり・正常な会話: 中身が来たあとは、そのまま流れる（最初の text は終わりを待たずに届く）', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const only: Script = async function* () {
      yield initMsg(OLD_SESSION)
      yield textMsg('続きです')
      await gate
      yield okResult()
    }
    const fake = makeSdk([only])
    const events: UiEvent[] = []
    startClaudeChat({
      projectDir, writeRoot, apiKey: 'k', writeMode: 'auto', aiEngineKey: null,
      prompt: 'p', images: [], snapshotId: 's', resumeSessionId: OLD_SESSION, model: '',
      onEvent: e => { events.push(e) },
      onOpenPreview: () => {}, ragBudgetCheck: () => ({ allowed: true }), onDelegated: () => {}, onFileWritten: () => {},
    }, fake.sdk)
    await waitUntil(() => events.length >= 2, 'session と text が届く')
    expect(events.map(e => e.kind)).toEqual(['session', 'text'])
    release()
    await waitUntil(() => events.length >= 3, 'result が届く')
    expect(fake.queries[0].options.resume).toBe(OLD_SESSION)
  })

  it('resume あり・何も出さずに正常終了（終端イベントなし）: 従来どおり「予期せず終了」の誤りを1回だけ出す', async () => {
    const first: Script = async function* () { /* 何も流さない */ }
    const { events, queries } = await run([first], { resume: OLD_SESSION, expectCount: 1 })
    expect(queries).toHaveLength(1)
    expect(events).toEqual([{ kind: 'error', message: '応答が予期せず終了しました。もう一度お試しください。' }])
  })
})
