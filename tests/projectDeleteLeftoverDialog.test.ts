import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

// ── 0.6.24 A（U12）: プロジェクトの削除のダイアログが、行の無い保存場所・レジストリ・アプリの破棄（残りの段）を言い、走らせる ──────────────
// 純関数（門・文・💾 の行・Vercel の判断）は tests/projectDeleteLeftoverPlan.test.ts・projectDeleteWords.test.ts が固定する。ここは**ダイアログがそれらを配線している**ことを、
// react の小さな代役の上で実際に動かして見る（tests/projectDeleteDialog.test.ts と同じ道具）。
//   T-A5 チェックの文（公開あり／保存場所／レジストリ／両方／Vercel と保存場所／行の無いアプリ）と、実行中のボタンの文
//   T-A6 💾 の行（HANAMII と残りが並ぶとき、同じ保存場所を2回言わない。state にだけある保存場所を落とさない）
//   A-5  teardownPublished の第4引数（plan.leftover の印）を、押したときに素通しする
//   A-9  Vercel の案内を「保存場所も破棄する回」だけ短くする（ManualTeardownNote の storageTornDown）
// 材料を読む関数と、公開先の破棄（teardownPublished）は代役。判断（plan）と押したあとの流れは本物。

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

import ManualTeardownNote from '../src/renderer/components/teardown/ManualTeardownNote'
import { PUBLISH_TARGET_LABEL } from '../src/renderer/publishStatus'
import { PUBLISH_RECORD_UNREADABLE_NOTE } from '../src/renderer/teardown/projectDeletePlan'
import { createDialogHarness } from './projectDeleteDialogHarness'

const { t, reset, settle, rerender, open, els, textOf, paragraphs, mainButton, checkbox, press, done, failed, results, withFacts } = createDialogHarness(hooks, fake)
beforeEach(reset)

const A = { bucket: 'koto-a', prefix: 'p', shared: false }
const B = { bucket: 'koto-b', prefix: 'p', shared: false }
const left = (over: Record<string, unknown> = {}) => ({ appNames: [] as string[], registryName: null as string | null, registryOrigin: 'unknown', registryUsers: [] as string[], placements: [] as typeof A[], ...over })
const uncheck = () => { checkbox().props.onChange({ target: { checked: false } }); rerender() }
const spans = () => els('span').map(el => textOf(el.props))
/** チェックの文（ラベル・オンの説明・オフの説明）。 */
const checkWords = () => ({ label: spans().find(s => s.endsWith('一緒に破棄する')) ?? null, on: paragraphs().find(p => p.startsWith('先に')) ?? null })

const PUBLISHED_ON = '先に公開を破棄してから、フォルダをゴミ箱へ移します。破棄に失敗したときは削除しません。'
const PUBLISHED_OFF = '公開はそのまま残ります。フォルダを消すと「どこに何を公開したか」の記録も消えるため、あとから Koto では破棄できなくなります。'
const LEFTOVER_ON = '先に破棄してから、フォルダをゴミ箱へ移します。破棄に失敗したときは削除しません。'
const LEFTOVER_OFF = 'フォルダを消すと記録も消えるため、あとから Koto では破棄できなくなります。'

describe('T-A5 チェックの文: 公開のある回は今のまま。公開していない回は、残りの呼び名で言う（ダイアログが projectDeleteCheckWords を配線している）', () => {
  it.each([
    ['公開あり（HANAMII の行）', { targets: ['hanamii'] }, '公開も一緒に破棄する', PUBLISHED_ON, PUBLISHED_OFF],
    ['公開あり（共用型の行）', { targets: ['sakura-apprun'] }, '公開も一緒に破棄する', PUBLISHED_ON, PUBLISHED_OFF],
    ['行の無いアプリ（アプリが残る回は公開の言い方のまま）', { targets: [], sharedLeftover: left({ appNames: ['myapp'] }) }, '公開も一緒に破棄する', PUBLISHED_ON, PUBLISHED_OFF],
    ['保存場所だけ', { targets: [], sharedLeftover: left({ placements: [A] }) }, '保存場所も一緒に破棄する', LEFTOVER_ON, LEFTOVER_OFF],
    ['レジストリだけ（Koto が作った・借り手なし）', { targets: [], sharedLeftover: left({ registryName: 'my-reg', registryOrigin: 'owned' }) }, 'コンテナレジストリも一緒に破棄する', LEFTOVER_ON, LEFTOVER_OFF],
    ['保存場所とレジストリ', { targets: [], sharedLeftover: left({ placements: [A], registryName: 'my-reg', registryOrigin: 'owned' }) }, '保存場所・コンテナレジストリも一緒に破棄する', LEFTOVER_ON, LEFTOVER_OFF],
    ['Vercel と保存場所（Vercel の行は破棄の段に入らないので、公開していない回）', { targets: ['vercel'], sharedLeftover: left({ placements: [A] }) }, '保存場所も一緒に破棄する', LEFTOVER_ON, LEFTOVER_OFF],
    ['Vercel・レンタルサーバと保存場所', { targets: ['vercel', 'sakura-rental'], sharedLeftover: left({ placements: [A] }) }, '保存場所も一緒に破棄する', LEFTOVER_ON, LEFTOVER_OFF],
  ] as const)('★★★ %s', async (_name, over, label, on, off) => {
    withFacts(over as any); await open()
    expect(checkWords()).toEqual({ label, on })
    expect(checkbox().props.checked).toBe(true) // 既定はオン
    uncheck()
    expect(paragraphs().find(p => p.startsWith('公開はそのまま') || p.startsWith('フォルダを消すと'))).toBe(off)
  })

  it.each([
    ['借りたもの（adopted）で借り手なし', 'adopted'],
    ['作ったか分からないもの（unknown）で借り手なし', 'unknown'],
  ] as const)('★★ 確認の既定がオフになるレジストリを数える回は、オンの説明に「次の確認で選べます」を足す: %s', async (_name, origin) => {
    withFacts({ targets: [], sharedLeftover: left({ registryName: 'R', registryOrigin: origin }) }); await open()
    expect(checkWords().on).toBe(`${LEFTOVER_ON} コンテナレジストリ『R』を消すかは、次の確認で選べます。`)
    withFacts({ targets: [], sharedLeftover: left({ registryName: 'R', registryOrigin: 'owned' }) }); await open()
    expect(checkWords().on, '既定でオンになる（Koto が作った・借り手なし）回は足さない').toBe(LEFTOVER_ON)
  })

  it('★★ 公開のある回で残りの段が足されても、チェックの文は公開のまま（HANAMII の行がある）。公開の文を1文字も変えない', async () => {
    withFacts({ targets: ['hanamii'], sharedLeftover: left({ placements: [A], registryName: 'R', registryOrigin: 'adopted' }) }); await open()
    expect(checkWords()).toEqual({ label: '公開も一緒に破棄する', on: PUBLISHED_ON })
  })

  it('★★ 済んだ段は数えない: HANAMII が済み、行がまだ材料に残っていても、箱に出ている段（残りの段だけ）で「保存場所も一緒に」と言う', async () => {
    // 破棄の1回目: HANAMII は done・残りの段が failed → 材料を読み直す。読み直した材料に HANAMII の行がまだ残っていても、済んだ HANAMII を「公開」として数えない
    withFacts({ targets: ['hanamii'], sharedLeftover: left({ placements: [A] }) })
    fake.teardownResult = async () => [done('hanamii'), failed('sakura-apprun', '保存場所: 削除できませんでした')]
    await open()
    expect(checkWords().label).toBe('公開も一緒に破棄する')
    await press()
    expect(spans().filter(s => s.endsWith('一緒に破棄する'))).toEqual(['保存場所も一緒に破棄する'])
  })

  it('★★ 実行中のボタン: 公開なしの回は「破棄しています…」、公開のある回は今のまま「公開を破棄しています…」', async () => {
    const busyText = async (over: Record<string, unknown>) => {
      reset(); withFacts(over as any)
      let release: () => void = () => {}
      fake.teardownResult = () => new Promise(r => { release = () => r([done('sakura-apprun')]) })
      await open()
      const pressed = mainButton().props.onClick()
      await settle(); rerender()
      const text = textOf(mainButton().props)
      release(); await pressed; await settle()
      return text
    }
    expect(await busyText({ targets: [], sharedLeftover: left({ placements: [A] }) })).toBe('破棄しています…')
    expect(await busyText({ targets: ['sakura-apprun'] })).toBe('公開を破棄しています…')
    expect(await busyText({ targets: ['hanamii'], sharedLeftover: left({ placements: [A] }) })).toBe('公開を破棄しています…')
    // 押す前は、どの回も同じ
    reset(); withFacts({ targets: [], sharedLeftover: left({ placements: [A] }) }); await open()
    expect(textOf(mainButton().props)).toBe('🗑 ゴミ箱に移動')
  })
})

describe('T-A6 💾 の行: 同じ保存場所を2回言わない。state にだけある保存場所を落とさない', () => {
  it('★★★ HANAMII と残りの段が並ぶ回: HANAMII の行が名指しした保存場所（env.json）は、残りの段の行から除く。公開先の名前は残りの行の前に付けない', async () => {
    withFacts({ targets: ['hanamii'], placements: [A], sharedLeftover: left({ placements: [A, B] }) }); await open()
    const lines = paragraphs().filter(p => p.startsWith('💾 '))
    expect(lines).toHaveLength(2)
    expect(lines[0].startsWith(`💾 ${PUBLISH_TARGET_LABEL['hanamii']}: `)).toBe(true) // HANAMII が先
    expect(lines[0]).toContain('『koto-a』')
    expect(lines[1].startsWith('💾 保存場所『koto-b』にある、')).toBe(true)
    expect(lines[1]).not.toContain('koto-a')
    expect(lines.some(l => l.includes(PUBLISH_TARGET_LABEL['sakura-apprun']))).toBe(false)
  })

  it('★★★ 外した 💾: state にだけある保存場所（env.json に無い）も言う。env.json にだけある保存場所も言う。同じ保存場所は1回', async () => {
    withFacts({ targets: ['hanamii'], placements: [A, B], sharedLeftover: left({ placements: [A] }) }); await open()
    uncheck()
    expect(paragraphs().filter(p => p.startsWith('💾 '))).toHaveLength(1)
    const line = paragraphs().find(p => p.startsWith('💾 '))!
    expect(line).toContain('koto-a')
    expect(line).toContain('koto-b')
    expect(line.split('koto-a').length - 1).toBe(1)
    withFacts({ targets: ['hanamii'], placements: [], sharedLeftover: left({ placements: [B] }) }); await open()
    uncheck()
    expect(paragraphs().find(p => p.startsWith('💾 '))).toContain('koto-b')
  })

  it('★★ 残りの段が保存場所を持たない回（レジストリだけ）は、チェックがオンの 💾 の行を出さない（公開先の行の env.json の保存場所は、そのまま言う）', async () => {
    withFacts({ targets: ['hanamii'], placements: [A], sharedLeftover: left({ registryName: 'R', registryOrigin: 'owned' }) }); await open()
    const lines = paragraphs().filter(p => p.startsWith('💾 '))
    expect(lines).toHaveLength(1)
    expect(lines[0].startsWith(`💾 ${PUBLISH_TARGET_LABEL['hanamii']}: `)).toBe(true)
  })
})

describe('A-5 押したとき: 残りの段の印（plan.leftover）を teardownPublished の第4引数へ素通しする', () => {
  it('★★★ 残りの段がある回は { leftover: { noun } }（名詞つき）。アプリが残る回は noun が null。呼び出しは1回で、先に破棄する公開先は plan.teardown', async () => {
    withFacts({ targets: [], sharedLeftover: left({ placements: [A] }) })
    fake.teardownResult = async () => [done('sakura-apprun')]
    await open(); await press()
    expect(fake.teardownCalls).toHaveLength(1)
    expect(fake.teardownCalls[0].targets).toEqual(['sakura-apprun'])
    expect(fake.teardownCalls[0].opts).toEqual({ leftover: { noun: '保存場所' } })
    reset(); withFacts({ targets: [], sharedLeftover: left({ appNames: ['myapp'] }) })
    fake.teardownResult = async () => [done('sakura-apprun')]
    await open(); await press()
    expect(fake.teardownCalls[0].opts).toEqual({ leftover: { noun: null } })
  })

  it('★★ 残りの段が無い回は、第4引数を渡さない（行のある共用型・HANAMII だけ）', async () => {
    withFacts({ targets: ['hanamii', 'sakura-apprun'] })
    fake.teardownResult = async () => [done('hanamii'), done('sakura-apprun')]
    await open(); await press()
    expect(fake.teardownCalls).toHaveLength(1)
    expect(fake.teardownCalls[0].opts).toBeUndefined()
  })

  it('★★ チェックを外した回は、破棄を呼ばない（残りの段があっても。フォルダだけ移す）', async () => {
    withFacts({ targets: [], sharedLeftover: left({ placements: [A] }) })
    await open(); uncheck(); await press()
    expect(fake.teardownCalls).toEqual([])
    expect(t.trashed).toEqual(['/tmp/ws/proj-a'])
  })
})

describe('A-9 Vercel の案内: 保存場所も一緒に破棄する回だけ、最後の文（保存場所は残ります）を言わない', () => {
  const noteProp = () => els(ManualTeardownNote).map(el => el.props.storageTornDown)

  it('★★★ Vercel と保存場所 + チェックがオン → storageTornDown が真。外すと偽（保存場所は残る）', async () => {
    withFacts({ targets: ['vercel'], sharedLeftover: left({ placements: [A] }) }); await open()
    expect(els(ManualTeardownNote)).toHaveLength(1)
    expect(noteProp()).toEqual([true])
    uncheck()
    expect(noteProp()).toEqual([false])
    checkbox().props.onChange({ target: { checked: true } }); rerender()
    expect(noteProp()).toEqual([true])
  })

  it.each([
    ['残りの段が無い（Vercel だけ）', { targets: ['vercel'] }],
    ['行のある共用型が保存場所を破棄するが、残りの段ではない（Vercel と共用型の行）', { targets: ['vercel', 'sakura-apprun'] }],
    ['残りがレジストリだけ（保存場所に触れない。保存場所は実際に残る）', { targets: ['vercel'], sharedLeftover: left({ registryName: 'R', registryOrigin: 'owned' }) }],
    ['残りがアプリだけ（保存場所に触れない）', { targets: ['vercel'], sharedLeftover: left({ appNames: ['myapp'] }) }],
    ['借り手のいるレジストリだけ（段を足さない）', { targets: ['vercel'], sharedLeftover: left({ registryName: 'R', registryOrigin: 'adopted', registryUsers: ['other'] }) }],
  ] as const)('★★ 偽のまま（今の文）: %s', async (_name, over) => {
    withFacts(over as any); await open()
    // 部品は公開先の行ごとに1つ渡る（破棄できる公開先の分は、部品が自分で何も描かない）。どれにも真を渡さない
    expect(noteProp()).toEqual(over.targets.map(() => false))
  })

  it('★★ 手動の案内が複数あっても、同じ判断を渡す（レンタルサーバも）。破棄できる公開先には部品を描かない', async () => {
    withFacts({ targets: ['hanamii', 'vercel', 'sakura-rental'], sharedLeftover: left({ placements: [A] }) }); await open()
    expect(els(ManualTeardownNote).map(el => el.props.target)).toEqual(['hanamii', 'vercel', 'sakura-rental'])
    expect(noteProp()).toEqual([true, true, true])
  })
})

describe('A-4 箱を出す条件: 破棄する段があれば、公開先の行が無くても箱とチェックが出る（出さないと行き止まりになる）', () => {
  it('★★★ 行の無い保存場所だけの回: 公開先の一覧・見出しは無いが、チェックと説明が出て、ボタンは押せる', async () => {
    withFacts({ targets: [], sharedLeftover: left({ placements: [A] }) }); await open()
    expect(paragraphs().some(p => p.includes('このプロジェクトは公開されています'))).toBe(false)
    expect(els('li')).toHaveLength(0)
    expect(els('input')).toHaveLength(1)
    expect(mainButton().props.disabled).toBe(false)
  })

  it('★★ 専有型で止める回は、段を足さない。チェックは出ず、ボタンは押せない（止めが先）', async () => {
    withFacts({ targets: [], dedicated: { clusterID: 'c1' }, sharedLeftover: left({ placements: [A] }) }); await open()
    expect(els('input')).toHaveLength(0)
    expect(mainButton().props.disabled).toBe(true)
  })
})

describe('R4-a 公開の記録を読めない回: 残りの段のチェックを出さない。「読めないため、削除できません」の注意だけを言う', () => {
  it('★★★ 読めない記録と保存場所の残り: チェックも「公開も一緒に」「保存場所も一緒に」の文も出ない。注意の文は出る。押しても、破棄（teardownPublished）は呼ばない', async () => {
    withFacts({ targets: [], unreadable: true, sharedLeftover: left({ placements: [A] }) }); await open()
    expect(els('input')).toHaveLength(0)
    expect(spans().some(sp => sp.endsWith('一緒に破棄する'))).toBe(false)
    expect(paragraphs()).toContain(`⚠️ ${PUBLISH_RECORD_UNREADABLE_NOTE}`)
    await press()
    expect(fake.teardownCalls).toEqual([])
  })

  it('★★ 対照: 同じ残りでも読めている回は、「保存場所も一緒に破棄する」のチェックが出る', async () => {
    withFacts({ targets: [], unreadable: false, sharedLeftover: left({ placements: [A] }) }); await open()
    expect(els('input')).toHaveLength(1)
    expect(checkWords().label).toBe('保存場所も一緒に破棄する')
  })
})

describe('R4-b-4 ダイアログが箱に出している段（shownTeardown）を、💾 の行と Vercel の判断へ渡す', () => {
  const lines = () => paragraphs().filter(p => p.startsWith('💾 '))
  const noteProp = () => els(ManualTeardownNote).map(el => el.props.storageTornDown)

  it('★★★ 残りの段の 💾 の行: HANAMII の段が済んで箱から外れたら、HANAMII の行はもう無いので、残りの段の行は同じ保存場所を言い直す（開いたときは HANAMII の行だけ）', async () => {
    withFacts({ targets: ['hanamii'], placements: [A], sharedLeftover: left({ placements: [A] }) })
    fake.teardownResult = async () => [done('hanamii'), failed('sakura-apprun', '保存場所: 削除できませんでした')]
    await open()
    expect(lines()).toHaveLength(1)
    expect(lines()[0].startsWith(`💾 ${PUBLISH_TARGET_LABEL['hanamii']}: `)).toBe(true) // 開いたときは HANAMII が名指しする。残りの段の行は、同じ保存場所なので出ない
    await press()
    expect(lines()).toHaveLength(1)
    expect(lines()[0].startsWith('💾 保存場所『koto-a』にある、')).toBe(true) // HANAMII は済んで箱から外れた。残りの段が自分で名指しする
  })

  it('★★★ Vercel の案内: 残りの段が済んで箱から外れたら、保存場所を破棄する回の印（storageTornDown）は偽に戻る（言う側＝「保存場所は残ります」の文）。済む前は真', async () => {
    withFacts({ targets: ['vercel'], sharedLeftover: left({ placements: [A] }) })
    fake.teardownResult = async () => [done('sakura-apprun', ['保存場所『koto-a』は残しました'])] // 警告つきで済んだ → 見せてから移す（review）。箱は開いたまま
    await open()
    expect(noteProp()).toEqual([true])
    await press()
    expect(results()?.run.phase).toBe('review')
    expect(noteProp()).toEqual([false])
  })
})

describe('R4-d 段を足さなかった残り（借り手のいるレジストリだけ・K2）の注意は、HANAMII の行があっても出る', () => {
  const KEPT = '💾 コンテナレジストリ『R』も残ります。'
  const k2 = left({ registryName: 'R', registryOrigin: 'adopted', registryUsers: ['other'] })
  const kept = () => paragraphs().filter(p => p.includes('コンテナレジストリ『R』'))

  it('★★★ HANAMII の行と K2 の残り: チェックがオンのとき、「コンテナレジストリ『R』も残ります。」を1回言う。残りの段は足さない（確認は HANAMII だけ）', async () => {
    withFacts({ targets: ['hanamii'], sharedLeftover: k2 }); await open()
    expect(checkbox().props.checked).toBe(true)
    expect(kept()).toEqual([KEPT])
    await press()
    expect(fake.teardownCalls[0].targets).toEqual(['hanamii'])
    expect(fake.teardownCalls[0].opts).toBeUndefined()
  })

  it('★★★ チェックを外した回は、外したときの 💾 が同じ注意を言うので、重ねない（1回だけ）', async () => {
    withFacts({ targets: ['hanamii'], sharedLeftover: k2 }); await open()
    uncheck()
    expect(kept()).toEqual([KEPT])
  })

  it('★★ 破棄する段が無い回（K2 の残りだけ）は、今までどおり1回。HANAMII が済んで箱から外れた回（review）も言う', async () => {
    withFacts({ targets: [], sharedLeftover: k2 }); await open()
    expect(els('input')).toHaveLength(0)
    expect(kept()).toEqual([KEPT])
    reset(); withFacts({ targets: ['hanamii'], sharedLeftover: k2 })
    fake.teardownResult = async () => [done('hanamii', ['保存場所『koto-a』は残しました'])]
    await open(); await press()
    expect(results()?.run.phase).toBe('review')
    expect(kept()).toEqual([KEPT])
  })

  it('★★ 残りの段を足した回は、この注意を出さない（段を足した残りは、確認が名指しする）', async () => {
    withFacts({ targets: ['hanamii'], sharedLeftover: left({ placements: [A], registryName: 'R', registryOrigin: 'adopted', registryUsers: ['other'] }) }); await open()
    expect(kept().filter(p => p === KEPT)).toEqual([])
  })
})
