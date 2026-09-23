// D-18（2026-09-16）: 起動で PATH の取得を待たない（窓を先に出す）。
//
// ── 何を固定するか ──────────────────────────────────────────────────
// 1. **覚えたものがあるときの振る舞いは変えない**（0 秒・同期で適用・待ちが発生しない）。
// 2. 覚えが無い／古いときは、取得の完了を**待たずに**先へ進む（＝窓を出せる）。
//    取れたら process.env.PATH が**合成後の値**になる（合成のしかたは D-18 で変えていない）。
// 3. 決まる前に道具を起動させない——`awaitLoginPath()` は**取得中は待つ**。
//    （これが常に即座に解決するよう壊されると、起動直後の `npm` が最小限の PATH で動く）
// 4. 時間切れのとき: PATH を壊さない・**印が立つ**・**覚えは書かない**（次の起動で調べ直す）。
// 5. 道具を起動する5ファイルが、実際に `await awaitLoginPath()` を通っている。
//
// 実測（2026-09-16・この機械）: `zsh -lc 'printf %s "$PATH"'` は 0.72〜1.58 秒。
// 上限 3 秒では実機で打ち切られており（`skip (spawnSync /bin/zsh ETIMEDOUT)`）、
// 打ち切られると PATH が直らないまま git・npm・node が「入っているのに見つからない」になる。
import { readFileSync } from 'fs'
import { join } from 'path'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  applyLoginPath, awaitLoginPath, loginPathFailureReason, loginPathHintForMissingTool,
  describeLoginPathResult, LOGIN_PATH_NOT_FOUND_HINT, LOGIN_PATH_SPAWN_TIMEOUT_MS,
  LOGIN_PATH_CACHE_VERSION, readShellConfigStamps, type LoginPathDeps, type LoginPathCacheEntry,
} from '../src/main/loginPath'

const NOW = Date.UTC(2026, 8, 16, 12, 0, 0)

let tmpDirs: string[] = []
let homeDir: string
let etcDir: string
let savedPath: string | undefined
let savedZdotdir: string | undefined

function mkTmpDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}

/** 次のマクロタスクまで進める（「即座に解決したか」を見分けるために使う）。
 *  解決済みの Promise の then はマイクロタスクなので、ここへ来るまでに必ず走っている。 */
const tick = () => new Promise(r => setTimeout(r, 0))

beforeEach(() => {
  tmpDirs = []
  homeDir = mkTmpDir('koto-d18-home-')
  etcDir = mkTmpDir('koto-d18-etc-')
  savedPath = process.env.PATH
  savedZdotdir = process.env.ZDOTDIR
  delete process.env.ZDOTDIR
  process.env.PATH = '/usr/bin:/bin'
})

afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH
  else process.env.PATH = savedPath
  if (savedZdotdir === undefined) delete process.env.ZDOTDIR
  else process.env.ZDOTDIR = savedZdotdir
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})

/** 覚えたもの（そのまま使える形）。 */
const freshEntry = (): LoginPathCacheEntry => ({
  version: LOGIN_PATH_CACHE_VERSION,
  shell: '/bin/zsh',
  zdotdir: null,
  configs: readShellConfigStamps({ homeDir, etcDir, zdotdir: null }),
  path: '/opt/homebrew/bin:/usr/bin:/bin',
  pathDirsPresent: [],
  savedAt: NOW,
})

const baseDeps = (over: Partial<LoginPathDeps> = {}): LoginPathDeps => ({
  platform: 'darwin',
  homeDir,
  etcDir,
  zdotdir: null,
  shell: '/bin/zsh',
  now: () => NOW,
  existsSync: () => false,
  readCache: () => null,
  writeCache: () => { /* 既定では覚えない */ },
  ...over,
})

describe('A. 覚えたものがあるとき（0 秒の道）の振る舞いは変えない', () => {
  it('同期で即座に適用され、awaitLoginPath は待たない', async () => {
    const start = applyLoginPath(baseDeps({
      readCache: () => freshEntry(),
      readLoginShellPath: () => { throw new Error('ここは呼ばれてはいけない') },
    }))
    // ★ 窓を出す前に、もう決まっている（'pending' ではない）
    expect(start.immediate.source).toBe('cached')
    expect(start.immediate.spawnMs).toBe(0)
    expect(process.env.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin')
    expect(describeLoginPathResult(start.immediate)).toBe('ok (cached)')

    let waited = true
    awaitLoginPath().then(() => { waited = false })
    await tick()
    expect(waited).toBe(false) // ★ 解決済み＝待っていない
    expect(loginPathFailureReason()).toBe(null)
  })

  it('そもそも調べていないとき（テスト・他プロセス）も、awaitLoginPath は待たない', async () => {
    applyLoginPath(baseDeps({ platform: 'linux' })) // darwin 以外＝何もしない
    let waited = true
    awaitLoginPath().then(() => { waited = false })
    await tick()
    expect(waited).toBe(false)
  })
})

describe('B. 覚えが無い／古いときは、取得の完了を待たない（窓を先に出す）', () => {
  it('★ 取得が終わらなくても applyLoginPath は戻る（窓を出す処理が先へ進む）', async () => {
    let release: (v: string) => void = () => {}
    const start = applyLoginPath(baseDeps({
      readLoginShellPath: () => new Promise<string>(r => { release = r }),
    }))

    // ★ ここが本題: 取得は終わっていないのに、もう戻ってきている
    expect(start.immediate.source).toBe('pending')
    expect(describeLoginPathResult(start.immediate)).toBe('調べています…（窓は先に出します）')
    let windowOpened = false
    windowOpened = true // 窓を出す処理に相当（待たされていたらここへ来ない）
    await tick()
    expect(windowOpened).toBe(true)
    expect(process.env.PATH).toBe('/usr/bin:/bin') // まだ反映されていない

    release('/opt/homebrew/bin:/usr/bin:/bin')
    const r = await start.done
    // ★ あとから反映される。合成のしかたは変えていない（ログインシェル → 元のPATH → 定番）
    expect(r.source).toBe('fresh')
    expect(r.after).toBe('/opt/homebrew/bin:/usr/bin:/bin')
    expect(process.env.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin')
    expect(describeLoginPathResult(r)).toMatch(/^ok \(fresh, [0-9.]+s\)・あとから反映$/)
  })

  it('★ 取り出しが同期で時間を食う作りでも、窓は止まらない（実際に時間を測る）', async () => {
    // 取り出しの中で 200ms 動きっぱなしになる（＝イベントループを塞ぐ）関数を渡す。
    // 「同期で待つ」形に戻すと applyLoginPath の中でこの 200ms を丸ごと食うので、
    // 下の 100ms の関門に引っかかる。いまは開始ごとマイクロタスクへ送るので 0ms で戻る。
    const BUSY_MS = 200
    const busy = (): string => {
      const until = Date.now() + BUSY_MS
      while (Date.now() < until) { /* 動きっぱなし */ }
      return '/opt/homebrew/bin:/usr/bin:/bin'
    }
    const t0 = Date.now()
    const start = applyLoginPath(baseDeps({ now: Date.now, readLoginShellPath: busy }))
    const elapsed = Date.now() - t0
    expect(start.immediate.source).toBe('pending')
    expect(elapsed).toBeLessThan(100) // ★ 窓を出す処理は待たされていない
    expect((await start.done).source).toBe('fresh')
  })

  it('★ 既定の取り出し方（差し替えなし）でも、窓を出す前に待たない', async () => {
    // ログインシェルの代わりに /bin/echo を起こす（設定ファイルを読まない・すぐ終わる）。
    // 出力は PATH らしくないので失敗として扱われる＝ここで見たいのは**戻るのが先か**だけ。
    // 同期（execFileSync）に戻すと、この時点で結果が出てしまい 'pending' にならない。
    let wrote = 0
    const start = applyLoginPath(baseDeps({ shell: '/bin/echo', writeCache: () => { wrote++ } }))
    expect(start.immediate.source).toBe('pending')
    const r = await start.done
    expect(r.source).toBe('none')
    expect(wrote).toBe(0)
  })
})

describe('C. 決まる前に道具を起動させない（awaitLoginPath は取得中だけ待つ）', () => {
  it('★ 取得中は待つ／決まったら解けて、そのとき PATH は合成後になっている', async () => {
    let release: (v: string) => void = () => {}
    const start = applyLoginPath(baseDeps({
      readLoginShellPath: () => new Promise<string>(r => { release = r }),
    }))
    expect(start.immediate.source).toBe('pending')

    let pathWhenToolStarted: string | undefined
    awaitLoginPath().then(() => { pathWhenToolStarted = process.env.PATH })
    await tick()
    // ★ ここが本題: まだ決まっていないので、道具はまだ起動していない
    expect(pathWhenToolStarted).toBe(undefined)

    release('/opt/homebrew/bin:/usr/bin:/bin')
    await start.done
    await tick()
    // 待った甲斐があること（古い PATH で起動していたら '/usr/bin:/bin' のまま）
    expect(pathWhenToolStarted).toBe('/opt/homebrew/bin:/usr/bin:/bin')
  })

  it('取得に失敗しても待ちは必ず解ける（道具が永久に起動しないのは困る）', async () => {
    let fail: (e: Error) => void = () => {}
    const start = applyLoginPath(baseDeps({
      readLoginShellPath: () => new Promise<string>((_, rej) => { fail = rej }),
    }))
    let released = false
    awaitLoginPath().then(() => { released = true })
    // 取り出しの呼び出しは1つ後の処理に回される（同期で投げても「失敗」として扱うため）。
    // **一拍おいてから**でないと、差し替えた関数がまだ動いておらず fail を掴めない。
    await tick()
    fail(new Error('ETIMEDOUT'))
    await start.done
    await tick()
    expect(released).toBe(true)
  })
})

describe('D. 時間切れのとき', () => {
  it('★ PATH を壊さない・印が立つ・覚えは書かない', async () => {
    let wrote = 0
    const r = await applyLoginPath(baseDeps({
      writeCache: () => { wrote++ },
      readLoginShellPath: () => Promise.reject(new Error('spawn /bin/zsh ETIMEDOUT')),
    })).done

    expect(r.source).toBe('none')
    expect(process.env.PATH).toBe('/usr/bin:/bin') // 受け継いだ PATH のまま
    expect(wrote).toBe(0)                          // ★ 覚えは書かない（次の起動で調べ直す）
    expect(loginPathFailureReason()).toBe('spawn /bin/zsh ETIMEDOUT') // ★ 印
    expect(loginPathHintForMissingTool()).toBe(LOGIN_PATH_NOT_FOUND_HINT)
    expect(describeLoginPathResult(r)).toBe('skip (spawn /bin/zsh ETIMEDOUT)・あとから反映')
  })

  it('うまくいったときは印を立てない（普段は余計なことを言わない）', async () => {
    await applyLoginPath(baseDeps({
      readLoginShellPath: () => '/opt/homebrew/bin:/usr/bin:/bin',
    })).done
    expect(loginPathFailureReason()).toBe(null)
    expect(loginPathHintForMissingTool()).toBe('')
  })

  it('待つ上限は 15 秒（窓を待たせないので、3 秒より長くしてよい）', () => {
    expect(LOGIN_PATH_SPAWN_TIMEOUT_MS).toBe(15000)
    const src = readFileSync(join(__dirname, '..', 'src/main/loginPath.ts'), 'utf-8')
    // 既定の取り出しが、この上限を実際に使っていること（定数だけ変えても効かない形を防ぐ）
    expect(src).toContain('timeout: LOGIN_PATH_SPAWN_TIMEOUT_MS')
    expect(src).not.toContain('timeout: 3000')
    // 同期の取り出し（execFileSync）へ戻していないこと
    expect(src).not.toContain('execFileSync')
  })
})

// ── 道具を起動する入口が、実際に待っているか（ソースを読む検査）──────────────
// **当て先が他の行に出ないかを確かめる**（掟10・2026-08-20 の教訓）: ここでは
// 「ファイルのどこかに awaitLoginPath と書いてあるか」ではなく、**入口ごとに**
// 一意な見出しを指し、その直後の範囲に呼び出しがあることを見る。
// どれか1か所から `await awaitLoginPath()` を外せば、その1件が落ちる。
describe('道具を起動する5ファイルが await awaitLoginPath() を通る', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf-8')

  /** anchor は**1か所だけ**に出ること。そこから len 文字の範囲を返す。 */
  function segmentAfter(src: string, anchor: string, len: number): string {
    const i = src.indexOf(anchor)
    expect(i, `見出しが見つからない: ${anchor}`).toBeGreaterThanOrEqual(0)
    expect(src.indexOf(anchor, i + 1), `見出しが2か所以上ある: ${anchor}`).toBe(-1)
    return src.slice(i, i + len)
  }

  const entries: { file: string; anchor: string; len: number }[] = [
    // AIの run_command（proc:run）——`npm: command not found` の正体だった経路
    { file: 'src/main/ipc/shell.ts', anchor: 'export async function runProjectCommand(', len: 700 },
    // 前提チェック——PATH が足りないと docker を「未インストール」と誤判定しうる
    { file: 'src/main/ipc/shell.ts', anchor: "ipcMain.handle('shell:which', async (_, cmd: string) => {", len: 500 },
    // ターミナル（pty の env は起動した瞬間の process.env で固まる）
    { file: 'src/main/ipc/term.ts', anchor: "ipcMain.handle('term:create', async (_, cwd?: string) => {", len: 400 },
    // 公開のときの npm
    { file: 'src/main/cloud/npmInstall.ts', anchor: 'export async function installDependencies(', len: 1400 },
    // docker を起こす4つ（1つでも抜けるとそこだけ最小限の PATH で docker を探す）
    { file: 'src/main/cloud/docker.ts', anchor: 'export async function dockerAvailable(): Promise<boolean> {', len: 300 },
    { file: 'src/main/cloud/docker.ts', anchor: 'export async function buildImage(', len: 300 },
    { file: 'src/main/cloud/docker.ts', anchor: 'export async function loginRegistry(', len: 300 },
    { file: 'src/main/cloud/docker.ts', anchor: 'export async function pushImage(', len: 300 },
    // 内蔵ビルダー（crane）の組み立て。中で tar と npm を起こす
    { file: 'src/main/cloud/imageBuild.ts', anchor: 'export async function buildAndPush(', len: 700 },
  ]

  for (const { file, anchor, len } of entries) {
    it(`${file} — ${anchor.slice(0, 48)}`, () => {
      expect(segmentAfter(read(file), anchor, len)).toContain('await awaitLoginPath()')
    })
  }

  it('5つのファイルが loginPath から awaitLoginPath を取り込んでいる（書き下す）', () => {
    for (const [file, line] of [
      ['src/main/ipc/shell.ts', "import { awaitLoginPath } from '../loginPath'"],
      ['src/main/ipc/term.ts', "import { awaitLoginPath } from '../loginPath'"],
      ['src/main/cloud/npmInstall.ts', "import { awaitLoginPath, loginPathHintForMissingTool } from '../loginPath'"],
      ['src/main/cloud/docker.ts', "import { awaitLoginPath } from '../loginPath'"],
      ['src/main/cloud/imageBuild.ts', "import { awaitLoginPath } from '../loginPath'"],
    ] as const) {
      expect(read(file), file).toContain(line)
    }
  })

  it('npm を探す前に待つ（順序が逆だと意味が無い）', () => {
    const seg = segmentAfter(read('src/main/cloud/npmInstall.ts'), 'export async function installDependencies(', 1400)
    expect(seg.indexOf('await awaitLoginPath()')).toBeLessThan(seg.indexOf('await npmAvailable()'))
  })

  it('D: 「npm が見つかりません」に、PATH の取得に失敗した見当を1か所だけ添える', () => {
    const npm = read('src/main/cloud/npmInstall.ts')
    expect(npm).toContain('const hint = loginPathHintForMissingTool()')
    // 複製しない（この見当を組み立てているのはここ1か所だけ）
    const others = ['src/main/cloud/docker.ts', 'src/main/cloud/imageBuild.ts',
      'src/main/ipc/shell.ts', 'src/main/ipc/term.ts', 'src/main/cloud/imagePublish.ts']
    for (const f of others) expect(read(f), f).not.toContain('loginPathHintForMissingTool')
  })

  it('窓を出す側は pending を受け取り、あとから決まった分もログに残す（main.ts）', () => {
    const main = read('src/main/main.ts')
    expect(main).toContain('const pathFix = applyLoginPath()')
    expect(main).toContain("if (pathFix.immediate.source === 'pending') {")
    expect(main).toContain('pathFix.done')
  })
})
