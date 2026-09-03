import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// 🕘「元に戻す」の完了を会話へ記録する配線（0.3.50・roadmap「次の改善2件」その2）。
// B-1a（2026-08-28）で、会話の画面更新経路を「main のストア（convStore.ts）からの押し出し
// （chat:applied）」1本にした。以前ここにあった backup:restore ハンドラの手動 send
// （chat:appended）と、ChatPanel の chat.onAppended 購読は廃止し、chat:applied 1本に揃えた。
//
// ── なぜ readCode か ─────────────────────────────────────────────────
// src/main/ipc/backup.ts・src/main/ipc/chatStore.ts は electron（ipcMain）を import しているため、
// node の vitest からそのまま呼び出せない（tests/publishRootWiring.test.ts と同じ事情）。
// ソースを読んで、「呼び出しの形そのもの」を固定する（掟10: 「どこかに書いてある」
// だけでは直し忘れを捕まえられない。呼び出しごと見る・直す前の形は not.toContain で禁じる）。

const ROOT = path.join(__dirname, '..')
const raw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
// コメントでの言及（「ここで直接 append し」等）だけを拾って誤検知しないよう、コメント行を除く。
const stripped = (rel: string) => raw(rel).split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')

describe('配線: backup:restore ハンドラが会話へ記録している', () => {
  it('復元が ok のとき applyConversationOps を通る（画面への手動 send はもう無い＝chat:appended 廃止）', () => {
    const src = stripped('src/main/ipc/backup.ts')
    expect(src).toContain("applyConversationOps(projectDir, [{ kind: 'append', msg }])")
    // B-1a: 手動の chat:appended send は廃止した（convStore の通知口が自動的に届けるため）
    expect(src).not.toContain("send('chat:appended'")
    expect(src).not.toContain('chat:appended')
  })

  it('applyConversationOps は if (result.ok) の中にある（失敗時は会話に書かない）', () => {
    const src = stripped('src/main/ipc/backup.ts')
    const at = src.indexOf('if (result.ok) {')
    expect(at).toBeGreaterThan(-1)
    const block = src.slice(at, src.indexOf('\n  })', at))
    expect(block).toContain('applyConversationOps(')
  })

  it('restoreNoteMessage を stamp() してから使う（会話ストアと画面で同じ時刻にする）', () => {
    const src = stripped('src/main/ipc/backup.ts')
    expect(src).toContain('restoreNoteMessage({ label,')
    expect(src).toContain('stamp(note)')
  })

  it('label はスナップショット一覧から取る（listSnapshotSummaries）', () => {
    const src = stripped('src/main/ipc/backup.ts')
    expect(src).toContain('listSnapshotSummaries(projectDir).snapshots.find(s => s.id === snapshotId)?.label')
  })
})

describe('配線: ipc/chatStore.ts が convStore の通知口（chat:applied）を配線している（B-1a）', () => {
  it('setApplyListener を import し、chat:applied を sendToWindow で送る', () => {
    const src = stripped('src/main/ipc/chatStore.ts')
    expect(src).toContain("setApplyListener, type Op } from '../chat/convStore'")
    expect(src).toContain("import { sendToWindow } from '../windowSend'")
    expect(src).toContain("setApplyListener((projectDir, op, length) => {")
    expect(src).toContain("sendToWindow(deps.getMainWindow(), 'chat:applied', { projectDir, op, length })")
  })

  it('destroyed ガードは windowSend.ts の sendToWindow に任せている（自前で ?. や isDestroyed を書いていない）', () => {
    const src = stripped('src/main/ipc/chatStore.ts')
    const at = src.indexOf('setApplyListener((projectDir, op, length) => {')
    expect(at).toBeGreaterThan(-1)
    // このコールバックの実装は1行（sendToWindow呼び出し1つ）に収まっているはずなので、
    // 十分な幅（300文字）を取れば "})" の誤検知（sendToWindow呼び出し自身の閉じ）を避けられる。
    const block = src.slice(at, at + 300)
    expect(block).not.toContain('isDestroyed')
    expect(block).not.toContain('getMainWindow()?.')
  })
})

describe('配線: ChatPanel が chat.onApplied を購読している（chat.onAppended は廃止）', () => {
  it('onApplied を購読し、projectDir が一致するものだけを扱う', () => {
    const src = stripped('src/renderer/components/ChatPanel.tsx')
    expect(src).toContain('window.electronAPI.chat.onApplied(({ projectDir: dir, op, length }) => {')
    expect(src).toContain('if (dir !== projectDir) return')
    // 直す前の形（chat.onAppended）が残っていない
    expect(src).not.toContain('chat.onAppended')
  })

  it('projectDir 一致ガードは setMessages より前にある（当てる前に必ず確かめている）', () => {
    const src = raw('src/renderer/components/ChatPanel.tsx')
    const at = src.indexOf('window.electronAPI.chat.onApplied(')
    expect(at).toBeGreaterThan(-1)
    const end = src.indexOf('}, [projectDir])', at)
    expect(end).toBeGreaterThan(at)
    const block = src.slice(at, end)
    const guardAt = block.indexOf('if (dir !== projectDir) return')
    const setMessagesAt = block.indexOf('setMessages(')
    expect(guardAt).toBeGreaterThan(-1)
    expect(setMessagesAt).toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(setMessagesAt)
  })

  it('viewSyncDecision で apply/reload を判定し、reload 側で loadConversationView から読み直す', () => {
    const src = raw('src/renderer/components/ChatPanel.tsx')
    const at = src.indexOf('window.electronAPI.chat.onApplied(')
    const end = src.indexOf('}, [projectDir])', at)
    const block = src.slice(at, end)
    expect(block).toContain('viewSyncDecision(op as Op, prev.length, length)')
    expect(block).toContain("decision === 'reload'")
    expect(block).toContain('loadConversationView(dir)')
  })

  // ⚠️ ここで ops（applyOp / client.apply）を送ると、main が convStore.ts へ既に当て済みの
  // 1件がもう一度書かれ、会話に同じ内容が2件残ってしまう（viewOnly でなければならない）。
  it('ops を送らない（viewOnly）。applyOp/clientRef を呼んでいない', () => {
    const src = raw('src/renderer/components/ChatPanel.tsx')
    const at = src.indexOf('window.electronAPI.chat.onApplied(')
    const end = src.indexOf('}, [projectDir])', at)
    const block = src.slice(at, end)
    expect(block).not.toContain('applyOp(')
    expect(block).not.toContain('clientRef.current')
  })
})

describe('配線: chatConvClient / useAiChat に画面へのローカル反映が残っていない（B-1a）', () => {
  it('chatConvClient.ts の makeConvClient は apply(op) で ops 送信だけを行い、applyLocal を持たない', () => {
    const src = stripped('src/renderer/chatConvClient.ts')
    expect(src).toContain('export function makeConvClient(')
    expect(src).not.toContain('applyLocal')
    // apply(op) の中身が chat.ops の送信だけであること（画面への反映呼び出しが無い）
    const at = src.indexOf('apply(op: Op) {')
    expect(at).toBeGreaterThan(-1)
    const end = src.indexOf('\n    },', at)
    const block = src.slice(at, end)
    expect(block).toContain('window.electronAPI.chat.ops(projectDir, [op])')
    expect(block).not.toContain('setMessages')
    expect(block).not.toContain('applyToMessages')
  })

  it('useAiChat.ts の viewOnlyEmit は convDir があるとき message系を捨てる（B\'-3e-b）', () => {
    const src = stripped('src/renderer/hooks/useAiChat.ts')
    const start = src.indexOf('const viewOnlyEmit = useCallback(')
    expect(start).toBeGreaterThan(-1)
    const m = /\n {2}\}, \[[^\]]*\]\)/.exec(src.slice(start))
    expect(m).not.toBeNull()
    const block = src.slice(start, start + m!.index + m![0].length)
    // convDir が無いとき（会話の置き場が定まっていない異常系）だけ当てる、という条件付きの形
    // になっていること（B'-3e-b: 単独チャットも main が書き主になったため toolsProjectDir では
    // なく convDir で判定する）
    expect(block).toContain('if (!convDir) updateShown(prev => applyToMessages(prev, ev))')
  })
})

describe('3点セット: chat.onApplied（main / preload / global.d.ts）', () => {
  it('main（convStore.ts）に setApplyListener がある', () => {
    const src = stripped('src/main/chat/convStore.ts')
    expect(src).toContain('export function setApplyListener(')
  })

  it('preload.ts が chat:applied を購読解除関数つきで公開している（chat:appended は廃止）', () => {
    const src = stripped('src/main/preload.ts')
    expect(src).toContain("ipcRenderer.on('chat:applied', handler)")
    expect(src).toContain("return () => ipcRenderer.removeListener('chat:applied', handler)")
    expect(src).not.toContain('chat:appended')
  })

  it('global.d.ts に onApplied の型がある（onAppended は無い）', () => {
    const src = stripped('src/renderer/global.d.ts')
    expect(src).toContain('onApplied(cb: (p: {')
    expect(src).not.toContain('onAppended(')
  })
})
