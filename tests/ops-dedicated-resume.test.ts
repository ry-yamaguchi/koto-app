import { describe, it, expect, beforeEach } from 'vitest'
import { withProjectLock } from '../src/main/projectLock'
import { getOps, ackOps, setProjectOpsListener, reportProgress, resetProjectOpsForTests, summarizeResult } from '../src/main/projectOps'
import {
  watchDedicatedOps, dedicatedOpKind, resumedCreateResult, resumedTeardownResult, resumedPublishResult, resumedNoteOf,
  addResumedNotes, opProgressText, opElapsedText, otherOpNote, shouldShowTeardownButton,
  TEARDOWN_REMAINING_WARNING_HEAD, TEARDOWN_IN_PROGRESS_WARNING_HEAD,
  type DedicatedRunningView, type DedicatedFinished, type DedicatedOpsApi, type DedicatedOpKind,
} from '../src/renderer/apprunDedicatedActions'

// ── 専有型⑤作成・⑥すべて削除・⑧公開: 閉じて開き直したとき、続きと結果を出す（2026-09-29・作者の決定 ①②）──────
//
// 公開のダイアログを閉じても、処理は main が最後まで進める（withProjectLock）。失われていたのは画面の表示だけ
// ——進み具合・結果・「保存場所が残ったので月額が続きます」のような警告——なので、開き直したとき main の記録
// （window.electronAPI.projectOps）を読んで続きを出す。
//
// ここは**振る舞いのテスト**（掟10）。偽の electronAPI.projectOps は、**本物の main の記録**
// （src/main/projectOps.ts の getOps／ackOps／押し出し）の上に作る——ack が「その記録まで」の累積であること・
// earlier／last の分かれ方・押し出しの形を、テストが勝手に決めない。main の処理は本物の withProjectLock で走らせる。
// 「コンポーネントを外して付け直す」は、watchDedicatedOps を stop して新しく作り直すこと
// （React の付け外しはこの部品の付け外しそのもの。画面の配線は tests/ops-dedicated-wiring.test.ts）。

const DIR = '/tmp/koto-ops-dedicated-project'
const OTHER_DIR = '/tmp/koto-ops-dedicated-other'

type Push = { projectDir: string } & ProjectOpsSnapshotShape

/** 偽の window.electronAPI.projectOps。本物の記録（projectOps.ts）へ流す。 */
function makeApi() {
  const subs = new Set<(p: Push) => void>()
  const acks: Array<[string, number | undefined]> = []
  setProjectOpsListener((projectDir, snapshot) => { for (const cb of [...subs]) cb({ projectDir, ...snapshot }) })
  const api: DedicatedOpsApi = {
    get: async (dir: string) => getOps(dir),
    ack: async (dir: string, upTo?: number) => { acks.push([dir, upTo]); return { ok: true, acked: ackOps(dir, upTo) } },
    onChanged: cb => { subs.add(cb); return () => { subs.delete(cb) } },
  }
  return { api, subs, acks }
}

/** 画面を開く（付ける）。届いたものを溜める。 */
function mount(api: DedicatedOpsApi, dir = DIR, isVisible?: () => boolean) {
  const running: DedicatedRunningView[] = []
  const finished: DedicatedFinished[][] = []
  const watch = watchDedicatedOps({ api, projectDir: dir, onRunning: v => running.push(v), onFinished: f => finished.push(f), ...(isVisible ? { isVisible } : {}) })
  return {
    watch,
    running,
    finished,
    lastRunning: () => running[running.length - 1] ?? null,
    allFinished: () => finished.flat(),
  }
}
/** 非同期の応答（get の Promise・ack）が流れるのを待つ。 */
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(r => setTimeout(r, 0)) }

const HANDLER: Record<DedicatedOpKind, { op: '作成' | '削除' | '公開'; handler: string }> = {
  create: { op: '作成', handler: 'apprunDedicated:create' },
  teardown: { op: '削除', handler: 'apprunDedicated:teardown' },
  publish: { op: '公開', handler: 'apprunDedicated:publishApp' },
}

/**
 * main の操作を1つ走らせる（本物の withProjectLock）。`release()` するまで終わらない。
 * 走らせたあとの進み具合は `progress()` で足す。
 */
function startOp(kind: DedicatedOpKind, result: unknown, dir = DIR) {
  let release!: () => void
  const gate = new Promise<void>(open => { release = open })
  const { op, handler } = HANDLER[kind]
  const done = withProjectLock(dir, op, async () => { await gate; return result }, { target: 'sakura-apprun-dedicated', handler })
  return { release, done, progress: (m: string) => reportProgress(dir, m) }
}
/** 別の公開先（Vercel など）の操作を1つ走らせる。 */
function startForeignOp(dir = DIR, handler = 'vercel:publish', target: 'vercel' | 'sakura-apprun-dedicated' = 'vercel') {
  let release!: () => void
  const gate = new Promise<void>(open => { release = open })
  const done = withProjectLock(dir, '公開', async () => { await gate; return { ok: true } }, { target, handler })
  return { release, done }
}
async function finish(op: { release: () => void; done: Promise<unknown> }) { op.release(); await op.done }

beforeEach(() => { resetProjectOpsForTests() })

describe('★★★ 走っていれば、外して付け直しても進み具合が出る', () => {
  it('⑥が走っている最中に付け直すと、走っていることと最新の進み具合が出る（外している間に進んだ分も）', async () => {
    const { api } = makeApi()
    const op = startOp('teardown', { ok: true, executed: [], message: '', remaining: {} })
    op.progress('ロードバランサの削除を待っています（1分経過）。実測ではおよそ9分でした（目安です）。')

    const first = mount(api)
    await flush()
    expect(first.lastRunning()?.running?.kind).toBe('teardown')
    expect(opProgressText(first.lastRunning()!.running!.record)).toContain('（1分経過）')

    // ダイアログを閉じる（外す）。処理は止まらず、進み具合だけが進む。
    first.watch.stop()
    op.progress('ロードバランサの削除を待っています（5分経過）。実測ではおよそ9分でした（目安です）。')
    const seenWhileClosed = first.running.length

    // 開き直す（付け直す）。続きから最新が出る。
    const second = mount(api)
    await flush()
    expect(second.lastRunning()?.running?.kind).toBe('teardown')
    expect(opProgressText(second.lastRunning()!.running!.record)).toBe('ロードバランサの削除を待っています（5分経過）。実測ではおよそ9分でした（目安です）。')
    // 外したほうには何も届かない（アンマウント後に state を書かない）
    expect(first.running.length).toBe(seenWhileClosed)
    expect(second.allFinished()).toEqual([])

    await finish(op)
  })

  it('⑤・⑧も同じ（種類が分かり、経過の材料 startedAt がある）', async () => {
    for (const kind of ['create', 'publish'] as const) {
      resetProjectOpsForTests()
      const { api } = makeApi()
      const op = startOp(kind, { ok: true })
      op.progress('進んでいます')
      const m = mount(api)
      await flush()
      const view = m.lastRunning()!
      expect(view.running?.kind).toBe(kind)
      expect(typeof view.running?.record.startedAt).toBe('number')
      expect(view.other).toBeNull()
      m.watch.stop()
      await finish(op)
    }
  })

  it('走っている間に届く押し出し（開いている間）で、進み具合が更新される', async () => {
    const { api } = makeApi()
    const op = startOp('publish', { ok: true })
    const m = mount(api)
    await flush()
    op.progress('ロードバランサの IP が付くのを待っています（10秒経過）。実測では、クラスタを作った約2分後はまだ空で、数分後に付いていました（目安です）。')
    expect(opProgressText(m.lastRunning()!.running!.record)).toContain('（10秒経過）')
    op.progress('🩺 アプリが応答するか確かめています…')
    expect(opProgressText(m.lastRunning()!.running!.record)).toBe('🩺 アプリが応答するか確かめています…')
    await finish(op)
    // 終わったら走っていない
    expect(m.lastRunning()).toEqual({ running: null, other: null })
  })
})

describe('★★★ 終わっていれば、外して付け直したとき結果と警告が出る。ack のあとは出ない', () => {
  const TEARDOWN_STORAGE_LEFT = {
    ok: false,
    executed: ['アプリケーション『app1』を削除しました（消えたことを確認）', '⚠️ 保存場所の記録（公開の設定）は残しています。次に公開する前に、③「保存場所を用意する」からやり直してください'],
    message: '保存場所を片づけられませんでした: 403',
    remaining: { storageBucket: 'koto-data-x' },
    appDeleted: true,
  }

  it('⑥が閉じている間に終わった: 付け直すと結果（残った保存場所）と警告（⚠️の行）が出る。警告つきなので、画面は ack しない', async () => {
    const { api, acks } = makeApi()
    const op = startOp('teardown', TEARDOWN_STORAGE_LEFT)
    const first = mount(api)
    await flush()
    first.watch.stop() // 閉じる
    await finish(op) // 閉じている間に終わる

    const second = mount(api)
    await flush()
    const items = second.allFinished()
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('teardown')

    // 結果欄（既存の⑥の結果欄がそのまま描ける形）: 残った保存場所が名指しで入っている
    const typed = resumedTeardownResult(items[0].record)
    expect(typed.ok).toBe(false)
    expect(typed.remaining).toEqual({ storageBucket: 'koto-data-x' })
    expect(typed.executed).toEqual(['アプリケーション『app1』を削除しました（消えたことを確認）'])
    expect(typed.message).toContain('保存場所を片づけられませんでした')
    expect(typed.appDeleted).toBe(true)

    // 警告（見逃してはいけない知らせ）: ⚠️ の行は警告へ移してあり、そのまま出る
    const note = resumedNoteOf(items[0])
    expect(note.warnings).toEqual(['⚠️ 保存場所の記録（公開の設定）は残しています。次に公開する前に、③「保存場所を用意する」からやり直してください'])
    expect(note.headline).toContain('⑥ すべて削除')

    // ack: **警告つきの記録は、画面が出しても「見た」と伝えない**（2026-09-30 検分）。⑥の結果欄は公開ボタンのずっと下にあり、
    // スクロールせずに閉じると、見せたことにならないのに見たことにして、月額が続く警告が二度と出なくなった。
    // 上部の「結果を確認しました」（PublishModal）を押したときにだけ見たことになる。
    expect(acks, '警告つきの記録を、画面が出しただけで「見た」と伝えた').toEqual([])
    expect(getOps(DIR).last?.startedAt).toBe(items[0].record.startedAt)
  })

  it('★★★ 警告つきの結果は、何度付け直しても出る（上部の確認で ack されるまで）。ack のあとは出ない', async () => {
    const { api } = makeApi()
    const op = startOp('teardown', TEARDOWN_STORAGE_LEFT)
    await finish(op)

    const first = mount(api)
    await flush()
    expect(first.allFinished()).toHaveLength(1)
    first.watch.stop()
    const second = mount(api)
    await flush()
    expect(second.allFinished(), '確認していない警告が、付け直したら消えている').toHaveLength(1)
    second.watch.stop()
    // 上部の「結果を確認しました」が伝える ack（見せた記録の startedAt まで）
    await api.ack(DIR, second.allFinished()[0].record.startedAt)
    const third = mount(api)
    await flush()
    expect(third.allFinished()).toEqual([])
    third.watch.stop()
  })

  it('★★ ack のあと、もう一度付け直しても出ない（結果は1回だけ・警告なしの結果）', async () => {
    const { api } = makeApi()
    const op = startOp('teardown', { ok: true, executed: ['クラスタ『c1』を削除しました（消えたことを確認）'], message: '', remaining: {} })
    await finish(op)

    const second = mount(api)
    await flush()
    expect(second.allFinished()).toHaveLength(1)
    second.watch.stop()

    const third = mount(api)
    await flush()
    expect(third.allFinished()).toEqual([])
    expect(third.lastRunning()).toEqual({ running: null, other: null })
    third.watch.stop()
  })

  it('⑧: 動いていない公開の警告・DNS の IP・応答の確認・URL が、結果欄と警告に分かれて出る', async () => {
    const { api } = makeApi()
    const op = startOp('publish', {
      ok: true, stage: 'done', message: '公開しました。DNS の A レコードを次の IP に向けてください: 59.106.222.212',
      applicationID: 'app-1', version: 2, url: 'https://app.example.com/', lbAddresses: ['59.106.222.212'],
      verify: 'no-backend', containerStates: [{ state: 'exited', status: 'exit 1' }],
      warnings: ['アプリがまだ応答していません。コントロールパネルで確認してください。', 'koto-data を新しい版へ差し替えました'],
    })
    await finish(op)

    const m = mount(api)
    await flush()
    const [item] = m.allFinished()
    const typed = resumedPublishResult(item.record)
    expect(typed).toMatchObject({
      ok: true, stage: 'done', applicationID: 'app-1', version: 2, url: 'https://app.example.com/',
      lbAddresses: ['59.106.222.212'], verify: 'no-backend', containerStates: [{ state: 'exited', status: 'exit 1' }],
    })
    // 警告は結果欄には入れず、知らせに集める（同じ知らせを2か所に出さない）
    expect(typed.warnings).toBeUndefined()
    expect(resumedNoteOf(item).warnings).toEqual([
      '⚠️ アプリがまだ応答していません。コントロールパネルで確認してください。',
      '⚠️ koto-data を新しい版へ差し替えました',
    ])
  })

  it('⑧が失敗した: 段・理由・詳細・回復の印（hint）が結果欄の形で戻る', async () => {
    const { api } = makeApi()
    const op = startOp('publish', { ok: false, stage: 'image', message: 'イメージの反映に失敗しました', detail: 'unauthorized', hint: 'reset-registry' })
    await finish(op)
    const m = mount(api)
    await flush()
    const typed = resumedPublishResult(m.allFinished()[0].record)
    expect(typed).toMatchObject({ ok: false, stage: 'image', message: 'イメージの反映に失敗しました', detail: 'unauthorized', hint: 'reset-registry' })
  })

  it('⑤: 途中で止まった結果（どこまで作られたか）が戻る', async () => {
    const { api } = makeApi()
    const op = startOp('create', { ok: false, stage: 'asg-create', message: 'ASG の作成に失敗しました', clusterID: 'c1', asgID: null, loadBalancerID: null })
    await finish(op)
    const m = mount(api)
    await flush()
    const typed = resumedCreateResult(m.allFinished()[0].record)
    expect(typed).toEqual({ ok: false, stage: 'asg-create', message: 'ASG の作成に失敗しました', clusterID: 'c1', asgID: null, loadBalancerID: null })
  })

  it('⑤が成功: 作られた3つの ID と段が戻る', async () => {
    const { api } = makeApi()
    const op = startOp('create', { ok: true, stage: 'done', message: '作成できました。', clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })
    await finish(op)
    const m = mount(api)
    await flush()
    expect(resumedCreateResult(m.allFinished()[0].record)).toEqual({ ok: true, stage: 'done', message: '作成できました。', clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })
  })

  it('⑥が「削除中です」で止まった / 消せずに残った: ID の一覧は結果欄が出し、同じ知らせを警告に重ねない（ただし知らせは消えない）', async () => {
    const { api } = makeApi()
    const inProgressOp = startOp('teardown', {
      ok: false, executed: [], message: 'ロードバランサの削除を受け付けましたが、まだ削除中です。しばらくして⑥をもう一度押してください',
      remaining: { loadBalancerID: 'l1', asgID: 'a1', clusterID: 'c1' }, inProgress: { loadBalancerID: 'l1' },
    })
    await finish(inProgressOp)
    const m1 = mount(api)
    await flush()
    const inProgress = m1.allFinished()[0]
    const typed = resumedTeardownResult(inProgress.record)
    expect(typed.inProgress).toEqual({ loadBalancerID: 'l1' })
    expect(typed.remaining).toEqual({ loadBalancerID: 'l1', asgID: 'a1', clusterID: 'c1' })
    // 結果欄が ID つきで出す2つの知らせは、警告へ重ねない
    expect(resumedNoteOf(inProgress).warnings).toEqual([])
    // ただし main が実際に作った警告の文で確かめる（書き出しが食い違えば、二重に出るだけで消えない）
    const mainWarnings = inProgress.record.result!.warnings
    expect(mainWarnings.length).toBeGreaterThan(0)
    expect(mainWarnings.every(w => w.startsWith(TEARDOWN_IN_PROGRESS_WARNING_HEAD) || w.startsWith(TEARDOWN_REMAINING_WARNING_HEAD))).toBe(true)
    m1.watch.stop()
  })

  it('★★ 結果欄が出せない知らせは落とさない: ⑤の警告・⑥の別の警告（残ったものが無いとき）は必ず知らせに載る', async () => {
    const { api } = makeApi()
    const op = startOp('create', { ok: true, stage: 'done', message: '作成できました。', clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1', warnings: ['ロードバランサの IP はまだ付いていません'] })
    await finish(op)
    const op2 = startOp('teardown', { ok: false, executed: [], message: '失敗', remaining: {}, warnings: ['残っています＝課金が続きます、と読める別の知らせ'] })
    await finish(op2)
    const m = mount(api)
    await flush()
    const [c, t] = m.allFinished()
    expect(resumedNoteOf(c).warnings).toEqual(['⚠️ ロードバランサの IP はまだ付いていません'])
    // 残ったものの ID が1つも無いなら、結果欄は一覧を出せない。同じ書き出しの知らせでも落とさない。
    expect(resumedNoteOf(t).warnings).toEqual(['⚠️ 残っています＝課金が続きます、と読める別の知らせ'])
  })

  it('★★ 見られていない結果が2件あるとき、前の警告を上書きで見逃さない（earlier と last の両方が古い順に届く）', async () => {
    const { api, acks } = makeApi()
    await finish(startOp('publish', { ok: true, stage: 'done', message: '1回目', warnings: ['1回目の警告'] }))
    await finish(startOp('publish', { ok: true, stage: 'done', message: '2回目', warnings: ['2回目の警告'] }))
    const m = mount(api)
    await flush()
    const items = m.allFinished()
    expect(items.map(i => i.record.result?.message)).toEqual(['1回目', '2回目'])
    let held = addResumedNotes({ create: [], teardown: [], publish: [] }, items.map(resumedNoteOf))
    expect(held.publish.map(n => n.warnings)).toEqual([['⚠️ 1回目の警告'], ['⚠️ 2回目の警告']])
    // 同じ記録を足し直しても増えない
    held = addResumedNotes(held, items.map(resumedNoteOf))
    expect(held.publish).toHaveLength(2)
    // 警告つきの2件は、画面は見たことにしない（上部の「結果を確認しました」まで、どちらも main に残る）
    expect(acks).toEqual([])
    expect(getOps(DIR).earlier).toHaveLength(1)
    expect(getOps(DIR).last).not.toBeNull()
  })

  it('★★ 警告の無い結果が2件あるとき、どちらも出して、新しいほうの startedAt まで見たことにする', async () => {
    const { api, acks } = makeApi()
    await finish(startOp('publish', { ok: false, stage: 'image', message: '1回目の失敗' }))
    await finish(startOp('publish', { ok: false, stage: 'image', message: '2回目の失敗' }))
    const m = mount(api)
    await flush()
    const items = m.allFinished()
    expect(items.map(i => i.record.result?.message)).toEqual(['1回目の失敗', '2回目の失敗'])
    expect(acks).toEqual([[DIR, items[1].record.startedAt]])
  })
})

// ── 隠れているタブの画面は、結果を「見た」に数えない（2026-09-30 検分）─────────────────────────
// 専有型のタブは、共用型へ切り替えても**パネルを外さずに隠す**（PublishModal）。隠れている間に届いた結果は、画面の状態
// （⑤⑥⑧の結果欄）には入っても、利用者は見ていない。以前は渡した直後・endLocal で、隠れたままでも ack していたので、
// 結果を見ないまま閉じると、開き直しても出なかった。
describe('★★★ 隠れているタブ（isVisible が false）では、結果を渡しても ack しない。また出たとき（visibilityChanged）に ack する', () => {
  const PLAIN_TEARDOWN = { ok: true, executed: ['クラスタ『c1』を削除しました（消えたことを確認）'], message: '', remaining: {} }

  it('★★★ 隠れている間に終わった結果: 画面へは渡すが、ack しない。main の記録に残る', async () => {
    const { api, acks } = makeApi()
    let visible = false
    const m = mount(api, DIR, () => visible)
    await flush()
    await finish(startOp('teardown', PLAIN_TEARDOWN))
    await flush()
    expect(m.allFinished(), '隠れていても、画面の状態には入れる').toHaveLength(1)
    expect(acks, '隠れているタブが、利用者が見ていない結果を「見た」と伝えた').toEqual([])
    expect(getOps(DIR).last, 'main の記録から消えた（閉じて開き直しても出ない）').not.toBeNull()
    m.watch.stop()

    // 閉じて開き直す（今度は目の前に出ている）と、同じ結果が出て、ack される
    visible = true
    const again = mount(api, DIR, () => visible)
    await flush()
    expect(again.allFinished()).toHaveLength(1)
    expect(acks).toHaveLength(1)
    again.watch.stop()
  })

  it('★★★ 隠れている間に渡した結果は、タブがまた出たとき（visibilityChanged）に ack する。二重には渡さない', async () => {
    const { api, acks } = makeApi()
    let visible = false
    const m = mount(api, DIR, () => visible)
    await flush()
    await finish(startOp('teardown', PLAIN_TEARDOWN))
    await flush()
    expect(m.allFinished()).toHaveLength(1)
    expect(acks).toEqual([])

    visible = true
    m.watch.visibilityChanged()
    await flush()
    expect(acks, 'タブが出たのに、見たことにならない').toEqual([[DIR, m.allFinished()[0].record.startedAt]])
    expect(m.allFinished(), '出たときに、同じ結果をもう一度渡した').toHaveLength(1)
    expect(getOps(DIR).last).toBeNull()
    m.watch.stop()
  })

  it('★★ 隠れたら（visible → hidden）また ack しなくなる。すでに伝えた分は取り消さない', async () => {
    const { api, acks } = makeApi()
    let visible = true
    const m = mount(api, DIR, () => visible)
    await flush()
    await finish(startOp('teardown', PLAIN_TEARDOWN))
    await flush()
    expect(acks).toHaveLength(1)
    visible = false
    m.watch.visibilityChanged()
    await finish(startOp('publish', { ok: false, stage: 'image', message: '隠れている間の失敗' }))
    await flush()
    expect(m.allFinished()).toHaveLength(2)
    expect(acks, '隠れている間に届いた結果を、見たことにした').toHaveLength(1)
    m.watch.stop()
  })

  it('★★ この画面が始めた操作（beginLocal〜endLocal）の途中で隠れたら、endLocal では ack しない。出たとき ack する', async () => {
    const { api, acks } = makeApi()
    let visible = true
    const m = mount(api, DIR, () => visible)
    await flush()
    m.watch.beginLocal('teardown')
    const op = startOp('teardown', PLAIN_TEARDOWN)
    await flush()
    visible = false                       // 操作の途中で、共用型のタブへ移った
    m.watch.visibilityChanged()
    await finish(op)
    await flush()
    m.watch.endLocal('teardown')          // 結果を（隠れた画面の）結果欄へ出し終えた
    await flush()
    expect(acks, '隠れたまま、利用者が見ていない結果を見たことにした').toEqual([])
    visible = true
    m.watch.visibilityChanged()
    await flush()
    expect(acks).toHaveLength(1)
    m.watch.stop()
  })

  it('★ isVisible を渡さない呼び出し（HANAMII 等・ふだんの1画面）は、これまでどおり（見えているものとして扱う）', async () => {
    const { api, acks } = makeApi()
    const m = mount(api)
    await flush()
    await finish(startOp('teardown', PLAIN_TEARDOWN))
    await flush()
    expect(acks).toHaveLength(1)
    m.watch.stop()
  })
})

describe('★★ 開いている間の終わり: 押し出しで結果が届き、1件につき1回だけ渡す', () => {
  it('走っている最中に開いた画面へ、終わったとき結果が届く（重ねて届かない）', async () => {
    const { api, acks } = makeApi()
    const op = startOp('teardown', { ok: true, executed: ['クラスタ『c1』を削除しました（消えたことを確認）'], message: '', remaining: {} })
    const m = mount(api)
    await flush()
    expect(m.allFinished()).toEqual([])
    await finish(op)
    await flush()
    expect(m.allFinished()).toHaveLength(1)
    expect(m.allFinished()[0].kind).toBe('teardown')
    // ack のあとに main が押し出す「見たことになった」の写しで、同じ結果を重ねて渡さない
    expect(m.allFinished()).toHaveLength(1)
    expect(acks).toHaveLength(1)
  })
})

describe('★★ この画面が始めた操作は、記録から二重に出さない（結果を出し終えるまで ack もしない）', () => {
  it('beginLocal〜endLocal: 終わっても onFinished へ渡さず、出し終える（endLocal）までは ack しない。endLocal で ack する', async () => {
    const { api, acks } = makeApi()
    const m = mount(api)
    await flush()
    m.watch.beginLocal('teardown')
    const op = startOp('teardown', { ok: true, executed: [], message: '', remaining: {} })
    await flush()
    expect(m.lastRunning()?.running?.kind).toBe('teardown') // 走っている進み具合は記録から出る
    await finish(op)
    await flush()
    expect(m.allFinished()).toEqual([]) // 結果は画面が自分の返り値から出す
    expect(acks).toEqual([]) // まだ出し終えていない
    m.watch.endLocal('teardown') // 画面が結果を出し終えた
    await flush()
    expect(m.allFinished()).toEqual([])
    expect(acks).toHaveLength(1)
    expect(getOps(DIR).last).toBeNull()
    // 付け直しても、二重には出ない
    m.watch.stop()
    const again = mount(api)
    await flush()
    expect(again.allFinished()).toEqual([])
  })

  it('★★ 出し終える前に窓が閉じたら ack されず、開き直したとき記録から結果が出る（結果を失わない）', async () => {
    const { api, acks } = makeApi()
    const m = mount(api)
    await flush()
    m.watch.beginLocal('publish')
    const op = startOp('publish', { ok: true, stage: 'done', message: 'ok', warnings: ['まだ動いていません'] })
    await flush()
    m.watch.stop() // 出し終える前に閉じた
    await finish(op)
    m.watch.endLocal('publish') // 古い画面の後始末が遅れて走っても、何もしない
    await flush()
    expect(acks).toEqual([])

    const reopened = mount(api)
    await flush()
    expect(reopened.allFinished()).toHaveLength(1)
    expect(resumedNoteOf(reopened.allFinished()[0]).warnings).toEqual(['⚠️ まだ動いていません'])
  })

  // ── 2026-09-30 検分の指摘5（変異が1件生き残った）──────────────────────────────────────
  // 「この画面が始めた操作の結果は、出し終えるまで ack しない」は、**ack が「その記録まで」の累積**だから要る約束。
  // 出している最中の結果 L より**新しい**別の記録 C が届いて、C を ack すると、L も一緒に見たことになる。
  // そのまま窓が閉じると、L（利用者はまだ見ていない結果・月額が続く警告かもしれない）は二度と出ない。
  // 以前のテストは「L だけ」の場面しか見ておらず、L を ack の巻き込みから外す1行を消しても落ちなかった。
  it('★★★ 出している最中の結果 L より新しい別の種類の記録 C が届いても、C の ack に L を巻き込まない（L は出し終えるまで ack しない）', async () => {
    const { api, acks } = makeApi()
    const m = mount(api)
    await flush()
    m.watch.beginLocal('teardown')                                   // この画面が⑥を始めた
    await finish(startOp('teardown', { ok: false, executed: [], message: '保存場所が残りました', remaining: { storageBucket: 'koto-data-x' } }))
    await finish(startOp('publish', { ok: true, stage: 'done', message: '別の窓の⑧', warnings: ['まだ動いていません'] }))
    await flush()
    const unseen = () => [...getOps(DIR).earlier, ...(getOps(DIR).last ? [getOps(DIR).last!] : [])]
    const [l, c] = unseen()
    expect(l.handler).toBe('apprunDedicated:teardown')
    expect(c.handler).toBe('apprunDedicated:publishApp')

    // C は画面へ渡す。だが L を出し終えていないので、C も ack しない（伝えると、累積で L まで見たことになる）
    expect(m.allFinished().map(i => i.kind)).toEqual(['publish'])
    expect(acks, 'L を出し終える前に、より新しい C の ack で L まで見たことになる').toEqual([])
    expect(unseen().map(r => r.startedAt), 'main の記録から L が消えている').toEqual([l.startedAt, c.startedAt])

    // このまま窓が閉じたら、開き直したとき L も C も記録から出せる（結果を失わない）
    m.watch.stop()
    const reopened = mount(api)
    await flush()
    expect(reopened.allFinished().map(i => i.kind).sort()).toEqual(['publish', 'teardown'])
    reopened.watch.stop()
  })

  it('★★ L を出し終えたら（endLocal）、L も C もまとめて ack する', async () => {
    const { api, acks } = makeApi()
    const m = mount(api)
    await flush()
    m.watch.beginLocal('teardown')
    await finish(startOp('teardown', { ok: true, executed: [], message: '', remaining: {} }))
    await finish(startOp('publish', { ok: true, stage: 'done', message: '別の窓の⑧' }))
    await flush()
    expect(acks).toEqual([])
    const cStartedAt = getOps(DIR).last!.startedAt
    m.watch.endLocal('teardown')
    await flush()
    expect(acks, '出し終えたのに ack していない／L と C を別々に ack している').toEqual([[DIR, cStartedAt]])
    expect(getOps(DIR).last).toBeNull()
  })

  it('この画面が始める前に終わっていた同じ種類の記録は、二重扱いにせず出す', async () => {
    const { api } = makeApi()
    await finish(startOp('teardown', { ok: false, executed: [], message: '前回の失敗', remaining: { clusterID: 'c1' } }))
    const m = mount(api)
    await flush()
    m.watch.beginLocal('teardown') // いま新しく押した
    await flush()
    // 前回の分は、いまの操作より前に始まったもの（=この画面の結果ではない）ので、すでに渡されている
    expect(m.allFinished().map(i => i.record.result?.message)).toEqual(['前回の失敗'])
  })

  it('別の種類（⑤を押している間に⑥の結果が終わっていた）は、⑤の操作に巻き込まれず出る', async () => {
    const { api } = makeApi()
    const m = mount(api)
    await flush()
    m.watch.beginLocal('create')
    await finish(startOp('publish', { ok: true, stage: 'done', message: '別の操作の結果' }))
    await flush()
    expect(m.allFinished().map(i => i.kind)).toEqual(['publish'])
  })
})

describe('★★ 別の公開先・別の操作の記録は出さない・巻き込まない（掟11）', () => {
  it('別の公開先（Vercel）の公開が走っている: 詳細は出さず「別の操作」だけ。⑤⑥⑧の走っている印は立たない', async () => {
    const { api } = makeApi()
    const op = startForeignOp()
    const m = mount(api)
    await flush()
    const view = m.lastRunning()!
    expect(view.running).toBeNull()
    expect(view.other).toEqual({ op: '公開', targetLabel: '▲ Vercel' })
    expect(otherOpNote(view.other!)).toContain('別の操作（▲ Vercelの公開）が進んでいます')
    await finish(op)
  })

  it('📡 の「アプリだけ破棄」（同じ専有型でも handler が違う）は、⑥として扱わない', async () => {
    const { api } = makeApi()
    const op = startForeignOp(DIR, 'apprunDedicated:teardownApp', 'sakura-apprun-dedicated')
    const m = mount(api)
    await flush()
    expect(m.lastRunning()!.running).toBeNull()
    expect(m.lastRunning()!.other?.op).toBe('公開') // （この偽の操作の名前。走っていても⑥の進み具合にはならない）
    await finish(op)
    await flush()
    expect(m.allFinished()).toEqual([])
    expect(dedicatedOpKind({ target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:teardownApp' })).toBeNull()
    expect(dedicatedOpKind({ target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:teardown' })).toBe('teardown')
    expect(dedicatedOpKind({ target: 'sakura-apprun', handler: 'apprunDedicated:teardown' })).toBeNull() // target も見る
    expect(dedicatedOpKind({ target: 'sakura-apprun-dedicated', handler: 'constructor' })).toBeNull()
  })

  it('★★ 別の公開先の結果は出さず、ack でも巻き込まない。自分のものが先に挟まれていなければ、自分の分だけ ack する', async () => {
    const { api, acks } = makeApi()
    await finish(startOp('publish', { ok: true, stage: 'done', message: '専有型の結果' })) // 古い
    await finish(startForeignOp()) // 新しい（Vercel）
    const m = mount(api)
    await flush()
    expect(m.allFinished().map(i => i.record.result?.message)).toEqual(['専有型の結果'])
    // Vercel の結果は、Vercel の持ち場のために残っている
    expect(getOps(DIR).last?.handler).toBe('vercel:publish')
    expect(getOps(DIR).earlier).toEqual([])
    expect(acks).toHaveLength(1)
  })

  it('★★ 別の公開先の結果のほうが古いときは、自分のものも ack せず残す（累積の ack でその持ち場の結果を消さない）', async () => {
    const { api, acks } = makeApi()
    await finish(startForeignOp()) // 古い（Vercel）
    await finish(startOp('publish', { ok: true, stage: 'done', message: '専有型の結果' })) // 新しい
    const m = mount(api)
    await flush()
    // 出しはする
    expect(m.allFinished().map(i => i.record.result?.message)).toEqual(['専有型の結果'])
    // でも ack はしない（ack すると、古い Vercel の結果まで見たことになって消える）
    expect(acks).toEqual([])
    expect(getOps(DIR).earlier.map(r => r.handler)).toEqual(['vercel:publish'])
    expect(getOps(DIR).last?.handler).toBe('apprunDedicated:publishApp')
  })

  it('★ ack できずに残っている結果（別の持ち場の古い結果が先に挟まっている）も、押し出しが何度届いても1回しか渡さない', async () => {
    const { api, acks } = makeApi()
    await finish(startForeignOp()) // 古い（Vercel）。この持ち場では ack できない
    await finish(startOp('publish', { ok: true, stage: 'done', message: '専有型の結果', warnings: ['まだ動いていません'] }))
    const m = mount(api)
    await flush()
    expect(m.allFinished()).toHaveLength(1)
    expect(acks).toEqual([]) // ack されず、記録には残ったまま

    // その後に別の操作が始まって進む（押し出しが何度も届く）。残っている結果が、そのたびに重ねて渡されない。
    const next = startOp('teardown', { ok: true, executed: [], message: '', remaining: {} })
    next.progress('1回目')
    next.progress('2回目')
    await flush()
    expect(m.allFinished()).toHaveLength(1)
    await finish(next)
    await flush()
    expect(m.allFinished().map(i => i.kind)).toEqual(['publish', 'teardown'])
  })

  it('別のプロジェクトの知らせは無視する。末尾の / の有無は同じプロジェクトとして扱う', async () => {
    const { api } = makeApi()
    const m = mount(api, DIR + '/')
    await flush()
    const op = startOp('teardown', { ok: true, executed: [], message: '', remaining: {} }, OTHER_DIR)
    await flush()
    expect(m.lastRunning()).toEqual({ running: null, other: null }) // 別プロジェクトの操作は見えない
    await finish(op)
    await flush()
    expect(m.allFinished()).toEqual([])

    const mine = startOp('teardown', { ok: true, executed: [], message: '', remaining: {} }, DIR) // 末尾の / なしで走る
    await flush()
    expect(m.lastRunning()?.running?.kind).toBe('teardown') // 末尾の / があっても同じプロジェクト
    await finish(mine)
    await flush()
    expect(m.allFinished()).toHaveLength(1)
  })
})

describe('★ 問い合わせ（get）の応答が遅れて届いても、より新しい押し出しを古い写しで戻さない', () => {
  it('get の応答より先に押し出しが届いたら、get の応答は使わない', async () => {
    const { api } = makeApi()
    const op = startOp('teardown', { ok: true, executed: [], message: '', remaining: {} })
    op.progress('古い進み具合')
    // 応答を手で遅らせる get（古い写しを返す）
    const oldSnapshot = getOps(DIR)
    let respond!: () => void
    const slow: DedicatedOpsApi = {
      ...api,
      get: () => new Promise(resolve => { respond = () => resolve(oldSnapshot) }),
    }
    const m = mount(slow)
    op.progress('新しい進み具合') // 押し出しが先に届く
    expect(opProgressText(m.lastRunning()!.running!.record)).toBe('新しい進み具合')
    respond()
    await flush()
    expect(opProgressText(m.lastRunning()!.running!.record)).toBe('新しい進み具合') // 古い写しで戻っていない
    await finish(op)
  })

  it('get が失敗しても（preload 未注入など）壊れない', async () => {
    const { api } = makeApi()
    const m = mount({ ...api, get: async () => { throw new Error('boom') } })
    await flush()
    expect(m.running).toEqual([])
    m.watch.stop()
  })
})

describe('★ 押し出しが1つ届かなくても、聞き直し（refresh）で「走っている」のまま固まらない', () => {
  it('押し出しが途絶えた状態で操作が終わっても、refresh で終わりと結果が届く', async () => {
    const { api, subs } = makeApi()
    const op = startOp('publish', { ok: true, stage: 'done', message: '終わり', warnings: ['まだ動いていません'] })
    const m = mount(api)
    await flush()
    expect(m.lastRunning()?.running?.kind).toBe('publish')
    subs.clear() // これ以降の押し出しは届かない
    await finish(op)
    await flush()
    expect(m.lastRunning()?.running?.kind).toBe('publish') // 古いまま（固まって見える）
    expect(m.allFinished()).toEqual([])

    m.watch.refresh()
    await flush()
    expect(m.lastRunning()).toEqual({ running: null, other: null })
    expect(m.allFinished()).toHaveLength(1)
    expect(resumedNoteOf(m.allFinished()[0]).warnings).toEqual(['⚠️ まだ動いていません'])
  })

  it('聞いている間により新しい押し出しが届いたら、その応答は古いので使わない', async () => {
    const { api } = makeApi()
    const op = startOp('teardown', { ok: true, executed: [], message: '', remaining: {} })
    op.progress('古い進み具合')
    let respond!: (s: ProjectOpsSnapshotShape) => void
    let asked = 0
    const slow: DedicatedOpsApi = { ...api, get: () => { asked++; return asked === 1 ? api.get(DIR) : new Promise(resolve => { respond = resolve }) } }
    const m = mount(slow)
    await flush()
    const old = getOps(DIR)
    m.watch.refresh() // 応答を手で遅らせる（古い写しを返す）
    op.progress('新しい進み具合') // 押し出しが先に届く
    respond(old)
    await flush()
    expect(opProgressText(m.lastRunning()!.running!.record)).toBe('新しい進み具合')
    await finish(op)
  })

  it('外したあとの refresh は何もしない', async () => {
    const { api } = makeApi()
    const op = startOp('teardown', { ok: true, executed: [], message: '', remaining: {} })
    let asked = 0
    const counting: DedicatedOpsApi = { ...api, get: (d: string) => { asked++; return api.get(d) } }
    const m = mount(counting)
    await flush()
    m.watch.stop()
    const before = asked
    m.watch.refresh()
    await flush()
    expect(asked).toBe(before)
    await finish(op)
  })
})

describe('⑥の節: 走っている間は、記録が空でも出し続ける', () => {
  it('計算資源を消し切って保存場所を片づけている最中（記録が空・残りの印もまだ無い）でも、走っていれば出す', () => {
    expect(shouldShowTeardownButton({ hasAnyResource: false, storageLeftoverBucket: null, running: true })).toBe(true)
    // 走っていなければ従来どおり（何も無ければ出さない・資源か残った保存場所があれば出す）
    expect(shouldShowTeardownButton({ hasAnyResource: false, storageLeftoverBucket: null, running: false })).toBe(false)
    expect(shouldShowTeardownButton({ hasAnyResource: false, storageLeftoverBucket: null })).toBe(false)
    expect(shouldShowTeardownButton({ hasAnyResource: true })).toBe(true)
    expect(shouldShowTeardownButton({ hasAnyResource: false, storageLeftoverBucket: 'koto-data-x' })).toBe(true)
  })
})

describe('部品: 進み具合・経過・警告の文', () => {
  it('opProgressText: 補足（detail）があれば続ける・無ければ label だけ', () => {
    expect(opProgressText({ progress: { label: 'A', detail: '' } })).toBe('A')
    expect(opProgressText({ progress: { label: 'A', detail: '状態: BUILDING（12秒経過）' } })).toBe('A 状態: BUILDING（12秒経過）')
    expect(opProgressText(null)).toBe('')
  })

  it('opElapsedText: 1分未満／N分（切り捨て）', () => {
    expect(opElapsedText(1000, 1000 + 59_000)).toBe('始まってから1分未満')
    expect(opElapsedText(1000, 1000 + 60_000)).toBe('始まってから約1分')
    expect(opElapsedText(1000, 1000 + 9 * 60_000 + 30_000)).toBe('始まってから約9分')
    expect(opElapsedText(5000, 1000)).toBe('始まってから1分未満') // 時計が戻っても負にならない
  })

  // warningLine・clockText は共通の1か所（src/shared/opsText.ts）に移した（2026-09-30 検分の指摘2）。
  // 振る舞いは tests/opsText.test.ts。この画面が出す警告が、その定義を通っていることだけをここで見る。
  it('警告の見出し行は、共通の warningLine を通る（印が無ければ ⚠️ が付き、あれば二重にならない）', () => {
    const rec = (warnings: string[]) => ({ kind: 'teardown' as const, record: { op: '削除' as const, target: 'sakura-apprun-dedicated' as const, handler: 'apprunDedicated:teardown', startedAt: 1, running: false, finishedAt: 2, seen: false, progress: { label: '', detail: '', at: 1 }, result: { ok: true, lines: [], warnings, extra: {} } } })
    expect(resumedNoteOf(rec(['印が無い'])).warnings).toEqual(['⚠️ 印が無い'])
    expect(resumedNoteOf(rec(['⚠️ すでに印がある', '※ 注記'])).warnings).toEqual(['⚠️ すでに印がある', '※ 注記'])
  })

  it('画面に出る文は素のテキスト（Markdown 記法なし・掟5）', () => {
    const texts = [
      otherOpNote({ op: '公開', targetLabel: '▲ Vercel' }),
      resumedNoteOf({ kind: 'teardown', record: { op: '削除', target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:teardown', startedAt: 1, running: false, finishedAt: 2, seen: false, progress: { label: '', detail: '', at: 1 }, result: { ok: true, lines: [], warnings: ['x'], extra: {} } } }).headline,
    ]
    for (const t of texts) expect(t).not.toMatch(/\*\*|__|`/)
  })

  it('「Claude Code」という製品名を使わない（掟8）', () => {
    expect(otherOpNote({ op: '公開', targetLabel: null })).not.toContain('Claude Code')
  })
})

describe('main の記録が作る警告の書き出しと、画面が外す書き出しが一致している（ズレると二重に出る）', () => {
  it('summarizeResult（本物）が作る「残っています」「削除中」の警告は、画面の定数で始まる', () => {
    const remaining = summarizeResult({ ok: false, remaining: { clusterID: 'c1' } }).warnings
    expect(remaining).toHaveLength(1)
    expect(remaining[0].startsWith(TEARDOWN_REMAINING_WARNING_HEAD)).toBe(true)
    const inProgress = summarizeResult({ ok: false, inProgress: { loadBalancerID: 'l1' }, remaining: { loadBalancerID: 'l1' } }).warnings
    expect(inProgress).toHaveLength(1)
    expect(inProgress[0].startsWith(TEARDOWN_IN_PROGRESS_WARNING_HEAD)).toBe(true)
  })
})
