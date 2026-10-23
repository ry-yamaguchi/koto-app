import { describe, it, expect, beforeEach } from 'vitest'
import { withProjectLock } from '../src/main/projectLock'
import { getOps, ackOps, setProjectOpsListener, reportProgress, resetProjectOpsForTests, summarizeResult } from '../src/main/projectOps'
import {
  TEARDOWN_HANDLER_TARGET, isTeardownRecordOf, resumedTeardownNote, watchTeardownOps,
  type TeardownRunningView,
} from '../src/renderer/teardown/watch'
import { TEARDOWN_REMAINING_WARNING_HEAD, TEARDOWN_IN_PROGRESS_WARNING_HEAD } from '../src/shared/teardownResult'
import { PUBLISH_TARGET_LABEL } from '../src/renderer/publishStatus'
import { clockText } from '../src/shared/opsText'
import type { ProjectOpsApi } from '../src/renderer/projectOpsView'
import type { TeardownWords } from '../src/renderer/teardown/types'
import type { PublishTargetKind } from '../src/shared/publishMeta'
import { stoppedNextStep } from '../src/shared/inFlightOps'
import { stoppedNotice } from './stoppedNoticeHarness'

// ── 段階0（0d）: 破棄の記録を読む部品（teardown/watch.ts）──────────────────────────────────────────────
//
// どの入口・IPC からもまだ呼ばれない（部品と単体テストだけ）。設計書: docs/teardown-unify-plan.md の 10.3.2 (5)。
// 画面を閉じても破棄は main が最後まで進める。開き直したとき「走っていれば進み具合」「終わっていれば結果と警告」が出て、
// 「見た」と伝えたあとは出ない——この約束は**お金の見え方に関わる**（月額が続く警告を見逃させない）ので、振る舞いで固定する（掟10）。
// 偽の projectOps は**本物の main の記録**（src/main/projectOps.ts）の上に作る。ack が「その記録まで」の累積であること・
// earlier／last の分かれ方・押し出しの形を、テストが勝手に決めない。main の処理は本物の withProjectLock で走らせる。
// 「画面を外して付け直す」は、watchTeardownOps を stop して新しく作り直すこと。

const DIR = '/tmp/koto-teardown-watch-project'
const OTHER_DIR = '/tmp/koto-teardown-watch-other'

type Push = { projectDir: string } & ProjectOpsSnapshotShape

const TARGETS: readonly PublishTargetKind[] = ['sakura-apprun', 'hanamii', 'sakura-apprun-dedicated']
const TEARDOWN_HANDLER: Record<string, string> = {
  'sakura-apprun': 'cloud:teardown', hanamii: 'hanamii:teardown', 'sakura-apprun-dedicated': 'apprunDedicated:teardown',
}

/** 偽の window.electronAPI.projectOps。本物の記録（projectOps.ts）へ流す。 */
function makeApi() {
  const subs = new Set<(p: Push) => void>()
  const acks: Array<[string, number | undefined]> = []
  setProjectOpsListener((projectDir, snapshot) => { for (const cb of [...subs]) cb({ projectDir, ...snapshot }) })
  const api: ProjectOpsApi = {
    get: async (dir: string) => getOps(dir),
    ack: async (dir: string, upTo?: number) => { acks.push([dir, upTo]); return { ok: true, acked: ackOps(dir, upTo) } },
    onChanged: cb => { subs.add(cb); return () => { subs.delete(cb) } },
  }
  return { api, subs, acks }
}

/** 画面を開く（付ける）。届いたものを溜める。 */
function mount(api: ProjectOpsApi, over: { target?: PublishTargetKind; dir?: string; isVisible?: () => boolean; now?: () => number } = {}) {
  const running: TeardownRunningView[] = []
  const finished: ProjectOpRecordShape[][] = []
  const watch = watchTeardownOps({
    api, projectDir: over.dir ?? DIR, target: over.target ?? 'hanamii',
    onRunning: v => running.push(v), onFinished: f => finished.push(f),
    ...(over.isVisible ? { isVisible: over.isVisible } : {}), ...(over.now ? { now: over.now } : {}),
  })
  return {
    watch, running, finished,
    lastRunning: () => running[running.length - 1] ?? null,
    allFinished: () => finished.flat(),
  }
}
/** 非同期の応答（get の Promise・ack）が流れるのを待つ。 */
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(r => setTimeout(r, 0)) }

type Op = '削除' | '公開' | '作成'
/**
 * main の操作を1つ走らせる（本物の withProjectLock）。`release()` するまで終わらない。
 * 走らせたあとの進み具合は `progress()` で足す。
 */
function startOp(target: PublishTargetKind | 'unknown', handler: string, result: unknown, opts: { op?: Op; dir?: string } = {}) {
  let release!: () => void
  const gate = new Promise<void>(open => { release = open })
  const dir = opts.dir ?? DIR
  const done = withProjectLock(dir, opts.op ?? '削除', async () => { await gate; return result }, { target, handler })
  return { release, done, progress: (m: string) => reportProgress(dir, m) }
}
const startTeardown = (target: PublishTargetKind, result: unknown, dir = DIR) => startOp(target, TEARDOWN_HANDLER[target], result, { dir })
async function finish(op: { release: () => void; done: Promise<unknown> }) { op.release(); await op.done }

beforeEach(() => { resetProjectOpsForTests() })

const OK_RESULT = { ok: true, executed: ['✅ 消しました'] }
/** 保存場所を残した成功（月額が続く警告つき。画面が「見た」にしてはいけない）。 */
const OK_WITH_WARNING = { ok: true, executed: ['✅ 消しました'], keptBucketName: 'koto-data-x' }

// ═══════════════════════════════════════════════════════════════════════════════
// 破棄の記録の見分け
// ═══════════════════════════════════════════════════════════════════════════════

describe('TEARDOWN_HANDLER_TARGET: 破棄の IPC と公開先の表（書き下し）', () => {
  it('★ 3つの IPC と公開先がこの対応で全部。凍結されている', () => {
    expect({ ...TEARDOWN_HANDLER_TARGET }).toEqual({
      'cloud:teardown': 'sakura-apprun',
      'hanamii:teardown': 'hanamii',
      'apprunDedicated:teardown': 'sakura-apprun-dedicated',
    })
    expect(Object.isFrozen(TEARDOWN_HANDLER_TARGET)).toBe(true)
  })
})

describe('isTeardownRecordOf: 見分けは target と handler の両方', () => {
  const HANDLERS = Object.keys(TEARDOWN_HANDLER_TARGET)

  it('★★ 3つの公開先 × 3つの破棄の IPC: 公開先と IPC が組になるときだけ true（対角線の3つだけ）', () => {
    const trues: string[] = []
    for (const t of TARGETS) for (const h of HANDLERS) if (isTeardownRecordOf(t, { target: t, handler: h })) trues.push(`${t} ${h}`)
    expect(trues.sort()).toEqual([
      'hanamii hanamii:teardown',
      'sakura-apprun cloud:teardown',
      'sakura-apprun-dedicated apprunDedicated:teardown',
    ])
  })

  it('★★ 記録の target が違えば、handler が自分の破棄でも false（別の公開先の破棄を自分のものにしない）', () => {
    for (const t of TARGETS) for (const other of TARGETS.filter(o => o !== t)) {
      expect(isTeardownRecordOf(t, { target: other, handler: TEARDOWN_HANDLER[t] })).toBe(false)
      expect(isTeardownRecordOf(t, { target: other, handler: TEARDOWN_HANDLER[other] })).toBe(false)
    }
  })

  it.each([
    ['同じ公開先の公開', 'hanamii', 'hanamii:publish'],
    ['専有型の作成', 'sakura-apprun-dedicated', 'apprunDedicated:create'],
    ['専有型の公開', 'sakura-apprun-dedicated', 'apprunDedicated:publishApp'],
    ['廃止した旧い口（アプリだけを消す）', 'sakura-apprun-dedicated', 'apprunDedicated:teardownApp'],
    ['共用型の公開', 'sakura-apprun', 'cloud:publish'],
    ['空の handler', 'hanamii', ''],
    ['Object.prototype 由来の名前', 'hanamii', 'constructor'],
    ['Object.prototype 由来の名前（toString）', 'hanamii', 'toString'],
    ['Object.prototype 由来の名前（__proto__）', 'hanamii', '__proto__'],
  ])('%s（%s・%s）→ false', (_label, target, handler) => {
    expect(isTeardownRecordOf(target as PublishTargetKind, { target, handler })).toBe(false)
  })

  it('handler が文字列でない・記録が無い・空 → false', () => {
    expect(isTeardownRecordOf('hanamii', { target: 'hanamii', handler: 1 as any })).toBe(false)
    expect(isTeardownRecordOf('hanamii', { target: 'hanamii' })).toBe(false)
    expect(isTeardownRecordOf('hanamii', { handler: 'hanamii:teardown' })).toBe(false)
    expect(isTeardownRecordOf('hanamii', {})).toBe(false)
    expect(isTeardownRecordOf('hanamii', null)).toBe(false)
    expect(isTeardownRecordOf('hanamii', undefined)).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 走っていれば、外して付け直しても進み具合が出る
// ═══════════════════════════════════════════════════════════════════════════════

describe('★★★ 走っていれば、外して付け直しても進み具合が出る', () => {
  it('破棄が走っている最中に付け直すと、走っていることと最新の進み具合が出る（外している間に進んだ分も）', async () => {
    const { api } = makeApi()
    const op = startTeardown('hanamii', OK_RESULT)
    op.progress('プロジェクトを削除しています…')
    const first = mount(api)
    await flush()
    expect(first.lastRunning()?.running?.startedAt).toBeGreaterThan(0)
    expect(first.lastRunning()?.other).toBeNull()
    first.watch.stop()

    op.progress('保存場所を削除しています…')
    const second = mount(api)
    await flush()
    const view = second.lastRunning()!
    expect(view.running?.handler).toBe('hanamii:teardown')
    expect(view.running?.progress.label).toBe('保存場所を削除しています…')
    await finish(op)
    second.watch.stop()
  })

  it('走っている間に届く押し出し（開いている間）で、進み具合が更新される。終わると running が外れる', async () => {
    const { api } = makeApi()
    const m = mount(api)
    await flush()
    expect(m.lastRunning()).toEqual({ running: null, other: null })
    const op = startTeardown('hanamii', OK_RESULT)
    op.progress('一覧を取得しています…')
    await flush()
    expect(m.lastRunning()?.running?.progress.label).toBe('一覧を取得しています…')
    await finish(op)
    await flush()
    expect(m.lastRunning()).toEqual({ running: null, other: null })
    m.watch.stop()
  })

  it('★★ 3つの公開先、どれでも自分の破棄が走っていれば running になる', async () => {
    for (const t of TARGETS) {
      resetProjectOpsForTests()
      const { api } = makeApi()
      const op = startTeardown(t, OK_RESULT)
      const m = mount(api, { target: t })
      await flush()
      expect(m.lastRunning()?.running?.handler, t).toBe(TEARDOWN_HANDLER[t])
      await finish(op)
      m.watch.stop()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 終わっていれば、結果と警告が出る。ack のあとは出ない
// ═══════════════════════════════════════════════════════════════════════════════

describe('★★★ 終わっていれば、外して付け直したとき結果が出る。ack のあとは出ない（警告つきは出続ける）', () => {
  it('★★ 警告の無い結果: 付け直すと1回だけ渡り、画面に渡したあとで ack する。もう一度付け直しても出ない', async () => {
    const { api, acks } = makeApi()
    await finish(startTeardown('hanamii', OK_RESULT))
    const m1 = mount(api)
    await flush()
    expect(m1.allFinished()).toHaveLength(1)
    expect(m1.allFinished()[0].result?.ok).toBe(true)
    expect(acks).toHaveLength(1)
    expect(acks[0][0]).toBe(DIR)
    expect(acks[0][1]).toBe(m1.allFinished()[0].startedAt)
    m1.watch.stop()

    const m2 = mount(api)
    await flush()
    expect(m2.allFinished()).toEqual([]) // 見た印のあとは出ない
    m2.watch.stop()
  })

  it('★★★ 警告つきの結果（保存場所を残して月額が続く）: 画面は ack しない。何度付け直しても出る', async () => {
    const { api, acks } = makeApi()
    await finish(startTeardown('hanamii', OK_WITH_WARNING))
    for (let i = 0; i < 3; i++) {
      const m = mount(api)
      await flush()
      expect(m.allFinished(), `${i + 1}回目`).toHaveLength(1)
      expect(m.allFinished()[0].result?.warnings.some(w => w.includes('koto-data-x')), 'main の記録に警告がある').toBe(true)
      m.watch.stop()
    }
    expect(acks).toEqual([]) // 警告つきの記録は、パネルは「見た」と伝えない
    expect(getOps(DIR).last?.seen).toBe(false)
  })

  it('★★ 同じ記録は、押し出しが何度届いても1回しか渡さない', async () => {
    const { api, subs } = makeApi()
    await finish(startTeardown('hanamii', OK_WITH_WARNING)) // 警告つき＝ack されず残る
    const m = mount(api)
    await flush()
    expect(m.allFinished()).toHaveLength(1)
    for (let i = 0; i < 3; i++) for (const cb of [...subs]) cb({ projectDir: DIR, ...getOps(DIR) })
    await flush()
    expect(m.allFinished()).toHaveLength(1)
    m.watch.stop()
  })

  it('★ ack が効かず記録が残り続けても、同じ ack を繰り返し送らない（押し出しが何度届いても1回）', async () => {
    await finish(startTeardown('hanamii', OK_RESULT))
    const snap = getOps(DIR)
    const subs = new Set<(p: Push) => void>()
    const acks: Array<number | undefined> = []
    const api: ProjectOpsApi = {
      get: async () => snap,
      ack: async (_d, upTo) => { acks.push(upTo); return { ok: true } }, // 実際には見たことにならない（記録は残り続ける）
      onChanged: cb => { subs.add(cb); return () => { subs.delete(cb) } },
    }
    const m = mount(api)
    await flush()
    for (let i = 0; i < 3; i++) for (const cb of [...subs]) cb({ projectDir: DIR, ...snap })
    await flush()
    expect(m.allFinished()).toHaveLength(1)
    expect(acks).toEqual([snap.last!.startedAt])
    m.watch.stop()
  })

  it('★★ 見られていない結果が2件あるとき、どちらも古い順に届く（前の警告を上書きで見逃さない）', async () => {
    const { api } = makeApi()
    await finish(startTeardown('hanamii', { ok: false, executed: [], message: '1回目は断られました' }))
    await finish(startTeardown('hanamii', { ok: true, executed: [], message: '2回目' }))
    const m = mount(api)
    await flush()
    const got = m.allFinished()
    expect(got.map(r => r.result?.message)).toEqual(['1回目は断られました', '2回目'])
    expect(got[0].startedAt).toBeLessThan(got[1].startedAt)
    m.watch.stop()
  })

  it('★★ 警告の無い結果が2件あるとき、新しいほうの startedAt まで1回で ack する', async () => {
    const { api, acks } = makeApi()
    await finish(startTeardown('hanamii', { ok: true, executed: [], message: '1回目' }))
    await finish(startTeardown('hanamii', { ok: true, executed: [], message: '2回目' }))
    const m = mount(api)
    await flush()
    const got = m.allFinished()
    expect(got).toHaveLength(2)
    expect(acks).toEqual([[DIR, got[1].startedAt]])
    m.watch.stop()
  })

  it('★★★ 開いている間の終わり: 走っている最中に開いた画面へ、終わったとき結果が届く（重ねて届かない）', async () => {
    const { api, acks } = makeApi()
    const op = startTeardown('hanamii', OK_RESULT)
    const m = mount(api)
    await flush()
    expect(m.allFinished()).toEqual([])
    await finish(op)
    await flush()
    expect(m.allFinished()).toHaveLength(1)
    expect(acks).toHaveLength(1)
    m.watch.stop()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 別の公開先・別の操作の記録は出さない・巻き込まない（掟11）
// ═══════════════════════════════════════════════════════════════════════════════

describe('★★ 別の公開先・別の操作の記録は出さない・巻き込まない（掟11）', () => {
  it('別の公開先（専有型）の破棄が走っている: 詳細は出さず「別の操作」だけ。自分の running は立たない', async () => {
    const { api } = makeApi()
    const op = startTeardown('sakura-apprun-dedicated', OK_RESULT)
    const m = mount(api, { target: 'hanamii' })
    await flush()
    const v = m.lastRunning()!
    expect(v.running).toBeNull()
    expect(v.other).toEqual({ op: '削除', targetLabel: PUBLISH_TARGET_LABEL['sakura-apprun-dedicated'] })
    await finish(op)
    m.watch.stop()
  })

  it('★★ 同じ公開先の公開（hanamii:publish）が走っている: 破棄の running にならず、別の操作として1行の知らせになる', async () => {
    const { api } = makeApi()
    const op = startOp('hanamii', 'hanamii:publish', { ok: true }, { op: '公開' })
    const m = mount(api, { target: 'hanamii' })
    await flush()
    expect(m.lastRunning()?.running).toBeNull()
    expect(m.lastRunning()?.other).toEqual({ op: '公開', targetLabel: PUBLISH_TARGET_LABEL.hanamii })
    await finish(op)
    m.watch.stop()
  })

  it('公開先が分からない記録（target が unknown）の操作は、targetLabel が null の「別の操作」', async () => {
    const { api } = makeApi()
    const op = startOp('unknown', 'test:hold', { ok: true }, { op: '公開' })
    const m = mount(api)
    await flush()
    expect(m.lastRunning()?.other).toEqual({ op: '公開', targetLabel: null })
    await finish(op)
    m.watch.stop()
  })

  it('★★ 別の公開先の結果は渡さず、ack でも巻き込まない。自分のものが先に挟まれていなければ、自分の分だけ ack する', async () => {
    const { api, acks } = makeApi()
    await finish(startTeardown('hanamii', OK_RESULT)) // 自分のもの（古い）
    await finish(startTeardown('sakura-apprun-dedicated', OK_RESULT)) // 別の公開先（新しい）
    const m = mount(api, { target: 'hanamii' })
    await flush()
    expect(m.allFinished()).toHaveLength(1)
    expect(m.allFinished()[0].handler).toBe('hanamii:teardown')
    expect(acks).toEqual([[DIR, m.allFinished()[0].startedAt]]) // 別の公開先の分には届かない
    m.watch.stop()
  })

  it('★★★ 別の公開先の結果のほうが古いときは、自分のものも ack せず残す（累積の ack でその持ち場の結果を消さない）', async () => {
    const { api, acks } = makeApi()
    await finish(startTeardown('sakura-apprun-dedicated', OK_RESULT)) // 別の公開先（古い）
    await finish(startTeardown('hanamii', OK_RESULT)) // 自分のもの（新しい）
    const m = mount(api, { target: 'hanamii' })
    await flush()
    expect(m.allFinished()).toHaveLength(1) // 自分のものは出す
    expect(acks).toEqual([]) // 古い別の持ち場の結果を挟んでいるので、ack しない
    m.watch.stop()
  })

  it('★★ 同じ公開先の公開の結果も、破棄の結果として渡さず、ack の連鎖もそこで止まる', async () => {
    const { api, acks } = makeApi()
    await finish(startOp('hanamii', 'hanamii:publish', { ok: true }, { op: '公開' }))
    await finish(startTeardown('hanamii', OK_RESULT))
    const m = mount(api, { target: 'hanamii' })
    await flush()
    expect(m.allFinished().map(r => r.handler)).toEqual(['hanamii:teardown'])
    expect(acks).toEqual([])
    m.watch.stop()
  })

  it('★ ack できずに残っている結果も、押し出しが何度届いても1回しか渡さない', async () => {
    const { api, subs } = makeApi()
    await finish(startTeardown('sakura-apprun-dedicated', OK_RESULT))
    await finish(startTeardown('hanamii', OK_RESULT))
    const m = mount(api, { target: 'hanamii' })
    await flush()
    for (let i = 0; i < 3; i++) for (const cb of [...subs]) cb({ projectDir: DIR, ...getOps(DIR) })
    await flush()
    expect(m.allFinished()).toHaveLength(1)
    m.watch.stop()
  })

  it('★★ 別のプロジェクトの知らせは無視する。末尾の / の有無は同じプロジェクトとして扱う', async () => {
    const { api, subs } = makeApi()
    const m = mount(api, { dir: `${DIR}/` })
    await flush()
    const before = m.running.length
    await finish(startTeardown('hanamii', OK_WITH_WARNING, OTHER_DIR))
    await flush()
    expect(m.allFinished()).toEqual([]) // 別のプロジェクトの結果
    expect(m.running.length).toBe(before) // running の知らせも来ない
    await finish(startTeardown('hanamii', OK_WITH_WARNING, DIR))
    await flush()
    expect(m.allFinished()).toHaveLength(1) // 末尾の / が違っても同じプロジェクト
    expect(subs.size).toBe(1)
    m.watch.stop()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// この画面が始めた破棄は、記録から二重に出さない（結果を出し終えるまで ack もしない）
// ═══════════════════════════════════════════════════════════════════════════════

describe('★★★ この画面が始めた破棄は、記録から二重に出さない（出し終えるまで ack もしない）', () => {
  it('beginLocal〜endLocal: 終わっても onFinished へ渡さず、endLocal までは ack しない。endLocal で ack する', async () => {
    const { api, acks } = makeApi()
    const m = mount(api)
    await flush()
    m.watch.beginLocal()
    await finish(startTeardown('hanamii', OK_RESULT))
    await flush()
    expect(m.allFinished()).toEqual([]) // 画面が自分の返り値から出す
    expect(acks).toEqual([]) // 出し終えるまでは「見た」ではない
    m.watch.endLocal()
    await flush()
    expect(m.allFinished()).toEqual([]) // endLocal でも二重に渡さない
    expect(acks).toHaveLength(1)
    expect(acks[0][1]).toBe(getOps(DIR).last?.startedAt ?? acks[0][1])
    m.watch.stop()
  })

  it('★★ 出し終える前に窓が閉じたら ack されず、開き直したとき記録から結果が出る（結果を失わない）', async () => {
    const { api, acks } = makeApi()
    const first = mount(api)
    await flush()
    first.watch.beginLocal()
    await finish(startTeardown('hanamii', OK_RESULT))
    await flush()
    first.watch.stop() // endLocal の前に窓が閉じた
    expect(acks).toEqual([])
    const reopened = mount(api)
    await flush()
    expect(reopened.allFinished()).toHaveLength(1) // 記録から出る
    reopened.watch.stop()
  })

  it('★★ 出している最中の結果 L より新しい別の持ち場の記録 C が届いても、C の ack に L を巻き込まない。L を出し終えたら両方まとめて ack', async () => {
    const { api, acks } = makeApi()
    const m = mount(api)
    await flush()
    m.watch.beginLocal()
    await finish(startTeardown('hanamii', OK_RESULT)) // L（この画面が始めた破棄）
    await finish(startOp('hanamii', 'hanamii:publish', { ok: true }, { op: '公開' })) // C（別の操作・新しい）
    await flush()
    expect(acks).toEqual([]) // L を出し終えるまで、C の分も伝えない
    const snap = getOps(DIR)
    const lStartedAt = [...snap.earlier, ...(snap.last ? [snap.last] : [])].find(r => r.handler === 'hanamii:teardown')?.startedAt
    expect(lStartedAt).toBeDefined()
    m.watch.endLocal()
    await flush()
    // C は自分の持ち場の結果ではないので、連鎖は C の手前（L）で止まる。L は出し終えたので伝わる。
    expect(acks).toEqual([[DIR, lStartedAt]])
    m.watch.stop()
  })

  it('★ この画面が始める前に終わっていた破棄は、二重扱いにせず出す（beginLocal の時刻より前の記録は、この画面のものではない）', async () => {
    const { api } = makeApi()
    await finish(startTeardown('hanamii', OK_WITH_WARNING))
    const record = getOps(DIR).last!
    const m = mount(api, { now: () => record.startedAt + 1_000_000 }) // 始めた時刻は、記録の startedAt よりずっと後
    m.watch.beginLocal() // 最初の問い合わせの応答が届く前に始める
    await flush()
    expect(m.allFinished()).toHaveLength(1)
    m.watch.stop()
  })

  it('★ この画面が始めた破棄（beginLocal の時刻以降の記録）は渡さない', async () => {
    const { api } = makeApi()
    await finish(startTeardown('hanamii', OK_WITH_WARNING))
    const record = getOps(DIR).last!
    const m = mount(api, { now: () => record.startedAt - 1 })
    m.watch.beginLocal()
    await flush()
    expect(m.allFinished()).toEqual([])
    m.watch.stop()
  })

  it('★★★ 出し終えたあと（endLocal の後）に別の入口が始めた同じ公開先の破棄は、この画面のものではない: 記録から渡し、渡してから ack する（誰にも見せないまま「見た」にしない）', async () => {
    const { api, acks } = makeApi()
    const m = mount(api)
    await flush()
    m.watch.beginLocal()
    await finish(startTeardown('hanamii', OK_RESULT)) // L（この画面が始めて、出し終えた）
    await flush()
    const lStartedAt = getOps(DIR).last!.startedAt // ack の前（ack すると未読の記録から消える）
    m.watch.endLocal()
    await flush()
    expect(m.allFinished()).toEqual([])
    expect(acks).toHaveLength(1)
    expect(acks[0][1]).toBe(lStartedAt)

    await new Promise<void>(r => setTimeout(r, 5)) // endLocal より後の時刻に始める（時計の同じ1ミリ秒に入らない）
    // 別の入口（別の画面・別の窓）が始めた同じ公開先の破棄。警告の無い失敗（ackUpToFor は止めない種類）。
    await finish(startTeardown('hanamii', { ok: false, executed: [], message: '別の入口の破棄が断られました' }))
    await flush()
    // この画面が始めたものではないので、onFinished へ渡す（誰にも見せないまま ack しない）。
    expect(m.allFinished()).toHaveLength(1)
    const otherStartedAt = m.allFinished()[0].startedAt
    expect(otherStartedAt).toBeGreaterThan(lStartedAt)
    expect(m.allFinished()[0].result?.message).toBe('別の入口の破棄が断られました')
    // 渡したあとで ack する。
    expect(acks).toHaveLength(2)
    expect(acks[1][1]).toBe(otherStartedAt)
    m.watch.stop()
  })

  it('★ 同じ画面が2回続けて始めた破棄は、2回とも自分のもの（beginLocal のたびに窓を張り直す）。間に挟まった別の入口の破棄だけが、記録から渡る', async () => {
    const { api } = makeApi()
    const m = mount(api)
    await flush()
    m.watch.beginLocal()
    await finish(startTeardown('hanamii', OK_RESULT)) // 1回目（自分）
    await flush()
    m.watch.endLocal()
    await new Promise<void>(r => setTimeout(r, 5))
    await finish(startTeardown('hanamii', { ok: false, executed: [], message: '間に挟まった別の入口' }))
    await new Promise<void>(r => setTimeout(r, 5))
    m.watch.beginLocal()
    await finish(startTeardown('hanamii', OK_RESULT)) // 2回目（自分）
    await flush()
    m.watch.endLocal()
    await flush()
    expect(m.allFinished().map(r => r.result?.message)).toEqual(['間に挟まった別の入口'])
    m.watch.stop()
  })

  // 段階1の1b（HANAMII の一覧の行）で見つかった穴: HANAMII が削除を受け付けただけの結果（受付済み）は警告つきの記録になり、ack されず残る。
  // 同じ画面が「もう一度破棄を押す」と beginLocal で窓を張り直すので、前の結果が窓の外になり、「閉じている間に終わった記録」として
  // 記録から重ねて渡されていた（押し直した最中に、前の結果が結果欄にまた出る）。この画面が自分の返り値から出した結果は、渡したことにする。
  it('★★★ 警告つきの結果（ack されず残る）を出したあと、同じ画面がもう一度始めても、前の結果を記録から重ねて渡さない', async () => {
    const { api, acks } = makeApi()
    const m = mount(api)
    await flush()
    m.watch.beginLocal()
    await finish(startTeardown('hanamii', OK_WITH_WARNING)) // 1回目（自分）。警告つき＝ack されない
    await flush()
    m.watch.endLocal()
    await flush()
    expect(acks).toEqual([])
    expect(m.allFinished()).toEqual([])
    await new Promise<void>(r => setTimeout(r, 5))
    m.watch.beginLocal() // 押し直し。窓を張り直す
    await flush()
    expect(m.allFinished(), '前の結果（この画面が出し済み）が、記録から重ねて渡された').toEqual([])
    m.watch.refresh()
    await flush()
    expect(m.allFinished()).toEqual([])
    // この画面を閉じて開き直したときは、記録から出る（結果を失わない）
    m.watch.stop()
    const reopened = mount(api)
    await flush()
    expect(reopened.allFinished()).toHaveLength(1)
    reopened.watch.stop()
  })

  it('endLocal は beginLocal が無ければ何もしない（ack もしない）', async () => {
    const { api, acks } = makeApi()
    await finish(startTeardown('hanamii', OK_WITH_WARNING))
    const m = mount(api)
    await flush()
    m.watch.endLocal()
    await flush()
    expect(acks).toEqual([])
    m.watch.stop()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 隠れているタブでは、結果を渡しても ack しない
// ═══════════════════════════════════════════════════════════════════════════════

describe('★★★ 隠れているタブ（isVisible が false）では、結果を渡しても ack しない。また出たとき（visibilityChanged）に ack する', () => {
  it('隠れている間に終わった結果: 画面へは渡すが ack しない。出たとき ack する。二重には渡さない', async () => {
    const { api, acks } = makeApi()
    let visible = false
    await finish(startTeardown('hanamii', OK_RESULT))
    const m = mount(api, { isVisible: () => visible })
    await flush()
    expect(m.allFinished()).toHaveLength(1)
    expect(acks).toEqual([]) // 利用者はまだ見ていない
    visible = true
    m.watch.visibilityChanged()
    await flush()
    expect(acks).toHaveLength(1)
    expect(m.allFinished()).toHaveLength(1) // 二重に渡さない
    m.watch.stop()
  })

  it('隠れたら（visible → hidden）また ack しなくなる。すでに伝えた分は取り消さない', async () => {
    const { api, acks } = makeApi()
    let visible = true
    const m = mount(api, { isVisible: () => visible })
    await flush()
    await finish(startTeardown('hanamii', OK_RESULT))
    await flush()
    expect(acks).toHaveLength(1)
    visible = false
    await finish(startTeardown('hanamii', OK_RESULT))
    await flush()
    expect(acks).toHaveLength(1) // 隠れている間の分は伝えない
    m.watch.stop()
  })

  it('isVisible を渡さない呼び出しは、見えているものとして扱う', async () => {
    const { api, acks } = makeApi()
    await finish(startTeardown('hanamii', OK_RESULT))
    const m = mount(api)
    await flush()
    expect(acks).toHaveLength(1)
    m.watch.stop()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 問い合わせ・聞き直し・外す
// ═══════════════════════════════════════════════════════════════════════════════

describe('問い合わせ（get）の応答が遅れても古い写しで戻さない／聞き直し／外す', () => {
  it('get の応答より先に押し出しが届いたら、get の応答は使わない', async () => {
    const subs = new Set<(p: Push) => void>()
    let releaseGet!: () => void
    const gate = new Promise<void>(r => { releaseGet = r })
    const empty = { running: null, last: null, earlier: [] } as ProjectOpsSnapshotShape
    const api: ProjectOpsApi = {
      get: async () => { await gate; return empty },
      ack: async () => ({ ok: true }),
      onChanged: cb => { subs.add(cb); return () => { subs.delete(cb) } },
    }
    const m = mount(api)
    const op = startTeardown('hanamii', OK_RESULT)
    for (const cb of [...subs]) cb({ projectDir: DIR, ...getOps(DIR) }) // 押し出しが先に届く（走っている）
    expect(m.lastRunning()?.running).not.toBeNull()
    releaseGet()
    await flush()
    expect(m.lastRunning()?.running, '古い（空の）応答で戻していない').not.toBeNull()
    await finish(op)
    m.watch.stop()
  })

  it('get が失敗しても壊れない', async () => {
    const api: ProjectOpsApi = {
      get: async () => { throw new Error('preload 未注入') },
      ack: async () => ({ ok: true }),
      onChanged: () => () => {},
    }
    const m = mount(api)
    await flush()
    expect(m.running).toEqual([])
    m.watch.stop()
  })

  it('★ 押し出しが途絶えた状態で操作が終わっても、refresh で終わりと結果が届く', async () => {
    const live = makeApi()
    // 押し出しを受けない偽の api（get だけが最新を返す）
    const api: ProjectOpsApi = { get: live.api.get, ack: live.api.ack, onChanged: () => () => {} }
    const op = startTeardown('hanamii', OK_RESULT)
    const m = mount(api)
    await flush()
    expect(m.lastRunning()?.running).not.toBeNull()
    await finish(op)
    await flush()
    expect(m.lastRunning()?.running).not.toBeNull() // 押し出しが届かないので、まだ「走っている」のまま
    m.watch.refresh()
    await flush()
    expect(m.lastRunning()).toEqual({ running: null, other: null })
    expect(m.allFinished()).toHaveLength(1)
    m.watch.stop()
  })

  it('外したあとは何も届けず、ack もしない（refresh・endLocal・visibilityChanged も何もしない）', async () => {
    const { api, acks, subs } = makeApi()
    const m = mount(api)
    await flush()
    m.watch.beginLocal()
    m.watch.stop()
    expect(subs.size).toBe(0) // 購読も外れる
    const before = m.running.length
    await finish(startTeardown('hanamii', OK_RESULT))
    m.watch.refresh()
    m.watch.endLocal()
    m.watch.visibilityChanged()
    await flush()
    expect(m.running.length).toBe(before)
    expect(m.allFinished()).toEqual([])
    expect(acks).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// resumedTeardownNote: 閉じて開き直したあとの結果に添える知らせ
// ═══════════════════════════════════════════════════════════════════════════════

const WORDS = (verb: '破棄' | '削除'): TeardownWords => ({
  verb, confirmTitle: 't', confirmLabel: 'c', activityLabel: 'a', rowButton: '🗑 破棄', running: 'r',
  doneHeadline: 'd', inProgressHeadline: 'i', failedHeadline: 'f', factsUnreadable: 'u', nothingToDo: 'n', askAiTarget: 'x',
})

/** 記録の形（ProjectOpRecordShape）を手で組む。 */
function record(over: {
  target?: string; handler?: string; startedAt?: number; finishedAt?: number | undefined
  result?: { ok: boolean; message?: string; lines?: string[]; warnings?: string[]; extra?: Record<string, unknown> } | undefined
}): ProjectOpRecordShape {
  const result = 'result' in over ? over.result : { ok: true, lines: [], warnings: [], extra: {} }
  return {
    op: '削除', target: over.target ?? 'hanamii', handler: over.handler ?? 'hanamii:teardown',
    startedAt: over.startedAt ?? 100, running: false, progress: {}, seen: false,
    ...('finishedAt' in over ? (over.finishedAt === undefined ? {} : { finishedAt: over.finishedAt }) : { finishedAt: 5000 }),
    ...(result ? { result: { detail: undefined, url: undefined, ...result, lines: result.lines ?? [], warnings: result.warnings ?? [], extra: result.extra ?? {} } } : {}),
  } as unknown as ProjectOpRecordShape
}
/** 本物の summarizeResult を通した記録（main が実際に書く警告）。 */
function recordOf(raw: unknown, target: PublishTargetKind = 'sakura-apprun-dedicated'): ProjectOpRecordShape {
  return record({ target, handler: TEARDOWN_HANDLER[target], result: summarizeResult(raw) })
}

describe('resumedTeardownNote: 見出し・一言・警告', () => {
  it('★ 見出しは「🔔 {動詞}の結果（HH:MM に終わりました）」（T162。「です」と句点なし）。動詞は公開先の言葉（破棄／削除）で、手本の「手順6」は言わない', () => {
    const rec = record({ finishedAt: new Date(2026, 9, 9, 9, 5).getTime() })
    expect(resumedTeardownNote(WORDS('破棄'), rec).headline).toBe(`🔔 破棄の結果（${clockText(rec.finishedAt)} に終わりました）`)
    expect(resumedTeardownNote(WORDS('削除'), rec).headline).toBe(`🔔 削除の結果（09:05 に終わりました）`)
    expect(resumedTeardownNote(WORDS('削除'), rec).headline).not.toContain('手順')
  })

  it('終わった時刻が無い記録は、時刻の言い回しごと省く。finishedAt は null', () => {
    const n = resumedTeardownNote(WORDS('破棄'), record({ finishedAt: undefined }))
    expect(n.headline).toBe('🔔 破棄の結果')
    expect(n.finishedAt).toBeNull()
  })

  it('★ ok は true のときだけ true（"true"・1・空オブジェクト・配列は失敗。不明な値を肯定に戻さない）', () => {
    for (const ok of ['true', 1, {}, [], 'yes', null]) {
      expect(resumedTeardownNote(WORDS('破棄'), record({ result: { ok: ok as any } })).ok, JSON.stringify(ok)).toBe(false)
    }
    expect(resumedTeardownNote(WORDS('破棄'), record({ result: { ok: true } })).ok).toBe(true)
  })

  it('★ 中身の無い警告（空の文）は出さない（「⚠️ 」だけの行にしない）', () => {
    const n = resumedTeardownNote(WORDS('破棄'), record({ result: { ok: true, message: '成功しました', warnings: ['', '別の知らせ'] } }))
    expect(n.warnings).toEqual(['⚠️ 別の知らせ'])
  })

  it('★★ 成功なのに止まったものが記録にある（一覧を出さない回）: 「削除の途中で…」の警告は落とさない', () => {
    const rec = recordOf({ ok: true, executed: [], message: '', inProgress: { loadBalancerID: 'l1' } })
    expect(rec.result!.warnings.some(w => w.startsWith(TEARDOWN_IN_PROGRESS_WARNING_HEAD))).toBe(true)
    expect(resumedTeardownNote(WORDS('削除'), rec).warnings).toEqual(rec.result!.warnings.map(w => `⚠️ ${w}`))
  })

  it('startedAt・finishedAt・ok・message は記録のまま', () => {
    const n = resumedTeardownNote(WORDS('破棄'), record({ startedAt: 777, finishedAt: 888, result: { ok: false, message: '断られました' } }))
    expect(n).toMatchObject({ startedAt: 777, finishedAt: 888, ok: false, message: '断られました' })
    expect(resumedTeardownNote(WORDS('破棄'), record({ result: { ok: true } })).ok).toBe(true)
  })

  it('★ 結果が無い記録: 読み取れなかった旨を言い、ok は false、警告は無い', () => {
    const n = resumedTeardownNote(WORDS('破棄'), record({ result: undefined }))
    expect(n.ok).toBe(false)
    expect(n.message).toBe('結果を読み取れませんでした。コントロールパネルで、実際の状態を確かめてください。')
    expect(n.warnings).toEqual([])
  })

  it('★ 警告は ⚠️ を付けた1行にする（印が付いていれば二重に付けない）', () => {
    const n = resumedTeardownNote(WORDS('破棄'), record({ result: { ok: true, warnings: ['月額が続きます', '⚠️ 鍵の無効化に失敗しました', '※ 注意です'] } }))
    expect(n.warnings).toEqual(['⚠️ 月額が続きます', '⚠️ 鍵の無効化に失敗しました', '※ 注意です'])
  })

  it('★★ 専有型: 残ったものの一覧を結果欄が出すので、「削除できずに残っています」の警告は重ねない。main の実際の文で確かめる', () => {
    const rec = recordOf({ ok: false, executed: [], message: '失敗', remaining: { loadBalancerID: 'l1', clusterID: 'c1' } })
    const mainWarnings = rec.result!.warnings
    expect(mainWarnings.length).toBeGreaterThan(0)
    expect(mainWarnings.every(w => w.startsWith(TEARDOWN_REMAINING_WARNING_HEAD))).toBe(true) // 書き出しが main と食い違っていないこと
    expect(resumedTeardownNote(WORDS('削除'), rec).warnings).toEqual([])
  })

  it('★★ 専有型: 待ち切れず止まった一覧を結果欄が出すので、「削除の途中で…」の警告は重ねない。main の実際の文で確かめる', () => {
    const rec = recordOf({ ok: false, executed: [], message: '待ち切れませんでした', remaining: { loadBalancerID: 'l1' }, inProgress: { loadBalancerID: 'l1' } })
    const mainWarnings = rec.result!.warnings
    expect(mainWarnings.length).toBeGreaterThan(0)
    expect(mainWarnings.every(w => w.startsWith(TEARDOWN_IN_PROGRESS_WARNING_HEAD))).toBe(true)
    expect(resumedTeardownNote(WORDS('削除'), rec).warnings).toEqual([])
  })

  it('★★ 一覧を出せない回は、同じ書き出しの知らせでも落とさない（残ったものの名前が1件も無い・待ち切れた一覧が空）', () => {
    const w1 = `${TEARDOWN_REMAINING_WARNING_HEAD}。何かが残っているらしい`
    const w2 = `${TEARDOWN_IN_PROGRESS_WARNING_HEAD}。もう一度`
    const noNames = record({ target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:teardown', result: { ok: false, message: '失敗', warnings: [w1], extra: { remaining: {} } } })
    expect(resumedTeardownNote(WORDS('削除'), noNames).warnings).toEqual([`⚠️ ${w1}`])
    const emptyList = record({ target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:teardown', result: { ok: false, message: '失敗', warnings: [w2], extra: { inProgress: {} } } })
    expect(resumedTeardownNote(WORDS('削除'), emptyList).warnings).toEqual([`⚠️ ${w2}`])
  })

  it('★★ 残ったものの一覧があっても、ほかの知らせは落とさない', () => {
    const rec = record({
      target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:teardown',
      result: { ok: false, message: '失敗', warnings: [`${TEARDOWN_REMAINING_WARNING_HEAD}。コントロールパネルから: x`, '別の知らせ'], extra: { remaining: { clusterID: 'c1' } } },
    })
    expect(resumedTeardownNote(WORDS('削除'), rec).warnings).toEqual(['⚠️ 別の知らせ'])
  })

  it('★★ HANAMII など保存場所を残した回: 月額の警告は一覧が無いので、そのまま知らせに載る', () => {
    const rec = recordOf({ ok: true, executed: [], keptBucketName: 'koto-data-x' }, 'hanamii')
    expect(rec.result!.warnings.length).toBeGreaterThan(0)
    // main の月額の警告は ⚠️ 付きで届く（二重に付けない）。
    expect(rec.result!.warnings.every(w => w.startsWith('⚠️'))).toBe(true)
    expect(resumedTeardownNote(WORDS('破棄'), rec).warnings).toEqual(rec.result!.warnings)
  })

  it('★★ message に含まれる文の警告は重ねない（結果欄が message をそのまま出す）。含まれない警告は残す', () => {
    const accepted = 'HANAMII が削除を受け付けましたが、まだ終わっていません。'
    const rec = record({ result: { ok: false, message: accepted, warnings: [accepted, '別の知らせ'] } })
    expect(resumedTeardownNote(WORDS('破棄'), rec).warnings).toEqual(['⚠️ 別の知らせ'])
    const other = record({ result: { ok: false, message: '失敗しました', warnings: ['月額が続きます'] } })
    expect(resumedTeardownNote(WORDS('破棄'), other).warnings).toEqual(['⚠️ 月額が続きます'])
  })

  it('message が空のとき、空でない警告は落とさない（空の message にはどの文も含まれる、という誤読をしない）', () => {
    const rec = record({ result: { ok: true, message: '', warnings: ['月額が続きます'] } })
    expect(resumedTeardownNote(WORDS('破棄'), rec).warnings).toEqual(['⚠️ 月額が続きます'])
  })

  it('公開先が分からない記録（target が unknown）でも読める（一覧の判断はしないが、落ちない）', () => {
    const rec = record({ target: 'unknown', handler: 'test:hold', result: { ok: false, message: '失敗', warnings: [`${TEARDOWN_REMAINING_WARNING_HEAD}。x`] } })
    expect(resumedTeardownNote(WORDS('破棄'), rec).warnings).toEqual([`⚠️ ${TEARDOWN_REMAINING_WARNING_HEAD}。x`])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// N2: 「Koto の終了で止まりました」の知らせ（起動の読み戻しが置く記録）の見出しと、持ち場の画面への届き方
// ═══════════════════════════════════════════════════════════════════════════

describe('N2: resumedTeardownNote — 「Koto の終了で止まりました」の知らせは「に終わりました」と言わない', () => {
  const FINISHED = new Date(2026, 9, 10, 14, 9).getTime()

  it.each(TARGETS)('★★ %s: 見出しは「🔔 {動詞}は、Koto の終了で止まりました（HH:MM ごろ）」。「の結果」「に終わりました」は言わない。本物の知らせの記録で確かめる', target => {
    const rec = stoppedNotice(DIR, target, FINISHED)
    for (const verb of ['破棄', '削除'] as const) {
      const n = resumedTeardownNote(WORDS(verb), rec)
      expect(n.headline, verb).toBe(`🔔 ${verb}は、Koto の終了で止まりました（14:09 ごろ）`)
      expect(n.headline).not.toContain('に終わりました')
      expect(n.headline).not.toContain('の結果')
      expect(n).toMatchObject({ ok: false, finishedAt: FINISHED, message: stoppedNextStep(target), warnings: [], stoppedByQuit: true })
    }
  })

  it('時刻が読めない知らせは、時刻の言い回しごと省く（「ごろ」だけが残らない）', () => {
    const rec = stoppedNotice(DIR, 'sakura-apprun-dedicated', FINISHED)
    const noTime = { ...rec, finishedAt: undefined } as unknown as ProjectOpRecordShape
    expect(resumedTeardownNote(WORDS('削除'), noTime).headline).toBe('🔔 削除は、Koto の終了で止まりました')
  })

  it('★★ 知らせでない記録の見出しは今までのまま（「の結果（HH:MM に終わりました）」）。stoppedByQuit のキーも無い', () => {
    const rec = record({ finishedAt: FINISHED })
    const n = resumedTeardownNote(WORDS('削除'), rec)
    expect(n.headline).toBe('🔔 削除の結果（14:09 に終わりました）')
    expect('stoppedByQuit' in n).toBe(false)
    // extra.stoppedByQuit が true でない（偽の知らせにならない）
    const fake = record({ finishedAt: FINISHED, result: { ok: false, message: 'x', extra: { stoppedByQuit: 'true' } } })
    expect(resumedTeardownNote(WORDS('削除'), fake).headline).toBe('🔔 削除の結果（14:09 に終わりました）')
  })

  it('★★ 知らせの記録は、その公開先の持ち場の画面に1件だけ届き、出した画面が ack すると消える。別の公開先・別のプロジェクトの持ち場には届かず、ack もしない（掟11）', async () => {
    const { api, acks } = makeApi()
    const rec = stoppedNotice(DIR, 'hanamii', FINISHED)
    expect(isTeardownRecordOf('hanamii', rec)).toBe(true)
    // 持ち主でない画面を先に付ける: 何も受け取らず、見たとも伝えない（伝えると、持ち主の画面に届く前に消える）。
    const otherTarget = mount(api, { target: 'sakura-apprun' })
    const otherProject = mount(api, { target: 'hanamii', dir: OTHER_DIR })
    await flush()
    expect(otherTarget.allFinished(), '別の公開先の持ち場には出ない').toEqual([])
    expect(otherProject.allFinished(), '別のプロジェクトには出ない').toEqual([])
    expect(acks.filter(([dir]) => dir === DIR), '持ち主でない画面は見たと伝えない').toEqual([])
    expect(getOps(DIR).last?.startedAt, '前提: まだ見られていない').toBe(rec.startedAt)
    // 持ち主の画面: 1件届き、出し終えたので ack（警告の無い知らせは、これで消える）。
    const mine = mount(api, { target: 'hanamii' })
    await flush()
    expect(mine.allFinished().map(r => r.startedAt)).toEqual([rec.startedAt])
    expect(acks.filter(([dir]) => dir === DIR)).toEqual([[DIR, rec.startedAt]])
    expect(getOps(DIR).last, 'ack のあとは出ない').toBeNull()
    const again = mount(api, { target: 'hanamii' })
    await flush()
    expect(again.allFinished()).toEqual([])
  })
})
