// chatEvents.ts — 画面への指示を「出来事（ChatEvent）」として表す純粋ロジック（React/DOM/electron 非依存）。
//
// ── なぜ（B'-2）───────────────────────────────────────────────
// useAiChat.ts は、AI の実行ループの中から React の setState を直接呼んで画面を変えている。
// これを「出来事を出す」→「純粋な関数が画面の状態に当てる」の2段に分ける。
// このあと（B'-3）実行ループを main へ移すとき、**「画面がどう変わるか」を決めるこのコードが、
// 移す前と移した後で literally 同じもの**であれば、「見かけが変わらない」ことが構造で保証される。
//
// chatTime.ts と同じく、メッセージの型は generic にする（shared/ から renderer の型を import しないため。
// `stamp<T extends { at?: string }>` の前例に合わせる）。

import { stamp } from './chatTime'

export type ChatEvent<M> =
  | { kind: 'append'; msg: M }        // 末尾に足す
  | { kind: 'replaceLast'; msg: M }   // 末尾を差し替える
  | { kind: 'removeLast' }            // 末尾を落とす
  | { kind: 'loading'; value: boolean }
  | { kind: 'status'; value: string }
  | { kind: 'routed'; value: string | null }

/**
 * 出来事を「メッセージ列」に当てる（メッセージに関係しない出来事なら prev をそのまま返す）。
 *
 * いまの3つのヘルパー（useAiChat.ts:142-148 の appendBubble/replaceLast/removeLast）と
 * **一字一句同じ振る舞い**にする。
 *
 * - `append` … `[...prev, stamp(msg, now)]`
 * - `replaceLast` … `prev` が**空のときは何も起きない**（元の実装は空配列に対して
 *   `next[-1] = ...` を行っており、これは配列の要素ではなく `"-1"` という名前の**属性**を
 *   作るだけで、長さは 0 のまま・画面にも保存にも出ない＝観測できる振る舞いは「何も起きない」）。
 *   ただし**新しい配列は返す**（`[...prev]`）ので React は再描画する。ここも合わせる。
 * - `removeLast` … `prev.slice(0, -1)`（空配列なら空配列）
 * - `loading` / `status` / `routed` … `prev` を**そのまま**返す（同一参照）
 */
export function applyToMessages<M extends { at?: string }>(
  prev: M[], ev: ChatEvent<M>, now?: Date
): M[] {
  switch (ev.kind) {
    case 'append':
      return [...prev, stamp(ev.msg, now)]
    case 'replaceLast': {
      if (prev.length === 0) return [...prev]
      const next = [...prev]
      next[next.length - 1] = stamp(ev.msg, now)
      return next
    }
    case 'removeLast':
      return prev.slice(0, -1)
    default:
      return prev
  }
}

/** 画面の状態まるごと。B'-3 で main が持つことになる形。 */
export type ChatView<M> = {
  messages: M[]
  isLoading: boolean
  statusNote: string
  routedModel: string | null
}

export function emptyView<M>(): ChatView<M> {
  return { messages: [], isLoading: false, statusNote: '', routedModel: null }
}

/**
 * 出来事を画面の状態に当てる。
 *
 * - `append` / `replaceLast` / `removeLast` … `messages` だけ差し替える（ほかは据え置き）
 * - `loading` / `status` / `routed` … 対応する1つだけ差し替える（`messages` は同一参照のまま）
 * - 常に**新しいオブジェクト**を返す
 */
export function applyEvent<M extends { at?: string }>(
  view: ChatView<M>, ev: ChatEvent<M>, now?: Date
): ChatView<M> {
  switch (ev.kind) {
    case 'append':
    case 'replaceLast':
    case 'removeLast':
      return { ...view, messages: applyToMessages(view.messages, ev, now) }
    case 'loading':
      return { ...view, isLoading: ev.value }
    case 'status':
      return { ...view, statusNote: ev.value }
    case 'routed':
      return { ...view, routedModel: ev.value }
  }
}

/** まとめて当てる。 */
export function applyEvents<M extends { at?: string }>(
  view: ChatView<M>, evs: ChatEvent<M>[], now?: Date
): ChatView<M> {
  return evs.reduce((v, ev) => applyEvent(v, ev, now), view)
}

// ── B-1a: 画面の更新を「main のストアからの押し出し」1本にする ─────────────────────
//
// main（convStore.ts）が会話を1件当てるたびに、画面（ChatPanel.tsx）へ
// { projectDir, op, length }（当てた op と、当てた直後の件数）を通知する。画面はそれを
// 「いま見ているプロジェクトの分だけ」写し（React state）に当てる。この判定を純粋関数に
// 切り出すのは、useAiChat.ts と同じ理由（B'-2）: 「画面がどう変わるか」を決めるコードを
// テストで固定できるようにするため。

/** convStore.ts の Op と同じ形（会話への書き換え1件）。shared からは main/renderer どちらの
 *  型も import しないため、ここで同じ形を定義する（main/renderer 側の Op はこれと構造的に同じ）。 */
export type ViewSyncOp<M> = ChatEvent<M> | { kind: 'replaceAll'; messages: M[] }

/**
 * main のストアが1件当てた通知（op と、当てた直後の件数）を、画面の写しにそのまま
 * 当ててよいか、ストアから読み直すべきかを決める。
 *
 * 画面の写しがストアと同期していれば、op を当てた結果の件数は storeLength に一致するはず
 * （append なら写し+1、replaceLast なら写しのまま、removeLast なら写し-1）。一致しない＝
 * どこかで取りこぼした（切替直後の読み込みと押し出しのすれ違い等）＝ストアから読み直して
 * 自己修復する。replaceAll は丸ごと来るので写しの状態に依らず常に当てられる。
 */
export function viewSyncDecision<M>(
  op: ViewSyncOp<M>, viewLength: number, storeLength: number,
): 'apply' | 'reload' {
  switch (op.kind) {
    case 'append': return viewLength === storeLength - 1 ? 'apply' : 'reload'
    case 'replaceLast': return viewLength === storeLength ? 'apply' : 'reload'
    case 'removeLast': return viewLength === storeLength + 1 ? 'apply' : 'reload'
    case 'replaceAll': return 'apply'
    // loading/status/routed はここへは来ない想定（convStore の Op に含まれない書き換え）。
    // 網羅のためだけに残す＝length に関係しないので当てて問題ない。
    default: return 'apply'
  }
}
