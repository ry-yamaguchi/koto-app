import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 公開の記録を読めない回（record-unreadable）と、確かめられなかっただけの回（unconfirmed）: 判断（plan）の試験 ─────────────────────
// 止める理由の順は、main の断りの順（fs:trashProject）と同じ: 走っている操作 → 公開の記録 → 覆う複製の免除 → 専有型。
// 公開の記録を読めない回は、破棄する公開先も複製の免除も持たない（読めた分の公開先を先に破棄しない）。
// 確かめられなかっただけの回（unconfirmed）は止めない。押し直しで新しく立ったときは、見せてから移す（noticesAddedSince）。
// 画面の描き方は tests/projectDeleteRecordDialog.test.ts、本物の main を通す流れは tests/projectDeleteRecordRealMain.test.ts。

import {
  projectDeleteBlockOf, projectDeleteBlockNote, planProjectDeleteTeardown, noticesAddedSince, projectDeleteVerdict,
  PUBLISH_RECORD_UNREADABLE_NOTE, PUBLISH_RECORD_UNREADABLE_FIX_NOTE, PUBLISH_RECORD_UNCONFIRMED_NOTE, type ProjectDeleteFacts,
} from '../src/renderer/teardown/projectDeletePlan'

const facts = (over: Partial<ProjectDeleteFacts> = {}): ProjectDeleteFacts =>
  ({ targets: [], unreadable: false, unconfirmed: false, dedicated: null, placements: [], running: null, sharedLeftover: null, sharedRegistry: null, twins: null, ...over })
const RECORD = { reason: 'record-unreadable' }
const LEFT = { appNames: [], registryName: 'reg', registryOrigin: 'owned' as const, registryUsers: [], placements: [{ bucket: 'koto-a', prefix: 'projects/x/', shared: true }] }

describe('projectDeleteBlockOf: record-unreadable の順は running → record-unreadable → 覆う複製の免除 → dedicated', () => {
  it('★★★ 公開の記録を読めない（true）: record-unreadable。公開先・専有型・残りの材料は問わない', () => {
    expect(projectDeleteBlockOf([], null, false, null, true)).toEqual(RECORD)
    expect(projectDeleteBlockOf(['hanamii', 'sakura-apprun'], null, false, undefined, true)).toEqual(RECORD)
  })

  it('★★★ true でない値（false・渡し忘れ）は止めない。今までの止め方は変わらない', () => {
    expect(projectDeleteBlockOf([], null, false, null, false)).toBeNull()
    expect(projectDeleteBlockOf([], null, false)).toBeNull()
    expect(projectDeleteBlockOf(['sakura-apprun-dedicated'], null, false, null, false)).toEqual({ reason: 'dedicated' })
  })

  it('★★★ 順序（変異: 順序を入れ替える）: 走っている操作が先。記録を読めない回の専有型の ID は、dedicated でなく record-unreadable（止める文は1つ）', () => {
    expect(projectDeleteBlockOf([], null, false, { op: '公開', target: 'hanamii' }, true)).toEqual({ reason: 'running', op: '公開', target: 'hanamii' })
    expect(projectDeleteBlockOf(['sakura-apprun-dedicated'], { clusterID: 'c-1' }, false, null, true)).toEqual(RECORD)
    expect(projectDeleteBlockOf([], { storageLeftoverBucket: 'koto-data' }, false, null, true)).toEqual(RECORD)
  })

  it('★★★ 覆う複製の免除（変異: 免除を先にする）は、記録の断りより後。複製があっても、記録を読めなければ止める。対照: 読めれば免除される', () => {
    const ids = { clusterID: 'c-1' }
    expect(projectDeleteBlockOf(['sakura-apprun-dedicated'], ids, true, null, true)).toEqual(RECORD)
    expect(projectDeleteBlockOf(['sakura-apprun-dedicated'], ids, true, null, false)).toBeNull()
    expect(projectDeleteBlockOf(['sakura-apprun-dedicated'], ids, false, null, false)).toEqual({ reason: 'dedicated' })
  })
})

describe('planProjectDeleteTeardown: 記録を読めない回は、破棄する公開先も複製の免除も持たない', () => {
  const HANAMII_AND_SHARED = { targets: ['hanamii', 'sakura-apprun'] as ProjectDeleteFacts['targets'], sharedLeftover: LEFT, placements: LEFT.placements }

  it('★★★ 読めた分の公開先（HANAMII・共用型）があっても、block は record-unreadable・teardown は []・twinned は []・残りの段（leftover）は無い', () => {
    const plan = planProjectDeleteTeardown(facts({ ...HANAMII_AND_SHARED, unreadable: true }))
    expect(plan).toEqual({ block: RECORD, teardown: [], twinned: [] })
    expect('leftover' in plan).toBe(false)
  })

  it('★★★ 対照: 読めていれば同じ材料で止めず、HANAMII → 共用型の順に破棄する', () => {
    const plan = planProjectDeleteTeardown(facts({ ...HANAMII_AND_SHARED, unreadable: false }))
    expect(plan).toEqual({ block: null, teardown: ['hanamii', 'sakura-apprun'], twinned: [] })
  })

  it('★★★ 行の無い共用型の残りだけの回（.sakuraide.json が読めない）も、段を足さず止める', () => {
    expect(planProjectDeleteTeardown(facts({ unreadable: true, sharedLeftover: LEFT }))).toEqual({ block: RECORD, teardown: [], twinned: [] })
  })

  it('★★★ 覆う複製がある専有型でも、記録を読めなければ止める。複製の注意（twinned）も出さない。対照: 読めれば止めを外し、複製の行を言う', () => {
    const twinned = { targets: ['sakura-apprun-dedicated'] as ProjectDeleteFacts['targets'], dedicated: { clusterID: 'c-1' }, twins: { hanamii: [], 'sakura-apprun': [], 'sakura-apprun-dedicated': ['copy'] } }
    expect(planProjectDeleteTeardown(facts({ ...twinned, unreadable: true }))).toEqual({ block: RECORD, teardown: [], twinned: [] })
    expect(planProjectDeleteTeardown(facts({ ...twinned, unreadable: false }))).toEqual({ block: null, teardown: [], twinned: [{ target: 'sakura-apprun-dedicated', folders: ['copy'] }] })
  })

  it('★★★ 覆う複製がある公開先（HANAMII・共用型・専有型）の全部で、記録を読めなければ twinned は []（複製の行を並べない）。対照: 読めれば複製の行を言う', () => {
    const copies = { hanamii: ['copy-h'], 'sakura-apprun': ['copy-s'], 'sakura-apprun-dedicated': ['copy-d'] }
    const all = { targets: ['hanamii', 'sakura-apprun', 'sakura-apprun-dedicated'] as ProjectDeleteFacts['targets'], dedicated: { clusterID: 'c-1' }, twins: copies }
    for (const target of ['hanamii', 'sakura-apprun'] as const) {
      const only = { targets: [target], twins: copies }
      expect(planProjectDeleteTeardown(facts({ ...only, unreadable: true })), `${target}・読めない`).toEqual({ block: RECORD, teardown: [], twinned: [] })
      expect(planProjectDeleteTeardown(facts({ ...only, unreadable: false })), `${target}・読める（対照）`).toEqual({
        block: null, teardown: [], twinned: [{ target, folders: [copies[target][0]] }],
      })
    }
    expect(planProjectDeleteTeardown(facts({ ...all, unreadable: true }))).toEqual({ block: RECORD, teardown: [], twinned: [] })
    expect(planProjectDeleteTeardown(facts({ ...all, unreadable: false })).twinned.map(t => t.target)).toEqual(['hanamii', 'sakura-apprun', 'sakura-apprun-dedicated'])
  })

  it('★★★ 記録を読めない回の専有型の ID・走っている操作との重なり: 止める文は1つ（走っている操作が先）', () => {
    expect(planProjectDeleteTeardown(facts({ targets: ['sakura-apprun-dedicated'], dedicated: { clusterID: 'c-1' }, unreadable: true })).block).toEqual(RECORD)
    expect(planProjectDeleteTeardown(facts({ unreadable: true, running: { op: '削除', target: 'sakura-apprun' } })).block).toMatchObject({ reason: 'running' })
  })

  it('★★ 移してよいか: 記録を読めない回は、どの steps でも移さない・見せて待たない（hold なし）', () => {
    const plan = planProjectDeleteTeardown(facts({ ...HANAMII_AND_SHARED, unreadable: true }))
    for (const teardownOnDelete of [true, false]) expect(projectDeleteVerdict(plan, teardownOnDelete, [])).toEqual({ moveToTrash: false, hold: false })
  })

  it('★★ 確かめられなかっただけ（unconfirmed）の回は止めない: block は null。公開先の破棄も今までどおり', () => {
    expect(planProjectDeleteTeardown(facts({ unconfirmed: true }))).toEqual({ block: null, teardown: [], twinned: [] })
    expect(planProjectDeleteTeardown(facts({ unconfirmed: true, targets: ['hanamii'] }))).toEqual({ block: null, teardown: ['hanamii'], twinned: [] })
  })
})

describe('projectDeleteBlockNote: 止める理由すべての枝（結果の欄の blocked の枝も同じ関数）', () => {
  const SAMPLES: Array<[string, Parameters<typeof projectDeleteBlockNote>[0]]> = [
    ['running', { reason: 'running', op: '公開', target: 'hanamii' }],
    ['record-unreadable', { reason: 'record-unreadable' }],
    ['dedicated', { reason: 'dedicated' }],
    ['dedicated-storage-leftover', { reason: 'dedicated-storage-leftover', buckets: ['koto-a'] }],
  ]

  it('★★★ 全部の理由で文が返る（undefined・空を画面に出さない）。record-unreadable の文は PUBLISH_RECORD_UNREADABLE_NOTE（文は変えない）に直し方を続けたもの', () => {
    for (const [reason, block] of SAMPLES) {
      const note = projectDeleteBlockNote(block)
      expect(typeof note, reason).toBe('string')
      expect(note.length, reason).toBeGreaterThan(10)
      expect(note, reason).not.toContain('undefined')
    }
    expect(projectDeleteBlockNote({ reason: 'record-unreadable' })).toBe(`${PUBLISH_RECORD_UNREADABLE_NOTE}${PUBLISH_RECORD_UNREADABLE_FIX_NOTE}`)
    expect(PUBLISH_RECORD_UNREADABLE_FIX_NOTE).toBe('Koto でこのプロジェクトを開き、ファイル一覧の 👁 で隠しファイルを表示すると、そのファイルを開いて直せます。直したら、この画面を開き直してください。')
    expect(PUBLISH_RECORD_UNREADABLE_NOTE).toBe('公開の記録（.sakuraide.json・.sakura-cloud/）を読めないため、削除できません。記録を直してから、もう一度削除してください。')
  })

  it('★★★ 理由の一覧が、型・switch の枝・この試験の一覧で食い違わない（足して書き漏らすと落ちる）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/teardown/projectDeletePlan.ts'), 'utf-8')
    const typeBody = src.slice(src.indexOf('export type ProjectDeleteBlock ='), src.indexOf('/**', src.indexOf('export type ProjectDeleteBlock =')))
    const inType = [...typeBody.matchAll(/reason: '([a-z-]+)'/g)].map(m => m[1])
    const fnBody = src.slice(src.indexOf('export function projectDeleteBlockNote'), src.indexOf('export const PUBLISH_RECORD_UNREADABLE_NOTE'))
    const inSwitch = [...fnBody.matchAll(/case '([a-z-]+)':/g)].map(m => m[1])
    const tested = SAMPLES.map(([r]) => r)
    expect(inType.sort()).toEqual([...tested].sort())
    expect(inSwitch.sort()).toEqual([...tested].sort())
  })
})

describe('noticesAddedSince: unconfirmed が新しく立った回も「注意が増えた」と数える（0-4）', () => {
  it('★★★ 見せたものは確かめられていた → 増えた。チェックの有無によらない（見せずに移さない）', () => {
    for (const teardownOnDelete of [true, false]) expect(noticesAddedSince(facts(), facts({ unconfirmed: true }), teardownOnDelete), `teardownOnDelete=${teardownOnDelete}`).toBe(true)
  })

  it('★★★ 見せたものも確かめられなかった・解けた → 増えていない（行き止まりにしない）', () => {
    expect(noticesAddedSince(facts({ unconfirmed: true }), facts({ unconfirmed: true }), true)).toBe(false)
    expect(noticesAddedSince(facts({ unconfirmed: true }), facts(), false)).toBe(false)
  })

  it('★★ 記録が読めなくなった（unreadable）の数えは今までどおり。unconfirmed と別の合図', () => {
    expect(noticesAddedSince(facts(), facts({ unreadable: true }), true)).toBe(true)
    expect(noticesAddedSince(facts({ unreadable: true }), facts({ unreadable: true }), true)).toBe(false)
    expect(noticesAddedSince(facts({ unreadable: true }), facts({ unconfirmed: true }), true)).toBe(true)
  })

  it('★★ 文: unconfirmed の注意は「削除できません」と言わない（main は断らない回）。確かめられなかったこと・破棄できなくなること・月額が続きうること・戻し方を言う', () => {
    expect(PUBLISH_RECORD_UNCONFIRMED_NOTE).toBe('共用型の記録（.sakura-cloud/）を確かめられませんでした。残っているものがあると、削除したあとは Koto から破棄できず、月額が続くことがあります（フォルダはゴミ箱から戻せます）。')
    // お金と戻し方は削らない（文を言い換えても、この2つが落ちれば止まる）
    expect(PUBLISH_RECORD_UNCONFIRMED_NOTE).toContain('月額')
    expect(PUBLISH_RECORD_UNCONFIRMED_NOTE).toContain('ゴミ箱から戻せます')
    expect(PUBLISH_RECORD_UNCONFIRMED_NOTE).not.toContain('削除できません')
    expect(PUBLISH_RECORD_UNCONFIRMED_NOTE).not.toBe(PUBLISH_RECORD_UNREADABLE_NOTE)
  })
})
