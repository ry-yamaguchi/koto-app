import { describe, it, expect } from 'vitest'
import { extOf, rescueTargets, withoutImages, droppedNote, stampOf } from '../src/shared/chatImages'
import { MATERIALS_DIR } from '../src/shared/publishExclude'

// 2026-08-20 実測で見つけた欠陥の再発防止。
// 単独チャットの保存は、失敗すると**全セッションの画像を黙って落として**保存し直し、
// console.warn を出すだけだった。「画像を使う」を押していない画像はそこにしか無いので、
// 利用者は理由も分からないまま画像を失っていた（手元では chat.json の 99% が画像）。

const png = 'data:image/png;base64,AAAA'
const jpg = 'data:image/jpeg;base64,BBBB'

describe('stampOf（ファイル名に入れる日時）', () => {
  it('手元の時刻で組み立てる（UTC にしない）', () => {
    expect(stampOf(new Date(2026, 7, 20, 17, 5))).toBe('20260820-1705')
  })

  it('1桁はゼロ詰めする', () => {
    expect(stampOf(new Date(2026, 0, 2, 3, 4))).toBe('20260102-0304')
  })
})

describe('extOf（書き出すときの拡張子）', () => {
  it('種類から決める', () => {
    expect(extOf(png)).toBe('png')
    expect(extOf('data:image/webp;base64,x')).toBe('webp')
  })

  it('jpeg / jpg はどちらも jpg にそろえる', () => {
    expect(extOf(jpg)).toBe('jpg')
    expect(extOf('data:image/jpg;base64,x')).toBe('jpg')
  })

  it('svg+xml は svg にする（そのままだとファイル名に使えない）', () => {
    expect(extOf('data:image/svg+xml;base64,x')).toBe('svg')
  })

  it('分からないものは png として扱う（拡張子が無いより良い）', () => {
    expect(extOf('')).toBe('png')
    expect(extOf('data:text/plain;base64,x')).toBe('png')
    expect(extOf(undefined as any)).toBe('png')
  })
})

describe('rescueTargets（落とす前に助ける画像）', () => {
  const sessions = [
    { messages: [{ images: [png] }, { content: 'text' } as any, { images: [jpg, png] }] },
    { messages: [{ images: [png] }] },
  ]

  it('全セッション・全メッセージの画像を順に拾う', () => {
    expect(rescueTargets(sessions, '20260820')).toHaveLength(4)
  })

  it('名前は並び順で決まる（同じ会話なら何度でも同じ）', () => {
    const a = rescueTargets(sessions, '20260820').map(t => t.name)
    const b = rescueTargets(sessions, '20260820').map(t => t.name)
    expect(a).toEqual(b)
    expect(a[0]).toBe('会話の画像-20260820-001.png')
    expect(a[1]).toBe('会話の画像-20260820-002.jpg')
  })

  it('画像でないものは拾わない', () => {
    expect(rescueTargets([{ messages: [{ images: ['https://example.com/a.png', '', null as any] }] }], 's')).toEqual([])
  })

  it('空・欠けた形でも壊れない', () => {
    expect(rescueTargets([], 's')).toEqual([])
    expect(rescueTargets([{}, { messages: undefined }] as any, 's')).toEqual([])
    expect(rescueTargets(null as any, 's')).toEqual([])
  })
})

describe('withoutImages（画像を落とした写しを作る）', () => {
  it('画像だけを外し、ほかは残す', () => {
    const src = [{ id: 'a', title: 'あ', messages: [{ role: 'user', content: 'x', images: [png] }] }]
    const out = withoutImages(src as any)
    expect(out[0].id).toBe('a')
    expect((out[0] as any).title).toBe('あ')
    expect((out[0].messages as any)[0].content).toBe('x')
    expect((out[0].messages as any)[0].images).toBeUndefined()
  })

  it('元の配列は書き換えない', () => {
    const src = [{ messages: [{ images: [png] }] }]
    withoutImages(src)
    expect(src[0].messages[0].images).toEqual([png])
  })
})

describe('droppedNote（画面に出す知らせ）', () => {
  it('落としていなければ何も言わない', () => {
    expect(droppedNote(0, 0, MATERIALS_DIR)).toBe('')
  })

  it('全部助けられたら、どこへ行ったかを言う', () => {
    const n = droppedNote(3, 3, MATERIALS_DIR)
    expect(n).toContain('画像3枚を会話から外しました')
    expect(n).toContain(MATERIALS_DIR)
    expect(n).not.toContain('失敗')
  })

  it('一部しか助けられなかったら、その数も言う', () => {
    const n = droppedNote(1, 3, MATERIALS_DIR)
    expect(n).toContain('うち1枚')
    expect(n).toContain('残り2枚')
  })

  it('1枚も助けられなかったら、表示されなくなることをはっきり言う', () => {
    // ここを黙ると、利用者は次に開いたときに理由の分からない欠落を見ることになる。
    const n = droppedNote(0, 3, MATERIALS_DIR)
    expect(n).toContain('画像は表示されません')
  })
})
