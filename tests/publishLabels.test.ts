import { describe, it, expect } from 'vitest'
import { publishButtonLabel } from '../src/shared/publishLabels'

// 委譲仕様 UX-E・判断8: 公開ボタンの文言を1関数に一元化する。
// HANAMII「再公開する」・AppRun共用型「公開する（作成・更新）」・専有型/Vercel「公開する」の
// 3通りを「🚀 公開する」／「🚀 公開する（更新）」の2つに揃える。

describe('publishButtonLabel: 公開ボタンの文言（純関数）', () => {
  it('未公開（published=false）なら「🚀 公開する」', () => {
    expect(publishButtonLabel(false)).toBe('🚀 公開する')
  })

  it('公開済み（published=true）なら「🚀 公開する（更新）」', () => {
    expect(publishButtonLabel(true)).toBe('🚀 公開する（更新）')
  })
})
