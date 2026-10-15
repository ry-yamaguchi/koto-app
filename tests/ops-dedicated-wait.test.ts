import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import type { Server } from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { teardownFlow, deleteWaitProgressMessage } from '../src/main/cloud/apprunDedicatedApply'
import { writeApprunDedicatedRecordFs } from '../src/main/publishMetaFs'
import { STAGE } from '../src/shared/stageTiming'
import { estimateForStage, estimateText, emptyStore, DEV_MEASURES } from '../src/shared/stageEstimate'

// ── ロードバランサを待つ画面の目安は、進み具合の文ではなく「段の目安」の仕組みが出す（2026-10-07・作者の決定）──────────────
//
// 2026-09-29 は、実測（docs/apprun-dedicated-plan.md）にもとづく目安（LB の削除はおよそ9分・IP は数分後）を
// **進み具合の文に焼き込んで**いた（「実測ではおよそ9分でした（目安です）」）。2026-10-07 に目安は
// **段の内部名から引く仕組み**（shared/stageEstimate.ts: この Mac で測れたら最近5回の中央値・それまでは開発時の実測）へ
// 一本化し、画面が待っている段の横に出す。ここは次を固定する:
//   ・進み具合の文に、目安（実測・およそ・目安です）が**入っていない**（同じ数字を2か所に持たない）
//   ・LB の削除の目安は、仕組みの出力（開発時の実測 約9分・2026-09-10）が出す。**測っていない段（ASG・クラスタ・アプリ）には出ない**
//   ・開発時の実測の出典（原本）に、その数字が書いてある

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

describe('★★★ ⑥の削除待ち: 進み具合の文に目安を焼き込まない（目安は段の仕組みが出す）', () => {
  it('ロードバランサの待ち始めの一文と、30秒ごとの経過つきの文は、目安なし（これまでの書き出しのまま）', async () => {
    const { r, progress } = await runTeardown({ lb: 13, asg: 0, cluster: 0 }) // 13回の一覧＝65秒待つ（30秒・60秒で経過の文が出る）
    expect(r.ok).toBe(true)
    const lb = progress.filter(m => m.startsWith('ロードバランサの削除を待っています'))
    expect(lb).toEqual([
      'ロードバランサの削除を待っています…', // 待ち始め
      'ロードバランサの削除を待っています（1分経過）…', // 30秒
      'ロードバランサの削除を待っています（1分経過）…', // 60秒
    ])
  })

  it('★★★ どの資源の待ちの文にも、実測・目安・およそ・分数の約束が入っていない（同じ数字を2か所に持たない）', async () => {
    const { progress } = await runTeardown({ lb: 8, asg: 8, cluster: 8 })
    const waits = progress.filter(m => m.includes('削除を待っています'))
    expect(waits.length).toBeGreaterThan(0)
    for (const m of waits) {
      expect(m, '目安が文に焼き込まれている').not.toMatch(/実測|目安|およそ|ふつう|かかります/)
      expect(m).toMatch(/^.+の削除を待っています(（\d+分経過）)?…$/)
    }
  })

  it('deleteWaitProgressMessage: 待ち始め（経過0）は経過を書かない・どの資源も同じ形（目安は付かない）', () => {
    expect(deleteWaitProgressMessage('ロードバランサ', 0)).toBe('ロードバランサの削除を待っています…')
    expect(deleteWaitProgressMessage('ロードバランサ', 90_000)).toBe('ロードバランサの削除を待っています（2分経過）…')
    expect(deleteWaitProgressMessage('クラスタ', 90_000)).toBe('クラスタの削除を待っています（2分経過）…')
    expect(deleteWaitProgressMessage('アプリケーション', 30_000)).toBe('アプリケーションの削除を待っています（1分経過）…')
  })
})

describe('目安は段の仕組みから出る（この Mac に記録が無いときは開発時の実測・出典の日付つき）', () => {
  it('★ ロードバランサの削除は「約9分（開発時の実測・2026-09-10）」。この数字を変えるなら実測を取り直す', () => {
    const e = estimateForStage(STAGE.teardownLb, emptyStore())
    expect(e).toEqual({ kind: 'dev', ms: 9 * 60_000, note: null, date: '2026-09-10' })
    expect(estimateText(e!)).toBe('目安 約9分（開発時の実測・2026-09-10）')
  })

  it('★ IP が付くまでは、数字にしない（付くまでの分数は測っていない）: 原本の言葉のまま「数分」（開発時の実測・2026-09-16）', () => {
    const e = estimateForStage(STAGE.publishLbAddress, emptyStore())
    expect(e).toEqual({ kind: 'dev', ms: null, note: '数分', date: '2026-09-16' })
    expect(estimateText(e!)).toBe('目安 数分（開発時の実測・2026-09-16）')
    expect(estimateText(e!).match(/\d+/g)).toEqual(['2026', '09', '16']) // 数字は出典の日付だけ
  })

  it('★ ASG の削除は、数字にせず原本の言葉のまま「数分」（開発時の実測・2026-09-10）。原本は「ASG を削除（削除中が数分）」とだけ書いている', () => {
    const e = estimateForStage(STAGE.teardownAsg, emptyStore())
    expect(e).toEqual({ kind: 'dev', ms: null, note: '数分', date: '2026-09-10' })
    expect(estimateText(e!)).toBe('目安 数分（開発時の実測・2026-09-10）')
  })

  it('★★ 測っていない段（アプリ・クラスタ・保存場所・公開のほかの段・作成の3段）には、目安が出ない', () => {
    const measured = new Set<string>([STAGE.teardownLb, STAGE.teardownAsg, STAGE.publishLbAddress])
    for (const id of Object.values(STAGE)) {
      if (measured.has(id)) continue
      expect(estimateForStage(id, emptyStore()), `${id} に目安がある`).toBeNull()
    }
    // 開発時の実測の表は、測った3段だけ
    expect(Object.keys(DEV_MEASURES).sort()).toEqual([STAGE.publishLbAddress, STAGE.teardownAsg, STAGE.teardownLb].sort())
  })

  it('出典（docs/apprun-dedicated-plan.md）に実測が書いてある: LB の削除は約9分・IP は数分後に付く', () => {
    const plan = fs.readFileSync(path.join(__dirname, '../docs/apprun-dedicated-plan.md'), 'utf-8')
    expect(plan).toContain('LB は約9分で消滅')
    expect(plan).toContain('クラスタ作成の約2分後は空・数分後には付いていた')
    expect(DEV_MEASURES[STAGE.teardownLb].source).toBe('docs/apprun-dedicated-plan.md 5-11')
    expect(DEV_MEASURES[STAGE.publishLbAddress].source).toBe('docs/apprun-dedicated-plan.md 5-13')
    expect(plan).toContain('ASG を削除（削除中が数分）')
    expect(DEV_MEASURES[STAGE.teardownAsg].source).toBe('docs/apprun-dedicated-plan.md 5-11')
  })

  it('★★ 目安の文・数字を、ほかの場所に書き写していない（固定文を持つ関数・定数が main から消えている）', () => {
    // コメントを除いたコードに、「N分かかります」「実測では」の直書きが無い。
    const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:'"`])\/\/.*$/gm, '$1')
    for (const f of ['src/main/cloud/apprunDedicatedApply.ts', 'src/main/cloud/apprunDedicatedAppApply.ts', 'src/main/cloud/apprunDedicated.ts', 'src/main/ipc/apprunDedicated.ts']) {
      const code = strip(fs.readFileSync(path.join(__dirname, '..', f), 'utf-8'))
      expect(code, `${f} に目安の直書きがある`).not.toMatch(/およそ\d+分|ふつう\d*分|ふつう数分|さくら側で|実測では|目安です/)
      expect(code, `${f} に旧い目安の関数・定数が残っている`).not.toMatch(/lbDeleteEstimateNote|lbAddressEstimateNote|LB_DELETE_MEASURED_MINUTES|LB_ADDRESS_EMPTY_AFTER_MINUTES/)
    }
  })
})
