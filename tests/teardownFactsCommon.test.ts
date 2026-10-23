import { describe, it, expect, afterEach } from 'vitest'
import {
  loadTeardownFacts, electronTeardownFactsApi, placementSettingsUnreadable, placementsFailureCause, type TeardownFactsApi,
} from '../src/renderer/teardown/facts'
import { teardownProgressText, notifyTeardownFinished } from '../src/renderer/teardown/flow'
// 進み具合の一文・経過の文は projectOpsView.ts の1つ（段階3B-3 で、teardown/flow.ts と apprunDedicatedActions.ts の同じ中身の2つを1つにした）。
import { opProgressText, opElapsedText } from '../src/renderer/projectOpsView'
import type { TargetSpec, TeardownPlacement } from '../src/renderer/teardown/types'
import { PUBLISH_TARGET_LABEL } from '../src/renderer/publishStatus'
// 偽の window は、手本の出力の写し（golden）と同じ定義を読む（tests/dedicatedGoldenCases.ts。材料が割れて片方だけ古くならないように）。
// 0.6.21 の手本（loadDedicatedTeardownFacts・electronFactsApi）との比べは、手本と一緒に 3B-7 で消えた。同じ窓の上で同じ材料になることは、
// 専有型の仕様書で本物の口を流す tests/dedicatedTeardownGolden.test.ts の「確認の材料」が、手本の出力の写し（JSON）と突き合わせて固定している。
import { installFactsWindow as installWindow } from './dedicatedGoldenCases'

// ── 段階0（0a）: 確認の材料を読む（facts.ts）と、進み具合の文（flow.ts の小さな純関数）──────────────────────────────
//
// この単位では、どの入口・IPC からもまだ呼ばれない（部品と単体テストだけ）。
//   ・材料の読み方: 読めなかった事実を残して空に倒す。記録（readRecord）が読めなければ投げる。
//   ・本物の口（electronTeardownFactsApi）は、偽の window で動かす。

type Rec = { id: string }
const REC: Rec = { id: 'r1' }
const A: TeardownPlacement = { bucket: 'koto-a', prefix: 'projects/myapp/', shared: true }
const B: TeardownPlacement = { bucket: 'koto-b', prefix: 'projects/myapp/', shared: true }

type SpecPick = Pick<TargetSpec<Rec, unknown, unknown>, 'readRecord' | 'waitNote' | 'target'>
const specOf = (over: Partial<SpecPick> = {}): SpecPick => ({ target: 'hanamii', readRecord: async () => REC, ...over })

function fakeApi(over: Partial<TeardownFactsApi> = {}) {
  const calls = { placements: [] as string[], others: [] as Array<[string, string]>, estimates: 0 }
  const api: TeardownFactsApi = {
    placements: async dir => { calls.placements.push(dir); return [A] },
    otherTargets: async (dir, self) => { calls.others.push([dir, self]); return ['Vercel'] },
    estimates: async () => { calls.estimates++; return { fake: true } },
    ...over,
  }
  return { api, calls }
}

afterEach(() => { delete (globalThis as any).window })

describe('loadTeardownFacts: 確認の材料を、押した時点の記録から読む', () => {
  it('★ 全部読めた回: 記録・保存場所・ほかの公開先をそのまま持ち、読めなかった印は立たない。目安を作る仕様書が無ければ waitNote は null', async () => {
    const { api, calls } = fakeApi()
    const facts = await loadTeardownFacts('/work/myapp', specOf(), api)
    expect(facts).toEqual({
      projectName: 'myapp',
      record: REC,
      placements: [A],
      placementsUnreadable: false,
      placementsUnreadableCause: null,
      otherTargets: ['Vercel'],
      otherTargetsUnreadable: false,
      waitNote: null,
    })
    expect(facts.record).toBe(REC)
    expect(calls.placements).toEqual(['/work/myapp'])
    expect(calls.estimates).toBe(1)
  })

  it('★★★ 公開の記録（readRecord）が読めなければ、そのまま投げる（流れが「材料が読めない」として確認を出さない）。ほかの問い合わせには進まない', async () => {
    const { api, calls } = fakeApi()
    const spec = specOf({ readRecord: async () => { throw new Error('.sakuraide.json が壊れています') } })
    await expect(loadTeardownFacts('/p', spec, api)).rejects.toThrow('.sakuraide.json が壊れています')
    expect(calls.placements).toEqual([])
    expect(calls.others).toEqual([])
    expect(calls.estimates).toBe(0)
  })

  it('★★ ほかの公開先の問い合わせには、この公開先（spec.target）を渡す（自分を除くため）', async () => {
    const { api, calls } = fakeApi()
    await loadTeardownFacts('/p', specOf({ target: 'sakura-apprun' }), api)
    await loadTeardownFacts('/q', specOf({ target: 'hanamii' }), api)
    expect(calls.others).toEqual([['/p', 'sakura-apprun'], ['/q', 'hanamii']])
  })

  it('★★★ 保存場所の問い合わせが IPC の失敗（reject）: 空に倒すが「読めなかった」事実が残る。理由は call', async () => {
    const { api } = fakeApi({ placements: async () => { throw new Error('IPC 失敗') } })
    const facts = await loadTeardownFacts('/p', specOf(), api)
    expect(facts.placements).toEqual([])
    expect(facts.placementsUnreadable).toBe(true)
    expect(facts.placementsUnreadableCause).toBe('call')
  })

  it('★★★ 保存場所の設定そのものが読めない（印つきの失敗）: 理由は settings。ほかの失敗とは別の事実', async () => {
    const { api } = fakeApi({ placements: async () => { throw placementSettingsUnreadable('env.json が壊れています') } })
    const facts = await loadTeardownFacts('/p', specOf(), api)
    expect(facts.placements).toEqual([])
    expect(facts.placementsUnreadable).toBe(true)
    expect(facts.placementsUnreadableCause).toBe('settings')
  })

  it('★★ ほかの公開先の記録が読めない: 空に倒すが otherTargetsUnreadable が立つ。保存場所の材料は影響を受けない', async () => {
    const { api } = fakeApi({ otherTargets: async () => { throw new Error('EACCES') } })
    const facts = await loadTeardownFacts('/p', specOf(), api)
    expect(facts.otherTargets).toEqual([])
    expect(facts.otherTargetsUnreadable).toBe(true)
    expect(facts.placements).toEqual([A])
    expect(facts.placementsUnreadable).toBe(false)
  })

  it('★ 「読めて 0 件」は「読めなかった」ではない（保存場所を用意していない・ほかの公開先が無い）', async () => {
    const { api } = fakeApi({ placements: async () => [], otherTargets: async () => [] })
    const facts = await loadTeardownFacts('/p', specOf(), api)
    expect(facts.placementsUnreadable).toBe(false)
    expect(facts.placementsUnreadableCause).toBeNull()
    expect(facts.otherTargetsUnreadable).toBe(false)
  })

  it('★ 目安（estimates）が読めなくても、確認の中身は変わらない: 読めなかった印は立たず、waitNote の材料は null で渡る', async () => {
    const seen: unknown[] = []
    const { api } = fakeApi({ estimates: async () => { throw new Error('目安が読めません') } })
    const facts = await loadTeardownFacts('/p', specOf({ waitNote: (_r, est) => { seen.push(est); return null } }), api)
    expect(seen).toEqual([null])
    expect(facts.placementsUnreadable).toBe(false)
    expect(facts.otherTargetsUnreadable).toBe(false)
    expect(facts.waitNote).toBeNull()
  })

  it('★★ waitNote は仕様書が記録と目安から作る（spec.waitNote(record, estimates)）。null を返せば null', async () => {
    const seen: Array<[unknown, unknown]> = []
    const { api } = fakeApi()
    const withNote = await loadTeardownFacts('/p', specOf({ waitNote: (r, est) => { seen.push([r, est]); return '⏳ 時間がかかります。' } }), api)
    expect(withNote.waitNote).toBe('⏳ 時間がかかります。')
    expect(seen).toEqual([[REC, { fake: true }]])
    const noNote = await loadTeardownFacts('/p', specOf({ waitNote: () => null }), api)
    expect(noNote.waitNote).toBeNull()
  })

  it('配列でない返り値は空に倒す（形が違う応答で落ちない）', async () => {
    const { api } = fakeApi({
      placements: (async () => 'x') as unknown as TeardownFactsApi['placements'],
      otherTargets: (async () => null) as unknown as TeardownFactsApi['otherTargets'],
    })
    const facts = await loadTeardownFacts('/p', specOf(), api)
    expect(facts.placements).toEqual([])
    expect(facts.otherTargets).toEqual([])
  })

  it.each([
    ['/work/myapp', 'myapp'],
    ['/work/myapp/', 'myapp'],
    ['myapp', 'myapp'],
    ['/', '/'],
    ['', ''],
  ])('プロジェクト名はフォルダ名（%s → %s）', async (dir, name) => {
    const { api } = fakeApi()
    expect((await loadTeardownFacts(dir, specOf(), api)).projectName).toBe(name)
  })
})

describe('placementSettingsUnreadable / placementsFailureCause', () => {
  it('印の付いた失敗だけが settings、ほかは call', () => {
    const marked = placementSettingsUnreadable('壊れています')
    expect(marked).toBeInstanceOf(Error)
    expect(marked.message).toBe('壊れています')
    expect(placementsFailureCause(marked)).toBe('settings')
    expect(placementsFailureCause(new Error('IPC'))).toBe('call')
    expect(placementsFailureCause(null)).toBe('call')
    expect(placementsFailureCause(undefined)).toBe('call')
    expect(placementsFailureCause('文字列')).toBe('call')
    // 印は true のときだけ（不明な値を「設定を読めなかった」に倒さない）
    expect(placementsFailureCause({ placementSettingsUnreadable: 'true' })).toBe('call')
    expect(placementsFailureCause({ placementSettingsUnreadable: 1 })).toBe('call')
    expect(placementsFailureCause({ placementSettingsUnreadable: false })).toBe('call')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 本物の口（electronTeardownFactsApi）を、偽の window で動かす
// ═══════════════════════════════════════════════════════════════════════════════

describe('electronTeardownFactsApi（本物の口）', () => {
  const reply = (r: unknown) => installWindow({ placement: async () => r })

  it('★★ storage:placement の全件を拾う。placements が無い古い応答でも先頭の1件は拾う', async () => {
    reply({ ok: true, placement: A, placements: [A, B] })
    expect(await electronTeardownFactsApi().placements('/p')).toEqual([A, B])
    reply({ ok: true, placement: A })
    expect(await electronTeardownFactsApi().placements('/p')).toEqual([A])
    reply({ ok: true, placement: null, placements: [] })
    expect(await electronTeardownFactsApi().placements('/p')).toEqual([])
    reply({ ok: true, placement: null })
    expect(await electronTeardownFactsApi().placements('/p')).toEqual([])
  })

  it('★★★ ok:false（設定そのものを読めなかった）は空に倒さず、印つきで投げる', async () => {
    reply({ ok: false, placement: null, placements: [], message: 'env.json が壊れています' })
    const err = await electronTeardownFactsApi().placements('/p').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('env.json が壊れています')
    expect(placementsFailureCause(err)).toBe('settings')
    reply({ ok: false })
    const err2 = await electronTeardownFactsApi().placements('/p').catch((e: unknown) => e)
    expect((err2 as Error).message).toBe('保存場所の設定を読めませんでした')
    expect(placementsFailureCause(err2)).toBe('settings')
  })

  it('★★ ほかの公開先は .sakuraide.json の publish.targets から、この公開先（self）を除いて、画面の表示名で返す', async () => {
    let path = ''
    installWindow({ readFile: async p => { path = p; return JSON.stringify({ publish: { targets: { hanamii: { publishedAt: 't' }, vercel: { publishedAt: 't' }, 'sakura-apprun': { publishedAt: 't' } } } }) } })
    const others = await electronTeardownFactsApi().otherTargets('/proj', 'hanamii')
    expect(path).toBe('/proj/.sakuraide.json')
    expect(others).toContain(PUBLISH_TARGET_LABEL.vercel)
    expect(others).toContain(PUBLISH_TARGET_LABEL['sakura-apprun'])
    expect(others).not.toContain(PUBLISH_TARGET_LABEL.hanamii)
    expect(others).toHaveLength(2)
    // 自分が違えば、除かれるものも違う
    const others2 = await electronTeardownFactsApi().otherTargets('/proj', 'vercel')
    expect(others2).not.toContain(PUBLISH_TARGET_LABEL.vercel)
    expect(others2).toContain(PUBLISH_TARGET_LABEL.hanamii)
  })

  it.each([
    ['ファイルを読めない', async () => { throw new Error('EACCES') }],
    ['壊れた JSON', async () => '{ 壊れた'],
    ['中身が配列', async () => '[]'],
    ['publish.targets が文字列', async () => JSON.stringify({ publish: { targets: 'x' } })],
  ])('★★ ほかの公開先の記録を読めない（%s）→ 空に倒さず投げる（読めなかった事実を流れが残す）', async (_label, readFile) => {
    installWindow({ readFile: readFile as (p: string) => Promise<string> })
    await expect(electronTeardownFactsApi().otherTargets('/p', 'hanamii')).rejects.toThrow()
    const { api } = { api: electronTeardownFactsApi() }
    const facts = await loadTeardownFacts('/p', specOf(), api)
    expect(facts.otherTargets).toEqual([])
    expect(facts.otherTargetsUnreadable).toBe(true)
  })

  it('目安は stageTiming.estimates をそのまま返す', async () => {
    installWindow({ estimates: async () => ({ stages: 'est' }) })
    expect(await electronTeardownFactsApi().estimates()).toEqual({ stages: 'est' })
  })

  it('★ 偽の口: 記録が読めなければ投げる／片方の問い合わせが落ちても、もう片方は読む（0.6.21 の手本と同じ答えを書き下した）', async () => {
    const fail = async () => { throw new Error('x') }
    const cases: Array<[string, () => Promise<TeardownPlacement[]>, () => Promise<string[]>, Record<string, unknown>]> = [
      ['両方が落ちる', fail, fail, { placements: [], placementsUnreadable: true, placementsUnreadableCause: 'call', otherTargets: [], otherTargetsUnreadable: true }],
      ['保存場所だけ落ちる', fail, async () => ['Vercel'], { placements: [], placementsUnreadable: true, placementsUnreadableCause: 'call', otherTargets: ['Vercel'], otherTargetsUnreadable: false }],
      ['ほかの公開先だけ落ちる', async () => [A, B], fail, { placements: [A, B], placementsUnreadable: false, placementsUnreadableCause: null, otherTargets: [], otherTargetsUnreadable: true }],
    ]
    for (const [label, placementsFn, othersFn, expected] of cases) {
      const facts = await loadTeardownFacts('/p', specOf(), fakeApi({ placements: placementsFn, otherTargets: othersFn }).api)
      expect({
        placements: facts.placements, placementsUnreadable: facts.placementsUnreadable, placementsUnreadableCause: facts.placementsUnreadableCause,
        otherTargets: facts.otherTargets, otherTargetsUnreadable: facts.otherTargetsUnreadable,
      }, label).toEqual(expected)
    }
    await expect(loadTeardownFacts('/p', specOf({ readRecord: fail }), fakeApi().api)).rejects.toThrow('x')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 進み具合の文・経過時間・済んだ知らせ
// ═══════════════════════════════════════════════════════════════════════════════

describe('opProgressText / opElapsedText: 定義は projectOpsView.ts の1つ（手順5・6・8と 📡 の行が同じこれを通る）', () => {
  const RECS: Array<{ progress?: { label?: string; detail?: string } } | null | undefined> = [
    null, undefined, {}, { progress: {} },
    { progress: { label: ' アプリを削除しています ' } },
    { progress: { label: 'アプリ', detail: ' 残り2件 ' } },
    { progress: { detail: '補足だけ' } },
    { progress: { label: '', detail: '' } },
  ]

  it('★ 記録の progress から一文を作る。label・detail の前後の空白は落とし、補足があれば続ける', () => {
    expect(opProgressText(null)).toBe('')
    expect(opProgressText(undefined)).toBe('')
    expect(opProgressText({ progress: { label: ' アプリを削除しています ' } })).toBe('アプリを削除しています')
    expect(opProgressText({ progress: { label: 'アプリ', detail: ' 残り2件 ' } })).toBe('アプリ 残り2件')
    expect(opProgressText({ progress: { detail: '補足だけ' } })).toBe('補足だけ')
    // 前は手本の関数と比べていた。同じ中身の関数は無くなり（段階3B-3）、手本の画面も同じこれを読む。材料ごとの答えを書き下す
    expect(RECS.map(r => opProgressText(r))).toEqual(['', '', '', '', 'アプリを削除しています', 'アプリ 残り2件', '補足だけ', ''])
  })

  it('★ 経過時間は「約N分」。1分未満・時計が戻った回は「1分未満」', () => {
    expect(opElapsedText(0, 0)).toBe('始まってから1分未満')
    expect(opElapsedText(1000, 60999)).toBe('始まってから1分未満')
    expect(opElapsedText(0, 60000)).toBe('始まってから約1分')
    expect(opElapsedText(0, 125000)).toBe('始まってから約2分')
    expect(opElapsedText(5000, 1000)).toBe('始まってから1分未満')
    expect(opElapsedText(0, 540000)).toBe('始まってから約9分')
  })
})

describe('teardownProgressText: 記録が「この公開先の破棄が走っている」と言うなら記録の文、そうでなければこの画面が始めた処理の最新の1行', () => {
  const runningRecord = { progress: { label: 'アプリを削除しています', detail: '残り2件' } }

  it('★★ running が true → 記録の文。local は読まない（別の窓で始めたものも、開き直したものも読める）', () => {
    expect(teardownProgressText({ running: true, runningRecord, local: 'この画面の最新の行' })).toBe('アプリを削除しています 残り2件')
    expect(teardownProgressText({ running: true, runningRecord: null, local: 'この画面の最新の行' })).toBe('')
  })

  it('★★ running が false → この画面が始めた処理の最新の1行（無ければ null）。記録の文は読まない', () => {
    expect(teardownProgressText({ running: false, runningRecord, local: 'この画面の最新の行' })).toBe('この画面の最新の行')
    expect(teardownProgressText({ running: false, runningRecord, local: null })).toBeNull()
  })

  it('記録が無く、この画面の行だけがある回は、その行（0.6.21 の手本と同じ答えを書き下した）', () => {
    const table: Array<[{ running: boolean; runningRecord: typeof runningRecord | null; local: string | null }, string | null]> = [
      [{ running: true, runningRecord, local: 'この画面の最新の行' }, 'アプリを削除しています 残り2件'],
      [{ running: true, runningRecord, local: null }, 'アプリを削除しています 残り2件'],
      [{ running: false, runningRecord, local: 'この画面の最新の行' }, 'この画面の最新の行'],
      [{ running: false, runningRecord, local: null }, null],
      [{ running: false, runningRecord: null, local: 'この画面の最新の行' }, 'この画面の最新の行'],
      [{ running: false, runningRecord: null, local: null }, null],
    ]
    for (const [input, out] of table) expect(teardownProgressText(input), JSON.stringify(input)).toBe(out)
  })
})

describe('notifyTeardownFinished: 開いている画面へ知らせるだけ（読み直すだけで書かない）', () => {
  it('sakura-meta-changed の Event を window へ1回出す', () => {
    const types: string[] = []
    ;(globalThis as any).window = { dispatchEvent: (e: Event) => { types.push(e.type); return true } }
    notifyTeardownFinished()
    expect(types).toEqual(['sakura-meta-changed'])
  })
})
