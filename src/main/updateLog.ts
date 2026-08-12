// updateLog.ts — 更新ログをファイルへ残す（main 側）。
//
// ── なぜ自前で書くか ──────────────────────────────────────────────────
// electron-updater が欲しがるのは `{ info, warn, error, debug }` だけなので、
// electron-log を足すほどのことはない。**同梱物を増やさない**（配布サイズは
// 更新のダウンロード量に直結する。docs/update-plan.md）。
//
// ── 置き場所 ──────────────────────────────────────────────────────────
// macOS の作法どおり `~/Library/Logs/Koto/updater.log`。
// **利用者が自分で辿り着ける場所ではない**ので、設定画面から開くボタンを用意する
// （`update:openLog`）。非エンジニアに「ログを見てください」は通じない。
//
// 秘密の除去と行の組み立ては shared/updateLog.ts（テスト済み）。ここは入出力だけ。

import { app, shell } from 'electron'
import fs from 'fs'
import path from 'path'
import { formatLogLine, trimLog, type UpdateLogLevel } from '../shared/updateLog'

/** ログが際限なく育たないための上限。数回分の更新を追うには十分。 */
const MAX_BYTES = 256 * 1024

let logPath: string | null = null
/** 最後に書き込みへ失敗した理由。**握りつぶしたままにしない**ための控え。 */
let lastWriteError: string | null = null

/** ログファイルの場所（無ければ作る）。 */
export function updateLogPath(): string {
  if (logPath) return logPath
  const dir = app.getPath('logs')
  fs.mkdirSync(dir, { recursive: true })
  logPath = path.join(dir, 'updater.log')
  return logPath
}

function write(level: UpdateLogLevel, message: unknown): void {
  try {
    const p = updateLogPath()
    fs.appendFileSync(p, formatLogLine(level, message, new Date()) + '\n', 'utf8')
    // 追記のたびに全部読むのは無駄なので、上限を超えたときだけ整える
    const st = fs.statSync(p)
    if (st.size > MAX_BYTES) fs.writeFileSync(p, trimLog(fs.readFileSync(p, 'utf8'), MAX_BYTES), 'utf8')
    lastWriteError = null
  } catch (e: any) {
    // **ログが書けないことでアプリを止めない。** ディスク満杯・権限など、
    // ログより本体のほうが大事な場面でこそ起こる。
    // ただし**黙って諦めない**。理由を控えて、記録を開いたときに利用者へ伝える
    // （空のログを送られても、こちらは何も分からないため）。
    lastWriteError = e?.message ?? String(e)
  }
}

/** electron-updater に渡すロガー。 */
export const updateLogger = {
  info: (m?: unknown) => write('info', m),
  warn: (m?: unknown) => write('warn', m),
  error: (m?: unknown) => write('error', m),
  debug: (m: string) => write('debug', m),
}

/** 起動のたびに、どの版が何を見に行くのかを1行残す（追う起点になる）。 */
export function logUpdaterStart(opts: { version: string; isPackaged: boolean; autoCheck: boolean }): void {
  write('info', `--- 起動 v${opts.version} packaged=${opts.isPackaged} 自動確認=${opts.autoCheck ? 'する' : 'しない'}`)
}

/**
 * ログを Finder で表示する（設定画面のボタンから）。
 * **開くのではなく「場所を示す」。** 利用者はそこから私に送ることになるため。
 */
export async function revealUpdateLog(): Promise<{ ok: boolean; path: string; message?: string }> {
  try {
    const p = updateLogPath()
    if (!fs.existsSync(p)) fs.writeFileSync(p, '', 'utf8') // 無いと showItemInFolder が何もしない
    shell.showItemInFolder(p)
    // 書けていなかったのなら、それこそが伝えるべきこと。空のログを送らせない
    if (lastWriteError) {
      return { ok: false, path: p, message: `記録を残せていません（${lastWriteError}）。このファイルは空か、古いままです。` }
    }
    return { ok: true, path: p }
  } catch (e: any) {
    return { ok: false, path: logPath ?? '', message: e?.message ?? String(e) }
  }
}
