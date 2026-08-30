import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// B'-3d-2a（executeTool 本体の shared 化・io ports 方式）の配線を固定する（掟10）。
//
// ── なぜこのテストが要るか ────────────────────────────────────────────
// executeToolCore 単体の振る舞いは tests/toolExecCore.test.ts が、皮側の組み立ては
// tests/aiToolsApply.test.ts が固定している。だが「皮が本当に本体を呼んでいるか」
// 「本体の実装が皮に生き残っていないか」「守りの関数（isProtectedWritePath）が
// 実際に呼ばれているか」は、それらのテストだけでは分からない（ソースを読んで確かめる
// しかない）。当て先が他の行（定義そのもの・別の変数への受け渡し）に出ないよう、
// 呼び出しの形をそのまま must/mustNot に書く。

const ROOT = path.join(__dirname, '..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8')

describe('renderer/aiTools.ts は executeToolCore を呼ぶ薄い皮になっている', () => {
  const src = read('src/renderer/aiTools.ts')

  it('executeTool が executeToolCore(name, argsJson, coreCtx, buildIo(ctx)) を呼んでいる', () => {
    expect(src).toContain('return executeToolCore(name, argsJson, coreCtx, buildIo(ctx))')
  })

  it('executeToolCore を shared/toolExecCore.ts から import している', () => {
    expect(src).toContain("import { executeToolCore, type CoreToolContext, type ToolIo, type SearchConfig, type SearchProvider } from '../shared/toolExecCore'")
  })

  // 本体の判定（if (name === 'write_file') 等）が皮に戻っていないか。
  // ⚠️ 文字列は「呼び出しの形」ではなく「分岐そのもの」なので、toolExecCore.ts 側には
  // 存在してよい（そちらは mustExist 側で別途確認する）。ここは aiTools.ts に無いことだけを見る。
  const toolBranches = [
    "if (name === 'fetch_url')",
    "if (name === 'search_web')",
    "if (name === 'list_files')",
    "if (name === 'read_file')",
    "if (name === 'write_file')",
    "if (name === 'edit_file')",
    "if (name === 'run_command')",
    "if (name === 'search_docs')",
    "if (name === 'search_in_files')",
    "if (name === 'open_preview')",
  ]
  it.each(toolBranches)('%s の分岐実装が aiTools.ts に残っていない', (branch) => {
    expect(src).not.toContain(branch)
  })

  it('未対応ツールの分岐（return `エラー: 未対応のツールです`）も aiTools.ts に残っていない', () => {
    expect(src).not.toContain("return `エラー: 未対応のツールです（${name}）`")
  })
})

describe('shared/toolExecCore.ts に本体（10分岐すべて）が実在する', () => {
  const src = read('src/shared/toolExecCore.ts')
  const toolBranches = [
    "if (name === 'fetch_url')",
    "if (name === 'search_web')",
    "if (name === 'list_files')",
    "if (name === 'read_file')",
    "if (name === 'write_file')",
    "if (name === 'edit_file')",
    "if (name === 'run_command')",
    "if (name === 'search_docs')",
    "if (name === 'search_in_files')",
    "if (name === 'open_preview')",
  ]
  it.each(toolBranches)('%s の分岐が存在する', (branch) => {
    expect(src).toContain(branch)
  })

  it('executeToolCore という関数名で export されている', () => {
    expect(src).toContain('export async function executeToolCore(name: string, argsJson: string, ctx: CoreToolContext, io: ToolIo): Promise<string>')
  })
})

describe('守りの配線: toolExecCore.ts の resolveForWrite が isProtectedWritePath を実際に呼んでいる', () => {
  const src = read('src/shared/toolExecCore.ts')

  it('protectedPaths.ts から isProtectedWritePath / protectedWriteMessage を import している', () => {
    expect(src).toContain("import { isProtectedWritePath, protectedWriteMessage } from './protectedPaths'")
  })

  // 呼び出しの形そのもの（定義行ではない）を固定する。resolveForWrite の中の
  // 分岐であることも、直前の関数シグネチャで確認する。
  it('resolveForWrite の中で isProtectedWritePath(relPath) を呼び、保護時は protectedWriteMessage を使ったエラーを返す', () => {
    const sigIdx = src.indexOf('export function resolveForWrite(projectDir: string, relPath: string)')
    expect(sigIdx).toBeGreaterThan(-1)
    const body = src.slice(sigIdx, sigIdx + 400)
    expect(body).toContain('if (isProtectedWritePath(relPath)) return { error: `エラー: ${protectedWriteMessage(relPath)}` }')
  })
})

describe('renderer/editFile.ts は shared/editFile.ts の re-export である', () => {
  it('applyEdit / ApplyEditResult を shared/editFile.ts から re-export しているだけ', () => {
    const src = read('src/renderer/editFile.ts')
    expect(src).toContain("export { applyEdit, type ApplyEditResult } from '../shared/editFile'")
    // 実装（本体のロジック）がここに戻っていないことも確認する
    expect(src).not.toContain('function applyEdit(')
    expect(src).not.toContain('function countOccurrences(')
    expect(src).not.toContain('function replaceFirst(')
  })

  it('shared/editFile.ts に applyEdit の実体（関数定義）がある', () => {
    const src = read('src/shared/editFile.ts')
    expect(src).toContain('export function applyEdit(')
  })
})
