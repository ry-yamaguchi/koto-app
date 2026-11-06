import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// 手動の【🗂 まとめる】は renderer で runCompact を回し、chatOnce は IPC（preload の sakura.chat → main の sakura:chat）を通る。
// IPC を越えた例外は message だけの Error になり、構造の印（cause.code・status）を失う。
// main が判定した種類を message の頭に載せ（failureText.ts の messageForIpc）、renderer が同じ層で読み戻すので、
// 手動のまとめの失敗が、main の経路（runEngineTurn・自動のまとめ）と同じ日本語の文になることを、実際の IPC の形で固定する。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  exposed: null as any,
  /** 次の runSakuraChat が投げる値。 */
  thrown: null as any,
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  contextBridge: { exposeInMainWorld: (_name: string, api: any) => { h.exposed = api } },
  ipcRenderer: {
    on: () => {}, removeListener: () => {},
    invoke: async (channel: string, ...args: any[]) => {
      const fn = h.handlers.get(channel)
      if (!fn) throw new Error(`未登録のチャンネル: ${channel}`)
      try {
        return await fn({ sender: { send: () => {} } }, ...args)
      } catch (e: any) {
        // 本物の Electron は main の例外を message だけの Error に包んで renderer へ渡す（name・cause・status は失われる）
        throw new Error(`Error invoking remote method '${channel}': Error: ${e?.message ?? String(e)}`)
      }
    },
  },
  webUtils: { getPathForFile: () => '' },
  app: { getPath: () => '/tmp', getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false },
  shell: {}, dialog: {},
}))

vi.mock('../src/main/sakura/engine', async (orig) => ({
  ...(await orig<typeof import('../src/main/sakura/engine')>()),
  runSakuraChat: async () => { throw h.thrown },
}))

import { registerSakuraHandlers } from '../src/main/ipc/sakura'
import '../src/main/preload'
import { runCompact, type EngineTurnPorts } from '../src/shared/chatTurn'
import { compactPrompt, acceptSummary, compactSource } from '../src/renderer/historyCompact'
import { modelLabel, estimateTokens } from '../src/renderer/usage'
import { formatChatError } from '../src/renderer/aiTools'

registerSakuraHandlers({} as any)

const ports = (): EngineTurnPorts => ({
  emit: () => {},
  chatOnce: (req: any) => h.exposed.sakura.chat(req, () => {}),
  usage: { check: () => ({ allowed: true }), record: () => {}, estimate: (t: string) => estimateTokens(t) },
  h: { compactPrompt, acceptSummary, compactSource, modelLabel, formatChatError },
} as unknown as EngineTurnPorts)

const HISTORY = [{ role: 'user', content: 'アプリを作りたい' }, { role: 'assistant', content: 'どんなアプリですか' }] as any[]
const PLAN = { base: null, from: 0, to: 2, mark: 'm1' }

/** openai SDK の失敗の形（APIConnectionError は message が 'Connection error.' だけで、理由は cause に入る）。 */
function connectionError(code: string): Error {
  const e = new Error('Connection error.')
  ;(e as any).cause = Object.assign(new Error('x'), { code })
  return e
}
function statusError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status })
}

/** main の経路（runEngineTurn）は IPC を通さず、投げられた値のまま formatChatError に渡す。手動のまとめも同じ文になるはず。 */
const mainSentence = (e: unknown): string => formatChatError((e as Error).message, 'sakura', e)

const CASES: Array<[string, () => Error, RegExp]> = [
  ['安全な接続（証明書の期限切れ）', () => connectionError('CERT_HAS_EXPIRED'), /^安全な接続を確認できませんでした/],
  ['時間切れ（ETIMEDOUT）', () => connectionError('ETIMEDOUT'), /^インターネットに接続できませんでした/],
  ['500（本文に番号が無い）', () => statusError(500, 'Upstream failure'), /^AI のサービス側で一時的な問題が起きています/],
  ['404（本文に番号が無い）', () => statusError(404, 'Not Found'), /^選んでいるモデルが見つかりませんでした（404）/],
]

describe('手動の 🗂 まとめる: IPC を越えた失敗も main の経路と同じ文になる', () => {
  for (const [name, make, sentence] of CASES) {
    it(`★ ${name}`, async () => {
      h.thrown = make()
      const r: any = await runCompact({ apiKey: 'k', model: 'test-model' }, ports(), HISTORY, PLAN)
      expect(r.error).toMatch(sentence)
      expect(r.error).toBe(mainSentence(make()))
      // 英語の頭・種類の印・「エラー: …」の汎用文が画面に出ない
      expect(r.error).not.toMatch(/Error invoking|koto-failure|^エラー:/)
    })
  }

  it('見分けられない失敗は、頭も印も付かない原文のまま（従来の文）', async () => {
    h.thrown = new Error('something odd')
    const r: any = await runCompact({ apiKey: 'k', model: 'test-model' }, ports(), HISTORY, PLAN)
    expect(r.error).toBe(mainSentence(new Error('something odd')))
    expect(r.error).toContain('エラー: something odd')
  })

  it('セキュリティチェックの口（同じ sakura.chat）も、頭と印の無い文を受け取る', async () => {
    h.thrown = connectionError('CERT_HAS_EXPIRED')
    const { failureText } = await import('../src/shared/failureText')
    const e = await h.exposed.sakura.chat({}, () => {}).catch((x: unknown) => x)
    expect(failureText(e, { readOnly: true })).toMatch(/^安全な接続を確認できませんでした/)
  })
})

describe('IPC を越える失敗を受ける口（ソースの形）', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8')

  it('ストリーミングの失敗も印つきで送る（受けた greeting も頭と印を落として判定に渡す）', () => {
    const main = read('src/main/ipc/sakura.ts')
    expect(main).toContain('wc.send(`sakura:chat-error:${id}`, messageForIpc(err))')
    expect(main).not.toContain('wc.send(`sakura:chat-error:${id}`, err?.message ?? String(err))')
    const greeting = read('src/renderer/greeting.ts')
    expect(greeting).toContain("ports.warn(formatChatError(stripRemoteHead(e), 'sakura', e))")
    expect(greeting).not.toContain('ports.warn(formatChatError(e?.message ?? String(e)))')
  })

  it('セキュリティチェックの失敗は、頭・印を落とした日本語の文にする', () => {
    const src = read('src/renderer/securityCheck.ts')
    // 文の途中（括弧の中）に埋め込むので、詳細（原文）は文の最後の行へ移す（wrapFailureText）
    expect(src).toContain("wrapFailureText(failureText(e, { readOnly: true }), t => `チェックに失敗しました（${t.replace(/。$/, '')}）。`)")
    expect(src).not.toContain("`チェックに失敗しました（${failureText(e, { readOnly: true }).replace(/。$/, '')}）。`")
    expect(src).not.toContain('チェックに失敗しました（${e?.message ?? e}）')
  })

  it('まとめ作りは、頭・印を落とした文と投げられた値を formatChatError に渡す', () => {
    const src = read('src/shared/chatTurn.ts')
    expect(src).toContain("ports.h.formatChatError(stripRemoteHead(e), 'sakura', e)")
    expect(src).not.toContain("ports.h.formatChatError(e?.message ?? String(e), 'sakura', e)")
  })
})

describe('formatChatError: 呼び出し元が原文のまま渡しても、IPC の頭と種類の印は画面に出ない', () => {
  it('知らない状態番号（原文を出す最後の分岐）でも、印と英語の頭を落とす', async () => {
    const { formatChatError } = await import('../src/shared/aiToolsCore')
    const { messageForIpc } = await import('../src/shared/failureText')
    const carried = messageForIpc(Object.assign(new Error('Unprocessable request'), { status: 422 }))
    expect(carried).toContain('⟦koto-failure')
    const text = formatChatError(`Error invoking remote method 'sakura:chat': Error: ${carried}`)
    expect(text).toContain('Unprocessable request')
    expect(text).not.toContain('⟦')
    expect(text).not.toContain('koto-failure')
    expect(text).not.toContain('Error invoking remote method')
  })
  it('空の文は空のまま扱う（undefined などの文字にしない）', async () => {
    const { formatChatError } = await import('../src/shared/aiToolsCore')
    expect(formatChatError('')).not.toContain('undefined')
  })
})
