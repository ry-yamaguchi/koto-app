import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// 🕘「元に戻す」の完了を会話へ記録する配線（0.3.50・roadmap「次の改善2件」その2）。
//
// ── なぜ readCode か ─────────────────────────────────────────────────
// src/main/ipc/backup.ts は electron（ipcMain）を import しているため、node の
// vitest からそのまま呼び出せない（tests/publishRootWiring.test.ts と同じ事情）。
// ソースを読んで、「呼び出しの形そのもの」を固定する（掟10: 「どこかに書いてある」
// だけでは直し忘れを捕まえられない。呼び出しごと見る・直す前の形は not.toContain で禁じる）。

const ROOT = path.join(__dirname, '..')
const raw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
// コメントでの言及（「ここで直接 append し」等）だけを拾って誤検知しないよう、コメント行を除く。
const stripped = (rel: string) => raw(rel).split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')

describe('配線: backup:restore ハンドラが会話へ記録している', () => {
  it('復元が ok のとき applyConversationOps と chat:appended send の両方を通る', () => {
    const src = stripped('src/main/ipc/backup.ts')
    expect(src).toContain("applyConversationOps(projectDir, [{ kind: 'append', msg }])")
    expect(src).toContain("event.sender.send('chat:appended', { projectDir, msg })")
  })

  it('両方とも if (result.ok) の中にある（失敗時は会話に書かない）', () => {
    const src = stripped('src/main/ipc/backup.ts')
    const at = src.indexOf('if (result.ok) {')
    expect(at).toBeGreaterThan(-1)
    const block = src.slice(at, src.indexOf('\n  })', at))
    expect(block).toContain('applyConversationOps(')
    expect(block).toContain("event.sender.send('chat:appended'")
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

describe('配線: ChatPanel が chat.onAppended を購読している', () => {
  it('onAppended を購読し、projectDir が一致するものだけを反映する', () => {
    const src = stripped('src/renderer/components/ChatPanel.tsx')
    expect(src).toContain('window.electronAPI.chat.onAppended(({ projectDir: dir, msg }) => {')
    expect(src).toContain('if (dir !== projectDir) return')
  })

  // ⚠️ ここで ops（applyOp / client.ops）を送ると、main が convStore.ts へ既に append 済みの
  // 1件がもう一度書かれ、会話に同じ「🕘 …」が2件残ってしまう（viewOnly でなければならない）。
  it('setMessages で直接映すだけで、ops を送らない（viewOnly）', () => {
    const src = raw('src/renderer/components/ChatPanel.tsx')
    const at = src.indexOf('window.electronAPI.chat.onAppended(')
    expect(at).toBeGreaterThan(-1)
    const end = src.indexOf('}, [projectDir])', at)
    expect(end).toBeGreaterThan(at)
    const block = src.slice(at, end)
    expect(block).toContain('setMessages(prev => [...prev, msg])')
    // 直す前の形（applyOp/client 経由で送ってしまう）へ戻さない
    expect(block).not.toContain('applyOp(')
    expect(block).not.toContain('clientRef.current')
  })
})

describe('3点セット: chat.onAppended（preload / global.d.ts）', () => {
  it('preload.ts が chat:appended を購読解除関数つきで公開している', () => {
    const src = stripped('src/main/preload.ts')
    expect(src).toContain("ipcRenderer.on('chat:appended', handler)")
    expect(src).toContain("return () => ipcRenderer.removeListener('chat:appended', handler)")
  })

  it('global.d.ts に onAppended の型がある', () => {
    const src = stripped('src/renderer/global.d.ts')
    expect(src).toContain('onAppended(cb: (p: { projectDir: string; msg:')
  })
})
