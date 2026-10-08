// tests/w-fix-delegate-approval.test.ts — W-18の最後の抜け道: 「✋ 毎回確認」でも、Claude の
// delegate_implementation（さくらのAI Engine へ実装を任せてファイルへ直接書く道）は、
// 書き込みの前に確認を出していなかった。
//
// ── なぜ委譲だけ別に確認が要るか ──────────────────────────────────────
// `mcp__ide__delegate_implementation` は allowedTools に名前で入っており、SDK は canUseTool
// （agent.ts の makeCanUseTool）より先に自動許可する。しかもどのファイルを書くかは AI Engine の
// 応答が返るまで分からない。だから承認は、書き込みの直前に tools.ts の writeDelegatedFiles で取る。
// 仕組みは makeCanUseTool と同じもの（planApproval → requestApproval・同じ turnId）を使い回している
// （新しい承認の仕組みは作っていない）ことを、**実際のファイル書き込みの有無**で固定する
// （掟10: ソースの文字列を grep するテストは「聞かずに書く」変異を素通りさせる）。
//
// 実際の手順: 偽のSDK（tool の登録を捕まえるだけ）へ buildIdeToolsServer を通し、本物のハンドラを
// 呼ぶ。AI Engine（sakuraClient）だけ偽物に差し替え、承認は本物の approvalStore を使って
// 「利用者の答え」を answerApproval で流す。ファイルは本物の一時フォルダへ書く。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const fake = vi.hoisted(() => ({ content: '', calls: 0 }))
vi.mock('../src/main/ipc/sakura', () => ({
  sakuraClient: () => ({
    chat: {
      completions: {
        create: async () => {
          fake.calls += 1
          return {
            choices: [{ finish_reason: 'stop', message: { content: fake.content } }],
            usage: { prompt_tokens: 11, completion_tokens: 22 },
          }
        },
      },
    },
  }),
  isContextLimitError: () => false,
  safeMaxTokens: () => null,
}))
vi.mock('../src/main/ipc/web', () => ({ fetchUrlPage: async () => { throw new Error('このテストでは使わない') } }))
vi.mock('../src/main/rag/client', () => ({ queryDocuments: async () => [] }))

import { buildIdeToolsServer, writeDelegatedFiles } from '../src/main/claude/tools'
import { summarizeDelegateDenied } from '../src/main/claude/toolText'
import {
  setApprovalListener, answerApproval, listPending, resetApprovalsForTest, cancelApprovalsForTurn,
} from '../src/main/chat/approvalStore'
import { writeDenialMessage } from '../src/shared/approvalPlan'
import { protectedWriteMessage } from '../src/shared/protectedPaths'
import type { WriteMode } from '../src/shared/approvalPlan'

const SNAPSHOT_ID = '2026-09-29T00-00-00-000Z'
const TURN_ID = 'claude-test-turn'

let projectDir = ''
let writeRoot = ''
let onDelegated: ReturnType<typeof vi.fn>
let onFileWritten: ReturnType<typeof vi.fn>

beforeEach(() => {
  resetApprovalsForTest()
  setApprovalListener(null)
  fake.calls = 0
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-w-fix-delegate-'))
  // public/ があるプロジェクト（書き込み先＝作業フォルダ ≠ プロジェクト直下）。取り違えを見つけるため、わざと分ける。
  writeRoot = path.join(projectDir, 'public')
  fs.mkdirSync(writeRoot, { recursive: true })
  onDelegated = vi.fn()
  onFileWritten = vi.fn()
})
afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true })
})

/** 偽のSDK。tool() の登録だけを捕まえ、実物のハンドラを取り出す。 */
function delegateHandler(writeMode: WriteMode): (args: any) => Promise<{ content: { text: string }[] }> {
  const sdk: any = {
    tool: (name: string, _desc: string, _schema: unknown, handler: any) => ({ name, handler }),
    createSdkMcpServer: (opts: any) => opts,
  }
  const server: any = buildIdeToolsServer(sdk, {
    projectDir, writeRoot, aiEngineKey: 'test-key', writeMode, turnId: TURN_ID,
    isStopped: () => false, // ⏹ の抜け道は tests/w-fix-delegate-stop.test.ts で固定
    onOpenPreview: () => {}, snapshotId: SNAPSHOT_ID, snapshotLabel: 'テスト',
    ragBudgetCheck: () => ({ allowed: true }), // W-85: search_docs の上限の確認（このテストは委譲だけを見るので常に許可）
    onDelegated: onDelegated as any, onFileWritten: onFileWritten as any,
  })
  return server.tools.find((t: any) => t.name === 'delegate_implementation').handler
}

/** AI Engine の応答（ファイル一式）を偽物に仕込む。 */
function aiReplies(files: { path: string; content: string }[]) {
  fake.content = JSON.stringify({ files, notes: '' })
}

/** 「一度でも承認が求められたか」を記録する。求められたら即「許可」を返す（変異で聞くようになっても
 *  ハングせず、`asked()` の検査で落ちるように）。 */
function watchAsks() {
  let asked = false
  setApprovalListener(list => {
    if (!list.length) return
    asked = true
    answerApproval(list[0].id, true)
  })
  return { asked: () => asked }
}
const tick = () => new Promise<void>(r => setTimeout(r, 0))
/** 承認待ちが n 件になるまで待つ（ハンドラは AI Engine の応答を待ってから承認を求めるため）。 */
async function waitPending(n: number) {
  for (let i = 0; i < 50 && listPending().length < n; i++) await tick()
  expect(listPending().length).toBe(n)
}
const exists = (rel: string) => fs.existsSync(path.join(writeRoot, rel))
const text = (r: { content: { text: string }[] }) => r.content[0].text

describe('W-18: delegate_implementation の書き込みも「✋ 毎回確認」を通る', () => {
  it('★★ 毎回確認（confirm）: 書き込みの前に承認を求め、答えが来るまで書かない（許可すると書く）', async () => {
    aiReplies([{ path: 'index.html', content: '<html>ok</html>' }])
    const p = delegateHandler('confirm')({ task: 'ページを作る' })
    await waitPending(1)
    // 聞いている間は、まだ書いていない（書いてから聞くのでは遅い）
    expect(exists('index.html')).toBe(false)
    expect(onFileWritten).not.toHaveBeenCalled()
    // makeCanUseTool と同じ文面・同じ持ち場（ChatPanel は dir===projectDir で絞り込む。作業フォルダではない）
    expect(listPending()[0].label).toBe('✏️ ファイルの保存（index.html）')
    expect(listPending()[0].dir).toBe(projectDir)
    expect(answerApproval(listPending()[0].id, true)).toBe(true)
    const r = await p
    expect(fs.readFileSync(path.join(writeRoot, 'index.html'), 'utf8')).toBe('<html>ok</html>')
    expect(onFileWritten).toHaveBeenCalledWith('public/index.html')
    expect(text(r)).toContain('委譲が完了しました')
    expect(listPending()).toEqual([])
  })

  it('★★ 毎回確認（confirm）: 拒否すると書かない（ファイルもフォルダも🕘退避も残らない）・Claudeへは拒否の文面を返す', async () => {
    aiReplies([{ path: 'sub/dir/index.html', content: 'x' }])
    const p = delegateHandler('confirm')({ task: 'ページを作る' })
    await waitPending(1)
    answerApproval(listPending()[0].id, false)
    const r = await p
    expect(exists('sub/dir/index.html')).toBe(false)
    expect(exists('sub')).toBe(false) // 断られたのにフォルダだけ作られていない
    expect(fs.existsSync(path.join(projectDir, '.sakuraide-backup'))).toBe(false) // 書いていないので退避もしない
    expect(onFileWritten).not.toHaveBeenCalled()
    expect(text(r)).toContain(writeDenialMessage('write_file', JSON.stringify({ path: 'sub/dir/index.html' })))
    expect(text(r)).not.toContain('委譲が完了しました')
    // 断られても AI Engine には依頼して費用が出ている。記録は残す。
    expect(onDelegated).toHaveBeenCalledWith({ model: expect.any(String), promptTokens: 11, completionTokens: 22 })
  })

  it('★★ おまかせ（auto）: 聞かずに書く（承認待ちが一度も立たない）', async () => {
    aiReplies([{ path: 'index.html', content: '<html>auto</html>' }])
    const watch = watchAsks()
    const r = await delegateHandler('auto')({ task: 'ページを作る' }) // 待たずに最後まで走り切る＝聞いていない
    expect(watch.asked()).toBe(false)
    expect(listPending()).toEqual([])
    expect(fs.readFileSync(path.join(writeRoot, 'index.html'), 'utf8')).toBe('<html>auto</html>')
    expect(text(r)).toContain('委譲が完了しました')
  })

  it('★★ 守るパスは、毎回確認でもおまかせでも、聞かずに拒否して何も書かない（同じ回の他のファイルも書かない）', async () => {
    for (const mode of ['confirm', 'auto'] as const) {
      for (const bad of ['.env', '.git/hooks/pre-commit', '.sakuraide-backup/x.json', 'sub/.env.local']) {
        resetApprovalsForTest()
        const watch = watchAsks()
        aiReplies([{ path: 'index.html', content: 'ok' }, { path: bad, content: 'x' }])
        const r = await delegateHandler(mode)({ task: 't' })
        expect(watch.asked(), `${mode}/${bad}: 聞いてはいけない`).toBe(false)
        expect(exists('index.html'), `${mode}/${bad}: 同じ回の普通のファイルも書かない`).toBe(false)
        expect(exists(bad), `${mode}/${bad}`).toBe(false)
        expect(fs.existsSync(path.join(projectDir, bad)), `${mode}/${bad}`).toBe(false)
        expect(text(r)).toContain('書き込みを中止しました')
        expect(onFileWritten).not.toHaveBeenCalled()
      }
    }
  })

  it('★ 複数ファイル: 1件ごとに聞く。先に許可した分は書き、拒否した時点で止めて残りは聞かず書かない', async () => {
    aiReplies([
      { path: 'a.html', content: 'A' },
      { path: 'b.css', content: 'B' },
      { path: 'c.js', content: 'C' },
    ])
    const p = delegateHandler('confirm')({ task: 't' })
    await waitPending(1)
    expect(listPending()[0].label).toBe('✏️ ファイルの保存（a.html）')
    expect(exists('a.html')).toBe(false)
    answerApproval(listPending()[0].id, true)
    // a は許可 → 書かれる。b は次の確認が立つまで書かれない
    await waitPending(1)
    expect(listPending()[0].label).toBe('✏️ ファイルの保存（b.css）')
    expect(exists('a.html')).toBe(true)
    expect(exists('b.css')).toBe(false)
    answerApproval(listPending()[0].id, false) // b を拒否
    const r = await p
    expect(exists('b.css')).toBe(false)
    expect(exists('c.js')).toBe(false) // 残りは聞きもせず、書きもしない
    expect(listPending()).toEqual([])
    // Claudeには、書けた分・書かなかった分を隠さず伝える
    expect(text(r)).toContain(writeDenialMessage('write_file', JSON.stringify({ path: 'b.css' })))
    expect(text(r)).toContain('a.html')
    expect(text(r)).toContain('c.js')
  })

  it('★ ⏹ 中止（cancelApprovalsForTurn）は、承認待ちを拒否として解決し、書かない', async () => {
    aiReplies([{ path: 'index.html', content: 'x' }])
    const p = delegateHandler('confirm')({ task: 't' })
    await waitPending(1)
    // claude:chatCancel が呼ぶのと同じ鍵（turnId）で取り消せる＝承認が同じ turnId で駐機している
    expect(cancelApprovalsForTurn(TURN_ID)).toBe(1)
    const r = await p
    expect(exists('index.html')).toBe(false)
    expect(text(r)).toContain('許可しませんでした')
  })

  it('別のターン（別の環境）の鍵では取り消せない（掟11）', async () => {
    aiReplies([{ path: 'index.html', content: 'x' }])
    const p = delegateHandler('confirm')({ task: 't' })
    await waitPending(1)
    expect(cancelApprovalsForTurn('another-turn')).toBe(0)
    expect(listPending().length).toBe(1)
    answerApproval(listPending()[0].id, false)
    await p
  })
})

describe('W-18: writeDelegatedFiles（書く関数そのもの）の関門', () => {
  const ctx = (writeMode: WriteMode) => ({
    projectDir, writeRoot, snapshotId: SNAPSHOT_ID, snapshotLabel: 't',
    onFileWritten: onFileWritten as any, writeMode, turnId: TURN_ID, isStopped: () => false,
  })

  it('★★ 守るパスは、呼び出し側の検査（validateDelegatePath）を通り抜けても、この関数が聞かずに拒否する', async () => {
    for (const mode of ['confirm', 'auto'] as const) {
      for (const bad of ['.env', '.git/hooks/post-commit', '.sakuraide.json']) {
        const watch = watchAsks()
        const out = await writeDelegatedFiles([{ path: bad, content: 'x' }, { path: 'ok.txt', content: 'y' }], ctx(mode))
        expect(watch.asked(), `${mode}/${bad}`).toBe(false)
        expect(out.written, `${mode}/${bad}`).toEqual([])
        expect(out.denied, `${mode}/${bad}`).toEqual({ path: bad, message: protectedWriteMessage(bad) })
        expect(out.notReached).toEqual(['ok.txt'])
        expect(fs.existsSync(path.join(writeRoot, bad)), `${mode}/${bad}`).toBe(false)
        expect(exists('ok.txt'), `${mode}/${bad}`).toBe(false)
      }
    }
  })

  it('おまかせ（auto）は聞かずに全部書き、denied は null・notReached は空', async () => {
    const out = await writeDelegatedFiles([{ path: 'a.txt', content: 'A' }, { path: 'd/b.txt', content: 'BB' }], ctx('auto'))
    expect(out.denied).toBeNull()
    expect(out.notReached).toEqual([])
    expect(out.written).toEqual([{ path: 'a.txt', bytes: 1 }, { path: 'd/b.txt', bytes: 2 }])
    expect(fs.readFileSync(path.join(writeRoot, 'd/b.txt'), 'utf8')).toBe('BB')
    // 🕘 の退避はプロジェクト直下の .sakuraide-backup（作業フォルダの中ではない）
    expect(fs.existsSync(path.join(projectDir, '.sakuraide-backup'))).toBe(true)
    expect(fs.existsSync(path.join(writeRoot, '.sakuraide-backup'))).toBe(false)
  })

  it('毎回確認（confirm）で許可すると、書く前に 🕘 へ退避する（既存ファイルを上書きしても戻せる）', async () => {
    fs.writeFileSync(path.join(writeRoot, 'index.html'), '古い内容', 'utf8')
    const p = writeDelegatedFiles([{ path: 'index.html', content: '新しい内容' }], ctx('confirm'))
    await waitPending(1)
    // 承認の前に退避も上書きもしない
    expect(fs.readFileSync(path.join(writeRoot, 'index.html'), 'utf8')).toBe('古い内容')
    expect(fs.existsSync(path.join(projectDir, '.sakuraide-backup'))).toBe(false)
    answerApproval(listPending()[0].id, true)
    const out = await p
    expect(out.denied).toBeNull()
    expect(fs.readFileSync(path.join(writeRoot, 'index.html'), 'utf8')).toBe('新しい内容')
    const backupDirs = fs.readdirSync(path.join(projectDir, '.sakuraide-backup'))
    expect(backupDirs.length).toBeGreaterThan(0)
  })

  it('毎回確認（confirm）で拒否すると、既存ファイルは元のまま', async () => {
    fs.writeFileSync(path.join(writeRoot, 'index.html'), '古い内容', 'utf8')
    const p = writeDelegatedFiles([{ path: 'index.html', content: '新しい内容' }], ctx('confirm'))
    await waitPending(1)
    answerApproval(listPending()[0].id, false)
    const out = await p
    expect(out.written).toEqual([])
    expect(out.denied?.path).toBe('index.html')
    expect(fs.readFileSync(path.join(writeRoot, 'index.html'), 'utf8')).toBe('古い内容')
  })
})

describe('W-18: 配線（agent.ts は writeMode と turnId を委譲のツールへ渡す）', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')

  it('agent.ts: buildIdeToolsServer へ、makeCanUseTool と同じ writeMode・turnId を渡す', () => {
    const agent = read('src/main/claude/agent.ts')
    // 呼び出しの側を前後ごと一意に指す（定義や別の呼び出しに当たらない）
    expect(agent).toContain('buildIdeToolsServer(sdk, { projectDir, writeRoot, aiEngineKey, writeMode, turnId, onOpenPreview,')
    expect(agent).toContain('canUseTool: makeCanUseTool(projectDir, writeRoot, writeMode, turnId)')
    // 渡していなかった直す前の形に戻っていない
    expect(agent).not.toContain('buildIdeToolsServer(sdk, { projectDir, writeRoot, aiEngineKey, onOpenPreview,')
  })

  it('tools.ts: writeMode・turnId は必須（?で任意にすると、渡し忘れても型検査を素通りして「おまかせ」に倒れる）', () => {
    const tools = read('src/main/claude/tools.ts')
    expect(tools).toContain('  writeMode: WriteMode\n')
    expect(tools).toContain('  turnId: string\n')
    expect(tools).not.toContain('writeMode?:')
    expect(tools).not.toContain('turnId?:')
    // ハンドラは書き込みを writeDelegatedFiles に通す（fs.writeFileSync を直接呼ぶ道が残っていない）
    expect(tools).toContain('await writeDelegatedFiles(parsed.files, { projectDir, writeRoot, snapshotId, snapshotLabel, onFileWritten, writeMode, turnId, isStopped })')
    expect(tools.match(/fs\.writeFileSync\(/g)?.length).toBe(1) // 書く関数の中の1か所だけ
  })
})

describe('summarizeDelegateDenied（Claudeへ返す拒否の要約・純粋関数）', () => {
  it('拒否の文面を先頭に、保存済み・未保存を伝える。本文（content）は含めない', () => {
    const s = summarizeDelegateDenied('ユーザーが b.css の保存を許可しませんでした。', [{ path: 'a.html', bytes: 5 }], ['c.js'], { promptTokens: 1, completionTokens: 2 })
    expect(s.startsWith('ユーザーが b.css の保存を許可しませんでした。')).toBe(true)
    expect(s).toContain('- a.html（5バイト）')
    expect(s).toContain('c.js')
    expect(s).toContain('入力1 / 出力2')
  })
  it('保存済みも未保存も無ければ、その節を出さない', () => {
    const s = summarizeDelegateDenied('拒否', [], [], { promptTokens: 0, completionTokens: 0 })
    expect(s).not.toContain('保存済み')
    expect(s).not.toContain('保存していません')
  })
})
