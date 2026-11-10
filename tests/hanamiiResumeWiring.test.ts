import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// 自動の続きを呼ぶ所3つが、同じ部品（teardown/hanamiiResume.ts）を通ること。ソースを読むので、呼び出しの形ごと見て、直す前の形を禁じる（掟10）。
const ROOT = path.join(__dirname, '..')
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

function rendererFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) out.push(...rendererFiles(rel))
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel)
  }
  return out
}
const code = (rel: string): string => read(rel).split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

describe('hanamii:resumeTeardown を呼ぶのは hanamiiResume.ts の1か所だけ', () => {
  it('window.electronAPI.hanamii.resumeTeardown( は src/renderer 全体で1ファイルだけ', () => {
    const users = rendererFiles('src/renderer').filter(f => /hanamii\.resumeTeardown\(/.test(code(f)))
    expect(users).toEqual(['src/renderer/teardown/hanamiiResume.ts'])
  })
  it('hanamiiResume.ts は、記録の tokenId の読み方を targets/hanamii.ts の loadHanamiiToken と共有する（トークンの読み方を複製しない）', () => {
    const src = code('src/renderer/teardown/hanamiiResume.ts')
    expect(src).toContain('loadToken: loadHanamiiToken,')
    expect(src).not.toMatch(/getHanamiiToken(ById)?\(/)
    expect(code('src/renderer/teardown/targets/hanamii.ts')).toContain('const token = await loadHanamiiToken(record.tokenId)')
  })
})

describe('呼ぶ所3つ', () => {
  it('1. Koto の起動のあと: App.tsx が、作業場所を読んでから1回（依存配列が空の effect）', () => {
    const app = code('src/renderer/App.tsx')
    expect(app).toContain("void getWorkspaceDir().then(ws => resumeHanamiiDeletionsIn(ws)).catch(() => {})\n  }, [])")
    expect(app.match(/resumeHanamiiDeletionsIn\(/g)).toHaveLength(1)
  })
  it('2. 📡 一覧を開いたとき: 作業場所が分かったあと、一覧を読む前に', () => {
    const src = code('src/renderer/components/PublishedListModal.tsx')
    expect(src).toContain('setWorkspace(ws); void resumeHanamiiDeletionsIn(ws)')
    expect(src.match(/resumeHanamiiDeletionsIn\(/g)).toHaveLength(1)
    expect(src).toContain("import { resumeHanamiiDeletionsIn } from '../teardown/hanamiiResume'")
  })
  it('3. 【公開】の HANAMII の画面: そのプロジェクトだけ（projectDir が変わるたびに）', () => {
    const src = code('src/renderer/components/HanamiiPanel.tsx')
    expect(src).toContain('useEffect(() => { void resumeHanamiiDeletionIn(projectDir) }, [projectDir])')
    expect(src.match(/resumeHanamiiDeletionIn\(/g)).toHaveLength(1)
    expect(src).not.toMatch(/resumeHanamiiDeletionsIn\(/)
  })
  it('画面は handler を直書きで見分けない（最初の破棄と続きの両方を isHanamiiTeardownHandler で見る）', () => {
    const src = code('src/renderer/components/HanamiiPanel.tsx')
    expect(src).toContain('if (isHanamiiTeardownHandler(rec.handler) && rec.result?.ok) await showTornDown()')
    expect(src).toContain('isHanamiiTeardownHandler(ops.ownRunning?.handler)')
    expect(src).not.toContain("rec.handler === 'hanamii:teardown'")
    expect(src).not.toContain("ops.ownRunning?.handler === 'hanamii:teardown'")
  })
})

describe('画面は新しい文を直書きしない（定数は main と画面が同じものを引く）', () => {
  it('続きの部品・窓の進み具合は、日本語の文を持たない（文は main が記録の progress に入れる）', () => {
    for (const f of ['src/renderer/teardown/hanamiiResume.ts', 'src/renderer/teardown/projectDeleteProgress.ts', 'src/renderer/components/teardown/ProjectDeleteProgressLine.tsx']) {
      const lit = [...code(f).matchAll(/(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)].map(m => m[2]).filter(t => /[ぁ-んァ-ヶ一-龠]/.test(t))
      expect(lit, f).toEqual([])
    }
  })
})
