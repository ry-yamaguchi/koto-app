import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── プロジェクトの削除の確認ダイアログ（ProjectDeleteDialog）を、振る舞いで固定する（段階3A・3A-5a で作り、3A-5b で材料の読み方と押せる条件に合わせて作り直した。設計書 10.9.5・10.9.13 の E）──────
// react の小さな代役の上で**実際に動かし**、(1)開いたときに何を読むか (2)何を描くか を見る。押したときは tests/projectDeleteDialogPress.test.ts。
// 材料を読む関数（readProjectDeleteFacts。読み方そのものは tests/projectDeleteFacts.test.ts）と、公開先の破棄（teardownPublished。
// tests/hanamiiProjectDelete.test.ts・sharedProjectDelete.test.ts）は代役に替える。判断（plan）と押したあとの流れ（pressProjectDelete）は本物。
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

import ManualTeardownNote from '../src/renderer/components/teardown/ManualTeardownNote'
import { PUBLISH_TARGET_LABEL, type PublishTargetKind } from '../src/renderer/publishStatus'
import { REGISTRY_MONTHLY_YEN, BUCKET_MONTHLY_YEN } from '../src/shared/cloudCost'
import { createDialogHarness, DIR } from './projectDeleteDialogHarness'

const { reset, settle, rerender, render, mount, open, els, textOf, paragraphs, mainButton, checkbox, results, withFacts, withTargets } = createDialogHarness(hooks, fake)
beforeEach(reset)

const T094 = (JSON.parse(readFileSync(join(__dirname, '..', 'docs/wording-trim-2026-10.json'), 'utf-8')).proposals as Array<{ id: string; proposed: string }>).find(p => p.id === 'T094')!.proposed
const UNREADABLE_HEAD = '⚠️ 公開の記録（.sakuraide.json・.sakura-cloud/）を読めないため、公開が残っているか分かりません。'

describe('開いたとき: 材料を読む（1回。このプロジェクトのパスで。閉じたあとの答えは捨てる）', () => {
  it('★★ 材料を読む関数を projectDir で 1 回だけ呼ぶ。effect は 1 つで、依存は projectDir だけ。ダイアログは自分では窓の口を読まない', async () => {
    const effects = await open()
    expect(fake.readCalls).toEqual([DIR])
    expect(effects).toHaveLength(1)
    expect(effects[0].deps).toEqual([DIR])
    // 窓にはフォルダの口と走っている操作の口しか無い（cloud・storage・apprunDedicated を呼べば TypeError で落ちる）
    expect(Object.keys((globalThis as any).window.electronAPI).sort()).toEqual(['fs', 'publishMeta'])
  })

  it('★★★ 読み込みの前は facts が空（null）: 赤い箱もチェックも出ず、押せない。読めたあとに出る', async () => {
    withTargets(['hanamii'])
    let openGate: () => void = () => {}
    fake.gate = new Promise<void>(r => { openGate = r })
    mount()
    await settle(); rerender() // 材料はまだ届かない
    expect(paragraphs().some(t => t.includes('公開されています'))).toBe(false)
    expect(els('input')).toHaveLength(0)
    expect(mainButton().props.disabled).toBe(true)
    openGate(); await settle(); rerender()
    expect(paragraphs()).toContain('このプロジェクトは公開されています')
    expect(els('input')).toHaveLength(1)
    expect(mainButton().props.disabled).toBe(false)
  })

  it('★★ 読み終わる前に閉じた → 届いた答えは捨てる（前のプロジェクトのものを出さない）。ボタンも押せないまま', async () => {
    withFacts({ targets: ['hanamii', 'sakura-apprun'], placements: [{ bucket: 'koto-late', prefix: 'p', shared: false }], dedicated: { clusterID: 'c1' }, unreadable: true })
    let openGate: () => void = () => {}
    fake.gate = new Promise<void>(r => { openGate = r })
    const cleanups = mount()
    for (const c of cleanups) c() // 読み込みが済む前に閉じる
    openGate(); await settle(); rerender()
    expect(paragraphs().some(t => t.includes('公開されています') || t.includes('分かりません') || t.includes('専有型'))).toBe(false)
    expect(els('input')).toHaveLength(0)
    expect(mainButton().props.disabled).toBe(true)
  })

  it('対照: 閉じなければ、同じ答えは出る（上の検査が、何も出ないだけで通っていない）', async () => {
    withFacts({ targets: ['hanamii', 'sakura-apprun'], placements: [{ bucket: 'koto-late', prefix: 'p', shared: false }], unreadable: true })
    await open()
    expect(paragraphs()).toContain('このプロジェクトは公開されています')
    expect(paragraphs()).toContain(UNREADABLE_HEAD + '公開が残っているままフォルダをゴミ箱へ移すと、どこに何を公開したかの記録も一緒に移り、あとから Koto では破棄できなくなります（公開先によっては月額が続きます）。📡 公開したもの一覧の『さくら側にあるものと、かかっている費用』で『調べる』を押すか、各サービスの管理画面で、公開が残っていないか確かめてから削除してください。')
    expect(paragraphs().some(t => t.startsWith('💾 '))).toBe(true)
  })
})

describe('描く: 赤い箱とチェックは、読めた材料（facts）と plan から決まる', () => {
  it('★★★ 読み込みの前: 赤い箱もチェックも出ない。ボタンは押せない（公開が無いものとして扱ってフォルダが移るのを防ぐ）。マウスを乗せたヒント（title）は無い', async () => {
    render() // 読み込み（effect）はまだ回さない
    expect(paragraphs().some(t => t.includes('公開されています'))).toBe(false)
    expect(els('input')).toHaveLength(0)
    expect(mainButton().props.disabled).toBe(true)
    expect(mainButton().props.title).toBeUndefined()
    expect(textOf(mainButton().props)).toBe('🗑 ゴミ箱に移動')
  })

  it('★★★ 読めたあと、止める理由が無ければ押せる', async () => {
    withTargets([]); await open()
    expect(mainButton().props.disabled).toBe(false)
    expect(mainButton().props.title).toBeUndefined()
  })

  it('★★★ 公開先が破棄できるもの（HANAMII・共用型）のときだけ「公開も一緒に破棄する」を出す。手動の案内の公開先だけなら出さない（公開先があるだけでは出ない）', async () => {
    withTargets(['vercel', 'sakura-rental']); await open()
    expect(paragraphs()).toContain('このプロジェクトは公開されています')
    expect(els('input')).toHaveLength(0)
    expect(els('span').map(el => textOf(el.props))).not.toContain('公開も一緒に破棄する')
    withTargets(['vercel', 'hanamii']); await open()
    expect(els('input')).toHaveLength(1)
    expect(els('span').map(el => textOf(el.props))).toContain('公開も一緒に破棄する')
    expect(checkbox().props.type).toBe('checkbox')
    expect(checkbox().props.checked).toBe(true) // 既定はオン
  })

  it('★★ 公開先は1つずつ <li> に名前を出し、手動の案内は ManualTeardownNote（公開先ごとに1つ）に任せる。案内の文を自分では書かない', async () => {
    withTargets(['hanamii', 'vercel', 'sakura-rental']); await open()
    expect(els('li').map(el => el.key)).toEqual(['hanamii', 'vercel', 'sakura-rental'])
    expect(els('li').map(el => textOf(el.props).includes(PUBLISH_TARGET_LABEL['hanamii']))).toEqual([true, false, false])
    expect(els(ManualTeardownNote).map(el => el.props.target)).toEqual(['hanamii', 'vercel', 'sakura-rental'])
  })

  it('★★ 公開の記録を読めなかった回だけ、注意を出す（公開先が無くても、注意だけで赤い箱が出る）。注意は 2 つのファイル名を言う', async () => {
    withTargets([], true); await open()
    const notes = paragraphs().filter(t => t.includes('分かりません'))
    expect(notes).toHaveLength(1)
    expect(notes[0].startsWith(UNREADABLE_HEAD)).toBe(true)
    withTargets([], false); await open()
    expect(paragraphs().some(t => t.includes('公開が残っているか分かりません'))).toBe(false)
    expect(paragraphs().some(t => t.includes('公開されています'))).toBe(false)
  })

  it('★★★ 専有型が残っている（公開先の行・クラスタの記録・アプリの記録・保存場所だけ）と、T094 の赤字を1つだけ出し、チェックを出さず、ボタンを押せなくする。公開先が空でも赤字は単独で出る', async () => {
    for (const [targets, dedicated] of [
      [['sakura-apprun-dedicated'], null],
      [[], { clusterID: 'c1' }],
      [[], { applicationID: 'a1' }],
      [['hanamii'], { loadBalancerID: 'lb1' }],
    ] as Array<[PublishTargetKind[], any]>) {
      withFacts({ targets, dedicated }); await open()
      const blockers = paragraphs().filter(t => t.includes('リソースが残っているため、この画面からは削除できません'))
      expect(blockers, `${JSON.stringify([targets, dedicated])}`).toEqual([T094])
      expect(els('input'), '止めるときはチェックを出さない').toHaveLength(0)
      expect(mainButton().props.disabled).toBe(true)
      expect(mainButton().props.title).toBeUndefined()
    }
    withFacts({ targets: ['hanamii'], dedicated: null }); await open()
    expect(mainButton().props.disabled).toBe(false)
  })

  it('★★★ 保存場所だけが残った専有型（P10）: 名前つきの赤字を 1 つ出し、チェックを出さず、ボタンを押せなくする', async () => {
    withFacts({ targets: [], dedicated: { storageLeftoverBucket: 'koto-left' } }); await open()
    const blockers = paragraphs().filter(t => t.includes('koto-left'))
    expect(blockers).toEqual([
      '⚠️ さくらのAppRun 専有型の削除で、保存場所『koto-left』だけが残っています（消すまで月額が続きます）。'
      + '先に「📦 さくらのAppRun」の専有型タブ「手順6 作ったものを削除する」で残った保存場所を削除してから、もう一度このプロジェクトを削除してください。',
    ])
    expect(els('input')).toHaveLength(0)
    expect(mainButton().props.disabled).toBe(true)
  })

  it('★★★ 公開・破棄・作成が進んでいる間は、赤字を 1 つ出し（操作名つき）、チェックを出さず、ボタンを押せなくする。専有型の記録より先に言う', async () => {
    // 言葉は記録の op ではなく、画面の言葉（共用型・HANAMII の破棄は「破棄」、専有型の削除・公開先が分からないときは「削除」。0.6.22 の決定 D3）
    for (const [op, target, word] of [
      ['公開', 'hanamii', '公開'], ['削除', 'sakura-apprun', '破棄'], ['削除', 'hanamii', '破棄'],
      ['削除', 'sakura-apprun-dedicated', '削除'], ['削除', 'unknown', '削除'], ['作成', 'sakura-apprun-dedicated', '作成'],
    ] as const) {
      withFacts({ targets: ['hanamii'], running: { op, target }, dedicated: { clusterID: 'c1' } }); await open()
      expect(paragraphs().filter(t => t.includes('が進んでいます')), `${op}・${target}`).toEqual([`⚠️ いまこのプロジェクトの${word}が進んでいます。終わってから、もう一度このプロジェクトを削除してください。`])
      expect(paragraphs().some(t => t.includes('リソースが残っている'))).toBe(false)
      expect(els('input')).toHaveLength(0)
      expect(mainButton().props.disabled).toBe(true)
    }
  })

  it('★★ チェックを外すと「公開はそのまま残ります」。コンテナレジストリの月額は、共用型のレジストリが「このプロジェクトのために Koto が作った・借り手がいない」ときだけ言う', async () => {
    const MONTHLY = `コンテナレジストリの月額${REGISTRY_MONTHLY_YEN}円（税込）が、消すまで続きます。`
    const PLAIN = '公開はそのまま残ります。フォルダを消すと「どこに何を公開したか」の記録も消えるため、あとから Koto では破棄できなくなります。'
    const unchecked = async (over: Parameters<typeof withFacts>[0]) => {
      withFacts(over); await open()
      checkbox().props.onChange({ target: { checked: false } }); rerender()
      return paragraphs().find(t => t.startsWith('公開はそのまま残ります'))!
    }
    // 共用型が無い（HANAMII だけ）→ 月額は言わない
    expect(await unchecked({ targets: ['hanamii'] })).toBe(PLAIN)
    // 共用型の行があり、Koto が作ったレジストリがあって借り手がいない → 言う
    expect(await unchecked({ targets: ['hanamii', 'sakura-apprun'], sharedRegistry: { registryName: 'myreg', origin: 'owned', users: [] } })).toBe(`${PLAIN} ${MONTHLY}`)
    // オンに戻すと、先に破棄する文に戻る
    checkbox().props.onChange({ target: { checked: true } }); rerender()
    expect(paragraphs().some(t => t.startsWith('先に公開を破棄してから、フォルダをゴミ箱へ移します。'))).toBe(true)
  })

  it.each([
    ['記録にレジストリが無い（作者の実例: .sakura-cloud が無く、共用型の行だけ）', null],
    ['owned で、ほかのプロジェクトが借りている', { registryName: 'myreg', origin: 'owned', users: ['reminder'] }],
    ['借りたもの（adopted）', { registryName: 'myreg', origin: 'adopted', users: [] }],
    ['作ったか分からないもの（unknown）', { registryName: 'myreg', origin: 'unknown', users: [] }],
  ] as const)('★★★ 共用型の行があっても、月額は言わない: %s', async (_name, sharedRegistry) => {
    withFacts({ targets: ['sakura-apprun'], sharedRegistry: sharedRegistry as any }); await open()
    checkbox().props.onChange({ target: { checked: false } }); rerender()
    const p = paragraphs().find(t => t.startsWith('公開はそのまま残ります'))!
    expect(p).toBeTruthy() // 公開が残ることは、これまでどおり言う
    expect(p).not.toContain('コンテナレジストリ')
    expect(p).not.toContain('月額')
    expect(paragraphs().some(t => t.includes(`${REGISTRY_MONTHLY_YEN}円`)), 'ほかの段落にも、レジストリの月額を言わない').toBe(false)
  })

  it('★★★ 💾: オンのとき、先に破棄する公開先（HANAMII・共用型）ごとに1行。オフのときは、残る保存場所の1行', async () => {
    const placements = [{ bucket: 'koto-data', prefix: 'proj-a', shared: false }]
    withFacts({ targets: ['sakura-apprun', 'hanamii', 'vercel'], placements }); await open()
    const lines = paragraphs().filter(t => t.startsWith('💾 '))
    expect(lines).toHaveLength(2)
    expect(lines[0].startsWith(`💾 ${PUBLISH_TARGET_LABEL['hanamii']}: `)).toBe(true) // HANAMII が先
    expect(lines[1].startsWith(`💾 ${PUBLISH_TARGET_LABEL['sakura-apprun']}: `)).toBe(true)
    expect(lines.every(l => l.includes('koto-data'))).toBe(true)
    checkbox().props.onChange({ target: { checked: false } }); rerender()
    expect(paragraphs().filter(t => t.startsWith('💾 '))).toEqual([`💾 保存場所「koto-data」とその中のデータは残ります（消すまで月額${BUCKET_MONTHLY_YEN}円・税込が続きます）。`])
  })

  it('★★ 保存場所が 1 件も無いときは、オフでも 💾 を出さない', async () => {
    withTargets(['hanamii']); await open()
    checkbox().props.onChange({ target: { checked: false } }); rerender()
    expect(paragraphs().filter(t => t.startsWith('💾 '))).toEqual([])
  })

  it('★★ コンテナレジストリの注記（「残します」）は無い。選ぶのは続く確認の選択の欄（10.9.18 の D）', async () => {
    withTargets(['sakura-apprun']); await open()
    expect(paragraphs().some(t => t.includes('は残します') || t.includes('コンテナレジストリ『'))).toBe(false)
    checkbox().props.onChange({ target: { checked: false } }); rerender()
    expect(paragraphs().some(t => t.includes('は残します') || t.includes('コンテナレジストリ『'))).toBe(false)
  })
})

describe('描く: 共用型の記録だけが残るプロジェクト（10.9.18 の E=1。文だけ足す。破棄はしない・止めない）', () => {
  const left = { registryName: 'my-reg', registryOrigin: 'owned', registryUsers: [] as string[], placements: [{ bucket: 'koto-data', prefix: 'p', shared: false }] }

  it('★★★ 共用型の行は無いのに記録に消すものがある → 赤い箱に 💾 の 1 行（保存場所 → レジストリの順）。チェックは出さず、ボタンは押せる', async () => {
    withFacts({ targets: [], sharedLeftover: left }); await open()
    expect(paragraphs().filter(t => t.startsWith('💾 '))).toEqual([
      `💾 保存場所「koto-data」とその中のデータは残ります（消すまで月額${BUCKET_MONTHLY_YEN}円・税込が続きます）。`
      + `コンテナレジストリ『my-reg』も残ります（消すまで月額${REGISTRY_MONTHLY_YEN}円・税込が続きます）。`,
    ])
    expect(els('input')).toHaveLength(0)
    expect(mainButton().props.disabled).toBe(false)
  })

  it('★★ レジストリだけ・保存場所だけでも、その分だけ言う', async () => {
    withFacts({ sharedLeftover: { registryName: 'only-reg', registryOrigin: 'owned', registryUsers: [], placements: [] } }); await open()
    expect(paragraphs().filter(t => t.startsWith('💾 '))).toEqual([`💾 コンテナレジストリ『only-reg』も残ります（消すまで月額${REGISTRY_MONTHLY_YEN}円・税込が続きます）。`])
    withFacts({ sharedLeftover: { registryName: null, registryOrigin: 'unknown', registryUsers: [], placements: left.placements } }); await open()
    expect(paragraphs().filter(t => t.startsWith('💾 '))).toEqual([`💾 保存場所「koto-data」とその中のデータは残ります（消すまで月額${BUCKET_MONTHLY_YEN}円・税込が続きます）。`])
  })

  it.each([
    ['借りたもの（adopted）', { registryOrigin: 'adopted', registryUsers: [] }],
    ['作ったか分からないもの（unknown）', { registryOrigin: 'unknown', registryUsers: [] }],
    ['owned でも、ほかのプロジェクトが使っている', { registryOrigin: 'owned', registryUsers: ['reminder'] }],
  ] as const)('★★★ このプロジェクトだけのレジストリでなければ、残ることだけを言い、月額は言わない: %s', async (_name, over) => {
    withFacts({ sharedLeftover: { ...left, ...over, registryUsers: [...over.registryUsers] } }); await open()
    expect(paragraphs().filter(t => t.startsWith('💾 '))).toEqual([
      `💾 保存場所「koto-data」とその中のデータは残ります（消すまで月額${BUCKET_MONTHLY_YEN}円・税込が続きます）。コンテナレジストリ『my-reg』も残ります。`,
    ])
    withFacts({ sharedLeftover: { registryName: 'only-reg', registryOrigin: over.registryOrigin, registryUsers: [...over.registryUsers], placements: [] } }); await open()
    expect(paragraphs().filter(t => t.startsWith('💾 '))).toEqual(['💾 コンテナレジストリ『only-reg』も残ります。'])
    expect(paragraphs().some(t => t.includes(`${REGISTRY_MONTHLY_YEN}円`))).toBe(false)
  })

  it('★★ 先に破棄する公開先があるとき（plan.teardown が空でない）は出さない（既存の説明と 💾 が言う）', async () => {
    withFacts({ targets: ['hanamii'], sharedLeftover: left }); await open()
    expect(paragraphs().some(t => t.includes('コンテナレジストリ『my-reg』'))).toBe(false)
  })

  it('★★ 言うことが無い（保存場所もレジストリも無い）ときは、空の赤い箱を出さない', async () => {
    withFacts({ sharedLeftover: { registryName: null, registryOrigin: 'unknown', registryUsers: [], placements: [] } }); await open()
    expect(paragraphs().some(t => t.startsWith('💾 '))).toBe(false)
    expect(els('ul')).toHaveLength(0)
    expect(hooks.rendered.some(el => el.type === 'div' && String(el.props.className).includes('border-brand-red/50'))).toBe(false)
  })

  it('★★ 専有型で止めるときは、止める文が先で、共用型の記録の文も重ねて出る（どちらも要る）', async () => {
    withFacts({ dedicated: { clusterID: 'c1' }, sharedLeftover: left }); await open()
    expect(paragraphs()).toContain(T094)
    expect(paragraphs().some(t => t.startsWith('💾 '))).toBe(true)
    expect(mainButton().props.disabled).toBe(true)
  })
})

describe('描く: 結果の欄はまだ押していない間は出ない。押したあとは ProjectDeleteResults が描く', () => {
  it('★ 押す前は結果の欄を描かない', async () => {
    withTargets(['hanamii']); await open()
    expect(results()).toBeUndefined()
  })
})
