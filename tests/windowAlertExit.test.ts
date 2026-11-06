import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { knowledgeFailureNotice } from '../src/renderer/components/knowledgeNotice'

// alert を使わない（資料の窓・画像の片づけ・上部のバー・App）。失敗は窓の中の帯に出す。
const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf-8')
const FILES = [
  'src/renderer/components/KnowledgeModal.tsx',
  'src/renderer/components/AppRunPanel.tsx',
  'src/renderer/components/TitleBar.tsx',
  'src/renderer/App.tsx',
]

describe('alert の退場（その1）', () => {
  for (const f of FILES) {
    it(`★★ ${f} に window.alert( が無い`, () => {
      expect(read(f)).not.toContain('window.alert(')
    })
  }

  it('★★ App の3つの入口は、プロジェクトが無いとき何も出さずに戻る（案内の alert を出さない）', () => {
    const app = read('src/renderer/App.tsx')
    expect(app).not.toContain('先にプロジェクトを開いてください')
    expect(app).toContain('hasProject={!!currentDir}')
    expect(app).toContain('if (!currentDir) return')
  })
})

describe('資料の窓の失敗の帯', () => {
  it('★★ 原因があるときは「: 原因」まで出す', () => {
    expect(knowledgeFailureNotice('更新', 'HTTP 500')).toBe('更新に失敗しました: HTTP 500')
  })
  it('★★ 原因が空・無い・空白のときは「: 」で途切れない', () => {
    for (const e of ['', '  ', undefined, null]) {
      expect(knowledgeFailureNotice('削除', e)).toBe('削除に失敗しました')
    }
  })
  it('★★ 更新・削除・追加の失敗は、同じ窓の帯（uploadNotice）へ出す', () => {
    const src = read('src/renderer/components/KnowledgeModal.tsx')
    for (const a of ['更新', '削除', '追加']) {
      expect(src).toContain(`setUploadNotice(knowledgeFailureNotice('${a}', r.error))`)
    }
    expect(src).not.toContain("に失敗しました: ${r.error ?? ''}")
  })
})
