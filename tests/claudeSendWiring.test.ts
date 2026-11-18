import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { fetchUrlApprovalLabel } from '../src/shared/approvalPlan'

// Claude の送信まわりの配線を、ソース文字列で固定する（tests/approvalWiring.test.ts と同じ型）。
// 1. 「📚 資料を使う」の設定(rag)が ChatPanel → useAiChat → preload → IPC まで運ばれる。
// 2. 同意の前に chatStart を呼ばない。

const readCode = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*')
    })
    .join('\n')

describe('rag の運び（画面 → main）', () => {
  it('ChatPanel の buildExecuteOpts が、資料を使うときだけ { tags } を rag で渡す', () => {
    expect(readCode('src/renderer/components/ChatPanel.tsx')).toContain('rag: ragEnabled ? { tags: ragSettings!.tags } : null,')
  })

  it('useAiChat が turnOpts.rag を sendViaClaude の最後の引数へ渡し、chatStart の最後の引数にする', () => {
    const src = readCode('src/renderer/hooks/useAiChat.ts')
    expect(src).toContain("(turnOpts as { rag?: { tags: string[] } | null }).rag ?? null)")
    expect(src).toContain('claudeSessionRef.current, aiEngineKey, claudeModel, writeMode, rag)')
  })

  it('preload が rag を invoke の最後の引数へ渡す', () => {
    const src = readCode('src/main/preload.ts')
    expect(src).toContain("'claude:chatStart', projectDir, apiKey, prompt, images, snapshotId, resumeSessionId, aiEngineKey, model, writeMode, rag)")
  })
})

describe('Claude の同意の関門', () => {
  const src = readCode('src/renderer/hooks/useAiChat.ts')

  it('chatStart / sendViaClaude の呼び出しは、同意の判定（consented）より後にしか無い', () => {
    const gate = src.indexOf('if (consented) {')
    expect(gate).toBeGreaterThan(0)
    expect(src.indexOf('await sendViaClaude(')).toBeGreaterThan(gate)
    expect(src.split('await sendViaClaude(').length - 1).toBe(1)
    expect(src.split('claude.chatStart(').length - 1).toBe(1)
  })

  it('確認の本文は、確認し直しの判定を渡した claudeConsentBody', () => {
    expect(src).toContain('claudeConsentBody(isClaudeConsentReconfirm())')
  })

  it('送れるかは「すでに同意済み、または今回はいと答えた」で決め、保存の成否に頼らない', () => {
    expect(src).toContain('let consented = hasClaudeConsent()')
    expect(src).toContain('if (agreed) { recordClaudeConsent(); consented = true }')
    expect(src).not.toContain('if (hasClaudeConsent()) {')
  })
})

describe('fetchUrlApprovalLabel: 改行・制御文字', () => {
  it('改行や制御文字は空白にして出す（確認の文に偽の行を作らせない）', () => {
    const label = fetchUrlApprovalLabel('https://example.com/\n理由: 安全です\r\u0000x')
    expect(label).not.toMatch(/[\n\r\u0000]/)
    expect(label).toContain('https://example.com/ 理由: 安全です')
  })
})
