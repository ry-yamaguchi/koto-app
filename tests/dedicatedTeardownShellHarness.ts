// 専有型の削除 apprunDedicated:teardown を、本物の main に流すための土台その2（下ごしらえ: プロジェクトの用意・偽サーバ・毎回の初期化）。
// tests/dedicatedTeardownShell.test.ts・tests/dedicatedTeardownShell2.test.ts が使う（0.6.22 段階3B-7 で、400行を超えた試験を2つに分けるために切り出した）。
// 偽物そのもの（electron・保存場所・teardownFlow の待ち・公開の記録の消し損ね）と、それに渡す入れ物 h は tests/dedicatedTeardownShellMocks.ts。
// 各テストファイルは、先頭に Mocks の vi.mock を4つ書いてから、このファイルを import する（このファイルは publishMetaFs などの本物を import する）。
import http from 'node:http'
import type { Server } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { h } from './dedicatedTeardownShellMocks'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'
import { writeApprunDedicatedRecordFs, writePublishRecordFs } from '../src/main/publishMetaFs'
import { resetProjectOpsForTests } from '../src/main/projectOps'
import { NOT_CONFIRMED_MESSAGE } from '../src/main/cloud/teardownShell'
import { isolatedProjectDir } from './isolatedProject'

export const AUTH = { token: 'dedicated-token-AAAA1111', secret: 'dedicated-secret-BBBB2222' }
export const BUCKET = 'koto-data-x'
export const PREFIX = 'projects/myapp/'
export const CONSENTED_BUCKET = { bucket: BUCKET, prefix: PREFIX, shared: true, consentedAt: '2026-08-14T00:00:00.000Z' }
export const EMPTY_OPS = { running: null, last: null, earlier: [] }
export const REFUSED_NOT_CONFIRMED = { ok: false, executed: [], message: NOT_CONFIRMED_MESSAGE, remaining: {} }

export type Route = { status: number; body?: unknown }
let server: Server | null = null
/** いまのテストのプロジェクトのフォルダ（setupEach が作る）。helper の project()・metaText() などが読む。 */
let dir = ''
/** renderer へ送られた進み具合の文（毎回空に戻す）。 */
export const sent: string[] = []
export const EVENT = { sender: { send: (_channel: string, m: string) => { sent.push(m) } } }

/** beforeEach から呼ぶ。新しいプロジェクトのフォルダを作って返す。 */
export function setupEach(): string {
  resetProjectOpsForTests()
  dir = isolatedProjectDir('koto-dedicated-shell-')
  h.baseUrl = ''
  h.keys = [`${PREFIX}.koto-keep`]
  h.listThrows = false
  h.storageCalls = []
  h.deletedBuckets = []
  h.forget = null
  h.listThrowsFor = new Set()
  h.keysFor = new Map()
  h.failRecordWrite = null
  h.forgetBucketsFails = false
  h.storageThrows = false
  sent.length = 0
  return dir
}
/** afterEach から呼ぶ。 */
export function teardownEach(): void {
  if (server) { server.close(); server = null }
  resetProjectOpsForTests()
  fs.rmSync(dir, { recursive: true, force: true })
}

// ── 下ごしらえ ────────────────────────────────────────────────────────

/** さくらの専有型 API の偽サーバ。**来た要求を calls に積む**（0本であることを確かめるのに使う）。 */
export async function startServer(routes: Record<string, Route>): Promise<string[]> {
  const calls: string[] = []
  const handler: http.RequestListener = (req, res) => {
    const key = `${req.method} ${req.url}`
    calls.push(key)
    req.on('data', () => {})
    req.on('end', () => {
      const route = routes[key]
      const status = route?.status ?? 404
      if (status === 204) { res.writeHead(204); res.end(); return }
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(route?.body ?? { error: `test router: 未定義のルート ${key}` }))
    })
  }
  await new Promise<void>((resolve, reject) => {
    server = http.createServer(handler)
    server.listen(0, () => {
      const addr = server?.address()
      if (addr && typeof addr === 'object') { h.baseUrl = `http://127.0.0.1:${addr.port}/`; resolve() } else reject(new Error('ポートを取得できません'))
    })
  })
  return calls
}

/** クラスタだけを消す最短の応答。 */
export const CLUSTER_GONE: Record<string, Route> = {
  'DELETE /clusters/c1': { status: 204 },
  'GET /clusters?maxItems=20': { status: 200, body: { clusters: [] } },
}
/** ロードバランサ・ASG・クラスタを順に消す応答（アプリは記録に無い）。 */
export const LB_ASG_CLUSTER_GONE: Record<string, Route> = {
  'DELETE /clusters/c1/asg/a1/load_balancers/l1': { status: 204 },
  'GET /clusters/c1/asg/a1/load_balancers?maxItems=20': { status: 200, body: { loadBalancers: [] } },
  'DELETE /clusters/c1/asg/a1': { status: 204 },
  'GET /clusters/c1/asg?maxItems=20': { status: 200, body: { autoScalingGroups: [] } },
  ...CLUSTER_GONE,
}

/** 保存場所の設定（同意済み）を env.json に置く。名前を渡せば、その全件（同じ接頭辞・同意済み）。 */
export function useStorage(buckets: readonly string[] = [BUCKET]) {
  const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: false })
  spec.persistence = { objectStorage: buckets.map(bucket => ({ ...CONSENTED_BUCKET, bucket })) }
  fs.mkdirSync(path.join(dir, '.sakura-cloud'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.sakura-cloud', 'env.json'), JSON.stringify(spec, null, 2), 'utf-8')
}

/** 専有型の記録（クラスタだけ）と、📡 の行（専有型・Vercel）。`row:false` は専有型の行が無いプロジェクト。 */
export function project(opts: { record?: Parameters<typeof writeApprunDedicatedRecordFs>[1]; row?: boolean; storage?: boolean | readonly string[] } = {}) {
  writeApprunDedicatedRecordFs(dir, opts.record ?? { clusterID: 'c1' })
  if (opts.row !== false) writePublishRecordFs(dir, 'sakura-apprun-dedicated', { publishedAt: '2026-09-28T00:00:00.000Z', url: 'https://app.example.com/' })
  writePublishRecordFs(dir, 'vercel', { publishedAt: '2026-09-27T00:00:00.000Z', url: 'https://myapp.vercel.app/' })
  if (opts.storage) useStorage(typeof opts.storage === 'object' ? opts.storage : undefined)
}

export const metaText = () => fs.readFileSync(path.join(dir, '.sakuraide.json'), 'utf-8')
export const targetsOf = (): string[] => Object.keys(JSON.parse(metaText())?.publish?.targets ?? {}).sort()
export const ROW_AND_VERCEL = ['sakura-apprun-dedicated', 'vercel']
