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

import { execFileSync } from 'child_process'

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

/**
 * ログインシェルの PATH を取得して process.env.PATH へ反映する（起動時に1回だけ呼ぶ）。
 * - 反映後の PATH は「ログインシェルのPATH → 元のPATH → 実在する定番ディレクトリ」の順で重複なく連結する
 *   （元のPATHを捨てないのは、開発時に `npm run electron` から起動した場合の環境を壊さないため）。
 * - 取得できない・出力が PATH らしくない場合は何もしない（起動は止めない）。
 * 戻り値は診断用（スモークテストのログで確認できるようにする）。
 */
export function applyLoginPath(): { ok: boolean; before: string; after: string; message?: string } {
  const before = process.env.PATH ?? ''
  // macOS 以外（CI の Linux 等）では GUI 起動の PATH 問題が当てはまらないため何もしない。
  if (process.platform !== 'darwin') return { ok: false, before, after: before, message: 'darwin 以外のため何もしない' }

  const shell = process.env.SHELL || '/bin/zsh'
  let loginPath = ''
  try {
    loginPath = execFileSync(shell, loginPathArgs(shell), {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'], // プロファイルが標準エラーへ出す出力は混ぜない
    }).trim()
  } catch (e: any) {
    return { ok: false, before, after: before, message: e?.message ?? String(e) }
  }
  if (!looksLikePath(loginPath)) {
    return { ok: false, before, after: before, message: 'ログインシェルの出力がPATHらしくない' }
  }

  // 定番の場所（Homebrew等）は、実在するときだけ保険として末尾に足す。
  const extras = ['/opt/homebrew/bin', '/usr/local/bin'].filter(p => {
    try { return require('fs').existsSync(p) } catch { return false }
  }).join(':')

  const after = mergePathEntries(loginPath, before, extras)
  process.env.PATH = after
  return { ok: true, before, after }
}
