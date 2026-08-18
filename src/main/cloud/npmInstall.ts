// npmInstall.ts — 依存ライブラリを、持っていける形で用意する（main の IO）。
//
// ── なぜ手元で入れるのか（改善案 1-5・2026-08-18）──────────────────────
// 内蔵ビルダーは Docker を使わない。`node:22-alpine` の上に**プロジェクトの
// ファイルを1層足す**だけなので、コンテナの中で `npm install` を走らせる場所が無い。
// だから**手元で入れて、その `node_modules` ごと持っていく**。
//
// ── 守り ────────────────────────────────────────────────────────────
// 1. `--ignore-scripts`。**ライブラリの後付けスクリプトを走らせない。**
//    公開のたびに、素性の分からないコードが利用者のパソコンで動くのは筋が悪い
//    （そして、走らせても macOS 用の部品ができるだけで、公開先では動かない）。
// 2. `--omit=dev`。動かすのに要らないものは持っていかない（重くなるだけ）。
// 3. 入れたあとに `.node` を探す。**あれば持っていかない**（判断は shared/deps.ts）。
// 4. 引数は配列で渡す（シェル文字列にしない）。

import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import { isNativeBinary } from '../../shared/deps'

/**
 * 公開先の形（`imageBuild.ts` の土台イメージ `node:22-alpine` と crane の既定）。
 *
 * **古い npm は知らない指定を黙って無視する**（実測: 未知の指定でも終了コード0）ので、
 * 付けたままで壊れない。
 */
const TARGET_PLATFORM_ARGS = ['--os=linux', '--cpu=x64', '--libc=musl'] as const

/** npm の実行を待つ上限。ライブラリが多いと数分かかる。 */
const INSTALL_TIMEOUT = 10 * 60 * 1000
const MAX_BUFFER = 8 * 1024 * 1024

export type InstallResult = {
  ok: boolean
  /** 入れたあとに見つかった、持っていけない部品（相対パス）。 */
  nativeFiles: string[]
  /** 失敗したときの出力（診断用・そのまま画面に出せる長さに切る）。 */
  log: string
  message?: string
}

/** npm が使えるか（PATH は main 起動時にログインシェルのものへ揃えてある）。 */
export function npmAvailable(): Promise<boolean> {
  return new Promise(resolve => {
    execFile('npm', ['--version'], { timeout: 15000 }, err => resolve(!err))
  })
}

/** `.node` を探す（深さ優先・上限つき）。 */
function findNativeBinaries(root: string, limit = 50): string[] {
  const found: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (found.length >= limit || depth > 12) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (found.length >= limit) return
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (isNativeBinary(e.name)) found.push(path.relative(root, full))
    }
  }
  walk(root, 0)
  return found
}

/**
 * ステージングした `app/` の中で依存ライブラリを用意する。
 *
 * **package.json が無い、または依存が無いときは何もしない**（呼び出し側で判断済みでも、
 * ここでも確かめる。無駄に npm を走らせない）。
 */
export async function installDependencies(
  appDir: string,
  onProgress?: (message: string) => void,
): Promise<InstallResult> {
  const pkgPath = path.join(appDir, 'package.json')
  if (!fs.existsSync(pkgPath)) return { ok: true, nativeFiles: [], log: '' }

  if (!(await npmAvailable())) {
    return {
      ok: false, nativeFiles: [], log: '',
      message: 'このアプリはライブラリを使っていますが、それを用意する道具（npm）が見つかりませんでした。'
        + 'Node.js をインストールしてから、もう一度お試しください。',
    }
  }

  onProgress?.('📚 ライブラリを用意しています…（時間がかかることがあります）')
  const r = await new Promise<{ ok: boolean; out: string }>(resolve => {
    execFile(
      'npm',
      [
        'install',
        '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error',
        // ── **公開先の形で入れる**（2026-08-18 実測で発覚）────────────────
        // 何も指定しないと、npm は**このパソコンの形**（macOS / arm64）に合う
        // 部品を選ぶ。実測: `esbuild` を入れると `@esbuild/darwin-arm64` が入り、
        // 中身は **Mach-O（macOS 用の実行ファイル）**だった。`.node` ではないので
        // 見つける仕掛けにも掛からず、**そのまま公開されて起動しない**。
        // 公開先（Alpine Linux / amd64）を指定すると `@esbuild/linux-x64`（ELF）が入る。
        ...TARGET_PLATFORM_ARGS,
        // 同じものを何度も取りに行かない（2回目以降はキャッシュから。実測 0.3秒）
        '--prefer-offline',
      ],
      { cwd: appDir, timeout: INSTALL_TIMEOUT, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout ?? ''}${stderr ?? ''}`.trim() }),
    )
  })
  const log = r.out.slice(0, 4000)
  if (!r.ok) {
    return {
      ok: false, nativeFiles: [], log,
      message: 'ライブラリを用意できませんでした。package.json に書かれた名前が正しいか、'
        + 'インターネットに繋がっているかを確かめてください。',
    }
  }

  const modules = path.join(appDir, 'node_modules')
  const nativeFiles = fs.existsSync(modules) ? findNativeBinaries(modules) : []
  return { ok: true, nativeFiles, log }
}
