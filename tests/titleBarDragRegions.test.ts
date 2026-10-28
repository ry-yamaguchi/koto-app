import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import TitleBar from '../src/renderer/components/TitleBar'

// 2026-10-20 作者:「バーの中でボタンなどがない場所をダブルクリックしたら、いまの動作（画面いっぱい）が出来るようにして欲しい」。
// ダブルクリックで拡大するのは macOS の標準の動きで、**ドラッグできる場所（-webkit-app-region: drag）でだけ**起きる。
// 以前は右半分の箱を丸ごと no-drag にしていたので、ボタンの無い空き地でも効かず、左側（ロゴ・版番号のあたり）でだけ効いた。
// いまはバー全体をドラッグできる場所にし、**押せるもの（ボタン）だけを no-drag** にする。
// 描いた HTML で確かめる（ソースの文字列ではなく、実際に付いている style を見る）。

const noop = () => {}
function render(mode: 'ide' | 'chat'): string {
  return renderToStaticMarkup(createElement(TitleBar, {
    mode, onSwitchMode: noop, theme: 'light', onSwitchTheme: noop,
    showChat: true, showTerminal: false, onToggleChat: noop, onToggleTerminal: noop,
    onOpenSettings: noop, onPublish: noop, onOpenKnowledge: noop, onOpenGithubSave: noop, onOpenHistory: noop,
    version: '0.6.23',
  } as any))
}

/** 開始タグを全部取り出す（属性つき）。 */
function openTags(html: string, tag: string): string[] {
  return html.match(new RegExp(`<${tag}\\b[^>]*>`, 'g')) ?? []
}
const isNoDrag = (t: string) => /-webkit-app-region:\s*no-drag/.test(t)
const isDrag = (t: string) => /-webkit-app-region:\s*drag/.test(t)

describe('上部のバー: 空き地はドラッグできる場所（ダブルクリックで拡大）・ボタンは押せる場所', () => {
  for (const mode of ['ide', 'chat'] as const) {
    it(`★ ${mode}: バーの外枠はドラッグできる場所`, () => {
      const root = openTags(render(mode), 'div')[0]
      expect(isDrag(root)).toBe(true)
    })

    it(`★ ${mode}: すべてのボタンが押せる場所（付け忘れたボタンは押せなくなる）`, () => {
      const buttons = openTags(render(mode), 'button')
      expect(buttons.length).toBeGreaterThanOrEqual(mode === 'ide' ? 10 : 5)
      for (const b of buttons) expect(isNoDrag(b), b).toBe(true)
    })

    it(`★ ${mode}: 右側の箱（ボタンが並ぶ所）は丸ごと押せる場所にしない（空き地で効かなくなる）`, () => {
      const right = openTags(render(mode), 'div').find(t => t.includes('justify-end'))
      expect(right).toBeTruthy()
      expect(isNoDrag(right!)).toBe(false)
    })
  }

  it('真ん中の切り替え（IDE／チャット）のつまみは押せる場所のまま', () => {
    const pill = openTags(render('ide'), 'div').find(t => t.includes('bg-elevated rounded-xl'))
    expect(pill).toBeTruthy()
    expect(isNoDrag(pill!)).toBe(true)
  })
})
