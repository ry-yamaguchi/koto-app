// B'-3d-1a: モデルの「ツール対応」「画像対応」学習キャッシュの持ち主を main へ移す
// （src/main/learningStore.ts）。convStore.test.ts（B'-3c）と同じ流儀: 実ファイル（一時フォルダ）
// で record → 読み直し・デバウンス後のファイル内容・forget・mergeMigration・壊れた learning.json
// を検証する。electron を import しない（learningStore.ts が保存先ディレクトリを差し替えられる
// ようにしてあるため、ここでは実ファイルシステムだけで完結する）。
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  initLearningStore, getLearning, recordLearning, forgetLearning, mergeMigration,
  flushLearningNow, setLearningListener, type LearningSnapshot,
} from '../src/main/learningStore'

let tmpDirs: string[] = []
function mkTmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-learningstore-'))
  tmpDirs.push(d)
  return d
}

let dir: string
beforeEach(() => {
  tmpDirs = []
  dir = mkTmpDir()
  initLearningStore(dir) // メモリをリセットし、以後この一時フォルダへ read/write する
})
afterEach(() => {
  setLearningListener(null)
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})

const learningJsonPath = () => path.join(dir, 'learning.json')

describe('learningStore: getLearning（未保存）', () => {
  it('ファイルが無ければ空のストア', () => {
    expect(getLearning()).toEqual({ toolSupport: {}, visionSupport: {} })
  })
})

describe('learningStore: recordLearning ⇄ getLearning（記録の往復）', () => {
  it('tool を記録すると読み戻せる（vision 側には影響しない）', () => {
    recordLearning('tool', 'preview/Kimi-K2.7-Code', true, 1000)
    const s = getLearning()
    expect(s.toolSupport).toEqual({ 'preview/Kimi-K2.7-Code': { supported: true, at: 1000 } })
    expect(s.visionSupport).toEqual({})
  })

  it('vision を記録すると読み戻せる（tool 側には影響しない）', () => {
    recordLearning('vision', 'modelA', false, 2000)
    const s = getLearning()
    expect(s.visionSupport).toEqual({ modelA: { supported: false, at: 2000 } })
    expect(s.toolSupport).toEqual({})
  })

  it('上書きできる（記録済みの判定が後から覆るケース）', () => {
    recordLearning('tool', 'flip-flop', false, 1000)
    recordLearning('tool', 'flip-flop', true, 2000)
    expect(getLearning().toolSupport['flip-flop']).toEqual({ supported: true, at: 2000 })
  })

  it('getLearning が返す配列は写し（呼び出し側が書き換えても内部状態は壊れない）', () => {
    recordLearning('tool', 'a', true, 1000)
    const s1 = getLearning()
    ;(s1.toolSupport as any)['a'] = { supported: false, at: 9999 }
    const s2 = getLearning()
    expect(s2.toolSupport['a']).toEqual({ supported: true, at: 1000 })
  })

  // ── 不正な kind を弾く（2026-08-30 セキュリティ点検）─────────────────────
  // IPC 越し（learning:record/forget）に想定外の kind が来ても、visionStore へ化けさせない。
  it('不正な kind の record は無視する（tool/vision どちらも汚さない）', () => {
    recordLearning('bogus' as any, 'x', true, 1000)
    const s = getLearning()
    expect(s.toolSupport).toEqual({})
    expect(s.visionSupport).toEqual({})
  })

  it('空文字のモデル名は記録しない', () => {
    recordLearning('tool', '', true, 1000)
    expect(getLearning().toolSupport).toEqual({})
  })

  it('不正な kind の forget は何もしない（既存記録を消さない）', () => {
    recordLearning('vision', 'keep', true, 1000)
    forgetLearning('bogus' as any)
    forgetLearning('bogus' as any, 'keep')
    expect(getLearning().visionSupport).toEqual({ keep: { supported: true, at: 1000 } })
  })
})

describe('learningStore: 保存（デバウンス・quit時フラッシュ・ファイルの形）', () => {
  it('record 直後はまだファイルへ書かれない（1.5秒デバウンス）', () => {
    recordLearning('tool', 'a', true)
    expect(fs.existsSync(learningJsonPath())).toBe(false)
  })

  it('flushLearningNow でデバウンスを待たずに書かれる。形は { v:1, toolSupport, visionSupport }', () => {
    recordLearning('tool', 'a', true, 1000)
    recordLearning('vision', 'b', false, 2000)
    flushLearningNow()
    expect(fs.existsSync(learningJsonPath())).toBe(true)
    const raw = JSON.parse(fs.readFileSync(learningJsonPath(), 'utf-8'))
    expect(raw).toEqual({
      v: 1,
      toolSupport: { a: { supported: true, at: 1000 } },
      visionSupport: { b: { supported: false, at: 2000 } },
    })
  })

  it('書いたファイルを読み直せる（メモリを空にしてから）', () => {
    recordLearning('tool', 'a', true, 1000)
    flushLearningNow()
    initLearningStore(dir) // メモリだけリセット（同じディレクトリ）→ 次回アクセスでファイルから読み直す
    expect(getLearning().toolSupport).toEqual({ a: { supported: true, at: 1000 } })
  })

  it('保留が無ければ flushLearningNow は何もしない（ファイルを作らない）', () => {
    flushLearningNow()
    expect(fs.existsSync(learningJsonPath())).toBe(false)
  })

  it('デバウンスタイマーで実際に書かれる', async () => {
    vi.useFakeTimers()
    try {
      recordLearning('tool', 'a', true, 1000)
      expect(fs.existsSync(learningJsonPath())).toBe(false)
      vi.advanceTimersByTime(1500)
      expect(fs.existsSync(learningJsonPath())).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('learningStore: forgetLearning（消去）', () => {
  it('モデル指定でそのモデルだけ消える（他は残る）', () => {
    recordLearning('tool', 'model-a', true)
    recordLearning('tool', 'model-b', false)
    forgetLearning('tool', 'model-a')
    const s = getLearning()
    expect(s.toolSupport['model-a']).toBeUndefined()
    expect(s.toolSupport['model-b']).toEqual({ supported: false, at: expect.any(Number) })
  })

  it('省略時はその kind だけ全消去（もう一方の kind には影響しない）', () => {
    recordLearning('tool', 'model-a', true)
    recordLearning('vision', 'model-c', true)
    forgetLearning('tool')
    const s = getLearning()
    expect(s.toolSupport).toEqual({})
    expect(s.visionSupport).toEqual({ 'model-c': { supported: true, at: expect.any(Number) } })
  })

  it('forget も保存待ちを作る（flush で反映される）', () => {
    recordLearning('tool', 'model-a', true)
    flushLearningNow()
    forgetLearning('tool', 'model-a')
    flushLearningNow()
    const raw = JSON.parse(fs.readFileSync(learningJsonPath(), 'utf-8'))
    expect(raw.toolSupport).toEqual({})
  })
})

describe('learningStore: mergeMigration（旧localStorageからの片道移行）', () => {
  it('main 側に無いモデルは取り込まれる', () => {
    mergeMigration({ toolSupport: { modelX: { supported: true, at: 1000 } } })
    expect(getLearning().toolSupport).toEqual({ modelX: { supported: true, at: 1000 } })
  })

  it('★ 新しい at だけ勝つ: main 側の記録の方が新しければ、移行データで上書きされない', () => {
    recordLearning('tool', 'modelX', false, 5000) // main 側が既に新しい記録を持っている
    mergeMigration({ toolSupport: { modelX: { supported: true, at: 1000 } } }) // 移行データは古い
    expect(getLearning().toolSupport['modelX']).toEqual({ supported: false, at: 5000 })
  })

  it('★ at が同じ（＝「新しい」わけではない）なら、移行データでは上書きされない', () => {
    recordLearning('tool', 'modelX', false, 5000)
    mergeMigration({ toolSupport: { modelX: { supported: true, at: 5000 } } })
    expect(getLearning().toolSupport['modelX']).toEqual({ supported: false, at: 5000 })
  })

  it('移行データの方が新しければ上書きされる', () => {
    recordLearning('tool', 'modelX', false, 1000)
    mergeMigration({ toolSupport: { modelX: { supported: true, at: 5000 } } })
    expect(getLearning().toolSupport['modelX']).toEqual({ supported: true, at: 5000 })
  })

  it('★ 二重適用しても結果は同じ（冪等）', () => {
    const payload = { toolSupport: { modelX: { supported: true, at: 1000 } }, visionSupport: { modelY: { supported: false, at: 2000 } } }
    mergeMigration(payload)
    const once = getLearning()
    mergeMigration(payload)
    const twice = getLearning()
    expect(twice).toEqual(once)
  })

  it('toolSupport・visionSupport 両方を同時に取り込める', () => {
    mergeMigration({
      toolSupport: { modelX: { supported: true, at: 1000 } },
      visionSupport: { modelY: { supported: false, at: 2000 } },
    })
    const s = getLearning()
    expect(s.toolSupport).toEqual({ modelX: { supported: true, at: 1000 } })
    expect(s.visionSupport).toEqual({ modelY: { supported: false, at: 2000 } })
  })

  it('壊れた形（配列・boolean欠落等）は sanitizeStore で弾かれ、例外を投げない', () => {
    expect(() => mergeMigration({ toolSupport: ['not', 'valid'], visionSupport: 'also not valid' })).not.toThrow()
    expect(getLearning()).toEqual({ toolSupport: {}, visionSupport: {} })
  })

  it('payload が空でも例外を投げない（何も変わらない）', () => {
    expect(() => mergeMigration({})).not.toThrow()
    expect(getLearning()).toEqual({ toolSupport: {}, visionSupport: {} })
  })
})

describe('learningStore: 壊れた learning.json', () => {
  it('壊れたJSONは空として扱われる（例外を投げない）', () => {
    fs.writeFileSync(learningJsonPath(), '{not valid json', 'utf-8')
    expect(() => getLearning()).not.toThrow()
    expect(getLearning()).toEqual({ toolSupport: {}, visionSupport: {} })
  })

  it('想定外の形（配列）でも空として扱われる', () => {
    fs.writeFileSync(learningJsonPath(), JSON.stringify(['not', 'an', 'object']), 'utf-8')
    expect(getLearning()).toEqual({ toolSupport: {}, visionSupport: {} })
  })

  it('壊れたファイルの上から記録すると、正常なJSONで上書きされる', () => {
    fs.writeFileSync(learningJsonPath(), '{not valid json', 'utf-8')
    recordLearning('tool', 'a', true, 1000)
    flushLearningNow()
    const raw = JSON.parse(fs.readFileSync(learningJsonPath(), 'utf-8'))
    expect(raw.toolSupport).toEqual({ a: { supported: true, at: 1000 } })
  })

  it('エントリの形が壊れていれば、そのモデルだけ無視される', () => {
    fs.writeFileSync(learningJsonPath(), JSON.stringify({
      v: 1,
      toolSupport: { good: { supported: true, at: 1000 }, bad: { supported: 'yes', at: 1000 } },
      visionSupport: {},
    }), 'utf-8')
    const s = getLearning()
    expect(s.toolSupport.good).toEqual({ supported: true, at: 1000 })
    expect(s.toolSupport.bad).toBeUndefined()
  })
})

describe('learningStore: setLearningListener（変更のたび呼ばれる押し出し口）', () => {
  it('record のたびに最新スナップショットで呼ばれる', () => {
    const calls: LearningSnapshot[] = []
    setLearningListener((s) => calls.push(s))
    recordLearning('tool', 'a', true, 1000)
    recordLearning('vision', 'b', false, 2000)
    expect(calls).toHaveLength(2)
    expect(calls[0].toolSupport).toEqual({ a: { supported: true, at: 1000 } })
    expect(calls[1].visionSupport).toEqual({ b: { supported: false, at: 2000 } })
  })

  it('forget・mergeMigration（変化があるとき）でも呼ばれる', () => {
    const calls: LearningSnapshot[] = []
    recordLearning('tool', 'a', true, 1000)
    setLearningListener((s) => calls.push(s))
    forgetLearning('tool', 'a')
    mergeMigration({ toolSupport: { c: { supported: true, at: 1000 } } })
    expect(calls).toHaveLength(2)
  })

  it('mergeMigration が何も変えなければ呼ばれない（新しいデータが無い・二重適用）', () => {
    recordLearning('tool', 'a', true, 5000)
    const calls: LearningSnapshot[] = []
    setLearningListener((s) => calls.push(s))
    mergeMigration({ toolSupport: { a: { supported: false, at: 1000 } } }) // 古いので取り込まれない
    expect(calls).toHaveLength(0)
  })

  it('setLearningListener(null) で外せる（以後は呼ばれない）', () => {
    let called = 0
    setLearningListener(() => { called++ })
    setLearningListener(null)
    recordLearning('tool', 'a', true)
    expect(called).toBe(0)
  })
})
