// AIに提供するツール（OpenAI互換のFunction Calling）の定義と実行。
// fetch_url・search_web（Web参照）/ list_files・read_file・write_file・run_command・open_preview（プロジェクト操作）。
// 書き込み系はプロジェクト内のみ。権限モード（おまかせ/毎回確認）と危険コマンドの必須確認は ChatPanel 側で制御。
// ※相互参照: Claude頭脳モード（C2b）の src/main/claude/tools.ts が fetch_url / search_docs / open_preview の
//   説明文言と結果整形（toolText.ts）を踏襲している。これらの文言・挙動を変更したら main 側も追随させること。

import { isDangerousCommand, leavesWorkingDir } from '../shared/commandGuard'
import { PUBLISH_DIR_LABEL, backupRelPath } from '../shared/publishRoot'
import { applyEdit } from './editFile'
import { isProtectedWritePath, protectedWriteMessage } from '../shared/protectedPaths'
export { isDangerousCommand }

const FETCH_URL_TOOL = {
  type: 'function',
  function: {
    name: 'fetch_url',
    description:
      '指定したURLのWebページ本文を取得する。ユーザーが参照を求めたページや、回答に必要なドキュメントを読むときに使う。' +
      '検索エンジンではないため、URLが分からない情報には使えない（その場合はユーザーにURLを依頼する）。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '取得するページのURL（http/httpsのみ）' },
      },
      required: ['url'],
    },
  },
}

const LIST_FILES_TOOL = {
  type: 'function',
  function: {
    name: 'list_files',
    description: '現在のプロジェクトのファイル一覧（相対パス）を取得する。構成を把握したいときに最初に使う。',
    parameters: { type: 'object', properties: {} },
  },
}

const READ_FILE_TOOL = {
  type: 'function',
  function: {
    name: 'read_file',
    description:
      '現在のプロジェクト内のファイルの中身を読む。コードの調査・修正・デバッグの前に、推測せず必ず実際の内容を読むこと。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'プロジェクトルートからの相対パス（例: src/index.js）' },
      },
      required: ['path'],
    },
  },
}

const WRITE_FILE_TOOL = {
  type: 'function',
  function: {
    name: 'write_file',
    description:
      '現在のプロジェクト内にファイルを作成・上書き保存する。コードの作成や修正はユーザーに頼まず、このツールで自分で保存すること。' +
      '【厳守】content にはファイルの完全な全文を入れること（断片・差分・省略は禁止。「...existing code...」のような省略も禁止）。' +
      '既存ファイルを修正するときは、必ず先に read_file で現在の内容を読み、変更箇所を反映した全文を書き戻すこと。' +
      '【重要】既存ファイルの部分修正には、全文を書き直すこのツールではなく edit_file を使うこと（新規作成・全面書き換えのときだけ write_file を使う）。' +
      '保存したファイルはエディタとファイルツリーに自動反映される。上書き時は旧内容が自動バックアップされ、ユーザーは画面上部の「🕘 元に戻す」から前の状態に戻せる。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'プロジェクトルートからの相対パス（例: src/index.html）' },
        content: { type: 'string', description: 'ファイルの完全な内容（差分ではなく全文）' },
      },
      required: ['path', 'content'],
    },
  },
}

const EDIT_FILE_TOOL = {
  type: 'function',
  function: {
    name: 'edit_file',
    description:
      '現在のプロジェクト内の既存ファイルを部分的に修正する（差分置換）。既存ファイルの一部を直すときは、' +
      '全文を書き直す write_file ではなく必ずこちらを使うこと（write_file は新規作成・全面書き換えのときだけ使う）。' +
      'old_string はファイル内で一意に決まる長さにすること（周囲の行を含めて、他の箇所と混同しない範囲まで広げる）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'プロジェクトルートからの相対パス（例: src/index.js）' },
        old_string: { type: 'string', description: '置き換える現在の文字列。周囲の行を含め、ファイル内で一意に決まる長さにすること' },
        new_string: { type: 'string', description: '置き換え後の文字列（削除したい場合は空文字）' },
        replace_all: { type: 'boolean', description: '一致箇所すべてを置換する場合は true（省略時は false。一致が複数あるとエラーになる）' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
}

const RUN_COMMAND_TOOL = {
  type: 'function',
  function: {
    name: 'run_command',
    description:
      'プロジェクトフォルダ内でシェルコマンドを実行し、終了コードと出力を得る。ビルド・テスト・構文チェック・エラー調査に使う。' +
      '実行後は出力を必ず読み、エラーがあれば自分でコードを修正して再実行すること。' +
      '【注意】60秒でタイムアウトするため、サーバーの常駐起動（npm start, php -S 等）には使わないこと（動作確認はユーザーに【② 試す】を案内する）。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '実行するコマンド（例: node --check main.js）' },
      },
      required: ['command'],
    },
  },
}

const OPEN_PREVIEW_TOOL = {
  type: 'function',
  function: {
    name: 'open_preview',
    description: 'プロジェクト内のHTMLファイルを既定ブラウザで開いてユーザーに見せる。作業が一段落して見た目を確認してもらうときに使う。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '開くHTMLファイルの相対パス（省略時は index.html）' },
      },
    },
  },
}

const SEARCH_WEB_TOOL = {
  type: 'function',
  function: {
    name: 'search_web',
    description:
      'Webを検索して結果一覧（タイトル・URL・抜粋）を得る。最新情報・知らない事柄・URLが不明な情報を調べるときに使う。' +
      '結果の抜粋だけで足りない場合は、有望なURLを fetch_url で読むこと。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '検索クエリ（日本語可）' },
      },
      required: ['query'],
    },
  },
}

const SEARCH_DOCS_TOOL = {
  type: 'function',
  function: {
    name: 'search_docs',
    description:
      'ユーザーが事前登録した資料（さくらのAI Engine）を検索して抜粋を得る。資料に関する質問や、資料を根拠にすべき回答の前に使う。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '検索したい内容（日本語可）' },
      },
      required: ['query'],
    },
  },
}

const SEARCH_IN_FILES_TOOL = {
  type: 'function',
  function: {
    name: 'search_in_files',
    description:
      'プロジェクト内のファイルを横断して文字列を検索し、該当ファイル・行番号・該当行を得る。' +
      'どのファイルに何があるか分からないときは、list_files と read_file を何度も繰り返す前に、まずこれで場所を特定すること。' +
      '単純な部分一致（大文字小文字は区別しない）。正規表現は使えない。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '探す文字列（単純な部分一致・大文字小文字を区別しない）' },
        path_pattern: { type: 'string', description: '省略可。対象を絞る単純なパターン（例: *.css, public/）。正規表現は不可' },
      },
      required: ['query'],
    },
  },
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

// モデルのツール（Function Calling）対応判定は src/renderer/toolSupport.ts へ移行した
// （旧: モデル名の正規表現によるハードコードで、新モデルが preview/・kimi 等の語に一致して
// 誤って非対応判定されていた。2026-07-30、実測から学習する方式に置き換え）。

// サーバがツール呼び出しに非対応のときの 400 エラー文言を判定する（実測前の楽観送信が外れたときの救済用）。
export function isToolUnsupportedError(message?: string): boolean {
  return /tool[-_ ]?call[-_ ]?parser|enable[-_ ]?auto[-_ ]?tool[-_ ]?choice|tool[-_ ]?choice|does not support tools|tools? .*not .*support/i.test(message ?? '')
}

/** 破壊的・危険なコマンドか（権限モードに関わらず必ずユーザー確認を取る）
 *  実体は src/shared/commandGuard.ts に一本化済み（ファイル冒頭で import・re-export 済み）
 *（旧: src/main/claude/guard.ts と同じ正規表現をここに複製しており「要相互追随」の危険な状態だったが解消した）。 */

/** チャットのエラーを、原因に応じた分かりやすい日本語の案内文にする。
 *  認証エラー（401 等）はキーの再発行・確認へ誘導する。
 *  engine で頭脳を指定（'sakura'=さくらのAI Engine / 'claude'=Claude）し、認証エラー時の
 *  誘導先（どちらのキーを確認するか）を出し分ける（所見9: Claude経路のエラーに
 *  「さくらのAI Engineのキーを確認」と誤案内していた問題の修正）。 */
export function formatChatError(message: string, engine: 'sakura' | 'claude' = 'sakura'): string {
  const m = (message || '').toLowerCase()
  // 認証エラー（401 等）。誘導先のキーを engine で出し分ける。
  if (/\b401\b|invalid token|unauthorized|authentication|invalid api key|invalid_api_key/.test(m)) {
    if (engine === 'claude') {
      return (
        'Claude のAPIキーが認証されませんでした（401）。キーが期限切れ・失効した可能性があります。\n\n' +
        '🔑 右上の ⚙️（設定）→「認証情報（APIキー）」で「Claude」のキーを確認し、\n' +
        'うまくいかない場合は Anthropic のコンソールでキーを再発行して入れ直してください。\n' +
        '（「🔌 接続テスト」で有効かどうか確認できます）'
      )
    }
    return (
      'APIキーが認証されませんでした（401）。キーが期限切れ・失効した可能性があります。\n\n' +
      '🔑 右上の ⚙️（設定）→「認証情報（APIキー）」で「さくらのAI Engine」のキーを確認し、\n' +
      'うまくいかない場合は さくらのAI Engine でキーを再発行して入れ直してください。\n' +
      '（「🔌 接続テスト」で有効かどうか確認できます）'
    )
  }
  // Claude の請求・クレジット不足（402 等）。キーは有効だが利用できない状態への案内。
  if (engine === 'claude' && /\b402\b|billing|credit balance|insufficient|payment|quota/.test(m)) {
    return (
      'Claude を利用できませんでした。Anthropic アカウントのクレジット残高・請求設定に問題がある可能性があります。\n\n' +
      '💳 Anthropic Console（console.anthropic.com）で請求設定を確認してください。\n' +
      '（さくらのAI Engine のキーも登録していれば、そちらに切り替えて続けることもできます）'
    )
  }
  // レート制限（429）。両経路共通。
  if (/\b429\b|rate limit|too many requests|overloaded/.test(m)) {
    return '混み合っています。少し待ってから、もう一度送信してください。'
  }
  // コンテキスト（会話）が長くなりすぎた場合。両経路共通。
  if (/context (length|window)|maximum context|too long|token limit|context_length|exceeds? .*token/.test(m)) {
    return '会話が長くなりすぎました。チャット上部の 🗑（クリア）で会話をリセットしてから、続きを依頼してください。'
  }
  const keyHint = engine === 'claude' ? 'Claude のAPIキー' : 'APIキーと利用上限'
  return `エラー: ${message}\n\n💡 うまくいかないときは: もう一度送信するか、設定（🔑）で${keyHint}を確認してください。`
}

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

/** 利用可能なツール一覧。プロジェクト・検索設定・資料設定の有無に応じて変える。 */
export function toolsFor(projectDir?: string | null, hasSearch?: boolean, hasRag?: boolean) {
  const tools: any[] = [FETCH_URL_TOOL]
  if (hasSearch) tools.push(SEARCH_WEB_TOOL)
  if (hasRag) tools.push(SEARCH_DOCS_TOOL)
  if (projectDir) tools.push(LIST_FILES_TOOL, READ_FILE_TOOL, WRITE_FILE_TOOL, EDIT_FILE_TOOL, RUN_COMMAND_TOOL, OPEN_PREVIEW_TOOL, SEARCH_IN_FILES_TOOL)
  return tools
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

/** ツール実行中にUIへ表示する短い説明文 */
export function toolStatusLabel(name: string, argsJson: string): string {
  try {
    const args = JSON.parse(argsJson || '{}')
    if (name === 'fetch_url') return `🌐 ページを取得しています… ${args.url ?? ''}`
    if (name === 'search_web') return `🔍 Webを検索しています… 「${args.query ?? ''}」`
    if (name === 'read_file') return `📄 ファイルを読んでいます… ${args.path ?? ''}`
    if (name === 'write_file') return `✏️ ファイルを保存しています… ${args.path ?? ''}`
    if (name === 'edit_file') return `✏️ ファイルを編集しています… ${args.path ?? ''}`
    if (name === 'list_files') return '📁 ファイル一覧を確認しています…'
    if (name === 'run_command') return `⚡ コマンドを実行しています… ${args.command ?? ''}`
    if (name === 'open_preview') return `🌐 プレビューを開いています… ${args.path ?? 'index.html'}`
    if (name === 'search_docs') return `📚 資料を検索しています… 「${args.query ?? ''}」`
    if (name === 'search_in_files') return `🔍 内容を検索しています… 「${args.query ?? ''}」`
  } catch { /* 引数が壊れていてもラベルは出す */ }
  return `🔧 ${name} を実行しています…`
}

// 推論(CoT)を回答へフォールバック表示する際、暴走（同じ段落の無限反復）や過長を抑えて要約する。
export function condenseReasoning(text: string): string {
  const raw = (text ?? '').trim()
  if (!raw) return raw
  const paras = raw.split(/\n+/).map(s => s.trim()).filter(Boolean)
  const seen = new Set<string>()
  const out: string[] = []
  let looped = false
  for (const p of paras) {
    if (p.length > 20 && seen.has(p)) { looped = true; break } // 反復検出→打ち切り
    seen.add(p)
    out.push(p)
  }
  let result = out.join('\n')
  const CAP = 1500
  let capped = false
  if (result.length > CAP) { result = result.slice(0, CAP).trim() + '…'; capped = true }
  if (looped || capped) {
    result = '（モデルが本文ではなく思考過程のみを返しました。暴走・冗長を避けるため要約して表示します）\n\n' + result
  }
  return result
}

/**
 * isToolArgsComplete — ツール呼び出しの引数（JSON文字列）が「途中で切れていない」完全なJSONか。
 * 推論型モデル（Kimi 等）が write_file の引数として大きなファイル内容を吐く途中で出力トークン上限に
 * 達すると、引数JSONが未終端（例: `{"path":"a.css","content":"...` の閉じ引用符欠落）になる。
 * この壊れた tool_calls をそのままサーバーへ送り返すと「400 Unterminated string」で失敗するため、
 * 実行・送り返しの前にこれで検証して安全に中断する（2026-07-14 ユーザー報告・Kimi K2.6 で発生）。
 */
export function isToolArgsComplete(args: string | undefined | null): boolean {
  if (typeof args !== 'string') return false
  const s = args.trim()
  if (s === '') return true // 引数を取らないツール（空文字）は正常扱い
  try { JSON.parse(s); return true } catch { return false }
}

// 一部のモデル（Kimi-K2 等）は、ツールを渡していなくても独自の特殊トークン形式で
// 「ツール呼び出し」を本文テキストとして出力する。IDE はこれをツールとして実行できず、
// 生のマークアップ（<|tool_calls_section_begin|> 等）が表示され、モデルは結果待ちで
// 止まったように見える。これを検出・除去・自己修復するためのヘルパー。
const TOOL_MARKUP_RE = /<\|tool_call|<\|tool_outputs?_section/i

/** 本文に「テキスト形式のツール呼び出し」マークアップが含まれるか。 */
export function hasTextToolMarkup(text?: string): boolean {
  return TOOL_MARKUP_RE.test(text ?? '')
}

/** ファイルを書き換えるツール（これが走っていなければ、中身は変わっていない）。 */
export const WRITING_TOOLS = ['write_file', 'edit_file'] as const

/**
 * その返事は「ファイルを変えた」と言っているか（純関数）。
 *
 * ── なぜ要るか（2026-08-19 実機・Ryosuke 報告）──────────────────────────
 * AI が「✅ 反映しました／プレースホルダーを差し替え」と答えたのに、
 * **ファイルは変わっていなかった**。会話には「📄 ファイルを読んでいます」しか
 * 出ておらず、**書き込みは1度も走っていなかった**。
 *
 * つまり原因は「ツールを扱えない」ではない（読み取りは正しく実行できている）。
 * **やっていないことを、やったと書いた**だけである。原因が何であれ、
 * 「言っていること」と「実際に起きたこと」の食い違いは、ここで捕まえられる。
 */
export function claimsFileChange(text: string | null | undefined): boolean {
  const t = String(text ?? '')
  // 「〜しました」「〜済み」のような**完了**の言い方だけを見る。
  // 「変更しますか？」「差し替えましょうか」は、まだやっていないので対象外。
  return /(反映|差し替え|置き換え|書き換え|変更|修正|更新|保存|追加|作成)(を)?(し|いたし)(まし|た)/.test(t)
    || /(に|へ)(差し替え|置き換え)ました/.test(t)
}

/**
 * 「変えたと言っているのに、書き込みが1度も走っていない」ときの注意書き（純関数）。
 *
 * **黙って成功に見せない。** 直し方（やり直す・モデルを変える）まで書く。
 */
export function unexecutedChangeWarning(claims: boolean, wrote: boolean): string | null {
  if (!claims || wrote) return null
  // ── 矛盾に見えないように書く（2026-08-19 実機・Ryosuke 報告）──────────
  // AI が「✏️ style.css を保存しました」と書いた直後に「変更されていません」と
  // 出るため、**どちらが本当か分からない**という見え方になっていた。
  // Koto が確かめた事実である、と分かる書き方にする。
  return '⚠️ AI は「保存しました」と書いていますが、**実際には書き込みが行われていません**'
    + '（Koto がこのやり取りを確認しました。AI の説明の方が誤りです）。\n'
    + 'もう一度「実際に変更して」と伝えるか、上のモデル選択を「Qwen3-Coder」などに'
    + '切り替えてからお試しください。'
}

/**
 * 「やったように書かれているが、実際には何も実行されていない」ときの注意書き（純関数）。
 *
 * ── なぜ要るか（2026-08-19 実機・Ryosuke 報告）──────────────────────────
 * 画像を添付したターンで、AI は「✅ 画像を反映しました。プレースホルダーを
 * 差し替えました」と答えたのに、**ファイルは何も変わっていなかった**。
 *
 * このモデル（Kimi 系）は構造化のツール呼び出しができず、本文に特殊トークンで
 * 「ツールを呼んだつもり」の文字を吐く。Koto はそれを取り除いて読める文だけを
 * 見せるので、**見た目は成功の報告そのもの**になる。いちばん困る形である。
 *
 * @param sawMarkup 本文にテキスト形式のツール呼び出しがあったか
 * @param usedTools このターンで実際にツールを実行したか
 */
export function unexecutedToolWarning(sawMarkup: boolean, usedTools: boolean): string | null {
  if (!sawMarkup || usedTools) return null
  return '⚠️ このモデルはファイルの書き換えを実行できませんでした。'
    + '**上の説明どおりには変わっていません。**'
    + 'モデルを「Qwen3-Coder」などツールを使えるものに切り替えて、もう一度お試しください。'
}

/** モデルが本文に吐いたツール呼び出しの特殊トークン／マークアップを除去し、人が読める本文だけにする。 */
export function stripToolMarkup(text: string): string {
  if (!text) return text
  let out = text
  // 完結したツールコール／ツール出力セクションを丸ごと除去
  out = out.replace(/<\|tool_calls?_section_begin\|>[\s\S]*?<\|tool_calls?_section_end\|>/gi, '')
  out = out.replace(/<\|tool_outputs?_section_begin\|>[\s\S]*?<\|tool_outputs?_section_end\|>/gi, '')
  // 未終端（モデルが途中で止まった）→ セクション開始以降を末尾まで除去
  out = out.replace(/<\|tool_(calls?_section|call)_begin\|>[\s\S]*$/gi, '')
  // 残った特殊トークン（<|...|>）を除去
  out = out.replace(/<\|[^|>]*\|>/g, '')
  // 孤立した functions.name:N（直後に引数JSONが続くことがある）を除去
  out = out.replace(/functions\.[A-Za-z0-9_]+:\d+\s*(\{[\s\S]*?\})?/g, '')
  // 余分な空白・空行を畳む
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
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
