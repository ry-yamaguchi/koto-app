import { describe, it, expect } from 'vitest'
import OpenAI from 'openai'
import { formatChatError } from '../src/shared/aiToolsCore'
import { failureText } from '../src/shared/failureText'
import { splitFailureDetail } from '../src/shared/failureDetail'
import { describeAssistantError } from '../src/main/claude/events'
import { describeClaudeError } from '../src/main/claude/client'
import { isConnectionFailure, isConnectionFailureMessage } from '../src/shared/connectionFailure'
import { describeSakuraError } from '../src/main/ipc/sakura'

// チャットの失敗の文を、原因ごとに分ける。回線が切れただけで英語の生文と「キーを確認」の案内が出ていた。
// 実際に届く形の message で、文を完全一致で固定する。

const CONNECTION = 'インターネットに接続できませんでした。接続を確かめてから、もう一度送信してください。'
const FORBIDDEN = 'APIキーに、この操作の権限がありませんでした（403）。認証情報（🔑）でキーを確かめるか、別のモデルを選んでください。'
const NOT_FOUND = '選んでいるモデルが見つかりませんでした（404）。モデルを選び直してから、もう一度送信してください。'
const SERVER = 'AI のサービス側で一時的な問題が起きています。しばらく待ってから、もう一度送信してください。'
const CLAUDE = 'Claude が正常に動きませんでした。Koto を再起動してから、もう一度送信してください。'
// 共通の層（shared/failureText.ts）の文を、チャットの言い方（もう一度送信してください）にしたもの
const TIMEOUT = '時間内に返事がありませんでした。混み合っているかもしれません。少し待ってから、もう一度送信してください。'
const TLS = '安全な接続を確認できませんでした。社内ネットワークやセキュリティソフトの設定を確かめてください。'
const CLAUDE_KEY_401 =
  'Claude のAPIキーが認証されませんでした（401）。キーが期限切れ・失効した可能性があります。\n\n' +
  '🔑 メニュー「Koto」→「認証情報（APIキー）…」（⇧⌘,）で「Claude」のキーを確認し、\n' +
  'うまくいかない場合は Claude Console（platform.claude.com）でキーを再発行して入れ直してください。\n' +
  '（「🔌 接続テスト」で有効かどうか確認できます）'
const FALLBACK_SAKURA = (msg: string): string =>
  `エラー: ${msg}\n\n💡 うまくいかないときは: もう一度送信するか、認証情報（🔑）でAPIキーと利用上限を確認してください。`
const SDK_PATH = '/Applications/Koto.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk/cli.js'

const ENGINES = ['sakura', 'claude'] as const

// 日本語に置き換えた文は、最後の行に「詳細: 原文」が付く。文の比べは詳細を除いた本文で行い、詳細は別に固める。
const fmt = (...args: Parameters<typeof formatChatError>): string => splitFailureDetail(formatChatError(...args)).text

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
    "Error invoking remote method 'x': TypeError: fetch failed", // 頭の型名が Error: 以外
    'net::ERR_INTERNET_DISCONNECTED',
    'request to https://api.ai.sakura.ad.jp/v1/chat/completions failed, reason: getaddrinfo ENOTFOUND api.ai.sakura.ad.jp', // node-fetch の文面
  ]
  for (const msg of messages) {
    for (const engine of ENGINES) {
      it(`${engine}: ${msg}`, () => {
        expect(fmt(msg, engine)).toBe(CONNECTION)
      })
    }
  }
})

// 時間切れ・安全な接続は、接続テストと同じ共通の層（shared/failureText.ts）が見分ける。
// 以前は「エラー: Request timed out.」と、無関係な「キーを確認」の案内がそのまま出ていた。
describe('formatChatError - 時間切れ・安全な接続', () => {
  // 本物の例外の文面（openai SDK の構成子が作る message・AbortSignal.timeout が作る DOMException の message）
  const sdkTimeout = new OpenAI.APIConnectionTimeoutError({}).message
  const sdkConnection = new OpenAI.APIConnectionError({}).message
  const domTimeout = async (): Promise<string> => {
    const signal = AbortSignal.timeout(5)
    await new Promise(resolve => setTimeout(resolve, 40))
    return String((signal.reason as Error).message)
  }

  it('本物の例外の文面を確かめる（SDK の時間切れ・回線断・TimeoutError）', async () => {
    expect(sdkTimeout).toBe('Request timed out.')
    expect(sdkConnection).toBe('Connection error.')
    expect(await domTimeout()).toBe('The operation was aborted due to timeout')
  })

  const timeouts = [
    'Request timed out.',
    'The operation was aborted due to timeout', // 中断の語を含むが、時間切れ（中断より先に見る）
    "Error invoking remote method 'x': Error: Request timed out.",
    "Error invoking remote method 'x': TypeError: The operation was aborted due to timeout",
    "Error invoking remote method 'x': TypeError: Request timed out.", // 頭の型名が Error: 以外でも、頭を落としてから見る
  ]
  for (const msg of timeouts) {
    for (const engine of ENGINES) {
      it(`${engine}: ${msg}`, () => {
        expect(fmt(msg, engine)).toBe(TIMEOUT)
      })
    }
  }

  const tlsMessages = ['net::ERR_CERT_AUTHORITY_INVALID', "Error invoking remote method 'x': Error: net::ERR_CERT_DATE_INVALID"]
  for (const msg of tlsMessages) {
    for (const engine of ENGINES) {
      it(`${engine}: ${msg}`, () => {
        expect(fmt(msg, engine)).toBe(TLS)
      })
    }
  }

  it('SDK の本物の message でも同じ（時間切れ・回線断）', async () => {
    expect(fmt(sdkTimeout)).toBe(TIMEOUT)
    expect(fmt(await domTimeout())).toBe(TIMEOUT)
    expect(fmt(sdkConnection)).toBe(CONNECTION)
  })

  it('★ 文は共通の層（failureText）の文に、チャットの言い方を渡したものと同じ', () => {
    const chat = { readOnly: true, tail: 'もう一度送信してください' }
    expect(fmt('Request timed out.')).toBe(splitFailureDetail(failureText('Request timed out.', chat)).text)
    expect(fmt('net::ERR_CERT_AUTHORITY_INVALID')).toBe(splitFailureDetail(failureText('net::ERR_CERT_AUTHORITY_INVALID', chat)).text)
    expect(fmt('Connection error.')).toBe(splitFailureDetail(failureText('Connection error.', chat)).text)
  })

  it('★ errno 名で見分けた切れ・時間切れ（つなぐ段の失敗）は、これまでどおり「接続できませんでした」', () => {
    expect(fmt('connect ETIMEDOUT 203.0.113.5:443')).toBe(CONNECTION)
    expect(fmt('read ECONNRESET')).toBe(CONNECTION)
    expect(fmt('net::ERR_CONNECTION_TIMED_OUT')).toBe(CONNECTION)
  })

  it('★ 状態番号で始まる失敗は、本文に time out の文があっても時間切れにしない（500 番台の文）', () => {
    expect(fmt('504 The operation was aborted due to timeout')).toBe(SERVER)
    expect(fmt("Error invoking remote method 'x': Error: 504 The operation was aborted due to timeout")).toBe(SERVER)
  })

  it('★ 中断（⏹ や aborted の文）は通信の失敗として言わない（受け皿のまま）', () => {
    for (const msg of ['Request was aborted.', 'This operation was aborted']) {
      expect(fmt(msg)).toBe(FALLBACK_SAKURA(msg))
    }
  })

  it('★ 日本語を含む文は、時間切れの判定にかけない（受け皿のまま）', () => {
    for (const msg of ['時間切れの文: The operation was aborted due to timeout という文', 'Request timed out. をお知らせします']) {
      expect(fmt(msg)).toBe(FALLBACK_SAKURA(msg))
    }
  })

  it('★ 順序: 429・会話が長すぎる・401 は、時間切れより先（既存の文のまま）', () => {
    expect(fmt('429 Too Many Requests')).toBe('混み合っています。少し待ってから、もう一度送信してください。')
    expect(fmt('401 Unauthorized')).toContain('APIキーが認証されませんでした（401）')
  })

  it('新しい2つの文に、英語の原文・キーの案内・受け皿の見出しを入れない', () => {
    for (const s of [TIMEOUT, TLS]) {
      for (const bad of ['Request timed out', 'timeout', 'エラー:', '🔑', '認証情報', 'Claude Code']) {
        expect(s).not.toContain(bad)
      }
    }
  })
})

// openai の APIConnectionError は message が 'Connection error.' だけで、証明書の失敗などの印は cause の奥（cause.cause.code）にある。
// 文字列だけを渡すと回線断と区別できないので、catch で受けた値そのものを第3引数で渡す（chatTurn.ts の2か所）。
describe('formatChatError - 投げられた値（第3引数）の印を見る', () => {
  // 本物の形: APIConnectionError { cause: TypeError('fetch failed') { cause: Error { code } } }
  const apiConnection = (code: string): Error =>
    new OpenAI.APIConnectionError({ cause: new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) }) })

  it('本物の例外の message は、どの印でも同じ（message だけでは見分けられない）', () => {
    expect(apiConnection('UNABLE_TO_VERIFY_LEAF_SIGNATURE').message).toBe('Connection error.')
    expect(apiConnection('ECONNREFUSED').message).toBe('Connection error.')
  })

  for (const code of ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT']) {
    for (const engine of ENGINES) {
      it(`${engine}: cause の奥が ${code} → 安全な接続の文（回線断の文ではない）`, () => {
        const err = apiConnection(code)
        expect(fmt(err.message, engine, err)).toBe(TLS)
      })
    }
  }

  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN']) {
    it(`cause の奥が ${code} → これまでどおり回線断の文`, () => {
      const err = apiConnection(code)
      expect(fmt(err.message, 'sakura', err)).toBe(CONNECTION)
    })
  }

  it('印の無い APIConnectionError（cause なし）は、これまでどおり回線断の文', () => {
    const err = new OpenAI.APIConnectionError({})
    expect(fmt(err.message, 'sakura', err)).toBe(CONNECTION)
  })

  it('値を渡さない呼び方（文字列だけ）は従来のまま: 証明書の失敗でも message だけなら回線断の文', () => {
    expect(fmt(apiConnection('UNABLE_TO_VERIFY_LEAF_SIGNATURE').message)).toBe(CONNECTION)
  })

  it('★ 値を渡しても、状態番号の失敗・認証・混雑の文は変わらない', () => {
    const e503 = Object.assign(new Error('503 Service Unavailable'), { status: 503 })
    expect(fmt(e503.message, 'sakura', e503)).toBe(SERVER)
    const e401 = Object.assign(new Error('401 Unauthorized'), { status: 401 })
    expect(fmt(e401.message, 'sakura', e401)).toContain('APIキーが認証されませんでした（401）')
    const e429 = Object.assign(new Error('429 Too Many Requests'), { status: 429 })
    expect(fmt(e429.message, 'sakura', e429)).toBe('混み合っています。少し待ってから、もう一度送信してください。')
  })

  it('値が文字列でも壊れない（catch で受けたのが文字列のとき）', () => {
    expect(fmt('Connection error.', 'sakura', 'Connection error.')).toBe(CONNECTION)
    expect(fmt('something odd happened', 'sakura', 'something odd happened')).toBe(FALLBACK_SAKURA('something odd happened'))
  })
})

// 種類が「中断」「時間切れ」に決まっても、同じ文に回線断の語（errno 名・fetch failed など）があれば回線断の文。
// 以前は 'aborted' の語が先に当たって、回線断の文から外れて英語の受け皿になった。
describe('formatChatError - 中断・時間切れの語と回線断の語が同じ文にあるとき', () => {
  for (const msg of ['socket aborted: ECONNRESET', 'fetch failed: The operation was aborted', 'aborted ECONNRESET', 'The operation was aborted due to timeout: network unreachable']) {
    for (const engine of ENGINES) {
      it(`${engine}: ${msg}`, () => {
        expect(fmt(msg, engine)).toBe(CONNECTION)
      })
    }
  }

  it('★ 回線断の語が無ければ、中断は受け皿・時間切れは時間切れの文のまま', () => {
    for (const msg of ['Request was aborted.', 'This operation was aborted', 'socket aborted']) {
      expect(fmt(msg), msg).toBe(FALLBACK_SAKURA(msg))
    }
    expect(fmt('The operation was aborted due to timeout')).toBe(TIMEOUT)
    expect(fmt('Request timed out.')).toBe(TIMEOUT)
  })

  it('★ 安全な接続の失敗は、同じ文に network があっても安全な接続の文（回線断にしない）', () => {
    expect(fmt('net::ERR_CERT_AUTHORITY_INVALID while on the network')).toBe(TLS)
  })
})

// 日本語を含む文（Koto 自身の文・利用者の語を含む文）は、英語の語（network など）だけで回線断にしない。
// 守りは connectionFailure.ts の isJudgeableMessage の1か所で、チャットの網も接続テストの網もそこを通る。
describe('日本語を含む文は、英語の語だけで回線断にしない（チャットも接続テストも）', () => {
  const JP_NETWORK = ['Docker の network が見つかりません', '接続に失敗しました（fetch failed）', 'ネットワークの設定を見直してください。ECONNRESET ではありません']

  for (const msg of JP_NETWORK) {
    for (const engine of ENGINES) {
      it(`チャット ${engine}: ${msg}`, () => {
        expect(fmt(msg, engine)).not.toBe(CONNECTION)
        expect(fmt(msg, engine)).toBe(engine === 'sakura' ? FALLBACK_SAKURA(msg) : `エラー: ${msg}\n\n💡 うまくいかないときは: もう一度送信するか、認証情報（🔑）でClaude のAPIキーを確認してください。`)
      })
    }

    it(`接続テスト: ${msg}`, () => {
      expect(splitFailureDetail(describeSakuraError(new Error(msg))).text).toBe(`接続テストに失敗しました: ${msg}`)
    })
  }

  it('構造の印（code）があれば、日本語の文でも回線断（印は文面より先）', () => {
    const err = Object.assign(new Error('ネットワークが切れました network'), { code: 'ECONNREFUSED' })
    expect(fmt(err.message, 'sakura', err)).toBe(CONNECTION)
    expect(splitFailureDetail(describeSakuraError(err)).text).toBe('インターネットに接続できませんでした。接続を確かめてから、もう一度お試しください。')
  })

  it('英語だけの同じ語は、従来どおり回線断', () => {
    expect(fmt('Docker network is unreachable')).toBe(CONNECTION)
    expect(splitFailureDetail(describeSakuraError(new Error('Docker network is unreachable'))).text).toBe('インターネットに接続できませんでした。接続を確かめてから、もう一度お試しください。')
  })
})

describe('formatChatError - 403', () => {
  for (const msg of ['403 Forbidden', '403 {"type":"error","error":{"type":"permission_error","message":"..."}}', 'Forbidden', '{"type":"permission_error"}', 'API Error: 403']) {
    for (const engine of ENGINES) {
      it(`${engine}: ${msg}`, () => {
        expect(fmt(msg, engine)).toBe(FORBIDDEN)
      })
    }
  }
})

describe('formatChatError - 404', () => {
  for (const msg of ['404 The model `foo` does not exist', '404 {"type":"error","error":{"type":"not_found_error","message":"model: x"}}', 'model_not_found', '{"type":"not_found_error"}']) {
    for (const engine of ENGINES) {
      it(`${engine}: ${msg}`, () => {
        expect(fmt(msg, engine)).toBe(NOT_FOUND)
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
        expect(fmt(msg, engine)).toBe(SERVER)
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
        expect(fmt(msg, engine)).toBe(CLAUDE)
      })
    }
  }
})

describe('formatChatError - Claude の例外文の末尾に原因があれば、その原因の文を先に出す', () => {
  it('404', () => {
    expect(fmt('Claude Code process exited with code 1: API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: x"}}', 'claude')).toBe(NOT_FOUND)
  })

  it('403', () => {
    expect(fmt('Claude Code process exited with code 1: API Error: 403 Forbidden', 'claude')).toBe(FORBIDDEN)
  })

  it('回線断', () => {
    expect(fmt('Claude Code process exited with code 1: Connection error.', 'claude')).toBe(CONNECTION)
  })

  it('500 番台', () => {
    expect(fmt('Claude Code process exited with code 1: 503 Service Unavailable', 'claude')).toBe(SERVER)
  })

  it('401 は既存の Claude 向けの文', () => {
    expect(fmt('Claude Code process exited with code 1: Invalid API key', 'claude')).toBe(CLAUDE_KEY_401)
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
    expect(fmt('503 upstream connect error ... network')).toBe(SERVER)
  })

  it('401 は既存の文のまま（本文に network があっても）', () => {
    expect(fmt('401 Unauthorized ... network')).toBe(
      'APIキーが認証されませんでした（401）。キーが期限切れ・失効した可能性があります。\n\n' +
      '🔑 メニュー「Koto」→「認証情報（APIキー）…」（⇧⌘,）で「さくらのAI Engine」のキーを確認し、\n' +
      'うまくいかない場合は さくらのAI Engine でキーを再発行して入れ直してください。\n' +
      '（「🔌 接続テスト」で有効かどうか確認できます）',
    )
  })

  it('429 は既存の文のまま', () => {
    expect(fmt('429 Too Many Requests')).toBe('混み合っています。少し待ってから、もう一度送信してください。')
  })

  it('403 と 404 が両方出ていれば 403 を先に見る', () => {
    expect(fmt('403 Forbidden: model not_found_error')).toBe(FORBIDDEN)
  })
})

describe('formatChatError - 状態番号で始まる失敗は、本文に network があっても回線断にしない', () => {
  it('SDK の形（400 から始まる）', () => {
    const msg = '400 Bad request: network parameter invalid'
    expect(fmt(msg)).toBe(FALLBACK_SAKURA(msg))
  })

  it('IPC で包まれた形（Error: 400）。原文は IPC の英語の頭を落として出す', () => {
    const msg = "Error invoking remote method 'x': Error: 400 network parameter invalid"
    expect(fmt(msg)).toBe(FALLBACK_SAKURA('400 network parameter invalid'))
  })
})

describe('formatChatError - 受け皿は変わらない', () => {
  it('どれにも当たらない文は、原文＋キー確認の案内のまま（さくら）', () => {
    expect(fmt('something odd happened')).toBe(
      'エラー: something odd happened\n\n💡 うまくいかないときは: もう一度送信するか、認証情報（🔑）でAPIキーと利用上限を確認してください。',
    )
  })

  it('どれにも当たらない文は、原文＋キー確認の案内のまま（Claude）', () => {
    expect(fmt('something odd happened', 'claude')).toBe(
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

// 接続テスト（describeSakuraError）も、同じ共通の層（shared/failureText.ts）を通る。読み取りなので「もう一度お試しください」。
// 本物の例外の形での全部の表は tests/sakuraIpc.test.ts。ここは判定が同じ層を読んでいることを、チャットと並べて固定する。
describe('describeSakuraError - 接続テストも同じ回線断の判定を使う', () => {
  const OFFLINE = 'インターネットに接続できませんでした。接続を確かめてから、もう一度お試しください。'
  const TIMEOUT_TEST = '時間内に返事がありませんでした。混み合っているかもしれません。少し待ってから、もう一度お試しください。'
  const SERVER_TEST = 'さくらのAI Engine 側で一時的な問題が起きています。しばらく待ってから、もう一度お試しください。'
  const NOT_FOUND_TEST = 'さくらのAI Engine からモデルの一覧を取得できませんでした（404）。しばらく待ってから、もう一度お試しください。'

  it('SDK の Connection error. は回線断の文（以前は「接続テストに失敗しました: Connection error.」）', () => {
    expect(splitFailureDetail(describeSakuraError({ message: 'Connection error.' })).text).toBe(OFFLINE)
  })

  it('ECONNRESET は途中で切れた（時間内に返事がなかった）文', () => {
    expect(splitFailureDetail(describeSakuraError({ code: 'ECONNRESET', message: 'x' })).text).toBe(TIMEOUT_TEST)
  })

  it('401 は既存の文のまま', () => {
    expect(splitFailureDetail(describeSakuraError({ status: 401 })).text).toBe('APIキーが正しくないようです。コピーし直して貼り付けてください')
  })

  it('cause.code が ETIMEDOUT は時間切れの文', () => {
    expect(splitFailureDetail(describeSakuraError({ message: 'x', cause: { code: 'ETIMEDOUT' } })).text).toBe(TIMEOUT_TEST)
  })

  it('SDK の時間切れ（Request timed out.）も同じ時間切れの文', () => {
    expect(splitFailureDetail(describeSakuraError(new OpenAI.APIConnectionTimeoutError({}))).text).toBe(TIMEOUT_TEST)
  })

  it('HTTP の応答が返った失敗は、本文に network があっても回線断にしない（502 は サービス側の文）', () => {
    expect(splitFailureDetail(describeSakuraError({ status: 502, message: '502 Bad Gateway: upstream network error' })).text).toBe(SERVER_TEST)
  })

  it('HTTP の応答が返った失敗は、本文に network があっても回線断にしない（404 はモデル一覧の文）', () => {
    expect(splitFailureDetail(describeSakuraError({ status: 404, message: '404 network not found' })).text).toBe(NOT_FOUND_TEST)
  })

  it('HTTP の応答が返った失敗は、本文に network があっても回線断にしない（400 は原文のまま）', () => {
    expect(splitFailureDetail(describeSakuraError({ status: 400, message: '400 network parameter invalid' })).text).toBe('接続テストに失敗しました: 400 network parameter invalid')
  })
})

// Claude の文（接続テストの describeClaudeError・SDK の error 区分の describeAssistantError）も、
// サービス側の問題・混雑には、さくら側・チャットと同じく「待ってから、もう一度」まで言う。
describe('Claude の文 - サービス側の問題・混雑は次の一手まで言う', () => {
  const NEXT = 'しばらく待ってから'
  it('describeAssistantError: server_error・overloaded・rate_limit', () => {
    expect(describeAssistantError('server_error')).toBe('Anthropic側でエラーが発生しました。しばらく待ってからもう一度お試しください。')
    for (const code of ['server_error', 'overloaded', 'rate_limit']) {
      expect(describeAssistantError(code), code).toContain(NEXT)
      expect(describeAssistantError(code), code).toContain('もう一度お試しください')
    }
  })

  it('describeClaudeError: 500 番台', () => {
    for (const status of [500, 502, 503, 529]) {
      expect(describeClaudeError(status), String(status)).toBe(`Anthropic 側で問題が発生しています（HTTP ${status}）。しばらく待ってから、もう一度お試しください。`)
    }
  })
})
