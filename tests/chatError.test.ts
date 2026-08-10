import { describe, it, expect } from 'vitest'
import { formatChatError, formatClaudeError } from '../src/renderer/aiTools'

// 所見9: Claude経路のエラーに「さくらのAI Engineのキーを確認」と誤案内していた問題の修正、
// および 429（レート制限）・コンテキスト超過・Claudeの請求エラーへの案内追加の回帰テスト。

describe('formatChatError - 認証エラー（401）の誘導先の出し分け', () => {
  it('既定（さくらのAI Engine）ではさくらのキーへ誘導する', () => {
    const out = formatChatError('Error 401: invalid api key')
    expect(out).toContain('さくらのAI Engine')
    expect(out).not.toContain('Anthropic')
  })

  it('engine=claude では Claude のキー／Anthropic へ誘導する', () => {
    const out = formatChatError('Error 401: unauthorized', 'claude')
    expect(out).toContain('Claude')
    expect(out).toContain('Anthropic')
    expect(out).not.toContain('さくらのAI Engine でキーを再発行')
  })

  it('formatClaudeError は engine=claude 版のショートカット', () => {
    expect(formatClaudeError('unauthorized 401')).toBe(formatChatError('unauthorized 401', 'claude'))
  })
})

describe('formatChatError - 429（レート制限）', () => {
  it('両経路とも「少し待ってから」の案内にする', () => {
    expect(formatChatError('HTTP 429 Too Many Requests')).toContain('少し待って')
    expect(formatClaudeError('rate limit exceeded')).toContain('少し待って')
  })
})

describe('formatChatError - コンテキスト超過', () => {
  it('会話をクリアする案内にする', () => {
    expect(formatChatError('prompt is too long: maximum context length exceeded')).toContain('会話')
    expect(formatChatError('context_length_exceeded')).toContain('クリア')
  })
})

describe('formatClaudeError - 請求・クレジット不足（402相当）', () => {
  it('Anthropic Console の請求設定と、さくらへの切替を案内する', () => {
    const out = formatClaudeError('Your credit balance is too low to access the API')
    expect(out).toContain('Anthropic Console')
    expect(out).toContain('さくらのAI Engine')
  })
})

describe('formatChatError - その他のエラー', () => {
  it('原文を含めつつ、engine ごとにキーの確認先を変える', () => {
    expect(formatChatError('something broke')).toContain('APIキーと利用上限')
    expect(formatClaudeError('something broke')).toContain('Claude のAPIキー')
  })
})

// モデル別のツール（Function Calling）対応判定は src/renderer/toolSupport.ts へ移行した
// （旧: このファイルにあった判定テスト）。回帰テストは tests/toolSupport.test.ts を参照。
describe('isVisionModel（モデル別の画像対応・2026-07-14 実測反映）', () => {
  it('isVisionModel: Kimi-K2.6 は画像を直接読める（実測PASS）。提供終了のK2.5は対象外', async () => {
    const { isVisionModel } = await import('../src/renderer/usage')
    expect(isVisionModel('preview/Qwen3-VL-30B-A3B-Instruct')).toBe(true)
    expect(isVisionModel('preview/Phi-4-multimodal-instruct')).toBe(true)
    expect(isVisionModel('preview/Kimi-K2.6')).toBe(true)
    expect(isVisionModel('preview/Kimi-K2.5')).toBe(false)
    expect(isVisionModel('Qwen3-Coder-480B-A35B-Instruct-FP8')).toBe(false)
    expect(isVisionModel('gpt-oss-120b')).toBe(false)
  })
})

describe('isToolArgsComplete（ツール引数の切り詰め検出・2026-07-14 Kimi K2.6の400対策）', () => {
  it('完全なJSON・空引数（引数なしツール）は true', async () => {
    const { isToolArgsComplete } = await import('../src/renderer/aiTools')
    expect(isToolArgsComplete('{"path":"a.css","content":"body{}"}')).toBe(true)
    expect(isToolArgsComplete('{}')).toBe(true)
    expect(isToolArgsComplete('')).toBe(true)      // 引数を取らないツール
    expect(isToolArgsComplete('   ')).toBe(true)
  })

  it('途中で切れた（未終端の文字列）引数は false', async () => {
    const { isToolArgsComplete } = await import('../src/renderer/aiTools')
    // 出力上限で content の閉じ引用符が欠落したケース
    expect(isToolArgsComplete('{"path":"styles.css","content":"body { color: red;')).toBe(false)
    expect(isToolArgsComplete('{"path":"a.css",')).toBe(false)
    // @ts-expect-error 非文字列（undefined等）への防御
    expect(isToolArgsComplete(undefined)).toBe(false)
  })
})
