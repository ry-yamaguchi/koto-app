import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// roadmap #35: 接続テストの見せ方を、共用型と専有型で揃える。
// 表示（チェックリストのUI）を複製しない——ConnectionChecklist.tsx という1つの部品を
// 両方のパネルが使っていることをソースで固定する（掟10）。

const checklist = readFileSync(join(__dirname, '..', 'src/renderer/components/ConnectionChecklist.tsx'), 'utf-8')
const appRunPanel = readFileSync(join(__dirname, '..', 'src/renderer/components/AppRunPanel.tsx'), 'utf-8')
const dedicatedPanel = readFileSync(join(__dirname, '..', 'src/renderer/components/AppRunDedicatedPanel.tsx'), 'utf-8')

describe('ConnectionChecklist.tsx: ✓/✗ と項目名・失敗理由・注記を描く共通部品', () => {
  it('items を map して ✓/✗ を出し、note があれば添える', () => {
    expect(checklist).toContain('items.map(c =>')
    expect(checklist).toContain("c.ok ? '✓' : '✗'")
    expect(checklist).toContain('{note &&')
  })
})

describe('AppRunPanel（共用型）は ConnectionChecklist を使う', () => {
  it('import している', () => {
    expect(appRunPanel).toContain("import ConnectionChecklist from './ConnectionChecklist'")
  })

  it('AppRun参照/コンテナレジストリ一覧/請求（コスト）参照の3項目を渡している', () => {
    const at = appRunPanel.indexOf('{connChecks && (')
    expect(at).toBeGreaterThan(0)
    const end = appRunPanel.indexOf('/>', at)
    const block = appRunPanel.slice(at, end)
    expect(block).toContain('<ConnectionChecklist')
    expect(block).toContain("label: 'AppRun 参照'")
    expect(block).toContain("label: 'コンテナレジストリ 一覧'")
    expect(block).toContain("label: '請求（コスト）参照'")
    expect(block).toContain('※「作成」権限は実際に作成するまで確認できません')
  })

  it('チェックリストの手描き（インラインの map）はもう無い（ConnectionChecklist に一元化した）', () => {
    expect(appRunPanel).not.toContain("c.ok ? '✓' : '✗'")
  })
})

describe('AppRunDedicatedPanel（専有型）も同じ ConnectionChecklist を使う（roadmap #35 本題）', () => {
  it('import している', () => {
    expect(dedicatedPanel).toContain("import ConnectionChecklist from './ConnectionChecklist'")
  })

  it('専有型API参照（制限・プラン）/請求（コスト）参照の2項目を渡し、レジストリは注記で「後で確認する」と案内する', () => {
    const at = dedicatedPanel.indexOf('{connChecks && (')
    expect(at).toBeGreaterThan(0)
    const end = dedicatedPanel.indexOf('/>', at)
    const block = dedicatedPanel.slice(at, end)
    expect(block).toContain('<ConnectionChecklist')
    expect(block).toContain("label: '専有型API 参照（制限・プラン）'")
    expect(block).toContain("label: '請求（コスト）参照'")
    expect(block).toContain('レジストリの権限は、アプリの公開に対応したときに確認します')
  })

  it('共用型と同じ「✅ すべて確認できました / ⚠️ 一部の権限が確認できませんでした」の文言に揃えている', () => {
    expect(dedicatedPanel).toContain('✅ すべて確認できました')
    expect(dedicatedPanel).toContain('⚠️ 一部の権限が確認できませんでした')
  })
})
