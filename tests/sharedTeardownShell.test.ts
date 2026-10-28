import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 共用型の破棄 cloud:teardown の骨と run（設計書 10.7.12 の C・D。前半）────────────────────────
// 本物の main に偽の client・偽の保存場所を流し、「要求の一覧（h.calls）」で固定する（掟10。ソースの文字列は読まない）。
//   C-1 確認の印 / C-2 projectDir / C-3 認証の形 / C-4 鍵が埋まっている / C-5 キー未登録・env.json
//   C-6 アプリの削除に失敗 / C-7 保存場所の一覧に失敗 / C-8 レジストリ / D 公開の記録（📡 の行）の片づけ
// 後半（鍵・押し直し・例外）は sharedTeardownShell2.test.ts。
import { A, B, APP, OK_AUTH, REGISTRY_ROW, bucketRef, h, resetHarness, newProjectDir, setup, envBuckets, stateKinds, stateMeta, writePublishRecord, publishTargets } from './sharedTeardownHarness'
import { shownTeardown } from './shownFromEnv'

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { SHARED_TEARDOWN_SHELL } from '../src/main/ipc/cloudTeardown'
import { NOT_CONFIRMED_MESSAGE, BAD_PROJECT_DIR_MESSAGE } from '../src/main/cloud/teardownShell'
import { projectBusyMessage, runningOp } from '../src/main/projectLock'
import { getOps, resetProjectOpsForTests, setProjectOpsListener } from '../src/main/projectOps'
import { STORAGE_TEARDOWN_PROGRESS } from '../src/shared/teardownSupport'

registerCloudHandlers({} as any)
// 画面の代わりに、確認で見せた保存場所（記録から作る）を足して渡す（0.6.24 F。main は見せたものだけを消す）
const teardown = shownTeardown(h.handlers.get('cloud:teardown')!)
const EVENT = {}
const GO = { confirmed: true, deleteRegistry: false, registryName: null }

let dir = ''
beforeEach(() => { resetProjectOpsForTests(); resetHarness(); dir = newProjectDir() })
afterEach(() => { h.hold = null; fs.rmSync(dir, { recursive: true, force: true }) })

const opsCount = (): number => { const o = getOps(dir); return (o.last ? 1 : 0) + o.earlier.length }
const storageOf = (b: string) => [`listAllKeys ${b}`, `deleteKeys ${b}`, `deleteBucket ${b}`]

describe('C-1〜C-5: 断る回は、さくらのクラウドへも保存場所へも1本も要求を出さない', () => {
  it('C-1 確認の印が無い・true でない（省略・false・\'true\'・1・{}）→ 要求0件。処理の記録も作らない', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A), APP], meta: { registryName: 'myreg' } })
    for (const confirmed of [undefined, false, 'true', 1, {}, null]) {
      const reply = await teardown(EVENT, dir, OK_AUTH, { confirmed, deleteRegistry: true, registryName: 'myreg' })
      expect(reply, String(confirmed)).toEqual({ ok: false, message: NOT_CONFIRMED_MESSAGE })
    }
    for (const opts of [undefined, null, 'confirmed', 42]) {
      expect(await teardown(EVENT, dir, OK_AUTH, opts), String(opts)).toEqual({ ok: false, message: NOT_CONFIRMED_MESSAGE })
    }
    expect(h.calls).toEqual([])
    expect(opsCount()).toBe(0)
    expect(stateKinds(dir)).toEqual(['bucket', 'apprun-app'])
  })

  it('C-2 projectDir が空・文字列でない → 要求0件', async () => {
    for (const bad of ['', undefined, null, 42, {}]) {
      expect(await teardown(EVENT, bad, OK_AUTH, GO), String(bad)).toEqual({ ok: false, message: BAD_PROJECT_DIR_MESSAGE })
    }
    expect(h.calls).toEqual([])
  })

  it('C-3 認証の形が違う（省略・{}・\'true\'・余計なキー・配列・null・true 以外）→ 要求0件。ちょうど { heldByMain: true } だけ通す', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A), APP] })
    const bad: unknown[] = [undefined, null, {}, { heldByMain: 'true' }, { heldByMain: 1 }, { heldByMain: false }, { heldByMain: true, token: 'x' }, [], [{ heldByMain: true }], 'heldByMain', true]
    for (const auth of bad) {
      const reply = await teardown(EVENT, dir, auth, GO)
      expect(reply, JSON.stringify(auth)).toEqual({ ok: false, message: SHARED_TEARDOWN_SHELL.authMissingMessage })
    }
    expect(h.calls).toEqual([])
    expect(opsCount()).toBe(0)
    expect(SHARED_TEARDOWN_SHELL.parseAuth({ heldByMain: true })).toEqual({ heldByMain: true })
  })

  it('C-4 同じプロジェクトの別の操作が走っている（鍵が埋まっている）→ 要求は増えず、使用中の文で断る。終われば通る', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A), APP] })
    let open!: () => void
    const gate = new Promise<void>(r => { open = r })
    const entered = new Promise<void>(r => { h.hold = { entered: r, gate } })
    const first = teardown(EVENT, dir, OK_AUTH, GO)
    await entered
    expect(h.calls).toEqual(['deleteApp app-1'])
    const running = runningOp(dir)
    expect(running).toBe('削除')

    const second = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(second).toEqual({ ok: false, message: projectBusyMessage(running!, 'sakura-apprun') })
    // 共用型の破棄が走っている間は「破棄」と言う（記録の op の「削除」をそのまま言わない。破棄の確認・進み具合・結果と揃える）
    expect(second.message).toBe('いま別の操作（破棄）を実行中です。終わってからもう一度お試しください。')
    expect(h.calls).toEqual(['deleteApp app-1'])        // 2回目は1本も出ていない

    open()
    expect((await first).ok).toBe(true)
    expect(runningOp(dir)).toBeUndefined()
  })

  it('C-5 キー未登録 → 要求0件・「APIキー未登録」。env.json が無い／壊れている → 要求0件', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A), APP] })
    h.creds = null
    const noKey = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(noKey.ok).toBe(false)
    expect(noKey.message).toContain('APIキー未登録')
    h.creds = { token: 'TEST-TOKEN', secret: 'TEST-SECRET' }

    fs.writeFileSync(path.join(dir, '.sakura-cloud', 'env.json'), '{ これは JSON ではない', 'utf-8')
    expect((await teardown(EVENT, dir, OK_AUTH, GO)).ok).toBe(false)
    fs.rmSync(path.join(dir, '.sakura-cloud', 'env.json'))
    expect(await teardown(EVENT, dir, OK_AUTH, GO)).toMatchObject({ ok: false, message: 'env.json がありません' })
    expect(h.calls).toEqual([])
    expect(stateKinds(dir)).toEqual(['bucket', 'apprun-app'])
  })
})

describe('C-6 アプリの削除に失敗: レジストリにも保存場所にも触れない', () => {
  it('deleteApp が 500 → 要求は deleteApp の1件だけ。appDeleted:false・state にアプリが残る・公開の記録が残る', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A), APP], meta: { registryName: 'myreg', storagePermissionId: 'perm-1' } })
    writePublishRecord(dir, { 'sakura-apprun': { publishedAt: '2026-10-01T00:00:00.000Z', url: 'https://x.test' } })
    h.registryRows = [REGISTRY_ROW]
    h.fail['deleteApp app-1'] = 'http500'

    const reply = await teardown(EVENT, dir, OK_AUTH, { confirmed: true, deleteRegistry: true, registryName: 'myreg' })
    expect(h.calls).toEqual(['deleteApp app-1'])
    expect(reply.ok).toBe(false)
    expect(reply.appDeleted).toBe(false)
    expect(reply.message).toContain('削除に失敗しました')
    expect(reply.keptRegistryName).toBeUndefined()      // 「削除する」を選んだ回は、失敗しても残すとは言わない
    expect(stateKinds(dir)).toEqual(['bucket', 'apprun-app'])
    expect(stateMeta(dir)).toMatchObject({ registryName: 'myreg', storagePermissionId: 'perm-1' })
    expect(envBuckets(dir)).toEqual([A])
    expect(publishTargets(dir)['sakura-apprun']).toBeDefined()
  })
})

describe('C-7 保存場所の削除に失敗: 残りを全件言い、押し直せる（公開の記録を残す）', () => {
  it('一覧に失敗 → そのバケットへの削除は0件。ok:false・appDeleted:true・remainingBuckets 全件・行が残る。押し直して片づくと行が消える', async () => {
    setup(dir, { env: [A], resources: [APP, bucketRef(A)] })
    writePublishRecord(dir, { 'sakura-apprun': { publishedAt: '2026-10-01T00:00:00.000Z', url: 'https://x.test' } })
    h.fail[`listAllKeys ${A}`] = 'throw'

    const first = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(h.calls.some(c => c.startsWith('deleteKeys ') || c.startsWith('deleteBucket '))).toBe(false)
    expect(first).toMatchObject({ ok: false, appDeleted: true, remainingBucket: A, remainingBuckets: [A] })
    expect(first.message).toContain(`保存場所『${A}』が残っています（消すまで月額が続きます）`)
    expect(first.message).toContain('もう一度 🗑 破棄を押すと、保存場所の削除だけをやり直します')
    expect(first.message).toContain('コントロールパネル')
    expect(stateKinds(dir)).toEqual(['bucket'])          // 消えたアプリは記録に残らない（次の公開が 404 にならない）
    expect(envBuckets(dir)).toEqual([A])
    expect(publishTargets(dir)['sakura-apprun']).toBeDefined()

    // 押し直し: アプリは記録に無いので deleteApp は出ない。保存場所だけをやり直して行が消える。1回目はアプリがあったのに保存場所の段が止まったので、一括の無効化の印が立っている（0.6.24 R1-a）
    expect(stateMeta(dir)?.keySweepPending).toBe('apprun')
    h.fail = {}
    h.calls = []
    const second = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(second.ok).toBe(true)
    expect(h.calls).toEqual(['connect', ...storageOf(A), 'listPermissions', 'dispose'])    // 印があるので、アプリが無い回でも一括の無効化（listPermissions）が走る。押し直しの詳細は tests/keySweepPending.test.ts
    expect(stateMeta(dir)).toBeUndefined()                                                  // 最後まで済んだ回は印が消える
    expect(stateKinds(dir)).toEqual([])
    expect(envBuckets(dir)).toEqual([])
    expect(publishTargets(dir)['sakura-apprun']).toBeUndefined()
  })

  it('2件のうち後ろの一覧に失敗 → 前の分は消えて env.json・state から外れ、残りは後ろの全件。前の分は捨てない', async () => {
    setup(dir, { env: [A, B], resources: [APP, bucketRef(A), bucketRef(B)] })
    h.fail[`listAllKeys ${B}`] = 'throw'

    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(h.calls).toEqual(['deleteApp app-1', 'connect', ...storageOf(A).slice(0, 3), `listAllKeys ${B}`, 'dispose'])
    expect(reply).toMatchObject({ ok: false, appDeleted: true, remainingBucket: B, remainingBuckets: [B] })
    expect(envBuckets(dir)).toEqual([B])
    expect(stateKinds(dir)).toEqual(['bucket'])
  })

  it('保存場所に接続できない → 全件が残り、ok:false。アプリは消えていて、記録に残らない', async () => {
    setup(dir, { env: [A, B], resources: [APP, bucketRef(A)] })
    h.fail.connect = 'throw'

    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(reply).toMatchObject({ ok: false, appDeleted: true, remainingBuckets: [A, B] })
    expect(reply.message).toContain('接続できないため')
    // 3つの公開先の「残っています」の行は同じ関数（bucketNamesText）で並べる。区切りを変えると、専有型・HANAMII と文が割れる（3B の検分）
    expect(reply.message).toContain(`保存場所『${A}』『${B}』が残っています（消すまで月額が続きます）。`)
    expect(stateKinds(dir)).toEqual(['bucket'])
    expect(envBuckets(dir)).toEqual([A, B])
  })
})

describe('C-8 コンテナレジストリ: deleteRegistry === true で、確認のときの名前が記録と一致するときだけ消す', () => {
  const REG = (extra: Record<string, unknown> = {}) => ({ confirmed: true, registryName: 'myreg', ...extra })
  const registryCalls = () => h.calls.filter(c => c.includes('ContainerRegistr'))

  beforeEach(() => {
    setup(dir, { env: [], resources: [APP], meta: { registryName: 'myreg' } })
    h.registryRows = [REGISTRY_ROW]
  })

  it('deleteRegistry が省略・false・\'true\'・1・null → 削除0件・keptRegistryName（月額が続く警告の元）', async () => {
    for (const v of [undefined, false, 'true', 1, null]) {
      setup(dir, { env: [], resources: [APP], meta: { registryName: 'myreg' } })
      h.calls = []
      const reply = await teardown(EVENT, dir, OK_AUTH, REG(v === undefined ? {} : { deleteRegistry: v }))
      expect(registryCalls(), String(v)).toEqual([])
      expect(reply.ok, String(v)).toBe(true)
      expect(reply.keptRegistryName, String(v)).toBe('myreg')
      expect(stateMeta(dir), String(v)).toMatchObject({ registryName: 'myreg' })
    }
  })

  it('true で名前が一致 → 削除する。記録の名前も落ちる。kept は付かない', async () => {
    const reply = await teardown(EVENT, dir, OK_AUTH, REG({ deleteRegistry: true }))
    expect(h.calls).toEqual(['deleteApp app-1', 'listContainerRegistries', 'deleteContainerRegistry reg-1'])
    expect(reply.ok).toBe(true)
    expect(reply.keptRegistryName).toBeUndefined()
    expect(reply.keptRegistryUnnamed).toBeUndefined()
    expect(stateMeta(dir)).toBeUndefined()
  })

  it('true で名前が違う・null → 削除0件・※の行・keptRegistryName（確認のあとで記録が変わった）', async () => {
    for (const asked of ['other-registry', null, '']) {
      setup(dir, { env: [], resources: [APP], meta: { registryName: 'myreg' } })
      h.calls = []
      const reply = await teardown(EVENT, dir, OK_AUTH, { confirmed: true, deleteRegistry: true, registryName: asked })
      expect(registryCalls(), String(asked)).toEqual([])
      expect(reply.executed.some((l: string) => l.startsWith('※ 確認のあとで、記録にあるコンテナレジストリが変わったため'))).toBe(true)
      expect(reply.keptRegistryName, String(asked)).toBe('myreg')
    }
  })

  it('借り物（registryAdopted）でも、利用者が true を選んだなら消す', async () => {
    setup(dir, { env: [], resources: [APP], meta: { registryName: 'myreg', registryAdopted: true } })
    const reply = await teardown(EVENT, dir, OK_AUTH, REG({ deleteRegistry: true }))
    expect(registryCalls()).toEqual(['listContainerRegistries', 'deleteContainerRegistry reg-1'])
    expect(reply.keptRegistryName).toBeUndefined()
  })

  // ★★★ main は、画面の既定がどうであれ、確認の答え（deleteRegistry）が true のときだけレジストリを消す（2026-10-19）。
  // 印の3つの状態（作った・借りた・印が無い＝作者の手元の実例の形）のどれでも同じ。選ばない回に、どの状態でも消さない。
  it.each([
    ['作った（registryAdopted: false）', { registryName: 'myreg', registryAdopted: false }],
    ['借りた（true）', { registryName: 'myreg', registryAdopted: true }],
    ['印が無い', { registryName: 'myreg' }],
  ])('★★★ 印が「%s」: 選ばない（省略・false）なら削除0件でレジストリを残す。選んだ（true）ときだけ消す', async (_label, meta) => {
    for (const opts of [{}, { deleteRegistry: false }]) {
      setup(dir, { env: [], resources: [APP], meta })
      h.calls = []
      const kept = await teardown(EVENT, dir, OK_AUTH, REG(opts))
      expect(registryCalls(), JSON.stringify(opts)).toEqual([])
      expect(kept.keptRegistryName, JSON.stringify(opts)).toBe('myreg')
      expect(stateMeta(dir), JSON.stringify(opts)).toMatchObject({ registryName: 'myreg', ...('registryAdopted' in meta ? { registryAdopted: meta.registryAdopted } : {}) })
    }
    setup(dir, { env: [], resources: [APP], meta })
    h.calls = []
    const gone = await teardown(EVENT, dir, OK_AUTH, REG({ deleteRegistry: true }))
    expect(registryCalls()).toEqual(['listContainerRegistries', 'deleteContainerRegistry reg-1'])
    expect(gone.keptRegistryName).toBeUndefined()
  })

  it('true だが記録に名前が無い → 削除0件・※の行（月額220円）。残すとは言わない', async () => {
    setup(dir, { env: [], resources: [APP] })
    const reply = await teardown(EVENT, dir, OK_AUTH, { confirmed: true, deleteRegistry: true, registryName: 'myreg' })
    expect(registryCalls()).toEqual([])
    expect(reply.executed.some((l: string) => l.includes('どのコンテナレジストリを使っていたかの記録がない'))).toBe(true)
    expect(reply.keptRegistryName).toBeUndefined()
    expect(reply.keptRegistryUnnamed).toBeUndefined()
  })
})

describe('D 公開の記録（📡 の行 publish.targets）を消すのは main の骨の1か所だけ。保存場所まで済んだ回だけ', () => {
  it('成功 → 共用型の行だけが消え、ほかの公開先の行は残る', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A), APP] })
    writePublishRecord(dir, { 'sakura-apprun': { publishedAt: '2026-10-01T00:00:00.000Z', url: 'https://x.test' }, vercel: { publishedAt: '2026-10-02T00:00:00.000Z', url: 'https://v.test' } })
    expect((await teardown(EVENT, dir, OK_AUTH, GO)).ok).toBe(true)
    expect(Object.keys(publishTargets(dir))).toEqual(['vercel'])
  })

  it('失敗（アプリを消せない・保存場所が残った）→ 行は残る', async () => {
    for (const failing of ['deleteApp app-1', `deleteBucket ${A}`]) {
      resetHarness()
      setup(dir, { env: [A], resources: [bucketRef(A), APP] })
      writePublishRecord(dir, { 'sakura-apprun': { publishedAt: '2026-10-01T00:00:00.000Z', url: 'https://x.test' } })
      h.fail[failing] = failing.startsWith('deleteApp') ? 'http500' : 'throw'
      expect((await teardown(EVENT, dir, OK_AUTH, GO)).ok, failing).toBe(false)
      expect(publishTargets(dir)['sakura-apprun'], failing).toBeDefined()
    }
  })

  it('publish.targets に行が無い旧い共用型（state.json だけ）でも、成功すると state にアプリが無くなる（一覧の行は作られなくなる）', async () => {
    setup(dir, { env: [], resources: [APP] })
    fs.writeFileSync(path.join(dir, '.sakuraide.json'), JSON.stringify({ publish: { targets: {} } }), 'utf-8')
    expect((await teardown(EVENT, dir, OK_AUTH, GO)).ok).toBe(true)
    expect(stateKinds(dir)).toEqual([])
  })
})

// ── 進み具合の動詞（0.6.22 の決定 D3: 共用型は確認・進み具合・結果まで「破棄」）──────────────────────────────
// 進み具合の文だけ「🗑 公開したものを削除しています…」と言っていた（確認と結果は「破棄」。0.6.22-rc.3 の実機のあとの確かめで見つかった）。
// 実物の流れ（偽の client・偽の保存場所）を流し、記録に載った進み具合の文を、変わるたびに全部集めて見る。
describe('W3 進み具合の動詞: 共用型の破棄の進み具合は「破棄しています」と言い、「削除しています」と言わない', () => {
  /** 記録の進み具合の文を、変わるたびに集める（押し出しの受け手＝画面が読むものと同じ記録）。 */
  function collectProgress(): string[] {
    const labels: string[] = []
    setProjectOpsListener((_dir, snap) => {
      const label = (snap.running ?? snap.last)?.progress?.label
      if (typeof label === 'string' && labels[labels.length - 1] !== label) labels.push(label)
    })
    return labels
  }

  it('★★ アプリだけを消す回: 進み具合のどれも「削除しています」と言わず、アプリの段は「🗑 公開したものを破棄しています…」', async () => {
    setup(dir, { env: [], resources: [APP] })
    const labels = collectProgress()
    expect((await teardown(EVENT, dir, OK_AUTH, GO)).ok).toBe(true)
    expect(labels).toContain('🗑 公開したものを破棄しています…')
    expect(labels.filter(l => l.includes('削除しています')), JSON.stringify(labels)).toEqual([])
    expect(labels.filter(l => l.includes('破棄しています')), JSON.stringify(labels)).toEqual(['🗑 公開したものを破棄しています…'])
    // 記録が最初に置く1行も「破棄」（記録の op は '削除' だが、画面の言葉は公開先で決まる）
    expect(labels[0]).toContain('破棄')
  })

  it('★★ 保存場所もある回: アプリの段は「破棄しています」。保存場所のデータを直接消す段だけは、そのものを名指しする文のまま', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A), APP] })
    const labels = collectProgress()
    expect((await teardown(EVENT, dir, OK_AUTH, GO)).ok).toBe(true)
    expect(labels).toContain('🗑 公開したものを破棄しています…')
    expect(labels).not.toContain('🗑 公開したものを削除しています…')
    expect(labels.filter(l => l.includes('削除しています')), JSON.stringify(labels)).toEqual([STORAGE_TEARDOWN_PROGRESS])
  })
})
