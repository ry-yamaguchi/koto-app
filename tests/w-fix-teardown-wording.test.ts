import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { manualTeardownGuide } from '../src/shared/teardownSupport'

// ── W-79（2026-09-27決定）: Vercel の破棄の案内は、番号で分けて「Vercel のプロジェクトを削除」と「鍵を削除」を書く ──
// ── W-43（同）: セキュリティチェックの説明は「全部」と言い切らず、使い方ガイドと同じ「原則すべて…名前を出します」──
//
// 既存の teardownSupport.test.ts は 'koto-'・'_vercel'・'オブジェクトストレージ'・'コントロールパネル' の
// toContain だけで、①② の番号分けも「Vercel のプロジェクトを削除」も見ていなかった。旧文に戻しても
// 全部通ってしまう（検分の変異で確認）。manualTeardownGuide は純関数なので、文面を直に固定する。

describe('W-79: manualTeardownGuide(vercel) は①②で分け、削除するものを取り違えさせない', () => {
  const g = manualTeardownGuide('vercel')

  it('★ ①は Vercel のダッシュボードで「Vercel のプロジェクトを削除」', () => {
    const i1 = g.indexOf('①')
    expect(i1).toBeGreaterThanOrEqual(0)
    const step1 = g.slice(i1, g.indexOf('②'))
    expect(step1).toContain('Vercel のダッシュボード')
    expect(step1).toContain('Vercel のプロジェクトを削除')
  })

  it('★ ②はさくらのクラウドのコントロールパネルで鍵を削除し、括弧は「オブジェクトストレージのパーミッション」', () => {
    const i2 = g.indexOf('②')
    expect(i2).toBeGreaterThanOrEqual(0)
    const step2 = g.slice(i2)
    expect(step2).toContain('さくらのクラウドのコントロールパネル')
    expect(step2).toContain('koto-<プロジェクト名>_vercel')
    expect(step2).toContain('を削除')
    expect(step2).toContain('（オブジェクトストレージのパーミッション）')
  })

  it('★ ①が②より先にあり、番号は2つだけ（3つ目を勝手に増やさない）', () => {
    expect(g.indexOf('①')).toBeLessThan(g.indexOf('②'))
    expect(g).not.toContain('③')
    expect(g.match(/[①②③④⑤]/g)).toHaveLength(2)
  })

  it('Koto からは消せないと先に断る', () => {
    expect(g.startsWith('Koto からは消せません')).toBe(true)
  })
})

describe('W-43: セキュリティチェックの説明は「全部」と言い切らない', () => {
  const src = readFileSync(join(__dirname, '..', 'src/renderer/components/SecurityCheckSection.tsx'), 'utf-8')

  it('★ 「原則すべて確認します（…確認しきれなかったファイルは、結果に名前を出します）」の1文になっている', () => {
    expect(src).toContain(
      '公開されるファイルを、原則すべて確認します（量が多いときは何回かに分けます。確認しきれなかったファイルは、結果に名前を出します）。',
    )
  })

  it('★ 旧文の「全部確認します」に戻っていない', () => {
    expect(src).not.toContain('全部確認します')
  })
})
