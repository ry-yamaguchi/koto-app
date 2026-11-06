import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ErrorMessageBlock } from '../src/renderer/components/VpsPanel'
import { joinFailureDetail } from '../src/shared/failureDetail'

// さくらのVPSの失敗の枠: 文の下に「詳細: stderr の原文」を別の行で出す（以前は文字列をそのまま1つの段落に流していた）。
describe('VPS の失敗の枠', () => {
  it('★ 詳細は別の要素・文には含めない', () => {
    const msg = joinFailureDetail('サーバに到達できませんでした（ネットワークやホスト名/IPを確認してください）', 'ssh: connect to host x port 22: No route to host')
    const out = renderToStaticMarkup(createElement(ErrorMessageBlock, { msg }))
    expect(out).toMatch(/<span class="[^"]*">詳細: ssh: connect to host x port 22: No route to host<\/span>/)
    expect(out).toContain('サーバに到達できませんでした')
  })
})
