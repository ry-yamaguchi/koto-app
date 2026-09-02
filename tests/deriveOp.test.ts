import { describe, it, expect } from 'vitest'
import { deriveOp } from '../src/renderer/components/ChatApp'

// ChatApp の「画面の状態差分 → convStore の Op」翻訳（B'-3e-a）。
// updateShown（useAiChat の直呼び）の before/after から永続化の Op を再構成する。
const m = (content: string) => ({ role: 'assistant' as const, content })

describe('deriveOp', () => {
  it('★★ 1件増えたら append（増えた末尾を送る）', () => {
    const a = [m('a')], b = [m('a'), m('b')]
    expect(deriveOp(a as any, b as any)).toEqual({ kind: 'append', msg: b[1] })
  })
  it('★★ 1件減ったら removeLast', () => {
    expect(deriveOp([m('a'), m('b')] as any, [m('a')] as any)).toEqual({ kind: 'removeLast' })
  })
  it('★★ 同数で末尾だけ変わったら replaceLast', () => {
    const shared = m('a')
    expect(deriveOp([shared, m('b')] as any, [shared, m('b2')] as any)).toEqual({ kind: 'replaceLast', msg: m('b2') })
  })
  it('★★ 同数でも末尾以外が変わっていたら replaceAll（replaceLast の嘘を送らない・安全側）', () => {
    const before = [m('a'), m('b')]
    const after = [m('a2'), m('b')]
    expect(deriveOp(before as any, after as any)).toEqual({ kind: 'replaceAll', messages: after })
  })
  it('★ 空→空は null（何も送らない）', () => {
    expect(deriveOp([] as any, [] as any)).toBeNull()
  })
  it('★ 想定外の複数件変化は replaceAll（取りこぼすより丸ごと・安全側）', () => {
    const after = [m('a'), m('b'), m('c')]
    expect(deriveOp([] as any, after as any)).toEqual({ kind: 'replaceAll', messages: after })
  })
})
