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
// そこで「実行中」を2本持つ: (1)count/labels（従来どおり・何かしら実行中か。自動更新の
// 再起動ゲート `canApplyNow` はアプリごと終了するので、AI応答も含めて**引き続きここを見る**）
// (2)blockingCount/blockingEntries（**閉じると本当に中断されるもの**だけ。close ダイアログは
// こちらだけを見る）。既定は blocksClose: true（今までどおり全部ブロックする）なので、
// AI応答以外の呼び出し側（NewProjectModal 等）は無修正のままでよい。
//
// ── close 警告文の実態合わせ（roadmap #14・2026-09-29 に事実を直した）──────────────
// 公開・作成・破棄の本体は main の1 invoke で完走するため、窓を閉じても処理そのものは
// 中断されない。**公開の記録（publish.targets）・pending の後片づけも main が書く**
// （roadmap #20。以前ここには「renderer 側で書く」と書いてあり、警告文も「公開の記録も Koto に
// 残りません」と嘘を言っていた）。一律「中断されます」では実態と合わないため、
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

// ── 窓を閉じるときの警告（公開・作成・破棄の全部で、この1つの文だけを使う）──────────
//
// ■ いつ出るか（原本: src/main/main.ts の `mainWindow.on('close')`）
//   **Koto の窓を閉じようとしたとき**（✗・⌘W・⌘Q など）に、いま beginActivity が
//   走っていれば出る。**公開ダイアログ（PublishModal）を閉じるとき（× や外側のクリック）には出ない**
//   ——あれは画面の中の部品を外すだけで、main には何も伝わらない。
//
// ■ そのとき本当に起きること
//   ・**窓を閉じただけなら、処理は止まらない。** 公開・作成・破棄の本体は main の1回の IPC で
//     最後まで進み、記録（publish.targets・pending の後片づけ・専有型の資源ID・HANAMII の
//     projectId）も main が書く（roadmap #20）。macOS は窓を閉じてもアプリが終了しない設計
//     （main.ts の window-all-closed。CLAUDE.md にも実測の記録）ので、main は生き続ける。
//     **結果の表示も失われない**（2026-09-29 から）: 進み具合・結果・警告は main が処理の記録（projectOps.ts・メモリ上）
//     として持ち、窓を開き直して公開のダイアログを開けば、続きから出る。失うのは Koto を終了したときだけ
//     （記録はメモリ上なので、終了すると消える）。以前の「結果は画面に出なくなります」は、この記録ができる前の文だった。
//   ・**Koto 自体を終了すると、処理は途中で止まる。** 作られたものが記録に残らないことがある
//     ——常時課金のクラスタに作ったアプリを手順6で破棄できなくなりうるので、**課金の歯止めに関わる
//     一文として必ず添える**（掟10）。次に開いたとき、公開の画面には
//     「中断された可能性」が出る（pending が残るため。judgePendingPublish）。
//
// ■ 確認ボタンの名前は「ウィンドウを閉じる（処理は続きます）」（2026-10-08 検分 H・実際の動きどおり）
//   このダイアログで確認ボタンを押したときに main がするのは、`closeBlockingBusy = false; mainWindow.close()` ——
//   **ウィンドウを閉じるだけ**で、アプリは終了しない（src/main/main.ts の close ハンドラ。macOS は window-all-closed で終了しない設計）。
//   ⌘Q・Dock の「終了」から来た場合も、`app.quit()` は最初のウィンドウの close を `preventDefault` で止めたところで中断されており、
//   確認のあとに閉じるのはそのウィンドウだけ。以前のボタン名「閉じて終了」は、押せば Koto が終了するように読め、
//   処理も止まると思わせた（実際は処理が裏で続く）。事実と逆の名前なので直した。
//   「ウィンドウを閉じても処理は続く」は、このボタン名が言う。本文（detail）では言い直さない
//   （2026-10-15 作者決定・掟5の2: 確認ダイアログのボタン名が言っていることを、本文で言い直さない）。
//   Electron を起動した確認はしていない（コードを読んだ範囲）。⌘Q で押したあと Koto が残ることは、実機で一度見ておくとよい。
//   「処理は続きます」が正しいのは macOS だけ（main.ts の window-all-closed は darwin 以外では app.quit() する）。配布は mac だけ
//   （electron-builder.config.js）なので今は問題ない。別の OS を配るときは、このボタン名を見直すこと。
//   closeWarning を渡さない処理（新規プロジェクト作成・公開済みの取り込み・VPS）のボタン名は main.ts のフォールバック
//   「中断してウィンドウを閉じる」（画面側が処理を持つので、ウィンドウを閉じると処理は実際に中断される）。
//
// 以前は公開の3パネルと専有型の作成・破棄が「公開の記録も Koto に残りません」（**事実と違う**。
// 記録は main が書く）を、専有型の手順8だけが正しい文（PUBLISH_CLOSE_WARNING_MAIN_RECORD）を出していた。
// 文を分けると片方だけ古くなるので、**この1つにまとめた**（掟10）。
/** 「ウィンドウを閉じても続く」ことと、「Koto を終了すると止まる」ことの、後者（課金の歯止めに関わる一文）。 */
export const PUBLISH_QUIT_STOPS =
  'ただし Koto 自体を終了すると、処理は途中で止まり、作られたものが記録に残らないことがあります。'

/**
 * 窓を閉じる警告の確認ボタンの名前。**実際の動きどおり**: ウィンドウが閉じるだけで、Koto は終了せず、処理は続く。
 * 「処理は続きます」はここが言うので、本文（PUBLISH_CLOSE_WARNING.detail）は言い直さない。
 */
export const PUBLISH_CLOSE_CONFIRM_LABEL = 'ウィンドウを閉じる（処理は続きます）'

export const PUBLISH_CLOSE_WARNING = {
  // 本文は、ボタン名が言わないことだけ: 開き直すと結果が出ること／Koto を終了すると止まること（課金の歯止め・必ず残す）。
  // 以前は「ウィンドウを閉じても、処理は最後まで進み、作ったものの記録も残ります。」から始まり「よろしいですか？」で終わっていたが、
  // 前者はボタン名の言い直し、後者はボタン（閉じる／キャンセル）が問いに答えているので外した（2026-10-15 作者決定）。
  detail: `開き直して公開の画面を開くと、進み具合と結果が出ます。${PUBLISH_QUIT_STOPS}`,
  confirmLabel: PUBLISH_CLOSE_CONFIRM_LABEL,
}

// 手順8「アプリを公開する」の画面に出す一文（専有型だけの案内つき）。**「Koto を終了すると止まる」の文は
// 窓を閉じる警告と同じ定義（PUBLISH_QUIT_STOPS）から引く**（2か所で別々に書かない・掟10）。
// 2026-09-24 検分の指摘4・7・10: 「閉じる」が何を指すのかを言い分ける（画面を閉じても進む／終了すると止まる）。
export const PUBLISH_STOP_NOTE_MAIN_RECORD =
  `この公開の画面を閉じても、公開は最後まで進みます（公開の記録は Koto が残すので、あとから手順6で削除できます）。開き直すと、ここに進み具合と結果が出ます。${PUBLISH_QUIT_STOPS}`

// テスト用: 現在の実行中数（テスト以外で使わない）
export function _activeCount() {
  return count
}

// テスト用: 「閉じると中断される」実行中数（テスト以外で使わない）
export function _blockingCount() {
  return blockingCount
}
