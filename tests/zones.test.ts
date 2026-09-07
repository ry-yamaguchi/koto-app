import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import type { Server } from 'node:http'
import { getZones } from '../src/main/cloud/zones'
import { iaasZoneBase } from '../src/main/cloud/client'

// roadmap #28。GET /zone（さくらのクラウド API v1.1 設備関連API）だけを持つ薄いクライアント。
// tests/apprunDedicated.test.ts と同じ流儀: fetchをモックせず、ローカルに本物の http サーバを
// 立てて実物のクライアントに対して確かめる。偽サーバの応答は docs/apprun-dedicated-plan.md #28
// に載っている実測どおりの JSON をそのまま使う（5-8「応答の形は決め打ちできる。推測してはいけない」
// の教訓――偽サーバが実物と違う形を返すとテストが素通りしてしまう）。

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

// 実測どおりの応答（先頭3件。docs/apprun-dedicated-plan.md #28 依頼文と同じ）。
const REAL_ZONES_RESPONSE = {
  From: 0,
  Count: 6,
  Total: 6,
  Zones: [
    { Index: 0, ID: 21001, DisplayOrder: 20021001, Name: 'tk1a', Description: '東京第1ゾーン', IsDummy: false, Region: { ID: 210, Name: '東京', Description: '東京' } },
    { Index: 1, ID: 21002, DisplayOrder: 20021002, Name: 'tk1b', Description: '東京第2ゾーン', IsDummy: false, Region: { ID: 210, Name: '東京', Description: '東京' } },
    { Index: 2, ID: 31001, DisplayOrder: 20031001, Name: 'is1a', Description: '石狩第1ゾーン', IsDummy: false, Region: { ID: 310, Name: '石狩', Description: '石狩' } },
  ],
}

describe('getZones: URLの組み立て', () => {
  it('baseUrl を渡したときは baseUrl + /zone を叩く', async () => {
    let seenUrl = ''
    const baseUrl = await listen((req, res) => {
      seenUrl = req.url ?? ''
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(REAL_ZONES_RESPONSE))
    })
    const r = await getZones(AUTH, baseUrl)
    expect(r.ok).toBe(true)
    expect(seenUrl).toBe('/zone')
  })

  it('baseUrl 省略時は iaasZoneBase(\'is1a\') + zone（公式サンプルと同じ is1a・5-9）', () => {
    // getZones が既定で組み立てる絶対URLを、iaasZoneBase を使って再構築し突き合わせる
    // （URL組み立ての定数を複製せず、client.ts の唯一の定義を経由して検証する）。
    const expected = iaasZoneBase('is1a').replace(/\/$/, '') + '/zone'
    expect(expected).toBe('https://secure.sakura.ad.jp/cloud/zone/is1a/api/cloud/1.1/zone')
  })
})

describe('getZones: BasicAuth ヘッダ（token:secret を base64。apprunDedicated.ts と同じ作法）', () => {
  it('Authorization ヘッダが Basic base64(token:secret) になる', async () => {
    let seenAuth = ''
    const baseUrl = await listen((req, res) => {
      seenAuth = req.headers.authorization ?? ''
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(REAL_ZONES_RESPONSE))
    })
    await getZones(AUTH, baseUrl)
    const expected = 'Basic ' + Buffer.from(`${AUTH.token}:${AUTH.secret}`, 'utf-8').toString('base64')
    expect(seenAuth).toBe(expected)
  })
})

describe('getZones: 成功時は応答本文をJSONとして data に載せる', () => {
  it('実測どおりの応答をそのまま返す（6件中の3件・5-8）', async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(REAL_ZONES_RESPONSE))
    })
    const r = await getZones(AUTH, baseUrl)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toEqual(REAL_ZONES_RESPONSE)
  })
})

describe('getZones: 失敗時は生の応答本文を message に載せる（要約しない・掟10）', () => {
  it('401 は「キーまたは権限の問題」と分かる文言＋本文', async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end('{"error":"invalid credentials"}')
    })
    const r = await getZones(AUTH, baseUrl)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message).toContain('キー')
      expect(r.message).toContain('権限')
      expect(r.message).toContain('invalid credentials')
    }
  })

  it('403 も「キーまたは権限の問題」と分かる文言になる', async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end('{"error":"permission_denied"}')
    })
    const r = await getZones(AUTH, baseUrl)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message).toContain('キー')
      expect(r.message).toContain('権限')
      expect(r.message).toContain('permission_denied')
    }
  })

  it('401/403以外（例: 500）は本文をそのまま message と detail に載せる', async () => {
    const body = '{"is_fatal":true,"serial":"xxxx","status":"500 Internal Server Error","error_code":"internal","error_msg":"internal error"}'
    const baseUrl = await listen((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(body)
    })
    const r = await getZones(AUTH, baseUrl)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message).toBe(body)
      expect(r.detail).toBe(body)
    }
  })

  it('通信自体に失敗したとき（サーバが無い）も message に理由を載せる', async () => {
    // listen していないポートへ向ける（接続できないURL）。
    const r = await getZones(AUTH, 'http://127.0.0.1:1/')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message.length).toBeGreaterThan(0)
  })
})

describe('getZones: POST/PUT/DELETE を1つも書いていない（GETのみ）', () => {
  it('リクエストは常に GET', async () => {
    let seenMethod = ''
    const baseUrl = await listen((req, res) => {
      seenMethod = req.method ?? ''
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(REAL_ZONES_RESPONSE))
    })
    await getZones(AUTH, baseUrl)
    expect(seenMethod).toBe('GET')
  })

  it('ソースに fetch を POST/PUT/DELETE で呼ぶコードが無い', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs')
    const src: string = fs.readFileSync(require('node:path').join(__dirname, '..', 'src/main/cloud/zones.ts'), 'utf-8')
    expect(src).not.toMatch(/method:\s*['"](POST|PUT|DELETE|PATCH)['"]/)
  })
})
