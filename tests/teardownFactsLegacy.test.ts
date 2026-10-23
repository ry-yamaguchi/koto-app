import { describe, it, expect, vi, afterEach } from 'vitest'

// ── 段階2（2b-1）: D9=2 ほかの公開先に、旧い記録の分も数える ────────────────────────────────────────────
// 設計書 docs/teardown-unify-plan.md の 10.7.7 (3)・10.7.12「D9=2」。親の判断（10.7.16 末尾）の 3: 「ほかの公開先」は保存場所を使いうる公開先だけ。
//
//   publishTargetsWithLegacy             … 純関数。publish.targets ∪ HANAMII（publish.hanamii.projectId）∪ 共用型（state.json の apprun-app）∪
//                                           専有型（publish.apprunDedicated のどれかの ID）。並びは定義順、重なりは1つ、形が読めなければ null
//   readPublishTargetsWithLegacyOrThrow  … 読み口。state.json が無ければ旧い共用型なし（読めなかった印は立たない）、あるのに読めなければ投げる
//   electronTeardownFactsApi().otherTargets … 自分を除き、レンタルサーバ（保存場所を使わない）を挙げない
//   確認の文                              … 共用型の確認で旧い HANAMII が、HANAMII の確認で旧い共用型が、名前で出る
// HANAMII の仕様書を使う確認の文だけ、トークンの読み口（CredentialsModal）を差し替える。

vi.mock('../src/renderer/components/CredentialsModal', () => ({
  getHanamiiToken: async () => null,
  getHanamiiTokenById: async () => null,
}))

import {
  publishTargetsWithLegacy, readPublishTargetsWithLegacyOrThrow, readPublishTargetsOrThrow, PUBLISH_TARGETS_USING_STORAGE,
} from '../src/renderer/publishRecord'
import { electronTeardownFactsApi, loadTeardownFacts } from '../src/renderer/teardown/facts'
import { buildTeardownConfirm } from '../src/renderer/teardown/confirm'
import { hanamiiTeardownSpec } from '../src/renderer/teardown/targets/hanamii'
import { sharedTeardownSpec, type SharedTeardownRecord } from '../src/renderer/teardown/targets/shared'
import { PUBLISH_TARGET_LABEL } from '../src/renderer/publishStatus'

afterEach(() => { delete (globalThis as any).window })

const STATE_WITH_APP = { resources: [{ kind: 'apprun-app', id: 'app-1' }] }
const STATE_WITHOUT_APP = { resources: [{ kind: 'bucket', id: 'koto-a' }] }
const t = (...kinds: string[]) => Object.fromEntries(kinds.map(k => [k, { publishedAt: '2026-10-01T00:00:00.000Z' }]))

describe('publishTargetsWithLegacy: 記録のある公開先に、旧い記録だけの公開先を足す（純関数）', () => {
  it('★ publish.targets だけ → 定義順（hanamii・vercel・sakura-apprun・sakura-apprun-dedicated・sakura-rental）', () => {
    expect(publishTargetsWithLegacy({ publish: { targets: t('sakura-rental', 'vercel', 'hanamii') } }, null)).toEqual(['hanamii', 'vercel', 'sakura-rental'])
    expect(publishTargetsWithLegacy({ publish: { targets: t('sakura-apprun-dedicated', 'sakura-apprun') } }, null)).toEqual(['sakura-apprun', 'sakura-apprun-dedicated'])
  })

  it('★★★ HANAMII: publish.hanamii.projectId が空でない文字列なら、targets に行が無くても数える。空・文字列でない・オブジェクトでないは数えない', () => {
    expect(publishTargetsWithLegacy({ publish: { hanamii: { projectId: 'prj-1' } } }, null)).toEqual(['hanamii'])
    for (const projectId of ['', null, undefined, 1, {}, []]) {
      expect(publishTargetsWithLegacy({ publish: { hanamii: { projectId } } }, null), JSON.stringify(projectId)).toEqual([])
    }
    expect(publishTargetsWithLegacy({ publish: { hanamii: 'prj-1' } }, null)).toEqual([])
    expect(publishTargetsWithLegacy({ publish: { hanamii: ['prj-1'] } }, null)).toEqual([])
  })

  it('★★★ 共用型: state.json に apprun-app があれば数える。bucket だけ・空・形が違う state は数えない。state が無い（null）なら数えない', () => {
    expect(publishTargetsWithLegacy({}, STATE_WITH_APP)).toEqual(['sakura-apprun'])
    expect(publishTargetsWithLegacy({}, STATE_WITHOUT_APP)).toEqual([])
    expect(publishTargetsWithLegacy({}, { resources: [] })).toEqual([])
    expect(publishTargetsWithLegacy({}, {})).toEqual([])
    expect(publishTargetsWithLegacy({}, [])).toEqual([])
    expect(publishTargetsWithLegacy({}, 'x')).toEqual([])
    expect(publishTargetsWithLegacy({}, null)).toEqual([])
  })

  it.each([['applicationID'], ['clusterID'], ['asgID'], ['loadBalancerID']])(
    '★★★ 専有型: publish.apprunDedicated の %s が空でない文字列なら数える', (key) => {
      expect(publishTargetsWithLegacy({ publish: { apprunDedicated: { [key]: 'id-1' } } }, null)).toEqual(['sakura-apprun-dedicated'])
      for (const v of ['', null, undefined, 0, {}]) {
        expect(publishTargetsWithLegacy({ publish: { apprunDedicated: { [key]: v } } }, null), `${key}=${JSON.stringify(v)}`).toEqual([])
      }
    })

  it('専有型: 資源の ID でないもの（サービスプリンシパル・同意・名前・作った時刻）だけでは数えない。オブジェクトでなければ数えない', () => {
    expect(publishTargetsWithLegacy({ publish: { apprunDedicated: { servicePrincipalId: 'sp-1', consentedAt: 't', name: 'n', createdAt: 't' } } }, null)).toEqual([])
    expect(publishTargetsWithLegacy({ publish: { apprunDedicated: 'x' } }, null)).toEqual([])
    expect(publishTargetsWithLegacy({ publish: { apprunDedicated: ['id'] } }, null)).toEqual([])
  })

  it('★★ 重なりは1つ。全部あれば定義順（hanamii・vercel・sakura-apprun・sakura-apprun-dedicated・sakura-rental）', () => {
    const meta = {
      publish: {
        targets: t('hanamii', 'sakura-rental', 'vercel'),
        hanamii: { projectId: 'prj-1' },
        apprunDedicated: { clusterID: 'c-1', asgID: 'a-1' },
      },
    }
    expect(publishTargetsWithLegacy(meta, STATE_WITH_APP)).toEqual(['hanamii', 'vercel', 'sakura-apprun', 'sakura-apprun-dedicated', 'sakura-rental'])
    expect(publishTargetsWithLegacy({ publish: { targets: t('sakura-apprun'), } }, STATE_WITH_APP)).toEqual(['sakura-apprun'])
  })

  it('★★ 形が読めなければ null（空配列とは別の意味）。publish.targets の読み（parsePublishTargets）と同じ', () => {
    for (const bad of [[], 'x', 1, null, undefined, { publish: 'x' }, { publish: [] }, { publish: { targets: 'x' } }, { publish: { targets: [] } }]) {
      expect(publishTargetsWithLegacy(bad, STATE_WITH_APP), JSON.stringify(bad)).toBeNull()
    }
    expect(publishTargetsWithLegacy({}, null)).toEqual([])
    expect(publishTargetsWithLegacy({ publish: {} }, null)).toEqual([])
    expect(publishTargetsWithLegacy({ publish: null }, null)).toEqual([])
    expect(publishTargetsWithLegacy({ publish: { targets: null } }, null)).toEqual([])
  })

  it('旧い記録の分を足すだけで、publish.targets だけを見る読み（parsePublishTargets）の答えを減らさない', () => {
    for (const meta of [{}, { publish: { targets: t('hanamii', 'vercel') } }, { publish: { targets: t('sakura-apprun-dedicated') } }]) {
      const legacy = publishTargetsWithLegacy(meta, null)!
      for (const x of Object.keys((meta as any).publish?.targets ?? {})) expect(legacy).toContain(x)
    }
  })

  it('保存場所を使いうる公開先の表（親の判断）: HANAMII・Vercel・共用型・専有型。レンタルサーバは入らない', () => {
    expect([...PUBLISH_TARGETS_USING_STORAGE].sort()).toEqual(['hanamii', 'sakura-apprun', 'sakura-apprun-dedicated', 'vercel'])
    expect(PUBLISH_TARGETS_USING_STORAGE).not.toContain('sakura-rental')
  })
})

// ── 読み口 ─────────────────────────────────────────────────────────────────────────────

type Files = Record<string, string | Error>
/** 偽の window。`files` に無いパスは ENOENT で投げる。`exists` は既定でファイルの有無。読んだパスと exists を聞かれたパスを記録する。 */
function installWindow(files: Files, over: { exists?: (p: string) => Promise<unknown>; estimates?: () => Promise<unknown> } = {}) {
  const read: string[] = []
  const asked: string[] = []
  ;(globalThis as any).window = {
    electronAPI: {
      fs: {
        readFile: async (p: string) => {
          read.push(p)
          const v = files[p]
          if (v === undefined) throw new Error(`ENOENT: ${p}`)
          if (v instanceof Error) throw v
          return v
        },
        exists: async (p: string) => { asked.push(p); return over.exists ? over.exists(p) : p in files },
      },
      stageTiming: { estimates: over.estimates ?? (async () => null) },
      storage: { placement: async () => ({ ok: true, placement: null, placements: [] }) },
    },
  }
  return { read, asked }
}
const META = '/proj/.sakuraide.json'
const STATE = '/proj/.sakura-cloud/state.json'
const meta = (publish: unknown) => JSON.stringify({ name: 'myapp', publish })
const state = (s: unknown) => JSON.stringify(s)

describe('readPublishTargetsWithLegacyOrThrow: 読み口（読めなかったら投げる）', () => {
  it('★★★ state.json が無い（exists が false）: 旧い共用型なし。state.json は読みにいかない（読めなかった印は立たない）', async () => {
    const w = installWindow({ [META]: meta({ targets: t('vercel') }) })
    expect(await readPublishTargetsWithLegacyOrThrow('/proj')).toEqual(['vercel'])
    // 段階3A（G=1）: .sakuraide.json にも exists を聞く（false なら「記録が無い」）。聞く順は .sakuraide.json → state.json
    expect(w.asked).toEqual([META, STATE])
    expect(w.read).toEqual([META])
  })

  it('★★★ state.json に apprun-app がある: 共用型が加わる。読むのは .sakuraide.json と .sakura-cloud/state.json', async () => {
    const w = installWindow({ [META]: meta({ targets: t('vercel') }), [STATE]: state(STATE_WITH_APP) })
    expect(await readPublishTargetsWithLegacyOrThrow('/proj')).toEqual(['vercel', 'sakura-apprun'])
    expect(w.read).toEqual([META, STATE])
  })

  it('★★ state.json があるのに読めない／JSON でない → 投げる（空に倒さない）', async () => {
    installWindow({ [META]: meta({}), [STATE]: new Error('EACCES') })
    await expect(readPublishTargetsWithLegacyOrThrow('/proj')).rejects.toThrow('EACCES')
    installWindow({ [META]: meta({}), [STATE]: '{ 壊れた' })
    await expect(readPublishTargetsWithLegacyOrThrow('/proj')).rejects.toThrow()
  })

  it('★★ exists そのものが失敗したら、あるとみなして読みにいく。読めなければ投げる', async () => {
    installWindow({ [META]: meta({}), [STATE]: state(STATE_WITH_APP) }, { exists: async () => { throw new Error('IPC 失敗') } })
    expect(await readPublishTargetsWithLegacyOrThrow('/proj')).toEqual(['sakura-apprun'])
    installWindow({ [META]: meta({}) }, { exists: async () => { throw new Error('IPC 失敗') } })
    await expect(readPublishTargetsWithLegacyOrThrow('/proj')).rejects.toThrow('ENOENT')
  })

  it('exists が true 以外（undefined など）を返したら、無いとみなす（hanamiiRowHarness 以前の偽物のように exists を持たない口でも落ちない）', async () => {
    const w = installWindow({ [META]: meta({ targets: t('hanamii') }), [STATE]: state(STATE_WITH_APP) }, { exists: async () => undefined })
    expect(await readPublishTargetsWithLegacyOrThrow('/proj')).toEqual(['hanamii'])
    expect(w.read).toEqual([META])
  })

  it('★★★ .sakuraide.json が読めない・JSON でない・形が違う → 投げる（今の readPublishTargetsOrThrow と同じ）。そのとき state.json には進まない', async () => {
    for (const files of [
      { [META]: new Error('EACCES') } as Files,
      { [META]: '{ 壊れた' } as Files,
      { [META]: '[]' } as Files,
      { [META]: meta('x') } as Files,
      { [META]: meta({ targets: 'x' }) } as Files,
    ]) {
      const w = installWindow({ ...files, [STATE]: state(STATE_WITH_APP) })
      await expect(readPublishTargetsWithLegacyOrThrow('/proj'), JSON.stringify(Object.keys(files))).rejects.toThrow()
      await expect(readPublishTargetsOrThrow('/proj')).rejects.toThrow()
      expect(w.read.includes(STATE)).toBe(false)
    }
  })

  // 段階3A（親の判断 G=1・2026-10-12）: .sakuraide.json が「無い」のは、記録が無いだけ。読めなかったことにしない。
  // 以前は投げて、state.json だけがあるプロジェクトの共用型の確認に「ほかの公開先の記録を読めなかったため」という事実でない注意が出ていた。
  it('★★★ .sakuraide.json が無い（exists が false）→ 投げない。readFile も呼ばない。state.json に apprun-app があれば共用型、どちらも無ければ []', async () => {
    const w = installWindow({ [STATE]: state(STATE_WITH_APP) })
    expect(await readPublishTargetsWithLegacyOrThrow('/proj')).toEqual(['sakura-apprun'])
    expect(w.read).toEqual([STATE])
    const w2 = installWindow({})
    expect(await readPublishTargetsWithLegacyOrThrow('/proj')).toEqual([])
    expect(w2.read).toEqual([])
    installWindow({ [STATE]: state(STATE_WITHOUT_APP) })
    expect(await readPublishTargetsWithLegacyOrThrow('/proj')).toEqual([])
  })

  it('★★ .sakuraide.json が無くても、state.json があるのに読めなければ投げる（旧い共用型を数えられなかった事実は残す）', async () => {
    installWindow({ [STATE]: '{ 壊れた' })
    await expect(readPublishTargetsWithLegacyOrThrow('/proj')).rejects.toThrow()
  })

  it('手本が使う readPublishTargetsOrThrow は変えない: .sakuraide.json が無ければ、今までどおり投げる', async () => {
    installWindow({ [STATE]: state(STATE_WITH_APP) })
    await expect(readPublishTargetsOrThrow('/proj')).rejects.toThrow('ENOENT')
  })

  it('旧い記録の分だけでなく、今の読み（readPublishTargetsOrThrow）の答えは減らない', async () => {
    installWindow({ [META]: meta({ targets: t('hanamii', 'sakura-rental') }) })
    const old = await readPublishTargetsOrThrow('/proj')
    const next = await readPublishTargetsWithLegacyOrThrow('/proj')
    for (const x of old) expect(next).toContain(x)
  })
})

// ── 確認の材料（otherTargets）と確認の文 ─────────────────────────────────────────────────

describe('electronTeardownFactsApi().otherTargets: 自分を除き、保存場所を使いうる公開先だけを、画面の表示名で返す', () => {
  const L = PUBLISH_TARGET_LABEL
  it('★★★ レンタルサーバは挙げない（保存場所を使わない）。HANAMII・Vercel・共用型・専有型は挙げる', async () => {
    installWindow({ [META]: meta({ targets: t('hanamii', 'vercel', 'sakura-apprun', 'sakura-apprun-dedicated', 'sakura-rental') }) })
    expect(await electronTeardownFactsApi().otherTargets('/proj', 'sakura-rental')).toEqual([L.hanamii, L.vercel, L['sakura-apprun'], L['sakura-apprun-dedicated']])
    expect(await electronTeardownFactsApi().otherTargets('/proj', 'hanamii')).toEqual([L.vercel, L['sakura-apprun'], L['sakura-apprun-dedicated']])
    expect(await electronTeardownFactsApi().otherTargets('/proj', 'sakura-apprun')).not.toContain(L['sakura-rental'])
  })

  it('★★★ 旧い記録だけの公開先も挙げる（targets に行が無い HANAMII・共用型・専有型）', async () => {
    installWindow({
      [META]: meta({ hanamii: { projectId: 'prj-1' }, apprunDedicated: { loadBalancerID: 'lb-1' } }),
      [STATE]: state(STATE_WITH_APP),
    })
    expect(await electronTeardownFactsApi().otherTargets('/proj', 'vercel')).toEqual([L.hanamii, L['sakura-apprun'], L['sakura-apprun-dedicated']])
    expect(await electronTeardownFactsApi().otherTargets('/proj', 'hanamii')).toEqual([L['sakura-apprun'], L['sakura-apprun-dedicated']])
    expect(await electronTeardownFactsApi().otherTargets('/proj', 'sakura-apprun')).toEqual([L.hanamii, L['sakura-apprun-dedicated']])
  })

  it('★★★ 旧い記録を読めない（state.json があるのに壊れている）→ 投げる。流れが otherTargetsUnreadable を立て、確認の文が「読めなかった」と言う', async () => {
    installWindow({ [META]: meta({ targets: t('vercel') }), [STATE]: '{ 壊れた' })
    await expect(electronTeardownFactsApi().otherTargets('/proj', 'hanamii')).rejects.toThrow()
    const facts = await loadTeardownFacts('/proj', { target: 'hanamii', readRecord: async () => ({}) }, electronTeardownFactsApi())
    expect(facts.otherTargets).toEqual([])
    expect(facts.otherTargetsUnreadable).toBe(true)
  })

  it('★★★ .sakuraide.json が無く state.json だけがある（G=1）→ 読めなかった印は立たない。state.json の共用型が名前で出る', async () => {
    installWindow({ [STATE]: state(STATE_WITH_APP) })
    const facts = await loadTeardownFacts('/proj', { target: 'hanamii', readRecord: async () => ({}) }, electronTeardownFactsApi())
    expect(facts.otherTargets).toEqual([L['sakura-apprun']])
    expect(facts.otherTargetsUnreadable).toBe(false)
  })

  it('state.json が無いだけなら、読めなかった印は立たない（旧い共用型が無いのは普通のこと）', async () => {
    installWindow({ [META]: meta({ targets: t('vercel') }) })
    const facts = await loadTeardownFacts('/proj', { target: 'hanamii', readRecord: async () => ({}) }, electronTeardownFactsApi())
    expect(facts.otherTargets).toEqual([L.vercel])
    expect(facts.otherTargetsUnreadable).toBe(false)
  })
})

describe('確認の文: 旧い記録の公開先が名前で出る（D9=2）', () => {
  const SHARED_REC: SharedTeardownRecord = {
    appNames: ['myapp'], registryName: 'myreg', registryOrigin: 'owned', registryUsers: [],
    placements: [{ bucket: 'koto-a', prefix: 'projects/myapp/', shared: true }], stateOnlyBuckets: [],
  }
  const HANAMII_REC = { projectId: 'prj-1', name: 'myapp', tokenId: 'tk-1', storageLeftoverBuckets: null }

  it('★★★ 共用型の確認: targets に行が無く publish.hanamii.projectId だけの HANAMII が「🌸 HANAMII でも使っているため」と名前で出る', async () => {
    installWindow({ [META]: meta({ hanamii: { projectId: 'prj-1' } }) })
    const facts = await loadTeardownFacts('/proj', { ...sharedTeardownSpec, readRecord: async () => SHARED_REC }, electronTeardownFactsApi())
    const body = buildTeardownConfirm(sharedTeardownSpec, facts).body
    expect(body).toContain(`${PUBLISH_TARGET_LABEL.hanamii} でも使っているため`)
    expect(body).toContain('そちらで公開中のアプリのデータも消えます')
  })

  it('★★★ HANAMII の確認: state.json だけの旧い共用型が名前で出る。targets にレンタルサーバがあっても挙げない', async () => {
    installWindow({
      [META]: meta({ hanamii: { projectId: 'prj-1' }, targets: t('sakura-rental') }),
      [STATE]: state(STATE_WITH_APP),
    })
    const facts = await loadTeardownFacts('/proj', {
      ...hanamiiTeardownSpec,
      readRecord: async () => HANAMII_REC,
      // 保存場所は1件ある回にする（ほかの公開先の段落は、保存場所があるときだけ出る）
      placementsOf: () => [{ bucket: 'koto-a', prefix: 'projects/myapp/', shared: true }],
    }, electronTeardownFactsApi())
    expect(facts.otherTargets).toEqual([PUBLISH_TARGET_LABEL['sakura-apprun']])
    const body = buildTeardownConfirm(hanamiiTeardownSpec, facts).body
    expect(body).toContain(`${PUBLISH_TARGET_LABEL['sakura-apprun']} でも使っているため`)
    expect(body).not.toContain(PUBLISH_TARGET_LABEL['sakura-rental'])
  })
})
