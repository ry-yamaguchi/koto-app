import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ProjectDeleteDialog from '../src/renderer/components/ProjectDeleteDialog'

// ── 本物の React で、ダイアログがそのまま描けること（段階3A・3A-5a）──────────────────────────────────────────
// tests/projectDeleteDialog.test.ts は react を小さな代役に替えて動きを見る。代役は「フックの使い方が本物の React に通るか」を確かめられない
// （条件つきのフック・描けない要素など）。ここは本物の React で、読み込みの前の姿（公開先なし・確認は閉じている）を HTML にする。
// 読み込み（effect）は回らない。window も要らない（描くだけでは触らない）。3A-5b: 読み込みの前は facts が null なので、押せない。

const html = (dir = '/tmp/ws/proj-a') =>
  renderToStaticMarkup(createElement(ProjectDeleteDialog, { projectDir: dir, onClose: () => {}, onDeleted: () => {} }))

describe('ProjectDeleteDialog を本物の React で描く（読み込みの前）', () => {
  it('★ 描ける。プロジェクト名・ゴミ箱へ移す説明・パス・2つのボタンが出る。赤い箱（公開先の一覧）はまだ出ない', () => {
    const h = html()
    expect(h).toContain('プロジェクト「proj-a」を削除しますか？')
    expect(h).toContain('ゴミ箱へ移動</b>します')
    expect(h).toContain('/tmp/ws/proj-a')
    expect(h).toContain('キャンセル</button>')
    expect(h).toContain('🗑 ゴミ箱に移動</button>')
    expect(h).toContain('GitHub に保存したファイル（コード）は<b>そのまま残ります</b>')
    expect(h).not.toContain('このプロジェクトは公開されています')
    expect(h).not.toContain('公開も一緒に破棄する')
  })

  it('★ 背景の div の中に、ダイアログの箱が1つ。パスの最後の1段をプロジェクト名にする。読み込みの前は「🗑 ゴミ箱に移動」を押せない（disabled）', () => {
    const h = html('/Users/x/koto-workspace/my-site')
    expect(h).toContain('プロジェクト「my-site」を削除しますか？')
    // 確認の要素（閉じている）は、背景の div を重ねて描かない。確認の窓は ui/Modal で、z-index を class でなく style に持つので、z-50 の有無によらず数える
    expect(h.match(/fixed inset-0/g)).toHaveLength(1)
    expect(h.match(/fixed inset-0 z-50/g)).toBeNull() // 数えた1つは、このダイアログ自身の背景（Modal。重なりは style の z-index）
    // 読み上げの印: 見出しと説明の id が本文の要素と対応する
    expect(h).toContain('role="dialog"')
    expect(h).toContain('aria-modal="true"')
    expect(h).toContain('aria-labelledby="project-delete-title"')
    expect(h).toContain('aria-describedby="project-delete-note"')
    expect(h).toContain('id="project-delete-title"')
    expect(h).toContain('id="project-delete-note"')
    // 材料を読み終わる前に押すと、公開が無いものとして扱い、破棄も専有型の停止もせずにフォルダが移りうる（3A-5b で押せなくした）
    expect(h).toMatch(/<button[^>]*disabled=""[^>]*>🗑 ゴミ箱に移動<\/button>/)
    expect(h).not.toContain('title=')
    // キャンセルは押せる
    expect(h).not.toMatch(/<button[^>]*disabled=""[^>]*>キャンセル/)
  })

  it('★ 結果の欄（ProjectDeleteResults）は、押す前は描かない', () => {
    expect(html()).not.toContain('data-project-delete-result')
  })
})
