import { describe, it, expect, beforeEach } from 'vitest'
import { packBatches, planAiCheck, runSecurityCheck, orderPiecesForPacking, type Piece } from '../src/renderer/securityCheck'

// 量が多いとき、大きなファイルがほかを押し出さない・途中までのファイルを名指しする、の振る舞い。
// 偽の fs と偽の sakura.chat に実際に流す。

const store = new Map<string, string>()
const g = globalThis as any
g.localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)) },
  removeItem: (k: string) => { store.delete(k) },
}

let sent: string[] = []

function setupWindow(contents: Record<string, string>) {
  g.window = {
    dispatchEvent: () => true,
    electronAPI: {
      fs: {
        exists: async () => false,
        projectFilesInfo: async () => ({ files: Object.keys(contents), truncated: false }),
        readForWriteFix: async (dir: string, rel: string) => {
          try { return { state: 'text', content: await g.window.electronAPI.fs.readFile(`${dir}/${rel}`) } } catch { return { state: 'unreadable' } }
        },
        readFile: async (p: string) => {
          const name = p.replace(/^.*\/proj\//, '')
          if (name in contents) return contents[name]
          throw new Error('無い')
        },
      },
      sakura: {
        chat: async (args: { messages: { role: string; content: string }[] }) => {
          sent.push(args.messages.filter(m => m.role === 'user').map(m => m.content).join('\n'))
          return { content: '{"findings":[]}', usage: { prompt_tokens: 1, completion_tokens: 1 } }
        },
      },
    },
  }
}

const rows = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `// ${tag}${String(i).padStart(5, '0')} ${'word '.repeat(18)}`.slice(0, 99)).join('\n') + '\n'
const SMALL = ['a.js', 'b.js', 'c.js', 'd.js']
const smallFiles = () => Object.fromEntries(SMALL.map(f => [f, rows(20, f)]))

beforeEach(() => { store.clear(); sent = [] })

const piece = (file: string, len: number, part = 1, total = 1): Piece => ({ file, part, total, startLine: 1, text: 'x'.repeat(len) })

describe('packBatches: 途中までのファイル', () => {
  it('一部だけ入ったファイルは partial、1つも入らないファイルは skipped、全部入ったファイルはどちらにも無い', () => {
    const pieces = [
      piece('whole', 900),
      piece('half', 900, 1, 2), piece('half', 900, 2, 2),
      piece('none', 900),
    ]
    const r = packBatches(pieces, 1000, 2)
    expect(r.batches.flat().map(p => `${p.file}${p.part}`)).toEqual(['whole1', 'half1'])
    expect(r.partial).toEqual(['half'])
    expect(r.skipped).toEqual(['none'])
  })

  it('収まるときは両方とも空', () => {
    const r = packBatches([piece('a', 100), piece('b', 100)], 1000, 6)
    expect(r.partial).toEqual([])
    expect(r.skipped).toEqual([])
  })
})

describe('orderPiecesForPacking', () => {
  it('入口は先頭のまま、残りは量の小さい順（同じ量なら元の並び）', () => {
    const pieces = [piece('entry', 5000), piece('big', 3000), piece('s1', 100), piece('s2', 100), piece('mid', 500)]
    expect(orderPiecesForPacking(pieces, 'entry').map(p => p.file)).toEqual(['entry', 's1', 's2', 'mid', 'big'])
  })
  it('入口が無ければ全部が量の順', () => {
    const pieces = [piece('big', 3000), piece('s1', 100)]
    expect(orderPiecesForPacking(pieces, null).map(p => p.file)).toEqual(['s1', 'big'])
  })
})

describe('planAiCheck: 大きなファイル1つと小さいファイル4つ', () => {
  it('小さい4つは全部送る束に入り、skipped は空、大きいファイルは partial', async () => {
    setupWindow({ 'big.js': rows(4500, 'big'), ...smallFiles() })
    const plan = await planAiCheck('/proj')
    const inBatches = new Set(plan.batches.flat().map(p => p.file))
    for (const f of SMALL) expect(inBatches.has(f), f).toBe(true)
    expect(plan.skipped).toEqual([])
    expect(plan.partial).toEqual(['big.js'])
    expect(plan.files).toBe(5)
    expect(plan.requests).toBe(6)
  })

  it('入口のファイルは、大きくても先頭の束に入る', async () => {
    setupWindow({
      'package.json': JSON.stringify({ main: 'server.js' }),
      'server.js': rows(4500, 'srv'),
      ...smallFiles(),
    })
    const plan = await planAiCheck('/proj')
    expect(plan.entry).toBe('server.js')
    expect(plan.batches[0][0].file).toBe('server.js')
    expect(plan.partial).toEqual(['server.js'])
  })
})

describe('runSecurityCheck を偽の送り先へ流す', () => {
  it('送った本文に小さい4ファイルの見出しが全部あり、結果は要確認で、途中までの注記が出る', async () => {
    setupWindow({ 'big.js': rows(4500, 'big'), ...smallFiles() })
    const r = await runSecurityCheck('/proj', 'key-1')
    const all = sent.join('\n')
    for (const f of SMALL) expect(all).toContain(`--- ${f} ---`)
    expect(r.verdict).toBe('warn')
    expect(r.report).toContain('※ 量が多いため、次のファイルは途中までしか確認していません: big.js')
    expect(r.report).not.toContain('次のファイルは確認していません')
  })
})
