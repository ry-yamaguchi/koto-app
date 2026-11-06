// notifyQueue.ts — 通知（OK が1つだけの窓）を、**順番待ちで**1つずつ出すための小さな待ち行列（react に依存しない純粋な部品）。
// useConfirm の notify が使う。確認（confirm）は答えが要るので1つずつ await される前提だが、通知は続けて呼ばれうる
// （例: 名前の変更が断られた直後に別の断りが来る）。先の Promise を取りこぼさないよう、前の通知が閉じるまで次を待たせる。

/** 通知の中身。題と本文の2つ。OK の文字は既定「OK」。 */
export interface NotifyOptions {
  title: string
  body: string
  okLabel?: string
}

export interface NotifyQueue {
  /** 通知を積む。その通知が閉じられたときに解決する Promise を返す（積んだ順に出る）。 */
  push(options: NotifyOptions): Promise<void>
  /** いま出している通知を閉じ、あれば次を出す。出している通知が無ければ何もしない。 */
  dismiss(): void
  /** いま出している通知（無ければ null）。 */
  current(): NotifyOptions | null
}

/** `onChange` は、出す通知が変わるたびに呼ばれる（画面の更新用）。 */
export function createNotifyQueue(onChange: (current: NotifyOptions | null) => void = () => {}): NotifyQueue {
  const waiting: { options: NotifyOptions; resolve: () => void }[] = []
  return {
    push(options) {
      return new Promise<void>(resolve => {
        waiting.push({ options, resolve })
        // 積んだのが先頭（=ほかに出ているものが無い）ときだけ、いま出す
        if (waiting.length === 1) onChange(waiting[0].options)
      })
    },
    dismiss() {
      const head = waiting.shift()
      if (!head) return
      head.resolve()
      onChange(waiting[0]?.options ?? null)
    },
    current() {
      return waiting[0]?.options ?? null
    },
  }
}
