import { describe, it, expect } from 'vitest'

// ── 確認の「ほかの公開先」の例の表と、保存場所を使いうる公開先の唯一の定義（掟10）────────────────────────
// 「ほかの公開先の記録を読めなかった」注意の例（teardown/confirm.ts の STORAGE_USING_TARGETS）は、
// 保存場所を使いうる公開先の唯一の定義（publishRecord.ts の PUBLISH_TARGETS_USING_STORAGE）から作る。
// 0.6.22 段階3B-3 までは、専有型の手本の文（「HANAMII・共用型など」）に合わせて Vercel だけ入れていなかった
// （表は部分集合で、このテストが「Vercel だけ」に固定していた）。手本をこの部品へ載せ替える段階に入り、
// 表は定義と**ちょうど同じ**になった。新しい公開先を定義へ足すと、短い呼び名を書き下した下の表と食い違って落ちる。
import { STORAGE_USING_TARGETS } from '../src/renderer/teardown/confirm'
import { PUBLISH_TARGETS_USING_STORAGE } from '../src/renderer/publishRecord'
import { PUBLISH_TARGET_LABEL } from '../src/renderer/publishStatus'

describe('確認の例の表 と PUBLISH_TARGETS_USING_STORAGE', () => {
  it('★★ 例の表の公開先は、「保存場所を使いうる公開先」とちょうど同じ（過不足も並びも）。保存場所を使わない公開先を、使うと言わない', () => {
    expect(STORAGE_USING_TARGETS.map(([kind]) => kind)).toEqual([...PUBLISH_TARGETS_USING_STORAGE])
    expect(STORAGE_USING_TARGETS.map(([kind]) => kind)).not.toContain('sakura-rental')
  })

  it('★★ 例の表に無い「保存場所を使いうる公開先」は無い（Vercel も入っている）。新しい公開先を足したら、ここで落ちて呼び名を決める', () => {
    const inTable = new Set(STORAGE_USING_TARGETS.map(([kind]) => kind))
    expect(PUBLISH_TARGETS_USING_STORAGE.filter(kind => !inTable.has(kind))).toEqual([])
  })

  it('呼び名は書き下す（HANAMII・Vercel・共用型・専有型。並びは定義のまま）。表示名（絵文字つき）の代わりに短い呼び名で挙げる', () => {
    expect(STORAGE_USING_TARGETS.map(([kind, label]) => `${kind}=${label}`)).toEqual([
      'hanamii=HANAMII', 'vercel=Vercel', 'sakura-apprun=共用型', 'sakura-apprun-dedicated=専有型',
    ])
    // 表示名へ倒れていない（呼び名を足し忘れた公開先は、表示名で挙がる。それも落ちて気づく）
    for (const [kind, label] of STORAGE_USING_TARGETS) expect(label, kind).not.toBe(PUBLISH_TARGET_LABEL[kind])
  })
})
