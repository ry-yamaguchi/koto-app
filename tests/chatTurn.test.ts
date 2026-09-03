import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  runEngineTurn, runCompact, REPEAT_LIMIT,
  type EngineTurnSpec, type EngineTurnPorts, type TurnMessage, type TurnHelpers, type CompactPlanLike,
} from '../src/shared/chatTurn'

// 本物の純粋関数（掟1: 推測で実装しない。node で動く前例は unexecutedTool.test.ts 等に多数ある）。
import {
  formatChatError, condenseReasoning, hasTextToolMarkup, stripToolMarkup, unexecutedToolWarning,
  claimsFileChange, unexecutedChangeWarning, stripRepeatedGuidance, isToolArgsComplete, isToolUnsupportedError,
  toolStatusLabel, WRITING_TOOLS, toolsFor,
} from '../src/renderer/aiTools'
import { isImageUnsupportedError } from '../src/renderer/visionSupport'
import { modelLabel, pickBestModel, estimateTokens } from '../src/renderer/usage'
import { extractUrls, wantsWebSearch } from '../src/renderer/webContext'
import { planSend, planCompact, compactPrompt, acceptSummary, compactSource } from '../src/renderer/historyCompact'
import { searchStatusContext } from '../src/renderer/aiContext'
import { applyToMessages } from '../src/shared/chatEvents'

// B'-3a: send() の AI Engine 部分を chatTurn.ts へ切り出した。ここでは
// 「偽の ports ＋ 本物の純粋関数」で runEngineTurn を node で駆動し、
// 出来事と副作用の並びを固定する（main へ移しても同じテストで保証できるようにするため）。
//
// ── ログに何を積むか ─────────────────────────────────────────────
// ports の呼び出しすべてを記録すると、shouldSendTools / isKnownToolCapable 等の
// 「判断のためだけに何度も呼ばれる純粋な問い合わせ」までが並びに混じり、
// ほんの少しの実装順序の違いで壊れる弱いテストになる。ここでは
// **観測できる出来事・副作用**（emit・chatStream・chatOnce・executeTool・approveToolCall・
// notifyActivity・setAbort・record 系・各種取得系）だけをログに積む。
// 判断そのもの（shouldSendTools 等）はシナリオの設定（config）側で固定し、
// その結果として「次に何が起きるか」をログで確認する。

const h: TurnHelpers = {
  formatChatError,
  condenseReasoning,
  hasTextToolMarkup,
  stripToolMarkup,
  unexecutedToolWarning,
  claimsFileChange,
  unexecutedChangeWarning,
  stripRepeatedGuidance,
  isToolArgsComplete,
  isToolUnsupportedError,
  isImageUnsupportedError,
  toolStatusLabel,
  modelLabel,
  pickBestModel,
  writingTools: WRITING_TOOLS,
  extractUrls,
  wantsWebSearch,
  toolsFor,
  planSend,
  planCompact,
  compactPrompt,
  acceptSummary,
  compactSource,
  searchStatusContext,
}

type Log = any[]

type StreamScript = {
  content: string
  toolCalls?: any[] | null
  aborted?: boolean
  reasoningText?: string | null
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
  /** 省略時は content をそのまま1回の delta として流す。 */
  contentDeltas?: string[]
  thinkingDeltas?: string[]
  /** true なら、この回の chatStream は reject する（Error(message)）。 */
  throwMessage?: string
}

interface PortsConfig {
  history?: TurnMessage[]
  systemPrompt?: string
  search?: any
  pagesBlock?: string
  searchBlock?: string
  ragBlock?: string
  hasBuildRagBlock?: boolean
  stream: StreamScript[]
  chatOnce?: { content?: string; usage?: { prompt_tokens?: number; completion_tokens?: number } | null }
  /** 指定すると chatOnce がこの内容で reject する（abort 例外・abort 以外の例外の両方を模す）。 */
  chatOnceThrow?: { message?: string; name?: string }
  usageAllowed?: boolean[] // usage.check() が呼ばれるたびに先頭から消費。尽きたら最後の値を使い続ける
  usageMessage?: string
  executeTool?: (name: string, argsJson: string, opts: any) => Promise<string> | string
  hasApproveToolCall?: boolean
  approveToolCall?: (name: string, args: string, scope: any) => Promise<string | null> | string | null
  sendable?: Record<string, boolean> // shouldSendTools（既定 true）
  knownCapable?: Record<string, boolean> // isKnownToolCapable（既定 false）
  visionDirect?: Record<string, boolean> // shouldTryDirect（既定 true）
  visionDefault?: string
  compactWarn?: boolean[] // compactWarnOnce() の返り値の列（既定 [true, false, false, ...]）
}

function makePorts(cfg: PortsConfig): { ports: EngineTurnPorts; log: Log; streamRequests: any[] } {
  const log: Log = []
  // chatStream へ渡った要求そのもの（messages を含む）。log は全列一致（toEqual）で使うので
  // かさばる messages はこちらへ分けて残す（17b が使う）。
  const streamRequests: any[] = []
  let streamIdx = 0
  let usageIdx = 0
  let compactWarnIdx = 0
  const usageAllowed = cfg.usageAllowed ?? [true]
  const compactWarn = cfg.compactWarn ?? [true, false, false, false, false]

  const ports: EngineTurnPorts = {
    emit: (ev) => { log.push({ tag: 'emit', ev }) },
    chatStream: async (req, onDelta, onAbortReady, onThinking) => {
      log.push({ tag: 'chatStream', model: req.model, hasTools: !!req.tools, maxTokens: req.maxTokens })
      streamRequests.push(req)
      const script = cfg.stream[streamIdx]
      streamIdx++
      if (!script) throw new Error('stream script exhausted')
      onAbortReady(() => {})
      for (const d of script.thinkingDeltas ?? []) onThinking(d)
      const deltas = script.contentDeltas ?? (script.content ? [script.content] : [])
      for (const d of deltas) onDelta(d)
      if (script.throwMessage) throw new Error(script.throwMessage)
      return {
        usage: script.usage,
        aborted: script.aborted,
        toolCalls: script.toolCalls,
        reasoningText: script.reasoningText,
      }
    },
    chatOnce: async (req) => {
      log.push({ tag: 'chatOnce', model: req.model })
      if (cfg.chatOnceThrow) {
        const e: any = new Error(cfg.chatOnceThrow.message ?? 'boom')
        if (cfg.chatOnceThrow.name) e.name = cfg.chatOnceThrow.name
        throw e
      }
      return cfg.chatOnce ?? { content: '', usage: null }
    },
    getHistory: () => { log.push({ tag: 'getHistory' }); return cfg.history ?? [] },
    buildSystemPrompt: () => { log.push({ tag: 'buildSystemPrompt' }); return cfg.systemPrompt ?? 'システム' },
    onUserMessage: (text, isFirst) => { log.push({ tag: 'onUserMessage', text, isFirst }) },
    approveToolCall: cfg.hasApproveToolCall
      ? async (name, args, scope) => {
          log.push({ tag: 'approveToolCall', name, args, scope })
          return cfg.approveToolCall ? await cfg.approveToolCall(name, args, scope) : null
        }
      : undefined,
    executeTool: async (name, argsJson, opts) => {
      log.push({ tag: 'executeTool', name, argsJson, opts })
      return cfg.executeTool ? await cfg.executeTool(name, argsJson, opts) : 'ok'
    },
    buildRagBlock: cfg.hasBuildRagBlock
      ? async (text) => { log.push({ tag: 'buildRagBlock', text }); return cfg.ragBlock ?? '' }
      : undefined,
    getSearchConfig: async () => { log.push({ tag: 'getSearchConfig' }); return cfg.search ?? null },
    fetchPagesBlock: async (urls) => { log.push({ tag: 'fetchPagesBlock', urls }); return cfg.pagesBlock ?? '' },
    autoSearchBlock: async (text, search) => { log.push({ tag: 'autoSearchBlock', text, search }); return cfg.searchBlock ?? '' },
    notifyActivity: () => { log.push({ tag: 'notifyActivity' }) },
    setAbort: (fn) => { log.push({ tag: 'setAbort', has: fn !== null }) },
    usage: {
      check: () => {
        log.push({ tag: 'usage.check' })
        const allowed = usageAllowed[Math.min(usageIdx, usageAllowed.length - 1)]
        usageIdx++
        return allowed ? { allowed: true } : { allowed: false, message: cfg.usageMessage ?? '上限に達しました' }
      },
      record: (model, promptTokens, completionTokens) => {
        log.push({ tag: 'usage.record', model, promptTokens, completionTokens })
      },
      estimate: (text) => estimateTokens(text),
    },
    toolSupport: {
      shouldSendTools: (model) => cfg.sendable?.[model] ?? true,
      isKnownToolCapable: (model) => cfg.knownCapable?.[model] ?? false,
      record: (model, supported) => { log.push({ tag: 'toolSupport.record', model, supported }) },
    },
    vision: {
      shouldTryDirect: (model) => cfg.visionDirect?.[model] ?? true,
      record: (model, supported) => { log.push({ tag: 'vision.record', model, supported }) },
      defaultModel: () => cfg.visionDefault ?? 'vision-model',
    },
    compactWarnOnce: () => {
      const v = compactWarn[Math.min(compactWarnIdx, compactWarn.length - 1)]
      compactWarnIdx++
      return v
    },
    h,
  }
  return { ports, log, streamRequests }
}

/**
 * ports の元々同期だったメンバーを Promise でくるむ（B'-3b のミューテーション試験用）。
 *
 * main 実装（IPC 往復）は非同期になるため、chatTurn.ts の該当メンバーは `T | Promise<T>` を
 * 受けて必ず await する形にした。ここでは偽 ports をこの形で包み、
 * 「同期実装でも非同期実装でも同じ結果になる（await が透過する）」ことを確かめる。
 * 呼び出しそのもの（ログを積む副作用）は中の同期関数がそのまま実行するので、
 * ログの並びは素の（同期）ports と変わらない。
 */
function wrapPortsAsync(ports: EngineTurnPorts): EngineTurnPorts {
  return {
    ...ports,
    getHistory: () => Promise.resolve(ports.getHistory()),
    buildSystemPrompt: () => Promise.resolve(ports.buildSystemPrompt()),
    onUserMessage: ports.onUserMessage
      ? (text, isFirst) => Promise.resolve(ports.onUserMessage!(text, isFirst))
      : undefined,
    usage: {
      check: () => Promise.resolve(ports.usage.check()),
      record: (m, i, o) => Promise.resolve(ports.usage.record(m, i, o)),
      estimate: (t) => Promise.resolve(ports.usage.estimate(t)),
    },
    toolSupport: {
      shouldSendTools: (m) => Promise.resolve(ports.toolSupport.shouldSendTools(m)),
      isKnownToolCapable: (m) => Promise.resolve(ports.toolSupport.isKnownToolCapable(m)),
      record: (m, s) => Promise.resolve(ports.toolSupport.record(m, s)),
    },
    vision: {
      shouldTryDirect: (m) => Promise.resolve(ports.vision.shouldTryDirect(m)),
      record: (m, s) => Promise.resolve(ports.vision.record(m, s)),
      defaultModel: () => Promise.resolve(ports.vision.defaultModel()),
    },
    compactWarnOnce: () => Promise.resolve(ports.compactWarnOnce()),
  }
}

function makeSpec(overrides: Partial<EngineTurnSpec> = {}): EngineTurnSpec {
  return {
    rawText: 'こんにちは',
    images: [],
    assetBlock: '',
    apiKey: 'key-1',
    model: 'modelA',
    models: [{ id: 'modelA' }, { id: 'modelB' }],
    maxRounds: 5,
    toolsProjectDir: '/proj',
    convDir: '/proj',
    errorPrefix: '',
    twoStageVision: false,
    routedModel: null,
    hasRag: false,
    turnOpts: {},
    snapshotId: 'snap-1',
    snapshotLabel: 'こんにちは',
    ...overrides,
  }
}

/**
 * ログに積んだ emit( 出来事を、本物の applyToMessages（chatEvents.ts）で畳んで
 * 「実際に画面に残る最終状態」を復元する。
 *
 * ── なぜ要るか ──────────────────────────────────────────────────
 * ログを「後ろから探して最初に見つかった一致」で見ると、その後 removeLast が
 * 起きて実際には消えている・別物に置き換わっていても素通りしてしまう
 * （掟10のミューテーション試験で実際に検出：wroteFiles の記録を無効化しても
 * 単純な log 検索では落ちなかった）。出来事を本物の適用ロジックで畳み、
 * **最終的に画面へ残るメッセージ列**で確かめる。
 */
function replayMessages(log: any[]): TurnMessage[] {
  let msgs: TurnMessage[] = []
  for (const e of log) {
    if (e.tag === 'emit' && (e.ev.kind === 'append' || e.ev.kind === 'replaceLast' || e.ev.kind === 'removeLast')) {
      msgs = applyToMessages(msgs, e.ev)
    }
  }
  return msgs
}

describe('runEngineTurn', () => {
  // 1. 予算超過
  it('予算超過: append(user) → append(🛑…) だけで終わる（loading は触らない）', async () => {
    const { ports, log } = makePorts({ stream: [], usageAllowed: [false], usageMessage: '今月の上限です' })
    await runEngineTurn(makeSpec(), ports)
    expect(log).toEqual([
      { tag: 'usage.check' },
      { tag: 'emit', ev: { kind: 'append', msg: { role: 'user', content: 'こんにちは' } } },
      { tag: 'emit', ev: { kind: 'append', msg: { role: 'assistant', content: '🛑 今月の上限です' } } },
    ])
  })

  // 2. 素の応答（全列一致）
  it('素の応答: 全列一致。usage.record が usage の値で呼ばれる', async () => {
    const { ports, log } = makePorts({
      stream: [{ content: 'こんにちは！', toolCalls: null, usage: { prompt_tokens: 10, completion_tokens: 5 } }],
    })
    await runEngineTurn(makeSpec(), ports)
    expect(log).toEqual([
      { tag: 'usage.check' },
      { tag: 'getHistory' },
      { tag: 'emit', ev: { kind: 'append', msg: { role: 'user', content: 'こんにちは', images: undefined } } },
      { tag: 'onUserMessage', text: 'こんにちは', isFirst: true },
      { tag: 'emit', ev: { kind: 'loading', value: true } },
      { tag: 'buildSystemPrompt' },
      { tag: 'getSearchConfig' },
      { tag: 'fetchPagesBlock', urls: [] },
      { tag: 'autoSearchBlock', text: 'こんにちは', search: null },
      { tag: 'emit', ev: { kind: 'status', value: '' } },
      { tag: 'emit', ev: { kind: 'status', value: '' } },
      { tag: 'emit', ev: { kind: 'append', msg: { role: 'assistant', content: '' } } },
      { tag: 'chatStream', model: 'modelA', hasTools: true, maxTokens: 16384 },
      { tag: 'setAbort', has: true },
      { tag: 'notifyActivity' },
      { tag: 'emit', ev: { kind: 'replaceLast', msg: { role: 'assistant', content: 'こんにちは！', thinking: undefined } } },
      { tag: 'usage.record', model: 'modelA', promptTokens: 10, completionTokens: 5 },
      { tag: 'setAbort', has: false },
      { tag: 'emit', ev: { kind: 'loading', value: false } },
      { tag: 'emit', ev: { kind: 'status', value: '' } },
    ])
  })

  // 3. usage が無いとき
  it('usage が無いとき: estimate の見積りで record される', async () => {
    const { ports, log } = makePorts({
      stream: [{ content: 'やあ', toolCalls: null, usage: null }],
    })
    const spec = makeSpec()
    await runEngineTurn(spec, ports)
    const rec = log.find((e) => e.tag === 'usage.record')
    // inputText = systemPrompt + '' + text + assetBlock。history 空・pastMessages 空なので systemPrompt + text。
    const expectedPrompt = estimateTokens('システム' + spec.rawText)
    const expectedCompletion = estimateTokens('やあ')
    expect(rec).toEqual({ tag: 'usage.record', model: 'modelA', promptTokens: expectedPrompt, completionTokens: expectedCompletion })
  })

  // 4. ツール1回
  it('ツール1回: replaceLast(実況) → executeTool(name,args,{...turnOpts,search,snapshotId,snapshotLabel}) → 2回目で本文 → 最終列', async () => {
    const toolCalls = [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }]
    const { ports, log } = makePorts({
      search: { provider: 'tavily', key: 'k' },
      stream: [
        { content: '', toolCalls, usage: { prompt_tokens: 1, completion_tokens: 1 } },
        { content: '読みました', toolCalls: null, usage: { prompt_tokens: 2, completion_tokens: 2 } },
      ],
      executeTool: () => 'ファイルの中身',
    })
    const spec = makeSpec({ turnOpts: { projectDir: '/proj' } })
    await runEngineTurn(spec, ports)

    const toolIdx = log.findIndex((e) => e.tag === 'executeTool')
    expect(toolIdx).toBeGreaterThan(-1)
    expect(log[toolIdx]).toEqual({
      tag: 'executeTool',
      name: 'read_file',
      argsJson: '{"path":"a.txt"}',
      opts: { projectDir: '/proj', search: { provider: 'tavily', key: 'k' }, snapshotId: 'snap-1', snapshotLabel: 'こんにちは' },
    })
    // 直前は「実況」への replaceLast
    expect(log[toolIdx - 1]).toEqual({
      tag: 'emit',
      ev: { kind: 'replaceLast', msg: { role: 'assistant', content: '📄 ファイルを読んでいます… a.txt', toolNote: true } },
    })
    // 最終列: 最後の3件は 本文のreplaceLast → setAbort(null) → loading false → status ''
    const last = log[log.length - 1]
    expect(last).toEqual({ tag: 'emit', ev: { kind: 'status', value: '' } })
    expect(log[log.length - 2]).toEqual({ tag: 'emit', ev: { kind: 'loading', value: false } })
    expect(log[log.length - 3]).toEqual({ tag: 'setAbort', has: false })
    expect(log.some((e) => e.tag === 'emit' && e.ev.kind === 'replaceLast' && e.ev.msg.content === '読みました')).toBe(true)
  })

  // 5. 承認拒否
  it('承認拒否: executeTool は呼ばれない。拒否文字列が次の chatStream の messages に入る', async () => {
    const toolCalls = [{ id: 'c1', function: { name: 'write_file', arguments: '{"path":"a.txt","content":"x"}' } }]
    let secondReqMessages: any[] | null = null
    const { ports, log } = makePorts({
      stream: [
        { content: '', toolCalls, usage: { prompt_tokens: 1, completion_tokens: 1 } },
        { content: 'わかりました', toolCalls: null, usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ],
      hasApproveToolCall: true,
      approveToolCall: () => '拒否しました',
    })
    // 2回目の chatStream 呼び出し時に messages を横取りする
    const origChatStream = ports.chatStream
    ports.chatStream = async (req, onDelta, onAbortReady, onThinking) => {
      if (log.filter((e) => e.tag === 'chatStream').length === 1) secondReqMessages = req.messages
      return origChatStream(req, onDelta, onAbortReady, onThinking)
    }
    await runEngineTurn(makeSpec(), ports)

    expect(log.some((e) => e.tag === 'executeTool')).toBe(false)
    expect(log.some((e) => e.tag === 'approveToolCall' && e.name === 'write_file')).toBe(true)
    expect(secondReqMessages).not.toBeNull()
    const toolResultMsg = (secondReqMessages as any[]).find((m) => m.role === 'tool')
    expect(toolResultMsg).toEqual({ role: 'tool', tool_call_id: 'c1', content: '拒否しました' })
  })

  // 6. 書き込みツールで wroteFiles
  it('書き込みツールで wroteFiles: write_file 実行後、「変えた」主張の警告が出ない', async () => {
    const toolCalls = [{ id: 'c1', function: { name: 'write_file', arguments: '{"path":"a.txt","content":"x"}' } }]
    const { ports, log } = makePorts({
      stream: [
        { content: '', toolCalls, usage: { prompt_tokens: 1, completion_tokens: 1 } },
        { content: 'index.html を修正しました', toolCalls: null, usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ],
      executeTool: () => 'ok',
    })
    await runEngineTurn(makeSpec(), ports)
    // 最終的に画面へ残るメッセージ列で確かめる（log を後ろから探すだけだと、あとで
    // removeLast された吹き出しにも一致してしまい弱いテストになる。掟10で実際に検出）。
    const messages = replayMessages(log)
    const last = messages[messages.length - 1]
    expect(last.content).toBe('index.html を修正しました') // 警告文が付いていない・やり直しにもならない
    expect(log.filter((e) => e.tag === 'chatStream').length).toBe(2) // 「やり直し」の3回目が走っていない
  })

  // 7. 暴走検出
  it('暴走検出: 同じ呼び出しが3回目で「同じ操作を繰り返している」で replaceLast、break', async () => {
    const call = { id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }
    const { ports, log } = makePorts({
      stream: [
        { content: '', toolCalls: [call] },
        { content: '', toolCalls: [call] },
        { content: '', toolCalls: [call] },
      ],
      executeTool: () => 'x',
    })
    await runEngineTurn(makeSpec({ maxRounds: 10 }), ports)
    expect(log.filter((e) => e.tag === 'executeTool').length).toBe(REPEAT_LIMIT)
    const warn = [...log].reverse().find((e) => e.tag === 'emit' && e.ev.kind === 'replaceLast' && typeof e.ev.msg.content === 'string' && e.ev.msg.content.includes('同じ操作を繰り返している'))
    expect(warn).toBeTruthy()
  })

  // 8. maxRounds 到達
  it('maxRounds 到達: offerContinue: true 付きで replaceLast', async () => {
    const call = (n: number) => ({ id: `c${n}`, function: { name: 'read_file', arguments: `{"path":"a${n}.txt"}` } })
    const { ports, log } = makePorts({
      stream: [
        { content: '', toolCalls: [call(1)] },
        { content: '', toolCalls: [call(2)] },
      ],
      executeTool: () => 'x',
    })
    await runEngineTurn(makeSpec({ maxRounds: 1 }), ports)
    const last = [...log].reverse().find((e) => e.tag === 'emit' && e.ev.kind === 'replaceLast' && e.ev.msg.offerContinue)
    expect(last).toBeTruthy()
    expect(last.ev.msg.offerContinue).toBe(true)
  })

  // 9. ツール失敗→再試行
  it('ツール失敗→再試行: toolFailed → removeLast → status「応答をやり直しています…」→ noTools で再ストリーム → status \'\'', async () => {
    const { ports, log } = makePorts({
      stream: [
        { content: '', toolCalls: null }, // 本文もツール呼び出しも無い＝失敗
        { content: '仕切り直しました', toolCalls: null },
      ],
    })
    await runEngineTurn(makeSpec(), ports)
    const streams = log.filter((e) => e.tag === 'chatStream')
    expect(streams.length).toBe(2)
    expect(streams[1].hasTools).toBe(false) // noTools=true で再試行
    const idxRemoveLast = log.findIndex((e) => e.tag === 'emit' && e.ev.kind === 'removeLast')
    expect(idxRemoveLast).toBeGreaterThan(-1)
    const idxRetryStatus = log.findIndex((e) => e.tag === 'emit' && e.ev.kind === 'status' && e.ev.value === '応答をやり直しています…')
    expect(idxRetryStatus).toBe(idxRemoveLast + 1)
    // streamOnce の中身: まず空の吹き出しを append してから chatStream を呼ぶ
    expect(log[idxRetryStatus + 1]).toEqual({ tag: 'emit', ev: { kind: 'append', msg: { role: 'assistant', content: '' } } })
    expect(log[idxRetryStatus + 2].tag).toBe('chatStream')
  })

  // 10. 400 ツール非対応
  it('400 ツール非対応: chatStream が throw、toolSupport.record(m,false) → removeLast → noTools 再試行', async () => {
    const { ports, log } = makePorts({
      stream: [
        { content: '', throwMessage: 'enable auto tool choice' },
        { content: '通常の返事です', toolCalls: null },
      ],
    })
    await runEngineTurn(makeSpec(), ports)
    expect(log.some((e) => e.tag === 'toolSupport.record' && e.model === 'modelA' && e.supported === false)).toBe(true)
    const idxRemoveLast = log.findIndex((e) => e.tag === 'emit' && e.ev.kind === 'removeLast')
    expect(idxRemoveLast).toBeGreaterThan(-1)
    const streams = log.filter((e) => e.tag === 'chatStream')
    expect(streams.length).toBe(2)
    expect(streams[1].hasTools).toBe(false)
  })

  // 11. 「変えた」と言って書いていない
  // （0.4.5 で非破壊化: removeLast をやめた。2026-08-30 実機で「lsを実行して」への返答が
  //  誤検知で消され、強制指示が頼まれていない書き込みを誘発したため。真陽性の効き目は
  //  このシナリオのとおり維持——促されて書かなければ警告が本文に付く）
  it('「変えた」と言って書いていない: 返事は消さず ⚠️ append → 促しの user メッセージが足されて continue。2回目も書かなければ警告が本文に付く', async () => {
    let requests: any[] = []
    const { ports, log } = makePorts({
      stream: [
        { content: 'index.html を修正しました', toolCalls: null },
        { content: 'index.html を修正しました', toolCalls: null },
      ],
    })
    const orig = ports.chatStream
    ports.chatStream = async (req, onDelta, onAbortReady, onThinking) => {
      requests.push(req.messages)
      return orig(req, onDelta, onAbortReady, onThinking)
    }
    await runEngineTurn(makeSpec(), ports)

    // （0.4.5 作り直し）確認中の印は吹き出しでなく一時ステータス（会話に積まれない）
    const idxAsked = log.findIndex((e) => e.tag === 'emit' && e.ev.kind === 'status' && e.ev.value === '実際に変更が必要か確かめています…')
    expect(idxAsked).toBeGreaterThan(-1)
    // （0.4.5）誤検知でも本物の答えを消さない: 確認より前に removeLast が1度も出ていない
    expect(log.slice(0, idxAsked).some((e) => e.tag === 'emit' && e.ev.kind === 'removeLast')).toBe(false)
    // 促しの user メッセージが2回目の chatStream の messages に入っている（実行の指示と、
    // 「不要なら実行しない」逃げ道の両方＝でっち上げ書き込みの防止）
    expect(requests[1].some((m: any) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('write_file または edit_file でいま実行してください'))).toBe(true)
    expect(requests[1].some((m: any) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('変更が不要な場合'))).toBe(true)
    // 2回目も書かなければ、最終本文に警告が付く
    const finalReplace = [...log].reverse().find((e) => e.tag === 'emit' && e.ev.kind === 'replaceLast' && typeof e.ev.msg.content === 'string' && e.ev.msg.content.startsWith('index.html を修正しました'))
    expect(finalReplace).toBeTruthy()
    expect(finalReplace.ev.msg.content).toContain('実際には書き込みが行われていません')
  })

  // 11b. 誤検知の発生源対策（2026-08-30 実機・v0.4.5）: 完了表現が**過去のターンの話**
  // （「先ほど保存しました」）なら、そもそも促しの往復すら走らず、1回で正常に終わる。
  it('過去のターンの話は促し自体が走らない: 1回で終了・書き込みも確認ステータスも無し', async () => {
    const { ports, log } = makePorts({
      stream: [
        { content: 'text.txt は先ほど保存しました。ls の結果は text.txt の1件です', toolCalls: null },
      ],
    })
    await runEngineTurn(makeSpec(), ports)
    expect(log.some((e) => e.tag === 'emit' && e.ev.kind === 'removeLast')).toBe(false)
    expect(log.some((e) => e.tag === 'emit' && e.ev.kind === 'status' && e.ev.value === '実際に変更が必要か確かめています…')).toBe(false)
    expect(log.some((e) => e.tag === 'executeTool')).toBe(false)
    expect(log.filter((e) => e.tag === 'chatStream').length).toBe(1) // 往復が増えていない
    // 返事はそのまま・警告なし
    const last = [...log].reverse().find((e) => e.tag === 'emit' && e.ev.kind === 'replaceLast')
    expect(last.ev.msg.content).toBe('text.txt は先ほど保存しました。ls の結果は text.txt の1件です')
  })

  // 11c. 促しに「変更は不要」と書かずに答え直した場合: でっち上げ書き込みはせず、
  // 事実（このターンは変更なし）だけを短く添える（嘘の「更新済みです」を利用者が見抜ける）。
  it('促しに書かず答え直したら: 書き込みゼロ・警告なし・ℹ️ の事実だけ添える（本物の答えは消えない）', async () => {
    const { ports, log } = makePorts({
      stream: [
        { content: 'text.txt を更新しました', toolCalls: null },
        { content: '変更は不要です', toolCalls: null },
      ],
    })
    await runEngineTurn(makeSpec(), ports)
    // 1回目の返事が消されていない
    expect(log.some((e) => e.tag === 'emit' && e.ev.kind === 'removeLast')).toBe(false)
    expect(log.some((e) => e.tag === 'emit' && e.ev.kind === 'replaceLast' && e.ev.msg.content === 'text.txt を更新しました')).toBe(true)
    // ツール（書き込み）は1度も実行されていない
    expect(log.some((e) => e.tag === 'executeTool')).toBe(false)
    // 2回目の返事はそのまま（警告は付かない）で、ℹ️ の事実が別の吹き出しで続く
    expect(log.some((e) => e.tag === 'emit' && e.ev.kind === 'replaceLast' && e.ev.msg.content === '変更は不要です')).toBe(true)
    const info = log.find((e) => e.tag === 'emit' && e.ev.kind === 'append' && e.ev.msg?.content === 'ℹ️ このターンでは、ファイルは変更されていません。')
    expect(info).toBeTruthy()
    expect(info.ev.msg.toolNote).toBe(true)
  })

  // 11d. 案内定型文の重複除去（2026-08-30 実機・Ryosuke 指摘: プロンプトの「連続で
  // 繰り返さない」を Kimi K2.7 が無視。Koto 側で機械的に抑止する）。
  it('直前の返事と同一の案内定型文は、確定時の replaceLast で取り除かれる', async () => {
    const guide = '画面上部の【② 試す】ボタンで、text.txt の内容を確認してみてください。'
    const { ports, log } = makePorts({
      history: [
        { role: 'user', content: '保存して' },
        { role: 'assistant', content: `保存しました\n\n${guide}` },
      ],
      stream: [
        { content: `ls の結果は text.txt の1件です。\n\n${guide}`, toolCalls: null },
      ],
    })
    await runEngineTurn(makeSpec(), ports)
    // 最後の replaceLast は案内が取り除かれた本文になっている
    const last = [...log].reverse().find((e) => e.tag === 'emit' && e.ev.kind === 'replaceLast')
    expect(last.ev.msg.content).toBe('ls の結果は text.txt の1件です。')
    expect(last.ev.msg.content).not.toContain('② 試す')
  })

  // 11e. 開始時の「文脈の飾り」系 ask が失敗してもターンは死なない（2026-08-31 実機:
  // 「今の」が wantsWebSearch に一致→実検索中の ⌘W で ask 全滅→ターンごとエラーになった）。
  it('文脈の飾り（検索設定・ページ取得・自動検索・資料注入）が reject しても、ターンは完走してエラー吹き出しを出さない', async () => {
    const { ports, log } = makePorts({
      stream: [{ content: 'できました', toolCalls: null }],
      hasBuildRagBlock: true,
    })
    // 4つの飾り ask を全部 reject させる（画面喪失の rejectAll を模す）
    ports.getSearchConfig = async () => { log.push({ tag: 'getSearchConfig' }); throw new Error('画面が閉じられました') }
    ports.fetchPagesBlock = async () => { throw new Error('画面が閉じられました') }
    ports.autoSearchBlock = async () => { throw new Error('画面が閉じられました') }
    ports.buildRagBlock = async () => { throw new Error('画面が閉じられました') }
    const r = await runEngineTurn(makeSpec(), ports)
    expect(r.endedWithError).toBe(false)
    // 最終返信が出ている（本体は完走）
    expect(log.some((e) => e.tag === 'emit' && e.ev.kind === 'replaceLast' && e.ev.msg.content === 'できました')).toBe(true)
    // エラー吹き出しが無い
    expect(log.some((e) => e.tag === 'emit' && (e.ev.kind === 'append' || e.ev.kind === 'replaceLast') && typeof e.ev.msg?.content === 'string' && e.ev.msg.content.includes('エラー'))).toBe(false)
  })

  // 11f. 🗂まとめは2つ目の system として送らない（2026-08-31 実機: preview/Qwen3.6-35B が
  // 「400 System message must be at the beginning.」で会話全体を拒否した。まとめ機能以来の潜在バグ）。
  it('まとめ持ちの履歴でも、送る messages の system は先頭の1つだけ（まとめは先頭 system に畳み込む）', async () => {
    // planSend が summary を role:'system' で返す形を、実物の履歴形（summary マーク付き）で作る
    const history: TurnMessage[] = [
      { role: 'user', content: '古い依頼' },
      // mark は「まとめが覆う最後の本文メッセージ」の markOf と一致していないと無効扱いになる
      // （currentSummary の食い違い検査）。実物と同じ式で作る。
      { role: 'assistant', content: '昔の作業のまとめです', summary: { upTo: 1, mark: 'user:' + '古い依頼'.length + ':古い依頼' } } as any,
      { role: 'user', content: '最近の依頼' },
      { role: 'assistant', content: '最近の返事' },
    ]
    const { ports, streamRequests } = makePorts({
      history,
      stream: [{ content: 'ok', toolCalls: null }],
    })
    await runEngineTurn(makeSpec(), ports)
    const msgs = streamRequests[0].messages
    const systemIdxs = msgs.map((m: any, i: number) => (m.role === 'system' ? i : -1)).filter((i: number) => i >= 0)
    expect(systemIdxs).toEqual([0]) // system は先頭の1つだけ
    expect(msgs[0].content).toContain('昔の作業のまとめです') // まとめは先頭 system に畳まれている
    // 履歴の user/assistant は従来どおり並んでいる
    expect(msgs.some((m: any) => m.role === 'user' && String(m.content).includes('最近の依頼'))).toBe(true)
  })

  // 12. ルーティング
  it('ルーティング: hadToolMarkup かつ isKnownToolCapable のモデルがある → routed イベント → removeLast → 🔀 append → そのモデルで再実行', async () => {
    const { ports, log } = makePorts({
      stream: [
        { content: '<|tool_calls_section_begin|>functions.write_file:0{}<|tool_calls_section_end|>', toolCalls: null },
        { content: 'modelB で実行しました', toolCalls: null },
      ],
      knownCapable: { modelB: true },
    })
    await runEngineTurn(makeSpec(), ports)
    const routedEv = log.find((e) => e.tag === 'emit' && e.ev.kind === 'routed')
    expect(routedEv).toEqual({ tag: 'emit', ev: { kind: 'routed', value: 'modelB' } })
    const idxRouted = log.indexOf(routedEv)
    expect(log[idxRouted + 1]).toEqual({ tag: 'emit', ev: { kind: 'removeLast' } })
    expect(log[idxRouted + 2].tag).toBe('emit')
    expect(log[idxRouted + 2].ev.kind).toBe('append')
    expect(log[idxRouted + 2].ev.msg.content).toContain('🔀')
    expect(log[idxRouted + 2].ev.msg.content).toContain('modelB')
    const streams = log.filter((e) => e.tag === 'chatStream')
    expect(streams[1].model).toBe('modelB')
  })

  // 13. 停止
  it('停止: aborted → 「（⏹ 停止しました）」。ループから抜ける', async () => {
    const { ports, log } = makePorts({
      stream: [{ content: '途中まで', aborted: true }],
    })
    await runEngineTurn(makeSpec(), ports)
    const last = [...log].reverse().find((e) => e.tag === 'emit' && e.ev.kind === 'replaceLast')
    expect(last.ev.msg.content).toContain('（⏹ 停止しました）')
    expect(log.filter((e) => e.tag === 'chatStream').length).toBe(1)
  })

  // 14. 空応答
  it('空応答: 「（応答が空でした…）」', async () => {
    // 本文もツール呼び出しも無い1回目は、まず「ツール無しで再試行」の自己修復が先に走る
    // （9番のシナリオと同じ経路）。再試行しても空のままなら、最終的にこの文言になる。
    const { ports, log } = makePorts({
      stream: [
        { content: '', toolCalls: null, reasoningText: null },
        { content: '', toolCalls: null, reasoningText: null },
      ],
    })
    await runEngineTurn(makeSpec(), ports)
    const last = [...log].reverse().find((e) => e.tag === 'emit' && e.ev.kind === 'replaceLast')
    expect(last.ev.msg.content).toContain('応答が空でした')
  })

  // 15. 推論フォールバック
  it('推論フォールバック: 本文空・toolCalls無し・reasoningTextあり → condenseReasoning の結果が本文', async () => {
    const { ports, log } = makePorts({
      stream: [{ content: '', toolCalls: null, reasoningText: '考え中の文章です' }],
    })
    await runEngineTurn(makeSpec(), ports)
    const expected = condenseReasoning('考え中の文章です')
    const hit = log.find((e) => e.tag === 'emit' && e.ev.kind === 'replaceLast' && e.ev.msg.content === expected)
    expect(hit).toBeTruthy()
  })

  // 16. ループ中の予算到達
  it('ループ中の予算到達: 2周目前に usage.check 不許可 → break', async () => {
    const call = (n: number) => ({ id: `c${n}`, function: { name: 'read_file', arguments: `{"path":"a${n}.txt"}` } })
    const { ports, log } = makePorts({
      stream: [
        { content: '', toolCalls: [call(1)] },
        { content: '本文2', toolCalls: null },
      ],
      executeTool: () => 'x',
      usageAllowed: [true, false],
    })
    await runEngineTurn(makeSpec({ maxRounds: 10 }), ports)
    expect(log.filter((e) => e.tag === 'chatStream').length).toBe(1) // 2周目には入らない
    expect(log.filter((e) => e.tag === 'usage.check').length).toBe(2)
  })

  // 17. 自動まとめ
  it('自動まとめ: planCompact が plan を返す長さの履歴 → status 🗂… → chatOnce → summary 付き append → planSend がまとめ入り履歴に適用される', async () => {
    // SEND_BUDGET_TOKENS(8000) を超える長さの履歴を作る（1件あたり十分長い文字列）
    const big = 'あ'.repeat(400) // estimateTokens は非ASCIIを1文字1トークンで数える
    const history: TurnMessage[] = Array.from({ length: 25 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: big }))
    const { ports, log } = makePorts({
      history,
      stream: [{ content: '本文', toolCalls: null }],
      chatOnce: { content: '## まとめ\nこれまでの要点です。20文字以上の本文が必要なので伸ばしています。', usage: { prompt_tokens: 1, completion_tokens: 1 } },
    })
    await runEngineTurn(makeSpec(), ports)
    const idxStatus = log.findIndex((e) => e.tag === 'emit' && e.ev.kind === 'status' && e.ev.value.includes('🗂'))
    expect(idxStatus).toBeGreaterThan(-1)
    const idxChatOnce = log.findIndex((e) => e.tag === 'chatOnce')
    expect(idxChatOnce).toBeGreaterThan(idxStatus)
    const summaryAppend = log.find((e) => e.tag === 'emit' && e.ev.kind === 'append' && e.ev.msg.summary)
    expect(summaryAppend).toBeTruthy()
    expect(summaryAppend.ev.msg.content).toBe('これまでの要点です。20文字以上の本文が必要なので伸ばしています。')
  })

  // 17b. まとめで畳んだ古いやり取りが、そのまま送られていないこと（planSend が実際に適用される証拠）。
  // ミューテーション試験で「...pastMessages を生の履歴に置き換えても 25件全部が通る」ことが
  // 分かったため追加した（2026-08-28）。まとめの意味（送る量を予算に収める）そのものを固定する。
  it('自動まとめ: 畳んだ範囲の古い本文は chatStream に送られない（送るのは summary＋直近だけ）', async () => {
    const big = 'あ'.repeat(400)
    const history: TurnMessage[] = Array.from({ length: 25 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `${i}番目:${big}`,
    }))
    const { ports, streamRequests } = makePorts({
      history,
      stream: [{ content: '本文', toolCalls: null }],
      chatOnce: { content: '## まとめ\nこれまでの要点です。20文字以上の本文が必要なので伸ばしています。', usage: { prompt_tokens: 1, completion_tokens: 1 } },
    })
    await runEngineTurn(makeSpec(), ports)
    expect(streamRequests.length).toBeGreaterThan(0)
    const sent = JSON.stringify(streamRequests[0].messages)
    // まとめが送る履歴に入っている
    expect(sent).toContain('これまでの要点です。')
    // 畳んだ範囲の先頭（0番目）の本文は入っていない
    // （'0番目:' だけだと「20番目:」に部分一致するので、JSONの形ごと当てる）
    expect(sent).not.toContain('"content":"0番目:')
    expect(sent).toContain('"content":"24番目:')
    // 送る量が predawn の全量（25件×400字）よりはっきり小さいこと
    const total = history.reduce((n, m) => n + m.content.length, 0)
    expect(sent.length).toBeLessThan(total)
  })

  // 18. まとめ失敗の警告は1度だけ
  it('まとめ失敗の警告は1度だけ: compactWarnOnce の true/false で分岐', async () => {
    const big = 'あ'.repeat(400)
    const history: TurnMessage[] = Array.from({ length: 25 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: big }))
    const runOnce = async (compactWarn: boolean[]) => {
      const { ports, log } = makePorts({
        history,
        stream: [{ content: '本文', toolCalls: null }],
        chatOnce: { content: '返事が空でまとめとして受理されない文章' }, // acceptSummary が null を返す＝失敗
        compactWarn,
      })
      await runEngineTurn(makeSpec(), ports)
      return log
    }
    const logTrue = await runOnce([true])
    expect(logTrue.some((e) => e.tag === 'emit' && e.ev.kind === 'append' && e.ev.msg.toolNote && String(e.ev.msg.content).startsWith('⚠️'))).toBe(true)
    const logFalse = await runOnce([false])
    expect(logFalse.some((e) => e.tag === 'emit' && e.ev.kind === 'append' && e.ev.msg.toolNote && String(e.ev.msg.content).startsWith('⚠️'))).toBe(false)
  })

  // 19. 2段階 vision
  it('2段階 vision: twoStageVision=true・画像あり・vision.shouldTryDirect=false → 🖼 append → status 🖼 → 視覚モデルで chatStream（tools無し・maxTokens 1024）→ 説明文が本文に合流', async () => {
    const { ports, log } = makePorts({
      visionDirect: { modelA: false },
      visionDefault: 'vision-model',
      stream: [
        { content: '画像の説明文です' }, // 1段目: 視覚モデルでの読み取り
        { content: '本文です', toolCalls: null }, // 2段目: 本来モデルでの実行
      ],
    })
    // 2回目の chatStream 呼び出しに渡される messages（＝合流後の userContent）を横取りする
    const requests: any[][] = []
    const orig = ports.chatStream
    ports.chatStream = async (req, onDelta, onAbortReady, onThinking) => {
      requests.push(req.messages)
      return orig(req, onDelta, onAbortReady, onThinking)
    }
    const spec = makeSpec({ images: ['data:image/png;base64,xxx'], twoStageVision: true })
    await runEngineTurn(spec, ports)
    const streams = log.filter((e) => e.tag === 'chatStream')
    expect(streams[0]).toEqual({ tag: 'chatStream', model: 'vision-model', hasTools: false, maxTokens: 1024 })
    expect(streams[1].model).toBe('modelA')
    const readingAppend = log.find((e) => e.tag === 'emit' && e.ev.kind === 'append' && typeof e.ev.msg.content === 'string' && e.ev.msg.content.includes('🖼'))
    expect(readingAppend).toBeTruthy()
    const readingStatus = log.find((e) => e.tag === 'emit' && e.ev.kind === 'status' && e.ev.value.includes('🖼'))
    expect(readingStatus).toBeTruthy()
    // 2段目（modelA）に渡された最後の user メッセージに、1段目の説明文が合流している
    const secondUserMsg = requests[1][requests[1].length - 1]
    expect(secondUserMsg.role).toBe('user')
    expect(secondUserMsg.content).toContain('画像の説明文です')
    expect(secondUserMsg.content).toContain('# 添付画像の内容（AIによる読み取り）')
  })

  // 20. vision 直接切替（twoStage 無し）
  it('vision 直接切替（twoStage 無し）: useModel が defaultVisionModel になり、🖼 の append が出る', async () => {
    const { ports, log } = makePorts({
      visionDirect: { modelA: false },
      visionDefault: 'vision-model',
      stream: [{ content: '画像を見て答えます', toolCalls: null }],
    })
    const spec = makeSpec({ images: ['data:image/png;base64,xxx'], twoStageVision: false })
    await runEngineTurn(spec, ports)
    const streams = log.filter((e) => e.tag === 'chatStream')
    expect(streams.length).toBe(1)
    expect(streams[0].model).toBe('vision-model')
    const switchAppend = log.find((e) => e.tag === 'emit' && e.ev.kind === 'append' && typeof e.ev.msg.content === 'string' && e.ev.msg.content.includes('🖼'))
    expect(switchAppend).toBeTruthy()
  })

  // 21. エラー整形
  it('エラー整形: chatStream が throw（ツール非対応でも画像非対応でもない）→ append(errorPrefix + formatChatError(...))', async () => {
    const { ports, log } = makePorts({
      stream: [{ content: '', throwMessage: 'network down' }],
    })
    await runEngineTurn(makeSpec({ errorPrefix: '⚠️ ' }), ports)
    const expected = '⚠️ ' + formatChatError('network down')
    const hit = log.find((e) => e.tag === 'emit' && e.ev.kind === 'append' && e.ev.msg.content === expected)
    expect(hit).toBeTruthy()
  })

  // 22. stream 中の刻み
  it('stream 中の刻み: onDelta ごとに replaceLast と notifyActivity が呼ばれる。thinking の delta でも同様', async () => {
    const { ports, log } = makePorts({
      stream: [{
        content: 'AB',
        contentDeltas: ['A', 'B'],
        thinkingDeltas: ['思', '考'],
        toolCalls: null,
      }],
    })
    await runEngineTurn(makeSpec(), ports)
    const notify = log.filter((e) => e.tag === 'notifyActivity')
    // thinking 2件 + content 2件 = 4件（fake は thinkingDeltas → contentDeltas の順で流す）
    expect(notify.length).toBe(4)
    const replaces = log.filter((e) => e.tag === 'emit' && e.ev.kind === 'replaceLast').map((e) => ({ content: e.ev.msg.content, thinking: e.ev.msg.thinking }))
    // 1. onThinking('思') → thinkingAcc='思' のみ反映（本文はまだ空）
    expect(replaces[0]).toEqual({ content: '', thinking: '思' })
    // 2. onThinking('考') → thinkingAcc='思考'
    expect(replaces[1]).toEqual({ content: '', thinking: '思考' })
    // 3. onDelta('A') → 本文が進む。このとき thinking は直前の値のまま一緒に乗る
    expect(replaces[2]).toEqual({ content: 'A', thinking: '思考' })
    // 4. onDelta('B') → 本文が積み上がる
    expect(replaces[3]).toEqual({ content: 'AB', thinking: '思考' })
  })

  // 23. async ports（B'-3b）: ports の該当メンバーは main 実装だと IPC 往復で非同期になる。
  // 元は同期だった偽 ports を全部 Promise でくるんでも、2番（素の応答）と同じ結果になる
  // ことを確かめる（= 本文中の await が実際に効いていて、async 実装でも壊れないことの証拠）。
  it('async ports: 全 ports を Promise でくるんでも、素の応答（2番）と同じ結果になる', async () => {
    const { ports, log } = makePorts({
      stream: [{ content: 'こんにちは！', toolCalls: null, usage: { prompt_tokens: 10, completion_tokens: 5 } }],
    })
    await runEngineTurn(makeSpec(), wrapPortsAsync(ports))
    expect(log).toEqual([
      { tag: 'usage.check' },
      { tag: 'getHistory' },
      { tag: 'emit', ev: { kind: 'append', msg: { role: 'user', content: 'こんにちは', images: undefined } } },
      { tag: 'onUserMessage', text: 'こんにちは', isFirst: true },
      { tag: 'emit', ev: { kind: 'loading', value: true } },
      { tag: 'buildSystemPrompt' },
      { tag: 'getSearchConfig' },
      { tag: 'fetchPagesBlock', urls: [] },
      { tag: 'autoSearchBlock', text: 'こんにちは', search: null },
      { tag: 'emit', ev: { kind: 'status', value: '' } },
      { tag: 'emit', ev: { kind: 'status', value: '' } },
      { tag: 'emit', ev: { kind: 'append', msg: { role: 'assistant', content: '' } } },
      { tag: 'chatStream', model: 'modelA', hasTools: true, maxTokens: 16384 },
      { tag: 'setAbort', has: true },
      { tag: 'notifyActivity' },
      { tag: 'emit', ev: { kind: 'replaceLast', msg: { role: 'assistant', content: 'こんにちは！', thinking: undefined } } },
      { tag: 'usage.record', model: 'modelA', promptTokens: 10, completionTokens: 5 },
      { tag: 'setAbort', has: false },
      { tag: 'emit', ev: { kind: 'loading', value: false } },
      { tag: 'emit', ev: { kind: 'status', value: '' } },
    ])
  })

  // 24. 🗂 まとめ作り中の ⏹ 停止（0.3.50・roadmap「次の改善2件」その1・本丸）
  it('🗂 まとめ作り中の ⏹ 停止: chatOnce が abort 例外で reject → chatStream は呼ばれない・（⏹ 停止しました）が append・最後は loading=false/status=\'\'', async () => {
    // SEND_BUDGET_TOKENS(8000) を超える長さの履歴（planCompact が plan を返す条件。17番と同じ作り）
    const big = 'あ'.repeat(400)
    const history: TurnMessage[] = Array.from({ length: 25 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: big }))
    const { ports, log } = makePorts({
      history,
      stream: [{ content: '本文', toolCalls: null }], // 呼ばれてはいけない（呼ばれたらテストが失敗する）
      chatOnceThrow: { name: 'APIUserAbortError', message: 'Request was aborted.' },
    })
    await runEngineTurn(makeSpec(), ports)

    // chatStream は一切呼ばれていない（まとめ作りの段階で打ち切ったので）
    expect(log.filter((e) => e.tag === 'chatStream').length).toBe(0)

    const idxChatOnce = log.findIndex((e) => e.tag === 'chatOnce')
    expect(idxChatOnce).toBeGreaterThan(-1)
    // chatOnce が reject したあとの出来事の並び（固定）:
    // runCompact の finally で status('') → 呼び出し元で append(⏹停止) → 外側の finally で
    // setAbort(null) → loading(false) → status('')
    expect(log.slice(idxChatOnce + 1)).toEqual([
      { tag: 'emit', ev: { kind: 'status', value: '' } },
      { tag: 'emit', ev: { kind: 'append', msg: { role: 'assistant', content: '（⏹ 停止しました）' } } },
      { tag: 'setAbort', has: false },
      { tag: 'emit', ev: { kind: 'loading', value: false } },
      { tag: 'emit', ev: { kind: 'status', value: '' } },
    ])
    // 画面に残るのはユーザーの発言と「（⏹ 停止しました）」だけ（まとめのバブルは出ていない）
    const messages = replayMessages(log)
    expect(messages.map((m) => m.content)).toEqual(['こんにちは', '（⏹ 停止しました）'])
  })

  // 25. まとめ失敗（abort 以外）は今まで通り（24番の対照実験）
  it('🗂 まとめ失敗（abort 以外の例外）: chatOnce が通常のエラーで reject しても、従来どおり黙って送信は続き・警告は1度だけ', async () => {
    const big = 'あ'.repeat(400)
    const history: TurnMessage[] = Array.from({ length: 25 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: big }))
    const { ports, log } = makePorts({
      history,
      stream: [{ content: '本文', toolCalls: null }],
      chatOnceThrow: { message: 'network down' }, // name は APIUserAbortError ではなく、abort とも読めない
    })
    await runEngineTurn(makeSpec(), ports)

    // 送信は続いている（chatStream が呼ばれ、最終的に本文が画面に残る）
    expect(log.filter((e) => e.tag === 'chatStream').length).toBe(1)
    const messages = replayMessages(log)
    expect(messages[messages.length - 1].content).toBe('本文')
    // 警告（⚠️ で始まる toolNote）が1度だけ出る
    const warns = log.filter((e) => e.tag === 'emit' && e.ev.kind === 'append' && e.ev.msg.toolNote && String(e.ev.msg.content).startsWith('⚠️'))
    expect(warns.length).toBe(1)
  })
})

// 配線: turnRunner.ts は electron（ipcMain）を import しているため node のテストから直接
// 呼び出せない。ソースを読んで、chatOnce が onAbortReady で entry.abort を差し替えている
// **呼び出しの形そのもの**を固定する（掟10: 「どこかに書いてある」だけでは直し忘れを捕まえられない）。
describe('配線: turnRunner.ts の chatOnce（🗂 まとめ作り中の ⏹ 停止・main 側）', () => {
  it('runSakuraChat へ onAbortReady を渡し、entry.abort を差し替えている', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/chat/turnRunner.ts'), 'utf-8')
    const inCode = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    expect(inCode).toContain('chatOnce: (req) => runSakuraChat(req, { onAbortReady: (abort) => { entry.abort = abort } }),')
    // 直す前の形（onAbortReady を渡さない）へ戻さない
    expect(src).not.toContain('chatOnce: (req) => runSakuraChat(req),')
  })
})

describe('runCompact', () => {
  it('apiKey / model が無ければ、キー未登録のエラーを返す', async () => {
    const { ports } = makePorts({ stream: [] })
    const plan: CompactPlanLike = { base: null, from: 0, to: 1, mark: 'm' }
    const r = await runCompact({ apiKey: '', model: 'modelA' }, ports, [], plan)
    expect(r).toEqual({ error: 'さくらのAI Engine のキーが登録されていないため、まとめを作れません。' })
  })

  it('予算超過なら作らない', async () => {
    const { ports } = makePorts({ stream: [], usageAllowed: [false] })
    const plan: CompactPlanLike = { base: null, from: 0, to: 1, mark: 'm' }
    const r = await runCompact({ apiKey: 'k', model: 'modelA' }, ports, [{ role: 'user', content: 'x' }], plan)
    expect('error' in r).toBe(true)
  })

  it('成功時は msg を返し、status を出し入れする', async () => {
    const summaryBody = '要点です。20文字以上の本文が必要なので伸ばしています。'
    const { ports, log } = makePorts({ stream: [], chatOnce: { content: `## まとめ\n${summaryBody}`, usage: { prompt_tokens: 3, completion_tokens: 4 } } })
    const plan: CompactPlanLike = { base: null, from: 0, to: 2, mark: 'm' }
    const history: TurnMessage[] = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]
    const r = await runCompact({ apiKey: 'k', model: 'modelA' }, ports, history, plan)
    expect(r).toEqual({ msg: { role: 'assistant', content: summaryBody, summary: { upTo: 2, mark: 'm' } } })
    expect(log[0]).toEqual({ tag: 'usage.check' })
    expect(log[1]).toEqual({ tag: 'emit', ev: { kind: 'status', value: '🗂 これまでの内容をまとめています…' } })
    expect(log[log.length - 1]).toEqual({ tag: 'emit', ev: { kind: 'status', value: '' } })
    expect(log.some((e) => e.tag === 'usage.record' && e.model === 'modelA' && e.promptTokens === 3 && e.completionTokens === 4)).toBe(true)
  })

  // ⏹ 停止（0.3.50・roadmap「次の改善2件」その1）: chatOnce が abort による例外で reject したら、
  // エラー文言（error）ではなく { aborted: true } を返す。isAbortError の分岐そのものを直接固定する
  // （runEngineTurn 側の24番・25番はこの分岐が「ターンを正しく終える」ところまでを確かめる）。
  it('⏹ 停止: chatOnce が abort 例外（APIUserAbortError）で reject → { aborted: true } を返す（エラー文言にしない）', async () => {
    const { ports, log } = makePorts({ stream: [], chatOnceThrow: { name: 'APIUserAbortError', message: 'Request was aborted.' } })
    const plan: CompactPlanLike = { base: null, from: 0, to: 2, mark: 'm' }
    const history: TurnMessage[] = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]
    const r = await runCompact({ apiKey: 'k', model: 'modelA' }, ports, history, plan)
    expect(r).toEqual({ aborted: true })
    // status は最後まで出し入れされる（まとめの試み自体は普通に始まり、finally で必ず戻す）
    expect(log[1]).toEqual({ tag: 'emit', ev: { kind: 'status', value: '🗂 これまでの内容をまとめています…' } })
    expect(log[log.length - 1]).toEqual({ tag: 'emit', ev: { kind: 'status', value: '' } })
  })

  // name が付いていない版（openai SDK の版によっては APIUserAbortError という名前が付かないことがある
  // 想定・engine.ts の isAbortError と同じ判定）でもメッセージの /abort/i だけで検知できることを確かめる。
  it('⏹ 停止: name の無い abort 例外（メッセージに abort を含む）でも { aborted: true } を返す', async () => {
    const { ports } = makePorts({ stream: [], chatOnceThrow: { message: 'The user aborted a request.' } })
    const plan: CompactPlanLike = { base: null, from: 0, to: 2, mark: 'm' }
    const r = await runCompact({ apiKey: 'k', model: 'modelA' }, ports, [{ role: 'user', content: 'a' }], plan)
    expect(r).toEqual({ aborted: true })
  })
})
