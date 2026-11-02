// renderer/usage.ts の checkBeforeRequest を呼ぶ所と、その関数の説明コメントが言う呼び元が一致していること。
// コメントは「呼び元は〇〇だけ」と言い切るので、呼び元が増える・減るときに、コメントも直す（数え間違いの再発を防ぐ）。

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8')
/** コメントを除いたソース（行頭のコメントと /* *\/） */
const code = (rel: string): string =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => { const t = line.trim(); return !t.startsWith('//') && !t.startsWith('*') })
    .join('\n')
const walk = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.(?:ts|tsx)$/.test(e.name) ? [`${dir}/${e.name}`] : [])
const count = (s: string, needle: string): number => s.split(needle).length - 1

describe('renderer/usage.ts の checkBeforeRequest の呼び元', () => {
  const importers = walk('src/renderer')
    .filter(f => f !== 'src/renderer/usage.ts')
    .filter(f => /import\s*\{[^}]*\bcheckBeforeRequest\b[^}]*\}\s*from\s*'(?:\.\/|\.\.\/)usage'/.test(code(f)))
    .sort()

  it('★ 取り込んでいるのは3ファイルだけ（ChatPanel・useAiChat・securityCheck）。src/main は renderer/usage.ts を使わない', () => {
    expect(importers).toEqual([
      'src/renderer/components/ChatPanel.tsx',
      'src/renderer/hooks/useAiChat.ts',
      'src/renderer/securityCheck.ts',
    ])
    for (const f of walk('src/main')) expect(code(f), f).not.toMatch(/from\s*'(?:\.\.\/)+renderer\/usage'/)
  })

  it('★ 呼ぶ所は4つ: ChatPanel は あいさつの ports へ渡す1か所（呼ばない）・useAiChat は2か所・securityCheck は1か所', () => {
    const panel = code('src/renderer/components/ChatPanel.tsx')
    expect(count(panel, 'checkBeforeRequest(')).toBe(0)
    expect(panel).toContain('        checkBeforeRequest,\n')
    expect(count(panel, 'checkBeforeRequest,')).toBe(2) // 取り込みの1行と、ports への受け渡し
    expect(code('src/renderer/greeting.ts')).toContain('const budget = ports.checkBeforeRequest(apiKey)')
    expect(count(code('src/renderer/hooks/useAiChat.ts'), 'checkBeforeRequest(')).toBe(2)
    expect(count(code('src/renderer/securityCheck.ts'), 'checkBeforeRequest(')).toBe(1)
  })

  it('★★ 関数の説明コメントが、4つの呼び元を挙げている。行番号・検分の話は書かない', () => {
    const src = read('src/renderer/usage.ts')
    const at = src.indexOf('export function checkBeforeRequest(')
    const doc = src.slice(src.lastIndexOf('/**', at), at).replace(/\n\s*\*\s*/g, ' ') // 折り返しをつなぐ
    expect(doc).toContain('呼ぶ所は4つ')
    for (const place of ['greeting.ts の runGreeting', 'ChatPanel が ports として渡す', 'useAiChat の Claude モードからの委譲チェック', 'useAiChat の buildPorts の usage.check', 'securityCheck の 🛡 簡易セキュリティチェック']) {
      expect(doc, place).toContain(place)
    }
    expect(doc).not.toMatch(/\.tsx?:\d+/)
    expect(doc).not.toContain('検分')
    expect(doc).not.toContain('専用と')
  })
})
