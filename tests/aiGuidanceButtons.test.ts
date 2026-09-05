import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { IDE_CONTEXT, CHAT_CONTEXT } from '../src/renderer/aiContext'

// AI に案内させるボタン名が、画面に実在するボタンと一致していることを固定する（掟9）。
//
// ── なぜ（2026-09-04 Ryosuke 実機）──────────────────────────────────
// チャットで文書を作らせたとき、AI が「[適用] で保存できます。」と案内したが、
// **画面のボタンは「💾 プロジェクトに保存」**で、[適用] というボタンはどこにも無い。
// システムプロンプト（aiContext.ts）が古いボタン名のまま案内を指示していた。
// 非エンジニア向けの IDE で「押す場所」を間違って教えるのは、そのまま手詰まりになる。
//
// このテストは **実物（AiMessage.tsx）のボタン名を読んで**突き合わせるので、
// 将来ボタン名を変えたときにも落ちて気づける（文字列を二重に書き下すだけでは、
// 実物が変わっても素通りしてしまう）。

const ROOT = path.join(__dirname, '..')
const aiMessageSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/components/AiMessage.tsx'), 'utf-8')

describe('AI の案内文のボタン名は、実物のボタンと一致する（掟9）', () => {
  it('AiMessage の保存ボタンの表示名を実物から取れる', () => {
    // 実物の三項: state === 'applying' ? '保存中…' : state === 'done' ? '✓ 保存しました' : '💾 プロジェクトに保存'
    expect(aiMessageSrc).toContain("'💾 プロジェクトに保存'")
  })

  it('IDE_CONTEXT / CHAT_CONTEXT の案内が、実物のボタン名を使っている', () => {
    const label = '💾 プロジェクトに保存'
    expect(IDE_CONTEXT).toContain(`[${label}]`)
    expect(CHAT_CONTEXT).toContain(`[${label}]`)
  })

  it('★ 存在しない「[適用] ボタン」を案内していない（案内文としては使わない）', () => {
    // 「[適用]」の語が残ってよいのは、**それを名乗るなという禁止指示の中だけ**。
    // 案内の形（「[適用] ボタンで保存できます」「[適用] でファイルを保存」）は禁止。
    for (const ctx of [IDE_CONTEXT, CHAT_CONTEXT]) {
      expect(ctx).not.toContain('[適用] ボタンで保存できます')
      expect(ctx).not.toContain('[適用] でファイルを保存')
    }
  })

  it('チャットモードには「存在しないボタン名を案内しない」という明示の禁止がある', () => {
    expect(CHAT_CONTEXT).toContain('存在しないボタン名を案内しないこと')
  })
})
