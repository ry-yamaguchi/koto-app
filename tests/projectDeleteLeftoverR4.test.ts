import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── 0.6.24 R4（U10〜U12 の検分の修理）: 残りの段（行の無い保存場所・レジストリ・アプリ）の門・印・かけ直しを、本物の流れ・本物の main・偽の client に通す ──────────────
// 仕様: docs/v0624-aefi-spec.md の 10章 R4-a・R4-b（1〜3）・R4-e。材料は本物の readProjectDeleteFacts（cloud:teardownRecord・cloud:recordTwins）、判断は本物の
// planProjectDeleteTeardown、走らせるのは本物の runProjectDelete・pressProjectDelete・teardownPublished。口は偽（確認の答え・HANAMII の IPC・さくらの client・保存場所）。
// フォルダを移す口だけは、R4-a では本物の trashProjectFs（main の fs:trashProject の本体。shell.trashItem の代役を呼ばれた一覧で見る）。
//   R4-a … 公開の記録を読めない回は、残りの段を足さない。足すと、main が断る削除の途中で、元に戻せないデータとバケットだけが消える
//   R4-b … 残りの段の step の印（leftover）と呼び名（label）: nothingToDo・catch の枝・名詞が null の回
//   R4-e … 走らせる直前に、読み直した記録へ同じ門をかけ直す（HANAMII が保存場所を消し切って、借り手のいるレジストリだけが残った回に、何も消さない確認を出さない）

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
import { planProjectDeleteTeardown, stepLabelOf } from '../src/renderer/teardown/projectDeletePlan'
import { projectDeleteStoppedTail } from '../src/renderer/teardown/projectDeleteWords'
import { HANAMII_TEARDOWN_WORDS } from '../src/renderer/teardown/targets/hanamii'
import { resolveConfirmWithChoices, type ConfirmWithChoicesAnswer, type ConfirmWithChoicesOptions } from '../src/renderer/useConfirmChoices'
import type { ConfirmOptions } from '../src/renderer/useConfirm'
import { PUBLISH_TARGET_LABEL } from '../src/renderer/publishStatus'
import { h, resetHarness, newProjectDir, workspaceOf, setup as setupProject, A, APP, bucketRef } from './sharedTeardownHarness'

const SHARED = PUBLISH_TARGET_LABEL['sakura-apprun']

registerCloudHandlers({} as any)
const mainTeardown = h.handlers.get('cloud:teardown')!
const mainRecord = h.handlers.get('cloud:teardownRecord')!
const mainTwins = h.handlers.get('cloud:recordTwins')!

let dir = ''
let win!: { teardownCalls: unknown[][]; hanamiiCalls: unknown[][]; hanamiiReply: Record<string, unknown>; afterHanamii: (() => void) | null }

const metaFile = (d: string) => path.join(d, '.sakuraide.json')
const HANAMII_ROW = { publishedAt: '2026-09-29T00:00:00.000Z', url: 'https://myapp.hanamii.test' }
/** 公開の記録（.sakuraide.json）。hanamii に true を渡すと HANAMII の行（と projectId）を置く。 */
function writeMeta(d: string, hanamii: boolean) {
  fs.writeFileSync(metaFile(d), JSON.stringify({
    name: 'myapp',
    publish: {
      ...(hanamii ? { hanamii: { workspaceId: 'ws-1', projectId: 'hnm-proj-1', name: 'myapp', tokenId: 'tk-recorded' } } : {}),
      targets: hanamii ? { hanamii: HANAMII_ROW } : {},
    },
  }, null, 2), 'utf-8')
}
const REG = 'reg-shared'
/** 同じ親フォルダの兄弟（コンテナレジストリ REG を使い、アプリを公開している＝REG の借り手）。 */
function putRegistryBorrower() {
  const sib = path.join(workspaceOf(dir), 'borrower')
  fs.mkdirSync(sib)
  setupProject(sib, { env: [], resources: [APP], meta: { registryName: REG, registryAdopted: true } })
}

beforeEach(() => {
  resetProjectOpsForTests()
  resetHarness()
  dir = newProjectDir()
  win = { teardownCalls: [], hanamiiCalls: [], hanamiiReply: { ok: true }, afterHanamii: null }
  ;(globalThis as any).window = {
    electronAPI: {
      cloud: {
        teardownRecord: (d: string) => mainRecord({}, d),
        recordTwins: (d: string) => mainTwins({}, d),
        teardown: (d: string, auth: unknown, opts: unknown) => { win.teardownCalls.push([d, auth, opts]); return mainTeardown({}, d, auth, opts) },
      },
      hanamii: {
        teardown: async (...a: unknown[]) => {
          win.hanamiiCalls.push(a)
          // main は、HANAMII の破棄が済んだら公開の記録（projectId と行）を外し、保存場所を消し切れば env.json と state からも外す（afterHanamii がそれを真似る）。
          if (win.hanamiiReply.ok === true) { writeMeta(dir, false); win.afterHanamii?.() }
          return win.hanamiiReply
        },
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
  fs.rmSync(path.join(workspaceOf(dir), 'borrower'), { recursive: true, force: true })
  delete (globalThis as any).window
})

/** 確認の答えを決め、開いた確認の見出しを残す偽の confirm／confirmWithChoices（選択つきは本物のフックと同じ規則）。throws を渡すと、確認が投げる。 */
function fakeAsk(answer: unknown, throws?: Error) {
  const titles: string[] = []
  return {
    titles,
    confirm: async (o: ConfirmOptions) => { titles.push(o.title); if (throws) throw throws; return answer as boolean },
    confirmWithChoices: async (o: ConfirmWithChoicesOptions): Promise<ConfirmWithChoicesAnswer> => {
      titles.push(o.title); if (throws) throw throws
      return answer === true ? resolveConfirmWithChoices('confirm', o.choices, {}) : { confirmed: answer as boolean, choices: {} }
    },
  }
}
/** 押したときの口。ダイアログと同じ形（teardown は teardownPublished に第3引数を素通しする）。ゴミ箱の口は呼び手が決める。 */
function makeDeps(ask: ReturnType<typeof fakeAsk>, trash: ProjectDeleteRunDeps['trash']): ProjectDeleteRunDeps {
  return {
    readFacts: readProjectDeleteFacts,
    teardown: (d, ts, o) => teardownPublished(d, ts, { confirm: ask.confirm, confirmWithChoices: ask.confirmWithChoices }, o),
    runningOp: async () => null,
    exists: async () => true,
    trash,
  }
}
const ctxOf = (ask: ReturnType<typeof fakeAsk>) => ({ confirm: ask.confirm, confirmWithChoices: ask.confirmWithChoices })
const readAll = (d: string) => ['.sakuraide.json', '.sakura-cloud/env.json', '.sakura-cloud/state.json'].map(f => fs.readFileSync(path.join(d, f), 'utf-8'))

// ── R4-a ──────────────────────────────────────────────────────────────────────────────

describe('R4-a 公開の記録を読めない回は、残りの段を足さない（main が断る削除の途中で、元に戻せないデータとバケットを消さない）', () => {
  const BROKEN = [['壊れた JSON', '{"publish": {'], ['空のファイル', ''], ['JSON でない文字', 'これは記録ではない']] as const

  it.each(BROKEN)('★★★ %s と、保存場所の残り: 材料は読めない＋残りあり。plan に leftover が無く teardown は []。押すと確認0・cloud:teardown 0・要求0件で、本物の trashProjectFs が断る（フォルダも記録も動かない）', async (_label, content) => {
    setupProject(dir, { env: [A], resources: [bucketRef(A)] })
    fs.writeFileSync(metaFile(dir), content, 'utf-8')
    const before = readAll(dir)
    const facts = await readProjectDeleteFacts(dir)
    expect(facts.unreadable).toBe(true)
    expect(facts.sharedLeftover?.placements.map(p => p.bucket)).toEqual([A]) // 残りは読めている（門が見るのは unreadable）
    const plan = planProjectDeleteTeardown(facts)
    expect(plan).toEqual({ block: null, teardown: [], twinned: [] })
    expect('leftover' in plan).toBe(false)

    const ask = fakeAsk(true)
    const trashItem = vi.fn(async (_p: string) => {})
    const deps = makeDeps(ask, async (p, skipped) => {
      const r = await trashProjectFs(p, { confirmed: true, skippedForTwins: skipped }, { home: os.tmpdir(), trashItem })
      if (!r.ok) throw new Error(r.message)
    })
    const r = await runProjectDelete(dir, plan, true, deps)
    expect(r.phase).toBe('trashFailed')
    expect(r).toMatchObject({ message: expect.stringContaining(FS_TRASH_MESSAGES.metaUnreadable) })
    expect(ask.titles).toEqual([])
    expect(win.teardownCalls).toEqual([])
    expect(win.hanamiiCalls).toEqual([])
    expect(h.calls).toEqual([]) // deleteKeys・deleteBucket・connect を含め、保存場所・client への要求は0件
    expect(trashItem.mock.calls).toEqual([])
    expect(readAll(dir)).toEqual(before)
  })

  it('★★ 対照: 読める `.sakuraide.json`（記録が無いのと同じ）なら、同じ保存場所の残りに段を足す。呼び名は「保存場所」', async () => {
    setupProject(dir, { env: [A], resources: [bucketRef(A)] })
    fs.writeFileSync(metaFile(dir), '{}', 'utf-8')
    const facts = await readProjectDeleteFacts(dir)
    expect(facts.unreadable).toBe(false)
    expect(planProjectDeleteTeardown(facts)).toMatchObject({ block: null, teardown: ['sakura-apprun'], leftover: { noun: '保存場所' } })
  })

  it('★★★ 押し直しの道も同じ: 開いたときから読めない記録のまま止まった回（走っている操作）を押し直しても、材料の読み直しで段を足さない（確認0・要求0件。本物の trashProjectFs が断る）', async () => {
    setupProject(dir, { env: [A], resources: [bucketRef(A)] })
    fs.writeFileSync(metaFile(dir), '{broken', 'utf-8')
    const first = await readProjectDeleteFacts(dir)
    const plan = planProjectDeleteTeardown(first)
    expect(plan.teardown).toEqual([])
    const ask = fakeAsk(true)
    const trashItem = vi.fn(async (_p: string) => {})
    const running = [{ op: '公開', target: 'hanamii' }, null] as const // 1回目に聞いたときだけ走っている（移す直前の聞き直し）
    let asked = 0
    const deps: ProjectDeleteRunDeps = {
      ...makeDeps(ask, async (p, skipped) => {
        const r = await trashProjectFs(p, { confirmed: true, skippedForTwins: skipped }, { home: os.tmpdir(), trashItem })
        if (!r.ok) throw new Error(r.message)
      }),
      runningOp: async () => (running[Math.min(asked++, 1)] as { op: '作成' | '削除' | '公開'; target: 'hanamii' } | null),
    }
    const blocked = await pressProjectDelete(dir, { plan, run: null, seen: first }, true, deps)
    expect(blocked.run.phase).toBe('blocked')
    const again = await pressProjectDelete(dir, { plan, run: blocked.run, seen: blocked.facts ?? first }, true, deps) // 読み直した材料は、見せた材料と同じ（増えた注意は無い）
    expect(again.run.phase).toBe('trashFailed')
    expect(again.run).toMatchObject({ message: expect.stringContaining(FS_TRASH_MESSAGES.metaUnreadable) })
    expect(ask.titles).toEqual([])
    expect(win.teardownCalls).toEqual([])
    expect(h.calls).toEqual([])
    expect(trashItem.mock.calls).toEqual([])
  })
})

// ── R4-b（1〜3）・R4-e ─────────────────────────────────────────────────────────────────

describe('R4-b 残りの段の step の印と呼び名（本物の teardownPublished）', () => {
  /** 保存場所だけの残り（A）。 */
  const putStorage = () => setupProject(dir, { env: [A], resources: [bucketRef(A)] })
  /** アプリだけの残り（保存場所・レジストリは無い）。 */
  const putApp = () => setupProject(dir, { env: [], resources: [APP] })
  const LEFTOVER = { leftover: { noun: '保存場所' } }

  it('★★★ 1. 消すものが無かった（nothingToDo）残りの段にも、印と呼び名が付く。印が無いと結果の欄が「何も無い行」を描いてしまう', async () => {
    setupProject(dir, { env: [], resources: [] }) // 記録に消すものが無い
    const steps = await teardownPublished(dir, ['sakura-apprun'], ctxOf(fakeAsk(true)), LEFTOVER)
    expect(steps).toEqual([{ target: 'sakura-apprun', kind: 'nothingToDo', message: expect.any(String), leftover: true, label: '保存場所' }])
    expect(h.calls).toEqual([])
    // 残りの段でない回（行のある共用型）は、印も呼び名も付かない（対照）
    const plain = await teardownPublished(dir, ['sakura-apprun'], ctxOf(fakeAsk(true)))
    expect(plain).toEqual([{ target: 'sakura-apprun', kind: 'nothingToDo', message: expect.any(String) }])
  })

  it('★★★ 2. 流れが投げた（catch の枝）残りの段の失敗にも、呼び名で言う行と、印と呼び名が付く。残りの段でない回は公開先の名前のまま', async () => {
    putStorage()
    const boom = new Error('確認の窓が閉じました（テスト）')
    const steps = await teardownPublished(dir, ['sakura-apprun'], ctxOf(fakeAsk(true, boom)), LEFTOVER)
    expect(steps).toEqual([{ target: 'sakura-apprun', kind: 'failed', line: '保存場所: 確認の窓が閉じました（テスト）', view: null, words: null, leftover: true, label: '保存場所' }])
    const plain = await teardownPublished(dir, ['sakura-apprun'], ctxOf(fakeAsk(true, boom)))
    expect(plain).toEqual([{ target: 'sakura-apprun', kind: 'failed', line: `${SHARED}: 確認の窓が閉じました（テスト）`, view: null, words: null }])
    expect(h.calls).toEqual([])
  })

  it('★★★ 3. 名詞が null（アプリが残る回＝公開の回）: 印は付くが label は付けず、行も結果の呼び名も公開先の名前で言う。やめた・済んだ・投げた・失敗のどれも', async () => {
    putApp()
    const cancelled = await teardownPublished(dir, ['sakura-apprun'], ctxOf(fakeAsk(false)), { leftover: { noun: null } })
    expect(cancelled).toEqual([{ target: 'sakura-apprun', kind: 'cancelled', line: `${SHARED}: 破棄をキャンセルしました`, leftover: true }])
    expect(stepLabelOf(cancelled[0])).toBe(SHARED)

    const thrown = await teardownPublished(dir, ['sakura-apprun'], ctxOf(fakeAsk(true, new Error('窓が閉じました（テスト）'))), { leftover: { noun: null } })
    expect(thrown).toEqual([{ target: 'sakura-apprun', kind: 'failed', line: `${SHARED}: 窓が閉じました（テスト）`, view: null, words: null, leftover: true }])

    h.fail['deleteApp app-1'] = 'http500'
    const failed = await teardownPublished(dir, ['sakura-apprun'], ctxOf(fakeAsk(true)), { leftover: { noun: null } })
    expect(failed).toMatchObject([{ target: 'sakura-apprun', kind: 'failed', leftover: true, line: expect.stringContaining(`${SHARED}: `) }])
    expect('label' in failed[0]).toBe(false)
    delete h.fail['deleteApp app-1']

    const done = await teardownPublished(dir, ['sakura-apprun'], ctxOf(fakeAsk(true)), { leftover: { noun: null } })
    expect(done).toMatchObject([{ target: 'sakura-apprun', kind: 'done', leftover: true }])
    expect('label' in done[0]).toBe(false)
    expect(h.calls.filter(c => c.startsWith('deleteApp')).length).toBe(2) // 失敗の回と済んだ回
  })
})

describe('R4-e 走らせる直前に、読み直した記録へ同じ門をかけ直す', () => {
  /** HANAMII の行と、保存場所 A の残りと、コンテナレジストリ REG（借り物）。HANAMII の破棄が済むと A は env.json と state から外れ、レジストリだけが残る。 */
  function putHanamiiThenOnlyRegistryRemains() {
    setupProject(dir, { env: [A], resources: [bucketRef(A)], meta: { registryName: REG, registryAdopted: true } })
    writeMeta(dir, true)
    win.afterHanamii = () => setupProject(dir, { env: [], resources: [], meta: { registryName: REG, registryAdopted: true } })
  }

  it('★★★ HANAMII が保存場所を消し切り、借り手のいるレジストリだけが残る回: 2つ目の確認は0回・cloud:teardown 0・要求0件。残りの段は nothingToDo（印つき）で、ゴミ箱へ1回移る', async () => {
    putHanamiiThenOnlyRegistryRemains()
    putRegistryBorrower()
    const facts = await readProjectDeleteFacts(dir)
    expect(facts.sharedLeftover?.registryUsers).toEqual(['borrower'])
    const plan = planProjectDeleteTeardown(facts)
    expect(plan).toMatchObject({ block: null, teardown: ['hanamii', 'sakura-apprun'], leftover: { noun: '保存場所' } }) // 開いたときは、保存場所があるので段を足す
    const ask = fakeAsk(true)
    const trashed: string[] = []
    const r = await pressProjectDelete(dir, { plan, run: null, seen: facts }, true, makeDeps(ask, async p => { trashed.push(p) }))
    expect(ask.titles).toEqual([HANAMII_TEARDOWN_WORDS.confirmTitle]) // HANAMII の確認だけ。公開の見出しの「何も消さない確認」は出ない
    expect(win.hanamiiCalls).toHaveLength(1)
    expect(win.teardownCalls).toEqual([])
    expect(h.calls).toEqual([])
    expect(r.run.phase).toBe('trashed')
    expect(r.run.steps).toMatchObject([
      { target: 'hanamii', kind: 'done' },
      { target: 'sakura-apprun', kind: 'nothingToDo', leftover: true, label: '保存場所' },
    ])
    expect(trashed).toEqual([dir])
  })

  it('★★★ 対照: 読み直した記録が門を通る回（借り手のいないレジストリが残る）は、今までどおり確認を出す。見出しは残りの呼び名。要求は cloud:teardown の1回', async () => {
    putHanamiiThenOnlyRegistryRemains() // 兄弟を置かない＝REG は借り手がいない＝数える
    const facts = await readProjectDeleteFacts(dir)
    const plan = planProjectDeleteTeardown(facts)
    const ask = fakeAsk(true)
    const trashed: string[] = []
    const r = await pressProjectDelete(dir, { plan, run: null, seen: facts }, true, makeDeps(ask, async p => { trashed.push(p) }))
    expect(ask.titles).toEqual([HANAMII_TEARDOWN_WORDS.confirmTitle, 'コンテナレジストリを破棄します'])
    expect(win.teardownCalls).toHaveLength(1)
    expect(win.teardownCalls[0][2]).toMatchObject({ confirmed: true, deleteRegistry: false, registryName: REG, shownPlacements: [] }) // 借り物は確認の既定がオフ
    expect(h.calls.some(c => c.startsWith('deleteApp') || c.startsWith('deleteBucket'))).toBe(false)
    expect(r.run.steps.map(s => `${s.target}:${s.kind}`)).toEqual(['hanamii:done', 'sakura-apprun:done'])
  })
})

describe('R4-c 実際の流れ: レジストリだけの残りでやめた回の尻は、コンテナレジストリで言う', () => {
  it('★★★ 本物の plan・teardownPublished・結果の尻: 名詞はコンテナレジストリ。尻の後半は「コンテナレジストリがもう無いことを…」。要求0件・ゴミ箱0', async () => {
    setupProject(dir, { env: [], resources: [], meta: { registryName: 'reg-own', registryAdopted: false } }) // Koto が作った・借り手なし
    const facts = await readProjectDeleteFacts(dir)
    const plan = planProjectDeleteTeardown(facts)
    expect(plan).toMatchObject({ teardown: ['sakura-apprun'], leftover: { noun: 'コンテナレジストリ' } })
    const trashed: string[] = []
    const r = await runProjectDelete(dir, plan, true, makeDeps(fakeAsk(false), async p => { trashed.push(p) }))
    expect(r.phase).toBe('stopped')
    expect(projectDeleteStoppedTail(r.steps)).toBe(
      'このままフォルダを削除すると、保存場所などの記録も消えて、Koto から破棄できなくなります。'
      + 'もう一度「🗑 ゴミ箱に移動」を押してください。コンテナレジストリがもう無いことをコントロールパネルで確かめたときだけ、チェックを外して削除できます。')
    expect(h.calls).toEqual([])
    expect(trashed).toEqual([])
  })
})
