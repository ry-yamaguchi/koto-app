import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { folderNamesText, isKeptPlacement, keptDataGroups, keptDataLine, keptDataReasonNote } from '../src/shared/keptDataNote'
import * as objectStorage from '../src/shared/objectStorage'
import { STORAGE_PANEL_DELETE_GUIDE, teardownDataNoteFor, teardownDataNoteForAll } from '../src/shared/teardownSupport'
import { leftoverStorageNoteLine, keptStorageNoteOf, rowStorageNotesOf } from '../src/renderer/teardown/projectDeleteWords'
import type { ProjectDeleteFacts } from '../src/renderer/teardown/projectDeletePlan'

// ── 0.6.25: 保存場所を「消しません」「残ります」と言う文の作り手（src/shared/keptDataNote.ts）。期待の文は書き下す ─────────────────────────

const TWIN = { risk: 'twin' as const, folders: ['clone'] }
const UNREAD = { risk: 'unread' as const, folders: ['rc24-x'] }
const A = { bucket: 'koto-a', prefix: 'projects/myapp/', shared: true }
const B = { bucket: 'koto-b', prefix: 'projects/myapp/', shared: false }
const REASON_TWIN = 'フォルダ『clone』も同じデータを使っています。'
const REASON_UNREAD = 'フォルダ『rc24-x』の記録を読めないため、同じデータを使っているか確かめられませんでした。'
const REASON_UNREAD_ANON = 'ほかのフォルダの記録を読めないため、同じデータを使っているか確かめられませんでした。'

describe('keptDataNote: 理由の文・「残ります」の1文・まとめ方', () => {
  it('★★ 理由の文: twin はフォルダ名・unread は読めなかったフォルダ名（無ければ「ほかのフォルダ」）。読めない値は、使っていると言い切らない側', () => {
    expect(keptDataReasonNote(TWIN)).toBe(REASON_TWIN)
    expect(keptDataReasonNote({ risk: 'twin', folders: ['a', 'b'] })).toBe('フォルダ『a』・『b』も同じデータを使っています。')
    expect(keptDataReasonNote(UNREAD)).toBe(REASON_UNREAD)
    expect(keptDataReasonNote({ risk: 'unread', folders: [] })).toBe(REASON_UNREAD_ANON)
    // twin なのにフォルダが無い・形が読めない・知らない種類 → 確かめられなかった側の文
    expect(keptDataReasonNote({ risk: 'twin', folders: [] })).toBe(REASON_UNREAD_ANON)
    expect(keptDataReasonNote({ risk: 'twin' })).toBe(REASON_UNREAD_ANON)
    expect(keptDataReasonNote({ risk: 'other', folders: 'x' })).toBe(REASON_UNREAD_ANON)
    expect(keptDataReasonNote(null)).toBe(REASON_UNREAD_ANON)
    expect(keptDataReasonNote(undefined)).toBe(REASON_UNREAD_ANON)
  })

  it('★ 「残ります」の1文: 括弧の月額は monthly のときだけ。理由は続けて言う。理由が無ければ文の終わりまで', () => {
    expect(keptDataLine('『A』', REASON_TWIN, true)).toBe(`保存場所『A』とその中のデータは残ります（消すまで月額が続きます）。${REASON_TWIN}`)
    expect(keptDataLine('『A』', REASON_TWIN, false)).toBe(`保存場所『A』とその中のデータは残ります。${REASON_TWIN}`)
    expect(keptDataLine('『A』『B』', '', true)).toBe('保存場所『A』『B』とその中のデータは残ります（消すまで月額が続きます）。')
  })

  it('★ まとめ方: 理由が同じ保存場所は1つの文（同じ名前は1つ・最初に出た順）。理由が違えば別の文（どの保存場所の話かを取り違えない）', () => {
    expect(keptDataGroups([{ bucket: 'a', keep: TWIN }, { bucket: 'b', keep: TWIN }, { bucket: 'a', keep: TWIN }]))
      .toEqual([{ buckets: ['a', 'b'], reason: REASON_TWIN }])
    expect(keptDataGroups([{ bucket: 'a', keep: TWIN }, { bucket: 'b', keep: UNREAD }, { bucket: 'c', keep: TWIN }]))
      .toEqual([{ buckets: ['a', 'c'], reason: REASON_TWIN }, { buckets: ['b'], reason: REASON_UNREAD }])
    expect(keptDataGroups([])).toEqual([])
  })

  it('★★★ keep を持つか: オブジェクトなら残す側。null・無い・偽は消す側。オブジェクトでない真の値も残す側（消すと言い切る側に倒さない）', () => {
    expect(isKeptPlacement({ bucket: 'a', keep: TWIN })).toBe(true)
    expect(isKeptPlacement({ bucket: 'a', keep: { risk: 'unread', folders: [] } })).toBe(true)
    expect(isKeptPlacement({ bucket: 'a', keep: true })).toBe(true)
    for (const p of [{ bucket: 'a' }, { bucket: 'a', keep: null }, { bucket: 'a', keep: undefined }, { bucket: 'a', keep: false }, null, undefined, 'x']) {
      expect(isKeptPlacement(p), JSON.stringify(p)).toBe(false)
    }
  })
})

describe('keptDataNote: 破棄の本体（teardownPlanFor）の note と同じ文の作り手', () => {
  const placement = { bucket: 'koto-a', prefix: 'projects/myapp/', shared: true }

  it('★★★ twin: teardownPlanFor の note は、確認が言う理由の文と同じ（1文字も変わらない）', () => {
    const plan = objectStorage.teardownPlanFor(placement, [], { known: true, users: [], samePrefix: ['clone', 'b'], samePrefixUnread: [], samePrefixChecked: true })
    expect(plan.keptData).toBe(true)
    expect(plan.note).toBe('フォルダ『clone』・『b』も同じデータを使っています。')
    expect(plan.note).toBe(keptDataReasonNote({ risk: 'twin', folders: ['clone', 'b'] }))
  })

  it('★★★ unread: 読めなかったフォルダ名あり・無し・確かめ自体ができなかった回。note は keptDataReasonNote と同じ', () => {
    const named = objectStorage.teardownPlanFor(placement, [], { known: false, samePrefix: [], samePrefixUnread: ['rc24-x'], samePrefixChecked: true })
    expect(named.note).toBe(REASON_UNREAD)
    expect(named.note).toBe(keptDataReasonNote({ risk: 'unread', folders: ['rc24-x'] }))
    const anon = objectStorage.teardownPlanFor(placement, [], { known: false, samePrefix: [], samePrefixUnread: [], samePrefixChecked: false })
    expect(anon.note).toBe(REASON_UNREAD_ANON)
    expect(anon.note).toBe(keptDataReasonNote({ risk: 'unread', folders: [] }))
    // 渡し忘れ（形が読めない回）も、確かめられなかった側の文
    const lost = objectStorage.teardownPlanFor(placement, [], undefined as never)
    expect(lost.note).toBe(REASON_UNREAD_ANON)
  })

  it('★★ folderNamesText は keptDataNote の1つ（objectStorage は再エクスポートするだけ。複製の断りの文・赤い箱の文の import 先を壊さない）', () => {
    expect(objectStorage.folderNamesText).toBe(folderNamesText)
    expect(folderNamesText(['A', 'B'])).toBe('フォルダ『A』・『B』')
  })

  it('★★★ 理由の文の作り手は src に keptDataNote.ts の1つだけ（別の場所で同じ文を書き直さない）', () => {
    const root = join(__dirname, '..', 'src')
    const walk = (dir: string): string[] => readdirSync(dir).flatMap(n => {
      const p = join(dir, n)
      return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) ? [p] : []
    })
    const files = walk(root)
    expect(files.length, 'src を読めていない').toBeGreaterThan(300)
    const FRAGMENTS = ['も同じデータを使っています', '同じデータを使っているか確かめられませんでした']
    const found = files.filter(f => { const t = readFileSync(f, 'utf8'); return FRAGMENTS.some(x => t.includes(x)) })
      .map(f => f.slice(root.length - 'src'.length).replace(/\\/g, '/'))
    expect(found).toEqual(['src/shared/keptDataNote.ts'])
  })
})

describe('teardownDataNoteFor・teardownDataNoteForAll: keep のある保存場所は「残ります」と言う（確認・赤い箱・手順6の行の作り手）', () => {
  const REMOVE_A = '保存場所『koto-a』にある、このプロジェクトのデータも削除します。ほかのプロジェクトのデータや、あなたが自分で置いたファイルは残します。この保存場所を使っているプロジェクトがほかに無ければ、保存場所そのものも削除して月額を止めます。'
  const REMOVE_B = '保存場所『koto-b』にある、このプロジェクトのデータも削除します。ほかのプロジェクトのデータや、あなたが自分で置いたファイルは残します。残るものが無ければ、保存場所そのものも削除して月額を止めます。'
  const KEPT_A = '保存場所『koto-a』とその中のデータは残ります（消すまで月額が続きます）。'

  it('★★★ keep の無い入力は 1文字も変わらない（消す側の公開先: 1件・2件。片づけない公開先: 案内つき）', () => {
    expect(teardownDataNoteFor({ target: 'hanamii', placement: A })).toBe(REMOVE_A)
    expect(teardownDataNoteFor({ target: 'hanamii', placement: B })).toBe(REMOVE_B)
    expect(teardownDataNoteForAll({ target: 'sakura-apprun', placements: [A, B] })).toBe(
      '保存場所『koto-a』『koto-b』にある、このプロジェクトのデータも削除します。ほかのプロジェクトのデータや、あなたが自分で置いたファイルは残します。'
      + 'それぞれの保存場所を使っているプロジェクトがほかに無ければ、保存場所そのものも削除して月額を止めます。')
    expect(teardownDataNoteFor({ target: 'vercel', placement: A })).toBe(KEPT_A + STORAGE_PANEL_DELETE_GUIDE)
    expect(teardownDataNoteForAll({ target: 'vercel', placements: [A, B] })).toBe('保存場所『koto-a』『koto-b』とその中のデータは残ります（消すまで月額が続きます）。' + STORAGE_PANEL_DELETE_GUIDE)
    // keep: null・undefined は keep の無い入力と同じ
    for (const keep of [null, undefined]) {
      expect(teardownDataNoteFor({ target: 'hanamii', placement: { ...A, keep } })).toBe(REMOVE_A)
      expect(teardownDataNoteForAll({ target: 'hanamii', placements: [{ ...A, keep }] })).toBe(REMOVE_A)
    }
    expect(teardownDataNoteForAll({ target: 'hanamii', placements: [] })).toBe('')
    expect(teardownDataNoteForAll({ target: 'hanamii', placements: null })).toBe('')
  })

  it('★★★ 1件・全部 keep: 消す文に入れず「残ります（消すまで月額が続きます）」＋理由。案内の1文は続けない。keptMonthlyNote が偽なら括弧が無い', () => {
    expect(teardownDataNoteFor({ target: 'hanamii', placement: { ...A, keep: TWIN } })).toBe(`${KEPT_A}${REASON_TWIN}`)
    expect(teardownDataNoteFor({ target: 'hanamii', placement: { ...A, keep: TWIN }, keptMonthlyNote: false }))
      .toBe(`保存場所『koto-a』とその中のデータは残ります。${REASON_TWIN}`)
    expect(teardownDataNoteFor({ target: 'sakura-apprun-dedicated', placement: { ...A, keep: UNREAD } })).toBe(`${KEPT_A}${REASON_UNREAD}`)
    // 片づけない公開先でも、keep のある保存場所は案内（「消すと、そのプロジェクトのデータも消えます」）を続けない
    expect(teardownDataNoteFor({ target: 'vercel', placement: { ...A, keep: TWIN } })).toBe(`${KEPT_A}${REASON_TWIN}`)
    expect(teardownDataNoteForAll({ target: 'hanamii', placements: [{ ...A, keep: TWIN }] })).toBe(`${KEPT_A}${REASON_TWIN}`)
  })

  it('★★★ 全部 keep（2件）: 理由が同じなら名前を並べた1つの文、違えば保存場所ごとの文', () => {
    expect(teardownDataNoteForAll({ target: 'hanamii', placements: [{ ...A, keep: TWIN }, { ...B, keep: TWIN }], keptMonthlyNote: false }))
      .toBe(`保存場所『koto-a』『koto-b』とその中のデータは残ります。${REASON_TWIN}`)
    expect(teardownDataNoteForAll({ target: 'hanamii', placements: [{ ...A, keep: TWIN }, { ...B, keep: UNREAD }], keptMonthlyNote: false }))
      .toBe(`保存場所『koto-a』とその中のデータは残ります。${REASON_TWIN}保存場所『koto-b』とその中のデータは残ります。${REASON_UNREAD}`)
  })

  it('★★★ 混在: 消す保存場所の文のあとに、残す保存場所の文。消す文は残す保存場所の名前を含まない', () => {
    const mixed = teardownDataNoteForAll({ target: 'hanamii', placements: [{ ...A, keep: TWIN }, B] })
    expect(mixed).toBe(REMOVE_B + KEPT_A + REASON_TWIN)
    expect(REMOVE_B).not.toContain('koto-a')
    // 並びを入れ替えても同じ（消す側が先）
    expect(teardownDataNoteForAll({ target: 'hanamii', placements: [B, { ...A, keep: TWIN }] })).toBe(mixed)
    // 消す保存場所が2件・残す保存場所が1件
    const two = teardownDataNoteForAll({ target: 'hanamii', placements: [{ ...A, keep: TWIN }, B, { bucket: 'koto-c', prefix: 'p/', shared: false }], keptMonthlyNote: false })
    expect(two.startsWith('保存場所『koto-b』『koto-c』にある、このプロジェクトのデータも削除します。')).toBe(true)
    expect(two.endsWith(`保存場所『koto-a』とその中のデータは残ります。${REASON_TWIN}`)).toBe(true)
  })

  it('★ 名前の無いもの（null・空の bucket）は数えない', () => {
    expect(teardownDataNoteForAll({ target: 'hanamii', placements: [null as never, { bucket: '', keep: TWIN }, { ...A, keep: TWIN }] })).toBe(`${KEPT_A}${REASON_TWIN}`)
    expect(teardownDataNoteFor({ target: 'hanamii', placement: { bucket: '', keep: TWIN } as never })).toBe('')
  })
})

describe('T-1c 赤い箱（プロジェクトの削除）の 💾: 確認と同じ作り手で、keep のある保存場所に「データも削除します」を言わない', () => {
  const facts = (over: Partial<ProjectDeleteFacts>): ProjectDeleteFacts =>
    ({ targets: [], unreadable: false, dedicated: null, placements: [], running: null, sharedLeftover: null, sharedRegistry: null, twins: null, ...over })
  const KEPT_RED = `保存場所『koto-a』とその中のデータは残ります（消すまで月額が続きます）。${REASON_TWIN}`
  const planOf = (teardown: Array<'hanamii' | 'sakura-apprun'>, leftover?: { noun: string | null }) => ({ block: null, teardown, twinned: [], ...(leftover ? { leftover } : {}) })

  it('★★★ rowStorageNotesOf（公開先の行）: keep のある保存場所は「残ります（消すまで月額が続きます）」＋理由。keep の無い回は今のまま', () => {
    expect(rowStorageNotesOf(planOf(['hanamii']), facts({ placements: [{ ...A, keep: TWIN } as never] }))).toEqual([{ target: 'hanamii', note: KEPT_RED }])
    const mixed = rowStorageNotesOf(planOf(['hanamii']), facts({ placements: [{ ...A, keep: TWIN } as never, B] }))
    expect(mixed).toHaveLength(1)
    expect(mixed[0].note.startsWith('保存場所『koto-b』にある、このプロジェクトのデータも削除します。')).toBe(true)
    expect(mixed[0].note.endsWith(KEPT_RED)).toBe(true)
    expect(rowStorageNotesOf(planOf(['hanamii']), facts({ placements: [A] }))[0].note.startsWith('保存場所『koto-a』にある、このプロジェクトのデータも削除します。')).toBe(true)
  })

  it('★★★ leftoverStorageNoteLine（残りの段）: 記録の残りの keep のある保存場所は「残ります」。同じバケットでも、消す側と残す側は別々に言う', () => {
    const left = (placements: unknown[]) => ({ appNames: [], registryName: null, registryOrigin: 'unknown' as const, registryUsers: [], placements: placements as never })
    const plan = planOf(['sakura-apprun'], { noun: '保存場所' })
    expect(leftoverStorageNoteLine(plan, facts({ sharedLeftover: left([{ ...A, keep: TWIN }]) }))).toBe(KEPT_RED)
    const both = leftoverStorageNoteLine(plan, facts({ sharedLeftover: left([{ ...A, keep: TWIN }, { ...A, prefix: 'projects/other/' }]) }))
    expect(both.startsWith('保存場所『koto-a』にある、このプロジェクトのデータも削除します。')).toBe(true)
    expect(both.endsWith(KEPT_RED)).toBe(true)
    // keep の無い回は今のまま
    expect(leftoverStorageNoteLine(plan, facts({ sharedLeftover: left([A]) })).startsWith('保存場所『koto-a』にある、このプロジェクトのデータも削除します。')).toBe(true)
  })

  it('★★ チェックを外した回の文（keptStorageNoteOf）は、keep の有無によらず今のまま（「残ります」側の文は変えない）', () => {
    expect(keptStorageNoteOf(facts({ placements: [{ ...A, keep: TWIN } as never] })))
      .toBe('保存場所「koto-a」とその中のデータは残ります（消すまで月額495円・税込が続きます）。')
    expect(keptStorageNoteOf(facts({ placements: [A] }))).toBe('保存場所「koto-a」とその中のデータは残ります（消すまで月額495円・税込が続きます）。')
  })
})
