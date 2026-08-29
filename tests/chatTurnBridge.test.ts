import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { stripFunctions, dispatchAsk } from '../src/renderer/chatTurnBridge'
import { ASK_PATHS, type AskPath } from '../src/shared/chatTurnRpc'

// chatTurnBridge.ts: main からの ask を renderer の実装（buildPorts の中身と同じもの）へ
// 振り分ける配線（B'-3b・renderer側）。仕様書の5テスト＋useAiChat.ts の配線確認（テスト6）。

describe('stripFunctions', () => {
  it('関数の項目が消え、値の項目（文字列・null・入れ子でない値）はそのまま', () => {
    const applyFile = async () => {}
    const ragSearch = async (q: string) => q
    const input = {
      writeRoot: '/w',
      projectRoot: '/p',
      snapshotId: 's',
      snapshotLabel: null,
      count: 3,
      applyFile,
      ragSearch,
    }
    const out = stripFunctions(input)
    expect(out).toEqual({ writeRoot: '/w', projectRoot: '/p', snapshotId: 's', snapshotLabel: null, count: 3 })
    expect(Object.prototype.hasOwnProperty.call(out, 'applyFile')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(out, 'ragSearch')).toBe(false)
  })

  it('空オブジェクトは空オブジェクトのまま', () => {
    expect(stripFunctions({})).toEqual({})
  })

  it('関数を含まないオブジェクトは変化しない', () => {
    const input = { a: 1, b: 'x', c: null }
    expect(stripFunctions(input)).toEqual(input)
  })
})

// ── dispatchAsk: ASK_PATHS の全項目 ─────────────────────────────────
//
// path ごとに「どの handler が」「どんな引数で」呼ばれ「何を返すか」を表にし、ASK_PATHS の
// 中身と突き合わせる。表が ASK_PATHS と過不足なく一致することも確かめるので、
// ・dispatchAsk 側の対応（case）を1つ消す
// ・この表からエントリを1つ消す
// のどちらでも検知できる（掟10）。

type Recorded = { handler: string; args: unknown[] }

function makeHandlers() {
  const calls: Recorded[] = []
  const record = (name: string, ret: unknown) => (...args: unknown[]) => {
    calls.push({ handler: name, args })
    return ret
  }
  const handlers = {
    executeTool: record('executeTool', 'exec-result'),
    approveToolCall: record('approveToolCall', 'approve-result'),
    buildSystemPrompt: record('buildSystemPrompt', 'system-prompt'),
    getHistory: record('getHistory', ['h1']),
    onUserMessage: record('onUserMessage', undefined),
    buildRagBlock: record('buildRagBlock', 'rag-block'),
    getSearchConfig: record('getSearchConfig', { engine: 'x' }),
    fetchPagesBlock: record('fetchPagesBlock', 'pages-block'),
    autoSearchBlock: record('autoSearchBlock', 'search-block'),
    usageCheck: record('usageCheck', { allowed: true }),
    usageRecord: record('usageRecord', undefined),
    compactWarnOnce: record('compactWarnOnce', true),
  }
  return { handlers, calls }
}

// executeTool は turnOptsFull を敷く合成があるため、ここでは turnOptsFull を空にして
// 「opts がそのまま渡る」ことだけを見る（合成そのものは次の describe で別途固定する）。
const TABLE: Record<AskPath, { args: unknown[]; handlerKey: string; expectedArgs: unknown[]; expectedResult: unknown }> = {
  executeTool: {
    args: ['write_file', '{"a":1}', { search: { engine: 'x' } }],
    handlerKey: 'executeTool',
    expectedArgs: ['write_file', '{"a":1}', { search: { engine: 'x' } }],
    expectedResult: 'exec-result',
  },
  approveToolCall: {
    args: ['write_file', '{"a":1}', { projectDir: '/p' }],
    handlerKey: 'approveToolCall',
    expectedArgs: ['write_file', '{"a":1}', { projectDir: '/p' }],
    expectedResult: 'approve-result',
  },
  buildSystemPrompt: { args: [], handlerKey: 'buildSystemPrompt', expectedArgs: [], expectedResult: 'system-prompt' },
  getHistory: { args: [], handlerKey: 'getHistory', expectedArgs: [], expectedResult: ['h1'] },
  onUserMessage: { args: ['hello', true], handlerKey: 'onUserMessage', expectedArgs: ['hello', true], expectedResult: undefined },
  buildRagBlock: { args: ['query'], handlerKey: 'buildRagBlock', expectedArgs: ['query'], expectedResult: 'rag-block' },
  getSearchConfig: { args: [], handlerKey: 'getSearchConfig', expectedArgs: [], expectedResult: { engine: 'x' } },
  fetchPagesBlock: { args: [['https://a']], handlerKey: 'fetchPagesBlock', expectedArgs: [['https://a']], expectedResult: 'pages-block' },
  autoSearchBlock: { args: ['text', { engine: 'x' }], handlerKey: 'autoSearchBlock', expectedArgs: ['text', { engine: 'x' }], expectedResult: 'search-block' },
  'usage.check': { args: [], handlerKey: 'usageCheck', expectedArgs: [], expectedResult: { allowed: true } },
  'usage.record': { args: ['model-a', 10, 20], handlerKey: 'usageRecord', expectedArgs: ['model-a', 10, 20], expectedResult: undefined },
  compactWarnOnce: { args: [], handlerKey: 'compactWarnOnce', expectedArgs: [], expectedResult: true },
}

describe('dispatchAsk: ASK_PATHS の全項目', () => {
  it('表（TABLE）が ASK_PATHS と過不足なく一致する', () => {
    expect(Object.keys(TABLE).sort()).toEqual((ASK_PATHS as readonly string[]).slice().sort())
  })

  for (const p of ASK_PATHS) {
    it(`${p}: 対応する handler が正しい引数で1回だけ呼ばれ、返り値がそのまま返る`, async () => {
      const { handlers, calls } = makeHandlers()
      const entry = TABLE[p]
      const result = await dispatchAsk(handlers, {}, p, entry.args)
      expect(calls).toHaveLength(1)
      expect(calls[0].handler).toBe(entry.handlerKey)
      expect(calls[0].args).toEqual(entry.expectedArgs)
      expect(result).toEqual(entry.expectedResult)
    })
  }
})

// ── executeTool の合成（turnOptsFull を敷く）─────────────────────────
describe('dispatchAsk: executeTool の合成', () => {
  it('turnOptsFull の関数（applyFile/ragSearch）が生きたまま、main からの値で上書きされる', async () => {
    const applyFile = async () => {}
    const ragSearch = async (q: string) => q
    const turnOptsFull = { writeRoot: '/w', projectRoot: '/p', applyFile, ragSearch }
    const mainOpts = { writeRoot: '/w', projectRoot: '/p', search: { engine: 'x' }, snapshotId: 's', snapshotLabel: 'l' }

    let received: Record<string, unknown> | null = null
    const { handlers } = makeHandlers()
    handlers.executeTool = (async (name: string, argsJson: string, opts: Record<string, unknown>) => {
      received = opts
      return 'ok'
    }) as typeof handlers.executeTool

    const result = await dispatchAsk(handlers, turnOptsFull, 'executeTool', ['write_file', '{}', mainOpts])

    expect(result).toBe('ok')
    expect(received).not.toBeNull()
    // 関数が生きている（同一参照のまま）こと
    expect(received!.applyFile).toBe(applyFile)
    expect(received!.ragSearch).toBe(ragSearch)
    // 値の項目は main からの opts の値になっている
    expect(received!.writeRoot).toBe('/w')
    expect(received!.projectRoot).toBe('/p')
    expect(received!.search).toEqual({ engine: 'x' })
    expect(received!.snapshotId).toBe('s')
    expect(received!.snapshotLabel).toBe('l')
    // 今日の executeTool(name, args, { ...turnOpts, search, snapshotId, snapshotLabel }) と
    // 完全に一致することの証明（関数を含むオブジェクト同士の比較。同一参照なので toEqual で通る）
    expect(received).toEqual({ ...turnOptsFull, search: mainOpts.search, snapshotId: mainOpts.snapshotId, snapshotLabel: mainOpts.snapshotLabel })
  })
})

// ── 知らない path ────────────────────────────────────────────────
describe('dispatchAsk: 知らない path', () => {
  it('throw する（黙って undefined を返さない）', async () => {
    const { handlers } = makeHandlers()
    let threw = false
    try {
      await dispatchAsk(handlers, {}, 'noSuchPath' as AskPath, [])
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})

// ── optional な handler が undefined のまま ask が来た ───────────────
describe('dispatchAsk: optional な handler が undefined', () => {
  const cases: [AskPath, unknown[]][] = [
    ['approveToolCall', ['write_file', '{}']],
    ['onUserMessage', ['hi', true]],
    ['buildRagBlock', ['q']],
  ]
  for (const [p, args] of cases) {
    it(`${p}: throw する（caps の食い違いを黙らせない）`, async () => {
      const { handlers } = makeHandlers()
      ;(handlers as Record<string, unknown>)[p] = undefined
      let threw = false
      try {
        await dispatchAsk(handlers, {}, p, args)
      } catch {
        threw = true
      }
      expect(threw).toBe(true)
    })
  }
})

// ── useAiChat.ts の配線（B'-3b: main のターンに繋ぐ）─────────────────
//
// ⚠️ コメントを外してから判定する（tests/chatEvents.test.ts の readCode と同じ流儀。
// 2026-08-20 に自分の説明コメントにテストが当たって落ちた事故があるため）。
const readCode = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*')
    })
    .join('\n')

describe('useAiChat.ts の配線（send() が main のターンを呼ぶ）', () => {
  const src = readCode('src/renderer/hooks/useAiChat.ts')

  it('runEngineTurn( が無い（もう renderer では呼ばない）', () => {
    expect(src).not.toContain('runEngineTurn(')
  })

  it('chatTurn.start を呼んでいる', () => {
    expect(src).toContain('window.electronAPI.chatTurn.start(')
  })

  it('caps の3項目が !!approveToolCall 等から作られている', () => {
    expect(src).toContain('caps: { approveToolCall: !!approveToolCall, onUserMessage: !!onUserMessage, buildRagBlock: !!buildRagBlock }')
  })
})

// ── 終端の状態の確定（2026-08-28 実機で発見した取りこぼしの再発防止）──────────
// main からの「loading を消す」出来事は、invoke の完了に追い越されて失われることがある。
// send() の finally が自前で loading=false / status='' を重ねていることをソースで固定する
// （出来事の到着順に依存しない終わり方であること）。
import { readFileSync } from 'fs'
import { join } from 'path'
describe('useAiChat: ターン終端の状態を自前で確定する', () => {
  it("chatTurn.start の finally で loading=false と status='' を emit している", () => {
    const src = readFileSync(join(__dirname, '..', 'src/renderer/hooks/useAiChat.ts'), 'utf-8')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    const at = src.indexOf('await window.electronAPI.chatTurn.start(')
    expect(at).toBeGreaterThan(-1)
    const after = src.slice(at, at + 1600)
    const fin = after.indexOf('} finally {')
    expect(fin).toBeGreaterThan(-1)
    const finallyBlock = after.slice(fin, fin + 400)
    expect(finallyBlock).toContain("emit({ kind: 'loading', value: false })")
    expect(finallyBlock).toContain("emit({ kind: 'status', value: '' })")
  })
})

