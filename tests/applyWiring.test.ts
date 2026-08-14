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

/** `applyPlan(` の呼び出しごとに、対応する閉じ括弧までの本文を切り出す。 */
function applyPlanCalls(source: string): string[] {
  const out: string[] = []
  const re = /applyPlan\(/g
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

describe('applyPlan の呼び出しに、保存場所の操作が渡っている', () => {
  const source = fs.readFileSync(IPC, 'utf-8')

  it('切り出しそのものが正しく動く（この検査の土台）', () => {
    expect(applyPlanCalls('applyPlan({ a: f(1), b: 2 })')).toEqual(['({ a: f(1), b: 2 })'])
    expect(applyPlanCalls('x; applyPlan({a}); applyPlan({b})').length).toBe(2)
  })

  it('公開と破棄の両方で applyPlan を呼んでいる', () => {
    expect(applyPlanCalls(source).length).toBe(2)
  })

  it('どの呼び出しにも storage を渡している（これが無いとバケットが作られない）', () => {
    for (const call of applyPlanCalls(source)) {
      expect(call).toContain('storage')
    }
  })

  it('渡したあとに片づけている（一時キーを残さない）', () => {
    expect(source).toContain('storage.dispose()')
  })
})
