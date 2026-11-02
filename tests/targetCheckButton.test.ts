// 公開先を変えたあとの吹き出しのボタン（src/renderer/components/TargetCheckButton.tsx）。
// 出す・隠す・押せない、の見え方と、押したときの処理が親から渡したものであることを確かめる。
// 描画は renderToStaticMarkup（フックを使わない部品なので、そのまま描ける）。

import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import TargetCheckButton from '../src/renderer/components/TargetCheckButton'
import { TARGET_CHECK_BUTTON_LABEL } from '../src/renderer/targetCheck'

const DIR = '/work/my-app'
const OTHER = '/work/other-app'
const PRESSED = '2026-10-29T10:00:00.000Z'
const BEFORE = '2026-10-29T09:59:59.000Z'
const AFTER = '2026-10-29T10:00:01.000Z'

type Props = Parameters<typeof TargetCheckButton>[0]
const props = (over: Partial<Props> = {}): Props => ({
  offered: true, dir: DIR, spent: new Map<string, string>(), isLoading: false, onPress: () => {}, ...over,
})
const html = (over: Partial<Props> = {}) => renderToStaticMarkup(createElement(TargetCheckButton, props(over)))

describe('T-4g 描画: 吹き出しのボタン', () => {
  it('印のある吹き出し・プロジェクトあり・押し終えていない → 決めた文のボタンが出て、押せる', () => {
    const h = html()
    expect(h).toContain('<button')
    expect(h).toContain(TARGET_CHECK_BUTTON_LABEL)
    expect(h).not.toContain('disabled=""')
  })

  it('応答中は出したまま押せない（disabled）', () => {
    const h = html({ isLoading: true })
    expect(h).toContain(TARGET_CHECK_BUTTON_LABEL)
    expect(h).toContain('disabled=""')
  })

  it('印の無い吹き出し・プロジェクトが無い回は出さない', () => {
    expect(html({ offered: undefined })).toBe('')
    expect(html({ offered: false })).toBe('')
    expect(html({ dir: null })).toBe('')
    expect(html({ dir: undefined })).toBe('')
    expect(html({ dir: '' })).toBe('')
  })

  it('押したあとは、押す前の吹き出しのボタンが隠れる。別のプロジェクトを押していても、こちらは出る', () => {
    expect(html({ spent: new Map([[DIR, PRESSED]]), at: BEFORE })).toBe('')
    expect(html({ spent: new Map([[OTHER, PRESSED]]), at: BEFORE })).toContain(TARGET_CHECK_BUTTON_LABEL)
  })

  it('押したあとに出た吹き出しには、ボタンが出る。at が無い吹き出しは押す前のものとして隠れる', () => {
    const spent = new Map([[DIR, PRESSED]])
    expect(html({ spent, at: AFTER })).toContain(TARGET_CHECK_BUTTON_LABEL)
    expect(html({ spent, at: undefined })).toBe('')
    expect(html({ spent: new Map(), at: BEFORE })).toContain(TARGET_CHECK_BUTTON_LABEL)
  })

  it('Claude の利用料は、ボタンの近くに書かない', () => {
    const h = html()
    for (const word of ['利用料', '費用', '円', '課金', '$']) expect(h, word).not.toContain(word)
  })
})

describe('T-4c ボタンの onClick は親から渡した処理そのもの（空にすると押しても何も起きない）', () => {
  // 描画せずに部品の返す要素を直接見る（クリックの代わりに props.onClick を取り出す）
  const buttonOf = (over: Partial<Props> = {}) => {
    const el = TargetCheckButton(props(over)) as unknown as { type: string; props: { onClick: () => void; disabled: boolean } } | null
    return el
  }

  it('押すと渡した onPress が1回呼ばれる', () => {
    let pressed = 0
    const el = buttonOf({ onPress: () => { pressed++ } })
    expect(el?.type).toBe('button')
    el!.props.onClick()
    expect(pressed).toBe(1)
  })

  it('disabled は応答中だけ立つ', () => {
    expect(buttonOf({ isLoading: false })!.props.disabled).toBe(false)
    expect(buttonOf({ isLoading: true })!.props.disabled).toBe(true)
  })

  it('出さない回は何も返さない', () => {
    expect(buttonOf({ offered: undefined })).toBeNull()
    expect(buttonOf({ spent: new Map([[DIR, PRESSED]]), at: BEFORE })).toBeNull()
  })
})
