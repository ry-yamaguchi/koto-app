import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── 段階1（1b）: 一覧の HANAMII の行（TeardownRow）を、本物の流れ・本物の main・偽の HANAMII/偽の保存場所に通す（トークン・保存場所だけ残った回・開き直し）─────
// 設計書: docs/teardown-unify-plan.md の 10.4.9 の E（フックと行）。前半は tests/hanamiiTeardownRow.test.ts（押す → 確認 → 破棄 → 結果）。
// D8（どのトークンで呼ぶか）・B-9 と D（保存場所だけ残った回の印が、main が書く → 記録から読む → 確認の文が言う、までつながる）・E-5（閉じて開き直す）。
//
// 共通の部品の E（tests/teardownHookCommon.test.ts）は偽の仕様書で書いてある。ここは**本物の仕様書（hanamiiTeardownSpec）**で:
//   ・行（TeardownRow）→ フック → 流れ（runTeardownFlow）→ 仕様書の readRecord/loadAuth/invoke → 本物の main の hanamii:teardown → 偽の HANAMII
//   ・画面は公開の記録を一度も消さない（publishMeta の口が0回）。消すのは main の1か所
//   ・出る要求を1本の並びで見る（ソースの文字列は読まない・掟10）
//
// React は DOM 環境を入れていないので、react の useState／useRef／useCallback／useEffect だけを試験用の小さな実装に差し替える
// （tests/teardownHookCommon.test.ts と同じやり方）。偽の応答は原本から写す（tests/hanamiiTeardownFixtures.ts）。
// 窓・記録・行の取り付けは tests/hanamiiRowHarness.ts。

const rt = vi.hoisted(() => ({
  slots: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<{ deps?: readonly unknown[]; cleanup?: void | (() => void) } | undefined>,
  queue: [] as Array<{ idx: number; fn: () => void | (() => void); deps?: readonly unknown[] }>,
  i: 0, r: 0, e: 0,
  rerender: () => {},
}))

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>()
  return {
    ...real,
    useState: (init: unknown) => {
      const idx = rt.i++
      if (!(idx in rt.slots)) rt.slots[idx] = typeof init === 'function' ? (init as () => unknown)() : init
      const set = (v: unknown) => {
        const next = typeof v === 'function' ? (v as (p: unknown) => unknown)(rt.slots[idx]) : v
        if (Object.is(next, rt.slots[idx])) return
        rt.slots[idx] = next
        rt.rerender()
      }
      return [rt.slots[idx], set]
    },
    useRef: (init: unknown) => {
      const idx = rt.r++
      if (!rt.refs[idx]) rt.refs[idx] = { current: init }
      return rt.refs[idx]
    },
    useCallback: (fn: unknown) => fn,
    useEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => {
      const idx = rt.e++
      const prev = rt.effects[idx]
      const changed = !prev || !deps || !prev.deps || deps.length !== prev.deps.length || deps.some((d, k) => !Object.is(d, prev.deps![k]))
      if (changed) rt.queue.push({ idx, fn, deps })
    },
  }
})

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  hasCreds: true,
  /** 偽の HANAMII の DELETE が返す HTTP ステータス。 */
  status: 200,
  /** HANAMII へ出た要求と、保存場所へ出た要求を、1本の並びで積む。 */
  calls: [] as string[],
  /** HANAMII へ出た要求の Authorization ヘッダ。 */
  auths: [] as string[],
  listThrows: false,
  /** 中央ストアの登録（id → トークン）と、使用中のトークン。 */
  byId: new Map<string, string>(),
  active: null as string | null,
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => '/tmp', getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {} },
  dialog: {},
}))

vi.mock('../src/main/cloud/auth', async (importOriginal) => {
  const real = await importOriginal<any>()
  return { ...real, loadCredentials: () => (h.hasCreds ? { token: 'tok', secret: 'sec' } : null) }
})

vi.mock('../src/main/cloud/storageAdapter', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    createStorageAdapter: async () => {
      h.calls.push('storage connect')
      return {
        siteInfo: () => ({ s3Endpoint: 's3.isk01.sakurastorage.jp', region: 'jp-north-1' }),
        async isSiteReady() { return true },
        async ensureBucket() {},
        async putMarker() {},
        async listAllKeys(bucket: string) {
          h.calls.push(`list ${bucket}`)
          if (h.listThrows) throw new Error('一覧を取得できませんでした（テスト）')
          return ['projects/myapp/a.txt']
        },
        async deleteKeys(bucket: string) { h.calls.push(`deleteKeys ${bucket}`) },
        async deleteBucket(bucket: string) { h.calls.push(`deleteBucket ${bucket}`) },
        async deletePermission(id: string) { h.calls.push(`deletePermission ${id}`) },
        async issueKey() { return { accessKey: 'AKIA-X', secretKey: 'S3CRET-X', permissionId: 'perm-tmp' } },
        async listPermissions() { return [{ id: 'perm-hanamii', displayName: 'koto-myapp-hanamii' }] },
        async dispose() {},
      }
    },
  }
})

vi.mock('../src/renderer/components/CredentialsModal', () => ({
  getHanamiiToken: async () => h.active,
  getHanamiiTokenById: async (id: string) => h.byId.get(id) ?? null,
}))


import { getOps } from '../src/main/projectOps'
import { hanamiiTeardownSpec } from '../src/renderer/teardown/targets/hanamii'
import { HANAMII_DELETION_ACCEPTED_WARNING } from '../src/shared/teardownResult'
import { createRowHarness, tick, until, holdGate, BUCKET, KEY_MISSING, PROJECT_ID, type RowMain, type RowRt } from './hanamiiRowHarness'

const H = createRowHarness(rt as RowRt, h as RowMain)
beforeEach(H.setup)
afterEach(H.cleanup)

// ═══════════════════════════════════════════════════════════════════════════════
// D8: トークン
// ═══════════════════════════════════════════════════════════════════════════════

describe('D8 トークン: 公開したときのトークンだけで呼ぶ。見つからなければ呼ばずに止める', () => {
  it('★★★ 記録の tokenId の登録が見つからない: 確認のあと、HANAMII へ要求0件。入口の案内が結果になる。使用中のトークンでは呼ばない。記録はそのまま', async () => {
    h.byId = new Map() // 公開に使ったトークンが、認証情報から無くなった。使用中の別のトークン（tok-active）はある。
    const m = H.mountRow()
    await H.pressAndConfirm(m)
    await until(() => m.outcomes.length === 1, '結果が届かない')
    expect(h.calls).toEqual([])
    expect(h.auths).toEqual([])
    expect(m.outcomes[0].outcome.view.ok).toBe(false)
    expect(m.outcomes[0].outcome.view.message).toBe(KEY_MISSING)
    expect(H.readMeta().publish.hanamii.projectId).toBe(PROJECT_ID)
    expect(H.win.busy[H.win.busy.length - 1][0]).toBe(false) // 窓を閉じる警告は外れる
    m.unmount()
  })

  it('★★ tokenId が記録に無い旧い記録だけ、使用中のトークンで呼ぶ', async () => {
    H.writeRecord({ projectId: PROJECT_ID, name: 'myapp' })
    const m = H.mountRow()
    await H.pressAndConfirm(m)
    await until(() => m.outcomes.length === 1, '結果が届かない')
    expect(h.auths).toEqual(['Bearer tok-active', ...h.auths.slice(1)])
    expect(m.outcomes[0].outcome.view.state).toBe('done')
    m.unmount()
  })
})


// ═══════════════════════════════════════════════════════════════════════════════
// B-9 ＋ D: 保存場所だけ残った回の印が、main が書く → 記録から読む → 確認の文が言う、までつながる
// ═══════════════════════════════════════════════════════════════════════════════

describe('B-9 ＋ D: 保存場所だけ残った回 → 押し直し', () => {
  it('★★★ 保存場所の一覧が失敗して残った回は、main が印を書き、行も残る。押し直しの確認は「削除済みか見つからない状態でした」で、プロジェクト名を挙げない。全部片づけば行も印も消える', async () => {
    h.listThrows = true
    const m = H.mountRow()
    await H.pressAndConfirm(m)
    await until(() => m.outcomes.length === 1, '1回目の結果が届かない')
    await tick()

    // 1回目: HANAMII のプロジェクトは消えて、保存場所だけ残った。
    const first = m.outcomes[0].outcome.view
    expect(first.state).toBe('failed')
    expect(first.appDeleted).toBe(true)
    expect(first.remaining.map(l => l.label)).toEqual([`保存場所『${BUCKET}』（月額が続きます）`])
    // main が書いた記録: 行も projectId も残り、印が増える。
    const mid = H.readMeta()
    expect(mid.publish.hanamii.projectId).toBe(PROJECT_ID)
    expect(mid.publish.targets.hanamii).toBeTruthy()
    expect(mid.publish.hanamii.storageLeftoverBuckets).toEqual([BUCKET])
    expect(H.win.publishMetaCalls).toEqual([])

    // 2回目: 押し直す。確認は、記録の印を読んで言い分ける。
    h.listThrows = false; h.status = 404; h.calls = []
    const props = await H.pressAndWaitConfirm(m)
    const ps = (props.body as string).split('\n\n')
    expect(ps[1]).toBe(`前回の破棄で、HANAMII のプロジェクトは削除済みか見つからない状態でした。残っている保存場所『${BUCKET}』を削除します。`)
    expect(props.body).not.toContain('次を破棄します')
    expect(props.body).not.toContain("HANAMII のプロジェクト『myapp』")
    expect(props.body).toContain('保存場所にあるデータの削除は元に戻せません')
    props.onConfirm()
    await until(() => m.outcomes.length === 2, '2回目の結果が届かない')
    await tick()

    expect(m.outcomes[1].outcome.view.state).toBe('done')
    expect(h.calls).toContain(`deleteBucket ${BUCKET}`)
    const end = H.readMeta()
    expect(end.publish.hanamii?.projectId ?? null).toBeNull()
    expect(end.publish.hanamii?.storageLeftoverBuckets ?? null).toBeNull()
    expect(end.publish.targets.hanamii).toBeUndefined()
    m.unmount()
  })
})


// ═══════════════════════════════════════════════════════════════════════════════
// E-5: 閉じて開き直す
// ═══════════════════════════════════════════════════════════════════════════════

describe('E-5 閉じて開き直したとき: 記録から結果を出す', () => {
  it('★★★ 画面を閉じている間に終わった破棄（受付済み）: 開き直すと、記録から途中の結果と知らせが1回だけ行の onOutcome に届く。受付済みは extra に写っている', async () => {
    h.status = 202
    // 画面が無い状態で破棄が走って終わる（main は最後まで進める）。
    const rec = await hanamiiTeardownSpec.readRecord(H.dir)
    const direct = await hanamiiTeardownSpec.invoke(H.dir, { token: 'tok-of-recorded' }, { confirmed: true }, rec)
    expect(direct.deletionAccepted).toBe(true)
    expect(getOps(H.dir).last?.seen).toBe(false)

    const m = H.mountRow()
    await tick()
    expect(m.outcomes).toHaveLength(1)
    expect(m.outcomes[0].entry).toBe(m.entry)
    const view = m.outcomes[0].outcome.view
    expect(view.state).toBe('inProgress') // 記録の extra.deletionAccepted から読んだ
    expect(view.message).toBe(HANAMII_DELETION_ACCEPTED_WARNING)
    expect(m.outcomes[0].outcome.notes).toHaveLength(1)
    expect(m.outcomes[0].outcome.notes[0].headline).toMatch(/^🔔 破棄の結果(（.+）)?$/) // T162: 「です」と句点が無い
    expect(m.finished).toEqual([1])
    m.unmount()
  })

  it('★★ 画面を閉じている間に走っている破棄: 開き直した行は「破棄しています…」で押せない。押しても確認も要求も出ない', async () => {
    const g = holdGate(); H.setDeleteGate(g.p)
    const first = H.mountRow()
    await H.pressAndConfirm(first)
    await until(() => h.calls.length === 1, '破棄が走り出さない')
    first.unmount() // 画面を閉じる。破棄は main が最後まで進める。

    const reopened = H.mountRow()
    await until(() => reopened.parts.busy === true, '記録から「走っている」を読み戻せない')
    expect(reopened.parts.button.props.disabled).toBe(true)
    reopened.parts.button.props.onClick()
    await tick()
    expect(reopened.confirm.props.open).toBe(false)
    expect(H.hanamiiCalls()).toHaveLength(1)
    reopened.unmount()
    g.open()
    await tick()
  })
})
