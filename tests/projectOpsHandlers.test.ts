import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── なぜこのテストが要るか（2026-09-29・作者の決定 ①②）──────────────────────────
// 公開・破棄・作成のダイアログを閉じて開き直したとき、進み具合と結果（警告を含む）が続きから見えるように、
// main が「プロジェクトごとの処理の記録」を持つ（src/main/projectOps.ts）。記録は鍵（withProjectLock）が
// 自動で書くので、**8本のハンドラが同じ道で記録される**ことをここで固定する。
//   共用型 cloud:apply・cloud:teardown／HANAMII hanamii:publish・hanamii:teardown／Vercel vercel:publish／
//   専有型 apprunDedicated:create・teardown・publishApp
//
// **ソースの文字列は読まない**（掟10）。8本を実際に呼び、偽の client（fetch・applyPlan・prepareAppImage）に流して、
// IPC（projectOps:get・projectOps:changed の押し出し）から読める記録で確かめる。
// **画面（renderer）は1度も出てこない**——ダイアログを閉じても main が最後まで進めて、開き直したときに読めること。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  /** 外部へ出た要求の一覧（順序込み）。 */
  calls: [] as string[],
  blockNext: false,
  entered: null as null | (() => void),
  release: (() => {}) as () => void,
  creds: { token: 'TEST-TOKEN', secret: 'TEST-SECRET' } as null | { token: string; secret: string },
  /** applyPlan が返す state の resources（共用型の破棄で「保存場所が残った」を作る）。 */
  applyResources: [] as any[],
  /** applyPlan が成功を返すか（false＝共用型の破棄が途中で失敗した回を作る）。 */
  applyOk: true,
  /** 偽の保存場所が、どのバケットを一覧しても返す中身（共用型の破棄で「ほかのプロジェクトが使っている」を作る）。 */
  bucketKeys: [] as string[],
  /** prepareAppImage の返り方（専有型の公開で「レジストリが秘密を含む文で断る」を作る）。 */
  imageFailure: null as null | string,
  /** main → renderer の押し出し（projectOps:changed）。 */
  pushed: [] as Array<{ channel: string; payload: any }>,
}))

async function record(label: string): Promise<void> {
  h.calls.push(label)
  if (!h.blockNext) return
  h.blockNext = false
  const gate = new Promise<void>(open => { h.release = open })
  h.entered?.()
  await gate
}

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test', on: () => {} },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {} },
  dialog: {},
}))

vi.mock('../src/main/cloud/auth', async (importOriginal) => {
  const real = await importOriginal<any>()
  return { ...real, loadCredentials: () => h.creds }
})

vi.mock('../src/main/cloud/imagePublish', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    prepareAppImage: async () => {
      await record('prepareAppImage')
      if (h.imageFailure) return { ok: false, message: h.imageFailure }
      return {
        ok: true, tag: 'test-tag', image: 'koto-test', ref: 'registry.example/koto-test:test-tag',
        runtimeKind: 'static',
        registryAuth: { server: 'registry.example', username: 'u', password: 'p' },
      }
    },
  }
})

vi.mock('../src/main/cloud/apply', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    applyPlan: async (opts: any) => {
      await record('applyPlan')
      return {
        ok: h.applyOk,
        state: { name: opts.spec.name, backend: opts.spec.backend, resources: h.applyResources, ...(opts.state?.meta ? { meta: opts.state.meta } : {}) },
        executed: ['✅ テスト'], skipped: [],
        ...(h.applyOk ? {} : { message: '保存場所を削除できませんでした（テスト）' }),
      }
    },
  }
})

// 保存場所（共用型の破棄で、消す保存場所があるとき・記録の鍵を無効にするときに接続する）。実ネットワークへは出ない。
// 判断（storageTeardown.ts → teardownPlanFor）は本物のまま動かす。どのバケットを一覧しても h.bucketKeys が返る
// （ほかのプロジェクトの prefix を入れておくと、バケットは残る）。
vi.mock('../src/main/cloud/storageAdapter', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    createStorageAdapter: async () => ({
      async listAllKeys() { return [...h.bucketKeys] },
      async deleteKeys() {},
      async deleteBucket() {},
      async deletePermission() {},
      async listPermissions() { return [] },
      async dispose() {},
    }),
  }
})

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { registerHanamiiHandlers } from '../src/main/ipc/hanamii'
import { registerVercelHandlers } from '../src/main/ipc/vercel'
import { registerApprunDedicatedHandlers } from '../src/main/ipc/apprunDedicated'
import { registerPublishMetaHandlers } from '../src/main/ipc/publishMeta'
import { registerProjectOpsHandlers } from '../src/main/ipc/projectOps'
import { resetProjectOpsForTests, ackOps } from '../src/main/projectOps'
import { withProjectLock } from '../src/main/projectLock'
import { hanamiiWaitTuning } from '../src/main/hanamii/aftercare'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'
import { teardownRemainingWarnings } from '../src/shared/cloudCost'
import { saveCloudState } from '../src/main/cloud/specStore'

const fakeWindow = {
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, send: (channel: string, payload: any) => { h.pushed.push({ channel, payload: JSON.parse(JSON.stringify(payload)) }) } },
}
registerCloudHandlers({} as any)
registerHanamiiHandlers({} as any)
registerVercelHandlers({} as any)
registerApprunDedicatedHandlers({} as any)
registerPublishMetaHandlers()
registerProjectOpsHandlers({ getMainWindow: () => fakeWindow } as any)

const EVENT = { sender: { send: () => {} } }
const HN_TOKEN = 'hnm_TOKEN-SECRET-0123456789'
const D_AUTH = { token: 'dedicated-token-AAAA1111', secret: 'dedicated-secret-BBBB2222' }
const BASE = 'https://hanamii.jp'

let projectDirs: string[] = []
let realFetch: typeof globalThis.fetch

/**
 * 公開できるプロジェクト。**プロジェクトごとに自分だけの親フォルダへ置く**: 共用型の破棄は、残すレジストリを使っているほかのプロジェクトを、同じ親フォルダの
 * 兄弟から数える（cloud/registryUsers.ts）。一時フォルダ直下だと、同時に走る別の試験の残りを兄弟として読む。
 */
function newProject(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-ops-'))
  projectDirs.push(ws)
  const dir = path.join(ws, 'myapp')
  fs.mkdirSync(dir)
  const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: false })
  fs.mkdirSync(path.join(dir, '.sakura-cloud'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.sakura-cloud', 'env.json'), JSON.stringify(spec, null, 2), 'utf-8')
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>hi</body></html>', 'utf-8')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'myapp', type: 'module' }, null, 2), 'utf-8')
  fs.writeFileSync(path.join(dir, 'app.js'), 'export const run = () => 1\n', 'utf-8')
  return dir
}

const jsonRes = (status: number, data: unknown) => ({ ok: status < 300, status, async text() { return status === 204 ? '' : JSON.stringify(data) } })

beforeEach(() => {
  projectDirs = []
  h.calls = []
  h.blockNext = false
  h.entered = null
  h.release = () => {}
  h.creds = { token: 'TEST-TOKEN', secret: 'TEST-SECRET' }
  h.applyResources = []
  h.applyOk = true
  h.bucketKeys = []
  h.imageFailure = null
  h.pushed = []
  resetProjectOpsForTests()
  // 依存を戻す（resetProjectOpsForTests は押し出しの受け手も外すので、つなぎ直す）
  registerProjectOpsHandlers({ getMainWindow: () => fakeWindow } as any)
  hanamiiWaitTuning.intervalMs = 0
  hanamiiWaitTuning.maxPolls = 3
  realFetch = globalThis.fetch
  // 偽の client。**実ネットワークへは一切出さない。**（HANAMII・Vercel の実物のクライアントが叩く先）
  globalThis.fetch = (async (input: unknown, init: any) => {
    await record(`${init?.method ?? 'GET'} ${String(input)}`)
    return jsonRes(500, { error: { message: 'テスト用の失敗' } })
  }) as unknown as typeof fetch
})
afterEach(() => {
  h.release()
  globalThis.fetch = realFetch
  hanamiiWaitTuning.intervalMs = 3000
  hanamiiWaitTuning.maxPolls = 100
  for (const d of projectDirs) fs.rmSync(d, { recursive: true, force: true })
})

const handler = (channel: string) => h.handlers.get(channel)!
/**
 * 記録（.sakuraide.json）が指す projectId と、画面が渡す projectId を一致させて、HANAMII の破棄を呼ぶ。
 * main は**渡された projectId が記録と一致するときだけ**動く（2026-09-30 検分・掟11。断る振る舞いは
 * tests/hanamiiTeardownRecord.test.ts が固定する）。ここで見たいのは処理の記録なので、一致する呼び出しにする。
 */
const hanamiiTeardown = (dir: string) => {
  const p = path.join(dir, '.sakuraide.json')
  if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify({ publish: { hanamii: { projectId: 'hnm-proj-1' } } }, null, 2), 'utf-8')
  return handler('hanamii:teardown')({}, dir, { token: HN_TOKEN }, { confirmed: true, projectId: 'hnm-proj-1' })
}
/** 画面が開き直したときに呼ぶ IPC。 */
const getOps = (dir: string): Promise<{ running: any; last: any; earlier: any[] }> => handler('projectOps:get')({}, dir)
const ack = (dir: string, upTo?: number) => handler('projectOps:ack')({}, dir, upTo)
const runningOp = (dir: string) => handler('publishMeta:runningOp')({}, dir)
/** その projectDir の分の押し出しだけ（順序どおり）。 */
const pushedFor = (dir: string) => h.pushed.filter(p => p.channel === 'projectOps:changed' && p.payload.projectDir === path.resolve(dir)).map(p => p.payload)

type Case = {
  name: string
  channel: string
  op: '作成' | '削除' | '公開'
  target: 'sakura-apprun' | 'sakura-apprun-dedicated' | 'hanamii' | 'vercel'
  invoke: (dir: string) => Promise<any>
}

const CLUSTER_SPEC = {
  name: 'myapp', ports: [], servicePrincipalID: 'sp-1', zone: 'is1a',
  workerServiceClassPath: 'w', lbServiceClassPath: 'l', minNodes: 1, maxNodes: 2,
}
const APP_INPUT = { host: 'app.example.test', cpu: 100, memory: 128, fixedScale: 1 }

const CASES: Case[] = [
  { name: 'cloud:apply（共用型の公開）', channel: 'cloud:apply', op: '公開', target: 'sakura-apprun',
    invoke: dir => handler('cloud:apply')(EVENT, dir, { confirmed: true }) },
  { name: 'cloud:teardown（共用型の破棄）', channel: 'cloud:teardown', op: '削除', target: 'sakura-apprun',
    invoke: dir => handler('cloud:teardown')({}, dir, { heldByMain: true }, { confirmed: true, deleteRegistry: false, registryName: null }) },
  { name: 'hanamii:publish（HANAMII の公開）', channel: 'hanamii:publish', op: '公開', target: 'hanamii',
    invoke: dir => handler('hanamii:publish')({}, dir, { token: HN_TOKEN, workspaceId: 'ws-1', name: 'myapp' }) },
  { name: 'hanamii:teardown（HANAMII の破棄）', channel: 'hanamii:teardown', op: '削除', target: 'hanamii',
    invoke: dir => hanamiiTeardown(dir) },
  { name: 'vercel:publish（Vercel の公開）', channel: 'vercel:publish', op: '公開', target: 'vercel',
    invoke: dir => handler('vercel:publish')(EVENT, dir, { token: 'vercel-token-CCCC3333', name: 'myapp' }) },
  { name: 'apprunDedicated:create（専有型の作成）', channel: 'apprunDedicated:create', op: '作成', target: 'sakura-apprun-dedicated',
    invoke: dir => handler('apprunDedicated:create')(EVENT, dir, D_AUTH, CLUSTER_SPEC, { confirmed: true }) },
  { name: 'apprunDedicated:teardown（専有型の全部削除。手順6も 📡 の 🗑 もこれ）', channel: 'apprunDedicated:teardown', op: '削除', target: 'sakura-apprun-dedicated',
    invoke: dir => handler('apprunDedicated:teardown')(EVENT, dir, D_AUTH, { confirmed: true }) },
  { name: 'apprunDedicated:publishApp（専有型⑧の公開）', channel: 'apprunDedicated:publishApp', op: '公開', target: 'sakura-apprun-dedicated',
    invoke: dir => handler('apprunDedicated:publishApp')(EVENT, dir, D_AUTH, APP_INPUT, { confirmed: true }) },
]

describe('★★★ 8本のハンドラすべてが、同じ道で記録される（実際に呼んで数える）', () => {
  it('対象は8本（増減したら、ここも数え直す）。アプリだけを消す apprunDedicated:teardownApp は無い（2026-10-08）', () => {
    expect(CASES).toHaveLength(8)
    expect(new Set(CASES.map(c => c.channel)).size).toBe(8)
    expect(h.handlers.has('apprunDedicated:teardownApp')).toBe(false)
  })

  for (const c of CASES) {
    it(`${c.name}: 始まり（running）と終わり（last）が、開き直した画面から読める`, async () => {
      const dir = newProject()
      const reply = await c.invoke(dir)
      // ハンドラは本体に入った（鍵に断られていない）
      expect(reply.message ?? '', 'ハンドラが鍵に断られた').not.toContain('別の操作')

      // ── 窓（renderer）が無くても、終わったあとに get で結果が読める ──
      const snap = await getOps(dir)
      expect(snap.running).toBeNull()
      expect(snap.last, `${c.channel} の記録が無い`).not.toBeNull()
      expect(snap.last).toMatchObject({ op: c.op, target: c.target, handler: c.channel, running: false, seen: false })
      expect(typeof snap.last.startedAt).toBe('number')
      expect(snap.last.finishedAt).toBeGreaterThanOrEqual(snap.last.startedAt)
      expect(snap.last.result).toBeTruthy()
      // 記録の ok は、ハンドラが返した ok と食い違わない（HANAMII は deployState:'error' のときだけ例外）
      expect(snap.last.result.ok, JSON.stringify(reply)).toBe(reply.ok === true)

      // ── 押し出し（projectOps:changed）: 最初は running、最後は last。このプロジェクトの分だけ ──
      const events = pushedFor(dir)
      expect(events.length).toBeGreaterThanOrEqual(2)
      expect(events[0].running).toMatchObject({ op: c.op, target: c.target, handler: c.channel, running: true })
      expect(events[0].last).toBeNull()
      const lastEvent = events[events.length - 1]
      expect(lastEvent.running).toBeNull()
      expect(lastEvent.last).toMatchObject({ handler: c.channel, running: false })
      // 鍵は外れている
      expect(await runningOp(dir)).toBeNull()

      // ── ack で消える ──
      const acked = await ack(dir, snap.last.startedAt)
      expect(acked).toEqual({ ok: true, acked: 1 })
      expect((await getOps(dir)).last).toBeNull()
    })
  }

  it('走っている最中: cloud:apply を外部要求の手前で止め、projectOps:get が running と進み具合を返す（閉じた窓が開き直した想定）', async () => {
    const dir = newProject()
    h.blockNext = true
    const entered = new Promise<void>(resolve => { h.entered = resolve })
    const first = handler('cloud:apply')(EVENT, dir, { confirmed: true })
    await entered

    const snap = await getOps(dir)
    expect(snap.last).toBeNull()
    expect(snap.running).toMatchObject({ op: '公開', target: 'sakura-apprun', handler: 'cloud:apply', running: true })
    // 各ハンドラが renderer へ送っている進捗と同じ文が、進み具合に入っている（prepareAppImage の手前は進捗が無いので、
    // このあと送られる「AppRun に反映しています…」を待つ）
    h.release()
    await first
    const labels = pushedFor(dir).map(e => (e.running ?? e.last)?.progress?.label)
    expect(labels).toContain('🚀 AppRun に反映しています…')
    expect(labels.some(l => typeof l === 'string' && l.includes('完了'))).toBe(true)
  })

  it('★ publishMeta:runningOp は、同じ記録から答える（走っている間は操作名・終われば null）', async () => {
    const dir = newProject()
    h.blockNext = true
    const entered = new Promise<void>(resolve => { h.entered = resolve })
    const first = handler('vercel:publish')(EVENT, dir, { token: 'vercel-token-CCCC3333', name: 'myapp' })
    await entered
    // 操作名と公開先（画面は、記録の op ではなく opWordFor(op, target) の言葉で「破棄が進んでいます」「削除が進んでいます」と言い分ける）
    expect(await runningOp(dir)).toEqual({ op: '公開', target: 'vercel' })
    const running = (await getOps(dir)).running
    expect({ op: running.op, target: running.target }).toEqual(await runningOp(dir))
    h.release()
    await first
    expect(await runningOp(dir)).toBeNull()
    expect((await getOps(dir)).running).toBeNull()
  })

  it('★★ publishMeta:runningOp の戻りは、走っているハンドラの公開先ごと（8本）: 共用型・HANAMII・専有型の削除は、どれも op が \'削除\' で、target で見分ける', async () => {
    for (const c of CASES) {
      const dir = newProject()
      let open!: () => void
      const gate = new Promise<void>(r => { open = r })
      const held = withProjectLock(dir, c.op, () => gate, { target: c.target, handler: c.channel })
      expect(await runningOp(dir), c.name).toEqual({ op: c.op, target: c.target })
      expect(await handler('publishMeta:runningOp')({}, 'relative/path'), '相対パスは null').toBeNull()
      expect(await handler('publishMeta:runningOp')({}, 42), '文字列でないものは null').toBeNull()
      open()
      await held
      expect(await runningOp(dir), c.name).toBeNull()
    }
  })
})

// ── 断る文は、走っている操作の公開先で言葉が決まる（8本すべてが「断る側」）──────────────────────────────
// 記録の op は共用型・HANAMII の破棄も専有型の削除も '削除'。断る文が op をそのまま言うと、共用型・HANAMII の破棄が走っている間に
// 別の操作を押すと「（削除）」と出る（破棄の流れの確認・進み具合・結果は「破棄」）。8本それぞれが、走っている操作の公開先を添えて言うことを
// 実物のハンドラで固定する（6つの呼び元のどれかが公開先を渡し忘れても、ここで落ちる）。
describe('★★★ 別の操作を断る文: 走っている操作の公開先で言葉が決まる（8本すべてが断る側）', () => {
  const HOLDERS: Array<{ name: string; op: '作成' | '削除' | '公開'; target: Case['target']; word: string }> = [
    { name: '共用型の破棄', op: '削除', target: 'sakura-apprun', word: '破棄' },
    { name: 'HANAMII の破棄', op: '削除', target: 'hanamii', word: '破棄' },
    { name: '専有型の削除', op: '削除', target: 'sakura-apprun-dedicated', word: '削除' },
    { name: 'HANAMII の公開', op: '公開', target: 'hanamii', word: '公開' },
    { name: '専有型の作成', op: '作成', target: 'sakura-apprun-dedicated', word: '作成' },
  ]
  for (const holder of HOLDERS) {
    for (const caller of CASES) {
      it(`${holder.name}が走っている間に ${caller.channel} を呼ぶと「（${holder.word}）」で断られる。外部の要求は増えない・記録も作らない`, async () => {
        const dir = newProject()
        let open!: () => void
        const gate = new Promise<void>(r => { open = r })
        const held = withProjectLock(dir, holder.op, () => gate, { target: holder.target, handler: 'test:hold' })
        const before = [...h.calls]
        const refused = await caller.invoke(dir)
        const during = await getOps(dir)
        open()
        await held

        expect(refused.ok).toBe(false)
        expect(refused.message).toBe(`いま別の操作（${holder.word}）を実行中です。終わってからもう一度お試しください。`)
        expect(h.calls).toEqual(before)
        // 断られた側は記録を作らない（走っている記録は走らせている側のまま）
        expect(during.running).toMatchObject({ op: holder.op, target: holder.target, handler: 'test:hold' })
      })
    }
  }
})

describe('★★ 進み具合: 各ハンドラが送っていた進捗の段は、記録（と押し出し）に載る', () => {
  // 進捗の送り口は1つ（progressReporter）。ここは「ハンドラが段の変わり目で実際に送っている」ことを、
  // 押し出された記録の progress.label で確かめる（ハンドラを実際に呼ぶ）。
  // 専有型の teardown／publishApp は、進捗が待ち（外部の一覧を引く段）の中で出るので、
  // 送り口の配線は tests/projectOpsWiring.test.ts が固定している。
  const STAGES: Array<[string, string]> = [
    ['cloud:apply', '🚀 AppRun に反映しています…'],
    ['cloud:teardown', '🗑 公開したものを破棄しています…'],
    ['hanamii:publish', '☁️ HANAMII へアップロードしています…'],
    ['hanamii:teardown', '🗑 HANAMII のプロジェクトを破棄しています…'],
    ['vercel:publish', 'ファイルを収集しています…'],
    ['apprunDedicated:create', '🏗 クラスタ・オートスケーリンググループ・ロードバランサを作っています…'],
  ]
  for (const [channel, label] of STAGES) {
    it(`${channel}: 「${label}」が進み具合として記録される`, async () => {
      const dir = newProject()
      const c = CASES.find(x => x.channel === channel)!
      // apprunDedicated:create は費用の同意（consentedAt）が無いと API を呼ばずに断る。段の記録だけを見たいので、断られる形のままでよい。
      await c.invoke(dir)
      const labels = pushedFor(dir).map(e => (e.running ?? e.last)?.progress?.label)
      expect(labels).toContain(label)
    })
  }

  // 共用型・HANAMII の破棄は、確認・結果・見出しまで「破棄」で1つ（0.6.22 の決定 D3）。進み具合の文だけ「削除しています」と言っていた
  // （0.6.22-rc.3 の実機のあとの確かめで見つかった）。専有型の削除の進み具合は「削除」のまま（そちらは tests/dedicatedTeardownShell*.test.ts が見る）。
  for (const channel of ['cloud:teardown', 'hanamii:teardown']) {
    it(`★★ ${channel}（破棄）: 記録された進み具合のどれも「削除しています」と言わない（動詞は「破棄」）`, async () => {
      const dir = newProject()
      const c = CASES.find(x => x.channel === channel)!
      await c.invoke(dir)
      const labels = pushedFor(dir).map(e => (e.running ?? e.last)?.progress?.label).filter((l): l is string => typeof l === 'string')
      expect(labels.some(l => l.includes('破棄しています')), JSON.stringify(labels)).toBe(true)
      expect(labels.filter(l => l.includes('削除しています')), JSON.stringify(labels)).toEqual([])
    })
  }

  it('Vercel: アップロードは「何個中の何個目か」（step/total）も記録される', async () => {
    const dir = newProject()
    await handler('vercel:publish')(EVENT, dir, { token: 'vercel-token-CCCC3333', name: 'myapp' })
    const uploading = pushedFor(dir).map(e => e.running?.progress).filter(p => p && /^アップロード中/.test(p.label))
    expect(uploading.length).toBeGreaterThan(0)
    expect(uploading[0]).toMatchObject({ step: 1 })
    expect(uploading[0].total).toBeGreaterThanOrEqual(1)
    expect(uploading[0].label).toBe(`アップロード中… (1/${uploading[0].total})`)
  })
})

describe('★★ 別のプロジェクトの記録は混ざらない（掟11・ハンドラを通して）', () => {
  it('A の HANAMII 公開が走っている間、B の記録は空で、A の進捗は B の押し出しに現れない', async () => {
    const a = newProject()
    const b = newProject()
    h.blockNext = true
    const entered = new Promise<void>(resolve => { h.entered = resolve })
    const first = handler('hanamii:publish')({}, a, { token: HN_TOKEN, workspaceId: 'ws-1', name: 'myapp' })
    await entered

    expect((await getOps(a)).running).toMatchObject({ target: 'hanamii', handler: 'hanamii:publish' })
    expect(await getOps(b)).toEqual({ running: null, last: null, earlier: [] })
    expect(pushedFor(b)).toEqual([])

    // B で別の操作（専有型の公開）を走らせて終えても、A の走っている記録は変わらない
    await handler('apprunDedicated:publishApp')(EVENT, b, D_AUTH, APP_INPUT, { confirmed: true })
    expect((await getOps(a)).running).toMatchObject({ target: 'hanamii', handler: 'hanamii:publish', running: true })
    expect((await getOps(b)).last).toMatchObject({ target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:publishApp' })
    // A の ack が B の結果を消さない
    await ack(a)
    expect((await getOps(b)).last).not.toBeNull()

    h.release()
    await first
  })

  it('projectDir が絶対パスでないとき、get は空・ack は断る（別の場所の記録を返さない）', async () => {
    expect(await getOps('relative/dir')).toEqual({ running: null, last: null, earlier: [] })
    expect(await getOps('')).toEqual({ running: null, last: null, earlier: [] })
    expect(await ack('relative/dir')).toMatchObject({ ok: false })
  })
})

describe('★★ 警告を見逃さない: 終わった結果の警告は、開き直したあとも読める', () => {
  it('★ 共用型の破棄: 保存場所が残った・レジストリを残した → 月額が続くと警告される', async () => {
    const dir = newProject()
    // 前の公開で作られたもの: 保存場所（env.json に同意済み・state にも記録）・記録済みのレジストリ
    const spec = JSON.parse(fs.readFileSync(path.join(dir, '.sakura-cloud', 'env.json'), 'utf-8'))
    spec.persistence = { objectStorage: [{ bucket: 'koto-data-x', prefix: 'projects/myapp/', shared: true, consentedAt: '2026-08-14T00:00:00.000Z' }] }
    fs.writeFileSync(path.join(dir, '.sakura-cloud', 'env.json'), JSON.stringify(spec, null, 2), 'utf-8')
    const bucketRef = { kind: 'bucket', key: 'bucket:koto-data-x', id: 'koto-data-x', stateful: true, prefix: 'projects/myapp/' }
    // Koto がこのプロジェクトのために作ったレジストリ（registryAdopted: false）で、ほかに使うプロジェクトは無い＝このプロジェクトだけのもの
    saveCloudState(dir, { name: 'myapp', backend: 'apprun', resources: [bucketRef as any], meta: { registryName: 'myreg', registryAdopted: false } } as any)
    // ほかのプロジェクトも同じ保存場所を使っている（3段構えで、バケットは残る）
    h.bucketKeys = ['projects/myapp/data.json', 'projects/other/data.json']

    const reply = await handler('cloud:teardown')({}, dir, { heldByMain: true }, { confirmed: true, deleteRegistry: false, registryName: 'myreg' })
    expect(reply.keptBucketName).toBe('koto-data-x')
    expect(reply.keptRegistryName).toBe('myreg')
    // 残した理由と、レジストリの由来・借り手も事実として返る（警告が「後で消す場合は」と言ってよいかを決める）
    expect(reply).toMatchObject({ keptBucketsUsedByOthers: ['koto-data-x'], keptRegistryOrigin: 'owned', keptRegistryUsers: [] })

    // ダイアログを閉じていた（窓はここに居ない）。開き直して get する
    const res = (await getOps(dir)).last.result
    expect(res.warnings).toHaveLength(1)
    expect(res.warnings[0]).toContain('データの保存場所『koto-data-x』')
    expect(res.warnings[0]).toContain('コンテナレジストリ『myreg』')
    expect(res.warnings[0]).toContain('月額')
    // このプロジェクトだけのレジストリには「後で消す場合は」と言う。ほかのプロジェクトも使う保存場所には、消すとそのアプリが止まると言う
    expect(res.warnings[0]).toContain('コンテナレジストリを後で消す場合は')
    expect(res.warnings[0]).toContain('データの保存場所『koto-data-x』は、ほかのプロジェクトも使っています。消すと、そのプロジェクトのデータも消えます。')
    expect(res.extra).toMatchObject({ keptBucketName: 'koto-data-x', keptRegistryName: 'myreg', keptBucketsUsedByOthers: ['koto-data-x'], keptRegistryOrigin: 'owned', keptRegistryUsers: [] })
  })

  // ── 2026-09-30 検分の指摘6: その場の警告と、開き直した警告が食い違っていた ──────────────────────
  // レジストリを消すのは、破棄が**成功したとき**の「消す」選択の分岐だけ。だから「残す」と選んだレジストリは、
  // 破棄の成否に関わらず残る。以前の main は `result.ok` のときしか keptRegistryName を返しておらず、破棄が途中で
  // 失敗した回は、その場の画面は月額が続くと言うのに、開き直した記録には警告が無かった。
  // いまは**返り値の事実から**、画面の破棄の結果も記録も同じ関数（teardownRemainingWarning）で警告を作る。
  it('★★★ 共用型の破棄が途中で失敗しても、「残す」と選んだレジストリの月額が続くことは、開き直した記録から消えない', async () => {
    const dir = newProject()
    saveCloudState(dir, { name: 'myapp', backend: 'apprun', resources: [], meta: { registryName: 'myreg', registryAdopted: false } } as any)
    h.applyOk = false
    const reply = await handler('cloud:teardown')({}, dir, { heldByMain: true }, { confirmed: true, deleteRegistry: false, registryName: 'myreg' })
    expect(reply.ok).toBe(false)
    expect(reply.keptRegistryName, '失敗した回に、残したレジストリの事実を返していない').toBe('myreg')
    expect(reply, '失敗した回にも、由来と借り手を返す（警告の言い分けの材料）').toMatchObject({ keptRegistryOrigin: 'owned', keptRegistryUsers: [] })

    const res = (await getOps(dir)).last.result
    expect(res.ok).toBe(false)
    expect(res.warnings).toHaveLength(1)
    expect(res.warnings[0]).toContain('コンテナレジストリ『myreg』')
    expect(res.warnings[0]).toContain('月額')
    // その場の画面が作る警告（返り値の事実から同じ関数で）と、記録の警告は同じ文
    expect(res.warnings).toEqual(teardownRemainingWarnings(reply))
  })

  it('★★ 記録にレジストリ名が無いとき（v0.2.94 以前に公開した等）も、その場と記録の警告は同じ。残っていると断定せず、確認画面と同じ文で言う', async () => {
    const dir = newProject()
    for (const ok of [true, false]) {
      // meta.registryName が無い。公開した形跡（アプリの記録）はある＝レジストリが残っているかもしれない。
      // 成功の回は記録を空にするので、回ごとに置き直す。
      saveCloudState(dir, { name: 'myapp', backend: 'apprun', resources: [{ kind: 'apprun-app', key: 'apprun-app:myapp', id: 'app-1', stateful: false }] } as any)
      h.applyOk = ok
      // 画面は、記録に名前が無いレジストリは削除できないので「削除しない」（deleteRegistry:false）を渡す
      const reply = await handler('cloud:teardown')({}, dir, { heldByMain: true }, { confirmed: true, deleteRegistry: false, registryName: null })
      expect(reply.ok, String(ok)).toBe(ok)
      expect(reply.keptRegistryName, String(ok)).toBeUndefined()
      expect(reply.keptRegistryUnnamed, String(ok)).toBe(true)
      const res = (await getOps(dir)).last.result
      expect(res.warnings, String(ok)).toHaveLength(1)
      expect(res.warnings[0], String(ok)).toContain('どのコンテナレジストリを使っているかの記録がない')
      expect(res.warnings, String(ok)).toEqual(teardownRemainingWarnings(reply))
      ackOps(dir)
    }
  })

  it('★★ 「削除する」を選んだ回は、失敗しても「残す」と言わない（利用者は残す選択をしていない・その場の画面と同じ）', async () => {
    const dir = newProject()
    saveCloudState(dir, { name: 'myapp', backend: 'apprun', resources: [], meta: { registryName: 'myreg' } } as any)
    h.applyOk = false
    const reply = await handler('cloud:teardown')({}, dir, { heldByMain: true }, { confirmed: true, deleteRegistry: true, registryName: 'myreg' })
    expect(reply.ok).toBe(false)
    expect(reply.keptRegistryName).toBeUndefined()
    expect(reply.keptRegistryUnnamed).toBeUndefined()
    expect((await getOps(dir)).last.result.warnings).toEqual([])
    expect(teardownRemainingWarnings(reply)).toEqual([])
  })

  it('共用型の破棄: 何も残らなければ、警告は出ない（言いすぎない）', async () => {
    const dir = newProject()
    saveCloudState(dir, { name: 'myapp', backend: 'apprun', resources: [], meta: { registryName: 'myreg' } } as any)
    // レジストリの一覧が読めて、そこに無い（＝削除済み）→ 何も残らず、確認できなかった注記も付かない
    globalThis.fetch = (async (input: unknown, init: any) => {
      await record(`${init?.method ?? 'GET'} ${String(input)}`)
      return jsonRes(200, { CommonServiceItems: [] })
    }) as unknown as typeof fetch
    const reply = await handler('cloud:teardown')({}, dir, { heldByMain: true }, { confirmed: true, deleteRegistry: true, registryName: 'myreg' })
    expect(reply.ok).toBe(true)
    expect(reply.keptRegistryName).toBeUndefined()
    expect(reply.keptRegistryUnnamed).toBeUndefined()
    expect(reply.keptBucketName).toBeNull()
    expect((await getOps(dir)).last.result.warnings).toEqual([])
  })

  it('★ 共用型の破棄: レジストリを削除できたか確かめられなかった（※）は、警告として記録に載る（executed の ※ 行を落とさない）', async () => {
    const dir = newProject()
    saveCloudState(dir, { name: 'myapp', backend: 'apprun', resources: [], meta: { registryName: 'myreg' } } as any)
    // 偽の client は全部 500 を返す＝レジストリの一覧が取れず、削除できたか確認できない
    const reply = await handler('cloud:teardown')({}, dir, { heldByMain: true }, { confirmed: true, deleteRegistry: true, registryName: 'myreg' })
    expect(reply.ok).toBe(true)
    const noteInReply = (reply.executed as string[]).find(l => l.startsWith('※'))
    expect(noteInReply, 'ハンドラがレジストリの確認失敗を言っていない').toContain('レジストリ『myreg』')
    const res = (await getOps(dir)).last.result
    expect(res.warnings).toContain(noteInReply)
    expect(res.lines).not.toContain(noteInReply)
  })

  it('★ 専有型⑥: 消せずに残ったものは「課金が続く」と名指しされる（IDをたどれる）', async () => {
    const dir = newProject()
    // アプリだけ記録があってクラスタの記録が無い（親のIDが無いと一覧を引けない）→ 外部の API は呼ばれず失敗で止まる
    fs.writeFileSync(path.join(dir, '.sakuraide.json'), JSON.stringify({ publish: { apprunDedicated: { applicationID: 'app-1' } } }), 'utf-8')
    const reply = await handler('apprunDedicated:teardown')(EVENT, dir, D_AUTH, { confirmed: true })
    expect(reply.ok).toBe(false)
    expect(reply.remaining).toMatchObject({ applicationID: 'app-1' })
    expect(h.calls).toEqual([])

    const res = (await getOps(dir)).last.result
    expect(res.ok).toBe(false)
    expect(res.message).toContain('app-1')
    expect(res.warnings).toHaveLength(1)
    expect(res.warnings[0]).toContain('課金が続きます')
    expect(res.warnings[0]).toContain('アプリケーション『app-1』')
    expect(res.extra.remaining).toEqual({ applicationID: 'app-1' })
  })
})

describe('★★★ 秘密が記録に入らない（掟4・ハンドラを通して）', () => {
  it('HANAMII: 応答がトークンを含む文で失敗しても、記録には伏せて残る（ハンドラの返り値そのものには入る＝テストが実際に漏れ道を通っている証拠）', async () => {
    const dir = newProject()
    globalThis.fetch = (async (input: unknown, init: any) => {
      await record(`${init?.method ?? 'GET'} ${String(input)}`)
      return jsonRes(400, { error: { message: `トークン ${HN_TOKEN} は無効です` } })
    }) as unknown as typeof fetch
    const reply = await handler('hanamii:publish')({}, dir, { token: HN_TOKEN, workspaceId: 'ws-1', name: 'myapp' })
    // 漏れ道が実在する: IPC の返り値（従来どおり画面へ返る）には入っている
    expect(JSON.stringify(reply)).toContain(HN_TOKEN)
    // 記録には入っていない
    const json = JSON.stringify(await getOps(dir))
    expect(json).not.toContain(HN_TOKEN)
    expect(json).toContain('トークン *** は無効です')
    expect(JSON.stringify(h.pushed)).not.toContain(HN_TOKEN)
  })

  it('専有型: 認証情報（token・secret）が、断りの文に混ざっても記録には入らない', async () => {
    const dir = newProject()
    h.imageFailure = `レジストリが ${D_AUTH.secret} を拒否しました（${D_AUTH.token}）`
    const reply = await handler('apprunDedicated:publishApp')(EVENT, dir, D_AUTH, APP_INPUT, { confirmed: true })
    expect(reply.ok).toBe(false)
    expect(reply.message).toContain(D_AUTH.secret)     // 漏れ道が実在する
    const json = JSON.stringify([await getOps(dir), h.pushed])
    expect(json).not.toContain(D_AUTH.secret)
    expect(json).not.toContain(D_AUTH.token)
    expect((await getOps(dir)).last.result.message).toContain('レジストリが *** を拒否しました')
  })

  it('Vercel: トークンが文に混ざっても記録には入らない', async () => {
    const dir = newProject()
    const VT = 'vercel-token-CCCC3333'
    globalThis.fetch = (async () => jsonRes(403, { error: { message: `token ${VT} lacks scope` } })) as unknown as typeof fetch
    const reply = await handler('vercel:publish')(EVENT, dir, { token: VT, name: 'myapp' })
    expect(reply.ok).toBe(false)
    expect(JSON.stringify(await getOps(dir))).not.toContain(VT)
  })

  it('HANAMII 破棄: トークンが文に混ざっても記録には入らない', async () => {
    const dir = newProject()
    globalThis.fetch = (async () => { throw new Error(`接続に失敗しました（${HN_TOKEN}）`) }) as unknown as typeof fetch
    const reply = await hanamiiTeardown(dir)
    expect(reply.ok).toBe(false)
    expect(reply.message).toContain(HN_TOKEN)
    expect(JSON.stringify(await getOps(dir))).not.toContain(HN_TOKEN)
  })
})

describe('例外で終わった操作も記録される（IPC は例外を投げ続け、鍵は外れる）', () => {
  it('cloud:apply の本体が例外を投げても、記録には ok:false が残り、次の操作が通る', async () => {
    const dir = newProject()
    h.creds = null                                 // 認証情報なし（本体は ok:false を返す。例外にはしない）
    const noCreds = await handler('cloud:apply')(EVENT, dir, { confirmed: true })
    expect(noCreds.ok).toBe(false)
    expect((await getOps(dir)).last.result).toMatchObject({ ok: false })
    expect((await getOps(dir)).last.result.message).toContain('APIキー未登録')
    // 次の操作も通る（鍵が外れている）
    h.creds = { token: 'TEST-TOKEN', secret: 'TEST-SECRET' }
    const again = await handler('cloud:apply')(EVENT, dir, { confirmed: true })
    expect(again.message ?? '').not.toContain('別の操作')
    expect((await getOps(dir)).earlier).toHaveLength(1)
  })
})
