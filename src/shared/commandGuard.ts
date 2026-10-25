// commandGuard.ts — Bash/run_command 実行前の危険コマンド判定。
// main（src/main/claude/guard.ts）と renderer（src/renderer/aiTools.ts）の両方から使われる
// 唯一の実装（旧: 両ファイルに同じ正規表現を複製しており「要相互追随」の危険な状態だった。一本化済み）。
//
// このモジュールは fs/electron/DOM に一切依存しない純粋関数のみで、Vitest で単体テスト可能にする。
//
// ── この関門の重み（2026-08-05 の点検で確認） ────────────────────────────────
// ここで true になると: Claudeモードでは**実行を拒否**（agent.ts の canUseTool が deny）、
// AI Engineモードでは**ユーザーへの確認を必ず挟む**（🪄おまかせでも省略しない）。
// つまり false を返したコマンドは、おまかせ運転中なら**何の確認もなく実行される**。
//
// そして重要な前提として、**🕘 履歴（.sakuraide-backup）はコマンドによる破壊を記録しない**。
// 退避しているのはファイル保存ツール（write_file / edit_file / Write / Edit）の経路だけで、
// `rm` や `find -delete` で消えたファイルは戻せない。**このモジュールが最後の砦**である。
//
// 判定は「怪しければ止める」側に倒す。誤検知（普通の作業が止まる）は確認を1回挟むだけで済むが、
// 見逃しはユーザーの作業物が消える。ただし普段使い（npm / git / node / php / mkdir / cp 等）を
// 妨げないことも同じくらい重要なので、追加するパターンは tests/commandGuard.test.ts で
// 「通すべきコマンド」と対にして必ず検証すること。

/** 常に拒否・確認すべき危険なコマンドのパターン。意図が分かるよう分類して並べる。 */
import { PUBLISH_DIR } from './publishRoot'

const DANGEROUS_PATTERNS: RegExp[] = [
  // ── 削除・破壊 ──
  /\brm\b/i,                                   // rm / rm -rf
  /\bunlink\b/i,
  /\bshred\b/i,
  /\brmtree\b/i,                               // python の shutil.rmtree など
  /\btruncate\s+-s\s*0/i,                      // ファイルを空にする
  /\bfind\b[^|;]*\s-(delete|exec\b)/i,         // find . -delete / find . -exec ...
  /\bmkfs/i,
  /\bdd\b/i,
  /\bdiskutil\b/i,

  // ── 権限昇格・システム変更 ──
  /\bsudo\b/i,
  /\bsu\s+-/i,
  /\bchmod\s+-R\b/i,                           // 再帰的な権限変更（777に限らず危険）
  /\bchmod\s+[0-7]{3,4}\b/i,
  /\bchown\s/i,
  /\bcsrutil\b|\bspctl\b|\bsystemsetup\b|\blaunchctl\b/i,
  /\bosascript\b/i,                            // AppleScript 経由で何でもできてしまう

  // ── プロセス・電源 ──
  /\b(p|)kill(all)?\b/i,                       // kill / killall / pkill
  /\bshutdown\b|\breboot\b|\bhalt\b/i,
  /:\s*\(\s*\)\s*\{.*\|.*&.*\}\s*;/,           // フォークボム :(){ :|:& };:

  // ── ネットワーク経由の実行 ──
  /curl[^|;]*\|\s*(ba|z|fi|)?sh/i,
  /wget[^|;]*\|\s*(ba|z|fi|)?sh/i,

  // ── デバイス・特殊ファイル ──
  // デバイスへの書き込み。`> /dev/null`（出力を捨てる）・/dev/stdout・/dev/stderr は普段使いなので除く
  // （`npm run build > /dev/null` が拒否されていた・2026-10-23）。名前の続き（/dev/nullx・/dev/null/../disk0）は除かない。
  // 後ろの区切りに閉じ引用符・バッククォート・} を含めるのは、`bash -c 'npm run build >/dev/null'`・
  // `` `npm run build >/dev/null` ``・`{ cmd >/dev/null; }` も普段使いのため。
  />\s*\/dev\/(?!(?:null|stdout|stderr)(?=[\s;&|)'"`}]|$))/i,
  /\/dev\/(u?random|zero)\b[^|;]*>/i,          // cat /dev/urandom > ファイル

  // ── 作業内容を失う git 操作 ──
  /git\s+push\b/i,                             // ユーザーのリポジトリへ勝手に反映しない
  /git\s+reset\s+--hard\b/i,
  /git\s+clean\b/i,
  /git\s+(checkout|restore)\s+(--\S+\s+)*(--\s+)?[.*](\s|$)/i, // git checkout . / git restore .
]

/** ファイル削除・強制終了・システム破壊的な操作など、常に拒否すべき危険なコマンドか。 */
export function isDangerousCommand(cmd: string): boolean {
  const s = String(cmd ?? '')
  return DANGEROUS_PATTERNS.some(re => re.test(s))
}

/**
 * **作業フォルダの外へ出ようとしているか**（`cd ..` など）。
 *
 * ── なぜ「拒否」ではなく「確認」なのか（2026-08-20 Ryosuke と合意）──────
 * AI の書き込みツールは作業フォルダの外へ出られない（`resolveInProject` が `..` を拒む）。
 * だが `run_command` はシェルなので `cd ..` で外に出られる。**確実に塞ぐ方法は無い**——
 * シェル1行から書き込み先を読むのは現実的に不可能（`>` `tee` `cp` `mv` `sed -i`・
 * 変数展開・パイプ）。中途半端な判定は**「止めすぎ」と「取りこぼし」を同時に招く**（掟10）。
 * さらにアプリ型では `npm install` を作業フォルダの中で動かす必要があり、
 * 塞ぎ込むとアプリが作れなくなる。
 *
 * そこで**止めない。一度だけ目に入るようにする**（おまかせモードでも確認が出る）。
 * 誤検出しても「確認が1回出るだけ」なので、止めすぎにはならない。
 *
 * 書き先の読み取り（`>` `tee` `cp` `mv` など）は、あとから writesOutsideWorkingDir が受け持った（2026-10-23。
 * 上の「現実的に不可能」は、完全には読めない、の意味。見える範囲だけ確認を出す）。
 */
export function leavesWorkingDir(cmd: string): boolean {
  const c = String(cmd ?? '')
  if (!c) return false
  // `cd ..` / `cd ../x` / `cd /abs`（`cd ...foo` のような別語は拾わない）
  if (/\bcd\s+\.\.(?=$|[/\s;&|])/.test(c)) return true
  if (/\bcd\s+\//.test(c)) return true
  if (/\bcd\s+~/.test(c)) return true
  // 引数として親をたどる道を渡している（`cp x ../y` など）
  if (/(^|[\s=])\.\.\//.test(c)) return true
  return false
}

// ── 作業フォルダの外へ「書く」コマンドの判定（2026-10-23・0.6.23）──────────────────────
//
// leavesWorkingDir は `cd` と `../` しか見ない。実測（おまかせ・偽の承認）で、次は承認0回のまま通った:
//   `echo x >> /Users/me/.zshrc` / `mv a ~/b` / `ln -s ~ home` / `ln -s /Users/me/Library link`
// 同じ効果の `echo x > ~/.zshrc`・`cp a ~/.zshrc`・`tee ~/.zshrc` は sensitive で承認が出ていた
// ＝判定が割れていた。書き先を読む判定をここ**1つ**に集め、requiresConfirmation（aiToolsCore.ts）がこれを見る。
// Claude の Bash（agent.ts）とさくらのAI Engine の run_command（turnRunner.ts → planApproval）は
// どちらも requiresConfirmation を通るので、両方に効く。
//
// **止めない。確認を出すだけ**（leavesWorkingDir と同じ。`isDangerousCommand` には足さない）。
// 見るのは書き先だけ: リダイレクト（> >> &> 2> など）の先・tee の引数・cp/rsync/install の宛先（最後の引数）・
// mv/ln/touch/mkdir/chmod/chown の引数。読むだけのコマンド（cat /etc/hosts・ls /usr/bin）と、
// 外にあるものを作業フォルダへ**持ち込む** cp/rsync の元（cp ~/Downloads/a.png images/）は対象外。
// 「外」＝ / 始まり・~ 始まり・$HOME・${HOME}・パスの区切りに `..` がある。
// 除外: /dev/null・/dev/stdout・/dev/stderr（出力を捨てる・普段使い）。
// **プロジェクト直下の絶対パス（opts.projectDir）を渡すと、その配下（ちょうど一致か配下）を指す絶対パスは外に数えない**
// （`mkdir -p /Users/someone/proj/public/css`。Claude は Bash で絶対パスを書くことが多く、数えると承認だらけになる）。
// `..` は正規化してから見る（`public/../server.js` は中・`/…/proj/../x` は外）。~ と $HOME は、プロジェクトがホームの
// 中でも外と数える（作業フォルダの外へ出るための書き方なので）。兄弟（/…/proj-other）は外。
// **渡さないときは、絶対パスはすべて外（安全側）**。任意の引数は渡し忘れても静かに飛ぶ（掟10）ので、呼び出し元
// （agent.ts の Bash・turnRunner.ts の decideApproval と planApproval）は必ず渡し、
// tests/commandWritesOutsideRoutes.test.ts が「中は承認0回・外は1回」を両方の経路で固定している。
//
// 限界（直さない）: シェル1行からは書き先を完全には読めない。変数（$HOME 以外）・`$(…)` や引用符の中のコマンド・
// `sed -i`・`curl -o`・`tar -C` などは見ない。見逃しても、今までと同じ（新しく悪くはならない）。

type ShellScan = { commands: string[][]; redirects: string[] }

/** シェルの1行を、コマンドごとの語の並びと、リダイレクトの書き先に分ける（引用符・エスケープは外す）。 */
function scanShell(src: string): ShellScan {
  const commands: string[][] = []
  const redirects: string[] = []
  const n = src.length
  let words: string[] = []
  let buf = ''
  let has = false                 // "" のような空の語も語として数える
  let i = 0
  const heredocs: string[] = []   // 読み飛ばすヒアドキュメントの終わりの印

  const flushWord = () => { if (has) words.push(buf); buf = ''; has = false }
  const endCommand = () => { flushWord(); if (words.length) commands.push(words); words = [] }
  const isDelimiter = (c: string) => /[\s;&|()<>`]/.test(c)

  // 引用符・エスケープを外した語の一部を、区切りまで読む。何も読まなければ null。
  const readChunk = (): string | null => {
    let out = ''
    const start = i
    while (i < n && !isDelimiter(src[i])) {
      const c = src[i]
      if (c === "'") {
        const j = src.indexOf("'", i + 1)
        out += src.slice(i + 1, j < 0 ? n : j)
        i = j < 0 ? n : j + 1
      } else if (c === '"') {
        i++
        while (i < n && src[i] !== '"') {
          if (src[i] === '\\' && i + 1 < n && '"\\$`'.includes(src[i + 1])) { out += src[i + 1]; i += 2 }
          else { out += src[i]; i++ }
        }
        i++
      } else if (c === '\\') {
        if (src[i + 1] === '\n') { i += 2 } else { out += src[i + 1] ?? ''; i += 2 }
      } else { out += c; i++ }
    }
    return i > start ? out : null
  }
  const readWord = (): string | null => {
    while (i < n && (src[i] === ' ' || src[i] === '\t')) i++
    return readChunk()
  }
  const takeRedirect = () => { const w = readWord(); if (w) redirects.push(w) }
  // 直前の語が数字だけなら fd 番号（2> の 2）なので、語として数えない。
  const dropFdNumber = () => { if (has && /^\d+$/.test(buf)) { buf = ''; has = false } else flushWord() }
  const skipHeredocBodies = () => {
    while (heredocs.length) {
      const mark = heredocs.shift()!
      while (i < n) {
        let e = src.indexOf('\n', i)
        if (e < 0) e = n
        const line = src.slice(i, e)
        i = Math.min(e + 1, n)
        if (line.replace(/^\t+/, '').trimEnd() === mark) break
      }
    }
  }

  while (i < n) {
    const c = src[i]
    if (c === '\n') { endCommand(); i++; skipHeredocBodies(); continue }
    if (c === ' ' || c === '\t' || c === '\r') { flushWord(); i++; continue }
    if (c === '#' && !has) { while (i < n && src[i] !== '\n') i++; continue }   // コメント（語の頭だけ）
    if (c === ';' || c === '(' || c === ')' || c === '`') { endCommand(); i++; continue }
    if (c === '|') { endCommand(); i++; if (src[i] === '|' || src[i] === '&') i++; continue }
    if (c === '&') {
      if (src[i + 1] === '>') { flushWord(); i += src[i + 2] === '>' ? 3 : 2; takeRedirect(); continue }   // &> &>>
      endCommand(); i++; if (src[i] === '&') i++; continue                                                // & &&
    }
    if (c === '>') {
      dropFdNumber(); i++
      if (src[i] === '>' || src[i] === '|') i++                                 // >> >|
      else if (src[i] === '&') {                                                // >&2（fd の複製）/ >&file
        i++
        if (/[\d-]/.test(src[i] ?? '')) { while (/[\d-]/.test(src[i] ?? '')) i++; continue }
      }
      takeRedirect(); continue
    }
    if (c === '<') {
      dropFdNumber(); i++
      if (src[i] === '<' && src[i + 1] === '<') { i += 2; readWord(); continue }     // <<< 文字列の入力
      if (src[i] === '<') {                                                          // << ヒアドキュメント
        i++; if (src[i] === '-') i++
        const mark = readWord()
        if (mark) heredocs.push(mark)
        continue
      }
      if (src[i] === '&') i++
      readWord(); continue                                                           // < ファイルの読み込み
    }
    const chunk = readChunk()
    if (chunk === null) { i++; continue }   // 読み進められない文字で止まらないための保険
    buf += chunk; has = true
  }
  endCommand()
  return { commands, redirects }
}

/** 出力を捨てる・標準出力へ流すだけの先。外とは数えない。 */
const HARMLESS_TARGETS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr'])

export type WritesOutsideOptions = {
  /** プロジェクト直下の絶対パス。渡すと、その配下を指す絶対パスは「外」に数えない（渡さなければ絶対パスはすべて外）。 */
  projectDir?: string | null
}

/** `.` と `..` をたどって畳む（posix・ファイルシステムは見ない・シンボリックリンクは解決しない）。
 *  絶対パスは `/` から始まる形で返す。相対パスで親をたどりきれない `..` は先頭に残す。 */
function normalizePosix(p: string): string {
  const abs = p.startsWith('/')
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!abs) out.push('..')
      continue
    }
    out.push(seg)
  }
  return (abs ? '/' : '') + out.join('/')
}

/** 渡されたプロジェクト直下を、比べられる形（正規化・末尾の / なし）にする。絶対パスでない・ルートは使わない（null）。 */
function projectRootOf(opts?: WritesOutsideOptions): string | null {
  const d = opts?.projectDir
  if (typeof d !== 'string' || !d.startsWith('/')) return null
  const n = normalizePosix(d)
  return n === '/' ? null : n
}

/** 書き先のパスが、作業フォルダの外か（絶対・ホーム・親をたどる）。projectRoot があれば、その配下の絶対パスは中。 */
function isOutsidePath(p: string, projectRoot: string | null): boolean {
  if (!p || HARMLESS_TARGETS.has(p)) return false
  if (p.startsWith('~')) return true
  if (/^\$\{?HOME(?![A-Za-z0-9_])/.test(p)) return true
  if (projectRoot === null) return p.startsWith('/') || p.split('/').includes('..')
  const n = normalizePosix(p)
  if (p.startsWith('/')) return !(n === projectRoot || n.startsWith(projectRoot + '/'))
  return n === '..' || n.startsWith('../')   // 相対パスは、畳んだ結果が親へ出るときだけ外
}

/** 先頭に付けても本体のコマンドは変わらないもの（`env cp …`・`nohup cp …`）。 */
const COMMAND_WRAPPERS = new Set(['env', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'xargs'])
const XARGS_VALUE_OPTIONS = new Set(['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a'])
/** `if`・`{` など、コマンドの前に付く構文の語。 */
const SYNTAX_WORDS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
/** rsync で、次の語を値として取るオプション（値を宛先と取り違えないため）。 */
const RSYNC_VALUE_OPTIONS = new Set([
  '-e', '--rsh', '--exclude', '--include', '--exclude-from', '--include-from', '-f', '--filter', '--files-from',
  '--rsync-path', '--port', '--bwlimit', '--timeout', '--log-file', '--backup-dir', '--suffix', '--chmod',
  '--chown', '--link-dest', '--compare-dest', '--copy-dest', '-T', '--temp-dir',
])
/** 引数のすべてが書き先になるコマンド。 */
const WRITES_ALL_OPERANDS = new Set(['tee', 'touch', 'mkdir', 'chmod', 'chown', 'mv', 'ln'])
/** 最後の引数だけが書き先になるコマンド（元は読むだけ）。 */
const WRITES_LAST_OPERAND = new Set(['cp', 'rsync', 'install'])
/** `-t DIR`（宛先を先に書く形）を持つコマンド。rsync の -t は別の意味なので含めない。 */
const HAS_TARGET_DIRECTORY = new Set(['cp', 'mv', 'ln', 'install'])

/** 1つのコマンド（語の並び）が、作業フォルダの外へ書くか。 */
function commandWritesOutside(words: string[], depth: number, projectRoot: string | null): boolean {
  const base = (w: string) => w.slice(w.lastIndexOf('/') + 1)
  let i = 0
  for (; i < words.length; i++) {
    const w = words[i]
    if (SYNTAX_WORDS.has(w) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue
    if (COMMAND_WRAPPERS.has(base(w))) {
      const wrapper = base(w)
      while (i + 1 < words.length && words[i + 1].startsWith('-')) {
        i++
        if (wrapper === 'xargs' && XARGS_VALUE_OPTIONS.has(words[i])) i++
      }
      continue
    }
    break
  }
  if (i >= words.length) return false
  const cmd = base(words[i])
  const args = words.slice(i + 1)

  // `bash -c '…'` の中身は、もう1度コマンドとして読む。
  if (SHELLS.has(cmd)) {
    const k = args.findIndex(a => /^-[A-Za-z]*c[A-Za-z]*$/.test(a))
    return k >= 0 && k + 1 < args.length && depth < 3 && writesOutside(args[k + 1], depth + 1, projectRoot)
  }
  const all = WRITES_ALL_OPERANDS.has(cmd)
  const last = WRITES_LAST_OPERAND.has(cmd)
  if (!all && !last) return false

  const operands: string[] = []
  let targetDir: string | null = null
  let optionsEnded = false
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (!optionsEnded && a === '--') { optionsEnded = true; continue }
    if (!optionsEnded && a.length > 1 && a.startsWith('-')) {
      if (HAS_TARGET_DIRECTORY.has(cmd) && (a === '-t' || a === '--target-directory')) targetDir = args[++k] ?? null
      else if (HAS_TARGET_DIRECTORY.has(cmd) && a.startsWith('--target-directory=')) targetDir = a.slice('--target-directory='.length)
      else if (cmd === 'rsync' && RSYNC_VALUE_OPTIONS.has(a)) k++
      continue
    }
    operands.push(a)
  }
  const outside = (p: string) => isOutsidePath(p, projectRoot)
  if (targetDir !== null && outside(targetDir)) return true
  if (all || (cmd === 'install' && args.includes('-d'))) return operands.some(outside)
  return operands.length > 0 && targetDir === null && outside(operands[operands.length - 1])
}

function writesOutside(cmd: string, depth: number, projectRoot: string | null): boolean {
  const { commands, redirects } = scanShell(cmd)
  return redirects.some(r => isOutsidePath(r, projectRoot)) || commands.some(words => commandWritesOutside(words, depth, projectRoot))
}

/** **プロジェクトのフォルダの外へ書き込むコマンドか**（上の説明のとおり。確認を出すための判定で、止めはしない）。
 *  opts.projectDir を渡すと、プロジェクトの中を指す絶対パスは外に数えない（渡さなければ絶対パスはすべて外）。 */
export function writesOutsideWorkingDir(cmd: string, opts?: WritesOutsideOptions): boolean {
  const c = String(cmd ?? '')
  if (!c.trim()) return false
  return writesOutside(c, 0, projectRootOf(opts))
}

/**
 * 「いつもと違う場所で実行しようとしている」ときだけ知らせる（純関数）。
 *
 * ── なぜ要るか（2026-08-24 の実害）────────────────────────────────────
 * 新規プロジェクトを開いた直後、AI の作業フォルダが**前のプロジェクトのまま**になり、
 * AI が前のプロジェクトのファイル一覧を見て `rm -rf` を出した。利用者は
 * 「既存ファイルが混在している」という**もっともらしい理由**を読んで承認し、
 * **別のプロジェクトのファイルが 19 件消えた**（幸い 🕘 の起点から戻せた）。
 *
 * ── パスは出さない（2026-08-24 Ryosuke 指摘）──────────────────────────
 * 最初はフルパスを出す案にしたが、**利用者に難しい判断を押しつける**ことになる。
 * 長いパスを1文字ずつ読み比べて「これは違う」と気づける人はいない。
 * **「いつもと違う」という事実**と、**見分けのつく名前**だけを伝える。
 *
 * いつもどおり（プロジェクトの中）なら**何も言わない**。確認の文が長くなるほど
 * 読まれなくなり、本当に危ないときの一行が埋もれる。
 *
 * @param projectDir いま開いているプロジェクト（絶対パス）
 * @param execRoot   実際に実行される場所（絶対パス）
 */
export function commandScopeNote(projectDir: string | null | undefined, execRoot: string | null | undefined, sep = '/'): string {
  const p = String(projectDir ?? '').replace(/[/\\]+$/, '')
  const e = String(execRoot ?? '').replace(/[/\\]+$/, '')
  if (!e || !p) return ''
  if (e === p || e.startsWith(p + sep)) return '' // いつもどおり＝何も言わない
  // **利用者が見分けるのはプロジェクト名。** 実行先は `<project>/public` のことが多く、
  // そのまま末尾を取ると「public」になって、どこの話か分からない。
  const name = (abs: string) => {
    const parts = abs.split(/[/\\]/).filter(Boolean)
    const last = parts[parts.length - 1]
    if (last === PUBLISH_DIR && parts.length > 1) return parts[parts.length - 2]
    return last ?? abs
  }
  return `\n⚠️ 通常と異なる場所で実行しようとしています。`
    + `いま開いているのは「${name(p)}」ですが、「${name(e)}」の中で実行されます。`
    + `心当たりがなければ拒否してください。`
}
