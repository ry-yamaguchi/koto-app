import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── Sidebar とプロジェクトの削除のダイアログのつなぎ目（段階3A・3A-5a。設計書 10.9.5・10.9.11・10.9.13 の F-6・F-7）──────────────
//
// ダイアログの中身（読み込み・描画・押したとき）は tests/projectDeleteDialog.test.ts が振る舞いで固定する。
// ここは Sidebar に**残したもの**だけを、ソースで見る:
//   ・ダイアログを開く口は 3 つのまま（プロジェクトの切り替えの一覧・開いているプロジェクトのメニュー・未オープン画面の一覧）。どれも setConfirmProjDelete(パス) だけ
//   ・ダイアログは key つきで 1 か所だけ描く（別のプロジェクトを開き直したとき、前の材料・チェックを持ち越さない。掟11）
//   ・フォルダを移したあとの後始末 afterProjectDeleted（タブ・旧チャットの記録・最近の一覧・ワークスペースの一覧・開いていたら閉じる・一覧の読み直し）
//   ・削除の状態・読み込み・破棄・フォルダを移す操作は、Sidebar に戻っていない

const ROOT = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')
const code = (rel: string) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ''))
  .replace(/(^|\s)\/\/[^\n]*/g, (_m, lead: string) => lead)

const SIDEBAR = 'src/renderer/components/Sidebar.tsx'
const sidebar = code(SIDEBAR)

describe('Sidebar: ダイアログを開く口は 3 つのまま。開くだけで、状態は持たない', () => {
  it('★★ setConfirmProjDelete( に渡すのは、パス 3 つ（一覧の行・開いているプロジェクト・未オープン画面の行）と、閉じる null の 1 つだけ', () => {
    const args = [...sidebar.matchAll(/setConfirmProjDelete\(([^)]*)\)/g)].map(m => m[1])
    expect(args.sort()).toEqual(['null', 'currentDir', 'p', 'p'].sort())
  })

  it('★★★ <ProjectDeleteDialog は 1 か所だけ。key・projectDir に同じパスを渡し、閉じる口は setConfirmProjDelete(null)、後始末は afterProjectDeleted', () => {
    expect(sidebar.match(/<ProjectDeleteDialog\b/g)).toHaveLength(1)
    expect(sidebar).toMatch(/\{confirmProjDelete && \(\s*<ProjectDeleteDialog\s+key=\{confirmProjDelete\}\s+projectDir=\{confirmProjDelete\}\s+onClose=\{\(\) => setConfirmProjDelete\(null\)\}\s+onDeleted=\{afterProjectDeleted\}\s*\/>\s*\)\}/)
    expect(sidebar).toContain("import ProjectDeleteDialog from './ProjectDeleteDialog'")
  })

  it('★★★ 削除の状態・読み込み・破棄・フォルダを移す操作は Sidebar に無い（ダイアログへ移した）', () => {
    for (const w of [
      'deleteProject', 'pendingPublish', 'publishUnreadable', 'teardownOnDelete', 'deletingBusy', 'pendingRegistry', 'pendingPlacements', 'pendingDedicated',
      'teardownPublished', 'readPublishTargetsChecked', 'blocksProjectDeleteFor', 'useConfirmChoices', 'choicesConfirmElement',
      'registryName(', 'storage.placement(', 'apprunDedicated.state(', 'projectDeleteRegistryNote', 'manualTeardownGuide', 'teardownDataNoteForAll',
    ]) expect(sidebar, w).not.toContain(w)
    expect(sidebar.match(/fs\.trash\(/g), 'ファイルの削除の 1 か所だけ').toHaveLength(1)
    expect(sidebar).toContain('fs.trash(entry.path)')
  })

  it('★ Sidebar は 1,209 行から 300 行以上短くなった（約 330 行をダイアログへ移した。10.9.15 の 7）', () => {
    expect(read(SIDEBAR).split('\n').length).toBeLessThanOrEqual(1209 - 300)
  })

  it('ファイル操作の確認（useConfirm）と要素 {confirmElement} は Sidebar に残る', () => {
    expect(sidebar).toContain("import { useConfirm } from '../useConfirm'")
    expect(sidebar).toContain('const { confirm, element: confirmElement } = useConfirm()')
    expect(sidebar.match(/\{confirmElement\}/g)).toHaveLength(1)
  })
})

describe('Sidebar: afterProjectDeleted（フォルダを移したあとの後始末）', () => {
  const body = () => {
    const from = sidebar.indexOf('const afterProjectDeleted = async (path: string) => {')
    expect(from, 'afterProjectDeleted が無い').toBeGreaterThan(0)
    const to = sidebar.indexOf('await loadWorkspaceProjects()', from)
    expect(to, '一覧の読み直しが無い').toBeGreaterThan(from)
    return sidebar.slice(from, to + 'await loadWorkspaceProjects()'.length)
  }

  it('★★★ このプロジェクトのタブ・旧チャットの記録を消し、最近の一覧とワークスペースの一覧から外す', () => {
    const b = body()
    expect(b).toContain('localStorage.removeItem(`sakura_tabs:${path}`)')
    expect(b).toContain('localStorage.removeItem(`sakura_chat:${path}`)')
    expect(b).toContain('setRecents(prev => {')
    expect(b).toContain('const next = prev.filter(p => p !== path)')
    expect(b).toContain('localStorage.setItem(RECENTS_KEY, JSON.stringify(next))')
    expect(b).toContain('setWorkspaceProjects(prev => prev.filter(p => p !== path))')
  })

  it('★★★ 開いていたプロジェクトを消したら未オープン状態へ戻し、そのあとディスクの実態で一覧を読み直す（消したプロジェクトが一覧に復活しない）', () => {
    const b = body()
    expect(b).toContain('if (path === currentDir) onSetDir(null)')
    expect(b.indexOf('onSetDir(null)')).toBeLessThan(b.indexOf('await loadWorkspaceProjects()'))
    expect(b.indexOf('setWorkspaceProjects(')).toBeLessThan(b.indexOf('onSetDir(null)'))
  })

  it('★★ 後始末はフォルダを移さない・破棄しない（それはダイアログの仕事）', () => {
    const b = body()
    expect(b).not.toContain('fs.trash')
    expect(b).not.toContain('teardown')
    expect(b).not.toContain('window.alert')
  })
})
