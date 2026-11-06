import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// 失敗の文の最後の行「詳細: 原文」を、公開先・インポート・GitHub・サーバの画面が分けて描くこと（描いた HTML で確かめる）。
// 分けて描けないと、詳細が文の途中に流れ込むか、改行のない1行に潰れる。

vi.mock('../src/renderer/components/StorageNotice', () => ({ default: () => null }))
vi.mock('../src/renderer/components/SecurityCheckSection', () => ({ default: () => null }))
vi.mock('../src/renderer/components/UnusedFilesSection', () => ({ default: () => null }))
vi.mock('../src/renderer/components/AppRunPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/components/HanamiiPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/components/VercelPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/components/VpsPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/components/AppRunDedicatedPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/publishRootRenderer', () => ({ resolvePublishRoot: async () => '' }))

import { Note } from '../src/renderer/components/ImportFromPublishedPanel'
import { SaveResultLine } from '../src/renderer/components/GithubSaveModal'
import { OpFinishedCard } from '../src/renderer/components/PublishModal'
import * as ops from '../src/main/projectOps'
import { joinFailureDetail } from '../src/shared/failureDetail'

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el)
const SHOWN = joinFailureDetail('インターネットに接続できませんでした。接続を確かめてから、もう一度お試しください。', 'getaddrinfo ENOTFOUND api.github.com')

describe('詳細の行を分けて描く', () => {
  it('★ インポートの注記（Note）: 文と詳細が別の要素になり、太字の記法は文だけに効く', () => {
    const out = html(createElement(Note, { children: joinFailureDetail('🕘 履歴の起点は作れませんでした（**ディスクの空き**が足りません）。', 'ENOSPC: no space left on device') }))
    expect(out).toContain('<b')
    expect(out).toMatch(/<span class="[^"]*select-text[^"]*">詳細: ENOSPC: no space left on device<\/span>/)
    expect(out).not.toContain('\n詳細')
    // 詳細の無い注記は今までどおり
    expect(html(createElement(Note, { children: '3 個のファイルをインポートしました。' }))).not.toContain('詳細:')
  })

  it('★ GitHub 保存の結果（SaveResultLine）: ❌ の文の下に詳細が別の行で出る。成功の行には出ない', () => {
    const out = html(createElement(SaveResultLine, { ok: false, text: SHOWN }))
    expect(out).toContain('❌ インターネットに接続できませんでした')
    expect(out).toMatch(/<span class="[^"]*">詳細: getaddrinfo ENOTFOUND api\.github\.com<\/span>/)
    expect(html(createElement(SaveResultLine, { ok: true, text: '保存しました（3件のファイル）' }))).not.toContain('詳細:')
  })

  it('★ 【公開】の「終わった操作」カード: 記録の message の詳細を分けて描く', () => {
    ops.resetProjectOpsForTests()
    ops.beginOp('/tmp/koto-l4-card', '公開', { target: 'vercel', handler: 'vercel:publish' })
    ops.finishOp('/tmp/koto-l4-card', { value: { ok: false, message: SHOWN } })
    const rec = ops.getOps('/tmp/koto-l4-card').last!
    const out = html(createElement(OpFinishedCard, { rec: rec as any }))
    expect(out).toMatch(/<span class="[^"]*">詳細: getaddrinfo ENOTFOUND api\.github\.com<\/span>/)
  })
})
