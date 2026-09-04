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
    // B'-3e-b: 同じ import 文に sessionIdFromDir も相乗り（chat:applied の逆引きに使う）
    expect(src).toContain("import { sessionDir, sessionIdFromDir } from '../../shared/appChatDirs'")
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

  // #16・掟10: workspaceDir も同じ流儀で最後の砦（assertValidWorkspaceDir）を通す。
  // 振る舞い（実際に例外になること）は tests/appSessionsStore.test.ts が実駆動で確かめる。
  // ここは「5つの公開関数すべての入口にある」という配線だけを固定する。
  it('assertValidWorkspaceDir を import している（isValidWorkspaceDir から組み立て）', () => {
    expect(src).toContain("import { sessionDir, sessionsIndexPath, isValidSessionId, isValidWorkspaceDir } from '../shared/appChatDirs'")
    expect(src).toContain('function assertValidWorkspaceDir(dir: unknown): asserts dir is string {')
    expect(src).toContain('if (!isValidWorkspaceDir(dir)) throw new Error(')
  })

  it('assertValidWorkspaceDir(workspaceDir) の呼び出しが、listSessions/createSession/renameSession/setSessionModel/deleteSession/ensureSessionProject の6関数すべてにある（掟10: 呼び出し形ごと・当て先が定義自身に当たらないことも確認済み）', () => {
    // ensureSessionProject はもう1引数（projectWorkspaceDir）も同じ検証を通すが、
    // それは呼び出しの文字列が異なる（assertValidWorkspaceDir(projectWorkspaceDir)）ため、
    // ここでの単純な文字列カウントには乗らない。専用のテストを下に置く。
    const count = src.split('assertValidWorkspaceDir(workspaceDir)').length - 1
    expect(count).toBe(6)
  })

  it('ensureSessionProject が projectWorkspaceDir も assertValidWorkspaceDir で検証している', () => {
    expect(src).toContain('assertValidWorkspaceDir(projectWorkspaceDir)')
  })
})

// ── B'-3e-b: ChatApp（単独チャット）も main が書き主に（convDir・onMessageEvent・
// chat:applied 購読）。ChatPanel の B-1a パターンをセッション複数対応で踏襲する。
describe('src/renderer/components/ChatApp.tsx: 単独チャットも main が書き主（B\'-3e-b）', () => {
  const src = readCode('src/renderer/components/ChatApp.tsx')

  it('useAiChat へ convDir（chatWorkspace が読み込み済みならセッション擬似 dir・そうでなければ null）を渡している', () => {
    expect(src).toContain('convDir: chatWorkspace ? sessionDir(chatWorkspace, activeId) : null,')
  })

  it('renderer 発の message系は onMessageEvent（applyOp）で main へ ops を送るだけにする', () => {
    expect(src).toContain('onMessageEvent: (ev) => applyOp(ev),')
  })

  it('applyOp は convClient があればそれへ委ね、無ければ updateShown へフォールバックする（ChatPanel の applyOp/applyOpLocally と同じ形）', () => {
    const start = src.indexOf('const applyOp = useCallback((op: Op) => {')
    expect(start).toBeGreaterThan(-1)
    const end = src.indexOf('}, [activeId, getConvClient, updateShown])', start)
    expect(end).toBeGreaterThan(start)
    const block = src.slice(start, end)
    expect(block).toContain('const client = getConvClient(activeId)')
    expect(block).toContain('if (client) client.apply(op)')
    expect(block).toContain('else updateShown(')
  })

  it('updateShown は純粋（deriveOp も ops 送信も無い・画面反映だけ）', () => {
    const start = src.indexOf('const updateShown = useCallback((updater: (prev: Message[]) => Message[]) => {')
    expect(start).toBeGreaterThan(-1)
    const end = src.indexOf('}, [activeId])', start)
    expect(end).toBeGreaterThan(start)
    const block = src.slice(start, end)
    expect(block).not.toContain('deriveOp(')
    expect(block).not.toContain('.apply(')
  })

  it('deriveOp / updateActiveMessages はもう存在しない（役目を終えて削除済み）', () => {
    expect(src).not.toContain('function deriveOp')
    expect(src).not.toContain('updateActiveMessages')
  })

  it('chat.onApplied を購読し、sessionIdFromDir でセッションを逆算して当てる（アクティブでないセッションも含む）', () => {
    expect(src).toContain("import { sessionDir, sessionIdFromDir } from '../../shared/appChatDirs'")
    expect(src).toContain('window.electronAPI.chat.onApplied(({ projectDir: dir, op, length }) => {')
    expect(src).toContain('const sid = sessionIdFromDir(chatWorkspace, dir)')
    // 「s.id !== sid」で絞る＝activeId に限らずどのセッションにも当てられる形になっていること
    expect(src).toContain('if (s.id !== sid) return s')
  })

  it('viewSyncDecision で apply/reload を判定し、reload 側で loadConversationView から読み直す（ChatPanel と同じ B-1a パターン）', () => {
    expect(src).toContain("import { applyToMessages, viewSyncDecision } from '../../shared/chatEvents'")
    expect(src).toContain("const decision = viewSyncDecision(op as Op, s.messages.length, length)")
    expect(src).toContain("decision === 'reload'")
  })

  it('送信ガード: send() は chatWorkspace が null の間は送らない（convDir null のまま送っても保存されないため）', () => {
    const start = src.indexOf('const send = useCallback(() => {')
    expect(start).toBeGreaterThan(-1)
    const end = src.indexOf('}, [activeSession, input, pendingImages, isLoading, chatWorkspace, chat])', start)
    expect(end).toBeGreaterThan(start)
    const block = src.slice(start, end)
    expect(block).toContain('|| isLoading || !chatWorkspace) return')
  })

  it('送信ボタンの disabled にも chatWorkspace の有無が入っている', () => {
    expect(src).toContain('disabled={(!input.trim() && pendingImages.length === 0) || !chatWorkspace}')
  })
})

// ── 2026-09-04 Ryosuke 決定: チャット（ChatApp）内の「保存」を会話専用の新規プロジェクトへ
// 向ける（掟11: 環境の独立。applyAiFile の base = root ?? currentDir が、IDE で最後に開いていた
// 無関係なプロジェクトへ書き込んでいた不具合の修正）。
describe('appSessions:ensureProject の3点セット（main / preload.ts / global.d.ts）', () => {
  it('main（ipc/appSessions.ts）がハンドラを登録している', () => {
    const src = readCode('src/main/ipc/appSessions.ts')
    expect(src).toContain("ipcMain.handle('appSessions:ensureProject', (_, workspaceDir: string, id: string, projectWorkspaceDir: string, title: string) =>")
    expect(src).toContain('ensureSessionProject(workspaceDir, id, projectWorkspaceDir, title))')
  })

  it('preload.ts が appSessions:ensureProject を invoke している', () => {
    const src = readCode('src/main/preload.ts')
    expect(src).toContain('ensureProject: (workspaceDir: string, id: string, projectWorkspaceDir: string, title: string) =>')
    expect(src).toContain("ipcRenderer.invoke('appSessions:ensureProject', workspaceDir, id, projectWorkspaceDir, title)")
  })

  it('global.d.ts に ensureProject の型がある', () => {
    const src = readCode('src/renderer/global.d.ts')
    expect(src).toContain('ensureProject(workspaceDir: string, id: string, projectWorkspaceDir: string, title: string): Promise<{')
  })
})

describe('ChatApp.tsx: AiMessage への onApplyFile はラッパ（handleApplyFile）経由（掟11）', () => {
  const src = readCode('src/renderer/components/ChatApp.tsx')

  it('旧形（onApplyFile をそのまま渡す）はもう無い（mustNot）', () => {
    expect(src).not.toContain('onApplyFile={onApplyFile}')
  })

  it('AiMessage には handleApplyFile を渡している', () => {
    expect(src).toContain('<AiMessage content={msg.content} onApplyFile={handleApplyFile}')
  })

  it('handleApplyFile が appSessions.ensureProject を呼び、projectDir + \'/public\' を root として渡している', () => {
    expect(src).toContain('window.electronAPI.appSessions.ensureProject(chatWorkspace, activeId, ws, activeSession?.title ?? ')
    expect(src).toContain("r.projectDir + '/public'")
    expect(src).toContain('{ openProjectDir: r.projectDir }')
  })
})

describe('App.tsx: applyAiFile の opts.openProjectDir 経路（掟11・チャット専用プロジェクトへの切替）', () => {
  const src = readCode('src/renderer/App.tsx')

  it('未保存の編集があるプロジェクトは切り替えない（isDirty ガード）', () => {
    expect(src).toContain('if (openFiles.some(f => f.isDirty)) return')
  })

  it('pendingOpenAfterSwitchRef へ退避してから setCurrentDir し、切替 effect の最後で dir 一致のときだけ消費する', () => {
    expect(src).toContain('const pendingOpenAfterSwitchRef = useRef<{ dir: string; full: string } | null>(null)')
    expect(src).toContain('pendingOpenAfterSwitchRef.current = { dir: switchTarget, full }')
    expect(src).toContain('setCurrentDir(switchTarget)')
    expect(src).toContain('const pending = pendingOpenAfterSwitchRef.current')
    expect(src).toContain('if (pending && pending.dir === currentDir) {')
    expect(src).toContain('pendingOpenAfterSwitchRef.current = null')
  })
})
