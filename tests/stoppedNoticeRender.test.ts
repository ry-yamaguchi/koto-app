import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// 子のパネルは本題ではないので空の部品に差し替える（公開ダイアログの上部の枠だけを描く。tests/ops-modal-behavior.test.ts と同じ）。
vi.mock('../src/renderer/components/StorageNotice', () => ({ default: () => null }))
vi.mock('../src/renderer/components/SecurityCheckSection', () => ({ default: () => null }))
vi.mock('../src/renderer/components/UnusedFilesSection', () => ({ default: () => null }))
vi.mock('../src/renderer/components/AppRunPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/components/HanamiiPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/components/VercelPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/components/VpsPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/components/AppRunDedicatedPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/publishRootRenderer', () => ({ resolvePublishRoot: async () => '' }))

import TeardownResultView from '../src/renderer/components/teardown/TeardownResultView'
import { OpFinishedCard } from '../src/renderer/components/PublishModal'
import { HanamiiTeardownResult } from '../src/renderer/components/HanamiiTeardownSection'
import { resumedTeardownNote, type TeardownResumedNote } from '../src/renderer/teardown/watch'
import { DEDICATED_TEARDOWN_WORDS } from '../src/renderer/teardown/targets/dedicated'
import { HANAMII_TEARDOWN_WORDS } from '../src/renderer/teardown/targets/hanamii'
import { SHARED_TEARDOWN_WORDS } from '../src/renderer/teardown/targets/shared'
import type { TeardownWords } from '../src/renderer/teardown/types'
import { resumedTeardownView } from '../src/shared/teardownResult'
import { stoppedNextStep } from '../src/shared/inFlightOps'
import { clockText } from '../src/shared/opsText'
import { PUBLISH_TARGET_LABEL } from '../src/renderer/publishStatus'
import type { TeardownView } from '../src/shared/teardownResult'
import { resetProjectOpsForTests } from '../src/main/projectOps'
import { stoppedNotice, type NoticeTarget } from './stoppedNoticeHarness'

// ── 「Koto の終了で止まりました」の知らせを、実際に HTML へ描いて確かめる（設計書 10.13.9・10.13.12 の N1・N3・N4・N6）─────────
// 知らせの記録は、本物の projectOps（起動の読み戻し）が置いたもの（tests/stoppedNoticeHarness.ts）。部品は本物の react-dom/server で描く。
// 見ること:
//   ・結果欄（共通の TeardownResultView）: 途中の見出し・次の操作の案内。失敗ではないので「AIに相談する」を出さない（N1）
//   ・知らせの見出し（📡 の行・専有型）: 「に終わりました」と言わない。同じ文が1つの画面で2回出ない（N2・N4）
//   ・公開ダイアログの上部の枠: 見出しが「止まりました」で、「に終わりました」の行は出ない（N3）
//   ・HANAMII の結果欄の見出し（N6）
// 共用型の結果欄の見出しは tests/ops-shared-pure.test.ts（opResultFromRecord を直接。N5）。

const DIR = '/tmp/koto-stopped-notice-render'
const FINISHED = new Date(2026, 9, 10, 14, 9).getTime()
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el)
const text = (h: string) => h.replace(/<[^>]*>/g, '')
const count = (s: string, part: string) => s.split(part).length - 1

const WORDS_OF: Record<NoticeTarget, TeardownWords> = {
  'sakura-apprun-dedicated': DEDICATED_TEARDOWN_WORDS,
  'sakura-apprun': SHARED_TEARDOWN_WORDS,
  hanamii: HANAMII_TEARDOWN_WORDS,
}
const TARGETS: NoticeTarget[] = ['sakura-apprun-dedicated', 'sakura-apprun', 'hanamii']

beforeEach(() => { resetProjectOpsForTests() })

/** 入口が渡す材料（結果欄・知らせ）。「AIに相談する」を出せる入口として描く（出ないことを確かめるため）。 */
function renderResult(target: NoticeTarget, notes: TeardownResumedNote[] = [], over: { onAskAi?: (t: string) => void; view?: TeardownView } = {}): string {
  const rec = stoppedNotice(DIR, target, FINISHED)
  return html(createElement(TeardownResultView, {
    view: over.view ?? resumedTeardownView(target, rec.result), notes, words: WORDS_OF[target], retryHint: '手順6',
    serviceConsoleUrl: 'https://service.example/', storageConsoleUrl: 'https://storage.example/',
    onAskAi: over.onAskAi ?? (() => {}),
  }))
}

describe('N1: 結果欄 — 知らせは途中の見出し。失敗ではないので「AIに相談する」を出さない', () => {
  it.each(TARGETS)('★★ %s: 途中の見出し（黄色）と、次の操作の案内を出す。失敗の見出し・「AIに相談する」・赤い欄は出ない', target => {
    const h = renderResult(target)
    const t = text(h)
    const w = WORDS_OF[target]
    expect(t).toContain(w.inProgressHeadline)
    expect(h).toContain(`<p class="text-xs font-semibold text-brand-yellow">${w.inProgressHeadline}</p>`)
    expect(t).toContain(stoppedNextStep(target))
    // 次の操作の案内は、その行のボタンの名前で言う（専有型「削除」・共用型と HANAMII「破棄」）
    const verb = w.rowButton.replace('🗑 ', '')
    expect(stoppedNextStep(target)).toContain(`もう一度${verb}を押`)
    expect(t).not.toContain(w.failedHeadline)
    expect(t).not.toContain(w.doneHeadline)
    expect(t, '失敗ではないので相談の入口を出さない').not.toContain('AIに相談する')
    expect(t).not.toContain('課金が続きます')
    expect(t).not.toContain('できずに残っているものがあります')
  })

  it('★ 失敗の結果（stoppedByQuit が無い）には、今までどおり「AIに相談する」が出る（出し分けは stoppedByQuit だけ）', () => {
    const view = resumedTeardownView('hanamii', { ok: false, message: '失敗しました', lines: [], warnings: [], extra: {} })
    const h = html(createElement(TeardownResultView, {
      view, notes: [], words: HANAMII_TEARDOWN_WORDS, retryHint: 'x', serviceConsoleUrl: 'https://a/', storageConsoleUrl: 'https://b/', onAskAi: () => {},
    }))
    expect(text(h)).toContain('AIに相談する')
  })
})

describe('N2・N4: 知らせの見出し（結果欄の上）— 「に終わりました」と言わず、同じ文を1つの画面で2回出さない', () => {
  it.each(TARGETS)('★★ %s: 見出しは「Koto の終了で止まりました（HH:MM ごろ）」。次の操作の案内は1回だけ。「に終わりました」「失敗しました」は出ない', target => {
    const rec = stoppedNotice(DIR, target, FINISHED)
    const note = resumedTeardownNote(WORDS_OF[target], rec)
    const t = text(renderResult(target, [note]))
    expect(t).toContain(`🔔 ${WORDS_OF[target].verb}は、Koto の終了で止まりました（${clockText(FINISHED)} ごろ）`)
    expect(t).not.toContain('に終わりました')
    expect(t).not.toContain('失敗しました')
    expect(count(t, 'Koto の終了で止まりました'), '見出しの言い回しが2回出ている').toBe(1)
    expect(count(t, stoppedNextStep(target)), '次の操作の案内が2回出ている').toBe(1)
  })

  it('★★ 知らせが最新でない（後ろに別の記録がある）ときも、「失敗しました」とは言わず、次の操作の案内だけを出す', () => {
    const rec = stoppedNotice(DIR, 'sakura-apprun-dedicated', FINISHED)
    const stopped = resumedTeardownNote(DEDICATED_TEARDOWN_WORDS, rec)
    const later = resumedTeardownNote(DEDICATED_TEARDOWN_WORDS, {
      ...rec, startedAt: rec.startedAt + 1, finishedAt: FINISHED + 60_000,
      result: { ok: true, message: '', lines: [], warnings: [], extra: {} },
    } as never)
    // 結果欄が描くのは最新の記録（後ろの成功）。止まった知らせは古い知らせとして、案内だけを出す。
    const t = text(renderResult('sakura-apprun-dedicated', [stopped, later], { view: resumedTeardownView('sakura-apprun-dedicated', { ok: true, message: '', lines: [], warnings: [], extra: {} }) }))
    expect(t).toContain('Koto の終了で止まりました')
    expect(t).toContain(stoppedNextStep('sakura-apprun-dedicated'))
    expect(t, '止まった知らせを失敗と言っている').not.toContain('⚠️ 失敗しました')
    expect(count(t, stoppedNextStep('sakura-apprun-dedicated'))).toBe(1)
  })

  it('知らせでない古い失敗の記録は、今までどおり「失敗しました」と言う（出し分けは stoppedByQuit だけ）', () => {
    const rec = stoppedNotice(DIR, 'hanamii', FINISHED)
    const failedNote = resumedTeardownNote(HANAMII_TEARDOWN_WORDS, { ...rec, result: { ok: false, message: '断られた', lines: [], warnings: [], extra: {} } } as never)
    const t = text(renderResult('hanamii', [failedNote, { ...failedNote, startedAt: failedNote.startedAt + 1 }]))
    expect(t).toContain('⚠️ 失敗しました。 断られた')
  })
})

describe('N3: 公開ダイアログの上部の枠 — 見出しは「止まりました」で、「に終わりました」の行は出さない', () => {
  it.each(TARGETS)('★★ %s: 枠の見出しは「⏳ {公開先}の{破棄|削除}は、Koto の終了で止まりました」（言葉は破棄の流れの words.verb と同じ）', target => {
    const label = PUBLISH_TARGET_LABEL[target]
    const rec = stoppedNotice(DIR, target, FINISHED)
    const h = html(createElement(OpFinishedCard, { rec }))
    const t = text(h)
    expect(t).toContain(`⏳ ${label}の${WORDS_OF[target].verb}は、Koto の終了で止まりました`)
    expect(t).not.toContain('に終わりました')
    expect(t).not.toContain('に失敗しました')
    expect(t).not.toContain('が終わりました')
    expect(t).not.toContain('結果を読み取れませんでした')
    // 次の操作の案内（記録の message）は出す。同じ文は1回だけ。
    expect(count(t, stoppedNextStep(target))).toBe(1)
    expect(count(t, 'Koto の終了で止まりました'), '見出しの言い回しが2回出ている').toBe(1)
  })

  it('★ 知らせでない記録の枠は今までどおり（失敗は「に失敗しました」と、時刻の行「に終わりました」）', () => {
    const rec = stoppedNotice(DIR, 'hanamii', FINISHED)
    const failed = { ...rec, result: { ok: false, message: '断られた', lines: [], warnings: [], extra: {} } } as never
    const t = text(html(createElement(OpFinishedCard, { rec: failed })))
    expect(t).toContain(`⚠️ ${PUBLISH_TARGET_LABEL.hanamii}の${HANAMII_TEARDOWN_WORDS.verb}に失敗しました`)
    expect(t).toContain('に終わりました')
    expect(t).not.toContain('Koto の終了で止まりました')
  })
})

describe('N6: HANAMII の結果欄 — 見出しは「破棄の結果（HH:MM ごろ、Koto の終了で止まりました）」', () => {
  it('★★ 知らせの記録: 「に始まった操作」と言わず、最後に分かった時刻で言う。結果欄は途中の見出しで、「AIに相談する」は出ない', () => {
    const rec = stoppedNotice(DIR, 'hanamii', FINISHED)
    const h = html(createElement(HanamiiTeardownResult, { rec }))
    const t = text(h)
    expect(t).toContain(`🗑 破棄の結果（${clockText(FINISHED)} ごろ、Koto の終了で止まりました）`)
    expect(t).not.toContain('に始まった操作')
    expect(t).not.toContain('に終わりました')
    expect(t).toContain(HANAMII_TEARDOWN_WORDS.inProgressHeadline)
    expect(t).not.toContain('AIに相談する')
    expect(count(t, 'Koto の終了で止まりました')).toBe(1)
  })

  it('★ 知らせでない記録の見出しは今までのまま（「HH:MM に始まった操作」）', () => {
    const rec = stoppedNotice(DIR, 'hanamii', FINISHED)
    const plain = { ...rec, startedAt: FINISHED - 60_000, result: { ok: true, message: '', lines: [], warnings: [], extra: {} } } as never
    const t = text(html(createElement(HanamiiTeardownResult, { rec: plain })))
    expect(t).toContain(`🗑 破棄の結果（${clockText(FINISHED - 60_000)} に始まった操作）`)
    expect(t).not.toContain('Koto の終了で止まりました')
  })
})
