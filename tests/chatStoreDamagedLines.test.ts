import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { projectChatPath } from '../src/main/chatStore/paths'
import { loadProjectChatFile, saveProjectChatFile, resetChatLogCache } from '../src/main/chatStore/file'

// ── 途中の壊れた行・書きかけの末尾・読まずに書く入口（0.6.26）────────────────────────────────────────
// v2 の記録は、途中の1行が壊れると、その後ろの行を「穴を開けない」決まりで全部捨てる。それでも「読めた」と
// 見なすと、写しを作らないまま最初の書き込みで元の記録を失う。書きかけで切れた末尾の行の後ろへ追記すると、
// その行が壊れた1行になり、それより後の記録が次の起動で全部捨てられる。読まずに書く入口でも、読めない記録を
// 写しなしに置き換えない。本物の一時フォルダで、返り値とフォルダの前後を見る。

const STAMP_NAME = 'chat.json.broken-20261103-142530'
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

const msg = (content: string) => ({ role: 'user', content })
const rec = (i: number, content: string) => `{"i":${i},"m":{"role":"user","content":${JSON.stringify(content)}}}`
const json = (...contents: string[]) => JSON.stringify(contents.map(msg))

let dir = ''
let file = ''
const side = () => path.dirname(file)
const names = () => fs.readdirSync(side()).sort()
const copyNames = () => names().filter((n) => n.startsWith('chat.json.broken-'))
const put = (content: string) => {
  fs.mkdirSync(side(), { recursive: true })
  fs.writeFileSync(file, content)
}
const contentsOf = (r: ReturnType<typeof loadProjectChatFile>): string[] => {
  if (!r.ok || r.json === null) throw new Error('読めていない')
  return (JSON.parse(r.json) as Array<{ content: string }>).map((m) => m.content)
}
/** ファイルの全行が、改行で終わり、JSON として読める（壊れた行が混ざっていない）。 */
const wellFormed = (): boolean => {
  const text = fs.readFileSync(file, 'utf-8')
  if (!text.endsWith('\n')) return false
  return text.split('\n').filter((l) => l.trim() !== '').every((l) => {
    try { JSON.parse(l); return true } catch { return false }
  })
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-damaged-'))
  file = projectChatPath(dir)
  resetChatLogCache()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 3, 14, 25, 30))
})
afterEach(() => {
  vi.useRealTimers()
  try { fs.chmodSync(side(), 0o755) } catch { /* 無ければ何もしない */ }
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('途中の壊れた行を捨てた記録は、読めた分を返し、読めなかった側に数えて写しを残す', () => {
  it('先頭の行が壊れていて、後ろの大きな行が穴で捨てられる: 空に読めても写しを作り、70KB の本文を失わない', () => {
    const big = 'x'.repeat(70 * 1024)
    const original = ['{"v":2}', '{"i":0,"m":{"role":"user","content":"hel', rec(1, big), rec(2, 'c')].join('\n') + '\n'
    put(original)

    const r = loadProjectChatFile(file)

    expect(r).toEqual({ ok: true, json: '[]', unreadable: { backupName: STAMP_NAME } })
    expect(names()).toEqual(['chat.json', STAMP_NAME])
    expect(fs.readFileSync(path.join(side(), STAMP_NAME), 'utf-8')).toBe(original) // 70KB の本文が写しにある
    expect(fs.readFileSync(file, 'utf-8')).toBe(original) // 元はその場に残る
  })

  it('途中の行が壊れている: 手前の分は読め、後ろは捨てる。写しは元の記録と同じ中身', () => {
    const original = ['{"v":2}', rec(0, 'a'), '{"i":1,"m":{"role":"user","con', rec(2, 'c'), rec(3, 'd')].join('\n') + '\n'
    put(original)

    const r = loadProjectChatFile(file)

    expect(r).toEqual({ ok: true, json: JSON.stringify([msg('a')]), unreadable: { backupName: STAMP_NAME } })
    expect(fs.readFileSync(path.join(side(), STAMP_NAME), 'utf-8')).toBe(original)
  })

  it.each<[string, string]>([
    ['オブジェクトでない行（配列）', ['{"v":2}', rec(0, 'a'), '[1,2]', rec(1, 'b')].join('\n') + '\n'],
    ['i が整数でない行', ['{"v":2}', rec(0, 'a'), '{"i":0.5,"m":{"role":"user","content":"x"}}', rec(1, 'b')].join('\n') + '\n'],
    ['穴を開ける番号の行', ['{"v":2}', rec(0, 'a'), rec(5, 'far'), rec(1, 'b')].join('\n') + '\n'],
    ['n が不正な行', ['{"v":2}', rec(0, 'a'), '{"n":-1}', rec(1, 'b')].join('\n') + '\n'],
    ['改行で終わらない最後の行が、JSON として読めても穴を開ける番号（書きかけの末尾ではない）', ['{"v":2}', rec(0, 'a'), rec(5, 'far')].join('\n')],
  ])('%s を捨てた回も、読めなかった側に数えて写しを残す', (_label, original) => {
    put(original)
    const r = loadProjectChatFile(file)
    expect(r.ok && r.unreadable).toEqual({ backupName: STAMP_NAME })
    expect(fs.readFileSync(path.join(side(), STAMP_NAME), 'utf-8')).toBe(original)
  })

  it('同じ記録を2回読んでも、写しは1つ', () => {
    put(['{"v":2}', '壊れた行', rec(1, 'b')].join('\n') + '\n')
    loadProjectChatFile(file)
    const again = loadProjectChatFile(file)
    expect(again.ok && again.unreadable).toEqual({ backupName: STAMP_NAME })
    expect(copyNames()).toEqual([STAMP_NAME])
  })

  it('知らない種類のレコードとバージョン印の行は、読めているので数えない（写しを作らない）', () => {
    put(['{"v":2}', rec(0, 'a'), '{"future":1}', '{"v":3}', rec(1, 'b')].join('\n') + '\n')
    const r = loadProjectChatFile(file)
    expect(contentsOf(r)).toEqual(['a', 'b'])
    expect('unreadable' in r).toBe(false)
    expect(copyNames()).toEqual([])
  })

  it.skipIf(isRoot)('書けないフォルダで捨てた回は、写しを作れず backupName が null。読めた分は返す。元は変わらない', () => {
    const original = ['{"v":2}', rec(0, 'a'), '{壊れた', rec(2, 'c')].join('\n') + '\n'
    put(original)
    fs.chmodSync(side(), 0o555)

    const r = loadProjectChatFile(file)
    fs.chmodSync(side(), 0o755)

    expect(r).toEqual({ ok: true, json: JSON.stringify([msg('a')]), unreadable: { backupName: null } })
    expect(names()).toEqual(['chat.json'])
    expect(fs.readFileSync(file, 'utf-8')).toBe(original)
  })
})

describe('書きかけで切れた末尾は、読めた側（写しなし）。ただし cache せず、次の保存で書き直す', () => {
  it('末尾が切れた v2: unreadable は付かず写しも作らない。読んだあと [c] [d] と保存しても、c と d が次の起動で残る', () => {
    put(['{"v":2}', rec(0, 'a'), rec(1, 'b'), '{"i":2,"m":{"role":"user","con'].join('\n'))

    const loaded = loadProjectChatFile(file)
    expect(contentsOf(loaded)).toEqual(['a', 'b'])
    expect('unreadable' in loaded).toBe(false)
    expect(copyNames()).toEqual([])

    expect(saveProjectChatFile(file, json('a', 'b', 'c'))).toEqual({ ok: true })
    expect(wellFormed()).toBe(true) // 切れた行の後ろへ続けて書いていない（書き直しで切れた行は消える）
    expect(saveProjectChatFile(file, json('a', 'b', 'c', 'd'))).toEqual({ ok: true })
    expect(wellFormed()).toBe(true)

    resetChatLogCache() // 再起動
    expect(contentsOf(loadProjectChatFile(file))).toEqual(['a', 'b', 'c', 'd'])
    expect(copyNames()).toEqual([])
  })

  it('最後の行は完全だが本文が改行で終わっていない v2: 読めた側。次の保存で行が繋がって壊れない', () => {
    put(['{"v":2}', rec(0, 'a'), rec(1, 'b')].join('\n')) // 末尾の改行が無い
    const loaded = loadProjectChatFile(file)
    expect(contentsOf(loaded)).toEqual(['a', 'b'])
    expect('unreadable' in loaded).toBe(false)

    expect(saveProjectChatFile(file, json('a', 'b', 'c'))).toEqual({ ok: true })
    expect(wellFormed()).toBe(true)
    resetChatLogCache()
    expect(contentsOf(loadProjectChatFile(file))).toEqual(['a', 'b', 'c'])
    expect(copyNames()).toEqual([])
  })

  it('壊れた行を捨てた回も cache しない: 次の保存は書き直しで、捨てた行は消え、元の記録は写しに残る', () => {
    const original = ['{"v":2}', rec(0, 'a'), '{壊れた', rec(2, 'c')].join('\n') + '\n'
    put(original)
    loadProjectChatFile(file)

    expect(saveProjectChatFile(file, json('a', 'x'))).toEqual({ ok: true })

    expect(wellFormed()).toBe(true)
    expect(fs.readFileSync(path.join(side(), STAMP_NAME), 'utf-8')).toBe(original)
    resetChatLogCache()
    expect(contentsOf(loadProjectChatFile(file))).toEqual(['a', 'x'])
  })

  it('きれいに読めた v2（改行で終わり、捨てた行なし）は今までどおり cache し、追記で書く（書き直さない）', () => {
    put(['{"v":2}', rec(0, 'a')].join('\n') + '\n')
    loadProjectChatFile(file)
    const before = fs.readFileSync(file, 'utf-8')

    expect(saveProjectChatFile(file, json('a', 'b'))).toEqual({ ok: true })

    expect(fs.readFileSync(file, 'utf-8')).toBe(before + rec(1, 'b') + '\n') // 末尾への追記だけ
  })
})

describe('読まずに書く入口（saveProjectChatFile）も、読めない記録を写しなしに置き換えない', () => {
  it('壊れた chat.json に、読み込みを挟まず保存する: 先に写しを残してから置き換える', () => {
    const original = '会話の記録ではない文字列'
    put(original)

    expect(saveProjectChatFile(file, json('新しい会話'))).toEqual({ ok: true })

    expect(names()).toEqual(['chat.json', STAMP_NAME])
    expect(fs.readFileSync(path.join(side(), STAMP_NAME), 'utf-8')).toBe(original) // 壊れた記録がそのまま写しにある
    expect(contentsOf(loadProjectChatFile(file))).toEqual(['新しい会話'])
  })

  it('途中の壊れた行を捨てる記録に、読み込みを挟まず保存する: 写しを残してから置き換える', () => {
    const original = ['{"v":2}', rec(0, 'a'), '{壊れた', rec(2, 'c')].join('\n') + '\n'
    put(original)

    expect(saveProjectChatFile(file, json('a', 'z'))).toEqual({ ok: true })

    expect(fs.readFileSync(path.join(side(), STAMP_NAME), 'utf-8')).toBe(original)
    expect(wellFormed()).toBe(true)
  })

  it.skipIf(isRoot)('書けないフォルダの壊れた記録: 写しを作れないので置き換えず、断る。元は変わらない', () => {
    const original = '会話の記録ではない文字列'
    put(original)
    fs.chmodSync(side(), 0o555)

    const r = saveProjectChatFile(file, json('新しい会話'))
    fs.chmodSync(side(), 0o755)

    expect(r).toEqual({ ok: false, message: '読めなかった記録の写しを作れなかったので、書き込みません' })
    expect(names()).toEqual(['chat.json'])
    expect(fs.readFileSync(file, 'utf-8')).toBe(original)
  })

  it.skipIf(isRoot)('読めない（権限を外した）chat.json: 写しも作れないので置き換えず、断る', () => {
    put('権限を外す前の中身')
    fs.chmodSync(file, 0o000)
    let r: ReturnType<typeof saveProjectChatFile>
    try {
      r = saveProjectChatFile(file, json('新しい会話'))
    } finally {
      fs.chmodSync(file, 0o644)
    }
    expect(r).toEqual({ ok: false, message: '読めなかった記録の写しを作れなかったので、書き込みません' })
    expect(fs.readFileSync(file, 'utf-8')).toBe('権限を外す前の中身')
    expect(names()).toEqual(['chat.json'])
  })

  it('無いファイル・読める v1／v2・空のファイルへの保存は、今までどおり写しを作らずに書く', () => {
    expect(saveProjectChatFile(file, json('初回'))).toEqual({ ok: true }) // 無い
    resetChatLogCache()
    put('')
    expect(saveProjectChatFile(file, json('空の後'))).toEqual({ ok: true }) // 空
    resetChatLogCache()
    put(JSON.stringify([msg('v1')]))
    expect(saveProjectChatFile(file, json('v1', 'next'))).toEqual({ ok: true }) // v1
    resetChatLogCache()
    put(['{"v":2}', rec(0, 'v2')].join('\n') + '\n')
    expect(saveProjectChatFile(file, json('v2', 'next'))).toEqual({ ok: true }) // v2
    expect(copyNames()).toEqual([])
    expect(contentsOf(loadProjectChatFile(file))).toEqual(['v2', 'next'])
  })

  it('読み込みで写しを作ったあとの保存は、同じ写しを使い、増やさない', () => {
    put('壊れた記録')
    loadProjectChatFile(file) // 写しができる
    expect(saveProjectChatFile(file, json('新しい会話'))).toEqual({ ok: true })
    expect(copyNames()).toEqual([STAMP_NAME])
  })
})
