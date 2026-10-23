import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 段階1（1b）: 一覧の HANAMII の行（TeardownRow）を、本物の流れ・本物の main・偽の HANAMII/偽の保存場所に通す（押す → 確認 → 破棄 → 結果）─────
// 設計書: docs/teardown-unify-plan.md の 10.4.9 の E（フックと行）。続きは tests/hanamiiTeardownRowResume.test.ts（トークン・保存場所だけ残った回・開き直し）。
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


import { withProjectLock } from '../src/main/projectLock'
import { getOps } from '../src/main/projectOps'
import { HANAMII_DELETION_ACCEPTED_WARNING } from '../src/shared/teardownResult'
import { createRowHarness, tick, until, holdGate, DELETE_CALL, BUCKET, PROJECT_ID, CLOSE_WARNING_CALL, type RowMain, type RowRt } from './hanamiiRowHarness'

const H = createRowHarness(rt as RowRt, h as RowMain)
beforeEach(H.setup)
afterEach(H.cleanup)

// ═══════════════════════════════════════════════════════════════════════════════
// E-1〜E-4: 押す → 確認 → 実行 → 結果（本物の仕様書・本物の main）
// ═══════════════════════════════════════════════════════════════════════════════

describe('E 行 → 流れ → 本物の main: 押す → 確認 → 破棄 → 結果', () => {
  it('★★★ E-1 やめる: HANAMII へも保存場所へも要求0件。結果も出ず、窓を閉じる警告も立たず、処理の記録も増えない', async () => {
    const m = H.mountRow()
    const props = await H.pressAndWaitConfirm(m)
    expect(props.title).toBe('HANAMII の公開を破棄します')
    expect(props.confirmLabel).toBe('破棄する')
    props.onCancel()
    await tick()
    expect(h.calls).toEqual([])
    expect(m.outcomes).toEqual([])
    expect(m.finished).toEqual([])
    expect(H.win.busy).toEqual([])
    expect(H.win.publishMetaCalls).toEqual([])
    expect(getOps(H.dir).last).toBeNull()
    expect(H.readMeta().publish.hanamii.projectId).toBe(PROJECT_ID) // 記録はそのまま
    m.unmount()
  })

  it('★★★ 確認の文は共通の文の作り手が、記録と保存場所から作る: 名前・保存場所・「元に戻せません」は言い、共用型の URL の文は言わない', async () => {
    const m = H.mountRow()
    const props = await H.pressAndWaitConfirm(m)
    expect(props.body).toContain(`対象のプロジェクト: 『${path.basename(H.dir)}』`) // 先頭はフォルダ名
    expect(props.body).toContain("次を破棄します: HANAMII のプロジェクト『myapp』・保存場所『koto-data-x』にある、このプロジェクトのデータ")
    expect(props.body).toContain('保存場所にあるデータの削除は元に戻せません')
    expect(props.body).toContain('▲ Vercel でも使っているため、そちらで公開中のアプリのデータも消えます') // 記録のほかの公開先（publish.targets の vercel）を名前で言う
    expect(props.body).not.toContain('URL')
    expect(props.body).not.toContain('課金は止まります')
    props.onCancel()
    await tick()
    m.unmount()
  })

  it('★★★ E-2 破棄する（全部片づく回）: HANAMII へ DELETE が1本、保存場所の片づけ、結果が1回。公開の記録を消したのは main で、画面は触れていない', async () => {
    const m = H.mountRow()
    await H.pressAndConfirm(m)
    await until(() => m.outcomes.length === 1, '結果が届かない')
    await tick()

    expect(H.hanamiiCalls()).toEqual([DELETE_CALL])
    expect(h.auths).toEqual(['Bearer tok-of-recorded']) // 公開したときのトークン（tokenId）。使用中のトークンではない
    expect(h.calls).toEqual([
      DELETE_CALL, 'storage connect', `list ${BUCKET}`, `deleteKeys ${BUCKET}`, `deleteBucket ${BUCKET}`, 'deletePermission perm-hanamii',
    ])
    expect(m.outcomes).toHaveLength(1)
    expect(m.outcomes[0].entry).toBe(m.entry)
    expect(m.outcomes[0].outcome.view.state).toBe('done')
    expect(m.outcomes[0].outcome.view.ok).toBe(true)
    expect(m.outcomes[0].outcome.notes).toEqual([])
    // 公開の記録（📡 の行）は main が消した。画面は publishMeta に1回も触れていない。
    const after = H.readMeta()
    expect(after.publish.hanamii?.projectId ?? null).toBeNull()
    expect(after.publish.targets.hanamii).toBeUndefined()
    expect(after.publish.targets.vercel).toBeTruthy() // ほかの公開先は残る
    expect(H.win.publishMetaCalls).toEqual([])
    expect(m.finished).toEqual([1]) // 結果を出したあとで一覧を読み直す
    expect(H.win.dispatched).toContain('sakura-meta-changed')
    m.unmount()
  })

  it('★★★ E-2b 受付済み（HANAMII の応答が 202）: 保存場所にも記録にも触れず、結果は「途中」。押し直すと、削除が済んでいれば先へ進む', async () => {
    h.status = 202
    const m = H.mountRow()
    await H.pressAndConfirm(m)
    await until(() => m.outcomes.length === 1, '結果が届かない')
    await tick()

    expect(h.calls).toEqual([DELETE_CALL]) // 保存場所へは出ない
    const view = m.outcomes[0].outcome.view
    expect(view.state).toBe('inProgress')
    expect(view.ok).toBe(false)
    expect(view.appDeleted).toBe(false)
    expect(view.message).toBe(HANAMII_DELETION_ACCEPTED_WARNING)
    expect(view.inProgress).toEqual([])
    expect(view.remaining).toEqual([])
    const after = H.readMeta()
    expect(after.publish.hanamii.projectId).toBe(PROJECT_ID) // 記録はそのまま（行も残る）
    expect(after.publish.targets.hanamii).toBeTruthy()

    // 押し直す（HANAMII 側の削除が済んで 404）→ 先へ進む
    h.status = 404; h.calls = []
    await H.pressAndConfirm(m)
    await until(() => m.outcomes.length === 2, '押し直しの結果が届かない')
    await tick()
    expect(m.outcomes[1].outcome.view.state).toBe('done')
    expect(h.calls[0]).toBe(DELETE_CALL)
    expect(h.calls).toContain(`deleteBucket ${BUCKET}`)
    expect(H.readMeta().publish.targets.hanamii).toBeUndefined()
    m.unmount()
  })

  it('★★★ E-3 窓を閉じる警告: HANAMII の DELETE が走っている間だけ立つ（名前は「HANAMII の破棄」・PUBLISH_CLOSE_WARNING）。終われば外れる', async () => {
    const g = holdGate(); H.setDeleteGate(g.p)
    const m = H.mountRow()
    await H.pressAndConfirm(m)
    await until(() => h.calls.length === 1, '破棄が走り出さない')

    expect(H.win.busy[0]).toEqual(CLOSE_WARNING_CALL)
    expect(m.parts.busy).toBe(true)
    expect(m.parts.button.props.disabled).toBe(true)
    expect(m.parts.button.props.children).toBe('破棄しています…')
    expect(m.busy).toContain(true) // 一覧へ「実行中」を伝えた

    g.open()
    await until(() => m.outcomes.length === 1, '結果が届かない')
    const last = H.win.busy[H.win.busy.length - 1]
    expect(last[0]).toBe(false)
    expect(last[2]).toBe(false)
    expect(m.busy[m.busy.length - 1]).toBe(false)
    m.unmount()
  })

  it('★★ E-4 二重押し: 確認を待っている間・実行中にもう一度押しても、HANAMII への要求は1本', async () => {
    const g = holdGate(); H.setDeleteGate(g.p)
    const m = H.mountRow()
    m.parts.button.props.onClick()
    m.parts.button.props.onClick() // 確認を待っている最中にもう一度
    await until(() => !!m.confirm?.props?.open, '確認ダイアログが開かない')
    m.confirm.props.onConfirm()
    await until(() => h.calls.length === 1, '破棄が走り出さない')
    m.parts.button.props.onClick() // 実行中にもう一度
    await tick()
    expect(m.confirm.props.open).toBe(false) // 2つ目の確認は開かない
    g.open()
    await until(() => m.outcomes.length === 1, '結果が届かない')
    expect(H.hanamiiCalls()).toEqual([DELETE_CALL])
    expect(m.outcomes).toHaveLength(1)
    m.unmount()
  })

  it('★★ 🗑 の文字と title: 「🗑 破棄」。title は「破棄します」。別の行の破棄が走っている（blocked）あいだは押せない', () => {
    const m = H.mountRow()
    expect(m.parts.button.props.children).toBe('🗑 破棄')
    expect(m.parts.button.props.title).toContain('破棄します')
    expect(m.parts.button.props.disabled).toBe(false)
    m.unmount()
    const blocked = H.mountRow({ blocked: true })
    expect(blocked.parts.button.props.disabled).toBe(true)
    blocked.unmount()
  })

  it('★★ 行が一覧から消えた（アンマウント）とき、実行中の印を必ず下ろす', async () => {
    const g = holdGate(); H.setDeleteGate(g.p)
    const m = H.mountRow()
    await H.pressAndConfirm(m)
    await until(() => m.busy.includes(true), '実行中の印が上がらない')
    m.unmount()
    expect(m.busy[m.busy.length - 1]).toBe(false)
    g.open()
    await tick()
  })

  it('★★ 別の操作（公開など）が走っているあいだ: 🗑 は押せない。title が理由を言う', async () => {
    const g = holdGate()
    const holder = withProjectLock(H.dir, '公開', () => g.p, { target: 'hanamii', handler: 'hanamii:publish', secrets: [] })
    const m = H.mountRow()
    await until(() => m.parts.button.props.disabled === true, '別の操作が走っているのに押せる')
    expect(m.parts.button.props.title).toContain('別の操作')
    g.open(); await holder
    m.unmount()
  })
})


// ═══════════════════════════════════════════════════════════════════════════════
// 記録が読めない・消すものが無い
// ═══════════════════════════════════════════════════════════════════════════════

describe('記録が読めない／消すものが無い: 確認も要求も出さない', () => {
  it('★★ 公開の記録が壊れている: 確認は開かず、要求0件。読めなかった旨の失敗が結果になる', async () => {
    fs.writeFileSync(H.metaFile(), '{ 壊れた JSON', 'utf-8')
    const m = H.mountRow()
    m.parts.button.props.onClick()
    await until(() => m.outcomes.length === 1, '結果が届かない')
    expect(m.confirm.props.open).toBe(false)
    expect(h.calls).toEqual([])
    expect(m.outcomes[0].outcome.view.message).toMatch(/^破棄するものの記録を読めませんでした: /)
    expect(H.win.busy).toEqual([])
    m.unmount()
  })

  it('★★ projectId が記録に無い（幽霊の行）: 確認は開かず、要求0件。管理画面への案内が結果になる', async () => {
    H.writeRecord({ name: 'myapp' })
    const m = H.mountRow()
    m.parts.button.props.onClick()
    await until(() => m.outcomes.length === 1, '結果が届かない')
    expect(m.confirm.props.open).toBe(false)
    expect(h.calls).toEqual([])
    expect(m.outcomes[0].outcome.view.message).toContain('HANAMII の管理画面から削除してください')
    m.unmount()
  })
})
