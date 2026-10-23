import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// ── プロジェクトの削除の入口の網羅（段階3A・3A-5b。設計書 docs/teardown-unify-plan.md の 10.9.13 の F・10.9.11・10.9.15）─────────────
//
// ソースを読んで、呼び出しの形ごと見張る（コメントを除く。当て先が他の行にも出ないか: 数えるのは「呼び出し」や「定義」を一意に指す文字列）。
// 振る舞いは tests/projectDeleteDialog*.test.ts（画面）・projectDeleteRun.test.ts（流れ）・projectDeletePlan.test.ts（判断）が固定する。ここは次を見る:
//   1. 破棄の呼び口は 1 か所（ダイアログ）。Sidebar は削除の中身を持たない
//   2. window.alert・window.confirm は 0 件（ダイアログ・結果の欄）。経路は pressProjectDelete の 1 つ。フォルダを移す口 fs.trash( は 1 か所
//   3. 背景の守り（busy）・確認の要素の置き場所・押せる条件
//   4. 止める文は 1 か所（T094）・T121 の title は無い
//   5. 手動の案内の描き手は ManualTeardownNote だけ
//   6. Sidebar は key つきでダイアログを描く
//   7. 新しいファイルの行数
//   8. 縛り（projectDelete.ts に publishRecord を書かない・材料を読む関数は仕様書も IPC も持たない）

const ROOT = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')
/** コメントを除く（行番号がずれないよう、改行は残す）。文字列の中の `//`（https://…）は直前が空白でないので消えない。 */
const code = (rel: string) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ''))
  .replace(/(^|\s)\/\/[^\n]*/g, (_m, lead: string) => lead)
const lines = (rel: string) => read(rel).split('\n').length

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel)
  }
  return out.sort()
}
const SRC = walk('src')
const RENDERER = SRC.filter(f => f.startsWith('src/renderer/'))
/** コメントを除いた本文に `needle`（文字列）を含む src のファイル。 */
const hits = (files: string[], needle: string) => files.filter(f => code(f).includes(needle))
const count = (rel: string, needle: string) => code(rel).split(needle).length - 1

const SIDEBAR = 'src/renderer/components/Sidebar.tsx'
const DIALOG = 'src/renderer/components/ProjectDeleteDialog.tsx'
const RESULTS = 'src/renderer/components/teardown/ProjectDeleteResults.tsx'
const NOTE = 'src/renderer/components/teardown/ManualTeardownNote.tsx'
const PLAN = 'src/renderer/teardown/projectDeletePlan.ts'
const FACTS = 'src/renderer/teardown/projectDeleteFacts.ts'
const RUN = 'src/renderer/teardown/projectDelete.ts'

describe('F-1 破棄の呼び口は 1 か所（ダイアログ）。Sidebar は削除の中身を持たない', () => {
  it('見張りの前提: 対象のファイルが実在する', () => {
    for (const f of [SIDEBAR, DIALOG, RESULTS, NOTE, PLAN, FACTS, RUN]) expect(SRC, f).toContain(f)
  })

  it('★★★ `teardownPublished(` を呼ぶのは ProjectDeleteDialog.tsx の 1 か所だけ（定義の projectDelete.ts を除く）', () => {
    expect(hits(RENDERER.filter(f => f !== RUN), 'teardownPublished(')).toEqual([DIALOG])
    expect(count(DIALOG, 'teardownPublished(')).toBe(1)
    expect(count(RUN, 'export async function teardownPublished(')).toBe(1)
  })

  it('★★★ Sidebar は削除の中身を持たない（破棄・削除の関数・フォルダを移す口・旧い読み口・選択つきの確認・止める判断・旧い alert）', () => {
    const sidebar = code(SIDEBAR)
    for (const w of [
      'teardownPublished', 'deleteProject', 'fs.trash(path)', 'readPublishTargetsChecked', 'useConfirmChoices', 'blocksProjectDeleteFor',
      'window.alert(`公開の破棄', 'pressProjectDelete', 'runProjectDelete', 'moveProjectToTrash', 'readProjectDeleteFacts', 'planProjectDeleteTeardown',
    ]) expect(sidebar, w).not.toContain(w)
  })

  it('★★ 使い手の無くなった 3 つ（旧い読み口・止めるかを返すだけの薄い関数・レジストリの注記）は src のどこにも定義が無い', () => {
    for (const name of ['readPublishTargetsChecked', 'blocksProjectDeleteFor', 'projectDeleteRegistryNote']) {
      expect(hits(SRC, name), name).toEqual([])
    }
  })
})

describe('F-2 window.alert・window.confirm は 0 件。経路は pressProjectDelete の 1 つ。フォルダを移す口は 1 か所', () => {
  it.each([DIALOG, RESULTS])('★★★ %s に window.alert( ・window.confirm( が無い', (rel) => {
    const c = code(rel)
    expect(c).not.toContain('window.alert(')
    expect(c).not.toContain('window.confirm(')
    expect(c).not.toMatch(/\balert\(/)
  })

  it('★★ Sidebar の window.alert( は、ファイル操作の 6 か所だけ（プロジェクト削除の分は無い）', () => {
    expect(count(SIDEBAR, 'window.alert(')).toBe(6)
    // 6 か所の中に、プロジェクトの削除の文（公開の破棄・プロジェクトを削除できませんでした）は無い
    for (const w of ['公開の破棄', 'プロジェクトを削除できませんでした', 'リソースが残っているため']) expect(code(SIDEBAR), w).not.toContain(w)
  })

  it('★★★ `pressProjectDelete(` を呼ぶのはダイアログの 1 か所。ダイアログは runProjectDelete(・moveProjectToTrash( を直接呼ばない（経路は pressProjectDelete の 1 つ）', () => {
    expect(hits(RENDERER.filter(f => f !== RUN), 'pressProjectDelete(')).toEqual([DIALOG])
    expect(count(DIALOG, 'pressProjectDelete(')).toBe(1)
    const c = code(DIALOG)
    expect(c).not.toContain('runProjectDelete(')
    expect(c).not.toContain('moveProjectToTrash(')
    // 流れの関数を呼ぶのは projectDelete.ts の中だけ
    expect(hits(RENDERER.filter(f => f !== RUN), 'runProjectDelete(')).toEqual([])
    expect(hits(RENDERER.filter(f => f !== RUN), 'moveProjectToTrash(')).toEqual([])
  })

  it('★★★ プロジェクトのフォルダをゴミ箱へ移す `fs.trash(` は、ダイアログの deps の 1 か所。ほかの `fs.trash(` はファイル操作（Sidebar のファイルの削除・使われていないファイルの削除）', () => {
    expect(count(DIALOG, 'fs.trash(')).toBe(1)
    expect(code(DIALOG)).toContain('trash: p => window.electronAPI.fs.trash(p),')
    expect(count(SIDEBAR, 'fs.trash(')).toBe(1)
    expect(code(SIDEBAR)).toContain('fs.trash(entry.path)')
    expect(hits(SRC, 'fs.trash(')).toEqual([DIALOG, SIDEBAR, 'src/renderer/components/AppRunPanel.tsx'].sort())
  })

  it('★★ 公開の記録は、ダイアログでも流れでも消さない（消すのは main の破棄の骨の 1 か所）', () => {
    for (const rel of [DIALOG, RESULTS, RUN, FACTS, PLAN]) {
      const c = code(rel)
      expect(c, rel).not.toContain('clearPublishRecord(')
      expect(c, rel).not.toContain('forgetPublishTarget')
    }
  })
})

describe('F-3 背景の守り・確認の要素の置き場所・押せる条件', () => {
  it('★★★ 背景の onClick は busy の間は閉じない（`if (!busy) onClose()`）。内側の箱は伝播を止める', () => {
    const c = code(DIALOG)
    expect(c).toContain('onClick={() => { if (!busy) onClose() }}')
    expect(c).toContain('onClick={e => e.stopPropagation()}')
  })

  it('★★★ 確認の要素 {element} は、背景の div の外（閉じたあと）に描く。中に描くと、確認の背景を押した click が背景の onClick まで届いて両方閉じる', () => {
    const c = code(DIALOG)
    expect(count(DIALOG, '{element}')).toBe(1)
    const at = c.indexOf('{element}')
    const backdrop = c.lastIndexOf('<div', c.indexOf('fixed inset-0 z-50'))
    expect(backdrop, '背景の div が見つからない').toBeGreaterThanOrEqual(0)
    const before = c.slice(backdrop, at)
    expect((before.match(/<div\b/g) ?? []).length, '{element} が背景の div の中にある').toBe((before.match(/<\/div>/g) ?? []).length)
    expect(c).toContain('const { confirm, confirmWithChoices, element } = useConfirmChoices()')
    expect(count(DIALOG, 'useConfirmChoices()')).toBe(1)
  })

  it('★★★ 押せる条件は 3 つ全部（実行中でない・読み込みが済んでいる・止める理由が無い）。押したときの先頭の守りも同じ。ボタンの title は無い（T121）', () => {
    const c = code(DIALOG)
    expect(c).toContain('disabled={busy || plan === null || plan.block !== null}')
    expect(c).toContain('if (busy || facts === null || plan === null || plan.block !== null) return')
    expect(c).toContain('const plan = facts ? planProjectDeleteTeardown(facts) : null')
    const button = c.slice(c.lastIndexOf('<button', c.indexOf("'🗑 ゴミ箱に移動'")), c.indexOf("'🗑 ゴミ箱に移動'"))
    expect(button).not.toContain('title=')
  })

  it('★★ 読み込みは開いたときに 1 回（依存は projectDir だけ）。閉じたあとの答えは捨てる', () => {
    const c = code(DIALOG)
    expect(count(DIALOG, 'readProjectDeleteFacts(projectDir)')).toBe(1)
    expect(c).toContain('let cancelled = false')
    expect(c).toContain('return () => { cancelled = true }')
    expect(c).toContain('}, [projectDir])')
  })

  it('★★ 押している間は busy を立て、必ず戻す（try / finally）', () => {
    const c = code(DIALOG)
    const body = c.slice(c.indexOf('const press = async () => {'), c.indexOf('const leftoverNote'))
    expect(body).toContain('setBusy(true)')
    expect(body).toMatch(/\} finally \{\s*setBusy\(false\)\s*\}/)
  })
})

describe('F-4 止める文は 1 か所（T094）。T121 の title は無い', () => {
  it('★★★ `projectDeleteBlockNote(` を描くのは、赤い箱（ダイアログ）の 1 か所と、結果の欄の blocked（showBlockNote で重ならない）の 1 か所だけ', () => {
    expect(hits(RENDERER.filter(f => f !== PLAN), 'projectDeleteBlockNote(')).toEqual([DIALOG, RESULTS].sort())
    expect(count(DIALOG, 'projectDeleteBlockNote(')).toBe(1)
    expect(count(RESULTS, 'projectDeleteBlockNote(')).toBe(1)
    expect(code(RESULTS)).toContain("run.phase === 'blocked' && showBlockNote")
    expect(code(DIALOG)).toContain('showBlockNote={plan === null || plan.block === null}')
  })

  it('★★★ T094 の旧い文・T121 の title の文は src のどこにも無い', () => {
    for (const old of [
      '専有型（さくらのAppRun 専有型）のリソースが残っているため',
      '専有型タブに手順6の削除ボタンが出ていないとき（削除するものの記録が無く、公開の記録だけが残っているとき）',
      '専有型を先に専有型タブの手順6で削除してください',
    ]) expect(hits(SRC, old), old).toEqual([])
  })

  it('★★ 止める文の本体（T094 の proposed）は projectDeletePlan.ts の 1 か所にある', () => {
    const t094 = (JSON.parse(read('docs/wording-trim-2026-10.json')).proposals as Array<{ id: string; proposed: string }>).find(p => p.id === 'T094')!.proposed
    const note = t094.replace(/^⚠️ /, '')
    // 文は '…' + '…' で連結されているので、連結を外して突き合わせる
    const plan = read(PLAN).replace(/'\s*\n\s*\+ '/g, '')
    expect(plan).toContain(note)
  })
})

describe('F-4b 画面の文の削減の一覧（wording-trim-2026-10.json）の状態', () => {
  const doc = JSON.parse(read('docs/wording-trim-2026-10.json')) as { counts: { status: Record<string, number> }; proposals: Array<{ id: string; status: string; statusNote?: string }> }

  it('★★ T094・T121 は applied（段階3A で当てた）。T022・T161・T203 も applied（段階3B で当てた）。deferred-teardown は 0 件', () => {
    const by = (id: string) => doc.proposals.find(p => p.id === id)!
    for (const id of ['T094', 'T121']) {
      expect(by(id).status, id).toBe('applied')
      expect(by(id).statusNote, id).toContain('段階3A')
    }
    for (const id of ['T022', 'T161', 'T203']) {
      expect(by(id).status, id).toBe('applied')
      expect(by(id).statusNote, id).toContain('段階3B')
    }
    expect(doc.proposals.filter(p => p.status === 'deferred-teardown').map(p => p.id)).toEqual([])
  })

  it('★ counts.status は、各提案の status の実数と合う（applied 205・deferred-teardown 0・skipped 0）', () => {
    const actual: Record<string, number> = {}
    for (const p of doc.proposals) actual[p.status] = (actual[p.status] ?? 0) + 1
    expect(doc.counts.status).toEqual({ applied: 205, 'deferred-teardown': 0, skipped: 0 })
    expect({ skipped: 0, 'deferred-teardown': 0, ...actual }).toEqual(doc.counts.status)
    expect(read('docs/wording-trim-2026-10.md')).toContain('内訳は applied 205・deferred-teardown 0・skipped 0')
  })
})

describe('F-5 手動の案内の描き手は ManualTeardownNote だけ', () => {
  it('★★★ `src/renderer` で `manualTeardownGuide(` を呼ぶのは ManualTeardownNote.tsx だけ。ダイアログは <ManualTeardownNote target={t} /> を描く', () => {
    expect(hits(RENDERER, 'manualTeardownGuide(')).toEqual([NOTE])
    expect(count(DIALOG, '<ManualTeardownNote target={t} />')).toBe(1)
  })
})

describe('F-6 Sidebar は key つきでダイアログを描く', () => {
  it('★★★ <ProjectDeleteDialog は 1 か所で、key={confirmProjDelete}（別のプロジェクトを開き直したとき、前の材料・結果・チェックを持ち越さない。掟11）', () => {
    expect(count(SIDEBAR, '<ProjectDeleteDialog')).toBe(1)
    expect(code(SIDEBAR)).toMatch(/<ProjectDeleteDialog\s+key=\{confirmProjDelete\}\s+projectDir=\{confirmProjDelete\}/)
    expect(hits(RENDERER, '<ProjectDeleteDialog')).toEqual([SIDEBAR])
  })
})

describe('F-7 新しいファイルの大きさ。Sidebar は 1,209 行から 300 行以上短い', () => {
  it.each([
    [DIALOG, 400], [RESULTS, 150], [PLAN, 300], [FACTS, 150], [NOTE, 40], [RUN, 400],
    ['tests/projectDeleteEntries.test.ts', 400], ['tests/projectDeleteDialog.test.ts', 400], ['tests/projectDeleteDialogPress.test.ts', 400],
    ['tests/projectDeleteDialogHarness.ts', 400], ['tests/projectDeleteResults.test.ts', 400], ['tests/projectDeleteRun.test.ts', 400],
    ['tests/projectDeletePlan.test.ts', 400], ['tests/projectDeleteFacts.test.ts', 400], ['tests/projectDeleteTargets.test.ts', 400],
    ['tests/projectDeleteRunHarness.ts', 400], ['tests/projectDeleteRunNotices.test.ts', 400], ['tests/projectDeleteDialogNotices.test.ts', 400],
  ])('%s は %i 行以下', (rel, max) => {
    expect(lines(rel), `${rel} は ${lines(rel)} 行`).toBeLessThanOrEqual(max)
  })

  it('★ Sidebar.tsx は 1,209 行から 300 行以上短い', () => {
    expect(lines(SIDEBAR)).toBeLessThanOrEqual(1209 - 300)
  })
})

describe('F-8 縛り（既存の入口の網羅テストが割れない置き場）', () => {
  it('★★ projectDelete.ts に公開の記録の読み口（publishRecord）を書かない。読む関数は別ファイル projectDeleteFacts.ts', () => {
    expect(code(RUN)).not.toContain('publishRecord')
    expect(code(FACTS)).toContain("from '../publishRecord'")
  })

  it('★★ 材料を読む関数は、仕様書（sharedTeardownSpec・hanamiiTeardownSpec）も、共用型の記録の IPC（electronAPI.cloud.teardownRecord(）も、`.invoke(` も書かない', () => {
    const c = code(FACTS)
    for (const w of ['sharedTeardownSpec', 'hanamiiTeardownSpec', 'electronAPI.cloud.teardownRecord(', '.invoke(']) expect(c, w).not.toContain(w)
    // 共用型の記録は、仕様書の読み口 readSharedTeardownRecord を通る
    expect(c).toContain('readSharedTeardownRecord(dir)')
  })

  it('★★ コンテナレジストリの名前（cloud.registryName）はどこでも読まない（選ぶのは続く確認）', () => {
    for (const rel of [DIALOG, RESULTS, FACTS, RUN, PLAN]) expect(code(rel), rel).not.toContain('registryName(')
  })

  it('★★ 専有型の手本の 9 ファイルを import しない（ダイアログ・結果の欄・判断・材料）', () => {
    for (const rel of [DIALOG, RESULTS, FACTS, PLAN]) {
      const c = code(rel)
      for (const model of ['dedicatedTeardownFlow', 'useDedicatedTeardown', 'DedicatedTeardownRow', 'DedicatedTeardownView', 'DedicatedOpsParts', 'apprunDedicatedActions', 'apprunDedicatedApply', 'AppRunDedicatedPanel']) {
        expect(c, `${relative('.', rel)} が ${model} を import している`).not.toContain(model)
      }
    }
  })
})

describe('F-9 文書の約束（掟9）: プロジェクトの削除の画面に進み具合は無い。ほかの3つが同じなのは、確認・窓を閉じる警告・結果', () => {
  const README = read('README.md')
  const GUIDE = read('docs/usage-guide.html')

  it('★★★ 前提: プロジェクトの削除の画面は、進み具合の部品も、実行が始まった印（onStart）も持たない。これが変わったら、下の文書の言い方を直す', () => {
    for (const rel of [DIALOG, RESULTS, RUN]) {
      const c = code(rel)
      expect(c, rel).not.toContain('TeardownProgress')
      expect(c, rel).not.toContain('onStart')
      expect(c, rel).not.toContain('onProgress')
    }
  })

  it('★★★ README・使い方ガイドは、「どこから押しても…進み具合…が同じに出る」と言わない。削除の画面に進み具合が出ないことを言う', () => {
    for (const [name, doc] of [['README.md', README], ['usage-guide.html', GUIDE]] as const) {
      expect(doc, `${name}: 進み具合が3つの入口で同じと読める`).not.toContain('進み具合、破棄している間にウィンドウを閉じようとしたときの警告')
      expect(doc, name).toContain('、破棄している間にウィンドウを閉じようとしたときの警告、結果が同じに出ます。ただし進み具合は、プロジェクトの削除の画面には出ません')
    }
  })

  it('★★ 押し直しで増えた注意を見せてから移すことを、文書が言う（ダイアログの seen と noticesAddedSince）', () => {
    for (const [name, doc] of [['README.md', README], ['usage-guide.html', GUIDE]] as const) {
      expect(doc, name).toContain('押し直したとき、公開の記録が読めなくなっていた、または保存場所などの残りが新しく見つかったときは、移さずに注意だけ更新します。見てから、もう一度押してください。')
    }
    expect(code(DIALOG)).toContain('seen: facts')
    expect(code(RUN)).toContain('noticesAddedSince(prev.seen, facts)')
  })
})
