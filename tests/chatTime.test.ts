import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { stamp, timelineMarks, bubbleTime, type TimelineMark } from '../src/shared/chatTime'

// 会話がいつのものか分からず、あとで見返したときに「これはなんだっけ？」となる（利用者からの要望）。
// 日付の区切りと、吹き出しに触れたときの時刻表示のための純粋ロジックを固定する。
//
// ── 古い会話には時刻が無い（推測で埋めない）───────────────────────────
// これまでの chat.json には `at` が無い。あとから付けると、実際にはいつ話したか
// 分からないものに嘘の時刻が付くため、`unknown` として区別する（date にしない）。

const NOW = new Date(2026, 7, 26, 10, 0, 0) // 2026-08-26（水）10:00

describe('timelineMarks（区切りの判定）', () => {
  // ⚠️ **置き場所を変えた（2026-08-26 Ryosuke 実機報告）。**
  // 最初は「記録なしの塊の**先頭**」に出していたが、**一度も見られなかった**。
  // チャットは常にいちばん下から始まるので、長い会話の先頭までは誰も遡らない。
  it('記録が1つも無いなら、境目は出さない（出しても誰も見ない）', () => {
    const marks = timelineMarks([{}, {}, {}], NOW)
    expect(marks).toEqual<TimelineMark[]>([
      { kind: 'none' },
      { kind: 'none' },
      { kind: 'none' },
    ])
  })

  it('境目は「記録なしの塊が終わるところ」に出る（＝最初の記録あるものの上）', () => {
    const marks = timelineMarks([
      {}, // 古い会話（記録なし）
      {}, // 同じ塊
      { at: new Date(2026, 7, 26, 12, 0, 0).toISOString() }, // ここから記録あり（今日）
      { at: new Date(2026, 7, 26, 13, 0, 0).toISOString() },
    ], NOW)
    expect(marks[0]).toEqual({ kind: 'none' })
    expect(marks[1]).toEqual({ kind: 'none' })
    expect(marks[2]).toEqual({ kind: 'unknown', label: '今日' })  // ← 直す前はここが date だった
    expect(marks[3]).toEqual({ kind: 'none' })
  })

  // ⚠️ **境目でも日付を落とさない。** 一度そう作ったら、記録がある最初の会話が
  // 「いつのものか分からない」ままになった——それこそが直したかったこと（2026-08-26）。
  it('境目は、日付も一緒に持つ', () => {
    const marks = timelineMarks([{}, { at: new Date(2026, 7, 21, 12, 0, 0).toISOString() }], NOW)
    expect(marks[1]).toEqual({ kind: 'unknown', label: '8月21日（金）' })
  })

  // 最初から記録があるなら、区別すべき相手がいない。
  it('先頭から記録があるなら、境目は出さない', () => {
    const marks = timelineMarks([
      { at: new Date(2026, 7, 26, 12, 0, 0).toISOString() },
      { at: new Date(2026, 7, 26, 13, 0, 0).toISOString() },
    ], NOW)
    expect(marks[0]).toEqual({ kind: 'date', label: '今日' })
    expect(marks.filter(m => m.kind === 'unknown')).toEqual([])
  })

  // 境目より下に混ざった記録なしは、区切りを増やさない。
  it('境目のあとに記録なしが混ざっても、区切りは増えない', () => {
    const marks = timelineMarks([
      {},
      { at: new Date(2026, 7, 26, 12, 0, 0).toISOString() },
      {},
      { at: new Date(2026, 7, 26, 13, 0, 0).toISOString() },
    ], NOW)
    expect(marks.filter(m => m.kind === 'unknown').length).toBe(1)
    expect(marks[2]).toEqual({ kind: 'none' })
  })

  it('同じ日が続く間は区切りが出ない', () => {
    const marks = timelineMarks([
      { at: new Date(2026, 7, 26, 9, 0, 0).toISOString() },
      { at: new Date(2026, 7, 26, 10, 0, 0).toISOString() },
      { at: new Date(2026, 7, 26, 23, 59, 0).toISOString() },
    ], NOW)
    expect(marks[0]).toEqual({ kind: 'date', label: '今日' })
    expect(marks[1]).toEqual({ kind: 'none' })
    expect(marks[2]).toEqual({ kind: 'none' })
  })

  it('日をまたぐと出る', () => {
    const marks = timelineMarks([
      { at: new Date(2026, 7, 25, 23, 0, 0).toISOString() }, // 昨日
      { at: new Date(2026, 7, 26, 0, 30, 0).toISOString() }, // 今日に変わった
    ], NOW)
    expect(marks[0]).toEqual({ kind: 'date', label: '昨日' })
    expect(marks[1]).toEqual({ kind: 'date', label: '今日' })
  })

  it('途中に混ざった at 無しのメッセージ（先頭の塊ではないもの）は none', () => {
    const marks = timelineMarks([
      { at: new Date(2026, 7, 26, 9, 0, 0).toISOString() },
      {}, // 途中に混ざった記録なし
      { at: new Date(2026, 7, 26, 10, 0, 0).toISOString() },
    ], NOW)
    expect(marks[0]).toEqual({ kind: 'date', label: '今日' })
    expect(marks[1]).toEqual({ kind: 'none' })
    expect(marks[2]).toEqual({ kind: 'none' })
  })

  it('壊れた at（こわれた）でも落ちない・at 無しと同じ扱い', () => {
    expect(() => timelineMarks([{ at: 'こわれた' }, { at: 'こわれた' }], NOW)).not.toThrow()
    const marks = timelineMarks([{ at: 'こわれた' }, { at: 'こわれた' }], NOW)
    expect(marks).toEqual<TimelineMark[]>([{ kind: 'none' }, { kind: 'none' }])
    // 壊れたものの次に正しいものが来たら、そこが境目
    const mixed = timelineMarks([{ at: 'こわれた' }, { at: new Date(2026, 7, 26, 12, 0, 0).toISOString() }], NOW)
    expect(mixed[1]).toEqual({ kind: 'unknown', label: '今日' })
  })

  it('空配列なら空配列', () => {
    expect(timelineMarks([], NOW)).toEqual([])
  })
})

describe('ラベルの作り方（今日・昨日・同じ年・去年）', () => {
  it('今日', () => {
    const marks = timelineMarks([{ at: new Date(2026, 7, 26, 15, 30, 0).toISOString() }], NOW)
    expect(marks[0]).toEqual({ kind: 'date', label: '今日' })
  })

  it('昨日', () => {
    const marks = timelineMarks([{ at: new Date(2026, 7, 25, 9, 0, 0).toISOString() }], NOW)
    expect(marks[0]).toEqual({ kind: 'date', label: '昨日' })
  })

  it('それ以外で同じ年 → 月日と曜日のみ', () => {
    // 2026-08-20 は木曜日
    const marks = timelineMarks([{ at: new Date(2026, 7, 20, 12, 0, 0).toISOString() }], NOW)
    expect(marks[0]).toEqual({ kind: 'date', label: '8月20日（木）' })
  })

  it('去年以前 → 年から出す', () => {
    // 2025-08-20 は水曜日
    const marks = timelineMarks([{ at: new Date(2025, 7, 20, 12, 0, 0).toISOString() }], NOW)
    expect(marks[0]).toEqual({ kind: 'date', label: '2025年8月20日（水）' })
  })
})

describe('stamp（新しいメッセージにだけ時刻を入れる）', () => {
  it('at が無ければ入れる', () => {
    const out = stamp({ role: 'user', content: 'こんにちは' } as any, NOW)
    expect(out.at).toBe(NOW.toISOString())
  })

  it('既に at があるものを上書きしない', () => {
    const original = { role: 'user', content: 'こんにちは', at: '2020-01-01T00:00:00.000Z' } as any
    const out = stamp(original, NOW)
    expect(out.at).toBe('2020-01-01T00:00:00.000Z')
    expect(out).toBe(original) // 触っていなければ同じ参照のはず
  })

  it('now を省略しても落ちない（既定値を使う）', () => {
    const out = stamp({ role: 'user', content: 'x' } as any)
    expect(typeof out.at).toBe('string')
  })
})

describe('bubbleTime（吹き出しに触れたときの文字列）', () => {
  it('at が無ければ null', () => {
    expect(bubbleTime(undefined)).toBeNull()
  })

  it('壊れた at でも落ちない・null を返す', () => {
    expect(bubbleTime('こわれた')).toBeNull()
  })

  // **日付は付けない。** すぐ上の区切りが日付を持っているので、ここは時刻だけでよい。
  it('時刻だけを返す（日付はすぐ上の区切りが持っている）', () => {
    const at = new Date(2026, 7, 21, 13, 57, 0).toISOString()
    expect(bubbleTime(at)).toBe('13:57')
    expect(bubbleTime(at)).not.toContain('年')
  })

  it('1桁の時・分もゼロ埋めする', () => {
    expect(bubbleTime(new Date(2026, 7, 21, 9, 5, 0).toISOString())).toBe('09:05')
  })
})

// ── 配線（画面は import できないのでソースを読んで固定。掟10）──────────────
describe('配線: 画面・保存経路がそれぞれ正しい判定を通している', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')

  it('ChatPanel.tsx が timelineMarks / bubbleTime を呼んでいる', () => {
    const s = read('src/renderer/components/ChatPanel.tsx')
    expect(s).toContain('timelineMarks(')
    expect(s).toContain('bubbleTime(')
  })

  // ⚠️ **OS のツールチップ（title）は使わない**（2026-08-26 Ryosuke 実機報告）。
  // 「非常にシビアなのか1度表示されましたが、その後表示できませんでした」——
  // 出るまでに間があり、少し動かすと消える。**触れたら吹き出しの下にすっと出す。**
  // 境目では2本（記録なしの断り＋日付）を出す。**片方だけ直さない。**
  it('境目では、断りと日付の2本を出す（2画面とも）', () => {
    for (const f of [
      'src/renderer/components/ChatPanel.tsx',
      'src/renderer/components/ChatApp.tsx',
    ]) {
      const s = read(f)
      expect(s, f).toContain("{line('日時の記録がありません', `u-${i}`)}{line(mark.label, `d-${i}`)}")
    }
  })

  it('時刻は title ではなく、触れたら吹き出しの下に出す（2画面とも）', () => {
    for (const f of [
      'src/renderer/components/ChatPanel.tsx',
      'src/renderer/components/ChatApp.tsx',
    ]) {
      const s = read(f)
      // 直す前の形（OS のツールチップ）に戻していないこと
      expect(s, f).not.toContain('title={bubbleTime')
      expect(s, f).not.toContain('bubbleTitle')
      // ⚠️ `opacity-0 group-hover:opacity-100` だけを見てはいけない——
      // **コピーボタンにも同じ指定がある**（実際にミューテーションで素通りした・掟10）。
      // 時刻の要素だけを一意に指す。
      expect(s, f).toContain('mt-0.5 px-1 text-[11px] text-ink-muted opacity-0 group-hover:opacity-100 transition-opacity')
      // **出す条件**も押さえる（中身だけ見ると、条件を潰しても通る）
      expect(s, f).toContain('{bubbleTime(msg.at) && (')
      expect(s, f).toContain('{bubbleTime(msg.at)}')
    }
  })

  it('ChatApp.tsx が timelineMarks / bubbleTime を呼んでいる', () => {
    const s = read('src/renderer/components/ChatApp.tsx')
    expect(s).toContain('timelineMarks(')
    expect(s).toContain('bubbleTime(')
  })

  // ⚠️ B'-2（2026-08-27）で stamp( の呼び出しは src/shared/chatEvents.ts の applyToMessages に
  // 一元化された（useAiChat.ts は emit( を通すだけになった）。以下の3件は、その2段（emit → 一元化された
  // stamp）が実際につながっていることを固定する（詳しい振る舞いの一致は tests/chatEvents.test.ts）。
  it('appendBubble が emit( を通っている（stamp は chatEvents.ts の applyToMessages に一元化された）', () => {
    const s = read('src/renderer/hooks/useAiChat.ts')
    expect(s).toContain("const appendBubble = useCallback((msg: ChatMessage) => emit({ kind: 'append', msg }), [emit])")
    const events = read('src/shared/chatEvents.ts')
    expect(events).toContain('return [...prev, stamp(ev.msg, now)]')
  })

  it('replaceLast が emit( を通っている（stamp は chatEvents.ts の applyToMessages に一元化された）', () => {
    const s = read('src/renderer/hooks/useAiChat.ts')
    expect(s).toContain("const replaceLast = useCallback((msg: ChatMessage) => emit({ kind: 'replaceLast', msg }), [emit])")
    const events = read('src/shared/chatEvents.ts')
    expect(events).toContain('next[next.length - 1] = stamp(ev.msg, now)')
  })

  it('利用上限で区切るときのユーザー吹き出し・案内の2件とも emit( の append を通っている', () => {
    const s = read('src/renderer/hooks/useAiChat.ts')
    expect(s).toContain("emit({ kind: 'append', msg: userMsg })")
    expect(s).toContain("emit({ kind: 'append', msg: budgetMsg })")
  })

  it('chatStorage.ts に stamp( が入っていない（古い会話に時刻を付けない）', () => {
    const s = read('src/renderer/chatStorage.ts')
    expect(s).not.toContain('stamp(')
  })
})
