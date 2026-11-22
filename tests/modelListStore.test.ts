import { describe, it, expect, beforeEach, vi } from 'vitest'

// モデルの一覧の置き場（さくら: usage.ts・Claude: claudeMode.ts）。取り直した一覧が購読者に届く・live の扱い。
function stubBrowser(models: (key: string) => Promise<unknown>, claudeModels: (key: string) => Promise<unknown>) {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  })
  vi.stubGlobal('window', {
    dispatchEvent: () => true,
    electronAPI: { sakura: { models }, claude: { models: claudeModels } },
  })
  return store
}

describe('モデルの一覧の置き場', () => {
  let usage: typeof import('../src/renderer/usage')
  let cm: typeof import('../src/renderer/claudeMode')
  let sig: typeof import('../src/renderer/modelListSignal')
  let pa: typeof import('../src/renderer/projectAi')
  let sakuraModels: ReturnType<typeof vi.fn>
  let claudeModels: ReturnType<typeof vi.fn>
  let store: Map<string, string>

  beforeEach(async () => {
    vi.resetModules()
    sakuraModels = vi.fn(async () => ['m', 'm9', 'whisper-large'])
    claudeModels = vi.fn(async () => ({ ok: true, models: [{ id: 'claude-x', displayName: 'Claude X' }] }))
    store = stubBrowser(sakuraModels as never, claudeModels as never)
    usage = await import('../src/renderer/usage')
    cm = await import('../src/renderer/claudeMode')
    sig = await import('../src/renderer/modelListSignal')
    pa = await import('../src/renderer/projectAi')
  })

  it('取得前は live=false で、キャッシュ／予備の一覧', () => {
    const s = usage.getSakuraModelList()
    expect(s.live).toBe(false)
    expect(s.at).toBe(0)
    expect(s.ids.length).toBeGreaterThan(0)
    const c = cm.getClaudeModelListState()
    expect(c.live).toBe(false)
    expect(c.models).toEqual(cm.CLAUDE_MODELS)
  })

  it('さくら: 取得すると {ids, live:true, at} になり、購読者へ1回知らせる（チャットモード用でない物は除く）', async () => {
    let calls = 0
    sig.subscribeModelList(() => { calls++ })
    const v0 = sig.getModelListVersion()
    await usage.fetchModels('k')
    const s = usage.getSakuraModelList()
    expect(s.ids).toEqual(['m', 'm9'])
    expect(s.live).toBe(true)
    expect(s.at).toBeGreaterThan(0)
    expect(calls).toBe(1)
    expect(sig.getModelListVersion()).toBe(v0 + 1)
  })

  it('さくら: 取得が空や失敗なら、置き場は live にならず、知らせない', async () => {
    let calls = 0
    sig.subscribeModelList(() => { calls++ })
    sakuraModels.mockResolvedValueOnce(['whisper-large'])
    await usage.fetchModels('k')
    sakuraModels.mockRejectedValueOnce(new Error('net'))
    await expect(usage.fetchModels('k')).rejects.toThrow()
    expect(usage.getSakuraModelList().live).toBe(false)
    expect(calls).toBe(0)
  })

  it('さくら: 取り直すと新しい一覧に替わり、また知らせる', async () => {
    await usage.fetchModels('k')
    let calls = 0
    sig.subscribeModelList(() => { calls++ })
    sakuraModels.mockResolvedValueOnce(['n1'])
    await usage.fetchModels('k')
    expect(usage.getSakuraModelList().ids).toEqual(['n1'])
    expect(calls).toBe(1)
  })

  it('Claude: 記録すると {models, live:true, at}、キャッシュにも入り、購読者へ知らせる。空は無視する', () => {
    let calls = 0
    sig.subscribeModelList(() => { calls++ })
    cm.recordClaudeModelList([])
    expect(calls).toBe(0)
    expect(cm.getClaudeModelListState().live).toBe(false)
    cm.recordClaudeModelList([{ id: 'claude-x', label: 'Claude X' }])
    const c = cm.getClaudeModelListState()
    expect(c.models).toEqual([{ id: 'claude-x', label: 'Claude X' }])
    expect(c.live).toBe(true)
    expect(c.at).toBeGreaterThan(0)
    expect(calls).toBe(1)
    expect(store.get(cm.CLAUDE_MODELS_CACHE_KEY)).toContain('claude-x')
  })

  it('取り直した一覧は、送る瞬間の読み（aiChoiceInputsNow）にも届く', async () => {
    await usage.fetchModels('k')
    cm.recordClaudeModelList([{ id: 'claude-x', label: 'Claude X' }])
    const now = pa.aiChoiceInputsNow('/p')
    expect(now.sakuraModelIds).toEqual(['m', 'm9'])
    expect(now.claudeModelIds).toEqual(['claude-x'])
  })

  it('取り直した一覧で、記憶のモデルの提供終了の判断が変わる（古い一覧では「提供終了」、新しい一覧では提供中）', async () => {
    pa.rememberProjectAi('/p', { sakuraModel: 'm9' })
    const keys = { hasClaudeKey: false, hasEngineKey: true }
    const stale = pa.currentAiChoice('/p', keys, { sakuraModelIds: ['m'] })
    expect(stale.retired.map(r => r.from)).toEqual(['m9'])
    await usage.fetchModels('k')
    const fresh = pa.currentAiChoice('/p', keys)
    expect(fresh.sakuraModel).toBe('m9')
    expect(fresh.retired).toEqual([])
  })

  it('購読の解除後は届かない', async () => {
    let calls = 0
    const off = sig.subscribeModelList(() => { calls++ })
    off()
    await usage.fetchModels('k')
    expect(calls).toBe(0)
  })
  it('さくら: キーを替えた直後、前のキーの取得があとで返っても、新しいキーの一覧を上書きしない', async () => {
    const resolvers: Record<string, (v: string[]) => void> = {}
    sakuraModels.mockImplementation(((k: string) => new Promise<string[]>(res => { resolvers[k] = res })) as never)
    const a = usage.fetchModels('A')
    const b = usage.fetchModels('B')
    resolvers.B(['b1'])
    await b
    resolvers.A(['a1'])
    await a
    expect(usage.getSakuraModelList().ids).toEqual(['b1'])
    expect(JSON.parse(store.get('sakura_models_cache')!)).toEqual(['b1'])
  })

  it('Claude: 取り直しで、前のキーの応答があとで返っても、新しいキーの一覧を上書きしない', async () => {
    const hooks = await import('../src/renderer/hooks/useClaudeModels')
    const resolvers: Record<string, (v: unknown) => void> = {}
    claudeModels.mockImplementation(((k: string) => new Promise(res => { resolvers[k] = res })) as never)
    const a = hooks.refetchClaudeModelIds('A')
    const b = hooks.refetchClaudeModelIds('B')
    resolvers.B({ ok: true, models: [{ id: 'claude-b', displayName: 'B' }] })
    await b
    resolvers.A({ ok: true, models: [{ id: 'claude-a', displayName: 'A' }] })
    await a
    expect(cm.getClaudeModelListState().models.map(m => m.id)).toContain('claude-b')
    expect(cm.getClaudeModelListState().models.map(m => m.id)).not.toContain('claude-a')
  })
})
