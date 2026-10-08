import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { join } from 'path'

// ── なぜこのテストが要るか（2026-09-24）────────────────────────────────
// `keepMarkerKey` の**名前を作る純関数**にはテストがあったが、**呼ぶ側**が無かった。
// そのため `putMarker` の呼び出しはリポジトリ全体で1か所（共用型 AppRun の apply）
// しか無く、**③公開の「保存場所を用意する」ボタンの経路では書かれていなかった**。
//
// 目印が無いと、用意しただけでまだ何も保存していないプロジェクトは
// バケットの一覧に現れない。同じバケットを共有する別のプロジェクトを⑥で破棄すると
// 「ほかに使っている人はいない」と判断され、**バケットごと消える**
// （効き目そのものは tests/objectStorage.test.ts の teardownPlanFor で固定してある）。
//
// ⚠️ ファイル全体を grep するだけの形にしない（掟10。過去に同じ弱さで4回すり抜けた）。
// **「保存場所を用意する」処理の中にあること**を確かめる。
//
// ── 2026-09-25 検分でこのファイル自身の穴が見つかった ──────────────────
// 「★ バケットの実在を確かめたあとに置く」は `body.indexOf('listBuckets(')` を
// **-1 で守らずに** `toBeLessThan` へ渡していたため、`listBuckets(` が本体から
// 消えると `-1 < （putMarker の位置）` で**常に真**になり、実在確認ごと消しても緑だった
// （実証: cloud.ts の `const names = (await client.listBuckets(site.id)).map(b => b.name)` を
// `const names: string[] = [placement.bucket]` に変えて6件とも緑）。
// 位置を見るときは**必ず -1 を先に弾く**（`at()`）。
//
// そして、お金と破壊に関わる歯止めは文字列ではなく**振る舞いで固定する**（掟10）。
// 下の「偽のさくらへ実際に流す」は、**偽の ObjectStorageClient**（作成は 409 を返し、
// 一覧には現れない）へ `storage:prepare` を流し、**ok:false になり・env.json が
// 書かれず・目印も置かれない**ことを見る。2026-08-14 に実機で2回外した形そのもの。

/** 偽のさくら側の記録。vi.mock の工場から触るので hoisted で持つ。 */
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
  /** 実際に置いた目印（バケットと鍵）。 */
  markers: [] as { bucket: string; key: string }[],
  /** 目印を置くのに失敗させるか。 */
  markerThrows: false,
  /** 一時キーの後始末（dispose）が呼ばれた回数。 */
  disposed: 0,
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {} },
  dialog: {},
}))

// 認証情報は「登録されているか」だけを差し替える（掟4: 実キーは使わない）。
vi.mock('../src/main/cloud/auth', async (importOriginal) => {
  const real = await importOriginal<any>()
  return { ...real, loadCredentials: () => h.creds }
})

// 偽のオブジェクトストレージ。**何を頼まれ、何を返したか**だけを持つ。
vi.mock('../src/main/cloud/objectStorage', async (importOriginal) => {
  const real = await importOriginal<any>()
  class FakeObjectStorageClient {
    constructor(_opts: any) { /* 実際の通信はしない */ }
    async pickSite() { h.calls.push('pickSite'); return { id: 'isk01', display_name: '石狩第1サイト', s3_endpoint: 's3.isk01.sakurastorage.jp', region: 'jp-north-1' } }
    async isSiteReady() { h.calls.push('isSiteReady'); return true }
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

// 偽の保存アダプタ。目印を置いたか・鍵を片づけたかだけを記録する。
vi.mock('../src/main/cloud/storageAdapter', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    createStorageAdapter: async () => ({
      async putMarker(bucket: string, key: string) {
        h.calls.push('putMarker')
        if (h.markerThrows) throw new Error('目印を置けませんでした（テスト）')
        h.markers.push({ bucket, key })
      },
      async dispose() { h.disposed++ },
    }),
  }
})

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { keepMarkerKey, prefixForProject } from '../src/shared/objectStorage'
import { CLOUD_ENV_FILE } from '../src/main/cloud/specStore'

const cloud = readFileSync(join(__dirname, '..', 'src/main/ipc/cloud.ts'), 'utf-8')

/** 文字列の位置。**-1（＝無い）は必ずここで落とす**（比較へ渡すと常に真になる）。 */
function at(body: string, needle: string, why: string): number {
  const i = body.indexOf(needle)
  expect(i, why).toBeGreaterThan(-1)
  return i
}

/** `storage:prepare` の処理の本体だけを切り出す（次の ipcMain.handle の手前まで）。 */
function prepareHandler(): string {
  const start = at(cloud, "ipcMain.handle('storage:prepare'", 'storage:prepare の処理が見つからない')
  const next = cloud.indexOf('ipcMain.handle(', start + 1)
  return next < 0 ? cloud.slice(start) : cloud.slice(start, next)
}

registerCloudHandlers({} as any)
const prepare = h.handlers.get('storage:prepare')!

const BUCKET = 'koto-data-test'

let projectDir = ''

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-prepare-'))
  h.creds = { token: 'TEST-TOKEN', secret: 'TEST-SECRET' }
  h.existingBuckets = []
  h.createStatus = 409
  h.calls = []
  h.created = []
  h.markers = []
  h.markerThrows = false
  h.disposed = 0
})
afterEach(() => {
  try { fs.rmSync(projectDir, { recursive: true, force: true }) } catch { /* 消せなくてもよい */ }
})

/** `.sakura-cloud/env.json` を読む（無ければ null）。 */
function readEnv(): any | null {
  try { return JSON.parse(fs.readFileSync(path.join(projectDir, '.sakura-cloud', CLOUD_ENV_FILE), 'utf-8')) } catch { return null }
}

/** 記録に残った保存場所（同意済みの印つき）。 */
function recordedBuckets(): string[] {
  return (readEnv()?.persistence?.objectStorage ?? []).map((b: any) => b.bucket)
}

describe('保存場所を用意する（偽のさくらへ実際に流す）', () => {
  it('★★★ 作成が409で一覧にも現れなければ、用意できたことにしない（2026-08-14 の再発防止）', async () => {
    h.createStatus = 409
    h.existingBuckets = [] // 消した直後で名前が解放されていない＝**作られていない**

    const r = await prepare({}, projectDir, { bucket: BUCKET })

    expect(r.ok).toBe(false)
    expect(String(r.message ?? '')).toContain('一覧に現れません')
    // **記録を残さない**（consentedAt が付くと、公開で鍵と環境変数を渡してしまう）
    expect(readEnv()).toBeNull()
    // 存在しないバケットへ書きに行かない
    expect(h.markers).toEqual([])
    expect(h.calls).not.toContain('putMarker')
  })

  it('★★★ 一覧に現れて初めて用意できたことにし、記録に同意の日時を残す', async () => {
    h.createStatus = 200
    h.existingBuckets = [BUCKET]

    const r = await prepare({}, projectDir, { bucket: BUCKET })

    expect(r.ok).toBe(true)
    expect(r.placement?.bucket).toBe(BUCKET)
    expect(recordedBuckets()).toEqual([BUCKET])
    const saved = readEnv().persistence.objectStorage[0]
    expect(String(saved.consentedAt ?? '')).not.toBe('')
    // 実在を確かめてから目印を置く。**出した要求の一覧と順序をそのまま見る**（掟10）。
    // 位置比較（`indexOf(a) < indexOf(b)`）は、片方が消えると -1 で素通りしうる形なので使わない
    // （2026-09-25 検分。同じ形が imageBuildWiring・applyBucket で実際に穴になっていた）。
    expect(h.calls).toEqual(['pickSite', 'isSiteReady', 'createBucket', 'listBuckets', 'putMarker'])
  })

  it('★★★ 目印を実際に置く（名前は keepMarkerKey が作ったものそのもの）', async () => {
    h.createStatus = 200
    h.existingBuckets = [BUCKET]

    const r = await prepare({}, projectDir, { bucket: BUCKET })

    expect(r.ok).toBe(true)
    expect(h.markers).toEqual([{ bucket: BUCKET, key: keepMarkerKey(r.placement.prefix) }])
    // プレフィックスは spec の名前から作る（フォルダ名ではない）
    expect(r.placement.prefix).toBe(prefixForProject(readEnv().name))
    // 目印に使った一時キーは必ず片づける
    expect(h.disposed).toBe(1)
  })

  it('★★ 目印を置けなくても用意そのものは中止しない（課金は既に始まっている）。ただし黙らない', async () => {
    h.createStatus = 200
    h.existingBuckets = [BUCKET]
    h.markerThrows = true

    const r = await prepare({}, projectDir, { bucket: BUCKET })

    expect(r.ok).toBe(true)
    expect(recordedBuckets()).toEqual([BUCKET])
    expect(String(r.markerNote ?? '')).toContain('目印を置けませんでした')
    // 失敗しても一時キーは片づける（finally）
    expect(h.disposed).toBe(1)
  })

  // ── この検査自身に穴があった（2026-09-25 検分・実証済み）──────────────────
  // 前は `'A_Bad_Name'` 1件だけを渡していた。ところが cloud.ts の
  // `if (chosen && !isValidBucketName(chosen))` を `if (false)` に変えても**10件すべて緑**だった。
  // `'A_Bad_Name'` は後段の `validateSpec`（spec.ts の NAME_PATTERN）**でも**弾かれるので、
  // 落ちた門が入れ替わっただけで結果が同じになる。
  //
  // 2つの門は**範囲が違う**:
  //   ・isValidBucketName（objectStorage.ts）… `^[a-z][a-z0-9-]*[a-z0-9]$`・3〜63字・`--` 禁止
  //   ・NAME_PATTERN（spec.ts）             … `^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$`（**先頭数字も `--` も通す**）
  // だから `'koto--data'` と `'9koto-data'` は **prepare 側の門でしか止まらない**。
  // ここを素通りすると `createBucket`（＝課金）まで行く（掟10）。
  const BAD_NAMES: readonly { name: string; why: string }[] = [
    { name: 'A_Bad_Name', why: '大文字と下線（どちらの門でも弾かれる）' },
    { name: 'koto--data', why: 'ハイフン2つ（prepare 側の門だけが弾く）' },
    { name: '9koto-data', why: '数字始まり（prepare 側の門だけが弾く）' },
  ]

  for (const { name, why } of BAD_NAMES) {
    it(`★★ 名前が使えないときは、課金の前に断る（バケットを作りに行かない）: ${name} — ${why}`, async () => {
      const r = await prepare({}, projectDir, { bucket: name })

      expect(r.ok, `${name} を通してしまった`).toBe(false)
      // **どちらの門で断ったか**まで固定する。prepare 側の門を外すと、
      // `koto--data` / `9koto-data` は validateSpec も通り抜けて createBucket（課金）まで行く。
      expect(String(r.message ?? ''), `${name}: prepare 側の門（isValidBucketName）で断っていない`)
        .toContain('英字で始まる小文字の英数字')
      // さくらへは一度も出していない（課金・通信の両方が起きていない）
      expect(h.created, `${name}: バケットを作りに行った`).toEqual([])
      expect(h.calls, `${name}: さくらへ要求を出した`).toEqual([])
      expect(readEnv(), `${name}: 記録を残した`).toBeNull()
    })
  }

  it('★★ APIキーが未登録なら、何も作らない', async () => {
    h.creds = null

    const r = await prepare({}, projectDir, { bucket: BUCKET })

    expect(r.ok).toBe(false)
    expect(h.calls).toEqual([])
    expect(readEnv()).toBeNull()
  })
})

describe('保存場所を用意したら、目印も置く（形）', () => {
  it('★ 「用意する」処理の中で putMarker を呼んでいる', () => {
    expect(prepareHandler()).toContain('putMarker(')
  })

  it('★ 目印の名前は keepMarkerKey から作る（名前を手で組み立てない・掟10）', () => {
    const body = prepareHandler()
    expect(body).toContain('keepMarkerKey(')
    // 手書きの `.koto-keep` が紛れていないこと（ずれた瞬間に守りが効かなくなる）
    expect(body).not.toContain("'.koto-keep'")
  })

  it('★ バケットの実在を確かめたあとに置く（作れていないのに書きに行かない）', () => {
    const body = prepareHandler()
    const lb = at(body, 'listBuckets(', 'バケットの実在確認（listBuckets）が無い')
    const pm = at(body, 'putMarker(', '目印を置く処理（putMarker）が無い')
    expect(lb).toBeLessThan(pm)
  })

  it('★ 目印を置く処理は、実在確認と記録の間にある（区切りで指す）', () => {
    const body = prepareHandler()
    // 「実在を確かめる」から「env.json へ書く」までの区切りの中に putMarker がある
    const check = at(body, '一覧に現れません', 'バケットの実在確認のメッセージが無い')
    const save = at(body, 'fs.writeFileSync(file', 'env.json への書き込みが無い')
    const between = body.slice(check, save)
    expect(between).toContain('putMarker(')
    // 投げっぱなしにしない（置けなくても用意は続ける）
    expect(between).toContain('catch')
    expect(between).toContain('dispose()')
    // 置けなかったことを黙らない（戻り値で画面へ伝える）
    expect(between).toContain('markerNote')
    expect(body).toContain('markerNote')
  })
})
