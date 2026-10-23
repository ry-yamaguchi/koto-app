import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// 子のパネルは本題ではないので空の部品に差し替える（公開ダイアログの結果カードだけを描く。tests/stoppedNoticeRender.test.ts と同じ）。
vi.mock('../src/renderer/components/StorageNotice', () => ({ default: () => null }))
vi.mock('../src/renderer/components/SecurityCheckSection', () => ({ default: () => null }))
vi.mock('../src/renderer/components/UnusedFilesSection', () => ({ default: () => null }))
vi.mock('../src/renderer/components/AppRunPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/components/HanamiiPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/components/VercelPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/components/VpsPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/components/AppRunDedicatedPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/publishRootRenderer', () => ({ resolvePublishRoot: async () => '' }))

import { opWordFor } from '../src/shared/opWord'
import { teardownSupport } from '../src/shared/teardownSupport'
import { OpFinishedCard, OpRunningCard, opHeadlineSubject } from '../src/renderer/components/PublishModal'
import { PUBLISH_TARGET_LABEL } from '../src/renderer/publishStatus'
import { DEDICATED_TEARDOWN_WORDS } from '../src/renderer/teardown/targets/dedicated'
import { HANAMII_TEARDOWN_WORDS } from '../src/renderer/teardown/targets/hanamii'
import { SHARED_TEARDOWN_WORDS } from '../src/renderer/teardown/targets/shared'
import { quitGuardDecision } from '../src/main/quitGuard'
import * as ops from '../src/main/projectOps'
import type { OpTarget } from '../src/main/projectOps'
import { stoppedNotice, type NoticeTarget } from './stoppedNoticeHarness'

// ── 記録の op（'削除'）を画面の言葉にする（0.6.22-rc.3 の実機・2026-10-20）────────────────────────────────
// main の記録は、共用型・HANAMII の「破棄」も専有型の「削除」も '削除' で持つ。画面がそのまま文にすると、共用型の破棄のあとの
// 【公開】の結果カードが「さくらのAppRunの削除は終わりましたが…」と出て、破棄の流れ（確認・進み具合・結果）の「破棄」と割れた
// （決定 D3: 共用型・HANAMII は「破棄」、専有型は「削除」。1回の流れの中は1つの言葉）。
// 言葉を決める唯一の定義は shared/opWord.ts の opWordFor。ここは、その全分岐と、破棄の流れの仕様（targets/*.ts の words.verb）との一致、
// 記録を画面の文にする入口（結果カード・走っている枠・終了の確認・始まりの1行）が同じ答えを言うことを固定する。
// 記録は本物の main（projectOps.ts）で作る——偽の形を手で書かない。

const DIR = '/tmp/koto-op-word'
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el)
const text = (h: string) => h.replace(/<[^>]*>/g, '')

beforeEach(() => { ops.resetProjectOpsForTests() })

/** 本物の記録を1件、終わらせて返す（結果は渡したとおり）。 */
function finished(op: '作成' | '削除' | '公開', target: OpTarget, handler: string, value: Record<string, unknown>) {
  ops.resetProjectOpsForTests()
  ops.beginOp(DIR, op, { target, handler })
  ops.finishOp(DIR, { value })
  return ops.getOps(DIR).last!
}

const TARGETS = ['sakura-apprun', 'sakura-apprun-dedicated', 'hanamii', 'sakura-rental', 'vercel'] as const

describe('opWordFor: 全分岐', () => {
  it('★★★ 「削除」は、共用型・HANAMII が「破棄」、専有型・レンタルサーバ・Vercel が「削除」', () => {
    expect(opWordFor('削除', 'sakura-apprun')).toBe('破棄')
    expect(opWordFor('削除', 'hanamii')).toBe('破棄')
    expect(opWordFor('削除', 'sakura-apprun-dedicated')).toBe('削除')
    expect(opWordFor('削除', 'sakura-rental')).toBe('削除')
    expect(opWordFor('削除', 'vercel')).toBe('削除')
  })

  it('★★ 公開先が分からない・読めない値は「削除」（推測で「破棄」と言わない）。Object.prototype 由来の名前も、公開先として扱わない', () => {
    for (const t of ['unknown', '', 'constructor', 'toString', '__proto__', 'hasOwnProperty', 'SAKURA-APPRUN', ' hanamii', undefined, null]) {
      expect(opWordFor('削除', t as never), String(t)).toBe('削除')
    }
    expect(opWordFor('削除')).toBe('削除')
  })

  it('★★ 「公開」「作成」は、どの公開先でもそのまま。知らない操作名もそのまま返す', () => {
    for (const t of [...TARGETS, 'unknown', undefined]) {
      expect(opWordFor('公開', t), String(t)).toBe('公開')
      expect(opWordFor('作成', t), String(t)).toBe('作成')
    }
    expect(opWordFor('処理', 'sakura-apprun')).toBe('処理')
    expect(opWordFor('', 'hanamii')).toBe('')
  })

  it('★★★ 破棄の流れの仕様（words.verb）と同じ答え。食い違えば、確認・結果の言葉と割れる', () => {
    expect(opWordFor('削除', 'sakura-apprun')).toBe(SHARED_TEARDOWN_WORDS.verb)
    expect(opWordFor('削除', 'hanamii')).toBe(HANAMII_TEARDOWN_WORDS.verb)
    expect(opWordFor('削除', 'sakura-apprun-dedicated')).toBe(DEDICATED_TEARDOWN_WORDS.verb)
  })

  it('★ Koto から破棄できる3つの公開先は、破棄の流れの verb と同じ。破棄の口が無い公開先は「削除」', () => {
    const verbOf: Record<string, string> = {
      'sakura-apprun': SHARED_TEARDOWN_WORDS.verb, hanamii: HANAMII_TEARDOWN_WORDS.verb, 'sakura-apprun-dedicated': DEDICATED_TEARDOWN_WORDS.verb,
    }
    for (const t of TARGETS) {
      expect(opWordFor('削除', t), t).toBe(teardownSupport(t) === 'supported' ? verbOf[t] : '削除')
    }
  })
})

describe('【公開】の結果カード（OpFinishedCard）の見出し: 同じ流れの確認・結果と同じ言葉', () => {
  const KEPT = { ok: true, keptBucketName: 'koto-data-bucket', executed: ['アプリを削除しました'] }

  it('★★★ 共用型の破棄（警告つき）: 「⚠️ 📦 さくらのAppRunの破棄は終わりましたが、確認が必要なことがあります」（📦 は公開先の絵文字）。「削除」とは言わない', () => {
    const t = text(html(createElement(OpFinishedCard, { rec: finished('削除', 'sakura-apprun', 'cloud:teardown', KEPT) })))
    expect(t).toContain('⚠️ 📦 さくらのAppRunの破棄は終わりましたが、確認が必要なことがあります')
    expect(t).not.toContain('さくらのAppRunの削除')
  })

  it('★★ 共用型の破棄: 警告なしの成功は「✅ …の破棄が終わりました」、失敗は「⚠️ …の破棄に失敗しました」', () => {
    const ok = text(html(createElement(OpFinishedCard, { rec: finished('削除', 'sakura-apprun', 'cloud:teardown', { ok: true }) })))
    expect(ok).toContain('✅ 📦 さくらのAppRunの破棄が終わりました')
    const bad = text(html(createElement(OpFinishedCard, { rec: finished('削除', 'sakura-apprun', 'cloud:teardown', { ok: false, message: '失敗' }) })))
    expect(bad).toContain('⚠️ 📦 さくらのAppRunの破棄に失敗しました')
  })

  it('★★ HANAMII の破棄は「破棄」', () => {
    const t = text(html(createElement(OpFinishedCard, { rec: finished('削除', 'hanamii', 'hanamii:teardown', KEPT) })))
    expect(t).toContain(`⚠️ ${PUBLISH_TARGET_LABEL.hanamii}の破棄は終わりましたが、確認が必要なことがあります`)
    expect(t).not.toContain(`${PUBLISH_TARGET_LABEL.hanamii}の削除`)
  })

  it('★★ 専有型の削除は「削除」のまま', () => {
    const t = text(html(createElement(OpFinishedCard, { rec: finished('削除', 'sakura-apprun-dedicated', 'apprunDedicated:teardown', { ok: true }) })))
    expect(t).toContain(`✅ ${PUBLISH_TARGET_LABEL['sakura-apprun-dedicated']}の削除が終わりました`)
    expect(t).not.toContain('破棄')
  })

  it('★★ 公開・作成はそのまま。公開先が分からない記録は「このプロジェクトの」と言い、削除は「削除」', () => {
    const pub = text(html(createElement(OpFinishedCard, { rec: finished('公開', 'hanamii', 'hanamii:publish', { ok: true }) })))
    expect(pub).toContain(`✅ ${PUBLISH_TARGET_LABEL.hanamii}の公開が終わりました`)
    const made = text(html(createElement(OpFinishedCard, { rec: finished('作成', 'sakura-apprun-dedicated', 'apprunDedicated:create', { ok: true }) })))
    expect(made).toContain(`✅ ${PUBLISH_TARGET_LABEL['sakura-apprun-dedicated']}の作成が終わりました`)
    const unknown = text(html(createElement(OpFinishedCard, { rec: finished('削除', 'unknown', 'test:hold', { ok: true }) })))
    expect(unknown).toContain('✅ このプロジェクトの削除が終わりました')
  })

  it.each(['sakura-apprun', 'hanamii', 'sakura-apprun-dedicated'] as NoticeTarget[])('★★ %s: 「Koto の終了で止まりました」の見出しも、破棄の流れの verb と同じ', target => {
    const words = { 'sakura-apprun': SHARED_TEARDOWN_WORDS, hanamii: HANAMII_TEARDOWN_WORDS, 'sakura-apprun-dedicated': DEDICATED_TEARDOWN_WORDS }[target]
    const t = text(html(createElement(OpFinishedCard, { rec: stoppedNotice(DIR, target, Date.now()) })))
    expect(t).toContain(`⏳ ${PUBLISH_TARGET_LABEL[target]}の${words.verb}は、Koto の終了で止まりました`)
  })
})

describe('走っている枠（OpRunningCard）・見出しの主語（opHeadlineSubject）', () => {
  function running(op: '作成' | '削除' | '公開', target: OpTarget, handler: string) {
    ops.resetProjectOpsForTests()
    ops.beginOp(DIR, op, { target, handler })
    return ops.getOps(DIR).running!
  }

  it('★★★ 共用型の破棄が走っている: 「⏳ 📦 さくらのAppRunの破棄が進んでいます」。HANAMII も「破棄」、専有型は「削除」', () => {
    const shared = text(html(createElement(OpRunningCard, { rec: running('削除', 'sakura-apprun', 'cloud:teardown') })))
    expect(shared).toContain('⏳ 📦 さくらのAppRunの破棄が進んでいます')
    const hanamii = text(html(createElement(OpRunningCard, { rec: running('削除', 'hanamii', 'hanamii:teardown') })))
    expect(hanamii).toContain(`⏳ ${PUBLISH_TARGET_LABEL.hanamii}の破棄が進んでいます`)
    const dedicated = text(html(createElement(OpRunningCard, { rec: running('削除', 'sakura-apprun-dedicated', 'apprunDedicated:teardown') })))
    expect(dedicated).toContain(`⏳ ${PUBLISH_TARGET_LABEL['sakura-apprun-dedicated']}の削除が進んでいます`)
  })

  it('★★ 始まりの1行（記録が最初に置く進み具合）も同じ言葉。「削除を始めています…」と言わない', () => {
    expect(text(html(createElement(OpRunningCard, { rec: running('削除', 'sakura-apprun', 'cloud:teardown') })))).toContain('破棄を始めています…')
    expect(text(html(createElement(OpRunningCard, { rec: running('削除', 'hanamii', 'hanamii:teardown') })))).toContain('破棄を始めています…')
    expect(text(html(createElement(OpRunningCard, { rec: running('削除', 'sakura-apprun-dedicated', 'apprunDedicated:teardown') })))).toContain('削除を始めています…')
    expect(text(html(createElement(OpRunningCard, { rec: running('公開', 'hanamii', 'hanamii:publish') })))).toContain('公開を始めています…')
  })

  it('opHeadlineSubject は 公開先の名前 + の + opWordFor（結果カードと走っている枠の主語は1つ）', () => {
    for (const t of TARGETS) {
      const rec = running('削除', t, 'test:hold')
      expect(opHeadlineSubject(rec), t).toBe(`${PUBLISH_TARGET_LABEL[t]}の${opWordFor('削除', t)}`)
    }
  })
})

describe('Koto を終了するときの確認（quitGuardDecision）も同じ言葉', () => {
  it('★★ 共用型・HANAMII の破棄が進行中なら「破棄が進行中です」。専有型は「削除」。target が渡らなければ今までどおり「削除」', () => {
    const d = (op: '作成' | '削除' | '公開', target?: OpTarget) =>
      (quitGuardDecision([{ projectDir: '/Users/a/Projects/site', op, ...(target ? { target } : {}) }]) as { detail: string }).detail
    expect(d('削除', 'sakura-apprun')).toContain('「site」の破棄が進行中です')
    expect(d('削除', 'hanamii')).toContain('「site」の破棄が進行中です')
    expect(d('削除', 'sakura-apprun-dedicated')).toContain('「site」の削除が進行中です')
    expect(d('削除')).toContain('「site」の削除が進行中です')
    expect(d('公開', 'hanamii')).toContain('「site」の公開が進行中です')
  })
})
