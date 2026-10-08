import { describe, it, expect } from 'vitest'
import { applyPlan, type StorageClientLike, type CloudClientLike } from '../src/main/cloud/apply'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'
import { emptyState, type EnvState } from '../src/main/cloud/state'
import type { Plan } from '../src/main/cloud/planner'

// ── なぜこのテストが要るか（2026-09-25 検分）──────────────────────────────
//
// 公開のたびに「バケットへ読み書きできる本物の鍵」を1本発行する。片づけ
// （cleanUpOldKeysFor）が走るのは**公開が成功して、アプリの応答まで確かめられたとき
// だけ**なので、途中で止まった回の鍵は誰も片づけない。しかも共用型は早期 return だと
// state.json にも載せないので、⑥の破棄からも辿れない。
//
// **実機で鍵が5件たまったのは、この共用型 AppRun である**（src/shared/storageKeys.ts 冒頭）。
// ところが「途中で止まったら、いま発行した鍵を取り消す」は専有型（apprunDedicated.ts の
// revokeJustIssuedKey）と Vercel にだけ入っていて、事故の起きた共用型に無かった。
//
// ここは**ソースの文字列を読まない**（掟10「お金・破壊の歯止めは振る舞いで固定する」）。
// 偽の client へ実際に流し、**どの要求が・どの順で飛んだか**の一覧で固定する。
//
// ── 取り消してよい範囲（ここを間違えると 2026-08-14 の 403 事故が戻る）──────
// 取り消してよいのは「いま発行して、**まだどの版にも載っていない**1件」だけ。
// create / patch が通ったあとの鍵は、これから立ち上がるコンテナが使うので触らない。
// 古い鍵も、いま動いている版が使っているので触らない。

const BUCKET = 'koto-data-x'
const PREFIX = 'projects/myapp/'
const ISSUED = { accessKey: 'AKIA-NEW', secretKey: 'SECRET-NEW', permissionId: 'perm-new' }

/** 何をされたかを**呼ばれた順に**記録する偽のストレージ。 */
function fakeStorage(calls: string[]) {
  const client: StorageClientLike = {
    async isSiteReady() { return true },
    async ensureBucket(b) { calls.push(`ensureBucket:${b}`) },
    async listAllKeys() { calls.push('listAllKeys'); return [] },
    async putMarker(_b, k) { calls.push(`putMarker:${k}`) },
    async deleteKeys(_b, ks) { calls.push(`deleteKeys:${ks.join(',')}`) },
    async deleteBucket(b) { calls.push(`deleteBucket:${b}`) },
    async issueKey() { calls.push('issueKey'); return ISSUED },
    async deletePermission(id) { calls.push(`deletePermission:${id}`) },
    async listPermissions() { return [] },
    siteInfo() { return { s3Endpoint: 's3.isk01.sakurastorage.jp', region: 'jp-north-1' } },
  }
  return client
}

/** 何も失敗しないクラウド（min_scale は defaultSpec の既定と同じ＝食い違わない）。 */
function fakeCloud(calls: string[], over: Partial<CloudClientLike> = {}): CloudClientLike {
  return {
    dryRun: false,
    async ensureUser() { return { ok: true } },
    async listApps() { return { ok: true, dryRun: false, data: [] } },
    async getApp() { return { ok: true, dryRun: false, data: { min_scale: 0 } } },
    async createApp() { calls.push('createApp'); return { ok: true, dryRun: false, data: { id: 'app-1' } } },
    async patchApp() { calls.push('patchApp'); return { ok: true, dryRun: false } },
    async deleteApp() { calls.push('deleteApp'); return { ok: true, dryRun: false } },
    ...over,
  }
}

/** 保存場所に同意済み＋イメージ型（この経路でだけ create/patch が実行される）の spec。 */
function imageSpec(): EnvSpec {
  const s = defaultSpec({ name: 'myapp', hasDockerfile: false })
  s.persistence = { objectStorage: [{ bucket: BUCKET, prefix: PREFIX, shared: true, consentedAt: '2026-08-14T00:00:00.000Z' }] }
  s.service.source = { type: 'image', image: 'example/img:latest' } as any
  return s
}

const createPlan = (): Plan => ({
  actions: [{ type: 'create', kind: 'apprun-app', name: 'myapp', stateful: false, description: 'アプリを作成' } as any],
  hasDestructive: false, hasStatefulDelete: false,
} as Plan)

const updatePlan = (): Plan => ({
  actions: [{ type: 'update', kind: 'apprun-app', name: 'myapp', stateful: false, description: 'アプリを再デプロイ' } as any],
  hasDestructive: false, hasStatefulDelete: false,
} as Plan)

/** 再デプロイできる state（アプリの ID が記録にある）。古い鍵の ID も持たせる。 */
function stateWithApp(oldKey = 'perm-old'): EnvState {
  const st: EnvState = { ...emptyState('myapp', 'sakura-apprun'), meta: { storagePermissionId: oldKey } }
  st.resources.push({ kind: 'apprun-app', id: 'app-1', stateful: false, key: 'apprun-app:myapp' })
  return st
}

const revoked = (calls: string[]) => calls.filter(c => c.startsWith('deletePermission:'))

// ── 1. 途中で止まったら、いま発行した鍵を取り消す ──────────────────────

describe('共用型 AppRun: 公開が途中で止まったら、いま発行した鍵を取り消す', () => {
  it('★ アプリの作成に失敗したとき、発行 → 作成 → 取り消し の順で流れる', async () => {
    const calls: string[] = []
    const cloud = fakeCloud(calls, {
      async createApp() { calls.push('createApp'); return { ok: false, dryRun: false, status: 500 } },
    })
    const r = await applyPlan({
      plan: createPlan(), spec: imageSpec(), state: emptyState('myapp', 'sakura-apprun'),
      client: cloud, storage: fakeStorage(calls), confirmed: true,
    })
    expect(r.ok).toBe(false)
    // **順番まで見る。** 作成を試す前に取り消していたら、鍵の無い版が公開されてしまう
    expect(calls).toEqual(['issueKey', 'createApp', `deletePermission:${ISSUED.permissionId}`])
  })

  it('★ 再デプロイ（PATCH）に失敗したときも、いま発行した鍵を取り消す', async () => {
    const calls: string[] = []
    const cloud = fakeCloud(calls, {
      async patchApp() { calls.push('patchApp'); return { ok: false, dryRun: false, status: 500 } },
    })
    const r = await applyPlan({
      plan: updatePlan(), spec: imageSpec(), state: stateWithApp(),
      client: cloud, storage: fakeStorage(calls), confirmed: true,
    })
    expect(r.ok).toBe(false)
    expect(calls).toEqual(['issueKey', 'patchApp', `deletePermission:${ISSUED.permissionId}`])
  })

  // ★ 古い鍵は**いま動いている版**が使っている。ここを取り違えると、原因の分からない
  //   403 を1時間以上追う事故（2026-08-14）が戻る
  it('★ 取り消すのは、いま発行した1件だけ（古い鍵には触れない）', async () => {
    const calls: string[] = []
    const cloud = fakeCloud(calls, {
      async createApp() { calls.push('createApp'); return { ok: false, dryRun: false, status: 500 } },
    })
    await applyPlan({
      plan: createPlan(), spec: imageSpec(), state: stateWithApp('perm-old'),
      client: cloud, storage: fakeStorage(calls), confirmed: true,
    })
    expect(revoked(calls)).toEqual([`deletePermission:${ISSUED.permissionId}`])
    expect(calls).not.toContain('deletePermission:perm-old')
  })

  // ★ 早期 return では state.meta に載らない＝**⑥の破棄からも辿れない鍵**になる。
  //   取り消したうえで、記録にも残さない
  it('★ 取り消した鍵を、記録（state.meta）に残さない', async () => {
    const calls: string[] = []
    const cloud = fakeCloud(calls, {
      async createApp() { calls.push('createApp'); return { ok: false, dryRun: false, status: 500 } },
    })
    const r = await applyPlan({
      plan: createPlan(), spec: imageSpec(), state: stateWithApp('perm-old'),
      client: cloud, storage: fakeStorage(calls), confirmed: true,
    })
    expect(r.state.meta?.storagePermissionId).not.toBe(ISSUED.permissionId)
  })

  // ★「起動のしかた」が食い違って止まる道は、**PATCH を一度も呼ばない**。
  //   選び直して押し直すたびに、誰にも渡らない鍵が1本ずつ増えていた
  it('★ 起動のしかたの食い違いで止まったとき（PATCH を呼ばない道）も取り消す', async () => {
    const calls: string[] = []
    const spec = imageSpec()
    spec.service.scale.min = 1
    const cloud = fakeCloud(calls, {
      // さくら側の実物は 0。Koto の設定（1）と食い違う＝decision 未指定なら止めて聞く
      async getApp() { return { ok: true, dryRun: false, data: { min_scale: 0 } } },
    })
    const r = await applyPlan({
      plan: updatePlan(), spec, state: stateWithApp(),
      client: cloud, storage: fakeStorage(calls), confirmed: true,
    })
    expect(r.ok).toBe(false)
    expect(r.needsScaleDecision).toBeTruthy()          // 聞き直す道であることまで固定する
    expect(calls).not.toContain('patchApp')            // 版は作られていない
    expect(revoked(calls)).toEqual([`deletePermission:${ISSUED.permissionId}`])
  })

  // ★ 鍵を発行していない回に deletePermission が飛んだら、それは**他人の鍵**を消している
  it('★ 保存場所を使っていないプロジェクトでは、鍵を1件も取り消さない', async () => {
    const calls: string[] = []
    const spec = imageSpec()
    spec.persistence = { objectStorage: [] }
    const cloud = fakeCloud(calls, {
      async createApp() { calls.push('createApp'); return { ok: false, dryRun: false, status: 500 } },
    })
    const r = await applyPlan({
      plan: createPlan(), spec, state: emptyState('myapp', 'sakura-apprun'),
      client: cloud, storage: fakeStorage(calls), confirmed: true,
    })
    expect(r.ok).toBe(false)
    expect(calls).toEqual(['createApp'])
    expect(revoked(calls)).toEqual([])
  })
})

// ── 2. 版に載った鍵は取り消さない（2026-08-14 の 403 事故と同じ守り）──────

describe('共用型 AppRun: 版に載った鍵は取り消さない', () => {
  it('★ 公開できた回は、いま発行した鍵を取り消さない（記録に残す）', async () => {
    const calls: string[] = []
    const r = await applyPlan({
      plan: createPlan(), spec: imageSpec(), state: stateWithApp(),
      client: fakeCloud(calls), storage: fakeStorage(calls), confirmed: true,
    })
    expect(r.ok).toBe(true)
    expect(revoked(calls)).toEqual([])
    expect(r.state.meta?.storagePermissionId).toBe(ISSUED.permissionId)
  })

  // ★ いちばん危ない形。1つ目のアプリには**この鍵が載って動き出す**ので、
  //   そのあと別の操作で失敗しても取り消してはいけない
  it('★ 1つ目の作成が通ったあとに失敗しても、その鍵は取り消さない（動き出す版が使う）', async () => {
    const calls: string[] = []
    let n = 0
    const cloud = fakeCloud(calls, {
      async createApp() {
        n++
        calls.push(`createApp:${n}`)
        return n === 1 ? { ok: true, dryRun: false, data: { id: 'app-1' } } : { ok: false, dryRun: false, status: 500 }
      },
    })
    const plan: Plan = {
      actions: [
        { type: 'create', kind: 'apprun-app', name: 'myapp', stateful: false, description: 'アプリを作成' },
        { type: 'create', kind: 'apprun-app', name: 'myapp2', stateful: false, description: 'アプリ2を作成' },
      ] as any,
      hasDestructive: false, hasStatefulDelete: false,
    } as Plan
    const r = await applyPlan({
      plan, spec: imageSpec(), state: emptyState('myapp', 'sakura-apprun'),
      client: cloud, storage: fakeStorage(calls), confirmed: true,
    })
    expect(r.ok).toBe(false)
    expect(calls).toEqual(['issueKey', 'createApp:1', 'createApp:2'])
    expect(revoked(calls)).toEqual([])
  })
})
