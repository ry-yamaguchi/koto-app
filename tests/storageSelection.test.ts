import { describe, it, expect } from 'vitest'
import { parseShownPlacements, selectShown, skippedBucketsMessage, uniqueBuckets } from '../src/main/cloud/storageSelection'

// ── T-F2・F3・F4（0.6.24 F-3）: main の純関数。確認で見せた保存場所（名前と prefix の組）だけを消す ──────────────
// 仕様: docs/v0624-aefi-spec.md の F-3・T-F2〜F4。
//   ・parseShownPlacements: 配列で、どの要素も bucket と prefix が文字列のときだけ通す。それ以外は null（＝1件も見せていない）
//   ・selectShown: 名前と prefix の**両方**が一致したものだけ tear。残りは skipped。why は、見せた一覧が空なら unnamed・空でなければ changed
// 呼び手（storageForTarget.ts）が外へ要求を出さないことは tests/sharedShownTeardown.test.ts が、偽 client の要求の一覧で固定する。

const P = (bucket: string, prefix = 'projects/myapp/', shared = true) => ({ bucket, prefix, shared })

describe('parseShownPlacements: 形が違えば null（「全部見せた」に倒さない）', () => {
  it('★ 正しい形は通す。余計な項目は運ばない（bucket と prefix だけに作り直す）', () => {
    expect(parseShownPlacements([{ bucket: 'a', prefix: 'p/' }, { bucket: 'b', prefix: '' }])).toStrictEqual([{ bucket: 'a', prefix: 'p/' }, { bucket: 'b', prefix: '' }])
    expect(parseShownPlacements([{ bucket: 'a', prefix: 'p/', shared: false, extra: 1 }])).toStrictEqual([{ bucket: 'a', prefix: 'p/' }])
  })

  it('空の配列は []（見せたものが無い。null ではない）', () => {
    expect(parseShownPlacements([])).toStrictEqual([])
  })

  it.each([
    ['undefined（渡し忘れ）', undefined],
    ['null', null],
    ['文字列', 'koto-data-a'],
    ['数', 1],
    ['配列でないオブジェクト', { bucket: 'a', prefix: 'p/' }],
    ['要素が null', [null]],
    ['要素が文字列', ['koto-data-a']],
    ['要素に prefix が無い', [{ bucket: 'a' }]],
    ['要素に bucket が無い', [{ prefix: 'p/' }]],
    ['prefix が文字列でない', [{ bucket: 'a', prefix: 1 }]],
    ['bucket が文字列でない', [{ bucket: 1, prefix: 'p/' }]],
    ['prefix が null', [{ bucket: 'a', prefix: null }]],
    ['1件目は正しく、2件目が壊れている（1件でも壊れていれば全体を通さない）', [{ bucket: 'a', prefix: 'p/' }, { bucket: 'b' }]],
    // eslint-disable-next-line no-sparse-arrays
    ['空き要素のある配列', [{ bucket: 'a', prefix: 'p/' }, , { bucket: 'b', prefix: 'p/' }]],
  ])('%s → null', (_name, x) => {
    expect(parseShownPlacements(x)).toBeNull()
  })
})

describe('selectShown: 名前と prefix の両方が一致したものだけを消す', () => {
  it('T-F4 見せたほうが多い（B1・B2 を見せて、いまは B1）→ B1 だけ。飛ばすものは無く、why は null', () => {
    const r = selectShown([P('b1')], [{ bucket: 'b1', prefix: 'projects/myapp/' }, { bucket: 'b2', prefix: 'projects/myapp/' }])
    expect(r).toStrictEqual({ tear: [P('b1')], skipped: [], why: null })
  })

  it('★ 確認のあとで足された保存場所（見せた一覧に無い）は飛ばす。why は changed。残りの並びは current のまま', () => {
    const r = selectShown([P('b1'), P('b2'), P('b3')], [{ bucket: 'b1', prefix: 'projects/myapp/' }, { bucket: 'b3', prefix: 'projects/myapp/' }])
    expect(r.tear).toStrictEqual([P('b1'), P('b3')])
    expect(r.skipped).toStrictEqual([P('b2')])
    expect(r.why).toBe('changed')
  })

  it('★ T-F3 同じバケットで prefix が違えば飛ばす（バケット名だけで突き合わせない）', () => {
    const r = selectShown([P('b1', 'projects/myapp/')], [{ bucket: 'b1', prefix: 'projects/other/' }])
    expect(r.tear).toStrictEqual([])
    expect(r.skipped).toStrictEqual([P('b1', 'projects/myapp/')])
    expect(r.why).toBe('changed')
  })

  it('prefix が空（専用バケット）同士は一致する。空と空でない prefix は一致しない', () => {
    expect(selectShown([P('b1', '', false)], [{ bucket: 'b1', prefix: '' }]).tear).toHaveLength(1)
    expect(selectShown([P('b1', '', false)], [{ bucket: 'b1', prefix: 'projects/myapp/' }]).tear).toHaveLength(0)
    expect(selectShown([P('b1', 'projects/myapp/')], [{ bucket: 'b1', prefix: '' }]).tear).toHaveLength(0)
  })

  it('大文字小文字・末尾のスラッシュの違いは別のものとして扱う（正規化して広げない）', () => {
    expect(selectShown([P('b1', 'projects/myapp/')], [{ bucket: 'B1', prefix: 'projects/myapp/' }]).tear).toHaveLength(0)
    expect(selectShown([P('b1', 'projects/myapp/')], [{ bucket: 'b1', prefix: 'projects/myapp' }]).tear).toHaveLength(0)
  })

  it('★ 見せた一覧が空・null（名前を挙げられなかった・形が違う）→ 全件を飛ばす。why は unnamed', () => {
    for (const shown of [[], null]) {
      const r = selectShown([P('b1'), P('b2')], shown)
      expect(r.tear).toStrictEqual([])
      expect(r.skipped).toStrictEqual([P('b1'), P('b2')])
      expect(r.why).toBe('unnamed')
    }
  })

  it('消す側の項目（shared など）は current のものを使う。画面が運んだ値では変えられない', () => {
    const r = selectShown([P('b1', 'projects/myapp/', true)], [{ bucket: 'b1', prefix: 'projects/myapp/', shared: false } as any])
    expect(r.tear).toStrictEqual([{ bucket: 'b1', prefix: 'projects/myapp/', shared: true }])
  })

  it('いまの保存場所が無ければ、飛ばすものも無い（見せた一覧が空でも why は null）', () => {
    expect(selectShown([], [])).toStrictEqual({ tear: [], skipped: [], why: null })
    expect(selectShown([], null)).toStrictEqual({ tear: [], skipped: [], why: null })
  })

  it('同じ組が current に2つあれば、両方とも tear（見せた組と一致するものは全部）', () => {
    const r = selectShown([P('b1'), P('b1')], [{ bucket: 'b1', prefix: 'projects/myapp/' }])
    expect(r.tear).toHaveLength(2)
  })
})

describe('飛ばした理由の文と、バケット名の並べ方', () => {
  it('changed: 確認のあとで記録が変わった。名前は『』で囲む', () => {
    expect(skippedBucketsMessage([P('koto-data-b')], 'changed')).toBe('確認のあとで保存場所の記録が変わったため、保存場所『koto-data-b』は削除していません。')
  })

  it('unnamed: 確認が名前を挙げられなかった', () => {
    expect(skippedBucketsMessage([P('koto-data-b')], 'unnamed')).toBe('確認で保存場所の名前を挙げられなかったため、保存場所『koto-data-b』は削除していません。')
  })

  it('同じバケットの別の prefix は1つの名前にまとめる。複数は並べる', () => {
    expect(skippedBucketsMessage([P('a', 'x/'), P('a', 'y/'), P('b')], 'changed')).toContain('保存場所『a』『b』は')
    expect(uniqueBuckets([P('a', 'x/'), P('b'), P('a', 'y/')])).toStrictEqual(['a', 'b'])
  })
})
