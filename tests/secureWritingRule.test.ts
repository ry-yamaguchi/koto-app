// AI への予防の指示（安全な書き方）が、3か所すべてに同じ1つの文として入っていることを固定する。
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { SECURE_WRITING_RULE } from '../src/shared/secureWritingRule'
import { IDE_CONTEXT, CHAT_CONTEXT } from '../src/renderer/aiContext'
import { buildDelegatePrompt } from '../src/main/claude/toolText'

const ROOT = path.join(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

describe('安全な書き方の指示', () => {
  it('定数は 100〜220 字で、禁止語・丸数字を含まない', () => {
    expect(SECURE_WRITING_RULE.length).toBeGreaterThanOrEqual(100)
    expect(SECURE_WRITING_RULE.length).toBeLessThanOrEqual(220)
    for (const w of ['無償', '無料', '秘密の値', '部品', '様子', '道具', 'Claude Code']) {
      expect(SECURE_WRITING_RULE).not.toContain(w)
    }
    expect(SECURE_WRITING_RULE).not.toMatch(/[①-⑳⓪❶-➓]/)
  })

  it('定数は文の要点（環境変数・値を書かない・公開先で変わる・訪問者の入力）を含む', () => {
    for (const k of ['環境変数', '値そのものを、会話にもコードにも書かない', '公開先で変わる', '利用者に確かめ', '訪問者の入力', 'コマンド', 'HTML', 'ファイルのパス']) {
      expect(SECURE_WRITING_RULE).toContain(k)
    }
  })

  it('IDE_CONTEXT は含み、CHAT_CONTEXT は含まない', () => {
    expect(IDE_CONTEXT).toContain(SECURE_WRITING_RULE)
    expect(CHAT_CONTEXT).not.toContain(SECURE_WRITING_RULE)
  })

  it('任せるツールの system に含まれる', () => {
    const { system } = buildDelegatePrompt('ページを作る', [])
    expect(system).toContain(SECURE_WRITING_RULE)
  })

  it('3か所とも定数を変数として使っている（文を手で写していない）', () => {
    // 文の書き出しが、定義の1か所以外のソースに現れない
    const head = '【安全な書き方】'
    for (const f of ['src/renderer/aiContext.ts', 'src/main/claude/agent.ts', 'src/main/claude/toolText.ts']) {
      const text = read(f)
      expect(text, f).not.toContain(head)
      expect(text, f).toMatch(/import \{ SECURE_WRITING_RULE \} from '[./]+\/shared\/secureWritingRule'/)
    }
    expect(read('src/shared/secureWritingRule.ts')).toContain(head)
  })
})
