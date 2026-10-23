import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

// ── 途中で止まった回の記録の配線（ソースを読んで確かめる。設計書 10.13.12 の W1〜W3）──────────────────
// 当て先が他の行に出ないか（掟10）: import の行だけを取り出して調べる。
// L-1 で W3 の shared の部分、L-2a で W3 の projectOps・保存の部品の部分、L-2b で W1（main.ts の呼び出し）・W2（will-quit の登録）と、
// 止まった回の部品（stoppedOps・inFlightOpsArm）の分け方を入れた。

const root = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf-8')
/** import 文・動的 import・require の取り込み先（from '…' / import '…' / require('…')）を全部取り出す。 */
const importedModules = (src: string): string[] =>
  [...src.matchAll(/(?:\bfrom|\bimport|\brequire\s*\()\s*['"]([^'"]+)['"]/g)].map(m => m[1])

describe('W3 shared の止まった回の部品は、node の組み込みと electron を import しない（画面からも import されるため）', () => {
  const FILES = ['src/shared/inFlightOps.ts', 'src/shared/stageTiming.ts', 'src/shared/opsText.ts']

  it.each(FILES)('★ %s: path・fs・electron・node: の取り込みが無い', (rel) => {
    const mods = importedModules(read(rel))
    const bad = mods.filter(m => /^(?:node:|path$|fs$|electron$|os$|crypto$|child_process$)/.test(m) || /(?:^|\/)electron(?:\/|$)/.test(m))
    expect(bad, `${rel} が取り込んでいる: ${bad.join(', ')}`).toEqual([])
  })

  it('検査が空振りしない: inFlightOps.ts は、実際に自分の仲間（./stageTiming・./opsText）を取り込んでいる', () => {
    const mods = importedModules(read('src/shared/inFlightOps.ts'))
    expect(mods).toContain('./stageTiming')
    expect(mods).toContain('./opsText')
  })

  it('shared の止まった回の部品は main の側（projectOps・inFlightOpsStore）を取り込まない（向きは main → shared だけ）', () => {
    for (const rel of ['src/shared/inFlightOps.ts', 'src/shared/stageTiming.ts']) {
      const bad = importedModules(read(rel)).filter(m => /\/main\/|projectOps|inFlightOpsStore|inFlightOpsArm/.test(m))
      expect(bad, rel).toEqual([])
    }
  })
})

// ── L-2a: 書く口（projectOps・inFlightOutlet）と保存の部品（inFlightOpsStore）の分け方 ─────────────────────────────
// ファイルに触るのは inFlightOpsStore.ts だけ。projectOps.ts と口の持ち主（inFlightOutlet.ts）は fs・electron を取り込まない
// （W3 の projectOps の部分。口がつながる前は何もしない・書けなくても操作を止めない、は tests/inFlightOpsRecord.test.ts が振る舞いで固定している）。
describe('W3 projectOps・口の持ち主は fs・electron を import しない。ファイルの名前を持つのも書くのも inFlightOpsStore.ts だけ', () => {
  const NODE_IO = /^(?:node:|fs$|electron$|child_process$|os$)/
  const MAIN_FILES = ['src/main/projectOps.ts', 'src/main/inFlightOutlet.ts', 'src/main/stoppedOps.ts']

  it.each(MAIN_FILES)('★ %s: fs・electron・node: の取り込みが無い', (rel) => {
    const bad = importedModules(read(rel)).filter(m => NODE_IO.test(m))
    expect(bad, `${rel} が取り込んでいる: ${bad.join(', ')}`).toEqual([])
  })

  it('検査が空振りしない: projectOps は shared の部品・口の持ち主・止まった回の部品を、inFlightOpsStore は fs・electron・shared を取り込んでいる', () => {
    const ops = importedModules(read('src/main/projectOps.ts'))
    expect(ops).toContain('../shared/inFlightOps')
    expect(ops).toContain('./inFlightOutlet')
    expect(ops).toContain('./stoppedOps')
    expect(importedModules(read('src/main/stoppedOps.ts'))).toEqual(expect.arrayContaining(['../shared/inFlightOps', '../shared/teardownResult']))
    const store = importedModules(read('src/main/inFlightOpsStore.ts'))
    expect(store).toEqual(expect.arrayContaining(['electron', 'fs', 'path', '../shared/inFlightOps']))
  })

  it('向きは「保存の部品 → shared」だけ。projectOps・口の持ち主は保存の部品を取り込まない（口で受け渡す）', () => {
    for (const rel of MAIN_FILES) {
      const bad = importedModules(read(rel)).filter(m => /inFlightOpsStore|inFlightOpsArm/.test(m))
      expect(bad, rel).toEqual([])
    }
  })

  it('★ 保存先のファイル名 in-flight-ops.json を文字列として持つのは、src の中で inFlightOpsStore.ts だけ', () => {
    const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap(e => {
      const rel = `${dir}/${e.name}`
      return e.isDirectory() ? walk(rel) : /\.(?:ts|tsx)$/.test(e.name) ? [rel] : []
    })
    const holders = walk('src').filter(rel => /['"`]in-flight-ops\.json['"`]/.test(read(rel)))
    expect(holders).toEqual(['src/main/inFlightOpsStore.ts'])
  })

  it('★ 口を呼ぶのは inFlightOutlet.ts の1か所で、try の中。例外を握りつぶして dirty の印を立てる', () => {
    const src = read('src/main/inFlightOutlet.ts')
    expect((src.match(/\bsink\(/g) ?? []).length).toBe(1)
    const at = src.indexOf('export function writeInFlightThrough')
    const body = src.slice(at, src.indexOf('\n}\n', at))
    expect(body.indexOf('try {')).toBeGreaterThan(-1)
    expect(body.indexOf('try {')).toBeLessThan(body.indexOf('sink(build())'))
    expect(body.indexOf('sink(build())')).toBeLessThan(body.indexOf('} catch {'))
    expect(body.slice(body.indexOf('} catch {'))).toContain('dirty = true')
  })

  it('projectOps が口へ渡す中身は buildInFlightFile 1つから作る。書く入口は writeInFlight 1つ（直接口を呼ばない）', () => {
    const src = read('src/main/projectOps.ts')
    expect(src).toContain('const writeInFlight = (onlyIfDue = false): void => writeInFlightThrough(buildInFlightFile, onlyIfDue)')
    expect((src.match(/writeInFlightThrough\(/g) ?? []).length).toBe(1)
  })
})

// ── L-2b: 起動の読み戻し（W1）と終了の直前の書き切り（W2）─────────────────────────────────────────────
describe('W1 読み戻し armInFlightOps は main.ts の1か所だけ。本体の Koto（isPrimaryInstance）のときだけ、try の中で、窓を作る前に呼ぶ', () => {
  const main = read('src/main/main.ts')
  const lines = main.split('\n')
  const callLine = lines.findIndex(l => l.includes('armInFlightOps({'))

  it('★ 呼び出しは main.ts に1つだけ（armInFlightOps( の形）', () => {
    expect((main.match(/armInFlightOps\(/g) ?? []).length).toBe(1)
    expect(callLine).toBeGreaterThan(-1)
  })

  it('★ if (isPrimaryInstance) { try { の中にある。try の外側は catch で受ける', () => {
    expect(lines[callLine - 2].trim()).toBe('if (isPrimaryInstance) {')
    expect(lines[callLine - 1].trim()).toBe('try {')
    const after = lines.slice(callLine).join('\n')
    expect(after.indexOf('} catch {')).toBeGreaterThan(-1)
    expect(after.indexOf('} catch {')).toBeLessThan(after.indexOf('applyCSP()')) // 呼び出しを囲む try は窓を作る処理より前で閉じる
  })

  it('★ 窓を作る（createWindow()）より前にある。同じ whenReady の中', () => {
    const create = main.indexOf('applyCSP(); buildMenu(); setDockIcon(); createWindow()')
    expect(create).toBeGreaterThan(-1)
    expect(main.indexOf('armInFlightOps({')).toBeLessThan(create)
    const ready = main.lastIndexOf('app.whenReady().then(() => {', main.indexOf('armInFlightOps({'))
    expect(ready).toBeGreaterThan(-1)
    expect(main.slice(ready, create)).not.toContain('\n})\n') // whenReady の本体が途中で閉じていない
  })

  it('★ isPrimaryInstance は「鍵を取れて、動いている別の Koto も無い」。鍵を取れたときだけ anotherKotoIsRunning() を見に行く', () => {
    expect(main).toContain('const otherKotoRunning = gotLock && anotherKotoIsRunning()')
    expect(main).toContain('const isPrimaryInstance = gotLock && !otherKotoRunning')
  })

  it('★ 直す前の形ではない: app.hasSingleInstanceLock() を読み戻しの条件にしていない（終了に入る側でも true のため）', () => {
    // 呼び出しの前3行に、鍵の確かめが無い（その上の `if (!app.hasSingleInstanceLock()) return` は窓を作る側の既存の守りで、読み戻しの条件ではない）
    expect(lines.slice(callLine - 3, callLine).join('\n')).not.toContain('hasSingleInstanceLock')
    expect(main).not.toMatch(/if \(app\.hasSingleInstanceLock\(\)\) \{\s*try \{\s*armInFlightOps/)
    // 窓の側の既存の守りは変えていない
    expect(main).toContain('if (!app.hasSingleInstanceLock()) return  // 上で終了処理に入っている')
  })

  it('★ ipc/ の下（registerAllHandlers の中）に置かない。armInFlightOps を知っているのは main.ts と inFlightOpsArm.ts だけ', () => {
    const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap(e => {
      const rel = `${dir}/${e.name}`
      return e.isDirectory() ? walk(rel) : /\.(?:ts|tsx)$/.test(e.name) ? [rel] : []
    })
    const holders = walk('src').filter(rel => /\barmInFlightOps\b/.test(read(rel)))
    expect(holders).toEqual(['src/main/inFlightOpsArm.ts', 'src/main/main.ts'])
  })

  it('本物の確かめを渡している（exists は fs.existsSync・hasWork は inFlightHasWork・版は app.getVersion()）', () => {
    expect(main).toContain('version: app.getVersion(), exists: fs.existsSync, hasWork: inFlightHasWork,')
    expect(main).toContain("import { armInFlightOps, inFlightHasWork } from './inFlightOpsArm'")
  })

  it('inFlightOpsArm.ts は electron を取り込まない（electron の app は main.ts が渡す）。全体を try で包み、投げない', () => {
    const src = read('src/main/inFlightOpsArm.ts')
    expect(importedModules(src).filter(m => m === 'electron')).toEqual([])
    const body = src.slice(src.indexOf('export function armInFlightOps'))
    expect(body.indexOf('try {')).toBeGreaterThan(-1)
    expect(body.indexOf('try {')).toBeLessThan(body.indexOf('adoptAtStartup('))
    expect(body.slice(body.indexOf('} catch {'))).toContain('return false')
    // 口をつなぐのは最後（ここまでで投げたら書かない）
    expect(body.indexOf('adoptStoppedOps(')).toBeLessThan(body.indexOf('setInFlightSink('))
    expect(body.indexOf('deps.onWillQuit(')).toBeLessThan(body.indexOf('setInFlightSink('))
  })
})

describe('W2 will-quit の登録は1つ。読み戻しが渡し、終了の直前に書き切る', () => {
  it('★ src 全体で、app.on(\'will-quit\') は main.ts の armInFlightOps の呼び出しの中の1つだけ', () => {
    const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap(e => {
      const rel = `${dir}/${e.name}`
      return e.isDirectory() ? walk(rel) : /\.(?:ts|tsx)$/.test(e.name) ? [rel] : []
    })
    // コメントに書かれた `app.on('will-quit')` は数えない（登録のコードだけを見る）
    const code = (rel: string): string => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
    const holders = walk('src').filter(rel => /\.on\(\s*['"]will-quit['"]/.test(code(rel)))
    expect(holders).toEqual(['src/main/main.ts'])
    const main = read('src/main/main.ts')
    expect((code('src/main/main.ts').match(/\.on\(\s*['"]will-quit['"]/g) ?? []).length).toBe(1)
    const call = main.slice(main.indexOf('armInFlightOps({'), main.indexOf('} catch { /* 読み戻せなくても起動する */ }'))
    expect(call).toContain("onWillQuit: fn => { app.on('will-quit', fn) },")
  })

  it('★ inFlightOpsArm.ts が onWillQuit を呼ぶのは1回。渡す関数は flushInFlightOps(Date.now()) を呼ぶ', () => {
    const src = read('src/main/inFlightOpsArm.ts')
    expect((src.match(/deps\.onWillQuit\(/g) ?? []).length).toBe(1)
    const at = src.indexOf('deps.onWillQuit(')
    expect(src.slice(at, at + 200)).toContain('flushInFlightOps(Date.now())')
  })
})
