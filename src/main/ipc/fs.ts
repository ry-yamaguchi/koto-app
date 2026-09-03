// ファイルシステムの IPC（fs:* ・ project:create）。watcher の Map（dirWatchers）はモジュール内に保持する。
// deps: getMainWindow（fs:openDialog / fs:pickDirectory のダイアログ親ウィンドウに使用）。
import { app, dialog, ipcMain, shell } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import type { IpcDeps } from './types'

// ── AI専用：プロジェクト内に閉じ込めたファイル読み書き（多層防御） ──
// rel はプロジェクトルートからの相対パス。絶対パスや .. での脱出は拒否する。
import { destinationDir, uniqueName, isImageFileName, type AssetPurpose } from '../../shared/assetImport'
import { canTrash } from '../../shared/trashGuard'
import { createProjectOnDisk } from '../projectCreateFs'
import { publishExcludedDirNames, excludedFileNames } from '../../shared/publishExclude'

function confineToProject(projectDir: string, rel: string): string {
  if (path.isAbsolute(rel)) throw new Error('不正なパスです（絶対パスは指定できません）')
  const full = path.normalize(path.join(projectDir, rel))
  if (full !== projectDir && !full.startsWith(projectDir + path.sep)) {
    throw new Error('不正なパスです（プロジェクトの外は操作できません）')
  }
  return full
}

// ── プロジェクト走査の共通除外規則 ──
// 重い/自動生成フォルダ名の禁止リスト。隠しフォルダ全般（.git / .sakuraide-backup / .sakuraide 等）は
// 名前の先頭が「.」であることで併せて除外する。fs:projectFiles（AIへの一覧提示）と
// fs:searchInProject（横断検索）の両方がこの関数を通して同じ除外規則を共有する（二重に持たない）。
const WALK_IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', '__pycache__', '.venv', 'bin', 'lib', 'include', '.next', 'out'])

/** フォルダ／ファイルを歩くときにどれを飛ばすかの規則。呼び出し側ごとに差し替えられる。 */
type WalkRule = {
  /** true を返したフォルダは丸ごと飛ばす（配下は歩かない）。 */
  skipDir: (name: string) => boolean
  /** true を返したファイルは一覧に含めない。 */
  skipFile: (name: string) => boolean
}

/**
 * 既定の除外規則（従来どおり・1文字も変えない）。
 * WALK_IGNORE_DIRS ＋ ドット始まりフォルダを丸ごと除外。ファイルは `.sakuraide.json` のみ除外
 * （`.DS_Store` 等はここでは除外しない＝fs:projectFiles / fs:searchInProject の挙動を変えないため）。
 */
const DEFAULT_WALK_RULE: WalkRule = {
  skipDir: (name) => WALK_IGNORE_DIRS.has(name) || name.startsWith('.'),
  skipFile: (name) => name === '.sakuraide.json',
}

// ── 公開基準の除外規則（roadmap #17 追補・2026-09-03）──────────────────────
// 公開前セキュリティチェックが「見ている一覧」と「実際に公開されるもの」がずれていた
// （dist/build/out/.well-known 等のドット始まりでないフォルダ・build/out 等は、
// 実際の公開経路（vercel/client.ts の collectDeployFiles・imageBuild.ts の copyTree）では
// 除外されていないのに、既定の WALK_IGNORE_DIRS が広く飛ばしていたため検査の目に入らなかった）。
// **一元定義（publishExclude.ts）をそのまま使う**（掟10: 除外リストは手で並べ直さない）。
// フォルダは publishExcludedDirNames()（HEAVY_DIRS＋KOTO_INTERNAL_DIRS＋PUBLISH_ONLY_DIRS）だけを飛ばし、
// ドット始まりの一律除外はやめる。ファイルは excludedFileNames()（NOISE_FILES＋KOTO_INTERNAL_FILES）を飛ばす
// （どちらも公開されないため。秘密ファイルの判定はここでは行わない＝securityCheck.ts 側が中身を見ずに判定する）。
const PUBLISH_VIEW_DIR_NAMES = publishExcludedDirNames()
const PUBLISH_VIEW_FILE_NAMES = excludedFileNames()
const PUBLISH_VIEW_WALK_RULE: WalkRule = {
  skipDir: (name) => PUBLISH_VIEW_DIR_NAMES.has(name),
  skipFile: (name) => PUBLISH_VIEW_FILE_NAMES.has(name),
}

/**
 * プロジェクト配下を再帰的に走査し、対象ファイル（相対パス・絶対パス）を1件ずつ onFile へ渡す。
 * onFile が false を返した時点で走査を打ち切る（マッチ数上限などで早期終了したいときに使う）。
 * 戻り値: 実際に走査したファイル数と、上限（maxFiles/深さ/onFileの早期終了）で打ち切ったかどうか。
 *
 * `truncated` は「一覧が全件ではない」ことを表す。以前は maxFiles 到達時にしか立たなかったが、
 * **深さの打ち切り（maxDepth）で実在するフォルダを黙って捨てるケースも truncated に含める**
 * （2026-09-03・roadmap #17 追補。黙って欠けない＝掟10）。searchInProjectFs の truncated の意味は
 * 「マッチ上限 or 走査上限」から「走査しきれていない」へわずかに広がるが、意味としては正しくなる。
 */
function walkProjectFiles(
  dir: string,
  maxFiles: number,
  onFile: (rel: string, full: string) => boolean | void,
  opts: { maxDepth?: number; rule?: WalkRule } = {}
): { count: number; truncated: boolean } {
  const maxDepth = opts.maxDepth ?? 6
  const rule = opts.rule ?? DEFAULT_WALK_RULE
  let count = 0
  let truncated = false
  let stoppedByCallback = false
  const walk = (d: string, rel: string, depth: number) => {
    if (stoppedByCallback) return
    if (depth > maxDepth) { truncated = true; return } // 実在するフォルダを深さで捨てた＝正直に truncated
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (stoppedByCallback) return
      if (count >= maxFiles) { truncated = true; return }
      if (e.isDirectory()) {
        if (!rule.skipDir(e.name)) walk(path.join(d, e.name), rel + e.name + '/', depth + 1)
      } else if (!rule.skipFile(e.name)) {
        count++
        if (onFile(rel + e.name, path.join(d, e.name)) === false) { stoppedByCallback = true; return }
      }
    }
  }
  walk(dir, '', 0)
  return { count, truncated }
}

// ── AIツール実行の main 直呼び用（B'-3d-2b）─────────────────────────────
// 中身は従来のハンドラをそのまま関数として切り出したもの（振る舞いは1文字も変えない）。
// ipcMain.handle 側はこれらを呼ぶだけの薄い形にする。main/chat/turnRunner.ts の
// buildMainIo が io.readFileInProject / io.writeFileInProject / io.projectFiles /
// io.searchInProject としてそのまま使う。

export function readFileInProjectFs(projectDir: string, rel: string): string {
  return fs.readFileSync(confineToProject(projectDir, rel), 'utf-8')
}

export function writeFileInProjectFs(projectDir: string, rel: string, content: string): void {
  const full = confineToProject(projectDir, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf-8')
}

/** プロジェクトのファイル一覧（AIへ渡す構成把握用。重いフォルダは除外）。fs:projectFiles の実体。 */
export function projectFilesFs(dir: string, maxFiles = 200): string[] {
  const out: string[] = []
  walkProjectFiles(dir, maxFiles, (rel) => { out.push(rel) })
  return out
}

/**
 * プロジェクトのファイル一覧＋**一覧そのものが打ち切られたか**。fs:projectFilesInfo の実体。
 *
 * `projectFilesFs`（fs:projectFiles）は walkProjectFiles が返す truncated を捨てているため、
 * 呼び出し側は「200件（既定）で打ち切られた部分検査」を「全件を見た完全な検査」と区別できない
 * （公開前セキュリティチェック・roadmap #17 で判明。互換性のため fs:projectFiles 自体は残す）。
 *
 * `opts.publishView`（既定 false）: true のとき、除外規則を**公開と同じ定義**
 * （PUBLISH_VIEW_WALK_RULE＝publishExcludedDirNames()＋excludedFileNames()）に差し替える。
 * false（既定）のときは従来どおり DEFAULT_WALK_RULE（WALK_IGNORE_DIRS＋ドット始まり全除外）のまま。
 * `opts.maxFiles`（既定 200）はそのまま渡す。
 */
export function projectFilesInfoFs(
  dir: string,
  opts?: { maxFiles?: number; publishView?: boolean }
): { files: string[]; truncated: boolean } {
  const maxFiles = opts?.maxFiles ?? 200
  const rule = opts?.publishView ? PUBLISH_VIEW_WALK_RULE : undefined
  const out: string[] = []
  const { truncated } = walkProjectFiles(dir, maxFiles, (rel) => { out.push(rel) }, { rule })
  return { files: out, truncated }
}

/** AIの search_in_files ツール：プロジェクト内の全文検索。fs:searchInProject の実体（下のハンドラと同じ規則）。 */
export function searchInProjectFs(
  projectDir: string, query: string, pathPattern?: string
): { ok: boolean; matches: { path: string; line: number; text: string }[]; scanned: number; truncated: boolean; message?: string } {
  const MAX_SCAN = 500
  const MAX_MATCHES = 100
  const MAX_FILE_BYTES = 1024 * 1024 // 1MB
  const MAX_LINE_CHARS = 200
  try {
    const q = String(query ?? '')
    if (!q.trim()) return { ok: false, matches: [], scanned: 0, truncated: false, message: '検索文字列が空です' }
    const qLower = q.toLowerCase()
    // 簡易パターン（* のみワイルドカード）→ 正規表現。他の記号はすべてエスケープしリテラル扱いにする。
    const pat = (pathPattern ?? '').trim()
    const patRe = pat
      ? new RegExp(pat.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*'), 'i')
      : null

    const matches: { path: string; line: number; text: string }[] = []
    let matchLimitHit = false
    const { count: scanned, truncated: scanTruncated } = walkProjectFiles(projectDir, MAX_SCAN, (rel, full) => {
      if (patRe && !patRe.test(rel)) return
      let stat: fs.Stats
      try { stat = fs.statSync(full) } catch { return }
      if (stat.size > MAX_FILE_BYTES) return
      let content: string
      try { content = fs.readFileSync(full, 'utf-8') } catch { return }
      if (content.includes('\u0000')) return // バイナリらしきファイルは飛ばす
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(qLower)) {
          let text = lines[i].trim()
          if (text.length > MAX_LINE_CHARS) text = text.slice(0, MAX_LINE_CHARS - 1) + '…'
          matches.push({ path: rel, line: i + 1, text })
          if (matches.length >= MAX_MATCHES) { matchLimitHit = true; return false }
        }
      }
    })
    return { ok: true, matches, scanned, truncated: scanTruncated || matchLimitHit }
  } catch (e: any) {
    return { ok: false, matches: [], scanned: 0, truncated: false, message: e?.message ?? String(e) }
  }
}

export function registerFsHandlers(deps: IpcDeps) {
  // File system IPC
  ipcMain.handle('fs:readFile', async (_, filePath: string) => {
    return fs.readFileSync(filePath, 'utf-8')
  })

  ipcMain.handle('fs:writeFile', async (_, filePath: string, content: string) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true }) // 親フォルダが無ければ作成
    fs.writeFileSync(filePath, content, 'utf-8')
  })

  ipcMain.handle('fs:readFileInProject', (_, projectDir: string, rel: string) => readFileInProjectFs(projectDir, rel))

  ipcMain.handle('fs:writeFileInProject', (_, projectDir: string, rel: string, content: string) =>
    writeFileInProjectFs(projectDir, rel, content))

  ipcMain.handle('fs:openDialog', async (_, opts?: { filters?: { name: string; extensions: string[] }[] }) => {
    const result = await dialog.showOpenDialog(deps.getMainWindow()!, {
      properties: opts?.filters ? ['openFile'] : ['openFile', 'openDirectory'],
      ...(opts?.filters ? { filters: opts.filters } : {}),
    })
    return result.filePaths[0] ?? null
  })

  ipcMain.handle('fs:readDir', async (_, dirPath: string) => {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    return entries.map(e => ({ name: e.name, isDir: e.isDirectory(), path: path.join(dirPath, e.name) }))
  })

  // Pick a directory only (for choosing where to create a new project)
  ipcMain.handle('fs:pickDirectory', async () => {
    const result = await dialog.showOpenDialog(deps.getMainWindow()!, {
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '選択',
    })
    return result.filePaths[0] ?? null
  })

  // Check whether a path already exists
  ipcMain.handle('fs:exists', async (_, p: string) => fs.existsSync(p))

  // 画像などのバイナリを base64 で読む（エディタ内プレビュー用）
  ipcMain.handle('fs:readFileBase64', async (_, filePath: string) => {
    return fs.readFileSync(filePath).toString('base64')
  })

  // Finderからのドラッグ＆ドロップ取り込み：外部ファイルをプロジェクトへコピーする
  /**
   * 手元のファイルをプロジェクトへ複製する。
   *
   * **入れ先の判断は shared/assetImport.ts に集約**（2026-08-19）。
   * ここで独自に決めると、画面の説明と実際の場所がずれる。
   *
   * `purpose`:
   *   'app'      … アプリで使う（`public/` があれば `public/images/`、無ければ `images/`）
   *   'material' … 素材として置く（`素材（公開しません）/`。**公開先へは出ない**）
   */
  ipcMain.handle('fs:importFile', async (_, args: { src: string; projectDir: string; purpose?: AssetPurpose }) => {
    const purpose: AssetPurpose = args.purpose === 'material' ? 'material' : 'app'
    const name = path.basename(args.src)
    let topLevel: string[] = []
    try { topLevel = fs.readdirSync(args.projectDir) } catch { topLevel = [] }

    // 画像でないものは、これまでどおりプロジェクト直下へ置く（素材は指定どおり）
    const relDir = isImageFileName(name) || purpose === 'material'
      ? destinationDir(purpose, topLevel)
      : ''
    const destDir = relDir ? confineToProject(args.projectDir, relDir) : args.projectDir
    fs.mkdirSync(destDir, { recursive: true })

    let existing: string[] = []
    try { existing = fs.readdirSync(destDir) } catch { existing = [] }
    const dest = path.join(destDir, uniqueName(name, existing))
    fs.copyFileSync(args.src, dest)
    // **読み取りだけを足す**（2026-08-14 の EACCES と同じ轍を踏まない）。
    // 手元が 0600 のままだと、公開したコンテナの中で読めない
    try {
      const mode = fs.statSync(dest).mode & 0o7777
      fs.chmodSync(dest, mode | 0o444)
    } catch { /* 権限を変えられなくても複製自体は成立している */ }
    return path.relative(args.projectDir, dest) // 例: public/images/logo.png
  })

  /**
   * チャットに添付した画像を、そのままプロジェクトへ入れる（2026-08-19）。
   *
   * 添付は**本文（data URL）として手元にある**ので、元ファイルの場所を追わなくてよい。
   * 貼り付けた画像（元ファイルが無い）も同じ道で入れられる。
   * 入れ先の判断は shared/assetImport.ts に集約。
   */
  ipcMain.handle('fs:importImageData', async (_, args: { projectDir: string; name: string; dataUrl: string; purpose?: AssetPurpose }) => {
    try {
      const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(args.dataUrl ?? ''))
      if (!m) return { ok: false, message: '画像の形式を読み取れませんでした' }
      const purpose: AssetPurpose = args.purpose === 'material' ? 'material' : 'app'
      let topLevel: string[] = []
      try { topLevel = fs.readdirSync(args.projectDir) } catch { topLevel = [] }
      const relDir = destinationDir(purpose, topLevel)
      const destDir = confineToProject(args.projectDir, relDir)
      fs.mkdirSync(destDir, { recursive: true })
      let existing: string[] = []
      try { existing = fs.readdirSync(destDir) } catch { existing = [] }
      const dest = path.join(destDir, uniqueName(args.name, existing))
      fs.writeFileSync(dest, Buffer.from(m[2], 'base64'))
      // **読み取りだけを足す**（2026-08-14 の EACCES と同じ轍を踏まない）
      try {
        const mode = fs.statSync(dest).mode & 0o7777
        fs.chmodSync(dest, mode | 0o444)
      } catch { /* 権限を変えられなくても複製自体は成立している */ }
      return { ok: true, rel: path.relative(args.projectDir, dest) }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  // ファイルをゴミ箱へ（完全削除はしない）
  // ── ゴミ箱は「ホームの深さ2以上」だけ（2026-08-20 セキュリティ点検）──────
  // どんな絶対パスでも送れる作りだった。到達する道はいま無いが、1枚目の守りに
  // 頼り切らない。判断は shared/trashGuard.ts（テスト付き）。
  ipcMain.handle('fs:trash', async (_, p: string) => {
    // home は fs:homeDir と同じ os.homedir() を使う（別ソースだと HOME 差し替え時に
    // ワークスペースの home とガードの home がズレる）
    const check = canTrash(os.homedir(), path.resolve(String(p ?? '')), path.sep)
    if (!check.ok) throw new Error(check.reason)
    return shell.trashItem(path.resolve(String(p)))
  })
  // リネーム（同フォルダ内での名前変更のみ）
  ipcMain.handle('fs:rename', async (_, oldPath: string, newName: string) => {
    if (!newName || newName.includes('/') || newName.includes('..')) throw new Error('不正なファイル名です')
    const newPath = path.join(path.dirname(oldPath), newName)
    if (fs.existsSync(newPath)) throw new Error('同名のファイルが既に存在します')
    fs.renameSync(oldPath, newPath)
    return newPath
  })

  // ── フォルダ監視（ファイルツリーの自動更新用） ──
  const dirWatchers = new Map<number, fs.FSWatcher>()
  let watchId = 0

  ipcMain.handle('fs:watch', (event, dir: string) => {
    const id = ++watchId
    let timer: NodeJS.Timeout | null = null
    try {
      const watcher = fs.watch(dir, { recursive: true }, (_e, filename) => {
        const f = String(filename ?? '')
        // 巨大フォルダ由来のイベントの嵐を避ける
        if (f.includes('node_modules') || f.includes('.git')) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          if (!event.sender.isDestroyed()) event.sender.send(`fs:changed:${id}`)
        }, 400)
      })
      dirWatchers.set(id, watcher)
      return id
    } catch {
      return -1 // 監視できない環境では手動更新のみ
    }
  })

  ipcMain.handle('fs:unwatch', (_, id: number) => {
    dirWatchers.get(id)?.close()
    dirWatchers.delete(id)
  })

  // Home directory (used to derive the default workspace root)
  // ⚠️ app.getPath('home') は macOS では $HOME を見ない（passwd 由来・2026-09-02 実測）。
  // os.homedir() は $HOME を尊重するため、smoke / e2e driver が env の HOME 差し替えで
  // 実ワークスペース（~/SAKURAIDE）を使い捨て領域へ隔離できる。通常利用では両者は同値。
  ipcMain.handle('fs:homeDir', () => os.homedir())

  // プロジェクトのファイル一覧（AIへ渡す構成把握用。重いフォルダは除外）
  ipcMain.handle('fs:projectFiles', async (_, dir: string, maxFiles = 200) => projectFilesFs(dir, maxFiles))

  // 同上＋一覧そのものが打ち切られたか（公開前セキュリティチェックが「部分検査を完全検査の
  // 顔で報告しない」ために使う。fs:projectFiles は互換のためそのまま残す）。
  // opts.publishView: true で除外規則を「公開と同じ定義」に差し替える（roadmap #17 追補）。
  ipcMain.handle('fs:projectFilesInfo', async (_, dir: string, opts?: { maxFiles?: number; publishView?: boolean }) =>
    projectFilesInfoFs(dir, opts))

  // AIの search_in_files ツール：プロジェクト内の全文検索（単純な部分一致・大文字小文字は区別しない。
  // 正規表現は受け付けない）。走査は fs:projectFiles と同じ除外規則（walkProjectFiles）を共有する。
  // バイナリ（NUL文字を含む内容）・1MB超のファイルは飛ばす。走査500件・マッチ100件で打ち切る。
  ipcMain.handle('fs:searchInProject', async (_, projectDir: string, query: string, pathPattern?: string) =>
    searchInProjectFs(projectDir, query, pathPattern))

  // プロジェクトの最終変更時刻（③公開の「公開状況」表示で、公開後にコードが変わっていないかの判定に使う）。
  // 「📡 公開したもの一覧」（PublishedListModal）用: ワークスペース配下の各プロジェクトから
  // 公開記録だけを集めて返す。**これは Koto がローカルに持つ記録であって、各サービスの現在の状態ではない**
  // （サービス側で削除されていても記録は残る。呼び出し側UIでその旨を明示すること）。
  // APIキー・ネットワークを一切使わないため、サービス側の障害中でも参照できる（この機能の主目的・2026-07-31）。
  ipcMain.handle('fs:publishedRecords', async (_, workspaceDir: string) => {
    try {
      if (!workspaceDir || !fs.existsSync(workspaceDir)) return { ok: true, projects: [] }
      const projects: { dir: string; name: string; publish: unknown; apprunState: unknown }[] = []
      for (const e of fs.readdirSync(workspaceDir, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue
        const dir = path.join(workspaceDir, e.name)
        let meta: any = null
        try { meta = JSON.parse(fs.readFileSync(path.join(dir, '.sakuraide.json'), 'utf-8')) } catch { /* メタ無し・壊れている */ }
        let apprunState: unknown = null
        try { apprunState = JSON.parse(fs.readFileSync(path.join(dir, '.sakura-cloud', 'state.json'), 'utf-8')) } catch { /* 無し */ }
        if (!meta && !apprunState) continue // 公開に関係しないフォルダは載せない
        projects.push({
          dir,
          name: typeof meta?.name === 'string' && meta.name ? meta.name : e.name,
          publish: meta?.publish ?? null,
          apprunState,
        })
      }
      return { ok: true, projects }
    } catch (e: any) {
      return { ok: false, projects: [], message: e?.message ?? String(e) }
    }
  })

  // envDetect.ts の SKIP_DIRS と同等の除外＋ルートの .sakuraide.json 自体は対象外（メタ書き込みを「コード変更」と誤認しないため）。
  // 上限 2000 ファイル・深さ 8（envDetect と同じ防御）。
  ipcMain.handle('fs:latestChangeAt', async (_, projectDir: string) => {
    const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'out', '.sakuraide-backup', '.sakuraide', '.sakura-cloud', '.vscode', 'vendor', '__pycache__'])
    const MAX_FILES = 2000
    let files = 0
    let latestMs = 0
    const walk = (dir: string, rel: string, depth: number): void => {
      if (depth > 8 || files >= MAX_FILES) return
      let entries: fs.Dirent[]
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const ent of entries) {
        if (files >= MAX_FILES) return
        const full = path.join(dir, ent.name)
        if (ent.isDirectory()) {
          if (SKIP_DIRS.has(ent.name)) continue
          walk(full, rel + ent.name + '/', depth + 1)
        } else if (ent.isFile()) {
          if (rel === '' && ent.name === '.sakuraide.json') continue // メタ書き込みはコード変更として扱わない
          let st: fs.Stats
          try { st = fs.statSync(full) } catch { continue }
          files++
          if (st.mtimeMs > latestMs) latestMs = st.mtimeMs
        }
      }
    }
    try {
      walk(projectDir, '', 0)
      return { ok: true, latest: latestMs > 0 ? new Date(latestMs).toISOString() : null, files }
    } catch (e: any) {
      return { ok: false, latest: null, files: 0, message: e?.message ?? String(e) }
    }
  })

  // Create a new project: folder + initial files
  // allowExisting: when true, write into an existing folder WITHOUT overwriting files that already exist.
  // withPublishDir: 最初から public/ を掘っておくか（改善1・2026-08-29）。実処理は
  // projectCreateFs.ts（electron非依存・実ファイルでテストできる）に切り出してある。
  ipcMain.handle(
    'project:create',
    async (
      _,
      parentDir: string,
      name: string,
      files: { path: string; content: string }[],
      allowExisting = false,
      withPublishDir = false
    ) => createProjectOnDisk(parentDir, name, files, allowExisting, withPublishDir)
  )
}
