import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── 何も消さなかった専有型の破棄（keptOnly）のあと、同じフォルダのプロジェクトの削除（fs:trashProject）が通る（結合）──────────────────────────────
// 本物の専有型の破棄（apprunDedicated:teardown。偽の保存場所・偽の client・実フォルダ。tests/keptOnlyKeepsRow.test.ts と同じ作り）で、複製のフォルダが同じ保存場所を使うために何も消さなかった回を作る。
// その回は「保存場所が残っている」印を下ろさないので、記録には印だけが残る（資源の ID は無い）。そのフォルダに、本物の trashProjectFs（偽の trashItem）を呼ぶ。
//   ・複製のフォルダがいる（または複製かどうか確かめられない）回 → フォルダを移す（偽の trashItem が呼ばれる）
//   ・複製のフォルダを消してからなら、今までどおり専有型の文で断る（保存場所を削除できる道を残す）
//   ・複製を消したあとの破棄は保存場所まで消し、印が下りて、フォルダも移せる
// 変異: main の判断が keep を見ない・材料に無い名前を残す側に数える・ID を見ない・env.json を読めない回を通す、がそれぞれ落ちる（tests/trashProjectDedicatedKept.test.ts と合わせて）。
import { A, PREFIX, CONSENTED_AT, h, resetHarness, newProjectDir, workspaceOf, setup, publishTargets } from './sharedTeardownHarness'

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))

import { registerApprunDedicatedHandlers } from '../src/main/ipc/apprunDedicated'
import { trashProjectFs, FS_TRASH_MESSAGES } from '../src/main/ipc/fsTrash'
import { readApprunDedicatedFs, writeApprunDedicatedRecordFs, writePublishRecordFs } from '../src/main/publishMetaFs'
import { resetProjectOpsForTests } from '../src/main/projectOps'
import { dedicatedTeardownHasWork } from '../src/shared/teardownSupport'

registerApprunDedicatedHandlers({} as any)
const dedicatedHandler = h.handlers.get('apprunDedicated:teardown')!

const EVENT = { sender: { send: () => {} } }
const S = A
const TWIN = 'myapp copy'
const AUTH = { token: 'tok', secret: 'sec' }
const ROW = { publishedAt: '2026-10-19T00:00:00.000Z', url: 'https://dedicated.example.com/' }
const GO = (keepData = false) => ({ confirmed: true, shownPlacements: [{ bucket: S, prefix: PREFIX, ...(keepData ? { keepData: true as const } : {}) }] })
const TRASH_GO = { confirmed: true, skippedForTwins: [] as string[] }

let dir = ''
let trashed: string[] = []
const deps = () => ({ home: os.tmpdir(), trashItem: async (p: string) => { trashed.push(p) } })
beforeEach(() => {
  resetHarness()
  resetProjectOpsForTests()
  trashed = []
  dir = newProjectDir()
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

/** 保存場所だけが残った印の押し直し（資源の ID は記録に無い）。公開の行（📡）も置く。 */
function leftoverOnly(): void {
  setup(dir, { env: [S], resources: [] })
  writeApprunDedicatedRecordFs(dir, { storageLeftoverBucket: S, storageLeftoverBuckets: [S], storagePermissionId: 'perm-ded', applicationName: 'myapp-ded', hosts: ['myapp.example.com'] })
  writePublishRecordFs(dir, 'sakura-apprun-dedicated', ROW)
}
function twin(): void {
  const p = path.join(workspaceOf(dir), TWIN, '.sakura-cloud')
  fs.mkdirSync(p, { recursive: true })
  fs.writeFileSync(path.join(p, 'env.json'), JSON.stringify({ persistence: { objectStorage: [{ bucket: S, prefix: PREFIX, shared: true, consentedAt: CONSENTED_AT }] } }))
}
function unreadSibling(): void {
  const p = path.join(workspaceOf(dir), 'broken-env', '.sakura-cloud')
  fs.mkdirSync(p, { recursive: true })
  fs.writeFileSync(path.join(p, 'env.json'), '{ not json')
}
const destructive = () => h.calls.filter(c => /^(deleteKeys|deleteBucket|deletePermission|listPermissions)\b/.test(c))
const marks = () => { const r = readApprunDedicatedFs(dir); return { one: r.storageLeftoverBucket, all: r.storageLeftoverBuckets } }

describe('★★★ 本物の専有型の破棄で keptOnly になった回のあと、同じフォルダの fs:trashProject が通る', () => {
  const INPUTS: Array<{ name: string; prepare: () => void }> = [
    { name: '複製のフォルダが同じ保存場所の同じ prefix を持つ', prepare: twin },
    { name: '複製かどうか確かめられない兄弟がいる（記録を読めない）', prepare: unreadSibling },
  ]
  for (const input of INPUTS) {
    it(`★★★ ${input.name}: 何も消さず（keptOnly）、印が残り、続けて trashProjectFs がフォルダを移す（偽の trashItem が1回）`, async () => {
      leftoverOnly()
      input.prepare()
      const reply = await dedicatedHandler(EVENT, dir, AUTH, GO())
      expect(reply.ok).toBe(true)
      expect(reply.keptOnly).toBe(true)
      expect(destructive(), '消す要求が出た').toEqual([])
      expect(marks()).toEqual({ one: S, all: [S] })
      expect(dedicatedTeardownHasWork(readApprunDedicatedFs(dir)), '印が残っている（止める側の材料）').toBe(true)

      const r = await trashProjectFs(dir, TRASH_GO, deps())
      expect(r).toEqual({ ok: true })
      expect(trashed).toEqual([dir])
    })
  }

  it('★★★ 複製のフォルダを消してからなら、同じフォルダを今までどおり専有型の文で断る（移さない。保存場所を削除できる道を残す）', async () => {
    leftoverOnly()
    twin()
    expect((await dedicatedHandler(EVENT, dir, AUTH, GO())).keptOnly).toBe(true)
    fs.rmSync(path.join(workspaceOf(dir), TWIN), { recursive: true, force: true })

    expect(await trashProjectFs(dir, TRASH_GO, deps())).toEqual({ ok: false, message: FS_TRASH_MESSAGES.dedicated, reason: 'twins-gone' })
    expect(trashed).toEqual([])
    expect(marks()).toEqual({ one: S, all: [S] })
  })

  it('★★★ 確認で「消しません」と言った回（keepData）でも、複製のフォルダが無ければ main は移さない（画面の言葉でなく、いまの記録で判断する）', async () => {
    leftoverOnly()
    const reply = await dedicatedHandler(EVENT, dir, AUTH, GO(true))
    expect(reply.keptOnly).toBe(true)
    expect(await trashProjectFs(dir, TRASH_GO, deps())).toEqual({ ok: false, message: FS_TRASH_MESSAGES.dedicated, reason: 'twins-gone' })
    expect(trashed).toEqual([])
  })

  it('★★★ 通しで: 複製がいる間にフォルダを移せる回の記録を、複製を消したあとに破棄し直すと、保存場所まで消えて印が下り、フォルダも移せる', async () => {
    leftoverOnly()
    twin()
    expect((await dedicatedHandler(EVENT, dir, AUTH, GO())).keptOnly).toBe(true)
    fs.rmSync(path.join(workspaceOf(dir), TWIN), { recursive: true, force: true })

    const second = await dedicatedHandler(EVENT, dir, AUTH, GO())
    expect(second.ok).toBe(true)
    expect('keptOnly' in second).toBe(false)
    expect(h.calls).toContain(`deleteBucket ${S}`)
    expect(marks().one ?? null).toBeNull()
    expect(publishTargets(dir)['sakura-apprun-dedicated']).toBeUndefined()

    expect(await trashProjectFs(dir, TRASH_GO, deps())).toEqual({ ok: true })
    expect(trashed).toEqual([dir])
  })

  it('★★★ 資源の ID が記録に残る回は、保存場所が全部複製と共有していても移さない', async () => {
    setup(dir, { env: [S], resources: [] })
    writeApprunDedicatedRecordFs(dir, { storageLeftoverBucket: S, storageLeftoverBuckets: [S], clusterID: 'c-1' })
    writePublishRecordFs(dir, 'sakura-apprun-dedicated', ROW)
    twin()
    expect(await trashProjectFs(dir, TRASH_GO, deps())).toEqual({ ok: false, message: FS_TRASH_MESSAGES.dedicated })
    expect(trashed).toEqual([])
  })

  it('★★★ 自分の env.json が読めない回は、複製がいても移さない', async () => {
    leftoverOnly()
    twin()
    expect((await dedicatedHandler(EVENT, dir, AUTH, GO())).keptOnly).toBe(true)
    fs.writeFileSync(path.join(dir, '.sakura-cloud', 'env.json'), '{ not json')
    expect(await trashProjectFs(dir, TRASH_GO, deps())).toEqual({ ok: false, message: FS_TRASH_MESSAGES.dedicated, reason: 'twins-gone' })
    expect(trashed).toEqual([])
  })
})
