import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  viewOfOps, ackSeen, opResultFromRecord, foreignBusyNote, progressTextOf, kindOfOp,
  beginCleanupJob, isCleanupRunning, takeFinishedCleanup, watchCleanup, resetCleanupJobsForTests,
} from '../src/renderer/components/AppRunPanel'
// 持ち場の判定・「どこまで見たと伝えてよいか」・警告の文は、共通の1か所（2026-09-30 検分の指摘2）。
// 共用型の画面が使う形（自分の記録で、出したもの）に当てはめて、ここで固定する。
import { isSharedTypeOp, unseenOf } from '../src/renderer/projectOpsView'
import { warningLine } from '../src/shared/opsText'
import * as ops from '../src/main/projectOps'
import { remainingCostWarning } from '../src/shared/cloudCost'

// ── 共用型 AppRun: 開き直しの判断（純関数）──────────────────────────────────────
// 画面を動かす振る舞いのテスト（tests/ops-shared-panel.test.ts）が主。ここは、その判断のうち
// 「どこまでを見たことにしてよいか」「記録をどう結果へ直すか」を、入力の組み合わせで固定する。
// 記録は本物の main（projectOps.ts）で作る——偽の形を手で書かない（形が変われば、ここが先に落ちる）。

const DIR = '/tmp/koto-ops-shared/pure'

beforeEach(() => { ops.resetProjectOpsForTests(); resetCleanupJobsForTests() })

function run(op: '公開' | '削除' | '作成', target: string, handler: string, value: Record<string, unknown>) {
  ops.beginOp(DIR, op, { target: target as any, handler })
  ops.finishOp(DIR, { value })
  return ops.getOps(DIR)
}
/**
 * **本物の AppRunPanel.ackSeen** を呼び、main の記録へ伝えた startedAt を返す（伝えなければ null）。
 * 偽の electronAPI.projectOps は本物の記録（projectOps.ts）の get／ack をそのまま通す。
 * （「どこまで伝えてよいか」の一般の規則は tests/projectOpsView.test.ts。ここは、共用型の画面が渡す
 *  「共用型の記録で、この画面が出したものだけ」という条件が、実際に効いていることを固定する。）
 */
async function ackedBySeen(shown: ReadonlySet<number>): Promise<number | null> {
  const calls: number[] = []
  ;(globalThis as any).window = {
    electronAPI: {
      projectOps: {
        get: async (d: string) => ops.getOps(d),
        ack: async (d: string, u?: number) => { calls.push(u as number); return { ok: true, acked: ops.ackOps(d, u) } },
        onChanged: () => () => {},
      },
    },
  }
  try {
    ackSeen(DIR, shown)
    for (let i = 0; i < 4; i++) await new Promise<void>(r => setTimeout(r, 0))
  } finally { delete (globalThis as any).window }
  return calls.length > 0 ? calls[calls.length - 1] : null
}

describe('isSharedTypeOp: この画面（共用型）の記録か', () => {
  it('sakura-apprun だけが共用型（専有型・HANAMII・Vercel・不明は別）', () => {
    expect(isSharedTypeOp({ target: 'sakura-apprun' })).toBe(true)
    expect(isSharedTypeOp({ target: 'sakura-apprun-dedicated' })).toBe(false)
    expect(isSharedTypeOp({ target: 'hanamii' })).toBe(false)
    expect(isSharedTypeOp({ target: 'vercel' })).toBe(false)
    expect(isSharedTypeOp({ target: 'unknown' })).toBe(false)
    expect(isSharedTypeOp({})).toBe(false)
    expect(isSharedTypeOp(null)).toBe(false)
    expect(isSharedTypeOp(undefined)).toBe(false)
  })
})

describe('viewOfOps: main の写しをこの画面の目で仕分ける', () => {
  it('何も無い・欠けている・壊れている写しでも落ちない', () => {
    const empty = { runningOwn: null, runningForeign: null, finishedOwn: [], finishedForeign: [] }
    expect(viewOfOps(null)).toEqual(empty)
    expect(viewOfOps(undefined)).toEqual(empty)
    expect(viewOfOps({})).toEqual(empty)
    expect(viewOfOps({ running: null, last: null, earlier: [] })).toEqual(empty)
    expect(viewOfOps({ earlier: 'x' as any, last: 5 as any, running: 'y' as any })).toEqual({ ...empty, runningForeign: null })
  })

  it('走っている操作を、共用型かそれ以外かで分ける', () => {
    ops.beginOp(DIR, '公開', { target: 'sakura-apprun', handler: 'cloud:apply' })
    let v = viewOfOps(ops.getOps(DIR))
    expect(v.runningOwn?.handler).toBe('cloud:apply')
    expect(v.runningForeign).toBeNull()
    ops.finishOp(DIR, { value: { ok: true } })
    ops.beginOp(DIR, '公開', { target: 'vercel', handler: 'vercel:publish' })
    v = viewOfOps(ops.getOps(DIR))
    expect(v.runningOwn).toBeNull()
    expect(v.runningForeign?.handler).toBe('vercel:publish')
  })

  it('見られていない結果は、共用型とそれ以外に分け、古い順に並ぶ', () => {
    run('削除', 'sakura-apprun', 'cloud:teardown', { ok: true })
    run('公開', 'hanamii', 'hanamii:publish', { ok: true })
    const snap = run('公開', 'sakura-apprun', 'cloud:apply', { ok: true })
    const v = viewOfOps(snap)
    expect(v.finishedOwn.map(r => r.handler)).toEqual(['cloud:teardown', 'cloud:apply'])
    expect(v.finishedForeign.map(r => r.handler)).toEqual(['hanamii:publish'])
    expect(v.finishedOwn[0].startedAt).toBeLessThan(v.finishedOwn[1].startedAt)
  })

  it('走っている記録が「終わった」欄に紛れても、終わった扱いにしない', () => {
    ops.beginOp(DIR, '公開', { target: 'sakura-apprun', handler: 'cloud:apply' })
    const running = ops.getOps(DIR).running!
    expect(viewOfOps({ running: null, last: running, earlier: [] }).finishedOwn).toEqual([])
  })
})

describe('ackSeen: どこまでを「見た」ことにしてよいか（別の画面の結果を巻き込まない・本物の ackSeen で確かめる）', () => {
  const started = (s: ProjectOpsSnapshotShape) => unseenOf(s).map(r => r.startedAt)

  it('見られていない記録が無ければ、何も伝えない', async () => {
    expect(await ackedBySeen(new Set([1, 2]))).toBeNull()
  })

  it('出したものが1つも無ければ、何も伝えない（何も見ていない）', async () => {
    run('公開', 'sakura-apprun', 'cloud:apply', { ok: true })
    expect(await ackedBySeen(new Set())).toBeNull()
  })

  it('出した共用型の記録だけなら、その startedAt', async () => {
    const s = run('公開', 'sakura-apprun', 'cloud:apply', { ok: true })
    const [a] = started(s)
    expect(await ackedBySeen(new Set([a]))).toBe(a)
  })

  it('★ 2件出したなら、新しいほう（まとめて見たことになる）', async () => {
    run('削除', 'sakura-apprun', 'cloud:teardown', { ok: true })
    const s = run('公開', 'sakura-apprun', 'cloud:apply', { ok: true })
    const [a, b] = started(s)
    expect(await ackedBySeen(new Set([a, b]))).toBe(b)
  })

  it('★★ 別の公開先の記録のほうが古いなら、それより後ろは見たことにしない（巻き込まない）', async () => {
    run('公開', 'hanamii', 'hanamii:publish', { ok: true })
    const s = run('公開', 'sakura-apprun', 'cloud:apply', { ok: true })
    const own = unseenOf(s).find(r => isSharedTypeOp(r))!.startedAt
    expect(await ackedBySeen(new Set([own]))).toBeNull()
    expect(unseenOf(ops.getOps(DIR))).toHaveLength(2) // どちらも残っている
  })

  it('別の公開先の記録が新しいなら、共用型だけを見たことにできる（別の公開先は残る）', async () => {
    run('公開', 'sakura-apprun', 'cloud:apply', { ok: true })
    const s = run('公開', 'vercel', 'vercel:publish', { ok: true })
    const own = unseenOf(s).find(r => isSharedTypeOp(r))!.startedAt
    expect(await ackedBySeen(new Set([own]))).toBe(own)
    expect(unseenOf(ops.getOps(DIR)).map(r => r.target)).toEqual(['vercel'])
  })

  it('★★ 共用型でも、まだ出していない古い記録があれば、それより後ろは見たことにしない（出した印の無い記録を ack しない）', async () => {
    run('削除', 'sakura-apprun', 'cloud:teardown', { ok: true }) // 出していない
    const s = run('公開', 'sakura-apprun', 'cloud:apply', { ok: true }) // 出した
    const [older, newer] = started(s)
    expect(await ackedBySeen(new Set([newer]))).toBeNull()
    expect(unseenOf(ops.getOps(DIR)).map(r => r.startedAt)).toEqual([older, newer])
  })

  it('★★ 出した印の無い共用型の記録は、それ単独でも ack しない（この画面が動かしている操作の最中に終わったもの）', async () => {
    const s = run('公開', 'sakura-apprun', 'cloud:apply', { ok: true })
    const [a] = started(s)
    // 「出した」の印に載っていない（shown が空でない別の値だけ持っている）
    expect(await ackedBySeen(new Set([a + 12345]))).toBeNull()
    expect(unseenOf(ops.getOps(DIR))).toHaveLength(1)
  })

  it('★ 別の公開先の記録の startedAt が「出した印」に紛れても（起こらないはずだが）、その記録は ack しない（持ち場の判定を外さない）', async () => {
    const s = run('公開', 'hanamii', 'hanamii:publish', { ok: true })
    const [a] = started(s)
    expect(await ackedBySeen(new Set([a]))).toBeNull()
    expect(unseenOf(ops.getOps(DIR))).toHaveLength(1)
  })

  it('出した記録がすでに見られている（写しに無い）なら、伝えない', async () => {
    const s = run('公開', 'sakura-apprun', 'cloud:apply', { ok: true })
    const [a] = started(s)
    ops.ackOps(DIR, a)
    expect(await ackedBySeen(new Set([a]))).toBeNull()
  })

  it('★ 実際の ack に渡すと、出したものまでが消え、別の公開先は残る（本物の main で確かめる）', async () => {
    run('公開', 'sakura-apprun', 'cloud:apply', { ok: true })
    run('公開', 'vercel', 'vercel:publish', { ok: true })
    const s = ops.getOps(DIR)
    const own = unseenOf(s).find(r => isSharedTypeOp(r))!.startedAt
    expect(await ackedBySeen(new Set([own]))).toBe(own)
    expect(unseenOf(ops.getOps(DIR)).map(r => r.target)).toEqual(['vercel'])
  })

  it('出した印が空なら、記録を読みにも行かない。読めなくても投げない', async () => {
    const get = vi.fn(async () => ops.getOps(DIR))
    ;(globalThis as any).window = { electronAPI: { projectOps: { get, ack: async () => ({}), onChanged: () => () => {} } } }
    try {
      ackSeen(DIR, new Set())
      await new Promise<void>(r => setTimeout(r, 0))
      expect(get).not.toHaveBeenCalled()
      ;(globalThis as any).window = { electronAPI: { projectOps: { get: async () => { throw new Error('x') }, ack: async () => ({}) } } }
      expect(() => ackSeen(DIR, new Set([1]))).not.toThrow()
      ;(globalThis as any).window = {}
      expect(() => ackSeen(DIR, new Set([1]))).not.toThrow() // window.electronAPI が無くても落ちない
      await new Promise<void>(r => setTimeout(r, 0))
    } finally { delete (globalThis as any).window }
  })
})

describe('opResultFromRecord: 記録を画面の結果へ', () => {
  it('★ 破棄で残ったもの（月額が続く）の警告を、そのまま warnings に持つ', () => {
    const s = run('削除', 'sakura-apprun', 'cloud:teardown', {
      ok: true, executed: ['アプリを削除'], keptBucketName: 'koto-data-x', keptRegistryName: 'koto-reg', message: '削除しました',
    })
    const r = opResultFromRecord(s.last!)
    const w = remainingCostWarning({ deleteRegistry: false, registryName: 'koto-reg', keptBucketName: 'koto-data-x' })!
    expect(r.warnings).toEqual([w])
    expect(r.ok).toBe(true)
    expect(r.message).toBe('削除しました')
    expect(r.executed).toEqual(['アプリを削除'])
    expect(r.kind).toBe('破棄')
    expect(r.caption).toMatch(/^破棄の結果（\d{2}:\d{2}に終わりました）$/)
  })

  it('公開の結果: URL・詳細・回復の導線の材料（hint・pending・logUrl・askAi・staleImages・skipped）を引き継ぐ', () => {
    const s = run('公開', 'sakura-apprun', 'cloud:apply', {
      ok: false, message: '起動を確認できていません', detail: 'ログの断片', hint: 'app-unhealthy', pending: true,
      logUrl: 'https://example.invalid/log', askAi: '相談文', skipped: ['保存場所: 未使用'],
      staleImages: { total: 12, removable: 7, keep: 5 },
    })
    const r = opResultFromRecord(s.last!)
    expect(r).toMatchObject({
      ok: false, message: '起動を確認できていません', detail: 'ログの断片', hint: 'app-unhealthy', pending: true,
      logUrl: 'https://example.invalid/log', askAi: '相談文', skipped: ['保存場所: 未使用'],
      staleImages: { total: 12, removable: 7, keep: 5 }, kind: '公開',
    })
    expect(r.caption).toMatch(/^公開の結果（/)
    expect(r.needsChoice).toBeUndefined()
  })

  it('形の違う staleImages は捨てる（推測で数を作らない）', () => {
    const s = run('公開', 'sakura-apprun', 'cloud:apply', { ok: true, staleImages: { total: '12', removable: 7, keep: 5 } })
    expect(opResultFromRecord(s.last!).staleImages).toBeUndefined()
  })

  it('⚠️・※ で始まる行は、main が warnings へ移したものをそのまま持ち、executed には混ざらない', () => {
    const s = run('公開', 'sakura-apprun', 'cloud:apply', {
      ok: true, executed: ['アプリを更新', '⚠️ 配られた版が古いままです'],
    })
    const r = opResultFromRecord(s.last!)
    expect(r.executed).toEqual(['アプリを更新'])
    expect(r.warnings).toEqual(['⚠️ 配られた版が古いままです'])
  })

  it('例外で止まった記録は、失敗として出す', () => {
    ops.beginOp(DIR, '公開', { target: 'sakura-apprun', handler: 'cloud:apply' })
    ops.finishOp(DIR, { error: new Error('落ちた') })
    const r = opResultFromRecord(ops.getOps(DIR).last!)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('落ちた')
  })

  it('★ 結果の無い記録（起こらないはず）は、うまくいったことにしない', () => {
    const rec = { ...run('公開', 'sakura-apprun', 'cloud:apply', { ok: true }).last! } as any
    delete rec.result
    const r = opResultFromRecord(rec)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('読み取れません')
  })

  it('★ 起動のしかたを聞く段階で止まったものは needsChoice。失敗とは言わず、押し直す案内を添える', () => {
    const s = run('公開', 'sakura-apprun', 'cloud:apply', {
      ok: false, message: '起動のしかたが違います。', needsScaleDecision: { appId: 'a', recorded: 0, actual: 1 },
    })
    const r = opResultFromRecord(s.last!)
    expect(r.needsChoice).toBe(true)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('起動のしかたが違います。')
    expect(r.message).toContain('もう一度「公開する」を押してください')
  })

  it('needsScaleDecision があっても、うまくいった結果（ok）なら needsChoice にしない', () => {
    const s = run('公開', 'sakura-apprun', 'cloud:apply', { ok: true, needsScaleDecision: { appId: 'a', recorded: 0, actual: 1 } })
    expect(opResultFromRecord(s.last!).needsChoice).toBeUndefined()
  })

  it('操作の呼び名: 削除は「破棄」、公開は「公開」。相談の種類も対応する', () => {
    expect(kindOfOp('削除')).toBe('破棄')
    expect(kindOfOp('公開')).toBe('公開')
    expect(kindOfOp('作成')).toBe('公開')
  })

  it('★ 記録に秘密は入っていない前提でも、画面用の結果は記録の文字列だけから作る（記録に無い値を足さない）', () => {
    const s = run('公開', 'sakura-apprun', 'cloud:apply', { ok: true, message: 'x', storagePermissionId: 'perm-secret-id', apiKey: 'sk-abcdef123456' })
    const r = JSON.stringify(opResultFromRecord(s.last!))
    expect(r).not.toContain('perm-secret-id')
    expect(r).not.toContain('sk-abcdef123456')
  })
})

describe('warningLine・foreignBusyNote・progressTextOf', () => {
  it('warningLine: ⚠️・※ で始まればそのまま、無ければ ⚠️ を添える（二重にしない）', () => {
    expect(warningLine('⚠️ 月額が続きます')).toBe('⚠️ 月額が続きます')
    expect(warningLine('※ 確かめていません')).toBe('※ 確かめていません')
    expect(warningLine('まだ動いていません')).toBe('⚠️ まだ動いていません')
  })

  it('foreignBusyNote: 何の操作が走っているかと、押せない理由を1行で言う（詳細は出さない）', () => {
    const t = foreignBusyNote({ op: '公開' })
    expect(t).toContain('別の操作（公開）が進んでいます')
    expect(t).toContain('押せません')
    expect(t).not.toContain('\n')
  })

  it('progressTextOf: 1文＋あれば補足', () => {
    ops.beginOp(DIR, '公開', { target: 'sakura-apprun', handler: 'cloud:apply' })
    ops.reportProgress(DIR, '🚀 反映しています…')
    expect(progressTextOf(ops.getOps(DIR).running!)).toBe('🚀 反映しています…')
    ops.reportProgress(DIR, '⏳ 待っています…', { detail: '状態: BUILDING（30秒経過）' })
    expect(progressTextOf(ops.getOps(DIR).running!)).toBe('⏳ 待っています…（状態: BUILDING（30秒経過））')
  })
})

describe('古いイメージの片づけの記録（画面のプロセス内）', () => {
  const A = '/tmp/koto-ops-shared/cleanup-a'
  const B = '/tmp/koto-ops-shared/cleanup-b'

  it('始めると走っている。終えると走っていない', () => {
    expect(isCleanupRunning(A)).toBe(false)
    const done = beginCleanupJob(A)
    expect(isCleanupRunning(A)).toBe(true)
    done({ ok: true, message: '片づけました' }, true)
    expect(isCleanupRunning(A)).toBe(false)
  })

  it('★ 始めた画面が結果を出した（shownByStarter）なら、結果は残らない', () => {
    beginCleanupJob(A)({ ok: true, message: '片づけました' }, true)
    expect(takeFinishedCleanup(A)).toBeNull()
  })

  it('★★ 始めた画面が閉じていたなら、結果は残り、取り出せるのは1回だけ', () => {
    beginCleanupJob(A)({ ok: true, message: '片づけました' }, false)
    const c = takeFinishedCleanup(A)
    expect(c?.result.message).toBe('片づけました')
    expect(Number.isFinite(c?.finishedAt)).toBe(true)
    expect(takeFinishedCleanup(A)).toBeNull()
  })

  it('走っている間は、結果としては取り出せない', () => {
    beginCleanupJob(A)
    expect(takeFinishedCleanup(A)).toBeNull()
    expect(isCleanupRunning(A)).toBe(true)
  })

  it('★ プロジェクトごとに別（掟11）。末尾の / の違いは同じ扱い', () => {
    beginCleanupJob(A)
    expect(isCleanupRunning(B)).toBe(false)
    expect(isCleanupRunning(`${A}/`)).toBe(true)
  })

  it('始まり・終わりを聞ける。解除したあとは届かない。別のプロジェクトの分は届かない', () => {
    let n = 0
    const off = watchCleanup(A, () => { n++ })
    const otherOff = watchCleanup(B, () => { n += 100 })
    const done = beginCleanupJob(A)
    expect(n).toBe(1)
    done({ ok: true }, false)
    expect(n).toBe(2)
    off()
    beginCleanupJob(A)
    expect(n).toBe(2)
    otherOff()
  })

  it('聞き手の1つが落ちても、ほかの聞き手には届く', () => {
    let got = 0
    watchCleanup(A, () => { throw new Error('boom') })
    watchCleanup(A, () => { got++ })
    beginCleanupJob(A)
    expect(got).toBe(1)
  })
})
