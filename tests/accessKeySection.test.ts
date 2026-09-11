import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { accessKeyView } from '../src/renderer/components/AccessKeySection'

// 委譲仕様 UX-E・判断8: 4パネル（AppRun 共用型・専有型・HANAMII・Vercel）の
// ①「キー」節を AccessKeySection.tsx に一元化した。ここは表示の分岐だけを切り出した
// 純関数 accessKeyView（JSX からは import できない・electron 非依存）を固定する。

describe('accessKeyView: 表示の分岐（純関数）', () => {
  it('未登録（registered=false）なら大きなボタン（register）', () => {
    expect(accessKeyView({ registered: false, test: undefined }).credentialsButton).toBe('register')
  })

  it('登録済み（registered=true）なら文字リンク（open）', () => {
    expect(accessKeyView({ registered: true, test: undefined }).credentialsButton).toBe('open')
  })

  it('registered の値だけで決まる（test の有無に左右されない）', () => {
    expect(accessKeyView({ registered: true, test: { run: async () => {}, state: 'idle' } }).credentialsButton).toBe('open')
    expect(accessKeyView({ registered: false, test: { run: async () => {}, state: 'idle' } }).credentialsButton).toBe('register')
  })

  it('test が無ければ、接続テストのボタン自体を出さない（showTest=false）', () => {
    expect(accessKeyView({ registered: true, test: undefined }).showTest).toBe(false)
    expect(accessKeyView({ registered: false, test: undefined }).showTest).toBe(false)
  })

  it('test があれば、接続テストのボタンを出す（showTest=true）', () => {
    expect(accessKeyView({ registered: true, test: { run: async () => {}, state: 'idle' } }).showTest).toBe(true)
  })
})

// ── 配線（ソースを読んで固定）── AccessKeySection.tsx 自体の見た目を固定する。
// electron に依存する4パネル側は import できないため、ソースを読んで確かめる
// （tests/apprunDedicatedWiring.test.ts と同じ流儀）。
const section = readFileSync(join(__dirname, '..', 'src/renderer/components/AccessKeySection.tsx'), 'utf-8')

describe('AccessKeySection.tsx: JSX は accessKeyView の結果をそのまま出し分けるだけ（分岐を複製しない）', () => {
  it('credentialsButton の分岐は view.credentialsButton を見て出し分けている（registered を直接見ていない）', () => {
    expect(section).toContain("view.credentialsButton === 'open'")
    // registered を直接使った三項（旧い書き方）が復活していないこと。
    expect(section).not.toMatch(/\{registered \? \(/)
  })

  it('接続テストの表示は view.showTest を見ている', () => {
    expect(section).toContain('{view.showTest && test && (')
  })

  it('未登録時のボタンは「🔑 認証情報を登録する」、登録済みは「認証情報を開く」', () => {
    expect(section).toContain('🔑 認証情報を登録する')
    expect(section).toContain('認証情報を開く')
  })

  it('見出しは「{stepNo} {keyLabel}」、説明文はサービス名を差し込んだ1文', () => {
    expect(section).toContain('{stepNo} {keyLabel}')
    expect(section).toContain('Koto が {serviceTitle} へ代わりにアクセスするための合言葉です。')
  })

  it('ConnectionChecklist を使う（手描きの一覧を複製しない）', () => {
    expect(section).toContain("import ConnectionChecklist")
    expect(section).toContain('<ConnectionChecklist items={test.checks} note={test.note} />')
  })

  it('全体エラー（test.message）は checks の有無に関係なく表示する（内訳とは別に全体メッセージが来ることがあるため）', () => {
    expect(section).toContain("test.state === 'ng' && test.message")
  })

  it('NGの要約は、内訳（checks）が全滅か一部かで文言を変える（言い過ぎない）', () => {
    expect(section).toContain('function ngSummary(')
    expect(section).toContain('すべての項目で確認できませんでした')
    expect(section).toContain('一部の権限が確認できませんでした')
  })

  it('window.confirm は使わない（掟5）', () => {
    expect(section).not.toContain('window.confirm(')
  })
})
