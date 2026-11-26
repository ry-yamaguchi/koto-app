import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  decideGreeting, runGreeting, isGreetingLeftover,
  type GreetingInput, type GreetingPorts, type GreetingStreamRequest,
} from '../src/renderer/greeting'
import { IDE_CONTEXT, GREETING_SYSTEM } from '../src/renderer/aiContext'
import { GREET_ON_OPEN_KEY, isGreetOnOpenEnabled } from '../src/renderer/greetSetting'

// ── 最初のあいさつ（U4・T-5a／T-5b／T-5d）────────────────────────────────────
// 判断（decideGreeting）と実行（runGreeting）を、ChatPanel から純関数へ切り出した。
// ここで固定するのは次の3つ。
//  1. decideGreeting: 6つの条件を1つずつ崩して 'none'。オフは 'none'（固定の一言も出さない）で、条件がそろった回は印を付ける。
//  2. runGreeting: 偽の ports に流して、呼ばれた要求の一覧（名前・引数・順）を見る。
//     お金の歯止め（checkBeforeRequest・recordUsage）は、切り出す前と同じ引数・同じ順で呼ばれること。
//  3. 配線: ChatPanel の effect が decideGreeting を1か所だけ通ること。
// 文字列の期待値は、実装の定数を import せず、リテラルで書く（定数を変えても気づけなくなるため）。

const KICKOFF =
  'これからこのプロジェクトの開発を始めます。まず、把握した内容（プロジェクトの目的と構成）を1〜2文で要約し、' +
  '続けて「次に何をしたいか」を私に1つ質問してください。この最初の返答ではコードは出力せず、まず会話で確認してください。'
const FIXED = 'こんにちは！つくりたいものを日本語で教えてください。'
const TIMED_OUT = '⏱ AIからの返事が届かなかったので、あいさつは省きました。つくりたいものを、そのまま送ってください。'
const FAILED = '（あいさつを準備できませんでした。つくりたいものを教えてください。）'

// ── T-5a: decideGreeting ─────────────────────────────────────────────────────
const ready: GreetingInput = {
  chatUsable: true,
  hasApiKey: true,
  projectDir: '/p/a',
  ctxDir: '/p/a',
  messagesLength: 0,
  conversationLoaded: true,
  isLoading: false,
  greetedDir: '',
  enabled: true,
  newProjectPending: false,
}
const NONE = { action: 'none', markGreeted: false }

describe('T-5a: decideGreeting — 条件がそろえば出す', () => {
  it('★ キーあり → ai（印も付ける）', () => {
    expect(decideGreeting(ready)).toEqual({ action: 'ai', markGreeted: true })
  })

  it('★ キー無しで Claude だけ → fixed（固定の一言・印も付ける）', () => {
    expect(decideGreeting({ ...ready, hasApiKey: false })).toEqual({ action: 'fixed', markGreeted: true })
  })

  it('別のフォルダだけを覚えているとき（A→B→A）は、また出る。覚えるのは直近1件だけ', () => {
    expect(decideGreeting({ ...ready, greetedDir: '/p/z' })).toEqual({ action: 'ai', markGreeted: true })
  })
})

describe('T-5a: decideGreeting — 7つの条件を1つずつ崩すと none（印も付けない）', () => {
  const broken: Array<[string, Partial<GreetingInput>]> = [
    ['projectCtx.dir が違う（別プロジェクトの文脈）', { ctxDir: '/p/b' }],
    ['projectCtx がまだ無い', { ctxDir: null }],
    ['projectCtx がまだ無い（undefined）', { ctxDir: undefined }],
    ['messages が1件以上', { messagesLength: 1 }],
    ['isLoading', { isLoading: true }],
    ['greetedDir が同じ（済んだ印が付いている）', { greetedDir: '/p/a' }],
    ['会話の読み込みが済んでいない（messages は前のプロジェクトのもの、または空）', { conversationLoaded: false }],
    ['chatUsable が偽（キーが無く Claude も無効）', { chatUsable: false }],
    ['projectDir が無い（null）', { projectDir: null }],
    ['projectDir が無い（undefined）', { projectDir: undefined }],
    ['projectDir が空文字', { projectDir: '' }],
  ]
  it.each(broken)('★ %s', (_name, patch) => {
    expect(decideGreeting({ ...ready, ...patch })).toEqual(NONE)
  })

  it('キー無しでも、条件が崩れていれば fixed を出さない', () => {
    expect(decideGreeting({ ...ready, hasApiKey: false, messagesLength: 2 })).toEqual(NONE)
    expect(decideGreeting({ ...ready, hasApiKey: false, chatUsable: false })).toEqual(NONE)
  })

  it('★★★ 読み込み前は、会話が空に見えても出さず、印も付けない（保存済みの会話を置き換えない）', () => {
    // A（会話が空）を開いたまま、保存済みの会話があるプロジェクト B へ切り替えた直後の入力。
    // messages はまだ A のもの（長さ0）で、B の文脈だけが先にそろっている。
    const switched: GreetingInput = { ...ready, projectDir: '/p/b', ctxDir: '/p/b', messagesLength: 0, conversationLoaded: false, greetedDir: '/p/a' }
    expect(decideGreeting(switched)).toEqual(NONE)
    expect(decideGreeting({ ...switched, hasApiKey: false })).toEqual(NONE)
    // 対照: 読み込みが済んで、会話が空のままなら出る
    expect(decideGreeting({ ...switched, conversationLoaded: true })).toEqual({ action: 'ai', markGreeted: true })
  })

  it('★★★ 読み込み前は、設定がオフでも印を付けない（オンへ戻したあとに読み込みが済めば、出る）', () => {
    expect(decideGreeting({ ...ready, enabled: false, conversationLoaded: false })).toEqual(NONE)
  })

  it('★ 読み込みが済んで messages が1件以上なら、いままでどおり none（読み込み済みの印だけでは出さない）', () => {
    expect(decideGreeting({ ...ready, conversationLoaded: true, messagesLength: 3 })).toEqual(NONE)
  })

  it('★ 新規作成の依頼が保留中 → none（依頼だけを送る。印は付けない＝送るほうが付ける）', () => {
    expect(decideGreeting({ ...ready, newProjectPending: true })).toEqual(NONE)
    expect(decideGreeting({ ...ready, newProjectPending: true, hasApiKey: false })).toEqual(NONE)
  })
})

describe('T-5a: decideGreeting — 設定がオフ', () => {
  it('★★ オフ → none。条件がそろった回は印を付ける', () => {
    expect(decideGreeting({ ...ready, enabled: false })).toEqual({ action: 'none', markGreeted: true })
  })

  it('★★ オフ → 固定の一言も出さない（キー無しで Claude だけでも none）', () => {
    expect(decideGreeting({ ...ready, enabled: false, hasApiKey: false })).toEqual({ action: 'none', markGreeted: true })
  })

  it('オフでも、条件がそろっていない回は印を付けない', () => {
    for (const patch of [{ ctxDir: '/p/b' }, { messagesLength: 1 }, { isLoading: true }, { chatUsable: false }, { projectDir: null }, { newProjectPending: true }, { conversationLoaded: false }] as Array<Partial<GreetingInput>>) {
      expect(decideGreeting({ ...ready, enabled: false, ...patch })).toEqual(NONE)
    }
  })

  it('★ オフの間に会話をクリアして、オンへ戻した瞬間にあいさつが出ない（印が残っている）', () => {
    // 1回目: オフで条件がそろう → none＋印。2回目: オンに戻して同じ状態（会話は空のまま）→ 印が効いて none。
    const first = decideGreeting({ ...ready, enabled: false })
    expect(first).toEqual({ action: 'none', markGreeted: true })
    const greetedDir = first.markGreeted ? ready.projectDir! : ''
    expect(decideGreeting({ ...ready, enabled: true, greetedDir })).toEqual(NONE)
  })

  it('オンで済ませたあとに、オフにしても何も起きない（印が効いている）', () => {
    expect(decideGreeting({ ...ready, enabled: false, greetedDir: '/p/a' })).toEqual(NONE)
  })
})

// ── 設定 → 判断（本物の読み出しをつなぐ）──────────────────────────────────────
// ChatPanel の effect は enabled に isGreetOnOpenEnabled() の値をそのまま渡す。
// 既定がオフへ反転する・不明な値がオフになる、と、設定が効かないだけでなく「頼んでいないあいさつが出ない／出る」が逆になる。
const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const installStorage = (initial: Record<string, string> | 'throws'): void => {
  const store: Record<string, string> = initial === 'throws' ? {} : { ...initial }
  const value = initial === 'throws'
    ? { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') }, removeItem: () => {} }
    : { getItem: (k: string) => (k in store ? store[k] : null), setItem: (k: string, v: string) => { store[k] = String(v) }, removeItem: (k: string) => { delete store[k] } }
  Object.defineProperty(globalThis, 'localStorage', { value, configurable: true, writable: true })
}
afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original)
  else delete (globalThis as { localStorage?: unknown }).localStorage
})
const decideWithSetting = (): ReturnType<typeof decideGreeting> =>
  decideGreeting({ ...ready, enabled: isGreetOnOpenEnabled() })

describe('設定 → 判断: 既定はオンで、設定が効く', () => {
  it('★★★ 未設定 → あいさつが出る（既定はオン）', () => {
    installStorage({})
    expect(decideWithSetting()).toEqual({ action: 'ai', markGreeted: true })
  })

  it('★★★ 不明な値・読み出しの失敗 → あいさつが出る（不明をオフに倒さない）', () => {
    for (const v of ['', '0', 'false', 'no', 'OFF', ' off', 'disabled']) {
      installStorage({ [GREET_ON_OPEN_KEY]: v })
      expect(decideWithSetting(), v).toEqual({ action: 'ai', markGreeted: true })
    }
    installStorage('throws')
    expect(decideWithSetting()).toEqual({ action: 'ai', markGreeted: true })
  })

  it('★★★ \'off\' → あいさつが出ない（印は付く）。\'on\' → 出る', () => {
    installStorage({ [GREET_ON_OPEN_KEY]: 'off' })
    expect(decideWithSetting()).toEqual({ action: 'none', markGreeted: true })
    installStorage({ [GREET_ON_OPEN_KEY]: 'on' })
    expect(decideWithSetting()).toEqual({ action: 'ai', markGreeted: true })
  })
})

// ── T-5b: runGreeting（偽の ports）────────────────────────────────────────────
type Call = { name: string; args: unknown[] }

/** あいさつを始めたプロジェクト（`run.dir`）。偽の ports は、指定が無ければずっとこのプロジェクトが開いている。 */
const RUN_DIR = '/p/a'

function makePorts(opts: {
  budget?: { allowed: boolean; warning?: string; message?: string }
  /** 返事の断片。関数は、その位置で起きる出来事（例: 別のプロジェクトへの切り替え）。 */
  deltas?: Array<string | (() => void)>
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
  timedOut?: 'first' | 'idle'
  streamThrows?: Error
  recordThrows?: Error
} = {}) {
  const calls: Call[] = []
  const rec = (name: string, ...args: unknown[]) => { calls.push({ name, args }) }
  const abortFn = () => {}
  /** 会話の記録へ送った書き換え（宛先つき。あいさつの書き換えの出口はこの1本だけ） */
  const toDir: Array<{ dir: string; op: any }> = []
  const ports: GreetingPorts = {
    checkBeforeRequest: (apiKey) => { rec('checkBeforeRequest', apiKey); return opts.budget ?? { allowed: true } },
    chatStream: async (req: GreetingStreamRequest, onDelta, onAbort) => {
      rec('chatStream', req)
      onAbort(abortFn)
      if (opts.streamThrows) throw opts.streamThrows
      for (const d of opts.deltas ?? ['こんにちは']) { if (typeof d === 'function') d(); else onDelta(d) }
      return { usage: opts.usage === undefined ? { prompt_tokens: 120, completion_tokens: 30 } : opts.usage, timedOut: opts.timedOut }
    },
    recordUsage: (...a) => { rec('recordUsage', ...a); if (opts.recordThrows) throw opts.recordThrows },
    estimateTokens: (text) => { rec('estimateTokens', text); return text.length },
    applyOpToDir: (dir, op) => { rec('applyOpToDir', op); toDir.push({ dir, op }) },
    setLoading: (v) => { rec('setLoading', v) },
    setAbort: (fn) => { rec('setAbort', fn) },
    warn: (d) => { rec('warn', d) },
  }
  return { ports, calls, abortFn, toDir }
}

const run = { apiKey: 'key-1', model: 'model-1', projectContext: '【プロジェクト】a', dir: RUN_DIR }
const names = (calls: Call[]) => calls.map(c => c.name)
const ofName = (calls: Call[], name: string) => calls.filter(c => c.name === name)
const ops = (calls: Call[]) => ofName(calls, 'applyOpToDir').map(c => c.args[0] as any)

describe('T-5b: runGreeting — お金の歯止めは、同じ引数・同じ順で呼ばれる', () => {
  it('★★★ 通常の1回: checkBeforeRequest(キー) → 読み込み表示 → 吹き出し → chatStream → … → recordUsage(キー, モデル, 入力, 出力) → 中断を外す → 読み込み表示を消す', async () => {
    const { ports, calls, abortFn } = makePorts({ deltas: ['こん', 'にちは'] })
    await runGreeting(run, ports)
    expect(names(calls)).toEqual([
      'checkBeforeRequest',
      'setLoading',
      'applyOpToDir',        // 空の吹き出しを出す
      'chatStream',
      'setAbort',       // chatStream の中で中断関数を受け取る
      'applyOpToDir',        // 'こん'
      'applyOpToDir',        // 'こんにちは'
      'recordUsage',
      'setAbort',
      'setLoading',
    ])
    expect(calls[0].args).toEqual(['key-1'])
    expect(calls[1].args).toEqual([true])
    expect(calls[4].args).toEqual([abortFn])
    expect(calls[7].args).toEqual(['key-1', 'model-1', 120, 30])
    expect(calls[8].args).toEqual([null])
    expect(calls[9].args).toEqual([false])
  })

  it('★★★ checkBeforeRequest も recordUsage も、ちょうど1回', async () => {
    const { ports, calls } = makePorts()
    await runGreeting(run, ports)
    expect(ofName(calls, 'checkBeforeRequest')).toHaveLength(1)
    expect(ofName(calls, 'recordUsage')).toHaveLength(1)
    expect(ofName(calls, 'chatStream')).toHaveLength(1)
  })

  it('★★★ 上限に達して止める設定（allowed:false）→ chatStream 0回・何も当てない・記録しない', async () => {
    const { ports, calls } = makePorts({ budget: { allowed: false, message: '今月の上限に達しました' } })
    await runGreeting(run, ports)
    expect(calls).toEqual([{ name: 'checkBeforeRequest', args: ['key-1'] }])
  })

  it('★★★ allowed:true なら AI へ送る（allowed を見ずに常に送る・常に止める、のどちらでもない）', async () => {
    const { ports, calls } = makePorts({ budget: { allowed: true } })
    await runGreeting(run, ports)
    expect(ofName(calls, 'chatStream')).toHaveLength(1)
  })

  it('★★ 確認の結果が出る前に、読み込み表示も要求も出さない（確認が最初）', async () => {
    const { ports, calls } = makePorts()
    await runGreeting(run, ports)
    expect(calls[0].name).toBe('checkBeforeRequest')
  })
})

describe('T-5b: runGreeting — キー無し（Claude だけ）は AI へ送らない', () => {
  it('★ chatStream 0回・確認も記録もしない・固定の一言だけ', async () => {
    const { ports, calls } = makePorts()
    await runGreeting({ ...run, apiKey: '' }, ports)
    expect(calls).toEqual([
      { name: 'applyOpToDir', args: [{ kind: 'replaceAll', messages: [{ role: 'assistant', content: FIXED }] }] },
    ])
  })
})

describe('T-5b: runGreeting — 送る中身', () => {
  it('★ maxTokens は 700。messages は system と user の2件だけで、ツール・履歴は付かない', async () => {
    const { ports, calls } = makePorts()
    await runGreeting(run, ports)
    const req = ofName(calls, 'chatStream')[0].args[0] as GreetingStreamRequest
    expect(req.maxTokens).toBe(700)
    expect(req.apiKey).toBe('key-1')
    expect(req.model).toBe('model-1')
    expect(req.messages.map(m => m.role)).toEqual(['system', 'user'])
    // tools のキーが無い（道具を渡さない）
    expect(Object.keys(req).sort()).toEqual(['apiKey', 'maxTokens', 'messages', 'model'])
  })

  it('★ system は GREETING_SYSTEM で始まり、道具前提の IDE_CONTEXT を含まない', async () => {
    const { ports, calls } = makePorts()
    await runGreeting(run, ports)
    const req = ofName(calls, 'chatStream')[0].args[0] as GreetingStreamRequest
    expect(req.messages[0].content.startsWith(GREETING_SYSTEM)).toBe(true)
    expect(req.messages[0].content).not.toContain(IDE_CONTEXT)
    expect(req.messages[0].content).not.toContain('read_file')
  })

  it('★ ファイル一覧の見出しは、道具の名前の無い言い方に差し替わって渡る', async () => {
    const { ports, calls } = makePorts()
    await runGreeting({ ...run, projectContext: 'ファイル構成（作業フォルダの中。そのまま read_file などに渡せるパス）:\n- a.js' }, ports)
    const sys = (ofName(calls, 'chatStream')[0].args[0] as GreetingStreamRequest).messages[0].content
    expect(sys).toContain('ファイル構成（作業フォルダの中）:\n- a.js')
    expect(sys).not.toContain('read_file')
  })

  it('★ system は GREETING_SYSTEM ＋ 空行 ＋ プロジェクトの文脈。user は依頼文', async () => {
    const { ports, calls } = makePorts()
    await runGreeting(run, ports)
    const req = ofName(calls, 'chatStream')[0].args[0] as GreetingStreamRequest
    expect(req.messages[0].content).toBe(GREETING_SYSTEM + '\n\n【プロジェクト】a')
    expect(req.messages[1].content).toBe(KICKOFF)
  })

  it('文脈が空なら、system は GREETING_SYSTEM だけ（余分な空行を付けない）', async () => {
    const { ports, calls } = makePorts()
    await runGreeting({ ...run, projectContext: '' }, ports)
    const req = ofName(calls, 'chatStream')[0].args[0] as GreetingStreamRequest
    expect(req.messages[0].content).toBe(GREETING_SYSTEM)
  })

  it('吹き出し: 依頼文（hidden）と、届いた分までの返事。最後の更新は届いた全文', async () => {
    const { ports, calls } = makePorts({ deltas: ['こん', 'にちは'] })
    await runGreeting(run, ports)
    const hidden = { role: 'user', content: KICKOFF, hidden: true }
    expect(ops(calls).slice(0, 3)).toEqual([
      { kind: 'replaceAll', messages: [hidden, { role: 'assistant', content: '' }] },
      { kind: 'replaceAll', messages: [hidden, { role: 'assistant', content: 'こん' }] },
      { kind: 'replaceAll', messages: [hidden, { role: 'assistant', content: 'こんにちは' }] },
    ])
  })

  it('吹き出しの差し替えは append ではなく replaceAll（時刻の刻印を付ける経路を通らない）', async () => {
    const { ports, calls } = makePorts()
    await runGreeting(run, ports)
    for (const op of ops(calls)) expect(op.kind).toBe('replaceAll')
  })
})

describe('T-5b: runGreeting — 利用量の記録', () => {
  it('★ usage があれば、その値を recordUsage へ渡す（見積もりは使わない）', async () => {
    const { ports, calls } = makePorts({ usage: { prompt_tokens: 7, completion_tokens: 3 } })
    await runGreeting(run, ports)
    expect(ofName(calls, 'recordUsage')[0].args).toEqual(['key-1', 'model-1', 7, 3])
    expect(ofName(calls, 'estimateTokens')).toHaveLength(0)
  })

  it('★ usage が無ければ見積もり（入力は system＋依頼文、出力は届いた全文）。入力 → 出力の順に見積もる', async () => {
    const { ports, calls } = makePorts({ usage: null, deltas: ['あいう', 'えお'] })
    await runGreeting(run, ports)
    const sys = GREETING_SYSTEM + '\n\n【プロジェクト】a'
    expect(ofName(calls, 'estimateTokens').map(c => c.args[0])).toEqual([sys + KICKOFF, 'あいうえお'])
    expect(ofName(calls, 'recordUsage')[0].args).toEqual(['key-1', 'model-1', (sys + KICKOFF).length, 'あいうえお'.length])
  })

  it('片方だけ返ったときは、足りない側だけ見積もる', async () => {
    const { ports, calls } = makePorts({ usage: { prompt_tokens: 50 }, deltas: ['あい'] })
    await runGreeting(run, ports)
    expect(ofName(calls, 'recordUsage')[0].args).toEqual(['key-1', 'model-1', 50, 2])
    expect(ofName(calls, 'estimateTokens').map(c => c.args[0])).toEqual(['あい'])
  })
})

describe('T-5b: runGreeting — warning（止めない設定で上限を超えた）', () => {
  const WARN = '⚠️ 今月の上限を超えています'
  const warning = (calls: Call[]) => ops(calls).filter(o => o.kind === 'append')

  it('★★ allowed:true のまま warning が付く回は、最後に append で足す', async () => {
    const { ports, calls } = makePorts({ budget: { allowed: true, warning: WARN } })
    await runGreeting(run, ports)
    expect(ofName(calls, 'chatStream')).toHaveLength(1)
    expect(warning(calls)).toEqual([{ kind: 'append', msg: { role: 'assistant', toolNote: true, content: WARN } }])
    // 最後の1件で、読み込み表示を消したあと
    const last = calls[calls.length - 1]
    expect(last.name).toBe('applyOpToDir')
    expect((last.args[0] as any).kind).toBe('append')
    const idxLoadingOff = calls.findIndex(c => c.name === 'setLoading' && c.args[0] === false)
    expect(idxLoadingOff).toBe(calls.length - 2)
  })

  it('★★ 順序: 返事の差し替え（replaceAll）がすべて終わってから warning を足す。先に出すと消える', async () => {
    const { ports, calls } = makePorts({ budget: { allowed: true, warning: WARN }, deltas: ['あ', 'い'] })
    await runGreeting(run, ports)
    const kinds = ops(calls).map(o => o.kind)
    expect(kinds).toEqual(['replaceAll', 'replaceAll', 'replaceAll', 'append'])
  })

  it('時間切れでも、失敗でも、最後に warning を足す', async () => {
    const a = makePorts({ budget: { allowed: true, warning: WARN }, timedOut: 'first', usage: null })
    await runGreeting(run, a.ports)
    expect(ops(a.calls).map(o => o.kind).pop()).toBe('append')
    const b = makePorts({ budget: { allowed: true, warning: WARN }, streamThrows: new Error('boom') })
    await runGreeting(run, b.ports)
    expect(ops(b.calls).map(o => o.kind).pop()).toBe('append')
  })

  it('warning が無い回は append しない', async () => {
    const { ports, calls } = makePorts({ budget: { allowed: true } })
    await runGreeting(run, ports)
    expect(warning(calls)).toHaveLength(0)
  })

  it('止める回（allowed:false）は warning も出さない', async () => {
    const { ports, calls } = makePorts({ budget: { allowed: false, warning: WARN } })
    await runGreeting(run, ports)
    expect(ops(calls)).toHaveLength(0)
  })
})

describe('T-5b: runGreeting — 時間切れ・失敗', () => {
  it('★ 時間切れ（throw せず timedOut で返る）→ あいさつ用の短い1文に差し替える', async () => {
    for (const timedOut of ['first', 'idle'] as const) {
      const { ports, calls } = makePorts({ usage: null, deltas: [], timedOut })
      await runGreeting(run, ports)
      const last = ops(calls).pop()
      expect(last).toEqual({ kind: 'replaceAll', messages: [{ role: 'assistant', content: TIMED_OUT }] })
    }
  })

  it('時間切れでも利用量は記録する（見積もりで1回）', async () => {
    const { ports, calls } = makePorts({ usage: null, deltas: [], timedOut: 'first' })
    await runGreeting(run, ports)
    expect(ofName(calls, 'recordUsage')).toHaveLength(1)
  })

  it('★ 例外 → 穏当な固定文に差し替え、原因はログにだけ残す。利用量は記録しない', async () => {
    const { ports, calls } = makePorts({ streamThrows: new Error('boom') })
    await runGreeting(run, ports)
    expect(ops(calls).pop()).toEqual({ kind: 'replaceAll', messages: [{ role: 'assistant', content: FAILED }] })
    expect(ofName(calls, 'warn')).toHaveLength(1)
    expect(typeof ofName(calls, 'warn')[0].args[0]).toBe('string')
    expect(ofName(calls, 'recordUsage')).toHaveLength(0)
    // 生のエラー文は吹き出しに出さない
    expect(JSON.stringify(ops(calls))).not.toContain('boom')
  })

  it('例外でも、中断関数は外し、読み込み表示は消す', async () => {
    const { ports, calls } = makePorts({ streamThrows: new Error('boom') })
    await runGreeting(run, ports)
    const tail = calls.slice(-2)
    expect(tail).toEqual([{ name: 'setAbort', args: [null] }, { name: 'setLoading', args: [false] }])
  })

  it('記録で例外が出たときも、固定文に差し替わる（記録は try の中のまま）', async () => {
    const { ports, calls } = makePorts({ recordThrows: new Error('quota') })
    await runGreeting(run, ports)
    expect(ops(calls).pop()).toEqual({ kind: 'replaceAll', messages: [{ role: 'assistant', content: FAILED }] })
  })

  it('例外では、返事を差し替えたあとの吹き出しを残さない（最後の replaceAll が固定文）', async () => {
    const { ports, calls } = makePorts({ streamThrows: new Error('boom') })
    await runGreeting(run, ports)
    const replaces = ops(calls).filter(o => o.kind === 'replaceAll')
    expect(replaces[replaces.length - 1].messages).toHaveLength(1)
  })
})

describe('T-5b: runGreeting — ⏹ 停止', () => {
  it('chatStream が渡した中断関数を setAbort へ渡し、終わったら null で外す', async () => {
    const { ports, calls, abortFn } = makePorts()
    await runGreeting(run, ports)
    expect(ofName(calls, 'setAbort').map(c => c.args[0])).toEqual([abortFn, null])
  })
})

describe('T-5b: runGreeting — 書き換えはいつも始めたプロジェクトの記録へ送る（環境の独立。開いている先は見ない）', () => {
  const WARN = '⚠️ 今月の上限を超えています'
  const A = '/p/a'

  it('★★★ 全文・時間切れ・失敗・上限の文・固定の一言のすべてが、始めたプロジェクト A の記録へだけ送られる', async () => {
    const cases: Array<{ name: string; o: Parameters<typeof makePorts>[0]; key?: string }> = [
      { name: '全文', o: { deltas: ['あ', 'い'] } },
      { name: '時間切れ', o: { usage: null, timedOut: 'first', deltas: [] } },
      { name: '失敗', o: { streamThrows: new Error('boom') } },
      { name: '上限の知らせ', o: { budget: { allowed: true, warning: WARN } } },
      { name: '固定の一言', o: {}, key: '' },
    ]
    for (const c of cases) {
      const { ports, toDir } = makePorts(c.o)
      await runGreeting({ ...run, apiKey: c.key ?? run.apiKey }, ports)
      expect(toDir.length, c.name).toBeGreaterThan(0)
      expect(toDir.every(t => t.dir === A), c.name).toBe(true)
    }
  })

  it('★★★ 返事の全文は、最後の1件が記録に残る全文になる（毎回送り直す）', async () => {
    const { ports, toDir } = makePorts({ deltas: ['あ', 'い', 'う'] })
    await runGreeting(run, ports)
    expect(toDir.map(t => t.dir)).toEqual([A, A, A, A])
    expect(toDir[toDir.length - 1].op).toEqual({ kind: 'replaceAll', messages: [{ role: 'user', content: KICKOFF, hidden: true }, { role: 'assistant', content: 'あいう' }] })
  })

  it('★★★ 時間切れ・失敗・上限の文は、記録の最後に文として残る', async () => {
    const t = makePorts({ usage: null, timedOut: 'first', deltas: [] })
    await runGreeting(run, t.ports)
    expect(t.toDir[t.toDir.length - 1]).toEqual({ dir: A, op: { kind: 'replaceAll', messages: [{ role: 'assistant', content: TIMED_OUT }] } })
    expect(ofName(t.calls, 'recordUsage')).toHaveLength(1)
    const f = makePorts({ streamThrows: new Error('boom') })
    await runGreeting(run, f.ports)
    expect(f.toDir[f.toDir.length - 1]).toEqual({ dir: A, op: { kind: 'replaceAll', messages: [{ role: 'assistant', content: FAILED }] } })
    expect(ofName(f.calls, 'warn')).toHaveLength(1)
    const w = makePorts({ budget: { allowed: true, warning: WARN }, deltas: ['あ'] })
    await runGreeting(run, w.ports)
    expect(w.toDir[w.toDir.length - 1]).toEqual({ dir: A, op: { kind: 'append', msg: { role: 'assistant', toolNote: true, content: WARN } } })
  })

  it('★★ 読み込み表示を消す・中断関数を外す・利用量を記録する、は変わらず続ける', async () => {
    const { ports, calls } = makePorts({ deltas: ['い'], usage: { prompt_tokens: 7, completion_tokens: 3 } })
    await runGreeting(run, ports)
    expect(ofName(calls, 'recordUsage')).toEqual([{ name: 'recordUsage', args: ['key-1', 'model-1', 7, 3] }])
    expect(calls.slice(-2)).toEqual([{ name: 'setAbort', args: [null] }, { name: 'setLoading', args: [false] }])
  })

  // ChatPanel の配線を写した ports。送り先は applyOpToConversation（dir ごとの列）だけで、
  // 画面の client（clientRef）・開いているプロジェクト（projectDirRef）は ports に渡さない。
  it('★★★ A→B→A の戻り（projectDirRef が A・clientRef は B の client）の間に A のあいさつが届いても、B の記録へは1件も入らない', async () => {
    const projectDirRef = { current: 'A' as string }
    const clientRef = { current: { dir: 'B', sent: [] as unknown[] } }
    const store = new Map<string, unknown[]>()
    const wired: GreetingPorts = {
      ...makePorts({ deltas: ['あ', 'い'] }).ports,
      applyOpToDir: (dir, op) => { const l = store.get(dir) ?? []; l.push(op); store.set(dir, l) },
    }
    // 描画は A へ戻ったが effect はまだ（clientRef は B のまま）
    expect(projectDirRef.current).toBe('A')
    expect(clientRef.current.dir).toBe('B')
    await runGreeting({ ...run, dir: 'A' }, wired)
    expect([...store.keys()]).toEqual(['A'])
    expect(store.get('B')).toBeUndefined()
    expect(clientRef.current.sent).toEqual([])
  })

  it('★★★ ports は画面への口（applyOp）・開いているプロジェクト（currentDir）・読み込み済みか（viewingReady）を持たない', () => {
    const g = readCode('src/renderer/greeting.ts')
    expect(g).not.toMatch(/applyOp\(|currentDir|viewingReady|ports\.applyOp\b/)
    const { ports } = makePorts()
    expect(Object.keys(ports).sort()).toEqual(['applyOpToDir', 'checkBeforeRequest', 'chatStream', 'estimateTokens', 'recordUsage', 'setAbort', 'setLoading', 'warn'].sort())
  })
})

// ── 判断と実行をつなぐ（ChatPanel の effect と同じ順）─────────────────────────────
async function effectLike(
  input: GreetingInput,
  apiKey: string,
  ports: GreetingPorts,
  greeted: { dir: string },
): Promise<void> {
  const decision = decideGreeting({ ...input, greetedDir: greeted.dir })
  if (decision.markGreeted && input.projectDir) greeted.dir = input.projectDir
  if (decision.action === 'none') return
  await runGreeting({ apiKey, model: 'model-1', projectContext: '', dir: input.projectDir! }, ports)
}

describe('判断 → 実行: オフなら AI へ何も飛ばない', () => {
  it('★★★ オン（キーあり）→ chatStream 1回', async () => {
    const { ports, calls } = makePorts()
    const greeted = { dir: '' }
    await effectLike(ready, 'key-1', ports, greeted)
    expect(ofName(calls, 'chatStream')).toHaveLength(1)
    expect(greeted.dir).toBe('/p/a')
  })

  it('★★★ オフ（キーあり）→ chatStream 0回・確認も記録も無い・吹き出しも出ない・印は付く', async () => {
    const { ports, calls } = makePorts()
    const greeted = { dir: '' }
    await effectLike({ ...ready, enabled: false }, 'key-1', ports, greeted)
    expect(calls).toEqual([])
    expect(greeted.dir).toBe('/p/a')
  })

  it('★★★ オフ（キー無しで Claude だけ）→ 固定の一言も出さない・印は付く', async () => {
    const { ports, calls } = makePorts()
    const greeted = { dir: '' }
    await effectLike({ ...ready, enabled: false, hasApiKey: false }, '', ports, greeted)
    expect(calls).toEqual([])
    expect(greeted.dir).toBe('/p/a')
  })

  it('オン（キー無しで Claude だけ）→ 固定の一言だけ・chatStream 0回', async () => {
    const { ports, calls } = makePorts()
    await effectLike({ ...ready, hasApiKey: false }, '', ports, { dir: '' })
    expect(names(calls)).toEqual(['applyOpToDir'])
  })

  it('同じフォルダでは2回目は飛ばない（印が効く）', async () => {
    const { ports, calls } = makePorts()
    const greeted = { dir: '' }
    await effectLike(ready, 'key-1', ports, greeted)
    await effectLike(ready, 'key-1', ports, greeted)
    expect(ofName(calls, 'chatStream')).toHaveLength(1)
  })

  it('新規作成の依頼が保留中なら、何も飛ばさず印も付けない', async () => {
    const { ports, calls } = makePorts()
    const greeted = { dir: '' }
    await effectLike({ ...ready, newProjectPending: true }, 'key-1', ports, greeted)
    expect(calls).toEqual([])
    expect(greeted.dir).toBe('')
  })
})

// ── T-5d: 配線（文字列一致の補助。当て先が他の行に出ないよう、前後ごと書く）─────────────
const ROOT = join(__dirname, '..')
const readCode = (rel: string): string =>
  readFileSync(join(ROOT, rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*')
    })
    .join('\n')
const countOf = (src: string, s: string): number => src.split(s).length - 1

describe('T-5d: ChatPanel の effect が decideGreeting を1か所で通る（配線）', () => {
  const src = readCode('src/renderer/components/ChatPanel.tsx')
  const start = src.indexOf('const decision = decideGreeting({')
  const end = src.indexOf('}, [apiKey, claudeActive, projectDir, projectCtx, messages.length, convLoadedDir])', start)
  const effect = src.slice(start, end)

  it('★ decideGreeting と runGreeting の呼び出しは、ChatPanel にそれぞれ1か所', () => {
    expect(countOf(src, 'decideGreeting(')).toBe(1)
    expect(countOf(src, 'runGreeting(')).toBe(1)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(effect).toContain('void runGreeting(')
  })

  it('★ effect の依存は、今までの5つに、会話の読み込み済みの印（convLoadedDir）を足したもの', () => {
    expect(src).toContain('}, [apiKey, claudeActive, projectDir, projectCtx, messages.length, convLoadedDir])')
    // 読み込みが済んだ回に、会話が空のままでも effect をもう一度評価する（messages.length は変わらないため）
    expect(src).not.toContain('}, [apiKey, claudeActive, projectDir, projectCtx, messages.length])')
  })

  it('★★ 入力が実物から作られている（enabled は設定から・済んだ印は greetedRef から・保留中は2つの出どころから）', () => {
    expect(effect).toContain('chatUsable: isChatUsable(!!apiKey, claudeActive),')
    expect(effect).toContain('hasApiKey: !!apiKey,')
    expect(effect).toContain('ctxDir: projectCtx?.dir ?? null,')
    expect(effect).toContain('messagesLength: messages.length,')
    expect(effect).toContain('conversationLoaded: convLoadedDir === projectDir,')
    expect(effect).toContain('isLoading,')
    expect(effect).toContain('greetedDir: greetedRef.current,')
    expect(effect).toContain('enabled: isGreetOnOpenEnabled(),')
    expect(effect).toContain('newProjectPending: !!projectDir && (pendingNewProjectRef.current?.dir === projectDir || hasNewProjectRequest(projectDir)),')
  })

  it('★ 順序: 判断 → 印を付ける → none なら止める → 実行', () => {
    const decide = effect.indexOf('decideGreeting({')
    const mark = effect.indexOf('if (decision.markGreeted && projectDir) greetedRef.current = projectDir')
    const stop = effect.indexOf("if (decision.action === 'none') return")
    const runAt = effect.indexOf('void runGreeting(')
    expect(decide).toBeGreaterThan(-1)
    expect(mark).toBeGreaterThan(decide)
    expect(stop).toBeGreaterThan(mark)
    expect(runAt).toBeGreaterThan(stop)
  })

  it('★★ 歯止めの ports は本物の checkBeforeRequest・recordUsage・estimateTokens を渡す', () => {
    const ports = effect.slice(effect.indexOf('void runGreeting('))
    expect(ports).toContain('        checkBeforeRequest,\n')
    expect(ports).toContain('        recordUsage,\n')
    expect(ports).toContain('        estimateTokens,\n')
    expect(ports).toContain('chatStream: (req, onDelta, onAbort) => window.electronAPI.sakura.chatStream(req, onDelta, onAbort),')
    expect(ports).toContain('setLoading: (loading) => greet.setLoadingOf(projectDir, loading),')
    expect(ports).toContain('applyOpToDir: applyOpToConversation,')
    // 見ている間の client も、見ていない間の口と同じ dir ごとの1本（別々に作ると同じ会話へ2本の列が書く）
    expect(readCode('src/renderer/components/ChatPanel.tsx')).toContain('clientRef.current = convClientOf(projectDir)')
    expect(readCode('src/renderer/components/ChatPanel.tsx')).not.toContain('clientRef.current = makeConvClient(')
    expect(ports).not.toMatch(/\n\s+applyOp,/)
  })

  it('★★ 第1引数（キー・モデル・そのプロジェクトの文脈・始めたプロジェクト）と、残りの ports も、実物のまま渡す', () => {
    // 型検査は通る形（空の文脈・空の関数・渡し忘れ）なので、呼び出しの形ごと固定する。
    const call = effect.slice(effect.indexOf('void runGreeting('))
    expect(call).toContain('{ apiKey, model, projectContext: ctxFor(projectDir), dir: projectDir },')
    expect(call).toContain('setAbort: (abort) => greet.setAbortOf(projectDir, abort),')
    expect(call).toContain("warn: (detail) => console.warn('greet failed:', detail),")
    // 画面の状態（開いているプロジェクト・client）をあいさつの送り先の判断に使わない
    expect(call).not.toContain('projectDirRef')
    expect(call).not.toContain('clientRef')
    expect(src).not.toContain('projectDirRef')
    // ⏹ は、登録された中断関数を呼ぶ
    expect(src).toContain('onClick={() => { chat.abort(); greet.abortViewing() }}')
    expect(src).not.toContain('greetAbortRef')
  })

  it('★★ ports は、GreetingPorts の項目をすべて渡している（渡し忘れが無い）', () => {
    const expected = ['applyOpToDir', 'chatStream', 'checkBeforeRequest', 'estimateTokens', 'recordUsage', 'setAbort', 'setLoading', 'warn']
    const g = readCode('src/renderer/greeting.ts')
    const block = g.slice(g.indexOf('export interface GreetingPorts {'), g.indexOf('\n}\n', g.indexOf('export interface GreetingPorts {')))
    const declared = [...block.matchAll(/^  (\w+)\(/gm)].map(m => m[1]).sort()
    expect(declared).toEqual(expected)
    const call = effect.slice(effect.indexOf('void runGreeting('))
    for (const key of expected) expect(call, key).toMatch(new RegExp(`\\n\\s+${key}[,:]`))
  })

  it('★ 直す前の形（greetedRef を直に比べて greet() を呼ぶ）には戻っていない', () => {
    expect(src).not.toContain('if (greetedRef.current === projectDir) return')
    expect(src).not.toContain('void greet()')
    expect(src).not.toContain('const greet = async')
    expect(src).not.toContain('maxTokens: 700')
  })

  it('AI Engine への直接の呼び出しは ChatPanel に1か所だけ（ports の chatStream）', () => {
    expect(countOf(src, 'sakura.chatStream(')).toBe(1)
  })

  it('★★★ 会話への書き換えは emit の1か所だけが渡し、いつも記録の口（applyOpToDir）へ送る', () => {
    const g = readCode('src/renderer/greeting.ts')
    expect(countOf(g, 'ports.applyOpToDir(')).toBe(1)
    expect(g).toContain('const emit = (op: Op): void => { ports.applyOpToDir(dir, op) }')
    // 書き換えの入口 6か所（キー無しの固定文・最初の吹き出し・返事の更新・時間切れ文・失敗文・あとから足す知らせ）は、すべて emit
    expect(countOf(g, 'emit({')).toBe(6)
  })

  it('greeting.ts は window・electronAPI・localStorage に触れない（ports だけで外へ出る）', () => {
    const g = readCode('src/renderer/greeting.ts')
    expect(g).not.toMatch(/electronAPI|window\.|localStorage|document\./)
  })

  it('保留中の依頼を判断へ渡す口が実在する（退避を取り出さずに見る）', () => {
    const n = readCode('src/renderer/newProjectRequest.ts')
    expect(n).toContain('export function hasNewProjectRequest(dir: string): boolean {')
  })
})

describe('T-5d: 会話の読み込み済みの印（convLoadedDir）は、読み込みが済んで client を付けたあとにだけ立つ（配線）', () => {
  const src = readCode('src/renderer/components/ChatPanel.tsx')
  const callAt = src.indexOf('loadConversationChecked(projectDir).then(')
  const effectStart = src.lastIndexOf('useEffect(', callAt)
  const effectEnd = src.indexOf('}, [projectDir, applyOpLocally])', callAt)
  const effect = src.slice(effectStart, effectEnd)
  const at = (needle: string): number => effect.indexOf(needle)

  it('読み込みの effect の範囲を取れている。読み込みは本物の loadConversationChecked で、印は effect の中の2か所だけが書く', () => {
    expect(callAt).toBeGreaterThan(-1)
    expect(effectStart).toBeGreaterThan(-1)
    expect(effectEnd).toBeGreaterThan(callAt)
    expect(countOf(src, 'loadConversationChecked(')).toBe(1)
    // 印を書く呼び出しは「消す」と「立てる」の2か所だけ。どちらも読み込みの effect の中
    expect(countOf(src, 'setConvLoadedDir(')).toBe(2)
    expect(countOf(effect, 'setConvLoadedDir(')).toBe(2)
    expect(src).toContain('const [convLoadedDir, setConvLoadedDir] = useState<string | null>(null)')
  })

  it('★★★ 切り替えで印を消す: client を捨てる行の隣で null にし、読み込みより前（切り替えた直後に古い印が残らない）', () => {
    expect(at('clientRef.current = null')).toBeGreaterThan(-1)
    expect(at('setConvLoadedDir(null)')).toBeGreaterThan(at('clientRef.current = null'))
    expect(at('setConvLoadedDir(null)')).toBeLessThan(at('if (!projectDir) { setMessages([]); return }'))
    expect(at('setConvLoadedDir(null)')).toBeLessThan(at('loadConversationChecked(projectDir)'))
  })

  it('★★★ 印を立てるのは、読み込みが返り（キャンセルでなく）、画面へ映し、client を付けたあと。読めたときだけ', () => {
    const load = at('loadConversationChecked(projectDir)')
    const cancelled = at('if (cancelled) return')
    const show = at('setMessages(msgs)')
    const client = at('clientRef.current = convClientOf(projectDir)')
    const mark = at('if (readable) setConvLoadedDir(projectDir)')
    expect(load).toBeGreaterThan(-1)
    expect(cancelled).toBeGreaterThan(load)
    expect(show).toBeGreaterThan(cancelled)
    expect(client).toBeGreaterThan(show)
    expect(mark).toBeGreaterThan(client)
    // 無条件に立てる形・読み込みの前に立てる形には戻っていない
    expect(effect).not.toContain('\n      setConvLoadedDir(projectDir)')
    expect(at('setConvLoadedDir(projectDir)')).toBe(mark + 'if (readable) '.length)
  })

  it('読み込みの結果は { messages, readable, unreadable } で受ける（読めたかも、読めなかった記録の知らせも捨てない）', () => {
    expect(effect).toContain('loadConversationChecked(projectDir).then(({ messages: msgs, readable, unreadable }) => {')
    expect(effect).not.toContain('.then(({ messages: msgs, readable }) => {')
  })
})

describe('T-5d: プロジェクトを開く入口6つは、すべて projectDir を変えて同じ effect に届く', () => {
  const app = readCode('src/renderer/App.tsx')

  it('★ App.tsx で currentDir を変える入口は6つ（setCurrentDir を直に呼ぶ3か所＋changeDir〔未保存の確かめを通る口。setCurrentDir の呼び出し1か所〕を通る3か所）', () => {
    expect(countOf(app, 'setCurrentDir(')).toBe(4)
    expect(countOf(app, 'onSetDir={changeDir}')).toBe(1)
    expect(countOf(app, 'void changeDir(dir)')).toBe(1)
    expect(countOf(app, 'await changeDir(root)')).toBe(1)
  })

  it('★ 入口側であいさつを呼ばない（止めるのは effect の判断の1か所だけ）', () => {
    expect(app).not.toMatch(/greet|decideGreeting|runGreeting|greetedRef/i)
  })

  it('★ ChatPanel は currentDir を projectDir として受ける（入口がどこでも同じ effect を通る）', () => {
    expect(app).toContain('<ChatPanel apiKey={sakuraApiKey} onSetApiKey={setApiKey} activeFile={activeFileObj} projectDir={currentDir}')
  })

  it('★ decideGreeting・runGreeting を呼ぶのは ChatPanel だけ（ほかの入口が直に呼んでいない）', () => {
    const walk = (dir: string): string[] => readdirSync(join(ROOT, dir), { withFileTypes: true })
      .flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : /\.(?:ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : [])
    const callers = walk('src')
      .filter(f => relative(ROOT, join(ROOT, f)) !== join('src', 'renderer', 'greeting.ts'))
      .filter(f => /\b(?:decideGreeting|runGreeting)\(/.test(readCode(f)))
      .sort()
    expect(callers).toEqual(['src/renderer/components/ChatPanel.tsx'])
  })
})

// ── あいさつの残り（途中で止めた会話）────────────────────────────────────────
const HID = { role: 'user', content: KICKOFF, hidden: true }
const EMPTY_AI = { role: 'assistant', content: '' }

describe('あいさつの残り: isGreetingLeftover', () => {
  it('隠した依頼文＋空の AI の吹き出しだけなら残り', () => {
    expect(isGreetingLeftover([HID, EMPTY_AI])).toBe(true)
  })
  it('空の会話・返事の文がある・利用者の発言がある・札だけ、は残りではない', () => {
    expect(isGreetingLeftover([])).toBe(false)
    expect(isGreetingLeftover([HID, { role: 'assistant', content: 'こんにちは' }])).toBe(false)
    expect(isGreetingLeftover([HID, EMPTY_AI, { role: 'user', content: 'ECサイトを作りたい' }])).toBe(false)
    expect(isGreetingLeftover([HID, { role: 'assistant', content: '', toolNote: true }])).toBe(false)
  })
  it('★ 画像を入れた旨の隠した発言（あいさつの依頼文ではない）は残りではない', () => {
    const IMG = { role: 'user', content: '画像を入れました: assets/a.png', hidden: true }
    expect(isGreetingLeftover([IMG, EMPTY_AI])).toBe(false)
    expect(isGreetingLeftover([IMG])).toBe(false)
    expect(decideGreeting({ ...ready, messagesLength: 1, messages: [{ role: 'user', content: 'x', hidden: true }] })).toEqual(NONE)
  })
})

describe('あいさつの残り: decideGreeting はやり直す', () => {
  const leftover = [HID, EMPTY_AI]
  it('★ 残りだけの会話では、空の会話と同じ判断（あいさつをやり直す）', () => {
    expect(decideGreeting({ ...ready, messagesLength: 2, messages: leftover })).toEqual({ action: 'ai', markGreeted: true })
    expect(decideGreeting({ ...ready, hasApiKey: false, messagesLength: 2, messages: leftover })).toEqual({ action: 'fixed', markGreeted: true })
  })
  it('★ 利用者が何か送ったあと（件数3・利用者の発言あり）はやり直さない', () => {
    const sent = [...leftover, { role: 'user', content: 'つくって' }]
    expect(decideGreeting({ ...ready, messagesLength: 3, messages: sent })).toEqual(NONE)
  })
  it('返事の文があるあいさつは出し直さない', () => {
    expect(decideGreeting({ ...ready, messagesLength: 2, messages: [HID, { role: 'assistant', content: 'やあ' }] })).toEqual(NONE)
  })
  it('残りでも、生成中・済んだ印・新規作成の保留中は出さない', () => {
    for (const patch of [{ isLoading: true }, { greetedDir: '/p/a' }, { newProjectPending: true }] as Array<Partial<GreetingInput>>) {
      expect(decideGreeting({ ...ready, messagesLength: 2, messages: leftover, ...patch })).toMatchObject({ action: 'none' })
    }
  })
  it('★ やり直しは追記でなく置き換え: 最初の op は replaceAll で、残りの2件を2組にしない', async () => {
    const ops: any[] = []
    const ports: GreetingPorts = {
      checkBeforeRequest: () => ({ allowed: true }),
      chatStream: async (_r, onDelta) => { onDelta('やあ'); return { usage: null } },
      recordUsage: () => {}, estimateTokens: () => 1,
      applyOpToDir: (_d, op) => { ops.push(op) },
      setLoading: () => {}, setAbort: () => {}, warn: () => {},
    }
    await runGreeting({ apiKey: 'k', model: 'm', projectContext: '', dir: '/p/a' }, ports)
    expect(ops[0]).toEqual({ kind: 'replaceAll', messages: [{ role: 'user', content: KICKOFF, hidden: true }, { role: 'assistant', content: '' }] })
    expect(ops.some(o => o.kind === 'append' && o.msg?.hidden)).toBe(false)
  })
  it('★ 画面は残りだけの会話で空の案内を出す（ChatPanel が isGreetingLeftover を通る）', () => {
    const src = readFileSync(join(__dirname, '..', 'src/renderer/components/ChatPanel.tsx'), 'utf-8')
    expect(src).toMatch(/isGreetingLeftover\(messages\)\) && !isLoading/)
    expect(src).toContain('      messages,\n')
  })
})
