import { describe, it, expect, beforeEach, vi } from 'vitest'
import { pickBestModel } from '../src/shared/modelInfo'

// 使う AI とモデルのプロジェクトごとの記憶と、その判断（resolveAiChoice）。
function stubBrowser() {
  const store = new Map<string, string>()
  const setKeys: string[] = []
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { setKeys.push(k); store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    // 数え上げて前方一致で消す書き方（length・key）も動くように持つ
    get length() { return store.size },
    key: (i: number) => [...store.keys()][i] ?? null,
  })
  const dispatchEvent = vi.fn(() => true)
  vi.stubGlobal('window', { dispatchEvent })
  return { store, setKeys, dispatchEvent }
}

const DEF = { brain: 'claude' as const, sakuraModel: 'm', claudeModel: null as string | null }
const base = {
  memory: {}, defaults: DEF, hasClaudeKey: true, hasEngineKey: true,
  sakuraModelIds: [] as string[], claudeModelIds: [] as string[],
}

describe('projectAi', () => {
  let env: ReturnType<typeof stubBrowser>
  let pa: typeof import('../src/renderer/projectAi')
  let sig: typeof import('../src/renderer/aiChoiceSignal')
  let cm: typeof import('../src/renderer/claudeMode')
  let usage: typeof import('../src/renderer/usage')
  let agent: typeof import('../src/renderer/newProjectAgent')

  beforeEach(async () => {
    vi.resetModules()
    env = stubBrowser()
    pa = await import('../src/renderer/projectAi')
    sig = await import('../src/renderer/aiChoiceSignal')
    cm = await import('../src/renderer/claudeMode')
    usage = await import('../src/renderer/usage')
    agent = await import('../src/renderer/newProjectAgent')
  })

  describe('AI の表（resolveAiChoice）', () => {
    it('記憶なし・既定 claude・両方のキー → claude', () => {
      expect(pa.resolveAiChoice(base).brain).toBe('claude')
    })
    it('記憶 sakura・既定 claude・両方 → sakura', () => {
      expect(pa.resolveAiChoice({ ...base, memory: { brain: 'sakura' } }).brain).toBe('sakura')
    })
    it('記憶 claude・既定 sakura・両方 → claude', () => {
      expect(pa.resolveAiChoice({ ...base, memory: { brain: 'claude' }, defaults: { ...DEF, brain: 'sakura' } }).brain).toBe('claude')
    })
    it('記憶 claude・Claude のキー無し・さくら有り → sakura、missingKey は claude', () => {
      const c = pa.resolveAiChoice({ ...base, memory: { brain: 'claude' }, hasClaudeKey: false })
      expect(c.brain).toBe('sakura')
      expect(c.missingKey).toBe('claude')
    })
    it('記憶 sakura・さくらのキー無し・Claude 有り → null（黙って Claude にしない）、missingKey は sakura', () => {
      const c = pa.resolveAiChoice({ ...base, memory: { brain: 'sakura' }, hasEngineKey: false })
      expect(c.brain).toBeNull()
      expect(c.missingKey).toBe('sakura')
    })
    it('既定 sakura・記憶なし・さくら無し・Claude 有り → null', () => {
      const c = pa.resolveAiChoice({ ...base, defaults: { ...DEF, brain: 'sakura' }, hasEngineKey: false })
      expect(c.brain).toBeNull()
    })
    it('キー無し → null', () => {
      expect(pa.resolveAiChoice({ ...base, hasClaudeKey: false, hasEngineKey: false }).brain).toBeNull()
    })
  })

  describe('モデルの連鎖', () => {
    it('さくら: 記憶が一覧にあれば記憶', () => {
      const c = pa.resolveAiChoice({ ...base, memory: { sakuraModel: 'a' }, sakuraModelIds: ['a', 'm'] })
      expect(c.sakuraModel).toBe('a')
      expect(c.retired).toEqual([])
    })
    it('さくら: 記憶が一覧に無く既定がある → 既定、記憶の提供終了として数える', () => {
      const c = pa.resolveAiChoice({ ...base, memory: { sakuraModel: 'old' }, sakuraModelIds: ['m', 'x'] })
      expect(c.sakuraModel).toBe('m')
      expect(c.retired).toEqual([{ brain: 'sakura', from: 'old', to: 'm', fromProject: true }])
    })
    it('さくら: どちらも一覧に無ければ pickBestModel', () => {
      const ids = ['x', 'gpt-oss-120b']
      const c = pa.resolveAiChoice({ ...base, memory: { sakuraModel: 'old' }, sakuraModelIds: ids })
      expect(c.sakuraModel).toBe(pickBestModel(ids))
    })
    it('さくら: 一覧が空なら記憶をそのまま使う', () => {
      expect(pa.resolveAiChoice({ ...base, memory: { sakuraModel: 'old' } }).sakuraModel).toBe('old')
    })
    it('さくら: 記憶なしで既定が提供終了 → 既定の提供終了（fromProject は false）', () => {
      const c = pa.resolveAiChoice({ ...base, defaults: { ...DEF, sakuraModel: 'gone' }, sakuraModelIds: ['x'] })
      expect(c.retired).toEqual([{ brain: 'sakura', from: 'gone', to: pickBestModel(['x']), fromProject: false }])
    })
    it('Claude: 記憶 → 保存の既定 → DEFAULT → 先頭', () => {
      const ids = ['c1', 'c2', cm.DEFAULT_CLAUDE_MODEL]
      expect(pa.resolveAiChoice({ ...base, memory: { claudeModel: 'c2' }, defaults: { ...DEF, claudeModel: 'c1' }, claudeModelIds: ids }).claudeModel).toBe('c2')
      expect(pa.resolveAiChoice({ ...base, memory: { claudeModel: 'zz' }, defaults: { ...DEF, claudeModel: 'c1' }, claudeModelIds: ids }).claudeModel).toBe('c1')
      expect(pa.resolveAiChoice({ ...base, memory: { claudeModel: 'zz' }, defaults: { ...DEF, claudeModel: 'yy' }, claudeModelIds: ids }).claudeModel).toBe(cm.DEFAULT_CLAUDE_MODEL)
      expect(pa.resolveAiChoice({ ...base, memory: { claudeModel: 'zz' }, defaults: { ...DEF, claudeModel: 'yy' }, claudeModelIds: ['c1', 'c2'] }).claudeModel).toBe('c1')
    })
    it('Claude: 記憶なし・保存の既定なし・live の一覧に DEFAULT が無い → 一覧の先頭、retired は空（DEFAULT を提供終了に数えない）', () => {
      const c = pa.resolveAiChoice({ ...base, claudeModelIds: ['c1', 'c2'] })
      expect(c.claudeModel).toBe('c1')
      expect(c.retired).toEqual([])
    })
    it('Claude: 記憶が提供終了で保存の既定も無い → 記憶を提供終了として数える', () => {
      const c = pa.resolveAiChoice({ ...base, memory: { claudeModel: 'old' }, claudeModelIds: ['c1', cm.DEFAULT_CLAUDE_MODEL] })
      expect(c.claudeModel).toBe(cm.DEFAULT_CLAUDE_MODEL)
      expect(c.retired).toEqual([{ brain: 'claude', from: 'old', to: cm.DEFAULT_CLAUDE_MODEL, fromProject: true }])
    })
    it('Claude: 一覧が空なら、記憶 → 保存の既定 → DEFAULT をそのまま返し、retired は空', () => {
      const c = pa.resolveAiChoice({ ...base, memory: { claudeModel: 'old' } })
      expect(c.claudeModel).toBe('old')
      expect(c.retired).toEqual([])
      expect(pa.resolveAiChoice(base).claudeModel).toBe(cm.DEFAULT_CLAUDE_MODEL)
    })
  })

  describe('保存', () => {
    it('A に書いても B は空。鍵はちょうど koto_project_ai: + dir', () => {
      pa.rememberProjectAi('/ws/a', { brain: 'sakura', sakuraModel: 'm2' })
      expect(pa.readProjectAi('/ws/a')).toEqual({ brain: 'sakura', sakuraModel: 'm2' })
      expect(pa.readProjectAi('/ws/b')).toEqual({})
      expect([...env.store.keys()]).toEqual(['koto_project_ai:/ws/a'])
    })
    it('末尾の / は同じ鍵になる（/ws/a/ と /ws/a）', () => {
      expect(pa.projectAiKey('/ws/a/')).toBe('koto_project_ai:/ws/a')
      pa.rememberProjectBrain('/ws/a/', 'claude')
      expect(pa.readProjectAi('/ws/a')).toEqual({ brain: 'claude' })
      pa.forgetProjectAi('/ws/a/')
      expect(pa.readProjectAi('/ws/a')).toEqual({})
    })
    it('壊れた JSON・v:2・変な brain は捨てる', () => {
      env.store.set('koto_project_ai:/p', '{not json')
      expect(pa.readProjectAi('/p')).toEqual({})
      env.store.set('koto_project_ai:/p', JSON.stringify({ v: 2, brain: 'claude' }))
      expect(pa.readProjectAi('/p')).toEqual({})
      env.store.set('koto_project_ai:/p', JSON.stringify({ v: 1, brain: 'gpt', sakuraModel: '', claudeModel: 5 }))
      expect(pa.readProjectAi('/p')).toEqual({})
      env.store.set('koto_project_ai:/p', JSON.stringify({ v: 1, brain: 'gpt', sakuraModel: 'k' }))
      expect(pa.readProjectAi('/p')).toEqual({ sakuraModel: 'k' })
    })
    it('dir が null なら書かない', () => {
      pa.rememberProjectAi(null, { brain: 'claude' })
      pa.rememberProjectBrain(undefined, 'claude')
      expect(env.store.size).toBe(0)
    })
    it('patch は重ねる（brain だけ書いてもモデルが残る）', () => {
      pa.rememberProjectModel('/p', 'sakura', 'm2')
      pa.rememberProjectBrain('/p', 'claude')
      pa.rememberProjectModel('/p', 'claude', 'c1')
      expect(pa.readProjectAi('/p')).toEqual({ brain: 'claude', sakuraModel: 'm2', claudeModel: 'c1' })
    })
    it('forgetProjectModel はその AI の側だけを消し、全部無くなれば鍵ごと消す', () => {
      pa.rememberProjectAi('/p', { sakuraModel: 'm2', claudeModel: 'c1' })
      pa.forgetProjectModel('/p', 'sakura')
      expect(pa.readProjectAi('/p')).toEqual({ claudeModel: 'c1' })
      pa.forgetProjectModel('/p', 'claude')
      expect(env.store.has('koto_project_ai:/p')).toBe(false)
    })
    it('forgetProjectAi は完全一致の鍵だけ消す（/ws/foo は /ws/foo-2 に当たらない）', () => {
      pa.rememberProjectBrain('/ws/foo', 'claude')
      pa.rememberProjectBrain('/ws/foo-2', 'claude')
      pa.forgetProjectAi('/ws/foo')
      expect(pa.readProjectAi('/ws/foo')).toEqual({})
      expect(pa.readProjectAi('/ws/foo-2')).toEqual({ brain: 'claude' })
    })
    it('保存領域が使えなくても例外にしない', () => {
      vi.stubGlobal('localStorage', {
        getItem: () => { throw new Error('x') }, setItem: () => { throw new Error('x') }, removeItem: () => { throw new Error('x') },
      })
      expect(pa.readProjectAi('/p')).toEqual({})
      expect(() => pa.rememberProjectBrain('/p', 'claude')).not.toThrow()
      expect(() => pa.forgetProjectAi('/p')).not.toThrow()
    })
  })

  it('既定を書かない: 記憶の操作のあと、既定の鍵は前と同じで、書かれた鍵は koto_project_ai:* だけ', () => {
    env.store.set('sakura_claude_mode', 'off')
    env.store.set('sakura_model_ide', 'dm')
    env.store.set('sakura_claude_model', 'dc')
    const before = ['sakura_claude_mode', 'sakura_model_ide', 'sakura_claude_model'].map(k => env.store.get(k))
    pa.rememberProjectAi('/p', { brain: 'claude', sakuraModel: 'a', claudeModel: 'b' })
    pa.rememberProjectBrain('/p', 'sakura')
    pa.rememberProjectModel('/p', 'claude', 'c')
    pa.forgetProjectModel('/p', 'sakura')
    expect(['sakura_claude_mode', 'sakura_model_ide', 'sakura_claude_model'].map(k => env.store.get(k))).toEqual(before)
    expect(env.setKeys.length).toBeGreaterThan(0)
    expect(env.setKeys.every(k => k === 'koto_project_ai:/p')).toBe(true)
  })

  describe('新規作成のあとの記憶（applyCreationAi）', () => {
    const KEYS = ['sakura_claude_mode', 'sakura_model_ide', 'sakura_claude_model']
    const seed = () => {
      env.store.set('koto_project_ai:/ws/x', JSON.stringify({ v: 1, brain: 'claude', claudeModel: 'c' }))
      for (const k of KEYS) env.store.set(k, 'v-' + k)
    }
    const base = { root: '/ws/x', merged: false, useChat: false, brain: null, claudeModelId: 'c9', sakuraModelId: 'm9' } as const
    const defaultsSame = () => KEYS.every(k => env.store.get(k) === 'v-' + k)
    const touched = () => new Set(env.setKeys)

    it('まっさら（useChat でない・merged でない）は、古い記憶を消して {} になる', () => {
      seed()
      expect(pa.applyCreationAi({ ...base })).toBe(true)
      expect(pa.readProjectAi('/ws/x')).toEqual({})
      expect(defaultsSame()).toBe(true)
      expect(touched().size).toBe(0)
    })
    it('さくらで作ると {brain:sakura, sakuraModel} だけ（古い claude の項目は残らない）', () => {
      seed()
      expect(pa.applyCreationAi({ ...base, useChat: true, brain: 'sakura' })).toBe(true)
      expect(pa.readProjectAi('/ws/x')).toEqual({ brain: 'sakura', sakuraModel: 'm9' })
      expect([...touched()]).toEqual(['koto_project_ai:/ws/x'])
      expect(defaultsSame()).toBe(true)
    })
    it('Claude で作ると {brain:claude, claudeModel} だけ', () => {
      seed()
      pa.rememberProjectAi('/ws/x', { sakuraModel: 'old' })
      expect(pa.applyCreationAi({ ...base, useChat: true, brain: 'claude' })).toBe(true)
      expect(pa.readProjectAi('/ws/x')).toEqual({ brain: 'claude', claudeModel: 'c9' })
      expect(defaultsSame()).toBe(true)
    })
    it('merged なら消さずに、今の記憶へ重ねる。merged でまっさらなら何も変えない', () => {
      seed()
      expect(pa.applyCreationAi({ ...base, merged: true })).toBe(true)
      expect(pa.readProjectAi('/ws/x')).toEqual({ brain: 'claude', claudeModel: 'c' })
      expect(pa.applyCreationAi({ ...base, merged: true, useChat: true, brain: 'sakura' })).toBe(true)
      expect(pa.readProjectAi('/ws/x')).toEqual({ brain: 'sakura', claudeModel: 'c', sakuraModel: 'm9' })
      expect(defaultsSame()).toBe(true)
    })
    it('保存できないとき（書けない・消せない）は false を返し、例外にしない', () => {
      vi.stubGlobal('localStorage', {
        getItem: () => null, setItem: () => { throw new Error('x') }, removeItem: () => { throw new Error('x') },
      })
      expect(pa.applyCreationAi({ ...base, useChat: true, brain: 'sakura' })).toBe(false)
      expect(pa.applyCreationAi({ ...base })).toBe(false)
      // 消す必要が無い（merged でまっさら）ときは書けなくても問題ない
      expect(pa.applyCreationAi({ ...base, merged: true })).toBe(true)
    })
    it('forgetProjectAi・rememberProjectAi は成否を返す', () => {
      expect(pa.rememberProjectAi('/p', { brain: 'claude' })).toBe(true)
      expect(pa.forgetProjectAi('/p')).toBe(true)
      vi.stubGlobal('localStorage', {
        getItem: () => null, setItem: () => { throw new Error('x') }, removeItem: () => { throw new Error('x') },
      })
      expect(pa.rememberProjectAi('/p', { brain: 'claude' })).toBe(false)
      expect(pa.forgetProjectAi('/p')).toBe(false)
    })
  })

  describe('知らせ', () => {
    function counted(act: () => void): { versionDelta: number; calls: number } {
      const v0 = sig.getAiChoiceVersion()
      let calls = 0
      const off = sig.subscribeAiChoice(() => { calls++ })
      act()
      off()
      return { versionDelta: sig.getAiChoiceVersion() - v0, calls }
    }
    it.each([
      ['rememberProjectAi', () => pa.rememberProjectAi('/p', { brain: 'claude' })],
      ['forgetProjectModel', () => { pa.rememberProjectModel('/p', 'claude', 'c'); pa.forgetProjectModel('/p', 'claude') }],
      ['forgetProjectAi', () => { pa.rememberProjectBrain('/p', 'claude'); pa.forgetProjectAi('/p') }],
      ['setClaudeMode', () => cm.setClaudeMode(false)],
      ['setClaudeModel', () => cm.setClaudeModel('c')],
      ['setDefaultModel', () => usage.setDefaultModel('m3', 'ide')],
    ])('%s は版を進め、購読者を呼ぶ', (name, act) => {
      const r = counted(act)
      expect(r.versionDelta).toBeGreaterThan(0)
      expect(r.calls).toBe(r.versionDelta)
    })
    it('購読の解除後は呼ばれない', () => {
      let n = 0
      const off = sig.subscribeAiChoice(() => { n++ })
      off()
      pa.rememberProjectBrain('/p', 'claude')
      expect(n).toBe(0)
    })
    it('rememberProjectAi は window.dispatchEvent を呼ばない（公開の画面の読み直しを起こさない）', () => {
      pa.rememberProjectAi('/p', { brain: 'claude', claudeModel: 'c' })
      pa.forgetProjectModel('/p', 'claude')
      expect(env.dispatchEvent).not.toHaveBeenCalled()
    })
    it('setClaudeMode は credentials-changed を出し続ける', () => {
      cm.setClaudeMode(true)
      expect(env.dispatchEvent).toHaveBeenCalledTimes(1)
    })
  })

  it('creationProjectAi: claude・sakura・null の3通り', () => {
    expect(agent.creationProjectAi({ brain: 'claude', claudeModelId: 'c1', sakuraModelId: 's1' })).toEqual({ brain: 'claude', claudeModel: 'c1' })
    expect(agent.creationProjectAi({ brain: 'sakura', claudeModelId: 'c1', sakuraModelId: 's1' })).toEqual({ brain: 'sakura', sakuraModel: 's1' })
    expect(agent.creationProjectAi({ brain: null, claudeModelId: 'c1', sakuraModelId: 's1' })).toBeNull()
  })

  describe('syncStoredClaudeDefaultWithOffered', () => {
    it('live でなければ書かない', () => {
      env.store.set('sakura_claude_model', 'old')
      expect(cm.syncStoredClaudeDefaultWithOffered(['a'], false)).toBeNull()
      expect(env.store.get('sakura_claude_model')).toBe('old')
    })
    it('保存値が一覧に無く live → DEFAULT（無ければ先頭）を書く', () => {
      env.store.set('sakura_claude_model', 'old')
      expect(cm.syncStoredClaudeDefaultWithOffered(['a', cm.DEFAULT_CLAUDE_MODEL], true)).toBe(cm.DEFAULT_CLAUDE_MODEL)
      expect(env.store.get('sakura_claude_model')).toBe(cm.DEFAULT_CLAUDE_MODEL)
      env.store.set('sakura_claude_model', 'old')
      expect(cm.syncStoredClaudeDefaultWithOffered(['a', 'b'], true)).toBe('a')
      expect(env.store.get('sakura_claude_model')).toBe('a')
    })
    it('保存値が一覧にあれば書かない・保存値が無ければ書かない', () => {
      env.store.set('sakura_claude_model', 'a')
      expect(cm.syncStoredClaudeDefaultWithOffered(['a'], true)).toBeNull()
      env.store.delete('sakura_claude_model')
      expect(cm.syncStoredClaudeDefaultWithOffered(['a'], true)).toBeNull()
      expect(env.store.has('sakura_claude_model')).toBe(false)
    })
  })

  describe('送る瞬間の読み（aiChoiceInputsNow・currentAiChoice）', () => {
    it('プロジェクトがあれば記憶、無ければ override。既定は設定の値', () => {
      pa.rememberProjectAi('/p', { brain: 'sakura', sakuraModel: 'm2' })
      env.store.set('sakura_claude_mode', 'off')
      env.store.set('sakura_claude_model', 'cx')
      const a = pa.aiChoiceInputsNow('/p', { brain: 'claude' })
      expect(a.memory).toEqual({ brain: 'sakura', sakuraModel: 'm2' })
      expect(a.defaults).toMatchObject({ brain: 'sakura', claudeModel: 'cx' })
      expect(pa.aiChoiceInputsNow(null, { brain: 'claude' }).memory).toEqual({ brain: 'claude' })
      expect(pa.aiChoiceInputsNow(null).memory).toEqual({})
    })
    it('currentAiChoice は記憶 → 既定で決める', () => {
      pa.rememberProjectBrain('/p', 'sakura')
      expect(pa.currentAiChoice('/p', { hasClaudeKey: true, hasEngineKey: true }).brain).toBe('sakura')
      expect(pa.currentAiChoice('/q', { hasClaudeKey: true, hasEngineKey: true }).brain).toBe('claude')
    })
  })
})
