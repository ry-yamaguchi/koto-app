// chatStatusLine.ts — 「考えています…」の1行に何を出すかの唯一の定義（掟10）。
//
// ── なぜ要るか（2026-09-23 実機・Ryosuke）─────────────────────────────
// ChatPanel.tsx と ChatApp.tsx は、どちらも
//   {statusNote || (stalled ? '⏳ 時間がかかっています…（⏹ で停止できます）' : '考えています…')}
// と**同じ条件を2か所に書き写して**いた。この形だと、ステータス文言（statusNote）が出ている間は
// **⏹ で止められることが絶対に表示されない**。しかも「実際に変更が必要か確かめています…」は
// chatTurn.ts が一度出すとターンが終わるまで消えないので、**固まっている間ずっと案内が隠れる**。
// 実機ではこれが「308秒 → 356秒、抜け方が分からない」になった。
//
// 判断はこの純関数1か所に置き、両方の画面はこれを呼ぶだけにする（二重修正禁止・掟7/掟10）。

/** 長引いたときに添える案内。⏹ ボタンのラベルと対応している。 */
export const STOP_HINT = '（⏹ で停止できます）'

/**
 * 進行中の1行を組み立てる。
 *
 * | statusNote | stalled | 出るもの |
 * |---|---|---|
 * | なし | false | 考えています… |
 * | あり | false | そのステータス文言 |
 * | なし | true  | ⏳ 時間がかかっています…（⏹ で停止できます） |
 * | あり | true  | そのステータス文言（⏹ で停止できます） |
 */
export function chatStatusLine(statusNote: string | null | undefined, stalled: boolean): string {
  const base = (statusNote ?? '').trim() || (stalled ? '⏳ 時間がかかっています…' : '考えています…')
  return stalled ? `${base}${STOP_HINT}` : base
}
