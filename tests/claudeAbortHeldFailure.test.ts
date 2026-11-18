// ⏹ で止めた回は、手元に持っていた失敗の知らせを画面へ送らない。
// 失敗の回は「失敗の知らせ（error）→ 結果（result）」の順で届くが、main は error を result まで手元に持つ。
// その間に ⏹ が押されたとき、持っていた error を流すと、止めたあとに失敗の吹き出しが出る。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { startClaudeChat, type ClaudeSdkModule } from '../src/main/claude/agent'
import type { UiEvent } from '../src/main/claude/events'

let projectDir = ''
beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-abort-held-'))
  fs.mkdirSync(path.join(projectDir, 'public'), { recursive: true })
})
afterEach(() => { fs.rmSync(projectDir, { recursive: true, force: true }) })

const init = { type: 'system', subtype: 'init', session_id: 'sess-1' }
const failedAssistant = { type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'Invalid API key' }] } }
const result = (isError: boolean) => ({ type: 'result', subtype: 'success', is_error: isError, total_cost_usd: 0.01, duration_ms: 5 })

function makeSdk(script: () => AsyncGenerator<unknown>) {
  return {
    query: () => script(),
    tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
    createSdkMcpServer: (opts: any) => ({ type: 'sdk', name: opts.name, instance: {}, tools: opts.tools }),
  } as unknown as ClaudeSdkModule
}

async function run(script: (abort: () => void) => AsyncGenerator<unknown>): Promise<UiEvent[]> {
  const delivered: UiEvent[] = []
  let handle: { abort: () => void } | null = null
  let done!: () => void
  const finished = new Promise<void>(r => { done = r })
  handle = startClaudeChat({
    projectDir, writeRoot: path.join(projectDir, 'public'), apiKey: 'k', writeMode: 'auto', aiEngineKey: null,
    prompt: 'p', images: [], snapshotId: 's', resumeSessionId: null, model: '',
    onEvent: e => { delivered.push(e) },
    onOpenPreview: () => {}, ragBudgetCheck: () => ({ allowed: true }), onDelegated: () => {}, onFileWritten: () => {},
  }, makeSdk(async function* () {
    try { yield* script(() => handle!.abort()) } finally { done() }
  }))
  await finished
  await new Promise(r => setTimeout(r, 20))
  return delivered
}

describe('⏹ で止めた回の、手元の失敗の知らせ', () => {
  it('★★★ error のあと result の前に ⏹: 失敗の知らせは届かない', async () => {
    const delivered = await run(async function* (abort) {
      yield init
      yield failedAssistant
      abort()
      yield result(true)
    })
    expect(delivered.filter(e => e.kind === 'error')).toEqual([])
  })

  it('⏹ が無ければ、同じ流れで失敗の知らせが1つ届く（対照）', async () => {
    const delivered = await run(async function* () {
      yield init
      yield failedAssistant
      yield result(true)
    })
    expect(delivered.filter(e => e.kind === 'error')).toHaveLength(1)
  })

  it('途中の失敗のあと、結果が成功で終わっても、失敗の回として出す（実際にこの形が来るかは未確認・費用は1回）', async () => {
    const delivered = await run(async function* () {
      yield init
      yield failedAssistant
      yield result(false)
    })
    expect(delivered.filter(e => e.kind === 'result')).toEqual([{ kind: 'result', costUsd: 0.01, durationMs: 5, isError: true }])
    expect(delivered.filter(e => e.kind === 'error')).toHaveLength(1)
    expect(delivered.map(e => e.kind).filter(k => k === 'result' || k === 'error')).toEqual(['result', 'error'])
  })
})
