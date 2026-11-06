import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeFileIfUnchangedFs, readCheckFs } from '../src/main/writeIfUnchangedFs'
import { snapshotBeforeWrite, listSnapshotSummaries } from '../src/main/backup/store'
import { BACKUP_DIRNAME } from '../src/main/backup/plan'
import { snapshotBeforeManualSave, type ManualSnapshotGroup } from '../src/renderer/manualSnapshot'
import {
  saveTab, saveAllAndQuit, saveBeforeLeave, keepMyEdit, recreateTab, reloadTabFromDisk, previewTab, autosaveTargets,
  type OpenFile, type SaveDeps, type SaveBlock,
} from '../src/renderer/editorTabs'
import { runGuardedMigrate } from '../src/renderer/migrateGuard'

// ── 外で書き換わったファイルの、書く入口4つ（自動保存・⌘S・プレビュー前・終了時）と、帯の操作 ──
// 守るもの: 外で変わった・消えた・読めないファイルを、タブの古い中身で黙って上書きしない。選ぶまで書かず、終了もしない。
// 本物の一時フォルダと、main の本物の「変わっていなければ書く」口（writeIfUnchangedFs）・本物の履歴の退避（backup/store）に流して、
// 呼ばれた要求の一覧とディスクの前後で見る。「読めない」は、ファイルのあるべき場所にフォルダを置いて作る
// （読もうとすると EISDIR で失敗する。権限の外し方と違い、どの実行者でも同じに再現できる）。

let root = ''
let proj = ''
let calls: string[]
let clock = 0
let afterRead: (() => void) | undefined
let afterWrite: (() => void) | undefined
let writeIfUnchangedThrows = false
const snapshotRef: { current: ManualSnapshotGroup | null } = { current: null }

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koto-sync-entries-')))
  proj = path.join(root, 'proj')
  fs.mkdirSync(proj)
  calls = []
  clock = Date.UTC(2026, 10, 3, 9, 0, 0)
  afterRead = undefined
  afterWrite = undefined
  writeIfUnchangedThrows = false
  snapshotRef.current = null
  vi.stubGlobal('window', {
    electronAPI: {
      fs: {
        readFile: async (p: string) => {
          calls.push(`readFile ${path.basename(p)}`)
          const text = fs.readFileSync(p, 'utf-8')
          afterRead?.()
          return text
        },
        exists: async (p: string) => fs.existsSync(p),
        // 読み直しに失敗したタブの分類は、保存の口と同じ main の分類（readCheckFs）に聞く
        readCheck: async (p: string) => { calls.push(`readCheck ${path.basename(p)}`); return readCheckFs(p) },
        // 保存の経路では 0 回であること（古い、基準を見ずに書く口）
        writeFile: async (p: string) => { calls.push(`writeFile ${path.basename(p)}`) },
        writeFileIfUnchanged: async (p: string, content: string, expected: string | null) => {
          calls.push(`writeFileIfUnchanged ${path.basename(p)} expected=${expected === null ? 'null' : JSON.stringify(expected)}`)
          if (writeIfUnchangedThrows) throw new Error('disk full')
          const r = writeFileIfUnchangedFs(p, content, expected)
          afterWrite?.()
          return r
        },
      },
      backup: {
        snapshotBeforeWrite: async (dir: string, id: string, rel: string, content: string, label?: string) => {
          calls.push(`snapshot ${rel}`)
          return snapshotBeforeWrite(dir, id, rel, content, label)
        },
      },
      shell: { openPath: async (p: string) => { calls.push(`openPath ${path.basename(p)}`) } },
      win: { quitAfterSave: async () => { calls.push('quit') } },
    },
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  fs.rmSync(root, { recursive: true, force: true })
})

const at = (name: string) => path.join(proj, name)
const put = (name: string, content: string): string => { const p = at(name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); return p }
/** ディスクの見え方（前後で比べる）。無い・フォルダ・中身。 */
const view = (p: string): string => {
  if (!fs.existsSync(p)) return '<無い>'
  if (fs.statSync(p).isDirectory()) return '<フォルダ>'
  return fs.readFileSync(p, 'utf-8')
}
const writes = () => calls.filter(c => c.startsWith('writeFile ') || c.startsWith('writeFileIfUnchanged '))

function tab(p: string, over: Partial<OpenFile> = {}): OpenFile {
  return { path: p, name: path.basename(p), content: 'mine', isDirty: true, language: 'plaintext', diskContent: 'base', ...over }
}

/** App が持つタブの一覧の代わり。退避は本物の履歴（manualSnapshot.ts → backup/store）に流す。 */
function makeStore(initial: OpenFile[]) {
  const store = {
    list: initial,
    snapshots: [] as string[],
    deps: undefined as unknown as SaveDeps,
    of(p: string) { return store.list.find(f => f.path === p)! },
  }
  store.deps = {
    getFiles: () => store.list,
    updateFiles: fn => { store.list = fn(store.list) },
    beforeWrite: (p, c) => snapshotBeforeManualSave(
      snapshotRef,
      { currentDir: proj, now: () => clock, snapshot: (dir, id, rel, content, label) => window.electronAPI.backup.snapshotBeforeWrite(dir, id, rel, content, label) },
      p, c),
  }
  return store
}

const STATES: SaveBlock[] = ['changed', 'missing', 'unreadable']

/** 「base」を開いて「mine」と編集したタブと、そのあとに外で起きたこと。 */
function openThenExternal(state: SaveBlock, marked = false) {
  const p = put('a.txt', 'base')
  const store = makeStore([tab(p, marked ? { syncMark: state } : {})])
  if (state === 'changed') fs.writeFileSync(p, 'external')
  else {
    fs.rmSync(p)
    if (state === 'unreadable') fs.mkdirSync(p)
  }
  return { p, store, before: view(p) }
}

// ── 書く入口4つ ──────────────────────────────────────────────────────────

/** 入口ごとの動かし方。App の配線（autosaveTargets → 保存・⌘S → 保存・previewTab・saveAllAndQuit）と同じ形で呼ぶ。 */
function entries(store: ReturnType<typeof makeStore>, p: string, notified: string[][]) {
  return {
    autosave: async () => { for (const f of autosaveTargets(store.list)) await saveTab(store.deps, f.path, f.content) },
    cmdS: async () => { await saveTab(store.deps, p, store.of(p).content) },
    preview: async () => { await previewTab(store.of(p), { save: (path_, c) => saveTab(store.deps, path_, c), open: window.electronAPI.shell.openPath }) },
    quit: async () => {
      await saveAllAndQuit({ ...store.deps, notifyUnsaved: u => notified.push(u.map(f => f.name)), quit: window.electronAPI.win.quitAfterSave })
    },
  }
}
type EntryName = 'autosave' | 'cmdS' | 'preview' | 'quit'
const ENTRY_NAMES: EntryName[] = ['autosave', 'cmdS', 'preview', 'quit']

describe('★★★ 書く入口4つは、外で変わった・消えた・読めないファイルを書かない（表で回す）', () => {
  for (const state of STATES) {
    for (const entry of ENTRY_NAMES) {
      it(`印がまだ無い回 / ${state} / ${entry}: ディスクは前のまま・印が立つ・編集は残る。プレビューは開かず、終了もしない`, async () => {
        const { p, store, before } = openThenExternal(state)
        const notified: string[][] = []
        await entries(store, p, notified)[entry]()
        expect(view(p)).toBe(before)
        expect(store.of(p).syncMark).toBe(state)
        expect(store.of(p).content).toBe('mine')
        expect(store.of(p).isDirty).toBe(true)
        expect(store.of(p).diskContent).toBe('base')
        // 古い口（基準を見ずに書く）は一度も使わない
        expect(calls.filter(c => c.startsWith('writeFile '))).toEqual([])
        expect(calls).not.toContain('openPath a.txt')
        expect(calls).not.toContain('quit')
        // 書いていないので、履歴（🕘）にも残さない（前に保存した時点が無い、最初の衝突でも）
        expect(calls.filter(c => c.startsWith('snapshot '))).toEqual([])
        expect(listSnapshotSummaries(proj).snapshots).toEqual([])
        if (entry === 'quit') expect(notified).toEqual([['a.txt']])
        else expect(notified).toEqual([])
      })

      it(`印がすでにある回 / ${state} / ${entry}: 同じく書かない。自動保存は主の口にも触れない`, async () => {
        const { p, store, before } = openThenExternal(state, true)
        const notified: string[][] = []
        await entries(store, p, notified)[entry]()
        expect(view(p)).toBe(before)
        expect(store.of(p).syncMark).toBe(state)
        expect(store.of(p).isDirty).toBe(true)
        expect(calls.filter(c => c.startsWith('writeFile '))).toEqual([])
        expect(calls).not.toContain('openPath a.txt')
        expect(calls).not.toContain('quit')
        if (entry === 'autosave') expect(calls).toEqual([]) // 印のあるタブは、主の口にも履歴にも触れない
      })
    }
  }

  it('★ 自動保存は、印のあるタブを何周しても要求を出さない（確認や帯が出続けるループにならない）', async () => {
    const { p, store, before } = openThenExternal('changed')
    const run = entries(store, p, [])
    await run.autosave() // 1回目は主の口が止め、印が立つ
    const afterFirst = calls.length
    expect(store.of(p).syncMark).toBe('changed')
    for (let i = 0; i < 5; i++) await run.autosave()
    expect(calls.length).toBe(afterFirst)
    expect(view(p)).toBe(before)
  })

  it('★ 知らない値の印も「止めた」と読む（不明値を「書いてよい」に戻さない）: 自動保存は要求を出さない', async () => {
    const p = put('a.txt', 'base')
    const store = makeStore([tab(p, { syncMark: 'weird' as unknown as SaveBlock })])
    await entries(store, p, []).autosave()
    expect(calls).toEqual([])
    expect(autosaveTargets(store.list)).toEqual([])
  })

  it('印が無く未保存のタブは自動保存の対象で、未保存でないタブは対象外', () => {
    const a = tab(at('a.txt'))
    const b = tab(at('b.txt'), { isDirty: false })
    const c = tab(at('c.txt'), { syncMark: 'missing' })
    expect(autosaveTargets([a, b, c])).toEqual([a])
  })

  it('外で変わっていなければ4つの入口とも普通に書く（止めるのは食い違いのときだけ）', async () => {
    for (const entry of ENTRY_NAMES) {
      const p = put('ok.txt', 'base')
      const store = makeStore([tab(p)])
      const notified: string[][] = []
      calls = []
      await entries(store, p, notified)[entry]()
      expect(view(p), entry).toBe('mine')
      expect(store.of(p).syncMark, entry).toBeUndefined()
      expect(store.of(p).isDirty, entry).toBe(false)
      expect(calls.filter(c => c.startsWith('writeFile ')), entry).toEqual([])
      expect(notified, entry).toEqual([])
      if (entry === 'preview') expect(calls[calls.length - 1], entry).toBe('openPath ok.txt')
      if (entry === 'quit') expect(calls[calls.length - 1], entry).toBe('quit')
    }
  })
})

describe('★★ 書くものが無いタブ（未保存の編集も止めた印も無い）は、⌘S でも自動保存でも終了でも、外の版に帯を出さない・書かない', () => {
  it('外で変わった・消えたタブに ⌘S: 要求も履歴も出さず、印も立たない。ディスクは外の版のまま', async () => {
    for (const state of ['changed', 'missing'] as const) {
      calls = []
      const p = put('clean.txt', 'base')
      const store = makeStore([tab(p, { content: 'base', isDirty: false })])
      if (state === 'changed') fs.writeFileSync(p, 'external')
      else fs.rmSync(p)
      const before = view(p)
      const r = await saveTab(store.deps, p, 'base')
      expect(r, state).toEqual({ ok: true })
      expect(calls, state).toEqual([])
      expect(view(p), state).toBe(before)
      expect(store.of(p).syncMark, state).toBeUndefined()
      expect(store.of(p).content, state).toBe('base')
      expect(listSnapshotSummaries(proj).snapshots, state).toEqual([])
      fs.rmSync(p, { force: true })
    }
  })

  it('外で変わったことを知らずに「自分の編集を保存する」で外の版を上書きする道は、編集の無いタブでは開かない', async () => {
    const p = put('clean.txt', 'base')
    const store = makeStore([tab(p, { content: 'base', isDirty: false })])
    fs.writeFileSync(p, 'pulled')
    await saveTab(store.deps, p, 'base')
    expect(autosaveTargets(store.list)).toEqual([])
    expect(store.of(p).syncMark).toBeUndefined() // 帯が出ないので、古い中身で外の版を上書きするボタンも出ない
    expect(view(p)).toBe('pulled')
  })
})

describe('★★ 止めた保存は履歴（🕘）に何も残さない（前の時点がある回でも、無い最初の衝突でも）', () => {
  it('前の時点が無い最初の衝突: 外の版も「作った」の記録も、履歴に出ない', async () => {
    for (const state of STATES) {
      calls = []
      const { p, store, before } = openThenExternal(state)
      expect((await saveTab(store.deps, p, 'mine')).ok, state).toBe(false)
      expect(view(p), state).toBe(before)
      expect(calls.filter(c => c.startsWith('snapshot ')), state).toEqual([])
      expect(listSnapshotSummaries(proj).snapshots, state).toEqual([])
      fs.rmSync(p, { recursive: true, force: true })
    }
  })

  it('書ける回は、書く前に退避する（書けそうなときは退避する側）', async () => {
    const p = put('ok.txt', 'base')
    const store = makeStore([tab(p)])
    expect((await saveTab(store.deps, p, 'mine')).ok).toBe(true)
    expect(calls.filter(c => c.startsWith('snapshot '))).toEqual(['snapshot ok.txt'])
    expect(listSnapshotSummaries(proj).snapshots).toHaveLength(1)
  })
})

// ── プロジェクトを切り替える前の保存 ─────────────────────────────────────

describe('saveBeforeLeave: 切り替えるとタブは入れ替わる。保存できなかった編集は、確かめてからでないと捨てない', () => {
  const leave = (store: ReturnType<typeof makeStore>, answer: unknown, asked: string[][]) =>
    saveBeforeLeave({
      ...store.deps,
      confirmDiscard: async unsaved => { asked.push(unsaved.map(f => f.name)); return answer as boolean },
    })

  it('未保存のタブが無ければ、確認も書き込みも無しで切り替えてよい', async () => {
    const p = put('a.txt', 'base')
    const store = makeStore([tab(p, { content: 'base', isDirty: false })])
    const asked: string[][] = []
    expect(await leave(store, false, asked)).toBe(true)
    expect(asked).toEqual([])
    expect(calls).toEqual([])
  })

  it('★ 書ける未保存のタブは、先に書く。確認は出ない（捨てる編集が無い）', async () => {
    const p = put('a.txt', 'base')
    const store = makeStore([tab(p)])
    const asked: string[][] = []
    expect(await leave(store, false, asked)).toBe(true)
    expect(view(p)).toBe('mine')
    expect(asked).toEqual([])
    expect(store.of(p).isDirty).toBe(false)
  })

  it('★★★ 保存を止めたタブ（外で変わった・消えた・読めない）の編集は、確認なしに捨てない。答えが no なら切り替えず、編集もディスクもそのまま', async () => {
    for (const state of STATES) {
      calls = []
      const { p, store, before } = openThenExternal(state, true)
      const asked: string[][] = []
      expect(await leave(store, false, asked), state).toBe(false)
      expect(asked, state).toEqual([['a.txt']])
      expect(view(p), state).toBe(before)
      expect(store.of(p).content, state).toBe('mine')
      expect(store.of(p).isDirty, state).toBe(true)
      expect(calls.filter(c => c.startsWith('writeFile ')), state).toEqual([])
      fs.rmSync(p, { recursive: true, force: true })
    }
  })

  it('答えが yes なら切り替えてよい（捨てると自分で選んだ）。それでも外の版は上書きしない', async () => {
    const { p, store, before } = openThenExternal('changed', true)
    const asked: string[][] = []
    expect(await leave(store, true, asked)).toBe(true)
    expect(asked).toEqual([['a.txt']])
    expect(view(p)).toBe(before)
  })

  it('★ true でない答え（不明な値）は「捨ててよい」と読まない', async () => {
    for (const odd of [undefined, null, 0, 'yes', 1]) {
      const { p, store } = openThenExternal('changed', true)
      expect(await leave(store, odd, []), String(odd)).toBe(false)
      fs.rmSync(p, { force: true })
    }
  })

  it('★ 書くのに失敗した回（例外）も、捨てる編集として確かめる。書ける別のタブは先に書く', async () => {
    const good = put('good.txt', 'base')
    const bad = put('bad.txt', 'base')
    const store = makeStore([tab(good), tab(bad)])
    const orig = window.electronAPI.fs.writeFileIfUnchanged
    window.electronAPI.fs.writeFileIfUnchanged = async (q: string, c: string, e: string | null) => {
      if (path.basename(q) === 'bad.txt') throw new Error('disk full')
      return orig(q, c, e)
    }
    const asked: string[][] = []
    expect(await leave(store, false, asked)).toBe(false)
    expect(asked).toEqual([['bad.txt']])
    expect(view(good)).toBe('mine')
    expect(view(bad)).toBe('base')
  })

  it('★ 順序: 保存が先、確認はあと（確認が出るのは、保存しても残った編集があるときだけ）', async () => {
    const good = put('good.txt', 'base')
    const stale = put('stale.txt', 'base')
    const store = makeStore([tab(good), tab(stale)])
    fs.writeFileSync(stale, 'external')
    let diskWhenAsked = ''
    const ok = await saveBeforeLeave({
      ...store.deps,
      confirmDiscard: async () => { diskWhenAsked = view(good); return false },
    })
    expect(ok).toBe(false)
    expect(diskWhenAsked).toBe('mine') // 確認が出た時点で、書ける方はもう書けている
  })
})

// ── フォルダの整理の前の保存 ─────────────────────────────────────────────

describe('runGuardedMigrate: フォルダの整理でタブは閉じる。保存を止めたタブの編集は、確認なしに捨てない', () => {
  /** App の配線（leaveProject = saveBeforeLeave）と同じ形の口で、整理の前の確認を通す。main の整理の代わりに、本物の一時フォルダでファイルを動かす。 */
  function run(store: ReturnType<typeof makeStore>, answer: boolean, asked: string[][]) {
    const closed: string[] = []
    const result = runGuardedMigrate({
      beforeMove: () => saveBeforeLeave({ ...store.deps, confirmDiscard: async u => { asked.push(u.map(f => f.name)); return answer } }),
      migrate: async () => {
        calls.push('migrate')
        fs.mkdirSync(at('public'), { recursive: true })
        fs.renameSync(at('index.html'), at('public/index.html'))
        return { ok: true, moved: ['index.html'], restored: false }
      },
      afterMoved: () => { calls.push('afterMoved'); closed.push('all'); store.list = [] },
    })
    return { result, closed }
  }

  it('★★★ 保存を止めたタブがあれば確認が出る。断ると何も動かさず、タブの編集もディスクもそのまま', async () => {
    const p = put('index.html', 'base')
    const store = makeStore([tab(p, { syncMark: 'changed' })])
    fs.writeFileSync(p, 'external')
    const asked: string[][] = []
    const { result, closed } = run(store, false, asked)
    expect(await result).toEqual({ cancelled: true })
    expect(asked).toEqual([['index.html']])
    expect(calls).not.toContain('migrate')
    expect(calls).not.toContain('afterMoved')
    expect(closed).toEqual([])
    expect(view(p)).toBe('external')
    expect(view(at('public/index.html'))).toBe('<無い>')
    expect(store.of(p).content).toBe('mine')
    expect(store.of(p).isDirty).toBe(true)
  })

  it('★ 書ける未保存のタブは、整理の前に書く（履歴にも残る）。確認は出ない。そのあとで動かし、タブを閉じる', async () => {
    const p = put('index.html', 'base')
    const store = makeStore([tab(p)])
    const asked: string[][] = []
    const { result } = run(store, false, asked)
    expect((await result)).toMatchObject({ ok: true })
    expect(asked).toEqual([])
    expect(view(at('public/index.html'))).toBe('mine') // 編集は、動かす前に書かれたので、動いた先にある
    expect(calls.filter(c => c.startsWith('snapshot '))).toEqual(['snapshot index.html'])
    expect(calls.indexOf('writeFileIfUnchanged index.html expected="base"')).toBeLessThan(calls.indexOf('migrate'))
    expect(calls.indexOf('migrate')).toBeLessThan(calls.indexOf('afterMoved'))
  })

  it('確認に yes と答えたら（捨てると選んだ）動かして閉じる', async () => {
    const p = put('index.html', 'base')
    const store = makeStore([tab(p, { syncMark: 'changed' })])
    fs.writeFileSync(p, 'external')
    const { result } = run(store, true, [])
    expect(await result).toMatchObject({ ok: true })
    expect(calls).toContain('afterMoved')
  })

  it('整理が失敗したら（ok でない）タブは閉じない', async () => {
    const p = put('index.html', 'base')
    const store = makeStore([tab(p, { content: 'base', isDirty: false })])
    const r = await runGuardedMigrate({
      beforeMove: () => saveBeforeLeave({ ...store.deps, confirmDiscard: async () => false }),
      migrate: async () => ({ ok: false, moved: [], restored: true, message: 'x' }),
      afterMoved: () => { calls.push('afterMoved') },
    })
    expect(r).toMatchObject({ ok: false })
    expect(calls).not.toContain('afterMoved')
  })
})

// ── 終了時の保存 ─────────────────────────────────────────────────────────

describe('saveAllAndQuit: 全部書けたときだけ終了する', () => {
  it('★ 書けるタブは書き、止めたタブがあれば終了しない。知らせるのは止めたタブだけ（書けたものを巻き戻さない）', async () => {
    const good = put('good.txt', 'base')
    const stale = put('stale.txt', 'base')
    const store = makeStore([tab(good), tab(stale)])
    fs.writeFileSync(stale, 'external')
    const notified: string[][] = []
    const ok = await saveAllAndQuit({ ...store.deps, notifyUnsaved: u => notified.push(u.map(f => f.name)), quit: window.electronAPI.win.quitAfterSave })
    expect(ok).toBe(false)
    expect(view(good)).toBe('mine')
    expect(view(stale)).toBe('external')
    expect(notified).toEqual([['stale.txt']])
    expect(calls).not.toContain('quit')
    expect(store.of(stale).syncMark).toBe('changed')
  })

  it('全部書けたら、書き終えたあとに1回だけ終了する。知らせは出さない', async () => {
    const a = put('a.txt', 'base')
    const b = put('b.txt', 'base')
    const store = makeStore([tab(a), tab(b)])
    const notified: string[][] = []
    const ok = await saveAllAndQuit({ ...store.deps, notifyUnsaved: u => notified.push(u.map(f => f.name)), quit: window.electronAPI.win.quitAfterSave })
    expect(ok).toBe(true)
    expect(view(a)).toBe('mine')
    expect(view(b)).toBe('mine')
    expect(calls.filter(c => c === 'quit')).toHaveLength(1)
    expect(calls.lastIndexOf('quit')).toBe(calls.length - 1)
    expect(calls.filter(c => c.startsWith('writeFile '))).toEqual([])
    expect(notified).toEqual([])
  })

  it('★ 書くのに失敗した（例外）回も終了しない。タブは未保存のまま、知らせる', async () => {
    const a = put('a.txt', 'base')
    const store = makeStore([tab(a)])
    writeIfUnchangedThrows = true
    const notified: string[][] = []
    const ok = await saveAllAndQuit({ ...store.deps, notifyUnsaved: u => notified.push(u.map(f => f.name)), quit: window.electronAPI.win.quitAfterSave })
    expect(ok).toBe(false)
    expect(view(a)).toBe('base')
    expect(store.of(a).isDirty).toBe(true)
    expect(notified).toEqual([['a.txt']])
    expect(calls).not.toContain('quit')
  })

  it('★ 書いている間に打った文字が残った回も終了しない（その文字はまだディスクに無い）', async () => {
    const a = put('a.txt', 'base')
    const store = makeStore([tab(a)])
    afterWrite = () => { store.list = store.list.map(f => ({ ...f, content: 'mine!!' })) }
    const notified: string[][] = []
    const ok = await saveAllAndQuit({ ...store.deps, notifyUnsaved: u => notified.push(u.map(f => f.name)), quit: window.electronAPI.win.quitAfterSave })
    expect(ok).toBe(false)
    expect(view(a)).toBe('mine')
    expect(store.of(a).content).toBe('mine!!')
    expect(store.of(a).isDirty).toBe(true)
    expect(notified).toEqual([['a.txt']])
    expect(calls).not.toContain('quit')
  })

  it('未保存でないタブの古い印は終了を止めない（捨てる編集が無い）', async () => {
    const a = put('a.txt', 'base')
    const b = put('b.txt', 'base')
    const store = makeStore([tab(a), tab(b, { isDirty: false, content: 'base', syncMark: 'missing' })])
    const ok = await saveAllAndQuit({ ...store.deps, notifyUnsaved: () => { throw new Error('知らせない') }, quit: window.electronAPI.win.quitAfterSave })
    expect(ok).toBe(true)
    expect(view(a)).toBe('mine')
  })

  it('終了時の保存も履歴（🕘）に退避してから書く。書く前の中身が残る', async () => {
    const a = put('a.txt', 'base')
    const store = makeStore([tab(a)])
    await saveAllAndQuit({ ...store.deps, notifyUnsaved: () => undefined, quit: window.electronAPI.win.quitAfterSave })
    expect(calls.slice(0, 4)).toEqual(['readFile a.txt', 'snapshot a.txt', 'writeFileIfUnchanged a.txt expected="base"', 'quit'])
    const snaps = listSnapshotSummaries(proj).snapshots
    expect(snaps).toHaveLength(1)
    expect(fs.readFileSync(path.join(proj, BACKUP_DIRNAME, snaps[0].id, 'a.txt'), 'utf-8')).toBe('base')
  })
})

// ── プレビュー前の保存 ───────────────────────────────────────────────────

describe('previewTab: 書けたのを待ってから開く。止まったら開かない', () => {
  it('★ 未保存なら、保存の要求が終わってから開く（待たずに古い版を開かない）', async () => {
    const p = put('page.html', 'base')
    const store = makeStore([tab(p)])
    const opened = await previewTab(store.of(p), { save: (q, c) => saveTab(store.deps, q, c), open: window.electronAPI.shell.openPath })
    expect(opened).toBe(true)
    expect(view(p)).toBe('mine')
    const iWrite = calls.findIndex(c => c.startsWith('writeFileIfUnchanged '))
    const iOpen = calls.indexOf('openPath page.html')
    expect(iWrite).toBeGreaterThanOrEqual(0)
    expect(iOpen).toBeGreaterThan(iWrite)
  })

  it('未保存でも印もないタブは保存を頼まずに開く', async () => {
    const p = put('page.html', 'base')
    const store = makeStore([tab(p, { isDirty: false, content: 'base' })])
    const opened = await previewTab(store.of(p), { save: (q, c) => saveTab(store.deps, q, c), open: window.electronAPI.shell.openPath })
    expect(opened).toBe(true)
    expect(calls).toEqual(['openPath page.html'])
  })

  it('★★ 未保存の編集が無くても、止めた印のあるタブは保存を頼み、止まったら開かない（外の版・無いファイルを見せない）', async () => {
    for (const state of ['changed', 'missing'] as const) {
      calls = []
      const p = put('page.html', 'base')
      const store = makeStore([tab(p, { content: 'base', isDirty: false, syncMark: state })])
      if (state === 'changed') fs.writeFileSync(p, 'external')
      else fs.rmSync(p)
      const opened = await previewTab(store.of(p), { save: (q, c) => saveTab(store.deps, q, c), open: window.electronAPI.shell.openPath })
      expect(opened, state).toBe(false)
      expect(calls.some(c => c.startsWith('writeFileIfUnchanged ')), state).toBe(true)
      expect(calls, state).not.toContain('openPath page.html')
      fs.rmSync(p, { force: true })
    }
  })

  it('★ 保存が例外で終わった回は開かない（例外はそのまま伝える）', async () => {
    const p = put('page.html', 'base')
    const store = makeStore([tab(p)])
    writeIfUnchangedThrows = true
    await expect(previewTab(store.of(p), { save: (q, c) => saveTab(store.deps, q, c), open: window.electronAPI.shell.openPath })).rejects.toThrow('disk full')
    expect(calls).not.toContain('openPath page.html')
  })
})

// ── 帯の操作: 自分の編集を保存する ───────────────────────────────────────

describe('keepMyEdit: 外の版を履歴（🕘）に残してから、読み直した外の版を基準に書く', () => {
  const keepDeps = (store: ReturnType<typeof makeStore>) => ({ ...store.deps, resetSnapshotGroup: () => { snapshotRef.current = null } })
  const backupOf = (id: string, rel: string) => fs.readFileSync(path.join(proj, BACKUP_DIRNAME, id, rel), 'utf-8')
  const snapshotsWith = (rel: string, content: string) =>
    listSnapshotSummaries(proj).snapshots.filter(s => {
      try { return backupOf(s.id, rel) === content } catch { return false }
    })

  it('★★★ 5分以内に1度保存したあとでも、外の版が新しい時点に残る。書く順は 読み直し → 退避 → 基準つきの書き込み', async () => {
    const p = put('a.txt', 'base')
    const store = makeStore([tab(p, { content: 'mine1' })])
    // 1回目の保存（普通に通る）。ここで「編集を始める前」の時点ができる
    expect((await saveTab(store.deps, p, 'mine1')).ok).toBe(true)
    // 外で書き換わり、自分の編集の保存は止まる（同じ時点の2回目の退避は残らない）
    fs.writeFileSync(p, 'external')
    clock += 60_000
    store.list = store.list.map(f => ({ ...f, content: 'mine2', isDirty: true }))
    expect((await saveTab(store.deps, p, 'mine2')).ok).toBe(false)
    expect(store.of(p).syncMark).toBe('changed')
    expect(snapshotsWith('a.txt', 'external')).toHaveLength(0)

    calls = []
    clock += 60_000
    const r = await keepMyEdit(keepDeps(store), p)
    expect(r.ok).toBe(true)
    expect(calls).toEqual(['readFile a.txt', 'snapshot a.txt', 'writeFileIfUnchanged a.txt expected="external"'])
    expect(view(p)).toBe('mine2')
    expect(snapshotsWith('a.txt', 'external')).toHaveLength(1)
    // 最初の時点（編集を始める前の base）も残っている
    expect(snapshotsWith('a.txt', 'base')).toHaveLength(1)
    expect(store.of(p).syncMark).toBeUndefined()
    expect(store.of(p).diskContent).toBe('mine2')
    expect(store.of(p).isDirty).toBe(false)
  })

  it('★★ 2回目以降の衝突でも毎回、その時点の外の版が残る（止めた保存では残らず、「自分の編集を保存する」で残る）', async () => {
    const p = put('a.txt', 'base')
    const store = makeStore([tab(p, { content: 'mine0' })])
    expect((await saveTab(store.deps, p, 'mine0')).ok).toBe(true) // 編集を始める前の時点ができる
    for (const [ext, mine] of [['external1', 'mine1'], ['external2', 'mine2']] as const) {
      fs.writeFileSync(p, ext)
      clock += 60_000
      store.list = store.list.map(f => ({ ...f, content: mine, isDirty: true }))
      expect((await saveTab(store.deps, p, mine)).ok).toBe(false)
      expect(snapshotsWith('a.txt', ext), `${ext} は止めた保存では残らない`).toHaveLength(0)
      clock += 60_000
      expect((await keepMyEdit(keepDeps(store), p)).ok).toBe(true)
      expect(view(p)).toBe(mine)
      expect(snapshotsWith('a.txt', ext), ext).toHaveLength(1)
    }
  })

  it('★★ 読み直したあとにさらに外で変わったら、書かない（その版を上書きで消さない）。帯に戻り、その版は履歴に残る', async () => {
    const p = put('a.txt', 'base')
    const store = makeStore([tab(p)])
    fs.writeFileSync(p, 'external1')
    expect((await saveTab(store.deps, p, 'mine')).ok).toBe(false)
    afterRead = () => { fs.writeFileSync(p, 'external2'); afterRead = undefined }
    clock += 60_000
    const r = await keepMyEdit(keepDeps(store), p)
    expect(r).toEqual({ ok: false, reason: 'changed' })
    expect(view(p)).toBe('external2')
    expect(store.of(p).syncMark).toBe('changed')
    expect(store.of(p).content).toBe('mine')
    expect(snapshotsWith('a.txt', 'external2')).toHaveLength(1)
    // もう一度押せば、いまの外の版を読み直して書ける
    clock += 60_000
    const again = await keepMyEdit(keepDeps(store), p)
    expect(again.ok).toBe(true)
    expect(view(p)).toBe('mine')
  })

  it('★ 読み直せない回（消えた・読めない）は、基準を変えずふつうの保存へ進み、主の口が理由を言い分けて止める', async () => {
    for (const state of ['missing', 'unreadable'] as const) {
      calls = []
      const { p, store, before } = openThenExternal(state, true)
      const r = await keepMyEdit(keepDeps(store), p)
      expect(r, state).toEqual({ ok: false, reason: state })
      expect(view(p), state).toBe(before)
      expect(store.of(p).syncMark, state).toBe(state)
      expect(store.of(p).diskContent, state).toBe('base')
      expect(calls.filter(c => c.startsWith('writeFile ')), state).toEqual([])
      fs.rmSync(p, { recursive: true, force: true })
    }
  })

  it('閉じたタブには何もしない', async () => {
    const p = put('a.txt', 'base')
    const store = makeStore([])
    const r = await keepMyEdit(keepDeps(store), p)
    expect(r).toEqual({ ok: false, reason: 'closed' })
    expect(calls).toEqual([])
  })
})

// ── 帯の操作: 自分の内容で作り直す ───────────────────────────────────────

describe('recreateTab: 無いときだけ書く', () => {
  it('★ 外で消えたタブは、自分の内容で作り直す（基準 null の1回だけ。履歴にも古い口にも触れない）。親フォルダごと消えていても作る', async () => {
    const p = put('sub/dir/a.txt', 'base')
    const store = makeStore([tab(p, { syncMark: 'missing' })])
    fs.rmSync(path.join(proj, 'sub'), { recursive: true })
    const r = await recreateTab(store.deps, p)
    expect(r.ok).toBe(true)
    expect(calls).toEqual(['writeFileIfUnchanged a.txt expected=null'])
    expect(view(p)).toBe('mine')
    expect(store.of(p).syncMark).toBeUndefined()
    expect(store.of(p).diskContent).toBe('mine')
    expect(store.of(p).isDirty).toBe(false)
  })

  it('★★ その間に外で作られていたら、上書きしない。衝突の帯に戻る', async () => {
    const p = put('a.txt', 'base')
    const store = makeStore([tab(p, { syncMark: 'missing' })])
    fs.rmSync(p)
    fs.writeFileSync(p, 'created by someone')
    const r = await recreateTab(store.deps, p)
    expect(r).toEqual({ ok: false, reason: 'changed' })
    expect(view(p)).toBe('created by someone')
    expect(store.of(p).syncMark).toBe('changed')
    expect(store.of(p).content).toBe('mine')
  })

  it('作ろうとして読めなかった回（そこにフォルダがある）は書かず、読めない印になる', async () => {
    const p = put('a.txt', 'base')
    const store = makeStore([tab(p, { syncMark: 'missing' })])
    fs.rmSync(p)
    fs.mkdirSync(p)
    const r = await recreateTab(store.deps, p)
    expect(r).toEqual({ ok: false, reason: 'unreadable' })
    expect(view(p)).toBe('<フォルダ>')
    expect(store.of(p).syncMark).toBe('unreadable')
  })

  it('★ 「消えた」の印のないタブには何もしない（ほかの印・印なしでは、主の口にも触れない）', async () => {
    for (const mark of [undefined, 'changed', 'unreadable'] as const) {
      calls = []
      const p = put('a.txt', 'base')
      const store = makeStore([tab(p, mark ? { syncMark: mark } : {})])
      fs.rmSync(p)
      const r = await recreateTab(store.deps, p)
      expect(r, String(mark)).toEqual({ ok: false, reason: 'closed' })
      expect(calls, String(mark)).toEqual([])
      expect(view(p), String(mark)).toBe('<無い>')
    }
  })
})

// ── 帯の操作: 外の内容を読み込む ─────────────────────────────────────────

describe('reloadTabFromDisk: ディスクの中身と基準で置き換える', () => {
  it('外で書き換わったタブは、外の中身・基準で置き換わり、印も未保存の印も外れる', async () => {
    const p = put('a.txt', 'base')
    const store = makeStore([tab(p, { syncMark: 'changed' })])
    fs.writeFileSync(p, 'external')
    expect(await reloadTabFromDisk(store.deps, p)).toBe(true)
    const t = store.of(p)
    expect(t.content).toBe('external')
    expect(t.diskContent).toBe('external')
    expect(t.isDirty).toBe(false)
    expect(t.syncMark).toBeUndefined()
    expect(view(p)).toBe('external')
    expect(autosaveTargets(store.list)).toEqual([])
  })

  it('★ 読めなかった回は、編集を捨てずにそのまま残し、消えたのか読めないのかを印にする', async () => {
    for (const state of ['missing', 'unreadable'] as const) {
      const { p, store, before } = openThenExternal(state)
      expect(await reloadTabFromDisk(store.deps, p), state).toBe(false)
      expect(store.of(p).syncMark, state).toBe(state)
      expect(store.of(p).content, state).toBe('mine')
      expect(store.of(p).isDirty, state).toBe(true)
      expect(view(p), state).toBe(before)
      fs.rmSync(p, { recursive: true, force: true })
    }
  })

  it('★★ 読めなかった理由の言い分けは main の分類（readCheck）に従う。親がファイルで道が通らない（ENOTDIR）回は「消えた」でなく「読めない」', async () => {
    const parent = put('notdir', 'x') // ファイル。その下のパスは existsSync では false になる
    const p = path.join(parent, 'a.txt')
    const store = makeStore([tab(p, { content: 'mine', diskContent: 'base' })])
    expect(fs.existsSync(p)).toBe(false)
    expect(await reloadTabFromDisk(store.deps, p)).toBe(false)
    expect(calls).toContain('readCheck a.txt')
    expect(store.of(p).syncMark).toBe('unreadable')
    expect(store.of(p).content).toBe('mine')
    expect(store.of(p).isDirty).toBe(true)
  })

  it('ファイルが無い（ENOENT）回だけが「消えた」。分類を聞けなかった回は「読めない」側', async () => {
    const gone = at('gone.txt')
    const store = makeStore([tab(gone)])
    expect(await reloadTabFromDisk(store.deps, gone)).toBe(false)
    expect(store.of(gone).syncMark).toBe('missing')
    const failing = makeStore([tab(gone)])
    window.electronAPI.fs.readCheck = async () => { throw new Error('ipc') }
    expect(await reloadTabFromDisk(failing.deps, gone)).toBe(false)
    expect(failing.of(gone).syncMark).toBe('unreadable')
  })

  it('読み直している間にタブが閉じられても、開き直さない', async () => {
    const p = put('a.txt', 'base')
    const store = makeStore([])
    expect(await reloadTabFromDisk(store.deps, p)).toBe(true)
    expect(store.list).toEqual([])
  })
})
