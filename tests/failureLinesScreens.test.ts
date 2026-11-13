import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ConnectionChecklist from '../src/renderer/components/ConnectionChecklist'
import { ErrorBlock } from '../src/renderer/components/DedicatedOpsParts'
import NotifyModal from '../src/renderer/components/NotifyModal'
import { cleanRemoteError } from '../src/renderer/remoteError'
import { splitFailureDetail } from '../src/shared/failureDetail'

// 置き換えた失敗の文の下に、原文を小さく出す「描き口」の固め（描いた HTML で見る）。
// 文と詳細の分け方・コピーの形は failureDetail.test.ts、ErrorBand は errorBand.test.ts が固める。

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf-8')
const SENTENCE = 'インターネットに接続できませんでした。接続を確かめてから、もう一度お試しください。'
const DETAIL = 'getaddrinfo ENOTFOUND api.ai.sakura.ad.jp'
const shown = `${SENTENCE}\n詳細: ${DETAIL}`
const DETAIL_SPAN = `>詳細: ${DETAIL}</span>`

describe('描き口が FailureLines を通る', () => {
  it('ConnectionChecklist: 失敗の項目の文の下に、小さな詳細の行が出る', () => {
    const h = renderToStaticMarkup(React.createElement(ConnectionChecklist, {
      items: [{ key: 'a', label: '課金', ok: false, message: shown }],
    }))
    expect(h).toContain(SENTENCE)
    expect(h).toContain(DETAIL_SPAN)
    expect(h).toContain('text-[10px]')
    // 文の側に「詳細: 」は混ざらない
    expect(h.replace(DETAIL_SPAN, '')).not.toContain('詳細: ')
  })

  it('ConnectionChecklist: 詳細が無い文・成功の項目には詳細の行が出ない', () => {
    const h = renderToStaticMarkup(React.createElement(ConnectionChecklist, {
      items: [{ key: 'a', label: '課金', ok: false, message: '権限がありません' }, { key: 'b', label: '登録', ok: true, message: shown }],
    }))
    expect(h).not.toContain('詳細: ')
  })

  it('ErrorBlock（専有型の結果欄）: 文の下に詳細の行が出る', () => {
    const h = renderToStaticMarkup(React.createElement(ErrorBlock, { msg: shown }))
    expect(h).toContain(SENTENCE)
    expect(h).toContain(DETAIL_SPAN)
    expect(h).toContain('whitespace-pre-wrap')
    expect(h).toContain('>コピー</button>')
  })

  it('NotifyModal: 本文の下に詳細の行が出る', () => {
    const h = renderToStaticMarkup(React.createElement(NotifyModal, { open: true, title: '移せませんでした', body: shown, onClose: () => {} }))
    expect(h).toContain(SENTENCE)
    expect(h).toContain(DETAIL_SPAN)
  })
})

describe('描き口の配線（ソースの形。当て先は一意）', () => {
  const once = (src: string, shape: string) => expect(src.split(shape).length - 1, shape).toBe(1)

  it('ErrorBlock 2つは、文を FailureLines で描き、コピーは failureCopyNow を通す', () => {
    for (const f of ['renderer/components/DedicatedOpsParts.tsx', 'renderer/components/teardown/TeardownResultView.tsx']) {
      const src = read(f)
      once(src, '<FailureLines text={msg} />')
      once(src, 'failureCopyNow(msg).then(t => navigator.clipboard.writeText(t))')
      expect(src, f).not.toContain('select-text">{msg}</p>')
      expect(src, f).not.toContain('navigator.clipboard.writeText(msg)')
    }
  })

  it('認証情報の接続テストの span（Claude・HANAMII・Vercel）は FailureLines で描く（CredentialsTestButtons.tsx）', () => {
    const src = read('renderer/components/CredentialsTestButtons.tsx')
    expect(src.split('❌ <FailureLines text={detail} />').length - 1).toBe(3)
    once(src, '⚠️ <FailureLines text={detail} />')
    expect(src).not.toContain('select-text">❌ {detail}</span>')
    expect(src).not.toContain('select-text">⚠️ {detail}</span>')
  })

  it('設定の「Koto の更新」と ServerFilesModal の知らせは FailureLines で描く', () => {
    once(read('renderer/components/SettingsModal.tsx'), '<FailureLines text={updateStatusText(update) ||')
    once(read('renderer/components/ServerFilesModal.tsx'), '<FailureLines text={notice} />')
    expect(read('renderer/components/ServerFilesModal.tsx')).not.toContain('break-all">{notice}</p>')
  })

  it('CopyButton は getText を押したときに呼び、無ければ text を写す', () => {
    const src = read('renderer/components/CopyButton.tsx')
    once(src, 'navigator.clipboard.writeText(getText ? await getText() : text)')
    once(src, 'getText?: () => string | Promise<string>')
  })
})

describe('IPC を越えた接続テストの失敗（sakura:models）でも詳細の行が残る', () => {
  it('cleanRemoteError は頭だけを落とし、末尾の「詳細: …」の行は残す', () => {
    const e = new Error(`Error invoking remote method 'sakura:models': Error: ${SENTENCE}\n詳細: ${DETAIL}`)
    const cleaned = cleanRemoteError(e)
    expect(splitFailureDetail(cleaned)).toEqual({ text: SENTENCE, detail: DETAIL })
  })
})
