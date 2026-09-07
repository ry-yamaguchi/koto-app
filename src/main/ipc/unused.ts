// unused.ts — 未使用ファイルの検出＋素材置き場への移動（project:unusedCheck / project:moveToMaterials）。
// あわせて roadmap #9②「ファイルの移動手段が無い」で、任意のファイルを手で移す project:moveFiles
// もここに置く（同じ「安全に移す」土台を共有するため）。
//
// ── 任意のファイルの移動（roadmap #9②・2026-09-07 追記） ──────────────────
//   ・実機で AI が「public/ の外へ移して」に応えられず、できないことをハルシネーションで
//     約束する事故があった（#9①でAI側の嘘は止めた・v0.6.3）。本命は**利用者が手で移せること**。
//   ・検証・退避・実行・ロールバック・空フォルダの片づけは、素材置き場への移動（#18・#22）と
//     まったく同じ形で成立する。**移動先が違うだけ**なので、`moveToMaterialsFs` を
//     `moveFilesToFs(projectDir, files, dest)` へ一般化し、`dest` で `MATERIALS_DIR` /
//     `PUBLISH_DIR`（shared/publishRoot.ts の一元定義）を切り替える。既存の守り
//     （confineToProject・isProtectedWritePath・nextFreeMaterialName・同一スナップショットID
//     での退避・実行段の存在チェック＋逆順ロールバック）は dest によらず共通のまま一切弱めない。
//   ・`moveFilesToFs` の `files` は**プロジェクト直下からの相対パス**で統一する（Sidebar は
//     公開の根の外側のファイルも渡すため、「根」の概念を持ち込まない）。一方
//     `moveToMaterialsFs`（＝`project:moveToMaterials`）は checkUnusedFiles が返す
//     「公開の根（resolvePublishRoot）からの相対パス」を渡す**従来の約束を変えない**
//     （呼び出し側＝UnusedFilesSection を壊さないため）。そこで薄い皮の側で
//     根→プロジェクト直下の読み替え（backupRelPath）を行ってから一般化した関数へ渡す。
//
// ── 決めごと（2026-09-03 Ryosuke と合意） ────────────────────────────────
//   ・移動するのは AI ではなく Koto の機能。利用者が一覧を確認して押したときだけ動く。
//   ・判定（何が未使用か）は shared/unusedFiles.ts の純関数に任せる。ここは IO だけ。
//
// ── Node/PHP への対応（roadmap #22・2026-09-06 追記） ────────────────────
//   ・当初は静的サイト限定だった（Node/PHP 等は動的参照で誤検知しやすい・runtimeDetect.ts）。
//     実機の Express アプリで制限を外して実測したところ、package.json・package-lock.json
//     まで「未使用」と誤判定した（shared/unusedFiles.ts の NODE_ALWAYS_USED_RE 冒頭コメント
//     参照）。そこで**対象外そのものを無くし、代わりにランタイムごとの守り
//     （extraAlwaysUsed）を追加で渡す**形にした。
//   ・ランタイムは detectRuntime（Node 判定）と .php の有無（PHP 判定）の両方を見る。
//     どちらにも当てはまれば両方の守りを合成する。
//   ・移す前に 🕘 履歴へ「移す直前」を残す。**移動元・移動先の両方**を同じスナップショットIDで
//     退避する（元＝内容退避・先＝まだ無かった印）。この2エントリで、その時点へ戻すと
//     「先を消し元を戻す」動きになり、移動そのものを取り消せる
//     （backup/plan.ts の畳み込みは追加の action 種別なしにこの構成へそのまま対応する）。
//   ・移動先の同名衝突（素材置き場に既にある／同じ一括内で basename が重複）は、全体を
//     中止せず shared/unusedFiles.ts の nextFreeMaterialName で**空いている名前を自動で採る**
//     （2026-09-04 実機で判明: 以前移動した test002 が居るだけで新しい test002 を二度と
//     移動できなかった。migrate.ts の「同名衝突は全体を中止する」とは事情が違うので
//     ここだけ方針を変えた。実行段の途中失敗（レース等）は従来どおり中止＋ロールバック）。
//   ・**書き込み経路には isProtectedWritePath を通す**（移動元・移動先の両方）。
//
// migrate.ts（既存プロジェクトを public/ の形へ移す）と実装の骨格は似ているが、独立に持つ
// （CLAUDE.md の指示により migrate.ts 自体は変更しない）。将来、両者の「安全な移動」の
// 部分（退避→rename→失敗時ロールバック）を一箇所へまとめる余地はある（未着手）。

import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { resolvePublishRoot } from '../publishRootFs'
import { projectFilesInfoFs, readFileInProjectFs } from './fs'
import { detectRuntime } from '../../shared/runtimeDetect'
import { findUnusedFiles, nextFreeMaterialName, NODE_ALWAYS_USED_RE, PHP_ALWAYS_USED_RE } from '../../shared/unusedFiles'
import type { UnusedRuntime } from '../../shared/unusedFiles'
import { MATERIALS_DIR } from '../../shared/publishExclude'
import { PUBLISH_DIR, backupRelPath } from '../../shared/publishRoot'
import { isProtectedWritePath } from '../../shared/protectedPaths'
import { snapshotBeforeChange } from '../backup/store'
import { BACKUP_DIRNAME, nextFreeSnapshotId } from '../backup/plan'

/** 一覧取得の上限。公開前セキュリティチェック（roadmap #17 追補）と同じ値に揃える。 */
const UNUSED_CHECK_MAX_FILES = 5000

// ── プロジェクト内に閉じ込めたパス解決（多層防御。fs.ts / backup/store.ts と同じ規則） ──
function confineToProject(projectDir: string, rel: string): string {
  if (path.isAbsolute(rel)) throw new Error('不正なパスです（絶対パスは指定できません）')
  const full = path.normalize(path.join(projectDir, rel))
  if (full !== projectDir && !full.startsWith(projectDir + path.sep)) {
    throw new Error('不正なパスです（プロジェクトの外は操作できません）')
  }
  return full
}

/**
 * 未使用ファイルを調べる（**何も変えない**）。project:unusedCheck の実体。
 *
 * 見るのは**実際に公開されるもの**（`public/`。無ければプロジェクト直下）。
 * ここがずれると「チェックでは0件なのに、実際は使われていないファイルが残る」ことになる
 * （securityCheck.ts と同じ理由・掟10）。
 *
 * `supported: false` は projectDir が不正なときだけ（**ランタイムでは落とさない**・
 * roadmap #22）。ランタイムは detectRuntime（Node 判定）と `.php` の有無（PHP 判定）の
 * 両方を見て、Node/PHP のどちらか（両方のこともある）なら 'dynamic'。'dynamic' のときは
 * shared/unusedFiles.ts の NODE_ALWAYS_USED_RE / PHP_ALWAYS_USED_RE を
 * findUnusedFiles の extraAlwaysUsed として渡し、実行に要るファイルを未使用扱いしない。
 *
 * 返す `unused` はここで見た根（`public/` があればその中）からの相対パス。
 * project:moveToMaterials へそのまま渡せる。
 */
export function checkUnusedFiles(projectDir: string): { supported: boolean; unused: string[]; runtime: UnusedRuntime } {
  if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) return { supported: false, unused: [], runtime: 'static' }
  const root = resolvePublishRoot(projectDir) || projectDir

  let packageJson: unknown | null = null
  try { packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')) } catch { /* 無ければ静的 */ }

  const { files } = projectFilesInfoFs(root, { maxFiles: UNUSED_CHECK_MAX_FILES, publishView: true })
  const choice = detectRuntime({ packageJson, fileNames: files.filter(f => !f.includes('/')) })

  // ランタイム判定: detectRuntime が static 以外なら Node、.php が1つでもあれば PHP。
  // 両方に当てはまることもある（PHP プロジェクトに package.json だけ置いてある等）ため、
  // その場合は両方の守りを合成して渡す。
  const isNode = choice.kind !== 'static'
  const isPhp = files.some(f => /\.php$/i.test(f))
  const runtime: UnusedRuntime = (isNode || isPhp) ? 'dynamic' : 'static'
  const extraAlwaysUsed = isNode && isPhp
    ? new RegExp(NODE_ALWAYS_USED_RE.source + '|' + PHP_ALWAYS_USED_RE.source, 'i')
    : isNode ? NODE_ALWAYS_USED_RE
    : isPhp ? PHP_ALWAYS_USED_RE
    : undefined

  const unused = findUnusedFiles(files, (rel) => {
    try { return readFileInProjectFs(root, rel) } catch { return null }
  }, extraAlwaysUsed ? { extraAlwaysUsed } : undefined)
  return { supported: true, unused, runtime }
}

export type MoveToMaterialsResult = {
  ok: boolean
  moved: string[]
  /** 🕘 履歴に「移す直前」を残せたか（取れなくても移動そのものは続ける）。 */
  snapshotOk: boolean
  /** 移動先で同名衝突があり、nextFreeMaterialName で改名して移動した分（無ければ空配列）。 */
  renamed?: { from: string; to: string }[]
  message?: string
}

/** 移動先の種類。'materials' は素材置き場（MATERIALS_DIR）、'publish' は公開されるもの（PUBLISH_DIR）。 */
export type MoveDestKind = 'materials' | 'publish'

/** 1件の移動対象（検証済みの実パスまで解決したもの）。 */
type MoveTarget = {
  /** 呼び出し側から渡された、プロジェクト直下からの相対パスそのもの。moved・renamed.from に使う。 */
  rel: string
  /** 移動先（プロジェクト直下からの相対パス。`<destDirName>/<basename>`）。 */
  destRel: string
  fromFull: string
  toFull: string
}

/**
 * ファイルを Koto 内の別の置き場（素材置き場／公開されるもの）へ移す唯一の実体。
 * project:moveToMaterials（roadmap #18・#22）と project:moveFiles（roadmap #9②・
 * 任意のファイルを手で移す）の両方がここを通る。
 *
 * `files` は**プロジェクト直下からの相対パス**として扱う（呼び出し側の責務。
 * ズレると移動が別の場所を指すため、上のコメントで基準を明示している）。
 * サブフォルダの中にあるファイルも、移動先では basename で `dest` の直下に平置きする。
 *
 * 検証（confineToProject・isProtectedWritePath を移動元・移動先の両方に）・
 * 同名衝突の自動改名（nextFreeMaterialName）・🕘 履歴への退避（移動元・移動先を同じ
 * スナップショットIDで）・実行段の存在チェックと失敗時の逆順ロールバック・
 * 移動元の親フォルダの片づけは、すべて dest によらず共通（既存の守りを一切弱めない）。
 *
 * スナップショットIDはここで発行する（呼び出し側に生成させない＝渡し忘れの余地を無くす）。
 */
export function moveFilesToFs(projectDir: string, files: readonly string[], dest: MoveDestKind): MoveToMaterialsResult {
  if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) {
    return { ok: false, moved: [], snapshotOk: false, message: 'プロジェクトフォルダのパスが不正です' }
  }
  const list = Array.from(new Set((files ?? []).filter((f): f is string => typeof f === 'string' && !!f)))
  if (!list.length) return { ok: true, moved: [], snapshotOk: true }

  const destDirName = dest === 'publish' ? PUBLISH_DIR : MATERIALS_DIR
  const label = dest === 'publish' ? `ファイルの移動（${PUBLISH_DIR}）` : `未使用ファイルの整理（${MATERIALS_DIR}）`

  // ① 検証（何も変えない）。保護パス等、名前を変えても解決しないものだけ弾く
  // （1件でも弾ければ全体を中止する・中途半端に動かさない）。
  // 移動先の同名衝突は弾かず、nextFreeMaterialName で空いている名前を自動で採る。
  const targets: MoveTarget[] = []
  // base（元のファイル名）と実際に採った名前が違う分だけ記録する（衝突が無ければ空のまま）。
  const renamed: { from: string; to: string }[] = []
  try {
    const usedDest = new Set<string>()
    for (const rel of list) {
      const fromFull = confineToProject(projectDir, rel) // .. ・絶対パスの脱出を拒否
      if (isProtectedWritePath(rel)) throw new Error(`Koto が管理する領域は移動できません: ${rel}`)

      const base = path.basename(rel)
      const name = nextFreeMaterialName(base, (candidate) => (
        usedDest.has(`${destDirName}/${candidate}`) ||
        fs.existsSync(confineToProject(projectDir, `${destDirName}/${candidate}`))
      ))
      const destRel = `${destDirName}/${name}`
      if (isProtectedWritePath(destRel)) throw new Error(`移動先が不正です: ${destRel}`)
      usedDest.add(destRel)
      const toFull = confineToProject(projectDir, destRel)
      if (name !== base) renamed.push({ from: rel, to: name })

      targets.push({ rel, destRel, fromFull, toFull })
    }
  } catch (e: any) {
    return { ok: false, moved: [], snapshotOk: false, message: e?.message ?? String(e) }
  }

  // ② 🕘 履歴へ「移す直前」を残す。**移動元・移動先の両方**を同じスナップショットIDで退避する
  // （元＝内容退避=overwrite、先＝まだ無かった印=create）。取れなくても移動は続ける
  // （履歴の欠落より作業の完了を優先する。migrate.ts と同じ方針）。
  const snapshotId = nextFreeSnapshotId(
    new Date().toISOString(),
    id => fs.existsSync(path.join(projectDir, BACKUP_DIRNAME, id)),
  )
  let snapshotOk = false
  for (const t of targets) {
    try {
      const r1 = snapshotBeforeChange(projectDir, snapshotId, t.rel, label)
      if (r1.ok) snapshotOk = true
      const r2 = snapshotBeforeChange(projectDir, snapshotId, t.destRel, label)
      if (r2.ok) snapshotOk = true
    } catch { /* 続ける */ }
  }

  // ③ 実際に動かす。途中で失敗したら、動かした分を逆順に戻す。
  const moved: string[] = []
  const touchedDirs = new Set<string>()
  try {
    fs.mkdirSync(path.join(projectDir, destDirName), { recursive: true })
    for (const t of targets) {
      if (fs.existsSync(t.toFull)) {
        // レース: ①の検証のあと・ここで実際に動かす直前に、誰かが同じ名前を作った
        // （① の時点では空きだった）。ここでも拒否せず、その場でもう一度
        // nextFreeMaterialName で採り直す（半端な状態を作らない）。
        const base = path.basename(t.rel)
        const reserved = new Set(targets.map(x => x.destRel))
        const name = nextFreeMaterialName(base, (candidate) => (
          reserved.has(`${destDirName}/${candidate}`) ||
          fs.existsSync(confineToProject(projectDir, `${destDirName}/${candidate}`))
        ))
        t.destRel = `${destDirName}/${name}`
        t.toFull = confineToProject(projectDir, t.destRel)
        if (name !== base) {
          const already = renamed.find(r => r.from === t.rel)
          if (already) already.to = name
          else renamed.push({ from: t.rel, to: name })
        }
        // 退避もその名前で行う（半端な状態を作らない）。取れなくても移動は続ける。
        try { if (snapshotBeforeChange(projectDir, snapshotId, t.destRel, label).ok) snapshotOk = true } catch { /* 続ける */ }
      }
      fs.renameSync(t.fromFull, t.toFull)
      moved.push(t.rel)
      touchedDirs.add(path.dirname(t.fromFull))
    }
  } catch (e: any) {
    // **半分だけ動いた状態を残さない。** 動かした分を逆順に戻す。
    let allRestored = true
    for (const movedRel of [...moved].reverse()) {
      const t = targets.find(x => x.rel === movedRel)!
      try { fs.renameSync(t.toFull, t.fromFull) } catch { allRestored = false }
    }
    const base = e?.message ?? String(e)
    const message = allRestored ? base : `${base}（一部は元へ戻せませんでした。🕘 履歴から戻してください）`
    return { ok: false, moved: [], snapshotOk, message }
  }

  // 移動元の親フォルダが空になったら片づける（migrate.ts と同じ作法。1階層だけ・連鎖はしない）。
  for (const dir of touchedDirs) {
    try { if (dir !== projectDir && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir) } catch { /* ignore */ }
  }

  return { ok: true, moved, snapshotOk, renamed }
}

/**
 * 未使用ファイルを「素材（公開しません）」へ移す。project:moveToMaterials の実体。
 * 一般化した moveFilesToFs（dest='materials' 固定）の薄い皮。
 *
 * `files` は checkUnusedFiles が返した相対パス（**公開の根からの相対**）をそのまま渡す
 * 想定——ここだけは従来の約束を変えない（呼び出し側＝UnusedFilesSection を壊さないため）。
 * moveFilesToFs は files を「プロジェクト直下からの相対パス」として扱うため、渡す前に
 * ここで根→プロジェクト直下の読み替え（backupRelPath）を行う。
 */
export function moveToMaterialsFs(projectDir: string, files: readonly string[]): MoveToMaterialsResult {
  if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) {
    return { ok: false, moved: [], snapshotOk: false, message: 'プロジェクトフォルダのパスが不正です' }
  }
  const root = resolvePublishRoot(projectDir) || projectDir
  const list = Array.from(new Set((files ?? []).filter((f): f is string => typeof f === 'string' && !!f)))
  const projectRelFiles = list.map(rel => backupRelPath(projectDir, root, rel))
  return moveFilesToFs(projectDir, projectRelFiles, 'materials')
}

export function registerUnusedHandlers(): void {
  ipcMain.handle('project:unusedCheck', (_, projectDir: string) => checkUnusedFiles(projectDir))
  ipcMain.handle('project:moveToMaterials', (_, projectDir: string, files: string[]) => moveToMaterialsFs(projectDir, files))
  ipcMain.handle('project:moveFiles', (_, projectDir: string, files: string[], dest: MoveDestKind) => moveFilesToFs(projectDir, files, dest))
}
