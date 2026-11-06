// 失敗の吹き出しに「もう一度送る」の印（offerRetry）が付くこと（chatTurn 側の5か所）と、
// 失敗の吹き出しが AI の履歴に入らないこと（表示専用）。
//
//   A. 吹き出しの作り手（chatFailure.ts の failureBubbleOf）: 印は必ず付く・保存と畳み込みで落ちない
//   B. 振る舞い: 本物の runEngineTurn を偽の ports で駆動し、出てくる出来事（emit）の一覧と
//      畳んだあとの画面の吹き出しを見る。印が付く5か所と、付かない出口を両方固定する
//   C. 配線: 吹き出しを組むのは failureBubbleOf だけ（直す前の手組みの形が戻らない）
//   D. AI の履歴から外す: 送信の入口 planSend に失敗の文が出ない・投げて空の吹き出しが残らない。
//      サーバーへ渡る一覧と、畳んだあとの画面・ディスクに残る形の両方を見る
//   E. 検分の直し: 時間切れの文が上書きで消えない・ツールの一覧で投げても空の吹き出しが残らない・
//      「応答が空」「ツール非対応」の文にも印・まとめの材料に入らない・待つ間に足された吹き出しを消さない

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  failureBubbleOf, unexpectedFailureBubble, undoEmptyBubble, requestTextOf, requestBubbleOf, noteWritten,
  unexpectedFailureAppends, UNEXPECTED_FAILURE_TEXT,
} from '../src/shared/chatFailure'
import {
  runEngineTurn, type EngineTurnSpec, type EngineTurnPorts, type TurnHelpers, type TurnMessage,
} from '../src/shared/chatTurn'
import { applyToMessages } from '../src/shared/chatEvents'
import { forStorage } from '../src/shared/chatStorage'
import { streamTimeoutMessage, type StreamTimeoutKind } from '../src/shared/chatTimeouts'
import { unexecutedToolsNote, toolActionName } from '../src/shared/aiToolsCore'
// 本物の純粋関数（偽物で固めると実物と離れる。tests/chatTurn.test.ts と同じ組み立て方）
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

const ROOT = path.join(__dirname, '..')

// ── A. 吹き出しの作り手 ───────────────────────────────────────────────────
describe('A. failureBubbleOf', () => {
  it('印と表示専用（toolNote）が必ず付く。余計な項目は増えない', () => {
    expect(failureBubbleOf('失敗しました')).toStrictEqual({ role: 'assistant', content: '失敗しました', toolNote: true, offerRetry: true })
  })

  it('運べるのは思考（thinking）だけ。思考が無ければ項目も作らない。表示専用は呼び出し側が外せない', () => {
    expect(failureBubbleOf('x', { thinking: '考え中' })).toStrictEqual({ role: 'assistant', content: 'x', thinking: '考え中', toolNote: true, offerRetry: true })
    expect(failureBubbleOf('x', { thinking: undefined })).toStrictEqual({ role: 'assistant', content: 'x', toolNote: true, offerRetry: true })
    // 引数で外そうとしても外れない
    expect(failureBubbleOf('x', { toolNote: false } as any).toolNote).toBe(true)
  })

  it('会話の保存（forStorage は thinking だけ落とす）と JSON の往復で、印と表示専用は残る', () => {
    const saved = forStorage([failureBubbleOf('x', { thinking: '考え中' })])
    expect(saved[0]).toStrictEqual({ role: 'assistant', content: 'x', toolNote: true, offerRetry: true })
    expect(JSON.parse(JSON.stringify(saved))[0]).toMatchObject({ offerRetry: true, toolNote: true })
  })

  it('undoEmptyBubble: 中身が空（空白だけも）なら末尾を取り除く出来事・途中まで届いていれば無し', () => {
    expect(undoEmptyBubble('')).toStrictEqual({ kind: 'removeLast' })
    expect(undoEmptyBubble(' \n\t')).toStrictEqual({ kind: 'removeLast' })
    expect(undoEmptyBubble('こんにち')).toBeNull()
    expect(undoEmptyBubble(' こ ')).toBeNull()
  })

  it('undoEmptyBubble: 会話の末尾が自分の足した空の吹き出しでなければ取り除かない（別の書き主が足した吹き出しを消さない）', () => {
    const empty = { role: 'assistant', content: '' }
    const notice = { role: 'assistant', content: '公開先を変えました', offerTargetCheck: true }
    // 末尾が空の assistant（自分の足したもの）→ 取り除く
    expect(undoEmptyBubble('', [{ role: 'user', content: '依頼' }, empty])).toStrictEqual({ kind: 'removeLast' })
    // 末尾が別の吹き出し → 取り除かない
    expect(undoEmptyBubble('', [{ role: 'user', content: '依頼' }, empty, notice])).toBeNull()
    expect(undoEmptyBubble('', [{ role: 'user', content: '依頼' }])).toBeNull()
    // 読めなかった（空の一覧）は、これまでどおり取り除く
    expect(undoEmptyBubble('', [])).toStrictEqual({ kind: 'removeLast' })
  })

  it('requestTextOf・requestBubbleOf: 画像だけの送信は既定の文・画像が無ければ images の項目は未設定', () => {
    expect(requestTextOf('  こんにちは ', false)).toBe('こんにちは')
    expect(requestTextOf('  ', true)).toBe('この画像について教えてください。')
    expect(requestTextOf('', false)).toBe('')
    expect(requestBubbleOf(' 直して ', [])).toStrictEqual({ role: 'user', content: '直して', images: undefined })
    expect(requestBubbleOf('', ['data:image/png;base64,xxx'])).toStrictEqual({
      role: 'user', content: 'この画像について教えてください。', images: ['data:image/png;base64,xxx'],
    })
  })

  it('unexpectedFailureAppends: 依頼がまだ会話に無ければ依頼→失敗の順・依頼があれば失敗だけ・失敗が既にあれば何も足さない', () => {
    const base = { rawText: '直して', images: [] as string[], errorPrefix: '⚠️ ' }
    const failure = unexpectedFailureBubble('⚠️ ')
    expect(unexpectedFailureAppends({ ...base, written: { request: false, failure: false } })).toStrictEqual([
      { kind: 'append', msg: requestBubbleOf('直して', []) },
      { kind: 'append', msg: failure },
    ])
    expect(unexpectedFailureAppends({ ...base, written: { request: true, failure: false } })).toStrictEqual([
      { kind: 'append', msg: failure },
    ])
    expect(unexpectedFailureAppends({ ...base, written: { request: true, failure: true } })).toStrictEqual([])
    expect(failure.content).toBe('⚠️ ' + UNEXPECTED_FAILURE_TEXT)
  })

  it('noteWritten: 依頼（隠しでない user）と失敗（印つき。append も replaceLast も）だけを数える。removeLast・別の吹き出しは数えない', () => {
    const w = { request: false, failure: false }
    noteWritten(w, { kind: 'append', msg: { role: 'assistant', content: '返事' } } as any)
    noteWritten(w, { kind: 'append', msg: { role: 'user', content: '隠し', hidden: true } } as any)
    noteWritten(w, { kind: 'removeLast' })
    noteWritten(w, { kind: 'loading', value: true } as any)
    expect(w).toEqual({ request: false, failure: false })
    noteWritten(w, { kind: 'append', msg: { role: 'user', content: '依頼' } } as any)
    expect(w).toEqual({ request: true, failure: false })
    noteWritten(w, { kind: 'replaceLast', msg: failureBubbleOf('失敗') } as any)
    expect(w).toEqual({ request: true, failure: true })
  })

  it('append と replaceLast を畳んでも、印は吹き出しと一緒に運ばれる（chatEvents.ts は変えていない）', () => {
    const bubble = failureBubbleOf('x')
    const appended = applyToMessages<TurnMessage>([{ role: 'user', content: 'こんにちは' }], { kind: 'append', msg: bubble })
    expect(appended.map(m => m.offerRetry)).toEqual([undefined, true])
    const replaced = applyToMessages<TurnMessage>([{ role: 'user', content: 'こんにちは' }, { role: 'assistant', content: '' }], { kind: 'replaceLast', msg: bubble })
    expect(replaced.map(m => m.offerRetry)).toEqual([undefined, true])
  })
})

// ── B. 振る舞い ───────────────────────────────────────────────────────────
const helpers: TurnHelpers = {
  formatChatError, condenseReasoning, hasTextToolMarkup, stripToolMarkup, unexecutedToolWarning,
  claimsFileChange, unexecutedChangeWarning, stripRepeatedGuidance, isToolArgsComplete, isToolUnsupportedError,
  isImageUnsupportedError, toolStatusLabel, modelLabel, pickBestModel, writingTools: WRITING_TOOLS,
  extractUrls, wantsWebSearch, toolsFor, planSend, planCompact, compactPrompt, acceptSummary, compactSource,
  searchStatusContext,
}

function spec(over: Partial<EngineTurnSpec> = {}): EngineTurnSpec {
  return {
    rawText: 'text.txt を直して', images: [], assetBlock: '', apiKey: 'k', model: 'modelA',
    models: [{ id: 'modelA' }], maxRounds: 5, toolsProjectDir: '/proj', convDir: '/proj',
    errorPrefix: '', twoStageVision: false, routedModel: null, hasRag: false, turnOpts: {},
    snapshotId: 's1', snapshotLabel: 'text.txt を直して', ...over,
  }
}

type Script = {
  content: string
  thinkingDeltas?: string[]
  timedOut?: StreamTimeoutKind
  aborted?: boolean
  toolCalls?: any[] | null
  throwMessage?: string
  /** 推論モデルの思考の本文（本文が空でツール呼び出しも無いとき、本文の代わりに使われる） */
  reasoningText?: string
  /** 応答を待つ間に、別の書き主が会話へ足した吹き出し（画面側の案内など）。流し込みのあと・返る前に入る */
  alsoAppend?: TurnMessage
}
type Cfg = {
  stream: Script[]
  /** 送信の前にあった会話（getHistory の答え）。既定は空 */
  history?: TurnMessage[]
  /** true なら getHistory は、送信の前の会話に、ここまでに出た出来事を畳んだものを足して返す（main の convStore と同じ） */
  live?: boolean
  /** shouldTryDirect の答え（false なら画像を直接渡さない）。既定は true */
  visionDirect?: boolean
  usageAllowed?: boolean
  executeTool?: (name: string, args: string) => string
  /** ツールの一覧を決める 2 か所（shouldSendTools・toolsFor）のどちらかを投げさせる */
  toolsThrow?: 'shouldSendTools' | 'toolsFor'
}

function makePorts(cfg: Cfg) {
  const log: any[] = []
  /** chatStream へ渡された要求の messages（サーバーへ渡る一覧）。呼ばれた順 */
  const requests: { role: string; content: any }[][] = []
  let i = 0
  const ports: EngineTurnPorts = {
    emit: ev => { log.push({ tag: 'emit', ev }) },
    chatStream: async (req, onDelta, onAbortReady, onThinking) => {
      requests.push(req.messages)
      const s = cfg.stream[i++]
      if (!s) throw new Error('stream script exhausted')
      onAbortReady(() => {})
      for (const d of s.thinkingDeltas ?? []) onThinking(d)
      if (s.content) onDelta(s.content)
      if (s.alsoAppend) log.push({ tag: 'emit', ev: { kind: 'append', msg: s.alsoAppend } })
      if (s.throwMessage) throw new Error(s.throwMessage)
      return { usage: null, aborted: s.aborted, timedOut: s.timedOut, toolCalls: s.toolCalls ?? null, reasoningText: s.reasoningText ?? null }
    },
    chatOnce: async () => ({ content: '', usage: null }),
    getHistory: () => cfg.live ? [...(cfg.history ?? []), ...shown(log)] : (cfg.history ?? []),
    buildSystemPrompt: () => 'システム',
    executeTool: async (name, args) => cfg.executeTool ? cfg.executeTool(name, args) : 'ok',
    getSearchConfig: async () => null,
    fetchPagesBlock: async () => '',
    autoSearchBlock: async () => '',
    notifyActivity: () => {},
    setAbort: () => {},
    usage: {
      check: () => cfg.usageAllowed === false ? { allowed: false, message: '今月の上限に達しました' } : { allowed: true },
      record: () => {},
      estimate: t => estimateTokens(t),
    },
    toolSupport: {
      shouldSendTools: () => { if (cfg.toolsThrow === 'shouldSendTools') throw new Error('tool check failed (test)'); return true },
      isKnownToolCapable: () => true,
      record: () => {},
    },
    vision: { shouldTryDirect: () => cfg.visionDirect ?? true, record: () => {}, defaultModel: () => 'vision-model' },
    compactWarnOnce: () => false,
    h: cfg.toolsThrow === 'toolsFor' ? { ...helpers, toolsFor: () => { throw new Error('tools list failed (test)') } } : helpers,
  }
  return { ports, log, requests }
}

/** 出てきた出来事を本物の applyToMessages で畳み、最終的に画面へ残る吹き出しの列を得る。 */
function shown(log: any[]): TurnMessage[] {
  let msgs: TurnMessage[] = []
  for (const e of log) {
    if (e.tag === 'emit' && ['append', 'replaceLast', 'removeLast'].includes(e.ev.kind)) msgs = applyToMessages(msgs, e.ev)
  }
  return msgs
}

/** emit された吹き出し（append・replaceLast）のうち、印の付いたものの一覧 */
const marked = (log: any[]): TurnMessage[] =>
  log.filter(e => e.tag === 'emit' && (e.ev.kind === 'append' || e.ev.kind === 'replaceLast') && e.ev.msg.offerRetry).map(e => e.ev.msg)

const IMG = ['data:image/png;base64,xxx']
const KINDS: StreamTimeoutKind[] = ['first', 'first-silent', 'idle']

describe('B. 印が付く5か所', () => {
  it('★ 1. 想定外の失敗（catch）: 失敗の吹き出しに印・そのあとに attention・結末は true', async () => {
    const { ports, log } = makePorts({ stream: [{ content: '', throwMessage: 'network down' }] })
    const r = await runEngineTurn(spec({ errorPrefix: '⚠️ ' }), ports)
    expect(r).toEqual({ endedWithError: true })
    const bubble = { role: 'assistant', content: '⚠️ ' + formatChatError('network down'), toolNote: true, offerRetry: true }
    const emits = log.filter(e => e.tag === 'emit').map(e => e.ev)
    // 失敗の吹き出し → 見てほしい合図 → 後片づけ、の順（順序を入れ替えると落ちる）
    const at = emits.findIndex(ev => ev.kind === 'append' && ev.msg.offerRetry)
    expect(at).toBeGreaterThan(0)
    expect(emits[at]).toStrictEqual({ kind: 'append', msg: bubble })
    expect(emits[at + 1]).toEqual({ kind: 'attention', value: 'error' })
    expect(emits.slice(at + 2)).toEqual([{ kind: 'loading', value: false }, { kind: 'status', value: '' }])
    // 画面に残るのは、利用者の吹き出しと、印つきの失敗の吹き出し1つずつ
    const msgs = shown(log)
    // （応答を流し込むために足した空の吹き出しは、投げたときに取り除かれる）
    expect(msgs.filter(m => m.offerRetry)).toHaveLength(1)
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[0].offerRetry).toBeUndefined()
    expect(msgs[msgs.length - 1].content).toBe(bubble.content)
  })

  for (const kind of KINDS) {
    it(`★ 2. 応答の時間切れ（${kind}）: 途中までの本文は AI の発言のまま残り、時間切れの文は別の吹き出し（印は1つだけ）`, async () => {
      const { ports, log } = makePorts({ stream: [{ content: 'こんにち', timedOut: kind }] })
      const r = await runEngineTurn(spec(), ports)
      expect(r).toEqual({ endedWithError: false }) // 時間切れは ⚠️ を立てるほどではない（今までどおり）
      const msgs = shown(log)
      expect(msgs.filter(m => m.offerRetry)).toHaveLength(1)
      expect(msgs.map(m => m.role)).toEqual(['user', 'assistant', 'assistant'])
      // 途中までの本文: ふつうの AI の発言（表示専用でも失敗の吹き出しでもない）
      expect(msgs[1]).toMatchObject({ content: 'こんにち' })
      expect(msgs[1].toolNote).toBeUndefined()
      expect(msgs[1].offerRetry).toBeUndefined()
      // 時間切れの文: 失敗の吹き出し（表示専用・本文は混ぜない）
      const last = msgs[msgs.length - 1]
      expect(last.offerRetry).toBe(true)
      expect(last.content).toBe(streamTimeoutMessage(kind))
      expect(last.toolNote).toBe(true) // 表示専用（AIへは送らない）
      expect(last.content).not.toContain('⏹ 停止しました')
    })
  }

  it('★ 2. 本文がまだ無いまま時間切れ: 空の吹き出しを時間切れの文に差し替える（空の assistant は残らない）', async () => {
    const { ports, log } = makePorts({ stream: [{ content: '', timedOut: 'first-silent' }] })
    await runEngineTurn(spec(), ports)
    const msgs = shown(log)
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[1]).toMatchObject({ role: 'assistant', content: streamTimeoutMessage('first-silent'), offerRetry: true, toolNote: true })
  })

  it('★ 2. 打ち切ったあとのテキスト形式のツール呼び出しの除去でも、時間切れの文は別の吹き出しとして残る', async () => {
    const { ports, log } = makePorts({
      stream: [{ content: '前置き<|tool_calls_section_begin|>functions.write_file:0{}<|tool_calls_section_end|>', timedOut: 'idle' }],
    })
    await runEngineTurn(spec(), ports)
    const msgs = shown(log)
    expect(msgs.map(m => m.content)).toEqual(['text.txt を直して', '前置き', streamTimeoutMessage('idle')])
    expect(msgs[2]).toMatchObject({ offerRetry: true, toolNote: true })
    expect(JSON.stringify(msgs)).not.toContain('<|tool_calls_section')
  })

  it('★ 2. 本文がマークアップだけで、除いたら空になった回の時間切れ: 時間切れの文に差し替える', async () => {
    const { ports, log } = makePorts({
      stream: [{ content: '<|tool_calls_section_begin|>functions.write_file:0{}<|tool_calls_section_end|>', timedOut: 'idle' }],
    })
    await runEngineTurn(spec(), ports)
    const msgs = shown(log)
    expect(msgs.map(m => m.content)).toEqual(['text.txt を直して', streamTimeoutMessage('idle')])
    expect(msgs[1].offerRetry).toBe(true)
  })

  it('★ 2. 思考（thinking）を流していた回の時間切れ: 途中の本文の吹き出しに思考が残り、時間切れの文にも印が付く', async () => {
    const { ports, log } = makePorts({ stream: [{ content: 'こんにち', thinkingDeltas: ['考え'], timedOut: 'idle' }] })
    await runEngineTurn(spec(), ports)
    const msgs = shown(log)
    expect(msgs[1]).toMatchObject({ content: 'こんにち', thinking: '考え' })
    expect(msgs[2]).toMatchObject({ offerRetry: true, content: streamTimeoutMessage('idle') })
  })

  it('★ 2. 本文が無く、思考の本文だけが届いた回の時間切れ: 思考を本文に使わず、時間切れの文だけを出す', async () => {
    // 時間切れは理由が分かっている。推論の本文化（本文が空のとき思考を本文にする）をすると、
    // 途中で切れた思考が AI の発言として会話に残ってしまう
    const { ports, log } = makePorts({ stream: [{ content: '', reasoningText: '考えの途中です', timedOut: 'idle' }] })
    await runEngineTurn(spec(), ports)
    const msgs = shown(log)
    expect(msgs.map(m => m.content)).toEqual(['text.txt を直して', streamTimeoutMessage('idle')])
    expect(JSON.stringify(msgs)).not.toContain('考えの途中です')
  })

  it('★ 2. 本文が無く思考だけ流れた回の時間切れ: 時間切れの文の吹き出しが思考を運ぶ', async () => {
    const { ports, log } = makePorts({ stream: [{ content: '', thinkingDeltas: ['考え'], timedOut: 'idle' }] })
    await runEngineTurn(spec(), ports)
    const msgs = shown(log)
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[1]).toMatchObject({ offerRetry: true, thinking: '考え', content: streamTimeoutMessage('idle') })
  })

  it('★ 3. 画像の読み取り（2段構えの1段目）の時間切れ: 時間切れの文に印・次の段へ進まない', async () => {
    const { ports, log } = makePorts({
      visionDirect: false,
      stream: [{ content: '', timedOut: 'first' }, { content: '2段目は呼ばれない' }],
    })
    const r = await runEngineTurn(spec({ images: IMG, twoStageVision: true }), ports)
    expect(r).toEqual({ endedWithError: false })
    const msgs = shown(log)
    expect(marked(log)).toStrictEqual([{ role: 'assistant', content: streamTimeoutMessage('first'), toolNote: true, offerRetry: true }])
    expect(msgs[msgs.length - 1]).toMatchObject({ content: streamTimeoutMessage('first'), offerRetry: true })
    expect(msgs.map(m => m.content).join('\n')).not.toContain('2段目は呼ばれない')
  })

  it('★ 4. 画像の読み取りの失敗（説明が空）: 「読み取りに失敗しました」の吹き出しに印', async () => {
    const { ports, log } = makePorts({ visionDirect: false, stream: [{ content: '' }] })
    const r = await runEngineTurn(spec({ images: IMG, twoStageVision: true }), ports)
    expect(r).toEqual({ endedWithError: false })
    expect(marked(log)).toStrictEqual([
      { role: 'assistant', content: '（画像の読み取りに失敗しました。もう一度お試しください）', toolNote: true, offerRetry: true },
    ])
    expect(shown(log).filter(m => m.offerRetry)).toHaveLength(1)
  })

  describe('★ 5. 画像を文章にする読み取り（ツール呼び出しが本文に出た回）の時間切れ', () => {
    // 画像を直接渡した回答が、テキスト形式のツール呼び出しだった → 画像を文章にして差し替えようとする。
    // その読み取りが時間切れになる。畳んだあとの画面（会話の記録と同じ並び）を見る。
    const MARKUP = '<|tool_calls_section_begin|>functions.write_file:0{}<|tool_calls_section_end|>'

    it('本文が空のまま: 時間切れの文が空の吹き出しに差し替わって残る（印つき・上書きされない・空の assistant なし）', async () => {
      const { ports, log, requests } = makePorts({
        stream: [{ content: MARKUP }, { content: '', timedOut: 'first' }, { content: '続きは呼ばれない' }],
      })
      const r = await runEngineTurn(spec({ images: IMG }), ports)
      expect(r).toEqual({ endedWithError: false })
      expect(marked(log)).toStrictEqual([
        { role: 'assistant', toolNote: true, content: streamTimeoutMessage('first'), offerRetry: true },
      ])
      const msgs = shown(log)
      expect(msgs.map(m => m.role)).toEqual(['user', 'assistant'])
      expect(msgs[1]).toMatchObject({ role: 'assistant', toolNote: true, content: streamTimeoutMessage('first'), offerRetry: true })
      // 「このモデルはツール…対応していません」などの文に上書きされない・空の assistant も残らない
      expect(JSON.stringify(msgs)).not.toContain('対応していません')
      expect(msgs.filter(m => m.role === 'assistant' && !(m.content ?? '').trim())).toEqual([])
      // 時間切れでは次の周へ進まない（画像の読み取り＋最初の1回だけ）
      expect(requests).toHaveLength(2)
    })

    it('前置きの本文があるとき: 本文はそのまま残り、その後ろに時間切れの文（本文を上書きしない）', async () => {
      const { ports, log } = makePorts({
        stream: [{ content: '直します。' + MARKUP }, { content: '', timedOut: 'first' }, { content: '続きは呼ばれない' }],
      })
      await runEngineTurn(spec({ images: IMG }), ports)
      const msgs = shown(log)
      expect(msgs.map(m => m.content)).toEqual(['text.txt を直して', '直します。', streamTimeoutMessage('first')])
      expect(msgs.map(m => !!m.offerRetry)).toEqual([false, false, true])
      expect(msgs[1].toolNote).toBeUndefined() // 本文は AI の発言のまま
    })

    it('時間切れでない失敗（説明が空）は、これまでどおり「ツール非対応」の文に差し替わる（印つき）', async () => {
      const { ports, log } = makePorts({
        stream: [{ content: MARKUP }, { content: '' }],
      })
      await runEngineTurn(spec({ images: IMG }), ports)
      const msgs = shown(log)
      expect(msgs.map(m => m.role)).toEqual(['user', 'assistant'])
      expect(msgs[1].content).toContain('対応していません')
      expect(msgs[1]).toMatchObject({ offerRetry: true, toolNote: true })
    })
  })
})

describe('B. 印が付かない出口', () => {
  const noMark = (log: any[]) => expect(marked(log)).toEqual([])

  it('正常に終わった回には付かない', async () => {
    const { ports, log } = makePorts({ stream: [{ content: 'できました' }] })
    await runEngineTurn(spec(), ports)
    noMark(log)
    expect(shown(log).map(m => m.content)).toEqual(['text.txt を直して', 'できました'])
  })

  it('🛑 上限に達した案内には付かない（案内であって失敗ではない）', async () => {
    const { ports, log } = makePorts({ usageAllowed: false, stream: [] })
    const r = await runEngineTurn(spec(), ports)
    expect(r).toEqual({ endedWithError: false })
    expect(shown(log).map(m => m.content)).toEqual(['text.txt を直して', '🛑 今月の上限に達しました'])
    noMark(log)
  })

  it('ツールが失敗した注記には付かない', async () => {
    const { ports, log } = makePorts({
      stream: [
        { content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'b.txt', content: 'x' }) } }] },
        { content: 'ご確認ください' },
      ],
      executeTool: () => 'エラー: 保存できませんでした',
    })
    await runEngineTurn(spec(), ports)
    const note = unexecutedToolsNote([toolActionName('write_file', JSON.stringify({ path: 'b.txt', content: 'x' }))])
    expect(shown(log).map(m => m.content ?? '').join('\n')).toContain(note)
    noMark(log)
  })

  it('⏹ 停止には付かない（自分で止めたのは失敗ではない）', async () => {
    const { ports, log } = makePorts({ stream: [{ content: 'こんにち', aborted: true }] })
    await runEngineTurn(spec(), ports)
    expect(shown(log).pop()!.content).toContain('⏹ 停止しました')
    noMark(log)
  })

  it('作業の区切り（続ける）の案内には付かない', async () => {
    const call = (id: string) => ({ id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `${id}.txt` }) } })
    const { ports, log } = makePorts({ stream: [{ content: '', toolCalls: [call('a')] }, { content: '', toolCalls: [call('b')] }] })
    await runEngineTurn(spec({ maxRounds: 1 }), ports)
    expect(shown(log).pop()).toMatchObject({ offerContinue: true })
    noMark(log)
  })
})

// ── C. 配線 ───────────────────────────────────────────────────────────────
const readCode = (rel: string): string =>
  fs.readFileSync(path.join(ROOT, rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => { const t = line.trim(); return !t.startsWith('//') && !t.startsWith('*') })
    .join('\n')

function typeBlock(code: string, name: string): string {
  const start = code.indexOf(`export type ${name} = {`)
  expect(start, `${name} の宣言`).toBeGreaterThanOrEqual(0)
  return code.slice(start, code.indexOf('\n}\n', start))
}

describe('C. 配線', () => {
  const turn = readCode('src/shared/chatTurn.ts')

  it('失敗の吹き出しの出口は、すべて failureBubbleOf を通る（呼び出しの形ごと）', () => {
    expect(turn).toContain("ports.emit({ kind: 'append', msg: failureBubbleOf(errorPrefix + ports.h.formatChatError(err?.message ?? String(err), 'sakura', err)) })")
    expect(turn).toContain("ports.emit({ kind: attemptIsEmpty ? 'replaceLast' : 'append', msg: failureBubbleOf(streamTimeoutMessage(timedOut)) })")
    expect(turn).toContain("ports.emit({ kind: 'replaceLast', msg: failureBubbleOf(streamTimeoutMessage(visionTimedOut)) })")
    expect(turn).toContain("ports.emit({ kind: 'replaceLast', msg: failureBubbleOf('（画像の読み取りに失敗しました。もう一度お試しください）') })")
    // 応答の時間切れ: 途中の本文があれば後ろに足し、無ければ空の吹き出しを差し替える（本文に時間切れの文を混ぜない）
    expect(turn).toContain(
      "ports.emit(acc.trim()\n          ? { kind: 'append', msg: failureBubbleOf(timeoutNote) }\n"
      + "          : { kind: 'replaceLast', msg: failureBubbleOf(timeoutNote, { thinking: thinkingAcc || undefined }) })",
    )
    expect(turn.split('failureBubbleOf(timeoutNote')).toHaveLength(3)
    // 「応答が空」「ツール非対応」の文（利用者に「もう一度」を勧める）も同じ道
    expect(turn).toContain("msg: failureBubbleOf(sawToolMarkup\n")
    expect(turn).toContain(": '（応答が空でした。もう一度送るか、モデルを変えてお試しください）'),")
  })

  it('直す前の手組みの形は戻らない', () => {
    expect(turn).not.toContain("msg: { role: 'assistant', content: errorPrefix")
    expect(turn).not.toContain("msg: { role: 'assistant', toolNote: true, content: streamTimeoutMessage(")
    expect(turn).not.toContain("msg: { role: 'assistant', content: streamTimeoutMessage(")
    expect(turn).not.toContain("msg: { role: 'assistant', content: '（画像の読み取りに失敗しました")
    // 表示専用は failureBubbleOf が付ける。呼び出し側が付け外しする形は無い
    expect(turn).not.toContain('failureBubbleOf(streamTimeoutMessage(timedOut), { toolNote: true })')
    // 時間切れの文を途中の本文に足して1つの吹き出しにする形（AI の本文ごと表示専用になる）は戻らない
    expect(turn).not.toContain("acc += (acc ? '\\n\\n' : '') + streamTimeoutMessage(timedOut)")
    expect(turn).not.toContain('lastBubble')
    expect(turn).not.toContain('failureBubbleOf(acc')
    // 「応答が空」「ツール非対応」の文を手組みの吹き出しで出す形は戻らない
    expect(turn).not.toContain("role: 'assistant', content: sawToolMarkup")
  })

  it('印 offerRetry を付けるのは chatFailure.ts の1か所だけ', () => {
    const walk = (rel: string, out: string[] = []): string[] => {
      for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
        const r = `${rel}/${e.name}`
        if (e.isDirectory()) walk(r, out)
        else if (/\.(ts|tsx)$/.test(e.name)) out.push(r)
      }
      return out
    }
    const files = walk('src').filter(f => /offerRetry\s*:\s*true/.test(readCode(f)))
    expect(files).toEqual(['src/shared/chatFailure.ts'])
  })

  it('吹き出しの型 TurnMessage に offerRetry?: true がある', () => {
    expect(typeBlock(turn, 'TurnMessage')).toContain('offerRetry?: true')
  })

  it('吹き出しを組む部分は新しい部品（400行以下）に出ている', () => {
    const lines = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8').split('\n').length
    expect(lines('src/shared/chatFailure.ts')).toBeLessThanOrEqual(400)
    expect(turn).toContain("import { failureBubbleOf, undoEmptyBubble, requestTextOf, requestBubbleOf } from './chatFailure'")
  })
})

// ── D. AI の履歴から外す ──────────────────────────────────────────────────
// 失敗の吹き出しは利用者に見せるもので、AI の発言ではない。次の送信に混ぜない。
// 応答を流し込むために足した空の吹き出しも、投げたまま残さない（空の assistant を送らない）。
describe('D. 失敗の吹き出しを AI の履歴から外す', () => {
  const emitsOf = (log: any[]) => log.filter(e => e.tag === 'emit').map(e => e.ev)
  const removeLasts = (log: any[]) => emitsOf(log).filter(ev => ev.kind === 'removeLast')
  /** サーバーへ渡った一覧のうち、中身が空の assistant */
  const emptyAssistants = (msgs: { role: string; content: any }[]) =>
    msgs.filter(m => m.role === 'assistant' && !String(m.content ?? '').trim())

  it('送信の入口 planSend に、失敗の吹き出し（どの出口のものも）が出ない', () => {
    const history: TurnMessage[] = [
      { role: 'user', content: '依頼1' },
      { role: 'assistant', content: '返事1' },
      { role: 'user', content: '依頼2' },
      failureBubbleOf('⚠️ 通信に失敗しました'),
      failureBubbleOf('こんにち\n\n' + streamTimeoutMessage('idle'), { thinking: '考え' }),
      failureBubbleOf('（画像の読み取りに失敗しました。もう一度お試しください）'),
      unexpectedFailureBubble('⚠️ '),
      { role: 'user', content: '依頼3' },
    ]
    expect(planSend(history)).toStrictEqual([
      { role: 'user', content: '依頼1' },
      { role: 'assistant', content: '返事1' },
      { role: 'user', content: '依頼2' },
      { role: 'user', content: '依頼3' },
    ])
  })

  it('失敗した回のあとの次の送信で、サーバーへ渡る一覧に失敗の文も空の assistant も入らない', async () => {
    const first = makePorts({ stream: [{ content: '', throwMessage: 'network down' }] })
    await runEngineTurn(spec({ errorPrefix: '⚠️ ' }), first.ports)
    const saved = shown(first.log)
    expect(saved.some(m => m.offerRetry)).toBe(true) // 失敗の吹き出しは会話に残る（表示のため）

    const second = makePorts({ history: saved, stream: [{ content: 'できました' }] })
    await runEngineTurn(spec({ rawText: 'もう一度お願い' }), second.ports)
    expect(second.requests).toHaveLength(1)
    const sent = second.requests[0]
    expect(sent.map(m => m.role)).toEqual(['system', 'user', 'user'])
    expect(sent[1].content).toBe('text.txt を直して')
    expect(JSON.stringify(sent)).not.toContain(formatChatError('network down'))
    expect(emptyAssistants(sent)).toEqual([])
  })

  it('応答の時間切れのあとの次の送信: 途中まで届いた本文は AI の発言として渡り、時間切れの文は渡らない', async () => {
    const first = makePorts({ stream: [{ content: 'こんにち', timedOut: 'idle' }] })
    await runEngineTurn(spec(), first.ports)
    const saved = shown(first.log)
    expect(saved[saved.length - 1]).toMatchObject({ offerRetry: true, toolNote: true })

    const second = makePorts({ history: saved, stream: [{ content: 'できました' }] })
    await runEngineTurn(spec({ rawText: 'もう一度お願い' }), second.ports)
    const sent = second.requests[0]
    expect(sent.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(sent[1].content).toBe('text.txt を直して') // 利用者の依頼は残る
    expect(sent[2].content).toBe('こんにち') // 途中までの本文は AI が書いたもの（続きを頼まれても分かる）
    expect(JSON.stringify(sent)).not.toContain(streamTimeoutMessage('idle'))
  })

  it('本文が無いまま時間切れだった回のあとの次の送信: AI へ渡るのは利用者の依頼だけ', async () => {
    const first = makePorts({ stream: [{ content: '', timedOut: 'first-silent' }] })
    await runEngineTurn(spec(), first.ports)
    const second = makePorts({ history: shown(first.log), stream: [{ content: 'できました' }] })
    await runEngineTurn(spec({ rawText: 'もう一度お願い' }), second.ports)
    const sent = second.requests[0]
    expect(sent.map(m => m.role)).toEqual(['system', 'user', 'user'])
    expect(JSON.stringify(sent)).not.toContain(streamTimeoutMessage('first-silent'))
    expect(emptyAssistants(sent)).toEqual([])
  })

  it('投げて中身が空: 足しておいた空の吹き出しを取り除いてから失敗の吹き出しを出す（順序つき）', async () => {
    const { ports, log } = makePorts({ stream: [{ content: '', throwMessage: 'network down' }] })
    await runEngineTurn(spec({ errorPrefix: '⚠️ ' }), ports)
    const emits = emitsOf(log)
    const at = emits.findIndex(ev => ev.kind === 'append' && ev.msg.role === 'assistant' && ev.msg.content === '')
    expect(at).toBeGreaterThan(-1)
    expect(emits.slice(at, at + 4)).toStrictEqual([
      { kind: 'append', msg: { role: 'assistant', content: '' } },
      { kind: 'removeLast' },
      { kind: 'append', msg: failureBubbleOf('⚠️ ' + formatChatError('network down')) },
      { kind: 'attention', value: 'error' },
    ])
    expect(removeLasts(log)).toHaveLength(1)
    // 畳んだあとの画面（会話の記録と同じ並び）に、空の assistant は残らない
    const msgs = shown(log)
    expect(emptyAssistants(msgs)).toEqual([])
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[1]).toMatchObject({ offerRetry: true, toolNote: true })
  })

  it('投げて中身が空白だけ: 空とみなして取り除く', async () => {
    const { ports, log } = makePorts({ stream: [{ content: ' \n', throwMessage: 'network down' }] })
    await runEngineTurn(spec(), ports)
    expect(removeLasts(log)).toHaveLength(1)
    expect(emptyAssistants(shown(log))).toEqual([])
    expect(shown(log).map(m => m.role)).toEqual(['user', 'assistant'])
  })

  it('途中まで届いてから投げた: 届いた本文の吹き出しは取り除かず、そのあとに失敗の吹き出しを出す', async () => {
    const { ports, log } = makePorts({ stream: [{ content: 'こんにち', throwMessage: 'network down' }] })
    await runEngineTurn(spec({ errorPrefix: '⚠️ ' }), ports)
    expect(removeLasts(log)).toEqual([])
    const msgs = shown(log)
    expect(msgs.map(m => m.content)).toEqual(['text.txt を直して', 'こんにち', '⚠️ ' + formatChatError('network down')])
    expect(msgs.map(m => !!m.offerRetry)).toEqual([false, false, true])
  })

  it('ツール非対応の 400 → 再試行: 取り除くのは空の試行1つだけ（利用者の吹き出しは消えない）', async () => {
    const { ports, log } = makePorts({
      stream: [{ content: '', throwMessage: 'enable auto tool choice' }, { content: '通常の返事です' }],
    })
    await runEngineTurn(spec(), ports)
    expect(removeLasts(log)).toHaveLength(1)
    const msgs = shown(log)
    expect(msgs.map(m => m.content)).toEqual(['text.txt を直して', '通常の返事です'])
    expect(marked(log)).toEqual([])
  })

  it('画像を受け取れない → 視覚モデルへ: 取り除くのは空の試行1つだけ（利用者の吹き出しは消えない）', async () => {
    const { ports, log } = makePorts({
      stream: [{ content: '', throwMessage: 'image_url is not supported' }, { content: '読み取れました' }],
    })
    await runEngineTurn(spec({ images: IMG }), ports)
    expect(removeLasts(log)).toHaveLength(1)
    const msgs = shown(log)
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(msgs[0]).toMatchObject({ role: 'user', content: 'text.txt を直して', images: IMG })
    expect(msgs[1].content).toContain('画像を受け取れませんでした')
    expect(msgs[2].content).toBe('読み取れました')
  })

  it('再試行も投げた: 試行ごとに空の吹き出しを1つずつ取り除き、失敗の吹き出しだけが残る', async () => {
    const { ports, log } = makePorts({
      stream: [{ content: '', throwMessage: 'enable auto tool choice' }, { content: '', throwMessage: 'network down' }],
    })
    await runEngineTurn(spec({ errorPrefix: '⚠️ ' }), ports)
    expect(removeLasts(log)).toHaveLength(2)
    const msgs = shown(log)
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[0].content).toBe('text.txt を直して')
    expect(msgs[1]).toMatchObject({ offerRetry: true, content: '⚠️ ' + formatChatError('network down') })
  })

  it('ツールを使った2周目で投げた: 2周目の空の吹き出しだけを取り除く（1周目の実況は残る）', async () => {
    const { ports, log } = makePorts({
      stream: [
        { content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) } }] },
        { content: '', throwMessage: 'network down' },
      ],
    })
    await runEngineTurn(spec({ errorPrefix: '⚠️ ' }), ports)
    expect(removeLasts(log)).toHaveLength(1)
    const msgs = shown(log)
    expect(emptyAssistants(msgs)).toEqual([])
    expect(msgs[0]).toMatchObject({ role: 'user', content: 'text.txt を直して' })
    expect(msgs[msgs.length - 1]).toMatchObject({ offerRetry: true, content: '⚠️ ' + formatChatError('network down') })
  })
})

describe('D. 配線', () => {
  const turn = readCode('src/shared/chatTurn.ts')
  const failure = readCode('src/shared/chatFailure.ts')

  it('streamOnce は chatStream が投げたとき undoEmptyBubble の判断で取り除く（呼び出しの形ごと）', () => {
    expect(turn).toContain('const undo = undoEmptyBubble(acc, await ports.getHistory())\n          if (undo) ports.emit(undo)')
    expect(turn.split('undoEmptyBubble(')).toHaveLength(2) // 判断を呼ぶのはここ1か所
    // 後片づけが投げても、元の失敗を隠さない（catch の中の try で受けて、必ず元の失敗を投げ直す）
    expect(turn).toMatch(/\} catch \{\s*\}\s*throw err/)
    expect(turn).not.toContain(').catch((err) => { const undo = undoEmptyBubble(acc); if (undo) ports.emit(undo); throw err })')
  })

  it('再試行の2か所は、投げた試行を自分では消さない（streamOnce が消すので二重に消えない）', () => {
    // （readCode はブロックコメント /* noTools */ も落とすので、引数の間は空白が2つ並ぶ）
    expect(turn).toContain("retriedNoTools = true\n          r = await streamOnce(apiMessages,  true)")
    expect(turn).toContain("triedVisionFallback = true\n          const fallback = await ports.vision.defaultModel()")
    expect(turn).not.toContain("retriedNoTools = true\n          ports.emit({ kind: 'removeLast' })")
    expect(turn).not.toContain("triedVisionFallback = true\n          ports.emit({ kind: 'removeLast' })")
  })

  it('失敗の吹き出しの表示専用は failureBubbleOf の中で必ず付く（型でも必須）', () => {
    expect(typeBlock(failure, 'FailureBubble')).toContain('toolNote: true')
    expect(typeBlock(failure, 'FailureBubble')).not.toContain('toolNote?:')
    expect(failure).toContain('toolNote: true,\n    ...(opts.thinking')
  })

  it('AI へ履歴を送る入口は planSend の1つ。bodyMessages を使うのは historyCompact.ts だけ', () => {
    expect(turn.split('ports.h.planSend(')).toHaveLength(2)
    const walk = (rel: string, out: string[] = []): string[] => {
      for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
        const r = `${rel}/${e.name}`
        if (e.isDirectory()) walk(r, out)
        else if (/\.(ts|tsx)$/.test(e.name)) out.push(r)
      }
      return out
    }
    const users = walk('src').filter(f => /\bbodyMessages\(/.test(readCode(f)))
    expect(users).toEqual(['src/shared/historyCompact.ts'])
    // 送信対象から外す条件は toolNote（表示専用）。ここが変わると失敗の吹き出しが履歴に戻る
    expect(readCode('src/shared/historyCompact.ts')).toContain('.filter(m => !!m && !m.toolNote && !m.summary)')
  })
})

// ── E. 検分の直し ─────────────────────────────────────────────────────────
describe('E. ツールの一覧を決める段で投げた回に、空の吹き出しを残さない', () => {
  for (const where of ['shouldSendTools', 'toolsFor'] as const) {
    it(`★ ${where} が投げた: 空の assistant を足す前に投げるので、会話には依頼と失敗の吹き出しだけが残る`, async () => {
      const { ports, log, requests } = makePorts({ toolsThrow: where, stream: [{ content: '呼ばれない' }] })
      const r = await runEngineTurn(spec({ errorPrefix: '⚠️ ' }), ports)
      expect(r).toEqual({ endedWithError: true })
      expect(requests).toHaveLength(0) // 通信までは進まない
      const msgs = shown(log)
      expect(msgs.map(m => m.role)).toEqual(['user', 'assistant'])
      expect(msgs[1]).toMatchObject({ offerRetry: true, toolNote: true })
      // 足してもいない吹き出しを取り除く出来事は出ない（利用者の吹き出しを消さない）
      expect(log.filter(e => e.tag === 'emit' && e.ev.kind === 'removeLast')).toEqual([])
      expect(log.filter(e => e.tag === 'emit' && e.ev.kind === 'append' && e.ev.msg.role === 'assistant' && e.ev.msg.content === '')).toEqual([])
      // 次の送信でサーバーへ渡る一覧にも、空の assistant は入らない
      const second = makePorts({ history: msgs, stream: [{ content: 'できました' }] })
      await runEngineTurn(spec({ rawText: 'もう一度お願い' }), second.ports)
      expect(emptyAssistantsOf(second.requests[0])).toEqual([])
    })
  }

  it('配線: ツールの一覧は吹き出しを足す前に決める（chatStream の引数の中で決める形は戻らない）', () => {
    const turn = readCode('src/shared/chatTurn.ts')
    const at = turn.indexOf('const streamOnce = async')
    const end = turn.indexOf('// ── まとめ等の system 行は', at)
    const body = turn.slice(at, end > 0 ? end : at + 6000)
    const toolsAt = body.indexOf('const tools = (!noTools && (await ports.toolSupport.shouldSendTools(useModel))) ? ports.h.toolsFor(toolsProjectDir, !!search, hasRag) : undefined')
    const appendAt = body.indexOf("ports.emit({ kind: 'append', msg: { role: 'assistant', content: '' } })")
    expect(toolsAt).toBeGreaterThan(-1)
    expect(appendAt).toBeGreaterThan(toolsAt)
    expect(body).toContain('maxTokens: 16384, tools },')
    expect(body).not.toContain('tools: (!noTools')
  })
})

const emptyAssistantsOf = (msgs: { role: string; content: any }[]) =>
  msgs.filter(m => m.role === 'assistant' && !String(m.content ?? '').trim())

describe('E. 「もう一度」を勧める失敗の文は、失敗の吹き出し（印つき・表示専用）で出る', () => {
  it('★ 応答が空のまま終わった: 「応答が空でした」の文に印・表示専用。空の assistant は残らない', async () => {
    const { ports, log } = makePorts({ stream: [{ content: '' }, { content: '' }] })
    const r = await runEngineTurn(spec(), ports)
    expect(r).toEqual({ endedWithError: false })
    const msgs = shown(log)
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[1]).toMatchObject({
      role: 'assistant', toolNote: true, offerRetry: true,
      content: '（応答が空でした。もう一度送るか、モデルを変えてお試しください）',
    })
    expect(marked(log)).toHaveLength(1)
  })

  it('★ ツール呼び出しのマークアップだけが返り、切替先も無い: 「ツール非対応」の文に印・表示専用', async () => {
    const MARKUP = '<|tool_calls_section_begin|>functions.write_file:0{}<|tool_calls_section_end|>'
    const { ports, log } = makePorts({ stream: [{ content: MARKUP }] })
    await runEngineTurn(spec({ models: [{ id: 'modelA' }] }), ports)
    const msgs = shown(log)
    expect(msgs[msgs.length - 1].content).toContain('対応していません')
    expect(msgs[msgs.length - 1]).toMatchObject({ role: 'assistant', toolNote: true, offerRetry: true })
    expect(emptyAssistantsOf(msgs as any)).toEqual([])
  })

  it('AI へは渡らない: 次の送信のサーバーへの一覧に、この文は入らない', async () => {
    const first = makePorts({ stream: [{ content: '' }, { content: '' }] })
    await runEngineTurn(spec(), first.ports)
    const second = makePorts({ history: shown(first.log), stream: [{ content: 'できました' }] })
    await runEngineTurn(spec({ rawText: 'もう一度お願い' }), second.ports)
    const sent = JSON.stringify(second.requests[0])
    expect(sent).not.toContain('応答が空でした')
  })
})

describe('E. 失敗の吹き出しは、まとめの材料（compactSource）に入らない', () => {
  it('★ 時間切れの文が AI の操作の記録として混ざらない。ふつうの実況の吹き出しは材料に入る', () => {
    const work = { role: 'assistant', content: '✏️ a.txt を保存しています…', toolNote: true }
    // 失敗の吹き出しの行頭が ✏️ / ⚡ でも、操作の記録ではない
    const failure = failureBubbleOf('✏️ 変更点\n⚡ ポイント\n' + streamTimeoutMessage('idle'))
    const msgs: TurnMessage[] = [
      { role: 'user', content: '依頼' },
      work,
      failure,
      { role: 'assistant', content: '返事' },
    ]
    const src = compactSource(msgs, 0, 10)
    expect(src).toContain(work)
    expect(src).not.toContain(failure)
    expect(src.map(m => m.content)).toEqual(['依頼', '✏️ a.txt を保存しています…', '返事'])
  })
})

describe('E. 後片づけで投げても元の失敗を隠さない・待つ間に足された吹き出しを消さない', () => {
  it('★ 空の吹き出しを取り除く出来事を出す側が投げても、利用者に見せるのは元の失敗', async () => {
    const { ports, log } = makePorts({ stream: [{ content: '', throwMessage: 'network down' }] })
    const emit = ports.emit
    ports.emit = ev => {
      if (ev.kind === 'removeLast') throw new Error('Render frame was disposed (test)')
      emit(ev)
    }
    const r = await runEngineTurn(spec({ errorPrefix: '⚠️ ' }), ports)
    expect(r).toEqual({ endedWithError: true })
    const failure = shown(log).find(m => m.offerRetry)!
    expect(failure.content).toBe('⚠️ ' + formatChatError('network down'))
    expect(failure.content).not.toContain('Render frame')
  })

  it('★ 待つ間に別の書き主が吹き出しを足していた: その吹き出しを消さない（空の assistant は残るが AI へは渡らない）', async () => {
    const notice: TurnMessage = { role: 'assistant', content: '公開先を AppRun に変えました', offerTargetCheck: true }
    const prior: TurnMessage[] = [{ role: 'user', content: '前の依頼' }, { role: 'assistant', content: '前の返事' }]
    const { ports, log } = makePorts({
      history: prior, live: true,
      stream: [{ content: '', throwMessage: 'network down', alsoAppend: notice }],
    })
    // 実際の会話は「送信の前の会話＋ここまでの出来事」なので、出来事は畳んで見る
    await runEngineTurn(spec({ errorPrefix: '⚠️ ' }), ports)
    expect(removeLastCount(log)).toBe(0) // 取り除く出来事を出さない
    const record = [...prior, ...shown(log)]
    expect(record.some(m => m.offerTargetCheck)).toBe(true) // 案内は消えない
    expect(record.filter(m => m.offerRetry)).toHaveLength(1)
    // 空の assistant が残っていても、次の送信でサーバーへ渡る一覧には入らない
    expect(emptyAssistantsOf(record as any).length).toBe(1)
    const second = makePorts({ history: record, stream: [{ content: 'できました' }] })
    await runEngineTurn(spec({ rawText: 'もう一度お願い' }), second.ports)
    expect(emptyAssistantsOf(second.requests[0])).toEqual([])
  })

  it('待つ間に何も足されなければ、これまでどおり空の吹き出しを取り除く（会話を読める回でも）', async () => {
    const prior: TurnMessage[] = [{ role: 'user', content: '前の依頼' }, { role: 'assistant', content: '前の返事' }]
    const { ports, log } = makePorts({ history: prior, live: true, stream: [{ content: '', throwMessage: 'network down' }] })
    await runEngineTurn(spec({ errorPrefix: '⚠️ ' }), ports)
    expect(removeLastCount(log)).toBe(1)
    expect(emptyAssistantsOf(shown(log) as any)).toEqual([])
  })
})

const removeLastCount = (log: any[]) => log.filter(e => e.tag === 'emit' && e.ev.kind === 'removeLast').length

describe('E. 送信の入口 planSend は、中身が空の assistant を AI へ渡さない', () => {
  it('★ 取り除きそこねたもの・古い版が会話に残したものも止める。ほかの吹き出しは変えない', () => {
    const history: TurnMessage[] = [
      { role: 'user', content: '依頼1' },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: ' \n' },
      { role: 'assistant', content: '返事1' },
      { role: 'user', content: '依頼2' },
    ]
    expect(planSend(history)).toStrictEqual([
      { role: 'user', content: '依頼1' },
      { role: 'assistant', content: '返事1' },
      { role: 'user', content: '依頼2' },
    ])
  })

  it('空の user は止めない（止めるのは assistant の空だけ）', () => {
    expect(planSend([{ role: 'user', content: '' }, { role: 'assistant', content: '返事' }]))
      .toStrictEqual([{ role: 'user', content: '' }, { role: 'assistant', content: '返事' }])
  })
})
