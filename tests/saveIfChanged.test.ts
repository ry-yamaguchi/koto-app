import { describe, it, expect } from 'vitest'
import { saveIfChanged, saveAndReport, type SavedMark } from '../src/shared/saveIfChanged'

// 「値が変わっていなければ書かない。書けなかったら、書いたことにしない」（2026-10-06 検分の指摘4）。
// AppRunDedicatedPanel の ②（サービスプリンシパルID）が、欄を離れたとき・候補を選んだとき・⑤で作るとき、
// のどの入口からも同じ判断で保存するための純関数。実際に write を差して、呼ばれた回数と印の動きを見る。

function recorder(failures: Array<Error | null> = []) {
  const written: string[] = []
  let n = 0
  const write = async (v: string) => {
    written.push(v)
    const f = failures[n++]
    if (f) throw f
  }
  return { written, write }
}

describe('saveIfChanged: 変わっていなければ書かない（指摘6 の守りを保つ）', () => {
  it('覚えている値と同じなら write を一度も呼ばない', async () => {
    const saved: SavedMark<string> = { current: '111111111111' }
    const { written, write } = recorder()
    await saveIfChanged(saved, '111111111111', write)
    expect(written).toEqual([])
    expect(saved.current).toBe('111111111111')
  })

  it('空→空も書かない（開いただけ・何も入れずに欄を離れただけでは書かない）', async () => {
    const saved: SavedMark<string> = { current: '' }
    const { written, write } = recorder()
    await saveIfChanged(saved, '', write)
    expect(written).toEqual([])
  })

  it('違う値なら1回だけ書き、書けたら印をその値へ進める（次の同じ値は書かない）', async () => {
    const saved: SavedMark<string> = { current: '' }
    const { written, write } = recorder()
    await saveIfChanged(saved, '111111111111', write)
    expect(written).toEqual(['111111111111'])
    expect(saved.current).toBe('111111111111')
    await saveIfChanged(saved, '111111111111', write)
    expect(written).toEqual(['111111111111']) // 2回目は書かない
  })
})

describe('saveIfChanged: 書けなかったら書いたことにしない（失敗後に、同じ値でもう一度書こうとする）', () => {
  it('★★ write が失敗したら、同じ例外を投げ直し、印を元へ戻す。次に同じ値で呼ぶと、もう一度書こうとする', async () => {
    const saved: SavedMark<string> = { current: '' }
    const boom = new Error('disk full')
    const { written, write } = recorder([boom, null])
    await expect(saveIfChanged(saved, '111111111111', write)).rejects.toBe(boom)
    expect(saved.current).toBe('') // 「保存済み」のまま残さない
    // 同じ値でもう一度（例: 欄を離れたとき失敗 → ⑤で作る入口）
    await saveIfChanged(saved, '111111111111', write)
    expect(written).toEqual(['111111111111', '111111111111']) // 2回目も実際に書こうとした
    expect(saved.current).toBe('111111111111')
    // 書けたあとは、また書かない
    await saveIfChanged(saved, '111111111111', write)
    expect(written).toHaveLength(2)
  })

  it('失敗したあと、元の値と同じ値で呼んでも書かない（印が元に戻っている＝ディスクはその値のまま）', async () => {
    const saved: SavedMark<string> = { current: '222222222222' }
    const { written, write } = recorder([new Error('x')])
    await expect(saveIfChanged(saved, '333333333333', write)).rejects.toThrow('x')
    expect(saved.current).toBe('222222222222')
    await saveIfChanged(saved, '222222222222', write)
    expect(written).toEqual(['333333333333']) // 元の値を書き直したりしない
  })

  it('失敗を待っている間に別の値へ進んでいたら、その印は触らない（古い失敗が新しい印を巻き戻さない）', async () => {
    const saved: SavedMark<string> = { current: '' }
    let release: (() => void) | undefined
    const written: string[] = []
    const slowFail = (v: string) => {
      written.push(v)
      return new Promise<void>((_, reject) => { release = () => reject(new Error('late failure')) })
    }
    const p = saveIfChanged(saved, '111111111111', slowFail)
    saved.current = '999999999999' // 失敗を待っている間に、別の保存が印を進めた
    release!()
    await expect(p).rejects.toThrow('late failure')
    expect(saved.current).toBe('999999999999')
  })
})

describe('saveIfChanged: 同じ値の保存が同時に2本走っても、書くのは1回', () => {
  it('欄を離れる＋⑤の入口が重なっても write は1回（印は書く前に進める）', async () => {
    const saved: SavedMark<string> = { current: '' }
    const written: string[] = []
    let release: (() => void) | undefined
    const write = (v: string) => {
      written.push(v)
      return new Promise<void>(resolve => { release = resolve })
    }
    const first = saveIfChanged(saved, '111111111111', write)
    const second = saveIfChanged(saved, '111111111111', write) // 1本目の書き込みがまだ終わっていない
    release!()
    await Promise.all([first, second])
    expect(written).toEqual(['111111111111'])
  })
})

// ── 切り替えたあとに戻ってきた保存の結果は、新しいプロジェクトの画面にも印にも触らない（2026-10-07 検分の指摘・掟11）──
// 印（savedResourceIdRef）も、画面の失敗の知らせ（idSaveError）も「いま開いているプロジェクト」のもの。
// プロジェクト A で始めた保存が、B へ切り替えたあとで失敗したとき、A の失敗を B の画面に出したり、
// B の印を A の前の値へ巻き戻したりしない。「いまのプロジェクトが、保存を始めたプロジェクトと違う」の判断は
// 呼び出し側（isStale）が決め、ここでは「stale なら何もしない」を実際の保存の動きで固定する。

/** 外から成功・失敗を決められる write（保存の途中の状態を作る）。 */
function deferredWrite() {
  const written: string[] = []
  let settle: { ok: () => void; fail: (e: unknown) => void } | undefined
  const write = (v: string) => {
    written.push(v)
    return new Promise<void>((resolve, reject) => { settle = { ok: resolve, fail: reject } })
  }
  return { written, write, ok: () => settle!.ok(), fail: (e: unknown) => settle!.fail(e) }
}

describe('saveIfChanged: 保存を始めたプロジェクトから離れていたら、失敗しても印を戻さない', () => {
  it('★★ stale なら失敗しても印を巻き戻さず（例外は投げ直す）。B の印が A の送った値と同じでも、A の前の値へ戻さない', async () => {
    const saved: SavedMark<string> = { current: '111111111111' }
    const d = deferredWrite()
    let stale = false
    const p = saveIfChanged(saved, '222222222222', d.write, () => stale)
    expect(saved.current).toBe('222222222222') // 書く前に進めてある
    stale = true // B へ切り替え。B の記録にも同じ ID が入っていた（印は '222222222222' のまま。前のプロジェクトで使った ID を B へ自動で入れた形）
    saved.current = '222222222222'
    d.fail(new Error('x'))
    await expect(p).rejects.toThrow('x')
    // stale を見ない従来の振る舞いなら、ここで印が '111111111111'（A の前の値）へ巻き戻る＝B の印を壊す。stale なら触らない
    expect(saved.current).toBe('222222222222')
  })

  it('isStale が false（同じプロジェクトのまま）なら従来どおり印を戻す', async () => {
    const saved: SavedMark<string> = { current: '111111111111' }
    const d = deferredWrite()
    const p = saveIfChanged(saved, '222222222222', d.write, () => false)
    d.fail(new Error('x'))
    await expect(p).rejects.toThrow('x')
    expect(saved.current).toBe('111111111111')
  })

  it('isStale は失敗を受け止めた時点で見る（始めたときではない）: 始めたときは false でも、失敗までに true になれば戻さない', async () => {
    const saved: SavedMark<string> = { current: '111111111111' }
    const d = deferredWrite()
    let calls = 0
    let stale = false // 始めたときは同じプロジェクト（始める時点の判定は通る・2026-10-07）
    const p = saveIfChanged(saved, '222222222222', d.write, () => { calls++; return stale })
    stale = true // 書いている間に切り替わった
    saved.current = '222222222222'
    d.fail(new Error('x'))
    await expect(p).rejects.toThrow('x')
    expect(calls).toBeGreaterThan(0)
    expect(saved.current).toBe('222222222222')
  })
})

describe('saveAndReport: 画面に出す知らせを決める（失敗しても投げない）', () => {
  it('書けたら { stale: false, error: null }（知らせを消す）。印は進む', async () => {
    const saved: SavedMark<string> = { current: '' }
    const { written, write } = recorder()
    const r = await saveAndReport(saved, '111111111111', write, () => false)
    expect(r).toEqual({ stale: false, error: null })
    expect(written).toEqual(['111111111111'])
    expect(saved.current).toBe('111111111111')
  })

  it('変わっていなければ書かず、{ stale: false, error: null }', async () => {
    const saved: SavedMark<string> = { current: '111111111111' }
    const { written, write } = recorder()
    expect(await saveAndReport(saved, '111111111111', write, () => false)).toEqual({ stale: false, error: null })
    expect(written).toEqual([])
  })

  it('★★ 書けなかったら { stale: false, error: メッセージ }（知らせを出す）。投げない。印は元へ戻り、次に同じ値でもう一度書こうとする', async () => {
    const saved: SavedMark<string> = { current: '' }
    const { written, write } = recorder([new Error('disk full'), null])
    const r = await saveAndReport(saved, '111111111111', write, () => false)
    expect(r).toEqual({ stale: false, error: 'disk full' })
    expect(saved.current).toBe('')
    const r2 = await saveAndReport(saved, '111111111111', write, () => false)
    expect(r2).toEqual({ stale: false, error: null })
    expect(written).toEqual(['111111111111', '111111111111'])
  })

  it('Error でない値が投げられても、文字列にして出す（message が無い・文字列そのもの）', async () => {
    const a = await saveAndReport({ current: '' }, '1', async () => { throw 'plain string' }, () => false)
    expect(a).toEqual({ stale: false, error: 'plain string' })
    const b = await saveAndReport({ current: '' }, '1', async () => { throw { message: 'from object' } }, () => false)
    expect(b).toEqual({ stale: false, error: 'from object' })
  })

  it('★★ 切り替えたあとに失敗: { stale: true }（前のプロジェクトの失敗を、新しいプロジェクトの画面に出さない）。新しいプロジェクトの印も触らない', async () => {
    // B の印が、A の送った値と違う場合と、同じ場合（前のプロジェクトで使った ID を B へ自動で入れた形）の両方
    for (const bMark of ['999999999999', '111111111111']) {
      // 1本の印を、プロジェクトをまたいで使い回す（画面と同じ）。A で保存を始め、途中で B へ切り替える
      const mark: SavedMark<string> = { current: '' }
      let current = 'A'
      const startedIn = 'A'
      const d = deferredWrite()
      const p = saveAndReport(mark, '111111111111', d.write, () => current !== startedIn)
      current = 'B' // 切り替え
      mark.current = bMark // B の初期化が、B の記録の値を印にした
      d.fail(new Error('A のディスクに書けなかった'))
      const r = await p
      expect(r).toEqual({ stale: true })
      expect(mark.current).toBe(bMark) // B の印は A の失敗で巻き戻らない
    }
  })

  it('★★ 切り替えたあとに成功: { stale: true }（B の画面の知らせを、A の成功で消さない）', async () => {
    const mark: SavedMark<string> = { current: '' }
    let current = 'A'
    const d = deferredWrite()
    const p = saveAndReport(mark, '111111111111', d.write, () => current !== 'A')
    current = 'B'
    mark.current = '999999999999'
    d.ok()
    expect(await p).toEqual({ stale: true })
    expect(mark.current).toBe('999999999999')
  })

  it('A→B→A と戻った場合は、いま開いているのが A なので stale ではない（A の失敗は A の画面に出してよい）', async () => {
    const mark: SavedMark<string> = { current: '' }
    let current = 'A'
    const d = deferredWrite()
    const p = saveAndReport(mark, '111111111111', d.write, () => current !== 'A')
    current = 'B'
    current = 'A'
    d.fail(new Error('x'))
    expect(await p).toEqual({ stale: false, error: 'x' })
    expect(mark.current).toBe('') // A の印は元へ戻る
  })

  it('判断は成功・失敗を受け取った時点で行う（始めたときに stale でなくても、待っている間に切り替われば stale）', async () => {
    const mark: SavedMark<string> = { current: '' }
    const seen: boolean[] = []
    let stale = false
    const d = deferredWrite()
    const p = saveAndReport(mark, '1', d.write, () => { seen.push(stale); return stale })
    stale = true
    d.fail(new Error('x'))
    expect(await p).toEqual({ stale: true })
    // 始める時点の判定（false＝同じプロジェクトなので書く）のあと、失敗を受け止めた時点の判定（true）で決めている。
    // 2026-10-07: 始める時点ですでに切り替わっていたら書かない判定を足したので、最初の1回は始めたときの値になる
    expect(seen[0]).toBe(false)
    expect(seen.slice(1).length).toBeGreaterThan(0)
    expect(seen.slice(1).every(v => v === true)).toBe(true)
  })
})

describe('始める時点で別のプロジェクトに切り替わっていたら、書かず印も変えない（2026-10-07 検分）', () => {
  it('★ saveIfChanged は書かない・印はそのまま', async () => {
    const saved: SavedMark<string> = { current: '222222222222' }
    const written: string[] = []
    await saveIfChanged(saved, '111111111111', async v => { written.push(v) }, () => true)
    expect(written).toEqual([])
    expect(saved.current).toBe('222222222222')
  })
  it('★ saveAndReport は stale を返し、書かない', async () => {
    const saved: SavedMark<string> = { current: '' }
    const written: string[] = []
    const r = await saveAndReport(saved, '111111111111', async v => { written.push(v) }, () => true)
    expect(r).toEqual({ stale: true })
    expect(written).toEqual([])
    expect(saved.current).toBe('')
  })
})
