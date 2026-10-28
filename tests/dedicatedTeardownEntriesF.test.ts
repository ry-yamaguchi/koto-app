import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 段階3B（3B-7）F: 専有型の削除の「入口の網羅」の最終形（ソースの文字列を読む。振る舞いは別のテストが固定する）──────────────────
// 設計書: docs/teardown-unify-plan.md の 10.11.14 の F・10.11.9 の表・10.11.17 の完了条件 8・17。
// tests/sharedTeardownEntries.test.ts（共用型）・tests/hanamiiTeardownEntries.test.ts（HANAMII）と同じ作り。
//
// 入口は3つ:
//   D1 手順6「すべて削除する」               … components/DedicatedTeardownSection.tsx（フック useDedicatedPanelTeardown）
//   D2 📡 公開したもの一覧の行               … components/PublishedListModal.tsx（TeardownRow）→ teardown/useTeardownFlow.ts
//   D3 プロジェクトの削除                   … 流れは呼ばない（止める）。判断は teardown/projectDeletePlan.ts の projectDeleteBlockOf
// D1・D2 は runTeardownFlow（teardown/flow.ts）を通る。IPC（apprunDedicated:teardown）を呼ぶのは仕様書（teardown/targets/dedicated.ts）の invoke の1行だけ。
// 入口が仕様書の invoke を直接呼ぶと、確認の答え・窓を閉じる警告・キーなしの失敗を全部飛ばせるのに、緑のままになる（CLAUDE.md の調査のしかた②）。
//
// 当て先が他の行にも出ないか: 数えるのは「コメントを除いた本文」。見張りが効いていることは、各テストが対象の実在を先に確かめる。

const ROOT = path.join(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

/** コメントを除く（改行は残す）。文字列の中の `//`（https://…）は直前が空白でないので消えない。 */
function stripComments(text: string): string {
  return text
    .replace(/(?<![^\s({[,;])\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ''))
    .replace(/(^|\s)\/\/[^\n]*/g, (_m, lead: string) => lead)
}
const code = (rel: string) => stripComments(read(rel))

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${ent.name}`
    if (ent.isDirectory()) walk(rel, out)
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(rel)
  }
  return out.sort()
}
const SRC = walk('src')
const RENDERER = SRC.filter(f => f.startsWith('src/renderer/'))
const hits = (files: string[], needle: string | RegExp) =>
  files.filter(f => (typeof needle === 'string' ? code(f).includes(needle) : needle.test(code(f))))
const count = (rel: string, needle: string | RegExp) => {
  const c = code(rel)
  return typeof needle === 'string' ? c.split(needle).length - 1 : (c.match(new RegExp(needle.source, needle.flags.includes('g') ? needle.flags : `${needle.flags}g`)) ?? []).length
}
const lines = (rel: string) => read(rel).split('\n').length

/** import／export-from／動的 import／require の相手（コメントを除いた本文から）。 */
function importsOf(rel: string): string[] {
  const out: string[] = []
  const body = code(rel)
  for (const m of body.matchAll(/\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g)) out.push(m[1])
  for (const m of body.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) out.push(m[1])
  for (const m of body.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1])
  for (const m of body.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1])
  return out
}
/** そのファイルが import している、リポジトリ内のファイル（拡張子なしの絶対パス）。 */
const resolvedImports = (rel: string): string[] => importsOf(rel)
  .filter(s => s.startsWith('.'))
  .map(s => path.resolve(path.dirname(path.join(ROOT, rel)), s).replace(/\.(ts|tsx)$/, ''))
const abs = (rel: string) => path.join(ROOT, rel).replace(/\.(ts|tsx)$/, '')

const SPEC = 'src/renderer/teardown/targets/dedicated.ts'
const MAIN = 'src/main/ipc/apprunDedicatedTeardown.ts'
const MAIN_COMMON = 'src/main/ipc/apprunDedicatedCommon.ts'
const MAIN_ROOT = 'src/main/ipc/apprunDedicated.ts'
const PRELOAD = 'src/main/preload.ts'
const GLOBAL_DTS = 'src/renderer/global.d.ts'
const FLOW = 'src/renderer/teardown/flow.ts'
const D1 = 'src/renderer/components/DedicatedTeardownSection.tsx'
const PANEL = 'src/renderer/components/AppRunDedicatedPanel.tsx'
const D2 = 'src/renderer/components/PublishedListModal.tsx'
const D2_HOOK = 'src/renderer/teardown/useTeardownFlow.ts'
const D2_ROW = 'src/renderer/components/teardown/TeardownRow.tsx'
const CARD = 'src/renderer/components/PublishedInventoryCard.tsx'
const D3_PLAN = 'src/renderer/teardown/projectDeletePlan.ts'
const D3_RUN = 'src/renderer/teardown/projectDelete.ts'
const DIALOG = 'src/renderer/components/ProjectDeleteDialog.tsx'
const SIDEBAR = 'src/renderer/components/Sidebar.tsx'
const SHELL = 'src/main/cloud/teardownShell.ts'
const RESULT = 'src/shared/teardownResult.ts'

/** 3B-7 で消した手本の4ファイル。 */
const DELETED = [
  'src/renderer/dedicatedTeardownFlow.ts',
  'src/renderer/hooks/useDedicatedTeardown.ts',
  'src/renderer/components/DedicatedTeardownRow.tsx',
  'src/renderer/components/DedicatedTeardownView.tsx',
]

describe('F-1 専有型の削除の呼び口は1つずつ', () => {
  it('見張りの前提: 対象のファイルが実在する', () => {
    for (const f of [SPEC, MAIN, MAIN_COMMON, MAIN_ROOT, PRELOAD, GLOBAL_DTS, FLOW, D1, PANEL, D2, D2_HOOK, D2_ROW, CARD, D3_PLAN, D3_RUN, DIALOG, SHELL, RESULT]) {
      expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true)
    }
  })

  it('★★★ `electronAPI.apprunDedicated.teardown(` を呼ぶファイルは src 全体で targets/dedicated.ts だけ（1回）', () => {
    expect(hits(SRC, 'electronAPI.apprunDedicated.teardown(')).toEqual([SPEC])
    expect(count(SPEC, 'electronAPI.apprunDedicated.teardown(')).toBe(1)
  })

  it('★★★ その1行は projectDir・認証・{ confirmed: opts.confirmed, shownPlacements: opts.shownPlacements } を渡す（確認の答えをそのまま。true の決め打ちにしない。shownPlacements は確認で見せた保存場所の組。0.6.24 F）', () => {
    expect(code(SPEC)).toContain('window.electronAPI.apprunDedicated.teardown(projectDir, auth, { confirmed: opts.confirmed, shownPlacements: opts.shownPlacements })')
  })

  it('★★★ 進み具合の購読 `apprunDedicated.onTeardownProgress(` を呼ぶのも仕様書の1行だけ', () => {
    expect(hits(SRC, 'apprunDedicated.onTeardownProgress(')).toEqual([SPEC])
    expect(count(SPEC, 'apprunDedicated.onTeardownProgress(')).toBe(1)
  })

  it('★★ 別の書き方（apprunDedicated?.teardown・apprunDedicated["teardown"]・分割代入のあとの呼び出し）でも、専有型の削除と購読を呼ぶのは仕様書だけ', () => {
    expect(hits(RENDERER, /\bapprunDedicated\s*(?:\??\.\s*(?:teardown|onTeardownProgress)\b|\[\s*['"](?:teardown|onTeardownProgress)['"]\s*\])/)).toEqual([SPEC])
    expect(hits(RENDERER, /\{[^}]*\b(?:teardown|onTeardownProgress)\b[^}]*\}\s*=\s*(?:window\.)?electronAPI\.apprunDedicated\b/)).toEqual([])
  })

  it("★★ `ipcMain.handle('apprunDedicated:teardown'` を持つファイルは main/ipc/apprunDedicatedTeardown.ts だけ。`ipcRenderer.invoke(` は preload.ts だけ。進み具合の送り口もそれぞれ1つ", () => {
    expect(hits(SRC, /ipcMain\.handle\(\s*['"]apprunDedicated:teardown['"]/)).toEqual([MAIN])
    expect(hits(SRC, /ipcRenderer\.invoke\(\s*['"]apprunDedicated:teardown['"]/)).toEqual([PRELOAD])
    expect(hits(SRC, /event\.sender\.send\(\s*['"]apprunDedicated:teardown-progress['"]/)).toEqual([MAIN])
    expect(hits(SRC, /ipcRenderer\.on\(\s*['"]apprunDedicated:teardown-progress['"]/)).toEqual([PRELOAD])
    // 作成・公開を受け持つ ipc/apprunDedicated.ts は、削除のハンドラを持たず、登録を呼ぶだけ（循環させない向きは F-6）
    expect(code(MAIN_ROOT)).not.toMatch(/ipcMain\.handle\(\s*['"]apprunDedicated:teardown/)
    expect(code(MAIN_ROOT)).toContain('registerApprunDedicatedTeardownHandler()')
  })

  it('★★ 3点セット（main・preload・global.d.ts）が同じ形: opts は必須の { confirmed: boolean; shownPlacements }、結果に remainingBuckets・skippedBuckets を持つ', () => {
    const d = code(GLOBAL_DTS)
    expect(d).toContain('teardown(projectDir: string, auth: { token: string; secret: string }, opts: { confirmed: boolean; shownPlacements: Array<{ bucket: string; prefix: string }> }): Promise<{')
    expect(d).toContain('remainingBuckets?: string[]')
    expect(d).toContain('skippedBuckets?: string[]')
    expect(code(PRELOAD)).toContain('teardown: (projectDir: string, auth: { token: string; secret: string }, opts: { confirmed: boolean; shownPlacements: Array<{ bucket: string; prefix: string }> }) =>')
    expect(code(PRELOAD)).toContain("ipcRenderer.invoke('apprunDedicated:teardown', projectDir, auth, opts)")
    // opts が任意（`?`）の旧い形は、削除の口に残っていない（作成の `opts?: { confirmed?: boolean }` は別の口）
    expect(d).not.toMatch(/teardown\(projectDir: string, auth: \{[^)]*\}, opts\?:/)
  })
})

describe('F-2 仕様書の invoke を呼ぶのは flow.ts だけ（入口が直接呼ぶと、確認・窓を閉じる警告・キーなしの失敗を飛ばせる）', () => {
  it('★★★ src/renderer 全体（コメント除く）で `.invoke(` を含むファイルは flow.ts だけ', () => {
    expect(hits(RENDERER, '.invoke(')).toEqual([FLOW])
  })

  it.each([D1, D2, D2_HOOK, D2_ROW, D3_PLAN, D3_RUN, DIALOG, SIDEBAR, PANEL])('★★ %s は仕様書の invoke・loadAuth・readRecord を直接呼ばない（確認の答えを見ずに実行できる抜け道になる）', (rel) => {
    const c = code(rel)
    expect(c).not.toContain('.invoke(')
    expect(c).not.toMatch(/[sS]pec\.(?:invoke|loadAuth|readRecord)\s*\(/)
  })
})

describe('F-3 入口ごとの呼び出しの形（この文字列のとおり）', () => {
  it('★★★ D1 手順6: フック useDedicatedPanelTeardown の中の1か所だけが runTeardownFlow(projectDir, dedicatedTeardownSpec, electronFlowDeps(projectDir, dedicatedTeardownSpec, {。キーが無いときの文は手順6のもの', () => {
    const c = code(D1)
    expect(c).toContain('runTeardownFlow(projectDir, dedicatedTeardownSpec, electronFlowDeps(projectDir, dedicatedTeardownSpec, {')
    expect(count(D1, /\brunTeardownFlow\(/)).toBe(1)
    expect(c).toContain('keyMissingMessage: DEDICATED_PANEL_KEY_MISSING_MESSAGE,')
    expect(c).toContain('export function useDedicatedPanelTeardown(')
    // 「すべて削除する」のボタンは節の中の1つ。押したら流れの start を呼ぶだけ
    expect(count(D1, 'onClick={() => { void start() }}')).toBe(1)
    // パネル本体は流れを自分では呼ばない（節が持つ）
    expect(code(PANEL)).not.toMatch(/\brunTeardownFlow\b/)
  })

  it('★★ D2 一覧: 専有型の行は同じ <TeardownRow の要素の中で spec={dedicatedTeardownSpec} と keyMissingMessage={DEDICATED_LIST_KEY_MISSING_MESSAGE} を渡す（1つだけ）。行の中で流れを呼ぶのは useTeardownFlow', () => {
    const c = code(D2)
    const at = c.indexOf('spec={dedicatedTeardownSpec}')
    expect(at, '一覧が spec={dedicatedTeardownSpec} を渡していない').toBeGreaterThan(0)
    expect(c.slice(at + 1).includes('spec={dedicatedTeardownSpec}'), '専有型の行は1つだけ').toBe(false)
    const start = c.lastIndexOf('<TeardownRow', at)
    expect(start, 'spec={dedicatedTeardownSpec} の前に <TeardownRow が無い').toBeGreaterThanOrEqual(0)
    // その要素が閉じる前（`/>` より前）に spec がある。つまり別の要素の props ではない。
    expect(c.slice(start, at)).not.toContain('/>')
    expect(c.slice(start, at + 300)).toContain('keyMissingMessage={DEDICATED_LIST_KEY_MISSING_MESSAGE}')
    expect(c.slice(start, at)).toContain('key={rowKey}')
    expect(code(D2_HOOK)).toContain('runTeardownFlow(projectDir, spec, electronFlowDeps(projectDir, spec, {')
    expect(code(D2_ROW)).toContain('useTeardownFlow(entry.dir, spec, {')
  })

  it('★★★ D3 プロジェクトの削除: 流れを呼ばない。専有型の仕様書も使わず、止める判断は projectDeleteBlockOf の1つ（専有型の枝は「この画面からは削除できません」を failed に積むだけ）', () => {
    expect(hits(SRC.filter(f => ![SPEC, D1, D2].includes(f)), /\bdedicatedTeardownSpec\b/)).toEqual([])
    for (const rel of [D3_PLAN, D3_RUN, DIALOG, SIDEBAR]) expect(code(rel), rel).not.toMatch(/\bdedicatedTeardownSpec\b/)
    const run = code(D3_RUN)
    const at = run.indexOf("} else if (t === 'sakura-apprun-dedicated') {")
    const end = run.indexOf("} else if (t === 'hanamii') {", at)
    expect(at, '専有型の枝が見つからない').toBeGreaterThan(0)
    expect(end, 'HANAMII の枝が専有型の枝のあとに無い').toBeGreaterThan(at)
    const branch = run.slice(at, end)
    expect(branch).toContain("kind: 'failed'")
    expect(branch).toContain('専有型は、この画面からは削除できません。')
    expect(branch).toContain('📡 公開したもの一覧の「🗑 削除」')
    for (const w of ['runTeardownFlow', 'electronFlowDeps', '.invoke(', 'apprunDedicated', 'clearPublishRecord']) expect(branch, w).not.toContain(w)
    // 止めるのは projectDeleteBlockOf（planProjectDeleteTeardown が呼ぶ）。ダイアログは plan.block を読む
    expect(code(D3_PLAN)).toContain('export function projectDeleteBlockOf(')
    expect(code(D3_PLAN)).toContain('dedicatedTeardownHasWork(dedicated)')
    expect(code(DIALOG)).toContain('planProjectDeleteTeardown(facts)')
  })

  it('★★★ 入口は3つだけ: 仕様書 dedicatedTeardownSpec を使うファイルは、定義と D1 の節・D2 の3つ（増えたら、ここで気づく）。useDedicatedPanelTeardown を使うのは節だけ', () => {
    expect(hits(SRC, /\bdedicatedTeardownSpec\b/)).toEqual([D1, D2, SPEC].sort())
    expect(hits(SRC, /\buseDedicatedPanelTeardown\(/)).toEqual([D1])
    // 専有型の言葉（DEDICATED_TEARDOWN_WORDS）を使う側は、仕様書の外では節・見張りの部品・パネルの知らせの作り手だけ
    for (const f of hits(SRC, /\bDEDICATED_TEARDOWN_WORDS\b/)) {
      expect([SPEC, D1, PANEL, 'src/renderer/apprunDedicatedActions.ts', 'src/renderer/components/DedicatedOpsParts.tsx', 'src/renderer/hooks/useDedicatedOpsWatch.ts'], f).toContain(f)
    }
    // runTeardownFlow を呼ぶのは、3つの公開先の入口だけ（専有型の入口は D1 と D2 のフック）
    expect(hits(SRC.filter(f => f !== FLOW), /\brunTeardownFlow\(/)).toEqual([
      'src/renderer/components/HanamiiTeardownSection.tsx', 'src/renderer/components/SharedTeardownSection.tsx', D1, D2_HOOK, D3_RUN,
    ].sort())
  })
})

describe('F-4 直す前の形が戻っていない（名前は単語の境界つきで見る。`DEDICATED_LIST_KEY_MISSING_MESSAGE` に `LIST_KEY_MISSING_MESSAGE` が含まれるため）', () => {
  it('★★★ 消した手本の4ファイルが無い', () => {
    for (const f of DELETED) expect(fs.existsSync(path.join(ROOT, f)), `${f} が戻っている`).toBe(false)
  })

  it.each([
    'runDedicatedTeardown', 'electronTeardownDeps', 'buildDedicatedTeardownConfirm', 'teardownConfirmMessage', 'useDedicatedTeardown',
    'DedicatedTeardownRow', 'DedicatedTeardownResultView', 'DedicatedTeardownProgress', 'DedicatedTeardownOutcome', 'DedicatedTeardownView',
    'resumedTeardownResult', 'notifyDedicatedTeardownFinished', 'dedicatedTeardownFlow', 'LIST_KEY_MISSING_MESSAGE', 'runTeardown',
    'TeardownReq', 'RunTeardownDeps',
  ])('★★★ %s が src のどこにも無い（コメント除く）', (name) => {
    expect(hits(SRC, new RegExp(`\\b${name}\\b`))).toEqual([])
  })

  it('★★★ 確認の本文を作る関数 buildTeardownConfirmBody を定義するのは teardown/confirm.ts だけ。呼ぶのも confirm.ts の buildTeardownConfirm の1か所だけ（確認の文を作る関数は1つ）', () => {
    const CONFIRM = 'src/renderer/teardown/confirm.ts'
    expect(hits(SRC, /\bfunction\s+buildTeardownConfirmBody\b/)).toEqual([CONFIRM])
    expect(hits(SRC, 'buildTeardownConfirmBody({')).toEqual([CONFIRM])
    expect(count(CONFIRM, 'buildTeardownConfirmBody({')).toBe(1)
    const c = code(CONFIRM)
    expect(c.slice(c.indexOf('export function buildTeardownConfirm<'))).toContain('const body = buildTeardownConfirmBody({')
  })

  it("★★ `scope: 'full'`・`dataNoteScope` が src のどこにも無い（💾 の文の範囲 scope は 3B-3 でやめた。専有型の手本が最後の使い手だった）", () => {
    expect(hits(SRC, /scope:\s*['"]full['"]/)).toEqual([])
    expect(hits(SRC, /\bdataNoteScope\b/)).toEqual([])
  })

  it('★ global.d.ts の appDeleted の説明が、公開記録を「ok ではなくこちらで判断する」と言う旧い文に戻っていない（D1=1 で事実でなくなった。main の説明 apprunDedicatedApply.ts とそろえた。コメントなので、この文だけを見張る）', () => {
    const dts = read(GLOBAL_DTS)
    expect(dts).not.toContain('ok ではなくこちらで判断')
    expect(dts).toContain('公開記録（📡 の行）を消すかには使わない')
  })

  it('★★ 見張りの前提: 新しい名前の側（DEDICATED_LIST_KEY_MISSING_MESSAGE）は実在し、単語の境界つきの検査には当たらない', () => {
    expect(hits(SRC, /\bDEDICATED_LIST_KEY_MISSING_MESSAGE\b/).length).toBeGreaterThan(0)
    expect(hits(SRC, /\bLIST_KEY_MISSING_MESSAGE\b/)).toEqual([])
  })

  it('★★ 見張りの道具: 単語の境界つきの正規表現は、本物の旧い名前に当たる（空振りしていない）', () => {
    expect(/\bLIST_KEY_MISSING_MESSAGE\b/.test('const m = LIST_KEY_MISSING_MESSAGE')).toBe(true)
    expect(/\bLIST_KEY_MISSING_MESSAGE\b/.test('const m = DEDICATED_LIST_KEY_MISSING_MESSAGE')).toBe(false)
    expect(/\brunTeardown\b/.test('await runTeardown(req, deps)')).toBe(true)
    expect(/\brunTeardown\b/.test('await runTeardownFlow(dir, spec, deps)')).toBe(false)
  })
})

describe('F-5 画面の記録消しは0件（消すのは main の apprunDedicated:teardown の1か所）', () => {
  /** 一覧の専有型の枝（HANAMII の枝の手前まで）。一覧は「一覧から削除」（R1）で clearPublishRecord を使うので、専有型の枝だけを見る。 */
  const dedicatedBranch = () => {
    const c = code(D2)
    const start = c.indexOf("if (e.target === 'sakura-apprun-dedicated' && supported) {")
    const end = c.indexOf("if (e.target === 'hanamii' && supported) {")
    expect(start, '専有型の枝が見つからない').toBeGreaterThan(0)
    expect(end, 'HANAMII の枝が専有型の枝のあとに無い').toBeGreaterThan(start)
    return c.slice(start, end)
  }

  it('★★★ 専有型のどの入口にも `clearPublishRecord`・`forgetPublishTargetRecord`・`forgetPublishTarget` が無い（手順6の節・パネル・行・フック・流れ・プロジェクトの削除の専有型の枝）', () => {
    for (const rel of [D1, PANEL, D2_ROW, D2_HOOK, FLOW, SPEC, D3_PLAN]) {
      const c = code(rel)
      expect(c, rel).not.toContain('clearPublishRecord')
      expect(c, rel).not.toContain('forgetPublishTarget')
    }
    const branch = dedicatedBranch()
    expect(branch).not.toContain('clearPublishRecord')
    expect(branch).not.toContain('forgetPublishTarget')
    expect(branch).toContain('<TeardownRow') // 見張りの前提: 枝の中身を読めている
  })

  it('★★ main の骨は公開の記録を1か所で消す（forgetRecord）。専有型の仕様書 DEDICATED_TEARDOWN_SHELL が forgetPublishTargetFs を渡す', () => {
    const c = code(MAIN)
    expect(c).toContain("forgetPublishTargetFs(ctx.projectDir, 'sakura-apprun-dedicated')")
    expect(count(MAIN, 'forgetPublishTargetFs(')).toBe(1)
    expect(hits(SRC.filter(f => f.startsWith('src/renderer/')), 'forgetPublishTargetFs')).toEqual([])
  })
})

describe('F-6 新しいファイルは各400行以下・巨大ファイルは移した分だけ短くなった・依存の向き', () => {
  it.each([
    MAIN, MAIN_COMMON, SPEC, D1, CARD, 'src/renderer/hooks/useDedicatedOpsWatch.ts', 'src/main/ipc/cloudTeardown.ts',
    'tests/dedicatedTeardownEntriesF.test.ts', 'tests/dedicatedTeardownShell.test.ts', 'tests/dedicatedTeardownShell2.test.ts',
    'tests/dedicatedTeardownShellMocks.ts', 'tests/dedicatedTeardownShellHarness.ts', 'tests/dedicatedTeardownSpec.test.ts',
    'tests/dedicatedTeardownGolden.test.ts', 'tests/dedicatedTeardownSection.test.ts', 'tests/dedicatedTeardownStorageAll.test.ts',
    'tests/dedicatedTeardownMarkWrites.test.ts',
    'tests/projectDeleteLeftoverAll.test.ts', 'tests/localOpsWindow.test.ts', 'tests/useDedicatedOpsWatch.test.ts',
  ])('%s は400行以下', (rel) => {
    expect(fs.existsSync(path.join(ROOT, rel)), rel).toBe(true)
    expect(lines(rel), `${rel} は ${lines(rel)} 行`).toBeLessThanOrEqual(400)
  })

  it('★ 専有型の仕様書は250行以下・棚卸しのカードは150行以下・一覧（PublishedListModal.tsx）は400行以下（超えたら、切り出し先を親に戻す＝設計書 10.11.9 の D2 の6）', () => {
    expect(lines(SPEC)).toBeLessThanOrEqual(250)
    expect(lines(CARD)).toBeLessThanOrEqual(150)
    expect(lines(D2)).toBeLessThanOrEqual(400)
  })

  it('★ AppRunDedicatedPanel.tsx は 3B の前（3,021 行）より短い（手順6の節・見張りを切り出した分）', () => {
    expect(lines(PANEL)).toBeLessThan(3021)
  })

  it('★★ 共通の部品（teardown/・components/teardown/・targets/*.ts・PublishedInventoryCard.tsx）と main の骨・結果の読み方は、専有型のパネルの部品・main の本体を import しない', () => {
    const forbidden = [
      'src/renderer/apprunDedicatedActions.ts', PANEL, 'src/main/cloud/apprunDedicatedApply.ts',
      ...fs.readdirSync(path.join(ROOT, 'src/main/ipc')).filter(f => /^apprunDedicated.*\.ts$/.test(f)).map(f => `src/main/ipc/${f}`),
    ].map(abs)
    const common = [
      ...RENDERER.filter(f => f.startsWith('src/renderer/teardown/') || f.startsWith('src/renderer/components/teardown/')), CARD, SHELL, RESULT,
    ]
    expect(common.length, '共通の部品を拾えていない').toBeGreaterThan(15)
    for (const rel of common) {
      for (const r of resolvedImports(rel)) expect(forbidden.includes(r), `${rel} が専有型の部品／main の本体を import している（${path.relative(ROOT, r)}）`).toBe(false)
    }
  })

  it('★★ ipc/apprunDedicatedTeardown.ts・ipc/apprunDedicatedCommon.ts は ipc/apprunDedicated.ts を import しない（一方向。CommonJS で循環させない）。Common は骨も本体も import しない', () => {
    for (const rel of [MAIN, MAIN_COMMON]) expect(resolvedImports(rel), rel).not.toContain(abs(MAIN_ROOT))
    expect(resolvedImports(MAIN_COMMON), 'Common が他の ipc を import している').toEqual(
      resolvedImports(MAIN_COMMON).filter(r => !r.includes('/ipc/apprunDedicated')))
    expect(resolvedImports(MAIN_ROOT)).toContain(abs(MAIN_COMMON))
    expect(resolvedImports(MAIN_ROOT)).toContain(abs(MAIN))
  })

  it('★★ 手順6の節 DedicatedTeardownSection.tsx は AppRunDedicatedPanel.tsx を import しない（パネル → 節 → パネルの循環になる）。apprunDedicatedActions.ts の純関数は使ってよい', () => {
    expect(resolvedImports(D1)).not.toContain(abs(PANEL))
    expect(resolvedImports(D1)).toContain(abs('src/renderer/apprunDedicatedActions.ts'))
    expect(resolvedImports(PANEL)).toContain(abs(D1))
  })
})
