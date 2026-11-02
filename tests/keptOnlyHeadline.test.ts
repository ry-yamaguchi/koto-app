import { describe, it, expect, beforeEach } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import TeardownResultView from '../src/renderer/components/teardown/TeardownResultView'
import ProjectDeleteResults from '../src/renderer/components/teardown/ProjectDeleteResults'
import { SharedTeardownResultView } from '../src/renderer/components/SharedTeardownSection'
import { HanamiiTeardownResult } from '../src/renderer/components/HanamiiTeardownSection'
import { ResumedNotesView as DedicatedNotesView } from '../src/renderer/components/DedicatedOpsParts'
import { teardownHeadlineOf, everyDoneStepKeptOnly } from '../src/renderer/teardown/headline'
import { resumedTeardownNote } from '../src/renderer/teardown/watch'
import { HANAMII_TEARDOWN_WORDS } from '../src/renderer/teardown/targets/hanamii'
import { SHARED_TEARDOWN_WORDS } from '../src/renderer/teardown/targets/shared'
import { DEDICATED_TEARDOWN_WORDS } from '../src/renderer/teardown/targets/dedicated'
import type { TeardownWords } from '../src/renderer/teardown/types'
import type { ProjectDeletePhase } from '../src/renderer/teardown/projectDelete'
import type { ProjectDeleteStep } from '../src/renderer/teardown/projectDeletePlan'
import { toTeardownView, resumedTeardownView, type TeardownView } from '../src/shared/teardownResult'
import { teardownCallLine } from '../src/shared/teardownCall'
import { teardownRemainingWarnings } from '../src/shared/cloudCost'
import * as ops from '../src/main/projectOps'

// ── 0.6.25: 見出し・総括・開き直しの一言を、keptOnly（何も消さなかった）で言い分ける（T-2c の一言・T-2d・T-2e）──────────────────────
// 見出しの選びは renderer/teardown/headline.ts の1つ。結果の描き口（【公開】3つ・📡 の3行・プロジェクトの削除）はすべて TeardownResultView を通る。
// 本物の React で HTML にして見る（文の期待は、関数を通さず書き下す）。view は本物の toTeardownView が返す形（main が keptOnly の回に返す形）から作る。
// 専有型の画面（手順6）は tests/keptOnlyHeadlineDedicated.test.ts、実際の流れ（本物の main）は tests/keptOnlyFlow.test.ts。

const ROOT = join(__dirname, '..')
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el)
const text = (s: string) => s.replace(/<[^>]*>/g, '')
const count = (s: string, part: string) => s.split(part).length - 1

/** main が keptOnly の回に返す形（保存場所が複製のため、データにも手を付けず残した）。 */
const KEPT_REPLY = {
  ok: true, appDeleted: true, executed: ['保存場所『koto-data-a』のデータは残しました — フォルダ『myapp copy』も同じデータを使っています。'],
  keptBucketName: 'koto-data-a', keptBucketNames: ['koto-data-a'], keptBucketsUsedByOthers: ['koto-data-a'], keptOnly: true,
}
/** 保存場所を残したが、ほかは消した回（keptOnly の印は付かない。専有型の「すべて」を言い換える回）。 */
const { keptOnly: _mark, ...KEPT_BUT_DELETED_REPLY } = { ...KEPT_REPLY, executed: ['アプリを削除しました', '保存場所『koto-data-a』のデータは残しました'] }
const ALL_GONE_REPLY = { ok: true, appDeleted: true, executed: ['クラスタ『c-1』を削除しました'] }

const SHARED = 'sakura-apprun' as const
const DEDICATED = 'sakura-apprun-dedicated' as const
const WORDS_OF = { [SHARED]: SHARED_TEARDOWN_WORDS, [DEDICATED]: DEDICATED_TEARDOWN_WORDS, hanamii: HANAMII_TEARDOWN_WORDS }

const baseView = (over: Partial<TeardownView> = {}): TeardownView => ({
  ok: true, state: 'done', appDeleted: true, executed: [], message: '', remaining: [], inProgress: [], warnings: [], stageTimings: null, ...over,
})
const render = (view: TeardownView | null, words: TeardownWords, extra: Record<string, unknown> = {}) => html(createElement(TeardownResultView, {
  view, notes: [], words, retryHint: 'この一覧の 🗑 破棄', serviceConsoleUrl: 'https://service.example/', storageConsoleUrl: 'https://storage.example/', ...extra,
}))

// ═══════════════════════════════════════════════════════════════════════════════
describe('3つの公開先の言葉: 見出しの文', () => {
  it('★★★ keptHeadline は3つとも持つ。共用型・HANAMII は「⚠️ 破棄していません」・専有型は「⚠️ 削除していません」', () => {
    expect(SHARED_TEARDOWN_WORDS.keptHeadline).toBe('⚠️ 破棄していません')
    expect(HANAMII_TEARDOWN_WORDS.keptHeadline).toBe('⚠️ 破棄していません')
    expect(DEDICATED_TEARDOWN_WORDS.keptHeadline).toBe('⚠️ 削除していません')
  })

  it('★★★ 保存場所を残した回の専用の見出しは専有型だけ（「✅ 削除しました」）。共用型・HANAMII は持たない', () => {
    expect(DEDICATED_TEARDOWN_WORDS.doneKeptStorageHeadline).toBe('✅ 削除しました')
    expect(SHARED_TEARDOWN_WORDS.doneKeptStorageHeadline).toBeUndefined()
    expect(HANAMII_TEARDOWN_WORDS.doneKeptStorageHeadline).toBeUndefined()
  })

  it('★★ 今までの見出しは変えない', () => {
    expect(SHARED_TEARDOWN_WORDS.doneHeadline).toBe('✅ 破棄しました')
    expect(HANAMII_TEARDOWN_WORDS.doneHeadline).toBe('✅ 破棄しました')
    expect(DEDICATED_TEARDOWN_WORDS.doneHeadline).toBe('✅ すべて削除しました')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
describe('teardownHeadlineOf: 見出しの選びの全分岐（純関数）', () => {
  const W = { ...SHARED_TEARDOWN_WORDS, doneKeptStorageHeadline: undefined } as TeardownWords
  const WD = DEDICATED_TEARDOWN_WORDS

  it('★★★ 済んだ・keptOnly → keptHeadline（黄）。緑にしない', () => {
    expect(teardownHeadlineOf({ state: 'done', keptOnly: true }, W)).toEqual({ text: '⚠️ 破棄していません', tone: 'yellow' })
    expect(teardownHeadlineOf({ state: 'done', keptOnly: true }, WD)).toEqual({ text: '⚠️ 削除していません', tone: 'yellow' })
  })

  it('★★★ 済んだ・keptOnly でない → 今までの見出し（緑）', () => {
    expect(teardownHeadlineOf({ state: 'done' }, W)).toEqual({ text: '✅ 破棄しました', tone: 'green' })
    expect(teardownHeadlineOf({ state: 'done' }, WD)).toEqual({ text: '✅ すべて削除しました', tone: 'green' })
  })

  it('★★★ 専有型: 保存場所を残した・keptOnly でない → 「✅ 削除しました」。残した保存場所が無ければ「✅ すべて削除しました」のまま', () => {
    expect(teardownHeadlineOf({ state: 'done', keptStorage: true }, WD)).toEqual({ text: '✅ 削除しました', tone: 'green' })
    expect(teardownHeadlineOf({ state: 'done' }, WD)).toEqual({ text: '✅ すべて削除しました', tone: 'green' })
  })

  it('★★★ 専用の見出しを持たない公開先（共用型・HANAMII）は、保存場所を残した回も今までの見出し（データを消したので「破棄しました」は事実）', () => {
    expect(teardownHeadlineOf({ state: 'done', keptStorage: true }, SHARED_TEARDOWN_WORDS)).toEqual({ text: '✅ 破棄しました', tone: 'green' })
    expect(teardownHeadlineOf({ state: 'done', keptStorage: true }, HANAMII_TEARDOWN_WORDS)).toEqual({ text: '✅ 破棄しました', tone: 'green' })
  })

  it('★★★ keptOnly が先: 保存場所を残した印と両方あっても、専有型は「削除していません」', () => {
    expect(teardownHeadlineOf({ state: 'done', keptOnly: true, keptStorage: true }, WD).text).toBe('⚠️ 削除していません')
  })

  it('★★★ 成否が先: 途中・失敗は keptOnly・keptStorage を読まない', () => {
    expect(teardownHeadlineOf({ state: 'inProgress', keptOnly: true, keptStorage: true }, WD)).toEqual({ text: '⏳ 削除中です', tone: 'yellow' })
    expect(teardownHeadlineOf({ state: 'failed', keptOnly: true, keptStorage: true }, WD)).toEqual({ text: '⚠️ 削除できませんでした', tone: 'red' })
    expect(teardownHeadlineOf({ state: 'failed', keptOnly: true }, W)).toEqual({ text: '⚠️ 破棄できませんでした', tone: 'red' })
  })

  it('★★ 知らない state は失敗の見出し（済んだ側に倒さない）', () => {
    expect(teardownHeadlineOf({ state: 'weird' as never }, W)).toEqual({ text: '⚠️ 破棄できませんでした', tone: 'red' })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
describe('keptStorage（保存場所を残した成功の回）の読み方: その場と記録が同じ', () => {
  it('★★★ 残した保存場所の名前がある成功の回だけ true。その場（toTeardownView）と main が書いた記録（summarizeResult → resumedTeardownView）が同じ', () => {
    for (const target of [SHARED, DEDICATED, 'hanamii'] as const) {
      const live = toTeardownView(target, KEPT_BUT_DELETED_REPLY)
      expect(live.keptStorage, target).toBe(true)
      expect(resumedTeardownView(target, ops.summarizeResult(KEPT_BUT_DELETED_REPLY)), `${target}: 開き直し`).toEqual(live)
      expect('keptStorage' in toTeardownView(target, ALL_GONE_REPLY), `${target}: 残していない`).toBe(false)
    }
  })

  it('★★★ 旧い形（keptBucketName だけ）も読む。文字列でない名前・空の名前・空の配列は数えない', () => {
    expect(toTeardownView(DEDICATED, { ok: true, keptBucketName: 'b' }).keptStorage).toBe(true)
    for (const odd of [{ keptBucketName: '' }, { keptBucketName: 1 }, { keptBucketNames: [] }, { keptBucketNames: [''] }, { keptBucketNames: [1, null] }, { keptBucketNames: 'b' }]) {
      expect('keptStorage' in toTeardownView(DEDICATED, { ok: true, ...odd }), JSON.stringify(odd)).toBe(false)
    }
  })

  it('★★★ 失敗の回には付けない（見出しは失敗のまま）', () => {
    expect('keptStorage' in toTeardownView(DEDICATED, { ...KEPT_BUT_DELETED_REPLY, ok: false, message: 'x' })).toBe(false)
  })

  it('★★ keptOnly の回にも付く（残した保存場所があるので）。見出しの選びは keptOnly が先', () => {
    const view = toTeardownView(DEDICATED, KEPT_REPLY)
    expect(view).toMatchObject({ keptOnly: true, keptStorage: true })
    expect(teardownHeadlineOf(view, DEDICATED_TEARDOWN_WORDS).text).toBe('⚠️ 削除していません')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
describe('TeardownResultView: keptOnly の見出し・警告・相談（T-2d）', () => {
  it.each([[SHARED, '⚠️ 破棄していません', '✅ 破棄しました'], [DEDICATED, '⚠️ 削除していません', '✅ すべて削除しました']] as const)(
    '★★★ %s: 新しい見出し（黄）・旧い見出しは出ない・月額の警告は出る（お金を削らない）・「AIに相談する」は出ない',
    (target, kept, old) => {
      const view = toTeardownView(target, KEPT_REPLY)
      expect(view.keptOnly).toBe(true)
      const h = render(view, WORDS_OF[target], { onAskAi: () => {} })
      expect(h).toContain(`<p class="text-xs font-semibold text-brand-yellow">${kept}</p>`)
      expect(text(h)).not.toContain(old)
      expect(text(h)).not.toContain('✅ 削除しました')
      expect(h).toContain('data-teardown-warnings')
      for (const w of teardownRemainingWarnings({ keptBucketName: 'koto-data-a', keptBucketNames: ['koto-data-a'], keptBucketsUsedByOthers: ['koto-data-a'] })) expect(text(h)).toContain(w)
      expect(text(h)).toContain('月額')
      expect(text(h)).not.toContain('AIに相談する')
      // 結果の行は変えない（行頭の ✅ も文もそのまま）
      expect(text(h)).toContain('✅ 保存場所『koto-data-a』のデータは残しました — フォルダ『myapp copy』も同じデータを使っています。')
    },
  )

  it('★★★ keptOnly でない済んだ回は今の見出し（緑）。共用型「✅ 破棄しました」・専有型「✅ すべて削除しました」', () => {
    expect(render(toTeardownView(SHARED, ALL_GONE_REPLY), SHARED_TEARDOWN_WORDS)).toContain('<p class="text-xs font-semibold text-brand-green">✅ 破棄しました</p>')
    expect(render(toTeardownView(DEDICATED, ALL_GONE_REPLY), DEDICATED_TEARDOWN_WORDS)).toContain('<p class="text-xs font-semibold text-brand-green">✅ すべて削除しました</p>')
  })

  it('★★★ 専有型: 保存場所を残し、ほかは消した回（keptOnly でない・理由は問わない）→ 「✅ 削除しました」。「すべて」と言わない。緑', () => {
    const view = toTeardownView(DEDICATED, KEPT_BUT_DELETED_REPLY)
    expect(view.keptOnly).toBeUndefined()
    expect(view.keptStorage).toBe(true)
    const h = render(view, DEDICATED_TEARDOWN_WORDS)
    expect(h).toContain('<p class="text-xs font-semibold text-brand-green">✅ 削除しました</p>')
    expect(text(h)).not.toContain('すべて削除しました')
    expect(text(h)).not.toContain('削除していません')
  })

  it('★★★ 共用型: 保存場所を残した回（keptOnly でない）は今のまま「✅ 破棄しました」', () => {
    const view = toTeardownView(SHARED, KEPT_BUT_DELETED_REPLY)
    expect(render(view, SHARED_TEARDOWN_WORDS)).toContain('✅ 破棄しました')
  })

  it('★★★ 専有型の失敗の回は、残した保存場所があっても失敗の見出し（成否が先）', () => {
    const view = toTeardownView(DEDICATED, { ...KEPT_REPLY, ok: false, message: '失敗しました', remaining: { storageBucket: 'koto-data-b' } })
    expect(view.state).toBe('failed')
    const h = render(view, DEDICATED_TEARDOWN_WORDS)
    expect(text(h)).toContain('⚠️ 削除できませんでした')
    expect(text(h)).not.toContain('削除していません')
    expect(text(h)).not.toContain('✅ 削除しました')
  })

  it('★★★ HANAMII は印を付けない公開先: 印が付いた返り値でも「✅ 破棄しました」（見出しがプロジェクト削除の唯一の知らせ）', () => {
    const view = toTeardownView('hanamii', KEPT_REPLY)
    expect(render(view, HANAMII_TEARDOWN_WORDS)).toContain('✅ 破棄しました')
    expect(text(render(view, HANAMII_TEARDOWN_WORDS))).not.toContain('破棄していません')
  })

  it('★★ view に keptOnly が無ければ、words が keptHeadline を持っていても出ない', () => {
    const h = render(baseView(), SHARED_TEARDOWN_WORDS)
    expect(text(h)).not.toContain('破棄していません')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
describe('描き口: 結果の入口は、どれも TeardownResultView の選びを通る（T-2d）', () => {
  it('★★★ 【公開】共用型の結果（SharedTeardownResultView。AppRunPanel も同じ）: keptOnly で「⚠️ 破棄していません」', () => {
    const h = html(createElement(SharedTeardownResultView, { view: toTeardownView(SHARED, KEPT_REPLY) }))
    expect(h).toContain('<p class="text-xs font-semibold text-brand-yellow">⚠️ 破棄していません</p>')
    expect(text(h)).not.toContain('✅ 破棄しました')
  })

  it('★★★ 【公開】HANAMII の結果（HanamiiTeardownResult。main が書いた記録を開き直した形）: 印は読まず「✅ 破棄しました」', () => {
    ops.resetProjectOpsForTests()
    ops.beginOp('/tmp/koto-kept-only-headline', '削除', { target: 'hanamii', handler: 'hanamii:teardown' })
    ops.finishOp('/tmp/koto-kept-only-headline', { value: KEPT_REPLY })
    const rec = ops.getOps('/tmp/koto-kept-only-headline').last!
    const h = html(createElement(HanamiiTeardownResult, { rec: rec as never }))
    expect(text(h)).toContain('✅ 破棄しました')
    expect(text(h)).not.toContain('破棄していません')
  })

  const step = (view: TeardownView, target: ProjectDeleteStep['target'] = SHARED): ProjectDeleteStep => ({ target, kind: 'done', view, words: WORDS_OF[target] })
  const run = (steps: ProjectDeleteStep[], phase: 'review' | 'stopped' = 'review'): ProjectDeletePhase => ({ phase, steps })
  const del = (r: ProjectDeletePhase) => html(createElement(ProjectDeleteResults, { run: r, showBlockNote: true }))

  it('★★★ プロジェクトの削除の段: keptOnly の段は「⚠️ 破棄していません」。旧い見出しは出ない', () => {
    const h = del(run([step(toTeardownView(SHARED, KEPT_REPLY))]))
    expect(h).toContain('<p class="text-xs font-semibold text-brand-yellow">⚠️ 破棄していません</p>')
    expect(text(h)).not.toContain('✅ 破棄しました')
  })

  it('★★★ 専有型の段: keptOnly → 「⚠️ 削除していません」。ほかは消した回 → 「✅ 削除しました」。何も残さない回 → 「✅ すべて削除しました」', () => {
    expect(text(del(run([step(toTeardownView(DEDICATED, KEPT_REPLY), DEDICATED)])))).toContain('⚠️ 削除していません')
    expect(text(del(run([step(toTeardownView(DEDICATED, KEPT_BUT_DELETED_REPLY), DEDICATED)])))).toContain('✅ 削除しました')
    expect(text(del(run([step(toTeardownView(DEDICATED, ALL_GONE_REPLY), DEDICATED)])))).toContain('✅ すべて削除しました')
  })

  it('★★★ 描き口を数える: <TeardownResultView を描く所は7か所（共用型1・HANAMII1・専有型1・📡 一覧3・プロジェクトの削除1）。ほかに見出しを選ぶ所は無い', () => {
    const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')
    const sites: Array<[string, number]> = [
      ['src/renderer/components/SharedTeardownSection.tsx', 1],
      ['src/renderer/components/HanamiiTeardownSection.tsx', 1],
      ['src/renderer/components/DedicatedTeardownSection.tsx', 1],
      ['src/renderer/components/PublishedListModal.tsx', 3],
      ['src/renderer/components/teardown/ProjectDeleteResults.tsx', 1],
    ]
    for (const [rel, n] of sites) expect(count(read(rel), '<TeardownResultView'), rel).toBe(n)
    // src/renderer のほかのファイルに、描き口は無い（増えたら、ここと見出しの確かめを足す）
    const all: string[] = []
    const walk = (dir: string) => { for (const name of readdirSync(join(ROOT, dir))) { const rel = `${dir}/${name}`; if (statSync(join(ROOT, rel)).isDirectory()) walk(rel); else if (/\.tsx?$/.test(name)) all.push(rel) } }
    walk('src/renderer')
    const withSite = all.filter(rel => rel !== 'src/renderer/components/teardown/TeardownResultView.tsx' && read(rel).includes('<TeardownResultView')).sort()
    expect(withSite).toEqual([
      'src/renderer/components/DedicatedTeardownSection.tsx',
      'src/renderer/components/HanamiiTeardownSection.tsx',
      'src/renderer/components/PublishedListModal.tsx',
      'src/renderer/components/SharedTeardownSection.tsx',
      'src/renderer/components/teardown/ProjectDeleteResults.tsx',
    ])
    // 見出しの文（words の4つ）を読むのは、選びの1か所（headline.ts）と、言葉を定義する所だけ
    const readsHeadline = all.filter(rel => /\b(doneHeadline|keptHeadline|doneKeptStorageHeadline|inProgressHeadline|failedHeadline)\b/.test(read(rel))).sort()
    expect(readsHeadline).toEqual([
      'src/renderer/teardown/headline.ts',
      'src/renderer/teardown/targets/dedicated.ts',
      'src/renderer/teardown/targets/hanamii.ts',
      'src/renderer/teardown/targets/shared.ts',
      'src/renderer/teardown/types.ts',
    ])
    // 部品は選びを呼ぶ（直に words の見出しを読まない）
    expect(read('src/renderer/components/teardown/TeardownResultView.tsx')).toContain('teardownHeadlineOf(view, words)')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
describe('ProjectDeleteResults: 総括「破棄は済みましたが、残ったものがあります。」（T-2e）', () => {
  const REVIEW_HEAD = '破棄は済みましたが、残ったものがあります。'
  const REVIEW_TAIL = '「🗑 ゴミ箱に移動」を押すと、フォルダをゴミ箱へ移します。残ったものは、各サービスの管理画面から削除できます。ほかのプロジェクトも使う保存場所とコンテナレジストリは、消さないでください。消すと、保存場所はそのプロジェクトのデータが消え、コンテナレジストリはそのアプリが止まります。'
  const kept = (target: ProjectDeleteStep['target'] = SHARED): ProjectDeleteStep => ({ target, kind: 'done', view: toTeardownView(target as never, KEPT_REPLY), words: WORDS_OF[target] })
  const plain = (target: ProjectDeleteStep['target'] = 'hanamii', warnings: string[] = ['保存場所『x』は残るため、月額の課金は続きます。']): ProjectDeleteStep =>
    ({ target, kind: 'done', view: baseView({ warnings }), words: WORDS_OF[target] })
  const nothing: ProjectDeleteStep = { target: SHARED, kind: 'nothingToDo', message: '公開されていないため、破棄するものはありません。' }
  const failedStep: ProjectDeleteStep = { target: SHARED, kind: 'failed', line: 'さくらのAppRun: 失敗（テスト）', view: null, words: null }
  const del = (steps: ProjectDeleteStep[], phase: ProjectDeletePhase['phase'] = 'review') => html(createElement(ProjectDeleteResults, { run: { phase, steps } as ProjectDeletePhase, showBlockNote: true }))

  it('★★★ 済んだ段が全部 keptOnly: 総括を出さない。段の見出しと末尾の文は出す', () => {
    const h = del([kept()])
    expect(text(h)).not.toContain(REVIEW_HEAD)
    expect(text(h)).toContain('⚠️ 破棄していません')
    expect(text(h)).toContain(REVIEW_TAIL)
  })

  it('★★★ 2つの段がどちらも keptOnly（共用型・専有型）: 総括なし', () => {
    const h = del([kept(SHARED), kept(DEDICATED)])
    expect(text(h)).not.toContain(REVIEW_HEAD)
    expect(text(h)).toContain('⚠️ 破棄していません')
    expect(text(h)).toContain('⚠️ 削除していません')
  })

  it('★★★ 混在（HANAMII は破棄・保存場所は残した）: 総括を出す。末尾の文も出す', () => {
    const h = del([plain('hanamii'), kept()])
    expect(text(h)).toContain(REVIEW_HEAD)
    expect(text(h)).toContain(REVIEW_TAIL)
    expect(text(h)).toContain('✅ 破棄しました')
    expect(text(h)).toContain('⚠️ 破棄していません')
  })

  it('★★★ keptOnly が1つも無い回は今まで通り総括を出す', () => {
    expect(text(del([plain('hanamii')]))).toContain(REVIEW_HEAD)
    expect(text(del([plain('sakura-apprun', [])]))).toContain(REVIEW_HEAD)
  })

  it('★★ 済んだ段が無い回（消すものが無い・やめた）は、keptOnly でないので総括を出す側（今までのまま）', () => {
    expect(everyDoneStepKeptOnly([])).toBe(false)
    expect(everyDoneStepKeptOnly([nothing])).toBe(false)
    expect(text(del([nothing]))).toContain(REVIEW_HEAD)
  })

  it('★★ 済んでいない段（消すものが無い・失敗）は数えない。keptOnly の段だけが済んだなら、総括なし', () => {
    expect(everyDoneStepKeptOnly([kept(), nothing])).toBe(true)
    expect(everyDoneStepKeptOnly([kept(), failedStep])).toBe(true)
    expect(everyDoneStepKeptOnly([plain(), failedStep])).toBe(false)
  })

  it('★★★ 「どれか」ではなく「全部」: keptOnly の段が1つあっても、何かを消した段が混じれば出す', () => {
    expect(everyDoneStepKeptOnly([kept(), plain()])).toBe(false)
    expect(everyDoneStepKeptOnly([plain(), kept()])).toBe(false)
    expect(everyDoneStepKeptOnly([kept(), kept(DEDICATED)])).toBe(true)
  })

  it('★★ stopped の見出しは keptOnly でも変わらない（総括を出さないのは review だけ）', () => {
    const h = del([kept()], 'stopped')
    expect(text(h)).toContain('破棄を完了できなかったため、プロジェクトの削除を中止しました。')
    expect(text(h)).not.toContain(REVIEW_HEAD)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
describe('開き直した古い記録の一言（teardownCallLine）', () => {
  it('★★★ keptOnly は「⚠️ 何も消していません。」（黄）。「成功しました」と言わない。message は後ろに続く', () => {
    expect(teardownCallLine('doneKeptOnly', '')).toEqual({ text: '⚠️ 何も消していません。', tone: 'wait' })
    expect(teardownCallLine('doneKeptOnly', 'メモ')).toEqual({ text: '⚠️ 何も消していません。 メモ', tone: 'wait' })
  })

  it('★★★ ほかの呼び名の一言は変えない', () => {
    expect(teardownCallLine('done', '')).toEqual({ text: '✅ 成功しました。', tone: 'ok' })
    expect(teardownCallLine('doneWithWarnings', '')).toEqual({ text: '✅ 成功しました。', tone: 'ok' })
    expect(teardownCallLine('inProgress', '')).toEqual({ text: '⏳ 途中です。', tone: 'wait' })
    expect(teardownCallLine('failed', '')).toEqual({ text: '⚠️ 失敗しました。', tone: 'fail' })
    expect(teardownCallLine('stoppedByQuit', '')).toBeNull()
  })

  const DIR = '/tmp/koto-kept-only-headline-notes'
  beforeEach(() => { ops.resetProjectOpsForTests() })
  function recordOf(target: 'sakura-apprun' | 'sakura-apprun-dedicated', handler: string, value: Record<string, unknown>) {
    ops.beginOp(DIR, '削除', { target, handler })
    ops.finishOp(DIR, { value })
    const all = ops.getOps(DIR)
    return all.last!
  }

  it.each([[SHARED, 'cloud:teardown'], [DEDICATED, 'apprunDedicated:teardown']] as const)(
    '★★★ %s: main が書いた記録を開き直すと、古い記録の一言は「⚠️ 何も消していません。」で、「✅ 成功しました。」は出ない（最新の1件は結果欄が出すので一言を足さない）',
    (target, handler) => {
      const older = recordOf(target, handler, KEPT_REPLY)
      const latest = { ...older, startedAt: older.startedAt + 1000 }
      const words = WORDS_OF[target]
      const notes = [resumedTeardownNote(words, older), resumedTeardownNote(words, latest)]
      expect(notes[0].call).toBe('doneKeptOnly')
      const h = render(toTeardownView(target, ALL_GONE_REPLY), words, { notes })
      expect(text(h)).toContain('⚠️ 何も消していません。')
      expect(text(h)).not.toContain('✅ 成功しました。')
      expect(h).toContain('text-xs leading-relaxed select-text text-brand-yellow">⚠️ 何も消していません。')
      // 専有型の節の知らせ（手順5・8の結果欄の部品）も同じ一言
      const dn = html(createElement(DedicatedNotesView, { notes: [{ ...notes[0], call: notes[0].call } as never, { ...notes[1] } as never] }))
      expect(text(dn)).toContain('⚠️ 何も消していません。')
      expect(text(dn)).not.toContain('✅ 成功しました。')
    },
  )

  it('★★ 警告つきの済んだ回・何も付かない済んだ回の古い記録は、今までどおり「✅ 成功しました。」', () => {
    const plainRec = recordOf(SHARED, 'cloud:teardown', ALL_GONE_REPLY)
    ops.resetProjectOpsForTests()
    const warnedRec = recordOf(SHARED, 'cloud:teardown', KEPT_BUT_DELETED_REPLY)
    const later = (r: typeof plainRec) => ({ ...r, startedAt: r.startedAt + 1000 })
    for (const rec of [plainRec, warnedRec]) {
      const notes = [resumedTeardownNote(SHARED_TEARDOWN_WORDS, rec), resumedTeardownNote(SHARED_TEARDOWN_WORDS, later(rec))]
      const h = render(toTeardownView(SHARED, ALL_GONE_REPLY), SHARED_TEARDOWN_WORDS, { notes })
      expect(text(h)).toContain('✅ 成功しました。')
      expect(text(h)).not.toContain('何も消していません')
    }
  })
})
