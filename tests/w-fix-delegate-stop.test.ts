// tests/w-fix-delegate-stop.test.ts — W-18 検分の指摘: 委譲で「さくらのAI Engine の応答待ち」の最中に
// ⏹ を押しても、応答が返ったあとに承認待ちが新しく立ち、⏹ では消せないまま残る抜け道。
//
// ── 何が起きていたか ──────────────────────────────────────────────
// ⏹（ipc/claude.ts の claude:chatCancel）は abort() と cancelApprovalsForTurn(turnId) を呼ぶ。
// だが AI Engine の応答待ち（委譲でいちばん長い区間・最長で約10〜20分）の最中は、まだ承認待ちが
// 立っていないので、取り消されるのは0件。そのあと応答が返ると writeDelegatedFiles が同じ turnId で
// requestApproval を**新しく**駐機する。activeChat は既に null なので、この承認待ちを取り消す道が
// もう無く、止めたはずの依頼の「✏️ ファイルの保存」が次の会話の最中に出て、許可すると書かれてしまう。
// 「おまかせ」でも、⏹ の後に黙って書いていた。
//
// ── 直し方 ────────────────────────────────────────────────────────
// agent.ts が abortController.signal.aborted を isStopped として渡し、writeDelegatedFiles は
// ①承認を求める前 ②許可された後の書く直前 ③次のファイルへ進む前 に止まっていれば、聞かず・書かずに返す。
//
// ── 検査の仕方（掟10）──────────────────────────────────────────────
// ソースの文字列ではなく**振る舞い**で固定する: 本物の tools.ts・本物の approvalStore・本物の一時フォルダ。
// 偽物は AI Engine（応答を好きなときに返せる）と、⏹ の印（isStopped）だけ。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const fake = vi.hoisted(() => ({
  content: '',
  calls: 0,
  /** 立っている間、AI Engine の応答は返らない（応答待ちの再現）。null なら即返す。 */
  gate: null as Promise<void> | null,
}))
vi.mock('../src/main/ipc/sakura', () => ({
  sakuraClient: () => ({
    chat: {
      completions: {
        create: async () => {
          fake.calls += 1
          if (fake.gate) await fake.gate
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
import { summarizeDelegateStopped } from '../src/main/claude/toolText'
import {
  setApprovalListener, answerApproval, listPending, resetApprovalsForTest, cancelApprovalsForTurn,
} from '../src/main/chat/approvalStore'
import type { WriteMode } from '../src/shared/approvalPlan'

const SNAPSHOT_ID = '2026-09-29T00-00-00-000Z'
const TURN_ID = 'claude-stop-turn'

let projectDir = ''
let writeRoot = ''
let stopped = false
let onDelegated: ReturnType<typeof vi.fn>
let onFileWritten: ReturnType<typeof vi.fn>

beforeEach(() => {
  resetApprovalsForTest()
  setApprovalListener(null)
  fake.calls = 0
  fake.gate = null
  stopped = false
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-w-fix-delegate-stop-'))
  writeRoot = path.join(projectDir, 'public')
  fs.mkdirSync(writeRoot, { recursive: true })
  onDelegated = vi.fn()
  onFileWritten = vi.fn()
})
afterEach(() => {
  setApprovalListener(null)
  fs.rmSync(projectDir, { recursive: true, force: true })
})

function delegateHandler(writeMode: WriteMode): (args: any) => Promise<{ content: { text: string }[] }> {
  const sdk: any = {
    tool: (name: string, _desc: string, _schema: unknown, handler: any) => ({ name, handler }),
    createSdkMcpServer: (opts: any) => opts,
  }
  const server: any = buildIdeToolsServer(sdk, {
    projectDir, writeRoot, aiEngineKey: 'test-key', writeMode, turnId: TURN_ID,
    isStopped: () => stopped,
    onOpenPreview: () => {}, snapshotId: SNAPSHOT_ID, snapshotLabel: 'テスト',
    ragBudgetCheck: () => ({ allowed: true }), // W-85: search_docs の上限の確認（このテストは委譲だけを見るので常に許可）
    onDelegated: onDelegated as any, onFileWritten: onFileWritten as any,
  })
  return server.tools.find((t: any) => t.name === 'delegate_implementation').handler
}
function aiReplies(files: { path: string; content: string }[]) {
  fake.content = JSON.stringify({ files, notes: '' })
}
/** 応答を止めておくための門。open() で AI Engine の応答が返る。 */
function holdAiEngine(): { open: () => void } {
  let open!: () => void
  fake.gate = new Promise<void>(r => { open = r })
  return { open }
}
const tick = () => new Promise<void>(r => setTimeout(r, 0))
/** AI Engine へ依頼が飛んだところまで進める（＝応答待ちに入った）。 */
async function waitAiCalled() {
  for (let i = 0; i < 50 && fake.calls < 1; i++) await tick()
  expect(fake.calls).toBe(1)
}
/** 承認の駐機が起きたら記録し、即「許可」を返す（変異で聞くようになってもハングしないように）。 */
function watchAsks() {
  let asked = 0
  setApprovalListener(list => {
    if (!list.length) return
    asked += 1
    answerApproval(list[0].id, true)
  })
  return { asked: () => asked }
}
const exists = (rel: string) => fs.existsSync(path.join(writeRoot, rel))
const text = (r: { content: { text: string }[] }) => r.content[0].text

/** ⏹ を押したのと同じこと（ipc/claude.ts の claude:chatCancel: abort() → cancelApprovalsForTurn(turnId)）。 */
function pressStop(): number {
  stopped = true
  return cancelApprovalsForTurn(TURN_ID)
}

describe('W-18: AI Engine の応答待ちの最中に ⏹ → 応答が返っても、聞かず・書かない', () => {
  for (const mode of ['confirm', 'auto'] as const) {
    it(`★★ ${mode}: 承認待ちは立たず（0件）、ファイルは存在せず、書いた通知も出ない`, async () => {
      aiReplies([{ path: 'index.html', content: 'AFTER-STOP' }, { path: 'css/site.css', content: 'x' }])
      const watch = watchAsks() // 聞かれたら即「許可」を返す。聞いたこと自体を捕まえる
      const hold = holdAiEngine()
      const p = delegateHandler(mode)({ task: 'ページを作る' })
      await waitAiCalled()
      // 応答待ちの最中に ⏹。この時点で承認待ちは無いので、取り消されるのは0件（指摘のとおり）
      expect(pressStop()).toBe(0)
      hold.open()
      const r = await p
      // 聞いていない・帳簿にも残っていない（⏹ では消せない承認待ちが生まれていない）
      expect(watch.asked()).toBe(0)
      expect(listPending()).toEqual([])
      // 書いていない（フォルダも 🕘 退避も痕跡なし）
      expect(exists('index.html')).toBe(false)
      expect(exists('css')).toBe(false)
      expect(fs.existsSync(path.join(projectDir, '.sakuraide-backup'))).toBe(false)
      expect(onFileWritten).not.toHaveBeenCalled()
      // 依頼した費用は残す。Claude へは「止められたので書かなかった」と伝える
      expect(onDelegated).toHaveBeenCalledWith({ model: expect.any(String), promptTokens: 11, completionTokens: 22 })
      expect(text(r)).toContain('停止')
      expect(text(r)).toContain('index.html')
      expect(text(r)).not.toContain('委譲が完了しました')
    })
  }

  it('★ 対照: ⏹ を押していなければ、同じ流れで従来どおり聞いて書く（テストが常に「書かない」を返す偽物ではない）', async () => {
    aiReplies([{ path: 'index.html', content: 'OK' }])
    const hold = holdAiEngine()
    const p = delegateHandler('confirm')({ task: 't' })
    await waitAiCalled()
    hold.open()
    for (let i = 0; i < 50 && listPending().length < 1; i++) await tick()
    expect(listPending().length).toBe(1)
    answerApproval(listPending()[0].id, true)
    const r = await p
    expect(fs.readFileSync(path.join(writeRoot, 'index.html'), 'utf8')).toBe('OK')
    expect(text(r)).toContain('委譲が完了しました')
  })
})

describe('W-18: writeDelegatedFiles（書く関数そのもの）は、止まっていれば聞かず・書かない', () => {
  const ctx = (writeMode: WriteMode) => ({
    projectDir, writeRoot, snapshotId: SNAPSHOT_ID, snapshotLabel: 't',
    onFileWritten: onFileWritten as any, writeMode, turnId: TURN_ID, isStopped: () => stopped,
  })

  it('★★ 最初から止まっている: confirm でも auto でも、聞かず・書かず、全ファイルが未着手', async () => {
    for (const mode of ['confirm', 'auto'] as const) {
      resetApprovalsForTest()
      const watch = watchAsks()
      stopped = true
      const out = await writeDelegatedFiles([{ path: 'a.txt', content: 'A' }, { path: 'b.txt', content: 'B' }], ctx(mode))
      expect(watch.asked(), mode).toBe(0)
      expect(out.written, mode).toEqual([])
      expect(out.denied, mode).toBeNull()
      expect(out.stopped, mode).toBe(true)
      expect(out.notReached, mode).toEqual(['a.txt', 'b.txt'])
      expect(exists('a.txt'), mode).toBe(false)
      expect(exists('b.txt'), mode).toBe(false)
      expect(onFileWritten).not.toHaveBeenCalled()
    }
  })

  it('★★ 許可の答えが来た「あと」で止まっていたら、書かない（書く直前にも見る）', async () => {
    // 承認待ちが立った瞬間に ⏹ が押され、その直後に「許可」が届いた、という順序を再現する。
    // （cancelApprovalsForTurn が先に走れば「拒否」になるが、許可が先に解決した場合でも書かない）
    setApprovalListener(list => {
      if (!list.length) return
      stopped = true
      answerApproval(list[0].id, true)
    })
    const out = await writeDelegatedFiles([{ path: 'index.html', content: 'x' }, { path: 'b.txt', content: 'y' }], ctx('confirm'))
    expect(out.stopped).toBe(true)
    expect(out.written).toEqual([])
    expect(out.denied).toBeNull()
    expect(out.notReached).toEqual(['index.html', 'b.txt'])
    expect(exists('index.html')).toBe(false)
    expect(exists('b.txt')).toBe(false)
    expect(fs.existsSync(path.join(projectDir, '.sakuraide-backup'))).toBe(false)
    expect(onFileWritten).not.toHaveBeenCalled()
  })

  it('★★ 複数ファイルの途中で止まったら、次のファイルは聞かず・書かない（書けた分は隠さず返す）', async () => {
    for (const mode of ['confirm', 'auto'] as const) {
      resetApprovalsForTest()
      stopped = false
      fs.rmSync(path.join(projectDir, '.sakuraide-backup'), { recursive: true, force: true })
      let asked = 0
      setApprovalListener(list => {
        if (!list.length) return
        asked += 1
        answerApproval(list[0].id, true)
      })
      // 1件書いた直後に ⏹ が押された、という順序（onFileWritten は書いた直後に呼ばれる）
      const wrote = vi.fn(() => { stopped = true })
      const files = [{ path: `${mode}-a.txt`, content: 'A' }, { path: `${mode}-b.txt`, content: 'B' }, { path: `${mode}-c.txt`, content: 'C' }]
      const out = await writeDelegatedFiles(files, { ...ctx(mode), onFileWritten: wrote as any })
      expect(exists(`${mode}-a.txt`), mode).toBe(true)
      expect(exists(`${mode}-b.txt`), mode).toBe(false)
      expect(exists(`${mode}-c.txt`), mode).toBe(false)
      expect(out.written.map(f => f.path), mode).toEqual([`${mode}-a.txt`])
      expect(out.stopped, mode).toBe(true)
      expect(out.denied, mode).toBeNull()
      expect(out.notReached, mode).toEqual([`${mode}-b.txt`, `${mode}-c.txt`])
      expect(asked, mode).toBe(mode === 'confirm' ? 1 : 0) // 止まったあとの b・c は聞いていない
      setApprovalListener(null)
    }
  })

  it('止まっていなければ、従来どおり全部書き、stopped は false（auto）', async () => {
    const out = await writeDelegatedFiles([{ path: 'a.txt', content: 'A' }, { path: 'b.txt', content: 'B' }], ctx('auto'))
    expect(out.stopped).toBe(false)
    expect(out.denied).toBeNull()
    expect(out.notReached).toEqual([])
    expect(out.written.map(f => f.path)).toEqual(['a.txt', 'b.txt'])
  })

  it('守るパスは、止まっていても聞かず・書かない', async () => {
    stopped = true
    const watch = watchAsks()
    const out = await writeDelegatedFiles([{ path: '.env', content: 'SECRET=1' }], ctx('confirm'))
    expect(watch.asked()).toBe(0)
    expect(out.written).toEqual([])
    expect(exists('.env')).toBe(false)
  })
})

describe('W-18: 配線（agent.ts は ⏹ の印を委譲のツールへ渡す）', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')

  it('agent.ts: isStopped は、abortController の signal（⏹ で abort() されるもの）を見る', () => {
    const agent = read('src/main/claude/agent.ts')
    expect(agent).toContain('onDelegated, onFileWritten, isStopped: () => abortController.signal.aborted })')
    // ⏹ の abort() と同じ abortController を Options にも渡している（別の物を見ていない）
    expect(agent).toContain('    abortController,\n')
    expect(agent).toContain('return { abort: () => abortController.abort(), turnId }')
  })

  it('tools.ts: isStopped は必須（? で任意にすると、渡し忘れても型検査を素通りして「⏹ の後に書く」に倒れる）', () => {
    const tools = read('src/main/claude/tools.ts')
    expect(tools).toContain('  isStopped: () => boolean\n')
    expect(tools).not.toContain('isStopped?:')
    // ハンドラは isStopped をそのまま書く関数へ渡す
    expect(tools).toContain('onFileWritten, writeMode, turnId, isStopped })')
  })
})

describe('summarizeDelegateStopped（Claudeへ返す「止められた」の要約・純粋関数）', () => {
  it('止められたこと・書けた分・書かなかった分・費用を伝える。本文は含めない', () => {
    const s = summarizeDelegateStopped([{ path: 'a.html', bytes: 5 }], ['b.css', 'c.js'], { promptTokens: 1, completionTokens: 2 })
    expect(s).toContain('停止')
    expect(s).toContain('- a.html（5バイト）')
    expect(s).toContain('b.css, c.js')
    expect(s).toContain('入力1 / 出力2')
  })
  it('保存済みが無ければ、その節を出さない', () => {
    const s = summarizeDelegateStopped([], ['a.html'], { promptTokens: 0, completionTokens: 0 })
    expect(s).not.toContain('保存済み')
    expect(s).toContain('a.html')
  })
})
