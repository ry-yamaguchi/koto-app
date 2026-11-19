// events.ts — Agent SDK のストリームメッセージ（SDKMessage）を、UI が扱いやすい単純なイベントへ
// マッピングする純粋関数。C2a の中核（agent.ts から呼ばれる／Vitest で単体テスト対象）。
//
// ※型について: SDKMessage の実体（SDKAssistantMessage.message は BetaMessage）は
//   `@anthropic-ai/sdk` の型（claude-agent-sdk の peerDependency・本プロジェクトには devDependency
//   として入れていない）に依存しており、tsconfig の skipLibCheck 環境では解決できず事実上 any 化される。
//   そのため本ファイルではブロックの中身を実行時に安全にチェックする防御的な実装にしてある
//   （型に頼らず `typeof` / `Array.isArray` 等で確認してから使う）。

import { withFailureDetail, failureDetailOf } from '../../shared/failureText'
import { joinFailureDetail } from '../../shared/failureDetail'
import type { WriteFixMark } from '../../shared/securityFindings'

export type UiEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; detail: string }
  | { kind: 'result'; costUsd: number; durationMs: number; isError: boolean }
  | { kind: 'error'; message: string }
  // C2b: open_preview ツールの副作用通知。mapSdkMessage からではなく、MCPツールのハンドラ実行時に
  // ipc/claude.ts が発行する（renderer は従来の open_preview ツールと同じ処理で既定ブラウザを開く）
  // id は結果の返信（claude:openPreviewResult）の鍵。projectDir・writeRoot は送信時のもの。
  | { kind: 'openPreview'; id: string; path: string; projectDir: string; writeRoot: string }
  // C3: delegate_implementation の実行後。mapSdkMessage からではなく、ipc/claude.ts が
  // tools.ts の onDelegated コールバックから発行する（renderer は AI Engine 側のusageとして記録する）。
  | { kind: 'delegated'; model: string; promptTokens: number; completionTokens: number }
  // Edit/Write・委譲書き込みの成功後（データ喪失バグ修正・2026-07-11）。mapSdkMessage からではなく、
  // agent.ts の PostToolUse フック／tools.ts の委譲書き込みから ipc/claude.ts が発行する。
  // renderer は該当パスの開きタブをディスクから読み直す（stale tab のオートセーブ上書き防止）。
  | { kind: 'fileWritten'; path: string }
  // 成功で終わるターンの終わりに、書いた中身の点検で残った問題を知らせる（値は含まない）。result の前に出る。
  // projectDir は、受け取る側が自分のプロジェクトの回のものだけを当てるための印（掟11）。
  | { kind: 'writeCheck'; text: string; marks: WriteFixMark[]; projectDir: string }

/** 画面へ送る形。どの回の出来事かの印（turn）を載せる。superseded は、同じプロジェクトの次の送信に前の回が止められたことの知らせ。 */
export type TurnTaggedUiEvent = (UiEvent | { kind: 'superseded' }) & { turn: string }

/** tool_use ブロックの input から、ツール実行中表示に使う短い一言（ファイルパス／コマンド等）を作る。 */
export function describeToolDetail(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return typeof i.file_path === 'string' ? i.file_path : ''
    case 'Bash':
      return typeof i.command === 'string' ? i.command : ''
    case 'Glob':
      return typeof i.pattern === 'string' ? i.pattern : ''
    case 'Grep':
      return typeof i.pattern === 'string' ? i.pattern : ''
    default:
      // C2b/C3: IDE固有MCPツール（修飾名 mcp__koto__fetch_url / mcp__koto__search_docs /
      // mcp__koto__open_preview / mcp__koto__delegate_implementation）。
      // 将来のMCPツール追加にも耐えるよう、修飾名（mcp__…）全般で url / query / task / path を拾う。
      if (name.startsWith('mcp__')) {
        if (typeof i.url === 'string') return i.url
        if (typeof i.query === 'string') return i.query
        // delegate_implementation: task の先頭60文字を表示（長い自己完結仕様の全文は出さない）
        if (typeof i.task === 'string') return i.task.slice(0, 60)
        if (typeof i.path === 'string') return i.path
        // open_preview の path 省略時は既定の index.html を表示（renderer の toolStatusLabel と同じ）
        if (name.endsWith('__open_preview')) return 'index.html'
      }
      return ''
  }
}

/** SDKAssistantMessage.error（あれば）を日本語の一言に変換する。 */
export function describeAssistantError(code: string): string {
  const table: Record<string, string> = {
    authentication_failed: 'APIキーが認証されませんでした。',
    oauth_org_not_allowed: '組織の設定によりこの認証は許可されていません。',
    // ※ この文言は renderer 側 claudeMode.ts の isClaudeUsageBlockedError() が「請求設定に問題」で
    //   検出して「さくらのAI Engineに切り替える」提案を出す判定に使う。変更する場合は同関数も追随すること。
    // W-11: 登録画面の呼び名「Claude Console（platform.claude.com）」に揃える。
    // 判定は「請求設定に問題」の部分文字列で行うため、その部分は変えない。
    billing_error: '請求設定に問題があります。Claude Console（platform.claude.com）を確認してください。',
    rate_limit: 'リクエストが多すぎます。しばらく待ってからもう一度お試しください。',
    overloaded: 'Anthropic側が混雑しています。しばらく待ってからもう一度お試しください。',
    invalid_request: 'リクエストが不正です。',
    model_not_found: '指定したモデルが見つかりません。',
    server_error: 'Anthropic側でエラーが発生しました。しばらく待ってからもう一度お試しください。',
    max_output_tokens: '出力の上限に達したため打ち切られました。',
  }
  // 表に無い区分（unknown・account_on_hold・verification_required・cloud_credential_error と、SDK が後から足すもの）は一般の文にする。
  // 画面が「エラー: 」を前に付けるので、文は「エラー」で始めない。区分そのものは assistantErrorMessage が「詳細」に添える。
  return Object.prototype.hasOwnProperty.call(table, code) ? table[code] : 'Claude の処理が失敗しました。'
}

/** 文のブロックだけをつなぐ（空白だけのブロックは数えない）。 */
function textOfBlocks(blocks: unknown[]): string {
  return blocks
    .map(raw => raw as Record<string, unknown>)
    .filter(b => b?.type === 'text' && typeof b.text === 'string' && (b.text as string).trim())
    .map(b => (b.text as string).trim())
    .join('\n')
}

/** assistant の error 区分と、同じメッセージの文から、画面へ送る失敗の文を決める。
 *  文があれば原文のまま送る（renderer の formatChatError が、回線断なら回線の文＋詳細に、見分けられなければ原文つきの文にする。
 *  ここで日本語の文を作ると、renderer がもう一度包んで詳細が途中に挟まる）。
 *  文が無ければ区分の日本語の文に、区分そのもの（authentication_failed など）を「詳細」として添える（失敗の文は原文を捨てない）。
 *  詳細を作る・運ぶのは shared/failureText.ts の withFailureDetail の1か所。renderer の formatChatError は、送られた文の
 *  最後の「詳細:」の行を判定にかけず、そのまま最後の行へ運ぶ。 */
export function assistantErrorMessage(code: string, text: string): string {
  // 文があるときも、区分名つきの詳細を添える（画面が文を見分けて日本語の文に置き換えても、区分名と原文が残る）。
  return text ? joinFailureDetail(text, failureDetailOf(`${code} / ${text}`)) : withFailureDetail(describeAssistantError(code), code)
}

/** SDK の文を持つ失敗（認証・モデル不明など、日本語の固定文に置き換える区分）の文。
 *  日本語の文は変えない（請求の判定が頼る）。詳細に、区分名と SDK の原文の両方を残す（原文を捨てない）。
 *  秘密の形とホームの場所は withFailureDetail が伏せる。 */
export function assistantErrorWithSdkText(code: string, sdkText: string): string {
  return withFailureDetail(describeAssistantError(code), sdkText ? `${code} / ${sdkText}` : code)
}

/** result.errors（SDK の型では文字列の配列だが、実行時は確かめない）から文を取り出す。
 *  文字列はそのまま、message を持つ値はその message。どちらでもない値は捨てる。 */
function errorStringsOf(errors: unknown[]): string[] {
  const out: string[] = []
  for (const e of errors) {
    if (typeof e === 'string') { if (e.trim()) out.push(e) }
    else if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') {
      const msg = (e as { message: string }).message
      if (msg.trim()) out.push(msg)
    }
  }
  return out
}

/** result が失敗で、errors が空のときの文。原因を言い切らず、SDK が返した区分（subtype）と result の文を詳細に残す。 */
export function resultErrorMessage(subtype: unknown, resultText: unknown): string {
  const original = [typeof subtype === 'string' ? subtype : '', typeof resultText === 'string' ? resultText.trim() : '']
    .filter(Boolean).join(' / ')
  return withFailureDetail('Claude の処理がエラーで終わりました。', original)
}

/**
 * SDK のストリームメッセージ1件を UI イベント配列へ変換する（0〜複数件）。
 * - system/init → session（session_id を拾う）
 * - assistant → message.content の各ブロックを見る（text→text、tool_use→tool）。
 *   msg.error があれば先頭に error イベントを追加する。
 * - result（成功/失敗共通） → result（total_cost_usd/duration_ms/is_error）。
 *   失敗時、errors 配列があれば先に error イベントも出す。
 * - それ以外（stream_event/user 等）は今回のUIでは使わないため空配列。
 */
export function mapSdkMessage(msg: unknown): UiEvent[] {
  if (!msg || typeof msg !== 'object') return []
  const m = msg as Record<string, unknown>

  switch (m.type) {
    case 'system': {
      if (m.subtype === 'init' && typeof m.session_id === 'string') {
        return [{ kind: 'session', sessionId: m.session_id }]
      }
      return []
    }
    case 'assistant': {
      const events: UiEvent[] = []
      const message = (m.message ?? {}) as Record<string, unknown>
      const blocks = Array.isArray(message.content) ? message.content : []
      // CLI は回線断などの API の失敗を「assistant の文」＋ error 区分（server_error・unknown）で返す。
      // 文を捨てて区分だけ出すと原因（ホスト名・符号）が画面から消えるので、この2区分だけは文を error にする。
      // 認証・課金・上限などの区分は、後段（請求の判定など）が日本語の固定文に頼るので変えない。
      const errorCode = typeof m.error === 'string' ? m.error : null
      const carriesText = errorCode === 'server_error' || errorCode === 'unknown'
      // 失敗の assistant の文は、どの区分でも SDK の原文。error に載せ（server_error・unknown は文そのもの、
      // 他の区分は日本語の文の詳細へ）、同じ文を text の吹き出しとして重ねて出さない（失敗の吹き出しは1つ）。
      const sdkText = errorCode !== null ? textOfBlocks(blocks) : ''
      const errorText = carriesText ? sdkText : ''
      if (errorCode !== null) {
        events.push({
          kind: 'error',
          message: carriesText ? assistantErrorMessage(errorCode, errorText) : assistantErrorWithSdkText(errorCode, sdkText),
        })
      }
      for (const raw of blocks) {
        const block = raw as Record<string, unknown>
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          if (!sdkText) events.push({ kind: 'text', text: block.text })
        } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
          events.push({ kind: 'tool', name: block.name, detail: describeToolDetail(block.name, block.input) })
        }
      }
      return events
    }
    case 'result': {
      const events: UiEvent[] = []
      const isError = !!m.is_error
      const errorStrings = isError && Array.isArray(m.errors) ? errorStringsOf(m.errors) : []
      if (errorStrings.length) {
        events.push({ kind: 'error', message: errorStrings.join('\n') })
      } else if (isError) {
        // errors が無い・空・文字列でない値だけの失敗。以前は「エラー: 」だけ（または何も）が画面に出た。
        events.push({ kind: 'error', message: resultErrorMessage(m.subtype, m.result) })
      }
      events.push({
        kind: 'result',
        costUsd: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : 0,
        durationMs: typeof m.duration_ms === 'number' ? m.duration_ms : 0,
        isError,
      })
      return events
    }
    default:
      return []
  }
}
