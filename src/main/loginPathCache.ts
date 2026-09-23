// loginPathCache.ts — ログインシェルの PATH を「覚えておく」場所（2026-09-16・D-16 A）。
//
// ── なぜ ────────────────────────────────────────────────────────────
// loginPath.ts の applyLoginPath() は起動のたびにログインシェルを**同期で**起こして待っていた。
// 実測（2026-09-16・この機械）で `zsh -lc 'echo $PATH'` に **1.22 秒**。3 秒の上限に達して
// 打ち切られた起動もある（`[login-path] skip (spawnSync /bin/zsh ETIMEDOUT)`）。
// PATH の値が要るだけなので、一度調べた結果を userData/login-path.json に覚えておき、
// 前と同じ状況ならシェルを起動しない（＝0 秒）。
//
// electron の `app` は「保存先ディレクトリ」を得るためだけに使う（learningStore.ts・
// usageStore.ts と同じ作法）。**使ってよいかの判定は loginPath.ts の純関数**
// （isLoginPathCacheFresh）で、このファイルは読み書きだけを持つ。
import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import type { LoginPathCacheEntry } from './loginPath'

/** 覚えておくファイル名（userData 直下）。 */
export const LOGIN_PATH_CACHE_FILE = 'login-path.json'

/** テスト用に差し替える保存先ディレクトリ。null なら app.getPath('userData')（本番）。
 *  learningStore.ts / usageStore.ts の dirOverride と同じ流儀。 */
let dirOverride: string | null = null

/**
 * テスト用: 保存先ディレクトリを差し替える。
 * dir に null を渡すと本番の app.getPath('userData') へ戻る。
 * 本番コード（main.ts・loginPath.ts）はこれを呼ばない。
 */
export function initLoginPathCache(dir: string | null): void {
  dirOverride = dir
}

/** 覚えておくファイルの場所。 */
export function loginPathCacheFile(): string {
  return path.join(dirOverride ?? app.getPath('userData'), LOGIN_PATH_CACHE_FILE)
}

/**
 * 覚えたものを読む。**無い・読めない・JSON として壊れているときは null**
 * （中身の妥当性は判定側＝isLoginPathCacheFresh が見る。ここでは「読めたか」だけ）。
 */
export function readLoginPathCache(): unknown {
  try {
    return JSON.parse(fs.readFileSync(loginPathCacheFile(), 'utf-8'))
  } catch {
    return null // 「分からない」→ 使わない（呼び出し側は調べ直す）
  }
}

/** 覚える（書けなくても致命的ではない＝次回また調べ直すだけ）。
 *  tmp へ書いて rename する（learningStore.saveNow と同じ、途中で落ちても壊れない作法）。 */
export function writeLoginPathCache(entry: LoginPathCacheEntry): void {
  const file = loginPathCacheFile()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(entry), 'utf-8')
    fs.renameSync(tmp, file)
  } catch {
    // 保存できなくても起動は続ける（掟: 起動を止めない）
  }
}
