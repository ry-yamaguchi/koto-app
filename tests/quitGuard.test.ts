import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  quitGuardDecision, createQuitGuard, quitGuardDialogOptions, createQuitAsk,
  type QuitDialogOptions,
  QUIT_GUARD_MESSAGE, QUIT_GUARD_CANCEL_LABEL, QUIT_GUARD_QUIT_LABEL, QUIT_GUARD_QUIT_INDEX,
} from '../src/main/quitGuard'
import { listRunningOps, getOps, resetProjectOpsForTests, type RunningOpInfo } from '../src/main/projectOps'
import { withProjectLock } from '../src/main/projectLock'

// ── 終了の歯止め（2026-10-10・0.6.21-rc.1 の実機で見つかった欠陥）──────────────────────────
// 専有型の削除の途中で ⌘Q →「ウィンドウを閉じる（処理は続きます）」→ Dock から開き直す → ところが
// そのあと警告が出ないまま Koto が終了し、削除が途中で止まった。終了の警告は mainWindow の 'close' だけにあり、
// 材料は画面が win:busy で登録した印だった（ウィンドウを閉じると外れ・開き直しても誰も登録せず・
// ウィンドウが無いときの ⌘Q は 'close' が起きない）。main の記録（projectOps）を直接読んで、
// app の 'before-quit' で必ず聞く。
//
// ここで固定するもの:
//   1. 判断（quitGuardDecision・純関数）  2. main の記録を読む listRunningOps（本物の withProjectLock）
//   3. 流れ（createQuitGuard）を本物の記録に流して、聞く・やめる・終了する・二重に聞かない
//   3b. ダイアログへ渡す設定と、押されたボタンの扱い（偽のダイアログに流す。Enter・Esc・各ボタン）
//   4. main.ts の配線（ソースの呼び出しの形。コメントを除く）  5. 自動更新との関係

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf-8')
const codeOnly = (src: string) => src.split('\n').filter(l => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*')).join('\n')

const META = { target: 'sakura-apprun-dedicated' as const, handler: 'apprunDedicated:teardown' }

/** 決まった間だけ止まる小道具（処理が「走っている」状態を作る）。 */
function gate() {
  let open!: () => void
  const wait = new Promise<void>(r => { open = r })
  return { wait, open }
}
const flush = () => new Promise<void>(r => setImmediate(r))

beforeEach(() => resetProjectOpsForTests())

// ── 1. 判断（純関数）──────────────────────────────────────────────────────

describe('quitGuardDecision: 走っている操作があるときだけ止める', () => {
  it('走っていなければ止めない', () => {
    expect(quitGuardDecision([])).toEqual({ block: false })
  })

  it('1件: 見出し・プロジェクト名と操作・「終了すると途中で止まる」・2つのボタン', () => {
    const d = quitGuardDecision([{ projectDir: '/Users/a/Projects/newname', op: '削除' }])
    expect(d).toEqual({
      block: true,
      message: '処理を実行中です',
      detail: '「newname」の削除が進行中です。いま Koto を終了すると、処理は途中で止まります。',
      buttons: ['終了しない', '終了する（処理は途中で止まります）'],
      defaultId: 0,
      cancelId: 0,
    })
  })

  it('既定とキャンセルは「終了しない」。「終了する」の番号は定数と一致する', () => {
    const d = quitGuardDecision([{ projectDir: '/p/a', op: '公開' }])
    if (!d.block) throw new Error('block のはず')
    expect(d.buttons[d.defaultId]).toBe(QUIT_GUARD_CANCEL_LABEL)
    expect(d.buttons[d.cancelId]).toBe(QUIT_GUARD_CANCEL_LABEL)
    expect(d.buttons[QUIT_GUARD_QUIT_INDEX]).toBe(QUIT_GUARD_QUIT_LABEL)
    expect(d.message).toBe(QUIT_GUARD_MESSAGE)
  })

  it('複数: すべてのプロジェクト名と操作を並べる（フォルダの道筋は出さない）', () => {
    const d = quitGuardDecision([
      { projectDir: '/Users/a/Projects/newname', op: '削除' },
      { projectDir: '/Users/a/Projects/Tsukaisute', op: '公開' },
      { projectDir: '/Users/a/Projects/landingTEST', op: '作成' },
    ])
    if (!d.block) throw new Error('block のはず')
    expect(d.detail).toBe('「newname」の削除、「Tsukaisute」の公開、「landingTEST」の作成が進行中です。いま Koto を終了すると、処理は途中で止まります。')
    expect(d.detail).not.toContain('/Users/a')
  })

  it('名前が取れないとき（ルート）は、projectDir そのものを出す', () => {
    const d = quitGuardDecision([{ projectDir: '/', op: '公開' }])
    if (!d.block) throw new Error('block のはず')
    expect(d.detail).toContain('「/」の公開が進行中です')
  })

  it('文が短い（掟5）: 見出し・ボタン・1件の詳細。丸数字・念押しの言い回しを使わない', () => {
    const d = quitGuardDecision([{ projectDir: '/Users/a/Projects/newname', op: '削除' }])
    if (!d.block) throw new Error('block のはず')
    expect(d.message.length).toBeLessThanOrEqual(12)
    expect(d.detail.length).toBeLessThanOrEqual(60)
    for (const b of d.buttons) expect(b.length).toBeLessThanOrEqual(20)
    const all = [d.message, d.detail, ...d.buttons].join('\n')
    expect(all).not.toMatch(/[①-⑳⓪❶-❿㉑-㊿]/)
    for (const w of ['念のため', '大丈夫', '実機', '窓', '鍵']) expect(all).not.toContain(w)
    // 括弧は1文に1つまで・入れ子にしない
    expect(d.buttons[1].match(/（/g)?.length).toBe(1)
  })
})

// ── 2. 走っている操作の一覧（main の記録を読むだけ）────────────────────────────

describe('listRunningOps: withProjectLock の中だけ載り、終われば消える', () => {
  it('何も走っていなければ空', () => {
    expect(listRunningOps()).toEqual([])
  })

  it('★ 鍵の中では載り（projectDir・操作・公開先）、終われば消える', async () => {
    const g = gate()
    const seen: RunningOpInfo[][] = []
    const p = withProjectLock('/p/a/', '削除', async () => {
      seen.push(listRunningOps())
      await g.wait
      return 'done'
    }, META)
    await flush()
    // 末尾の `/` は同じプロジェクトとして正規化される
    expect(listRunningOps()).toEqual([{ projectDir: '/p/a', op: '削除', target: 'sakura-apprun-dedicated' }])
    g.open()
    await p
    expect(seen).toHaveLength(1)
    expect(listRunningOps()).toEqual([])
  })

  it('★ 処理が例外で終わっても消える（残ると「走っている」と言い続ける）', async () => {
    await expect(withProjectLock('/p/b', '公開', async () => { throw new Error('boom') }, META)).rejects.toThrow('boom')
    expect(listRunningOps()).toEqual([])
  })

  it('別のプロジェクトは開始順に並び、終わったものから消える', async () => {
    const g1 = gate(); const g2 = gate()
    const p1 = withProjectLock('/p/one', '作成', async () => { await g1.wait }, META)
    const p2 = withProjectLock('/p/two', '公開', async () => { await g2.wait }, META)
    await flush()
    expect(listRunningOps().map(r => [r.projectDir, r.op])).toEqual([['/p/one', '作成'], ['/p/two', '公開']])
    g1.open(); await p1
    expect(listRunningOps().map(r => r.projectDir)).toEqual(['/p/two'])
    g2.open(); await p2
    expect(listRunningOps()).toEqual([])
  })

  it('断られた側（同じプロジェクトの2本目）は載らない', async () => {
    const g = gate()
    const p = withProjectLock('/p/c', '削除', async () => { await g.wait }, META)
    await flush()
    const refused = await withProjectLock('/p/c', '公開', async () => 'x', META)
    expect(refused).toEqual({ busy: true, running: '削除' })
    expect(listRunningOps()).toHaveLength(1)
    g.open(); await p
  })

  it('読むだけで何も書かない（画面が読む記録は変わらない）。返す配列を触っても記録は変わらない', async () => {
    const g = gate()
    const p = withProjectLock('/p/d', '削除', async () => { await g.wait }, META)
    await flush()
    const before = JSON.stringify(getOps('/p/d'))
    const list = listRunningOps()
    list.pop()
    list.length = 0
    expect(JSON.stringify(getOps('/p/d'))).toBe(before)
    expect(listRunningOps()).toHaveLength(1)
    g.open(); await p
  })
})

// ── 3. 流れ（本物の記録に流す）──────────────────────────────────────────────

describe('createQuitGuard: 走っている処理があれば、聞いてから終了する', () => {
  function setup(failToAsk = false) {
    const log = { prevented: 0, asked: [] as string[], quit: 0 }
    let release: ((n: number) => void) | null = null
    const guard = createQuitGuard({
      listRunning: listRunningOps,
      ask: (d) => {
        log.asked.push(d.detail)
        if (failToAsk) return Promise.reject(new Error('dialog failed'))
        // 答えを手動で返す（聞いている間の動きを試すため）
        return new Promise<number>(r => { release = r })
      },
      quit: () => { log.quit++ },
    })
    const beforeQuit = () => guard.onBeforeQuit({ preventDefault: () => { log.prevented++ } })
    return { guard, log, beforeQuit, answer: (n: number) => release?.(n) }
  }

  it('★ 走っていなければ、止めず・聞かない', async () => {
    const t = setup()
    t.beforeQuit()
    await flush()
    expect(t.log).toEqual({ prevented: 0, asked: [], quit: 0 })
  })

  it('★ 走っていれば、終了を止めて聞く（文にプロジェクト名と操作が入る）。まだ終了しない', async () => {
    const g = gate()
    const p = withProjectLock('/Users/a/Projects/newname', '削除', async () => { await g.wait }, META)
    await flush()
    const t = setup()
    t.beforeQuit()
    await flush()
    expect(t.log.prevented).toBe(1)
    expect(t.log.asked).toEqual(['「newname」の削除が進行中です。いま Koto を終了すると、処理は途中で止まります。'])
    expect(t.log.quit).toBe(0)
    g.open(); await p
  })

  it('★ 「終了しない」: 終了しない・印も立てない・次の終了でまた聞く', async () => {
    const g = gate()
    const p = withProjectLock('/p/a', '削除', async () => { await g.wait }, META)
    await flush()
    const t = setup()
    t.beforeQuit(); await flush()
    t.answer(0); await flush()
    expect(t.log.quit).toBe(0)
    expect(t.guard.isQuitConfirmed()).toBe(false)
    t.beforeQuit(); await flush()
    expect(t.log.asked).toHaveLength(2)
    expect(t.log.prevented).toBe(2)
    g.open(); await p
  })

  it('★★ 「終了する」: 印を立てて quit() をやり直す。やり直しの before-quit では止めず・聞かない', async () => {
    const g = gate()
    const p = withProjectLock('/p/a', '削除', async () => { await g.wait }, META)
    await flush()
    const t = setup()
    t.beforeQuit(); await flush()
    t.answer(QUIT_GUARD_QUIT_INDEX); await flush()
    expect(t.log.quit).toBe(1)
    expect(t.guard.isQuitConfirmed()).toBe(true)
    // app.quit() がもう一度 before-quit を出す。処理はまだ走っているが、聞かない
    t.beforeQuit(); await flush()
    expect(t.log.prevented).toBe(1)
    expect(t.log.asked).toHaveLength(1)
    expect(t.log.quit).toBe(1)
    g.open(); await p
  })

  it('★ 聞いている間に ⌘Q を続けて押しても、ダイアログは重ならない（終了は止めたまま）', async () => {
    const g = gate()
    const p = withProjectLock('/p/a', '公開', async () => { await g.wait }, META)
    await flush()
    const t = setup()
    t.beforeQuit(); t.beforeQuit(); t.beforeQuit()
    await flush()
    expect(t.log.asked).toHaveLength(1)
    expect(t.log.prevented).toBe(3)
    t.answer(QUIT_GUARD_QUIT_INDEX); await flush()
    expect(t.log.quit).toBe(1)
    g.open(); await p
  })

  it('★ ダイアログが出せなかったとき（失敗）は、終了しない。あとでまた聞ける', async () => {
    const g = gate()
    const p = withProjectLock('/p/a', '作成', async () => { await g.wait }, META)
    await flush()
    const t = setup(true)
    t.beforeQuit(); await flush()
    expect(t.log.quit).toBe(0)
    expect(t.guard.isQuitConfirmed()).toBe(false)
    t.beforeQuit(); await flush()
    expect(t.log.asked).toHaveLength(2)
    g.open(); await p
  })

  it('★ reset: 終了が中断されたら印を戻し、次の終了でまた聞く', async () => {
    const g = gate()
    const p = withProjectLock('/p/a', '削除', async () => { await g.wait }, META)
    await flush()
    const t = setup()
    t.beforeQuit(); await flush()
    t.answer(QUIT_GUARD_QUIT_INDEX); await flush()
    expect(t.guard.isQuitConfirmed()).toBe(true)
    t.guard.reset()
    expect(t.guard.isQuitConfirmed()).toBe(false)
    t.beforeQuit(); await flush()
    expect(t.log.asked).toHaveLength(2)
    g.open(); await p
  })

  it('処理が終わったあとは、聞かずに終了できる', async () => {
    const g = gate()
    const p = withProjectLock('/p/a', '削除', async () => { await g.wait }, META)
    await flush()
    g.open(); await p
    const t = setup()
    t.beforeQuit(); await flush()
    expect(t.log).toEqual({ prevented: 0, asked: [], quit: 0 })
  })

  it('★ ウィンドウの有無・画面の登録に関係なく聞く: createQuitGuard は画面の印（closeBlockingBusy）を一切受け取らない', () => {
    // 材料は main の記録（listRunning）だけ。画面の登録を当てにした欠陥に戻らないよう、受け取る口が無いことを固定する
    const src = codeOnly(read('src/main/quitGuard.ts'))
    expect(src).not.toContain('closeBlocking')
    expect(src).not.toContain('win:busy')
    expect(src).not.toContain("from 'electron'")
  })
})

// ── 3b. ダイアログへ渡す設定と、押されたボタンの扱い（偽のダイアログに流す）──────────────────────
// main.ts は electron の dialog につなぐだけ。設定の作り方（Enter・Esc の番号）と、答えをそのまま返すことは、ここで固定する。
// 変異（rc.2 の検分）: cancelId を 1 に（Esc で終了）／defaultId を 1 に（Enter で終了）／返す答えを 1 に固定（どのボタンでも終了）／
// ボタンの並びを逆に（「終了しない」を押すと終了）——いずれも、下のテストのどれかが落ちる。

describe('ダイアログへ渡す設定と、押されたボタンの扱い', () => {
  const blocked = () => {
    const d = quitGuardDecision([{ projectDir: '/Users/a/Projects/newname', op: '削除' }])
    if (!d.block) throw new Error('block のはず')
    return d
  }

  /** 偽のダイアログ。渡された設定を覚え、`press` が決めた番号を答える。 */
  function fakeDialog(press: (o: QuitDialogOptions) => number) {
    const calls: { opts: QuitDialogOptions; args: number }[] = []
    const showMessageBox = (opts: QuitDialogOptions, ...rest: unknown[]) => {
      calls.push({ opts, args: 1 + rest.length })
      return Promise.resolve({ response: press(opts) })
    }
    return { calls, showMessageBox }
  }

  it('★ 設定: 警告の種類・見出し・詳細・ボタン、既定（Enter）と取消（Esc）は「終了しない」の番号 0', () => {
    expect(quitGuardDialogOptions(blocked())).toEqual({
      type: 'warning',
      message: '処理を実行中です',
      detail: '「newname」の削除が進行中です。いま Koto を終了すると、処理は途中で止まります。',
      buttons: ['終了しない', '終了する（処理は途中で止まります）'],
      defaultId: 0,
      cancelId: 0,
    })
  })

  it('★ ask は、決定から作った設定をそのままダイアログへ渡す', async () => {
    const dlg = fakeDialog(() => 0)
    await createQuitAsk({ getParent: () => null, showMessageBox: dlg.showMessageBox })(blocked())
    expect(dlg.calls).toHaveLength(1)
    expect(dlg.calls[0].opts).toEqual(quitGuardDialogOptions(blocked()))
  })

  it('★ ask は、押されたボタンの番号を加工せずに返す（0 は 0・1 は 1）', async () => {
    for (const n of [0, 1]) {
      const dlg = fakeDialog(() => n)
      const answer = await createQuitAsk({ getParent: () => null, showMessageBox: dlg.showMessageBox })(blocked())
      expect(answer).toBe(n)
    }
  })

  it('ウィンドウがあれば親にして渡し、無ければ親なし（引数1つ）で渡す', async () => {
    const parent = { id: 'win' }
    const seenParents: unknown[] = []
    await createQuitAsk({
      getParent: () => parent,
      showMessageBox: (_opts, p) => { seenParents.push(p); return Promise.resolve({ response: 0 }) },
    })(blocked())
    expect(seenParents).toEqual([parent])
    const dlg = fakeDialog(() => 0)
    await createQuitAsk({ getParent: () => null, showMessageBox: dlg.showMessageBox })(blocked())
    expect(dlg.calls.map(c => c.args)).toEqual([1])
  })

  /** 本物の記録（withProjectLock）・本物の createQuitGuard・本物の ask に、偽のダイアログをつなぐ。 */
  async function runWith(press: (o: QuitDialogOptions) => number) {
    const g = gate()
    const p = withProjectLock('/p/a', '削除', async () => { await g.wait }, META)
    await flush()
    const dlg = fakeDialog(press)
    let quit = 0
    let prevented = 0
    const guard = createQuitGuard({
      listRunning: listRunningOps,
      ask: createQuitAsk({ getParent: () => null, showMessageBox: dlg.showMessageBox }),
      quit: () => { quit++ },
    })
    guard.onBeforeQuit({ preventDefault: () => { prevented++ } })
    await flush()
    g.open(); await p
    return { quit, prevented, confirmed: guard.isQuitConfirmed(), dlg }
  }

  it('★★ Esc（取消の番号）を押しても終了しない', async () => {
    const r = await runWith(o => o.cancelId)
    expect(r).toMatchObject({ quit: 0, prevented: 1, confirmed: false })
  })

  it('★★ Enter（既定の番号）を押しても終了しない', async () => {
    const r = await runWith(o => o.defaultId)
    expect(r).toMatchObject({ quit: 0, prevented: 1, confirmed: false })
  })

  it('★★ 「終了しない」と書かれたボタンを押しても終了しない（ボタンの並びが逆でも、名前で押す）', async () => {
    const r = await runWith(o => o.buttons.indexOf(QUIT_GUARD_CANCEL_LABEL))
    expect(r).toMatchObject({ quit: 0, prevented: 1, confirmed: false })
  })

  it('★★ 「終了する（処理は途中で止まります）」と書かれたボタンを押したときだけ、終了する', async () => {
    const r = await runWith(o => o.buttons.indexOf(QUIT_GUARD_QUIT_LABEL))
    expect(r).toMatchObject({ quit: 1, prevented: 1, confirmed: true })
  })
})

// ── 4. main.ts の配線（コメントを除いた実物の呼び出しの形）───────────────────────────────

describe('main.ts の配線: before-quit で判断し、close の (1) だけ飛ばし、(2) は飛ばさない', () => {
  const main = codeOnly(read('src/main/main.ts'))
  const count = (hay: string, needle: string) => hay.split(needle).length - 1

  /** `mainWindow.on('close', async (e) => {` から、その関数の閉じ（`  })\n}`）まで。 */
  const closeHandler = (() => {
    const at = main.indexOf("mainWindow.on('close', async (e) => {")
    expect(at, "main.ts に mainWindow.on('close') が無い").toBeGreaterThan(0)
    return main.slice(at, main.indexOf('\n  })\n}', at))
  })()
  /** (1) の処理中の警告のブロック（`if (closeBlockingBusy` から (2) の手前まで）と、(2) 以降。 */
  const at2 = closeHandler.indexOf('if (!hasUnsavedChanges) return')
  const part1 = closeHandler.slice(0, at2)
  const part2 = closeHandler.slice(at2)

  it('main の記録（listRunningOps）を材料にして、quitGuard を作っている。画面の印を材料にしない', () => {
    expect(main).toContain("import { listRunningOps } from './projectOps'")
    expect(main).toContain("import { createQuitGuard, createQuitAsk } from './quitGuard'")
    expect(main).toContain('const quitGuard = createQuitGuard({')
    expect(main).toContain('listRunning: listRunningOps,')
    expect(main).toContain('quit: () => app.quit(),')
  })

  it('★ app.on(before-quit) が1つだけあり、quitGuard.onBeforeQuit を呼ぶ（門が外れていない）', () => {
    expect(count(main, "app.on('before-quit'")).toBe(1)
    expect(main).toContain("app.on('before-quit', (e) => quitGuard.onBeforeQuit(e))")
  })

  it('★ ダイアログは quitGuard.ts の createQuitAsk につなぐだけ。設定（既定・取消の番号）と答えの扱いを main.ts で自前に組まない', () => {
    const at = main.indexOf('const quitGuard = createQuitGuard({')
    const block = main.slice(at, main.indexOf('\n})\n', at))
    expect(block).toContain('ask: createQuitAsk<BrowserWindow>({')
    // ウィンドウがあればそれを親にし、無ければ親なしで出す
    expect(block).toContain('getParent: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),')
    expect(block).toContain('showMessageBox: (opts, parent) => (parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts)),')
    // 設定や答えを main.ts で組むと、偽のダイアログのテスト（3b）を通らない道ができる
    for (const w of ['defaultId', 'cancelId', 'buttons', 'response', 'detail', 'message']) {
      expect(block, `main.ts の quitGuard の定義に ${w} を書いている`).not.toContain(w)
    }
  })

  it('★★ close の (1) は「終了する」の印を見て飛ばす', () => {
    expect(part1).toContain('if (closeBlockingBusy && !quitGuard.isQuitConfirmed()) {')
    // 直す前の形（印を見ない）に戻っていない
    expect(part1).not.toContain('if (closeBlockingBusy) {')
  })

  it('★★ close の (2)（未保存の確認）は、「終了する」の印では飛ばさない。forceQuit も立てない', () => {
    expect(at2).toBeGreaterThan(0)
    // 先頭の門は forceQuit だけ（印を足すと (2) まで飛ぶ）
    expect(closeHandler.startsWith("mainWindow.on('close', async (e) => {\n    if (forceQuit) return\n")).toBe(true)
    expect(closeHandler).not.toMatch(/if \(forceQuit \|\|/)
    expect(part2).not.toContain('isQuitConfirmed')
    expect(part2).toContain("buttons: ['保存して終了', '保存せずに終了', 'キャンセル'],")
    // 印の数: 見るのは (1) の1か所だけ
    expect(count(main, 'isQuitConfirmed')).toBe(1)
  })

  it('「終了する」の経路（quitGuard の定義の中）で forceQuit を立てない', () => {
    const at = main.indexOf('const quitGuard = createQuitGuard({')
    const block = main.slice(at, main.indexOf('\n})\n', at))
    expect(block).not.toContain('forceQuit')
  })

  it('終了が中断されたら印を戻す: ウィンドウが閉じたとき・未保存の確認が出たとき（どの答えでも）', () => {
    expect(main).toContain("mainWindow.on('closed', () => { mainWindow = null; quitGuard.reset() })")
    // (2) は e.preventDefault() で進行中の終了を取り消す。その時点で、答えを待たずに戻す
    // （「保存して終了」で保存に失敗するとウィンドウは開いたまま・印だけ残って、あとの ⌘Q が聞かずに通り抜けた）
    expect(part2).toContain('e.preventDefault()\n    quitGuard.reset()\n    const { response } = await dialog.showMessageBox(mainWindow!, {')
    // 戻すのは 'closed' と (2) の2か所だけ（答えごとの分岐の中には置かない）
    expect(count(main, 'quitGuard.reset()')).toBe(2)
    expect(part2).not.toContain('} else {\n      quitGuard.reset()')
  })

  it('ウィンドウを閉じるだけ（赤いボタン・⌘W）の警告は今のまま（ボタン名・文の組み立て）', () => {
    expect(part1).toContain("buttons: [closeBlockingConfirm || '中断してウィンドウを閉じる', 'キャンセル'],")
    expect(part1).toContain('detail: closeBlockingDetail || ')
    expect(part1).toContain('closeBlockingBusy = false\n      mainWindow!.close()')
  })
})

// ── 5. 自動更新（再起動して更新する）との関係 ─────────────────────────────────────────────

describe('自動更新: 走っている処理を、聞かずに止めない', () => {
  it('★ 今の門（canApplyNow に isBusy を渡す）は、そのまま残っている', () => {
    const upd = codeOnly(read('src/main/ipc/update.ts'))
    expect(upd).toContain('isBusy: deps.isBusy(),')
    expect(upd).toContain('if (!decision.ok) return decision')
    expect(upd).toContain('quitAndInstallNow()')
  })

  it('★ 再起動は autoUpdater.quitAndInstall() を通る（Electron が窓を閉じたあと app の終了＝before-quit を出す）。before-quit を迂回する終了を呼んでいない', () => {
    const updater = codeOnly(read('src/main/updater.ts'))
    expect(updater).toContain('autoUpdater.quitAndInstall()')
    // app.exit() / process.exit() は before-quit を出さずに終了する。main のどこにも無いこと
    for (const rel of ['src/main/updater.ts', 'src/main/main.ts', 'src/main/ipc/update.ts', 'src/main/ipc/window.ts']) {
      const src = codeOnly(read(rel))
      expect(src, `${rel} が before-quit を迂回する終了を呼んでいる`).not.toMatch(/\bapp\.exit\(|\bprocess\.exit\(/)
    }
  })
})

// ── 6. CHANGELOG ─────────────────────────────────────────────────────────────────

describe('CHANGELOG: 0.6.21 の節に、この修理の項目がある', () => {
  const changelog = read('CHANGELOG.md')
  // 0.6.21 を出したので、未リリースの節は 0.6.21 の節になった（2026-10-15）
  const unreleased = changelog.slice(changelog.indexOf('## [0.6.21]'), changelog.indexOf('\n## [0.6.20]'))

  it('🐛 の項目で、直したことと、確かめた範囲を書く（「実機」と書かない）', () => {
    const item = unreleased.split('\n').find(l => l.startsWith('- 🐛') && l.includes('⌘Q') && l.includes('警告なしに'))
    expect(item, '終了の歯止めの項目が見つからない').toBeTruthy()
    expect(item).toContain('終了の前に必ず聞く')
    // 0.6.21-rc.2 の実際の画面で確かめた（2026-10-15 作者）。確かめたことを、まだのまま残さない
    expect(item).toContain('0.6.21-rc.2 の実際の画面で確かめました')
    expect(item).not.toContain('まだ確かめていません')
    expect(item).not.toContain('実機')
  })

  it('★ 「知らせが届かない」のは、閉じたあと・開き直して**その処理を映す画面を開くまで**。開き直したあと一律に届かない、とは書かない', () => {
    const item = unreleased.split('\n').find(l => l.startsWith('- 🐛') && l.includes('⌘Q') && l.includes('警告なしに'))
    expect(item).toContain('その処理を映す画面を開くまでは届きません')
    expect(item).not.toContain('その知らせが届いていませんでした')
  })

  it('★ rc.1 で答えが出たこと（2回目の警告）を、「まだ分かっていません」のまま残さない', () => {
    expect(unreleased).not.toContain('警告が出るかも、まだ分かっていません')
    const btn = unreleased.split('\n').find(l => l.startsWith('- 🐛') && l.includes('「ウィンドウを閉じる（処理は続きます）」に直しました'))
    expect(btn, 'ボタン名の項目が見つからない').toBeTruthy()
    expect(btn).toContain('2回目の警告は、0.6.21-rc.1 の実際の画面で確かめました')
  })
})
