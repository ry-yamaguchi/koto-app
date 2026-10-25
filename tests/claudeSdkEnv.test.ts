// tests/claudeSdkEnv.test.ts — SDK（claude の実行ファイル）へ渡す環境から、親の Claude の印を外す。
//
// 実機（2026-10-24）: Koto を Claude Code（デスクトップ）の会話の中から起動すると、親の
// CLAUDECODE=1・CLAUDE_CODE_ENTRYPOINT=claude-desktop・ANTHROPIC_BASE_URL など31個が Koto に入り、
// agent.ts の env がそのまま SDK へ渡っていた。SDK は CLAUDE_CODE_ENTRYPOINT が既にあると自分の印 'sdk-ts' を
// 付けず、Anthropic 側から Claude Code の利用に見えて、Max プランの API クレジットが使えなかった。
//
// 1. claudeSdkEnv（純関数）の振る舞い
// 2. startClaudeChat が、その関数の結果を実際に query() の options.env へ渡していること（偽の SDK が受け取ったもの）
//    ＝「守りの関数は正しいのに呼ばれていない」を防ぐ（掟10）

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../src/main/ipc/sakura', () => ({
  sakuraClient: () => ({ chat: { completions: { create: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '' } }], usage: { prompt_tokens: 0, completion_tokens: 0 } }) } } }),
  isContextLimitError: () => false,
  safeMaxTokens: () => null,
}))
vi.mock('../src/main/ipc/web', () => ({ fetchUrlPage: async () => { throw new Error('このテストでは使わない') } }))

import { claudeSdkEnv } from '../src/main/claude/sdkEnv'
import { startClaudeChat, type ClaudeSdkModule } from '../src/main/claude/agent'
import type { UiEvent } from '../src/main/claude/events'

/** 実機で Koto に入っていた形に近い親の環境（Claude Code デスクトップの会話の中から起動した場合）。 */
function parentEnvFromClaudeDesktop(): NodeJS.ProcessEnv {
  return {
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
    CLAUDE_CODE_OAUTH_SCOPES: 'user:inference user:profile',
    CLAUDE_CODE_SESSION_ID: 'parent-session-1234',
    CLAUDE_AGENT_SDK_VERSION: '0.9.9',
    ANTHROPIC_BASE_URL: 'https://proxy.example.invalid',
    ANTHROPIC_AUTH_TOKEN: 'parent-token',
    ANTHROPIC_API_KEY: 'parent-api-key',
    PATH: '/usr/bin:/bin',
    HOME: '/Users/someone',
    LANG: 'ja_JP.UTF-8',
  }
}

describe('claudeSdkEnv: 親の環境から Claude の印・宛先・別の認証を外す', () => {
  it('★★★ 親の Claude の印と ANTHROPIC_BASE_URL は結果に無く、ANTHROPIC_API_KEY は渡したキー、PATH・HOME は残る', () => {
    const env = claudeSdkEnv(parentEnvFromClaudeDesktop(), 'koto-user-key')
    expect(env.CLAUDECODE).toBeUndefined()
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined() // 自分では入れない（SDK が 'sdk-ts' を入れる）
    expect(env.CLAUDE_CODE_OAUTH_SCOPES).toBeUndefined()
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined()
    expect(env.CLAUDE_AGENT_SDK_VERSION).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBe('koto-user-key') // 親の値ではなく、渡したキー
    expect(env.PATH).toBe('/usr/bin:/bin')
    expect(env.HOME).toBe('/Users/someone')
    expect(env.LANG).toBe('ja_JP.UTF-8')
  })

  it('CLAUDE_CODE_ENTRYPOINT を結果に入れない（親に無くても・親にあっても。印を付けるのは SDK）', () => {
    expect('CLAUDE_CODE_ENTRYPOINT' in claudeSdkEnv({ PATH: '/bin' }, 'k')).toBe(false)
    expect('CLAUDE_CODE_ENTRYPOINT' in claudeSdkEnv({ CLAUDE_CODE_ENTRYPOINT: 'cli', PATH: '/bin' }, 'k')).toBe(false)
  })

  it('外すのは CLAUDECODE・CLAUDE_CODE_*・CLAUDE_AGENT_SDK_*・ANTHROPIC_* だけ（ほかの CLAUDE_ や似た名前は残す）', () => {
    const env = claudeSdkEnv({
      CLAUDE_CONFIG_DIR: '/x/claude', // CLAUDE_ で始まるが CLAUDE_CODE_ ではない
      CLAUDECODEX: 'keep', // CLAUDECODE そのものではない
      MY_ANTHROPIC_NOTE: 'keep', // ANTHROPIC_ で始まらない
      CLAUDE_CODE_USE_BEDROCK: '1',
      ANTHROPIC_MODEL: 'x',
      NODE_ENV: 'production',
    }, 'k')
    expect(env.CLAUDE_CONFIG_DIR).toBe('/x/claude')
    expect(env.CLAUDECODEX).toBe('keep')
    expect(env.MY_ANTHROPIC_NOTE).toBe('keep')
    expect(env.NODE_ENV).toBe('production')
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
    expect(env.ANTHROPIC_MODEL).toBeUndefined()
  })

  it('値が undefined のものは落とす・親の環境を書き換えない', () => {
    const parent: NodeJS.ProcessEnv = { PATH: '/bin', EMPTY: undefined, CLAUDECODE: '1' }
    const env = claudeSdkEnv(parent, 'k')
    expect('EMPTY' in env).toBe(false)
    expect(Object.values(env).every(v => typeof v === 'string')).toBe(true)
    expect(parent.CLAUDECODE).toBe('1') // 親は触らない
    expect(Object.keys(parent).sort()).toEqual(['CLAUDECODE', 'EMPTY', 'PATH'])
  })
})

// ══ startClaudeChat が query() へ実際にこの環境を渡している ═══════════════════════════════

describe('startClaudeChat: query() の options.env は claudeSdkEnv の結果（偽の SDK が受け取ったもの）', () => {
  let projectDir = ''
  let writeRoot = ''
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-claude-sdkenv-'))
    writeRoot = path.join(projectDir, 'public')
    fs.mkdirSync(writeRoot, { recursive: true })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it('★★★ 親（この process.env）に Claude の印があっても、SDK へ渡る env には無い・キーは渡したもの・PATH は残る', async () => {
    vi.stubEnv('CLAUDECODE', '1')
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'claude-desktop')
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'parent-session-1234')
    vi.stubEnv('CLAUDE_AGENT_SDK_VERSION', '0.9.9')
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://proxy.example.invalid')
    vi.stubEnv('ANTHROPIC_API_KEY', 'parent-api-key')
    vi.stubEnv('PATH', '/usr/bin:/bin')

    const queries: { options: Record<string, any> }[] = []
    const sdk = {
      query: (arg: { options: Record<string, any> }) => {
        queries.push(arg)
        return (async function* () {
          yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, duration_ms: 1 }
        })()
      },
      tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
      createSdkMcpServer: (opts: any) => ({ type: 'sdk', name: opts.name, instance: {}, tools: opts.tools }),
    } as unknown as ClaudeSdkModule

    let finish!: () => void
    const finished = new Promise<void>(r => { finish = r })
    const events: UiEvent[] = []
    startClaudeChat({
      projectDir, writeRoot, apiKey: 'koto-user-key', writeMode: 'auto', aiEngineKey: null,
      prompt: 'こんにちは', images: [], snapshotId: '2026-10-24T00-00-00-000Z', resumeSessionId: null, model: '',
      onEvent: e => { events.push(e); if (e.kind === 'result' || e.kind === 'error') finish() },
      onOpenPreview: () => {}, ragBudgetCheck: () => ({ allowed: true }), onDelegated: () => {}, onFileWritten: () => {},
    }, sdk)
    await finished

    expect(queries).toHaveLength(1)
    const env = queries[0].options.env as Record<string, string>
    expect(env).toBeTruthy()
    for (const name of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_AGENT_SDK_VERSION', 'ANTHROPIC_BASE_URL']) {
      expect(name in env, `${name} が SDK へ渡る env に残っている`).toBe(false)
    }
    expect(env.ANTHROPIC_API_KEY).toBe('koto-user-key')
    expect(env.PATH).toBe('/usr/bin:/bin')
  })
})
