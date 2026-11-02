import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import type { Server } from 'node:http'
import path from 'node:path'

// ── 何も消さなかった回（keptOnly）は、公開の記録（📡 の行）を残す。専有型は「保存場所が残っている」印も下ろさない ─────────────────────
// 本物の cloud:teardown・本物の専有型の破棄（apprunDedicated:teardown）に、偽の保存場所・偽の client・実フォルダを流し、`.sakuraide.json` と専有型の記録の中身で固定する（掟10）。
// keptOnly になる入力は3通り: 複製を確かめられない兄弟がいる回（確認が出た）・確認のあとで複製ができた回・確認で「消しません」と言った回（keepData）。
// 何かを消した回（keptOnly でない成功）は、今までどおり行が消え、専有型の印も下ろす。失敗の回は今までどおり行を残す。
// HANAMII は keptOnly を付けず、行の扱いも変えない（その固定は tests/keptOnlyTeardown.test.ts）。
import { A, B, APP, OK_AUTH, PREFIX, CONSENTED_AT, bucketRef, h, resetHarness, newProjectDir, workspaceOf, setup, writePublishRecord, publishTargets, stateMeta } from './sharedTeardownHarness'

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))

// 専有型の破棄の本体は実物を動かす。偽サーバへ向けるため baseUrl だけを足し、待たない sleep を入れる。
const d = vi.hoisted(() => ({ baseUrl: '' }))
vi.mock('../src/main/cloud/apprunDedicatedApply', async (orig) => {
  const real = await orig<any>()
  return { ...real, teardownFlow: (auth: any, dir: string, opts: any) => real.teardownFlow(auth, dir, { ...opts, sleep: async () => {} }, d.baseUrl) }
})

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { registerApprunDedicatedHandlers } from '../src/main/ipc/apprunDedicated'
import { shouldForgetSharedRecord } from '../src/main/ipc/cloudTeardown'
import { readApprunDedicatedFs, writeApprunDedicatedRecordFs, writePublishRecordFs } from '../src/main/publishMetaFs'
import { resetProjectOpsForTests } from '../src/main/projectOps'
import { dedicatedTeardownHasWork } from '../src/shared/teardownSupport'

registerCloudHandlers({} as any)
registerApprunDedicatedHandlers({} as any)
const sharedHandler = h.handlers.get('cloud:teardown')!
const dedicatedHandler = h.handlers.get('apprunDedicated:teardown')!

const EVENT = { sender: { send: () => {} } }
const S = A
const TWIN = 'myapp copy'
const KEY_ID = 'perm-rec'
const AUTH = { token: 'tok', secret: 'sec' }
const ROW_AT = '2026-10-19T00:00:00.000Z'
const SHARED_ROW = { publishedAt: ROW_AT, url: 'https://shared.example.com/' }
const DEDICATED_ROW = { publishedAt: ROW_AT, url: 'https://dedicated.example.com/' }
const OTHER_ROW = { publishedAt: ROW_AT, url: 'https://myapp.vercel.app/' }

/** 確認で見せた保存場所（名前と prefix の組）。`keepData` は確認で「消しません」と言った保存場所。 */
const shown = (buckets: string[], keepData = false) => buckets.map(bucket => ({ bucket, prefix: PREFIX, ...(keepData ? { keepData: true as const } : {}) }))
const SHARED_GO = (buckets: string[], keepData = false) => ({ confirmed: true, deleteRegistry: false, registryName: null, shownPlacements: shown(buckets, keepData) })
const DEDICATED_GO = (buckets: string[], keepData = false) => ({ confirmed: true, shownPlacements: shown(buckets, keepData) })

let dir = ''
let server: Server | null = null
beforeEach(() => {
  resetHarness()
  resetProjectOpsForTests()
  d.baseUrl = ''
  dir = newProjectDir()
})
afterEach(() => {
  if (server) { server.close(); server = null }
  fs.rmSync(dir, { recursive: true, force: true })
})

/** 複製（`myapp copy`）を、元と同じ親フォルダに置く。元と同じバケット・同じ prefix を同意済みで持つ。 */
function twin(buckets: string[] = [S]): void {
  const p = path.join(workspaceOf(dir), TWIN, '.sakura-cloud')
  fs.mkdirSync(p, { recursive: true })
  fs.writeFileSync(path.join(p, 'env.json'), JSON.stringify({
    persistence: { objectStorage: buckets.map(bucket => ({ bucket, prefix: PREFIX, shared: true, consentedAt: CONSENTED_AT })) },
  }))
}
/** 隣に、複製かどうか確かめられないフォルダ（env.json が壊れている）を置く。 */
function unreadSibling(): void {
  const p = path.join(workspaceOf(dir), 'broken-env', '.sakura-cloud')
  fs.mkdirSync(p, { recursive: true })
  fs.writeFileSync(path.join(p, 'env.json'), '{ not json')
}
const destructive = () => h.calls.filter(c => /^(deleteKeys|deleteBucket|deletePermission|listPermissions)\b/.test(c))

/** 入力ごとの表。keptOnly になる3通りを、共用型・専有型の両方に流す。 */
const KEPT_INPUTS: Array<{ name: string; prepare: () => void; keepData: boolean }> = [
  { name: '複製を確かめられない兄弟がいる（確認が出た回）', prepare: unreadSibling, keepData: false },
  { name: '確認のあとで複製ができた（確認は「消す」と言った回）', prepare: () => twin(), keepData: false },
  { name: '確認で「消しません」と言った保存場所（keepData）', prepare: () => {}, keepData: true },
]

describe('★★★ 共用型 cloud:teardown: keptOnly の回は 📡 の行を残し、keptOnly でない成功は行を消す', () => {
  const write = () => writePublishRecord(dir, { 'sakura-apprun': SHARED_ROW, vercel: OTHER_ROW })

  for (const input of KEPT_INPUTS) {
    it(`★★★ ${input.name}: keptOnly:true・何も消す要求を出さず、.sakuraide.json の行は1行も変わらない。記録の鍵の ID も記録に残る`, async () => {
      setup(dir, { env: [S], resources: [bucketRef(S)], meta: { storagePermissionId: KEY_ID } })
      write()
      input.prepare()
      const reply = await sharedHandler(EVENT, dir, OK_AUTH, SHARED_GO([S], input.keepData))

      expect(reply.ok).toBe(true)
      expect(reply.keptOnly).toBe(true)
      expect(destructive(), '消す要求が出た').toEqual([])
      expect(publishTargets(dir)).toEqual({ 'sakura-apprun': SHARED_ROW, vercel: OTHER_ROW })
      // 鍵は無効にしていない。ID まで記録から落ちると、生きた鍵がどこにも辿れず、次の押しでも無効にできない
      expect(stateMeta(dir)?.storagePermissionId).toBe(KEY_ID)
    })

    it(`★★ ${input.name}: 続けて押しても同じ（行が残っているので押し直せる。2回目も keptOnly で行も鍵の ID も残る）`, async () => {
      setup(dir, { env: [S], resources: [bucketRef(S)], meta: { storagePermissionId: KEY_ID } })
      write()
      input.prepare()
      await sharedHandler(EVENT, dir, OK_AUTH, SHARED_GO([S], input.keepData))
      const again = await sharedHandler(EVENT, dir, OK_AUTH, SHARED_GO([S], input.keepData))

      expect(again.ok).toBe(true)
      expect(again.keptOnly).toBe(true)
      expect(publishTargets(dir)['sakura-apprun']).toEqual(SHARED_ROW)
      expect(stateMeta(dir)?.storagePermissionId).toBe(KEY_ID)
    })
  }

  it('★★★ 保存場所が2件とも残った回（keptOnly）も行を残す', async () => {
    setup(dir, { env: [S, B], resources: [bucketRef(S), bucketRef(B)] })
    write()
    twin([S, B])
    const reply = await sharedHandler(EVENT, dir, OK_AUTH, SHARED_GO([S, B]))

    expect(reply.keptOnly).toBe(true)
    expect(publishTargets(dir)['sakura-apprun']).toEqual(SHARED_ROW)
  })

  it('★★★ 複製を外した次の押しで、残してあった記録の鍵が無効になり、鍵の ID が記録から外れ、行も消える（keptOnly の回に鍵を辿れなくしていない）', async () => {
    setup(dir, { env: [S], resources: [bucketRef(S)], meta: { storagePermissionId: KEY_ID } })
    write()
    twin()
    const first = await sharedHandler(EVENT, dir, OK_AUTH, SHARED_GO([S]))
    expect(first.keptOnly).toBe(true)
    expect(h.calls.some(c => c.startsWith('deletePermission')), '1回目で鍵を無効にした').toBe(false)

    fs.rmSync(path.join(workspaceOf(dir), TWIN), { recursive: true, force: true })
    const second = await sharedHandler(EVENT, dir, OK_AUTH, SHARED_GO([S]))

    expect(second.ok).toBe(true)
    expect('keptOnly' in second).toBe(false)
    expect(h.calls).toContain(`deletePermission ${KEY_ID}`)
    expect(h.calls).toContain(`deleteBucket ${S}`)
    expect(stateMeta(dir)?.storagePermissionId ?? null).toBeNull()
    expect(publishTargets(dir)).toEqual({ vercel: OTHER_ROW })
  })

  it('★★★ 対照: 複製がいなければバケットごと消す。keptOnly でない成功なので行は消える（ほかの公開先の行は残る）', async () => {
    setup(dir, { env: [S], resources: [bucketRef(S)] })
    write()
    const reply = await sharedHandler(EVENT, dir, OK_AUTH, SHARED_GO([S]))

    expect(reply.ok).toBe(true)
    expect('keptOnly' in reply).toBe(false)
    expect(h.calls).toContain(`deleteBucket ${S}`)
    expect(publishTargets(dir)).toEqual({ vercel: OTHER_ROW })
  })

  it('★★★ 対照: アプリを消した回は、保存場所が全部複製でも keptOnly でない成功。行は消える', async () => {
    setup(dir, { env: [S], resources: [bucketRef(S), APP] })
    write()
    twin()
    const reply = await sharedHandler(EVENT, dir, OK_AUTH, SHARED_GO([S]))

    expect(reply.ok).toBe(true)
    expect(reply.appDeleted).toBe(true)
    expect('keptOnly' in reply).toBe(false)
    expect(publishTargets(dir)).toEqual({ vercel: OTHER_ROW })
  })

  it('★★ 対照: 2件のうち1件だけ消した回（1件は複製のため残した）も keptOnly でない成功。行は消える', async () => {
    setup(dir, { env: [S, B], resources: [bucketRef(S), bucketRef(B)] })
    write()
    twin([S])
    const reply = await sharedHandler(EVENT, dir, OK_AUTH, SHARED_GO([S, B]))

    expect(reply.ok).toBe(true)
    expect('keptOnly' in reply).toBe(false)
    expect(h.calls).toContain(`deleteBucket ${B}`)
    expect(publishTargets(dir)).toEqual({ vercel: OTHER_ROW })
  })

  it('★★ 対照: 失敗の回（一覧できず止まった）は、今までどおり行を残す', async () => {
    setup(dir, { env: [S], resources: [bucketRef(S)] })
    write()
    twin()
    h.fail[`listAllKeys ${S}`] = 'throw'
    const reply = await sharedHandler(EVENT, dir, OK_AUTH, SHARED_GO([S]))

    expect(reply.ok).toBe(false)
    expect(publishTargets(dir)['sakura-apprun']).toEqual(SHARED_ROW)
  })

  it('★★ 規則（shouldForgetSharedRecord）の真理値表: ok のときだけ消す。keptOnly は真偽値の true だけを読む', () => {
    const table: Array<[Record<string, unknown>, boolean]> = [
      [{ ok: true }, true], [{ ok: false }, false],
      [{ ok: true, keptOnly: true }, false], [{ ok: false, keptOnly: true }, false],
      [{ ok: true, keptOnly: undefined }, true], [{ ok: true, keptOnly: false }, true],
      [{ ok: true, keptOnly: 'true' }, true], [{ ok: true, keptOnly: 1 }, true], [{ ok: true, keptOnly: {} }, true],
    ]
    for (const [result, expected] of table) {
      expect(shouldForgetSharedRecord({ result: result as any }), JSON.stringify(result)).toBe(expected)
    }
  })
})

describe('★★★ 専有型 apprunDedicated:teardown: keptOnly の回は 📡 の行と「保存場所が残っている」印を残し、次の押しも「破棄するものはありません」にならない', () => {
  /** 保存場所だけが残った印の押し直し（資源の ID は記録に無い）。行（📡）も置く。`withRecord` が真なら、印のほかの項目（鍵の ID・アプリの名前・ホスト）も記録に置く。 */
  function leftoverOnly(buckets: string[], withRecord = false): void {
    setup(dir, { env: buckets, resources: [] })
    writeApprunDedicatedRecordFs(dir, {
      storageLeftoverBucket: buckets[0], storageLeftoverBuckets: buckets,
      ...(withRecord ? { storagePermissionId: 'perm-ded', applicationName: 'myapp-ded', hosts: ['myapp.example.com'] } : {}),
    })
    writePublishRecordFs(dir, 'sakura-apprun-dedicated', DEDICATED_ROW)
    writePublishRecordFs(dir, 'vercel', OTHER_ROW)
  }
  const marks = () => { const r = readApprunDedicatedFs(dir); return { one: r.storageLeftoverBucket, all: r.storageLeftoverBuckets } }
  /** `.sakuraide.json` の全体（印・鍵の ID・アプリの名前・ホスト・公開先の行を含む）。 */
  const wholeRecord = (): unknown => JSON.parse(fs.readFileSync(path.join(dir, '.sakuraide.json'), 'utf-8'))

  for (const input of KEPT_INPUTS) {
    it(`★★★ ${input.name}: keptOnly:true・何も消す要求を出さず、行も印（先頭の1件と全件）も変わらない。dedicatedTeardownHasWork は真のまま。鍵の ID・アプリの名前・ホストも含め、記録は1項目も変わらない`, async () => {
      leftoverOnly([S], true)
      input.prepare()
      const before = wholeRecord()
      const reply = await dedicatedHandler(EVENT, dir, AUTH, DEDICATED_GO([S], input.keepData))

      expect(reply.ok).toBe(true)
      expect(reply.keptOnly).toBe(true)
      expect(destructive(), '消す要求が出た').toEqual([])
      expect(publishTargets(dir)).toEqual({ 'sakura-apprun-dedicated': DEDICATED_ROW, vercel: OTHER_ROW })
      expect(marks()).toEqual({ one: S, all: [S] })
      expect(dedicatedTeardownHasWork(readApprunDedicatedFs(dir)), '次の押しが「破棄するものはありません」になる').toBe(true)
      // 鍵を無効にしていないので、鍵の ID が記録から外れると、生きた鍵がどこにも辿れなくなる（印以外の項目も触れない）
      expect(readApprunDedicatedFs(dir).storagePermissionId).toBe('perm-ded')
      expect(wholeRecord()).toEqual(before)
      // 印は下ろしていない（保存場所は残っている）。「保存場所は残っていませんが…印を消せませんでした」と言い違えない
      expect(reply.executed.join('\n')).not.toContain('保存場所は残っていませんが')
    })

    it(`★★★ ${input.name}: 続けて押しても同じ。2回目も保存場所へ進み（一覧を引く）、keptOnly で、行も印も、記録のほかの項目も残る`, async () => {
      leftoverOnly([S], true)
      input.prepare()
      const before = wholeRecord()
      await dedicatedHandler(EVENT, dir, AUTH, DEDICATED_GO([S], input.keepData))
      const again = await dedicatedHandler(EVENT, dir, AUTH, DEDICATED_GO([S], input.keepData))

      expect(again.ok).toBe(true)
      expect(again.keptOnly).toBe(true)
      expect(again.keptBucketNames, '2回目が保存場所の段まで進んでいない（破棄するものはありません、で止まった）').toEqual([S])
      expect(destructive()).toEqual([])
      expect(publishTargets(dir)['sakura-apprun-dedicated']).toEqual(DEDICATED_ROW)
      expect(marks()).toEqual({ one: S, all: [S] })
      expect(wholeRecord()).toEqual(before)
    })
  }

  it('★★★ 保存場所が2件とも残った回（keptOnly）は、2件の印を残す（先頭の1件だけにしない）', async () => {
    leftoverOnly([S, B])
    twin([S, B])
    const reply = await dedicatedHandler(EVENT, dir, AUTH, DEDICATED_GO([S, B]))

    expect(reply.keptOnly).toBe(true)
    expect(marks()).toEqual({ one: S, all: [S, B] })
    expect(publishTargets(dir)['sakura-apprun-dedicated']).toEqual(DEDICATED_ROW)
  })

  it('★★★ 複製を外した次の押しで、残してあった記録の鍵が無効になり、鍵の ID も印も下り、行も消える', async () => {
    leftoverOnly([S], true)
    twin()
    const first = await dedicatedHandler(EVENT, dir, AUTH, DEDICATED_GO([S]))
    expect(first.keptOnly).toBe(true)
    expect(h.calls.some(c => c.startsWith('deletePermission')), '1回目で鍵を無効にした').toBe(false)

    fs.rmSync(path.join(workspaceOf(dir), TWIN), { recursive: true, force: true })
    const second = await dedicatedHandler(EVENT, dir, AUTH, DEDICATED_GO([S]))

    expect(second.ok).toBe(true)
    expect('keptOnly' in second).toBe(false)
    expect(h.calls).toContain('deletePermission perm-ded')
    expect(h.calls).toContain(`deleteBucket ${S}`)
    expect(readApprunDedicatedFs(dir).storagePermissionId ?? null).toBeNull()
    expect(marks().one ?? null).toBeNull()
    expect(publishTargets(dir)).toEqual({ vercel: OTHER_ROW })
  })

  it('★★★ 対照: 複製がいなければバケットごと消す。keptOnly でない成功なので、行は消え、印も下りる（次の押しは「破棄するものはありません」）', async () => {
    leftoverOnly([S])
    const reply = await dedicatedHandler(EVENT, dir, AUTH, DEDICATED_GO([S]))

    expect(reply.ok).toBe(true)
    expect('keptOnly' in reply).toBe(false)
    expect(h.calls).toContain(`deleteBucket ${S}`)
    expect(publishTargets(dir)).toEqual({ vercel: OTHER_ROW })
    expect(marks().one ?? null).toBeNull()
    expect(marks().all ?? null).toBeNull()
    expect(dedicatedTeardownHasWork(readApprunDedicatedFs(dir))).toBe(false)
  })

  it('★★★ 対照: 2件のうち1件だけ消した回（1件は複製のため残した）は keptOnly でない成功。行は消え、印も下りる（既存の振る舞い）', async () => {
    leftoverOnly([S, B])
    twin([S])
    const reply = await dedicatedHandler(EVENT, dir, AUTH, DEDICATED_GO([S, B]))

    expect(reply.ok).toBe(true)
    expect('keptOnly' in reply).toBe(false)
    expect(h.calls).toContain(`deleteBucket ${B}`)
    expect(publishTargets(dir)).toEqual({ vercel: OTHER_ROW })
    expect(marks().one ?? null).toBeNull()
  })

  it('★★★ 対照: 資源の ID がある回（クラスタを消した）は、保存場所が全部複製でも keptOnly でない成功。行は消える', async () => {
    setup(dir, { env: [S], resources: [] })
    writeApprunDedicatedRecordFs(dir, { clusterID: 'c1' })
    writePublishRecordFs(dir, 'sakura-apprun-dedicated', DEDICATED_ROW)
    twin()
    d.baseUrl = await listen()
    const reply = await dedicatedHandler(EVENT, dir, AUTH, DEDICATED_GO([S]))

    expect(reply.ok).toBe(true)
    expect(reply.executed.length, 'クラスタを消した行がある').toBeGreaterThan(0)
    expect('keptOnly' in reply).toBe(false)
    expect(publishTargets(dir)['sakura-apprun-dedicated']).toBeUndefined()
  })

  it('★★ 対照: 失敗の回（一覧できず止まった）は、今までどおり行を残し、印も残る', async () => {
    leftoverOnly([S])
    twin()
    h.fail[`listAllKeys ${S}`] = 'throw'
    const reply = await dedicatedHandler(EVENT, dir, AUTH, DEDICATED_GO([S]))

    expect(reply.ok).toBe(false)
    expect(publishTargets(dir)['sakura-apprun-dedicated']).toEqual(DEDICATED_ROW)
    expect(marks().one).toBe(S)
  })

  function listen(): Promise<string> {
    return new Promise((resolve, reject) => {
      server = http.createServer((req, res) => {
        req.on('data', () => {})
        req.on('end', () => {
          const key = `${req.method} ${req.url}`
          if (key === 'DELETE /clusters/c1') { res.writeHead(204); res.end(); return }
          res.writeHead(key === 'GET /clusters?maxItems=20' ? 200 : 404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(key === 'GET /clusters?maxItems=20' ? { clusters: [] } : { error: `test router: 未定義のルート ${key}` }))
        })
      })
      server.listen(0, () => {
        const addr = server?.address()
        if (addr && typeof addr === 'object') resolve(`http://127.0.0.1:${addr.port}/`)
        else reject(new Error('サーバのポートを取得できませんでした'))
      })
    })
  }
})
