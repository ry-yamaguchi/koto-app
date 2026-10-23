// quitGuard.ts — Koto を終了するとき、走っている処理があれば必ず聞く（main の歯止め）。
//
// ── なぜ要るか（2026-10-10・0.6.21-rc.1 の実機）──────────────────────────────
// 専有型の削除（約9分）の途中で ⌘Q → 警告 →「ウィンドウを閉じる（処理は続きます）」→ Dock から開き直す →
// 削除は続いていた——ところが、そのあと**警告が出ないまま Koto が終了し、削除が途中で止まった**。
// 終了の警告は mainWindow の 'close' だけにあり、材料は画面が win:busy で登録した印だった。その印は
// ウィンドウを閉じると外れ、開き直したウィンドウでは、その処理を映す画面を開くまで誰も登録せず、ウィンドウが無いときの ⌘Q は 'close' が起きない。
// どの道でも、main の中では処理が走っている（projectOps のメモリの記録＝鍵と同じ記録）のに、聞かずに終了できた。
//
// ── 何をするか ─────────────────────────────────────────────────────────────
// 画面の登録を当てにせず、main が「走っているか」の正（projectOps.listRunningOps）を直接読み、
// アプリの 'before-quit'（⌘Q・Dock の「終了」・メニューの「終了」のすべてがここを通る）で聞く。
// ・判断は純関数 `quitGuardDecision`（走っていない→止めない／走っている→文とボタンを返す）
// ・流れ（聞く・やめる・「終了する」を選んだら app.quit() をやり直す・二重に聞かない）は `createQuitGuard`
//   （electron に触れない。ダイアログと app.quit は main.ts が渡す＝振る舞いをテストで固定できる）
// ウィンドウを閉じるだけ（赤いボタン・⌘W）は、これまでどおり main.ts の 'close' の警告（ここは関与しない）。

import * as path from 'path'
import type { RunningOpInfo } from './projectOps'
import { opWordFor } from '../shared/opWord'

/** ダイアログの見出し。 */
export const QUIT_GUARD_MESSAGE = '処理を実行中です'
/** 0 番目のボタン（既定＝Return が付き、macOS では青く描かれる）。 */
export const QUIT_GUARD_CANCEL_LABEL = '終了しない'
/** 1 番目のボタン。押すと処理は途中で止まる。 */
export const QUIT_GUARD_QUIT_LABEL = '終了する（処理は途中で止まります）'
/** 「終了する」のボタンの番号（`showMessageBox` の response と比べる）。 */
export const QUIT_GUARD_QUIT_INDEX = 1

export type QuitGuardDecision =
  | { block: false }
  | { block: true; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number }

/** プロジェクト名（projectDir の末尾の名前）。取れなければ projectDir そのもの。 */
function projectNameOf(projectDir: string): string {
  return path.basename(projectDir) || projectDir
}

/**
 * いま終了してよいか（純関数）。走っている操作が無ければ止めない。あれば、ダイアログの文とボタンを返す。
 * 文は短く: 何が進行中か（プロジェクト名と公開/削除/作成）と、終了すると途中で止まることだけ。
 *
 * ── defaultId と cancelId（2026-10-12・0.6.21-rc.2 の実際の画面で「終了しない」が青くならなかった）──────────
 * defaultId=0（終了しない）と cancelId=0 を同じにすると、macOS では**どのボタンも青くならない**。
 *   Electron 33.4.11 の原本 shell/browser/ui/message_box_mac.mm 68〜85 行: defaultId のボタンに Return（`\r`）を付けたあと、
 *   cancelId のボタンに Escape（`\e`）を付ける。同じボタンだと Return が Escape に**上書き**され（setKeyEquivalent は
 *   1つしか持てない）、Return のボタンが無くなる＝青くならず、Return を押しても何も起きない。
 * かといって cancelId を省くと、lib/browser/api/dialog.ts 195〜203 行が defaultId=0 のとき cancelId=1 を当てる
 *   ＝**「終了する」に Escape が付く**（Esc で処理が止まったまま終了する）。省かない。
 * そこで cancelId を**ボタンの数以上の値**にする。message_box_mac.mm は範囲外の cancelId にはキーを付けない
 *   （`cancel_id < button_count` のときだけ）。dialog.ts は cancelId が null でなければそのまま渡す。
 *   結果: 「終了しない」に Return が付いて青くなり、Esc はどのボタンにも付かない（何も起きない）。
 *   「終了する」に Return も Esc も付かないので、キーだけでは終了できない。押されたのが 1（終了する）以外なら、
 *   0（終了しない）・範囲外の 2・ダイアログの失敗のどれでも終了しない（`QUIT_GUARD_QUIT_INDEX` と等しいときだけ終了する）。
 * ※ 実機で未確認。青く描かれるかは、署名した版の実機でしか確かめられない。
 */
export function quitGuardDecision(running: readonly (Pick<RunningOpInfo, 'projectDir' | 'op'> & Partial<Pick<RunningOpInfo, 'target'>>)[]): QuitGuardDecision {
  if (running.length === 0) return { block: false }
  const items = running.map(r => `「${projectNameOf(r.projectDir)}」の${opWordFor(r.op, r.target)}`).join('、')
  const buttons = [QUIT_GUARD_CANCEL_LABEL, QUIT_GUARD_QUIT_LABEL]
  return {
    block: true,
    message: QUIT_GUARD_MESSAGE,
    detail: `${items}が進行中です。いま Koto を終了すると、処理は途中で止まります。`,
    buttons,
    defaultId: 0,
    cancelId: buttons.length,
  }
}

type BlockedDecision = Extract<QuitGuardDecision, { block: true }>

/** `dialog.showMessageBox` に渡す設定。決まった形（electron の型には依存しない）。 */
export type QuitDialogOptions = {
  type: 'warning'
  buttons: string[]
  defaultId: number
  cancelId: number
  message: string
  detail: string
}

/**
 * 決定（`quitGuardDecision`）からダイアログの設定を作る。**既定（Return）と cancelId は決定の値をそのまま渡す**
 * （cancelId を省くと Electron が「終了する」に Esc を付ける。上の説明）——ここが外れると、キーを押しただけで処理が止まったまま終了してしまう。
 */
export function quitGuardDialogOptions(d: BlockedDecision): QuitDialogOptions {
  return { type: 'warning', buttons: d.buttons, defaultId: d.defaultId, cancelId: d.cancelId, message: d.message, detail: d.detail }
}

/**
 * 「聞く」道具（`createQuitGuard` の `ask`）を作る。electron の `dialog` は main.ts が `showMessageBox` として渡す
 * （このファイルは electron に触れない＝偽のダイアログに流して振る舞いを固定できる）。
 * - ウィンドウがあれば親にする（無ければ親なし。Dock に残っているだけでも出す）
 * - **押されたボタンの番号は加工せずそのまま返す**（`createQuitGuard` が「終了する」の番号と比べる）
 */
export function createQuitAsk<P>(deps: {
  getParent: () => P | null
  showMessageBox: (opts: QuitDialogOptions, parent?: P) => Promise<{ response: number }>
}) {
  return async (d: BlockedDecision): Promise<number> => {
    const opts = quitGuardDialogOptions(d)
    const parent = deps.getParent()
    const { response } = parent ? await deps.showMessageBox(opts, parent) : await deps.showMessageBox(opts)
    return response
  }
}

/**
 * 終了の歯止めの流れ。
 *
 * - `onBeforeQuit`: app.on('before-quit') から呼ぶ。走っている操作があれば `preventDefault()` して聞く。
 *   「終了する」が選ばれたら印を立てて `quit()` をやり直す（2 回目の before-quit では聞かない）。
 *   「終了しない」・ダイアログの失敗は、何も閉じない（安全側）。聞いている間の ⌘Q の連打では、ダイアログを重ねない。
 * - `isQuitConfirmed`: 「終了する」を選んだあとか。mainWindow の 'close' が、**処理中の警告（(1)）だけ**飛ばすのに使う。
 *   **未保存の確認（(2)）は飛ばさない**（`forceQuit` とは別の印にしてある理由）。
 * - `reset`: 終了が中断されたとき（未保存の確認が出た＝その時点で終了は取り消されている・ウィンドウが閉じただけで終了しなかった）に
 *   印を戻す。戻さないと、次の ⌘Q で聞かずに終了してしまう（未保存の確認で「保存して終了」を選び、保存に失敗してウィンドウが
 *   開いたままのときも同じ）。
 */
export function createQuitGuard(deps: {
  listRunning: () => readonly RunningOpInfo[]
  /** ダイアログを出して、押されたボタンの番号を返す。 */
  ask: (decision: BlockedDecision) => Promise<number>
  /** `app.quit()`。 */
  quit: () => void
}) {
  let confirmed = false
  let asking = false
  return {
    onBeforeQuit(e: { preventDefault: () => void }): void {
      if (confirmed) return
      if (asking) { e.preventDefault(); return }
      const decision = quitGuardDecision(deps.listRunning())
      if (!decision.block) return
      e.preventDefault()
      asking = true
      Promise.resolve()
        .then(() => deps.ask(decision))
        .catch(() => decision.cancelId)
        .then(response => {
          asking = false
          if (response !== QUIT_GUARD_QUIT_INDEX) return
          confirmed = true
          deps.quit()
        })
    },
    isQuitConfirmed: (): boolean => confirmed,
    reset(): void { confirmed = false },
  }
}
