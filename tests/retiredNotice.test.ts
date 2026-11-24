import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { shouldNoticeRetired } from '../src/renderer/retiredNotice'

// P-135: 提供終了したモデルの会話を開くと、案内が同じ会話に2回足されていた。
describe('提供終了の案内を出すかの判断', () => {
  it('同じ会話・同じ元のモデルで2回判断しても、出すのは1回だけ', () => {
    const noticed = new Set<string>()
    expect(shouldNoticeRetired(noticed, 'conv-1', 'old/model')).toBe(true)
    expect(shouldNoticeRetired(noticed, 'conv-1', 'old/model')).toBe(false)
    expect(shouldNoticeRetired(noticed, 'conv-1', 'old/model')).toBe(false)
  })
  it('別の会話なら出す', () => {
    const noticed = new Set<string>()
    shouldNoticeRetired(noticed, 'conv-1', 'old/model')
    expect(shouldNoticeRetired(noticed, 'conv-2', 'old/model')).toBe(true)
  })
  it('同じ会話でも元のモデルが別なら出す', () => {
    const noticed = new Set<string>()
    shouldNoticeRetired(noticed, 'conv-1', 'old/model-a')
    expect(shouldNoticeRetired(noticed, 'conv-1', 'old/model-b')).toBe(true)
  })
})

// ChatApp 側の配線の固定。これは振る舞いの固定ではなく、元の形（P-135）へ戻る変更を見つける grep の縛り。
describe('ChatApp の配線（ソースの形の固定。振る舞いのテストではない）', () => {
  const src = readFileSync(resolve(__dirname, '../src/renderer/components/ChatApp.tsx'), 'utf8')
  it('案内の条件に shouldNoticeRetired を使っている', () => {
    expect(src).toMatch(/shouldNoticeRetired\(retiredNoticed, activeId, activeSession\.model\)/)
  })
  it('effect の依存は models の配列そのものでなく中身（modelIdsKey）', () => {
    expect(src).toMatch(/\[modelIdsKey, modelsLive, activeId\]/)
    expect(src).not.toMatch(/\[models, modelsLive, activeId\]/)
  })
  it('印の Set は関数の外（モジュール直下）にある', () => {
    expect(src).toMatch(/^const retiredNoticed = new Set<string>\(\)/m)
  })
})
