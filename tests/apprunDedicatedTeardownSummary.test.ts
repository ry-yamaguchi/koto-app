import { describe, it, expect } from 'vitest'
import { buildTeardownSummary, priceSummary } from '../src/renderer/components/AppRunDedicatedPanel'

// 3b（委譲仕様 #38）: ⑥「作ったものを壊す（破棄）」のリソースID一覧の上に出す
// 「いまの構成と月額目安」を組み立てる純関数 buildTeardownSummary を固定する
// （利用者目線レビュー・判断不要）。月額は既存の priceSummary(...) の text をそのまま使う
// （計算を複製しない・掟10）。記録にプランの path が無い旧データのときは金額行を省く
// （推測で埋めない）。

const WORKER_PLANS = [
  { name: 'AppRun専有型 ワーカ 1vCPU / 2GBメモリ', nodeCount: null, path: 'cloud/apprun/dedicated/worker/1vcpu_2gb' },
  { name: 'AppRun専有型 ワーカ 2vCPU / 2GBメモリ', nodeCount: null, path: 'cloud/apprun/dedicated/worker/2vcpu_2gb' },
]
const LB_PLANS = [
  { name: 'AppRun専有型 ロードバランサ 1vCPU / 2GBメモリ（非冗長構成）', nodeCount: 1, path: 'cloud/apprun/dedicated/lb/1vcpu_2gb_1' },
]

describe('buildTeardownSummary: 名前・ゾーン・プラン名・作成日時・月額目安の行を組み立てる', () => {
  it('プラン一覧・記録がすべて揃っているとき、5行（名前・ゾーン・ワーカ・LB・作成日時）＋月額目安が入る', () => {
    const record = {
      name: 'myapp', zone: 'tk1a',
      workerServiceClassPath: 'cloud/apprun/dedicated/worker/1vcpu_2gb',
      lbServiceClassPath: 'cloud/apprun/dedicated/lb/1vcpu_2gb_1',
      createdAt: '2026-09-10T12:00:00.000Z',
    }
    const { lines } = buildTeardownSummary(record, { worker: WORKER_PLANS, lb: LB_PLANS })
    expect(lines[0]).toBe('名前: myapp')
    expect(lines[1]).toBe('ゾーン: tk1a')
    expect(lines[2]).toBe('ワーカプラン: AppRun専有型 ワーカ 1vCPU / 2GBメモリ')
    expect(lines[3]).toBe('ロードバランサプラン: AppRun専有型 ロードバランサ 1vCPU / 2GBメモリ（非冗長構成）')
    expect(lines[4]).toBe(`作成日時: ${new Date(record.createdAt).toLocaleString('ja-JP')}`)
    expect(lines.length).toBe(6)
  })

  // ★ 完了条件の核心その1: path が無ければ金額行が無い（推測で埋めない）。
  it('workerServiceClassPath が無ければ金額行が無い（5行のまま）', () => {
    const record = {
      name: 'myapp', zone: 'tk1a',
      workerServiceClassPath: null,
      lbServiceClassPath: 'cloud/apprun/dedicated/lb/1vcpu_2gb_1',
      createdAt: '2026-09-10T12:00:00.000Z',
    }
    const { lines } = buildTeardownSummary(record, { worker: WORKER_PLANS, lb: LB_PLANS })
    expect(lines.length).toBe(5)
    expect(lines.some(l => l.startsWith('月額目安'))).toBe(false)
  })

  it('lbServiceClassPath が無ければ金額行が無い（5行のまま）', () => {
    const record = {
      name: 'myapp', zone: 'tk1a',
      workerServiceClassPath: 'cloud/apprun/dedicated/worker/1vcpu_2gb',
      lbServiceClassPath: undefined,
      createdAt: '2026-09-10T12:00:00.000Z',
    }
    const { lines } = buildTeardownSummary(record, { worker: WORKER_PLANS, lb: LB_PLANS })
    expect(lines.length).toBe(5)
    expect(lines.some(l => l.startsWith('月額目安'))).toBe(false)
  })

  it('記録が空（旧データ・null）なら、両方の path が無いので金額行も無く、他は「不明」で埋まる', () => {
    const { lines } = buildTeardownSummary(null, null)
    expect(lines).toEqual([
      '名前: 不明', 'ゾーン: 不明', 'ワーカプラン: 不明', 'ロードバランサプラン: 不明', '作成日時: 不明',
    ])
  })

  // ★ 完了条件の核心その2: path が両方あれば priceSummary の text がそのまま入る（計算を複製しない）。
  it('path が両方あれば、priceSummary(...).text がそのまま月額目安に入る', () => {
    const record = {
      name: 'myapp', zone: 'tk1a',
      workerServiceClassPath: 'cloud/apprun/dedicated/worker/1vcpu_2gb',
      lbServiceClassPath: 'cloud/apprun/dedicated/lb/1vcpu_2gb_1',
      createdAt: '2026-09-10T12:00:00.000Z',
    }
    const { lines } = buildTeardownSummary(record, { worker: WORKER_PLANS, lb: LB_PLANS })
    const expected = priceSummary(
      { path: record.workerServiceClassPath },
      { path: record.lbServiceClassPath, nodeCount: 1 },
      1,
    )
    expect(lines[5]).toBe(`月額目安: ${expected.text}`)
    expect(expected.text).not.toContain('出せません')
  })

  it('プラン一覧が未取得（null）なら、プラン名は path をそのまま表示する（推測で名前を作らない）', () => {
    const record = {
      name: 'myapp', zone: 'tk1a',
      workerServiceClassPath: 'cloud/apprun/dedicated/worker/1vcpu_2gb',
      lbServiceClassPath: 'cloud/apprun/dedicated/lb/1vcpu_2gb_1',
      createdAt: '2026-09-10T12:00:00.000Z',
    }
    const { lines } = buildTeardownSummary(record, { worker: null, lb: null })
    expect(lines[2]).toBe('ワーカプラン: cloud/apprun/dedicated/worker/1vcpu_2gb')
    expect(lines[3]).toBe('ロードバランサプラン: cloud/apprun/dedicated/lb/1vcpu_2gb_1')
    // プラン名が引けなくても、path が両方あれば月額目安は出す（priceSummary は path だけで計算できる）。
    expect(lines.some(l => l.startsWith('月額目安'))).toBe(true)
  })

  it('プラン一覧はあるが、一致するプランが無いとき（旧いプランpath等）も path をそのまま表示する', () => {
    const record = {
      name: 'myapp', zone: 'tk1a',
      workerServiceClassPath: 'cloud/apprun/dedicated/worker/16vcpu_64gb',
      lbServiceClassPath: 'cloud/apprun/dedicated/lb/16vcpu_64gb_1',
      createdAt: '2026-09-10T12:00:00.000Z',
    }
    const { lines } = buildTeardownSummary(record, { worker: WORKER_PLANS, lb: LB_PLANS })
    expect(lines[2]).toBe('ワーカプラン: cloud/apprun/dedicated/worker/16vcpu_64gb')
    expect(lines[3]).toBe('ロードバランサプラン: cloud/apprun/dedicated/lb/16vcpu_64gb_1')
    // 料金表に無いプランなので、priceSummary は「月額を出せません」——それでも行自体は出す
    // （path は両方あるため。金額を捏造しないのは priceSummary 側の責務）。
    expect(lines[4 + 1]).toContain('月額目安')
    expect(lines[4 + 1]).toContain('出せません')
  })

  it('作成日時（createdAt）が無ければ「不明」', () => {
    const record = { name: 'myapp', zone: 'tk1a', workerServiceClassPath: null, lbServiceClassPath: null, createdAt: null }
    const { lines } = buildTeardownSummary(record, null)
    expect(lines[4]).toBe('作成日時: 不明')
  })
})
