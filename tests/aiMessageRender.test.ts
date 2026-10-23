import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import AiMessage, { parseMessage } from '../src/renderer/components/AiMessage'
import { CHAT_TEXT_WRAP } from '../src/renderer/textWrap'

// ── AI の吹き出しを実際に HTML へ描いて確かめる（2026-10-09 作者決定）────────────────────
// 純関数の分け方は chatMarkdown.test.ts。ここは「React の要素として描いた結果」を見る:
//   ・** が消えて <strong> になる / 箇条書きが <ul><li> になる / 見出し / インラインコード
//   ・AI の返事に <script> や <b> が入っても、タグではなく文字として出る（エスケープ）
//   ・コードブロック・ファイル提案（file=）は今までどおり

const ROOT = path.resolve(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

const html = (content: string, props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(AiMessage, { content, ...props } as any))

describe('実機の2例: ** が消えて <strong> になる', () => {
  it('★ 例1: 警告の1文まるごと', () => {
    const body = '⚠️ 警告：このサイトは意図的に極めて重い状態にしています。ブラウザが固まることがあるので、保存してから開いてください。'
    const h = html(`**${body}**`)
    expect(h).toContain(`<strong class="font-bold">${body}</strong>`)
    expect(h).not.toContain('**')
  })

  it('★ 例2: 「次にやること：」のあとの太字', () => {
    const body = '画面上部の【試す】ボタンで動作を確認してみてください。'
    const h = html(`次にやること：**${body}**`)
    expect(h).toContain(`次にやること：<strong class="font-bold">${body}</strong>`)
    expect(h).not.toContain('**')
  })

  it('対にならない **・2**3・空の **** は <strong> にしない（記号のまま）', () => {
    for (const src of ['**だけ', '2**3 を計算', '空の****です', '**a** と ** b']) {
      const h = html(src)
      if (src === '**a** と ** b') {
        expect(h).toContain('<strong class="font-bold">a</strong>')
        expect(h).toContain(' と ** b')
        continue
      }
      expect(h, src).not.toContain('<strong')
      expect(h, src).toContain(src)
    }
  })
})

describe('箇条書き・見出し・段落・インラインコード', () => {
  it('★ 「- 」「* 」「・」はどれも <ul><li> になり、行頭の記号は消える', () => {
    for (const src of ['- りんご\n- みかん\n- ぶどう', '* りんご\n* みかん\n* ぶどう', '・りんご\n・みかん\n・ぶどう']) {
      const h = html(src)
      expect(h, src).toContain('<ul')
      expect((h.match(/<li/g) ?? []).length, src).toBe(3)
      expect(h, src).toContain('>りんご</li>')
      expect(h, src).not.toMatch(/>[-*・]\s?りんご/)
    }
  })

  it('★ 項目の中の太字・コードも描く', () => {
    const h = html('- **重要**：確認\n- `npm test` を実行')
    expect(h).toContain('<li')
    expect(h).toContain('<strong class="font-bold">重要</strong>：確認')
    expect(h).toContain('<code')
    expect(h).toContain('>npm test</code> を実行')
  })

  it('★ 番号つきは今のまま文字で出す（<ul>・<ol> にしない・改行も保つ）', () => {
    const h = html('1. 開く\n2. 押す')
    expect(h).toContain('1. 開く\n2. 押す')
    expect(h).not.toContain('<ul')
    expect(h).not.toContain('<ol')
    expect(h).not.toContain('<li')
  })

  it('★ 見出し: # を外して太字の <p> にする', () => {
    const h = html('### 作りました\n\n本文')
    expect(h).not.toContain('###')
    expect(h).toMatch(/<p class="font-bold [^"]*">作りました<\/p>/)
    expect(h).not.toContain('<h')
  })

  it('★ インラインコード: 等幅・薄い背景で、中の ** はそのまま', () => {
    const h = html('`a ** b ** c` と `**x**`')
    expect(h).not.toContain('<strong')
    expect(h).toMatch(/<code class="[^"]*font-mono[^"]*">a \*\* b \*\* c<\/code>/)
    expect(h).toMatch(/<code class="[^"]*font-mono[^"]*">\*\*x\*\*<\/code>/)
  })

  it('色はテーマの色だけ（ライト・ダークの両方で読める）: 固定の色・style を使わない', () => {
    const h = html('**太字** と `code` と\n- 項目\n### 見出し')
    expect(h).toContain('bg-overlay')
    expect(h).toContain('border-line')
    expect(h).toContain('text-ink')
    expect(h).not.toMatch(/style=/)
    expect(h).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(h).not.toMatch(/\btext-(white|black)\b|\bbg-(white|black)\b/)
  })

  it('★ 空行で段落が分かれ、段落の中の改行は保つ', () => {
    const two = html('一つ目\n\n二つ目')
    expect((two.match(/<p /g) ?? []).length).toBe(2)
    expect(two).toContain('>一つ目</p>')
    expect(two).toContain('>二つ目</p>')
    const one = html('一行目\n二行目')
    expect((one.match(/<p /g) ?? []).length).toBe(1)
    expect(one).toContain('>一行目\n二行目</p>')
  })

  it('折り返し（CHAT_TEXT_WRAP）は段落・項目・見出しのすべてに付く', () => {
    const h = html('段落\n\n- 項目\n\n## 見出し')
    expect((h.match(new RegExp(CHAT_TEXT_WRAP.replace(/[[\]\\]/g, '\\$&'), 'g')) ?? []).length).toBe(3)
  })
})

describe('★ AI の返事のタグは、タグではなく文字として出る（エスケープ）', () => {
  it('<script>alert(1)</script> と <b> を含む返事', () => {
    const h = html('<script>alert(1)</script> と <b>太字</b> と **本物の太字**')
    expect(h).not.toContain('<script')
    expect(h).not.toMatch(/<b>/)
    expect(h).not.toContain('</b>')
    expect(h).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(h).toContain('&lt;b&gt;太字&lt;/b&gt;')
    expect(h).toContain('<strong class="font-bold">本物の太字</strong>')
  })

  it('太字・コード・箇条書き・見出しの中でも文字として出る', () => {
    const h = html([
      '**<img src=x onerror=alert(1)>**',
      '`<script>x</script>`',
      '- <iframe src="//evil"></iframe>',
      '## <style>*{display:none}</style>',
    ].join('\n\n'))
    for (const tag of ['<img', '<script', '<iframe', '<style']) expect(h, tag).not.toContain(tag)
    expect(h).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(h).toContain('&lt;script&gt;x&lt;/script&gt;')
    expect(h).toContain('&lt;iframe src=&quot;//evil&quot;&gt;&lt;/iframe&gt;')
    expect(h).toContain('&lt;style&gt;*{display:none}&lt;/style&gt;')
  })

  it('HTML の文字列を差し込む書き方を、描画側のソースに持ち込まない', () => {
    for (const rel of ['src/renderer/components/AiMessage.tsx', 'src/renderer/chatMarkdown.ts']) {
      expect(read(rel), rel).not.toMatch(/dangerouslySetInnerHTML|innerHTML/)
    }
  })
})

describe('コードブロックとファイル提案（file=）は今までどおり', () => {
  it('コードブロックは <pre><code> のカード（中の ** も ` もそのまま・太字にしない）', () => {
    const h = html('説明です\n\n```js\nconst a = "**x**"\n```\n\n終わり')
    expect(h).toContain('<pre')
    expect(h).toContain('const a = &quot;**x**&quot;')
    expect(h).toContain('コピー')
    expect(h).not.toContain('<strong')
    expect(h).toContain('>説明です</p>')
    expect(h).toContain('>終わり</p>')
  })

  it('ファイル提案（file=）はカードで、onApplyFile があれば保存ボタンが出る', () => {
    const src = '作りました\n\n```html file=src/index.html\n<h1>やあ</h1>\n```'
    const withApply = html(src, { onApplyFile: async () => {}, applyHint: '保存先の案内' })
    expect(withApply).toContain('📄')
    expect(withApply).toContain('src/index.html')
    expect(withApply).toContain('💾 プロジェクトに保存')
    expect(withApply).toContain('保存先の案内')
    const without = html(src)
    expect(without).toContain('src/index.html')
    expect(without).not.toContain('💾 プロジェクトに保存')
  })

  it('parseMessage: 説明文・コード・ファイル提案への分解は変わらない', () => {
    const parts = parseMessage('前置き\n```js\nlet a = 1\n```\n中\n```ts file=./src/a.ts\nexport {}\n```\n後ろ')
    expect(parts).toEqual([
      { type: 'text', text: '前置き' },
      { type: 'code', lang: 'js', code: 'let a = 1' },
      { type: 'text', text: '中' },
      { type: 'file', path: 'src/a.ts', lang: 'ts', code: 'export {}' },
      { type: 'text', text: '後ろ' },
    ])
    expect(parseMessage('```\nx\n```')).toEqual([{ type: 'code', lang: '', code: 'x' }])
    expect(parseMessage('')).toEqual([])
  })

  it('説明文の部分にだけ新しい描き方を当てる（コードブロックを通さない）', () => {
    const src = read('src/renderer/components/AiMessage.tsx')
    expect(src).toContain("if (p.type === 'text') return <ChatText key={i} text={p.text} plain={plain} />")
    expect(src).not.toContain('<p key={i} className={CHAT_TEXT_WRAP}>{p.text}</p>')
    expect(src).toContain('<ChatText key={i} text={p.text} plain={plain} />')
  })
})

describe('流し込み中・長い返事', () => {
  it('★ 閉じていない ** や ` は文字のまま出る。閉じたら太字になる', () => {
    const open = html('次にやること：**画面上部の')
    expect(open).not.toContain('<strong')
    expect(open).toContain('次にやること：**画面上部の')
    const closed = html('次にやること：**画面上部の**')
    expect(closed).toContain('<strong class="font-bold">画面上部の</strong>')
    expect(html('`abc')).not.toContain('<code')
  })

  it('★ 閉じていない ``` の途中（流し込み中・⏹ で止めたとき）は、コードの中の # ・字下げ・** を消さずそのまま出す', () => {
    const code = '# 設定を読む\nimport os\n    - not a list\nprint(2**3, x**2)'
    const src = `説明です\n\n\`\`\`python\n${code}\n`
    const open = html(src)
    expect(open).toContain('>説明です</p>')
    expect(open).toContain(`\`\`\`python\n${code}`)
    for (const bad of ['<strong', '<ul', '<li', 'class="font-bold']) expect(open, bad).not.toContain(bad)
    expect(open).not.toContain('<pre') // 閉じるまでコードのカードにはしない
    // 閉じたらカードになり、中身は変わらない
    const closed = html(src + '```\n')
    expect(closed).toContain('<pre')
    expect(closed).toContain('print(2**3, x**2)')
    expect(closed).not.toContain('<strong')
  })

  it('★ どの長さで切っても、開いたままの ``` の中身は一字も変わらず出る（記号が消えない）', () => {
    const head = '説明です\n\n'
    const body = '```python\n# 設定を読む\nimport os\n    - not a list\nprint(2**3, x**2)\n'
    const src = head + body + '```\n終わり'
    for (let n = head.length + 3; n <= head.length + body.length; n++) {
      const h = html(src.slice(0, n))
      const shown = src.slice(head.length, n).trimEnd()
      expect(h, `n=${n}`).toContain(shown)
      for (const bad of ['<strong', '<ul', '<li', 'class="font-bold', '<pre']) expect(h, `n=${n} ${bad}`).not.toContain(bad)
    }
  })

  it('どの長さで切っても、描いて例外を投げない', () => {
    const src = '### 見出し\n\n**⚠️ 警告：重い。**\n\n- `a` を作った\n- **b**\n\n```js file=a.js\nlet a = 1\n```\n\n1. 開く\n**閉じていない'
    for (let n = 0; n <= src.length; n++) {
      expect(() => html(src.slice(0, n)), `n=${n}`).not.toThrow()
    }
  })

  it('長い返事でも重くならない', () => {
    const big = ('**太字** と `コード` と - 記号\n- 項目 **x**\n\n').repeat(2000)
    const t = Date.now()
    const h = html(big)
    expect(Date.now() - t).toBeLessThan(3000)
    expect((h.match(/<li/g) ?? []).length).toBe(2000)
  })
})

describe('plain（Koto 自身の一言: toolNote）は記号を解釈しない', () => {
  it('★ glob・コマンドの ** ・` は、太字・コードにせず、そのまま出す', () => {
    for (const src of ['src/**/components/**/*.tsx', 'echo "今日は `date`" && ls **/dist/**', '- 一覧\n# 見出し']) {
      const h = html(src, { plain: true })
      expect(h, src).not.toMatch(/<(strong|code|ul|li)\b/)
      expect(h, src).not.toContain('class="font-bold')
      expect(h, src).toContain(src.replace(/&/g, '&amp;').replace(/"/g, '&quot;'))
    }
  })

  it('plain でないときは同じ文を解釈する（plain が効いている証拠）', () => {
    const h = html('src/**/components/**/*.tsx')
    expect(h).toContain('<strong')
  })

  it('plain でもコードブロックはカードのまま（今までどおり）', () => {
    const h = html('説明\n\n```js\nlet a = 1\n```', { plain: true })
    expect(h).toContain('<pre')
    expect(h).toContain('let a = 1')
  })
})

describe('AiMessage を使う場所は、IDE のチャットとチャットモードの両方（どちらにも効く）', () => {
  // コメントの中に元の書き方を残しただけでは通らないよう、コメントを除いた実物を見る
  // （wordingGlossary.test.ts の stripComments と同じ決まり。文字列の中の /* は始まりにしない）
  const BLOCK_COMMENT = /(?<![^\s({[,;])\/\*[\s\S]*?\*\//g
  const code = (rel: string) => read(rel)
    .replace(BLOCK_COMMENT, m => m.replace(/[^\n]/g, ''))
    .replace(/(^|\s)\/\/[^\n]*/g, (_m, lead: string) => lead)
  const FILES = ['src/renderer/components/ChatPanel.tsx', 'src/renderer/components/ChatApp.tsx']

  it('両方とも AiMessage を取り込んでいる', () => {
    for (const rel of FILES) expect(code(rel), rel).toContain("import AiMessage from './AiMessage'")
  })

  it('★ role が assistant の枝で AiMessage を使う（user の枝ではない）', () => {
    for (const rel of FILES) {
      expect(code(rel), rel).toMatch(/msg\.role === 'assistant' \? \(?\s*<AiMessage content=\{msg\.content\}/)
    }
  })

  it('★ toolNote の吹き出しには plain を渡す（作業中の一言は ** ・` を解釈しない）', () => {
    for (const rel of FILES) {
      expect(code(rel), rel).toMatch(/<AiMessage content=\{msg\.content\}[^\n]*plain=\{msg\.toolNote\} \/>/)
    }
  })
})
