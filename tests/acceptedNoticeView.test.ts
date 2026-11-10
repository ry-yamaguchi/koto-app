import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { isHanamiiAcceptedNotice, settlesAcceptedNotice } from '../src/shared/inFlightOps'
import { withoutSettledAccepted } from '../src/renderer/projectOpsView'

// ── このテストが固定すること（HANAMII の破棄の「途中」を、開いている画面からも自動で外す）──────────────────────
// main は、あとの破棄（自動の続き・押し直し）が済んだ回に、前の「受け付けただけ」（途中）を見られていない記録から外す（stoppedOps.ts）。
// だが【公開】の上部のカード（PublishModal の heldResults）と HANAMII の画面の結果（useProjectOpsView の shown）は、開いている間は
// 届いた結果を手元に溜めるだけで、main から消えたものを外さなかった。そのため、続きが済んでも、開き直すか「結果を確認しました」を
// 押すまで「途中」が残った（作者の依頼「途中ですのメッセージも自動的に無くなるように」に届かない）。
//   ・判定は shared の settlesAcceptedNotice の1つ（main と画面が同じこれを通る）
//   ・外すのは「あとの破棄が済んだ記録が見えた」ときだけ。写しに「途中」が見当たらないことは根拠にしない
//     （テストの偽の世界のように押し出しが遅れて届くと、古い写しが新しい写しのあとに来る。見逃してはいけない知らせを隠さない）
//   ・2つの溜め場所が、新しい写しを受けるたびに通る（呼び出しの形ごと見る・直す前の形を禁じる）

type Rec = { startedAt: number; target?: string; op?: string; handler?: string; result?: any }
const accepted = (startedAt: number, target = 'hanamii'): Rec =>
  ({ startedAt, target, op: '削除', handler: 'hanamii:teardown', result: { ok: false, warnings: ['途中'], extra: { deletionAccepted: true } } })
const done = (startedAt: number): Rec =>
  ({ startedAt, target: 'hanamii', op: '削除', handler: 'hanamii:resumeTeardown', result: { ok: true, warnings: [], extra: {} } })
const otherWarning = (startedAt: number): Rec =>
  ({ startedAt, target: 'sakura-apprun', op: '削除', handler: 'cloud:teardown', result: { ok: false, warnings: ['月額が続きます'], extra: {} } })

describe('★★★ isHanamiiAcceptedNotice（「途中」の判定は1つ）', () => {
  it.each([
    ['HANAMII の受け付けただけ', accepted(1), true],
    ['別の公開先の同じ印', accepted(1, 'sakura-apprun'), false],
    ['済んだ回', done(1), false],
    ['印が文字列の true', { startedAt: 1, target: 'hanamii', result: { extra: { deletionAccepted: 'true' } } }, false],
    ['extra が無い', { startedAt: 1, target: 'hanamii', result: { ok: false } }, false],
    ['result が無い', { startedAt: 1, target: 'hanamii' }, false],
    ['null', null, false],
    ['配列', [], false],
  ])('%s → %s', (_n, rec, want) => {
    expect(isHanamiiAcceptedNotice(rec)).toBe(want)
  })
})

describe('★★★ settlesAcceptedNotice（「途中」を済ませた記録か。main と画面が同じこれを通る）', () => {
  it.each([
    ['あとの済んだ回（自動の続き）', done(5), accepted(1), true],
    ['あとの済んだ回（押し直し）', { ...done(5), handler: 'hanamii:teardown' }, accepted(1), true],
    ['前に始まった済んだ回', done(1), accepted(5), false],
    ['同じ時刻', done(5), accepted(5), false],
    ['あとの回が済んでいない（また途中）', accepted(5), accepted(1), false],
    ['あとの回が失敗', { ...done(5), result: { ok: false } }, accepted(1), false],
    ['別の公開先の済んだ回', { ...done(5), target: 'sakura-apprun' }, accepted(1), false],
    ['別の種類（公開）の済んだ回', { ...done(5), op: '公開' }, accepted(1), false],
    ['外す側が「途中」でない', done(5), otherWarning(1), false],
    ['ok が文字列の true', { ...done(5), result: { ok: 'true' } }, accepted(1), false],
  ])('%s → %s', (_n, later, rec, want) => {
    expect(settlesAcceptedNotice(later, rec)).toBe(want)
  })
})

describe('★★★ withoutSettledAccepted（あとの破棄が済んだ「途中」を、開いた画面の手元からも外す）', () => {
  it('写しに済んだ回が届いたら、手元の「途中」を外す。ほかの結果は残す', () => {
    const held = [accepted(1), otherWarning(2)]
    expect(withoutSettledAccepted(held, [otherWarning(2), done(3)]).map(r => r.startedAt)).toEqual([2])
  })

  it('済んだ回が手元にあれば、写しから消えていても外す（済んだ回はパネルがすぐ「見た」にする）', () => {
    expect(withoutSettledAccepted([accepted(1), done(3)], []).map(r => r.startedAt)).toEqual([3])
  })

  it('★★★ 写しに「途中」が見当たらないだけでは外さない（遅れて届いた古い写しで、見逃してはいけない知らせを隠さない）', () => {
    const held = [accepted(1)]
    expect(withoutSettledAccepted(held, [])).toBe(held)
  })

  it('あとの回もまた途中（待ち切れなかった）なら、どちらも残す', () => {
    const held = [accepted(1), accepted(4)]
    expect(withoutSettledAccepted(held, [accepted(1), accepted(4)])).toBe(held)
  })

  it('済んだ回より、あとに始まった「途中」は残す', () => {
    expect(withoutSettledAccepted([done(3), accepted(5)], []).map(r => r.startedAt)).toEqual([3, 5])
  })

  it('外すものが無ければ同じ配列を返す（描き直さない）', () => {
    const held = [otherWarning(2), done(3)]
    expect(withoutSettledAccepted(held, [])).toBe(held)
    const empty: Rec[] = []
    expect(withoutSettledAccepted(empty, [accepted(1), done(3)])).toBe(empty)
  })
})

describe('★★★ 配線: 2つの溜め場所が、写しを受けるたびに通る', () => {
  const src = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf-8')

  it('【公開】の上部のカード（PublishModal の applyOps）', () => {
    const s = src('src/renderer/components/PublishModal.tsx')
    expect(s).toContain('setHeldResults(prev => withoutSettledAccepted(mergeFinished(prev, finished), finished))')
    // 直す前の形（新しく終わった分があるときだけ足す・外さない）
    expect(s).not.toContain('if (finished.length > 0) setHeldResults(prev => mergeFinished(prev, finished))')
  })

  it('HANAMII の画面の結果（useProjectOpsView の apply）', () => {
    const s = src('src/renderer/hooks/useProjectOpsView.ts')
    expect(s).toContain('setShown(prev => withoutSettledAccepted(prev, finished))')
  })

  it('main の「済んだ回に前の途中を外す」も同じ判定を通る', () => {
    const s = src('src/main/stoppedOps.ts')
    expect(s).toContain('return list.filter(r => !settlesAcceptedNotice(finished, r))')
    expect(s).not.toContain('r.result?.extra?.deletionAccepted === true')
  })
})
