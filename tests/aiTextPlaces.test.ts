import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import AiMessage, { AiText } from '../src/renderer/components/AiMessage'
import ThinkingBlock from '../src/renderer/components/ThinkingBlock'

// ── AI が書いた文は、どの場所でも同じ部品（AiText）で描く（2026-10-09 作者決定「そっちも直しましょう」）──────
// チャットの吹き出しでは、AI の返事の **太字**・箇条書き・見出し・`コード` を描けるようにした（aiMessageRender.test.ts）。
// ところが同じ AI の文を、ただの文字（<p whitespace-pre-wrap>・<pre>）で出している所が5か所残っていた。
//   1. 「資料に聞く」の回答（KnowledgeAnswer。KnowledgeModal から切り出した）
//   2. 公開前セキュリティチェックの結果・問題なしのとき畳んで出す側（SecurityCheckSection → SecurityReportBody）
//   3. 同じく要確認のときの側（SecurityCheckSection → SecurityReportBody）
//   4. 会話のまとめ（CompactNote）
//   5. 推論モデルの思考（ThinkingBlock）
// このテストは、
//   ・共通の部品の描画（記号が消える・タグは文字として出る・流し込み中でも落ちない）
//   ・5か所が実際にその部品を使っていること（コメントを除いた実物で、渡している値まで）
//   ・AI を呼ぶ入口が増えたら気づけること
// を固定する。5か所を実際に描いて確かめるものは tests/aiTextPlacesRender.test.ts
// （表示の条件を壊しても通る、という文字列照合だけの弱さを補う）。

const ROOT = path.resolve(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

// コメントの中に元の書き方を残しただけでは通らないよう、コメントを除いた実物を見る
// （aiMessageRender.test.ts と同じ決まり。文字列の中の /* は始まりにしない）
const BLOCK_COMMENT = /(?<![^\s({[,;])\/\*[\s\S]*?\*\//g
const code = (rel: string) => read(rel)
  .replace(BLOCK_COMMENT, m => m.replace(/[^\n]/g, ''))
  .replace(/(^|\s)\/\/[^\n]*/g, (_m, lead: string) => lead)

const text = (content: unknown, props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(AiText, { content, ...props } as any))

describe('共通の部品 AiText の描画', () => {
  it('★ 太字・箇条書き・見出し・インラインコードを描き、記号は消える', () => {
    const h = text('### 結果\n\n**重要**：確認\n\n- 一つ目\n- `npm test` を実行')
    expect(h).toContain('<strong class="font-bold">重要</strong>：確認')
    expect(h).toContain('<ul')
    expect((h.match(/<li/g) ?? []).length).toBe(2)
    expect(h).toMatch(/<code class="[^"]*font-mono[^"]*">npm test<\/code>/)
    expect(h).toMatch(/<p class="font-bold [^"]*">結果<\/p>/)
    for (const mark of ['**', '###', '`', '- 一つ目']) expect(h, mark).not.toContain(mark)
  })

  it('★ 外側の見た目は className で渡した値がそのまま付く（大きさ・色・select-text・高さは場所ごと）', () => {
    for (const cls of [
      'text-sm text-ink select-text',
      'text-xs text-ink-secondary select-text max-h-52 overflow-y-auto',
      'mt-2 text-[12px] text-ink select-text',
      'text-[11px] text-ink-secondary leading-relaxed select-text',
    ]) {
      expect(text('本文', { className: cls }), cls).toMatch(new RegExp(`^<div class="${cls.replace(/[[\]]/g, '\\$&')}">`))
    }
  })

  it('★ 空・文字でない値でも例外を投げない（空の枠だけ描く）', () => {
    expect(text('', { className: 'x' })).toBe('<div class="x"></div>')
    for (const v of [undefined, null, 42, {}, []]) {
      expect(() => text(v, { className: 'x' }), String(v)).not.toThrow()
      expect(text(v, { className: 'x' })).toBe('<div class="x"></div>')
    }
  })

  it('★ onApplyFile を渡さなければ、ファイル提案（file=）に「保存」は出ない。コピーは出る', () => {
    const src = '作りました\n\n```html file=src/index.html\n<h1>やあ</h1>\n```\n\n```js\nlet a = 1\n```'
    const h = text(src, { className: 'x' })
    expect(h).toContain('src/index.html')
    expect(h).toContain('let a = 1')
    expect(h).toContain('コピー')
    expect(h).not.toContain('💾')
    expect(h).not.toContain('プロジェクトに保存')
    // 渡せば出る（チャットの吹き出し用の口は残っている）
    expect(text(src, { onApplyFile: async () => {} })).toContain('💾 プロジェクトに保存')
  })

  it('★ コードブロックの中は、太字・箇条書きにせずそのまま（カードに入る）', () => {
    const h = text('説明\n\n```js\nconst a = "**x**"\n- b\n```\n\n終わり', { className: 'x' })
    expect(h).toContain('<pre')
    expect(h).toContain('const a = &quot;**x**&quot;')
    expect(h).not.toContain('<strong')
    expect(h).not.toContain('<ul')
  })

  it('★ HTML のタグはタグではなく文字として出る（文・太字・箇条書き・見出し・コードの中のすべて）', () => {
    const h = text([
      '<script>alert(1)</script> と **<img src=x onerror=alert(1)>**',
      '- <iframe src="//evil"></iframe>',
      '## <style>*{display:none}</style>',
      '`<b>x</b>`',
      '```html\n<script>y</script>\n```',
    ].join('\n\n'), { className: 'x' })
    for (const tag of ['<script', '<img', '<iframe', '<style', '<b>']) expect(h, tag).not.toContain(tag)
    expect(h).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(h).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(h).toContain('&lt;iframe src=&quot;//evil&quot;&gt;&lt;/iframe&gt;')
    expect(h).toContain('&lt;style&gt;*{display:none}&lt;/style&gt;')
    expect(h).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(h).toContain('&lt;script&gt;y&lt;/script&gt;')
  })

  it('★ 流し込み中（どの長さで切っても）例外を投げない。閉じていない ** ・` ・``` は記号のまま出る', () => {
    const src = '### 考え中\n\n**まず** `a` を見る\n\n- 次に **b\n- `c\n\n```js\nlet a = 2**3\n'
    for (let n = 0; n <= src.length; n++) {
      expect(() => text(src.slice(0, n), { className: 'x' }), `n=${n}`).not.toThrow()
    }
    const open = text('これは **まだ閉じていない', { className: 'x' })
    expect(open).not.toContain('<strong')
    expect(open).toContain('これは **まだ閉じていない')
    expect(text('これは **閉じた**', { className: 'x' })).toContain('<strong class="font-bold">閉じた</strong>')
  })

  it('色はテーマの色だけ（ライト・ダークの両方で読める）: 固定の色・style を持ち込まない', () => {
    const h = text('**太字** と `code` と\n- 項目\n### 見出し\n```js\nx\n```', { className: 'x' })
    expect(h).toContain('bg-overlay')
    expect(h).toContain('border-line')
    expect(h).toContain('text-ink')
    expect(h).not.toMatch(/style=/)
    expect(h).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(h).not.toMatch(/\btext-(white|black)\b|\bbg-(white|black)\b/)
  })

  it('★ チャットの吹き出し（AiMessage）は、AiText に吹き出しの文字の大きさを付けただけ（描き方は同じ）', () => {
    const src = '**太字**\n\n- 項目 `c`\n\n```js file=a.js\nlet a = 1\n```'
    const apply = async () => {}
    expect(renderToStaticMarkup(createElement(AiMessage, { content: src })))
      .toBe(text(src, { className: 'text-sm leading-relaxed' }))
    expect(renderToStaticMarkup(createElement(AiMessage, { content: src, onApplyFile: apply, applyHint: 'ここ' })))
      .toBe(text(src, { className: 'text-sm leading-relaxed', onApplyFile: apply, applyHint: 'ここ' }))
    expect(renderToStaticMarkup(createElement(AiMessage, { content: 'src/**/*.ts', plain: true })))
      .toBe(text('src/**/*.ts', { className: 'text-sm leading-relaxed', plain: true }))
  })
})

describe('思考（ThinkingBlock）を実際に描く', () => {
  // ThinkingBlock は描くときに localStorage（常に開く設定）を読む。node には無いので差し替える
  const render = (t: string, live = true) => {
    vi.stubGlobal('localStorage', { getItem: () => null })
    try { return renderToStaticMarkup(createElement(ThinkingBlock, { text: t, live })) }
    finally { vi.unstubAllGlobals() }
  }

  it('★ 流れている間は開いていて、太字・箇条書き・コードを描く（記号は消える）', () => {
    const h = render('まず **ファイルを読む**。\n\n- `index.html` を開く\n- 直す')
    expect(h).toContain('考えています…')
    expect(h).toContain('<strong class="font-bold">ファイルを読む</strong>')
    expect(h).toContain('<ul')
    expect(h).toMatch(/<code class="[^"]*">index\.html<\/code>/)
    expect(h).not.toContain('**')
  })

  it('★ 見た目（11px・ink-secondary・select-text・高さ上限）は今のまま', () => {
    const h = render('考え')
    expect(h).toContain('text-[11px] text-ink-secondary leading-relaxed select-text')
    expect(h).toContain('max-h-40 overflow-y-auto')
  })

  it('★ 思考にタグが入っても文字として出る', () => {
    const h = render('<script>alert(1)</script> **<b>x</b>**')
    expect(h).not.toContain('<script')
    expect(h).not.toContain('<b>')
    expect(h).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('★ 増えていく途中（どの長さで切っても・閉じていなくても）例外を投げない', () => {
    const src = '**まず** `a` を見る\n\n- 次に **b\n\n```js\nlet a = 2**3\n```\n\n最後に **c**'
    for (let n = 0; n <= src.length; n++) expect(() => render(src.slice(0, n)), `n=${n}`).not.toThrow()
    expect(render('')).toBe('')
    expect(render('   \n')).toBe('')
  })

  it('畳んでいる（流し込みが終わった）ときは中身を描かない', () => {
    const h = render('**中身**', false)
    expect(h).toContain('考えた内容')
    expect(h).not.toContain('<strong')
  })
})

describe('★ 5か所は、ただの文字ではなく共通の部品を使っている（コメントを除いた実物で見る）', () => {
  const COMP = 'src/renderer/components/'
  const countOf = (src: string, needle: string) => src.split(needle).length - 1

  it('1. 資料に聞く: KnowledgeModal は結果を KnowledgeAnswer に渡し、KnowledgeAnswer が answer.text を AiText に渡す', () => {
    const modal = code(COMP + 'KnowledgeModal.tsx')
    expect(modal).toContain("import KnowledgeAnswer, { type KnowledgeAnswerData } from './KnowledgeAnswer'")
    expect(modal).toContain('{answer && <KnowledgeAnswer answer={answer} />}')
    expect(modal).not.toContain('AiText')
    const src = code(COMP + 'KnowledgeAnswer.tsx')
    expect(src).toContain("import { AiText } from './AiMessage'")
    expect(src).toContain('<AiText content={answer.text} className="text-sm text-ink select-text" />')
    // 直す前の形に戻さない
    expect(src).not.toContain('<p className="text-sm text-ink whitespace-pre-wrap select-text">{answer.text}</p>')
    expect(src).not.toMatch(/\{answer\.text\}\s*<\/(?:p|pre|div|span)>/)
  })

  it('2・3. 公開前セキュリティチェック: SecurityCheckSection は問題なし側・要確認側の両方で SecurityReportBody に結果を渡す', () => {
    const src = code(COMP + 'SecurityCheckSection.tsx')
    expect(src).toContain("import SecurityReportBody from './SecurityReportBody'")
    expect(countOf(src, '<SecurityReportBody result={result} />')).toBe(2)
    expect(src).not.toContain('<pre')
    expect(src).not.toContain('AiText')
    expect(src).not.toMatch(/\{result\.report\}\s*<\/(?:p|pre|div|span)>/)
    // コピーされるのは元の文（AI が書いたまま）
    expect(countOf(src, '<CopyButton text={result.report} title="チェック結果をコピー" />')).toBe(2)
    // 「AIに修正させる」に渡すのも元の文
    expect(src).toContain('\\n\\n${result.report}')
  })

  it('2・3. SecurityReportBody: AI の行だけ AiText で解釈し、Koto の行は plain で文字のまま出す', () => {
    const src = code(COMP + 'SecurityReportBody.tsx')
    expect(src).toContain("import { AiText } from './AiMessage'")
    expect(src).toContain('reportParts(result).map((p, i) => <AiText key={i} content={p.text} plain={!p.ai} />)')
    expect(src).toContain('<div className="text-xs text-ink-secondary select-text max-h-52 overflow-y-auto space-y-2">')
    expect(src).not.toContain('<pre')
  })

  it('4. 会話のまとめ（CompactNote）: text を AiText に渡す。コピー・保存は元の文のまま', () => {
    const src = code(COMP + 'CompactNote.tsx')
    expect(src).toContain("import { AiText } from './AiMessage'")
    expect(src).toContain('<AiText content={text} className="mt-2 text-[12px] text-ink select-text" />')
    expect(src).not.toMatch(/\{text\}\s*<\/(?:p|pre|div|span)>/)
    expect(src).not.toContain('CHAT_TEXT_WRAP')
    expect(src).toContain('text={`${COMPACT_NOTE}\\n${text}`}')
    expect(src).toContain('summaryFileBody(text, now)')
  })

  it('5. 推論モデルの思考（ThinkingBlock）: text を AiText に渡す。自動で最新行へ動く枠（bodyRef）は外側に残す', () => {
    const src = code(COMP + 'ThinkingBlock.tsx')
    expect(src).toContain("import { AiText } from './AiMessage'")
    expect(src).toContain('<AiText content={text} className="text-[11px] text-ink-secondary leading-relaxed select-text" />')
    // 本文の要素は text ごとに覚え、外側の枠の中にそのまま置く
    expect(src).toContain('() => <AiText content={text} className="text-[11px] text-ink-secondary leading-relaxed select-text" />,\n    [text],')
    expect(src).toContain('<div ref={bodyRef} className="px-2 pb-2 max-h-40 overflow-y-auto">')
    // コメント（{/* … */}）を除くと空の {} が残るので、それは許す
    expect(src).toMatch(/<div ref=\{bodyRef\}[^>]*>\s*(?:\{\s*\}\s*)?\{body\}\s*<\/div>/)
    expect(src).not.toMatch(/\{text\}\s*<\/(?:p|pre|div|span)>/)
    expect(src).not.toContain('CHAT_TEXT_WRAP')
  })

  it('チャットの吹き出しも同じ部品（AiMessage は AiText を呼ぶだけ）', () => {
    const src = code(COMP + 'AiMessage.tsx')
    expect(src).toContain('<AiText content={content} className="text-sm leading-relaxed" onApplyFile={onApplyFile} applyHint={applyHint} plain={plain} />')
    expect(src).toContain("if (p.type === 'text') return <ChatText key={i} text={p.text} plain={plain} />")
  })

  it('解析は content・text が変わったときだけ（useMemo）。AiText と ChatText の両方', () => {
    const src = code(COMP + 'AiMessage.tsx')
    expect(src).toContain('const parts = useMemo(() => parseMessage(typeof content === \'string\' ? content : \'\'), [content])')
    expect(src).toContain('const blocks = useMemo(() => (plain ? [] : parseChatText(text)), [text, plain])')
    expect(src).not.toMatch(/const (?:parts|blocks) = parse(?:Message|ChatText)\(/)
  })

  it('描き方は1つ: chatMarkdown を取り込むのは AiMessage.tsx だけ（双子を作らない）', () => {
    const users = fs.readdirSync(path.join(ROOT, COMP)).filter(f => f.endsWith('.tsx'))
      .filter(f => /chatMarkdown/.test(code(COMP + f)))
    expect(users).toEqual(['AiMessage.tsx'])
  })

  it('HTML の文字列を差し込む書き方を持ち込まない（5か所と共通の部品）', () => {
    for (const f of ['AiMessage', 'KnowledgeModal', 'KnowledgeAnswer', 'SecurityCheckSection', 'SecurityReportBody', 'CompactNote', 'ThinkingBlock']) {
      expect(code(COMP + f + '.tsx'), f).not.toMatch(/dangerouslySetInnerHTML|innerHTML/)
    }
  })
})

describe('★ AI を呼ぶ画面側の入口が増えたら気づく', () => {
  // AI の文を画面に出す所は、AiText を通す。入口を足したら、出力をどこに出すかを確かめ、この一覧に足す。
  // チャットの本線（chatTurn.start）も入口。`electronAPI?.sakura?.chat` のような ?. や改行を挟んだ書き方も拾う
  const CALLER = /electronAPI\s*\??\.\s*(?:rag\s*\??\.\s*chat\b|sakura\s*\??\.\s*chat|claude\s*\??\.\s*chatStart|chatTurn\s*\??\.\s*start)/
  const walk = (dir: string): string[] => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(?:ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : [])

  it('★ 入口を見つける正規表現は、4つの入口を ?. や改行を挟んでも拾い、AI を呼ばない口は拾わない', () => {
    for (const hit of [
      'window.electronAPI.rag.chat(apiKey, a)',
      'window.electronAPI.sakura.chat(req)',
      'window.electronAPI.sakura.chatStream(req)',
      'window.electronAPI.claude.chatStart(a)',
      'window.electronAPI.chatTurn.start(p, h)',
      'window.electronAPI?.chatTurn?.start(p, h)',
      'window.electronAPI?.sakura?.chat(req)',
      'window.electronAPI\n  .chatTurn\n  .start(p, h)',
    ]) expect(hit, hit).toMatch(CALLER)
    for (const miss of [
      'window.electronAPI.rag.list(apiKey)',
      'window.electronAPI.rag.chunks(apiKey, id)',
      'window.electronAPI.sakura.models(apiKey)',
      'window.electronAPI.claude.models(k)',
      'window.electronAPI.chatTurn.abort(id)',
      'window.electronAPI.chat.load(dir)',
    ]) expect(miss, miss).not.toMatch(CALLER)
  })

  it('入口の一覧（出力の行き先つき）', () => {
    const found = walk('src/renderer').filter(f => CALLER.test(code(f))).sort()
    expect(found).toEqual([
      'src/renderer/components/ChatPanel.tsx', // あいさつ → 吹き出し（AiMessage）
      'src/renderer/components/KnowledgeModal.tsx', // 資料に聞く → AiText
      'src/renderer/hooks/useAiChat.ts', // チャット・まとめ・思考 → AiMessage・CompactNote・ThinkingBlock
      'src/renderer/securityCheck.ts', // 公開前セキュリティチェック → SecurityCheckSection の AiText
    ])
  })
})
