import { describe, it, expect, afterEach } from 'vitest'
import {
  fileEntryDeleteAction, deleteFileEntry, createNewFile, announceFileDeleted, submitFileNameDialog,
  TRASH_CHECK_UNREADABLE_MESSAGE, NEW_FILE_EXISTS_MESSAGE, FILE_DELETED_EVENT,
  type FileEntryDeleteDeps, type NameDialogDeps,
} from '../src/renderer/fileEntryOps'

// ── 0.6.24 T-E4: ファイル一覧の削除の振り分け・新規ファイルの同名・消したあとの知らせ（Sidebar から切り出した fileEntryOps.ts）──
// 偽の口（deps）に流し、**呼ばれた順の一覧**を見る（掟10: 確認の答え・聞いた答えを無視すると、移す要求が飛ぶ）。
//   ・根（プロジェクトのフォルダ）→ 削除の画面を開く。確認も fs.trash も 0 回
//   ・記録・中にプロジェクトがある・調べられない・ホームの深さ → 断りの文だけ。確認も fs.trash も 0 回
//   ・ふつう → 確認のあとで移す。確認でやめたら移さない
//   ・聞けなかった（投げた・形が違う）→ 移さない（不明を「移してよい」と読まない）
//   ・新規ファイルが同名 → writeFile 0 回（既存のファイルを空にしない）

type Call = string
function setup(answer: unknown | Error, opts: { confirm?: boolean; trashThrows?: Error } = {}) {
  const calls: Call[] = []
  const log = { alerts: [] as string[], opened: [] as string[], trashed: [] as string[], announced: [] as string[], asked: [] as string[], confirms: [] as unknown[] }
  const deps: FileEntryDeleteDeps = {
    trashCheck: async p => { calls.push('trashCheck'); log.asked.push(p); if (answer instanceof Error) throw answer; return answer },
    trash: async p => { calls.push('trash'); log.trashed.push(p); if (opts.trashThrows) throw opts.trashThrows },
    confirm: async o => { calls.push('confirm'); log.confirms.push(o); return opts.confirm ?? true },
    openProjectDelete: d => { calls.push('openProjectDelete'); log.opened.push(d) },
    alert: m => { calls.push('alert'); log.alerts.push(m) },
    announceDeleted: p => { calls.push('announce'); log.announced.push(p) },
  }
  return { calls, log, deps }
}
const ENTRY = { name: 'proj-a', path: '/Users/me/SAKURAIDE/proj-a' }

describe('fileEntryDeleteAction（純関数）: main の答えから、画面の動きを決める', () => {
  it('★★★ ok:true だけが確認へ進む。project は削除の画面。ほかの断りは main の文をそのまま出す', () => {
    expect(fileEntryDeleteAction({ ok: true })).toEqual({ kind: 'confirm' })
    expect(fileEntryDeleteAction({ ok: false, kind: 'project', message: 'プロジェクトのフォルダは、プロジェクトの 🗑 から削除してください。' })).toEqual({ kind: 'projectDelete' })
    for (const kind of ['denied', 'record', 'workspace', 'unknown'] as const) {
      expect(fileEntryDeleteAction({ ok: false, kind, message: `文-${kind}` }), kind).toEqual({ kind: 'refuse', message: `文-${kind}` })
    }
  })

  it('★★★ 読めない答え（undefined・null・{}・ok が true でない・文が無い）は断る側。確認へ進めない', () => {
    const odd: unknown[] = [undefined, null, {}, 'ok', 1, { ok: 'true' }, { ok: 1 }, { ok: 0 }, { ok: false }, { ok: false, kind: 'record' }, { ok: false, kind: 'record', message: '' }, { ok: false, kind: 'record', message: 5 }]
    for (const a of odd) {
      expect(fileEntryDeleteAction(a), JSON.stringify(a)).toEqual({ kind: 'refuse', message: TRASH_CHECK_UNREADABLE_MESSAGE })
    }
  })
})

describe('deleteFileEntry: 先に聞く → 振り分け → ふつうのものだけ 確認 → 移す', () => {
  it('★★★ ふつうのファイル: 聞く → 確認 → 移す → タブへ知らせる（この順）。確認の文は今までどおり', async () => {
    const { calls, log, deps } = setup({ ok: true })
    await deleteFileEntry({ name: 'a.html', path: '/Users/me/SAKURAIDE/p/a.html' }, deps)
    expect(calls).toEqual(['trashCheck', 'confirm', 'trash', 'announce'])
    expect(log.asked).toEqual(['/Users/me/SAKURAIDE/p/a.html'])
    expect(log.trashed).toEqual(['/Users/me/SAKURAIDE/p/a.html'])
    expect(log.announced).toEqual(['/Users/me/SAKURAIDE/p/a.html'])
    expect(log.confirms).toEqual([{
      title: 'ファイルをゴミ箱へ移します', body: '「a.html」をゴミ箱に移動します。よろしいですか？', confirmLabel: 'ゴミ箱へ移す', danger: true,
    }])
    expect(log.alerts).toEqual([])
  })

  it('★★★ 確認でやめた → 移さない・知らせない', async () => {
    const { calls, deps } = setup({ ok: true }, { confirm: false })
    await deleteFileEntry(ENTRY, deps)
    expect(calls).toEqual(['trashCheck', 'confirm'])
  })

  it('★★★ プロジェクトの根: 削除の画面を開くだけ。汎用の確認も、fs.trash も、断りの文も 0 回', async () => {
    const { calls, log, deps } = setup({ ok: false, kind: 'project', message: 'プロジェクトのフォルダは、プロジェクトの 🗑 から削除してください。' })
    await deleteFileEntry(ENTRY, deps)
    expect(calls).toEqual(['trashCheck', 'openProjectDelete'])
    expect(log.opened).toEqual([ENTRY.path])
    expect(log.trashed).toEqual([])
    expect(log.confirms).toEqual([])
    expect(log.alerts).toEqual([])
    expect(log.announced).toEqual([])
  })

  it.each([
    ['record', 'Koto の記録のファイルなので、ここからは削除できません。'],
    ['workspace', '中にプロジェクトがあるフォルダは、まとめて削除できません。プロジェクトごとに削除してください。'],
    ['unknown', 'フォルダの中を確かめられないため、削除していません。'],
    ['denied', 'ホームフォルダの直下は、まとめてゴミ箱へ送れません（中のファイルやプロジェクトを選んでください）'],
  ] as const)('★★★ %s: main の文だけを出す。確認も fs.trash も 0 回', async (kind, message) => {
    const { calls, log, deps } = setup({ ok: false, kind, message })
    await deleteFileEntry(ENTRY, deps)
    expect(calls).toEqual(['trashCheck', 'alert'])
    expect(log.alerts).toEqual([message])
    expect(log.trashed).toEqual([])
    expect(log.confirms).toEqual([])
    expect(log.opened).toEqual([])
  })

  it('★★★ 聞けなかった（trashCheck が投げた）→ 理由を出して終わり。確認も fs.trash も 0 回（不明を「移してよい」にしない）', async () => {
    const { calls, log, deps } = setup(new Error('IPC 失敗'))
    await deleteFileEntry(ENTRY, deps)
    expect(calls).toEqual(['trashCheck', 'alert'])
    expect(log.alerts).toEqual(['削除できませんでした: IPC 失敗'])
    expect(log.trashed).toEqual([])
    expect(log.confirms).toEqual([])
  })

  it('★★★ 形の違う答えが来た → 断りの文を出して終わり。確認も fs.trash も 0 回', async () => {
    for (const odd of [undefined, null, {}, { ok: 'true' }]) {
      const { calls, log, deps } = setup(odd)
      await deleteFileEntry(ENTRY, deps)
      expect(calls, JSON.stringify(odd)).toEqual(['trashCheck', 'alert'])
      expect(log.alerts, JSON.stringify(odd)).toEqual([TRASH_CHECK_UNREADABLE_MESSAGE])
      expect(log.trashed, JSON.stringify(odd)).toEqual([])
    }
  })

  it('★★ 確認のあとで移せなかった（main が断った・OS の失敗）→ 理由を出す。タブへは知らせない', async () => {
    const { calls, log, deps } = setup({ ok: true }, { trashThrows: new Error('権限がありません') })
    await deleteFileEntry(ENTRY, deps)
    expect(calls).toEqual(['trashCheck', 'confirm', 'trash', 'alert'])
    expect(log.alerts).toEqual(['削除できませんでした: 権限がありません'])
    expect(log.announced).toEqual([])
  })
})

describe('createNewFile: 同名があれば作らない（writeFile は既存のファイルを空にする）', () => {
  function files(exists: boolean | Error | unknown) {
    const calls: string[] = []
    const written: Array<[string, string]> = []
    return {
      calls, written,
      deps: {
        exists: async (p: string) => { calls.push(`exists ${p}`); if (exists instanceof Error) throw exists; return exists as boolean },
        writeFile: async (p: string, c: string) => { calls.push('writeFile'); written.push([p, c]) },
      },
    }
  }

  it('★★★ 無ければ空のファイルを作り、作ったパスを返す（確かめてから作る）', async () => {
    const f = files(false)
    expect(await createNewFile('/Users/me/SAKURAIDE/p', 'index.html', f.deps)).toBe('/Users/me/SAKURAIDE/p/index.html')
    expect(f.calls).toEqual(['exists /Users/me/SAKURAIDE/p/index.html', 'writeFile'])
    expect(f.written).toEqual([['/Users/me/SAKURAIDE/p/index.html', '']])
  })

  it('★★★ 同名があれば作らない（writeFile 0 回）。文は「同名のファイルが既にあります」', async () => {
    const f = files(true)
    await expect(createNewFile('/Users/me/SAKURAIDE/p/.sakura-cloud', 'state.json', f.deps)).rejects.toThrow(NEW_FILE_EXISTS_MESSAGE)
    expect(NEW_FILE_EXISTS_MESSAGE).toBe('同名のファイルが既にあります')
    expect(f.written).toEqual([])
  })

  it('★★★ あるか確かめられなかった（exists が投げた・boolean で答えない）→ 作らない', async () => {
    const thrown = files(new Error('IPC 失敗'))
    await expect(createNewFile('/d', 'a.txt', thrown.deps)).rejects.toThrow('IPC 失敗')
    expect(thrown.written).toEqual([])
    for (const odd of [undefined, null, 'false', 0]) {
      const f = files(odd)
      await expect(createNewFile('/d', 'a.txt', f.deps), String(odd)).rejects.toThrow(NEW_FILE_EXISTS_MESSAGE)
      expect(f.written, String(odd)).toEqual([])
    }
  })
})

describe('announceFileDeleted: 消したことをタブへ知らせる（sakura:file-deleted）', () => {
  const g = globalThis as { window?: unknown }
  const before = g.window
  afterEach(() => { g.window = before })

  it('★★★ sakura:file-deleted を、消したパスを detail にして 1 回出す（App がこの名前で聞く）', () => {
    const got: Array<{ type: string; detail: unknown }> = []
    g.window = { dispatchEvent: (e: Event) => { got.push({ type: e.type, detail: (e as CustomEvent).detail }); return true } }
    announceFileDeleted('/Users/me/SAKURAIDE/proj-a')
    expect(FILE_DELETED_EVENT).toBe('sakura:file-deleted')
    expect(got).toEqual([{ type: 'sakura:file-deleted', detail: '/Users/me/SAKURAIDE/proj-a' }])
  })
})

// ── R2-g: main の断りの文に、Electron の英語の頭（`Error invoking remote method '<チャンネル>': Error: `）が付いても、画面には文だけが出る ──
// 本物の ipcRenderer.invoke は、main が投げた文を必ずこの頭でくるんで reject する。偽の reject にも同じ頭を付けて流す。
// 変異: 3か所（削除の聞く・削除の移す・名前の変更／新規ファイル）の cleanRemoteError(e) を e?.message に戻す（それぞれ別に当てる）。
const headed = (channel: string, text: string) => new Error(`Error invoking remote method '${channel}': Error: ${text}`)

describe('★★★ R2-g 削除の断り: 頭つきの reject でも、文だけを出す', () => {
  it('★★★ 聞く口（fs:trashCheck）が頭つきで投げた → 「削除できませんでした: 文」。頭は出ない', async () => {
    const { calls, log, deps } = setup(headed('fs:trashCheck', '通信に失敗しました'))
    await deleteFileEntry(ENTRY, deps)
    expect(calls).toEqual(['trashCheck', 'alert'])
    expect(log.alerts).toEqual(['削除できませんでした: 通信に失敗しました'])
  })

  it('★★★ 移す口（fs:trash）が頭つきで投げた → 「削除できませんでした: 文」。タブへは知らせない', async () => {
    const { calls, log, deps } = setup({ ok: true }, { trashThrows: headed('fs:trash', '中にプロジェクトがあるフォルダは、まとめて削除できません。プロジェクトごとに削除してください。') })
    await deleteFileEntry(ENTRY, deps)
    expect(calls).toEqual(['trashCheck', 'confirm', 'trash', 'alert'])
    expect(log.alerts).toEqual(['削除できませんでした: 中にプロジェクトがあるフォルダは、まとめて削除できません。プロジェクトごとに削除してください。'])
    expect(log.announced).toEqual([])
  })
})

function nameDialogSetup(over: Partial<NameDialogDeps> = {}) {
  const calls: string[] = []
  const alerts: string[] = []
  const deps: NameDialogDeps = {
    rename: async (p, n) => { calls.push(`rename ${p} ${n}`); return `/d/${n}` },
    exists: async p => { calls.push(`exists ${p}`); return false },
    writeFile: async (p, c) => { calls.push(`writeFile ${p} ${JSON.stringify(c)}`) },
    openFile: p => { calls.push(`open ${p}`) },
    announceRenamed: (from, to) => { calls.push(`renamed ${from} ${to}`) },
    alert: m => { calls.push('alert'); alerts.push(m) },
    ...over,
  }
  return { calls, alerts, deps }
}

describe('★★★ R2-g submitFileNameDialog（名前の変更・新規ファイル）: 頭つきの reject でも、文だけを出す。ダイアログは閉じない', () => {
  it('★★★ 名前の変更: main が頭つきで断った → 文だけを alert に出す。false（開いたまま）・タブへ知らせない', async () => {
    const f = nameDialogSetup({ rename: async (p, n) => { f.calls.push(`rename ${p} ${n}`); throw headed('fs:rename', 'プロジェクトのフォルダの名前は変えられません。') } })
    const ok = await submitFileNameDialog({ mode: 'rename', targetPath: '/d/proj' }, 'newname', f.deps)
    expect(ok).toBe(false)
    expect(f.alerts).toEqual(['プロジェクトのフォルダの名前は変えられません。'])
    expect(f.calls).toEqual(['rename /d/proj newname', 'alert'])
  })

  it('★★★ 新規ファイル: あるか確かめる口が頭つきで投げた → 文だけ。writeFile 0 回。同名なら今までの文（頭なし）', async () => {
    const thrown = nameDialogSetup({ exists: async () => { throw headed('fs:exists', '確かめられません') } })
    expect(await submitFileNameDialog({ mode: 'new', targetPath: '/d' }, 'a.txt', thrown.deps)).toBe(false)
    expect(thrown.alerts).toEqual(['確かめられません'])
    expect(thrown.calls.some(c => c.startsWith('writeFile'))).toBe(false)
    const dup = nameDialogSetup({ exists: async () => true })
    expect(await submitFileNameDialog({ mode: 'new', targetPath: '/d' }, 'a.txt', dup.deps)).toBe(false)
    expect(dup.alerts).toEqual([NEW_FILE_EXISTS_MESSAGE])
    expect(dup.calls.some(c => c.startsWith('writeFile'))).toBe(false)
  })

  it('★★ 頭の無い文・Error でない値は、そのまま出す（削り過ぎない）', async () => {
    const plain = nameDialogSetup({ rename: async () => { throw new Error('同名のファイルが既に存在します') } })
    await submitFileNameDialog({ mode: 'rename', targetPath: '/d/a' }, 'b', plain.deps)
    expect(plain.alerts).toEqual(['同名のファイルが既に存在します'])
    const str = nameDialogSetup({ rename: async () => { throw '文字列で投げた' } })
    await submitFileNameDialog({ mode: 'rename', targetPath: '/d/a' }, 'b', str.deps)
    expect(str.alerts).toEqual(['文字列で投げた'])
  })

  it('★★★ 不正な名前（空・空白だけ・/ ・..）は main へ聞かずに「不正なファイル名です」。rename・exists・writeFile は 0 回', async () => {
    for (const bad of ['', '   ', 'a/b', '..', 'x..y']) {
      const f = nameDialogSetup()
      expect(await submitFileNameDialog({ mode: 'rename', targetPath: '/d/a' }, bad, f.deps), JSON.stringify(bad)).toBe(false)
      expect(await submitFileNameDialog({ mode: 'new', targetPath: '/d' }, bad, f.deps), JSON.stringify(bad)).toBe(false)
      expect(f.alerts, JSON.stringify(bad)).toEqual(['不正なファイル名です', '不正なファイル名です'])
      expect(f.calls.filter(c => c !== 'alert'), JSON.stringify(bad)).toEqual([])
    }
  })

  it('★★ 対照（成功）: 名前の変更は trim した名前で rename → 知らせて true。新規は exists → writeFile → 開いて true', async () => {
    const r = nameDialogSetup()
    expect(await submitFileNameDialog({ mode: 'rename', targetPath: '/d/a.txt' }, ' b.txt ', r.deps)).toBe(true)
    expect(r.calls).toEqual(['rename /d/a.txt b.txt', 'renamed /d/a.txt /d/b.txt'])
    const n = nameDialogSetup()
    expect(await submitFileNameDialog({ mode: 'new', targetPath: '/d' }, 'index.html', n.deps)).toBe(true)
    expect(n.calls).toEqual(['exists /d/index.html', 'writeFile /d/index.html ""', 'open /d/index.html'])
    expect(n.alerts).toEqual([])
  })
})
