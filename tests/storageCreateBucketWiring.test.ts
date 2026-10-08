import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import os from 'node:os'
import { join } from 'path'

// ── なぜこのテストが要るか（2026-09-25 検分の指摘23）──────────────────────
//
// 「作れたと決めつけない」（作成の応答が 409 でも、**一覧に現れるまで信じない**）という
// 歯止めは `storage:prepare` で固めた。ところが**85行下の `storage:createBucket` に
// 文字どおり同じ判定**があり、そちらには振る舞いのテストも構造のテストも1件も無かった
// （`grep -rn 'storage:createBucket' tests/` が 0件）。
// tests/storagePrepareWiring.test.ts の切り出しは `storage:prepare` の本体だけを見るので、
// この経路には一切当たらない——**指摘が挙げた変異（一覧の代わりに自分の名前を入れる）を
// こちらへ当てれば、いまでも全件緑**だった。
//
// しかもここは画面からちゃんと届く経路である
// （src/main/preload.ts → StorageSettings.tsx の「新しい保存場所を作る」）。
// 作れていない名前を「作れました」と返すと、利用者はその名前で保存場所を用意したつもりになり、
// **データが書けないまま公開する**。お金と破壊の歯止めは**振る舞いで固定する**（掟10）。
//
// ここはソースの文字列を読まない。**偽の ObjectStorageClient**（作成は 409 を返し、
// 一覧には現れない）へ実際に流し、**出た要求の一覧と順序**と返り値で固定する。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  /** loadCredentials が返す値（実キーは使わない・掟4）。 */
  creds: { token: 'TEST-TOKEN', secret: 'TEST-SECRET' } as null | { token: string; secret: string },
  /** `listBuckets` が返す名前（＝**実在している**保存場所）。 */
  existingBuckets: [] as string[],
  /** `createBucket` の応答（既定は 409＝「もうある」と読み違えやすい形）。 */
  createStatus: 409,
  /** さくらへ出した要求の順番。 */
  calls: [] as string[],
  /** 作成を頼んだバケット名。 */
  created: [] as string[],
  /** サイトが動いていない状態から始めるか。 */
  siteReady: true,
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {} },
  dialog: {},
}))

vi.mock('../src/main/cloud/auth', async (importOriginal) => {
  const real = await importOriginal<any>()
  return { ...real, loadCredentials: () => h.creds }
})

// 偽のオブジェクトストレージ。**何を頼まれ、何を返したか**だけを持つ（storagePrepareWiring と同じ形）。
vi.mock('../src/main/cloud/objectStorage', async (importOriginal) => {
  const real = await importOriginal<any>()
  class FakeObjectStorageClient {
    constructor(_opts: any) { /* 実際の通信はしない */ }
    async pickSite() { h.calls.push('pickSite'); return { id: 'isk01', display_name: '石狩第1サイト', s3_endpoint: 's3.isk01.sakurastorage.jp', region: 'jp-north-1' } }
    async isSiteReady() { h.calls.push('isSiteReady'); return h.siteReady }
    async startSite() { h.calls.push('startSite') }
    async createBucket(_siteId: string, bucket: string) {
      h.calls.push('createBucket')
      h.created.push(bucket)
      return { status: h.createStatus, text: h.createStatus === 409 ? 'bucket already exists' : '' }
    }
    async listBuckets() { h.calls.push('listBuckets'); return h.existingBuckets.map(name => ({ name })) }
  }
  return { ...real, ObjectStorageClient: FakeObjectStorageClient }
})

import { registerCloudHandlers } from '../src/main/ipc/cloud'

const cloud = readFileSync(join(__dirname, '..', 'src/main/ipc/cloud.ts'), 'utf-8')

/** 文字列の位置。**-1（＝無い）は必ずここで落とす**（比較へ渡すと常に真になる）。 */
function at(body: string, needle: string, why: string): number {
  const i = body.indexOf(needle)
  expect(i, why).toBeGreaterThan(-1)
  return i
}

/** `storage:createBucket` の処理の本体だけを切り出す（次の ipcMain.handle の手前まで）。 */
function createBucketHandler(): string {
  const start = at(cloud, "ipcMain.handle('storage:createBucket'", 'storage:createBucket の処理が見つからない')
  const next = cloud.indexOf('ipcMain.handle(', start + 1)
  return next < 0 ? cloud.slice(start) : cloud.slice(start, next)
}

registerCloudHandlers({} as any)
const createBucket = h.handlers.get('storage:createBucket')!

const BUCKET = 'koto-data-test'

beforeEach(() => {
  h.creds = { token: 'TEST-TOKEN', secret: 'TEST-SECRET' }
  h.existingBuckets = []
  h.createStatus = 409
  h.calls = []
  h.created = []
  h.siteReady = true
})
afterEach(() => { h.calls = [] })

describe('新しい保存場所を作る（偽のさくらへ実際に流す）', () => {
  it('★★★ 作成が409で一覧にも現れなければ、作れたことにしない', async () => {
    h.createStatus = 409
    h.existingBuckets = []   // 消した直後で名前が解放されていない＝**作られていない**

    const r = await createBucket({}, BUCKET)

    expect(r.ok, '作れていないのに「作れました」と返している').toBe(false)
    expect(String(r.message ?? '')).toContain('一覧に現れません')
    // 作成のあとに一覧を引いている（順序そのものを固定する）
    expect(h.calls.indexOf('listBuckets')).toBeGreaterThan(h.calls.indexOf('createBucket'))
  })

  it('★★★ 一覧に現れて初めて、作れたことにする', async () => {
    h.createStatus = 200
    h.existingBuckets = [BUCKET]

    const r = await createBucket({}, BUCKET)

    expect(r.ok).toBe(true)
    expect(r.bucket).toBe(BUCKET)
    expect(h.created).toEqual([BUCKET])
    expect(h.calls).toContain('listBuckets')
  })

  it('★★★ 200 で返ってきても、一覧に無ければ作れたことにしない（応答を信じない）', async () => {
    // 「作成の応答が成功なら作れている」と読み替えた瞬間に歯止めが外れる。
    h.createStatus = 200
    h.existingBuckets = ['koto-data-other']   // 別の名前しか無い

    const r = await createBucket({}, BUCKET)

    expect(r.ok).toBe(false)
    expect(String(r.message ?? '')).toContain('一覧に現れません')
  })

  it('★★ 409 でも、その名前が実在していれば作れたことにする（既にある保存場所を使える）', async () => {
    h.createStatus = 409
    h.existingBuckets = [BUCKET]

    const r = await createBucket({}, BUCKET)

    expect(r.ok).toBe(true)
    expect(r.bucket).toBe(BUCKET)
  })

  it('★★ 名前が使えないときは、課金の前に断る（作りに行かない）', async () => {
    const r = await createBucket({}, 'A_Bad_Name')

    expect(r.ok).toBe(false)
    expect(h.created).toEqual([])
    expect(h.calls, 'さくらへ1件も要求を出していないこと').toEqual([])
  })

  it('★★ APIキーが未登録なら、何も作らない', async () => {
    h.creds = null

    const r = await createBucket({}, BUCKET)

    expect(r.ok).toBe(false)
    expect(h.calls).toEqual([])
  })

  it('★ サイトが動いていなければ、作る前に起こす', async () => {
    h.siteReady = false
    h.createStatus = 200
    h.existingBuckets = [BUCKET]

    const r = await createBucket({}, BUCKET)

    expect(r.ok).toBe(true)
    expect(h.calls.indexOf('startSite')).toBeGreaterThan(-1)
    expect(h.calls.indexOf('startSite')).toBeLessThan(h.calls.indexOf('createBucket'))
  })

  it('★ 途中で落ちても、落ちたことを黙って成功にしない', async () => {
    // 認証情報はあるが、名前が空（＝`isValidBucketName` で弾かれる）。
    const r = await createBucket({}, '')
    expect(r.ok).toBe(false)
    expect(String(r.message ?? '')).not.toBe('')
  })
})

// ── 形（切り出す場所を prepare と対にする）────────────────────────────────
// 振る舞いのテストが本体なので、ここは「同じ守りが同じ形で書かれているか」だけを見る。
describe('新しい保存場所を作る処理の形', () => {
  it('★ 実在の確認（listBuckets）が、作成のあとにある', () => {
    const body = createBucketHandler()
    const cb = at(body, 'createBucket(', '作成の呼び出しが無い')
    const lb = at(body, 'listBuckets(', 'バケットの実在確認（listBuckets）が無い')
    expect(lb).toBeGreaterThan(cb)
  })

  it('★ 実在を確かめてからでないと ok:true を返さない', () => {
    const body = createBucketHandler()
    const lb = at(body, 'listBuckets(', 'バケットの実在確認（listBuckets）が無い')
    const ok = at(body, 'return { ok: true, bucket }', '成功の返り値が無い')
    expect(lb).toBeLessThan(ok)
  })
})
