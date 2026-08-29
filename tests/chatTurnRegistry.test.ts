import { describe, it, expect, beforeEach } from 'vitest'
import {
  CHAT_APP_KEY, turnKey, getTurn, updateTurn, resetTurn, isAnyLoading, loadingKeys,
  subscribe, getSnapshot,
} from '../src/renderer/chatTurnRegistry'

// chatTurnRegistry.ts — 実行状態（isLoading・statusNote・routedModel・⏹・入力欄のロック）を
// プロジェクト別に持つ置き場（B-1b）。React 非依存の純粋ロジックなので node で検証できる。
//
// ── なぜこのテストが要るか ─────────────────────────────────────────
// この置き場は「別プロジェクトの実行状態が互いに漏れないこと」がすべて（漏れると B-1b が
// 直そうとしているバグそのものが再発する）。鍵ごとの独立・通知・resetTurn の中身・
// loadingKeys の絞り込みを固定する。

// モジュールレベルの Map を使うため、テスト間で状態が残らないよう毎回別の鍵を使う
// （beforeEach でモジュールをリセットする口は無いため、鍵をユニークにして隔離する）。
let seq = 0
const freshKey = (label: string) => `/test/${label}-${++seq}`

describe('turnKey', () => {
  it('projectDir をそのまま鍵にする', () => {
    expect(turnKey('/Users/x/project')).toBe('/Users/x/project')
  })

  it('null / undefined は単独チャットの鍵になる（sessionId も無ければ CHAT_APP_KEY）', () => {
    expect(turnKey(null)).toBe(CHAT_APP_KEY)
    expect(turnKey(undefined)).toBe(CHAT_APP_KEY)
  })

  // projectDir は必ず絶対パス（'/' 始まり）。CHAT_APP_KEY が '/' 始まりだと、
  // 万一どこかのプロジェクトパスと衝突しうる。衝突しない文字列であることを固定する。
  it('CHAT_APP_KEY はプロジェクトの絶対パス（\'/\' 始まり）と衝突しない', () => {
    expect(CHAT_APP_KEY.startsWith('/')).toBe(false)
  })

  // ── 改善2（2026-08-29）: 単独チャット（ChatApp）のセッション別の鍵 ──────────────
  // 仕様書のテスト4をそのまま固定する。
  describe('sessionId（単独チャットのセッション別化）', () => {
    it('projectDir が無く sessionId があれば `@chat-app:<sessionId>`', () => {
      expect(turnKey(null, 'abc')).toBe('@chat-app:abc')
      expect(turnKey(null, 'abc')).toBe(`${CHAT_APP_KEY}:abc`)
    })

    it('projectDir があれば、sessionId があってもプロジェクトを優先する', () => {
      expect(turnKey('/p', 'abc')).toBe('/p')
    })

    it('どちらも無ければ従来どおり CHAT_APP_KEY', () => {
      expect(turnKey(null)).toBe(CHAT_APP_KEY)
    })

    it('sessionId が違えば別の鍵になる（セッション別に独立する）', () => {
      expect(turnKey(null, 'a')).not.toBe(turnKey(null, 'b'))
    })

    it('sessionId が空文字なら CHAT_APP_KEY へ落ちる（空鍵を作らない）', () => {
      expect(turnKey(null, '')).toBe(CHAT_APP_KEY)
    })
  })
})

describe('getTurn', () => {
  it('未登録の鍵はアイドルの既定値を返す', () => {
    const t = getTurn(freshKey('idle'))
    expect(t).toEqual({
      isLoading: false, statusNote: '', routedModel: null,
      startedAt: null, lastActivityAt: 0, abort: null, attention: null,
    })
  })

  // ── B-2: 「見てほしい」合図（⚠️） ──────────────────────────────────────
  // attention は未登録の鍵では null（＝アイドルの既定値。IDLE に含まれる）。
  it('未登録の鍵は attention も null', () => {
    expect(getTurn(freshKey('idle-attention')).attention).toBeNull()
  })
})

describe('updateTurn: 鍵ごとの独立', () => {
  it('ある鍵への書き換えは、別の鍵に影響しない', () => {
    const a = freshKey('a')
    const b = freshKey('b')
    updateTurn(a, { isLoading: true, statusNote: '🔍 検索中…' })
    expect(getTurn(a).isLoading).toBe(true)
    expect(getTurn(a).statusNote).toBe('🔍 検索中…')
    // b は触っていないのでアイドルのまま（＝これが B-1b の本題: 別プロジェクトへ漏れない）
    expect(getTurn(b).isLoading).toBe(false)
    expect(getTurn(b).statusNote).toBe('')
  })

  it('patch は部分更新（渡していない項目は保持される）', () => {
    const k = freshKey('partial')
    updateTurn(k, { isLoading: true, routedModel: 'qwen3-coder' })
    updateTurn(k, { statusNote: '📚 資料を確認しています…' })
    const t = getTurn(k)
    expect(t.isLoading).toBe(true) // 消えていない
    expect(t.routedModel).toBe('qwen3-coder') // 消えていない
    expect(t.statusNote).toBe('📚 資料を確認しています…')
  })

  // ── B-2: 「見てほしい」合図（⚠️） ──────────────────────────────────────
  it('updateTurn で attention を \'approval\' に設定できる', () => {
    const k = freshKey('attention-approval')
    updateTurn(k, { attention: 'approval' })
    expect(getTurn(k).attention).toBe('approval')
  })

  it('updateTurn で attention を \'error\' に設定できる', () => {
    const k = freshKey('attention-error')
    updateTurn(k, { attention: 'error' })
    expect(getTurn(k).attention).toBe('error')
  })
})

describe('resetTurn', () => {
  it('isLoading・statusNote・startedAt・abort をアイドルへ戻す', () => {
    const k = freshKey('reset')
    const abortFn = () => {}
    updateTurn(k, { isLoading: true, statusNote: '考えています…', startedAt: 12345, lastActivityAt: 12345, abort: abortFn })
    resetTurn(k)
    const t = getTurn(k)
    expect(t.isLoading).toBe(false)
    expect(t.statusNote).toBe('')
    expect(t.startedAt).toBeNull()
    expect(t.abort).toBeNull()
  })

  // ── なぜ routedModel だけ引き継ぐか（chatTurnRegistry.ts のコメント参照）───────────
  // routedModel は「会話ごとに維持」が本来の意味。ターンが終わるたびに消えると、
  // 次のメッセージでまた同じ再割り振りが起きてしまう。
  it('routedModel だけは引き継ぐ（会話ごとに維持するため）', () => {
    const k = freshKey('keep-routed')
    updateTurn(k, { isLoading: true, routedModel: 'qwen3-coder' })
    resetTurn(k)
    const t = getTurn(k)
    expect(t.isLoading).toBe(false)
    expect(t.routedModel).toBe('qwen3-coder')
  })

  it('未登録の鍵に対しても安全（アイドルのまま）', () => {
    const k = freshKey('reset-idle')
    resetTurn(k)
    expect(getTurn(k)).toEqual(getTurn(freshKey('never-touched')))
  })

  // ── B-2: attention は 'error' だけ引き継ぐ・'approval' は消える ──────────────
  // 'error' はターンの結果（見ていなければ知らせ続ける必要がある）、'approval' はそのターンの
  // 最中だけの状態（ダイアログが閉じれば一緒に消えるのが正しい）。chatTurnRegistry.ts のコメント参照。
  it('resetTurn は attention が \'error\' のときは残す', () => {
    const k = freshKey('reset-attention-error')
    updateTurn(k, { isLoading: true, attention: 'error' })
    resetTurn(k)
    expect(getTurn(k).attention).toBe('error')
  })

  it('resetTurn は attention が \'approval\' のときは消す', () => {
    const k = freshKey('reset-attention-approval')
    updateTurn(k, { isLoading: true, attention: 'approval' })
    resetTurn(k)
    expect(getTurn(k).attention).toBeNull()
  })

  it('resetTurn しても routedModel は従来どおり残る（attention の追加で崩れていないこと）', () => {
    const k = freshKey('reset-attention-routed')
    updateTurn(k, { isLoading: true, routedModel: 'qwen3-coder', attention: 'error' })
    resetTurn(k)
    const t = getTurn(k)
    expect(t.routedModel).toBe('qwen3-coder')
    expect(t.attention).toBe('error')
  })
})

describe('loadingKeys / isAnyLoading', () => {
  it('isLoading な鍵だけを返す（全鍵ではない）', () => {
    const loading = freshKey('loading')
    const idle = freshKey('idle2')
    updateTurn(loading, { isLoading: true })
    updateTurn(idle, { statusNote: 'まだ実行中ではない' }) // isLoading は立てない
    const keys = loadingKeys()
    expect(keys).toContain(loading)
    expect(keys).not.toContain(idle)
  })

  it('1件も実行中でなければ空配列', () => {
    const k = freshKey('none-loading')
    updateTurn(k, { statusNote: 'x' })
    // 他のテストが別の鍵を loading のまま残している可能性があるため、
    // 「この鍵が含まれないこと」だけを見る（全体が空とは限らない＝隔離のため freshKey を使う）。
    expect(loadingKeys()).not.toContain(k)
  })

  it('isAnyLoading はどれか1つでも実行中なら true', () => {
    const k = freshKey('any-loading')
    expect(getTurn(k).isLoading).toBe(false)
    updateTurn(k, { isLoading: true })
    expect(isAnyLoading()).toBe(true)
  })
})

describe('subscribe / getSnapshot', () => {
  it('updateTurn のたびに listener が呼ばれ、版数が増える', () => {
    const k = freshKey('subscribe')
    let calls = 0
    const before = getSnapshot()
    const unsubscribe = subscribe(() => { calls++ })
    updateTurn(k, { isLoading: true })
    expect(calls).toBe(1)
    expect(getSnapshot()).toBeGreaterThan(before)
    updateTurn(k, { isLoading: false })
    expect(calls).toBe(2)
    unsubscribe()
    updateTurn(k, { isLoading: true })
    expect(calls).toBe(2) // 解除後は呼ばれない
  })

  it('resetTurn も listener を呼ぶ', () => {
    const k = freshKey('subscribe-reset')
    updateTurn(k, { isLoading: true })
    let calls = 0
    const unsubscribe = subscribe(() => { calls++ })
    resetTurn(k)
    expect(calls).toBe(1)
    unsubscribe()
  })

  it('複数の listener を同時に購読できる', () => {
    const k = freshKey('subscribe-multi')
    let a = 0
    let b = 0
    const unsubA = subscribe(() => { a++ })
    const unsubB = subscribe(() => { b++ })
    updateTurn(k, { isLoading: true })
    expect(a).toBe(1)
    expect(b).toBe(1)
    unsubA()
    unsubB()
  })

  // 2026-08-28: lastActivityAt はトークンごとに更新される。通知すると購読者（Sidebar 等）が
  // 毎トークン再描画されるため、これ**だけ**の更新は通知しない（停滞判定はポーリングで読む）。
  it('lastActivityAt だけの更新は listener に通知しない（毎トークンの再描画を防ぐ）', () => {
    let calls = 0
    const un = subscribe(() => { calls++ })
    updateTurn('/p', { lastActivityAt: Date.now() })
    expect(calls).toBe(0)
    updateTurn('/p', { isLoading: true, lastActivityAt: Date.now() })
    expect(calls).toBe(1)
    un()
  })

  // ── B-2: attention の変更で listener が呼ばれる（Sidebar・ChatApp の再描画に必要） ──────
  it('attention の変更で listener が呼ばれる', () => {
    const k = freshKey('subscribe-attention')
    let calls = 0
    const un = subscribe(() => { calls++ })
    updateTurn(k, { attention: 'approval' })
    expect(calls).toBe(1)
    updateTurn(k, { attention: null })
    expect(calls).toBe(2)
    un()
  })

})
