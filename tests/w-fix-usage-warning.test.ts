// tests/w-fix-usage-warning.test.ts — W-21: 「上限に達したら止める」をオフにしていても、上限を超えたら作業中に警告する。
//
// 設定画面（SettingsModal.tsx）は「オフの場合は止めず、上限を超えたら作業中にも知らせます」と約束している。
// 判定の純関数（shared/usageBudget.ts の checkBeforeRequestOf）は warning を返していたが、
//   main/chat/turnRunner.ts の usage.check → main/usageStore.ts の checkBeforeRequest（型が warning を落としていた）
//   → shared/chatTurn.ts の runEngineTurn（warning を見ていなかった）
// と通るうちに消えて、画面には出なかった。ここでは**振る舞い**で固定する（ソース文字列ではなく、
// 偽の ports ＋ 本物の usageStore で runEngineTurn を駆動して、画面に残るメッセージ列で確かめる）。
//
// 固定するもの:
//   1. enforce=false・上限超え → 送信は止めない・警告の吹き出しが出る（利用者の吹き出しのあと・表示専用）
//   2. 上限内 → 出ない
//   3. enforce=true・上限超え → 止める（従来どおり 🛑）。警告の吹き出しは出さない
//   4. 同じ会話では1度だけ（会話・キー・月が変われば出る）
//   5. 警告の吹き出しは AI へ送らない
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  runEngineTurn, resetUsageWarnedForTest,
  type EngineTurnSpec, type EngineTurnPorts, type TurnMessage, type TurnHelpers, type UsageCheckResult,
} from '../src/shared/chatTurn'
import { applyToMessages } from '../src/shared/chatEvents'
import {
  initUsageStore, checkBeforeRequest, recordUsage, setSettings, flushUsageNow, setUsageListener,
} from '../src/main/usageStore'
import { hashKey, PRICING, DEFAULT_SETTINGS } from '../src/shared/usageBudget'

// 本物の純粋関数（tests/chatTurn.test.ts と同じ組み立て）
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

const h: TurnHelpers = {
  formatChatError, condenseReasoning, hasTextToolMarkup, stripToolMarkup, unexecutedToolWarning,
  claimsFileChange, unexecutedChangeWarning, stripRepeatedGuidance, isToolArgsComplete, isToolUnsupportedError,
  isImageUnsupportedError, toolStatusLabel, modelLabel, pickBestModel, writingTools: WRITING_TOOLS,
  extractUrls, wantsWebSearch, toolsFor, planSend, planCompact, compactPrompt, acceptSummary, compactSource,
  searchStatusContext,
}

const KEY_A = 'sk-w21-aaaaaaaaaaaaaaaa'
const KEY_B = 'sk-w21-bbbbbbbbbbbbbbbb'
const MODEL = Object.keys(PRICING)[0]
const WARN_MARK = '止める設定ではないため、このまま続けられます'

type Harness = {
  ports: EngineTurnPorts
  emitted: any[]
  streamRequests: any[]
  /** 画面に残るメッセージ列（本物の applyToMessages で畳む）。previous を渡すと続きから畳む。 */
  replay(previous?: TurnMessage[]): TurnMessage[]
}

/** usage.check を差し替えられる偽 ports（送信ができたかは streamRequests の件数で見る）。 */
function makeHarness(check: () => UsageCheckResult, history: TurnMessage[] = []): Harness {
  const emitted: any[] = []
  const streamRequests: any[] = []
  const ports: EngineTurnPorts = {
    emit: (ev) => { emitted.push(ev) },
    chatStream: async (req, onDelta, onAbortReady) => {
      streamRequests.push(req)
      onAbortReady(() => {})
      onDelta('お返事です')
      return { usage: { prompt_tokens: 1, completion_tokens: 1 }, toolCalls: null }
    },
    chatOnce: async () => ({ content: '', usage: null }),
    getHistory: () => history,
    buildSystemPrompt: () => 'システム',
    executeTool: async () => 'ok',
    getSearchConfig: async () => null,
    fetchPagesBlock: async () => '',
    autoSearchBlock: async () => '',
    notifyActivity: () => {},
    setAbort: () => {},
    usage: {
      check,
      record: () => {},
      estimate: (text) => estimateTokens(text),
    },
    toolSupport: { shouldSendTools: () => true, isKnownToolCapable: () => false, record: () => {} },
    vision: { shouldTryDirect: () => true, record: () => {}, defaultModel: () => 'vision-model' },
    compactWarnOnce: () => false,
    h,
  }
  return {
    ports, emitted, streamRequests,
    replay: (previous = []) => emitted
      .filter((e) => e.kind === 'append' || e.kind === 'replaceLast' || e.kind === 'removeLast')
      .reduce((msgs: TurnMessage[], e) => applyToMessages(msgs, e), previous),
  }
}

function makeSpec(overrides: Partial<EngineTurnSpec> = {}): EngineTurnSpec {
  return {
    rawText: 'こんにちは', images: [], assetBlock: '', apiKey: KEY_A, model: 'modelA',
    models: [{ id: 'modelA' }], maxRounds: 5, toolsProjectDir: null, convDir: '/conv/one',
    errorPrefix: '', twoStageVision: false, routedModel: null, hasRag: false, turnOpts: {},
    snapshotId: 'snap-1', snapshotLabel: 'こんにちは', ...overrides,
  }
}

/** turnRunner.ts と同じ配線: usage.check = checkBeforeRequest(hashKey(apiKey))（main の本物の usageStore）。 */
const realCheck = (apiKey: string) => () => checkBeforeRequest(hashKey(apiKey))

const warningBubbles = (msgs: TurnMessage[]) => msgs.filter((m) => m.role === 'assistant' && m.content.includes(WARN_MARK))

let tmpDirs: string[] = []
beforeEach(() => {
  tmpDirs = []
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-w-fix-usage-warning-'))
  tmpDirs.push(dir)
  initUsageStore(dir) // メモリをリセットし、以後この一時フォルダへ read/write する
  resetUsageWarnedForTest()
})
afterEach(() => {
  vi.useRealTimers()
  flushUsageNow()
  setUsageListener(null)
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})

/** キーA・キーBの両方を、月の上限（¥1）を超えた状態にする。 */
function overLimit(enforce: boolean): void {
  setSettings({ ...DEFAULT_SETTINGS, enforce, monthlyLimitYen: 1 })
  recordUsage(hashKey(KEY_A), MODEL, 100_000_000, 0)
  recordUsage(hashKey(KEY_B), MODEL, 100_000_000, 0)
}

describe('W-21: usageStore.checkBeforeRequest は warning を落とさない', () => {
  it('enforce=false・上限超え → allowed:true のまま warning が付く（止めない）', () => {
    overLimit(false)
    const r = checkBeforeRequest(hashKey(KEY_A))
    expect(r.allowed).toBe(true)
    expect(r.message).toBeUndefined()
    expect(r.warning).toContain(WARN_MARK)
  })

  it('enforce=false でも上限内なら warning は付かない', () => {
    setSettings({ ...DEFAULT_SETTINGS, enforce: false, monthlyLimitYen: 100_000 })
    recordUsage(hashKey(KEY_A), MODEL, 1000, 1000)
    expect(checkBeforeRequest(hashKey(KEY_A))).toEqual({ allowed: true })
  })

  it('enforce=false でも上限が無制限（null）なら warning は付かない', () => {
    setSettings({ ...DEFAULT_SETTINGS, enforce: false, monthlyLimitYen: null })
    recordUsage(hashKey(KEY_A), MODEL, 100_000_000, 100_000_000)
    expect(checkBeforeRequest(hashKey(KEY_A))).toEqual({ allowed: true })
  })

  it('enforce=true・上限超え → 止める（allowed:false・message のみ。warning は付けない）', () => {
    overLimit(true)
    const r = checkBeforeRequest(hashKey(KEY_A))
    expect(r.allowed).toBe(false)
    expect(r.message).toContain('上限')
    expect(r.warning).toBeUndefined()
  })
})

describe('W-21: runEngineTurn は「止めない設定で上限超え」を吹き出しで知らせる（本物の usageStore 経由）', () => {
  it('★ enforce=false・上限超え → 送信は止めない・警告の吹き出しが出る（表示専用・🛑 は出ない）', async () => {
    overLimit(false)
    const t = makeHarness(realCheck(KEY_A))
    const r = await runEngineTurn(makeSpec(), t.ports)

    expect(r).toEqual({ endedWithError: false })
    expect(t.streamRequests).toHaveLength(1) // 止めていない
    const msgs = t.replay()
    const warns = warningBubbles(msgs)
    expect(warns).toHaveLength(1)
    expect(warns[0].toolNote).toBe(true) // 表示専用（AI へは送らない）
    expect(warns[0].content).toBe(checkBeforeRequest(hashKey(KEY_A)).warning) // 文面は usageBudget の1つだけ（言い換えない）
    expect(msgs.some((m) => m.content.includes('🛑'))).toBe(false)
    // 並び: 利用者の吹き出し → 警告 → AI の返事（自分の発言より前に警告が来ない）
    expect(msgs.map((m) => m.role + ':' + (m.toolNote ? 'note' : 'msg'))).toEqual(['user:msg', 'assistant:note', 'assistant:msg'])
    expect(msgs[0].content).toBe('こんにちは')
  })

  it('上限内 → 警告は出ない（利用者の吹き出しと返事だけ）', async () => {
    setSettings({ ...DEFAULT_SETTINGS, enforce: false, monthlyLimitYen: 100_000 })
    recordUsage(hashKey(KEY_A), MODEL, 1000, 1000)
    const t = makeHarness(realCheck(KEY_A))
    await runEngineTurn(makeSpec(), t.ports)

    expect(t.streamRequests).toHaveLength(1)
    const msgs = t.replay()
    expect(msgs.some((m) => m.toolNote)).toBe(false)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('★ enforce=true・上限超え → 止める（従来どおり 🛑 だけ・送信しない・警告の吹き出しは出さない）', async () => {
    overLimit(true)
    const t = makeHarness(realCheck(KEY_A))
    const r = await runEngineTurn(makeSpec(), t.ports)

    expect(r).toEqual({ endedWithError: false })
    expect(t.streamRequests).toHaveLength(0) // 送っていない
    const msgs = t.replay()
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toMatchObject({ role: 'user', content: 'こんにちは' })
    expect(msgs[1].role).toBe('assistant')
    expect(msgs[1].content.startsWith('🛑 ')).toBe(true)
    expect(msgs[1].content).toContain('上限')
    expect(warningBubbles(msgs)).toHaveLength(0)
  })
})

describe('W-21: 同じ会話で何度も出さない（会話・キー・月ごとに1度）', () => {
  const OVER: UsageCheckResult = { allowed: true, warning: `⚠️ 超えています。${WARN_MARK}（テスト用）` }

  it('★ 同じ会話の2回目のターンでは出ない（送信は毎回する）', async () => {
    const check = () => OVER
    const t1 = makeHarness(check)
    await runEngineTurn(makeSpec({ rawText: '1回目' }), t1.ports)
    const after1 = t1.replay()
    expect(warningBubbles(after1)).toHaveLength(1)

    const t2 = makeHarness(check, after1) // 2回目は1回目の会話を履歴として持つ
    await runEngineTurn(makeSpec({ rawText: '2回目' }), t2.ports)
    expect(t2.streamRequests).toHaveLength(1) // 止めていない
    expect(warningBubbles(t2.replay(after1))).toHaveLength(1) // 増えていない（最初の1件のまま）
    expect(t2.emitted.some((e) => e.kind === 'append' && e.msg.toolNote)).toBe(false) // 2回目は警告を出していない
  })

  it('別の会話では、その会話で初めて見る人のためにもう一度出る', async () => {
    const check = () => OVER
    const t1 = makeHarness(check)
    await runEngineTurn(makeSpec({ convDir: '/conv/one' }), t1.ports)
    const t2 = makeHarness(check)
    await runEngineTurn(makeSpec({ convDir: '/conv/two' }), t2.ports)
    expect(warningBubbles(t1.replay())).toHaveLength(1)
    expect(warningBubbles(t2.replay())).toHaveLength(1)
  })

  it('同じ会話でも、別のキー（別の上限）へ切り替えたら、そのキーの超過はもう一度知らせる', async () => {
    overLimit(false)
    const tA = makeHarness(realCheck(KEY_A))
    await runEngineTurn(makeSpec({ apiKey: KEY_A }), tA.ports)
    const tB = makeHarness(realCheck(KEY_B))
    await runEngineTurn(makeSpec({ apiKey: KEY_B }), tB.ports)
    expect(warningBubbles(tA.replay())).toHaveLength(1)
    expect(warningBubbles(tB.replay())).toHaveLength(1)
    // 同じキーのままなら、もう出ない
    const tB2 = makeHarness(realCheck(KEY_B))
    await runEngineTurn(makeSpec({ apiKey: KEY_B }), tB2.ports)
    expect(warningBubbles(tB2.replay())).toHaveLength(0)
  })

  it('月が変われば、同じ会話・同じキーでも、その月の超過をもう一度知らせる（アプリを起動したままでも）', async () => {
    const check = () => OVER
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 15, 12, 0, 0)) // 2026年9月
    const t1 = makeHarness(check)
    await runEngineTurn(makeSpec(), t1.ports)
    const t2 = makeHarness(check)
    await runEngineTurn(makeSpec(), t2.ports)
    expect(warningBubbles(t1.replay())).toHaveLength(1)
    expect(warningBubbles(t2.replay())).toHaveLength(0) // 同じ月の2回目は出ない

    vi.setSystemTime(new Date(2026, 9, 2, 12, 0, 0)) // 2026年10月
    const t3 = makeHarness(check)
    await runEngineTurn(makeSpec(), t3.ports)
    expect(warningBubbles(t3.replay())).toHaveLength(1)
  })

  it('止めるとき（allowed:false）は、warning が付いていても 🛑 だけ（警告の吹き出しを重ねない）', async () => {
    const t = makeHarness(() => ({ allowed: false, message: '上限に達しました', warning: `⚠️ ${WARN_MARK}` }))
    await runEngineTurn(makeSpec(), t.ports)
    expect(t.streamRequests).toHaveLength(0)
    const msgs = t.replay()
    expect(msgs.map((m) => m.content)).toEqual(['こんにちは', '🛑 上限に達しました'])
  })

  it('止めたターン（enforce=true）は「知らせた」ことにしない: あとで止めない設定へ変えたら、そこで1度出る', async () => {
    let res: UsageCheckResult = { allowed: false, message: '上限に達しました' }
    const check = () => res
    const t1 = makeHarness(check)
    await runEngineTurn(makeSpec(), t1.ports)
    expect(warningBubbles(t1.replay())).toHaveLength(0)

    res = OVER
    const t2 = makeHarness(check)
    await runEngineTurn(makeSpec(), t2.ports)
    expect(warningBubbles(t2.replay())).toHaveLength(1)
  })
})

describe('W-21: 警告の吹き出しは AI へ送らない', () => {
  it('★ 警告が履歴に残っていても、次のターンの送信内容（messages）には入らない', async () => {
    overLimit(false)
    const t1 = makeHarness(realCheck(KEY_A))
    await runEngineTurn(makeSpec({ rawText: '1回目' }), t1.ports)
    const after1 = t1.replay()
    expect(warningBubbles(after1)).toHaveLength(1)

    // 別のキー・会話でも同じ履歴を持って送る（警告を出す側の挙動に影響されず、履歴の扱いだけを見る）
    resetUsageWarnedForTest()
    const t2 = makeHarness(realCheck(KEY_A), after1)
    await runEngineTurn(makeSpec({ rawText: '2回目' }), t2.ports)
    const sent = JSON.stringify(t2.streamRequests[0].messages)
    expect(sent).not.toContain(WARN_MARK)
    expect(sent).toContain('1回目') // 履歴そのものは送っている（比較の当て先が空でないことの確認）
  })
})
