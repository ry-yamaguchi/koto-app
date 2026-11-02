// 公開先を変えたあとの確認の配線（ChatPanel・App.tsx・吹き出しの型・useTargetCheck）。
//
//   A. 配線（コメントを除いたソースで、呼び出しの形ごと照合する）
//      入口1つ（App.tsx の changeTarget が dir を運ぶ）・受け手1つ（ChatPanel のハンドラは onTargetChanged を呼ぶだけで
//      送らない）・吹き出しの型2か所・ボタンは応答中 disabled・ChatPanel が小さくなっている
//   B. 振る舞い: 本物の useAiChat と本物の useTargetCheck を、偽の React・偽の electronAPI で動かす。
//      公開先が変わった知らせだけでは claude.chatStart・chatTurn.start・sakura.chatStream が0回。
//      ボタンの経路（press）は chatStart を1回だけ呼ぶ。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// ── 偽の React（フックを呼び出し順の置き場で動かす最小の実装）─────────────────
const rt = vi.hoisted(() => ({
  slots: [] as any[],
  i: 0,
  effects: [] as Array<() => void | (() => void)>,
}))
vi.mock('react', async () => {
  const actual = await vi.importActual<any>('react')
  const useRef = (init: unknown) => { const s = (rt.slots[rt.i] ??= { current: init }); rt.i++; return s }
  const useState = (init: unknown) => {
    const idx = rt.i++
    const s = (rt.slots[idx] ??= { v: typeof init === 'function' ? (init as () => unknown)() : init })
    return [s.v, (n: unknown) => { s.v = typeof n === 'function' ? (n as (p: unknown) => unknown)(s.v) : n }]
  }
  const useCallback = (fn: unknown) => { rt.i++; return fn }
  const useEffect = (fn: () => void | (() => void), deps?: unknown[]) => {
    const idx = rt.i++
    const prev = rt.slots[idx] as { deps?: unknown[] } | undefined
    const changed = !deps || !prev || !prev.deps || deps.length !== prev.deps.length || deps.some((d, k) => !Object.is(d, prev.deps![k]))
    rt.slots[idx] = { deps }
    if (changed) rt.effects.push(fn)
  }
  const useSyncExternalStore = (_sub: unknown, snap: () => unknown) => { rt.i++; return snap() }
  const hooks = { useRef, useState, useCallback, useEffect, useSyncExternalStore }
  return { ...actual, ...hooks, default: { ...(actual.default ?? actual), ...hooks } }
})
vi.mock('../src/renderer/components/CredentialsModal', () => ({
  getAnthropicToken: async () => 'sk-ant-test-key',
}))

import { useAiChat } from '../src/renderer/hooks/useAiChat'
import { useTargetCheck, makeTargetCheckPorts, resetTargetCheckSpent, isOtherProjectLoading, type TargetCheckIo } from '../src/renderer/hooks/useTargetCheck'
import { onTargetChanged, targetCheckButtonState, buildTargetCheckPrompt, TARGET_CHECK_OTHER_BUSY_NOTE, TARGET_CHECK_STALE_NOTE } from '../src/renderer/targetCheck'
import { getTargetProfile } from '../src/renderer/targetProfiles'
import { CLAUDE_CONSENT_KEY } from '../src/renderer/claudeMode'
import { resetTurn, turnKey, updateTurn, CHAT_APP_KEY } from '../src/renderer/chatTurnRegistry'
import { applyToMessages } from '../src/shared/chatEvents'
import { forStorage } from '../src/shared/chatStorage'

const ROOT = path.join(__dirname, '..')

// ── A. 配線（コメントを除いたソース）──────────────────────────────────────────
const readCode = (rel: string): string =>
  fs.readFileSync(path.join(ROOT, rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => { const t = line.trim(); return !t.startsWith('//') && !t.startsWith('*') })
    .join('\n')

function walk(rel: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
    const r = `${rel}/${e.name}`
    if (e.isDirectory()) walk(r, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(r)
  }
  return out
}
const SRC_FILES = walk('src')
const filesWith = (needle: string | RegExp): string[] =>
  SRC_FILES.filter(f => {
    const code = readCode(f)
    return typeof needle === 'string' ? code.includes(needle) : needle.test(code)
  })

/** 型の宣言 `export type <name> = {` から、閉じる `}` までの本文 */
function typeBlock(code: string, name: string): string {
  const start = code.indexOf(`export type ${name} = {`)
  expect(start, `${name} の宣言`).toBeGreaterThanOrEqual(0)
  return code.slice(start, code.indexOf('\n}\n', start))
}

/** ChatPanel の `sakura-target-changed` を受ける effect の範囲（useEffect( から依存配列の行まで） */
function handlerRange(code: string): string {
  const at = code.indexOf("addEventListener('sakura-target-changed'")
  expect(at, "addEventListener('sakura-target-changed'").toBeGreaterThan(0)
  const start = code.lastIndexOf('useEffect(', at)
  const end = code.indexOf('\n  }, [', at)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(at)
  return code.slice(start, end)
}

describe('A. 配線', () => {
  const panel = readCode('src/renderer/components/ChatPanel.tsx')

  it('受け手1つ: ChatPanel の sakura-target-changed のハンドラは onTargetChanged を呼ぶだけで、送らない', () => {
    expect(panel.split("addEventListener('sakura-target-changed'")).toHaveLength(2)
    expect(panel.split("removeEventListener('sakura-target-changed'")).toHaveLength(2)
    const range = handlerRange(panel)
    expect(range).toContain('void onTargetChanged((e as CustomEvent<TargetChangedDetail>).detail, targetCheck.ports)')
    // 送る形（chat.send(・send(）も、送り先の頭脳へ直に触る形も、ハンドラの範囲に無い
    expect(range).not.toMatch(/send\(/)
    expect(range).not.toContain('chat.')
    expect(range).not.toContain('chatStart')
    expect(range).not.toContain('chatTurn')
    expect(range).not.toContain('chatStream')
    expect(range.split('\n').length).toBeLessThanOrEqual(8)
  })

  it('onTargetChanged を呼ぶのは ChatPanel だけ。runTargetCheck を呼ぶのは useTargetCheck だけ', () => {
    expect(filesWith(/\bonTargetChanged\(/).sort()).toEqual([
      'src/renderer/components/ChatPanel.tsx',
      'src/renderer/targetCheck.ts',
    ])
    expect(filesWith(/\brunTargetCheck\(/).sort()).toEqual([
      'src/renderer/hooks/useTargetCheck.ts',
      'src/renderer/targetCheck.ts',
    ])
  })

  it('自動で送る旧い作りが残っていない（lastCheckedTargetRef・shouldAutoCheckTarget・旧い依頼文の置き場）', () => {
    expect(filesWith('lastCheckedTargetRef')).toEqual([])
    expect(filesWith('shouldAutoCheckTarget')).toEqual([])
    // 依頼文は targetCheck.ts の1か所だけ（ハンドラに複製を持たない）
    expect(filesWith('今のコードがこの公開先でそのまま動くか確認してください')).toEqual(['src/renderer/targetCheck.ts'])
    expect(panel).not.toContain('getTargetProfile')
    expect(panel).not.toContain('buildPublishStatusRows')
  })

  it('useTargetCheck: 送る口は send の1つだけ（live().send）で、ChatPanel はそこへ chat.send を渡す', () => {
    const hook = readCode('src/renderer/hooks/useTargetCheck.ts')
    expect(hook.match(/\.send\(/g)).toHaveLength(1)
    expect(hook).toContain('send: (text, images) => live().send(text, images)')
    expect(hook).toContain('otherProjectBusy: () => live().claudeActive && isOtherProjectLoading(live().projectDir),')
    expect(panel.split('useTargetCheck({')).toHaveLength(2)
    expect(panel).toContain('send: chat.send')
    expect(panel).toContain('isBusy: isLoading')
  })

  it('useTargetCheck への渡し物は7つすべて（渡し忘れ・空の関数への差し替え・あとからの上書きが無い）', () => {
    // 呼び出しの引数の本文を、前後の空白を除いて丸ごと照合する。7つのうち1つでも抜く・別の値にする・足すと落ちる。
    // 型検査は通る形（空の関数・空文字・false）なので、ここで固定する。
    const at = panel.indexOf('useTargetCheck({')
    expect(at).toBeGreaterThan(-1)
    const body = panel.slice(at + 'useTargetCheck({'.length, panel.indexOf('\n  })', at)).trim()
    expect(body).toBe('projectDir, apiKey, claudeActive, isBusy: isLoading, applyOp, applyProjectCtx, send: chat.send,')
    // 渡す元も実物: applyProjectCtx は ref と state を同時に更新する ChatPanel の関数、isLoading は応答中とあいさつ中の両方
    expect(panel).toContain('const applyProjectCtx = useCallback((v: { dir: string; ctx: string } | null) => {\n    projectCtxRef.current = v\n    setProjectCtx(v)\n  }, [])')
    expect(panel).toContain('const isLoading = chat.isLoading || greetLoading')
  })

  it('入口1つ: sakura-target-changed を出すのは App.tsx の changeTarget だけで、変えたプロジェクトの dir を運ぶ', () => {
    expect(filesWith("new CustomEvent('sakura-target-changed'")).toEqual(['src/renderer/App.tsx'])
    expect(filesWith(/dispatchEvent\([^)]*sakura-target-changed/)).toEqual(['src/renderer/App.tsx'])
    const app = readCode('src/renderer/App.tsx')
    expect(app).toContain("new CustomEvent('sakura-target-changed', { detail: { target: newTarget, dir: currentDir } })")
    // 受け取る側（addEventListener）も ChatPanel の1か所だけ
    expect(filesWith("addEventListener('sakura-target-changed'")).toEqual(['src/renderer/components/ChatPanel.tsx'])
  })

  it('吹き出しの型2か所（ChatMessage・TurnMessage）に offerTargetCheck?: true がある', () => {
    expect(typeBlock(readCode('src/renderer/hooks/useAiChat.ts'), 'ChatMessage')).toContain('offerTargetCheck?: true')
    expect(typeBlock(readCode('src/shared/chatTurn.ts'), 'TurnMessage')).toContain('offerTargetCheck?: true')
    // 同じ名前の項目を持つ型は、この2か所だけ
    const typed = SRC_FILES.filter(f => /offerTargetCheck\?:/.test(readCode(f))).sort()
    expect(typed).toEqual(['src/renderer/hooks/useAiChat.ts', 'src/renderer/targetCheck.ts', 'src/shared/chatTurn.ts'])
  })

  it('ボタン: 応答中は disabled（chat.isLoading を渡す）。印・プロジェクト・押した時刻の記録・吹き出しの時刻・押したときの処理も渡す', () => {
    const tag = panel.match(/<TargetCheckButton[\s\S]*?\/>/)?.[0] ?? ''
    expect(tag).not.toBe('')
    expect(panel.split('<TargetCheckButton')).toHaveLength(2)
    expect(tag).toContain('offered={msg.offerTargetCheck}')
    expect(tag).toContain('dir={projectDir}')
    expect(tag).toContain('spent={targetCheck.spent}')
    // 吹き出しの時刻を渡す。無いと、押す前後を見分けられず、押したあとに出た新しい案内にもボタンが出ない
    expect(tag).toContain('at={msg.at}')
    expect(tag).toContain('isLoading={chat.isLoading}')
    expect(tag).toContain('onPress={() => void targetCheck.press()}')
  })

  it('ChatPanel.tsx の行数が減っている（この節を切り出す前は 1,372 行）。新しい部品は400行以下', () => {
    const lines = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8').split('\n').length
    expect(lines('src/renderer/components/ChatPanel.tsx')).toBeLessThan(1372)
    expect(lines('src/renderer/hooks/useTargetCheck.ts')).toBeLessThanOrEqual(400)
    expect(lines('src/renderer/components/TargetCheckButton.tsx')).toBeLessThanOrEqual(400)
  })

  it('新しい部品に、開発環境のパスを書いていない', () => {
    for (const f of ['src/renderer/hooks/useTargetCheck.ts', 'src/renderer/components/TargetCheckButton.tsx']) {
      expect(fs.readFileSync(path.join(ROOT, f), 'utf-8'), f).not.toMatch(/\/Users\/|\/home\//)
    }
  })
})

describe('A2. 吹き出しの印は会話の保存に残る', () => {
  const bubble = { role: 'assistant' as const, content: 'ℹ️ 公開先を「X」に変えました。', offerTargetCheck: true as const }

  it('保存用に整えても残る（落ちるのは thinking だけ）', () => {
    const [saved] = forStorage([{ ...bubble, thinking: '考え中' }])
    expect(saved.offerTargetCheck).toBe(true)
    expect(saved).not.toHaveProperty('thinking')
  })

  it('会話へ足しても残る', () => {
    const next = applyToMessages([], { kind: 'append', msg: bubble })
    expect(next).toHaveLength(1)
    expect(next[0].offerTargetCheck).toBe(true)
  })
})

// ── B. 振る舞い ─────────────────────────────────────────────────────────────
const PROJECT = '/Users/test/koto-project-a'
const OTHER_PROJECT = '/Users/test/koto-project-b'
const TARGET = 'sakura-apprun'

let store: Map<string, string>
let files: Map<string, string>
let chatStartCalls: Array<{ projectDir: string; text: string }>
let chatTurnStartCalls: number
let chatStreamCalls: number
let streamListener: ((ev: any) => void) | null
/** window.electronAPI.fs.latestChangeAt の答え（io を渡さない本物の配線が読む） */
let latestAnswer: { ok: boolean; latest: string | null; files?: number }
let bubbles: Array<Record<string, unknown>>
let contexts: Array<{ dir: string; ctx: string }>
/** 文脈の反映（ctx）と送信（chatStart）が起きた順 */
let events: string[]

beforeEach(() => {
  store = new Map()
  files = new Map()
  chatStartCalls = []
  chatTurnStartCalls = 0
  chatStreamCalls = 0
  streamListener = null
  latestAnswer = { ok: true, latest: null, files: 0 }
  bubbles = []
  contexts = []
  events = []
  rt.slots = []
  rt.i = 0
  rt.effects = []
  resetTargetCheckSpent()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
  })
  vi.stubGlobal('window', {
    electronAPI: {
      win: { setBusy: () => {} },
      fs: {
        readFile: async (p: string) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p)! },
        projectFiles: async () => [],
        latestChangeAt: async () => latestAnswer,
      },
      chatTurn: { start: async () => { chatTurnStartCalls++ } },
      sakura: { chatStream: async () => { chatStreamCalls++ } },
      claude: {
        onStream: (cb: (ev: any) => void) => { streamListener = cb; return () => { if (streamListener === cb) streamListener = null } },
        chatCancel: () => {},
        chatStart: async (projectDir: string, _key: string, text: string) => {
          chatStartCalls.push({ projectDir, text })
          events.push('chatStart')
          setTimeout(() => { streamListener?.({ kind: 'result', costUsd: 0, durationMs: 1, isError: false }) }, 0)
        },
      },
    },
  })
  store.set(CLAUDE_CONSENT_KEY, '1')
  setMeta(PROJECT, { name: 'a', target: TARGET })
})
afterEach(() => {
  resetTurn(turnKey(PROJECT, 'x'))
  resetTurn(turnKey(OTHER_PROJECT, 'x'))
  vi.unstubAllGlobals()
})

function setMeta(dir: string, meta: Record<string, unknown>) {
  files.set(`${dir}/.sakuraide.json`, JSON.stringify(meta))
}
const tick = () => new Promise<void>(r => setTimeout(r, 0))
async function settle(n = 20) { for (let i = 0; i < n; i++) await tick() }
async function waitUntil(cond: () => boolean, label: string) {
  for (let i = 0; i < 400; i++) { if (cond()) return; await tick() }
  throw new Error(`時間切れ: ${label}`)
}

interface Live { projectDir: string | null; apiKey: string; claudeActive: boolean; isBusy?: boolean }

/** useAiChat と useTargetCheck を1回描画する（ChatPanel が同じ順で呼ぶ形）。effect も実行する。 */
function renderAll(live: Partial<Live> = {}, io?: TargetCheckIo) {
  rt.i = 0
  rt.effects = []
  const l: Live = { projectDir: PROJECT, apiKey: '', claudeActive: true, ...live }
  const chat = useAiChat({
    apiKey: l.apiKey,
    model: '', models: [], maxRounds: 5,
    buildSystemPrompt: () => '',
    toolsProjectDir: PROJECT, convDir: PROJECT, sessionId: 'x',
    buildExecuteOpts: () => ({ writeMode: 'auto' }),
    getHistory: () => [],
    updateShown: () => {},
    onMessageEvent: () => {},
    confirm: async () => true,
  } as any)
  const tc = useTargetCheck({
    projectDir: l.projectDir,
    apiKey: l.apiKey,
    claudeActive: l.claudeActive,
    isBusy: l.isBusy ?? chat.isLoading,
    applyOp: (op) => { if (op.kind === 'append') bubbles.push(op.msg as Record<string, unknown>) },
    applyProjectCtx: (v) => { if (v) { contexts.push(v); events.push('ctx') } },
    send: chat.send,
  }, io)
  for (const e of rt.effects) e()
  return { chat, tc }
}

const noAiCalls = () => {
  expect(chatStartCalls, 'claude.chatStart').toHaveLength(0)
  expect(chatTurnStartCalls, 'chatTurn.start').toBe(0)
  expect(chatStreamCalls, 'sakura.chatStream').toBe(0)
}

describe('T-4f 公開先が変わった知らせだけでは、どの頭脳へも送らない', () => {
  it('制約のある公開先: 吹き出し1つ（ボタンの印つき）。chatStart・chatTurn.start・chatStream は0回', async () => {
    const { tc } = renderAll()
    await onTargetChanged({ target: TARGET, dir: PROJECT }, tc.ports)
    await settle()
    expect(bubbles).toHaveLength(1)
    expect(bubbles[0].offerTargetCheck).toBe(true)
    expect(String(bubbles[0].content)).toContain(getTargetProfile(TARGET).label)
    noAiCalls()
    expect(contexts).toEqual([]) // 文脈の読み直しもしない（送る準備もしない）
  })

  it('local・other: 吹き出しも出さず、送らない', async () => {
    for (const target of ['local', 'other']) {
      const { tc } = renderAll()
      await onTargetChanged({ target, dir: PROJECT }, tc.ports)
    }
    await settle()
    expect(bubbles).toEqual([])
    noAiCalls()
  })

  it('Claude のキーだけ（apiKey 空・claudeActive）でも、変えただけでは送らず、ボタンの印は付く', async () => {
    const { tc } = renderAll({ apiKey: '', claudeActive: true })
    await onTargetChanged({ target: TARGET, dir: PROJECT }, tc.ports)
    await settle()
    expect(bubbles).toHaveLength(1)
    expect(bubbles[0].offerTargetCheck).toBe(true)
    noAiCalls()
  })

  it('AI Engine のキーがあって Claude もオンでも、変えただけでは送らない（以前は自動で Claude へ飛んだ形）', async () => {
    const { tc } = renderAll({ apiKey: 'sk-test', claudeActive: true })
    await onTargetChanged({ target: TARGET, dir: PROJECT }, tc.ports)
    await settle()
    expect(bubbles).toHaveLength(1)
    noAiCalls()
  })

  it('どちらのキーも無い回は、案内の吹き出しだけでボタンの印は付かない。送らない', async () => {
    const { tc } = renderAll({ apiKey: '', claudeActive: false })
    await onTargetChanged({ target: TARGET, dir: PROJECT }, tc.ports)
    await settle()
    expect(bubbles).toHaveLength(1)
    expect(bubbles[0]).not.toHaveProperty('offerTargetCheck')
    noAiCalls()
  })

  it('別のプロジェクトの知らせ（dir が違う・dir が無い）は捨てる: 吹き出しを置かず、送らない', async () => {
    const { tc } = renderAll()
    await onTargetChanged({ target: TARGET, dir: OTHER_PROJECT }, tc.ports)
    await onTargetChanged({ target: TARGET }, tc.ports)
    await settle()
    expect(bubbles).toEqual([])
    noAiCalls()
  })

  it('知らせを待っている間にプロジェクトが切り替わったら、吹き出しを置かない', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const io: TargetCheckIo = {
      readFile: async (p) => { await gate; return window.electronAPI.fs.readFile(p) },
      latestChangeAt: async () => ({ ok: true, latest: null }),
      buildContext: async () => '',
    }
    const { tc } = renderAll({}, io)
    const pending = onTargetChanged({ target: TARGET, dir: PROJECT }, tc.ports)
    renderAll({ projectDir: OTHER_PROJECT }, io) // 描き直し（開いているプロジェクトが変わる）
    release()
    await pending
    expect(bubbles).toEqual([])
    noAiCalls()
  })
})

describe('T-4f io を渡さない本物の配線は、electronAPI の fs.latestChangeAt で「公開後にコードが変わったか」を読む', () => {
  const PUBLISHED_AT = '2026-10-01T00:00:00.000Z'
  const publishedMeta = () => setMeta(PROJECT, {
    name: 'a', target: TARGET, publish: { targets: { [TARGET]: { publishedAt: PUBLISHED_AT, url: 'https://example.test/' } } },
  })

  it('公開後に変更あり: 実績の案内に一言を添え、ボタンの印が付く。送らない', async () => {
    publishedMeta()
    latestAnswer = { ok: true, latest: '2026-10-05T00:00:00.000Z' }
    const { tc } = renderAll() // io を渡さない
    await onTargetChanged({ target: TARGET, dir: PROJECT }, tc.ports)
    await settle()
    expect(bubbles).toHaveLength(1)
    expect(bubbles[0].offerTargetCheck).toBe(true)
    expect(String(bubbles[0].content)).toContain(TARGET_CHECK_STALE_NOTE)
    noAiCalls()
  })

  it('対照: 公開後に変更なし → 実績の案内だけで、一言もボタンの印も付かない', async () => {
    publishedMeta()
    latestAnswer = { ok: true, latest: '2026-09-30T00:00:00.000Z' }
    const { tc } = renderAll()
    await onTargetChanged({ target: TARGET, dir: PROJECT }, tc.ports)
    await settle()
    expect(bubbles).toHaveLength(1)
    expect(bubbles[0]).not.toHaveProperty('offerTargetCheck')
    expect(String(bubbles[0].content)).not.toContain(TARGET_CHECK_STALE_NOTE)
  })

  it('読めなかった答え（ok:false）は、公開後の時刻が入っていても使わない（一言もボタンの印も付かない）', async () => {
    publishedMeta()
    latestAnswer = { ok: false, latest: '2026-10-05T00:00:00.000Z' }
    const { tc } = renderAll()
    await onTargetChanged({ target: TARGET, dir: PROJECT }, tc.ports)
    await settle()
    expect(bubbles).toHaveLength(1)
    expect(bubbles[0]).not.toHaveProperty('offerTargetCheck')
    expect(String(bubbles[0].content)).not.toContain(TARGET_CHECK_STALE_NOTE)
  })
})

describe('T-4f ボタンの経路（press）は chatStart を1回だけ呼ぶ', () => {
  it('押すと、今の公開先を確かめる依頼が chatStart へ1回だけ届く。文脈は送る前に読み直す', async () => {
    const { tc } = renderAll()
    await onTargetChanged({ target: TARGET, dir: PROJECT }, tc.ports)
    noAiCalls()
    await tc.press()
    await waitUntil(() => chatStartCalls.length >= 1, 'chatStart')
    await settle()
    expect(chatStartCalls).toHaveLength(1)
    expect(chatStartCalls[0].projectDir).toBe(PROJECT)
    expect(chatStartCalls[0].text).toBe(buildTargetCheckPrompt(getTargetProfile(TARGET).label))
    expect(chatStartCalls[0].text.startsWith(`公開先を「${getTargetProfile(TARGET).label}」に変更しました。`)).toBe(true)
    expect(chatTurnStartCalls).toBe(0)
    expect(chatStreamCalls).toBe(0)
    expect(contexts).toHaveLength(1)
    expect(contexts[0].dir).toBe(PROJECT)
    expect(contexts[0].ctx).toContain('公開先')
  })

  it('文脈の反映（applyProjectCtx）は、送信（chatStart）より先に、ちょうど1回起きる（送信が新しい公開先の前提で組まれる）', async () => {
    const { tc } = renderAll()
    await tc.press()
    await waitUntil(() => chatStartCalls.length >= 1, 'chatStart')
    await settle()
    expect(events).toEqual(['ctx', 'chatStart'])
  })

  it('押した時点の公開先で確かめる（吹き出しを出したあとに変えても、新しい公開先の話になる）', async () => {
    const { tc } = renderAll()
    await onTargetChanged({ target: TARGET, dir: PROJECT }, tc.ports)
    setMeta(PROJECT, { name: 'a', target: 'hanamii' })
    await tc.press()
    await waitUntil(() => chatStartCalls.length >= 1, 'chatStart')
    expect(chatStartCalls[0].text.startsWith(`公開先を「${getTargetProfile('hanamii').label}」に変更しました。`)).toBe(true)
  })

  it('押したあとは、そのプロジェクトのボタンが隠れる（描き直した次の描画で。ほかのプロジェクトは隠れない）', async () => {
    const first = renderAll()
    const before = targetCheckButtonState({ offered: true, dir: PROJECT, spent: first.tc.spent, isLoading: false })
    expect(before.show).toBe(true)
    await first.tc.press()
    await waitUntil(() => chatStartCalls.length >= 1, 'chatStart')
    await settle()
    const second = renderAll()
    expect(targetCheckButtonState({ offered: true, dir: PROJECT, spent: second.tc.spent, isLoading: false }).show).toBe(false)
    expect(targetCheckButtonState({ offered: true, dir: OTHER_PROJECT, spent: second.tc.spent, isLoading: false }).show).toBe(true)
  })

  it('押した時刻は押し始めに取り、そのプロジェクトの分として残る。押す前の吹き出しは隠れ、押している間に出た吹き出しには出る', async () => {
    let clock = Date.parse('2026-10-29T10:00:00.000Z')
    const io: TargetCheckIo = {
      readFile: (p) => window.electronAPI.fs.readFile(p),
      latestChangeAt: async () => ({ ok: true, latest: null }),
      buildContext: async () => { clock += 5000; return '' }, // 押している間に時間が進む
      now: () => new Date(clock),
    }
    const first = renderAll({}, io)
    await first.tc.press()
    await waitUntil(() => chatStartCalls.length >= 1, 'chatStart')
    await settle()
    const spent = renderAll({}, io).tc.spent
    expect(spent.get(PROJECT)).toBe('2026-10-29T10:00:00.000Z')
    const stateAt = (at: string | undefined) => targetCheckButtonState({ offered: true, dir: PROJECT, spent, isLoading: false, at }).show
    expect(stateAt('2026-10-29T09:59:59.000Z')).toBe(false)
    expect(stateAt('2026-10-29T10:00:03.000Z')).toBe(true)
    expect(stateAt(undefined)).toBe(false)
  })

  it('パネルが作り直されても、押し終えた印は残る（開き直して同じボタンがまた出ない）', async () => {
    const first = renderAll()
    await first.tc.press()
    await waitUntil(() => chatStartCalls.length >= 1, 'chatStart')
    await settle()
    rt.slots = [] // パネルの作り直し（フックの置き場が空になる）
    const remounted = renderAll()
    expect(remounted.tc.spent.has(PROJECT)).toBe(true)
  })

  it('押し直しが重なっても、送るのは1回', async () => {
    const { tc } = renderAll()
    await Promise.all([tc.press(), tc.press(), tc.press()])
    await waitUntil(() => chatStartCalls.length >= 1, 'chatStart')
    await settle()
    expect(chatStartCalls).toHaveLength(1)
  })

  it('応答中は押しても送らない。印も付けない（応答が終われば、また押せる）', async () => {
    const busy = renderAll({ isBusy: true })
    await busy.tc.press()
    await settle()
    noAiCalls()
    expect(renderAll().tc.spent.has(PROJECT)).toBe(false)
  })

  it('押した時点の公開先が local・other に変わっていたら送らない。もう確かめる意味が無いのでボタンは隠れる', async () => {
    const { tc } = renderAll()
    await onTargetChanged({ target: TARGET, dir: PROJECT }, tc.ports)
    setMeta(PROJECT, { name: 'a', target: 'local' })
    await tc.press()
    await settle()
    noAiCalls()
    expect(renderAll().tc.spent.has(PROJECT)).toBe(true)
  })

  it('押している間にプロジェクトが切り替わっても、押し終えた印は「押したプロジェクト」に付く', async () => {
    setMeta(PROJECT, { name: 'a', target: 'local' })
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    let started = false
    const io: TargetCheckIo = {
      readFile: async (p) => { started = true; await gate; return window.electronAPI.fs.readFile(p) },
      latestChangeAt: async () => ({ ok: true, latest: null }),
      buildContext: async () => '',
    }
    const { tc } = renderAll({}, io)
    const pressing = tc.press()
    await waitUntil(() => started, '公開先の読み取り開始')
    renderAll({ projectDir: OTHER_PROJECT }, io) // 押している間に、開いているプロジェクトが変わる
    release()
    await pressing
    const spent = renderAll({ projectDir: PROJECT }).tc.spent
    expect(spent.has(PROJECT)).toBe(true)
    expect(spent.has(OTHER_PROJECT)).toBe(false)
    noAiCalls()
  })

  it('Claude のキーだけ（apiKey 空・claudeActive）でも、押せば chatStart が1回', async () => {
    const { tc } = renderAll({ apiKey: '', claudeActive: true })
    await tc.press()
    await waitUntil(() => chatStartCalls.length >= 1, 'chatStart')
    await settle()
    expect(chatStartCalls).toHaveLength(1)
  })
})

describe('ほかのプロジェクトで AI が作業中のとき（Claude が送り先の回）は、押しても送らない', () => {
  it('★ 押しても chatStart を呼ばない。押した会話に一言だけ置く。ボタンは隠れず、終わったあとに押せば1回送る', async () => {
    updateTurn(OTHER_PROJECT, { isLoading: true }) // ほかのプロジェクトの Claude が作業中
    const { tc } = renderAll({ apiKey: '', claudeActive: true })
    await tc.press()
    await settle()
    noAiCalls()
    expect(contexts).toEqual([])
    expect(bubbles).toEqual([{ role: 'assistant', content: TARGET_CHECK_OTHER_BUSY_NOTE }])
    expect(renderAll().tc.spent.has(PROJECT)).toBe(false)
    resetTurn(OTHER_PROJECT) // ほかのプロジェクトの作業が終わる
    await tc.press()
    await waitUntil(() => chatStartCalls.length >= 1, 'chatStart')
    await settle()
    expect(chatStartCalls).toHaveLength(1)
    expect(chatStartCalls[0].projectDir).toBe(PROJECT)
  })

  it('対照: ほかのプロジェクトが作業中でなければ送る。一言は出ない', async () => {
    const { tc } = renderAll({ apiKey: '', claudeActive: true })
    await tc.press()
    await waitUntil(() => chatStartCalls.length >= 1, 'chatStart')
    await settle()
    expect(chatStartCalls).toHaveLength(1)
    expect(bubbles).toEqual([])
  })

  it('送り先が Claude でない回（claudeActive が偽）は見ない。AI Engine の応答はプロジェクトごとに独立している', () => {
    updateTurn(OTHER_PROJECT, { isLoading: true })
    const live = (claudeActive: boolean) => ({ projectDir: PROJECT as string | null, apiKey: 'sk-test', claudeActive, isBusy: false, applyOp: () => {}, applyProjectCtx: () => {}, send: () => {} })
    expect(makeTargetCheckPorts(() => live(false)).otherProjectBusy()).toBe(false)
    expect(makeTargetCheckPorts(() => live(true)).otherProjectBusy()).toBe(true)
  })

  it('自分のプロジェクトの作業は「ほか」に数えない（それは isBusy が見る）', () => {
    updateTurn(PROJECT, { isLoading: true })
    const live = { projectDir: PROJECT as string | null, apiKey: '', claudeActive: true, isBusy: false, applyOp: () => {}, applyProjectCtx: () => {}, send: () => {} }
    expect(makeTargetCheckPorts(() => live).otherProjectBusy()).toBe(false)
    updateTurn(OTHER_PROJECT, { isLoading: true })
    expect(makeTargetCheckPorts(() => live).otherProjectBusy()).toBe(true)
  })

  it('isOtherProjectLoading: 自分のプロジェクトと単独チャット（プロジェクトを持たない）は数えない', () => {
    expect(isOtherProjectLoading(PROJECT, [])).toBe(false)
    expect(isOtherProjectLoading(PROJECT, [PROJECT])).toBe(false)
    expect(isOtherProjectLoading(PROJECT, [CHAT_APP_KEY])).toBe(false)
    expect(isOtherProjectLoading(PROJECT, [`${CHAT_APP_KEY}:s1`])).toBe(false)
    expect(isOtherProjectLoading(PROJECT, [OTHER_PROJECT])).toBe(true)
    expect(isOtherProjectLoading(PROJECT, [PROJECT, CHAT_APP_KEY, OTHER_PROJECT])).toBe(true)
  })
})

describe('文脈の読み直し: 読んでいる間にプロジェクトが切り替わったら、その文脈は置かず、送らない', () => {
  function deferredIo() {
    const pending: { release: (ctx: string) => void } = { release: () => {} }
    let started = false
    const io: TargetCheckIo = {
      readFile: (p) => window.electronAPI.fs.readFile(p),
      latestChangeAt: async () => ({ ok: true, latest: null }),
      buildContext: () => new Promise<string>(r => { started = true; pending.release = r }),
    }
    return { io, pending, hasStarted: () => started }
  }

  it('対照: 切り替わらなければ、文脈を置いてから送る', async () => {
    const d = deferredIo()
    const { tc } = renderAll({}, d.io)
    const p = tc.press()
    await waitUntil(d.hasStarted, '文脈の読み込み開始')
    d.pending.release('文脈A')
    await p
    await waitUntil(() => chatStartCalls.length >= 1, 'chatStart')
    expect(contexts).toEqual([{ dir: PROJECT, ctx: '文脈A' }])
    expect(chatStartCalls).toHaveLength(1)
  })

  it('切り替わったら、古い文脈を置かず、送らない', async () => {
    const d = deferredIo()
    const { tc } = renderAll({}, d.io)
    const p = tc.press()
    await waitUntil(d.hasStarted, '文脈の読み込み開始')
    renderAll({ projectDir: OTHER_PROJECT }, d.io) // 開いているプロジェクトが変わる
    d.pending.release('文脈A')
    await p
    await settle()
    expect(contexts).toEqual([])
    noAiCalls()
  })

  it('makeTargetCheckPorts: 文脈を読めなかったら投げる（runTargetCheck が送らずに止まる側）', async () => {
    const live = { projectDir: PROJECT as string | null, apiKey: '', claudeActive: true, isBusy: false, applyOp: () => {}, applyProjectCtx: () => {}, send: () => {} }
    const ports = makeTargetCheckPorts(() => live, {
      readFile: async () => '', latestChangeAt: async () => ({ ok: true, latest: null }),
      buildContext: async () => { throw new Error('読めない') },
    })
    await expect(ports.refreshProjectContext(PROJECT)).rejects.toThrow('読めない')
  })
})
