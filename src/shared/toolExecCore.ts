// toolExecCore.ts — AIツール実行（executeTool）の本体を、window/electron に依存しない
// 純粋な shared モジュールへ切り出したもの（B'-3d-2a）。
//
// ── なぜ（B'-3d-2）───────────────────────────────────────────────
// このあと（B'-3d-2b）AIのツール実行（executeTool）を main プロセスへ移す。今回はその
// 前段として、実行本体を「io（副作用の束）を受け取って動く純粋関数 executeToolCore」へ
// 切り出す。renderer（aiTools.ts）は io を window.electronAPI から組み立てて呼ぶだけの
// 薄い皮になり、main は同じ io を直呼びの実装で組み立てて呼ぶ（B'-3d-2b）。
// B'-2/3a と同じ手法:「移す前と移した後で同じコードが走る」ことで、見かけ・文言の不変を
// 構造で保証する。**この段では見かけは一切変わらない。ask（executeTool）もそのまま。**
//
// 大原則: 対象コード（旧 renderer/aiTools.ts の executeTool 本体）はコピーして、
// 呼び先の付け替え（window.electronAPI.* → io.*、ctx.applyFile/ctx.ragSearch →
// io.applyFile/io.ragSearch）だけを行っている。ロジック・判定順序・結果文言は
// 一字一句変えていない。コメントもそのまま持ってきている（このリポジトリのコメントは
// 「なぜ」を記録した資産）。

import { isProtectedWritePath, protectedWriteMessage } from './protectedPaths'
import { backupRelPath } from './publishRoot'
import { wrapUntrusted } from './untrustedBlock'
import { applyEdit } from './editFile'

export type SearchProvider = 'tavily' | 'brave'
export interface SearchConfig { provider: SearchProvider; key: string }

const READ_MAX_CHARS = 16000 // AIに渡すファイル内容の上限（トークン費用の暴走防止）

/** プロジェクトルート配下の安全な絶対パスに解決する。絶対パス・脱出を試みるパスは null。 */
export function resolveInProject(projectDir: string, relPath: string): string | null {
  if (relPath.startsWith('/') || relPath.includes('..')) return null
  const clean = relPath.replace(/^\.\//, '')
  if (!clean) return null
  return `${projectDir}/${clean}`
}

/** 書き込み系ツール専用の解決（読み取りは制限しない）。Koto の管理領域は拒否する。 */
export function resolveForWrite(projectDir: string, relPath: string): { full: string } | { error: string } {
  if (isProtectedWritePath(relPath)) return { error: `エラー: ${protectedWriteMessage(relPath)}` }
  const full = resolveInProject(projectDir, relPath)
  if (!full) return { error: `エラー: 不正なパスです（${relPath}）。プロジェクトルートからの相対パスを指定してください` }
  return { full }
}

/** データだけの文脈（直列化可能。関数は io 側に置く）。ToolContext（renderer）から関数を除いた形。 */
export interface CoreToolContext {
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
  // このAIターンのスナップショットID（useAiChat が send 1回ごとに採番）。
  // write_file の上書き前バックアップを「AIターン単位」で同じスナップショットdirにまとめるために使う。
  snapshotId?: string
  // 履歴一覧に出す見出し（このターンのユーザーの指示文）。「🕘 履歴」でどの作業か見分けるために使う。
  snapshotLabel?: string
}

/** 副作用の束。renderer は window.electronAPI から組む。B'-3d-2b で main が直呼びで組む。 */
export interface ToolIo {
  fetchPage(url: string): Promise<{ url: string; title?: string; content: string }>
  webSearch(provider: 'tavily' | 'brave', key: string, query: string): Promise<{ title: string; url: string; description: string }[]>
  projectFiles(root: string): Promise<string[]>
  readFileInProject(root: string, rel: string): Promise<string>
  writeFileInProject(root: string, rel: string, content: string): Promise<void>
  // ファイル保存の実処理（保存＋エディタ・ツリーへの反映）。App.tsx の applyAiFile を渡す。
  // 第3引数 root は「書き込む根」（省略時は applyAiFile 側が currentDir にフォールバックする）。
  // ここに ctx.writeRoot（ふつうは public/）を渡さないと、IDE のチャットは
  // プロジェクト直下へ書いてしまう（2026-08-27 発見の不具合の根っこ）。
  applyFile?(rel: string, content: string, root?: string | null): Promise<void>
  snapshotBeforeWrite(root: string, snapshotId: string, rel: string, newContent: string, label?: string): Promise<{ ok: boolean; backedUp: boolean }>
  runCommand(cwd: string, command: string): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>
  // 📚 資料の検索（rag:query を呼んで出典付きブロック文字列を返す）。ChatPanel が渡す
  ragSearch?(query: string): Promise<string>
  // search_in_files ツール用（プロジェクト内の全文検索）。fs.searchInProject の付け替え先。
  searchInProject(root: string, query: string, pathPattern?: string): Promise<{
    ok: boolean
    matches: { path: string; line: number; text: string }[]
    truncated: boolean
    message?: string
  }>
  exists(path: string): Promise<boolean>
  openPath(path: string): Promise<void>
}

/** ツールを実行して、AIに返す結果文字列を作る。失敗もAIに伝える（説明できるように）。 */
export async function executeToolCore(name: string, argsJson: string, ctx: CoreToolContext, io: ToolIo): Promise<string> {
  let args: any = {}
  try { args = JSON.parse(argsJson || '{}') } catch { return 'エラー: ツール引数のJSONが不正です' }

  if (name === 'fetch_url') {
    const url = String(args.url ?? '')
    try {
      const page = await io.fetchPage(url)
      return wrapUntrusted(`ページ: ${page.url}${page.title ? `（${page.title}）` : ''}`, page.content)
    } catch (e: any) {
      return `エラー: ページを取得できませんでした（${e?.message ?? e}）`
    }
  }

  if (name === 'search_web') {
    if (!ctx.search) return 'エラー: Web検索のAPIキーが未設定です（ユーザーに認証情報（⇧⌘,）でのTavilyまたはBraveのキー登録を案内してください）'
    const query = String(args.query ?? '').trim()
    if (!query) return 'エラー: 検索クエリが空です'
    try {
      const results = await io.webSearch(ctx.search.provider, ctx.search.key, query)
      if (!results.length) return `「${query}」の検索結果はありませんでした`
      return (
        `「${query}」の検索結果:\n\n` +
        wrapUntrusted(`Web検索結果（クエリ: "${query}"）`, results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`).join('\n\n')) +
        '\n\n（詳細が必要なページは fetch_url で本文を取得できます）'
      )
    } catch (e: any) {
      return `エラー: ${e?.message ?? e}`
    }
  }

  if (name === 'list_files') {
    if (!ctx.writeRoot) return 'エラー: プロジェクトが開かれていません'
    try {
      const files = await io.projectFiles(ctx.writeRoot)
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
      const content = await io.readFileInProject(ctx.writeRoot, rel)
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
        const r = await io.snapshotBeforeWrite(
          root, snapshotId, backupRelPath(root, ctx.writeRoot, rel), content, ctx.snapshotLabel)
        backedUp = r.ok && r.backedUp
      } catch { /* バックアップ失敗は保存を妨げない */ }
      if (io.applyFile) {
        // root（ctx.writeRoot）を必ず渡す。渡さないと applyAiFile 側は
        // プロジェクト直下へ書いてしまい、public/ を持つプロジェクトで
        // 「AIが書いたファイルが公開の根の外へ出る」（2026-08-27 発見の不具合）。
        await io.applyFile(rel, content, ctx.writeRoot) // 保存＋エディタ・ツリー反映
      } else {
        await io.writeFileInProject(ctx.writeRoot, rel, content)
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
      content = await io.readFileInProject(ctx.writeRoot, rel)
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
        const r = await io.snapshotBeforeWrite(
          root, snapshotId, backupRelPath(root, ctx.writeRoot, rel), result.next, ctx.snapshotLabel)
        backedUp = r.ok && r.backedUp
      } catch { /* バックアップ失敗は保存を妨げない */ }
      if (io.applyFile) {
        // write_file とまったく同じ理由で root（ctx.writeRoot）を渡す（掟10・一元化した守りの形）
        await io.applyFile(rel, result.next, ctx.writeRoot) // 保存＋エディタ・ツリー反映
      } else {
        await io.writeFileInProject(ctx.writeRoot, rel, result.next)
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
      const r = await io.runCommand(ctx.writeRoot, command)
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
    if (!io.ragSearch) return '資料検索は現在利用できません'
    const query = String(args.query ?? '').trim()
    if (!query) return 'エラー: 検索クエリが空です'
    try {
      const result = await io.ragSearch(query)
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
      const r = await io.searchInProject(ctx.writeRoot, query, pathPattern)
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
    if (!(await io.exists(full))) return `エラー: ファイルがありません（${rel}）`
    try {
      await io.openPath(full)
      return `ブラウザで ${rel} を開きました。ユーザーに見た目の感想を聞いてください。`
    } catch (e: any) {
      return `エラー: 開けませんでした（${e?.message ?? e}）`
    }
  }

  return `エラー: 未対応のツールです（${name}）`
}
