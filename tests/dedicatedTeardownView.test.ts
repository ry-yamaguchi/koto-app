import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DedicatedTeardownProgress, DedicatedTeardownResultView, teardownFailureHasLeftover } from '../src/renderer/components/DedicatedTeardownView'
import DedicatedTeardownRow, { LIST_KEY_MISSING_MESSAGE } from '../src/renderer/components/DedicatedTeardownRow'
import { NOTHING_TO_DELETE_MESSAGE, type DedicatedTeardownResult } from '../src/renderer/dedicatedTeardownFlow'
import type { PublishedEntry } from '../src/renderer/publishedIndex'
import type { DedicatedResumedNote } from '../src/renderer/apprunDedicatedActions'

// ── 専有型の「すべて削除」の見た目: 手順6も 📡 の行も、同じ部品が描く（2026-10-08）──────────────────────────────
// 見た目の部品（DedicatedTeardownView）を本物の react-dom/server で HTML にして、
//   ・進み具合（文・始まってからの時間・閉じても進むこと）と、結果（すべて削除しました／削除中です／残っているもの）が出ること
//   ・入口ごとに違ってよいのは、押し直す場所の呼び方（retryHint）と、AI に相談するボタンの有無だけ
// を確かめる。ここは描くだけの部品なので、判断（何を消すか・いつ確認するか）は tests/dedicatedTeardownEntries.test.ts。
// （StageEstimate の目安は useEffect で読むので、サーバ側の描画では出ない。その効果は tests/stageEstimateEffect.test.ts。）

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el)
const text = (h: string) => h.replace(/<[^>]*>/g, '')

const OK: DedicatedTeardownResult = { ok: true, executed: ['アプリケーション『app1』を削除しました（消えたことを確認）', 'クラスタ『c1』を削除しました'], message: '削除の要求はすべて受け付けられました。', remaining: {} }
const FAILED: DedicatedTeardownResult = {
  ok: false, executed: [], message: 'ロードバランサの削除に失敗しました',
  remaining: { applicationID: 'app1', loadBalancerID: 'l1', asgID: 'a1', clusterID: 'c1', storageBucket: 'koto-data-x' },
}
const FAILED_NO_STORAGE: DedicatedTeardownResult = { ok: false, executed: [], message: 'アプリの削除に失敗しました', remaining: { applicationID: 'app1' } }
const IN_PROGRESS: DedicatedTeardownResult = {
  ok: false, executed: [], message: '待ち切れませんでした', remaining: { loadBalancerID: 'l1' }, inProgress: { loadBalancerID: 'l1', asgID: 'a1', clusterID: 'c1' },
}

describe('DedicatedTeardownResultView: 結果', () => {
  it('★ 成功: 「すべて削除しました」と、起きたことの一覧。残っているものの赤い欄は出ない', () => {
    const t = text(html(createElement(DedicatedTeardownResultView, { result: OK, notes: [], retryHint: '手順6' })))
    expect(t).toContain('✅ すべて削除しました')
    expect(t).toContain("✅ アプリケーション『app1』を削除しました（消えたことを確認）")
    expect(t).not.toContain('削除できませんでした')
    expect(t).not.toContain('課金が続きます')
  })

  it('★ 失敗: 残っているもの（アプリ → LB → ASG → クラスタ → 保存場所）を順に出し、課金が続くことと、コントロールパネルへの導線を言う', () => {
    const h = html(createElement(DedicatedTeardownResultView, { result: FAILED, notes: [], retryHint: '手順6' }))
    const t = text(h)
    expect(t).toContain('⚠️ 削除できませんでした')
    expect(t).toContain('削除できずに残っているものがあります。残っている間は課金が続きます。')
    const at = ["アプリケーション『app1』", "ロードバランサ『l1』", "オートスケーリンググループ『a1』", "クラスタ『c1』", "保存場所『koto-data-x』（月額が続きます）"].map(k => t.indexOf(k))
    expect(at.every(i => i >= 0)).toBe(true)
    expect([...at].sort((x, y) => x - y)).toEqual(at)
    expect(h).toContain('コントロールパネルを開く')
  })

  it('★ 待ち切れず止まった: 黄色い「削除中です」。押し直す場所の呼び方は入口ごと（手順6／この一覧の 🗑 破棄）', () => {
    const step6 = text(html(createElement(DedicatedTeardownResultView, { result: IN_PROGRESS, notes: [], retryHint: '手順6' })))
    const list = text(html(createElement(DedicatedTeardownResultView, { result: IN_PROGRESS, notes: [], retryHint: 'この一覧の 🗑 破棄' })))
    expect(step6).toContain('⏳ 削除中です')
    expect(step6).toContain('削除中です。しばらくして手順6をもう一度押してください。')
    expect(list).toContain('削除中です。しばらくしてこの一覧の 🗑 破棄をもう一度押してください。')
    // 違うのは押し直す場所の呼び方だけ（ほかの文・並びは同じ）
    expect(list.replace('この一覧の 🗑 破棄', '手順6')).toBe(step6)
    expect(step6).not.toContain('削除できずに残っているものがあります') // 赤い失敗の文とは別
  })

  it('★ 保存場所だけが残った失敗: 📡 の入口は、もう一度削除できる場所（手順6）を添える。手順6には添えない（同じ節に押し直すボタンがある）', () => {
    const storageOnly: DedicatedTeardownResult = { ok: false, executed: [], message: '保存場所を削除できませんでした', remaining: { storageBucket: 'koto-data-x' }, appDeleted: true }
    const hint = 'もう一度削除するには手順6を押してください（テスト用の文）'
    const list = text(html(createElement(DedicatedTeardownResultView, { result: storageOnly, notes: [], retryHint: 'この一覧の 🗑 破棄', storageRetryHint: hint })))
    const step6 = text(html(createElement(DedicatedTeardownResultView, { result: storageOnly, notes: [], retryHint: '手順6' })))
    expect(list).toContain("保存場所『koto-data-x』（月額が続きます）")
    expect(list).toContain(hint)
    expect(step6).toContain("保存場所『koto-data-x』（月額が続きます）")
    expect(step6).not.toContain(hint)
    // 保存場所が残っていない失敗には添えない（無い保存場所の話をしない）
    const other = text(html(createElement(DedicatedTeardownResultView, { result: FAILED_NO_STORAGE, notes: [], retryHint: 'この一覧の 🗑 破棄', storageRetryHint: hint })))
    expect(other).not.toContain(hint)
  })

  // 2026-10-08 検分 C: 案内が指す場所へ、その場で行けるボタン（storageRetryAction）。案内の文と同じ条件のときだけ出る。
  it('★ 保存場所だけが残った失敗: 📡 の入口は案内の文の直後に「このプロジェクトを開く」ボタンを出す。ほかの条件では出さない', () => {
    const storageOnly: DedicatedTeardownResult = { ok: false, executed: [], message: '保存場所を削除できませんでした', remaining: { storageBucket: 'koto-data-x' }, appDeleted: true }
    const hint = 'もう一度削除するには、下の「このプロジェクトを開く」から手順6を押してください（テスト用の文）'
    const action = { label: 'このプロジェクトを開く', onClick: () => {} } // 押したときの処理は tests/publishedListDedicatedRow.test.ts（一覧の配線）
    const view = createElement(DedicatedTeardownResultView, { result: storageOnly, notes: [], retryHint: 'この一覧の 🗑 破棄', storageRetryHint: hint, storageRetryAction: action })
    const h = html(view)
    expect(h).toContain('>このプロジェクトを開く</button>')
    expect(h.indexOf(hint)).toBeGreaterThan(-1)
    expect(h.indexOf('>このプロジェクトを開く</button>'), '案内の文より前にボタンがある').toBeGreaterThan(h.indexOf(hint))
    // 条件が違うときは出さない: 文が無い入口（手順6）・保存場所が残っていない失敗・成功・削除中
    const noHint = html(createElement(DedicatedTeardownResultView, { result: storageOnly, notes: [], retryHint: '手順6', storageRetryAction: action }))
    expect(noHint).not.toContain('このプロジェクトを開く')
    const other = html(createElement(DedicatedTeardownResultView, { result: FAILED_NO_STORAGE, notes: [], retryHint: 'この一覧の 🗑 破棄', storageRetryHint: hint, storageRetryAction: action }))
    expect(other).not.toContain('このプロジェクトを開く')
    const ok = html(createElement(DedicatedTeardownResultView, { result: OK, notes: [], retryHint: 'この一覧の 🗑 破棄', storageRetryHint: hint, storageRetryAction: action }))
    expect(ok).not.toContain('このプロジェクトを開く')
  })

  // 2026-10-08 検分: 何も始まっていない失敗（別の操作が走っていて断られた・キーが無い・消すものが記録に無い）は、executed も remaining も空。
  // そこで「削除できずに残っているものがあります。残っている間は課金が続きます」と、中身の無い一覧つきで出すのは、起きていない課金の話になる。
  it('★★ 何も始まっていない失敗（断られた・キーが無い・記録に無い）には、赤い「課金が続きます」を出さない。理由の文（message）は出す', () => {
    const refused: DedicatedTeardownResult = { ok: false, executed: [], message: 'いま別の操作（公開）を実行中です。終わってからもう一度お試しください。', remaining: {} }
    const noKey: DedicatedTeardownResult = { ok: false, executed: [], message: 'API キーが未登録です', remaining: {} }
    const nothing: DedicatedTeardownResult = { ok: false, executed: [], message: NOTHING_TO_DELETE_MESSAGE, remaining: {} }
    for (const r of [refused, noKey, nothing]) {
      const h = html(createElement(DedicatedTeardownResultView, { result: r, notes: [], retryHint: '手順6' }))
      const t = text(h)
      expect(t, r.message).toContain('⚠️ 削除できませんでした')
      expect(t).toContain(r.message)
      expect(t, r.message).not.toContain('課金が続きます')
      expect(t).not.toContain('削除できずに残っているものがあります')
      expect(h).not.toContain('コントロールパネルを開く')
    }
  })

  it('何かが残っている／やりかけた失敗には、これまでどおり赤い「課金が続きます」を出す（残っているものが1つでもある・実行したことが1つでもある）', () => {
    expect(teardownFailureHasLeftover({ executed: [], remaining: { clusterID: 'c1' } })).toBe(true)
    expect(teardownFailureHasLeftover({ executed: [], remaining: { storageBucket: 'koto-data-x' } })).toBe(true)
    expect(teardownFailureHasLeftover({ executed: ['アプリケーション『app1』を削除しました'], remaining: {} })).toBe(true)
    expect(teardownFailureHasLeftover({ executed: [], remaining: {} })).toBe(false)
    expect(teardownFailureHasLeftover({ executed: [], remaining: { clusterID: undefined, asgID: '' } })).toBe(false)
    const t = text(html(createElement(DedicatedTeardownResultView, { result: FAILED, notes: [], retryHint: '手順6' })))
    expect(t).toContain('削除できずに残っているものがあります。残っている間は課金が続きます。')
  })

  it('★ 「🤖 AIに相談する」は、失敗のときだけ・出す入口だけ（📡 の一覧は画面全体を覆うので出さない）', () => {
    const withAi = html(createElement(DedicatedTeardownResultView, { result: FAILED, notes: [], retryHint: '手順6', onAskAi: () => {} }))
    const without = html(createElement(DedicatedTeardownResultView, { result: FAILED, notes: [], retryHint: 'この一覧の 🗑 破棄' }))
    const okWithAi = html(createElement(DedicatedTeardownResultView, { result: OK, notes: [], retryHint: '手順6', onAskAi: () => {} }))
    expect(withAi).toContain('AIに相談する')
    expect(without).not.toContain('AIに相談する')
    expect(okWithAi).not.toContain('AIに相談する')
  })

  it('閉じて開き直したあとの知らせ（見逃してはいけない警告）が、結果の上に出る。結果が無くても知らせは出る', () => {
    const note: DedicatedResumedNote = {
      kind: 'teardown', startedAt: 1, finishedAt: 2, ok: true,
      headline: '🔔 手順6 すべて削除の結果です。', message: '', warnings: ['⚠️ 保存場所『x』は残しました。月額が続きます'],
    }
    const t = text(html(createElement(DedicatedTeardownResultView, { result: OK, notes: [note], retryHint: '手順6' })))
    expect(t).toContain('🔔 手順6 すべて削除の結果です。')
    expect(t).toContain('保存場所『x』は残しました。月額が続きます')
    expect(t.indexOf('🔔')).toBeLessThan(t.indexOf('✅ すべて削除しました'))
    const only = text(html(createElement(DedicatedTeardownResultView, { result: null, notes: [note], retryHint: '手順6' })))
    expect(only).toContain('保存場所『x』は残しました')
    expect(only).not.toContain('すべて削除しました')
    expect(html(createElement(DedicatedTeardownResultView, { result: null, notes: [], retryHint: '手順6' }))).toBe('')
  })

  it('かかった時間（段ごとの時間）が付いていれば「かかった時間を見る」を出す（手順5・8と同じ部品）', () => {
    const withTimings: DedicatedTeardownResult = { ...OK, stageTimings: { stages: [{ stage: 'teardown.lb', ms: 540_000 }], totalMs: 540_000 } as any }
    expect(html(createElement(DedicatedTeardownResultView, { result: withTimings, notes: [], retryHint: '手順6' }))).toContain('data-stage-timing-details')
    expect(html(createElement(DedicatedTeardownResultView, { result: OK, notes: [], retryHint: '手順6' }))).not.toContain('data-stage-timing-details')
  })
})

describe('DedicatedTeardownProgress: 進み具合', () => {
  const START = Date.parse('2026-10-08T00:00:00.000Z')
  it('★ 文と、記録が「走っている」と言うときの始まってからの時間・閉じても進むこと・Koto を終了すると止まること', () => {
    const t = text(html(createElement(DedicatedTeardownProgress, {
      progress: 'ロードバランサの削除を待っています（3分経過）…', runningKind: 'teardown',
      runningRecord: { startedAt: START, progress: { stage: 'teardown.lb' } }, nowMs: START + 3 * 60_000 + 5000,
    })))
    expect(t).toContain('ロードバランサの削除を待っています（3分経過）…')
    expect(t).toContain('始まってから約3分')
    expect(t).toContain('この画面を閉じても、削除は最後まで進みます。')
    expect(t).toContain('Koto 自体を終了すると、処理は途中で止まり')
  })

  it('記録が「走っている」と言わない（この画面が始めた直後）あいだは、文だけを出す', () => {
    const t = text(html(createElement(DedicatedTeardownProgress, { progress: '準備しています', runningKind: null, runningRecord: null, nowMs: START })))
    expect(t).toBe('準備しています')
  })

  it('別の操作（公開など）が走っているときの記録は、削除の経過として出さない', () => {
    const t = text(html(createElement(DedicatedTeardownProgress, {
      progress: null, runningKind: 'publish', runningRecord: { startedAt: START, progress: { stage: 'publish.image' } }, nowMs: START + 120_000,
    })))
    expect(t).toBe('')
  })
})

describe('DedicatedTeardownRow: 📡 の行の 🗑', () => {
  const ENTRY: PublishedEntry = {
    dir: '/tmp/proj', projectName: 'proj', target: 'sakura-apprun-dedicated', label: '📦 さくらのAppRun（専有型）',
    url: 'https://app.example.com/', publishedAt: '2026-09-28T00:00:00.000Z', dateUnknown: false,
    hanamiiProjectId: null, registryName: null, registryAdopted: false,
  }
  const render = (over: { blocked?: boolean } = {}) => html(createElement(DedicatedTeardownRow, {
    entry: ENTRY, blocked: over.blocked ?? false, onBusyChange: () => {}, onOutcome: () => {}, onFinished: () => {},
    render: ({ button, below }) => createElement('div', null, button, below),
  }))

  it('★ 押せる 🗑 破棄のボタンを、行の本体（render）へ渡す。実行中でなければ進み具合の枠は出ない', () => {
    const h = render()
    expect(text(h)).toBe('🗑 破棄')
    expect(h).not.toContain('disabled=""')
    expect(h).not.toContain('data-dedicated-teardown-progress')
    expect(h).toContain('title="公開を止めて、作られたものをすべて削除します（アプリ・ロードバランサ・オートスケーリンググループ・クラスタ）"')
  })

  it('ほかの行の破棄が走っているあいだは、押せない', () => {
    expect(render({ blocked: true })).toContain('disabled=""')
  })

  it('行の本体（render）へ渡すのは button・below・busy の3つ。この行の削除が走っていなければ busy:false', () => {
    let parts: Record<string, unknown> | null = null
    html(createElement(DedicatedTeardownRow, {
      entry: ENTRY, blocked: false, onBusyChange: () => {}, onOutcome: () => {}, onFinished: () => {},
      render: p => { parts = p as unknown as Record<string, unknown>; return null },
    }))
    expect(Object.keys(parts ?? {}).sort()).toEqual(['below', 'busy', 'button'])
    expect((parts as any).busy).toBe(false)
    expect((parts as any).below).toBeNull()
  })

  it('キーが無いときの案内は、📡 の言い方（「認証情報」で登録）', () => {
    expect(LIST_KEY_MISSING_MESSAGE).toBe('さくらのクラウドの API キーが未登録です。「認証情報」で登録してから、もう一度お試しください。')
  })
})
