import { describe, it, expect } from 'vitest'
import {
  ACCOUNT_MISMATCH_NOTE,
  collectServicePrincipalCandidates,
  formatProjectNames,
  isServicePrincipalId,
  needsServicePrincipalCandidates,
  planServicePrincipalPrefill,
  resourceIdFormatOk,
  singlePrefillNote,
  type ServicePrincipalCandidate,
} from '../src/shared/servicePrincipalCandidates'
import { servicePrincipalIdOf } from '../src/shared/publishMeta'
import { validateClusterSpec, type ApprunDedicatedClusterSpec } from '../src/main/cloud/apprunDedicatedApply'
import {
  loadServicePrincipalCandidates,
  resolveServicePrincipalPrefill,
  type CandidateIo,
} from '../src/renderer/servicePrincipalCandidates'

// AppRun 専有型 ②: 「前のプロジェクトで使ったサービスプリンシパルID」を候補として集める（2026-10-06・作者の決定）。
// 集める・束ねる・並べる・自分を除く・形を見る、はすべて純関数（src/shared/servicePrincipalCandidates.ts）。
// ここは振る舞いで固定する（実装を壊すと落ちる。変異試験は作業報告にある）。

const ID_A = '111111111111'
const ID_B = '222222222222'
const ID_C = '333333333333'

type Rec = { dir: string; name?: string; publish?: unknown; metaUpdatedAtMs?: number | null }
const rec = (dir: string, name: string, id: unknown, at: number | null = null): Rec => ({
  dir,
  name,
  publish: { apprunDedicated: { servicePrincipalId: id } },
  metaUpdatedAtMs: at,
})

describe('resourceIdFormatOk: 12桁の数字かどうか（②の欄の「形は合っています」・候補の判定・main の作成入口の唯一の定義）', () => {
  it('空・空白だけは null（まだ入力が無い）', () => {
    expect(resourceIdFormatOk('')).toBeNull()
    expect(resourceIdFormatOk('   ')).toBeNull()
  })
  it('前後の空白を落としてちょうど12桁の数字なら true、それ以外は false', () => {
    expect(resourceIdFormatOk(ID_A)).toBe(true)
    expect(resourceIdFormatOk(`  ${ID_A} `)).toBe(true)
    expect(resourceIdFormatOk('12345678901')).toBe(false)
    expect(resourceIdFormatOk('1234567890123')).toBe(false)
  })
  it('★ 12文字でも数字でないものは false（以前は長さだけを見て true になり、main に拒否される ID が通っていた）', () => {
    expect(resourceIdFormatOk('11111111111a')).toBe(false)
    expect(resourceIdFormatOk('abcdefghijkl')).toBe(false)
    expect(resourceIdFormatOk('1111-1111-11')).toBe(false)
    expect(resourceIdFormatOk('１１１１１１１１１１１１')).toBe(false) // 全角の数字
  })
})

describe('画面（resourceIdFormatOk）と main の作成入口（validateClusterSpec）は、同じ ID について同じ答えを出す（食い違わない）', () => {
  const SPEC: ApprunDedicatedClusterSpec = {
    name: 'myapp',
    ports: [{ port: 80, protocol: 'http' }, { port: 443, protocol: 'https' }],
    servicePrincipalID: ID_A,
    zone: 'tk1b',
    workerServiceClassPath: 'cloud/apprun/dedicated/worker/1vcpu_2gb',
    minNodes: 1,
    maxNodes: 1,
    lbServiceClassPath: 'cloud/apprun/dedicated/lb/1vcpu_2gb_1',
  }

  const SAMPLES = [
    ID_A, '123456789012', '000000000000',
    '11111111111a', 'abcdefghijkl', '1111-1111-11', '１１１１１１１１１１１１',
    '12345678901', '1234567890123', 'sp-1', '12345', ' 111111111111', '111111111111 ',
  ]

  it('どの ID でも、画面が「形は合っています」と言うもの＝ main が通すもの', () => {
    for (const id of SAMPLES) {
      const main = validateClusterSpec({ ...SPEC, servicePrincipalID: id }).ok
      // 画面は前後の空白を落としてから見る。main へは画面が落とした値（resourceId.trim()）が渡る。
      const screen = resourceIdFormatOk(id)
      const mainOnTrimmed = validateClusterSpec({ ...SPEC, servicePrincipalID: id.trim() }).ok
      expect(screen === true, `画面の判定と main の判定が食い違う: ${JSON.stringify(id)}`).toBe(mainOnTrimmed)
      // 空白つきのまま main へ来たら通さない（isServicePrincipalId は落とさない・落とすのは呼び出し側）
      expect(main).toBe(isServicePrincipalId(id))
    }
  })

  it('候補にしてよいものも、同じ判定（候補になった ID は、そのまま main が通す）', () => {
    const out = collectServicePrincipalCandidates(
      SAMPLES.map((id, i) => rec(`/ws/p${i}`, `p${i}`, id, i + 1)),
      '/ws/current',
    )
    expect(out.length).toBeGreaterThan(0)
    for (const c of out) expect(validateClusterSpec({ ...SPEC, servicePrincipalID: c.id }).ok).toBe(true)
  })
})

describe('servicePrincipalIdOf: publish から記録済みの ID を読む（形が違えば null）', () => {
  it('apprunDedicated.servicePrincipalId が文字列ならそのまま返す（空白も落とさない）', () => {
    expect(servicePrincipalIdOf({ apprunDedicated: { servicePrincipalId: ID_A } })).toBe(ID_A)
    expect(servicePrincipalIdOf({ apprunDedicated: { servicePrincipalId: ` ${ID_A}` } })).toBe(` ${ID_A}`)
  })
  it('publish が無い・apprunDedicated が無い・文字列でない・配列は null', () => {
    expect(servicePrincipalIdOf(null)).toBeNull()
    expect(servicePrincipalIdOf(undefined)).toBeNull()
    expect(servicePrincipalIdOf('x')).toBeNull()
    expect(servicePrincipalIdOf({})).toBeNull()
    expect(servicePrincipalIdOf({ apprunDedicated: null })).toBeNull()
    expect(servicePrincipalIdOf({ apprunDedicated: [] })).toBeNull()
    expect(servicePrincipalIdOf({ apprunDedicated: { servicePrincipalId: 123456789012 } })).toBeNull()
    expect(servicePrincipalIdOf({ apprunDedicated: { servicePrincipalId: null } })).toBeNull()
  })
})

describe('collectServicePrincipalCandidates: 集める・束ねる・並べる', () => {
  it('同じ ID は1つにまとめ、使っているプロジェクト名を束ねる（記録が新しいプロジェクトが先）', () => {
    const out = collectServicePrincipalCandidates([
      rec('/ws/blog', 'blog', ID_A, 100),
      rec('/ws/shop', 'shop', ID_A, 300),
      rec('/ws/lp', 'lp', ID_A, 200),
    ], '/ws/current')
    expect(out).toEqual([{ id: ID_A, projectNames: ['shop', 'lp', 'blog'], updatedAtMs: 300 }])
  })

  it('新しい順に並べる（いちばん新しい記録の更新時刻。複数のプロジェクトが同じ ID なら、その中の最新で比べる）', () => {
    const out = collectServicePrincipalCandidates([
      rec('/ws/a1', 'a1', ID_A, 100),
      rec('/ws/b1', 'b1', ID_B, 500),
      rec('/ws/c1', 'c1', ID_C, 300),
      rec('/ws/a2', 'a2', ID_A, 400),
    ], '/ws/current')
    expect(out.map(c => c.id)).toEqual([ID_B, ID_A, ID_C])
    expect(out.map(c => c.updatedAtMs)).toEqual([500, 400, 300])
  })

  it('更新時刻が分からないもの（null・欠落・数でない）は最後に回る。時刻のあるものを押しのけない', () => {
    const out = collectServicePrincipalCandidates([
      rec('/ws/n1', 'n1', ID_A, null),
      { dir: '/ws/n2', name: 'n2', publish: { apprunDedicated: { servicePrincipalId: ID_B } } }, // metaUpdatedAtMs なし
      { dir: '/ws/n3', name: 'n3', publish: { apprunDedicated: { servicePrincipalId: ID_C } }, metaUpdatedAtMs: 'x' as any },
      rec('/ws/t1', 't1', '444444444444', 1),
    ], '/ws/current')
    expect(out[0]).toEqual({ id: '444444444444', projectNames: ['t1'], updatedAtMs: 1 })
    expect(out.slice(1).every(c => c.updatedAtMs === null)).toBe(true)
  })

  it('同じ時刻なら、使っているプロジェクトが多い ID が先。それも同じなら ID の昇順（結果が毎回同じ）', () => {
    const a = collectServicePrincipalCandidates([
      rec('/ws/p1', 'p1', ID_B, 100), rec('/ws/p2', 'p2', ID_A, 100), rec('/ws/p3', 'p3', ID_A, 100),
    ], '/ws/current')
    expect(a.map(c => c.id)).toEqual([ID_A, ID_B]) // A は2件
    const b = collectServicePrincipalCandidates([
      rec('/ws/p1', 'p1', ID_C, 100), rec('/ws/p2', 'p2', ID_A, 100), rec('/ws/p3', 'p3', ID_B, 100),
    ], '/ws/current')
    expect(b.map(c => c.id)).toEqual([ID_A, ID_B, ID_C])
    // 入力の並びを逆にしても同じ
    const c = collectServicePrincipalCandidates([
      rec('/ws/p3', 'p3', ID_B, 100), rec('/ws/p2', 'p2', ID_A, 100), rec('/ws/p1', 'p1', ID_C, 100),
    ], '/ws/current')
    expect(c).toEqual(b)
  })

  it('同じプロジェクト名が2つあっても名前は重複して並べない', () => {
    const out = collectServicePrincipalCandidates([
      rec('/ws/x', 'site', ID_A, 100), rec('/other/x', 'site', ID_A, 200),
    ], '/ws/current')
    expect(out).toEqual([{ id: ID_A, projectNames: ['site'], updatedAtMs: 200 }])
  })

  it('名前が無い記録はフォルダ名で、フォルダも分からなければ「（名前不明）」で出す（ID を落とさない）', () => {
    const out = collectServicePrincipalCandidates([
      { dir: '/ws/folder-name/', publish: { apprunDedicated: { servicePrincipalId: ID_A } }, metaUpdatedAtMs: 2 },
      { publish: { apprunDedicated: { servicePrincipalId: ID_B } }, metaUpdatedAtMs: 1 },
    ], '/ws/current')
    expect(out).toEqual([
      { id: ID_A, projectNames: ['folder-name'], updatedAtMs: 2 },
      { id: ID_B, projectNames: ['（名前不明）'], updatedAtMs: 1 },
    ])
  })

  it('ID の前後の空白は落として束ねる（記録に空白つきで入っていても同じ ID として数える）', () => {
    const out = collectServicePrincipalCandidates([
      rec('/ws/a', 'a', ` ${ID_A} `, 1), rec('/ws/b', 'b', ID_A, 2),
    ], '/ws/current')
    expect(out).toEqual([{ id: ID_A, projectNames: ['b', 'a'], updatedAtMs: 2 }])
  })
})

describe('collectServicePrincipalCandidates: 自分自身を除く・12文字でないものを除く', () => {
  it('現在のプロジェクト自身の記録は候補にしない（末尾の / があっても同じフォルダと見る）', () => {
    const records = [rec('/ws/current', 'current', ID_A, 900), rec('/ws/other', 'other', ID_B, 100)]
    expect(collectServicePrincipalCandidates(records, '/ws/current').map(c => c.id)).toEqual([ID_B])
    expect(collectServicePrincipalCandidates(records, '/ws/current/').map(c => c.id)).toEqual([ID_B])
    expect(collectServicePrincipalCandidates([rec('/ws/current/', 'current', ID_A, 9)], '/ws/current')).toEqual([])
  })

  it('自分と同じ ID を別のプロジェクトも使っていれば、その別のプロジェクトのぶんは候補に残る（自分のぶんだけ除く）', () => {
    const out = collectServicePrincipalCandidates([
      rec('/ws/current', 'current', ID_A, 900), rec('/ws/other', 'other', ID_A, 100),
    ], '/ws/current')
    expect(out).toEqual([{ id: ID_A, projectNames: ['other'], updatedAtMs: 100 }])
  })

  it('12桁の数字でないもの（短い・長い・空・空白だけ・12文字でも数字でない）は候補にしない。判定は resourceIdFormatOk と同じ', () => {
    const bad = ['', '   ', 'sp-1', '12345678901', '1234567890123', '11111111111a', 'abcdefghijkl']
    const out = collectServicePrincipalCandidates(
      [...bad.map((b, i) => rec(`/ws/bad${i}`, `bad${i}`, b, 10 + i)), rec('/ws/good', 'good', ID_A, 1)],
      '/ws/current',
    )
    expect(out.map(c => c.id)).toEqual([ID_A])
    for (const c of out) expect(resourceIdFormatOk(c.id)).toBe(true)
  })
})

describe('collectServicePrincipalCandidates: 壊れた記録でも落ちない（読むだけ・入力を信用しない）', () => {
  it('配列でない入力・空の配列は空', () => {
    expect(collectServicePrincipalCandidates(null, '/ws/c')).toEqual([])
    expect(collectServicePrincipalCandidates(undefined, '/ws/c')).toEqual([])
    expect(collectServicePrincipalCandidates({ projects: [] }, '/ws/c')).toEqual([])
    expect(collectServicePrincipalCandidates('x', '/ws/c')).toEqual([])
    expect(collectServicePrincipalCandidates([], '/ws/c')).toEqual([])
  })

  it('要素が null・文字列・数・配列／publish が無い・null・文字列・配列／apprunDedicated が壊れている／ID が文字列でない、は飛ばして、残りは拾う', () => {
    const out = collectServicePrincipalCandidates([
      null, undefined, 'x', 42, [], {},
      { dir: '/ws/a', name: 'a' }, // publish なし
      { dir: '/ws/b', name: 'b', publish: null },
      { dir: '/ws/c', name: 'c', publish: 'oops' },
      { dir: '/ws/d', name: 'd', publish: [] },
      { dir: '/ws/e', name: 'e', publish: { apprunDedicated: 'oops' } },
      { dir: '/ws/f', name: 'f', publish: { apprunDedicated: { servicePrincipalId: 123456789012 } } },
      { dir: '/ws/g', name: 'g', publish: { apprunDedicated: { servicePrincipalId: { id: ID_A } } } },
      { dir: 7, name: 7, publish: { apprunDedicated: { servicePrincipalId: ID_B } }, metaUpdatedAtMs: Number.NaN },
      rec('/ws/ok', 'ok', ID_A, 5),
    ], '/ws/current')
    expect(out.map(c => c.id).sort()).toEqual([ID_A, ID_B])
    const b = out.find(c => c.id === ID_B)!
    expect(b.updatedAtMs).toBeNull() // NaN は時刻として採らない
  })

  it('入力の配列・要素を書き換えない（読むだけ）', () => {
    const records = Object.freeze([
      Object.freeze(rec('/ws/a', 'a', ID_A, 2)),
      Object.freeze(rec('/ws/b', 'b', ID_A, 1)),
    ])
    expect(() => collectServicePrincipalCandidates(records, '/ws/c')).not.toThrow()
    expect(records[0].name).toBe('a')
  })
})

describe('formatProjectNames: 画面に並べる形', () => {
  it('3つまでは「・」でつなぎ、超えたら「ほかN件」', () => {
    expect(formatProjectNames(['a'])).toBe('a')
    expect(formatProjectNames(['a', 'b', 'c'])).toBe('a・b・c')
    expect(formatProjectNames(['a', 'b', 'c', 'd'])).toBe('a・b・cほか1件')
    expect(formatProjectNames(['a', 'b', 'c', 'd', 'e', 'f'])).toBe('a・b・cほか3件')
    expect(formatProjectNames(['a', 'b', 'c'], 2)).toBe('a・bほか1件')
  })
})

describe('planServicePrincipalPrefill / needsServicePrincipalCandidates: 記録に ID が無いときだけ出す・入れる', () => {
  const one: ServicePrincipalCandidate = { id: ID_A, projectNames: ['blog'], updatedAtMs: 2 }
  const two: ServicePrincipalCandidate = { id: ID_B, projectNames: ['shop'], updatedAtMs: 1 }

  it('記録に ID が無い（null・undefined・空・空白だけ）→ 探す。ある → 探さない', () => {
    for (const none of [null, undefined, '', '   ']) expect(needsServicePrincipalCandidates(none)).toBe(true)
    expect(needsServicePrincipalCandidates(ID_A)).toBe(false)
    expect(needsServicePrincipalCandidates('x')).toBe(false)
  })

  it('記録に ID があれば、候補があっても何も出さず・何も入れない（記録がこのプロジェクトの正）', () => {
    expect(planServicePrincipalPrefill(ID_C, [one, two])).toEqual({ candidates: [], fillId: null })
    expect(planServicePrincipalPrefill(ID_A, [one])).toEqual({ candidates: [], fillId: null })
  })

  it('候補が0 → 何も出さない（いまと同じ・欄は空のまま）', () => {
    expect(planServicePrincipalPrefill('', [])).toEqual({ candidates: [], fillId: null })
    expect(planServicePrincipalPrefill(null, [])).toEqual({ candidates: [], fillId: null })
  })

  it('候補が1 → その ID を入れる', () => {
    expect(planServicePrincipalPrefill('', [one])).toEqual({ candidates: [one], fillId: ID_A })
  })

  it('候補が複数 → 一覧を出し、既定は先頭（いちばん新しいもの）', () => {
    expect(planServicePrincipalPrefill(undefined, [one, two])).toEqual({ candidates: [one, two], fillId: ID_A })
  })
})

describe('画面に出す文', () => {
  it('候補が1つのとき: 前のプロジェクト名つきで「入れました。違うときは書き換えてください。」', () => {
    expect(singlePrefillNote({ id: ID_A, projectNames: ['Landingtest'], updatedAtMs: 1 }))
      .toBe('前のプロジェクト（Landingtest）で使った ID を入れました。違うときは書き換えてください。')
    expect(singlePrefillNote({ id: ID_A, projectNames: ['a', 'b'], updatedAtMs: 1 }))
      .toContain('前のプロジェクト（a・b）')
  })

  it('別のアカウント、または別のプロジェクトで作った ID は使えない、の一言がある（制約の単位は原本どおり「プロジェクト」）', () => {
    expect(ACCOUNT_MISMATCH_NOTE).toContain('別のさくらのアカウント、または別のプロジェクトで作った ID は使えません')
    expect(ACCOUNT_MISMATCH_NOTE).toContain('「プロジェクト」のリソースです')
    // 直す前の言い方（「アカウント」だけ）へ戻っていない
    expect(ACCOUNT_MISMATCH_NOTE).not.toContain('別のさくらのアカウントで作った ID は使えません')
  })
})

// ── renderer 側の入口（読むだけ）。fs:publishedRecords を呼ぶ io を偽物に差し替えて駆動する ───────────────
function fakeIo(projects: unknown, opts: { ok?: boolean; throwAt?: 'workspace' | 'records' } = {}) {
  const calls: { workspaceDir: number; records: string[] } = { workspaceDir: 0, records: [] }
  const io: CandidateIo = {
    workspaceDir: async () => {
      calls.workspaceDir++
      if (opts.throwAt === 'workspace') throw new Error('boom')
      return '/ws'
    },
    publishedRecords: async (dir) => {
      calls.records.push(dir)
      if (opts.throwAt === 'records') throw new Error('boom')
      return { ok: opts.ok ?? true, projects }
    },
  }
  return { io, calls }
}

describe('loadServicePrincipalCandidates: ワークスペースの全記録から、自分以外の候補を読む', () => {
  it('ワークスペースを fs:publishedRecords で読み、現在のプロジェクト自身を除いて新しい順に返す', async () => {
    const { io, calls } = fakeIo([
      rec('/ws/current', 'current', ID_C, 999),
      rec('/ws/a', 'a', ID_A, 100),
      rec('/ws/b', 'b', ID_B, 200),
    ])
    const out = await loadServicePrincipalCandidates('/ws/current', io)
    expect(out.map(c => c.id)).toEqual([ID_B, ID_A])
    expect(calls.records).toEqual(['/ws']) // 読んだのはワークスペース1回だけ
  })

  it('読めなかったとき（ok:false・例外）は候補なし（②の入力を止めない）', async () => {
    expect(await loadServicePrincipalCandidates('/ws/current', fakeIo([rec('/ws/a', 'a', ID_A)], { ok: false }).io)).toEqual([])
    expect(await loadServicePrincipalCandidates('/ws/current', fakeIo([], { throwAt: 'workspace' }).io)).toEqual([])
    expect(await loadServicePrincipalCandidates('/ws/current', fakeIo([], { throwAt: 'records' }).io)).toEqual([])
  })
})

describe('resolveServicePrincipalPrefill: ②を開いたときの判断（記録に ID が無いときだけ・読むだけ）', () => {
  const projects = [rec('/ws/a', 'a', ID_A, 100), rec('/ws/b', 'b', ID_B, 200)]

  it('このプロジェクトの記録に ID があれば、ほかの記録は読みにも行かず、何も出さない・何も入れない', async () => {
    const { io, calls } = fakeIo(projects)
    expect(await resolveServicePrincipalPrefill('/ws/current', ID_C, io)).toEqual({ candidates: [], fillId: null })
    expect(calls.workspaceDir).toBe(0)
    expect(calls.records).toEqual([])
  })

  it('記録に ID が無く、候補が1つ → その ID を入れる', async () => {
    const { io } = fakeIo([rec('/ws/a', 'a', ID_A, 100)])
    const plan = await resolveServicePrincipalPrefill('/ws/current', '', io)
    expect(plan.fillId).toBe(ID_A)
    expect(plan.candidates).toEqual([{ id: ID_A, projectNames: ['a'], updatedAtMs: 100 }])
  })

  it('記録に ID が無く、候補が複数 → 一覧を出し、既定は一番新しいもの', async () => {
    const { io } = fakeIo(projects)
    const plan = await resolveServicePrincipalPrefill('/ws/current', undefined, io)
    expect(plan.candidates.map(c => c.id)).toEqual([ID_B, ID_A])
    expect(plan.fillId).toBe(ID_B)
  })

  it('記録に ID が無く、候補が0（自分しか無い・読めない）→ いまと同じ（空）', async () => {
    expect(await resolveServicePrincipalPrefill('/ws/current', '', fakeIo([rec('/ws/current', 'current', ID_A)]).io))
      .toEqual({ candidates: [], fillId: null })
    expect(await resolveServicePrincipalPrefill('/ws/current', '', fakeIo([], { throwAt: 'records' }).io))
      .toEqual({ candidates: [], fillId: null })
  })

  it('io には「読む」口しか無い（書き込みの口を渡していない＝開いただけでは何も書けない）', () => {
    const { io } = fakeIo(projects)
    expect(Object.keys(io).sort()).toEqual(['publishedRecords', 'workspaceDir'])
  })
})
