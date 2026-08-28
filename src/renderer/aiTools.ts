// AIに提供するツール（OpenAI互換のFunction Calling）の定義と実行。
// fetch_url・search_web（Web参照）/ list_files・read_file・write_file・run_command・open_preview（プロジェクト操作）。
// 書き込み系はプロジェクト内のみ。権限モード（おまかせ/毎回確認）と危険コマンドの必須確認は ChatPanel 側で制御。
// ※相互参照: Claude頭脳モード（C2b）の src/main/claude/tools.ts が fetch_url / search_docs / open_preview の
//   説明文言と結果整形（toolText.ts）を踏襲している。これらの文言・挙動を変更したら main 側も追随させること。

import { isDangerousCommand, leavesWorkingDir } from '../shared/commandGuard'
import { PUBLISH_DIR_LABEL, backupRelPath } from '../shared/publishRoot'
import { applyEdit } from './editFile'
import { isProtectedWritePath, protectedWriteMessage } from '../shared/protectedPaths'
// 実体は shared へ移した（B'-3b）。ツール定義（toolsFor 他）・純粋な補助関数は
// src/shared/aiToolsCore.ts を参照。
import {
  toolsFor, WRITING_TOOLS, isToolUnsupportedError, toolStatusLabel, formatChatError,
  condenseReasoning, hasTextToolMarkup, stripToolMarkup, unexecutedToolWarning,
  claimsFileChange, unexecutedChangeWarning, isToolArgsComplete,
} from '../shared/aiToolsCore'
export { isDangerousCommand }
export {
  toolsFor, WRITING_TOOLS, isToolUnsupportedError, toolStatusLabel, formatChatError,
  condenseReasoning, hasTextToolMarkup, stripToolMarkup, unexecutedToolWarning,
  claimsFileChange, unexecutedChangeWarning, isToolArgsComplete,
}

export type SearchProvider = 'tavily' | 'brave'
export interface SearchConfig { provider: SearchProvider; key: string }

/**
 * 暗号化保存された認証情報からWeb検索の設定を取り出す。
 * 優先プロバイダ（認証情報画面で選択）を先に試し、未登録ならもう一方を使う。
 */
export async function getSearchConfig(): Promise<SearchConfig | null> {
  try {
    const enc = localStorage.getItem('sakura_credentials_enc')
    if (!enc) return null
    const raw = await window.electronAPI.secure.decrypt(enc)
    if (!raw) return null
    const store = JSON.parse(raw)
    const pick = (id: string): string => {
      const s = store[id]
      const e = s?.entries?.find((x: any) => x.id === s.activeId) ?? s?.entries?.[0]
      return (e?.values?.apiKey ?? '').trim()
    }
    // 旧「webSearch」欄（移行前のデータ）もキーの形式で読み分ける
    const legacy = pick('webSearch')
    const tavilyKey = pick('tavily') || (legacy.startsWith('tvly-') ? legacy : '')
    const braveKey = pick('braveSearch') || (legacy && !legacy.startsWith('tvly-') ? legacy : '')
    const pref: SearchProvider = localStorage.getItem('sakura_search_provider') === 'brave' ? 'brave' : 'tavily'
    const order: SearchProvider[] = pref === 'brave' ? ['brave', 'tavily'] : ['tavily', 'brave']
    for (const p of order) {
      const key = p === 'tavily' ? tavilyKey : braveKey
      if (key) return { provider: p, key }
    }
    return null
  } catch {
    return null
  }
}

/** 破壊的・危険なコマンドか（権限モードに関わらず必ずユーザー確認を取る）
 *  実体は src/shared/commandGuard.ts に一本化済み（ファイル冒頭で import・re-export 済み）
 *（旧: src/main/claude/guard.ts と同じ正規表現をここに複製しており「要相互追随」の危険な状態だったが解消した）。 */

/** Claude 頭脳モードのエラー整形（formatChatError の engine='claude' 版・呼び出し側の可読性のため）。 */
export function formatClaudeError(message: string): string {
  return formatChatError(message, 'claude')
}

/** インストール・通信・コード直接実行・システム設定変更など、おまかせモードでも確認すべきコマンドか */
export function isSensitiveCommand(cmd: string): boolean {
  return (
    // パッケージインストール（postinstall等で任意コード実行の恐れ）
    /\b(npm|pnpm|yarn)\s+(i|install|add|exec|dlx)\b|\bnpx\b|\b(pip|pip3)\s+install\b|\bbrew\s+(install|tap)\b|\bgem\s+install\b|\bcargo\s+install\b|\bgo\s+(install|get)\b|\bcomposer\s+(require|install)\b|\bpoetry\s+add\b|\bapt(-get)?\s+install\b/i.test(cmd) ||
    // ネットワーク通信
    /\bcurl\b|\bwget\b|\bnc\b|\bncat\b|\bssh\b|\bscp\b|\bsftp\b|\btelnet\b/i.test(cmd) ||
    // コードの直接実行（ワンライナー）
    /\b(python3?|node|ruby|perl|php)\s+-(c|e)\b|\bosascript\b|\beval\b|\bbase64\s+-{1,2}d\b/i.test(cmd) ||
    // システム/ホーム設定の変更
    />>?\s*~|~\/\.(zshrc|bashrc|bash_profile|zprofile|profile|ssh)|\bcrontab\b|\blaunchctl\b|\bdefaults\s+write\b/i.test(cmd)
  )
}

/** run_command 実行前にユーザー確認が必要か（破壊的 or 上記カテゴリ） */
export function requiresConfirmation(cmd: string): boolean {
  // 作業フォルダの外へ出るコマンドも一度は目に入れる（止めはしない・2026-08-20）。
  return isDangerousCommand(cmd) || isSensitiveCommand(cmd) || leavesWorkingDir(cmd)
}

/**
 * インストールするライブラリの名前をコマンドから読み取る（純関数）。
 *
 * ── なぜ要るか（2026-08-18 Ryosuke 指摘）────────────────────────────
 * 「インターネットからプログラムを取得して実行します」とだけ出しても、
 * **何が入るのかが分からない**。名前が分かるなら見せる。
 * `npm install`（名前なし）は package.json を見ないと分からないので、
 * その場合は呼び出し側が渡す。
 */
export function installTargetsFromCommand(cmd: string): string[] {
  const t = String(cmd ?? '').trim()
  const m = /^(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\s+(.+)$/i.exec(t)
  if (!m) return []
  return m[1]
    .split(/\s+/)
    .filter(a => a && !a.startsWith('-'))   // オプションは名前ではない
    .slice(0, 20)
}

/** なぜ確認するのかを初心者向けに一言で説明する */
export function confirmReason(cmd: string, opts?: { dependencies?: readonly string[] }): string {
  if (isDangerousCommand(cmd)) return 'この操作はファイルやシステムを壊す可能性があります。'
  if (/\binstall\b|\badd\b|\bnpx\b|\bget\b|\brequire\b|\btap\b/i.test(cmd)) {
    // **何が入るのかを見せる**（2026-08-18 Ryosuke 指摘）
    const named = installTargetsFromCommand(cmd)
    const names = named.length > 0 ? named : (opts?.dependencies ?? [])
    const list = names.length > 0
      ? `（${names.slice(0, 5).join('、')}${names.length > 5 ? ` ほか${names.length - 5}件` : ''}）`
      : ''
    return `インターネットからプログラム${list}を取得して実行します。`
  }
  if (/\bcurl\b|\bwget\b|\bnc\b|\bssh\b|\bscp\b|\bsftp\b|\btelnet\b/i.test(cmd)) return '外部と通信します。'
  // 止めはしないが、一度は目に入れる（2026-08-20）。
  if (leavesWorkingDir(cmd)) return `作業フォルダ（${PUBLISH_DIR_LABEL}）の外を操作しようとしています。`
  if (/-(c|e)\b|\bosascript\b|\beval\b|\bbase64\b/i.test(cmd)) return 'コードを直接実行します。'
  return 'システムやホームの設定を変更する可能性があります。'
}

const READ_MAX_CHARS = 16000 // AIに渡すファイル内容の上限（トークン費用の暴走防止）

/** プロジェクトルート配下の安全な絶対パスに解決する。絶対パス・脱出を試みるパスは null。 */
function resolveInProject(projectDir: string, relPath: string): string | null {
  if (relPath.startsWith('/') || relPath.includes('..')) return null
  const clean = relPath.replace(/^\.\//, '')
  if (!clean) return null
  return `${projectDir}/${clean}`
}

/** 書き込み系ツール専用の解決（読み取りは制限しない）。Koto の管理領域は拒否する。 */
function resolveForWrite(projectDir: string, relPath: string): { full: string } | { error: string } {
  if (isProtectedWritePath(relPath)) return { error: `エラー: ${protectedWriteMessage(relPath)}` }
  const full = resolveInProject(projectDir, relPath)
  if (!full) return { error: `エラー: 不正なパスです（${relPath}）。プロジェクトルートからの相対パスを指定してください` }
  return { full }
}

export interface ToolContext {
  /**
   * AI が読み書きする根（ふつうは `<project>/public`）。
   *
   * ⚠️ **退避（🕘 履歴）の根とは別物。** 1つの `projectDir` で兼ねていたため、
   * 退避が `public/.sakuraide-backup` へ行き、履歴の一覧に一切出なかった
   * （＝「元に戻す」が効かない）。2026-08-24 に実害を確認して分けた。
   * `main/claude/agent.ts` は同じ問題を先に解いており（projectDir と writeRoot）、
   * こちらもその形へ揃える。
   */
  writeRoot?: string | null
  /** プロジェクト直下（**退避と記録の根**）。省略時は `writeRoot` を使う。 */
  projectRoot?: string | null
  search?: SearchConfig | null
  // ファイル保存の実処理（保存＋エディタ・ツリーへの反映）。App.tsx の applyAiFile を渡す
  applyFile?: (relPath: string, content: string) => Promise<void>
  // 📚 資料の検索（rag:query を呼んで出典付きブロック文字列を返す）。ChatPanel が渡す
  ragSearch?: (query: string) => Promise<string>
  // このAIターンのスナップショットID（useAiChat が send 1回ごとに採番）。
  // write_file の上書き前バックアップを「AIターン単位」で同じスナップショットdirにまとめるために使う。
  snapshotId?: string
  // 履歴一覧に出す見出し（このターンのユーザーの指示文）。「🕘 履歴」でどの作業か見分けるために使う。
  snapshotLabel?: string
}

/** ツールを実行して、AIに返す結果文字列を作る。失敗もAIに伝える（説明できるように）。 */
export async function executeTool(name: string, argsJson: string, ctx: ToolContext = {}): Promise<string> {
  let args: any = {}
  try { args = JSON.parse(argsJson || '{}') } catch { return 'エラー: ツール引数のJSONが不正です' }

  if (name === 'fetch_url') {
    const url = String(args.url ?? '')
    try {
      const page = await window.electronAPI.web.fetchPage(url)
      return `ページ: ${page.url}${page.title ? `（${page.title}）` : ''}\n\n${page.content}`
    } catch (e: any) {
      return `エラー: ページを取得できませんでした（${e?.message ?? e}）`
    }
  }

  if (name === 'search_web') {
    if (!ctx.search) return 'エラー: Web検索のAPIキーが未設定です（ユーザーに認証情報（⇧⌘,）でのTavilyまたはBraveのキー登録を案内してください）'
    const query = String(args.query ?? '').trim()
    if (!query) return 'エラー: 検索クエリが空です'
    try {
      const results = await window.electronAPI.web.search(ctx.search.provider, ctx.search.key, query)
      if (!results.length) return `「${query}」の検索結果はありませんでした`
      return (
        `「${query}」の検索結果:\n\n` +
        results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`).join('\n\n') +
        '\n\n（詳細が必要なページは fetch_url で本文を取得できます）'
      )
    } catch (e: any) {
      return `エラー: ${e?.message ?? e}`
    }
  }

  if (name === 'list_files') {
    if (!ctx.writeRoot) return 'エラー: プロジェクトが開かれていません'
    try {
      const files = await window.electronAPI.fs.projectFiles(ctx.writeRoot)
      return files.length ? `プロジェクトのファイル一覧:\n${files.map(f => `- ${f}`).join('\n')}` : '（ファイルがありません）'
    } catch (e: any) {
      return `エラー: 一覧を取得できませんでした（${e?.message ?? e}）`
    }
  }

  if (name === 'read_file') {
    if (!ctx.writeRoot) return 'エラー: プロジェクトが開かれていません'
    const rel = String(args.path ?? '')
    const full = resolveInProject(ctx.writeRoot, rel)
    if (!full) return `エラー: 不正なパスです（${rel}）。プロジェクトルートからの相対パスを指定してください`
    try {
      const content = await window.electronAPI.fs.readFileInProject(ctx.writeRoot, rel)
      const truncated = content.length > READ_MAX_CHARS
      return (
        `ファイル: ${rel}\n\n${content.slice(0, READ_MAX_CHARS)}` +
        (truncated ? `\n\n（長いため ${READ_MAX_CHARS} 文字で打ち切り。全体は ${content.length} 文字）` : '')
      )
    } catch (e: any) {
      return `エラー: ファイルを読めませんでした（${e?.message ?? e}）`
    }
  }

  if (name === 'write_file') {
    if (!ctx.writeRoot) return 'エラー: プロジェクトが開かれていません'
    const rel = String(args.path ?? '')
    const content = String(args.content ?? '')
    const resolved = resolveForWrite(ctx.writeRoot, rel)
    if ('error' in resolved) return resolved.error
    try {
      // 上書き前の自動バックアップ（AIターン単位のスナップショット。「🕘 履歴」から1クリックで戻せる）
      let backedUp = false
      try {
        // snapshotId は useAiChat が send 1回ごとに採番。万一無ければこの呼び出し単体で採番する
        const snapshotId = ctx.snapshotId ?? new Date().toISOString().replace(/[:.]/g, '-')
        const root = ctx.projectRoot ?? ctx.writeRoot
        const r = await window.electronAPI.backup.snapshotBeforeWrite(
          root, snapshotId, backupRelPath(root, ctx.writeRoot, rel), content, ctx.snapshotLabel)
        backedUp = r.ok && r.backedUp
      } catch { /* バックアップ失敗は保存を妨げない */ }
      if (ctx.applyFile) {
        await ctx.applyFile(rel, content) // 保存＋エディタ・ツリー反映
      } else {
        await window.electronAPI.fs.writeFileInProject(ctx.writeRoot, rel, content)
      }
      return `保存しました: ${rel}（${content.length}文字）` +
        (backedUp ? `（旧内容は自動バックアップ済み。ユーザーに「元に戻して」と言われたら、画面上部の「🕘 元に戻す」から、その時点の状態にまるごと戻せることを案内してください）` : '')
    } catch (e: any) {
      return `エラー: 保存できませんでした（${e?.message ?? e}）`
    }
  }

  if (name === 'edit_file') {
    if (!ctx.writeRoot) return 'エラー: プロジェクトが開かれていません'
    const rel = String(args.path ?? '')
    const oldString = String(args.old_string ?? '')
    const newString = String(args.new_string ?? '')
    const replaceAll = args.replace_all === true
    const resolved = resolveForWrite(ctx.writeRoot, rel)
    if ('error' in resolved) return resolved.error

    let content: string
    try {
      content = await window.electronAPI.fs.readFileInProject(ctx.writeRoot, rel)
    } catch (e: any) {
      return `エラー: ファイルを読めませんでした（${e?.message ?? e}）。先に read_file で現在の内容を確認するか、新規作成なら write_file を使ってください`
    }

    const result = applyEdit(content, oldString, newString, replaceAll)
    if (!result.ok) {
      if (result.reason === 'not-found') {
        return `エラー: 指定された文字列が見つかりません（${rel}）。read_file で現在の内容を確認してから、実際にファイル内にある文字列を old_string に指定してください（推測で再試行しないこと）`
      }
      if (result.reason === 'ambiguous') {
        return `エラー: 指定された文字列が ${result.count} 箇所にあります（${rel}）。周囲の行を含めて old_string がファイル内で一意になるよう広げるか、replace_all: true を指定してください`
      }
      if (result.reason === 'empty-old') {
        return 'エラー: old_string が空です。置き換えたい既存の文字列を指定してください'
      }
      return 'エラー: old_string と new_string が同じです（変更内容がありません）'
    }

    try {
      // 上書き前の自動バックアップ（write_file とまったく同じ手順。「🕘 履歴」から1クリックで戻せる）
      let backedUp = false
      try {
        const snapshotId = ctx.snapshotId ?? new Date().toISOString().replace(/[:.]/g, '-')
        const root = ctx.projectRoot ?? ctx.writeRoot
        const r = await window.electronAPI.backup.snapshotBeforeWrite(
          root, snapshotId, backupRelPath(root, ctx.writeRoot, rel), result.next, ctx.snapshotLabel)
        backedUp = r.ok && r.backedUp
      } catch { /* バックアップ失敗は保存を妨げない */ }
      if (ctx.applyFile) {
        await ctx.applyFile(rel, result.next) // 保存＋エディタ・ツリー反映
      } else {
        await window.electronAPI.fs.writeFileInProject(ctx.writeRoot, rel, result.next)
      }
      return `編集しました: ${rel}（${result.count}箇所を置換）` +
        (backedUp ? `（旧内容は自動バックアップ済み。ユーザーに「元に戻して」と言われたら、画面上部の「🕘 元に戻す」から、その時点の状態にまるごと戻せることを案内してください）` : '')
    } catch (e: any) {
      return `エラー: 保存できませんでした（${e?.message ?? e}）`
    }
  }

  if (name === 'run_command') {
    if (!ctx.writeRoot) return 'エラー: プロジェクトが開かれていません'
    const command = String(args.command ?? '').trim()
    if (!command) return 'エラー: コマンドが空です'
    try {
      const r = await window.electronAPI.proc.run(ctx.writeRoot, command)
      return (
        `$ ${command}\n終了コード: ${r.code}${r.timedOut ? '（60秒でタイムアウト。常駐プロセスはこのツールでは起動できません）' : ''}\n` +
        (r.stdout ? `--- stdout ---\n${r.stdout}\n` : '') +
        (r.stderr ? `--- stderr ---\n${r.stderr}\n` : '') +
        (!r.stdout && !r.stderr ? '（出力なし）' : '')
      )
    } catch (e: any) {
      return `エラー: コマンドを実行できませんでした（${e?.message ?? e}）`
    }
  }

  if (name === 'search_docs') {
    if (!ctx.ragSearch) return '資料検索は現在利用できません'
    const query = String(args.query ?? '').trim()
    if (!query) return 'エラー: 検索クエリが空です'
    try {
      const result = await ctx.ragSearch(query)
      return result || '該当する資料が見つかりませんでした'
    } catch (e: any) {
      return `エラー: ${e?.message ?? e}`
    }
  }

  if (name === 'search_in_files') {
    if (!ctx.writeRoot) return 'エラー: プロジェクトが開かれていません'
    const query = String(args.query ?? '').trim()
    if (!query) return 'エラー: 検索クエリが空です'
    const pathPattern = args.path_pattern ? String(args.path_pattern) : undefined
    try {
      const r = await window.electronAPI.fs.searchInProject(ctx.writeRoot, query, pathPattern)
      if (!r.ok) return `エラー: 検索できませんでした（${r.message ?? ''}）`
      if (!r.matches.length) return `「${query}」は見つかりませんでした。別の語で試すか、list_files で構成を確認してください`
      const lines = r.matches.map(m => `${m.path}:${m.line}: ${m.text}`).join('\n')
      return (
        `「${query}」の検索結果（${r.matches.length}件）:\n\n${lines}` +
        (r.truncated ? `\n\n（多すぎるため ${r.matches.length} 件で打ち切りました。語を具体的にして絞り込んでください）` : '') +
        `\n\n（該当箇所の前後が必要なら read_file で該当ファイルを読むこと）`
      )
    } catch (e: any) {
      return `エラー: ${e?.message ?? e}`
    }
  }

  if (name === 'open_preview') {
    if (!ctx.writeRoot) return 'エラー: プロジェクトが開かれていません'
    const rel = String(args.path ?? 'index.html')
    const full = resolveInProject(ctx.writeRoot, rel)
    if (!full) return `エラー: 不正なパスです（${rel}）`
    if (!(await window.electronAPI.fs.exists(full))) return `エラー: ファイルがありません（${rel}）`
    try {
      await window.electronAPI.shell.openPath(full)
      return `ブラウザで ${rel} を開きました。ユーザーに見た目の感想を聞いてください。`
    } catch (e: any) {
      return `エラー: 開けませんでした（${e?.message ?? e}）`
    }
  }

  return `エラー: 未対応のツールです（${name}）`
}
