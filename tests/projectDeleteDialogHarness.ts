// ProjectDeleteDialog を react の小さな代役の上で動かすテストの共通の道具（段階3A・3A-5a で作り、3A-5b で押す流れに合わせて作り直した。設計書 10.9.13 の E）。
// 使うテスト: tests/projectDeleteDialog.test.ts（開いたとき・描く）・tests/projectDeleteDialogPress.test.ts（押す）。
// vi.mock（react・jsx・projectDeleteFacts・projectDelete〔teardownPublished だけ代役〕）と vi.hoisted の入れ物（hooks・fake）は、テストのファイルの先頭に置く
// （vi.mock はそのファイルの中でしか巻き上げられないため）。ここは、その入れ物を受け取って、窓・描き直し・取り出しの道具を組み立てる。
// 代役のやり方は tests/publishedListDedicatedRow.test.ts と同じ（画面は作らず、**何を描いたか**＝type と props を残す）。
// 押したあとの流れ（pressProjectDelete・runProjectDelete・moveProjectToTrash）は**本物**を走らせる。代役にするのは、材料を読む関数と、公開先の破棄だけ。

import ProjectDeleteDialog from '../src/renderer/components/ProjectDeleteDialog'
import ProjectDeleteResults from '../src/renderer/components/teardown/ProjectDeleteResults'
import type { PublishTargetKind } from '../src/renderer/publishStatus'
import type { ProjectDeleteFacts } from '../src/renderer/teardown/projectDeletePlan'

export type Hooks = {
  states: unknown[]
  effects: { fn: () => void | (() => void); deps: unknown[] | undefined }[]
  index: number
  rendered: { type: unknown; props: any; key: unknown }[]
}
/** 代役: 材料を読む関数（readProjectDeleteFacts）と、公開先の破棄（teardownPublished）。 */
export type Fake = {
  facts: ProjectDeleteFacts
  readCalls: string[]
  /** 材料の答えを返す前に待つ門（読み終わる前に閉じた回・読み込みの前の回を作る）。 */
  gate: Promise<void> | null
  /** opts は teardownPublished の第4引数（残りの段の印。plan.leftover があるときだけ { leftover: { noun } }。無い回は undefined）。 */
  teardownCalls: Array<{ dir: string; targets: string[]; ctx: any; opts?: any }>
  teardownResult: () => Promise<any[]>
}

export const DIR = '/tmp/ws/proj-a'
export const emptyFacts = (): ProjectDeleteFacts => ({ targets: [], unreadable: false, dedicated: null, placements: [], running: null, sharedLeftover: null, sharedRegistry: null, twins: null })

export function createDialogHarness(hooks: Hooks, fake: Fake) {
  /** 画面が呼んだ順（runningOp・exists・trash・close・deleted）と、その中身。'trash' はプロジェクトのフォルダを移す口 fs.trashProject の呼び出し（0.6.24 E-4）。汎用の fs.trash は 'fs.trash' と残す（ここへ来たら失敗）。 */
  const t = { calls: [] as string[], trashed: [] as string[], trashOpts: [] as unknown[], deleted: [] as string[] }
  const api = {
    /** 走っている操作の答え（readRunningOp）。Error なら聞くと投げる。 */
    running: null as { op: '作成' | '削除' | '公開'; target: string } | null | Error,
    exists: true as boolean | Error,
    /** fs.trashProject が「移せません」（ok:false・文つき）と答える。 */
    trash: null as null | Error,
    /** fs.trashProject が投げる（IPC の失敗）。 */
    trashThrows: null as null | Error,
    /** fs.trashProject が返す値そのもの（形の違う答えの試験用）。 */
    trashAnswer: undefined as unknown,
    alerts: [] as string[],
  }
  ;(globalThis as any).window = {
    // 画面が window.alert を呼んだら失敗にする（プロジェクト削除の window.alert は 0 件。呼ばれたら記録して、テストが見つける）
    alert: (m: string) => { t.calls.push('alert'); api.alerts.push(m) },
    confirm: () => { t.calls.push('confirm'); return true },
    electronAPI: {
      publishMeta: { runningOp: async () => { t.calls.push('runningOp'); if (api.running instanceof Error) throw api.running; return api.running } },
      fs: {
        exists: async () => { t.calls.push('exists'); if (api.exists instanceof Error) throw api.exists; return api.exists },
        trashProject: async (p: string, opts: unknown) => {
          t.calls.push('trash'); t.trashed.push(p); t.trashOpts.push(opts)
          if (api.trashThrows) throw api.trashThrows
          if (api.trashAnswer !== undefined) return api.trashAnswer
          return api.trash ? { ok: false, message: api.trash.message } : { ok: true }
        },
        trash: async (p: string) => { t.calls.push('fs.trash'); t.trashed.push(p) },
      },
    },
  }
  const props = {
    projectDir: DIR,
    onClose: () => { t.calls.push('close') },
    onDeleted: async (p: string) => { t.calls.push('deleted'); t.deleted.push(p) },
  }

  const reset = () => {
    t.calls.length = 0; t.trashed.length = 0; t.trashOpts.length = 0; t.deleted.length = 0; api.alerts.length = 0
    fake.facts = emptyFacts(); fake.readCalls = []; fake.gate = null
    fake.teardownCalls = []; fake.teardownResult = () => Promise.resolve([])
    api.running = null; api.exists = true; api.trash = null; api.trashThrows = null; api.trashAnswer = undefined
  }
  const clearCalls = () => { t.calls.length = 0; api.alerts.length = 0 }

  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await new Promise(r => setTimeout(r, 0))
  }
  /** 今の状態のまま描き直す（state は持ち越す。effect は回さない）。 */
  function rerender(): void {
    hooks.index = 0; hooks.effects = []; hooks.rendered = []
    ProjectDeleteDialog(props)
  }
  /** 描くだけ（読み込み〔effect〕は回さない）。 */
  function render(): void {
    hooks.states = []; hooks.effects = []; hooks.index = 0; hooks.rendered = []
    ProjectDeleteDialog(props)
  }
  /** 描いて、開いたときの読み込み（effect）を回す。cleanup の関数を返す。読み終わるのは待たない。 */
  function mount(): Array<() => void> {
    hooks.states = []; hooks.effects = []; hooks.index = 0; hooks.rendered = []
    ProjectDeleteDialog(props)
    return hooks.effects.map(e => e.fn() as () => void)
  }
  /** 開く（描く → 読み込みを回す → 読み終わるのを待つ → 描き直す）。effect の一覧を返す。 */
  async function open() {
    hooks.states = []; hooks.effects = []; hooks.index = 0; hooks.rendered = []
    ProjectDeleteDialog(props)
    const effects = hooks.effects
    for (const e of effects) e.fn()
    await settle()
    rerender()
    return effects
  }

  const els = (type: unknown) => hooks.rendered.filter(el => el.type === type)
  const textOf = (p: any): string => {
    const flat = (c: any): string => Array.isArray(c) ? c.map(flat).join('') : (typeof c === 'string' || typeof c === 'number') ? String(c) : ''
    return flat(p?.children)
  }
  const paragraphs = () => els('p').map(el => textOf(el.props))
  const mainButton = () => hooks.rendered.find(el => el.type === 'button' && /ゴミ箱に移動|破棄しています/.test(textOf(el.props)))!
  const cancelButton = () => hooks.rendered.find(el => el.type === 'button' && /^キャンセル$/.test(textOf(el.props)))!
  const checkbox = () => els('input')[0]
  const backdrop = () => hooks.rendered.find(el => el.type === 'div' && String(el.props.className).includes('fixed inset-0'))!
  /** 結果の欄（ProjectDeleteResults）に渡された props。描いていなければ undefined。 */
  const results = () => els(ProjectDeleteResults)[0]?.props as { run: any; showBlockNote: boolean } | undefined
  const press = async () => { const p = mainButton().props.onClick(); await p; await settle(); rerender() }

  const done = (target: PublishTargetKind, warnings: string[] = []) => ({ target, kind: 'done', view: { warnings }, words: {} })
  const failed = (target: PublishTargetKind, line: string) => ({ target, kind: 'failed', line, view: null, words: null })
  const cancelled = (target: PublishTargetKind, line: string) => ({ target, kind: 'cancelled', line })
  const nothingToDo = (target: PublishTargetKind, message = '破棄するものはありません') => ({ target, kind: 'nothingToDo', message })
  /** 開いたときに読まれる材料。公開先だけ変えたいときの近道。 */
  const withFacts = (over: Partial<ProjectDeleteFacts>) => { fake.facts = { ...emptyFacts(), ...over } }
  const withTargets = (targets: PublishTargetKind[], unreadable = false) => withFacts({ targets, unreadable })

  return {
    t, api, props, reset, clearCalls, settle, rerender, render, mount, open, els, textOf, paragraphs, mainButton, cancelButton, checkbox, backdrop, results, press,
    done, failed, cancelled, nothingToDo, withFacts, withTargets,
  }
}
