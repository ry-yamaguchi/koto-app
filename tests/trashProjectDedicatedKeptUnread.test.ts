import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── fs:trashProject: 「消さずに残す」の判断を読めない回（cloud:twinFacts の本体が投げる・ok:false・形違いの答え）は、止める側 ──────────────────────
// 残す判断は readTwinFacts（読むだけの口の本体）から読む。実フォルダの記録からは、本物の readTwinFacts は引数が正しい限り ok:true を返すので、
// 読めない答えを作るために、その1つだけを代役にする（返す答えを試験が決める）。それ以外（env.json の読み・記録・trashProjectFs の手順）は本物。
// 変異: 読めない答え（投げる・ok:false・形違い）を、全部残す側と読む、がそれぞれ落ちる。対照: 代役が「全部残す」と答える回は、フォルダを移す（代役が働いていること）。
const twin = vi.hoisted(() => ({
  answer: null as unknown,
  mode: 'answer' as 'answer' | 'throw',
  calls: [] as unknown[][],
}))
vi.mock('../src/main/cloud/twinFacts', () => ({
  readTwinFacts: (...args: unknown[]) => {
    twin.calls.push(args)
    if (twin.mode === 'throw') throw new Error('テスト用の失敗')
    return twin.answer
  },
}))

import { trashProjectFs, FS_TRASH_MESSAGES } from '../src/main/ipc/fsTrash'
import { defaultSpec } from '../src/main/cloud/spec'
import { resetProjectOpsForTests } from '../src/main/projectOps'

const CONSENTED_AT = '2026-08-14T00:00:00.000Z'
const GO = { confirmed: true, skippedForTwins: [] as string[] }
let home = ''
let trashed: string[] = []
const deps = () => ({ home, trashItem: async (p: string) => { trashed.push(p) } })
const SELF = (): string => path.join(home, 'SAKURAIDE', 'p')

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koto-dedicated-kept-unread-')))
  trashed = []
  twin.answer = null; twin.mode = 'answer'; twin.calls = []
  const spec = defaultSpec({ name: 'myapp', hasDockerfile: false })
  spec.persistence = { objectStorage: [{ bucket: 'koto-a', prefix: 'projects/myapp/', shared: true, consentedAt: CONSENTED_AT }] } as any
  fs.mkdirSync(path.join(SELF(), '.sakura-cloud'), { recursive: true })
  fs.writeFileSync(path.join(SELF(), '.sakura-cloud', 'env.json'), JSON.stringify(spec))
  fs.writeFileSync(path.join(SELF(), '.sakuraide.json'), JSON.stringify({
    name: 'p', publish: { targets: { 'sakura-apprun-dedicated': { publishedAt: '2026-10-19T00:00:00.000Z', url: 'https://dedicated.example.com/' } }, apprunDedicated: { storageLeftoverBucket: 'koto-a', storageLeftoverBuckets: ['koto-a'] } },
  }))
})
afterEach(() => {
  resetProjectOpsForTests()
  fs.rmSync(home, { recursive: true, force: true })
})

const KEPT = { ok: true, refusal: null, placements: [{ bucket: 'koto-a', prefix: 'projects/myapp/', keep: { risk: 'twin', folders: ['copy'] } }] }

describe('★★★ 残す判断を読めない回は、フォルダを移さない（止める側）', () => {
  it('★★★ 対照: 残す判断が「全部残す」なら、フォルダを移す。残す判断は、専有型の公開先と env.json の同意済みの保存場所（名前と prefix）で聞く', async () => {
    twin.answer = KEPT
    expect(await trashProjectFs(SELF(), GO, deps())).toEqual({ ok: true })
    expect(trashed).toEqual([SELF()])
    expect(twin.calls).toEqual([[SELF(), { target: 'sakura-apprun-dedicated', placements: [{ bucket: 'koto-a', prefix: 'projects/myapp/' }] }]])
  })

  const UNREADABLE: Array<[string, () => void]> = [
    ['投げる', () => { twin.mode = 'throw' }],
    ['ok:false', () => { twin.answer = { ok: false } }],
    ['null', () => { twin.answer = null }],
    ['undefined', () => { twin.answer = undefined }],
    ['ok:true だが placements が無い', () => { twin.answer = { ok: true, refusal: null } }],
    ['ok:true だが placements が配列でない', () => { twin.answer = { ok: true, refusal: null, placements: 'x' } }],
    ['ok が真偽値の true でない', () => { twin.answer = { ...KEPT, ok: 'true' } }],
    ['keep が付かない（複製はいないと確かめられた）', () => { twin.answer = { ok: true, refusal: null, placements: [{ bucket: 'koto-a', prefix: 'projects/myapp/', keep: null }] } }],
    ['別の名前の保存場所の答えしか無い', () => { twin.answer = { ok: true, refusal: null, placements: [{ bucket: 'koto-other', prefix: 'projects/myapp/', keep: { risk: 'twin', folders: ['copy'] } }] } }],
    ['空の placements', () => { twin.answer = { ok: true, refusal: null, placements: [] } }],
  ]
  it.each(UNREADABLE)('★★★ %s → 専有型の文で断り、trashItem は0回・フォルダの中身は変わらない', async (_name, arrange) => {
    arrange()
    const before = fs.readFileSync(path.join(SELF(), '.sakuraide.json'), 'utf-8')
    expect(await trashProjectFs(SELF(), GO, deps())).toEqual({ ok: false, message: FS_TRASH_MESSAGES.dedicated, reason: 'twins-gone' })
    expect(trashed).toEqual([])
    expect(fs.readFileSync(path.join(SELF(), '.sakuraide.json'), 'utf-8')).toBe(before)
    expect(twin.calls.length, '残す判断を聞いていない（断りが別の理由）').toBe(1)
  })

  it('★★ 資源の ID が残る回も、残す判断が「全部残す」でも断る（ID が先に効く）', async () => {
    twin.answer = KEPT
    fs.writeFileSync(path.join(SELF(), '.sakuraide.json'), JSON.stringify({
      name: 'p', publish: { apprunDedicated: { storageLeftoverBucket: 'koto-a', storageLeftoverBuckets: ['koto-a'], loadBalancerID: 'lb-1' } },
    }))
    expect(await trashProjectFs(SELF(), GO, deps())).toEqual({ ok: false, message: FS_TRASH_MESSAGES.dedicated })
    expect(trashed).toEqual([])
  })

  it('★★ 専有型の記録に消すものが無い回は、残す判断を聞かずに移す（外へも内へも読みを増やさない）', async () => {
    fs.writeFileSync(path.join(SELF(), '.sakuraide.json'), JSON.stringify({ name: 'p' }))
    expect(await trashProjectFs(SELF(), GO, deps())).toEqual({ ok: true })
    expect(twin.calls).toEqual([])
  })
})
