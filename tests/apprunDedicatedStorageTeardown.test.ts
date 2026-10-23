import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import type { Server } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── なぜこのテストが要るか（2026-09-24 Ryosuke 決定「①は案2・一貫性が重要」）────────────
// ⑥「すべて削除する」は、専有型では**保存場所（バケット・プレフィックス・鍵）を一切
// 片づけていなかった**。2026-09-23 まで専有型は保存場所を使っていなかったので無害だったが、
// 同日の修理（鍵を発行して渡すようにした）で**この穴が生きたものになった**——
// 破棄しても、消えたはずの保存場所へ届く鍵と、月額のかかるバケットが残る。
//
// ここは**ソースの文字列を読まない**（掟10「お金・破壊の歯止めは振る舞いで固定する」）。
// 偽の保存場所クライアントに実際に流し、**何が呼ばれ、何が呼ばれなかったか・その順序**を見る。
// **ここは利用者のデータを実際に消す経路**なので、いちばん大事なのは
// 「一覧できなければ1件も消さずに中止する」——「たぶん空」で消すのがいちばん危ない。

const ISSUED = { accessKey: 'AKIA-X', secretKey: 'S3CRET-X', permissionId: 'perm-tmp' }

/** 偽の保存場所。**呼ばれた操作を順番に積むだけ**（判断はしない）。 */
const h = vi.hoisted(() => ({
  baseUrl: '',
  handlers: new Map<string, (...args: any[]) => any>(),
  /** listAllKeys が返すバケットの中身。 */
  keys: [] as string[],
  /** 一覧そのものが失敗する（＝中身を確かめられない）か。 */
  listThrows: false,
  /** このバケットの一覧だけが失敗する（空なら無し。複数の保存場所の途中で止まる回に使う）。 */
  listThrowsFor: '',
  /** createStorageAdapter が失敗する（＝保存場所に接続できない）か。 */
  adapterThrows: false,
  /** deletePermission が失敗するか。 */
  revokeThrows: false,
  /** listPermissions が返す鍵の一覧（⑥の「その公開先の鍵をまとめて無効にする」の材料）。 */
  permissions: [] as { id: string; displayName: string }[],
  /** listPermissions そのものが失敗するか。 */
  listPermissionsThrows: false,
  /** 保存場所へ出た要求の一覧（順序込み）。**空であることを確かめるのに使う。** */
  storageCalls: [] as string[],
  deletedKeys: [] as string[],
  deletedBuckets: [] as string[],
  deletedPermissions: [] as string[],
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => '/tmp', getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {} },
  dialog: {},
}))

// 偽の保存場所クライアント。**実物の判断（storageTeardown.ts → teardownPlanFor）はそのまま動かす。**
vi.mock('../src/main/cloud/storageAdapter', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    createStorageAdapter: async () => {
      if (h.adapterThrows) throw new Error('保存場所に接続できません（テスト）')
      h.storageCalls.push('connect')
      return {
        siteInfo: () => ({ s3Endpoint: 's3.isk01.sakurastorage.jp', region: 'jp-north-1' }),
        async isSiteReady() { return true },
        async ensureBucket() { /* 破棄では使わない */ },
        async putMarker() { /* 破棄では使わない */ },
        async listAllKeys(bucket: string) {
          h.storageCalls.push(`listAllKeys ${bucket}`)
          if (h.listThrows || h.listThrowsFor === bucket) throw new Error('一覧を取得できませんでした（テスト）')
          return h.keys
        },
        async deleteKeys(bucket: string, keys: string[]) {
          h.storageCalls.push(`deleteKeys ${bucket}`)
          h.deletedKeys.push(...keys)
        },
        async deleteBucket(bucket: string) {
          h.storageCalls.push(`deleteBucket ${bucket}`)
          h.deletedBuckets.push(bucket)
        },
        async deletePermission(id: string) {
          h.storageCalls.push(`deletePermission ${id}`)
          if (h.revokeThrows) throw new Error('鍵を無効にできませんでした（テスト）')
          h.deletedPermissions.push(id)
        },
        async issueKey() { h.storageCalls.push('issueKey'); return ISSUED },
        async listPermissions() {
          h.storageCalls.push('listPermissions')
          if (h.listPermissionsThrows) throw new Error('パーミッションの一覧を取得できませんでした（テスト）')
          return h.permissions
        },
        async dispose() { h.storageCalls.push('dispose') },
      }
    },
  }
})

// 破棄の本体は**実物**を動かす。偽サーバへ向けるため baseUrl だけを足し、待たない sleep を入れる。
vi.mock('../src/main/cloud/apprunDedicatedApply', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    teardownFlow: (auth: any, dir: string, opts: any) =>
      real.teardownFlow(auth, dir, { ...opts, sleep: async () => {} }, h.baseUrl),
  }
})

import { registerApprunDedicatedHandlers } from '../src/main/ipc/apprunDedicated'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'
import { writeApprunDedicatedRecordFs, readApprunDedicatedFs, writePublishRecordFs } from '../src/main/publishMetaFs'
import { getOps, resetProjectOpsForTests } from '../src/main/projectOps'
import { BUCKET_MONTHLY_YEN, teardownRemainingWarnings } from '../src/shared/cloudCost'
import { isolatedProjectDir, workspaceDirOf } from './isolatedProject'

registerApprunDedicatedHandlers({} as any)
const teardown = h.handlers.get('apprunDedicated:teardown')!

const EVENT = { sender: { send: () => {} } }
const AUTH = { token: 'tok', secret: 'sec' }
const BUCKET = 'koto-data-x'
const PREFIX = 'projects/myapp/'
const CONSENTED_BUCKET = { bucket: BUCKET, prefix: PREFIX, shared: true, consentedAt: '2026-08-14T00:00:00.000Z' }

let server: Server | null = null
let projectDir = ''

beforeEach(() => {
  resetProjectOpsForTests()
  projectDir = isolatedProjectDir('koto-dedicated-teardown-')
  h.baseUrl = ''
  h.keys = [`${PREFIX}.koto-keep`]
  h.listThrows = false
  h.listThrowsFor = ''
  h.adapterThrows = false
  h.revokeThrows = false
  h.permissions = []
  h.listPermissionsThrows = false
  h.storageCalls = []
  h.deletedKeys = []
  h.deletedBuckets = []
  h.deletedPermissions = []
})
afterEach(() => {
  if (server) { server.close(); server = null }
  fs.rmSync(projectDir, { recursive: true, force: true })
})

// ── 下ごしらえ ────────────────────────────────────────────────────────

type Route = { status: number; body: unknown }

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

function routedServer(routes: Record<string, Route>, calls: string[]): http.RequestListener {
  return (req, res) => {
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
}

/** `.sakura-cloud/env.json`（保存場所は既定で同意済み）と、⑤で作られたクラスタの記録を置く。 */
function setupProject(opts: { storage?: boolean; permissionId?: string | null; applicationID?: string } = {}) {
  const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: false })
  if (opts.storage !== false) spec.persistence = { objectStorage: [CONSENTED_BUCKET] }
  else spec.persistence = { objectStorage: [] }
  fs.mkdirSync(path.join(projectDir, '.sakura-cloud'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), JSON.stringify(spec, null, 2), 'utf-8')
  writeApprunDedicatedRecordFs(projectDir, {
    clusterID: 'c1',
    ...(opts.applicationID ? { applicationID: opts.applicationID } : {}),
    ...(opts.permissionId !== undefined ? { storagePermissionId: opts.permissionId } : {}),
  })
}

/** クラスタだけを消す最短の応答（DELETE 204 → 一覧から消えたのを確認）。 */
function clusterGoneRoutes(): Record<string, Route> {
  return {
    'DELETE /clusters/c1': { status: 204, body: {} },
    'GET /clusters?maxItems=20': { status: 200, body: { clusters: [] } },
  }
}

async function runTeardown(routes: Record<string, Route> = clusterGoneRoutes()) {
  const calls: string[] = []
  h.baseUrl = await listen(routedServer(routes, calls))
  const result = await teardown(EVENT, projectDir, AUTH, { confirmed: true })
  return { result, calls }
}

/** 保存場所を実際に触る要求だけ（接続・dispose を除く）。 */
const touched = () => h.storageCalls.filter(c => c !== 'connect' && c !== 'dispose')

// ── 1. いちばん大事な守り ────────────────────────────────────────────────

describe('⑥の破棄: 保存場所を消す前に、必ず一覧して確かめる', () => {
  it('★★ 一覧できなかったら、削除の要求を1件も出さずに中止する（「たぶん空」で消さない）', async () => {
    setupProject({ permissionId: 'perm-live' })
    h.listThrows = true
    const { result } = await runTeardown()

    expect(result.ok).toBe(false)
    expect(result.message).toContain('中身を確認できないため、削除を中止しました')
    // **削除の要求は1件も出ていない**（鍵の無効化も含めて）。
    expect(touched()).toEqual([`listAllKeys ${BUCKET}`])
    expect(h.deletedKeys).toEqual([])
    expect(h.deletedBuckets).toEqual([])
    expect(h.deletedPermissions).toEqual([])
    // 消せていないので、鍵のIDは記録に残したまま（消すと、どこにも辿れない鍵が生き続ける）。
    expect(readApprunDedicatedFs(projectDir).storagePermissionId).toBe('perm-live')
  })

  it('保存場所に接続できないときも、削除の要求は1件も出ない', async () => {
    setupProject()
    h.adapterThrows = true
    const { result } = await runTeardown()

    expect(result.ok).toBe(false)
    expect(result.message).toContain('削除を中止しました')
    expect(h.storageCalls).toEqual([])
  })
})

// ── 2. 何を消してよいかは teardownPlanFor に任せる（ここで条件を書かない） ─────────────

describe('⑥の破棄: 消してよい範囲の判断', () => {
  it('★★ ほかのプロジェクトが使っている保存場所は、バケットごと消さない（自分の prefix だけ消す）', async () => {
    setupProject()
    h.keys = [`${PREFIX}a.txt`, `${PREFIX}b/c.json`, 'projects/other/data.json']
    const { result } = await runTeardown()

    expect(result.ok).toBe(true)
    expect(h.deletedKeys).toEqual([`${PREFIX}a.txt`, `${PREFIX}b/c.json`])
    expect(h.deletedBuckets).toEqual([]) // ← ここが true になると、他人のデータが道連れで消える
    expect(touched()).not.toContain(`deleteBucket ${BUCKET}`)
  })

  it('★ 利用者が自分で置いたファイル（projects/ の外）があれば、バケットごと消さない', async () => {
    setupProject()
    h.keys = [`${PREFIX}a.txt`, 'わたしの大事な資料.pdf']
    const { result } = await runTeardown()

    expect(result.ok).toBe(true)
    expect(h.deletedKeys).toEqual([`${PREFIX}a.txt`])
    expect(h.deletedBuckets).toEqual([])
  })

  it('★★ ほかに誰も使っていなければ、バケットごと消す（残すと月額の課金が続く）', async () => {
    setupProject()
    h.keys = [`${PREFIX}.koto-keep`, `${PREFIX}a.txt`]
    const { result } = await runTeardown()

    expect(result.ok).toBe(true)
    expect(h.deletedKeys).toEqual([`${PREFIX}.koto-keep`, `${PREFIX}a.txt`])
    expect(h.deletedBuckets).toEqual([BUCKET])
  })
})

// ── 2b. バケットを残した回は、「残った」事実を返す（処理の記録の警告になる・2026-09-30 検分）──────────
// 利用者のファイルがあってバケットごとは消さなかった回は、executed に「保存場所『X』を片づけました — …残します
// （月額の課金は続きます）」の1行が入るだけで、⚠️ が付かなかった。処理の記録（開き直した画面・上部の確認カード）は
// ⚠️・※ で始まる行だけを警告へ移すので、この回は「✅ 削除が終わりました」と出て、月額が続く一文は折りたたみの中に隠れた。
describe('★★★ ⑥の破棄: バケットを残した回は、残った事実（keptBucketName）を返し、記録の警告になる', () => {
  it('★★★ 利用者のファイルがあってバケットを残した: keptBucketName が返り、警告が1件（月額が続く）になる', async () => {
    setupProject()
    h.keys = [`${PREFIX}a.txt`, 'わたしの大事な資料.pdf']
    const { result } = await runTeardown()

    expect(result.ok).toBe(true)
    expect(h.deletedBuckets).toEqual([])
    expect(result.keptBucketName).toBe(BUCKET)
    expect(result.keptBucketNames).toEqual([BUCKET])
    const rec = getOps(projectDir).last!
    expect(rec.handler).toBe('apprunDedicated:teardown')
    expect(rec.result!.ok).toBe(true)
    expect(rec.result!.warnings, '月額が続くのに、警告になっていない（折りたたみの中に隠れる）').toHaveLength(1)
    expect(rec.result!.warnings[0]).toContain(`『${BUCKET}』`)
    expect(rec.result!.warnings[0]).toContain(`月額${BUCKET_MONTHLY_YEN}円`)
    // 共用型・HANAMII と同じ関数の文（公開先によって扱いが食い違わない）。残した理由（利用者のファイル）も事実として返り、文はそれを言う
    expect(result.keptBucketsWithOwnFiles).toEqual([BUCKET])
    expect(result.keptBucketsUsedByOthers).toBeUndefined()
    expect(rec.result!.warnings).toEqual(teardownRemainingWarnings({ keptBucketName: BUCKET, keptBucketsWithOwnFiles: [BUCKET] }))
    expect(rec.result!.warnings[0]).toContain('Koto が作ったのではないファイルがあります')
    expect(rec.result!.warnings[0], '利用者のファイルが入った保存場所に、言われたとおり消してよいとは言わない').not.toContain('後で消す場合は')
  })

  it('★★ ほかのプロジェクトが使っている保存場所を残した回も、同じ', async () => {
    setupProject()
    h.keys = [`${PREFIX}a.txt`, 'projects/other/data.json']
    const { result } = await runTeardown()
    expect(result.keptBucketName).toBe(BUCKET)
    expect(getOps(projectDir).last!.result!.warnings).toHaveLength(1)
    // 残した理由（ほかのプロジェクトも使っている）が返り、「後で消す場合は削除して」ではなく、消すとそのアプリが止まると言う（共用型・HANAMII と同じ判断）
    expect(result.keptBucketsUsedByOthers).toEqual([BUCKET])
    expect(result.keptBucketsWithOwnFiles).toBeUndefined()
    expect(getOps(projectDir).last!.result!.warnings[0]).toContain('ほかのプロジェクトも使っています。消すと、そのプロジェクトのデータも消えます。')
    expect(getOps(projectDir).last!.result!.warnings[0]).not.toContain('後で消す場合は')
  })

  it('★★ バケットごと消した回・保存場所を使っていない回は、残った事実を返さない（警告を出さない）', async () => {
    setupProject()
    h.keys = [`${PREFIX}a.txt`]
    const first = await runTeardown()
    expect(h.deletedBuckets).toEqual([BUCKET])
    expect(first.result.keptBucketName).toBeUndefined()
    expect(getOps(projectDir).last!.result!.warnings).toEqual([])

    resetProjectOpsForTests()
    setupProject({ storage: false })
    const second = await runTeardown()
    expect(second.result.keptBucketName).toBeUndefined()
    expect(getOps(projectDir).last!.result!.warnings).toEqual([])
  })

  it('★★★ 残した保存場所が2つあれば、両方の名前と、合計の月額を言う（名前が出なかった分の月額が黙って続かない）', async () => {
    const BUCKET2 = 'koto-data-y'
    const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: false })
    spec.persistence = { objectStorage: [CONSENTED_BUCKET, { bucket: BUCKET2, prefix: PREFIX, shared: true, consentedAt: '2026-08-14T00:00:00.000Z' }] } as any
    fs.mkdirSync(path.join(projectDir, '.sakura-cloud'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), JSON.stringify(spec, null, 2), 'utf-8')
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1' })
    h.keys = [`${PREFIX}a.txt`, 'わたしの大事な資料.pdf']
    const { result } = await runTeardown()

    expect(result.keptBucketNames).toEqual([BUCKET, BUCKET2])
    const warnings = getOps(projectDir).last!.result!.warnings
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`『${BUCKET}』`)
    expect(warnings[0]).toContain(`『${BUCKET2}』`)
    expect(warnings[0]).toContain(`月額${BUCKET_MONTHLY_YEN * 2}円`)
  })
})

// ── 3. 鍵（2026-09-23 に発行するようになったもの）を無効にする ───────────────────────

describe('⑥の破棄: 保存場所の鍵を無効にする', () => {
  it('★★ 記録された鍵を無効にし、記録から外す', async () => {
    setupProject({ permissionId: 'perm-live' })
    const { result } = await runTeardown()

    expect(result.ok).toBe(true)
    expect(h.deletedPermissions).toEqual(['perm-live'])
    expect(readApprunDedicatedFs(projectDir).storagePermissionId).toBeFalsy()
  })

  it('★★ 鍵の記録が無い（2026-09-23 より前に公開した）ときは、無効化だけ飛ばして破棄は続ける', async () => {
    setupProject() // storagePermissionId を記録しない
    const { result } = await runTeardown()

    expect(result.ok).toBe(true)
    expect(h.deletedPermissions).toEqual([])
    expect(touched().some(c => c.startsWith('deletePermission'))).toBe(false)
    // 保存場所そのものの片づけは、記録が無くても行われる
    expect(h.deletedBuckets).toEqual([BUCKET])
  })

  it('★★ 鍵を無効にするのは、バケットを消したあと（先に消すと中身を消せずに 403 で止まる）', async () => {
    setupProject({ permissionId: 'perm-live' })
    h.keys = [`${PREFIX}a.txt`]
    const { result } = await runTeardown()

    expect(result.ok).toBe(true)
    const order = touched()
    expect(order).toEqual([
      `listAllKeys ${BUCKET}`,
      `deleteKeys ${BUCKET}`,
      `deleteBucket ${BUCKET}`,
      'deletePermission perm-live',
      // 2026-09-24 検分の指摘6: 記録の1件を消したあと、同じ名前の鍵が残っていないか一覧で確かめる。
      'listPermissions',
    ])
  })

  it('アクセスキーを無効にできなかったら黙らない。記録も残す（辿れないアクセスキーを作らない）', async () => {
    setupProject({ permissionId: 'perm-live' })
    h.revokeThrows = true
    const { result } = await runTeardown()

    expect(result.ok).toBe(true) // 保存場所そのものは片づいている
    expect(result.executed.some((e: string) => e.includes('アクセスキーを無効にできませんでした'))).toBe(true)
    // 0.6.21（作者の決定 2026-10-01）: 「鍵」は「アクセスキー」に揃えた。直す前の言い方は戻さない
    expect(result.executed.some((e: string) => e.includes('鍵を無効'))).toBe(false)
    expect(readApprunDedicatedFs(projectDir).storagePermissionId).toBe('perm-live')
  })
})

// ── 4. 触ってはいけないもの（掟11 環境の独立） ─────────────────────────────────

describe('保存場所に触らない経路', () => {
  it('★★ アプリだけを消す口（apprunDedicated:teardownApp）は無い。📡 の 🗑 も手順6と同じ apprunDedicated:teardown を呼ぶ（2026-10-08）', () => {
    expect(h.handlers.has('apprunDedicated:teardownApp')).toBe(false)
    expect(h.handlers.has('apprunDedicated:teardown')).toBe(true)
  })

  it('★★ 📡 の 🗑 と同じ呼び出し（アプリあり）: アプリ → クラスタが消えたあと、保存場所のデータ・鍵まで片づける（アプリだけで止まらない）', async () => {
    setupProject({ permissionId: 'perm-live', applicationID: 'app1' })
    h.keys = [`${PREFIX}a.txt`]
    const { result, calls } = await runTeardown({
      'GET /applications/app1': { status: 200, body: { application: { applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion: null } } },
      'GET /applications/app1/containers': { status: 200, body: { nodes: [] } },
      'DELETE /applications/app1': { status: 204, body: {} },
      'GET /applications?clusterID=c1&maxItems=20': { status: 200, body: { applications: [] } },
      ...clusterGoneRoutes(),
    })

    expect(result.ok).toBe(true)
    expect(calls.filter(c => c.startsWith('DELETE '))).toEqual(['DELETE /applications/app1', 'DELETE /clusters/c1'])
    // 保存場所まで片づけた（以前の「アプリだけ」の口は、保存場所へ接続すらしなかった）
    expect(h.deletedKeys).toEqual([`${PREFIX}a.txt`])
    expect(h.deletedBuckets).toEqual([BUCKET])
    expect(h.deletedPermissions).toEqual(['perm-live'])
    expect(readApprunDedicatedFs(projectDir).storagePermissionId ?? null).toBeNull()
  })

  it('★ 保存場所を使っていないプロジェクトでは、保存場所へ1件も要求を出さない', async () => {
    setupProject({ storage: false })
    const { result } = await runTeardown()

    expect(result.ok).toBe(true)
    expect(h.storageCalls).toEqual([])
  })

  it('★ 計算資源の削除が途中で止まったら、保存場所には触らない（アプリがまだ動いている）', async () => {
    setupProject({ permissionId: 'perm-live' })
    const { result } = await runTeardown({
      'DELETE /clusters/c1': { status: 500, body: { error: 'boom' } },
    })

    expect(result.ok).toBe(false)
    expect(h.storageCalls).toEqual([])
    expect(readApprunDedicatedFs(projectDir).storagePermissionId).toBe('perm-live')
  })

  it('確認ダイアログを通っていなければ、保存場所へも1件も要求を出さない（掟10の3点セット）', async () => {
    setupProject({ permissionId: 'perm-live' })
    const calls: string[] = []
    h.baseUrl = await listen(routedServer(clusterGoneRoutes(), calls))
    const result = await teardown(EVENT, projectDir, AUTH, { confirmed: false })

    expect(result.ok).toBe(false)
    expect(calls).toEqual([])
    expect(h.storageCalls).toEqual([])
  })
})

// ── 4b. 幽霊の行（2026-10-08 検分の指摘）──────────────────────────────────────────
// 資源の記録（アプリ・LB・ASG・クラスタの ID）は空で、公開記録（📡 の行）だけが残っている行。📡 の専有型の行は公開記録がある限り
// 🗑 を出す（手順6のボタンのように、記録が空なら隠す条件が無い）ので、その行の 🗑 が `apprunDedicated:teardown` に届く。
// teardownFlow は「記録がありません」で ok:true を返す——そのまま保存場所の片づけへ進むと、**何を消すか名指しできないまま**
// プロジェクトの保存場所のデータ（ほかの公開先が使っているものを含む）と鍵が消え、しかも行は残って押すたびに繰り返された。
// いまは: 消すものが記録に無い（資源のIDが無く、前回の保存場所の残りの印も無い）なら保存場所には触れず、行だけを外す。

describe('幽霊の行（資源の記録が空・公開記録だけ残っている）の 🗑', () => {
  const targetsOfDir = (): string[] => {
    const meta = JSON.parse(fs.readFileSync(path.join(projectDir, '.sakuraide.json'), 'utf-8'))
    return Object.keys(meta?.publish?.targets ?? {}).sort()
  }
  /** 保存場所の設定（同意済み）はあるが、専有型の資源の記録は空。公開記録は専有型のほかに、共用型 AppRun もある。 */
  function setupGhost() {
    const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: false })
    spec.persistence = { objectStorage: [CONSENTED_BUCKET] }
    fs.mkdirSync(path.join(projectDir, '.sakura-cloud'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), JSON.stringify(spec, null, 2), 'utf-8')
    writePublishRecordFs(projectDir, 'sakura-apprun-dedicated', { publishedAt: '2026-09-28T00:00:00.000Z', url: 'https://app.example.com/' })
    writePublishRecordFs(projectDir, 'sakura-apprun', { publishedAt: '2026-09-27T00:00:00.000Z', url: 'https://shared.example.com/' })
  }

  it('★★★ 保存場所へは1本も要求を出さない（接続すらしない）。さくらへの要求も0本。データ・バケット・鍵は消えない', async () => {
    setupGhost()
    h.keys = [`${PREFIX}db.sqlite`, `${PREFIX}shared-app-data.sqlite`]
    const { result, calls } = await runTeardown({})

    expect(result.ok).toBe(true)
    expect(result.message).toContain('記録がありません')
    expect(calls).toEqual([])
    expect(h.storageCalls).toEqual([]) // connect も listAllKeys も deleteKeys も deleteBucket も無い
    expect(h.deletedKeys).toEqual([])
    expect(h.deletedBuckets).toEqual([])
    expect(h.deletedPermissions).toEqual([])
    // env.json の保存場所の記録もそのまま
    expect(readObjectStorage().map((p: any) => p.bucket)).toEqual([BUCKET])
  })

  it('★★ 専有型の行（公開記録）だけが外れる。共用型 AppRun の行は残る（旧 📡 の「幽霊を消す出口」と同じ救済）', async () => {
    setupGhost()
    expect(targetsOfDir()).toEqual(['sakura-apprun', 'sakura-apprun-dedicated'])
    const { result } = await runTeardown({})

    expect(result.ok).toBe(true)
    expect(targetsOfDir()).toEqual(['sakura-apprun'])
  })

  it('★★ 確認ダイアログを通っていなければ（confirmed:false）、行も外さない・保存場所にも触れない', async () => {
    setupGhost()
    h.baseUrl = await listen(routedServer({}, []))
    const result = await teardown(EVENT, projectDir, AUTH, { confirmed: false })

    expect(result.ok).toBe(false)
    expect(h.storageCalls).toEqual([])
    expect(targetsOfDir()).toEqual(['sakura-apprun', 'sakura-apprun-dedicated'])
  })

  it('★ 前回の保存場所の残りの印（storageLeftoverBucket）がある行は「消すものがある」＝保存場所の片づけまで進む（押し直せる）', async () => {
    setupGhost()
    writeApprunDedicatedRecordFs(projectDir, { storageLeftoverBucket: BUCKET })
    h.keys = [`${PREFIX}a.txt`]
    const { result } = await runTeardown({})

    expect(result.ok).toBe(true)
    expect(h.deletedKeys).toEqual([`${PREFIX}a.txt`])
    expect(h.deletedBuckets).toEqual([BUCKET])
    expect(targetsOfDir()).toEqual(['sakura-apprun']) // 全部消せたので行も外れる
  })
})

// ── 5. 片づけに失敗したときに、利用者が取り残されないか（2026-09-24 検分の指摘1・4・5） ──────

describe('⑥の破棄: 保存場所だけが失敗したとき', () => {
  it('★★ 残っているバケット名を「残っています」の一覧に載せる（指摘5）', async () => {
    setupProject({ permissionId: 'perm-live' })
    h.listThrows = true
    const { result } = await runTeardown()

    expect(result.ok).toBe(false)
    // 計算資源のIDは1件も残っていない（全部消えている）。ここが空のままだと、
    // 画面の赤い「残っています＝課金が続きます」の下に1件も出ない。
    expect(result.remaining.clusterID).toBeUndefined()
    expect(result.remaining.storageBucket).toBe(BUCKET)
  })

  it('★★ 計算資源は消えたことを appDeleted で伝える（指摘4・9・13の幽霊を防ぐ）', async () => {
    setupProject({ permissionId: 'perm-live', applicationID: 'app1' })
    h.listThrows = true
    const { result } = await runTeardown({
      'GET /applications/app1': { status: 200, body: { application: { applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion: null } } },
      'GET /applications/app1/containers': { status: 200, body: { nodes: [] } },
      'DELETE /applications/app1': { status: 204, body: {} },
      'GET /applications?clusterID=c1&maxItems=20': { status: 200, body: { applications: [] } },
      ...clusterGoneRoutes(),
    })

    expect(result.ok).toBe(false)            // 保存場所は残った
    expect(result.appDeleted).toBe(true)     // でもアプリは消えた（公開記録＝📡 の行は残す。押し直して保存場所まで片づくと消える・D1=1）
    expect(readApprunDedicatedFs(projectDir).applicationID).toBeFalsy()
  })

  it('★★ 記録に印（storageLeftoverBucket）を残し、⑥をもう一度押せば片づく（指摘1）', async () => {
    setupProject({ permissionId: 'perm-live' })
    h.listThrows = true
    const first = await runTeardown()
    expect(first.result.ok).toBe(false)
    // 窓を閉じて開き直しても分かる形で残す（画面の state ではなくファイルの記録）。
    expect(readApprunDedicatedFs(projectDir).storageLeftoverBucket).toBe(BUCKET)
    // 計算資源の記録は空になっている＝従来の hasAnyResource ではボタンが出ない状態。
    expect(readApprunDedicatedFs(projectDir).clusterID).toBeFalsy()

    // 押し直す。計算資源の記録が空でも、保存場所の片づけまで進む。
    if (server) { server.close(); server = null }
    h.listThrows = false
    h.storageCalls = []
    const second = await runTeardown({})

    expect(second.result.ok).toBe(true)
    expect(h.deletedBuckets).toEqual([BUCKET])
    expect(h.deletedPermissions).toEqual(['perm-live'])
    expect(readApprunDedicatedFs(projectDir).storageLeftoverBucket).toBeFalsy()
  })
})

// ── 6. バケットを消したら、env.json の記録も外す（2026-09-24 検分の指摘3・8） ─────────────

function readObjectStorage(): any[] {
  const raw = JSON.parse(fs.readFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), 'utf-8'))
  return raw?.persistence?.objectStorage ?? []
}

describe('⑥の破棄: env.json の保存場所の記録', () => {
  it('★★ バケットごと消したら、env.json の persistence.objectStorage からも外す', async () => {
    setupProject({ permissionId: 'perm-live' })
    h.keys = [`${PREFIX}.koto-keep`]
    const { result } = await runTeardown()

    expect(result.ok).toBe(true)
    expect(h.deletedBuckets).toEqual([BUCKET])
    // 残すと、次の⑧公開が**消えたバケット宛ての鍵**を渡して「成功」してしまう。
    expect(readObjectStorage()).toEqual([])
  })

  it('★★ バケットを残した（ほかのプロジェクトが使っている）ときは、記録も残す', async () => {
    setupProject({ permissionId: 'perm-live' })
    h.keys = [`${PREFIX}a.txt`, 'projects/other/data.json']
    const { result } = await runTeardown()

    expect(result.ok).toBe(true)
    expect(h.deletedBuckets).toEqual([])
    expect(readObjectStorage().map((b: any) => b.bucket)).toEqual([BUCKET])
  })
})

// ── 7. 同意済みの保存場所が複数あるとき（2026-09-24 検分の指摘10） ──────────────────────

describe('⑥の破棄: 同意済みの保存場所が2つあるとき', () => {
  const BUCKET2 = 'koto-data-y'

  function setupTwoBuckets() {
    const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: false })
    spec.persistence = {
      objectStorage: [
        CONSENTED_BUCKET,
        { bucket: BUCKET2, prefix: PREFIX, shared: true, consentedAt: '2026-08-14T00:00:00.000Z' },
      ],
    } as any
    fs.mkdirSync(path.join(projectDir, '.sakura-cloud'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), JSON.stringify(spec, null, 2), 'utf-8')
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', storagePermissionId: 'perm-live' })
  }

  it('★★ 2つとも片づける（先頭1件だけだと、2つ目の月額が黙って続く）', async () => {
    setupTwoBuckets()
    h.keys = [`${PREFIX}.koto-keep`]
    const { result } = await runTeardown()

    expect(result.ok).toBe(true)
    expect(h.deletedBuckets).toEqual([BUCKET, BUCKET2])
    expect(readObjectStorage()).toEqual([])
    expect(result.executed.some((e: string) => e.includes(BUCKET))).toBe(true)
    expect(result.executed.some((e: string) => e.includes(BUCKET2))).toBe(true)
  })

  it('★ 1件目で失敗したら黙らない（2件目には進まず、残っているバケット名を返す）', async () => {
    setupTwoBuckets()
    h.listThrows = true
    const { result } = await runTeardown()

    expect(result.ok).toBe(false)
    expect(result.remaining.storageBucket).toBe(BUCKET)
    expect(h.deletedBuckets).toEqual([])
  })

  // 途中で止まった回の返り値にも、それまでに残した保存場所の理由が載る（HANAMII の「片づけの途中で止まった回も…」と同じ形。
  // 載らないと、止まった回だけ「理由が分からない」文になる＝ほかのプロジェクトも使う保存場所に、理由を言わずに「消す前に確かめてください」と言う）。
  it('★★★ 2件目の一覧に失敗して止まった回も、1件目に残した保存場所の理由（ほかのプロジェクトも使っている）を返し、警告が言う', async () => {
    setupTwoBuckets()
    h.keys = [`${PREFIX}a.txt`, 'projects/other/data.json'] // 1件目: ほかのプロジェクトが使っているのでバケットは残る
    h.listThrowsFor = BUCKET2                                 // 2件目: 一覧できず、そこで止まる
    const { result } = await runTeardown()

    expect(result.ok).toBe(false)
    expect(result.keptBucketName).toBe(BUCKET)
    expect(result.keptBucketNames).toEqual([BUCKET])
    expect(result.keptBucketsUsedByOthers, '止まった回に、残した理由が載っていない').toEqual([BUCKET])
    expect(result.keptBucketsWithOwnFiles).toBeUndefined()
    expect(result.remainingBuckets).toEqual([BUCKET2])
    expect(h.deletedBuckets).toEqual([])
    const warnings = getOps(projectDir).last!.result!.warnings
    const kept = warnings.find((w: string) => w.includes(`『${BUCKET}』`) && w.includes('月額'))!
    expect(kept, '残した保存場所の月額の警告が無い').toBeTruthy()
    expect(kept).toContain('ほかのプロジェクトも使っています。消すと、そのプロジェクトのデータも消えます。')
    expect(kept).not.toContain('使っているプロジェクトが無いか確かめてください') // 理由が分からない側の文に倒れていない
  })
})

// ── 8. この公開先の鍵をまとめて無効にする（2026-09-24 検分の指摘6） ────────────────────

describe('⑥の破棄: 古い鍵も含めてまとめて無効にする', () => {
  const MINE = 'koto-myapp_apprun-dedicated'

  it('★★ 記録の1件だけでなく、この公開先の名前の鍵を全部無効にする', async () => {
    setupProject({ permissionId: 'perm-live' })
    // 確認が確定しないまま2回以上公開すると、記録からも消えた古い鍵が残る。
    h.permissions = [
      { id: 'perm-old-1', displayName: MINE },
      { id: 'perm-old-2', displayName: MINE },
    ]
    const { result } = await runTeardown()

    expect(result.ok).toBe(true)
    expect(h.deletedPermissions).toEqual(['perm-live', 'perm-old-1', 'perm-old-2'])
  })

  it('★★ ほかのプロジェクト・ほかの公開先の鍵には触れない（掟11）', async () => {
    setupProject({ permissionId: 'perm-live' })
    h.permissions = [
      { id: 'perm-old-1', displayName: MINE },
      { id: 'perm-shared', displayName: 'koto-myapp' },              // 共用型
      { id: 'perm-hanamii', displayName: 'koto-myapp-hanamii' },     // HANAMII
      { id: 'perm-other', displayName: 'koto-other_apprun-dedicated' }, // 別プロジェクト
    ]
    const { result } = await runTeardown()

    expect(result.ok).toBe(true)
    expect(h.deletedPermissions).toEqual(['perm-live', 'perm-old-1'])
  })

  it('★ 消せなかったら黙らない（warnings として結果に出す）', async () => {
    setupProject({ permissionId: null })
    h.permissions = [{ id: 'perm-old-1', displayName: MINE }]
    h.revokeThrows = true
    const { result } = await runTeardown()

    expect(result.ok).toBe(true) // 保存場所そのものは片づいている
    expect(result.executed.some((e: string) => e.includes('アクセスキーを1件、無効にできませんでした'))).toBe(true)
    expect(result.executed.some((e: string) => e.includes('鍵を1件'))).toBe(false) // 0.6.21: 直す前の言い方は戻さない
  })

  it('★ アクセスキーの一覧が引けなくても、破棄そのものは失敗にしない（保存場所は既に片づいている）', async () => {
    setupProject({ permissionId: 'perm-live' })
    h.listPermissionsThrows = true
    const { result } = await runTeardown()

    expect(result.ok).toBe(true)
    expect(result.executed.some((e: string) => e.includes('パーミッション（アクセスキー）の一覧を取得できなかった'))).toBe(true)
    expect(result.executed.some((e: string) => e.includes('保存場所の鍵の一覧'))).toBe(false) // 0.6.21: 直す前の言い方は戻さない
    // 一覧が引けないので現役が分からない＝記録の鍵のIDは残す（辿れない鍵を作らない）。
    expect(readApprunDedicatedFs(projectDir).storagePermissionId).toBe('perm-live')
  })
})

// ── 9. env.json が壊れていても、消したものの一覧を失わない（指摘12・14・15） ────────────

describe('⑥の破棄: env.json が壊れているとき', () => {
  it('★★ 例外を外へ出さず、計算資源の削除結果（executed）を保ったまま返す', async () => {
    setupProject({ permissionId: 'perm-live' })
    fs.writeFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), '{ これは JSON ではない', 'utf-8')
    const { result } = await runTeardown()

    // 例外が IPC を突き抜けると、画面は「何も起きずに失敗した」ように見える（掟10）。
    expect(result.ok).toBe(false)
    expect(result.appDeleted).toBe(true)
    expect(result.executed.length).toBeGreaterThan(0)
    expect(result.executed.some((e: string) => e.includes('クラスタ'))).toBe(true)
    expect(result.message).toContain('保存場所の設定を読めないため')
    // 読めないので保存場所には1件も触っていない。
    expect(h.storageCalls).toEqual([])
  })
})

// ── ほかのプロジェクトの記録を読んでから、バケットごと消すか決める（2026-10-21 実機の欠陥・rc1-ded1 の専有型の削除がそのまま起こした形）──────────
//
// 実機: 専有型の rc1-ded1 を手順6で削除したら、teardownPlanFor が S のキー一覧だけを見て「ほかに使う prefix が無い」と判断し、**S をバケットごと消した**。
// rc1-shared の env.json には S が同意済みで残っていた（見ていなかった）。ここは専有型の破棄（apprunDedicated:teardown ＝ 手順6と 📡 の 🗑 が同じ道）で、
// 兄弟の記録から使っていると分かるとき・わからないときに、バケット削除の要求が0件になることを固定する。
describe('★★★ ⑥の破棄: ほかのプロジェクトの記録に同じ保存場所があれば、バケットごとは消さない', () => {
  /** 兄弟のプロジェクトを同じ親フォルダに置く。`published` は公開の記録（.sakuraide.json の共用型の行）。兄弟が「いま使っている」と数えられるのは、公開の記録がまだあるとき。 */
  function sibling(name: string, opts: { consent?: string[]; rawEnv?: string; published?: boolean } = {}) {
    const dir = path.join(workspaceDirOf(projectDir), name)
    fs.mkdirSync(path.join(dir, '.sakura-cloud'), { recursive: true })
    const file = path.join(dir, '.sakura-cloud', 'env.json')
    if (opts.rawEnv !== undefined) fs.writeFileSync(file, opts.rawEnv)
    else fs.writeFileSync(file, JSON.stringify({ persistence: { objectStorage: (opts.consent ?? []).map(bucket => ({ bucket, prefix: `projects/${name}/`, shared: true, consentedAt: '2026-10-19T00:00:00.000Z' })) } }))
    if (opts.published) fs.writeFileSync(path.join(dir, '.sakuraide.json'), JSON.stringify({ publish: { targets: { 'sakura-apprun': { publishedAt: '2026-10-19T00:00:00.000Z', url: 'https://x.example/' } } } }))
  }

  it('★★★ 実機の再現: キーには自分の prefix しか無いが、兄弟の env.json に同意済みで残っている → バケット削除0件・自分のキーだけ消す・「ほかのプロジェクトも使っています」', async () => {
    setupProject({ permissionId: 'perm-live' })
    h.keys = [`${PREFIX}data.json`] // 自分の prefix しか無い
    sibling('rc1-shared', { consent: [BUCKET], published: true })
    const { result } = await runTeardown()

    expect(result.ok).toBe(true)
    expect(h.deletedBuckets, 'バケットごと消した（実機の欠陥）').toEqual([])
    expect(touched()).not.toContain(`deleteBucket ${BUCKET}`)
    expect(h.deletedKeys).toEqual([`${PREFIX}data.json`])
    expect(h.deletedPermissions).toEqual(['perm-live'])
    expect(result.keptBucketName).toBe(BUCKET)
    expect(result.keptBucketsUsedByOthers).toEqual([BUCKET])
    expect(teardownRemainingWarnings(result).join('\n')).toContain('ほかのプロジェクトも使っています')
  })

  it('★★★ 兄弟の記録を読めない（壊れた JSON）→ わからないので残す。「ほかのプロジェクトも使っています」とは言わない', async () => {
    setupProject()
    h.keys = [`${PREFIX}data.json`]
    sibling('broken', { rawEnv: '{ not json' })
    const { result } = await runTeardown()

    expect(result.ok).toBe(true)
    expect(h.deletedBuckets).toEqual([])
    expect(h.deletedKeys).toEqual([`${PREFIX}data.json`])
    expect(result.keptBucketName).toBe(BUCKET)
    expect(result.keptBucketsUsedByOthers).toBeUndefined()
    const warning = teardownRemainingWarnings(result).join('\n')
    expect(warning).toContain('使っているプロジェクトが無いか確かめてください')
    expect(warning).not.toContain('ほかのプロジェクトも使っています')
  })

  it('★ 兄弟が別のバケットだけを使っている → 今までどおりバケットごと消す', async () => {
    setupProject()
    h.keys = [`${PREFIX}data.json`]
    sibling('uses-other', { consent: ['koto-data-other'], published: true })
    const { result } = await runTeardown()

    expect(result.ok).toBe(true)
    expect(h.deletedBuckets).toEqual([BUCKET])
    expect(result.executed).toContain(`保存場所『${BUCKET}』のデータを削除しました — 保存場所ごと削除しました。月額の課金も止まります。`)
  })
})

// ── 兄弟が「いま使っている」かは、設定に加えて公開の記録（.sakuraide.json の行）で決める（8f5e9d8 の直後に見つかった回帰）────────────────
// 共用型・HANAMII・専有型の破棄は、ほかが使うので残したバケットを env.json・state.json に残す（設定から外さない）。設定だけで数えると、
// 同じ保存場所 S を使う A・B を順に破棄したとき、B の破棄が**破棄済みの A** を使用者と読み、S は誰にも消せず月額が続いた。
describe('★★★ ⑥の破棄: 回帰 — 同じ保存場所を使う A・B を順に破棄すると、最後の破棄でバケットごと消える', () => {
  const PREFIX_A = 'projects/proj-a/'
  const PREFIX_B = 'projects/proj-b/'
  /** 専有型で公開中のプロジェクト（保存場所を同意済み・クラスタの記録と公開の記録＝専有型の行あり）。 */
  function publishedProject(dir: string, prefix: string) {
    const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: false })
    spec.persistence = { objectStorage: [{ ...CONSENTED_BUCKET, prefix }] }
    fs.mkdirSync(path.join(dir, '.sakura-cloud'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.sakura-cloud', 'env.json'), JSON.stringify(spec, null, 2), 'utf-8')
    writeApprunDedicatedRecordFs(dir, { clusterID: 'c1' })
    writePublishRecordFs(dir, 'sakura-apprun-dedicated', { publishedAt: '2026-10-19T00:00:00.000Z', url: 'https://x.example/' })
  }
  /** 指定したプロジェクトの⑥の破棄を、偽サーバ（クラスタだけを消す最短の応答）へ流す。 */
  async function teardownAt(dir: string) {
    if (server) { server.close(); server = null }
    h.baseUrl = await listen(routedServer(clusterGoneRoutes(), []))
    return teardown(EVENT, dir, AUTH, { confirmed: true })
  }
  const metaTargets = (dir: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(dir, '.sakuraide.json'), 'utf-8'))?.publish?.targets ?? {}

  it('A を破棄 → S は残る（B が公開中）。続けて B を破棄（A は破棄済みで行が無い）→ バケット削除の要求が1件・「保存場所ごと削除しました」', async () => {
    const dirB = path.join(workspaceDirOf(projectDir), 'proj-b')
    fs.mkdirSync(dirB)
    publishedProject(projectDir, PREFIX_A)
    publishedProject(dirB, PREFIX_B)

    // 1. A を破棄。S のキーは A の prefix だけ（B の prefix は目印ごと消えていた・実機と同じ）。B は公開中なので S は残る
    h.keys = [`${PREFIX_A}data.json`]
    const first = await teardownAt(projectDir)
    expect(first.ok).toBe(true)
    expect(h.deletedBuckets, 'B が公開中なのに S を消した').toEqual([])
    expect(first.keptBucketsUsedByOthers).toEqual([BUCKET])
    // A の公開の記録（専有型の行）は消える。設定（env.json の S）は残る（設定から外さない作り）
    expect(metaTargets(projectDir)['sakura-apprun-dedicated']).toBeUndefined()
    expect(JSON.parse(fs.readFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), 'utf-8')).persistence.objectStorage.map((b: any) => b.bucket)).toEqual([BUCKET])

    // 2. 続けて B を破棄。A は破棄済み（公開の記録が無い）なので数えない → S をバケットごと消す
    h.keys = [`${PREFIX_B}data.json`]
    const second = await teardownAt(dirB)
    expect(second.ok).toBe(true)
    expect(h.deletedBuckets, '最後の破棄で S が消えない（月額が続く・回帰）').toEqual([BUCKET])
    expect(h.storageCalls.filter(c => c === `deleteBucket ${BUCKET}`)).toHaveLength(1)
    expect(second.keptBucketName).toBeUndefined()
    expect(second.keptBucketsUsedByOthers).toBeUndefined()
    expect(second.executed).toContain(`保存場所『${BUCKET}』のデータを削除しました — 保存場所ごと削除しました。月額の課金も止まります。`)
  })
})
