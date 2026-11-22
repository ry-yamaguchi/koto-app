import { describe, it, expect, beforeEach, vi } from 'vitest'
import { maskSecretShapes } from '../src/shared/secretShapes'

// 計画（planAiCheck）は読むだけ。通信せず・利用量を見ず・キーを受け取らない。
// 偽の fs と偽の sakura.chat に実際に流して、呼ばれた回数と、送られた本文の長さで確かめる。

const mocks = vi.hoisted(() => ({ budgetCalls: 0 }))
vi.mock('../src/renderer/usage', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/renderer/usage')>()
  return { ...real, checkBeforeRequest: (k: string) => { mocks.budgetCalls++; return real.checkBeforeRequest(k) } }
})

const store = new Map<string, string>()
const g = globalThis as any
g.localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)) },
  removeItem: (k: string) => { store.delete(k) },
}

let chatCalls: { content: string }[] = []

function setupWindow(contents: Record<string, string>, extraFiles: string[] = []) {
  const files = [...Object.keys(contents), ...extraFiles]
  g.window = {
    dispatchEvent: () => true,
    electronAPI: {
      fs: {
        exists: async () => false,
        projectFilesInfo: async () => ({ files, truncated: false }),
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
          chatCalls.push({ content: args.messages.find(m => m.role === 'user')!.content })
          return { content: '{"findings":[]}', usage: { prompt_tokens: 1, completion_tokens: 1 } }
        },
      },
    },
  }
}

/** 99文字の行を n 行（各行は改行つきで100文字）。 */
const lines = (n: number, tag = 'row') => Array.from({ length: n }, (_, i) => `// ${tag}${String(i).padStart(4, '0')} ${'word '.repeat(18)}`.slice(0, 99)).join('\n') + '\n'

beforeEach(() => {
  store.clear()
  chatCalls = []
  mocks.budgetCalls = 0
})

describe('planAiCheck は、プロジェクトの外を指すリンクを読まない', () => {
  it('★ 閉じ込めた読み口が「読めない」と答えたファイルは、中身を使わず、読めなかった扱い', async () => {
    setupWindow({ 'a.html': lines(5), 'notes.txt': 'AKIAIOSFODNN7EXAMPLE outside-secret' })
    const base = g.window.electronAPI.fs.readForWriteFix
    // 閉じ込めた口は、リンクで外を指すものを unreadable と答える。素の readFile はそのまま読めてしまう
    g.window.electronAPI.fs.readForWriteFix = async (dir: string, rel: string) =>
      rel === 'notes.txt' ? { state: 'unreadable' } : base(dir, rel)
    const { planAiCheck } = await import('../src/renderer/securityCheck')
    const plan = await planAiCheck('/proj')
    expect(plan.unreadable).toEqual(['notes.txt'])
    expect(JSON.stringify(plan.batches)).not.toContain('outside-secret')
  })
})

describe('planAiCheck は読むだけ', () => {
  it('★ 通信しない・利用量を見ない', async () => {
    setupWindow({ 'a.html': lines(10), 'b.js': lines(10) })
    const { planAiCheck } = await import('../src/renderer/securityCheck')
    const plan = await planAiCheck('/proj')
    expect(chatCalls).toHaveLength(0)
    expect(mocks.budgetCalls).toBe(0)
    expect(plan.nothing).toBe(false)
    expect(plan.files).toBe(2)
    expect(plan.mode).toBe('static')
  })

  it('1ファイルが3つに分かれるとき、startLine は前のかたまりまでの改行の数＋1。つなぐと伏せたあとの全文に戻る', async () => {
    const body = lines(130)
    setupWindow({ 'big.js': body })
    const { planAiCheck } = await import('../src/renderer/securityCheck')
    const plan = await planAiCheck('/proj')
    const pieces = plan.batches.flat()
    expect(pieces).toHaveLength(3)
    let newlines = 0
    for (const p of pieces) {
      expect(p.startLine).toBe(newlines + 1)
      newlines += p.text.split('\n').length - 1
    }
    expect(pieces.map(p => p.startLine)).toEqual([1, 61, 121])
    expect(pieces.map(p => p.text).join('')).toBe(maskSecretShapes(body))
    // 行番号は本文に混ぜない
    expect(pieces[1].text.startsWith('// row0060')).toBe(true)
  })

  it('行の途中で切れたかたまり（改行の無い長い行）は、次のかたまりが同じ行の番号から始まる', async () => {
    const { splitIntoPieces } = await import('../src/renderer/securityCheck')
    const text = 'head\n' + 'x'.repeat(30) + '\ntail\n'
    const pieces = splitIntoPieces('a.js', text, 10)
    expect(pieces.map(p => p.text).join('')).toBe(text)
    expect(pieces[0].startLine).toBe(1)
    // 2つめは 'x' の行（2行目）の途中から。3つめ以降も、改行を越えるまでは同じ2行目
    expect(pieces[1].startLine).toBe(2)
    expect(pieces[2].startLine).toBe(2)
    const last = pieces[pieces.length - 1]
    expect(last.startLine).toBe(text.slice(0, text.length - last.text.length).split('\n').length)
  })

  it('★ promptChars は、同じ計画を runAiCheck に流したときに送られた user の本文の長さの合計。requests は送った回数', async () => {
    // 4ファイル×約5,000文字 → 24,000文字の束を超えて2回に分かれる
    setupWindow({ 'a.html': lines(50, 'a'), 'b.html': lines(50, 'b'), 'c.html': lines(50, 'c'), 'd.html': lines(50, 'd'), 'e.html': lines(50, 'e') })
    const { planAiCheck, runAiCheck } = await import('../src/renderer/securityCheck')
    const plan = await planAiCheck('/proj')
    expect(plan.requests).toBe(plan.batches.length)
    expect(plan.requests).toBeGreaterThan(1)
    expect(chatCalls).toHaveLength(0)
    await runAiCheck(plan, 'key-1')
    expect(chatCalls).toHaveLength(plan.requests)
    expect(chatCalls.reduce((n, c) => n + c.content.length, 0)).toBe(plan.promptChars)
    expect(plan.promptChars).toBeGreaterThan(0)
  })

  it('名前だけ渡すファイル（others）だけの回も、1回送る（promptChars・requests に数える）', async () => {
    setupWindow({}, ['server.py'])
    const { planAiCheck, runAiCheck } = await import('../src/renderer/securityCheck')
    const plan = await planAiCheck('/proj')
    expect(plan.nothing).toBe(false)
    expect(plan.others).toEqual(['server.py'])
    expect(plan.files).toBe(0)
    expect(plan.requests).toBe(1)
    await runAiCheck(plan, 'key-1')
    expect(chatCalls.map(c => c.content.length)).toEqual([plan.promptChars])
  })

  it('点検する対象が1つも無いとき nothing が真・送る回は0', async () => {
    setupWindow({}, ['logo.png'])
    const { planAiCheck } = await import('../src/renderer/securityCheck')
    const plan = await planAiCheck('/proj')
    expect(plan.nothing).toBe(true)
    expect(plan.requests).toBe(0)
    expect(plan.promptChars).toBe(0)
    expect(plan.assets).toEqual(['logo.png'])
    expect(plan.partial).toEqual([])
    expect(plan.skipped).toEqual([])
  })

  it('★ 並べ替えで束の数が変わる入力でも、requests は送った回数・promptChars は送った本文の合計と一致する', async () => {
    // 名前の順なら [a+b][c+d] の2回、小さい順に詰めると3回になる大小の混ざった入力
    setupWindow({ 'a.js': lines(150, 'a'), 'b.js': lines(60, 'b'), 'c.js': lines(150, 'c'), 'd.js': lines(60, 'd') })
    const { planAiCheck, runAiCheck } = await import('../src/renderer/securityCheck')
    const plan = await planAiCheck('/proj')
    await runAiCheck(plan, 'key-1')
    expect(chatCalls).toHaveLength(plan.requests)
    expect(plan.requests).toBe(plan.batches.length)
    expect(chatCalls.reduce((n, c) => n + c.content.length, 0)).toBe(plan.promptChars)
  })

  it('量が多くて送らないファイルは skipped に入り、files に数えない（files は、送る束に入っているファイルの数）', async () => {
    const contents: Record<string, string> = {}
    for (let i = 0; i < 9; i++) contents[`big${i}.js`] = lines(200, `f${i}`)
    setupWindow(contents)
    const { planAiCheck } = await import('../src/renderer/securityCheck')
    const plan = await planAiCheck('/proj')
    expect(plan.skipped.length).toBeGreaterThan(0)
    expect(plan.files).toBe(9 - plan.skipped.length)
    expect(plan.files).toBe(new Set(plan.batches.flat().map(p => p.file)).size)
    for (const f of plan.skipped) expect(plan.batches.flat().some(p => p.file === f)).toBe(false)
  })

  it('読めなかったファイルは unreadable に入り、files に数えない', async () => {
    setupWindow({ 'a.html': lines(3) }, ['broken.html'])
    const { planAiCheck } = await import('../src/renderer/securityCheck')
    const plan = await planAiCheck('/proj')
    expect(plan.unreadable).toEqual(['broken.html'])
    expect(plan.files).toBe(1)
  })
})
