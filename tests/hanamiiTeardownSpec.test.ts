import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// ── HANAMII の破棄の仕様書（teardown/targets/hanamii.ts）。段階1の1b ─────────────────────────────
// 設計書: docs/teardown-unify-plan.md の 10.4.3（仕様書の項目）・10.4.9 の B（確認の文）・10.5.4 の D8（どのトークンで呼ぶか）。
//
//   読み方   … 記録（.sakuraide.json の publish.hanamii）から projectId・name・tokenId・storageLeftoverBuckets を読む。読めない・壊れているときは**投げる**
//   D8       … 記録の tokenId のトークンだけで呼ぶ。見つからなければ null（使用中・先頭の登録へ倒さない）。tokenId が無い旧い記録だけ、使用中のトークン
//   B        … 共通の確認の文（buildTeardownConfirm）に HANAMII の仕様書を渡した結果。共用型の URL の文・課金の文が出ない／B-8（元に戻せません）／B-9（保存場所だけ残った回）
//   呼び出し … IPC は projectDir・認証・{ confirmed, projectId } の3つで呼ぶ（projectId は記録のもの）
//
// 本物の main と画面を通した振る舞い（確認 → 実行 → 記録）は tests/hanamiiTeardownRow.test.ts。ここは仕様書だけ。
// 画面の React は使わない（トークンの読み口 CredentialsModal だけ差し替える）。

const creds = vi.hoisted(() => ({
  /** 中央ストアの登録（id → トークン）。 */
  byId: new Map<string, string>(),
  /** 使用中のトークン（無ければ null）。 */
  active: null as string | null,
  calls: [] as string[],
}))
vi.mock('../src/renderer/components/CredentialsModal', () => ({
  getHanamiiToken: async () => { creds.calls.push('active'); return creds.active },
  getHanamiiTokenById: async (id: string) => { creds.calls.push(`byId:${id}`); return creds.byId.get(id) ?? null },
}))

import { hanamiiTeardownSpec, readHanamiiTeardownRecord, HANAMII_TEARDOWN_WORDS, HANAMII_KEY_MISSING_MESSAGE, type HanamiiTeardownRecord } from '../src/renderer/teardown/targets/hanamii'
import { buildTeardownConfirm } from '../src/renderer/teardown/confirm'
import { HANAMII_DELETION_ACCEPTED_WARNING } from '../src/shared/teardownResult'
import { urlChangesOnTeardownNotice } from '../src/shared/cloudCost'
import type { TeardownFacts } from '../src/renderer/teardown/types'
import TeardownResultView from '../src/renderer/components/teardown/TeardownResultView'

const DIR = '/tmp/ws/myapp'
const META_PATH = `${DIR}/.sakuraide.json`

// ── 偽の window ──────────────────────────────────────────────────────────────────────
let metaText: string | Error
let readPaths: string[]
let teardownCalls: Array<{ dir: unknown; auth: unknown; opts: unknown }>
let teardownReply: unknown

beforeEach(() => {
  metaText = '{}'
  readPaths = []
  teardownCalls = []
  teardownReply = { ok: true }
  creds.byId = new Map(); creds.active = null; creds.calls = []
  ;(globalThis as any).window = {
    electronAPI: {
      fs: {
        readFile: async (p: string) => {
          readPaths.push(p)
          if (metaText instanceof Error) throw metaText
          return metaText
        },
      },
      hanamii: {
        teardown: async (dir: unknown, auth: unknown, opts: unknown) => { teardownCalls.push({ dir, auth, opts }); return teardownReply },
      },
    },
  }
})
afterEach(() => { delete (globalThis as any).window })

const metaWith = (hanamii: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ name: 'myapp', publish: { hanamii, ...extra } })

const REC: HanamiiTeardownRecord = { projectId: 'prj-1', name: 'myapp', tokenId: 'tk-1', storageLeftoverBuckets: null }

// ═══════════════════════════════════════════════════════════════════════════════
// 記録の読み方
// ═══════════════════════════════════════════════════════════════════════════════

describe('readRecord: .sakuraide.json の publish.hanamii を読む。読めないときは投げる', () => {
  it('★★★ projectId・name・tokenId・storageLeftoverBuckets を読む。読む場所はプロジェクトの .sakuraide.json', async () => {
    metaText = metaWith({ projectId: 'prj-1', name: 'myapp', tokenId: 'tk-1', storageLeftoverBuckets: ['koto-data-x', 'koto-data-y'] })
    expect(await hanamiiTeardownSpec.readRecord(DIR)).toEqual({
      projectId: 'prj-1', name: 'myapp', tokenId: 'tk-1', storageLeftoverBuckets: ['koto-data-x', 'koto-data-y'],
    })
    expect(readPaths).toEqual([META_PATH])
  })

  it('★★ 項目が無い・空文字は null。HANAMII の節が無い記録は、全部 null（消すものが無い）', async () => {
    metaText = metaWith({ projectId: '', name: 7, tokenId: null })
    expect(await readHanamiiTeardownRecord(DIR)).toEqual({ projectId: null, name: null, tokenId: null, storageLeftoverBuckets: null })
    metaText = JSON.stringify({ name: 'myapp', publish: { targets: { vercel: {} } } })
    expect(await readHanamiiTeardownRecord(DIR)).toEqual({ projectId: null, name: null, tokenId: null, storageLeftoverBuckets: null })
    metaText = '{}'
    expect(await readHanamiiTeardownRecord(DIR)).toEqual({ projectId: null, name: null, tokenId: null, storageLeftoverBuckets: null })
  })

  it('★★ 残りの印の形: 配列（空も）はそのまま。文字列の配列でなければ null（投げない）。空の名前は数えない', async () => {
    const read = async (v: unknown) => { metaText = metaWith({ projectId: 'prj-1', storageLeftoverBuckets: v }); return (await readHanamiiTeardownRecord(DIR)).storageLeftoverBuckets }
    expect(await read([])).toEqual([])
    expect(await read(['a'])).toEqual(['a'])
    expect(await read(['a', ''])).toEqual(['a'])
    expect(await read('a')).toBeNull()
    expect(await read(['a', 1])).toBeNull()
    expect(await read({ 0: 'a' })).toBeNull()
    expect(await read(null)).toBeNull()
    expect(await read(undefined)).toBeNull()
  })

  it('★★★ 読めない・壊れているときは投げる（null に倒さない。倒すと「記録に無い」と「読めない」が区別できない）', async () => {
    metaText = new Error('ENOENT')
    await expect(readHanamiiTeardownRecord(DIR)).rejects.toThrow('ENOENT')
    metaText = '{ 壊れた JSON'
    await expect(readHanamiiTeardownRecord(DIR)).rejects.toThrow()
    for (const bad of ['[]', 'null', '7', '"text"']) {
      metaText = bad
      await expect(readHanamiiTeardownRecord(DIR), `${bad} は記録の形ではない`).rejects.toThrow('公開の記録の形を読めませんでした')
    }
    metaText = JSON.stringify({ publish: 'こわれた' })
    await expect(readHanamiiTeardownRecord(DIR)).rejects.toThrow('公開の記録の形を読めませんでした')
    metaText = JSON.stringify({ publish: { hanamii: 'こわれた' } })
    await expect(readHanamiiTeardownRecord(DIR)).rejects.toThrow('公開の記録の形を読めませんでした')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 仕様書の項目
// ═══════════════════════════════════════════════════════════════════════════════

describe('仕様書の項目（10.4.3）', () => {
  it('★★ 公開先・言葉・確認の言い方の設定', () => {
    const s = hanamiiTeardownSpec
    expect(s.target).toBe('hanamii')
    expect(s.handler).toBe('hanamii:teardown')
    expect(s.words).toBe(HANAMII_TEARDOWN_WORDS)
    expect(s.words).toMatchObject({
      verb: '破棄', confirmTitle: 'HANAMII の公開を破棄します', confirmLabel: '破棄する', activityLabel: 'HANAMII の破棄',
      rowButton: '🗑 破棄', running: '破棄しています…', askAiTarget: 'HANAMII',
    })
    expect(s.claimsComputeBillingStops).toBe(false) // 課金が止まるかは原本で確かめていない
    expect(s.irreversibleNote).toBe('storage-only') // 戻せないと言えるのは、Koto が消す保存場所のデータだけ
    expect(s.waitNote).toBeUndefined()
    expect(s.subscribeProgress).toBeUndefined()
  })

  it('★★ hasWork: projectId があるときだけ（幽霊の行の門番）。nothingToDo は管理画面への案内', () => {
    expect(hanamiiTeardownSpec.hasWork(REC)).toBe(true)
    expect(hanamiiTeardownSpec.hasWork({ ...REC, projectId: null })).toBe(false)
    expect(HANAMII_TEARDOWN_WORDS.nothingToDo).toContain('プロジェクトIDが記録に無い')
    expect(HANAMII_TEARDOWN_WORDS.nothingToDo).toContain('HANAMII の管理画面から削除してください')
  })

  it('★★ targets: 名前を出す（名前が無ければ projectId）。残りの印があるときは [] （プロジェクトはもう無い）', () => {
    expect(hanamiiTeardownSpec.targets(REC)).toEqual(["HANAMII のプロジェクト『myapp』"])
    expect(hanamiiTeardownSpec.targets({ ...REC, name: null })).toEqual(["HANAMII のプロジェクト『prj-1』"])
    expect(hanamiiTeardownSpec.targets({ ...REC, storageLeftoverBuckets: ['a'] })).toEqual([])
    expect(hanamiiTeardownSpec.targets({ ...REC, storageLeftoverBuckets: [] })).toEqual([])
  })

  it('★★ leftoverNote: 印が無ければ null。あれば「削除済みか見つからない状態でした」（404 は「存在しない、または参照できない」。消えたと言い切らない）と、残っている保存場所を全件（空配列は名前なし）', () => {
    const note = hanamiiTeardownSpec.leftoverNote!
    expect(note(REC)).toBeNull()
    expect(note({ ...REC, storageLeftoverBuckets: ['koto-data-x'] }))
      .toBe('前回の破棄で、HANAMII のプロジェクトは削除済みか見つからない状態でした。残っている保存場所『koto-data-x』を削除します。')
    expect(note({ ...REC, storageLeftoverBuckets: ['koto-data-x', 'koto-data-y'] }))
      .toBe('前回の破棄で、HANAMII のプロジェクトは削除済みか見つからない状態でした。残っている保存場所『koto-data-x』『koto-data-y』を削除します。')
    expect(note({ ...REC, storageLeftoverBuckets: [] }))
      .toBe('前回の破棄で、HANAMII のプロジェクトは削除済みか見つからない状態でした。残っている保存場所を削除します。')
    for (const left of [[], ['koto-data-x']]) {
      expect(note({ ...REC, storageLeftoverBuckets: left }), '404 でも書かれる印なのに、消えたと言い切っている').not.toContain('すでに削除されています')
    }
  })

  it('★★★ invoke: IPC は (projectDir, 認証, { confirmed, projectId }) の3つ。projectId は記録のもの。返り値はそのまま返す', async () => {
    teardownReply = { ok: false, message: 'm' }
    const r = await hanamiiTeardownSpec.invoke(DIR, { token: 'tok-1' }, { confirmed: true }, REC)
    expect(r).toBe(teardownReply)
    expect(teardownCalls).toEqual([{ dir: DIR, auth: { token: 'tok-1' }, opts: { confirmed: true, projectId: 'prj-1' } }])
  })

  it('★★ failure は { ok:false, message }。toView は HANAMII の返り値の読み方（受付済みは途中、残った保存場所は残ったもの）', () => {
    expect(hanamiiTeardownSpec.failure('あれ')).toEqual({ ok: false, message: 'あれ' })
    const accepted = hanamiiTeardownSpec.toView({ ok: false, appDeleted: false, deletionAccepted: true, message: HANAMII_DELETION_ACCEPTED_WARNING })
    expect(accepted.state).toBe('inProgress')
    const left = hanamiiTeardownSpec.toView({ ok: false, appDeleted: true, remainingBuckets: ['koto-data-x'], message: '消せませんでした' })
    expect(left.state).toBe('failed')
    expect(left.appDeleted).toBe(true)
    expect(left.remaining.map(l => l.label)).toEqual(['保存場所『koto-data-x』（月額が続きます）'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// D8: どのトークンで呼ぶか
// ═══════════════════════════════════════════════════════════════════════════════

describe('loadAuth（D8）: 記録の tokenId のトークンだけで呼ぶ。見つからなければ止める', () => {
  it('★★★ tokenId があり、登録も見つかる → そのトークン。使用中のトークンは読みにも行かない', async () => {
    creds.byId.set('tk-1', 'tok-of-tk-1'); creds.active = 'tok-active'
    expect(await hanamiiTeardownSpec.loadAuth(REC)).toEqual({ token: 'tok-of-tk-1' })
    expect(creds.calls).toEqual(['byId:tk-1'])
  })

  it('★★★ tokenId があるのに登録が見つからない → null（使用中・先頭の登録のトークンへ倒さない。別のアカウントのトークンで呼ぶと、実体があるのに「もう無い」と読みうる）', async () => {
    creds.active = 'tok-active' // 別のアカウントのトークンがあっても使わない
    creds.byId.set('tk-other', 'tok-other')
    expect(await hanamiiTeardownSpec.loadAuth(REC)).toBeNull()
    expect(creds.calls).toEqual(['byId:tk-1'])
  })

  it('★★ tokenId が記録に無い旧い記録だけ、使用中のトークン（無ければ null）', async () => {
    creds.active = 'tok-active'
    expect(await hanamiiTeardownSpec.loadAuth({ ...REC, tokenId: null })).toEqual({ token: 'tok-active' })
    expect(creds.calls).toEqual(['active'])
    creds.active = null
    expect(await hanamiiTeardownSpec.loadAuth({ ...REC, tokenId: null })).toBeNull()
  })
})

describe('トークンが見つからないときの案内（HANAMII_KEY_MISSING_MESSAGE）: 通る道だけを言う', () => {
  // 記録の tokenId は登録の id との完全一致でしか引かれない（getHanamiiTokenById）。登録を消して足し直すと id が変わり、二度と一致しない。
  // 「認証情報で登録してから、もう一度」とだけ言うと、その人は何度登録し直しても同じ所で止まる。
  it('★★★ 同じ登録にトークンを入れ直す道と、登録を消したなら足し直しても使えない旨・管理画面で削除する道を言う', () => {
    const m = HANAMII_KEY_MISSING_MESSAGE
    expect(m).toContain('認証情報')
    expect(m, '同じ登録に入れ直す道').toContain('公開に使った登録')
    expect(m).toContain('入れ直し')
    expect(m, '登録を消した人が、足し直して回り続けない').toContain('足し直しても使えません')
    expect(m, '行き止まりの先（管理画面で削除する）').toContain('HANAMII の管理画面でプロジェクトを削除')
    expect(m, '削除したあとに残りうる保存場所（月額が続く）の確かめ先').toContain('保存場所が残っていないかコントロールパネルで確かめて')
  })

  it('★★ 「公開に使った」と言い切らない: tokenId の無い旧い記録で使用中のトークンも無い回にも、同じ文で足りる（事実と違う断定を持たない）', () => {
    expect(HANAMII_KEY_MISSING_MESSAGE).not.toContain('公開に使った HANAMII のトークンが見つかりません')
    expect(HANAMII_KEY_MISSING_MESSAGE.startsWith('HANAMII のトークンが見つかりません。')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// B: 確認の文（HANAMII の仕様書で）
// ═══════════════════════════════════════════════════════════════════════════════

const PLACEMENT_A = { bucket: 'koto-data-a', prefix: 'projects/myapp/', shared: true }
const PLACEMENT_B = { bucket: 'koto-data-b', prefix: 'projects/myapp/', shared: true }

function facts(over: Partial<TeardownFacts<HanamiiTeardownRecord>> = {}): TeardownFacts<HanamiiTeardownRecord> {
  return {
    projectName: 'myapp', record: REC, placements: [], placementsUnreadable: false, placementsUnreadableCause: null,
    otherTargets: [], otherTargetsUnreadable: false, waitNote: null, ...over,
  }
}
const confirmOf = (over: Partial<TeardownFacts<HanamiiTeardownRecord>> = {}) => buildTeardownConfirm(hanamiiTeardownSpec, facts(over))
const paragraphs = (body: string) => body.split('\n\n')

describe('B 確認の文: HANAMII の仕様書で', () => {
  it('★★ 見出し・ボタンは仕様書の言葉。danger。先頭はどのプロジェクトか。「次を破棄します」で、「次を削除します」とは言わない', () => {
    const c = confirmOf()
    expect(c.title).toBe('HANAMII の公開を破棄します')
    expect(c.confirmLabel).toBe('破棄する')
    expect(c.danger).toBe(true)
    expect(paragraphs(c.body)[0]).toBe('対象のプロジェクト: 『myapp』')
    expect(paragraphs(c.body)[1]).toBe("次を破棄します: HANAMII のプロジェクト『myapp』")
    expect(c.body).not.toContain('次を削除します')
  })

  it('★★★ 共用型の URL の文（「破棄したあとに公開し直すと別のURLになる」）を出さない。HANAMII の URL が変わるかは原本に書いていない', () => {
    for (const c of [confirmOf(), confirmOf({ placements: [PLACEMENT_A] }), confirmOf({ placements: [PLACEMENT_A, PLACEMENT_B], otherTargets: ['📦 さくらのAppRun'] })]) {
      expect(c.body).not.toContain(urlChangesOnTeardownNotice())
      expect(c.body).not.toContain('別のURL')
      expect(c.body).not.toContain('URL')
    }
  })

  it('★★ 課金の一文（「…の課金は止まります」）を出さない（HANAMII のプロジェクトを消すと課金が止まるかは、原本で確かめていない）。保存場所の一文は残る', () => {
    expect(confirmOf().body).not.toContain('課金は止まります')
    const withStorage = confirmOf({ placements: [PLACEMENT_A] })
    expect(withStorage.body).not.toContain('課金は止まります')
    expect(withStorage.body).toContain('保存場所は、ほかに使っているプロジェクトが無いときだけ止まります。')
  })

  it('★★★ B-3 保存場所1件: 「データも削除します」があり、「残ります」が無い（公開先だけで決まる。保存場所を片づける公開先）。名前を出す', () => {
    const c = confirmOf({ placements: [PLACEMENT_A] })
    expect(c.body).toContain('💾 ')
    expect(c.body).toContain('koto-data-a')
    expect(c.body).toContain('も削除します')
    expect(c.body).not.toContain('残ります')
    expect(c.body).toContain('保存場所『koto-data-a』にある、このプロジェクトのデータ')
  })

  it('★★ B-2 保存場所2件: 2件とも名前を出す', () => {
    const c = confirmOf({ placements: [PLACEMENT_A, PLACEMENT_B] })
    expect(c.body).toContain('『koto-data-a』『koto-data-b』')
    expect(c.body).not.toContain('残ります')
  })

  it('★★ B-4 ほかの公開先: 保存場所があるときだけ名前を出す。0件なら段落が出ない', () => {
    const others = ['📦 さくらのAppRun']
    expect(confirmOf({ placements: [PLACEMENT_A], otherTargets: others }).body).toContain('📦 さくらのAppRun でも使っているため、そちらで公開中のアプリのデータも消えます')
    expect(confirmOf({ placements: [], otherTargets: others }).body).not.toContain('📦 さくらのAppRun')
  })

  it('★★ B-8 元に戻せません: 保存場所0件では言わない。1件以上では、保存場所のデータについてだけ言う（プロジェクトそのものは言わない）', () => {
    const none = confirmOf().body
    expect(none).not.toContain('元に戻せません')
    expect(paragraphs(none).pop()).toBe('よろしいですか？')
    const some = confirmOf({ placements: [PLACEMENT_A] }).body
    expect(some).toContain('保存場所にあるデータの削除は元に戻せません。')
    expect(some).not.toContain('プロジェクトの削除は元に戻せません')
    expect(paragraphs(some).pop()).toBe('保存場所にあるデータの削除は元に戻せません。破棄すると、保存場所は、ほかに使っているプロジェクトが無いときだけ止まります。よろしいですか？')
  })

  it('★★ B-5 読めなかった材料の注意: settings は「保存場所の削除は行われません」（元に戻せませんも、ほかの公開先も足さない）', () => {
    const c = confirmOf({ placementsUnreadable: true, placementsUnreadableCause: 'settings', otherTargets: ['📦 さくらのAppRun'] })
    expect(c.body).toContain('保存場所の削除は行われません')
    expect(c.body).not.toContain('元に戻せません')
    expect(c.body).not.toContain('📦 さくらのAppRun')
  })

  it('★★★ B-5 読めなかった材料の注意: call（問い合わせの失敗）は「削除される場合があります」と「元に戻せません」の両方を言い、ほかの公開先の名前も出す', () => {
    const c = confirmOf({ placementsUnreadable: true, placementsUnreadableCause: 'call', otherTargets: ['📦 さくらのAppRun'] })
    expect(c.body).toContain('削除される場合があります')
    expect(c.body).toContain('削除されたデータは元に戻せません')
    expect(c.body).toContain('ほかの公開先（📦 さくらのAppRun）')
    // ほかの公開先が0件なら、その文は足さない
    expect(confirmOf({ placementsUnreadable: true, placementsUnreadableCause: 'call' }).body).not.toContain('ほかの公開先（')
  })

  it('★★ B-5 ほかの公開先の記録を読めなかった注意: 例に HANAMII 自身を挙げない（Vercel・共用型・専有型。V5）', () => {
    const c = confirmOf({ otherTargetsUnreadable: true })
    expect(c.body).toContain('ほかの公開先の記録を読めなかった')
    expect(c.body).toContain('（Vercel・共用型・専有型など）')
    expect(c.body).not.toContain('（HANAMII')
  })

  it('★★★ B-9 保存場所だけが残った回: 先頭がプロジェクトの削除済みの文で、プロジェクト名の段落（「次を…します」）が無い。💾・元に戻せませんは変わらない', () => {
    const record = { ...REC, storageLeftoverBuckets: ['koto-data-a'] }
    const c = confirmOf({ record, placements: [PLACEMENT_A] })
    const ps = paragraphs(c.body)
    expect(ps[1]).toBe('前回の破棄で、HANAMII のプロジェクトは削除済みか見つからない状態でした。残っている保存場所『koto-data-a』を削除します。')
    expect(c.body).not.toContain('次を破棄します')
    expect(c.body).not.toContain("HANAMII のプロジェクト『myapp』")
    expect(c.body).toContain('💾 ')
    expect(c.body).toContain('保存場所にあるデータの削除は元に戻せません')
    expect(c.body).not.toContain('課金は止まります')
  })

  it('★★ B-9 名前が分からない回（[]）: 「残っている保存場所を削除します。」。印が無い回は変わらない', () => {
    const c = confirmOf({ record: { ...REC, storageLeftoverBuckets: [] } })
    expect(paragraphs(c.body)[1]).toBe('前回の破棄で、HANAMII のプロジェクトは削除済みか見つからない状態でした。残っている保存場所を削除します。')
    expect(confirmOf().body).not.toContain('削除済みか見つからない状態でした')
  })

  it('★★★ B-9 保存場所の設定も読めない回（settings）: 先頭は事実だけ。「残っている保存場所を削除します」と、下の「削除は行われません」が食い違わない', () => {
    const record = { ...REC, storageLeftoverBuckets: ['koto-data-a'] }
    const c = confirmOf({ record, placementsUnreadable: true, placementsUnreadableCause: 'settings' })
    expect(c.body).toContain('前回の破棄で、保存場所だけが残っています。')
    expect(c.body).not.toContain('残っている保存場所『koto-data-a』を削除します')
    expect(c.body).toContain('保存場所の削除は行われません')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 結果欄: HANAMII の返り値を、仕様書の toView と言葉で共通の結果の部品に描いたもの（一覧が出す見た目）
// ═══════════════════════════════════════════════════════════════════════════════

describe('結果欄: HANAMII の返り値（受付済み・保存場所だけ残った・全部片づいた）を共通の部品で描く', () => {
  const SERVICE_URL = 'https://hanamii.jp/'
  const STORAGE_URL = 'https://secure.sakura.ad.jp/cloud/'
  const text = (h: string) => h.replace(/<[^>]*>/g, '')
  const hrefs = (h: string) => [...h.matchAll(/href="([^"]*)"/g)].map(m => m[1])
  const count = (s: string, part: string) => s.split(part).length - 1
  const render = (raw: unknown) => renderToStaticMarkup(createElement(TeardownResultView, {
    view: hanamiiTeardownSpec.toView(raw as any), notes: [], words: HANAMII_TEARDOWN_WORDS, retryHint: 'この一覧の 🗑 破棄',
    serviceConsoleUrl: SERVICE_URL, storageConsoleUrl: STORAGE_URL,
  }))

  it('★★★ 受付済み（deletionAccepted）: 「破棄の途中です」。受付済みの文は1回だけ（message と警告で重ねない）。HANAMII はまだ消えていないので、HANAMII の管理画面へ案内する', () => {
    const h = render({ ok: false, appDeleted: false, deletionAccepted: true, message: HANAMII_DELETION_ACCEPTED_WARNING })
    expect(text(h)).toContain('⏳ 破棄の途中です')
    expect(count(text(h), HANAMII_DELETION_ACCEPTED_WARNING)).toBe(1)
    expect(text(h)).not.toContain('待ち切れずに止まりました') // 専有型の文（Koto が待ち切れなかったのではない）
    expect(text(h)).not.toContain('課金が続きます')
    expect(hrefs(h)).toEqual([SERVICE_URL])
  })

  it('★★★ 保存場所だけ残った回: 「破棄できませんでした」。残った保存場所の名前と月額が続くこと。保存場所はコントロールパネルへ案内し、HANAMII の管理画面へは案内しない（プロジェクトはもう無い）', () => {
    const h = render({ ok: false, appDeleted: true, remainingBuckets: ['koto-data-x', 'koto-data-y'], message: '保存場所を削除できませんでした' })
    expect(text(h)).toContain('⚠️ 破棄できませんでした')
    expect(text(h)).toContain("保存場所『koto-data-x』（月額が続きます）")
    expect(text(h)).toContain("保存場所『koto-data-y』（月額が続きます）")
    expect(text(h)).toContain('破棄できずに残っているものがあります')
    expect(hrefs(h)).toEqual([STORAGE_URL])
  })

  it('★★ 全部片づいた回: 「破棄しました」。案内のリンクは出ない', () => {
    const h = render({ ok: true, appDeleted: true, executed: ['保存場所『koto-data-x』のデータを削除しました'] })
    expect(text(h)).toContain('✅ 破棄しました')
    expect(hrefs(h)).toEqual([])
  })

  it('★★ HANAMII のプロジェクトを消せなかった失敗（トークンが無い・断られた）: HANAMII の管理画面へ案内する。入口の案内文がそのまま出る', () => {
    const h = render(hanamiiTeardownSpec.failure('公開に使ったトークンが見つかりません'))
    expect(text(h)).toContain('⚠️ 破棄できませんでした')
    expect(text(h)).toContain('公開に使ったトークンが見つかりません')
    expect(hrefs(h)).toEqual([SERVICE_URL])
  })
})
