import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── T-F1・F2・F3・F4・F7（HANAMII）0.6.24 F-5: 本物の hanamii:teardown に、偽の HANAMII・偽の保存場所を流す ──────────────────
// 仕様: docs/v0624-aefi-spec.md の F-4・F-5・T-F1〜F4・F7。「見せていない保存場所への要求が0件」を、呼ばれた要求の一覧（h.storage）で固定する（掟10）。
//   ・HANAMII の破棄は、確認で見せた保存場所（名前と prefix の組。shownPlacements）と一致するものだけを消す
//   ・見せていないもの（確認のあとで足された・名前を挙げられなかった・値の形が違う）は、外へ1本も要求を出さない。ok:false・残りに入る・行と projectId は残る
//     （HANAMII のプロジェクトはそれより前に消えている。残りは publish.hanamii.storageLeftoverBuckets の印に書く＝押し直しの道）
//   ・残りは main が数え直さない。teardownStorageForProject が返す remainingBuckets（止まった1件・後ろの未着手・飛ばした分の順）をそのまま使う
//   ・飛ばした分があるとき、名前での鍵の一括の無効化はしない（押し直しで行う）
// 共用型は tests/sharedShownTeardown.test.ts。純関数は tests/storageSelection.test.ts。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  hasCreds: true,
  /** DELETE /api/v1/projects/<id> の HTTP ステータス（200＝削除済み・404＝もう無い・202＝受け付けただけ）。 */
  status: 200,
  /** HANAMII へ出た要求。 */
  hanamii: [] as string[],
  /** 保存場所へ出た要求（接続・一覧・削除・鍵・dispose。順序込み）。 */
  storage: [] as string[],
  /** 一覧が失敗する保存場所（バケット名）。 */
  listThrowsFor: [] as string[],
  /** listPermissions が返す鍵。 */
  permissions: [] as { id: string; displayName: string }[],
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => '/tmp', getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {} },
  dialog: {},
}))

vi.mock('../src/main/cloud/auth', async (importOriginal) => {
  const real = await importOriginal<any>()
  return { ...real, loadCredentials: () => (h.hasCreds ? { token: 'tok', secret: 'sec' } : null) }
})

// 偽の保存場所。実物の判断（storageTeardown.ts → teardownPlanFor）はそのまま動かす。
vi.mock('../src/main/cloud/storageAdapter', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    createStorageAdapter: async () => {
      h.storage.push('connect')
      return {
        siteInfo: () => ({ s3Endpoint: 's3.isk01.sakurastorage.jp', region: 'jp-north-1' }),
        async isSiteReady() { return true },
        async ensureBucket() {},
        async putMarker() {},
        async listAllKeys(bucket: string) {
          h.storage.push(`listAllKeys ${bucket}`)
          if (h.listThrowsFor.includes(bucket)) throw new Error('一覧を取得できませんでした（テスト）')
          return ['projects/myapp/.koto-keep']
        },
        async deleteKeys(bucket: string) { h.storage.push(`deleteKeys ${bucket}`) },
        async deleteBucket(bucket: string) { h.storage.push(`deleteBucket ${bucket}`) },
        async deletePermission(id: string) { h.storage.push(`deletePermission ${id}`) },
        async issueKey() { return { accessKey: 'AKIA-X', secretKey: 'S3CRET-X', permissionId: 'perm-tmp' } },
        async listPermissions() { h.storage.push('listPermissions'); return h.permissions },
        async dispose() { h.storage.push('dispose') },
      }
    },
  }
})

import { registerHanamiiHandlers } from '../src/main/ipc/hanamii'
import { resetProjectOpsForTests } from '../src/main/projectOps'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'
import { permissionNameFor } from '../src/shared/storageKeys'
import { deleteProjectReply } from './hanamiiTeardownFixtures'
import { isolatedProjectDir } from './isolatedProject'

registerHanamiiHandlers({} as any)
// 画面を通さず本物の main を直接呼ぶ（shownPlacements は各試験が自分で書く）
const teardown = h.handlers.get('hanamii:teardown')!

const EVENT = {}
const P1 = 'hnm-proj-1'
const PREFIX = 'projects/myapp/'
const A = 'koto-data-a'
const B = 'koto-data-b'
const C = 'koto-data-c'
const D = 'koto-data-d'
const pair = (bucket: string, prefix = PREFIX) => ({ bucket, prefix })
const SKIP_CHANGED = (b: string) => `確認のあとで保存場所の記録が変わったため、保存場所『${b}』は削除していません。`
const SKIP_UNNAMED = (b: string) => `確認で保存場所の名前を挙げられなかったため、保存場所『${b}』は削除していません。`

let projectDir = ''
const realFetch = globalThis.fetch
const metaFile = () => path.join(projectDir, '.sakuraide.json')
const readMeta = (): any => JSON.parse(fs.readFileSync(metaFile(), 'utf-8'))

/** 公開済みの記録（HANAMII の projectId・📡 の行）。 */
function writeMeta() {
  fs.writeFileSync(metaFile(), JSON.stringify({
    name: 'myapp',
    publish: {
      hanamii: { projectId: P1, workspaceId: 'ws-1', name: 'myapp' },
      targets: { hanamii: { publishedAt: '2026-09-29T00:00:00.000Z', url: 'https://myapp.example.test' } },
    },
  }, null, 2), 'utf-8')
}

/** env.json（保存場所は同意済み）。 */
function setEnv(buckets: string[]) {
  const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: false })
  spec.persistence = { objectStorage: buckets.map(bucket => ({ bucket, prefix: PREFIX, shared: true, consentedAt: '2026-08-14T00:00:00.000Z' })) } as any
  fs.mkdirSync(path.join(projectDir, '.sakura-cloud'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), JSON.stringify(spec, null, 2), 'utf-8')
}
const envBuckets = (): string[] => JSON.parse(fs.readFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), 'utf-8')).persistence.objectStorage.map((b: any) => b.bucket)

beforeEach(() => {
  resetProjectOpsForTests()
  projectDir = isolatedProjectDir('koto-hanamii-shown-')
  h.hasCreds = true
  h.status = 200
  h.hanamii = []
  h.storage = []
  h.listThrowsFor = []
  h.permissions = []
  globalThis.fetch = (async (input: unknown, init: any) => {
    h.hanamii.push(`${init?.method ?? 'GET'} ${String(input)}`)
    return deleteProjectReply(h.status, P1)
  }) as unknown as typeof fetch
  writeMeta()
})
afterEach(() => { globalThis.fetch = realFetch })

/** shownPlacements を渡さない（undefined）か、渡す。 */
const go = (shownPlacements?: unknown) =>
  teardown(EVENT, projectDir, { token: 'hnm_test' }, { confirmed: true, projectId: P1, ...(shownPlacements === undefined ? {} : { shownPlacements }) })

/** そのバケットへ出た要求（一覧・データ削除・バケット削除）。 */
const touching = (bucket: string) => h.storage.filter(c => c === `listAllKeys ${bucket}` || c === `deleteKeys ${bucket}` || c === `deleteBucket ${bucket}`)
const gone = (bucket: string) => [`listAllKeys ${bucket}`, `deleteKeys ${bucket}`, `deleteBucket ${bucket}`]
const marker = () => readMeta().publish.hanamii.storageLeftoverBuckets
const DELETE_URL = `DELETE https://hanamii.jp/api/v1/projects/${P1}`

describe('T-F1 HANAMII: 確認で見せていない保存場所への要求は0件', () => {
  it('★★★ 確認は A だけ名指しし、そのあとで env.json に B が足された → 要求は A だけ・B は0件・ok:false・残りに B・行と projectId は残り、印に B', async () => {
    setEnv([A, B]) // 確認のあとの記録（B が足されている）
    const r = await go([pair(A)])

    expect(h.hanamii).toEqual([DELETE_URL]) // HANAMII のプロジェクトは消えている
    expect(h.storage).toEqual(expect.arrayContaining(gone(A)))
    expect(touching(B), 'B への要求が出ている（見せていないのに）').toEqual([])
    expect(h.storage.filter(c => c.endsWith(` ${B}`))).toEqual([])
    expect(r.ok).toBe(false)
    expect(r.appDeleted).toBe(true)
    expect(r.remainingBucket).toBe(B)
    expect(r.remainingBuckets).toEqual([B])
    expect(r.skippedBuckets, '見せていなくて飛ばした分を、共用型と同じ印で返す（0.6.24 R1-d）').toEqual([B])
    expect(r.message).toContain(SKIP_CHANGED(B))
    expect(r.message).toContain(`保存場所『${B}』が残っています（消すまで月額が続きます）`)
    expect(r.message).toContain('保存場所の削除だけをやり直します')
    // 押し直しの道: 行も projectId も残り、残っている B が印に書かれる。消した A だけが env.json から外れる
    expect(marker()).toEqual([B])
    expect(readMeta().publish.hanamii.projectId).toBe(P1)
    expect(readMeta().publish.targets.hanamii).toBeDefined()
    expect(envBuckets()).toEqual([B])
  })

  it('対照: 確認が A・B の両方を名指ししていれば、両方ふつうに消える・ok:true・行も印も消える', async () => {
    setEnv([A, B])
    const r = await go([pair(A), pair(B)])
    expect(h.storage).toEqual(expect.arrayContaining([...gone(A), ...gone(B)]))
    expect(r.ok).toBe(true)
    expect(r.remainingBuckets).toBeUndefined()
    expect(r.skippedBuckets).toBeUndefined()
    expect(readMeta().publish.targets.hanamii).toBeUndefined()
    expect(readMeta().publish.hanamii.projectId).toBeNull()
  })

  it('★★ 押し直し: プロジェクトはもう無い（404）。次の確認が B を名指しすれば消え、行・projectId・印が消える', async () => {
    setEnv([A, B])
    expect((await go([pair(A)])).ok).toBe(false)
    h.status = 404
    h.hanamii = []
    h.storage = []
    const again = await go([pair(B)])
    expect(again.ok).toBe(true)
    expect(h.hanamii).toEqual([DELETE_URL])
    expect(h.storage).toEqual(expect.arrayContaining(gone(B)))
    expect(touching(A)).toEqual([])
    const m = readMeta()
    expect(m.publish.targets.hanamii, '全部片づいたのに行が残っている').toBeUndefined()
    expect(m.publish.hanamii.projectId).toBeNull()
    expect(m.publish.hanamii.storageLeftoverBuckets).toBeNull()
  })
})

describe('T-F2 HANAMII: 見せた保存場所が無い・形が違う → 保存場所への要求は0件（接続もしない）', () => {
  // 渡さない・文字列・prefix が無い・null・要素が null・空の配列（確認が名前を挙げられなかった回＝'call'）。どれも「全部見せた」に倒さない（不明を肯定にしない）
  it.each([
    ['shownPlacements を渡さない', undefined],
    ['文字列', A],
    ['prefix が無い要素', [{ bucket: A }]],
    ['null', null],
    ['要素が null', [null]],
    ['空の配列', []],
    ['配列でないオブジェクト', { bucket: A, prefix: PREFIX }],
  ])('★★★ %s → 一覧も削除も接続も鍵の一覧も0件。ok:false・残りに A・行と projectId は残り、印に A', async (_name, shown) => {
    setEnv([A])
    h.permissions = [{ id: 'perm-hanamii', displayName: permissionNameFor('myapp', 'hanamii') }]
    const r = await go(shown)

    expect(h.storage, '保存場所への要求が出ている').toEqual([])
    expect(h.hanamii).toEqual([DELETE_URL]) // HANAMII のプロジェクトは消えている
    expect(r.ok).toBe(false)
    expect(r.appDeleted).toBe(true)
    expect(r.remainingBuckets).toEqual([A])
    expect(r.remainingBucket).toBe(A)
    expect(r.message).toContain(SKIP_UNNAMED(A))
    expect(marker()).toEqual([A])
    expect(readMeta().publish.hanamii.projectId).toBe(P1)
    expect(readMeta().publish.targets.hanamii).toBeDefined()
    expect(envBuckets()).toEqual([A])
  })
})

describe('T-F3 HANAMII: 同じバケットで prefix が違えば飛ばす', () => {
  it('★★★ 見せたのは別の prefix → A への要求0件・ok:false・「確認のあとで…変わった」', async () => {
    setEnv([A])
    const r = await go([pair(A, 'projects/other/')])
    expect(h.storage).toEqual([])
    expect(r.ok).toBe(false)
    expect(r.remainingBuckets).toEqual([A])
    expect(r.message).toContain(SKIP_CHANGED(A))
    expect(marker()).toEqual([A])
  })
})

describe('T-F4 HANAMII: 見せたほうが多い → ふつうに消える', () => {
  it('★★ 確認は A・B を名指ししたが、いまの記録は A だけ → A だけ消す・B への要求0件・ok:true', async () => {
    setEnv([A])
    const r = await go([pair(A), pair(B)])
    expect(h.storage).toEqual(expect.arrayContaining(gone(A)))
    expect(touching(B)).toEqual([])
    expect(r.ok).toBe(true)
    expect(readMeta().publish.targets.hanamii).toBeUndefined()
  })
})

describe('T-F7 HANAMII: 飛ばした分があるとき、鍵は押し直しで片づける', () => {
  const KEY = { id: 'perm-hanamii', displayName: permissionNameFor('myapp', 'hanamii') }

  it('★★★ 名前での鍵の一括の無効化はしない（listPermissions も deletePermission も0件）。対照: 全部見せれば、一括の無効化が走る', async () => {
    setEnv([A, B])
    h.permissions = [KEY]
    const r = await go([pair(A)])
    expect(r.ok).toBe(false)
    expect(h.storage).not.toContain('listPermissions')
    expect(h.storage).not.toContain('deletePermission perm-hanamii')
    // 対照（同じ並び・全部見せる）
    h.storage = []
    setEnv([A, B])
    writeMeta()
    h.permissions = [KEY]
    expect((await go([pair(A), pair(B)])).ok).toBe(true)
    expect(h.storage).toContain('listPermissions')
    expect(h.storage).toContain('deletePermission perm-hanamii')
  })
})

describe('残りの数え方（remainingBuckets）: 止まった1件・その後ろの未着手・飛ばした分の順。重ならない。main は数え直さない', () => {
  it('★★★ A は消え、B の一覧で止まり、C は見せていない・D は未着手 → 残りは B・D・C（A は入らない）。D と C への要求は0件。印も同じ並び', async () => {
    setEnv([A, B, C, D])
    h.listThrowsFor = [B]
    const r = await go([pair(A), pair(B), pair(D)])

    expect(r.ok).toBe(false)
    expect(r.appDeleted).toBe(true)
    expect(r.remainingBucket).toBe(B)
    expect(r.remainingBuckets).toEqual([B, D, C])
    expect(r.skippedBuckets, '飛ばしたのは見せていない C だけ（止まった B と未着手の D は入らない）').toEqual([C])
    expect(touching(A)).toHaveLength(3)
    expect(touching(C)).toEqual([])
    expect(touching(D)).toEqual([])
    expect(r.message).toContain('一覧を取得できませんでした（テスト）')
    expect(r.message).toContain(SKIP_CHANGED(C))
    expect(r.message).toContain(`保存場所『${B}』『${D}』『${C}』が残っています`)
    expect(marker()).toEqual([B, D, C])
    expect(envBuckets()).toEqual([B, C, D]) // 消えた A だけが外れる
  })

  it('★★ 見せたものが全部片づき、見せていない C だけが残る → 残りは C だけ（片づけた分を残りに数えない）', async () => {
    setEnv([A, B, C])
    const r = await go([pair(A), pair(B)])
    expect(r.ok).toBe(false)
    expect(r.remainingBuckets).toEqual([C])
    expect(r.skippedBuckets).toEqual([C])
    expect(touching(C)).toEqual([])
    expect(marker()).toEqual([C])
  })
})

describe('HANAMII が削除を受け付けただけ（202）→ 保存場所には、見せた値があっても触れない（既存の守り・F と重ならない）', () => {
  it('★★ 202 → 保存場所への要求0件・印も書かない。見せた組があっても同じ', async () => {
    setEnv([A])
    h.status = 202
    const r = await go([pair(A)])
    expect(r.ok).toBe(false)
    expect(r.deletionAccepted).toBe(true)
    expect(h.storage).toEqual([])
    expect(readMeta().publish.hanamii.storageLeftoverBuckets).toBeUndefined()
    expect(envBuckets()).toEqual([A])
  })
})
