import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// 提供終了したモデルが「保存済みの既定」になっているとき、一覧が実際に取得できた場合だけ
// 既定を保存し直す（新しい会話のたびに「自動で切り替えました」が出続けないように）。
function stubBrowser() {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  })
  vi.stubGlobal('window', { dispatchEvent: () => true })
  return store
}

const RETIRED = 'preview/Kimi-K2.6'
const LIVE_LIST = ['preview/gemma-4-31B-it', 'gpt-oss-120b', 'Qwen3-Coder-480B-A35B-Instruct-FP8']

describe('提供終了モデルが保存済みの既定のとき', () => {
  let store: Map<string, string>
  let usage: typeof import('../src/renderer/usage')
  beforeEach(async () => {
    vi.resetModules()
    store = stubBrowser()
    usage = await import('../src/renderer/usage')
  })

  // 画面側の流れを写した最小の再現: 新しい会話を作り、提供終了なら案内を1回出す
  function newChat(mode: 'ide' | 'chat', list: string[], live: boolean) {
    const sessionModel = usage.getDefaultModel(mode)
    let notices = 0
    usage.syncStoredDefaultWithOffered(mode, list, live)
    let shown = sessionModel
    if (!list.includes(sessionModel)) { shown = usage.pickBestModel(list); notices++ }
    return { shown, notices }
  }

  it('一覧を実際に取得できて既定がその中に無い → 切り替え・保存・案内は1回、2回目の新しい会話では案内なし', () => {
    for (const mode of ['ide', 'chat'] as const) {
      usage.setDefaultModel(RETIRED, mode)
      const first = newChat(mode, LIVE_LIST, true)
      expect(first.notices).toBe(1)
      expect(LIVE_LIST).toContain(first.shown)
      expect(usage.getDefaultModel(mode)).toBe(first.shown) // 保存し直された
      const second = newChat(mode, LIVE_LIST, true)
      expect(second.notices).toBe(0)
      expect(second.shown).toBe(first.shown)
    }
  })

  it('モードごとに別々に保存される（片方のモードの既定は触らない）', () => {
    usage.setDefaultModel(RETIRED, 'chat')
    usage.setDefaultModel('gpt-oss-120b', 'ide')
    usage.syncStoredDefaultWithOffered('chat', LIVE_LIST, true)
    expect(usage.getDefaultModel('ide')).toBe('gpt-oss-120b')
    expect(usage.getDefaultModel('chat')).not.toBe(RETIRED)
  })

  it('取得に失敗した／予備の一覧（live でない）→ 保存した選択は書き換えない', () => {
    usage.setDefaultModel(RETIRED, 'chat')
    expect(usage.syncStoredDefaultWithOffered('chat', LIVE_LIST, false)).toBeNull()
    expect(usage.getDefaultModel('chat')).toBe(RETIRED)
    expect(store.get('sakura_model_chat')).toBe(RETIRED)
  })

  it('取得できた一覧に既定がある、または一覧が空 → 書き換えない', () => {
    usage.setDefaultModel('gpt-oss-120b', 'ide')
    expect(usage.syncStoredDefaultWithOffered('ide', LIVE_LIST, true)).toBeNull()
    usage.setDefaultModel(RETIRED, 'ide')
    expect(usage.syncStoredDefaultWithOffered('ide', [], true)).toBeNull()
    expect(usage.getDefaultModel('ide')).toBe(RETIRED)
  })
})

describe('画面の配線（ChatApp / ChatPanel は同じ関数を、取得できたかを添えて呼ぶ）', () => {
  const read = (f: string) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
  it('useModelList は取得成功のときだけ live を立てる', () => {
    const src = read('src/renderer/hooks/useModels.ts')
    expect(src).toMatch(/\.then\(list => \{ if \(!cancelled && list\.length\) \{ setIds\(list\); setLive\(true\) \} \}\)/)
  })
  it.each([
    ['src/renderer/components/ChatApp.tsx', 'chat'],
    ['src/renderer/components/ChatPanel.tsx', 'ide'],
  ])('%s', (f, mode) => {
    const src = read(f)
    expect(src).toContain(`syncStoredDefaultWithOffered('${mode}', models.map(m => m.id), modelsLive)`)
    expect(src).toMatch(/useModelList\(apiKey\)/)
  })
})
