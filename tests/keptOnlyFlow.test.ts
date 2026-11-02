import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// ── 0.6.25（T-2f）: 確認のあとで複製ができた回を、本物の流れ・本物の main・偽の client／偽の保存場所に通す ──────────────────────────
// 材料は本物の readProjectDeleteFacts、判断は本物の planProjectDeleteTeardown、走らせるのは本物の runProjectDelete・pressProjectDelete・teardownPublished、
// 保存場所を消す判断は本物の main（cloud:teardown）。口は偽（確認の答え・ゴミ箱）。確認の答えを返した直後に、同じ親フォルダへ複製を置く。
//   ・main は複製に気づいてデータにもバケットにも触れず、keptOnly を返す → 移してよいが、月額の警告があるので見せてから（phase review）
//   ・見出しは「⚠️ 破棄していません」・総括は出さない・フォルダはまだ移さない → 2回目の押しで移る
//   ・対照: 複製がいなければ、データごと消す（keptOnly は付かず、見出しは「✅ 破棄しました」）

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { resetProjectOpsForTests } from '../src/main/projectOps'
import { runProjectDelete, pressProjectDelete, teardownPublished, type ProjectDeleteRunDeps } from '../src/renderer/teardown/projectDelete'
import { readProjectDeleteFacts } from '../src/renderer/teardown/projectDeleteFacts'
import { planProjectDeleteTeardown } from '../src/renderer/teardown/projectDeletePlan'
import { teardownHeadlineOf } from '../src/renderer/teardown/headline'
import ProjectDeleteResults from '../src/renderer/components/teardown/ProjectDeleteResults'
import { resolveConfirmWithChoices, type ConfirmWithChoicesAnswer, type ConfirmWithChoicesOptions } from '../src/renderer/useConfirmChoices'
import type { ConfirmOptions } from '../src/renderer/useConfirm'
import { h, resetHarness, newProjectDir, workspaceOf, setup as setupProject, A, PREFIX, bucketRef, CONSENTED_AT } from './sharedTeardownHarness'

registerCloudHandlers({} as any)
const mainTeardown = h.handlers.get('cloud:teardown')!
const mainRecord = h.handlers.get('cloud:teardownRecord')!
const mainTwins = h.handlers.get('cloud:recordTwins')!

const REVIEW_HEAD = '破棄は済みましたが、残ったものがあります。'
const text = (s: string) => s.replace(/<[^>]*>/g, '')

let dir = ''
let teardownCalls: unknown[][] = []
const metaFile = (d: string) => path.join(d, '.sakuraide.json')

beforeEach(() => {
  resetProjectOpsForTests()
  resetHarness()
  dir = newProjectDir()
  teardownCalls = []
  // 行の無い保存場所だけのプロジェクト（A だけが env.json と state にある。アプリ・レジストリは無い。公開の行は無い）
  setupProject(dir, { env: [A], resources: [bucketRef(A)] })
  fs.writeFileSync(metaFile(dir), JSON.stringify({ name: 'myapp', publish: { targets: {} } }), 'utf-8')
  ;(globalThis as any).window = {
    electronAPI: {
      cloud: {
        teardownRecord: (d: string) => mainRecord({}, d),
        recordTwins: (d: string) => mainTwins({}, d),
        teardown: (d: string, auth: unknown, opts: unknown) => { teardownCalls.push([d, auth, opts]); return mainTeardown({}, d, auth, opts) },
      },
      hanamii: { teardown: async () => { throw new Error('この試験では HANAMII を呼ばない') } },
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
      publishMeta: new Proxy({}, { get: (_t, key) => key === 'runningOp' ? async () => null : (..._a: unknown[]) => Promise.resolve({ ok: true, meta: {} }) }),
    },
    dispatchEvent: () => true,
  }
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(path.join(workspaceOf(dir), 'myapp copy'), { recursive: true, force: true })
  delete (globalThis as any).window
})

/** 同じ親フォルダに、同じバケット・同じ prefix を同意済みで持つ複製を置く。 */
function putTwin() {
  const p = path.join(workspaceOf(dir), 'myapp copy', '.sakura-cloud')
  fs.mkdirSync(p, { recursive: true })
  fs.writeFileSync(path.join(p, 'env.json'), JSON.stringify({
    persistence: { objectStorage: [{ bucket: A, prefix: PREFIX, shared: true, consentedAt: CONSENTED_AT }] },
  }))
}

/** 確認に「はい」と答え、その直後（実行の前）に `after` を呼ぶ偽の confirm／confirmWithChoices。 */
function fakeAsk(after: () => void = () => {}) {
  const titles: string[] = []
  const answer = (): boolean => { after(); return true }
  return {
    titles,
    confirm: async (o: ConfirmOptions) => { titles.push(o.title); return answer() },
    confirmWithChoices: async (o: ConfirmWithChoicesOptions): Promise<ConfirmWithChoicesAnswer> => {
      titles.push(o.title); answer()
      return resolveConfirmWithChoices('confirm', o.choices, {})
    },
  }
}
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
const destructive = () => h.calls.filter(c => /^(deleteKeys|deleteBucket|deletePermission|listPermissions)\b/.test(c))
const resultsHtml = (run: Parameters<typeof ProjectDeleteResults>[0]['run']) => renderToStaticMarkup(createElement(ProjectDeleteResults, { run, showBlockNote: true }))

describe('T-2f 確認のあとで複製ができた回の、プロジェクトの削除（本物の流れ・本物の main）', () => {
  it('★★★ 複製ができた: main は何も消さず keptOnly を返し、phase は review・見出しは「⚠️ 破棄していません」・総括なし・フォルダはまだ移さない。2回目の押しで移る', async () => {
    const facts = await readProjectDeleteFacts(dir)
    const plan = planProjectDeleteTeardown(facts)
    expect(plan).toMatchObject({ block: null, teardown: ['sakura-apprun'], leftover: { noun: '保存場所' } })
    const ask = fakeAsk(putTwin) // 「破棄する」と答えた直後に複製ができる
    const { deps, trashed } = makeDeps(ask)

    const r = await runProjectDelete(dir, plan, true, deps)

    // main が返した事実: 複製のため、データにもバケットにも触れていない
    expect(teardownCalls).toHaveLength(1)
    expect(destructive(), '複製がいるのに、消す要求が出た').toEqual([])
    expect(r.phase).toBe('review')
    const step = r.steps[0]
    expect(step).toMatchObject({ target: 'sakura-apprun', kind: 'done', leftover: true, label: '保存場所' })
    if (step.kind !== 'done') throw new Error('done のはず')
    expect(step.view).toMatchObject({ ok: true, state: 'done', keptOnly: true })
    expect(step.view.warnings.length, '月額の警告は残る').toBeGreaterThan(0)
    expect(trashed, '見せてから移す。1回目の押しでは移さない').toEqual([])

    // 結果の欄: 新しい見出し・総括なし・月額の警告・末尾の文
    const t = text(resultsHtml(r))
    expect(t).toContain('⚠️ 破棄していません')
    expect(t).not.toContain('✅ 破棄しました')
    expect(t).not.toContain(REVIEW_HEAD)
    expect(t).toContain('月額')
    expect(t).toContain('「🗑 ゴミ箱に移動」を押すと、フォルダをゴミ箱へ移します。')

    // 2回目の押し: 破棄はやり直さず、フォルダを移す
    const second = await pressProjectDelete(dir, { plan, run: r, seen: facts }, true, deps)
    expect(second.run.phase).toBe('trashed')
    expect(trashed).toEqual([dir])
    expect(teardownCalls, '2回目の押しで、破棄をやり直した').toHaveLength(1)
    expect(ask.titles, '2回目の押しで、確認をもう一度出した').toHaveLength(1)
  })

  it('★★ 対照: 複製がいなければ、データごと消す。keptOnly は付かず、見出しは「✅ 破棄しました」。警告が無いので、そのままフォルダも移る', async () => {
    const facts = await readProjectDeleteFacts(dir)
    const plan = planProjectDeleteTeardown(facts)
    const { deps, trashed } = makeDeps(fakeAsk())

    const r = await runProjectDelete(dir, plan, true, deps)

    expect(h.calls).toContain(`deleteBucket ${A}`)
    const step = r.steps[0]
    if (step.kind !== 'done') throw new Error('done のはず')
    expect('keptOnly' in step.view).toBe(false)
    expect(step.view.warnings).toEqual([])
    expect(teardownHeadlineOf(step.view, step.words).text).toBe('✅ 破棄しました')
    expect(r.phase).toBe('trashed')
    expect(trashed).toEqual([dir])
  })
})
