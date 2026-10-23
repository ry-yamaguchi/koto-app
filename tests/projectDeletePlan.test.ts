import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── 段階3A（3A-4a）: プロジェクトの削除の判断（純関数）。設計書 docs/teardown-unify-plan.md の 10.9.3・10.9.13 の P ─────────────
//
//   projectDeleteBlockOf / projectDeleteBlockNote … 止める理由（running・dedicated・dedicated-storage-leftover）と、その赤い文
//   planProjectDeleteTeardown                       … 先に破棄する公開先の順（HANAMII → 共用型。専有型は入らない）
//   projectDeleteVerdict                            … フォルダをゴミ箱へ移してよいか。**不明な形を、移す側に倒さない**
//   failureLinesOf / keptLinesOf / sharedLeftoverNote / 文の定数
// 文の期待は、関数を通さず書き下す（関数を写した期待は、関数が壊れても通る）。

// 表に無い 'supported' の種類（将来の公開先）が末尾に残ることを確かめるため、teardownSupport に1つだけ偽の種類を足す。
vi.mock('../src/shared/teardownSupport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/shared/teardownSupport')>()
  return { ...actual, teardownSupport: (t: string) => (t === 'future-x' ? 'supported' : actual.teardownSupport(t as any)) }
})

import {
  projectDeleteBlockOf, projectDeleteBlockNote, planProjectDeleteTeardown, projectDeleteVerdict,
  failureLinesOf, keptLinesOf, sharedLeftoverNote, remainingPlacementsNote, PROJECT_DELETE_TEARDOWN_ORDER, withoutDoneTargets, noticesAddedSince,
  PROJECT_DELETE_STOPPED_HEAD, PROJECT_DELETE_STOPPED_TAIL, PROJECT_DELETE_REVIEW_HEAD, PROJECT_DELETE_REVIEW_TAIL,
  type ProjectDeleteStep, type ProjectDeletePlan, type ProjectDeleteFacts, type DedicatedResourceIds,
} from '../src/renderer/teardown/projectDeletePlan'
import { PUBLISH_TARGET_LABEL, type PublishTargetKind } from '../src/renderer/publishStatus'
import { dedicatedTeardownHasWork, teardownSupport } from '../src/shared/teardownSupport'
import type { TeardownView } from '../src/shared/teardownResult'

const ROOT = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')
const KINDS = Object.keys(PUBLISH_TARGET_LABEL) as PublishTargetKind[]

// ── P-1 止める理由 ───────────────────────────────────────────────────────────────────

describe('projectDeleteBlockOf: 止める理由', () => {
  it('★★★ publish.targets に専有型の行がある → dedicated（記録が空でも・ほかの公開先があっても）', () => {
    expect(projectDeleteBlockOf(['sakura-apprun-dedicated'], null)).toEqual({ reason: 'dedicated' })
    expect(projectDeleteBlockOf(['hanamii', 'sakura-apprun', 'sakura-apprun-dedicated'], {})).toEqual({ reason: 'dedicated' })
  })

  it.each(['applicationID', 'clusterID', 'asgID', 'loadBalancerID'] as const)('★★★ 専有型の ID（%s）が1つだけ残っている → dedicated（行が無くても）', (key) => {
    expect(projectDeleteBlockOf([], { [key]: 'id-1' })).toEqual({ reason: 'dedicated' })
    expect(projectDeleteBlockOf(['hanamii'], { [key]: 'id-1' })).toEqual({ reason: 'dedicated' })
  })

  it('★★★ 保存場所だけが残っている（storageLeftoverBucket）→ dedicated-storage-leftover（名前つき）。P10 の穴', () => {
    expect(projectDeleteBlockOf([], { storageLeftoverBucket: 'koto-data' })).toEqual({ reason: 'dedicated-storage-leftover', buckets: ['koto-data'] })
    expect(projectDeleteBlockOf(['hanamii'], { storageLeftoverBucket: 'koto-data', clusterID: null })).toEqual({ reason: 'dedicated-storage-leftover', buckets: ['koto-data'] })
  })

  it.each(['applicationID', 'clusterID', 'asgID', 'loadBalancerID'] as const)('ID（%s）と保存場所の両方が残っている → dedicated（先に言うのはクラスタなどの削除）', (key) => {
    expect(projectDeleteBlockOf([], { [key]: 'id-1', storageLeftoverBucket: 'koto-data' })).toEqual({ reason: 'dedicated' })
  })

  // 0.6.22 段階3B-7・10.11.9 の D3（詳しい場合分けは tests/projectDeleteLeftoverAll.test.ts）: D1=1 で、保存場所だけ残った回は専有型の行が残る。行があっても言い分ける。
  it('★★★ 専有型の行あり＋保存場所の残りだけ → dedicated-storage-leftover。ID が1つでもあれば dedicated のまま', () => {
    expect(projectDeleteBlockOf(['sakura-apprun-dedicated'], { storageLeftoverBucket: 'koto-data' })).toEqual({ reason: 'dedicated-storage-leftover', buckets: ['koto-data'] })
    expect(projectDeleteBlockOf(['sakura-apprun-dedicated'], { loadBalancerID: 'lb-1', storageLeftoverBucket: 'koto-data' })).toEqual({ reason: 'dedicated' })
  })

  it('全部 null・空文字・undefined・記録が null／undefined／空 → 止めない', () => {
    expect(projectDeleteBlockOf([], null)).toBeNull()
    expect(projectDeleteBlockOf([], undefined)).toBeNull()
    expect(projectDeleteBlockOf([], {})).toBeNull()
    expect(projectDeleteBlockOf([], { applicationID: null, clusterID: '', asgID: undefined, loadBalancerID: null, storageLeftoverBucket: '' })).toBeNull()
    expect(projectDeleteBlockOf(['hanamii', 'vercel', 'sakura-rental', 'sakura-apprun'], null)).toBeNull()
  })

  it('形が読めない値（文字列でない保存場所）が残っている → 止める側（dedicated）に倒す', () => {
    expect(projectDeleteBlockOf([], { storageLeftoverBucket: 5 as any })).toEqual({ reason: 'dedicated' })
  })

  it('★★★ running が最優先。専有型の行や ID があっても、進んでいる操作を言う。null・undefined なら従来どおり', () => {
    // 公開先は止める判断を変えない（どの公開先でも、走っていれば止める。言葉だけが公開先で決まる＝projectDeleteBlockNote）
    expect(projectDeleteBlockOf([], null, { op: '公開', target: 'hanamii' })).toEqual({ reason: 'running', op: '公開', target: 'hanamii' })
    expect(projectDeleteBlockOf(['sakura-apprun-dedicated'], { clusterID: 'c-1' }, { op: '削除', target: 'sakura-apprun' })).toEqual({ reason: 'running', op: '削除', target: 'sakura-apprun' })
    expect(projectDeleteBlockOf([], null, { op: '作成', target: 'unknown' })).toEqual({ reason: 'running', op: '作成', target: 'unknown' })
    expect(projectDeleteBlockOf(['sakura-apprun-dedicated'], null, null)).toEqual({ reason: 'dedicated' })
    expect(projectDeleteBlockOf(['sakura-apprun-dedicated'], null, undefined)).toEqual({ reason: 'dedicated' })
  })

  it('★★★ 専有型の行が無いとき、「止めるか」は dedicatedTeardownHasWork と全組み合わせで同じ（判断を2つ持たない）', () => {
    const vals = [null, '', 'x'] as const
    let n = 0
    for (const a of vals) for (const c of vals) for (const g of vals) for (const l of vals) for (const s of vals) {
      const rec: DedicatedResourceIds = { applicationID: a, clusterID: c, asgID: g, loadBalancerID: l, storageLeftoverBucket: s }
      expect(projectDeleteBlockOf([], rec) !== null, JSON.stringify(rec)).toBe(dedicatedTeardownHasWork(rec))
      n++
    }
    expect(n).toBe(243)
  })

  it('★ 専有型の行だけがあり記録が空の回（幽霊の行）は、止める。dedicatedTeardownHasWork は偽なので、ここは同じではない（出口は 📡 の「一覧から削除」）', () => {
    expect(dedicatedTeardownHasWork({})).toBe(false)
    expect(projectDeleteBlockOf(['sakura-apprun-dedicated'], {})).not.toBeNull()
  })

  it('「止めるか」は projectDeleteBlockOf(...) !== null。専有型の記録を渡さない（undefined）回も動く（薄い包み blocksProjectDeleteFor は 3A-5b で消した）', () => {
    const blocks = (...a: Parameters<typeof projectDeleteBlockOf>) => projectDeleteBlockOf(...a) !== null
    expect(blocks(['sakura-apprun-dedicated'], undefined)).toBe(true)
    expect(blocks(['hanamii'], undefined)).toBe(false)
    expect(blocks([], { applicationID: 'app-1' })).toBe(true)
    expect(blocks([], { storageLeftoverBucket: 'koto-data' })).toBe(true)
    expect(blocks([], { clusterID: null, asgID: null, loadBalancerID: null })).toBe(false)
  })
})

// ── P-2 赤い文 ───────────────────────────────────────────────────────────────────────

describe('projectDeleteBlockNote: 止めたときの赤い文（先頭の「⚠️ 」は描く側が付ける）', () => {
  const t094 = (JSON.parse(read('docs/wording-trim-2026-10.json')).proposals as Array<{ id: string; proposed: string }>).find(p => p.id === 'T094')!.proposed

  it('★★★ dedicated は T094 の proposed から先頭の「⚠️ 」を除いたものと1文字も同じ。描く側が付けた ⚠️ で proposed と同じになる（二重にならない）', () => {
    const note = projectDeleteBlockNote({ reason: 'dedicated' })
    expect(t094.startsWith('⚠️ ')).toBe(true)
    expect(note).toBe(t094.slice('⚠️ '.length))
    expect(`⚠️ ${note}`).toBe(t094)
    expect(note.startsWith('⚠️')).toBe(false)
  })

  it('dedicated は旧い文（「専有型（さくらのAppRun 専有型）」「削除するものの記録が無く」）を含まない。出口と次の操作は残る', () => {
    const note = projectDeleteBlockNote({ reason: 'dedicated' })
    expect(note).not.toContain('専有型（さくらのAppRun 専有型）')
    expect(note).not.toContain('削除するものの記録が無く')
    expect(note).toContain('「手順6 作ったものを削除する」')
    expect(note).toContain('クラスタ・ロードバランサを含めて削除')
    expect(note).toContain('「一覧から削除」')
  })

  it('★★ dedicated-storage-leftover: 保存場所の名前・月額が続くこと・手順6の見出し・次の操作を言う', () => {
    expect(projectDeleteBlockNote({ reason: 'dedicated-storage-leftover', buckets: ['koto-data'] })).toBe(
      'さくらのAppRun 専有型の削除で、保存場所『koto-data』だけが残っています（消すまで月額が続きます）。'
      + '先に「📦 さくらのAppRun」の専有型タブ「手順6 作ったものを削除する」で残った保存場所を削除してから、もう一度このプロジェクトを削除してください。')
  })

  // 記録の op は共用型・HANAMII の破棄も専有型の削除も '削除'。画面は前者を「破棄」と言う（D3）。公開先が分からない（'unknown'）なら op のまま。
  it.each([
    ['削除', 'sakura-apprun', '破棄'], ['削除', 'hanamii', '破棄'], ['削除', 'sakura-apprun-dedicated', '削除'], ['削除', 'unknown', '削除'],
    ['公開', 'hanamii', '公開'], ['作成', 'sakura-apprun-dedicated', '作成'],
  ] as const)('★★★ running（%s・%s）: 「いまこのプロジェクトの%sが進んでいます。終わってから…」', (op, target, word) => {
    expect(projectDeleteBlockNote({ reason: 'running', op, target }))
      .toBe(`いまこのプロジェクトの${word}が進んでいます。終わってから、もう一度このプロジェクトを削除してください。`)
  })
})

// ── P-3 先に破棄する公開先 ───────────────────────────────────────────────────────────

const facts = (over: Partial<ProjectDeleteFacts> = {}): ProjectDeleteFacts =>
  ({ targets: [], unreadable: false, dedicated: null, placements: [], running: null, sharedLeftover: null, sharedRegistry: null, ...over })

describe('planProjectDeleteTeardown: 先に破棄する公開先', () => {
  it('★★★ 並びは targets の並びに依らず HANAMII → 共用型', () => {
    expect(planProjectDeleteTeardown(facts({ targets: ['hanamii', 'sakura-apprun'] })).teardown).toEqual(['hanamii', 'sakura-apprun'])
    expect(planProjectDeleteTeardown(facts({ targets: ['sakura-apprun', 'hanamii'] })).teardown).toEqual(['hanamii', 'sakura-apprun'])
  })

  it('★★★ 専有型・Vercel・レンタルサーバは teardown に入らない（専有型は止める側。手動の案内はプランに持たない）', () => {
    const plan = planProjectDeleteTeardown(facts({ targets: ['hanamii', 'vercel', 'sakura-apprun-dedicated', 'sakura-rental'] }))
    expect(plan.teardown).toEqual(['hanamii'])
    expect(plan.block).toEqual({ reason: 'dedicated' })
    expect(Object.keys(plan).sort()).toEqual(['block', 'teardown'])
  })

  it('★★ PROJECT_DELETE_TEARDOWN_ORDER は「teardownSupport が supported と言う種類から専有型を除いた全部」と同じ（公開先を足したら、ここで気づく）', () => {
    const expected = KINDS.filter(t => teardownSupport(t) === 'supported' && t !== 'sakura-apprun-dedicated').sort()
    expect([...PROJECT_DELETE_TEARDOWN_ORDER].sort()).toEqual(expected)
    expect([...PROJECT_DELETE_TEARDOWN_ORDER]).toEqual(['hanamii', 'sakura-apprun'])
  })

  it('★★ 表に無い supported の種類（将来の公開先）は落とさず末尾に残す（teardownPublished が失敗に積み、フォルダは移らない）', () => {
    const plan = planProjectDeleteTeardown(facts({ targets: ['future-x' as PublishTargetKind, 'sakura-apprun', 'hanamii'] }))
    expect(plan.teardown).toEqual(['hanamii', 'sakura-apprun', 'future-x'])
  })

  it('同じ公開先が重なっても1つ', () => {
    expect(planProjectDeleteTeardown(facts({ targets: ['hanamii', 'hanamii', 'sakura-apprun'] })).teardown).toEqual(['hanamii', 'sakura-apprun'])
  })

  it('★★ running を渡すと block が running。teardown の中身は変えない', () => {
    const plan = planProjectDeleteTeardown(facts({ targets: ['hanamii', 'sakura-apprun'], running: { op: '公開', target: 'hanamii' } }))
    expect(plan.block).toEqual({ reason: 'running', op: '公開', target: 'hanamii' })
    expect(plan.teardown).toEqual(['hanamii', 'sakura-apprun'])
  })

  it('★★ dedicated の ID・保存場所の残りが block に出る（公開先の行が無くても）', () => {
    expect(planProjectDeleteTeardown(facts({ dedicated: { clusterID: 'c-1' } })).block).toEqual({ reason: 'dedicated' })
    expect(planProjectDeleteTeardown(facts({ dedicated: { storageLeftoverBucket: 'b' } })).block).toEqual({ reason: 'dedicated-storage-leftover', buckets: ['b'] })
    expect(planProjectDeleteTeardown(facts({ targets: ['hanamii'] }))).toEqual({ block: null, teardown: ['hanamii'] })
  })

  it('★★ sharedLeftover（10.9.18 の E=1）があっても、teardown に sakura-apprun は足さない（文を出すだけ。破棄はしない）', () => {
    const plan = planProjectDeleteTeardown(facts({
      targets: [], sharedLeftover: { registryName: 'reg', registryOrigin: 'owned', registryUsers: [], placements: [{ bucket: 'b', prefix: 'p/', shared: true }] },
    }))
    expect(plan.teardown).toEqual([])
    expect(plan.block).toBeNull()
  })
})

// ── P-4 移してよいか ─────────────────────────────────────────────────────────────────

const view = (warnings: string[] = []): TeardownView => ({
  ok: true, state: 'done', appDeleted: true, executed: [], message: '', remaining: [], inProgress: [], warnings, stageTimings: null,
})
const done = (target: PublishTargetKind, warnings: string[] = []): ProjectDeleteStep =>
  ({ target, kind: 'done', view: view(warnings), words: {} as any })
const nothing = (target: PublishTargetKind): ProjectDeleteStep => ({ target, kind: 'nothingToDo', message: '' })
const failed = (target: PublishTargetKind, line = 'x'): ProjectDeleteStep => ({ target, kind: 'failed', line, view: null, words: null })
const cancelled = (target: PublishTargetKind): ProjectDeleteStep => ({ target, kind: 'cancelled', line: 'y' })
const plan = (teardown: PublishTargetKind[], block: ProjectDeletePlan['block'] = null): ProjectDeletePlan => ({ block, teardown })
const TWO = plan(['hanamii', 'sakura-apprun'])

describe('projectDeleteVerdict: フォルダをゴミ箱へ移してよいか（不明な形を、移す側に倒さない）', () => {
  it('★★★ 止める理由がある → 移さない（step が全部 done でも）', () => {
    expect(projectDeleteVerdict(plan(['hanamii'], { reason: 'dedicated' }), true, [done('hanamii')])).toEqual({ moveToTrash: false, hold: false })
    expect(projectDeleteVerdict(plan([], { reason: 'running', op: '公開', target: 'hanamii' }), false, [])).toEqual({ moveToTrash: false, hold: false })
  })

  it('★★ チェックを外した・破棄する公開先が無い → 移す（破棄せずに移す。steps は見ない）', () => {
    expect(projectDeleteVerdict(TWO, false, [])).toEqual({ moveToTrash: true, hold: false })
    expect(projectDeleteVerdict(plan([]), true, [])).toEqual({ moveToTrash: true, hold: false })
  })

  it('★★★ 全部 done／nothingToDo → 移す', () => {
    expect(projectDeleteVerdict(TWO, true, [done('hanamii'), done('sakura-apprun')])).toEqual({ moveToTrash: true, hold: false })
    expect(projectDeleteVerdict(TWO, true, [done('hanamii'), nothing('sakura-apprun')])).toEqual({ moveToTrash: true, hold: false })
    expect(projectDeleteVerdict(plan(['sakura-apprun']), true, [nothing('sakura-apprun')])).toEqual({ moveToTrash: true, hold: false })
  })

  it('★★★ failed・cancelled が1つでもあれば移さない', () => {
    expect(projectDeleteVerdict(TWO, true, [done('hanamii'), failed('sakura-apprun')]).moveToTrash).toBe(false)
    expect(projectDeleteVerdict(TWO, true, [failed('hanamii')]).moveToTrash).toBe(false)
    expect(projectDeleteVerdict(TWO, true, [cancelled('hanamii')]).moveToTrash).toBe(false)
    expect(projectDeleteVerdict(TWO, true, [done('hanamii'), cancelled('sakura-apprun')]).moveToTrash).toBe(false)
  })

  it('★★★ step が足りない（HANAMII だけで共用型の step が無い・steps が空）→ 移さない', () => {
    expect(projectDeleteVerdict(TWO, true, [done('hanamii')])).toEqual({ moveToTrash: false, hold: false })
    expect(projectDeleteVerdict(TWO, true, [])).toEqual({ moveToTrash: false, hold: false })
    expect(projectDeleteVerdict(TWO, true, [done('sakura-apprun')]).moveToTrash).toBe(false)
  })

  it('★★ 同じ公開先の step が2つ → 移さない', () => {
    expect(projectDeleteVerdict(TWO, true, [done('hanamii'), done('hanamii'), done('sakura-apprun')]).moveToTrash).toBe(false)
  })

  it('★★★ 知らない kind（any の { kind: "ok" }）→ 移さない', () => {
    const odd = { target: 'hanamii', kind: 'ok' } as any as ProjectDeleteStep
    expect(projectDeleteVerdict(plan(['hanamii']), true, [odd]).moveToTrash).toBe(false)
    expect(projectDeleteVerdict(TWO, true, [done('hanamii'), done('sakura-apprun'), odd]).moveToTrash).toBe(false)
  })

  it('★★ plan.teardown に無い公開先の step がある → 移さない', () => {
    expect(projectDeleteVerdict(plan(['hanamii']), true, [done('hanamii'), done('sakura-apprun')]).moveToTrash).toBe(false)
  })

  it('★★★ done の警告（残った保存場所・鍵の ⚠️）が1件以上 → 移すが hold（見せてから、もう一度押してもらう）。警告が無ければ hold しない', () => {
    expect(projectDeleteVerdict(TWO, true, [done('hanamii', ['保存場所は残しました']), done('sakura-apprun')])).toEqual({ moveToTrash: true, hold: true })
    expect(projectDeleteVerdict(TWO, true, [done('hanamii'), done('sakura-apprun', [])])).toEqual({ moveToTrash: true, hold: false })
  })

  it('移さない回は、警告があっても hold しない', () => {
    expect(projectDeleteVerdict(TWO, true, [done('hanamii', ['w']), failed('sakura-apprun')])).toEqual({ moveToTrash: false, hold: false })
  })
})

// ── P-5 文の作り ─────────────────────────────────────────────────────────────────────

describe('failureLinesOf・keptLinesOf: 今の failed[]・kept[] と同じ文', () => {
  it('failureLinesOf: failed・cancelled の line を並び順どおりに。done・nothingToDo は出さない', () => {
    const steps = [
      done('hanamii', ['w']), failed('sakura-apprun', '📦 さくらのAppRun: 原因不明'), cancelled('hanamii'), nothing('sakura-apprun'),
    ]
    expect(failureLinesOf(steps)).toEqual(['📦 さくらのAppRun: 原因不明', 'y'])
    expect(failureLinesOf([])).toEqual([])
    expect(failureLinesOf([done('hanamii'), nothing('sakura-apprun')])).toEqual([])
  })

  it('★★ keptLinesOf: done の警告を「公開先の名前: 警告」にする（公開先の名前は表の文字どおり）。failed・nothingToDo の警告は出さない', () => {
    expect(keptLinesOf([done('hanamii', ['保存場所『a』は残しました', '鍵が無効になっていません']), done('sakura-apprun', ['コンテナレジストリは残しました'])])).toEqual([
      '🌸 HANAMII: 保存場所『a』は残しました',
      '🌸 HANAMII: 鍵が無効になっていません',
      '📦 さくらのAppRun: コンテナレジストリは残しました',
    ])
    expect(keptLinesOf([failed('hanamii'), nothing('sakura-apprun'), done('hanamii')])).toEqual([])
  })
})

// ── 検分（段階3A の指摘）: 済んだ破棄を「これから消す」と言い続けない／見ていない注意を見せてから移す ───────────────

describe('withoutDoneTargets: 破棄が済んだ（done）公開先を除く。失敗・やめた・消すものが無い行は残す', () => {
  it('★★★ done の公開先だけが落ちる。並びは変えない', () => {
    expect(withoutDoneTargets(['hanamii', 'sakura-apprun'], [done('hanamii', ['残り'])])).toEqual(['sakura-apprun'])
    expect(withoutDoneTargets(['hanamii', 'sakura-apprun'], [done('hanamii'), done('sakura-apprun')])).toEqual([])
    expect(withoutDoneTargets(['hanamii', 'sakura-apprun', 'vercel'], [done('sakura-apprun')])).toEqual(['hanamii', 'vercel'])
  })

  it('★★★ failed・cancelled・nothingToDo の公開先は残る（まだ消えていない／消すものが記録に無いだけ）。step が無ければ全部残る', () => {
    expect(withoutDoneTargets(['hanamii', 'sakura-apprun'], [done('hanamii'), failed('sakura-apprun')])).toEqual(['sakura-apprun'])
    expect(withoutDoneTargets(['hanamii'], [cancelled('hanamii')])).toEqual(['hanamii'])
    expect(withoutDoneTargets(['sakura-apprun'], [nothing('sakura-apprun')])).toEqual(['sakura-apprun'])
    expect(withoutDoneTargets(['hanamii', 'sakura-apprun'], [])).toEqual(['hanamii', 'sakura-apprun'])
  })
})

describe('noticesAddedSince: 読み直した材料に、利用者がまだ見ていない注意が増えたか（増えたら移す前に見せる）', () => {
  const base = (over: Partial<ProjectDeleteFacts> = {}): ProjectDeleteFacts =>
    ({ targets: [], unreadable: false, dedicated: null, placements: [], running: null, sharedLeftover: null, sharedRegistry: null, ...over })
  const PL = { bucket: 'koto-a', prefix: 'projects/x/', shared: true }

  it('★★★ 公開の記録が読めなくなった（見せたものは読めていた）→ 増えた。見せたものも読めなかったなら、増えていない（行き止まりにしない）', () => {
    expect(noticesAddedSince(base(), base({ unreadable: true }))).toBe(true)
    expect(noticesAddedSince(base({ unreadable: true }), base({ unreadable: true }))).toBe(false)
    expect(noticesAddedSince(base({ unreadable: true }), base())).toBe(false)
  })

  it('★★★ 共用型の残りが新しく出てきた → 増えた。見せたものと同じなら増えていない。無くなったのは増えていない', () => {
    expect(noticesAddedSince(base(), base({ sharedLeftover: { registryName: 'reg', placements: [] } }))).toBe(true)
    expect(noticesAddedSince(base(), base({ sharedLeftover: { registryName: null, placements: [PL] } }))).toBe(true)
    const same = { registryName: 'reg', placements: [PL] }
    expect(noticesAddedSince(base({ sharedLeftover: same }), base({ sharedLeftover: { ...same, placements: [{ ...PL }] } }))).toBe(false)
    expect(noticesAddedSince(base({ sharedLeftover: same }), base())).toBe(false)
  })

  it('★★ 見せた残りに、新しい保存場所・別のレジストリが足された → 増えた。保存場所が減っただけなら増えていない', () => {
    const seen = base({ sharedLeftover: { registryName: 'reg', placements: [PL] } })
    expect(noticesAddedSince(seen, base({ sharedLeftover: { registryName: 'reg', placements: [PL, { bucket: 'koto-b', prefix: 'p/', shared: false }] } }))).toBe(true)
    expect(noticesAddedSince(seen, base({ sharedLeftover: { registryName: 'reg', placements: [{ ...PL, prefix: 'projects/y/' }] } }))).toBe(true)
    expect(noticesAddedSince(seen, base({ sharedLeftover: { registryName: 'other', placements: [PL] } }))).toBe(true)
    expect(noticesAddedSince(seen, base({ sharedLeftover: { registryName: 'reg', placements: [] } }))).toBe(false)
  })

  it('★★ 公開先が増えただけ・止める理由・走っている操作は数えない（破棄の確認と止める判断が、それぞれ見せる）', () => {
    expect(noticesAddedSince(base(), base({ targets: ['hanamii'], dedicated: { clusterID: 'c' }, running: { op: '公開', target: 'hanamii' } }))).toBe(false)
  })
})

describe('sharedLeftoverNote・remainingPlacementsNote・文の定数', () => {
  const placements = [{ bucket: 'koto-a', prefix: 'projects/a/', shared: true }]

  it('★★ 保存場所だけ → remainingPlacementsNote と1文字も同じ（文は今のまま）', () => {
    expect(sharedLeftoverNote({ registryName: null, registryOrigin: 'unknown', registryUsers: [], placements })).toBe(remainingPlacementsNote(placements))
    expect(remainingPlacementsNote(placements)).toBe('保存場所「koto-a」とその中のデータは残ります（消すまで月額495円・税込が続きます）。')
  })

  // レジストリの文（owned・借り手なしだけ月額まで言う。3状態と借り手ごと）は tests/projectDeleteRegistryBillingNote.test.ts（このファイルは 400 行までの決まり）

  it('remainingPlacementsNote: 名前の重複を除く。2つ以上は「1つにつき」', () => {
    expect(remainingPlacementsNote([{ bucket: 'a' }, { bucket: 'a' }])).toBe('保存場所「a」とその中のデータは残ります（消すまで月額495円・税込が続きます）。')
    expect(remainingPlacementsNote([{ bucket: 'a' }, { bucket: 'b' }])).toBe('保存場所「a・b」とその中のデータは残ります（消すまで1つにつき月額495円・税込が続きます）。')
  })

  it('★★ 文の定数: もとの window.alert の文のまま（「OK を押すと」だけ言い換えた）。review の末尾だけ、ほかのプロジェクトも使う保存場所を消さないよう添えた（検分: 残した保存場所の削除を勧めない）', () => {
    expect(PROJECT_DELETE_STOPPED_HEAD).toBe('公開の破棄を完了できなかったため、プロジェクトの削除を中止しました。')
    expect(PROJECT_DELETE_STOPPED_TAIL).toBe(
      'このままフォルダを削除すると、どこに何を公開したかの記録も消えて、Koto から破棄できなくなります。'
      + '【公開】の画面から破棄するか、各サービスの管理画面で削除してください。')
    expect(PROJECT_DELETE_REVIEW_HEAD).toBe('公開の破棄は済みましたが、残ったものがあります。')
    expect(PROJECT_DELETE_REVIEW_TAIL).toBe('「🗑 ゴミ箱に移動」を押すと、フォルダをゴミ箱へ移します。残ったものは、各サービスの管理画面から削除できます。ほかのプロジェクトも使う保存場所とコンテナレジストリは、消さないでください。消すと、保存場所はそのプロジェクトのデータが消え、コンテナレジストリはそのアプリが止まります。')
  })
})

// ── 配線（ソースの見張り。コメントを除いて見る）────────────────────────────────────

describe('projectDeletePlan.ts の作り', () => {
  const code = (rel: string) => read(rel).split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*')).join('\n')
  const FILE = 'src/renderer/teardown/projectDeletePlan.ts'

  it('300行以下。window・React・IPC に触らず、専有型の手本の9ファイルを import しない', () => {
    expect(read(FILE).split('\n').length).toBeLessThanOrEqual(300)
    const c = code(FILE)
    expect(c).not.toMatch(/\bwindow\b/)
    expect(c).not.toContain('electronAPI')
    expect(c).not.toMatch(/from 'react'/)
    expect(c).not.toContain('useState')
    for (const model of ['dedicatedTeardownFlow', 'useDedicatedTeardown', 'DedicatedTeardownRow', 'DedicatedTeardownView', 'DedicatedOpsParts', 'apprunDedicatedActions', 'apprunDedicated\'', 'apprunDedicatedApply', 'AppRunDedicatedPanel']) {
      expect(c, model).not.toContain(model)
    }
  })

  it('★★★ Sidebar とダイアログは、移した 4 つを自分では定義も再エクスポートもしない。使うダイアログは、ここから import する', () => {
    const sidebar = code('src/renderer/components/Sidebar.tsx')
    const dialog = code('src/renderer/components/ProjectDeleteDialog.tsx')
    // 3A-5a: 削除の確認の中身はダイアログへ移った。Sidebar はこの判断を import しない。薄い包み blocksProjectDeleteFor は 3A-5b で消えた（src に無い）
    expect(sidebar).not.toContain("from '../teardown/projectDeletePlan'")
    expect(dialog).toMatch(/from '\.\.\/teardown\/projectDeletePlan'/)
    for (const name of ['PUBLISH_RECORD_UNREADABLE_NOTE', 'remainingPlacementsNote']) expect(dialog, name).toContain(name)
    for (const src of [sidebar, dialog]) {
      for (const name of ['blocksProjectDeleteFor', 'PUBLISH_RECORD_UNREADABLE_NOTE', 'remainingPlacementsNote', 'DedicatedResourceIds']) {
        expect(src, `${name} を定義している`).not.toMatch(new RegExp(`^\\s*(?:export\\s+)?(?:function|const|type)\\s+${name}\\b`, 'm'))
        expect(src, `${name} を export している`).not.toMatch(new RegExp(`export[^\\n]*\\b${name}\\b`))
      }
    }
  })

  it('専有型の「何か残っているか」は dedicatedTeardownHasWork を呼んで決める（ここは理由の言い分けだけ。判断を2つ持たない）', () => {
    expect(code(FILE)).toContain('dedicatedTeardownHasWork(dedicated)')
  })
})
