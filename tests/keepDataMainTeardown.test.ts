import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import type { Server } from 'node:http'
import path from 'node:path'

// ── 0.6.25 U11: 確認で「消しません」と言った保存場所（shownPlacements の `keepData: true`）を、main が消さずに残す ──────────────
// 仕様: docs/v0625-plan.md の 1-1「確認で「消しません」と言った前提を main へ運ぶ」・2-3 の U11・T-1d。
//   ・`keepData: true` が付いた保存場所は、確認のあとで記録が変わって（同じデータを使うフォルダが消えて）「消してよい」に見えても、
//     データにもバケットにも鍵にも一括の無効化にも触れず、`keptData` で残す。**本物の `teardownStorageForProject` に偽の保存場所を流し、出た要求の一覧で見る**（掟10）。
//   ・3つの IPC（cloud:teardown・hanamii:teardown・apprunDedicated:teardown）はすべて同じ。`keepData` の無い保存場所は今までどおり消す。
//   ・消す側には働かない（`keepData` が無い・false・別の prefix の印は、消すことを言わない。消すかは今までどおり `teardownPlanFor`）。
//   ・形が読めない `keepData`（真偽値でない値）は、壊れた値として1件も見せていない扱い（消さない側）。
// 運ぶ側（画面が印を付ける）は tests/keepDataCarry.test.ts。main が最後の判断者のままであること（複製がいれば消さない）は既存の twin 系の試験が固定している。
import { A, B, APP, PREFIX, CONSENTED_AT, OK_AUTH, bucketRef, h, resetHarness, newProjectDir, workspaceOf, setup, envBuckets } from './sharedTeardownHarness'
import { KEPT_AFTER_CONFIRM_NOTE, KEY_KEPT_CONFIRMED_WARNING } from '../src/main/cloud/storageTeardown'

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
import { registerHanamiiHandlers } from '../src/main/ipc/hanamii'
import { registerApprunDedicatedHandlers } from '../src/main/ipc/apprunDedicated'
import { writeApprunDedicatedRecordFs } from '../src/main/publishMetaFs'
import { resetProjectOpsForTests } from '../src/main/projectOps'
import { teardownStorageForProject } from '../src/main/cloud/storageForTarget'
import { deleteProjectReply } from './hanamiiTeardownFixtures'

registerCloudHandlers({} as any)
registerHanamiiHandlers({} as any)
registerApprunDedicatedHandlers({} as any)
// 画面を通さず本物の main を直接呼ぶ（shownPlacements は各試験が自分で書く）
const sharedHandler = h.handlers.get('cloud:teardown')!
const hanamiiHandler = h.handlers.get('hanamii:teardown')!
const dedicatedHandler = h.handlers.get('apprunDedicated:teardown')!

const EVENT = { sender: { send: () => {} } }
const CREDS = { token: 'TEST-TOKEN', secret: 'TEST-SECRET' } as any
const OTHER_PREFIX = 'projects/other/'
const TWIN = 'myapp copy'
const keep = (bucket: string, prefix = PREFIX) => ({ bucket, prefix, keepData: true as const })
const plain = (bucket: string, prefix = PREFIX) => ({ bucket, prefix })
const CONFIRM_KEPT_LINE = (b: string) => `保存場所『${b}』のデータは残しました — ${KEPT_AFTER_CONFIRM_NOTE}`
const TWIN_KEPT_LINE = (b: string) => `保存場所『${b}』のデータは残しました — フォルダ『${TWIN}』も同じデータを使っています。`
const DELETED_LINE_HEAD = (b: string) => `保存場所『${b}』のデータを削除しました`
const KEY_WARNING_LINE = `⚠️ ${KEY_KEPT_CONFIRMED_WARNING}`

let dir = ''
let server: Server | null = null
const realFetch = globalThis.fetch
beforeEach(() => {
  resetHarness()
  resetProjectOpsForTests()
  d.baseUrl = ''
  dir = newProjectDir()
})
afterEach(() => {
  if (server) { server.close(); server = null }
  globalThis.fetch = realFetch
  fs.rmSync(dir, { recursive: true, force: true })
})

/** 保存場所へ出た要求（接続・一覧・削除・鍵の一覧・鍵の削除・dispose）。アプリ・レジストリ・計算資源への要求は含めない。 */
const storageCalls = () => h.calls.filter(c => /^(connect|listAllKeys|deleteKeys|deleteBucket|deletePermission|listPermissions|dispose)\b/.test(c))
/** 保存場所の「消す」要求（一覧は含めない）。仕様の完了条件の言い方: listAllKeys 以外の削除要求。 */
const destructiveCalls = () => h.calls.filter(c => /^(deleteKeys|deleteBucket|deletePermission|listPermissions)\b/.test(c))
const touching = (bucket: string) => h.calls.filter(c => c === `listAllKeys ${bucket}` || c === `deleteKeys ${bucket}` || c === `deleteBucket ${bucket}`)
const gone = (bucket: string) => [`listAllKeys ${bucket}`, `deleteKeys ${bucket}`, `deleteBucket ${bucket}`]

/** 複製（`myapp copy`）を、元と同じ親フォルダに置く。元と同じバケット・同じ prefix を同意済みで持つ。 */
function twin(): void {
  const p = path.join(workspaceOf(dir), TWIN, '.sakura-cloud')
  fs.mkdirSync(p, { recursive: true })
  fs.writeFileSync(path.join(p, 'env.json'), JSON.stringify({ persistence: { objectStorage: [{ bucket: A, prefix: PREFIX, shared: true, consentedAt: CONSENTED_AT }] } }))
}
/** 記録を読めない兄弟（複製かどうか確かめられない）を置く。 */
function unreadSibling(name: string): void {
  const p = path.join(workspaceOf(dir), name, '.sakura-cloud')
  fs.mkdirSync(p, { recursive: true })
  fs.writeFileSync(path.join(p, 'env.json'), '{ not json')
}

// ═════════════════════════════════════════════════════════════════════════════
// teardownStorageForProject（3つの IPC が通る1か所）に、偽の保存場所を流す
// ═════════════════════════════════════════════════════════════════════════════
describe('teardownStorageForProject: keepData の保存場所は、確認のあとで複製が消えても（記録の上では複製なし）要求0件で残る', () => {
  beforeEach(() => { setup(dir, { env: [A, B], resources: [APP, bucketRef(A), bucketRef(B)] }) })

  it('★★★ 全部 keepData: 保存場所への要求は0件（接続も一覧も削除も鍵も）・ok:true・keptData・理由は「どちらでもない」・鍵は無効にしない', async () => {
    const r = await teardownStorageForProject({
      creds: CREDS, projectDir: dir, permissionId: 'perm-rec', sweepKeysFor: 'apprun', placements: [{ bucket: A, prefix: PREFIX, shared: true }], shown: [keep(A)],
    })
    expect(destructiveCalls(), '消す要求・鍵の要求が出ている').toEqual([])
    expect(storageCalls(), '残す回は、外へ1本も要求を出さない（接続もしない）').toEqual([])
    expect(r).toStrictEqual({
      ok: true, reason: 'done', permissionRevoked: false, warnings: [KEY_KEPT_CONFIRMED_WARNING],
      done: [{ bucket: A, deletedBucket: false, note: KEPT_AFTER_CONFIRM_NOTE, keptReasons: { ownFiles: false, usedByOthers: false }, keptData: true }],
    })
  })

  it('★★★ 混在（A は keepData・B は付かない）: A への要求は0件。B は今までどおり消える。鍵は無効にしない（記録の鍵の削除も、名前での一括の無効化の一覧も0件）', async () => {
    h.permissions = [{ id: 'perm-old', displayName: 'koto-myapp-apprun' }]
    const r = await teardownStorageForProject({ creds: CREDS, projectDir: dir, permissionId: 'perm-rec', sweepKeysFor: 'apprun', shown: [keep(A), plain(B)] })
    expect(touching(A), 'A（消さないと言った）に要求が出ている').toEqual([])
    expect(h.calls).toEqual(expect.arrayContaining(gone(B)))
    expect(h.calls.filter(c => c.startsWith('deletePermission'))).toEqual([])
    expect(h.calls).not.toContain('listPermissions')
    expect(h.calls.at(-1)).toBe('dispose') // 作ったアダプタの一時キーは片づける
    expect(r.ok).toBe(true)
    if (!r.ok || r.reason !== 'done') throw new Error('done のはず')
    expect(r.permissionRevoked).toBe(false)
    expect(r.warnings).toEqual([KEY_KEPT_CONFIRMED_WARNING])
    expect(r.done.map(b => [b.bucket, b.deletedBucket, b.keptData === true])).toEqual([[A, false, true], [B, true, false]])
  })

  it('対照: 同じ混在で keepData が付かなければ、A も消え、記録の鍵の削除と名前での鍵の一括の無効化が出る（印が無ければ今までどおり消す）', async () => {
    h.permissions = [{ id: 'perm-old', displayName: 'koto-myapp-apprun' }]
    const r = await teardownStorageForProject({ creds: CREDS, projectDir: dir, permissionId: 'perm-rec', sweepKeysFor: 'apprun', shown: [plain(A), plain(B)] })
    expect(h.calls).toEqual(expect.arrayContaining([...gone(A), ...gone(B), 'deletePermission perm-rec', 'listPermissions']))
    expect(r.ok).toBe(true)
    if (!r.ok || r.reason !== 'done') throw new Error('done のはず')
    expect(r.warnings).toEqual([])
    expect(r.permissionRevoked).toBe(true)
  })

  it('★★ keepData: false・別の prefix への keepData は、消さないことを言わない（A は今までどおり消える）。消す側には働かない', async () => {
    await teardownStorageForProject({ creds: CREDS, projectDir: dir, placements: [{ bucket: A, prefix: PREFIX, shared: true }], shown: [{ bucket: A, prefix: PREFIX, keepData: false }] })
    expect(h.calls).toEqual(expect.arrayContaining(gone(A)))

    h.calls = []
    await teardownStorageForProject({ creds: CREDS, projectDir: dir, placements: [{ bucket: A, prefix: PREFIX, shared: true }], shown: [plain(A), keep(A, OTHER_PREFIX)] })
    expect(h.calls, '別の prefix の印で、この prefix が残った').toEqual(expect.arrayContaining(gone(A)))
  })

  it('★★ 同じ組が2回あり、片方だけ keepData → 残す側（消さない言い切りを、別の項目で打ち消さない）', async () => {
    const r = await teardownStorageForProject({ creds: CREDS, projectDir: dir, placements: [{ bucket: A, prefix: PREFIX, shared: true }], shown: [plain(A), keep(A)] })
    expect(storageCalls()).toEqual([])
    expect(r.ok && r.reason === 'done' && r.done[0].keptData).toBe(true)
  })

  it('★★ 形の読めない keepData（真偽値でない値）は壊れた値: 1件も見せていない扱い。要求0件・ok:false・全件が残りに（消さない側）', async () => {
    for (const bad of ['true', 'yes', 1, 0, null, {}, []]) {
      h.calls = []
      const r = await teardownStorageForProject({ creds: CREDS, projectDir: dir, shown: [{ bucket: A, prefix: PREFIX, keepData: bad }, plain(B)] })
      expect(storageCalls(), String(bad)).toEqual([])
      expect(r, String(bad)).toMatchObject({ ok: false, reason: 'failed', done: [], remainingBuckets: [A, B], skippedBuckets: [A, B] })
    }
  })

  it('★★ 全部 keepData の回は、アダプタを作らない: 接続が失敗する状況でも ok:true で残る。消す側が混じる回は、接続の失敗で止まる（対照）', async () => {
    h.fail.connect = 'throw'
    const kept = await teardownStorageForProject({ creds: CREDS, projectDir: dir, shown: [keep(A), keep(B)] })
    expect(kept.ok).toBe(true)
    expect(storageCalls(), '接続（アダプタを作ること）そのものが出ていない').toEqual([])

    h.calls = []
    const mixed = await teardownStorageForProject({ creds: CREDS, projectDir: dir, shown: [keep(A), plain(B)] })
    expect(mixed.ok).toBe(false)
    expect(destructiveCalls()).toEqual([])
  })

  it('★★ 複製がいる回: 理由は複製の文のまま（「確認のあとで…」と言わない）。要求0件。鍵の警告は足さない（残したデータの説明が言う）', async () => {
    twin()
    const r = await teardownStorageForProject({
      creds: CREDS, projectDir: dir, permissionId: 'perm-rec', sweepKeysFor: 'apprun', placements: [{ bucket: A, prefix: PREFIX, shared: true }], shown: [keep(A)],
    })
    expect(storageCalls()).toEqual([])
    expect(r).toStrictEqual({
      ok: true, reason: 'done', permissionRevoked: false, warnings: [],
      done: [{ bucket: A, deletedBucket: false, note: `フォルダ『${TWIN}』も同じデータを使っています。`, keptReasons: { ownFiles: false, usedByOthers: true }, keptData: true }],
    })
  })

  it('★★ 複製かどうか確かめられない回: 理由は読めなかったフォルダの文のまま。理由は「どちらでもない」。要求0件', async () => {
    unreadSibling('broken-env')
    const r = await teardownStorageForProject({ creds: CREDS, projectDir: dir, placements: [{ bucket: A, prefix: PREFIX, shared: true }], shown: [keep(A)] })
    expect(storageCalls()).toEqual([])
    expect(r).toMatchObject({
      ok: true, reason: 'done',
      done: [{ bucket: A, deletedBucket: false, note: 'フォルダ『broken-env』の記録を読めないため、同じデータを使っているか確かめられませんでした。', keptReasons: { ownFiles: false, usedByOthers: false }, keptData: true }],
    })
  })

  it('★★ 無効にする鍵が元から無い回（記録の鍵なし・一括の無効化の指定なし）は、鍵の警告を足さない（言うことが無い）', async () => {
    const r = await teardownStorageForProject({ creds: CREDS, projectDir: dir, placements: [{ bucket: A, prefix: PREFIX, shared: true }], shown: [keep(A)] })
    expect(r.ok && r.reason === 'done' && r.warnings).toEqual([])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3つの IPC（本物の main）: 同じ振る舞い
// ═════════════════════════════════════════════════════════════════════════════
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

type Door = { name: string; run: (buckets: string[], shown: unknown) => Promise<any> }
const DOORS: Door[] = [
  {
    name: '共用型 cloud:teardown',
    run: async (buckets, shown) => {
      setup(dir, { env: buckets, resources: [APP, ...buckets.map(bucketRef)] })
      return sharedHandler(EVENT, dir, OK_AUTH, { confirmed: true, deleteRegistry: false, registryName: null, shownPlacements: shown })
    },
  },
  {
    name: 'HANAMII hanamii:teardown',
    run: async (buckets, shown) => {
      const PROJECT_ID = 'hnm-proj-1'
      setup(dir, { env: buckets, resources: [] })
      fs.writeFileSync(path.join(dir, '.sakuraide.json'), JSON.stringify({ publish: { hanamii: { projectId: PROJECT_ID } } }, null, 2), 'utf-8')
      globalThis.fetch = (async () => deleteProjectReply(200, PROJECT_ID)) as unknown as typeof fetch
      return hanamiiHandler(EVENT, dir, { token: 'hnm_test' }, { confirmed: true, projectId: PROJECT_ID, shownPlacements: shown })
    },
  },
  {
    name: '専有型 apprunDedicated:teardown',
    run: async (buckets, shown) => {
      setup(dir, { env: buckets, resources: [] })
      writeApprunDedicatedRecordFs(dir, { clusterID: 'c1' })
      d.baseUrl = await listen()
      return dedicatedHandler(EVENT, dir, { token: 'tok', secret: 'sec' }, { confirmed: true, shownPlacements: shown })
    },
  },
]

describe.each(DOORS)('★★★ $name: keepData の保存場所は、確認のあとで複製が消えても消さない', door => {
  it('★★★ 全部 keepData（複製の記録はもう無い）: 保存場所への要求は0件・ok:true・行は「データは残しました — 確認のあとで記録が変わったため、消していません。」。記録の保存場所は残る', async () => {
    const r = await door.run([A], [keep(A)])
    expect(destructiveCalls(), '消す要求・鍵の要求が出ている').toEqual([])
    expect(storageCalls()).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.executed.find((l: string) => l.includes(A))).toBe(CONFIRM_KEPT_LINE(A))
    expect(r.executed.join('\n')).not.toContain(DELETED_LINE_HEAD(A))
    expect(r.executed).toContain(KEY_WARNING_LINE)
    expect(r.keptBucketNames).toEqual([A])
    expect(envBuckets(dir), 'バケットを消していないので、記録に残す').toEqual([A])
  })

  it('★★★ 複製がまだいる回: 理由は複製の文。要求0件（一覧も出さない）。keepData の無かった従来は一覧の確認が1回出ていた', async () => {
    twin()
    const r = await door.run([A], [keep(A)])
    expect(storageCalls()).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.executed.find((l: string) => l.includes(A))).toBe(TWIN_KEPT_LINE(A))
    expect(r.executed).not.toContain(KEY_WARNING_LINE)
    expect(r.keptBucketsUsedByOthers).toEqual([A])
  })

  it('★★★ 混在（A は keepData・B は付かない）: A は0件・B は消える・鍵（記録の鍵・名前での一括）には触れない', async () => {
    h.permissions = [{ id: 'perm-old', displayName: 'koto-myapp-apprun' }]
    const r = await door.run([A, B], [keep(A), plain(B)])
    expect(touching(A), 'A に要求が出ている（消さないと言ったのに）').toEqual([])
    expect(h.calls).toEqual(expect.arrayContaining(gone(B)))
    expect(h.calls.filter(c => c.startsWith('deletePermission'))).toEqual([])
    expect(h.calls).not.toContain('listPermissions')
    expect(r.ok).toBe(true)
    expect(r.executed.find((l: string) => l.includes(A))).toBe(CONFIRM_KEPT_LINE(A))
    expect(r.executed.find((l: string) => l.includes(B))).toContain(DELETED_LINE_HEAD(B))
    expect(r.executed).toContain(KEY_WARNING_LINE)
    expect(envBuckets(dir), '消したバケットだけ記録から外れる').toEqual([A])
  })

  it('対照: 同じ呼び出しで keepData が無ければ、今までどおりバケットごと消し、名前での鍵の一括の無効化（listPermissions）が出る', async () => {
    h.permissions = [{ id: 'perm-old', displayName: 'koto-myapp-apprun' }]
    const r = await door.run([A], [plain(A)])
    expect(h.calls).toEqual(expect.arrayContaining(gone(A)))
    expect(h.calls).toContain('listPermissions')
    expect(r.ok).toBe(true)
    expect(r.executed.find((l: string) => l.includes(A))).toContain(DELETED_LINE_HEAD(A))
    expect(r.executed).not.toContain(KEY_WARNING_LINE)
  })

  it('★★ keepData の値が壊れている（真偽値でない）: 1件も見せていない扱い。要求0件・ok:false・保存場所は残りに', async () => {
    const r = await door.run([A], [{ bucket: A, prefix: PREFIX, keepData: 'true' }])
    expect(storageCalls()).toEqual([])
    expect(r.ok).toBe(false)
    expect(r.remainingBuckets).toEqual([A])
    expect(envBuckets(dir)).toEqual([A])
  })
})
