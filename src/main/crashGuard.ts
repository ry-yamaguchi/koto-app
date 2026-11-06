// crashGuard.ts — 画面が止まった・落ちた／main が想定外の例外を投げたとき、日本語で知らせて記録を残す（main の歯止め）。
//
// ── なぜ要るか ─────────────────────────────────────────────────────────────
// 画面（描画プロセス）が落ちると、窓は白いまま何も起きず、利用者には「固まった」としか見えない。回復の道は
// 製品版のメニューの「再読み込み」だけだった。main が想定外の例外を投げたときは、Electron の英語の窓が出る
// （windowSend.ts の冒頭に、アプリごと落ちた記録がある）。何が起きたか分からないまま、続けるか終わるかを迫られる。
//
// ── 何をするか ─────────────────────────────────────────────────────────────
// 受ける出来事は5つ。1つも抜かさない（main.ts が全部をここへ渡し、何を無視するかはここだけが決める）。
//   画面: render-process-gone ・ did-fail-load ・ unresponsive／responsive
//   main: uncaughtException ・ unhandledRejection
// ・判断は純関数 `crashGuardDecision`（無視する／聞く／再読み込みを止めて終了だけにする）
// ・流れ（記録・窓・答えの扱い・二重に出さない）は `createCrashGuard`（electron に触れない。窓・再読み込み・終了・時計・記録は
//   main.ts が渡す＝quitGuard.ts と同じ作り。振る舞いは偽の道具に流してテストで固定する）
// ・終了は app.quit() を通る（main.ts が渡す）。quitGuard の 'before-quit' が走っているので、公開や削除が走っていれば確認が出る。
//   app.exit() や process.exit() で抜けない（その確認を飛ばしてしまう）。
// ・記録は `crash.log`（app.getPath('logs')。updater.log と同じ置き場）。書く前に redactSecrets で秘密を伏せ、ホームのパス
//   （利用者名）を `~` にする（記録は利用者が作者へ送るもので、貼り付け先が公開の場所のこともある）。
// ・応答の待ち受け（unresponsive の5秒）は、そのあと窓が閉じる・画面が落ちる・読み込めなくなるときは取り消す（画面がもう無いのに「停止しました」を出さない）。

import fs from 'fs'
import os from 'os'
import path from 'path'
import { redactSecrets, formatLogLine, trimLog, type UpdateLogLevel } from '../shared/updateLog'
import { maskHomePath } from '../shared/homePath'

/** 画面の異常は「画面」、main の例外は「main」の窓を出す。 */
export type CrashFamily = 'renderer' | 'main'

/** 受ける出来事。webContents と process の5つ。 */
export type CrashReason =
  | { kind: 'render-process-gone'; reason: string; exitCode?: number }
  | { kind: 'did-fail-load'; errorCode: number; errorDescription: string; isMainFrame: boolean }
  | { kind: 'unresponsive' }
  | { kind: 'uncaughtException'; error: unknown }
  | { kind: 'unhandledRejection'; error: unknown }

export type CrashDecision = 'ignore' | 'ask' | 'giveUp'

/** 同じ系統の異常がこの時間内にもう一度起きたら、再読み込みを勧めるのをやめる。 */
export const CRASH_REPEAT_WINDOW_MS = 60_000
/** 応答しなくなってから、戻るのを待つ時間。戻ったら窓は出さない（出した窓は取り下げられない）。 */
export const UNRESPONSIVE_GRACE_MS = 5_000
/** Chromium の「読み込みを中断した」エラー番号（ERR_ABORTED）。遷移の取り消しや読み込み中の再読み込みで起きる＝異常ではない。 */
const LOAD_ABORTED = -3
/** 「同じ原因は1回だけ」のために覚えておく原因の数。これを超えたら古いものから忘れる。 */
const MAX_REMEMBERED_CAUSES = 200
/** 記録に書く1件の長さの上限。 */
const MAX_LOG_TEXT = 8000

export const CRASH_LOG_FILE = 'crash.log'
export const CRASH_LOG_MAX_BYTES = 256 * 1024

export const CRASH_LABEL_RELOAD = '再読み込み'
export const CRASH_LABEL_CONTINUE = '続ける'
export const CRASH_LABEL_QUIT = '終了'

export function crashFamilyOf(reason: CrashReason): CrashFamily {
  return reason.kind === 'uncaughtException' || reason.kind === 'unhandledRejection' ? 'main' : 'renderer'
}

/**
 * 出来事を受けて何をするか（純関数）。`recentAt` は、同じ系統で窓を出した時刻（ミリ秒）。
 * - 'ignore': 異常ではない（clean-exit・読み込みの中断・子フレーム）
 * - 'giveUp': 画面の異常が短い間に繰り返した。再読み込みを勧めず、「終了」だけにする（再読み込みが落ちる輪にならないように）
 * - 'ask'   : 聞く
 * main の例外は、繰り返しても 'ask' のまま（同じ原因は流れの側で1回だけにする）。
 */
export function crashGuardDecision(reason: CrashReason, recentAt: readonly number[], now: number): CrashDecision {
  const repeated = () => (recentAt.some(t => now - t < CRASH_REPEAT_WINDOW_MS) ? 'giveUp' : 'ask')
  switch (reason.kind) {
    case 'render-process-gone':
      return reason.reason === 'clean-exit' ? 'ignore' : repeated()
    case 'did-fail-load':
      return reason.isMainFrame && reason.errorCode !== LOAD_ABORTED ? repeated() : 'ignore'
    case 'unresponsive':
      return repeated()
    default:
      return 'ask'
  }
}

type CrashAction = 'reload' | 'continue' | 'quit'
const ACTION_LABEL: Record<CrashAction, string> = {
  reload: CRASH_LABEL_RELOAD,
  continue: CRASH_LABEL_CONTINUE,
  quit: CRASH_LABEL_QUIT,
}

/** `showMessageBox` に渡す設定。決まった形（electron の型には依存しない）。 */
export type CrashDialogOptions = {
  type: 'warning'
  buttons: string[]
  defaultId: number
  cancelId: number
  message: string
  detail: string
}

const FAMILY_TEXT: Record<CrashFamily, { message: string; detail: string; proceed: CrashAction }> = {
  renderer: { message: 'Koto の画面が停止しました。', detail: '保存していない編集は失われます。', proceed: 'reload' },
  main: { message: 'Koto の内部で問題が起きました。', detail: '続けると、正しく動かないことがあります。', proceed: 'continue' },
}

/**
 * 窓の設定と、ボタンごとの動き。`actions[i]` が i 番目のボタンの動き（ボタンの名前も同じ表から作るので食い違わない）。
 * 既定（Return）は 0 番目＝続ける側。取消の番号はボタンの数（範囲外）にして、Esc はどのボタンにも付けない
 * （cancelId を省くと Electron が「終了」に Esc を付ける。理由と原本は quitGuard.ts の quitGuardDecision のコメント）。
 */
export function crashDialogPlan(family: CrashFamily, giveUp: boolean): { options: CrashDialogOptions; actions: CrashAction[] } {
  const t = FAMILY_TEXT[family]
  const actions: CrashAction[] = giveUp ? ['quit'] : [t.proceed, 'quit']
  return {
    options: {
      type: 'warning',
      buttons: actions.map(a => ACTION_LABEL[a]),
      defaultId: 0,
      cancelId: actions.length,
      message: t.message,
      detail: t.detail,
    },
    actions,
  }
}

/** 値を文にする。どんな値（循環・読むと投げるもの）でも投げない。 */
function safeString(value: unknown): string {
  try {
    if (typeof value === 'string') return value
    if (value === undefined) return 'undefined'
    if (value !== null && typeof value === 'object') return JSON.stringify(value) ?? Object.prototype.toString.call(value)
    return String(value)
  } catch {
    return '[文字にできない値]'
  }
}

/** `os.homedir()`。取れない環境でも投げない。 */
function homeDir(): string {
  try { return os.homedir() } catch { return '' }
}

/** 記録に書くエラーの文。スタックがあればスタック。秘密を伏せ、ホームのパスを `~` にしてから長さを切る（切り口に秘密の頭が残らないように）。 */
export function errorText(error: unknown): string {
  let raw: string
  try {
    raw = error instanceof Error ? (error.stack || `${error.name}: ${error.message}`) : safeString(error)
  } catch {
    raw = '[読み取れない値]'
  }
  return maskHomePath(redactSecrets(raw), homeDir()).slice(0, MAX_LOG_TEXT)
}

/** 「同じ原因」の見分け。エラーの名前・メッセージと、スタックの先頭の1行。値そのものが違えば別の原因。 */
function causeKeyOf(reason: CrashReason): string | null {
  if (reason.kind !== 'uncaughtException' && reason.kind !== 'unhandledRejection') return null
  try {
    const e = reason.error
    if (e instanceof Error) {
      const frame = (e.stack ?? '').split('\n').map(l => l.trim()).find(l => l.startsWith('at ')) ?? ''
      return `${e.name}: ${e.message} @ ${frame}`
    }
  } catch { /* 読めない値は下の文字にする */ }
  return safeString(reason.error).slice(0, 300)
}

function describeCrash(reason: CrashReason): string {
  switch (reason.kind) {
    case 'render-process-gone':
      return `画面のプロセスが終了しました（render-process-gone reason=${reason.reason} exitCode=${reason.exitCode ?? '-'}）`
    case 'did-fail-load':
      return `画面を読み込めませんでした（did-fail-load errorCode=${reason.errorCode} ${reason.errorDescription}）`
    case 'unresponsive':
      return `画面の応答が戻らないまま ${UNRESPONSIVE_GRACE_MS / 1000} 秒たちました（unresponsive）`
    case 'uncaughtException':
      return `main で捕まえていない例外（uncaughtException）: ${errorText(reason.error)}`
    case 'unhandledRejection':
      return `main で受け取っていない拒否（unhandledRejection）: ${errorText(reason.error)}`
    default:
      return '想定外の出来事'
  }
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms)
  return () => clearTimeout(t)
}

/**
 * 異常を受けて、記録し、窓で聞き、答えを実行する流れ。どの口も投げない（process の例外処理の中で呼ばれるため）。
 * - 窓が出ている間は、次の異常で窓を重ねない（記録には残す）
 * - 答えが範囲外・窓が出せなかった・閉じられた、のときは何もしない（再読み込みも終了もしない）。窓は次の異常でまた出せる
 * - main の例外・拒否は、同じ原因を1回だけ出して記録する（毎秒投げる例外で窓と記録があふれない）
 */
export function createCrashGuard(deps: {
  /** 窓を出して、押されたボタンの番号を返す。 */
  dialog: (opts: CrashDialogOptions) => Promise<number>
  /** 画面を読み込み直す。 */
  reload: () => void
  /** `app.quit()`。画面の異常のときは、止まった画面の印（未保存・実行中）を捨ててから終了する、のように分けられる。 */
  quit: (family: CrashFamily) => void
  now: () => number
  log: (level: UpdateLogLevel, message: string) => void
  /** 遅れて実行し、取り消す道具を返す。省くと setTimeout。 */
  schedule?: (fn: () => void, ms: number) => () => void
}) {
  const schedule = deps.schedule ?? defaultSchedule
  const recent: Record<CrashFamily, number[]> = { renderer: [], main: [] }
  const seenCauses = new Set<string>()
  let asking = false
  let cancelHangWait: (() => void) | null = null

  const log = (level: UpdateLogLevel, message: string): void => {
    try { deps.log(level, message) } catch { /* 記録が書けなくても、異常の処理を止めない */ }
  }

  function run(action: CrashAction | undefined, family: CrashFamily): void {
    try {
      if (action === undefined) { log('warn', '確認の窓が答えなしで閉じました。何もしません'); return }
      log('info', `選んだ答え: ${ACTION_LABEL[action]}`)
      if (action === 'reload') deps.reload()
      else if (action === 'quit') deps.quit(family)
    } catch (e) {
      log('error', `答えを実行できませんでした（${action}）: ${errorText(e)}`)
    }
  }

  /** 応答の待ち受けの予約を取り消す。予約が無ければ何もしない（取り消しが投げても、予約は捨てる）。 */
  function dropHangWait(): boolean {
    const cancel = cancelHangWait
    cancelHangWait = null
    if (!cancel) return false
    try { cancel() } catch (e) { log('error', `応答の待ち受けの取り消しに失敗しました: ${errorText(e)}`) }
    return true
  }

  function handle(reason: CrashReason): void {
    const family = crashFamilyOf(reason)
    const now = deps.now()
    const times = recent[family].filter(t => now - t < CRASH_REPEAT_WINDOW_MS)
    recent[family] = times
    const decision = crashGuardDecision(reason, times, now)
    // 画面が落ちた・読み込めなくなった。応答を待っていた予約は意味を失う（残すと、落ちた窓の答えのあとに「停止しました」が重なって出る）
    if (reason.kind === 'render-process-gone' || (reason.kind === 'did-fail-load' && decision !== 'ignore')) dropHangWait()
    if (decision === 'ignore') return

    const cause = causeKeyOf(reason)
    if (cause !== null) {
      if (seenCauses.has(cause)) return
      seenCauses.add(cause)
      if (seenCauses.size > MAX_REMEMBERED_CAUSES) seenCauses.delete(seenCauses.values().next().value as string)
    }
    log('error', describeCrash(reason))
    if (asking) { log('warn', '別の確認の窓が出ているため、この件では窓を出しません'); return }

    asking = true
    times.push(now)
    const plan = crashDialogPlan(family, decision === 'giveUp')
    Promise.resolve()
      .then(() => deps.dialog(plan.options))
      .then(response => {
        asking = false
        run(Number.isInteger(response) ? plan.actions[response] : undefined, family)
      })
      .catch(e => {
        asking = false
        log('error', `確認の窓を出せませんでした: ${errorText(e)}`)
      })
  }

  /** どの口も投げない。 */
  const report = (reason: CrashReason): void => {
    try { handle(reason) } catch (e) { log('error', `異常の処理で失敗しました: ${errorText(e)}`) }
  }

  return {
    onRenderProcessGone: (details: { reason: string; exitCode?: number }): void =>
      report({ kind: 'render-process-gone', reason: details.reason, exitCode: details.exitCode }),
    onDidFailLoad: (e: { errorCode: number; errorDescription: string; isMainFrame: boolean }): void =>
      report({ kind: 'did-fail-load', errorCode: e.errorCode, errorDescription: e.errorDescription, isMainFrame: e.isMainFrame }),
    /** 応答しなくなった。すぐには聞かず、戻るのを少し待つ（同じ停止の間は予約を1つだけ持つ）。 */
    onUnresponsive: (): void => {
      try {
        if (cancelHangWait) return
        cancelHangWait = schedule(() => { cancelHangWait = null; report({ kind: 'unresponsive' }) }, UNRESPONSIVE_GRACE_MS)
      } catch (e) { log('error', `応答の待ち受けに失敗しました: ${errorText(e)}`) }
    },
    /** 応答が戻った。待っている間なら、窓は出さない。 */
    onResponsive: (): void => {
      try {
        dropHangWait()
        log('info', '画面の応答が戻りました')
      } catch (e) { log('error', `応答の待ち受けの取り消しに失敗しました: ${errorText(e)}`) }
    },
    /** 窓が閉じた。応答を待っている間なら、窓は出さない（窓がもう無い）。 */
    onWindowClosed: (): void => {
      try {
        if (dropHangWait()) log('info', '窓が閉じたため、画面の応答の待ち受けを取り消しました')
      } catch (e) { log('error', `応答の待ち受けの取り消しに失敗しました: ${errorText(e)}`) }
    },
    onUncaughtException: (error: unknown): void => report({ kind: 'uncaughtException', error }),
    onUnhandledRejection: (error: unknown): void => report({ kind: 'unhandledRejection', error }),
  }
}

/**
 * 記録の書き手を作る。`getDir()` の下の crash.log に1行ずつ足し、上限を超えたら古い行から捨てる
 * （updater.log と同じ作り。行の組み立ては shared/updateLog.ts）。書けなくても投げない
 * （例外の処理の中で呼ばれる。ここで投げると、その例外がまた例外を呼ぶ）。
 */
export function createCrashLogWriter(
  getDir: () => string,
  opts: { now?: () => Date; maxBytes?: number; home?: string } = {},
): (level: UpdateLogLevel, message: unknown) => void {
  const now = opts.now ?? (() => new Date())
  const maxBytes = opts.maxBytes ?? CRASH_LOG_MAX_BYTES
  return (level, message) => {
    try {
      const dir = getDir()
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, CRASH_LOG_FILE)
      // 行の組み立て（formatLogLine）が、秘密を伏せ、ホームのパスを `~` にする（エラーの文の外から来る行も、ここを通る）
      fs.appendFileSync(file, formatLogLine(level, message, now(), opts.home ?? homeDir()) + '\n', 'utf8')
      if (fs.statSync(file).size > maxBytes) fs.writeFileSync(file, trimLog(fs.readFileSync(file, 'utf8'), maxBytes), 'utf8')
    } catch { /* 記録が書けないことで、アプリを止めない */ }
  }
}
