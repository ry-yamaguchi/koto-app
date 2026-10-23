import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'

// ── プロジェクトの削除の確認ダイアログ（ProjectDeleteDialog）: 段階3A の検分の指摘 ──────────────────────────────────
//   1. 破棄が済んだあとの赤い箱は、開いたときの材料のままで済んだ破棄を「これから消す」と言い続けない
//      （済んだ公開先を一覧・チェック・💾 から外す。stopped の直後は、pressProjectDelete が読み直した材料で更新する）
//   2. 押し直しで読み直した材料に、見ていない注意（記録が読めなくなった・共用型の残りが出てきた）が増えたら、移さずに箱を描き直す。見てからもう一度押す
// 押したあとの流れは本物。代役は、材料を読む関数と公開先の破棄だけ（tests/projectDeleteDialogPress.test.ts と同じ）。道具は tests/projectDeleteDialogHarness.ts。

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
  facts: { targets: [], unreadable: false, dedicated: null, placements: [], running: null, sharedLeftover: null, sharedRegistry: null } as any,
  readCalls: [] as string[],
  gate: null as Promise<void> | null,
  teardownCalls: [] as Array<{ dir: string; targets: string[]; ctx: any }>,
  teardownResult: (() => Promise.resolve([])) as () => Promise<any[]>,
}))
vi.mock('../src/renderer/teardown/projectDeleteFacts', () => ({
  readProjectDeleteFacts: async (dir: string) => { fake.readCalls.push(dir); if (fake.gate) await fake.gate; return { ...fake.facts } },
}))
vi.mock('../src/renderer/teardown/projectDelete', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/teardown/projectDelete')>()),
  teardownPublished: async (dir: string, targets: string[], ctx: any) => { fake.teardownCalls.push({ dir, targets, ctx }); return fake.teardownResult() },
}))
const onUnhandled = () => {}
process.on('unhandledRejection', onUnhandled)
afterAll(() => { process.off('unhandledRejection', onUnhandled) })

import { createDialogHarness, DIR } from './projectDeleteDialogHarness'

const { t, api, reset, clearCalls, rerender, open, els, paragraphs, checkbox, results, press, done, failed, withFacts, withTargets } = createDialogHarness(hooks, fake)
beforeEach(reset)
afterEach(() => {
  expect(api.alerts, 'プロジェクト削除の window.alert・window.confirm は 0 件').toEqual([])
  expect(t.calls.includes('alert') || t.calls.includes('confirm')).toBe(false)
})

const MOVE = ['runningOp', 'exists', 'trash', 'deleted', 'close'] // フォルダを移す流れ

describe('押す: 破棄が済んだあとの赤い箱は、済んだ破棄を「これから消す」と言わない（検分）', () => {
  const PL = { bucket: 'bkt', prefix: 'projects/a/', shared: false }

  it('★★★ review: 公開先の一覧・チェック・「先に公開を破棄」の文・💾 が消える。読めなかった注意と結果の欄は残る', async () => {
    withFacts({ targets: ['hanamii', 'sakura-apprun'], placements: [PL], unreadable: true })
    fake.teardownResult = async () => [done('hanamii', ['保存場所『bkt』は残しました']), done('sakura-apprun')]
    await open()
    expect(els('li')).toHaveLength(2)
    expect(els('input')).toHaveLength(1)
    expect(paragraphs().some(p => p.includes('先に公開を破棄してから'))).toBe(true)
    await press()
    expect(results()!.run.phase).toBe('review')
    expect(els('li'), '済んだ破棄を、公開されているものとして並べない').toEqual([])
    expect(els('input'), '押しても何も変わらないチェックを出さない').toEqual([])
    expect(paragraphs().some(p => p.includes('このプロジェクトは公開されています'))).toBe(false)
    expect(paragraphs().some(p => p.includes('先に公開を破棄してから') || p.includes('公開はそのまま残ります') || p.startsWith('💾'))).toBe(false)
    expect(paragraphs().some(p => p.includes('公開の記録（.sakuraide.json')), '読めなかったという注意は材料の事実なので残す').toBe(true)
  })

  it('★★★ review でチェックを外し直しても、事実でない文（公開はそのまま残ります・月額）は出ない（箱にチェックが無い）', async () => {
    withFacts({ targets: ['sakura-apprun'], placements: [PL] })
    fake.teardownResult = async () => [done('sakura-apprun', ['保存場所『bkt』は残しました'])]
    await open(); await press()
    expect(results()!.run.phase).toBe('review')
    expect(els('input')).toEqual([])
    expect(paragraphs().some(p => p.includes('月額') && !p.includes('残しました'))).toBe(false)
  })

  it('★★ 移せなかった（trashFailed）: 破棄が済んでいれば箱の一覧は出ない。破棄していない回（チェックを外した）は箱が残る', async () => {
    withTargets(['hanamii'])
    fake.teardownResult = async () => [done('hanamii')]
    api.trash = new Error('権限がありません')
    await open(); await press()
    expect(results()!.run.phase).toBe('trashFailed')
    expect(els('li')).toEqual([])
    expect(els('input')).toEqual([])
    reset()
    withTargets(['hanamii'])
    api.trash = new Error('権限がありません')
    await open()
    checkbox().props.onChange({ target: { checked: false } }); rerender()
    await press()
    expect(results()!.run.phase).toBe('trashFailed')
    expect(fake.teardownCalls).toEqual([])
    expect(els('li').map(el => el.key), '破棄していないので、公開は残っている').toEqual(['hanamii'])
  })

  it('★★ 失敗した公開先は、箱に残る（済んだものだけが外れる）', async () => {
    withTargets(['hanamii', 'sakura-apprun'])
    fake.teardownResult = async () => [done('hanamii'), failed('sakura-apprun', 'さくらのAppRun: 削除できませんでした')]
    await open(); await press()
    expect(results()!.run.phase).toBe('stopped')
    expect(els('li').map(el => el.key)).toEqual(['sakura-apprun'])
    expect(els('input')).toHaveLength(1)
  })
})

describe('押す: 押し直しで増えた注意は、見せてから移す（検分）', () => {
  it('★★★ stopped のあと、押し直したら公開の記録が読めなくなっていた: 移さず、赤い箱に注意を出す。見たあとにもう一度押すと進む（行き止まりにならない）', async () => {
    withTargets(['sakura-apprun'])
    fake.teardownResult = async () => [failed('sakura-apprun', 'さくらのAppRun: 削除できませんでした')]
    await open(); await press()
    expect(results()!.run.phase).toBe('stopped')
    clearCalls(); fake.teardownCalls = []
    withFacts({ targets: [], unreadable: true }) // 読み直しで、公開の記録が読めなかった（公開先が空に見える）
    await press()
    expect(t.calls, '走っている操作の確認も、フォルダを移す操作も、閉じることもしない').toEqual([])
    expect(fake.teardownCalls).toEqual([])
    expect(t.trashed).toEqual([])
    expect(results()!.run.phase, '結果の欄は stopped のまま').toBe('stopped')
    expect(paragraphs().some(p => p.includes('公開の記録（.sakuraide.json')), '新しい赤い箱に、読めなかった注意が出る').toBe(true)
    await press() // 注意を見せたあと
    expect(t.calls).toEqual(MOVE)
    expect(t.trashed).toEqual([DIR])
  })

  it('★★★ 共用型の残り（レジストリ・保存場所）だけが新しく出てきた回も、移さずに💾 を見せる', async () => {
    withTargets(['sakura-apprun'])
    fake.teardownResult = async () => [failed('sakura-apprun', 'さくらのAppRun: 削除できませんでした')]
    await open(); await press()
    clearCalls(); fake.teardownCalls = []
    withFacts({ targets: [], sharedLeftover: { registryName: 'myreg', registryOrigin: 'owned', registryUsers: [], placements: [{ bucket: 'bkt', prefix: 'projects/a/', shared: false }] } })
    await press()
    expect(t.calls).toEqual([])
    expect(t.trashed).toEqual([])
    expect(paragraphs().some(p => p.startsWith('💾') && p.includes('myreg'))).toBe(true)
    await press()
    expect(t.calls).toEqual(MOVE)
  })

  it('★★ 注意が増えていなければ、いつもどおり進む（記録が読めなかったことを、すでに見せていた）', async () => {
    withFacts({ targets: ['sakura-apprun'], unreadable: true })
    fake.teardownResult = async () => [failed('sakura-apprun', 'さくらのAppRun: 削除できませんでした')]
    await open(); await press()
    fake.teardownResult = async () => [done('sakura-apprun')]
    await press()
    expect(t.calls).toEqual(MOVE)
  })
})
