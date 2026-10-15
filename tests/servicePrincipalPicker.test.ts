import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'fs'
import { join } from 'path'
import * as ts from 'typescript'
import ServicePrincipalPicker, { SERVICE_PRINCIPALS_URL } from '../src/renderer/components/ServicePrincipalPicker'
import { ACCOUNT_MISMATCH_NOTE, type ServicePrincipalCandidate } from '../src/shared/servicePrincipalCandidates'

// AppRun 専有型 ② の「前のプロジェクトで使った ID」の案内・選択と「新しく作る」リンク（2026-10-06）。
// 見た目だけの部品なので、react-dom/server で実際に描いて、出る文・選ばれている項目を見る
// （文字列の grep ではなく、描いた結果で固定する）。

const ID_A = '111111111111'
const ID_B = '222222222222'
const A: ServicePrincipalCandidate = { id: ID_A, projectNames: ['Landingtest'], updatedAtMs: 200 }
const B: ServicePrincipalCandidate = { id: ID_B, projectNames: ['blog', 'shop'], updatedAtMs: 100 }

const noop = () => {}
function render(candidates: ServicePrincipalCandidate[], value: string): string {
  return renderToStaticMarkup(createElement(ServicePrincipalPicker, { candidates, value, onPick: noop, onPickManual: noop }))
}
const radios = (html: string) => html.match(/<input[^>]*type="radio"[^>]*>/g) ?? []
const checkedRadios = (html: string) => radios(html).filter(r => /\schecked(=|\s|>)/.test(r))

describe('「新しく作る」リンク', () => {
  it('候補がいくつあっても（0件でも）出る。行き先は公式マニュアルのクイックスタートが示す「サービスプリンシパル」の画面', () => {
    // 出典: https://manual.sakura.ad.jp/cloud/apprun-dedicated/getting_started.html（更新 2026-04-21）の
    // 「サービスプリンシパルの設定」1つ目の手順の「サービスプリンシパル」の href（2026-10-06 に原本の HTML で確認）。
    expect(SERVICE_PRINCIPALS_URL).toBe('https://secure.sakura.ad.jp/cloud/?#/service-principals')
    for (const [cands, value] of [[[], ''], [[A], ID_A], [[A, B], ID_A]] as const) {
      const html = render([...cands], value)
      expect(html).toContain(`href="${SERVICE_PRINCIPALS_URL}"`)
      expect(html).toContain('新しく作る')
    }
  })

  it('開き方は、この画面のほかの外部リンクと同じ（`<a href>` だけ。target も onClick も付けない）', () => {
    const src = readFileSync(join(__dirname, '..', 'src/renderer/components/ServicePrincipalPicker.tsx'), 'utf-8')
    const at = src.indexOf('<a\n        href={SERVICE_PRINCIPALS_URL}')
    expect(at).toBeGreaterThan(0)
    const tag = src.slice(at, src.indexOf('>＋ 新しく作る', at))
    expect(tag).not.toContain('target=')
    expect(tag).not.toContain('onClick')
    expect(tag).not.toContain('rel=')
  })
})

describe('候補が0: 欄はいまと同じ（一覧も「入れました」も出さない）。リンクと、別のアカウント・プロジェクトの注意は出す', () => {
  it('ラジオも「入れました」も出ない', () => {
    const html = render([], '')
    expect(radios(html)).toHaveLength(0)
    expect(html).not.toContain('入れました')
    expect(html).not.toContain('前のプロジェクト')
  })

  it('★ 「どの場合も」一言添える（仕様の文字どおりの読み）: 0件でも別のアカウント・別のプロジェクトの ID は使えない、の注意が出る', () => {
    for (const value of ['', '999999999999']) {
      const html = render([], value)
      expect(html).toContain(ACCOUNT_MISMATCH_NOTE)
      expect(html).toContain('別のさくらのアカウント、または別のプロジェクトで作った ID は使えません')
    }
  })
})

describe('候補が1つ: 欄に入れた旨を添える', () => {
  it('欄がその ID のとき: 前のプロジェクト名つきの一文と、アカウントの注意。ラジオは出さない', () => {
    const html = render([A], ID_A)
    expect(html).toContain('前のプロジェクト（Landingtest）で使った ID を入れました。違うときは書き換えてください。')
    expect(html).toContain('別のさくらのアカウント、または別のプロジェクトで作った ID は使えません')
    expect(radios(html)).toHaveLength(0)
  })

  it('利用者が書き換えたあとは「入れました」を消す（もう正しくない）が、アカウントの注意は残る', () => {
    const html = render([A], '999999999999')
    expect(html).not.toContain('入れました')
    expect(html).toContain('別のさくらのアカウント、または別のプロジェクトで作った ID は使えません')
  })

  it('欄が空のときも「入れました」とは言わない（入っていないのに入れたと言わない）', () => {
    expect(render([A], '')).not.toContain('入れました')
  })
})

describe('候補が複数: ID とプロジェクト名を並べて選べる', () => {
  it('候補ごとのラジオ（ID とプロジェクト名つき）と「別の ID を入力する」。既定の欄＝先頭の候補が選ばれている', () => {
    const html = render([A, B], ID_A)
    expect(radios(html)).toHaveLength(3)
    expect(html).toContain(ID_A)
    expect(html).toContain(ID_B)
    expect(html).toContain('Landingtest')
    expect(html).toContain('blog・shop')
    expect(html).toContain('別の ID を入力する')
    expect(html).toContain('別のさくらのアカウント、または別のプロジェクトで作った ID は使えません')
    // 選ばれているのは1つだけ。それは A（欄の値と同じ候補）
    const checked = checkedRadios(html)
    expect(checked).toHaveLength(1)
    // A のラジオの次に A の ID の <code> が来る並びで、A の側にだけ checked が付く
    const aAt = html.indexOf(ID_A)
    const firstRadioAt = html.indexOf('type="radio"')
    expect(firstRadioAt).toBeLessThan(aAt)
    expect(radios(html)[0]).toMatch(/\schecked(=|\s|>)/)
  })

  it('別の候補が欄に入っていれば、その候補が選ばれる', () => {
    const html = render([A, B], ID_B)
    expect(checkedRadios(html)).toHaveLength(1)
    expect(radios(html)[1]).toMatch(/\schecked(=|\s|>)/)
    expect(radios(html)[0]).not.toMatch(/\schecked(=|\s|>)/)
  })

  it('欄がどの候補でもない（空・手で入力中）なら「別の ID を入力する」が選ばれる', () => {
    for (const value of ['', '   ', '999999999999', '12345']) {
      const html = render([A, B], value)
      const rs = radios(html)
      expect(checkedRadios(html)).toHaveLength(1)
      expect(rs[2]).toMatch(/\schecked(=|\s|>)/)
    }
  })

  it('「いちばん最近更新された記録」の印は先頭の候補だけに付く（根拠はファイルの更新時刻。「いちばん新しい ID」とは言わない）', () => {
    const html = render([A, B], ID_A)
    expect((html.match(/いちばん最近更新された記録/g) ?? []).length).toBe(1)
    expect(html.indexOf('いちばん最近更新された記録')).toBeLessThan(html.indexOf(ID_B))
    // 直す前の言い方（ID の新しさと読める）へ戻っていない
    expect(html).not.toContain('いちばん新しい記録')
    expect(html).not.toContain('いちばん新しい')
  })

  it('更新時刻が分からない先頭の候補には、その印を付けない（根拠が無いのに「最近更新」と言わない）', () => {
    const html = render([{ ...A, updatedAtMs: null }, B], ID_A)
    expect(html).not.toContain('いちばん最近更新された記録')
  })

  it('ラジオは同じグループ名でまとまり、画面に複数あっても他と混ざらない（useId）', () => {
    const html = render([A, B], ID_A)
    const names = new Set(radios(html).map(r => /name="([^"]+)"/.exec(r)?.[1]))
    expect(names.size).toBe(1)
  })
})

describe('配線（描いただけでは見えないところ）', () => {
  const src = readFileSync(join(__dirname, '..', 'src/renderer/components/ServicePrincipalPicker.tsx'), 'utf-8')

  it('候補を選ぶと onPick(その ID)、「別の ID を入力する」を選ぶと onPickManual()', () => {
    expect(src).toContain('onChange={() => onPick(c.id)}')
    expect(src).toContain('onChange={() => onPickManual()}')
  })

  it('状態も書き込みも持たない（見た目だけ。保存は ServicePrincipalSection.tsx の useServicePrincipal の saveResourceId が行う）', () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/useState|useEffect|saveMeta|mergeProjectMeta|writeFile|electronAPI/)
  })
})

// ── 部品の守り（構文木）: 保存へ通じる口（onPick・onPickManual）を、マウント時・描画中に呼ばない（2026-10-07 検分の指摘）──
// 「画面を開いただけでは .sakuraide.json を書かない」は、tests/servicePrincipalPanelWiring.test.ts がパネル本体の
// 構文木で固定している。だが、保存へ通じる口 onPick は props でこの部品へ渡されている。パネルが onPick を
// useEffect などから呼ばなくても、**この部品の中で**マウント時（useEffect / useLayoutEffect / useInsertionEffect・
// ref コールバック）や描画中に呼べば、開いただけで保存が走る（そのとき保存の入口は「欄を離れた」でも「候補を選んだ」でもない）。
// パネルの検査はこの退行を見られないので、部品の側で、構文木で「ユーザーの操作（onChange / onClick）の中でだけ呼ぶ」を固定する。
describe('部品の守り: onPick・onPickManual は、ユーザーの操作（onChange / onClick）の中でだけ呼ぶ（開いただけでは保存の口を呼ばない）', () => {
  const file = join(__dirname, '..', 'src/renderer/components/ServicePrincipalPicker.tsx')
  const src = readFileSync(file, 'utf-8')
  const sf = ts.createSourceFile('ServicePrincipalPicker.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  function walk(node: ts.Node, f: (n: ts.Node) => void) { f(node); ts.forEachChild(node, c => walk(c, f)) }

  /** 呼び出し（callee がその名前）の一覧 */
  const callsTo = (name: string): ts.CallExpression[] => {
    const out: ts.CallExpression[] = []
    walk(sf, n => { if (ts.isCallExpression(n) && n.expression.getText(sf) === name) out.push(n) })
    return out
  }
  /** `use…`（React のフック）の呼び出しの名前。`React.useEffect` のような書き方も拾う。 */
  const hookCalls = (): string[] => {
    const out: string[] = []
    walk(sf, n => {
      if (!ts.isCallExpression(n)) return
      const callee = n.expression.getText(sf)
      if (/^(React\.)?use[A-Z]\w*$/.test(callee)) out.push(callee)
    })
    return out
  }
  /**
   * その呼び出しを直接かこむ関数が、`onChange={…}` か `onClick={…}` の属性の値（イベントハンドラ）か。
   * 属性の式がそのまま呼び出し（`onChange={onPick(c.id)}`＝描画中に呼ぶ形）や、useEffect の関数・ref コールバックの中の
   * 呼び出しは、ここで false になる。
   */
  const insideUserHandler = (call: ts.Node, file: ts.SourceFile = sf): boolean => {
    for (let n: ts.Node | undefined = call.parent; n; n = n.parent) {
      if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)) {
        const jsx = n.parent
        if (!jsx || !ts.isJsxExpression(jsx)) return false
        const attr = jsx.parent
        return !!attr && ts.isJsxAttribute(attr) && ['onChange', 'onClick'].includes(attr.name.getText(file))
      }
    }
    return false // 関数の外＝描画中
  }

  it('構文木が空振りしていない: onPick・onPickManual の呼び出しがそれぞれ1つずつ見つかる', () => {
    expect(callsTo('onPick')).toHaveLength(1)
    expect(callsTo('onPickManual')).toHaveLength(1)
  })

  it('★★ (a) この部品は use*Effect（useEffect・useLayoutEffect・useInsertionEffect）・useRef・ref= を使わない。フックは useId だけ', () => {
    // マウント時に走る道具を、そもそも持たない（持たなければ、マウント時に onPick を呼びようがない）
    expect(hookCalls()).toEqual(['useId'])
    const refAttrs: string[] = []
    walk(sf, n => { if (ts.isJsxAttribute(n) && n.name.getText(sf) === 'ref') refAttrs.push(n.getText(sf)) })
    expect(refAttrs).toEqual([])
    // react からの import も useId だけ（useRef などを別名で取り込む道を塞ぐ）
    const reactImports: string[] = []
    walk(sf, n => {
      if (ts.isImportDeclaration(n) && n.moduleSpecifier.getText(sf).slice(1, -1) === 'react') {
        reactImports.push(n.importClause?.getText(sf) ?? '')
      }
    })
    expect(reactImports).toEqual(['{ useId }'])
  })

  it('★★ (b) onPick( の呼び出しは、onChange / onClick のハンドラ（関数）の中だけ。描画中・effect・ref コールバックの中では呼ばない', () => {
    for (const name of ['onPick', 'onPickManual']) {
      for (const call of callsTo(name)) {
        const line = sf.getLineAndCharacterOfPosition(call.getStart(sf)).line + 1
        expect(insideUserHandler(call), `${name}( の呼び出し（${line} 行）が、onChange / onClick のハンドラの外にある`).toBe(true)
      }
    }
  })

  it('★ onPick・onPickManual を「呼ばずに」別の場所へ渡さない（useEffect(onPick)・setTimeout(onPick)・.then(onPick) のような、マウント時に走る道を作らない）', () => {
    const refs: string[] = []
    walk(sf, n => {
      if (!ts.isIdentifier(n) || !['onPick', 'onPickManual'].includes(n.text)) return
      const p = n.parent
      const isDeclaration = ts.isPropertySignature(p) || ts.isBindingElement(p) // props の型と、引数の分割代入
      const isCallee = ts.isCallExpression(p) && p.expression === n
      if (!isDeclaration && !isCallee) refs.push(`${n.text}（${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} 行）: ${p.getText(sf).slice(0, 40)}`)
    })
    expect(refs).toEqual([])
  })

  it('自己点検: 検査の道具が本当に退行を見つける（マウント時・描画中の呼び出しを含む合成ソースで落ちる）', () => {
    // 上の `insideUserHandler`（本物の検査と同じ関数）を、悪い形の合成ソースに当てて、見逃さないことを確かめる。
    const bad = [
      "useLayoutEffect(() => { onPick('1') }, [])",
      "useEffect(() => { onPick('1') })",
      "useInsertionEffect(() => { onPick('1') })",
      "const x = onPick('1')",
      "<div ref={el => onPick('1')} />",
      "<input onChange={onPick('1')} />",
      "<input onFocus={() => onPick('1')} />",
    ]
    const good = ["<input onChange={() => onPick('1')} />", "<button onClick={() => { onPick('1') }} />"]
    const judge = (code: string): boolean => {
      const f = ts.createSourceFile('x.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      let call: ts.Node | undefined
      const visit = (n: ts.Node) => { if (ts.isCallExpression(n) && n.expression.getText(f) === 'onPick') call = n; ts.forEachChild(n, visit) }
      visit(f)
      expect(call, code).toBeDefined()
      return insideUserHandler(call!, f)
    }
    for (const code of bad) expect(judge(code), code).toBe(false)
    for (const code of good) expect(judge(code), code).toBe(true)
  })
})
