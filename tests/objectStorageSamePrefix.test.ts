import { describe, it, expect } from 'vitest'
import { teardownPlanFor, type StoragePlacement, type BucketRecordUsers } from '../src/shared/objectStorage'
import { storageTeardownDoneLine } from '../src/shared/teardownSupport'

// ── T-I1: 同じ prefix の複製がいれば、データにもバケットにも手を付けない（0.6.24 I-1・docs/v0624-aefi-spec.md）────────────────
// フォルダを複製すると、複製は元と同じバケット・同じ prefix を記録に持つ（env.json の同意済み・state.json の bucket 資源）。
// 複製のどちらかを破棄すると、これまでは **もう一方のデータが prefix ごと消え**、ほかに使う人がいなければ**バケットごと消えた**
// （元が「用意しただけ」で公開していなければ、使用者とも数えられなかった＝H7）。
// ここは判断の純関数 `teardownPlanFor` を固定する。記録から samePrefix を作る側は tests/bucketUsersSamePrefix.test.ts、
// 3つの破棄と公開の apply を通した「要求の一覧」は tests/samePrefixTeardown.test.ts。

const MINE = ['projects/myapp/.koto-keep', 'projects/myapp/data.json']
const OTHERS = ['projects/other/.koto-keep']
const shared: StoragePlacement = { bucket: 'koto-data-x', prefix: 'projects/myapp/', shared: true }
const dedicated: StoragePlacement = { bucket: 'koto-myapp', prefix: 'projects/myapp/', shared: false }
const NOTE = 'フォルダ『myapp copy』も同じデータを使っています。'

const known = (samePrefix: string[], users: string[] = []): BucketRecordUsers => ({ known: true, users, samePrefix, samePrefixUnread: [], samePrefixChecked: true })
const unknown = (samePrefix: string[]): BucketRecordUsers => ({ known: false, samePrefix, samePrefixUnread: [], samePrefixChecked: true })

/** データにもバケットにも手を付けない、守りの形（キーを消さない・バケットを消さない・「データを残した」印・理由は「ほかのフォルダも使っている」）。 */
const KEPT = {
  deleteBucket: false,
  deletePrefix: null,
  keptData: true,
  keptReasons: { ownFiles: false, usedByOthers: true },
}

describe('★★★ teardownPlanFor: samePrefix が1件でもあれば、キーも消さず、バケットも消さない', () => {
  it('共有・専用のどちらでも: deletePrefix は null・deleteBucket は false・keptData は true。note は複製のフォルダ名を言う', () => {
    for (const p of [shared, dedicated]) {
      const t = teardownPlanFor(p, MINE, known(['myapp copy']))
      expect(t, p.bucket).toEqual({ ...KEPT, note: NOTE })
    }
  })

  it('★★★ キーの一覧が自分の prefix だけで、ほかに使う人が誰もいなくても残す（元が「用意しただけ」の複製 = H7。以前はバケットごと消えた）', () => {
    // 同じ条件で samePrefix が空なら、バケットごと消す（残して課金を続けさせない）。違いは samePrefix だけ
    expect(teardownPlanFor(shared, MINE, known([])).deleteBucket).toBe(true)
    expect(teardownPlanFor(shared, MINE, known(['myapp copy'])).deleteBucket).toBe(false)
  })

  it('★★★ 順序: projects/ の外のキー（利用者のファイル）があっても、ほかの prefix があっても、同じ守りの形（foreign・usedByOthers より前に見る）', () => {
    for (const p of [shared, dedicated]) {
      const withForeign = teardownPlanFor(p, [...MINE, 'わたしの大事な資料.pdf'], known(['myapp copy']))
      expect(withForeign, p.bucket).toEqual({ ...KEPT, note: NOTE }) // deletePrefix は null のまま（foreign の回なら自分の prefix を渡していた）・ownFiles も false
      const withOthers = teardownPlanFor(p, [...MINE, ...OTHERS], known(['myapp copy'], ['rc1-shared']))
      expect(withOthers, p.bucket).toEqual({ ...KEPT, note: NOTE })
    }
  })

  it('★★ 記録を読めなかった（known:false）回でも、見つかった複製は守る（見つかった事実は動かない）', () => {
    for (const p of [shared, dedicated]) {
      expect(teardownPlanFor(p, MINE, unknown(['myapp copy'])), p.bucket).toEqual({ ...KEPT, note: NOTE })
    }
  })

  it('複製が複数なら、名前を並べて言う', () => {
    const t = teardownPlanFor(shared, MINE, known(['a copy', 'b']))
    expect(t.note).toBe('フォルダ『a copy』・『b』も同じデータを使っています。')
    expect(t.deletePrefix).toBeNull()
  })

  it('samePrefix が空なら、これまでの判断のまま（keptData は付かない）', () => {
    // 消す
    const del = teardownPlanFor(shared, MINE, known([]))
    expect(del.deleteBucket).toBe(true)
    expect(del.deletePrefix).toBe('projects/myapp/')
    expect('keptData' in del).toBe(false)
    // 利用者のファイルがある → 自分の prefix だけ消す（keptData ではない）
    const foreign = teardownPlanFor(shared, [...MINE, 'メモ.txt'], known([]))
    expect(foreign).toMatchObject({ deleteBucket: false, deletePrefix: 'projects/myapp/', keptReasons: { ownFiles: true, usedByOthers: false } })
    expect('keptData' in foreign).toBe(false)
    // ほかの利用者がいる → 自分の prefix だけ消す（keptData ではない）
    const used = teardownPlanFor(shared, MINE, known([], ['rc1-shared']))
    expect(used).toMatchObject({ deleteBucket: false, deletePrefix: 'projects/myapp/', keptReasons: { ownFiles: false, usedByOthers: true } })
    expect('keptData' in used).toBe(false)
    // 読めなかった → 自分の prefix だけ消す（keptData ではない）
    const unk = teardownPlanFor(shared, MINE, unknown([]))
    expect(unk).toMatchObject({ deleteBucket: false, deletePrefix: 'projects/myapp/', keptReasons: { ownFiles: false, usedByOthers: false } })
    expect('keptData' in unk).toBe(false)
  })

  it('★★★ samePrefix を渡し忘れた形（古い形・配列でない値）は「複製がいない」と読まない — バケットは消さない', () => {
    for (const bad of [undefined, null, 'myapp copy', 0]) {
      const rec = { known: true, users: [], samePrefix: bad } as unknown as BucketRecordUsers
      const t = teardownPlanFor(shared, MINE, rec)
      expect(t.deleteBucket, String(bad)).toBe(false)
      expect(t.keptReasons).toEqual({ ownFiles: false, usedByOthers: false }) // 「わからない」の形（使っているとは言わない）
    }
    // known:true で samePrefix の無い古い形そのもの
    const old = { known: true, users: [] } as unknown as BucketRecordUsers
    expect(teardownPlanFor(shared, MINE, old).deleteBucket).toBe(false)
  })
})

describe('storageTeardownDoneLine: データに手を付けなかった回は「削除しました」と言わない', () => {
  it('keptData が true のときだけ「データは残しました」。無い・false は今までの文', () => {
    expect(storageTeardownDoneLine('koto-x', NOTE, true)).toBe(`保存場所『koto-x』のデータは残しました — ${NOTE}`)
    expect(storageTeardownDoneLine('koto-x', '保存場所は残します。')).toBe('保存場所『koto-x』のデータを削除しました — 保存場所は残します。')
    expect(storageTeardownDoneLine('koto-x', '保存場所は残します。', false)).toBe('保存場所『koto-x』のデータを削除しました — 保存場所は残します。')
    expect(storageTeardownDoneLine('koto-x', '保存場所は残します。', undefined)).toBe('保存場所『koto-x』のデータを削除しました — 保存場所は残します。')
  })
})
