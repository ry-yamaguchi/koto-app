// AIに提供するツール（OpenAI互換のFunction Calling）の定義と実行。
// fetch_url・search_web（Web参照）/ list_files・read_file・write_file・run_command・open_preview（プロジェクト操作）。
// 書き込み系はプロジェクト内のみ。権限モード（おまかせ/毎回確認）と危険コマンドの必須確認は ChatPanel 側で制御。
// ※相互参照: Claude頭脳モード（C2b）の src/main/claude/tools.ts が fetch_url / search_docs / open_preview の
//   説明文言と結果整形（toolText.ts）を踏襲している。これらの文言・挙動を変更したら main 側も追随させること。

import { isDangerousCommand, leavesWorkingDir } from '../shared/commandGuard'
import { PUBLISH_DIR_LABEL } from '../shared/publishRoot'
// 実体は shared へ移した（B'-3b）。ツール定義（toolsFor 他）・純粋な補助関数は
// src/shared/aiToolsCore.ts を参照。
import {
  toolsFor, WRITING_TOOLS, isToolUnsupportedError, toolStatusLabel, formatChatError,
  condenseReasoning, hasTextToolMarkup, stripToolMarkup, unexecutedToolWarning,
  claimsFileChange, unexecutedChangeWarning, stripRepeatedGuidance, isToolArgsComplete,
} from '../shared/aiToolsCore'
export { isDangerousCommand }
export {
  toolsFor, WRITING_TOOLS, isToolUnsupportedError, toolStatusLabel, formatChatError,
  condenseReasoning, hasTextToolMarkup, stripToolMarkup, unexecutedToolWarning,
  claimsFileChange, unexecutedChangeWarning, stripRepeatedGuidance, isToolArgsComplete,
}

// executeTool の本体（executeToolCore）・SearchConfig 型・io の型は shared へ移した（B'-3d-2a）。
// ここは io を window.electronAPI から組み立てて渡すだけの薄い皮になる。
export type { SearchConfig, SearchProvider } from '../shared/toolExecCore'
import { executeToolCore, type CoreToolContext, type ToolIo, type SearchConfig, type SearchProvider } from '../shared/toolExecCore'

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
  // ファイル保存の実処理（保存＋エディタ・ツリーへの反映）。App.tsx の applyAiFile を渡す。
  // 第3引数 root は「書き込む根」（省略時は applyAiFile 側が currentDir にフォールバックする）。
  // ここに ctx.writeRoot（ふつうは public/）を渡さないと、IDE のチャットは
  // プロジェクト直下へ書いてしまう（2026-08-27 発見の不具合の根っこ）。
  applyFile?: (relPath: string, content: string, root?: string | null) => Promise<void>
  // 📚 資料の検索（rag:query を呼んで出典付きブロック文字列を返す）。ChatPanel が渡す
  ragSearch?: (query: string) => Promise<string>
  // このAIターンのスナップショットID（useAiChat が send 1回ごとに採番）。
  // write_file の上書き前バックアップを「AIターン単位」で同じスナップショットdirにまとめるために使う。
  snapshotId?: string
  // 履歴一覧に出す見出し（このターンのユーザーの指示文）。「🕘 履歴」でどの作業か見分けるために使う。
  snapshotLabel?: string
}

/** ctx（applyFile・ragSearch などの関数込み）から、io（副作用の束）を window.electronAPI 呼び出しそのもので組み立てる。 */
function buildIo(ctx: ToolContext): ToolIo {
  return {
    fetchPage: (url) => window.electronAPI.web.fetchPage(url),
    webSearch: (provider, key, query) => window.electronAPI.web.search(provider, key, query),
    projectFiles: (root) => window.electronAPI.fs.projectFiles(root),
    readFileInProject: (root, rel) => window.electronAPI.fs.readFileInProject(root, rel),
    writeFileInProject: (root, rel, content) => window.electronAPI.fs.writeFileInProject(root, rel, content),
    applyFile: ctx.applyFile,
    snapshotBeforeWrite: (root, snapshotId, rel, newContent, label) =>
      window.electronAPI.backup.snapshotBeforeWrite(root, snapshotId, rel, newContent, label),
    runCommand: (cwd, command) => window.electronAPI.proc.run(cwd, command),
    ragSearch: ctx.ragSearch,
    searchInProject: (root, query, pathPattern) => window.electronAPI.fs.searchInProject(root, query, pathPattern),
    exists: (path) => window.electronAPI.fs.exists(path),
    openPath: async (path) => { await window.electronAPI.shell.openPath(path) },
  }
}

/** ツールを実行して、AIに返す結果文字列を作る。失敗もAIに伝える（説明できるように）。
 *  本体（判定順序・結果文言）は shared/toolExecCore.ts の executeToolCore に移した（B'-3d-2a）。
 *  ここは ctx から io（applyFile・ragSearch）と CoreToolContext（writeRoot 等）を分けて渡すだけ。 */
export async function executeTool(name: string, argsJson: string, ctx: ToolContext = {}): Promise<string> {
  const coreCtx: CoreToolContext = {
    writeRoot: ctx.writeRoot,
    projectRoot: ctx.projectRoot,
    search: ctx.search,
    snapshotId: ctx.snapshotId,
    snapshotLabel: ctx.snapshotLabel,
  }
  return executeToolCore(name, argsJson, coreCtx, buildIo(ctx))
}
