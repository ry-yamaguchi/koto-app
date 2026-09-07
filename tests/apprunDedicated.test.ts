import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import type { Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  getLimits,
  getWorkerClasses,
  getLbClasses,
  listClusters,
  APPRUN_DEDICATED_API_BASE,
} from '../src/main/cloud/apprunDedicated'

// roadmap #23 段階①「下調べ画面」。この段階は GET のみで、クラスタもアプリも作らない。
// **実APIは叩かない。** tests/sakuraEngine.test.ts と同じく、ローカルに本物の http サーバを
// 立てて実物のクライアントに対して確かめる（fetchをモックしない）。

let server: Server | null = null

afterEach(() => {
  if (server) { server.close(); server = null }
})

/** ローカルに http サーバを立てて空きポートで listen し、baseUrl（末尾スラッシュ付き）を返す。 */
function listen(handler: http.RequestListener): Promise<string> {
  return new Promise((resolve, reject) => {
    server = http.createServer(handler)
    server.listen(0, () => {
      const addr = server?.address()
      if (addr && typeof addr === 'object') resolve(`http://127.0.0.1:${addr.port}/`)
      else reject(new Error('サーバのポートを取得できませんでした'))
    })
  })
}

const AUTH = { token: 'my-token', secret: 'my-secret' }

describe('ベースURLは定数（実APIキーでの疎通時に確認済み）', () => {
  it('ゾーンを含まない apprun-dedicated/1.0 のURL', () => {
    expect(APPRUN_DEDICATED_API_BASE).toBe('https://secure.sakura.ad.jp/cloud/api/apprun-dedicated/1.0/')
  })
})

describe('listClusters: maxItems=20 が必ず付く（付け忘れると実APIで400になる実測あり）', () => {
  it('リクエストURLに ?maxItems=20 が含まれる', async () => {
    let seenUrl = ''
    const baseUrl = await listen((req, res) => {
      seenUrl = req.url ?? ''
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ clusters: [] }))
    })
    const r = await listClusters(AUTH, baseUrl)
    expect(r.ok).toBe(true)
    expect(seenUrl).toBe('/clusters?maxItems=20')
  })
})

describe('パスの組み立て', () => {
  it('getLimits は /limits を叩く', async () => {
    let seenUrl = ''
    const baseUrl = await listen((req, res) => {
      seenUrl = req.url ?? ''
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
    })
    await getLimits(AUTH, baseUrl)
    expect(seenUrl).toBe('/limits')
  })

  it('getWorkerClasses は /service_classes/worker を叩く', async () => {
    let seenUrl = ''
    const baseUrl = await listen((req, res) => {
      seenUrl = req.url ?? ''
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
    })
    await getWorkerClasses(AUTH, baseUrl)
    expect(seenUrl).toBe('/service_classes/worker')
  })

  it('getLbClasses は /service_classes/lb を叩く', async () => {
    let seenUrl = ''
    const baseUrl = await listen((req, res) => {
      seenUrl = req.url ?? ''
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
    })
    await getLbClasses(AUTH, baseUrl)
    expect(seenUrl).toBe('/service_classes/lb')
  })
})

describe('BasicAuth ヘッダ（token:secret を base64）', () => {
  it('Authorization ヘッダが Basic base64(token:secret) になる', async () => {
    let seenAuth = ''
    const baseUrl = await listen((req, res) => {
      seenAuth = req.headers.authorization ?? ''
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
    })
    await getLimits(AUTH, baseUrl)
    const expected = 'Basic ' + Buffer.from(`${AUTH.token}:${AUTH.secret}`, 'utf-8').toString('base64')
    expect(seenAuth).toBe(expected)
  })
})

describe('成功時: 応答本文をJSONとして data に載せる', () => {
  it('JSONをパースして返す', async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ clusterCount: 3, workerNodeCount: 14 }))
    })
    const r = await getLimits(AUTH, baseUrl)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toEqual({ clusterCount: 3, workerNodeCount: 14 })
  })
})

describe('失敗時: 生の応答本文を message に載せる（要約しない）', () => {
  it('401 は「キーまたは権限の問題」と分かる文言＋本文', async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end('{"error":"invalid credentials"}')
    })
    const r = await getLimits(AUTH, baseUrl)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message).toContain('キー')
      expect(r.message).toContain('権限')
      expect(r.message).toContain('invalid credentials') // 本文を要約せずそのまま含む
    }
  })

  it('403 も「キーまたは権限の問題」と分かる文言になる', async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end('{"error":"permission_denied"}')
    })
    const r = await getLimits(AUTH, baseUrl)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message).toContain('キー')
      expect(r.message).toContain('権限')
      expect(r.message).toContain('permission_denied')
    }
  })

  it('401/403以外（例: 400）は本文をそのまま message に載せる', async () => {
    const body = 'operation ListClusters: … query parameter "maxItems" not set'
    const baseUrl = await listen((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end(body)
    })
    const r = await listClusters(AUTH, baseUrl)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toBe(body)
  })

  it('500 も生の応答本文をそのまま載せる', async () => {
    const body = '{"code":500,"message":"internal error"}'
    const baseUrl = await listen((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(body)
    })
    const r = await getWorkerClasses(AUTH, baseUrl)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message).toBe(body)
      expect(r.detail).toBe(body)
    }
  })
})

describe('破壊系メソッドが1つも無いこと（この段階ではクラスタもアプリも作らない）', () => {
  const src = readFileSync(join(__dirname, '..', 'src/main/cloud/apprunDedicated.ts'), 'utf-8')

  it('POST を書いていない', () => { expect(src).not.toContain("method: 'POST'") })
  it('PUT を書いていない', () => { expect(src).not.toContain("method: 'PUT'") })
  it('PATCH を書いていない', () => { expect(src).not.toContain("method: 'PATCH'") })
  it('DELETE を書いていない', () => { expect(src).not.toContain("method: 'DELETE'") })
})
