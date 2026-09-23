// D-16 A: ログインシェルの結果を覚える（起動が遅い主因への対処・2026-09-16）。
// 実測で `zsh -lc 'echo $PATH'` に 1.22 秒かかっており、3 秒の上限で打ち切られた起動もあった。
// ここでは「覚えたものを使ってよいかの判定」（純関数 isLoginPathCacheFresh）と、
// 保存先を差し替えた実ファイルでの読み書き、そして **2回目にシェルを起動していないこと**を固定する。
// electron は import しない（loginPathCache.ts が保存先を差し替えられるようにしてあるため）。
//
// 2026-09-16 検分の指摘で足したもの（★ 付き）: 初版はホーム直下の6つの dotfile の更新時刻しか
// 見ておらず、fish・`~/.zlogin`・`/etc/paths`・`/etc/paths.d/*`・`/etc/zprofile`・`$ZDOTDIR` で
// PATH が変わっても**永久に気づけなかった**（＝間違った PATH を覚えたまま使い続ける）。
// また savedAt を保存しているのに期限として使っていなかった。
// **どの経路で PATH が変わったら調べ直すか**を、実際にファイルを動かして固定する。
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  isLoginPathCacheFresh, isWithinMaxAge, cachedLoginPathValue, cachedPathDirsStillPresent,
  readShellConfigStamps, applyLoginPath,
  describeLoginPathResult, LOGIN_PATH_CACHE_VERSION, LOGIN_PATH_CACHE_MAX_AGE_MS,
  SHELL_CONFIG_FILES, type LoginPathDeps,
} from '../src/main/loginPath'
import {
  initLoginPathCache, readLoginPathCache, writeLoginPathCache, loginPathCacheFile,
} from '../src/main/loginPathCache'

let tmpDirs: string[] = []
function mkTmpDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}

let dataDir: string
let homeDir: string
let etcDir: string
let zdotDir: string
let savedPath: string | undefined
let savedZdotdir: string | undefined

/** 「いま」を固定する（期限の判定を時計に左右されないようにする）。 */
const NOW = Date.UTC(2026, 8, 16, 12, 0, 0)

beforeEach(() => {
  tmpDirs = []
  dataDir = mkTmpDir('koto-loginpathcache-')
  homeDir = mkTmpDir('koto-loginpathhome-')
  etcDir = mkTmpDir('koto-loginpathetc-')
  zdotDir = mkTmpDir('koto-loginpathzdot-')
  initLoginPathCache(dataDir)
  savedPath = process.env.PATH
  savedZdotdir = process.env.ZDOTDIR
  delete process.env.ZDOTDIR // 実行環境の ZDOTDIR に結果を左右されない
})
afterEach(() => {
  initLoginPathCache(null)
  if (savedPath === undefined) delete process.env.PATH
  else process.env.PATH = savedPath
  if (savedZdotdir === undefined) delete process.env.ZDOTDIR
  else process.env.ZDOTDIR = savedZdotdir
  delete process.env.KOTO_LOGIN_PATH_REFRESH
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})

/** いまの印（テスト用の置き場から読む）。 */
const stamps = (zdotdir: string | null = null) =>
  readShellConfigStamps({ homeDir, etcDir, zdotdir })

const current = (over: Record<string, unknown> = {}) => ({
  shell: '/bin/zsh', zdotdir: null as string | null, configs: stamps(), now: NOW, ...over,
})

const entry = (over: Record<string, unknown> = {}) => ({
  version: LOGIN_PATH_CACHE_VERSION,
  shell: '/bin/zsh',
  zdotdir: null as string | null,
  configs: stamps(),
  path: '/opt/homebrew/bin:/usr/bin:/bin',
  pathDirsPresent: [] as string[], // ★ version 3: 既定は空（＝実在確認は常に通る。個別のテストで上書き）
  savedAt: NOW,
  ...over,
})

/** ファイルを作る（親フォルダごと）。 */
function put(file: string, body = 'export FOO=1'): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body, 'utf-8')
  return file
}
/** 更新時刻だけを進める（中身は変えない）。 */
function touchLater(file: string, seconds = 60): void {
  const t = new Date(Date.now() + seconds * 1000)
  fs.utimesSync(file, t, t)
}

describe('isLoginPathCacheFresh（覚えたものを使ってよいかの判定）', () => {
  it('同じ状況なら true', () => {
    expect(isLoginPathCacheFresh(entry(), current())).toBe(true)
  })

  it('SHELL が違えば false', () => {
    expect(isLoginPathCacheFresh(entry({ shell: '/bin/bash' }), current())).toBe(false)
  })

  it('設定ファイルの更新時刻が違えば false', () => {
    const zshrc = put(path.join(homeDir, '.zshrc'))
    const before = entry({ configs: stamps() })
    touchLater(zshrc)
    expect(isLoginPathCacheFresh(before, current())).toBe(false)
  })

  it('存在しなかったファイルが増えたら false（無いという事実ごと覚えている）', () => {
    const before = entry()
    put(path.join(homeDir, '.zprofile'))
    expect(isLoginPathCacheFresh(before, current())).toBe(false)
  })

  it('覚えた形式の版が違えば false', () => {
    expect(isLoginPathCacheFresh(entry({ version: LOGIN_PATH_CACHE_VERSION + 1 }), current())).toBe(false)
    expect(LOGIN_PATH_CACHE_VERSION).toBe(3) // 印の顔ぶれを変えたら必ず上げる（古い覚えを捨てる）
  })

  it('★ pathDirsPresent が無い・形が違う覚えは false（古い形式＝version 3 未満の残骸）', () => {
    const noDirs: Record<string, unknown> = { ...entry() }
    delete noDirs.pathDirsPresent
    expect(isLoginPathCacheFresh(noDirs, current())).toBe(false)
    expect(isLoginPathCacheFresh(entry({ pathDirsPresent: 'not-an-array' }), current())).toBe(false)
    expect(isLoginPathCacheFresh(entry({ pathDirsPresent: [1, 2] }), current())).toBe(false)
    expect(isLoginPathCacheFresh(entry({ pathDirsPresent: null }), current())).toBe(false)
    // 空配列・文字列の配列は正しい形（version 3 の既定はこちら）
    expect(isLoginPathCacheFresh(entry({ pathDirsPresent: [] }), current())).toBe(true)
    expect(isLoginPathCacheFresh(entry({ pathDirsPresent: ['/opt/homebrew/bin'] }), current())).toBe(true)
  })

  it('★ $ZDOTDIR が違えば false（zsh が読む設定ファイルが丸ごと変わる）', () => {
    expect(isLoginPathCacheFresh(entry({ zdotdir: zdotDir }), current())).toBe(false)
    expect(isLoginPathCacheFresh(entry(), current({ zdotdir: zdotDir }))).toBe(false)
    expect(isLoginPathCacheFresh(entry({ zdotdir: zdotDir, configs: stamps(zdotDir) }),
      current({ zdotdir: zdotDir, configs: stamps(zdotDir) }))).toBe(true)
  })

  it('★ zdotdir が無い・形が違う覚えは false（古い形＝版1の残骸を使わない）', () => {
    const noZdotdir: Record<string, unknown> = { ...entry() }
    delete noZdotdir.zdotdir
    expect(isLoginPathCacheFresh(noZdotdir, current())).toBe(false)
    expect(isLoginPathCacheFresh(entry({ zdotdir: 123 }), current())).toBe(false)
  })

  it('★ 期限を過ぎた覚えは false（印で気づけない経路のための最後の砦）', () => {
    const old = entry({ savedAt: NOW - LOGIN_PATH_CACHE_MAX_AGE_MS - 1 })
    expect(isLoginPathCacheFresh(old, current())).toBe(false)
    const justInTime = entry({ savedAt: NOW - LOGIN_PATH_CACHE_MAX_AGE_MS })
    expect(isLoginPathCacheFresh(justInTime, current())).toBe(true)
  })

  it('★ savedAt が無い・未来・数値でないものは false（分からないを使ってよいに倒さない）', () => {
    expect(isLoginPathCacheFresh(entry({ savedAt: undefined }), current())).toBe(false)
    expect(isLoginPathCacheFresh(entry({ savedAt: '2026-09-16' }), current())).toBe(false)
    expect(isLoginPathCacheFresh(entry({ savedAt: NOW + 1 }), current())).toBe(false)
  })

  it('壊れている・形が違うものは false（「分からない」を「使ってよい」に倒さない）', () => {
    expect(isLoginPathCacheFresh(null, current())).toBe(false)
    expect(isLoginPathCacheFresh(undefined, current())).toBe(false)
    expect(isLoginPathCacheFresh('/usr/bin', current())).toBe(false)
    expect(isLoginPathCacheFresh([entry()], current())).toBe(false)
    expect(isLoginPathCacheFresh(entry({ configs: undefined }), current())).toBe(false)
    expect(isLoginPathCacheFresh(entry({ configs: stamps().slice(1) }), current())).toBe(false)
    expect(isLoginPathCacheFresh(entry({ path: 'bin:usr' }), current())).toBe(false) // PATH らしくない
  })
})

describe('isWithinMaxAge（期限そのもの）', () => {
  it('期限は 7 日', () => {
    expect(LOGIN_PATH_CACHE_MAX_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })
  it('境界: ちょうどは使える / 1 ミリ秒でも過ぎたら使わない', () => {
    expect(isWithinMaxAge(NOW - LOGIN_PATH_CACHE_MAX_AGE_MS, NOW)).toBe(true)
    expect(isWithinMaxAge(NOW - LOGIN_PATH_CACHE_MAX_AGE_MS - 1, NOW)).toBe(false)
    expect(isWithinMaxAge(NOW, NOW)).toBe(true)
  })
  it('未来・数値でない・NaN は使わない', () => {
    expect(isWithinMaxAge(NOW + 1, NOW)).toBe(false)
    expect(isWithinMaxAge('きのう', NOW)).toBe(false)
    expect(isWithinMaxAge(NaN, NOW)).toBe(false)
    expect(isWithinMaxAge(NOW, NaN)).toBe(false)
  })
})

// ★ D-17 A（2026-09-16）: 覚えた時点で実在した PATH のフォルダが、今も全部実在するか。
// 設定ファイルの更新時刻だけでは、設定ファイルを書き換えずに PATH の中身だけが消える経路
//（nvm/rbenv/pyenv の切り替え・brew uninstall・道具の移動）に気づけない、という指摘への対処。
describe('cachedPathDirsStillPresent（覚えた PATH のフォルダが、今も全部実在するか）', () => {
  it('全部実在すれば true', () => {
    expect(cachedPathDirsStillPresent(['/a', '/b'], () => true)).toBe(true)
  })

  it('1つでも消えていれば false', () => {
    const exists = (p: string) => p !== '/b'
    expect(cachedPathDirsStillPresent(['/a', '/b'], exists)).toBe(false)
  })

  it('渡す dirs が空なら true（もともと存在しなかった項目は、そもそも渡さない＝判定しない）', () => {
    expect(cachedPathDirsStillPresent([], () => false)).toBe(true)
  })

  it('exists が例外を投げても false に倒す（分からないものを「ある」に倒さない）', () => {
    expect(cachedPathDirsStillPresent(['/a'], () => { throw new Error('boom') })).toBe(false)
  })
})

describe('readShellConfigStamps（PATH を変えうる場所を、取りこぼさず印にする）', () => {
  const ids = (s: ReturnType<typeof stamps>) => s.map(x => x.file)

  it('存在するものは更新時刻、存在しないものは null を覚える', () => {
    put(path.join(homeDir, '.zshrc'))
    const got = stamps()
    expect(typeof got.find(s => s.file === '.zshrc')!.mtimeMs).toBe('number')
    expect(got.find(s => s.file === '.bashrc')!.mtimeMs).toBe(null)
  })

  it('★ 顔ぶれを書き下す（一覧を回すだけのテストは、中身が減っても気づけない）', () => {
    const got = ids(stamps())
    // ホーム直下（zsh・bash・fish）
    for (const f of ['.zprofile', '.zshrc', '.zshenv', '.zlogin',
      '.profile', '.bash_profile', '.bash_login', '.bashrc', '.config/fish/config.fish']) {
      expect(got).toContain(f)
    }
    expect([...SHELL_CONFIG_FILES]).toContain('.config/fish/config.fish') // fish を落とさない
    expect([...SHELL_CONFIG_FILES]).toContain('.zlogin')
    // fish の conf.d（フォルダ自身＝中身の増減）
    expect(got).toContain(path.join(homeDir, '.config/fish/conf.d'))
    // システム側（path_helper が読む場所・インストーラが書く場所）
    for (const f of ['paths', 'zprofile', 'zshenv', 'zshrc', 'profile', 'bashrc']) {
      expect(got).toContain(path.join(etcDir, f))
    }
    expect(got).toContain(path.join(etcDir, 'paths.d'))
  })

  it('★ フォルダは中身も1つずつ覚える（/etc/paths.d に置かれたものを見落とさない）', () => {
    put(path.join(etcDir, 'paths.d', 'docker'), '/usr/local/bin')
    const got = ids(stamps())
    expect(got).toContain(path.join(etcDir, 'paths.d', 'docker'))
    expect(got.length).toBe(ids(readShellConfigStamps({ homeDir, etcDir: mkTmpDir('koto-etc2-') })).length + 1)
  })

  it('★ $ZDOTDIR を設定していれば、そちらの zsh 設定も印にする', () => {
    const withZ = ids(stamps(zdotDir))
    for (const f of ['.zprofile', '.zshrc', '.zshenv', '.zlogin']) {
      expect(withZ).toContain(path.join(zdotDir, f))
    }
    // ZDOTDIR がホームと同じなら二重に覚えない
    expect(ids(stamps(homeDir)).length).toBe(ids(stamps()).length)
  })
})

describe('loginPathCache（保存先を差し替えた読み書き）', () => {
  it('書いたものを読み戻せる', () => {
    writeLoginPathCache(entry() as any)
    expect(readLoginPathCache()).toEqual(entry())
    expect(loginPathCacheFile()).toBe(path.join(dataDir, 'login-path.json'))
  })
  it('ファイルが無ければ null', () => {
    expect(readLoginPathCache()).toBe(null)
  })
  it('壊れた JSON は null（黙って使わない）', () => {
    fs.writeFileSync(path.join(dataDir, 'login-path.json'), '{ぐちゃ', 'utf-8')
    expect(readLoginPathCache()).toBe(null)
    expect(isLoginPathCacheFresh(readLoginPathCache(), current())).toBe(false)
  })
})

describe('cachedLoginPathValue（調べ直しに失敗したときの逃げ道）', () => {
  it('版と形が正しければ PATH を返す', () => {
    expect(cachedLoginPathValue(entry())).toBe('/opt/homebrew/bin:/usr/bin:/bin')
  })
  it('版が違う・壊れているときは null', () => {
    expect(cachedLoginPathValue(entry({ version: 99 }))).toBe(null)
    expect(cachedLoginPathValue(null)).toBe(null)
    expect(cachedLoginPathValue(entry({ path: '' }))).toBe(null)
  })
})

// D-18（2026-09-16）: 覚えが無い／古いときの取得は**非同期**になった（窓を先に出すため）。
// `applyLoginPath` は `{ immediate, done }` を返し、覚えたものを使えたときだけ immediate が
// 最終結果（'cached'）になる。ここの試験は「何を調べ直すか」を見るものなので、
// **最終結果**（done）で判定する。**窓を待たせないこと自体**は tests/loginPathAsync.test.ts。
const applyAndWait = (d: LoginPathDeps) => applyLoginPath(d).done

describe('applyLoginPath: 覚えたものを使うときはログインシェルを起動しない', () => {
  let spawns = 0
  let clock = NOW
  const deps = (over: Partial<LoginPathDeps> = {}): LoginPathDeps => ({
    platform: 'darwin',
    homeDir,
    etcDir,
    zdotdir: null,
    shell: '/bin/zsh',
    now: () => clock,
    existsSync: () => false, // /opt/homebrew などの実在確認はテストでは常に「無い」
    readLoginShellPath: () => { spawns++; return '/opt/homebrew/bin:/usr/bin:/bin' },
    ...over,
  })

  beforeEach(() => {
    spawns = 0
    clock = NOW
    put(path.join(homeDir, '.zshrc'))
    process.env.PATH = '/usr/bin:/bin'
  })

  /** 1回目で覚えさせ、「これを変えたら調べ直すか」を確かめる。 */
  async function refreshesAfter(change: () => void, over: Partial<LoginPathDeps> = {}): Promise<string> {
    expect((await applyAndWait(deps())).source).toBe('fresh')
    expect(spawns).toBe(1)
    expect((await applyAndWait(deps())).source).toBe('cached') // 何もしなければ使い回す
    expect(spawns).toBe(1)
    change()
    const r = await applyAndWait(deps(over))
    return r.source
  }

  it('1回目は調べ直し、2回目は覚えたものを使う（起動回数は 1 のまま）', async () => {
    const first = await applyAndWait(deps())
    expect(first.source).toBe('fresh')
    expect(first.after).toBe('/opt/homebrew/bin:/usr/bin:/bin')
    expect(spawns).toBe(1)

    const second = await applyAndWait(deps())
    expect(second.source).toBe('cached')
    expect(second.spawnMs).toBe(0)
    expect(second.after).toBe('/opt/homebrew/bin:/usr/bin:/bin')
    expect(spawns).toBe(1) // ★シェルを起動していない
    expect(describeLoginPathResult(second)).toBe('ok (cached)')
  })

  it('設定ファイルが変わったら調べ直す', async () => {
    expect(await refreshesAfter(() => touchLater(path.join(homeDir, '.zshrc')))).toBe('fresh')
    expect(spawns).toBe(2)
  })

  it('SHELL が変わったら調べ直す', async () => {
    expect(await refreshesAfter(() => {}, { shell: '/bin/bash' })).toBe('fresh')
    expect(spawns).toBe(2)
  })

  // ── ここから 2026-09-16 の検分で足した経路（どれも「永久に気づけない」形だった）──
  it('★ fish の config.fish を書き換えたら調べ直す', async () => {
    const cfg = put(path.join(homeDir, '.config/fish/config.fish'), 'set -x PATH /opt/homebrew/bin $PATH')
    expect(await refreshesAfter(() => touchLater(cfg))).toBe('fresh')
    expect(spawns).toBe(2)
  })

  it('★ fish の conf.d に *.fish が置かれたら調べ直す', async () => {
    fs.mkdirSync(path.join(homeDir, '.config/fish/conf.d'), { recursive: true })
    expect(await refreshesAfter(() =>
      put(path.join(homeDir, '.config/fish/conf.d/brew.fish'), 'fish_add_path /opt/homebrew/bin'))).toBe('fresh')
    expect(spawns).toBe(2)
  })

  it('★ ~/.zlogin が作られたら調べ直す（ログインシェルでだけ読まれる）', async () => {
    expect(await refreshesAfter(() => put(path.join(homeDir, '.zlogin'), 'PATH=/opt/tool/bin:$PATH'))).toBe('fresh')
    expect(spawns).toBe(2)
  })

  it('★ /etc/paths が変わったら調べ直す（path_helper が読む大元）', async () => {
    const etcPaths = put(path.join(etcDir, 'paths'), '/usr/bin\n/bin')
    expect(await refreshesAfter(() => touchLater(etcPaths))).toBe('fresh')
    expect(spawns).toBe(2)
  })

  it('★ /etc/paths.d にインストーラが置いたら調べ直す', async () => {
    expect(await refreshesAfter(() => put(path.join(etcDir, 'paths.d', 'docker'), '/usr/local/bin'))).toBe('fresh')
    expect(spawns).toBe(2)
  })

  it('★ /etc/zprofile が変わったら調べ直す', async () => {
    const etcZprofile = put(path.join(etcDir, 'zprofile'), 'eval `/usr/libexec/path_helper -s`')
    expect(await refreshesAfter(() => touchLater(etcZprofile))).toBe('fresh')
    expect(spawns).toBe(2)
  })

  it('★ $ZDOTDIR が設定されたら調べ直す／その下の .zshrc が変わっても調べ直す', async () => {
    expect(await refreshesAfter(() => {}, { zdotdir: zdotDir })).toBe('fresh')
    expect(spawns).toBe(2)
    expect((await applyAndWait(deps({ zdotdir: zdotDir }))).source).toBe('cached')
    const zshrc = put(path.join(zdotDir, '.zshrc'), 'path+=(/opt/tool/bin)')
    expect((await applyAndWait(deps({ zdotdir: zdotDir }))).source).toBe('fresh')
    touchLater(zshrc)
    expect((await applyAndWait(deps({ zdotdir: zdotDir }))).source).toBe('fresh')
    expect(spawns).toBe(4)
  })

  it('★ 期限（7日）を過ぎたら、印が同じでも調べ直す', async () => {
    expect((await applyAndWait(deps())).source).toBe('fresh')
    clock = NOW + LOGIN_PATH_CACHE_MAX_AGE_MS
    expect((await applyAndWait(deps())).source).toBe('cached') // ちょうどはまだ使える
    expect(spawns).toBe(1)
    clock = NOW + LOGIN_PATH_CACHE_MAX_AGE_MS + 1
    expect((await applyAndWait(deps())).source).toBe('fresh')
    expect(spawns).toBe(2)
    // 調べ直したら期限も更新される（次はまた使える）
    expect((await applyAndWait(deps())).source).toBe('cached')
    expect(spawns).toBe(2)
  })

  it('★ KOTO_LOGIN_PATH_REFRESH=1 なら覚えを捨てて調べ直す', async () => {
    expect((await applyAndWait(deps())).source).toBe('fresh')
    expect((await applyAndWait(deps())).source).toBe('cached')
    process.env.KOTO_LOGIN_PATH_REFRESH = '1'
    expect((await applyAndWait(deps({ forceRefresh: undefined }))).source).toBe('fresh')
    expect(spawns).toBe(2)
    delete process.env.KOTO_LOGIN_PATH_REFRESH
    expect((await applyAndWait(deps())).source).toBe('cached')
    expect(spawns).toBe(2)
  })

  it('調べ直しに失敗したら古い覚えを使う（stale とログに出す）', async () => {
    await applyAndWait(deps())
    touchLater(path.join(homeDir, '.zshrc')) // 状況が変わった＝調べ直しが要る
    process.env.PATH = '/usr/bin:/bin'
    const r = await applyAndWait(deps({
      readLoginShellPath: () => { throw new Error('spawnSync /bin/zsh ETIMEDOUT') },
    }))
    expect(r.source).toBe('stale')
    expect(r.after).toBe('/opt/homebrew/bin:/usr/bin:/bin')
    expect(describeLoginPathResult(r)).toContain('stale cache')
  })

  it('覚えが無く調べ直しも失敗したら、PATH を変えない', async () => {
    const r = await applyAndWait(deps({
      readLoginShellPath: () => { throw new Error('ETIMEDOUT') },
    }))
    expect(r.ok).toBe(false)
    expect(r.source).toBe('none')
    expect(process.env.PATH).toBe('/usr/bin:/bin')
    // D-18: 窓を出したあとに決まった結果なので「あとから反映」が付く
    expect(describeLoginPathResult(r)).toBe('skip (ETIMEDOUT)・あとから反映')
  })
})

// ★ D-17 A（2026-09-16・検分の指摘）: 覚えたものを使ってよいかの判定が、これまで設定ファイルの
// 更新時刻しか見ておらず、**設定ファイルを書き換えずに PATH の中身だけが消える経路**
//（nvm/rbenv/pyenv の切り替え・brew uninstall・道具を別の場所へ移す、等）を検知できなかった。
// ここでは、覚えた時点で実在した PATH のフォルダが消えたときに、実際に調べ直す（＝シェルの
// 起動回数が増える）ことを、また「もともと無かった項目」では調べ直さないことを固定する。
describe('applyLoginPath: 覚えた PATH のフォルダの実在確認（D-17 A）', () => {
  let spawns = 0
  let clock = NOW
  let presentDirs: Set<string>
  // /usr/local/bin はログインシェルの PATH には含まれるが、このテストでは最初から
  // 実在しない＝「もともと存在しなかった項目」として扱われる（pathDirsPresent に入らない）。
  const loginPathValue = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'

  const deps = (over: Partial<LoginPathDeps> = {}): LoginPathDeps => ({
    platform: 'darwin',
    homeDir,
    etcDir,
    zdotdir: null,
    shell: '/bin/zsh',
    now: () => clock,
    existsSync: (p: string) => presentDirs.has(p),
    readLoginShellPath: () => { spawns++; return loginPathValue },
    ...over,
  })

  beforeEach(() => {
    spawns = 0
    clock = NOW
    put(path.join(homeDir, '.zshrc'))
    process.env.PATH = '/usr/bin:/bin'
    presentDirs = new Set(['/opt/homebrew/bin', '/usr/bin', '/bin']) // /usr/local/bin は含めない
  })

  it('覚えた時点で実在したフォルダが今も全部あれば、覚えたものを使う（シェル未起動）', async () => {
    expect((await applyAndWait(deps())).source).toBe('fresh')
    expect(spawns).toBe(1)
    const r = await applyAndWait(deps())
    expect(r.source).toBe('cached')
    expect(r.spawnMs).toBe(0)
    expect(spawns).toBe(1) // ★シェルを起動していない
  })

  it('実在したフォルダのうち1つが消えたら調べ直す（例: brew uninstall・nvm の切り替え）', async () => {
    expect((await applyAndWait(deps())).source).toBe('fresh')
    expect(spawns).toBe(1)
    presentDirs.delete('/opt/homebrew/bin') // 設定ファイルは変わらないまま、フォルダだけ消えた
    const r = await applyAndWait(deps())
    expect(r.source).toBe('fresh') // ★ここが本題: 設定ファイルの更新時刻は同じでも調べ直す
    expect(spawns).toBe(2)
    expect(describeLoginPathResult(r)).toContain('PATH のフォルダが変わったため調べ直し')
  })

  it('もともと存在しなかった項目（/usr/local/bin）は、今も無くても調べ直さない', async () => {
    expect((await applyAndWait(deps())).source).toBe('fresh')
    expect(spawns).toBe(1)
    // /usr/local/bin はここでも presentDirs に入れない＝ずっと無いまま。
    expect((await applyAndWait(deps())).source).toBe('cached')
    expect(spawns).toBe(1)
  })

  it('古い形式（pathDirsPresent が無い覚え）は調べ直す', async () => {
    const legacy = {
      version: LOGIN_PATH_CACHE_VERSION,
      shell: '/bin/zsh',
      zdotdir: null,
      configs: stamps(),
      path: loginPathValue,
      savedAt: NOW,
      // pathDirsPresent を持たない（version 3 より前の形）
    }
    const r = await applyAndWait(deps({ readCache: () => legacy }))
    expect(r.source).toBe('fresh')
    expect(spawns).toBe(1)
  })
})
