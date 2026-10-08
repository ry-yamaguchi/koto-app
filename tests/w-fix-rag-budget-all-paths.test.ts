// W-85（2026-09-27 決定）の「全部の道」を数えて固定するテスト: 上限を超えたら 📚 資料の検索も止める。
//
// ── なぜ「全部の道を数える」テストが要るか ──────────────────────────────────
// rag/client.ts に上限の確認の口（budgetCheck）ができたあと、「口はできたが渡していない呼び出し」が
// 3度続いた（ipc/rag.ts の3ハンドラだけ配線 → いちばん使われる turnRunner.ts の資料検索と
// claude/tools.ts の search_docs が漏れていた）。配線の固定テストを「いま知っている道」ごとに足すと、
// 次に増える道・見落としていた道は必ずすり抜ける。ここでは逆に、src/main の**全部の .ts**を読み、
// 📚 資料の API（queryDocuments・chatDocuments・uploadDocument）の**呼び出しを全部拾って**、
// どれにも budgetCheck が渡っていることを確かめる。新しい呼び出しが増えて budgetCheck を付け忘れれば、
// このテストが落ちる。
//
// ── 読み方（ソースの文字列一致にしない）─────────────────────────────────────
// 正規表現で `queryDocuments(` を拾うと、関数の定義・コメント・import に当たる（掟10「当て先が他の行に出ないか」）。
// TypeScript の構文木（typescript パッケージ）で読み、**呼び出し式だけ**を数える。関数の定義・import・コメントは
// 構文上そもそも呼び出しではない。呼び出さずに値として持ち回る（別名に入れる・引数で渡す）形は、
// 呼び出しの数え漏れになるので「呼び出し以外の参照」として別に検出して落とす。
// 見つけた呼び出しの数の**下限**も固定する（0件で素通り＝スキャナが壊れて何も拾わなくなる、を許さない）。
// スキャナ自体も、偽のソースを食わせて「付け忘れ・undefined を渡す・別名で持ち回る」を拾えることを確かめる。
//
// ── 振る舞い（掟10: お金の歯止めは偽 fetch に実際に流す）──────────────────────
// 上のスキャンは「渡しているか」しか見ない。渡した先で本当に通信が止まるかは、偽の fetch の呼び出し回数で確かめる:
//   - rag/client.ts: 上限超えなら fetch 0回・isBudgetStopError が true／上限内なら fetch 1回
//   - chat/turnRunner.ts の ragSearch: 上限超えなら fetch 0回・「止めた理由」を返す（'' にしない）
//   - claude/tools.ts の search_docs: 上限超えなら fetch 0回
// ここの usageStore は本物（保存先だけ使い捨て）。上限は「利用実績を記録して超えさせる」ことで作る。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as ts from 'typescript'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  /** ipc/claude.ts が startClaudeChat へ渡した引数（本物の startClaudeChat は SDK を起動するので偽物に差し替える）。 */
  started: null as null | Record<string, any>,
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => '/nonexistent-koto-test-userdata' },
}))
vi.mock('../src/main/claude/agent', () => ({
  startClaudeChat: (params: Record<string, any>) => { h.started = params; return { abort: () => {}, turnId: 'claude-test-turn' } },
}))
// tools.ts が import する、通信・electron に触れる部品だけ偽物にする（rag/client.ts は本物・fetch を偽にする）。
vi.mock('../src/main/ipc/sakura', () => ({
  sakuraClient: () => { throw new Error('このテストでは使わない') },
  isContextLimitError: () => false,
  safeMaxTokens: () => null,
}))
vi.mock('../src/main/ipc/web', () => ({
  fetchUrlPage: async () => { throw new Error('このテストでは使わない') },
  webSearch: async () => { throw new Error('このテストでは使わない') },
}))

import { queryDocuments, chatDocuments, uploadDocument, isBudgetStopError, RAG_API_BASE } from '../src/main/rag/client'
import { initUsageStore, setSettings, recordUsage, budgetCheckForKey, checkBeforeRequest } from '../src/main/usageStore'
import { hashKey } from '../src/shared/usageBudget'
import { buildMainIo } from '../src/main/chat/turnRunner'
import { buildIdeToolsServer } from '../src/main/claude/tools'
import { registerClaudeHandlers } from '../src/main/ipc/claude'

// ══ 1. 全部の道を数える（src/main の全 .ts の構文木）══════════════════════════════

/** 📚 資料の API のうち、AI Engine のモデルを使う3つ（一覧・取得・更新・削除・チャンク一覧はモデルを使わないので対象外）。 */
const MODEL_APIS = ['queryDocuments', 'chatDocuments', 'uploadDocument'] as const

type FoundCall = { file: string; line: number; api: string; hasBudgetCheck: boolean }
type Scan = { calls: FoundCall[]; escapes: { file: string; line: number; api: string }[] }

/** budgetCheck: <式> を持つオブジェクトリテラルが、呼び出しの引数の中にあるか。値が undefined／null／void 0 の「渡したつもり」は渡していない扱い。 */
function argsCarryBudgetCheck(call: ts.CallExpression): boolean {
  return call.arguments.some(arg => {
    if (!ts.isObjectLiteralExpression(arg)) return false
    return arg.properties.some(prop => {
      if (ts.isShorthandPropertyAssignment(prop)) return prop.name.text === 'budgetCheck'
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name) || prop.name.text !== 'budgetCheck') return false
      const v = prop.initializer
      if (ts.isIdentifier(v) && v.text === 'undefined') return false
      if (v.kind === ts.SyntaxKind.NullKeyword) return false
      if (ts.isVoidExpression(v)) return false
      return true
    })
  })
}

/** 1つのソース（ファイル名・本文）から、モデルを使う資料 API の呼び出しと「呼び出し以外の参照」を拾う。 */
function scanSource(file: string, text: string): Scan {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS)
  const out: Scan = { calls: [], escapes: [] }
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : ''
      if ((MODEL_APIS as readonly string[]).includes(name)) {
        out.calls.push({ file, line: lineOf(node), api: name, hasBudgetCheck: argsCarryBudgetCheck(node) })
      }
    } else if (ts.isIdentifier(node) && (MODEL_APIS as readonly string[]).includes(node.text)) {
      const p = node.parent
      const isDefinition = (ts.isFunctionDeclaration(p) && p.name === node) || ts.isImportSpecifier(p)
      const isCallee = (ts.isCallExpression(p) && p.expression === node)
        || (ts.isPropertyAccessExpression(p) && p.name === node && ts.isCallExpression(p.parent) && p.parent.expression === p)
      if (!isDefinition && !isCallee) out.escapes.push({ file, line: lineOf(node), api: node.text })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

function listTsFiles(dir: string): string[] {
  const files: string[] = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) files.push(...listTsFiles(full))
    else if (ent.isFile() && ent.name.endsWith('.ts') && !ent.name.endsWith('.d.ts')) files.push(full)
  }
  return files
}

const ROOT = path.join(__dirname, '..')
const MAIN_DIR = path.join(ROOT, 'src', 'main')

function scanMain(): { scan: Scan; fileCount: number } {
  const files = listTsFiles(MAIN_DIR)
  const scan: Scan = { calls: [], escapes: [] }
  for (const f of files) {
    const r = scanSource(path.relative(ROOT, f), fs.readFileSync(f, 'utf8'))
    scan.calls.push(...r.calls)
    scan.escapes.push(...r.escapes)
  }
  return { scan, fileCount: files.length }
}

describe('全部の道: src/main の 📚 資料 API（モデルを使う3つ）の呼び出しは、すべて budgetCheck を渡している（W-85）', () => {
  const { scan, fileCount } = scanMain()
  const where = (c: { file: string; line: number; api: string }) => `${c.file}:${c.line} ${c.api}`

  it('src/main の .ts を実際に読めている（ディレクトリの読み違いで0件素通りしない）', () => {
    expect(fileCount).toBeGreaterThan(50)
  })

  it('見つけた呼び出しの数の下限: 合計5件以上（rag:upload・rag:query・rag:chat・turnRunner の資料検索・tools の search_docs）', () => {
    // 0件で素通りしない（スキャナが壊れて何も拾わなくなったら、下の「全部渡している」は空の配列で通ってしまう）。
    // 呼び出しが減るのは、道を畳んだときだけ。そのときはこの下限を意図して下げること。
    expect(scan.calls.length).toBeGreaterThanOrEqual(5)
    const count = (api: string) => scan.calls.filter(c => c.api === api).length
    expect(count('queryDocuments')).toBeGreaterThanOrEqual(3) // ipc/rag.ts・chat/turnRunner.ts・claude/tools.ts
    expect(count('chatDocuments')).toBeGreaterThanOrEqual(1) // ipc/rag.ts
    expect(count('uploadDocument')).toBeGreaterThanOrEqual(1) // ipc/rag.ts
  })

  it('いま知っている5つの道は、その場所で拾えている（別の行に当たって数だけ合っている、を許さない）', () => {
    const at = (file: string, api: string) => scan.calls.filter(c => c.file === path.join('src', 'main', file) && c.api === api).length
    expect(at('ipc/rag.ts', 'uploadDocument')).toBe(1)
    expect(at('ipc/rag.ts', 'queryDocuments')).toBe(1)
    expect(at('ipc/rag.ts', 'chatDocuments')).toBe(1)
    expect(at('chat/turnRunner.ts', 'queryDocuments')).toBe(1)
    expect(at('claude/tools.ts', 'queryDocuments')).toBe(1)
  })

  it('どの呼び出しにも budgetCheck が渡っている（渡していない場所を全部並べる）', () => {
    const missing = scan.calls.filter(c => !c.hasBudgetCheck).map(where)
    expect(missing).toEqual([])
  })

  it('呼び出さずに値として持ち回る形（別名・引数渡し）が無い（呼び出しの数え漏れを許さない）', () => {
    expect(scan.escapes.map(where)).toEqual([])
  })

  it('関数の定義（rag/client.ts）・import・コメントは呼び出しに数えない（数えると budgetCheck を持たない定義で落ちる）', () => {
    expect(scan.calls.filter(c => c.file === path.join('src', 'main', 'rag', 'client.ts'))).toEqual([])
  })
})

describe('スキャナ自体の確認: 付け忘れ・「渡したつもり」・別名の持ち回りを拾い、定義とコメントは拾わない', () => {
  it('budgetCheck を渡していない呼び出しを、渡していない印で拾う', () => {
    const r = scanSource('x.ts', `import * as c from './c'\nasync function f(k: string) { await c.queryDocuments(k, 'q', { topK: 3 }) }`)
    expect(r.calls).toEqual([{ file: 'x.ts', line: 2, api: 'queryDocuments', hasBudgetCheck: false }])
  })

  it('budgetCheck を渡している呼び出しは、渡している印で拾う（普通の書き方・省略記法・スプレッドと併用）', () => {
    const r = scanSource('x.ts', [
      `c.queryDocuments(k, 'q', { budgetCheck: check })`,
      `c.chatDocuments(k, 'q', { chatModel: 'm', budgetCheck })`,
      `queryDocuments(k, 'q', { ...opts, budgetCheck: budgetCheckForKey(k) })`,
    ].join('\n'))
    expect(r.calls.map(c => [c.api, c.hasBudgetCheck])).toEqual([['queryDocuments', true], ['chatDocuments', true], ['queryDocuments', true]])
  })

  it('budgetCheck: undefined / null / void 0 の「渡したつもり」は渡していない扱い', () => {
    const r = scanSource('x.ts', [
      `c.queryDocuments(k, 'q', { budgetCheck: undefined })`,
      `c.queryDocuments(k, 'q', { budgetCheck: null })`,
      `c.uploadDocument(k, { filename: 'a', budgetCheck: void 0 })`,
    ].join('\n'))
    expect(r.calls.map(c => c.hasBudgetCheck)).toEqual([false, false, false])
  })

  it('オプションを変数で渡す呼び出し（中身が見えない）は、渡していない扱い（明示的に書かせる）', () => {
    const r = scanSource('x.ts', `c.queryDocuments(k, 'q', opts)`)
    expect(r.calls.map(c => c.hasBudgetCheck)).toEqual([false])
  })

  it('関数の定義・import・コメント・文字列の中の名前は、呼び出しに数えない', () => {
    const r = scanSource('x.ts', [
      `import { queryDocuments } from './c'`,
      `export async function queryDocuments(a: string) { return [] }`,
      `// queryDocuments(k, 'q') を呼ぶ`,
      `/* chatDocuments(k, 'q', {}) */`,
      `const s = "uploadDocument(k, {})"`,
    ].join('\n'))
    expect(r.calls).toEqual([])
    expect(r.escapes).toEqual([])
  })

  it('別名に入れる・引数として渡す（呼び出さずに持ち回る）形は、呼び出し以外の参照として拾う', () => {
    const r = scanSource('x.ts', [
      `const q = c.queryDocuments`,
      `run(uploadDocument)`,
      `const { chatDocuments } = c`,
    ].join('\n'))
    expect(r.escapes.map(e => e.api).sort()).toEqual(['chatDocuments', 'queryDocuments', 'uploadDocument'])
  })
})

// ══ 2. 振る舞い（偽の fetch に流す）══════════════════════════════════════════════

const KEY = 'TEST-KEY-ALL-PATHS'

/** 偽の fetch が受けた要求（URL）。 */
let calls: string[] = []
/** true の間、偽の fetch は HTTP 500 を返す（上限とは無関係の失敗を作る）。 */
let serverDown = false

const fakeFetch = async (url: string) => {
  calls.push(url)
  if (serverDown) return { ok: false, status: 500, text: async () => 'boom' } as any
  let body: unknown = {}
  if (url.endsWith('/v1/documents/query/')) {
    body = { results: [{ content: '抜粋の本文です', document: { id: 'd1', name: '手引き.md', status: 'available' } }] }
  } else if (url.endsWith('/v1/documents/chat/')) body = { answer: 'こたえ', sources: [] }
  else if (url.endsWith('/v1/documents/upload/')) body = { id: 'doc-1', name: 'a.md', status: 'pending' }
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as any
}

/** そのキーの今月の利用額を、上限（¥100）より大きくする。 */
function exceedLimit(apiKey: string) {
  recordUsage(hashKey(apiKey), 'gpt-oss-120b', 10_000_000, 10_000_000)
}

let tmpDir = ''
let projectDir = ''

beforeEach(() => {
  calls = []
  serverDown = false
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-rag-allpaths-'))
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-rag-allpaths-proj-'))
  initUsageStore(tmpDir)
  setSettings({ monthlyLimitYen: 100, enforce: true, warnRatio: 0.8, perKeyLimits: {} })
  vi.stubGlobal('fetch', vi.fn(fakeFetch))
})

afterEach(() => {
  vi.unstubAllGlobals()
  initUsageStore(null) // 保存のタイマーも止める
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.rmSync(projectDir, { recursive: true, force: true })
})

describe('rag/client.ts: 上限で止めたときは通信ゼロ・isBudgetStopError が true／上限内なら通信する', () => {
  const APIS: { name: string; url: string; run: (budgetCheck: () => { allowed: boolean; message?: string }) => Promise<unknown> }[] = [
    { name: 'queryDocuments', url: `${RAG_API_BASE}/v1/documents/query/`, run: (budgetCheck) => queryDocuments('key', 'これは何ですか', { budgetCheck }) },
    { name: 'chatDocuments', url: `${RAG_API_BASE}/v1/documents/chat/`, run: (budgetCheck) => chatDocuments('key', 'これは何ですか', { chatModel: 'm', budgetCheck }) },
    { name: 'uploadDocument', url: `${RAG_API_BASE}/v1/documents/upload/`, run: (budgetCheck) => uploadDocument('key', { content: 'ほんぶん', filename: 'a.md', budgetCheck }) },
  ]

  for (const api of APIS) {
    describe(api.name, () => {
      it('上限超え（allowed:false）: fetch は1回も呼ばれない・止めた例外は isBudgetStopError が true・文は budgetCheck の message', async () => {
        let caught: unknown
        try { await api.run(() => ({ allowed: false, message: '今月の上限に達しています' })) } catch (e) { caught = e }
        expect(caught).toBeInstanceOf(Error)
        expect((caught as Error).message).toBe('今月の上限に達しています')
        expect(isBudgetStopError(caught)).toBe(true)
        expect(calls).toHaveLength(0) // ★お金の歯止め: 止めたつもりで裏では呼んでいた、を許さない
      })

      it('message が無くても止まり、印は付く（既定文）', async () => {
        let caught: unknown
        try { await api.run(() => ({ allowed: false })) } catch (e) { caught = e }
        expect(isBudgetStopError(caught)).toBe(true)
        expect(calls).toHaveLength(0)
      })

      it('上限内（allowed:true）: fetch は1回呼ばれ、例外にならない', async () => {
        await expect(api.run(() => ({ allowed: true }))).resolves.not.toThrow()
        expect(calls).toEqual([api.url])
      })
    })
  }

  it('上限とは無関係の失敗（HTTP 500）は、止めた印が付かない（「上限で止めた」と誤って言わない）', async () => {
    serverDown = true
    let caught: unknown
    try { await queryDocuments('key', 'q', { budgetCheck: () => ({ allowed: true }) }) } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(Error)
    expect(isBudgetStopError(caught)).toBe(false)
    expect(calls).toHaveLength(1) // 通信は実際に行われた失敗
  })

  it('isBudgetStopError: 普通の Error・文字列・null・undefined・印の無いオブジェクトは false', () => {
    expect(isBudgetStopError(new Error('通信に失敗しました'))).toBe(false)
    expect(isBudgetStopError('上限')).toBe(false)
    expect(isBudgetStopError(null)).toBe(false)
    expect(isBudgetStopError(undefined)).toBe(false)
    expect(isBudgetStopError({ message: '上限' })).toBe(false)
  })
})

describe('usageStore.ts: budgetCheckForKey は「渡されたキーの指紋」で、呼ばれた時点の上限を判定する（1か所）', () => {
  it('上限内なら allowed:true／超えたあとに同じ関数を呼ぶと allowed:false（作ったあとで超えても効く）', () => {
    const check = budgetCheckForKey(KEY)
    expect(check().allowed).toBe(true)
    exceedLimit(KEY)
    const gate = check()
    expect(gate.allowed).toBe(false)
    expect(gate.message).toBe(checkBeforeRequest(hashKey(KEY)).message) // チャットで止めるときと同じ文
  })

  it('別のキーが超えていても、このキーは止まらない', () => {
    exceedLimit('OTHER-KEY')
    expect(budgetCheckForKey(KEY)().allowed).toBe(true)
  })
})

describe('chat/turnRunner.ts の資料検索（ragSearch）: 上限を超えたら通信せず、止めた理由を返す（W-85）', () => {
  const payload = { turnId: 't1', spec: { apiKey: KEY }, caps: {} } as any
  const ragSearch = () => {
    const io = buildMainIo({ rag: { tags: [] } }, payload, () => {})
    return io.ragSearch!
  }

  it('上限を超えていれば、fetch は1回も呼ばれない・返り値は「止めた理由」（空文字にしない）', async () => {
    exceedLimit(KEY)
    const limitMessage = checkBeforeRequest(hashKey(KEY)).message
    expect(limitMessage).toBeTruthy() // 前提: いま本当に止める状態
    const out = await ragSearch()('これは何ですか')
    expect(calls).toHaveLength(0) // ★お金の歯止め
    expect(out).not.toBe('') // ''（＝「該当する資料が見つかりませんでした」に言い換わる）にしない
    expect(out).toBe(`（📚 資料の検索は止めました: ${limitMessage}）`)
  })

  it('上限内なら、fetch が1回・検索結果の抜粋が返る', async () => {
    const out = await ragSearch()('これは何ですか')
    expect(calls).toEqual([`${RAG_API_BASE}/v1/documents/query/`])
    expect(out).toContain('抜粋の本文です')
  })

  it('上限とは無関係の失敗（HTTP 500）は、従来どおり空文字（止めた理由を出さない）', async () => {
    serverDown = true
    const out = await ragSearch()('これは何ですか')
    expect(calls).toHaveLength(1)
    expect(out).toBe('')
  })

  it('「上限に達したら止める」がオフなら、超えていても止めない', async () => {
    setSettings({ monthlyLimitYen: 100, enforce: false, warnRatio: 0.8, perKeyLimits: {} })
    exceedLimit(KEY)
    const out = await ragSearch()('これは何ですか')
    expect(calls).toHaveLength(1)
    expect(out).toContain('抜粋の本文です')
  })
})

describe('claude/tools.ts の search_docs: 渡された ragBudgetCheck で、上限を超えたら通信しない（W-85）', () => {
  function searchDocsHandler(ragBudgetCheck: () => { allowed: boolean; message?: string }): (args: any) => Promise<{ content: { text: string }[] }> {
    const sdk: any = {
      tool: (name: string, _desc: string, _schema: unknown, handler: any) => ({ name, handler }),
      createSdkMcpServer: (opts: any) => opts,
    }
    const server: any = buildIdeToolsServer(sdk, {
      projectDir, writeRoot: projectDir, aiEngineKey: KEY, writeMode: 'auto', turnId: 'claude-test-turn',
      isStopped: () => false,
      onOpenPreview: () => {}, snapshotId: 'snap', snapshotLabel: 'テスト',
      onDelegated: () => {}, onFileWritten: () => {},
      ragBudgetCheck,
    })
    return server.tools.find((t: any) => t.name === 'search_docs').handler
  }

  it('上限を超えていれば、fetch は1回も呼ばれない・止めた文が返る', async () => {
    exceedLimit(KEY)
    const limitMessage = checkBeforeRequest(hashKey(KEY)).message
    const out = await searchDocsHandler(budgetCheckForKey(KEY))({ query: 'これは何ですか' })
    expect(calls).toHaveLength(0) // ★お金の歯止め
    expect(out.content[0].text).toContain(limitMessage!)
  })

  it('上限内なら、fetch が1回・抜粋が返る', async () => {
    const out = await searchDocsHandler(budgetCheckForKey(KEY))({ query: 'これは何ですか' })
    expect(calls).toEqual([`${RAG_API_BASE}/v1/documents/query/`])
    expect(out.content[0].text).toContain('抜粋の本文です')
  })

  it('渡された確認が呼ばれる（tools.ts が自前で判定せず、渡された口を通す）', async () => {
    let checked = 0
    await searchDocsHandler(() => { checked += 1; return { allowed: false, message: '止めます' } })({ query: 'q' })
    expect(checked).toBe(1)
    expect(calls).toHaveLength(0)
  })
})

describe('ipc/claude.ts: startClaudeChat へ渡す ragBudgetCheck は、AI Engine のキーの上限で判定する（W-85）', () => {
  /** 実際の claude:chatStart ハンドラを呼び、startClaudeChat へ渡った引数を返す。 */
  function startChat(aiEngineKey: string | null): Record<string, any> {
    h.started = null
    registerClaudeHandlers({} as any)
    const fn = h.handlers.get('claude:chatStart')
    if (!fn) throw new Error('claude:chatStart が登録されていない')
    const event = { sender: { send: () => {} } }
    fn(event, projectDir, 'anthropic-key', 'こんにちは', [], 'snap', null, aiEngineKey, '', 'auto')
    if (!h.started) throw new Error('startClaudeChat が呼ばれていない')
    return h.started
  }

  it('AI Engine のキーが上限を超えていれば、渡された確認は allowed:false（チャットで止めるときと同じ文）', () => {
    exceedLimit(KEY)
    const params = startChat(KEY)
    expect(typeof params.ragBudgetCheck).toBe('function')
    const gate = params.ragBudgetCheck()
    expect(gate.allowed).toBe(false)
    expect(gate.message).toBe(checkBeforeRequest(hashKey(KEY)).message)
  })

  it('上限内なら allowed:true。確認は呼ばれた時点で判定する（渡したあとに超えても効く）', () => {
    const params = startChat(KEY)
    expect(params.ragBudgetCheck().allowed).toBe(true)
    exceedLimit(KEY)
    expect(params.ragBudgetCheck().allowed).toBe(false)
  })

  it('別のキーが超えていても、渡されたキーが超えていなければ止まらない（判定は渡されたキーの指紋）', () => {
    exceedLimit('OTHER-KEY')
    expect(startChat(KEY).ragBudgetCheck().allowed).toBe(true)
  })

  it('AI Engine のキーが無い（null・空）なら、常に allowed:true（search_docs は「キーが要る」と返して通信しない）', () => {
    exceedLimit(KEY)
    expect(startChat(null).ragBudgetCheck()).toEqual({ allowed: true })
    expect(startChat('').ragBudgetCheck()).toEqual({ allowed: true })
  })
})

// ══ 3. 型・配線の固定（渡し忘れを型検査で落とす口）═══════════════════════════════════

describe('渡し忘れを型検査が落とす（ragBudgetCheck は必須）／ipc/claude.ts は上限の確認を作って渡す', () => {
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

  it('tools.ts の IdeToolsParams・agent.ts の StartClaudeChatParams は、ragBudgetCheck を必須で持つ（? で任意にしない）', () => {
    expect(read('src/main/claude/tools.ts')).toContain('  ragBudgetCheck: RagBudgetCheck\n')
    expect(read('src/main/claude/agent.ts')).toContain('  ragBudgetCheck: RagBudgetCheck\n')
    expect(read('src/main/claude/tools.ts')).not.toContain('ragBudgetCheck?:')
    expect(read('src/main/claude/agent.ts')).not.toContain('ragBudgetCheck?:')
  })

  it('tools.ts は usageStore.ts を import しない（electron を読み込み、テストの作りに響く）', () => {
    expect(read('src/main/claude/tools.ts')).not.toMatch(/from '\.\.\/usageStore'/)
  })

  it('agent.ts は buildIdeToolsServer へ ragBudgetCheck を渡す・ipc/claude.ts は startClaudeChat へ budgetCheckForKey で作った確認を渡す', () => {
    expect(read('src/main/claude/agent.ts')).toContain('onOpenPreview, ragBudgetCheck, snapshotId,')
    expect(read('src/main/ipc/claude.ts')).toContain('ragBudgetCheck: aiEngineKey ? budgetCheckForKey(aiEngineKey) : () => ({ allowed: true }),')
  })

  it('startClaudeChat・buildIdeToolsServer の呼び出しは、src/main に1つずつしかない（増えたらここで気づく）', () => {
    const { scanCalls } = (() => {
      const found: string[] = []
      for (const f of listTsFiles(MAIN_DIR)) {
        const sf = ts.createSourceFile(f, fs.readFileSync(f, 'utf8'), ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS)
        const visit = (n: ts.Node) => {
          if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && (n.expression.text === 'startClaudeChat' || n.expression.text === 'buildIdeToolsServer')) {
            found.push(`${path.relative(ROOT, f)} ${n.expression.text}`)
          }
          ts.forEachChild(n, visit)
        }
        visit(sf)
      }
      return { scanCalls: found.sort() }
    })()
    expect(scanCalls).toEqual([
      'src/main/claude/agent.ts buildIdeToolsServer',
      'src/main/ipc/claude.ts startClaudeChat',
    ])
  })
})
