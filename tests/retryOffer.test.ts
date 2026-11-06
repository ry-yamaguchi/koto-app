// 「もう一度送る」ボタン（src/shared/retryOffer.ts・RetryButton.tsx・配線）。
// 出す・出さないの表と、材料の取り出し、描画、ChatPanel・ChatApp の呼び口を固定する。

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { retryRequestOf, showsRetry } from '../src/shared/retryOffer'
import RetryButton, { RETRY_BUTTON_LABEL } from '../src/renderer/components/RetryButton'

type M = { role: string; content: string; hidden?: boolean; summary?: unknown; images?: string[]; offerRetry?: true; toolNote?: boolean }
const user = (content: string, extra: Partial<M> = {}): M => ({ role: 'user', content, ...extra })
const ai = (content: string, extra: Partial<M> = {}): M => ({ role: 'assistant', content, ...extra })
const fail = (): M => ai('⚠️ 失敗', { offerRetry: true })

const IMG = 'data:image/png;base64,AAAA'

describe('retryRequestOf: 失敗の吹き出しより前で最後の、見える利用者の吹き出し', () => {
  it('ふつうの失敗: 直前の依頼の文を返す（画像が無ければ空の配列）', () => {
    expect(retryRequestOf([user('ホームページを作って'), fail()])).toEqual({ text: 'ホームページを作って', images: [] })
  })

  it('画像つきの依頼は、画像もそのまま返す', () => {
    expect(retryRequestOf([user('この絵で', { images: [IMG] }), fail()])).toEqual({ text: 'この絵で', images: [IMG] })
  })

  it('間に挟まった AI の吹き出し・ツールの注記は飛ばす', () => {
    const msgs = [user('直して'), ai('ファイルを読みます', { toolNote: true }), ai('途中まで'), fail()]
    expect(retryRequestOf(msgs)).toEqual({ text: '直して', images: [] })
  })

  it('hidden の利用者の吹き出し（AI への内部指示）は拾わない', () => {
    const msgs = [user('本当の依頼'), user('内部の指示', { hidden: true }), fail()]
    expect(retryRequestOf(msgs)).toEqual({ text: '本当の依頼', images: [] })
  })

  it('summary（まとめ）の吹き出しは拾わない', () => {
    const msgs = [user('本当の依頼'), user('まとめ本文', { summary: { upTo: 1, mark: 'x' } }), fail()]
    expect(retryRequestOf(msgs)).toEqual({ text: '本当の依頼', images: [] })
  })

  it('失敗が2つあるときは、最後の失敗の前の依頼を返す', () => {
    const msgs = [user('1つ目'), fail(), user('2つ目'), fail()]
    expect(retryRequestOf(msgs)).toEqual({ text: '2つ目', images: [] })
  })

  it('材料が無ければ null（失敗が無い・依頼が無い・依頼が見えるものでない・中身が空）', () => {
    expect(retryRequestOf([])).toBeNull()
    expect(retryRequestOf([user('依頼'), ai('返事')])).toBeNull()
    expect(retryRequestOf([fail()])).toBeNull()
    expect(retryRequestOf([user('内部', { hidden: true }), fail()])).toBeNull()
    expect(retryRequestOf([user('  '), fail()])).toBeNull()
  })
})

describe('showsRetry: 最後の失敗にだけ出す', () => {
  it('依頼の直後の失敗には出る', () => {
    expect(showsRetry([user('依頼'), fail()], 1)).toBe(true)
  })

  it('印の無い吹き出しには出ない', () => {
    const msgs = [user('依頼'), ai('返事')]
    expect(showsRetry(msgs, 1)).toBe(false)
    expect(showsRetry(msgs, 0)).toBe(false)
    expect(showsRetry(msgs, 9)).toBe(false)
  })

  it('以降に見える利用者の吹き出しがあれば出ない（送り直したあと・次の依頼を送ったあと）', () => {
    const msgs = [user('1つ目'), fail(), user('2つ目'), ai('成功')]
    expect(showsRetry(msgs, 1)).toBe(false)
  })

  it('以降が hidden の利用者の吹き出しや AI の吹き出しだけなら、まだ出る', () => {
    const msgs = [user('依頼'), fail(), user('内部', { hidden: true }), ai('ℹ️ 案内', { toolNote: true })]
    expect(showsRetry(msgs, 1)).toBe(true)
  })

  it('失敗が2つ続くときは、最後の失敗にだけ出る', () => {
    const msgs = [user('依頼'), fail(), user('同じ依頼'), fail()]
    expect(showsRetry(msgs, 1)).toBe(false)
    expect(showsRetry(msgs, 3)).toBe(true)
  })

  it('間に利用者の吹き出しが無く失敗が続くときも、最後の失敗にだけ出る', () => {
    const msgs = [user('依頼'), fail(), fail()]
    expect(showsRetry(msgs, 1)).toBe(false)
    expect(showsRetry(msgs, 2)).toBe(true)
  })

  it('材料が無ければ、印があっても出さない', () => {
    expect(showsRetry([fail()], 0)).toBe(false)
    expect(showsRetry([user('内部', { hidden: true }), fail()], 1)).toBe(false)
  })
})

describe('RetryButton の描画', () => {
  const html = (over: Partial<Parameters<typeof RetryButton>[0]> = {}) =>
    renderToStaticMarkup(createElement(RetryButton, { show: true, isLoading: false, onPress: () => {}, ...over }))

  it('出すとき: 決めた文のボタンで、押せる', () => {
    const h = html()
    expect(RETRY_BUTTON_LABEL).toBe('もう一度送る')
    expect(h).toContain('<button')
    expect(h).toContain('もう一度送る')
    expect(h).not.toContain('disabled=""')
  })

  it('応答中は出したまま押せない', () => {
    expect(html({ isLoading: true })).toContain('disabled=""')
  })

  it('出さないとき: 何も描かない', () => {
    expect(html({ show: false })).toBe('')
  })
})

describe('配線: ChatPanel・ChatApp の2つに出し、押したら chat.retryLast を呼ぶ', () => {
  const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8')
  const CALL = '<RetryButton show={showsRetry(shown, i)} isLoading={chat.isLoading} onPress={() => void chat.retryLast()} />'

  for (const file of ['src/renderer/components/ChatPanel.tsx', 'src/renderer/components/ChatApp.tsx']) {
    it(`${file}: 呼び口は1つで、形がそろっている`, () => {
      const src = read(file)
      expect(src).toContain(CALL)
      expect(src.split('<RetryButton ').length - 1).toBe(1)
    })
  }

  it('shown は画面に並べている吹き出しそのもの（ChatApp は会話の全件、ChatPanel は hidden を除いた全件）で、添字 i はその map のもの', () => {
    const app = read('src/renderer/components/ChatApp.tsx')
    expect(app).toContain('const shown = activeSession.messages\n')
    expect(app).toContain('return shown.map((msg, i) => {')
    const panel = read('src/renderer/components/ChatPanel.tsx')
    expect(panel).toContain('const shown = messages.filter(m => !m.hidden)\n')
    expect(panel).toContain('return shown.map((msg, i) => {')
  })

  it('retryOffer.ts・RetryButton.tsx は updateShown( も画面の状態も触らない（判断と描画だけ）', () => {
    for (const f of ['src/shared/retryOffer.ts', 'src/renderer/components/RetryButton.tsx']) {
      expect(read(f)).not.toContain('updateShown(')
    }
  })

  it('useAiChat.ts: retryLast は retryRequestOf の材料を既存の send へ渡し、返り値に出す', () => {
    const src = read('src/renderer/hooks/useAiChat.ts')
    expect(src).toContain('const req = retryRequestOf(getHistory())')
    expect(src).toContain('await send(req.text, req.images)')
    expect(src).toContain('switchToAiEngineAndResend, retryLast,')
  })
})
