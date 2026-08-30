// Web取得/検索の IPC（web:fetch / web:search）。SSRFガード（isBlockedIp 等）もここに移動。deps は使わない。
import { ipcMain } from 'electron'
import { lookup } from 'dns/promises'
import net from 'net'
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

/** fetch 対象URLが安全か検証する。内部IPを指すホストは拒否。 */
async function assertFetchAllowed(rawUrl: string): Promise<void> {
  let u: URL
  try { u = new URL(rawUrl) } catch { throw new Error('URLの形式が正しくありません') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('http/https のURLのみ取得できます')
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
  if (res.status === 429) throw new Error('Brave検索の利用制限に達しました（無料クレジットは毎月$5＝約1,000回）')
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
  const maxChars = opts?.maxChars ?? FETCH_MAX_CHARS
  if (!/^https?:\/\//i.test(url)) throw new Error('http/https のURLのみ取得できます')
  // 手動でリダイレクトを辿り、各ホップで内部IP宛てでないか検証する（リダイレクト経由のSSRF対策）
  let current = url
  let res: Response | null = null
  for (let hop = 0; hop <= 5; hop++) {
    await assertFetchAllowed(current)
    const r = await fetch(current, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) SakuraIDE/0.1', Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' },
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    })
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location')
      if (!loc) { res = r; break } // 3xxだがLocation無し → そのまま扱う
      current = new URL(loc, current).toString()
      continue
    }
    res = r
    break
  }
  if (!res) throw new Error('リダイレクトが多すぎます（5回まで）')
  if (!res.ok) throw new Error(`ページを取得できませんでした（HTTP ${res.status}）`)
  const ctype = res.headers.get('content-type') ?? ''
  const raw = await res.text()
  if (/html/i.test(ctype) || /^\s*</.test(raw)) {
    const { title, text } = htmlToText(raw)
    return { url: res.url || current, title, content: text.slice(0, maxChars) }
  }
  // プレーンテキスト・JSON等はそのまま（上限のみ適用）
  return { url: res.url || current, title: '', content: raw.slice(0, maxChars) }
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
