import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'

// ── プロジェクトの削除の確認ダイアログ（ProjectDeleteDialog）を、振る舞いで固定する: 押したとき（段階3A・3A-5a で作り、3A-5b で pressProjectDelete の流れに作り直した。設計書 10.9.4・10.9.5・10.9.13 の E）──────
// 押したあとの流れ（pressProjectDelete → runProjectDelete → moveProjectToTrash）は**本物**を走らせ、画面がそれをどう呼び、結果をどう出すかを見る。
// 代役にするのは、材料を読む関数（readProjectDeleteFacts）と、公開先の破棄（teardownPublished）だけ。流れそのものの場合分けは tests/projectDeleteRun.test.ts が固定する。
// **プロジェクト削除の window.alert は 0 件**: どのテストの終わりにも、alert も confirm も呼ばれていないことを確かめる（afterEach）。
// 道具は tests/projectDeleteDialogHarness.ts（vi.mock と入れ物 hooks・fake はこのファイルの先頭に置く）。

const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  effects: [] as { fn: () => void | (() => void); deps: unknown[] | undefined }[],
  index: 0,
  rendered: [] as { type: unknown; props: any; key: unknown }[],
}))
vi.mock('react', () => ({
  useState: (init: unknown) => {
    const i = hooks.index++
    if (hooks.states.length <= i) hooks.states.push(typeof init === 'function' ? (init as () => unknown)() : init)
    return [hooks.states[i], (v: unknown) => { hooks.states[i] = typeof v === 'function' ? (v as (p: unknown) => unknown)(hooks.states[i]) : v }]
  },
  useEffect: (fn: () => void | (() => void), deps: unknown[] | undefined) => { hooks.effects.push({ fn, deps }) },
  useCallback: (fn: unknown) => fn,
  useMemo: (fn: () => unknown) => fn(),
  useRef: (v: unknown) => ({ current: v }),
  default: {},
}))
vi.mock('react/jsx-runtime', () => {
  const jsx = (type: unknown, props: any, key?: unknown) => { hooks.rendered.push({ type, props, key }); return null }
  return { jsx, jsxs: jsx, Fragment: () => null }
})
vi.mock('react/jsx-dev-runtime', () => {
  const jsxDEV = (type: unknown, props: any, key?: unknown) => { hooks.rendered.push({ type, props, key }); return null }
  return { jsxDEV, Fragment: () => null }
})
const fake = vi.hoisted(() => ({
  facts: { targets: [], unreadable: false, dedicated: null, placements: [], running: null, sharedLeftover: null, sharedRegistry: null, twins: null } as any,
  readCalls: [] as string[],
  gate: null as Promise<void> | null,
  teardownCalls: [] as Array<{ dir: string; targets: string[]; ctx: any; opts?: any }>,
  teardownResult: (() => Promise.resolve([])) as () => Promise<any[]>,
}))
vi.mock('../src/renderer/teardown/projectDeleteFacts', () => ({
  readProjectDeleteFacts: async (dir: string) => { fake.readCalls.push(dir); if (fake.gate) await fake.gate; return { ...fake.facts } },
}))
vi.mock('../src/renderer/teardown/projectDelete', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/teardown/projectDelete')>()),
  teardownPublished: async (dir: string, targets: string[], ctx: any, opts?: any) => { fake.teardownCalls.push({ dir, targets, ctx, opts }); return fake.teardownResult() },
}))
const onUnhandled = () => {}
process.on('unhandledRejection', onUnhandled)
afterAll(() => { process.off('unhandledRejection', onUnhandled) })

import { createDialogHarness, DIR } from './projectDeleteDialogHarness'

const { t, api, props, reset, clearCalls, settle, rerender, mount, open, els, textOf, paragraphs, mainButton, cancelButton, checkbox, backdrop, results, press, done, failed, cancelled, nothingToDo, withFacts, withTargets } = createDialogHarness(hooks, fake)
beforeEach(reset)
afterEach(() => {
  expect(api.alerts, 'プロジェクト削除の window.alert・window.confirm は 0 件').toEqual([])
  expect(t.calls.includes('alert') || t.calls.includes('confirm')).toBe(false)
})

const MOVE = ['runningOp', 'exists', 'trash', 'deleted', 'close'] // フォルダを移す流れ（走っている操作を聞き直す → あるか → 移す → 後始末 → 閉じる）

describe('押す: 押せない回は、押されても（最後の砦）何も起こさない', () => {
  it('★★★ 読み込みの前は、ボタンの onClick を直に呼んでも何もしない（破棄も、走っている操作の確認も、フォルダを移す操作も、閉じることもしない）', async () => {
    withTargets(['hanamii'])
    fake.gate = new Promise<void>(() => {}) // 材料が届かないまま
    const cleanups = mount()
    await settle(); rerender()
    expect(mainButton().props.disabled).toBe(true)
    await press() // ボタンの onClick を直に呼ぶ（押し終わるのを待って、描き直す）
    expect(t.calls).toEqual([])
    expect(fake.teardownCalls).toEqual([])
    expect(results()).toBeUndefined()
    expect(paragraphs().some(p => p.includes('エラーが発生')), '先頭の守りで止まる（読み込みの前の plan を触って落ちるのではない）').toBe(false)
    for (const c of cleanups) c()
  })

  it('★★★ 専有型で止まる回（・保存場所だけ残った回・公開が進んでいる回）は、押されても破棄もフォルダを移す操作もしない', async () => {
    for (const over of [
      { targets: ['sakura-apprun-dedicated', 'hanamii'] as const, dedicated: null, running: null },
      { targets: [] as const, dedicated: { storageLeftoverBucket: 'koto-left' }, running: null },
      { targets: ['hanamii'] as const, dedicated: null, running: { op: '公開', target: 'hanamii' } as const },
    ]) {
      clearCalls(); fake.teardownCalls = []
      withFacts({ ...over, targets: [...over.targets] }); await open()
      expect(mainButton().props.disabled).toBe(true)
      await press() // ボタンの onClick を直に呼ぶ（押し終わるのを待って、描き直す）
      expect(t.calls, JSON.stringify(over)).toEqual([])
      expect(fake.teardownCalls).toEqual([])
      expect(results(), '止める理由がある回は、結果の欄（blocked）も出さない').toBeUndefined()
      expect(paragraphs().some(p => p.includes('エラーが発生'))).toBe(false)
    }
  })
})

describe('押す: 全部済んだら、フォルダを移して、後始末を呼んで閉じる', () => {
  it('★★★ 破棄する回: 先に破棄する公開先を（HANAMII → 共用型の順で）渡し、全部済んだらフォルダを移し、後始末 → 閉じる。結果の欄は出さない', async () => {
    withTargets(['sakura-apprun', 'vercel', 'hanamii'])
    fake.teardownResult = async () => [done('hanamii'), done('sakura-apprun')]
    await open(); await press()
    expect(fake.teardownCalls).toHaveLength(1)
    expect(fake.teardownCalls[0].dir).toBe(DIR)
    expect(fake.teardownCalls[0].targets).toEqual(['hanamii', 'sakura-apprun'])
    expect(typeof fake.teardownCalls[0].ctx.confirm).toBe('function')
    expect(typeof fake.teardownCalls[0].ctx.confirmWithChoices).toBe('function')
    expect(t.calls).toEqual(MOVE)
    expect(t.trashed).toEqual([DIR])
    expect(t.deleted).toEqual([DIR])
    expect(results()).toBeUndefined()
  })

  it('★★★ フォルダを移す口は fs.trashProject を { confirmed: true, skippedForTwins: [] } つきで 1 回だけ（複製を外した公開先が無ければ空）（汎用の fs.trash は呼ばない。呼べば calls に fs.trash が残る）', async () => {
    withTargets([]); await open(); await press()
    expect(t.calls).toEqual(MOVE)
    expect(t.calls).not.toContain('fs.trash')
    expect(t.trashOpts).toEqual([{ confirmed: true, skippedForTwins: [] }])
    expect(t.trashed).toEqual([DIR])
  })

  it('★★★ 破棄の口が無い公開先（Vercel・レンタルサーバ）だけなら、破棄は呼ばずにそのまま移す', async () => {
    withTargets(['vercel', 'sakura-rental']); await open(); await press()
    expect(fake.teardownCalls).toEqual([])
    expect(t.calls).toEqual(MOVE)
  })

  it('★★★ チェックを外した回は、破棄を呼ばずに移す（公開は残る）', async () => {
    withTargets(['hanamii', 'sakura-apprun']); await open()
    checkbox().props.onChange({ target: { checked: false } }); rerender()
    await press()
    expect(fake.teardownCalls).toEqual([])
    expect(t.calls).toEqual(MOVE)
  })

  it('★★ 「破棄するものはありません」（nothingToDo）だけの回は、成功として移す（幽霊の行でフォルダを移せなくならない）', async () => {
    withTargets(['sakura-apprun'])
    fake.teardownResult = async () => [nothingToDo('sakura-apprun')]
    await open(); await press()
    expect(t.calls).toEqual(MOVE)
  })

  it('★★ フォルダがもう無い（一覧が古かった）ときは、移さずに後始末だけ呼ぶ', async () => {
    withTargets([]); api.exists = false; await open(); await press()
    expect(t.calls).toEqual(['runningOp', 'exists', 'deleted', 'close'])
    expect(t.trashed).toEqual([])
  })

  it('★★ 後始末が投げても、ダイアログは閉じる（フォルダはもう移っている）。busy は戻る', async () => {
    withTargets([]); await open()
    const original = props.onDeleted
    props.onDeleted = async () => { t.calls.push('deleted'); throw new Error('一覧の読み直しに失敗') }
    rerender() // 後始末の口は、描いたときの props から取る
    try {
      await press()
      expect(t.calls).toEqual(MOVE)
      expect(mainButton().props.disabled).toBe(false)
    } finally {
      props.onDeleted = original
    }
  })
})

describe('押す: 破棄が済まなかった回（stopped）は、フォルダを移さず、結果の欄に出す', () => {
  it('★★★ 失敗が 1 件でもあれば、閉じも移しもしない。結果の欄に済んだ分も失敗も出る。ボタンは元の文字に戻り、もう一度押せる', async () => {
    withTargets(['hanamii', 'sakura-apprun'])
    fake.teardownResult = async () => [done('hanamii'), failed('sakura-apprun', 'さくらのAppRun: 削除できませんでした')]
    await open(); await press()
    expect(t.calls, '走っている操作の確認・フォルダの有無・移す操作・閉じることを、どれもしない').toEqual([])
    expect(results()!.run.phase).toBe('stopped')
    expect(results()!.run.steps.map((s: any) => [s.target, s.kind])).toEqual([['hanamii', 'done'], ['sakura-apprun', 'failed']])
    expect(textOf(mainButton().props)).toBe('🗑 ゴミ箱に移動')
    expect(mainButton().props.disabled).toBe(false)
    expect(textOf(cancelButton().props)).toBe('キャンセル')
  })

  it('★★★ やめた（cancelled）も、移さずに結果の欄へ。残りの公開先の破棄は始めていない', async () => {
    withTargets(['hanamii', 'sakura-apprun'])
    fake.teardownResult = async () => [cancelled('hanamii', 'HANAMII: 破棄をキャンセルしました。さくらのAppRunの破棄も始めていません')]
    await open(); await press()
    expect(t.calls).toEqual([])
    expect(results()!.run.phase).toBe('stopped')
    expect(fake.teardownCalls).toHaveLength(1)
  })

  it('★★★ 押し直し（stopped のあと）: 材料を読み直し、残った公開先の破棄だけをやり直す。済んだ公開先（HANAMII）の破棄は走らせ直さない', async () => {
    withTargets(['hanamii', 'sakura-apprun'])
    fake.teardownResult = async () => {
      withTargets(['sakura-apprun']) // main は HANAMII の破棄が済むと projectId と行を外す。stopped の直後の読み直しには HANAMII が出てこない
      return [done('hanamii', ['保存場所「koto-data」は残しました']), failed('sakura-apprun', 'さくらのAppRun: 削除できませんでした')]
    }
    await open(); await press()
    expect(fake.readCalls, '開いたときと、stopped の直後に読む').toEqual([DIR, DIR])
    // 読み直した材料で、箱の一覧が最新になる（済んだ HANAMII を「公開されています」に出さない）
    expect(els('li').map(el => el.key)).toEqual(['sakura-apprun'])
    fake.teardownResult = async () => [done('sakura-apprun')]
    await press()
    expect(fake.readCalls, '押し直しでも材料を読み直す').toEqual([DIR, DIR, DIR])
    expect(fake.teardownCalls.map(c => c.targets)).toEqual([['hanamii', 'sakura-apprun'], ['sakura-apprun']])
    // 1 回目に済んだ HANAMII の知らせ（残した保存場所）は失わず、見せてから移す（review）
    expect(results()!.run.phase).toBe('review')
    expect(results()!.run.steps.map((s: any) => [s.target, s.kind])).toEqual([['hanamii', 'done'], ['sakura-apprun', 'done']])
    expect(t.calls).toEqual([])
    // 全部済んだ（review）ので、箱の一覧はもう出ない
    expect(els('li')).toEqual([])
  })

  it('★★ 押し直しで全部済んだ（警告なし）なら、フォルダを移して閉じる', async () => {
    withTargets(['hanamii', 'sakura-apprun'])
    fake.teardownResult = async () => [done('hanamii'), failed('sakura-apprun', 'さくらのAppRun: 削除できませんでした')]
    await open(); await press()
    withTargets(['sakura-apprun'])
    fake.teardownResult = async () => [done('sakura-apprun')]
    await press()
    expect(t.calls).toEqual(MOVE)
  })
})

describe('押す: 済んだが残ったものがある回（review）は、見せてから、もう一度押したときに移す', () => {
  const setup = async () => {
    withTargets(['hanamii'])
    fake.teardownResult = async () => [done('hanamii', ['保存場所「koto-data」は残しました'])]
    await open(); await press()
  }

  it('★★★ 1 回目は移さず、結果の欄に残ったものを出す。キャンセルの文字は、最初の回と同じ「キャンセル」のまま', async () => {
    await setup()
    expect(t.calls, '移す前に見せる（移すと保存場所と鍵の唯一の記録も消える）').toEqual([])
    expect(results()!.run.phase).toBe('review')
    expect(results()!.run.steps[0].view.warnings).toEqual(['保存場所「koto-data」は残しました'])
    expect(textOf(cancelButton().props), '済んだが残った回も、取り消しのボタンは「キャンセル」（「移さずに閉じる」ではない）').toBe('キャンセル')
    expect(cancelButton().props.onClick).toBe(props.onClose)
    expect(mainButton().props.disabled).toBe(false)
  })

  it('★★★ 2 回目に押すと移す。破棄はもう一度走らせず、材料も読み直さない', async () => {
    await setup()
    await press()
    expect(fake.teardownCalls, '破棄は 1 回だけ').toHaveLength(1)
    expect(fake.readCalls, '材料は開いたときの 1 回だけ').toEqual([DIR])
    expect(t.calls).toEqual(MOVE)
  })

  it('★★ 結果を見せている回の「キャンセル」は onClose だけ。フォルダは移さない', async () => {
    await setup()
    clearCalls()
    cancelButton().props.onClick()
    expect(t.calls).toEqual(['close'])
    expect(t.trashed).toEqual([])
  })
})

describe('押す: フォルダを移せなかった回（trashFailed）は、移すだけをやり直す', () => {
  it('★★★ 移せなかった（trash が投げる）→ 結果の欄に理由。後始末は呼ばない。もう一度押すと、破棄は走らせず、移すだけをやり直す', async () => {
    withTargets(['hanamii'])
    fake.teardownResult = async () => [done('hanamii')]
    api.trash = new Error('権限がありません')
    await open(); await press()
    expect(results()!.run).toMatchObject({ phase: 'trashFailed', message: 'プロジェクトを削除できませんでした: 権限がありません' })
    expect(t.calls).toEqual(['runningOp', 'exists', 'trash'])
    expect(t.deleted).toEqual([])
    clearCalls()
    api.trash = null
    await press()
    expect(fake.teardownCalls, '破棄は走らせ直さない').toHaveLength(1)
    expect(fake.readCalls, '材料も読み直さない').toEqual([DIR])
    expect(t.calls).toEqual(MOVE)
  })

  it('★★★ main が移さなかった（ok:false・文つき）→ 移せなかった扱い。後始末も閉じるも呼ばない', async () => {
    withTargets([]); api.trash = new Error('このプロジェクトで処理が進んでいます。終わってから、もう一度削除してください。'); await open(); await press()
    expect(results()!.run).toMatchObject({ phase: 'trashFailed', message: 'プロジェクトを削除できませんでした: このプロジェクトで処理が進んでいます。終わってから、もう一度削除してください。' })
    expect(t.calls).toEqual(['runningOp', 'exists', 'trash'])
    expect(t.deleted).toEqual([])
  })

  it('★★★ main の呼び出しが投げた（IPC の失敗）・形の違う答え（undefined・null・{}・ok が true でない）は、どれも移せなかった扱い（移せた扱いにしない）', async () => {
    withTargets([]); api.trashThrows = new Error('IPC 失敗'); await open(); await press()
    expect(results()!.run).toMatchObject({ phase: 'trashFailed', message: 'プロジェクトを削除できませんでした: IPC 失敗' })
    expect(t.deleted).toEqual([])
    for (const odd of [null, {}, { ok: 'yes' }, { ok: 1 }, 'ok']) {
      reset(); withTargets([]); api.trashAnswer = odd; await open(); await press()
      expect(results()!.run, JSON.stringify(odd)).toMatchObject({ phase: 'trashFailed', message: 'プロジェクトを削除できませんでした: 原因不明' })
      expect(t.deleted, JSON.stringify(odd)).toEqual([])
      expect(t.calls, JSON.stringify(odd)).not.toContain('close')
    }
  })

  it('★★ 存在の確認が投げた回も、移せなかった扱い（理由は元の文）', async () => {
    withTargets([]); api.exists = new Error('IPC 失敗'); await open(); await press()
    expect(results()!.run).toMatchObject({ phase: 'trashFailed', message: 'プロジェクトを削除できませんでした: IPC 失敗' })
    expect(t.deleted).toEqual([])
  })
})

describe('押す: 公開・破棄・作成が進んでいる間は、移さない（移す直前にもう一度聞く）', () => {
  it('★★★ 開いたときは走っていなかったが、移す直前には走っていた → 移さず、結果の欄に止める文（赤い箱はまだ同じ文を出していないので showBlockNote が true）', async () => {
    withTargets([]); await open()
    api.running = { op: '公開', target: 'hanamii' }
    await press()
    expect(t.calls, '聞いたあと、あるか確かめることも移すこともしない').toEqual(['runningOp'])
    expect(results()!.run).toMatchObject({ phase: 'blocked', block: { reason: 'running', op: '公開', target: 'hanamii' } })
    expect(results()!.showBlockNote).toBe(true)
    expect(mainButton().props.disabled).toBe(false)
  })

  it('★★★ 移す直前に走っていたのが共用型・HANAMII の破棄・専有型の削除 → 止める理由に公開先が載る（結果の欄が「破棄が進んでいます」「削除が進んでいます」と言い分ける材料。文は tests/projectDeleteResults.test.ts）', async () => {
    for (const target of ['sakura-apprun', 'hanamii', 'sakura-apprun-dedicated'] as const) {
      withTargets([]); await open()
      api.running = { op: '削除', target }
      await press()
      expect(results()!.run, target).toMatchObject({ phase: 'blocked', block: { reason: 'running', op: '削除', target } })
      expect(results()!.showBlockNote, target).toBe(true)
    }
  })

  it('★★ そのあと押し直すと材料を読み直す。まだ走っていれば、赤い箱が同じ文を出してボタンが止まり、結果の欄は文を重ねない', async () => {
    withTargets([]); await open()
    api.running = { op: '公開', target: 'hanamii' }
    await press()
    withFacts({ running: { op: '公開', target: 'hanamii' } })
    await press()
    expect(fake.readCalls).toEqual([DIR, DIR])
    expect(paragraphs().filter(p => p.includes('が進んでいます'))).toEqual(['⚠️ いまこのプロジェクトの公開が進んでいます。終わってから、もう一度このプロジェクトを削除してください。'])
    expect(mainButton().props.disabled).toBe(true)
    expect(results()!.run.phase).toBe('blocked')
    expect(results()!.showBlockNote).toBe(false)
  })
})

describe('押す: 押している間（busy）と、思いがけない失敗', () => {
  it('★★★ 破棄している間: 文字が変わり、ボタン・チェック・キャンセルが止まり、背景を押しても閉じない。終わったら背景で閉じられる', async () => {
    withTargets(['hanamii'])
    let release: (v: any[]) => void = () => {}
    fake.teardownResult = () => new Promise(r => { release = r })
    await open()
    const pressing = mainButton().props.onClick()
    await settle(); rerender()
    expect(textOf(mainButton().props)).toBe('公開を破棄しています…')
    expect(mainButton().props.disabled).toBe(true)
    expect(cancelButton().props.disabled).toBe(true)
    expect(checkbox().props.disabled).toBe(true)
    backdrop().props.onClick()
    expect(t.calls, '破棄の実行中は、背景を押しても閉じない（確認の答えを返せなくなる）').toEqual([])
    release([failed('hanamii', 'HANAMII: 失敗')])
    await pressing; await settle(); rerender()
    expect(textOf(mainButton().props)).toBe('🗑 ゴミ箱に移動')
    expect(checkbox().props.disabled).toBe(false)
    clearCalls()
    backdrop().props.onClick()
    expect(t.calls).toEqual(['close'])
  })

  it('★★★ 押している間にもう一度押されても、二重に走らない（破棄は 1 回）', async () => {
    withTargets(['hanamii'])
    let release: (v: any[]) => void = () => {}
    fake.teardownResult = () => new Promise(r => { release = r })
    await open()
    const first = mainButton().props.onClick()
    await settle(); rerender()
    await mainButton().props.onClick() // busy の間の 2 回目（ボタンは止まっているが、呼ばれても何もしない）
    expect(fake.teardownCalls).toHaveLength(1)
    release([done('hanamii')])
    await first; await settle()
    expect(t.trashed).toEqual([DIR])
  })

  it('★★★ 破棄の関数が投げた（思いがけない失敗）→ フォルダは移さず、理由を選択できる形で出し、busy は戻る。もう一度押せる', async () => {
    withTargets(['hanamii'])
    fake.teardownResult = async () => { throw new Error('想定外') }
    await open(); await press()
    expect(t.calls).toEqual([])
    expect(paragraphs()).toContain('⚠️ プロジェクトの削除の途中でエラーが発生しました: 想定外')
    expect(mainButton().props.disabled).toBe(false)
    expect(textOf(mainButton().props)).toBe('🗑 ゴミ箱に移動')
    const warn = els('p').find(el => textOf(el.props).includes('想定外'))!
    expect(String(warn.props.className)).toContain('select-text')
    fake.teardownResult = async () => [done('hanamii')]
    await press()
    expect(t.calls).toEqual(MOVE)
    expect(paragraphs().some(p => p.includes('想定外'))).toBe(false)
  })

  it('★ キャンセルのボタンは onClose。ダイアログの中を押しても背景の onClick（閉じる）に届かない', async () => {
    await open()
    expect(cancelButton().props.onClick).toBe(props.onClose)
    const inner = hooks.rendered.find(el => el.type === 'div' && String(el.props.className).includes('bg-elevated'))!
    let stopped = 0
    inner.props.onClick({ stopPropagation: () => { stopped++ } })
    expect(stopped).toBe(1)
  })
})
