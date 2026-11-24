import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { withGreetLoading, isGreetLoadingFor, abortGreetingOf, abortAllGreetings } from '../src/renderer/hooks/useGreetingState'

// P-140: あいさつの「考えています…」と ⏹ 停止は、始めたプロジェクトの印つき（掟11 環境の独立）。
const A = '/p/a'
const B = '/p/b'

describe('P-140: あいさつの生成中の印', () => {
  it('★★★ A のあいさつの最中、B を開くと出ない・A に戻ると出る', () => {
    const dirs = withGreetLoading(new Set(), A, true)
    expect(isGreetLoadingFor(dirs, B)).toBe(false)
    expect(isGreetLoadingFor(dirs, A)).toBe(true)
  })

  it('終わったら A でも出ない', () => {
    const dirs = withGreetLoading(withGreetLoading(new Set(), A, true), A, false)
    expect(isGreetLoadingFor(dirs, A)).toBe(false)
  })

  it('★★ B のあいさつが終わっても、A の印は消えない（互いに上書きしない）', () => {
    let dirs = withGreetLoading(new Set(), A, true)
    dirs = withGreetLoading(dirs, B, true)
    dirs = withGreetLoading(dirs, B, false)
    expect(isGreetLoadingFor(dirs, A)).toBe(true)
    expect(isGreetLoadingFor(dirs, B)).toBe(false)
  })

  it('開いているプロジェクトが無い（null・undefined）ときは出ない', () => {
    const dirs = withGreetLoading(new Set(), A, true)
    expect(isGreetLoadingFor(dirs, null)).toBe(false)
    expect(isGreetLoadingFor(dirs, undefined)).toBe(false)
  })
})

describe('P-140: ⏹ 停止は開いているプロジェクトのあいさつだけを止める', () => {
  it('★★★ B で押しても A のあいさつは止まらない。A で押せば止まる', () => {
    const stopped: string[] = []
    const aborts = new Map<string, () => void>([[A, () => stopped.push('A')]])
    expect(abortGreetingOf(aborts, B)).toBe(false)
    expect(stopped).toEqual([])
    expect(abortGreetingOf(aborts, A)).toBe(true)
    expect(stopped).toEqual(['A'])
  })
})

describe('P-139: チャット欄が外れるとき、走っているあいさつをすべて止める', () => {
  it('★★★ 登録されている中断関数を、プロジェクトを問わず全部呼ぶ', () => {
    const called: string[] = []
    const aborts = new Map<string, () => void>([[A, () => called.push('a')], [B, () => called.push('b')]])
    expect(abortAllGreetings(aborts)).toBe(2)
    expect(called.sort()).toEqual(['a', 'b'])
  })

  it('何も登録されていなければ何もしない', () => {
    expect(abortAllGreetings(new Map())).toBe(0)
  })

  it('★★★ 外れる後片付けとして useGreetingState が登録している（外すと、外れたあともあいさつが走り続ける）', () => {
    const src = readFileSync(join(__dirname, '..', 'src/renderer/hooks/useGreetingState.ts'), 'utf-8')
    expect(src).toContain('useEffect(() => () => { abortAllGreetings(abortsRef.current) }, [])')
  })
})
