import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeFileIfUnchangedFs } from '../src/main/writeIfUnchangedFs'
import {
  loadOpenFile, loadOpenFiles, upsertLoaded, afterAiWrite, reloadOpenFiles, applyReloaded,
  readSaveOutcome, settleSave, saveTab, hasUnsaved, type OpenFile, type SaveDeps,
} from '../src/renderer/editorTabs'

// ── エディタのタブの基準（diskContent）と保存の配線（renderer/editorTabs.ts）──
// 守るもの: 外で書き換わったファイルを、タブの古い中身で上書きしない。
// 基準（最後に読んだ・書いた中身）を作る・進める6系統（読み込み・保存・AI の反映・AI が書いたファイルの表示・履歴からの復元・タブの復元）が
// どれも基準を更新すること、保存が基準を main に渡し、外で変わっていれば書かずに印を立てることを、
// 本物の一時フォルダと、main の本物の「変わっていなければ書く」口（writeIfUnchangedFs）に流して、呼ばれた要求の一覧とディスクの前後で見る。

let dir = ''
let calls: string[]
let writeArgs: Array<{ path: string; content: string; expected: string | null }>
/** `fs:writeFileIfUnchanged` の答えを差し替える（undefined なら本物の口に流す）。 */
let ipcOverride: ((path: string, content: string, expected: string | null) => unknown) | undefined
/** 本物の口が書き終えたあと、答えが返る前に走らせる（書いている間に起きることを再現する）。 */
let afterWrite: (() => void) | undefined

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koto-tabs-')))
  calls = []
  writeArgs = []
  ipcOverride = undefined
  afterWrite = undefined
  vi.stubGlobal('window', {
    electronAPI: {
      fs: {
        readFile: async (p: string) => { calls.push(`readFile ${path.basename(p)}`); return fs.readFileSync(p, 'utf-8') },
        readFileBase64: async (p: string) => { calls.push(`readFileBase64 ${path.basename(p)}`); return fs.readFileSync(p).toString('base64') },
        // 保存が直に書く古い口。保存の経路では 0 回であること
        writeFile: async (p: string) => { calls.push(`writeFile ${path.basename(p)}`) },
        writeFileIfUnchanged: async (p: string, content: string, expected: string | null) => {
          calls.push(`writeFileIfUnchanged ${path.basename(p)}`)
          writeArgs.push({ path: p, content, expected })
          if (ipcOverride) return ipcOverride(p, content, expected)
          const r = writeFileIfUnchangedFs(p, content, expected)
          afterWrite?.()
          return r
        },
      },
    },
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  try { fs.chmodSync(path.join(dir, 'a.txt'), 0o644) } catch { /* 無い */ }
  fs.rmSync(dir, { recursive: true, force: true })
})

const at = (name: string) => path.join(dir, name)
const put = (name: string, content: string): string => { const p = at(name); fs.writeFileSync(p, content); return p }
const disk = (name: string) => fs.readFileSync(at(name), 'utf-8')
const canTestPermissions = typeof process.getuid === 'function' && process.getuid() !== 0

function tab(p: string, over: Partial<OpenFile> = {}): OpenFile {
  const content = over.content ?? 'x'
  return { path: p, name: path.basename(p), content, isDirty: false, language: 'plaintext', diskContent: content, ...over }
}

/** App が持つタブの一覧の代わり。保存の処理から見える口（SaveDeps）をそのまま満たす。 */
function makeStore(initial: OpenFile[]) {
  const store = {
    list: initial,
    snapshots: [] as string[],
    deps: undefined as unknown as SaveDeps,
    update(fn: (prev: OpenFile[]) => OpenFile[]) { store.list = fn(store.list) },
    of(p: string) { return store.list.find(f => f.path === p)! },
  }
  store.deps = {
    getFiles: () => store.list,
    updateFiles: fn => store.update(fn),
    beforeWrite: async (p: string, c: string) => { calls.push(`snapshot ${path.basename(p)}`); store.snapshots.push(c) },
  }
  return store
}

describe('基準を作る・進める6系統（どれも diskContent がディスクの中身になる）', () => {
  it('1. 読み込み loadOpenFile: 読んだ中身が content と diskContent の両方に入る。未保存の印も止めた印も無い', async () => {
    const p = put('a.txt', 'こんにちは\n')
    const f = await loadOpenFile(p)
    expect(f).toEqual({ path: p, name: 'a.txt', content: 'こんにちは\n', isDirty: false, language: 'plaintext', diskContent: 'こんにちは\n' })
    expect(f.syncMark).toBeUndefined()
    expect(calls).toEqual(['readFile a.txt'])
  })

  it('1b. 読み込み: 画像は data URL で、基準は表示用の中身と同じ（画像は書かない）', async () => {
    const p = put('pic.png', 'PNGDATA')
    const f = await loadOpenFile(p)
    expect(f.language).toBe('image')
    expect(f.content).toBe(`data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}`)
    expect(f.diskContent).toBe(f.content)
  })

  it('1c. 読み込み: 読めなければ投げる（基準を作れないタブは作らない）', async () => {
    await expect(loadOpenFile(at('none.txt'))).rejects.toThrow()
  })

  it('2. 保存 saveTab: 書けたら基準が書いた中身に進み、未保存の印が戻る', async () => {
    const p = put('a.txt', 'v1')
    const s = makeStore([tab(p, { content: 'v2', isDirty: true, diskContent: 'v1' })])
    expect(await saveTab(s.deps, p, 'v2')).toEqual({ ok: true })
    expect(disk('a.txt')).toBe('v2')
    expect(s.of(p)).toMatchObject({ content: 'v2', isDirty: false, diskContent: 'v2' })
    expect(s.of(p).syncMark).toBeUndefined()
  })

  it('3. AI の反映 afterAiWrite: 開いているタブは中身と基準を書いた中身にし、止めた印を外す。開いていなければ基準つきで足す', () => {
    const p = at('a.txt')
    const marked = tab(p, { content: '自分の編集', isDirty: true, diskContent: '古い', syncMark: 'changed' })
    const next = afterAiWrite([marked], p, 'AIの中身')
    expect(next).toEqual([{ path: p, name: 'a.txt', content: 'AIの中身', isDirty: false, language: 'plaintext', diskContent: 'AIの中身' }])
    expect('syncMark' in next[0]).toBe(false)

    const added = afterAiWrite(next, at('b.html'), '<p>b</p>')
    expect(added[1]).toEqual({ path: at('b.html'), name: 'b.html', content: '<p>b</p>', isDirty: false, language: 'html', diskContent: '<p>b</p>' })
    expect(added[0]).toBe(next[0])
  })

  it('4. AI が書いたファイルの表示 upsertLoaded: 未保存の編集が無いタブは、読み直したタブ（基準つき）で置き換える。開いていなければ末尾に足す', async () => {
    const p = put('a.txt', 'AIが書いた')
    const clean = tab(p, { content: '古い', diskContent: '古い', syncMark: 'missing' })
    const other = tab(at('o.txt'), { content: 'o' })
    const loaded = await loadOpenFile(p)
    const replaced = upsertLoaded([other, clean], loaded)
    expect(replaced).toEqual([other, loaded])
    expect(replaced[1]).toMatchObject({ content: 'AIが書いた', diskContent: 'AIが書いた', isDirty: false })
    expect(replaced[1].syncMark).toBeUndefined()
    expect(upsertLoaded([other], loaded)).toEqual([other, loaded])
  })

  it('4b. ★★★ upsertLoaded: 未保存の編集があるタブは、AI が書いても捨てない。外で変わった印を立てて残す（表）', async () => {
    const p = put('a.txt', 'AIが書いた')
    const loaded = await loadOpenFile(p)
    const cases: Array<{ name: string; current: OpenFile; expected: OpenFile }> = [
      {
        name: '印なし・基準と違う版をディスクに書かれた → 編集も基準もそのまま、印だけ立つ',
        current: tab(p, { content: '自分の編集', isDirty: true, diskContent: '古い' }),
        expected: tab(p, { content: '自分の編集', isDirty: true, diskContent: '古い', syncMark: 'changed' }),
      },
      {
        name: 'すでに印がある（保存を止めたあと）→ 同じタブのまま（編集は画面の中だけにある）',
        current: tab(p, { content: '自分の編集', isDirty: true, diskContent: '古い', syncMark: 'changed' }),
        expected: tab(p, { content: '自分の編集', isDirty: true, diskContent: '古い', syncMark: 'changed' }),
      },
      {
        name: '消えた印のあるタブにも、編集があれば捨てずに衝突の印にする',
        current: tab(p, { content: '自分の編集', isDirty: true, diskContent: '古い', syncMark: 'missing' }),
        expected: tab(p, { content: '自分の編集', isDirty: true, diskContent: '古い', syncMark: 'changed' }),
      },
      {
        name: 'ディスクが基準のまま（何も変わっていない）→ 編集はそのまま。止めた印は外す',
        current: tab(p, { content: '自分の編集', isDirty: true, diskContent: 'AIが書いた', syncMark: 'changed' }),
        expected: tab(p, { content: '自分の編集', isDirty: true, diskContent: 'AIが書いた' }),
      },
      {
        name: 'ディスクがすでに自分の編集と同じ → 読み直したタブ（保存済み）に置き換わる',
        current: tab(p, { content: 'AIが書いた', isDirty: true, diskContent: '古い', syncMark: 'changed' }),
        expected: loaded,
      },
    ]
    for (const c of cases) {
      const other = tab(at('o.txt'), { content: 'o' })
      expect(upsertLoaded([other, c.current], loaded), c.name).toEqual([other, c.expected])
    }
  })

  it('4c. upsertLoaded: 画像のタブは編集しないので、いつも読み直したタブで置き換える', async () => {
    const p = put('a.txt', 'x')
    const loaded: OpenFile = { path: p, name: 'a.png', content: 'data:image/png;base64,AA', isDirty: false, language: 'image', diskContent: 'data:image/png;base64,AA' }
    const stale: OpenFile = { ...loaded, content: 'data:image/png;base64,BB', diskContent: 'data:image/png;base64,BB', isDirty: true }
    expect(upsertLoaded([stale], loaded)).toEqual([loaded])
  })

  it('5. 履歴からの復元 reloadOpenFiles + applyReloaded: 復元されたタブは読み直した中身と基準になる。消えたファイルのタブは閉じる。ほかは触らない', async () => {
    const restored = put('a.txt', '復元された中身')
    const untouched = put('b.txt', 'b')
    const gone = at('gone.txt')
    const files = [
      tab(restored, { content: '古い中身', diskContent: '古い中身' }),
      tab(untouched, { content: 'b' }),
      tab(gone, { content: 'g' }),
    ]
    const reloaded = await reloadOpenFiles(files, new Set([restored]))
    expect([...reloaded.keys()]).toEqual([restored])
    const next = applyReloaded(files, new Set([gone]), reloaded)
    expect(next.map(f => f.path)).toEqual([restored, untouched])
    expect(next[0]).toMatchObject({ content: '復元された中身', diskContent: '復元された中身', isDirty: false })
    expect(next[1]).toBe(files[1])
  })

  it('5a. ★★★ 履歴からの復元: 未保存の編集があるタブは、復元でも消えたファイルでも捨てない（復元は外で変わった印、消えたら消えた印で残す）', async () => {
    const restored = put('a.txt', '復元された中身')
    const gone = at('gone.txt')
    const files = [
      tab(restored, { content: '編集中', isDirty: true, diskContent: '復元前' }),
      tab(gone, { content: '消えるファイルの編集', isDirty: true, diskContent: 'g' }),
    ]
    const reloaded = await reloadOpenFiles(files, new Set([restored]))
    const next = applyReloaded(files, new Set([gone]), reloaded)
    expect(next).toEqual([
      tab(restored, { content: '編集中', isDirty: true, diskContent: '復元前', syncMark: 'changed' }),
      tab(gone, { content: '消えるファイルの編集', isDirty: true, diskContent: 'g', syncMark: 'missing' }),
    ])
  })

  it('5b. 履歴からの復元: 読み直せなかったタブは据え置き（基準も古いまま）。次の保存は外の変更として止まり、ディスクを上書きしない', async () => {
    const p = put('a.txt', '復元された中身')
    const stale = tab(p, { content: '編集中', isDirty: true, diskContent: '復元前' })
    fs.chmodSync(p, 0o000)
    if (canTestPermissions) {
      const reloaded = await reloadOpenFiles([stale], new Set([p]))
      expect(reloaded.size).toBe(0)
      expect(applyReloaded([stale], new Set(), reloaded)[0]).toBe(stale)
    }
    fs.chmodSync(p, 0o644)
    const s = makeStore([stale])
    expect(await saveTab(s.deps, p, '編集中')).toEqual({ ok: false, reason: 'changed' })
    expect(disk('a.txt')).toBe('復元された中身')
  })

  it('6. タブの復元 loadOpenFiles: 順に読み、読めないもの（移動・削除）は飛ばす。それぞれ基準つき', async () => {
    const a = put('a.txt', 'A')
    const b = put('b.txt', 'B')
    const files = await loadOpenFiles([a, at('missing.txt'), b])
    expect(files.map(f => [f.path, f.content, f.diskContent])).toEqual([[a, 'A', 'A'], [b, 'B', 'B']])
  })
})

describe('saveTab: 基準を渡して書く。外で変わっていれば書かずに印を立てる（本物の一時フォルダ）', () => {
  it('★ 普通の保存: 退避 → 基準つきの口の順に1回ずつ呼ぶ。古い口（writeFile）は0回。基準は開いたときの中身', async () => {
    const p = put('a.txt', 'v1')
    const s = makeStore([tab(p, { content: 'v2', isDirty: true, diskContent: 'v1' })])
    await saveTab(s.deps, p, 'v2')
    expect(calls).toEqual(['readFile a.txt', 'snapshot a.txt', 'writeFileIfUnchanged a.txt'])
    expect(writeArgs).toEqual([{ path: p, content: 'v2', expected: 'v1' }])
    expect(s.snapshots).toEqual(['v2'])
    expect(disk('a.txt')).toBe('v2')
  })

  it('★★ 外で書き換わったあとの保存: 書き込みは0回（ディスクは外の版のまま）。印が立ち、編集も基準も未保存の印もそのまま', async () => {
    const p = put('a.txt', 'v1')
    const s = makeStore([tab(p, { content: '自分の編集', isDirty: true, diskContent: 'v1' })])
    fs.writeFileSync(p, '外で書いた') // 端末・git などが書き換えた
    const before = disk('a.txt')
    expect(await saveTab(s.deps, p, '自分の編集')).toEqual({ ok: false, reason: 'changed' })
    expect(disk('a.txt')).toBe(before)
    expect(disk('a.txt')).toBe('外で書いた')
    expect(calls.filter(c => c.startsWith('writeFile '))).toEqual([])
    expect(s.of(p)).toEqual({ ...tab(p, { content: '自分の編集', isDirty: true, diskContent: 'v1' }), syncMark: 'changed' })
  })

  it('★★ 外で消えたあとの保存: 作り直さない（ファイルは無いまま）。印は missing', async () => {
    const p = put('a.txt', 'v1')
    const s = makeStore([tab(p, { content: '編集', isDirty: true, diskContent: 'v1' })])
    fs.rmSync(p)
    expect(await saveTab(s.deps, p, '編集')).toEqual({ ok: false, reason: 'missing' })
    expect(fs.existsSync(p)).toBe(false)
    expect(s.of(p)).toMatchObject({ isDirty: true, content: '編集', diskContent: 'v1', syncMark: 'missing' })
  })

  it.skipIf(!canTestPermissions)('★★ 読めないファイルへの保存: 書かない。印は unreadable（missing に倒さない）', async () => {
    const p = put('a.txt', 'v1')
    const s = makeStore([tab(p, { content: '編集', isDirty: true, diskContent: 'v1' })])
    fs.chmodSync(p, 0o000)
    expect(await saveTab(s.deps, p, '編集')).toEqual({ ok: false, reason: 'unreadable' })
    fs.chmodSync(p, 0o644)
    expect(disk('a.txt')).toBe('v1')
    expect(s.of(p)).toMatchObject({ isDirty: true, syncMark: 'unreadable' })
  })

  it('止めた答え3つの表（主の口が返した理由が、そのまま印になる。書き込みの要求は1回だけ）', async () => {
    for (const reason of ['changed', 'missing', 'unreadable'] as const) {
      writeArgs = []
      ipcOverride = () => ({ ok: false, reason })
      const p = at('t.txt')
      const s = makeStore([tab(p, { content: 'e', isDirty: true, diskContent: 'd' })])
      expect(await saveTab(s.deps, p, 'e')).toEqual({ ok: false, reason })
      expect(writeArgs).toHaveLength(1)
      expect(s.of(p)).toMatchObject({ isDirty: true, diskContent: 'd', content: 'e', syncMark: reason })
    }
  })

  it('★★★ 不明な答え（形違い・知らない理由・ok が真でない）は「書けた」と読まない: 未保存のまま・基準は進まず・印は unreadable', async () => {
    const unknowns: unknown[] = [undefined, null, {}, 'ok', 1, { ok: 'yes' }, { ok: 1 }, { ok: false }, { ok: false, reason: 'weird' }]
    for (const raw of unknowns) {
      ipcOverride = () => raw
      const p = at('t.txt')
      const s = makeStore([tab(p, { content: 'e', isDirty: true, diskContent: 'd' })])
      const r = await saveTab(s.deps, p, 'e')
      expect(r.ok, JSON.stringify(raw)).toBe(false)
      expect(s.of(p), JSON.stringify(raw)).toMatchObject({ isDirty: true, diskContent: 'd', content: 'e' })
      expect(s.of(p).syncMark, JSON.stringify(raw)).toBe('unreadable')
    }
  })

  it('★★★ 書いている間に打った文字は、保存済みに見せない: 未保存のまま残り、中身は戻さない。基準は書いた中身に進む', async () => {
    const p = put('a.txt', 'v1')
    const s = makeStore([tab(p, { content: 'v2', isDirty: true, diskContent: 'v1' })])
    // 書いている間（main が書き終えたあと答えが返る前）に、利用者がさらに打つ
    afterWrite = () => s.update(fs2 => fs2.map(f => f.path === p ? { ...f, content: 'v2+打った', isDirty: true } : f))
    await saveTab(s.deps, p, 'v2')
    expect(disk('a.txt')).toBe('v2')
    expect(s.of(p)).toMatchObject({ content: 'v2+打った', isDirty: true, diskContent: 'v2' })
    // 次の保存は、書いた中身を基準にして続けて通る（外の変更と取り違えない）
    afterWrite = undefined
    expect(await saveTab(s.deps, p, 'v2+打った')).toEqual({ ok: true })
    expect(writeArgs.map(a => a.expected)).toEqual(['v1', 'v2'])
    expect(disk('a.txt')).toBe('v2+打った')
    expect(s.of(p)).toMatchObject({ isDirty: false, diskContent: 'v2+打った' })
  })

  it('★★ 続けて2回保存を頼んでも、2回目は1回目の結果を基準にする（外の変更と取り違えて止めない）', async () => {
    const p = put('a.txt', 'v1')
    const s = makeStore([tab(p, { content: 'v3', isDirty: true, diskContent: 'v1' })])
    const first = saveTab(s.deps, p, 'v2')
    const second = saveTab(s.deps, p, 'v3')
    expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }])
    expect(writeArgs.map(a => [a.content, a.expected])).toEqual([['v2', 'v1'], ['v3', 'v2']])
    expect(disk('a.txt')).toBe('v3')
    expect(s.of(p)).toMatchObject({ isDirty: false, diskContent: 'v3' })
    expect(s.of(p).syncMark).toBeUndefined()
  })

  it('保存の間に別の読み込みで基準が進んでいたら、その読み込みを優先する（古い答えで基準を巻き戻さない）', async () => {
    const p = put('a.txt', 'v1')
    const s = makeStore([tab(p, { content: 'v2', isDirty: true, diskContent: 'v1' })])
    afterWrite = () => s.update(files => afterAiWrite(files, p, 'AIの版'))
    await saveTab(s.deps, p, 'v2')
    expect(s.of(p)).toEqual(tab(p, { content: 'AIの版', diskContent: 'AIの版' }))
  })

  it('保存の間にタブが閉じられた回: 書かない。closed を返す', async () => {
    const p = put('a.txt', 'v1')
    const s = makeStore([])
    expect(await saveTab(s.deps, p, 'v2')).toEqual({ ok: false, reason: 'closed' })
    expect(writeArgs).toEqual([])
    expect(disk('a.txt')).toBe('v1')
  })

  it('書くのに失敗した（口が例外を投げた）回は今までどおり例外のまま。タブは変えず、次の保存は通る', async () => {
    const p = put('a.txt', 'v1')
    const s = makeStore([tab(p, { content: 'v2', isDirty: true, diskContent: 'v1' })])
    ipcOverride = () => { throw new Error('EACCES') }
    await expect(saveTab(s.deps, p, 'v2')).rejects.toThrow('EACCES')
    expect(s.of(p)).toEqual(tab(p, { content: 'v2', isDirty: true, diskContent: 'v1' }))
    ipcOverride = undefined
    expect(await saveTab(s.deps, p, 'v2')).toEqual({ ok: true })
    expect(disk('a.txt')).toBe('v2')
  })

  it('★★ 書くものが無いタブ（未保存の編集も止めた印も無い）には何も頼まない。外で変わっていても、帯も履歴も出さない', async () => {
    const p = put('a.txt', 'v1')
    const s = makeStore([tab(p, { content: 'v1', diskContent: 'v1' })])
    fs.writeFileSync(p, '外で書いた') // git pull などが書き換えた。タブに編集は無い
    expect(await saveTab(s.deps, p, 'v1')).toEqual({ ok: true })
    expect(calls).toEqual([])
    expect(disk('a.txt')).toBe('外で書いた')
    expect(s.of(p)).toEqual(tab(p, { content: 'v1', diskContent: 'v1' }))
  })

  it('hasUnsaved: 未保存の編集があるか、止めた印があれば保存するものがある（知らない印も「ある」側）', () => {
    expect(hasUnsaved({ isDirty: false })).toBe(false)
    expect(hasUnsaved({ isDirty: true })).toBe(true)
    for (const mark of ['changed', 'missing', 'unreadable'] as const) expect(hasUnsaved({ isDirty: false, syncMark: mark })).toBe(true)
    expect(hasUnsaved({ isDirty: false, syncMark: 'weird' as unknown as 'changed' })).toBe(true)
  })

  it('★★ 印のある（未保存でない）タブには、保存の口を通す（「もう一度保存する」が効く）', async () => {
    const p = put('a.txt', 'v1')
    const s = makeStore([tab(p, { content: 'v1', diskContent: 'v1', syncMark: 'unreadable' })])
    expect(await saveTab(s.deps, p, 'v1')).toEqual({ ok: true })
    expect(calls).toEqual(['readFile a.txt', 'snapshot a.txt', 'writeFileIfUnchanged a.txt'])
    expect(s.of(p).syncMark).toBeUndefined()
  })

  it('★ 順序: 退避が先、書くのはあと（退避は書く前の中身を残すため）', async () => {
    const p = put('a.txt', 'v1')
    const s = makeStore([tab(p, { content: 'v2', isDirty: true, diskContent: 'v1' })])
    await saveTab(s.deps, p, 'v2')
    expect(calls.indexOf('snapshot a.txt')).toBeGreaterThanOrEqual(0)
    expect(calls.indexOf('snapshot a.txt')).toBeLessThan(calls.indexOf('writeFileIfUnchanged a.txt'))
  })

  it('外の変更のあと、読み直して基準が進めば保存は通る（印は外れる）', async () => {
    const p = put('a.txt', 'v1')
    const s = makeStore([tab(p, { content: '編集', isDirty: true, diskContent: 'v1' })])
    fs.writeFileSync(p, '外で書いた')
    await saveTab(s.deps, p, '編集')
    expect(s.of(p).syncMark).toBe('changed')
    s.update(files => files.map(f => f.path === p ? { ...f, diskContent: '外で書いた' } : f)) // 外の版を読み直した
    expect(await saveTab(s.deps, p, '編集')).toEqual({ ok: true })
    expect(disk('a.txt')).toBe('編集')
    expect(s.of(p).syncMark).toBeUndefined()
  })
})

describe('settleSave / readSaveOutcome', () => {
  it('★ 同じ印がすでにあれば一覧をそのまま返す（描き直しと自動保存のやり直しを起こさない）。違う印なら置き換える', () => {
    const p = at('a.txt')
    const files = [tab(p, { content: 'e', isDirty: true, diskContent: 'd' })]
    const once = settleSave(files, p, 'e', 'd', { ok: false, reason: 'changed' })
    expect(once).not.toBe(files)
    expect(once[0].syncMark).toBe('changed')
    expect(settleSave(once, p, 'e', 'd', { ok: false, reason: 'changed' })).toBe(once)
    expect(settleSave(once, p, 'e', 'd', { ok: false, reason: 'missing' })[0].syncMark).toBe('missing')
  })

  it('書けたら止めた印が外れる。ほかのタブは同じ物のまま', () => {
    const p = at('a.txt')
    const other = tab(at('o.txt'))
    const files = [other, tab(p, { content: 'e', isDirty: true, diskContent: 'd', syncMark: 'changed' })]
    const next = settleSave(files, p, 'e', 'd', { ok: true })
    expect(next[0]).toBe(other)
    expect(next[1]).toEqual(tab(p, { content: 'e', isDirty: false, diskContent: 'e' }))
    expect('syncMark' in next[1]).toBe(false)
  })

  it('★ 保存した中身とタブの中身が違えば未保存のまま（isDirty を無条件に戻さない）', () => {
    const p = at('a.txt')
    const files = [tab(p, { content: '保存後に打った', isDirty: true, diskContent: 'd' })]
    const next = settleSave(files, p, '保存した中身', 'd', { ok: true })
    expect(next[0]).toMatchObject({ content: '保存後に打った', isDirty: true, diskContent: '保存した中身' })
  })

  it('readSaveOutcome: ok が true のときだけ書けた。ほかは止めた側（知らない理由は unreadable）', () => {
    expect(readSaveOutcome({ ok: true })).toEqual({ ok: true })
    expect(readSaveOutcome({ ok: false, reason: 'changed', disk: 'x' })).toEqual({ ok: false, reason: 'changed' })
    expect(readSaveOutcome({ ok: false, reason: 'missing' })).toEqual({ ok: false, reason: 'missing' })
    expect(readSaveOutcome({ ok: false, reason: 'unreadable' })).toEqual({ ok: false, reason: 'unreadable' })
    for (const raw of [undefined, null, {}, { ok: 'true' }, { ok: 1 }, { ok: false }, { ok: false, reason: 'x' }, 'ok']) {
      expect(readSaveOutcome(raw), JSON.stringify(raw)).toEqual({ ok: false, reason: 'unreadable' })
    }
  })
})

// ── App.tsx の配線（ソースを読む。呼び出しの形ごと指し、直す前の形を not.toContain で禁じる）──
describe('App.tsx の配線: 保存は saveTab を通り、基準の更新は editorTabs.ts の関数を通る', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')
  const app = read('src/renderer/App.tsx')
  const code = app.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  const bodyOf = (src: string, head: string, tail: string) => {
    const a = src.indexOf(head)
    expect(a, head).toBeGreaterThanOrEqual(0)
    const b = src.indexOf(tail, a)
    expect(b, tail).toBeGreaterThan(a)
    return src.slice(a, b)
  }

  it('★★ saveFile は saveTab に、最新の一覧・一覧の更新・退避（saveDeps）を渡す1本だけ。直に writeFile を呼ばない', () => {
    const deps = bodyOf(code, 'const saveDeps = useMemo(', 'const saveFile')
    expect(deps).toContain('{ getFiles: () => openFilesRef.current, updateFiles: setOpenFiles, beforeWrite: snapshotBeforeManualSave }')
    const body = bodyOf(code, 'const saveFile = useCallback(', 'const keepMine')
    expect(body).toContain('saveTab(saveDeps, filePath, content)')
    expect(body).not.toContain('fs.writeFile(')
    expect(body).not.toContain('isDirty: false')
    expect(code).not.toContain('window.electronAPI.fs.writeFile(filePath, content)')
    expect(code).not.toContain('{ ...f, content, isDirty: false }')
  })

  it('★ 一覧の更新は最新の一覧（openFilesRef）に同期で当ててから state に渡す', () => {
    expect(code).toContain('const next = typeof update === \'function\' ? update(openFilesRef.current) : update')
    expect(code).toContain('openFilesRef.current = next\n    setOpenFilesState(next)')
    expect(code).toContain('const [openFiles, setOpenFilesState] = useState<OpenFile[]>([])')
    expect(code).not.toContain('const [openFiles, setOpenFiles] = useState')
  })

  it('★ 基準の6系統は editorTabs.ts の関数を呼ぶ（App.tsx に読み込み・組み立てを複製しない）', () => {
    expect(code).toContain("} from './editorTabs'")
    expect(code).not.toContain('async function loadOpenFile(')
    expect(code).not.toContain('function detectLanguage(')
    // AI の反映（applyAiFile）
    expect(code).toContain('setOpenFiles(prev => afterAiWrite(prev, full, content))')
    // AI が書いたファイルの表示（showAiFileInEditor）と、プロジェクト切替後に開くファイル
    expect(code.split('setOpenFiles(prev => upsertLoaded(prev, file))').length - 1).toBe(2)
    // 履歴からの復元（applyRestoreResult）
    expect(code).toContain('const reloaded = await reloadOpenFiles(openFiles, restoredAbs)')
    expect(code).toContain('setOpenFiles(prev => applyReloaded(prev, deletedAbs, reloaded))')
    // タブの復元（起動時・プロジェクト切替）
    expect(code).toContain('const files = await loadOpenFiles(paths ?? [])')
    expect(code).toContain('files.push(...await loadOpenFiles(parsed.paths ?? []))')
    // 直す前の形（その場で組み立てる）を残さない
    expect(code).not.toContain('{ ...f, content, isDirty: false } : f)')
    expect(code).not.toContain("language: detectLanguage(name) }]")
    expect(code).not.toContain('files.push(await loadOpenFile(p))')
  })

  it('applyAiFile の書き込みは、利用者が押した明示の書き込みとして直に書く（基準では確かめない）。そのあと基準を進める', () => {
    const body = bodyOf(code, 'const applyAiFile = useCallback(', 'const showAiFileInEditor')
    expect(body).toContain('await window.electronAPI.fs.writeFile(full, content)')
    expect(body).toContain('afterAiWrite(prev, full, content)')
  })
})
