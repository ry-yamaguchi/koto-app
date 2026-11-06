import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  chatUnreadableText, unreadableFrom, copiesFrom, IDE_CHAT_BACKUP_PLACE,
  sessionsIndexUnreadableText, sessionBackupPlace, sessionsIndexBackupPlace,
} from '../src/shared/chatUnreadable'
import ChatLoadNotice, { ChatAppLoadNotices } from '../src/renderer/components/ChatLoadNotice'

// ── 会話の記録を読めなかったことの知らせ（0.6.26）─────────────────────────────────────
// 文は2つ。写しがある回は、読めなかった事実と、写しの場所・名前を言う。写しを作れなかった回は、
// 写しが無いこと（書き込まないこと）を言い、場所や名前を言わない。文字列の期待値はリテラルで書く
// （定数を変えても気づけなくなるため）。

const COPY = 'chat.json.broken-20261103-142530'
const WITH_COPY =
  '前の会話の記録を読めませんでした。元の記録は プロジェクトの .sakuraide フォルダ に chat.json.broken-20261103-142530 として残してあります。'
const NO_COPY = '前の会話の記録を読めませんでした。この会話には書き込みません。'

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el)
const text = (h: string) => h.replace(/<[^>]*>/g, '')

describe('chatUnreadableText: 知らせの文', () => {
  it('写しがある回: 場所とファイル名を言う', () => {
    expect(chatUnreadableText({ backupName: COPY }, IDE_CHAT_BACKUP_PLACE)).toBe(WITH_COPY)
  })

  it('写しを作れなかった回: 書き込まないことを言い、場所も名前も言わない', () => {
    const t = chatUnreadableText({ backupName: null }, IDE_CHAT_BACKUP_PLACE)
    expect(t).toBe(NO_COPY)
    expect(t).not.toContain('.sakuraide')
    expect(t).not.toContain('残してあります')
  })

  it('場所の言い方は呼び手が決める（チャットモードは会話の保存フォルダを渡す）', () => {
    expect(chatUnreadableText({ backupName: COPY }, 'この会話の保存フォルダ'))
      .toBe('前の会話の記録を読めませんでした。元の記録は この会話の保存フォルダ に chat.json.broken-20261103-142530 として残してあります。')
  })

  it('IDE の場所の言い方は、プロジェクトの .sakuraide フォルダ', () => {
    expect(IDE_CHAT_BACKUP_PLACE).toBe('プロジェクトの .sakuraide フォルダ')
  })

  it('画面に出さない語（内部の名前・丸数字）を含まない', () => {
    for (const t of [WITH_COPY, NO_COPY, chatUnreadableText({ backupName: COPY }, IDE_CHAT_BACKUP_PLACE), chatUnreadableText({ backupName: null }, IDE_CHAT_BACKUP_PLACE)]) {
      expect(t).not.toMatch(/IPC|unreadable|backupName/)
      expect(t).not.toMatch(/[①-⑳]/) // 丸数字
    }
  })
})

describe('unreadableFrom: IPC の返事の読み取り（形の分からない値を「読めた」に戻さない）', () => {
  it.each<[string, unknown, { backupName: string | null } | null]>([
    ['null', null, null],
    ['undefined', undefined, null],
    ['写しの名前あり', { backupName: COPY }, { backupName: COPY }],
    ['写しの名前が null', { backupName: null }, { backupName: null }],
    ['空のオブジェクト', {}, { backupName: null }],
    ['写しの名前が数値', { backupName: 5 }, { backupName: null }],
    ['写しの名前が空文字', { backupName: '' }, { backupName: null }],
    ['オブジェクトでない真偽値', true, { backupName: null }],
    ['オブジェクトでない文字列', 'broken', { backupName: null }],
    ['オブジェクトでない数値', 1, { backupName: null }],
  ])('%s', (_label, raw, expected) => {
    expect(unreadableFrom(raw)).toEqual(expected)
  })
})

describe('copiesFrom: IPC の返事から、残っている写しの名前を取り出す', () => {
  it.each<[string, unknown, string[]]>([
    ['名前の配列', [COPY, 'chat.json.broken-20261104-090000'], [COPY, 'chat.json.broken-20261104-090000']],
    ['空の配列', [], []],
    ['undefined', undefined, []],
    ['null', null, []],
    ['配列でない文字列', COPY, []],
    ['配列でないオブジェクト', { 0: COPY }, []],
    ['数値', 3, []],
    ['文字列でない要素と空の名前は捨てる', [COPY, 5, null, '', undefined, {}], [COPY]],
  ])('%s', (_label, raw, expected) => {
    expect(copiesFrom(raw)).toEqual(expected)
  })
})

describe('ChatLoadNotice: 描いた結果', () => {
  it('読めた（null）なら何も描かない', () => {
    expect(html(createElement(ChatLoadNotice, { unreadable: null, place: IDE_CHAT_BACKUP_PLACE }))).toBe('')
  })

  it('写しがある回: 1つ目の文を、選択できる帯に描く', () => {
    const h = html(createElement(ChatLoadNotice, { unreadable: { backupName: COPY }, place: IDE_CHAT_BACKUP_PLACE }))
    expect(text(h)).toBe(WITH_COPY)
    expect(h).toContain('select-text')
    expect(h).toContain('role="status"')
  })

  it('写しを作れなかった回: 2つ目の文だけを描く', () => {
    const h = html(createElement(ChatLoadNotice, { unreadable: { backupName: null }, place: IDE_CHAT_BACKUP_PLACE }))
    expect(text(h)).toBe(NO_COPY)
  })
})

// ── チャットモード（ChatApp）の知らせ: 会話の記録（上と同じ文）と、会話の一覧（索引）の文 ─────────────────
const INDEX_COPY = 'sessions.json.broken-20261103-142530'
const INDEX_WITH_COPY =
  '会話の一覧を読めませんでした。元の一覧は /work/.sakuraide-app-chat に sessions.json.broken-20261103-142530 として残してあります。読めるようになるまで一覧には書き込まないので、この間に作った会話は一覧に残りません。'
const INDEX_NO_COPY = '会話の一覧を読めませんでした。一覧には書き込まないので、この間に作った会話は一覧に残りません。'

describe('チャットモードの知らせの文と場所', () => {
  it('会話の一覧を読めなかった回（写しあり）: 場所とファイル名を言い、書き込まないことと、この間の会話が残らないことを言う', () => {
    expect(sessionsIndexUnreadableText({ backupName: INDEX_COPY }, '/work/.sakuraide-app-chat')).toBe(INDEX_WITH_COPY)
  })

  it('会話の一覧を読めなかった回（写しを作れなかった）: 場所も名前も言わない', () => {
    const t = sessionsIndexUnreadableText({ backupName: null }, '/work/.sakuraide-app-chat')
    expect(t).toBe(INDEX_NO_COPY)
    expect(t).not.toContain('/work')
    expect(t).not.toContain('残してあります')
  })

  it('画面に出さない語（内部の名前・丸数字）を含まない', () => {
    for (const t of [INDEX_WITH_COPY, INDEX_NO_COPY]) {
      expect(t).not.toMatch(/IPC|unreadable|backupName|sessions\.json\b(?!\.broken)/)
      expect(t).not.toMatch(/[①-⑳]/)
    }
  })

  it('会話の記録の写しの場所は、その会話の保存フォルダ（.sakuraide）。一覧の写しの場所は、チャットモードの置き場', () => {
    expect(sessionBackupPlace('/work', 's1')).toBe('/work/.sakuraide-app-chat/sessions/s1/.sakuraide')
    expect(sessionsIndexBackupPlace('/work')).toBe('/work/.sakuraide-app-chat')
  })

  it('チャットモードの会話の記録の知らせは、IDE と同じ文に場所だけ差し替える', () => {
    expect(chatUnreadableText({ backupName: COPY }, sessionBackupPlace('/work', 's1')))
      .toBe('前の会話の記録を読めませんでした。元の記録は /work/.sakuraide-app-chat/sessions/s1/.sakuraide に chat.json.broken-20261103-142530 として残してあります。')
  })
})

describe('ChatLoadNotice: 一覧（subject="index"）の描いた結果', () => {
  it('読めた（null）なら何も描かない', () => {
    expect(html(createElement(ChatLoadNotice, { subject: 'index', unreadable: null, place: '/work/.sakuraide-app-chat' }))).toBe('')
  })

  it('写しがある回: 一覧の文を選択できる帯に描く（会話の記録の文は描かない）', () => {
    const h = html(createElement(ChatLoadNotice, { subject: 'index', unreadable: { backupName: INDEX_COPY }, place: '/work/.sakuraide-app-chat' }))
    expect(text(h)).toBe(INDEX_WITH_COPY)
    expect(h).toContain('select-text')
    expect(h).toContain('role="status"')
  })

  it('写しを作れなかった回: 一覧の2つ目の文だけを描く', () => {
    const h = html(createElement(ChatLoadNotice, { subject: 'index', unreadable: { backupName: null }, place: '/work/.sakuraide-app-chat' }))
    expect(text(h)).toBe(INDEX_NO_COPY)
  })

  it('subject を省くと、会話の記録の文（今までの描き方）', () => {
    const h = html(createElement(ChatLoadNotice, { unreadable: { backupName: COPY }, place: IDE_CHAT_BACKUP_PLACE }))
    expect(text(h)).toBe(WITH_COPY)
  })
})

// ── 3点セットと ChatPanel の配線（文字列一致の補助。当て先が他の行に出ないよう、前後ごと書く）──────────
// 本物の chat:load の返り値は tests/chatLoadHandler.test.ts、読み込みの振る舞いは tests/chatConvClientLoad.test.ts。
const ROOT = join(__dirname, '..')
const readCode = (rel: string): string =>
  readFileSync(join(ROOT, rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*')
    })
    .join('\n')
const countOf = (src: string, s: string): number => src.split(s).length - 1

describe('chat:load の3点セット（main の返り値・preload・global.d.ts）', () => {
  it('main: chat:load は読み込みの状態（messages と unreadable）をそのまま返す。messages だけ返す古い形に戻っていない', () => {
    const main = readCode('src/main/ipc/chatStore.ts')
    expect(main).toContain('const { messages, unreadable, copies } = loadConversationState(projectDir)')
    expect(main).toContain('return { ok: true, messages, unreadable, ...(copies ? { copies } : {}) }')
    expect(main).not.toContain('return { ok: true, messages: loadConversation(projectDir) }')
    expect(main).not.toContain('return { ok: true, messages, unreadable }')
  })

  it('preload: load は返事をそのまま渡す（フィールドを選び直さない）', () => {
    const pre = readCode('src/main/preload.ts')
    expect(countOf(pre, "load: (projectDir: string) => ipcRenderer.invoke('chat:load', projectDir),")).toBe(1)
    expect(pre).not.toContain("ipcRenderer.invoke('chat:load', projectDir).then")
  })

  it('global.d.ts: load の成功の返事の型に unreadable がある', () => {
    const d = readCode('src/renderer/global.d.ts')
    const start = d.indexOf('load(projectDir: string): Promise<')
    const end = d.indexOf('ops(projectDir: string, ops: unknown[]', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const block = d.slice(start, end)
    expect(block).toContain("| { ok: true; messages: import('../shared/chatTurn').TurnMessage[] | null; unreadable: import('../shared/chatUnreadable').UnreadableChat | null; copies?: string[] }")
    expect(block).not.toContain("| { ok: true; messages: import('../shared/chatTurn').TurnMessage[] | null }")
  })
})

describe('ChatPanel: 読めなかった知らせを読み込みの結果から受け、会話の領域の先頭に出す', () => {
  const src = readCode('src/renderer/components/ChatPanel.tsx')
  const callAt = src.indexOf('loadConversationChecked(projectDir).then(')
  const effectStart = src.lastIndexOf('useEffect(', callAt)
  const effectEnd = src.indexOf('}, [projectDir, applyOpLocally])', callAt)
  const effect = src.slice(effectStart, effectEnd)
  const at = (needle: string): number => effect.indexOf(needle)

  it('読み込みの effect の範囲を取れている。知らせの state を書くのはこの effect の中の2か所だけ', () => {
    expect(callAt).toBeGreaterThan(-1)
    expect(effectEnd).toBeGreaterThan(callAt)
    expect(countOf(src, 'setLoadUnreadable(')).toBe(2)
    expect(countOf(effect, 'setLoadUnreadable(')).toBe(2)
    expect(src).toContain('const [loadUnreadable, setLoadUnreadable] = useState<UnreadableChat | null>(null)')
  })

  it('切り替えで知らせを消す: 読み込みより前（前のプロジェクトの知らせが残らない）', () => {
    expect(at('setLoadUnreadable(null)')).toBeGreaterThan(-1)
    expect(at('setLoadUnreadable(null)')).toBeLessThan(at('if (!projectDir) { setMessages([]); return }'))
    expect(at('setLoadUnreadable(null)')).toBeLessThan(at('loadConversationChecked(projectDir)'))
  })

  it('知らせを立てるのは、読み込みが返り（キャンセルでなく）、会話を映したあと。読み込みの結果をそのまま渡す', () => {
    const cancelled = at('if (cancelled) return')
    const show = at('setMessages(msgs)')
    const mark = at('setLoadUnreadable(unreadable)')
    expect(cancelled).toBeGreaterThan(-1)
    expect(show).toBeGreaterThan(cancelled)
    expect(mark).toBeGreaterThan(show)
  })

  it('知らせの部品は会話の領域に1つだけ。state と IDE の場所を渡す', () => {
    expect(countOf(src, '<ChatLoadNotice unreadable={loadUnreadable} place={IDE_CHAT_BACKUP_PLACE} />')).toBe(1)
    expect(countOf(src, '<ChatLoadNotice')).toBe(1)
  })

  it('知らせは会話の領域の先頭（空の会話の案内より前）に置く', () => {
    const notice = src.indexOf('<ChatLoadNotice unreadable={loadUnreadable} place={IDE_CHAT_BACKUP_PLACE} />')
    const empty = src.indexOf('{messages.filter(m => !m.hidden).length === 0 && !isLoading && (')
    expect(notice).toBeGreaterThan(-1)
    expect(empty).toBeGreaterThan(notice)
  })
})

// ── ChatApp（チャットモード）の配線 ─────────────────────────────────────────────────────────────
// 読み口 3つ（表示中の会話の読み込み・会話の切り替え・削除の前の読み）がすべて loadConversationChecked を通り、
// 読めなかった記録の知らせを覚えて、削除の判断と画面の知らせに使う。振る舞いは tests/chatDeleteGuard.test.ts。
describe('ChatApp: 読み口 3つ・削除の判断・知らせの配線', () => {
  const src = readCode('src/renderer/components/ChatApp.tsx')

  it('読み口は loadConversationChecked だけ。読めたかを捨てる loadConversationView は 1 か所も使っていない', () => {
    expect(src).not.toContain('loadConversationView')
    expect(countOf(src, 'loadConversationChecked(')).toBe(3)
  })

  it('読み口1（会話の切り替え）: 読んだ結果の読めたか・知らせを、その会話の印として覚える（キャンセルされていないときだけ）', () => {
    const at = src.indexOf('loadConversationChecked(sessionDir(chatWorkspace, activeId)).then(')
    const end = src.indexOf('return () => { cancelled = true }', at)
    expect(at).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(at)
    const block = src.slice(at, end)
    expect(block).toContain('({ messages: msgs, ...mark }) => {')
    expect(block.indexOf('if (cancelled) return')).toBeGreaterThan(-1)
    expect(block.indexOf('if (cancelled) return')).toBeLessThan(block.indexOf('setLoadMarks('))
    expect(block).toContain('setLoadMarks(prev => ({ ...prev, [activeId]: mark }))')
    // 直す前の形（読めたか・知らせだけを選んで覚える。写しの有無が落ちる）
    expect(block).not.toContain('{ readable, unreadable } }))')
  })

  it('読み口2（押し出しを取りこぼしたときの読み直し）: 同じく、その会話の印を覚え直す', () => {
    const at = src.indexOf('loadConversationChecked(dir).then(')
    const end = src.indexOf('return () => { cancelled = true; off() }', at)
    expect(at).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(at)
    const block = src.slice(at, end)
    expect(block).toContain('({ messages: msgs, ...mark }) => {')
    expect(block).toContain('if (cancelled) return')
    expect(block).toContain('setLoadMarks(prev => ({ ...prev, [sid]: mark }))')
    expect(block).not.toContain('{ readable, unreadable } }))')
  })

  it('削除（表示中と表示していない会話の両方）は runDeleteSession を通る。画面の数と覚えた印を渡し、読みに行く口も loadConversationChecked', () => {
    const at = src.indexOf('const deleteSession = async (id: string) => {')
    const end = src.indexOf('\n  }\n', at)
    expect(at).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(at)
    const block = src.slice(at, end)
    expect(block).toContain('await runDeleteSession(')
    expect(block).toContain('shownLength: id === activeId ? target.messages.length : null,')
    expect(block).toContain('known: id === activeId ? (loadMarks[id] ?? null) : null,')
    expect(block).toContain('read: () => chatWorkspace ? loadConversationChecked(sessionDir(chatWorkspace, id)) : Promise.resolve(NOTHING_ON_DISK),')
    expect(block).toContain("confirm: (body) => confirm({ title: '会話を削除します', body, confirmLabel: '削除する', danger: true }),")
    // 直す前の形（空なら確認なしで消す・画面の数だけで決める）が残っていない
    expect(block).not.toContain('hasMessages')
    expect(block).not.toContain('target.messages.length > 0')
    expect(block).not.toContain('{ remove(); return }')
    // 消したら、その会話の印も捨てる
    expect(block).toContain('const { [id]: _gone, ...rest } = prev')
  })

  it('起動時の一覧: 返事の sessions と unreadable を受け、unreadable を知らせの state へ立てる（キャンセルでなければ）', () => {
    const at = src.indexOf('const { sessions: list, unreadable } = await window.electronAPI.appSessions.list(workspaceDir)')
    expect(at).toBeGreaterThan(-1)
    const after = src.slice(at, src.indexOf('setChatWorkspace(workspaceDir)', at))
    expect(after.indexOf('if (cancelled) return')).toBeGreaterThan(-1)
    expect(after.indexOf('if (cancelled) return')).toBeLessThan(after.indexOf('setIndexUnreadable(unreadableFrom(unreadable))'))
    expect(countOf(src, 'setIndexUnreadable(')).toBe(1)
  })

  it('知らせは、会話の領域の前（モデルの見出しのあと）に、部品 ChatAppLoadNotices を 1 つだけ置く。出す条件は部品の中（下の描いた結果）', () => {
    const header = src.indexOf('<ModelSelect')
    const call = '<ChatAppLoadNotices workspaceDir={chatWorkspace} sessionId={activeId} indexUnreadable={indexUnreadable} activeUnreadable={activeUnreadable} />'
    const note = src.indexOf(call)
    const messages = src.indexOf('className={`flex-1 overflow-y-auto relative ${drag.over')
    expect(header).toBeGreaterThan(-1)
    expect(note).toBeGreaterThan(header)
    expect(messages).toBeGreaterThan(note)
    expect(countOf(src, '<ChatAppLoadNotices')).toBe(1)
    expect(src).toContain('const activeUnreadable = loadMarks[activeId]?.unreadable ?? null')
    // 直す前の形（条件と帯を ChatApp が持つ。条件が描かれず、どのテストにも固定されなかった）
    expect(src).not.toContain('{chatWorkspace && (indexUnreadable || activeUnreadable) && (')
    expect(src).not.toContain('<ChatLoadNotice')
  })
})

// ── チャットモードの知らせの帯を出す条件（描いた結果）─────────────────────────────────────────────────
// 一覧の分と表示中の会話の分は、どちらか一方だけ読めなかった回もある。条件を片方に狭めると、もう片方の知らせが
// 一度も出なくなる（一覧は読めるが、会話の記録が壊れている回が主な場面）。
describe('ChatAppLoadNotices: どちらの知らせが出るか', () => {
  const WS = '/work'
  const render = (p: { workspaceDir?: string | null; indexUnreadable?: { backupName: string | null } | null; activeUnreadable?: { backupName: string | null } | null }) =>
    html(createElement(ChatAppLoadNotices, {
      workspaceDir: p.workspaceDir === undefined ? WS : p.workspaceDir,
      sessionId: 's1',
      indexUnreadable: p.indexUnreadable ?? null,
      activeUnreadable: p.activeUnreadable ?? null,
    }))
  const CONV_WITH_COPY = '前の会話の記録を読めませんでした。元の記録は /work/.sakuraide-app-chat/sessions/s1/.sakuraide に chat.json.broken-20261103-142530 として残してあります。'

  it('どちらも読めた（null）なら、帯も余白も描かない', () => {
    expect(render({})).toBe('')
  })

  it('保存先がまだ定まっていない間（null）は、読めなかった印があっても描かない', () => {
    expect(render({ workspaceDir: null, indexUnreadable: { backupName: INDEX_COPY }, activeUnreadable: { backupName: COPY } })).toBe('')
  })

  it('会話の記録だけ読めなかった回（一覧は読めた）: 会話の記録の知らせだけを描く', () => {
    const h = render({ activeUnreadable: { backupName: COPY } })
    expect(text(h)).toBe(CONV_WITH_COPY)
    expect(countOf(h, 'role="status"')).toBe(1)
  })

  it('一覧だけ読めなかった回（会話の記録は読めた）: 一覧の知らせだけを描く', () => {
    const h = render({ indexUnreadable: { backupName: INDEX_COPY } })
    expect(text(h)).toBe(INDEX_WITH_COPY)
    expect(countOf(h, 'role="status"')).toBe(1)
  })

  it('両方読めなかった回: 一覧の知らせ、会話の記録の知らせの順に、1つの帯の中へ描く', () => {
    const h = render({ indexUnreadable: { backupName: INDEX_COPY }, activeUnreadable: { backupName: COPY } })
    expect(text(h)).toBe(INDEX_WITH_COPY + CONV_WITH_COPY)
    expect(countOf(h, 'role="status"')).toBe(2)
    expect(countOf(h, 'flex-none space-y-2 px-4 pt-3')).toBe(1)
  })

  it('写しを作れなかった回も、それぞれの2つ目の文を描く', () => {
    const h = render({ indexUnreadable: { backupName: null }, activeUnreadable: { backupName: null } })
    expect(text(h)).toBe(INDEX_NO_COPY + NO_COPY)
  })
})
