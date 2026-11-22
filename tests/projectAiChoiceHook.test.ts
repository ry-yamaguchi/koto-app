// tests/projectAiChoiceHook.test.ts — 本物の useProjectAiChoice（チャット欄の使う AI とモデルを決めるフック）。
//
// 偽の React（フックを呼び出し順の置き場で動かし、effect は依存が変わったときだけ描画のあとに走らせる）・偽の localStorage・
// 偽のモデル一覧で動かし、次のことを確かめる。
//   - 表示は、描画の中でそのプロジェクトの記憶 → 設定の既定の順に決まる（別のプロジェクトの値が1描画も出ない）
//   - 上の選択は、そのプロジェクトの記憶だけを書き、設定の既定を書かない
//   - 提供終了のモデルの記憶は、一覧を取り直して確かめてから消し、案内は1回だけ（回の途中には出さない）
// ソースの文字列は見ない。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const rt = vi.hoisted(() => ({
  slots: [] as any[],
  i: 0,
  effects: [] as Array<() => void | (() => void)>,
  /** さくらの一覧（useModelList の答え） */
  sakura: { models: [] as { id: string; label: string }[], live: true },
  claude: { models: [] as { id: string; label: string }[], live: true },
  /** 取り直しの答え（null は取れなかった） */
  refetchSakura: null as null | (() => Promise<string[] | null>),
  refetchClaude: null as null | (() => Promise<string[] | null>),
  token: null as string | null,
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
    const prev = rt.slots[idx] as { deps?: unknown[]; cleanup?: () => void } | undefined
    const changed = !deps || !prev || !prev.deps || deps.length !== prev.deps.length || deps.some((d, k) => !Object.is(d, prev.deps![k]))
    const slot: { deps?: unknown[]; cleanup?: () => void } = prev ?? {}
    rt.slots[idx] = slot
    if (changed) {
      rt.effects.push(() => {
        slot.cleanup?.()
        slot.deps = deps
        const c = fn()
        slot.cleanup = typeof c === 'function' ? c : undefined
      })
    }
  }
  const useSyncExternalStore = (_sub: unknown, snap: () => unknown) => { rt.i++; return snap() }
  const hooks = { useRef, useState, useCallback, useEffect, useSyncExternalStore }
  return { ...actual, ...hooks, default: { ...(actual.default ?? actual), ...hooks } }
})
vi.mock('../src/renderer/components/CredentialsModal', () => ({
  getAnthropicToken: async () => rt.token,
}))
vi.mock('../src/renderer/hooks/useModels', () => ({
  useModelList: () => rt.sakura,
  refetchSakuraModelIds: () => (rt.refetchSakura ? rt.refetchSakura() : Promise.resolve(null)),
}))
vi.mock('../src/renderer/hooks/useClaudeModels', () => ({
  useClaudeModelList: () => rt.claude,
  refetchClaudeModelIds: () => (rt.refetchClaude ? rt.refetchClaude() : Promise.resolve(null)),
}))

// 案内を出した印はモジュールの中に覚えるので、テストごとにモジュールを読み直して持ち越さない。
let useProjectAiChoice: typeof import('../src/renderer/hooks/useProjectAiChoice').useProjectAiChoice
let rememberProjectAi: typeof import('../src/renderer/projectAi').rememberProjectAi
let readProjectAi: typeof import('../src/renderer/projectAi').readProjectAi
let retiredModelNoticeText: typeof import('../src/renderer/usage').retiredModelNoticeText
let modelLabel: typeof import('../src/renderer/usage').modelLabel
let updateTurn: typeof import('../src/renderer/chatTurnRegistry').updateTurn
let resetTurn: typeof import('../src/renderer/chatTurnRegistry').resetTurn
let turnKey: typeof import('../src/renderer/chatTurnRegistry').turnKey

const A = '/work/a'
const B = '/work/b'
const models = (...ids: string[]) => ids.map(id => ({ id, label: id }))

let store: Map<string, string>
let setKeys: string[]
let applyOp: ReturnType<typeof vi.fn>

beforeEach(async () => {
  vi.resetModules()
  ;({ useProjectAiChoice } = await import('../src/renderer/hooks/useProjectAiChoice'))
  ;({ rememberProjectAi, readProjectAi } = await import('../src/renderer/projectAi'))
  ;({ retiredModelNoticeText, modelLabel } = await import('../src/renderer/usage'))
  ;({ updateTurn, resetTurn, turnKey } = await import('../src/renderer/chatTurnRegistry'))
  store = new Map()
  setKeys = []
  applyOp = vi.fn()
  rt.slots = []
  rt.i = 0
  rt.effects = []
  rt.sakura = { models: models('m', 'm2', 'm3'), live: true }
  rt.claude = { models: models('claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'), live: true }
  rt.refetchSakura = null
  rt.refetchClaude = null
  rt.token = null
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { setKeys.push(k); store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
  })
  vi.stubGlobal('window', { dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} })
  store.set('sakura_claude_mode', 'off')
  store.set('sakura_model_ide', 'm')
})
afterEach(() => {
  resetTurn(turnKey(A))
  resetTurn(turnKey(B))
  vi.unstubAllGlobals()
})

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise<void>(r => setTimeout(r, 0)) }

function renderHook(o: { dir: string | null; apiKey?: string; convLoadedDir?: string | null }) {
  rt.i = 0
  rt.effects = []
  const r = useProjectAiChoice({
    projectDir: o.dir,
    apiKey: o.apiKey ?? 'k',
    convLoadedDir: o.convLoadedDir === undefined ? o.dir : o.convLoadedDir,
    applyOp,
  })
  for (const e of rt.effects) e()
  return r
}
/** 描いて、非同期の続き（キーの読み込み・取り直し）を流して、もう一度描く。 */
async function settle(o: Parameters<typeof renderHook>[0]) {
  renderHook(o)
  await flush()
  return renderHook(o)
}

describe('表示は、描画の中でそのプロジェクトの記憶 → 設定の既定の順に決まる', () => {
  it('H1: A がモデル m2 を覚えていても、記憶の無い B の描画に m2 は出ない（既定の m）', () => {
    rememberProjectAi(A, { brain: 'sakura', sakuraModel: 'm2' })
    expect(renderHook({ dir: A }).model).toBe('m2')
    expect(renderHook({ dir: B }).model).toBe('m')
    expect(renderHook({ dir: A }).model).toBe('m2')
  })

  it('H2: さくらのとき selectModel は、そのプロジェクトの記憶だけを書く（設定の既定は書かない）', () => {
    rememberProjectAi(A, { brain: 'sakura' })
    setKeys = []
    renderHook({ dir: A }).selectModel('m3')
    expect(setKeys).toEqual(['koto_project_ai:' + A])
    expect(store.get('sakura_model_ide')).toBe('m')
    expect(readProjectAi(A).sakuraModel).toBe('m3')
    expect(readProjectAi(B)).toEqual({})
    expect(renderHook({ dir: A }).model).toBe('m3')
  })

  it('H3: Claude のとき selectModel は claudeModel だけを書く（さくらのモデルと、設定の Claude の既定は書かない）', async () => {
    rt.token = 'sk-ant-test'
    rememberProjectAi(A, { brain: 'claude' })
    const r = await settle({ dir: A })
    expect(r.claudeActive).toBe(true)
    setKeys = []
    r.selectModel('claude-haiku-4-5')
    expect(setKeys).toEqual(['koto_project_ai:' + A])
    expect(readProjectAi(A)).toEqual({ brain: 'claude', claudeModel: 'claude-haiku-4-5' })
    expect(store.has('sakura_claude_model')).toBe(false)
  })

  it('H4: プロジェクトが無いとき selectModel は保存せず、次の描画の model がその選び', () => {
    const r = renderHook({ dir: null })
    expect(r.model).toBe('m')
    setKeys = []
    r.selectModel('m3')
    expect(setKeys).toEqual([])
    expect(renderHook({ dir: null }).model).toBe('m3')
  })

  it('H6: switchToClaudeHere は「記憶がさくら・さくらのキー無し・Claude のキー有り・プロジェクト有り」のときだけ関数。呼ぶと brain だけを claude にする', async () => {
    rt.token = 'sk-ant-test'
    rememberProjectAi(A, { brain: 'sakura', sakuraModel: 'm2' })
    const ok = await settle({ dir: A, apiKey: '' })
    expect(ok.choice.brain).toBeNull()
    expect(typeof ok.switchToClaudeHere).toBe('function')
    // さくらのキーがある・プロジェクトが無い、のときは関数にならない
    expect((await settle({ dir: A, apiKey: 'k' })).switchToClaudeHere).toBeNull()
    expect((await settle({ dir: null, apiKey: '' })).switchToClaudeHere).toBeNull()
    ok.switchToClaudeHere!()
    expect(readProjectAi(A)).toEqual({ brain: 'claude', sakuraModel: 'm2' })
  })

  it('H6: Claude のキーが無いときも関数にならない（キー無しの案内のまま）', async () => {
    rememberProjectAi(A, { brain: 'sakura' })
    expect((await settle({ dir: A, apiKey: '' })).switchToClaudeHere).toBeNull()
  })
})

describe('提供終了のモデルの記憶は、一覧を取り直して確かめてから消し、案内は1回だけ', () => {
  const NOTICE = () => retiredModelNoticeText('old', modelLabel('m'))

  it('H5: 記憶の old が live の一覧に無く、取り直しても無い → 記憶の項目が消え、案内が1回。描き直しても2回目は出ない', async () => {
    rememberProjectAi(A, { brain: 'sakura', sakuraModel: 'old' })
    rt.refetchSakura = async () => ['m', 'm2', 'm3']
    await settle({ dir: A })
    expect(readProjectAi(A).sakuraModel).toBeUndefined()
    expect(readProjectAi(A).brain).toBe('sakura') // AI の記憶は残る
    expect(applyOp).toHaveBeenCalledTimes(1)
    expect(applyOp.mock.calls[0][0]).toEqual({ kind: 'append', msg: { role: 'assistant', content: NOTICE() } })
    await settle({ dir: A })
    expect(applyOp).toHaveBeenCalledTimes(1)
  })

  it('H5: 一覧が live でなければ、消さず・出さない', async () => {
    rt.sakura = { models: models('m', 'm2'), live: false }
    rememberProjectAi(A, { brain: 'sakura', sakuraModel: 'old' })
    rt.refetchSakura = async () => ['m', 'm2']
    await settle({ dir: A })
    expect(readProjectAi(A).sakuraModel).toBe('old')
    expect(applyOp).not.toHaveBeenCalled()
  })

  it('H5: 会話を読み込んだのが別のプロジェクト（convLoadedDir が違う）なら、出さない（消さない）', async () => {
    rememberProjectAi(A, { brain: 'sakura', sakuraModel: 'old' })
    rt.refetchSakura = async () => ['m', 'm2']
    await settle({ dir: A, convLoadedDir: B })
    await settle({ dir: A, convLoadedDir: null })
    expect(readProjectAi(A).sakuraModel).toBe('old')
    expect(applyOp).not.toHaveBeenCalled()
  })

  it('取り直しが取れなかった（null）ときは、消さず・出さない', async () => {
    rememberProjectAi(A, { brain: 'sakura', sakuraModel: 'old' })
    rt.refetchSakura = async () => null
    await settle({ dir: A })
    expect(readProjectAi(A).sakuraModel).toBe('old')
    expect(applyOp).not.toHaveBeenCalled()
  })

  it('古い一覧: live の一覧 [m] で描いたあとに m9 を覚えても、取り直しで m9 が見つかれば、消さず・出さない', async () => {
    rt.sakura = { models: models('m'), live: true }
    rt.refetchSakura = async () => ['m', 'm9']
    await settle({ dir: A })
    rememberProjectAi(A, { sakuraModel: 'm9' })
    await settle({ dir: A })
    expect(readProjectAi(A).sakuraModel).toBe('m9')
    expect(applyOp).not.toHaveBeenCalled()
  })

  it('古い一覧: 取り直しても m9 が無ければ、消して案内を1回だけ出す', async () => {
    rt.sakura = { models: models('m'), live: true }
    rt.refetchSakura = async () => ['m']
    rememberProjectAi(A, { sakuraModel: 'm9' })
    await settle({ dir: A })
    await settle({ dir: A })
    expect(readProjectAi(A).sakuraModel).toBeUndefined()
    expect(applyOp).toHaveBeenCalledTimes(1)
  })

  it('チャット欄を作り直しても（マウントし直し）、同じプロジェクトの同じモデルの案内は2回目を出さない', async () => {
    rt.refetchSakura = async () => ['m', 'm2', 'm3']
    rememberProjectAi(A, { brain: 'sakura', sakuraModel: 'old' })
    await settle({ dir: A })
    expect(applyOp).toHaveBeenCalledTimes(1)
    rt.slots = []
    rememberProjectAi(A, { sakuraModel: 'old' }) // 同じ記憶がまた現れた
    await settle({ dir: A })
    expect(readProjectAi(A).sakuraModel).toBeUndefined()
    expect(applyOp).toHaveBeenCalledTimes(1)
  })

  it('回が走っている間は案内を出さず（記憶は消す）、回が終わった描画で1回だけ出す', async () => {
    rt.refetchSakura = async () => ['m', 'm2', 'm3']
    updateTurn(turnKey(A), { isLoading: true })
    rememberProjectAi(A, { brain: 'sakura', sakuraModel: 'old' })
    await settle({ dir: A })
    expect(readProjectAi(A).sakuraModel).toBeUndefined()
    expect(applyOp).not.toHaveBeenCalled()
    updateTurn(turnKey(A), { isLoading: false })
    await settle({ dir: A })
    expect(applyOp).toHaveBeenCalledTimes(1)
    await settle({ dir: A })
    expect(applyOp).toHaveBeenCalledTimes(1)
  })

  it('使っていない側（Claude）の提供終了の案内は、さくらを使っているチャットには出さない', async () => {
    rt.token = 'sk-ant-test'
    rememberProjectAi(A, { brain: 'sakura', claudeModel: 'claude-old' })
    rt.refetchClaude = async () => ['claude-opus-5']
    await settle({ dir: A })
    expect(readProjectAi(A).claudeModel).toBeUndefined() // 記憶は消す
    expect(applyOp).not.toHaveBeenCalled()
  })
})
