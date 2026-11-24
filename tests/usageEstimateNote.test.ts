// P-144・P-145（2026-11-24 作者決定）: 利用額の見立ての断りと、資料（RAG）の料金の説明。
// 計算（usageBudget.ts）は控えめのまま変えない。画面と文書が「月ごとの利用枠を引いていない」「資料の料金は見立てと上限に入らない」と言うことを固定する。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { USAGE_ESTIMATE_NOTE } from '../src/renderer/components/SettingsModal'

const root = path.join(__dirname, '..')
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf-8')

describe('利用額の見立ての断り（P-145）', () => {
  it('断りの文は、利用枠を引いていないことと、請求の確かめ先を言う', () => {
    expect(USAGE_ESTIMATE_NOTE).toBe('料金表の単価で足した見立てで、さくらの月ごとの利用枠は引いていません。実際の請求は、さくらのコントロールパネルで確かめてください。')
  })
  it('設定の画面は、利用額の数字のすぐ下で断りを1回だけ出す（ソースの形の固定）', () => {
    const src = read('src/renderer/components/SettingsModal.tsx')
    expect(src.split('{USAGE_ESTIMATE_NOTE}').length - 1).toBe(1)
    const amount = src.indexOf('¥{usage.costYen.toFixed(1)}')
    const note = src.indexOf('{USAGE_ESTIMATE_NOTE}')
    expect(amount).toBeGreaterThan(0)
    expect(note).toBeGreaterThan(amount)
    expect(note - amount).toBeLessThan(400)
  })
  it('画面と文書に「無料枠」「無償」と書かない（月ごとの利用枠と言う）', () => {
    const src = read('src/renderer/components/SettingsModal.tsx')
    expect(src).not.toContain('無料枠')
    expect(src).toContain('実際の請求と月ごとの利用枠は')
  })
})

describe('資料（RAG）の料金の説明（P-144）', () => {
  const C = '資料（📚）は、登録している量に応じて さくらのAI Engine の料金がかかります（100チャンクごと。月ごとの利用枠はありません）。この分と、資料を探すときの分は、Koto の利用額の見立てと月の上限には入りません。'
  it('README と使い方ガイドは、資料の料金が見立てと上限に入らないことを言う', () => {
    expect(read('README.md')).toContain(C)
    expect(read('docs/usage-guide.html')).toContain(C)
  })
  it('README と使い方ガイドは、利用額が利用枠を引く前の見立てだと言う', () => {
    expect(read('README.md')).toContain('さくらの月ごとの利用枠は引いていないので、実際の請求より大きく出ることがあります。')
    expect(read('docs/usage-guide.html')).toContain('さくらの月ごとの利用枠は引いていないので、実際の請求より大きく出ることがあります。')
  })
  it('直す前の「資料を探すと費用が出ます」の言い方は残っていない', () => {
    expect(read('README.md')).not.toContain('さくらのAI Engineの費用も出ます')
    expect(read('docs/usage-guide.html')).not.toContain('さくらのAI Engine の費用も出ます')
  })
})
