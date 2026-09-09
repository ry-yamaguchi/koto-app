import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// roadmap #37: 2つの「戻す」の違いを画面に書く。
// Ryosuke さんから「ロールバックと Koto の『元に戻す』はどう棲み分けるのか」と実際に質問が出た
// （＝同じところで他の人も迷う）。⑨（RollbackSection）に、公開したものだけを戻すこと・
// 手元のファイルは変わらないことを短く書く。

const section = readFileSync(join(__dirname, '..', 'src/renderer/components/RollbackSection.tsx'), 'utf-8')

describe('RollbackSection: 「手元のファイルは変わりません」相当の説明がある', () => {
  it('見出しのすぐ下（refresh ボタンの直後）に注記がある', () => {
    const headingAt = section.indexOf('⏪ 公開したものを前のバージョンに戻す')
    expect(headingAt).toBeGreaterThan(0)
    const noteAt = section.indexOf('手元のファイルは変わりません', headingAt)
    expect(noteAt).toBeGreaterThan(headingAt)
  })

  it('🕘 履歴（前の状態に戻す）が手元を戻すものだと、混同しない形で名指ししている', () => {
    expect(section).toContain('🕘 履歴（前の状態に戻す）')
    // 「手元のファイルは変わりません」という一文の近くに、履歴への言及があること
    // （遠く離れた別の場所での偶然の一致を除くため、300文字以内の近接を見る）。
    const noteAt = section.indexOf('手元のファイルは変わりません')
    const historyAt = section.indexOf('🕘 履歴（前の状態に戻す）', noteAt - 300)
    expect(historyAt).toBeGreaterThan(-1)
    expect(Math.abs(historyAt - noteAt)).toBeLessThan(300)
  })

  it('壊れたときの安全な順番（まずここで戻す）にも触れている', () => {
    expect(section).toContain('壊れたときは')
  })

  it('「公開したもの」（訪問者に見えているもの）を戻す、と明示している', () => {
    const noteAt = section.indexOf('手元のファイルは変わりません')
    expect(noteAt).toBeGreaterThan(0)
    const before = section.slice(Math.max(0, noteAt - 200), noteAt)
    expect(before).toContain('公開したもの')
  })
})
