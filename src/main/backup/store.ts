// store.ts — 「前の状態に戻す」（P2-⑧）の実ファイル操作。
//
// 役割分担:
//   backup/plan.ts   … electron にも fs にも依存しない純ロジック（畳み込み・ローテーション対象の算出）
//   backup/store.ts  … このファイル。fs の実 IO（退避・一覧・復元）。**electron に依存しない**ので、
//                      実際のファイルを使った単体テストができる（tests/backupStore.test.ts）
//   ipc/backup.ts    … ipcMain.handle の登録だけ
//
// electron を import しないこと。ここに `import { ipcMain } from 'electron'` を足すと、
// テストから読み込めなくなり、復元（ユーザーのファイルを上書き・削除する最も危険な処理）が
// 実物での検証から外れる。
import * as path from 'path'
import * as fs from 'fs'
import {
  BACKUP_DIRNAME, MANIFEST_FILENAME, MAX_SNAPSHOTS,
  isoToSnapshotId, looksLikeSnapshotId, isValidManifest, sortSnapshotsDesc, rotationTargets,
  normalizeSnapshotLabel, snapshotIdToIso, nextFreeSnapshotId, computeRestorePlanTo, buildPreRestoreManifest,
  type Manifest, type ManifestFileEntry, type SnapshotRecord, type SnapshotSummary,
} from './plan'

// ── プロジェクト内に閉じ込めたパス解決（多層防御。fs.ts の confineToProject と同じ規則） ──
function confineToProject(projectDir: string, rel: string): string {
  if (path.isAbsolute(rel)) throw new Error('不正なパスです（絶対パスは指定できません）')
  const full = path.normalize(path.join(projectDir, rel))
  if (full !== projectDir && !full.startsWith(projectDir + path.sep)) {
    throw new Error('不正なパスです（プロジェクトの外は操作できません）')
  }
  return full
}

function backupRoot(projectDir: string): string {
  return path.join(projectDir, BACKUP_DIRNAME)
}

function snapshotDir(projectDir: string, snapshotId: string): string {
  // snapshotId 自体もパスとして扱う前に検証する（脱出防止）
  if (!looksLikeSnapshotId(snapshotId)) throw new Error('不正なスナップショットIDです')
  return path.join(backupRoot(projectDir), snapshotId)
}

function readManifest(dir: string): Manifest | null {
  try {
    const raw = fs.readFileSync(path.join(dir, MANIFEST_FILENAME), 'utf-8')
    const parsed = JSON.parse(raw)
    return isValidManifest(parsed) ? parsed : null
  } catch {
    return null
  }
}

function writeManifest(dir: string, manifest: Manifest) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2), 'utf-8')
}

/** 新形式のスナップショット一覧（ディレクトリ名の形＋マニフェストが有効なもののみ）。
 *  旧形式（`.sakuraide-backup/<相対パス>.<stamp>` を直下に置くフラットな形。マニフェスト無し）は
 *  ここで落ちるため、残っていても一覧に出ず、アプリは壊れない。 */
function listSnapshots(projectDir: string): SnapshotRecord[] {
  const root = backupRoot(projectDir)
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return [] }
  const out: SnapshotRecord[] = []
  for (const e of entries) {
    if (!e.isDirectory() || !looksLikeSnapshotId(e.name)) continue
    const manifest = readManifest(path.join(root, e.name))
    if (manifest) out.push({ id: e.name, manifest })
  }
  return out
}

/** 直近 MAX_SNAPSHOTS を超えた古いスナップショットを削除する（ローテーション）。 */
function rotate(projectDir: string) {
  const ids = listSnapshots(projectDir).map(s => s.id)
  for (const id of rotationTargets(ids, MAX_SNAPSHOTS)) {
    try { fs.rmSync(snapshotDir(projectDir, id), { recursive: true, force: true }) } catch { /* 1件の失敗で全体を止めない */ }
  }
}

/**
 * 上書き前の旧内容を退避し、この作業のスナップショットマニフェストへ1エントリ追記する
 * （同一スナップショットIDの複数ファイルは同じスナップショットdirにまとまる）。
 * skipIfUnchanged に文字列を渡すと、退避先の旧内容と一致する場合は退避をスキップする
 * （write_file 用。最終的な新内容が事前に分かっている場合のみ使える最適化）。
 * null を渡すと常に（存在すれば）退避する（Edit 等、最終内容が事前に分からない場合用）。
 * label は履歴一覧の見出し（ユーザーの指示文など）。同一スナップショットでは最初の1件を採用する。
 * 戻り値: 実際にバックアップを取ったか（新規作成/変化なしなら false）。
 */
function snapshotEntry(
  projectDir: string, snapshotId: string, rel: string, skipIfUnchanged: string | null, label?: string
): { ok: boolean; backedUp: boolean; message?: string } {
  try {
    // スナップショットdir直下のマニフェストと衝突する名前は退避対象にしない（極めて稀なケース）
    if (rel === MANIFEST_FILENAME) return { ok: true, backedUp: false }
    const full = confineToProject(projectDir, rel)
    const dir = snapshotDir(projectDir, snapshotId)

    // 同一スナップショット内で同じファイルが複数回保存されても「作業開始時点の状態」を保持する
    // （2回目以降で退避を上書きすると、復元先が作業途中の内容になってしまうため退避しない）
    // createdAt は snapshotId（＝作業を始めた瞬間）から導く。書き込み時刻ではない理由は
    // plan.ts の snapshotIdToIso のコメント参照（一覧の並びと復元範囲を同じ時計に揃えるため）。
    const manifest = readManifest(dir)
      ?? { createdAt: snapshotIdToIso(snapshotId) ?? new Date().toISOString(), files: [] }
    const normalized = normalizeSnapshotLabel(label)
    const labelAdded = !!normalized && !manifest.label
    if (labelAdded) manifest.label = normalized
    if (manifest.files.some(f => f.path === rel)) {
      if (labelAdded) writeManifest(dir, manifest) // 見出しだけ後から付くケース
      return { ok: true, backedUp: false }
    }

    const exists = fs.existsSync(full)
    const action: ManifestFileEntry['action'] = exists ? 'overwrite' : 'create'
    if (exists) {
      const old = fs.readFileSync(full, 'utf-8')
      if (skipIfUnchanged !== null && old === skipIfUnchanged) return { ok: true, backedUp: false } // 変化なし＝退避不要
      const dest = path.join(dir, rel)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, old, 'utf-8')
    }

    manifest.files.push({ path: rel, action })
    writeManifest(dir, manifest)
    rotate(projectDir)
    // backedUp は「旧内容を実際に退避したか」（新規作成はマニフェスト記録のみ＝false）
    return { ok: true, backedUp: exists }
  } catch (e: any) {
    return { ok: false, backedUp: false, message: e?.message ?? String(e) }
  }
}

/** write_file の実行前に呼ばれる（IPC・従来の AI Engine ツール経路）。newContent と一致すれば退避を省く。 */
export function snapshotBeforeWrite(
  projectDir: string, snapshotId: string, rel: string, newContent: string, label?: string
): { ok: boolean; backedUp: boolean; message?: string } {
  return snapshotEntry(projectDir, snapshotId, rel, newContent, label)
}

/**
 * Claude Agent SDK の Edit ツール実行前に呼ばれる（C2: claude/agent.ts の PreToolUse フックから）。
 * Edit は old_string/new_string しか分からず最終的な全文が事前に得られないため、
 * snapshotBeforeWrite と違って「変化なしなら省略」はせず、既存内容があれば常に退避する。
 */
export function snapshotBeforeChange(
  projectDir: string, snapshotId: string, rel: string, label?: string
): { ok: boolean; backedUp: boolean; message?: string } {
  return snapshotEntry(projectDir, snapshotId, rel, null, label)
}

/**
 * いま在るファイルの内容を、そのまま1つの「時点」として残す（**戻れる起点**）。
 *
 * ── なぜ要るか（2026-08-24・④ 公開されているもののインポート）────────────
 * インポートした直後のプロジェクトには履歴が1つも無い。そのまま AI に触らせると、
 * **公開されていた姿へ戻す手立てが無いまま**作業が始まる。取り込んだ直後に
 * 「その時点」を作り、何をどう壊しても戻れるようにしてから触らせる。
 *
 * 既存の snapshotBeforeWrite は使えない。あれは「これから書き換える1件の旧内容」を
 * 退避する形で、まだ無いファイルは `create` として記録される。インポート直後の
 * ファイルをそれで記録すると、**その時点へ戻したときに全部消える**（逆になる）。
 * ここは復元前の現状退避と同じ `pre-restore` 扱い（＝戻すと書き戻る）で記録する。
 *
 * copyFileSync で写すので、**画像などのバイナリも壊れない**。
 * 呼び出し側は件数の上限を自分で判断すること（ここでは黙って打ち切らない）。
 */
export function snapshotCurrentFiles(
  projectDir: string, rels: readonly string[], label?: string
): { ok: boolean; snapshotId?: string; count: number; message?: string } {
  try {
    const kept: string[] = []
    const dirs = new Set<string>()
    // スナップショットIDは写し始める前に決める（途中で日付が変わっても1つの時点にまとまる）。
    const id = nextFreeSnapshotId(
      new Date().toISOString(),
      i => fs.existsSync(path.join(backupRoot(projectDir), i))
    )
    const dir = snapshotDir(projectDir, id)
    for (const rel of rels) {
      if (rel === MANIFEST_FILENAME) continue // マニフェストと衝突する名前は残せない
      const full = confineToProject(projectDir, rel) // プロジェクトの外は触らせない
      // フォルダが紛れても写そうとしない（1件で起点づくり全体を落とさない）
      let stat: fs.Stats
      try { stat = fs.statSync(full) } catch { continue }
      if (!stat.isFile()) continue
      const dest = path.join(dir, rel)
      const parent = path.dirname(dest)
      if (!dirs.has(parent)) { fs.mkdirSync(parent, { recursive: true }); dirs.add(parent) }
      fs.copyFileSync(full, dest)
      kept.push(rel)
    }
    if (!kept.length) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 作っていなければ何もしない */ }
      return { ok: true, count: 0 }
    }
    const existsMap: Record<string, boolean> = {}
    for (const k of kept) existsMap[k] = true
    writeManifest(dir, buildPreRestoreManifest(kept, existsMap, snapshotIdToIso(id) ?? new Date().toISOString(), label))
    rotate(projectDir)
    return { ok: true, snapshotId: id, count: kept.length }
  } catch (e: any) {
    return { ok: false, count: 0, message: e?.message ?? String(e) }
  }
}

/** 「🕘 履歴」一覧（新しい順）。restoreCount / deleteCount は「その時点に戻すと何ファイルが変わるか」。 */
export function listSnapshotSummaries(projectDir: string): { ok: boolean; snapshots: SnapshotSummary[]; message?: string } {
  try {
    const all = listSnapshots(projectDir)
    const summaries: SnapshotSummary[] = all.map(({ id, manifest }) => {
      const plan = computeRestorePlanTo(all, id)
      return {
        id,
        createdAt: manifest.createdAt,
        label: manifest.label,
        fileCount: manifest.files.length,
        files: manifest.files,
        restoreCount: plan.length,
        deleteCount: plan.filter(s => s.op === 'delete').length,
      }
    })
    return { ok: true, snapshots: sortSnapshotsDesc(summaries) }
  } catch (e: any) {
    return { ok: false, snapshots: [], message: e?.message ?? String(e) }
  }
}

export type RestoreResult = {
  ok: boolean
  restored?: string[]
  deleted?: string[]
  /** 退避ファイルが見つからない等で戻せなかったもの（1件の失敗で全体を止めないため報告する）。 */
  failed?: string[]
  preRestoreSnapshotId?: string
  message?: string
}

/**
 * 「その時点の状態」へ戻す。対象スナップショット以降を畳み込むので、対象より後の作業も取り消される
 * （「3つ前のデザインに戻す」がこれで成立する。詳細は plan.ts 冒頭）。
 * 先に現状を新スナップショット（'pre-restore' / 'create'）へ退避するので、戻しすぎてもやり直せる。
 */
export function restoreToSnapshot(projectDir: string, snapshotId: string): RestoreResult {
  try {
    const all = listSnapshots(projectDir)
    if (!all.some(s => s.id === snapshotId)) {
      return { ok: false, message: '指定した履歴が見つかりませんでした（既に削除された可能性があります）' }
    }
    const plan = computeRestorePlanTo(all, snapshotId)

    // ① 現状を退避する新スナップショットを先に作る（戻す操作自体も取り消せるように）
    const existsMap: Record<string, boolean> = {}
    for (const step of plan) {
      existsMap[step.path] = fs.existsSync(confineToProject(projectDir, step.path))
    }
    // 退避先は既存と必ず別にする。同じミリ秒に2回実行されると衝突し、直前の退避を
    // 上書きして「やり直せる」保証が壊れる（plan.ts の nextFreeSnapshotId のコメント参照）。
    const preRestoreId = nextFreeSnapshotId(
      new Date().toISOString(),
      id => fs.existsSync(path.join(backupRoot(projectDir), id))
    )
    const preRestoreAt = snapshotIdToIso(preRestoreId) ?? new Date().toISOString()
    const preManifest = buildPreRestoreManifest(
      plan.map(s => s.path), existsMap, preRestoreAt, '「元に戻す」を実行する直前の状態'
    )
    const preDir = snapshotDir(projectDir, preRestoreId)
    for (const f of preManifest.files) {
      if (f.action === 'pre-restore') {
        const dest = path.join(preDir, f.path)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(confineToProject(projectDir, f.path), dest)
      }
    }
    writeManifest(preDir, preManifest)

    // ② 復元計画に従って書き戻す/削除する。
    //    1ファイルの失敗（退避ファイルが消えている等）で全体を止めず、失敗分だけ報告する
    //    （途中で例外を投げると「半分だけ戻った」状態になり、しかも何が戻ったか分からなくなる）。
    const restored: string[] = []
    const deleted: string[] = []
    const failed: string[] = []
    for (const step of plan) {
      try {
        const full = confineToProject(projectDir, step.path)
        if (step.op === 'restore') {
          const src = path.join(snapshotDir(projectDir, step.fromSnapshotId), step.path)
          fs.mkdirSync(path.dirname(full), { recursive: true })
          fs.copyFileSync(src, full)
          restored.push(step.path)
        } else {
          try { fs.unlinkSync(full) } catch { /* 既に無ければ何もしない */ }
          deleted.push(step.path)
        }
      } catch {
        failed.push(step.path)
      }
    }

    rotate(projectDir)
    return { ok: true, restored, deleted, failed, preRestoreSnapshotId: preRestoreId }
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e) }
  }
}
