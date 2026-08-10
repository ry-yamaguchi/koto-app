import { describe, it, expect } from 'vitest'
import { countNonImageFiles } from '../src/renderer/imageInput'

// 所見19: 画像以外のファイル添付が無反応だった問題の回帰テスト。
// fileToDataUrl は非画像を黙って null で捨てるため、呼び出し側（ChatPanel/ChatApp）が
// 「画像ファイルのみ添付できます」と案内できるよう、非画像の件数を数える純粋関数を用意した。
// countNonImageFiles は File 全体ではなく `{ type }` を受け取り、DOM非依存でテストできる。
describe('countNonImageFiles', () => {
  it('returns 0 when every file is an image', () => {
    expect(countNonImageFiles([{ type: 'image/png' }, { type: 'image/jpeg' }])).toBe(0)
  })

  it('counts non-image files (PDF/テキスト等)', () => {
    expect(countNonImageFiles([{ type: 'application/pdf' }, { type: 'image/png' }, { type: 'text/plain' }])).toBe(2)
  })

  it('treats an empty MIME type as non-image', () => {
    expect(countNonImageFiles([{ type: '' }])).toBe(1)
  })

  it('returns 0 for an empty list', () => {
    expect(countNonImageFiles([])).toBe(0)
  })
})
