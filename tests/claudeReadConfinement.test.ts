// tests/claudeReadConfinement.test.ts — Claude の読み取り（Read・Glob・Grep）をプロジェクトの中に閉じ込める配線（P42-5）と、
// ページを読む道具（fetch_url）の「✋ 毎回確認」での URL 確認を固定する。
//
// 穴: Read・Glob・Grep を allowedTools に名前だけで入れると、SDK は canUseTool を呼ばずにプロジェクトの外の絶対パスも読ませ、
// fetch_url も承認を通らなかった（✋ でも、外を読んで URL で外へ送れる道ができる）。
// 直し: allowedTools から Read・Glob・Grep を外す（SDK は cwd と additionalDirectories の外だけ canUseTool へ回す）。
// canUseTool は、SDK が外と判定した呼び出しと、Koto 自身の realpath の判定のどちらかが外なら、利用者に聞かずに断る。
// fetch_url は ✋ のときだけ許可の一覧から外し、取得する前に URL を見せて確認する。
//
// 偽にするのは SDK（startClaudeChat の第2引数）・承認の窓（requestApproval）・取得（fetchUrlPage）。判定は本物。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const approvals = vi.hoisted(() => ({
  calls: [] as { turnId: string; dir: string | null; label: string }[],
  answer: true,
}))
vi.mock('../src/main/chat/approvalStore', () => ({
  requestApproval: async (entry: { turnId: string; dir: string | null; label: string }) => {
    approvals.calls.push(entry)
    return approvals.answer
  },
}))
const web = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('../src/main/ipc/web', () => ({
  fetchUrlPage: async (url: string) => { web.calls.push(url); return { url, finalUrl: url, status: 200, contentType: 'text/plain', text: '本文です', truncated: false } },
}))
vi.mock('../src/main/ipc/sakura', () => ({
  sakuraClient: () => ({ chat: { completions: { create: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '' } }], usage: {} }) } } }),
  isContextLimitError: () => false,
  safeMaxTokens: () => null,
}))

import { startClaudeChat, makeCanUseTool, claudeToolGatingOptions, type ClaudeSdkModule } from '../src/main/claude/agent'
import { IDE_MCP_SERVER_NAME, resolveIdeTools } from '../src/main/claude/toolText'
import { fetchUrlApprovalLabel, fetchUrlDenialMessage } from '../src/shared/approvalPlan'

const FETCH = `mcp__${IDE_MCP_SERVER_NAME}__fetch_url`
let base = ''
let project = ''
let outside = ''

beforeEach(() => {
  approvals.calls = []
  approvals.answer = true
  web.calls = []
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koto-read-confine-')))
  project = path.join(base, 'proj')
  outside = path.join(base, 'outside')
  fs.mkdirSync(path.join(project, 'public'), { recursive: true })
  fs.mkdirSync(path.join(project, 'sub'), { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(project, 'a.txt'), 'a')
  fs.writeFileSync(path.join(project, 'public', 'p.txt'), 'p')
  fs.writeFileSync(path.join(project, '.env'), 'X=1')
  fs.writeFileSync(path.join(outside, 'secret.txt'), 's')
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(project, 'link-out.txt'))
  fs.symlinkSync(outside, path.join(project, 'dir-out'))
  fs.symlinkSync(path.join(project, 'a.txt'), path.join(project, 'link-in.txt'))
})
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }) })

const call = (tool: string, input: Record<string, unknown>, root = project, mode: 'auto' | 'confirm' = 'auto', sdkOpts: object = {}) =>
  makeCanUseTool(project, root, mode, 't')(tool, input, { signal: new AbortController().signal, ...sdkOpts } as any) as Promise<{ behavior: string; message?: string }>

describe('P42-5: Read・Glob・Grep は、プロジェクトの中なら許可（窓なし）・外なら断る（窓なし）', () => {
  const insideCases: [string, string, Record<string, unknown>][] = [
    ['Read 絶対パス（中）', 'Read', { file_path: '/P/a.txt' }],
    ['Read 相対（中）', 'Read', { file_path: 'a.txt' }],
    ['Read 隠しファイル（中）', 'Read', { file_path: '.env' }],
    ['Read 中を指すリンク', 'Read', { file_path: 'link-in.txt' }],
    ['Read まだ無いファイル（中）', 'Read', { file_path: 'new.txt' }],
    ['Glob 相対 pattern', 'Glob', { pattern: '**/*.txt' }],
    ['Glob path（中）', 'Glob', { pattern: '*.txt', path: 'sub' }],
    ['Glob 絶対 pattern（中）', 'Glob', { pattern: '/P/*.txt' }],
    ['Read 中の「..」で始まる名前のファイル', 'Read', { file_path: '..cache/x' }],
    ['Glob 枝のあとの /** （絶対パスではない）', 'Glob', { pattern: 'src/{main,renderer}/**/*.ts' }],
    ['Glob 末尾の枝', 'Glob', { pattern: '**/*.{ts,tsx}' }],
    ['Grep path なし', 'Grep', { pattern: 'a' }],
    ['Grep path（中）', 'Grep', { pattern: 'a', path: '/P/sub' }],
  ]
  for (const root of ['project', 'public'] as const) {
    for (const [name, tool, input] of insideCases) {
      it(`中 → 許可・窓なし（作業フォルダ=${root}）: ${name}`, async () => {
        const fixed = JSON.parse(JSON.stringify(input).replace('/P/', project + '/').replace('/P"', project + '"'))
        const r = await call(tool, fixed, root === 'project' ? project : path.join(project, 'public'))
        expect(r.behavior).toBe('allow')
        expect(approvals.calls).toHaveLength(0)
      })
    }
  }

  const outsideCases: [string, string, (o: string, pre: string) => Record<string, unknown>][] = [
    ['Read 外の絶対パス', 'Read', o => ({ file_path: `${o}/secret.txt` })],
    ['Read 相対の ..', 'Read', (_o, pre) => ({ file_path: `${pre}../outside/secret.txt` })],
    ['Read ~', 'Read', () => ({ file_path: '~/.zshrc' })],
    ['Read 外を指すリンク', 'Read', (_o, pre) => ({ file_path: `${pre}link-out.txt` })],
    ['Read 外を指すフォルダ経由', 'Read', (_o, pre) => ({ file_path: `${pre}dir-out/secret.txt` })],
    ['Read パス無し', 'Read', () => ({})],
    ['Glob 絶対パスの pattern', 'Glob', o => ({ pattern: `${o}/*.txt` })],
    ['Glob 相対 .. の pattern', 'Glob', (_o, pre) => ({ pattern: `${pre}../*.txt` })],
    ['Glob ~ の pattern', 'Glob', () => ({ pattern: '~/*' })],
    ['Glob 枝の中の絶対パス', 'Glob', o => ({ pattern: `{a.txt,${o}/secret.txt}` })],
    ['Glob 枝の中の絶対パス（先頭の枝）', 'Glob', () => ({ pattern: '{src,/etc}/x' })],
    ['Glob 枝の中の .. の段', 'Glob', () => ({ pattern: 'src/{a,../..}/x' })],
    ['Glob path（外）', 'Glob', o => ({ pattern: '*.txt', path: o })],
    ['Grep path（外）', 'Grep', o => ({ pattern: 's', path: o })],
    ['Grep 外を指すフォルダ', 'Grep', (_o, pre) => ({ pattern: 's', path: `${pre}dir-out` })],
  ]
  for (const root of ['project', 'public'] as const) {
    for (const [name, tool, mk] of outsideCases) {
      it(`外 → 断る・窓なし（作業フォルダ=${root}）: ${name}`, async () => {
        // 作業フォルダが public/ のときは、プロジェクト直下の相対パスに ../ を付けて同じものを指す
        const r = await call(tool, mk(outside, root === 'project' ? '' : '../'), root === 'project' ? project : path.join(project, 'public'))
        expect(r.behavior).toBe('deny')
        expect(r.message).toContain('プロジェクトの外のファイル（')
        expect(r.message).toContain('必要なファイルは、ユーザーにプロジェクトの中へ置いてもらってください。')
        expect(approvals.calls).toHaveLength(0)
      })
    }
  }

  it('おまかせ・✋ のどちらでも同じ（外は断り・窓なし）', async () => {
    for (const mode of ['auto', 'confirm'] as const) {
      expect((await call('Read', { file_path: `${outside}/secret.txt` }, project, mode)).behavior).toBe('deny')
      expect((await call('Read', { file_path: 'a.txt' }, project, mode)).behavior).toBe('allow')
    }
    expect(approvals.calls).toHaveLength(0)
  })

  it('SDK が外と判定して回してきた呼び出し（decisionReason・blockedPath）は、Koto の判定が中でも断る', async () => {
    const r = await call('Read', { file_path: 'a.txt' }, project, 'auto', { decisionReason: { type: 'other', reason: 'Path is outside allowed working directories' }, blockedPath: '/etc/hosts' })
    expect(r.behavior).toBe('deny')
    expect(r.message).toContain('/etc/hosts')
    const r2 = await call('Grep', { pattern: 'a' }, project, 'auto', { decisionReason: { type: 'other', reason: 'x' } })
    expect(r2.behavior).toBe('deny')
    expect(approvals.calls).toHaveLength(0)
  })

  it('断りの文は、外のパスを含めて固定', async () => {
    const r = await call('Read', { file_path: '/etc/hosts' })
    expect(r.message).toBe('プロジェクトの外のファイル（/etc/hosts）は読めません。Koto は、Claude の読み取りをプロジェクトの中に限っています。必要なファイルは、ユーザーにプロジェクトの中へ置いてもらってください。')
  })
})

// ── 偽の SDK ──
function runWith(writeMode: 'auto' | 'confirm', root = project) {
  const queries: { options: Record<string, any> }[] = []
  const sdk = {
    query: (arg: any) => { queries.push(arg); return (async function* () { yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, duration_ms: 1 } })() },
    tool: (name: string, description: string, schema: unknown, handler: any) => ({ name, description, schema, handler }),
    createSdkMcpServer: (o: any) => ({ type: 'sdk', name: o.name, instance: {}, tools: o.tools }),
  } as unknown as ClaudeSdkModule
  return new Promise<{ options: Record<string, any> }>(resolve => {
    startClaudeChat({
      projectDir: project, writeRoot: root, apiKey: 'k', writeMode, aiEngineKey: null, rag: null,
      prompt: 'x', images: [], snapshotId: 's', resumeSessionId: null, model: '',
      onEvent: e => { if (e.kind === 'result' || e.kind === 'error') resolve(queries[0]) },
      onOpenPreview: async () => '', ragBudgetCheck: () => ({ allowed: true }), onDelegated: () => {}, onFileWritten: () => {},
    }, sdk)
  })
}

/** SDK のふるまいの写し: 許可の一覧にある道具は canUseTool を通さず実行・無い道具は canUseTool が allow のときだけ実行。 */
async function sdkInvokeFetch(q: { options: Record<string, any> }, url: string) {
  const allowedByList = (q.options.allowedTools as string[]).includes(FETCH)
  const handler = (q.options.mcpServers[IDE_MCP_SERVER_NAME].tools as any[]).find(t => t.name === 'fetch_url').handler
  if (!allowedByList) {
    const r = await q.options.canUseTool(FETCH, { url }, { signal: new AbortController().signal })
    if (r.behavior !== 'allow') return r
  }
  await handler({ url })
  return { behavior: 'allow' }
}

describe('P42-5: query() へ渡る options（allowedTools・additionalDirectories）', () => {
  it('Read・Glob・Grep は allowedTools に無い（auto・confirm とも）', async () => {
    for (const mode of ['auto', 'confirm'] as const) {
      const q = await runWith(mode)
      for (const t of ['Read', 'Glob', 'Grep']) expect(q.options.allowedTools).not.toContain(t)
      expect(q.options.tools).toEqual(expect.arrayContaining(['Read', 'Glob', 'Grep'])) // 内蔵の道具の絞り込みは変えない
      expect(q.options.disallowedTools).toEqual(['WebFetch', 'WebSearch'])
      expect(q.options.permissionMode).toBe('default')
    }
  })

  it('作業フォルダがプロジェクトそのものなら additionalDirectories は付けず、public/ のときはプロジェクトを足す', async () => {
    expect((await runWith('auto')).options.additionalDirectories).toBeUndefined()
    expect((await runWith('auto', path.join(project, 'public'))).options.additionalDirectories).toEqual([project])
  })

  it('fetch_url は ✋ のときだけ allowedTools から外れる（search_docs・open_preview は残る）', async () => {
    const auto = await runWith('auto')
    expect(auto.options.allowedTools).toContain(FETCH)
    const confirm = await runWith('confirm')
    expect(confirm.options.allowedTools).not.toContain(FETCH)
    expect(confirm.options.allowedTools).toContain(`mcp__${IDE_MCP_SERVER_NAME}__open_preview`)
    // 登録は残る（承認を通ったあと取得できる）
    expect((confirm.options.mcpServers[IDE_MCP_SERVER_NAME].tools as any[]).map(t => t.name)).toContain('fetch_url')
  })

  it('claudeToolGatingOptions: writeMode で fetch_url だけが変わる', () => {
    const names = resolveIdeTools({ hasAiEngineKey: true, ragEnabled: true }).qualifiedNames
    const a = claudeToolGatingOptions(names, 'auto').allowedTools!
    const c = claudeToolGatingOptions(names, 'confirm').allowedTools!
    expect(a.filter(t => !c.includes(t))).toEqual([FETCH])
  })
})

describe('P42-5: fetch_url の確認（取得する前に URL を見せる）', () => {
  const URL_ = 'https://example.com/docs?a=1'
  it('✋: 窓が1回・許可なら取得する', async () => {
    const q = await runWith('confirm')
    approvals.answer = true
    const r = await sdkInvokeFetch(q, URL_)
    expect(r.behavior).toBe('allow')
    expect(approvals.calls).toHaveLength(1)
    expect(approvals.calls[0].label).toBe('🌐 ページの読み取り（https://example.com/docs?a=1）')
    expect(approvals.calls[0].dir).toBe(project)
    expect(web.calls).toEqual([URL_])
  })

  it('✋: 拒否なら取得しない（偽の取得は 0 回）・断りの文が返る', async () => {
    const q = await runWith('confirm')
    approvals.answer = false
    const r = await sdkInvokeFetch(q, URL_) as { behavior: string; message?: string }
    expect(r.behavior).toBe('deny')
    expect(r.message).toBe(`ユーザーが ${URL_} の読み取りを許可しませんでした。読まずに、どう進めるべきかユーザーに確認してください。`)
    expect(approvals.calls).toHaveLength(1)
    expect(web.calls).toEqual([])
  })

  it('おまかせ: 窓 0 回・取得する', async () => {
    const q = await runWith('auto')
    approvals.answer = false // 聞かれたら断る設定にしても、聞かれない
    const r = await sdkInvokeFetch(q, URL_)
    expect(r.behavior).toBe('allow')
    expect(approvals.calls).toHaveLength(0)
    expect(web.calls).toEqual([URL_])
  })

  it('おまかせで canUseTool が呼ばれても確認なしで通す', async () => {
    expect((await call(FETCH, { url: URL_ }, project, 'auto')).behavior).toBe('allow')
    expect(approvals.calls).toHaveLength(0)
  })

  it('search_docs・open_preview は ✋ でも確認なし', async () => {
    for (const t of ['search_docs', 'open_preview']) {
      expect((await call(`mcp__${IDE_MCP_SERVER_NAME}__${t}`, {}, project, 'confirm')).behavior).toBe('allow')
    }
    expect(approvals.calls).toHaveLength(0)
  })

  it('長い URL も切らずに全部出す（末尾まで入る）・改行は空白にする・URL が無ければ不明と出す', () => {
    const long = 'https://example.com/' + 'a'.repeat(300) + '?token=SECRET_TAIL'
    expect(fetchUrlApprovalLabel(long)).toBe(`🌐 ページの読み取り（${long}）`)
    expect(fetchUrlApprovalLabel(long)).toContain('SECRET_TAIL')
    expect(fetchUrlApprovalLabel('https://a.example/\nx')).toBe('🌐 ページの読み取り（https://a.example/ x）')
    expect(fetchUrlDenialMessage(long)).toContain('SECRET_TAIL')
    expect(fetchUrlApprovalLabel('')).toBe('🌐 ページの読み取り（(不明なURL)）')
    expect(fetchUrlDenialMessage('')).toContain('このURL')
  })
})
