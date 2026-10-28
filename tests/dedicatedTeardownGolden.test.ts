import { describe, it, expect, afterEach } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import TeardownResultView from '../src/renderer/components/teardown/TeardownResultView'
import { buildTeardownConfirm } from '../src/renderer/teardown/confirm'
import { loadTeardownFacts, electronTeardownFactsApi } from '../src/renderer/teardown/facts'
import { resumedTeardownNote, type TeardownResumedNote } from '../src/renderer/teardown/watch'
import type { TeardownFacts } from '../src/renderer/teardown/types'
import {
  dedicatedTeardownSpec, DEDICATED_TEARDOWN_WORDS, DEDICATED_NOTHING_TO_DELETE_MESSAGE, DEDICATED_LIST_KEY_MISSING_MESSAGE,
  DEDICATED_PANEL_KEY_MISSING_MESSAGE, type DedicatedTeardownRecord,
} from '../src/renderer/teardown/targets/dedicated'
import { CONTROL_PANEL_URL } from '../src/renderer/components/ServicePrincipalSection'
import { PUBLISH_TARGET_CONSOLE, PUBLISH_TARGET_LABEL } from '../src/renderer/publishStatus'
import { estimatesFor, emptyStore, estimateLineFor } from '../src/shared/stageEstimate'
import { STAGE } from '../src/shared/stageTiming'
import { teardownRemainingWarnings } from '../src/shared/cloudCost'
import {
  GOLDEN_CONFIRM_CASES, GOLDEN_RESULT_CASES, GOLDEN_NOTE_CASES, GOLDEN_FACTS_CASES, GOLDEN_FULL_RECORD, GOLDEN_FACTS_DIR, GOLDEN_FACTS_RECORD,
  GOLDEN_LB_LINE, INTENDED_CONFIRM_DIFFERENCES, markupText, recordOfNoteCase, installFactsWindow, readGolden,
  type GoldenConfirmCase, type GoldenResultCase, type GoldenReply, type IntendedConfirmDifference,
} from './dedicatedGoldenCases'

// ── 手本の出力の写し（golden）との比べ: 専有型の仕様書（targets/dedicated.ts）を共通の部品に流すと、手本が返した文と同じ文になる ───────
//
// 設計書 10.11.12・10.11.19 の 3B-4。0.6.21 で直した文を、載せ替えで黙って失わないための試験。
// 比べる相手は、手本の関数が返した文を書き出した JSON（tests/fixtures/dedicated-teardown-golden.json）。材料は tests/dedicatedGoldenCases.ts の1か所
// （手本を呼んで写しを書き出していた tests/dedicatedGoldenCapture.test.ts は、手本と一緒に 3B-7 で消した）。**写しを新しい部品の出力で書き直さない**（比べる意味が無くなる）。
//
// 食い違ってよいのは、下の表に理由つきで載っている違い（設計書 10.11.12 の V1〜V16 のうち、ここで出るもの）だけ。表に無い違いは落ちる。
// 表の各行には、書いた件数（count）ぶんの材料にだけ当たることを見る試験がある（死んだ行・広すぎる行を作らない）。
//   確認の文 … V2（D10 の1行）・F6（以前の V4。0.6.24 F-6）・V5・V6
//   結果欄   … V1（📡 の押し直しの呼び方）・V7（警告の枠・月額の警告・空の message・管理画面への導線）・V17（残った保存場所の一覧の下の、削除する前の確かめ）
//   知らせ   … V8（開き直したときの見出し）
//   材料     … V3（ほかの公開先の読み口）
//   定数     … 画面の文の定数・言葉は1文字も変わらない
// 手本は 3B-7 で消えた。以後、この写し（JSON）が「0.6.21 の手本が返した文」の唯一の記録で、書き直せない（タグ v0.6.21 から取り直すしかない）。

const golden = readGolden()

afterEach(() => { delete (globalThis as any).window })

type Difference<C, T> = { id: string; why: string; count: number; apply: (golden: T, c: C) => T }

/** 表を全部当てた写し。 */
function expectedOf<C, T>(rows: Array<Difference<C, T>>, base: T, c: C): T {
  return rows.reduce((acc, row) => row.apply(acc, c), base)
}

// ═══════════════════════════════════════════════════════════════════════════════
// 確認の文
// ═══════════════════════════════════════════════════════════════════════════════

describe('確認の文: 本物の専有型の仕様書で、手本が返した確認の文と同じになる', () => {
  const estimates = estimatesFor(emptyStore())

  it('材料の前提: 目安の一文（GOLDEN_LB_LINE）は、目安の仕組みの出力そのもの（数字をテストが決め打ちにしていない）', () => {
    expect(estimateLineFor(STAGE.teardownLb, estimates)).toBe(GOLDEN_LB_LINE)
  })

  /** 新しい部品に渡す材料。時間の予告は、仕様書の waitNote が記録と目安から作る。 */
  function factsOf(c: GoldenConfirmCase): TeardownFacts<DedicatedTeardownRecord> {
    const record = (c.record ?? GOLDEN_FULL_RECORD) as DedicatedTeardownRecord
    return {
      projectName: 'myapp',
      record,
      placements: c.placements ?? [],
      placementsUnreadable: c.placementsUnreadable ?? false,
      placementsUnreadableCause: c.placementsUnreadable ? (c.cause ?? null) : null,
      otherTargets: c.otherTargets ?? [],
      otherTargetsUnreadable: c.otherTargetsUnreadable ?? false,
      waitNote: dedicatedTeardownSpec.waitNote!(record, c.estimate ? estimates : null),
    }
  }
  const confirmOf = (c: GoldenConfirmCase) => buildTeardownConfirm(dedicatedTeardownSpec, factsOf(c))

  const D10_NAMELESS = '🌐 独自ドメインの DNS に、このロードバランサを指す A レコードがあれば、DNS の管理画面で削除してください。削除するロードバランサの IP は、いずれ別の利用者に割り当てられることがあります。'
  const hasLb = (c: GoldenConfirmCase) => !!(c.record ?? GOLDEN_FULL_RECORD).loadBalancerID

  // V2 は本物の仕様書だけが足す（偽の仕様書には notes が無い）。位置は、💾・ほかの公開先の段落のあと、時間の予告と最後の問いの前。
  const V2: IntendedConfirmDifference = {
    id: 'V2',
    why: 'ロードバランサが記録にあるとき、確認に DNS の A レコードの1行（D10。設計書 10.6.2 の0b・10.11.8）。記録にホスト名が無い材料なので名前なしの文。位置は時間の予告の前',
    count: 18,
    apply: (body, c) => {
      if (!hasLb(c)) return body
      const paragraphs = body.split('\n\n')
      // 最後の段落は「…よろしいですか？」の問い。時間の予告（⏳）があれば、その前に置く。
      const waitAt = paragraphs.length - 2
      const at = paragraphs[waitAt]?.startsWith('⏳ ') ? waitAt : paragraphs.length - 1
      paragraphs.splice(at, 0, D10_NAMELESS)
      return paragraphs.join('\n\n')
    },
  }
  const ROWS: IntendedConfirmDifference[] = [V2, ...INTENDED_CONFIRM_DIFFERENCES]
  const expectedBody = (c: GoldenConfirmCase) => expectedOf(ROWS, golden.confirm[c.name].body, c)

  it('写しの材料が、確認の文の材料（GOLDEN_CONFIRM_CASES）と過不足なく同じ', () => {
    expect(Object.keys(golden.confirm).sort()).toEqual(GOLDEN_CONFIRM_CASES.map(c => c.name).sort())
  })

  it.each(GOLDEN_CONFIRM_CASES.map(c => [c.name, c] as const))('★★ %s: 見出し・ボタン・danger が写しと同じで、本文は「意図して違う文」の表を当てた写しと一字一句同じ', (_name, c) => {
    const mine = confirmOf(c)
    const theirs = golden.confirm[c.name]
    expect(mine.title).toBe(theirs.title)
    expect(mine.confirmLabel).toBe(theirs.confirmLabel)
    expect(mine.danger).toBe(theirs.danger)
    expect(mine.body).toBe(expectedBody(c))
  })

  it.each(ROWS.map(row => [row.id, row] as const))('★★ 意図して違う文の表 %s: 書いた件数（count）ぶんの材料にだけ当たり、当たった材料の本文は写しと違う（死んだ行・広すぎる行を作らない）', (_id, row) => {
    const hit = GOLDEN_CONFIRM_CASES.filter(c => row.apply(golden.confirm[c.name].body, c) !== golden.confirm[c.name].body)
    expect(hit.map(c => c.name)).toHaveLength(row.count)
  })

  it('★★ 表に無い違いは落ちる: 新しい部品の本文が写しと違う材料は、表のどれかの行に当たる材料と過不足なく同じ', () => {
    const differing = GOLDEN_CONFIRM_CASES.filter(c => confirmOf(c).body !== golden.confirm[c.name].body).map(c => c.name)
    const listed = GOLDEN_CONFIRM_CASES.filter(c => expectedBody(c) !== golden.confirm[c.name].body).map(c => c.name)
    expect(differing.sort()).toEqual(listed.sort())
  })

  it('★★ V2（D10）: ロードバランサがある回は DNS の A レコードの1行が、💾・ほかの公開先の段落のあと、時間の予告の前に1回だけ入る。ロードバランサが無い回は入らない', () => {
    const withLb = confirmOf({ name: 'x', placements: [{ bucket: 'koto-a', prefix: 'p/', shared: true }], otherTargets: ['HANAMII'], estimate: GOLDEN_LB_LINE }).body
    const paragraphs = withLb.split('\n\n')
    const at = paragraphs.indexOf(D10_NAMELESS)
    expect(at).toBeGreaterThan(0)
    expect(withLb.split(D10_NAMELESS)).toHaveLength(2) // 1回だけ
    expect(paragraphs[at - 1]).toMatch(/^⚠️ この保存場所は HANAMII でも使っているため/) // ほかの公開先の段落のあと
    expect(paragraphs[at + 1]).toMatch(/^⏳ ロードバランサの削除には時間がかかります/) // 時間の予告の前
    expect(paragraphs[at + 2]).toMatch(/^この操作は元に戻せません。/) // 最後の問いの前
    for (const name of ['ロードバランサが記録に無い（目安は出ない）', '保存場所だけ残った印だけ（押し直し）', 'アプリだけ', '記録が空（名前を挙げられるものが無い）']) {
      const c = GOLDEN_CONFIRM_CASES.find(x => x.name === name)!
      expect(confirmOf(c).body, name).not.toContain('🌐')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 結果欄
// ═══════════════════════════════════════════════════════════════════════════════

describe('結果欄: 本物の専有型の仕様書の toView ＋ TeardownResultView で、手本の結果欄と同じになる', () => {
  const SERVICE_CONSOLE = PUBLISH_TARGET_CONSOLE['sakura-apprun-dedicated']
  const CONSOLE_LINK = '🔧 コントロールパネルを開く'

  /** 入口が渡す材料のうち、入口の呼び方（V1: 📡 の押し直しは「🗑 削除」）。 */
  const retryHintOf = (c: GoldenResultCase) => c.retryHint.replace('🗑 破棄', '🗑 削除')

  function renderOf(c: GoldenResultCase): string {
    return markupText(renderToStaticMarkup(createElement(TeardownResultView, {
      view: c.result === null ? null : dedicatedTeardownSpec.toView(c.result),
      notes: (c.notes ?? []) as unknown as TeardownResumedNote[],
      words: DEDICATED_TEARDOWN_WORDS,
      retryHint: retryHintOf(c),
      serviceConsoleUrl: SERVICE_CONSOLE,
      storageConsoleUrl: CONTROL_PANEL_URL,
      ...(c.askAi ? { onAskAi: () => {} } : {}),
      ...(c.storageRetryHint ? { storageRetryHint: c.storageRetryHint } : {}),
      ...(c.storageRetryAction ? { storageRetryAction: { label: 'このプロジェクトを開く', onClick: () => {} } } : {}),
    })))
  }

  /** 失敗で、アプリが消えたと分かっていない（結果欄が管理画面への導線を足す回）。 */
  const failedWithoutAppGone = (r: GoldenReply | null) => !!r && !r.ok && r.appDeleted !== true

  const ROWS: Array<Difference<GoldenResultCase, string>> = [
    {
      id: 'V1',
      why: '📡 の行から押し直す呼び方が「この一覧の 🗑 破棄」→「この一覧の 🗑 削除」（行のボタンが「🗑 削除」になるため。設計書 10.6.2 の0・10.11.7 (1)）',
      count: 1,
      apply: text => text.replace('この一覧の 🗑 破棄', 'この一覧の 🗑 削除'),
    },
    {
      id: 'V7-message',
      why: '結果の message が空なら、空の枠（「コピー」だけの欄）を出さない（設計書 10.11.2 の2 (e)。手本は空でも出す）',
      count: 1,
      apply: (text, c) => {
        if (c.result?.message !== '') return text
        const lines = text.split('\n')
        const at = lines.indexOf('コピー')
        if (at >= 0) lines.splice(at, 1)
        return lines.join('\n')
      },
    },
    {
      id: 'V7-warn-line',
      why: '⚠️ で始まる行（鍵を無効にできなかった等）を「✅ ⚠️ …」の成功の行にせず、警告の枠に出す（設計書 10.11.2 の2 (e)）',
      count: 1,
      apply: text => {
        const lines = text.split('\n')
        const moved = lines.filter(l => l.startsWith('✅ ⚠️'))
        if (moved.length === 0) return text
        const rest = lines.filter(l => !l.startsWith('✅ ⚠️'))
        const at = rest.indexOf('コピー') // 警告の枠は message の枠のあと
        rest.splice(at + 1, 0, ...moved.map(l => l.slice('✅ '.length)))
        return rest.join('\n')
      },
    },
    {
      id: 'V7-kept',
      why: '残した保存場所（ほかのプロジェクトも使うので消さなかったもの）の月額の警告を、その場の結果にも出す（手本は開き直したときの知らせにしか出さない。設計書 10.11.2 の2 (e)）',
      count: 1,
      apply: (text, c) => {
        const r = c.result
        if (!r || !r.ok || !r.keptBucketName) return text
        const warning = teardownRemainingWarnings({ keptBucketName: r.keptBucketName, keptBucketNames: r.keptBucketNames ?? [] })[0]
        const lines = text.split('\n')
        const at = lines.indexOf('コピー')
        lines.splice(at + 1, 0, warning)
        return lines.join('\n')
      },
    },
    {
      id: 'V17-storage-check',
      why: '保存場所が残ったものの一覧があるとき、その下に1行足す: 削除する前に、ほかのプロジェクトも使っていないか確かめてもらう（保存場所はほかのプロジェクトも使っていることがあり、Koto は残った保存場所の中身を確かめていない。コントロールパネルで保存場所ごと削除すると、ほかのプロジェクトのデータも消える。2026-10-19 検分。手本は何も言わない）',
      count: 5,
      apply: text => {
        const lines = text.split('\n')
        const at = lines.map(l => /^保存場所『.+』（月額が続きます）$/.test(l)).lastIndexOf(true)
        if (at < 0) return text
        lines.splice(at + 1, 0, '保存場所は、ほかのプロジェクトも使っていないか確かめてから削除してください。消すと、そのプロジェクトのデータも消えます。')
        return lines.join('\n')
      },
    },
    {
      id: 'V7-console',
      why: '失敗（アプリが消えたと分かっていない回）に、残りの一覧が無くても管理画面への導線を出す。途中で止まった回・何も始まっていない失敗・キーが無い失敗が当たる（設計書 10.11.2 の2 (e)。専有型は2つの URL が同じなので1つ）',
      count: 5,
      apply: (text, c) => (failedWithoutAppGone(c.result) && !text.includes(CONSOLE_LINK) ? `${text}\n${CONSOLE_LINK}` : text),
    },
  ]
  const expectedText = (c: GoldenResultCase) => expectedOf(ROWS, golden.result[c.name], c)

  it('写しの材料が、結果欄の材料（GOLDEN_RESULT_CASES）と過不足なく同じ', () => {
    expect(Object.keys(golden.result).sort()).toEqual(GOLDEN_RESULT_CASES.map(c => c.name).sort())
  })

  it.each(GOLDEN_RESULT_CASES.map(c => [c.name, c] as const))('★★ %s: 「意図して違う文」の表を当てた写しと一字一句同じ', (_name, c) => {
    expect(renderOf(c)).toBe(expectedText(c))
  })

  it.each(ROWS.map(row => [row.id, row] as const))('★★ 意図して違う文の表 %s: 書いた件数（count）ぶんの材料にだけ当たり、当たった材料の文は写しと違う（死んだ行・広すぎる行を作らない）', (_id, row) => {
    const hit = GOLDEN_RESULT_CASES.filter(c => row.apply(golden.result[c.name], c) !== golden.result[c.name])
    expect(hit.map(c => c.name)).toHaveLength(row.count)
  })

  it('★★ 表に無い違いは落ちる: 新しい部品の文が写しと違う材料は、表のどれかの行に当たる材料と過不足なく同じ', () => {
    const differing = GOLDEN_RESULT_CASES.filter(c => renderOf(c) !== golden.result[c.name]).map(c => c.name)
    const listed = GOLDEN_RESULT_CASES.filter(c => expectedText(c) !== golden.result[c.name]).map(c => c.name)
    expect(differing.sort()).toEqual(listed.sort())
  })

  it('★ V7: 月額が続く警告は、その場の結果にも、閉じて開き直した知らせにも出る（どちらかにしか出ない穴を作らない）', () => {
    const kept = GOLDEN_RESULT_CASES.find(c => c.name === '残した保存場所つき（全部消えた）')!
    expect(renderOf(kept)).toContain('月額495円（税込）の課金は続きます')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 開き直したときの知らせ
// ═══════════════════════════════════════════════════════════════════════════════

describe('開き直したときの知らせ: 本物の専有型の言葉の resumedTeardownNote で、手本の resumedNoteOf と同じになる', () => {
  type Golden = (typeof golden.notes)[string]
  const noteOf = (c: (typeof GOLDEN_NOTE_CASES)[number]): Golden => {
    const n = resumedTeardownNote(DEDICATED_TEARDOWN_WORDS, recordOfNoteCase(c) as never)
    return { kind: 'teardown', ok: n.ok, finished: n.finishedAt !== null, headline: n.headline, message: n.message, warnings: n.warnings }
  }

  const ROWS: Array<Difference<(typeof GOLDEN_NOTE_CASES)[number], Golden>> = [
    {
      id: 'V8',
      why: '見出しが「🔔 手順6 すべて削除の結果です。」系 → 「🔔 削除の結果（HH:MM に終わりました）」（T162。「です」と句点をやめ、入口の名前を言わない。設計書 10.11.7 (2)・10.11.20 の G）',
      count: GOLDEN_NOTE_CASES.length,
      apply: g => ({ ...g, headline: g.headline.replace('🔔 手順6 すべて削除の結果', '🔔 削除の結果') }),
    },
  ]

  it('写しの材料が、知らせの材料（GOLDEN_NOTE_CASES）と過不足なく同じ', () => {
    expect(Object.keys(golden.notes).sort()).toEqual(GOLDEN_NOTE_CASES.map(c => c.name).sort())
  })

  it.each(GOLDEN_NOTE_CASES.map(c => [c.name, c] as const))('★★ %s: 見出し以外（成否・終わった時刻の有無・結果の一言・警告）は写しと同じ。見出しは V8', (_name, c) => {
    expect(noteOf(c)).toEqual(expectedOf(ROWS, golden.notes[c.name], c))
  })

  it.each(ROWS.map(row => [row.id, row] as const))('★★ 意図して違う文の表 %s: 書いた件数（count）ぶんの材料に当たる', (_id, row) => {
    const hit = GOLDEN_NOTE_CASES.filter(c => JSON.stringify(row.apply(golden.notes[c.name], c)) !== JSON.stringify(golden.notes[c.name]))
    expect(hit.map(c => c.name)).toHaveLength(row.count)
  })

  it('★★ 表に無い違いは落ちる: 新しい部品の知らせが写しと違う材料は、表の行に当たる材料と過不足なく同じ', () => {
    const differing = GOLDEN_NOTE_CASES.filter(c => JSON.stringify(noteOf(c)) !== JSON.stringify(golden.notes[c.name])).map(c => c.name)
    const listed = GOLDEN_NOTE_CASES.filter(c => JSON.stringify(expectedOf(ROWS, golden.notes[c.name], c)) !== JSON.stringify(golden.notes[c.name])).map(c => c.name)
    expect(differing.sort()).toEqual(listed.sort())
  })

  it('V8: 見出しは入口の名前（手順6）を言わない。手順6の知らせも 📡 の知らせも同じ「🔔 削除の結果」', () => {
    for (const c of GOLDEN_NOTE_CASES) expect(noteOf(c).headline, c.name).not.toContain('手順6')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 確認の材料（facts）
// ═══════════════════════════════════════════════════════════════════════════════

describe('確認の材料: 本物の口 ＋ 専有型の仕様書で、手本の loadDedicatedTeardownFacts と同じ材料になる', () => {
  /** 材料を読むとき、記録にロードバランサがある回にする（時間の予告の有無を、目安の有無だけで決められるように）。 */
  const RECORD: DedicatedTeardownRecord = { ...(GOLDEN_FACTS_RECORD as object), loadBalancerID: 'l1' } as DedicatedTeardownRecord
  const WAIT_HEAD = '⏳ ロードバランサの削除には時間がかかります。'

  async function load(over: Parameters<typeof installFactsWindow>[0]) {
    installFactsWindow(over)
    ;(globalThis as any).window.electronAPI.apprunDedicated = { state: async () => RECORD }
    return loadTeardownFacts(GOLDEN_FACTS_DIR, dedicatedTeardownSpec, electronTeardownFactsApi())
  }

  /** 新しい材料を、写し（手本の形）に直す。手本の `lbEstimateLine` は、新しい部品では `waitNote` の中の目安の一文になる。 */
  function inGoldenShape(f: TeardownFacts<DedicatedTeardownRecord>): Record<string, unknown> {
    const line = f.waitNote === null ? null : f.waitNote.slice(WAIT_HEAD.length).replace(/。$/, '')
    return {
      projectName: f.projectName,
      record: f.record === RECORD ? GOLDEN_FACTS_RECORD : f.record,
      placements: f.placements,
      placementsUnreadable: f.placementsUnreadable,
      placementsUnreadableCause: f.placementsUnreadableCause,
      otherTargets: f.otherTargets,
      otherTargetsUnreadable: f.otherTargetsUnreadable,
      lbEstimateLine: line,
    }
  }

  // V3: 読み口が変わる材料。旧い記録だけの公開先も名前で言い、保存場所を使わない公開先（レンタルサーバ）は挙げない（D9=2。設計書 10.7.16 の親の判断3）。
  const V3: Record<string, string[]> = {
    'ほかの公開先にレンタルサーバがある（手本は挙げる）': [PUBLISH_TARGET_LABEL.vercel],
    '旧い記録だけの公開先がある（HANAMII の projectId・共用型の state.json。手本は数えない）': [PUBLISH_TARGET_LABEL.hanamii, PUBLISH_TARGET_LABEL['sakura-apprun']],
  }

  it('写しの材料が、確認の材料（GOLDEN_FACTS_CASES）と過不足なく同じ', () => {
    expect(Object.keys(golden.facts).sort()).toEqual(GOLDEN_FACTS_CASES.map(c => c.name).sort())
  })

  it.each(GOLDEN_FACTS_CASES.map(c => [c.name, c] as const))('★★ %s: 写しと同じ材料（V3 の2件だけ、ほかの公開先の読み口が違う）', async (name, c) => {
    const mine = inGoldenShape(await load(c.over))
    const expected = { ...golden.facts[name], ...(V3[name] ? { otherTargets: V3[name] } : {}) }
    expect(mine).toEqual(expected)
  })

  it('V3 の行は、v3 の印がある材料にだけ当たる（印の無い材料は写しと一字一句同じ）', () => {
    expect(Object.keys(V3).sort()).toEqual(GOLDEN_FACTS_CASES.filter(c => c.v3).map(c => c.name).sort())
  })

  it('★ 目安が読める回だけ時間の予告が出る（写しの lbEstimateLine が null の回は waitNote も null）', async () => {
    const withLine = GOLDEN_FACTS_CASES.find(c => golden.facts[c.name].lbEstimateLine)!
    expect((await load(withLine.over)).waitNote).toBe(`${WAIT_HEAD}${golden.facts[withLine.name].lbEstimateLine}。`)
    const without = GOLDEN_FACTS_CASES.find(c => golden.facts[c.name].lbEstimateLine === null)!
    expect((await load(without.over)).waitNote).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 画面の文の定数・言葉
// ═══════════════════════════════════════════════════════════════════════════════

describe('定数と言葉: 手本の文を1文字も変えずに移した', () => {
  it('★★ 窓を閉じる警告に出る名前・幽霊の行の案内・キー未登録の2つの文が、写しと同じ', () => {
    expect({
      activityLabel: DEDICATED_TEARDOWN_WORDS.activityLabel,
      nothingToDelete: DEDICATED_NOTHING_TO_DELETE_MESSAGE,
      listKeyMissing: DEDICATED_LIST_KEY_MISSING_MESSAGE,
      panelKeyMissing: DEDICATED_PANEL_KEY_MISSING_MESSAGE,
    }).toEqual(golden.constants)
    expect(DEDICATED_TEARDOWN_WORDS.nothingToDo).toBe(DEDICATED_NOTHING_TO_DELETE_MESSAGE)
  })

  it('★ 見出し・ボタン・実行中の文字が、写しの確認・結果欄と同じ（確認の title／confirmLabel は確認の比べが、結果欄の見出し3つは結果欄の比べが固定する）', () => {
    const first = Object.values(golden.confirm)[0]
    expect(DEDICATED_TEARDOWN_WORDS.confirmTitle).toBe(first.title)
    expect(DEDICATED_TEARDOWN_WORDS.confirmLabel).toBe(first.confirmLabel)
    expect(golden.result['全部消えた（手順6）']).toContain(DEDICATED_TEARDOWN_WORDS.doneHeadline)
    expect(golden.result['途中で止まった（手順6）']).toContain(DEDICATED_TEARDOWN_WORDS.inProgressHeadline)
    expect(golden.result['残った＋AIに相談する（手順6）']).toContain(DEDICATED_TEARDOWN_WORDS.failedHeadline)
  })
})

describe('材料の名前: 4つの表のどれも、名前が重なっていない（重なると、後ろの材料が前の材料の写しを上書きして、比べているつもりで比べていない）', () => {
  it.each([
    ['確認', GOLDEN_CONFIRM_CASES], ['結果欄', GOLDEN_RESULT_CASES], ['知らせ', GOLDEN_NOTE_CASES], ['材料', GOLDEN_FACTS_CASES],
  ] as const)('%s', (_label, cases) => {
    const names = cases.map(c => c.name)
    expect(new Set(names).size).toBe(names.length)
  })
})
