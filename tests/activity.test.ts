import { describe, it, expect } from 'vitest'
import { beginActivity, _activeCount, _blockingCount } from '../src/renderer/activity'

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

// ── B'-3d-3: blocksClose（閉じる前の確認ダイアログの対象かどうか）─────────────────
// AI応答（useAiChat.ts）は main でターンが完走するようになったので、_activeCount（何かしら
// 実行中か・自動更新の再起動ゲートに使う）には数えつつ、_blockingCount（閉じると本当に
// 中断されるもの）からは外れる。既定（opts省略）は今までどおり両方に数える。
describe('beginActivity: blocksClose（B\'-3d-3）', () => {
  it('既定（opts省略）は _activeCount と _blockingCount の両方に数える', () => {
    expect(_activeCount()).toBe(0)
    expect(_blockingCount()).toBe(0)
    const end = beginActivity('公開処理')
    expect(_activeCount()).toBe(1)
    expect(_blockingCount()).toBe(1)
    end()
    expect(_activeCount()).toBe(0)
    expect(_blockingCount()).toBe(0)
  })

  it('blocksClose: false は _activeCount には数えるが _blockingCount には数えない（AI応答）', () => {
    const end = beginActivity('AIが応答中', { blocksClose: false })
    expect(_activeCount()).toBe(1)
    expect(_blockingCount()).toBe(0)
    end()
    expect(_activeCount()).toBe(0)
    expect(_blockingCount()).toBe(0)
  })

  it('blocksClose: false と既定（true 相当）が同時に走っても、それぞれ正しく数えられる', () => {
    const endAi = beginActivity('AIが応答中', { blocksClose: false })
    const endPublish = beginActivity('公開処理')
    expect(_activeCount()).toBe(2)
    expect(_blockingCount()).toBe(1) // AI応答はブロック対象外
    endAi()
    expect(_activeCount()).toBe(1)
    expect(_blockingCount()).toBe(1) // 公開処理はまだ実行中
    endPublish()
    expect(_activeCount()).toBe(0)
    expect(_blockingCount()).toBe(0)
  })

  it('blocksClose: false の end() を二重に呼んでも 0 未満にならない', () => {
    const end = beginActivity('AIが応答中', { blocksClose: false })
    end()
    end()
    expect(_activeCount()).toBe(0)
    expect(_blockingCount()).toBe(0)
  })
})
