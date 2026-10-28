import { describe, it, expect } from 'vitest'
import { twinRiskOf, teardownPlanFor, type StoragePlacement, type BucketRecordUsers } from '../src/shared/objectStorage'
import { storageTeardownDoneLine } from '../src/shared/teardownSupport'

// ── T-R1b-1: 複製（または複製かもしれないもの）がいるかの判断 `twinRiskOf` の表（0.6.24 R1-b・作者の決定 K3）────────────────
// 'twin'   … samePrefix が1件以上（I-1）
// 'unread' … 確かめられなかった（samePrefixChecked が true でない・samePrefixUnread が配列でない／1件以上）。**渡し忘れ・古い形も unread**（不明を肯定にしない）
// null     … 確かめられて、複製はいない
// 判断の1か所がこれ。teardownPlanFor（データを残す）も、鍵に触るかの判断（tests/twinKeysUntouched.test.ts）も、これを見る。

const form = (known: boolean, f: { samePrefix?: unknown; samePrefixUnread?: unknown; samePrefixChecked?: unknown }): BucketRecordUsers =>
  ({ known, ...(known ? { users: [] } : {}), ...f }) as unknown as BucketRecordUsers

describe('★★★ twinRiskOf の表', () => {
  it('samePrefix が1件以上 → twin（known の true・false・確かめ済みか・読めない兄弟の有無によらない）', () => {
    for (const known of [true, false]) {
      for (const checked of [true, false]) {
        for (const unread of [[], ['broken']]) {
          expect(twinRiskOf(form(known, { samePrefix: ['copy'], samePrefixUnread: unread, samePrefixChecked: checked })), `known:${known} checked:${checked} unread:${unread.length}`).toBe('twin')
        }
      }
    }
  })

  it('★★★ twin でなく、読めない兄弟がいる（samePrefixUnread が1件以上）→ unread（known の true・false どちらでも）', () => {
    for (const known of [true, false]) {
      expect(twinRiskOf(form(known, { samePrefix: [], samePrefixUnread: ['broken-env'], samePrefixChecked: true })), `known:${known}`).toBe('unread')
      expect(twinRiskOf(form(known, { samePrefix: [], samePrefixUnread: ['a', 'b'], samePrefixChecked: true })), `known:${known}`).toBe('unread')
    }
  })

  it('★★★ 確かめ自体ができなかった（samePrefixChecked が false）→ unread。読めない兄弟の名前が無くても', () => {
    for (const known of [true, false]) {
      expect(twinRiskOf(form(known, { samePrefix: [], samePrefixUnread: [], samePrefixChecked: false })), `known:${known}`).toBe('unread')
    }
  })

  it('★★★ 渡し忘れ・古い形・配列でない値は unread（「複製はいない」と読まない）', () => {
    // samePrefixChecked が無い・true 以外
    for (const bad of [undefined, null, 'true', 1, 0, {}]) {
      expect(twinRiskOf(form(true, { samePrefix: [], samePrefixUnread: [], samePrefixChecked: bad })), `checked:${String(bad)}`).toBe('unread')
    }
    // samePrefixUnread が無い・配列でない
    for (const bad of [undefined, null, 'broken', 0, {}]) {
      expect(twinRiskOf(form(true, { samePrefix: [], samePrefixUnread: bad, samePrefixChecked: true })), `unread:${String(bad)}`).toBe('unread')
    }
    // samePrefix が無い・配列でない
    for (const bad of [undefined, null, 'copy', 0]) {
      expect(twinRiskOf(form(true, { samePrefix: bad, samePrefixUnread: [], samePrefixChecked: true })), `samePrefix:${String(bad)}`).toBe('unread')
    }
    // 古い形そのもの（0.6.24 U1 の形・それより前の形）
    expect(twinRiskOf({ known: true, users: [], samePrefix: [] } as unknown as BucketRecordUsers)).toBe('unread')
    expect(twinRiskOf({ known: true, users: [] } as unknown as BucketRecordUsers)).toBe('unread')
    expect(twinRiskOf({ known: false } as unknown as BucketRecordUsers)).toBe('unread')
    // そもそも渡されなかった
    expect(twinRiskOf(undefined as unknown as BucketRecordUsers)).toBe('unread')
    expect(twinRiskOf(null as unknown as BucketRecordUsers)).toBe('unread')
  })

  it('★★★ 確かめられて、複製も読めない兄弟もいない → null（known の true・false どちらでも。.sakuraide.json だけ読めない兄弟の known:false はここ）', () => {
    for (const known of [true, false]) {
      expect(twinRiskOf(form(known, { samePrefix: [], samePrefixUnread: [], samePrefixChecked: true })), `known:${known}`).toBeNull()
    }
  })
})

describe('★★★ teardownPlanFor: unread → データにもバケットにも手を付けない', () => {
  const shared: StoragePlacement = { bucket: 'koto-data-x', prefix: 'projects/myapp/', shared: true }
  const dedicated: StoragePlacement = { bucket: 'koto-myapp', prefix: 'projects/myapp/', shared: false }
  const MINE = ['projects/myapp/.koto-keep', 'projects/myapp/data.json']
  const OTHERS = ['projects/other/.koto-keep']
  const UNREAD_KEPT = { deleteBucket: false, deletePrefix: null, keptData: true, keptReasons: { ownFiles: false, usedByOthers: false } }

  it('名前があるとき: 「フォルダ『X』（・『Y』）の記録を読めないため、同じデータを使っているか確かめられませんでした。」。共有・専用のどちらでも', () => {
    for (const p of [shared, dedicated]) {
      expect(teardownPlanFor(p, MINE, { known: false, samePrefix: [], samePrefixUnread: ['broken'], samePrefixChecked: true }), p.bucket)
        .toEqual({ ...UNREAD_KEPT, note: 'フォルダ『broken』の記録を読めないため、同じデータを使っているか確かめられませんでした。' })
      expect(teardownPlanFor(p, MINE, { known: true, users: [], samePrefix: [], samePrefixUnread: ['a copy', 'b'], samePrefixChecked: true }).note, p.bucket)
        .toBe('フォルダ『a copy』・『b』の記録を読めないため、同じデータを使っているか確かめられませんでした。')
    }
  })

  it('名前が無いとき（確かめ自体ができなかった）: 「ほかのフォルダの記録を読めないため、…」', () => {
    for (const p of [shared, dedicated]) {
      expect(teardownPlanFor(p, MINE, { known: false, samePrefix: [], samePrefixUnread: [], samePrefixChecked: false }), p.bucket)
        .toEqual({ ...UNREAD_KEPT, note: 'ほかのフォルダの記録を読めないため、同じデータを使っているか確かめられませんでした。' })
    }
  })

  it('★★★ 渡し忘れ・古い形も同じ（unread）。記録の上では誰も使っていなくても、バケットごと消さない', () => {
    for (const rec of [undefined, { known: true, users: [], samePrefix: [] }, { known: true, users: [] }] as unknown[]) {
      const t = teardownPlanFor(shared, MINE, rec as BucketRecordUsers)
      expect(t, JSON.stringify(rec)).toMatchObject(UNREAD_KEPT)
      expect(t.note).toBe('ほかのフォルダの記録を読めないため、同じデータを使っているか確かめられませんでした。')
    }
  })

  it('★★★ 順序: projects/ の外のキー・ほかの prefix・使っている兄弟があっても、unread の形（twin と同じく foreign・usedByOthers より前に見る）', () => {
    const unread: BucketRecordUsers = { known: true, users: ['rc1-shared'], samePrefix: [], samePrefixUnread: ['broken'], samePrefixChecked: true }
    for (const p of [shared, dedicated]) {
      expect(teardownPlanFor(p, [...MINE, 'わたしの大事な資料.pdf'], unread), p.bucket).toMatchObject(UNREAD_KEPT)
      expect(teardownPlanFor(p, [...MINE, ...OTHERS], unread), p.bucket).toMatchObject(UNREAD_KEPT)
    }
  })

  it('★★★ twin が先: 複製が見つかっていれば、読めない兄弟がいても twin の文（複製のフォルダ名）', () => {
    const t = teardownPlanFor(shared, MINE, { known: false, samePrefix: ['myapp copy'], samePrefixUnread: ['broken'], samePrefixChecked: true })
    expect(t).toEqual({ deleteBucket: false, deletePrefix: null, keptData: true, keptReasons: { ownFiles: false, usedByOthers: true }, note: 'フォルダ『myapp copy』も同じデータを使っています。' })
  })

  it('★★★ 対照（確かめられて null）: known:false でも、.sakuraide.json だけ読めない回は今どおり。自分の prefix を消し、バケットは残す（keptData は付かない）', () => {
    const t = teardownPlanFor(shared, MINE, { known: false, samePrefix: [], samePrefixUnread: [], samePrefixChecked: true })
    expect(t).toMatchObject({ deleteBucket: false, deletePrefix: 'projects/myapp/', keptReasons: { ownFiles: false, usedByOthers: false }, note: '保存場所は残します。' })
    expect('keptData' in t).toBe(false)
    // 確かめられて null・使っている兄弟もいない → バケットごと消す
    const del = teardownPlanFor(shared, MINE, { known: true, users: [], samePrefix: [], samePrefixUnread: [], samePrefixChecked: true })
    expect(del).toMatchObject({ deleteBucket: true, deletePrefix: 'projects/myapp/' })
    expect('keptData' in del).toBe(false)
  })

  it('結果の行は、既存の storageTeardownDoneLine で「データは残しました — …」になる', () => {
    const t = teardownPlanFor(shared, MINE, { known: false, samePrefix: [], samePrefixUnread: ['broken'], samePrefixChecked: true })
    expect(storageTeardownDoneLine('koto-data-x', t.note, t.keptData)).toBe(
      '保存場所『koto-data-x』のデータは残しました — フォルダ『broken』の記録を読めないため、同じデータを使っているか確かめられませんでした。',
    )
  })
})
