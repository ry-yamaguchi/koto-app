import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import * as ts from 'typescript'
import * as cloudCost from '../src/shared/cloudCost'

// 費用の金額（レジストリの月額・保存場所の月額）は shared/cloudCost.ts の定数の1か所にだけ書く。
// 画面や処理の記録の文は、定数から取る作り手（cloudCost.ts の関数）を通す。サービス側の改定で金額が変わったとき、
// 直書きの文だけが古い額を言い続ける——0.6.25 までは cloudTeardown.ts の2か所が「月額220円」を直書きしていた。
//
// このテストは src の全ファイルを構文木で読み、コメントを除いた文字列・テンプレートの文字・JSX の文字に
// 「220円」「495円」が無いことを見る（コメントは説明であって、画面にも記録にも出ない）。
// 同梱の使い方ガイド（docs/usage-guide.html）は静的な文書で定数を読めないので、書かれている金額が定数と同じ値であることを別に見る。

const ROOT = join(__dirname, '..')
const SRC = join(ROOT, 'src')

/** 金額の直書き。`月額220円`・`220 円` に当たり、`1220円` や `22円` には当たらない。 */
const AMOUNT_LITERAL = /\b(220|495)\s?円/

type Hit = { line: number; text: string }

/** コメントを除いた、文字列・テンプレートの文字の部分・JSX の文字を集める（構文木で読む。文字列の中の `//` に惑わされない）。 */
function literalTexts(fileName: string, code: string): Hit[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, kind)
  const out: Hit[] = []
  const add = (n: ts.Node, text: string) => out.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text })
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) add(n, n.text)
    else if (ts.isJsxText(n)) add(n, n.text)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

/** 金額の直書きに当たる行。 */
const amountHits = (fileName: string, code: string): Hit[] => literalTexts(fileName, code).filter(h => AMOUNT_LITERAL.test(h.text))

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
    else if (/\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

describe('走査器の自己点検（空振りしない）', () => {
  it('文字列・テンプレート・JSX の文字にある直書きは見つける', () => {
    expect(amountHits('a.ts', "const a = '月額220円がかかり続けます'")).toHaveLength(1)
    expect(amountHits('a.ts', 'const a = "保存場所は495円"')).toHaveLength(1)
    expect(amountHits('a.ts', 'const a = `月額220円（${x}）`')).toHaveLength(1)
    expect(amountHits('a.ts', 'const a = `（${x}）月額495円`')).toHaveLength(1)
    expect(amountHits('a.ts', "const a = '月額' + '220 円'")).toHaveLength(1)
    expect(amountHits('a.tsx', 'const a = <p>月額220円がかかります</p>')).toHaveLength(1)
    // 文字列の中の `//` のあとにある直書きも見逃さない（コメントと取り違えない）
    expect(amountHits('a.ts', "const a = 'https://example.test/' + '月額220円'")).toHaveLength(1)
    expect(amountHits('a.ts', "const a = 'https://example.test/月額220円'")).toHaveLength(1)
  })

  it('コメントの中の金額は数えない（行コメント・ブロック・JSDoc・JSX の中のコメント）', () => {
    const code = [
      '// 月額220円がかかり続ける',
      '/* 保存場所は495円 */',
      '/**',
      ' * 月額220円（税込）',
      ' */',
      'export const a = 1',
      'export const b = <p>{/* 月額495円 */}ok</p>',
    ].join('\n')
    expect(amountHits('a.tsx', code)).toEqual([])
  })

  it('定数から取る形・別の金額・桁違いは当てない', () => {
    expect(amountHits('a.ts', 'const a = `月額${REGISTRY_MONTHLY_YEN}円`')).toEqual([])
    expect(amountHits('a.ts', "const a = '超過は1GiBごと22円'")).toEqual([])
    expect(amountHits('a.ts', "const a = '月額1220円'")).toEqual([])
    expect(amountHits('a.ts', "const a = '2200円'")).toEqual([])
  })

  it('行番号を返す', () => {
    expect(amountHits('a.ts', "const a = 1\nconst b = '月額220円'")).toEqual([{ line: 2, text: '月額220円' }])
  })

  it('src を実際に走査している（空の一覧で通らない）', () => {
    const files = sourceFiles(SRC).map(f => relative(ROOT, f).split('\\').join('/'))
    expect(files.length).toBeGreaterThan(200)
    // 直書きのあった場所と、金額を持つ場所は、必ず対象に入っている
    expect(files).toContain('src/main/ipc/cloudTeardown.ts')
    expect(files).toContain('src/shared/cloudCost.ts')
    expect(files.some(f => f.endsWith('.tsx'))).toBe(true)
  })
})

describe('src の金額の直書き（コメントを除いた走査）', () => {
  it('★ 「220円」「495円」を文字として書いたところが0件（金額は cloudCost.ts の定数と作り手から取る）', () => {
    const found = sourceFiles(SRC).flatMap(f => amountHits(f, readFileSync(f, 'utf8')).map(h => `${relative(ROOT, f)}:${h.line} ${h.text.slice(0, 40)}`))
    expect(found).toEqual([])
  })

  it('cloudCost.ts の定数は、公表値のまま1か所にある（直書きを禁じる走査の前提）', () => {
    expect(cloudCost.REGISTRY_MONTHLY_YEN).toBe(220)
    expect(cloudCost.BUCKET_MONTHLY_YEN).toBe(495)
    const code = readFileSync(join(SRC, 'shared/cloudCost.ts'), 'utf8')
    expect(code).toContain('export const REGISTRY_MONTHLY_YEN = 220')
    expect(code).toContain('export const BUCKET_MONTHLY_YEN = 495')
  })
})

describe('同梱の使い方ガイド（docs/usage-guide.html）の金額は、cloudCost.ts の定数と同じ値', () => {
  // ガイドは配布物に入り、Koto のヘルプメニューから開く。定数を直したら、ガイドの金額も同じ値に直す（掟9）。
  const guide = readFileSync(join(ROOT, 'docs/usage-guide.html'), 'utf8')
  const amounts = [...guide.matchAll(/(\d[\d,]*)\s?円/g)].map(m => Number(m[1].replace(/,/g, '')))

  it('走査器の自己点検: 金額の書き方を拾う（空振りしない）', () => {
    const pick = (t: string) => [...t.matchAll(/(\d[\d,]*)\s?円/g)].map(m => Number(m[1].replace(/,/g, '')))
    expect(pick('月額220円（税込）')).toEqual([220])
    expect(pick('この220円が止まります・月額 1,485円')).toEqual([220, 1485])
    expect(pick('円は使わない')).toEqual([])
  })

  it('★ ガイドに出る円の金額は、すべてレジストリの月額か保存場所の月額と同じ値（定数を直したのにガイドが古い額を言い続けない）', () => {
    expect(amounts.length).toBeGreaterThan(0)
    const allowed = [cloudCost.REGISTRY_MONTHLY_YEN, cloudCost.BUCKET_MONTHLY_YEN]
    const stale = amounts.filter(a => !allowed.includes(a))
    expect(stale, 'docs/usage-guide.html の金額を、cloudCost.ts の定数に合わせて直す').toEqual([])
  })

  it('レジストリの月額は、ガイドの数か所に書いてある（書いてある場所を失って通ってしまわない）', () => {
    expect(amounts.filter(a => a === cloudCost.REGISTRY_MONTHLY_YEN).length).toBeGreaterThanOrEqual(4)
  })
})

describe('破棄の結果の結び（cloudTeardown.ts の2か所）', () => {
  const code = readFileSync(join(SRC, 'main/ipc/cloudTeardown.ts'), 'utf8')
  const count = (s: string, part: string) => s.split(part).length - 1

  it('確認できなかった回の行と、レジストリの記録が無い回の行が、どちらも作り手 registryCheckInPanelNote() で終わる', () => {
    expect(count(code, "削除できたか確認できませんでした（${t.replace(/。$/, '')}）。` + registryCheckInPanelNote()")).toBe(1)
    expect(count(code, "レジストリは削除していません。' + registryCheckInPanelNote()")).toBe(1)
    expect(count(code, 'registryCheckInPanelNote()')).toBe(2)
  })

  it('直す前の形（月額を文に書き込んだ結び）は戻さない', () => {
    expect(code).not.toContain('月額220円がかかり続けます')
    expect(code).not.toContain('不要なら削除してください（月額')
    expect(code).not.toContain('コントロールパネルで確認し、不要なら削除してください')
  })
})

describe('使い手のない費用の作り手は持たない', () => {
  it('ongoingCostNotice・registryCostNotice は cloudCost.ts に無く、src のどこからも呼ばれない', () => {
    expect(cloudCost).not.toHaveProperty('ongoingCostNotice')
    expect(cloudCost).not.toHaveProperty('registryCostNotice')
    const users = sourceFiles(SRC).filter(f => /ongoingCostNotice|registryCostNotice/.test(readFileSync(f, 'utf8')))
    expect(users.map(f => relative(ROOT, f))).toEqual([])
  })
})
