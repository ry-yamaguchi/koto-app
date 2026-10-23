import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { localOpsWindow, opProgressText, opElapsedText } from '../src/renderer/projectOpsView'

// ── 「この画面が始めた操作の窓」と、進み具合の文は、処理の記録の読み方の置き場（projectOpsView.ts）の1つ ─────────
// 0.6.22 段階3B-3（設計書 10.11.7 の最後・10.11.15・10.6.2 の7）。
//   ・窓の判断（始めた時刻以上・出し終えた時刻以下・渡したことにする）は `localOpsWindow` の1つ。
//     📡 の行の見張り（teardown/watch.ts の watchTeardownOps）と、専有型のパネルの見張り（apprunDedicatedActions.ts の watchDedicatedOps。
//     手順5・6・8）が同じこれを通る。見張りそのものの振る舞いは tests/teardownWatchCommon.test.ts・tests/ops-dedicated-resume.test.ts。
//   ・進み具合の一文・経過の文（opProgressText・opElapsedText）の定義は projectOpsView.ts の1つ（前は teardown/flow.ts と apprunDedicatedActions.ts に同じ中身が2つ）。

/** 時計を手で進める。 */
function clock(start = 1000) {
  let t = start
  return { now: () => t, set: (v: number) => { t = v } }
}

describe('localOpsWindow: 始めた時刻以上・出し終えた時刻以下に始まった記録だけを覆う', () => {
  it('★ 始めていないあいだは、どの記録も窓の外（outside）', () => {
    const c = clock()
    const w = localOpsWindow(c.now)
    expect(w.stateOf({ startedAt: 0 })).toBe('outside')
    expect(w.stateOf({ startedAt: 1000 })).toBe('outside')
    expect(w.stateOf({ startedAt: 99999 })).toBe('outside')
  })

  it('★★ begin のあと: since より前に始まった記録は外、since 以降は active（出している最中）', () => {
    const c = clock(1000)
    const w = localOpsWindow(c.now)
    w.begin()
    expect(w.stateOf({ startedAt: 999 })).toBe('outside') // この画面が始める前に終わっていた記録
    expect(w.stateOf({ startedAt: 1000 })).toBe('active') // since ちょうどは窓の中
    expect(w.stateOf({ startedAt: 5000 })).toBe('active')
  })

  it('★★★ end のあと: 窓の上限（出し終えた時刻）まで done、それより後に始まった記録は外（別の入口が始めたものは、この画面のものではない）', () => {
    const c = clock(1000)
    const w = localOpsWindow(c.now)
    w.begin()
    c.set(2000)
    expect(w.end()).toBe(true)
    expect(w.stateOf({ startedAt: 1500 })).toBe('done') // 出し終えた＝「見た」にしてよい
    expect(w.stateOf({ startedAt: 2000 })).toBe('done') // 上限ちょうどは窓の中
    expect(w.stateOf({ startedAt: 2001 })).toBe('outside') // 出し終えたあとに始まった記録
    expect(w.stateOf({ startedAt: 999 })).toBe('outside')
  })

  it('★★ 上限は、時計が戻っても since より前にならない（max(now, since)）', () => {
    const c = clock(5000)
    const w = localOpsWindow(c.now)
    w.begin()
    c.set(3000) // 時計が戻った
    w.end()
    expect(w.stateOf({ startedAt: 5000 })).toBe('done')
    expect(w.stateOf({ startedAt: 5001 })).toBe('outside')
  })

  it('★★ begin のたびに窓を張り直す: 前の窓の上限は捨てる。前の窓の記録は、新しい since より前なら外になる', () => {
    const c = clock(1000)
    const w = localOpsWindow(c.now)
    w.begin()
    c.set(2000)
    w.end()
    c.set(3000)
    w.begin() // 押し直し
    expect(w.stateOf({ startedAt: 1500 })).toBe('outside') // 前の窓の記録（呼び手は渡したことにしている）
    expect(w.stateOf({ startedAt: 2500 })).toBe('outside') // 間に別の入口が始めたもの
    expect(w.stateOf({ startedAt: 3000 })).toBe('active')
    expect(w.stateOf({ startedAt: 9999 })).toBe('active') // 上限は外れている（出している最中）
  })

  it('★ end は begin が無ければ何もせず false（呼び手は記録を読み直さない・ack もしない）。その後も窓は無いまま', () => {
    const c = clock()
    const w = localOpsWindow(c.now)
    expect(w.end()).toBe(false)
    expect(w.stateOf({ startedAt: 1000 })).toBe('outside')
  })

  it('窓は作るたびに別（種類ごとに1つずつ持てる）', () => {
    const c = clock(1000)
    const a = localOpsWindow(c.now)
    const b = localOpsWindow(c.now)
    a.begin()
    expect(a.stateOf({ startedAt: 1500 })).toBe('active')
    expect(b.stateOf({ startedAt: 1500 })).toBe('outside')
  })
})

describe('窓の判断は2つの見張りが同じ localOpsWindow を通る（片方だけ直る、を作らない）', () => {
  const code = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  const WATCHERS = ['src/renderer/teardown/watch.ts', 'src/renderer/apprunDedicatedActions.ts']

  it.each(WATCHERS)('★★ %s は localOpsWindow を使い、窓の時刻（since・until）を自分では持たない', rel => {
    const src = code(rel)
    expect(src, `${rel} が localOpsWindow を呼んでいない`).toMatch(/localOpsWindow\(now\)/)
    expect(src, `${rel} が窓の時刻を自前で持っている（判断が2つに割れる）`).not.toMatch(/\bsince\s*:/)
    expect(src).not.toMatch(/\buntil\s*[:=]/)
  })

  it('★ 手順5・6・8は種類ごとに窓を1つずつ持つ（beginLocal のときに作る）', () => {
    const src = code('src/renderer/apprunDedicatedActions.ts')
    expect(src).toContain('beginLocal(kind) { (locals[kind] ??= localOpsWindow(now)).begin() },')
    expect(src).toContain('if (!locals[kind]?.end()) return')
  })
})

describe('opProgressText / opElapsedText の定義は projectOpsView.ts の1か所（二重の解消）', () => {
  it('★ 進み具合の一文: label に detail が続く。前後の空白は落とす。無ければ空', () => {
    expect(opProgressText({ progress: { label: ' A ', detail: ' B ' } })).toBe('A B')
    expect(opProgressText({ progress: { label: 'A' } })).toBe('A')
    expect(opProgressText({ progress: { detail: 'B' } })).toBe('B')
    expect(opProgressText(null)).toBe('')
  })

  it('★ 経過の文: 1分未満・N分（切り捨て）・時計が戻っても負にならない', () => {
    expect(opElapsedText(0, 59_999)).toBe('始まってから1分未満')
    expect(opElapsedText(0, 60_000)).toBe('始まってから約1分')
    expect(opElapsedText(0, 9 * 60_000 + 30_000)).toBe('始まってから約9分')
    expect(opElapsedText(5000, 1000)).toBe('始まってから1分未満')
  })

  it('★★ `function opProgressText`・`function opElapsedText` を定義するのは src で projectOpsView.ts だけ', () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n: string) => {
      const p = join(dir, n)
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []
    })
    // 全ファイルを1回だけ読む（名前ごとに読み直さない。忙しい機械で時間切れにしない）。
    const files = walk(join(__dirname, '../src')).map(f => ({ f, text: readFileSync(f, 'utf8') }))
    const defs = (name: string) => files
      .filter(({ text }) => new RegExp(`function ${name}\\b`).test(text))
      .map(({ f }) => f.replace(join(__dirname, '..') + '/', ''))
    expect(defs('opProgressText')).toEqual(['src/renderer/projectOpsView.ts'])
    expect(defs('opElapsedText')).toEqual(['src/renderer/projectOpsView.ts'])
  })
})
