// B'-3c: 会話データの持ち主を renderer から main へ移す（プロジェクト別チャットのみ）。
// 対象: src/main/chat/convStore.ts（会話の唯一の持ち主・実ファイルで検証）と、
// その配線（turnRunner.ts / ChatPanel.tsx / useAiChat.ts / chatConvClient.ts。readCode 方式）。
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  loadConversation, applyConversationOps, flushConversations, resetConversations, type Op,
} from '../src/main/chat/convStore'
import { projectChatPath } from '../src/main/chatStore/paths'
import { loadProjectChatFile, saveProjectChatFile, resetChatLogCache } from '../src/main/chatStore/file'
import { isV1ChatLog } from '../src/main/chatStore/log'
import { applyToMessages } from '../src/shared/chatEvents'
import { makeConvClient } from '../src/renderer/chatConvClient'

// ── tmp ディレクトリの後始末 ─────────────────────────────────────────
let tmpDirs: string[] = []
function mkProjectDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-convstore-'))
  tmpDirs.push(d)
  return d
}

beforeEach(() => {
  tmpDirs = []
  resetConversations() // convStore.ts のメモリ（モジュール内 Map）はテスト間で残り続けるため
  resetChatLogCache() // chatStore/file.ts の cache も同様
})
afterEach(() => {
  resetConversations()
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})

describe('convStore: loadConversation', () => {
  it('1. 未保存 → load が null（空配列ではなく）', () => {
    const dir = mkProjectDir()
    expect(loadConversation(dir)).toBeNull()
  })

  it("2. v1 の実ファイル → load で読める（B'-1 の fold と同じ）", () => {
    const dir = mkProjectDir()
    const arr = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }]
    const filePath = projectChatPath(dir)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(arr), 'utf-8') // v1（配列まるごと）として直接書く
    expect(loadConversation(dir)).toEqual(arr)
  })

  it('読み込んだ配列を書き換えても内部の状態は壊れない（コピーを返す）', () => {
    const dir = mkProjectDir()
    applyConversationOps(dir, [{ kind: 'append', msg: { role: 'user', content: 'a' } }])
    const a = loadConversation(dir)!
    a.push({ role: 'user', content: '横から差し込む' } as any)
    const b = loadConversation(dir)!
    expect(b).toHaveLength(1) // a への破壊的操作は b に影響しない
  })
})

describe('convStore: applyConversationOps は applyToMessages と同じ結果になる', () => {
  const NOW = new Date(2026, 7, 28, 9, 0, 0)
  const withFrozenClock = (fn: () => void) => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(NOW)
      fn()
    } finally {
      vi.useRealTimers()
    }
  }

  it('3-a. append', () => {
    withFrozenClock(() => {
      const dir = mkProjectDir()
      const msg = { role: 'user', content: 'hi' }
      const op: Op = { kind: 'append', msg }
      applyConversationOps(dir, [op])
      expect(loadConversation(dir)).toEqual(applyToMessages([], op, NOW))
    })
  })

  it('3-b. replaceLast', () => {
    withFrozenClock(() => {
      const dir = mkProjectDir()
      applyConversationOps(dir, [{ kind: 'append', msg: { role: 'user', content: 'a' } }])
      const prev = loadConversation(dir)!
      const op: Op = { kind: 'replaceLast', msg: { role: 'user', content: 'b' } }
      applyConversationOps(dir, [op])
      expect(loadConversation(dir)).toEqual(applyToMessages(prev, op, NOW))
    })
  })

  it('3-c. removeLast', () => {
    withFrozenClock(() => {
      const dir = mkProjectDir()
      applyConversationOps(dir, [
        { kind: 'append', msg: { role: 'user', content: 'a' } },
        { kind: 'append', msg: { role: 'user', content: 'b' } },
      ])
      const prev = loadConversation(dir)!
      const op: Op = { kind: 'removeLast' }
      applyConversationOps(dir, [op])
      expect(loadConversation(dir)).toEqual(applyToMessages(prev, op, NOW))
    })
  })

  it('3-d. replaceAll はそのまま採用される（stampしない＝at を勝手に付けない）', () => {
    const dir = mkProjectDir()
    applyConversationOps(dir, [{ kind: 'append', msg: { role: 'user', content: 'a' } }])
    const replacement = [{ role: 'assistant', content: 'x' }] // at 無し
    applyConversationOps(dir, [{ kind: 'replaceAll', messages: replacement }])
    expect(loadConversation(dir)).toEqual(replacement) // stamp されていない（at が付かない）
  })
})

describe('convStore: 保存（デバウンス・quit時フラッシュ・削除ガード）', () => {
  it('4. ops後 flush → ファイルが v2 で、読み直すと一致。thinking が保存されていない（forStorage）', () => {
    const dir = mkProjectDir()
    applyConversationOps(dir, [{ kind: 'append', msg: { role: 'assistant', content: 'ok', thinking: 'あ'.repeat(500) } }])
    flushConversations()

    const raw = fs.readFileSync(projectChatPath(dir), 'utf-8')
    expect(isV1ChatLog(raw)).toBe(false) // v2（追記式JSONL）で書かれている

    resetConversations() // メモリを空にして、本当にファイルから読めるか確かめる
    const reloaded = loadConversation(dir)
    expect(reloaded).toHaveLength(1)
    expect(reloaded![0]).toMatchObject({ role: 'assistant', content: 'ok' })
    expect('thinking' in reloaded![0]).toBe(false) // forStorage を通っている証拠
  })

  it('5. デバウンス: flush 前はファイルが変わらない・flush で書かれる', () => {
    const dir = mkProjectDir()
    applyConversationOps(dir, [{ kind: 'append', msg: { role: 'user', content: 'a' } }])
    expect(fs.existsSync(projectChatPath(dir))).toBe(false) // 1.5秒のデバウンス中はまだ書かれない
    flushConversations()
    expect(fs.existsSync(projectChatPath(dir))).toBe(true)
    expect(loadProjectChatFile(projectChatPath(dir)).ok).toBe(true)
  })


  // flushNow（2026-08-28）: 旧localStorage移行は「元を消す前にファイルへ書き切る」ため、
  // デバウンスを待たずに即時保存できること。
  it('flushNow: デバウンスを待たずに即時にファイルへ書かれる', () => {
    const dir = mkProjectDir()
    applyConversationOps(dir, [{ kind: 'replaceAll', messages: [{ role: 'user', content: '移行された1件' }] }], { flushNow: true })
    const raw = fs.readFileSync(path.join(dir, '.sakuraide', 'chat.json'), 'utf-8')
    expect(raw.startsWith('{"v":2}')).toBe(true)
    expect(raw).toContain('移行された1件')
  })

  it('6. プロジェクトのフォルダを消してから flush → ファイルが蘇生しない', () => {
    const dir = mkProjectDir()
    applyConversationOps(dir, [{ kind: 'append', msg: { role: 'user', content: 'a' } }])
    flushConversations()
    expect(fs.existsSync(dir)).toBe(true) // 前提: いったん実在する

    fs.rmSync(dir, { recursive: true, force: true }) // プロジェクトごと削除（ゴミ箱移動を模す）
    applyConversationOps(dir, [{ kind: 'append', msg: { role: 'user', content: 'b' } }]) // 削除後に来た書き換え
    flushConversations()

    expect(fs.existsSync(dir)).toBe(false) // フォルダごと蘇生しない（2026-07-14 の決まり）
  })

  it('7. 未ロードの projectDir に ops → 既存ファイルの中身が失われず、末尾に足される', () => {
    const dir = mkProjectDir()
    // 直接 chatStore/file.ts で「前回のアプリ起動で保存済みの会話」を作る
    saveProjectChatFile(projectChatPath(dir), JSON.stringify([{ role: 'user', content: 'existing' }]))
    resetConversations() // このプロセスのメモリにはまだ何も乗っていない（未ロード）状態を作る

    applyConversationOps(dir, [{ kind: 'append', msg: { role: 'user', content: 'new' } }])
    flushConversations()

    resetConversations() // 本当にファイルへ反映されたかを、メモリに頼らず確かめる
    const reloaded = loadConversation(dir)
    expect(reloaded).toHaveLength(2)
    expect(reloaded![0]).toMatchObject({ content: 'existing' })
    expect(reloaded![1]).toMatchObject({ content: 'new' })
  })

  it('8. 実物形式の往復（role/content/toolNote/images/hidden/summary/at）', () => {
    const dir = mkProjectDir()
    const msg = {
      role: 'assistant',
      content: '直しました。改行\nを含む本文や "引用符" も入ります。',
      toolNote: 'read_file: src/App.tsx',
      images: ['data:image/png;base64,AAAA'],
      hidden: false,
      summary: '要約テキスト',
      at: '2026-08-27T01:00:05.000Z', // 既に at がある → stamp で上書きされない
    }
    applyConversationOps(dir, [{ kind: 'append', msg: msg as any }])
    flushConversations()
    resetConversations()
    expect(loadConversation(dir)).toEqual([msg])
  })
})

// ── 配線（readCode 方式・コメント除去）─────────────────────────────────
// ⚠️ コメントを外してから判定する（tests/chatEvents.test.ts / chatTurnBridge.test.ts と同じ流儀。
// 2026-08-20 に自分の説明コメントにテストが当たって落ちた事故があるため）。
const readCode = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*')
    })
    .join('\n')

describe('9. turnRunner: message系 emit が applyConversationOps を通る（toolsProjectDir あり時）', () => {
  const src = readCode('src/main/chat/turnRunner.ts')

  it('import している', () => {
    expect(src).toContain("import { applyConversationOps } from './convStore'")
  })

  it('emit: の定義（buildMainPorts の中）が applyConversationOps(payload.spec.toolsProjectDir, [ev]) を、wc.send より前に呼ぶ', () => {
    const start = src.indexOf('emit: (ev) => {')
    expect(start).toBeGreaterThan(-1)
    const closeIdx = src.indexOf('\n    },', start) // このプロパティの閉じ（4スペース）
    expect(closeIdx).toBeGreaterThan(-1)
    const block = src.slice(start, closeIdx)
    expect(block).toContain('applyConversationOps(payload.spec.toolsProjectDir, [ev])')
    expect(block.indexOf('applyConversationOps(')).toBeLessThan(block.indexOf('wc.send('))
    // message系（append/replaceLast/removeLast）だけを対象にしている条件があること
    expect(block).toContain("ev.kind === 'append'")
    expect(block).toContain("ev.kind === 'replaceLast'")
    expect(block).toContain("ev.kind === 'removeLast'")
  })
})

describe('10. ChatPanel: 旧 chatStorage の読み書きがもう無い・デバウンス保存の effect が無い', () => {
  const src = readCode('src/renderer/components/ChatPanel.tsx')

  it("旧 renderer/chatStorage.ts の loadProjectChat/saveProjectChat を import していない", () => {
    expect(src).not.toContain("from '../chatStorage'")
    expect(src).not.toContain('loadProjectChat(')
    expect(src).not.toContain('saveProjectChat(')
  })

  it('新しい chatConvClient.ts（loadConversationView / makeConvClient）を使っている', () => {
    expect(src).toContain("from '../chatConvClient'")
    expect(src).toContain('loadConversationView(projectDir)')
    expect(src).toContain('makeConvClient(projectDir, applyOpLocally)')
  })

  it('1.5秒デバウンス保存・アンマウント時フラッシュの effect が無い（window.setTimeout / messagesRef が出てこない）', () => {
    expect(src).not.toContain('window.setTimeout')
    expect(src).not.toContain('window.clearTimeout')
    expect(src).not.toContain('messagesRef')
  })
})

describe('12. chatConvClient: 送信が直列化されていること（Promiseチェーン）', () => {
  it('前の invoke が返るまで、次の invoke（chat.ops）を呼ばない', async () => {
    const calls: string[] = []
    let resolveFirst: ((v: { ok: true }) => void) | null = null
    const opsMock = vi.fn((_projectDir: string, ops: any[]) => {
      const tag = ops[0]?.msg?.content ?? ops[0]?.kind
      calls.push(`call:${tag}`)
      if (calls.length === 1) {
        return new Promise(resolve => { resolveFirst = resolve })
      }
      return Promise.resolve({ ok: true })
    })
    ;(globalThis as any).window = { electronAPI: { chat: { ops: opsMock } } }

    const applied: any[] = []
    const client = makeConvClient('/tmp/koto-proj', op => applied.push(op))

    client.apply({ kind: 'append', msg: { role: 'user', content: 'first' } } as any)
    client.apply({ kind: 'append', msg: { role: 'user', content: 'second' } } as any)

    // 画面反映（applyLocal）は直列化しない＝即時に両方とも反映される
    expect(applied).toHaveLength(2)

    // マイクロタスクを十分に流しても、1件目の invoke が解決するまで2件目は呼ばれない
    await new Promise(r => setImmediate(r))
    expect(opsMock).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['call:first'])

    resolveFirst!({ ok: true })
    await client.idle()
    expect(opsMock).toHaveBeenCalledTimes(2)
    expect(calls).toEqual(['call:first', 'call:second']) // 到着順が送った順と一致する
  })

})
