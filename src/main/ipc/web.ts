// Web取得/検索の IPC（web:fetch / web:search）。SSRFガード（isBlockedIp 等）もここに移動。deps は使わない。
import { ipcMain } from 'electron'
import { lookup } from 'dns/promises'
import net from 'net'
import http from 'node:http'
import https from 'node:https'
import zlib from 'node:zlib'
import { PassThrough, type Readable } from 'node:stream'
import { withFailureDetail } from '../../shared/failureText'
import type { IpcDeps } from './types'

// ── Webページの取得（AIに本文を渡すため。メインプロセスなのでCORS制約なし） ──
const FETCH_MAX_CHARS = 12000 // AIに渡す本文の上限（トークン費用の暴走防止）

/** ごく簡易なHTML→テキスト変換（依存パッケージなしで本文を抽出する） */
function htmlToText(html: string): { title: string; text: string } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? ''
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  t = t
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
  return { title, text: t }
}

/** 内部ネットワーク／メタデータ／予約済みのIPアドレスか（true=遮断） */
function isBlockedIp(ip: string): boolean {
  const v = net.isIP(ip)
  if (v === 4) {
    const p = ip.split('.').map(Number)
    if (p.length !== 4 || p.some(n => Number.isNaN(n))) return true
    const [a, b] = p
    if (a === 127) return true                       // 127.0.0.0/8 ループバック
    if (a === 10) return true                         // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true  // 172.16.0.0/12
    if (a === 192 && b === 168) return true           // 192.168.0.0/16
    if (a === 169 && b === 254) return true           // 169.254.0.0/16 リンクローカル/メタデータ
    if (a === 0) return true                          // 0.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
    return false
  }
  if (v === 6) {
    const lower = ip.toLowerCase()
    // IPv4射影（::ffff:x.x.x.x）は内側のIPv4で判定
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isBlockedIp(mapped[1])
    if (lower === '::1') return true                  // ループバック
    if (lower === '::') return true                   // unspecified
    if (/^f[cd]/.test(lower)) return true             // fc00::/7 ULA
    if (/^fe[89ab]/.test(lower)) return true          // fe80::/10 リンクローカル
    return false
  }
  return true // 解析不能なものは遮断側に倒す
}

/** Fetch の仕様の禁止ポート（ブラウザ・undici が接続を断る一覧）。
 *  出典: undici 6.27.0 の lib/web/fetch/constants.js の badPorts（Fetch Standard の bad port blocking）を写した。 */
const FETCH_BAD_PORTS: ReadonlySet<string> = new Set([
  '1', '7', '9', '11', '13', '15', '17', '19', '20', '21', '22', '23', '25', '37', '42', '43', '53', '69', '77', '79',
  '87', '95', '101', '102', '103', '104', '109', '110', '111', '113', '115', '117', '119', '123', '135', '137',
  '139', '143', '161', '179', '389', '427', '465', '512', '513', '514', '515', '526', '530', '531', '532',
  '540', '548', '554', '556', '563', '587', '601', '636', '989', '990', '993', '995', '1719', '1720', '1723',
  '2049', '3659', '4045', '4190', '5060', '5061', '6000', '6566', '6665', '6666', '6667', '6668', '6669', '6679',
  '6697', '10080',
])

/** fetch 対象URLが安全か検証する。内部IPを指すホスト・禁止ポート・資格情報つきURLは拒否。 */
async function assertFetchAllowed(rawUrl: string): Promise<void> {
  let u: URL
  try { u = new URL(rawUrl) } catch { throw new Error('URLの形式が正しくありません') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('http/https のURLのみ取得できます')
  // 以前の global fetch（undici）が断っていたものを、自前の通信でも同じに断る
  if (u.username !== '' || u.password !== '') throw new Error('安全のため、利用者名・パスワードを含むURLは取得できません')
  if (u.port !== '' && FETCH_BAD_PORTS.has(u.port)) throw new Error('安全のため、このポート番号へはアクセスできません')
  const host = u.hostname
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error('安全のため、内部ネットワークのアドレスへはアクセスできません')
    return
  }
  const addrs = await lookup(host, { all: true })
  if (addrs.some(a => isBlockedIp(a.address))) {
    throw new Error('安全のため、内部ネットワークのアドレスへはアクセスできません')
  }
}

// ── Web検索（Tavily / Brave。AIの search_web ツールから使用） ──
type SearchResult = { title: string; url: string; description: string }

async function searchBrave(key: string, query: string): Promise<SearchResult[]> {
  const u = new URL('https://api.search.brave.com/res/v1/web/search')
  u.searchParams.set('q', query)
  u.searchParams.set('count', '5')
  u.searchParams.set('country', 'JP')
  u.searchParams.set('search_lang', 'jp')
  const res = await fetch(u, {
    headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  })
  if (res.status === 401 || res.status === 403) throw new Error('Brave検索のAPIキーが無効です（認証情報画面で確認してください）')
  if (res.status === 429) throw new Error('Brave検索の利用制限に達しました（無料クレジットは毎月$5で、約1,000回です）')
  if (!res.ok) throw new Error(`Brave検索に失敗しました（HTTP ${res.status}）`)
  const data: any = await res.json()
  return (data.web?.results ?? []).slice(0, 5).map((r: any) => ({
    title: String(r.title ?? ''),
    url: String(r.url ?? ''),
    description: String(r.description ?? '').replace(/<[^>]+>/g, ''), // ハイライトタグを除去
  }))
}

async function searchTavily(key: string, query: string): Promise<SearchResult[]> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: 5, search_depth: 'basic' }),
    signal: AbortSignal.timeout(20000),
  })
  if (res.status === 401 || res.status === 403) throw new Error('TavilyのAPIキーが無効です（認証情報画面で確認してください）')
  if (res.status === 429 || res.status === 432) throw new Error('Tavilyの利用制限に達しました（無料枠は月1,000回）')
  if (!res.ok) throw new Error(`Tavily検索に失敗しました（HTTP ${res.status}）`)
  const data: any = await res.json()
  return (data.results ?? []).slice(0, 5).map((r: any) => ({
    title: String(r.title ?? ''),
    url: String(r.url ?? ''),
    description: String(r.content ?? '').slice(0, 400), // Tavilyは本文抜粋を返す
  }))
}

// web:fetch ハンドラの応答型（renderer 側 web.fetchPage の戻り値と一致させること）
export type FetchedPage = { url: string; title: string; content: string }

// ── 通信（node:http / node:https）。global fetch・Electron の net は使わない ──
// 理由: CVE-2026-111497（Brotli の展開の領域外書き込み）。global fetch（undici）は Content-Encoding: br を
// 自動で展開する。この展開を Electron の版上げ（別の版）まで通さないための緩和であり、Electron 側の Brotli の
// 修正を確かめたものではない。node:http は自動で展開しないので、Accept-Encoding は gzip, deflate だけを送り、
// gzip・deflate だけ自分で展開し、br と知らない符号化は本文を1バイトも展開せずに断る。
// 対象はこの fetchUrlPage の経路だけ。search_web（Brave・Tavily）は固定の API を global fetch で読むので対象外。
const FETCH_TIMEOUT_MS = 15000
const FETCH_MIN_BYTES = 2 * 1024 * 1024 // 展開後に読む量の下限（上限は maxChars に見合う大きさ）
const FETCH_MAX_BYTES_CEILING = 8 * 1024 * 1024 // どんな maxChars でも超えない天井

// 途中で切れた応答は読めたところまで返す（Z_SYNC_FLUSH）。以前の global fetch（undici）と同じ。Brotli はここでも使わない。
const ZLIB_OPTS = { finishFlush: zlib.constants.Z_SYNC_FLUSH }

/** 断る文に入れる Content-Encoding の値。サーバー任せの値なので、制御文字を落として80字までに切る。 */
function safeEncodingForMessage(enc: string): string {
  // eslint-disable-next-line no-control-regex
  return enc.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 80)
}

type Inflater = zlib.Gunzip | zlib.Inflate | zlib.InflateRaw

/** 最初のチャンクを見て展開器を選び、残りを流し込む。本文が1バイトも無ければ空として読む（以前の undici と同じ）。 */
function openInflate(res: Readable, pick: (first: Buffer) => Inflater): Readable {
  const out = new PassThrough()
  let started = false
  res.once('data', (first: Buffer) => {
    started = true
    const z = pick(first)
    z.on('error', (e) => out.destroy(e))
    out.on('close', () => z.destroy())
    z.pipe(out)
    z.write(first)
    res.pipe(z)
  })
  res.once('end', () => { if (!started) out.end() })
  return out
}

const openGunzip = (res: Readable): Readable => openInflate(res, () => zlib.createGunzip(ZLIB_OPTS))

/** deflate は zlib の頭つき（先頭バイトの下位4ビットが 8）と頭なしの生の2通りがある。先頭の1バイトで見分ける。 */
const openDeflate = (res: Readable): Readable =>
  openInflate(res, (first) => ((first[0] & 0x0f) === 8 ? zlib.createInflate(ZLIB_OPTS) : zlib.createInflateRaw(ZLIB_OPTS)))

type FetchedHop = { status: number; location: string | null; ctype: string; text: string }

function requestOnce(current: string, maxBytes: number): Promise<FetchedHop> {
  return new Promise<FetchedHop>((resolve, reject) => {
    const u = new URL(current)
    const mod = u.protocol === 'https:' ? https : http
    let done = false
    const finish = (fn: () => void): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      fn()
    }
    const req = mod.request(u, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh) SakuraIDE/0.1',
        Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
      },
    }, (res) => {
      const status = res.statusCode ?? 0
      const header = (name: string): string => {
        const v = res.headers[name]
        return Array.isArray(v) ? v.join(', ') : (v ?? '')
      }
      const ctype = header('content-type')
      if (status < 200 || status >= 300) {
        // 本文は読まない（リダイレクト・エラーの応答）
        const location = header('location') || null
        res.destroy()
        finish(() => resolve({ status, location, ctype, text: '' }))
        return
      }
      const enc = header('content-encoding').trim().toLowerCase()
      let stream: Readable = res
      if (enc === '' || enc === 'identity') {
        // そのまま読む
      } else if (enc === 'gzip' || enc === 'x-gzip' || enc === 'deflate') {
        stream = enc === 'deflate' ? openDeflate(res) : openGunzip(res)
      } else {
        // br を含む・知らない符号化は、1バイトも展開せずに切る
        res.destroy()
        finish(() => reject(new Error(withFailureDetail(
          'このページは、Koto が読めない圧縮の形式で返ってきたため、読みませんでした。',
          new Error(`Content-Encoding: ${safeEncodingForMessage(enc)}`),
        ))))
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      const complete = (): void => finish(() => resolve({ status, location: null, ctype, text: Buffer.concat(chunks).toString('utf8') }))
      stream.on('data', (chunk: Buffer) => {
        if (done) return
        const room = maxBytes - total
        if (chunk.length >= room) {
          chunks.push(chunk.subarray(0, room))
          total = maxBytes
          res.destroy()
          stream.destroy()
          complete() // 上限に達したら読み切らずに切る
          return
        }
        chunks.push(chunk)
        total += chunk.length
      })
      stream.on('end', complete)
      stream.on('error', (e) => finish(() => reject(e)))
      res.on('error', (e) => finish(() => reject(e)))
      res.on('close', () => {
        if (!res.complete) finish(() => reject(new Error('接続が途中で切れました')))
      })
    })
    const timer = setTimeout(() => {
      const err = new Error('The operation was aborted due to timeout')
      err.name = 'TimeoutError'
      req.destroy()
      finish(() => reject(err))
    }, FETCH_TIMEOUT_MS)
    req.on('error', (e) => finish(() => reject(e)))
    req.end()
  })
}

/**
 * 指定URLのWebページ本文を取得する（web:fetch ハンドラの実体）。
 * main プロセス内で完結する処理のため、Claude頭脳モード（C2b）の fetch_url MCPツール
 * （src/main/claude/tools.ts）からも IPC を経由せず直接呼び出して共用する（挙動は完全に同一）。
 *
 * opts.maxChars: 本文の切詰め上限。省略時は既定の FETCH_MAX_CHARS（AIの文脈に渡す用の12000）のまま。
 * 資料パック取り込み（📚 資料）やナレッジコレクター（R3）など、行き先がRAG書庫でトークン費用が
 * 発生しない用途は、呼び出し側が明示的に大きい値（例: 200000）を渡す。
 */
export async function fetchUrlPage(url: string, opts?: { maxChars?: number }): Promise<FetchedPage> {
  // renderer から IPC（web:fetch）で来る値もここを通る。有限で正の数だけ使い、それ以外（Infinity・NaN・0・負・数でない値）は既定。
  const rawMax = opts?.maxChars
  const maxChars = typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax > 0 ? rawMax : FETCH_MAX_CHARS
  if (!/^https?:\/\//i.test(url)) throw new Error('http/https のURLのみ取得できます')
  const maxBytes = Math.min(FETCH_MAX_BYTES_CEILING, Math.max(FETCH_MIN_BYTES, maxChars * 8))
  // 手動でリダイレクトを辿り、各ホップで内部IP宛てでないか検証する（リダイレクト経由のSSRF対策）
  let current = url
  let res: FetchedHop | null = null
  for (let hop = 0; hop <= 5; hop++) {
    await assertFetchAllowed(current)
    const r = await requestOnce(current, maxBytes)
    if (r.status >= 300 && r.status < 400) {
      if (!r.location) { res = r; break } // 3xxだがLocation無し → そのまま扱う
      current = new URL(r.location, current).toString()
      continue
    }
    res = r
    break
  }
  if (!res) throw new Error('リダイレクトが多すぎます（5回まで）')
  if (!(res.status >= 200 && res.status < 300)) throw new Error(`ページを取得できませんでした（HTTP ${res.status}）`)
  const raw = res.text
  if (/html/i.test(res.ctype) || /^\s*</.test(raw)) {
    const { title, text } = htmlToText(raw)
    return { url: current, title, content: text.slice(0, maxChars) }
  }
  // プレーンテキスト・JSON等はそのまま（上限のみ適用）
  return { url: current, title: '', content: raw.slice(0, maxChars) }
}

/**
 * Web検索を実行する（web:search ハンドラの実体）。provider 分岐は現行のまま。
 * B'-3d-2b: main の io（buildMainIo・src/main/chat/turnRunner.ts）が io.webSearch として
 * そのまま直呼びする。
 */
export async function webSearch(provider: 'tavily' | 'brave', key: string, query: string): Promise<SearchResult[]> {
  return provider === 'tavily' ? searchTavily(key, query) : searchBrave(key, query)
}

export function registerWebHandlers(_deps: IpcDeps) {
  ipcMain.handle('web:fetch', async (_, url: string, opts?: { maxChars?: number }) => fetchUrlPage(url, opts))

  ipcMain.handle('web:search', async (_, args: { provider: 'tavily' | 'brave'; key: string; query: string }) =>
    webSearch(args.provider, args.key, args.query))
}
