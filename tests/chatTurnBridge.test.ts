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
    approveToolCall: record('approveToolCall', 'approve-result'),
    buildSystemPrompt: record('buildSystemPrompt', 'system-prompt'),
    getHistory: record('getHistory', ['h1']),
    onUserMessage: record('onUserMessage', undefined),
    buildRagBlock: record('buildRagBlock', 'rag-block'),
    getSearchConfig: record('getSearchConfig', { engine: 'x' }),
    fetchPagesBlock: record('fetchPagesBlock', 'pages-block'),
    autoSearchBlock: record('autoSearchBlock', 'search-block'),
  }
  return { handlers, calls }
}

// B'-3d-2b: executeTool は main 直呼びになり ASK_PATHS から外れた（dispatchAsk に case が無い・
// 下の「知らない path」describe で確かめる）。この表からは executeTool のエントリを外した。
const TABLE: Record<AskPath, { args: unknown[]; handlerKey: string; expectedArgs: unknown[]; expectedResult: unknown }> = {
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
}

describe('dispatchAsk: ASK_PATHS の全項目', () => {
  it('表（TABLE）が ASK_PATHS と過不足なく一致する', () => {
    expect(Object.keys(TABLE).sort()).toEqual((ASK_PATHS as readonly string[]).slice().sort())
  })

  for (const p of ASK_PATHS) {
    it(`${p}: 対応する handler が正しい引数で1回だけ呼ばれ、返り値がそのまま返る`, async () => {
      const { handlers, calls } = makeHandlers()
      const entry = TABLE[p]
      const result = await dispatchAsk(handlers, p, entry.args)
      expect(calls).toHaveLength(1)
      expect(calls[0].handler).toBe(entry.handlerKey)
      expect(calls[0].args).toEqual(entry.expectedArgs)
      expect(result).toEqual(entry.expectedResult)
    })
  }
})

// ── 知らない path ────────────────────────────────────────────────
describe('dispatchAsk: 知らない path', () => {
  it('throw する（黙って undefined を返さない）', async () => {
    const { handlers } = makeHandlers()
    let threw = false
    try {
      await dispatchAsk(handlers, 'noSuchPath' as AskPath, [])
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  // B'-3d-2b: executeTool は main 直呼びになり、ASK_PATHS からも dispatchAsk の case からも
  // 消えた。もし main 側の実装ミスで 'executeTool' という path が ask として飛んできても、
  // 「知らない path」として throw する（黙って undefined を返さない・型を経由しない実行時の値）。
  it("'executeTool' も「知らない path」として throw する（main 直呼びになり ask ではない）", async () => {
    const { handlers } = makeHandlers()
    let threw = false
    try {
      await dispatchAsk(handlers, 'executeTool' as AskPath, ['write_file', '{}', {}])
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
        await dispatchAsk(handlers, p, args)
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

