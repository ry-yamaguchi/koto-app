import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 段階2（2d）S4: プロジェクト削除（Sidebar）の「公開も一緒に破棄する」の共用型（さくらのAppRun）の枝を、
//    本物の流れ・本物の main（cloud:teardown・cloud:teardownRecord）・偽の client／偽の保存場所に通す ──────────────────────
// 設計書: docs/teardown-unify-plan.md の 10.7.9 の S4・10.7.12 の S4・10.7.16 末尾の親の判断（2026-10-10 → 0.6.24 A-5 で改めた）。teardown/projectDelete.ts の teardownPublished（Sidebar から切り出した関数）を、偽の confirm／confirmWithChoices と偽の window.electronAPI で呼ぶ。
//   ・戻り値は公開先ごとの結果（ProjectDeleteStep）。失敗の説明は failureLinesOf で取り出す（空のときだけ移してよい。判断は tests/projectDeletePlan.test.ts と
//     tests/projectDeleteRun.test.ts。呼び出し側の守りは tests/hanamiiTeardownEntries.test.ts。行の無い保存場所〔残りの段〕は projectDeleteLeftoverRun.test.ts）
//   ・確認の答えが true でなければ、client へも保存場所へも要求は0件（偽の client・保存場所に出た要求の一覧 h.calls で見る。ソースの文字列は読まない・掟10）
//   ・画面は公開の記録を一度も消さない（publishMeta の口が0回）。消すのは main の cloud:teardown の1か所
//   ・置き場（コンテナレジストリ）を消すかは、確認の選択の答えで決まる。既定は押した時点の main の記録から（借り物はオフ）
// HANAMII の枝（段階1）の振る舞いは tests/hanamiiProjectDelete.test.ts。main の殻の振る舞いは tests/sharedTeardownShell*.test.ts。

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))
// HANAMII の枝が公開したときのトークンを読む口（HANAMII が失敗したあとの共用型の確認を見るテストだけが通る）。
vi.mock('../src/renderer/components/CredentialsModal', () => ({
  getHanamiiToken: async () => 'tok-active',
  getHanamiiTokenById: async () => 'tok-recorded',
}))

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { resetProjectOpsForTests } from '../src/main/projectOps'
import { teardownPublished } from '../src/renderer/teardown/projectDelete'
import { SHARED_TEARDOWN_AUTH, SHARED_TEARDOWN_WORDS } from '../src/renderer/teardown/targets/shared'
import { resolveConfirmWithChoices, type ConfirmWithChoicesAnswer, type ConfirmWithChoicesOptions } from '../src/renderer/useConfirmChoices'
import type { ConfirmOptions } from '../src/renderer/useConfirm'
import { PUBLISH_TARGET_LABEL, type PublishTargetKind } from '../src/renderer/publishStatus'
import { PUBLISH_CLOSE_WARNING } from '../src/renderer/activity'
import { failureLinesOf } from '../src/renderer/teardown/projectDeletePlan'
import { h, resetHarness, newProjectDir, setup as setupProject, writePublishRecord, publishTargets, envBuckets, A, APP, PREFIX, bucketRef, REGISTRY_ROW } from './sharedTeardownHarness'
import type { ResourceRef, EnvState } from '../src/main/cloud/state'

const SHARED = PUBLISH_TARGET_LABEL['sakura-apprun']
const HANAMII = PUBLISH_TARGET_LABEL.hanamii
const SHARED_ROW = { publishedAt: '2026-09-29T00:00:00.000Z', url: 'https://myapp.example.test' }
/** 確認で見せた保存場所（名前と prefix の組）。確認の 💾 が名指しした A を、記録の prefix のまま main へ運ぶ（0.6.24 F）。 */
const SHOWN_A = [{ bucket: A, prefix: PREFIX }]

registerCloudHandlers({} as any)
const mainTeardown = h.handlers.get('cloud:teardown')!
const mainRecord = h.handlers.get('cloud:teardownRecord')!

let dir = ''
let win!: { teardownCalls: unknown[][]; hanamiiCalls: unknown[][]; publishMetaCalls: unknown[][]; busy: unknown[][]; hanamiiReply: { ok: boolean; message?: string } }

function put(o: { env?: string[]; resources?: ResourceRef[]; meta?: EnvState['meta'] } = {}) {
  setupProject(dir, { env: o.env ?? [A], resources: o.resources ?? [APP, bucketRef(A)], ...(o.meta ? { meta: o.meta } : {}) })
  writePublishRecord(dir, { 'sakura-apprun': SHARED_ROW })
}

beforeEach(() => {
  resetProjectOpsForTests()
  resetHarness()
  h.registryRows = [REGISTRY_ROW]
  dir = newProjectDir()
  win = { teardownCalls: [], hanamiiCalls: [], publishMetaCalls: [], busy: [], hanamiiReply: { ok: false, message: 'HANAMII の削除を受け付けました（テスト）' } }
  ;(globalThis as any).window = {
    electronAPI: {
      // 本物の main のハンドラ（preload の素通しと同じ形）。
      cloud: {
        teardownRecord: (d: string) => mainRecord({}, d),
        teardown: (d: string, auth: unknown, opts: unknown) => { win.teardownCalls.push([d, auth, opts]); return mainTeardown({}, d, auth, opts) },
      },
      // HANAMII の枝（段階1）が読む口。env.json の保存場所は実ファイルから返す。
      hanamii: { teardown: async (...a: unknown[]) => { win.hanamiiCalls.push(a); return win.hanamiiReply } },
      fs: { readFile: async (p: string) => fs.readFileSync(p, 'utf-8'), exists: async (p: string) => fs.existsSync(p) },
      storage: {
        placement: async (d: string) => {
          const list = JSON.parse(fs.readFileSync(path.join(d, '.sakura-cloud', 'env.json'), 'utf-8'))?.persistence?.objectStorage ?? []
          return { ok: true, placements: list.map((p: any) => ({ bucket: p.bucket, prefix: p.prefix, shared: p.shared })) }
        },
      },
      stageTiming: { estimates: async () => null },
      win: { setBusy: (...a: unknown[]) => { win.busy.push(a) } },
      // 画面が公開の記録に触れたら数える（触れてはいけない）。
      publishMeta: new Proxy({}, { get: (_t, key) => (...a: unknown[]) => { win.publishMetaCalls.push([String(key), ...a]); return Promise.resolve({ ok: true, meta: {} }) } }),
    },
    dispatchEvent: () => true,
  }
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  delete (globalThis as any).window
})

/** 確認の答えを決め、開いた確認の中身を残す偽の confirm／confirmWithChoices。選択つきの答えは、本物のフックと同じ規則（既定は defaultChecked）で作る。 */
function fakeAsk(answer: unknown, choiceAnswer?: (o: ConfirmWithChoicesOptions) => ConfirmWithChoicesAnswer) {
  const plain: ConfirmOptions[] = []
  const withChoices: ConfirmWithChoicesOptions[] = []
  return {
    plain, withChoices,
    confirm: async (o: ConfirmOptions) => { plain.push(o); return answer as boolean },
    confirmWithChoices: async (o: ConfirmWithChoicesOptions) => {
      withChoices.push(o)
      if (answer !== true) return { confirmed: answer as boolean, choices: {} } as ConfirmWithChoicesAnswer
      return choiceAnswer ? choiceAnswer(o) : resolveConfirmWithChoices('confirm', o.choices, {})
    },
  }
}
/** steps は teardownPublished の返り値。failed は失敗の説明（もとの返り値）、warned は済んだ回（done）の知らせ（もとの onWarnings が渡していたもの）。 */
async function run(targets: PublishTargetKind[], ask: ReturnType<typeof fakeAsk>) {
  const steps = await teardownPublished(dir, targets, { confirm: ask.confirm, confirmWithChoices: ask.confirmWithChoices })
  const warned = steps.flatMap(s => (s.kind === 'done' && s.view.warnings.length > 0 ? [{ target: s.target, warnings: s.view.warnings }] : []))
  return { steps, failed: failureLinesOf(steps), warned }
}

describe('S4 共用型: 確認（選択つき）の答えが true のときだけ実行する', () => {
  it('★★★ 破棄する（Koto が作った置き場）: 失敗は0件。選択つきの確認が1回・選択のない確認は0回。IPC は新しい呼び形で1回。画面は記録に触れず、消したのは main', async () => {
    put({ meta: { registryName: 'myreg', registryAdopted: false } })
    const ask = fakeAsk(true)
    const r = await run(['sakura-apprun'], ask)
    expect(r.failed).toEqual([])
    expect(ask.plain).toEqual([])
    expect(ask.withChoices).toHaveLength(1)
    const o = ask.withChoices[0]
    expect(o.danger).toBe(true)
    expect(o.title).toBe('さくらのAppRun の公開を破棄します')
    expect(o.confirmLabel).toBe('破棄する')
    expect(o.choices.map(c => ({ id: c.id, defaultChecked: c.defaultChecked }))).toEqual([{ id: 'deleteRegistry', defaultChecked: true }])
    expect(o.body).toContain('『myapp』')
    expect(o.body).toContain('保存場所『koto-data-a』')
    expect(win.teardownCalls).toEqual([[dir, SHARED_TEARDOWN_AUTH, { confirmed: true, deleteRegistry: true, registryName: 'myreg', shownPlacements: SHOWN_A }]])
    expect(r.steps).toHaveLength(1)
    expect(r.steps[0]).toMatchObject({ target: 'sakura-apprun', kind: 'done', words: SHARED_TEARDOWN_WORDS, view: { ok: true, state: 'done' } })
    expect(h.calls).toContain('deleteApp app-1')
    expect(h.calls).toContain('deleteContainerRegistry reg-1')
    expect(h.calls).toContain('deleteBucket koto-data-a')
    expect(win.publishMetaCalls).toEqual([]) // 画面は公開の記録を消さない
    expect(publishTargets(dir)['sakura-apprun']).toBeUndefined() // 消したのは main
    expect(envBuckets(dir)).toEqual([]) // 消したバケットの宛先は設定から外れる
  })

  it('★★ 実行中だけ窓を閉じる警告が立つ（共通の流れの1か所）。終われば外れる。やめた回は立たない', async () => {
    put({ meta: { registryName: 'myreg', registryAdopted: false } })
    await run(['sakura-apprun'], fakeAsk(true))
    expect(win.busy[0]).toEqual([true, 'さくらのAppRun の破棄', true, 'さくらのAppRun の破棄', PUBLISH_CLOSE_WARNING.detail, PUBLISH_CLOSE_WARNING.confirmLabel])
    expect(win.busy[win.busy.length - 1]).toEqual([false, '', false, '', '', ''])
    win.busy = []
    resetHarness(); put({ meta: { registryName: 'myreg', registryAdopted: false } })
    await run(['sakura-apprun'], fakeAsk(false))
    expect(win.busy).toEqual([]) // 実行が始まっていない
  })

  it.each([false, undefined, null, 'yes', 1, {}])('★★★ 確認の答えが true でない値（%j）は、やめたと同じ。「破棄をキャンセルしました」が積まれ、要求0件・IPC 0（不明値を肯定に戻さない）', async (answer) => {
    put({ meta: { registryName: 'myreg', registryAdopted: false } })
    const r = await run(['sakura-apprun'], fakeAsk(answer))
    expect(r.failed).toEqual([`${SHARED}: 破棄をキャンセルしました`])
    expect(r.steps).toEqual([{ target: 'sakura-apprun', kind: 'cancelled', line: `${SHARED}: 破棄をキャンセルしました` }])
    expect(win.teardownCalls).toEqual([])
    expect(h.calls).toEqual([])
    expect(publishTargets(dir)['sakura-apprun']).toBeTruthy()
  })

  it('★★★ やめた共用型のあとに続く公開先があれば、名前を挙げて「始めていません」と言い、破棄の口が無いものは挙げない', async () => {
    put({ meta: { registryName: 'myreg', registryAdopted: false } })
    const r = await run(['sakura-apprun', 'sakura-apprun-dedicated', 'vercel'], fakeAsk(false))
    expect(r.failed).toEqual([`${SHARED}: 破棄をキャンセルしました。${PUBLISH_TARGET_LABEL['sakura-apprun-dedicated']}の破棄も始めていません`])
  })

  it.each([false, undefined, null, 'yes', 1, {}])('★★★ 選択の無い確認（レジストリの記録が無い回）も、答えが true でない値（%j）ならやめたと同じ。IPC 0・要求0件', async (answer) => {
    put()
    const ask = fakeAsk(answer)
    const r = await run(['sakura-apprun'], ask)
    expect(ask.plain).toHaveLength(1)
    expect(r.failed).toEqual([`${SHARED}: 破棄をキャンセルしました`])
    expect(win.teardownCalls).toEqual([])
    expect(h.calls).toEqual([])
  })

  it('★★ レジストリの記録が無い回は選択の無い確認（confirm）を使う。選択つきは0回。deleteRegistry は false で渡り、レジストリは消えない', async () => {
    put()
    const ask = fakeAsk(true)
    const r = await run(['sakura-apprun'], ask)
    expect(r.failed).toEqual([])
    expect(ask.withChoices).toEqual([])
    expect(ask.plain).toHaveLength(1)
    expect(win.teardownCalls).toEqual([[dir, SHARED_TEARDOWN_AUTH, { confirmed: true, deleteRegistry: false, registryName: null, shownPlacements: SHOWN_A }]])
    expect(h.calls.some(c => c.startsWith('deleteContainerRegistry'))).toBe(false)
    expect(r.warned).toHaveLength(1) // 記録が無いので残るかもしれない、という知らせ
    expect(r.warned[0].target).toBe('sakura-apprun')
  })
})

describe('S4 共用型: 置き場（コンテナレジストリ）を消すかは利用者が選ぶ（既定でオンなのは、Koto が作ったと記録にあるものだけ）', () => {
  // ★ 作者の手元の実例の形: ScheduleAPP が作った scheduleapp を、reminder などが借りている。借りた側の記録は registryName あり・registryAdopted なし。
  // 「Koto が作ったもの」とは読まない。そのまま破棄しても置き場は消えない（ほかのアプリのイメージ入りの置き場を、既定で消さない）。
  it('★★★ 印が無い置き場（作ったか分からない）: 選択の既定はオフ。そのまま破棄しても置き場は消えず、残したことと月額が続くことが呼び手へ渡る', async () => {
    put({ meta: { registryName: 'scheduleapp' } })
    h.registryRows = [{ ...REGISTRY_ROW, Status: { registry_name: 'scheduleapp' } }]
    const ask = fakeAsk(true)
    const r = await run(['sakura-apprun'], ask)
    expect(ask.withChoices[0].choices.map(c => c.defaultChecked)).toEqual([false])
    expect(win.teardownCalls[0][2]).toEqual({ confirmed: true, deleteRegistry: false, registryName: 'scheduleapp', shownPlacements: SHOWN_A })
    expect(h.calls.some(c => c.startsWith('deleteContainerRegistry'))).toBe(false)
    expect(h.calls.some(c => c === 'listContainerRegistries')).toBe(false)
    expect(r.failed).toEqual([])
    expect(r.warned).toHaveLength(1)
    expect(r.warned[0].warnings.join('\n')).toContain('scheduleapp')
  })

  it('★★★ 印が無い置き場でも、利用者が選んだら消す（選択の値がそのまま main へ届く）', async () => {
    put({ meta: { registryName: 'scheduleapp' } })
    h.registryRows = [{ ...REGISTRY_ROW, Status: { registry_name: 'scheduleapp' } }]
    await run(['sakura-apprun'], fakeAsk(true, () => ({ confirmed: true, choices: { deleteRegistry: true } })))
    expect(win.teardownCalls[0][2]).toEqual({ confirmed: true, deleteRegistry: true, registryName: 'scheduleapp', shownPlacements: SHOWN_A })
    expect(h.calls).toContain('deleteContainerRegistry reg-1')
  })

  it('★★★ 借り物（引き継いだ置き場）: 選択の既定はオフ。そのまま破棄しても置き場は消えず、残したことと月額が続くことが呼び手へ渡る', async () => {
    put({ meta: { registryName: 'myreg', registryAdopted: true } })
    const ask = fakeAsk(true)
    const r = await run(['sakura-apprun'], ask)
    expect(ask.withChoices[0].choices.map(c => c.defaultChecked)).toEqual([false])
    expect(win.teardownCalls[0][2]).toEqual({ confirmed: true, deleteRegistry: false, registryName: 'myreg', shownPlacements: SHOWN_A })
    expect(h.calls.some(c => c.startsWith('deleteContainerRegistry'))).toBe(false)
    expect(r.failed).toEqual([])
    expect(r.warned).toHaveLength(1)
    expect(r.warned[0].warnings.join('\n')).toContain('myreg')
  })

  it('★★★ 借り物でも、利用者が選んだら消す。Koto が作った置き場でも、外したら消さない（選択の値がそのまま main へ届く）', async () => {
    put({ meta: { registryName: 'myreg', registryAdopted: true } })
    await run(['sakura-apprun'], fakeAsk(true, () => ({ confirmed: true, choices: { deleteRegistry: true } })))
    expect(win.teardownCalls[0][2]).toEqual({ confirmed: true, deleteRegistry: true, registryName: 'myreg', shownPlacements: SHOWN_A })
    expect(h.calls).toContain('deleteContainerRegistry reg-1')

    resetHarness(); h.registryRows = [REGISTRY_ROW]; win.teardownCalls = []
    put({ meta: { registryName: 'myreg', registryAdopted: false } })
    await run(['sakura-apprun'], fakeAsk(true, () => ({ confirmed: true, choices: { deleteRegistry: false } })))
    expect(win.teardownCalls[0][2]).toEqual({ confirmed: true, deleteRegistry: false, registryName: 'myreg', shownPlacements: SHOWN_A })
    expect(h.calls.some(c => c.startsWith('deleteContainerRegistry'))).toBe(false)
  })

  it('★★ 既定は「この画面を開いたときの写し」ではなく、押した時点の main の記録から決まる（開いたあとに記録が借り物に変わっても、借り物の既定になる）', async () => {
    put({ meta: { registryName: 'myreg', registryAdopted: false } })
    const first = await mainRecord({}, dir)
    expect(first.record.registryOrigin).toBe('owned')
    put({ meta: { registryName: 'myreg', registryAdopted: true } }) // 画面が開いたあとに、記録が変わった
    const ask = fakeAsk(true)
    await run(['sakura-apprun'], ask)
    expect(ask.withChoices[0].choices.map(c => c.defaultChecked)).toEqual([false])
  })
})

describe('S4 共用型: 消すものが記録に無い行（幽霊の行）は失敗ではない。確認も出さず、フォルダを移せる', () => {
  it('★★★ 公開の記録に共用型の行があるが、state・env.json の保存場所・レジストリの記録が空: 確認0・IPC 0・要求0件。失敗にも警告にも積まれない', async () => {
    put({ env: [], resources: [] })
    const ask = fakeAsk(true)
    const r = await run(['sakura-apprun'], ask)
    expect(r.failed).toEqual([])
    expect(r.steps).toEqual([{ target: 'sakura-apprun', kind: 'nothingToDo', message: SHARED_TEARDOWN_WORDS.nothingToDo }]) // 失敗でも done でもない
    expect(r.warned).toEqual([])
    expect(ask.plain).toEqual([])
    expect(ask.withChoices).toEqual([])
    expect(win.teardownCalls).toEqual([])
    expect(h.calls).toEqual([])
    expect(win.publishMetaCalls).toEqual([])
  })

  it('★★★ 記録に無い残骸（アプリが無く、保存場所だけ・レジストリだけ）は幽霊の行ではない。確認が出て、消す', async () => {
    put({ resources: [] })
    const ask = fakeAsk(true)
    expect((await run(['sakura-apprun'], ask)).failed).toEqual([])
    expect(ask.plain[0].body).toContain('保存場所『koto-data-a』')
    expect(h.calls).toContain('deleteBucket koto-data-a')
    expect(h.calls.some(c => c.startsWith('deleteApp'))).toBe(false)

    resetHarness(); h.registryRows = [REGISTRY_ROW]; win.teardownCalls = []
    put({ env: [], resources: [], meta: { registryName: 'myreg', registryAdopted: false } })
    const ask2 = fakeAsk(true)
    expect((await run(['sakura-apprun'], ask2)).failed).toEqual([])
    expect(ask2.withChoices).toHaveLength(1)
    expect(h.calls).toContain('deleteContainerRegistry reg-1')
  })
})

describe('S4 共用型: 破棄できなかった回は失敗に積む（積まれた回は、フォルダを移さない）', () => {
  it('★★★ アプリを消せなかった: 失敗に積まれ、レジストリにも保存場所にも要求0件。公開の記録は残る', async () => {
    put({ meta: { registryName: 'myreg', registryAdopted: false } })
    h.fail['deleteApp app-1'] = 'http500'
    const r = await run(['sakura-apprun'], fakeAsk(true))
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0]).toContain(`${SHARED}: `)
    expect(r.steps).toHaveLength(1)
    expect(r.steps[0]).toMatchObject({ target: 'sakura-apprun', kind: 'failed', line: r.failed[0], words: SHARED_TEARDOWN_WORDS, view: { ok: false, state: 'failed' } })
    expect(h.calls.some(c => c.startsWith('deleteContainerRegistry') || c.startsWith('listAllKeys') || c.startsWith('deleteBucket'))).toBe(false)
    expect(publishTargets(dir)['sakura-apprun']).toBeTruthy()
    expect(win.publishMetaCalls).toEqual([])
  })

  it('★★★ アプリは消えたが保存場所の一覧を取れなかった: 失敗に積まれ、バケットは消えない。公開の記録は残る（押し直せる）', async () => {
    put()
    h.fail['listAllKeys koto-data-a'] = 'throw'
    const r = await run(['sakura-apprun'], fakeAsk(true))
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0]).toContain(`${SHARED}: `)
    expect(h.calls).toContain('deleteApp app-1')
    expect(h.calls.some(c => c.startsWith('deleteBucket'))).toBe(false)
    expect(publishTargets(dir)['sakura-apprun']).toBeTruthy()
  })

  it('★★★ さくらのクラウドのキー未登録: main が断り、失敗に積まれる。client・保存場所への要求は0件', async () => {
    put()
    h.creds = null
    const r = await run(['sakura-apprun'], fakeAsk(true))
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0]).toContain('APIキー未登録')
    expect(h.calls).toEqual([])
  })

  it('★★ 呼び出しが例外を投げた: 失敗に積まれる（握りつぶさない）', async () => {
    put()
    ;(globalThis as any).window.electronAPI.cloud.teardown = async () => { throw new Error('接続が切れました（テスト）') }
    expect((await run(['sakura-apprun'], fakeAsk(true))).failed).toEqual([`${SHARED}: 接続が切れました（テスト）`])
  })

  it('★★ 複数の公開先: 共用型が失敗しても、残り（専有型の「この画面からは削除できません」）を扱い、失敗を全部返す', async () => {
    put()
    h.fail['deleteApp app-1'] = 'http500'
    const r = await run(['sakura-apprun', 'sakura-apprun-dedicated'], fakeAsk(true))
    expect(r.failed).toHaveLength(2)
    expect(r.failed[0]).toContain(`${SHARED}: `)
    expect(r.failed[1]).toContain('専有型は、この画面からは削除できません。')
    expect(win.teardownCalls).toHaveLength(1)
  })
})

describe('S4 共用型: 済んだ回（ok:true）の知らせは、フォルダを移す前に呼び手へ渡す', () => {
  it('★★★ 利用者のファイルがあってバケットごとは消さなかった回: failed は空（移してよい）だが、月額が続く警告が渡る', async () => {
    put({ meta: { registryName: 'myreg', registryAdopted: false } })
    h.keys = ['projects/myapp/data.json', 'わたしの大事な資料.pdf']
    const r = await run(['sakura-apprun'], fakeAsk(true))
    expect(r.failed).toEqual([])
    expect(h.calls, '前提: バケットは残した').not.toContain('deleteBucket koto-data-a')
    expect(r.warned).toHaveLength(1)
    expect(r.warned[0].warnings.join('\n')).toContain('『koto-data-a』')
  })

  it('★★ 全部きれいに片づいた回は、知らせを渡さない', async () => {
    put({ meta: { registryName: 'myreg', registryAdopted: false } })
    expect((await run(['sakura-apprun'], fakeAsk(true))).warned).toEqual([])
  })
})

describe('S4 HANAMII が済んでいなければ共用型へ進まない（0.6.24 A-5。2026-10-10 の親の判断「HANAMII が失敗しても共用型へ進む」を、決定 D1 に合わせて改めた）', () => {
  function putWithHanamii() {
    put({ meta: { registryName: 'myreg', registryAdopted: false } })
    fs.writeFileSync(path.join(dir, '.sakuraide.json'), JSON.stringify({
      name: 'myapp',
      publish: {
        hanamii: { workspaceId: 'ws-1', projectId: 'hnm-proj-1', name: 'myapp', tokenId: 'tk-recorded' },
        targets: { hanamii: { publishedAt: '2026-09-29T00:00:00.000Z', url: 'https://myapp.hanamii.test' }, 'sakura-apprun': SHARED_ROW },
      },
    }, null, 2), 'utf-8')
  }

  it('★★★ HANAMII が ok:false（受け付けただけ・消せなかった）: HANAMII の行だけが積まれ、行に「共用型の破棄も始めていません」が付く。共用型の確認0・cloud:teardown 0・要求0件・共用型の step は積まない', async () => {
    putWithHanamii()
    const ask = fakeAsk(true)
    const r = await run(['hanamii', 'sakura-apprun'], ask)
    expect(win.hanamiiCalls).toHaveLength(1)
    expect(r.failed).toEqual([`${HANAMII}: HANAMII の削除を受け付けました（テスト）。${SHARED}の破棄も始めていません`])
    expect(r.steps.map(s => `${s.target}:${s.kind}`)).toEqual(['hanamii:failed']) // 共用型の step は積まない（判断が「step が無い」として移さない）
    expect(r.steps[0]).toMatchObject({ notStarted: `${SHARED}の破棄も始めていません` }) // 結果の部品で出す回は line を描かないので、別に持つ
    expect(ask.withChoices).toEqual([])
    expect(win.teardownCalls).toEqual([])
    expect(h.calls).toEqual([])
  })

  it('★★★ HANAMII が済んだ（ok:true）なら共用型へ進む。確認は、同じ保存場所を使う HANAMII の名前と「データも消えます」を言う', async () => {
    putWithHanamii()
    win.hanamiiReply = { ok: true }
    const ask = fakeAsk(true)
    const r = await run(['hanamii', 'sakura-apprun'], ask)
    expect(r.failed).toEqual([])
    expect(r.steps.map(s => `${s.target}:${s.kind}`)).toEqual(['hanamii:done', 'sakura-apprun:done'])
    expect(ask.withChoices).toHaveLength(1)
    const body = ask.withChoices[0].body
    expect(body).toContain(`${HANAMII} でも使っているため`)
    expect(body).toContain('そちらで公開中のアプリのデータも消えます')
    expect(h.calls).toContain('deleteBucket koto-data-a')
  })

  it('★★★ HANAMII の確認でやめた: 共用型の確認は出さず、IPC 0・要求0件（同じ保存場所のデータを消さない）', async () => {
    putWithHanamii()
    const ask = fakeAsk(false)
    const r = await run(['hanamii', 'sakura-apprun'], ask)
    expect(r.failed).toEqual([`${HANAMII}: 破棄をキャンセルしました。${SHARED}の破棄も始めていません`])
    expect(ask.withChoices).toEqual([])
    expect(win.teardownCalls).toEqual([])
    expect(win.hanamiiCalls).toEqual([])
    expect(h.calls).toEqual([])
  })
})
