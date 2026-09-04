// aiToolsCore.ts — AIツール（Function Calling）定義・チャットの純粋な補助関数のうち、
// window/localStorage/electron に依存しない部分（renderer の aiTools.ts / aiContext.ts
// から実体を移した）。
//
// なぜ shared にあるか（B'-3b）: 次の段で main プロセスで動くループ（chatTurn.ts）の
// ports.h を、renderer からも main からも同じ実装で組み立てられるようにするため。
//
// ── B'-3d-3（2026-08-30）: 承認の要否判定に使う関数を renderer/aiTools.ts から移した ──────
// requiresConfirmation / confirmReason / installTargetsFromCommand / isSensitiveCommand は、
// 承認（approveToolCall）を main へ一元化する（掟10）ための材料。main（turnRunner.ts）・
// renderer（aiTools.ts が re-export・互換維持）の両方から同じ実装を呼べるようにする。
import { isDangerousCommand, leavesWorkingDir } from './commandGuard'
import { PUBLISH_DIR_LABEL } from './publishRoot'

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

/** 利用可能なツール一覧。プロジェクト・検索設定・資料設定の有無に応じて変える。 */
export function toolsFor(projectDir?: string | null, hasSearch?: boolean, hasRag?: boolean) {
  const tools: any[] = [FETCH_URL_TOOL]
  if (hasSearch) tools.push(SEARCH_WEB_TOOL)
  if (hasRag) tools.push(SEARCH_DOCS_TOOL)
  if (projectDir) tools.push(LIST_FILES_TOOL, READ_FILE_TOOL, WRITE_FILE_TOOL, EDIT_FILE_TOOL, RUN_COMMAND_TOOL, OPEN_PREVIEW_TOOL, SEARCH_IN_FILES_TOOL)
  return tools
}

// モデルのツール（Function Calling）対応判定は src/renderer/toolSupport.ts へ移行した
// （旧: モデル名の正規表現によるハードコードで、新モデルが preview/・kimi 等の語に一致して
//   誤って非対応判定されていた。2026-07-30、実測から学習する方式に置き換え）。

/** インストール・通信・コード直接実行・システム設定変更など、おまかせモードでも確認すべきコマンドか
 *  （旧 renderer/aiTools.ts から移した・B'-3d-3）。 */
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

/** run_command 実行前にユーザー確認が必要か（破壊的 or 上記カテゴリ）（旧 renderer/aiTools.ts から移した・B'-3d-3）。 */
export function requiresConfirmation(cmd: string): boolean {
  // 作業フォルダの外へ出るコマンドも一度は目に入れる（止めはしない・2026-08-20）。
  return isDangerousCommand(cmd) || isSensitiveCommand(cmd) || leavesWorkingDir(cmd)
}

/**
 * インストールするライブラリの名前をコマンドから読み取る（純関数）（旧 renderer/aiTools.ts から移した・B'-3d-3）。
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

/** なぜ確認するのかを初心者向けに一言で説明する（旧 renderer/aiTools.ts から移した・B'-3d-3）。 */
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

// サーバがツール呼び出しに非対応のときの 400 エラー文言を判定する（実測前の楽観送信が外れたときの救済用）。
export function isToolUnsupportedError(message?: string): boolean {
  return /tool[-_ ]?call[-_ ]?parser|enable[-_ ]?auto[-_ ]?tool[-_ ]?choice|tool[-_ ]?choice|does not support tools|tools? .*not .*support/i.test(message ?? '')
}

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
  //
  // ── 文ごとに見て、過去の作業への言及は除外する（2026-08-30 実機・v0.4.5）────────
  // 「lsを実行して」への返答が「text.txt は先ほど更新した内容が保存されています」の
  // ような**過去のターンの話**を含むだけで真になり、誤検知の確認往復が毎ターン走った
  // （Kimi 系は直前の作業に触れる癖がある）。「先ほど」「前のターンで」等を含む文は、
  // このターンの完了報告ではないので数えない。
  // ⚠️ トレードオフ: 「すでにあるファイルを更新しました」のような本物の報告も
  // 除外されうる（偽陰性）。守りの主目的は「露骨な嘘の完了報告」であり、そちらは
  // ふつう過去参照を伴わないため、うるささ（毎ターンの誤検知）の解消を優先した。
  const PAST_REF = /先ほど|さっき|前のターン|以前|すでに|既に|過去に/
  const DONE = /(反映|差し替え|置き換え|書き換え|変更|修正|更新|保存|追加|作成)(を)?(し|いたし)(まし|た)/
  const DONE2 = /(に|へ)(差し替え|置き換え)ました/
  return t.split(/[。\n]/).some(s => (DONE.test(s) || DONE2.test(s)) && !PAST_REF.test(s))
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
    + 'もう一度「実際に変更して」と伝えるか、上のモデル選択を「Kimi K2.7 Code」などに'
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
    + 'モデルを「Kimi K2.7 Code」などツールを使えるものに切り替えて、もう一度お試しください。'
}

/**
 * 直前の返事と**同一の案内段落**（「②試す で確認してみてください」等の定型文）を取り除く（純関数）。
 *
 * ── なぜ（2026-08-30 実機・Ryosuke 指摘）──────────────────────────────
 * システムプロンプトは初心者向けに「作業がひと区切りしたら次にやることを案内」と指示している。
 * 「同じ案内を連続で繰り返さない」という指示も足したが、モデル（Kimi K2.7）は**無視して**
 * 毎ターン一字一句同じ定型文を付けてきた。プロンプトで従わせるのは諦め、Koto 側で機械的に
 * 抑止する（stripToolMarkup と同じ発想: モデル任せにせず、判定はコードで）。
 *
 * 消すのは「①案内の形をした段落（GUIDANCE_RE）で、かつ ②直前のアシスタントの返事に
 * **同じ段落がそのまま**在るもの」だけ。新しい内容の案内（初出）は残る。
 * 全段落が消える場合は元のまま返す（空の返事にしない）。
 */
const GUIDANCE_RE = /画面上部の【[②③]|次にやることを1つ案内します/
export function stripRepeatedGuidance(content: string, prevAssistant: string | null | undefined): string {
  if (!content || !prevAssistant) return content
  const prevParas = new Set(prevAssistant.split(/\n{2,}/).map(p => p.trim()).filter(Boolean))
  const paras = content.split(/\n{2,}/)
  const kept = paras.filter(p => {
    const t = p.trim()
    return !(GUIDANCE_RE.test(t) && prevParas.has(t))
  })
  if (kept.length === paras.length) return content // 何も消さないなら原文をそのまま（空行の形も保つ）
  const next = kept.join('\n\n').trim()
  return next === '' ? content : next
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

// Web検索は IDE 主導（autoSearchBlock）で結果を注入する方式に変更したため、モデル非依存で機能する。
// ここではキーの有無だけをモデルに伝える（捏造防止）。
export function searchStatusContext(hasSearchKey: boolean): string {
  return hasSearchKey
    ? '\n【Web検索】検索が必要そうな質問では、IDEが自動でWeb検索を行い「検索結果」をこのプロンプトに添付します（どのモデルでも機能します）。検索結果が添付されていればそれを根拠に回答すること。添付が無い事実や最新情報を推測で創作せず、「検索しました」と偽らないこと。\n'
    : '\n【Web検索】現在Web検索は利用できません（検索用APIキーが未登録）。最新情報やWeb上の事実を推測で創作したり「検索しました」と偽ったりせず、「Web検索は未設定です。認証情報（⌘ ,）の『Web検索』で Tavily または Brave の無料APIキーを登録すると、どのモデルでも検索できます」と案内すること。\n'
}
