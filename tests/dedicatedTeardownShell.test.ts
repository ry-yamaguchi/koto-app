import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── 何を固定するか（設計書 docs/teardown-unify-plan.md 10.11.14 の C。0.6.22 段階3B-1）──────────────────
// 専有型の削除 `apprunDedicated:teardown` は、段階3B-1 から共通の骨（cloud/teardownShell.ts）に載った。
// ここは**ソースの文字列を読まず**（掟10「お金・破壊の歯止めは振る舞いで固定する」）、本物の main（ハンドラ・骨・teardownFlow・
// 保存場所の片づけ）に、偽の HTTP サーバ（さくらの専有型 API）と偽の保存場所を当てて、**何が出て・何が出なかったか**を見る。
//
//   C-1 確認の印が無い（false・'true'・1・{} ほか）→ さくらへの要求0本・保存場所への要求0本・**処理の記録が増えない**（V13）
//   C-2 projectDir・認証の形が違う／鍵が埋まっている → 要求0本
//   C-3 公開の記録（📡 の行）: 保存場所まで片づいた回だけ消える（V9）。消し損ねても結果は変わらない
//   C-6 進み具合: renderer へ送る文の列と処理の記録が同じ。段の時間は返り値と記録で同じ値
//   C-7 ゾーン: 段の時間の保存にゾーンが付く（`zoneOf` が undefined になる退行を捕まえる）
// 保存場所の残りの全件（C-4）・鍵の案内（C-5）は 3B-2 で足した（tests/dedicatedTeardownStorageAll.test.ts）。
// 0.6.22 段階3B-7: 400行を超えたので2つに分けた。偽物は tests/dedicatedTeardownShellMocks.ts、下ごしらえは tests/dedicatedTeardownShellHarness.ts。
// C-6・C-7・秘密・import の向きは tests/dedicatedTeardownShell2.test.ts。

vi.mock('electron', async () => (await import('./dedicatedTeardownShellMocks')).electronMock())
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./dedicatedTeardownShellMocks')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/apprunDedicatedApply', async (orig) => (await import('./dedicatedTeardownShellMocks')).applyMock(await orig()))
vi.mock('../src/main/publishMetaFs', async (orig) => (await import('./dedicatedTeardownShellMocks')).publishMetaMock(await orig()))

import { registerApprunDedicatedHandlers } from '../src/main/ipc/apprunDedicated'
import { readApprunDedicatedFs } from '../src/main/publishMetaFs'
import { getOps } from '../src/main/projectOps'
import { withProjectLock, projectBusyMessage } from '../src/main/projectLock'
import { BAD_PROJECT_DIR_MESSAGE } from '../src/main/cloud/teardownShell'
import { shownTeardown } from './shownFromEnv'
import { h } from './dedicatedTeardownShellMocks'
import {
  AUTH, BUCKET, EMPTY_OPS, REFUSED_NOT_CONFIRMED, EVENT, sent, setupEach, teardownEach, startServer, CLUSTER_GONE, LB_ASG_CLUSTER_GONE,
  project, metaText, targetsOf, ROW_AND_VERCEL,
} from './dedicatedTeardownShellHarness'

registerApprunDedicatedHandlers({} as any)
const teardown = shownTeardown(h.handlers.get('apprunDedicated:teardown')!) // 画面の代わりに、確認で見せた保存場所（env.json の記録）を渡す（0.6.24 F。main は見せたものだけを消す）

let dir = ''
beforeEach(() => { dir = setupEach() })
afterEach(() => { teardownEach() })

// ── C-1 確認の印が無い ───────────────────────────────────────────────

const NOT_CONFIRMED_OPTS: ReadonlyArray<readonly [string, unknown]> = [
  ['undefined', undefined], ['null', null], ['true（真偽値そのもの）', true], ['文字列 "true"', 'true'], ['数 1', 1],
  ['空配列', []], ['空オブジェクト', {}], ['confirmed: false', { confirmed: false }],
  ['confirmed: "true"', { confirmed: 'true' }], ['confirmed: 1', { confirmed: 1 }], ['confirmed: "yes"', { confirmed: 'yes' }],
  ['confirmed: {}', { confirmed: {} }], ['confirmed: undefined', { confirmed: undefined }], ['confirmed: null', { confirmed: null }],
]

describe('C-1 確認の印が無い: さくらへも保存場所へも1本も出ない。処理の記録も増えない（V13）', () => {
  it.each(NOT_CONFIRMED_OPTS)('opts が %s → 断る。さくらへの要求0本・保存場所への要求0本・処理の記録なし・記録（📡 の行・資源の記録）はそのまま', async (_label, opts) => {
    project({ storage: true })
    const before = metaText()
    const calls = await startServer(LB_ASG_CLUSTER_GONE)

    const r = await teardown(EVENT, dir, AUTH, opts)

    expect(r).toEqual(REFUSED_NOT_CONFIRMED)
    expect(calls).toEqual([])
    expect(h.storageCalls).toEqual([])
    expect(sent).toEqual([])
    // 直す前（鍵を取ってから teardownFlow の中で断っていた）は、ここに「削除」の記録が1件できていた
    expect(getOps(dir)).toEqual(EMPTY_OPS)
    expect(metaText()).toBe(before)
  })

  it('対照: 同じプロジェクトでも、確認の印が true なら要求が出る（上の断りは印のせいである）', async () => {
    project({ storage: true })
    const calls = await startServer(CLUSTER_GONE)

    const r = await teardown(EVENT, dir, AUTH, { confirmed: true })

    expect(r.ok).toBe(true)
    expect(calls).toEqual(['DELETE /clusters/c1', 'GET /clusters?maxItems=20'])
    expect(h.storageCalls.length).toBeGreaterThan(0)
    expect(getOps(dir).last?.handler).toBe('apprunDedicated:teardown')
  })

  it('順序: 確認の印が無ければ、キーが空でも「確認ダイアログを通っていません」で断る（印は鍵より前・認証より前）。projectDir が不正ならそちらが先', async () => {
    project()
    const calls = await startServer(LB_ASG_CLUSTER_GONE)

    expect(await teardown(EVENT, dir, undefined, undefined)).toEqual(REFUSED_NOT_CONFIRMED)
    expect(await teardown(EVENT, dir, { token: '', secret: '' }, {})).toEqual(REFUSED_NOT_CONFIRMED)
    expect(await teardown(EVENT, '', AUTH, undefined)).toEqual({ ok: false, executed: [], message: BAD_PROJECT_DIR_MESSAGE, remaining: {} })
    expect(calls).toEqual([])
    expect(getOps(dir)).toEqual(EMPTY_OPS)
  })
})

// ── C-2 projectDir・認証の形・鍵 ─────────────────────────────────────

describe('C-2 projectDir・認証の形が違う・鍵が埋まっている: 要求0本', () => {
  const KEY_MISSING = 'クラウドのAPIキーが未登録です'

  it.each([['空文字', ''], ['undefined', undefined], ['null', null], ['数', 123], ['オブジェクト', {}], ['配列', ['/tmp']]] as const)(
    'projectDir が %s → 断る（さくらへ0本・保存場所へ0本）',
    async (_label, bad) => {
      const calls = await startServer(LB_ASG_CLUSTER_GONE)
      const r = await teardown(EVENT, bad, AUTH, { confirmed: true })
      expect(r).toEqual({ ok: false, executed: [], message: BAD_PROJECT_DIR_MESSAGE, remaining: {} })
      expect(calls).toEqual([])
      expect(h.storageCalls).toEqual([])
    },
  )

  it.each([
    ['undefined', undefined], ['null', null], ['空オブジェクト', {}], ['token だけ', { token: 'a' }], ['secret だけ', { secret: 'b' }],
    ['token が空', { token: '', secret: 'b' }], ['secret が空', { token: 'a', secret: '' }], ['token が数', { token: 1, secret: 'b' }],
    ['文字列', 'x'], ['配列', []],
  ] as const)('認証が %s → 「キーが未登録」で断る。さくらへ0本・保存場所へ0本・処理の記録なし', async (_label, auth) => {
    project({ storage: true })
    const calls = await startServer(LB_ASG_CLUSTER_GONE)

    const r = await teardown(EVENT, dir, auth, { confirmed: true })

    expect(r).toEqual({ ok: false, executed: [], message: KEY_MISSING, remaining: {} })
    expect(calls).toEqual([])
    expect(h.storageCalls).toEqual([])
    expect(getOps(dir)).toEqual(EMPTY_OPS)
    expect(targetsOf()).toEqual(ROW_AND_VERCEL)
  })

  it('★ 同じプロジェクトで別の操作が走っている（鍵が埋まっている）: 断る。さくらへ0本・保存場所へ0本・行も資源の記録も触れない', async () => {
    project({ storage: true })
    const before = metaText()
    const calls = await startServer(LB_ASG_CLUSTER_GONE)
    let open!: () => void
    const gate = new Promise<void>(r => { open = r })
    const holder = withProjectLock(dir, '公開', () => gate, { target: 'sakura-apprun-dedicated', handler: 'test:hold' })

    const r = await teardown(EVENT, dir, AUTH, { confirmed: true })
    open()
    await holder

    expect(r).toEqual({ ok: false, executed: [], message: projectBusyMessage('公開', 'sakura-apprun-dedicated'), remaining: {} })
    expect(calls).toEqual([])
    expect(h.storageCalls).toEqual([])
    expect(metaText()).toBe(before)
  })
})

// ── C-3 公開の記録（📡 の行）─────────────────────────────────────────

describe('C-3 公開の記録（📡 の行）: 保存場所まで片づいた回だけ消す（D1=1・V9）', () => {
  it('全部消えた → 行が消える（ほかの公開先の行は残る）', async () => {
    project()
    await startServer(CLUSTER_GONE)
    const r = await teardown(EVENT, dir, AUTH, { confirmed: true })
    expect(r.ok).toBe(true)
    expect(targetsOf()).toEqual(['vercel'])
    expect(JSON.parse(metaText()).publish.targets.vercel.url).toBe('https://myapp.vercel.app/')
  })

  it('★★ 保存場所だけ失敗（appDeleted:true・ok:false）→ 行が残る（V9）→ 押し直して片づく → 消える', async () => {
    project({ storage: true })
    h.listThrows = true
    await startServer(CLUSTER_GONE)

    const first = await teardown(EVENT, dir, AUTH, { confirmed: true })
    expect(first.ok).toBe(false)
    expect(first.appDeleted).toBe(true)
    expect(first.remaining.storageBucket).toBe(BUCKET)
    expect(targetsOf(), '直す前: アプリが消えた時点で行が外れていた').toEqual(ROW_AND_VERCEL)
    expect(readApprunDedicatedFs(dir).storageLeftoverBucket).toBe(BUCKET) // 押し直しの印

    h.listThrows = false
    h.storageCalls = []
    const again = await teardown(EVENT, dir, AUTH, { confirmed: true })
    expect(again.ok).toBe(true)
    expect(h.deletedBuckets).toEqual([BUCKET])
    expect(targetsOf()).toEqual(['vercel'])
    expect(readApprunDedicatedFs(dir).storageLeftoverBucket).toBeFalsy()
  })

  it('★ アプリ・クラスタの削除に失敗 → 行は残る。保存場所には触れない', async () => {
    project({ storage: true })
    const calls = await startServer({ 'DELETE /clusters/c1': { status: 500, body: { error: 'boom' } } })

    const r = await teardown(EVENT, dir, AUTH, { confirmed: true })

    expect(r.ok).toBe(false)
    expect(calls).toContain('DELETE /clusters/c1')
    expect(h.storageCalls).toEqual([])
    expect(targetsOf()).toEqual(ROW_AND_VERCEL)
  })

  it('★ 専有型の行が無かった → 触れない（行を作りも、ほかの公開先を消しもしない）', async () => {
    project({ row: false })
    await startServer(CLUSTER_GONE)
    const r = await teardown(EVENT, dir, AUTH, { confirmed: true })
    expect(r.ok).toBe(true)
    expect(targetsOf()).toEqual(['vercel'])
    expect(JSON.parse(metaText()).publish.targets.vercel.url).toBe('https://myapp.vercel.app/')
  })

  it.each([
    ['書けなかった（ok:false を返す）', () => ({ ok: false, message: '書き込めません（テスト）' }), '書き込めません（テスト）'],
    ['例外を投げる', () => { throw new Error('壊れています（テスト）') }, '壊れています（テスト）'],
  ] as const)('★ 消し損ね（%s）→ ⚠️ の1行を足す。ok と ほかの結果は変えない', async (_label, forget, why) => {
    project()
    h.forget = forget
    await startServer(CLUSTER_GONE)

    const r = await teardown(EVENT, dir, AUTH, { confirmed: true })

    expect(r.ok).toBe(true)
    const warn = r.executed.filter((l: string) => l.startsWith('⚠️ 公開の記録を削除できませんでした'))
    expect(warn).toHaveLength(1)
    expect(warn[0]).toContain(why)
    expect(r.executed.some((l: string) => l.includes('c1'))).toBe(true) // 消したものの行は残っている
    expect(targetsOf()).toEqual(ROW_AND_VERCEL) // 消せなかったので、行はそのまま
  })
})
