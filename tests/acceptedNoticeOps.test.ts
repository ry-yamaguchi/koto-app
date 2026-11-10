import { describe, it, expect, beforeEach } from 'vitest'
import { withProjectLock } from '../src/main/projectLock'
import { getOps, resetProjectOpsForTests, type OpTarget, type ProjectOp } from '../src/main/projectOps'
import { withoutAcceptedNotice } from '../src/main/stoppedOps'

// ── このテストが固定すること（上部の「途中です」を、利用者が何もしなくても外す）──────────────────────────────
// HANAMII の破棄が**済んだ**（ok:true）回が終わったとき、同じプロジェクトの、それより前の見られていない HANAMII の破棄のうち
// 「受け付けただけ」（deletionAccepted）の結果を外す。続きで済んだ回も、手での押し直しで済んだ回も同じこの1か所（projectOps.finishOp）を通る。
// 外さない: 別のプロジェクト・別の公開先・別の種類（op）・まだ済んでいない回が終わったとき・「受け付けただけ」でない結果。
// 本物の projectOps（withProjectLock の中で beginOp → finishOp）に流して、`getOps` の見られていない記録で見る。

beforeEach(() => resetProjectOpsForTests())

const ACCEPTED = { ok: false, appDeleted: false, deletionAccepted: true, message: 'まだ済んでいません' }
const DONE = { ok: true, appDeleted: true }
const FAILED = { ok: false, message: '削除に失敗しました（HTTP 500）' }

async function run(dir: string, op: ProjectOp, target: OpTarget, value: unknown): Promise<void> {
  await withProjectLock(dir, op, async () => value, { target, handler: `${target}:test` })
}
const unseenOf = (dir: string) => { const s = getOps(dir); return [...s.earlier, ...(s.last ? [s.last] : [])] }
const acceptedLeft = (dir: string) => unseenOf(dir).filter(r => r.result?.extra?.deletionAccepted === true)

describe('★★★ 済んだ回が終わると、前の「受け付けただけ」を外す', () => {
  it('★★★ 受け付けただけ → 済んだ: 「途中」の記録が見られていない記録から消え、済んだ回だけが残る', async () => {
    await run('/tmp/p-a', '削除', 'hanamii', ACCEPTED)
    expect(acceptedLeft('/tmp/p-a')).toHaveLength(1)
    await run('/tmp/p-a', '削除', 'hanamii', DONE)
    expect(acceptedLeft('/tmp/p-a'), '前の「途中」が残っている').toEqual([])
    expect(unseenOf('/tmp/p-a')).toHaveLength(1)
    expect(getOps('/tmp/p-a').last?.result?.ok).toBe(true)
  })

  it('★★★ 受け付けただけが2回続いたあと済んだ → 両方外れる', async () => {
    await run('/tmp/p-b', '削除', 'hanamii', ACCEPTED)
    await run('/tmp/p-b', '削除', 'hanamii', ACCEPTED)
    await run('/tmp/p-b', '削除', 'hanamii', DONE)
    expect(acceptedLeft('/tmp/p-b')).toEqual([])
  })

  it('★★★ まだ済んでいない回（受け付けただけ・失敗）が終わっても、前の「途中」は外さない', async () => {
    await run('/tmp/p-c', '削除', 'hanamii', ACCEPTED)
    await run('/tmp/p-c', '削除', 'hanamii', ACCEPTED)
    expect(acceptedLeft('/tmp/p-c')).toHaveLength(2)
    await run('/tmp/p-c', '削除', 'hanamii', FAILED)
    expect(acceptedLeft('/tmp/p-c')).toHaveLength(2)
  })

  it('★★★ 別のプロジェクトの「途中」は外さない（掟11）', async () => {
    await run('/tmp/p-d1', '削除', 'hanamii', ACCEPTED)
    await run('/tmp/p-d2', '削除', 'hanamii', DONE)
    expect(acceptedLeft('/tmp/p-d1')).toHaveLength(1)
  })

  it('★★★ 別の公開先の記録は外さない（HANAMII の破棄が済んでも、共用型の記録は残る）。別の公開先の破棄が済んでも HANAMII の「途中」は残る', async () => {
    await run('/tmp/p-e', '削除', 'sakura-apprun', ACCEPTED) // 形が似ていても、公開先が違う
    await run('/tmp/p-e', '削除', 'hanamii', DONE)
    expect(acceptedLeft('/tmp/p-e')).toHaveLength(1)
    await run('/tmp/p-e2', '削除', 'hanamii', ACCEPTED)
    await run('/tmp/p-e2', '削除', 'sakura-apprun', DONE)
    expect(acceptedLeft('/tmp/p-e2')).toHaveLength(1)
  })

  it('★★★ 別の種類（公開）の記録は外さない', async () => {
    await run('/tmp/p-f', '公開', 'hanamii', ACCEPTED)
    await run('/tmp/p-f', '削除', 'hanamii', DONE)
    expect(acceptedLeft('/tmp/p-f')).toHaveLength(1)
  })

  it('★★ 「受け付けただけ」でない前の記録（失敗・済んだ）は、この関数が外さない', async () => {
    await run('/tmp/p-g', '削除', 'hanamii', FAILED)
    await run('/tmp/p-g', '削除', 'hanamii', DONE)
    expect(unseenOf('/tmp/p-g')).toHaveLength(2)
  })
})

describe('withoutAcceptedNotice（純関数）', () => {
  const rec = (over: Record<string, unknown>, startedAt: number, extra: Record<string, unknown> = {}): any => ({
    op: '削除', target: 'hanamii', handler: 'x', startedAt, running: false, progress: { label: '', detail: '', at: 0 }, seen: false,
    result: { ok: false, lines: [], warnings: [], extra },
    ...over,
  })
  it('★★ あとから始まった回の結果は外さない（finished より前に始まったものだけ）', () => {
    const finished = rec({ result: { ok: true, lines: [], warnings: [], extra: {} } }, 10)
    const earlier = rec({}, 5, { deletionAccepted: true })
    const later = rec({}, 20, { deletionAccepted: true })
    expect(withoutAcceptedNotice([earlier, later], finished)).toEqual([later])
  })
  it('★★ 済んでいない finished・HANAMII でない finished では何も外さない。引数の一覧は変えない', () => {
    const earlier = rec({}, 5, { deletionAccepted: true })
    const list = [earlier]
    expect(withoutAcceptedNotice(list, rec({ result: { ok: false, lines: [], warnings: [], extra: {} } }, 10))).toEqual([earlier])
    expect(withoutAcceptedNotice(list, rec({ target: 'vercel', result: { ok: true, lines: [], warnings: [], extra: {} } }, 10))).toEqual([earlier])
    expect(withoutAcceptedNotice(list, rec({ result: undefined }, 10))).toEqual([earlier])
    expect(list).toEqual([earlier])
  })
})
