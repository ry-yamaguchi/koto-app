import { describe, it, expect } from 'vitest'
import {
  FAILURE_DETAIL_LABEL, splitFailureDetail, joinFailureDetail, wrapFailureText, failureCopyText, formatCopyStamp,
} from '../src/shared/failureDetail'

// 詳細つきの文の形（文＋最後の1行の「詳細: …」）の分け方・つなぎ方・埋め込み・コピーの文。

describe('splitFailureDetail', () => {
  it('最後の行が「詳細: …」のときだけ分ける', () => {
    expect(splitFailureDetail('文です。\n詳細: ENOTFOUND')).toEqual({ text: '文です。', detail: 'ENOTFOUND' })
  })

  it('詳細が無ければ文のまま', () => {
    expect(splitFailureDetail('文です。')).toEqual({ text: '文です。', detail: '' })
  })

  it('★ 最後の行でない「詳細: …」は詳細ではない', () => {
    const s = '文です。\n詳細: 途中\n続きの行'
    expect(splitFailureDetail(s)).toEqual({ text: s, detail: '' })
  })

  it('詳細が空・空白だけなら詳細なし', () => {
    expect(splitFailureDetail('文です。\n詳細: ').detail).toBe('')
    expect(splitFailureDetail('文です。\n詳細:    ').detail).toBe('')
  })
})

describe('joinFailureDetail', () => {
  it('文の下に1行で添える（空白・改行は1つの空白にまとめる）', () => {
    expect(joinFailureDetail('文です。', 'a\n  b\tc')).toBe('文です。\n詳細: a b c')
  })

  it('詳細が空なら文のまま', () => {
    expect(joinFailureDetail('文です。', '')).toBe('文です。')
    expect(joinFailureDetail('文です。', '  \n ')).toBe('文です。')
  })

  it('★ すでに詳細があれば足さない（先に付いたほうが本物の原文）', () => {
    const once = joinFailureDetail('文です。', '本物')
    expect(joinFailureDetail(once, '別')).toBe(once)
  })

  it('ラベルは「詳細: 」', () => {
    expect(FAILURE_DETAIL_LABEL).toBe('詳細: ')
  })
})

describe('wrapFailureText', () => {
  it('埋め込むのは日本語の文だけ。詳細は外側の文の最後へ移る', () => {
    const shown = 'ネットに接続できませんでした。\n詳細: ENOTFOUND h'
    const out = wrapFailureText(shown, t => `チェックに失敗しました（${t.replace(/。$/, '')}）。`)
    expect(out).toBe('チェックに失敗しました（ネットに接続できませんでした）。\n詳細: ENOTFOUND h')
  })

  it('詳細が無ければ外側の文だけ', () => {
    expect(wrapFailureText('文。', t => `「${t}」`)).toBe('「文。」')
  })
})

describe('failureCopyText', () => {
  const at = new Date(2026, 10, 5, 0, 7)

  it('日時の形は YYYY-MM-DD HH:mm', () => {
    expect(formatCopyStamp(at)).toBe('2026-11-05 00:07')
  })

  it('文・詳細・版・日時の順に並ぶ', () => {
    expect(failureCopyText('文。\n詳細: ENOTFOUND', { version: '0.6.26', at })).toBe('文。\n詳細: ENOTFOUND\nKoto 0.6.26・2026-11-05 00:07')
  })

  it('詳細が無ければ詳細の行を作らない・版が分からなければ「不明」', () => {
    expect(failureCopyText('文。', { at })).toBe('文。\nKoto 不明・2026-11-05 00:07')
    expect(failureCopyText('文。', { version: '  ', at })).toBe('文。\nKoto 不明・2026-11-05 00:07')
  })

  it('★ 秘密の形とホームのパスを伏せる（文の側も）', () => {
    const out = failureCopyText('失敗 Bearer abcdefghijklmnopqrstuvwxyz123456\n詳細: open /Users/taro/app/a.txt', { version: '1', at })
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz123456')
    expect(out).not.toContain('/Users/taro')
    expect(out).toContain('~/app/a.txt')
  })
})
