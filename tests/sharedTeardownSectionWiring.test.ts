import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 段階2（2c）: 【公開】(AppRunPanel) の 🗑（S1・S2）の「つなぎ方」の見張り（ソースの文字列を読む。振る舞いは tests/sharedTeardownSection*.test.ts が固定する）──────
// 設計書: docs/teardown-unify-plan.md の 10.7.9（S1・S2）・10.7.12 の F（2d で tests/sharedTeardownEntries.test.ts に広げる。ここはその先取り）・10.7.13 の 4・11・15。
//
// 振る舞いでは見えないことだけを、コメントを除いた本文で見張る:
//   ・2つの 🗑（S1 手順6・S2 期限切れのバナー）が、同じ doTeardown を呼ぶ。押せる条件は変えていない
//   ・doTeardown は doApply の直後の今の場所にあり、最初の文が setOpKind('破棄')（doApply の範囲を切り出す4本のテストの終端の目印）
//   ・AppRunPanel は直す前の形（自前の確認・IPC・記録消し・レジストリの選択）を持たず、流れは SharedTeardownSection の1か所から呼ぶ
//   ・新しいファイルは400行以下。AppRunPanel は破棄の節の分だけ短くなった
// 当て先が他の行にも出ないか: 数えるのは「コメントを除いた本文」。見張りが効く対象の実在を、各テストが先に確かめる。

const ROOT = path.join(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
/** コメントを除く（行番号がずれないよう改行は残す）。文字列の中の `//`（https://…）は直前が空白でないので消えない。 */
function stripComments(text: string): string {
  return text
    .replace(/(?<![^\s({[,;])\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ''))
    .replace(/(^|\s)\/\/[^\n]*/g, (_m, lead: string) => lead)
}
const code = (rel: string) => stripComments(read(rel))

const PANEL = 'src/renderer/components/AppRunPanel.tsx'
const SECTION = 'src/renderer/components/SharedTeardownSection.tsx'
const ORIGINAL_PANEL_LINES = 2890 // 2c の前の AppRunPanel.tsx の行数

describe('S1・S2: 2つの 🗑 は同じ doTeardown を呼び、押せる条件は今のまま', () => {
  it('見張りの前提: 対象のファイルが実在する', () => {
    for (const f of [PANEL, SECTION]) expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true)
  })

  it('★★★ onClick={() => { void doTeardown() }} がちょうど2つ（S1・S2）。askTeardown は無い', () => {
    const c = code(PANEL)
    expect(c.match(/onClick=\{\(\) => \{ void doTeardown\(\) \}\}/g)).toHaveLength(2)
    expect(c).not.toContain('askTeardown')
  })

  it('★★ 押せる条件は変えていない: S1 は blocked || !keyReady、S2 は blocked', () => {
    const c = code(PANEL)
    expect(c).toMatch(/onClick=\{\(\) => \{ void doTeardown\(\) \}\}\s+disabled=\{blocked\}\s+className="flex-none bg-brand-red-fill/)
    expect(c).toMatch(/onClick=\{\(\) => \{ void doTeardown\(\) \}\}\s+disabled=\{blocked \|\| !keyReady\}/)
  })

  it('★★★ doTeardown は doApply の直後の今の場所にあり、最初の文が setOpKind(\'破棄\')、次に clearResults() と sharedTeardown.start()', () => {
    const c = read(PANEL)
    const at = c.indexOf('\n  const doTeardown = async () => {')
    expect(at, 'doTeardown が無い').toBeGreaterThan(0)
    expect(c.indexOf('const doApply = async (applyOpts:')).toBeLessThan(at)
    expect(c.slice(at, at + 400)).toMatch(/const doTeardown = async \(\) => \{\n    setOpKind\('破棄'\)\n    clearResults\(\)\n    await sharedTeardown\.start\(\)\n  \}/)
  })
})

describe('S1・S2: 直す前の形が戻っていない。流れを呼ぶのは SharedTeardownSection の1か所', () => {
  it.each([
    'cloud.teardown(', 'clearAppRunPublishRecord', 'clearPublishRecord', "kind: 'teardown'", '環境を破棄します', '理解した上で破棄する',
    'effectiveDeleteRegistry', 'setDeleteRegistry', 'deleteRegistry', 'registryAdopted', 'teardownRemainingWarnings', 'teardownTargets', 'onTeardown',
  ])('AppRunPanel に %s が無い', (old) => {
    expect(code(PANEL)).not.toContain(old)
  })

  it('★★★ AppRunPanel は流れ（runTeardownFlow）も仕様書（sharedTeardownSpec）も直接は持たない。useSharedTeardown を1か所から呼ぶ', () => {
    const c = code(PANEL)
    for (const w of ['runTeardownFlow', 'electronFlowDeps', 'sharedTeardownSpec', '.invoke(']) expect(c, w).not.toContain(w)
    expect(c.match(/useSharedTeardown\(projectDir, \{/g)).toHaveLength(1)
    expect(c).toContain("import { useSharedTeardown, SharedTeardownResultView } from './SharedTeardownSection'")
  })

  it('★★★ SharedTeardownSection は runTeardownFlow(projectDir, sharedTeardownSpec, electronFlowDeps(projectDir, sharedTeardownSpec, { を1回だけ呼び、仕様書の invoke・loadAuth・readRecord は直接呼ばない', () => {
    const c = code(SECTION)
    expect(c.match(/runTeardownFlow\(projectDir, sharedTeardownSpec, electronFlowDeps\(projectDir, sharedTeardownSpec, \{/g)).toHaveLength(1)
    expect(c).not.toContain('.invoke(')
    expect(c).not.toMatch(/[sS]pec\.(?:invoke|loadAuth|readRecord)\s*\(/)
    // 確認のあと（やめたときは呼ばれない）だけ画面へ知らせる
    expect(c).toContain('onStart: () => { began = { since: panelRef.current.onStart() } },')
    expect(c).toContain('keyMissingMessage: SHARED_KEY_MISSING_MESSAGE,')
  })

  it('★★★ 公開の記録（📡 の行）に、画面のどちらも触れない（消すのは main の cloud:teardown の1か所）', () => {
    for (const f of [PANEL, SECTION]) {
      const c = code(f)
      for (const w of ['clearPublishRecord', 'forgetPublishTarget', 'publishMeta.', 'forgetTarget']) expect(c, `${f} に ${w}`).not.toContain(w)
    }
  })

  it('★★ 確認の要素は本体の描画の {confirmElement} の隣に1つ（早期 return の枝には描かない）', () => {
    const c = code(PANEL)
    expect(c.match(/\{sharedTeardown\.confirmElement\}/g)).toHaveLength(1)
    expect(c).toMatch(/\{confirmElement\}\n\s+\{sharedTeardown\.confirmElement\}\n\s+<\/div>/)
  })
})

describe('S1・S2: 結果は共通の結果欄で描く（その場も、開き直した記録も）', () => {
  it('★★ opResultFromRecord は削除の記録に teardownView を足し、OpResultView は teardownView があれば SharedTeardownResultView で描く', () => {
    const c = code(PANEL)
    expect(c).toContain("if (rec.op === '削除') out.teardownView = resumedTeardownView('sakura-apprun', r)")
    expect(c).toMatch(/if \(result\.teardownView\) \{[\s\S]*?<SharedTeardownResultView view=\{result\.teardownView\} \/>/)
    expect(c).toContain("setOpResult({ ok: view.ok, kind: '破棄', teardownView: view })")
  })

  it('★★ 終わった回の取り直しと実行中の印は、画面が持つ（始まった回だけ。前のプロジェクトのものには出さない）', () => {
    const c = code(PANEL)
    expect(c).toContain('onStart: () => beginLiveOp(),')
    expect(c).toContain('if (stale) return')
    expect(c).toContain('if (!stale) await markLiveOpShown(projectDir, began.since)')
  })
})

describe('S1・S2: 手順6の注記（T046）は2文目だけ。専有型のテストが見る位置と文は変えない', () => {
  it('★★ 「公開する」は事前チェックを…の1文目が無く、「破棄する」はデータの保存場所も含めて削除する場合があります。だけが残る', () => {
    const c = read(PANEL)
    expect(c).not.toContain('「公開する」は事前チェックを表示して確認してから実行します。')
    expect(c).toContain('「破棄する」はデータの保存場所も含めて削除する場合があります。')
    // 公開ボタンの文字から1,400字以内（apprunDedicatedWiring.test.ts が同じ位置を見る）
    const btn = c.indexOf('>{publishButtonLabel(published)}</button>')
    expect(btn).toBeGreaterThan(0)
    const note = c.indexOf('「破棄する」はデータの保存場所も含めて削除する場合があります。', btn)
    expect(note - btn).toBeGreaterThan(0)
    expect(note - btn).toBeLessThan(1400)
    expect(c.indexOf('{ephemeralDataNote()}', btn) - btn).toBeLessThan(1400)
  })
})

describe('S1・S2: 新しいファイルは400行以下。AppRunPanel は破棄の節の分だけ短くなった', () => {
  const lines = (rel: string) => read(rel).split('\n').length
  it.each([
    SECTION, 'tests/appRunPanelRt.ts', 'tests/sharedSectionHarness.ts', 'tests/sharedTeardownSection.test.ts',
    'tests/sharedTeardownSectionStates.test.ts', 'tests/sharedTeardownSectionWiring.test.ts',
  ])('%s は400行以下', (rel) => {
    expect(lines(rel)).toBeLessThanOrEqual(400)
  })

  it('★ AppRunPanel.tsx は、2c の前（2,890 行）より短い。確認の枝・IPC・記録消し・選択の state を SharedTeardownSection へ移した', () => {
    expect(lines(PANEL)).toBeLessThan(ORIGINAL_PANEL_LINES)
  })
})
