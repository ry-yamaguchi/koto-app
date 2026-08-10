// Claude頭脳モードの画像直接処理（C2d・src/main/claude/vision.ts）のテスト。
// parseDataUrl: data URL の分解、buildUserContent: SDKUserMessage.message.content 用ブロック配列の組み立て。
import { describe, it, expect } from 'vitest'
import { parseDataUrl, buildUserContent, ALLOWED_IMAGE_TYPES } from '../src/main/claude/vision'

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='

describe('parseDataUrl', () => {
  it('PNG/JPEG の data URL を mediaType と base64 データに分解する', () => {
    expect(parseDataUrl(PNG)).toEqual({ mediaType: 'image/png', data: 'iVBORw0KGgo=' })
    expect(parseDataUrl(JPEG)).toEqual({ mediaType: 'image/jpeg', data: '/9j/4AAQSkZJRg==' })
  })

  it('data URL の形をしていない文字列は null', () => {
    expect(parseDataUrl('https://example.com/a.png')).toBeNull()
    expect(parseDataUrl('')).toBeNull()
    expect(parseDataUrl('iVBORw0KGgo=')).toBeNull()
  })

  it('base64 エンコーディングでない data URL は null（例: SVGの素のURLエンコード形式）', () => {
    expect(parseDataUrl('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>')).toBeNull()
  })

  it('base64 として不正な文字を含む場合は null', () => {
    expect(parseDataUrl('data:image/png;base64,あいう')).toBeNull()
  })
})

describe('buildUserContent', () => {
  it('テキストのみ（画像なし）はテキストブロック1件', () => {
    expect(buildUserContent('こんにちは', [])).toEqual([{ type: 'text', text: 'こんにちは' }])
  })

  it('テキスト＋画像1枚はテキスト＋画像ブロックの順', () => {
    const blocks = buildUserContent('この画像を見て', [PNG])
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({ type: 'text', text: 'この画像を見て' })
    expect(blocks[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } })
  })

  it('複数画像はすべてブロック化される', () => {
    const blocks = buildUserContent('比較して', [PNG, JPEG])
    expect(blocks.filter(b => b.type === 'image')).toHaveLength(2)
  })

  it('許可外の media_type・不正な data URL は黙って除外される', () => {
    const blocks = buildUserContent('見て', [
      'data:application/pdf;base64,JVBERi0=', // 許可外タイプ
      'not-a-data-url',                        // 不正形式
      PNG,                                     // 有効
    ])
    expect(blocks.filter(b => b.type === 'image')).toHaveLength(1)
  })

  it('テキストが空なら画像ブロックのみ（空テキストブロックを含めない）', () => {
    const blocks = buildUserContent('', [PNG])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('image')
  })

  it('許可タイプは png/jpeg/webp/gif の4種', () => {
    expect([...ALLOWED_IMAGE_TYPES]).toEqual(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
  })
})
