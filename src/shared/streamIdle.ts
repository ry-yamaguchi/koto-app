// streamIdle.ts — 「返事が始まったあと、無音が続いたら打ち切る」見張り（唯一の定義・掟10）。
//
// ── なぜ要るか（2026-09-23 実機・Ryosuke）─────────────────────────────
// openai SDK 4.104.0 の timeout は**応答ヘッダが返った時点で解除される**
// （node_modules/openai/core.js の fetchWithTimeout・382-401行の
//  `.finally(() => clearTimeout(timeout))`。undici の fetch はヘッダで解決するので、
//  解除されるのは**ヘッダ到着時**であって最初のチャンク到着時ではない）。
// node_modules/openai/streaming.js に setTimeout は**0件**なので、サーバがヘッダだけ返して
// 黙ると `for await (const chunk of stream)` が**永久に戻らない**。実機ではこれが
// 「実際に変更が必要か確かめています… 308秒」のまま ⏹ も効かない固まり方になった。
//
// engine.ts の for-await をこの関数に置き換える。中身（純粋に近い制御だけ）を shared に置くのは、
// **偽の時計（vi.useFakeTimers）で「決して来ないチャンク」を試験できるようにする**ため。
// 実際の通信を張ったままでは、この道筋は実時間で90秒待たないと確かめられず、
// だからこそ tests/chatTurn.test.ts は「必ず即座に返る偽の通信」しか扱えず、
// 同じ症状が何度もすり抜けた。

/**
 * 非同期の並び（ストリーム）を1件ずつ読み、`idleMs` のあいだ1件も届かなければ打ち切る。
 *
 * - **届いたのが何であれ**（本文でも推論でも）時計はその場で振り出しに戻る。
 *   呼び出し側が「本文だけ数える」ことのないよう、ここではチャンクの中身を見ない
 *   （推論モデルは本文が出るまで数十秒沈黙するので、中身で選ると正常な応答を切ってしまう）。
 * - 打ち切るときは `onTimeout` を呼ぶ（呼び出し側が通信を中断する）。
 *   届く途中だった `next()` は捨てるが、あとから来る拒否で
 *   unhandledRejection にならないよう握りつぶしておく。
 *
 * @returns timedOut=true なら無音で打ち切った（最後まで読み切っていない）。
 *          received は**実際に届いたチャンクの件数**。
 *
 * ── なぜ received も返すか（2026-09-23 検分の指摘11）──────────────────────
 * SDK の時計はヘッダ到着で解除される（上記）。実機の症状「ヘッダだけ返して黙る」では
 * STREAM_FIRST_CHUNK_TIMEOUT_MS は**一度も発火せず**、必ずこちらの無音側で打ち切られる。
 * 呼び出し側が件数を見ずに 'idle' と決めていたため、1文字も届いていないのに
 * 「途中までの内容はそのまま残しています」と表示され、利用者が混乱していた。
 * 「1件も届かないまま打ち切ったか」を呼び出し側が判断できるようにする。
 */
export async function forEachChunkWithIdleTimeout<T>(
  iterable: AsyncIterable<T>,
  onChunk: (chunk: T) => void,
  opts: { idleMs: number; onTimeout?: () => void },
): Promise<{ timedOut: boolean; received: number }> {
  const it = iterable[Symbol.asyncIterator]()
  let received = 0
  for (;;) {
    const next = it.next()
    // 打ち切ったあとに届く拒否で unhandledRejection を出さない（結果は下の race で使う）。
    next.catch(() => { /* 打ち切り後の拒否は無視する */ })
    let timer: ReturnType<typeof setTimeout> | undefined
    const idle = new Promise<'idle'>((resolve) => {
      timer = setTimeout(() => resolve('idle'), opts.idleMs)
    })
    let winner: IteratorResult<T> | 'idle'
    try {
      winner = await Promise.race([next, idle])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    if (winner === 'idle') {
      opts.onTimeout?.()
      return { timedOut: true, received }
    }
    if (winner.done) return { timedOut: false, received }
    received++
    onChunk(winner.value)
  }
}
