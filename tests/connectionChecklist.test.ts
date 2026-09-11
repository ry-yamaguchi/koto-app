import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// roadmap #35 → 委譲仕様 UX-E（判断8）: 接続テストの見せ方を、共用型と専有型で揃える。
// 表示（チェックリストのUI）を複製しない——ConnectionChecklist.tsx という1つの部品を
// AccessKeySection.tsx 経由で両方のパネルが使っていることをソースで固定する（掟10）。
//
// UX-E で①「キー」節ごと AccessKeySection.tsx に一元化したため、<ConnectionChecklist> を
// 描くJSXそのものは AccessKeySection.tsx の中に1箇所だけあり（tests/accessKeySection.test.ts
// が固定する）、各パネルは test.checks に渡す配列（項目名・note）を組み立てるだけになった。
// ここでは「各パネルが AccessKeySection へ正しい内訳・注記を渡しているか」を固定する。

const checklist = readFileSync(join(__dirname, '..', 'src/renderer/components/ConnectionChecklist.tsx'), 'utf-8')
const accessKeySection = readFileSync(join(__dirname, '..', 'src/renderer/components/AccessKeySection.tsx'), 'utf-8')
const appRunPanel = readFileSync(join(__dirname, '..', 'src/renderer/components/AppRunPanel.tsx'), 'utf-8')
const dedicatedPanel = readFileSync(join(__dirname, '..', 'src/renderer/components/AppRunDedicatedPanel.tsx'), 'utf-8')

describe('ConnectionChecklist.tsx: ✓/✗ と項目名・失敗理由・注記を描く共通部品', () => {
  it('items を map して ✓/✗ を出し、note があれば添える', () => {
    expect(checklist).toContain('items.map(c =>')
    expect(checklist).toContain("c.ok ? '✓' : '✗'")
    expect(checklist).toContain('{note &&')
  })

  // P（2026-09-10 レビューの修理・バッチ3・掟5: エラーメッセージは選択・コピー可能に）。
  // 失敗理由の行（c.message を出す span）そのものに select-text が付いていることを、
  // その行の className ごと見る（別の行の select-text に当たらないよう一意に指す）。
  it('失敗理由（c.message）の行に select-text が付いている', () => {
    expect(checklist).toContain('<span className="ml-2 text-[11px] text-ink-muted select-text">{c.message}</span>')
  })
})

describe('AccessKeySection.tsx（①を一元化した共通部品）は ConnectionChecklist を使う', () => {
  it('import し、test.checks を渡している', () => {
    expect(accessKeySection).toContain("import ConnectionChecklist")
    expect(accessKeySection).toContain('<ConnectionChecklist items={test.checks} note={test.note} />')
  })

  it('チェックリストの手描き（インラインの map）はもう無い（ConnectionChecklist に一元化した）', () => {
    expect(accessKeySection).not.toContain("c.ok ? '✓' : '✗'")
  })
})

describe('AppRunPanel（共用型）は AccessKeySection の test.checks に3項目を渡している', () => {
  it('AccessKeySection を使っている', () => {
    expect(appRunPanel).toContain('<AccessKeySection')
  })

  it('AppRun参照/コンテナレジストリ一覧/請求（コスト）参照の3項目と注記を渡している', () => {
    const at = appRunPanel.indexOf('<AccessKeySection')
    expect(at).toBeGreaterThan(0)
    const end = appRunPanel.indexOf('</AccessKeySection>', at)
    expect(end).toBeGreaterThan(at)
    const block = appRunPanel.slice(at, end)
    expect(block).toContain("label: 'AppRun 参照'")
    expect(block).toContain("label: 'コンテナレジストリ 一覧'")
    expect(block).toContain("label: '請求（コスト）参照'")
    expect(block).toContain('※「作成」権限は実際に作成するまで確認できません')
  })

  it('チェックリストの手描き（インラインの map）はもう無い（ConnectionChecklist に一元化した）', () => {
    expect(appRunPanel).not.toContain("c.ok ? '✓' : '✗'")
  })
})

describe('AppRunDedicatedPanel（専有型）も AccessKeySection の test.checks に2項目を渡している（roadmap #35 本題）', () => {
  it('AccessKeySection を使っている', () => {
    expect(dedicatedPanel).toContain('<AccessKeySection')
  })

  it('専有型API参照（制限・プラン）/請求（コスト）参照の2項目を渡し、レジストリは注記で「後で確認する」と案内する', () => {
    const at = dedicatedPanel.indexOf('<AccessKeySection')
    expect(at).toBeGreaterThan(0)
    const end = dedicatedPanel.indexOf('</AccessKeySection>', at)
    expect(end).toBeGreaterThan(at)
    const block = dedicatedPanel.slice(at, end)
    expect(block).toContain("label: '専有型API 参照（制限・プラン）'")
    expect(block).toContain("label: '請求（コスト）参照'")
    expect(block).toContain('レジストリの権限は、アプリの公開に対応したときに確認します')
  })

  // roadmap #35 の元々の目的（共用型と専有型で①の文言を揃える）は、UX-E で
  // AccessKeySection.tsx に一元化したことでファイルレベルでも達成された——
  // 「✅ すべて確認できました」「⚠️ 一部の権限が確認できませんでした」という文言は
  // dedicatedPanel 自身にはもう出てこず、AccessKeySection.tsx に1箇所だけある。
  it('①の要約文言はもう複製していない（AccessKeySection.tsx に一元化）', () => {
    expect(dedicatedPanel).not.toContain('✅ すべて確認できました')
    expect(dedicatedPanel).not.toContain('⚠️ 一部の権限が確認できませんでした')
    expect(accessKeySection).toContain('✅ すべて確認できました')
    expect(accessKeySection).toContain('一部の権限が確認できませんでした')
  })
})
