import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AI_CHECK_SYSTEM } from '../src/shared/aiCheckPrompt'

// 「AI の確認」の送信と読み取り。偽の fs と偽の sakura.chat に実際に流し、
// 送った依頼文と、返ってきた結果（findings・report・parts）を見る。

const mocks = vi.hoisted(() => ({
  budget: { allowed: true } as { allowed: boolean; message?: string; warning?: string },
  usage: [] as unknown[][],
}))
vi.mock('../src/renderer/usage', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/renderer/usage')>()
  return {
    ...real,
    checkBeforeRequest: () => mocks.budget,
    recordUsage: (...args: unknown[]) => { mocks.usage.push(args) },
  }
})

const store = new Map<string, string>()
const g = globalThis as any
g.localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)) },
  removeItem: (k: string) => { store.delete(k) },
}

type Sent = { system: string; user: string }
let sent: Sent[] = []
let reply: (n: number) => string = () => '{"findings":[]}'
let withUsage = true

const PAGE = '<html>\n<body>\n<p>hello</p>\n<script>document.write(location.hash)</script>\n</body>\n</html>\n'

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
          sent.push({
            system: args.messages.find(m => m.role === 'system')!.content,
            user: args.messages.find(m => m.role === 'user')!.content,
          })
          return { content: reply(sent.length), usage: withUsage ? { prompt_tokens: 1, completion_tokens: 1 } : undefined }
        },
      },
    },
  }
}

const J = (findings: unknown[]) => JSON.stringify({ findings })
const htmlFinding = (o: Record<string, unknown> = {}) => ({
  file: 'a.html', line: 99, kind: 'input-to-html', quote: 'document.write(location.hash)', note: '入力をそのまま出しています', ...o,
})

beforeEach(() => {
  store.clear()
  sent = []
  reply = () => '{"findings":[]}'
  mocks.budget = { allowed: true }
  mocks.usage = []
  withUsage = true
})

describe('正しい返事', () => {
  it('★ 指摘が result.findings に入り、行は Koto が決めた行（AI の言う行ではない）', async () => {
    setupWindow({ 'a.html': PAGE })
    reply = () => J([htmlFinding()])
    const { runSecurityCheck } = await import('../src/renderer/securityCheck')
    const r = await runSecurityCheck('/proj', 'key-1')
    expect(r.verdict).toBe('warn')
    expect(r.findings).toHaveLength(1)
    expect(r.findings![0]).toMatchObject({ file: 'a.html', line: 4, kind: 'input-to-html', certainty: 'ai', severity: 'should' })
    expect(r.report).toContain('a.html:4')
    expect(r.report).toContain('直したほうがよい')
    expect(r.parts!.every(p => p.ai === false)).toBe(true)
  })

  it('指摘が無い返事は ok', async () => {
    setupWindow({ 'a.html': PAGE })
    const { runSecurityCheck } = await import('../src/renderer/securityCheck')
    const r = await runSecurityCheck('/proj', 'key-1')
    expect(r.verdict).toBe('ok')
    expect(r.findings).toEqual([])
    expect(r.report).toContain('確認した範囲では、問題は見つかりませんでした。')
  })

  it('★ 送った依頼文: system は AI_CHECK_SYSTEM、本文は行番号つき・囲み（対）・JSON の形の指定つき', async () => {
    setupWindow({ 'a.html': PAGE })
    const { runSecurityCheck } = await import('../src/renderer/securityCheck')
    await runSecurityCheck('/proj', 'key-1')
    expect(sent).toHaveLength(1)
    expect(sent[0].system).toBe(AI_CHECK_SYSTEM)
    const u = sent[0].user
    expect(u).toContain('4| <script>document.write(location.hash)</script>')
    const open = u.match(/<<<KOTO-EXT-([0-9a-f]+)>>>/)
    expect(open).not.toBeNull()
    expect(u).toContain(`<<<END-KOTO-EXT-${open![1]}>>>`)
    expect(u).toContain('{"findings":[{"file":"ファイル名","line":行番号,"kind":"種類","quote":"その行の中身","note":"何が問題かを1文で"}]}')
    expect(u).not.toContain('判定: 問題なし')
  })
})

describe('返事を信用しない', () => {
  it('★ 旧い形の返事（「判定: 問題なし」で始まる文）は読めない回。全部の回がそうなら skip', async () => {
    setupWindow({ 'a.html': PAGE })
    reply = () => '判定: 問題なし\n- 特に問題は見つかりませんでした'
    const { runSecurityCheck } = await import('../src/renderer/securityCheck')
    const r = await runSecurityCheck('/proj', 'key-1')
    expect(r.verdict).toBe('skip')
    expect(r.report).toBe('AI の返事を読み取れませんでした。もう一度試すか、設定で別のモデルを選んでください。')
  })

  it('空の返事も読めない回', async () => {
    setupWindow({ 'a.html': PAGE })
    reply = () => ''
    const { runSecurityCheck } = await import('../src/renderer/securityCheck')
    const r = await runSecurityCheck('/proj', 'key-1')
    expect(r.verdict).toBe('skip')
    expect(r.report).toContain('AI の返事を読み取れませんでした。')
  })

  it('★ 送っていないファイル名の指摘は、result にも report にも出ない', async () => {
    setupWindow({ 'a.html': PAGE })
    reply = () => J([htmlFinding({ file: 'ghost-file.html' })])
    const { runSecurityCheck } = await import('../src/renderer/securityCheck')
    const r = await runSecurityCheck('/proj', 'key-1')
    expect(r.findings).toEqual([])
    expect(JSON.stringify(r)).not.toContain('ghost-file')
  })

  it('★ 返事の note に秘密の形の文字列があっても、値の並びは result に残らない', async () => {
    const secret = 'AKIA' + 'ABCDEFGHIJKLMNOP'
    setupWindow({ 'a.html': PAGE })
    reply = () => J([htmlFinding({ note: `キー ${secret} が書かれています`, quote: `x ${secret}` })])
    const { runSecurityCheck } = await import('../src/renderer/securityCheck')
    const r = await runSecurityCheck('/proj', 'key-1')
    expect(r.findings).toHaveLength(1)
    const all = JSON.stringify({ report: r.report, parts: r.parts, findings: r.findings })
    expect(all).not.toContain(secret)
    expect(all).not.toContain('ABCDEFGHIJKLMNOP')
  })

  it('名前だけ渡したファイルへの指摘は、行なしで入る', async () => {
    setupWindow({}, ['server.py'])
    reply = () => J([{ file: 'server.py', line: 0, kind: 'secret-exposed', quote: '', note: '名前が疑わしい' }])
    const { runSecurityCheck } = await import('../src/renderer/securityCheck')
    const r = await runSecurityCheck('/proj', 'key-1')
    expect(r.findings).toHaveLength(1)
    expect(r.findings![0].file).toBe('server.py')
    expect(r.findings![0].line).toBeUndefined()
    expect(r.report).toContain('・server.py ')
  })
})

describe('利用量', () => {
  it('★ warning があるとき、report の2行目がその文（言い換えない）', async () => {
    setupWindow({ 'a.html': PAGE })
    mocks.budget = { allowed: true, warning: '今月の上限に近づいています' }
    const { runSecurityCheck } = await import('../src/renderer/securityCheck')
    const r = await runSecurityCheck('/proj', 'key-1')
    const lines = r.report.split('\n')
    expect(lines[0]).toBe('判定: 問題なし')
    expect(lines[1]).toBe('今月の上限に近づいています')
  })

  it('★ allowed でないとき、要求は0件で、今の文の skip', async () => {
    setupWindow({ 'a.html': PAGE })
    mocks.budget = { allowed: false, message: 'x' }
    const { runSecurityCheck } = await import('../src/renderer/securityCheck')
    const r = await runSecurityCheck('/proj', 'key-1')
    expect(sent).toHaveLength(0)
    expect(r).toEqual({ verdict: 'skip', report: 'AI利用上限に達しているため、セキュリティチェックを省略しました。' })
  })

  it('キーが無いとき、要求は0件で、今の文の skip', async () => {
    setupWindow({ 'a.html': PAGE })
    const { runSecurityCheck } = await import('../src/renderer/securityCheck')
    const r = await runSecurityCheck('/proj', '')
    expect(sent).toHaveLength(0)
    expect(r.report).toBe('APIキーが未設定のため、セキュリティチェックを省略しました。')
  })

  it('対象が無いとき、要求は0件で、今の文の skip', async () => {
    setupWindow({}, ['logo.png'])
    const { runSecurityCheck } = await import('../src/renderer/securityCheck')
    const r = await runSecurityCheck('/proj', 'key-1')
    expect(sent).toHaveLength(0)
    expect(r).toEqual({ verdict: 'skip', report: 'チェック対象のコードファイルが見つかりませんでした。' })
  })
})

describe('runAiCheck を直に呼ぶ（計画のあと）', () => {
  it('★ キーが無いとき・上限で止める設定のとき、要求は0件で、今の文の skip', async () => {
    setupWindow({ 'a.html': PAGE })
    const { planAiCheck, runAiCheck } = await import('../src/renderer/securityCheck')
    const plan = await planAiCheck('/proj')
    expect(plan.requests).toBe(1)

    const noKey = await runAiCheck(plan, '')
    expect(sent).toHaveLength(0)
    expect(noKey).toEqual({ verdict: 'skip', report: 'APIキーが未設定のため、セキュリティチェックを省略しました。' })

    mocks.budget = { allowed: false, message: 'x' }
    const over = await runAiCheck(plan, 'key-1')
    expect(sent).toHaveLength(0)
    expect(over).toEqual({ verdict: 'skip', report: 'AI利用上限に達しているため、セキュリティチェックを省略しました。' })
  })

  it('許されているとき、計画のとおりに送り、warning は報告の2行目に入る', async () => {
    setupWindow({ 'a.html': PAGE })
    mocks.budget = { allowed: true, warning: '今月の上限に近づいています' }
    const { planAiCheck, runAiCheck } = await import('../src/renderer/securityCheck')
    const plan = await planAiCheck('/proj')
    const r = await runAiCheck(plan, 'key-1')
    expect(sent).toHaveLength(1)
    expect(r.report.split('\n')[1]).toBe('今月の上限に近づいています')
  })

  it('中止の関数は、直に呼んだ実行にも効く（押したあとは新しい要求を出さず、中止の skip）', async () => {
    setupWindow({ 'a.html': PAGE })
    const { planAiCheck, runAiCheck } = await import('../src/renderer/securityCheck')
    const plan = await planAiCheck('/proj')
    // 受け取ったその場で押す（最初の要求より前）
    const r = await runAiCheck(plan, 'key-1', undefined, fn => { fn() })
    expect(sent).toHaveLength(0)
    expect(r.verdict).toBe('skip')
    expect(r.report).toContain('最後まで確認していません')
  })
})

const longPage = (name: string) => `<!-- ${name} -->\n` + 'a'.repeat(5000)

describe('利用量の記録', () => {
  it('★ 回ごとに1回、送った依頼文と返事の長さから見積もった量が記録される', async () => {
    const { estimateTokens } = await import('../src/renderer/usage')
    const contents: Record<string, string> = {}
    for (let i = 0; i < 6; i++) contents[`p${i}.html`] = longPage(`p${i}.html`)
    setupWindow(contents)
    withUsage = false
    reply = n => J(n === 1 ? [] : [htmlFinding({ file: 'p5.html', note: 'x'.repeat(40) })])
    const { runSecurityCheck } = await import('../src/renderer/securityCheck')
    await runSecurityCheck('/proj', 'key-1')
    expect(sent).toHaveLength(2)
    expect(mocks.usage).toHaveLength(2)
    sent.forEach((s, i) => {
      const [key, , promptTokens, completionTokens] = mocks.usage[i]
      expect(key).toBe('key-1')
      expect(promptTokens).toBe(estimateTokens(s.user))
      expect(completionTokens).toBe(estimateTokens(reply(i + 1)))
    })
    expect(mocks.usage[0][2]).not.toBe(mocks.usage[1][2])
  })

  it('返事に利用量が付いていれば、その数が記録される', async () => {
    setupWindow({ 'a.html': PAGE })
    const { runSecurityCheck } = await import('../src/renderer/securityCheck')
    await runSecurityCheck('/proj', 'key-1')
    expect(mocks.usage).toHaveLength(1)
    expect(mocks.usage[0].slice(2)).toEqual([1, 1])
  })

  it('要求を送らない skip（キー無し・上限）では記録しない', async () => {
    setupWindow({ 'a.html': PAGE })
    const { runSecurityCheck } = await import('../src/renderer/securityCheck')
    await runSecurityCheck('/proj', '')
    mocks.budget = { allowed: false, message: 'x' }
    await runSecurityCheck('/proj', 'key-1')
    expect(mocks.usage).toHaveLength(0)
  })
})

describe('配られるファイルかどうかで、秘密の指摘の重さが分かれる', () => {
  const secret = (file: string) => ({ file, line: 1, kind: 'secret-exposed', quote: 'const token = readToken(request)', note: '値が見える' })
  const NODE_FILES = {
    'package.json': '{"scripts":{"start":"node server.js"}}',
    'server.js': 'const http = require("http")\nhttp.createServer()\n',
    'public/app.js': 'const token = readToken(request)\n',
    'lib/util.js': 'const token = readToken(request)\n',
  }

  it('★ node のアプリでは、public/ の下の指摘は now、それ以外のコードの指摘は should', async () => {
    setupWindow(NODE_FILES)
    reply = () => J([secret('public/app.js'), secret('lib/util.js')])
    const { runSecurityCheck } = await import('../src/renderer/securityCheck')
    const r = await runSecurityCheck('/proj', 'key-1')
    const by = (file: string) => r.findings!.find(x => x.file === file)!
    expect(by('public/app.js')).toMatchObject({ severity: 'now', certainty: 'ai' })
    expect(by('lib/util.js')).toMatchObject({ severity: 'should', certainty: 'ai' })
  })

  it('★ 名前だけ渡したファイルも同じ。public/ の下の名前は now、そうでなければ should', async () => {
    setupWindow(NODE_FILES, ['public/dump.py', 'tool.py'])
    reply = () => J([
      { file: 'public/dump.py', line: 0, kind: 'secret-exposed', quote: '', note: '名前が疑わしい' },
      { file: 'tool.py', line: 0, kind: 'secret-exposed', quote: '', note: '名前が疑わしい' },
    ])
    const { runSecurityCheck } = await import('../src/renderer/securityCheck')
    const r = await runSecurityCheck('/proj', 'key-1')
    const by = (file: string) => r.findings!.find(x => x.file === file)!
    expect(by('public/dump.py').severity).toBe('now')
    expect(by('tool.py').severity).toBe('should')
  })

  it('対照: 静的なサイトでは、どのファイルも配られるので now', async () => {
    setupWindow({ 'a.html': 'const token = readToken(request)\n', 'lib/x.js': 'const token = readToken(request)\n' })
    reply = () => J([secret('lib/x.js')])
    const { runSecurityCheck } = await import('../src/renderer/securityCheck')
    const r = await runSecurityCheck('/proj', 'key-1')
    expect(r.findings![0]).toMatchObject({ file: 'lib/x.js', severity: 'now' })
  })
})

describe('依頼文に載せていない名前への指摘は、送った名前として受け入れない', () => {
  const nameItem = (file: string) => ({ file, line: 0, kind: 'secret-exposed', quote: '', note: '名前が疑わしい' })

  it('★ 秘密らしい名前が上限（20件）を超えたぶんは、指しても読み取れなかった指摘になる', async () => {
    const secrets = Array.from({ length: 21 }, (_, i) => `d${String(i).padStart(2, '0')}/credentials.json`)
    setupWindow({ 'a.html': PAGE }, secrets)
    reply = () => J([nameItem(secrets[19]), nameItem(secrets[20])])
    const { runSecurityCheck } = await import('../src/renderer/securityCheck')
    const r = await runSecurityCheck('/proj', 'key-1')
    expect(r.findings!.map(x => x.file)).toEqual([secrets[19]])
    expect(r.report).toContain('読み取れなかったものが1件')
  })

  it('★ 対象外の名前が上限（80件）を超えたぶんは、指しても読み取れなかった指摘になる', async () => {
    const others = Array.from({ length: 81 }, (_, i) => `o${String(i).padStart(2, '0')}.py`)
    setupWindow({ 'a.html': PAGE }, others)
    reply = () => J([nameItem(others[79]), nameItem(others[80])])
    const { runSecurityCheck } = await import('../src/renderer/securityCheck')
    const r = await runSecurityCheck('/proj', 'key-1')
    expect(r.findings!.map(x => x.file)).toEqual([others[79]])
    expect(r.report).toContain('読み取れなかったものが1件')
  })

  it('★ .env への指摘は、公開されないので取り上げない（要確認にもならない）', async () => {
    setupWindow({ 'a.html': PAGE }, ['.env'])
    reply = () => J([nameItem('.env')])
    const { runSecurityCheck } = await import('../src/renderer/securityCheck')
    const r = await runSecurityCheck('/proj', 'key-1')
    expect(r.findings).toEqual([])
    expect(r.verdict).toBe('ok')
  })
})

describe('指摘の行は、送った本文の行から Koto が決める', () => {
  // 100文字の行を並べる。かたまりは6,000文字で切れるので、2つ目のかたまりは61行目から始まる
  const row = (i: number) => `// row${String(i).padStart(4, '0')} ${'word '.repeat(18)}`.slice(0, 99)
  const body = Array.from({ length: 100 }, (_, i) => (i + 1 === 80 ? 'document.write(location.hash)' : row(i + 1))).join('\n') + '\n'

  it('★ 2つ目のかたまりの中の行は、ファイルの中の行番号（かたまりの中の番号ではない）になる', async () => {
    setupWindow({ 'a.js': body })
    reply = () => J([{ file: 'a.js', line: 1, kind: 'input-to-html', quote: 'document.write(location.hash)', note: '入力をそのまま出しています' }])
    const { runSecurityCheck } = await import('../src/renderer/securityCheck')
    const r = await runSecurityCheck('/proj', 'key-1')
    expect(sent[0].user).toContain('80| document.write(location.hash)')
    expect(r.findings).toHaveLength(1)
    expect(r.findings![0]).toMatchObject({ file: 'a.js', line: 80, certainty: 'ai' })
  })

  it('★ ファイルの最後の行の次の番号（末尾の改行のあとの空の行）は、送っていない行なので受け入れない', async () => {
    setupWindow({ 'a.js': body })
    reply = () => J([
      { file: 'a.js', line: 101, kind: 'input-to-html', quote: '', note: 'どこか' },
      { file: 'a.js', line: 100, kind: 'input-to-query', quote: '', note: '最後の行' },
    ])
    const { runSecurityCheck } = await import('../src/renderer/securityCheck')
    const r = await runSecurityCheck('/proj', 'key-1')
    const past = r.findings!.find(x => x.kind === 'input-to-html')!
    const last = r.findings!.find(x => x.kind === 'input-to-query')!
    expect(past.line).toBeUndefined()
    expect(past.certainty).toBe('unverified')
    expect(last.line).toBe(100)
    expect(last.certainty).toBe('unverified')
  })
})
