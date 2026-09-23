// D-16 B: ブラウザの一時ファイル（Cache / Code Cache）の上限 200MB（2026-09-16）。
// ここで固定したいのは2つ。
//   1. 上限の判断（shouldClearCache）の境界——ちょうど 200MB では片づけない。
//   2. **消してはいけないものを消さない**——片づけの対象は Cache と Code Cache だけで、
//      認証情報・利用実績・学習・Local Storage の名前が対象に現れないこと。
//      片づけは Electron の API 経由で、フォルダを直接消さない（ソースに削除の呼び出しが無いこと）。
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  shouldClearCache, CACHE_LIMIT_BYTES, CACHE_DIR_NAMES, PROTECTED_NAMES,
  measureDirBytes, trimBrowserCacheIfLarge, toMegabytes,
} from '../src/main/browserCacheLimit'

let tmpDirs: string[] = []
function mkTmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-cachelimit-'))
  tmpDirs.push(d)
  return d
}
let dataDir: string
beforeEach(() => { tmpDirs = []; dataDir = mkTmpDir() })
afterEach(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }) })

describe('shouldClearCache（上限の判断・純関数）', () => {
  it('上限ちょうどでは片づけない', () => {
    expect(shouldClearCache(CACHE_LIMIT_BYTES, CACHE_LIMIT_BYTES)).toBe(false)
  })
  it('1 バイトでも超えたら片づける', () => {
    expect(shouldClearCache(CACHE_LIMIT_BYTES + 1, CACHE_LIMIT_BYTES)).toBe(true)
  })
  it('下回るなら片づけない', () => {
    expect(shouldClearCache(CACHE_LIMIT_BYTES - 1, CACHE_LIMIT_BYTES)).toBe(false)
    expect(shouldClearCache(0, CACHE_LIMIT_BYTES)).toBe(false)
  })
  it('実測（2026-09-16）の 399MB は超えている / 上限は 200MB', () => {
    expect(CACHE_LIMIT_BYTES).toBe(200 * 1024 * 1024)
    expect(shouldClearCache(399 * 1024 * 1024)).toBe(true)
  })
  it('分からない値（NaN・負）では片づけない', () => {
    expect(shouldClearCache(NaN, CACHE_LIMIT_BYTES)).toBe(false)
    expect(shouldClearCache(-1, CACHE_LIMIT_BYTES)).toBe(false)
    expect(shouldClearCache(Infinity, NaN)).toBe(false)
  })
})

describe('片づけの対象（消してはいけないものを消さない）', () => {
  it('対象は Cache と Code Cache の2つだけ', () => {
    expect([...CACHE_DIR_NAMES]).toEqual(['Cache', 'Code Cache'])
  })
  it('守るべきものの名前が対象に現れない', () => {
    for (const name of PROTECTED_NAMES) {
      expect([...CACHE_DIR_NAMES]).not.toContain(name)
    }
    expect([...PROTECTED_NAMES]).toContain('usage.json')
    expect([...PROTECTED_NAMES]).toContain('learning.json')
    expect([...PROTECTED_NAMES]).toContain('cloud-credentials.enc')
    expect([...PROTECTED_NAMES]).toContain('registry-credentials.enc')
    expect([...PROTECTED_NAMES]).toContain('Local Storage')
  })
  it('フォルダを直接消さない（ソースに削除の呼び出しが無い）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'browserCacheLimit.ts'), 'utf-8')
    for (const forbidden of ['rmSync', 'rmdir', 'unlink', 'fs.rm(', 'promises.rm']) {
      expect(src).not.toContain(forbidden)
    }
  })
})

describe('measureDirBytes（大きさを測る）', () => {
  it('入れ子のファイルを合計する / 無いフォルダは 0', async () => {
    const cache = path.join(dataDir, 'Cache', 'sub')
    fs.mkdirSync(cache, { recursive: true })
    fs.writeFileSync(path.join(cache, 'a.bin'), Buffer.alloc(1000))
    fs.writeFileSync(path.join(dataDir, 'Cache', 'b.bin'), Buffer.alloc(24))
    expect(await measureDirBytes(path.join(dataDir, 'Cache'))).toBe(1024)
    expect(await measureDirBytes(path.join(dataDir, 'Code Cache'))).toBe(0)
  })
})

describe('trimBrowserCacheIfLarge（片づけ本体）', () => {
  type Calls = { cache: number; code: Array<{ urls: string[] }>; logs: string[] }
  function deps(calls: Calls, bytes: number, limitBytes = CACHE_LIMIT_BYTES) {
    return {
      userDataDir: dataDir,
      limitBytes,
      // 対象フォルダ1つあたり bytes/2 を返す（合計が bytes になる）
      measure: async (_dir: string) => bytes / 2,
      clearCache: async () => { calls.cache++ },
      clearCodeCaches: async (options: { urls: string[] }) => { calls.code.push(options) },
      log: (line: string) => { calls.logs.push(line) },
    }
  }
  const emptyCalls = (): Calls => ({ cache: 0, code: [], logs: [] })

  it('上限を超えていたら Electron の API 2本で片づけ、ログを1行出す', async () => {
    const calls = emptyCalls()
    const r = await trimBrowserCacheIfLarge(deps(calls, 399 * 1024 * 1024))
    expect(r.cleared).toBe(true)
    expect(r.bytes).toBe(399 * 1024 * 1024)
    expect(calls.cache).toBe(1)
    expect(calls.code).toEqual([{ urls: [] }])
    expect(calls.logs.length).toBe(1)
    expect(calls.logs[0]).toContain('399MB')
    expect(calls.logs[0]).toContain('片づけました')
  })

  it('上限を超えていなければ何も消さない', async () => {
    const calls = emptyCalls()
    const r = await trimBrowserCacheIfLarge(deps(calls, 100 * 1024 * 1024))
    expect(r.cleared).toBe(false)
    expect(calls.cache).toBe(0)
    expect(calls.code).toEqual([])
  })

  it('測る先は Cache と Code Cache だけ（守るべきものを測りにも行かない）', async () => {
    const calls = emptyCalls()
    const r = await trimBrowserCacheIfLarge(deps(calls, 399 * 1024 * 1024))
    expect(r.measured).toEqual([path.join(dataDir, 'Cache'), path.join(dataDir, 'Code Cache')])
    for (const name of PROTECTED_NAMES) {
      for (const m of r.measured) expect(path.basename(m)).not.toBe(name)
    }
  })

  it('片づけに失敗してもアプリを止めない（cleared=false で返る）', async () => {
    const calls = emptyCalls()
    const base = deps(calls, 399 * 1024 * 1024)
    const r = await trimBrowserCacheIfLarge({
      ...base,
      clearCache: async () => { throw new Error('セッションが無い') },
    })
    expect(r.cleared).toBe(false)
    expect(r.error).toContain('セッションが無い')
  })

  it('toMegabytes は整数 MB', () => {
    expect(toMegabytes(399 * 1024 * 1024)).toBe(399)
    expect(toMegabytes(0)).toBe(0)
  })
})

// ── 配線（消す力を持っているのは main.ts のこの2行だけ）────────────────────
// 2026-09-16 検分の指摘: 上のテストは browserCacheLimit.ts の本文しか読まないので、
// main.ts が渡す Electron の API を **clearStorageData()（＝Local Storage ごと消える。
// 2026-08-19 に中央ストアのAPIキーが全部消えたのと同じ形）** に差し替えても全件緑のまま通った。
// モジュールは渡されたものを呼ぶだけで、**何を渡すかを決めているのは main.ts のこの2行**。
// 掟10（守りは振る舞い／配線で固定する）に従い、ここで前後ごと一意に固定する。
describe('片づけの配線: main.ts が渡す Electron の API', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.ts'), 'utf-8')

  it('★ 消すのは一時ファイルだけ（clearCache と clearCodeCaches の2本）', () => {
    expect(main).toMatch(
      /scheduleBrowserCacheTrim\(\{[\s\S]{0,400}?clearCache: \(\) => session\.defaultSession\.clearCache\(\),/)
    expect(main).toMatch(
      /scheduleBrowserCacheTrim\(\{[\s\S]{0,400}?clearCodeCaches: \(options\) => session\.defaultSession\.clearCodeCaches\(options\),/)
    expect(main).toMatch(
      /scheduleBrowserCacheTrim\(\{[\s\S]{0,200}?userDataDir: app\.getPath\('userData'\),/)
  })

  it('★ 利用者の持ち物を消す API を、どこからも呼ばない', () => {
    // clearStorageData/clearData は Local Storage（APIキーの保存先）・Cookie・IndexedDB まで消す。
    // clearHostResolverCache は一時ファイルとは無関係（消しても得が無く、副作用だけある）。
    for (const forbidden of [
      'clearStorageData', 'clearData', 'clearHostResolverCache', 'clearAuthCache', 'flushStorageData',
    ]) {
      expect(main).not.toContain(forbidden)
    }
  })

  it('★ 窓を出したあとに遅らせて呼ぶ（起動を遅くしない）', () => {
    expect(main).toMatch(/createWindow\(\)[\s\S]{0,800}?scheduleBrowserCacheTrim\(\{/)
    // 即時実行（trimBrowserCacheIfLarge の直呼び）にしない＝起動時に測りに行かせない
    expect(main).not.toContain('trimBrowserCacheIfLarge')
  })
})
