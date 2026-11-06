import { describe, it, expect, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import type { ReactElement } from 'react'

// ── 確認の窓の呼び口 17 か所は、すべて ConfirmModal 1 部品を通る ───────────────────────────────────────
// 確認の窓（枠・読み上げの印・Esc と Tab・フォーカスの復帰）は ui/Modal の上の ConfirmModal だけが持つ。
// 呼び口は useConfirm（13）と useConfirmChoices（4）で、どの画面も自前の確認の窓を描かず、フックが返す element を置く。
// だから「ConfirmModal 本体を直せば 17 か所すべてが直る」。それを 2 つの面から固定する。
//   (1) 呼び口を 1 つずつ書き下す: 呼ぶ形が 1 回だけ・element を置く形・ConfirmModal を直接取り込まない・自前の確認の窓を描かない
//   (2) 両方のフックが返す element は ConfirmModal で、ConfirmModal は alertdialog の Modal を返す
// 一覧に無い呼び口が増えたら、全件の走査で落ちる（足したときは、この一覧にも書き足す）。

const rt = vi.hoisted(() => ({
  slots: [] as unknown[],
  i: 0,
  rerender: () => {},
}))

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>()
  return {
    ...real,
    useState: (init: unknown) => {
      const idx = rt.i++
      if (!(idx in rt.slots)) rt.slots[idx] = typeof init === 'function' ? (init as () => unknown)() : init
      const set = (v: unknown) => {
        const next = typeof v === 'function' ? (v as (p: unknown) => unknown)(rt.slots[idx]) : v
        if (Object.is(next, rt.slots[idx])) return
        rt.slots[idx] = next
        rt.rerender()
      }
      return [rt.slots[idx], set]
    },
    useCallback: (fn: unknown) => fn,
  }
})

import { useConfirm } from '../src/renderer/useConfirm'
import { useConfirmChoices } from '../src/renderer/useConfirmChoices'
import ConfirmModal from '../src/renderer/components/ConfirmModal'
import Modal from '../src/renderer/ui/Modal'

const RENDERER = path.join(__dirname, '..', 'src/renderer')
const read = (rel: string) => fs.readFileSync(path.join(RENDERER, rel), 'utf-8')
const countOf = (src: string, needle: string) => src.split(needle).length - 1

/** 呼び口 1 か所の形。呼ぶ形は 1 回だけ、element を置く形も指定の回数だけ。 */
function expectCallSite(file: string, call: string, placed: string[]) {
  const src = read(file)
  expect(countOf(src, call)).toBe(1)
  for (const p of placed) expect(countOf(src, p)).toBe(1)
  // ConfirmModal を直接取り込まない・描かない（フックを通す）。window.confirm にも戻っていない
  expect(src).not.toMatch(/from '[^']*ConfirmModal'/)
  expect(src).not.toContain('<ConfirmModal')
  expect(src).not.toContain('window.confirm(')
  // 自前の確認の窓（alertdialog の枠）を持たない
  expect(src).not.toContain('role="alertdialog"')
}

describe('useConfirm の呼び口 13 か所', () => {
  it('App.tsx（保存できなかった編集を捨てて、プロジェクトを切り替える・フォルダを整理する）', () => {
    expectCallSite('App.tsx', 'const { confirm: askUser, element: confirmElement } = useConfirm()', ['{confirmElement}'])
  })
  it('AppRunDedicatedPanel.tsx（専有型。作成・公開・破棄の確認）', () => {
    expectCallSite('components/AppRunDedicatedPanel.tsx', 'const { confirm, element: confirmElement } = useConfirm()', ['{confirmElement}'])
  })
  it('RollbackSection.tsx（前のバージョンへ戻す）', () => {
    expectCallSite('components/RollbackSection.tsx', 'const { confirm, element: confirmElement } = useConfirm()', ['{confirmElement}'])
  })
  it('HanamiiTeardownSection.tsx（HANAMII の破棄）', () => {
    expectCallSite('components/HanamiiTeardownSection.tsx', 'const { confirm, element: confirmElement } = useConfirm()', ['{confirmElement}'])
  })
  it('EditorPanel.tsx（未保存のタブを閉じる）', () => {
    expectCallSite('components/EditorPanel.tsx', 'const { confirm, element: confirmElement } = useConfirm()', ['{confirmElement}'])
  })
  it('WorkflowBar.tsx（ツールのインストール）', () => {
    expectCallSite('components/WorkflowBar.tsx', 'const { confirm, element: confirmElement } = useConfirm()', ['{confirmElement}'])
  })
  it('AppRunPanel.tsx（使っていない画像。別名 confirmDialog）', () => {
    expectCallSite('components/AppRunPanel.tsx', 'const { confirm: confirmDialog, element: confirmElement } = useConfirm()', ['{confirmElement}'])
  })
  it('Sidebar.tsx（ファイルの移動・削除。断りの通知 notify も同じフックから）', () => {
    expectCallSite('components/Sidebar.tsx', 'const { confirm, notify, element: confirmElement } = useConfirm()', ['{confirmElement}'])
  })
  it('UnusedFilesSection.tsx（未使用ファイルの移動）', () => {
    expectCallSite('components/UnusedFilesSection.tsx', 'const { confirm, element: confirmElement } = useConfirm()', ['{confirmElement}'])
  })
  it('CredentialsModal.tsx（未保存の破棄・鍵の消去）', () => {
    expectCallSite('components/CredentialsModal.tsx', 'const { confirm, element: confirmElement } = useConfirm()', ['{confirmElement}'])
  })
  it('ChatPanel.tsx（会話の全削除）', () => {
    expectCallSite('components/ChatPanel.tsx', 'const { confirm, element: confirmElement } = useConfirm()', ['{confirmElement}'])
  })
  it('ChatApp.tsx（会話の削除）', () => {
    expectCallSite('components/ChatApp.tsx', 'const { confirm, element: confirmElement } = useConfirm()', ['{confirmElement}'])
  })
  it('SettingsModal.tsx（今月の記録を0に戻す）', () => {
    expectCallSite('components/SettingsModal.tsx', 'const { confirm, element: confirmElement } = useConfirm()', ['{confirmElement}'])
  })
})

describe('useConfirmChoices の呼び口 4 か所', () => {
  it('teardown/useTeardownFlow.ts（📡 の行の破棄。element は戻り値に載せ、TeardownRow が置く）', () => {
    expectCallSite('teardown/useTeardownFlow.ts', 'const { confirm, confirmWithChoices, element: confirmElement } = useConfirmChoices()', ['    confirmElement,\n  }\n}'])
    expect(countOf(read('components/teardown/TeardownRow.tsx'), '{t.confirmElement}')).toBe(1)
  })
  it('ProjectDeleteDialog.tsx（プロジェクトの削除。element は背景の外の兄弟に置く）', () => {
    expectCallSite('components/ProjectDeleteDialog.tsx', 'const { confirm, confirmWithChoices, element } = useConfirmChoices()', ['      {element}\n'])
  })
  it('DedicatedTeardownSection.tsx（専有型の手順6。element は節の描画に置く）', () => {
    expectCallSite('components/DedicatedTeardownSection.tsx', 'const { confirm, element: confirmElement } = useConfirmChoices()', ['      {confirmElement}\n'])
  })
  it('SharedTeardownSection.tsx（共用型の破棄。element は AppRunPanel が置く）', () => {
    expectCallSite('components/SharedTeardownSection.tsx', 'const { confirm, confirmWithChoices, element: confirmElement } = useConfirmChoices()', ['  return { start, confirmElement }'])
    expect(countOf(read('components/AppRunPanel.tsx'), '{sharedTeardown.confirmElement}')).toBe(1)
  })
})

describe('呼び口の全件（一覧に無い呼び口が増えたら落ちる）', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      if (fs.statSync(full).isDirectory()) walk(full, out)
      else if (/\.(ts|tsx)$/.test(name)) out.push(path.relative(RENDERER, full))
    }
    return out
  }
  const files = walk(RENDERER)
  // 行頭のコメント（使い方の例）は数えない
  const using = (needle: string) =>
    files.filter(f => read(f).split('\n').some(l => !l.trim().startsWith('//') && l.includes(needle))).sort()

  it('★★★ `= useConfirm()` を呼ぶファイルは、書き下した 13 個だけ', () => {
    expect(using('= useConfirm()')).toEqual([
      'App.tsx',
      'components/AppRunDedicatedPanel.tsx',
      'components/AppRunPanel.tsx',
      'components/ChatApp.tsx',
      'components/ChatPanel.tsx',
      'components/CredentialsModal.tsx',
      'components/EditorPanel.tsx',
      'components/HanamiiTeardownSection.tsx',
      'components/RollbackSection.tsx',
      'components/SettingsModal.tsx',
      'components/Sidebar.tsx',
      'components/UnusedFilesSection.tsx',
      'components/WorkflowBar.tsx',
    ])
  })

  it('★★★ `= useConfirmChoices()` を呼ぶファイルは、書き下した 4 個だけ', () => {
    expect(using('= useConfirmChoices()')).toEqual([
      'components/DedicatedTeardownSection.tsx',
      'components/ProjectDeleteDialog.tsx',
      'components/SharedTeardownSection.tsx',
      'teardown/useTeardownFlow.ts',
    ])
  })

  it('★★★ ConfirmModal 本体を取り込むのは 2 つのフックだけ（画面が直接取り込んだ自前の確認は無い）', () => {
    const importers = files.filter(f => /^import (?!type)[^\n]*from '[^']*components\/ConfirmModal'/m.test(read(f)))
    expect(importers.sort()).toEqual(['useConfirm.tsx', 'useConfirmChoices.tsx'])
  })
})

describe('ConfirmModal 本体を直せば 16 か所すべてが直る', () => {
  function mountPlain() {
    rt.slots = []
    let latest!: ReturnType<typeof useConfirm>
    const render = () => { rt.i = 0; latest = useConfirm() }
    rt.rerender = render
    render()
    return { get h() { return latest } }
  }
  function mountChoices() {
    rt.slots = []
    let latest!: ReturnType<typeof useConfirmChoices>
    const render = () => { rt.i = 0; latest = useConfirmChoices() }
    rt.rerender = render
    render()
    return { get h() { return latest } }
  }

  it('★★★ useConfirm が返す element は ConfirmModal。開くと alertdialog の Modal を返し、Esc・背景は onCancel（実行ではない）', async () => {
    const m = mountPlain()
    const p = m.h.confirm({ title: 't', body: 'b', danger: true })
    // element は確認（ConfirmModal）と通知（NotifyModal）を並べた Fragment。確認はその1つめ
    const el = (m.h.element as ReactElement<{ children: ReactElement[] }>).props.children[0]
    expect(el.type).toBe(ConfirmModal)
    const shown = ConfirmModal(el.props as any) as ReactElement
    expect(shown.type).toBe(Modal)
    expect((shown.props as any).role).toBe('alertdialog')
    ;(shown.props as any).onRequestClose('escape')
    expect(await p).toBe(false)
  })

  it('★★★ useConfirmChoices が返す element も ConfirmModal。選択つきでも Esc は {confirmed:false, choices:{}}', async () => {
    const m = mountChoices()
    const p = m.h.confirmWithChoices({ title: 't', body: 'b', danger: true, choices: [{ id: 'x', label: 'x', defaultChecked: true }] })
    const el = m.h.element as ReactElement
    expect(el.type).toBe(ConfirmModal)
    const shown = ConfirmModal(el.props as any) as ReactElement
    expect(shown.type).toBe(Modal)
    expect((shown.props as any).role).toBe('alertdialog')
    ;(shown.props as any).onRequestClose('backdrop')
    expect(await p).toEqual({ confirmed: false, choices: {} })
  })
})

describe('最初にキャンセルへフォーカスを置く、お金に触れる赤くない確認 3 か所', () => {
  it('★★★ useAiChat.ts: Claude の同意（Anthropic へ直接課金）。呼び出しの形ごと', () => {
    const src = read('hooks/useAiChat.ts')
    expect(src).toContain("confirmLabel: '同意して使う',\n            danger: false,\n            initialFocus: 'cancel',\n          })")
    expect(countOf(src, "initialFocus: 'cancel'")).toBe(1)
    expect(src).not.toContain("confirmLabel: '同意して使う',\n            danger: false,\n          })")
  })

  it('★★★ RollbackSection.tsx: 公開したものを前のバージョンへ戻す。呼び出しの形ごと', () => {
    const src = read('components/RollbackSection.tsx')
    expect(src).toContain("confirmLabel: '切り替える',\n        initialFocus: 'cancel',\n      })")
    expect(countOf(src, "initialFocus: 'cancel'")).toBe(1)
    expect(src).not.toContain("confirmLabel: '切り替える',\n      })")
  })

  it('★★★ AppRunDedicatedPanel.tsx: 専有型の公開。呼び出しの形ごと（作成の確認は danger: true なので足さない）', () => {
    const src = read('components/AppRunDedicatedPanel.tsx')
    expect(src).toContain("const ok = await confirm({ title: '専有型にアプリを公開します', body: confirmMessage, confirmLabel: '公開する', danger: false, initialFocus: 'cancel' })")
    expect(countOf(src, "initialFocus: 'cancel'")).toBe(1)
    expect(src).not.toContain("confirmLabel: '公開する', danger: false })")
    expect(src).toContain("confirmLabel: '作成する', danger: true })")
  })

  it('★★ 赤くない確認で initialFocus: \'confirm\' を渡している呼び口は無い（実行を初期フォーカスにする例外を作らない）', () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name)
        if (fs.statSync(full).isDirectory()) walk(full, out)
        else if (/\.(ts|tsx)$/.test(name)) out.push(full)
      }
      return out
    }
    const offenders = walk(RENDERER).filter(f => fs.readFileSync(f, 'utf-8').includes("initialFocus: 'confirm'")).map(f => path.relative(RENDERER, f))
    expect(offenders).toEqual([])
  })
})
