import { describe, it, expect, vi, beforeEach } from 'vitest'
import { splitFailureDetail } from '../src/shared/failureDetail'
import { PUBLISH_TARGET_LABEL } from '../src/renderer/publishStatus'
import { teardownPublished } from '../src/renderer/teardown/projectDelete'

// プロジェクトの削除で、公開先の破棄が失敗した行（step.line）に付く詳細（原文）の位置を固める。
// 「…。<あとの公開先は始めていません>」の注が付く回でも、詳細は文の途中に挟まらず、最後の1行に来る。
// 破棄の流れそのもの（runTeardownFlow）は代役にし、投げる回と、詳細つきの文を返す回を作る。

const flow = vi.hoisted(() => ({ next: null as null | (() => Promise<unknown>) }))
vi.mock('../src/renderer/teardown/flow', () => ({
  runTeardownFlow: () => flow.next!(),
  electronFlowDeps: () => ({}),
}))

const HANAMII = PUBLISH_TARGET_LABEL.hanamii
const APPRUN = PUBLISH_TARGET_LABEL['sakura-apprun']
const ctx = { confirm: async () => true, confirmWithChoices: async () => ({ confirmed: false, choices: {} }) } as any
const SENTENCE = '通信が途中で切れました。操作が済んだかは確かめられていません。'

beforeEach(() => { flow.next = null })

describe('公開先の破棄が投げた回（teardownFailureText の行）', () => {
  it('「…始めていません」の注のあとの最後の行に原文が付く。文の途中には入らない', async () => {
    flow.next = async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) }
    const steps = await teardownPublished('/p', ['hanamii', 'sakura-apprun'], ctx)
    expect(steps).toHaveLength(1)
    const line = (steps[0] as any).line as string
    const { text, detail } = splitFailureDetail(line)
    expect(text.startsWith(`${HANAMII}: 通信が途中で切れました。`)).toBe(true)
    expect(text.endsWith(`。${APPRUN}の破棄も始めていません`)).toBe(true)
    expect(text).not.toContain('詳細: ')
    expect(detail).toContain('socket hang up')
  })

  it('原文の無い（見分けられない）失敗には詳細を重ねない', async () => {
    flow.next = async () => { throw new Error('想定外') }
    const steps = await teardownPublished('/p', ['hanamii'], ctx)
    expect((steps[0] as any).line).toBe(`${HANAMII}: 想定外`)
  })
})

describe('HANAMII の結果が ok:false で、文に詳細が付いて届いた回', () => {
  it('詳細は「…始めていません」の注のあとへ移る（文の途中に挟まらない）', async () => {
    flow.next = async () => ({ cancelled: false, result: { ok: false, message: `${SENTENCE}\n詳細: getaddrinfo ENOTFOUND hanamii.jp` } })
    const steps = await teardownPublished('/p', ['hanamii', 'sakura-apprun'], ctx)
    const line = (steps[0] as any).line as string
    const { text, detail } = splitFailureDetail(line)
    expect(text).toBe(`${HANAMII}: 通信が途中で切れました。操作が済んだかは確かめられていません${'。'}${APPRUN}の破棄も始めていません`)
    expect(detail).toBe('getaddrinfo ENOTFOUND hanamii.jp')
  })
})
