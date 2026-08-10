import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getClaudeSessionId, setClaudeSessionId } from '../src/renderer/claudeSession'

// localStorage の簡易モック（他テストと同じ流儀）。
function installLocalStorage() {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
  })
  return store
}

describe('claudeSession — セッションIDの永続化（所見10）', () => {
  beforeEach(() => { installLocalStorage() })

  it('保存したIDをプロジェクト単位で読み戻せる', () => {
    setClaudeSessionId('/proj/a', 'sess-a')
    setClaudeSessionId('/proj/b', 'sess-b')
    expect(getClaudeSessionId('/proj/a')).toBe('sess-a')
    expect(getClaudeSessionId('/proj/b')).toBe('sess-b')
  })

  it('未保存のプロジェクトは null', () => {
    expect(getClaudeSessionId('/proj/none')).toBeNull()
  })

  it('projectDir が null/空なら null（保存もしない）', () => {
    expect(getClaudeSessionId(null)).toBeNull()
    expect(getClaudeSessionId('')).toBeNull()
    setClaudeSessionId(null, 'x') // 例外を投げない
    expect(getClaudeSessionId(null)).toBeNull()
  })

  it('空IDを渡すと保存済みを削除する', () => {
    setClaudeSessionId('/proj/a', 'sess-a')
    expect(getClaudeSessionId('/proj/a')).toBe('sess-a')
    setClaudeSessionId('/proj/a', '')
    expect(getClaudeSessionId('/proj/a')).toBeNull()
    setClaudeSessionId('/proj/a', 'sess-a2')
    setClaudeSessionId('/proj/a', null)
    expect(getClaudeSessionId('/proj/a')).toBeNull()
  })

  it('空白のみのIDは無効として扱う', () => {
    setClaudeSessionId('/proj/a', '   ')
    expect(getClaudeSessionId('/proj/a')).toBeNull()
  })
})
