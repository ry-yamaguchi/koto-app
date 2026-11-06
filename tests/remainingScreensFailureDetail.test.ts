import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { failureText } from '../src/shared/failureText'
import { splitFailureDetail } from '../src/shared/failureDetail'
import ProjectDeleteResults from '../src/renderer/components/teardown/ProjectDeleteResults'
import { joinUploadErrors } from '../src/renderer/components/KnowledgeCollectorTab'
import { savedFailureNote } from '../src/renderer/components/CompactNote'
import { trashFailureText } from '../src/renderer/teardown/projectDelete'

// 専有型・資料・削除の画面で、置き換えた失敗の文の下に原文（詳細）が小さく出ること、
// 文の途中や括弧の中に詳細が挟まらないことを、描いた HTML と返り値で固める。

const read = (rel: string): string => fs.readFileSync(path.resolve(__dirname, '..', 'src/renderer', rel), 'utf-8')
const count = (src: string, needle: string): number => src.split(needle).length - 1

const SENTENCE = 'インターネットに接続できませんでした。接続を確かめてから、もう一度お試しください。'
const DETAIL = 'getaddrinfo ENOTFOUND api.ai.sakura.ad.jp'
const shown = `${SENTENCE}\n詳細: ${DETAIL}`
const DETAIL_SPAN = `>詳細: ${DETAIL}</span>`
const offline = (): Error => Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND', message: DETAIL } })

describe('ProjectDeleteResults: 失敗の文の下に詳細の行', () => {
  const failedStep = { target: 'hanamii', kind: 'failed', line: `HANAMII: ${shown}`, view: null, words: null } as any

  it('失敗した公開先の1行は、文のすぐ下に小さな詳細の行が出る（文の側に「詳細: 」は混ざらない）', () => {
    const h = renderToStaticMarkup(React.createElement(ProjectDeleteResults, { run: { phase: 'stopped', steps: [failedStep] } as any, showBlockNote: true }))
    expect(h).toContain(`HANAMII: ${SENTENCE}`)
    expect(h).toContain(DETAIL_SPAN)
    expect(h).toContain('text-[10px]')
    expect(h.replace(DETAIL_SPAN, '')).not.toContain('詳細: ')
  })

  it('フォルダを移せなかった理由の箱も、文と詳細の行に分けて描く', () => {
    const h = renderToStaticMarkup(React.createElement(ProjectDeleteResults, {
      run: { phase: 'trashFailed', steps: [], message: `プロジェクトを削除できませんでした: ${shown}` } as any, showBlockNote: true,
    }))
    expect(h).toContain(DETAIL_SPAN)
    expect(h.replace(DETAIL_SPAN, '')).not.toContain('詳細: ')
  })

  it('詳細の無い文には詳細の行が出ない', () => {
    const step = { ...failedStep, line: 'HANAMII: 失敗しました' }
    const h = renderToStaticMarkup(React.createElement(ProjectDeleteResults, { run: { phase: 'stopped', steps: [step] } as any, showBlockNote: true }))
    expect(h).not.toContain('詳細: ')
  })
})

describe('trashFailureText: 自前の固定文でも原文を捨てない', () => {
  it('権限の失敗は固定文のまま、原文（EACCES）が詳細に残る', () => {
    const denied = Object.assign(new Error("EACCES: permission denied, rename '/x/app'"), { code: 'EACCES' })
    const { text, detail } = splitFailureDetail(trashFailureText(denied))
    expect(text).toBe('フォルダをゴミ箱へ移せません。Finder で権限を確かめてください。')
    expect(detail).toContain('EACCES')
  })
})

describe('KnowledgeCollectorTab: 複数の失敗を1つの知らせにまとめる', () => {
  it('各件の文を「 / 」でつなぎ、詳細は文の途中に挟まず最後の1行にまとめる', () => {
    const a = `「A」: ${failureText(offline())}`
    const b = `「B」: ${failureText(Object.assign(new Error('x'), { code: 'CERT_HAS_EXPIRED' }))}`
    const out = joinUploadErrors([a, b])
    const { text, detail } = splitFailureDetail(out)
    expect(text.startsWith('アップロードに失敗しました。「A」: ')).toBe(true)
    expect(text).toContain(' / 「B」: ')
    expect(text).not.toContain('詳細: ')
    expect(detail).toContain('ENOTFOUND')
    expect(detail).toContain('CERT_HAS_EXPIRED')
    // 詳細の行はちょうど1つ
    expect(count(out, '\n詳細: ')).toBe(1)
  })

  it('詳細の無い失敗（サーバの断りの文）だけなら、従来の形のまま', () => {
    expect(joinUploadErrors(['「A」: 容量オーバーです', '「B」: 重複しています'])).toBe('アップロードに失敗しました。「A」: 容量オーバーです / 「B」: 重複しています')
  })
})

describe('CompactNote: 括弧の中に詳細を入れない', () => {
  it('「残せませんでした（日本語の文）」のあと、最後の行に詳細が付く', () => {
    const out = savedFailureNote(offline())
    const { text, detail } = splitFailureDetail(out)
    expect(text).toBe(`残せませんでした（${SENTENCE}）`)
    expect(detail).toContain('ENOTFOUND')
  })
})

describe('描き口は FailureLines を通る（直す前の {msg} の形は残さない）', () => {
  const SITES: Array<[string, string[], string[]]> = [
    ['components/KnowledgeCollectorTab.tsx', ['<FailureLines text={searchError} />', '<FailureLines text={p.error} />', '<FailureLines text={uploadNotice} />'], ['>{searchError}<', '>{p.error}<', '>{uploadNotice}<']],
    ['components/KnowledgeModal.tsx', ['<FailureLines text={listError} />'], ['>{listError}<']],
    ['components/KnowledgePacksTab.tsx', ['<FailureLines text={r.error} />'], ['>{r.error}<']],
    ['components/CompactNote.tsx', ['⚠️ <FailureLines text={saveErr} />'], ['残せませんでした（{saveErr}）']],
    ['components/ProjectDeleteDialog.tsx', ['⚠️ <FailureLines text={crashed} />'], ['⚠️ {crashed}']],
    ['components/AppRunDedicatedPanel.tsx', ['<FailureLines text={lbRefreshError} />', '<FailureLines text={siteCheckError} />', '<FailureLines text={checkError} />'], ['>{lbRefreshError}<', '>{siteCheckError}<', '>{checkError}<']],
    ['components/teardown/ProjectDeleteResults.tsx', ['<FailureLines text={step.line} />', '<FailureLines text={msg} />', 'failureCopyNow(msg)'], ['>{msg}<', 'writeText(msg)']],
  ]
  for (const [file, must, mustNot] of SITES) {
    it(file, () => {
      const src = read(file)
      for (const m of must) expect(count(src, m), `${file}: ${m}`).toBe(1)
      for (const m of mustNot) expect(src, `${file}: ${m}`).not.toContain(m)
    })
  }
})
