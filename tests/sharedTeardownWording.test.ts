import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'

// ── 共用型の破棄の「実行した内容」に、資源の種類名を出さない（0.6.22-rc.3 の実機・2026-10-20。掟5 の4）──────────────────────
// 0.6.22 の段階2で、共用型の破棄（ipc/cloudTeardown.ts の deletePlanWithoutBuckets）が実行内容の行を `${r.kind}『…』を削除` と自前で組み、
// 結果に「✅ apprun-app『rc1-shared』を削除」と、内部の種類名が出た（0.6.21 までは planner.ts の deleteDescription を通っていて
// 「AppRunアプリ『…』を削除」だった）。行の言い方の唯一の定義は deleteDescription。破棄の実物の流れ（本物の main に偽の client を流す）で、
// 返り値と処理の記録（開き直したときに読むもの）のどの行にも、種類名が出ないことを固定する。
import { APP, OK_AUTH, bucketRef, h, resetHarness, newProjectDir, setup } from './sharedTeardownHarness'
import type { ResourceRef } from '../src/main/cloud/state'

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { deleteDescription } from '../src/main/cloud/planner'
import { getOps, resetProjectOpsForTests } from '../src/main/projectOps'

registerCloudHandlers({} as any)
const teardown = h.handlers.get('cloud:teardown')!
const EVENT = {}
const GO = { confirmed: true, deleteRegistry: false, registryName: null }
const REGISTRY: ResourceRef = { kind: 'registry', id: 'reg-1', stateful: false, key: 'registry:myreg' }
const IMAGE: ResourceRef = { kind: 'image', id: 'img-1', stateful: false, key: 'image:myimg' }
/** 画面に出してはいけない、資源の種類名（記録の kind）。 */
const KIND_NAME = /apprun-app|registry|image|bucket/

let dir = ''
beforeEach(() => { resetProjectOpsForTests(); resetHarness(); dir = newProjectDir() })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

/** 返り値と処理の記録の、画面に出る行をすべて集める。 */
function screenLines(reply: any): string[] {
  const rec = getOps(dir).last
  const r: any = rec?.result ?? {}
  return [
    ...(reply.executed ?? []), ...(reply.skipped ?? []), reply.message ?? '',
    ...(r.lines ?? []), ...(r.warnings ?? []), r.message ?? '', ...(r.extra?.skipped ?? []),
  ].filter((l: unknown): l is string => typeof l === 'string' && l !== '')
}

describe('W1: 共用型の破棄の実物の流れ — 実行内容は「AppRunアプリ『x』を削除」。種類名は出ない', () => {
  it('★★★ アプリ1件: 返り値の executed は「AppRunアプリ『myapp』を削除」。処理の記録にも同じ行。どの行にも種類名が無い', async () => {
    setup(dir, { env: [], resources: [APP] })
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect(reply.executed).toContain('AppRunアプリ『myapp』を削除')
    expect(((getOps(dir).last?.result as any)?.lines ?? [])).toContain('AppRunアプリ『myapp』を削除')
    for (const l of screenLines(reply)) expect(l, l).not.toMatch(KIND_NAME)
  })

  it('★★★ アプリ・レジストリ・イメージの記録が混ざる回: 実行した行も、対応外の行も、種類名でなく画面の言葉で言う', async () => {
    setup(dir, { env: [], resources: [APP, REGISTRY, IMAGE] })
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect(reply.executed).toContain('AppRunアプリ『myapp』を削除')
    expect(reply.skipped).toEqual([
      'コンテナレジストリ『myreg』を削除: 段階3で対応',
      'コンテナイメージ『myimg』を削除: 段階3で対応',
    ])
    for (const l of screenLines(reply)) expect(l, l).not.toMatch(/apprun-app|registry『|image『|bucket『/)
  })

  it('★★ 保存場所の行（バケット）は deletePlanWithoutBuckets に入らない。保存場所があっても、種類名は出ない', async () => {
    setup(dir, { env: ['koto-data-a'], resources: [APP, bucketRef('koto-data-a')] })
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect(reply.executed).toContain('AppRunアプリ『myapp』を削除')
    for (const l of screenLines(reply)) expect(l, l).not.toMatch(/apprun-app|registry『|image『|bucket『/)
  })
})

describe('deleteDescription: 実行内容の行の言い方の唯一の定義（planner と共用型の破棄が同じ）', () => {
  it('★★ 4つの種類を画面の言葉で言う。ステートフルは「データが消えます」と言う', () => {
    expect(deleteDescription('apprun-app', 'x', false)).toBe('AppRunアプリ『x』を削除')
    expect(deleteDescription('registry', 'x', false)).toBe('コンテナレジストリ『x』を削除')
    expect(deleteDescription('image', 'x', false)).toBe('コンテナイメージ『x』を削除')
    expect(deleteDescription('bucket', 'x', true)).toBe('保存場所『x』にある、このプロジェクトのデータを削除（データが消えます）')
    expect(deleteDescription('bucket', 'x', false)).toBe('保存場所『x』にある、このプロジェクトのデータを削除（データが消えます）')
    for (const k of ['apprun-app', 'registry', 'image', 'bucket'] as const) {
      expect(deleteDescription(k, 'x', false), k).not.toMatch(/apprun-app|registry『|image『|bucket『/)
    }
  })
})
