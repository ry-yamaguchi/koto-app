import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 0.6.24 R2-d: プロジェクトの削除を、本物の plan・本物の hanamii:teardown・本物の cloud:recordTwins で通す ──────────────────────────
// 検分の再現: 保存場所を作る前に Finder で写したバックアップ（同じ projectId だけを持つ複製）がある元を削除すると、いまは複製と数えて破棄を外し、
// フォルダだけを移す。元にしか無い保存場所の記録が、どこにも残らないまま残る。
// 直したあと: 重なるが覆わない複製は、plan が破棄に入れ → 骨（I-2・重なる）が断り → 手順が failed になり → フォルダは移らない（断りの文は「要らないほうを削除」）。
// 覆われるほう（部分のほう＝バックアップ）からは、元が覆うので破棄を外して移せる（行き止まりにならない）。完全な複製は今どおり（破棄を外して移す）。
// 画面の材料（facts）は、**ここの本物の main の答え**（cloud:recordTwins）から作る。外への要求（HANAMII へ出た fetch）・ゴミ箱へ移す要求の一覧で固定する（掟10）。
// 変異: 覆うを重なるに戻す（cloud:recordTwins＝plan の側）。
import { A, h, resetHarness, newProjectDir, workspaceOf, setup } from './sharedTeardownHarness'
import { shownTeardown } from './shownFromEnv'

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { registerHanamiiHandlers } from '../src/main/ipc/hanamii'
import { resetProjectOpsForTests } from '../src/main/projectOps'
import { planProjectDeleteTeardown, type ProjectDeleteFacts, type ProjectDeleteStep } from '../src/renderer/teardown/projectDeletePlan'
import { runProjectDelete, type ProjectDeleteRunDeps } from '../src/renderer/teardown/projectDelete'
import { deleteProjectReply } from './hanamiiTeardownFixtures'

registerCloudHandlers({} as any)
registerHanamiiHandlers({} as any)
const hanamiiTeardown = shownTeardown(h.handlers.get('hanamii:teardown')!)
const EVENT = { sender: { send: () => {} } }
const PROJECT_ID = 'hnm-proj-1'
const ROW = { publishedAt: '2026-10-19T00:00:00.000Z', url: 'https://x.example/' }

let dir = ''
const realFetch = globalThis.fetch
const hanamiiFetch: string[] = []
const trashed: string[] = []
beforeEach(() => {
  resetHarness()
  resetProjectOpsForTests()
  hanamiiFetch.length = 0
  trashed.length = 0
  dir = newProjectDir()
  globalThis.fetch = (async (url: string, init?: { method?: string }) => {
    hanamiiFetch.push(`${init?.method ?? 'GET'} ${url}`)
    return deleteProjectReply(200, PROJECT_ID)
  }) as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
  fs.rmSync(dir, { recursive: true, force: true })
})

const writeHanamii = (p: string) => {
  fs.mkdirSync(p, { recursive: true })
  fs.writeFileSync(path.join(p, '.sakuraide.json'), JSON.stringify({ publish: { hanamii: { projectId: PROJECT_ID }, targets: { hanamii: ROW } } }, null, 2), 'utf-8')
}
const sibling = (name: string) => path.join(workspaceOf(dir), name)

/** 画面の材料。複製の欄は、本物の cloud:recordTwins の答え（画面の readRecordTwins と同じ形）。 */
async function factsOf(projectDir: string): Promise<ProjectDeleteFacts> {
  const r = await h.handlers.get('cloud:recordTwins')!({}, projectDir)
  return {
    targets: ['hanamii'], unreadable: false, dedicated: null, placements: [], running: null, sharedLeftover: null, sharedRegistry: null,
    twins: r.ok === true ? r.twins : null,
  }
}

/** 本物の hanamii:teardown を通して破棄する deps。ゴミ箱へ移す要求は `trashed` に積む。 */
function depsFor(): ProjectDeleteRunDeps {
  return {
    readFacts: factsOf,
    teardown: async (d, targets) => {
      const steps: ProjectDeleteStep[] = []
      for (const t of targets) {
        expect(t).toBe('hanamii')
        const r = await hanamiiTeardown(EVENT, d, { token: 'hnm_test' }, { confirmed: true, projectId: PROJECT_ID })
        if (r.ok) throw new Error('この試験では、破棄が通らない（断る）道だけを通す')
        steps.push({ target: t, kind: 'failed', line: `HANAMII: ${r.message}`, view: null, words: null })
      }
      return steps
    },
    runningOp: async () => null,
    exists: async () => true,
    trash: async p => { trashed.push(p) },
  }
}

describe('★★★ 検分の再現: 重なるが覆わない複製（保存場所を作る前のバックアップ）がある元の削除', () => {
  it('★★★ 元を削除する → plan は HANAMII を破棄に入れる → 骨が断る（HANAMII への要求0件）→ 手順は failed → フォルダは移らない（stopped）。文は「要らないほうを削除」', async () => {
    setup(dir, { env: [A], resources: [] }) // 元だけが保存場所（env.json）を持つ
    writeHanamii(dir)
    writeHanamii(sibling('backup')) // 同じ projectId だけを持つ（保存場所の記録なし）
    const facts = await factsOf(dir)
    expect(facts.twins).toEqual({ hanamii: [], 'sakura-apprun': [], 'sakura-apprun-dedicated': [] }) // 覆う複製は無い
    const plan = planProjectDeleteTeardown(facts)
    expect(plan.teardown).toEqual(['hanamii'])
    expect(plan.twinned).toEqual([])

    const run = await runProjectDelete(dir, plan, true, depsFor())
    expect(run.phase).toBe('stopped')
    expect(run.steps).toEqual([{
      target: 'hanamii', kind: 'failed', view: null, words: null,
      line: 'HANAMII: フォルダ『backup』にも同じ公開の記録があるため、何も破棄していません。要らないほうのフォルダを削除すると、残ったほうから破棄できます。',
    }])
    expect(trashed, 'フォルダを移した（元にしか無い保存場所の記録がどこにも残らない）').toEqual([])
    expect(hanamiiFetch, 'HANAMII へ削除の要求が出た（元の動いているプロジェクトが消える）').toEqual([])
    expect(fs.existsSync(path.join(dir, '.sakura-cloud', 'env.json'))).toBe(true)
  })

  it('★★★ 覆われるほう（バックアップ）を削除する → 元が覆うので破棄を外す（twinned）→ フォルダを移す（1回）。HANAMII への要求0件', async () => {
    setup(dir, { env: [A], resources: [] })
    writeHanamii(dir)
    const backup = sibling('backup')
    writeHanamii(backup)
    const facts = await factsOf(backup)
    expect(facts.twins?.hanamii).toEqual([path.basename(dir)])
    const plan = planProjectDeleteTeardown(facts)
    expect(plan.teardown).toEqual([])
    expect(plan.twinned).toEqual([{ target: 'hanamii', folders: [path.basename(dir)] }])

    const run = await runProjectDelete(backup, plan, true, depsFor())
    expect(run.phase).toBe('trashed')
    expect(trashed).toEqual([backup])
    expect(hanamiiFetch).toEqual([])
  })

  it('★★★ 対照: 完全な複製がある元は、今までどおり破棄を外してフォルダだけを移す（1回）。HANAMII への要求0件', async () => {
    setup(dir, { env: [A], resources: [] })
    writeHanamii(dir)
    setup(sibling('copy'), { env: [A], resources: [] })
    writeHanamii(sibling('copy'))
    const facts = await factsOf(dir)
    expect(facts.twins?.hanamii).toEqual(['copy'])
    const plan = planProjectDeleteTeardown(facts)
    expect(plan.teardown).toEqual([])
    const run = await runProjectDelete(dir, plan, true, depsFor())
    expect(run.phase).toBe('trashed')
    expect(trashed).toEqual([dir])
    expect(hanamiiFetch).toEqual([])
  })
})
