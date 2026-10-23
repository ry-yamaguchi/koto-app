import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import TeardownResultView, { teardownFailureHasLeftover } from '../src/renderer/components/teardown/TeardownResultView'
import TeardownProgress from '../src/renderer/components/teardown/TeardownProgress'
import TeardownRow from '../src/renderer/components/teardown/TeardownRow'
import {
  dedicatedTeardownSpec, DEDICATED_TEARDOWN_WORDS, DEDICATED_LIST_KEY_MISSING_MESSAGE, DEDICATED_NOTHING_TO_DELETE_MESSAGE,
} from '../src/renderer/teardown/targets/dedicated'
import { toTeardownView } from '../src/shared/teardownResult'
import { PUBLISH_TARGET_CONSOLE } from '../src/renderer/publishStatus'
import type { PublishedEntry } from '../src/renderer/publishedIndex'
import type { TeardownResumedNote } from '../src/renderer/teardown/watch'

// ── 専有型の「すべて削除」の見た目: 手順6も 📡 の行も、同じ共通の部品が描く（2026-10-08 → 0.6.22 3B-5 で共通の部品に向け直し）──────────────
// 見た目の部品（components/teardown/）を、専有型の言葉（DEDICATED_TEARDOWN_WORDS）で本物の react-dom/server で HTML にして、
//   ・進み具合（文・始まってからの時間・閉じても進むこと）と、結果（すべて削除しました／削除中です／残っているもの）が出ること
//   ・入口ごとに違ってよいのは、押し直す場所の呼び方（retryHint）と、AI に相談するボタンの有無だけ
// を確かめる。ここは描くだけの部品なので、判断（何を消すか・いつ確認するか）は tests/dedicatedTeardownEntries.test.ts。
// （StageEstimate の目安は useEffect で読むので、サーバ側の描画では出ない。その効果は tests/stageEstimateEffect.test.ts。）
//
// 3B-5: 手本の DedicatedTeardownView／DedicatedTeardownRow から共通の TeardownResultView／TeardownProgress／TeardownRow に向け直した。
// 期待を変えたのは次の所だけ（設計書 10.11.13 の (B)）:
//   ・V1  行のボタンは「🗑 削除」。押し直す場所の呼び方は「この一覧の 🗑 削除」
//   ・V7  何も始まっていない失敗にも管理画面（コントロールパネル）への導線を出す。⚠️ の行は「✅ 」を付けず警告の枠へ。空の message の枠は出さない。残した保存場所の月額の警告をその場の結果にも出す
//   ・V16 行の title は共通の文（手本の末尾の括弧「（アプリ・ロードバランサ・…）」はなくなる）
//   ・V8  知らせの見出しは「🔔 削除の結果（HH:MM に終わりました）」（この部品は知らせを材料として受け取るだけなので、文字は材料のとおり）

const DEDICATED = 'sakura-apprun-dedicated' as const
const WORDS = DEDICATED_TEARDOWN_WORDS
/** 専有型の管理画面とコントロールパネルは同じ入口（publishStatus.ts）。 */
const CONSOLE_URL = PUBLISH_TARGET_CONSOLE[DEDICATED]

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el)
const text = (h: string) => h.replace(/<[^>]*>/g, '')
const count = (s: string, part: string) => s.split(part).length - 1

type Reply = Parameters<typeof toTeardownView>[1]
/** 結果の部品を専有型の言葉で描く。`result` は main の返り値（その場の結果）。 */
function renderResult(result: Reply | null, over: Partial<Parameters<typeof TeardownResultView>[0]> = {}): string {
  return html(createElement(TeardownResultView, {
    view: result === null ? null : toTeardownView(DEDICATED, result), notes: [], words: WORDS, retryHint: '手順6',
    serviceConsoleUrl: CONSOLE_URL, storageConsoleUrl: CONSOLE_URL, ...over,
  }))
}

const OK = { ok: true, executed: ['アプリケーション『app1』を削除しました（消えたことを確認）', 'クラスタ『c1』を削除しました'], message: '削除の要求はすべて受け付けられました。', remaining: {} }
const FAILED = {
  ok: false, executed: [], message: 'ロードバランサの削除に失敗しました',
  remaining: { applicationID: 'app1', loadBalancerID: 'l1', asgID: 'a1', clusterID: 'c1', storageBucket: 'koto-data-x' },
}
const FAILED_NO_STORAGE = { ok: false, executed: [], message: 'アプリの削除に失敗しました', remaining: { applicationID: 'app1' } }
const IN_PROGRESS = {
  ok: false, executed: [], message: '待ち切れませんでした', remaining: { loadBalancerID: 'l1' }, inProgress: { loadBalancerID: 'l1', asgID: 'a1', clusterID: 'c1' },
}
const STORAGE_ONLY = { ok: false, executed: [], message: '保存場所を削除できませんでした', remaining: { storageBucket: 'koto-data-x' }, appDeleted: true }

describe('TeardownResultView（専有型の言葉）: 結果', () => {
  it('★ 成功: 「すべて削除しました」と、起きたことの一覧。残っているものの赤い欄は出ない', () => {
    const t = text(renderResult(OK))
    expect(t).toContain('✅ すべて削除しました')
    expect(t).toContain('✅ アプリケーション『app1』を削除しました（消えたことを確認）')
    expect(t).not.toContain('削除できませんでした')
    expect(t).not.toContain('課金が続きます')
  })

  it('★ 失敗: 残っているもの（アプリ → LB → ASG → クラスタ → 保存場所）を順に出し、課金が続くことと、コントロールパネルへの導線を言う', () => {
    const h = renderResult(FAILED)
    const t = text(h)
    expect(t).toContain('⚠️ 削除できませんでした')
    expect(t).toContain('削除できずに残っているものがあります。残っている間は課金が続きます。')
    const at = ["アプリケーション『app1』", "ロードバランサ『l1』", "オートスケーリンググループ『a1』", "クラスタ『c1』", "保存場所『koto-data-x』（月額が続きます）"].map(k => t.indexOf(k))
    expect(at.every(i => i >= 0)).toBe(true)
    expect([...at].sort((x, y) => x - y)).toEqual(at)
    expect(h).toContain('コントロールパネルを開く')
  })

  it('★ 待ち切れず止まった: 黄色い「削除中です」。押し直す場所の呼び方は入口ごと（手順6／この一覧の 🗑 削除）', () => {
    const step6 = text(renderResult(IN_PROGRESS, { retryHint: '手順6' }))
    const list = text(renderResult(IN_PROGRESS, { retryHint: 'この一覧の 🗑 削除' }))
    expect(step6).toContain('⏳ 削除中です')
    expect(step6).toContain('削除中です。しばらくして手順6をもう一度押してください。')
    expect(list).toContain('削除中です。しばらくしてこの一覧の 🗑 削除をもう一度押してください。')
    // 違うのは押し直す場所の呼び方だけ（ほかの文・並びは同じ）
    expect(list.replace('この一覧の 🗑 削除', '手順6')).toBe(step6)
    expect(step6).not.toContain('削除できずに残っているものがあります') // 赤い失敗の文とは別
  })

  it('★ 保存場所だけが残った失敗: 📡 の入口は、もう一度削除できる場所の案内を添える。手順6には添えない（同じ節に押し直すボタンがある）', () => {
    const hint = 'もう一度削除するには、この行の 🗑 削除を押してください（テスト用の文）'
    const list = text(renderResult(STORAGE_ONLY, { retryHint: 'この一覧の 🗑 削除', storageRetryHint: hint }))
    const step6 = text(renderResult(STORAGE_ONLY, { retryHint: '手順6' }))
    expect(list).toContain("保存場所『koto-data-x』（月額が続きます）")
    expect(list).toContain(hint)
    expect(step6).toContain("保存場所『koto-data-x』（月額が続きます）")
    expect(step6).not.toContain(hint)
    // 保存場所が残っていない失敗には添えない（無い保存場所の話をしない）
    const other = text(renderResult(FAILED_NO_STORAGE, { retryHint: 'この一覧の 🗑 削除', storageRetryHint: hint }))
    expect(other).not.toContain(hint)
  })

  // 2026-10-08 検分 C: 案内の下に、その場で行けるボタン（storageRetryAction）。案内の文と同じ条件のときだけ出る。
  it('★ 保存場所だけが残った失敗: 📡 の入口は案内の文の直後に「このプロジェクトを開く」ボタンを出す。ほかの条件では出さない', () => {
    const hint = 'もう一度削除するには、この行の 🗑 削除を押してください（テスト用の文）'
    const action = { label: 'このプロジェクトを開く', onClick: () => {} } // 押したときの処理は tests/publishedListDedicatedRow.test.ts（一覧の配線）
    const h = renderResult(STORAGE_ONLY, { retryHint: 'この一覧の 🗑 削除', storageRetryHint: hint, storageRetryAction: action })
    expect(h).toContain('>このプロジェクトを開く</button>')
    expect(h.indexOf(hint)).toBeGreaterThan(-1)
    expect(h.indexOf('>このプロジェクトを開く</button>'), '案内の文より前にボタンがある').toBeGreaterThan(h.indexOf(hint))
    // 条件が違うときは出さない: 文が無い入口（手順6）・保存場所が残っていない失敗・成功・削除中
    expect(renderResult(STORAGE_ONLY, { retryHint: '手順6', storageRetryAction: action })).not.toContain('このプロジェクトを開く')
    expect(renderResult(FAILED_NO_STORAGE, { storageRetryHint: hint, storageRetryAction: action })).not.toContain('このプロジェクトを開く')
    expect(renderResult(OK, { storageRetryHint: hint, storageRetryAction: action })).not.toContain('このプロジェクトを開く')
    expect(renderResult(IN_PROGRESS, { storageRetryHint: hint, storageRetryAction: action })).not.toContain('このプロジェクトを開く')
  })

  // 2026-10-08 検分: 何も始まっていない失敗（別の操作が走っていて断られた・キーが無い・消すものが記録に無い）は、executed も remaining も空。
  // そこで「削除できずに残っているものがあります。残っている間は課金が続きます」と、中身の無い一覧つきで出すのは、起きていない課金の話になる。
  // V7: 失敗には、残りの一覧が無くても管理画面への導線を出す（専有型は2つの URL が同じなので「コントロールパネルを開く」が1つ）。
  it('★★ 何も始まっていない失敗（断られた・キーが無い・記録に無い）には、赤い「課金が続きます」を出さない。理由の文（message）は出す。V7: コントロールパネルへの導線は1つ出る', () => {
    const refused = { ok: false, executed: [], message: 'いま別の操作（公開）を実行中です。終わってからもう一度お試しください。', remaining: {} }
    const noKey = { ok: false, executed: [], message: 'API キーが未登録です', remaining: {} }
    const nothing = { ok: false, executed: [], message: DEDICATED_NOTHING_TO_DELETE_MESSAGE, remaining: {} }
    for (const r of [refused, noKey, nothing]) {
      const h = renderResult(r)
      const t = text(h)
      expect(t, r.message).toContain('⚠️ 削除できませんでした')
      expect(t).toContain(r.message)
      expect(t, r.message).not.toContain('課金が続きます')
      expect(t).not.toContain('削除できずに残っているものがあります')
      expect(count(h, 'コントロールパネルを開く'), r.message).toBe(1)
    }
  })

  it('何かが残っている／やりかけた失敗には、これまでどおり赤い「課金が続きます」を出す（残っているものが1つでもある・実行したことが1つでもある）', () => {
    const left = (r: Reply) => teardownFailureHasLeftover(toTeardownView(DEDICATED, r))
    expect(left({ ok: false, executed: [], message: '', remaining: { clusterID: 'c1' } })).toBe(true)
    expect(left({ ok: false, executed: [], message: '', remaining: { storageBucket: 'koto-data-x' } })).toBe(true)
    expect(left({ ok: false, executed: ['アプリケーション『app1』を削除しました'], message: '', remaining: {} })).toBe(true)
    expect(left({ ok: false, executed: [], message: '', remaining: {} })).toBe(false)
    expect(left({ ok: false, executed: [], message: '', remaining: { clusterID: undefined, asgID: '' } })).toBe(false)
    const t = text(renderResult(FAILED))
    expect(t).toContain('削除できずに残っているものがあります。残っている間は課金が続きます。')
  })

  it('★ 「🤖 AIに相談する」は、失敗のときだけ・出す入口だけ（📡 の一覧は画面全体を覆うので出さない）', () => {
    const withAi = renderResult(FAILED, { onAskAi: () => {} })
    const without = renderResult(FAILED, { retryHint: 'この一覧の 🗑 削除' })
    const okWithAi = renderResult(OK, { onAskAi: () => {} })
    expect(withAi).toContain('AIに相談する')
    expect(without).not.toContain('AIに相談する')
    expect(okWithAi).not.toContain('AIに相談する')
  })

  it('閉じて開き直したあとの知らせ（見逃してはいけない警告）が、結果の上に出る。結果が無くても知らせは出る', () => {
    // 知らせの材料は main の記録から resumedTeardownNote が作る（見出しは「🔔 削除の結果（HH:MM に終わりました）」。V8）。ここは材料を渡して描き方だけを見る。
    const note: TeardownResumedNote = {
      startedAt: 1, finishedAt: 2, ok: true, call: 'doneWithWarnings',
      headline: '🔔 削除の結果（12:34 に終わりました）', message: '', warnings: ['⚠️ 保存場所『x』は残しました。月額が続きます'],
    }
    const t = text(renderResult(OK, { notes: [note] }))
    expect(t).toContain('🔔 削除の結果（12:34 に終わりました）')
    expect(t).toContain('保存場所『x』は残しました。月額が続きます')
    expect(t.indexOf('🔔')).toBeLessThan(t.indexOf('✅ すべて削除しました'))
    const only = text(renderResult(null, { notes: [note] }))
    expect(only).toContain('保存場所『x』は残しました')
    expect(only).not.toContain('すべて削除しました')
    expect(renderResult(null)).toBe('')
  })

  it('かかった時間（段ごとの時間）が付いていれば「かかった時間を見る」を出す（手順5・8と同じ部品）', () => {
    const withTimings = { ...OK, stageTimings: { stages: [{ stage: 'teardown.lb', ms: 540_000 }], totalMs: 540_000 } as any }
    expect(renderResult(withTimings)).toContain('data-stage-timing-details')
    expect(renderResult(OK)).not.toContain('data-stage-timing-details')
  })
})

// V7（設計書 10.11.2 の2 (e)）: 共通の結果欄にしたことで、専有型の結果欄も HANAMII・共用型と同じ見せ方になる。
describe('TeardownResultView（専有型の言葉）: V7 共通の結果欄の見せ方', () => {
  it('★★ ⚠️ で始まる行は「✅ 」を付けず、警告の枠へ出す（アクセスキーの無効化に失敗した回の警告など）', () => {
    const warn = '⚠️ 保存場所のアクセスキーを無効にできませんでした。コントロールパネルのパーミッションから削除してください'
    const h = renderResult({ ...OK, executed: [...OK.executed, warn] })
    const t = text(h)
    expect(h).toContain('data-teardown-warnings')
    expect(t).toContain(warn)
    expect(t).not.toContain('✅ ⚠️')
    expect(t).toContain('✅ クラスタ『c1』を削除しました') // 起きたことの行はそのまま
  })

  it('★★ 残した保存場所（ほかのプロジェクトも使う）の月額の警告を、その場の結果にも出す（開き直したときだけにしない）', () => {
    const t = text(renderResult({ ...OK, keptBucketName: 'koto-data-x', keptBucketNames: ['koto-data-x'] }))
    expect(t).toContain('koto-data-x')
    expect(t).toContain('月額')
  })

  it('★ message が空なら、空のメッセージの枠（とコピーのボタン）を出さない。あれば出す', () => {
    expect(renderResult({ ...OK, message: '' })).not.toContain('メッセージをコピー')
    expect(renderResult({ ...OK, message: '削除の要求はすべて受け付けられました。' })).toContain('メッセージをコピー')
  })
})

describe('TeardownProgress（専有型の言葉）: 進み具合', () => {
  const START = Date.parse('2026-10-08T00:00:00.000Z')
  it('★ 文と、記録が「走っている」と言うときの始まってからの時間・閉じても進むこと・Koto を終了すると止まること', () => {
    const t = text(html(createElement(TeardownProgress, {
      words: WORDS, progress: 'ロードバランサの削除を待っています（3分経過）…', running: true,
      runningRecord: { startedAt: START, progress: { stage: 'teardown.lb' } }, nowMs: START + 3 * 60_000 + 5000,
    })))
    expect(t).toContain('ロードバランサの削除を待っています（3分経過）…')
    expect(t).toContain('始まってから約3分')
    expect(t).toContain('この画面を閉じても、削除は最後まで進みます。')
    expect(t).toContain('Koto 自体を終了すると、処理は途中で止まり')
  })

  it('記録が「走っている」と言わない（この画面が始めた直後）あいだは、文だけを出す', () => {
    const t = text(html(createElement(TeardownProgress, { words: WORDS, progress: '準備しています', running: false, runningRecord: null, nowMs: START })))
    expect(t).toBe('準備しています')
  })

  it('別の操作（公開など）が走っているときの記録は、削除の経過として出さない（running は削除の記録だけで立つ）', () => {
    const t = text(html(createElement(TeardownProgress, { words: WORDS, progress: null, running: false, runningRecord: null, nowMs: START + 120_000 })))
    expect(t).toBe('')
  })
})

describe('TeardownRow（専有型の仕様書）: 📡 の行の 🗑', () => {
  const ENTRY: PublishedEntry = {
    dir: '/tmp/proj', projectName: 'proj', target: 'sakura-apprun-dedicated', label: '📦 さくらのAppRun（専有型）',
    url: 'https://app.example.com/', publishedAt: '2026-09-28T00:00:00.000Z', dateUnknown: false,
    hanamiiProjectId: null, registryName: null,
  }
  const props = (over: { blocked?: boolean; render?: (p: any) => any } = {}) => ({
    spec: dedicatedTeardownSpec, entry: ENTRY, keyMissingMessage: DEDICATED_LIST_KEY_MISSING_MESSAGE, blocked: over.blocked ?? false,
    onBusyChange: () => {}, onOutcome: () => {}, onFinished: () => {},
    render: over.render ?? (({ button, below }: any) => createElement('div', null, button, below)),
  })

  it('★ V1・V16: 押せる「🗑 削除」のボタンを、行の本体（render）へ渡す。実行中でなければ進み具合の枠は出ない。title は共通の文', () => {
    const h = html(createElement(TeardownRow, props()))
    expect(text(h)).toBe('🗑 削除')
    expect(h).not.toContain('🗑 破棄')
    expect(h).not.toContain('disabled=""')
    expect(h).not.toContain('data-teardown-row-progress')
    expect(h).toContain('title="公開を止めて、作られたものをすべて削除します"')
    expect(h).not.toContain('アプリ・ロードバランサ・オートスケーリンググループ・クラスタ）') // 手本の title の末尾の括弧は、確認の先頭が並べるのでなくなった
  })

  it('ほかの行の破棄が走っているあいだは、押せない', () => {
    expect(html(createElement(TeardownRow, props({ blocked: true })))).toContain('disabled=""')
  })

  it('行の本体（render）へ渡すのは button・below・busy の3つ。この行の削除が走っていなければ busy:false', () => {
    let parts: Record<string, unknown> | null = null
    html(createElement(TeardownRow, props({ render: p => { parts = p as Record<string, unknown>; return null } })))
    expect(Object.keys(parts ?? {}).sort()).toEqual(['below', 'busy', 'button'])
    expect((parts as any).busy).toBe(false)
    expect((parts as any).below).toBeNull()
  })

  it('キーが無いときの案内は、📡 の言い方（「認証情報」で登録）', () => {
    expect(DEDICATED_LIST_KEY_MISSING_MESSAGE).toBe('さくらのクラウドの API キーが未登録です。「認証情報」で登録してから、もう一度お試しください。')
    expect(props().keyMissingMessage).toBe(DEDICATED_LIST_KEY_MISSING_MESSAGE)
  })
})
