import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 段階2（2d）F: 共用型（さくらのAppRun）の破棄の「入口の網羅」（ソースの文字列を読む。振る舞いは別のテストが固定する）──────────────────
// 設計書: docs/teardown-unify-plan.md の 10.7.12 の F・10.7.13 の 2・4。tests/hanamiiTeardownEntries.test.ts（HANAMII）を写した。
//
// 入口は4つ:
//   S1 【公開】(AppRunPanel) 手順6の 🗑          … components/SharedTeardownSection.tsx（フック useSharedTeardown）
//   S2 【公開】(AppRunPanel) 期限切れバナーの 🗑 … S1 と同じ doTeardown（ボタンが2つ）
//   S3 📡 公開したもの一覧の行                   … components/PublishedListModal.tsx（TeardownRow）→ teardown/useTeardownFlow.ts
//   S4 プロジェクト削除                         … teardown/projectDelete.ts の teardownPublished（呼ぶのは components/ProjectDeleteDialog.tsx。もとは Sidebar）
// どの入口も runTeardownFlow（teardown/flow.ts）を通る。IPC（cloud:teardown）を呼ぶのは仕様書（teardown/targets/shared.ts）の invoke の1行だけ。
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

const SPEC = 'src/renderer/teardown/targets/shared.ts'
const MAIN = 'src/main/ipc/cloudTeardown.ts'
const MAIN_STORAGE = 'src/main/ipc/cloudTeardownStorage.ts' // 保存場所の段（0.6.24 R1-a で MAIN から切り出した）
const PRELOAD = 'src/main/preload.ts'
const FLOW = 'src/renderer/teardown/flow.ts'
const S1 = 'src/renderer/components/SharedTeardownSection.tsx'
// 専有型（0.6.22 段階3B-6a）の手順6「すべて削除する」。専有型の仕様書で同じ流れを呼ぶ。
const D1 = 'src/renderer/components/DedicatedTeardownSection.tsx'
const PANEL = 'src/renderer/components/AppRunPanel.tsx'
const S3 = 'src/renderer/components/PublishedListModal.tsx'
const S3_HOOK = 'src/renderer/teardown/useTeardownFlow.ts'
const S4 = 'src/renderer/teardown/projectDelete.ts'
const SIDEBAR = 'src/renderer/components/Sidebar.tsx'
const DIALOG = 'src/renderer/components/ProjectDeleteDialog.tsx'
const PUBLISH_RECORD = 'src/renderer/publishRecord.ts'
const PROJECT_META = 'src/renderer/projectMeta.ts'
const PUBLISH_MODAL = 'src/renderer/components/PublishModal.tsx'

describe('F-1 共用型の破棄の呼び口は1つずつ', () => {
  it('見張りの前提: 対象のファイルが実在する', () => {
    for (const f of [SPEC, MAIN, PRELOAD, FLOW, S1, PANEL, S3, S3_HOOK, S4, SIDEBAR, DIALOG, PUBLISH_RECORD, PROJECT_META, PUBLISH_MODAL, 'src/renderer/global.d.ts']) expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true)
  })

  it('★★★ `electronAPI.cloud.teardown(` を呼ぶファイルは src 全体で targets/shared.ts だけ（1回）', () => {
    expect(hits(SRC, 'electronAPI.cloud.teardown(')).toEqual([SPEC])
    expect(count(SPEC, 'electronAPI.cloud.teardown(')).toBe(1)
  })

  it('★★★ その1行は projectDir・認証・{ confirmed, deleteRegistry, registryName, shownPlacements } を渡す。deleteRegistry は選択が true のときだけ true、registryName は確認を出した時点の記録の名前、shownPlacements は確認で見せた保存場所の組（流れが作ったものをそのまま。0.6.24 F）', () => {
    expect(code(SPEC)).toMatch(/electronAPI\.cloud\.teardown\(projectDir, auth, \{\s*confirmed: opts\.confirmed,\s*deleteRegistry: opts\.choices\?\.deleteRegistry === true,\s*registryName: record\.registryName,\s*shownPlacements: opts\.shownPlacements,\s*\}\)/)
  })

  it('★★ 確認の材料の口 `electronAPI.cloud.teardownRecord(` を呼ぶのも仕様書だけ（入口が自分で記録を読んで確認を作らない）', () => {
    expect(hits(SRC, 'electronAPI.cloud.teardownRecord(')).toEqual([SPEC])
    expect(count(SPEC, 'electronAPI.cloud.teardownRecord(')).toBe(1)
  })

  it('★★ 別の書き方（cloud?.teardown・cloud["teardown"]・分割代入のあとの呼び出し）でも、共用型の破棄を呼ぶのは仕様書だけ', () => {
    expect(hits(RENDERER, /\bcloud\s*(?:\??\.\s*teardown\b|\[\s*['"]teardown['"]\s*\])/)).toEqual([SPEC])
    expect(hits(RENDERER, /\{[^}]*\bteardown\b[^}]*\}\s*=\s*(?:window\.)?electronAPI\.cloud\b/)).toEqual([])
  })

  it("★★ `ipcMain.handle('cloud:teardown'`・`'cloud:teardownRecord'` を持つファイルは main/ipc/cloudTeardown.ts だけ。`ipcRenderer.invoke(` は preload.ts だけ", () => {
    expect(hits(SRC, /ipcMain\.handle\(\s*['"]cloud:teardown['"]/)).toEqual([MAIN])
    expect(hits(SRC, /ipcMain\.handle\(\s*['"]cloud:teardownRecord['"]/)).toEqual([MAIN])
    expect(hits(SRC, /ipcRenderer\.invoke\(\s*['"]cloud:teardown['"]/)).toEqual([PRELOAD])
    expect(hits(SRC, /ipcRenderer\.invoke\(\s*['"]cloud:teardownRecord['"]/)).toEqual([PRELOAD])
  })

  it('★★ 3点セット（main・preload・global.d.ts）が同じ形: cloud の teardown は { heldByMain: true } と { confirmed, deleteRegistry, registryName }、teardownRecord が並ぶ', () => {
    const d = code('src/renderer/global.d.ts')
    expect(d).toContain('teardown(projectDir: string, auth: { heldByMain: true }, opts: { confirmed: boolean; deleteRegistry: boolean; registryName: string | null; shownPlacements: Array<{ bucket: string; prefix: string }> })')
    expect(code(PRELOAD)).toContain('opts: { confirmed: boolean; deleteRegistry: boolean; registryName: string | null; shownPlacements: Array<{ bucket: string; prefix: string }> }) =>')
    expect(d).toContain('teardownRecord(projectDir: string)')
    expect(code(PRELOAD)).toContain("ipcRenderer.invoke('cloud:teardown', projectDir, auth, opts)")
    expect(code(PRELOAD)).toContain("teardownRecord: (projectDir: string) => ipcRenderer.invoke('cloud:teardownRecord', projectDir)")
  })
})

describe('F-2 仕様書の invoke を呼ぶのは flow.ts だけ（入口が直接呼ぶと、確認・窓を閉じる警告・キーなしの失敗を飛ばせる）', () => {
  it('★★★ src/renderer 全体（コメント除く）で `.invoke(` を含むファイルは flow.ts だけ', () => {
    expect(hits(RENDERER, '.invoke(')).toEqual([FLOW])
  })

  it.each([S1, S3, S3_HOOK, S4, PANEL, SIDEBAR, DIALOG])('★★ %s は仕様書の invoke・loadAuth・readRecord を直接呼ばない（確認の答えを見ずに実行できる抜け道になる）', (rel) => {
    const c = code(rel)
    expect(c).not.toContain('.invoke(')
    expect(c).not.toMatch(/[sS]pec\.(?:invoke|loadAuth|readRecord)\s*\(/)
  })
})

describe('F-3 入口ごとの呼び出しの形（この文字列のとおり）', () => {
  it('★★ S1・S2 【公開】の節: runTeardownFlow(projectDir, sharedTeardownSpec, electronFlowDeps(projectDir, sharedTeardownSpec, {。選択つきの確認の口 confirmWithChoices を渡す', () => {
    const c = code(S1)
    expect(c).toContain('runTeardownFlow(projectDir, sharedTeardownSpec, electronFlowDeps(projectDir, sharedTeardownSpec, {')
    expect(c).toContain('confirmWithChoices,')
    expect(c).toContain('keyMissingMessage: SHARED_KEY_MISSING_MESSAGE,')
  })

  it('★★★ AppRunPanel の 🗑 のボタンはちょうど2つ（S1 手順6・S2 期限切れバナー）で、どちらも onClick={() => { void doTeardown() }}。doTeardown は流れの start を呼ぶだけ', () => {
    const c = code(PANEL)
    expect(count(PANEL, 'onClick={() => { void doTeardown() }}')).toBe(2)
    expect(count(PANEL, /doTeardown\b/)).toBe(3) // 定義1・ボタン2
    expect(c).toMatch(/const doTeardown = async \(\) => \{\s*setOpKind\('破棄'\)\s*clearResults\(\)\s*await sharedTeardown\.start\(\)\s*\}/)
    expect(c).toContain('{sharedTeardown.confirmElement}')
  })

  it('★★ S3 一覧: 共用型の行は同じ <TeardownRow の要素の中で spec={sharedTeardownSpec} を渡す。行の中で流れを呼ぶのは useTeardownFlow', () => {
    const c = code(S3)
    const at = c.indexOf('spec={sharedTeardownSpec}')
    expect(at, '一覧が spec={sharedTeardownSpec} を渡していない').toBeGreaterThan(0)
    expect(c.slice(at + 1).includes('spec={sharedTeardownSpec}'), '共用型の行は1つだけ').toBe(false)
    const start = c.lastIndexOf('<TeardownRow', at)
    expect(start, 'spec={sharedTeardownSpec} の前に <TeardownRow が無い').toBeGreaterThanOrEqual(0)
    // その要素が閉じる前（`/>` より前）に spec がある。つまり別の要素の props ではない。
    expect(c.slice(start, at)).not.toContain('/>')
    expect(c.slice(start, at + 400)).toContain('keyMissingMessage={SHARED_KEY_MISSING_MESSAGE}')
    expect(code(S3_HOOK)).toContain('runTeardownFlow(projectDir, spec, electronFlowDeps(projectDir, spec, {')
  })

  it('★★ S4 プロジェクト削除: projectDelete.ts が runTeardownFlow(dir, sharedTeardownSpec, electronFlowDeps(dir, sharedTeardownSpec, {。選択つきの確認の口を ctx から渡す', () => {
    const c = code(S4)
    expect(c).toContain('runTeardownFlow(dir, sharedTeardownSpec, electronFlowDeps(dir, sharedTeardownSpec, {')
    expect(c).toContain('confirmWithChoices: ctx.confirmWithChoices,')
    expect(c).toContain('keyMissingMessage: SHARED_KEY_MISSING_MESSAGE,')
  })

  it('★★ ダイアログは teardownPublished に confirm と confirmWithChoices を渡して呼ぶだけ。選択つきの確認の要素を、背景の div の後ろに描く。流れも共用型の仕様書も持たない。Sidebar は選択つきの確認を持たない', () => {
    const c = code(DIALOG)
    expect(c).toContain("import { useConfirmChoices } from '../useConfirmChoices'")
    expect(c).toContain('const { confirm, confirmWithChoices, element } = useConfirmChoices()')
    expect(count(DIALOG, 'useConfirmChoices()')).toBe(1)
    // 3A-5b: 破棄は、押す口 pressProjectDelete に渡す deps の teardown として 1 か所だけ呼ぶ
    // 第3引数 o は残りの段の印（plan.leftover）。渡さないと、残りの段の step に印と呼び名が付かない（0.6.24 A-5・U12）
    expect(c).toContain('teardown: (d, ts, o) => teardownPublished(d, ts, { confirm, confirmWithChoices }, o),')
    expect(count(DIALOG, 'teardownPublished(')).toBe(1)
    for (const w of ['runTeardownFlow', 'electronFlowDeps', 'sharedTeardownSpec', 'cloud.teardown(', 'targets/shared']) expect(c, w).not.toContain(w)
    // 確認の要素 {element} は、背景の div の外（後ろの兄弟）に描く。中に描くと、確認の背景を押した click がダイアログの背景の onClick まで届いて両方閉じる
    const at = c.indexOf('{element}')
    expect(at, '確認の要素を描いていない').toBeGreaterThan(0)
    expect(count(DIALOG, '{element}')).toBe(1)
    const backdrop = c.lastIndexOf('<div', c.indexOf('fixed inset-0 z-50'))
    expect(backdrop, '背景の div が見つからない').toBeGreaterThanOrEqual(0)
    const before = c.slice(backdrop, at)
    expect((before.match(/<div\b/g) ?? []).length, '{element} が背景の div の中にある（背景の div を閉じる前に描いている）').toBe((before.match(/<\/div>/g) ?? []).length)
    // 置き場を消すかの既定は、画面が開いたときの写し（registry）から渡さない（押した時点の main の記録から決まる）
    const call = c.slice(c.indexOf('teardownPublished(d, ts'), c.indexOf('teardownPublished(d, ts') + 160)
    expect(call.length).toBeGreaterThan(40)
    expect(call).not.toContain('registry')
    // Sidebar は選択つきの確認を持たない（ダイアログが持つ。Sidebar に残る確認の要素はファイル操作の useConfirm の1つ）
    const side = code(SIDEBAR)
    expect(side).not.toContain('useConfirmChoices')
    expect(side).not.toContain('choicesConfirmElement')
    expect(side).not.toContain('confirmWithChoices')
    for (const w of ['runTeardownFlow', 'electronFlowDeps', 'sharedTeardownSpec', 'cloud.teardown(', 'targets/shared']) expect(side, `Sidebar に ${w}`).not.toContain(w)
    expect(count(SIDEBAR, '{confirmElement}')).toBe(1)
  })

  it('★★★ 入口は4つだけ: 仕様書 sharedTeardownSpec を使うファイルは、定義と S1の節・S3・S4 の4つ（増えたら、ここで気づく）。AppRunPanel は流れを自分では呼ばない', () => {
    expect(hits(SRC, 'sharedTeardownSpec')).toEqual([S1, S3, S4, SPEC].sort())
    expect(hits(SRC, 'useSharedTeardown(')).toEqual([PANEL, S1].sort())
    expect(hits(SRC.filter(f => f !== FLOW), /\brunTeardownFlow\(/)).toEqual(['src/renderer/components/HanamiiTeardownSection.tsx', S3_HOOK, S4, S1, D1].sort())
  })
})

describe('F-4 直す前の形が戻っていない', () => {
  it.each([
    [PANEL, ['cloud.teardown(', 'clearAppRunPublishRecord', 'clearPublishRecord(', 'askTeardown', "kind: 'teardown'", '環境を破棄します', '理解した上で破棄する', 'effectiveDeleteRegistry', 'setDeleteRegistry(']],
    [S3, ['cloud.teardown(', 'runTeardown', 'askConfirm', 'confirmPlacements', '公開を破棄します', 'registryDeleteLabel(']],
    [S4, ['cloud.teardown(', 'clearPublishRecord', 'registryDeleteDefault(', 'pendingRegistry']],
  ] as Array<[string, string[]]>)('★★ %s に、直す前の形が無い', (rel, gone) => {
    const c = code(rel)
    for (const w of gone) expect(c, `${rel} に ${w}`).not.toContain(w)
  })

  it('★★★ 直す前の呼び形（IPC に projectDir と { … } の2つだけを渡す形・段階2の橋の { heldByMain: true } を直に渡す形）は src のどこにも無い', () => {
    // 新しい呼び形は第2引数が認証の変数（auth）。第2引数がオブジェクトのリテラルなら、直す前の形か橋。
    expect(hits(SRC, /electronAPI\.cloud\.teardown\(\s*[\w.]+\s*,\s*\{/)).toEqual([])
    for (const old of [
      'window.electronAPI.cloud.teardown(projectDir, { confirmed: true, deleteRegistry: effectiveDeleteRegistry })', // 【公開】(AppRunPanel)
      'window.electronAPI.cloud.teardown(e.dir, { confirmed: true, deleteRegistry: effectiveDeleteRegistry })',      // 📡 一覧
    ]) expect(hits(SRC, old), old).toEqual([])
  })

  it('★★ 一覧・Sidebar・ダイアログ・AppRunPanel は、レジストリを消すかの選択も確認の本文も自分では作らない（仕様書と共通の確認が作る）', () => {
    for (const rel of [S3, S4, SIDEBAR, DIALOG, PANEL, S1]) {
      const c = code(rel)
      for (const w of ['deleteRegistry:', 'registryDeleteDefault(', 'registryDeleteHelp(', 'registryUnknownNotice(', 'adoptedRegistryNote(', 'teardownDataNoteForAll(']) {
        // プロジェクト削除のダイアログは、消える保存場所の注記（teardownDataNoteForAll）を自分で作る（Sidebar から移した。3B 以降で見直す）
        if (rel === DIALOG && w === 'teardownDataNoteForAll(') continue
        expect(c, `${rel} に ${w}`).not.toContain(w)
      }
    }
  })
})

describe('F-5 画面の記録消しは0件（消すのは main の cloud:teardown の1か所）', () => {
  it('★★★ src/renderer（コメント除く）で `clearPublishRecord(` を含むのは publishRecord.ts（定義）と PublishedListModal.tsx（R1 の1行）だけ', () => {
    expect(hits(RENDERER, 'clearPublishRecord(')).toEqual([PUBLISH_RECORD, S3].sort())
    expect(count(S3, 'clearPublishRecord(e.dir, e.target)')).toBe(1)
    expect(count(S3, 'clearPublishRecord(')).toBe(1)
  })

  it('★★ `forgetPublishTargetThenLoad(` は projectMeta.ts（定義）と PublishModal.tsx（R2）だけ。`forgetPublishTargetRecord(` は projectMeta.ts と publishRecord.ts だけ。`clearAppRunPublishRecord` は0件', () => {
    expect(hits(RENDERER, 'forgetPublishTargetThenLoad(')).toEqual([PROJECT_META, PUBLISH_MODAL].sort())
    expect(hits(RENDERER, 'forgetPublishTargetRecord(')).toEqual([PROJECT_META, PUBLISH_RECORD].sort())
    expect(hits(SRC, 'clearAppRunPublishRecord')).toEqual([])
  })

  it('★★★ 共用型の 4 つの入口（S1・S3・S4・AppRunPanel）は、公開の記録を消す口（publishMeta・forgetPublishTarget）を持たない。R1（一覧から削除）だけが S3 に残る', () => {
    for (const rel of [S1, PANEL, S4, SIDEBAR, DIALOG]) {
      const c = code(rel)
      expect(c, rel).not.toContain('forgetPublishTarget')
      expect(c, rel).not.toContain('clearPublishRecord')
    }
    expect(code(S1)).not.toContain('publishMeta')
    expect(code(S4)).not.toContain('publishMeta')
  })
})

describe('F-5b プロジェクト削除の共用型の枝（projectDelete.ts）', () => {
  /** teardownPublished の共用型の枝（`t === 'sakura-apprun'` から専有型の枝の手前まで）。 */
  const branch = () => {
    const c = code(S4)
    const from = c.indexOf("if (t === 'sakura-apprun') {")
    const to = c.indexOf("} else if (t === 'sakura-apprun-dedicated') {")
    expect(from, '共用型の枝が見つからない').toBeGreaterThan(0)
    expect(to, '専有型の枝が見つからない').toBeGreaterThan(from)
    return c.slice(from, to)
  }

  it('★★★ やめた（cancelled）ときは失敗に積んで、残りの公開先へ進まない（break）', () => {
    const b = branch()
    expect(b).toContain('if (outcome.cancelled) {')
    expect(b).toContain('破棄をキャンセルしました')
    expect(b).toMatch(/破棄をキャンセルしました[\s\S]*?\n\s*break\n/)
  })

  it('★★★ 「破棄するものはありません」（nothingToDo）は成功として扱い、失敗に積む判断（!outcome.result.ok）より先に見る。順序を逆にすると、幽霊の行でフォルダを移せなくなる', () => {
    const b = branch()
    const ghost = b.indexOf('outcome.nothingToDo === true')
    const failure = b.indexOf('!outcome.result.ok')
    expect(ghost, 'nothingToDo の判断が無い').toBeGreaterThan(0)
    expect(failure, 'ok:false の判断が無い').toBeGreaterThan(0)
    expect(ghost).toBeLessThan(failure)
    expect(b).toContain("kind: 'failed'")
    expect(b).toContain("line: `${nameOf(t)}: ${outcome.result.message ?? '原因不明'}`") // 残りの段は名詞で言う（0.6.24 A-5）
    // nothingToDo の枝（`{` から `} else if`）は nothingToDo の step を積み、失敗・済んだの step を積まない（積むと、幽霊の行でフォルダを移せなくなる／偽の知らせが出る）
    const ghostBranch = b.slice(b.indexOf('{', ghost), b.indexOf('} else if (!outcome.result.ok)'))
    expect(ghostBranch).toContain("kind: 'nothingToDo'")
    expect(ghostBranch).not.toContain("kind: 'failed'")
    expect(ghostBranch).not.toContain("kind: 'done'")
    expect(ghostBranch).not.toContain('onWarnings')
  })

  it('★★ 済んだ回の知らせは、共用型の仕様書の toView を step の view に持たせて呼び手へ渡す（文を自分で作らない）。公開の記録も、レジストリの既定も、自分では扱わない', () => {
    const b = branch()
    expect(b).toContain("kind: 'done', view: sharedTeardownSpec.toView(outcome.result), words: sharedTeardownSpec.words")
    expect(b).not.toContain('onWarnings')
    for (const w of ['clearPublishRecord', 'forgetPublishTarget', 'publishMeta', 'registryDeleteDefault', 'pendingRegistry', 'deleteRegistry', 'cloud.teardown(', '.invoke(']) expect(b, w).not.toContain(w)
  })

  it('★★★ フォルダをゴミ箱へ移してよいかは projectDeleteVerdict の 1 つ（全部 ok のときだけ移す。nothingToDo は失敗に積まれないので移せる）。ダイアログは判断せず、フォルダを移す口 fs.trash( は deps の 1 か所だけ', () => {
    const c = code(DIALOG)
    expect(count(DIALOG, 'fs.trashProject(')).toBe(1) // 0.6.24 E-4: プロジェクトのフォルダを移す口は fs.trashProject（確認の印つき）。汎用の fs.trash( はダイアログに無い
    expect(count(DIALOG, 'fs.trash(')).toBe(0)
    expect(c).toContain('const r = await window.electronAPI.fs.trashProject(p, { confirmed: true, skippedForTwins })')
    expect(c).not.toContain('failed.length')
    expect(count(SIDEBAR, 'fs.trash(path)')).toBe(0)
    const run = code(S4)
    expect(run).toContain('const verdict = projectDeleteVerdict(plan, teardownOnDelete, steps)')
    expect(run).toContain("if (!verdict.moveToTrash) return { phase: 'stopped', steps: all }")
  })
})

describe('F-6 新しいファイルは各400行以下。巨大ファイルは移した分だけ短くなった', () => {
  const lines = (rel: string) => read(rel).split('\n').length

  it.each([
    MAIN, MAIN_STORAGE, SPEC, S1, S4, 'src/renderer/useConfirmChoices.tsx',
    'tests/sharedTeardownEntries.test.ts', 'tests/sharedProjectDelete.test.ts', 'tests/hanamiiProjectDelete.test.ts',
    'tests/sharedTeardownHarness.ts', 'tests/sharedTeardownShell.test.ts', 'tests/sharedTeardownShell2.test.ts', 'tests/sharedTeardownRecord.test.ts',
    'tests/sharedTeardownMeasure.test.ts', 'tests/teardownResultSharedTwin.test.ts', 'tests/sharedTeardownSpec.test.ts', 'tests/sharedTeardownConfirm.test.ts',
    'tests/sharedTeardownRow.test.ts', 'tests/sharedTeardownRowStates.test.ts', 'tests/sharedTeardownRowHarness.ts', 'tests/publishedListSharedRow.test.ts',
    'tests/sharedTeardownSection.test.ts', 'tests/sharedTeardownSectionStates.test.ts', 'tests/sharedTeardownSectionWiring.test.ts', 'tests/sharedSectionHarness.ts',
    'tests/confirmChoices.test.ts', 'tests/teardownFlowChoices.test.ts', 'tests/teardownFactsLegacy.test.ts', 'tests/teardownHookChoices.test.ts',
  ])('%s は400行以下', (rel) => {
    expect(fs.existsSync(path.join(ROOT, rel)), rel).toBe(true)
    // hanamiiProjectDelete.test.ts は段階1からある（409 行だった）ファイル。共用型の旧い枝のテストを外したので、400 行以下に戻った。
    expect(lines(rel), `${rel} は ${lines(rel)} 行`).toBeLessThanOrEqual(400)
  })

  it('★ 保存場所の段（cloudTeardownStorage.ts）は200行以下。cloudTeardown.ts は段を足したあとも400行以下に収まる（超えたら、足す先を段のファイルに戻す＝0.6.24 R1-a）', () => {
    expect(lines(MAIN_STORAGE)).toBeLessThanOrEqual(200)
    expect(lines(MAIN)).toBeLessThanOrEqual(400)
  })

  it('★ cloud.ts（今の 2,339 行→移した分だけ短くなった）・AppRunPanel.tsx（2,888 行）・PublishedListModal.tsx（593 行）は、段階2の前より減っている', () => {
    expect(lines('src/main/ipc/cloud.ts')).toBeLessThan(2339)
    expect(lines(PANEL)).toBeLessThan(2888)
    expect(lines(S3)).toBeLessThan(593)
  })

  it('★ Sidebar.tsx は新しい節を足さない（hook 1行・要素1行・引数1つ・コメントだけ。1,206 行から数行の増え）。破棄の節の切り出しは段階3の ProjectDeleteDialog で行う', () => {
    expect(lines(SIDEBAR)).toBeLessThan(1215)
  })
})
