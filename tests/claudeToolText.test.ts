// Claude頭脳モードのIDE固有MCPツール（C2b）の純粋部分（src/main/claude/toolText.ts）のテスト。
// SDK/electron に依存しない名前規則・文言・整形・パス検証を検証する。
import { describe, it, expect } from 'vitest'
import {
  IDE_MCP_SERVER_NAME,
  IDE_TOOL_BARE_NAMES,
  IDE_MCP_TOOL_NAMES,
  qualifyMcpToolName,
  SEARCH_DOCS_NO_KEY_MESSAGE,
  buildRagBlockText,
  formatSearchDocsResult,
  parseRagTags,
  formatFetchedPage,
  normalizePreviewPath,
  DELEGATE_MODELS,
  DELEGATE_DEFAULT_MODEL,
  DELEGATION_GUIDANCE,
  buildDelegatePrompt,
  parseDelegateOutput,
  validateDelegatePath,
  summarizeDelegateResult,
} from '../src/main/claude/toolText'
import { buildRagBlockText as rendererBuildRagBlockText } from '../src/renderer/ragContext'

// ── ツール名の修飾規則（mcp__<server>__<tool>） ────────────────────────
describe('MCP tool name qualification', () => {
  it('qualifies a tool name as mcp__<server>__<tool>', () => {
    expect(qualifyMcpToolName('ide', 'fetch_url')).toBe('mcp__ide__fetch_url')
  })

  it('exposes the four IDE tools with fully-qualified names (for allowedTools / canUseTool)', () => {
    expect(IDE_MCP_SERVER_NAME).toBe('ide')
    expect(IDE_TOOL_BARE_NAMES).toEqual(['fetch_url', 'search_docs', 'open_preview', 'delegate_implementation'])
    expect(IDE_MCP_TOOL_NAMES).toEqual([
      'mcp__ide__fetch_url',
      'mcp__ide__search_docs',
      'mcp__ide__open_preview',
      'mcp__ide__delegate_implementation',
    ])
  })
})

// ── search_docs ────────────────────────────────────────────────────
describe('SEARCH_DOCS_NO_KEY_MESSAGE', () => {
  it('is the guidance message shown when the AI Engine key is missing', () => {
    expect(SEARCH_DOCS_NO_KEY_MESSAGE).toBe('📚 資料機能を使うには さくらのAI Engine のAPIキーが必要です')
  })
})

// RagQueryHit を最小構成で作るヘルパー（document は name だけ意味を持つ）
function hit(name: string | null, content: string) {
  return {
    document: name === null ? null : {
      id: 'd1', name, status: 'available', tags: [], model: null,
      chunkSize: null, chunkCount: null, errorMessage: null, content: null, createdAt: null, updatedAt: null,
    },
    chunkIndex: 0,
    distance: 0.1,
    content,
    metadata: null,
  }
}

describe('buildRagBlockText (main copy)', () => {
  it('returns an empty string for no hits', () => {
    expect(buildRagBlockText([])).toBe('')
  })

  it('includes the source (document name) for each hit', () => {
    const text = buildRagBlockText([hit('会員規約.pdf', '第1条 …')])
    expect(text).toContain('【出典: 会員規約.pdf】')
    expect(text).toContain('第1条 …')
    expect(text).toContain('# 関連資料')
  })

  it('falls back to (名称不明) when the document is missing', () => {
    expect(buildRagBlockText([hit(null, 'abc')])).toContain('【出典: (名称不明)】')
  })

  it('truncates long chunks at 2000 chars with an ellipsis', () => {
    const long = 'あ'.repeat(2500)
    const text = buildRagBlockText([hit('doc', long)])
    expect(text).toContain('あ'.repeat(2000) + '…')
    expect(text).not.toContain('あ'.repeat(2001))
  })

  it('produces exactly the same output as the renderer buildRagBlockText (相互参照の複製)', () => {
    const hits = [hit('資料A', 'コンテンツ1'), hit(null, 'x'.repeat(2100))]
    expect(buildRagBlockText(hits)).toBe(rendererBuildRagBlockText(hits as any))
  })
})

describe('formatSearchDocsResult', () => {
  it('returns a not-found message for no hits (renderer 版 executeTool と同じ)', () => {
    expect(formatSearchDocsResult([])).toBe('該当する資料が見つかりませんでした')
  })

  it('returns the rag block for hits', () => {
    expect(formatSearchDocsResult([hit('資料A', '本文')])).toContain('【出典: 資料A】')
  })
})

describe('parseRagTags', () => {
  it('returns the tags array from .sakuraide.json rag settings', () => {
    expect(parseRagTags({ rag: { enabled: true, tags: ['t1', 't2'] } })).toEqual(['t1', 't2'])
  })

  it('filters out non-string entries', () => {
    expect(parseRagTags({ rag: { tags: ['a', 1, null, 'b'] } })).toEqual(['a', 'b'])
  })

  it('returns [] when the rag key is missing or malformed', () => {
    expect(parseRagTags({})).toEqual([])
    expect(parseRagTags(null)).toEqual([])
    expect(parseRagTags({ rag: 'oops' })).toEqual([])
    expect(parseRagTags({ rag: { tags: 'not-an-array' } })).toEqual([])
  })
})

// ── fetch_url ──────────────────────────────────────────────────────
describe('formatFetchedPage', () => {
  it('formats url + title + content (renderer 版 executeTool と同じ整形)', () => {
    expect(formatFetchedPage({ url: 'https://a.example', title: 'タイトル', content: '本文' }))
      .toBe('ページ: https://a.example（タイトル）\n\n本文')
  })

  it('omits the title parentheses when the title is empty', () => {
    expect(formatFetchedPage({ url: 'https://a.example', title: '', content: '本文' }))
      .toBe('ページ: https://a.example\n\n本文')
  })
})

// ── open_preview ───────────────────────────────────────────────────
describe('normalizePreviewPath', () => {
  it('defaults to index.html when the path is omitted or empty', () => {
    expect(normalizePreviewPath(undefined)).toBe('index.html')
    expect(normalizePreviewPath('')).toBe('index.html')
    expect(normalizePreviewPath('   ')).toBe('index.html')
  })

  it('returns a relative path unchanged (stripping a leading ./)', () => {
    expect(normalizePreviewPath('about.html')).toBe('about.html')
    expect(normalizePreviewPath('sub/page.html')).toBe('sub/page.html')
    expect(normalizePreviewPath('./about.html')).toBe('about.html')
  })

  it('rejects absolute paths and path traversal', () => {
    expect(normalizePreviewPath('/etc/passwd')).toBe(null)
    expect(normalizePreviewPath('../outside.html')).toBe(null)
    expect(normalizePreviewPath('a/../../b.html')).toBe(null)
  })
})

// ── delegate_implementation（C3） ─────────────────────────────────────
describe('DELEGATE_MODELS / DELEGATE_DEFAULT_MODEL', () => {
  it('lists the two Qwen3-Coder models with the 480B model as default (matches usage.ts PRICING keys)', () => {
    expect(DELEGATE_MODELS).toEqual(['Qwen3-Coder-480B-A35B-Instruct-FP8', 'Qwen3-Coder-30B-A3B-Instruct'])
    expect(DELEGATE_DEFAULT_MODEL).toBe('Qwen3-Coder-480B-A35B-Instruct-FP8')
  })
})

describe('DELEGATION_GUIDANCE', () => {
  it('instructs Claude to prefer delegating implementation work to the AI Engine', () => {
    expect(DELEGATION_GUIDANCE).toContain('delegate_implementation')
    expect(DELEGATION_GUIDANCE).toContain('さくらのAI Engine')
    expect(DELEGATION_GUIDANCE).toContain('2回失敗')
  })
})

describe('buildDelegatePrompt', () => {
  it('specifies a strict JSON-only output format (no fences, no prose)', () => {
    const { system } = buildDelegatePrompt('タスク', [])
    expect(system).toContain('{"files":[{"path":"相対パス","content":"ファイル全文"}],"notes":"補足(任意)"}')
    expect(system).toContain('コードフェンス')
    expect(system).toContain('説明文')
  })

  it('includes the task text and context files in the user prompt', () => {
    const { user } = buildDelegatePrompt('会員一覧ページを作る', [{ path: 'src/App.tsx', content: 'export default App' }])
    expect(user).toContain('会員一覧ページを作る')
    expect(user).toContain('src/App.tsx')
    expect(user).toContain('export default App')
  })

  it('notes when no context files were provided', () => {
    const { user } = buildDelegatePrompt('タスク', [])
    expect(user).toContain('参照する既存ファイルの指定なし')
  })
})

describe('parseDelegateOutput', () => {
  it('parses a clean JSON response', () => {
    const raw = '{"files":[{"path":"a.ts","content":"export {}"}],"notes":"補足"}'
    const r = parseDelegateOutput(raw)
    expect(r).toEqual({ ok: true, files: [{ path: 'a.ts', content: 'export {}' }], notes: '補足' })
  })

  it('strips a ```json code fence', () => {
    const raw = '```json\n{"files":[{"path":"a.ts","content":"x"}],"notes":""}\n```'
    const r = parseDelegateOutput(raw)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.files).toEqual([{ path: 'a.ts', content: 'x' }])
  })

  it('strips a bare ``` code fence (no language tag)', () => {
    const raw = '```\n{"files":[{"path":"a.ts","content":"x"}],"notes":""}\n```'
    const r = parseDelegateOutput(raw)
    expect(r.ok).toBe(true)
  })

  it('extracts the JSON object even with explanatory prose before/after it', () => {
    const raw = 'かしこまりました。以下が実装結果です。\n{"files":[{"path":"a.ts","content":"x"}],"notes":""}\n以上です。'
    const r = parseDelegateOutput(raw)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.files).toEqual([{ path: 'a.ts', content: 'x' }])
  })

  it('does not get confused by braces inside string content', () => {
    const raw = '{"files":[{"path":"a.ts","content":"const o = { a: 1 }"}],"notes":""}'
    const r = parseDelegateOutput(raw)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.files[0].content).toBe('const o = { a: 1 }')
  })

  it('returns ok:false with a message for malformed JSON', () => {
    const r = parseDelegateOutput('{"files": [')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(typeof r.message).toBe('string')
  })

  it('returns ok:false when there is no JSON object at all', () => {
    const r = parseDelegateOutput('すみません、実装できませんでした。')
    expect(r).toEqual({ ok: false, message: 'JSON形式の応答が見つかりませんでした' })
  })

  it('returns ok:false when the schema does not match (missing files array)', () => {
    expect(parseDelegateOutput('{"notes":"x"}').ok).toBe(false)
    expect(parseDelegateOutput('{"files":"not-an-array"}').ok).toBe(false)
    expect(parseDelegateOutput('{"files":[]}').ok).toBe(false) // 空配列も拒否
    expect(parseDelegateOutput('{"files":[{"path":"a.ts"}]}').ok).toBe(false) // content欠落
    expect(parseDelegateOutput('{"files":[{"content":"x"}]}').ok).toBe(false) // path欠落
  })

  it('defaults notes to an empty string when omitted', () => {
    const r = parseDelegateOutput('{"files":[{"path":"a.ts","content":"x"}]}')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.notes).toBe('')
  })
})

describe('validateDelegatePath', () => {
  it('accepts ordinary relative paths', () => {
    expect(validateDelegatePath('src/App.tsx')).toBe(true)
    expect(validateDelegatePath('a.ts')).toBe(true)
    expect(validateDelegatePath('deep/nested/dir/file.ts')).toBe(true)
  })

  it('rejects absolute paths', () => {
    expect(validateDelegatePath('/etc/passwd')).toBe(false)
  })

  it('rejects path traversal', () => {
    expect(validateDelegatePath('../outside.ts')).toBe(false)
    expect(validateDelegatePath('a/../../b.ts')).toBe(false)
  })

  it('rejects .env-prefixed filenames (secrets)', () => {
    expect(validateDelegatePath('.env')).toBe(false)
    expect(validateDelegatePath('.env.local')).toBe(false)
    expect(validateDelegatePath('config/.env.production')).toBe(false)
  })

  it('rejects empty or non-string input', () => {
    expect(validateDelegatePath('')).toBe(false)
    expect(validateDelegatePath('   ')).toBe(false)
    expect(validateDelegatePath(undefined as any)).toBe(false)
  })
})

describe('summarizeDelegateResult', () => {
  it('lists files with byte counts, notes, and token usage, without file content', () => {
    const text = summarizeDelegateResult(
      [{ path: 'src/App.tsx', bytes: 1234 }, { path: 'src/App.test.tsx', bytes: 567 }],
      '補足事項です',
      { promptTokens: 1000, completionTokens: 2000 }
    )
    expect(text).toContain('src/App.tsx')
    expect(text).toContain('1234')
    expect(text).toContain('src/App.test.tsx')
    expect(text).toContain('567')
    expect(text).toContain('補足事項です')
    expect(text).toContain('1000')
    expect(text).toContain('2000')
    expect(text).toContain('2件')
  })

  it('omits the notes block when notes is empty', () => {
    const text = summarizeDelegateResult([{ path: 'a.ts', bytes: 10 }], '', { promptTokens: 1, completionTokens: 2 })
    expect(text).not.toContain('補足:')
  })

  it('never includes file content (summary only, per the design principle)', () => {
    const text = summarizeDelegateResult(
      [{ path: 'a.ts', bytes: 999 }],
      '',
      { promptTokens: 1, completionTokens: 2 }
    )
    expect(text).not.toContain('export')
  })
})
