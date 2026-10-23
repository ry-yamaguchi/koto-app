import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// 2026-08-14。**型が通ることは、繋がっている証拠にならない。**
//
// 永続データ（S-1）で、裏側を全部作り、単体テストも 1,000 件以上通したのに、
// `applyPlan` に `storage` を渡す1行が無く、公開してもバケットが作られなかった。
// `ApplyOptions.storage` が任意（`?`）なので型検査も素通りし、実行時も
// `skipped` に積まれるだけで、画面には何も出なかった。
//
// 同じ形の抜けは、注入で受け取る任意の依存すべてに起こりうる。ここでは
// **呼び出し側のソースを読んで、渡し忘れていないこと自体を確かめる**。
// 泥臭いが、これが無いと同じ穴にもう一度落ちる。

const IPC = path.join(__dirname, '..', 'src', 'main', 'ipc', 'cloud.ts')
// 公開の applyPlan は 2026-10-21 から applyForProject.ts（プロジェクトのフォルダつき・一時キーの片づけつき）を通る。cloud.ts はそれを呼ぶ
const APPLY_FOR_PROJECT = path.join(__dirname, '..', 'src', 'main', 'cloud', 'applyForProject.ts')
// 破棄は 2026-10-10（段階2）に cloudTeardown.ts へ移した。破棄のアプリの削除は applyPlan に storage を渡さず、
// 保存場所は teardownStorageForProject（env.json の同意済み全件 + state にだけあるもの）が最後に消す。
const TEARDOWN_IPC = path.join(__dirname, '..', 'src', 'main', 'ipc', 'cloudTeardown.ts')

/** `name(` の呼び出しごとに、対応する閉じ括弧までの本文を切り出す。 */
function callsOf(source: string, name: string): string[] {
  const out: string[] = []
  const re = new RegExp(`${name}\\(`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    let depth = 0
    let i = m.index + m[0].length - 1
    const start = i
    for (; i < source.length; i++) {
      if (source[i] === '(') depth++
      else if (source[i] === ')') {
        depth--
        if (depth === 0) break
      }
    }
    out.push(source.slice(start, i + 1))
  }
  return out
}
const applyPlanCalls = (source: string): string[] => callsOf(source, 'applyPlan')

describe('applyPlan の呼び出しに、保存場所の操作が渡っている', () => {
  const source = fs.readFileSync(IPC, 'utf-8')
  const teardownSource = fs.readFileSync(TEARDOWN_IPC, 'utf-8')

  it('切り出しそのものが正しく動く（この検査の土台）', () => {
    expect(applyPlanCalls('applyPlan({ a: f(1), b: 2 })')).toEqual(['({ a: f(1), b: 2 })'])
    expect(applyPlanCalls('x; applyPlan({a}); applyPlan({b})').length).toBe(2)
  })

  it('公開（cloud.ts）は applyForProject を1回、破棄（cloudTeardown.ts）は applyPlan を1回呼んでいる（cloud.ts は applyPlan を直に呼ばない）', () => {
    expect(callsOf(source, 'applyForProject').length).toBe(1)
    expect(applyPlanCalls(source).length).toBe(0)
    expect(applyPlanCalls(teardownSource).length).toBe(1)
  })

  it('公開の呼び出しは storage を渡している（これが無いとバケットが作られない）', () => {
    for (const call of callsOf(source, 'applyForProject')) {
      expect(call).toContain('storage')
    }
  })

  it('公開・破棄のどちらの呼び出しも projectDir を渡している（保存場所の削除が、ほかのプロジェクトの記録を読む起点）', () => {
    for (const call of callsOf(source, 'applyForProject')) expect(call).toContain('projectDir,')
    for (const call of applyPlanCalls(teardownSource)) expect(call).toContain('projectDir })')
  })

  it('破棄の呼び出しは storage を渡さない（渡すと state 経由の読みに戻り、確認が言う保存場所と食い違う）。保存場所は teardownStorageForProject を通る', () => {
    for (const call of applyPlanCalls(teardownSource)) {
      expect(call).not.toContain('storage')
    }
    expect(teardownSource).toContain('teardownStorageForProject({ creds, projectDir')
    expect(teardownSource).toContain('placements })')
  })

  it('渡したあとに片づけている（一時キーを残さない）。片づけは applyForProject の finally にあり、applyPlan の呼び出しはその try の中', () => {
    const forProject = fs.readFileSync(APPLY_FOR_PROJECT, 'utf-8')
    expect(forProject).toContain('return await applyPlan(opts)\n  } finally {\n    if (opts.storage) await opts.storage.dispose()')
  })
})
