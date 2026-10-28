import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── プロジェクトの削除で「公開も一緒に破棄する」を外したときの、コンテナレジストリの月額の文（2026-10-19、0.6.22-rc.1 の実機）──────────
// 実機の欠陥: 共用型の公開先の行があるだけで「コンテナレジストリの月額220円（税込）が、消すまで続きます。」と言っていた。
// レジストリの記録が無いプロジェクト（.sakura-cloud が無く、.sakuraide.json に共用型の行だけがある）でも出た。事実と違う。
//
// 言うのは、そのプロジェクトのために Koto が作った（owned）レジストリがあり、ほかのプロジェクトが借りていないときだけ。
// 固定のしかた: 実フォルダに記録と兄弟プロジェクトを置き、**本物の main（cloud:teardownRecord）→ 材料を読む関数 → 判断 → 文**まで流して見る
// （ソースの文字列は読まない。掟10）。文を描くダイアログ側は tests/projectDeleteDialog.test.ts、判断だけは tests/projectDeletePlan.test.ts。
import { APP, h, resetHarness, newProjectDir, workspaceOf, setup, writePublishRecord } from './sharedTeardownHarness'

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { readProjectDeleteFacts } from '../src/renderer/teardown/projectDeleteFacts'
import { planProjectDeleteTeardown, ownRegistryBillingNote, sharedLeftoverNote } from '../src/renderer/teardown/projectDeletePlan'
import { keptStorageNoteOf } from '../src/renderer/teardown/projectDeleteWords'
import { resetProjectOpsForTests } from '../src/main/projectOps'

registerCloudHandlers({} as any)
const mainRecord = h.handlers.get('cloud:teardownRecord')!
const EVENT = {}

let dir = ''
beforeEach(() => {
  resetProjectOpsForTests(); resetHarness(); dir = newProjectDir()
  // 画面の窓。ファイルは実フォルダを読み、共用型の記録は本物の main に聞く。ほかの口は「何も無い」答え。
  ;(globalThis as any).window = {
    electronAPI: {
      fs: {
        exists: async (p: string) => fs.existsSync(p),
        readFile: async (p: string) => fs.readFileSync(p, 'utf-8'),
      },
      publishMeta: { runningOp: async () => null },
      apprunDedicated: { state: async () => null },
      storage: { placement: async () => ({ ok: true, placements: [] }) },
      cloud: { teardownRecord: (d: string) => mainRecord(EVENT, d) },
    },
  }
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); delete (globalThis as any).window })

const SENTENCE = 'コンテナレジストリの月額220円（税込）が、消すまで続きます。'
const REG = 'myreg'
const ROW = { 'sakura-apprun': { publishedAt: '2026-10-01T00:00:00.000Z' } }

/** 材料を読み、判断に通して、チェックを外したときに出る月額の文を返す（先に破棄する公開先は、判断が決める）。 */
async function noteWhenUnchecked(): Promise<string> {
  const facts = await readProjectDeleteFacts(dir)
  const plan = planProjectDeleteTeardown(facts)
  expect(plan.teardown, '共用型の行があるので、先に破棄する公開先に入る').toContain('sakura-apprun')
  return ownRegistryBillingNote(facts, plan.teardown)
}

/** 共用型の公開記録（行）と、state.json（アプリ1件とレジストリ）を置く。`meta` の registryAdopted が印（false=作った・true=借りた・無い=分からない）。 */
function publishedWith(meta: Record<string, unknown>): void {
  writePublishRecord(dir, ROW)
  setup(dir, { env: [], resources: [APP], meta: meta as any })
}
/** 同じ親フォルダのほかのプロジェクトで、このレジストリにアプリを置いているもの（借りている側）。 */
function borrower(name: string): void {
  const d = path.join(workspaceOf(dir), name)
  fs.mkdirSync(path.join(d, '.sakura-cloud'), { recursive: true })
  fs.writeFileSync(path.join(d, '.sakura-cloud', 'state.json'), JSON.stringify({
    name, backend: 'apprun', resources: [{ kind: 'apprun-app', id: `app-${name}`, stateful: false, key: `apprun-app:${name}` }], meta: { registryName: REG },
  }), 'utf-8')
}

describe('チェックを外したときのコンテナレジストリの月額: 記録 → 材料 → 判断 → 文（本物の main を通す）', () => {
  it('★★★ 作者の実例の形: .sakura-cloud が無く、.sakuraide.json に共用型の行だけ → 言わない', async () => {
    writePublishRecord(dir, ROW)
    expect(fs.existsSync(path.join(dir, '.sakura-cloud'))).toBe(false)
    expect(await noteWhenUnchecked()).toBe('')
  })

  it('★★★ このプロジェクトのために Koto が作ったレジストリ（owned）で、ほかのプロジェクトが借りていない → 言う', async () => {
    publishedWith({ registryName: REG, registryAdopted: false })
    expect(await noteWhenUnchecked()).toBe(SENTENCE)
  })

  it('★★★ owned でも、ほかのプロジェクトが借りている → 言わない（1件でも）', async () => {
    publishedWith({ registryName: REG, registryAdopted: false })
    borrower('reminder')
    expect(await noteWhenUnchecked()).toBe('')
  })

  it('★★★ 借りたレジストリ（adopted）→ 言わない', async () => {
    publishedWith({ registryName: REG, registryAdopted: true })
    expect(await noteWhenUnchecked()).toBe('')
  })

  it('★★★ 作ったか分からないレジストリ（記録に印が無い。0.3.43 より前に作ったものを含む）→ 言わない', async () => {
    publishedWith({ registryName: REG })
    expect(await noteWhenUnchecked()).toBe('')
  })

  it('★★ 共用型のアプリはあるが、記録にレジストリの名前が無い → 言わない', async () => {
    publishedWith({ registryAdopted: false })
    expect(await noteWhenUnchecked()).toBe('')
  })

  // 親フォルダの一覧を読めないと、借り手がいるか分からない。空に倒すと「借り手なし」と読んで、owned の月額を言ってしまう。
  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)('★★ 親フォルダの一覧を読めない → 借り手が分からないので言わない。削除の画面には偽の注意（unreadable）も出さない', async () => {
    publishedWith({ registryName: REG, registryAdopted: false })
    const ws = workspaceOf(dir)
    fs.chmodSync(ws, 0o300) // 入れる（x）が、一覧は読めない（r なし）。自分のフォルダへは辿り着けるので、記録そのものは読める
    try {
      const facts = await readProjectDeleteFacts(dir)
      expect(facts.targets).toContain('sakura-apprun')
      expect(facts.sharedRegistry).toBeNull()
      expect(facts.unreadable).toBe(false)
      expect(ownRegistryBillingNote(facts, planProjectDeleteTeardown(facts).teardown)).toBe('')
    } finally {
      fs.chmodSync(ws, 0o700)
    }
  })
})

// ── 同じ形: 共用型の行は無く、記録にレジストリだけが残っているプロジェクト（赤い箱の 💾 の行。上と同じ判断）──────────────────────────
// アプリが無いので公開先は空。記録のコンテナレジストリが残る。月額まで言うのは、このプロジェクトだけのレジストリ（owned・借り手なし）のときだけ。
describe('記録だけが残るプロジェクトの 💾 の行: 記録 → 材料 → 文（本物の main を通す）', () => {
  const COST = `コンテナレジストリ『${REG}』も残ります（消すまで月額220円・税込が続きます）。`
  const NO_COST = `コンテナレジストリ『${REG}』も残ります。`

  /**
   * アプリは無く、レジストリの名前（と印）だけが記録にある。公開の行も無い。0.6.24 A-2 以降、借り手のいないレジストリは残りの段として破棄の対象に入る
   * （チェックを外したときに出る文が、この文）。借り手のいるレジストリだけが残る回は、段を足さない（作者の決定 K2）。
   */
  async function leftoverNote(meta: Record<string, unknown>, borrowed = false): Promise<string> {
    setup(dir, { env: [], resources: [], meta: meta as any })
    const facts = await readProjectDeleteFacts(dir)
    expect(facts.targets, '公開先は空（行もアプリも無い）').toEqual([])
    const plan = planProjectDeleteTeardown(facts)
    expect(plan.teardown, borrowed ? '借り手がいるレジストリだけ → 段を足さない（K2）' : '借り手のいないレジストリ → 残りの段').toEqual(borrowed ? [] : ['sakura-apprun'])
    expect(plan.leftover).toEqual(borrowed ? undefined : { noun: 'コンテナレジストリ' })
    expect(facts.sharedRegistry, '行が無い回は sharedRegistry ではなく sharedLeftover が言う').toBeNull()
    expect(keptStorageNoteOf(facts), 'チェックを外した回の 💾').toBe(sharedLeftoverNote(facts.sharedLeftover!))
    return keptStorageNoteOf(facts)
  }

  it('★★★ このプロジェクトのために Koto が作った（owned）レジストリで、借り手がいない → 月額を言う', async () => {
    expect(await leftoverNote({ registryName: REG, registryAdopted: false })).toBe(COST)
  })

  it('★★★ owned でも、ほかのプロジェクトが借りている → 残ることだけ。月額は言わない', async () => {
    borrower('reminder')
    expect(await leftoverNote({ registryName: REG, registryAdopted: false }, true)).toBe(NO_COST)
  })

  it('★★★ 借りたもの（adopted）→ 残ることだけ', async () => {
    expect(await leftoverNote({ registryName: REG, registryAdopted: true })).toBe(NO_COST)
  })

  it('★★★ 作ったか分からないもの（記録に印が無い）→ 残ることだけ', async () => {
    expect(await leftoverNote({ registryName: REG })).toBe(NO_COST)
  })
})
