import { describe, it, expect } from 'vitest'
import { buildTeardownConfirm, confirmDestroysNothing, unreadableCautions } from '../src/renderer/teardown/confirm'
import { shownPlacementsOf } from '../src/renderer/teardown/flow'
import { sharedTeardownSpec, sharedLeftoverNoun, type SharedTeardownRecord } from '../src/renderer/teardown/targets/shared'
import { hanamiiTeardownSpec, type HanamiiTeardownRecord } from '../src/renderer/teardown/targets/hanamii'
import { dedicatedTeardownSpec } from '../src/renderer/teardown/targets/dedicated'
import { sharedLeftoverGateOf } from '../src/renderer/teardown/projectDeletePlan'
import type { TeardownFacts, TeardownPlacement } from '../src/renderer/teardown/types'

// ── 0.6.25: 確認の文が、保存場所の keep（同じデータを使うフォルダがいる・確かめられない。cloud:twinFacts の答え）を見て、「消しません」と言う ──────────
// 期待の文は関数を通さず書き下す（関数を写した期待は、関数が壊れても通る）。keep の無い入力が1文字も変わらないことは、既存の完全一致のテスト
// （teardownFlowCommon・dedicatedTeardownGolden・sharedTeardownConfirm など）が固定する。ここは keep のある入力と、keep の無い対照だけを見る。

const TWIN = { risk: 'twin' as const, folders: ['rc24-h2'] }
const UNREAD = { risk: 'unread' as const, folders: ['rc24-x'] }
const KEPT_TWIN: TeardownPlacement = { bucket: 'koto-rc24-1028', prefix: 'projects/rc24-h/', shared: true, keep: TWIN }
const KEPT_UNREAD: TeardownPlacement = { bucket: 'koto-rc24-1028', prefix: 'projects/rc24-h/', shared: true, keep: UNREAD }
const GONE: TeardownPlacement = { bucket: 'koto-other', prefix: 'projects/rc24-h/', shared: false }

const NOTE_TWIN = '保存場所『koto-rc24-1028』とその中のデータは残ります。フォルダ『rc24-h2』も同じデータを使っています。'
const NOTE_UNREAD = '保存場所『koto-rc24-1028』とその中のデータは残ります。フォルダ『rc24-x』の記録を読めないため、同じデータを使っているか確かめられませんでした。'
const COST_KEPT = '保存場所は残るため、月額は続きます。'
// 消す保存場所と混じる回だけ、消さない側の 💾 に括弧の月額が付く（費用の行は消す側だけを言う）。
const NOTE_TWIN_MIXED = '保存場所『koto-rc24-1028』とその中のデータは残ります（消すまで月額が続きます）。フォルダ『rc24-h2』も同じデータを使っています。'

const facts = <R>(record: R, placements: TeardownPlacement[], over: Partial<TeardownFacts<R>> = {}): TeardownFacts<R> => ({
  projectName: 'rc24-h', record, placements, placementsUnreadable: false, placementsUnreadableCause: null,
  otherTargets: [], otherTargetsUnreadable: false, waitNote: null, ...over,
})
const hanamiiRec = (o: Partial<HanamiiTeardownRecord> = {}): HanamiiTeardownRecord => ({ projectId: 'p1', name: 'rc24-h', tokenId: null, storageLeftoverBuckets: null, ...o })
const sharedRec = (o: Partial<SharedTeardownRecord> = {}): SharedTeardownRecord =>
  ({ appNames: [], registryName: null, registryOrigin: 'owned', registryUsers: [], placements: [], stateOnlyBuckets: [], keyRecorded: true, ...o })
const REC_PLACEMENT = { bucket: 'koto-rc24-1028', prefix: 'projects/rc24-h/', shared: true }
const dedicatedRec = { applicationID: 'app-1', applicationName: 'myapp', loadBalancerID: 'lb-1', asgID: 'asg-1', clusterID: 'cl-1' } as never

const bodyOf = (c: { body: string }) => c.body.split('\n\n')

describe('T-1c 確認: keep のある保存場所は消す側の文に入れず、「残ります」と言う', () => {
  it('★★★ HANAMII・保存場所が複製と共有: 一覧は保存場所を入れない・💾 は「残ります」＋理由・費用は消さない側・「元に戻せません」「データも削除します」を言わない', () => {
    const c = buildTeardownConfirm(hanamiiTeardownSpec, facts(hanamiiRec(), [KEPT_TWIN]))
    expect(c.body).toBe([
      '対象のプロジェクト: 『rc24-h』',
      '次を破棄します: HANAMII のプロジェクト『rc24-h』',
      `💾 ${NOTE_TWIN}`,
      `破棄すると、${COST_KEPT}よろしいですか？`,
    ].join('\n\n'))
    expect(c.body).not.toContain('にある、このプロジェクトのデータ')
    expect(c.body).not.toContain('データも削除します')
    expect(c.body).not.toContain('元に戻せません')
    expect(c.body).not.toContain('止まります')
    expect(c.title).toBe('HANAMII の公開を破棄します')
  })

  it('★★★ 複製か確かめられない保存場所（unread）も「残ります」と言い切る。理由の文は main の note と同じ', () => {
    const c = buildTeardownConfirm(hanamiiTeardownSpec, facts(hanamiiRec(), [KEPT_UNREAD]))
    expect(bodyOf(c)).toContain(`💾 ${NOTE_UNREAD}`)
    expect(c.body).not.toContain('データも削除します')
    // フォルダが分からないときは「ほかのフォルダの記録を読めないため、…」
    const noName = buildTeardownConfirm(hanamiiTeardownSpec, facts(hanamiiRec(), [{ ...KEPT_UNREAD, keep: { risk: 'unread', folders: [] } }]))
    expect(bodyOf(noName)).toContain('💾 保存場所『koto-rc24-1028』とその中のデータは残ります。ほかのフォルダの記録を読めないため、同じデータを使っているか確かめられませんでした。')
  })

  it('★★★ 確認の 💾 は括弧の月額を付けず、コントロールパネルの案内も続けない（月額は費用の行が1回だけ言う）', () => {
    const c = buildTeardownConfirm(hanamiiTeardownSpec, facts(hanamiiRec(), [KEPT_TWIN]))
    expect(c.body).not.toContain('消すまで月額が続きます')
    expect(c.body).not.toContain('コントロールパネル')
    expect(c.body.split('月額は続きます').length - 1).toBe(1)
  })

  it('★★★ 共用型・アプリあり・全部 keep: 一覧に保存場所が入らない。⚠️「でも使っているため」も出ない。アプリを消すので「元に戻せません」は言う。費用は消さない側', () => {
    const c = buildTeardownConfirm(sharedTeardownSpec, facts(sharedRec({ appNames: ['myapp'], placements: [REC_PLACEMENT] }), [KEPT_TWIN], { otherTargets: ['HANAMII'] }))
    const paras = bodyOf(c)
    expect(paras).toContain('次を破棄します: AppRun アプリ『myapp』')
    expect(paras).toContain(`💾 ${NOTE_TWIN}`)
    expect(c.body).not.toContain('でも使っているため')
    expect(c.body).not.toContain('データも削除します')
    expect(paras[paras.length - 1]).toBe(`この操作は元に戻せません。破棄すると、${COST_KEPT}よろしいですか？`)
  })

  it('★★★ 専有型・全部 keep: 課金の止まる種類はアプリ・LB… のまま、保存場所は消さない側の費用の一文。「元に戻せません」は言う（クラスタを消す）', () => {
    const c = buildTeardownConfirm(dedicatedTeardownSpec, facts(dedicatedRec, [KEPT_TWIN]))
    const paras = bodyOf(c)
    expect(paras).toContain(`💾 ${NOTE_TWIN}`)
    expect(paras[paras.length - 1]).toBe(`この操作は元に戻せません。削除すると、アプリ・ロードバランサ・オートスケーリンググループ・クラスタの課金は止まります。${COST_KEPT}よろしいですか？`)
    expect(c.body).not.toContain('にある、このプロジェクトのデータ')
  })

  it('★★★ 混在（消す保存場所と消さない保存場所）: 一覧と ⚠️ と費用は消す側だけ数える。💾 は消す側の文のあとに残す側の文', () => {
    const c = buildTeardownConfirm(hanamiiTeardownSpec, facts(hanamiiRec(), [KEPT_TWIN, GONE], { otherTargets: ['共用型'] }))
    const paras = bodyOf(c)
    expect(paras).toContain('次を破棄します: HANAMII のプロジェクト『rc24-h』・保存場所『koto-other』にある、このプロジェクトのデータ')
    expect(paras).toContain('💾 保存場所『koto-other』にある、このプロジェクトのデータも削除します。ほかのプロジェクトのデータや、あなたが自分で置いたファイルは残します。残るものが無ければ、保存場所そのものも削除して月額を止めます。'
      + NOTE_TWIN_MIXED)
    // 「この保存場所」（消す側の1件）。消さない側を数えて「これらの保存場所」にしない
    expect(paras).toContain('⚠️ この保存場所は 共用型 でも使っているため、そちらで公開中のアプリのデータも消えます（アプリ自体は消えません）。')
    expect(paras[paras.length - 1]).toBe('保存場所にあるデータの削除は元に戻せません。破棄すると、保存場所は、ほかに使っているプロジェクトが無いときだけ止まります。よろしいですか？')
  })

  it('★★ keep の無い対照: 今までどおり（一覧に保存場所・「データも削除します」・元に戻せません・費用の止まる文）', () => {
    const c = buildTeardownConfirm(hanamiiTeardownSpec, facts(hanamiiRec(), [GONE]))
    const paras = bodyOf(c)
    expect(paras).toContain('次を破棄します: HANAMII のプロジェクト『rc24-h』・保存場所『koto-other』にある、このプロジェクトのデータ')
    expect(paras).toContain('💾 保存場所『koto-other』にある、このプロジェクトのデータも削除します。ほかのプロジェクトのデータや、あなたが自分で置いたファイルは残します。残るものが無ければ、保存場所そのものも削除して月額を止めます。')
    expect(paras[paras.length - 1]).toBe('保存場所にあるデータの削除は元に戻せません。破棄すると、保存場所は、ほかに使っているプロジェクトが無いときだけ止まります。よろしいですか？')
    // keep: null・keep が無いもの・keep: undefined は、keep の無い入力と1文字も変わらない
    for (const keep of [undefined, null] as const) {
      expect(buildTeardownConfirm(hanamiiTeardownSpec, facts(hanamiiRec(), [{ ...GONE, keep: keep as never }])).body).toBe(c.body)
    }
  })

  it('★★ 確認が名指しする保存場所の組は、消さないものも含めて facts.placements の全件のまま。消さないものにだけ、main へ運ぶ印（keepData:true）が付く', () => {
    const f = facts(hanamiiRec(), [KEPT_TWIN, GONE])
    expect(shownPlacementsOf(f)).toStrictEqual([
      { bucket: 'koto-rc24-1028', prefix: 'projects/rc24-h/', keepData: true },
      { bucket: 'koto-other', prefix: 'projects/rc24-h/' },
    ])
    expect(f.placements).toHaveLength(2)
  })
})

describe('T-1c 確認: 保存場所が全部 keep で、消すものが何も無い回（公開の行だけがあり、保存場所が全部「残す」の幽霊の行。この回の確認の文が矛盾しない形）', () => {
  it('★★★ 共用型・アプリもレジストリも無く全部 keep: 先頭の段落（一覧）を出さない・「元に戻せません」「削除します」を言わない・💾 が「残ります」と言う', () => {
    const c = buildTeardownConfirm(sharedTeardownSpec, facts(sharedRec({ placements: [REC_PLACEMENT] }), [KEPT_TWIN]))
    expect(c.body).toBe([
      '対象のプロジェクト: 『rc24-h』',
      `💾 ${NOTE_TWIN}`,
      `破棄すると、${COST_KEPT}よろしいですか？`,
    ].join('\n\n'))
    expect(c.body).not.toContain('次を破棄します')
    expect(c.body).not.toContain('記録に名前を挙げられるものがありません')
    expect(c.body).not.toContain('元に戻せません')
    expect(c.body).not.toContain('削除します')
    // 何も消さない確認の見出しとボタンは、公開先ごとの「公開を破棄します」「破棄する」ではなく、保存場所は残ることを言う
    expect(c.title).toBe('保存場所は残ります')
    expect(c.confirmLabel).toBe('続ける')
  })

  it('★★ keep の無い、保存場所も無い入力の先頭の段落は今のまま（一覧が空のときの文）', () => {
    const c = buildTeardownConfirm(sharedTeardownSpec, facts(sharedRec(), []))
    expect(bodyOf(c)).toContain('次を破棄します: （記録に名前を挙げられるものがありません）')
  })
})

describe('T-1c 共用型: レジストリがあり保存場所が全部 keep の確認', () => {
  const rec = (o: Partial<SharedTeardownRecord> = {}) => sharedRec({ registryName: 'myreg', placements: [REC_PLACEMENT], ...o })

  it('★★★ 一覧は「コンテナレジストリ『…』（下のチェックで選んだとき）」・見出しは「コンテナレジストリを破棄します」・保存場所は一覧に入らない。レジストリを消すので「元に戻せません」は言う', () => {
    const c = buildTeardownConfirm(sharedTeardownSpec, facts(rec(), [KEPT_TWIN]))
    const paras = bodyOf(c)
    expect(c.title).toBe('コンテナレジストリを破棄します')
    expect(paras).toContain('次を破棄します: コンテナレジストリ『myreg』（下のチェックで選んだとき）')
    expect(c.body).not.toContain('にある、このプロジェクトのデータ')
    expect(paras).toContain(`💾 ${NOTE_TWIN}`)
    expect(paras[paras.length - 1]).toBe(`この操作は元に戻せません。破棄すると、${COST_KEPT}よろしいですか？`)
  })

  it('★★★ 混在: 見出しは「保存場所・コンテナレジストリを破棄します」。一覧は消す保存場所だけ。keep の無い入力は今のまま', () => {
    const mixed = rec({ placements: [REC_PLACEMENT, { bucket: 'koto-other', prefix: 'projects/rc24-h/', shared: false }] })
    const c = buildTeardownConfirm(sharedTeardownSpec, facts(mixed, [KEPT_TWIN, GONE]))
    expect(c.title).toBe('保存場所・コンテナレジストリを破棄します')
    expect(c.body).toContain('保存場所『koto-other』にある、このプロジェクトのデータ')
    expect(c.body).not.toContain('保存場所『koto-rc24-1028』にある、このプロジェクトのデータ')
    const none = buildTeardownConfirm(sharedTeardownSpec, facts(mixed, mixed.placements))
    expect(none.title).toBe('保存場所・コンテナレジストリを破棄します')
    expect(none.body).toContain('保存場所『koto-rc24-1028』『koto-other』にある、このプロジェクトのデータ')
  })

  it('★★ 見出し: 保存場所だけで全部 keep・アプリも無い → 何も消さない見出し。一部 keep → 「保存場所を破棄します」', () => {
    const only = sharedRec({ placements: [REC_PLACEMENT] })
    expect(buildTeardownConfirm(sharedTeardownSpec, facts(only, [KEPT_TWIN])).title).toBe('保存場所は残ります')
    const mixed = sharedRec({ placements: [REC_PLACEMENT, { bucket: 'koto-other', prefix: 'projects/rc24-h/', shared: false }] })
    expect(buildTeardownConfirm(sharedTeardownSpec, facts(mixed, [KEPT_TWIN, GONE])).title).toBe('保存場所を破棄します')
    expect(buildTeardownConfirm(sharedTeardownSpec, facts(only, [])).title).toBe('保存場所を破棄します')
  })
})

describe('T-1c 共用型の targets・confirmTitleOf・notes・sharedLeftoverNoun は、消す保存場所（keep の無いもの）だけを数える', () => {
  it('★★★ targets: 保存場所が全部 keep でレジストリがあれば、レジストリの1件。一部 keep なら今のまま（レジストリの1件にならない）', () => {
    const r = sharedRec({ registryName: 'myreg', placements: [REC_PLACEMENT, { ...REC_PLACEMENT, bucket: 'koto-other' }] })
    const reg = ['コンテナレジストリ『myreg』（下のチェックで選んだとき）']
    expect(sharedTeardownSpec.targets(r, [KEPT_TWIN, { ...KEPT_TWIN, bucket: 'koto-other' }])).toEqual(reg)
    expect(sharedTeardownSpec.targets(r, [KEPT_TWIN, { ...GONE, bucket: 'koto-other', prefix: 'projects/rc24-h/' }])).toEqual([])
    // 材料が無い・keep が無い回は、記録の保存場所を全部消す側として数える（今までどおり）
    expect(sharedTeardownSpec.targets(r)).toEqual([])
    expect(sharedTeardownSpec.targets(r, [])).toEqual([])
    expect(sharedTeardownSpec.targets(sharedRec({ registryName: 'myreg' }))).toEqual(reg)
  })

  it('★★★ keep は名前と prefix の組で当てる（同じバケットの別の prefix が keep でも、このプレフィックスは消す側）', () => {
    const r = sharedRec({ registryName: 'myreg', placements: [REC_PLACEMENT] })
    expect(sharedTeardownSpec.targets(r, [{ ...KEPT_TWIN, prefix: 'projects/another/' }])).toEqual([])
    expect(sharedTeardownSpec.confirmTitleOf!(r, [{ ...KEPT_TWIN, prefix: 'projects/another/' }])).toBe('保存場所・コンテナレジストリを破棄します')
    expect(sharedTeardownSpec.confirmTitleOf!(r, [KEPT_TWIN])).toBe('コンテナレジストリを破棄します')
  })

  it('★★★ notes: 設定から外した保存場所が全部 keep なら「削除します」と言わない。一部だけ keep・keep の無い回は今のまま', () => {
    const p2 = { bucket: 'koto-gone', prefix: 'projects/rc24-h/', shared: true }
    const r = sharedRec({ placements: [REC_PLACEMENT, p2], stateOnlyBuckets: ['koto-gone'] })
    const SAYS = '⚠️ 設定から外した保存場所『koto-gone』も削除します。'
    expect(sharedTeardownSpec.notes!(r, [KEPT_TWIN, { ...KEPT_TWIN, bucket: 'koto-gone' }])).toEqual([])
    expect(sharedTeardownSpec.notes!(r, [KEPT_TWIN, { bucket: 'koto-gone', prefix: 'projects/rc24-h/', shared: true }])).toEqual([SAYS])
    expect(sharedTeardownSpec.notes!(r)).toEqual([SAYS])
    expect(sharedTeardownSpec.notes!(r, [])).toEqual([SAYS])
    // 記録の保存場所に無い名前の状態だけの保存場所は、今のまま言う
    expect(sharedTeardownSpec.notes!(sharedRec({ stateOnlyBuckets: ['koto-gone'] }), [KEPT_TWIN])).toEqual([SAYS])
  })

  it('★★★ 確認の本文（呼び元が placements を notes へ渡す）: 設定から外した保存場所が keep なら「削除します」の段落が出ない。消す保存場所なら出る', () => {
    const gone = { bucket: 'koto-gone', prefix: 'projects/rc24-h/', shared: true }
    const r = sharedRec({ appNames: ['myapp'], placements: [REC_PLACEMENT, gone], stateOnlyBuckets: ['koto-gone'] })
    const kept = buildTeardownConfirm(sharedTeardownSpec, facts(r, [KEPT_TWIN, { ...gone, keep: TWIN }]))
    expect(kept.body).not.toContain('設定から外した保存場所')
    const mixed = buildTeardownConfirm(sharedTeardownSpec, facts(r, [KEPT_TWIN, gone]))
    expect(bodyOf(mixed)).toContain('⚠️ 設定から外した保存場所『koto-gone』も削除します。')
  })

  it('★★★ sharedLeftoverNoun: keep を持つ保存場所は数えない（呼び名・名詞は消す保存場所だけで決まる）', () => {
    const k = { ...REC_PLACEMENT, keep: TWIN }
    expect(sharedLeftoverNoun({ appNames: [], placements: [k] }, true)).toBe('コンテナレジストリ')
    expect(sharedLeftoverNoun({ appNames: [], placements: [k] }, false)).toBeNull()
    expect(sharedLeftoverNoun({ appNames: [], placements: [k, REC_PLACEMENT] }, true)).toBe('保存場所・コンテナレジストリ')
    expect(sharedLeftoverNoun({ appNames: [], placements: [k, REC_PLACEMENT] }, false)).toBe('保存場所')
    expect(sharedLeftoverNoun({ appNames: ['myapp'], placements: [k] }, true)).toBeNull()
    // keep の無い入力は今のまま
    expect(sharedLeftoverNoun({ appNames: [], placements: [REC_PLACEMENT] }, true)).toBe('保存場所・コンテナレジストリ')
    expect(sharedLeftoverNoun({ appNames: [], placements: [REC_PLACEMENT] }, false)).toBe('保存場所')
    expect(sharedLeftoverNoun({ appNames: [], placements: [] }, true)).toBe('コンテナレジストリ')
    expect(sharedLeftoverNoun({ appNames: [], placements: [] }, false)).toBeNull()
  })

  it('★★★ プロジェクトの削除の門が渡す記録の残り（keep 付きの保存場所）も同じ名詞になる。keep の無い回は今のまま', () => {
    const left = (placements: unknown[], registryName: string | null) =>
      ({ appNames: [] as string[], registryName, registryOrigin: 'owned' as const, registryUsers: [] as string[], placements: placements as never })
    expect(sharedLeftoverGateOf(left([{ ...REC_PLACEMENT, keep: TWIN }], 'myreg'))).toEqual({ noun: 'コンテナレジストリ' })
    expect(sharedLeftoverGateOf(left([{ ...REC_PLACEMENT, keep: TWIN }, REC_PLACEMENT], 'myreg'))).toEqual({ noun: '保存場所・コンテナレジストリ' })
    expect(sharedLeftoverGateOf(left([REC_PLACEMENT], 'myreg'))).toEqual({ noun: '保存場所・コンテナレジストリ' })
    expect(sharedLeftoverGateOf(left([REC_PLACEMENT], null))).toEqual({ noun: '保存場所' })
  })
})

describe('T-1c 確認: 保存場所だけが残った回（leftoverNote）と、ほかの公開先の記録を読めなかった注意', () => {
  it('★★★ HANAMII の保存場所だけが残った回で、保存場所が全部 keep: 先頭は事実だけ（「残っている保存場所を削除します」と言わない）。keep の無い回は今のまま', () => {
    const rec = hanamiiRec({ storageLeftoverBuckets: ['koto-rc24-1028'] })
    const kept = buildTeardownConfirm(hanamiiTeardownSpec, facts(rec, [KEPT_TWIN]))
    expect(bodyOf(kept)).toContain('前回の破棄で、保存場所だけが残っています。')
    expect(kept.body).not.toContain('を削除します')
    expect(kept.body).not.toContain('元に戻せません')
    const plain = buildTeardownConfirm(hanamiiTeardownSpec, facts(rec, [GONE]))
    expect(bodyOf(plain)).toContain('前回の破棄で、HANAMII のプロジェクトは削除済みか見つからない状態でした。残っている保存場所『koto-rc24-1028』を削除します。')
  })

  const cautionFacts = (placements: TeardownPlacement[]) => ({
    placements, placementsUnreadable: false, placementsUnreadableCause: null, otherTargetsUnreadable: true, otherTargets: [],
  })
  const CAUTION = '⚠️ ほかの公開先の記録を読めなかったため、ここに挙げられません。保存場所をほかの公開先（Vercel・共用型・専有型など）が使っていれば、そちらのアプリのデータも消えます。'
  const words = hanamiiTeardownSpec.words

  it('★★★ 消す保存場所が無い回（全部 keep）は出さない。消す保存場所がある回・保存場所が無い回・keep の無い回は今のまま出す', () => {
    expect(unreadableCautions(cautionFacts([KEPT_TWIN]), words, 'storage-only', 'hanamii')).toEqual([])
    expect(unreadableCautions(cautionFacts([KEPT_TWIN, KEPT_UNREAD]), words, 'storage-only', 'hanamii')).toEqual([])
    expect(unreadableCautions(cautionFacts([KEPT_TWIN, GONE]), words, 'storage-only', 'hanamii')).toEqual([CAUTION])
    expect(unreadableCautions(cautionFacts([GONE]), words, 'storage-only', 'hanamii')).toEqual([CAUTION])
    expect(unreadableCautions(cautionFacts([]), words, 'storage-only', 'hanamii')).toEqual([CAUTION])
    // placements を渡さない呼び方（古い呼び手）も今のまま
    const { placements: _omit, ...noPlacements } = cautionFacts([])
    expect(unreadableCautions(noPlacements, words, 'storage-only', 'hanamii')).toEqual([CAUTION])
  })

  it('★★ 確認を作る流れ（buildTeardownConfirm）でも、全部 keep の回はこの注意が出ない', () => {
    const f = facts(hanamiiRec(), [KEPT_TWIN], { otherTargetsUnreadable: true })
    expect(buildTeardownConfirm(hanamiiTeardownSpec, f).body).not.toContain('ほかの公開先の記録を読めなかった')
    expect(buildTeardownConfirm(hanamiiTeardownSpec, facts(hanamiiRec(), [GONE], { otherTargetsUnreadable: true })).body).toContain('ほかの公開先の記録を読めなかった')
  })
})

// ── 一部だけ keep（混在）の確認: 「元に戻せません」と、保存場所だけが残った回の先頭の文 ─────────────────────────────────────────────
// 公開先のものを名指ししない確認（共用型でアプリ無し・専有型で保存場所だけ残る回）でも、消す保存場所が混じれば、データを消すので「元に戻せません」を言う。
// 期待の文は書き下す。

const DEL_GONE = '保存場所『koto-other』にある、このプロジェクトのデータも削除します。ほかのプロジェクトのデータや、あなたが自分で置いたファイルは残します。残るものが無ければ、保存場所そのものも削除して月額を止めます。'
const COST_REMOVING = '保存場所は、ほかに使っているプロジェクトが無いときだけ止まります。'
const REC_GONE = { bucket: 'koto-other', prefix: 'projects/rc24-h/', shared: false }
const dedicatedStorageOnly = { storageLeftoverBucket: 'koto-rc24-1028', storageLeftoverBuckets: ['koto-rc24-1028'] } as never
const HANAMII_LEFT = '前回の破棄で、HANAMII のプロジェクトは削除済みか見つからない状態でした。'

describe('T-1c 混在の確認は、公開先のものを名指ししなくても「元に戻せません」を言う（データを消すので）', () => {
  it('★★★ 共用型・アプリもレジストリも無く、保存場所が A（keep）と B（消す）: 最後の段落は「この操作は元に戻せません。」で始まる', () => {
    const rec = sharedRec({ placements: [REC_PLACEMENT, REC_GONE] })
    const c = buildTeardownConfirm(sharedTeardownSpec, facts(rec, [KEPT_TWIN, GONE]))
    expect(bodyOf(c)).toEqual([
      '対象のプロジェクト: 『rc24-h』',
      '次を破棄します: 保存場所『koto-other』にある、このプロジェクトのデータ',
      `💾 ${DEL_GONE}${NOTE_TWIN_MIXED}`,
      `この操作は元に戻せません。破棄すると、${COST_REMOVING}よろしいですか？`,
    ])
    expect(c.title).toBe('保存場所を破棄します')
    expect(c.confirmLabel).toBe('破棄する')
  })

  it('★★★ 専有型・保存場所だけが残り（資源は記録に無い）、A（keep）と B（消す）: 最後の段落は「この操作は元に戻せません。」で始まる', () => {
    const c = buildTeardownConfirm(dedicatedTeardownSpec, facts(dedicatedStorageOnly, [KEPT_TWIN, GONE]))
    expect(bodyOf(c)).toEqual([
      '対象のプロジェクト: 『rc24-h』',
      '次を削除します: 保存場所『koto-other』にある、このプロジェクトのデータ',
      `💾 ${DEL_GONE}${NOTE_TWIN_MIXED}`,
      `この操作は元に戻せません。削除すると、${COST_REMOVING}よろしいですか？`,
    ])
    // 消す保存場所があるので、見出しとボタンは公開先ごとのまま
    expect(c.title).toBe('専有型クラスタを削除します')
    expect(c.confirmLabel).toBe('削除する')
  })

  it('★★★ HANAMII・保存場所だけが残り（A と B）、A が keep: 「削除します」と言う名前は B だけ。A は 💾 が「残ります」と言う。データを消すので「元に戻せません」を言う', () => {
    const rec = hanamiiRec({ storageLeftoverBuckets: ['koto-rc24-1028', 'koto-other'] })
    const c = buildTeardownConfirm(hanamiiTeardownSpec, facts(rec, [KEPT_TWIN, GONE]))
    expect(bodyOf(c)).toEqual([
      '対象のプロジェクト: 『rc24-h』',
      `${HANAMII_LEFT}残っている保存場所『koto-other』を削除します。`,
      `💾 ${DEL_GONE}${NOTE_TWIN_MIXED}`,
      `保存場所にあるデータの削除は元に戻せません。破棄すると、${COST_REMOVING}よろしいですか？`,
    ])
    // 1つの確認が、同じ保存場所を「削除します」と「残ります」の両方で言わない
    expect(c.body).not.toContain('『koto-rc24-1028』『koto-other』を削除します')
    expect(c.body).not.toContain('『koto-rc24-1028』を削除します')
    expect(c.title).toBe('HANAMII の公開を破棄します')
  })

  it('★★★ HANAMII・残っている保存場所の名前が全部 keep（ほかに消す保存場所 C がある）: 先頭は事実だけ。C は 💾 が「削除します」と言う', () => {
    const rec = hanamiiRec({ storageLeftoverBuckets: ['koto-rc24-1028'] })
    const c = buildTeardownConfirm(hanamiiTeardownSpec, facts(rec, [KEPT_TWIN, GONE]))
    expect(bodyOf(c)[1]).toBe('前回の破棄で、保存場所だけが残っています。')
    expect(bodyOf(c)[2]).toBe(`💾 ${DEL_GONE}${NOTE_TWIN_MIXED}`)
    expect(c.body).not.toContain('を削除します。\n\n💾')
  })

  it('★★ HANAMII・残っている保存場所の名前が分からない（空の一覧）・材料が無い・keep の無い回は、今までどおり', () => {
    const none = buildTeardownConfirm(hanamiiTeardownSpec, facts(hanamiiRec({ storageLeftoverBuckets: [] }), [KEPT_TWIN, GONE]))
    expect(bodyOf(none)[1]).toBe(`${HANAMII_LEFT}残っている保存場所を削除します。`)
    const rec = hanamiiRec({ storageLeftoverBuckets: ['koto-rc24-1028', 'koto-other'] })
    expect(bodyOf(buildTeardownConfirm(hanamiiTeardownSpec, facts(rec, [])))[1]).toBe(`${HANAMII_LEFT}残っている保存場所『koto-rc24-1028』『koto-other』を削除します。`)
    expect(bodyOf(buildTeardownConfirm(hanamiiTeardownSpec, facts(rec, [{ ...KEPT_TWIN, keep: null as never }, GONE])))[1]).toBe(`${HANAMII_LEFT}残っている保存場所『koto-rc24-1028』『koto-other』を削除します。`)
  })

  it('★★★ 仕様書の leftoverNote: 同じバケットの別の prefix が keep でない回は、そのバケットを「削除します」の名前に残す（名前と prefix の組で全部 keep のときだけ外す）', () => {
    const rec = hanamiiRec({ storageLeftoverBuckets: ['koto-rc24-1028', 'koto-other'] })
    const note = hanamiiTeardownSpec.leftoverNote!
    expect(note(rec, [KEPT_TWIN, GONE])).toBe(`${HANAMII_LEFT}残っている保存場所『koto-other』を削除します。`)
    expect(note(rec, [KEPT_TWIN, { ...KEPT_TWIN, prefix: 'projects/another/', keep: undefined }, GONE]))
      .toBe(`${HANAMII_LEFT}残っている保存場所『koto-rc24-1028』『koto-other』を削除します。`)
    expect(note(rec, [KEPT_TWIN, { ...KEPT_TWIN, prefix: 'projects/another/' }, { ...GONE, keep: UNREAD }])).toBe('前回の破棄で、保存場所だけが残っています。')
    expect(note(hanamiiRec(), [KEPT_TWIN])).toBeNull()
  })
})

describe('T-1c 何も消さない確認（confirmDestroysNothing）は、見出しとボタンも「保存場所は残ります」と言う', () => {
  it('★★★ confirmDestroysNothing: 消す保存場所が無く・残す保存場所があり・公開先のものも無い回だけ true。消す保存場所が1件でも混じれば false', () => {
    const P = [KEPT_TWIN]
    expect(confirmDestroysNothing({ placements: P, targets: [] })).toBe(true)
    expect(confirmDestroysNothing({ placements: P, targets: ['AppRun アプリ『a』'] })).toBe(false) // 公開先のものを消す
    expect(confirmDestroysNothing({ placements: P, targets: ['AppRun アプリ『a』'], leftoverNote: '前回の破棄で、保存場所だけが残っています。' })).toBe(true) // 先頭の段落が言うのは保存場所だけ
    expect(confirmDestroysNothing({ placements: [KEPT_TWIN, GONE], targets: [] })).toBe(false) // 混在: データを消す
    expect(confirmDestroysNothing({ placements: [KEPT_TWIN, GONE], targets: [], leftoverNote: '前回の破棄で、…' })).toBe(false)
    expect(confirmDestroysNothing({ placements: [GONE], targets: [] })).toBe(false) // keep の無い回
    expect(confirmDestroysNothing({ placements: [], targets: [] })).toBe(false) // 保存場所が無い回
    expect(confirmDestroysNothing({ placements: null, targets: [] })).toBe(false)
    expect(confirmDestroysNothing({ placements: [null, undefined, { bucket: '', keep: TWIN }], targets: [] })).toBe(false) // 名前の無いものは数えない
  })

  it('★★★ 専有型・保存場所だけが残り全部 keep（R4 のクラスタ削除のあとに押し直す回）: 見出しは「保存場所は残ります」・ボタンは「続ける」。本文は残ります＋月額は続く', () => {
    const c = buildTeardownConfirm(dedicatedTeardownSpec, facts(dedicatedStorageOnly, [KEPT_TWIN]))
    expect(c.title).toBe('保存場所は残ります')
    expect(c.confirmLabel).toBe('続ける')
    expect(bodyOf(c)).toEqual([
      '対象のプロジェクト: 『rc24-h』',
      `💾 ${NOTE_TWIN}`,
      `削除すると、${COST_KEPT}よろしいですか？`,
    ])
    expect(c.title).not.toContain('削除')
    expect(c.confirmLabel).not.toContain('削除')
  })

  it('★★★ HANAMII・保存場所だけが残り全部 keep: 見出しは「保存場所は残ります」・ボタンは「続ける」。HANAMII のプロジェクトを破棄する回（全部 keep）は今のまま', () => {
    const left = buildTeardownConfirm(hanamiiTeardownSpec, facts(hanamiiRec({ storageLeftoverBuckets: ['koto-rc24-1028'] }), [KEPT_TWIN]))
    expect(left.title).toBe('保存場所は残ります')
    expect(left.confirmLabel).toBe('続ける')
    expect(left.title).not.toContain('破棄')
    expect(left.confirmLabel).not.toContain('破棄')
    const project = buildTeardownConfirm(hanamiiTeardownSpec, facts(hanamiiRec(), [KEPT_TWIN]))
    expect(project.title).toBe('HANAMII の公開を破棄します')
    expect(project.confirmLabel).toBe('破棄する')
  })

  it('★★ 先頭の段落が保存場所だけを言う回（leftoverNote）は、仕様書が targets を返しても（確認は使わない）、見出しとボタンは何も消さない側', () => {
    const spec = { ...hanamiiTeardownSpec, targets: () => ['HANAMII のプロジェクト『rc24-h』'] }
    const c = buildTeardownConfirm(spec, facts(hanamiiRec({ storageLeftoverBuckets: ['koto-rc24-1028'] }), [KEPT_TWIN]))
    expect(bodyOf(c)[1]).toBe('前回の破棄で、保存場所だけが残っています。')
    expect([c.title, c.confirmLabel]).toEqual(['保存場所は残ります', '続ける'])
  })

  it('★★★ 公開先のものを消す回（専有型の資源あり・共用型のアプリあり）は、全部 keep でも公開先ごとの見出しとボタンのまま', () => {
    const d = buildTeardownConfirm(dedicatedTeardownSpec, facts(dedicatedRec, [KEPT_TWIN]))
    expect([d.title, d.confirmLabel]).toEqual(['専有型クラスタを削除します', '削除する'])
    const s = buildTeardownConfirm(sharedTeardownSpec, facts(sharedRec({ appNames: ['myapp'], placements: [REC_PLACEMENT] }), [KEPT_TWIN]))
    expect([s.title, s.confirmLabel]).toEqual(['さくらのAppRun の公開を破棄します', '破棄する'])
  })

  it('★★★ 共用型・アプリが無く、保存場所は全部 keep で、借り手のいるレジストリだけが選べる回: 見出しは「コンテナレジストリを破棄します」（公開の破棄と言わない）。keep の無い回は今のまま', () => {
    const borrowed = sharedRec({ registryName: 'myreg', registryUsers: ['borrower'], placements: [REC_PLACEMENT] })
    const c = buildTeardownConfirm(sharedTeardownSpec, facts(borrowed, [KEPT_TWIN]))
    expect(c.title).toBe('コンテナレジストリを破棄します')
    expect(c.confirmLabel).toBe('破棄する')
    expect(bodyOf(c)).toContain('次を破棄します: コンテナレジストリ『myreg』（下のチェックで選んだとき）')
    // keep の無い対照: 見出しは今のまま（保存場所を消す側）
    expect(buildTeardownConfirm(sharedTeardownSpec, facts(borrowed, [])).title).toBe('保存場所を破棄します')
    expect(buildTeardownConfirm(sharedTeardownSpec, facts(sharedRec({ registryName: 'myreg', registryUsers: ['borrower'] }), [])).title).toBe('さくらのAppRun の公開を破棄します')
    // 保存場所が全部 keep でも、アプリがある回は公開の見出し
    expect(buildTeardownConfirm(sharedTeardownSpec, facts({ ...borrowed, appNames: ['myapp'] }, [KEPT_TWIN])).title).toBe('さくらのAppRun の公開を破棄します')
  })
})
