import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import * as ts from 'typescript'

// AppRun 専有型 手順2 「前のプロジェクトで使ったサービスプリンシパルID」の配線（2026-10-06・作者の決定）。
// 画面は electron に依存するため import できず、ソースを読んで確かめる（tests/apprunDedicatedWiring.test.ts と同じ流儀）。
// 当て先が他の行にも出ないよう、前後ごと書く。直す前の形は not.toContain で禁じる（掟10）。
// 判断そのもの（記録に ID があるときだけ出す・読むだけ・新しい順 等）は純関数の側で、
// tests/servicePrincipalCandidates.test.ts が振る舞いで固定している。
//
// 2026-10-07: 手順2の節（見出し・入力欄・(A)/(B)・説明）と、その節だけが使う状態・ハンドラ（欄の値・保存・候補・
// 保存失敗の知らせ・初期化）は、巨大ファイルの決まりで ServicePrincipalSection.tsx へ切り出した。
// 値の持ち主はそこの useServicePrincipal 1つで、パネルはフックを1回呼んで結果（sp）を受け取る。
// そこで構文木は**2つのファイル**（パネルと節）に当て、「呼び出し元は3つだけ」などの数え上げは両方を合わせて見る。
// toContain は持ち主のファイル1つへ（当て先を一意に）。not.toContain（直す前の形）は戻りうる両方（spAll）へ。

const root = join(__dirname, '..')
const panel = readFileSync(join(root, 'src/renderer/components/AppRunDedicatedPanel.tsx'), 'utf-8')
const spSection = readFileSync(join(root, 'src/renderer/components/ServicePrincipalSection.tsx'), 'utf-8')
const spAll = panel + '\n' + spSection
const readme = readFileSync(join(root, 'README.md'), 'utf-8')
const guide = readFileSync(join(root, 'docs/usage-guide.html'), 'utf-8')
// JSX の文章は途中で改行・字下げが入るので、比べるときは改行と字下げを詰めた形でも見る。
const flat = (src: string) => src.replace(/\n\s*/g, '')
const panelFlat = flat(panel)
const spSectionFlat = flat(spSection)

// ── 構文木（コメントや文字列の中の語に惑わされず、「どこから呼ばれているか」を見る）──────────────
function analyze(fileName: string, src: string) {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  function walk(node: ts.Node, f: (n: ts.Node) => void) { f(node); ts.forEachChild(node, c => walk(c, f)) }
  const isEffectCall = (n: ts.Node): n is ts.CallExpression =>
    ts.isCallExpression(n) && /^(React\.)?use(Layout|Insertion)?Effect$/.test(n.expression.getText(sf))
  const isFnInit = (init: ts.Expression | undefined) =>
    !!init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)
      || (ts.isCallExpression(init) && /^use(Callback|Memo)$/.test(init.expression.getText(sf))))
  /** その呼び出しを直接かこむもの。`jsx:onBlur`（属性）／`fn:名前`（const 名 = 関数）／`prop:名前`（{ 名前: 関数 }）／`effect`（useEffect の中）。 */
  function ownerOf(node: ts.Node): string {
    for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
      if (ts.isJsxAttribute(n)) return `jsx:${n.name.getText(sf)}`
      if (ts.isVariableDeclaration(n) && isFnInit(n.initializer)) return `fn:${n.name.getText(sf)}`
      if (ts.isPropertyAssignment(n)) return `prop:${n.name.getText(sf)}`
      if (isEffectCall(n)) return 'effect'
    }
    return 'top'
  }
  /**
   * ファイル全体で、callee がその名前の呼び出し。`sp.saveResourceId(...)` のように
   * 持ち物として呼ぶ形も数える（切り出しで素の名前だけを数えると、パネルの描画中の
   * `sp.saveResourceId(...)` を見逃す・2026-10-07 検分）。
   */
  function callsOf(name: string): ts.CallExpression[] {
    const out: ts.CallExpression[] = []
    walk(sf, n => {
      if (!ts.isCallExpression(n)) return
      const callee = n.expression.getText(sf)
      if (callee === name || callee.endsWith('.' + name) || callee.endsWith('?.' + name)) out.push(n)
    })
    return out
  }
  /** 全 useEffect / useLayoutEffect / useInsertionEffect の本体（先頭の引数）。 */
  function effectBodies(): { line: number; body: ts.Node }[] {
    const out: { line: number; body: ts.Node }[] = []
    walk(sf, n => {
      if (isEffectCall(n) && n.arguments[0]) out.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, body: n.arguments[0] })
    })
    return out
  }
  return { sf, walk, ownerOf, callsOf, effectBodies }
}
const panelAst = analyze('AppRunDedicatedPanel.tsx', panel)
const sectionAst = analyze('ServicePrincipalSection.tsx', spSection)

/** 初期化 useEffect の本体（プロジェクトが切り替わったときに走る）。節のフック（useServicePrincipal）の中にある。 */
function initBlock(): string {
  const at = spSection.indexOf('// 前のプロジェクトの候補を持ち越さない')
  expect(at).toBeGreaterThan(0)
  const end = spSection.indexOf('}, [projectDir])', at)
  expect(end).toBeGreaterThan(at)
  return spSection.slice(at, end)
}

describe('値の持ち主は1つだけ: 欄の値・保存・候補・保存失敗の知らせは useServicePrincipal（節）が持ち、パネルは受け取るだけ（掟10）', () => {
  it('パネルはフックを1回だけ呼び、resourceId・saveResourceId・idSaveWarning を受け取る。saveMeta をそのまま渡す（保存の口は増やさない）', () => {
    expect(panelAst.callsOf('useServicePrincipal')).toHaveLength(1)
    expect(panel).toContain('const sp = useServicePrincipal(projectDir, readMeta, saveMeta)')
    expect(panel).toContain('const { resourceId, saveResourceId, idSaveWarning } = sp')
    expect(panel).toContain("import ServicePrincipalSection, { CONTROL_PANEL_URL, useServicePrincipal } from './ServicePrincipalSection'")
  })

  it('★ resourceId の state は、パネルにも節のコンポーネントにも無い（フックの中の useState 1つだけ。写しを持たない）', () => {
    const stateDecls = (src: string) => src.match(/\[resourceId, setResourceId\] = useState\(/g) ?? []
    expect(stateDecls(panel)).toHaveLength(0)
    expect(stateDecls(spSection)).toHaveLength(1)
    // その1つは useServicePrincipal の中（コンポーネント本体 ServicePrincipalSection より前）
    expect(spSection.indexOf("const [resourceId, setResourceId] = useState('')")).toBeGreaterThan(spSection.indexOf('export function useServicePrincipal('))
    expect(spSection.indexOf("const [resourceId, setResourceId] = useState('')")).toBeLessThan(spSection.indexOf('export default function ServicePrincipalSection('))
    // 節のコンポーネントは、フックの結果（sp）を受け取って描くだけ（自分では state も effect も持たない）
    const comp = spSection.slice(spSection.indexOf('export default function ServicePrincipalSection('))
    expect(comp).not.toMatch(/useState|useEffect|useRef/)
  })

  it('パネルは、手順2に属する状態・ハンドラ（savedResourceIdRef・候補・保存失敗・pick…・saveResourceId の定義）を持たない', () => {
    for (const name of ['savedResourceIdRef', 'setSpCandidates', 'setIdSaveError', 'resourceInputRef', 'pickServicePrincipal', 'pickManualServicePrincipal']) {
      expect(panel, name).not.toContain(name)
    }
    expect(panel).not.toContain('const saveResourceId')
    expect(panel).not.toContain('const idSaveWarning')
  })
})

describe('手順2の初期化: 記録に ID が無いときだけ候補を探し、開いただけではファイルに書かない', () => {
  it('このプロジェクトの記録から読んだ savedId を、そのまま resolveServicePrincipalPrefill へ渡す（記録の ID を見て判断する）', () => {
    const b = initBlock()
    const savedAt = b.indexOf("const savedId = typeof v?.servicePrincipalId === 'string' ? v.servicePrincipalId : ''")
    const callAt = b.indexOf('const plan = await resolveServicePrincipalPrefill(projectDir, savedId)')
    expect(savedAt).toBeGreaterThan(-1)
    expect(callAt).toBeGreaterThan(savedAt)
    // 直接 ID を探す形（記録を見ずに常に探す）へ戻っていない。パネルは候補の取得に関わらない（節のフックだけ）
    expect(spAll).not.toContain('loadServicePrincipalCandidates(')
    expect(spAll).not.toContain("resolveServicePrincipalPrefill(projectDir, '')")
    expect(panel).not.toContain('resolveServicePrincipalPrefill')
  })

  it('★★ 開いただけでは何も書かない: 初期化の中に保存の呼び出し（saveMeta・saveResourceId・mergeProjectMeta・候補を選ぶ処理）が無い', () => {
    const b = initBlock()
    expect(b).not.toContain('saveMeta(')
    expect(b).not.toContain('saveResourceId(')
    expect(b).not.toContain('mergeProjectMeta(')
    expect(b).not.toContain('pickServicePrincipal')
    expect(b).not.toContain('writeFile')
    expect(b).not.toContain('sakura-meta-changed')
  })

  it('初期化の中に、記録へ書く口（electronAPI.publishMeta・forgetTarget・consent の保存）そのものが無い（直接書く退行も見逃さない）', () => {
    const b = initBlock()
    expect(b).not.toContain('publishMeta')
    expect(b).not.toContain('giveConsent')
    expect(b).not.toContain('revokeConsent')
    expect(b).not.toContain('forgetPublishTargetRecord')
    expect(b).not.toContain('clearPublishRecord')
  })

  it('★★ どの useEffect / useLayoutEffect / useInsertionEffect も（パネルも節も）、記録へ書く道具を呼ばない・参照しない（「resourceId が変わったら保存する」型の退行を禁じる）', () => {
    const FORBIDDEN = new Set([
      'saveResourceId', 'saveMeta', 'mergeProjectMeta', 'saveIfChanged', 'saveAndReport', 'pickServicePrincipal',
      'giveConsent', 'revokeConsent', 'clearPublishRecord', 'forgetPublishTargetRecord', 'dismissInterruptedPublish',
      'publishMeta', 'writeFile',
    ])
    // 構文木が空振りしていない（effect を数え損ねていない）。パネルは10本以上、節は初期化の1本
    const panelEffects = panelAst.effectBodies()
    const sectionEffects = sectionAst.effectBodies()
    expect(panelEffects.length).toBeGreaterThanOrEqual(8)
    expect(sectionEffects).toHaveLength(1)
    const hits: string[] = []
    for (const [file, ast, effects] of [['パネル', panelAst, panelEffects], ['節', sectionAst, sectionEffects]] as const) {
      for (const e of effects) {
        ast.walk(e.body, n => { if (ts.isIdentifier(n) && FORBIDDEN.has(n.text)) hits.push(`${file} 行${e.line}: ${n.text}`) })
      }
    }
    expect(hits).toEqual([])
  })

  it('★★ saveResourceId の呼び出し元は3つだけ: 欄の onBlur・候補を選ぶ pickServicePrincipal（どちらも節）・手順5の create コールバック（パネル）。4つ目を足すと落ちる', () => {
    expect(sectionAst.callsOf('saveResourceId').map(sectionAst.ownerOf).sort()).toEqual(['fn:pickServicePrincipal', 'jsx:onBlur'])
    expect(panelAst.callsOf('saveResourceId').map(panelAst.ownerOf).sort()).toEqual(['prop:create'])
    // 選ぶ口もパネル側からは呼ばない（sp.pickServicePrincipal(...) の形も数える）
    expect(panelAst.callsOf('pickServicePrincipal')).toEqual([])
    // 受け渡し onEdit の節側: 入力欄を打ったら「触った」をパネルへ知らせる（手順5の足りないものの出し方が保たれる）
    expect(spSection).toContain('onChange={e => { setResourceId(e.target.value); onEdit() }}')
  })

  it('★★ servicePrincipalId を記録へ書く口は1つだけ（節の saveResourceId の中の saveMeta）。mergeProjectMeta を呼ぶのはパネルの saveMeta の中だけ', () => {
    const spWrites = (ast: ReturnType<typeof analyze>) =>
      ast.callsOf('saveMeta').filter(c => c.arguments[0]?.getText(ast.sf).includes('servicePrincipalId')).map(ast.ownerOf)
    expect(spWrites(sectionAst)).toEqual(['fn:saveResourceId'])
    expect(spWrites(panelAst)).toEqual([]) // パネルは servicePrincipalId を自分では書かない（saveMeta を節のフックへ渡すだけ）
    expect(panelAst.callsOf('mergeProjectMeta').map(panelAst.ownerOf)).toEqual(['fn:saveMeta'])
    expect(sectionAst.callsOf('mergeProjectMeta')).toEqual([])
    // 画面は main の記録の口（publishMeta）を直接呼ばない（差分だけを渡す mergeProjectMeta を必ず通す）
    for (const ast of [panelAst, sectionAst]) {
      let publishMetaRefs = 0
      ast.walk(ast.sf, n => { if (ts.isIdentifier(n) && n.text === 'publishMeta') publishMetaRefs++ })
      expect(publishMetaRefs).toBe(0)
    }
  })

  it('候補を欄へ入れるのは「空のときだけ」（読んでいる間に打ち始めた入力を消さない）', () => {
    expect(initBlock()).toContain('if (fillId) setResourceId(cur => (cur.trim() ? cur : fillId))')
  })

  it('プロジェクトが切り替わったら、前のプロジェクトの候補・読み取りの結果を使わない（掟11: 環境の独立）', () => {
    const b = initBlock()
    // 切り替えの最初に候補を空へ戻す
    expect(b.indexOf('setSpCandidates([])')).toBeGreaterThanOrEqual(0)
    expect(b.indexOf('setSpCandidates([])')).toBeLessThan(b.indexOf('let cancelled = false'))
    // 保存失敗の知らせ（別のプロジェクトの失敗）も、切り替えの最初に消す
    expect(b.indexOf('setIdSaveError(null)')).toBeGreaterThanOrEqual(0)
    expect(b.indexOf('setIdSaveError(null)')).toBeLessThan(b.indexOf('let cancelled = false'))
    // 非同期の各 await の直後で、切り替わっていたら抜ける（記録の読み取りのあとと、候補の読み取りのあと）
    expect((b.match(/if \(cancelled\) return/g) ?? []).length).toBe(2)
    expect(b.indexOf('if (cancelled) return')).toBeLessThan(b.indexOf('const savedId ='))
    const callAt = b.indexOf('await resolveServicePrincipalPrefill(projectDir, savedId)')
    expect(b.indexOf('if (cancelled) return', callAt)).toBeLessThan(b.indexOf('setSpCandidates(plan.candidates)'))
    expect(b).toContain('return () => { cancelled = true }')
  })

  it('パネル自身の初期化（同意日時の読み取り）は、手順2の欄・候補を触らない（手順2の初期化は節のフックの1か所だけ）', () => {
    const at = panel.indexOf('// （手順2の欄の値・候補・保存失敗の知らせの初期化は useServicePrincipal の中の useEffect が、同じ [projectDir] で行う。）')
    expect(at).toBeGreaterThan(0)
    const end = panel.indexOf('}, [projectDir])', at)
    expect(end).toBeGreaterThan(at)
    const b = panel.slice(at, end)
    expect(b).toContain('setConsentedAt(')
    for (const name of ['setResourceId', 'setSpCandidates', 'setIdSaveError', 'savedResourceId', 'resolveServicePrincipalPrefill']) {
      expect(b, name).not.toContain(name)
    }
  })
})

describe('手順2の保存: 欄を離れたとき・候補を選んだとき・手順5で作るとき（どれも既存の saveResourceId を通す）', () => {
  it('欄を離れたときの保存は従来どおり（saveResourceId）', () => {
    expect(spSection).toContain('onBlur={() => saveResourceId(resourceId.trim())}')
  })

  it('候補を選んだら、欄へ入れて saveResourceId で保存する（欄へ入れる→保存の順）', () => {
    const at = spSection.indexOf('const pickServicePrincipal = async (id: string) => {')
    expect(at).toBeGreaterThan(0)
    const block = spSection.slice(at, spSection.indexOf('}', spSection.indexOf('await saveResourceId(id)', at)) + 1)
    expect(block.indexOf('setResourceId(id)')).toBeGreaterThan(-1)
    expect(block.indexOf('await saveResourceId(id)')).toBeGreaterThan(block.indexOf('setResourceId(id)'))
  })

  it('「別の ID を入力する」: 欄を空にして入力へ進める（保存はしない。離れたときの保存に任せる）', () => {
    const at = spSection.indexOf('const pickManualServicePrincipal = () => {')
    expect(at).toBeGreaterThan(0)
    const block = spSection.slice(at, spSection.indexOf('\n  }\n', at))
    expect(block).toContain("setResourceId('')")
    expect(block).toContain('resourceInputRef.current?.focus()')
    expect(block).not.toContain('saveResourceId')
    expect(spSection).toContain('ref={resourceInputRef}')
  })

  it('★★ 手順5の作成の入口: 認証の確認のあと、作成の IPC を呼ぶ前に、同じ saveResourceId で保存する。記録できなくても作成は止めない（失敗は saveResourceId が画面に出す）', () => {
    const at = panel.indexOf('create: async (s, opts) => {')
    expect(at).toBeGreaterThan(0)
    const end = panel.indexOf('opts)\n          },', at)
    expect(end).toBeGreaterThan(at)
    const block = panel.slice(at, end)
    const authAt = block.indexOf('if (!auth || !auth.token || !auth.secret) {')
    const saveAt = block.indexOf('await saveResourceId(s.servicePrincipalID)')
    const createAt = block.indexOf('return window.electronAPI.apprunDedicated.create(projectDir, auth, s, ')
    expect(authAt).toBeGreaterThan(-1)
    expect(saveAt).toBeGreaterThan(authAt)
    expect(createAt).toBeGreaterThan(saveAt)
    // 直す前の形（認証の確認の直後にそのまま作成を呼ぶ＝記録に ID が残らない）へ戻っていない
    expect(panel).not.toContain("} as any\n            }\n            return window.electronAPI.apprunDedicated.create(projectDir, auth, s, opts)")
    // 失敗を黙って握りつぶす形（画面に出さない）へ戻っていない。saveResourceId は投げないので、ここに try は要らない
    expect(panel).not.toContain('try { await saveResourceId(s.servicePrincipalID) } catch')
    expect(block).not.toContain('catch')
  })

  it('保存の関数は1つだけ（候補・作成のための別の書き込み口を作っていない）。書く・書かない・戻す・離れたら何もしない、の判断は saveAndReport（→ saveIfChanged）', () => {
    const at = spSection.indexOf('const saveResourceId = async (v: string) => {')
    expect(at).toBeGreaterThan(0)
    expect((spSection.match(/const saveResourceId = /g) ?? []).length).toBe(1)
    const block = spSection.slice(at, spSection.indexOf('const idSaveWarning', at))
    expect(block).toContain('await saveAndReport(')
    expect(block).toContain('savedResourceIdRef, v, id => saveMeta({ servicePrincipalId: id }),')
    // 直す前の形（印を書く前に進めたまま・失敗しても戻さない）へ戻っていない
    expect(spAll).not.toContain('    savedResourceIdRef.current = v\n    await saveMeta({ servicePrincipalId: v })')
    expect(spAll).not.toContain('await saveMeta({ servicePrincipalId: v })')
    expect(spSection).toContain("import { saveAndReport } from '../../shared/saveIfChanged'")
    // パネルは saveIfChanged を直接使わない（判断の窓口は1つ）
    expect(panel).not.toContain("from '../../shared/saveIfChanged'")
  })

  it('★★ 保存の結果は saveAndReport の戻り値のまま画面へ: 切り替わっていなければ（stale でなければ）失敗を出す・成功なら消す。投げ直さない', () => {
    const at = spSection.indexOf('const saveResourceId = async (v: string) => {')
    const block = spSection.slice(at, spSection.indexOf('const idSaveWarning', at))
    const callAt = block.indexOf('await saveAndReport(')
    const setAt = block.indexOf('if (!r.stale) setIdSaveError(r.error)')
    expect(callAt).toBeGreaterThan(-1)
    expect(setAt).toBeGreaterThan(callAt)
    expect(block).not.toContain('throw')
    expect(block).not.toContain('catch')
    // 知らせの状態を変える口は2つだけ: 初期化の消去（effect）と、ここ（saveResourceId）。ここを通らずに出す経路が無い
    expect(sectionAst.callsOf('setIdSaveError').map(sectionAst.ownerOf).sort()).toEqual(['effect', 'fn:saveResourceId'])
    expect(panelAst.callsOf('setIdSaveError')).toEqual([])
    // 知らせは2か所: 手順2の欄（候補の部品）の下、手順5の「クラスタを作成する」ボタンの下
    expect((spSection.match(/\{idSaveWarning\}/g) ?? []).length).toBe(1)
    expect((panel.match(/\{idSaveWarning\}/g) ?? []).length).toBe(1)
    const first = spSection.indexOf('{idSaveWarning}')
    expect(first).toBeGreaterThan(spSection.indexOf('<ServicePrincipalPicker'))
    expect(first).toBeLessThan(spSection.indexOf('<summary className="cursor-pointer select-none text-xs font-semibold text-ink-secondary hover:text-ink">詳しい手順を見る</summary>'))
    expect(panel.indexOf('{idSaveWarning}')).toBeGreaterThan(panel.indexOf("'クラスタを作成する'}</button>"))
    // 選択・コピーできる文（掟5）
    expect(spSection).toContain('className="text-[11px] text-brand-yellow leading-relaxed select-text"')
  })

  it('★★ プロジェクトを切り替えたあとの保存の結果で、新しいプロジェクトの画面を汚さない（掟11）: 保存を始めたプロジェクトを覚え、いまのプロジェクトと違えば stale', () => {
    const at = spSection.indexOf('const saveResourceId = async (v: string) => {')
    const block = spSection.slice(at, spSection.indexOf('const idSaveWarning', at))
    // 始めたときのプロジェクトを、この呼び出しの中で1回だけ覚える（あとで読み直さない）
    expect(block).toContain('const startedIn = projectDir')
    // いまのプロジェクトは ref から読む（クロージャの projectDir は古いまま）。違えば stale
    expect(block).toContain('() => projectDirRef.current !== startedIn,')
    // ref は描くたびに最新のプロジェクトへ進める
    expect(spSection).toContain('const projectDirRef = useRef(projectDir)\n  projectDirRef.current = projectDir')
    // 判断（stale のとき知らせも印も触らない）は純関数 saveAndReport。画面は !r.stale のときだけ状態へ出す
    expect(block).toContain('if (!r.stale) setIdSaveError(r.error)')
  })
})

describe('手順2の画面: 部品へ渡す・形式の判定は共有の1つだけ', () => {
  it('ServicePrincipalPicker に候補・欄の値・選んだときの処理を渡している', () => {
    const at = spSection.indexOf('<ServicePrincipalPicker')
    expect(at).toBeGreaterThan(0)
    const tag = spSection.slice(at, spSection.indexOf('/>', at))
    expect(tag).toContain('candidates={spCandidates}')
    expect(tag).toContain('value={resourceId}')
    expect(tag).toContain('onPick={pickServicePrincipal}')
    expect(tag).toContain('onPickManual={pickManualServicePrincipal}')
    // 部品は手順2の入力欄のすぐ下（形式の表示のあと・「詳しい手順を見る」の前）
    expect(spSection.indexOf('⚠️ 違うようです（12桁の数字ではありません）')).toBeLessThan(at)
    expect(at).toBeLessThan(spSection.indexOf('<summary className="cursor-pointer select-none text-xs font-semibold text-ink-secondary hover:text-ink">詳しい手順を見る</summary>'))
    // パネルは Picker を直接使わない（節を通す）
    expect(panel).not.toContain('ServicePrincipalPicker')
  })

  it('resourceIdFormatOk は共有モジュールの1つだけ（画面に同じ判定を書き写さない）。画面の表示は「12桁の数字」', () => {
    expect(spSection).toContain("import { resourceIdFormatOk, type ServicePrincipalCandidate } from '../../shared/servicePrincipalCandidates'")
    expect(spAll).not.toContain('function resourceIdFormatOk')
    expect(spSection).toContain('const idFormat = resourceIdFormatOk(resourceId)')
    expect(spSection).toContain('✓ 形は合っています（12桁の数字）')
    // 直す前の言い方（長さだけ見て「12文字」）へ戻っていない
    expect(spAll).not.toContain('✓ 形は合っています（12文字）')
    expect(spAll).not.toContain('違うようです（12文字ではありません）')
  })

  it('★ 12桁の数字の定義はどこにも書き写さない（共有モジュールの1つだけ）。main の作成入口もそこから引く', () => {
    const files: string[] = []
    const scan = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) scan(full)
        else if (/\.(ts|tsx)$/.test(name)) files.push(full)
      }
    }
    scan(join(root, 'src'))
    const holders = files
      .filter(f => /\\d\{12\}/.test(readFileSync(f, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')))
      .map(f => f.slice(root.length + 1))
    expect(holders).toEqual(['src/shared/servicePrincipalCandidates.ts'])

    const apply = readFileSync(join(root, 'src/main/cloud/apprunDedicatedApply.ts'), 'utf-8')
    expect(apply).toContain("import { isServicePrincipalId } from '../../shared/servicePrincipalCandidates'")
    expect(apply).toContain("!isServicePrincipalId(spec.servicePrincipalID)")
    expect(apply).not.toContain('SERVICE_PRINCIPAL_ID_RE')
  })

  it('候補の取得は「読むだけ」の入口経由（画面から直接ワークスペースを歩かない・IPC を足していない）', () => {
    expect(spSection).toContain("import { resolveServicePrincipalPrefill } from '../servicePrincipalCandidates'")
    expect(spAll).not.toContain('electronAPI.fs.publishedRecords')
  })

  it('読むだけの3つの部品（共有の純関数・renderer の入口・見た目の部品）は、記録へ書く道具を使っていない', () => {
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    for (const f of ['src/shared/servicePrincipalCandidates.ts', 'src/renderer/servicePrincipalCandidates.ts', 'src/renderer/components/ServicePrincipalPicker.tsx']) {
      const code = strip(readFileSync(join(root, f), 'utf-8'))
      expect(code, f).not.toMatch(/mergeProjectMeta|saveMeta|writeFile|publishMeta\.merge|forgetTarget|fs\.write/)
    }
  })
})

describe('文言: 「最初の一度だけで済みます」を事実に合わせた（README・使い方ガイドも・掟9）', () => {
  // 使い回せることは、2026-10-07 の実測で裏づけられた（同じサービスプリンシパルで、2026-09-18 の Koto のプロジェクト CertTest と
  // 2026-09-29 の Tsukaisute に、専有型のクラスタを作れている。同時ではなく順番に）。1巡目で弱めた「使い回せる想定」を、裏づけつきで元の強さに戻した。
  // 「同時に2つのクラスタで使えるか」は未確認（docs/apprun-dedicated-plan.md に書き分けてある）ので、画面・README・ガイドは言い切らない。
  const STRONG_SCREEN = 'さくら側のサービスプリンシパルは使い回せます（さくらのクラウドの「プロジェクト」のリソースで、Koto のプロジェクトとは別のものです。同じものでクラスタを2回作れたことを確かめています）。前のプロジェクトで使った ID があれば、ここに入れておきます。'

  it('画面: 直す前の説明（プロジェクト共通のリソース／最初の一度だけで済みます）は戻さない。新しい説明がある', () => {
    expect(spAll).not.toContain('この手作業は最初の一度だけで済みます')
    expect(spAll).not.toContain('サービスプリンシパルはプロジェクト共通のリソースとして使い回せるので')
    expect(spSection).toContain('前のプロジェクトで使った ID があれば、ここに入れておきます。')
  })

  it('★ 使い回せることは実測で裏づけがあるので言い切る（「想定」「公式の文書に明記されていない」へ戻さない）。裏づけ（同じもので2回作れた）を添える', () => {
    expect(spSectionFlat).toContain(STRONG_SCREEN)
    // 弱めた言い方へ戻っていない（パネルにも節にも）
    expect(flat(spAll)).not.toContain('使い回せる想定')
    expect(flat(spAll)).not.toContain('公式の文書には、1つのサービスプリンシパルで複数のクラスタを作れるとまでは書かれていないので')
    expect(flat(spAll)).not.toContain('クラスタの作成でエラーになったときは、コントロールパネルで確かめてください')
    // 「確かめていない」と言っていた1巡目より前の、裏づけの無い断定（「使い回せるので最初の一度だけ」）とも違う
    expect(flat(spAll)).not.toContain('使い回せるので最初の一度だけ')
    // 言い切った文はパネルに書き写していない（手順2の文の持ち主は節の1つ）
    expect(panelFlat).not.toContain('使い回せます')
  })

  it('画面: 丸数字の見出しと、既定で見える1行の説明はいまのまま（実測で正しいと分かった）', () => {
    expect(spSection).toContain('手順2 サービスプリンシパルの用意（最初の一度だけ手作業）')
    expect(spSection).toContain('コントロールパネルで一度だけ作ります。作り方は「詳しい手順を見る」。')
  })

  it('README: 直す前の「最初の一度だけ」の言い方は戻さない。使い回せます（裏づけつき）・自動で入れる・選べる・新しく作る・別のアカウント／プロジェクトは使えない、がある', () => {
    expect(readme).not.toContain('手順2 サービスプリンシパルの用意（コントロールパネルでの手作業・最初の一度だけ）')
    expect(readme).not.toContain('さくら側は最初の一度だけ')
    const at = readme.indexOf('手順2 サービスプリンシパルの用意（コントロールパネルでの手作業。さくら側のサービスプリンシパルは、2つ目以降のプロジェクトでも使い回せます（同じものでクラスタを2回作れたことを確かめています）。')
    expect(at).toBeGreaterThan(0)
    const seg = readme.slice(at, readme.indexOf('手順3 使えるプランと制限', at))
    expect(seg).toContain('前のプロジェクトで使った ID を自動で入れます')
    expect(seg).toContain('複数あるときは一覧から選べ')
    expect(seg).toContain('「新しく作る」のリンク')
    expect(seg).toContain('別のさくらのアカウント、または別のプロジェクトで作った ID は使えません')
    expect(seg).not.toContain('別のさくらのアカウントで作った ID は使えません')
    // 弱めた言い方へ戻っていない
    expect(readme).not.toContain('使い回せる想定')
    expect(seg).not.toContain('1つのサービスプリンシパルで複数のクラスタを作れるとは公式の文書に明記されていない')
    expect(seg).not.toContain('クラスタの作成でエラーになったときは、コントロールパネルで確かめてください')
  })

  it('使い方ガイド: 手順2の ID の自動入力・選択・新しく作る・別のアカウントは使えない・記録のタイミングを説明している。使い回せます（裏づけつき）', () => {
    const at = guide.indexOf('<b>手順2 サービスプリンシパルの ID は、前のプロジェクトで使ったものを自動で入れます。</b>')
    expect(at).toBeGreaterThan(0)
    const seg = guide.slice(at, guide.indexOf('</p>', at))
    // 確かめていない断定（「最初の一度だけ」「作り直す必要はありません」）をしない
    expect(seg).not.toContain('さくら側で用意するのは最初の一度だけ')
    expect(seg).not.toContain('作り直す必要はありません')
    // 使い回せることは実測の裏づけつきで言い切る。弱めた言い方へ戻さない
    expect(seg).toContain('<b>さくら側のサービスプリンシパルは、同じものを使い回せます</b>（同じものでクラスタを2回作れたことを確かめています）。')
    expect(guide).not.toContain('同じものを使い回せる想定')
    expect(seg).not.toContain('1つのサービスプリンシパルで複数のクラスタを作れるとまでは書かれていません')
    expect(seg).not.toContain('クラスタの作成でエラーになったときは、さくらのコントロールパネルで確かめてください')
    expect(seg).toContain('「別の ID を入力する」も選べます')
    expect(seg).toContain('「新しく作る」')
    expect(seg).toContain('別のさくらのアカウント、または別のプロジェクトで作った ID は使えません')
    expect(seg).not.toContain('別のさくらのアカウントで作った ID は使えません')
    expect(seg).toContain('開いただけでは記録しません')
    // タグの対応（<p> の中で <b> が閉じている）
    expect((seg.match(/<b>/g) ?? []).length).toBe((seg.match(/<\/b>/g) ?? []).length)
  })

  it('計画書: 実測の確認（日付・プロジェクト名・順番に作った旨）と、同時に使えるかは未確認の書き分けがある', () => {
    const plan = readFileSync(join(root, 'docs/apprun-dedicated-plan.md'), 'utf-8')
    const at = plan.indexOf('2026-10-07 実測で確認:')
    expect(at).toBeGreaterThan(0)
    const seg = plan.slice(at, at + 700)
    expect(seg).toContain('同じサービスプリンシパルで 2026-09-18（Koto のプロジェクト CertTest）と 2026-09-29（Tsukaisute）にクラスタを作成できた（同時ではなく順番に）')
    expect(seg).toContain('同時に2つのクラスタで使えるかは未確認')
  })
})
