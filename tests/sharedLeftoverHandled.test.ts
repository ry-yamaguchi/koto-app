import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 同じ押しで HANAMII が済ませた保存場所だけの残りの段は、走らせない ─────────────────────────────────────────────────
// 材料は本物の readProjectDeleteFacts（本物の cloud:teardownRecord・cloud:recordTwins）、判断は本物の planProjectDeleteTeardown、走らせるのは本物の
// runProjectDelete・pressProjectDelete・teardownPublished。口は偽（確認の答え・ゴミ箱・保存場所・さくらのクラウド・HANAMII のサーバ）。
//   T-3a … 本物の hanamii:teardown と本物の cloud:teardown を同じ押しに通す（実害を見る試験）。兄弟が使うバケット＋HANAMII 200 → 確認1回・cloud:teardown 0・
//          一覧とデータの削除は HANAMII の1回・結果の警告は1回・ゴミ箱は review のあとの1回
//   T-3b … 偽の HANAMII が ok:true（保存場所は処理済み・アプリ無し・数えるレジストリ無し・記録の鍵なし）→ 残りの段は nothingToDo（leftover 印）
//   T-3c〜e … 走らせる条件（別 prefix・記録の鍵・アプリ・数えるレジストリ・設定から外した保存場所・HANAMII の見せた組が空）
//   T-3f … HANAMII が済まない回（失敗・キャンセル）は残りの段へ進まない
//   T-3h … 現状の固定（押しをまたぐ回・共用型の行もある回は、直さない）
// 偽の HANAMII の ok:true は、見せた保存場所を全部処理したことを言う（本物の main は、見せていない保存場所があれば ok:false で止まる。T-3a で本物を通す）。

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))
vi.mock('../src/renderer/components/CredentialsModal', () => ({
  getHanamiiToken: async () => 'tok-active',
  getHanamiiTokenById: async () => 'tok-recorded',
}))

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { registerHanamiiHandlers } from '../src/main/ipc/hanamii'
import { resetProjectOpsForTests } from '../src/main/projectOps'
import { runProjectDelete, pressProjectDelete, teardownPublished, type ProjectDeleteRunDeps } from '../src/renderer/teardown/projectDelete'
import { readProjectDeleteFacts } from '../src/renderer/teardown/projectDeleteFacts'
import { planProjectDeleteTeardown, keptLinesOf } from '../src/renderer/teardown/projectDeletePlan'
import { HANAMII_TEARDOWN_WORDS } from '../src/renderer/teardown/targets/hanamii'
import { resolveConfirmWithChoices, type ConfirmWithChoicesAnswer, type ConfirmWithChoicesOptions } from '../src/renderer/useConfirmChoices'
import type { ConfirmOptions } from '../src/renderer/useConfirm'
import { BUCKET_MONTHLY_YEN } from '../src/shared/cloudCost'
import { deleteProjectReply } from './hanamiiTeardownFixtures'
import { h, resetHarness, newProjectDir, workspaceOf, setup as setupProject, A, B, APP, PREFIX, bucketRef } from './sharedTeardownHarness'

const LEFTOVER_TITLE = '保存場所を破棄します'
const SHARED_TITLE = 'さくらのAppRun の公開を破棄します'
const PROJECT_ID = 'hnm-proj-1'
const OTHER_PREFIX = 'projects/other/'

registerCloudHandlers({} as any)
registerHanamiiHandlers({} as any)
const mainTeardown = h.handlers.get('cloud:teardown')!
const mainRecord = h.handlers.get('cloud:teardownRecord')!
const mainTwins = h.handlers.get('cloud:recordTwins')!
const mainHanamii = h.handlers.get('hanamii:teardown')!

type HanamiiReply = Record<string, unknown> | 'throws' | 'real'
let dir = ''
let win!: {
  teardownCalls: unknown[][]; hanamiiCalls: unknown[][]; fetchCalls: string[]
  /** 'real' は本物の hanamii:teardown（偽の HANAMII のサーバ・偽の保存場所）。そうでなければ、その返り値を返す偽。 */
  hanamiiReply: HanamiiReply
  /** 確認が読む保存場所（storage:placement）の答えを差し替える。null は env.json の同意済みそのまま。 */
  placementReply: null | { ok: false; message: string } | { ok: true; placements: Array<{ bucket: string; prefix: string; shared: boolean }> }
}
let realFetch: typeof fetch

const metaFile = (d: string) => path.join(d, '.sakuraide.json')
const HANAMII_ROW = { publishedAt: '2026-09-29T00:00:00.000Z', url: 'https://myapp.hanamii.test' }
const SHARED_ROW = { publishedAt: '2026-09-29T00:00:00.000Z', url: 'https://myapp.example.test' }
/** 公開の記録（.sakuraide.json）。hanamii に true を渡すと HANAMII の行（と projectId）を置く。 */
function writeMeta(d: string, o: { hanamii?: boolean; sharedRow?: boolean }) {
  fs.writeFileSync(metaFile(d), JSON.stringify({
    name: 'myapp',
    publish: {
      ...(o.hanamii ? { hanamii: { workspaceId: 'ws-1', projectId: PROJECT_ID, name: 'myapp', tokenId: 'tk-recorded' } } : {}),
      targets: { ...(o.hanamii ? { hanamii: HANAMII_ROW } : {}), ...(o.sharedRow ? { 'sakura-apprun': SHARED_ROW } : {}) },
    },
  }, null, 2), 'utf-8')
}
/** 行の無い保存場所だけのプロジェクト（A だけが env.json と state にある）。`meta` は state.json の meta（記録の鍵・レジストリ）。 */
function putLeftover(o: { hanamii?: boolean; meta?: Record<string, unknown> } = {}) {
  setupProject(dir, { env: [A], resources: [bucketRef(A)], ...(o.meta ? { meta: o.meta as any } : {}) })
  writeMeta(dir, o)
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
  win = { teardownCalls: [], hanamiiCalls: [], fetchCalls: [], hanamiiReply: 'real', placementReply: null }
  realFetch = globalThis.fetch
  // 偽の HANAMII のサーバ（実物の HanamiiClient をそのまま動かし、出た要求だけを記録する）。プロジェクトの削除は 200（物理削除済み）。
  globalThis.fetch = (async (input: unknown, init: any) => {
    win.fetchCalls.push(`${init?.method ?? 'GET'} ${String(input)}`)
    return deleteProjectReply(200, PROJECT_ID)
  }) as unknown as typeof fetch
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
          if (win.hanamiiReply === 'real') return mainHanamii({}, ...a)
          if (win.hanamiiReply === 'throws') throw new Error('接続が切れました（テスト）')
          // 偽の ok:true。本物の main は、済んだら公開の記録（projectId と行）を外す。押し直しの材料の読み直しが、それを前提にする。
          if (win.hanamiiReply.ok === true) writeMeta(dir, { sharedRow: fs.readFileSync(metaFile(dir), 'utf-8').includes('sakura-apprun') })
          return win.hanamiiReply
        },
      },
      fs: { readFile: async (p: string) => fs.readFileSync(p, 'utf-8'), exists: async (p: string) => fs.existsSync(p) },
      storage: {
        placement: async (d: string) => {
          if (win.placementReply) return win.placementReply
          const list = JSON.parse(fs.readFileSync(path.join(d, '.sakura-cloud', 'env.json'), 'utf-8'))?.persistence?.objectStorage ?? []
          return { ok: true, placements: list.map((p: any) => ({ bucket: p.bucket, prefix: p.prefix, shared: p.shared })) }
        },
      },
      apprunDedicated: { state: async () => null },
      stageTiming: { estimates: async () => null },
      win: { setBusy: () => {} },
      publishMeta: new Proxy({}, { get: (_t, key) => key === 'runningOp' ? async () => null : (..._a: unknown[]) => Promise.resolve({ ok: true, meta: {} }) }),
    },
    dispatchEvent: () => true,
  }
})

afterEach(() => {
  globalThis.fetch = realFetch
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
/** 押したときの口。ダイアログと同じ形。ゴミ箱は呼ばれた回数を残す。`runningOps` は、フォルダを移す直前に聞く「いま走っている操作」の答えを順に返す（尽きたら null）。 */
function makeDeps(ask: ReturnType<typeof fakeAsk>, o: { runningOps?: Array<{ op: any; target: any } | null>; trashFailures?: number } = {}) {
  const trashed: string[] = []
  const running = [...(o.runningOps ?? [])]
  let failures = o.trashFailures ?? 0
  const deps: ProjectDeleteRunDeps = {
    readFacts: readProjectDeleteFacts,
    teardown: (d, ts, opts) => teardownPublished(d, ts, { confirm: ask.confirm, confirmWithChoices: ask.confirmWithChoices }, opts),
    runningOp: async () => (running.length > 0 ? (running.shift() ?? null) : null) as any,
    exists: async () => true,
    trash: async p => { if (failures > 0) { failures--; throw new Error('ゴミ箱へ移せませんでした（テスト）') } trashed.push(p) },
  }
  return { deps, trashed }
}
async function openPlan() {
  const facts = await readProjectDeleteFacts(dir)
  return { facts, plan: planProjectDeleteTeardown(facts) }
}
const callsOf = (prefix: string) => h.calls.filter(c => c.startsWith(prefix))
/** 偽の HANAMII が ok で A のデータだけ消して残した回の返り値（保存場所は env.json に残る。警告が出る）。 */
const KEPT_REPLY = { ok: true, appDeleted: true, executed: ['✅ 保存場所『koto-data-a』のデータを削除しました — 保存場所は残します。'], keptBucketName: A, keptBucketNames: [A], keptBucketsUsedByOthers: [A] }

describe('T-3a 本物の hanamii:teardown と本物の cloud:teardown を同じ押しに通す', () => {
  it('★★★ 兄弟が使うバケット＋HANAMII 200: 確認は HANAMII の1回・cloud:teardown 0・一覧とデータの削除は1回ずつ・結果の警告は1回・ゴミ箱は review のあとの1回', async () => {
    putLeftover({ hanamii: true })
    putSibling()
    h.keysByBucket[A] = [`${PREFIX}data.json`] // 兄弟の記録だけが A を使っている印（キーの一覧には兄弟のものは無い）
    const { facts, plan } = await openPlan()
    expect(plan).toMatchObject({ block: null, teardown: ['hanamii', 'sakura-apprun'], leftover: { noun: '保存場所' } }) // 開いたときの plan は、残りの段も足す
    const ask = fakeAsk(true)
    const { deps, trashed } = makeDeps(ask)

    const r = await pressProjectDelete(dir, { plan, run: null, seen: facts }, true, deps)

    expect(win.fetchCalls).toEqual([`DELETE https://hanamii.jp/api/v1/projects/${PROJECT_ID}`])
    expect(win.hanamiiCalls).toHaveLength(1)
    expect(ask.titles).toEqual([HANAMII_TEARDOWN_WORDS.confirmTitle]) // 「保存場所を破棄します」は出ない
    expect(win.teardownCalls).toEqual([]) // cloud:teardown は0回
    expect(callsOf('listAllKeys')).toEqual(['listAllKeys koto-data-a']) // HANAMII の1回だけ
    expect(callsOf('deleteKeys')).toEqual(['deleteKeys koto-data-a'])
    expect(callsOf('deleteBucket')).toEqual([]) // 兄弟が使うので、バケットは残す
    expect(callsOf('connect')).toEqual(['connect']) // 保存場所へつないだのも1回
    expect(callsOf('deleteApp')).toEqual([])

    expect(r.run.phase).toBe('review') // HANAMII の警告（残した保存場所・月額）を見せてから移す
    expect(r.run.steps.map(s => `${s.target}:${s.kind}`)).toEqual(['hanamii:done', 'sakura-apprun:nothingToDo'])
    expect(r.run.steps[1]).toMatchObject({ leftover: true, label: '保存場所' })
    const kept = keptLinesOf(r.run.steps)
    expect(kept.filter(l => l.includes('koto-data-a'))).toHaveLength(1) // 残した保存場所の知らせは1回
    expect(kept.join('\n').split(`${BUCKET_MONTHLY_YEN}円`)).toHaveLength(2) // 月額の注意も1回
    const executed = r.run.steps.flatMap(s => (s.kind === 'done' ? s.view.executed : []))
    expect(executed.filter(l => l.includes('データを削除しました'))).toHaveLength(1) // 「データを削除しました」の行も1回
    expect(trashed).toEqual([]) // 見せてから、もう一度押してもらう

    const again = await pressProjectDelete(dir, { plan, run: r.run, seen: facts }, true, deps)
    expect(again.run.phase).toBe('trashed')
    expect(trashed).toEqual([dir]) // ゴミ箱は review のあとの1回
    expect(ask.titles).toHaveLength(1) // 押し直しで確認は増えない
    expect(win.teardownCalls).toEqual([])
    expect(callsOf('listAllKeys')).toHaveLength(1)
  })
})

describe('T-3b 偽の HANAMII が ok:true で、保存場所は処理済み・ほかに仕事が無い → 残りの段は走らせない', () => {
  it('★★★ 残りの段は nothingToDo（leftover 印）・確認0・cloud:teardown 0・外への要求0件。hold は HANAMII の警告で立つ', async () => {
    putLeftover({ hanamii: true })
    win.hanamiiReply = KEPT_REPLY
    const { facts, plan } = await openPlan()
    const ask = fakeAsk(true)
    const { deps, trashed } = makeDeps(ask)
    const r = await pressProjectDelete(dir, { plan, run: null, seen: facts }, true, deps)
    expect(ask.titles).toEqual([HANAMII_TEARDOWN_WORDS.confirmTitle])
    expect(win.teardownCalls).toEqual([])
    expect(h.calls).toEqual([])
    expect(r.run.steps).toMatchObject([{ target: 'hanamii', kind: 'done' }, { target: 'sakura-apprun', kind: 'nothingToDo', leftover: true, label: '保存場所' }])
    expect(r.run.phase).toBe('review')
    expect(trashed).toEqual([])
  })

  it('★★ HANAMII の警告が無い回（保存場所をバケットごと消した等）は、そのまま移す（ゴミ箱1回）', async () => {
    putLeftover({ hanamii: true })
    win.hanamiiReply = { ok: true }
    const { facts, plan } = await openPlan()
    const { deps, trashed } = makeDeps(fakeAsk(true))
    const r = await pressProjectDelete(dir, { plan, run: null, seen: facts }, true, deps)
    expect(r.run.steps.map(s => `${s.target}:${s.kind}`)).toEqual(['hanamii:done', 'sakura-apprun:nothingToDo'])
    expect(r.run.phase).toBe('trashed')
    expect(trashed).toEqual([dir])
    expect(win.teardownCalls).toEqual([])
  })
})

describe('T-3c〜e 走らせる条件: 1つでも欠ければ、残りの段は走る（偽の HANAMII が ok:true）', () => {
  /** 押して、残りの段の確認が出て cloud:teardown が1回呼ばれたことを見る。確認の見出しと、残りの段の step の種類を返す。 */
  async function press(replyShown?: { bucket: string; prefix: string; shared: boolean }[]) {
    win.hanamiiReply = KEPT_REPLY
    if (replyShown) win.placementReply = { ok: true, placements: replyShown }
    const { facts, plan } = await openPlan()
    const ask = fakeAsk(true)
    const { deps } = makeDeps(ask)
    const r = await pressProjectDelete(dir, { plan, run: null, seen: facts }, true, deps)
    return { ask, r, plan }
  }

  it('★★★ T-3c 同じバケットの別の prefix が残る（HANAMII が見せたのは A/p1。いまの記録は A/p2）→ 走る（名前だけで比べると、済んだものと取り違える）', async () => {
    setupProject(dir, { env: [A], resources: [bucketRef(A)], envExtra: () => ({ prefix: OTHER_PREFIX }) })
    writeMeta(dir, { hanamii: true })
    const { ask, r } = await press([{ bucket: A, prefix: PREFIX, shared: true }])
    expect(ask.titles).toEqual([HANAMII_TEARDOWN_WORDS.confirmTitle, LEFTOVER_TITLE])
    expect(win.teardownCalls).toHaveLength(1)
    expect(r.run.steps.map(s => `${s.target}:${s.kind}`)).toEqual(['hanamii:done', 'sakura-apprun:done'])
  })

  it('★★★ T-3d 記録の鍵が残っている（storagePermissionId）→ 走る。鍵は共用型の段が無効にする', async () => {
    putLeftover({ hanamii: true, meta: { storagePermissionId: 'perm-recorded' } })
    const { ask, r } = await press()
    expect(ask.titles).toEqual([HANAMII_TEARDOWN_WORDS.confirmTitle, LEFTOVER_TITLE])
    expect(win.teardownCalls).toHaveLength(1)
    expect(callsOf('deletePermission')).toContain('deletePermission perm-recorded')
    expect(r.run.steps.map(s => `${s.target}:${s.kind}`)).toEqual(['hanamii:done', 'sakura-apprun:done'])
  })

  it('★★★ T-3d 前の回が鍵の一括の無効化を果たさずに止まった印（keySweepPending）がある → 走る', async () => {
    putLeftover({ hanamii: true, meta: { keySweepPending: 'apprun' } })
    const { ask } = await press()
    expect(ask.titles).toEqual([HANAMII_TEARDOWN_WORDS.confirmTitle, LEFTOVER_TITLE])
    expect(win.teardownCalls).toHaveLength(1)
    expect(callsOf('listPermissions').length).toBeGreaterThan(0) // 名前での一括の無効化を果たす（共用型の段にしかできない）
  })

  it('★★★ T-3e 数えるレジストリが残っている → 走る', async () => {
    putLeftover({ hanamii: true, meta: { registryName: 'myreg' } })
    const { ask } = await press()
    expect(ask.titles[0]).toBe(HANAMII_TEARDOWN_WORDS.confirmTitle)
    expect(ask.titles).toHaveLength(2)
    expect(win.teardownCalls).toHaveLength(1)
  })

  it('★★★ T-3e 設定から外した保存場所（state にだけある）が残っている → 走る', async () => {
    setupProject(dir, { env: [A], resources: [bucketRef(A), bucketRef(B)] })
    writeMeta(dir, { hanamii: true })
    const { ask } = await press()
    expect(ask.titles).toEqual([HANAMII_TEARDOWN_WORDS.confirmTitle, LEFTOVER_TITLE])
    expect(win.teardownCalls).toHaveLength(1)
    expect(callsOf('listAllKeys')).toContain(`listAllKeys ${B}`)
  })

  it('★★★ T-3e HANAMII の確認が保存場所の名前を挙げられなかった（設定を読めない）＝見せた組が空 → 走る', async () => {
    putLeftover({ hanamii: true })
    win.placementReply = { ok: false, message: '保存場所の設定を読めませんでした（テスト）' }
    const { ask, r } = await press()
    expect(ask.titles).toEqual([HANAMII_TEARDOWN_WORDS.confirmTitle, LEFTOVER_TITLE])
    expect(win.teardownCalls).toHaveLength(1)
    expect(r.run.steps.map(s => `${s.target}:${s.kind}`)).toEqual(['hanamii:done', 'sakura-apprun:done'])
  })
})

describe('T-3f HANAMII が済まない回は、残りの段へ進まない（渡さない）', () => {
  it.each([
    ['失敗（保存場所だけ残った）', { ok: false, appDeleted: true, remainingBucket: A, remainingBuckets: [A], message: 'HANAMII の保存場所を削除できませんでした（テスト）' }],
    ['受け付けただけ（202）', { ok: false, appDeleted: false, deletionAccepted: true, message: '受け付けました（テスト）' }],
  ])('★★★ %s: 共用型の確認0・cloud:teardown 0・要求0件・ゴミ箱0。step は HANAMII の failed だけ', async (_n, reply) => {
    putLeftover({ hanamii: true })
    win.hanamiiReply = reply
    const { facts, plan } = await openPlan()
    const ask = fakeAsk(true)
    const { deps, trashed } = makeDeps(ask)
    const r = await pressProjectDelete(dir, { plan, run: null, seen: facts }, true, deps)
    expect(r.run.phase).toBe('stopped')
    expect(r.run.steps.map(s => `${s.target}:${s.kind}`)).toEqual(['hanamii:failed'])
    expect(ask.titles).toEqual([HANAMII_TEARDOWN_WORDS.confirmTitle])
    expect(win.teardownCalls).toEqual([])
    expect(h.calls).toEqual([])
    expect(trashed).toEqual([])
  })

  it('★★★ キャンセル・例外: 同じく共用型の確認0・要求0件', async () => {
    putLeftover({ hanamii: true })
    const { facts, plan } = await openPlan()
    const cancelled = makeDeps(fakeAsk(false))
    const r1 = await pressProjectDelete(dir, { plan, run: null, seen: facts }, true, cancelled.deps)
    expect(r1.run.steps.map(s => `${s.target}:${s.kind}`)).toEqual(['hanamii:cancelled'])
    win.hanamiiReply = 'throws'
    const ask = fakeAsk(true)
    const r2 = await pressProjectDelete(dir, { plan, run: null, seen: facts }, true, makeDeps(ask).deps)
    expect(r2.run.steps.map(s => `${s.target}:${s.kind}`)).toEqual(['hanamii:failed'])
    expect(ask.titles).toEqual([HANAMII_TEARDOWN_WORDS.confirmTitle])
    expect(win.teardownCalls).toEqual([])
    expect(h.calls).toEqual([])
  })
})

describe('T-3h 現状の固定（直さないこと）: 押しをまたぐ回・HANAMII の行と共用型の行が両方ある回', () => {
  it('★★ 押しをまたぐ二重（HANAMII done のあと、フォルダを移す直前に別の操作が走っていて blocked → 押し直す）: HANAMII の行はもう無いので、残りの段が単独で走る（確認と cloud:teardown が1回ずつ増える）', async () => {
    putLeftover({ hanamii: true })
    putSibling()
    h.keysByBucket[A] = [`${PREFIX}data.json`]
    const { facts, plan } = await openPlan()
    const ask = fakeAsk(true)
    const { deps, trashed } = makeDeps(ask, { runningOps: [{ op: 'teardown', target: 'hanamii' }] })
    const first = await pressProjectDelete(dir, { plan, run: null, seen: facts }, true, deps)
    expect(first.run.phase).toBe('review') // 1回目: HANAMII だけ（残りの段は飛ばした）
    const second = await pressProjectDelete(dir, { plan, run: first.run, seen: facts }, true, deps)
    expect(second.run.phase).toBe('blocked') // 移す直前に聞いたら、別の操作が走っていた
    expect(win.teardownCalls).toEqual([])
    const third = await pressProjectDelete(dir, { plan, run: second.run, seen: facts }, true, deps)
    // 押し直しは材料を読み直す。HANAMII の行は main が外したので、残りの段が単独で足され、同じ押しの引き算（handled）は無い。直さない。
    expect(ask.titles).toEqual([HANAMII_TEARDOWN_WORDS.confirmTitle, LEFTOVER_TITLE])
    expect(win.teardownCalls).toHaveLength(1)
    expect(third.run.steps.map(s => `${s.target}:${s.kind}`)).toEqual(['hanamii:done', 'sakura-apprun:done'])
    expect(win.hanamiiCalls).toHaveLength(1) // HANAMII へはもう聞かない
  })

  it('★★ 移せなかった（trashFailed）あとの押し直しは、移すだけをやり直す（確認も cloud:teardown も増えない）', async () => {
    putLeftover({ hanamii: true })
    win.hanamiiReply = { ok: true }
    const { facts, plan } = await openPlan()
    const ask = fakeAsk(true)
    const { deps, trashed } = makeDeps(ask, { trashFailures: 1 })
    const first = await pressProjectDelete(dir, { plan, run: null, seen: facts }, true, deps)
    expect(first.run.phase).toBe('trashFailed')
    const second = await pressProjectDelete(dir, { plan, run: first.run, seen: facts }, true, deps)
    expect(second.run.phase).toBe('trashed')
    expect(trashed).toEqual([dir])
    expect(ask.titles).toEqual([HANAMII_TEARDOWN_WORDS.confirmTitle])
    expect(win.teardownCalls).toEqual([])
  })

  it('★★★ HANAMII の行と共用型の行が両方ある回（アプリを消す仕事があるので段は走る）: 確認2回・段2つ。同じ保存場所をもう一度扱う（畳まない）', async () => {
    setupProject(dir, { env: [A], resources: [APP, bucketRef(A)] })
    writeMeta(dir, { hanamii: true, sharedRow: true })
    putSibling()
    h.keysByBucket[A] = [`${PREFIX}data.json`]
    const { facts, plan } = await openPlan()
    expect(plan.teardown).toEqual(['hanamii', 'sakura-apprun'])
    expect(plan.leftover).toBeUndefined() // 行があるので、残りの段の印は付かない
    const ask = fakeAsk(true)
    const { deps } = makeDeps(ask)
    const r = await pressProjectDelete(dir, { plan, run: null, seen: facts }, true, deps)
    expect(ask.titles).toEqual([HANAMII_TEARDOWN_WORDS.confirmTitle, SHARED_TITLE])
    expect(win.teardownCalls).toHaveLength(1)
    expect(r.run.steps.map(s => `${s.target}:${s.kind}`)).toEqual(['hanamii:done', 'sakura-apprun:done'])
    expect(callsOf('deleteApp')).toEqual(['deleteApp app-1'])
    expect(callsOf('listAllKeys')).toEqual(['listAllKeys koto-data-a', 'listAllKeys koto-data-a']) // 同じ保存場所を2回扱う。重なりは畳まない（実機の画面を見てから決める）
  })
})

describe('チェックを外した・保存場所だけの回の確認の数は変わらない', () => {
  it('★★ HANAMII の行が無い（行の無い保存場所だけ）: 残りの段の確認は今までどおり1回、cloud:teardown は1回', async () => {
    putLeftover()
    const { facts, plan } = await openPlan()
    expect(plan.teardown).toEqual(['sakura-apprun'])
    const ask = fakeAsk(true)
    const { deps, trashed } = makeDeps(ask)
    const r = await runProjectDelete(dir, plan, true, deps)
    expect(r.phase).toBe('trashed')
    expect(ask.titles).toEqual([LEFTOVER_TITLE])
    expect(win.teardownCalls).toHaveLength(1)
    expect(trashed).toEqual([dir])
    expect(facts.targets).toEqual([])
  })
})

describe('C1 HANAMII の結果の ok が厳密に true でない回は、済ませた組（handled）を残りの段へ渡さない', () => {
  // 真に読めるが true ではない値（"true"・"yes"・1）は、今の失敗の見分け（!ok）では成功側に通る。その回に残りの段を飛ばすと、不明を肯定に倒す。
  it.each([
    ['"true"（文字列）', 'true'],
    ['"yes"（文字列）', 'yes'],
    ['1（数）', 1],
  ])('★★★ ok が %s: 残りの段は飛ばさない（共用型の確認が出て、cloud:teardown が1回呼ばれる）', async (_name, ok) => {
    putLeftover({ hanamii: true })
    win.hanamiiReply = { ...KEPT_REPLY, ok }
    const { facts, plan } = await openPlan()
    const ask = fakeAsk(true)
    const { deps } = makeDeps(ask)
    const r = await pressProjectDelete(dir, { plan, run: null, seen: facts }, true, deps)
    expect(ask.titles).toEqual([HANAMII_TEARDOWN_WORDS.confirmTitle, LEFTOVER_TITLE])
    expect(win.teardownCalls).toHaveLength(1)
    expect(callsOf('listAllKeys')).toContain(`listAllKeys ${A}`) // 残りの段が、保存場所に実際に触れた
    expect(r.run.steps.map(s => `${s.target}:${s.kind}`)).toEqual(['hanamii:done', 'sakura-apprun:done'])
  })

  // ok が欠けた・偽の値は、今のまま失敗に積む（handled も渡らず、残りの段は始まらない）。
  it.each([
    ['欠けた', undefined],
    ['null', null],
    ['0', 0],
    ['空文字', ''],
    ['false', false],
  ])('★★ ok が %s: 今の失敗の扱いのまま（HANAMII の failed だけ・共用型の確認0・cloud:teardown 0・要求0件）', async (_name, ok) => {
    putLeftover({ hanamii: true })
    const { ok: _dropped, ...rest } = KEPT_REPLY
    win.hanamiiReply = ok === undefined ? rest : { ...rest, ok }
    const { facts, plan } = await openPlan()
    const ask = fakeAsk(true)
    const { deps, trashed } = makeDeps(ask)
    const r = await pressProjectDelete(dir, { plan, run: null, seen: facts }, true, deps)
    expect(r.run.phase).toBe('stopped')
    expect(r.run.steps.map(s => `${s.target}:${s.kind}`)).toEqual(['hanamii:failed'])
    expect(ask.titles).toEqual([HANAMII_TEARDOWN_WORDS.confirmTitle])
    expect(win.teardownCalls).toEqual([])
    expect(h.calls).toEqual([])
    expect(trashed).toEqual([])
  })

  it('★★ 比べる対応: ok が true ちょうどの回は、これまでどおり飛ばす（確認は HANAMII の1回・cloud:teardown 0）', async () => {
    putLeftover({ hanamii: true })
    win.hanamiiReply = { ...KEPT_REPLY, ok: true }
    const { facts, plan } = await openPlan()
    const ask = fakeAsk(true)
    const { deps } = makeDeps(ask)
    const r = await pressProjectDelete(dir, { plan, run: null, seen: facts }, true, deps)
    expect(ask.titles).toEqual([HANAMII_TEARDOWN_WORDS.confirmTitle])
    expect(win.teardownCalls).toEqual([])
    expect(r.run.steps.map(s => `${s.target}:${s.kind}`)).toEqual(['hanamii:done', 'sakura-apprun:nothingToDo'])
  })
})

describe('C2 新しい門の options（handled・keyRecorded・stateOnlyBuckets）を渡すのは、残りの段だけ', () => {
  it('★★★ 共用型の行がある通常の段（アプリは state に無い・保存場所は A だけ）: 同じ押しで HANAMII が A を済ませても飛ばさない。確認が出て cloud:teardown が1回、公開の記録の片づけが main で走る', async () => {
    setupProject(dir, { env: [A], resources: [bucketRef(A)] }) // state にアプリは無い。env.json に保存場所 A だけ
    writeMeta(dir, { hanamii: true, sharedRow: true })
    win.hanamiiReply = KEPT_REPLY // 同じ押しで HANAMII が A を ok:true で済ませる（確認で見せたのは A）
    const { facts, plan } = await openPlan()
    expect(plan.teardown).toEqual(['hanamii', 'sakura-apprun'])
    expect(plan.leftover).toBeUndefined() // 行があるので残りの段ではない（印は付かない）
    expect(fs.readFileSync(metaFile(dir), 'utf-8')).toContain('sakura-apprun')
    const ask = fakeAsk(true)
    const { deps } = makeDeps(ask)
    const r = await pressProjectDelete(dir, { plan, run: null, seen: facts }, true, deps)
    expect(ask.titles).toEqual([HANAMII_TEARDOWN_WORDS.confirmTitle, LEFTOVER_TITLE]) // 見出しは記録から決まる（アプリが無いので保存場所）。段そのものは通常の共用型の段
    expect(win.teardownCalls).toHaveLength(1)
    expect(r.run.steps.map(s => `${s.target}:${s.kind}`)).toEqual(['hanamii:done', 'sakura-apprun:done'])
    expect(r.run.steps[1]).not.toHaveProperty('leftover') // 残りの段の印は付かない
    expect(fs.readFileSync(metaFile(dir), 'utf-8')).not.toContain('sakura-apprun') // main が公開の記録（共用型の行）を片づけた
  })
})
