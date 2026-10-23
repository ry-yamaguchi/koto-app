import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── このテストが固定すること（設計書 docs/teardown-unify-plan.md 10.4.1・10.4.9 の D。2026-10-09 段階1の1a-1）──────────
// D1=1（作者の決定）: 保存場所だけが残った回は、📡 の行も projectId も残す（押し直せる入口）。ところが記録が projectId を持ったままだと、
// 押し直したときの確認は「HANAMII のプロジェクト『X』を削除します」と言う——実体はもう消えている。専有型は消えた資源の ID を記録から外すので
// 「次を削除します」に載らないが、HANAMII は行を残すために projectId を残すので同じにならない。そこで main が
// `publish.hanamii.storageLeftoverBuckets`（残っている保存場所の名前）を書き、renderer の確認の文がそれを読んで言い分ける（1b）。
//
//   ・印を書くのは main だけ。保存場所だけ残った回（プロジェクトは消えた・ok:false）に、残っている保存場所の名前を全件書く
//   ・設定を読めず名前が分からない回は空配列 []（「プロジェクトは消えた・残りの名前は不明」）
//   ・行も projectId もほかの設定も、そのまま残る。増えるのは印だけ
//   ・押し直して全部片づけば、行・projectId・印が消える（main の1か所）。「一覧から削除」（withoutPublishTarget）も印を消す
//   ・記録の projectId が消したものと違う／記録が無い・壊れている → 印を書かない（ファイルを作らず、壊れたものを上書きもしない）
//   ・書けなかったときは結果の ok を変えず、起きたことに知らせの行を足す
//   ・HANAMII が削除を受け付けただけの回（202）は、印も書かない（プロジェクトはまだ消えていない）
// ここも本物のハンドラ・本物のディスク・偽の HANAMII・偽の保存場所に流す（ソースの文字列は読まない・掟10）。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  hasCreds: true,
  status: 200,
  calls: [] as string[],
  /** 一覧が失敗する保存場所（バケット名）。 */
  listThrowsFor: [] as string[],
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

vi.mock('../src/main/cloud/storageAdapter', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    createStorageAdapter: async () => ({
      siteInfo: () => ({ s3Endpoint: 's3.isk01.sakurastorage.jp', region: 'jp-north-1' }),
      async isSiteReady() { return true },
      async ensureBucket() {},
      async putMarker() {},
      async listAllKeys(bucket: string) {
        h.calls.push(`list ${bucket}`)
        if (h.listThrowsFor.includes(bucket)) throw new Error('一覧を取得できませんでした（テスト）')
        return ['projects/myapp/a.txt']
      },
      async deleteKeys() {},
      async deleteBucket(bucket: string) { h.calls.push(`deleteBucket ${bucket}`) },
      async deletePermission() {},
      async issueKey() { return { accessKey: 'AKIA-X', secretKey: 'S3CRET-X', permissionId: 'perm-tmp' } },
      async listPermissions() { return [] },
      async dispose() {},
    }),
  }
})

import { registerHanamiiHandlers } from '../src/main/ipc/hanamii'
import { markHanamiiStorageLeftoverFs, forgetPublishTargetFs } from '../src/main/publishMetaFs'
import { withHanamiiStorageLeftover, withoutPublishTarget } from '../src/shared/publishMeta'
import { resetProjectOpsForTests } from '../src/main/projectOps'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'
import { deleteProjectReply } from './hanamiiTeardownFixtures'
import { isolatedProjectDir } from './isolatedProject'

registerHanamiiHandlers({} as any)
const teardown = h.handlers.get('hanamii:teardown')!

const EVENT = {}
const P1 = 'hnm-proj-1'
const B1 = 'koto-data-x'
const B2 = 'koto-data-y'
const consented = (bucket: string) => ({ bucket, prefix: 'projects/myapp/', shared: true, consentedAt: '2026-08-14T00:00:00.000Z' })

let projectDir = ''
const realFetch = globalThis.fetch
const metaFile = () => path.join(projectDir, '.sakuraide.json')
const readMeta = (): any => JSON.parse(fs.readFileSync(metaFile(), 'utf-8'))
const writeMeta = (m: unknown) => fs.writeFileSync(metaFile(), JSON.stringify(m, null, 2), 'utf-8')

/** 公開済みの記録。HANAMII の設定（workspaceId・envs）・別の公開先・専有型の資源IDも持たせて、「残るもの」を確かめられるようにする。 */
function publishedMeta(projectId: string = P1): any {
  return {
    name: 'myapp',
    publish: {
      hanamii: { projectId, workspaceId: 'ws-1', name: 'myapp', envs: [{ key: 'A', value: '1', secret: false }] },
      targets: {
        hanamii: { publishedAt: '2026-09-29T00:00:00.000Z', url: 'https://myapp.example.test' },
        vercel: { publishedAt: '2026-09-28T00:00:00.000Z', url: 'https://myapp.vercel.test' },
      },
      apprunDedicated: { clusterID: 'cluster-1' },
    },
  }
}

function setEnv(buckets: string[], raw?: string) {
  const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: false })
  spec.persistence = { objectStorage: buckets.map(consented) } as any
  fs.mkdirSync(path.join(projectDir, '.sakura-cloud'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), raw ?? JSON.stringify(spec, null, 2), 'utf-8')
}

beforeEach(() => {
  resetProjectOpsForTests()
  projectDir = isolatedProjectDir('koto-hanamii-leftover-')
  h.hasCreds = true
  h.status = 200
  h.calls = []
  h.listThrowsFor = []
  globalThis.fetch = (async (input: unknown, init: any) => {
    h.calls.push(`${init?.method ?? 'GET'} ${String(input)}`)
    return deleteProjectReply(h.status, String(input).split('/').pop() ?? '')
  }) as unknown as typeof fetch
  writeMeta(publishedMeta())
})
afterEach(() => {
  globalThis.fetch = realFetch
  fs.rmSync(projectDir, { recursive: true, force: true })
})

const run = (projectId: string = P1) => teardown(EVENT, projectDir, { token: 'hnm_test' }, { confirmed: true, projectId })

/** 印のほかは、記録がそのまま（行・projectId・設定・別の公開先・専有型の資源ID）。 */
function expectOnlyMarkerAdded(before: any) {
  const after = readMeta()
  const { storageLeftoverBuckets: _marker, ...hanamiiRest } = after.publish.hanamii
  expect({ ...after, publish: { ...after.publish, hanamii: hanamiiRest } }).toEqual(before)
}

describe('★★★ 保存場所だけ残った回: main が印（残っている保存場所の名前）を書く。行も projectId もそのまま', () => {
  it('★★★ 認証情報が無くて片づけられない → 残っている保存場所を全件、印に書く', async () => {
    setEnv([B1, B2])
    h.hasCreds = false
    const before = readMeta()
    const r = await run()
    expect(r.ok).toBe(false)
    expect(r.appDeleted).toBe(true)
    expect(readMeta().publish.hanamii.storageLeftoverBuckets).toEqual([B1, B2])
    expectOnlyMarkerAdded(before)
  })

  it('★★★ 1件目は片づき、2件目で止まる → 印は残っている2件目だけ（片づいた分を「残っている」と言わない）', async () => {
    setEnv([B1, B2])
    h.listThrowsFor = [B2]
    const r = await run()
    expect(r.ok).toBe(false)
    expect(r.remainingBuckets).toEqual([B2])
    expect(readMeta().publish.hanamii.storageLeftoverBuckets).toEqual([B2])
  })

  it('★★★ 保存場所の設定を読めない（名前が分からない）→ 印は空配列 []（プロジェクトは消えた・残りの名前は不明）', async () => {
    setEnv([B1], '{ これは JSON ではない')
    const r = await run()
    expect(r.ok).toBe(false)
    expect(r.appDeleted).toBe(true)
    expect(readMeta().publish.hanamii.storageLeftoverBuckets).toEqual([])
    expect(readMeta().publish.hanamii.projectId).toBe(P1)
  })

  it('★★★ 押し直して全部片づく → 行・projectId・印が消える。ほかの設定・別の公開先・専有型の資源IDは残る（消すのは main だけ）', async () => {
    setEnv([B1])
    h.hasCreds = false
    expect((await run()).ok).toBe(false)
    expect(readMeta().publish.hanamii.storageLeftoverBuckets).toEqual([B1])

    // 押し直し: プロジェクトはもう無い（404）。認証情報を登録したので、保存場所の削除が通る
    h.hasCreds = true
    h.status = 404
    h.calls = []
    const second = await run()
    expect(second.ok).toBe(true)
    expect(h.calls).toContain(`deleteBucket ${B1}`)
    const m = readMeta()
    expect(m.publish.hanamii.projectId).toBeNull()
    expect(m.publish.hanamii.storageLeftoverBuckets, '全部片づいたのに印が残っている').toBeNull()
    expect(m.publish.targets.hanamii, '全部片づいたのに行が残っている').toBeUndefined()
    expect(m.publish.hanamii.workspaceId).toBe('ws-1')
    expect(m.publish.targets.vercel).toBeDefined()
    expect(m.publish.apprunDedicated).toEqual({ clusterID: 'cluster-1' })
  })

  it('★★ 押し直してまた残る → 印は今回の残りに書き換わる', async () => {
    setEnv([B1, B2])
    h.hasCreds = false
    await run()
    expect(readMeta().publish.hanamii.storageLeftoverBuckets).toEqual([B1, B2])
    h.hasCreds = true
    h.status = 404
    h.listThrowsFor = [B2]
    const second = await run()
    expect(second.ok).toBe(false)
    expect(readMeta().publish.hanamii.storageLeftoverBuckets).toEqual([B2])
    expect(readMeta().publish.hanamii.projectId).toBe(P1)
  })

  it('★★ HANAMII の削除が失敗、または受け付けただけ（202）→ 印は書かない（プロジェクトはまだ消えていない）', async () => {
    setEnv([B1])
    const before = readMeta()
    for (const status of [202, 500, 403]) {
      h.status = status
      await run()
      expect(readMeta(), String(status)).toEqual(before)
    }
  })

  it('★★ 保存場所を使っていない・全部片づく回は、印を書かない', async () => {
    setEnv([])
    expect((await run()).ok).toBe(true)
    expect(readMeta().publish.hanamii.storageLeftoverBuckets ?? null).toBeNull()
  })

  it('★★ 全部片づいた回は、印を書こうとすらしない（記録が書き込めない回に「保存場所が残っている」と言い違えない）', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return // root は書けてしまう
    setEnv([B1])
    fs.chmodSync(metaFile(), 0o444)
    try {
      const r = await run()
      expect(r.ok, '保存場所は片づいている').toBe(true)
      const warns = (r.executed ?? []).filter((l: string) => l.startsWith('⚠️'))
      expect(warns, '知らせは「公開の記録を削除できませんでした」の1行だけ').toHaveLength(1)
      expect(warns[0]).toContain('公開の記録を削除できませんでした')
      expect(warns[0]).not.toContain('保存場所が残っている')
    } finally { fs.chmodSync(metaFile(), 0o644) }
  })

  it('★★ 印を書けなかった → ok も appDeleted も変えず、起きたことに知らせの行（次にどうなるか）を足す', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return // root は書けてしまう
    setEnv([B1])
    h.hasCreds = false
    fs.chmodSync(metaFile(), 0o444)
    try {
      const r = await run()
      expect(r.ok).toBe(false)
      expect(r.appDeleted).toBe(true)
      const line = (r.executed ?? []).find((l: string) => l.startsWith('⚠️') && l.includes('保存場所が残っている'))
      expect(line, '印を書けなかったことを言っていない').toBeDefined()
      expect(line).toContain('もう一度破棄を押すと、残りの保存場所を削除します')
      expect(readMeta().publish.hanamii.storageLeftoverBuckets, '前提: 書けていない').toBeUndefined()
    } finally { fs.chmodSync(metaFile(), 0o644) }
  })
})

describe('★★ markHanamiiStorageLeftoverFs: 記録の守り（settleHanamiiTeardownFs と同じ規則）', () => {
  it('★★★ 記録の projectId が消したものと違う（新しい公開）・projectId が無い → 書かない', () => {
    const cases: any[] = [publishedMeta('hnm-proj-2'), { publish: { hanamii: { projectId: null } } }, { publish: { hanamii: { projectId: '' } } }, { publish: {} }, {}]
    for (const meta of cases) {
      writeMeta(meta)
      const before = fs.readFileSync(metaFile(), 'utf-8')
      expect(markHanamiiStorageLeftoverFs(projectDir, P1, [B1]), JSON.stringify(meta)).toEqual({ ok: true, marked: false })
      expect(fs.readFileSync(metaFile(), 'utf-8'), JSON.stringify(meta)).toBe(before)
    }
  })

  it('★ 記録ファイルが無いときは作らない。壊れているときは上書きしない', () => {
    fs.rmSync(metaFile())
    expect(markHanamiiStorageLeftoverFs(projectDir, P1, [B1])).toEqual({ ok: true, marked: false })
    expect(fs.existsSync(metaFile()), '記録が無いのに、ファイルを作った').toBe(false)
    fs.writeFileSync(metaFile(), '{ 壊れた記録', 'utf-8')
    expect(markHanamiiStorageLeftoverFs(projectDir, P1, [B1])).toEqual({ ok: true, marked: false })
    expect(fs.readFileSync(metaFile(), 'utf-8'), '壊れた記録を上書きした').toBe('{ 壊れた記録')
  })

  it('★ 一致するときは書く（何度書いても同じ）', () => {
    const before = readMeta()
    expect(markHanamiiStorageLeftoverFs(projectDir, P1, [B1, B2])).toEqual({ ok: true, marked: true })
    expect(markHanamiiStorageLeftoverFs(projectDir, P1, [B1, B2])).toEqual({ ok: true, marked: true })
    expect(readMeta().publish.hanamii.storageLeftoverBuckets).toEqual([B1, B2])
    expectOnlyMarkerAdded(before)
  })
})

describe('★★ 印を消す口: 全部片づいた回のほか、「一覧から削除」（withoutPublishTarget）も消す', () => {
  it('★★★ 「一覧から削除」（forgetPublishTargetFs）→ 行・projectId・印が消え、ほかは残る', () => {
    const m = publishedMeta()
    m.publish.hanamii.storageLeftoverBuckets = [B1]
    writeMeta(m)
    expect(forgetPublishTargetFs(projectDir, 'hanamii').ok).toBe(true)
    const after = readMeta()
    expect(after.publish.hanamii.projectId).toBeNull()
    expect(after.publish.hanamii.storageLeftoverBuckets).toBeNull()
    expect(after.publish.targets.hanamii).toBeUndefined()
    expect(after.publish.targets.vercel).toBeDefined()
    expect(after.publish.hanamii.workspaceId).toBe('ws-1')
  })

  it('★ 純関数: withoutPublishTarget は HANAMII のときだけ印を消す。withHanamiiStorageLeftover は名前を整えて書く', () => {
    const publish = { hanamii: { projectId: P1, storageLeftoverBuckets: [B1] }, targets: { hanamii: {}, vercel: {} } }
    expect(withoutPublishTarget(publish as any, 'hanamii').hanamii).toEqual({ projectId: null, storageLeftoverBuckets: null })
    expect(withoutPublishTarget(publish as any, 'vercel').hanamii, '別の公開先の破棄で HANAMII の印を消した').toEqual(publish.hanamii)
    const written = (buckets: any) => (withHanamiiStorageLeftover({ publish: { hanamii: { projectId: P1 } } }, buckets) as any).publish.hanamii
    expect(written([B1, '', B1, B2, 7 as any])).toEqual({ projectId: P1, storageLeftoverBuckets: [B1, B2] })
    expect(written([])).toEqual({ projectId: P1, storageLeftoverBuckets: [] })
    expect(written(null)).toEqual({ projectId: P1, storageLeftoverBuckets: null })
    expect(withHanamiiStorageLeftover(undefined, [B1])).toEqual({ publish: { hanamii: { storageLeftoverBuckets: [B1] } } })
  })
})
