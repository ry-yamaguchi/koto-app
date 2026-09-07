import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import type { Server } from 'node:http'
import {
  getLimits,
  getWorkerClasses,
  getLbClasses,
  listClusters,
  createCluster,
  getCluster,
  deleteCluster,
  createAsg,
  getAsg,
  deleteAsg,
  createLoadBalancer,
  deleteLoadBalancer,
  listAsg,
  listLoadBalancers,
  APPRUN_DEDICATED_API_BASE,
} from '../src/main/cloud/apprunDedicated'

// roadmap #23。段階①「下調べ画面」は GET のみだったが、段階②「作る」でクラスタ・ASG・
// ロードバランサの作成/削除メソッドを追加した（application/version は対象外・
// src/main/cloud/apprunDedicated.ts の冒頭コメント参照）。
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
  it('JSONをパースして返す（getLimits の実物の形は入れ子 { limit: {...} }・5-8）', async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ limit: { clusterCount: 3, workerNodeCount: 14 } }))
    })
    const r = await getLimits(AUTH, baseUrl)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toEqual({ limit: { clusterCount: 3, workerNodeCount: 14 } })
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

  it('失敗応答が5-8の形 { status, title } なら、title を message に添える（生の本文も残す）', async () => {
    const body = '{"status":400,"title":"クラスタ名が不正です"}'
    const baseUrl = await listen((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(body)
    })
    const r = await getWorkerClasses(AUTH, baseUrl)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message).toContain('クラスタ名が不正です') // title を要約せず添える
      expect(r.message).toContain(body) // 生の本文もそのまま残す（掟10）
    }
  })

  it('title が無い形（推測で埋めない）なら、従来どおり生の本文だけを載せる', async () => {
    const body = '{"code":400}'
    const baseUrl = await listen((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(body)
    })
    const r = await getWorkerClasses(AUTH, baseUrl)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toBe(body)
  })
})

describe('段階②で追加: クラスタの作成・実在確認・削除', () => {
  it('createCluster: POST /clusters に本文をJSONで送る（成功応答は200・{cluster:{clusterID}}が5-8の実物の形）', async () => {
    let seenMethod = ''; let seenUrl = ''; let seenBody = ''
    const baseUrl = await listen((req, res) => {
      seenMethod = req.method ?? ''; seenUrl = req.url ?? ''
      let raw = ''
      req.on('data', c => { raw += c })
      req.on('end', () => {
        seenBody = raw
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ cluster: { clusterID: 'cluster-1' } }))
      })
    })
    const body = { name: 'myapp', ports: [{ port: 80, protocol: 'http' }], servicePrincipalID: '113800956789' }
    const r = await createCluster(AUTH, body, baseUrl)
    expect(seenMethod).toBe('POST')
    expect(seenUrl).toBe('/clusters')
    expect(JSON.parse(seenBody)).toEqual(body)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toEqual({ cluster: { clusterID: 'cluster-1' } })
  })

  it('getCluster: GET /clusters/{id}', async () => {
    let seenUrl = ''
    const baseUrl = await listen((req, res) => {
      seenUrl = req.url ?? ''
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ cluster: { clusterID: 'cluster-1' } }))
    })
    await getCluster(AUTH, 'cluster-1', baseUrl)
    expect(seenUrl).toBe('/clusters/cluster-1')
  })

  it('deleteCluster: DELETE /clusters/{id}（本文なし）', async () => {
    let seenMethod = ''; let seenUrl = ''; let hadBody = false
    const baseUrl = await listen((req, res) => {
      seenMethod = req.method ?? ''; seenUrl = req.url ?? ''
      req.on('data', () => { hadBody = true })
      req.on('end', () => { res.writeHead(204); res.end() })
    })
    const r = await deleteCluster(AUTH, 'cluster-1', baseUrl)
    expect(seenMethod).toBe('DELETE')
    expect(seenUrl).toBe('/clusters/cluster-1')
    expect(hadBody).toBe(false)
    expect(r.ok).toBe(true)
  })
})

describe('段階②で追加: ASG（オートスケーリンググループ）の作成・実在確認・削除・一覧', () => {
  it('createAsg: POST /clusters/{id}/asg（成功応答は200・{autoScalingGroup:{autoScalingGroupID}}が実物の形）', async () => {
    let seenMethod = ''; let seenUrl = ''
    const baseUrl = await listen((req, res) => {
      seenMethod = req.method ?? ''; seenUrl = req.url ?? ''
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ autoScalingGroup: { autoScalingGroupID: 'asg-1' } }))
    })
    await createAsg(AUTH, 'cluster-1', { name: 'myapp' }, baseUrl)
    expect(seenMethod).toBe('POST')
    expect(seenUrl).toBe('/clusters/cluster-1/asg')
  })

  it('getAsg: GET /clusters/{id}/asg/{asgId}', async () => {
    let seenUrl = ''
    const baseUrl = await listen((req, res) => {
      seenUrl = req.url ?? ''
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}')
    })
    await getAsg(AUTH, 'cluster-1', 'asg-1', baseUrl)
    expect(seenUrl).toBe('/clusters/cluster-1/asg/asg-1')
  })

  it('deleteAsg: DELETE /clusters/{id}/asg/{asgId}', async () => {
    let seenMethod = ''; let seenUrl = ''
    const baseUrl = await listen((req, res) => {
      seenMethod = req.method ?? ''; seenUrl = req.url ?? ''
      res.writeHead(204); res.end()
    })
    await deleteAsg(AUTH, 'cluster-1', 'asg-1', baseUrl)
    expect(seenMethod).toBe('DELETE')
    expect(seenUrl).toBe('/clusters/cluster-1/asg/asg-1')
  })

  it('listAsg: maxItems の既定値が付く（付け忘れると実APIで400になる実測が /clusters にある。ASGも同じ作法にする）', async () => {
    let seenUrl = ''
    const baseUrl = await listen((req, res) => {
      seenUrl = req.url ?? ''
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"asgs":[]}')
    })
    await listAsg(AUTH, 'cluster-1', undefined, baseUrl)
    expect(seenUrl).toBe('/clusters/cluster-1/asg?maxItems=20')
  })
})

describe('段階②で追加: ロードバランサ（クラスタ/ASGとは別資源・5-6）の作成・削除・一覧', () => {
  it('createLoadBalancer: POST /clusters/{id}/asg/{asgId}/load_balancers（成功応答は200・{loadBalancer:{loadBalancerID}}が実物の形）', async () => {
    let seenMethod = ''; let seenUrl = ''
    const baseUrl = await listen((req, res) => {
      seenMethod = req.method ?? ''; seenUrl = req.url ?? ''
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ loadBalancer: { loadBalancerID: 'lb-1' } }))
    })
    await createLoadBalancer(AUTH, 'cluster-1', 'asg-1', { name: 'myapp' }, baseUrl)
    expect(seenMethod).toBe('POST')
    expect(seenUrl).toBe('/clusters/cluster-1/asg/asg-1/load_balancers')
  })

  it('deleteLoadBalancer: DELETE /clusters/{id}/asg/{asgId}/load_balancers/{lbId}', async () => {
    let seenMethod = ''; let seenUrl = ''
    const baseUrl = await listen((req, res) => {
      seenMethod = req.method ?? ''; seenUrl = req.url ?? ''
      res.writeHead(204); res.end()
    })
    await deleteLoadBalancer(AUTH, 'cluster-1', 'asg-1', 'lb-1', baseUrl)
    expect(seenMethod).toBe('DELETE')
    expect(seenUrl).toBe('/clusters/cluster-1/asg/asg-1/load_balancers/lb-1')
  })

  it('listLoadBalancers: maxItems の既定値が付く（min2だが20なら範囲内・5-1）', async () => {
    let seenUrl = ''
    const baseUrl = await listen((req, res) => {
      seenUrl = req.url ?? ''
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"loadBalancers":[]}')
    })
    await listLoadBalancers(AUTH, 'cluster-1', 'asg-1', undefined, baseUrl)
    expect(seenUrl).toBe('/clusters/cluster-1/asg/asg-1/load_balancers?maxItems=20')
  })
})

describe('段階②で追加: 作成系も失敗時は生の応答本文を message に載せる（要約しない）', () => {
  it('createCluster が 400 のとき、本文をそのまま message に載せる', async () => {
    const body = '{"error":"invalid name"}'
    const baseUrl = await listen((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(body)
    })
    const r = await createCluster(AUTH, { name: '' }, baseUrl)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toBe(body)
  })
})
