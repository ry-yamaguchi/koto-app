import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 何を固定するか（設計書 docs/teardown-unify-plan.md 10.11.14 の C の後半。0.6.22 段階3B-1。3B-7 で前半と2つに分けた）──────────────
// 専有型の削除 `apprunDedicated:teardown` を、本物の main に偽の HTTP サーバと偽の保存場所を当てて流す。ソースの文字列は読まない（掟10。
// ただし最後の「import の向き」は、循環させない向きの見張りなので、import の行を読む）。
//   C-6 進み具合: renderer へ送る文の列と処理の記録が同じ。段の時間は返り値と記録で同じ値
//   秘密（掟4）: token・secret が処理の記録に入らない
//   C-7 ゾーン: 段の時間の保存にゾーンが付く（`zoneOf` が undefined になる退行を捕まえる）
//   import の向き: ipc/apprunDedicatedTeardown.ts・ipc/apprunDedicatedCommon.ts は ipc/apprunDedicated.ts を import しない
// 前半（C-1 確認の印・C-2 projectDir・認証・鍵・C-3 公開の記録）は tests/dedicatedTeardownShell.test.ts。偽物は tests/dedicatedTeardownShellMocks.ts、
// 下ごしらえは tests/dedicatedTeardownShellHarness.ts。

vi.mock('electron', async () => (await import('./dedicatedTeardownShellMocks')).electronMock())
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./dedicatedTeardownShellMocks')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/apprunDedicatedApply', async (orig) => (await import('./dedicatedTeardownShellMocks')).applyMock(await orig()))
vi.mock('../src/main/publishMetaFs', async (orig) => (await import('./dedicatedTeardownShellMocks')).publishMetaMock(await orig()))

import { registerApprunDedicatedHandlers } from '../src/main/ipc/apprunDedicated'
import { getOps, setStageTimingSink, type StageTimingSinkEntry } from '../src/main/projectOps'
import { STORAGE_TEARDOWN_PROGRESS } from '../src/shared/teardownSupport'
import { shownTeardown } from './shownFromEnv'
import { h } from './dedicatedTeardownShellMocks'
import { AUTH, EMPTY_OPS, EVENT, sent, setupEach, teardownEach, startServer, LB_ASG_CLUSTER_GONE, project } from './dedicatedTeardownShellHarness'

registerApprunDedicatedHandlers({} as any)
const teardown = shownTeardown(h.handlers.get('apprunDedicated:teardown')!) // 画面の代わりに、確認で見せた保存場所（env.json の記録）を渡す（0.6.24 F。main は見せたものだけを消す）

let dir = ''
beforeEach(() => { dir = setupEach() })
afterEach(() => { teardownEach() })

// ── C-6 進み具合・段の時間 ────────────────────────────────────────────

describe('C-6 進み具合と段の時間: 今までと同じ列・記録と返り値が同じ', () => {
  const LB_RECORD = { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' }

  it('★ renderer へ送る文は「LB の待ち」と「保存場所の削除」の2つだけ（文だけ・段の内部名は混ざらない）。送るたびに、処理の記録の進み具合が同じ文になる', async () => {
    project({ record: LB_RECORD, storage: true })
    await startServer(LB_ASG_CLUSTER_GONE)
    const recorded: string[] = []
    const event = { sender: { send: (_c: string, m: string) => { sent.push(m); recorded.push(getOps(dir).running?.progress.label ?? '(記録なし)') } } }

    const r = await teardown(event, dir, AUTH, { confirmed: true })

    expect(r.ok).toBe(true)
    expect(sent).toEqual(['ロードバランサの削除を待っています…', STORAGE_TEARDOWN_PROGRESS])
    expect(recorded).toEqual(sent) // 送った瞬間に、記録の進み具合も同じ文
    for (const m of sent) expect(m).not.toMatch(/teardown\.|stage/)
    // 終わったあとの記録: 最後の進み具合は最後に送った文
    expect(getOps(dir).last?.progress.label).toBe(STORAGE_TEARDOWN_PROGRESS)
    expect(getOps(dir).last?.progress.stage).toBe('teardown.storage')
  })

  it('★ 段の時間は、返り値と記録の extra.stageTimings が同じ値（アプリ → LB → ASG → クラスタ → 保存場所の順）', async () => {
    project({ record: LB_RECORD, storage: true })
    await startServer(LB_ASG_CLUSTER_GONE)

    const r = await teardown(EVENT, dir, AUTH, { confirmed: true })

    expect(r.stageTimings.stages.map((s: { stage: string }) => s.stage)).toEqual(['teardown.lb', 'teardown.asg', 'teardown.cluster', 'teardown.storage'])
    for (const s of r.stageTimings.stages) expect(s.ms).toBeGreaterThanOrEqual(0)
    expect(getOps(dir).last?.result?.extra?.stageTimings).toEqual(r.stageTimings)
  })

  it('確認の印が無い回は、段を作らない・時間を出さない（記録も作らない）', async () => {
    project({ record: LB_RECORD, storage: true })
    await startServer(LB_ASG_CLUSTER_GONE)
    const r = await teardown(EVENT, dir, AUTH, {})
    expect(r.stageTimings).toBeUndefined()
    expect(getOps(dir)).toEqual(EMPTY_OPS)
  })
})

// ── 秘密（掟4）──────────────────────────────────────────────────────

describe('秘密が処理の記録に入らない（掟4）: secretsOf が token・secret を骨へ渡している', () => {
  it('★ さくらの応答の文に token・secret が混ざって失敗しても、返り値には入る（漏れ道が実在する）が、処理の記録には伏せて残る', async () => {
    project()
    await startServer({ 'DELETE /clusters/c1': { status: 500, body: { status: 500, title: `キー ${AUTH.secret} は無効です（${AUTH.token}）` } } })

    const r = await teardown(EVENT, dir, AUTH, { confirmed: true })

    expect(r.ok).toBe(false)
    // 漏れ道が実在する: 返り値（画面へ返る）の文のどこかに入っている
    expect(JSON.stringify(r)).toContain(AUTH.secret)
    // 記録（開き直した画面が読む・main の外へ出る）には入っていない
    const json = JSON.stringify(getOps(dir))
    expect(json).not.toContain(AUTH.secret)
    expect(json).not.toContain(AUTH.token)
    expect(json).toContain('***')
  })
})

// ── C-7 ゾーン ───────────────────────────────────────────────────────

describe('C-7 ゾーン: 段の時間の保存に、記録のゾーンが付く（zoneOf が undefined になって黙って記録されなくなる退行を捕まえる）', () => {
  const sunk: StageTimingSinkEntry[] = []
  beforeEach(() => { sunk.length = 0; setStageTimingSink(e => { sunk.push(e) }) })

  it('記録にゾーンがある回: 保存の口へ渡る値に zone が付く', async () => {
    project({ record: { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1', zone: 'tk1b' } })
    await startServer(LB_ASG_CLUSTER_GONE)

    const r = await teardown(EVENT, dir, AUTH, { confirmed: true })

    expect(r.ok).toBe(true)
    expect(sunk).toHaveLength(1)
    expect(sunk[0].handler).toBe('apprunDedicated:teardown')
    expect(sunk[0].zone).toBe('tk1b')
    expect(sunk[0].stages.map(s => s.stage)).toEqual(['teardown.lb', 'teardown.asg', 'teardown.cluster'])
  })

  it('ゾーンの記録が無い回は null（無いものを推測で入れない）', async () => {
    project({ record: { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' } })
    await startServer(LB_ASG_CLUSTER_GONE)

    await teardown(EVENT, dir, AUTH, { confirmed: true })

    expect(sunk).toHaveLength(1)
    expect(sunk[0].zone).toBeNull()
  })
})

// ── import の向き（main は CommonJS へ変換される。循環させない）────────────────────────

describe('import の向き: ipc/apprunDedicatedTeardown.ts・ipc/apprunDedicatedCommon.ts は ipc/apprunDedicated.ts を import しない（循環させない）', () => {
  const ROOT = path.join(__dirname, '..')
  /** コメントを除いた import／require の相手。 */
  const importsOf = (rel: string): string[] => {
    const body = fs.readFileSync(path.join(ROOT, rel), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n')
    return [...body.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map(m => m[1])
      .concat([...body.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]))
  }

  it('apprunDedicatedCommon.ts は ipc/apprunDedicated*.ts のどれも import しない（両方が使う小さな部品。向きは一方向）', () => {
    expect(importsOf('src/main/ipc/apprunDedicatedCommon.ts').filter(s => /apprunDedicated(Teardown|Common)?$/.test(s) && s.startsWith('.'))).toEqual([])
  })

  it('apprunDedicatedTeardown.ts は ./apprunDedicated を import しない。部品は ./apprunDedicatedCommon から', () => {
    const specs = importsOf('src/main/ipc/apprunDedicatedTeardown.ts')
    expect(specs).not.toContain('./apprunDedicated')
    expect(specs).toContain('./apprunDedicatedCommon')
  })

  it('apprunDedicated.ts は ./apprunDedicatedCommon から isCreds・recordedZone を読み、削除は ./apprunDedicatedTeardown を呼ぶだけ', () => {
    const specs = importsOf('src/main/ipc/apprunDedicated.ts')
    expect(specs).toContain('./apprunDedicatedCommon')
    expect(specs).toContain('./apprunDedicatedTeardown')
  })
})
