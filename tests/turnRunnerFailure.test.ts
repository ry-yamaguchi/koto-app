// main の想定外の throw で、失敗の吹き出しが会話に1回だけ残る（turnRunner.ts の chatTurn:start）。
// 利用者の依頼の吹き出しは runEngineTurn の中で初めて会話に入るので、それより前に投げた回は、
// 依頼もここで足す（無いと、会話に今回の依頼が無いまま「もう一度送る」だけが残る）。
//
//   A. 振る舞い: 本物の registerChatTurnHandlers を偽の ipcMain・偽の WebContents で動かし、
//      runEngineTurn を投げさせる。会話の記録（本物の convStore と一時フォルダ）・画面へ届く出来事・
//      chat:applied の通知・返り値を、呼ばれた順の一覧で見る。runEngineTurn が依頼・失敗の吹き出しを
//      出したあとで投げた回も、足りないものだけが足される
//   B. 配線: ports を try の前に作ること・catch の emit の形・直す前の形が戻らないこと
//   （後片づけの送信が投げる回は、本物の runEngineTurn で tests/turnRunnerFailureReal.test.ts が見る）

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  /** runEngineTurn の呼び出し回数 */
  runCalls: 0,
  /** runEngineTurn の中身。既定は何も出さずに投げる。ports.emit で吹き出しを出してから投げる回もある */
  runImpl: null as null | ((spec: any, ports: any) => Promise<void>),
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {}, openPath: async () => '' },
  dialog: {},
}))

// ループの本体だけを「想定外に投げる」ものへ差し替える（ほかは本物）。
vi.mock('../src/shared/chatTurn', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    runEngineTurn: async (spec: any, ports: any) => {
      h.runCalls++
      if (h.runImpl) await h.runImpl(spec, ports)
      throw new Error('Unexpected internal failure (test)')
    },
  }
})

import { registerChatTurnHandlers } from '../src/main/chat/turnRunner'
import {
  loadConversation, resetConversations, flushConversations, setApplyListener, type Op,
} from '../src/main/chat/convStore'
import { projectChatPath } from '../src/main/chatStore/paths'
import { resetChatLogCache } from '../src/main/chatStore/file'
import { UNEXPECTED_FAILURE_TEXT, failureBubbleOf, requestBubbleOf } from '../src/shared/chatFailure'

const ROOT = path.join(__dirname, '..')

let tmpDirs: string[] = []
function mkDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-turnrunner-failure-'))
  tmpDirs.push(d)
  return d
}

/** 偽の WebContents。送ったもの・外したリスナーを順に記録する。 */
function fakeWc(opts: { sendThrows?: boolean } = {}) {
  const sent: Array<{ channel: string; payload: any }> = []
  const offs: string[] = []
  const wc = {
    isDestroyed: () => false,
    send: (channel: string, payload: any) => {
      if (opts.sendThrows) throw new Error('send failed (test)')
      sent.push({ channel, payload })
    },
    once: () => {},
    on: () => {},
    off: (name: string) => { offs.push(name) },
  }
  return { wc, sent, offs }
}

function payloadOf(convDir: string | null, errorPrefix = '', over: { rawText?: string; images?: string[] } = {}) {
  return {
    turnId: 't1',
    spec: {
      rawText: over.rawText ?? 'こんにちは', images: over.images ?? [], assetBlock: '', apiKey: 'k', model: 'm', models: [{ id: 'm' }], maxRounds: 3,
      toolsProjectDir: null, convDir, errorPrefix, twoStageVision: false, routedModel: null, hasRag: false,
      turnOpts: {}, snapshotId: 's', snapshotLabel: 'x',
    },
    caps: { onUserMessage: false, buildRagBlock: false },
  } as any
}

let applied: Array<{ dir: string; op: Op; length: number }>
let errorLog: unknown[][]
let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  tmpDirs = []
  h.handlers.clear()
  h.runCalls = 0
  h.runImpl = null
  applied = []
  resetConversations()
  resetChatLogCache()
  setApplyListener((dir, op, length) => { applied.push({ dir, op, length }) })
  errorLog = []
  errorSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errorLog.push(a) })
  registerChatTurnHandlers({} as any)
})
afterEach(() => {
  resetConversations()
  setApplyListener(null)
  errorSpy.mockRestore()
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})

async function startTurn(wc: any, payload: any) {
  const start = h.handlers.get('chatTurn:start')
  expect(start, 'chatTurn:start').toBeTypeOf('function')
  return start!({ sender: wc }, payload)
}

// ── A. 振る舞い ──────────────────────────────────────────────────────────
describe('A. main の想定外の throw: 足りない吹き出し（依頼→失敗）が main の emit から1回ずつ出る', () => {
  it('★ 依頼が会話に入る前に投げた回: 会話の記録に、依頼の吹き出し1つ・失敗の吹き出し1つ・印が1つ（ディスクにも残る）', async () => {
    const dir = mkDir()
    const before = fs.existsSync(projectChatPath(dir))
    const { wc, sent, offs } = fakeWc()

    const result = await startTurn(wc, payloadOf(dir))

    expect(before).toBe(false)
    expect(h.runCalls).toBe(1)
    expect(result).toEqual({ ok: true, endedWithError: true })
    // メモリの会話: 依頼 → 失敗の順
    const messages = loadConversation(dir)!
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ role: 'user', content: 'こんにちは' })
    expect(messages[1]).toMatchObject({ role: 'assistant', content: UNEXPECTED_FAILURE_TEXT, offerRetry: true })
    expect(messages.filter(m => m.offerRetry)).toHaveLength(1)
    expect(messages.filter(m => m.role === 'user')).toHaveLength(1)
    // ディスク: 保存を書き切って、メモリを捨ててから読み直しても同じ
    flushConversations()
    expect(fs.existsSync(projectChatPath(dir))).toBe(true)
    resetConversations()
    resetChatLogCache()
    const reloaded = loadConversation(dir)!
    expect(reloaded).toHaveLength(2)
    expect(reloaded[0]).toMatchObject({ role: 'user', content: 'こんにちは' })
    expect(reloaded[1]).toMatchObject({ role: 'assistant', content: UNEXPECTED_FAILURE_TEXT, offerRetry: true })
    // 画面へ届く道（chat:applied の元になる通知）には、依頼 → 失敗の順に1回ずつ
    expect(applied.map(a => a.op.kind)).toEqual(['append', 'append'])
    expect(applied.every(a => a.dir === dir)).toBe(true)
    expect((applied[0].op as any).msg).toMatchObject({ role: 'user', content: 'こんにちは' })
    expect((applied[1].op as any).msg).toMatchObject({ offerRetry: true, content: UNEXPECTED_FAILURE_TEXT })
    // ターンの出来事（chatTurn:event）は、依頼 → 失敗 → ⚠️ の順に1回ずつ。ほかは何も送らない
    expect(sent.map(s => s.channel)).toEqual(['chatTurn:event:t1', 'chatTurn:event:t1', 'chatTurn:event:t1'])
    expect(sent[0].payload.ev).toMatchObject({ kind: 'append', msg: { role: 'user', content: 'こんにちは' } })
    expect(sent[1].payload.ev).toMatchObject({ kind: 'append', msg: { offerRetry: true, content: UNEXPECTED_FAILURE_TEXT } })
    expect(sent[2].payload).toEqual({ type: 'emit', ev: { kind: 'attention', value: 'error' } })
    // 片づけ（登録した窓のリスナーを外す）は投げた回でも済む
    expect(offs.sort()).toEqual(['destroyed', 'did-navigate'])
    // 原文はログにだけ残る
    expect(errorLog.some(a => String(a[0]).includes('runEngineTurn failed'))).toBe(true)
    expect(JSON.stringify(messages)).not.toContain('Unexpected internal failure')
  })

  it('単独チャットの接頭辞（⚠️ ）は失敗の文の前に付く', async () => {
    const dir = mkDir()
    const { wc } = fakeWc()
    await startTurn(wc, payloadOf(dir, '⚠️ '))
    const messages = loadConversation(dir)!
    expect(messages[0].content).toBe('こんにちは')
    expect(messages[1].content).toBe(`⚠️ ${UNEXPECTED_FAILURE_TEXT}`)
  })

  it('★ 既にある会話の続きに足す（前の吹き出しは消えない）。失敗の吹き出しより前で最後の利用者の吹き出しは、今回の依頼', async () => {
    const dir = mkDir()
    const { wc } = fakeWc()
    const { applyConversationOps } = await import('../src/main/chat/convStore')
    applyConversationOps(dir, [
      { kind: 'append', msg: { role: 'user', content: '前の依頼' } },
      { kind: 'append', msg: { role: 'assistant', content: '前の返事' } },
    ])
    applied.length = 0
    await startTurn(wc, payloadOf(dir))
    const messages = loadConversation(dir)!
    expect(messages.map(m => m.content)).toEqual(['前の依頼', '前の返事', 'こんにちは', UNEXPECTED_FAILURE_TEXT])
    expect(messages.map(m => !!m.offerRetry)).toEqual([false, false, false, true])
    // 「もう一度送る」が取り出す依頼（失敗の吹き出しより前で最後の user）は、1つ前ではなく今回のもの
    const failureAt = messages.findIndex(m => m.offerRetry)
    const requestBefore = [...messages.slice(0, failureAt)].reverse().find(m => m.role === 'user')
    expect(requestBefore?.content).toBe('こんにちは')
  })

  it('画像だけの送信: 依頼の吹き出しは既定の文と画像を持つ（送信の入口と同じ規則）', async () => {
    const dir = mkDir()
    const { wc } = fakeWc()
    await startTurn(wc, payloadOf(dir, '', { rawText: '  ', images: ['data:image/png;base64,xxx'] }))
    const messages = loadConversation(dir)!
    expect(messages[0]).toMatchObject(requestBubbleOf('', ['data:image/png;base64,xxx']))
    expect(messages[0]).toMatchObject({ role: 'user', content: 'この画像について教えてください。', images: ['data:image/png;base64,xxx'] })
  })

  it('★ runEngineTurn が依頼の吹き出しを出したあとで投げた回: 依頼は足さない（2つにならない）。失敗の吹き出しだけ足す', async () => {
    h.runImpl = async (_spec, ports) => { ports.emit({ kind: 'append', msg: { role: 'user', content: 'こんにちは' } }) }
    const dir = mkDir()
    const { wc } = fakeWc()
    await startTurn(wc, payloadOf(dir))
    const messages = loadConversation(dir)!
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(messages[1]).toMatchObject({ offerRetry: true, content: UNEXPECTED_FAILURE_TEXT })
  })

  it('★ runEngineTurn が失敗の吹き出しまで出したあとで投げた回: 2つ目を足さない（⚠️ だけ出す）。結末は endedWithError: true', async () => {
    h.runImpl = async (_spec, ports) => {
      ports.emit({ kind: 'append', msg: { role: 'user', content: 'こんにちは' } })
      ports.emit({ kind: 'append', msg: failureBubbleOf('通信に失敗しました') })
    }
    const dir = mkDir()
    const { wc, sent } = fakeWc()
    const result = await startTurn(wc, payloadOf(dir))
    expect(result).toEqual({ ok: true, endedWithError: true })
    const messages = loadConversation(dir)!
    expect(messages.map(m => m.content)).toEqual(['こんにちは', '通信に失敗しました'])
    expect(messages.filter(m => m.offerRetry)).toHaveLength(1)
    expect(sent.slice(-1)[0].payload).toEqual({ type: 'emit', ev: { kind: 'attention', value: 'error' } })
  })

  it('★ 失敗の吹き出しが replaceLast で出た回（画像の読み取りの失敗など）も、出たものとして数える', async () => {
    h.runImpl = async (_spec, ports) => {
      ports.emit({ kind: 'append', msg: { role: 'user', content: 'こんにちは' } })
      ports.emit({ kind: 'append', msg: { role: 'assistant', content: '' } })
      ports.emit({ kind: 'replaceLast', msg: failureBubbleOf('（画像の読み取りに失敗しました。もう一度お試しください）') })
    }
    const dir = mkDir()
    const { wc } = fakeWc()
    await startTurn(wc, payloadOf(dir))
    expect(loadConversation(dir)!.filter(m => m.offerRetry)).toHaveLength(1)
  })

  it('convDir が無い異常系: 会話の記録には触れず（二重書きにならず）、出来事だけを画面へ送る', async () => {
    const { wc, sent } = fakeWc()
    const result = await startTurn(wc, payloadOf(null))
    expect(result).toEqual({ ok: true, endedWithError: true })
    expect(applied).toEqual([])
    expect(sent.map(s => s.payload.ev.kind)).toEqual(['append', 'append', 'attention'])
    expect(sent[0].payload.ev.msg).toMatchObject({ role: 'user', content: 'こんにちは' })
    expect(sent[1].payload.ev.msg.offerRetry).toBe(true)
  })

  it('★ 吹き出しを出す側が投げても、ハンドラは reject しない（画面側が2つ目を出さない）。会話の記録には依頼と失敗が入る', async () => {
    const dir = mkDir()
    const { wc } = fakeWc({ sendThrows: true })
    const result = await startTurn(wc, payloadOf(dir))
    expect(result).toEqual({ ok: true, endedWithError: true })
    expect(errorLog.some(a => String(a[0]).includes('failure bubble not emitted'))).toBe(true)
    // 画面への送信が投げても、会話の記録には依頼 → 失敗の順に1つずつ入る（renderer が重ねて書かない前提）
    const messages = loadConversation(dir)!
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(messages.filter(m => m.offerRetry)).toHaveLength(1)
  })

  it('同じ会話で2回投げると、回ごとに依頼と失敗が1つずつ（1回の失敗で2つにならない）', async () => {
    const dir = mkDir()
    const first = fakeWc()
    await startTurn(first.wc, payloadOf(dir))
    const second = fakeWc()
    await startTurn(second.wc, { ...payloadOf(dir), turnId: 't2' })
    const messages = loadConversation(dir)!
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(messages.filter(m => m.offerRetry)).toHaveLength(2)
    expect(second.sent.map(s => s.channel)).toEqual(['chatTurn:event:t2', 'chatTurn:event:t2', 'chatTurn:event:t2'])
  })
})

// ── B. 配線 ──────────────────────────────────────────────────────────────
const readCode = (rel: string): string =>
  fs.readFileSync(path.join(ROOT, rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => { const t = line.trim(); return !t.startsWith('//') && !t.startsWith('*') })
    .join('\n')

describe('B. 配線（turnRunner.ts）', () => {
  const src = readCode('src/main/chat/turnRunner.ts')
  const handler = src.slice(src.indexOf("ipcMain.handle('chatTurn:start'"), src.indexOf("ipcMain.handle('chatTurn:abort'"))

  it('ports は try の前に作り、try の中では同じ ports を渡す', () => {
    const portsAt = handler.indexOf('const ports = buildMainPorts(turnId, wc, payload, entry)')
    const tryAt = handler.indexOf('    try {\n      endedWithError')
    expect(portsAt).toBeGreaterThan(-1)
    expect(tryAt).toBeGreaterThan(portsAt)
    expect(handler).toContain('endedWithError = (await runEngineTurn(payload.spec, ports)).endedWithError')
    // 直す前の形（try の中で組み立てる）は戻らない
    expect(handler).not.toContain('runEngineTurn(payload.spec, buildMainPorts(')
    expect(handler.split('buildMainPorts(')).toHaveLength(2)
  })

  it('catch は main の emit（ports.emit）で、吹き出しと ⚠️ を1回ずつ出す。画面側の emit・viewOnlyEmit は使わない', () => {
    const catchAt = handler.indexOf('} catch (e) {')
    const finallyAt = handler.indexOf('} finally {')
    expect(catchAt).toBeGreaterThan(-1)
    expect(finallyAt).toBeGreaterThan(catchAt)
    const body = handler.slice(catchAt, finallyAt)
    // 足りないものは数えた印（entry.written）から決める。出す吹き出しの一覧は chatFailure.ts の1か所が作る
    expect(body).toContain('...unexpectedFailureAppends({')
    expect(body).toContain('rawText: payload.spec.rawText, images: payload.spec.images, errorPrefix: payload.spec.errorPrefix, written: entry.written,')
    expect(body.split("{ kind: 'attention', value: 'error' },")).toHaveLength(2)
    expect(body.split('ports.emit(ev)')).toHaveLength(2) // 出す口は ports.emit だけ（1件ずつ受ける）
    expect(body).toContain('endedWithError = true')
    // 失敗の吹き出しだけを足す直す前の形・手組みの吹き出し・会話への直書きは無い
    expect(body).not.toContain('unexpectedFailureBubble(')
    expect(body).not.toContain("role: 'assistant'")
    expect(body).not.toContain("role: 'user'")
    expect(body).not.toContain('applyConversationOps(')
    expect(body).not.toContain('viewOnlyEmit')
    // 投げ直さない
    expect(body).not.toMatch(/\bthrow\b/)
  })

  it('会話に入ったものを数えるのは emit の中、会話に当てた直後（送信が投げても数えが残る）', () => {
    const apply = src.indexOf("applyConversationOps(payload.spec.convDir, [ev])")
    const note = src.indexOf('noteWritten(entry.written, ev)')
    const send = src.indexOf('if (!wc.isDestroyed()) wc.send(`chatTurn:event:${turnId}`, { type: \'emit\', ev })')
    expect(apply).toBeGreaterThan(-1)
    expect(note).toBeGreaterThan(apply)
    expect(send).toBeGreaterThan(note)
    expect(src.split('noteWritten(')).toHaveLength(2)
    expect(src).toContain('written: { request: false, failure: false },')
  })

  it('失敗の文は chatFailure.ts の1か所から取る（turnRunner.ts に文を書かない）', () => {
    expect(src).toContain("import { noteWritten, unexpectedFailureAppends, type WrittenState } from '../../shared/chatFailure'")
    expect(src).not.toContain('Koto の内部で問題が起きました')
    expect(src).not.toContain('offerRetry')
  })
})
