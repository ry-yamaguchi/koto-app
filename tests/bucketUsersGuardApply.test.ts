import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { applyPlan, type StorageClientLike, type CloudClientLike } from '../src/main/cloud/apply'
import { applyForProject } from '../src/main/cloud/applyForProject'
import { teardownStorage } from '../src/main/cloud/storageTeardown'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'
import { emptyState } from '../src/main/cloud/state'
import type { Plan } from '../src/main/cloud/planner'
import { isolatedProjectDir, workspaceDirOf } from './isolatedProject'

// ── 公開の apply の中の保存場所の削除（apply.ts の bucket delete）も、ほかのプロジェクトの記録を読んでから決める ──────────
// 2026-10-21 の実機の欠陥は、破棄（共用型・HANAMII・専有型）の道で起きた。同じバケットを消す道は、もう1つある:
//   ・公開（ipc/cloud.ts の cloud:apply → applyForProject → applyPlan）で、plan に bucket の delete があるとき（env.json から保存場所を外して公開し直した回）
// バケットを消す呼び出しは cloud/storageTeardown.ts の teardownStorage の1か所だけで、4つの道（上の1つと、teardownStorageForProject 経由の3つ）はすべてそれを通る。
// ここは apply の道と、その入口（applyForProject）を、偽の保存場所に実際に流して固定する。

const BUCKET = 'koto-rc-s1019'
const PREFIX = 'projects/myapp/'
const MINE = [`${PREFIX}.koto-keep`, `${PREFIX}data.json`]

function fakeStorage(keys: string[]) {
  const calls = { deletedKeys: [] as string[], deletedBuckets: [] as string[], disposed: 0 }
  const client: StorageClientLike & { dispose(): Promise<void> } = {
    async isSiteReady() { return true },
    async ensureBucket() {},
    async listAllKeys() { return keys },
    async putMarker() {},
    async deleteKeys(_b, ks) { calls.deletedKeys.push(...ks) },
    async deleteBucket(b) { calls.deletedBuckets.push(b) },
    async issueKey() { return { accessKey: 'AKIA', secretKey: 'S3CRET', permissionId: 'perm-new' } },
    async deletePermission() {},
    async listPermissions() { return [] },
    siteInfo() { return { s3Endpoint: 's3.isk01.sakurastorage.jp', region: 'jp-north-1' } },
    async dispose() { calls.disposed++ },
  }
  return { client, calls }
}

const noCloud: CloudClientLike = {
  dryRun: false,
  async ensureUser() { return { ok: true } },
  async listApps() { return { ok: true, data: [] } },
  async getApp() { return { ok: true, dryRun: false, data: { min_scale: 0 } } },
  async createApp() { return { ok: true } },
  async patchApp() { return { ok: true } },
  async deleteApp() { return { ok: true } },
}

function specWith(shared: boolean): EnvSpec {
  const s = defaultSpec({ name: 'myapp', hasDockerfile: false })
  s.persistence = { objectStorage: [{ bucket: BUCKET, prefix: PREFIX, shared, consentedAt: '2026-08-14T00:00:00.000Z' }] }
  return s
}
const deletePlan = (): Plan => ({
  actions: [{ type: 'delete', kind: 'bucket', name: BUCKET, stateful: true, destructive: true, description: `保存場所『${BUCKET}』を削除` } as any],
  hasDestructive: true,
  hasStatefulDelete: true,
}) as Plan

/**
 * 兄弟のプロジェクト（env.json に BUCKET が同意済み）を同じ親フォルダに置く。`raw` を渡すとそのまま env.json に書く。
 * `published`（既定は true）: 公開の記録（.sakuraide.json の共用型の行）を置く。兄弟が「いま使っている」と数えられるのは、公開の記録がまだあるときだけ。
 */
function sibling(projectDir: string, name: string, raw?: string, published = true) {
  const dir = path.join(workspaceDirOf(projectDir), name)
  fs.mkdirSync(path.join(dir, '.sakura-cloud'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.sakura-cloud', 'env.json'), raw ?? JSON.stringify({
    persistence: { objectStorage: [{ bucket: BUCKET, prefix: `projects/${name}/`, shared: true, consentedAt: '2026-10-19T00:00:00.000Z' }] },
  }))
  if (published) fs.writeFileSync(path.join(dir, '.sakuraide.json'), JSON.stringify({ publish: { targets: { 'sakura-apprun': { publishedAt: '2026-10-19T00:00:00.000Z', url: 'https://x.example/' } } } }))
}

const runApply = (projectDir: string, storage: StorageClientLike) =>
  applyPlan({ plan: deletePlan(), spec: specWith(true), state: emptyState('myapp', 'sakura-apprun'), client: noCloud, storage, confirmed: true, projectDir })

describe('★★★ 公開の apply の保存場所の削除（applyPlan）: 兄弟の記録を読んでから、バケットごと消すか決める', () => {
  it('実機の再現: キーには自分の prefix しか無いが、兄弟の env.json に同意済みで残っている → バケット削除0件・自分のキーだけ消す・「ほかのプロジェクトも使っています」', async () => {
    const dir = isolatedProjectDir('koto-apply-guard-')
    sibling(dir, 'rc1-shared')
    const { client, calls } = fakeStorage([...MINE])
    const r = await runApply(dir, client)

    expect(r.ok).toBe(true)
    expect(calls.deletedBuckets, 'バケットごと消した（実機の欠陥）').toEqual([])
    expect(calls.deletedKeys).toEqual(MINE)
    expect(r.executed[0]).toBe(`保存場所『${BUCKET}』を削除 — 保存場所は残します。`)
    expect(r.executed.join('\n')).toContain('ほかのプロジェクトも使っています。消すと、そのプロジェクトのデータも消えます。')
    expect(r.state.resources.some(x => x.kind === 'bucket')).toBe(false) // emptyState に bucket は無い（記録の変更はここでは見ない）
  })

  it('★★★ 兄弟の記録を読めない → わからないので残す。「使っているプロジェクトが無いか確かめてください」と言い、「ほかのプロジェクトも使っています」とは言わない', async () => {
    const dir = isolatedProjectDir('koto-apply-guard-')
    sibling(dir, 'broken', '{ not json')
    const { client, calls } = fakeStorage([...MINE])
    const r = await runApply(dir, client)

    expect(r.ok).toBe(true)
    expect(calls.deletedBuckets).toEqual([])
    expect(calls.deletedKeys, '0.6.24 R1-b: 読めない兄弟は複製かもしれない。データ（キー）にも手を付けない').toEqual([])
    expect(r.executed[0]).toBe(`保存場所『${BUCKET}』のデータは残しました — フォルダ『broken』の記録を読めないため、同じデータを使っているか確かめられませんでした。`)
    const text = r.executed.join('\n')
    expect(text).toContain('使っているプロジェクトが無いか確かめてください')
    expect(text).not.toContain('ほかのプロジェクトも使っています')
  })

  it('兄弟がいなければ、バケットごと消す（残して課金を続けさせない）。緑の行は消したことを事実で言う', async () => {
    const dir = isolatedProjectDir('koto-apply-guard-')
    const { client, calls } = fakeStorage([...MINE])
    const r = await runApply(dir, client)

    expect(r.ok).toBe(true)
    expect(calls.deletedBuckets).toEqual([BUCKET])
    expect(r.executed).toEqual([`保存場所『${BUCKET}』を削除 — 保存場所ごと削除しました。月額の課金も止まります。`])
  })

  it('★★ 兄弟が BUCKET を同意済みでも、公開の記録が無い（破棄が済んだ・一度も公開していない）なら数えない → バケットごと消す', async () => {
    const dir = isolatedProjectDir('koto-apply-guard-')
    sibling(dir, 'torn-down', undefined, false)
    const { client, calls } = fakeStorage([...MINE])
    const r = await runApply(dir, client)

    expect(r.ok).toBe(true)
    expect(calls.deletedBuckets).toEqual([BUCKET])
    expect(r.executed).toEqual([`保存場所『${BUCKET}』を削除 — 保存場所ごと削除しました。月額の課金も止まります。`])
  })

  it('★★★ projectDir を渡し忘れた・絶対パスでない → わからない扱い＝バケットは消さない（渡し忘れが「いない」に倒れない）', async () => {
    for (const projectDir of [undefined, '', 'relative/dir'] as unknown[]) {
      const { client, calls } = fakeStorage([...MINE])
      const r = await applyPlan({
        plan: deletePlan(), spec: specWith(true), state: emptyState('myapp', 'sakura-apprun'), client: noCloud, storage: client, confirmed: true,
        projectDir: projectDir as string,
      })
      expect(r.ok, String(projectDir)).toBe(true)
      expect(calls.deletedBuckets, String(projectDir)).toEqual([])
      expect(calls.deletedKeys, String(projectDir)).toEqual([]) // 確かめ自体ができなかった（0.6.24 R1-b）: データ（キー）にも手を付けない
      expect(r.executed[0], String(projectDir)).toBe(`保存場所『${BUCKET}』のデータは残しました — ほかのフォルダの記録を読めないため、同じデータを使っているか確かめられませんでした。`)
    }
  })
})

describe('applyForProject（cloud:apply の入口）: projectDir を applyPlan まで運び、終わったら必ず一時キーを片づける', () => {
  it('★★★ 兄弟が使っている保存場所は、この入口から呼んでも消えない。呼び終えたら storage.dispose() が1回呼ばれる', async () => {
    const dir = isolatedProjectDir('koto-apply-guard-')
    sibling(dir, 'rc1-shared')
    const { client, calls } = fakeStorage([...MINE])
    const r = await applyForProject({ plan: deletePlan(), spec: specWith(true), state: emptyState('myapp', 'sakura-apprun'), client: noCloud, storage: client, confirmed: true, projectDir: dir })

    expect(r.ok).toBe(true)
    expect(calls.deletedBuckets).toEqual([])
    expect(calls.disposed).toBe(1)
  })

  it('★ 兄弟がいなければ、この入口から呼んでもバケットごと消える（projectDir が applyPlan まで届いている証拠。落とすと「わからない」になり消えない）', async () => {
    const dir = isolatedProjectDir('koto-apply-guard-')
    const { client, calls } = fakeStorage([...MINE])
    const r = await applyForProject({ plan: deletePlan(), spec: specWith(true), state: emptyState('myapp', 'sakura-apprun'), client: noCloud, storage: client, confirmed: true, projectDir: dir })

    expect(r.ok).toBe(true)
    expect(calls.deletedBuckets).toEqual([BUCKET])
    expect(calls.disposed).toBe(1)
  })

  it('applyPlan が投げても dispose する。確認なしの破壊的な plan は、保存場所に1件も要求を出さない', async () => {
    const dir = isolatedProjectDir('koto-apply-guard-')
    const broken = fakeStorage([...MINE])
    broken.client.isSiteReady = async () => { throw new Error('ネットワークが切れました') }
    const createPlan: Plan = { actions: [{ type: 'create', kind: 'bucket', name: BUCKET, stateful: true, destructive: false, description: '用意' } as any], hasDestructive: false, hasStatefulDelete: false }
    await expect(applyForProject({ plan: createPlan, spec: specWith(true), state: emptyState('myapp', 'sakura-apprun'), client: noCloud, storage: broken.client, confirmed: true, projectDir: dir })).rejects.toThrow()
    expect(broken.calls.disposed).toBe(1)

    const second = fakeStorage([...MINE])
    const r = await applyForProject({ plan: deletePlan(), spec: specWith(true), state: emptyState('myapp', 'sakura-apprun'), client: noCloud, storage: second.client, confirmed: false, projectDir: dir })
    expect(r.ok).toBe(false)
    expect(second.calls.deletedKeys).toEqual([])
    expect(second.calls.deletedBuckets).toEqual([])
  })
})

describe('teardownStorage: バケットを消す道は1つ（projectDir が必須）', () => {
  it('★★★ projectDir を渡さない・絶対パスでないときは消さない。渡して兄弟もいなければ消す', async () => {
    for (const projectDir of [undefined, '', 'relative'] as unknown[]) {
      const { client, calls } = fakeStorage([...MINE])
      const r = await teardownStorage({ storage: client, placement: { bucket: BUCKET, prefix: PREFIX, shared: true }, projectDir: projectDir as string })
      expect(r.ok, String(projectDir)).toBe(true)
      if (r.ok) {
        expect(r.deletedBucket, String(projectDir)).toBe(false)
        expect(r.keptReasons, String(projectDir)).toEqual({ ownFiles: false, usedByOthers: false })
      }
      expect(calls.deletedBuckets, String(projectDir)).toEqual([])
    }
    const dir = isolatedProjectDir('koto-apply-guard-')
    const { client, calls } = fakeStorage([...MINE])
    const r = await teardownStorage({ storage: client, placement: { bucket: BUCKET, prefix: PREFIX, shared: true }, projectDir: dir })
    expect(r.ok && r.deletedBucket).toBe(true)
    expect(calls.deletedBuckets).toEqual([BUCKET])
  })

  it('★ ソースの上でも、バケットを消す呼び出し（.deleteBucket(）は storageTeardown.ts の teardownStorage の1か所だけ（新しい道が直に呼んだら落ちる）', () => {
    const root = path.join(__dirname, '..', 'src')
    const hits: string[] = []
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(e.name)) {
          fs.readFileSync(p, 'utf-8').split('\n').forEach((line, i) => {
            if (/\.deleteBucket\(/.test(line) && !line.trim().startsWith('//') && !line.trim().startsWith('*')) hits.push(`${path.relative(root, p)}:${i + 1}`)
          })
        }
      }
    }
    walk(root)
    // storageTeardown.ts … 判断を仰いだあとに呼ぶ唯一の場所。storageAdapter.ts … 注入される保存場所の実装が、さくらの client へ渡すだけ（判断を持たない）
    expect(hits.map(h => h.replace(/:\d+$/, '')).sort()).toEqual(['main/cloud/storageAdapter.ts', 'main/cloud/storageTeardown.ts'])
  })
})
