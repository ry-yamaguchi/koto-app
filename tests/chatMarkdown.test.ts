import { describe, it, expect } from 'vitest'
import { parseChatText, parseChatInline, type ChatBlock, type ChatInline } from '../src/renderer/chatMarkdown'

// ── AI の返事の太字・箇条書き・見出し・インラインコード（2026-10-09 作者決定）──────────
// 純関数 parseChatText の振る舞いを固定する。描画（React の要素・エスケープ）は aiMessageRender.test.ts。

const T = (s: string): ChatInline => ({ t: 'text', s })
const B = (s: string): ChatInline => ({ t: 'bold', s })
const C = (s: string): ChatInline => ({ t: 'code', s })
const para = (...lines: ChatInline[][]): ChatBlock => ({ kind: 'para', lines })
const list = (...items: ChatInline[][]): ChatBlock => ({ kind: 'list', items })
const heading = (...inlines: ChatInline[]): ChatBlock => ({ kind: 'heading', inlines })
const raw = (text: string): ChatBlock => ({ kind: 'raw', text })

describe('太字 **…**: 実機で見えた記号が消える', () => {
  it('★ 実機の例1: 警告の1文まるごとの太字（絵文字・全角の「：」「。」に隣り合っていても太字）', () => {
    const body = '⚠️ 警告：このサイトは意図的に極めて重い状態にしています。ブラウザが固まることがあるので、保存してから開いてください。'
    expect(parseChatText(`**${body}**`)).toEqual([para([B(body)])])
  })

  it('★ 実機の例2: 「次にやること：」のあとの太字（【】も中身）', () => {
    const body = '画面上部の【試す】ボタンで動作を確認してみてください。'
    expect(parseChatText(`次にやること：**${body}**`)).toEqual([para([T('次にやること：'), B(body)])])
  })

  it('日本語の句読点・かぎ括弧・絵文字に隣り合っていても太字にする（CommonMark の左右の決まりは使わない）', () => {
    expect(parseChatInline('これは**重要**です。')).toEqual([T('これは'), B('重要'), T('です。')])
    expect(parseChatInline('「**確認**」と、**注意**。')).toEqual([T('「'), B('確認'), T('」と、'), B('注意'), T('。')])
    expect(parseChatInline('完了🎉**成功**✅')).toEqual([T('完了🎉'), B('成功'), T('✅')])
    expect(parseChatInline('A**B**C')).toEqual([T('A'), B('B'), T('C')])
  })

  it('最短一致: 1行に太字が2つあれば、間を太字にしない', () => {
    expect(parseChatInline('**a** と **b**')).toEqual([B('a'), T(' と '), B('b')])
  })

  it('太字は改行をまたがない（行ごとに見る）', () => {
    expect(parseChatText('**a\nb**')).toEqual([para([T('**a')], [T('b**')])])
  })
})

describe('太字にしないもの: 対にならない **・空の ****・数式', () => {
  it('★ 対にならない ** はそのまま文字で残す', () => {
    expect(parseChatInline('**だけ')).toEqual([T('**だけ')])
    expect(parseChatInline('だけ**')).toEqual([T('だけ**')])
    expect(parseChatInline('a ** b')).toEqual([T('a ** b')])
    expect(parseChatInline('**a** と ** b')).toEqual([B('a'), T(' と ** b')])
  })

  it('★ 数式のような 2**3 は太字にしない（対にならない）', () => {
    expect(parseChatInline('2**3')).toEqual([T('2**3')])
    expect(parseChatInline('2**3 を計算')).toEqual([T('2**3 を計算')])
  })

  it('★ 空の **** は太字にしない（記号のまま）', () => {
    expect(parseChatInline('****')).toEqual([T('****')])
    expect(parseChatInline('a****b')).toEqual([T('a****b')])
    expect(parseChatInline('** **')).toEqual([T('** **')])
    expect(parseChatInline('***')).toEqual([T('***')])
  })

  it('★ 数式・glob の ** が先にあっても、あとの本物の太字だけが太字になる（間を太字にしない）', () => {
    expect(parseChatInline('2**3 と **太字**')).toEqual([T('2**3 と '), B('太字')])
    expect(parseChatInline('src/**/*.js と **重要**')).toEqual([T('src/**/*.js と '), B('重要')])
    expect(parseChatInline('x ** 2 と **太字**')).toEqual([T('x ** 2 と '), B('太字')])
    expect(parseChatInline('**太字** と 2**3')).toEqual([B('太字'), T(' と 2**3')])
    expect(parseChatInline('2**3 と **太字** と x**2')).toEqual([T('2**3 と '), B('太字'), T(' と x**2')])
  })

  it('★ 3 個以上続く * は区切りにしない（***強調*** は片方だけ太字にならず、文字のまま）', () => {
    expect(parseChatInline('***強調***')).toEqual([T('***強調***')])
    expect(parseChatInline('***強調*** と **太字**')).toEqual([T('***強調*** と '), B('太字')])
    expect(parseChatInline('a*****b')).toEqual([T('a*****b')])
  })

  it('両側が空白の ** どうしは対にしない（x ** 2 と y ** 3）', () => {
    expect(parseChatInline('x ** 2 と y ** 3')).toEqual([T('x ** 2 と y ** 3')])
  })

  it('太字を入れ子にしない（対にしたら、それより前の開きは捨てる）', () => {
    const inlines = parseChatInline('**a **b** c**')
    expect(inlines.filter(n => n.t === 'bold')).toEqual([B('b')])
    expect(inlines.map(n => n.s).join('')).toBe('**a ' + 'b' + ' c**')
  })

  it('流し込み中（閉じていない **）は文字のまま。閉じたら太字になる', () => {
    expect(parseChatInline('次にやること：**画面上部の')).toEqual([T('次にやること：**画面上部の')])
    expect(parseChatInline('次にやること：**画面上部の【試す】**')).toEqual([T('次にやること：'), B('画面上部の【試す】')])
  })
})

describe('インラインコード `…`', () => {
  it('`…` はコードにする（前後の文字はそのまま）', () => {
    expect(parseChatInline('`npm test` を実行')).toEqual([C('npm test'), T(' を実行')])
    expect(parseChatInline('a `x` b `y` c')).toEqual([T('a '), C('x'), T(' b '), C('y'), T(' c')])
  })

  it('★ コードの中の ** は太字にしない（記号のまま中身に残る）', () => {
    expect(parseChatInline('`a ** b ** c`')).toEqual([C('a ** b ** c')])
    expect(parseChatInline('`**x**`')).toEqual([C('**x**')])
    expect(parseChatInline('**太字** と `**そのまま**`')).toEqual([B('太字'), T(' と '), C('**そのまま**')])
  })

  it('★ コードの中の ** は太字の対にも数えない（外の ** と組んで太字を作らない）', () => {
    expect(parseChatInline('2**3 を `x**2` で')).toEqual([T('2**3 を '), C('x**2'), T(' で')])
  })

  it('太字の中にコードがあれば「太字・コード・太字」に割る', () => {
    expect(parseChatInline('**`foo.ts` を変更**')).toEqual([C('foo.ts'), B(' を変更')])
    expect(parseChatInline('**a `b**c` d**')).toEqual([B('a '), C('b**c'), B(' d')])
  })

  it('空の `` ・閉じていない ` は文字のまま（流し込み中）', () => {
    expect(parseChatInline('``')).toEqual([T('``')])
    expect(parseChatInline('`abc')).toEqual([T('`abc')])
    expect(parseChatInline('x ` y')).toEqual([T('x ` y')])
  })

  it('コードはその行の中だけ（改行をまたがない）', () => {
    expect(parseChatText('`a\nb`')).toEqual([para([T('`a')], [T('b`')])])
  })
})

describe('箇条書き: 「- 」「* 」「・」', () => {
  it('★ 「- 」の行が続く所を list にする', () => {
    expect(parseChatText('- りんご\n- みかん')).toEqual([list([T('りんご')], [T('みかん')])])
  })

  it('★ 「* 」の行も list', () => {
    expect(parseChatText('* りんご\n* みかん')).toEqual([list([T('りんご')], [T('みかん')])])
  })

  it('★ 「・」の行も list（空白なしでも）', () => {
    expect(parseChatText('・りんご\n・みかん')).toEqual([list([T('りんご')], [T('みかん')])])
    expect(parseChatText('・ りんご')).toEqual([list([T('りんご')])])
  })

  it('行頭の前の空白は許す（入れ子は平らな1つの list にする）', () => {
    expect(parseChatText('  - a\n    - b')).toEqual([list([T('a')], [T('b')])])
  })

  it('★ 項目の中の太字・コードも描く', () => {
    expect(parseChatText('- **重要**：確認\n- `npm test` を実行')).toEqual([
      list([B('重要'), T('：確認')], [C('npm test'), T(' を実行')]),
    ])
  })

  it('前の行（段落）・後ろの行（段落）とは別のブロックになる（空行がなくても）', () => {
    expect(parseChatText('次のとおりです：\n- a\n- b\n以上です')).toEqual([
      para([T('次のとおりです：')]),
      list([T('a')], [T('b')]),
      para([T('以上です')]),
    ])
  })

  it('空行で区切られた list は別々の list', () => {
    expect(parseChatText('- a\n\n- b')).toEqual([list([T('a')]), list([T('b')])])
  })

  it('★ 番号つき（1. ）は変えない: 段落のまま、改行も保つ', () => {
    expect(parseChatText('1. はい\n2. いいえ')).toEqual([para([T('1. はい')], [T('2. いいえ')])])
    expect(parseChatText('手順：\n1. 開く\n   - 補足')).toEqual([
      para([T('手順：')], [T('1. 開く')]),
      list([T('補足')]),
    ])
  })

  it('箇条書きにしないもの（行頭の **太字**・---・-5・中身の無い「- 」）', () => {
    expect(parseChatText('**太字**から始まる')).toEqual([para([B('太字'), T('から始まる')])])
    expect(parseChatText('---')).toEqual([para([T('---')])])
    expect(parseChatText('-5 度')).toEqual([para([T('-5 度')])])
    expect(parseChatText('- ')).toEqual([para([T('- ')])])
    expect(parseChatText('・')).toEqual([para([T('・')])])
    expect(parseChatText('これは - 途中のハイフン')).toEqual([para([T('これは - 途中のハイフン')])])
  })
})

describe('見出し: 行頭の # 〜 ######', () => {
  it('★ 「### 見出し」は記号を外して heading にする', () => {
    expect(parseChatText('### 見出し')).toEqual([heading(T('見出し'))])
  })

  it('# から ###### まで heading。7個・空白なし・中身なしは見出しにしない', () => {
    for (const mark of ['#', '##', '###', '####', '#####', '######']) {
      expect(parseChatText(`${mark} あ`), mark).toEqual([heading(T('あ'))])
    }
    expect(parseChatText('####### あ')).toEqual([para([T('####### あ')])])
    expect(parseChatText('#タグ')).toEqual([para([T('#タグ')])])
    expect(parseChatText('### ')).toEqual([para([T('### ')])])
  })

  it('見出しの中の太字・コードも描く', () => {
    expect(parseChatText('## **手順** と `a`')).toEqual([heading(B('手順'), T(' と '), C('a'))])
  })

  it('空行がなくても、前後の行とは別のブロック', () => {
    expect(parseChatText('前置き\n## 見出し\n本文\n- a')).toEqual([
      para([T('前置き')]),
      heading(T('見出し')),
      para([T('本文')]),
      list([T('a')]),
    ])
  })
})

describe('閉じていない ```（流し込み中・⏹ で止めたとき）: コードの途中は何も解釈しない', () => {
  it('★ ``` の行から終わりまでを raw にする。# ・字下げ・** ・` が消えない（前の説明文は今までどおり描く）', () => {
    const code = '```python\n# 設定を読む\nimport os\n    - not a list\nprint(2**3, x**2)'
    expect(parseChatText('説明です\n\n' + code)).toEqual([para([T('説明です')]), raw(code)])
  })

  it('``` だけの行・言語つき・前の空白つきも同じ', () => {
    expect(parseChatText('```')).toEqual([raw('```')])
    expect(parseChatText('```js')).toEqual([raw('```js')])
    expect(parseChatText('  ```js\n**x**')).toEqual([raw('  ```js\n**x**')])
  })

  it('コードの中の空行は残し、終わりの空白だけ落とす。CRLF は LF にそろえる', () => {
    expect(parseChatText('```\na\n\n\nb\n\n')).toEqual([raw('```\na\n\n\nb')])
    expect(parseChatText('```\r\n# a\r\n')).toEqual([raw('```\n# a')])
  })

  it('前の箇条書き・見出しは閉じてから raw になる。raw のあとに別のブロックは出ない', () => {
    expect(parseChatText('- a\n```js\n- b\n### c')).toEqual([list([T('a')]), raw('```js\n- b\n### c')])
    expect(parseChatText('## 見出し\n```\n**x**')).toEqual([heading(T('見出し')), raw('```\n**x**')])
  })

  it('行の途中の ``` は fence ではない（文の中で触れただけなら、あとの行も今までどおり描く）', () => {
    expect(parseChatText('コードは ``` で囲みます\n**太字**')).toEqual([para([T('コードは ``` で囲みます')], [B('太字')])])
  })
})

describe('段落: 空行で分ける・段落の中の改行は保つ', () => {
  it('★ 空行で段落を分ける', () => {
    expect(parseChatText('a\n\nb')).toEqual([para([T('a')]), para([T('b')])])
    expect(parseChatText('a\n\n\n\nb')).toEqual([para([T('a')]), para([T('b')])])
    expect(parseChatText('a\n  \nb')).toEqual([para([T('a')]), para([T('b')])])
  })

  it('★ 段落の中の改行は保つ（行ごとに分けて持つ）', () => {
    expect(parseChatText('a\nb\nc')).toEqual([para([T('a')], [T('b')], [T('c')])])
  })

  it('行頭の空白は消さない（whitespace-pre-wrap と同じ見え方）', () => {
    expect(parseChatText('a\n   b')).toEqual([para([T('a')], [T('   b')])])
  })

  it('CRLF も改行として扱う', () => {
    expect(parseChatText('a\r\n\r\nb\r\n- c')).toEqual([para([T('a')]), para([T('b')]), list([T('c')])])
  })

  it('空・空白だけ・文字でない値は []（例外を投げない）', () => {
    expect(parseChatText('')).toEqual([])
    expect(parseChatText('  \n \n')).toEqual([])
    expect(parseChatText(undefined as unknown as string)).toEqual([])
    expect(parseChatText(null as unknown as string)).toEqual([])
    expect(parseChatInline('')).toEqual([])
  })

  it('HTML のタグは解釈しない（そのまま文字。描くときに React が文字として出す）', () => {
    expect(parseChatText('<script>alert(1)</script> と <b>太字</b>')).toEqual([
      para([T('<script>alert(1)</script> と <b>太字</b>')]),
    ])
    expect(parseChatInline('**<b>x</b>**')).toEqual([B('<b>x</b>')])
  })
})

describe('実機の長い返事（全部入り）', () => {
  const doc = [
    '### 作りました',
    '',
    '**⚠️ 警告：このサイトは意図的に極めて重い状態にしています。保存してから開いてください。**',
    '',
    '次にやること：**画面上部の【試す】ボタンで動作を確認してみてください。**',
    '',
    '- `index.html` を作りました',
    '- **styles.css** で色を決めました',
    '・メモ',
    '',
    '1. 開く',
    '2. 押す',
  ].join('\n')

  it('見出し・段落・段落・箇条書き（-と・が続く所は1つ）・番号つきの順に出る', () => {
    const blocks = parseChatText(doc)
    expect(blocks.map(b => b.kind)).toEqual(['heading', 'para', 'para', 'list', 'para'])
    expect(blocks[3]).toEqual(list(
      [C('index.html'), T(' を作りました')],
      [B('styles.css'), T(' で色を決めました')],
      [T('メモ')],
    ))
    expect(blocks[4]).toEqual(para([T('1. 開く')], [T('2. 押す')]))
  })

  // 出力に ** も ``` も # も残らない（描く前の段階で記号が外れている）
  it('対になった記号は残らない', () => {
    const flat = JSON.stringify(parseChatText(doc))
    expect(flat).not.toContain('**')
    expect(flat).not.toContain('`')
    expect(flat).not.toContain('###')
  })

  it('★ 流し込み中: どの長さで切っても例外を投げず、出力の「あ」は入力と同数（文字を落とさない）', () => {
    const src = doc + '\n\nあ**あ`あ\n- あ\n### あ'
    for (let n = 0; n <= src.length; n++) {
      const part = src.slice(0, n)
      const blocks = parseChatText(part)
      const out = JSON.stringify(blocks).split('あ').length - 1
      const inn = part.split('あ').length - 1
      expect(out, `n=${n}`).toBe(inn)
    }
  })
})

describe('長い返事でも重くならない・どんな並びでも壊れない', () => {
  const timed = (f: () => unknown): number => { const t = Date.now(); f(); return Date.now() - t }

  it('★ 記号だらけの長い入力でも線形に終わる（正規表現の入れ子の量指定をしない）', () => {
    const inputs: Record<string, string> = {
      '** の羅列（対になる）': '**a'.repeat(100_000),
      '** の羅列（改行つき）': '**a**\n'.repeat(50_000),
      '` の羅列': '`'.repeat(200_000),
      '1 行に開いたままの `': 'x`'.repeat(100_000),
      'コードの中の ** だらけ': '`' + '**'.repeat(100_000) + '`' + ' **x',
      '「`**`」の繰り返し': '`**`'.repeat(50_000),
      '* の羅列': '* '.repeat(100_000),
      '- の羅列（各行）': '- a\n'.repeat(100_000),
      '# の羅列': '#'.repeat(200_000),
      '空白の羅列': ' '.repeat(200_000) + 'x',
    }
    for (const [name, input] of Object.entries(inputs)) {
      const ms = timed(() => parseChatText(input))
      expect(ms, `${name}: ${ms}ms`).toBeLessThan(2000)
    }
  })

  it('★ 記号をでたらめに並べても例外を投げず、「あ」を落とさず、空の太字・コードを作らない（固定の乱数）', () => {
    const alphabet = ['*', '*', '`', '-', ' ', '\n', '\n', '#', 'あ', 'あ', '・', '1', '.', '<', '>']
    let seed = 12345
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
    for (let k = 0; k < 3000; k++) {
      const len = Math.floor(rnd() * 40)
      let s = ''
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(rnd() * alphabet.length)]
      const blocks = parseChatText(s)
      const json = JSON.stringify(blocks)
      expect(json.split('あ').length - 1, JSON.stringify(s)).toBe(s.split('あ').length - 1)
      const walk = (ins: ChatInline[]) => {
        for (const n of ins) {
          expect(n.s.length, JSON.stringify(s)).toBeGreaterThan(0)
          if (n.t === 'bold') expect(n.s.trim().length, JSON.stringify(s)).toBeGreaterThan(0)
        }
      }
      for (const b of blocks) {
        if (b.kind === 'para') b.lines.forEach(walk)
        else if (b.kind === 'list') b.items.forEach(walk)
        else if (b.kind === 'raw') expect(b.text.length, JSON.stringify(s)).toBeGreaterThan(0)
        else walk(b.inlines)
      }
    }
  })
})
