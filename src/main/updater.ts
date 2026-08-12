// updater.ts — 自動更新（electron-updater）の main 側。
//
// ── 設計の要点（docs/update-plan.md 段階2）──────────────────────────────
// **勝手に再起動しない。** これが最優先。Koto の利用者は非エンジニアで、
// 消えた作業を自力で復旧できない。既定は「ダウンロードだけして、次回起動時に適用」。
// 即時再起動は、利用者が明示的にボタンを押し、かつ作業中でないときだけ行う
// （判定は shared/updatePolicy.ts の canApplyNow に集約）。
//
// 配信元は GitHub Releases（ry-yamaguchi/koto-app）。本体リポジトリ ry-yamaguchi/koto は
// private のままで、配布物だけを公開リポジトリに置く（update-plan.md 1-5 の案A）。
// **koto-app が Public になるまで、更新の確認は失敗する。** それは正常な状態で、
// 画面には「確認できませんでした」と出るだけでアプリの動作には影響しない。

import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { sendToWindow } from './windowSend'
import { updateLogger, logUpdaterStart } from './updateLog'
import { shouldCheckOnStartup, type UpdateState } from '../shared/updatePolicy'

/** renderer へ状態を流すチャンネル（preload / global.d.ts と対応）。 */
export const UPDATE_STATE_CHANNEL = 'update:state'

let current: UpdateState = { kind: 'idle' }
let getWindow: (() => BrowserWindow | null) | null = null

/** いまの状態（renderer が後から聞きに来たときに返す）。 */
export function currentUpdateState(): UpdateState {
  return current
}

function setState(next: UpdateState) {
  current = next
  if (getWindow) sendToWindow(getWindow(), UPDATE_STATE_CHANNEL, next)
}

/**
 * 更新まわりを初期化する。app.whenReady() の後に一度だけ呼ぶ。
 *
 * @param deps.getMainWindow 状態の送り先。閉じていれば sendToWindow が黙って捨てる
 * @param deps.autoCheck     起動時に自動で確認するか（利用者の設定）
 */
export function initUpdater(deps: { getMainWindow: () => BrowserWindow | null; autoCheck: boolean }) {
  getWindow = deps.getMainWindow

  // **失敗の理由をファイルに残す。** これが無いと「更新されない」と言われても
  // 追う手段が無い（2026-08-11 に実際にそうなった）。秘密は書く前に落としてある。
  autoUpdater.logger = updateLogger
  logUpdaterStart({ version: app.getVersion(), isPackaged: app.isPackaged, autoCheck: deps.autoCheck })

  // 見つけたら自動でダウンロードする。ただし**適用はしない**。
  // 利用者を待たせずに準備を終えておき、切り替えは次回起動時にする。
  autoUpdater.autoDownload = true
  // 終了時に自動で適用する。次に起動したときには新しい版になっている。
  // quitAndInstall を明示的に呼ばない限り、作業中に再起動が起きることはない。
  autoUpdater.autoInstallOnAppQuit = true
  // 開発中は配信元に開発版が無いので確認しない（毎回エラーになるだけ）。
  autoUpdater.forceDevUpdateConfig = false

  autoUpdater.on('checking-for-update', () => setState({ kind: 'checking' }))
  autoUpdater.on('update-not-available', () => setState({ kind: 'none' }))
  autoUpdater.on('update-available', info => setState({ kind: 'available', version: info.version }))
  autoUpdater.on('download-progress', p => {
    const version = current.kind === 'available' || current.kind === 'downloading' ? current.version : ''
    setState({ kind: 'downloading', version, percent: p.percent })
  })
  autoUpdater.on('update-downloaded', e => setState({ kind: 'downloaded', version: e.version }))
  autoUpdater.on('error', err => {
    // 更新の失敗でアプリを止めない。配信元が未公開・オフライン等は普通に起こる。
    setState({ kind: 'error', message: err?.message ?? String(err) })
  })

  if (shouldCheckOnStartup({ isPackaged: app.isPackaged, enabled: deps.autoCheck })) {
    // 起動直後は他の初期化と競合するので少し待つ。失敗しても握りつぶす（上の error で拾う）。
    setTimeout(() => { void autoUpdater.checkForUpdates().catch(() => { /* error イベントで処理済み */ }) }, 5000)
  }
}

/** 手動で確認する（メニュー・設定画面から）。 */
export async function checkForUpdatesNow(): Promise<UpdateState> {
  if (!app.isPackaged) {
    setState({ kind: 'error', message: '開発中は更新を確認できません（パッケージ版でのみ動作します）。' })
    return current
  }
  try {
    await autoUpdater.checkForUpdates()
  } catch (e: any) {
    setState({ kind: 'error', message: e?.message ?? String(e) })
  }
  return current
}

/**
 * ダウンロード済みの更新を、いますぐ適用して再起動する。
 *
 * **呼ぶ前に canApplyNow で確認すること。** ここは実行するだけで、判断はしない
 * （判断を2箇所に置くと、片方だけ直されて「作業中に再起動する」事故に戻る）。
 */
export function quitAndInstallNow(): void {
  autoUpdater.quitAndInstall()
}
