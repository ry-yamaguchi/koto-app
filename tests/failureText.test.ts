import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, rmSync, chmodSync } from 'fs'
import { createServer, type Server } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import OpenAI from 'openai'
import { classifyFailure, failureText as rawFailureText, stripRemoteHead, type FailureTextOptions } from '../src/shared/failureText'
import { splitFailureDetail } from '../src/shared/failureDetail'
import { isConnectionFailure, isConnectionFailureMessage, isJudgeableMessage } from '../src/shared/connectionFailure'
import { cleanRemoteError } from '../src/renderer/remoteError'

// 失敗の判定と文の土台。本物の例外の形（openai SDK・fetch・AbortSignal・fs）で作り、文は完全一致で固定する。
// 判定の順序（IPC の頭 → status → 構造の印 → 文面 → 原文のまま）と、
// 「要求が出ていない」と言い切ってよい失敗の一覧が、変異で崩れたら落ちるようにしてある。

const root = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf-8')

// ── 文（完全一致）──
const T_OFFLINE = 'インターネットに接続できませんでした。接続を確かめてから、もう一度お試しください。'
const T_TLS = '安全な接続を確認できませんでした。社内ネットワークやセキュリティソフトの設定を確かめてください。'
const T_TIMEOUT_READ = '時間内に返事がありませんでした。混み合っているかもしれません。少し待ってから、もう一度お試しください。'
const T_CUT_WRITE = (where: string) => `通信が途中で切れました。操作が済んだかは確かめられていません。少し待ってから、${where}状態を確かめてください。`
const T_FULL = 'ディスクの空きが足りません。空きを作ってから、もう一度お試しください。'

// 文の比べは、詳細の行を外した文で行う（詳細の中身は下の describe で別に固める）
const failureText = (e: unknown, opts?: FailureTextOptions) => splitFailureDetail(rawFailureText(e, opts)).text

const head = (channel: string, inner: string) => `Error invoking remote method '${channel}': ${inner}`
const errno = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { code, ...extra })

// ── 本物の通信の失敗を作る（自分の機械の中だけ。外へは出ない）──
let closedPort = 0
let silent: Server
let silentPort = 0
const sockets: Array<{ destroy(): void }> = []

async function listen(server: Server): Promise<number> {
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
})

afterAll(async () => {
  for (const s of sockets) s.destroy()
  await new Promise<void>(resolve => silent.close(() => resolve()))
})

const catchOf = async (run: () => Promise<unknown>): Promise<any> => {
  try { await run() } catch (e) { return e }
  throw new Error('失敗するはずの呼び出しが成功した')
}

describe('IPC の頭を落とす（stripRemoteHead）', () => {
  const body = 'APIキーが正しくないようです'
  for (const inner of ['Error: ', 'TypeError: ', 'RangeError: ', '']) {
    it(`頭「${inner || '型名なし'}」を、文字列でも Error 値でも落とす`, () => {
      const raw = head('sakura:models', inner + body)
      expect(stripRemoteHead(raw)).toBe(body)
      expect(stripRemoteHead(new Error(raw))).toBe(body)
    })
  }

  it('頭が無い文・先頭でない所の頭は触らない', () => {
    expect(stripRemoteHead(new Error('インターネット接続を確認してください'))).toBe('インターネット接続を確認してください')
    const mid = "本文の途中に Error invoking remote method 'x': Error: が出ても残す"
    expect(stripRemoteHead(mid)).toBe(mid)
  })

  it('Error でない値でも壊れない', () => {
    expect(stripRemoteHead(undefined)).toBe('undefined')
    expect(stripRemoteHead(null)).toBe('null')
    expect(stripRemoteHead('プレーン')).toBe('プレーン')
  })

  it('★ 画面の cleanRemoteError は、同じ1つの関数の別名（呼び出しは変えず、定義を2つ持たない）', () => {
    expect(cleanRemoteError).toBe(stripRemoteHead)
    const src = read('src/renderer/remoteError.ts')
    expect(src).toContain("import { stripRemoteHead } from '../shared/failureText'")
    expect(src).toContain('export const cleanRemoteError = stripRemoteHead')
    // 直す前の形（Error: だけを許す正規表現を自分で持つ）に戻っていない
    expect(src).not.toContain('raw.replace(')
    expect(src).not.toContain('(?:Error:\\s*)?')
  })

  it('★ 頭の正規表現は「型名つき」まで許す形（TypeError: を取り残さない）', () => {
    expect(read('src/shared/failureText.ts')).toContain("/^Error invoking remote method '[^']*':\\s*(?:[A-Za-z]*Error:\\s*)?/")
  })
})

describe('本物の例外の形を見分ける', () => {
  it('openai の APIConnectionError（閉じたポートへ接続。cause に fetch の失敗と errno）→ 回線なし・要求は出ていない', async () => {
    const client = new OpenAI({ apiKey: 'test', baseURL: `http://127.0.0.1:${closedPort}/v1`, maxRetries: 0 })
    const e = await catchOf(() => client.models.list())
    expect(e.constructor.name).toBe('APIConnectionError')
    expect(e.message).toBe('Connection error.')
    const c = classifyFailure(e)
    expect(c).toMatchObject({ kind: 'offline', sent: 'no', code: 'ECONNREFUSED' })
    expect(failureText(e, { readOnly: true })).toBe(T_OFFLINE)
  })

  it('openai の APIConnectionTimeoutError（返事が来ない相手）→ 時間切れ', async () => {
    const client = new OpenAI({ apiKey: 'test', baseURL: `http://127.0.0.1:${silentPort}/v1`, maxRetries: 0, timeout: 80 })
    const e = await catchOf(() => client.models.list())
    expect(e.constructor.name).toBe('APIConnectionTimeoutError')
    expect(e.message).toBe('Request timed out.')
    expect(classifyFailure(e)).toMatchObject({ kind: 'timeout', sent: 'maybe' })
    expect(failureText(e, { readOnly: true })).toBe(T_TIMEOUT_READ)
  })

  it('fetch の失敗（TypeError: fetch failed。cause に errno）→ errno の印が優先され、要求は出ていない', async () => {
    const e = await catchOf(() => fetch(`http://127.0.0.1:${closedPort}/`))
    expect(e.message).toBe('fetch failed')
    expect(classifyFailure(e)).toMatchObject({ kind: 'offline', sent: 'no', code: 'ECONNREFUSED' })
  })

  it('AbortSignal.timeout が作る DOMException（TimeoutError）→ 時間切れ。中断（interrupted）に取り違えない', async () => {
    const e = await catchOf(() => fetch(`http://127.0.0.1:${silentPort}/`, { signal: AbortSignal.timeout(80) }))
    expect(e.name).toBe('TimeoutError')
    expect(e.message).toMatch(/aborted due to timeout/)
    expect(classifyFailure(e)).toMatchObject({ kind: 'timeout', sent: 'maybe' })
  })

  it('中断そのもの（AbortController.abort が作る AbortError）→ 途中で切れた', async () => {
    const ctl = new AbortController()
    const run = fetch(`http://127.0.0.1:${silentPort}/`, { signal: ctl.signal })
    setTimeout(() => ctl.abort(), 20)
    const e = await catchOf(() => run)
    expect(e.name).toBe('AbortError')
    expect(classifyFailure(e)).toMatchObject({ kind: 'interrupted', sent: 'maybe' })
  })

  describe('本物の fs の errno', () => {
    const dir = mkdtempSync(join(tmpdir(), 'failure-text-'))
    afterAll(() => { try { chmodSync(join(dir, 'locked'), 0o700) } catch { /* 無ければよい */ } rmSync(dir, { recursive: true, force: true }) })

    it('存在しないファイル（ENOENT）→ 見つからない。パスは例外の path から', () => {
      const target = join(dir, 'missing', 'a.txt')
      let e: any
      try { readFileSync(target) } catch (err) { e = err }
      expect(e.code).toBe('ENOENT')
      expect(classifyFailure(e)).toMatchObject({ kind: 'fs-missing', code: 'ENOENT', path: target })
      expect(failureText(e)).toBe(`ファイルまたはフォルダが見つかりませんでした（${target}）。`)
    })

    // root では権限で拒まれない（その環境では確かめようがない）
    it.skipIf(process.getuid?.() === 0)('権限の無いフォルダ（EACCES）→ 書き込めない', () => {
      const locked = join(dir, 'locked')
      mkdirSync(locked)
      chmodSync(locked, 0o500)
      let e: any
      try { mkdirSync(join(locked, 'child')) } catch (err) { e = err }
      expect(e.code).toBe('EACCES')
      expect(classifyFailure(e)).toMatchObject({ kind: 'fs-denied', sent: 'no', code: 'EACCES', path: join(locked, 'child') })
      expect(failureText(e)).toBe(`このフォルダには書き込めません（${join(locked, 'child')}）。別の場所を選ぶか、Finder で権限を確かめてください。`)
    })
  })

  it('空きが無い（ENOSPC。手で作る）→ ディスクの空き', () => {
    const e = errno('ENOSPC', "ENOSPC: no space left on device, write", { errno: -28, syscall: 'write' })
    expect(classifyFailure(e)).toMatchObject({ kind: 'fs-full', code: 'ENOSPC' })
    expect(failureText(e)).toBe(T_FULL)
  })
})

describe('IPC を通って文字列だけになった失敗（構造の印が無い）', () => {
  it('fs の errno の文面（先頭が E…:）から、種類とパスを読む', () => {
    const e = new Error(head('fs:createProject', "Error: EACCES: permission denied, mkdir '/work/proj'"))
    expect(classifyFailure(e)).toMatchObject({ kind: 'fs-denied', code: 'EACCES', path: '/work/proj' })
    expect(failureText(e)).toBe('このフォルダには書き込めません（/work/proj）。別の場所を選ぶか、Finder で権限を確かめてください。')
    expect(failureText(head('fs:read', "Error: ENOENT: no such file or directory, open '/work/a.txt'")))
      .toBe('ファイルまたはフォルダが見つかりませんでした（/work/a.txt）。')
  })

  it('パスが読めなければ括弧ごと省く', () => {
    expect(failureText(errno('EACCES', 'EACCES'))).toBe('このフォルダには書き込めません。別の場所を選ぶか、Finder で権限を確かめてください。')
    expect(failureText(errno('ENOENT', 'ENOENT'))).toBe('ファイルまたはフォルダが見つかりませんでした。')
  })

  it('★ パスの中のアポストロフィ（フォルダ名の所有格など）で途中で切れない', () => {
    // Node は引用符の中のパスを逃がさずに出す。切れたパスを「確かめた事実」として画面に出さない
    const denied = new Error(head('fs:createProject', "Error: EACCES: permission denied, mkdir '/work/Taro's Projects/app'"))
    expect(classifyFailure(denied)).toMatchObject({ kind: 'fs-denied', code: 'EACCES', path: "/work/Taro's Projects/app" })
    expect(failureText(denied)).toBe("このフォルダには書き込めません（/work/Taro's Projects/app）。別の場所を選ぶか、Finder で権限を確かめてください。")
    expect(failureText("ENOENT: no such file or directory, open '/work/Mom's Files/it's.txt'"))
      .toBe("ファイルまたはフォルダが見つかりませんでした（/work/Mom's Files/it's.txt）。")
  })

  it('★ rename は最初の1つのパス（アポストロフィを含んでも、矢印の手前で切る）', () => {
    expect(classifyFailure(new Error("ENOENT: no such file or directory, rename '/work/Taro's/a' -> '/work/b'")).path).toBe("/work/Taro's/a")
    expect(classifyFailure(new Error("ENOENT: no such file or directory, rename '/work/a' -> '/work/Taro's/b'")).path).toBe('/work/a')
    expect(classifyFailure(new Error("EACCES: permission denied, open '/work/a.txt'")).path).toBe('/work/a.txt')
  })

  it('★ パスの読みは Node の errno 文の形だけ（Kids\' Photos・Rock \'n\' Roll で欠けない・形が曖昧なら言わない）', () => {
    const pathOf = (m: string) => classifyFailure(new Error(m)).path
    expect(pathOf("ENOENT: no such file or directory, open '/work/Kids' Photos'")).toBe("/work/Kids' Photos")
    expect(pathOf("EACCES: permission denied, mkdir '/work/Rock 'n' Roll/app'")).toBe("/work/Rock 'n' Roll/app")
    expect(pathOf("EACCES: permission denied, mkdir '/work/Taro's Projects'")).toBe("/work/Taro's Projects")
    // 2つのパス（rename）は元のパス
    expect(pathOf("ENOENT: no such file or directory, rename '/work/a b' -> '/work/c d'")).toBe('/work/a b')
    expect(pathOf("ENOENT: no such file or directory, rename '/work/Kids' Photos' -> '/work/Rock 'n' Roll'")).toBe("/work/Kids' Photos")
    // 曖昧: パスの中にも ' -> ' がある・文末が閉じていない・errno の形でない → パスを言わない
    expect(pathOf("ENOENT: no such file or directory, rename '/w/a' -> '/w/b' -> '/w/c'")).toBeUndefined()
    expect(pathOf("EACCES: permission denied, open '/work/a.txt' while copying 'x'. retry later")).toBeUndefined()
    expect(pathOf("EACCES: permission denied, open '/work/a.txt' (see log 'x')")).toBeUndefined()
    expect(pathOf("EACCES: something failed for 'x'")).toBeUndefined()
    // 言わない場合は文から括弧ごと省く（誤った事実を言うより省く）
    expect(failureText(new Error("EACCES: permission denied, open '/work/a.txt' (see log 'x')")))
      .toBe('このフォルダには書き込めません。別の場所を選ぶか、Finder で権限を確かめてください。')
  })

  it('net::ERR_* と、syscall つきの errno の文面', () => {
    expect(classifyFailure(new Error('net::ERR_INTERNET_DISCONNECTED'))).toMatchObject({ kind: 'offline', sent: 'no', code: 'net::ERR_INTERNET_DISCONNECTED' })
    expect(classifyFailure(new Error('net::ERR_CONNECTION_RESET'))).toMatchObject({ kind: 'interrupted', sent: 'maybe' })
    expect(classifyFailure(new Error('net::ERR_CONNECTION_TIMED_OUT'))).toMatchObject({ kind: 'timeout', sent: 'maybe' })
    expect(classifyFailure(new Error('net::ERR_CERT_AUTHORITY_INVALID'))).toMatchObject({ kind: 'tls', code: 'net::ERR_CERT_AUTHORITY_INVALID' })
    expect(classifyFailure(new Error('getaddrinfo ENOTFOUND api.example.test'))).toMatchObject({ kind: 'offline', sent: 'no', code: 'ENOTFOUND' })
    expect(classifyFailure(new Error('connect ETIMEDOUT 203.0.113.5:500'))).toMatchObject({ kind: 'timeout', sent: 'maybe' })
    expect(classifyFailure(new Error('read ECONNRESET'))).toMatchObject({ kind: 'interrupted', sent: 'maybe' })
  })

  it('頭の型名が TypeError: でも、中の文面を見分ける', () => {
    const e = new Error(head('claude:test', 'TypeError: fetch failed'))
    expect(classifyFailure(e)).toMatchObject({ kind: 'offline', sent: 'maybe', original: 'fetch failed' })
  })

  it('文面の「中断」でも、時間切れの文面は時間切れ（中断より先に見る）', () => {
    expect(classifyFailure(new Error('The operation was aborted due to timeout'))).toMatchObject({ kind: 'timeout' })
    expect(classifyFailure(new Error(head('x', 'Error: The operation was aborted due to timeout')))).toMatchObject({ kind: 'timeout' })
    expect(classifyFailure(new Error('This operation was aborted'))).toMatchObject({ kind: 'interrupted' })
    expect(classifyFailure(new Error('Request timed out.'))).toMatchObject({ kind: 'timeout' })
  })
})

describe('「要求が出ていない」と言い切るのは、名前が引けない・つながらない失敗だけ', () => {
  const NO = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH']
  const MAYBE = ['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']
  for (const code of NO) {
    it(`${code}（errno の印・文面）→ no`, () => {
      expect(classifyFailure(errno(code, 'x')).sent).toBe('no')
      expect(classifyFailure(new Error(`connect ${code} 127.0.0.1:1`)).sent).toBe('no')
    })
  }
  for (const code of MAYBE) {
    it(`${code}（errno の印）→ maybe`, () => {
      expect(classifyFailure(errno(code, 'x')).sent).toBe('maybe')
    })
  }
  it('net::ERR_INTERNET_DISCONNECTED・net::ERR_NAME_NOT_RESOLVED → no。印の無い fetch failed・時間切れ → maybe', () => {
    expect(classifyFailure(new Error('net::ERR_INTERNET_DISCONNECTED')).sent).toBe('no')
    expect(classifyFailure(new Error('net::ERR_NAME_NOT_RESOLVED')).sent).toBe('no')
    expect(classifyFailure(new Error('fetch failed')).sent).toBe('maybe')
    expect(classifyFailure(new Error('Connection error.')).sent).toBe('maybe')
    expect(classifyFailure(new Error('Request timed out.')).sent).toBe('maybe')
    expect(classifyFailure(new Error('net::ERR_CONNECTION_REFUSED')).sent).toBe('maybe')
  })
  it('つながる前に止まった時間切れ（dial の i/o timeout）は、書き込みでも「済んだか」を言わない。途中の時間切れは言う', () => {
    const dial = 'Error: Get "https://r.example.jp/v2/": dial tcp 54.1.2.3:443: i/o timeout'
    expect(failureText(dial)).not.toContain('操作が済んだかは確かめられていません')
    expect(failureText(dial)).toContain('時間内に返事がありませんでした')
    expect(failureText(new Error('Request timed out.'))).toContain('操作が済んだかは確かめられていません')
  })
  it('cause の奥の errno も読む（cause.code・cause.cause.code・cause.errors[0].code）', () => {
    const fetchFailed = (cause: unknown) => new TypeError('fetch failed', { cause })
    expect(classifyFailure(fetchFailed({ code: 'ENOTFOUND' })).sent).toBe('no')
    expect(classifyFailure(fetchFailed({ cause: { code: 'EHOSTUNREACH' } })).sent).toBe('no')
    expect(classifyFailure(fetchFailed({ errors: [{ code: 'ENETUNREACH' }, { code: 'ECONNRESET' }] })).sent).toBe('no')
    expect(classifyFailure(fetchFailed({ cause: { code: 'ECONNRESET' } })).sent).toBe('maybe')
  })
})

describe('判定の順序', () => {
  it('★ 構造の印が文面より先（文面は「fetch failed」＝maybe でも、cause の errno が no なら no）', () => {
    const e = new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })
    expect(classifyFailure(e)).toMatchObject({ kind: 'offline', sent: 'no', code: 'ENOTFOUND' })
  })

  it('★ 構造の印が文面より先（日本語の文でも、errno の印があれば種類が決まる）', () => {
    expect(classifyFailure(errno('ENOENT', 'ファイルがありません', { path: '/work/x' }))).toMatchObject({ kind: 'fs-missing', path: '/work/x' })
  })

  it('★ status が数値なら、回線断・時間切れの印があっても数えない（HTTP の応答は返っている）', () => {
    for (const e of [
      Object.assign(new Error('Connection error.'), { status: 502 }),
      Object.assign(new Error('read ECONNRESET'), { status: 429 }),
      Object.assign(new Error('x'), { status: 504, cause: { code: 'ETIMEDOUT' } }),
      Object.assign(new Error('Request timed out.'), { status: 408 }),
    ]) {
      const c = classifyFailure(e)
      expect(c.kind).toBe('unknown')
      expect(typeof c.status).toBe('number')
      expect(failureText(e, { readOnly: true })).toBe(e.message)
    }
  })

  it('★ 状態番号で始まる文面は、本文に network・ECONNRESET があっても数えない', () => {
    for (const msg of ['502 Bad Gateway: upstream read ECONNRESET', head('x', 'Error: 400 network is unreachable'), 'API Error: 404 fetch failed']) {
      expect(classifyFailure(new Error(msg)).kind).toBe('unknown')
    }
  })

  it('★ 日本語を含む文は、文面の判定にかけない（原文のまま）', () => {
    for (const msg of [
      '接続に失敗しました（fetch failed）',
      'ネットワークの設定を見直してください。ECONNRESET ではありません',
      'net::ERR_INTERNET_DISCONNECTED のとき、こう表示します',
      'ENOENT: 見つかりません',
      'Connection error. をお知らせします',
      'The operation was aborted due to timeout という文',
    ]) {
      expect(classifyFailure(new Error(msg)).kind, msg).toBe('unknown')
      expect(failureText(new Error(msg)), msg).toBe(msg)
      expect(failureText(new Error(msg), { readOnly: true }), msg).toBe(msg)
    }
  })

  // 英語の語だけで回線断にしない。日本語の文を見ない守りは connectionFailure.ts の isJudgeableMessage の1か所で、
  // failureText の判定と、回線断の文面の網（isConnectionFailureMessage）の両方が通る
  it('★ 日本語を含む文は、回線断の文面の網（isConnectionFailureMessage・isConnectionFailure）にもかけない', () => {
    for (const msg of ['Docker の network が見つかりません', '接続に失敗しました（fetch failed）', 'ネットワークの設定を見直してください。ECONNRESET ではありません']) {
      expect(isJudgeableMessage(msg), msg).toBe(false)
      expect(isConnectionFailureMessage(msg), msg).toBe(false)
      expect(isConnectionFailure(new Error(msg)), msg).toBe(false)
    }
    // 英語の文は従来どおり（見る）。構造の印（code）があれば、日本語の文でも種類が決まる
    expect(isJudgeableMessage('Connection error.')).toBe(true)
    expect(isConnectionFailureMessage('Connection error.')).toBe(true)
    expect(isConnectionFailure(errno('ECONNRESET', 'ネットワークが切れました network'))).toBe(true)
  })

  it('★ 知らない英語の文は、原文のまま（IPC の頭だけ落ちる）', () => {
    for (const msg of ['Something odd happened', 'HTTP 500 Internal Server Error', 'Unexpected token < in JSON', 'EISDIR: illegal operation on a directory, read']) {
      expect(failureText(new Error(msg))).toBe(msg)
      expect(failureText(msg, { readOnly: true })).toBe(msg)
      expect(failureText(new Error(head('x', `Error: ${msg}`)))).toBe(msg)
    }
    expect(failureText(undefined)).toBe('undefined')
  })
})

describe('文（完全一致）', () => {
  const noRequest = errno('ENOTFOUND', 'getaddrinfo ENOTFOUND api.example.test')
  const unsure = new TypeError('fetch failed')
  const cut = errno('ECONNRESET', 'read ECONNRESET')
  const timeout = errno('ETIMEDOUT', 'connect ETIMEDOUT 203.0.113.5:443')

  it('回線断: 読み取りも、要求が出ていないと言い切れる書き込みも、もう一度お試しください', () => {
    expect(failureText(noRequest, { readOnly: true })).toBe(T_OFFLINE)
    expect(failureText(noRequest)).toBe(T_OFFLINE)
    expect(failureText(unsure, { readOnly: true })).toBe(T_OFFLINE)
  })

  it('★ 書き込みの途中で切れた（かもしれない）ときは「もう一度」と言わず、確かめる場所を言う', () => {
    for (const e of [unsure, cut, timeout]) {
      expect(failureText(e, { checkAt: '📡 公開したもの一覧' })).toBe(T_CUT_WRITE('📡 公開したもの一覧で'))
      expect(failureText(e, { checkAt: 'ファイル一覧' })).toBe(T_CUT_WRITE('ファイル一覧で'))
      expect(failureText(e)).not.toContain('もう一度')
    }
  })

  it('★ checkAt が無い（空も同じ）ときは、この画面を開き直して確かめる', () => {
    const where = T_CUT_WRITE('この画面を開き直して')
    expect(failureText(cut)).toBe(where)
    expect(failureText(cut, {})).toBe(where)
    expect(failureText(cut, { checkAt: '' })).toBe(where)
    expect(failureText(cut, { checkAt: '  ' })).toBe(where)
    expect(where).toBe('通信が途中で切れました。操作が済んだかは確かめられていません。少し待ってから、この画面を開き直して状態を確かめてください。')
  })

  it('読み取りの切れ・時間切れは、混み合っているかもしれない（checkAt は使わない）', () => {
    for (const e of [cut, timeout, new Error('Request timed out.')]) {
      expect(failureText(e, { readOnly: true })).toBe(T_TIMEOUT_READ)
      expect(failureText(e, { readOnly: true, checkAt: 'ファイル一覧' })).toBe(T_TIMEOUT_READ)
    }
  })

  it('安全な接続（TLS）は読み取りも書き込みも同じ文', () => {
    for (const code of ['CERT_HAS_EXPIRED', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
      expect(failureText(errno(code, 'x'))).toBe(T_TLS)
      expect(failureText(errno(code, 'x'), { readOnly: true })).toBe(T_TLS)
    }
    expect(failureText(new TypeError('fetch failed', { cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } }))).toBe(T_TLS)
  })

  it('tail は再試行の言い方だけを替える（チャットは「もう一度送信してください」）', () => {
    const CHAT = 'インターネットに接続できませんでした。接続を確かめてから、もう一度送信してください。'
    expect(failureText(noRequest, { tail: 'もう一度送信してください' })).toBe(CHAT)
    expect(failureText(noRequest, { tail: 'もう一度送信してください。' })).toBe(CHAT)
    expect(failureText(timeout, { readOnly: true, tail: 'もう一度送信してください' }))
      .toBe('時間内に返事がありませんでした。混み合っているかもしれません。少し待ってから、もう一度送信してください。')
    expect(failureText(errno('ENOSPC', 'x'), { tail: 'もう一度保存してください' }))
      .toBe('ディスクの空きが足りません。空きを作ってから、もう一度保存してください。')
    // 書き込みの途中で切れた文には再試行の言い方が入らない
    expect(failureText(cut, { tail: 'もう一度送信してください' })).toBe(T_CUT_WRITE('この画面を開き直して'))
  })
})

describe('connectionFailure.ts の errno の表', () => {
  it('★ 足した errno と TLS の印を、回線断として数える（errno の印・cause の奥）', () => {
    for (const code of ['ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'ECONNABORTED', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
      expect(isConnectionFailure(errno(code, 'x')), code).toBe(true)
      expect(isConnectionFailure({ message: 'x', cause: { code } }), code).toBe(true)
      expect(isConnectionFailure({ message: 'x', cause: { cause: { code } } }), code).toBe(true)
    }
  })

  it('既存の表（ENOTFOUND・ECONNREFUSED・ECONNRESET・ETIMEDOUT・EAI_AGAIN）はそのまま真。HTTP の応答が返った失敗は偽のまま', () => {
    for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN']) {
      expect(isConnectionFailure(errno(code, 'x')), code).toBe(true)
    }
    expect(isConnectionFailure(Object.assign(errno('ECONNRESET', 'x'), { status: 502 }))).toBe(false)
    expect(isConnectionFailure(new Error('something else'))).toBe(false)
  })
})

describe('詳細の行（置き換えた文のすぐ下に原文を添える）', () => {
  it('回線断: 文の最後の行に、原文と符号が残る', () => {
    const e = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.ai.sakura.ad.jp'), { code: 'ENOTFOUND' }) })
    const shown = rawFailureText(e, { readOnly: true })
    expect(shown).toBe(`${T_OFFLINE}\n詳細: fetch failed / getaddrinfo ENOTFOUND api.ai.sakura.ad.jp`)
  })

  it('message が Connection error. だけでも、code から原因が分かる', () => {
    const e = Object.assign(new Error('Connection error.'), { cause: { code: 'ENOTFOUND' } })
    expect(splitFailureDetail(rawFailureText(e, { readOnly: true })).detail).toBe('Connection error. / ENOTFOUND')
  })

  it('安全な接続・フォルダの失敗にも付く', () => {
    expect(splitFailureDetail(rawFailureText(errno('CERT_HAS_EXPIRED', 'certificate has expired'))).detail).toBe('certificate has expired / CERT_HAS_EXPIRED')
    expect(splitFailureDetail(rawFailureText(new Error("EACCES: permission denied, open '/work/a.txt'"))).detail)
      .toBe("EACCES: permission denied, open '/work/a.txt'")
  })

  it('★ 見分けられない失敗（unknown）は原文のままで、詳細を重ねない', () => {
    expect(rawFailureText(new Error('なにか壊れました'))).toBe('なにか壊れました')
    expect(rawFailureText(new Error('boom'))).toBe('boom')
    expect(rawFailureText(Object.assign(new Error('Bad'), { status: 503 }))).toBe('Bad')
  })

  it('★ detail:false なら詳細の行を付けない', () => {
    const e = errno('ENOTFOUND', 'getaddrinfo ENOTFOUND h.example')
    expect(rawFailureText(e, { readOnly: true, detail: false })).toBe(T_OFFLINE)
    expect(rawFailureText(e, { readOnly: true })).toContain('\n詳細: ')
  })
})
