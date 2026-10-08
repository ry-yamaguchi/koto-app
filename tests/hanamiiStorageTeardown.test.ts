import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── なぜこのテストが要るか（2026-09-25 検分）────────────────────────────────
// 📡 公開したもの一覧の「🗑 破棄」は、HANAMII でも確認オーバーレイに
// 「保存場所『koto-data-xxxx』にある、このプロジェクトのデータも削除します。…この保存場所を
// 使っているプロジェクトがほかに無ければ、保存場所そのものも削除して月額を止めます。」と出す
// （shared/teardownSupport.ts の teardownDataNoteFor。teardownRemovesStorage('hanamii','list') が true）。
//
// ところが当時の `hanamii:teardown` は HANAMII のプロジェクトを消すだけで、
// **バケットも、その中のデータも、鍵（koto-<名前>-hanamii）も1件も消していなかった。**
// 画面が「月額を止めます」と言い切った後なので利用者はコントロールパネルを確認せず、
// **月額495円が止まらないまま、消したはずのアプリの鍵がバケットへ読み書きできるまま生き残る。**
// 専有型の⑥で直したのとまったく同じ形である。
//
// そして tests/teardownSupport.test.ts は `teardownRemovesStorage('hanamii','list')` が true で
// あることだけを固定していた——**テストは断定を固定するだけで、断定が正しいかは確かめない**
// （掟10・#34 レジストリと同じ形）。だからここは**ソースの文字列を読まない**。
// 偽の保存場所と偽の HANAMII API に実際に流し、**何が呼ばれ、何が呼ばれなかったか・その順序**を見る。
//
// **ここは利用者のデータを実際に消す経路**なので、いちばん大事なのは
// 「一覧できなければ1件も消さずに中止する」——「たぶん空」で消すのがいちばん危ない。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  /** さくらのクラウドの認証情報が登録されているか（保存場所の鍵はこれで読む）。 */
  hasCreds: true,
  /** HANAMII API が返す HTTP ステータス（DELETE /api/v1/projects/<id>）。 */
  hanamiiStatus: 204,
  /** HANAMII API へ出た要求（順序込み）。**空であることを確かめるのに使う。** */
  hanamiiCalls: [] as string[],
  /** listAllKeys が返すバケットの中身。 */
  keys: [] as string[],
  /** 一覧そのものが失敗する（＝中身を確かめられない）か。 */
  listThrows: false,
  /** この名前のバケットだけ一覧が失敗する（2件目だけ片づかない形を作る）。 */
  listThrowsFor: null as string | null,
  /** createStorageAdapter が失敗する（＝保存場所に接続できない）か。 */
  adapterThrows: false,
  /** deletePermission が失敗するか。 */
  revokeThrows: false,
  /** listPermissions が返す鍵の一覧。 */
  permissions: [] as { id: string; displayName: string }[],
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

// さくらのクラウドの認証情報（保存場所の鍵の発行・片づけに使う）。公開のときの
// issueStorageEnvFor と同じく main が loadCredentials() で読む。
vi.mock('../src/main/cloud/auth', async (importOriginal) => {
  const real = await importOriginal<any>()
  return { ...real, loadCredentials: () => (h.hasCreds ? { token: 'tok', secret: 'sec' } : null) }
})

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
        async issueKey() { h.storageCalls.push('issueKey'); return { accessKey: 'AKIA-X', secretKey: 'S3CRET-X', permissionId: 'perm-tmp' } },
        async listPermissions() {
          h.storageCalls.push('listPermissions')
          return h.permissions
        },
        async dispose() { h.storageCalls.push('dispose') },
      }
    },
  }
})

import { registerHanamiiHandlers } from '../src/main/ipc/hanamii'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'
import { getOps, resetProjectOpsForTests } from '../src/main/projectOps'
import { BUCKET_MONTHLY_YEN, teardownRemainingWarnings } from '../src/shared/cloudCost'

registerHanamiiHandlers({} as any)
const teardown = h.handlers.get('hanamii:teardown')!
const publish = h.handlers.get('hanamii:publish')!

const EVENT = {}
const TOKEN = 'hnm_test'
const PROJECT_ID = 'hnm-proj-1'
const BUCKET = 'koto-data-x'
const PREFIX = 'projects/myapp/'
const CONSENTED_BUCKET = { bucket: BUCKET, prefix: PREFIX, shared: true, consentedAt: '2026-08-14T00:00:00.000Z' }
/** HANAMII の鍵の名前（shared/storageKeys.ts の permissionNameFor('myapp','hanamii')）。 */
const MINE = 'koto-myapp-hanamii'

let projectDir = ''
const realFetch = globalThis.fetch

beforeEach(() => {
  resetProjectOpsForTests()
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-hanamii-teardown-'))
  h.hasCreds = true
  h.hanamiiStatus = 204
  h.hanamiiCalls = []
  h.keys = [`${PREFIX}.koto-keep`]
  h.listThrows = false
  h.listThrowsFor = null
  h.adapterThrows = false
  h.revokeThrows = false
  h.permissions = []
  h.storageCalls = []
  h.deletedKeys = []
  h.deletedBuckets = []
  h.deletedPermissions = []
  // 偽の HANAMII API（実物の HanamiiClient をそのまま動かし、出た要求だけを記録する）。
  globalThis.fetch = (async (input: unknown, init: any) => {
    h.hanamiiCalls.push(`${init?.method ?? 'GET'} ${String(input)}`)
    const status = h.hanamiiStatus
    return { ok: status >= 200 && status < 300, status, async text() { return '' } }
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  fs.rmSync(projectDir, { recursive: true, force: true })
})

/** `.sakura-cloud/env.json`（保存場所は既定で同意済み）を置く。 */
function setupProject(opts: { storage?: boolean; buckets?: any[] } = {}) {
  const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: false })
  spec.persistence = { objectStorage: opts.buckets ?? (opts.storage === false ? [] : [CONSENTED_BUCKET]) } as any
  fs.mkdirSync(path.join(projectDir, '.sakura-cloud'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), JSON.stringify(spec, null, 2), 'utf-8')
}

function readObjectStorage(): any[] {
  const raw = JSON.parse(fs.readFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), 'utf-8'))
  return raw?.persistence?.objectStorage ?? []
}

/** 保存場所を実際に触る要求だけ（接続・dispose を除く）。 */
const touched = () => h.storageCalls.filter(c => c !== 'connect' && c !== 'dispose')

/**
 * このプロジェクトの記録（.sakuraide.json）に、HANAMII の projectId を置く。
 * main は**画面が渡した projectId が、記録が指すものと一致するときだけ**動く（2026-09-30 検分・掟11）ので、
 * 「画面が正しい projectId を渡している」状態をここで作る（一致しない・無いときに断る振る舞いは
 * tests/hanamiiPublishProjectId.test.ts・tests/hanamiiTeardownRecord.test.ts が固定する）。
 */
function recordProjectId(projectId: string = PROJECT_ID) {
  fs.writeFileSync(path.join(projectDir, '.sakuraide.json'), JSON.stringify({ publish: { hanamii: { projectId } } }, null, 2), 'utf-8')
}

const run = () => { recordProjectId(); return teardown(EVENT, PROJECT_ID, TOKEN, projectDir) }

// ── 1. 確認画面の約束を、実物が果たしているか ────────────────────────────────

describe('HANAMII の破棄: 確認画面が約束した「保存場所も消して月額を止める」を実際にやる', () => {
  it('★★ バケット・データ・鍵を実際に片づける（2026-09-25 まで1件も出ていなかった要求）', async () => {
    setupProject()
    h.keys = [`${PREFIX}.koto-keep`, `${PREFIX}a.txt`]
    h.permissions = [{ id: 'perm-hanamii', displayName: MINE }]
    const result = await run()

    expect(result.ok).toBe(true)
    // HANAMII のプロジェクトは消えている
    expect(h.hanamiiCalls).toEqual([`DELETE https://hanamii.jp/api/v1/projects/${PROJECT_ID}`])
    // **保存場所へ要求が出ている**（ここが空だったのが、この検分の指摘そのもの）
    expect(h.deletedKeys).toEqual([`${PREFIX}.koto-keep`, `${PREFIX}a.txt`])
    expect(h.deletedBuckets).toEqual([BUCKET])
    expect(h.deletedPermissions).toEqual(['perm-hanamii'])
  })

  it('★★ 順序: 一覧 → 中身 → バケット → 鍵（先に鍵を消すと中身を消せずに 403 で止まる）', async () => {
    setupProject()
    h.keys = [`${PREFIX}a.txt`]
    h.permissions = [{ id: 'perm-hanamii', displayName: MINE }]
    const result = await run()

    expect(result.ok).toBe(true)
    expect(touched()).toEqual([
      `listAllKeys ${BUCKET}`,
      `deleteKeys ${BUCKET}`,
      `deleteBucket ${BUCKET}`,
      'listPermissions',
      'deletePermission perm-hanamii',
    ])
  })

  it('★★ 片づけた内容を画面へ返す（「破棄しました。」だけで済ませない）', async () => {
    setupProject()
    const result = await run()

    expect(result.ok).toBe(true)
    expect((result.executed ?? []).some((e: string) => e.includes(BUCKET))).toBe(true)
  })
})

// ── 2. いちばん大事な守り（消す前に必ず確かめる） ──────────────────────────────

describe('HANAMII の破棄: 保存場所を消す前に、必ず一覧して確かめる', () => {
  it('★★ 一覧できなかったら、削除の要求を1件も出さずに中止する（「たぶん空」で消さない）', async () => {
    setupProject()
    h.listThrows = true
    const result = await run()

    expect(result.ok).toBe(false)
    expect(result.message).toContain('中身を確認できないため、削除を中止しました')
    expect(touched()).toEqual([`listAllKeys ${BUCKET}`])
    expect(h.deletedKeys).toEqual([])
    expect(h.deletedBuckets).toEqual([])
    expect(h.deletedPermissions).toEqual([])
    // HANAMII のプロジェクトは消えている＝公開の記録は片づけてよい（幽霊を作らない）
    expect(result.appDeleted).toBe(true)
    // 残っているバケット名を黙らない（月額が続く）
    expect(result.remainingBucket).toBe(BUCKET)
  })

  it('★ 保存場所に接続できないときも、削除の要求は1件も出ない', async () => {
    setupProject()
    h.adapterThrows = true
    const result = await run()

    expect(result.ok).toBe(false)
    expect(result.appDeleted).toBe(true)
    expect(h.storageCalls).toEqual([])
    expect(result.message).toContain('削除を中止しました')
  })

  it('★★ さくらのクラウドのAPIキーが未登録なら、片づけていないことを黙らない', async () => {
    setupProject()
    h.hasCreds = false
    const result = await run()

    expect(result.ok).toBe(false)
    expect(result.appDeleted).toBe(true)
    expect(result.remainingBucket).toBe(BUCKET)
    expect(result.message).toContain('月額が続きます')
    expect(h.storageCalls).toEqual([])
  })

  it('★★ env.json が壊れていても例外を外へ出さず、片づけていないことを言う', async () => {
    setupProject()
    fs.writeFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), '{ これは JSON ではない', 'utf-8')
    const result = await run()

    expect(result.ok).toBe(false)
    expect(result.appDeleted).toBe(true)
    expect(result.message).toContain('保存場所は片づけていません')
    expect(h.storageCalls).toEqual([])
  })
})

// ── 3. 何を消してよいかは teardownPlanFor に任せる（ここで条件を書かない） ─────────────

describe('HANAMII の破棄: 消してよい範囲の判断', () => {
  it('★★ ほかのプロジェクトが使っている保存場所は、バケットごと消さない', async () => {
    setupProject()
    h.keys = [`${PREFIX}a.txt`, 'projects/other/data.json']
    const result = await run()

    expect(result.ok).toBe(true)
    expect(h.deletedKeys).toEqual([`${PREFIX}a.txt`])
    expect(h.deletedBuckets).toEqual([]) // ← ここが true になると、他人のデータが道連れで消える
  })

  it('★ 利用者が自分で置いたファイル（projects/ の外）があれば、バケットごと消さない', async () => {
    setupProject()
    h.keys = [`${PREFIX}a.txt`, 'わたしの大事な資料.pdf']
    const result = await run()

    expect(result.ok).toBe(true)
    expect(h.deletedBuckets).toEqual([])
  })

  it('★★ 同意済みの保存場所が2つあれば、2つとも片づける（先頭だけだと月額が黙って続く）', async () => {
    const BUCKET2 = 'koto-data-y'
    setupProject({ buckets: [CONSENTED_BUCKET, { bucket: BUCKET2, prefix: PREFIX, shared: true, consentedAt: '2026-08-14T00:00:00.000Z' }] })
    const result = await run()

    expect(result.ok).toBe(true)
    expect(h.deletedBuckets).toEqual([BUCKET, BUCKET2])
  })
})

// ── 3b. バケットを残した回は、「残った」事実を返す（処理の記録の警告になる・2026-09-30 検分）──────────
// 利用者のファイルがあってバケットごとは消さなかった回は、executed に「保存場所『X』を片づけました — …残します
// （月額の課金は続きます）」の1行が入るだけで、⚠️ が付かなかった。処理の記録（開き直した画面・上部の確認カード）は
// ⚠️・※ で始まる行だけを警告へ移すので、この回は「✅ 削除が終わりました」と出て、月額が続く一文は折りたたみの中に隠れた。
// 共用型は同じ事実を keptBucketName で返し、警告にしている。HANAMII も同じ事実を返し、同じ関数で警告にする。
describe('★★★ HANAMII の破棄: バケットを残した回は、残った事実（keptBucketName）を返し、記録の警告になる', () => {
  it('★★★ 利用者のファイルがあってバケットを残した: keptBucketName が返り、警告が1件（月額が続く）になる', async () => {
    setupProject()
    h.keys = [`${PREFIX}a.txt`, 'わたしの大事な資料.pdf']
    const result = await run()

    expect(result.ok).toBe(true)
    expect(h.deletedBuckets).toEqual([])
    expect(result.keptBucketName).toBe(BUCKET)
    expect(result.keptBucketNames).toEqual([BUCKET])
    // 実物の記録（withProjectLock が書く）: 警告が1件。月額の金額とバケット名が入っている
    const rec = getOps(projectDir).last!
    expect(rec.result!.ok).toBe(true)
    expect(rec.result!.warnings, '月額が続くのに、警告になっていない（折りたたみの中に隠れる）').toHaveLength(1)
    expect(rec.result!.warnings[0]).toContain(`『${BUCKET}』`)
    expect(rec.result!.warnings[0]).toContain(`月額${BUCKET_MONTHLY_YEN}円`)
    // 共用型と同じ関数の文（画面によって言い方が食い違わない）
    expect(rec.result!.warnings).toEqual(teardownRemainingWarnings({ keptBucketName: BUCKET }))
  })

  it('★★ ほかのプロジェクトが使っている保存場所を残した回も、同じ（残れば月額が続く）', async () => {
    setupProject()
    h.keys = [`${PREFIX}a.txt`, 'projects/other/data.json']
    const result = await run()
    expect(result.keptBucketName).toBe(BUCKET)
    expect(getOps(projectDir).last!.result!.warnings).toHaveLength(1)
  })

  it('★★ バケットごと消した回は、残った事実を返さない（警告を出さない）', async () => {
    setupProject()
    h.keys = [`${PREFIX}a.txt`]
    const result = await run()
    expect(h.deletedBuckets).toEqual([BUCKET])
    expect(result.keptBucketName).toBeUndefined()
    expect(result.keptBucketNames).toBeUndefined()
    expect(getOps(projectDir).last!.result!.warnings).toEqual([])
  })

  it('★★ 保存場所を使っていない回も、何も返さない', async () => {
    setupProject({ storage: false })
    const result = await run()
    expect(result.ok).toBe(true)
    expect(result.keptBucketName).toBeUndefined()
    expect(getOps(projectDir).last!.result!.warnings).toEqual([])
  })

  it('★★★ 残した保存場所が2つあれば、両方の名前と、合計の月額を言う（名前が出なかった分の月額が黙って続かない）', async () => {
    const BUCKET2 = 'koto-data-y'
    setupProject({ buckets: [CONSENTED_BUCKET, { bucket: BUCKET2, prefix: PREFIX, shared: true, consentedAt: '2026-08-14T00:00:00.000Z' }] })
    h.keys = [`${PREFIX}a.txt`, 'わたしの大事な資料.pdf']
    const result = await run()

    expect(result.keptBucketNames).toEqual([BUCKET, BUCKET2])
    const warnings = getOps(projectDir).last!.result!.warnings
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`『${BUCKET}』`)
    expect(warnings[0]).toContain(`『${BUCKET2}』`)
    expect(warnings[0]).toContain(`月額${BUCKET_MONTHLY_YEN * 2}円`)
  })

  it('★★ 片づけの途中で止まった回も、それまでに残した保存場所を返す（失敗の文だけで、残した分が消えない）', async () => {
    const BUCKET2 = 'koto-data-y'
    setupProject({ buckets: [CONSENTED_BUCKET, { bucket: BUCKET2, prefix: PREFIX, shared: true, consentedAt: '2026-08-14T00:00:00.000Z' }] })
    h.keys = [`${PREFIX}a.txt`, 'わたしの大事な資料.pdf']
    h.listThrowsFor = BUCKET2 // 2件目だけ一覧できず、中止する
    const result = await run()

    expect(result.ok).toBe(false)
    expect(result.appDeleted).toBe(true)
    expect(result.remainingBuckets).toEqual([BUCKET2])
    expect(result.keptBucketNames, '1件目は片づけたがバケットは残した').toEqual([BUCKET])
    const warnings = getOps(projectDir).last!.result!.warnings
    expect(warnings.some(w => w.includes(`『${BUCKET}』`) && w.includes('月額'))).toBe(true)
  })
})

// ── 4. バケットを消したら、env.json の記録も外す ────────────────────────────────

describe('HANAMII の破棄: env.json の保存場所の記録', () => {
  it('★★ バケットごと消したら、persistence.objectStorage からも外す', async () => {
    setupProject()
    const result = await run()

    expect(result.ok).toBe(true)
    expect(h.deletedBuckets).toEqual([BUCKET])
    // 残すと、次の公開が**消えたバケット宛ての鍵**を渡して「成功」してしまう。
    expect(readObjectStorage()).toEqual([])
  })

  it('★★ バケットを残した（ほかのプロジェクトが使っている）ときは、記録も残す', async () => {
    setupProject()
    h.keys = [`${PREFIX}a.txt`, 'projects/other/data.json']
    const result = await run()

    expect(result.ok).toBe(true)
    expect(readObjectStorage().map((b: any) => b.bucket)).toEqual([BUCKET])
  })
})

// ── 5. 鍵（koto-<名前>-hanamii）の片づけ ────────────────────────────────────

describe('HANAMII の破棄: 保存場所の鍵', () => {
  it('★★ この公開先の鍵を全部無効にする（記録が無くても、名前で見分けて消す）', async () => {
    setupProject()
    h.permissions = [
      { id: 'perm-1', displayName: MINE },
      { id: 'perm-2', displayName: MINE },
    ]
    const result = await run()

    expect(result.ok).toBe(true)
    expect(h.deletedPermissions).toEqual(['perm-1', 'perm-2'])
  })

  it('★★ ほかのプロジェクト・ほかの公開先の鍵には触れない（掟11）', async () => {
    setupProject()
    h.permissions = [
      { id: 'perm-1', displayName: MINE },
      { id: 'perm-shared', displayName: 'koto-myapp' },                  // 共用型 AppRun
      { id: 'perm-dedicated', displayName: 'koto-myapp_apprun-dedicated' }, // 専有型
      { id: 'perm-vercel', displayName: 'koto-myapp_vercel' },           // Vercel
      { id: 'perm-other', displayName: 'koto-other-hanamii' },           // 別プロジェクト
    ]
    const result = await run()

    expect(result.ok).toBe(true)
    expect(h.deletedPermissions).toEqual(['perm-1'])
  })

  it('★ 鍵を消せなかったら黙らない（warnings として結果に出す）', async () => {
    setupProject()
    h.permissions = [{ id: 'perm-1', displayName: MINE }]
    h.revokeThrows = true
    const result = await run()

    expect(result.ok).toBe(true) // 保存場所そのものは片づいている
    expect((result.executed ?? []).some((e: string) => e.includes('鍵を1件、無効にできませんでした'))).toBe(true)
  })
})

// ── 6. 触ってはいけないもの ─────────────────────────────────────────────────

describe('HANAMII の破棄: 保存場所に触らない場合', () => {
  it('★★ HANAMII のプロジェクトを消せなかったら、保存場所へ1件も要求を出さない（まだ動いている）', async () => {
    setupProject()
    h.hanamiiStatus = 500
    const result = await run()

    expect(result.ok).toBe(false)
    expect(result.appDeleted).toBeFalsy()
    expect(h.storageCalls).toEqual([]) // 接続すらしない（先に鍵を消すと 403 で落ちる）
  })

  it('★★ トークンが未登録なら、HANAMII へも保存場所へも1件も要求を出さない', async () => {
    setupProject()
    recordProjectId()
    const result = await teardown(EVENT, PROJECT_ID, '', projectDir)

    expect(result.ok).toBe(false)
    expect(h.hanamiiCalls).toEqual([])
    expect(h.storageCalls).toEqual([])
  })

  it('★ 保存場所を使っていないプロジェクトでは、保存場所へ1件も要求を出さない', async () => {
    setupProject({ storage: false })
    const result = await run()

    expect(result.ok).toBe(true)
    expect(h.storageCalls).toEqual([])
  })

  it('★ projectDir が渡らない呼び出しでは、片づけたふりをしない（何も消さない）', async () => {
    setupProject()
    const result = await teardown(EVENT, PROJECT_ID, TOKEN)

    expect(result.ok).toBe(true)
    expect(result.appDeleted).toBe(true)
    expect(h.storageCalls).toEqual([])
    expect(result.executed).toEqual([])
  })
})

// ── 7. 押し直しが効く（2026-09-25 検分の指摘3）──────────────────────────────
//
// 保存場所だけ片づかなかったとき、main は「もう一度 🗑 を押してください」と案内する。
// ところが2度目の破棄は HANAMII の DELETE が **404（もう無い）** になり、当時はそこで
// `削除に失敗しました（HTTP 404）` を返して**保存場所へは一生進めなかった**
// ＝案内した導線がどこにも無い（📡 一覧はこの行の記録も消していた）。
//
// HANAMII が「そんなプロジェクトは無い」と言っている＝**動いているアプリはもう無い**ので、
// 鍵を消しても 403 で落ちるものは無い。共用型 apply.ts の削除も `status !== 404` で同じ扱い。

describe('HANAMII の破棄: 2度目（プロジェクトはもう無い）でも、保存場所の片づけを続ける', () => {
  it('★★ HANAMII が 404 を返しても、バケット・データ・鍵を片づける（押し直しが効く）', async () => {
    setupProject()
    h.hanamiiStatus = 404
    h.permissions = [{ id: 'perm-hanamii', displayName: MINE }]
    const result = await run()

    expect(result.ok).toBe(true)
    expect(result.appDeleted).toBe(true)
    expect(h.deletedBuckets).toEqual([BUCKET])
    expect(h.deletedPermissions).toEqual(['perm-hanamii'])
  })

  it('★★ 404 以外（500）は「まだ在るかもしれない」＝保存場所へ1件も要求を出さない', async () => {
    setupProject()
    h.hanamiiStatus = 500
    const result = await run()

    expect(result.ok).toBe(false)
    expect(h.storageCalls).toEqual([])
  })

  it('★★ 片づけ残りの案内は、実在する導線だけを指す（押し直し＋コントロールパネル）', async () => {
    setupProject()
    h.hasCreds = false
    const result = await run()

    expect(result.message).toContain('もう一度 🗑 を押す')
    // やり直しても直らないとき（env.json が壊れている等）の逃げ道も必ず添える
    expect(result.message).toContain('コントロールパネル')
  })

  it('★ 保存場所の記録そのものが読めないときは、押し直しを案内しない（やっても同じ）', async () => {
    setupProject()
    fs.writeFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), '{ これは JSON ではない', 'utf-8')
    const result = await run()

    expect(result.message).not.toContain('もう一度 🗑 を押す')
    expect(result.message).toContain('コントロールパネル')
    expect(result.message).toContain('月額が続きます')
  })
})

// ── 8. 片づけ残りは「全部」名指しする（2026-09-25 検分の指摘5）──────────────────
//
// 破棄は同意済みの保存場所を全件片づける。にもかかわらず、残りの案内は `placements[0]`
// ＝**先頭の1件しか名指ししていなかった**。2件目は名前すら出ないまま月額（495円）が続く。

describe('HANAMII の破棄: 残った保存場所は全部名指しする', () => {
  const BUCKET2 = 'koto-data-y'
  const setupTwo = () => setupProject({
    buckets: [CONSENTED_BUCKET, { bucket: BUCKET2, prefix: PREFIX, shared: true, consentedAt: '2026-08-14T00:00:00.000Z' }],
  })

  it('★★ さくらのAPIキーが未登録のとき、残る2件とも名前が出る', async () => {
    setupTwo()
    h.hasCreds = false
    const result = await run()

    expect(result.ok).toBe(false)
    expect(result.message).toContain(BUCKET)
    expect(result.message, '2件目の保存場所の名前が出ていない（黙って月額が続く）').toContain(BUCKET2)
    expect(result.remainingBuckets).toEqual([BUCKET, BUCKET2])
  })

  it('★★ 1件目で止まったときも、手を付けていない2件目を残りとして名指しする', async () => {
    setupTwo()
    h.listThrows = true
    const result = await run()

    expect(result.ok).toBe(false)
    expect(h.deletedBuckets).toEqual([])
    expect(result.message).toContain(BUCKET)
    expect(result.message, '手を付けていない2件目が残りとして出ていない').toContain(BUCKET2)
    expect(result.remainingBuckets).toEqual([BUCKET, BUCKET2])
  })

  it('★★ 片づいた分は残りに数えない（1件目は消えて、残りは2件目だけ）', async () => {
    setupTwo()
    h.listThrowsFor = BUCKET2
    const result = await run()

    expect(result.ok).toBe(false)
    expect(h.deletedBuckets).toEqual([BUCKET])
    expect(result.remainingBuckets).toEqual([BUCKET2])
    // 消えたものを「残っています」と言わない（言うと、消した保存場所を探しに行かせる）
    expect(result.message).toContain(`保存場所『${BUCKET2}』が残っています`)
    expect(result.message).not.toContain(`『${BUCKET}』が残っています`)
  })
})

// ── 9. 公開が途中で止まったら、いま発行した鍵を取り消す（2026-09-25 検分の指摘14）──────
//
// 公開のたびに「バケットへ読み書きできる本物の鍵」を1本発行する。片づけ（cleanUpOldKeysFor＝
// `hanamii:cleanUpKeys`）が走るのは**公開が成功して READY まで確かめられたときだけ**なので、
// 途中で止まった回の鍵は誰も片づけない——ビルドが直らない間に押した回数だけ溜まる
// （実機で5件・src/shared/storageKeys.ts 冒頭）。この守りは専有型・Vercel・共用型（apply.ts）
// には入っていて、**HANAMII だけ無かった**。
//
// ここも**ソースの文字列は読まない**（掟10）。偽の HANAMII と偽の保存場所へ実際に流し、
// **どの要求が・どの順で飛んだか**で固定する。
//
// ⚠️ 取り消してよいのは「いま発行して、**まだどの版にも載っていない**1件」だけ。
//    createProject / redeploy が通ったあとの鍵は、これから立ち上がるコンテナが使う
//    （2026-08-14 の 403 事故）。最後のテストがそれを固定している。

const UPLOAD_URL = 'https://upload.example.test/put'

/** 公開の偽 HANAMII。**どの段で落とすか**を指定して流す（指定しない段は成功）。 */
function setupPublishFetch(fail: { env?: number; hc?: number; deploy?: number; create?: number } = {}) {
  globalThis.fetch = (async (input: unknown, init: any) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    h.hanamiiCalls.push(`${method} ${url}`)
    const res = (status: number, body: unknown) => ({
      ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(body) },
    })
    if (url === 'https://hanamii.jp/api/v1/uploads') return res(200, { upload: { uploadUrl: UPLOAD_URL, id: 'up-1' } })
    if (url === UPLOAD_URL) return res(200, {})
    if (url.endsWith('/uploads/up-1/check')) return res(200, { result: { canDeploy: true, checkId: 'chk-1' } })
    if (url.endsWith('/env')) return res(fail.env ?? 200, {})
    if (url.endsWith('/health-check')) return res(fail.hc ?? 200, {})
    if (url.endsWith('/deploy')) return res(fail.deploy ?? 200, { deployment: { id: 'dep-1' } })
    if (url === 'https://hanamii.jp/api/v1/projects') return res(fail.create ?? 200, { project: { id: 'hnm-new' } })
    return res(404, {})
  }) as unknown as typeof fetch
}

/** 公開できる形のプロジェクト（言語マニフェストあり）＋同意済みの保存場所。 */
function setupPublishProject() {
  setupProject()
  fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'myapp', version: '1.0.0' }), 'utf-8')
}

/** 再公開（既存プロジェクトへ）。env → health-check → deploy の順に進む。 */
const republish = () => { recordProjectId(); return publish(EVENT, projectDir, {
  token: TOKEN, workspaceId: 'ws-1', projectId: PROJECT_ID, name: 'myapp',
  envs: [{ key: 'FOO', value: 'bar', type: 'plain' as const }],
  healthCheck: { enabled: true, path: '/', port: null },
  withStorage: true,
}) }

describe('HANAMII の公開: 途中で止まったら、いま発行した鍵を取り消す', () => {
  it('★★ 環境変数の保存に失敗したら、発行 → 保存を試す → 取り消し の順で流れる', async () => {
    setupPublishProject()
    setupPublishFetch({ env: 500 })
    const r = await republish()

    expect(r.ok).toBe(false)
    expect(r.message).toContain('環境変数の保存に失敗しました')
    // **順番まで見る。** 保存を試す前に取り消していたら、鍵の無い版が公開されてしまう
    expect(touched()).toEqual(['issueKey', 'deletePermission perm-tmp'])
    expect(h.deletedPermissions).toEqual(['perm-tmp'])
    expect(h.hanamiiCalls.some(c => c.startsWith('PATCH'))).toBe(true)
  })

  it('★★ ヘルスチェックの保存に失敗したときも取り消す（版はまだ作られていない）', async () => {
    setupPublishProject()
    setupPublishFetch({ hc: 500 })
    const r = await republish()

    expect(r.ok).toBe(false)
    expect(r.message).toContain('ヘルスチェック設定の保存に失敗しました')
    expect(h.deletedPermissions).toEqual(['perm-tmp'])
    // 版（デプロイ）は作られていない
    expect(h.hanamiiCalls.some(c => c.endsWith('/deploy'))).toBe(false)
  })

  it('★★ 再公開（deploy）が通らなかったときも取り消す', async () => {
    setupPublishProject()
    setupPublishFetch({ deploy: 500 })
    const r = await republish()

    expect(r.ok).toBe(false)
    expect(r.message).toContain('公開に失敗しました')
    expect(touched()).toEqual(['issueKey', 'deletePermission perm-tmp'])
  })

  it('★★ 初回公開（createProject）が通らなかったときも取り消す', async () => {
    setupPublishProject()
    setupPublishFetch({ create: 500 })
    const r = await publish(EVENT, projectDir, {
      token: TOKEN, workspaceId: 'ws-1', name: 'myapp', envs: [], withStorage: true,
    })

    expect(r.ok).toBe(false)
    expect(touched()).toEqual(['issueKey', 'deletePermission perm-tmp'])
  })

  it('★★ 公開が通ったら取り消さない（その鍵で新しい版が動き出す・2026-08-14 の 403 事故）', async () => {
    setupPublishProject()
    setupPublishFetch()
    const r = await republish()

    expect(r.ok).toBe(true)
    expect(h.deletedPermissions, '動き出す版が使う鍵を消している').toEqual([])
    expect(r.storagePermissionId).toBe('perm-tmp')
  })

  it('★ 保存場所を使わない公開では、鍵を発行もしないし取り消しもしない', async () => {
    setupPublishProject()
    setupPublishFetch({ deploy: 500 })
    recordProjectId()
    const r = await publish(EVENT, projectDir, {
      token: TOKEN, workspaceId: 'ws-1', projectId: PROJECT_ID, name: 'myapp', envs: [], withStorage: false,
    })

    expect(r.ok).toBe(false)
    expect(h.storageCalls).toEqual([])
  })
})

// ── 10. 公開が koto-data を差し替えたら、黙らない（指摘13 の HANAMII 経路）────────────
//
// 公開の3経路（Vercel・共用型 AppRun・HANAMII）はどれも `ensureDataLayer` の**戻り値を捨てて**
// 呼び、直前に
//
//     // **既にあれば触らないので、何度呼んでも安全。**
//
// という**嘘のコメント**を置いていた。`ensureDataLayer` は 2026-09-24 から「印
//（`// koto-data-template:`）が付いていて版が古いファイル」を**上書きする**。
// つまり「公開する」を押しただけで利用者の koto-data が差し替わるのに、画面にも 🕘 履歴にも
// 何も出ない。退避（.sakuraide-backup）も通らないので「前の状態に戻す」でも戻せない。
// Vercel と共用型は前の巡回で直り、**HANAMII だけが戻り値を捨てたまま残っていた。**
//
// ここも**ソースの文字列は読まない**（掟10）。偽の HANAMII API へ実際に流し、
// **ファイルが実際にどうなったか**と**結果に何が載ったか**で固定する。

/** 同梱テンプレート（require 版）。setupPublishProject の package.json は type 指定なし＝cjs。 */
const TEMPLATE_CJS = fs.readFileSync(path.join(process.cwd(), 'templates', 'koto-data.cjs'), 'utf-8')
const DATA_LAYER_FILE = 'koto-data.cjs'

/** 古い版の koto-data.cjs（Koto が置いた印はあるが、版が古い）を置く。 */
function placeOldDataLayer(): string {
  const old = TEMPLATE_CJS.replace(/^\/\/ koto-data-template: .*$/m, '// koto-data-template: 2026-01-01.0')
    + '\n// 古い版の目印（差し替えられたら消える）\n'
  fs.writeFileSync(path.join(projectDir, DATA_LAYER_FILE), old, 'utf-8')
  return old
}

const dataLayerText = (): string | null => {
  const f = path.join(projectDir, DATA_LAYER_FILE)
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : null
}

/** 保存場所を使わない公開（鍵まわりには入らない＝ここで見たいのは koto-data だけ）。 */
const publishPlain = () => { recordProjectId(); return publish(EVENT, projectDir, {
  token: TOKEN, workspaceId: 'ws-1', projectId: PROJECT_ID, name: 'myapp', envs: [], withStorage: false,
}) }

describe('HANAMII の公開: koto-data を差し替えたら、黙らない（指摘13）', () => {
  it('★★★ 古い版を差し替えたら、公開の結果（executed）に1行が載る', async () => {
    setupPublishProject()
    const old = placeOldDataLayer()
    setupPublishFetch()
    const r = await publishPlain()

    expect(r.ok).toBe(true)
    // 実際に差し替わっている（＝黙って書き換える操作が起きている）
    expect(dataLayerText()).toBe(TEMPLATE_CJS)
    expect(dataLayerText()).not.toBe(old)
    // **その事実が利用者に届く**（画面は executed をそのまま並べる）
    const executed = (r.executed ?? []).join('\n')
    expect(executed, '差し替えたのに黙っている（指摘13 の HANAMII 経路が残っている）').toContain('差し替えました')
    expect(executed).toContain(DATA_LAYER_FILE)
  })

  it('★★★ 差し替えは、ZIP を送る前に済んでいる（古い版を公開物に入れない）', async () => {
    setupPublishProject()
    placeOldDataLayer()
    setupPublishFetch()
    // アップロードの瞬間に、手元の koto-data がどうなっていたかを覗く
    let atUpload: string | null | undefined
    const inner = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init: any) => {
      if (String(input) === UPLOAD_URL) atUpload = dataLayerText()
      return (inner as any)(input, init)
    }) as unknown as typeof fetch

    await publishPlain()
    expect(atUpload, 'ZIP を送る時点でまだ古い版だった').toBe(TEMPLATE_CJS)
  })

  it('★★ 公開が途中で止まっても、差し替えたことは黙らない（deploy が通らなかった回）', async () => {
    setupPublishProject()
    const old = placeOldDataLayer()
    setupPublishFetch({ deploy: 500 })
    const r = await publishPlain()

    expect(r.ok).toBe(false)
    expect(dataLayerText()).toBe(TEMPLATE_CJS)
    expect(dataLayerText()).not.toBe(old)
    expect(String(r.message), '差し替えたのに黙っている').toContain('差し替えました')
    expect(String(r.message)).toContain(DATA_LAYER_FILE)
    // 失敗の理由も落とさない（差し替えの1行で上書きしない）
    expect(String(r.message)).toContain('公開に失敗しました')
  })

  it('★★ HANAMII が受け付けずに止まった回も、差し替えたことは黙らない', async () => {
    setupPublishProject()
    placeOldDataLayer()
    // 言語マニフェストも index.html も無い形へ倒す（ZIP を送る前に止まる道）
    fs.rmSync(path.join(projectDir, 'package.json'))
    setupPublishFetch()
    const r = await publishPlain()

    expect(r.ok).toBe(false)
    expect(String(r.message)).toContain('HANAMII で公開できる形になっていません')
    expect(String(r.message), '差し替えたのに黙っている').toContain('差し替えました')
  })

  it('★ 差し替えていない回は、余計なお知らせを出さない', async () => {
    setupPublishProject()
    fs.writeFileSync(path.join(projectDir, DATA_LAYER_FILE), TEMPLATE_CJS, 'utf-8')   // 既に新しい版
    setupPublishFetch()
    const r = await publishPlain()

    expect(r.ok).toBe(true)
    expect((r.executed ?? []).join('\n')).not.toContain('差し替えました')
  })

  // ★ ここを踏み外すと、データベース版に差し替えた利用者の仕事を消す
  it('★ Koto が置いた印の無いファイルは、触らない', async () => {
    setupPublishProject()
    const mine = "// 自分で作り直した版\nmodule.exports = { list: async () => [], save: async () => ({}) }\n"
    fs.writeFileSync(path.join(projectDir, DATA_LAYER_FILE), mine, 'utf-8')
    setupPublishFetch()
    const r = await publishPlain()

    expect(r.ok).toBe(true)
    expect(dataLayerText()).toBe(mine)
    expect((r.executed ?? []).join('\n')).not.toContain('差し替えました')
  })
})
