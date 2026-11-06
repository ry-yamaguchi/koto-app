import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { createServer, type Server as NetServer } from 'net'
import { createServer as createHttpServer, type Server as HttpServer } from 'http'
import OpenAI from 'openai'
import { MODELS_TIMEOUT_MS, MODELS_MAX_RETRIES } from '../src/shared/chatTimeouts'

// 偽 electron と、さくらの AI Engine のクライアントの差し替え。
// sakura:models のハンドラを実際に登録して呼び、「どの例外が来たら、利用者に何と言うか」を完全一致で見る。
const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  /** models.list が呼ばれた順（キーと、渡された待ち時間の設定）。 */
  calls: [] as Array<{ apiKey: string; opts: unknown }>,
  /** 次に models.list が投げる値（null なら成功を返す）。 */
  next: null as unknown,
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
}))

vi.mock('../src/main/sakura/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/sakura/engine')>()
  return {
    ...actual,
    sakuraClient: (apiKey: string) => ({
      models: {
        list: async (opts: unknown) => {
          h.calls.push({ apiKey, opts })
          if (h.next !== null) throw h.next
          return { data: [{ id: 'model-a' }, { id: 7 }, { id: 'model-b' }] }
        },
      },
    }),
  }
})

import { describeSakuraError as describeSakuraErrorFull, registerSakuraHandlers } from '../src/main/ipc/sakura'
import { splitFailureDetail } from '../src/shared/failureDetail'

// 文の比べは、詳細の行（原文）を除いた日本語の文で行う。詳細の行は末尾の describe で固める。
const describeSakuraError = (e: unknown): string => splitFailureDetail(describeSakuraErrorFull(e)).text

registerSakuraHandlers({} as any)

// ── 文（完全一致）。回線断・時間切れ・安全な接続は共通の層の文、状態番号は接続テストの文 ──
const T_OFFLINE = 'インターネットに接続できませんでした。接続を確かめてから、もう一度お試しください。'
const T_TIMEOUT = '時間内に返事がありませんでした。混み合っているかもしれません。少し待ってから、もう一度お試しください。'
const T_TLS = '安全な接続を確認できませんでした。社内ネットワークやセキュリティソフトの設定を確かめてください。'
const KEY_NG = 'APIキーが正しくないようです。コピーし直して貼り付けてください'
const BUSY = 'アクセスが集中しています。しばらく待ってからもう一度お試しください'
const SERVER = 'さくらのAI Engine 側で一時的な問題が起きています。しばらく待ってから、もう一度お試しください。'
const NOT_FOUND = 'さくらのAI Engine からモデルの一覧を取得できませんでした（404）。しばらく待ってから、もう一度お試しください。'

// ── 本物の例外を作る（自分の機械の中だけ。外へは出ない）──
let closedPort = 0
let silent: NetServer
let silentPort = 0
let statusServer: HttpServer
let statusPort = 0
const sockets: Array<{ destroy(): void }> = []

async function listen(server: NetServer | HttpServer): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}

beforeAll(async () => {
  const probe = createServer()
  closedPort = await listen(probe)
  await new Promise<void>(resolve => probe.close(() => resolve()))
  // つながるが、1文字も返さない相手
  silent = createServer(s => { sockets.push(s) })
  silentPort = await listen(silent)
  // /s/<状態番号>/… に、その状態番号で答える相手
  statusServer = createHttpServer((req, res) => {
    const code = Number(/^\/s\/(\d+)\//.exec(req.url ?? '')?.[1] ?? 500)
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `status ${code}` } }))
  })
  statusPort = await listen(statusServer)
})

afterAll(async () => {
  for (const s of sockets) s.destroy()
  await new Promise<void>(resolve => silent.close(() => resolve()))
  await new Promise<void>(resolve => statusServer.close(() => resolve()))
})

const catchOf = async (run: () => Promise<unknown>): Promise<any> => {
  try { await run() } catch (e) { return e }
  throw new Error('失敗するはずの呼び出しが成功した')
}
const openai = (baseURL: string, extra: Record<string, unknown> = {}) =>
  new OpenAI({ apiKey: 'test', baseURL, maxRetries: 0, ...extra })
const httpError = (status: number) => catchOf(() => openai(`http://127.0.0.1:${statusPort}/s/${status}`).models.list())

// 「どの例外が来たら何と言うか」の表。本物の例外の形で作る（undici の cause の形だけは手で作る）。
const SHAPES: Array<[string, () => Promise<unknown>, string]> = [
  ['openai の APIConnectionError（閉じたポート）', () => catchOf(() => openai(`http://127.0.0.1:${closedPort}/v1`).models.list()), T_OFFLINE],
  ['openai の APIConnectionTimeoutError（返事が来ない相手）', () => catchOf(() => openai(`http://127.0.0.1:${silentPort}/v1`, { timeout: 80 }).models.list()), T_TIMEOUT],
  ['fetch の TimeoutError（AbortSignal.timeout が作る DOMException）', () => catchOf(() => fetch(`http://127.0.0.1:${silentPort}/`, { signal: AbortSignal.timeout(80) })), T_TIMEOUT],
  ['fetch の失敗（閉じたポート。cause に errno）', () => catchOf(() => fetch(`http://127.0.0.1:${closedPort}/`)), T_OFFLINE],
  ['名前が引けない（cause.code が ENOTFOUND）', async () => new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }), T_OFFLINE],
  ['途中で切れた（cause.code が ECONNRESET）', async () => new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }), T_TIMEOUT],
  ['証明書を確かめられない（cause.code が UNABLE_TO_VERIFY_LEAF_SIGNATURE）', async () => new TypeError('fetch failed', { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } }), T_TLS],
  ['401', () => httpError(401), KEY_NG],
  ['403', () => httpError(403), KEY_NG],
  ['404', () => httpError(404), NOT_FOUND],
  ['429', () => httpError(429), BUSY],
  ['500', () => httpError(500), SERVER],
  ['502', () => httpError(502), SERVER],
  ['503', () => httpError(503), SERVER],
]

// describeSakuraError: さくらのAI Engine接続テスト（所見14）で OpenAI SDK の生エラー（英語＋HTTPステータス）が
// そのまま画面に出ていた問題の修正。既知の原因（401/403・404・429・500 番台・回線断・時間切れ）は日本語化し、未知は先頭120字を見せる。
describe('describeSakuraError', () => {
  it('describes 401 as an invalid API key', () => {
    expect(describeSakuraError({ status: 401, message: '401 Incorrect API key provided' }))
      .toBe(KEY_NG)
  })

  it('describes 403 the same as 401', () => {
    expect(describeSakuraError({ status: 403, message: '403 Forbidden' }))
      .toBe(KEY_NG)
  })

  it('describes 429 as rate limiting', () => {
    expect(describeSakuraError({ status: 429, message: '429 Too Many Requests' }))
      .toBe(BUSY)
  })

  it('describes a network error via cause.code (undici fetch failures)', () => {
    expect(describeSakuraError({ message: 'fetch failed', cause: { code: 'ENOTFOUND' } }))
      .toBe(T_OFFLINE)
  })

  it('describes a network error via message text when no status/cause is present', () => {
    expect(describeSakuraError({ message: 'request to https://api.ai.sakura.ad.jp/v1 failed, reason: getaddrinfo ENOTFOUND' }))
      .toBe(T_OFFLINE)
  })

  it('falls back to a truncated raw message for unknown errors', () => {
    const longMsg = 'x'.repeat(200)
    expect(describeSakuraError({ status: 400, message: longMsg }))
      .toBe(`接続テストに失敗しました: ${longMsg.slice(0, 120)}`)
  })

  it('handles a plain Error instance (no status field)', () => {
    expect(describeSakuraError(new Error('something odd happened')))
      .toBe('接続テストに失敗しました: something odd happened')
  })

  it('handles a non-object thrown value', () => {
    expect(describeSakuraError('boom')).toBe('接続テストに失敗しました: boom')
  })

  it('describes a 500 番台 failure (サービス側の一時的な問題) without the English body', () => {
    for (const status of [500, 502, 503, 504, 599]) {
      expect(describeSakuraError({ status, message: `${status} Bad Gateway` })).toBe(SERVER)
    }
  })

  it('describes 404 (モデル一覧が取れなかった) without the English body', () => {
    expect(describeSakuraError({ status: 404, message: '404 The model `foo` does not exist' })).toBe(NOT_FOUND)
  })

  it('other statuses (400 など) stay raw (決定9: 知らない英語は原文のまま)、本文に network があっても回線断にしない', () => {
    expect(describeSakuraError({ status: 400, message: '400 network parameter invalid' }))
      .toBe('接続テストに失敗しました: 400 network parameter invalid')
    expect(describeSakuraError({ status: 408, message: 'Request timed out.' }))
      .toBe('接続テストに失敗しました: Request timed out.')
  })
})

describe('describeSakuraError - 本物の例外の形（回線断・時間切れ・証明書・状態番号）', () => {
  for (const [name, make, expected] of SHAPES) {
    it(name, async () => {
      expect(describeSakuraError(await make())).toBe(expected)
    })
  }

  it('★ 状態番号が先: 500 番台は、errno や time out の印があっても回線断・時間切れにしない', () => {
    expect(describeSakuraError({ status: 503, code: 'ECONNRESET', message: 'x' })).toBe(SERVER)
    expect(describeSakuraError({ status: 504, message: 'Request timed out.', cause: { code: 'ETIMEDOUT' } })).toBe(SERVER)
    expect(describeSakuraError({ status: 404, message: 'fetch failed', code: 'ENOTFOUND' })).toBe(NOT_FOUND)
  })

  it('★ 文の中に英語の原文・状態番号の英語・製品の内部の名前を出さない', () => {
    for (const s of [T_OFFLINE, T_TIMEOUT, T_TLS, SERVER, NOT_FOUND]) {
      for (const bad of ['Connection error', 'Request timed out', 'status code', 'Bad Gateway', 'Claude Code', '接続テストに失敗しました']) {
        expect(s).not.toContain(bad)
      }
    }
  })
})

describe('sakura:models（接続テストの入口）', () => {
  const call = (apiKey: string) => h.handlers.get('sakura:models')!({}, apiKey)

  it('成功: モデルの id（文字列だけ）を返し、キーと待ち時間の上限を models.list に渡す', async () => {
    h.calls.length = 0
    h.next = null
    expect(await call('key-1')).toEqual(['model-a', 'model-b'])
    expect(h.calls).toEqual([{ apiKey: 'key-1', opts: { timeout: MODELS_TIMEOUT_MS, maxRetries: MODELS_MAX_RETRIES } }])
  })

  for (const [name, make, expected] of SHAPES) {
    it(`失敗（${name}）: 英語の原文を出さず、1回だけ呼んで、日本語の文で投げ直す`, async () => {
      h.calls.length = 0
      h.next = await make()
      const thrown = await call('key-2').then(() => null, (e: Error) => e)
      expect(thrown).toBeInstanceOf(Error)
      expect(splitFailureDetail((thrown as Error).message).text).toBe(expected)
      expect(h.calls.length).toBe(1)
      h.next = null
    })
  }

  it('知らない失敗は「接続テストに失敗しました: 原文」（先頭120字）で投げ直す', async () => {
    h.next = new Error('something odd happened')
    await expect(call('key-3')).rejects.toThrow(new Error('接続テストに失敗しました: something odd happened'))
    h.next = null
  })

  it('★ 日本語を含む失敗は、本文に network があっても回線断にしない（原文を添えた文で投げ直す）', async () => {
    h.calls.length = 0
    h.next = new Error('Docker の network が見つかりません')
    await expect(call('key-4')).rejects.toThrow(new Error('接続テストに失敗しました: Docker の network が見つかりません'))
    expect(h.calls.length).toBe(1)
    h.next = null
  })
})

// ── 詳細（原文）: 日本語の固定文に置き換えて原文を捨てていた分岐に、文の下へ「詳細: 原文」を添える ──
describe('describeSakuraError - 詳細の行（原文）', () => {
  const detailOf = (e: unknown) => splitFailureDetail(describeSakuraErrorFull(e)).detail

  it('401: キーの形は伏せ、状態番号を残す', () => {
    const t = describeSakuraErrorFull({ status: 401, message: '401 Incorrect API key provided: sk-abcdefghijklmnopqrstuvwxyz0123456789' })
    expect(splitFailureDetail(t).text).toBe(KEY_NG)
    expect(splitFailureDetail(t).detail).toContain('401 Incorrect API key provided')
    expect(t).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123456789')
  })

  it('403・429・404・5xx も、文のあとに原文の詳細が付く', () => {
    expect(describeSakuraErrorFull({ status: 403, message: '403 Forbidden' })).toBe(`${KEY_NG}\n詳細: 403 Forbidden`)
    expect(describeSakuraErrorFull({ status: 429, message: '429 Too Many Requests' })).toBe(`${BUSY}\n詳細: 429 Too Many Requests`)
    expect(describeSakuraErrorFull({ status: 404, message: '404 The model `foo` does not exist' })).toBe(`${NOT_FOUND}\n詳細: 404 The model \`foo\` does not exist`)
    expect(describeSakuraErrorFull({ status: 503, message: '503 Service Unavailable' })).toBe(`${SERVER}\n詳細: 503 Service Unavailable`)
  })

  it('状態番号が message に無いときは HTTP <番号> を足す', () => {
    expect(detailOf({ status: 502, message: 'Bad Gateway' })).toContain('HTTP 502')
  })

  it('回線断（共通の層を通る分岐）: 本物の原因の連なり（ホスト名）が詳細に残る', () => {
    const e = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.ai.sakura.ad.jp'), { code: 'ENOTFOUND' }) })
    const t = describeSakuraErrorFull(e)
    expect(splitFailureDetail(t).text).toBe(T_OFFLINE)
    expect(splitFailureDetail(t).detail).toContain('getaddrinfo ENOTFOUND api.ai.sakura.ad.jp')
  })

  it('★ 見本（Connection error.）の回線断: 文は回線断、詳細は本物の失敗から。見本の文面は出さない', () => {
    const e = { message: 'The network blip happened while reaching api.ai.sakura.ad.jp' }
    const t = describeSakuraErrorFull(e)
    const { text, detail } = splitFailureDetail(t)
    expect(text).toBe(T_OFFLINE)
    expect(detail).toContain('The network blip happened while reaching api.ai.sakura.ad.jp')
    expect(t).not.toContain('Connection error.')
  })

  it('見分けられない失敗（原文を文に出している分岐）には詳細を重ねない', () => {
    const t = describeSakuraErrorFull({ status: 400, message: '400 bad' })
    expect(t).toBe('接続テストに失敗しました: 400 bad')
    expect(t).not.toContain('詳細: ')
  })

  it('入口（sakura:models）の投げ直しの message にも詳細が載る', async () => {
    h.next = Object.assign(new Error('503 Service Unavailable'), { status: 503 })
    const thrown = await h.handlers.get('sakura:models')!({}, 'k').then(() => null, (e: Error) => e)
    expect((thrown as Error).message).toBe(`${SERVER}\n詳細: 503 Service Unavailable`)
    h.next = null
  })
})
