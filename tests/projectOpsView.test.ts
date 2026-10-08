import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as ops from '../src/main/projectOps'
import {
  normDir, unseenOf, ackUpToFor, sendAck, ackShown, watchProjectOps, visiblePanelShows, holdsWarning,
  isHanamiiOp, isVercelOp, isSharedTypeOp, isDedicatedPanelOp, DEDICATED_PANEL_HANDLERS, DEDICATED_TARGET,
  type ProjectOpsApi,
} from '../src/renderer/projectOpsView'
import { dedicatedOpKind } from '../src/renderer/apprunDedicatedActions'

// ── 処理の記録を「読む・見たと伝える・誰の持ち場か決める」共通の部品（2026-09-30 検分の指摘2）─────────────────
// 以前は5つの画面に別々に書かれていた（PublishModal・HANAMII／Vercel のフック・AppRunPanel・専有型の watchDedicatedOps）。
// 記録は本物の main（src/main/projectOps.ts）で作る——偽の形を手で書かない（形が変われば、ここが先に落ちる）。

const DIR = '/tmp/koto-ops-view/a'
const OTHER = '/tmp/koto-ops-view/b'

beforeEach(() => { ops.resetProjectOpsForTests() })

function run(dir: string, op: '公開' | '削除' | '作成', target: string, handler: string, value: Record<string, unknown> = { ok: true }) {
  ops.beginOp(dir, op, { target: target as any, handler })
  ops.finishOp(dir, { value })
  return ops.getOps(dir)
}
const H = (dir = DIR) => run(dir, '公開', 'hanamii', 'hanamii:publish')
const V = (dir = DIR) => run(dir, '公開', 'vercel', 'vercel:publish')
const S = (dir = DIR) => run(dir, '削除', 'sakura-apprun', 'cloud:teardown')

describe('unseenOf: 終わってまだ見られていない記録を、古い順に', () => {
  it('earlier と last をまとめて、startedAt の古い順に返す', () => {
    H(); V(); S()
    const u = unseenOf(ops.getOps(DIR))
    expect(u.map(r => r.target)).toEqual(['hanamii', 'vercel', 'sakura-apprun'])
    expect(u.map(r => r.startedAt)).toEqual([...u.map(r => r.startedAt)].sort((a, b) => a - b))
  })

  it('何も無い・欠けている・壊れている写しでも落ちない', () => {
    for (const bad of [null, undefined, {}, { earlier: 'x', last: 5, running: 'y' }, { earlier: [null, 1, 'z', {}], last: {} }]) {
      expect(unseenOf(bad as any), JSON.stringify(bad)).toEqual([])
    }
  })

  it('走っているもの（running: true）は入れない。同じ記録（startedAt）は1つだけ', () => {
    const rec = (startedAt: number, running = false) => ({ op: '公開', target: 'hanamii', handler: 'h', startedAt, running, progress: { label: '', detail: '', at: 1 }, seen: false }) as any
    const u = unseenOf({ running: null, earlier: [rec(5), rec(3), rec(5)], last: rec(9, true) })
    expect(u.map(r => r.startedAt)).toEqual([3, 5])
  })
})

describe('★★★ ackUpToFor: どこまで「見た」と伝えてよいか（連続した先頭から、見せたところまで）', () => {
  const at = (dir = DIR) => unseenOf(ops.getOps(dir)).map(r => r.startedAt)

  it('見られていない記録が無ければ null', () => {
    expect(ackUpToFor([], () => true)).toBeNull()
  })

  it('1件も見せていなければ null（何も伝えない）', () => {
    H(); V()
    expect(ackUpToFor(unseenOf(ops.getOps(DIR)), () => false)).toBeNull()
  })

  it('全部見せたなら、いちばん新しい記録まで', () => {
    H(); V(); S()
    const [, , c] = at()
    expect(ackUpToFor(unseenOf(ops.getOps(DIR)), () => true)).toBe(c)
  })

  it('★★★ 見せていない記録が挟まったら、そこで止まる。それより新しいものは、見せていても伝えない（ack は累積）', () => {
    H(); V(); S()
    const [a, b, c] = at()
    const shown = new Set([a, c])          // b（別の公開先など）は見せていない
    expect(ackUpToFor(unseenOf(ops.getOps(DIR)), r => shown.has(r.startedAt))).toBe(a)
    // 実際に ack すると、見せた a だけが消え、b と c は残る（c を見たことにしていない）
    ops.ackOps(DIR, a)
    expect(at()).toEqual([b, c])
  })

  it('★★ 先頭が見せていなければ、後ろを全部見せていても null（巻き込んで消さない）', () => {
    H(); V(); S()
    const [a, b, c] = at()
    const shown = new Set([b, c])
    expect(ackUpToFor(unseenOf(ops.getOps(DIR)), r => shown.has(r.startedAt))).toBeNull()
    expect(a).toBeLessThan(b)
  })

  it('入れた順に関わらず、古い順に見る（並びの違う入力でも、同じ答え）', () => {
    H(); V(); S()
    const u = unseenOf(ops.getOps(DIR))
    const [a, b, c] = u.map(r => r.startedAt)
    const shown = new Set([a, b])
    expect(ackUpToFor([...u].reverse(), r => shown.has(r.startedAt))).toBe(b)
    expect(ackUpToFor([u[2], u[0], u[1]], r => shown.has(r.startedAt))).toBe(b)
    expect(c).toBeGreaterThan(b)
  })
})

// ── 警告つきの記録は、パネルは「見た」と伝えない（2026-09-30 検分）─────────────────────────────
// パネルは結果を公開ボタンのずっと下（①〜④の下・⑥⑧の節の中）に出す。利用者がスクロールせずに閉じると、見せたことに
// ならないのに「見た」と伝えて、月額が続く警告が閉じて開き直すと二度と出なくなった。隠れているタブのパネルも同じ。
// 警告つきの記録は、上部の「結果を確認しました」（PublishModal）を押したときにだけ見たことにする。
// パネルの ack の範囲を決める ackUpToFor が、警告つきの記録で必ず止まる（各画面が別々に除外を書くと、1つだけ抜ける）。
describe('★★★ holdsWarning／ackUpToFor: 警告つきの記録は、isShown が true でも、パネルの ack の範囲に入れない', () => {
  const WARNED = { ok: true, warnings: ['月額が続きます'] }
  const at = () => unseenOf(ops.getOps(DIR)).map(r => r.startedAt)

  it('holdsWarning: 警告が1件でもあれば true。警告の無い成功・失敗、結果の無い記録・壊れた形は false', () => {
    expect(holdsWarning({ result: { warnings: ['x'] } })).toBe(true)
    for (const no of [{ result: { warnings: [] } }, { result: {} }, { result: null }, {}, null, undefined, { result: { warnings: 'x' } }]) {
      expect(holdsWarning(no as any), JSON.stringify(no)).toBe(false)
    }
    // 本物の記録: 警告を持つ結果・持たない結果・失敗
    run(DIR, '公開', 'hanamii', 'hanamii:publish', WARNED)
    run(DIR, '公開', 'hanamii', 'hanamii:publish', { ok: true })
    run(DIR, '公開', 'hanamii', 'hanamii:publish', { ok: false, message: '失敗' })
    expect(unseenOf(ops.getOps(DIR)).map(holdsWarning)).toEqual([true, false, false])
  })

  it('★★★ 先頭が警告つき: 全部を「見せた」と言っても、何も ack しない（null）', () => {
    run(DIR, '公開', 'hanamii', 'hanamii:publish', WARNED)
    expect(ackUpToFor(unseenOf(ops.getOps(DIR)), () => true), '警告つきの記録を、パネルが見たことにできてしまう').toBeNull()
  })

  it('★★★ 警告つきが挟まったら、そこで止まる（それより新しい警告の無い記録も、伝えない）。手前の分までは伝える', () => {
    run(DIR, '公開', 'hanamii', 'hanamii:publish')
    run(DIR, '公開', 'hanamii', 'hanamii:publish', WARNED)
    run(DIR, '公開', 'hanamii', 'hanamii:publish')
    const [a, , c] = at()
    expect(ackUpToFor(unseenOf(ops.getOps(DIR)), () => true)).toBe(a)
    expect(c).toBeGreaterThan(a)
  })

  it('警告の無い記録（成功・失敗）は、これまでどおり、見せたなら ack の範囲に入る', () => {
    run(DIR, '公開', 'hanamii', 'hanamii:publish')
    run(DIR, '公開', 'hanamii', 'hanamii:publish', { ok: false, message: '失敗' })
    const [, b] = at()
    expect(ackUpToFor(unseenOf(ops.getOps(DIR)), () => true)).toBe(b)
  })

  it('★★ ackShown（AppRunPanel が閉じるとき使う）も、警告つきは ack しない', async () => {
    run(DIR, '削除', 'sakura-apprun', 'cloud:teardown', { ok: true, keptBucketName: 'koto-b' })
    const ack = vi.fn(async (d: string, u?: number) => ({ ok: true, acked: ops.ackOps(d, u) }))
    ackShown({ get: async (d: string) => ops.getOps(d), ack }, DIR, () => true)
    await new Promise(r => setTimeout(r, 0))
    expect(ack).not.toHaveBeenCalled()
    expect(ops.getOps(DIR).last, '警告つきの記録が main から消えた').not.toBeNull()
  })
})

describe('sendAck・ackShown: 「見た」と伝える（失敗しても画面は止めない）', () => {
  it('sendAck は ack を1回、projectDir と startedAt を添えて呼ぶ。失敗（例外・reject）しても投げない', async () => {
    const ack = vi.fn(async () => ({ ok: true }))
    sendAck({ ack }, DIR, 42)
    expect(ack).toHaveBeenCalledWith(DIR, 42)
    expect(() => sendAck({ ack: () => { throw new Error('x') } } as any, DIR, 1)).not.toThrow()
    expect(() => sendAck({ ack: async () => { throw new Error('x') } } as any, DIR, 1)).not.toThrow()
    await new Promise(r => setTimeout(r, 0)) // reject が握られている（unhandled にならない）
  })

  it('★ ackShown は、呼ぶ時点の記録を読み直し、見せた分だけ ack する', async () => {
    H(); V(); S()
    const [a, b] = unseenOf(ops.getOps(DIR)).map(r => r.startedAt)
    const ack = vi.fn(async (d: string, u?: number) => ({ ok: true, acked: ops.ackOps(d, u) }))
    const api = { get: async (d: string) => ops.getOps(d), ack }
    const shown = new Set([a, b])
    ackShown(api, DIR, r => shown.has(r.startedAt))
    await new Promise(r => setTimeout(r, 0))
    expect(ack).toHaveBeenCalledWith(DIR, b)
    expect(unseenOf(ops.getOps(DIR)).map(r => r.target)).toEqual(['sakura-apprun'])
    // すでに見られていれば、もう伝えない
    ack.mockClear()
    ackShown(api, DIR, r => shown.has(r.startedAt))
    await new Promise(r => setTimeout(r, 0))
    expect(ack).not.toHaveBeenCalled()
  })

  it('ackShown は、読めなくても（例外・reject）投げない', async () => {
    expect(() => ackShown({ get: () => { throw new Error('x') }, ack: async () => ({}) } as any, DIR, () => true)).not.toThrow()
    expect(() => ackShown({ get: async () => { throw new Error('x') }, ack: async () => ({}) } as any, DIR, () => true)).not.toThrow()
    await new Promise(r => setTimeout(r, 0))
  })
})

describe('★★ watchProjectOps: 開いたとき1回・開いている間は押し出し（5つの画面が共通で使う）', () => {
  type Push = { projectDir: string } & ProjectOpsSnapshotShape
  function makeApi() {
    const subs = new Set<(p: Push) => void>()
    ops.setProjectOpsListener((projectDir, snapshot) => { for (const cb of [...subs]) cb({ projectDir, ...snapshot }) })
    const gate = { wait: null as null | Promise<void> }
    const api: ProjectOpsApi = {
      get: async (d: string) => { const snap = ops.getOps(d); if (gate.wait) await gate.wait; return snap },
      ack: async (d: string, u?: number) => ({ ok: true, acked: ops.ackOps(d, u) }),
      onChanged: cb => { subs.add(cb); return () => { subs.delete(cb) } },
    }
    return { api, subs, gate }
  }
  const flush = async () => { for (let i = 0; i < 4; i++) await new Promise<void>(r => setTimeout(r, 0)) }

  it('開いたとき、いまの写しを1回届ける', async () => {
    H()
    const { api } = makeApi()
    const got: ProjectOpsSnapshotShape[] = []
    const w = watchProjectOps(api, DIR, s => got.push(s))
    await flush()
    expect(got).toHaveLength(1)
    expect(got[0].last?.target).toBe('hanamii')
    w.stop()
  })

  it('開いている間、押し出し（走り始め・進み・終わり・見たことにした）が届く', async () => {
    const { api } = makeApi()
    const got: ProjectOpsSnapshotShape[] = []
    const w = watchProjectOps(api, DIR, s => got.push(s))
    await flush()
    got.length = 0
    ops.beginOp(DIR, '公開', { target: 'hanamii', handler: 'hanamii:publish' })
    expect(got.at(-1)?.running?.handler).toBe('hanamii:publish')
    ops.finishOp(DIR, { value: { ok: true } })
    expect(got.at(-1)?.running).toBeNull()
    expect(got.at(-1)?.last?.result?.ok).toBe(true)
    ops.ackOps(DIR)
    expect(got.at(-1)?.last).toBeNull()
    w.stop()
  })

  it('★★ 別のプロジェクトの知らせは無視する（掟11）。projectDir の末尾の / は違いにしない', async () => {
    const { api } = makeApi()
    const got: ProjectOpsSnapshotShape[] = []
    const w = watchProjectOps(api, `${DIR}/`, s => got.push(s))
    await flush()
    got.length = 0
    H(OTHER)
    expect(got, '別のプロジェクトの知らせが届いた').toEqual([])
    H(DIR)
    expect(got.length).toBeGreaterThan(0)
    expect(normDir('/a/b//')).toBe('/a/b')
    expect(normDir(`${DIR}/`)).toBe(normDir(DIR))
    w.stop()
  })

  it('★★★ 問い合わせ（get）の応答が届く前に押し出しが先に届いたら、遅れて届いた古い応答で上書きしない', async () => {
    const { api, gate } = makeApi()
    let release!: () => void
    gate.wait = new Promise<void>(r => { release = r })
    const got: ProjectOpsSnapshotShape[] = []
    const w = watchProjectOps(api, DIR, s => got.push(s))   // get は「まだ何も無い」写しを持ったまま待たされる
    H()                                                     // その間に、より新しい写し（走り始め→結果が1件）が押し出される
    expect(got.length).toBeGreaterThan(0)
    expect(got.at(-1)?.last?.target).toBe('hanamii')
    ops.ackOps(DIR)                                          // さらに、その結果が見られて消える（押し出し）
    expect(got.at(-1)?.last).toBeNull()
    const before = got.length
    release()                                                // 古い写しの応答が、いまごろ届く
    await flush()
    expect(got.length, '古い応答で、新しい写しを上書きした').toBe(before)
    w.stop()
  })

  it('refresh() は聞き直す。応答が届く前に押し出しが来ていたら捨てる。解決するのは応答を処理したあと', async () => {
    const { api, gate } = makeApi()
    const got: ProjectOpsSnapshotShape[] = []
    const w = watchProjectOps(api, DIR, s => got.push(s))
    await flush()
    got.length = 0
    V()                                                      // 押し出しが1つ届かなかった状況は作りにくいので、届いたぶんを数える
    const n = got.length
    await w.refresh()
    expect(got.length).toBe(n + 1)                           // 聞き直した応答は届く（押し出しが挟まっていないので）
    let release!: () => void
    gate.wait = new Promise<void>(r => { release = r })
    const pending = w.refresh()
    S()                                                      // 聞いている間に押し出しが来た
    const m = got.length
    release()
    await pending
    expect(got.length, '押し出しより古い応答を使った').toBe(m)
    w.stop()
  })

  it('stop() のあとは、何も届けない・聞き直しても何も起きない。解除が呼ばれる', async () => {
    const { api, subs } = makeApi()
    const got: ProjectOpsSnapshotShape[] = []
    const w = watchProjectOps(api, DIR, s => got.push(s))
    await flush()
    expect(subs.size).toBe(1)
    w.stop()
    expect(subs.size, '押し出しの受け口が外れていない').toBe(0)
    got.length = 0
    H()
    await w.refresh()
    await flush()
    expect(got).toEqual([])
  })

  it('聞けなくても・押し出しを受けられなくても、落ちない（画面は動く）', async () => {
    const boom: ProjectOpsApi = {
      get: async () => { throw new Error('x') },
      ack: async () => ({}),
      onChanged: () => { throw new Error('y') },
    }
    let w: ReturnType<typeof watchProjectOps> | undefined
    expect(() => { w = watchProjectOps(boom, DIR, () => {}) }).not.toThrow()
    await flush()
    await expect(w!.refresh()).resolves.toBeUndefined()
    expect(() => w!.stop()).not.toThrow()
  })
})

describe('★★ 持ち場: どの画面が、どの記録を自分の画面に出すか（1か所）', () => {
  const rec = (target: string, handler: string) => ({ target, handler })

  it('HANAMII・Vercel・共用型は target で決まる', () => {
    expect(isHanamiiOp(rec('hanamii', 'hanamii:teardown'))).toBe(true)
    expect(isHanamiiOp(rec('vercel', 'vercel:publish'))).toBe(false)
    expect(isVercelOp(rec('vercel', 'vercel:publish'))).toBe(true)
    expect(isSharedTypeOp(rec('sakura-apprun', 'cloud:apply'))).toBe(true)
    expect(isSharedTypeOp(rec(DEDICATED_TARGET, 'apprunDedicated:publishApp'))).toBe(false)
    for (const f of [isHanamiiOp, isVercelOp, isSharedTypeOp, isDedicatedPanelOp]) {
      expect(f(null)).toBe(false)
      expect(f(undefined)).toBe(false)
      expect(f({})).toBe(false)
      expect(f(rec('unknown', ''))).toBe(false)
    }
  })

  it('★★ 専有型のパネルが受け持つのは⑤⑥⑧だけ。📡 一覧の「アプリだけ破棄」（teardownApp）は持ち場が無い', () => {
    expect(isDedicatedPanelOp(rec(DEDICATED_TARGET, 'apprunDedicated:create'))).toBe(true)
    expect(isDedicatedPanelOp(rec(DEDICATED_TARGET, 'apprunDedicated:teardown'))).toBe(true)
    expect(isDedicatedPanelOp(rec(DEDICATED_TARGET, 'apprunDedicated:publishApp'))).toBe(true)
    expect(isDedicatedPanelOp(rec(DEDICATED_TARGET, 'apprunDedicated:teardownApp'))).toBe(false)
    expect(isDedicatedPanelOp(rec('sakura-apprun', 'apprunDedicated:create'))).toBe(false)
    // Object のプロトタイプの名前で当たらない
    for (const h of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) expect(isDedicatedPanelOp(rec(DEDICATED_TARGET, h)), h).toBe(false)
  })

  it('★ 専有型の種類（dedicatedOpKind）は、この表を引く。表と食い違わない', () => {
    expect(Object.keys(DEDICATED_PANEL_HANDLERS).sort()).toEqual(['apprunDedicated:create', 'apprunDedicated:publishApp', 'apprunDedicated:teardown'])
    for (const [handler, kind] of Object.entries(DEDICATED_PANEL_HANDLERS)) {
      expect(dedicatedOpKind(rec(DEDICATED_TARGET, handler))).toBe(kind)
    }
    expect(dedicatedOpKind(rec(DEDICATED_TARGET, 'apprunDedicated:teardownApp'))).toBeNull()
    expect(dedicatedOpKind(null)).toBeNull()
  })

  it('★★★ visiblePanelShows: 目の前の公開先の画面が出す記録だけが true（隠れたタブ・公開先の選択・レンタルサーバ・VPS・読み込み前は false）', () => {
    const cases: Array<[string | null | undefined, ReturnType<typeof rec>, boolean]> = [
      ['hanamii', rec('hanamii', 'hanamii:publish'), true],
      ['hanamii', rec('hanamii', 'hanamii:teardown'), true],
      ['hanamii', rec('vercel', 'vercel:publish'), false],
      ['vercel', rec('vercel', 'vercel:publish'), true],
      ['vercel', rec('hanamii', 'hanamii:publish'), false],
      ['sakura-apprun', rec('sakura-apprun', 'cloud:apply'), true],
      ['sakura-apprun', rec('sakura-apprun', 'cloud:teardown'), true],
      ['sakura-apprun', rec(DEDICATED_TARGET, 'apprunDedicated:publishApp'), false],   // 専有型のタブは隠れている
      [DEDICATED_TARGET, rec(DEDICATED_TARGET, 'apprunDedicated:publishApp'), true],
      [DEDICATED_TARGET, rec(DEDICATED_TARGET, 'apprunDedicated:teardownApp'), false], // パネルが出さない
      [DEDICATED_TARGET, rec('sakura-apprun', 'cloud:apply'), false],                  // 共用型のタブは隠れている
      ['sakura-rental', rec('hanamii', 'hanamii:publish'), false],
      ['sakura-vps', rec('sakura-apprun', 'cloud:apply'), false],
      [null, rec('hanamii', 'hanamii:publish'), false],
      [undefined, rec('vercel', 'vercel:publish'), false],
    ]
    for (const [target, r, expected] of cases) expect(visiblePanelShows(target, r), `${String(target)} × ${r.target}/${r.handler}`).toBe(expected)
  })
})
