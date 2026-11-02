import { describe, it, expect, afterEach } from 'vitest'

// ── 削除の画面の材料: 保存場所ごとの「消さずに残す」（keep）を cloud:twinFacts で読む（readProjectDeleteFacts）────────────────
// 読めた回の、残す保存場所にだけ keep を付ける。口が無い・投げた・ok:false・形の違う答えは、何も付けない（今までどおり）。
// 保存場所の一覧は材料の placements（env.json）と sharedLeftover.placements（記録の残り）の2つ。重なる組は1回の問い合わせにまとめる。
// 読むだけ（書く口・ほかの読む口を増やさない）。投げない。偽の window は、呼ばれた口の名前と引数を残す。

import { readProjectDeleteFacts } from '../src/renderer/teardown/projectDeleteFacts'
import { planProjectDeleteTeardown } from '../src/renderer/teardown/projectDeletePlan'
import type { TwinFactsArgs } from '../src/shared/twinFactsTypes'

afterEach(() => { delete (globalThis as any).window })

const DIR = '/work/proj'
const A = { bucket: 'koto-a', prefix: 'projects/myapp/', shared: true }
const B = { bucket: 'koto-b', prefix: 'projects/myapp/', shared: false }
const rec = (placements: unknown[]) => ({ appNames: [], registryName: null, registryOrigin: 'unknown', registryUsers: [], placements, stateOnlyBuckets: [] })
const KEEP = { risk: 'twin', folders: ['copy'] }

type Answer = (args: TwinFactsArgs) => unknown
/** 偽の window。twinFacts が undefined なら口が無い（プロパティ自体を置かない）。 */
function install(opts: { env: unknown[]; record: unknown[]; twinFacts?: Answer | 'absent' }) {
  const log: string[] = []
  const twinCalls: Array<{ dir: string; args: TwinFactsArgs }> = []
  const cloud: Record<string, unknown> = {
    teardownRecord: async () => { log.push('cloud.teardownRecord'); return { ok: true, record: rec(opts.record) } },
  }
  if (opts.twinFacts !== 'absent') {
    cloud.twinFacts = async (dir: string, args: TwinFactsArgs) => {
      log.push('cloud.twinFacts'); twinCalls.push({ dir, args })
      const a = opts.twinFacts ?? ((x: TwinFactsArgs) => ({ ok: true, refusal: null, placements: x.placements.map(p => ({ bucket: p.bucket, prefix: p.prefix, keep: null })) }))
      const v = a(args)
      if (v instanceof Error) throw v
      return v
    }
  }
  ;(globalThis as any).window = {
    electronAPI: {
      fs: { exists: async () => { log.push('fs.exists'); return false }, readFile: async () => { log.push('fs.readFile'); throw new Error('ENOENT') } },
      publishMeta: { runningOp: async () => { log.push('publishMeta.runningOp'); return null } },
      apprunDedicated: { state: async () => { log.push('apprunDedicated.state'); return null } },
      storage: { placement: async () => { log.push('storage.placement'); return { ok: true, placements: opts.env } } },
      cloud,
    },
  }
  return { log, twinCalls }
}
/** 組ごとの keep を決める偽の答え（組に無ければ keep なし）。 */
const answer = (keeps: Record<string, unknown>): Answer => args => ({
  ok: true, refusal: null,
  placements: args.placements.map(p => ({ bucket: p.bucket, prefix: p.prefix, keep: keeps[p.bucket] ?? null })),
})

/** 名前と prefix の組ごとに keep を決める偽の答え（`${bucket}\u0000${prefix}`。組に無ければ keep なし）。本物の cloud:twinFacts は組で答える。 */
const answerPairs = (keeps: Record<string, unknown>): Answer => args => ({
  ok: true, refusal: null,
  placements: args.placements.map(p => ({ bucket: p.bucket, prefix: p.prefix, keep: keeps[`${p.bucket}\u0000${p.prefix}`] ?? null })),
})

describe('材料: keep を cloud:twinFacts で読む', () => {
  it('★★★ 全部 keep: materials の placements と sharedLeftover.placements の両方に keep が付く。問い合わせは1回（保存場所の組だけ・dir つき）', async () => {
    const { twinCalls } = install({ env: [A], record: [A], twinFacts: answer({ 'koto-a': KEEP }) })
    const f = await readProjectDeleteFacts(DIR)
    expect(f.placements).toEqual([{ ...A, keep: KEEP }])
    expect(f.sharedLeftover?.placements).toEqual([{ ...A, keep: KEEP }])
    expect(twinCalls).toEqual([{ dir: DIR, args: { target: 'sakura-apprun', placements: [{ bucket: 'koto-a', prefix: 'projects/myapp/' }] } }])
    expect(planProjectDeleteTeardown(f)).toEqual({ block: null, teardown: [], twinned: [] }) // R4 の形: 残りの段を足さない
  })

  it('★★★ 混在: keep のある保存場所にだけ keep が付く。keep の無い保存場所のオブジェクトには、キーごと付かない', async () => {
    install({ env: [A, B], record: [A, B], twinFacts: answer({ 'koto-a': KEEP }) })
    const f = await readProjectDeleteFacts(DIR)
    expect(f.placements).toEqual([{ ...A, keep: KEEP }, B])
    expect(Object.keys(f.placements[1]).sort()).toEqual(['bucket', 'prefix', 'shared'])
    expect(Object.keys(f.sharedLeftover!.placements[1]).sort()).toEqual(['bucket', 'prefix', 'shared'])
    expect(planProjectDeleteTeardown(f)).toMatchObject({ teardown: ['sakura-apprun'], leftover: { noun: '保存場所' } }) // 消す保存場所があるので足す
  })

  it('★★ 理由が確かめられなかった（unread）も keep として付く', async () => {
    install({ env: [A], record: [A], twinFacts: answer({ 'koto-a': { risk: 'unread', folders: [] } }) })
    const f = await readProjectDeleteFacts(DIR)
    expect(f.sharedLeftover?.placements[0].keep).toEqual({ risk: 'unread', folders: [] })
    expect(planProjectDeleteTeardown(f).teardown).toEqual([])
  })

  it('★★★ 重なる組は1回にまとめる: env.json の保存場所と、記録の残り（env.json + state にだけあるもの）を合わせて、1回の問い合わせ。両方の一覧に keep が届く', async () => {
    const { twinCalls } = install({ env: [A], record: [A, B], twinFacts: answer({ 'koto-a': KEEP, 'koto-b': { risk: 'unread', folders: ['x'] } }) })
    const f = await readProjectDeleteFacts(DIR)
    expect(twinCalls).toHaveLength(1)
    expect(twinCalls[0].args.placements).toEqual([{ bucket: 'koto-a', prefix: 'projects/myapp/' }, { bucket: 'koto-b', prefix: 'projects/myapp/' }])
    expect(f.placements).toEqual([{ ...A, keep: KEEP }])
    expect(f.sharedLeftover?.placements).toEqual([{ ...A, keep: KEEP }, { ...B, keep: { risk: 'unread', folders: ['x'] } }])
  })

  describe('同じバケットの別の prefix が2件（P1 は複製と共有・P2 は誰も使わない）: keep は名前と prefix の組で当てる', () => {
    const P1 = { bucket: 'koto-a', prefix: 'projects/p1/', shared: true }
    const P2 = { bucket: 'koto-a', prefix: 'projects/p2/', shared: true }
    const pair = (p: { bucket: string; prefix: string }) => `${p.bucket}\u0000${p.prefix}`

    it('★★★ P1 にだけ keep: 問い合わせは2組とも。材料の placements も sharedLeftover.placements も P1 にだけ keep が付く。P2 は消す側なので、plan は残りの段を足す（混在）', async () => {
      const { twinCalls } = install({ env: [P1, P2], record: [P1, P2], twinFacts: answerPairs({ [pair(P1)]: KEEP }) })
      const f = await readProjectDeleteFacts(DIR)
      expect(twinCalls).toHaveLength(1)
      expect(twinCalls[0].args.placements).toEqual([{ bucket: 'koto-a', prefix: 'projects/p1/' }, { bucket: 'koto-a', prefix: 'projects/p2/' }])
      expect(f.placements).toEqual([{ ...P1, keep: KEEP }, P2])
      expect(f.sharedLeftover?.placements).toEqual([{ ...P1, keep: KEEP }, P2])
      expect(Object.keys(f.placements[1]).sort()).toEqual(['bucket', 'prefix', 'shared'])
      expect(planProjectDeleteTeardown(f)).toMatchObject({ teardown: ['sakura-apprun'], leftover: { noun: '保存場所' } })
    })

    it('★★★ 逆: P2 にだけ keep なら、P1 は消す側のまま（keep が同じ名前の別の prefix へ移らない）', async () => {
      install({ env: [P1, P2], record: [P1, P2], twinFacts: answerPairs({ [pair(P2)]: KEEP }) })
      const f = await readProjectDeleteFacts(DIR)
      expect(f.placements).toEqual([P1, { ...P2, keep: KEEP }])
      expect(f.sharedLeftover?.placements).toEqual([P1, { ...P2, keep: KEEP }])
      expect(planProjectDeleteTeardown(f)).toMatchObject({ teardown: ['sakura-apprun'], leftover: { noun: '保存場所' } })
    })

    it('★★★ 両方 keep なら、残りの段は足さない（全部 keep）。どちらも keep でなければ、段を足す', async () => {
      install({ env: [P1, P2], record: [P1, P2], twinFacts: answerPairs({ [pair(P1)]: KEEP, [pair(P2)]: { risk: 'unread', folders: [] } }) })
      const all = await readProjectDeleteFacts(DIR)
      expect(all.placements).toEqual([{ ...P1, keep: KEEP }, { ...P2, keep: { risk: 'unread', folders: [] } }])
      expect(planProjectDeleteTeardown(all).teardown).toEqual([])
      install({ env: [P1, P2], record: [P1, P2], twinFacts: answerPairs({}) })
      const none = await readProjectDeleteFacts(DIR)
      expect(none.placements).toEqual([P1, P2])
      expect(planProjectDeleteTeardown(none).teardown).toEqual(['sakura-apprun'])
    })
  })

  it('★★ 共用型の行がある回（記録の残りは無い）も、材料の placements に keep が付く', async () => {
    const files: Record<string, string> = { '/work/proj/.sakuraide.json': JSON.stringify({ name: 'myapp', publish: { targets: { 'sakura-apprun': { publishedAt: '2026-10-01T00:00:00.000Z' } } } }) }
    install({ env: [A], record: [A], twinFacts: answer({ 'koto-a': KEEP }) })
    ;(globalThis as any).window.electronAPI.fs = { exists: async (p: string) => p in files, readFile: async (p: string) => files[p] }
    const f = await readProjectDeleteFacts(DIR)
    expect(f.targets).toEqual(['sakura-apprun'])
    expect(f.sharedLeftover).toBeNull()
    expect(f.placements).toEqual([{ ...A, keep: KEEP }])
  })

  it('★★★ 保存場所が1件も無い回は、問い合わせない', async () => {
    const { log } = install({ env: [], record: [], twinFacts: answer({}) })
    await readProjectDeleteFacts(DIR)
    expect(log).not.toContain('cloud.twinFacts')
  })

  it('★★★ 読むだけ: 増える口は cloud.twinFacts の1つだけ。書く口・ほかの読む口は増えない', async () => {
    const without = install({ env: [A], record: [A], twinFacts: 'absent' })
    await readProjectDeleteFacts(DIR)
    const base = [...without.log]
    const withRead = install({ env: [A], record: [A], twinFacts: answer({ 'koto-a': KEEP }) })
    await readProjectDeleteFacts(DIR)
    expect(withRead.log.filter(n => n !== 'cloud.twinFacts')).toEqual(base)
    expect(withRead.log.filter(n => n === 'cloud.twinFacts')).toHaveLength(1)
  })

  it('★★ 答えの断り（refusal）は、この材料には載せない。保存場所の keep だけを使う', async () => {
    install({ env: [A], record: [A], twinFacts: args => ({ ok: true, refusal: { kind: 'twin', folders: ['copy'] }, placements: args.placements.map(p => ({ bucket: p.bucket, prefix: p.prefix, keep: null })) }) })
    const f = await readProjectDeleteFacts(DIR)
    expect(f.placements).toEqual([A])
    expect(Object.keys(f).sort()).toEqual(['dedicated', 'placements', 'running', 'sharedLeftover', 'sharedRegistry', 'targets', 'twins', 'unconfirmed', 'unreadable'])
  })
})

describe('材料: 読めなかった回は keep を付けない（今までどおり。残りの段は足す側）', () => {
  const UNREADABLE: Array<[string, Answer | 'absent']> = [
    ['口が無い（window.electronAPI.cloud.twinFacts が無い）', 'absent'],
    ['口が投げる', () => new Error('IPC が落ちた')],
    ['ok:false', () => ({ ok: false })],
    ['null を返す', () => null],
    ['件数が違う', args => ({ ok: true, refusal: null, placements: args.placements.slice(1).map(p => ({ ...p, keep: KEEP })) })],
    ['名前が違う', args => ({ ok: true, refusal: null, placements: args.placements.map(p => ({ bucket: 'other', prefix: p.prefix, keep: KEEP })) })],
    ['prefix が違う', args => ({ ok: true, refusal: null, placements: args.placements.map(p => ({ bucket: p.bucket, prefix: 'x/', keep: KEEP })) })],
    ['keep の形が違う（理由が読めない）', args => ({ ok: true, refusal: null, placements: args.placements.map(p => ({ ...p, keep: { risk: 'maybe', folders: ['c'] } })) })],
    ['keep の twin でフォルダが空', args => ({ ok: true, refusal: null, placements: args.placements.map(p => ({ ...p, keep: { risk: 'twin', folders: [] } })) })],
    ['断りの形が違う', args => ({ ok: true, refusal: 5, placements: args.placements.map(p => ({ ...p, keep: KEEP })) })],
    ['placements が配列でない', () => ({ ok: true, refusal: null, placements: 'x' })],
    ['答えを読む途中で投げる（項目の読み取りが失敗する形の答え）', args => ({ ok: true, placements: args.placements.map(p => ({ ...p, keep: KEEP })), get refusal(): never { throw new Error('読めない答え（テスト）') } })],
  ]

  it.each(UNREADABLE)('★★★ %s → keep は1つも付かず、材料は「口が無い」ときと同じ。plan は残りの段を足す', async (_name, tw) => {
    install({ env: [A, B], record: [A, B], twinFacts: 'absent' })
    const base = await readProjectDeleteFacts(DIR)
    install({ env: [A, B], record: [A, B], twinFacts: tw })
    const f = await readProjectDeleteFacts(DIR)
    expect(f).toEqual(base)
    expect(f.placements.some(p => 'keep' in p)).toBe(false)
    expect(f.sharedLeftover!.placements.some(p => 'keep' in p)).toBe(false)
    expect(planProjectDeleteTeardown(f)).toMatchObject({ teardown: ['sakura-apprun'], leftover: { noun: '保存場所' } })
  })

  it('★★★ 部分的に信じない: 1件でも答えがおかしければ、ほかの件の keep も付けない', async () => {
    install({ env: [A, B], record: [A, B], twinFacts: args => ({ ok: true, refusal: null, placements: args.placements.map((p, i) => ({ ...p, keep: i === 0 ? KEEP : { risk: 'bad', folders: [] } })) }) })
    const f = await readProjectDeleteFacts(DIR)
    expect(f.placements.some(p => 'keep' in p)).toBe(false)
    expect(planProjectDeleteTeardown(f).teardown).toEqual(['sakura-apprun'])
  })

  it('★★ window が無い回も投げない（公開の記録は読めなかった扱い）', async () => {
    delete (globalThis as any).window
    await expect(readProjectDeleteFacts(DIR)).resolves.toMatchObject({ unreadable: true, placements: [], sharedLeftover: null })
  })
})
