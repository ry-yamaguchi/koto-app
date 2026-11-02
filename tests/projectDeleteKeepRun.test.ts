import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── 削除の画面: 保存場所が全部「消さずに残す」回は、残りの段を足さない（本物の readProjectDeleteFacts・本物の cloud:twinFacts・runProjectDelete・trashProjectFs）──────────────
// 実フォルダに複製（同じ保存場所の同じ prefix を持つ兄弟）を置く。材料は本物の readProjectDeleteFacts（cloud:teardownRecord・cloud:recordTwins・cloud:twinFacts は本物の main）、
// 判断は本物の planProjectDeleteTeardown、走らせるのは本物の runProjectDelete・teardownPublished、フォルダを移すのは本物の trashProjectFs（shell.trashItem の代役を呼ばれた一覧で見る）。
// 口は偽（確認の答え・HANAMII の IPC・さくらの client・保存場所）。
//   R4  … 公開の記録の無い複製が、同じ保存場所の同じ prefix を持つ → 段なし・確認 0・teardown の IPC 0・要求 0 件で、フォルダは移る
//   R3  … 同じ公開の記録を持つ複製（HANAMII の行を覆う）がいて、保存場所も同じ → 破棄は外れ、残りの段も足されず、フォルダだけ移る
//   混在 … 一部だけ keep → 段は足され、確認は消す側だけを言い、main は keep の保存場所に触れない
//   読めない … cloud:twinFacts が無い・失敗 → 今までどおり段を足す（main が最後の判断者）
// 変異: 全 keep でも段を足す／混在で消すものまで外す／読めない回を keep と読む（不明を肯定に）／赤い箱の文を戻す。

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))
vi.mock('../src/renderer/components/CredentialsModal', () => ({
  getHanamiiToken: async () => 'tok-active',
  getHanamiiTokenById: async () => 'tok-recorded',
}))

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { resetProjectOpsForTests } from '../src/main/projectOps'
import { trashProjectFs } from '../src/main/ipc/fsTrash'
import { runProjectDelete, pressProjectDelete, teardownPublished, type ProjectDeleteRunDeps } from '../src/renderer/teardown/projectDelete'
import { readProjectDeleteFacts } from '../src/renderer/teardown/projectDeleteFacts'
import { planProjectDeleteTeardown } from '../src/renderer/teardown/projectDeletePlan'
import { leftoverStorageNoteLine, rowStorageNotesOf, keptStorageNoteOf, unsteppedLeftoverNote } from '../src/renderer/teardown/projectDeleteWords'
import { resolveConfirmWithChoices, type ConfirmWithChoicesAnswer, type ConfirmWithChoicesOptions } from '../src/renderer/useConfirmChoices'
import type { ConfirmOptions } from '../src/renderer/useConfirm'
import { h, resetHarness, newProjectDir, workspaceOf, setup as setupProject, A, B, PREFIX, bucketRef } from './sharedTeardownHarness'

registerCloudHandlers({} as any)
const mainTeardown = h.handlers.get('cloud:teardown')!
const mainRecord = h.handlers.get('cloud:teardownRecord')!
const mainTwins = h.handlers.get('cloud:recordTwins')!
const mainTwinFacts = h.handlers.get('cloud:twinFacts')!

let dir = ''
let win!: { teardownCalls: unknown[][]; hanamiiCalls: unknown[][]; twinFacts: 'real' | 'absent' | 'failed' | 'throws'; twinFactsCalls: unknown[][] }

const copyDir = () => path.join(workspaceOf(dir), 'copy')
const HANAMII_ROW = { publishedAt: '2026-09-29T00:00:00.000Z', url: 'https://myapp.hanamii.test' }
/** HANAMII の行つきの公開の記録（同じ projectId なら、複製がこの公開先を覆う）。 */
function writeHanamiiMeta(d: string) {
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, '.sakuraide.json'), JSON.stringify({
    name: 'myapp',
    publish: { hanamii: { workspaceId: 'ws-1', projectId: 'hnm-proj-1', name: 'myapp', tokenId: 'tk-recorded' }, targets: { hanamii: HANAMII_ROW } },
  }, null, 2), 'utf-8')
}

beforeEach(() => {
  resetProjectOpsForTests()
  resetHarness()
  dir = newProjectDir()
  win = { teardownCalls: [], hanamiiCalls: [], twinFacts: 'real', twinFactsCalls: [] }
  const cloud: Record<string, unknown> = {
    teardownRecord: (d: string) => mainRecord({}, d),
    recordTwins: (d: string) => mainTwins({}, d),
    teardown: (d: string, auth: unknown, opts: unknown) => { win.teardownCalls.push([d, auth, opts]); return mainTeardown({}, d, auth, opts) },
  }
  // 窓の口は呼ばれた時点で win.twinFacts を見る（口が無い回は、プロパティが無いのと同じ答え）
  Object.defineProperty(cloud, 'twinFacts', {
    enumerable: true,
    get: () => win.twinFacts === 'absent' ? undefined : (d: string, a: unknown) => {
      win.twinFactsCalls.push([d, a])
      if (win.twinFacts === 'throws') throw new Error('IPC が落ちた（テスト）')
      return win.twinFacts === 'failed' ? { ok: false } : mainTwinFacts({}, d, a)
    },
  })
  ;(globalThis as any).window = {
    electronAPI: {
      cloud,
      hanamii: { teardown: async (...a: unknown[]) => { win.hanamiiCalls.push(a); return { ok: true } } },
      fs: { readFile: async (p: string) => fs.readFileSync(p, 'utf-8'), exists: async (p: string) => fs.existsSync(p) },
      storage: {
        placement: async (d: string) => {
          const list = JSON.parse(fs.readFileSync(path.join(d, '.sakura-cloud', 'env.json'), 'utf-8'))?.persistence?.objectStorage ?? []
          return { ok: true, placements: list.map((p: any) => ({ bucket: p.bucket, prefix: p.prefix, shared: p.shared })) }
        },
      },
      apprunDedicated: { state: async () => null },
      stageTiming: { estimates: async () => null },
      win: { setBusy: () => {} },
      publishMeta: { runningOp: async () => null },
    },
    dispatchEvent: () => true,
  }
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(copyDir(), { recursive: true, force: true })
  delete (globalThis as any).window
})

/** 確認の答えを決め、開いた確認の見出しと本文を残す偽の confirm／confirmWithChoices（選択つきは本物のフックと同じ規則）。 */
function fakeAsk(answer: boolean) {
  const asked: Array<{ title: string; body: string }> = []
  return {
    asked,
    confirm: async (o: ConfirmOptions) => { asked.push({ title: o.title, body: o.body }); return answer },
    confirmWithChoices: async (o: ConfirmWithChoicesOptions): Promise<ConfirmWithChoicesAnswer> => {
      asked.push({ title: o.title, body: o.body })
      return answer ? resolveConfirmWithChoices('confirm', o.choices, {}) : { confirmed: false, choices: {} }
    },
  }
}
/** フォルダを移す口は本物の trashProjectFs（shell.trashItem の代役を呼ばれた一覧で見る）。 */
function makeDeps(ask: ReturnType<typeof fakeAsk>, trashItem: (p: string) => Promise<void>): ProjectDeleteRunDeps {
  return {
    readFacts: readProjectDeleteFacts,
    teardown: (d, ts, o) => teardownPublished(d, ts, { confirm: ask.confirm, confirmWithChoices: ask.confirmWithChoices }, o),
    runningOp: async () => null,
    exists: async () => true,
    trash: async (p, skipped) => {
      const r = await trashProjectFs(p, { confirmed: true, skippedForTwins: skipped }, { home: os.tmpdir(), trashItem })
      if (!r.ok) throw new Error(r.message)
    },
  }
}
const readAll = (d: string) => ['.sakuraide.json', '.sakura-cloud/env.json', '.sakura-cloud/state.json'].map(f => {
  try { return fs.readFileSync(path.join(d, f), 'utf-8') } catch { return null }
})
const KEEP_TWIN = { risk: 'twin', folders: ['copy'] }
const KEPT_LINE = `保存場所『${A}』とその中のデータは残ります（消すまで月額が続きます）。フォルダ『copy』も同じデータを使っています。`
/** 保存場所 A の残り（保存場所だけ。アプリ・レジストリは無い）。 */
const putStorageA = () => setupProject(dir, { env: [A], resources: [bucketRef(A)] })
/** 同じ保存場所 A の同じ prefix を持つ複製（公開の記録は無い。「用意しただけ」の複製）。 */
const putTwinOfA = () => { fs.mkdirSync(copyDir(), { recursive: true }); setupProject(copyDir(), { env: [A], resources: [] }) }

describe('T-1e R4 の形: 公開の記録の無い複製が同じ保存場所を持つ → 残りの段を足さず、確認も IPC も出さずにフォルダを移す', () => {
  it('★★★ 材料の keep は本物の cloud:twinFacts の答え。plan は段なし（leftover のキーも無い）', async () => {
    putStorageA(); putTwinOfA()
    const facts = await readProjectDeleteFacts(dir)
    expect(facts.placements).toEqual([{ bucket: A, prefix: PREFIX, shared: true, keep: KEEP_TWIN }])
    expect(facts.sharedLeftover?.placements).toEqual([{ bucket: A, prefix: PREFIX, shared: true, keep: KEEP_TWIN }])
    const plan = planProjectDeleteTeardown(facts)
    expect(plan).toEqual({ block: null, teardown: [], twinned: [] })
    expect('leftover' in plan).toBe(false)
    expect(win.twinFactsCalls).toHaveLength(1) // 材料の保存場所と記録の残りを、1回の問い合わせにまとめる
  })

  it('★★★ 押す: 確認 0 回・cloud:teardown 0 回・HANAMII 0 回・保存場所と client への要求 0 件。本物の trashProjectFs がフォルダを1回移す。記録は1バイトも変わらない', async () => {
    putStorageA(); putTwinOfA()
    const beforeOwn = readAll(dir); const beforeCopy = readAll(copyDir())
    const facts = await readProjectDeleteFacts(dir)
    const plan = planProjectDeleteTeardown(facts)
    const ask = fakeAsk(true)
    const trashItem = vi.fn(async (_p: string) => {})
    const r = await runProjectDelete(dir, plan, true, makeDeps(ask, trashItem))
    expect(r.phase).toBe('trashed')
    expect(r.steps).toEqual([])
    expect(ask.asked).toEqual([])
    expect(win.teardownCalls).toEqual([])
    expect(win.hanamiiCalls).toEqual([])
    expect(h.calls).toEqual([]) // connect・listAllKeys・deleteKeys・deleteBucket・deletePermission・listPermissions を含め 0 件
    expect(trashItem.mock.calls).toEqual([[dir]])
    expect(readAll(dir)).toEqual(beforeOwn)
    expect(readAll(copyDir())).toEqual(beforeCopy)
  })

  it('★★★ 押し直しの経路（pressProjectDelete）も同じ。1回の押しでフォルダが移り、読み直しも確認もしない', async () => {
    putStorageA(); putTwinOfA()
    const facts = await readProjectDeleteFacts(dir)
    const plan = planProjectDeleteTeardown(facts)
    const ask = fakeAsk(true)
    const trashItem = vi.fn(async (_p: string) => {})
    const r = await pressProjectDelete(dir, { plan, run: null, seen: facts }, true, makeDeps(ask, trashItem))
    expect(r.run.phase).toBe('trashed')
    expect(ask.asked).toEqual([])
    expect(win.teardownCalls).toEqual([])
    expect(trashItem.mock.calls).toEqual([[dir]])
  })

  it('★★★ 赤い箱の文（3つの経路）: leftoverNote は「残ります」と複製のフォルダ名。rowNotes・leftoverLine の経路にも、keep の保存場所に「データも削除します」は出ない', async () => {
    putStorageA(); putTwinOfA()
    const facts = await readProjectDeleteFacts(dir)
    const plan = planProjectDeleteTeardown(facts)
    expect(unsteppedLeftoverNote(facts, false)).toBe(KEPT_LINE)
    expect(leftoverStorageNoteLine(plan, facts)).toBe('') // 段が無いので、残りの段の行は無い
    // チェックを外した回の1行は、keep の有無によらず今の文（保存場所が残ることと月額）。keep の理由は言わない
    expect(keptStorageNoteOf(facts)).toBe(`保存場所「${A}」とその中のデータは残ります（消すまで月額495円・税込が続きます）。`)
    // HANAMII の行が加わる回（rowNotes の経路）でも、同じ保存場所は「残ります」
    const withRow = { ...facts, targets: ['hanamii' as const] }
    expect(rowStorageNotesOf(planProjectDeleteTeardown(withRow), withRow)).toEqual([{ target: 'hanamii', note: KEPT_LINE }])
    for (const t of [unsteppedLeftoverNote(facts, false), keptStorageNoteOf(facts), rowStorageNotesOf(planProjectDeleteTeardown(withRow), withRow)[0].note]) {
      expect(t).not.toContain('データも削除します')
    }
  })

  it('★★ 複製の記録を読めない（壊れた env.json）→ keep は unread。段は足さず、赤い箱は確かめられなかったと言う', async () => {
    putStorageA()
    fs.mkdirSync(path.join(copyDir(), '.sakura-cloud'), { recursive: true })
    fs.writeFileSync(path.join(copyDir(), '.sakura-cloud', 'env.json'), '{ 壊れた', 'utf-8')
    const facts = await readProjectDeleteFacts(dir)
    expect(facts.sharedLeftover?.placements).toEqual([{ bucket: A, prefix: PREFIX, shared: true, keep: { risk: 'unread', folders: ['copy'] } }])
    expect(planProjectDeleteTeardown(facts)).toEqual({ block: null, teardown: [], twinned: [] })
    expect(unsteppedLeftoverNote(facts, false)).toBe(
      `保存場所『${A}』とその中のデータは残ります（消すまで月額が続きます）。フォルダ『copy』の記録を読めないため、同じデータを使っているか確かめられませんでした。`)
  })

  it('★★ 対照: 兄弟が別のバケット・別の prefix なら keep は付かず、今までどおり段を足す', async () => {
    putStorageA()
    fs.mkdirSync(copyDir(), { recursive: true })
    setupProject(copyDir(), { env: ['koto-other'], resources: [] })
    const facts = await readProjectDeleteFacts(dir)
    expect(facts.sharedLeftover?.placements.every(p => !('keep' in p))).toBe(true)
    expect(planProjectDeleteTeardown(facts)).toMatchObject({ teardown: ['sakura-apprun'], leftover: { noun: '保存場所' } })
  })
})

describe('T-1e R3 後半の形: 同じ公開の記録を持つ複製（HANAMII の行を覆う）で、保存場所も同じ → 破棄は外れ、残りの段も足さない', () => {
  it('★★★ plan は破棄なし・複製あり。確認 0・HANAMII 0・cloud:teardown 0・要求 0 件。フォルダだけ移る（skippedForTwins は hanamii）', async () => {
    putStorageA(); writeHanamiiMeta(dir)
    putTwinOfA(); writeHanamiiMeta(copyDir())
    const facts = await readProjectDeleteFacts(dir)
    expect(facts.targets).toEqual(['hanamii'])
    expect(facts.sharedLeftover?.placements[0]).toMatchObject({ bucket: A, keep: { risk: 'twin' } })
    const plan = planProjectDeleteTeardown(facts)
    expect(plan).toEqual({ block: null, teardown: [], twinned: [{ target: 'hanamii', folders: ['copy'] }] })
    const ask = fakeAsk(true)
    const trashItem = vi.fn(async (_p: string) => {})
    const r = await runProjectDelete(dir, plan, true, makeDeps(ask, trashItem))
    expect(r.phase).toBe('trashed')
    expect(ask.asked).toEqual([])
    expect(win.teardownCalls).toEqual([])
    expect(win.hanamiiCalls).toEqual([])
    expect(h.calls).toEqual([])
    expect(trashItem.mock.calls).toEqual([[dir]])
  })
})

describe('T-1e 一部だけ keep（混在）: 段は足され、確認は消す側だけを言い、main は keep の保存場所に触れない', () => {
  /** 保存場所 A（複製がいる）と B（複製がいない）の残り。 */
  const putMixed = () => { setupProject(dir, { env: [A, B], resources: [bucketRef(A), bucketRef(B)] }); putTwinOfA() }

  it('★★★ plan は段を足す（呼び名は「保存場所」）。材料の keep は A にだけ付く', async () => {
    putMixed()
    const facts = await readProjectDeleteFacts(dir)
    expect(facts.sharedLeftover?.placements).toEqual([
      { bucket: A, prefix: PREFIX, shared: true, keep: KEEP_TWIN },
      { bucket: B, prefix: PREFIX, shared: true },
    ])
    expect(planProjectDeleteTeardown(facts)).toMatchObject({ block: null, teardown: ['sakura-apprun'], leftover: { noun: '保存場所' } })
  })

  it('★★★ 押す: 確認は1回で、消す B だけを「削除します」と言い、A は「残ります」。main へ運ぶ組の A に keepData。A への削除要求は0件・B は消す', async () => {
    putMixed()
    const facts = await readProjectDeleteFacts(dir)
    const plan = planProjectDeleteTeardown(facts)
    const ask = fakeAsk(true)
    const trashItem = vi.fn(async (_p: string) => {})
    const r = await runProjectDelete(dir, plan, true, makeDeps(ask, trashItem))
    expect(ask.asked).toHaveLength(1)
    expect(ask.asked[0].title).toBe('保存場所を破棄します')
    expect(ask.asked[0].body).toContain(`保存場所『${B}』にある、このプロジェクトのデータも削除します。`)
    expect(ask.asked[0].body).not.toContain(`保存場所『${A}』にある、このプロジェクトのデータも削除します。`)
    expect(ask.asked[0].body).toContain(`保存場所『${A}』とその中のデータは残ります`)
    expect(ask.asked[0].body).toContain('フォルダ『copy』も同じデータを使っています。')
    expect(win.teardownCalls).toHaveLength(1)
    expect((win.teardownCalls[0][2] as any).shownPlacements).toEqual([{ bucket: A, prefix: PREFIX, keepData: true }, { bucket: B, prefix: PREFIX }])
    expect(h.calls.filter(c => /^(deleteKeys|deleteBucket|deletePermission)/.test(c) && c.includes(A))).toEqual([]) // A には削除要求を出さない
    expect(h.calls).toContain(`deleteKeys ${B}`)
    expect(r.steps).toHaveLength(1)
    expect(r.steps[0]).toMatchObject({ target: 'sakura-apprun', kind: 'done', leftover: true, label: '保存場所' })
  })

  it('★★★ 共用型の記録にレジストリがある（選択つきの確認の枝）: 残りの段でも、main へ運ぶ組の A に keepData が付き、選んだ値・記録のレジストリ名と一緒に届く', async () => {
    // 借り物のレジストリ（記録の registryAdopted:true）＝確認の既定はオフ。選択つきの確認は confirmWithChoices で聞く。
    setupProject(dir, { env: [A, B], resources: [bucketRef(A), bucketRef(B)], meta: { registryName: 'reg-borrowed', registryAdopted: true } })
    putTwinOfA()
    const facts = await readProjectDeleteFacts(dir)
    expect(facts.sharedLeftover?.registryName).toBe('reg-borrowed')
    const plan = planProjectDeleteTeardown(facts)
    expect(plan).toMatchObject({ block: null, teardown: ['sakura-apprun'], leftover: { noun: '保存場所・コンテナレジストリ' } })
    const ask = fakeAsk(true)
    let withChoices = 0; let plain = 0
    const wrapped = {
      ...ask,
      confirm: async (o: ConfirmOptions) => { plain++; return ask.confirm(o) },
      confirmWithChoices: async (o: ConfirmWithChoicesOptions) => { withChoices++; return ask.confirmWithChoices(o) },
    }
    const trashItem = vi.fn(async (_p: string) => {})
    await runProjectDelete(dir, plan, true, makeDeps(wrapped, trashItem))
    expect([withChoices, plain]).toEqual([1, 0]) // 選択つきの確認だけが開く
    expect(ask.asked[0].title).toBe('保存場所・コンテナレジストリを破棄します')
    expect(win.teardownCalls).toHaveLength(1)
    expect(win.teardownCalls[0][2]).toStrictEqual({
      confirmed: true,
      deleteRegistry: false,
      registryName: 'reg-borrowed',
      shownPlacements: [{ bucket: A, prefix: PREFIX, keepData: true }, { bucket: B, prefix: PREFIX }],
    })
    expect(h.calls.filter(c => /^(deleteKeys|deleteBucket|deletePermission)/.test(c) && c.includes(A))).toEqual([]) // A には削除要求を出さない
    expect(h.calls).toContain(`deleteKeys ${B}`)
  })

  it('★★ 混在の赤い箱の 💾: leftoverLine は B を「削除します」・A を「残ります」と言い分ける', async () => {
    putMixed()
    const facts = await readProjectDeleteFacts(dir)
    const plan = planProjectDeleteTeardown(facts)
    const line = leftoverStorageNoteLine(plan, facts)
    expect(line).toContain(`保存場所『${B}』にある、このプロジェクトのデータも削除します。`)
    expect(line).not.toContain(`保存場所『${A}』にある、このプロジェクトのデータも削除します。`)
    expect(line.endsWith(KEPT_LINE)).toBe(true)
  })
})

describe('T-1e 読みが null（口が無い・失敗）: 今までどおり段を足す（不明を「消さない」に倒さない）。main が最後の判断者', () => {
  it.each([['口が無い', 'absent'], ['ok:false', 'failed'], ['口が投げる', 'throws']] as const)('★★★ %s: keep は付かず、plan は残りの段を足す。押すと確認が出る。複製がいる保存場所は main が残す（削除要求は0件）', async (_name, mode) => {
    putStorageA(); putTwinOfA()
    win.twinFacts = mode
    const facts = await readProjectDeleteFacts(dir)
    expect(facts.placements.every(p => !('keep' in p))).toBe(true)
    expect(facts.sharedLeftover?.placements.every(p => !('keep' in p))).toBe(true)
    const plan = planProjectDeleteTeardown(facts)
    expect(plan).toMatchObject({ block: null, teardown: ['sakura-apprun'], leftover: { noun: '保存場所' } })
    const ask = fakeAsk(true)
    const trashItem = vi.fn(async (_p: string) => {})
    await runProjectDelete(dir, plan, true, makeDeps(ask, trashItem))
    expect(ask.asked).toHaveLength(1) // 確認は出る（keep を知らないので「データも削除します」と言う側）
    expect(win.teardownCalls).toHaveLength(1)
    // main は記録から複製を見つけて残す（確認が keep を知らなくても、データ・バケット・鍵に削除要求を出さない）
    expect(h.calls.filter(c => /^(deleteKeys|deleteBucket|deletePermission)/.test(c))).toEqual([])
  })
})
