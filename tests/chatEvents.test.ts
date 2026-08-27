import { describe, it, expect, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { applyToMessages, applyEvent, applyEvents, emptyView, type ChatEvent, type ChatView } from '../src/shared/chatEvents'
import { stamp } from '../src/shared/chatTime'

// B'-2: 画面への指示を「出来事（ChatEvent）」に変える。
//
// ── なぜ（useAiChat.ts のコメントより）─────────────────────────────
// いまは AI の実行ループの中から React の setState を直接呼んで画面を変えている。
// これを「出来事を出す」→「純粋な関数が画面の状態に当てる」の2段にする。
// このあと（B'-3）実行ループを main へ移すとき、「画面がどう変わるか」を決める
// このコードが移す前と移した後で literally 同じものであれば、
// 「見かけが変わらない」ことが構造で保証される。

type Msg = { id: number; at?: string }

const NOW = new Date(2026, 7, 27, 10, 0, 0) // 2026-08-27（木）10:00

describe('applyToMessages', () => {
  it('append: 空に足す', () => {
    const next = applyToMessages<Msg>([], { kind: 'append', msg: { id: 1 } }, NOW)
    expect(next).toEqual([{ id: 1, at: NOW.toISOString() }])
  })

  it('append: 末尾に足す', () => {
    const prev: Msg[] = [{ id: 1, at: '2026-08-01T00:00:00.000Z' }]
    const next = applyToMessages(prev, { kind: 'append', msg: { id: 2 } }, NOW)
    expect(next).toEqual([
      { id: 1, at: '2026-08-01T00:00:00.000Z' },
      { id: 2, at: NOW.toISOString() },
    ])
  })

  it('append: at が無いメッセージには now の時刻が入る', () => {
    const next = applyToMessages<Msg>([], { kind: 'append', msg: { id: 1 } }, NOW)
    expect(next[0].at).toBe(NOW.toISOString())
  })

  // stamp() は既に at があるメッセージを上書きしない（chatTime.ts）。その性質をそのまま使う。
  it('append: at が既にあるメッセージは上書きされない', () => {
    const original = '2020-01-01T00:00:00.000Z'
    const next = applyToMessages<Msg>([], { kind: 'append', msg: { id: 1, at: original } }, NOW)
    expect(next[0].at).toBe(original)
  })

  it('replaceLast: 末尾が差し替わる。それ以外の要素は同一参照のまま', () => {
    const first: Msg = { id: 1, at: '2026-08-01T00:00:00.000Z' }
    const prev: Msg[] = [first, { id: 2, at: '2026-08-02T00:00:00.000Z' }]
    const next = applyToMessages(prev, { kind: 'replaceLast', msg: { id: 3 } }, NOW)
    expect(next[0]).toBe(first) // それ以外の要素は同一参照のまま
    expect(next[1]).toEqual({ id: 3, at: NOW.toISOString() })
  })

  // 元の実装は空配列に対して next[-1] = ... を行い、これは配列の要素ではなく
  // "-1" という名前の属性を作るだけで、長さは0のまま・観測できる振る舞いは「何も起きない」。
  // ただし新しい配列は返す（[...prev]）ので React は再描画する。
  it('replaceLast: 空配列のときは何も起きない（長さ0のまま）が、prev とは別の配列が返る', () => {
    const prev: Msg[] = []
    const next = applyToMessages(prev, { kind: 'replaceLast', msg: { id: 1 } }, NOW)
    expect(next).toEqual([])
    expect(next).not.toBe(prev)
  })

  it('removeLast: 1件減る', () => {
    const prev: Msg[] = [{ id: 1 }, { id: 2 }]
    const next = applyToMessages(prev, { kind: 'removeLast' }, NOW)
    expect(next).toEqual([{ id: 1 }])
  })

  it('removeLast: 空配列なら空配列', () => {
    const next = applyToMessages<Msg>([], { kind: 'removeLast' }, NOW)
    expect(next).toEqual([])
  })

  it('loading / status / routed: prev がそのまま返る（同一参照）', () => {
    const prev: Msg[] = [{ id: 1 }]
    expect(applyToMessages(prev, { kind: 'loading', value: true }, NOW)).toBe(prev)
    expect(applyToMessages(prev, { kind: 'status', value: 'x' }, NOW)).toBe(prev)
    expect(applyToMessages(prev, { kind: 'routed', value: 'model' }, NOW)).toBe(prev)
  })
})

describe('applyEvent / applyEvents', () => {
  it('loading を当てると isLoading だけ変わり、messages は同一参照', () => {
    const view = emptyView<Msg>()
    const next = applyEvent(view, { kind: 'loading', value: true }, NOW)
    expect(next.isLoading).toBe(true)
    expect(next.messages).toBe(view.messages)
    expect(next.statusNote).toBe(view.statusNote)
    expect(next.routedModel).toBe(view.routedModel)
    // true 固定に取り違えていないか（ev.value を実際に見ているか）を false 側でも確かめる
    const loadingView: ChatView<Msg> = { ...view, isLoading: true }
    expect(applyEvent(loadingView, { kind: 'loading', value: false }, NOW).isLoading).toBe(false)
  })

  it('status も同様（messages は同一参照）', () => {
    const view = emptyView<Msg>()
    const next = applyEvent(view, { kind: 'status', value: '🔍 検索中…' }, NOW)
    expect(next.statusNote).toBe('🔍 検索中…')
    expect(next.messages).toBe(view.messages)
  })

  it('routed も同様（messages は同一参照）', () => {
    const view = emptyView<Msg>()
    const next = applyEvent(view, { kind: 'routed', value: 'qwen3-coder' }, NOW)
    expect(next.routedModel).toBe('qwen3-coder')
    expect(next.messages).toBe(view.messages)
  })

  it('append を当てると messages だけ変わり、isLoading などは据え置き', () => {
    const view: ChatView<Msg> = { messages: [], isLoading: true, statusNote: '進行中', routedModel: 'x' }
    const next = applyEvent(view, { kind: 'append', msg: { id: 1 } }, NOW)
    expect(next.messages).toEqual([{ id: 1, at: NOW.toISOString() }])
    expect(next.isLoading).toBe(true)
    expect(next.statusNote).toBe('進行中')
    expect(next.routedModel).toBe('x')
  })

  it('常に新しいオブジェクトが返る', () => {
    const view = emptyView<Msg>()
    const next = applyEvent(view, { kind: 'loading', value: false }, NOW)
    expect(next).not.toBe(view)
  })

  it('applyEvents で複数を順に当てられる', () => {
    const view = emptyView<Msg>()
    const evs: ChatEvent<Msg>[] = [
      { kind: 'append', msg: { id: 1 } },
      { kind: 'loading', value: true },
      { kind: 'append', msg: { id: 2 } },
      { kind: 'loading', value: false },
      { kind: 'status', value: '完了' },
    ]
    const next = applyEvents(view, evs, NOW)
    expect(next.messages).toEqual([
      { id: 1, at: NOW.toISOString() },
      { id: 2, at: NOW.toISOString() },
    ])
    expect(next.isLoading).toBe(false)
    expect(next.statusNote).toBe('完了')
  })

  it('emptyView() の中身', () => {
    expect(emptyView<Msg>()).toEqual({ messages: [], isLoading: false, statusNote: '', routedModel: null })
  })
})

// ── いまの振る舞いとの一致（ここが本題）─────────────────────────────
// useAiChat.ts:142-148 の 2026-08-27 時点の実装（これと一致し続けることを固定する）。
// これを書き写しておき、applyToMessages と同じ入力に対して結果が一致することを直接ぶつけて確かめる。
const oldAppend = (prev: Msg[], msg: Msg): Msg[] => [...prev, stamp(msg)]
const oldReplaceLast = (prev: Msg[], msg: Msg): Msg[] => {
  const next = [...prev]
  next[next.length - 1] = stamp(msg)
  return next
}
const oldRemoveLast = (prev: Msg[]): Msg[] => prev.slice(0, -1)

describe('いまの3つのヘルパーとの一致（空・1件・3件）', () => {
  // stamp() は引数無しで new Date() を使うため、比較の間だけ時刻を止める（同じ瞬間として比べる）。
  const withFrozenClock = (fn: () => void) => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(NOW)
      fn()
    } finally {
      vi.useRealTimers()
    }
  }

  const cases: Msg[][] = [
    [],
    [{ id: 1, at: '2026-08-01T00:00:00.000Z' }],
    [
      { id: 1, at: '2026-08-01T00:00:00.000Z' },
      { id: 2, at: '2026-08-02T00:00:00.000Z' },
      { id: 3, at: '2026-08-03T00:00:00.000Z' },
    ],
  ]

  it('append', () => {
    withFrozenClock(() => {
      for (const prev of cases) {
        const msg: Msg = { id: 99 }
        expect(applyToMessages(prev, { kind: 'append', msg })).toEqual(oldAppend(prev, msg))
      }
    })
  })

  it('replaceLast', () => {
    withFrozenClock(() => {
      for (const prev of cases) {
        const msg: Msg = { id: 99 }
        const actual = applyToMessages(prev, { kind: 'replaceLast', msg })
        const old = oldReplaceLast(prev, msg)
        // prev が空のとき、元の実装は next[-1] = ... により配列の要素ではなく
        // "-1" という名前の属性を作るだけ（toEqual の深い比較ではこの属性差が出てしまう）。
        // 観測できる振る舞い（= 要素として反復・直列化されるもの）だけを比べる。
        expect(Array.from(actual)).toEqual(Array.from(old))
        expect(actual.length).toBe(old.length)
      }
    })
  })

  it('removeLast', () => {
    for (const prev of cases) {
      expect(applyToMessages(prev, { kind: 'removeLast' })).toEqual(oldRemoveLast(prev))
    }
  })
})

// ── 配線（useAiChat.ts が emit だけを通ること。掟10）───────────────────
//
// ⚠️ コメントを外してから判定する（adoptAppRun.test.ts / syncPublic.test.ts の前例と同じ流儀。
// 2026-08-20 に自分の説明コメントにテストが当たって落ちた事故があるため）。
const readCode = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*')
    })
    .join('\n')

describe('useAiChat.ts の配線（emit だけが画面に触る）', () => {
  it('emit の定義の中を除いて setIsLoading( / setStatusNote( / setRoutedModel( / updateShown( が出てこない', () => {
    const src = readCode('src/renderer/hooks/useAiChat.ts')
    // emit の定義（const emit = useCallback(... }, [updateShown]) まで）を取り除いた残りを見る。
    const emitStart = src.indexOf('const emit = useCallback(')
    expect(emitStart).toBeGreaterThan(-1)
    const afterEmitStart = src.indexOf('[updateShown])', emitStart)
    expect(afterEmitStart).toBeGreaterThan(-1)
    const rest = src.slice(0, emitStart) + src.slice(afterEmitStart + '[updateShown])'.length)
    expect(rest).not.toContain('setIsLoading(')
    expect(rest).not.toContain('setStatusNote(')
    expect(rest).not.toContain('setRoutedModel(')
    expect(rest).not.toContain('updateShown(')
  })
})
