import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TARGET_PROFILES } from '../src/renderer/targetProfiles'
import { SECURITY_PLACEMENTS, GITHUB_SAVE_PLACEMENT } from './securityPlacements'

const ROOT = path.join(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
const count = (src: string, needle: string) => src.split(needle).length - 1
const COMP = 'src/renderer/components'
const tsx = fs.readdirSync(path.join(ROOT, COMP)).filter(f => f.endsWith('.tsx')).map(f => `${COMP}/${f}`)
const rows = Object.entries(SECURITY_PLACEMENTS)

describe('🛡 の置き場所の表', () => {
  it('表のキー＝公開先の一覧（過不足なし）', () => {
    expect(Object.keys(SECURITY_PLACEMENTS).sort()).toEqual(Object.keys(TARGET_PROFILES).sort())
  })

  it.each(rows.filter(([, p]) => p.kind === 'section'))('%s: 呼び出しがちょうど1回・節もちょうど1つ', (_k, p) => {
    if (p.kind !== 'section') return
    const src = read(p.file)
    expect(count(src, p.call)).toBe(1)
    expect(count(src, '<SecurityCheckSection')).toBe(1)
  })

  it('PublishModal には stepNo つきの呼び出しが無い', () => {
    expect(read(`${COMP}/PublishModal.tsx`)).not.toContain('<SecurityCheckSection projectDir={projectDir} apiKey={apiKey} stepNo=')
  })

  it('節を持つ画面の集合＝表の節ありの行の画面の集合', () => {
    const actual = tsx.filter(f => read(f).includes('<SecurityCheckSection')).sort()
    const listed = [...new Set(rows.flatMap(([, p]) => (p.kind === 'section' ? [p.file] : [])))].sort()
    expect(actual).toEqual(listed)
  })

  it.each(rows.filter(([, p]) => p.kind === 'none'))('%s: 節なしの理由があり、画面に節が無い', (_k, p) => {
    if (p.kind !== 'none') return
    expect(p.reason.trim().length).toBeGreaterThanOrEqual(8)
    if (p.file) expect(read(p.file)).not.toContain('<SecurityCheckSection')
  })

  it('GitHub 保存: 置き場の呼び出しが1回、使う画面は GithubSaveModal だけ', () => {
    expect(count(read(GITHUB_SAVE_PLACEMENT.file), GITHUB_SAVE_PLACEMENT.call)).toBe(1)
    const users = tsx.filter(f => read(f).includes('<GithubSaveScan'))
    expect(users).toEqual([GITHUB_SAVE_PLACEMENT.file])
  })
})
