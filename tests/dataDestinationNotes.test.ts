import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { AI_ENGINE_SEND_NOTE, WEB_SEARCH_SEND_NOTE } from '../src/shared/dataDestinationNotes'

// 送り先の一文は shared の定数1つで、2つの画面がその定数を描く。禁止語（無償・無料・Claude Code・丸数字）は書かない。

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')
const ONBOARDING = read('src/renderer/components/OnboardingModal.tsx')
const CREDENTIALS = read('src/renderer/components/CredentialsModal.tsx')

describe('送り先の一文', () => {
  it('文は表の文のまま', () => {
    expect(AI_ENGINE_SEND_NOTE).toBe('ファイルの内容と指示が、さくらのAI Engine に送られます。')
    expect(WEB_SEARCH_SEND_NOTE).toBe('質問から作った検索語が、Tavily または Brave に送られます。')
  })

  it('ようこその APIキー登録の画面が AI Engine の定数を描く（文の直書きは禁止）', () => {
    expect(ONBOARDING).toContain("import { AI_ENGINE_SEND_NOTE } from '../../shared/dataDestinationNotes'")
    expect(ONBOARDING).toContain('<p className="text-[11px] text-ink-muted mb-4">{AI_ENGINE_SEND_NOTE}</p>')
    expect(ONBOARDING).not.toContain('AI Engine に送られます')
  })

  it('Web 検索のカードが Web 検索の定数を描く（文の直書きは禁止）', () => {
    expect(CREDENTIALS).toContain("import { WEB_SEARCH_SEND_NOTE } from '../../shared/dataDestinationNotes'")
    expect(CREDENTIALS).toContain('<p className="text-[11px] text-ink-muted mt-0.5">{WEB_SEARCH_SEND_NOTE}</p>')
    expect(CREDENTIALS).not.toContain('Tavily または Brave に送られます')
  })

  it('禁止語を含まない', () => {
    for (const text of [AI_ENGINE_SEND_NOTE, WEB_SEARCH_SEND_NOTE]) {
      expect(text).not.toMatch(/Claude Code|無償|無料|[①-⑳㉑-㊿]/)
    }
  })
})
