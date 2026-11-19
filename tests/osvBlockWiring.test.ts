import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.join(__dirname, '..')
const RENDERER = path.join(ROOT, 'src/renderer')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
const count = (src: string, needle: string) => src.split(needle).length - 1
const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(path.relative(ROOT, full))
  }
  return out
}

const SECTION = read('src/renderer/components/SecurityCheckSection.tsx')
const BLOCK = read('src/renderer/components/OsvCheckBlock.tsx')

describe('SecurityCheckSection への置き方', () => {
  it('ブロックはちょうど1回で、</section> の直前', () => {
    expect(count(SECTION, '<OsvCheckBlock projectDir={projectDir} />')).toBe(1)
    expect(SECTION).toContain('      <OsvCheckBlock projectDir={projectDir} />\n    </section>')
    expect(count(SECTION, '</section>')).toBe(1)
  })
  it('import はちょうど1回', () => {
    expect(count(SECTION, "import OsvCheckBlock from './OsvCheckBlock'")).toBe(1)
  })
})

describe('OsvCheckBlock の配線', () => {
  it('流れの呼び出しは1回。通信する口は ports の中にだけある', () => {
    expect(count(BLOCK, 'runOsvFlow(')).toBe(1)
    expect(count(BLOCK, 'window.electronAPI.osv.check')).toBe(1)
    expect(count(BLOCK, 'window.electronAPI.osv.preview')).toBe(1)
    const start = BLOCK.indexOf('runOsvFlow({')
    const end = BLOCK.indexOf('}, started)', start)
    const inPorts = BLOCK.slice(start, end)
    expect(inPorts).toContain('window.electronAPI.osv.check')
    expect(inPorts).toContain('window.electronAPI.osv.preview')
  })
  it('同意は押した時点で関数から読む（state から渡さない）', () => {
    expect(count(BLOCK, 'hasConsent: hasOsvConsent,')).toBe(1)
    for (const l of BLOCK.split('\n').filter(l => l.includes('useState'))) expect(l).not.toMatch(/consent/i)
  })
  it('確認はフックの element を置く。ブラウザの確認・通知・AI を使わない', () => {
    expect(count(BLOCK, 'const { confirm, element: confirmElement } = useConfirm()')).toBe(1)
    expect(count(BLOCK, '{confirmElement}')).toBe(1)
    for (const s of ['window.confirm(', 'window.alert(', 'sakura.chat', '<SecurityReportBody', '<pre', 'AiText', '{result && (', 'koto_seccheck']) {
      expect(BLOCK).not.toContain(s)
    }
  })
  it('押したときの守り・ports の受け渡し・結果の出し分け', () => {
    for (const s of [
      'if (busy) return',
      'const started = projectDir',
      '}, started)',
      'if (outcome.kind === \'view\' && dirRef.current === started) setView(outcome.view)',
      'check: (dir, consented) => window.electronAPI.osv.check(dir, consented),',
      'preview: (dir) => window.electronAPI.osv.preview(dir),',
      'recordConsent: () => { recordOsvConsent() },',
      'disabled={busy}',
      'onClick={() => window.open(link)}',
      "getText={view.verdict === 'skip' ? () => failureCopyNow(osvViewText(view)) : undefined}",
      'text={osvViewText(view)}',
    ]) expect(count(BLOCK, s), s).toBe(1)
    expect(BLOCK).not.toContain('dirRef.current)')
  })
  it('調べている最中の印は、押したプロジェクトの持ち物（別のプロジェクトの画面では押せる）', () => {
    for (const s of [
      'const [busyDir, setBusyDir] = useState<string | null>(null)',
      'const busy = busyDir === projectDir',
      'setBusyDir(started)',
      'setBusyDir(cur => (cur === started ? null : cur))',
    ]) expect(count(BLOCK, s), s).toBe(1)
    expect(BLOCK).not.toContain('setBusyDir(null)')
  })
  it('プロジェクトが変わったら結果を消す', () => {
    expect(count(BLOCK, 'useEffect(() => { setView(null) }, [projectDir])')).toBe(1)
  })
})

describe('入口は1つ', () => {
  const files = walk(RENDERER)
  it('electronAPI.osv. を含むのは OsvCheckBlock.tsx だけ', () => {
    expect(files.filter(f => read(f).includes('electronAPI.osv.'))).toEqual(['src/renderer/components/OsvCheckBlock.tsx'])
  })
  it('同意の保存先に触るのは osvConsent.ts だけ', () => {
    const touching = files.filter(f => {
      const s = read(f)
      return s.includes('localStorage') && (s.includes('OSV_CONSENT_KEY') || s.includes("'koto_osv_consent'"))
    })
    expect(touching).toEqual(['src/renderer/osvConsent.ts'])
  })
  it('同意の書き込み（setItem・removeItem）は osvConsent.ts の2か所だけ', () => {
    const src = read('src/renderer/osvConsent.ts')
    expect(count(src, 'localStorage.setItem(')).toBe(1)
    expect(count(src, 'localStorage.removeItem(')).toBe(1)
  })
})
