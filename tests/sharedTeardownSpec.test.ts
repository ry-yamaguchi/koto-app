import { describe, it, expect, afterEach } from 'vitest'

// ── 段階2（2b-1）: 共用型の破棄の仕様書（teardown/targets/shared.ts）。B（確認の文）と仕様書の単体 ───────────────
// 設計書 docs/teardown-unify-plan.md の 10.7.8・10.7.12 の B。親の判断（10.7.16 末尾）の 1（state にだけある保存場所は「言って消す」。
// 数えるので hasWork が true）・4（nothingToDoIsOk）。本物の main を通した確認の文は tests/sharedTeardownConfirm.test.ts（P5-確認）。
//
//   B  … 共通の確認の文（buildTeardownConfirm）に共用型の仕様書を渡した結果。名前・💾・元に戻せません・🔗・レジストリの注意・選択の既定
//   単体 … invoke が deleteRegistry を `=== true` で、registryName を記録のまま渡す／loadAuth がちょうど { heldByMain: true }／
//          readRecord が ok:false・形違いで投げる／hasWork の表／placementsOf が記録の保存場所を返す

import { sharedTeardownSpec, readSharedTeardownRecord, SHARED_TEARDOWN_AUTH, SHARED_TEARDOWN_WORDS, SHARED_KEY_MISSING_MESSAGE, type SharedTeardownRecord } from '../src/renderer/teardown/targets/shared'
import { buildTeardownConfirm } from '../src/renderer/teardown/confirm'
import { runTeardownFlow, electronFlowDeps } from '../src/renderer/teardown/flow'
import type { TeardownFacts } from '../src/renderer/teardown/types'
import type { ConfirmWithChoicesOptions } from '../src/renderer/useConfirmChoices'
import { teardownDataNoteForAll } from '../src/shared/teardownSupport'
import { adoptedRegistryNote, registryDeleteDefault, registryDeleteHelp, registryDeleteLabel, registryUnknownNotice, sharedRegistryNote, unknownOriginRegistryNote, urlChangesOnTeardownNotice, type RegistryOrigin } from '../src/shared/cloudCost'

const A = { bucket: 'koto-data-a', prefix: 'projects/myapp/', shared: true }
const B = { bucket: 'koto-data-b', prefix: 'projects/myapp/', shared: true }
const spec = sharedTeardownSpec
/** A・B を確認で見せたときの、main へ運ぶ組（名前と prefix）。 */
const SHOWN = [{ bucket: 'koto-data-a', prefix: 'projects/myapp/' }, { bucket: 'koto-data-b', prefix: 'projects/myapp/' }]

const rec = (over: Partial<SharedTeardownRecord> = {}): SharedTeardownRecord => ({
  appNames: ['myapp'], registryName: 'myreg', registryOrigin: 'owned', registryUsers: [], placements: [A, B], stateOnlyBuckets: [], ...over,
})
const facts = (record: SharedTeardownRecord, over: Partial<TeardownFacts<SharedTeardownRecord>> = {}): TeardownFacts<SharedTeardownRecord> => ({
  projectName: 'myapp', record, placements: spec.placementsOf!(record), placementsUnreadable: false, placementsUnreadableCause: null,
  otherTargets: [], otherTargetsUnreadable: false, waitNote: null, ...over,
})
const confirmOf = (record: SharedTeardownRecord, over: Partial<TeardownFacts<SharedTeardownRecord>> = {}) => buildTeardownConfirm(spec, facts(record, over))
const paragraphs = (body: string) => body.split('\n\n')

afterEach(() => { delete (globalThis as any).window })

describe('B 共用型の確認の文', () => {
  it('★ 見出し・ボタン・danger は仕様書の言葉（破棄）', () => {
    const c = confirmOf(rec())
    expect(c.title).toBe('さくらのAppRun の公開を破棄します')
    expect(c.confirmLabel).toBe('破棄する')
    expect(c.danger).toBe(true)
    expect(c.body).toContain('対象のプロジェクト: 『myapp』')
  })

  it('★★★ アプリと保存場所2件: 両方の名前・💾（一覧の「データも削除します」）・「この操作は元に戻せません」・🔗。アプリの「課金は止まります」は言わない', () => {
    const body = confirmOf(rec()).body
    expect(body).toContain('次を破棄します: AppRun アプリ『myapp』・保存場所『koto-data-a』『koto-data-b』にある、このプロジェクトのデータ')
    expect(body).toContain(`💾 ${teardownDataNoteForAll({ target: 'sakura-apprun', placements: [A, B] })}`)
    expect(body).toContain('データも削除します')
    expect(body).toContain('この操作は元に戻せません。')
    expect(body).toContain(`🔗 ${urlChangesOnTeardownNotice()}`)
    expect(body).not.toContain('の課金は止まります')
    expect(body).toContain('保存場所は、ほかに使っているプロジェクトが無いときだけ止まります。')
  })

  it('★★ アプリが複数なら全部の名前を出す', () => {
    expect(confirmOf(rec({ appNames: ['a-app', 'b-app'] })).body).toContain('次を破棄します: AppRun アプリ『a-app』・AppRun アプリ『b-app』・保存場所')
  })

  it('★★★ ほかの公開先 → 保存場所を使っているという注意（P2）。保存場所が2件なら「これらの保存場所」', () => {
    const one = confirmOf(rec({ placements: [A] }), { otherTargets: ['🌸 HANAMII'] }).body
    expect(one).toContain('⚠️ この保存場所は 🌸 HANAMII でも使っているため、そちらで公開中のアプリのデータも消えます')
    expect(confirmOf(rec(), { otherTargets: ['🌸 HANAMII', '▲ Vercel'] }).body).toContain('⚠️ これらの保存場所は 🌸 HANAMII・▲ Vercel でも使っているため、')
    expect(confirmOf(rec()).body).not.toContain('でも使っているため')
  })

  it('★★★ レジストリの記録なし＋アプリあり → 「記録がない」の注意。選択は出ない（消せないものを選ばせない）', () => {
    const r = rec({ registryName: null })
    expect(confirmOf(r).body).toContain(`⚠️ ${registryUnknownNotice()}`)
    expect(spec.choices!(r)).toEqual([])
  })

  it('★★★ レジストリの記録なし＋アプリなし（レジストリを消し終えて保存場所で止まった押し直し）→ 「月額がかかり続けます」の誤警告を出さない。🔗 も出さない', () => {
    const body = confirmOf(rec({ appNames: [], registryName: null, placements: [A] })).body
    expect(body).not.toContain(registryUnknownNotice())
    expect(body).not.toContain('月額220円')
    expect(body).not.toContain('🔗')
    expect(spec.notes!(rec({ appNames: [], registryName: null, placements: [A] }))).toEqual([])
  })

  it('★★ レジストリだけ（アプリも保存場所も無い）→ 先頭が空にならない。レジストリは下のチェックが言う', () => {
    const r = rec({ appNames: [], placements: [] })
    const first = paragraphs(confirmOf(r).body)[1]
    expect(first).toBe('次を破棄します: コンテナレジストリ『myreg』（下のチェックで選んだとき）')
    expect(confirmOf(r).body).not.toContain('記録に名前を挙げられるものがありません')
    expect(confirmOf(r).body).not.toContain('🔗')
  })

  it('★★ アプリがあるときのレジストリは、一覧に入れない（選択の欄が言う）', () => {
    expect(spec.targets(rec())).toEqual(['AppRun アプリ『myapp』'])
    expect(confirmOf(rec()).body).not.toContain('下のチェックで選んだとき')
  })

  it('★★★ 保存場所だけ（アプリ無し）→ 先頭が「次を破棄します: 保存場所『A』にある、このプロジェクトのデータ」。🔗 は出ない', () => {
    const body = confirmOf(rec({ appNames: [], registryName: null, placements: [A] })).body
    expect(paragraphs(body)[1]).toBe('次を破棄します: 保存場所『koto-data-a』にある、このプロジェクトのデータ')
    expect(body).not.toContain('🔗')
  })

  it('★★★ 設定から外した保存場所（state にだけある）→ 一覧にも名前が出て、「設定から外した保存場所『B』も削除します」と言い分ける（言って消す）', () => {
    const r = rec({ placements: [A, B], stateOnlyBuckets: ['koto-data-b'] })
    const body = confirmOf(r).body
    expect(body).toContain('保存場所『koto-data-a』『koto-data-b』にある、このプロジェクトのデータ')
    expect(body).toContain('⚠️ 設定から外した保存場所『koto-data-b』も削除します。')
    expect(body).not.toContain('削除しません')
    expect(confirmOf(rec()).body).not.toContain('設定から外した保存場所')
    // 2件なら並べて言う
    expect(spec.notes!(rec({ placements: [A, B], stateOnlyBuckets: ['koto-data-a', 'koto-data-b'] }))).toContain('⚠️ 設定から外した保存場所『koto-data-a』『koto-data-b』も削除します。')
  })

  it('★★ 設定から外した保存場所だけの回（state にだけある B）でも、確認が出て B の名前を言う', () => {
    const r = rec({ appNames: [], registryName: null, placements: [B], stateOnlyBuckets: ['koto-data-b'] })
    expect(spec.hasWork(r)).toBe(true)
    const body = confirmOf(r).body
    expect(paragraphs(body)[1]).toBe('次を破棄します: 保存場所『koto-data-b』にある、このプロジェクトのデータ')
    expect(body).toContain('設定から外した保存場所『koto-data-b』も削除します。')
  })

  it('★★ 保存場所を問い合わせられなかった（call。placementsOf が投げた回）注意は、共通の文のまま出る。名前を挙げられない保存場所は削除しない（ほかの公開先のデータが消える、とは言わない。0.6.24 F-6）', () => {
    const c = confirmOf(rec({ placements: [] }), { placementsUnreadable: true, placementsUnreadableCause: 'call', otherTargets: ['🌸 HANAMII'] }).body
    expect(c).toContain('保存場所の設定を問い合わせられなかったため、保存場所の名前を挙げられません。名前を挙げられない保存場所は削除しません（使っていれば残り、月額が続きます）。')
    expect(c).not.toContain('🌸 HANAMII')
  })
})

describe('B 選択（コンテナレジストリを削除する）', () => {
  it('★★★ Koto が作ったレジストリ（owned）は既定オン。借り物（adopted）は既定オフで、赤い注意（T189 のあとの文）が付く', () => {
    const made = spec.choices!(rec({ registryOrigin: 'owned' }))
    expect(made).toHaveLength(1)
    expect(made[0]).toMatchObject({ id: 'deleteRegistry', label: registryDeleteLabel('myreg'), defaultChecked: true })
    expect(made[0].note).toBeUndefined()
    const adopted = spec.choices!(rec({ registryOrigin: 'adopted' }))
    expect(adopted[0].defaultChecked).toBe(false)
    expect(adopted[0].note).toBe(adoptedRegistryNote('myreg'))
    expect(adopted[0].note).toContain('このプロジェクトのために作ったものではありません。ほかのアプリのイメージも入っている場合')
    expect(adopted[0].note).not.toContain('Koto が作ったものではありません')
    expect(adopted[0].note).not.toContain('引き継いだときに')       // T189: 言い直しの括弧を削った
    expect(adopted[0].note).toContain('月額220円')
  })

  // ★★★ 作ったか分からない（unknown。記録に印が無い・作者の手元の実例の形）は既定オフ。ほかのアプリのイメージが入っていることがある（2026-10-19）。
  it('★★★ 作ったか分からないレジストリ（unknown）は既定オフで、そのことを言う注意が付く（借り物の注意とは別の文）', () => {
    const unknown = spec.choices!(rec({ registryOrigin: 'unknown' }))
    expect(unknown).toHaveLength(1)
    expect(unknown[0].defaultChecked).toBe(false)
    expect(unknown[0].note).toBe(unknownOriginRegistryNote('myreg'))
    expect(unknown[0].note).toBe('このコンテナレジストリ『myreg』を、このプロジェクトのために作ったか分かりません。'
      + 'ほかのアプリも使っている場合、消すとそれらが動かなくなります。'
      + '消してよいと分かっているときだけ、チェックを入れてください（月額220円・税込が止まります）。')
    expect(unknown[0].note).not.toBe(adoptedRegistryNote('myreg'))
    // 外した選択欄は、利用者が自分で入れれば消せる（選択そのものは出す）
    expect(unknown[0].id).toBe('deleteRegistry')
  })

  it('★ 既定は共通の判断（registryDeleteDefault）と同じ。オンになるのは owned だけ。説明はチェックの状態で変わる', () => {
    const want: Record<RegistryOrigin, boolean> = { owned: true, adopted: false, unknown: false }
    for (const origin of ['owned', 'adopted', 'unknown'] as const) {
      const got = spec.choices!(rec({ registryOrigin: origin }))[0].defaultChecked
      expect(got, origin).toBe(registryDeleteDefault({ registryName: 'myreg', origin, otherUsers: 0 }))
      expect(got, origin).toBe(want[origin])
    }
    expect(spec.choices!(rec())[0].help).toEqual({ checked: registryDeleteHelp(true, true), unchecked: registryDeleteHelp(false, true) })
  })

  // ★★★ 外したときの説明（月額と「後で消す場合は削除して」）も、結果の警告と同じ判断（このプロジェクトだけのレジストリか）に通す（2026-10-19・双子）。
  // 借りたもの・作ったか分からないもの・ほかのプロジェクトが使っているものに「後で消す場合は削除して」と言うと、言われたとおり消したときに、ほかのアプリが動かなくなる。
  it('★★★ 外したときの説明: このプロジェクトだけのレジストリ（owned・借り手なし）にだけ、月額と「後で消す場合は」を言う', () => {
    const ONLY = 'レジストリは残ります。月額220円（税込）の課金は続きます。後で消す場合は、さくらのクラウドのコントロールパネルから削除してください。'
    expect(spec.choices!(rec({ registryOrigin: 'owned' }))[0].help!.unchecked).toBe(ONLY)
    for (const r of [rec({ registryOrigin: 'adopted' }), rec({ registryOrigin: 'unknown' }), rec({ registryOrigin: 'owned', registryUsers: ['reminder'] })]) {
      const help = spec.choices!(r)[0].help!
      // 空の文字列（出さない）。「レジストリは残ります。」はチェックの名前「…も削除する」の言い直しで、月額と残す理由は上の注意が言う
      expect(help.unchecked, `${r.registryOrigin}・借り手${r.registryUsers.length}件`).toBe('')
      expect(help.unchecked).not.toContain('後で消す場合は')
      expect(help.unchecked).not.toContain('月額')
      // 入れたときの説明は、どれも同じ（月額が止まる・イメージも消える）
      expect(help.checked).toBe(registryDeleteHelp(true, false))
    }
  })

  // ★★★ ほかのプロジェクトが使っているレジストリは、作った側（owned）でも既定オフ（2026-10-19。振る舞いの全体は tests/sharedTeardownUsers.test.ts が実フォルダで固定する）
  it('★★★ 作った側（owned）でも、ほかのプロジェクトが使っていれば既定オフで、使っているプロジェクトの名前つきの注意が付く', () => {
    const shared = spec.choices!(rec({ registryOrigin: 'owned', registryUsers: ['reminder', 'landingTEST', 'tsukaisute'] }))
    expect(shared[0].defaultChecked).toBe(false)
    expect(shared[0].note).toBe(sharedRegistryNote('myreg', ['reminder', 'landingTEST', 'tsukaisute']))
    expect(shared[0].note).toContain('ほかのプロジェクト（reminder ほか2件）も、このコンテナレジストリ『myreg』を使っています。')
    expect(shared[0].note).toContain('消すと、それらのアプリが動かなくなります。')
    expect(shared[0].note).toContain('月額220円')
    // 使い手が分かっているときは、借り物・分からないの断りより、そちらを言う（どれか1つ。重ねない）
    for (const origin of ['adopted', 'unknown'] as const) {
      const c = spec.choices!(rec({ registryOrigin: origin, registryUsers: ['reminder'] }))[0]
      expect(c.defaultChecked, origin).toBe(false)
      expect(c.note, origin).toBe(sharedRegistryNote('myreg', ['reminder']))
    }
    // 使い手がいなければ、これまでどおり
    expect(spec.choices!(rec({ registryOrigin: 'owned', registryUsers: [] }))[0].defaultChecked).toBe(true)
  })

  it('記録にレジストリが無ければ選択は無い', () => {
    expect(spec.choices!(rec({ registryName: null }))).toEqual([])
  })
})

describe('仕様書の単体', () => {
  it('★ 公開先・IPC の名前・言葉', () => {
    expect(spec.target).toBe('sakura-apprun')
    expect(spec.handler).toBe('cloud:teardown')
    expect(spec.words).toBe(SHARED_TEARDOWN_WORDS)
    expect(spec.words.verb).toBe('破棄')
    expect(spec.words.nothingToDo).toBe('公開されていないため、破棄するものはありません。')
    expect(spec.words.rowButton).toBe('🗑 破棄') // 専有型だけ「🗑 削除」（共用型は破棄）
    expect(spec.claimsComputeBillingStops).toBe(false)
    expect(spec.irreversibleNote).toBe('always')
    expect(spec.nothingToDoIsOk).toBe(true)
    expect(SHARED_KEY_MISSING_MESSAGE).toContain('APIキー')
  })

  it('★★★ hasWork の表: アプリ・レジストリ・保存場所（env.json の分も state にだけある分も）のどれかがあれば true。全部無ければ false', () => {
    const none = { appNames: [], registryName: null, placements: [], stateOnlyBuckets: [] }
    expect(spec.hasWork(rec(none))).toBe(false)
    expect(spec.hasWork(rec({ ...none, appNames: ['myapp'] }))).toBe(true)
    expect(spec.hasWork(rec({ ...none, registryName: 'myreg' }))).toBe(true)
    expect(spec.hasWork(rec({ ...none, placements: [A] }))).toBe(true)
    expect(spec.hasWork(rec({ ...none, placements: [B], stateOnlyBuckets: ['koto-data-b'] }))).toBe(true)
  })

  it('★★ placementsOf は記録の保存場所をそのまま（名前・prefix・shared）返す。記録の配列そのものは渡さない', () => {
    const r = rec({ placements: [A, { ...B, shared: false }] })
    const got = spec.placementsOf!(r)
    expect(got).toEqual([A, { ...B, shared: false }])
    expect(got).not.toBe(r.placements)
    expect(got[0]).not.toBe(r.placements[0])
  })

  it('★★★ loadAuth はちょうど { heldByMain: true }（null を返さない。鍵は main が持つ）', async () => {
    expect(await spec.loadAuth(rec())).toEqual({ heldByMain: true })
    expect(Object.keys(await spec.loadAuth(rec())!)).toEqual(['heldByMain'])
    expect(Object.isFrozen(SHARED_TEARDOWN_AUTH)).toBe(true)
  })

  function installCloud(reply: unknown) {
    const calls: unknown[][] = []
    ;(globalThis as any).window = { electronAPI: { cloud: {
      teardown: async (...a: unknown[]) => { calls.push(a); return { ok: true } },
      teardownRecord: async (...a: unknown[]) => { calls.push(['teardownRecord', ...a]); return reply },
    } } }
    return calls
  }

  it('★★★ invoke: deleteRegistry は choices.deleteRegistry が true のときだけ true。省略・false・boolean でない値は false。registryName は記録のまま', async () => {
    const calls = installCloud(null)
    const r = rec()
    for (const [choices, want] of [
      [{ deleteRegistry: true }, true], [{ deleteRegistry: false }, false], [undefined, false], [{}, false],
      [{ deleteRegistry: 'true' as unknown as boolean }, false], [{ deleteRegistry: 1 as unknown as boolean }, false],
    ] as const) {
      calls.length = 0
      // shownPlacements（確認で見せた保存場所の組）は、流れが作った値をそのまま main へ渡す（仕様書は選ばない・変えない）
      await spec.invoke('/proj', SHARED_TEARDOWN_AUTH, { confirmed: true, shownPlacements: SHOWN, ...(choices ? { choices } : {}) }, r)
      expect(calls).toEqual([['/proj', { heldByMain: true }, { confirmed: true, deleteRegistry: want, registryName: 'myreg', shownPlacements: SHOWN }]])
    }
    calls.length = 0
    await spec.invoke('/proj', SHARED_TEARDOWN_AUTH, { confirmed: true, shownPlacements: [] }, rec({ registryName: null }))
    expect(calls[0][2]).toEqual({ confirmed: true, deleteRegistry: false, registryName: null, shownPlacements: [] })
  })

  it('★★ readRecord: main の cloud:teardownRecord の記録を、押した時点で読む（コピーを返す）', async () => {
    const r = rec({ placements: [A, B], stateOnlyBuckets: ['koto-data-b'] })
    const calls = installCloud({ ok: true, record: r })
    const got = await readSharedTeardownRecord('/proj')
    expect(calls).toEqual([['teardownRecord', '/proj']])
    expect(got).toEqual(r)
    expect(got.appNames).not.toBe(r.appNames)
  })

  it('★★★ readRecord: ok:false は投げる（確認を出さない）。メッセージは main のもの', async () => {
    installCloud({ ok: false, message: 'env.json がありません' })
    await expect(readSharedTeardownRecord('/proj')).rejects.toThrow('env.json がありません')
    installCloud({ ok: false })
    await expect(readSharedTeardownRecord('/proj')).rejects.toThrow('破棄するものの記録を読めませんでした')
    installCloud(undefined)
    await expect(readSharedTeardownRecord('/proj')).rejects.toThrow()
  })

  it.each([
    ['record が無い', { ok: true }],
    ['appNames が配列でない', { ok: true, record: { ...rec(), appNames: 'x' } }],
    ['placements が欠けた', { ok: true, record: { ...rec(), placements: undefined } }],
    ['placements の要素の形が違う', { ok: true, record: { ...rec(), placements: [{ bucket: 'a' }] } }],
    ['registryOrigin が欠けた', { ok: true, record: { ...rec(), registryOrigin: undefined } }],
    ["registryOrigin が3つのどれでもない（'yes'）", { ok: true, record: { ...rec(), registryOrigin: 'yes' } }],
    ['registryOrigin が真偽値（古い形の registryAdopted を取り違えて渡した）', { ok: true, record: { ...rec(), registryOrigin: false } }],
    ['registryUsers が欠けた', { ok: true, record: { ...rec(), registryUsers: undefined } }],
    ['registryUsers が文字列の配列でない（件数だけを渡した）', { ok: true, record: { ...rec(), registryUsers: 2 } }],
    ['registryName が文字列でも null でもない', { ok: true, record: { ...rec(), registryName: 1 } }],
    ['stateOnlyBuckets が欠けた', { ok: true, record: { ...rec(), stateOnlyBuckets: undefined } }],
  ])('★★★ readRecord: 形が違う（%s）→ 投げる。空の記録に倒して「破棄するものはありません」と言わない', async (_n, reply) => {
    installCloud(reply)
    await expect(readSharedTeardownRecord('/proj')).rejects.toThrow('破棄するものの記録の形を読めませんでした')
  })

  it('failure / toView', () => {
    expect(spec.failure('だめでした')).toEqual({ ok: false, message: 'だめでした' })
    const v = spec.toView({ ok: true, executed: ['✅ 消しました'] })
    expect(v.ok).toBe(true)
    expect(spec.toView(spec.failure('だめでした')).ok).toBe(false)
  })
})

describe('本物の流れ（runTeardownFlow + electronFlowDeps）に共用型の仕様書を通す', () => {
  function installWindow(record: SharedTeardownRecord | { ok: false; message: string }) {
    const calls = { teardown: [] as unknown[][], placement: 0 }
    ;(globalThis as any).window = {
      electronAPI: {
        cloud: {
          teardownRecord: async () => ('ok' in record ? record : { ok: true, record }),
          teardown: async (...a: unknown[]) => { calls.teardown.push(a); return { ok: true } },
        },
        // 共通の読み口（env.json の同意済みだけ）。共用型は記録の保存場所を使うので、呼ばれない
        storage: { placement: async () => { calls.placement++; return { ok: true, placement: null, placements: [] } } },
        fs: { readFile: async () => JSON.stringify({ publish: { targets: { 'sakura-apprun': { publishedAt: 't' } } } }), exists: async (p: string) => p.endsWith('/.sakuraide.json') },
        stageTiming: { estimates: async () => null },
        win: { setBusy: () => {} },
      },
      dispatchEvent: () => true,
    }
    return calls
  }
  const entry = (asked: ConfirmWithChoicesOptions[], answer: unknown) => ({
    confirm: async () => { throw new Error('選択のある確認で confirm は使わない') },
    confirmWithChoices: async (o: ConfirmWithChoicesOptions) => { asked.push(o); return answer as any },
    keyMissingMessage: SHARED_KEY_MISSING_MESSAGE,
  })

  it('★★★ 確認 → チェックを外して実行: cloud.teardown は { confirmed:true, deleteRegistry:false, registryName } の1回。保存場所の共通の読み口は呼ばない', async () => {
    const calls = installWindow(rec())
    const asked: ConfirmWithChoicesOptions[] = []
    const out = await runTeardownFlow('/proj', spec, electronFlowDeps('/proj', spec, entry(asked, { confirmed: true, choices: { deleteRegistry: false } })))
    expect(out).toEqual({ cancelled: false, result: { ok: true } })
    // 確認で見せた保存場所（名前と prefix の組）は、記録の placements（確認の 💾 が名指しする全件）のまま届く（0.6.24 F）
    expect(calls.teardown).toEqual([['/proj', { heldByMain: true }, { confirmed: true, deleteRegistry: false, registryName: 'myreg', shownPlacements: SHOWN }]])
    expect(calls.placement).toBe(0)
    expect(asked).toHaveLength(1)
    expect(asked[0].choices.map(c => c.id)).toEqual(['deleteRegistry'])
    // 共用型の公開記録があるので、ほかの公開先に自分（共用型）は挙がらない
    expect(asked[0].body).not.toContain('でも使っているため')
  })

  it('★★ 触らずに実行: 既定のまま（Koto が作ったレジストリは消す／借り物と作ったか分からないものは残す）', async () => {
    for (const [origin, want] of [['owned', true], ['adopted', false], ['unknown', false]] as const) {
      const calls = installWindow(rec({ registryOrigin: origin }))
      const asked: ConfirmWithChoicesOptions[] = []
      // 実際の useConfirmChoices は、触っていなければ defaultChecked を答えにする。ここでは同じ答えを返す。
      await runTeardownFlow('/proj', spec, electronFlowDeps('/proj', spec, { ...entry(asked, null), confirmWithChoices: async o => { asked.push(o); return { confirmed: true, choices: Object.fromEntries(o.choices.map(c => [c.id, c.defaultChecked])) } } }))
      expect((calls.teardown[0][2] as any).deleteRegistry).toBe(want)
    }
  })

  it('★★★ キャンセル → cloud.teardown は呼ばれない', async () => {
    const calls = installWindow(rec())
    const out = await runTeardownFlow('/proj', spec, electronFlowDeps('/proj', spec, entry([], { confirmed: false, choices: {} })))
    expect(out).toEqual({ cancelled: true })
    expect(calls.teardown).toEqual([])
  })

  it('★★★ 消すものが記録に無い（幽霊の行）→ 確認0・IPC0・結果に nothingToDo:true。S4 はこれを成功として扱える', async () => {
    const calls = installWindow(rec({ appNames: [], registryName: null, placements: [], stateOnlyBuckets: [] }))
    const asked: ConfirmWithChoicesOptions[] = []
    const out = await runTeardownFlow('/proj', spec, electronFlowDeps('/proj', spec, entry(asked, { confirmed: true, choices: {} })))
    expect(out).toMatchObject({ cancelled: false, nothingToDo: true, result: { ok: false, message: spec.words.nothingToDo } })
    expect(asked).toEqual([])
    expect(calls.teardown).toEqual([])
  })

  it('★★ 記録を読めない → 確認0・IPC0・「記録を読めませんでした」（nothingToDo ではない）', async () => {
    const calls = installWindow({ ok: false, message: 'env.json がありません' })
    const asked: ConfirmWithChoicesOptions[] = []
    const out = await runTeardownFlow('/proj', spec, electronFlowDeps('/proj', spec, entry(asked, { confirmed: true, choices: {} })))
    expect((out as any).result.message).toContain('破棄するものの記録を読めませんでした')
    expect((out as any).result.message).toContain('env.json がありません')
    expect('nothingToDo' in out).toBe(false)
    expect(asked).toEqual([])
    expect(calls.teardown).toEqual([])
  })

  it('★★ 同じ材料なら、入口（S1・S3・S4）が違っても確認の文は同じ（文を作るのは共通の1つ）', async () => {
    const seen: ConfirmWithChoicesOptions[][] = []
    for (let i = 0; i < 3; i++) {
      installWindow(rec({ registryOrigin: 'adopted', stateOnlyBuckets: ['koto-data-b'] }))
      const asked: ConfirmWithChoicesOptions[] = []
      await runTeardownFlow('/proj', spec, electronFlowDeps('/proj', spec, entry(asked, { confirmed: false, choices: {} })))
      seen.push(asked)
    }
    expect(seen[1]).toEqual(seen[0])
    expect(seen[2]).toEqual(seen[0])
    expect(seen[0]).toHaveLength(1)
  })
})
