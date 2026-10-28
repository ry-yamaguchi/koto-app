import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 段階1（1d）F: HANAMII の破棄の「入口の網羅」（ソースの文字列を読む。振る舞いは別のテストが固定する）──────────────────────
// 設計書: docs/teardown-unify-plan.md の 10.4.4・10.4.9 の F・10.4.10 の 1〜7・12。
// 置き換えた先: 前は tests/teardownSupport.test.ts が「呼び出しの文字列」と「出現数3」を数えていた。それは
// 入口が仕様書の invoke を直接呼ぶと、確認・窓を閉じる警告・キーなしの失敗を全部飛ばせるのに、緑のままだった（CLAUDE.md の調査のしかた②）。
//
// 入口は3つ（段階2の共用型が増えるとき、ここに足す）:
//   H1 【公開】(HanamiiPanel) の 🗑   … components/HanamiiTeardownSection.tsx
//   H2 📡 公開したもの一覧の行        … components/PublishedListModal.tsx（TeardownRow）→ teardown/useTeardownFlow.ts
//   H3 プロジェクト削除             … teardown/projectDelete.ts の teardownPublished（呼ぶのは components/ProjectDeleteDialog.tsx。もとは Sidebar）
// どの入口も runTeardownFlow（teardown/flow.ts）を通る。IPC を呼ぶのは仕様書（teardown/targets/hanamii.ts）の invoke の1行だけ。
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
const hits = (files: string[], needle: string | RegExp) =>
  files.filter(f => (typeof needle === 'string' ? code(f).includes(needle) : needle.test(code(f))))

const SPEC = 'src/renderer/teardown/targets/hanamii.ts'
const MAIN = 'src/main/ipc/hanamiiTeardown.ts'
const FLOW = 'src/renderer/teardown/flow.ts'
const H1 = 'src/renderer/components/HanamiiTeardownSection.tsx'
const H2 = 'src/renderer/components/PublishedListModal.tsx'
const H2_HOOK = 'src/renderer/teardown/useTeardownFlow.ts'
const H3 = 'src/renderer/teardown/projectDelete.ts'
// 共用型（段階2の2c）の【公開】の 🗑（S1・S2）。HANAMII の仕様書は使わず、共用型の仕様書（targets/shared.ts）で同じ流れを呼ぶ。
const S1 = 'src/renderer/components/SharedTeardownSection.tsx'
// 専有型（0.6.22 段階3B-6a）の手順6「すべて削除する」。専有型の仕様書（targets/dedicated.ts）で同じ流れを呼ぶ。
const D1 = 'src/renderer/components/DedicatedTeardownSection.tsx'
const SIDEBAR = 'src/renderer/components/Sidebar.tsx'
const DIALOG = 'src/renderer/components/ProjectDeleteDialog.tsx'
const PANEL = 'src/renderer/components/HanamiiPanel.tsx'

describe('F-1 HANAMII の破棄の呼び口は1つずつ', () => {
  it('見張りの前提: 対象のファイルが実在する', () => {
    for (const f of [SPEC, MAIN, FLOW, H1, H2, H2_HOOK, H3, SIDEBAR, DIALOG, PANEL, 'src/main/preload.ts']) expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true)
  })

  it('★★★ `electronAPI.hanamii.teardown(` を呼ぶファイルは src 全体で targets/hanamii.ts だけ（1回）', () => {
    expect(hits(SRC, 'electronAPI.hanamii.teardown(')).toEqual([SPEC])
    expect(code(SPEC).match(/electronAPI\.hanamii\.teardown\(/g)).toHaveLength(1)
  })

  it('★★★ その1行は projectDir・認証・{ confirmed, projectId, shownPlacements } の3つを渡す（projectDir を渡し忘れると、保存場所に触れずに ok を返していた。指摘1・2。shownPlacements は確認で見せた保存場所の組。0.6.24 F）', () => {
    expect(code(SPEC)).toContain("window.electronAPI.hanamii.teardown(projectDir, auth, { confirmed: opts.confirmed, projectId: record.projectId ?? '', shownPlacements: opts.shownPlacements })")
  })

  it('★★ 別の書き方（hanamii?.teardown・hanamii["teardown"]・分割代入のあとの呼び出し）でも、HANAMII の破棄を呼ぶのは仕様書だけ', () => {
    expect(hits(SRC, /\bhanamii\s*(?:\??\.\s*teardown\b|\[\s*['"]teardown['"]\s*\])/)).toEqual([SPEC])
    expect(hits(SRC, /\{[^}]*\bteardown\b[^}]*\}\s*=\s*(?:window\.)?electronAPI\.hanamii\b/)).toEqual([])
  })

  it("★★ `ipcMain.handle('hanamii:teardown'` を持つファイルは main/ipc/hanamiiTeardown.ts だけ。`ipcRenderer.invoke('hanamii:teardown'` は preload.ts だけ", () => {
    expect(hits(SRC, /ipcMain\.handle\(\s*['"]hanamii:teardown['"]/)).toEqual([MAIN])
    expect(hits(SRC, /ipcRenderer\.invoke\(\s*['"]hanamii:teardown['"]/)).toEqual(['src/main/preload.ts'])
  })
})

describe('F-2 仕様書の invoke を呼ぶのは flow.ts だけ（入口が直接呼ぶと、確認・窓を閉じる警告・キーなしの失敗を飛ばせる）', () => {
  it('★★★ src/renderer 全体（コメント除く）で `.invoke(` を含むファイルは flow.ts だけ', () => {
    expect(hits(SRC.filter(f => f.startsWith('src/renderer/')), '.invoke(')).toEqual([FLOW])
  })

  it.each([H1, H2, H2_HOOK, H3, S1, SIDEBAR, DIALOG, PANEL])('★★ %s は仕様書の invoke・loadAuth・readRecord を直接呼ばない（確認の答えを見ずに実行できる抜け道になる）', (rel) => {
    const c = code(rel)
    expect(c).not.toContain('.invoke(')
    expect(c).not.toMatch(/[sS]pec\.(?:invoke|loadAuth|readRecord)\s*\(/)
  })

  it('★ flow.ts の中で、仕様書の invoke を呼ぶのは electronFlowDeps の1行', () => {
    expect(code(FLOW).match(/spec\.invoke\(/g)).toHaveLength(1)
    expect(code(FLOW)).toContain('invoke: (dir, auth, opts, record) => spec.invoke(dir, auth, opts, record),')
  })
})

describe('F-3 入口ごとの呼び出しの形（この文字列のとおり）', () => {
  it('★★ H1 【公開】の節: runTeardownFlow(projectDir, hanamiiTeardownSpec, electronFlowDeps(projectDir, hanamiiTeardownSpec, {', () => {
    expect(code(H1)).toContain('runTeardownFlow(projectDir, hanamiiTeardownSpec, electronFlowDeps(projectDir, hanamiiTeardownSpec, {')
  })

  it('★★ H2 一覧: HANAMII の行は同じ <TeardownRow の要素の中で spec={hanamiiTeardownSpec} を渡す。行の中で流れを呼ぶのは useTeardownFlow', () => {
    const c = code(H2)
    expect(c).toContain('<TeardownRow')
    const at = c.indexOf('spec={hanamiiTeardownSpec}')
    expect(at, '一覧が spec={hanamiiTeardownSpec} を渡していない').toBeGreaterThan(0)
    const start = c.lastIndexOf('<TeardownRow', at)
    expect(start, 'spec={hanamiiTeardownSpec} の前に <TeardownRow が無い').toBeGreaterThanOrEqual(0)
    // その要素が閉じる前（`/>` より前）に spec がある。つまり別の要素の props ではない。
    expect(c.slice(start, at)).not.toContain('/>')
    expect(code(H2_HOOK)).toContain('runTeardownFlow(projectDir, spec, electronFlowDeps(projectDir, spec, {')
    expect(code('src/renderer/components/teardown/TeardownRow.tsx')).toContain('useTeardownFlow(entry.dir, spec, {')
  })

  it('★★ H3 プロジェクト削除: projectDelete.ts が runTeardownFlow(dir, hanamiiTeardownSpec, electronFlowDeps(dir, hanamiiTeardownSpec, {', () => {
    expect(code(H3)).toContain('runTeardownFlow(dir, hanamiiTeardownSpec, electronFlowDeps(dir, hanamiiTeardownSpec, {')
  })

  it('★★ ダイアログは teardownPublished を import して呼ぶだけ。流れも HANAMII の破棄も仕様書も持たない。Sidebar は破棄を呼ばない', () => {
    const c = code(DIALOG)
    expect(c).toContain("import { teardownPublished, pressProjectDelete, TwinsGoneError, type ProjectDeletePhase, type ProjectDeleteRunDeps } from '../teardown/projectDelete'")
    // 3A-5b: 破棄は、押す口 pressProjectDelete に渡す deps の teardown として 1 か所だけ呼ぶ。先に破棄する公開先は pressProjectDelete が plan.teardown から渡す。
    // 返り値は公開先ごとの step。失敗の文・残ったもの（月額が続く保存場所など）は、step を結果の欄（ProjectDeleteResults）が描く（見せるのはフォルダを移す前。振る舞いは hanamiiProjectDelete.test.ts・projectDeleteRun.test.ts）
    // 第3引数 o は残りの段の印（plan.leftover）。渡さないと、残りの段の step に印と呼び名が付かない（0.6.24 A-5・U12）
    expect(c).toContain('teardown: (d, ts, o) => teardownPublished(d, ts, { confirm, confirmWithChoices }, o),')
    expect(c).toContain('await pressProjectDelete(projectDir, { plan, run, seen: facts }, teardownOnDelete, deps)')
    expect(c, '知らせを受け取る口 onWarnings は無くなった（同じ事実を2つの道で返さない）').not.toContain('onWarnings')
    expect(c.match(/teardownPublished\(/g)).toHaveLength(1)
    expect(c, 'alert の橋は無い').not.toContain('failureLinesOf')
    expect(c, 'alert の橋は無い').not.toContain('keptLinesOf')
    for (const w of ['runTeardownFlow', 'electronFlowDeps', 'hanamiiTeardownSpec', 'hanamii.teardown(', 'targets/hanamii']) expect(c, w).not.toContain(w)
    // 破棄の関数をもう一度ここに定義していない（切り出した先を迂回する別の入口にならない）。
    expect(c).not.toMatch(/(?:const|function)\s+teardownPublished\b/)
    // Sidebar は破棄の関数を import も呼びもしない（ダイアログを描くだけ）
    const side = code(SIDEBAR)
    expect(side).not.toContain('teardownPublished')
    expect(side).not.toContain("teardown/projectDelete'")
    for (const w of ['runTeardownFlow', 'electronFlowDeps', 'hanamiiTeardownSpec', 'hanamii.teardown(', 'targets/hanamii']) expect(side, `Sidebar に ${w}`).not.toContain(w)
  })

  it('★★★ 入口は3つだけ: 仕様書 hanamiiTeardownSpec を使うファイルは、定義と H1・H2・H3 の4つ（増えたら、ここで気づく）', () => {
    expect(hits(SRC, 'hanamiiTeardownSpec')).toEqual([H1, H2, H3, SPEC].sort())
    // 流れを呼ぶのは H1・H3・useTeardownFlow（H2 の行が通る）と、共用型の S1・S2（SharedTeardownSection）と、専有型の手順6（D1。3B-6a）。ほかの入口が flow.ts を直接呼ぶ形も増えていない。
    expect(hits(SRC.filter(f => f !== FLOW), /\brunTeardownFlow\(/)).toEqual([H1, H2_HOOK, H3, S1, D1].sort())
  })
})

describe('F-4 直す前の形が戻っていない', () => {
  const OLD_CALLS = [
    'window.electronAPI.hanamii.teardown(projectId, token, projectDir)',     // 【公開】(HanamiiPanel)
    'window.electronAPI.hanamii.teardown(e.hanamiiProjectId, token, e.dir)', // 📡 一覧
    'window.electronAPI.hanamii.teardown(id, token, dir)',                   // プロジェクト削除（Sidebar）
  ]

  it('★★ 直す前の呼び形3つは、src のどこにも無い', () => {
    for (const old of OLD_CALLS) expect(hits(SRC, old), old).toEqual([])
    // 1a-1 の最小の合わせ直し（Sidebar が projectId とトークンを自分で読んで渡した形）も無い
    expect(hits(SRC, 'hanamii.teardown(dir, { token }, { confirmed: true, projectId: id })')).toEqual([])
  })

  it.each([PANEL, H1])('★★ %s: 画面の赤い確認枠と、旧い確認の文が無い', (rel) => {
    const c = code(rel)
    expect(c).not.toContain('window.electronAPI.hanamii.teardown(')
    expect(c).not.toContain('setConfirmDel(')
    expect(c).not.toContain('この公開を破棄（削除）します。公開URLは無効になります。')
  })

  it('★★ 一覧: HANAMII の破棄を自分では呼ばない。トークンと projectId を自分で読んで渡す形も無い', () => {
    const c = code(H2)
    expect(c).not.toContain('hanamii.teardown(')
    expect(c).not.toContain('e.hanamiiProjectId, token, e.dir')
  })

  it.each([SIDEBAR, DIALOG])('★★ %s: 破棄を呼ばない。トークンも projectId も自分では読まない（仕様書が読む）', (rel) => {
    const c = code(rel)
    expect(c).not.toContain('hanamii.teardown(')
    expect(c).not.toContain('getHanamiiToken(')
    expect(c).not.toContain('readHanamiiProjectId(')
    expect(c).not.toContain('clearPublishRecord')
  })

  it('★★ 【公開】(HanamiiPanel) に、破棄の確認枠・破棄の関数・破棄の結果の枝（isDelete）が戻っていない', () => {
    const c = code(PANEL)
    for (const w of ['confirmDel', 'const teardown = async', 'isDelete']) expect(c, w).not.toContain(w)
  })
})

describe('F-5 プロジェクト削除の HANAMII の枝（projectDelete.ts）', () => {
  /** teardownPublished の HANAMII の枝（`t === 'hanamii'` から次の `} else {` まで）。 */
  const branch = () => {
    const c = code(H3)
    const from = c.indexOf("} else if (t === 'hanamii') {")
    expect(from, 'HANAMII の枝が見つからない').toBeGreaterThan(0)
    const rest = c.slice(from)
    // 枝の終わり＝「破棄の枝が無い種類」の else の手前（枝の中にも else があるので、最初の `} else {` では切らない。コメントは code() が除くので、その else の失敗の文で切る）
    const end = rest.indexOf('この画面からは破棄できません')
    expect(end, '破棄の枝が無い種類の else が見つからない').toBeGreaterThan(0)
    return rest.slice(0, end)
  }

  it('★★★ 公開の記録を消す口を持たない（消すのは main の1か所）。トークンも projectId も自分で読まない', () => {
    const b = branch()
    expect(b.length).toBeGreaterThan(100)
    for (const w of ['clearPublishRecord', 'forgetPublishTarget', 'publishMeta', 'getHanamiiToken', 'getHanamiiTokenById', 'readHanamiiProjectId', 'hanamii.teardown(']) expect(b, w).not.toContain(w)
  })

  it('★★★ やめた（cancelled）ときは失敗に積んで、残りの公開先へ進まない（break）。ok:false も失敗に積む（積まれた回は、呼び出し側がフォルダを移さない）', () => {
    const b = branch()
    expect(b).toContain('if (outcome.cancelled) {')
    expect(b).toContain("kind: 'cancelled'")
    expect(b).toContain('破棄をキャンセルしました')
    expect(b).toMatch(/破棄をキャンセルしました[\s\S]*?\n\s*break\n/) // やめたあとで共用型の破棄へ進むと、残すと決めた HANAMII のアプリのデータが消える（振る舞いは hanamiiProjectDelete.test.ts）
    expect(b).toContain("kind: 'failed'")
    expect(b).toContain("const base = `${PUBLISH_TARGET_LABEL[t]}: ${outcome.result.message ?? '原因不明'}`")
    // HANAMII が済んでいない（ok:false）ときも、あとの公開先（共用型・残りの段）は始めない（0.6.24 A-5。振る舞いは tests/projectDeleteLeftoverRun.test.ts の T-A3）
    expect(b).toMatch(/kind: 'failed'[\s\S]*?\n\s*break\n/)
    expect(b).toContain("kind: 'done'")
  })

  it('★★★ 共用型の枝にも公開の記録の掃除は無い（段階2の2d で消した）。projectDelete.ts は記録を消す口そのものを持たない', () => {
    const c = code(H3)
    expect(c).not.toContain('clearPublishRecord')
    expect(c).not.toContain('publishRecord')
    expect(c).not.toContain('forgetPublishTarget')
  })

  it('★★★ フォルダをゴミ箱へ移してよいかは projectDeleteVerdict の 1 つ（失敗が 1 件でもあれば移さない）。ダイアログは自分では判断しない: 押す口 pressProjectDelete に任せ、フォルダを移す口 fs.trash( は deps の 1 か所だけ', () => {
    const c = code(DIALOG)
    expect(c).not.toContain('failed.length')
    expect(c).not.toContain('kept.length')
    expect(c.match(/fs\.trashProject\(/g)).toHaveLength(1) // 0.6.24 E-4: プロジェクトのフォルダを移す口は fs.trashProject（確認の印つき）。汎用の fs.trash( はダイアログに無い
    expect(c).toContain('const r = await window.electronAPI.fs.trashProject(p, { confirmed: true, skippedForTwins })')
    expect(c).not.toContain('fs.trash(')
    // 判断は純関数。済んだが残ったもの（月額が続く保存場所など）は、移す前に結果の欄で見せる（review。移すと保存場所と鍵の唯一の記録も消える）
    const run = code(H3)
    expect(run).toContain('const verdict = projectDeleteVerdict(plan, teardownOnDelete, steps)')
    expect(run).toContain("if (!verdict.moveToTrash) return { phase: 'stopped', steps: all }")
    expect(run).toContain("if (verdict.hold || keptLinesOf(carried).length > 0) return { phase: 'review', steps: all }")
    expect(run.indexOf('projectDeleteVerdict(plan'), '判断が先').toBeLessThan(run.indexOf('moveProjectToTrash(dir, all, deps, skippedForTwinsOf(plan))'))
    // プロジェクトのフォルダを移す口は、Sidebar には無い
    expect(code(SIDEBAR)).not.toContain('fs.trash(path)')
    expect(code(SIDEBAR).match(/fs\.trash\(/g), 'Sidebar のファイルの削除の 1 か所だけ（deleteFileEntry に渡す口。先に fs.trashCheck で聞く）').toHaveLength(1)
  })
})

describe('F-6 新しいファイルは各400行以下。巨大ファイルは破棄の節の分だけ短くなった', () => {
  it.each([MAIN, SPEC, H1, H3, 'tests/hanamiiTeardownEntries.test.ts'])('%s は400行以下', (rel) => {
    expect(fs.existsSync(path.join(ROOT, rel)), rel).toBe(true)
    const n = read(rel).split('\n').length
    expect(n, `${rel} は ${n} 行`).toBeLessThanOrEqual(400)
  })

  it('★ Sidebar.tsx は teardownPublished（約67行）の分だけ短くなった（1,260 行より減っている）', () => {
    expect(read(SIDEBAR).split('\n').length).toBeLessThan(1260)
  })
})
