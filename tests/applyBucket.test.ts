import { describe, it, expect } from 'vitest'
import { applyPlan, orderForApply, type StorageClientLike, type CloudClientLike } from '../src/main/cloud/apply'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'
import { emptyState, type EnvState } from '../src/main/cloud/state'
import type { Plan } from '../src/main/cloud/planner'

// 2026-08-13。永続データ（S-1）の実行層。**ここは実際にデータを消す経路**なので、
// 偽のストレージを注入して「何が消えたか」を確かめる。
//
// 今日、設計の穴を2つ Ryosuke に指摘されている:
//   ① 最後のプロジェクトを消してもバケットが残り、課金が続く
//   ② 利用者が自分で置いたデータを巻き込んで消す
// 判断そのものは shared/objectStorage.ts で固定済みだが、**apply がその判断を
// 正しく使っているか**は別の話なので、ここで確かめる（掟10「一元化したことと、
// 全経路が実際にそこを通っていることは別」）。

/** 何をされたかを記録する偽のストレージ。 */
function fakeStorage(keys: string[], opts: { siteReady?: boolean } = {}) {
  const calls = {
    ensured: [] as string[], markers: [] as string[], deletedKeys: [] as string[],
    deletedBuckets: [] as string[], listed: 0, issued: 0, deletedPermissions: [] as string[],
  }
  const client: StorageClientLike = {
    async isSiteReady() { return opts.siteReady ?? true },
    async ensureBucket(b) { calls.ensured.push(b) },
    async listAllKeys() { calls.listed++; return keys },
    async putMarker(_b, k) { calls.markers.push(k) },
    async deleteKeys(_b, ks) { calls.deletedKeys.push(...ks) },
    async deleteBucket(b) { calls.deletedBuckets.push(b) },
    async issueKey() { calls.issued++; return { accessKey: 'AKIANEW', secretKey: 'SECRETNEW', permissionId: 'perm-new' } },
    async deletePermission(id) { calls.deletedPermissions.push(id) },
    siteInfo() { return { s3Endpoint: 's3.isk01.sakurastorage.jp', region: 'jp-north-1' } },
  }
  return { client, calls }
}

const noCloud: CloudClientLike = {
  dryRun: false,
  async ensureUser() { return { ok: true } },
  async listApps() { return { ok: true, data: [] } },
  async createApp() { return { ok: true } },
  async patchApp() { return { ok: true } },
  async deleteApp() { return { ok: true } },
}

const BUCKET = 'koto-data-x'
const PREFIX = 'projects/myapp/'

function specWith(shared: boolean): EnvSpec {
  const s = defaultSpec({ name: 'myapp', hasDockerfile: false })
  // consentedAt が無いバケットは「同意していない」として無視される（2026-08-14）。
  // ここは同意済みの状態を再現する
  s.persistence = { objectStorage: [{ bucket: BUCKET, prefix: PREFIX, shared, consentedAt: '2026-08-14T00:00:00.000Z' }] }
  return s
}

function planOf(type: 'create' | 'delete'): Plan {
  return {
    actions: [{ type, kind: 'bucket', name: BUCKET, stateful: true, description: `保存場所『${BUCKET}』を${type === 'create' ? '用意' : '削除'}` } as any],
    hasDestructive: type === 'delete',
    hasStatefulDelete: type === 'delete',
  } as Plan
}

describe('保存場所を用意する', () => {
  it('バケットを作り、目印を置く', async () => {
    const { client, calls } = fakeStorage([])
    const r = await applyPlan({ plan: planOf('create'), spec: specWith(true), state: emptyState('myapp', 'sakura-apprun'), client: noCloud, storage: client, confirmed: true })
    expect(r.ok).toBe(true)
    expect(calls.ensured).toEqual([BUCKET])
    // 目印が無いと「空のプロジェクト」が一覧に出ず、他の破棄で巻き込まれる
    expect(calls.markers).toEqual(['projects/myapp/.koto-keep'])
    expect(r.state.resources.find(x => x.kind === 'bucket')?.prefix).toBe(PREFIX)
  })

  // 利用開始は月額課金の始まり。apply が勝手に始めてはいけない
  it('サイトの利用が始まっていなければ、何もせず知らせる', async () => {
    const { client, calls } = fakeStorage([], { siteReady: false })
    const r = await applyPlan({ plan: planOf('create'), spec: specWith(true), state: emptyState('myapp', 'sakura-apprun'), client: noCloud, storage: client, confirmed: true })
    expect(calls.ensured).toEqual([])
    expect(r.skipped.join()).toContain('費用')
  })

  it('保存場所の操作が渡されていなければ、黙って成功にしない', async () => {
    const r = await applyPlan({ plan: planOf('create'), spec: specWith(true), state: emptyState('myapp', 'sakura-apprun'), client: noCloud, confirmed: true })
    expect(r.skipped.length).toBe(1)
    expect(r.executed).toEqual([])
  })
})

describe('保存場所を破棄する（★実際にデータが消える経路）', () => {
  const MINE = ['projects/myapp/.koto-keep', 'projects/myapp/data/posts.json']

  it('自分のデータだけを消し、最後の1つならバケットも消す', async () => {
    const { client, calls } = fakeStorage(MINE)
    const r = await applyPlan({ plan: planOf('delete'), spec: specWith(true), state: emptyState('myapp', 'sakura-apprun'), client: noCloud, storage: client, confirmed: true })
    expect(r.ok).toBe(true)
    expect(calls.deletedKeys.sort()).toEqual(MINE.sort())
    expect(calls.deletedBuckets).toEqual([BUCKET])
  })

  it('ほかのプロジェクトが使っていれば、バケットは消さない', async () => {
    const { client, calls } = fakeStorage([...MINE, 'projects/other/.koto-keep'])
    await applyPlan({ plan: planOf('delete'), spec: specWith(true), state: emptyState('myapp', 'sakura-apprun'), client: noCloud, storage: client, confirmed: true })
    expect(calls.deletedBuckets).toEqual([])
    expect(calls.deletedKeys).toEqual(MINE)
  })

  // ★ Ryosuke 指摘。利用者が自分で置いたファイルを巻き込まない
  it('利用者のファイルがあれば、バケットは消さない', async () => {
    const { client, calls } = fakeStorage([...MINE, 'わたしの資料.pdf'])
    const r = await applyPlan({ plan: planOf('delete'), spec: specWith(true), state: emptyState('myapp', 'sakura-apprun'), client: noCloud, storage: client, confirmed: true })
    expect(calls.deletedBuckets).toEqual([])
    // 利用者のファイルには手を付けない
    expect(calls.deletedKeys).not.toContain('わたしの資料.pdf')
    expect(r.executed.join()).toContain('Koto が作ったのではない')
  })

  // 「たぶん空」で消すのがいちばん危ない
  it('中身を確認できなければ、削除を中止する', async () => {
    const { client, calls } = fakeStorage([])
    client.listAllKeys = async () => { throw new Error('通信できません') }
    const r = await applyPlan({ plan: planOf('delete'), spec: specWith(true), state: emptyState('myapp', 'sakura-apprun'), client: noCloud, storage: client, confirmed: true })
    expect(r.ok).toBe(false)
    expect(calls.deletedBuckets).toEqual([])
    expect(calls.deletedKeys).toEqual([])
    expect(r.message).toContain('中止')
  })

  it('必ず一覧してから消す', async () => {
    const { client, calls } = fakeStorage(MINE)
    await applyPlan({ plan: planOf('delete'), spec: specWith(true), state: emptyState('myapp', 'sakura-apprun'), client: noCloud, storage: client, confirmed: true })
    expect(calls.listed).toBe(1)
  })

  // 確認していない破棄は実行されてはならない（既存の安全規約）
  it('確認していなければ何もしない', async () => {
    const { client, calls } = fakeStorage(MINE)
    const r = await applyPlan({ plan: planOf('delete'), spec: specWith(true), state: emptyState('myapp', 'sakura-apprun'), client: noCloud, storage: client, confirmed: false })
    expect(r.ok).toBe(false)
    expect(calls.listed).toBe(0)
    expect(calls.deletedKeys).toEqual([])
  })

  it('専用バケットは、自分のものだけならバケットごと消す', async () => {
    const { client, calls } = fakeStorage(MINE)
    await applyPlan({ plan: planOf('delete'), spec: specWith(false), state: emptyState('myapp', 'sakura-apprun'), client: noCloud, storage: client, confirmed: true })
    expect(calls.deletedBuckets).toEqual([BUCKET])
  })
})

describe('公開のたびに鍵を発行して渡す', () => {
  function deployPlan(): Plan {
    return {
      actions: [{ type: 'create', kind: 'apprun-app', name: 'myapp', stateful: false, description: 'アプリを作成' } as any],
      hasDestructive: false, hasStatefulDelete: false,
    } as Plan
  }
  function imageSpec(): EnvSpec {
    const s = specWith(true)
    s.service.source = { type: 'image', image: 'example/img:latest' } as any
    return s
  }

  it('デプロイ本文に、保存場所の設定とシークレットを載せる', async () => {
    const { client, calls } = fakeStorage([])
    let sentBody: any = null
    const cloud: CloudClientLike = { ...noCloud, async createApp(b) { sentBody = b; return { ok: true, dryRun: false } } }
    const r = await applyPlan({ plan: deployPlan(), spec: imageSpec(), state: emptyState('myapp', 'sakura-apprun'), client: cloud, storage: client, confirmed: true })
    expect(r.ok).toBe(true)
    expect(calls.issued).toBe(1)
    const env: any[] = sentBody.components[0].env
    const names = env.map(e => e.key)
    expect(names).toContain('KOTO_STORAGE_BUCKET')
    expect(names).toContain('KOTO_STORAGE_ACCESS_KEY')
    expect(names).toContain('KOTO_STORAGE_SECRET_KEY')
    expect(env.find(e => e.key === 'KOTO_STORAGE_SECRET_KEY').value).toBe('SECRETNEW')
  })

  // シークレットは発行時にしか読めず、控える必要も無い。控えると漏れる口が増える
  it('シークレットを state に残さない', async () => {
    const { client } = fakeStorage([])
    const cloud: CloudClientLike = { ...noCloud, async createApp() { return { ok: true, dryRun: false } } }
    const r = await applyPlan({ plan: deployPlan(), spec: imageSpec(), state: emptyState('myapp', 'sakura-apprun'), client: cloud, storage: client, confirmed: true })
    expect(JSON.stringify(r.state)).not.toContain('SECRETNEW')
    expect(r.state.meta?.storagePermissionId).toBe('perm-new')
  })

  // 先に消すと、デプロイに失敗したとき古い版も動かなくなる
  it('古い鍵は、新しい公開が成功してから無効にする', async () => {
    const { client, calls } = fakeStorage([])
    const state: EnvState = { ...emptyState('myapp', 'sakura-apprun'), meta: { storagePermissionId: 'perm-old' } }
    const cloud: CloudClientLike = { ...noCloud, async createApp() { return { ok: true, dryRun: false } } }
    await applyPlan({ plan: deployPlan(), spec: imageSpec(), state, client: cloud, storage: client, confirmed: true })
    expect(calls.deletedPermissions).toEqual(['perm-old'])
  })

  it('公開に失敗したら、古い鍵は消さない', async () => {
    const { client, calls } = fakeStorage([])
    const state: EnvState = { ...emptyState('myapp', 'sakura-apprun'), meta: { storagePermissionId: 'perm-old' } }
    const cloud: CloudClientLike = { ...noCloud, async createApp() { return { ok: false, dryRun: false, status: 500 } } }
    const r = await applyPlan({ plan: deployPlan(), spec: imageSpec(), state, client: cloud, storage: client, confirmed: true })
    expect(r.ok).toBe(false)
    expect(calls.deletedPermissions).toEqual([])
  })

  // 鍵の発行は権限を1つ作る操作。アプリを配らない計画で発行しても、
  // 誰にも渡らないまま権限だけが増える
  it('アプリを配らない計画では鍵を発行しない', async () => {
    const { client, calls } = fakeStorage([])
    await applyPlan({ plan: planOf('create'), spec: imageSpec(), state: emptyState('myapp', 'sakura-apprun'), client: noCloud, storage: client, confirmed: true })
    expect(calls.ensured).toEqual([BUCKET])
    expect(calls.issued).toBe(0)
  })

  it('永続データを使わないプロジェクトでは鍵を発行しない', async () => {
    const { client, calls } = fakeStorage([])
    const s = imageSpec()
    s.persistence = { objectStorage: [] }
    const cloud: CloudClientLike = { ...noCloud, async createApp() { return { ok: true, dryRun: false } } }
    await applyPlan({ plan: deployPlan(), spec: s, state: emptyState('myapp', 'sakura-apprun'), client: cloud, storage: client, confirmed: true })
    expect(calls.issued).toBe(0)
  })
})

// ── 費用の同意（2026-08-14）─────────────────────────────────────────
// planner が同意していないバケットを要求しないのが第一の砦。apply 側でも
// 「同意の無い定義に鍵を発行しない」を守る（二重の守り。掟10）。
describe('同意していない保存場所には鍵を発行しない', () => {
  const appPlan: Plan = {
    actions: [{ type: 'create', kind: 'apprun-app', name: 'myapp', stateful: false, description: 'アプリを作成' } as any],
    hasDestructive: false,
    hasStatefulDelete: false,
  } as Plan

  it('consentedAt が無ければ、鍵を発行しない（＝環境変数も注入しない）', async () => {
    const { client, calls } = fakeStorage([])
    const spec = defaultSpec({ name: 'myapp', hasDockerfile: false })
    spec.persistence = { objectStorage: [{ bucket: BUCKET, prefix: PREFIX, shared: true }] }
    const r = await applyPlan({ plan: appPlan, spec, state: emptyState('myapp', 'sakura-apprun'), client: noCloud, storage: client, confirmed: true })
    expect(r.ok).toBe(true)
    expect(calls.issued).toBe(0)
  })

  it('consentedAt があれば、公開のたびに鍵を発行する', async () => {
    const { client, calls } = fakeStorage([])
    const r = await applyPlan({ plan: appPlan, spec: specWith(true), state: emptyState('myapp', 'sakura-apprun'), client: noCloud, storage: client, confirmed: true })
    expect(r.ok).toBe(true)
    expect(calls.issued).toBe(1)
  })
})

// ── 再公開（PATCH）でも鍵が渡ること（2026-08-14）──────────────────────
// 実機の data-test は既にアプリが存在するので、次の公開は create ではなく **patch**。
// create だけ確かめて安心すると、**二度目以降の公開でだけ鍵が渡らない**という、
// いちばん見つけにくい形になる。
describe('再公開でも保存場所の鍵を渡す', () => {
  const updatePlan: Plan = {
    actions: [{ type: 'update', kind: 'apprun-app', name: 'myapp', stateful: false, description: 'アプリを再デプロイ' } as any],
    hasDestructive: false,
    hasStatefulDelete: false,
  } as Plan

  it('PATCH の本文にも KOTO_STORAGE_* が載る', async () => {
    const { client } = fakeStorage([])
    let sentBody: any = null
    const cloud: CloudClientLike = {
      ...noCloud,
      async listApps() { return { ok: true, dryRun: false, data: [{ id: 'app-1', name: 'myapp' }] } },
      async patchApp(_id, b) { sentBody = b; return { ok: true, dryRun: false } },
    }
    const state = emptyState('myapp', 'sakura-apprun')
    state.resources.push({ kind: 'apprun-app', id: 'app-1', stateful: false, key: 'apprun-app:myapp' })
    // 再デプロイは image ソースでのみ実行される（dockerfile はビルド後に差し替え済みの想定）
    const spec = specWith(true)
    spec.service.source = { type: 'image', ref: 'example.jp/myapp:latest' } as any
    const r = await applyPlan({ plan: updatePlan, spec, state, client: cloud, storage: client, confirmed: true })
    expect(r.ok).toBe(true)
    const env = sentBody.components[0].env
    const names = env.map((e: any) => e.key)
    expect(names).toContain('KOTO_STORAGE_BUCKET')
    expect(names).toContain('KOTO_STORAGE_ACCESS_KEY')
    expect(names).toContain('KOTO_STORAGE_SECRET_KEY')
    expect(env.find((e: any) => e.key === 'KOTO_STORAGE_SECRET_KEY').value).toBe('SECRETNEW')
    // 置き場所も渡す（共有バケットで隣のプロジェクトに書かないため）
    expect(env.find((e: any) => e.key === 'KOTO_STORAGE_PREFIX').value).toBe(PREFIX)
  })
})

// ── 実行の順番（2026-08-14 実機で 403）─────────────────────────────────
// 初回公開では「アプリ作成」と「バケット作成」が同じプランに並ぶ。
// アプリには保存場所の鍵を環境変数で渡すが、**その鍵はバケットが無いと効かない**。
// 先に鍵を発行してしまい、あとで目印を書くところで AccessDenied になった。
describe('保存場所を先に作ってから、アプリを公開する', () => {
  it('バケットの作成が、アプリの作成より先に並ぶ', () => {
    const actions = [
      { kind: 'apprun-app', type: 'create' },
      { kind: 'registry', type: 'create' },
      { kind: 'bucket', type: 'create' },
    ]
    expect(orderForApply(actions).map(a => a.kind)[0]).toBe('bucket')
  })

  it('削除の順番は変えない（アプリを止めてから保存場所を消す）', () => {
    const actions = [
      { kind: 'apprun-app', type: 'delete' },
      { kind: 'bucket', type: 'delete' },
    ]
    expect(orderForApply(actions).map(a => a.kind)).toEqual(['apprun-app', 'bucket'])
  })

  it('バケットが無いプランの並びは変わらない', () => {
    const actions = [
      { kind: 'registry', type: 'create' },
      { kind: 'image', type: 'create' },
      { kind: 'apprun-app', type: 'create' },
    ]
    expect(orderForApply(actions).map(a => a.kind)).toEqual(['registry', 'image', 'apprun-app'])
  })

  // ★ 本丸。バケットを作ってから鍵を発行しているか
  it('鍵の発行は、バケットを用意したあとに行う', async () => {
    const { client, calls } = fakeStorage([])
    const order: string[] = []
    const spy: typeof client = {
      ...client,
      async ensureBucket(b) { order.push('ensureBucket'); return client.ensureBucket(b) },
      async putMarker(b, k) { order.push('putMarker'); return client.putMarker(b, k) },
      async issueKey(b, n) { order.push('issueKey'); return client.issueKey(b, n) },
    }
    const plan: Plan = {
      actions: [
        { type: 'create', kind: 'apprun-app', name: 'myapp', stateful: false, description: 'アプリを作成' },
        { type: 'create', kind: 'bucket', name: BUCKET, stateful: true, description: `保存場所『${BUCKET}』を用意` },
      ] as any,
      hasDestructive: false,
      hasStatefulDelete: false,
    } as Plan
    const r = await applyPlan({ plan, spec: specWith(true), state: emptyState('myapp', 'sakura-apprun'), client: noCloud, storage: spy, confirmed: true })
    expect(r.ok).toBe(true)
    expect(order.indexOf('ensureBucket')).toBeLessThan(order.indexOf('issueKey'))
    expect(calls.issued).toBe(1)
  })
})
