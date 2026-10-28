import { describe, it, expect, vi } from 'vitest'
import { runCreate, runPublishApp, shouldShowCreateResult, shouldShowTeardownResult, shouldShowPublishSection } from '../src/renderer/apprunDedicatedActions'
import { panelBusy, panelBusyReason } from '../src/renderer/apprunDedicatedActions'
import { buildTeardownConfirmBody } from '../src/renderer/teardown/confirm'
import { shouldShowTeardownButton, storageLeftoverNote } from '../src/renderer/apprunDedicatedActions'
import { teardownDataNote, teardownDataNoteForAll, dedicatedStorageLeftoverNames } from '../src/shared/teardownSupport'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// apprunDedicatedActions.test.ts — AppRunDedicatedPanel.tsx の「確認→IPC」を、React/DOM から
// 切り離して振る舞いで固定する（2026-09-10 レビューの修理・J・tests/rollbackSwitch.test.ts と同型）。
// confirm・create を注入で受け取るので jsdom は要らない。「confirm が false（キャンセル）を
// 返したとき、create が一度も呼ばれないこと」を偽の関数の呼び出し回数で確かめる
// （文字列一致ではない・掟10）。
//
// 0.6.22 段階3B-7: 破棄（手順6・📡 の 🗑）の「確認 → IPC」（runTeardown）と、確認の本文を作る teardownConfirmMessage は、
// 3つの公開先で共通の流れ・文（teardown/flow.ts・teardown/confirm.ts）の1つになった。ここにあった runTeardown の5件は、
// tests/teardownFlowCommon.test.ts の A に1対1で移っている（下の表）。確認の本文の試験は、同じ期待のまま buildTeardownConfirmBody に向け直した。
//
//   runTeardown の試験（消した）                                    → 共通の流れの試験（tests/teardownFlowCommon.test.ts）
//   1 confirm が false → teardown 0回・{cancelled:true}・begin/end 0回  → A-1（確認 no。invoke 0回・begin 0回・loadAuth 0回）と A-3（答えが true 以外 8通り）
//   2 confirm が true → { confirmed: true } で1回だけ・結果を返す      → A-2（invoke が { confirmed: true } 付きで1回・beginActivity 1回・end 1回）
//   3 confirm に req.confirmMessage がそのまま渡る                    → 「確認に出した文は buildTeardownConfirm の出力そのもの。確認は1回だけ」
//   4 begin → teardown → end の順                                     → A-8（材料 → 確認 → 活動レジストリに載せる → onStart → キー → IPC → 外す）
//   5 teardown が reject しても end は1回                            → A-5（IPC が例外 → 投げ直す・end は1回）と A-5b（キーの読み込みが例外でも end は1回）

// 専有型の確認の本文（手順6・📡 の 🗑 の確認で同じ）。専有型の言葉（verb 削除・課金は止まると言う・元に戻せませんは常に言う）で共通の本文作りを呼ぶ。
const confirmBody = (o: {
  targets: string[]
  placements: Array<{ bucket: string; prefix?: string; shared?: boolean } | null | undefined> | null | undefined
  dataNote: string
  otherTargets?: string[]
  waitNote?: string
}): string => buildTeardownConfirmBody({ verb: '削除', claimsComputeBillingStops: true, irreversibleNote: 'always', ...o })

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

// ── B-2（2026-09-10 実機・Ryosuke さん指摘「消した後の表示が変」） ──────────────────────
//
// 破棄（手順6）が成功して記録（apprunState）が空になったのに、手順5の節に古い「✅ 作成できました」
// （前回の createResult）がそのまま出続けていた。かつ、手順6の結果表示自体も「記録がある間だけ」
// 描く節の中にあったため、破棄が完了した瞬間に自分の「✅ すべて削除しました」も一緒に消えていた。
// shouldShowCreateResult / shouldShowTeardownResult は、この2つの表示判断を React/DOM から
// 切り離した純関数として固定する（掟10）。

describe('shouldShowCreateResult: 手順5の結果ブロックを出すか', () => {
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

describe('shouldShowTeardownResult: 手順6の結果ブロックを出すか', () => {
  it('teardownResult が無ければ出さない', () => {
    expect(shouldShowTeardownResult(null)).toBe(false)
    expect(shouldShowTeardownResult(undefined)).toBe(false)
  })

  it('teardownResult があれば、ok/ng を問わず常に出す（手順6の節＝hasAnyResourceの有無に関係なく。記録が空になっても結果自体は隠さない）', () => {
    expect(shouldShowTeardownResult({ ok: true, executed: [], message: 'ok', remaining: {} })).toBe(true)
    expect(shouldShowTeardownResult({ ok: false, executed: [], message: 'ng', remaining: {} })).toBe(true)
    // inProgress で止まったときも同様（値の形そのものは見ない＝「今の値をそのまま出すか」だけを判定する）。
    expect(shouldShowTeardownResult({ ok: false, executed: [], message: 'ng', remaining: {}, inProgress: { loadBalancerID: 'l1' } })).toBe(true)
  })
})

// ── D-4（2026-09-15）: 手順8「アプリを公開する」──────────────────────────────────────
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
describe('shouldShowPublishSection: 手順8の節はクラスタ・ASG・LB の3つが揃っているときだけ出す', () => {
  it('記録が無ければ出さない（null / undefined / 空）', () => {
    expect(shouldShowPublishSection(null)).toBe(false)
    expect(shouldShowPublishSection(undefined)).toBe(false)
    expect(shouldShowPublishSection({})).toBe(false)
    expect(shouldShowPublishSection({ clusterID: null, asgID: null, loadBalancerID: null })).toBe(false)
  })

  it('一部だけ（手順5の途中で止まった状態）では出さない（shouldShowCreateResult の OR とは違う・AND）', () => {
    expect(shouldShowPublishSection({ clusterID: 'c1' })).toBe(false)
    expect(shouldShowPublishSection({ clusterID: 'c1', asgID: 'a1' })).toBe(false)
    expect(shouldShowPublishSection({ asgID: 'a1', loadBalancerID: 'l1' })).toBe(false)
    expect(shouldShowPublishSection({ clusterID: 'c1', asgID: 'a1', loadBalancerID: '' })).toBe(false)
  })

  it('3つ揃っていれば出す', () => {
    expect(shouldShowPublishSection({ clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })).toBe(true)
  })
})

// ── H-1（2026-09-17）: 手順5・6・7・8 を同時に走らせない ────────────────────────────────
// 横断点検（6視点）のうち4つが独立に同じ欠陥へ収束した。手順6の破棄は実測で約9分かかり、
// そのあいだ手順8「公開する」が押せていた。割り込むと記録が交錯し、applicationID があるのに
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
    expect(panelBusyReason({ tearingDown: true })).toContain('手順6')
    expect(panelBusyReason({ publishing: true })).toContain('手順8')
    expect(panelBusyReason({ creating: true })).toContain('手順5')
    for (const reason of [panelBusyReason({ tearingDown: true }), panelBusyReason({ publishing: true }), panelBusyReason({ creating: true })]) {
      expect(reason, '案内に丸数字が戻っている（2026-10-07・作者の決定）').not.toMatch(/[①-⑳]/)
    }
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

describe('画面の配線: 手順5・6・7・8 の操作はすべて panelBusy で止まる', () => {
  const panel = codeOnlyPanel(readFileSync(join(__dirname, '../src/renderer/components/AppRunDedicatedPanel.tsx'), 'utf8'))
  // 0.6.22 段階3B-6a: 手順6のボタンと流れの入口は節（DedicatedTeardownSection.tsx）にある。パネルは panelBusy の答えを `locked` として渡す。
  const section = codeOnlyPanel(readFileSync(join(__dirname, '../src/renderer/components/DedicatedTeardownSection.tsx'), 'utf8'))
  const BUSY = 'panelBusy({ creating, tearingDown, publishing, lbRefreshing })'

  it('★ 手順8の公開ボタンが、破棄の最中でも無効になる（今回の穴そのもの）', () => {
    expect(panel).toContain(`disabled={publishErrors.length > 0 || ${BUSY}}`)
    // 直す前の形（publishing しか見ない）を禁じる。
    expect(panel).not.toContain('disabled={publishErrors.length > 0 || publishing}')
  })

  it('★ 手順6の破棄ボタンが、公開の最中でも無効になる（逆向き）', () => {
    // パネルが panelBusy の答えを `locked` で渡し、節のボタンが `disabled={locked}` で受ける（どちらかが欠けると、公開の最中に押せてしまう）
    expect(panel).toContain(`locked={${BUSY}}`)
    expect(section).toContain('disabled={locked}')
    expect(panel).not.toContain('disabled={tearingDown}')
    expect(section).not.toContain('disabled={tearingDown}')
  })

  it('★ 手順5の作成ボタン・IP の取り直しも同じ判定を通る', () => {
    expect(panel).toContain(`disabled={hasErrors || ${BUSY}}`)
    expect(panel).not.toContain('disabled={hasErrors || creating}')
    expect(panel).not.toContain('disabled={lbRefreshing}')
  })

  it('★ 手順7のつなぐボタンも同じ判定を通る', () => {
    expect(panel).toContain(`disabled={telemetryBusyKind === kind || ${BUSY}}`)
    expect(panel).not.toContain('disabled={telemetryBusyKind === kind || tearingDown}')
  })

  it('★ ボタンを無効にするだけでなく、実行の入口（早期 return）も同じ判定を通る', () => {
    expect(panel).toContain(`if (hasErrors || ${BUSY}) return`)
    // 手順6: 流れの入口（節のフック）が、渡された `locked`（＝上の panelBusy の答え）を見て早期 return する
    expect(section).toContain('if (startedRef.current || panelRef.current.locked) return')
    expect(panel).toContain(`if (publishErrors.length > 0 || ${BUSY} || !appStatus) return`)
  })

  it('★ 押せないときに、理由の一言を出す', () => {
    expect(panel).toContain('panelBusyReason({ creating, tearingDown, publishing, lbRefreshing })')
  })
})

// ── 手順6の確認ダイアログの文面（2026-09-24 Ryosuke 決定「(1)は案2・一貫性が重要」）────────────
//
// 案2 では手順6の破棄で**利用者のデータが実際に消える**。それを名指ししない確認は嘘になる。
// 以前の文面は「次を削除します: アプリ…・クラスタ…／この操作は元に戻せません。
// 消さない限り課金が続きます。」で、**保存場所が一覧に入っていなかった。**

describe('手順6の確認ダイアログ: 保存場所を名指しする（案2）', () => {
  const TARGETS = ['アプリ『myapp』', 'ロードバランサ『lb-z』', 'クラスタ『cluster-x』']
  const PLACEMENT = { bucket: 'koto-data-x', prefix: 'projects/myapp/', shared: true }

  // W-14（2026-09-27 決定）: 「（中のデータも消えます）」は保存場所そのものが丸ごと消えると
  // 読めてしまうため「にある、このプロジェクトのデータ」に直した（wording-review.md W-14 の注意）。
  it('★★ 保存場所があるとき、一覧に名前が入り「このプロジェクトのデータ」と言う', () => {
    const msg = confirmBody({
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
    const msg = confirmBody({
      targets: TARGETS,
      placements: [PLACEMENT],
      dataNote: teardownDataNote(PLACEMENT),
    })
    expect(msg).toContain('ほかのプロジェクトのデータ')
    expect(msg).toContain('あなたが自分で置いたファイルは残します')
    expect(msg).toContain('ほかに無ければ')
  })

  it('★★ 保存場所が無いときは、一覧にも本文にも保存場所が出ない', () => {
    const msg = confirmBody({ targets: TARGETS, placements: [], dataNote: '' })
    expect(msg).not.toContain('保存場所')
    expect(msg).not.toContain('データも消えます')
    for (const t of TARGETS) expect(msg).toContain(t)
  })

  // W-14（2026-09-27 決定）: 「ここに挙げたものの月額の課金は止まります」という固定の言い切りはやめ、
  // targets から組み立てた「〜の課金は止まります」にした（固定文言ではなくなったので、
  // 部分一致は語尾の「の課金は止まります」だけを見る）。
  it('★ 「消さない限り課金が続きます」ではなく、止まる側の説明にする', () => {
    for (const placement of [PLACEMENT, null]) {
      const msg = confirmBody({ targets: TARGETS, placements: placement ? [placement] : [], dataNote: teardownDataNote(placement) })
      expect(msg).not.toContain('消さない限り課金が続きます')
      expect(msg).toContain('の課金は止まります')
      expect(msg).toContain('この操作は元に戻せません')
    }
  })

  it('画面には素のテキストとして出る（Markdown 記法を使わない・v0.2.98 の教訓）', () => {
    const msg = confirmBody({ targets: TARGETS, placements: [PLACEMENT], dataNote: teardownDataNote(PLACEMENT) })
    expect(msg).not.toMatch(/\*\*|__|`/)
  })
})

// ── 手順6の確認ダイアログ: 消える保存場所を**全件**名指しする（2026-09-25 検分の指摘15・V6）──
//
// 手順6の破棄は `teardownStorageForProject` が、確認で見せた保存場所だけを消す（見せるのは env.json の同意済みの**全件**。0.6.24 F）。
// ところが確認の本文は `storage:placement` の先頭1件だけで組み立てていたので、2件ある状態では
// 『A』しか出ないまま、**名前が一度も出なかった『B』とその中のデータまで消えた**。
// 元に戻せない削除を、名指ししないまま実行させてはいけない（掟10「お金・破壊の歯止め」）。

describe('手順6の確認ダイアログ: 保存場所が2件あるとき、両方を名指しする（指摘15）', () => {
  const TARGETS = ['クラスタ『cluster-x』']
  const A = { bucket: 'koto-data-a', prefix: 'projects/myapp/', shared: true }
  const B = { bucket: 'koto-data-b', prefix: 'projects/myapp/', shared: true }
  const noteAll = teardownDataNoteForAll({ target: 'sakura-apprun-dedicated', placements: [A, B] })

  it('★★ 削除するものの一覧に『A』と『B』が両方入る（先頭1件で終わらない）', () => {
    const msg = confirmBody({ targets: TARGETS, placements: [A, B], dataNote: noteAll })
    const first = msg.split('\n\n')[0]
    expect(first, '『A』が一覧に無い').toContain('『koto-data-a』')
    expect(first, '『B』が一覧に無い＝名指ししないまま消す').toContain('『koto-data-b』')
    // W-14（2026-09-27 決定）: 「（中のデータも消えます）」→「にある、このプロジェクトのデータ」
    expect(first).toContain('にある、このプロジェクトのデータ')
  })

  it('★★ 「ほか1件」のように省かない（省いた名前は、利用者にとって存在しないのと同じ）', () => {
    const msg = confirmBody({ targets: TARGETS, placements: [A, B], dataNote: noteAll })
    expect(msg).not.toMatch(/ほか\s*\d+\s*件/)
    expect(msg).not.toContain('…')
  })

  it('★★ 💾 の行（何が残るかの約束）も全件の名前を出す', () => {
    const msg = confirmBody({ targets: TARGETS, placements: [A, B], dataNote: noteAll })
    const dataLine = msg.split('\n\n').find(x => x.startsWith('💾 '))
    expect(dataLine, '💾 の行が無い').toBeTruthy()
    expect(dataLine!).toContain('『koto-data-a』')
    expect(dataLine!).toContain('『koto-data-b』')
  })

  it('★★ ほかの公開先の巻き添えも、2件のときは「これらの保存場所」と言う', () => {
    const msg = confirmBody({
      targets: TARGETS, placements: [A, B], dataNote: noteAll, otherTargets: ['HANAMII'],
    })
    // T161（作者の決定・0.6.22 段階3B-3）: 公開先の名前を2回並べず「そちらで」にまとめた。部分一致は「でも使っているため」と「データも消えます」に分けて見る
    expect(msg).toContain('これらの保存場所は HANAMII でも使っているため、')
    expect(msg).toContain('そちらで公開中のアプリのデータも消えます（アプリ自体は消えません）。')
  })

  // W-14（2026-09-27 決定）でこの全文の固定文言を組み立て式に直したため、期待値も新しい文面に更新
  // （テストの狙い＝1件と2件で組み立てが同じであることは変えていない）。
  it('★★ 1件のときの文面は、直したあとの形で固定する（文言を二重管理しない）', () => {
    const noteOne = teardownDataNoteForAll({ target: 'sakura-apprun-dedicated', placements: [A] })
    const msg = confirmBody({ targets: TARGETS, placements: [A], dataNote: noteOne })
    expect(msg).toBe(
      '次を削除します: クラスタ『cluster-x』・保存場所『koto-data-a』にある、このプロジェクトのデータ'
      + '\n\n💾 ' + noteOne
      // 2026-09-29（作者の決定）: 課金の文は種類だけ（ID は1つ上の一覧で一度出している）。
      + '\n\nこの操作は元に戻せません。削除すると、クラスタの課金は止まります。保存場所は、ほかに使っているプロジェクトが無いときだけ止まります。よろしいですか？',
    )
    // 1件のときは「この保存場所」（従来どおり）
    const withOther = confirmBody({
      targets: TARGETS, placements: [A], dataNote: noteOne, otherTargets: ['HANAMII'],
    })
    expect(withOther).toContain('この保存場所は HANAMII でも使っているため、')
    expect(withOther).toContain('そちらで公開中のアプリのデータも消えます')
    expect(withOther).not.toContain('これらの保存場所')
  })

  it('★ 名前の無いもの（bucket が空）は数えない（空の『』を出さない）', () => {
    const msg = confirmBody({
      targets: TARGETS, placements: [{ bucket: '' }, null, undefined, A], dataNote: teardownDataNote(A),
    })
    expect(msg).not.toContain('『』')
    expect(msg).toContain('『koto-data-a』')
  })

  it('★ 1件も無ければ、保存場所の話は一切出ない（消えるものが無い）', () => {
    for (const placements of [[], null, undefined, [{ bucket: '' }]]) {
      const msg = confirmBody({ targets: TARGETS, placements, dataNote: noteAll, otherTargets: ['HANAMII'] })
      expect(msg).not.toContain('保存場所')
      expect(msg).not.toContain('HANAMII')
      expect(msg).not.toContain('💾')
    }
  })
})

describe('専有型の確認ダイアログ: 画面は文を組み立てず、共通の1つの関数（buildTeardownConfirm → buildTeardownConfirmBody）を通す', () => {
  const panel = codeOnlyPanel(readFileSync(join(__dirname, '../src/renderer/components/AppRunDedicatedPanel.tsx'), 'utf8'))
  const section = codeOnlyPanel(readFileSync(join(__dirname, '../src/renderer/components/DedicatedTeardownSection.tsx'), 'utf8'))
  const confirm = codeOnlyPanel(readFileSync(join(__dirname, '../src/renderer/teardown/confirm.ts'), 'utf8'))
  const facts = codeOnlyPanel(readFileSync(join(__dirname, '../src/renderer/teardown/facts.ts'), 'utf8'))
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const f = join(dir, e.name)
    return e.isDirectory() ? walk(f) : /\.(ts|tsx)$/.test(e.name) ? [f] : []
  })

  it('★ 確認の文を作るのは confirm.ts の1か所。本文の組み立てに placements（全件）と teardownDataNoteForAll を渡す', () => {
    // 2026-09-24 検分の指摘7: 「保存場所まで片づけるか」の判断は shared の純関数に置く。専有型の削除は
    // 2026-10-08 から、手順6も 📡 の 🗑 も保存場所まで片づける（0.6.22 段階3B-3 で入口の範囲 scope をやめた。公開先だけで決まる）。
    // 2026-09-25 検分の指摘15: 保存場所は**全件**片づけるので、確認の本文も全件（placements）。
    // **呼び出しの形ごと**見る（'placements,' だけを探すと、ほかの行にも当たって素通りする）。
    expect(confirm).toContain(`const body = buildTeardownConfirmBody({
    verb: spec.words.verb,
    targets: spec.targets(facts.record),
    placements: facts.placements,
    dataNote: teardownDataNoteForAll({ target: spec.target, placements: facts.placements }),
    otherTargets: facts.otherTargets,`)
    // 先頭1件だけを渡す形へ戻っていないこと（この行が戻ると『B』が名指しされないまま消える）
    expect(confirm).not.toContain('teardownDataNoteFor({ target')
    expect(confirm).not.toContain('placements[0]')
    // 直す前の文面が残っていない
    expect(confirm).not.toContain('この操作は元に戻せません。消さない限り課金が続きます。よろしいですか？')
  })

  it('★ ほかの公開先の名前は、読めなかったら投げる読み口（旧い記録の分も数える）で読む。空に倒す readPublishTargets に戻さない', () => {
    // 2026-09-24 検分の指摘2: 巻き添えになる公開先の名前は、公開記録を読むだけで足りる（材料の読み方も共有）。
    // 2026-10-08 検分 A: 読めなかったら**投げる**版（空に倒すと、「ほかの公開先の記録を読めなかった」注意が本物の口では立たない）。
    expect(facts).toContain('otherTargets: async (dir, self) => (await readPublishTargetsWithLegacyOrThrow(dir))')
    expect(facts).not.toMatch(/\breadPublishTargets\b/)
    expect(facts).not.toMatch(/\breadPublishTargetsOrThrow\b/)
  })

  it('★ 画面（パネル・節）には確認の文を組み立てる処理が無い（組み立て直すと、📡 と食い違う）。手順6の削除は節が共通の流れ runTeardownFlow で行う', () => {
    for (const [name, src] of [['パネル', panel], ['節', section]] as const) {
      expect(src, name).not.toContain('buildTeardownConfirmBody(')
      expect(src, name).not.toContain('buildTeardownConfirm(')
      expect(src, name).not.toContain('teardownDataNoteForAll(')
      expect(src, name).not.toContain('readPublishTargets(')
    }
    expect(section).toContain('runTeardownFlow(projectDir, dedicatedTeardownSpec, electronFlowDeps(projectDir, dedicatedTeardownSpec, {')
  })

  it('★ buildTeardownConfirmBody を定義するのは confirm.ts だけ。呼ぶのは buildTeardownConfirm だけ（確認の文を作る関数は1つ）', () => {
    const files = walk(join(__dirname, '../src'))
    const defs = files.filter(f => /\bfunction\s+buildTeardownConfirmBody\b/.test(codeOnlyPanel(readFileSync(f, 'utf8'))))
    expect(defs.map(f => f.split('/src/')[1])).toEqual(['renderer/teardown/confirm.ts'])
    const callers = files.filter(f => codeOnlyPanel(readFileSync(f, 'utf8')).includes('buildTeardownConfirmBody({'))
    expect(callers.map(f => f.split('/src/')[1])).toEqual(['renderer/teardown/confirm.ts'])
    // confirm.ts の中で呼ぶのは buildTeardownConfirm の1か所だけ
    expect(confirm.split('buildTeardownConfirmBody({').length - 1).toBe(1)
    const insideConfirm = confirm.slice(confirm.indexOf('export function buildTeardownConfirm<'))
    expect(insideConfirm).toContain('const body = buildTeardownConfirmBody({')
  })

  it('★ 手本の名前（teardownConfirmMessage・buildDedicatedTeardownConfirm・runDedicatedTeardown）が src のどこにも無い', () => {
    for (const f of walk(join(__dirname, '../src'))) {
      const code = codeOnlyPanel(readFileSync(f, 'utf8'))
      for (const gone of ['teardownConfirmMessage', 'buildDedicatedTeardownConfirm', 'runDedicatedTeardown']) {
        expect(new RegExp(`\\b${gone}\\b`).test(code), `${f.split('/src/')[1]} に ${gone}`).toBe(false)
      }
    }
  })
})

// ── 2026-09-24 検分の指摘1・2・4: 手順6を押し直せるか／巻き添えを言うか／幽霊を残さないか ────────

describe('手順6の確認ダイアログ: 保存場所を共有しているほかの公開先を名指しする（指摘2）', () => {
  const TARGETS = ['クラスタ『cluster-x』']
  const PLACEMENT = { bucket: 'koto-data-x', prefix: 'projects/myapp/', shared: true }

  it('★★ ほかの公開先が生きているときは、その名前と「データも消えます」を出す', () => {
    const msg = confirmBody({
      targets: TARGETS, placements: [PLACEMENT], dataNote: teardownDataNote(PLACEMENT),
      otherTargets: ['HANAMII'],
    })
    expect(msg).toContain('HANAMII')
    expect(msg).toContain('でも使っているため')
    expect(msg).toContain('データも消えます')
    // アプリそのものは消えない（消しすぎの誤解を生まない）
    expect(msg).toContain('アプリ自体は消えません')
  })

  it('★★ ほかの公開先が無ければ、その段落自体を出さない', () => {
    const msg = confirmBody({
      targets: TARGETS, placements: [PLACEMENT], dataNote: teardownDataNote(PLACEMENT), otherTargets: [],
    })
    expect(msg).not.toContain('でも使っているため')
    expect(msg).not.toContain('データも消えます')
  })

  it('★ 保存場所を使っていなければ、ほかの公開先の名前も出さない（消えるものが無い）', () => {
    const msg = confirmBody({
      targets: TARGETS, placements: [], dataNote: '', otherTargets: ['HANAMII'],
    })
    expect(msg).not.toContain('HANAMII')
  })
})

describe('手順6「すべて削除する」を押し直せるか（指摘1）', () => {
  it('★★ 計算資源が空でも、保存場所だけ残っていればボタンを出す', () => {
    expect(shouldShowTeardownButton({ record: { storageLeftoverBucket: 'koto-data-x' } })).toBe(true)
  })

  it('★★ 計算資源も保存場所も無ければ出さない（押しても何も起きないボタンを作らない）', () => {
    expect(shouldShowTeardownButton({ record: { storageLeftoverBucket: null } })).toBe(false)
    expect(shouldShowTeardownButton({ record: {} })).toBe(false)
    expect(shouldShowTeardownButton({ record: null })).toBe(false)
    expect(shouldShowTeardownButton({})).toBe(false)
    expect(shouldShowTeardownButton({ record: { storageLeftoverBucket: '' } })).toBe(false)
  })

  it('★ 計算資源があれば従来どおり出す', () => {
    expect(shouldShowTeardownButton({ record: { clusterID: 'c1', storageLeftoverBucket: null } })).toBe(true)
  })

  // 2026-10-08 検分 E: 手順6のボタンは、📡 の 🗑 が破壊の確認を出す判断（dedicatedTeardownHasWork）と同じ1つ。
  // アプリのID だけの記録も「消すもの」に数える（以前は手順6だけが クラスタ・ASG・LB の3つで判断していた）。
  it('★★ アプリのIDだけの記録でも出す（📡 の 🗑 と同じ判断）', () => {
    expect(shouldShowTeardownButton({ record: { applicationID: 'app1' } })).toBe(true)
  })

  it('★★ 残っているバケット名と「もう一度押すと片づく」ことを言う', () => {
    const note = storageLeftoverNote(['koto-data-x'])
    expect(note).toContain('koto-data-x')
    expect(note).toContain('月額')
    expect(note).toContain('もう一度押す')
    // 1件のときの文は、全件を言う形にしても1文字も変えない（B=2・段階3B-2）
    expect(note).toBe('保存場所『koto-data-x』だけが残っています（消すまで月額が続きます）。もう一度押すと削除します。')
    expect(storageLeftoverNote(null)).toBe('')
    expect(storageLeftoverNote([])).toBe('')
  })

  it('★★★ 残りが2件なら両方の名前を言う（先頭の1件だけだと、もう1件の月額が黙って続く）。名前は記録から全件を読む', () => {
    expect(storageLeftoverNote(['koto-a', 'koto-b'])).toBe('保存場所『koto-a』『koto-b』だけが残っています（消すまで月額が続きます）。もう一度押すと削除します。')
    expect(storageLeftoverNote(dedicatedStorageLeftoverNames({ storageLeftoverBucket: 'koto-a', storageLeftoverBuckets: ['koto-a', 'koto-b'] })))
      .toContain('『koto-a』『koto-b』')
    // 旧い記録（storageLeftoverBuckets が無い）は1件
    expect(storageLeftoverNote(dedicatedStorageLeftoverNames({ storageLeftoverBucket: 'koto-a' }))).toContain('『koto-a』だけが')
    expect(storageLeftoverNote(dedicatedStorageLeftoverNames({ storageLeftoverBucket: null, storageLeftoverBuckets: null }))).toBe('')
  })
})

// 破棄のあとに公開記録（publish.targets）を片づけるかの判断（指摘4・9・13）は、2026-10-08 から画面には無い。
// main の apprunDedicated:teardown の1か所（shouldForgetPublishRecord）。真理値表は tests/ops-dedicated-teardown.test.ts。
