import { describe, it, expect, vi } from 'vitest'
import { runCreate, runTeardown, runPublishApp, shouldShowCreateResult, shouldShowTeardownResult, shouldShowPublishSection } from '../src/renderer/apprunDedicatedActions'
import { panelBusy, panelBusyReason } from '../src/renderer/apprunDedicatedActions'
import { teardownConfirmMessage } from '../src/renderer/apprunDedicatedActions'
import { shouldShowTeardownButton, storageLeftoverNote, shouldClearPublishRecord } from '../src/renderer/apprunDedicatedActions'
import { teardownDataNote, teardownDataNoteForAll } from '../src/shared/teardownSupport'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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

// ── D-4（2026-09-15）: ⑧「アプリを公開する」──────────────────────────────────────
// runCreate と同じ形の歯止め（confirm が false なら publish を一度も呼ばない）を、偽の
// confirm/publish/activity の**呼び出し回数**で固定する（文字列一致ではない・掟10）。
// 変異(a)「confirm を見ずに publish を呼ぶ」は「confirm=false → publish 0回」のケースが検知する。

const PUBLISH_INPUT = { host: 'app.example.com', cpu: 500, memory: 512, fixedScale: 1 }

describe('runPublishApp: confirm を通らなければ publish は一切呼ばれない', () => {
  it('confirm が false を返すと publish は呼ばれず、{cancelled:true} を返す（begin/end も呼ばれない）', async () => {
    const publish = vi.fn()
    const { activity, begin, end } = fakeActivity()
    const outcome = await runPublishApp(
      { confirmMessage: 'ホスト名: app.example.com', input: PUBLISH_INPUT },
      { confirm: () => false, publish, activity },
    )
    expect(publish).not.toHaveBeenCalled()
    expect(outcome).toEqual({ cancelled: true })
    expect(begin).not.toHaveBeenCalled()
    expect(end).not.toHaveBeenCalled()
  })

  it('confirm が true を返すと publish を input と { confirmed: true } で1回だけ呼ぶ', async () => {
    const publish = vi.fn().mockResolvedValue({ ok: true, stage: 'done', url: 'https://app.example.com/' })
    const { activity } = fakeActivity()
    const outcome = await runPublishApp(
      { confirmMessage: 'ホスト名: app.example.com', input: PUBLISH_INPUT },
      { confirm: () => true, publish, activity },
    )
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith(PUBLISH_INPUT, { confirmed: true })
    expect(outcome).toEqual({ cancelled: false, result: { ok: true, stage: 'done', url: 'https://app.example.com/' } })
  })

  it('confirm には req.confirmMessage がそのまま渡る（確認文と実行が同じリクエストに基づく）', async () => {
    const confirm = vi.fn().mockReturnValue(false)
    const { activity } = fakeActivity()
    await runPublishApp({ confirmMessage: '確認文言Z', input: PUBLISH_INPUT }, { confirm, publish: vi.fn(), activity })
    expect(confirm).toHaveBeenCalledWith('確認文言Z')
  })

  it('confirm が例外を投げても publish は呼ばれない（confirm→publish の順序を保つ）', async () => {
    const publish = vi.fn()
    const { activity, begin, end } = fakeActivity()
    await expect(runPublishApp(
      { confirmMessage: 'x', input: PUBLISH_INPUT },
      { confirm: () => { throw new Error('boom') }, publish, activity },
    )).rejects.toThrow('boom')
    expect(publish).not.toHaveBeenCalled()
    expect(begin).not.toHaveBeenCalled()
    expect(end).not.toHaveBeenCalled()
  })

  it('confirm=true のとき、publish の前に begin が1回、後に end が1回呼ばれる', async () => {
    const calls: string[] = []
    const publish = vi.fn(async () => { calls.push('publish'); return { ok: true, stage: 'done' } })
    const end = vi.fn(() => { calls.push('end') })
    const begin = vi.fn(() => { calls.push('begin'); return end })
    const outcome = await runPublishApp(
      { confirmMessage: 'x', input: PUBLISH_INPUT },
      { confirm: () => true, publish, activity: { begin } },
    )
    expect(begin).toHaveBeenCalledTimes(1)
    expect(end).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['begin', 'publish', 'end'])
    expect(outcome).toEqual({ cancelled: false, result: { ok: true, stage: 'done' } })
  })

  it('publish が失敗（reject）しても end は必ず1回呼ばれる', async () => {
    const publish = vi.fn().mockRejectedValue(new Error('公開失敗'))
    const { activity, begin, end } = fakeActivity()
    await expect(runPublishApp(
      { confirmMessage: 'x', input: PUBLISH_INPUT },
      { confirm: () => true, publish, activity },
    )).rejects.toThrow('公開失敗')
    expect(begin).toHaveBeenCalledTimes(1)
    expect(end).toHaveBeenCalledTimes(1)
  })
})

// 変異(c)「記録が無くても true」は null/undefined/{} → false のケースが検知する。
// OR（1つでもあれば）に書き換える変異は「一部欠け → false」のケースが検知する。
describe('shouldShowPublishSection: ⑧の節はクラスタ・ASG・LB の3つが揃っているときだけ出す', () => {
  it('記録が無ければ出さない（null / undefined / 空）', () => {
    expect(shouldShowPublishSection(null)).toBe(false)
    expect(shouldShowPublishSection(undefined)).toBe(false)
    expect(shouldShowPublishSection({})).toBe(false)
    expect(shouldShowPublishSection({ clusterID: null, asgID: null, loadBalancerID: null })).toBe(false)
  })

  it('一部だけ（⑤の途中で止まった状態）では出さない（shouldShowCreateResult の OR とは違う・AND）', () => {
    expect(shouldShowPublishSection({ clusterID: 'c1' })).toBe(false)
    expect(shouldShowPublishSection({ clusterID: 'c1', asgID: 'a1' })).toBe(false)
    expect(shouldShowPublishSection({ asgID: 'a1', loadBalancerID: 'l1' })).toBe(false)
    expect(shouldShowPublishSection({ clusterID: 'c1', asgID: 'a1', loadBalancerID: '' })).toBe(false)
  })

  it('3つ揃っていれば出す', () => {
    expect(shouldShowPublishSection({ clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })).toBe(true)
  })
})

// ── H-1（2026-09-17）: ⑤⑥⑦⑧ を同時に走らせない ────────────────────────────────
// 横断点検（6視点）のうち4つが独立に同じ欠陥へ収束した。⑥の破棄は実測で約9分かかり、
// そのあいだ⑧「公開する」が押せていた。割り込むと記録が交錯し、applicationID があるのに
// clusterID が無い状態になって **Koto からは二度と消せない**（課金が止まらない）。

describe('panelBusy: この節で何かが走っているか', () => {
  it('何も走っていなければ false', () => {
    expect(panelBusy({})).toBe(false)
    expect(panelBusy({ creating: false, tearingDown: false, publishing: false, lbRefreshing: false })).toBe(false)
  })

  it('★ どれか1つでも走っていれば true（4通りすべて）', () => {
    expect(panelBusy({ creating: true })).toBe(true)
    expect(panelBusy({ tearingDown: true })).toBe(true)
    expect(panelBusy({ publishing: true })).toBe(true)
    expect(panelBusy({ lbRefreshing: true })).toBe(true)
  })

  it('壊れた入力でも落ちない', () => {
    expect(panelBusy(null)).toBe(false)
    expect(panelBusy(undefined)).toBe(false)
  })
})

describe('panelBusyReason: 押せない理由を名指しする', () => {
  it('★ 理由の分からない無効化にしない（何が走っているかを書く）', () => {
    expect(panelBusyReason({ tearingDown: true })).toContain('⑥')
    expect(panelBusyReason({ publishing: true })).toContain('⑧')
    expect(panelBusyReason({ creating: true })).toContain('⑤')
  })

  it('何も走っていなければ空文字（画面は何も出さない）', () => {
    expect(panelBusyReason({})).toBe('')
    expect(panelBusyReason(null)).toBe('')
  })
})

/** コメント行を剥がす（当て先がコメントに出るのを避ける）。 */
function codeOnlyPanel(src: string): string {
  return src
    .split('\n')
    .filter(l => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*') && !l.trimStart().startsWith('/*') && !l.trimStart().startsWith('{/*'))
    .join('\n')
}

describe('画面の配線: ⑤⑥⑦⑧ の操作はすべて panelBusy で止まる', () => {
  const panel = codeOnlyPanel(readFileSync(join(__dirname, '../src/renderer/components/AppRunDedicatedPanel.tsx'), 'utf8'))
  const BUSY = 'panelBusy({ creating, tearingDown, publishing, lbRefreshing })'

  it('★ ⑧の公開ボタンが、破棄の最中でも無効になる（今回の穴そのもの）', () => {
    expect(panel).toContain(`disabled={publishErrors.length > 0 || ${BUSY}}`)
    // 直す前の形（publishing しか見ない）を禁じる。
    expect(panel).not.toContain('disabled={publishErrors.length > 0 || publishing}')
  })

  it('★ ⑥の破棄ボタンが、公開の最中でも無効になる（逆向き）', () => {
    expect(panel).toContain(`disabled={${BUSY}}`)
    expect(panel).not.toContain('disabled={tearingDown}')
  })

  it('★ ⑤の作成ボタン・IP の取り直しも同じ判定を通る', () => {
    expect(panel).toContain(`disabled={hasErrors || ${BUSY}}`)
    expect(panel).not.toContain('disabled={hasErrors || creating}')
    expect(panel).not.toContain('disabled={lbRefreshing}')
  })

  it('★ ⑦のつなぐボタンも同じ判定を通る', () => {
    expect(panel).toContain(`disabled={telemetryBusyKind === kind || ${BUSY}}`)
    expect(panel).not.toContain('disabled={telemetryBusyKind === kind || tearingDown}')
  })

  it('★ ボタンを無効にするだけでなく、実行の入口（早期 return）も同じ判定を通る', () => {
    expect(panel).toContain(`if (hasErrors || ${BUSY}) return`)
    expect(panel).toContain(`if (${BUSY}) return`)
    expect(panel).toContain(`if (publishErrors.length > 0 || ${BUSY} || !appStatus) return`)
  })

  it('★ 押せないときに、理由の一言を出す', () => {
    expect(panel).toContain('panelBusyReason({ creating, tearingDown, publishing, lbRefreshing })')
  })
})

// ── ⑥の確認ダイアログの文面（2026-09-24 Ryosuke 決定「①は案2・一貫性が重要」）────────────
//
// 案2 では⑥の破棄で**利用者のデータが実際に消える**。それを名指ししない確認は嘘になる。
// 以前の文面は「次を削除します: アプリ…・クラスタ…／この操作は元に戻せません。
// 消さない限り課金が続きます。」で、**保存場所が一覧に入っていなかった。**

describe('⑥の確認ダイアログ: 保存場所を名指しする（案2）', () => {
  const TARGETS = ['アプリ『myapp』', 'ロードバランサ『lb-z』', 'クラスタ『cluster-x』']
  const PLACEMENT = { bucket: 'koto-data-x', prefix: 'projects/myapp/', shared: true }

  // W-14（2026-09-27 決定）: 「（中のデータも消えます）」は保存場所そのものが丸ごと消えると
  // 読めてしまうため「にある、このプロジェクトのデータ」に直した（wording-review.md W-14 の注意）。
  it('★★ 保存場所があるとき、一覧に名前が入り「このプロジェクトのデータ」と言う', () => {
    const msg = teardownConfirmMessage({
      targets: TARGETS,
      placements: [PLACEMENT],
      dataNote: teardownDataNote(PLACEMENT),
    })
    expect(msg).toContain('保存場所『koto-data-x』')
    expect(msg).toContain('にある、このプロジェクトのデータ')
    expect(msg).not.toContain('中のデータも消えます')
    // 削除するものの一覧の中に入っている（別の段落に添えるだけではない）
    expect(msg.split('\n\n')[0]).toContain('保存場所『koto-data-x』')
    for (const t of TARGETS) expect(msg).toContain(t)
  })

  it('★★ ほかのプロジェクトも使っている保存場所のことを伝える（何が残るかの約束）', () => {
    const msg = teardownConfirmMessage({
      targets: TARGETS,
      placements: [PLACEMENT],
      dataNote: teardownDataNote(PLACEMENT),
    })
    expect(msg).toContain('ほかのプロジェクトのデータ')
    expect(msg).toContain('あなたが自分で置いたファイルは残します')
    expect(msg).toContain('ほかに無ければ')
  })

  it('★★ 保存場所が無いときは、一覧にも本文にも保存場所が出ない', () => {
    const msg = teardownConfirmMessage({ targets: TARGETS, placements: [], dataNote: '' })
    expect(msg).not.toContain('保存場所')
    expect(msg).not.toContain('データも消えます')
    for (const t of TARGETS) expect(msg).toContain(t)
  })

  // W-14（2026-09-27 決定）: 「ここに挙げたものの月額の課金は止まります」という固定の言い切りはやめ、
  // targets から組み立てた「〜の課金は止まります」にした（固定文言ではなくなったので、
  // 部分一致は語尾の「の課金は止まります」だけを見る）。
  it('★ 「消さない限り課金が続きます」ではなく、止まる側の説明にする', () => {
    for (const placement of [PLACEMENT, null]) {
      const msg = teardownConfirmMessage({ targets: TARGETS, placements: placement ? [placement] : [], dataNote: teardownDataNote(placement) })
      expect(msg).not.toContain('消さない限り課金が続きます')
      expect(msg).toContain('の課金は止まります')
      expect(msg).toContain('この操作は元に戻せません')
    }
  })

  it('画面には素のテキストとして出る（Markdown 記法を使わない・v0.2.98 の教訓）', () => {
    const msg = teardownConfirmMessage({ targets: TARGETS, placements: [PLACEMENT], dataNote: teardownDataNote(PLACEMENT) })
    expect(msg).not.toMatch(/\*\*|__|`/)
  })
})

// ── ⑥の確認ダイアログ: 消える保存場所を**全件**名指しする（2026-09-25 検分の指摘15・V6）──
//
// ⑥の破棄は `teardownStorageForProject` が env.json の同意済みの保存場所を**全件**片づける。
// ところが確認の本文は `storage:placement` の先頭1件だけで組み立てていたので、2件ある状態では
// 『A』しか出ないまま、**名前が一度も出なかった『B』とその中のデータまで消えた**。
// 元に戻せない削除を、名指ししないまま実行させてはいけない（掟10「お金・破壊の歯止め」）。

describe('⑥の確認ダイアログ: 保存場所が2件あるとき、両方を名指しする（指摘15）', () => {
  const TARGETS = ['クラスタ『cluster-x』']
  const A = { bucket: 'koto-data-a', prefix: 'projects/myapp/', shared: true }
  const B = { bucket: 'koto-data-b', prefix: 'projects/myapp/', shared: true }
  const noteAll = teardownDataNoteForAll({ target: 'sakura-apprun-dedicated', scope: 'full', placements: [A, B] })

  it('★★ 削除するものの一覧に『A』と『B』が両方入る（先頭1件で終わらない）', () => {
    const msg = teardownConfirmMessage({ targets: TARGETS, placements: [A, B], dataNote: noteAll })
    const first = msg.split('\n\n')[0]
    expect(first, '『A』が一覧に無い').toContain('『koto-data-a』')
    expect(first, '『B』が一覧に無い＝名指ししないまま消す').toContain('『koto-data-b』')
    // W-14（2026-09-27 決定）: 「（中のデータも消えます）」→「にある、このプロジェクトのデータ」
    expect(first).toContain('にある、このプロジェクトのデータ')
  })

  it('★★ 「ほか1件」のように省かない（省いた名前は、利用者にとって存在しないのと同じ）', () => {
    const msg = teardownConfirmMessage({ targets: TARGETS, placements: [A, B], dataNote: noteAll })
    expect(msg).not.toMatch(/ほか\s*\d+\s*件/)
    expect(msg).not.toContain('…')
  })

  it('★★ 💾 の行（何が残るかの約束）も全件の名前を出す', () => {
    const msg = teardownConfirmMessage({ targets: TARGETS, placements: [A, B], dataNote: noteAll })
    const dataLine = msg.split('\n\n').find(x => x.startsWith('💾 '))
    expect(dataLine, '💾 の行が無い').toBeTruthy()
    expect(dataLine!).toContain('『koto-data-a』')
    expect(dataLine!).toContain('『koto-data-b』')
  })

  it('★★ ほかの公開先の巻き添えも、2件のときは「これらの保存場所」と言う', () => {
    const msg = teardownConfirmMessage({
      targets: TARGETS, placements: [A, B], dataNote: noteAll, otherTargets: ['HANAMII'],
    })
    expect(msg).toContain('これらの保存場所は HANAMII でも使っています。')
    expect(msg).toContain('アプリ自体は消えません')
  })

  // W-14（2026-09-27 決定）でこの全文の固定文言を組み立て式に直したため、期待値も新しい文面に更新
  // （テストの狙い＝1件と2件で組み立てが同じであることは変えていない）。
  it('★★ 1件のときの文面は、直したあとの形で固定する（文言を二重管理しない）', () => {
    const noteOne = teardownDataNoteForAll({ target: 'sakura-apprun-dedicated', scope: 'full', placements: [A] })
    const msg = teardownConfirmMessage({ targets: TARGETS, placements: [A], dataNote: noteOne })
    expect(msg).toBe(
      '次を削除します: クラスタ『cluster-x』・保存場所『koto-data-a』にある、このプロジェクトのデータ'
      + '\n\n💾 ' + noteOne
      // 2026-09-29（作者の決定）: 課金の文は種類だけ（ID は1つ上の一覧で一度出している）。
      + '\n\nこの操作は元に戻せません。削除すると、クラスタの課金は止まります。保存場所は、ほかに使っているプロジェクトが無いときだけ止まります。よろしいですか？',
    )
    // 1件のときは「この保存場所」（従来どおり）
    const withOther = teardownConfirmMessage({
      targets: TARGETS, placements: [A], dataNote: noteOne, otherTargets: ['HANAMII'],
    })
    expect(withOther).toContain('この保存場所は HANAMII でも使っています。')
    expect(withOther).not.toContain('これらの保存場所')
  })

  it('★ 名前の無いもの（bucket が空）は数えない（空の『』を出さない）', () => {
    const msg = teardownConfirmMessage({
      targets: TARGETS, placements: [{ bucket: '' }, null, undefined, A], dataNote: teardownDataNote(A),
    })
    expect(msg).not.toContain('『』')
    expect(msg).toContain('『koto-data-a』')
  })

  it('★ 1件も無ければ、保存場所の話は一切出ない（消えるものが無い）', () => {
    for (const placements of [[], null, undefined, [{ bucket: '' }]]) {
      const msg = teardownConfirmMessage({ targets: TARGETS, placements, dataNote: noteAll, otherTargets: ['HANAMII'] })
      expect(msg).not.toContain('保存場所')
      expect(msg).not.toContain('HANAMII')
      expect(msg).not.toContain('💾')
    }
  })
})

describe('⑥の確認ダイアログ: 画面が純関数を通している（組み立て直していない）', () => {
  const panel = codeOnlyPanel(readFileSync(join(__dirname, '../src/renderer/components/AppRunDedicatedPanel.tsx'), 'utf8'))

  it('★ doTeardown は teardownConfirmMessage に placements（全件）と teardownDataNoteForAll を渡す', () => {
    // 2026-09-24 検分の指摘7: 「保存場所まで片づけるか」の判断は shared の純関数に置き、
    // 📡 一覧（scope:'list'）と⑥（scope:'full'）の両方がそこを通る。
    // 2026-09-25 検分の指摘15: ⑥は保存場所を**全件**片づけるので、確認の本文も全件（placements）。
    // **呼び出しの形ごと**見る（'placements,' だけを探すと、ほかの行にも当たって素通りする）。
    expect(panel).toContain(`const confirmMessage = teardownConfirmMessage({
      targets,
      placements,
      dataNote: teardownDataNoteForAll({ target: 'sakura-apprun-dedicated', scope: 'full', placements }),
      otherTargets,
    })`)
    // 先頭1件だけを渡す形へ戻っていないこと（この行が戻ると『B』が名指しされないまま消える）
    expect(panel).not.toContain("dataNote: teardownDataNoteFor({ target: 'sakura-apprun-dedicated', scope: 'full', placement }),")
    expect(panel).not.toContain('const placement = placements[0]')
    // 2026-09-24 検分の指摘2: 巻き添えになる公開先の名前は、公開記録を読むだけで足りる。
    expect(panel).toContain('const otherTargets = (await readPublishTargets(projectDir).catch(() => []))')
    expect(panel).toContain('otherTargets,')
    // 直す前の文面が残っていない（画面の中で組み立て直すと、テストが効かなくなる）
    expect(panel).not.toContain('この操作は元に戻せません。消さない限り課金が続きます。よろしいですか？')
  })
})

// ── 2026-09-24 検分の指摘1・2・4: ⑥を押し直せるか／巻き添えを言うか／幽霊を残さないか ────────

describe('⑥の確認ダイアログ: 保存場所を共有しているほかの公開先を名指しする（指摘2）', () => {
  const TARGETS = ['クラスタ『cluster-x』']
  const PLACEMENT = { bucket: 'koto-data-x', prefix: 'projects/myapp/', shared: true }

  it('★★ ほかの公開先が生きているときは、その名前と「データも消えます」を出す', () => {
    const msg = teardownConfirmMessage({
      targets: TARGETS, placements: [PLACEMENT], dataNote: teardownDataNote(PLACEMENT),
      otherTargets: ['HANAMII'],
    })
    expect(msg).toContain('HANAMII')
    expect(msg).toContain('データも消えます')
    // アプリそのものは消えない（消しすぎの誤解を生まない）
    expect(msg).toContain('アプリ自体は消えません')
  })

  it('★★ ほかの公開先が無ければ、その段落自体を出さない', () => {
    const msg = teardownConfirmMessage({
      targets: TARGETS, placements: [PLACEMENT], dataNote: teardownDataNote(PLACEMENT), otherTargets: [],
    })
    expect(msg).not.toContain('でも使っています')
  })

  it('★ 保存場所を使っていなければ、ほかの公開先の名前も出さない（消えるものが無い）', () => {
    const msg = teardownConfirmMessage({
      targets: TARGETS, placements: [], dataNote: '', otherTargets: ['HANAMII'],
    })
    expect(msg).not.toContain('HANAMII')
  })
})

describe('⑥「すべて削除する」を押し直せるか（指摘1）', () => {
  it('★★ 計算資源が空でも、保存場所だけ残っていればボタンを出す', () => {
    expect(shouldShowTeardownButton({ hasAnyResource: false, storageLeftoverBucket: 'koto-data-x' })).toBe(true)
  })

  it('★★ 計算資源も保存場所も無ければ出さない（押しても何も起きないボタンを作らない）', () => {
    expect(shouldShowTeardownButton({ hasAnyResource: false, storageLeftoverBucket: null })).toBe(false)
    expect(shouldShowTeardownButton({ hasAnyResource: false })).toBe(false)
    expect(shouldShowTeardownButton({ hasAnyResource: false, storageLeftoverBucket: '' })).toBe(false)
  })

  it('★ 計算資源があれば従来どおり出す', () => {
    expect(shouldShowTeardownButton({ hasAnyResource: true, storageLeftoverBucket: null })).toBe(true)
  })

  it('★★ 残っているバケット名と「もう一度押すと片づく」ことを言う', () => {
    const note = storageLeftoverNote('koto-data-x')
    expect(note).toContain('koto-data-x')
    expect(note).toContain('月額')
    expect(note).toContain('もう一度押す')
    expect(storageLeftoverNote(null)).toBe('')
    expect(storageLeftoverNote('')).toBe('')
  })
})

describe('破棄のあとに公開記録を片づけるか（指摘4・9・13）', () => {
  it('★★ 保存場所だけ失敗しても、アプリが消えていれば公開記録を片づける（📡の幽霊を防ぐ）', () => {
    expect(shouldClearPublishRecord({
      hadApplicationID: true, result: { ok: false, appDeleted: true },
    })).toBe(true)
  })

  it('★★ 計算資源の削除が途中で止まったら片づけない（アプリはまだ生きている）', () => {
    expect(shouldClearPublishRecord({
      hadApplicationID: true, result: { ok: false, appDeleted: false },
    })).toBe(false)
  })

  it('★ そもそもアプリを公開していなければ呼ばない', () => {
    expect(shouldClearPublishRecord({ hadApplicationID: false, result: { ok: true, appDeleted: true } })).toBe(false)
    expect(shouldClearPublishRecord({ hadApplicationID: true, result: null })).toBe(false)
  })

  it('★ appDeleted を持たない古い応答では ok に倒す（従来どおりの振る舞い）', () => {
    expect(shouldClearPublishRecord({ hadApplicationID: true, result: { ok: true } })).toBe(true)
    expect(shouldClearPublishRecord({ hadApplicationID: true, result: { ok: false } })).toBe(false)
  })
})
