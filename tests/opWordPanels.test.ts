import { describe, it, expect, beforeEach } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { OpProgressCard, OpForeignNote } from '../src/renderer/components/HanamiiPanel'
import { foreignBusyNote, opResultFromRecord } from '../src/renderer/components/AppRunPanel'
import { otherOpNote } from '../src/renderer/apprunDedicatedActions'
import { watchTeardownOps } from '../src/renderer/teardown/watch'
import { PUBLISH_TARGET_LABEL } from '../src/renderer/publishStatus'
import { DEDICATED_TEARDOWN_WORDS } from '../src/renderer/teardown/targets/dedicated'
import { HANAMII_TEARDOWN_WORDS } from '../src/renderer/teardown/targets/hanamii'
import { SHARED_TEARDOWN_WORDS } from '../src/renderer/teardown/targets/shared'
import * as ops from '../src/main/projectOps'
import type { OpTarget } from '../src/main/projectOps'
import { withProjectLock } from '../src/main/projectLock'

// ── 記録の op（'削除'）を画面の文にする入口は、どこも opWordFor（shared/opWord.ts）を通る（2026-10-20）──────────────────────────
// 共用型・HANAMII の破棄は「破棄」、専有型は「削除」。tests/opWord.test.ts は【公開】の結果カードと走っている枠・終了の確認。
// ここは、持ち場のパネル（HANAMII・共用型・専有型）が出す「走っている操作の枠」「別の操作が進んでいます」の1行と、
// 別の持ち場の操作を知らせる材料（watch の other）が、同じ言葉を言うことを固定する。記録は本物の main（projectOps.ts・withProjectLock）。

const DIR = '/tmp/koto-op-word-panels'
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el)
const text = (h: string) => h.replace(/<[^>]*>/g, '')

beforeEach(() => { ops.resetProjectOpsForTests() })

function running(op: '作成' | '削除' | '公開', target: OpTarget, handler: string) {
  ops.resetProjectOpsForTests()
  ops.beginOp(DIR, op, { target, handler })
  return ops.getOps(DIR).running!
}

describe('HANAMII の画面の部品', () => {
  it('★★ 走っている枠（OpProgressCard）: HANAMII の破棄は「破棄が進んでいます」、公開・作成はそのまま', () => {
    expect(text(html(createElement(OpProgressCard, { rec: running('削除', 'hanamii', 'hanamii:teardown') })))).toContain('⏳ 破棄が進んでいます')
    expect(text(html(createElement(OpProgressCard, { rec: running('公開', 'hanamii', 'hanamii:publish') })))).toContain('⏳ 公開が進んでいます')
    expect(text(html(createElement(OpProgressCard, { rec: running('作成', 'hanamii', 'hanamii:create') })))).toContain('⏳ 作成が進んでいます')
  })

  it('★★★ 別の操作の1行（OpForeignNote）: 共用型の破棄は「破棄・さくらのAppRun」、専有型は「削除・さくらのAppRun 専有型」', () => {
    const note = (op: '作成' | '削除' | '公開', target: OpTarget) => text(html(createElement(OpForeignNote, { rec: running(op, target, 'x:y') })))
    expect(note('削除', 'sakura-apprun')).toContain('別の操作（破棄・さくらのAppRun）が進んでいます')
    expect(note('削除', 'sakura-apprun-dedicated')).toContain('別の操作（削除・さくらのAppRun 専有型）が進んでいます')
    expect(note('削除', 'hanamii')).toContain('別の操作（破棄・HANAMII）が進んでいます')
    expect(note('公開', 'vercel')).toContain('別の操作（公開・Vercel）が進んでいます')
  })
})

describe('共用型の画面', () => {
  it('★★★ 別の操作の1行（foreignBusyNote）: HANAMII の破棄は「破棄」、専有型は「削除」。公開先が渡らなければ今までどおり。記録が無ければ「処理」', () => {
    expect(foreignBusyNote({ op: '削除', target: 'hanamii' })).toContain('別の操作（破棄）が進んでいます')
    expect(foreignBusyNote({ op: '削除', target: 'sakura-apprun-dedicated' })).toContain('別の操作（削除）が進んでいます')
    expect(foreignBusyNote({ op: '削除' })).toContain('別の操作（削除）が進んでいます')
    expect(foreignBusyNote({ op: '公開', target: 'vercel' })).toContain('別の操作（公開）が進んでいます')
    expect(foreignBusyNote(null)).toContain('別の操作（処理）が進んでいます')
    expect(foreignBusyNote({})).toContain('別の操作（処理）が進んでいます')
  })

  it('★★ 結果の見出し（opResultFromRecord の caption）: 共用型の破棄は「破棄の結果」、公開は「公開の結果」', () => {
    ops.beginOp(DIR, '削除', { target: 'sakura-apprun', handler: 'cloud:teardown' })
    ops.finishOp(DIR, { value: { ok: true } })
    expect(opResultFromRecord(ops.getOps(DIR).last!).caption).toMatch(/^破棄の結果/)
    ops.resetProjectOpsForTests()
    ops.beginOp(DIR, '公開', { target: 'sakura-apprun', handler: 'cloud:apply' })
    ops.finishOp(DIR, { value: { ok: true } })
    expect(opResultFromRecord(ops.getOps(DIR).last!).caption).toMatch(/^公開の結果/)
  })
})

describe('別の持ち場の操作を知らせる材料（専有型の画面の otherOpNote・破棄の流れの watch の other）', () => {
  it('★★ otherOpNote は、渡された操作の言葉をそのまま言う（言葉は材料を作る側で決める）', () => {
    expect(otherOpNote({ op: '破棄', targetLabel: PUBLISH_TARGET_LABEL.hanamii })).toContain(`別の操作（${PUBLISH_TARGET_LABEL.hanamii}の破棄）が進んでいます`)
    expect(otherOpNote({ op: '公開', targetLabel: null })).toContain('別の操作（公開）が進んでいます')
  })

  /** 別の公開先の破棄（走っている）を、破棄の流れの watch が other としてどう言うか。 */
  async function otherSeenBy(watched: 'hanamii' | 'sakura-apprun' | 'sakura-apprun-dedicated', running: OpTarget, handler: string) {
    ops.resetProjectOpsForTests()
    let release!: () => void
    const gate = new Promise<void>(open => { release = open })
    const done = withProjectLock(DIR, '削除', async () => { await gate; return { ok: true } }, { target: running, handler })
    const views: Array<{ other: { op: string; targetLabel: string | null } | null }> = []
    const api = {
      get: async (dir: string) => ops.getOps(dir),
      ack: async (dir: string, upTo: number) => { ops.ackOps(dir, upTo) },
      onChanged: () => () => {},
    } as never
    const watch = watchTeardownOps({ api, projectDir: DIR, target: watched, onRunning: v => views.push(v), onFinished: () => {} })
    await new Promise(r => setTimeout(r, 20))
    const last = views[views.length - 1]
    release(); await done
    watch.stop()
    return last?.other ?? null
  }

  it('★★★ 共用型の破棄を、専有型・HANAMII の持ち場から見ると「破棄」。HANAMII の破棄も「破棄」。専有型の削除は「削除」', async () => {
    expect(await otherSeenBy('sakura-apprun-dedicated', 'sakura-apprun', 'cloud:teardown')).toEqual({ op: '破棄', targetLabel: PUBLISH_TARGET_LABEL['sakura-apprun'] })
    expect(await otherSeenBy('sakura-apprun', 'hanamii', 'hanamii:teardown')).toEqual({ op: '破棄', targetLabel: PUBLISH_TARGET_LABEL.hanamii })
    expect(await otherSeenBy('hanamii', 'sakura-apprun-dedicated', 'apprunDedicated:teardown')).toEqual({ op: '削除', targetLabel: PUBLISH_TARGET_LABEL['sakura-apprun-dedicated'] })
  })
})

describe('3つの破棄の流れの verb は、記録を画面の言葉にする規則と同じ（opWord.test.ts と二重の網）', () => {
  it('共用型・HANAMII は「破棄」、専有型は「削除」', () => {
    expect([SHARED_TEARDOWN_WORDS.verb, HANAMII_TEARDOWN_WORDS.verb, DEDICATED_TEARDOWN_WORDS.verb]).toEqual(['破棄', '破棄', '削除'])
  })
})
