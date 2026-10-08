import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── なぜこのテストが要るか（2026-09-25 検分の指摘23）──────────────────────
// ⑥「すべて削除する」の確認ダイアログの材料になる `storage:placement` は、
// 同意済みの保存場所を**先頭の1件しか返していなかった**。一方、実際に消す側
// （src/main/cloud/storageForTarget.ts の storagePlacementsOf）は**全件**を片づける。
//
// env.json に保存場所が2件ある状態（手で編集した・過去の記録が残っている）で⑥を押すと、
// 確認には「保存場所『A』（中のデータも消えます）」としか出ないのに、**名前が一度も
// 出なかった『B』とその中のデータまで消える**。元に戻せない削除を、名指ししないまま
// 実行させてはいけない（掟10「お金・破壊の歯止め」）。
//
// ここはソースの文字列を読まない。**偽の electron に登録させた実物のハンドラへ、
// 本物の env.json を読ませて**「返ってくる保存場所の一覧」を見る。

const handlers = new Map<string, (...args: any[]) => any>()

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { handlers.set(channel, fn) } },
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {} },
  dialog: {},
}))

import { registerCloudHandlers, consentedPlacements } from '../src/main/ipc/cloud'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'

registerCloudHandlers({} as any)
const placement = handlers.get('storage:placement')!

const CONSENTED = '2026-09-24T00:00:00.000Z'
const A = { bucket: 'koto-data-aaa', prefix: 'projects/myapp/', shared: true, consentedAt: CONSENTED }
const B = { bucket: 'koto-data-bbb', prefix: 'projects/myapp/', shared: true, consentedAt: CONSENTED }
/** 同意していない（費用に同意していないので、用意もされていない）記録。 */
const NOT_CONSENTED = { bucket: 'koto-data-ccc', prefix: 'projects/myapp/', shared: true }

let projectDir = ''

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-placement-'))
})
afterEach(() => {
  try { fs.rmSync(projectDir, { recursive: true, force: true }) } catch { /* 消せなくてもよい */ }
})

/** `.sakura-cloud/env.json` を本物の形で置く。 */
function writeEnv(buckets: unknown[]) {
  const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: false })
  spec.persistence = { objectStorage: buckets as EnvSpec['persistence'] extends undefined ? never : any }
  fs.mkdirSync(path.join(projectDir, '.sakura-cloud'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), JSON.stringify(spec, null, 2), 'utf-8')
}

describe('storage:placement は、消える保存場所を1件も隠さない', () => {
  it('★★★ 保存場所が2件あれば、2件とも返す（確認で名指しできる材料になる）', async () => {
    writeEnv([A, B])
    const r = await placement({}, projectDir)
    expect(r.ok).toBe(true)
    expect((r.placements ?? []).map((p: any) => p.bucket)).toEqual([A.bucket, B.bucket])
  })

  it('★★★ 破棄が片づける一覧と、返す一覧が一致する（確認で見せたものと消すものを揃える）', async () => {
    writeEnv([A, B])
    // 実際に消す側の一元定義。ここと食い違ったら、名前の出ない保存場所が消えている
    const { storagePlacementsOf } = await import('../src/main/cloud/storageForTarget')
    const r = await placement({}, projectDir)
    expect((r.placements ?? []).map((p: any) => p.bucket))
      .toEqual(storagePlacementsOf(projectDir).map(p => p.bucket))
  })

  it('★★ 同意していない記録は、どちらの一覧にも入らない（用意されないものを消すと言わない）', async () => {
    writeEnv([A, NOT_CONSENTED])
    const r = await placement({}, projectDir)
    expect((r.placements ?? []).map((p: any) => p.bucket)).toEqual([A.bucket])
  })

  it('★ 1件目は placement にも入る（「用意済みか」の表示は今までどおり）', async () => {
    writeEnv([A, B])
    const r = await placement({}, projectDir)
    expect(r.placement?.bucket).toBe(A.bucket)
    expect(r.placement?.prefix).toBe(A.prefix)
    expect(r.placement?.shared).toBe(true)
  })

  it('★ 保存場所を使っていなければ、placement は null・placements は0件', async () => {
    writeEnv([])
    const r = await placement({}, projectDir)
    expect(r.placement).toBeNull()
    expect(r.placements).toEqual([])
  })

  it('★ env.json が無いプロジェクトでも落ちない', async () => {
    const r = await placement({}, projectDir)
    expect(r.ok).toBe(true)
    expect(r.placement).toBeNull()
    expect(r.placements).toEqual([])
  })

  it('★ env.json が壊れていたら、黙って0件にせずエラーを返す', async () => {
    fs.mkdirSync(path.join(projectDir, '.sakura-cloud'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), '{ 壊れている', 'utf-8')
    const r = await placement({}, projectDir)
    expect(r.ok).toBe(false)
    expect(String(r.message ?? '')).not.toBe('')
  })

  it('読む関数そのものも全件を返す（ハンドラと同じ一元定義を使っている）', () => {
    writeEnv([A, B])
    expect(consentedPlacements(projectDir).map(p => p.bucket)).toEqual([A.bucket, B.bucket])
  })
})
