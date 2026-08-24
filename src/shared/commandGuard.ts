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
  />\s*\/dev\//i,                              // デバイスへの書き込み
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
