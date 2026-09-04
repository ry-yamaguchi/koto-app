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
// ②blockingCount/blockingEntries（**閉じると本当に中断されるもの**だけ。close ダイアログは
// こちらだけを見る）。既定は blocksClose: true（今までどおり全部ブロックする）なので、
// AI応答以外の呼び出し側（NewProjectModal 等）は無修正のままでよい。
//
// ── close 警告文の実態合わせ（roadmap #14）─────────────────────────────
// 公開処理（3パネル）は main の1 invoke で完走するため、窓を閉じても公開そのものは
// 中断されない。実際に失われるのは「結果の表示」と、renderer 側で書く公開の記録
// （publish.targets・pending の後片づけ）。一律「中断されます」では実態と合わないため、
// blockingEntries に任意の close 警告文（detail・confirm）を持たせ、main のダイアログまで通す。
let count = 0
const labels: string[] = []
let blockingCount = 0
const blockingEntries: { label: string; detail: string; confirm: string }[] = []

function report() {
  try {
    const last = blockingEntries[blockingEntries.length - 1]
    window.electronAPI.win.setBusy(
      count > 0, labels[labels.length - 1] ?? '',
      blockingCount > 0, last?.label ?? '', last?.detail ?? '', last?.confirm ?? '',
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
 * @param opts.closeWarning blocksClose が true のときだけ意味を持つ、close ダイアログの
 *   文言差し替え（detail・confirmLabel）。未指定なら main 側の従来文言（「中断されます」）のまま。
 */
export function beginActivity(
  label: string,
  opts?: { blocksClose?: boolean; closeWarning?: { detail: string; confirmLabel: string } },
): () => void {
  const blocksClose = opts?.blocksClose !== false
  count++
  labels.push(label)
  if (blocksClose) {
    blockingCount++
    blockingEntries.push({
      label,
      detail: opts?.closeWarning?.detail ?? '',
      confirm: opts?.closeWarning?.confirmLabel ?? '',
    })
  }
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
      // 同 label の最後の1件を除去（findLastIndex 相当。tsconfig の lib が ES2020 のため手書き）。
      let bi = -1
      for (let idx = blockingEntries.length - 1; idx >= 0; idx--) {
        if (blockingEntries[idx].label === label) { bi = idx; break }
      }
      if (bi >= 0) blockingEntries.splice(bi, 1)
    }
    report()
  }
}

// 公開処理の close 警告（3パネル共通・文言を割らない）。公開の本体は main の1 invoke で完走する
// ため「中断されます」は実態と合わない（2026-08-31 Ryosuke の問いで確認・roadmap #14）。
// 失われるのは結果の表示と、renderer 側で書く公開の記録（publish.targets・pending の後片づけ）。
export const PUBLISH_CLOSE_WARNING = {
  detail: '公開処理が進行中です。公開そのものは裏で最後まで進みますが、いま閉じると結果の表示が失われ、公開の記録も Koto に残りません。よろしいですか？',
  confirmLabel: '閉じて終了',
}

// テスト用: 現在の実行中数（テスト以外で使わない）
export function _activeCount() {
  return count
}

// テスト用: 「閉じると中断される」実行中数（テスト以外で使わない）
export function _blockingCount() {
  return blockingCount
}
