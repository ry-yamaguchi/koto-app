// sdkEnv.ts — Agent SDK（claude の実行ファイル）へ渡す環境変数を作る純関数（Electron 非依存）。
//
// 親の環境の Claude の印（CLAUDE_CODE_ENTRYPOINT など）を引き継ぐと、SDK が自分の印 'sdk-ts' を付けず、
// Anthropic 側で Claude Code の利用に見える（2026-10-24 の実機）。
//
// 実機: Koto を Claude Code（デスクトップ）の会話の中から起動すると、親の CLAUDECODE=1・
// CLAUDE_CODE_ENTRYPOINT=claude-desktop・CLAUDE_CODE_OAUTH_SCOPES・CLAUDE_CODE_SESSION_ID・
// CLAUDE_AGENT_SDK_VERSION・ANTHROPIC_BASE_URL など31個が Koto の process.env に入り、そのまま SDK へ渡っていた。
// SDK は CLAUDE_CODE_ENTRYPOINT が既にあると自分の印を付けない（sdk.mjs の
// 「if(!c.CLAUDE_CODE_ENTRYPOINT)c.CLAUDE_CODE_ENTRYPOINT="sdk-ts"」）。Anthropic 側からは Claude Code の
// 利用に見え、Max プランの API クレジット（Agent SDK には使えるが Claude Code には使えない）が使えず
// 「Credit balance is too low」になった。印を外して起動し直すと、同じキーで普通に動いた。
// Finder・Dock から開く普段の使い方では起きない（ターミナルから開いたときに起きうる）。
//
// ここでは「親の環境から外すもの」をこの1か所に定義する。CLAUDE_CODE_ENTRYPOINT は**自分では入れない**
// （SDK が 'sdk-ts' を入れる）。

/**
 * 親の環境から引き継がない名前か。
 * - CLAUDECODE（Claude Code の中で動いている印）と CLAUDE_CODE_ で始まるもの（ENTRYPOINT・SESSION_ID・OAUTH_SCOPES など）
 * - CLAUDE_AGENT_SDK_ で始まるもの（SDK 自身の印。SDK が自分で入れ直す）
 * - ANTHROPIC_ で始まるもの（ANTHROPIC_BASE_URL・ANTHROPIC_AUTH_TOKEN など。Koto は BYO の API キーで
 *   api.anthropic.com だけと話すので、親の宛先・別の認証を引き継がない）
 */
export function isParentClaudeEnvName(name: string): boolean {
  const n = name.toUpperCase()
  return n === 'CLAUDECODE' || n.startsWith('CLAUDE_CODE_') || n.startsWith('CLAUDE_AGENT_SDK_') || n.startsWith('ANTHROPIC_')
}

/**
 * SDK の query() の options.env に渡す環境を作る。親の環境から Claude の印・宛先・別の認証を外して写し、
 * 最後に ANTHROPIC_API_KEY=apiKey を入れる。PATH・HOME など他はそのまま。値が undefined のものは落とす。
 * （SDK は options.env を process.env へ**マージせず丸ごと置き換える**ので、必要なものは自分で写す。）
 */
export function claudeSdkEnv(parentEnv: NodeJS.ProcessEnv, apiKey: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue
    if (isParentClaudeEnvName(name)) continue
    env[name] = value
  }
  env.ANTHROPIC_API_KEY = apiKey
  return env
}
