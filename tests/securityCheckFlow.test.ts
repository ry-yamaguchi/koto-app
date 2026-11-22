import { describe, it, expect } from 'vitest'
import { createRunGate, runScanFlow, runAiFlow, makeEstimate } from '../src/renderer/securityCheckFlow'
import type { AiEstimate, EstimatePlan, EstimateBudget } from '../src/renderer/aiCheckEstimate'
import type { PublishScanOutcome } from '../src/renderer/publishScanRun'
import type { SecurityCheckResult } from '../src/renderer/securityCheck'

// 押したときの流れを、偽の関数を渡して固定する（お金の歯止めは振る舞いで確かめる）。
// 送る口（runSecurityCheck の役）が呼ばれた回数を数える。

const PLAN: EstimatePlan = { files: 3, promptChars: 1200, requests: 1, skipped: [], partial: [], nothing: false }
const OK_BUDGET: EstimateBudget = { allowed: true }
const OUTCOME: PublishScanOutcome = { view: { verdict: 'ok', lines: [] }, fixItems: [] }
const OK_RESULT: SecurityCheckResult = { verdict: 'ok', report: 'ok' }
const SENDABLE: AiEstimate = { state: 'made', plan: PLAN, budget: OK_BUDGET }

function scanArgs(over: Partial<{ apiKey: string; plan: () => Promise<EstimatePlan>; budget: () => EstimateBudget; current: (d: string) => boolean }> = {}) {
  const log = { sends: 0, scans: [] as PublishScanOutcome[], estimates: [] as AiEstimate[], finished: 0 }
  const args = {
    projectDir: '/p',
    apiKey: over.apiKey ?? 'key-1',
    gate: createRunGate(),
    isCurrent: over.current ?? (() => true),
    deps: {
      runScan: async () => OUTCOME,
      planAiCheck: over.plan ?? (async () => PLAN),
      aiCheckBudget: over.budget ?? (() => OK_BUDGET),
      // 渡しても使われない。呼ばれたら数える
      runSecurityCheck: async () => { log.sends++; return OK_RESULT },
    },
    on: {
      start: () => {},
      scan: (o: PublishScanOutcome) => { log.scans.push(o) },
      estimate: (e: AiEstimate) => { log.estimates.push(e) },
      finish: () => { log.finished++ },
    },
  }
  return { args, log }
}

function aiArgs(estimate: AiEstimate | null, over: Partial<{ apiKey: string; run: () => Promise<SecurityCheckResult>; current: (d: string) => boolean; gate: ReturnType<typeof createRunGate> }> = {}) {
  const log = { sends: 0, results: [] as SecurityCheckResult[], records: [] as unknown[], placedRecords: [] as unknown[], finished: 0 }
  const args = {
    projectDir: '/p',
    apiKey: over.apiKey ?? 'key-1',
    estimate,
    gate: over.gate ?? createRunGate(),
    isCurrent: over.current ?? (() => true),
    deps: {
      runSecurityCheck: async () => { log.sends++; return over.run ? over.run() : OK_RESULT },
      writeRecord: (_d: string, rec: unknown) => { log.records.push(rec) },
    },
    on: {
      start: () => {},
      progress: () => {},
      abortReady: () => {},
      result: (r: SecurityCheckResult, rec: unknown) => { log.results.push(r); log.placedRecords.push(rec) },
      finish: () => { log.finished++ },
    },
  }
  return { args, log }
}

describe('【ファイルを点検する】の流れ', () => {
  it('キーがあっても、送る口は0回。見積りだけ作る', async () => {
    const { args, log } = scanArgs()
    expect(await runScanFlow(args)).toBe('done')
    expect(log.sends).toBe(0)
    expect(log.scans).toEqual([OUTCOME])
    expect(log.estimates).toHaveLength(1)
    expect(log.estimates[0].state).toBe('made')
  })
  it('上限で止める・送るものが無い・計画が例外、のどれでも送る口は0回（見積りは作る）', async () => {
    for (const over of [
      { budget: () => ({ allowed: false as const, message: '上限' }) },
      { plan: async () => ({ ...PLAN, nothing: true }) },
      { plan: async () => { throw new Error('boom') } },
    ]) {
      const { args, log } = scanArgs(over)
      await runScanFlow(args)
      expect(log.sends).toBe(0)
      expect(log.estimates).toHaveLength(1)
    }
  })
  it('計画を読んでいる間にプロジェクトが変わったら、見積りを置かない', async () => {
    let calls = 0
    // 点検の結果を置く確かめと計画を読む前の確かめは真、計画を読んだあとの確かめは偽
    const { args, log } = scanArgs({ current: () => ++calls <= 2 })
    await runScanFlow(args)
    expect(log.scans).toHaveLength(1)
    expect(log.estimates).toEqual([])
    expect(log.sends).toBe(0)
  })
  it('点検が済んだあとにプロジェクトが変わったら、計画を読み始めない', async () => {
    let calls = 0
    let planned = 0
    const { args, log } = scanArgs({ current: () => ++calls <= 1, plan: async () => { planned++; return PLAN } })
    await runScanFlow(args)
    expect(log.scans).toHaveLength(1)
    expect(planned).toBe(0)
    expect(log.estimates).toEqual([])
  })
  it('キーが無いときは見積りを作らず、計画も読まない', async () => {
    let planned = 0
    const { args, log } = scanArgs({ apiKey: '', plan: async () => { planned++; return PLAN } })
    await runScanFlow(args)
    expect(planned).toBe(0)
    expect(log.estimates).toEqual([])
    expect(log.sends).toBe(0)
  })
  it('点検が失敗しても、送る口は0回で、失敗はそのまま伝わり、札は戻る', async () => {
    const { args, log } = scanArgs()
    const err = new Error('scan failed')
    args.deps.runScan = async () => { throw err }
    await expect(runScanFlow(args)).rejects.toBe(err)
    expect(log.sends).toBe(0)
    expect(log.finished).toBe(1)
    expect(args.gate.busy).toBe(false)
  })
  it('押した時点のプロジェクトのままのときだけ、結果と見積りを置く', async () => {
    const { args, log } = scanArgs({ current: () => false })
    await runScanFlow(args)
    expect(log.scans).toEqual([])
    expect(log.estimates).toEqual([])
    expect(log.sends).toBe(0)
  })
  it('走っている間に押し直しても、2回目は何もしない', async () => {
    let release: () => void = () => {}
    const { args, log } = scanArgs()
    let scans = 0
    args.deps.runScan = () => { scans++; return new Promise<PublishScanOutcome>(r => { release = () => r(OUTCOME) }) }
    const first = runScanFlow(args)
    expect(await runScanFlow(args)).toBe('busy')
    release()
    await first
    expect(scans).toBe(1)
  })
})

describe('【AIに確認してもらう】の流れ', () => {
  it('見積りが「送れる」ときだけ、送る口を1回呼ぶ', async () => {
    const { args, log } = aiArgs(SENDABLE)
    expect(await runAiFlow(args)).toBe('sent')
    expect(log.sends).toBe(1)
    expect(log.results).toEqual([OK_RESULT])
  })
  it('上限で止める・送るものが無い・見積りを作れなかった・見積りが無い・キーが無い、のどれでも0回', async () => {
    const cases: [string, AiEstimate | null, string?][] = [
      ['上限', { state: 'made', plan: PLAN, budget: { allowed: false, message: '上限' } }],
      ['上限で message 無し', { state: 'made', plan: PLAN, budget: { allowed: false } }],
      ['送るものが無い', { state: 'made', plan: { ...PLAN, nothing: true }, budget: OK_BUDGET }],
      ['見積りを作れなかった', { state: 'failed', failure: 'x' }],
      ['見積りが無い', null],
      ['キーが無い', SENDABLE, ''],
    ]
    for (const [, est, key] of cases) {
      const { args, log } = aiArgs(est, key === undefined ? {} : { apiKey: key })
      await runAiFlow(args)
      expect(log.sends).toBe(0)
      expect(log.results).toEqual([])
      expect(args.gate.busy).toBe(false)
    }
  })
  it('警告つきの見積りは送れる', async () => {
    const { args, log } = aiArgs({ state: 'made', plan: PLAN, budget: { allowed: true, warning: '残りわずか' } })
    await runAiFlow(args)
    expect(log.sends).toBe(1)
  })
  it('走っている間に押し直しても、送る口は1回だけ', async () => {
    let release: () => void = () => {}
    const gate = createRunGate()
    const { args, log } = aiArgs(SENDABLE, { gate, run: () => new Promise<SecurityCheckResult>(r => { release = () => r(OK_RESULT) }) })
    const first = runAiFlow(args)
    const second = await runAiFlow(args)
    expect(second).toBe('busy')
    expect(log.sends).toBe(1)
    release()
    await first
    expect(log.sends).toBe(1)
    // 終わったあとは、また押せる
    release = () => {}
    const again = aiArgs(SENDABLE, { gate })
    expect(await runAiFlow(again.args)).toBe('sent')
  })
  it('点検が走っている間（札が塞がっている間）は、送る口を呼ばない', async () => {
    const gate = createRunGate()
    expect(gate.tryEnter()).toBe(true)
    const { args, log } = aiArgs(SENDABLE, { gate })
    expect(await runAiFlow(args)).toBe('busy')
    expect(log.sends).toBe(0)
  })
  it('結果を置く関数は、押した時点のプロジェクトのままのときだけ呼ばれる。記録は押した時点の鍵へ書く', async () => {
    const stale = aiArgs(SENDABLE, { current: () => false })
    await runAiFlow(stale.args)
    expect(stale.log.sends).toBe(1)
    expect(stale.log.results).toEqual([])
    expect(stale.log.records).toHaveLength(1)
    const fresh = aiArgs(SENDABLE)
    await runAiFlow(fresh.args)
    expect(fresh.log.results).toHaveLength(1)
    expect(fresh.log.placedRecords[0]).toMatchObject({ verdict: 'ok' })
  })
  it('実施できなかった（skip）ときは記録しない', async () => {
    const { args, log } = aiArgs(SENDABLE, { run: async () => ({ verdict: 'skip', report: 'x' }) })
    await runAiFlow(args)
    expect(log.records).toEqual([])
    expect(log.placedRecords).toEqual([null])
  })
  it('送る口が例外で終わっても、黙って消えない: 実施できなかった結果を置き、記録せず、札は戻る', async () => {
    const { args, log } = aiArgs(SENDABLE, { run: async () => { throw new Error('ai failed') } })
    await expect(runAiFlow(args)).resolves.toBe('sent')
    expect(log.results).toHaveLength(1)
    expect(log.results[0].verdict).toBe('skip')
    expect(log.results[0].report).toContain('ai failed')
    expect(log.records).toEqual([])
    expect(log.placedRecords).toEqual([null])
    expect(log.finished).toBe(1)
    expect(args.gate.busy).toBe(false)
  })
  it('送る口が例外で終わった回も、プロジェクトが変わっていたら結果を置かない', async () => {
    const { args, log } = aiArgs(SENDABLE, { run: async () => { throw new Error('ai failed') }, current: () => false })
    await expect(runAiFlow(args)).resolves.toBe('sent')
    expect(log.results).toEqual([])
    expect(args.gate.busy).toBe(false)
  })
})

describe('見積りを作る段', () => {
  it('利用量の確かめが止めるなら、計画の中身によらずボタンを出さない', async () => {
    const plans: EstimatePlan[] = [
      PLAN,
      { ...PLAN, files: 0, promptChars: 0, requests: 0, nothing: true },
      { ...PLAN, requests: 5, skipped: ['a.js'] },
    ]
    for (const p of plans) {
      const est = await makeEstimate('/p', 'k', { planAiCheck: async () => p, aiCheckBudget: () => ({ allowed: false, message: '止める' }) })
      const { args, log } = aiArgs(est)
      await runAiFlow(args)
      expect(log.sends).toBe(0)
    }
  })
  it('計画が例外でも、止める設定でも、例外を投げず送らない見積りになる', async () => {
    const est = await makeEstimate('/p', 'k', { planAiCheck: async () => { throw new Error('x') }, aiCheckBudget: () => ({ allowed: false }) })
    expect(est.state).toBe('failed')
  })
})

describe('点検の結果から修正の項目を作る口', () => {
  const g = globalThis as unknown as { window?: unknown }
  it('publish の点検の指摘（行のあるもの）が項目になり、名前だけのものは入らない', async () => {
    const { runPublishScanResult } = await import('../src/renderer/publishScanRun')
    const done = {
      state: 'done', scope: 'publish', mode: 'static', listed: 2, scanned: 2, findingsTotal: 2,
      findings: [
        { kind: 'known-key', severity: 'now', file: 'a.js', line: 3 },
        { kind: 'secret-name', severity: 'now', file: '.env' },
      ],
      notScanned: { tooLarge: [], tooLargeCount: 0, unreadable: [], unreadableCount: 0, binary: [], binaryCount: 0, sample: [], sampleCount: 0, longLine: [], longLineCount: 0, overTotal: [], overTotalCount: 0, listTruncated: false },
    }
    g.window = { electronAPI: { publishScan: { run: async () => done } } }
    try {
      const r = await runPublishScanResult('/p', 'publish')
      expect(r.fixItems).toEqual([{ file: 'a.js', line: 3, kind: 'known-key' }])
      g.window = { electronAPI: { publishScan: { run: async () => { throw new Error('x') } } } }
      const f = await runPublishScanResult('/p', 'publish')
      expect(f.fixItems).toEqual([])
      expect(f.view.verdict).toBe('skip')
    } finally { delete g.window }
  })
})
