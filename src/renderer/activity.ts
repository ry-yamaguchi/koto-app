// activity.ts — 「実行中」レジストリ（renderer側）。
// 複数の処理（AI応答・公開・VPS操作・プロジェクト作成）が同時に進行していても正しく数えられる
// カウンタ方式。count > 0 の間、main プロセスへ 'win:busy' を通知し、閉じる前の確認ダイアログに使う
// （src/main/main.ts の mainWindow.on('close') が isBusy を見る）。
// electron/DOM 非依存の純粋ロジック（tests/activity.test.ts の対象）。ただし window.electronAPI
// の呼び出しだけは try/catch で包み、preload未注入（テスト環境等）でも例外にしない。

let count = 0
const labels: string[] = []

function report() {
  try {
    window.electronAPI.win.setBusy(count > 0, labels[labels.length - 1] ?? '')
  } catch {
    /* preload未注入時（テスト環境等）は何もしない */
  }
}

/**
 * 処理の開始を登録し、終了用の関数を返す。呼び出し側は必ず try/finally の finally で
 * 戻り値を呼ぶこと（失敗・中断でも実行中フラグが残らないようにするため）。
 */
export function beginActivity(label: string): () => void {
  count++
  labels.push(label)
  report()
  let ended = false
  return () => {
    if (ended) return
    ended = true
    count = Math.max(0, count - 1)
    const i = labels.lastIndexOf(label)
    if (i >= 0) labels.splice(i, 1)
    report()
  }
}

// テスト用: 現在の実行中数（テスト以外で使わない）
export function _activeCount() {
  return count
}
