import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 0.6.24 A（U11）: 行の無い保存場所（残りの段）のプロジェクトの削除を、本物の流れ・本物の main・偽の client／偽の保存場所に通す ──────────────
// 仕様: docs/v0624-aefi-spec.md の A-5・T-A2〜A4・A8。材料は本物の readProjectDeleteFacts（本物の cloud:teardownRecord・cloud:recordTwins）、判断は本物の
// planProjectDeleteTeardown、走らせるのは本物の runProjectDelete・pressProjectDelete・teardownPublished。口は偽（確認の答え・ゴミ箱・HANAMII の IPC）。
// 掟10: 確認の答えが true でなければ、client へも保存場所へも要求は0件。ゴミ箱は呼ばれた回数で見る（ソースの文字列は読まない）。
//   T-A2 … 行の無い保存場所だけのプロジェクト（はい／キャンセル／オフ）
//   T-A3 … HANAMII が受け付けただけ（202）・例外のあとは、共用型の段を始めない（行あり・行なしの両方）
//   T-A4 … HANAMII が済んで共用型が失敗 → 押し直しで、HANAMII は聞かず共用型だけ聞く
//   T-A8 … 二重の確認（HANAMII が残した保存場所を、共用型の確認がもう一度名指しする）

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
import { runProjectDelete, pressProjectDelete, teardownPublished, type ProjectDeleteRunDeps } from '../src/renderer/teardown/projectDelete'
import { readProjectDeleteFacts } from '../src/renderer/teardown/projectDeleteFacts'
import { planProjectDeleteTeardown, keptLinesOf, type ProjectDeleteFacts } from '../src/renderer/teardown/projectDeletePlan'
import { HANAMII_TEARDOWN_WORDS } from '../src/renderer/teardown/targets/hanamii'
import { resolveConfirmWithChoices, type ConfirmWithChoicesAnswer, type ConfirmWithChoicesOptions } from '../src/renderer/useConfirmChoices'
import type { ConfirmOptions } from '../src/renderer/useConfirm'
import { PUBLISH_TARGET_LABEL } from '../src/renderer/publishStatus'
import { h, resetHarness, newProjectDir, workspaceOf, setup as setupProject, writePublishRecord, A, APP, PREFIX, bucketRef, CONSENTED_AT } from './sharedTeardownHarness'

const SHARED = PUBLISH_TARGET_LABEL['sakura-apprun']
const HANAMII = PUBLISH_TARGET_LABEL.hanamii
const LEFTOVER_TITLE = '保存場所を破棄します'
const ACCEPTED = 'HANAMII の削除を受け付けました（テスト）'

registerCloudHandlers({} as any)
const mainTeardown = h.handlers.get('cloud:teardown')!
const mainRecord = h.handlers.get('cloud:teardownRecord')!
const mainTwins = h.handlers.get('cloud:recordTwins')!

let dir = ''
let win!: { teardownCalls: unknown[][]; hanamiiCalls: unknown[][]; publishMetaCalls: string[]; hanamiiReply: Record<string, unknown> | 'throws' }

const metaFile = (d: string) => path.join(d, '.sakuraide.json')
const HANAMII_ROW = { publishedAt: '2026-09-29T00:00:00.000Z', url: 'https://myapp.hanamii.test' }
const SHARED_ROW = { publishedAt: '2026-09-29T00:00:00.000Z', url: 'https://myapp.example.test' }
/** 公開の記録（.sakuraide.json）。hanamii に true を渡すと HANAMII の行（と projectId）を置く。 */
function writeMeta(d: string, o: { hanamii?: boolean; sharedRow?: boolean }) {
  fs.writeFileSync(metaFile(d), JSON.stringify({
    name: 'myapp',
    publish: {
      ...(o.hanamii ? { hanamii: { workspaceId: 'ws-1', projectId: 'hnm-proj-1', name: 'myapp', tokenId: 'tk-recorded' } } : {}),
      targets: { ...(o.hanamii ? { hanamii: HANAMII_ROW } : {}), ...(o.sharedRow ? { 'sakura-apprun': SHARED_ROW } : {}) },
    },
  }, null, 2), 'utf-8')
}
/** 行の無い保存場所だけのプロジェクト（A だけが env.json と state にある。アプリ・レジストリは無い）。 */
function putLeftover(o: { hanamii?: boolean } = {}) {
  setupProject(dir, { env: [A], resources: [bucketRef(A)] })
  writeMeta(dir, o)
}
/** 共用型の行もあるプロジェクト（アプリあり）。 */
function putRow(o: { hanamii?: boolean } = {}) {
  setupProject(dir, { env: [A], resources: [APP, bucketRef(A)] })
  writeMeta(dir, { ...o, sharedRow: true })
}
/** 同じ親フォルダの兄弟（A を別の prefix で使い、公開の記録が残っている＝A の使用者）。 */
function putSibling() {
  const sib = path.join(workspaceOf(dir), 'sibling')
  fs.mkdirSync(sib)
  setupProject(sib, { env: [A], resources: [], envExtra: () => ({ prefix: 'projects/sibling/' }) })
  fs.writeFileSync(metaFile(sib), JSON.stringify({ name: 'sibling', publish: { targets: { hanamii: HANAMII_ROW } } }), 'utf-8')
}

beforeEach(() => {
  resetProjectOpsForTests()
  resetHarness()
  dir = newProjectDir()
  win = { teardownCalls: [], hanamiiCalls: [], publishMetaCalls: [], hanamiiReply: { ok: false, deletionAccepted: true, message: ACCEPTED } }
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
          if (win.hanamiiReply === 'throws') throw new Error('接続が切れました（テスト）')
          // main は、HANAMII の破棄が済んだら公開の記録（projectId と行）を外す。押し直しの材料の読み直しが、それを前提にする。
          if (win.hanamiiReply.ok === true) writeMeta(dir, { sharedRow: fs.readFileSync(metaFile(dir), 'utf-8').includes('sakura-apprun') })
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
      // 画面は公開の記録に触れない（running を聞く runningOp だけが通る）。
      publishMeta: new Proxy({}, { get: (_t, key) => key === 'runningOp' ? async () => null : (..._a: unknown[]) => { win.publishMetaCalls.push(String(key)); return Promise.resolve({ ok: true, meta: {} }) } }),
    },
    dispatchEvent: () => true,
  }
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(path.join(workspaceOf(dir), 'sibling'), { recursive: true, force: true })
  delete (globalThis as any).window
})

/** 確認の答えを決め、開いた確認の見出しを残す偽の confirm／confirmWithChoices（選択つきは本物のフックと同じ規則）。 */
function fakeAsk(answer: unknown) {
  const titles: string[] = []
  const bodies: string[] = []
  return {
    titles, bodies,
    confirm: async (o: ConfirmOptions) => { titles.push(o.title); bodies.push(o.body ?? ''); return answer as boolean },
    confirmWithChoices: async (o: ConfirmWithChoicesOptions): Promise<ConfirmWithChoicesAnswer> => {
      titles.push(o.title); bodies.push(o.body ?? '')
      return answer === true ? resolveConfirmWithChoices('confirm', o.choices, {}) : { confirmed: answer as boolean, choices: {} }
    },
  }
}
/** 押したときの口。ダイアログと同じ形（teardown は teardownPublished に第3引数を素通しする）。ゴミ箱は呼ばれた回数を残す。 */
function makeDeps(ask: ReturnType<typeof fakeAsk>) {
  const trashed: string[] = []
  const deps: ProjectDeleteRunDeps = {
    readFacts: readProjectDeleteFacts,
    teardown: (d, ts, o) => teardownPublished(d, ts, { confirm: ask.confirm, confirmWithChoices: ask.confirmWithChoices }, o),
    runningOp: async () => null,
    exists: async () => true,
    trash: async p => { trashed.push(p) },
  }
  return { deps, trashed }
}
async function openPlan() {
  const facts = await readProjectDeleteFacts(dir)
  return { facts, plan: planProjectDeleteTeardown(facts) }
}

describe('T-A2 行の無い保存場所だけのプロジェクト: はい・キャンセル・オフ', () => {
  it('★★★ はい: 材料と判断は「保存場所」の残りの段。確認の見出しも「保存場所を破棄します」。自分の prefix のデータ → 最後の使用者ならバケット → ゴミ箱1回。画面は公開の記録に触れない', async () => {
    putLeftover()
    const { facts, plan } = await openPlan()
    expect(facts.targets).toEqual([])
    expect(plan).toMatchObject({ block: null, teardown: ['sakura-apprun'], leftover: { noun: '保存場所' } })
    const ask = fakeAsk(true)
    const { deps, trashed } = makeDeps(ask)
    const r = await runProjectDelete(dir, plan, true, deps)
    expect(r.phase).toBe('trashed')
    expect(ask.titles).toEqual([LEFTOVER_TITLE])
    expect(ask.bodies[0]).toContain('保存場所『koto-data-a』')
    expect(win.teardownCalls).toEqual([[dir, { heldByMain: true }, { confirmed: true, deleteRegistry: false, registryName: null, shownPlacements: [{ bucket: A, prefix: PREFIX }] }]])
    expect(h.calls.filter(c => c.startsWith('deleteKeys') || c.startsWith('deleteBucket'))).toEqual(['deleteKeys koto-data-a', 'deleteBucket koto-data-a'])
    expect(h.calls.some(c => c.startsWith('deleteApp'))).toBe(false)
    expect(trashed).toEqual([dir])
    expect(r.steps).toMatchObject([{ target: 'sakura-apprun', kind: 'done', leftover: true, label: '保存場所' }])
    expect(win.publishMetaCalls).toEqual([])
  })

  it.each([false, undefined, null, 'yes', 1, {}])('★★★ 確認の答えが true でない値（%j）: やめたと同じ。client・保存場所への要求0件・IPC 0・ゴミ箱0。「保存場所: 破棄をキャンセルしました」で止まる（不明値を肯定に戻さない）', async (answer) => {
    putLeftover()
    const { plan } = await openPlan()
    const ask = fakeAsk(answer)
    const { deps, trashed } = makeDeps(ask)
    const r = await runProjectDelete(dir, plan, true, deps)
    expect(r.phase).toBe('stopped')
    expect(r.steps).toEqual([{ target: 'sakura-apprun', kind: 'cancelled', line: '保存場所: 破棄をキャンセルしました', leftover: true, label: '保存場所' }])
    expect(ask.titles).toEqual([LEFTOVER_TITLE])
    expect(win.teardownCalls).toEqual([])
    expect(h.calls).toEqual([])
    expect(trashed).toEqual([])
  })

  it('★★★ オフ（チェックを外した）: 確認0・IPC 0・要求0件。破棄せずにゴミ箱へ1回（記録ごと移る＝チェックの外し方が選択）', async () => {
    putLeftover()
    const { plan } = await openPlan()
    const ask = fakeAsk(true)
    const { deps, trashed } = makeDeps(ask)
    const r = await runProjectDelete(dir, plan, false, deps)
    expect(r).toMatchObject({ phase: 'trashed', steps: [] })
    expect(ask.titles).toEqual([])
    expect(win.teardownCalls).toEqual([])
    expect(h.calls).toEqual([])
    expect(trashed).toEqual([dir])
  })

  it('★★ 破棄が失敗した（保存場所の一覧を取れない）: 残りの段の失敗（label つき）で止まり、ゴミ箱0。バケットは消えない', async () => {
    putLeftover()
    h.fail['listAllKeys koto-data-a'] = 'throw'
    const { plan } = await openPlan()
    const { deps, trashed } = makeDeps(fakeAsk(true))
    const r = await runProjectDelete(dir, plan, true, deps)
    expect(r.phase).toBe('stopped')
    expect(r.steps).toMatchObject([{ target: 'sakura-apprun', kind: 'failed', leftover: true, label: '保存場所', line: expect.stringMatching(/^保存場所: /) }])
    expect(h.calls.some(c => c.startsWith('deleteBucket'))).toBe(false)
    expect(trashed).toEqual([])
  })
})

describe('T-A3 HANAMII が済んでいなければ（受け付けただけ・例外）、共用型の段を始めない', () => {
  const NOT_STARTED = [['行あり', putRow, `${SHARED}の破棄も始めていません`], ['行なし（残りの段）', putLeftover, '保存場所の破棄も始めていません']] as const
  it.each(NOT_STARTED)('★★★ 202（%s）: 共用型の確認0・cloud:teardown 0・要求0件・ゴミ箱0。HANAMII の行に「…も始めていません」。共用型の step は積まない', async (_name, put, note) => {
    put({ hanamii: true })
    const { plan } = await openPlan()
    expect(plan.teardown).toEqual(['hanamii', 'sakura-apprun'])
    const ask = fakeAsk(true)
    const { deps, trashed } = makeDeps(ask)
    const r = await runProjectDelete(dir, plan, true, deps)
    expect(r.phase).toBe('stopped')
    expect(r.steps).toMatchObject([{ target: 'hanamii', kind: 'failed', line: `${HANAMII}: ${ACCEPTED}。${note}`, notStarted: note }])
    expect(ask.titles).toEqual([HANAMII_TEARDOWN_WORDS.confirmTitle]) // HANAMII の確認だけ
    expect(win.hanamiiCalls).toHaveLength(1)
    expect(win.teardownCalls).toEqual([])
    expect(h.calls).toEqual([])
    expect(trashed).toEqual([])
  })

  it.each(NOT_STARTED)('★★★ 例外（%s）: 同じく共用型へ進まない（確認0・要求0件・ゴミ箱0）', async (_name, put, note) => {
    put({ hanamii: true })
    win.hanamiiReply = 'throws'
    const { plan } = await openPlan()
    const ask = fakeAsk(true)
    const { deps, trashed } = makeDeps(ask)
    const r = await runProjectDelete(dir, plan, true, deps)
    expect(r.phase).toBe('stopped')
    expect(r.steps).toMatchObject([{ target: 'hanamii', kind: 'failed', line: `${HANAMII}: 接続が切れました（テスト）。${note}`, notStarted: note }])
    expect(ask.titles).toEqual([HANAMII_TEARDOWN_WORDS.confirmTitle])
    expect(win.teardownCalls).toEqual([])
    expect(h.calls).toEqual([])
    expect(trashed).toEqual([])
  })

  it('★★ HANAMII の文が「。」で終わるときは、「。。」にしない。あとの公開先が無い回は、文をそのまま（「始めていません」を足さない）', async () => {
    putLeftover({ hanamii: true })
    const MSG = 'HANAMII の削除が済んだと確認できませんでした。'
    win.hanamiiReply = { ok: false, deletionAccepted: true, message: MSG }
    const withRest = await teardownPublished(dir, ['hanamii', 'sakura-apprun'], { confirm: async () => true, confirmWithChoices: async () => ({ confirmed: true, choices: {} }) }, { leftover: { noun: '保存場所' } })
    expect(withRest).toMatchObject([{ target: 'hanamii', kind: 'failed', line: `${HANAMII}: ${MSG}保存場所の破棄も始めていません` }])
    const alone = await teardownPublished(dir, ['hanamii'], { confirm: async () => true, confirmWithChoices: async () => ({ confirmed: true, choices: {} }) })
    expect(alone).toHaveLength(1)
    expect(alone[0]).toMatchObject({ kind: 'failed', line: `${HANAMII}: ${MSG}` })
    expect(alone[0]).not.toHaveProperty('notStarted')
  })

  it('★★ HANAMII の確認でやめた（行なし）: 共用型へ進まず、行は名詞で「保存場所の破棄も始めていません」と言う', async () => {
    putLeftover({ hanamii: true })
    const { plan } = await openPlan()
    const { deps } = makeDeps(fakeAsk(false))
    const r = await runProjectDelete(dir, plan, true, deps)
    expect(r.steps).toEqual([{ target: 'hanamii', kind: 'cancelled', line: `${HANAMII}: 破棄をキャンセルしました。保存場所の破棄も始めていません` }])
    expect(h.calls).toEqual([])
  })
})

describe('T-A4 HANAMII は済み・共用型は失敗: 押し直しで、HANAMII は聞かず共用型だけ聞く', () => {
  it('★★★ 1回目 stopped → 材料を読み直した結果で押し直す: HANAMII の確認は増えず（0）、共用型の確認は2回目の1回。HANAMII の done は carried で結果に残り、最後はゴミ箱1回', async () => {
    putLeftover({ hanamii: true })
    win.hanamiiReply = { ok: true }
    h.fail['listAllKeys koto-data-a'] = 'throw'
    const { facts, plan } = await openPlan()
    const ask = fakeAsk(true)
    const { deps, trashed } = makeDeps(ask)
    const first = await pressProjectDelete(dir, { plan, run: null, seen: facts }, true, deps)
    expect(first.run.phase).toBe('stopped')
    expect(first.run.steps.map(s => `${s.target}:${s.kind}`)).toEqual(['hanamii:done', 'sakura-apprun:failed'])
    expect(ask.titles).toEqual([HANAMII_TEARDOWN_WORDS.confirmTitle, LEFTOVER_TITLE])
    expect(first.facts?.targets).toEqual([]) // HANAMII の行は main が外した。読み直した材料に出てこない
    expect(trashed).toEqual([])

    delete h.fail['listAllKeys koto-data-a']
    ask.titles.length = 0
    // 渡す plan は、開いたときの古いもの（HANAMII あり）。押し直しの経路は、前の plan を使わず、読み直した材料から作り直す（画面が材料を更新し損ねても、済んだ HANAMII をもう一度聞かない）
    const second = await pressProjectDelete(dir, { plan, run: first.run, seen: first.facts! }, true, deps)
    expect(plan.teardown).toEqual(['hanamii', 'sakura-apprun'])
    expect(ask.titles).toEqual([LEFTOVER_TITLE]) // HANAMII は聞かない。共用型は1回
    expect(win.hanamiiCalls).toHaveLength(1)
    expect(second.run.phase).toBe('trashed')
    expect(second.run.steps.map(s => `${s.target}:${s.kind}`)).toEqual(['hanamii:done', 'sakura-apprun:done']) // 済んだ HANAMII は carried で先に残る
    expect(trashed).toEqual([dir])
    expect(h.calls).toContain('deleteBucket koto-data-a')
  })
})

describe('T-A8 二重の確認: HANAMII が残した保存場所を、共用型の確認がもう一度名指しする。兄弟が使うバケットは消えず、見せてから移す', () => {
  it('★★★ HANAMII は ok（保存場所は env.json に残る）→ 共用型の確認1回が A を名指し → 自分の prefix だけ消してバケットは残す（deleteBucket 0）→ review。ゴミ箱は押し直すまで0', async () => {
    putLeftover({ hanamii: true })
    putSibling()
    win.hanamiiReply = { ok: true }
    h.keysByBucket[A] = [`${PREFIX}data.json`] // 兄弟の記録だけが、A を使っている印（キーの一覧には兄弟のものは無い）
    const { facts, plan } = await openPlan()
    const ask = fakeAsk(true)
    const { deps, trashed } = makeDeps(ask)
    const r = await pressProjectDelete(dir, { plan, run: null, seen: facts }, true, deps)
    expect(ask.titles).toEqual([HANAMII_TEARDOWN_WORDS.confirmTitle, LEFTOVER_TITLE])
    expect(ask.bodies[1]).toContain('保存場所『koto-data-a』')
    expect(h.calls.some(c => c.startsWith('deleteBucket'))).toBe(false)
    expect(h.calls.filter(c => c.startsWith('deleteKeys'))).toEqual(['deleteKeys koto-data-a']) // 自分の prefix だけ（兄弟の分は消さない）
    expect(r.run.phase).toBe('review')
    expect(r.run.steps.map(s => `${s.target}:${s.kind}`)).toEqual(['hanamii:done', 'sakura-apprun:done'])
    expect(keptLinesOf(r.run.steps).some(l => l.startsWith('保存場所: ') && l.includes('koto-data-a'))).toBe(true) // 残した保存場所の知らせは、名詞（label）で言う
    expect(trashed).toEqual([])
  })
})
