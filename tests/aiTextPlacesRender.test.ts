import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// ── AI の文を出す5か所を、実際に描いて確かめる（2026-10-09 検分の指摘）──────────────────────────────
// tests/aiTextPlaces.test.ts の5か所の配線は、ソースに文字列があるかを見るだけだった。次の変異が全部素通りした:
//   (M5) KnowledgeModal の `{answer.text && (` を `{answer.text && false && (` にする → 回答が出なくなる
//   (CompactNote・SecurityCheckSection も同じ。実際に描くテストがあるのは ThinkingBlock だけだった)
// DOM 環境（jsdom 等）は入れていないので、react の useState／useMemo だけを**この試験用の小さな実装**に差し替えて
// 部品の関数をそのまま呼び、描いた結果は本物の react-dom/server で HTML にする（stageEstimateEffect.test.ts と同じ手）。
//   ・useState: 描くたびの「最初の1回」だけ、flag が立っていれば true を返す。
//     CompactNote は「まとめを見る」を押すまで本文を描かない（open の初期値 false が最初の useState）。押したあとの形を静的に描く
//   ・useMemo: 依存が同じなら前回の値を返す（React の決まりを写している）。同じ文を描き直したとき、解析をやり直さないことを数える

const rt = vi.hoisted(() => ({
  states: 0,
  forceFirstState: false,
  memos: [] as Array<{ deps: readonly unknown[]; value: unknown } | undefined>,
  m: 0,
  parseChatTextCalls: 0,
}))

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>()
  return {
    ...real,
    useState: (init: unknown) => {
      const first = rt.states++ === 0
      return first && rt.forceFirstState ? [true, () => {}] : real.useState(init as never)
    },
    useMemo: (factory: () => unknown, deps: readonly unknown[]) => {
      const idx = rt.m++
      const prev = rt.memos[idx]
      if (prev && prev.deps.length === deps.length && deps.every((d, k) => Object.is(d, prev.deps[k]))) return prev.value
      const value = factory()
      rt.memos[idx] = { deps, value }
      return value
    },
  }
})

vi.mock('../src/renderer/chatMarkdown', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/renderer/chatMarkdown')>()
  return {
    ...real,
    parseChatText: (t: string) => { rt.parseChatTextCalls++; return real.parseChatText(t) },
  }
})

import { AiText } from '../src/renderer/components/AiMessage'
import CompactNote from '../src/renderer/components/CompactNote'
import KnowledgeAnswer from '../src/renderer/components/KnowledgeAnswer'
import SecurityReportBody from '../src/renderer/components/SecurityReportBody'
import ThinkingBlock from '../src/renderer/components/ThinkingBlock'
import { mergeCheckResults, reportParts } from '../src/renderer/securityCheck'

/** 描くたびに、フックの数え方を最初に戻す（同じ木を描き直す = 同じ順で呼ばれる）。覚えた値は beforeEach まで残す。 */
function render(el: Parameters<typeof renderToStaticMarkup>[0]): string {
  rt.states = 0
  rt.m = 0
  return renderToStaticMarkup(el)
}

beforeEach(() => {
  rt.forceFirstState = false
  rt.memos = []
  rt.parseChatTextCalls = 0
  vi.stubGlobal('localStorage', { getItem: () => null })
})

const AI = '### 結果\n\n**重要**: 確認\n\n- 一つ目\n- `npm test` を実行'

describe('会話のまとめ（CompactNote）を開いたとき', () => {
  const note = (text: string, open: boolean) => {
    rt.forceFirstState = open
    return render(createElement(CompactNote, { text }))
  }

  it('★ AI の文を、太字・箇条書き・コードに描く。記号は消える', () => {
    const h = note(AI, true)
    expect(h).toContain('<strong class="font-bold">重要</strong>')
    expect(h).toContain('<ul')
    expect(h).toMatch(/<code class="[^"]*">npm test<\/code>/)
    for (const mark of ['**', '###', '`']) expect(h, mark).not.toContain(mark)
  })

  it('見た目（余白・12px・ink・select-text）は今のまま', () => {
    expect(note('本文', true)).toContain('<div class="mt-2 text-[12px] text-ink select-text">')
  })

  it('閉じているときは本文を描かない', () => {
    const h = note(AI, false)
    expect(h).toContain('まとめを見る')
    expect(h).not.toContain('<strong')
    expect(h).not.toContain('npm test')
  })

  it('タグは文字として出る', () => {
    const h = note('<script>alert(1)</script> **<b>x</b>**', true)
    expect(h).not.toContain('<script')
    expect(h).not.toContain('<b>')
    expect(h).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })
})

describe('「資料に聞く」の回答（KnowledgeAnswer）', () => {
  const hits = [{ name: '料金表.md', where: '2 番目の区切り', excerpt: '月額 **495円**' }]
  const answer = (text: string, h = hits) => render(createElement(KnowledgeAnswer, { answer: { text, hits: h } }))

  it('★ 回答の文を、太字・箇条書き・コードに描く。記号は消える', () => {
    const h = answer(AI)
    expect(h).toContain('<strong class="font-bold">重要</strong>')
    expect(h).toContain('<ul')
    expect(h).toMatch(/<code class="[^"]*">npm test<\/code>/)
    expect(h).not.toContain('###')
  })

  it('★ 回答の文があれば出る（表示の条件を壊すと落ちる）', () => {
    expect(answer('これが回答です')).toContain('これが回答です')
    expect(answer('これが回答です')).toContain('text-sm text-ink select-text')
  })

  it('回答の文が空なら、文の枠は出さない。当たった資料は出る', () => {
    const h = answer('')
    expect(h).not.toContain('text-sm text-ink select-text')
    expect(h).toContain('見つかったところ')
  })

  it('当たった資料の名前・場所・本文は、解釈せずそのまま見せる（本文の ** は太字にしない）', () => {
    const h = answer('回答')
    expect(h).toContain('📄 料金表.md')
    expect(h).toContain('2 番目の区切り')
    expect(h).toContain('月額 **495円**')
  })

  it('当たった資料が無いときは、見つからなかったと言う', () => {
    const h = answer('回答', [])
    expect(h).toContain('当てはまる資料は見つかりませんでした')
    expect(h).not.toContain('見つかったところ')
  })

  it('タグは文字として出る', () => {
    const h = answer('<img src=x onerror=alert(1)> **<script>x</script>**')
    expect(h).not.toContain('<img')
    expect(h).not.toContain('<script')
    expect(h).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })
})

describe('公開前セキュリティチェックの結果（SecurityReportBody）', () => {
  const ok = { verdict: 'ok' as const, report: '判定: 問題なし\n- **全ファイル**: 秘密情報はありません\n- `app.js` は安全です' }

  it('★ AI の行は、太字・箇条書き・コードに描く', () => {
    const merged = mergeCheckResults([ok], { files: 3, batches: 1, skipped: [] })
    const h = render(createElement(SecurityReportBody, { result: merged }))
    expect(h).toContain('<strong class="font-bold">全ファイル</strong>')
    expect(h).toContain('<ul')
    expect(h).toMatch(/<code class="[^"]*">app\.js<\/code>/)
    // 判定の行・件数の行（Koto が書く）は、そのまま出る
    expect(h).toContain('判定: 問題なし')
    expect(h).toContain('（3個のファイルを確認しました）')
  })

  it('★ Koto が組み立てた行（確認しなかったファイル名の一覧）は、名前の ** や ` を解釈しない', () => {
    const merged = mergeCheckResults([ok], {
      files: 3, batches: 1,
      skipped: ['pages/s**t.html'],
      dataLike: ['data/a**b.csv', 'data/c**d.csv'],
      others: ['`x`.txt', 'k**l.py'],
    })
    const h = render(createElement(SecurityReportBody, { result: merged }))
    // 名前はそのまま見える
    expect(h).toContain('pages/s**t.html')
    expect(h).toContain('data/a**b.csv、data/c**d.csv')
    expect(h).toContain('`x`.txt, k**l.py')
    // 名前の ** が太字になっていない・` がコードになっていない（太字になっているのは AI の行だけ）
    expect((h.match(/<strong/g) ?? []).length).toBe(1)
    expect(h).toContain('<strong class="font-bold">全ファイル</strong>')
    expect((h.match(/<code/g) ?? []).length).toBe(1)
    expect(h).not.toMatch(/<code[^>]*>x<\/code>/)
  })

  it('外側の見た目（大きさ・色・select-text・高さ）は今のまま', () => {
    const h = render(createElement(SecurityReportBody, { result: mergeCheckResults([ok], { files: 1, batches: 1, skipped: [] }) }))
    expect(h).toMatch(/^<div class="text-xs text-ink-secondary select-text max-h-52 overflow-y-auto space-y-2">/)
  })

  it('実施できなかった結果（Koto の一言だけ）は、文字のまま出す。AI の行は無い', () => {
    const skip = { verdict: 'skip' as const, report: 'チェックに失敗しました（HTTP **500** `x`）。' }
    const h = render(createElement(SecurityReportBody, { result: skip }))
    expect(h).toContain('チェックに失敗しました（HTTP **500** `x`）。')
    expect(h).not.toContain('<strong')
    expect(h).not.toContain('<code')
    // parts を持たない結果（早期の一言）も同じ
    expect(reportParts(skip)).toEqual([{ text: skip.report, ai: false }])
    const merged = mergeCheckResults([{ verdict: 'skip', report: 'チェックに失敗しました（**timeout**）。' }], { files: 1, batches: 1, skipped: [] })
    const h2 = render(createElement(SecurityReportBody, { result: merged }))
    expect(h2).toContain('チェックに失敗しました（**timeout**）。')
    expect(h2).not.toContain('<strong')
  })

  it('タグは文字として出る', () => {
    const merged = mergeCheckResults(
      [{ verdict: 'warn', report: '判定: 要確認\n- <script>alert(1)</script> **<b>x</b>**' }],
      { files: 1, batches: 1, skipped: [], dataLike: ['<img src=x>.csv'] },
    )
    const h = render(createElement(SecurityReportBody, { result: merged }))
    expect(h).not.toContain('<script')
    expect(h).not.toContain('<img')
    expect(h).not.toContain('<b>')
    expect(h).toContain('&lt;img src=x&gt;.csv')
  })
})

describe('★ 同じ文を描き直しても、全文を解析し直さない（流し込み中の重さ・2026-10-09 検分の指摘）', () => {
  const think = (text: string, live: boolean) => render(createElement(ThinkingBlock, { text, live }))

  it('AiText: 同じ文を描き直しても解析は1回。文が変われば解析し直す', () => {
    const el = (c: string) => createElement(AiText, { content: c, className: 'x' })
    render(el('**考え**\n\n- a'))
    expect(rt.parseChatTextCalls).toBe(1)
    render(el('**考え**\n\n- a'))
    render(el('**考え**\n\n- a'))
    expect(rt.parseChatTextCalls).toBe(1)
    render(el('**考え**\n\n- a\n- b'))
    expect(rt.parseChatTextCalls).toBe(2)
  })

  it('思考: 本文だけが流れて思考が同じ間（live や親の描き直し）は、思考の全文を解析し直さない', () => {
    const t = '**まず**ファイルを読む\n\n- `index.html` を開く\n- 直す'
    think(t, true)
    expect(rt.parseChatTextCalls).toBe(1)
    for (let i = 0; i < 5; i++) think(t, true)
    expect(rt.parseChatTextCalls).toBe(1)
    // 思考が増えたら、その分だけ解析し直す
    think(t + '\n- 確認', true)
    expect(rt.parseChatTextCalls).toBe(2)
  })

  it('plain のときは解析しない（Koto の一言）', () => {
    render(createElement(AiText, { content: 'src/**/*.ts', plain: true }))
    expect(rt.parseChatTextCalls).toBe(0)
  })
})
