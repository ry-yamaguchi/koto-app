// projectCreateFs.ts — 新規プロジェクトのフォルダ・初期ファイルをディスクへ書き出す（project:create の中身）。
//
// ipc/fs.ts の ipcMain ハンドラから分離した理由: Vitest は electron 非依存のモジュールしか
// 直接 import できない（vitest.config.ts の方針）。ここを実ファイル・mkdtemp で検証できるようにする
// （publishRootFs.ts と同じ「ディスクを見る/書く部分だけを main/*Fs.ts に置く」流儀）。

import * as fs from 'fs'
import * as path from 'path'
import { PUBLISH_DIR, placeInProject, topSegment } from '../shared/publishRoot'
import { isPublished } from '../shared/publishExclude'

export type ProjectCreateFile = { path: string; content: string }
export type ProjectCreateResult = { root: string; merged: boolean; skipped: string[] }

/**
 * プロジェクトフォルダ＋初期ファイルをディスクへ書き出す。
 *
 * @param withPublishDir 最初から `public/`（PUBLISH_DIR）を掘っておくか（改善1・2026-08-29）。
 *
 * ── なぜ呼び出し側が決めるか（ここでは target を判定しない）─────────────────
 * 「公開先が決まっている（ローカルのみ・未定ではない）」だけでは足りない。
 * さくらのレンタルサーバ向けの AI 指示（newProjectRequest.ts の sitePrompt/targetPrompt）は
 * **自分で** `public/index.html` `app/db.php` のように書き込み先の相対パスへ `public/`（と
 * 非公開の `app/`）を明示している。ここで先に `public/` を掘って書き込みの根そのものを
 * `public/` へ切り替えてしまうと、AI 自身が書く `public/…` は `public/public/…` に二重化し、
 * `app/…`（DB設定など、あえて公開先の外に置きたいもの）は書き込みの根の外なので
 * **書けなくなる**（write_file は `..` 相当の脱出を拒む・aiTools.ts の resolveInProject）。
 * つまり「先に public/ を掘って根をそこへ寄せる」やり方は、AI 指示が既に `public/` を
 * 自前で書き添えている構成（さくらのレンタルサーバ）とは相性が悪い。どの構成が
 * どちらのやり方を要るかは newProjectRequest.ts の指示文の作り方（＝呼び出し側の知識）に
 * 依存するため、判定はこの関数に持ち込まず、呼び出し側（NewProjectModal.tsx）に委ねる。
 */
export function createProjectOnDisk(
  parentDir: string,
  name: string,
  files: ProjectCreateFile[] | undefined,
  allowExisting: boolean,
  withPublishDir: boolean,
): ProjectCreateResult {
  const root = path.join(parentDir, name)
  const alreadyExisted = fs.existsSync(root)
  if (alreadyExisted && !allowExisting) {
    throw new Error(`既に同名のフォルダが存在します: ${root}`)
  }
  fs.mkdirSync(root, { recursive: true })
  // 新規プロジェクトは、対応する構成では最初から public/ を掘って始める（改善1）。
  // これが無いと、この直後にAIが初期ファイル生成を依頼された時点で public/ がまだ無いため、
  // resolvePublishRoot（shared/publishRoot.ts）はプロジェクト直下を根として返し、
  // AIの書き込みが直下へ流れてしまう（0.3.49 の public/ 修理の効果が新規プロジェクトでは
  // 一拍遅れて効くことになり、直後に「フォルダを整理する」の提案が出る一因になっていた）。
  if (withPublishDir) {
    fs.mkdirSync(path.join(root, PUBLISH_DIR), { recursive: true })
  }
  const skipped: string[] = []
  for (const f of files ?? []) {
    // 渡されたテンプレートファイルの置き場も、移行（migratePlan.ts）とまったく同じ判断
    // （placeInProject）に通す。この判断は「public/ が実在するか」を見ないので、
    // 上の withPublishDir の有無に引きずられない（無くても、公開されるものは
    // このループが書く瞬間に public/ を自動で掘る＝2026-08-20 からの既存の挙動）。
    const top = topSegment(f.path)
    const rel = placeInProject(f.path, isPublished(top, String(f.path).includes('/')))
    // prevent path traversal outside root
    const full = path.normalize(path.join(root, rel))
    if (!full.startsWith(root + path.sep) && full !== root) continue
    // when merging into an existing folder, never clobber the user's files
    if (alreadyExisted && fs.existsSync(full)) {
      skipped.push(rel)
      continue
    }
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, f.content ?? '', 'utf-8')
  }
  return { root, merged: alreadyExisted, skipped }
}
