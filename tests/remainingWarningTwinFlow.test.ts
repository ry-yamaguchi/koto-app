import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 破棄の結果の警告の双子（2026-10-19）: 本物の main（cloud:teardown）を通して、由来・借り手・残した理由が返り値に載り、警告の文に届くことを固定する ──────────
// 文の全文の表は tests/remainingWarningTwin.test.ts（純関数）。ここは**本物の main が返した事実**から、その場の画面（toTeardownView）・開き直した記録
// （summarizeResult → getOps → resumedTeardownView）・プロジェクトの削除の「残したもの」（keptLinesOf）まで、同じ文が出ることを見る。
// 作者の実例の形: 共用型で、借りた（adopted）「scheduleapp」を5つのプロジェクトが使っている。そのレジストリを残した回に「後で消す場合は」と言わない。
// 偽の client・偽の保存場所と、同じ親フォルダの兄弟プロジェクト（実フォルダ）は tests/sharedTeardownHarness.ts と tests/sharedTeardownUsers.test.ts と同じ作り。
import { A, B, PREFIX, APP, OK_AUTH, REGISTRY_ROW, bucketRef, h, resetHarness, newProjectDir, workspaceOf, setup } from './sharedTeardownHarness'
import { shownTeardown } from './shownFromEnv'

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { getOps, resetProjectOpsForTests } from '../src/main/projectOps'
import { toTeardownView, resumedTeardownView } from '../src/shared/teardownResult'
import { sharedTeardownSpec } from '../src/renderer/teardown/targets/shared'
import { keptLinesOf, projectDeleteVerdict } from '../src/renderer/teardown/projectDeletePlan'
import { PUBLISH_TARGET_LABEL } from '../src/renderer/publishStatus'
import { keptBucketReasonFields } from '../src/main/cloud/storageForTarget'

registerCloudHandlers({} as any)
// 画面の代わりに、確認で見せた保存場所（記録から作る）を足して渡す（0.6.24 F。main は見せたものだけを消す）
const teardown = shownTeardown(h.handlers.get('cloud:teardown')!)
const EVENT = {}
const SHARED = 'sakura-apprun' as const
const REG = 'scheduleapp'
const KEEP = { confirmed: true, deleteRegistry: false, registryName: REG } // 利用者がチェックを入れずに（残して）破棄した回
const LATER = '後で消す場合は'
const PANEL = 'さくらのクラウドのコントロールパネル'
/** 作者の手元の実例の形（scheduleapp を使うプロジェクト）。文字コード順では Tsukaisute が先頭。 */
const FIVE = ['Tsukaisute', 'landingTEST', 'landingtest-2', 'reminder', 'tsukaisute2']

let dir = ''
beforeEach(() => { resetProjectOpsForTests(); resetHarness(); dir = newProjectDir() })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const ws = (): string => workspaceOf(dir)
const APP_OF = (name: string) => ({ kind: 'apprun-app', id: `app-${name}`, stateful: false, key: `apprun-app:${name}` })
/** 同じレジストリを使って公開しているほかのプロジェクト（アプリ1件）を、同じ親フォルダに置く。 */
function borrower(name: string, registry = REG): void {
  const d = path.join(ws(), name)
  fs.mkdirSync(path.join(d, '.sakura-cloud'), { recursive: true })
  fs.writeFileSync(path.join(d, '.sakura-cloud', 'state.json'), JSON.stringify({ name, backend: 'apprun', resources: [APP_OF(name)], meta: { registryName: registry } }), 'utf-8')
}

/** このプロジェクトの記録（レジストリ REG・アプリ1件）を置いて破棄する。その場と開き直しが同じ警告になることも確かめる。 */
async function run(meta: Record<string, unknown>, opts: Record<string, unknown> = KEEP, setupOver: Partial<Parameters<typeof setup>[1]> = {}) {
  setup(dir, { env: [], resources: [APP], meta: { registryName: REG, ...meta } as any, ...setupOver })
  h.registryRows = [{ ...REGISTRY_ROW, Status: { registry_name: REG } }]
  const reply = await teardown(EVENT, dir, OK_AUTH, opts)
  const rec = getOps(dir).last?.result
  expect(rec, '終わった操作の結果が記録に無い').toBeTruthy()
  const live = toTeardownView(SHARED, reply)
  expect(resumedTeardownView(SHARED, rec), 'その場と開き直しが食い違う').toEqual(live)
  return { reply, live }
}

// 残した理由は言わない（「…ため、残しました」としない）。残すかどうかを決めたのは Koto とは限らない（利用者がチェックを外した回・確認のあとで記録が変わって見送った回）
const USERS_SENTENCE = (who: string) => `⚠️ コンテナレジストリ『${REG}』は残しました。ほかのプロジェクト（${who}）も使っています。`

describe('★★★ 本物の main: 残したレジストリの由来と借り手が返り値に載り、警告が言い分けられる', () => {
  it('★★★ 作者の実例: 借りた（adopted）「scheduleapp」を5つのプロジェクトが使っている回を残す → 「後で消す場合は」と言わない', async () => {
    for (const n of FIVE) borrower(n)
    const { reply, live } = await run({ registryAdopted: true })
    expect(reply).toMatchObject({ ok: true, keptRegistryName: REG, keptRegistryOrigin: 'adopted', keptRegistryUsers: FIVE })
    expect(live.warnings).toEqual([USERS_SENTENCE('Tsukaisute ほか4件')])
    expect(live.warnings.join('')).not.toContain(LATER)
    expect(live.warnings.join('')).not.toContain('月額')
    // 残したレジストリには触れていない（一覧も削除も呼ばない）
    expect(h.calls.filter(c => c.includes('ContainerRegistr'))).toEqual([])
  })

  it('★★★ 借りた（adopted）が、ほかに使うプロジェクトが無い → 「このプロジェクトのために作ったものではなく…」。後で消す場合は、を言わない', async () => {
    const { reply, live } = await run({ registryAdopted: true })
    expect(reply).toMatchObject({ keptRegistryName: REG, keptRegistryOrigin: 'adopted', keptRegistryUsers: [] })
    expect(live.warnings).toEqual([`⚠️ コンテナレジストリ『${REG}』は残しました。このプロジェクトのために作ったものではありません。`])
    expect(live.warnings.join('')).not.toContain('月額') // 借りたもの。月額が続くのはこのプロジェクトの話ではない
  })

  // 0.3.43 より前に Koto が作ったレジストリも、記録に印が無いのでここに入る＝このプロジェクト自身のものかもしれない。月額は言う（お金は削らない）
  it('★★★ 印が無い（unknown。作者の手元の実例の形）→ 「このプロジェクトのために作ったか分かりません」。月額は続くと言い、「後で消す場合は」は言わない', async () => {
    const { reply, live } = await run({})
    expect(reply).toMatchObject({ keptRegistryName: REG, keptRegistryOrigin: 'unknown', keptRegistryUsers: [] })
    expect(live.warnings).toEqual([`⚠️ コンテナレジストリ『${REG}』は残しました（月額220円・税込は続きます）。このプロジェクトのために作ったか分かりません。ほかのアプリも使っていることがあります。`])
    expect(live.warnings.join('')).not.toContain(LATER)
  })

  it('★★★ 作った（owned）が、ほかのプロジェクトが借りている → 借りているプロジェクトの名前を言う。後で消す場合は、を言わない', async () => {
    borrower('reminder'); borrower('landingTEST')
    const { reply, live } = await run({ registryAdopted: false })
    expect(reply).toMatchObject({ keptRegistryOrigin: 'owned', keptRegistryUsers: ['landingTEST', 'reminder'] })
    expect(live.warnings).toEqual([USERS_SENTENCE('landingTEST・reminder')])
  })

  it('★★★ 作った（owned）で、ほかに使うプロジェクトが無い → 今の文のまま（月額・後で消す場合は）', async () => {
    const { reply, live } = await run({ registryAdopted: false })
    expect(reply).toMatchObject({ keptRegistryName: REG, keptRegistryOrigin: 'owned', keptRegistryUsers: [] })
    expect(live.warnings).toEqual([`⚠️ コンテナレジストリ『${REG}』は残るため、月額220円（税込）の課金は続きます。後で消す場合は、${PANEL}から削除してください。`])
  })

  it('★★ 自分のフォルダは借り手に数えない・アプリの無いプロジェクトは数えない（作った側が、借り手なしと読まれる）', async () => {
    fs.mkdirSync(path.join(ws(), 'name-only', '.sakura-cloud'), { recursive: true })
    fs.writeFileSync(path.join(ws(), 'name-only', '.sakura-cloud', 'state.json'), JSON.stringify({ name: 'x', backend: 'apprun', resources: [], meta: { registryName: REG } }), 'utf-8')
    const { reply } = await run({ registryAdopted: false })
    expect(reply.keptRegistryUsers).toEqual([])
  })

  // 公開したアプリ（apprun-app）の記録がある回は、親フォルダの一覧を読めないと複製の有無を確かめられず、骨が破棄ごと断る（0.6.24 R2-f。tests/twinsParentUnreadable.test.ts）。
  // ここは、複製の確かめの対象が無い回（アプリの記録が無く、レジストリの名前だけがある）で、借り手を調べる側が「いない」と言わないことを見る。
  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)('★★★ 親フォルダの一覧を読めない → 借り手は「いない」でなく「分からない」。このプロジェクトだけのものと言わない（月額・後で消す場合は、を言わない）', async () => {
    setup(dir, { env: [], resources: [], meta: { registryName: REG, registryAdopted: false } })
    h.registryRows = [{ ...REGISTRY_ROW, Status: { registry_name: REG } }]
    fs.chmodSync(ws(), 0o300) // 入れる（x）が、一覧は読めない（r なし）
    let reply: any
    try {
      reply = await teardown(EVENT, dir, OK_AUTH, KEEP)
    } finally {
      fs.chmodSync(ws(), 0o700)
    }
    expect(reply).toMatchObject({ ok: true, keptRegistryName: REG, keptRegistryOrigin: 'owned' })
    expect(reply.keptRegistryUsers, '調べられなかったのに、借り手なしを返している').toBeUndefined()
    const w = toTeardownView(SHARED, reply).warnings
    // 利用者が自分で外した回でも、「確かめられなかったため残した」とは言わない（残したのは利用者の選択）。月額は続くので言う
    expect(w).toEqual([`⚠️ コンテナレジストリ『${REG}』は残しました（月額220円・税込は続きます）。ほかのプロジェクトが使っていないか確かめられませんでした。`])
  })

  it('★★ アプリの削除に失敗した回（ok:false）にも、由来と借り手を返す。確認のあとで記録のレジストリが変わった回（名前が違う）も同じ', async () => {
    borrower('reminder')
    h.fail['deleteApp app-1'] = 'http500'
    const failed = await run({ registryAdopted: true })
    expect(failed.reply).toMatchObject({ ok: false, keptRegistryName: REG, keptRegistryOrigin: 'adopted', keptRegistryUsers: ['reminder'] })
    expect(failed.live.warnings).toContain(USERS_SENTENCE('reminder'))

    resetProjectOpsForTests(); resetHarness()
    const changed = await run({ registryAdopted: true }, { confirmed: true, deleteRegistry: true, registryName: 'other-name' })
    expect(changed.reply).toMatchObject({ keptRegistryName: REG, keptRegistryOrigin: 'adopted', keptRegistryUsers: ['reminder'] })
    // ※ の行（確認のあとで記録が変わったため、削除していません）は起きたことから警告へ移る。そのあとに、残したレジストリの1文
    expect(changed.live.warnings).toHaveLength(2)
    expect(changed.live.warnings[0]).toMatch(/^※ 確認のあとで、記録にあるコンテナレジストリが変わったため/)
    // 残した理由は、上の※の行（確認のあとで記録が変わった）。次の1文は事実だけを言い、「ほかのプロジェクトも使っているため残しました」と、実際の理由とは別の理由を言わない
    expect(changed.live.warnings[1]).toBe(USERS_SENTENCE('reminder'))
    expect(changed.live.warnings[1]).not.toContain('ため')
    expect(h.calls.filter(c => c.includes('deleteContainerRegistry'))).toEqual([])
  })

  it('★★ 利用者が「消す」を選んだ回は、借り物でも「残した」と言わない（由来・借り手の事実も返さない）', async () => {
    borrower('reminder')
    const { reply, live } = await run({ registryAdopted: true }, { confirmed: true, deleteRegistry: true, registryName: REG })
    expect(reply.keptRegistryName).toBeUndefined()
    expect(reply.keptRegistryOrigin).toBeUndefined()
    expect(reply.keptRegistryUsers).toBeUndefined()
    expect(live.warnings).toEqual([])
  })

  it('★★★ プロジェクトの削除: 残したレジストリの1文も「残ったもの」として移す前に見せる（黙って移さない）。どの文も「後で消す場合は」を言わない', async () => {
    for (const n of FIVE) borrower(n)
    const { reply } = await run({ registryAdopted: true })
    const view = toTeardownView(SHARED, reply)
    const step = { target: SHARED, kind: 'done' as const, view, words: sharedTeardownSpec.words }
    const kept = keptLinesOf([step])
    expect(kept).toEqual([`${PUBLISH_TARGET_LABEL[SHARED]}: ${USERS_SENTENCE('Tsukaisute ほか4件')}`])
    expect(projectDeleteVerdict({ block: null, teardown: [SHARED] }, true, [step])).toEqual({ moveToTrash: true, hold: true })
  })
})

describe('★★★ 本物の main: 残した保存場所の理由が返り値に載り、警告が言い分けられる', () => {
  const OTHER_PROJECT = 'projects/other-app/data.json' // ほかのプロジェクトのデータ
  const OWN_FILE = 'わたしの大事な資料.pdf'              // Koto が作ったのではないファイル（projects/ の外）
  const money = '月額495円（税込）の課金は続きます。'
  // レジストリは「消す」を選んだ形にそろえる（残したレジストリの警告が混ざらない。レジストリの言い分けは上の describe）
  const PUT = (keys: string[]) => {
    h.keys = [`${PREFIX}data.json`, ...keys]
    setup(dir, { env: [A], resources: [bucketRef(A), APP], meta: { registryName: 'myreg', registryAdopted: false } })
    h.registryRows = [REGISTRY_ROW]
  }
  const go = async () => {
    const reply = await teardown(EVENT, dir, OK_AUTH, { confirmed: true, deleteRegistry: true, registryName: 'myreg' })
    return { reply, live: toTeardownView(SHARED, reply) }
  }

  it('★★★ ほかのプロジェクトも使っている保存場所 → keptBucketsUsedByOthers。「使っています。消すと、そのプロジェクトのデータも消えます」', async () => {
    PUT([OTHER_PROJECT])
    const { reply, live } = await go()
    expect(reply).toMatchObject({ ok: true, keptBucketName: A, keptBucketNames: [A], keptBucketsUsedByOthers: [A] })
    expect(reply.keptBucketsWithOwnFiles).toBeUndefined()
    expect(live.warnings).toEqual([`⚠️ データの保存場所『${A}』は残るため、${money}ほかのプロジェクトも使っています。消すと、そのプロジェクトのデータも消えます。`])
    expect(live.warnings[0]).not.toContain(LATER)
    // 緑の ✅ の行は、理由・月額・次の操作を言わない（黄色の枠が1か所で言う）。「削除してください」と勧めない
    expect(live.executed.join('')).toContain(`保存場所『${A}』のデータを削除しました — 保存場所は残します。`)
    expect(live.executed.join('')).not.toContain('削除してください')
  })

  it('★★★ 利用者のファイルがある保存場所 → keptBucketsWithOwnFiles。「Koto が作ったのではないファイルがあります。消す前に、中身を確かめてください」', async () => {
    PUT([OWN_FILE])
    const { reply, live } = await go()
    expect(reply).toMatchObject({ ok: true, keptBucketName: A, keptBucketsWithOwnFiles: [A] })
    expect(reply.keptBucketsUsedByOthers).toBeUndefined()
    expect(live.warnings).toEqual([`⚠️ データの保存場所『${A}』は残るため、${money}Koto が作ったのではないファイルがあります。消す前に、${PANEL}で中身を確かめてください。`])
    expect(live.warnings[0]).not.toContain(LATER)
    expect(live.executed.join('')).toContain(`保存場所『${A}』のデータを削除しました — 保存場所は残します。`)
    expect(live.executed.join('')).not.toContain('削除してください')
  })

  it('★★ 両方に当てはまる（利用者のファイルもあり、ほかのプロジェクトも使う）→ 両方の事実を返し、ほかが使うほう（消すとそのデータも消える）を言う', async () => {
    PUT([OTHER_PROJECT, OWN_FILE])
    const { reply, live } = await go()
    expect(reply).toMatchObject({ keptBucketsUsedByOthers: [A], keptBucketsWithOwnFiles: [A] })
    expect(live.warnings).toEqual([`⚠️ データの保存場所『${A}』は残るため、${money}ほかのプロジェクトも使っています。消すと、そのプロジェクトのデータも消えます。`])
    // 緑の ✅ の行は、黄色の枠と食い違わない（ほかのプロジェクトも使う保存場所を「削除してください」と勧めない）
    expect(live.executed.join('')).not.toContain('削除してください')
  })

  it('★★ バケットごと消した回は、理由の事実を返さない（残ったものが無い）', async () => {
    PUT([])
    const { reply, live } = await go()
    expect(reply).toMatchObject({ ok: true, keptBucketName: null })
    expect(reply.keptBucketsUsedByOthers).toBeUndefined()
    expect(reply.keptBucketsWithOwnFiles).toBeUndefined()
    expect(live.warnings).toEqual([])
  })

  it('★★ 複数の保存場所で理由が違う → 保存場所ごとに、どの理由かを言う', async () => {
    h.keysByBucket[A] = [`${PREFIX}data.json`, OTHER_PROJECT]
    h.keysByBucket[B] = [`${PREFIX}data.json`, OWN_FILE]
    setup(dir, { env: [A, B], resources: [bucketRef(A), bucketRef(B), APP], meta: { registryName: 'myreg', registryAdopted: false } })
    h.registryRows = [REGISTRY_ROW]
    const { reply, live } = await go()
    expect(reply).toMatchObject({ keptBucketNames: [A, B], keptBucketsUsedByOthers: [A], keptBucketsWithOwnFiles: [B] })
    expect(live.warnings).toEqual([
      `⚠️ データの保存場所『${A}』『${B}』は残るため、月額990円（税込）の課金は続きます。`
      + `データの保存場所『${A}』は、ほかのプロジェクトも使っています。消すと、そのプロジェクトのデータも消えます。`
      + `データの保存場所『${B}』には、Koto が作ったのではないファイルがあります。消す前に、${PANEL}で中身を確かめてください。`,
    ])
  })
})

describe('keptBucketReasonFields: 3つの破棄（共用型・HANAMII・専有型）が返り値へ足す、残した保存場所の理由（バケットごと消したものは入れない）', () => {
  const R = (ownFiles: boolean, usedByOthers: boolean) => ({ ownFiles, usedByOthers })
  it('★★★ 理由ごとに、残した保存場所の名前を分ける。両方に当てはまるものは両方に入る。消したもの・理由の無いものは入れない', () => {
    expect(keptBucketReasonFields([
      { bucket: 'o', deletedBucket: false, keptReasons: R(false, true) },
      { bucket: 'f', deletedBucket: false, keptReasons: R(true, false) },
      { bucket: 'b', deletedBucket: false, keptReasons: R(true, true) },
      { bucket: 'none', deletedBucket: false },
      { bucket: 'gone', deletedBucket: true, keptReasons: R(true, true) }, // 消したのに理由が付いていても、残ったものではない
    ])).toEqual({ keptBucketsUsedByOthers: ['o', 'b'], keptBucketsWithOwnFiles: ['f', 'b'] })
  })
  it('理由が1つも無い（旧い返り値・全部消した）なら、何も足さない', () => {
    expect(keptBucketReasonFields([])).toEqual({})
    expect(keptBucketReasonFields([{ bucket: 'x', deletedBucket: false }, { bucket: 'y', deletedBucket: true }])).toEqual({})
    expect(keptBucketReasonFields([{ bucket: 'x', deletedBucket: false, keptReasons: R(false, false) }])).toEqual({})
  })
})
