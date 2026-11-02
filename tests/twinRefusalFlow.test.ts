import { describe, it, expect, vi, afterEach } from 'vitest'

// ── 公開先の拒否は、確認を出さずに結果を返す（画面の流れ）──────────────────────────────────────────────────────────
// 確認の材料（facts.ts の loadTeardownFacts）が `cloud:twinFacts` を1回読み、公開先の断り（refusal）と保存場所ごとの keep を付ける。
// 流れ（flow.ts の runTeardownFlow）は、断る回（同じ公開の記録を持つフォルダがいる・いるか確かめられない）に、確認も IPC も活動レジストリもキーの読み出しも出さず、
// main の断りと同じ文の失敗を返す。読めなかった回は、確認は今までどおり出て、注意の1行が付く。
// 偽の口に流し、実際に呼ばれた回数と順を見る（ソースの文字列は読まない・掟10）。本物の main と並べた比べは tests/twinRefusalRealMain.test.ts。
// 変異: refusal を無視して確認へ進む／unknown を通す／確認のあとで読む／読めなかった回に keep を付ける／読めなかった印を付けない。

vi.mock('../src/renderer/components/CredentialsModal', () => ({
  getHanamiiToken: async () => 'tok-active',
  getHanamiiTokenById: async () => 'tok-recorded',
}))

import { runTeardownFlow, electronFlowDeps } from '../src/renderer/teardown/flow'
import { loadTeardownFacts, placementsWithKeep, electronTeardownFactsApi, type TeardownFactsApi } from '../src/renderer/teardown/facts'
import { buildTeardownConfirm, unreadableCautions } from '../src/renderer/teardown/confirm'
import { sharedTeardownSpec, type SharedTeardownRecord } from '../src/renderer/teardown/targets/shared'
import { hanamiiTeardownSpec, type HanamiiTeardownRecord } from '../src/renderer/teardown/targets/hanamii'
import { dedicatedTeardownSpec, type DedicatedTeardownRecord } from '../src/renderer/teardown/targets/dedicated'
import type { TargetSpec, TeardownFacts, TeardownPlacement } from '../src/renderer/teardown/types'
import type { ConfirmWithChoicesAnswer, ConfirmWithChoicesOptions } from '../src/renderer/useConfirmChoices'
import type { ConfirmOptions } from '../src/renderer/useConfirm'
import type { TwinFactsArgs, TwinFactsResult } from '../src/shared/twinFactsTypes'
import { twinsRefusedMessage, TWINS_UNKNOWN_MESSAGE, twinsRefusalMessage } from '../src/shared/twinsRefusal'
import { twinsRefusedMessage as shellRefused, TWINS_UNKNOWN_MESSAGE as shellUnknown } from '../src/main/cloud/teardownShell'

const A: TeardownPlacement = { bucket: 'koto-data-a', prefix: 'projects/myapp/', shared: true }
const B: TeardownPlacement = { bucket: 'koto-data-b', prefix: 'projects/other/', shared: false }
const NO_PREFIX: TeardownPlacement = { bucket: 'koto-data-c' }

const SHARED_RECORD: SharedTeardownRecord = {
  appNames: ['myapp'], registryName: null, registryOrigin: 'owned', registryUsers: [], placements: [], stateOnlyBuckets: [],
}
const SHARED_EMPTY: SharedTeardownRecord = { ...SHARED_RECORD, appNames: [] }
const HANAMII_RECORD: HanamiiTeardownRecord = { projectId: 'p-1', name: 'myapp', tokenId: 'tok-1', storageLeftoverBuckets: null }
const DEDICATED_RECORD: DedicatedTeardownRecord = { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1', applicationID: 'app1', applicationName: 'myapp' }

type Door = 'cloud' | 'hanamii' | 'apprunDedicated'
let ipc: Array<{ door: Door; dir: string; opts: any }> = []

function installWindow() {
  ipc = []
  const reply = (door: Door) => async (dir: string, _auth: unknown, opts: unknown) => { ipc.push({ door, dir, opts }); return { ok: true, executed: [], message: '', remaining: {} } }
  ;(globalThis as any).window = {
    electronAPI: {
      cloud: { teardown: reply('cloud'), loadKey: async () => ({ token: 't', secret: 's' }) },
      hanamii: { teardown: reply('hanamii') },
      apprunDedicated: { teardown: reply('apprunDedicated'), onTeardownProgress: () => () => {} },
      win: { setBusy: () => {} },
    },
  }
}
afterEach(() => { delete (globalThis as any).window })

type Case = { name: string; door: Door; spec: TargetSpec<any, any, any>; record: unknown }
const CASES: Case[] = [
  { name: '共用型', door: 'cloud', spec: sharedTeardownSpec, record: SHARED_RECORD },
  { name: 'HANAMII', door: 'hanamii', spec: hanamiiTeardownSpec, record: HANAMII_RECORD },
  { name: '専有型', door: 'apprunDedicated', spec: dedicatedTeardownSpec, record: DEDICATED_RECORD },
]

function factsOf(record: unknown, over: Partial<TeardownFacts<any>> = {}): TeardownFacts<any> {
  return {
    projectName: 'myapp', record, placements: [], placementsUnreadable: false, placementsUnreadableCause: null,
    otherTargets: [], otherTargetsUnreadable: false, waitNote: null, ...over,
  }
}

/** 本物の流れと本物の deps の組み立てに、材料だけを差し替えて通す。確認・活動レジストリ・キーの読み出しの回数と順を数える。 */
async function runFlow(c: Case, facts: TeardownFacts<any>, extra: { hasWork?: (r: any) => boolean; answer?: boolean; reportShown?: boolean } = {}) {
  installWindow()
  const order: string[] = []
  const asked: ConfirmOptions[] = []
  const entry = {
    confirm: async (o: ConfirmOptions) => { order.push('confirm'); asked.push(o); return extra.answer ?? true },
    confirmWithChoices: async (o: ConfirmWithChoicesOptions): Promise<ConfirmWithChoicesAnswer> => { order.push('confirm'); asked.push(o); return { confirmed: extra.answer ?? true, choices: {} } },
    keyMissingMessage: 'キーがありません（テスト）',
    ...(extra.hasWork ? { hasWork: extra.hasWork } : {}),
    ...(extra.reportShown ? { reportShown: true } : {}),
  }
  const base = electronFlowDeps('/proj', c.spec, entry)
  const deps = {
    ...base,
    loadFacts: async () => { order.push('loadFacts'); return facts },
    loadAuth: async (r: any) => { order.push('loadAuth'); return base.loadAuth(r) },
    beginActivity: (label: string, o: any) => { order.push('beginActivity'); return base.beginActivity(label, o) },
    onStart: () => { order.push('onStart') },
  }
  const out = await runTeardownFlow('/proj', c.spec, deps)
  return { out, order, asked }
}

const TWIN = { kind: 'twin' as const, folders: ['copy'] }
const UNKNOWN = { kind: 'unknown' as const }

describe('★★★ 公開先の拒否: 3つの仕様書×（twin・unknown）で、確認 0 回・IPC 0 回・活動レジストリ 0 回・キーの読み出し 0 回', () => {
  for (const c of CASES) {
    it(`${c.name} × twin: 結果は main の断りと同じ文の失敗。確認もキーも IPC も活動レジストリも呼ばない`, async () => {
      const { out, order, asked } = await runFlow(c, factsOf(c.record, { refusal: TWIN, placements: [A] }))
      expect(out).toMatchObject({ cancelled: false, result: { ok: false, message: twinsRefusedMessage(['copy']) } })
      expect(order).toEqual(['loadFacts'])
      expect(asked).toEqual([])
      expect(ipc).toEqual([])
    })

    it(`${c.name} × unknown: 結果は main の「確かめられなかった」断りと同じ文。何も呼ばない`, async () => {
      const { out, order, asked } = await runFlow(c, factsOf(c.record, { refusal: UNKNOWN }))
      expect(out).toMatchObject({ cancelled: false, result: { ok: false, message: TWINS_UNKNOWN_MESSAGE } })
      expect(order).toEqual(['loadFacts'])
      expect(asked).toEqual([])
      expect(ipc).toEqual([])
    })

    it(`${c.name} × 複製なし（refusal が null）: 今までどおり確認 → キー → IPC が1回。順序は 確認 → 活動レジストリ → 開始 → キー`, async () => {
      const { out, order, asked } = await runFlow(c, factsOf(c.record, { refusal: null, placements: [A] }))
      expect(order).toEqual(['loadFacts', 'confirm', 'beginActivity', 'onStart', 'loadAuth'])
      expect(asked).toHaveLength(1)
      expect(ipc.map(x => x.door)).toEqual([c.door])
      expect(out).toMatchObject({ cancelled: false })
    })

    it(`${c.name} × 読めなかった印（refusal が付かない）: 確認は今までどおり出て、IPC は1回。行き止まりにしない`, async () => {
      const { order, asked } = await runFlow(c, factsOf(c.record, { twinFactsUnreadable: true, placements: [A] }))
      expect(order).toEqual(['loadFacts', 'confirm', 'beginActivity', 'onStart', 'loadAuth'])
      expect(asked).toHaveLength(1)
      expect(ipc.map(x => x.door)).toEqual([c.door])
    })

    it(`${c.name} × 何も付いていない材料（口が無い）: 今までどおり確認 → IPC`, async () => {
      const { order } = await runFlow(c, factsOf(c.record, { placements: [A] }))
      expect(order).toEqual(['loadFacts', 'confirm', 'beginActivity', 'onStart', 'loadAuth'])
      expect(ipc).toHaveLength(1)
    })
  }

  it('断る回は、入口が reportShown を渡していても shownPlacements を結果に付けない（IPC まで進んでいないので、見せた組は無い）', async () => {
    const { out } = await runFlow(CASES[1], factsOf(HANAMII_RECORD, { refusal: TWIN, placements: [A] }), { reportShown: true })
    expect(out).toStrictEqual({ cancelled: false, result: { ok: false, message: twinsRefusedMessage(['copy']) } })
  })

  it('複数のフォルダ名は、骨と同じ並べ方で全部挙げる', async () => {
    const { out } = await runFlow(CASES[0], factsOf(SHARED_RECORD, { refusal: { kind: 'twin', folders: ['a copy', 'b copy'] } }))
    expect(out).toMatchObject({ result: { message: shellRefused(['a copy', 'b copy']) } })
    expect((out as any).result.message).toContain('『a copy』・『b copy』')
  })
})

describe('★★★ 順序: 消すものが無い（nothingToDo）が先。拒否の確認の前に読む', () => {
  it('共用型: 消すものが無く、拒否もあるとき → nothingToDo が先（結果は nothingToDo の文・印つき）', async () => {
    const { out, order } = await runFlow(CASES[0], factsOf(SHARED_EMPTY, { refusal: TWIN }))
    expect(out).toStrictEqual({ cancelled: false, result: { ok: false, message: sharedTeardownSpec.words.nothingToDo }, nothingToDo: true })
    expect(order).toEqual(['loadFacts'])
  })

  it('HANAMII・専有型: 消すものが無く、拒否もあるとき → nothingToDo の文（拒否の文ではない）', async () => {
    const h = await runFlow(CASES[1], factsOf({ ...HANAMII_RECORD, projectId: null }, { refusal: TWIN }))
    expect((h.out as any).result.message).toBe(hanamiiTeardownSpec.words.nothingToDo)
    const d = await runFlow(CASES[2], factsOf({ clusterID: null, asgID: null, loadBalancerID: null, applicationID: null, applicationName: null }, { refusal: TWIN }))
    expect((d.out as any).result.message).toBe(dedicatedTeardownSpec.words.nothingToDo)
  })

  it('入口の門（deps.hasWork）が「消すものが無い」と言う回も、nothingToDo が先', async () => {
    const { out } = await runFlow(CASES[0], factsOf(SHARED_RECORD, { refusal: TWIN }), { hasWork: () => false })
    expect(out).toMatchObject({ cancelled: false, nothingToDo: true, result: { message: sharedTeardownSpec.words.nothingToDo } })
  })

  it('拒否は確認のあとではなく前: 確認が「いいえ」でも拒否の結果は同じで、確認の関数は呼ばれない（確認の前に読む）', async () => {
    const { out, asked } = await runFlow(CASES[1], factsOf(HANAMII_RECORD, { refusal: TWIN }), { answer: false })
    expect(out).toMatchObject({ cancelled: false, result: { ok: false } })
    expect(asked).toEqual([])
  })
})

describe('twinsRefusalMessage / 再エクスポート: 文の作り手は shared の1つ', () => {
  it('twin（フォルダ名あり）だけが複製の文。unknown・形の違う値・フォルダ名が空の twin は「確かめられなかった」の文（複製の名前を挙げる側へ倒さない）', () => {
    expect(twinsRefusalMessage({ kind: 'twin', folders: ['x'] })).toBe(twinsRefusedMessage(['x']))
    expect(twinsRefusalMessage({ kind: 'unknown' })).toBe(TWINS_UNKNOWN_MESSAGE)
    expect(twinsRefusalMessage({ kind: 'twin', folders: [] })).toBe(TWINS_UNKNOWN_MESSAGE)
    expect(twinsRefusalMessage({ kind: 'twin' } as any)).toBe(TWINS_UNKNOWN_MESSAGE)
    expect(twinsRefusalMessage({ kind: 'what', folders: ['x'] } as any)).toBe(TWINS_UNKNOWN_MESSAGE)
  })

  it('骨（teardownShell.ts）が同じ関数・同じ定数を再エクスポートしている。文は固定（利用者が読む文）', () => {
    expect(shellRefused).toBe(twinsRefusedMessage)
    expect(shellUnknown).toBe(TWINS_UNKNOWN_MESSAGE)
    expect(twinsRefusedMessage(['C'])).toBe('フォルダ『C』にも同じ公開の記録があるため、何も破棄していません。要らないほうのフォルダを削除すると、残ったほうから破棄できます。')
    expect(TWINS_UNKNOWN_MESSAGE).toBe('同じ公開の記録を持つフォルダがあるか確かめられなかったため、何も破棄していません。')
  })
})

// ── 確認の材料: cloud:twinFacts を1回読み、読めた回だけ keep・refusal を付ける ───────────────────────────────────

type TwinApiOver = { twinFacts?: TeardownFactsApi['twinFacts'] }
function apiOf(over: TwinApiOver & { placements?: TeardownPlacement[] } = {}) {
  const calls: Array<{ dir: string; args: TwinFactsArgs }> = []
  const api: TeardownFactsApi = {
    placements: async () => over.placements ?? [A],
    otherTargets: async () => [],
    estimates: async () => null,
    ...(over.twinFacts ? { twinFacts: async (dir, args) => { calls.push({ dir, args }); return over.twinFacts!(dir, args) } } : {}),
  }
  return { api, calls }
}
const specOf = (target: 'hanamii' | 'sakura-apprun' | 'sakura-apprun-dedicated' = 'hanamii') => ({ target, readRecord: async () => ({ id: 'r1' }) })
const okResult = (placements: Array<{ bucket: string; prefix: string; keep?: any }>, refusal: any = null): TwinFactsResult =>
  ({ ok: true, refusal, placements: placements.map(p => ({ bucket: p.bucket, prefix: p.prefix, keep: p.keep ?? null })) })

describe('loadTeardownFacts: cloud:twinFacts を1回読んで、読めた回だけ keep・refusal を付ける', () => {
  it('★★★ 全部読めて複製なし: refusal は null・keep は付かない（保存場所の項目は現行と同じ）。問い合わせは1回で、公開先と保存場所の組（prefix の無いものは \'\'）を渡す', async () => {
    const { api, calls } = apiOf({ placements: [A, NO_PREFIX], twinFacts: async (_d, args) => okResult(args.placements) })
    const facts = await loadTeardownFacts('/work/myapp', specOf('sakura-apprun'), api)
    expect(calls).toEqual([{ dir: '/work/myapp', args: { target: 'sakura-apprun', placements: [{ bucket: 'koto-data-a', prefix: 'projects/myapp/' }, { bucket: 'koto-data-c', prefix: '' }] } }])
    expect(facts.refusal).toBeNull()
    expect(facts.placements).toEqual([A, NO_PREFIX])
    expect(facts.placements.every(p => !('keep' in p))).toBe(true)
    expect('twinFactsUnreadable' in facts).toBe(false)
  })

  it('★★★ keep のある保存場所だけに keep が付く（twin はフォルダ名つき・unread は読めなかったフォルダ名）。ほかの項目は変わらず、全件が残る', async () => {
    const keepTwin = { risk: 'twin', folders: ['copy'] }
    const keepUnread = { risk: 'unread', folders: [] }
    const { api } = apiOf({
      placements: [A, B, NO_PREFIX],
      twinFacts: async (_d, args) => okResult(args.placements.map((p, i) => ({ ...p, keep: i === 0 ? keepTwin : i === 2 ? keepUnread : null }))),
    })
    const facts = await loadTeardownFacts('/work/myapp', specOf(), api)
    expect(facts.placements).toEqual([{ ...A, keep: keepTwin }, B, { ...NO_PREFIX, keep: keepUnread }])
    expect(facts.placements).toHaveLength(3)
  })

  it('★★ refusal（twin・unknown）はそのまま材料に載る', async () => {
    for (const refusal of [TWIN, UNKNOWN]) {
      const { api } = apiOf({ twinFacts: async (_d, args) => okResult(args.placements, refusal) })
      expect((await loadTeardownFacts('/p', specOf(), api)).refusal).toEqual(refusal)
    }
  })

  it('★★★ 読めなかった回（投げた・ok:false・形の違う答え）: keep も refusal も付けず、読めなかった印だけ。保存場所の項目は現行のまま', async () => {
    const keepTwin = { risk: 'twin', folders: ['copy'] }
    const bad: Array<[string, TeardownFactsApi['twinFacts']]> = [
      ['投げた', async () => { throw new Error('IPC の失敗') }],
      ['ok:false', async () => ({ ok: false })],
      ['undefined', async () => undefined as any],
      ['ok が true でない', async () => ({ ok: 'true', refusal: null, placements: [] }) as any],
      ['placements が配列でない', async () => ({ ok: true, refusal: null, placements: null }) as any],
      ['件数が違う', async () => okResult([])],
      ['名前が違う', async () => okResult([{ bucket: 'other', prefix: 'projects/myapp/', keep: keepTwin }])],
      ['prefix が違う', async () => okResult([{ bucket: 'koto-data-a', prefix: 'x/', keep: keepTwin }])],
      ['refusal が無い', async () => ({ ok: true, placements: [{ bucket: 'koto-data-a', prefix: 'projects/myapp/', keep: null }] }) as any],
      ['refusal の形が違う', async () => okResult([{ bucket: 'koto-data-a', prefix: 'projects/myapp/' }], { kind: 'twin', folders: [] })],
      ['keep が無い', async () => ({ ok: true, refusal: null, placements: [{ bucket: 'koto-data-a', prefix: 'projects/myapp/' }] }) as any],
      ['keep の形が違う', async () => okResult([{ bucket: 'koto-data-a', prefix: 'projects/myapp/', keep: { risk: 'maybe', folders: [] } }])],
      ['keep が真偽値', async () => okResult([{ bucket: 'koto-data-a', prefix: 'projects/myapp/', keep: true }])],
    ]
    for (const [name, twinFacts] of bad) {
      const { api } = apiOf({ twinFacts })
      const facts = await loadTeardownFacts('/p', specOf(), api)
      expect(facts.twinFactsUnreadable, name).toBe(true)
      expect('refusal' in facts, name).toBe(false)
      expect(facts.placements, name).toEqual([A])
      expect(facts.placements.every(p => !('keep' in p)), name).toBe(true)
    }
  })

  it('★★★ 余計な要素が付いた答え（渡した件数より多い。先頭は正しい）: 読めなかった扱い。keep も refusal も付けず、失敗の注意が付く。手順6の読み（placementsWithKeep）も付けない', async () => {
    const keepTwin = { risk: 'twin', folders: ['copy'] }
    const extra = { bucket: 'koto-extra', prefix: 'projects/extra/', keep: null }
    const cases: Array<[string, TeardownPlacement[], TeardownFactsApi['twinFacts']]> = [
      ['1件に1件の余計', [A], async (_d, args) => ({ ...okResult([{ ...args.placements[0], keep: keepTwin }], TWIN), placements: [{ ...args.placements[0], keep: keepTwin }, extra] })],
      ['2件に1件の余計（先頭2件は正しい）', [A, B], async (_d, args) => ({ ...okResult(args.placements.map((p, i) => ({ ...p, keep: i === 0 ? keepTwin : null })), TWIN), placements: [...args.placements.map((p, i) => ({ ...p, keep: i === 0 ? keepTwin : null })), extra] })],
    ]
    for (const [name, list, twinFacts] of cases) {
      const { api, calls } = apiOf({ placements: list, twinFacts })
      const facts = await loadTeardownFacts('/p', { ...hanamiiTeardownSpec, readRecord: async () => HANAMII_RECORD }, api)
      expect(calls, name).toHaveLength(1)
      expect(facts.twinFactsUnreadable, name).toBe(true)
      expect('refusal' in facts, name).toBe(false)
      expect(facts.placements, name).toEqual(list)
      expect(facts.placements.every(p => !('keep' in p)), name).toBe(true)
      // 確認: keep を付けないので今までどおり「消す」側の文のまま、失敗の注意が1つ付く
      const confirm = buildTeardownConfirm(hanamiiTeardownSpec, facts)
      expect(count(confirm.body, CAUTION), name).toBe(1)
      expect(confirm.body, name).toContain('にある、このプロジェクトのデータも削除します。')
      expect(confirm.body, name).not.toContain('は残ります')
      // 手順6の 💾 の行の読み: 読めなかった回は、渡した一覧をそのまま返す
      const row = apiOf({ placements: list, twinFacts })
      expect(await placementsWithKeep(row.api, '/p', 'sakura-apprun-dedicated', list), name).toEqual(list)
    }
  })

  it('★★ 口が無い（api に twinFacts が無い・null を返す）: 何も付けない（今までどおり）', async () => {
    const none = await loadTeardownFacts('/p', specOf(), apiOf().api)
    expect('refusal' in none).toBe(false)
    expect('twinFactsUnreadable' in none).toBe(false)
    const { api } = apiOf({ twinFacts: async () => null })
    const nul = await loadTeardownFacts('/p', specOf(), api)
    expect('refusal' in nul).toBe(false)
    expect('twinFactsUnreadable' in nul).toBe(false)
  })

  it('★★ 保存場所が無い・設定を読めない回も、公開先の断りのために1回だけ読む（保存場所の組は空）', async () => {
    const empty = apiOf({ placements: [], twinFacts: async () => okResult([], TWIN) })
    const f1 = await loadTeardownFacts('/p', specOf(), empty.api)
    expect(empty.calls).toHaveLength(1)
    expect(empty.calls[0].args.placements).toEqual([])
    expect(f1.refusal).toEqual(TWIN)
    const unreadable = apiOf({ twinFacts: async () => okResult([], null) })
    unreadable.api.placements = async () => { throw new Error('設定が読めません') }
    const f2 = await loadTeardownFacts('/p', specOf(), unreadable.api)
    expect(unreadable.calls).toHaveLength(1)
    expect(unreadable.calls[0].args.placements).toEqual([])
    expect(f2.placementsUnreadable).toBe(true)
  })

  it('名前の無い要素（null・空の bucket）は問い合わせず、そのまま通す。残りの keep は正しい要素に付く', async () => {
    const keepTwin = { risk: 'twin', folders: ['copy'] }
    const odd = [null, { bucket: '' }, B] as unknown as TeardownPlacement[]
    const { api, calls } = apiOf({ placements: odd, twinFacts: async (_d, args) => okResult(args.placements.map(p => ({ ...p, keep: keepTwin }))) })
    const facts = await loadTeardownFacts('/p', specOf(), api)
    expect(calls[0].args.placements).toEqual([{ bucket: 'koto-data-b', prefix: 'projects/other/' }])
    expect(facts.placements).toEqual([null, { bucket: '' }, { ...B, keep: keepTwin }])
  })

  it('electronTeardownFactsApi: window の cloud.twinFacts があれば、引数をそのまま渡して答えを返す。無ければ null（口が無い）で、材料には何も付かない', async () => {
    const seen: unknown[] = []
    ;(globalThis as any).window = {
      electronAPI: {
        storage: { placement: async () => ({ ok: true, placement: A, placements: [A] }) },
        fs: { readFile: async () => '{}', exists: async () => false },
        stageTiming: { estimates: async () => null },
        cloud: { twinFacts: async (dir: string, args: TwinFactsArgs) => { seen.push([dir, args]); return okResult(args.placements, TWIN) } },
      },
    }
    const withMouth = await loadTeardownFacts('/p', specOf(), electronTeardownFactsApi())
    expect(seen).toEqual([['/p', { target: 'hanamii', placements: [{ bucket: 'koto-data-a', prefix: 'projects/myapp/' }] }]])
    expect(withMouth.refusal).toEqual(TWIN)
    delete (globalThis as any).window.electronAPI.cloud
    const noMouth = await electronTeardownFactsApi().twinFacts!('/p', { target: 'hanamii', placements: [] })
    expect(noMouth).toBeNull()
    const facts = await loadTeardownFacts('/p', specOf(), electronTeardownFactsApi())
    expect('refusal' in facts).toBe(false)
    expect('twinFactsUnreadable' in facts).toBe(false)
  })
})

// ── 確認の文: 読めなかった回の注意の1行 ─────────────────────────────────────────────────────────────────────────
const CAUTION = '⚠️ 同じデータを使うフォルダがあるか確かめられませんでした。使っていれば、データは消さずに残します（月額が続きます）。'
const count = (s: string, sub: string) => s.split(sub).length - 1

describe('確認の注意: 同じデータを使うフォルダがあるか読めなかった回に、1行だけ付く', () => {
  it('★★★ 読めなかった印＋名前を挙げた保存場所 → 注意がちょうど1つ。3つの仕様書とも。確認は今までどおり「消す」側の文のまま', () => {
    for (const c of CASES) {
      const plain = buildTeardownConfirm(c.spec, factsOf(c.record, { placements: [A, B] }))
      const unread = buildTeardownConfirm(c.spec, factsOf(c.record, { placements: [A, B], twinFactsUnreadable: true }))
      expect(count(unread.body, CAUTION), c.name).toBe(1)
      expect(unread.body.replace(`\n\n${CAUTION}`, ''), c.name).toBe(plain.body)
    }
  })

  it('★★ 注意を出さない回: 読めた（印なし）・口が無い・保存場所が無い・保存場所の設定を読めない（main が触れない）', () => {
    expect(unreadableCautions(factsOf(null, { placements: [A] }), {} as any, 'always', 'hanamii')).toEqual([])
    expect(unreadableCautions(factsOf(null, { placements: [], twinFactsUnreadable: true }), {} as any, 'always', 'hanamii')).toEqual([])
    expect(unreadableCautions(factsOf(null, { placements: [null as any, { bucket: '' }], twinFactsUnreadable: true }), {} as any, 'always', 'hanamii')).toEqual([])
    const settings = unreadableCautions(factsOf(null, { placements: [], placementsUnreadable: true, placementsUnreadableCause: 'settings', twinFactsUnreadable: true }), {} as any, 'always', 'hanamii')
    expect(settings.some(l => l === CAUTION)).toBe(false)
    expect(settings).toHaveLength(1)
  })

  it('注意は ⚠️ の文のうち最後に並ぶ（ほかの公開先の記録を読めなかった注意と併せて2つ）', () => {
    const out = unreadableCautions(factsOf(null, { placements: [A], twinFactsUnreadable: true, otherTargetsUnreadable: true }), {} as any, 'always', 'hanamii')
    expect(out).toHaveLength(2)
    expect(out[1]).toBe(CAUTION)
  })
})
