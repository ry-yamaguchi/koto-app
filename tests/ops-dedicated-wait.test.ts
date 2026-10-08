import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import type { Server } from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { teardownFlow, deleteWaitProgressMessage } from '../src/main/cloud/apprunDedicatedApply'
import { LB_DELETE_MEASURED_MINUTES, LB_ADDRESS_EMPTY_AFTER_MINUTES, lbDeleteEstimateNote, lbAddressEstimateNote } from '../src/main/cloud/apprunDedicated'
import { writeApprunDedicatedRecordFs } from '../src/main/publishMetaFs'

// ── ロードバランサを待つ画面に、実測にもとづく目安を出す（2026-09-29・作者の決定）─────────────────────
//
// 実測（docs/apprun-dedicated-plan.md）:
//   ・削除: ロードバランサの DELETE は 204 でも一覧に deleting:true で残り、消えるまでおよそ9分（5-11）
//   ・IP: クラスタを作った約2分後は LB のアドレスが空で、数分後に付く（5-13）
// 進み具合の文に添える。**根拠の範囲を越えない**（2026-09-30 検分の指摘4）: 実測は1〜2回なので、「実測では〜でした」と
// 起きたことを言う。「ふつう〜かかります」と一般化して言い切らない。**測っていない資源（ASG・クラスタ）には付けない**。
// 目安の数字は apprunDedicated.ts の1か所（LB_DELETE_MEASURED_MINUTES）。

let server: Server | null = null
afterEach(() => { if (server) { server.close(); server = null } })
function listen(handler: http.RequestListener): Promise<string> {
  return new Promise((resolve, reject) => {
    server = http.createServer(handler)
    server.listen(0, () => {
      const addr = server?.address()
      if (addr && typeof addr === 'object') resolve(`http://127.0.0.1:${addr.port}/`)
      else reject(new Error('サーバのポートを取得できませんでした'))
    })
  })
}
let projectDir = ''
beforeEach(() => { projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-ops-dedicated-wait-')) })
afterEach(() => { fs.rmSync(projectDir, { recursive: true, force: true }) })
const AUTH = { token: 'tok', secret: 'sec' }
const ESTIMATE = '実測ではおよそ9分でした（目安です）'

/**
 * LB・ASG・クラスタが、それぞれ `polls` 回の一覧のあいだ deleting:true で残り、そのあと消える偽サーバ。
 * teardownFlow の待ちは「回した回数 × 5秒」で数えるので、sleep を即時の偽物にすれば1ミリ秒も待たずに進む。
 */
async function runTeardown(polls: { lb: number; asg: number; cluster: number }) {
  writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })
  const n = { lb: 0, asg: 0, cluster: 0 }
  const baseUrl = await listen((req, res) => {
    const key = `${req.method} ${req.url}`
    const send = (status: number, body: unknown) => {
      if (status === 204) { res.writeHead(204); res.end(); return }
      res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
    }
    if (key === 'DELETE /clusters/c1/asg/a1/load_balancers/l1') return send(204, {})
    if (key === 'GET /clusters/c1/asg/a1/load_balancers?maxItems=20') {
      n.lb++
      return send(200, { loadBalancers: n.lb <= polls.lb ? [{ loadBalancerID: 'l1', name: 'myapp', deleting: true, created: 1, serviceClassPath: 'x' }] : [] })
    }
    if (key === 'DELETE /clusters/c1/asg/a1') return send(204, {})
    if (key === 'GET /clusters/c1/asg?maxItems=20') {
      n.asg++
      return send(200, { autoScalingGroups: n.asg <= polls.asg ? [{ autoScalingGroupID: 'a1', name: 'myapp', created: 1 }] : [] })
    }
    if (key === 'DELETE /clusters/c1') return send(204, {})
    if (key === 'GET /clusters?maxItems=20') {
      n.cluster++
      return send(200, { clusters: n.cluster <= polls.cluster ? [{ clusterID: 'c1', name: 'myapp', created: 1 }] : [] })
    }
    send(404, { error: `test router: 未定義のルート ${key}` })
  })
  const progress: string[] = []
  const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep: async () => {}, progress: m => progress.push(m) }, baseUrl)
  return { r, progress }
}

describe('★★★ ⑥のロードバランサ削除待ち: 実測にもとづく目安が進み具合の文に出る', () => {
  it('待ち始めの一文と、30秒ごとの経過つきの文の両方に、目安（およそ9分）が付く', async () => {
    const { r, progress } = await runTeardown({ lb: 13, asg: 0, cluster: 0 }) // 13回の一覧＝65秒待つ（30秒・60秒で経過の文が出る）
    expect(r.ok).toBe(true)
    const lb = progress.filter(m => m.startsWith('ロードバランサの削除を待っています'))
    expect(lb[0]).toBe(`ロードバランサの削除を待っています。${ESTIMATE}。`)
    expect(lb.slice(1)).toEqual([
      `ロードバランサの削除を待っています（1分経過）。${ESTIMATE}。`, // 30秒
      `ロードバランサの削除を待っています（1分経過）。${ESTIMATE}。`, // 60秒
    ])
    for (const m of lb) expect(m).toContain(ESTIMATE)
  })

  it('★★★ 根拠の範囲を越えない: 「実測では〜でした」と起きたことを言う。「ふつう」と一般化せず、「かかります」と約束しない', async () => {
    const { progress } = await runTeardown({ lb: 8, asg: 0, cluster: 0 })
    const lb = progress.filter(m => m.startsWith('ロードバランサの削除を待っています'))
    expect(lb.length).toBeGreaterThan(0)
    for (const m of lb) {
      expect(m).toMatch(/実測ではおよそ\d+分でした（目安です）/)
      expect(m, '1〜2回の観測を「ふつう」と一般化している').not.toContain('ふつう')
      expect(m, '「かかります」と言い切っている').not.toMatch(/かかります/)
    }
  })

  it('★★ 測っていない資源（ASG・クラスタ）には目安を付けない（確かめていないことを断定しない）', async () => {
    const { r, progress } = await runTeardown({ lb: 0, asg: 8, cluster: 8 })
    expect(r.ok).toBe(true)
    const asg = progress.filter(m => m.startsWith('オートスケーリンググループの削除を待っています'))
    const cluster = progress.filter(m => m.startsWith('クラスタの削除を待っています'))
    expect(asg).toEqual(['オートスケーリンググループの削除を待っています（1分経過）…'])
    expect(cluster).toEqual(['クラスタの削除を待っています（1分経過）…'])
    // 目安が付くのはロードバランサの待ち始めの一文だけ（ASG・クラスタの文には1つも付かない）
    expect(progress.filter(m => m.includes('およそ'))).toEqual([`ロードバランサの削除を待っています。${ESTIMATE}。`])
  })

  it('deleteWaitProgressMessage: 待ち始め（経過0）は経過を書かない・ロードバランサだけ目安が付く', () => {
    expect(deleteWaitProgressMessage('ロードバランサ', 0)).toBe(`ロードバランサの削除を待っています。${ESTIMATE}。`)
    expect(deleteWaitProgressMessage('ロードバランサ', 90_000)).toBe(`ロードバランサの削除を待っています（2分経過）。${ESTIMATE}。`)
    expect(deleteWaitProgressMessage('クラスタ', 90_000)).toBe('クラスタの削除を待っています（2分経過）…')
    expect(deleteWaitProgressMessage('アプリケーション', 30_000)).toBe('アプリケーションの削除を待っています（1分経過）…')
  })
})

describe('目安の数字は1か所・出典は実測', () => {
  it('★ ロードバランサの削除は「実測ではおよそ9分でした」（実測 5-11・2026-09-10）。この数字を変えるなら実測を取り直す', () => {
    expect(LB_DELETE_MEASURED_MINUTES).toBe(9)
    expect(lbDeleteEstimateNote()).toBe('実測ではおよそ9分でした（目安です）')
  })

  it('★ IP が付くまでは「クラスタを作った約2分後はまだ空で、数分後に付いていました」（実測 5-13。付くまでの分数は測っていないので数字にしない）', () => {
    expect(LB_ADDRESS_EMPTY_AFTER_MINUTES).toBe(2)
    expect(lbAddressEstimateNote()).toBe('実測では、クラスタを作った約2分後はまだ空で、数分後に付いていました（目安です）')
    // 出てくる数字は「空だった時点（約2分後）」だけ。付くまでにかかる分数を数字で言わない
    expect(lbAddressEstimateNote().match(/\d+/g)).toEqual(['2'])
  })

  it('★★★ どちらの文も、根拠の範囲を越えない（「ふつう」と一般化しない・「かかります」と約束しない）', () => {
    for (const note of [lbDeleteEstimateNote(), lbAddressEstimateNote()]) {
      expect(note).toContain('実測')
      expect(note).toContain('目安です')
      expect(note).not.toContain('ふつう')
      expect(note).not.toMatch(/かかります|必ず|かならず|絶対/)
    }
  })

  it('出典（docs/apprun-dedicated-plan.md）に実測が書いてある: LB の削除は約9分・IP は数分後に付く', () => {
    const plan = fs.readFileSync(path.join(__dirname, '../docs/apprun-dedicated-plan.md'), 'utf-8')
    expect(plan).toContain('LB は約9分で消滅')
    expect(plan).toContain('クラスタ作成の約2分後は空・数分後には付いていた')
  })

  it('★★ 目安の数字・言い回しを、ほかの場所に書き写していない（apprunDedicated.ts の関数だけを通る）', () => {
    // コメントを除いたコードに、「N分かかります」の直書きが無い。文の組み立ては lbDeleteEstimateNote / lbAddressEstimateNote だけ。
    const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:'"`])\/\/.*$/gm, '$1')
    for (const f of ['src/main/cloud/apprunDedicatedApply.ts', 'src/main/cloud/apprunDedicatedAppApply.ts', 'src/main/ipc/apprunDedicated.ts']) {
      const code = strip(fs.readFileSync(path.join(__dirname, '..', f), 'utf-8'))
      expect(code, `${f} に目安の直書きがある`).not.toMatch(/およそ\d+分|ふつう\d*分|ふつう数分|さくら側で|実測では|目安です/)
    }
    // 文はこの2つの関数から引いている
    const apply = fs.readFileSync(path.join(__dirname, '../src/main/cloud/apprunDedicatedApply.ts'), 'utf-8')
    const appApply = fs.readFileSync(path.join(__dirname, '../src/main/cloud/apprunDedicatedAppApply.ts'), 'utf-8')
    expect(apply).toContain('${lbDeleteEstimateNote()}')
    expect(appApply).toContain('${lbAddressEstimateNote()}')
  })
})
