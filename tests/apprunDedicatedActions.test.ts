import { describe, it, expect, vi } from 'vitest'
import { runCreate, runTeardown, shouldShowCreateResult, shouldShowTeardownResult } from '../src/renderer/apprunDedicatedActions'

// apprunDedicatedActions.test.ts — AppRunDedicatedPanel.tsx の「確認→IPC」を、React/DOM から
// 切り離して振る舞いで固定する（2026-09-10 レビューの修理・J・tests/rollbackSwitch.test.ts と同型）。
// confirm・create/teardown を注入で受け取るので jsdom は要らない。「confirm が false（キャンセル）を
// 返したとき、create/teardown が一度も呼ばれないこと」を偽の関数の呼び出し回数で確かめる
// （文字列一致ではない・掟10）。

// K（2026-09-10 レビューの修理・バッチ3）: 「実行中」レジストリ（activity.ts の beginActivity と
// 同じ形）への伝達。偽の begin/end で「create/teardown の前に begin が1回、後に end が1回
// （失敗時も）」「confirm=false のときは begin も end も呼ばれない」を固定する。
function fakeActivity() {
  const end = vi.fn()
  const begin = vi.fn(() => end)
  return { activity: { begin }, begin, end }
}

describe('runCreate: confirm を通らなければ create は一切呼ばれない', () => {
  it('confirm が false を返すと create は呼ばれず、{cancelled:true} を返す', async () => {
    const create = vi.fn()
    const { activity, begin, end } = fakeActivity()
    const outcome = await runCreate(
      { confirmMessage: '月額22,000円かかります。よろしいですか？', spec: { name: 'myapp' } },
      { confirm: () => false, create, activity },
    )
    expect(create).not.toHaveBeenCalled()
    expect(outcome).toEqual({ cancelled: true })
    // confirm=false のときは begin も end も呼ばれない
    expect(begin).not.toHaveBeenCalled()
    expect(end).not.toHaveBeenCalled()
  })

  it('confirm が true を返すと create を spec と { confirmed: true } で1回だけ呼ぶ', async () => {
    const create = vi.fn().mockResolvedValue({ ok: true, stage: 'done' })
    const spec = { name: 'myapp' }
    const { activity } = fakeActivity()
    const outcome = await runCreate(
      { confirmMessage: '月額22,000円かかります。よろしいですか？', spec },
      { confirm: () => true, create, activity },
    )
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith(spec, { confirmed: true })
    expect(outcome).toEqual({ cancelled: false, result: { ok: true, stage: 'done' } })
  })

  it('confirm には req.confirmMessage がそのまま渡る（確認文と実行が同じリクエストに基づく）', async () => {
    const confirm = vi.fn().mockReturnValue(false)
    const { activity } = fakeActivity()
    await runCreate(
      { confirmMessage: '確認文言X', spec: {} },
      { confirm, create: vi.fn(), activity },
    )
    expect(confirm).toHaveBeenCalledWith('確認文言X')
  })

  it('confirm が例外を投げても create は呼ばれない（confirm→createの順序を保つ）', async () => {
    const create = vi.fn()
    const { activity, begin, end } = fakeActivity()
    await expect(runCreate(
      { confirmMessage: 'x', spec: {} },
      { confirm: () => { throw new Error('boom') }, create, activity },
    )).rejects.toThrow('boom')
    expect(create).not.toHaveBeenCalled()
    expect(begin).not.toHaveBeenCalled()
    expect(end).not.toHaveBeenCalled()
  })

  it('confirm=true のとき、create の前に begin が1回、後に end が1回呼ばれる', async () => {
    const calls: string[] = []
    const create = vi.fn(async () => { calls.push('create'); return { ok: true } })
    const end = vi.fn(() => { calls.push('end') })
    const begin = vi.fn(() => { calls.push('begin'); return end })
    const outcome = await runCreate(
      { confirmMessage: 'x', spec: {} },
      { confirm: () => true, create, activity: { begin } },
    )
    expect(begin).toHaveBeenCalledTimes(1)
    expect(end).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['begin', 'create', 'end'])
    expect(outcome).toEqual({ cancelled: false, result: { ok: true } })
  })

  it('create が失敗（reject）しても end は必ず1回呼ばれる', async () => {
    const create = vi.fn().mockRejectedValue(new Error('作成失敗'))
    const { activity, begin, end } = fakeActivity()
    await expect(runCreate(
      { confirmMessage: 'x', spec: {} },
      { confirm: () => true, create, activity },
    )).rejects.toThrow('作成失敗')
    expect(begin).toHaveBeenCalledTimes(1)
    expect(end).toHaveBeenCalledTimes(1)
  })
})

describe('runTeardown: confirm を通らなければ teardown は一切呼ばれない', () => {
  it('confirm が false を返すと teardown は呼ばれず、{cancelled:true} を返す', async () => {
    const teardown = vi.fn()
    const { activity, begin, end } = fakeActivity()
    const outcome = await runTeardown(
      { confirmMessage: '次を削除します。よろしいですか？' },
      { confirm: () => false, teardown, activity },
    )
    expect(teardown).not.toHaveBeenCalled()
    expect(outcome).toEqual({ cancelled: true })
    expect(begin).not.toHaveBeenCalled()
    expect(end).not.toHaveBeenCalled()
  })

  it('confirm が true を返すと teardown を { confirmed: true } で1回だけ呼ぶ', async () => {
    const teardown = vi.fn().mockResolvedValue({ ok: true, executed: ['クラスタ『c1』を削除しました'], message: 'ok', remaining: {} })
    const { activity } = fakeActivity()
    const outcome = await runTeardown(
      { confirmMessage: '次を削除します。よろしいですか？' },
      { confirm: () => true, teardown, activity },
    )
    expect(teardown).toHaveBeenCalledTimes(1)
    expect(teardown).toHaveBeenCalledWith({ confirmed: true })
    expect(outcome).toEqual({
      cancelled: false,
      result: { ok: true, executed: ['クラスタ『c1』を削除しました'], message: 'ok', remaining: {} },
    })
  })

  it('confirm には req.confirmMessage がそのまま渡る', async () => {
    const confirm = vi.fn().mockReturnValue(false)
    const { activity } = fakeActivity()
    await runTeardown({ confirmMessage: '確認文言Y' }, { confirm, teardown: vi.fn(), activity })
    expect(confirm).toHaveBeenCalledWith('確認文言Y')
  })

  it('confirm=true のとき、teardown の前に begin が1回、後に end が1回呼ばれる', async () => {
    const calls: string[] = []
    const teardown = vi.fn(async () => { calls.push('teardown'); return { ok: true, executed: [], message: 'ok', remaining: {} } })
    const end = vi.fn(() => { calls.push('end') })
    const begin = vi.fn(() => { calls.push('begin'); return end })
    const outcome = await runTeardown(
      { confirmMessage: 'x' },
      { confirm: () => true, teardown, activity: { begin } },
    )
    expect(begin).toHaveBeenCalledTimes(1)
    expect(end).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['begin', 'teardown', 'end'])
    expect(outcome.cancelled).toBe(false)
  })

  it('teardown が失敗（reject）しても end は必ず1回呼ばれる', async () => {
    const teardown = vi.fn().mockRejectedValue(new Error('破棄失敗'))
    const { activity, begin, end } = fakeActivity()
    await expect(runTeardown(
      { confirmMessage: 'x' },
      { confirm: () => true, teardown, activity },
    )).rejects.toThrow('破棄失敗')
    expect(begin).toHaveBeenCalledTimes(1)
    expect(end).toHaveBeenCalledTimes(1)
  })
})

// ── B-2（2026-09-10 実機・Ryosuke さん指摘「消した後の表示が変」） ──────────────────────
//
// 破棄（⑥）が成功して記録（apprunState）が空になったのに、⑤の節に古い「✅ 作成できました」
// （前回の createResult）がそのまま出続けていた。かつ、⑥の結果表示自体も「記録がある間だけ」
// 描く節の中にあったため、破棄が完了した瞬間に自分の「✅ すべて削除しました」も一緒に消えていた。
// shouldShowCreateResult / shouldShowTeardownResult は、この2つの表示判断を React/DOM から
// 切り離した純関数として固定する（掟10）。

describe('shouldShowCreateResult: ⑤の結果ブロックを出すか', () => {
  it('createResult が無ければ出さない', () => {
    expect(shouldShowCreateResult(null, { clusterID: 'c1' })).toBe(false)
    expect(shouldShowCreateResult(undefined, { clusterID: 'c1' })).toBe(false)
  })

  it('createResult.ok が false（途中で止まった）なら、記録が空でも常に出す（失敗の内容・途中IDは破棄の判断に要る）', () => {
    expect(shouldShowCreateResult({ ok: false }, null)).toBe(true)
    expect(shouldShowCreateResult({ ok: false }, {})).toBe(true)
    expect(shouldShowCreateResult({ ok: false }, { clusterID: 'c1' })).toBe(true)
  })

  it('createResult.ok が true でも、記録（apprunState）が空なら出さない（破棄済みなのに古い成功表示を見せない・2026-09-10実機で発見）', () => {
    expect(shouldShowCreateResult({ ok: true }, null)).toBe(false)
    expect(shouldShowCreateResult({ ok: true }, undefined)).toBe(false)
    expect(shouldShowCreateResult({ ok: true }, {})).toBe(false)
    expect(shouldShowCreateResult({ ok: true }, { clusterID: null, asgID: null, loadBalancerID: null })).toBe(false)
  })

  it('createResult.ok が true で、記録にIDが1つでもあれば出す（clusterID/asgID/loadBalancerIDのどれでもよい）', () => {
    expect(shouldShowCreateResult({ ok: true }, { clusterID: 'c1' })).toBe(true)
    expect(shouldShowCreateResult({ ok: true }, { asgID: 'a1' })).toBe(true)
    expect(shouldShowCreateResult({ ok: true }, { loadBalancerID: 'l1' })).toBe(true)
  })
})

describe('shouldShowTeardownResult: ⑥の結果ブロックを出すか', () => {
  it('teardownResult が無ければ出さない', () => {
    expect(shouldShowTeardownResult(null)).toBe(false)
    expect(shouldShowTeardownResult(undefined)).toBe(false)
  })

  it('teardownResult があれば、ok/ng を問わず常に出す（⑥の節＝hasAnyResourceの有無に関係なく。記録が空になっても結果自体は隠さない）', () => {
    expect(shouldShowTeardownResult({ ok: true, executed: [], message: 'ok', remaining: {} })).toBe(true)
    expect(shouldShowTeardownResult({ ok: false, executed: [], message: 'ng', remaining: {} })).toBe(true)
    // inProgress で止まったときも同様（値の形そのものは見ない＝「今の値をそのまま出すか」だけを判定する）。
    expect(shouldShowTeardownResult({ ok: false, executed: [], message: 'ng', remaining: {}, inProgress: { loadBalancerID: 'l1' } })).toBe(true)
  })
})
