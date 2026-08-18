// dataLayer.ts — プロジェクトに koto-data.js を用意する（main 側の IO）。
//
// ── なぜ自動で置くのか（2026-08-13）──────────────────────────────────
// AI には「データの保存には koto-data を使う」と伝えてある（aiContext.ts の
// DATA_RULE）。だが**ファイルが無ければ import が失敗し、「② 試す」で落ちる**。
// 非エンジニアにとって「試すと壊れる」は致命的なので、**参照された時点で置く**。
//
// ── 上書きしないこと（重要）──────────────────────────────────────────
// 既にあるものは**絶対に上書きしない**。この層は「あとでデータベース版に
// 差し替える」ことを想定して作ってある（roadmap S-1）。差し替えたものを
// Koto が黙って元に戻すと、**利用者のデータの読み書きが突然オブジェクト
// ストレージへ戻る**。直したくなったら利用者に知らせて選ばせる。

import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { usesDataLayer, writesFilesDirectly, DATA_LAYER_FILE } from '../shared/objectStorage'
import { serverListens } from '../shared/vercelFit'

/** 走査を打ち切る条件（envDetect.ts と同じ考え方）。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'out', '.koto-data', '.sakuraide', '.sakuraide-backup', '.sakura-cloud', 'vendor', '__pycache__'])
const EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py'])
const MAX_FILES = 2000
const MAX_BYTES = 512 * 1024

/** 同梱しているテンプレートの場所。開発時とパッケージ版の両方に対応する。 */
function templatePath(): string {
  const candidates = [
    path.join(app.getAppPath(), 'templates', DATA_LAYER_FILE),
    path.join(process.cwd(), 'templates', DATA_LAYER_FILE),
  ]
  for (const p of candidates) if (fs.existsSync(p)) return p
  throw new Error(`${DATA_LAYER_FILE} のテンプレートが見つかりません`)
}

export type DataLayerScan = {
  /** koto-data を使っているファイル（相対パス）。 */
  usedBy: string[]
  /** 自分でファイルに書き込んでいるファイル（相対パス）。**静かに壊れる形。** */
  writesFiles: string[]
  /**
   * 自分でポートを待ち受けているファイル（相対パス）。
   *
   * Vercel の確認で使う（2026-08-15）。**歩き回る処理を二つ持たない**ため、
   * ここで一緒に集める（同じファイルを二度読まない）。
   */
  listens: string[]
}

/** プロジェクトを走査して、データの扱いを調べる。 */
export function scanDataUsage(projectDir: string): DataLayerScan {
  const usedBy: string[] = []
  const writesFiles: string[] = []
  const listens: string[] = []
  let scanned = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > 8 || scanned >= MAX_FILES) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (scanned >= MAX_FILES) return
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1)
        continue
      }
      if (!EXTS.has(path.extname(e.name))) continue
      if (e.name === DATA_LAYER_FILE) continue // 層そのものは対象外
      let text: string
      try {
        if (fs.statSync(full).size > MAX_BYTES) continue
        text = fs.readFileSync(full, 'utf8')
      } catch { continue }
      scanned++
      const rel = path.relative(projectDir, full)
      if (usesDataLayer(text)) usedBy.push(rel)
      else if (writesFilesDirectly(text)) writesFiles.push(rel)
      // **これは別の観点**（データの扱いではなく起動の形）なので else にしない
      if (serverListens(text)) listens.push(rel)
    }
  }
  walk(projectDir, 0)
  return { usedBy, writesFiles, listens }
}

/**
 * koto-data.js が要るなら置く。**既にあれば触らない。**
 *
 * @returns 置いたら true、既にある・要らないなら false
 */
export function ensureDataLayer(projectDir: string): boolean {
  if (!projectDir) return false
  const dest = path.join(projectDir, DATA_LAYER_FILE)
  if (fs.existsSync(dest)) return false // **上書きしない**（差し替えられている可能性がある）
  const scan = scanDataUsage(projectDir)
  if (scan.usedBy.length === 0) return false
  fs.copyFileSync(templatePath(), dest)
  // **読み取りだけを足す。** copyFileSync は元の権限を引き継ぐため、アプリの中の
  // （asar 内の）テンプレートによっては 0600 で置かれる。それがそのままコンテナへ
  // 入ると、Node が自分のファイルを読めず
  // `EACCES: permission denied, open '/app/koto-data.js'` で起動に失敗する
  // （2026-08-14 実機。原因が容器の中にあるので、症状から辿るのが非常に難しい）。
  // 書き込み権限は与えない。ここは利用者のプロジェクト内のファイルなので、
  // **必要な分だけ**にする（Ryosuke の点検・2026-08-14）。
  try {
    const mode = fs.statSync(dest).mode & 0o7777
    if ((mode & 0o444) !== 0o444) fs.chmodSync(dest, mode | 0o444)
  } catch { /* 権限を変えられなくても置けてはいる */ }
  return true
}
