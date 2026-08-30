import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// B'-3d-2b: executeTool（AIツール実行）を main が直呼びで実行するようになった配線を固定する
// （tests/usageWiring.test.ts・tests/learningWiring.test.ts と同じ readCode 流儀）。
//
// ⚠️ コメントを外してから判定する（2026-08-20 に自分の説明コメントにテストが当たって落ちた事故の
// 再発防止。他の readCode テストと同じ流儀）。各 must/mustNot は、実装直後に `grep -n` 相当で
// 対象ファイル内に実在すること／存在しないことを確認済み（掟10: 当て先が他の行に出ないか）。
// このテストファイル自身は `\n`（バックスラッシュ+n）を文字列リテラルとして書いていないため、
// tests/untrustedBlockWiring.test.ts 冒頭が警告する「\n の罠」には触れない
// （対象ソース側の物理的な改行に対応する箇所は、実際の改行 `\n` で表す）。

const readCode = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*')
    })
    .join('\n')

describe('turnRunner.ts: executeTool はもう bridge.ask ではない（executeToolCore を直呼び）', () => {
  const src = readCode('src/main/chat/turnRunner.ts')

  it("bridge.ask('executeTool' が残っていない", () => {
    expect(src).not.toContain("bridge.ask('executeTool'")
  })

  it('executeToolCore を import し、buildMainIo と coreCtx で組み立てて直呼びしている', () => {
    expect(src).toContain(
      "import { executeToolCore, type CoreToolContext, type ToolIo, type SearchConfig } from '../../shared/toolExecCore'"
    )
    expect(src).toContain(
      'executeTool: (name, argsJson, opts) => executeToolCore(name, argsJson, coreCtx(opts), buildMainIo(opts, payload, emit)),'
    )
  })
})

describe('shared/chatTurnRpc.ts: ASK_PATHS から executeTool が消え、8本になっている', () => {
  const src = readCode('src/shared/chatTurnRpc.ts')

  it("'executeTool' という要素が ASK_PATHS 配列に無い", () => {
    // ASK_PATHS の定義（配列リテラル）だけを取り出して確認する（コメント中の言及とは区別する）。
    const start = src.indexOf('export const ASK_PATHS = [')
    const end = src.indexOf('] as const', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const arrayLiteral = src.slice(start, end)
    expect(arrayLiteral).not.toContain("'executeTool'")
  })
})

describe("renderer/chatTurnBridge.ts: dispatchAsk に case 'executeTool' が無い", () => {
  const src = readCode('src/renderer/chatTurnBridge.ts')

  it("case 'executeTool' も handlers 型の executeTool メンバーも無い", () => {
    expect(src).not.toContain("case 'executeTool'")
    expect(src).not.toContain('executeTool(name: string, argsJson: string, opts: Record<string, unknown>): Promise<string>')
  })

  it('turnOptsFull 引数が外れている（executeTool のためだけの合成だったため）', () => {
    expect(src).not.toContain('turnOptsFull: Record<string, unknown>,')
    expect(src).not.toContain('{ ...turnOptsFull, ...opts }')
  })
})

describe('renderer/hooks/useAiChat.ts: handlers に executeTool が渡っていない・dispatchAsk の呼び方', () => {
  const src = readCode('src/renderer/hooks/useAiChat.ts')

  it('handlers オブジェクトに executeTool: ports.executeTool が無い', () => {
    expect(src).not.toContain('executeTool: ports.executeTool,')
  })

  it('ports.executeTool 自体は buildPorts に残っている（EngineTurnPorts の型完全性のため）', () => {
    expect(src).toContain("executeTool: (name, argsJson, opts) => executeTool(name, argsJson, opts as ToolContext),")
  })

  it('dispatchAsk の呼び出しから turnOpts が外れている（3引数の形）', () => {
    expect(src).toContain('dispatchAsk(handlers, path as AskPath, args)')
    expect(src).not.toContain('dispatchAsk(handlers, turnOpts, path as AskPath, args)')
  })
})

describe('main/chat/turnRunner.ts: buildMainIo の applyFile（保存＋aiFileWritten通知）', () => {
  const src = readCode('src/main/chat/turnRunner.ts')

  it('cleanAiRelPath を使って書き先を組み立てている', () => {
    expect(src).toContain("const full = path.join(String(opts.writeRoot ?? ''), cleanAiRelPath(rel))")
  })

  it('保存（mkdir + writeFileSync）のあとに aiFileWritten を emit している（口の並び）', () => {
    const idx = src.indexOf('applyFile: async (rel, content) => {')
    expect(idx).toBeGreaterThan(-1)
    const block = src.slice(idx, idx + 400)
    const mkdirAt = block.indexOf('fs.mkdirSync(path.dirname(full), { recursive: true })')
    const writeAt = block.indexOf('fs.writeFileSync(full, content, \'utf-8\')')
    const emitAt = block.indexOf("emit({ kind: 'aiFileWritten', rel, full })")
    expect(mkdirAt).toBeGreaterThan(-1)
    expect(writeAt).toBeGreaterThan(mkdirAt)
    expect(emitAt).toBeGreaterThan(writeAt)
  })
})

describe('shared/publishRoot.ts と App.tsx: cleanAiRelPath が一元定義され、両方の呼び出し形が実在する', () => {
  it('shared/publishRoot.ts に cleanAiRelPath の定義がある（軽いトラバーサル対策のコメントごと）', () => {
    const src = readCode('src/shared/publishRoot.ts')
    expect(src).toContain('export function cleanAiRelPath(relPath: string): string {')
    expect(src).toContain("return relPath.replace(/^\\.?\\//, '').replace(/\\.\\.(\\/|\\\\)/g, '') // 軽いトラバーサル対策")
  })

  it('App.tsx の applyAiFile が cleanAiRelPath( を呼んでいる（renderer 側の呼び出し形）', () => {
    const src = readCode('src/renderer/App.tsx')
    expect(src).toContain("import { cleanAiRelPath } from '../shared/publishRoot'")
    expect(src).toContain('const clean = cleanAiRelPath(relPath) // 一元定義（shared/publishRoot.ts・掟10）')
    // 直す前の形（式を直接書く・複製）へ戻っていない
    expect(src).not.toContain("const clean = relPath.replace(/^\\.?\\//, '').replace(/\\.\\.(\\/|\\\\)/g, '')")
  })

  it('main/chat/turnRunner.ts の buildMainIo も cleanAiRelPath( を呼んでいる（main 側の呼び出し形）', () => {
    const src = readCode('src/main/chat/turnRunner.ts')
    expect(src).toContain("import { cleanAiRelPath } from '../../shared/publishRoot'")
    expect(src).toContain('cleanAiRelPath(rel)')
  })
})

describe('main/chat/turnRunner.ts: buildMainIo の ragSearch（search_docs の main 実装）', () => {
  const src = readCode('src/main/chat/turnRunner.ts')

  it('queryDocuments と buildRagBlockText を使っている', () => {
    expect(src).toContain("import { buildRagBlockText } from '../claude/toolText'")
    expect(src).toContain('const hits = await ragClient.queryDocuments(payload.spec.apiKey, query.slice(0, 1000), {')
    expect(src).toContain('return buildRagBlockText(hits)')
  })

  it('パラメータ（query.slice(0, 1000)・tags・topK 3）が、AI Engine 経路のこれまでの ragSearch と一致する', () => {
    // ── なぜここで固定するか ──────────────────────────────────────────
    // renderer ChatPanel.tsx の buildExecuteOpts はもう ragSearch（関数）を持たない
    // （B'-3d-2b・turnOpts の宣言化で rag: {tags}|null というデータへ置き換わった）。
    // そのため「いまの renderer 側コードと突き合わせる」形のテストは書けない。
    // 代わりに、置き換え前の renderer 実装（query.slice(0, 1000)・tags・topK: 3）と
    // 同じ値を main 側がそのまま持ち込んでいることを、値そのもので固定する。
    expect(src).toContain('query.slice(0, 1000)')
    expect(src).toContain('tags: rag.tags.length ? rag.tags : undefined,')
    expect(src).toContain('topK: 3,')
  })

  it('失敗は ""（renderer 版と同じ振る舞い）で、rag が無ければ undefined', () => {
    const idx = src.indexOf('ragSearch: rag ? async (query: string) => {')
    expect(idx).toBeGreaterThan(-1)
    const block = src.slice(idx, idx + 400)
    expect(block).toContain('} catch {')
    expect(block).toContain("return ''")
    expect(block).toContain('} : undefined,')
  })
})

describe('renderer/components/ChatPanel.tsx: buildExecuteOpts に applyFile:/ragSearch: が無く、rag: がある', () => {
  const src = readCode('src/renderer/components/ChatPanel.tsx')

  it('buildExecuteOpts のオブジェクトリテラルの中に applyFile:/ragSearch: が無い（口ごと確認）', () => {
    const start = src.indexOf('buildExecuteOpts: () => ({')
    expect(start).toBeGreaterThan(-1)
    // 次のトップレベル項目（buildRagBlock:）の手前までを対象にする（buildExecuteOpts の閉じ括弧の外）
    const end = src.indexOf('buildRagBlock: ragEnabled ? (text: string) => autoRagBlock(text, apiKey, ragSettings) : undefined,', start)
    expect(end).toBeGreaterThan(start)
    const block = src.slice(start, end)
    expect(block).not.toContain('applyFile:')
    expect(block).not.toContain('ragSearch:')
    expect(block).toContain('rag: ragEnabled ? { tags: ragSettings!.tags } : null,')
  })

  it('onApplyFile プロパティ自体は残っている（コードカードの「反映」ボタンが使う）', () => {
    expect(src).toContain('onApplyFile={onApplyFile ? (rel, content) => onApplyFile(rel, content, currentAiRoot) : undefined}')
  })
})

describe('renderer/components/ChatPanel.tsx: onAiFileWritten に projectDir 照合ガードがある（掟11）', () => {
  const src = readCode('src/renderer/components/ChatPanel.tsx')

  it('full が「いま見ているプロジェクト」配下のときだけ呼ぶガードがある', () => {
    expect(src).toContain(
      "if (projectDir && (full === projectDir || full.startsWith(`${projectDir}/`))) onAiFileWritten(full)"
    )
  })
})

describe('src/main/ipc/fs.ts・shell.ts・web.ts: ハンドラが抽出関数を呼ぶ薄い形になっている', () => {
  it('fs.ts: readFileInProjectFs / writeFileInProjectFs / projectFilesFs / searchInProjectFs が export され、ハンドラから呼ばれている', () => {
    const src = readCode('src/main/ipc/fs.ts')
    expect(src).toContain('export function readFileInProjectFs(projectDir: string, rel: string): string {')
    expect(src).toContain('export function writeFileInProjectFs(projectDir: string, rel: string, content: string): void {')
    expect(src).toContain('export function projectFilesFs(dir: string, maxFiles = 200): string[] {')
    expect(src).toContain('export function searchInProjectFs(')
    expect(src).toContain(
      "ipcMain.handle('fs:readFileInProject', (_, projectDir: string, rel: string) => readFileInProjectFs(projectDir, rel))"
    )
    expect(src).toContain(
      "ipcMain.handle('fs:writeFileInProject', (_, projectDir: string, rel: string, content: string) =>\n    writeFileInProjectFs(projectDir, rel, content))"
    )
    expect(src).toContain(
      "ipcMain.handle('fs:projectFiles', async (_, dir: string, maxFiles = 200) => projectFilesFs(dir, maxFiles))"
    )
    expect(src).toContain(
      "ipcMain.handle('fs:searchInProject', async (_, projectDir: string, query: string, pathPattern?: string) =>\n    searchInProjectFs(projectDir, query, pathPattern))"
    )
  })

  it('shell.ts: runProjectCommand が export され、proc:run ハンドラから呼ばれている（PROC_OUTPUT_MAX/timeout/shell の形ごと）', () => {
    const src = readCode('src/main/ipc/shell.ts')
    expect(src).toContain('const PROC_OUTPUT_MAX = 8000')
    expect(src).toContain('export function runProjectCommand(')
    expect(src).toContain('timeout: 60000,')
    expect(src).toContain("shell: process.env.SHELL || '/bin/zsh',")
    expect(src).toContain(
      "ipcMain.handle('proc:run', (_, args: { cwd: string; command: string }) => runProjectCommand(args.cwd, args.command))"
    )
  })

  it('web.ts: webSearch が export され、web:search ハンドラから呼ばれている（provider分岐は現行のまま）', () => {
    const src = readCode('src/main/ipc/web.ts')
    expect(src).toContain(
      "export async function webSearch(provider: 'tavily' | 'brave', key: string, query: string): Promise<SearchResult[]> {"
    )
    expect(src).toContain("return provider === 'tavily' ? searchTavily(key, query) : searchBrave(key, query)")
    expect(src).toContain(
      "ipcMain.handle('web:search', async (_, args: { provider: 'tavily' | 'brave'; key: string; query: string }) =>\n    webSearch(args.provider, args.key, args.query))"
    )
  })
})
