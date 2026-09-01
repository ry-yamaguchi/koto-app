// activity.ts — 「実行中」レジストリ（renderer側）。
// 複数の処理（AI応答・公開・VPS操作・プロジェクト作成）が同時に進行していても正しく数えられる
// カウンタ方式。count > 0 の間、main プロセスへ 'win:busy' を通知する。
// electron/DOM 非依存の純粋ロジック（tests/activity.test.ts の対象）。ただし window.electronAPI
// の呼び出しだけは try/catch で包み、preload未注入（テスト環境等）でも例外にしない。
//
// ── 2種類の「実行中」（B'-3d-3・閉じる前の確認ダイアログの実態合わせ）───────────────
// 従来は「実行中＝閉じると中断される」の1本だったが、AI応答（AI Engine・Claude 両経路）は
// main でターンが走るようになり（B'-3b〜B'-3d-3）、**窓を閉じても main プロセスは生き続け、
// ターンは完走する**（macOS は window-all-closed でアプリが終了しない設計のため）。
// 一方、公開・VPS操作・プロジェクト作成は renderer 発の処理で、窓を閉じると本当に中断される。
//
// そこで「実行中」を2本持つ: ①count/labels（従来どおり・何かしら実行中か。自動更新の
// 再起動ゲート `canApplyNow` はアプリごと終了するので、AI応答も含めて**引き続きここを見る**）
// ②blockingCount/blockingLabels（**閉じると本当に中断されるもの**だけ。close ダイアログは
// こちらだけを見る）。既定は blocksClose: true（今までどおり全部ブロックする）なので、
// AI応答以外の呼び出し側（NewProjectModal 等）は無修正のままでよい。
let count = 0
const labels: string[] = []
let blockingCount = 0
const blockingLabels: string[] = []

function report() {
  try {
    window.electronAPI.win.setBusy(
      count > 0, labels[labels.length - 1] ?? '',
      blockingCount > 0, blockingLabels[blockingLabels.length - 1] ?? '',
    )
  } catch {
    /* preload未注入時（テスト環境等）は何もしない */
  }
}

/**
 * 処理の開始を登録し、終了用の関数を返す。呼び出し側は必ず try/finally の finally で
 * 戻り値を呼ぶこと（失敗・中断でも実行中フラグが残らないようにするため）。
 *
 * @param opts.blocksClose 窓を閉じると本当に中断されるか（既定 true）。AI応答（useAiChat.ts）
 *   だけが false を渡す——main でターンが完走するようになったため、閉じる前の確認ダイアログの
 *   対象から外す（自動更新の再起動ゲートは別枠で引き続き対象。上のコメント参照）。
 */
export function beginActivity(label: string, opts?: { blocksClose?: boolean }): () => void {
  const blocksClose = opts?.blocksClose !== false
  count++
  labels.push(label)
  if (blocksClose) { blockingCount++; blockingLabels.push(label) }
  report()
  let ended = false
  return () => {
    if (ended) return
    ended = true
    count = Math.max(0, count - 1)
    const i = labels.lastIndexOf(label)
    if (i >= 0) labels.splice(i, 1)
    if (blocksClose) {
      blockingCount = Math.max(0, blockingCount - 1)
      const bi = blockingLabels.lastIndexOf(label)
      if (bi >= 0) blockingLabels.splice(bi, 1)
    }
    report()
  }
}

// テスト用: 現在の実行中数（テスト以外で使わない）
export function _activeCount() {
  return count
}

// テスト用: 「閉じると中断される」実行中数（テスト以外で使わない）
export function _blockingCount() {
  return blockingCount
}
