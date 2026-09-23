// loginPath.ts — GUI起動時に PATH が最小限になる問題への対処（2026-08-01）。
//
// 背景（実測で確定）: macOS では Finder/Dock から起動したアプリの PATH は launchd の最小構成
// （/usr/bin:/bin:/usr/sbin:/sbin 等）になり、Homebrew の /opt/homebrew/bin などが入らない。
// Homebrew の PATH 設定（eval "$(brew shellenv)"）は **~/.zprofile に書かれるのが標準**で、
// これは**ログインシェルでしか読まれない**。Koto は main で process.env をそのまま使っていたため、
// 次の3か所すべてで「入っているのに見つからない」が起きていた:
//   - AIの run_command（proc:run）… `npm: command not found`（2026-07-30 ユーザー報告の正体）
//   - ターミナルパネル（node-pty を -l なしで起動）
//   - shell:which（前提チェック）… **docker を「未インストール」と誤判定しうる**（AppRun公開の前提）
//
// 対処: 起動時に一度だけログインシェルから PATH を取り出し、main の process.env.PATH へ反映する。
// 取得は短いタイムアウト付きで、失敗しても現状のまま動く（起動を止めない）。
//
// ここには IO を持たない純粋関数を置き、実際の実行は applyLoginPath()（下）が行う。
//
// 2026-09-16 追記（起動が遅い主因）: この取得は**毎回 1.22 秒**かかっていた（実測）。
// 3 秒の上限に達して打ち切られた起動もある（`[login-path] skip (spawnSync /bin/zsh ETIMEDOUT)`）。
// PATH の値が要るだけで毎回調べ直す必要は無いため、結果を覚えるようにした（下の「覚える」節）。
//
// 2026-09-16 追記（D-18・窓を先に出す）: 覚えが無い／古いときの取得を**非同期**にした。
// PATH は**道具を使うときに要るもの**で、**窓を出すのに要るものではない**。
//   - 覚えたものがあるとき（0 秒）は今までどおり**同期で即座に**適用する（振る舞いを変えない）。
//   - 覚えが無い／古いときは取得を始めるだけで**待たない**。窓を出す処理が先へ進む。
//     取れたら `process.env.PATH` へ入れる（合成のしかたは変えない）。`process.env.PATH` は
//     子プロセスに受け継がれるので、**あとから起動する道具にはすべて効く**。
//   - 決まる前に道具を起動されると古い PATH のままになるので、**道具を起動する入口**で
//     `await awaitLoginPath()`（下の「待つ」節）を通す。決まっていれば 0 コスト。
//   - 取得に失敗したら**印を残す**（loginPathFailureReason）。「入っているはずの npm が
//     見つからない」という原因の分からない不調に、見当を添えるために使う。

import { execFile } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { readLoginPathCache, writeLoginPathCache } from './loginPathCache'

/** PATH 文字列として妥当そうか（コロン区切りで、絶対パスの要素を1つ以上含む）。
 *  ログインシェルの出力にプロファイルの print 等が混ざった場合に、それを PATH として採用しないための検査。 */
export function looksLikePath(s: string | null | undefined): boolean {
  if (typeof s !== 'string') return false
  const t = s.trim()
  if (!t) return false
  if (t.includes('\n')) return false // 複数行＝プロファイルの出力が混ざっている
  return t.split(':').some(p => p.startsWith('/'))
}

/**
 * 複数の PATH 文字列（や候補ディレクトリ）を、順序を保ったまま重複なく1本に連結する。
 * 先に渡したものが優先（前に来る）。空文字・undefined は無視する。
 */
export function mergePathEntries(...lists: (string | null | undefined)[]): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    if (typeof list !== 'string' || !list) continue
    for (const entry of list.split(':')) {
      const e = entry.trim()
      if (!e || seen.has(e)) continue
      seen.add(e)
      out.push(e)
    }
  }
  return out.join(':')
}

/** ログインシェルから PATH を取り出すためのコマンド引数を組み立てる（シェルごとの方言に対応）。
 *  fish は $PATH がリスト変数で `printf "%s" $PATH` だと空白区切りになるため、明示的に : で連結する。 */
export function loginPathArgs(shellPath: string): string[] {
  const name = (shellPath || '').split('/').pop() ?? ''
  if (name === 'fish') return ['-l', '-c', 'string join : $PATH']
  return ['-l', '-c', 'printf %s "$PATH"']
}

// ── 覚える（2026-09-16）─────────────────────────────────────────────────
// 一度調べた PATH を userData/login-path.json に覚えておき、「前と同じ状況」ならシェルを
// **起動せずに**そのまま使う（0 秒）。「前と同じ状況」は次の**すべて**が一致すること
// （1つでも違えば調べ直して覚え直す）:
//   1. SHELL が同じ（使うシェルが変われば PATH も変わりうる）
//   2. $ZDOTDIR が同じ（zsh はここが変わると読む設定ファイルが丸ごと変わる）
//   3. PATH を書きうる設定ファイルの更新時刻が同じ（**存在しないファイルは「無い」という
//      事実ごと覚える**＝あとで作られたら調べ直しになる）
//   4. 覚えてから日が経ちすぎていない（LOGIN_PATH_CACHE_MAX_AGE_MS）
//   5. 覚えた形式の版が同じ（形を変えたら古い覚えは捨てる）
//   6. 覚えた時点で実在した PATH のフォルダが、今も全部実在する（cachedPathDirsStillPresent）
// 判定は純関数 isLoginPathCacheFresh（1〜5）・cachedPathDirsStillPresent（6）に閉じてある
//（保存の IO は loginPathCache.ts）。
//
// 2026-09-16 検分の指摘で 2・3（顔ぶれ）・4 を足した。初版はホーム直下の6つの dotfile しか
// 見ておらず、**次の経路で PATH が変わっても永久に気づけなかった**（再起動しても直らない）:
//   - fish（`~/.config/fish/config.fish`・`~/.config/fish/conf.d/*.fish`）。loginPathArgs が
//     fish を明示的に扱っているのに、その設定ファイルだけ印に入っていなかった
//   - zsh の `~/.zlogin`（ログインシェルでだけ読まれる＝まさにここで調べている経路）
//   - システム側（`/etc/paths`・`/etc/paths.d/*`・`/etc/zprofile` ほか）。macOS の
//     `path_helper` はここを読む。**インストーラが `/etc/paths.d` に置く**のが典型
//   - `$ZDOTDIR`（zsh の設定の置き場をホーム以外にしている人）
// これらを取りこぼすと、この機能が本来直したはずの「入っているのに見つからない」へ
// 静かに戻る。どれだけ顔ぶれを増やしても漏れは残りうるので、**期限（4）を最後の砦にする**。
//
// 2026-09-16 D-17 A: さらに 6 を足した。1〜5 は**設定ファイルの更新時刻**しか見ておらず、
// **設定ファイルを書き換えずに PATH の中身だけが消える経路**に気づけなかった（nvm/rbenv/pyenv
// でのバージョン切り替え・`brew uninstall`・道具を別の場所へ移す、等）。この状態だと、利用者
// からは「入っているはずの npm が見つからない」という原因不明の不調が、期限（4・最長7日）まで
// 続く。覚えるときに PATH のフォルダのうち実在したものだけを `pathDirsPresent` として控え、
// 使うときに**それが今も全部実在するか**を確かめる（もともと無かった項目は最初から控えていない
// ので判定しない＝それで毎回調べ直しになる事態を避ける）。

/** 覚えた形式の版。LoginPathCacheEntry の形を変えたら必ず上げる（古い覚えが使われなくなる）。
 *  2（初版は 1）: zdotdir を足し、印の顔ぶれ（fish・/etc・.zlogin）を増やした。
 *  3（D-17 A・2026-09-16）: pathDirsPresent を足した。設定ファイルの更新時刻だけでは、
 *  設定ファイルを書き換えずに PATH の中身だけが消える経路（nvm/rbenv/pyenv の切り替え・
 *  brew uninstall・道具の移動）に気づけないため。 */
export const LOGIN_PATH_CACHE_VERSION = 3

/**
 * 覚えたものを使ってよい期限。**7 日**。
 * 根拠は実測ではなく方針: 印（下の顔ぶれ）は PATH を変えうる経路を**すべては**覆えない
 * （独自の場所から読み込む設定・`launchctl config` など）。覆えない経路で PATH が変わると
 * 印だけでは永久に気づけないので、**必ずいつか調べ直す**ようにする。代償は7日に一度の
 * 1.2 秒（実測値・2026-09-16）だけで、利用者には「たまに起動が一瞬遅い」以上の影響が無い。
 */
export const LOGIN_PATH_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** PATH を設定しうる設定ファイル（ホーム直下・存在しないものも「無い」として覚える）。 */
export const SHELL_CONFIG_FILES = [
  // zsh（macOS の既定のシェル）
  '.zprofile', '.zshrc', '.zshenv',
  '.zlogin',                   // ログインシェルでだけ読まれる＝この機能が通る経路そのもの
  // sh / bash
  '.profile', '.bash_profile', '.bash_login', '.bashrc',
  // fish（loginPathArgs が明示的に扱っているのに、初版は印に入っていなかった）
  '.config/fish/config.fish',
] as const

/** zsh が $ZDOTDIR の下から読むもの（ZDOTDIR が設定されているときだけ、そちらも印にする）。 */
export const ZDOTDIR_CONFIG_FILES = ['.zprofile', '.zshrc', '.zshenv', '.zlogin'] as const

/** 中身の**増減**でも PATH が変わるフォルダ（ホーム直下）。フォルダ自身＋直下の各ファイルを覚える。 */
export const SHELL_CONFIG_DIRS = ['.config/fish/conf.d'] as const

/** システム側の設定の置き場。テストで差し替えるためだけに定数にしてある（本番は /etc）。 */
export const SYSTEM_CONFIG_DIR = '/etc'

/** システム側の設定ファイル（SYSTEM_CONFIG_DIR からの相対）。
 *  macOS の path_helper は /etc/paths と /etc/paths.d/* を読んで PATH を組み立て、
 *  それを呼ぶのは /etc/zprofile・/etc/profile。ここが変わると全ユーザーの PATH が変わる。 */
export const SYSTEM_CONFIG_FILES = [
  'paths', 'zprofile', 'zshenv', 'zshrc', 'profile', 'bashrc',
] as const

/** システム側の「中身の増減で PATH が変わる」フォルダ。**インストーラが書く場所**。 */
export const SYSTEM_CONFIG_DIRS = ['paths.d'] as const

/** 設定ファイル1つ分の印。mtimeMs が null＝そのとき存在しなかった（という事実を覚える）。 */
export type ShellConfigStamp = { file: string; mtimeMs: number | null }

/** userData/login-path.json に覚える中身。 */
export type LoginPathCacheEntry = {
  version: number
  shell: string
  /** $ZDOTDIR（zsh の設定の置き場）。未設定なら null。 */
  zdotdir: string | null
  configs: ShellConfigStamp[]
  /** ログインシェルから取り出した**生の** PATH（合成後ではない。合成は毎回やり直す＝安い）。 */
  path: string
  /**
   * 覚えた時点で `path` に並ぶフォルダのうち**実在したもの**（version 3・D-17 A）。
   * もともと存在しなかった項目は入れない（PATH には最初から実在しない項目が混ざるのが
   * 普通なので、それも覚えると毎回調べ直しになってしまう）。使うときに
   * cachedPathDirsStillPresent で「今も全部実在するか」を確かめ、1つでも消えていれば
   * 調べ直す——設定ファイルの更新時刻だけでは、設定ファイルを書き換えずに PATH の中身
   * だけが消える経路（nvm/rbenv/pyenv の切り替え・brew uninstall・道具の移動）に
   * 気づけないため。
   */
  pathDirsPresent: string[]
  savedAt: number
}

/** 印を読むときの置き場（テストで差し替える。本番は既定のまま）。 */
export type StampSources = {
  homeDir?: string
  /** $ZDOTDIR。未指定なら process.env.ZDOTDIR、null なら「設定されていない」。 */
  zdotdir?: string | null
  /** システム側の置き場（本番は /etc）。 */
  etcDir?: string
}

/** ファイル1つ分の印。stat が失敗したら null——**分からないものを「同じ」に倒さない**。
 *  次に stat が成功すれば値が変わるので、その回は調べ直しになる（安全側）。 */
function stampOf(id: string, full: string): ShellConfigStamp {
  try {
    return { file: id, mtimeMs: fs.statSync(full).mtimeMs }
  } catch {
    return { file: id, mtimeMs: null }
  }
}

/** フォルダ1つ分の印。**フォルダ自身**（＝中身の増減で変わる）と、**直下の各ファイル**
 *  （＝中身の書き換えで変わる）の両方を覚える。顔ぶれが変われば長さが変わるので、
 *  ファイルが増えても減っても isLoginPathCacheFresh は false になる。 */
function stampsOfDir(dir: string): ShellConfigStamp[] {
  const out = [stampOf(dir, dir)]
  let names: string[] = []
  try {
    names = fs.readdirSync(dir).sort()
  } catch {
    return out // 無い＝フォルダ自身が mtimeMs: null として覚わる（あとで作られたら調べ直し）
  }
  for (const name of names) {
    const full = path.join(dir, name)
    out.push(stampOf(full, full))
  }
  return out
}

/** $ZDOTDIR を決める（未指定なら環境変数。空文字は「設定されていない」扱い）。 */
export function resolveZdotdir(src: StampSources = {}): string | null {
  if ('zdotdir' in src) return src.zdotdir ?? null
  return process.env.ZDOTDIR || null
}

/**
 * PATH を設定しうる設定ファイル・フォルダの印を読む。
 * ここに挙げた顔ぶれが「覚えたものを捨てる合図」のすべてである（＋期限）。
 * stat を数十回するだけ（1 ミリ秒未満）で、ログインシェルの 1.2 秒とは桁が違う。
 */
export function readShellConfigStamps(src: StampSources = {}): ShellConfigStamp[] {
  const home = src.homeDir ?? os.homedir()
  const etc = src.etcDir ?? SYSTEM_CONFIG_DIR
  const zdotdir = resolveZdotdir(src)
  const out: ShellConfigStamp[] = []

  for (const file of SHELL_CONFIG_FILES) out.push(stampOf(file, path.join(home, file)))
  for (const dir of SHELL_CONFIG_DIRS) out.push(...stampsOfDir(path.join(home, dir)))
  // ZDOTDIR がホームと同じなら二重に覚えない（顔ぶれが増えるだけで意味が無い）。
  if (zdotdir && path.resolve(zdotdir) !== path.resolve(home)) {
    for (const file of ZDOTDIR_CONFIG_FILES) {
      const full = path.join(zdotdir, file)
      out.push(stampOf(full, full))
    }
  }
  for (const file of SYSTEM_CONFIG_FILES) {
    const full = path.join(etc, file)
    out.push(stampOf(full, full))
  }
  for (const dir of SYSTEM_CONFIG_DIRS) out.push(...stampsOfDir(path.join(etc, dir)))
  return out
}

/** 覚えた印と今の印が同じか（順序は問わないが、顔ぶれと値は完全一致を要求する）。 */
function sameStamps(cached: unknown, current: ShellConfigStamp[]): boolean {
  if (!Array.isArray(cached) || cached.length !== current.length) return false
  for (const want of current) {
    const got = cached.find(c => c && typeof c === 'object' && (c as ShellConfigStamp).file === want.file) as
      | ShellConfigStamp | undefined
    if (!got) return false
    const m = got.mtimeMs
    if (m !== null && typeof m !== 'number') return false // 形が違う（文字列など）→ 使わない
    if (m !== want.mtimeMs) return false
  }
  return true
}

/** 覚えてからの日数が期限内か（純関数）。
 *  savedAt が数値でない＝形が違う → false。**未来の日付も false**（時計が動いた・書き換えられた＝
 *  「分からない」。1回余計に 1.2 秒かけて調べ直すだけなので安全側に倒す）。 */
export function isWithinMaxAge(
  savedAt: unknown,
  now: number,
  maxAgeMs: number = LOGIN_PATH_CACHE_MAX_AGE_MS,
): boolean {
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return false
  if (!Number.isFinite(now)) return false
  const age = now - savedAt
  if (age < 0) return false
  return age <= maxAgeMs
}

/**
 * 覚えたものをそのまま使ってよいか（純関数・IO なし）。
 * 壊れている／読めない／形が違うときは **false**（「分からない」を「使ってよい」に倒さない）。
 * `now` を渡さない呼び方はしない（期限を見ないで済む抜け道を作らないため、必須にしてある）。
 */
export function isLoginPathCacheFresh(
  cached: unknown,
  current: { shell: string; zdotdir: string | null; configs: ShellConfigStamp[]; now: number },
  maxAgeMs: number = LOGIN_PATH_CACHE_MAX_AGE_MS,
): cached is LoginPathCacheEntry {
  if (!cached || typeof cached !== 'object' || Array.isArray(cached)) return false
  const c = cached as Record<string, unknown>
  if (c.version !== LOGIN_PATH_CACHE_VERSION) return false
  if (typeof c.shell !== 'string' || c.shell !== current.shell) return false
  // zdotdir は string か null のみ受ける（無い＝古い形／壊れている → 使わない）。
  if (!(c.zdotdir === null || typeof c.zdotdir === 'string')) return false
  if (c.zdotdir !== (current.zdotdir ?? null)) return false
  if (!looksLikePath(typeof c.path === 'string' ? c.path : null)) return false
  // pathDirsPresent は version 3 で足した必須項目。無い・形が違う＝古い形式の残骸なので
  // 使わない（version の不一致だけでも弾けるはずだが、壊れた／手で作った覚えにも同じく倒す）。
  if (!Array.isArray(c.pathDirsPresent) || !c.pathDirsPresent.every(d => typeof d === 'string')) return false
  if (!isWithinMaxAge(c.savedAt, current.now, maxAgeMs)) return false
  return sameStamps(c.configs, current.configs)
}

/**
 * 覚えた時点で実在した PATH のフォルダ（`dirs`）が、**今も全部実在するか**（純関数）。
 * 1つでも消えていれば false（＝調べ直す）。`dirs` には「覚えた時点で実在したもの」だけを
 * 渡すこと——もともと存在しなかった項目は最初から `dirs` に入らないので、ここでは判定しない
 * （PATH には実在しない項目が普通に混ざり、それも調べると毎回調べ直しになって意味が無い）。
 * `exists` は差し替え可能（テスト用。本番は fs.existsSync）。
 */
export function cachedPathDirsStillPresent(
  dirs: string[],
  exists: (p: string) => boolean,
): boolean {
  return dirs.every(d => {
    try {
      return exists(d)
    } catch {
      return false // 「分からない」→ 実在しない扱い（安全側＝調べ直す方に倒す）
    }
  })
}

/** 覚えたものから PATH だけ取り出す（版と形だけ見る）。**調べ直しに失敗したときの逃げ道**専用。 */
export function cachedLoginPathValue(cached: unknown): string | null {
  if (!cached || typeof cached !== 'object' || Array.isArray(cached)) return null
  const c = cached as Record<string, unknown>
  if (c.version !== LOGIN_PATH_CACHE_VERSION) return null
  return typeof c.path === 'string' && looksLikePath(c.path) ? c.path : null
}

/**
 * ログインシェルの PATH を取得して process.env.PATH へ反映する（起動時に1回だけ呼ぶ）。
 * - 反映後の PATH は「ログインシェルのPATH → 元のPATH → 実在する定番ディレクトリ」の順で重複なく連結する
 *   （元のPATHを捨てないのは、開発時に `npm run electron` から起動した場合の環境を壊さないため）。
 * - 取得できない・出力が PATH らしくない場合は何もしない（起動は止めない）。
 * - **覚えたものが使えるときはシェルを起動しない**（source: 'cached'・0 秒）。
 * 戻り値は診断用（スモークテストのログで確認できるようにする）。
 */
export type LoginPathSource = 'cached' | 'fresh' | 'stale' | 'none' | 'pending'

export type LoginPathResult = {
  ok: boolean
  before: string
  after: string
  /** cached＝覚えたものを使った（シェル未起動）／fresh＝調べ直した／stale＝調べ直しに失敗して古い覚えを使った／
   *  none＝何もしなかった／pending＝**まだ決まっていない**（調べ始めただけ。窓は先に出す・D-18） */
  source: LoginPathSource
  /** ログインシェルを起こすのに掛かった時間（ms）。覚えたものを使ったときは 0。 */
  spawnMs: number
  /** source が 'fresh' のときは調べ直した理由（覚えた時点で実在した PATH のフォルダが
   *  消えていたときだけ入る）。'stale' のときは調べ直しに失敗した理由。 */
  message?: string
  /** 窓を出したあとに決まった結果（ログに「あとから反映」と出すため・D-18）。 */
  deferred?: boolean
}

/**
 * `applyLoginPath()` の戻り値（D-18）。**窓を出す側は immediate だけ見て先へ進む。**
 * - `immediate`: 呼んだ時点で分かっていること。覚えたものが使えたなら 'cached'（適用済み）、
 *   調べ直しが要るなら 'pending'（**まだ PATH は変わっていない**）。
 * - `done`: 最終結果。immediate が 'pending' でなければ**すでに解決済み**。
 */
export type LoginPathStart = {
  immediate: LoginPathResult
  done: Promise<LoginPathResult>
}

// ── 待つ（D-18 C）───────────────────────────────────────────────────
// `process.env.PATH` に入れるだけだと、**決まる前に道具を起動した場合**（起動直後に利用者が
// 押した場合）に古い PATH のまま子プロセスが立ち上がる。道具を起動する入口で
// `await awaitLoginPath()` を通し、決まるまでだけ待つ。
//
// **決まっていれば 0 コスト**（解決済みの Promise を返すだけ＝マイクロタスク1つ）。
// 待つのは「覚えが無い／古い起動の、最初の数秒に道具を押した」場合だけで、その待ちも
// 取得そのものの上限（LOGIN_PATH_SPAWN_TIMEOUT_MS）で必ず終わる。

/** 解決済みの Promise（毎回作らない）。 */
const ALREADY_SETTLED: Promise<void> = Promise.resolve()

/** 取得中ならその Promise。決まっている（or 調べていない）なら null。 */
let pendingLoginPath: Promise<void> | null = null

/** 取得に失敗した理由（成功・未実施なら null）。D の「印」。 */
let loginPathFailure: string | null = null

/**
 * PATH が決まるのを待つ。**道具（npm・docker・crane・シェル・ターミナル）を起動する直前に呼ぶ。**
 * 覚えたものを使ったとき・調べ終わったとき・そもそも調べていないときは**即座に解決**する。
 */
export function awaitLoginPath(): Promise<void> {
  return pendingLoginPath ?? ALREADY_SETTLED
}

/** 取得に失敗していればその理由、直っていれば null（D の印）。 */
export function loginPathFailureReason(): string | null {
  return loginPathFailure
}

/** 「入っているはずの道具が見つからない」に添える、原因の見当（D）。
 *  PATH の取得に失敗していないときは**空文字**（余計なことを言わない）。 */
export const LOGIN_PATH_NOT_FOUND_HINT =
  'なお、Koto の起動時に、お使いのシェルの設定から PATH（道具の置き場所の一覧）を読み取れませんでした。'
  + 'そのために、入っている道具が見つかっていない可能性があります。Koto を一度終了してから開き直すと直ることがあります。'

export function loginPathHintForMissingTool(): string {
  return loginPathFailure ? LOGIN_PATH_NOT_FOUND_HINT : ''
}

/** テスト用の差し替え口（本番の呼び出しは引数なし）。 */
export type LoginPathDeps = {
  platform?: NodeJS.Platform
  homeDir?: string
  /** $ZDOTDIR。未指定なら process.env.ZDOTDIR。 */
  zdotdir?: string | null
  /** システム側の設定の置き場（本番は /etc。テストで差し替える）。 */
  etcDir?: string
  shell?: string
  /** ログインシェルから PATH を取り出す。既定は execFile（非同期・1秒級）。
   *  テストが同期の関数を渡してもよい（戻り値を await するだけ）。 */
  readLoginShellPath?: (shell: string) => string | Promise<string>
  readCache?: () => unknown
  writeCache?: (entry: LoginPathCacheEntry) => void
  existsSync?: (p: string) => boolean
  now?: () => number
  /** 覚えたものを使わずに必ず調べ直す（覚えを捨てる手段）。
   *  未指定なら環境変数 KOTO_LOGIN_PATH_REFRESH=1。 */
  forceRefresh?: boolean
  /** 覚えたものを使ってよい期限（テスト用。本番は LOGIN_PATH_CACHE_MAX_AGE_MS）。 */
  maxAgeMs?: number
}

/**
 * ログインシェルを起こすのを待つ上限。**15 秒**（D-18 まで 3 秒）。
 *
 * 実測（2026-09-16・この機械）: `zsh -lc 'printf %s "$PATH"'` を10回で **0.72〜1.58 秒**
 * （平均約1.0秒）。**3 秒はばらつきの2〜3倍しかなく**、起動時は vite・tsc・crane の確認が
 * 同時に走るので実際に超えていた（実機ログ `[login-path] skip (spawnSync /bin/zsh ETIMEDOUT)`）。
 * 打ち切られると PATH が直らないまま動き続け、配布版では git・npm・node が
 * 「入っているのに見つからない」になる——**失敗の代償が、待つ代償よりずっと大きい**。
 * D-18 で**誰も待たなくなった**（窓は先に出る）ので、最悪値の約10倍まで広げる。
 * 無限にしないのは、応答しないシェルの子プロセスを残さないため。
 */
export const LOGIN_PATH_SPAWN_TIMEOUT_MS = 15000

/** 既定の取得方法（ログインシェルを**非同期で**起こして PATH を印字させる）。
 *  execFile は stdout / stderr を別々に渡すので、プロファイルが標準エラーへ出す出力は混ざらない。 */
function spawnLoginShellPath(shell: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      shell,
      loginPathArgs(shell),
      { encoding: 'utf-8', timeout: LOGIN_PATH_SPAWN_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err)
        else resolve(String(stdout ?? '').trim())
      },
    )
  })
}

/** 取り出した PATH を「ログインシェル → 元のPATH → 実在する定番ディレクトリ」の順で合成して反映する。 */
function applyMerged(loginPath: string, before: string, deps: LoginPathDeps): string {
  const exists = deps.existsSync ?? ((p: string) => { try { return fs.existsSync(p) } catch { return false } })
  // 定番の場所（Homebrew等）は、実在するときだけ保険として末尾に足す。
  const extras = ['/opt/homebrew/bin', '/usr/local/bin'].filter(exists).join(':')
  const after = mergePathEntries(loginPath, before, extras)
  process.env.PATH = after
  return after
}

/** すでに決まっている結果を LoginPathStart の形にする（done は解決済み）。 */
function settledStart(r: LoginPathResult): LoginPathStart {
  return { immediate: r, done: Promise.resolve(r) }
}

export function applyLoginPath(deps: LoginPathDeps = {}): LoginPathStart {
  // 1回の起動につき1回の試み。前回の残り（テストでの連続呼び出し）を持ち越さない。
  pendingLoginPath = null
  loginPathFailure = null

  const before = process.env.PATH ?? ''
  // macOS 以外（CI の Linux 等）では GUI 起動の PATH 問題が当てはまらないため何もしない。
  const platform = deps.platform ?? process.platform
  if (platform !== 'darwin') {
    return settledStart({
      ok: false, before, after: before, source: 'none', spawnMs: 0, message: 'darwin 以外のため何もしない',
    })
  }

  const shell = deps.shell ?? (process.env.SHELL || '/bin/zsh')
  const now = deps.now ?? Date.now
  const readCache = deps.readCache ?? readLoginPathCache
  const writeCache = deps.writeCache ?? writeLoginPathCache
  const readLoginShellPath = deps.readLoginShellPath ?? spawnLoginShellPath
  const zdotdir = resolveZdotdir(deps)
  const configs = readShellConfigStamps({ homeDir: deps.homeDir, zdotdir, etcDir: deps.etcDir })
  const maxAgeMs = deps.maxAgeMs ?? LOGIN_PATH_CACHE_MAX_AGE_MS
  // 覚えを捨てる手段（環境変数）。印も期限も当てにならないときの最後の逃げ道で、
  // 利用者に説明するものではなく、原因を切り分けるためにある。
  const forceRefresh = deps.forceRefresh ?? (process.env.KOTO_LOGIN_PATH_REFRESH === '1')

  let cached: unknown = null
  try { cached = readCache() } catch { cached = null }

  const existsFn = deps.existsSync ?? ((p: string) => { try { return fs.existsSync(p) } catch { return false } })

  // 1) 前と同じ状況 → 覚えたものを使う。**ここでシェルを起動しない**のが 1.22 秒の節約。
  //    ただし、覚えた時点で実在した PATH のフォルダが1つでも消えていれば（D-17 A）、
  //    設定ファイルの更新時刻だけでは気づけない変化なので調べ直す。
  let pathDirsChanged = false
  if (!forceRefresh && isLoginPathCacheFresh(cached, { shell, zdotdir, configs, now: now() }, maxAgeMs)) {
    if (cachedPathDirsStillPresent(cached.pathDirsPresent, existsFn)) {
      return settledStart({
        ok: true, before, after: applyMerged(cached.path, before, deps), source: 'cached', spawnMs: 0,
      })
    }
    pathDirsChanged = true // 印は同じだが、フォルダの実在が変わった → 下で調べ直す
  }

  // 2) 状況が変わった／覚えが無い／覚えが壊れている → 調べ直して覚え直す。
  //    **ここで待たない**（D-18）。取得を始めるだけで戻り、窓を出す処理を先へ進める。
  const done = refreshLoginPath({
    before, shell, configs, zdotdir, cached, deps,
    now, writeCache, readLoginShellPath, existsFn, pathDirsChanged,
  })
  // 道具を起動する入口（awaitLoginPath）は、これが決まるまで待つ。
  // **失敗しても待ちは終わる**（then の第2引数）——待ち続けると道具が永久に起動しない。
  pendingLoginPath = done.then(() => undefined, () => undefined)
  return {
    immediate: { ok: false, before, after: before, source: 'pending', spawnMs: 0 },
    done,
  }
}

/** 調べ直しの本体（非同期）。**窓を出したあとに終わる。** */
async function refreshLoginPath(ctx: {
  before: string
  shell: string
  configs: ShellConfigStamp[]
  zdotdir: string | null
  cached: unknown
  deps: LoginPathDeps
  now: () => number
  writeCache: (entry: LoginPathCacheEntry) => void
  readLoginShellPath: (shell: string) => string | Promise<string>
  existsFn: (p: string) => boolean
  pathDirsChanged: boolean
}): Promise<LoginPathResult> {
  const {
    before, shell, configs, zdotdir, cached, deps, now, writeCache, readLoginShellPath, existsFn, pathDirsChanged,
  } = ctx
  const t0 = now()
  let loginPath = ''
  let failure = ''
  try {
    // **窓を出す処理を止めない。** 取り出しの「開始」ごとマイクロタスクへ送る。
    // 既定（spawnLoginShellPath）は非同期の execFile だが、ここが同期で待つ関数に
    // 戻されても**窓は止まらない**——止まるかどうかを、呼ぶ相手の実装に委ねない。
    loginPath = await Promise.resolve().then(() => readLoginShellPath(shell))
    if (!looksLikePath(loginPath)) failure = 'ログインシェルの出力がPATHらしくない'
  } catch (e: any) {
    failure = e?.message ?? String(e)
  }
  const spawnMs = Math.max(0, now() - t0)

  if (!failure) {
    // 今回取り出した PATH のうち、実在したフォルダだけを覚える（次回の実在確認の材料）。
    const pathDirsPresent = loginPath.split(':').map(d => d.trim()).filter(d => {
      if (!d) return false
      try { return existsFn(d) } catch { return false }
    })
    try {
      writeCache({
        version: LOGIN_PATH_CACHE_VERSION, shell, zdotdir, configs, path: loginPath,
        pathDirsPresent, savedAt: now(),
      })
    } catch {
      // 覚えられなくても動く（次回また調べ直すだけ）。起動を止める理由にはしない。
    }
    return {
      ok: true, before, after: applyMerged(loginPath, before, deps), source: 'fresh', spawnMs, deferred: true,
      message: pathDirsChanged ? 'PATH のフォルダが変わったため調べ直し' : undefined,
    }
  }

  // 3) 調べ直しに失敗した（時間切れなど）。**取れなかったという印を残す**（D）。
  //    PATH が直っていないと「入っているはずの npm が見つからない」という、原因の分からない
  //    不調になる。あとで道具が見つからなかったときに、この印を見て見当を添える。
  //    **覚えは書かない**（次の起動で調べ直す）。
  loginPathFailure = failure
  //    **古い覚えがあれば使う**——この失敗の典型が「時間切れ」であり、そのとき PATH 無しで
  //    起動すると npm/docker が「入っているのに見つからない」に逆戻りする。
  //    古い PATH でも無いよりましなので使う。
  //    ただし黙って使わず、`stale cache` としてログに出す（速いのか壊れているのかを後から推測しない）。
  const stale = cachedLoginPathValue(cached)
  if (stale) {
    return {
      ok: true, before, after: applyMerged(stale, before, deps), source: 'stale', spawnMs,
      message: failure, deferred: true,
    }
  }
  return { ok: false, before, after: before, source: 'none', spawnMs, message: failure, deferred: true }
}

/** 起動ログの1行（`[login-path] ` に続ける部分）。**覚えたものを使ったのか調べ直したのか**が
 *  一目で分かるようにする（起動が速い／遅い理由の唯一の手がかり）。 */
export function describeLoginPathResult(r: LoginPathResult): string {
  const sec = (r.spawnMs / 1000).toFixed(1)
  // 窓を出したあとに決まった結果には印を付ける（D-18）。でないと、起動ログの中で
  // 「窓より前の話」と「窓より後の話」が見分けられない。
  const later = r.deferred ? '・あとから反映' : ''
  if (r.source === 'pending') return '調べています…（窓は先に出します）'
  if (r.source === 'cached') return 'ok (cached)'
  // PATH のフォルダの実在確認で調べ直したとき（D-17 A）は、その理由も分かるようにする
  // （でないと「なぜ2回目以降も 0 秒にならないのか」が、ログからだけでは推測になる）。
  if (r.source === 'fresh') return (r.message ? `ok (fresh, ${sec}s, ${r.message})` : `ok (fresh, ${sec}s)`) + later
  if (r.source === 'stale') return `ok (stale cache, 調べ直しに失敗: ${r.message ?? ''})` + later
  return `skip${r.message ? ` (${r.message})` : ''}` + later
}
