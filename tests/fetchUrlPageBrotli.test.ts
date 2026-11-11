// tests/fetchUrlPageBrotli.test.ts — fetchUrlPage（AI の fetch_url・チャットの URL 読み込み・資料の取り込みが通る所）の
// 通信の仕組みを、手元の偽サーバーで「振る舞いで」固定する（掟10）。
//
// 背景（CVE-2026-111497・Brotli の展開の領域外書き込み）: global fetch（undici）は応答の
// Content-Encoding: br を自動で展開する。根本の直しは Electron の版上げ（別の版）なので、
// それまでは fetchUrlPage が node:http / node:https で読み、gzip・deflate だけ展開し、br と知らない符号化は
// 本文を展開せずに断る。ここでは「br の応答で Brotli の展開が1回も呼ばれない」ことなどを固定する。
//
// 127.0.0.1 は assertFetchAllowed が断るので、名前引き（dns/promises の lookup）を差し替えて公開 IP・内部 IP に見せ、
// http.request の宛先だけを偽サーバーへ向け直す（assertFetchAllowed 自体は本物が動く）。
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import zlib from 'node:zlib'
import type { AddressInfo } from 'node:net'

vi.mock('electron', () => ({ ipcMain: { handle: () => {} } }))
const lookupMock = vi.fn(async (host: string) => {
  if (host.startsWith('internal')) return [{ address: '10.0.0.5', family: 4 }]
  return [{ address: '93.184.216.34', family: 4 }]
})
vi.mock('dns/promises', () => ({ lookup: (host: string) => lookupMock(host), default: { lookup: (host: string) => lookupMock(host) } }))

import { fetchUrlPage } from '../src/main/ipc/web'

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void
let server: http.Server
let port = 0
let targetPort = 0 // 宛先の偽サーバーの port（既定は server。生の TCP の試しでは差し替える）
let handler: Handler = (_q, r) => { r.end('') }
const seenHeaders: http.IncomingHttpHeaders[] = []
const requestedHosts: string[] = []
const realRequest = http.request.bind(http)

beforeAll(async () => {
  server = http.createServer((req, res) => { seenHeaders.push(req.headers); handler(req, res) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
  targetPort = port
  // 宛先だけ偽サーバーへ向け直す（元の URL のホスト名は記録する）
  vi.spyOn(http, 'request').mockImplementation(((url: any, options: any, cb: any) => {
    requestedHosts.push(new URL(url.toString()).hostname)
    return realRequest({ hostname: '127.0.0.1', port: targetPort, path: new URL(url.toString()).pathname + new URL(url.toString()).search, ...options }, cb)
  }) as any)
})
afterAll(async () => { vi.restoreAllMocks(); await new Promise<void>(r => server.close(() => r())) })
afterEach(() => { targetPort = port; vi.useRealTimers(); seenHeaders.length = 0; requestedHosts.length = 0; lookupMock.mockClear() })

/** Brotli の展開が1回でも起きたかを見張る。関数（createBrotliDecompress・brotliDecompress・brotliDecompressSync）と、
 *  クラスの _transform／_processChunk の両方に掛ける。Node の版によって関数を代入で差し替えられないので defineProperty で掛ける。 */
function watchBrotli(): { hits: string[]; restore: () => void } {
  const hits: string[] = []
  const restores: Array<() => void> = []
  const z = zlib as any
  for (const fn of ['createBrotliDecompress', 'brotliDecompress', 'brotliDecompressSync']) {
    const desc = Object.getOwnPropertyDescriptor(z, fn)
    const orig = z[fn]
    Object.defineProperty(z, fn, { configurable: true, enumerable: true, writable: true, value: function (this: unknown, ...a: unknown[]) { hits.push(fn); return orig.apply(this, a) } })
    restores.push(() => { if (desc) Object.defineProperty(z, fn, desc); else delete z[fn] })
  }
  const proto = z.BrotliDecompress.prototype
  const base = Object.getPrototypeOf(Object.getPrototypeOf(proto)) // ZlibBase.prototype（_transform・_processChunk の持ち主）
  for (const m of ['_transform', '_processChunk']) {
    const own = Object.getOwnPropertyDescriptor(proto, m)
    const orig = proto[m] ?? base[m]
    Object.defineProperty(proto, m, { configurable: true, enumerable: false, writable: true, value: function (this: unknown, ...a: unknown[]) { hits.push('BrotliDecompress#' + m); return orig.apply(this, a) } })
    restores.push(() => { if (own) Object.defineProperty(proto, m, own); else delete proto[m] })
  }
  return { hits, restore: () => restores.reverse().forEach(r => r()) }
}

describe('fetchUrlPage: Brotli を展開しない', () => {
  it('Content-Encoding: br の応答は断り、Brotli の展開は1回も呼ばれず、失敗の詳細に原文が残る', async () => {
    const w = watchBrotli()
    const body = zlib.brotliCompressSync(Buffer.from('<html><body>secret</body></html>'))
    handler = (_q, r) => { r.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'br' }); r.end(body) }
    const err = await fetchUrlPage('http://pub.test/a').then(() => null, e => e as Error)
    expect(err).not.toBeNull()
    expect(err!.message).toContain('Koto が読めない圧縮の形式で返ってきたため、読みませんでした。')
    expect(err!.message).toContain('Content-Encoding: br')
    expect(w.hits).toEqual([])
    w.restore()
  })

  it('gzip と組み合わせた br・知らない符号化（zstd）も断る', async () => {
    const w = watchBrotli()
    for (const enc of ['gzip, br', 'zstd', 'compress']) {
      handler = (_q, r) => { r.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': enc }); r.end('x') }
      const err = await fetchUrlPage('http://pub.test/a').then(() => null, e => e as Error)
      expect(err?.message, enc).toContain('読めない圧縮の形式')
      expect(err?.message, enc).toContain(`Content-Encoding: ${enc}`)
    }
    expect(w.hits).toEqual([])
    w.restore()
  })

  it('送る Accept-Encoding は gzip, deflate（br を求めない）', async () => {
    handler = (_q, r) => { r.writeHead(200, { 'Content-Type': 'text/plain' }); r.end('hello') }
    await fetchUrlPage('http://pub.test/a')
    expect(seenHeaders[0]['accept-encoding']).toBe('gzip, deflate')
    expect(String(seenHeaders[0]['accept-encoding'])).not.toMatch(/br/i)
    expect(seenHeaders[0]['user-agent']).toContain('SakuraIDE')
  })
})

describe('fetchUrlPage: 読める符号化', () => {
  it('identity・なし・gzip・x-gzip・deflate は読める', async () => {
    const html = '<html><head><title>題</title></head><body><p>本文です</p></body></html>'
    const cases: Array<[string | null, Buffer]> = [
      [null, Buffer.from(html)],
      ['identity', Buffer.from(html)],
      ['gzip', zlib.gzipSync(html)],
      ['x-gzip', zlib.gzipSync(html)],
      ['deflate', zlib.deflateSync(html)],
    ]
    for (const [enc, body] of cases) {
      handler = (_q, r) => {
        r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...(enc ? { 'Content-Encoding': enc } : {}) })
        r.end(body)
      }
      const page = await fetchUrlPage('http://pub.test/p')
      expect(page.title, String(enc)).toBe('題')
      expect(page.content, String(enc)).toContain('本文です')
      expect(page.url, String(enc)).toBe('http://pub.test/p')
    }
  })

  it('content-type が HTML でなくても本文の先頭が < なら HTML として読む／JSON・テキストはそのまま', async () => {
    handler = (_q, r) => { r.writeHead(200, { 'Content-Type': 'application/octet-stream' }); r.end('<b>こんにちは</b>') }
    expect((await fetchUrlPage('http://pub.test/a')).content).toBe('こんにちは')
    handler = (_q, r) => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end('{"a":1}') }
    const j = await fetchUrlPage('http://pub.test/a')
    expect(j).toEqual({ url: 'http://pub.test/a', title: '', content: '{"a":1}' })
  })

  it('maxChars で切る', async () => {
    handler = (_q, r) => { r.writeHead(200, { 'Content-Type': 'text/plain' }); r.end('あ'.repeat(500)) }
    expect((await fetchUrlPage('http://pub.test/a', { maxChars: 100 })).content).toHaveLength(100)
  })
})

describe('fetchUrlPage: リダイレクトと内部 IP の守り', () => {
  it('各ホップで assertFetchAllowed が働く（名前引きがホップごとに呼ばれる）／相対 Location は絶対にする／返る url は最後のホップ', async () => {
    handler = (q, r) => {
      if (q.url === '/start') { r.writeHead(302, { Location: '/mid' }); r.end() }
      else if (q.url === '/mid') { r.writeHead(301, { Location: 'http://other.test/end' }); r.end() }
      else { r.writeHead(200, { 'Content-Type': 'text/plain' }); r.end('着いた') }
    }
    const page = await fetchUrlPage('http://pub.test/start')
    expect(page.url).toBe('http://other.test/end')
    expect(page.content).toBe('着いた')
    expect(lookupMock.mock.calls.map(c => c[0])).toEqual(['pub.test', 'pub.test', 'other.test'])
  })

  it('内部 IP へ向かうホップは断り、そのホップへは要求を出さない', async () => {
    handler = (_q, r) => { r.writeHead(302, { Location: 'http://internal.test/meta' }); r.end() }
    await expect(fetchUrlPage('http://pub.test/a')).rejects.toThrow('内部ネットワーク')
    expect(requestedHosts).toEqual(['pub.test'])
  })

  it('最初から内部 IP（直書き）も断る', async () => {
    await expect(fetchUrlPage('http://169.254.169.254/latest')).rejects.toThrow('内部ネットワーク')
    expect(requestedHosts).toEqual([])
  })

  it('リダイレクトは5回まで（6回目で断る）。5回目までは辿れる', async () => {
    let n = 0
    handler = (_q, r) => { n++; r.writeHead(302, { Location: `/r${n}` }); r.end() }
    await expect(fetchUrlPage('http://pub.test/a')).rejects.toThrow('リダイレクトが多すぎます（5回まで）')
    expect(requestedHosts).toHaveLength(6)
    n = 0
    handler = (q, r) => {
      if (n < 5) { n++; r.writeHead(302, { Location: `/r${n}` }); r.end() }
      else { r.writeHead(200, { 'Content-Type': 'text/plain' }); r.end('ok') }
    }
    expect((await fetchUrlPage('http://pub.test/a')).content).toBe('ok')
  })

  it('3xx で Location が無ければ、そのまま扱う（2xx でないので HTTP の失敗）', async () => {
    handler = (_q, r) => { r.writeHead(304); r.end() }
    await expect(fetchUrlPage('http://pub.test/a')).rejects.toThrow('ページを取得できませんでした（HTTP 304）')
  })

  it('http/https 以外は断る', async () => {
    await expect(fetchUrlPage('file:///etc/passwd')).rejects.toThrow('http/https のURLのみ取得できます')
    await expect(fetchUrlPage('ftp://pub.test/a')).rejects.toThrow('http/https のURLのみ取得できます')
  })
})

describe('fetchUrlPage: 失敗・上限・時間切れ', () => {
  it('2xx でない応答は「ページを取得できませんでした（HTTP n）」', async () => {
    for (const code of [404, 500]) {
      handler = (_q, r) => { r.writeHead(code, { 'Content-Type': 'text/html' }); r.end('<html>err</html>') }
      await expect(fetchUrlPage('http://pub.test/a')).rejects.toThrow(`ページを取得できませんでした（HTTP ${code}）`)
    }
  })

  it('読む量に上限がある（巨大な本文を読み切らずに切る）', async () => {
    const CHUNK = Buffer.alloc(64 * 1024, 0x61)
    const TOTAL = 400 * 1024 * 1024
    let written = 0
    let closed = false
    handler = (_q, r) => {
      r.writeHead(200, { 'Content-Type': 'text/plain' })
      r.on('close', () => { closed = true })
      const pump = (): void => {
        while (!closed && written < TOTAL) {
          written += CHUNK.length
          if (!r.write(CHUNK)) { r.once('drain', pump); return }
        }
        if (!closed) r.end()
      }
      pump()
    }
    const page = await fetchUrlPage('http://pub.test/big', { maxChars: 1000 })
    expect(page.content).toHaveLength(1000)
    await new Promise(r => setTimeout(r, 100))
    expect(closed).toBe(true)
    expect(written).toBeLessThan(TOTAL / 2) // 読み切らずに接続を切った
  })

  it('gzip の爆弾（小さく圧縮された巨大な本文）でも展開は上限で止まる', async () => {
    const bomb = zlib.gzipSync(Buffer.alloc(256 * 1024 * 1024, 0x61))
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024)
    handler = (_q, r) => { r.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' }); r.end(bomb) }
    const before = process.memoryUsage().rss
    const page = await fetchUrlPage('http://pub.test/bomb', { maxChars: 1000 })
    expect(page.content).toHaveLength(1000)
    expect(process.memoryUsage().rss - before).toBeLessThan(200 * 1024 * 1024)
  })

  it('15 秒で時間切れ（応答が来ないとき）', async () => {
    handler = () => { /* 応答しない */ }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const p = fetchUrlPage('http://pub.test/slow')
    const settled = p.then(() => null, e => e as Error)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(15001)
    const err = await settled
    expect(err?.name).toBe('TimeoutError')
  })

  it('本文の途中で止まっても（ヘッダ後に送らない）15 秒で時間切れ', async () => {
    handler = (_q, r) => { r.writeHead(200, { 'Content-Type': 'text/plain' }); r.write('途中') }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const settled = fetchUrlPage('http://pub.test/slow2').then(() => null, e => e as Error)
    await vi.advanceTimersByTimeAsync(0)
    await new Promise(r => setImmediate(r))
    await vi.advanceTimersByTimeAsync(15001)
    expect((await settled)?.name).toBe('TimeoutError')
  })
})

describe('fetchUrlPage: Brotli の見張りの確かめ・重複した符号化・3xx の本文', () => {
  it('見張りは本物の Brotli の展開を捕まえる（見張りが空振りでないこと）', async () => {
    const w = watchBrotli()
    try {
      zlib.brotliDecompressSync(zlib.brotliCompressSync(Buffer.from('x')))
      const s = zlib.createBrotliDecompress()
      s.end(zlib.brotliCompressSync(Buffer.from('y')))
      s.resume()
      await new Promise(r => s.once('end', r)) // 非同期の展開が見張りの外へ漏れないよう、終わるまで待つ
      expect(w.hits).toContain('brotliDecompressSync')
      expect(w.hits).toContain('createBrotliDecompress')
      expect(w.hits).toContain('BrotliDecompress#_transform')
    } finally { w.restore() }
  })

  it('Content-Encoding が2本の重複（gzip と br）でも断り、Brotli は展開しない', async () => {
    const w = watchBrotli()
    try {
      handler = (_q, r) => { r.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': ['gzip', 'br'] }); r.end(zlib.gzipSync('x')) }
      const err = await fetchUrlPage('http://pub.test/a').then(() => null, e => e as Error)
      expect(err?.message).toContain('読めない圧縮の形式')
      expect(err?.message).toContain('Content-Encoding: gzip, br')
      expect(w.hits).toEqual([])
    } finally { w.restore() }
  })

  it('3xx の本文が br でも、本文は読まずに次のホップへ進む（Brotli は展開しない）', async () => {
    const w = watchBrotli()
    try {
      handler = (q, r) => {
        if (q.url === '/start') { r.writeHead(302, { Location: '/end', 'Content-Encoding': 'br' }); r.end(zlib.brotliCompressSync(Buffer.from('redirect body'))) }
        else { r.writeHead(200, { 'Content-Type': 'text/plain' }); r.end('着いた') }
      }
      expect((await fetchUrlPage('http://pub.test/start')).content).toBe('着いた')
      expect(w.hits).toEqual([])
    } finally { w.restore() }
  })

  it('エラー応答（404）の本文が br でも、HTTP の失敗として断る（Brotli は展開しない）', async () => {
    const w = watchBrotli()
    try {
      handler = (_q, r) => { r.writeHead(404, { 'Content-Encoding': 'br' }); r.end(zlib.brotliCompressSync(Buffer.from('nf'))) }
      await expect(fetchUrlPage('http://pub.test/a')).rejects.toThrow('ページを取得できませんでした（HTTP 404）')
      expect(w.hits).toEqual([])
    } finally { w.restore() }
  })

  it('断る文に入る Content-Encoding の値は、制御文字を落として80字までに切る', async () => {
    // 制御文字（タブ）を含む長い値は、Node の偽サーバーでは送れないので、生の TCP で返す
    const raw = net.createServer((sock) => {
      sock.once('data', () => {
        sock.end('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Encoding: zz\tyy' + 'a'.repeat(200) + '\r\nContent-Length: 1\r\n\r\nx')
      })
    })
    await new Promise<void>(r => raw.listen(0, '127.0.0.1', r))
    targetPort = (raw.address() as AddressInfo).port
    try {
      const err = await fetchUrlPage('http://pub.test/a').then(() => null, e => e as Error)
      const m = err!.message.match(/Content-Encoding: (.*)$/)
      expect(m).not.toBeNull()
      expect(m![1]).not.toMatch(/[\u0000-\u001f]/)
      expect(m![1].length).toBeLessThanOrEqual(80)
      expect(m![1].startsWith('zzyy')).toBe(true)
    } finally { await new Promise<void>(r => raw.close(() => r())) }
  })
})

describe('fetchUrlPage: 以前の fetch が読めていた展開', () => {
  it('空の本文で gzip を名乗る応答は、空文字として読む', async () => {
    for (const enc of ['gzip', 'deflate']) {
      handler = (_q, r) => { r.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': enc, 'Content-Length': '0' }); r.end() }
      expect(await fetchUrlPage('http://pub.test/e'), enc).toEqual({ url: 'http://pub.test/e', title: '', content: '' })
    }
  })

  it('途中で切れた gzip・deflate は、読めたところまで返す', async () => {
    const text = '途中まで読める本文。'.repeat(2000)
    const gz = zlib.gzipSync(text)
    const df = zlib.deflateSync(text)
    for (const [enc, full] of [['gzip', gz], ['deflate', df]] as const) {
      const cut = full.subarray(0, Math.floor(full.length * 0.6))
      handler = (_q, r) => { r.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': enc }); r.end(cut) }
      const page = await fetchUrlPage('http://pub.test/t', { maxChars: 1_000_000 })
      expect(page.content.length, enc).toBeGreaterThan(100)
      expect(text.startsWith(page.content.slice(0, page.content.length - 2)), enc).toBe(true)
    }
  })

  it('生の deflate（zlib の頭が無い）も読める', async () => {
    const html = '<html><head><title>生</title></head><body>生の deflate</body></html>'
    const raw = zlib.deflateRawSync(html)
    expect(raw[0] & 0x0f).not.toBe(8) // 試しの前提: 頭つきの形ではない
    handler = (_q, r) => { r.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'deflate' }); r.end(raw) }
    const page = await fetchUrlPage('http://pub.test/raw')
    expect(page.title).toBe('生')
    expect(page.content).toContain('生の deflate')
  })

  it('壊れた gzip（途中切れではなく中身が違う）は失敗として返す', async () => {
    handler = (_q, r) => { r.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' }); r.end(Buffer.from('これは gzip ではない')) }
    await expect(fetchUrlPage('http://pub.test/bad')).rejects.toThrow()
  })
})

describe('fetchUrlPage: 読む量の上限が外れない', () => {
  async function bigServer(): Promise<{ written: () => number; closed: () => boolean }> {
    const CHUNK = Buffer.alloc(64 * 1024, 0x61)
    const TOTAL = 200 * 1024 * 1024
    let written = 0
    let closed = false
    handler = (_q, r) => {
      written = 0
      closed = false
      r.writeHead(200, { 'Content-Type': 'text/plain' })
      r.on('close', () => { closed = true })
      const pump = (): void => {
        while (!closed && written < TOTAL) {
          written += CHUNK.length
          if (!r.write(CHUNK)) { r.once('drain', pump); return }
        }
        if (!closed) r.end()
      }
      pump()
    }
    return { written: () => written, closed: () => closed }
  }

  it('maxChars が Infinity・NaN・0・負・数でない値のときは既定（12000 字）で切り、読むのも2MB台で止める', async () => {
    for (const bad of [Infinity, -Infinity, NaN, 0, -5, '99999' as unknown as number, null as unknown as number]) {
      const st = await bigServer()
      const page = await fetchUrlPage('http://pub.test/big', { maxChars: bad })
      expect(page.content, String(bad)).toHaveLength(12000)
      await new Promise(r => setTimeout(r, 100))
      expect(st.closed(), String(bad)).toBe(true)
      expect(st.written(), String(bad)).toBeLessThan(32 * 1024 * 1024)
    }
  })

  it('maxChars が 1e9 でも、読むのは 8MB の天井まで（その先は読まずに切る）', async () => {
    const st = await bigServer()
    const page = await fetchUrlPage('http://pub.test/big', { maxChars: 1e9 })
    expect(page.content.length).toBeLessThanOrEqual(8 * 1024 * 1024)
    expect(page.content.length).toBeGreaterThan(7 * 1024 * 1024)
    await new Promise(r => setTimeout(r, 100))
    expect(st.closed()).toBe(true)
    expect(st.written()).toBeLessThan(40 * 1024 * 1024)
  })

  it('有限の大きい値（200000）はそのまま使える', async () => {
    handler = (_q, r) => { r.writeHead(200, { 'Content-Type': 'text/plain' }); r.end('あ'.repeat(300000)) }
    expect((await fetchUrlPage('http://pub.test/a', { maxChars: 200000 })).content).toHaveLength(200000)
  })

  it('IPC の入口（web:fetch ハンドラ）から来た maxChars も同じ判断を通る', async () => {
    vi.resetModules()
    let registered: ((e: unknown, url: string, opts?: { maxChars?: number }) => Promise<{ content: string }>) | null = null
    vi.doMock('electron', () => ({ ipcMain: { handle: (ch: string, fn: any) => { if (ch === 'web:fetch') registered = fn } } }))
    const mod = await import('../src/main/ipc/web')
    mod.registerWebHandlers({} as any)
    expect(registered).not.toBeNull()
    handler = (_q, r) => { r.writeHead(200, { 'Content-Type': 'text/plain' }); r.end('あ'.repeat(50000)) }
    expect((await registered!(null, 'http://pub.test/a', { maxChars: Infinity })).content).toHaveLength(12000)
    expect((await registered!(null, 'http://pub.test/a', { maxChars: NaN })).content).toHaveLength(12000)
    expect((await registered!(null, 'http://pub.test/a', undefined)).content).toHaveLength(12000)
    expect((await registered!(null, 'http://pub.test/a', { maxChars: 20000 })).content).toHaveLength(20000)
    vi.doUnmock('electron')
  })
})

describe('fetchUrlPage: 以前の fetch が断っていたものを断る', () => {
  it('Fetch の仕様の禁止ポートは断り、要求を出さない', async () => {
    for (const p of [1, 22, 25, 6000, 6667, 10080]) {
      await expect(fetchUrlPage(`http://pub.test:${p}/a`), String(p)).rejects.toThrow('このポート番号へはアクセスできません')
    }
    expect(requestedHosts).toEqual([])
  })

  it('禁止でないポートは通る（80・8080・443 の既定）', async () => {
    handler = (_q, r) => { r.writeHead(200, { 'Content-Type': 'text/plain' }); r.end('ok') }
    expect((await fetchUrlPage('http://pub.test:8080/a')).content).toBe('ok')
    expect((await fetchUrlPage('http://pub.test:80/a')).content).toBe('ok')
  })

  it('利用者名・パスワードを含む URL は断り、要求を出さない', async () => {
    for (const u of ['http://user:pass@pub.test/a', 'http://user@pub.test/a', 'http://:pass@pub.test/a']) {
      await expect(fetchUrlPage(u), u).rejects.toThrow('利用者名・パスワードを含むURL')
    }
    expect(requestedHosts).toEqual([])
  })

  it('リダイレクト先が資格情報つき・禁止ポートなら、そのホップへは要求を出さない', async () => {
    handler = (_q, r) => { r.writeHead(302, { Location: 'http://u:p@other.test/x' }); r.end() }
    await expect(fetchUrlPage('http://pub.test/a')).rejects.toThrow('利用者名・パスワードを含むURL')
    handler = (_q, r) => { r.writeHead(302, { Location: 'http://other.test:6667/x' }); r.end() }
    await expect(fetchUrlPage('http://pub.test/a')).rejects.toThrow('このポート番号へはアクセスできません')
    expect(requestedHosts).toEqual(['pub.test', 'pub.test'])
  })
})
