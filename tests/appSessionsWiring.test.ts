import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// B'-3e-a: 単独チャット（ChatApp）のセッションの器を main（appSessionsStore.ts・convStore.ts）へ
// 移した配線を固定する（tests/learningWiring.test.ts / tests/usageWiring.test.ts と同じ readCode 流儀）。
//
// ⚠️ コメントを外してから判定する（tests/untrustedBlockWiring.test.ts 冒頭の説明のとおり。
// このテストファイル自身の中では対象ソース側の `\n` 文字列リテラルとの一致判定は使っていないため、
// その罠には触れない）。各 must/mustNot は実装直後に `grep -n` 相当で対象ファイル内に実在する
// こと／存在しないことを確認済み（掟10: 当て先が他の行に出ないかの確認）。

const readCode = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*')
    })
    .join('\n')

describe('main/ipc/index.ts: registerAppSessionsHandlers が登録されている', () => {
  const src = readCode('src/main/ipc/index.ts')

  it('import と呼び出しの両方がある', () => {
    expect(src).toContain("import { registerAppSessionsHandlers } from './appSessions'")
    expect(src).toContain('registerAppSessionsHandlers(deps)')
  })
})

describe('main/ipc/appSessions.ts: before-quit フラッシュ・push配線がある', () => {
  const src = readCode('src/main/ipc/appSessions.ts')

  it("app.on('before-quit', () => flushAppSessions()) がある", () => {
    expect(src).toContain("app.on('before-quit', () => flushAppSessions())")
  })

  it('setAppSessionsListener で appSessions:changed を sendToWindow している', () => {
    expect(src).toContain('setAppSessionsListener((workspaceDir, sessions) => {')
    expect(src).toContain("sendToWindow(deps.getMainWindow(), 'appSessions:changed', { workspaceDir, sessions })")
  })

  it('5つの invoke ハンドラ（list/create/rename/setModel/delete）がある', () => {
    for (const ch of ['appSessions:list', 'appSessions:create', 'appSessions:rename', 'appSessions:setModel', 'appSessions:delete']) {
      expect(src).toContain(`ipcMain.handle('${ch}'`)
    }
  })
})

describe('preload.ts / global.d.ts: appSessions の3点セットがある', () => {
  const preload = readCode('src/main/preload.ts')
  const dts = readCode('src/renderer/global.d.ts')

  it('preload.ts が appSessions:* を invoke/on している', () => {
    expect(preload).toContain("list: (workspaceDir: string) => ipcRenderer.invoke('appSessions:list', workspaceDir)")
    expect(preload).toContain("ipcRenderer.invoke('appSessions:create', workspaceDir, meta)")
    expect(preload).toContain("ipcRenderer.invoke('appSessions:rename', workspaceDir, id, title)")
    expect(preload).toContain("ipcRenderer.invoke('appSessions:setModel', workspaceDir, id, model)")
    expect(preload).toContain("delete: (workspaceDir: string, id: string) => ipcRenderer.invoke('appSessions:delete', workspaceDir, id)")
    expect(preload).toContain("ipcRenderer.on('appSessions:changed', handler)")
  })

  it('global.d.ts に appSessions の型宣言（list/create/rename/setModel/delete/onChanged）がある', () => {
    expect(dts).toContain('appSessions: {')
    expect(dts).toContain('list(workspaceDir: string): Promise<{ id: string; title: string; model: string; createdAt: number }[]>')
    expect(dts).toContain('create(workspaceDir: string, meta: { id: string; title: string; model: string; createdAt: number }): Promise<void>')
    expect(dts).toContain('rename(workspaceDir: string, id: string, title: string): Promise<void>')
    expect(dts).toContain('setModel(workspaceDir: string, id: string, model: string): Promise<void>')
    expect(dts).toContain('delete(workspaceDir: string, id: string): Promise<void>')
  })
})

describe('ChatApp.tsx: 旧 chatStorage の読み書きが消え、appSessions + chatConvClient に置き換わっている', () => {
  const src = readCode('src/renderer/components/ChatApp.tsx')

  it("旧 renderer/chatStorage.ts の loadAppSessions/saveAppSessions を import していない（mustNot）", () => {
    expect(src).not.toContain("from '../chatStorage'")
    expect(src).not.toContain('loadAppSessions(')
    expect(src).not.toContain('saveAppSessions(')
  })

  it('chatConvClient.ts（loadConversationView / makeConvClient）を使っている', () => {
    expect(src).toContain("import { loadConversationView, makeConvClient, type Op } from '../chatConvClient'")
    expect(src).toContain('loadConversationView(sessionDir(chatWorkspace, activeId))')
    expect(src).toContain('makeConvClient(sessionDir(chatWorkspace, id))')
  })

  it('appChatDirs.ts の sessionDir を使っている（複製の擬似dir組み立てをしていない）', () => {
    expect(src).toContain("import { sessionDir } from '../../shared/appChatDirs'")
  })

  it('appSessions IPC（list/create/rename/setModel/delete）をすべて呼んでいる', () => {
    expect(src).toContain('window.electronAPI.appSessions.list(workspaceDir)')
    expect(src).toContain('window.electronAPI.appSessions.create(workspaceDir, {')
    expect(src).toContain('window.electronAPI.appSessions.create(chatWorkspace, {')
    expect(src).toContain('window.electronAPI.appSessions.rename(chatWorkspace, id, patch.title)')
    expect(src).toContain('window.electronAPI.appSessions.setModel(chatWorkspace, id, patch.model)')
    expect(src).toContain('window.electronAPI.appSessions.delete(chatWorkspace, id)')
  })

  it('旧 chat.loadApp / chat.saveApp をもう呼んでいない（mustNot）', () => {
    expect(src).not.toContain('chat.loadApp(')
    expect(src).not.toContain('chat.saveApp(')
  })

  // 掟7: ターンの配線（toolsProjectDir・buildExecuteOpts）はこの段では一切変えない。
  it('toolsProjectDir: null・buildExecuteOpts: () => ({}) が変わっていない', () => {
    expect(src).toContain('toolsProjectDir: null,')
    expect(src).toContain('buildExecuteOpts: () => ({}),')
  })
})

describe('src/renderer/chatStorage.ts は削除済み', () => {
  it('ファイルが存在しない（本体ごと削除。呼び出しがゼロになったため）', () => {
    const p = path.join(__dirname, '..', 'src/renderer/chatStorage.ts')
    expect(fs.existsSync(p)).toBe(false)
  })
})

describe('src/main/appSessionsStore.ts: convStore.dropConversation を delete で使っている', () => {
  const src = readCode('src/main/appSessionsStore.ts')

  it('import と、削除時の呼び出しがある', () => {
    expect(src).toContain("import { applyConversationOps, flushConversations, dropConversation } from './chat/convStore'")
    expect(src).toContain('dropConversation(dir)')
  })

  it('isValidSessionId を create/rename/setModel/delete すべてで検証している（掟10）', () => {
    expect(src).toContain('if (!isValidSessionId(meta?.id)) return')
    expect(src).toContain("if (!isValidSessionId(id) || typeof title !== 'string') return")
    expect(src).toContain("if (!isValidSessionId(id) || typeof model !== 'string') return")
    expect(src).toContain('if (!isValidSessionId(id)) return')
  })
})
