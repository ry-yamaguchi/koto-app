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

  // 雛形が自分で public/ を明示しているなら、その構造をそのまま使う（移行の判断を通さない）。
  //
  // ── なぜ要るか（roadmap #6・2026-09-07 実測で再現）─────────────────────
  // さくらのレンタルサーバ雛形（rentalServerFiles・NewProjectModal.tsx）は
  // `public/index.php` `app/db.php` `deploy.sh` のように、**雛形自身が**公開先（public/）と
  // 非公開（app/ 直下・deploy.sh）を書き分けている。ところが従来はここで全ファイルを
  // 無条件に placeInProject（＝既存プロジェクトを public/ 構成へ「移行」するときの判断）へ
  // 通していた。placeInProject は isPublished（除外リストに載っていないか）しか見ないため
  // `app` も `deploy.sh` も「公開扱い」と判定され、実測では次のように壊れていた:
  //   app/db.php              → public/app/db.php        （DB接続情報が公開領域へ）
  //   app/config.sample.php   → public/app/config.sample.php
  //   deploy.sh                → public/deploy.sh          （サーバー名・パス等が丸ごとHTTPで読める）
  //   .gitignore / README.md   → public/ の中
  // レンタルサーバの公開は public/ の中身をそのまま ~/www/ へ送るため、上のいずれも
  // 2026-08-05 の `.sakuraide` 流出・08-09 の `.env` 流出と同じ「公開領域への混入」になる。
  //
  // 実測で確認したのは「public/ を明示しているのはレンタルサーバ雛形だけ」ということ
  // （AppRun・React・Node・Python・静的サイト等の他の雛形は public/ という語を使わない）。
  // だからこの分岐は他の雛形の挙動を一切変えない。
  const templateDeclaresPublishDir = (files ?? []).some(
    f => String(f?.path ?? '').replace(/^\.?\//, '').startsWith(PUBLISH_DIR + '/'),
  )

  const skipped: string[] = []
  for (const f of files ?? []) {
    // 雛形が public/ を自分で明示しているときは、その相対パスをそのまま使う
    // （placeInProject を通さない＝移行の判断に巻き込まない）。
    // そうでないときは従来どおり、移行（migratePlan.ts）とまったく同じ判断
    // （placeInProject）に通す。この判断は「public/ が実在するか」を見ないので、
    // 上の withPublishDir の有無に引きずられない（無くても、公開されるものは
    // このループが書く瞬間に public/ を自動で掘る＝2026-08-20 からの既存の挙動）。
    const rel = templateDeclaresPublishDir
      ? String(f.path ?? '').replace(/^\.?\//, '').replace(/\\/g, '/')
      : placeInProject(f.path, isPublished(topSegment(f.path), String(f.path).includes('/')))
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
