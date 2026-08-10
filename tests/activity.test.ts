import { describe, it, expect } from 'vitest'
import { beginActivity, _activeCount } from '../src/renderer/activity'

// window.electronAPI はテスト環境では未定義。activity.ts の report() は try/catch で吸収する
// 設計のため、モック無しでも例外にならないはず（そのこと自体もここで検証する）。

describe('beginActivity / _activeCount', () => {
  it('increments on begin and decrements on end', () => {
    expect(_activeCount()).toBe(0)
    const end = beginActivity('テスト処理')
    expect(_activeCount()).toBe(1)
    end()
    expect(_activeCount()).toBe(0)
  })

  it('supports multiple concurrent activities (counter, not boolean)', () => {
    const end1 = beginActivity('処理A')
    const end2 = beginActivity('処理B')
    expect(_activeCount()).toBe(2)
    end1()
    expect(_activeCount()).toBe(1)
    end2()
    expect(_activeCount()).toBe(0)
  })

  it('calling the end function twice is harmless (no double-decrement)', () => {
    const end = beginActivity('テスト処理')
    expect(_activeCount()).toBe(1)
    end()
    expect(_activeCount()).toBe(0)
    end() // 二重呼び出し
    expect(_activeCount()).toBe(0)
  })

  it('nested activities with different labels end independently and never go negative', () => {
    const endOuter = beginActivity('外側')
    const endInner = beginActivity('内側')
    expect(_activeCount()).toBe(2)
    endInner()
    expect(_activeCount()).toBe(1)
    endOuter()
    expect(_activeCount()).toBe(0)
    // 余分な end() 呼び出し（既に終了済み）があっても 0 未満にならない
    endOuter()
    endInner()
    expect(_activeCount()).toBe(0)
  })

  it('does not throw even though window.electronAPI is undefined in the test env', () => {
    expect(() => {
      const end = beginActivity('例外にならないこと')
      end()
    }).not.toThrow()
  })
})
