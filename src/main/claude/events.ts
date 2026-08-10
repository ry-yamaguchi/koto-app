// events.ts — Agent SDK のストリームメッセージ（SDKMessage）を、UI が扱いやすい単純なイベントへ
// マッピングする純粋関数。C2a の中核（agent.ts から呼ばれる／Vitest で単体テスト対象）。
//
// ※型について: SDKMessage の実体（SDKAssistantMessage.message は BetaMessage）は
//   `@anthropic-ai/sdk` の型（claude-agent-sdk の peerDependency・本プロジェクトには devDependency
//   として入れていない）に依存しており、tsconfig の skipLibCheck 環境では解決できず事実上 any 化される。
//   そのため本ファイルではブロックの中身を実行時に安全にチェックする防御的な実装にしてある
//   （型に頼らず `typeof` / `Array.isArray` 等で確認してから使う）。

export type UiEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; detail: string }
  | { kind: 'result'; costUsd: number; durationMs: number; isError: boolean }
  | { kind: 'error'; message: string }
  // C2b: open_preview ツールの副作用通知。mapSdkMessage からではなく、MCPツールのハンドラ実行時に
  // ipc/claude.ts が発行する（renderer は従来の open_preview ツールと同じ処理で既定ブラウザを開く）
  | { kind: 'openPreview'; path: string }
  // C3: delegate_implementation の実行後。mapSdkMessage からではなく、ipc/claude.ts が
  // tools.ts の onDelegated コールバックから発行する（renderer は AI Engine 側のusageとして記録する）。
  | { kind: 'delegated'; model: string; promptTokens: number; completionTokens: number }
  // Edit/Write・委譲書き込みの成功後（データ喪失バグ修正・2026-07-11）。mapSdkMessage からではなく、
  // agent.ts の PostToolUse フック／tools.ts の委譲書き込みから ipc/claude.ts が発行する。
  // renderer は該当パスの開きタブをディスクから読み直す（stale tab のオートセーブ上書き防止）。
  | { kind: 'fileWritten'; path: string }

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
      // C2b/C3: IDE固有MCPツール（修飾名 mcp__ide__fetch_url / mcp__ide__search_docs /
      // mcp__ide__open_preview / mcp__ide__delegate_implementation）。
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
    billing_error: '請求設定に問題があります（Anthropic Console を確認してください）。',
    rate_limit: 'リクエストが多すぎます。しばらく待ってからもう一度お試しください。',
    overloaded: 'Anthropic側が混雑しています。しばらく待ってからもう一度お試しください。',
    invalid_request: 'リクエストが不正です。',
    model_not_found: '指定したモデルが見つかりません。',
    server_error: 'Anthropic側でエラーが発生しました。',
    max_output_tokens: '出力の上限に達したため打ち切られました。',
  }
  return table[code] ?? `エラーが発生しました（${code}）`
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
      if (typeof m.error === 'string') {
        events.push({ kind: 'error', message: describeAssistantError(m.error) })
      }
      const message = (m.message ?? {}) as Record<string, unknown>
      const blocks = Array.isArray(message.content) ? message.content : []
      for (const raw of blocks) {
        const block = raw as Record<string, unknown>
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          events.push({ kind: 'text', text: block.text })
        } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
          events.push({ kind: 'tool', name: block.name, detail: describeToolDetail(block.name, block.input) })
        }
      }
      return events
    }
    case 'result': {
      const events: UiEvent[] = []
      const isError = !!m.is_error
      if (isError && Array.isArray(m.errors) && m.errors.length) {
        events.push({ kind: 'error', message: (m.errors as unknown[]).filter(e => typeof e === 'string').join('\n') })
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
