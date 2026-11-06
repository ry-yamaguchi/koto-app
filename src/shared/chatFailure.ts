// chatFailure.ts — 失敗の吹き出しを作る唯一の場所（純粋ロジック）。
//
// ── なぜ要るか（0.6.26）────────────────────────────────────────────
// 失敗・時間切れ・画像の読み取りの失敗で出す吹き出しは、これまで chatTurn.ts のあちこちが
// 手で組み立てていた。「もう一度送る」ボタンを出す印（offerRetry）を付ける場所が散らばると、
// 1か所だけ付け忘れても誰も気づかない（掟10）。そこで、吹き出しの形をここに集める。
//
// ・**印だけを持たせる。** 送り直す材料（直前の依頼の文と画像）は吹き出しに入れない。
//   画像のデータ URL を会話の保存に二重に入れないため。押した時点の会話から取り出す。
// ・**表示専用にする（toolNote は必ず付く）。** 失敗の文は利用者に見せるもので、AI の発言ではない。
//   履歴に入れると、次の送信でエラー文がそのまま AI へ届き、AI がそれを自分の発言として引き継ぐ。
//   toolNote の吹き出しは historyCompact.ts の bodyMessages が送信の対象から外す。
//   **だから失敗の吹き出しに入れるのは、Koto が書いた失敗の文だけ。** 応答の途中で時間切れになったときも、
//   AI が途中まで書いた本文は AI の発言として別の吹き出しに残す（chatTurn.ts の streamOnce）。
// ・**投げて中身が空のときは、足しておいた空の吹き出しを取り除く。** 空の assistant が履歴に
//   残ると次の送信でそのまま送られ、サーバーによっては拒まれる（undoEmptyBubble）。
// ・**印を付けるのは失敗の吹き出しだけ。** 上限に達した案内（🛑）・ツールの失敗の注記・
//   ⏹ 停止・「続ける」の案内には付けない（それぞれ別の出口がある）。
// ・**想定外の失敗の出口は、会話に何が残っているかを見て足りないものだけを足す**
//   （unexpectedFailureAppends）。利用者の依頼の吹き出しは runEngineTurn の中で初めて会話に入るので、
//   それより前に失敗した回は、依頼もここで足す。足さないと、会話に今回の依頼が無いまま
//   「もう一度送る」だけが残り、1つ前の依頼を送り直してしまう。
// ・書き主が誰でも（main のループ・画面側の送信）同じ形になるよう、ここは electron にも
//   React にも依存しない。

/** 失敗の吹き出し。TurnMessage（shared/chatTurn.ts）・画面側の ChatMessage の両方へそのまま渡せる形。 */
export type FailureBubble = {
  role: 'assistant'
  content: string
  /** 「もう一度送る」ボタンを出す印。会話の保存に残る。 */
  offerRetry: true
  /** 表示専用（AIへは送らない）。失敗の吹き出しには必ず付く。 */
  toolNote: true
  /** 推論モデルの思考（表示専用）。応答の途中で打ち切ったとき、それまでの思考を残すために運ぶ。 */
  thinking?: string
}

/** 失敗の吹き出しを作る。`offerRetry` と `toolNote` は必ず付く（呼び出し側が選べない）。 */
export function failureBubbleOf(content: string, opts: { thinking?: string } = {}): FailureBubble {
  return {
    role: 'assistant',
    content,
    toolNote: true,
    ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
    offerRetry: true,
  }
}

/**
 * 通信が投げたとき、応答を流し込むために足しておいた吹き出しを取り除く出来事を返す。
 * 取り除くのは**中身が空のときだけ**（空白だけも空とみなす）。途中まで届いた本文があれば残す。
 * 空のまま残すと、会話の記録に空の assistant が入り、次の送信でそのまま AI へ送られる。
 *
 * `conversation` は、いま会話に残っている吹き出し（読めるときだけ渡す）。応答を待つ間に別の書き主が
 * 吹き出しを足していたら、末尾は自分の足した空の吹き出しではない。そのときは取り除かない
 * （足された吹き出しを消さない。残った空の吹き出しは送信の入口 planSend が AI へ渡さない）。
 * 空の一覧は「読めなかった」と同じに扱う（取り除く）。
 */
export function undoEmptyBubble(
  content: string,
  conversation: readonly { role: string; content?: string }[] = [],
): { kind: 'removeLast' } | null {
  if (content.trim() !== '') return null
  const last = conversation[conversation.length - 1]
  if (last && !(last.role === 'assistant' && !(last.content ?? '').trim())) return null
  return { kind: 'removeLast' }
}

/** 利用者の依頼の文。画像だけの送信は、既定の文を使う。送信の入口と失敗の出口が同じ規則を通る。 */
export function requestTextOf(rawText: string, hasImages: boolean): string {
  return rawText.trim() || (hasImages ? 'この画像について教えてください。' : '')
}

/** 利用者の依頼の吹き出し。 */
export type RequestBubble = {
  role: 'user'
  content: string
  images?: string[]
}

export function requestBubbleOf(rawText: string, images: string[]): RequestBubble {
  const hasImages = images.length > 0
  return { role: 'user', content: requestTextOf(rawText, hasImages), images: hasImages ? images : undefined }
}

/** 想定外の失敗の文。例外の原文は出さない（英語の頭やパスが画面に出るため）。 */
export const UNEXPECTED_FAILURE_TEXT = 'Koto の内部で問題が起きました。もう一度お試しください。'

/**
 * 想定外の失敗（main のループが投げた・画面と main の通信が失敗した）の吹き出し。
 * どちらの出口も、書き主が自分の `emit` で1回だけ出す（書き主でない側から出すと二重に書かれる）。
 * `errorPrefix` は呼び出し元の接頭辞（単独チャットは「⚠️ 」）。
 */
export function unexpectedFailureBubble(errorPrefix: string): FailureBubble {
  return failureBubbleOf(errorPrefix + UNEXPECTED_FAILURE_TEXT)
}

/** 会話に既にあるもの。想定外の失敗の出口が、足りないものだけを足すために数える。 */
export type WrittenState = {
  /** 利用者の依頼の吹き出しが会話に入った（runEngineTurn の中で入る）。 */
  request: boolean
  /** 失敗の吹き出しが会話に入った（runEngineTurn の catch が出す）。 */
  failure: boolean
}

/**
 * 会話へ出した出来事を数える（出口が、依頼と失敗の吹き出しが既にあるかを知るため）。
 * 出す側が会話に当てた直後に呼ぶ（そのあとの送信が投げても、会話には入っている）。
 */
export function noteWritten(written: WrittenState, ev: { kind: string }): void {
  if (ev.kind !== 'append' && ev.kind !== 'replaceLast') return
  const msg = (ev as { msg?: { role?: string; hidden?: boolean; offerRetry?: boolean } }).msg
  if (msg?.role === 'user' && !msg.hidden) written.request = true
  if (msg?.offerRetry) written.failure = true
}

/**
 * 想定外の失敗の出口が会話へ足す吹き出しの一覧（足す順）。
 * ・失敗の吹き出しが既にあれば、何も足さない（runEngineTurn が出したあとで後片づけが投げた回に、
 *   2つ目を出さない）。
 * ・利用者の依頼がまだ会話に無ければ、先に依頼の吹き出しを足す（そのあとに失敗の吹き出し）。
 */
export function unexpectedFailureAppends(opts: {
  rawText: string
  images: string[]
  errorPrefix: string
  written: WrittenState
}): { kind: 'append'; msg: RequestBubble | FailureBubble }[] {
  const { rawText, images, errorPrefix, written } = opts
  if (written.failure) return []
  return [
    ...(written.request ? [] : [{ kind: 'append' as const, msg: requestBubbleOf(rawText, images) }]),
    { kind: 'append' as const, msg: unexpectedFailureBubble(errorPrefix) },
  ]
}
