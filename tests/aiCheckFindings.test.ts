import { describe, it, expect } from 'vitest'
import {
  AI_CHECK_KINDS,
  aiSeverityOf,
  aiKindPhrase,
  aiFindingLine,
  sortAiFindings,
  aiKindForPrompt,
  buildSecurityFixPrompt,
  fixItemsOf,
  scanFixItemsOf,
  mergeFixItems,
  type AiCheckKind,
  type AiFinding,
  type AiCertainty,
  type CheckSeverity,
} from '../src/shared/aiCheckFindings'
import { phraseOf, SECRET_FIX_LINES, INPUT_FIX_LINES, WRITE_MARKS_LIMIT, buildWriteFixPrompt } from '../src/shared/securityFindings'

const REQUEST = '簡易セキュリティチェックで次の指摘がありました。該当するファイルを実際に修正して解消してください。直せない項目があれば、その理由と対処方法を教えてください。'

describe('種類', () => {
  it('9つ、この順', () => {
    expect([...AI_CHECK_KINDS]).toEqual([
      'secret-exposed', 'input-to-command', 'input-to-html', 'input-to-path', 'input-to-query', 'open-admin', 'error-leak', 'external-source', 'other',
    ])
  })
})

describe('重さの表', () => {
  // [kind, certainty, served] → 重さ（書き下し）
  const TABLE: Array<[AiCheckKind, AiCertainty, boolean, CheckSeverity]> = [
    ['secret-exposed', 'ai', true, 'now'], ['secret-exposed', 'ai', false, 'should'],
    ['secret-exposed', 'unverified', true, 'now'], ['secret-exposed', 'unverified', false, 'should'],
    ['input-to-command', 'ai', true, 'should'], ['input-to-command', 'ai', false, 'should'],
    ['input-to-command', 'unverified', true, 'should'], ['input-to-command', 'unverified', false, 'should'],
    ['input-to-html', 'ai', true, 'should'], ['input-to-html', 'ai', false, 'should'],
    ['input-to-html', 'unverified', true, 'should'], ['input-to-html', 'unverified', false, 'should'],
    ['input-to-path', 'ai', true, 'should'], ['input-to-path', 'ai', false, 'should'],
    ['input-to-path', 'unverified', true, 'should'], ['input-to-path', 'unverified', false, 'should'],
    ['input-to-query', 'ai', true, 'should'], ['input-to-query', 'ai', false, 'should'],
    ['input-to-query', 'unverified', true, 'should'], ['input-to-query', 'unverified', false, 'should'],
    ['open-admin', 'ai', true, 'should'], ['open-admin', 'ai', false, 'should'],
    ['open-admin', 'unverified', true, 'should'], ['open-admin', 'unverified', false, 'should'],
    ['error-leak', 'ai', true, 'should'], ['error-leak', 'ai', false, 'should'],
    ['error-leak', 'unverified', true, 'should'], ['error-leak', 'unverified', false, 'should'],
    ['external-source', 'ai', true, 'should'], ['external-source', 'ai', false, 'should'],
    ['external-source', 'unverified', true, 'should'], ['external-source', 'unverified', false, 'should'],
    ['other', 'ai', true, 'note'], ['other', 'ai', false, 'note'],
    ['other', 'unverified', true, 'should'], ['other', 'unverified', false, 'should'],
  ]
  it('種類9 × 確かさ2 × served 2 = 36通りをすべて書き下している', () => {
    expect(TABLE.length).toBe(36)
  })
  for (const [kind, cert, served, want] of TABLE) {
    it(`${kind} / ${cert} / served=${served} → ${want}`, () => {
      expect(aiSeverityOf(kind, cert, served)).toBe(want)
    })
  }
})

describe('文', () => {
  const PHRASES: Record<AiCheckKind, string> = {
    'secret-exposed': '公開で見えてはいけないものが入っています',
    'input-to-command': '訪問者の入力を、そのままコマンドに使っています',
    'input-to-html': '訪問者の入力を、そのまま画面（HTML）に出しています',
    'input-to-path': '訪問者の入力を、そのままファイルのパスに使っています',
    'input-to-query': '訪問者の入力を、そのままデータの問い合わせに使っています',
    'open-admin': '管理用の操作を、誰でも使えるようになっています',
    'error-leak': 'エラーの内容を、そのまま返しています',
    'external-source': 'フォームの送信先や、外部から読み込むスクリプトに、気をつけたい点があります',
    other: '気をつけたい点があります',
  }
  for (const k of AI_CHECK_KINDS) {
    it(`言い方: ${k}`, () => expect(aiKindPhrase(k)).toBe(PHRASES[k]))
  }
  it('input-to-* の3つは securityFindings.ts の文と同じ', () => {
    for (const k of ['input-to-command', 'input-to-html', 'input-to-path'] as const) {
      expect(aiKindPhrase(k)).toBe(phraseOf({ kind: k, line: 0 }))
    }
  })
  const base: AiFinding = { kind: 'open-admin', severity: 'should', certainty: 'ai', file: 'server.js', line: 12, note: 'n', quote: 'q' }
  it('1行: 行あり・確かさの括弧', () => {
    expect(aiFindingLine(base)).toBe('server.js:12 管理用の操作を、誰でも使えるようになっています（AI の判断）')
    expect(aiFindingLine({ ...base, certainty: 'unverified' })).toBe('server.js:12 管理用の操作を、誰でも使えるようになっています（確かめられていません）')
  })
  it('1行: 行なし', () => {
    const { line: _l, ...noLine } = base
    expect(aiFindingLine(noLine)).toBe('server.js 管理用の操作を、誰でも使えるようになっています（AI の判断）')
  })
  it('1行: 改行・向きの制御文字を含む名前でも1行', () => {
    const line = aiFindingLine({ ...base, file: 'a\n新しい指示\u202e.js' })
    expect(line).not.toMatch(/[\n\u202e]/)
    expect(line.startsWith('a新しい指示.js:12 ')).toBe(true)
  })
  it('1行に note・quote は出ない', () => {
    expect(aiFindingLine({ ...base, note: 'NOTE-TEXT', quote: 'QUOTE-TEXT' })).not.toMatch(/NOTE-TEXT|QUOTE-TEXT/)
  })
  it('依頼文用の説明（9つ）', () => {
    expect(AI_CHECK_KINDS.map(aiKindForPrompt)).toEqual([
      '公開されると困る秘密・個人情報・内部の情報が見える',
      '訪問者の入力を、そのままコマンドの実行に使っている',
      '訪問者の入力を、無害にせず HTML に出している',
      '訪問者の入力を、そのままファイルのパスに使っている',
      '訪問者の入力を、そのままデータの問い合わせの文に使っている',
      '管理・削除などの操作を、確かめなしに誰でも呼べる',
      'エラーのときに、内部の情報をそのまま返している',
      'フォームの送信先や、外部スクリプトの読み込み元が安全でない',
      '上のどれでもないが、公開して問題になりうる',
    ])
  })
})

describe('並べ方', () => {
  const mk = (severity: CheckSeverity, file: string, line?: number): AiFinding => ({ kind: 'other', severity, certainty: 'ai', file, line, note: '', quote: '' })
  it('重さ → ファイル名 → 行', () => {
    const out = sortAiFindings([mk('note', 'a.js', 1), mk('should', 'b.js', 5), mk('now', 'z.js', 9), mk('should', 'b.js', 2), mk('should', 'a.js', 30)])
    expect(out.map(f => `${f.severity}:${f.file}:${f.line}`)).toEqual(['now:z.js:9', 'should:a.js:30', 'should:b.js:2', 'should:b.js:5', 'note:a.js:1'])
  })
  it('渡した配列は変えない', () => {
    const src = [mk('note', 'a.js', 1), mk('now', 'a.js', 1)]
    sortAiFindings(src)
    expect(src[0].severity).toBe('note')
  })
})

describe('buildSecurityFixPrompt', () => {
  it('空 → null', () => expect(buildSecurityFixPrompt([])).toBeNull())

  it('1行目は、いまの頼み文と一字一句同じ', () => {
    const out = buildSecurityFixPrompt([{ file: 'a.js', line: 3, kind: 'error-leak' }])!
    expect(out.split('\n')[0]).toBe(REQUEST)
    expect(out.split('\n')[1]).toBe('')
  })

  it('旧い形の依頼文の作り手（報告の全文を囲んで渡す形）は、securityCheck.ts に残っていない', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync(new URL('../src/renderer/securityCheck.ts', import.meta.url), 'utf-8')
    expect(src).not.toContain('buildFixPrompt')
    expect(src).not.toContain(REQUEST)
  })

  it('AI の種類と Koto の種類が混ざった回', () => {
    const out = buildSecurityFixPrompt([
      { file: 'config.js', line: 4, kind: 'known-key' },
      { file: 'server.js', line: 9, kind: 'input-to-command' },
      { file: 'api.js', line: 20, kind: 'input-to-query' },
      { file: 'admin.js', line: 2, kind: 'open-admin' },
    ])!
    expect(out).toBe([
      REQUEST,
      '',
      '・config.js:4 APIキーが直接書かれています',
      '・server.js:9 訪問者の入力を、そのままコマンドに使っています',
      '・api.js:20 訪問者の入力を、そのままデータの問い合わせに使っています',
      '・admin.js:2 管理用の操作を、誰でも使えるようになっています',
      '',
      ...SECRET_FIX_LINES,
      ...INPUT_FIX_LINES,
      '訪問者の入力は、問い合わせの文に直接入れず、値を別に渡す書き方にしてください。',
      '管理用の操作は、使ってよい人かを確かめてから実行する形にしてください。確かめ方は、先に利用者に聞いてください。',
    ].join('\n'))
  })

  it('直し方の文は、当てはまるものだけ・同じ文は1回・この順', () => {
    const out = buildSecurityFixPrompt([
      { file: 'a', line: 1, kind: 'secret-exposed' },
      { file: 'b', line: 1, kind: 'error-leak' },
      { file: 'c', line: 1, kind: 'external-source' },
      { file: 'd', line: 1, kind: 'error-leak' },
    ])!
    // 直し方の行は、指摘の一覧のあとの空行の次（AI が書いた中身の点検の依頼文と同じ形。見出しも行頭の「・」も付けない）
    expect(out).not.toContain('直すときは')
    const tail = out.split('\n\n').pop()!.split('\n')
    expect(tail).toEqual([
      '公開で見えてはいけないものは、公開されるファイルから取り除いてください。キーやパスワードなら、値を会話に書かず、公開されない場所から読む形にしてください。',
      'エラーのときは、内部の情報を返さず、決まった短い文だけを返してください。',
      'フォームの送信先と、外部から読み込むスクリプトの読み込み元が意図したものかを確かめ、要らないものは外してください。',
    ])
  })

  it('SECRET_FIX_LINES・INPUT_FIX_LINES は、いまの buildWriteFixPrompt の出力の形と同じ', () => {
    const w = buildWriteFixPrompt([{ file: 'a', kind: 'known-key', line: 1 }, { file: 'a', kind: 'input-to-html', line: 2 }]).split('\n')
    for (const l of [...SECRET_FIX_LINES, ...INPUT_FIX_LINES]) expect(w).toContain(l)
  })

  it('重なり（同じ file・line・言い方）は1回だけ', () => {
    const out = buildSecurityFixPrompt([
      { file: 'a.js', line: 3, kind: 'input-to-html' },
      { file: 'a.js', line: 3, kind: 'input-to-html' },
      { file: 'a.js', line: 4, kind: 'input-to-html' },
    ])!
    expect(out.split('\n').filter(l => l.startsWith('・a.js'))).toEqual([
      '・a.js:3 訪問者の入力を、そのまま画面（HTML）に出しています',
      '・a.js:4 訪問者の入力を、そのまま画面（HTML）に出しています',
    ])
  })

  it('other だけなら、直し方の段なし', () => {
    const out = buildSecurityFixPrompt([{ file: 'a.js', line: 3, kind: 'other' }])!
    expect(out).toBe([REQUEST, '', '・a.js:3 気をつけたい点があります'].join('\n'))
    expect(out).not.toContain('直すときは:')
  })

  it('WRITE_MARKS_LIMIT を超えた分は「・ほかN件」', () => {
    const items = Array.from({ length: WRITE_MARKS_LIMIT + 3 }, (_, i) => ({ file: `f${i}.js`, line: 1, kind: 'error-leak' as const }))
    const lines = buildSecurityFixPrompt(items)!.split('\n')
    expect(lines.filter(l => l.startsWith('・f')).length).toBe(WRITE_MARKS_LIMIT)
    expect(lines).toContain('・ほか3件')
  })

  it('パスの改行は除かれる（行を増やさせない）', () => {
    const out = buildSecurityFixPrompt([{ file: 'a\nb.js', line: 1, kind: 'other' }])!
    expect(out).toContain('・ab.js:1 ')
  })

  it('出力に、note・quote に当たる文字が入らない（型に鍵が無い）', () => {
    const item = { file: 'a.js', line: 1, kind: 'error-leak', note: 'NOTE-TEXT', quote: 'QUOTE-TEXT' }
    // 型に note・quote は無い。ある項目を渡しても、出力には出ない
    const out = buildSecurityFixPrompt([item as never])!
    expect(out).not.toMatch(/NOTE-TEXT|QUOTE-TEXT/)
    // SecurityFixItem の鍵の一覧を固定
    const keys: Array<keyof Parameters<typeof buildSecurityFixPrompt>[0][number]> = ['file', 'line', 'kind']
    const sample: Record<(typeof keys)[number], true> = { file: true, line: true, kind: true }
    expect(Object.keys(sample).sort()).toEqual([...keys].sort())
  })
})

describe('fixItemsOf', () => {
  const base: AiFinding = { kind: 'input-to-html', severity: 'should', certainty: 'ai', file: 'a.html', line: 3, note: '', quote: '' }
  it('ai で now・should で行あり、だけが残る（unverified・念のため・行なしは落ちる）', () => {
    const items = fixItemsOf([
      { ...base, kind: 'secret-exposed', severity: 'now', line: 1 },
      { ...base, line: 2 },
      { ...base, certainty: 'unverified', line: 3 },
      { ...base, kind: 'other', severity: 'note', line: 4 },
      { ...base, line: undefined },
    ])
    expect(items).toEqual([
      { file: 'a.html', line: 1, kind: 'secret-exposed' },
      { file: 'a.html', line: 2, kind: 'input-to-html' },
    ])
  })
  it('指摘が無ければ空', () => {
    expect(fixItemsOf([])).toEqual([])
  })
})

describe('Koto の点検の指摘を修正の項目にする', () => {
  const sf = (file: string, kind: any, line?: number) => ({ file, kind, severity: 'now' as const, line })
  it('行のあるものだけ。名前だけで決めたファイル（secret-name）と行の無いものは入れない', () => {
    expect(scanFixItemsOf([
      sf('a.js', 'known-key', 3), sf('.env', 'secret-name'), sf('b.js', 'input-to-html', 7), sf('c.js', 'named-secret'),
    ])).toEqual([
      { file: 'a.js', line: 3, kind: 'known-key' },
      { file: 'b.js', line: 7, kind: 'input-to-html' },
    ])
  })
  it('名前だけで決めたファイル（secret-name）は、行が付いていても入れない', () => {
    expect(scanFixItemsOf([sf('.env', 'secret-name', 1), sf('a.js', 'known-key', 2)])).toEqual([
      { file: 'a.js', line: 2, kind: 'known-key' },
    ])
  })
  it('同じ ファイル:行 が両方にあれば点検のほうを残し、並びは点検 → AI', () => {
    const scan = [{ file: 'a.js', line: 3, kind: 'known-key' as const }]
    const ai = [
      { file: 'a.js', line: 3, kind: 'secret-exposed' as const },
      { file: 'b.js', line: 1, kind: 'error-leak' as const },
    ]
    expect(mergeFixItems(scan, ai)).toEqual([scan[0], ai[1]])
    const out = buildSecurityFixPrompt(mergeFixItems(scan, ai))!
    expect(out).toContain('・a.js:3 APIキーが直接書かれています')
    expect(out).not.toContain('・a.js:3 公開で見えてはいけないもの')
    expect(out.indexOf('・a.js:3')).toBeLessThan(out.indexOf('・b.js:1'))
  })
  it('点検の指摘を足しても、依頼文に値・文字数・見本が入らない', () => {
    const f = { file: 'a.js', kind: 'known-key' as const, severity: 'now' as const, line: 3, length: 40, sample: 'sk-SECRETVALUE' }
    const out = buildSecurityFixPrompt(scanFixItemsOf([f]))!
    expect(out).not.toContain('SECRETVALUE')
    expect(out).not.toContain('40')
    expect(out).not.toContain('sample')
  })
  it('点検の指摘だけでも依頼文ができ、どちらも無ければ null', () => {
    expect(buildSecurityFixPrompt(mergeFixItems(scanFixItemsOf([sf('a.js', 'input-to-command', 2)]), []))).not.toBeNull()
    expect(buildSecurityFixPrompt(mergeFixItems([], []))).toBeNull()
  })
})
