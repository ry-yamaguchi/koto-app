// migrate.ts — 既存プロジェクトを`public/` の形へ移す（project:migrate*）。
//
// ── 決めごと（2026-08-20 Ryosuke 指示）────────────────────────────────
//   ・**確認は出すが、拒否はできない。** 押すまで進まない案内（renderer 側）。
//   ・**移す前に 🕘 履歴のスナップショットを取る。** Koto 自身の安全網なので、
//     利用者は「元に戻す」で丸ごと戻せる。
//   ・**途中で失敗したら、そこで止めて元へ戻す。** 半分だけ移った状態を残さない。
//   ・移すのは公開されるものだけ（判断は shared/migratePlan.ts → publishExclude.ts）。

import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { PUBLISH_DIR } from '../../shared/publishRoot'
import { planMigrate, needsMigration, type Entry, type MigratePlan } from '../../shared/migratePlan'
import { isPublished } from '../../shared/publishExclude'
import { snapshotBeforeChange } from '../backup/store'

/** プロジェクト直下の一覧（読めなければ空）。 */
function readEntries(projectDir: string): Entry[] {
  try {
    return fs.readdirSync(projectDir, { withFileTypes: true }).map(e => ({ name: e.name, isDir: e.isDirectory() }))
  } catch {
    return []
  }
}

/**
 * プロジェクトの公開先（`.sakuraide.json` の `target`）。読めなければ null。
 * **公開しないものに `public/` を作らせない**ために要る（migratePlan の skipMigrationForTarget）。
 */
function readTarget(projectDir: string): string | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(projectDir, '.sakuraide.json'), 'utf-8'))
    return typeof m?.target === 'string' ? m.target : null
  } catch {
    return null // メタが無い（既存フォルダを開いた等）＝ 従来どおり案内する
  }
}

export function registerMigrateHandlers(): void {
  /** 移行が要るか調べ、計画を返す（**何も変えない**）。 */
  ipcMain.handle('project:migrateCheck', (_, projectDir: string) => {
    if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) {
      return { needed: false, plan: { move: [], keep: [] } as MigratePlan }
    }
    const entries = readEntries(projectDir)
    if (!needsMigration(entries, readTarget(projectDir))) return { needed: false, plan: { move: [], keep: [] } as MigratePlan }
    return { needed: true, plan: planMigrate(entries, isPublished) }
  })

  /**
   * 実際に移す。**途中で失敗したら、移した分をすべて元へ戻す。**
   * 戻せなかったときは、そのことを正直に返す（利用者は 🕘 履歴から戻せる）。
   */
  ipcMain.handle('project:migrate', (_, projectDir: string, snapshotId: string) => {
    if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) {
      return { ok: false, moved: [], restored: true, message: 'プロジェクトフォルダのパスが不正です' }
    }
    const entries = readEntries(projectDir)
    if (!needsMigration(entries, readTarget(projectDir))) return { ok: true, moved: [], restored: true }
    const plan = planMigrate(entries, isPublished)
    const dest = path.join(projectDir, PUBLISH_DIR)

    // 🕘 履歴へ「移す直前」を残す。**取れなくても移行は続ける**（履歴の欠落より
    // 作業の完了を優先する。agent.ts の PreToolUse と同じ方針）が、
    // 取れたかどうかは呼び出し側へ返し、案内の文面を変えられるようにする。
    let snapshotOk = false
    for (const name of plan.move) {
      try {
        const r = snapshotBeforeChange(projectDir, snapshotId, name, `フォルダの整理（${PUBLISH_DIR}）`)
        if (r.ok) snapshotOk = true
      } catch { /* 続ける */ }
    }

    const moved: string[] = []
    try {
      fs.mkdirSync(dest, { recursive: true })
      for (const name of plan.move) {
        const from = path.join(projectDir, name)
        const to = path.join(dest, name)
        if (fs.existsSync(to)) throw new Error(`「${PUBLISH_DIR}」に同じ名前が既にあります: ${name}`)
        fs.renameSync(from, to)
        moved.push(name)
      }
      return { ok: true, moved, restored: true, snapshotOk }
    } catch (e: any) {
      // **半分だけ移った状態を残さない。** 移した分を逆順に戻す。
      let restored = true
      for (const name of [...moved].reverse()) {
        try {
          fs.renameSync(path.join(dest, name), path.join(projectDir, name))
        } catch {
          restored = false
        }
      }
      // 空になったフォルダは片づける（残すと「移行済み」と誤判定される）
      try { if (fs.readdirSync(dest).length === 0) fs.rmdirSync(dest) } catch { /* ignore */ }
      return { ok: false, moved: [], restored, snapshotOk, message: e?.message ?? String(e) }
    }
  })
}
