import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 共用型 cloud:teardown: コンテナレジストリの削除の要求を出したのに、結果が分からない回は「何も消さなかった」と言わない ─────────────────
// 本物の main に偽の client・偽の保存場所・偽の兄弟フォルダ（複製）を流し、**出た要求の一覧**と返り値で固定する（掟10）。
// 保存場所は全部「消さずに残す」（複製がいる）回にして、keptOnly が付くかどうかをレジストリの削除の結果だけで決まるようにする。
//   ・削除の要求が投げた（打ち切りなど。さくら側で消えたかもしれない）→ keptOnly を付けない。記録にはレジストリの名前を残す
//   ・削除の要求が HTTP の失敗で返った（消えていないと分かる）→ 付く
//   ・一覧の取得が投げた・失敗した（削除の要求を出していない）→ 付く
// 判定の全分岐は tests/keptOnly.test.ts、レジストリを消さない回・消した回は tests/keptOnlyTeardown.test.ts、teardownRegistry 単体は tests/cloudIpcRegistryTeardown.test.ts。
import { A, OK_AUTH, PREFIX, CONSENTED_AT, REGISTRY_ROW, bucketRef, h, resetHarness, newProjectDir, workspaceOf, setup, stateMeta } from './sharedTeardownHarness'
import { shownTeardown } from './shownFromEnv'

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))

import { registerCloudHandlers } from '../src/main/ipc/cloud'

registerCloudHandlers({} as any)
const sharedTeardown = shownTeardown(h.handlers.get('cloud:teardown')!)

const EVENT = { sender: { send: () => {} } }
const S = A
const GO_DELETE_REGISTRY = { confirmed: true, deleteRegistry: true, registryName: 'myreg' }
const CANNOT_CONFIRM = 'レジストリ『myreg』を削除できたか確認できませんでした'

let dir = ''
beforeEach(() => {
  resetHarness()
  dir = newProjectDir()
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

/** 複製（`myapp copy`）を、元と同じ親フォルダに置く。元と同じバケット・同じ prefix を同意済みで持つ。 */
function twin(): void {
  const p = path.join(workspaceOf(dir), 'myapp copy')
  fs.mkdirSync(path.join(p, '.sakura-cloud'), { recursive: true })
  fs.writeFileSync(path.join(p, '.sakura-cloud', 'env.json'), JSON.stringify({
    persistence: { objectStorage: [{ bucket: S, prefix: PREFIX, shared: true, consentedAt: CONSENTED_AT }] },
  }))
}

/** レジストリを消す選択をした回の準備（アプリ無し・保存場所1件は複製と同じ・記録にレジストリ『myreg』）。 */
function arrange(): void {
  setup(dir, { env: [S], resources: [bucketRef(S)], meta: { registryName: 'myreg' } })
  twin()
  h.registryRows = [REGISTRY_ROW]
}

const registryCalls = () => h.calls.filter((c: string) => /^(listContainerRegistries|deleteContainerRegistry)\b/.test(c))
const storageDeletes = () => h.calls.filter((c: string) => /^(deleteKeys|deleteBucket|deletePermission)\b/.test(c))

describe('★★★ 共用型 cloud:teardown: レジストリの削除の結果が分からない回は keptOnly を付けない', () => {
  it('★★★ 削除の要求が投げた（結果が分からない）→ keptOnly を付けない。要求は1回出ていて、確認できなかった旨の行が返り、記録にレジストリの名前が残る', async () => {
    arrange()
    h.fail['deleteContainerRegistry reg-1'] = 'throw'
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO_DELETE_REGISTRY)

    expect(reply.ok).toBe(true)
    expect(registryCalls()).toEqual(['listContainerRegistries', 'deleteContainerRegistry reg-1'])
    expect('keptOnly' in reply, '消えたか分からないのに「何も消さなかった」と言った').toBe(false)
    expect((reply.executed as string[]).some(l => l.includes(CANNOT_CONFIRM))).toBe(true)
    expect(reply.keptBucketNames).toEqual([S])
    expect(storageDeletes(), '保存場所は複製のため残す').toEqual([])
    expect(stateMeta(dir)?.registryName, '消えたと確かめられていないので、名前を記録に残す').toBe('myreg')
  })

  it('★★★ 削除の要求が HTTP の失敗で返った（消えていないと分かる）→ keptOnly が付く。要求は1回出ている', async () => {
    arrange()
    h.fail['deleteContainerRegistry reg-1'] = 'http500'
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO_DELETE_REGISTRY)

    expect(reply.ok).toBe(true)
    expect(registryCalls()).toEqual(['listContainerRegistries', 'deleteContainerRegistry reg-1'])
    expect(reply.keptOnly).toBe(true)
    expect((reply.executed as string[]).some(l => l.includes('削除に失敗（HTTP 500）'))).toBe(true)
    expect(stateMeta(dir)?.registryName).toBe('myreg')
  })

  it('★★★ 一覧の取得が投げた（削除の要求を出していない）→ keptOnly が付く。削除の要求は0件', async () => {
    arrange()
    h.fail.listContainerRegistries = 'throw'
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO_DELETE_REGISTRY)

    expect(reply.ok).toBe(true)
    expect(registryCalls()).toEqual(['listContainerRegistries'])
    expect(reply.keptOnly).toBe(true)
    expect((reply.executed as string[]).some(l => l.includes(CANNOT_CONFIRM))).toBe(true)
    expect(stateMeta(dir)?.registryName).toBe('myreg')
  })

  it('★★ 一覧の取得が HTTP の失敗で返った（削除の要求を出していない）→ keptOnly が付く。削除の要求は0件', async () => {
    arrange()
    h.fail.listContainerRegistries = 'http500'
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO_DELETE_REGISTRY)

    expect(reply.ok).toBe(true)
    expect(registryCalls()).toEqual(['listContainerRegistries'])
    expect(reply.keptOnly).toBe(true)
  })

  it('★★ 対照: 削除に成功した回は keptOnly を付けず、記録からレジストリの名前が落ちる', async () => {
    arrange()
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO_DELETE_REGISTRY)

    expect(reply.ok).toBe(true)
    expect(registryCalls()).toEqual(['listContainerRegistries', 'deleteContainerRegistry reg-1'])
    expect('keptOnly' in reply).toBe(false)
    expect(stateMeta(dir)?.registryName).toBeUndefined()
  })
})
