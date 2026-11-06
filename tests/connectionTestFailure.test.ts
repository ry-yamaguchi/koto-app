import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'

// ── 接続テストの入口が、通信の失敗を日本語の1文で返すこと ─────────────────────────────
// 設定の「接続テスト」ボタン（さくらのAI Engine・GitHub・Claude・HANAMII・Vercel・さくらのクラウド・専有型）は、
// 通信が切れたとき、これまで fetch の英語の原文（'fetch failed' など）をそのまま画面に出していた。
// 回線断・時間切れ・安全な接続は共通の層（shared/failureText.ts）の読み取りの文にする。見分けられない失敗は原文のまま。
//
// ここは**ソースの文字列を読まない**（歯止めは振る舞いで固定する）。入口の ipcMain ハンドラを実際に登録して呼び、
// fetch だけを差し替えて、投げた例外の形ごとに「利用者に見える message」を完全一致で見る。
// 入口の一覧（表）を回すので、1入口だけ日本語にならない漏れも捕まる。
// 外へは出ない: fetch は常に偽物で、実際に出ようとした要求（メソッドと宛先）を数える。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  /** loadCredentials が返す値（実キーは使わない）。 */
  creds: { token: 'TEST-TOKEN', secret: 'TEST-SECRET' } as null | { token: string; secret: string },
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => '/tmp', getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {} },
  dialog: {},
}))

vi.mock('../src/main/cloud/auth', async (importOriginal) => {
  const real = await importOriginal<any>()
  return { ...real, loadCredentials: () => h.creds }
})

// さくらのAI Engine のクライアントは、モデル一覧の取得で fetch を1回呼ぶ偽物にする（fetch が投げた値がそのまま handler に届く）。
// SDK が回線断を包む所（APIConnectionError など）の本物の形は tests/sakuraIpc.test.ts が、本物の SDK と手元の相手で見ている。
vi.mock('../src/main/sakura/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/sakura/engine')>()
  return {
    ...actual,
    sakuraClient: (_apiKey: string) => ({
      models: {
        list: async (_opts: unknown) => {
          const res: Response = await (globalThis.fetch as any)('https://ai.example.invalid/v1/models', { method: 'GET' })
          // 応答が返った失敗は、SDK と同じく状態番号つきの例外にする
          if (!res.ok) throw Object.assign(new Error(`${res.status} status code (no body)`), { status: res.status })
          return { data: [{ id: 'model-a' }] }
        },
      },
    }),
  }
})

import { registerSakuraHandlers } from '../src/main/ipc/sakura'
import { registerGithubHandlers } from '../src/main/ipc/github'
import { registerClaudeHandlers } from '../src/main/ipc/claude'
import { registerHanamiiHandlers } from '../src/main/ipc/hanamii'
import { registerVercelHandlers } from '../src/main/ipc/vercel'
import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { registerApprunDedicatedHandlers } from '../src/main/ipc/apprunDedicated'
import { createCluster, getCluster } from '../src/main/cloud/apprunDedicated'

for (const register of [
  registerSakuraHandlers, registerGithubHandlers, registerClaudeHandlers, registerHanamiiHandlers,
  registerVercelHandlers, registerCloudHandlers, registerApprunDedicatedHandlers,
]) register({} as any)

// ── 文（完全一致）。共通の層の読み取りの文 ──
const T_OFFLINE = 'インターネットに接続できませんでした。接続を確かめてから、もう一度お試しください。'
const T_TIMEOUT = '時間内に返事がありませんでした。混み合っているかもしれません。少し待ってから、もう一度お試しください。'
const T_TLS = '安全な接続を確認できませんでした。社内ネットワークやセキュリティソフトの設定を確かめてください。'
// 書き込みの途中で切れたときの文（接続テストは読み取りなので、これは出さない）
const T_WRITE_CUT = '通信が途中で切れました。操作が済んだかは確かめられていません。'

const AUTH = { token: 'tok', secret: 'sec' }

// ── 投げる例外の形（fetch が実際に投げる形）──
let timeoutError: unknown
beforeAll(async () => {
  // AbortSignal.timeout が作る本物の DOMException（name は TimeoutError）
  const signal = AbortSignal.timeout(5)
  await new Promise<void>(resolve => setTimeout(resolve, 40))
  timeoutError = signal.reason
})

interface Shape {
  name: string
  make: () => unknown
  /** 日本語の文。null は「見分けられない失敗」（原文のまま）。 */
  text: string | null
  /** 文の下の詳細に残るべき原文の断片（原因の連なりの message と code）。 */
  detail: string[]
}
const UNKNOWN_MESSAGE = 'something odd happened'
const SHAPES: Shape[] = [
  { name: '名前が引けない（cause.code が ENOTFOUND）', make: () => new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }), text: T_OFFLINE, detail: ['fetch failed', 'ENOTFOUND'] },
  { name: '時間切れ（AbortSignal.timeout の TimeoutError）', make: () => timeoutError, text: T_TIMEOUT, detail: ['aborted due to timeout'] },
  { name: '途中で切れた（cause.code が ECONNRESET）', make: () => new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }), text: T_TIMEOUT, detail: ['fetch failed', 'ECONNRESET'] },
  { name: '証明書を確かめられない（cause.code が UNABLE_TO_VERIFY_LEAF_SIGNATURE）', make: () => new TypeError('fetch failed', { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } }), text: T_TLS, detail: ['fetch failed', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'] },
  { name: '見分けられない失敗（未知の英語）', make: () => new Error(UNKNOWN_MESSAGE), text: null, detail: [] },
]

// ── fetch の差し替え ──
let thrown: unknown
let respondWith: number | null
const calls: string[] = []

beforeEach(() => {
  calls.length = 0
  respondWith = null
  vi.stubGlobal('fetch', async (input: unknown, init?: { method?: string }) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string }).url ?? input)
    calls.push(`${String(init?.method ?? 'GET').toUpperCase()} ${new URL(url).host}`)
    if (respondWith !== null) return new Response('{}', { status: respondWith, headers: { 'content-type': 'application/json' } })
    throw thrown
  })
})
afterEach(() => { vi.unstubAllGlobals() })

// ── 入口の表 ──
const call = (channel: string, ...args: unknown[]) => h.handlers.get(channel)!({}, ...args)
/** { message } を返す入口。 */
const messageOf = async (channel: string, ...args: unknown[]): Promise<string[]> => [(await call(channel, ...args)).message]
/** { checks: { … : { message } } } を返す入口（チェックごとの message をすべて集める）。 */
const checkMessagesOf = async (channel: string, ...args: unknown[]): Promise<string[]> =>
  Object.values((await call(channel, ...args)).checks as Record<string, { message?: string }>).map(c => c.message ?? '')

interface Entry {
  name: string
  channel: string
  run: () => Promise<string[]>
  /** 実際に出ようとした要求（メソッドと宛先）。接続テストは読み取りだけ。 */
  requests: string[]
  /** 見分けられない失敗（原文）のとき、画面に出る文。 */
  raw: (original: string) => string
}
const same = (original: string) => original
const GITHUB = 'GET api.github.com'
const ANTHROPIC = 'GET api.anthropic.com'
const CLOUD = 'GET secure.sakura.ad.jp'

const ENTRIES: Entry[] = [
  {
    name: 'さくらのAI Engine', channel: 'sakura:models',
    run: async () => {
      try { await call('sakura:models', 'key-1') } catch (e: any) { return [e.message] }
      throw new Error('失敗するはずの呼び出しが成功した')
    },
    requests: ['GET ai.example.invalid'], raw: m => `接続テストに失敗しました: ${m}`,
  },
  { name: 'GitHub（接続テスト）', channel: 'github:test', run: () => messageOf('github:test', 'ghp_test'), requests: [GITHUB], raw: same },
  { name: 'GitHub（状態確認）', channel: 'github:status', run: () => messageOf('github:status', 'ghp_test', 'owner/repo'), requests: [GITHUB], raw: same },
  { name: 'Claude（接続テスト）', channel: 'claude:test', run: () => messageOf('claude:test', 'sk-ant-test'), requests: [ANTHROPIC], raw: same },
  { name: 'Claude（モデル一覧）', channel: 'claude:models', run: () => messageOf('claude:models', 'sk-ant-test'), requests: [ANTHROPIC], raw: same },
  { name: 'HANAMII', channel: 'hanamii:testConnection', run: () => messageOf('hanamii:testConnection', 'hnm_test'), requests: ['GET hanamii.jp'], raw: same },
  { name: 'Vercel', channel: 'vercel:testConnection', run: () => messageOf('vercel:testConnection', 'vercel-test'), requests: ['GET api.vercel.com'], raw: same },
  // さくらのクラウド: アプリの参照・コンテナレジストリの一覧・請求の参照の3つ（どれも読み取り）
  { name: 'さくらのクラウド', channel: 'cloud:testConnection', run: () => checkMessagesOf('cloud:testConnection'), requests: [CLOUD, CLOUD, CLOUD], raw: same },
  // 専有型: 上限の参照・コンテナレジストリの一覧・請求の参照の3つ（どれも読み取り）
  { name: '専有型', channel: 'apprunDedicated:testConnection', run: () => checkMessagesOf('apprunDedicated:testConnection', AUTH), requests: [CLOUD, CLOUD, CLOUD], raw: same },
  // 専有型のゾーン一覧（読み取りだけ。接続テストと同じ画面で読み込まれる）
  { name: '専有型（ゾーン一覧）', channel: 'apprunDedicated:zones', run: () => messageOf('apprunDedicated:zones', AUTH), requests: [CLOUD], raw: same },
]

import { splitFailureDetail } from '../src/shared/failureDetail'

describe('接続テストの入口の表', () => {
  it('表の入口は、すべて実際に登録されている（名前の打ち間違いで素通りさせない）', () => {
    for (const e of ENTRIES) expect(h.handlers.has(e.channel), e.channel).toBe(true)
  })

  it('★ 7つの入口（さくら・GitHub・Claude・HANAMII・Vercel・さくらのクラウド・専有型）が、すべて表に入っている', () => {
    const channels = ENTRIES.map(e => e.channel)
    for (const c of ['sakura:models', 'github:test', 'github:status', 'claude:test', 'claude:models', 'hanamii:testConnection', 'vercel:testConnection', 'cloud:testConnection', 'apprunDedicated:testConnection']) {
      expect(channels, c).toContain(c)
    }
  })
})

describe('★ 通信の失敗を、入口ごとに日本語の1文で返す（完全一致・出た要求の一覧つき）', () => {
  for (const entry of ENTRIES) {
    describe(`${entry.name}（${entry.channel}）`, () => {
      for (const shape of SHAPES) {
        it(shape.name, async () => {
          thrown = shape.make()
          const messages = await entry.run()
          const expected = shape.text ?? entry.raw(UNKNOWN_MESSAGE)
          // 返る message のすべてが、その文と完全に一致する（複数のチェックを持つ入口は、チェックごと）。
          // 比べるのは詳細の行を除いた日本語の文（詳細は下の it で固める）
          expect(messages.map(m => splitFailureDetail(m).text)).toEqual(messages.map(() => expected))
          expect(messages.length).toBeGreaterThan(0)
          // 日本語に置き換えた失敗には、すべての message に原文の詳細が付く（1入口・1チェックだけ付け忘れる漏れを捕まえる）。
          // 見分けられない失敗は原文がすでに文に入っているので、詳細を重ねない
          for (const m of messages) {
            const { detail } = splitFailureDetail(m)
            if (shape.text === null) expect(detail, m).toBe('')
            else for (const part of shape.detail) expect(detail, m).toContain(part)
          }
          // 出ようとした要求は読み取りだけ（何も作らない・何も消さない）
          expect(calls).toEqual(entry.requests)
        })
      }

      it('応答が返った失敗（503）は、回線断・時間切れの文にしない', async () => {
        respondWith = 503
        const messages = await entry.run()
        for (const m of messages) {
          expect(m).not.toBe(T_OFFLINE)
          expect(m).not.toBe(T_TIMEOUT)
          expect(m).not.toBe(T_TLS)
        }
      })
    })
  }

  it('読み取りの文であって、書き込みの文（操作が済んだかは…）は出ない', async () => {
    thrown = new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })
    for (const entry of ENTRIES) {
      for (const m of await entry.run()) expect(m, entry.name).not.toContain(T_WRITE_CUT)
    }
  })
})

describe('専有型の読み取り: 接続テスト以外（作る・消す流れの中）は慎重な文（読み取りの文は使わない）', () => {
  // 作る・消す流れは、読み取りの失敗の文を自分の文に埋め込む（「作成を確認できませんでした…: <原文>」）。
  // そこへ「もう一度お試しください」を入れると、作り済みのものを二重に作らせかねないので、読み取りの文は接続テストの口だけにする。
  it('実在確認の読み取り（getCluster）は、通信が切れても慎重な文＋詳細（読み取りの文ではない）', async () => {
    thrown = new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })
    const r = await getCluster(AUTH, 'cluster-1')
    expect(r.ok).toBe(false)
    expect(r.message).toContain(T_WRITE_CUT)
    expect(r.message).toContain('詳細: fetch failed')
    expect(calls).toEqual(['GET secure.sakura.ad.jp'])
  })

  it('作成（POST）は、回線が切れたら日本語の文＋詳細（詳細に原文が残る）', async () => {
    thrown = new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })
    const r = await createCluster(AUTH, { name: 'x' })
    expect(r.ok).toBe(false)
    expect(r.message).toContain(T_OFFLINE)
    expect(r.message).toContain('詳細: fetch failed')
    expect(calls).toEqual(['POST secure.sakura.ad.jp'])
  })
})
