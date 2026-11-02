import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── 公開の記録を読めない回（record-unreadable）を、本物の流れ・本物の main・偽の client に通す ──────────────────────────────────────
// 材料は本物の readProjectDeleteFacts、判断は本物の planProjectDeleteTeardown、走らせるのは本物の runProjectDelete・pressProjectDelete・teardownPublished。
// フォルダを移す口は本物の trashProjectFs（main の fs:trashProject の本体。shell.trashItem の代役を呼ばれた一覧で見る）。口は偽（確認の答え・HANAMII の IPC・さくらの client・保存場所）。
// 台は tests/projectDeleteLeftoverR4.test.ts と同じ（tests/sharedTeardownHarness.ts）。
//   止める … `state.json` だけが壊れていて、HANAMII の行は読めた回: 止める・押しても HANAMII へ要求0件・shell.trashItem 0回・記録が動かない。対照: 読めれば同じ行で破棄が走る
//   押し直し … 止まった画面を押し直したとき、開き直した材料が読めるようになっていれば、古い plan のまま移さず、読み直した plan で破棄から始まる

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
import { trashProjectFs, FS_TRASH_MESSAGES } from '../src/main/ipc/fsTrash'
import { runProjectDelete, pressProjectDelete, teardownPublished, type ProjectDeleteRunDeps } from '../src/renderer/teardown/projectDelete'
import { readProjectDeleteFacts } from '../src/renderer/teardown/projectDeleteFacts'
import { planProjectDeleteTeardown } from '../src/renderer/teardown/projectDeletePlan'
import { HANAMII_TEARDOWN_WORDS } from '../src/renderer/teardown/targets/hanamii'
import { resolveConfirmWithChoices, type ConfirmWithChoicesAnswer, type ConfirmWithChoicesOptions } from '../src/renderer/useConfirmChoices'
import type { ConfirmOptions } from '../src/renderer/useConfirm'
import { h, resetHarness, newProjectDir, setup as setupProject, A, bucketRef } from './sharedTeardownHarness'

registerCloudHandlers({} as any)
const mainTeardown = h.handlers.get('cloud:teardown')!
const mainRecord = h.handlers.get('cloud:teardownRecord')!
const mainTwins = h.handlers.get('cloud:recordTwins')!

let dir = ''
let win!: { teardownCalls: unknown[][]; hanamiiCalls: unknown[][] }

const metaFile = (d: string) => path.join(d, '.sakuraide.json')
const stateFile = (d: string) => path.join(d, '.sakura-cloud', 'state.json')
/** 公開の記録（.sakuraide.json）。HANAMII の行（と projectId）を置く。 */
function writeHanamiiMeta(d: string) {
  fs.writeFileSync(metaFile(d), JSON.stringify({
    name: 'myapp',
    publish: {
      hanamii: { workspaceId: 'ws-1', projectId: 'hnm-proj-1', name: 'myapp', tokenId: 'tk-recorded' },
      targets: { hanamii: { publishedAt: '2026-09-29T00:00:00.000Z', url: 'https://myapp.hanamii.test' } },
    },
  }, null, 2), 'utf-8')
}
/** HANAMII の行と、保存場所 A の残りがあるプロジェクト。brokenState なら state.json だけを壊す（.sakuraide.json は読める）。 */
function putProject(brokenState: boolean) {
  setupProject(dir, { env: [A], resources: [bucketRef(A)] })
  writeHanamiiMeta(dir)
  if (brokenState) fs.writeFileSync(stateFile(dir), '{ 壊れた state', 'utf-8')
}
const readAll = (d: string) => ['.sakuraide.json', '.sakura-cloud/env.json', '.sakura-cloud/state.json'].map(f => fs.readFileSync(path.join(d, f), 'utf-8'))

beforeEach(() => {
  resetProjectOpsForTests()
  resetHarness()
  dir = newProjectDir()
  win = { teardownCalls: [], hanamiiCalls: [] }
  ;(globalThis as any).window = {
    electronAPI: {
      cloud: {
        teardownRecord: (d: string) => mainRecord({}, d),
        recordTwins: (d: string) => mainTwins({}, d),
        teardown: (d: string, auth: unknown, opts: unknown) => { win.teardownCalls.push([d, auth, opts]); return mainTeardown({}, d, auth, opts) },
      },
      hanamii: {
        teardown: async (...a: unknown[]) => { win.hanamiiCalls.push(a); return { ok: true } },
      },
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
  delete (globalThis as any).window
})

/** 確認の答えを決め、開いた確認の見出しを残す偽の confirm／confirmWithChoices（選択つきは本物のフックと同じ規則）。 */
function fakeAsk(answer: boolean) {
  const titles: string[] = []
  return {
    titles,
    confirm: async (o: ConfirmOptions) => { titles.push(o.title); return answer },
    confirmWithChoices: async (o: ConfirmWithChoicesOptions): Promise<ConfirmWithChoicesAnswer> => {
      titles.push(o.title)
      return answer ? resolveConfirmWithChoices('confirm', o.choices, {}) : { confirmed: answer, choices: {} }
    },
  }
}

/** 押したときの口。ダイアログと同じ形。フォルダを移す口は本物の trashProjectFs（shell.trashItem の代役 trashItem の呼び出しを数える）。 */
function makeDeps(ask: ReturnType<typeof fakeAsk>, trashItem: (p: string) => Promise<void>, counters: { reads: number }): ProjectDeleteRunDeps {
  return {
    readFacts: async d => { counters.reads++; return readProjectDeleteFacts(d) },
    teardown: (d, ts, o) => teardownPublished(d, ts, { confirm: ask.confirm, confirmWithChoices: ask.confirmWithChoices }, o),
    runningOp: async () => null,
    exists: async () => true,
    trash: async (p, skippedForTwins) => {
      const r = await trashProjectFs(p, { confirmed: true, skippedForTwins }, { home: os.tmpdir(), trashItem })
      if (!r.ok) throw new Error(r.message)
    },
  }
}

describe('state.json だけが壊れ、HANAMII の行は読めた回: 画面が止める（チェックつきで破棄を走らせない）', () => {
  it('★★★ 材料: unreadable・HANAMII の行は読めている（読めた分は数える）。plan は record-unreadable・teardown は []（破棄する公開先を持たない）', async () => {
    putProject(true)
    const facts = await readProjectDeleteFacts(dir)
    expect(facts.unreadable).toBe(true)
    expect(facts.unconfirmed, '止める文が理由を言うので、弱い注意は立てない').toBe(false)
    expect(facts.targets).toEqual(['hanamii']) // 読めた分は数える（箱に見せる。破棄はしない）
    expect(planProjectDeleteTeardown(facts)).toEqual({ block: { reason: 'record-unreadable' }, teardown: [], twinned: [] })
  })

  it('★★★ 押しても、外への要求0件: HANAMII へ0件・cloud:teardown 0・保存場所・client への要求0件・shell.trashItem 0回・記録が動かない。最後の砦の本物の trashProjectFs も断る', async () => {
    putProject(true)
    const before = readAll(dir)
    const facts = await readProjectDeleteFacts(dir)
    const plan = planProjectDeleteTeardown(facts)
    const ask = fakeAsk(true)
    const trashItem = vi.fn(async (_p: string) => {})
    const r = await runProjectDelete(dir, plan, true, makeDeps(ask, trashItem, { reads: 0 }))
    // 外への要求を先に見る（要求が出ていれば、ここで落ちる）
    expect(win.hanamiiCalls).toEqual([])
    expect(win.teardownCalls).toEqual([])
    expect(h.calls).toEqual([]) // deleteKeys・deleteBucket・connect を含め、保存場所・client への要求は0件
    expect(ask.titles).toEqual([])
    expect(trashItem.mock.calls).toEqual([])
    expect(readAll(dir)).toEqual(before)
    expect(r).toEqual({ phase: 'blocked', block: { reason: 'record-unreadable' }, steps: [] })

    // 最後の砦: 画面が止めなくても、本物の main の口は同じ記録を断る（移す操作は0回）
    expect(await trashProjectFs(dir, { confirmed: true, skippedForTwins: [] }, { home: os.tmpdir(), trashItem })).toMatchObject({ ok: false, message: FS_TRASH_MESSAGES.stateUnreadable })
    expect(trashItem.mock.calls).toEqual([])
    expect(readAll(dir)).toEqual(before)
  })

  it('★★★ 対照（変異: block を立てない・eligible を外さない）: state.json が読めれば、同じ HANAMII の行の破棄が走る（確認 → HANAMII へ1回）', async () => {
    putProject(false)
    const facts = await readProjectDeleteFacts(dir)
    expect(facts.unreadable).toBe(false)
    const plan = planProjectDeleteTeardown(facts)
    expect(plan.block).toBeNull()
    expect(plan.teardown[0]).toBe('hanamii')
    const ask = fakeAsk(true)
    const r = await runProjectDelete(dir, plan, true, makeDeps(ask, async () => {}, { reads: 0 }))
    expect(ask.titles[0]).toBe(HANAMII_TEARDOWN_WORDS.confirmTitle)
    expect(win.hanamiiCalls).toHaveLength(1)
    expect(r.phase).not.toBe('blocked')
  })
})

describe('押し直し: 止まった画面を押し直したとき、開き直した材料が読めれば、読み直した plan で破棄から始まる（古い plan のまま移さない）', () => {
  it('★★★ 記録を読めない回で止まる → 記録を直す → 押し直すと、HANAMII の破棄から始まる。止まっている間は HANAMII へ要求0件', async () => {
    putProject(true)
    const first = await readProjectDeleteFacts(dir)
    const stalePlan = planProjectDeleteTeardown(first)
    expect(stalePlan.block).toEqual({ reason: 'record-unreadable' })
    const ask = fakeAsk(true)
    const trashItem = vi.fn(async (_p: string) => {})
    const counters = { reads: 0 }
    const deps = makeDeps(ask, trashItem, counters)

    const blocked = await pressProjectDelete(dir, { plan: stalePlan, run: null, seen: first }, true, deps)
    expect(blocked.run).toEqual({ phase: 'blocked', block: { reason: 'record-unreadable' }, steps: [] })
    expect(win.hanamiiCalls).toEqual([])

    // 利用者が記録を直した（開き直した材料は読める）。見せていた古い plan（止まっている）のまま移さない
    setupProject(dir, { env: [A], resources: [bucketRef(A)] })
    const again = await pressProjectDelete(dir, { plan: stalePlan, run: blocked.run, seen: first }, true, deps)
    expect(counters.reads, '押し直しは材料を読み直す').toBe(1)
    expect(ask.titles[0], '破棄の確認から始まる').toBe(HANAMII_TEARDOWN_WORDS.confirmTitle)
    expect(win.hanamiiCalls, 'HANAMII の破棄が1回走る').toHaveLength(1)
    expect(again.run.phase).not.toBe('blocked')
    expect(again.run.steps[0]).toMatchObject({ target: 'hanamii', kind: 'done' })
  })

  it('★★ 対照: 直さずに押し直すと、また止まる。HANAMII へも保存場所へも要求0件・shell.trashItem 0回（読み直しで段を足さない）', async () => {
    putProject(true)
    const first = await readProjectDeleteFacts(dir)
    const plan = planProjectDeleteTeardown(first)
    const ask = fakeAsk(true)
    const trashItem = vi.fn(async (_p: string) => {})
    const counters = { reads: 0 }
    const deps = makeDeps(ask, trashItem, counters)
    const blocked = await pressProjectDelete(dir, { plan, run: null, seen: first }, true, deps)
    const again = await pressProjectDelete(dir, { plan, run: blocked.run, seen: first }, true, deps)
    expect(again.run).toEqual({ phase: 'blocked', block: { reason: 'record-unreadable' }, steps: [] })
    expect(counters.reads).toBe(1)
    expect(ask.titles).toEqual([])
    expect(win.hanamiiCalls).toEqual([])
    expect(win.teardownCalls).toEqual([])
    expect(h.calls).toEqual([])
    expect(trashItem.mock.calls).toEqual([])
  })
})
