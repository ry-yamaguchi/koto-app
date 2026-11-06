import React from 'react'
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createBucketListController } from '../src/renderer/storageChoice'
import { askAiRewritePlan } from '../src/shared/storageNoticeText'
import { askAiMoveDataPlan, leftoverScanLine } from '../src/shared/leftoverData'
import { splitFailureDetail } from '../src/shared/failureDetail'
import { KeptLines } from '../src/renderer/components/StorageNotice'
import FailureLines from '../src/renderer/components/FailureLines'

// ── 保存場所まわりの画面の文: 失敗の文は「日本語の文＋詳細: 原文」で、詳細は文の途中に挟まらない ──────────────

const JAPANESE = /[぀-ヿ一-鿿]/
const MAIN_SENTENCE = 'インターネットに接続できませんでした。接続を確かめてから、もう一度お試しください。'
const WITH_DETAIL = `${MAIN_SENTENCE}\n詳細: getaddrinfo ENOTFOUND secure.sakura.ad.jp`

describe('保存場所の一覧（controller）: 呼び出しそのものが失敗したとき', () => {
  it('IPC の英語の頭を落とし、日本語の文＋詳細にする', async () => {
    const states: Array<{ listError: string }> = []
    const c = createBucketListController({
      status: async () => { throw new Error("Error invoking remote method 'storage:status': TypeError: fetch failed") },
      recorded: () => '',
      onChange: s => { states.push(s as { listError: string }) },
    })
    await c.reload()
    const { text, detail } = splitFailureDetail(c.get().listError)
    expect(JAPANESE.test(text)).toBe(true)
    expect(text).not.toContain('Error invoking')
    expect(detail).toBe('fetch failed')
  })

  it('main が日本語の文＋詳細で返した理由は、そのまま残る', async () => {
    const c = createBucketListController({
      status: async () => ({ ok: false, message: WITH_DETAIL, siteReady: false, buckets: [] }),
      recorded: () => '',
      onChange: () => {},
    })
    await c.reload()
    expect(c.get().listError).toBe(WITH_DETAIL)
  })
})

describe('AI に頼む前の「koto-data を用意できませんでした」', () => {
  const layer = { ok: false, ready: false, message: WITH_DETAIL }
  it.each([
    ['書き直してもらう', () => askAiRewritePlan([], layer)],
    ['一緒に移してもらう', () => askAiMoveDataPlan([], layer)],
  ])('%s: 原因の文は前置きのあとに続け、原文（詳細）は最後の行', (_n, plan) => {
    const p = plan()
    expect(p.send).toBe(false)
    if (p.send) return
    const { text, detail } = splitFailureDetail(p.error)
    expect(text).toContain('データ保存用のファイル（koto-data）を用意できませんでした。インターネットに接続できませんでした。接続を確かめてから、もう一度お試しください。')
    expect(text).not.toContain('少し待ってから')
    expect(text).not.toContain('（インターネット')
    expect(detail).toContain('secure.sakura.ad.jp')
    expect(p.error.endsWith(`詳細: ${detail}`)).toBe(true)
  })

  it('message が無い・原文だけ（見分けられない失敗）でも壊れない', () => {
    const none = askAiRewritePlan([], { ok: false })
    expect(none.send === false && none.error).toBe('データ保存用のファイル（koto-data）を用意できませんでした。少し待ってから、もう一度お試しください。')
    const raw = askAiMoveDataPlan([], { ok: false, message: 'EPIPE weird' })
    expect(raw.send === false && raw.error).toContain('（EPIPE weird）')
  })
})

describe('描いた HTML', () => {
  it('KeptLines: 目印を置けなかった知らせの「詳細: 原文」は、文と別の小さな行', () => {
    const note = `保存場所は用意できましたが、目印を置けませんでした（${MAIN_SENTENCE.replace(/。$/, '')}）。\n詳細: read ECONNRESET`
    const html = renderToStaticMarkup(React.createElement(KeptLines, { markerNote: note, dataLayerLine: '', checkLine: '' }))
    expect(html).toContain('詳細: read ECONNRESET')
    expect(html).toContain('select-text')
    // 文の側に詳細が混ざらない
    expect(html.indexOf('詳細: ')).toBeGreaterThan(html.indexOf('目印を置けませんでした'))
    expect(html).toMatch(/<span class="[^"]*text-\[10px\][^"]*">詳細: read ECONNRESET<\/span>/)
  })

  it('FailureLines: 詳細が無い文はそのまま', () => {
    expect(renderToStaticMarkup(React.createElement(FailureLines, { text: '用意できませんでした' }))).toBe('用意できませんでした')
  })

  it('leftoverScanLine: 詳細つきの理由を括弧の中に入れても、詳細は最後の行', () => {
    const line = leftoverScanLine({ ok: false, message: WITH_DETAIL })
    expect(line.endsWith('詳細: getaddrinfo ENOTFOUND secure.sakura.ad.jp')).toBe(true)
    expect(splitFailureDetail(line).text).toContain('いま入っているデータを確かめられませんでした。インターネットに接続できませんでした。')
  })
})
