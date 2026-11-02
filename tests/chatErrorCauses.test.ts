import { describe, it, expect } from 'vitest'
import { formatChatError } from '../src/shared/aiToolsCore'
import { isConnectionFailure, isConnectionFailureMessage } from '../src/shared/connectionFailure'
import { describeSakuraError } from '../src/main/ipc/sakura'

// チャットの失敗の文を、原因ごとに分ける。回線が切れただけで英語の生文と「キーを確認」の案内が出ていた。
// 実際に届く形の message で、文を完全一致で固定する。

const CONNECTION = 'インターネットに接続できませんでした。接続を確かめてから、もう一度送信してください。'
const FORBIDDEN = 'APIキーに、この操作の権限がありませんでした（403）。認証情報（🔑）でキーを確かめるか、別のモデルを選んでください。'
const NOT_FOUND = '選んでいるモデルが見つかりませんでした（404）。モデルを選び直してから、もう一度送信してください。'
const SERVER = 'AI のサービス側で一時的な問題が起きています。しばらく待ってから、もう一度送信してください。'
const CLAUDE = 'Claude が正常に動きませんでした。Koto を再起動してから、もう一度送信してください。'
const CLAUDE_KEY_401 =
  'Claude のAPIキーが認証されませんでした（401）。キーが期限切れ・失効した可能性があります。\n\n' +
  '🔑 メニュー「Koto」→「認証情報（APIキー）…」（⇧⌘,）で「Claude」のキーを確認し、\n' +
  'うまくいかない場合は Claude Console（platform.claude.com）でキーを再発行して入れ直してください。\n' +
  '（「🔌 接続テスト」で有効かどうか確認できます）'
const FALLBACK_SAKURA = (msg: string): string =>
  `エラー: ${msg}\n\n💡 うまくいかないときは: もう一度送信するか、認証情報（🔑）でAPIキーと利用上限を確認してください。`
const SDK_PATH = '/Applications/Koto.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk/cli.js'

const ENGINES = ['sakura', 'claude'] as const

describe('formatChatError - 回線断', () => {
  const messages = [
    'Connection error.', // openai SDK の APIConnectionError
    'fetch failed',
    'getaddrinfo ENOTFOUND api.ai.sakura.ad.jp',
    'connect ECONNREFUSED 127.0.0.1:443',
    'read ECONNRESET',
    'connect ETIMEDOUT 203.0.113.5:500', // アドレス・ホスト名の数字は状態番号に数えない
    'connect ECONNREFUSED 127.0.0.1:403',
    'connect ECONNREFUSED 127.0.0.1:404',
    'connect ECONNREFUSED [::1]:404',
    'connect ECONNREFUSED fe80::404',
    'getaddrinfo ENOTFOUND node-500.example.com',
    'getaddrinfo ENOTFOUND api-403.example.com',
    'getaddrinfo EAI_AGAIN x',
    'NetworkError when attempting to fetch resource.',
    "Error invoking remote method 'x': Error: Connection error.",
  ]
  for (const msg of messages) {
    for (const engine of ENGINES) {
      it(`${engine}: ${msg}`, () => {
        expect(formatChatError(msg, engine)).toBe(CONNECTION)
      })
    }
  }
})

describe('formatChatError - 403', () => {
  for (const msg of ['403 Forbidden', '403 {"type":"error","error":{"type":"permission_error","message":"..."}}', 'Forbidden', '{"type":"permission_error"}', 'API Error: 403']) {
    for (const engine of ENGINES) {
      it(`${engine}: ${msg}`, () => {
        expect(formatChatError(msg, engine)).toBe(FORBIDDEN)
      })
    }
  }
})

describe('formatChatError - 404', () => {
  for (const msg of ['404 The model `foo` does not exist', '404 {"type":"error","error":{"type":"not_found_error","message":"model: x"}}', 'model_not_found', '{"type":"not_found_error"}']) {
    for (const engine of ENGINES) {
      it(`${engine}: ${msg}`, () => {
        expect(formatChatError(msg, engine)).toBe(NOT_FOUND)
      })
    }
  }
})

describe('formatChatError - 500 番台', () => {
  const messages = [
    '500 Internal Server Error', '502 Bad Gateway', '503 Service Unavailable', '504 Gateway Timeout',
    'Internal Server Error', 'Bad Gateway', 'Service Unavailable', 'Gateway Timeout', // 番号の無い語だけ
    'API Error: 500', 'API Error: 502', 'API Error: 503', 'API Error: 504', // 番号だけ
  ]
  for (const msg of messages) {
    for (const engine of ENGINES) {
      it(`${engine}: ${msg}`, () => {
        expect(formatChatError(msg, engine)).toBe(SERVER)
      })
    }
  }
})

describe('formatChatError - Claude が正常に動かなかった（Agent SDK の例外文）', () => {
  const messages = [
    `Claude Code executable not found at ${SDK_PATH}. Is options.pathToClaudeCodeExecutable set?`,
    `Claude Code executable at ${SDK_PATH} exists but failed to launch.`,
    `Claude Code native binary not found at ${SDK_PATH}. Please ensure Claude Code is installed via native installer or specify …`,
    `Claude Code native binary at ${SDK_PATH} exists but failed to launch. This usually means the binary does not match this sy…`,
    'Claude Code process exited with code 1',
    'Claude Code process exited with code 1: something unrelated on stderr', // 末尾にどの原因も無ければ Claude の文
    'Claude Code process terminated by signal SIGKILL',
    'Claude Code process: spawn ENOENT',
  ]
  for (const msg of messages) {
    for (const engine of ENGINES) {
      it(`${engine}: ${msg.slice(0, 50)}`, () => {
        expect(formatChatError(msg, engine)).toBe(CLAUDE)
      })
    }
  }
})

describe('formatChatError - Claude の例外文の末尾に原因があれば、その原因の文を先に出す', () => {
  it('404', () => {
    expect(formatChatError('Claude Code process exited with code 1: API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: x"}}', 'claude')).toBe(NOT_FOUND)
  })

  it('403', () => {
    expect(formatChatError('Claude Code process exited with code 1: API Error: 403 Forbidden', 'claude')).toBe(FORBIDDEN)
  })

  it('回線断', () => {
    expect(formatChatError('Claude Code process exited with code 1: Connection error.', 'claude')).toBe(CONNECTION)
  })

  it('500 番台', () => {
    expect(formatChatError('Claude Code process exited with code 1: 503 Service Unavailable', 'claude')).toBe(SERVER)
  })

  it('401 は既存の Claude 向けの文', () => {
    expect(formatChatError('Claude Code process exited with code 1: Invalid API key', 'claude')).toBe(CLAUDE_KEY_401)
  })
})

describe('formatChatError - 新しい5つの文に入れないもの', () => {
  const sentences = { CONNECTION, FORBIDDEN, NOT_FOUND, SERVER, CLAUDE }
  for (const [name, s] of Object.entries(sentences)) {
    it(`${name}: 英語の原文・パス・製品名・受け皿の見出しを含まない`, () => {
      for (const bad of ['Claude Code', '/Applications', 'app.asar', 'Connection error', 'エラー:']) {
        expect(s).not.toContain(bad)
      }
    })
    if (name !== 'FORBIDDEN') {
      it(`${name}: キーの案内を含まない（キーの案内は 401 と 403 だけ）`, () => {
        expect(s).not.toContain('🔑')
        expect(s).not.toContain('認証情報')
      })
    }
  }
})

describe('formatChatError - 分岐の順序', () => {
  it('状態番号のある失敗は、本文に network があっても回線断にしない（500 番台）', () => {
    expect(formatChatError('503 upstream connect error ... network')).toBe(SERVER)
  })

  it('401 は既存の文のまま（本文に network があっても）', () => {
    expect(formatChatError('401 Unauthorized ... network')).toBe(
      'APIキーが認証されませんでした（401）。キーが期限切れ・失効した可能性があります。\n\n' +
      '🔑 メニュー「Koto」→「認証情報（APIキー）…」（⇧⌘,）で「さくらのAI Engine」のキーを確認し、\n' +
      'うまくいかない場合は さくらのAI Engine でキーを再発行して入れ直してください。\n' +
      '（「🔌 接続テスト」で有効かどうか確認できます）',
    )
  })

  it('429 は既存の文のまま', () => {
    expect(formatChatError('429 Too Many Requests')).toBe('混み合っています。少し待ってから、もう一度送信してください。')
  })

  it('403 と 404 が両方出ていれば 403 を先に見る', () => {
    expect(formatChatError('403 Forbidden: model not_found_error')).toBe(FORBIDDEN)
  })
})

describe('formatChatError - 状態番号で始まる失敗は、本文に network があっても回線断にしない', () => {
  it('SDK の形（400 から始まる）', () => {
    const msg = '400 Bad request: network parameter invalid'
    expect(formatChatError(msg)).toBe(FALLBACK_SAKURA(msg))
  })

  it('IPC で包まれた形（Error: 400）', () => {
    const msg = "Error invoking remote method 'x': Error: 400 network parameter invalid"
    expect(formatChatError(msg)).toBe(FALLBACK_SAKURA(msg))
  })
})

describe('formatChatError - 受け皿は変わらない', () => {
  it('どれにも当たらない文は、原文＋キー確認の案内のまま（さくら）', () => {
    expect(formatChatError('something odd happened')).toBe(
      'エラー: something odd happened\n\n💡 うまくいかないときは: もう一度送信するか、認証情報（🔑）でAPIキーと利用上限を確認してください。',
    )
  })

  it('どれにも当たらない文は、原文＋キー確認の案内のまま（Claude）', () => {
    expect(formatChatError('something odd happened', 'claude')).toBe(
      'エラー: something odd happened\n\n💡 うまくいかないときは: もう一度送信するか、認証情報（🔑）でClaude のAPIキーを確認してください。',
    )
  })
})

describe('isConnectionFailure - 投げられた値から回線断を見分ける', () => {
  it('message に回線断の語がある', () => {
    expect(isConnectionFailure({ message: 'Connection error.' })).toBe(true)
  })

  for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN']) {
    it(`cause.code が ${code}`, () => {
      expect(isConnectionFailure({ cause: { code }, message: 'x' })).toBe(true)
    })

    it(`code が ${code}`, () => {
      expect(isConnectionFailure({ code, message: 'x' })).toBe(true)
    })
  }

  it('HTTP の応答が返った失敗（status が数値）は、本文に network があっても回線断ではない', () => {
    expect(isConnectionFailure({ status: 502, message: '502 Bad Gateway: upstream network error' })).toBe(false)
  })

  it('status が数値なら、errno 名があっても回線断ではない', () => {
    expect(isConnectionFailure({ status: 503, code: 'ECONNRESET', message: 'x' })).toBe(false)
  })

  it('状態番号だけのサービス側の失敗は回線断ではない', () => {
    expect(isConnectionFailure({ status: 500, message: 'Internal Server Error' })).toBe(false)
  })

  it('null・空文字は回線断ではない', () => {
    expect(isConnectionFailure(null)).toBe(false)
    expect(isConnectionFailure('')).toBe(false)
  })

  it('文字列そのものが投げられた場合も文面で見分ける', () => {
    expect(isConnectionFailure('fetch failed')).toBe(true)
  })

  it('isConnectionFailureMessage は errno 名・SDK の文・fetch の文に当たる', () => {
    for (const s of ['Connection error.', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'fetch failed', 'Network request failed']) {
      expect(isConnectionFailureMessage(s)).toBe(true)
    }
    expect(isConnectionFailureMessage('500 Internal Server Error')).toBe(false)
  })

  it('isConnectionFailureMessage: 状態番号で始まる文面は回線断ではない（行頭・SDK の API Error: ・IPC の Error: 、先頭の空白も）', () => {
    expect(isConnectionFailureMessage('API Error: 400 network')).toBe(false)
    expect(isConnectionFailureMessage('400 Bad request: network parameter invalid')).toBe(false)
    expect(isConnectionFailureMessage("Error invoking remote method 'x': Error: 400 network parameter invalid")).toBe(false)
    expect(isConnectionFailureMessage('  404 network not found')).toBe(false)
  })

  it('isConnectionFailureMessage: アドレスの数字は状態番号に数えない', () => {
    expect(isConnectionFailureMessage('connect ECONNREFUSED 127.0.0.1:443')).toBe(true)
    expect(isConnectionFailureMessage('connect ETIMEDOUT 203.0.113.5:500')).toBe(true)
  })
})

describe('describeSakuraError - 接続テストも同じ回線断の判定を使う', () => {
  it('SDK の Connection error. は「インターネット接続を確認してください」（以前は「接続テストに失敗しました: Connection error.」）', () => {
    expect(describeSakuraError({ message: 'Connection error.' })).toBe('インターネット接続を確認してください')
  })

  it('ECONNRESET も回線断', () => {
    expect(describeSakuraError({ code: 'ECONNRESET', message: 'x' })).toBe('インターネット接続を確認してください')
  })

  it('401 は既存の文のまま', () => {
    expect(describeSakuraError({ status: 401 })).toBe('APIキーが正しくないようです。コピーし直して貼り付けてください')
  })

  it('cause.code が ETIMEDOUT でも回線断', () => {
    expect(describeSakuraError({ message: 'x', cause: { code: 'ETIMEDOUT' } })).toBe('インターネット接続を確認してください')
  })

  it('HTTP の応答が返った失敗は、本文に network があっても回線断にしない（502）', () => {
    expect(describeSakuraError({ status: 502, message: '502 Bad Gateway: upstream network error' })).toBe(
      '接続テストに失敗しました: 502 Bad Gateway: upstream network error',
    )
  })

  it('HTTP の応答が返った失敗は、本文に network があっても回線断にしない（404）', () => {
    expect(describeSakuraError({ status: 404, message: '404 network not found' })).toBe('接続テストに失敗しました: 404 network not found')
  })
})
