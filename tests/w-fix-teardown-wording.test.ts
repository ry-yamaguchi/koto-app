import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { manualTeardownGuide } from '../src/shared/teardownSupport'

// ── W-79（2026-09-27決定）: Vercel の破棄の案内は、番号で分けて「Vercel のプロジェクトを削除」と「鍵を削除」を書く ──
// ── W-43（同）: セキュリティチェックの説明は「全部」と言い切らず、使い方ガイドと同じ「原則すべて…名前を出します」──
//
// 既存の teardownSupport.test.ts は 'koto-'・'_vercel'・'オブジェクトストレージ'・'コントロールパネル' の
// toContain だけで、(1)(2) の番号分けも「Vercel のプロジェクトを削除」も見ていなかった。旧文に戻しても
// 全部通ってしまう（検分の変異で確認）。manualTeardownGuide は純関数なので、文面を直に固定する。

describe('W-79: manualTeardownGuide(vercel) は(1)(2)で分け、削除するものを取り違えさせない', () => {
  const g = manualTeardownGuide('vercel')

  it('★ (1)は Vercel のダッシュボードで「Vercel のプロジェクトを削除」', () => {
    const i1 = g.indexOf('(1)')
    expect(i1).toBeGreaterThanOrEqual(0)
    const step1 = g.slice(i1, g.indexOf('(2)'))
    expect(step1).toContain('Vercel のダッシュボード')
    expect(step1).toContain('Vercel のプロジェクトを削除')
  })

  it('★ (2)はさくらのクラウドのコントロールパネルで、オブジェクトストレージのパーミッションを削除する（アクセスキーも一緒に無効になる）', () => {
    const i2 = g.indexOf('(2)')
    expect(i2).toBeGreaterThanOrEqual(0)
    const step2 = g.slice(i2)
    expect(step2).toContain('さくらのクラウドのコントロールパネル')
    expect(step2).toContain('koto-<プロジェクト名>_vercel')
    expect(step2).toContain('を削除')
    expect(step2).toContain('オブジェクトストレージのパーミッション「koto-<プロジェクト名>_vercel」を削除')
    expect(step2).toContain('アプリ用のアクセスキーも一緒に無効になります')
    // 0.6.21: 「鍵」のたとえは使わない（直す前は「鍵「koto-…」を削除（オブジェクトストレージのパーミッション）」）
    expect(step2).not.toContain('鍵')
  })

  it('★ (1)が(2)より先にあり、番号は2つだけ（3つ目を勝手に増やさない）', () => {
    expect(g.indexOf('(1)')).toBeLessThan(g.indexOf('(2)'))
    expect(g).not.toContain('(3)')
    expect(g.match(/\(\d\)/g)).toHaveLength(2)
    expect(g, '丸数字が戻っている（2026-10-07・作者の決定: 列挙は (1) (2)）').not.toMatch(/[①-⑳]/)
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
