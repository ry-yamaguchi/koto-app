// B'-3c: 会話データの持ち主を renderer から main へ移す（プロジェクト別チャットのみ）。
// 対象: src/main/chat/convStore.ts（会話の唯一の持ち主・実ファイルで検証）と、
// その配線（turnRunner.ts / ChatPanel.tsx / useAiChat.ts / chatConvClient.ts。readCode 方式）。
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  loadConversation, loadConversationState, applyConversationOps, flushConversations, resetConversations,
  setApplyListener, dropConversation, type Op,
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
  setApplyListener(null) // モジュール内のリスナーもテスト間で残り続けるため外す（B-1a）
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

describe('convStore: setApplyListener（B-1a・画面への押し出し口）', () => {
  it('1. op ごとに（projectDir, op, 当てた直後の length）で呼ばれる。まとめて1回ではない', () => {
    const dir = mkProjectDir()
    const calls: Array<{ projectDir: string; op: Op; length: number }> = []
    setApplyListener((projectDir, op, length) => calls.push({ projectDir, op, length }))

    // replaceLast の連打（ストリーミングの差分を模す）を含む3件をまとめて渡す
    applyConversationOps(dir, [
      { kind: 'append', msg: { role: 'assistant', content: '' } },
      { kind: 'replaceLast', msg: { role: 'assistant', content: 'a' } },
      { kind: 'replaceLast', msg: { role: 'assistant', content: 'ab' } },
    ])

    expect(calls).toHaveLength(3) // 1回にまとめられていない
    expect(calls.map(c => c.projectDir)).toEqual([dir, dir, dir])
    expect(calls.map(c => c.length)).toEqual([1, 1, 1]) // append で1件→以降 replaceLast なので長さは1のまま
    expect(calls[0].op).toEqual({ kind: 'append', msg: { role: 'assistant', content: '', at: expect.any(String) } })
    expect(calls[2].op).toMatchObject({ kind: 'replaceLast', msg: { content: 'ab' } })
  })

  it('通知される op の msg には、実際に保存された値（stamp 済みの at）が入っている（二重stamp防止）', () => {
    const dir = mkProjectDir()
    let seenAt: string | undefined
    setApplyListener((_dir, op) => { if (op.kind === 'append') seenAt = op.msg.at })

    applyConversationOps(dir, [{ kind: 'append', msg: { role: 'user', content: 'hi' } }])

    expect(seenAt).toBeDefined()
    expect(loadConversation(dir)![0].at).toBe(seenAt) // 保存された at と通知された at が完全一致
  })

  it('setApplyListener(null) で外せる（以後は呼ばれない）', () => {
    const dir = mkProjectDir()
    let called = 0
    setApplyListener(() => { called++ })
    setApplyListener(null)
    applyConversationOps(dir, [{ kind: 'append', msg: { role: 'user', content: 'a' } }])
    expect(called).toBe(0)
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

// B'-3e-a: 単独チャット（ChatApp）のセッション削除で、擬似 dir のフォルダを消すのと合わせて
// convStore のメモリ（保存待ちタイマー含む）も落とせるようにするための最小追加。
// resetConversations は全プロジェクトを巻き込むため使えず、この1件だけを狙って落とす。
describe("convStore: dropConversation（B'-3e-a・1件だけキャッシュを破棄）", () => {
  it('保存待ち（デバウンス中）のタイマーごと落ちる。drop後に flush してもファイルは書かれない', () => {
    const dir = mkProjectDir()
    applyConversationOps(dir, [{ kind: 'append', msg: { role: 'user', content: 'a' } }])
    expect(fs.existsSync(projectChatPath(dir))).toBe(false) // まだデバウンス中

    dropConversation(dir)
    flushConversations() // drop 済みなので、この dir 分の保存は走らない
    expect(fs.existsSync(projectChatPath(dir))).toBe(false)
  })

  it('drop 後に同じ dir へ ops を送ると、メモリが無い状態から作り直される（フォルダが実在すれば普通に保存できる）', () => {
    const dir = mkProjectDir()
    applyConversationOps(dir, [{ kind: 'append', msg: { role: 'user', content: 'a' } }])
    flushConversations()
    dropConversation(dir)

    applyConversationOps(dir, [{ kind: 'append', msg: { role: 'user', content: 'b' } }])
    flushConversations()
    resetConversations()
    // drop 前の 'a' はファイルに残ったまま（ensureEntry がファイルから読み直して積み増す）。
    // 消えたのはメモリのキャッシュだけで、ディスクの内容は壊れていないことの確認。
    const reloaded = loadConversation(dir)
    expect(reloaded).toHaveLength(2)
    expect(reloaded![1]).toMatchObject({ content: 'b' })
  })

  it('未ロードの dir に対しては何もしない（例外を投げない）', () => {
    const dir = mkProjectDir()
    expect(() => dropConversation(dir)).not.toThrow()
  })

  it('他の dir のキャッシュには影響しない', () => {
    const a = mkProjectDir()
    const b = mkProjectDir()
    applyConversationOps(a, [{ kind: 'append', msg: { role: 'user', content: 'a' } }])
    applyConversationOps(b, [{ kind: 'append', msg: { role: 'user', content: 'b' } }])
    dropConversation(a)
    flushConversations()
    expect(fs.existsSync(projectChatPath(a))).toBe(false) // a は drop 済み → 保存されない
    expect(fs.existsSync(projectChatPath(b))).toBe(true) // b は無事に保存される
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

describe('9. turnRunner: message系 emit が applyConversationOps を通る（convDir あり時・B\'-3e-b）', () => {
  const src = readCode('src/main/chat/turnRunner.ts')

  it('import している', () => {
    // B'-3d-3: getHistory が convStore.loadConversation も直読みするようになり、同じ import 文に相乗り
    expect(src).toContain("import { applyConversationOps, loadConversation } from './convStore'")
  })

  // B'-3d-2b: emit はオブジェクトリテラルの中の直書きプロパティ（emit: (ev) => {...}）から、
  // buildMainPorts 内の局所 const（const emit: EngineTurnPorts['emit'] = (ev) => {...}）へ
  // 形が変わった（executeTool の io（buildMainIo）からも同じ emit を参照するため）。
  // 中身の判定順序・条件は1文字も変えていない——探す形だけをこの新しい形に合わせる。
  //
  // B'-3e-b: 判定・書き込み先を toolsProjectDir から convDir へ変えた（単独チャットも
  // main が書き主になった。会話の置き場＝convDir と、ツールの根＝toolsProjectDir は別物）。
  it("emit の定義（buildMainPorts の中の const emit）が applyConversationOps(payload.spec.convDir, [ev]) を、wc.send より前に呼ぶ", () => {
    const start = src.indexOf("const emit: EngineTurnPorts['emit'] = (ev) => {")
    expect(start).toBeGreaterThan(-1)
    const closeIdx = src.indexOf('\n  }', start) // この const の閉じ（2スペース・関数直下）
    expect(closeIdx).toBeGreaterThan(-1)
    const block = src.slice(start, closeIdx)
    expect(block).toContain('applyConversationOps(payload.spec.convDir, [ev])')
    expect(block).not.toContain('applyConversationOps(payload.spec.toolsProjectDir, [ev])')
    expect(block.indexOf('applyConversationOps(')).toBeLessThan(block.indexOf('wc.send('))
    // message系（append/replaceLast/removeLast）だけを対象にしている条件があること
    expect(block).toContain("ev.kind === 'append'")
    expect(block).toContain("ev.kind === 'replaceLast'")
    expect(block).toContain("ev.kind === 'removeLast'")
  })

  it('返り値の EngineTurnPorts オブジェクトは、この const emit をそのまま使っている（複製していない）', () => {
    expect(src).toContain('return {\n    emit,')
  })
})

describe('10. ChatPanel: 旧 chatStorage の読み書きがもう無い・デバウンス保存の effect が無い', () => {
  const src = readCode('src/renderer/components/ChatPanel.tsx')

  it("旧 renderer/chatStorage.ts の loadProjectChat/saveProjectChat を import していない", () => {
    expect(src).not.toContain("from '../chatStorage'")
    expect(src).not.toContain('loadProjectChat(')
    expect(src).not.toContain('saveProjectChat(')
  })

  it('新しい chatConvClient.ts（loadConversationChecked / makeConvClient）を使っている', () => {
    expect(src).toContain("from '../chatConvClient'")
    expect(src).toContain('loadConversationChecked(projectDir)')
    // B-1a: makeConvClient はもう画面へのローカル反映を受け取らない（applyOpLocally を渡さない）
    expect(src).toContain('makeConvClient(projectDir)')
    expect(src).not.toContain('makeConvClient(projectDir, applyOpLocally)')
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

    // B-1a: makeConvClient はもう画面へのローカル反映を持たない（引数は projectDir だけ）
    const client = makeConvClient('/tmp/koto-proj')

    client.apply({ kind: 'append', msg: { role: 'user', content: 'first' } } as any)
    client.apply({ kind: 'append', msg: { role: 'user', content: 'second' } } as any)

    // マイクロタスクを十分に流しても、1件目の invoke が解決するまで2件目は呼ばれない
    await new Promise(r => setImmediate(r))
    expect(opsMock).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['call:first'])

    resolveFirst!({ ok: true })
    await client.idle()
    expect(opsMock).toHaveBeenCalledTimes(2)
    expect(calls).toEqual(['call:first', 'call:second']) // 到着順が送った順と一致する
  })

  it('apply(op) は ops 送信だけで、画面への反映は一切行わない（B-1a）', async () => {
    const opsMock = vi.fn(() => Promise.resolve({ ok: true }))
    ;(globalThis as any).window = { electronAPI: { chat: { ops: opsMock } } }
    // makeConvClient の第2引数（applyLocal）はもう受け取れない・呼ばれない
    const client = makeConvClient('/tmp/koto-proj')
    client.apply({ kind: 'append', msg: { role: 'user', content: 'x' } } as any)
    await client.idle() // chain は Promise チェーンなので、送信は次のマイクロタスクまで待つ
    expect(opsMock).toHaveBeenCalledWith('/tmp/koto-proj', [{ kind: 'append', msg: { role: 'user', content: 'x' } }])
  })
})

// ── 壊れた記録を「無い」と区別し、読んだ時点で写しを残す（0.6.26）──────────────────────
// 会話を読む入口は3つ（chat:load が呼ぶ loadConversation・書き込みの前の ensureEntry・AI のターンの履歴
// loadConversation(dir) ?? []）。どれも readFromFile を通り、写しは file.ts の1か所で作る。
// 本物の一時フォルダで、写しの有無・中身と、書き込みの前後のディスクを見る。
describe('convStore: 壊れた記録は「無い」と区別し、読んだ時点で写しを残す', () => {
  const STAMP_NAME = 'chat.json.broken-20261103-142530'
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
  const MSG = { role: 'user', content: '新しい発言' }

  const sideOf = (dir: string) => path.dirname(projectChatPath(dir))
  const copiesOf = (dir: string) =>
    fs.existsSync(sideOf(dir)) ? fs.readdirSync(sideOf(dir)).filter((n) => n.startsWith('chat.json.broken-')).sort() : []
  const putBroken = (dir: string, content: string | Buffer) => {
    fs.mkdirSync(sideOf(dir), { recursive: true })
    fs.writeFileSync(projectChatPath(dir), content)
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 3, 14, 25, 30))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // 壊れた記録の表（JSON でない・途中で切れた v1・v1 と v2 の混在）
  const BROKEN: Array<[string, string]> = [
    ['JSON でない', '会話の記録ではない文字列'],
    ['途中で切れた v1', '[{"role":"user","content":"前の発言"},{"role":"assis'],
    ['v1 と v2 の混在', '[{"role":"user","content":"前の発言"}]\n{"i":1,"m":{"role":"user","content":"続き"}}\n'],
  ]
  // 会話を読む入口。どれも読んだ時点で写しができる
  const DOORS: Array<[string, (dir: string) => void]> = [
    ['chat:load が呼ぶ loadConversation', (dir) => { loadConversation(dir) }],
    ['書き込みの前の ensureEntry（applyConversationOps）', (dir) => applyConversationOps(dir, [{ kind: 'append', msg: MSG }])],
    ['AI のターンの履歴 loadConversation(dir) ?? []', (dir) => { void (loadConversation(dir) ?? []) }],
  ]

  describe.each(BROKEN)('%s', (_label, content) => {
    it.each(DOORS)('入口「%s」: 最初の書き込みより前に、元と同じ中身の写しがある。元はまだその場にある', (_door, open) => {
      const dir = mkProjectDir()
      putBroken(dir, content)

      open(dir) // 書き込み（flush）はまだしていない

      expect(copiesOf(dir)).toEqual([STAMP_NAME])
      expect(fs.readFileSync(path.join(sideOf(dir), STAMP_NAME), 'utf-8')).toBe(content)
      expect(fs.readFileSync(projectChatPath(dir), 'utf-8')).toBe(content) // 元は消えず、名前も変わらず、中身も同じ
    })

    it('書き込みが進んだあとも、写しは元の中身のまま残る。chat.json は新しい会話に置き換わる', () => {
      const dir = mkProjectDir()
      putBroken(dir, content)

      applyConversationOps(dir, [{ kind: 'append', msg: MSG }])
      flushConversations()

      expect(fs.readFileSync(path.join(sideOf(dir), STAMP_NAME), 'utf-8')).toBe(content)
      resetConversations()
      expect(loadConversation(dir)).toEqual([expect.objectContaining(MSG)])
      expect(copiesOf(dir)).toEqual([STAMP_NAME])
    })
  })

  it('読んだ結果は messages が null のまま、unreadable で「無い」と区別できる。メモリに載ったあとも同じ', () => {
    const dir = mkProjectDir()
    putBroken(dir, '壊れた記録')

    expect(loadConversation(dir)).toBeNull() // 旧 localStorage の移行の判定は今までどおり null
    expect(loadConversationState(dir)).toEqual({ messages: null, unreadable: { backupName: STAMP_NAME } })

    applyConversationOps(dir, [{ kind: 'append', msg: MSG }])
    const after = loadConversationState(dir)
    expect(after.messages).toEqual([expect.objectContaining(MSG)])
    expect(after.unreadable).toEqual({ backupName: STAMP_NAME })
  })

  it('ファイルが無い回は今までどおり null で、unreadable は無く、写しを作らない', () => {
    const dir = mkProjectDir()
    expect(loadConversation(dir)).toBeNull()
    expect(loadConversationState(dir)).toEqual({ messages: null, unreadable: null })
    applyConversationOps(dir, [{ kind: 'append', msg: MSG }])
    flushConversations()
    expect(copiesOf(dir)).toEqual([])
    expect(loadConversationState(dir).unreadable).toBeNull()
  })

  it('読めて空の記録（ヘッダだけの v2）は、壊れたものではない。写しを作らない', () => {
    const dir = mkProjectDir()
    putBroken(dir, '{"v":2}\n')
    expect(loadConversationState(dir)).toEqual({ messages: [], unreadable: null })
    expect(copiesOf(dir)).toEqual([])
  })

  it('同じ記録を何度読んでも、書き込みの前の ensureEntry を通っても、写しは1つ', () => {
    const dir = mkProjectDir()
    putBroken(dir, '壊れた記録')
    loadConversation(dir)
    loadConversation(dir)
    applyConversationOps(dir, [{ kind: 'append', msg: MSG }])
    loadConversationState(dir)
    expect(copiesOf(dir)).toEqual([STAMP_NAME])
  })

  it('写しを作れなかった回（backupName: null）は、その会話へ書き込まない。ディスクの前後が同じ', () => {
    const dir = mkProjectDir()
    const original = '壊れた記録（写しを作れない回）'
    putBroken(dir, original)
    // 同じ秒の名前をすべて別の中身で埋めて、写しの名前を取れなくする（フォルダ自体は書ける）
    for (let n = 1; n <= 50; n++) {
      fs.writeFileSync(path.join(sideOf(dir), n === 1 ? STAMP_NAME : `${STAMP_NAME}-${n}`), `別の写し${n}`)
    }
    const listing = fs.readdirSync(sideOf(dir)).sort()

    applyConversationOps(dir, [{ kind: 'append', msg: MSG }])
    flushConversations()
    applyConversationOps(dir, [{ kind: 'append', msg: { role: 'assistant', content: '返事' } }], { flushNow: true })
    flushConversations()

    expect(fs.readdirSync(sideOf(dir)).sort()).toEqual(listing) // 新しいファイルも .tmp も増えていない
    expect(fs.readFileSync(projectChatPath(dir), 'utf-8')).toBe(original) // 元は置き換わっていない
    expect(loadConversationState(dir).unreadable).toEqual({ backupName: null })
    expect(loadConversation(dir)).toHaveLength(2) // 画面の会話は続く（書かないだけ）
  })

  it.skipIf(isRoot)('読めない記録（権限を外したファイル）の回も、写しを作れず、書き込まない', () => {
    const dir = mkProjectDir()
    putBroken(dir, '権限を外す前の中身')
    const file = projectChatPath(dir)
    fs.chmodSync(file, 0o000)
    try {
      applyConversationOps(dir, [{ kind: 'append', msg: MSG }], { flushNow: true })
      flushConversations()
      expect(loadConversationState(dir).unreadable).toEqual({ backupName: null })
      expect(fs.readdirSync(sideOf(dir))).toEqual(['chat.json'])
    } finally {
      fs.chmodSync(file, 0o644)
    }
    expect(fs.readFileSync(file, 'utf-8')).toBe('権限を外す前の中身')
  })

  it('読む処理そのものが例外を投げた回（入れ子が深すぎて畳めない記録）も「無い」にせず、書き込まない', () => {
    const dir = mkProjectDir()
    const deep = 100000
    const original = '{"v":2}\n{"i":0,"m":' + '['.repeat(deep) + ']'.repeat(deep) + '}\n'
    putBroken(dir, original)

    expect(loadConversation(dir)).toBeNull()
    expect(loadConversationState(dir)).toEqual({ messages: null, unreadable: { backupName: null } })
    applyConversationOps(dir, [{ kind: 'append', msg: MSG }], { flushNow: true })
    flushConversations()

    expect(fs.readFileSync(projectChatPath(dir), 'utf-8')).toBe(original) // 置き換わっていない
    expect(fs.readdirSync(sideOf(dir))).toEqual(['chat.json'])
  })

  it('写しがあれば書き込みは止めない（置き換えても、写しに元が残っているため）', () => {
    const dir = mkProjectDir()
    putBroken(dir, '壊れた記録')
    applyConversationOps(dir, [{ kind: 'append', msg: MSG }], { flushNow: true })
    expect(fs.readFileSync(projectChatPath(dir), 'utf-8').startsWith('{"v":2}')).toBe(true)
    expect(fs.readFileSync(path.join(sideOf(dir), STAMP_NAME), 'utf-8')).toBe('壊れた記録')
  })
})

// 配線の形（コメントを外した本文）。呼び出しの形ごと指し、直す前の形は not.toContain で禁じる。
describe('convStore / file.ts: 写しを作る入口は1か所（読む入口は readFromFile を通る）', () => {
  const conv = readCode('src/main/chat/convStore.ts')
  const file = readCode('src/main/chatStore/file.ts')

  it('convStore は chat.json を loadProjectChatFile(projectChatPath(projectDir)) の1か所だけで読み、unreadable を運ぶ', () => {
    expect(conv.split('loadProjectChatFile(projectChatPath(projectDir))').length - 1).toBe(1)
    // 壊れた行を捨てて読めた分は、messages にその分を入れ、unreadable と一緒に運ぶ
    expect(conv).toContain('if (result.unreadable) {\n      return { messages: result.json === null ? null : parseMessages(result.json), unreadable: result.unreadable }\n    }')
    expect(conv).toContain('entry = { messages: read.messages ?? [], timer: null, unreadable }')
    expect(conv).not.toContain('if (result.unreadable) return { messages: null, unreadable: result.unreadable }')
    // 直す前の形（壊れた記録を null＝無いと同じにして、ensureEntry が空配列で始める）
    expect(conv).not.toContain('if (!result.ok || result.json === null) return null')
    expect(conv).not.toContain('const fromFile = readFromFile(projectDir)')
  })

  it('保存の書き口 saveNow は、写しを作れなかった回を saveProjectChatFile より前に止める', () => {
    const start = conv.indexOf('function saveNow(')
    const block = conv.slice(start, conv.indexOf('\n}', start))
    const guard = block.indexOf('if (entry.unreadable && entry.unreadable.backupName === null) return')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(block.indexOf('saveProjectChatFile(projectChatPath(projectDir)'))
    // 会話をファイルへ書く呼び出しは saveNow の1か所だけ
    expect(conv.split('saveProjectChatFile(').length - 1).toBe(1)
  })

  it('file.ts は壊れた記録の写しを copyBrokenOnce(filePath, state.bytes) の1か所で作り、読めないものを「無い」にしない', () => {
    expect(file.split('copyBrokenOnce(filePath, state.bytes)').length - 1).toBe(1)
    expect(file).toContain("if (state.kind === 'unreadable') return { kind: 'unreadable', unreadable: { backupName: null } }")
    expect(file).toContain("if (found.kind === 'unreadable') return { ok: true, json: null, unreadable: found.unreadable }")
    // 直す前の形（存在しない・読めないを同じ null にする読み方）
    expect(file).not.toContain('readFileOrNull')
    expect(file).not.toContain('if (!folded) return { ok: true, json: null }')
  })
})
