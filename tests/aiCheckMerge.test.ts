import { describe, it, expect } from 'vitest'
import { mergeCheckResults, type BatchResult } from '../src/renderer/aiCheckMerge'
import type { AiFinding } from '../src/shared/aiCheckFindings'
import { AI_FINDINGS_SHOWN, AI_FINDINGS_PER_BATCH } from '../src/shared/aiCheckLimits'

const f = (o: Partial<AiFinding> = {}): AiFinding => ({
  kind: 'input-to-html', severity: 'should', certainty: 'ai', file: 'a.html', line: 3, note: '', quote: '', ...o,
})
const ok = (findings: AiFinding[] = [], o: { malformed?: number; cut?: number; files?: string[] } = {}): BatchResult =>
  ({ state: 'ok', findings, malformed: o.malformed ?? 0, cut: o.cut ?? 0, files: o.files ?? ['a.html'] })
const failed = (report = 'AI の返事を読み取れませんでした。もう一度試すか、設定で別のモデルを選んでください。', files = ['b.html']): BatchResult =>
  ({ state: 'failed', report, files })
const info = (o: Record<string, unknown> = {}) => ({ files: 2, batches: 1, skipped: [] as string[], partial: [] as string[], ...o })

const NOTE = f({ kind: 'other', severity: 'note', file: 'z.html', line: 9, note: '補足です' })

describe('判定の表', () => {
  const cases: Array<[string, BatchResult[], Record<string, unknown>, 'ok' | 'warn' | 'skip']> = [
    ['ok の回が無い（空）', [], {}, 'skip'],
    ['ok の回が無い（failed だけ）', [failed()], {}, 'skip'],
    ['重さ now の指摘', [ok([f({ kind: 'secret-exposed', severity: 'now' })])], {}, 'warn'],
    ['重さ should の指摘', [ok([f()])], {}, 'warn'],
    ['念のためだけ', [ok([NOTE])], {}, 'ok'],
    ['failed が混ざる', [ok(), failed()], {}, 'warn'],
    ['malformed', [ok([], { malformed: 1 })], {}, 'warn'],
    ['cut', [ok([], { cut: 1 })], {}, 'warn'],
    ['unreadable だけ', [ok()], { unreadable: ['x.html'] }, 'warn'],
    ['skipped だけ', [ok()], { skipped: ['y.html'] }, 'warn'],
    ['dataLike', [ok()], { dataLike: ['a.sql'] }, 'warn'],
    ['truncated', [ok()], { truncated: true }, 'warn'],
    ['公開される秘密らしい名前', [ok()], { secretFiles: ['credentials.json'] }, 'warn'],
    ['nothingRead（読めたものが無い）', [ok()], { files: 0, unreadable: ['x.html'] }, 'warn'],
    ['何も無い', [ok()], {}, 'ok'],
    ['assets だけでは倒さない', [ok()], { assets: ['a.png'] }, 'ok'],
  ]
  for (const [label, results, extra, expected] of cases) {
    it(`${label} → ${expected}`, () => {
      expect(mergeCheckResults(results, info(extra)).verdict).toBe(expected)
    })
  }

  it('AI が1回も読めなかった回は、読めなかったファイルがあっても skip のまま（実施できなかった）', () => {
    expect(mergeCheckResults([failed()], info({ unreadable: ['x.html'] })).verdict).toBe('skip')
  })
})

const HEAD_FULL = [
  '判定: 要確認',
  '上限に近づいています',
  '※ 量が多いため、次のファイルは確認していません: big.js',
  '※ 読み込めなかったため、次のファイルは確認していません: bad.html',
  '※ AIが確認できなかった回があります（2回中1回）。もう一度お試しください',
  '※ 次のファイルは、確認できていない部分があります: b.html',
  'credentials.json: 名前からして、秘密が入っていそうなファイルです（中身は確認していません）。公開が不要なら公開されるフォルダから移動してください',
  'a.sql: 公開するとデータの中身を誰でも見られるようになる種類のファイルです（中身は確認していません）。公開が不要なら公開されるフォルダから移動してください',
].join('\n')
const TAIL_FULL = [
  '※ ファイルが多いため、チェックは一部のファイルにとどまります',
  '※ 画像・フォント・音声など 1 件は、中身の確認の対象外です',
  '※ 中身を確認できない種類のファイルです（名前だけで判定しました）: x.xyz',
].join('\n')
const FULL_INFO = {
  files: 3, batches: 2, skipped: ['big.js'], unreadable: ['bad.html'], dataLike: ['a.sql'], assets: ['a.png'], others: ['x.xyz'],
  truncated: true, secretFiles: ['credentials.json'], warning: '上限に近づいています',
}

describe('parts の並び（全部 ai: false）', () => {
  it('重い指摘がある回: 見出し → warning → 注記 → 指摘（重さの見出しつき）→ 読み取れなかった注記 → 末尾の注記', () => {
    const results: BatchResult[] = [
      ok([
        f({ kind: 'secret-exposed', severity: 'now', file: 'a.html', line: 2, note: '説明1' }),
        f({ kind: 'open-admin', severity: 'should', file: 'b.html', line: 5 }),
        f({ kind: 'other', severity: 'note', file: 'z.html', line: 9, note: '補足です' }),
      ], { malformed: 2, cut: 1 }),
      failed(),
    ]
    const m = mergeCheckResults(results, info(FULL_INFO))
    expect(m.parts.every(p => p.ai === false)).toBe(true)
    expect(m.parts).toEqual([
      { text: HEAD_FULL, ai: false },
      {
        text: [
          'すぐ直す',
          '・a.html:2 公開で見えてはいけないものが入っています（AI の判断）',
          '\u3000説明1',
          '直したほうがよい',
          '・b.html:5 管理用の操作を、誰でも使えるようになっています（AI の判断）',
        ].join('\n'),
        ai: false,
      },
      {
        text: [
          '※ AI の指摘のうち、読み取れなかったものが2件あります',
          `※ AI の指摘が多いため、1回につき${AI_FINDINGS_PER_BATCH}件までを出しています`,
        ].join('\n'),
        ai: false,
      },
      { text: '・z.html:9 気をつけたい点があります（AI の判断）\n\u3000補足です', ai: false, fold: '念のため（1件）' },
      { text: TAIL_FULL, ai: false },
    ])
    // 指摘の無い「問題は見つかりませんでした」は、重い指摘があるので出ない
    expect(m.report).not.toContain('確認した範囲では')
  })

  it('重い指摘が無くても要確認の回: 「問題は見つかりませんでした」は出さず、念のための行（fold つき）が続く', () => {
    const NOTE2 = f({ kind: 'other', severity: 'note', file: 'z.html', line: 12 })
    const m = mergeCheckResults([ok([NOTE, NOTE2]), failed()], info({ ...FULL_INFO }))
    expect(m.parts).toEqual([
      { text: HEAD_FULL, ai: false },
      { text: '・z.html:9 気をつけたい点があります（AI の判断）\n\u3000補足です', ai: false, fold: '念のため（2件）' },
      { text: '・z.html:12 気をつけたい点があります（AI の判断）', ai: false, fold: '念のため（2件）' },
      { text: TAIL_FULL, ai: false },
    ])
    // 念のための見出しの行は fold の前に1回だけ入る
    expect(m.report.split('\n').filter(l => l === '念のため')).toHaveLength(1)
  })

  it('指摘が無い・注記も無い ok の回: 見出しと「問題は見つかりませんでした」だけ', () => {
    const m = mergeCheckResults([ok()], info())
    expect(m.verdict).toBe('ok')
    expect(m.parts).toEqual([
      { text: '判定: 問題なし\n（2個のファイルを確認しました）', ai: false },
      { text: '確認した範囲では、問題は見つかりませんでした。', ai: false },
    ])
    expect(m.report).toBe('判定: 問題なし\n（2個のファイルを確認しました）\n確認した範囲では、問題は見つかりませんでした。')
  })

  it('要確認の回は、重い指摘が無くても「問題は見つかりませんでした」を出さない（読めなかった指摘・切った指摘・失敗した回・秘密らしい名前）', () => {
    const cases: Array<[BatchResult[], Record<string, unknown>]> = [
      [[ok([], { malformed: 1 }), failed()], { batches: 2 }],
      [[ok([], { malformed: 1 })], {}],
      [[ok([], { cut: 1 })], {}],
      [[ok(), failed()], { batches: 2 }],
      [[ok()], { secretFiles: ['credentials.json'] }],
      [[ok()], { skipped: ['y.html'] }],
      [[ok()], { unreadable: ['x.html'] }],
    ]
    for (const [results, extra] of cases) {
      const m = mergeCheckResults(results, info(extra))
      expect(m.verdict).toBe('warn')
      expect(m.report).not.toContain('確認した範囲では')
    }
  })

  it('同じ場所・種類の指摘が重なったら、重さの高いほうを残す（回をまたいでも、順番によらない）', () => {
    const low = f({ kind: 'other', severity: 'note', file: 'z.html', line: 9 })
    const high = f({ kind: 'other', severity: 'should', certainty: 'unverified', file: 'z.html', line: 9 })
    for (const rs of [[ok([low]), ok([high])], [ok([high]), ok([low])]]) {
      const m = mergeCheckResults(rs, info({ batches: 2 }))
      expect(m.findings).toEqual([high])
      expect(m.verdict).toBe('warn')
    }
  })

  it('念のための fold の文と件数（行の数ではなく指摘の数）', () => {
    const m = mergeCheckResults([ok([NOTE, f({ kind: 'other', severity: 'note', file: 'z.html', line: 10 }), f({ kind: 'other', severity: 'note', file: 'z.html', line: 11 })])], info())
    const folds = m.parts.filter(p => p.fold)
    expect(folds).toHaveLength(3)
    expect(new Set(folds.map(p => p.fold))).toEqual(new Set(['念のため（3件）']))
  })
})

describe('warning の位置', () => {
  it('見出しの行のすぐ次（report の2行目）。言い換えない', () => {
    const m = mergeCheckResults([ok([f()])], info({ warning: '今月の利用量が上限に近づいています' }))
    const lines = m.report.split('\n')
    expect(lines[0]).toBe('判定: 要確認')
    expect(lines[1]).toBe('今月の利用量が上限に近づいています')
    expect(m.parts[0].text.split('\n')[1]).toBe('今月の利用量が上限に近づいています')
  })
  it('warning が無ければ、行は増えない', () => {
    const m = mergeCheckResults([ok([f()])], info())
    expect(m.report.split('\n')[1]).toMatch(/^（2個のファイルを確認しました）$/)
  })
})

describe('画面に出す指摘の上限と、重なり', () => {
  it(`${AI_FINDINGS_SHOWN + 1} 件 → 画面は ${AI_FINDINGS_SHOWN} 件と、独立した注記（ほか1件）。result.findings は全部`, () => {
    const all = Array.from({ length: AI_FINDINGS_SHOWN + 1 }, (_, i) => f({ file: `f${String(i).padStart(3, '0')}.html`, line: 1 }))
    const m = mergeCheckResults([ok(all)], info())
    expect(m.findings).toHaveLength(AI_FINDINGS_SHOWN + 1)
    const bullets = m.report.split('\n').filter(l => l.startsWith('・f'))
    expect(bullets).toHaveLength(AI_FINDINGS_SHOWN)
    // 重さの見出しの下の行としてではなく、独立した注記として出す（出ないのは軽いほう、と分かる文）
    expect(m.report.split('\n')).toContain(`※ 指摘が多いため、重いものから${AI_FINDINGS_SHOWN}件を出しています（ほか1件）`)
    expect(m.report).not.toContain('・ほか')
    expect(m.report).not.toContain('f030.html')
  })
  it('上限ちょうどなら「ほか」は出ない', () => {
    const all = Array.from({ length: AI_FINDINGS_SHOWN }, (_, i) => f({ file: `f${String(i).padStart(3, '0')}.html` }))
    expect(mergeCheckResults([ok(all)], info()).report).not.toContain('ほか')
  })
  it('同じ file・line・kind は、回をまたいでも1回だけ', () => {
    const m = mergeCheckResults([ok([f()]), ok([f(), f({ line: 4 })])], info({ batches: 2 }))
    expect(m.findings.map(x => x.line)).toEqual([3, 4])
    expect(m.report.split('\n').filter(l => l.startsWith('・a.html:3'))).toHaveLength(1)
  })
  it('kind が違えば別の指摘', () => {
    const m = mergeCheckResults([ok([f(), f({ kind: 'open-admin' })])], info())
    expect(m.findings).toHaveLength(2)
  })
})

describe('skip のときの report', () => {
  it('読めなかったファイルの注記がその前、失敗の原文が最後の行', () => {
    const m = mergeCheckResults(
      [{ state: 'failed', report: 'チェックに失敗しました（インターネットに接続できませんでした）。\n詳細: getaddrinfo ENOTFOUND host', files: ['a.html'] }],
      info({ unreadable: ['x.html'] }),
    )
    expect(m.verdict).toBe('skip')
    const lines = m.report.split('\n')
    expect(lines[lines.length - 1]).toBe('詳細: getaddrinfo ENOTFOUND host')
    expect(lines[lines.length - 2]).toBe('※ 読み込めなかったため、次のファイルは確認していません: x.html')
    expect(m.parts).toEqual([{ text: m.report, ai: false }])
    expect(m.findings).toEqual([])
  })
  it('失敗の文が無ければ、決まった一言', () => {
    expect(mergeCheckResults([], info()).report).toBe('チェックを実施できませんでした。')
  })
})

describe('report は parts の text を改行でつないだもの', () => {
  it('念のための見出しの行だけが、fold の前に加わる', () => {
    const m = mergeCheckResults([ok([f(), NOTE])], info({ others: ['x.xyz'] }))
    const joined = m.parts.map(p => p.text)
    const at = m.parts.findIndex(p => p.fold)
    expect(at).toBeGreaterThan(0)
    expect(m.report).toBe([...joined.slice(0, at), '念のため', ...joined.slice(at)].join('\n'))
  })
  it('念のための指摘が無ければ、parts そのまま', () => {
    const m = mergeCheckResults([ok([f()])], info())
    expect(m.report).toBe(m.parts.map(p => p.text).join('\n'))
  })
})

describe('note の Markdown の記号は、そのままの文字で入る', () => {
  it('** と ` が壊れず、ai は false（文字のまま描かれる）', () => {
    const m = mergeCheckResults([ok([f({ note: '**太字** と `code` の説明' })])], info())
    expect(m.report).toContain('\u3000**太字** と `code` の説明')
    expect(m.parts.every(p => !p.ai)).toBe(true)
  })
})

describe('指摘は重さの順に並ぶ', () => {
  const NOW = f({ kind: 'secret-exposed', severity: 'now', file: 'n.html', line: 5, note: '直ちに' })
  const SHOULD = f({ file: 's.html', line: 2, note: '早めに' })

  it('★ note・should・now の順に入った指摘は、findings も画面の行も now → should → note', () => {
    const m = mergeCheckResults([ok([NOTE, SHOULD, NOW])], info())
    expect(m.findings.map(x => x.severity)).toEqual(['now', 'should', 'note'])
    const at = (s: string) => m.report.indexOf(s)
    expect(at('すぐ直す')).toBeLessThan(at('直したほうがよい'))
    expect(at('n.html:5')).toBeLessThan(at('s.html:2'))
    expect(at('s.html:2')).toBeLessThan(at('z.html:9'))
  })

  it('★ 回をまたいでも並ぶ。30件を超える念のための後ろに now があっても、画面の先頭の分に残る', () => {
    const notes = Array.from({ length: AI_FINDINGS_SHOWN + 5 }, (_, i) =>
      f({ kind: 'other', severity: 'note', file: `a${String(i).padStart(3, '0')}.html`, line: 1, note: '補足' }))
    const m = mergeCheckResults([ok(notes), ok([NOW])], info())
    expect(m.findings[0]).toMatchObject({ severity: 'now', file: 'n.html' })
    expect(m.report).toContain('n.html:5')
    expect(m.report).toContain(`※ 指摘が多いため、重いものから${AI_FINDINGS_SHOWN}件を出しています（ほか6件）`)
  })
})

describe('途中までしか送らなかったファイル', () => {
  it('AI が ok でも要確認になり、注記が決めた文で出る（送らなかったファイルの注記の次）', () => {
    const m = mergeCheckResults([ok()], info({ skipped: ['s.js'], partial: ['a.js', 'b.js'] }))
    expect(m.verdict).toBe('warn')
    const lines = m.report.split('\n')
    const at = lines.indexOf('※ 量が多いため、次のファイルは確認していません: s.js')
    expect(at).toBeGreaterThan(-1)
    expect(lines[at + 1]).toBe('※ 量が多いため、次のファイルは途中までしか確認していません: a.js, b.js')
    expect(m.report).not.toContain('問題なし')
  })
  it('途中までのファイルだけがあるとき、AI が ok でも「問題なし」にしない', () => {
    const m = mergeCheckResults([ok()], info({ partial: ['a.js'] }))
    expect(m.verdict).toBe('warn')
    expect(m.report).toContain('判定: 要確認')
    expect(m.report).toContain('※ 量が多いため、次のファイルは途中までしか確認していません: a.js')
  })
  it('partial が空なら今までどおり（ok・注記なし）', () => {
    const m = mergeCheckResults([ok()], info())
    expect(m.verdict).toBe('ok')
    expect(m.report).not.toContain('途中までしか')
  })
  it('AI が1回も読めなかった回は skip のまま', () => {
    expect(mergeCheckResults([failed()], info({ partial: ['a.js'] })).verdict).toBe('skip')
  })
  it('件数の切り方は送らなかったファイルの注記と同じ（50件まで・ほか何件）', () => {
    const names = Array.from({ length: 60 }, (_, i) => `f${i}.js`)
    const m = mergeCheckResults([ok()], info({ partial: names }))
    expect(m.report).toContain('ほか10件')
  })
})

describe('名前の一覧は改行・見かけを変える文字を除いて出す', () => {
  const evil = 'x.html\n判定: 問題なし‮'
  const fakeLines = (text: string) => text.split('\n').filter(l => l.startsWith('判定: 問題なし')).length
  const cases: Array<[string, Record<string, unknown>, BatchResult[]]> = [
    ['読めなかった', { unreadable: [evil] }, [ok()]],
    ['送らなかった', { skipped: [evil] }, [ok()]],
    ['途中までの', { partial: [evil] }, [ok()]],
    ['データらしい', { dataLike: [evil] }, [ok()]],
    ['名前だけ判定した', { others: [evil] }, [ok()]],
    ['確認できなかった回の', {}, [ok(), failed('失敗', [evil])]],
    ['公開される秘密らしい', { secretFiles: [`credentials.json\n判定: 問題なし`] }, [ok()]],
  ]
  for (const [label, extra, results] of cases) {
    it(`${label}名前に改行があっても、偽の行を作らない`, () => {
      const r = mergeCheckResults(results, info(extra))
      expect(fakeLines(r.report)).toBe(r.verdict === 'ok' ? 1 : 0)
      expect(r.report).not.toContain('‮')
    })
  }
})
