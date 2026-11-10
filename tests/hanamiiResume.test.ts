import { describe, it, expect } from 'vitest'
import { createHanamiiResumer, hanamiiResumeCandidateOf, type HanamiiResumeDeps } from '../src/renderer/teardown/hanamiiResume'
import { isTeardownRecordOf, isHanamiiTeardownHandler } from '../src/renderer/teardown/watch'

// 自動の続きを呼ぶ部品（teardown/hanamiiResume.ts）の振る舞い。偽の口に流して、呼ばれた要求の一覧を見る（掟10）。
// 呼ぶ所3つの配線は tests/hanamiiResumeWiring.test.ts。

const mark = (projectId: string, over: Record<string, unknown> = {}) => ({
  projectId, acceptedAt: '2026-11-09T01:00:00.000Z', shownPlacements: [{ bucket: 'b1', prefix: 'p1' }], requiresReview: false, ...over,
})
const publishOf = (projectId: string | null, m: unknown, tokenId: string | null = 'tok-1') => ({
  hanamii: { ...(projectId ? { projectId } : {}), ...(tokenId ? { tokenId } : {}), ...(m ? { deletionAccepted: m } : {}) },
})

function fake(over: Partial<HanamiiResumeDeps> & { projects?: Array<{ dir: string; publish: unknown }>; tokens?: Record<string, string | null> } = {}) {
  const calls: Array<{ dir: string; token: string; projectId: string }> = []
  const tokenReads: Array<string | null> = []
  const deps: HanamiiResumeDeps = {
    readWorkspace: async () => over.projects ?? [],
    readProject: async () => null,
    loadToken: async id => { tokenReads.push(id); return over.tokens ? (over.tokens[id ?? ''] ?? null) : 'T' },
    resume: async (dir, auth, opts) => { calls.push({ dir, token: auth.token, projectId: opts.projectId }); return { ok: true } },
    ...over,
  }
  return { deps, calls, tokenReads }
}

describe('hanamiiResumeCandidateOf: 印があり、projectId が合うときだけ', () => {
  it('印あり・projectId 一致 → 対象（tokenId は記録のもの）', () => {
    expect(hanamiiResumeCandidateOf('/w/a', publishOf('P1', mark('P1'), 'tok-9'))).toEqual({ projectDir: '/w/a', projectId: 'P1', tokenId: 'tok-9' })
  })
  it('印なし・projectId 違い・projectId なし・壊れた印は null', () => {
    expect(hanamiiResumeCandidateOf('/w/a', publishOf('P1', null))).toBeNull()
    expect(hanamiiResumeCandidateOf('/w/a', publishOf('P1', mark('P2')))).toBeNull()
    expect(hanamiiResumeCandidateOf('/w/a', publishOf(null, mark('P1')))).toBeNull()
    expect(hanamiiResumeCandidateOf('/w/a', publishOf('P1', { projectId: 'P1' }))).toBeNull()
    expect(hanamiiResumeCandidateOf('/w/a', null)).toBeNull()
    expect(hanamiiResumeCandidateOf('/w/a', 'x')).toBeNull()
  })
  it('★★★ tokenId が記録に無い旧い記録は対象にしない（使用中・先頭のトークンへ倒れて、別のアカウントで「見えない」を「消えた」と読ませない）', () => {
    expect(hanamiiResumeCandidateOf('/w/a', publishOf('P1', mark('P1'), null))).toBeNull()
  })
})

describe('resumeIn: 印のあるプロジェクトだけを、順に1件ずつ呼ぶ', () => {
  it('印のあるものだけ呼ぶ。トークンは記録の tokenId で読み、渡す', async () => {
    const { deps, calls, tokenReads } = fake({
      projects: [
        { dir: '/w/a', publish: publishOf('PA', mark('PA'), 'tok-a') },
        { dir: '/w/b', publish: publishOf('PB', null) },
        { dir: '/w/c', publish: publishOf('PC', mark('OTHER')) },
        { dir: '/w/d', publish: publishOf('PD', mark('PD'), 'tok-d') },
      ],
      tokens: { 'tok-a': 'TOKEN-A', 'tok-d': 'TOKEN-D' },
    })
    const called = await createHanamiiResumer(deps).resumeIn('/w')
    expect(called).toEqual(['/w/a', '/w/d'])
    expect(calls).toEqual([
      { dir: '/w/a', token: 'TOKEN-A', projectId: 'PA' },
      { dir: '/w/d', token: 'TOKEN-D', projectId: 'PD' },
    ])
    expect(tokenReads).toEqual(['tok-a', 'tok-d'])
  })

  it('順に呼ぶ（前の続きが終わるまで次を呼ばない）', async () => {
    const log: string[] = []
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const { deps } = fake({
      projects: [{ dir: '/w/a', publish: publishOf('PA', mark('PA')) }, { dir: '/w/b', publish: publishOf('PB', mark('PB')) }],
      resume: async dir => { log.push(`start ${dir}`); if (dir === '/w/a') await gate; log.push(`end ${dir}`); return {} },
    })
    const p = createHanamiiResumer(deps).resumeIn('/w')
    await new Promise(r => setTimeout(r, 5))
    expect(log).toEqual(['start /w/a'])
    release()
    await p
    expect(log).toEqual(['start /w/a', 'end /w/a', 'start /w/b', 'end /w/b'])
  })

  it('★★★ tokenId の無い旧い記録は、トークンも読まず、resume も呼ばない（使用中のトークンへ倒れない）。resumeProject の入口も同じ', async () => {
    const legacy = publishOf('PA', mark('PA'), null)
    const { deps, calls, tokenReads } = fake({
      projects: [{ dir: '/w/a', publish: legacy }],
      readProject: async () => ({ publish: legacy }),
      loadToken: async id => { tokenReads.push(id); return 'tok-B' }, // 本物の loadHanamiiToken は null のとき使用中のトークンを返す
    })
    const r = createHanamiiResumer(deps)
    expect(await r.resumeIn('/w')).toEqual([])
    expect(await r.resumeProject('/w/a')).toBe(false)
    expect(calls).toEqual([])
    expect(tokenReads).toEqual([])
  })

  it('トークンが見つからなければ呼ばない（ほかのプロジェクトは続ける）', async () => {
    const { deps, calls } = fake({
      projects: [{ dir: '/w/a', publish: publishOf('PA', mark('PA'), 'gone') }, { dir: '/w/b', publish: publishOf('PB', mark('PB'), 'tok-b') }],
      tokens: { 'tok-b': 'TB' },
    })
    expect(await createHanamiiResumer(deps).resumeIn('/w')).toEqual(['/w/b'])
    expect(calls.map(c => c.dir)).toEqual(['/w/b'])
  })

  it('同じプロジェクトで続きが走っている間は、二重に呼ばない（作業場所・プロジェクトのどちらの入口でも）', async () => {
    let n = 0
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const publish = publishOf('PA', mark('PA'))
    const { deps } = fake({
      projects: [{ dir: '/w/a', publish }],
      readProject: async () => ({ publish }),
      resume: async () => { n++; await gate; return {} },
    })
    const r = createHanamiiResumer(deps)
    const first = r.resumeIn('/w')
    await new Promise(x => setTimeout(x, 5))
    expect(await r.resumeProject('/w/a/')).toBe(false) // 末尾の / が違っても同じプロジェクト
    expect(await r.resumeIn('/w')).toEqual([])
    release()
    await first
    expect(n).toBe(1)
    // 終わったあとは、また呼べる
    expect(await r.resumeProject('/w/a')).toBe(true)
    expect(n).toBe(2)
  })

  it('main が投げても、続けて次を呼び、自分は投げない', async () => {
    const { deps, calls } = fake({
      projects: [{ dir: '/w/a', publish: publishOf('PA', mark('PA')) }, { dir: '/w/b', publish: publishOf('PB', mark('PB')) }],
      resume: async (dir, auth, opts) => { calls.push({ dir, token: auth.token, projectId: opts.projectId }); if (dir === '/w/a') throw new Error('boom'); return {} },
    })
    expect(await createHanamiiResumer(deps).resumeIn('/w')).toEqual(['/w/b'])
  })

  it('作業場所を読めなければ何も呼ばず、投げない', async () => {
    const { deps, calls } = fake({ readWorkspace: async () => { throw new Error('x') } })
    expect(await createHanamiiResumer(deps).resumeIn('/w')).toEqual([])
    expect(calls).toEqual([])
  })
})

describe('resumeProject: そのプロジェクトだけ', () => {
  it('印があれば呼ぶ・無ければ呼ばない・読めなければ呼ばない', async () => {
    const m = fake({ readProject: async () => ({ publish: publishOf('PA', mark('PA')) }) })
    expect(await createHanamiiResumer(m.deps).resumeProject('/w/a')).toBe(true)
    expect(m.calls).toEqual([{ dir: '/w/a', token: 'T', projectId: 'PA' }])
    const n = fake({ readProject: async () => ({ publish: publishOf('PA', null) }) })
    expect(await createHanamiiResumer(n.deps).resumeProject('/w/a')).toBe(false)
    expect(n.calls).toEqual([])
    const u = fake({ readProject: async () => { throw new Error('unreadable') } })
    expect(await createHanamiiResumer(u.deps).resumeProject('/w/a')).toBe(false)
    expect(u.calls).toEqual([])
  })
})

describe('続きの記録は、最初の破棄と同じ HANAMII の破棄として読まれる', () => {
  it('isTeardownRecordOf・isHanamiiTeardownHandler は resumeTeardown も HANAMII の破棄と言う（別の公開先・別の名前は言わない）', () => {
    expect(isTeardownRecordOf('hanamii', { target: 'hanamii', handler: 'hanamii:resumeTeardown' })).toBe(true)
    expect(isTeardownRecordOf('sakura-apprun', { target: 'sakura-apprun', handler: 'hanamii:resumeTeardown' })).toBe(false)
    expect(isTeardownRecordOf('hanamii', { target: 'vercel', handler: 'hanamii:resumeTeardown' })).toBe(false)
    expect(isTeardownRecordOf('hanamii', { target: 'hanamii', handler: 'hanamii:publish' })).toBe(false)
    expect(isHanamiiTeardownHandler('hanamii:teardown')).toBe(true)
    expect(isHanamiiTeardownHandler('hanamii:resumeTeardown')).toBe(true)
    expect(isHanamiiTeardownHandler('hanamii:publish')).toBe(false)
    expect(isHanamiiTeardownHandler(undefined)).toBe(false)
  })
})
