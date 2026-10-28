import { describe, it, expect } from 'vitest'
import { buildTeardownConfirm } from '../src/renderer/teardown/confirm'
import { runTeardownFlow } from '../src/renderer/teardown/flow'
import { sharedTeardownSpec, SHARED_TEARDOWN_WORDS, type SharedTeardownRecord } from '../src/renderer/teardown/targets/shared'
import { hanamiiTeardownSpec, HANAMII_TEARDOWN_WORDS } from '../src/renderer/teardown/targets/hanamii'
import type { TeardownFacts } from '../src/renderer/teardown/types'
import type { ConfirmOptions } from '../src/renderer/useConfirm'

// ── 0.6.24 A-8: 共用型の確認の見出し。アプリが無く、保存場所・コンテナレジストリだけが残る回は「{名詞}を破棄します」───────────────────
// 名詞は、プロジェクトの削除のチェックの文と同じ sharedLeftoverNoun の1つ（K2: 借り手のいるレジストリだけの回は、レジストリと言わない）。
// 確認の文は3つの入口（【公開】の 🗑・📡・プロジェクトの削除）がすべて runTeardownFlow → buildTeardownConfirm で作るので、ここで見れば全部に効く。

const rec = (o: Partial<SharedTeardownRecord> = {}): SharedTeardownRecord =>
  ({ appNames: [], registryName: null, registryOrigin: 'owned', registryUsers: [], placements: [], stateOnlyBuckets: [], ...o })
const PLACEMENT = { bucket: 'koto-data-a', prefix: 'projects/myapp/', shared: true }
const facts = (record: SharedTeardownRecord): TeardownFacts<SharedTeardownRecord> => ({
  projectName: 'myapp', record, placements: record.placements, placementsUnreadable: false, placementsUnreadableCause: null,
  otherTargets: [], otherTargetsUnreadable: false, waitNote: null,
})
const DEFAULT_TITLE = 'さくらのAppRun の公開を破棄します'

describe('A-8 共用型の確認の見出し', () => {
  it.each([
    ['アプリだけ', rec({ appNames: ['myapp'] }), DEFAULT_TITLE],
    ['アプリと保存場所（公開の回）', rec({ appNames: ['myapp'], placements: [PLACEMENT] }), DEFAULT_TITLE],
    ['アプリとレジストリ（公開の回）', rec({ appNames: ['myapp'], registryName: 'myreg' }), DEFAULT_TITLE],
    ['保存場所だけ', rec({ placements: [PLACEMENT] }), '保存場所を破棄します'],
    ['レジストリだけ（作った）', rec({ registryName: 'myreg' }), 'コンテナレジストリを破棄します'],
    ['レジストリだけ（借りた・借り手なし）', rec({ registryName: 'myreg', registryOrigin: 'adopted' }), 'コンテナレジストリを破棄します'],
    ['レジストリだけ（由来が分からない・借り手なし）', rec({ registryName: 'myreg', registryOrigin: 'unknown' }), 'コンテナレジストリを破棄します'],
    ['保存場所とレジストリ', rec({ placements: [PLACEMENT], registryName: 'myreg' }), '保存場所・コンテナレジストリを破棄します'],
    ['借り手のいるレジストリだけ（K2: 数えない）', rec({ registryName: 'myreg', registryUsers: ['other'] }), DEFAULT_TITLE],
    ['保存場所と、借り手のいるレジストリ（レジストリは言わない）', rec({ placements: [PLACEMENT], registryName: 'myreg', registryUsers: ['other'] }), '保存場所を破棄します'],
    ['何も無い（幽霊の行）', rec(), DEFAULT_TITLE],
  ] as const)('★★★ %s → 「%s」', (_name, record, title) => {
    const c = buildTeardownConfirm(sharedTeardownSpec, facts(record))
    expect(c.title).toBe(title)
    expect(c.confirmLabel).toBe('破棄する')
    expect(c.danger).toBe(true)
  })

  it('★★ 見出しだけが変わる。本文（対象のプロジェクト・保存場所の名指し・元に戻せません）は、見出しを言い換えない回と同じ作り方のまま', () => {
    const c = buildTeardownConfirm(sharedTeardownSpec, facts(rec({ placements: [PLACEMENT] })))
    expect(c.body).toContain('対象のプロジェクト: 『myapp』')
    expect(c.body).toContain('保存場所『koto-data-a』')
    expect(c.body).toContain('この操作は元に戻せません。')
    const same = buildTeardownConfirm({ ...sharedTeardownSpec, confirmTitleOf: undefined }, facts(rec({ placements: [PLACEMENT] })))
    expect(same.body).toBe(c.body)
    expect(same.title).toBe(DEFAULT_TITLE)
  })

  it('★★★ 確認を出す流れ（3つの入口が通る runTeardownFlow）が、確認の見出しに使う。HANAMII など、言い換えを持たない公開先は今の見出しのまま', async () => {
    const opened: string[] = []
    const confirm = async (o: ConfirmOptions) => { opened.push(o.title); return false }
    const deps = (record: SharedTeardownRecord) => ({
      loadFacts: async () => facts(record), confirm,
      confirmWithChoices: async (o: ConfirmOptions) => { opened.push(o.title); return { confirmed: false, choices: {} } },
      loadAuth: async () => ({ heldByMain: true as const }), invoke: async () => ({ ok: true }) as never,
      beginActivity: () => () => {}, keyMissingMessage: '',
    })
    await runTeardownFlow('/p', sharedTeardownSpec, deps(rec({ placements: [PLACEMENT] })))
    await runTeardownFlow('/p', sharedTeardownSpec, deps(rec({ placements: [PLACEMENT], registryName: 'myreg' }))) // 選択つきの確認
    await runTeardownFlow('/p', sharedTeardownSpec, deps(rec({ appNames: ['myapp'], placements: [PLACEMENT] })))
    expect(opened).toEqual(['保存場所を破棄します', '保存場所・コンテナレジストリを破棄します', DEFAULT_TITLE])
    expect(SHARED_TEARDOWN_WORDS.confirmTitle).toBe(DEFAULT_TITLE)
    expect(hanamiiTeardownSpec.confirmTitleOf).toBeUndefined()
    expect(HANAMII_TEARDOWN_WORDS.confirmTitle).toBe('HANAMII の公開を破棄します')
  })
})
