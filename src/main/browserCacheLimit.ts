// browserCacheLimit.ts — ブラウザの一時ファイル（Cache / Code Cache）の上限（2026-09-16・D-16 B）。
//
// ── なぜ ────────────────────────────────────────────────────────────
// 実測（2026-09-16・この機械）: `~/Library/Application Support/Koto` は **399 MB**。
// 内訳は `Cache` 298 MB・`Code Cache` 99 MB で、**99% がブラウザの一時ファイル**だった。
// Koto 自身のデータ（usage.json・learning.json）は**2 KB 足らず**。Electron/Chromium は
// これを自動で整理しないので、放っておくと増え続ける。
//
// ── 消してはいけないものを消さないために ──────────────────────────────
// 片づけは **Electron の API だけ**で行う（session.clearCache / clearCodeCaches）。
// **フォルダを直接消さない**——使用中のファイルを消すと Chromium の内部状態が壊れる。
// 対象は一時ファイルだけで、認証情報（cloud-credentials.enc・registry-credentials.enc）・
// 利用実績（usage.json）・学習（learning.json）・Local Storage（設定とAPIキーの保存先）には
// 触れない。会話の記録はそもそも userData の外（プロジェクトの .sakuraide/）にある。
// この「触れない顔ぶれ」は PROTECTED_NAMES としてテストで固定してある。
import * as fs from 'fs'
import * as path from 'path'

/**
 * 一時ファイルの上限。**200 MB**（2026-09-16・Ryosuke さん承認）。
 * 根拠: 同日の実測で Cache+Code Cache が 399 MB まで育っていた一方、Koto 自身のデータは
 * 2 KB 足らず。つまりこの上限は「アプリのデータの大きさ」とは無関係で、**一時ファイルが
 * どこまで育つのを許すか**だけを決めている。200 MB あれば通常の利用で再取得が頻発することは
 * なく（超えたときだけ空にする＝次回以降にまた貯まる）、数百 MB の肥大も防げる。
 */
export const CACHE_LIMIT_BYTES = 200 * 1024 * 1024

/** 大きさを測る対象＝片づけの対象（userData 直下のこの2つだけ）。 */
export const CACHE_DIR_NAMES = ['Cache', 'Code Cache'] as const

/**
 * **絶対に片づけの対象にしない**もの（テストで固定）。
 * ここに挙げた名前が CACHE_DIR_NAMES に混ざったら、その時点でテストが落ちる。
 */
export const PROTECTED_NAMES = [
  'usage.json',                 // 利用実績（課金データ）
  'learning.json',              // モデルの学習結果
  'cloud-credentials.enc',      // さくらのクラウドの認証情報
  'registry-credentials.enc',   // コンテナレジストリの認証情報
  'Local Storage',              // 設定・APIキー（2026-08-19 に一度全部消えた場所）
  'Session Storage',
  'Cookies',
  'knowledge',                  // RAG の索引
] as const

/** 片づけるべきか（純関数）。上限**ちょうど**では片づけない（超えたときだけ）。
 *  数値でない・負・NaN は「分からない」として片づけない（安全側）。 */
export function shouldClearCache(bytes: number, limitBytes: number = CACHE_LIMIT_BYTES): boolean {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return false
  if (typeof limitBytes !== 'number' || !Number.isFinite(limitBytes) || limitBytes < 0) return false
  return bytes > limitBytes
}

/** ログ用の見やすい大きさ（整数 MB）。 */
export function toMegabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024))
}

/**
 * フォルダの中身の合計バイト数を数える（非同期・シンボリックリンクは辿らない）。
 * 数えられないもの（権限が無い・途中で消えた）は 0 として飛ばす——**測れないことを理由に
 * 片づけない**（測り漏れは「小さい」側に倒れるので、余計な片づけは起きない）。
 */
export async function measureDirBytes(dir: string): Promise<number> {
  let total = 0
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return 0 // 無い（まだ作られていない）
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      total += await measureDirBytes(full)
    } else if (e.isFile()) {
      try {
        total += (await fs.promises.lstat(full)).size
      } catch {
        // 数えている間に消えた（一時ファイルなので普通に起きる）
      }
    }
  }
  return total
}

export type CacheTrimDeps = {
  /** app.getPath('userData')。テストでは一時フォルダ。 */
  userDataDir: string
  /** session.defaultSession.clearCache() */
  clearCache: () => Promise<void>
  /** session.defaultSession.clearCodeCaches({ urls: [] }) */
  clearCodeCaches: (options: { urls: string[] }) => Promise<void>
  limitBytes?: number
  measure?: (dir: string) => Promise<number>
  log?: (line: string) => void
}

export type CacheTrimResult = {
  bytes: number
  limitBytes: number
  cleared: boolean
  /** 実際に測ったフォルダ（テストで「対象がこの2つだけ」を固定するために返す）。 */
  measured: string[]
  error?: string
}

/**
 * 一時ファイルが上限を超えていたら片づける。**起動を遅くしない**ため、窓を出したあとに
 * 遅らせて呼ぶ（scheduleBrowserCacheTrim）。利用者の画面には何も出さない
 * （一時ファイルの話は利用者の関心事ではない。ログにだけ残す）。
 */
export async function trimBrowserCacheIfLarge(deps: CacheTrimDeps): Promise<CacheTrimResult> {
  const limitBytes = deps.limitBytes ?? CACHE_LIMIT_BYTES
  const measure = deps.measure ?? measureDirBytes
  const log = deps.log ?? ((line: string) => console.log(line))
  const measured = CACHE_DIR_NAMES.map(name => path.join(deps.userDataDir, name))

  let bytes = 0
  try {
    for (const dir of measured) bytes += await measure(dir)
  } catch (e: any) {
    return { bytes: 0, limitBytes, cleared: false, measured, error: e?.message ?? String(e) }
  }

  if (!shouldClearCache(bytes, limitBytes)) {
    log(`[cache-limit] ${toMegabytes(bytes)}MB（上限 ${toMegabytes(limitBytes)}MB）そのまま`)
    return { bytes, limitBytes, cleared: false, measured }
  }

  try {
    // **Electron の API で消す**（フォルダを直接消さない＝使用中のファイルを壊さない）。
    await deps.clearCache()
    await deps.clearCodeCaches({ urls: [] }) // urls: [] ＝すべてのコードキャッシュ
  } catch (e: any) {
    log(`[cache-limit] 片づけに失敗: ${e?.message ?? String(e)}`)
    return { bytes, limitBytes, cleared: false, measured, error: e?.message ?? String(e) }
  }
  log(`[cache-limit] 一時ファイルが ${toMegabytes(bytes)}MB（上限 ${toMegabytes(limitBytes)}MB）あったので片づけました`)
  return { bytes, limitBytes, cleared: true, measured }
}

/** 窓を出してから片づけるまでの待ち時間。起動直後の重い時間帯を避けるための 10 秒。 */
export const CACHE_TRIM_DELAY_MS = 10_000

/** 起動を遅くしないように、窓を出したあと遅らせて実行する（呼び出しは main.ts の whenReady）。 */
export function scheduleBrowserCacheTrim(
  deps: CacheTrimDeps,
  delayMs: number = CACHE_TRIM_DELAY_MS,
): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    void trimBrowserCacheIfLarge(deps).catch(() => { /* 片づけ失敗でアプリを止めない */ })
  }, delayMs)
}
