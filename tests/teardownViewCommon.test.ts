import { describe, it, expect } from 'vitest'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import TeardownResultView, { teardownFailureHasLeftover } from '../src/renderer/components/teardown/TeardownResultView'
import TeardownProgress from '../src/renderer/components/teardown/TeardownProgress'
import TeardownRow from '../src/renderer/components/teardown/TeardownRow'
import StageEstimate from '../src/renderer/components/StageEstimate'
import { resumedTeardownNote, type TeardownResumedNote } from '../src/renderer/teardown/watch'
import type { TeardownWords, TargetSpec } from '../src/renderer/teardown/types'
import type { PublishedEntry } from '../src/renderer/publishedIndex'
import {
  toTeardownView, resumedTeardownView, TEARDOWN_REMAINING_WARNING_HEAD, TEARDOWN_IN_PROGRESS_WARNING_HEAD,
  type TeardownView,
} from '../src/shared/teardownResult'
import { summarizeResult } from '../src/main/projectOps'
import { askAiAboutFailure } from '../src/shared/askAi'
import { PUBLISH_QUIT_STOPS } from '../src/renderer/activity'
import { PUBLISH_TARGET_CONSOLE } from '../src/renderer/publishStatus'

// ── 段階0（0d）: 破棄（削除）の結果・進み具合・行の見た目（公開先によらず共通の部品）────────────────────────────
//
// どの入口・IPC からもまだ呼ばれない（部品と単体テストだけ）。設計書: docs/teardown-unify-plan.md の 10.3.4 の「描画」。
// 見た目の部品を本物の react-dom/server で HTML にして確かめる。ここは描くだけの部品なので、判断（何を消すか・いつ確認するか）は
// tests/teardownFlowCommon.test.ts と tests/teardownHookCommon.test.ts。何が起きたかの読み方は tests/teardownResultCommon.test.ts。
// **警告の書き出しは、main の summarizeResult の実際の出力で確かめる**（描画側の文字列を別に写して合わせない）。

const html = (el: ReactElement) => renderToStaticMarkup(el)
const text = (h: string) => h.replace(/<[^>]*>/g, '')

const DEDICATED = 'sakura-apprun-dedicated' as const
const SERVICE_URL = 'https://hanamii.jp/'
const STORAGE_URL = 'https://secure.sakura.ad.jp/cloud/'

const WORDS: TeardownWords = {
  verb: '破棄',
  confirmTitle: 'HANAMII の公開を破棄します',
  confirmLabel: '破棄する',
  activityLabel: 'HANAMII の破棄',
  rowButton: '🗑 破棄',
  running: '破棄しています…',
  doneHeadline: '✅ 破棄しました',
  inProgressHeadline: '⏳ 破棄の途中です',
  failedHeadline: '⚠️ 破棄できませんでした',
  factsUnreadable: '破棄するものの記録を読めませんでした',
  nothingToDo: 'HANAMII のプロジェクトIDが記録に無いため、ここからは削除できません。',
  askAiTarget: 'HANAMII',
}
const DEDICATED_WORDS: TeardownWords = {
  ...WORDS,
  verb: '削除',
  confirmTitle: '専有型クラスタを削除します',
  confirmLabel: '削除する',
  activityLabel: '専有型クラスタの削除',
  rowButton: '🗑 削除',
  running: '削除しています…',
  doneHeadline: '✅ すべて削除しました',
  inProgressHeadline: '⏳ 削除中です',
  failedHeadline: '⚠️ 削除できませんでした',
  askAiTarget: 'さくらのAppRun（専有型）',
}

/** 画面に渡す材料の既定。URL は公開先と保存場所で別（HANAMII）にしてある。 */
function view(over: Partial<TeardownView> = {}): TeardownView {
  return {
    ok: true, state: 'done', appDeleted: null, executed: [], message: '', remaining: [], inProgress: [], warnings: [], stageTimings: null,
    ...over,
  }
}
function render(v: TeardownView | null, over: Partial<Parameters<typeof TeardownResultView>[0]> = {}): string {
  return html(createElement(TeardownResultView, {
    view: v, notes: [], words: WORDS, retryHint: 'この一覧の 🗑 破棄', serviceConsoleUrl: SERVICE_URL, storageConsoleUrl: STORAGE_URL, ...over,
  }))
}
const count = (s: string, part: string) => s.split(part).length - 1
const hrefs = (h: string) => [...h.matchAll(/href="([^"]*)"/g)].map(m => m[1])

const STORAGE_LEFT = { label: "保存場所『koto-data-x』（月額が続きます）", billing: true, kind: 'storage' as const }
const LB_LEFT = { label: "ロードバランサ『l1』", billing: true, kind: 'service' as const }
const CLUSTER_LEFT = { label: "クラスタ『c1』", billing: true, kind: 'service' as const }

// ═══════════════════════════════════════════════════════════════════════════════
// 結果
// ═══════════════════════════════════════════════════════════════════════════════

describe('TeardownResultView: 見出し3種は仕様書の言葉（words）で、色が分かれる', () => {
  it.each([
    ['done', 'text-brand-green', (w: TeardownWords) => w.doneHeadline, view({ ok: true, state: 'done' })],
    ['inProgress', 'text-brand-yellow', (w: TeardownWords) => w.inProgressHeadline, view({ ok: false, state: 'inProgress' })],
    ['failed', 'text-brand-red', (w: TeardownWords) => w.failedHeadline, view({ ok: false, state: 'failed' })],
  ] as const)('★ %s → 見出しは words の文・色は %s。ほかの2つの見出しは出ない', (_state, cls, pick, v) => {
    for (const w of [WORDS, DEDICATED_WORDS]) {
      const h = render(v, { words: w })
      expect(h).toContain(`<p class="text-xs font-semibold ${cls}">${pick(w)}</p>`)
      for (const other of [w.doneHeadline, w.inProgressHeadline, w.failedHeadline].filter(x => x !== pick(w))) expect(text(h)).not.toContain(other)
    }
  })

  it('★ 結果を出すかは view が null かどうかだけ。null で知らせも無ければ何も描かない', () => {
    expect(render(null)).toBe('')
    expect(render(view())).not.toBe('')
  })

  it('★ 成功: 「破棄しました」と、起きたことの一覧（✅）。残っているものの赤い欄・管理画面の案内は出ない', () => {
    const t = text(render(view({ executed: ['プロジェクトを削除しました', '保存場所のデータを削除しました'], appDeleted: true })))
    expect(t).toContain('✅ 破棄しました')
    expect(t).toContain('✅ プロジェクトを削除しました')
    expect(t).toContain('✅ 保存場所のデータを削除しました')
    expect(t).not.toContain('課金が続きます')
    expect(t).not.toContain('管理画面')
    expect(t).not.toContain('コントロールパネル')
  })
})

describe('TeardownResultView: 失敗 — 残っているもの', () => {
  const FAILED_ALL = {
    ok: false, executed: [], message: 'ロードバランサの削除に失敗しました',
    remaining: { applicationID: 'app1', loadBalancerID: 'l1', asgID: 'a1', clusterID: 'c1', storageBucket: 'koto-data-x' },
  }

  it('★★ 残っているもの（アプリ → LB → ASG → クラスタ → 保存場所）を順に出し、課金が続くことを1度だけ言う。同じ警告（名前を「・」でつないだ文）は重ねない', () => {
    const v = toTeardownView(DEDICATED, FAILED_ALL)
    expect(v.warnings.some(w => w.startsWith(TEARDOWN_REMAINING_WARNING_HEAD)), '警告には入っている').toBe(true)
    const h = render(v, { words: DEDICATED_WORDS })
    const t = text(h)
    expect(t).toContain('⚠️ 削除できませんでした')
    expect(t).toContain('削除できずに残っているものがあります。残っている間は課金が続きます。コントロールパネルから直接削除することもできます。')
    expect(count(t, '削除できずに残っているものがあります')).toBe(1) // 警告の欄に同じ文を重ねない
    const at = ["アプリケーション『app1』", "ロードバランサ『l1』", "オートスケーリンググループ『a1』", "クラスタ『c1』", "保存場所『koto-data-x』（月額が続きます）"].map(k => t.indexOf(k))
    expect(at.every(i => i >= 0)).toBe(true)
    expect([...at].sort((x, y) => x - y)).toEqual(at)
    expect(count(t, "アプリケーション『app1』")).toBe(1) // 名前を警告の文でもう一度言わない
    expect(h).not.toContain('data-teardown-warnings') // 警告の欄そのものが出ない（重ねる警告が無い）
  })

  // 残った保存場所は、ほかのプロジェクトも使っていることがある（Koto は中身を確かめていない）。「直接削除することもできます」の隣に、削除する前の確かめを添える。
  it('★★★ 保存場所が残ったときだけ、「ほかのプロジェクトも使っていないか確かめてから削除してください」を、1度だけ言う。message が同じ文を言っているときは重ねない', () => {
    const CHECK = '保存場所は、ほかのプロジェクトも使っていないか確かめてから削除してください。消すと、そのプロジェクトのデータも消えます。'
    const withStorage = text(render(view({ ok: false, state: 'failed', remaining: [LB_LEFT, STORAGE_LEFT], message: '失敗' })))
    expect(count(withStorage, CHECK)).toBe(1)
    // 公開先のものだけが残った回には言わない（保存場所の話ではない）
    expect(text(render(view({ ok: false, state: 'failed', remaining: [LB_LEFT, CLUSTER_LEFT], message: '失敗' })))).not.toContain('ほかのプロジェクトも使っていないか')
    // main の message が同じ確かめを言っている回（共用型・HANAMII の保存場所の失敗）は、画面で重ねない
    const said = text(render(view({ ok: false, state: 'failed', remaining: [STORAGE_LEFT], message: `失敗です。やり直しても消えないときは、コントロールパネルで、${CHECK}` })))
    expect(count(said, 'ほかのプロジェクトも使っていないか確かめてから削除してください')).toBe(1)
  })

  it('★★ 何も始まっていない失敗（断られた・キーが無い・記録に無い）には、赤い「課金が続きます」を出さない。理由の文（message）は出す', () => {
    for (const message of ['いま別の操作（公開）を実行中です。終わってからもう一度お試しください。', 'トークンが未登録です', WORDS.nothingToDo]) {
      const t = text(render(view({ ok: false, state: 'failed', message })))
      expect(t, message).toContain('⚠️ 破棄できませんでした')
      expect(t).toContain(message)
      expect(t, message).not.toContain('課金が続きます')
      expect(t).not.toContain('削除できずに残っているものがあります')
    }
  })

  it('teardownFailureHasLeftover: 残っているものが1つでもある・実行したことが1つでもあるときだけ true', () => {
    expect(teardownFailureHasLeftover({ executed: [], remaining: [LB_LEFT] })).toBe(true)
    expect(teardownFailureHasLeftover({ executed: [], remaining: [STORAGE_LEFT] })).toBe(true)
    expect(teardownFailureHasLeftover({ executed: ['プロジェクトを削除しました'], remaining: [] })).toBe(true)
    expect(teardownFailureHasLeftover({ executed: [], remaining: [] })).toBe(false)
  })

  it('★ 実行したことがあって残りが無い失敗（保存場所の削除だけが失敗した等）も、赤い欄を出す。書き出しの動詞は、その流れの言葉（破棄の入口は「破棄できずに」・削除の入口は「削除できずに」）', () => {
    const failed = view({ ok: false, state: 'failed', executed: ['プロジェクトを削除しました'], message: '保存場所を削除できませんでした' })
    const t = text(render(failed))
    expect(t).toContain('破棄できずに残っているものがあります。残っている間は課金が続きます。コントロールパネルから直接削除することもできます。')
    const removal = text(render(failed, { words: DEDICATED_WORDS }))
    expect(removal).toContain('削除できずに残っているものがあります。残っている間は課金が続きます。コントロールパネルから直接削除することもできます。')
  })

  it('★★★ 赤い欄の書き出しは、見出し（破棄できませんでした）と同じ言葉。1回の流れの中で「破棄」と「削除」を混ぜない（D3）', () => {
    // 残っているものの一覧つきの失敗（HANAMII 風の保存場所だけが残った回を含む）
    for (const left of [[STORAGE_LEFT], [LB_LEFT, CLUSTER_LEFT]]) {
      const t = text(render(view({ ok: false, state: 'failed', remaining: left, message: '失敗' })))
      expect(t).toContain('⚠️ 破棄できませんでした')
      expect(t).toContain('破棄できずに残っているものがあります。残っている間は課金が続きます')
      expect(t, '見出しは「破棄」なのに赤い欄が「削除できずに」と言っている').not.toContain('削除できずに')
    }
    // 削除の流れでは、見出しも赤い欄も「削除」
    const t2 = text(render(view({ ok: false, state: 'failed', remaining: [LB_LEFT], message: '失敗' }), { words: DEDICATED_WORDS }))
    expect(t2).toContain('⚠️ 削除できませんでした')
    expect(t2).toContain('削除できずに残っているものがあります。残っている間は課金が続きます')
    expect(t2).not.toContain('破棄')
  })

  it('★★ 一覧を出せない回（残ったものが1件も無い）は、同じ書き出しの警告でも落とさず警告の欄に出す', () => {
    const w = `${TEARDOWN_REMAINING_WARNING_HEAD}。コントロールパネルから直接削除することもできます: 名前不明`
    const h = render(view({ ok: false, state: 'failed', message: '失敗', warnings: [w] }))
    expect(h).toContain('data-teardown-warnings')
    expect(text(h)).toContain(w)
  })

  it('★★ 別の警告は、一覧を出す回でも落とさず警告の欄に出る', () => {
    const h = render(view({ ok: false, state: 'failed', remaining: [LB_LEFT], warnings: [`${TEARDOWN_REMAINING_WARNING_HEAD}。x`, '⚠️ 鍵の無効化に失敗しました'] }))
    expect(h).toContain('data-teardown-warnings')
    expect(text(h)).toContain('⚠️ 鍵の無効化に失敗しました')
    expect(text(h)).not.toContain(`${TEARDOWN_REMAINING_WARNING_HEAD}。x`)
  })
})

describe('TeardownResultView: 待ち切れず止まった（途中）', () => {
  const IN_PROGRESS_RAW = {
    ok: false, executed: [], message: '待ち切れませんでした', remaining: { loadBalancerID: 'l1' }, inProgress: { loadBalancerID: 'l1', asgID: 'a1', clusterID: 'c1' },
  }

  it('★★ 黄色い「{動詞}中です。しばらくして{retryHint}をもう一度押してください」と、止まったものの一覧。赤い失敗の文・同じ警告は出ない', () => {
    const v = toTeardownView(DEDICATED, IN_PROGRESS_RAW)
    expect(v.state).toBe('inProgress')
    expect(v.warnings.some(w => w.startsWith(TEARDOWN_IN_PROGRESS_WARNING_HEAD)), '警告には入っている').toBe(true)
    const list = text(render(v, { words: DEDICATED_WORDS, retryHint: 'この一覧の 🗑 破棄' }))
    const step6 = text(render(v, { words: DEDICATED_WORDS, retryHint: '手順6' }))
    expect(step6).toContain('⏳ 削除中です')
    expect(step6).toContain('削除中です。しばらくして手順6をもう一度押してください。')
    expect(list).toContain('削除中です。しばらくしてこの一覧の 🗑 破棄をもう一度押してください。')
    // 違うのは押し直す場所の呼び方だけ（ほかの文・並びは同じ）
    expect(list.replace('この一覧の 🗑 破棄', '手順6')).toBe(step6)
    for (const k of ["ロードバランサ『l1』", "オートスケーリンググループ『a1』", "クラスタ『c1』"]) expect(step6).toContain(k)
    expect(step6).not.toContain('削除できずに残っているものがあります') // 赤い失敗の文とは別
    expect(step6).not.toContain('待ち切れずに止まりました') // 警告の文を重ねない
  })

  it('動詞は公開先の言葉（破棄の入口なら「破棄中です」）', () => {
    const v = toTeardownView(DEDICATED, IN_PROGRESS_RAW)
    expect(text(render(v, { words: WORDS, retryHint: 'この一覧の 🗑 破棄' }))).toContain('破棄中です。しばらくしてこの一覧の 🗑 破棄をもう一度押してください。')
  })

  it('★★ 止まったものの一覧が空（HANAMII の受付済みなど）: 黄色い押し直しの枠は出さない。文は警告が言う。message と同じ文の警告は重ねない', () => {
    const accepted = 'HANAMII が削除を受け付けましたが、まだ終わっていません。しばらくしてから、もう一度破棄を押してください。'
    const same = render(view({ ok: false, state: 'inProgress', appDeleted: false, message: accepted, warnings: [accepted] }))
    expect(text(same)).toContain('⏳ 破棄の途中です')
    expect(text(same)).not.toContain('破棄中です。しばらくして')
    expect(count(text(same), accepted)).toBe(1) // message と警告が同じ文でも、1度だけ
    expect(same).not.toContain('data-teardown-warnings')
    const different = render(view({ ok: false, state: 'inProgress', appDeleted: false, message: '受付済み', warnings: [accepted] }))
    expect(text(different)).toContain(accepted) // message に含まれない警告は落とさない
    expect(different).toContain('data-teardown-warnings')
  })

  it('★ 途中でない結果（成功）は、止まったものの一覧があっても黄色い押し直しの枠を出さない。同じ書き出しの警告は警告の欄に出る', () => {
    const w = `${TEARDOWN_IN_PROGRESS_WARNING_HEAD}。しばらくしてから、もう一度`
    const h = render(view({ ok: true, state: 'done', inProgress: [LB_LEFT], warnings: [w] }))
    expect(text(h)).not.toContain('破棄中です。しばらくして')
    expect(text(h)).toContain(w)
  })

  it('★ 一覧が空の途中でも、同じ書き出しの警告は落とさない（一覧が出せないので）', () => {
    const w = `${TEARDOWN_IN_PROGRESS_WARNING_HEAD}。しばらくしてから、もう一度`
    const h = render(view({ ok: false, state: 'inProgress', message: '途中', warnings: [w] }))
    expect(text(h)).toContain(w)
  })
})

describe('TeardownResultView: 警告 — ⚠️・※ の行は「✅」を付けない', () => {
  it('★★ ⚠️ で始まる行は警告の欄に黄色で出て、「✅ ⚠️」にならない。起きたことは ✅ のまま', () => {
    const v = toTeardownView('hanamii', { ok: true, executed: ['プロジェクトを削除しました', '⚠️ アクセスキーの無効化に失敗しました'] })
    const h = render(v)
    const t = text(h)
    expect(t).toContain('✅ プロジェクトを削除しました')
    expect(t).toContain('⚠️ アクセスキーの無効化に失敗しました')
    expect(t).not.toContain('✅ ⚠️')
    expect(h).toContain('data-teardown-warnings')
    expect(h).toContain('text-brand-yellow')
  })

  it('中身の無い警告（空の文）は出さない（「⚠️ 」だけの行にしない）。ほかの警告は出る', () => {
    const h = render(view({ warnings: ['', '月額が続きます'] }))
    expect(count(h, 'whitespace-pre-wrap">')).toBe(1)
    expect(text(h)).toContain('⚠️ 月額が続きます')
    expect(render(view({ warnings: [''] }))).not.toContain('data-teardown-warnings')
  })

  it('警告は ⚠️ を付けた1行にする（印が付いていれば二重に付けない）', () => {
    const t = text(render(view({ warnings: ['月額が続きます', '⚠️ 印あり', '※ 注意'] })))
    expect(t).toContain('⚠️ 月額が続きます')
    expect(t).toContain('⚠️ 印あり')
    expect(t).not.toContain('⚠️ ⚠️')
    expect(t).toContain('※ 注意')
    expect(t).not.toContain('⚠️ ※')
  })

  it('★ 成功でも、保存場所を残した月額の警告は出る（HANAMII）', () => {
    const v = toTeardownView('hanamii', { ok: true, executed: [], keptBucketName: 'koto-data-x' })
    const t = text(render(v))
    expect(t).toContain('✅ 破棄しました')
    expect(t).toContain('koto-data-x')
    expect(t).toContain('月額')
  })
})

describe('TeardownResultView: message・AI に相談・保存場所の押し直し', () => {
  it('message は選択・コピーできる枠に出す。空なら枠を出さない', () => {
    const h = render(view({ ok: false, state: 'failed', message: 'HANAMII が断りました' }))
    expect(h).toContain('select-text')
    expect(h).toContain('title="メッセージをコピー"')
    expect(text(h)).toContain('HANAMII が断りました')
    expect(render(view({ message: '' }))).not.toContain('メッセージをコピー')
  })

  it('★ 「🤖 AIに相談する」は、失敗のときだけ・出す入口だけ。押すと仕様書の公開先名つきの定型文が渡る（message が空なら「失敗しました」）', () => {
    const failed = view({ ok: false, state: 'failed', message: 'HANAMII が断りました' })
    expect(render(failed, { onAskAi: () => {} })).toContain('AIに相談する')
    expect(render(failed)).not.toContain('AIに相談する')
    expect(render(view(), { onAskAi: () => {} })).not.toContain('AIに相談する')

    const asked: string[] = []
    const el = TeardownResultView({ view: failed, notes: [], words: WORDS, retryHint: 'x', serviceConsoleUrl: SERVICE_URL, storageConsoleUrl: STORAGE_URL, onAskAi: t => asked.push(t) }) as ReactElement
    const buttons = findAll(el, n => n.type === 'button' && String(n.props.className).includes('bg-sakura'))
    expect(buttons).toHaveLength(1)
    buttons[0].props.onClick()
    // 文は境界トークンで囲まれる（毎回違う印）ので、印を揃えて比べる。
    const stable = (t: string) => t.replace(/KOTO-EXT-[0-9a-f]+/g, 'KOTO-EXT-x')
    expect(asked.map(stable)).toEqual([stable(askAiAboutFailure('破棄', 'HANAMII', 'HANAMII が断りました'))])
    const el2 = TeardownResultView({ view: view({ ok: false, state: 'failed', message: '' }), notes: [], words: WORDS, retryHint: 'x', serviceConsoleUrl: SERVICE_URL, storageConsoleUrl: STORAGE_URL, onAskAi: t => asked.push(t) }) as ReactElement
    findAll(el2, n => n.type === 'button' && String(n.props.className).includes('bg-sakura'))[0].props.onClick()
    expect(stable(asked[1])).toBe(stable(askAiAboutFailure('破棄', 'HANAMII', '失敗しました')))
  })

  it('★ 保存場所だけが残った失敗: 押し直す場所の案内とボタンを添える。ほかの条件（案内が無い入口・保存場所が残っていない・成功・途中）では出さない', () => {
    const hint = 'もう一度破棄するには、下の「このプロジェクトを開く」から押してください（テスト用の文）'
    const action = { label: 'このプロジェクトを開く', onClick: () => {} }
    const storageOnly = view({ ok: false, state: 'failed', appDeleted: true, message: '保存場所を削除できませんでした', remaining: [STORAGE_LEFT] })
    const h = render(storageOnly, { storageRetryHint: hint, storageRetryAction: action })
    expect(h).toContain('>このプロジェクトを開く</button>')
    expect(h.indexOf('>このプロジェクトを開く</button>'), '案内の文より前にボタンがある').toBeGreaterThan(h.indexOf(hint))
    expect(render(storageOnly, { storageRetryAction: action })).not.toContain('>このプロジェクトを開く</button>') // 文が無い入口
    expect(text(render(storageOnly, { storageRetryHint: hint }))).toContain(hint)
    expect(render(storageOnly, { storageRetryHint: hint })).not.toContain('>このプロジェクトを開く</button>') // ボタンだけ無い
    const serviceOnly = view({ ok: false, state: 'failed', remaining: [LB_LEFT] })
    expect(text(render(serviceOnly, { storageRetryHint: hint, storageRetryAction: action }))).not.toContain(hint) // 保存場所が残っていない
    expect(text(render(view(), { storageRetryHint: hint, storageRetryAction: action }))).not.toContain(hint)
    expect(text(render(view({ ok: false, state: 'inProgress', inProgress: [LB_LEFT] }), { storageRetryHint: hint, storageRetryAction: action }))).not.toContain(hint)
  })

  it('かかった時間（段ごとの時間）が付いていれば「かかった時間を見る」を出す', () => {
    const timings = { stages: [{ stage: 'teardown.lb', ms: 540_000 }], totalMs: 540_000 } as any
    expect(render(view({ stageTimings: timings }))).toContain('data-stage-timing-details')
    expect(render(view())).not.toContain('data-stage-timing-details')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 管理画面の導線は2つ
// ═══════════════════════════════════════════════════════════════════════════════

describe('TeardownResultView: 管理画面への導線は2つに使い分ける（保存場所 → storageConsoleUrl、公開先のもの → serviceConsoleUrl）', () => {
  it('★★★ 保存場所だけが残った失敗（公開先のものは消えた）: コントロールパネル（storageConsoleUrl）だけ。公開先の管理画面は案内しない', () => {
    const h = render(view({ ok: false, state: 'failed', appDeleted: true, message: '保存場所を削除できませんでした', remaining: [STORAGE_LEFT] }))
    expect(hrefs(h)).toEqual([STORAGE_URL])
    expect(h).toContain('🔧 コントロールパネルを開く')
    expect(h).not.toContain('管理画面を開く')
  })

  it('★★★ 公開先のものが残った失敗: 公開先の管理画面（serviceConsoleUrl）。保存場所の案内（storageConsoleUrl）は出ない', () => {
    const h = render(view({ ok: false, state: 'failed', appDeleted: false, remaining: [LB_LEFT, CLUSTER_LEFT] }))
    expect(hrefs(h)).toEqual([SERVICE_URL])
    expect(h).toContain('🔧 管理画面を開く')
    expect(h).not.toContain('コントロールパネルを開く')
  })

  it('★★ 公開先のものも保存場所も残った失敗: 2つとも出る。どちらも渡した URL になる', () => {
    const h = render(view({ ok: false, state: 'failed', appDeleted: false, remaining: [LB_LEFT, STORAGE_LEFT] }))
    expect(hrefs(h).sort()).toEqual([SERVICE_URL, STORAGE_URL].sort())
    expect(h).toContain('🔧 コントロールパネルを開く')
    expect(h).toContain('🔧 管理画面を開く')
  })

  it('★★ 待ち切れず止まったもの（公開先）: 公開先の管理画面へ', () => {
    const h = render(view({ ok: false, state: 'inProgress', appDeleted: false, inProgress: [LB_LEFT] }))
    expect(hrefs(h)).toEqual([SERVICE_URL])
  })

  it('★★ 公開先のものが消えたと分からない失敗（appDeleted が true でない）: 残りの一覧が空でも、公開先の管理画面へ案内する（キーが無くても辿り着ける）', () => {
    for (const appDeleted of [false, null]) {
      const h = render(view({ ok: false, state: 'failed', appDeleted, message: 'トークンが未登録です' }))
      expect(hrefs(h), String(appDeleted)).toEqual([SERVICE_URL])
    }
  })

  it('公開先のものが消えた失敗で、残りも無ければ（appDeleted が true）、案内は出ない', () => {
    expect(hrefs(render(view({ ok: false, state: 'failed', appDeleted: true, message: '失敗' })))).toEqual([])
  })

  it('★ 待ち切れず止まったものがあるなら、アプリが消えていても（appDeleted が true）公開先の管理画面へ案内する', () => {
    const h = render(view({ ok: false, state: 'inProgress', appDeleted: true, inProgress: [LB_LEFT] }))
    expect(hrefs(h)).toEqual([SERVICE_URL])
  })

  it('成功には案内を出さない（公開先のものが消えたか分からなくても）', () => {
    expect(hrefs(render(view({ ok: true, state: 'done', appDeleted: null })))).toEqual([])
  })

  it('★ 2つの行き先が同じ（専有型）なら、リンクは1つ。「コントロールパネル」と言う', () => {
    const same = PUBLISH_TARGET_CONSOLE[DEDICATED]
    const props = { serviceConsoleUrl: same, storageConsoleUrl: same, words: DEDICATED_WORDS }
    const both = render(view({ ok: false, state: 'failed', appDeleted: false, remaining: [LB_LEFT, STORAGE_LEFT] }), props)
    expect(hrefs(both)).toEqual([same])
    expect(both).toContain('🔧 コントロールパネルを開く')
    expect(both).not.toContain('管理画面を開く')
    const serviceOnly = render(view({ ok: false, state: 'failed', appDeleted: false, remaining: [LB_LEFT] }), props)
    expect(hrefs(serviceOnly)).toEqual([same])
    expect(serviceOnly).toContain('🔧 コントロールパネルを開く')
  })

  it('行き先が空の文字列なら、そのリンクは出さない', () => {
    const v = view({ ok: false, state: 'failed', appDeleted: false, remaining: [LB_LEFT, STORAGE_LEFT] })
    expect(hrefs(render(v, { serviceConsoleUrl: '' }))).toEqual([STORAGE_URL])
    expect(hrefs(render(v, { storageConsoleUrl: '' }))).toEqual([SERVICE_URL])
  })

  it('HANAMII の行き先は、公開先の管理画面が https://hanamii.jp/ （PUBLISH_TARGET_CONSOLE）', () => {
    expect(PUBLISH_TARGET_CONSOLE.hanamii).toBe(SERVICE_URL)
    expect(PUBLISH_TARGET_CONSOLE[DEDICATED]).toBe(STORAGE_URL)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// main の実際の出力と結ぶ
// ═══════════════════════════════════════════════════════════════════════════════

describe('★★★ 警告の書き出しは、main の summarizeResult の実際の出力で確かめる（描画側の文字列を別に写して合わせない）', () => {
  const FAILED_RAW = { ok: false, executed: [], message: '失敗', remaining: { loadBalancerID: 'l1', clusterID: 'c1', storageBucket: 'koto-data-x' } }
  const IN_PROGRESS_RAW = { ok: false, executed: [], message: '待ち切れませんでした', remaining: { loadBalancerID: 'l1' }, inProgress: { loadBalancerID: 'l1' } }

  it('summarizeResult が作る「残っています」「途中」の警告は、共通の定数で始まる', () => {
    const remaining = summarizeResult(FAILED_RAW).warnings
    expect(remaining.length).toBeGreaterThan(0)
    expect(remaining.every(w => w.startsWith(TEARDOWN_REMAINING_WARNING_HEAD))).toBe(true)
    const inProgress = summarizeResult(IN_PROGRESS_RAW).warnings
    expect(inProgress.length).toBeGreaterThan(0)
    expect(inProgress.every(w => w.startsWith(TEARDOWN_IN_PROGRESS_WARNING_HEAD))).toBe(true)
  })

  it('★★ 記録（summarizeResult を通ったもの）から開き直した画面でも、一覧を出す回は同じ警告を重ねない。その場の画面と文が同じ', () => {
    for (const raw of [FAILED_RAW, IN_PROGRESS_RAW]) {
      const live = render(toTeardownView(DEDICATED, raw), { words: DEDICATED_WORDS })
      const resumed = render(resumedTeardownView(DEDICATED, summarizeResult(raw)), { words: DEDICATED_WORDS })
      expect(resumed).toBe(live)
      expect(live).not.toContain('data-teardown-warnings')
    }
  })

  it('★★★ 知らせ（閉じて開き直したときの notes）と結果欄は、同じ警告を2か所で言わない。どちらかには必ず出る（落とさない）。開き直した画面そのもの（結果欄＋最新の1件の知らせ）で数える', () => {
    const raws: unknown[] = [
      FAILED_RAW, IN_PROGRESS_RAW,
      { ok: false, executed: [], message: '失敗', remaining: { clusterID: 'c1' }, warnings: ['別の知らせです'] },
      { ok: false, executed: ['プロジェクトを削除しました'], message: '失敗', remaining: {}, warnings: ['別の知らせです'] },
      { ok: true, executed: [], message: '', keptBucketName: 'koto-data-x' },
      { ok: false, executed: [], message: '失敗', remaining: {}, inProgress: {} },
      { ok: true, executed: [], message: '', inProgress: { loadBalancerID: 'l1' } }, // 成功なのに止まったものがある（一覧は出ない）
    ]
    for (const raw of raws) {
      const rec = summarizeResult(raw)
      const record = { op: '削除', target: DEDICATED, handler: 'apprunDedicated:teardown', startedAt: 1, finishedAt: 2, running: false, progress: {}, seen: false, result: rec } as unknown as ProjectOpRecordShape
      const note = resumedTeardownNote(DEDICATED_WORDS, record)
      const v = resumedTeardownView(DEDICATED, rec)
      // 開き直した画面そのもの。フックは最新の1件を、結果欄（view）と知らせ（notes）の両方へ渡す。
      const t = text(render(v, { words: DEDICATED_WORDS, notes: [note] }))
      for (const w of rec.warnings) {
        const times = count(t, w)
        // 同じ警告を2か所で言わない（その場の結果は1回。開き直しても1回）。
        expect(times, `2回出ている: ${w}`).toBeLessThanOrEqual(1)
        // 落とさない: 文として出ていなければ、結果欄の一覧（残っているもの・止まったもの）がその知らせを言っている。
        expect(times === 1 || t.includes('削除できずに残っているものがあります') || t.includes('待ち切れずに止まりました') || t.includes('削除中です。しばらくして'), `どこにも出ていない: ${w}`).toBe(true)
      }
    }
  })

  it('★★★ 保存場所を残した成功（月額が続く警告）: その場の結果でも、開き直した画面（最新の知らせつき）でも、警告は1回。見出しの知らせは残る', () => {
    const raw = { ok: true, executed: ['✅ プロジェクトを削除しました'], message: '', keptBucketName: 'koto-data-x' }
    const live = text(render(toTeardownView('hanamii', raw)))
    expect(count(live, 'koto-data-x')).toBe(1)
    const rec = summarizeResult(raw)
    const record = { op: '削除', target: 'hanamii', handler: 'hanamii:teardown', startedAt: 1, finishedAt: 2, running: false, progress: {}, seen: false, result: rec } as unknown as ProjectOpRecordShape
    const note = resumedTeardownNote(WORDS, record)
    expect(note.warnings.some(w => w.includes('koto-data-x'))).toBe(true) // 知らせの側は警告を持っている（結果欄が出す分は、描くときに重ねない）
    const reopened = text(render(resumedTeardownView('hanamii', rec), { notes: [note] }))
    expect(count(reopened, 'koto-data-x'), '開き直すと警告が2回出る').toBe(1)
    expect(reopened).toContain('🔔 破棄の結果')
    expect(reopened).not.toContain('結果です') // T162: 見出しに「です」と句点が無い
    expect(reopened).toContain('✅ 破棄しました')
  })

  it('★★ 古い記録の知らせの警告は、全件ここに残る（結果欄は最新の1件だけを出すので、古い警告は結果欄に無い）。最新の1件の警告だけが、結果欄と重ならない', () => {
    // 古い記録の警告に、最新の警告と同じ文（2回続けて同じ保存場所を残した）を含める。古いほうは別の出来事なので落とさない。
    const old = { startedAt: 1, finishedAt: 2, ok: true, call: 'doneWithWarnings' as const, headline: '🔔 破棄の結果（古い）', message: '', warnings: ['⚠️ 古い記録の月額の知らせです', '⚠️ 保存場所『koto-data-x』は残しました'] }
    const latest = { startedAt: 2, finishedAt: 3, ok: true, call: 'doneWithWarnings' as const, headline: '🔔 破棄の結果（新しい）', message: '', warnings: ['⚠️ 保存場所『koto-data-x』は残しました', '⚠️ 結果欄に無い別の知らせです'] }
    const v = view({ warnings: ['保存場所『koto-data-x』は残しました'] })
    const t = text(render(v, { notes: [old, latest] }))
    expect(count(t, '古い記録の月額の知らせです')).toBe(1)
    // 古い記録の知らせで1回、結果欄（最新）で1回。最新の知らせは、結果欄と同じ文を重ねない（古い記録の同じ文は別の出来事なので落とさない）
    expect(count(t, '保存場所『koto-data-x』は残しました')).toBe(2)
    expect(count(t, '結果欄に無い別の知らせです')).toBe(1) // 結果欄が出さない分は、最新の知らせでも落とさない
    // 結果欄が無い（view が null）なら、最新の1件の警告も全件、知らせが出す
    const only = text(render(null, { notes: [old, latest] }))
    expect(count(only, '保存場所『koto-data-x』は残しました')).toBe(2) // 古い記録と最新の知らせで1回ずつ
    expect(count(only, '結果欄に無い別の知らせです')).toBe(1)
    expect(count(only, '古い記録の月額の知らせです')).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 閉じて開き直したあとの知らせ
// ═══════════════════════════════════════════════════════════════════════════════

describe('TeardownResultView: 閉じて開き直したあとの知らせ（見逃してはいけない警告）', () => {
  const note = (over: Partial<TeardownResumedNote> = {}): TeardownResumedNote => ({
    startedAt: 1, finishedAt: 2, ok: true, call: 'doneWithWarnings', headline: '🔔 破棄の結果', message: '', warnings: ['⚠️ 保存場所『x』は残しました。月額が続きます'], ...over,
  })

  it('★ 知らせが結果の上に出る。結果が無くても知らせは出る。知らせが無ければ何も出ない', () => {
    const t = text(render(view({ executed: ['x を削除しました'] }), { notes: [note()] }))
    expect(t).toContain('🔔 破棄の結果')
    expect(t).toContain('保存場所『x』は残しました。月額が続きます')
    expect(t.indexOf('🔔')).toBeLessThan(t.indexOf('✅ 破棄しました'))
    const only = text(render(null, { notes: [note()] }))
    expect(only).toContain('保存場所『x』は残しました')
    expect(only).not.toContain('破棄しました')
    expect(render(null, { notes: [] })).toBe('')
  })

  it('★ 最新の1件の結果の一言は結果欄が出す。古い記録の知らせは成功／失敗と一言も出す', () => {
    const old = note({ startedAt: 1, ok: false, call: 'failed', message: '1回目は断られました', warnings: [] })
    const latest = note({ startedAt: 2, ok: true, call: 'done', message: '2回目の一言', warnings: [] })
    const t = text(render(null, { notes: [old, latest] }))
    expect(t).toContain('⚠️ 失敗しました。 1回目は断られました')
    expect(t).not.toContain('2回目の一言')
    expect(t).not.toContain('✅ 成功しました。')
    const okOld = text(render(null, { notes: [note({ startedAt: 1, ok: true, call: 'done', message: '', warnings: [] }), latest] }))
    expect(okOld).toContain('✅ 成功しました。')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 進み具合
// ═══════════════════════════════════════════════════════════════════════════════

describe('TeardownProgress: 進み具合', () => {
  const START = Date.parse('2026-10-08T00:00:00.000Z')

  it('★ 文と、記録が「走っている」と言うときの始まってからの時間・閉じても進むこと・Koto を終了すると止まること', () => {
    const t = text(html(createElement(TeardownProgress, {
      words: DEDICATED_WORDS, progress: 'ロードバランサの削除を待っています（3分経過）…', running: true,
      runningRecord: { startedAt: START, progress: { stage: 'teardown.lb' } }, nowMs: START + 3 * 60_000 + 5000,
    })))
    expect(t).toContain('ロードバランサの削除を待っています（3分経過）…')
    expect(t).toContain('始まってから約3分')
    expect(t).toContain('この画面を閉じても、削除は最後まで進みます。')
    expect(t).toContain(PUBLISH_QUIT_STOPS)
  })

  it('「閉じても…」の動詞は公開先の言葉（破棄の入口なら「破棄は最後まで進みます」）', () => {
    const t = text(html(createElement(TeardownProgress, { words: WORDS, progress: null, running: true, runningRecord: { startedAt: START }, nowMs: START })))
    expect(t).toContain('この画面を閉じても、破棄は最後まで進みます。')
    expect(t).not.toContain('削除は最後まで')
    expect(t).toContain('始まってから1分未満')
  })

  it('記録が「走っている」と言わない（この画面が始めた直後）あいだは、文だけを出す', () => {
    const t = text(html(createElement(TeardownProgress, { words: WORDS, progress: '準備しています', running: false, runningRecord: null, nowMs: START })))
    expect(t).toBe('準備しています')
  })

  it('★ 走っていないなら、記録が残っていても時間や「閉じても進む」は出さない（別の操作の記録を、この破棄の経過として出さない）', () => {
    const t = text(html(createElement(TeardownProgress, { words: WORDS, progress: null, running: false, runningRecord: { startedAt: START, progress: { stage: 'publish.image' } }, nowMs: START + 120_000 })))
    expect(t).toBe('')
  })

  it('走っていると言うのに記録が無いときは、時間も「閉じても進む」も出さない', () => {
    const t = text(html(createElement(TeardownProgress, { words: WORDS, progress: null, running: true, runningRecord: null, nowMs: START })))
    expect(t).toBe('')
  })

  it('進み具合の文が無ければ、その段落は出ない', () => {
    const h = html(createElement(TeardownProgress, { words: WORDS, progress: null, running: true, runningRecord: { startedAt: START }, nowMs: START }))
    expect(h).not.toContain('data-teardown-progress')
    expect(html(createElement(TeardownProgress, { words: WORDS, progress: 'x', running: false, runningRecord: null, nowMs: START }))).toContain('data-teardown-progress')
  })

  it('★ 待っている段の目安（StageEstimate）は、走っているときだけ・記録の段（progress.stage）を渡して置く', () => {
    const on = TeardownProgress({ words: WORDS, progress: null, running: true, runningRecord: { startedAt: START, progress: { stage: 'teardown.lb' } }, nowMs: START }) as ReactElement
    const est = findAll(on, n => n.type === StageEstimate)
    expect(est).toHaveLength(1)
    expect(est[0].props.stage).toBe('teardown.lb')
    const off = TeardownProgress({ words: WORDS, progress: 'x', running: false, runningRecord: { startedAt: START, progress: { stage: 'teardown.lb' } }, nowMs: START }) as ReactElement
    expect(findAll(off, n => n.type === StageEstimate)).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 行
// ═══════════════════════════════════════════════════════════════════════════════

describe('TeardownRow: 📡 の行の 🗑（描画）', () => {
  const ENTRY = {
    dir: '/tmp/proj', projectName: 'proj', target: 'hanamii', label: 'HANAMII',
    url: 'https://app.example.com/', publishedAt: '2026-10-01T00:00:00.000Z', dateUnknown: false,
    hanamiiProjectId: 'p1', registryName: null,
  } as PublishedEntry
  const SPEC = {
    target: 'hanamii', handler: 'hanamii:teardown', words: WORDS, claimsComputeBillingStops: false, irreversibleNote: 'storage-only',
    readRecord: async () => ({}), hasWork: () => true, targets: () => [], loadAuth: async () => ({}), invoke: async () => ({ ok: true }),
    failure: (message: string) => ({ ok: false, message }), toView: (raw: unknown) => toTeardownView('hanamii', raw),
  } as unknown as TargetSpec<unknown, unknown, unknown>
  const renderRow = (over: { blocked?: boolean } = {}) => html(createElement(TeardownRow, {
    spec: SPEC, entry: ENTRY, keyMissingMessage: 'x', blocked: over.blocked ?? false,
    onBusyChange: () => {}, onOutcome: () => {}, onFinished: () => {},
    render: ({ button, below }) => createElement('div', null, button, below),
  }))

  it('★ 押せる 🗑 破棄のボタンを、行の本体（render）へ渡す。実行中でなければ進み具合の枠は出ない。title は仕様書の動詞', () => {
    const h = renderRow()
    expect(text(h)).toBe('🗑 破棄')
    expect(h).not.toContain('disabled=""')
    expect(h).not.toContain('data-teardown-row-progress')
    expect(h).toContain('title="公開を止めて、作られたものをすべて破棄します"')
  })

  it('ほかの行の破棄が走っているあいだは、押せない', () => {
    expect(renderRow({ blocked: true })).toContain('disabled=""')
  })

  it('行の本体（render）へ渡すのは button・below・busy の3つ。この行の破棄が走っていなければ busy:false', () => {
    let parts: Record<string, unknown> | null = null
    html(createElement(TeardownRow, {
      spec: SPEC, entry: ENTRY, keyMissingMessage: 'x', blocked: false, onBusyChange: () => {}, onOutcome: () => {}, onFinished: () => {},
      render: p => { parts = p as unknown as Record<string, unknown>; return null },
    }))
    expect(Object.keys(parts ?? {}).sort()).toEqual(['below', 'busy', 'button'])
    expect((parts as any).busy).toBe(false)
    expect((parts as any).below).toBeNull()
  })
})

// ── React の要素の木を歩く（クリックの処理や部品の種類を見るため）────────────────────────────
function findAll(node: unknown, pred: (n: ReactElement & { props: any }) => boolean, out: Array<ReactElement & { props: any }> = []): Array<ReactElement & { props: any }> {
  if (Array.isArray(node)) { for (const c of node) findAll(c, pred, out); return out }
  if (!node || typeof node !== 'object') return out
  const el = node as ReactElement & { props: any }
  if (el.props === undefined) return out
  if (pred(el)) out.push(el)
  findAll(el.props.children, pred, out)
  return out
}
