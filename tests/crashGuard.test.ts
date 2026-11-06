import { describe, it, expect, afterAll, afterEach, vi } from 'vitest'
import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync as readFile } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  crashGuardDecision, crashDialogPlan, crashFamilyOf, createCrashGuard, createCrashLogWriter, errorText,
  CRASH_REPEAT_WINDOW_MS, UNRESPONSIVE_GRACE_MS, CRASH_LOG_FILE,
  CRASH_LABEL_RELOAD, CRASH_LABEL_CONTINUE, CRASH_LABEL_QUIT,
  type CrashReason, type CrashDialogOptions, type CrashFamily,
} from '../src/main/crashGuard'

// ── main のクラッシュ処理（画面が止まった・落ちた／main が想定外の例外を投げた）──────────────────────
// 窓の外に出ない白い画面と、英語の標準の窓のまま続けるか終わるかを迫られる状態を、日本語の窓と記録に置き換える。
// 受ける出来事は5つ（render-process-gone・did-fail-load・unresponsive／responsive・uncaughtException・unhandledRejection）。
// 窓は macOS の窓で外から押せないので、ここでは偽の窓に流して「呼ばれた道具の一覧」を見る。
//
// ここで固定するもの:
//   1. 判断（crashGuardDecision・純関数）  2. 窓の設定と文（crashDialogPlan）
//   3. 画面の異常の流れ（偽の道具）  4. main の例外・拒否の流れ  5. 応答しない／戻った  6. 答えの扱い（範囲外・窓の失敗・道具の失敗）
//   7. 記録（本物の一時フォルダ。秘密とホームのパスを伏せる）  8. main.ts の配線（ソースの呼び出しの形。コメントを除く）
//   応答の待ち受け（5秒）は、responsive のほか、窓が閉じる・画面が落ちる・読み込めなくなるときも取り消す（5 の後ろ）

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf-8')
const codeOnly = (src: string) => src.split('\n').filter(l => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*')).join('\n')
const flush = () => new Promise<void>(r => setImmediate(r))

// 他のテストと同じ流儀: 道具が投げても、拒否が誰にも受け取られないまま残らないことを見る
const unhandled: unknown[] = []
const onUnhandled = (e: unknown) => { unhandled.push(e) }
process.on('unhandledRejection', onUnhandled)
afterAll(() => { process.off('unhandledRejection', onUnhandled) })
afterEach(() => { expect(unhandled).toEqual([]); vi.useRealTimers() })

const T0 = 1_700_000_000_000
const gone = (reason: string): CrashReason => ({ kind: 'render-process-gone', reason })
const failLoad = (errorCode: number, isMainFrame = true): CrashReason => ({ kind: 'did-fail-load', errorCode, errorDescription: 'ERR', isMainFrame })

// ── 1. 判断（純関数）──────────────────────────────────────────────────────

describe('crashGuardDecision: 異常でないものは無視し、画面の異常が繰り返したら再読み込みをやめる', () => {
  it('★★ render-process-gone: clean-exit は無視する（正常な終了で窓を出さない）', () => {
    expect(crashGuardDecision(gone('clean-exit'), [], T0)).toBe('ignore')
    // 直近に異常があっても、clean-exit は無視のまま（giveUp にならない）
    expect(crashGuardDecision(gone('clean-exit'), [T0 - 1000], T0)).toBe('ignore')
  })

  it('render-process-gone: clean-exit 以外は、知らない理由も含めて聞く', () => {
    for (const r of ['crashed', 'killed', 'oom', 'launch-failed', 'integrity-failure', 'abnormal-exit', 'memory-eviction', 'なにか知らない値', '']) {
      expect(crashGuardDecision(gone(r), [], T0), r).toBe('ask')
    }
  })

  it('★ did-fail-load: 主フレームで、中断（-3）でなければ聞く', () => {
    expect(crashGuardDecision(failLoad(-102), [], T0)).toBe('ask')
    expect(crashGuardDecision(failLoad(-6), [], T0)).toBe('ask')
  })

  it('★ did-fail-load: 中断（-3）は主フレームでも無視する（遷移の取り消し・読み込み中の再読み込み）', () => {
    expect(crashGuardDecision(failLoad(-3), [], T0)).toBe('ignore')
  })

  it('★ did-fail-load: 子フレームの失敗は無視する（番号が何でも）', () => {
    expect(crashGuardDecision(failLoad(-102, false), [], T0)).toBe('ignore')
    expect(crashGuardDecision(failLoad(-3, false), [], T0)).toBe('ignore')
  })

  it('unresponsive は聞く', () => {
    expect(crashGuardDecision({ kind: 'unresponsive' }, [], T0)).toBe('ask')
  })

  it('★★ 画面の異常が60秒以内にもう一度起きたら giveUp（再読み込みを勧めない）。60秒たてば聞き直す', () => {
    expect(crashGuardDecision(gone('crashed'), [T0 - 1], T0)).toBe('giveUp')
    expect(crashGuardDecision(gone('crashed'), [T0 - (CRASH_REPEAT_WINDOW_MS - 1)], T0)).toBe('giveUp')
    expect(crashGuardDecision(gone('crashed'), [T0 - CRASH_REPEAT_WINDOW_MS], T0)).toBe('ask')
    expect(crashGuardDecision(gone('crashed'), [T0 - 10 * CRASH_REPEAT_WINDOW_MS], T0)).toBe('ask')
    // 3つの出来事は同じ数え方（どれが先でも、どれが後でも）
    expect(crashGuardDecision(failLoad(-102), [T0 - 5000], T0)).toBe('giveUp')
    expect(crashGuardDecision({ kind: 'unresponsive' }, [T0 - 5000], T0)).toBe('giveUp')
  })

  it('main の例外・拒否は、直近の時刻に関係なく聞く（giveUp にならない）', () => {
    for (const kind of ['uncaughtException', 'unhandledRejection'] as const) {
      expect(crashGuardDecision({ kind, error: new Error('x') }, [], T0)).toBe('ask')
      expect(crashGuardDecision({ kind, error: new Error('x') }, [T0 - 1], T0)).toBe('ask')
    }
  })

  it('系統: 画面の3つは renderer、例外と拒否は main', () => {
    const fam = (r: CrashReason): CrashFamily => crashFamilyOf(r)
    expect([gone('crashed'), failLoad(-102), { kind: 'unresponsive' } as CrashReason].map(fam)).toEqual(['renderer', 'renderer', 'renderer'])
    expect([{ kind: 'uncaughtException', error: 1 }, { kind: 'unhandledRejection', error: 1 }].map(r => fam(r as CrashReason))).toEqual(['main', 'main'])
  })
})

// ── 2. 窓の設定と文 ──────────────────────────────────────────────────────

describe('crashDialogPlan: 窓の文・ボタン・既定', () => {
  it('★★ 画面の窓: 文は決めたとおり。ボタンは「再読み込み」「終了」、Return は「再読み込み」', () => {
    const { options, actions } = crashDialogPlan('renderer', false)
    expect(options.message + options.detail).toBe('Koto の画面が停止しました。保存していない編集は失われます。')
    expect(options).toEqual({
      type: 'warning',
      buttons: ['再読み込み', '終了'],
      defaultId: 0,
      cancelId: 2,
      message: 'Koto の画面が停止しました。',
      detail: '保存していない編集は失われます。',
    })
    expect(actions).toEqual(['reload', 'quit'])
  })

  it('★★ main の窓: 文は決めたとおり。ボタンは「続ける」「終了」、Return は「続ける」', () => {
    const { options, actions } = crashDialogPlan('main', false)
    expect(options.message + options.detail).toBe('Koto の内部で問題が起きました。続けると、正しく動かないことがあります。')
    expect(options.buttons).toEqual(['続ける', '終了'])
    expect(options.defaultId).toBe(0)
    expect(actions).toEqual(['continue', 'quit'])
  })

  it('★★ giveUp: ボタンは「終了」だけ（再読み込みの口が無い）。文は変えない', () => {
    const r = crashDialogPlan('renderer', true)
    expect(r.options.buttons).toEqual(['終了'])
    expect(r.actions).toEqual(['quit'])
    expect(r.options.message + r.options.detail).toBe('Koto の画面が停止しました。保存していない編集は失われます。')
    expect(crashDialogPlan('main', true).options.buttons).toEqual(['終了'])
  })

  it('★ 取消の番号はボタンの数（範囲外）にして、Esc をどのボタンにも付けない。省かない', () => {
    // 理由: cancelId を省くと、Electron が defaultId=0 のとき 1 番目のボタン（終了）に Esc を付ける。defaultId と同じ 0 にすると
    // macOS では Return が Esc に上書きされて既定のボタンが無くなる。範囲外なら、どちらも起きない（quitGuard.test.ts と同じ理由）
    for (const family of ['renderer', 'main'] as const) {
      for (const giveUp of [false, true]) {
        const { options } = crashDialogPlan(family, giveUp)
        expect('cancelId' in options).toBe(true)
        expect(options.cancelId).toBe(options.buttons.length)
        expect(options.cancelId).not.toBe(options.defaultId)
        expect(options.defaultId).toBe(0)
      }
    }
  })

  it('ボタンの名前は定数と一致し、画面の文の決まり（短く・念押しなし・丸数字なし）に沿う', () => {
    expect([CRASH_LABEL_RELOAD, CRASH_LABEL_CONTINUE, CRASH_LABEL_QUIT]).toEqual(['再読み込み', '続ける', '終了'])
    for (const family of ['renderer', 'main'] as const) {
      const { options } = crashDialogPlan(family, false)
      const all = [options.message, options.detail, ...options.buttons].join('\n')
      expect(all).not.toMatch(/[①-⑳⓪❶-❿㉑-㊿]/)
      for (const w of ['念のため', '大丈夫', '実機', '鍵', '窓']) expect(all).not.toContain(w)
      expect(options.message.length).toBeLessThanOrEqual(24)
      expect(options.detail.length).toBeLessThanOrEqual(24)
      for (const b of options.buttons) expect(b.length).toBeLessThanOrEqual(6)
    }
  })
})

// ── 偽の道具 ──────────────────────────────────────────────────────────────

/** 偽の窓・再読み込み・終了・時計・記録・タイマー。呼ばれた順を `calls` に積む。 */
function setup(opts: {
  press?: (o: CrashDialogOptions) => number
  /** true なら窓を開いたままにし、`answer` で答える（窓が出ている間の動きを試す）。 */
  hold?: boolean
  dialogFails?: boolean
  reloadThrows?: boolean
  quitThrows?: boolean
  logThrows?: boolean
  useRealSchedule?: boolean
} = {}) {
  const calls: string[] = []
  const logs: { level: string; message: string }[] = []
  const shown: CrashDialogOptions[] = []
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = []
  let now = T0
  let release: ((n: number) => void) | null = null
  const guard = createCrashGuard({
    dialog: (o) => {
      shown.push(o)
      calls.push(`dialog:${o.buttons.join('/')}`)
      if (opts.dialogFails) return Promise.reject(new Error('dialog failed'))
      if (opts.hold) return new Promise<number>(r => { release = r })
      return Promise.resolve((opts.press ?? (() => o.cancelId))(o))
    },
    reload: () => { calls.push('reload'); if (opts.reloadThrows) throw new Error('reload failed') },
    quit: (family) => { calls.push(`quit:${family}`); if (opts.quitThrows) throw new Error('quit failed') },
    now: () => now,
    log: (level, message) => { logs.push({ level, message }); if (opts.logThrows) throw new Error('log failed') },
    ...(opts.useRealSchedule ? {} : {
      schedule: (fn: () => void, ms: number) => {
        const t = { fn, ms, cancelled: false }
        timers.push(t)
        return () => { t.cancelled = true }
      },
    }),
  })
  return {
    guard, calls, logs, shown, timers,
    advance: (ms: number) => { now += ms },
    answer: (n: number) => release?.(n),
    /** 押し間違えない: 名前でボタンを押す。 */
    label: (name: string) => (o: CrashDialogOptions) => o.buttons.indexOf(name),
    logText: () => logs.map(l => l.message).join('\n'),
    /** 取り消されていないタイマーを動かす。 */
    fireTimers: () => { for (const t of timers) if (!t.cancelled) { t.cancelled = true; t.fn() } },
  }
}

// ── 3. 画面の異常の流れ ──────────────────────────────────────────────────

describe('画面の異常: 窓で聞き、「再読み込み」「終了」を実行する（偽の道具に流す）', () => {
  it('★★ clean-exit: 窓も記録も再読み込みも終了も無い（呼ばれた道具の一覧が空）', async () => {
    const t = setup()
    t.guard.onRenderProcessGone({ reason: 'clean-exit', exitCode: 0 })
    await flush()
    expect(t.calls).toEqual([])
    expect(t.logs).toEqual([])
  })

  it('★★ crashed → 窓が1回出る → 「再読み込み」で reload だけ（終了しない）。記録に理由が残る', async () => {
    const t = setup({ press: o => o.buttons.indexOf('再読み込み') })
    t.guard.onRenderProcessGone({ reason: 'crashed', exitCode: 11 })
    await flush()
    expect(t.calls).toEqual(['dialog:再読み込み/終了', 'reload'])
    expect(t.logText()).toContain('render-process-gone reason=crashed exitCode=11')
    expect(t.logs[0].level).toBe('error')
  })

  it('★★ crashed → 「終了」で quit だけ（系統は renderer。再読み込みしない）', async () => {
    const t = setup({ press: o => o.buttons.indexOf('終了') })
    t.guard.onRenderProcessGone({ reason: 'oom' })
    await flush()
    expect(t.calls).toEqual(['dialog:再読み込み/終了', 'quit:renderer'])
  })

  it('★★ 2回目（60秒以内）は再読み込みを勧めない。「終了」だけの窓で、押せば抜けられる', async () => {
    const t = setup({ press: o => o.buttons.indexOf('終了') })
    t.guard.onRenderProcessGone({ reason: 'crashed' }); await flush()
    t.advance(10_000)
    t.guard.onRenderProcessGone({ reason: 'crashed' }); await flush()
    expect(t.shown.map(o => o.buttons)).toEqual([['再読み込み', '終了'], ['終了']])
    expect(t.calls).toEqual(['dialog:再読み込み/終了', 'quit:renderer', 'dialog:終了', 'quit:renderer'])
    // 再読み込みの口が無いので、reload は一度も呼ばれない
    expect(t.calls).not.toContain('reload')
  })

  it('★★ 再読み込みの直後にまた落ちる輪: 3回目以降も「終了」だけ（繰り返さない）', async () => {
    const t = setup({ press: o => o.buttons.indexOf('再読み込み') })
    for (let i = 0; i < 4; i++) { t.guard.onRenderProcessGone({ reason: 'crashed' }); await flush(); t.advance(5_000) }
    // 押した答えは「再読み込み」だが、2回目以降の窓にその名前のボタンは無い（indexOf が -1 → 何もしない）
    expect(t.calls.filter(c => c === 'reload')).toHaveLength(1)
    expect(t.shown.map(o => o.buttons)).toEqual([['再読み込み', '終了'], ['終了'], ['終了'], ['終了']])
  })

  it('60秒たってからの異常は、また再読み込みを勧める', async () => {
    const t = setup({ press: o => o.buttons.indexOf('再読み込み') })
    t.guard.onRenderProcessGone({ reason: 'crashed' }); await flush()
    t.advance(CRASH_REPEAT_WINDOW_MS)
    t.guard.onRenderProcessGone({ reason: 'crashed' }); await flush()
    expect(t.shown.map(o => o.buttons)).toEqual([['再読み込み', '終了'], ['再読み込み', '終了']])
    expect(t.calls.filter(c => c === 'reload')).toHaveLength(2)
  })

  it('無視した出来事（clean-exit）は数えない: clean-exit のあとの最初の異常は、再読み込みを勧める', async () => {
    const t = setup()
    t.guard.onRenderProcessGone({ reason: 'clean-exit' })
    t.guard.onRenderProcessGone({ reason: 'crashed' }); await flush()
    expect(t.shown.map(o => o.buttons)).toEqual([['再読み込み', '終了']])
  })

  it('★★ 窓が出ている間の異常では、窓を重ねない（記録には残す）。答えたあとは、また出せる', async () => {
    const t = setup({ hold: true })
    t.guard.onRenderProcessGone({ reason: 'crashed' }); await flush()
    t.guard.onRenderProcessGone({ reason: 'killed' }); await flush()
    expect(t.shown).toHaveLength(1)
    expect(t.logText()).toContain('reason=killed')
    expect(t.logText()).toContain('別の確認の窓が出ているため')
    t.answer(t.shown[0].buttons.indexOf('再読み込み')); await flush()
    expect(t.calls).toEqual(['dialog:再読み込み/終了', 'reload'])
    t.advance(CRASH_REPEAT_WINDOW_MS)
    t.guard.onRenderProcessGone({ reason: 'crashed' }); await flush()
    expect(t.shown).toHaveLength(2)
  })

  it('★ did-fail-load: 主フレームの失敗は窓＋記録。中断（-3）と子フレームは何も呼ばない', async () => {
    const t = setup()
    t.guard.onDidFailLoad({ errorCode: -3, errorDescription: 'ERR_ABORTED', isMainFrame: true })
    t.guard.onDidFailLoad({ errorCode: -102, errorDescription: 'ERR_CONNECTION_REFUSED', isMainFrame: false })
    await flush()
    expect(t.calls).toEqual([])
    expect(t.logs).toEqual([])
    t.guard.onDidFailLoad({ errorCode: -102, errorDescription: 'ERR_CONNECTION_REFUSED', isMainFrame: true })
    await flush()
    expect(t.calls).toEqual(['dialog:再読み込み/終了'])
    expect(t.logText()).toContain('did-fail-load errorCode=-102 ERR_CONNECTION_REFUSED')
  })

  it('★ 読み込みの失敗も、再読み込みしてまた失敗したら「終了」だけになる', async () => {
    const t = setup({ press: o => o.buttons.indexOf('再読み込み') })
    t.guard.onDidFailLoad({ errorCode: -102, errorDescription: 'x', isMainFrame: true }); await flush()
    t.advance(2_000)
    t.guard.onDidFailLoad({ errorCode: -102, errorDescription: 'x', isMainFrame: true }); await flush()
    expect(t.shown.map(o => o.buttons)).toEqual([['再読み込み', '終了'], ['終了']])
  })
})

// ── 4. main の例外・拒否 ─────────────────────────────────────────────────

describe('main の例外と拒否: 窓＋記録。同じ原因は1回だけ', () => {
  const boom = () => new Error('boom')

  it('★★ uncaughtException: 「続ける」「終了」の窓が出て、スタックつきで記録される。続けるでは何も実行しない', async () => {
    const t = setup({ press: o => o.buttons.indexOf('続ける') })
    t.guard.onUncaughtException(boom())
    await flush()
    expect(t.calls).toEqual(['dialog:続ける/終了'])
    expect(t.shown[0].message + t.shown[0].detail).toBe('Koto の内部で問題が起きました。続けると、正しく動かないことがあります。')
    expect(t.logs[0].level).toBe('error')
    expect(t.logs[0].message).toContain('uncaughtException')
    expect(t.logs[0].message).toContain('Error: boom')
    expect(t.logs[0].message).toContain('at ') // スタック
  })

  it('★★ 「終了」で quit（系統は main）', async () => {
    const t = setup({ press: o => o.buttons.indexOf('終了') })
    t.guard.onUncaughtException(boom())
    await flush()
    expect(t.calls).toEqual(['dialog:続ける/終了', 'quit:main'])
  })

  it('★★ 同じ原因は1回だけ出す（窓も記録も1回）。別の原因は別に出す', async () => {
    const t = setup({ press: o => o.buttons.indexOf('続ける') })
    for (let i = 0; i < 5; i++) { t.guard.onUncaughtException(boom()); await flush() }
    expect(t.shown).toHaveLength(1)
    expect(t.logs).toHaveLength(2) // 例外の記録 + 選んだ答え
    t.guard.onUncaughtException(new Error('another')); await flush()
    expect(t.shown).toHaveLength(2)
    expect(t.logText()).toContain('another')
  })

  it('同じ原因の見分け: メッセージが違えば別。同じ文字列の拒否は同じ', async () => {
    const t = setup({ press: o => o.buttons.indexOf('続ける') })
    t.guard.onUnhandledRejection('network down'); await flush()
    t.guard.onUnhandledRejection('network down'); await flush()
    expect(t.shown).toHaveLength(1)
    t.guard.onUnhandledRejection('disk full'); await flush()
    expect(t.shown).toHaveLength(2)
  })

  it('★ unhandledRejection: 値が Error でなくても（文字列・undefined・オブジェクト・循環）窓と記録を出し、投げない', async () => {
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    const t = setup({ press: o => o.buttons.indexOf('続ける') })
    for (const v of ['text reason', undefined, { code: 'E_X' }, circular, null, 42]) {
      expect(() => t.guard.onUnhandledRejection(v)).not.toThrow()
      await flush()
    }
    expect(t.shown).toHaveLength(6)
    expect(t.logText()).toContain('unhandledRejection')
    expect(t.logText()).toContain('text reason')
    expect(t.logText()).toContain('E_X')
  })

  it('★ 記録は秘密を伏せる（例外のメッセージに鍵が入っていても、そのままは残さない）', async () => {
    const t = setup({ press: o => o.buttons.indexOf('続ける') })
    t.guard.onUncaughtException(new Error('request failed: Authorization: Bearer abcdefgh12345678 ghp_0123456789abcdefghij'))
    await flush()
    // 伏せるのは書く側（createCrashLogWriter）の役目だが、組み立てる文の時点でも伏せる
    expect(t.logs[0].message).not.toContain('abcdefgh12345678')
    expect(t.logs[0].message).not.toContain('ghp_0123456789abcdefghij')
    expect(errorText(new Error('token=abcdefgh12345678'))).not.toContain('abcdefgh12345678')
  })

  it('★★ 例外を握りつぶさない: 窓の前に記録が出る（窓が開いたままでも記録は残っている）', async () => {
    const t = setup({ hold: true })
    t.guard.onUncaughtException(boom())
    await flush()
    expect(t.logs.map(l => l.level)).toEqual(['error'])
    expect(t.shown).toHaveLength(1)
  })

  it('★ 例外の窓が出ている間に画面の異常が起きても、窓は重ならない', async () => {
    const t = setup({ hold: true })
    t.guard.onUncaughtException(boom()); await flush()
    t.guard.onRenderProcessGone({ reason: 'crashed' }); await flush()
    expect(t.shown).toHaveLength(1)
    expect(t.logText()).toContain('render-process-gone')
  })

  it('main の例外は、画面の異常の回数に影響されない（画面で2回落ちたあとでも「続ける」がある）', async () => {
    const t = setup({ press: o => o.buttons.indexOf('再読み込み') })
    t.guard.onRenderProcessGone({ reason: 'crashed' }); await flush()
    t.guard.onRenderProcessGone({ reason: 'crashed' }); await flush()
    t.guard.onUncaughtException(boom()); await flush()
    expect(t.shown[2].buttons).toEqual(['続ける', '終了'])
  })

  it('覚える原因の数には上限がある（同じ原因でなく別々の例外が大量に来ても、増え続けない）', async () => {
    const t = setup({ press: o => o.buttons.indexOf('続ける') })
    for (let i = 0; i < 260; i++) { t.guard.onUnhandledRejection(`cause-${i}`); await flush() }
    expect(t.shown).toHaveLength(260)
    // 古いものは忘れられている（最初の原因がもう一度出る）。直近のものはまだ覚えている
    t.guard.onUnhandledRejection('cause-259'); await flush()
    expect(t.shown).toHaveLength(260)
    t.guard.onUnhandledRejection('cause-0'); await flush()
    expect(t.shown).toHaveLength(261)
  })
})

// ── 5. 応答しない／戻った ────────────────────────────────────────────────

describe('unresponsive／responsive: 戻るのを少し待ち、戻らなければ聞く', () => {
  it('★★ unresponsive だけでは窓を出さない。待ち時間のあとで、まだ戻っていなければ画面の窓を出す', async () => {
    const t = setup()
    t.guard.onUnresponsive()
    await flush()
    expect(t.calls).toEqual([])
    expect(t.timers).toHaveLength(1)
    expect(t.timers[0].ms).toBe(UNRESPONSIVE_GRACE_MS)
    t.fireTimers(); await flush()
    expect(t.calls).toEqual(['dialog:再読み込み/終了'])
    expect(t.logText()).toContain('unresponsive')
  })

  it('★★ 待ち時間の間に responsive が来たら、窓は出ない（予約を取り消す）', async () => {
    const t = setup()
    t.guard.onUnresponsive()
    t.guard.onResponsive()
    expect(t.timers[0].cancelled).toBe(true)
    t.fireTimers(); await flush()
    expect(t.calls).toEqual([])
    expect(t.logText()).toContain('画面の応答が戻りました')
  })

  it('同じ停止の間の unresponsive は予約を1つしか持たない。戻ったあとの次の停止は、また予約する', async () => {
    const t = setup()
    t.guard.onUnresponsive(); t.guard.onUnresponsive()
    expect(t.timers).toHaveLength(1)
    t.guard.onResponsive()
    t.guard.onUnresponsive()
    expect(t.timers).toHaveLength(2)
  })

  it('60秒以内に続けて応答しなくなったら、2回目は「終了」だけ', async () => {
    const t = setup({ press: o => o.buttons.indexOf('再読み込み') })
    t.guard.onUnresponsive(); t.fireTimers(); await flush()
    t.advance(20_000)
    t.guard.onUnresponsive(); t.fireTimers(); await flush()
    expect(t.shown.map(o => o.buttons)).toEqual([['再読み込み', '終了'], ['終了']])
  })

  it('★★ 待っている間に窓が閉じたら、窓は出ない（予約を取り消す）。窓が無いのに「停止しました」を出さない', async () => {
    const t = setup()
    t.guard.onUnresponsive()
    t.guard.onWindowClosed()
    expect(t.timers[0].cancelled).toBe(true)
    t.fireTimers(); await flush()
    expect(t.calls).toEqual([])
    expect(t.logText()).not.toContain('unresponsive')
    expect(t.logText()).toContain('窓が閉じたため、画面の応答の待ち受けを取り消しました')
    // 次の停止（新しい窓）は、また予約する。60秒の「繰り返し」にも数えない（窓を出していない）
    t.guard.onUnresponsive()
    expect(t.timers).toHaveLength(2)
    t.fireTimers(); await flush()
    expect(t.shown.map(o => o.buttons)).toEqual([['再読み込み', '終了']])
  })

  it('窓が閉じたとき、待ち受けが無ければ何もしない（記録にも書かない・投げない）', async () => {
    const t = setup()
    expect(() => t.guard.onWindowClosed()).not.toThrow()
    await flush()
    expect(t.calls).toEqual([])
    expect(t.logs).toEqual([])
  })

  it('★★ 待っている間に画面が落ちたら、予約は取り消す。落ちた窓の答え（再読み込み）のあとに、停止の窓を重ねて出さない', async () => {
    const t = setup({ press: o => o.buttons.indexOf('再読み込み') })
    t.guard.onUnresponsive()
    t.guard.onRenderProcessGone({ reason: 'crashed' })
    expect(t.timers[0].cancelled).toBe(true)
    await flush()
    t.fireTimers(); await flush()
    // 窓は落ちた分の1回だけ。「再読み込み」を押したあとに「終了」だけの窓（繰り返しの扱い）は出ない
    expect(t.calls).toEqual(['dialog:再読み込み/終了', 'reload'])
    expect(t.logText()).not.toContain('unresponsive')
  })

  it('画面が落ちたとき、clean-exit（異常ではない）でも予約は取り消す。窓は出ない', async () => {
    const t = setup()
    t.guard.onUnresponsive()
    t.guard.onRenderProcessGone({ reason: 'clean-exit' })
    expect(t.timers[0].cancelled).toBe(true)
    t.fireTimers(); await flush()
    expect(t.calls).toEqual([])
  })

  it('★ 待っている間に画面を読み込めなくなったら（本体のフレーム）、予約は取り消す。無視するもの（読み込みの中断・子フレーム）では取り消さない', async () => {
    const ignored = setup()
    ignored.guard.onUnresponsive()
    ignored.guard.onDidFailLoad({ errorCode: -3, errorDescription: 'ERR_ABORTED', isMainFrame: true })
    ignored.guard.onDidFailLoad({ errorCode: -102, errorDescription: 'ERR_CONNECTION_REFUSED', isMainFrame: false })
    expect(ignored.timers[0].cancelled).toBe(false)
    ignored.fireTimers(); await flush()
    expect(ignored.calls).toEqual(['dialog:再読み込み/終了'])

    const failed = setup()
    failed.guard.onUnresponsive()
    failed.guard.onDidFailLoad({ errorCode: -102, errorDescription: 'ERR_CONNECTION_REFUSED', isMainFrame: true })
    expect(failed.timers[0].cancelled).toBe(true)
    await flush()
    failed.fireTimers(); await flush()
    expect(failed.calls).toEqual(['dialog:再読み込み/終了'])
  })

  it('取り消しの道具が投げても、予約は捨て、次の停止でまた予約できる（どの口も投げない）', async () => {
    const calls: string[] = []
    const logs: string[] = []
    let n = 0
    const guard = createCrashGuard({
      dialog: async () => 0, reload: () => {}, quit: () => {}, now: () => T0,
      log: (_l, m) => { logs.push(m) },
      schedule: () => { n++; return () => { calls.push(`cancel${n}`); throw new Error('cancel failed') } },
    })
    guard.onUnresponsive()
    expect(() => guard.onWindowClosed()).not.toThrow()
    expect(logs.join('\n')).toContain('応答の待ち受けの取り消しに失敗しました')
    guard.onUnresponsive()
    expect(n).toBe(2)
    expect(() => guard.onResponsive()).not.toThrow()
    expect(calls).toEqual(['cancel1', 'cancel2'])
  })

  it('既定のタイマー（setTimeout）でも動く', async () => {
    vi.useFakeTimers()
    const t = setup({ useRealSchedule: true })
    t.guard.onUnresponsive()
    await vi.advanceTimersByTimeAsync(UNRESPONSIVE_GRACE_MS - 1)
    expect(t.calls).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(t.calls).toEqual(['dialog:再読み込み/終了'])
    t.guard.onResponsive()
  })
})

// ── 6. 答えの扱いと、道具の失敗 ───────────────────────────────────────────

describe('答えの扱い: 範囲外・窓の失敗・閉じた、は何もしない', () => {
  it('★★ Esc（取消の番号）・範囲外・負・小数・NaN を押されても、再読み込みも終了もしない', async () => {
    for (const press of [(o: CrashDialogOptions) => o.cancelId, () => 99, () => -1, () => 0.5, () => NaN]) {
      const t = setup({ press })
      t.guard.onRenderProcessGone({ reason: 'crashed' })
      await flush()
      expect(t.calls, String(press)).toEqual(['dialog:再読み込み/終了'])
      expect(t.logText()).toContain('答えなしで閉じました')
    }
  })

  it('★★ 窓が出せなかったとき（失敗）は何もしない。記録に残り、次の異常でまた聞ける', async () => {
    const t = setup({ dialogFails: true })
    t.guard.onUncaughtException(new Error('first')); await flush()
    expect(t.calls).toEqual(['dialog:続ける/終了'])
    expect(t.logText()).toContain('確認の窓を出せませんでした')
    t.guard.onUncaughtException(new Error('second')); await flush()
    expect(t.shown).toHaveLength(2)
  })

  it('★ 答えの実行（reload・quit）が投げても、拒否を残さず、記録に書き、次の異常でまた聞ける', async () => {
    const t = setup({ press: o => o.buttons.indexOf('再読み込み'), reloadThrows: true })
    t.guard.onRenderProcessGone({ reason: 'crashed' }); await flush()
    expect(t.logText()).toContain('答えを実行できませんでした（reload）')
    const q = setup({ press: o => o.buttons.indexOf('終了'), quitThrows: true })
    q.guard.onUncaughtException(boomError()); await flush()
    expect(q.logText()).toContain('答えを実行できませんでした（quit）')
    q.guard.onUncaughtException(new Error('next')); await flush()
    expect(q.shown).toHaveLength(2)
  })

  it('★ 記録の道具が投げても、窓まで進む（記録の失敗が異常の処理を止めない）。どの口も投げない', async () => {
    const t = setup({ logThrows: true, press: o => o.buttons.indexOf('続ける') })
    expect(() => t.guard.onUncaughtException(boomError())).not.toThrow()
    expect(() => t.guard.onRenderProcessGone({ reason: 'crashed' })).not.toThrow()
    expect(() => t.guard.onUnresponsive()).not.toThrow()
    expect(() => t.guard.onResponsive()).not.toThrow()
    await flush()
    expect(t.shown.length).toBeGreaterThanOrEqual(1)
  })
})
function boomError() { return new Error('boom') }

// ── 7. 記録（本物の一時フォルダ）─────────────────────────────────────────

describe('createCrashLogWriter: app.getPath(logs) の下の crash.log に、秘密を伏せて1行ずつ残す', () => {
  const dirs: string[] = []
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'koto-crash-')); dirs.push(d); return d }
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

  it('★ 1行 = 1件。時刻・深刻度・本文。改行は1行にまとめる。ほかのファイルは作らない', () => {
    const dir = join(tmp(), 'Logs', 'Koto') // まだ無いフォルダ（作る）
    const write = createCrashLogWriter(() => dir, { now: () => new Date('2026-11-03T01:02:03.000Z') })
    write('error', 'line one\nline two')
    write('info', '選んだ答え: 続ける')
    expect(readdirSync(dir)).toEqual([CRASH_LOG_FILE])
    const lines = readFile(join(dir, CRASH_LOG_FILE), 'utf8').split('\n')
    expect(lines).toEqual([
      '2026-11-03T01:02:03.000Z [error] line one ⏎ line two',
      '2026-11-03T01:02:03.000Z [info] 選んだ答え: 続ける',
      '',
    ])
  })

  it('★ 秘密を伏せてから書く（伏せ字だけが残る）', () => {
    const dir = tmp()
    const write = createCrashLogWriter(() => dir)
    write('error', 'failed GET https://user:p@ssw0rd@example.com/x ?access_token=abcdefgh12345678 ghp_0123456789abcdefghij')
    const text = readFile(join(dir, CRASH_LOG_FILE), 'utf8')
    for (const secret of ['p@ssw0rd', 'abcdefgh12345678', 'ghp_0123456789abcdefghij']) expect(text).not.toContain(secret)
    expect(text).toContain('***')
    expect(text).toContain('example.com')
  })

  it('★★ ホームのパス（利用者名）は ~ にして書く。その下のフォルダ名は調べるのに要るので残す', () => {
    const dir = tmp()
    const write = createCrashLogWriter(() => dir)
    write('error', "ENOENT: no such file or directory, open '/Users/tanaka/Projects/A社サイト/.sakuraide.json'\n    at read (/Users/tanaka/sakura-ide/dist/main/a.js:10:5)")
    const text = readFile(join(dir, CRASH_LOG_FILE), 'utf8')
    expect(text).not.toContain('tanaka')
    expect(text).not.toContain('/Users/')
    expect(text).toContain("open '~/Projects/A社サイト/.sakuraide.json'")
    expect(text).toContain('at read (~/sakura-ide/dist/main/a.js:10:5)')
  })

  it('★ 実行している環境のホーム（os.homedir()）も ~ にする。/Users の外にあってもよい', () => {
    const dir = tmp()
    const own = homedir()
    if (own.length > 1) {
      createCrashLogWriter(() => dir)('error', `open '${own}/Documents/memo.txt'`)
      const text = readFile(join(dir, CRASH_LOG_FILE), 'utf8')
      expect(text).not.toContain(own)
      expect(text).toContain("open '~/Documents/memo.txt'")
    }
    const other = tmp()
    createCrashLogWriter(() => other, { home: '/var/folders/zz/tanaka-home' })('error', "open '/var/folders/zz/tanaka-home/Documents/memo.txt'")
    expect(readFile(join(other, CRASH_LOG_FILE), 'utf8')).toContain("open '~/Documents/memo.txt'")
  })

  it('★★ main の拒否 → 本物の記録: fs の失敗のパスから利用者名が消えて crash.log に残る。errorText も同じ', async () => {
    const msg = "ENOENT: no such file or directory, open '/Users/taro.yamada/Documents/お客様A/shop/public/index.html'"
    expect(errorText(new Error(msg))).not.toContain('taro.yamada')
    expect(errorText(new Error(msg))).toContain("open '~/Documents/お客様A/shop/public/index.html'")
    expect(errorText(msg)).not.toContain('taro.yamada')
    const dir = tmp()
    const write = createCrashLogWriter(() => dir)
    const guard = createCrashGuard({
      dialog: () => new Promise<number>(() => { /* 開いたまま */ }),
      reload: () => {}, quit: () => {}, now: () => T0,
      log: (level, message) => write(level, message),
    })
    guard.onUnhandledRejection(new Error(msg))
    await flush()
    const text = readFile(join(dir, CRASH_LOG_FILE), 'utf8')
    expect(text).toContain('[error] main で受け取っていない拒否（unhandledRejection）')
    expect(text).not.toContain('taro.yamada')
    expect(text).not.toContain('/Users/')
    expect(text).toContain('~/Documents/お客様A/shop/public/index.html')
  })

  it('★ 上限を超えたら古い行から捨てる（行の途中では切らない）', () => {
    const dir = tmp()
    const write = createCrashLogWriter(() => dir, { maxBytes: 400 })
    for (let i = 0; i < 30; i++) write('error', `entry-${String(i).padStart(2, '0')} ` + 'x'.repeat(20))
    const text = readFile(join(dir, CRASH_LOG_FILE), 'utf8')
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(400 + 100)
    const lines = text.split('\n').filter(Boolean)
    expect(lines[lines.length - 1]).toContain('entry-29')
    expect(text).not.toContain('entry-00')
    for (const l of lines) expect(l).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z \[error\] entry-\d\d x{20}$/)
  })

  it('★ 書けない場所でも投げない（例外の処理の中で呼ばれる）', () => {
    const base = tmp()
    writeFileSync(join(base, 'file'), 'x')
    const underFile = createCrashLogWriter(() => join(base, 'file', 'sub'))
    expect(() => underFile('error', 'x')).not.toThrow()
    const dirThrows = createCrashLogWriter(() => { throw new Error('no logs dir') })
    expect(() => dirThrows('error', 'x')).not.toThrow()
  })

  it('★★ 例外 → 本物の記録: 窓の答えを待つ間にも、秘密を伏せたスタックつきの1行が crash.log にある。異常でないものは書かない', async () => {
    const dir = tmp()
    const write = createCrashLogWriter(() => dir)
    const guard = createCrashGuard({
      dialog: () => new Promise<number>(() => { /* 開いたまま */ }),
      reload: () => {}, quit: () => {}, now: () => T0,
      log: (level, message) => write(level, message),
    })
    guard.onRenderProcessGone({ reason: 'clean-exit' })
    guard.onDidFailLoad({ errorCode: -3, errorDescription: 'ERR_ABORTED', isMainFrame: true })
    await flush()
    expect(readdirSync(dir)).toEqual([]) // 何も書いていない
    guard.onUncaughtException(new Error('Authorization: Bearer abcdefgh12345678 was rejected'))
    await flush()
    const text = readFile(join(dir, CRASH_LOG_FILE), 'utf8')
    expect(text.split('\n').filter(Boolean)).toHaveLength(1)
    expect(text).toContain('[error] main で捕まえていない例外（uncaughtException）')
    expect(text).toContain('was rejected')
    expect(text).toContain(' at ')
    expect(text).not.toContain('abcdefgh12345678')
  })
})

// ── 8. main.ts の配線（コメントを除いた実物の呼び出しの形）────────────────────

describe('main.ts の配線: 5つの出来事を全部 crashGuard へ渡す。選り分けは crashGuard.ts だけ', () => {
  const main = codeOnly(read('src/main/main.ts'))
  const guardSrc = codeOnly(read('src/main/crashGuard.ts'))
  const count = (hay: string, needle: string) => hay.split(needle).length - 1

  it('crashGuard を作っている（画面の窓・再読み込み・終了・時計・記録をつなぐ）', () => {
    expect(main).toContain("import { createCrashGuard, createCrashLogWriter } from './crashGuard'")
    expect(main).toContain('const crashGuard = createCrashGuard({')
    expect(main).toContain("const writeCrashLog = createCrashLogWriter(() => app.getPath('logs'))")
    expect(main).toContain('now: () => Date.now(),')
  })

  it('★★ 画面の3つの出来事（4つのイベント）が、読み込みを始める前に、全部そのまま渡されている', () => {
    const at = main.indexOf('const crashWc = mainWindow.webContents')
    expect(at).toBeGreaterThan(0)
    const load = Math.min(main.indexOf('mainWindow.loadURL(', at), main.indexOf('mainWindow.loadFile(', at))
    expect(load).toBeGreaterThan(at)
    const block = main.slice(at, load)
    expect(block).toContain("crashWc.on('render-process-gone', (_e, details) => crashGuard.onRenderProcessGone(details))")
    expect(block).toContain("crashWc.on('did-fail-load', (_e, errorCode, errorDescription, _url, isMainFrame) => crashGuard.onDidFailLoad({ errorCode, errorDescription, isMainFrame }))")
    expect(block).toContain("crashWc.on('unresponsive', () => crashGuard.onUnresponsive())")
    expect(block).toContain("crashWc.on('responsive', () => crashGuard.onResponsive())")
  })

  it('★★ main の2つの出来事が process に付いている（起動の最初から。窓の中ではなく外）', () => {
    expect(main).toContain("process.on('uncaughtException', (error) => crashGuard.onUncaughtException(error))")
    expect(main).toContain("process.on('unhandledRejection', (reason) => crashGuard.onUnhandledRejection(reason))")
    expect(count(main, "process.on('uncaughtException'")).toBe(1)
    expect(count(main, "process.on('unhandledRejection'")).toBe(1)
    // createWindow の外（作り直しのたびに増えない）
    expect(main.indexOf("process.on('uncaughtException'")).toBeLessThan(main.indexOf('function createWindow()'))
  })

  it('★★ 窓が閉じたら、応答の待ち受けも取り消す（画面の出来事と同じ場所で、読み込みを始める前に付ける）', () => {
    const at = main.indexOf('const crashWc = mainWindow.webContents')
    const load = Math.min(main.indexOf('mainWindow.loadURL(', at), main.indexOf('mainWindow.loadFile(', at))
    expect(main.slice(at, load)).toContain("mainWindow.on('closed', () => crashGuard.onWindowClosed())")
    expect(count(main, 'crashGuard.onWindowClosed()')).toBe(1)
    // 終了の歯止めの 'closed'（印を戻す）は、今のまま別の1行
    expect(main).toContain("mainWindow.on('closed', () => { mainWindow = null; quitGuard.reset() })")
    // 取り消しの定義は crashGuard.ts の1か所（main.ts に待ち時間や予約を持ち込まない）
    expect(guardSrc).toContain('onWindowClosed: (): void => {')
    expect(main).not.toContain('UNRESPONSIVE_GRACE_MS')
  })

  it('各出来事のハンドラは src/main 全体で1つずつ（二重に付けない）', () => {
    const files: string[] = []
    const walk = (d: string) => { for (const e of readdirSync(join(__dirname, '..', d), { withFileTypes: true })) e.isDirectory() ? walk(`${d}/${e.name}`) : files.push(`${d}/${e.name}`) }
    walk('src/main')
    const all = files.filter(f => f.endsWith('.ts')).map(f => codeOnly(read(f))).join('\n')
    for (const ev of ["'render-process-gone'", "'did-fail-load'", "'unresponsive'", "'responsive'", "'uncaughtException'", "'unhandledRejection'"]) {
      expect(count(all, `.on(${ev}`), ev).toBe(1)
    }
  })

  it('★★ 何を無視するか・再読み込みを止めるか・窓の文は main.ts に書かない（1か所の定義）', () => {
    for (const w of ['clean-exit', 'isMainFrame &&', 'errorCode !==', 'errorCode ===', '-3', 'defaultId', 'cancelId', 'buttons', 'response ===', '再読み込み', '続ける', '停止しました']) {
      const at = main.indexOf('const crashGuard = createCrashGuard({')
      const block = main.slice(at, main.indexOf('process.on(\'uncaughtException\'', at))
      expect(block, `main.ts の crashGuard の定義に ${w} を書いている`).not.toContain(w)
    }
    const wcBlock = main.slice(main.indexOf('const crashWc = mainWindow.webContents'), main.indexOf('if (process.env.NODE_ENV === \'development\') {'))
    for (const w of ['clean-exit', 'isMainFrame &&', 'errorCode !==', '-3']) expect(wcBlock).not.toContain(w)
  })

  it('★★ 終了は app.quit()（quitGuard を通る）。画面の異常のときだけ画面の印を捨てる。app.exit・process.exit・app.relaunch で抜けない', () => {
    expect(main).toContain("    if (family === 'renderer') forgetRendererMarks()\n    app.quit()\n")
    expect(main).toContain("  reload: () => {\n    forgetRendererMarks()\n    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload()\n  },")
    for (const src of [main, guardSrc]) {
      expect(src).not.toContain('app.exit(')
      expect(src).not.toContain('process.exit(')
      expect(src).not.toContain('app.relaunch(')
    }
    // main の例外のときは画面の印に触れない（画面は生きていて、未保存の確認はふだんどおり出す）
    expect(main).not.toContain("if (family === 'main') forgetRendererMarks()")
    expect(main).not.toContain('forceQuit = true\n    app.quit()')
  })

  it('窓は親を付けず（準備ができてから）出し、設定は crashGuard.ts の作ったものをそのまま渡す', () => {
    expect(main).toContain('await app.whenReady()\n    return (await dialog.showMessageBox(opts)).response')
    expect(main).not.toContain('dialog.showErrorBox')
  })

  it('★ 記録の行は formatLogLine が組み立て（秘密とホームのパスを落とす）。crashGuard.ts は書く直前に自分で置き換えない', () => {
    expect(guardSrc).toContain("fs.appendFileSync(file, formatLogLine(level, message, now(), opts.home ?? homeDir()) + '\\n', 'utf8')")
    expect(guardSrc).not.toContain('formatLogLine(level, message, now()) +')
  })

  it('crashGuard.ts は electron に触れない（偽の道具でテストできる）', () => {
    expect(guardSrc).not.toContain("from 'electron'")
    expect(guardSrc).not.toContain('require(')
  })

  it('画面が登録した印は、画面の異常のときに全部捨てる（残ると、止まった画面へ「保存して終了」を頼み続ける）', () => {
    const at = main.indexOf('function forgetRendererMarks(): void {')
    const body = main.slice(at, main.indexOf('\n}\n', at))
    for (const v of ['hasUnsavedChanges = false', 'isBusy = false', "busyLabel = ''", 'closeBlockingBusy = false', "closeBlockingLabel = ''", "closeBlockingDetail = ''", "closeBlockingConfirm = ''"]) {
      expect(body, v).toContain(v)
    }
  })
})
