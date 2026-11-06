import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { splitFailureDetail } from '../src/shared/failureDetail'

// 手元のファイル・履歴・資料（📚）・更新の記録の失敗が、日本語の文＋「詳細: 原文」で出ること。
// 見るのは返り値（message / error / 画面に渡す文）で、ソースの書き方ではない。
// 資料（rag）は、回線断・時間切れ・手元のファイルの失敗のどれでも、日本語の文になり、ホスト名などの原文が詳細に残る。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  renameImpl: null as null | ((from: unknown, to: unknown) => void),
  logsDir: '',
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: (name: string) => (name === 'logs' ? h.logsDir : os.tmpdir()), on: () => {} },
  shell: { showItemInFolder: () => {}, trashItem: async () => {} },
  dialog: {},
}))
// renameSync だけ差し替えられる fs（既定は本物）
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  const wrapped = {
    ...actual,
    renameSync: (from: fs.PathLike, to: fs.PathLike) => (h.renameImpl ? h.renameImpl(from, to) : actual.renameSync(from, to)),
  }
  return { ...wrapped, default: wrapped }
})
vi.mock('../src/main/usageStore', () => ({ budgetCheckForKey: () => undefined }))

import { registerRagHandlers } from '../src/main/ipc/rag'
import { registerFsHandlers, publishedRecordsFs } from '../src/main/ipc/fs'
import { snapshotBeforeWrite, restoreToSnapshot, listSnapshotSummaries } from '../src/main/backup/store'
import { moveFilesToFs } from '../src/main/ipc/unused'
import { restoreFailedNotice, restorePartialLine } from '../src/renderer/historyNotice'
import { knowledgeFailureNotice, sourcePageFailureText } from '../src/renderer/components/knowledgeNotice'
import { migrateFailed } from '../src/shared/migratePlan'
import { deleteFileEntry, submitFileNameDialog } from '../src/renderer/fileEntryOps'
import type { NameDialogDeps } from '../src/renderer/fileEntryOps'

const HOST = 'api.ai.sakura.ad.jp'
/** 回線が切れたときの fetch の失敗（Node の形）。 */
const offlineError = () => Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${HOST}`), { code: 'ENOTFOUND' }),
})
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

let tmp = ''
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-localfail-'))
  h.renameImpl = null
  h.handlers.clear()
})
afterEach(() => {
  vi.unstubAllGlobals()
  h.renameImpl = null
  // 読み取り専用にした場所も消せるように戻す
  const walk = (p: string) => {
    try { fs.chmodSync(p, 0o755) } catch { /* ignore */ }
    try { for (const n of fs.readdirSync(p)) walk(path.join(p, n)) } catch { /* ignore */ }
  }
  walk(tmp)
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('📚 資料（rag）の IPC: 失敗は日本語の文＋詳細', () => {
  const call = async (channel: string, ...args: unknown[]): Promise<{ ok: boolean; error?: string }> => {
    registerRagHandlers({} as never)
    return h.handlers.get(channel)!({}, 'dummy-key', ...args)
  }

  it('★ 回線断: 一覧・取得・質問・チャンク（読み取り）は「接続できませんでした」の文で、詳細にホスト名が残る', async () => {
    vi.stubGlobal('fetch', async () => { throw offlineError() })
    const cases: Array<[string, unknown[]]> = [
      ['rag:list', []], ['rag:get', ['id1']], ['rag:chunks', ['id1']],
      ['rag:query', [{ query: 'q' }]], ['rag:chat', [{ query: 'q', chatModel: 'm' }]],
    ]
    for (const [ch, args] of cases) {
      const r = await call(ch, ...args)
      expect(r.ok, ch).toBe(false)
      const { text, detail } = splitFailureDetail(r.error ?? '')
      expect(text, ch).toContain('インターネットに接続できませんでした')
      expect(detail, ch).toContain(HOST)
      expect(r.error, ch).not.toMatch(/^[\x00-\x7F]*$/) // 英語だけの原文ではない
    }
  })

  it('★ 回線断: 追加・更新・削除（書き込み）も日本語の文で、詳細にホスト名が残る（要求が出ていないので「もう一度」と言える）', async () => {
    vi.stubGlobal('fetch', async () => { throw offlineError() })
    for (const [ch, args] of [
      ['rag:upload', [{ content: 'x', filename: 'a.md' }]], ['rag:update', ['id1', { name: 'n' }]], ['rag:delete', ['id1']],
    ] as Array<[string, unknown[]]>) {
      const r = await call(ch, ...args)
      expect(r.ok, ch).toBe(false)
      const { text, detail } = splitFailureDetail(r.error ?? '')
      expect(text, ch).toMatch(/接続|済んだか/)
      expect(detail, ch).toContain(HOST)
    }
  })

  it('★ 時間切れ: 読み取りは「時間内に返事がありません」、書き込みは「済んだかは確かめられていません」。どちらも詳細つき（固定の1文だけにしない）', async () => {
    vi.stubGlobal('fetch', async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) })
    const read = await call('rag:list')
    expect(splitFailureDetail(read.error ?? '').text).toContain('時間内に返事がありませんでした')
    expect(splitFailureDetail(read.error ?? '').detail).not.toBe('')
    const write = await call('rag:update', 'id1', { name: 'n' })
    expect(splitFailureDetail(write.error ?? '').text).toContain('済んだかは確かめられていません')
    expect(splitFailureDetail(write.error ?? '').text).toContain('📚 資料の一覧')
    expect(splitFailureDetail(write.error ?? '').detail).not.toBe('')
  })

  it('★ アップロードの時間切れは、ファイルの大きさの手がかりを言う文のまま、原文を詳細に添える', async () => {
    vi.stubGlobal('fetch', async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) })
    const up = await call('rag:upload', { content: 'x', filename: 'a.md' })
    const { text, detail } = splitFailureDetail(up.error ?? '')
    expect(text).toBe('アップロードがタイムアウトしました。ファイルサイズを確認し、しばらくしてから再度お試しください。')
    expect(detail).toContain('timeout')
  })

  it('証明書の失敗は「安全な接続」の文。見分けられない失敗は、何の通信かの前置きに原文を続ける（原文が消えない）', async () => {
    vi.stubGlobal('fetch', async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }) }) })
    expect(splitFailureDetail((await call('rag:list')).error ?? '').text).toContain('安全な接続を確認できませんでした')
    vi.stubGlobal('fetch', async () => { throw new Error('something strange happened') })
    const unknown = (await call('rag:list')).error ?? ''
    expect(unknown).toContain('さくらのAI Engine への通信に失敗しました')
    expect(unknown).toContain('something strange happened')
  })

  it('★ 選んだファイルを読めない（手元の失敗）: 英語の EACCES/ENOENT のままにせず、日本語の文＋詳細', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('ここへは来ない') })
    const r = await call('rag:upload', { filePath: path.join(tmp, 'no-such-file.md'), filename: 'no-such-file.md' })
    const { text, detail } = splitFailureDetail(r.error ?? '')
    expect(text).toContain('見つかりませんでした')
    expect(detail).toContain('ENOENT')
  })

  it('状態番号つきの固定文（認証・HTTP）はそのまま', async () => {
    vi.stubGlobal('fetch', async () => new Response('denied', { status: 401 }))
    expect((await call('rag:list')).error).toContain('認証に失敗しました')
    vi.stubGlobal('fetch', async () => new Response('boom', { status: 500 }))
    expect((await call('rag:list')).error).toContain('HTTP 500')
  })
})

describe('資料の窓の文の組み立て', () => {
  it('knowledgeFailureNotice: 前置きの後ろに文を続け、詳細は最後の行に残す（途中に挟まない）', () => {
    const shown = knowledgeFailureNotice('追加', 'インターネットに接続できませんでした。もう一度お試しください。\n詳細: fetch failed / getaddrinfo ENOTFOUND h')
    expect(shown).toBe('追加に失敗しました: インターネットに接続できませんでした。もう一度お試しください。\n詳細: fetch failed / getaddrinfo ENOTFOUND h')
    expect(splitFailureDetail(shown).text.split('\n')).toHaveLength(1)
    expect(knowledgeFailureNotice('削除', '  ')).toBe('削除に失敗しました')
  })

  it('sourcePageFailureText: 回線断は理由の文＋詳細。見分けられない失敗は固定文に原文を添える', () => {
    const net = sourcePageFailureText(offlineError())
    expect(splitFailureDetail(net).text).toContain('インターネットに接続できませんでした')
    expect(splitFailureDetail(net).detail).toContain(HOST)
    const other = sourcePageFailureText(new Error('Page said no'))
    expect(splitFailureDetail(other)).toEqual({ text: '元のページを取得できませんでした', detail: 'Page said no' })
  })
})

describe('🕘 履歴: 失敗は日本語の文＋詳細', () => {
  const idAt = (sec: number) => new Date(Date.UTC(2026, 7, 5, 12, 0, sec)).toISOString().replace(/[:.]/g, '-')

  it.skipIf(isRoot)('★ 復元を始められない（履歴の置き場に書けない）: 日本語の文＋詳細。英語の errno だけにしない', () => {
    const file = path.join(tmp, 'a.txt')
    fs.writeFileSync(file, 'old')
    snapshotBeforeWrite(tmp, idAt(1), 'a.txt', 'new', 'テスト')
    fs.writeFileSync(file, 'new')
    // 履歴の置き場を読み取り専用にして、復元前の退避を作れなくする
    const root = path.join(tmp, '.sakuraide-backup')
    fs.chmodSync(root, 0o555)
    const r = restoreToSnapshot(tmp, idAt(1))
    fs.chmodSync(root, 0o755)
    expect(r.ok).toBe(false)
    const { text, detail } = splitFailureDetail(r.message ?? '')
    expect(text).toContain('書き込めません')
    expect(detail).toContain('EACCES')
  })

  it.skipIf(isRoot)('★ 一部のファイルだけ戻せない: failed に名前、failedReason に理由（権限）。「記録が見つかりません」と決めつけない', () => {
    const file = path.join(tmp, 'a.txt')
    fs.writeFileSync(file, 'old')
    snapshotBeforeWrite(tmp, idAt(1), 'a.txt', 'new', 'テスト')
    fs.writeFileSync(file, 'new')
    fs.chmodSync(file, 0o444) // 上書きできない
    const r = restoreToSnapshot(tmp, idAt(1))
    fs.chmodSync(file, 0o644)
    expect(r.ok).toBe(true)
    expect(r.failed).toEqual(['a.txt'])
    const { text, detail } = splitFailureDetail(r.failedReason ?? '')
    expect(text).toContain('書き込めません')
    expect(detail).toContain('EACCES')
  })

  it('一覧が読めない: 読み取りの文（置き場が無いだけなら空の一覧で、失敗にしない）', () => {
    expect(listSnapshotSummaries(path.join(tmp, 'none'))).toMatchObject({ ok: true, snapshots: [] })
  })

  it('historyNotice: 前置きに文を埋め込み、詳細は最後の行に移す。理由が無いときは理由を言わない', () => {
    const msg = 'このフォルダには書き込めません。別の場所を選ぶか、Finder で権限を確かめてください。\n詳細: EACCES: permission denied'
    const failed = restoreFailedNotice(msg)
    expect(failed).toBe('⚠️ 復元できませんでした: このフォルダには書き込めません。別の場所を選ぶか、Finder で権限を確かめてください。\n詳細: EACCES: permission denied')
    expect(restoreFailedNotice('')).toBe('⚠️ 復元できませんでした')
    const partial = restorePartialLine(['a.txt', 'b.txt'], msg)
    expect(splitFailureDetail(partial).text).toContain('a.txt、b.txt')
    expect(splitFailureDetail(partial).detail).toBe('EACCES: permission denied')
    expect(restorePartialLine(['a.txt'], undefined)).toBe('⚠️ ただし次のファイルは戻せませんでした: a.txt')
    expect(restorePartialLine(['a.txt'], undefined)).not.toContain('記録が見つかりません')
  })
})

describe('🧹 フォルダの整理・ファイルの移動: 失敗は日本語の文＋詳細', () => {
  it('migrateFailed: 詳細は最後の行。戻したかの案内の前に挟まない', () => {
    const reason = 'このフォルダには書き込めません。別の場所を選ぶか、Finder で権限を確かめてください。\n詳細: EACCES: permission denied, mkdir'
    for (const restored of [true, false]) {
      const shown = migrateFailed(reason, restored)
      const { text, detail } = splitFailureDetail(shown)
      expect(detail).toBe('EACCES: permission denied, mkdir')
      expect(text).toContain('フォルダの整理に失敗しました（このフォルダには書き込めません。別の場所を選ぶか、Finder で権限を確かめてください）。')
      expect(text).toContain(restored ? '元へ戻しました' : '元へ戻せませんでした')
      expect(text).not.toContain('詳細:')
    }
    expect(migrateFailed('原因不明', true)).toContain('（原因不明）')
  })

  it('★ 移動の途中で失敗して、巻き戻しも失敗した: 文は日本語・「一部は元へ戻せませんでした」を足し、詳細は最後の1行', () => {
    for (const n of ['a.txt', 'b.txt']) fs.writeFileSync(path.join(tmp, n), n)
    let calls = 0
    h.renameImpl = () => {
      calls += 1
      if (calls === 1) return // 1つ目は動く
      throw Object.assign(new Error(`EACCES: permission denied, rename '${tmp}/b.txt' -> '${tmp}/materials/b.txt'`), { code: 'EACCES' })
    }
    const r = moveFilesToFs(tmp, ['a.txt', 'b.txt'], 'materials') as { ok: boolean; message?: string }
    expect(r.ok).toBe(false)
    const { text, detail } = splitFailureDetail(r.message ?? '')
    expect(text).toContain('書き込めません')
    expect(text).toContain('一部は元へ戻せませんでした')
    expect(text).not.toContain('EACCES')
    expect(detail).toContain('EACCES')
  })

  it('移動の途中で失敗して巻き戻せた: 「一部は…」は付かない', () => {
    for (const n of ['a.txt', 'b.txt']) fs.writeFileSync(path.join(tmp, n), n)
    const real = fs.renameSync
    let calls = 0
    h.renameImpl = (from, to) => {
      calls += 1
      if (calls === 2) throw Object.assign(new Error('ENOSPC: no space left on device, rename'), { code: 'ENOSPC' })
      real(from as string, to as string)
    }
    const r = moveFilesToFs(tmp, ['a.txt', 'b.txt'], 'materials') as { ok: boolean; message?: string }
    expect(r.ok).toBe(false)
    expect(splitFailureDetail(r.message ?? '').text).toContain('ディスクの空きが足りません')
    expect(r.message).not.toContain('一部は元へ戻せませんでした')
  })
})

describe('ファイル一覧・チャットの画像: 失敗は日本語の文＋詳細', () => {
  it.skipIf(isRoot)('★ 公開の記録の一覧が読めない（読み取り）: 日本語の文＋詳細', () => {
    const ws = path.join(tmp, 'ws')
    fs.mkdirSync(ws)
    fs.chmodSync(ws, 0o000)
    const r = publishedRecordsFs(ws)
    fs.chmodSync(ws, 0o755)
    expect(r.ok).toBe(false)
    const { text, detail } = splitFailureDetail(r.message ?? '')
    // 一覧を読むだけの失敗なので「書き込めません」とは言わない
    expect(text).toContain('読み込めませんでした')
    expect(text).not.toContain('書き込めません')
    expect(detail).toContain('EACCES')
  })

  it.skipIf(isRoot)('★ 画像をプロジェクトへ入れる口（fs:importImageData）が書けない: 日本語の文＋詳細', async () => {
    registerFsHandlers({ getMainWindow: () => null } as never)
    const project = path.join(tmp, 'proj')
    fs.mkdirSync(project)
    fs.chmodSync(project, 0o555)
    const r = await h.handlers.get('fs:importImageData')!({}, {
      projectDir: project, name: 'a.png', dataUrl: 'data:image/png;base64,AAAA', purpose: 'material',
    })
    fs.chmodSync(project, 0o755)
    expect(r.ok).toBe(false)
    const { text, detail } = splitFailureDetail(r.message)
    expect(text).toContain('書き込めません')
    expect(detail).toContain('EACCES')
  })

  const headed = (channel: string, text: string) => new Error(`Error invoking remote method '${channel}': Error: ${text}`)

  it('★ 名前の変更・新規ファイル: 権限の失敗は、頭を取った日本語の文＋詳細で通知する。日本語の断りの文はそのまま', async () => {
    const bodies: string[] = []
    const deps = {
      rename: async () => { throw headed('fs:rename', "EACCES: permission denied, rename '/d/a' -> '/d/b'") },
      exists: async () => false, writeFile: async () => {}, openFile: () => {}, announceRenamed: () => {},
      notify: (o: { body: string }) => { bodies.push(o.body) },
    } as unknown as NameDialogDeps
    expect(await submitFileNameDialog({ mode: 'rename', targetPath: '/d/a' }, 'b', deps)).toBe(false)
    const { text, detail } = splitFailureDetail(bodies[0])
    expect(text).toContain('書き込めません')
    expect(detail).toContain('EACCES')
    expect(bodies[0]).not.toContain('Error invoking remote method')

    bodies.length = 0
    const refused = { ...deps, rename: async () => { throw headed('fs:rename', 'プロジェクトのフォルダの名前は変えられません。') } } as unknown as NameDialogDeps
    await submitFileNameDialog({ mode: 'rename', targetPath: '/d/a' }, 'b', refused)
    expect(bodies).toEqual(['プロジェクトのフォルダの名前は変えられません。'])

    bodies.length = 0
    const noSpace = { ...deps, exists: async () => false, writeFile: async () => { throw headed('fs:writeFile', "ENOSPC: no space left on device, write") } } as unknown as NameDialogDeps
    await submitFileNameDialog({ mode: 'new', targetPath: '/d' }, 'n.txt', noSpace)
    expect(splitFailureDetail(bodies[0]).text).toContain('ディスクの空きが足りません')
  })

  it('★ 削除（ゴミ箱へ）: 権限の失敗は日本語の文＋詳細。聞く口（読み取り）の回線断は「接続できませんでした」', async () => {
    const bodies: string[] = []
    const base = {
      confirm: async () => true, openProjectDelete: () => {}, announceDeleted: () => {},
      notify: (o: { body: string }) => { bodies.push(o.body) },
    }
    await deleteFileEntry({ name: 'a', path: '/d/a' }, {
      ...base, trashCheck: async () => ({ ok: true }),
      trash: async () => { throw headed('fs:trash', "EPERM: operation not permitted, rename '/d/a' -> '/t/a'") },
    } as never)
    expect(splitFailureDetail(bodies[0]).text).toContain('書き込めません')
    expect(splitFailureDetail(bodies[0]).detail).toContain('EPERM')
    bodies.length = 0
    await deleteFileEntry({ name: 'a', path: '/d/a' }, {
      ...base, trashCheck: async () => { throw offlineError() }, trash: async () => {},
    } as never)
    expect(splitFailureDetail(bodies[0]).text).toContain('接続できませんでした')
  })
})

describe('⚙️ 更新の記録: 失敗は日本語の文＋詳細', () => {
  it.skipIf(isRoot)('★ 記録の場所に書けなくて、開こうとした: 日本語の文＋詳細', async () => {
    vi.resetModules()
    h.logsDir = path.join(tmp, 'logs')
    fs.mkdirSync(h.logsDir)
    fs.chmodSync(h.logsDir, 0o555)
    const mod = await import('../src/main/updateLog')
    mod.updateLogger.info('x') // 書けない → 理由を控える
    const r = await mod.revealUpdateLog()
    fs.chmodSync(h.logsDir, 0o755)
    expect(r.ok).toBe(false)
    const { text, detail } = splitFailureDetail(r.message ?? '')
    expect(text).toContain('書き込めません')
    expect(detail).toContain('EACCES')
  })

  it.skipIf(isRoot)('★ 記録のファイルはあるが追記できない: 「記録を残せていません（日本語の文）」＋詳細は最後の1行', async () => {
    vi.resetModules()
    h.logsDir = path.join(tmp, 'logs2')
    fs.mkdirSync(h.logsDir)
    const file = path.join(h.logsDir, 'updater.log')
    fs.writeFileSync(file, '')
    fs.chmodSync(file, 0o444)
    const mod = await import('../src/main/updateLog')
    mod.updateLogger.info('x')
    const r = await mod.revealUpdateLog()
    fs.chmodSync(file, 0o644)
    expect(r.ok).toBe(false)
    const { text, detail } = splitFailureDetail(r.message ?? '')
    expect(text).toContain('記録を残せていません（')
    expect(text).toContain('書き込めません')
    expect(text).toContain('このファイルは空か、古いままです。')
    expect(detail).toContain('EACCES')
  })
})

// ── 画面の描き口: 詳細を分けて描く部品（FailureLines）を通っている ─────────────────────
// 窓の描画そのものは重いので、置き場所だけを見る。文の組み立ては上の振る舞いのテストが固めている。
describe('画面の描き口は FailureLines を通る', () => {
  const src = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')
  const flat = (s: string) => s.replace(/\s+/g, ' ')
  it('★ 資料の質問の失敗・出典の確認の失敗・履歴の知らせと一覧・未使用ファイルの知らせ・設定の更新の失敗は、詳細を小さな行に分けて描く', () => {
    expect(flat(src('src/renderer/components/KnowledgeModal.tsx'))).toContain('<FailureLines text={askError} />')
    expect(flat(src('src/renderer/components/KnowledgeModal.tsx'))).toContain('<FailureLines text={note.text} />')
    const history = flat(src('src/renderer/components/HistoryModal.tsx'))
    expect(history).toContain('<FailureLines text={notice} />')
    expect(history).toContain('<FailureLines text={listError} />')
    expect(flat(src('src/renderer/components/UnusedFilesSection.tsx'))).toContain('<FailureLines text={note} />')
    expect(flat(src('src/renderer/components/SettingsModal.tsx'))).toContain('<FailureLines text={applyError} />')
  })

  it('★ 更新の失敗の表示は、更新が済んでいない通常の状態でも見える場所（強調の枠の外）にある', () => {
    const s = src('src/renderer/components/SettingsModal.tsx')
    const open = s.indexOf('{shouldHighlight(update) && (')
    const close = s.indexOf('更新の記録を表示…')
    const insideHighlight = s.slice(open, close)
    expect(insideHighlight).not.toContain('<FailureLines text={applyError} />')
    expect(s.indexOf('<FailureLines text={applyError} />')).toBeGreaterThan(close)
  })
})
