import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── なぜこのテストが要るか（2026-09-29・作者の問い「公開のダイアログを閉じると止まりますか」の調査で判明）──
//
// 公開・破棄の本体は main の1回の IPC で最後まで進む。だから**処理中にダイアログを閉じて開き直し、
// もう一度「公開」を押せる**——画面のフラグ（publishing）は窓が持っている状態でしかなく、開き直せば消える。
// main の二重実行の歯止め（withProjectLock）は、それまで**専有型（apprunDedicated.ts）にしか無かった**。
// 共用型（cloud:apply・cloud:teardown）・HANAMII（publish・teardown）・Vercel（publish）には無く、
// 同じプロジェクトの公開が**二重に走った**（HANAMII は projectId を保存する前だと二重作成のおそれ）。
//
// ここは**ソースの文字列を読まない**（掟10）。5つのハンドラを実際に呼び、偽の client（fetch・applyPlan・
// prepareAppImage）へ**実際に出た要求の一覧**で固定する:
//   ・1回目が走っている間の2回目は、**外部の API を1件も呼ばずに**断られる（一覧が増えない）
//   ・1回目が終わったあとは通る（鍵が外れる）
//   ・断られた側が、走っている公開の印（publish.pending）を消さない
//   ・プロジェクトをまたがない（別のプロジェクトは影響を受けない）
//   ・公開先をまたぐ（同じプロジェクトなら、共用型が走っている間は HANAMII も Vercel も断られる）

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  /** 外部へ出た要求の一覧（順序込み）。fetch・applyPlan・prepareAppImage。**増えないことを確かめるのに使う。** */
  calls: [] as string[],
  /** 次の外部要求で1回だけ止める（1回目を「走っている最中」にしておくため）。 */
  blockNext: false,
  /** 止まったときに呼ぶ（テストが「1回目は外部要求の手前まで来た」を待つ）。 */
  entered: null as null | (() => void),
  /** 止めている門を開ける。 */
  release: (() => {}) as () => void,
  creds: { token: 'TEST-TOKEN', secret: 'TEST-SECRET' } as null | { token: string; secret: string },
}))

/** 外部要求を記録し、必要なら1回だけ止める。 */
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
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {} },
  dialog: {},
}))

vi.mock('../src/main/cloud/auth', async (importOriginal) => {
  const real = await importOriginal<any>()
  return { ...real, loadCredentials: () => h.creds }
})

// 像の組み立て（レジストリへの push）。**実ネットワークへは出ない。**
vi.mock('../src/main/cloud/imagePublish', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    prepareAppImage: async () => {
      await record('prepareAppImage')
      return {
        ok: true, tag: 'test-tag', image: 'koto-test', ref: 'registry.example/koto-test:test-tag',
        runtimeKind: 'static',
        registryAuth: { server: 'registry.example', username: 'u', password: 'p' },
      }
    },
  }
})

// さくらへの反映。resources を空にして返す＝このあとの疎通確認などには入らない。
vi.mock('../src/main/cloud/apply', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    applyPlan: async (opts: any) => {
      await record('applyPlan')
      return {
        ok: true,
        state: { name: opts.spec.name, backend: opts.spec.backend, resources: [] },
        executed: ['✅ テスト'], skipped: [],
      }
    },
  }
})

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { registerHanamiiHandlers } from '../src/main/ipc/hanamii'
import { registerVercelHandlers } from '../src/main/ipc/vercel'
import { registerPublishMetaHandlers } from '../src/main/ipc/publishMeta'
import { projectBusyMessage } from '../src/main/projectLock'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'

registerCloudHandlers({} as any)
registerHanamiiHandlers({} as any)
registerVercelHandlers({} as any)
registerPublishMetaHandlers()

const EVENT = { sender: { send: () => {} } }
const TOKEN = 'tok-test'

let projectDirs: string[] = []
let realFetch: typeof globalThis.fetch

/** 公開できるプロジェクト（保存場所は使わない）。 */
function newProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-lock-'))
  projectDirs.push(dir)
  const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: false })
  fs.mkdirSync(path.join(dir, '.sakura-cloud'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.sakura-cloud', 'env.json'), JSON.stringify(spec, null, 2), 'utf-8')
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>hi</body></html>', 'utf-8')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'myapp', type: 'module' }, null, 2), 'utf-8')
  fs.writeFileSync(path.join(dir, 'app.js'), 'export const run = () => 1\n', 'utf-8')
  return dir
}

beforeEach(() => {
  projectDirs = []
  h.calls = []
  h.blockNext = false
  h.entered = null
  h.release = () => {}
  h.creds = { token: 'TEST-TOKEN', secret: 'TEST-SECRET' }
  realFetch = globalThis.fetch
  // **偽の client。** 実ネットワークへは一切出さない。出た要求は一覧に積む（HANAMII・Vercel の実物のクライアントが叩く先）。
  globalThis.fetch = (async (input: unknown, init: any) => {
    await record(`${init?.method ?? 'GET'} ${String(input)}`)
    return { ok: false, status: 500, async text() { return JSON.stringify({ error: { message: 'テスト用の失敗' } }) } }
  }) as unknown as typeof fetch
})
afterEach(async () => {
  h.release()
  globalThis.fetch = realFetch
  for (const d of projectDirs) fs.rmSync(d, { recursive: true, force: true })
})

const handler = (channel: string) => h.handlers.get(channel)!
const runningOp = (dir: string) => handler('publishMeta:runningOp')({}, dir)
const readPublish = (dir: string): any => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, '.sakuraide.json'), 'utf-8'))?.publish ?? {} } catch { return {} }
}

/**
 * 記録（.sakuraide.json）が指す projectId と、画面が渡す projectId を一致させて、HANAMII の破棄を呼ぶ。
 * main は**渡された projectId が記録と一致するときだけ**動く（2026-09-30 検分・掟11。断る振る舞いは
 * tests/hanamiiTeardownRecord.test.ts が固定する）。ここで見たいのは鍵の振る舞いなので、一致する呼び出しにする。
 */
const hanamiiTeardown = (dir: string) => {
  const p = path.join(dir, '.sakuraide.json')
  if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify({ publish: { hanamii: { projectId: 'hnm-proj-1' } } }, null, 2), 'utf-8')
  return handler('hanamii:teardown')({}, 'hnm-proj-1', TOKEN, dir)
}

type Case = {
  name: string
  /** 走っているあいだ main の鍵が名乗る操作。 */
  op: '公開' | '削除'
  /** pending（公開開始マーカー）を書く公開の経路か（破棄は書かない）。 */
  writesPending: boolean
  invoke: (dir: string) => Promise<any>
}

const CASES: Case[] = [
  { name: 'cloud:apply（共用型の公開）', op: '公開', writesPending: true, invoke: dir => handler('cloud:apply')(EVENT, dir, { confirmed: true }) },
  { name: 'cloud:teardown（共用型の破棄）', op: '削除', writesPending: false, invoke: dir => handler('cloud:teardown')({}, dir, { confirmed: true, deleteRegistry: false }) },
  { name: 'hanamii:publish（HANAMII の公開）', op: '公開', writesPending: true, invoke: dir => handler('hanamii:publish')({}, dir, { token: TOKEN, workspaceId: 'ws-1', name: 'myapp' }) },
  { name: 'hanamii:teardown（HANAMII の破棄）', op: '削除', writesPending: false, invoke: dir => hanamiiTeardown(dir) },
  { name: 'vercel:publish（Vercel の公開）', op: '公開', writesPending: true, invoke: dir => handler('vercel:publish')(EVENT, dir, { token: TOKEN, name: 'myapp' }) },
]

/**
 * 1回目を「外部の API を呼ぶ手前」で止めておき、走っている最中の状態を作る。
 * 戻り値の `finish` で1回目を終わらせる。
 */
async function startHeld(invoke: () => Promise<any>): Promise<{ first: Promise<any>; finish: () => Promise<any> }> {
  h.blockNext = true
  const entered = new Promise<void>(resolve => { h.entered = resolve })
  const first = invoke()
  await entered
  return { first, finish: async () => { h.release(); return first } }
}

describe('★★★ 1回目が走っている間の2回目は、外部の API を1件も呼ばずに断られる（5つのハンドラすべて）', () => {
  for (const c of CASES) {
    it(`${c.name}`, async () => {
      const dir = newProject()
      const held = await startHeld(() => c.invoke(dir))
      // 1回目は外部要求の手前まで来て止まっている（ここまでで外部要求は1件）
      expect(h.calls).toHaveLength(1)
      expect(await runningOp(dir)).toBe(c.op)

      const before = [...h.calls]
      const second = await c.invoke(dir)

      // **2回目は断られ、外部の要求は1件も増えていない**（偽 client の呼び出し一覧で固定）
      expect(second.ok).toBe(false)
      expect(second.message).toBe(projectBusyMessage(c.op))
      expect(second.message).toContain(`（${c.op}）`)
      expect(h.calls).toEqual(before)

      // 1回目を終わらせる
      const firstResult = await held.finish()
      expect(firstResult.message ?? '').not.toContain('別の操作')
      expect(await runningOp(dir)).toBeNull()
    })

    it(`${c.name}: 1回目が終わったあとは通る（鍵が外れる）`, async () => {
      const dir = newProject()
      const held = await startHeld(() => c.invoke(dir))
      await held.finish()
      const callsAfterFirst = h.calls.length

      const third = await c.invoke(dir)
      // 断られていない＝本体に入り、外部へ要求が出ている
      expect(third.message ?? '').not.toContain('別の操作')
      expect(h.calls.length).toBeGreaterThan(callsAfterFirst)
      expect(await runningOp(dir)).toBeNull()
    })
  }
})

describe('★★ 断られた側は、走っている公開の印（publish.pending）を消さない', () => {
  for (const c of CASES.filter(x => x.writesPending)) {
    it(`${c.name}`, async () => {
      const dir = newProject()
      const held = await startHeld(() => c.invoke(dir))
      // 走っている公開が、開始の印を書いている
      expect(readPublish(dir).pending).toBeDefined()

      const second = await c.invoke(dir)
      expect(second.ok).toBe(false)
      // 断られた側の後始末が、走っている公開の印を消していない（鍵を印の書き込みより外側で取っている）
      expect(readPublish(dir).pending).toBeDefined()

      await held.finish()
      // 1回目が終われば、その公開自身が印を消す
      expect(readPublish(dir).pending).toBeUndefined()
    })
  }
})

describe('★★ 鍵はプロジェクト単位: 公開先をまたいでも、同じプロジェクトなら1つずつ', () => {
  it('共用型の公開が走っている間、HANAMII の公開・破棄も、Vercel の公開も、共用型の破棄も断られ、外部の要求は増えない', async () => {
    const dir = newProject()
    const held = await startHeld(() => handler('cloud:apply')(EVENT, dir, { confirmed: true }))
    const before = [...h.calls]

    for (const c of CASES.slice(1)) {
      const r = await c.invoke(dir)
      expect(r.ok, c.name).toBe(false)
      expect(r.message, c.name).toContain('いま別の操作（公開）を実行中です')
    }
    expect(h.calls).toEqual(before)
    await held.finish()
  })

  it('HANAMII の破棄が走っている間、共用型の公開も Vercel の公開も断られる（破棄と公開は交錯させない）', async () => {
    const dir = newProject()
    const held = await startHeld(() => hanamiiTeardown(dir))
    const before = [...h.calls]

    const apply = await handler('cloud:apply')(EVENT, dir, { confirmed: true })
    const vercel = await handler('vercel:publish')(EVENT, dir, { token: TOKEN, name: 'myapp' })
    expect(apply.message).toBe(projectBusyMessage('削除'))
    expect(vercel.message).toBe(projectBusyMessage('削除'))
    expect(h.calls).toEqual(before)
    await held.finish()
  })

  it('別のプロジェクトは影響を受けない（片方が走っていても、もう片方は本体に入る）', async () => {
    const a = newProject()
    const b = newProject()
    const held = await startHeld(() => handler('hanamii:publish')({}, a, { token: TOKEN, workspaceId: 'ws-1', name: 'myapp' }))
    const before = h.calls.length

    const other = await handler('hanamii:publish')({}, b, { token: TOKEN, workspaceId: 'ws-1', name: 'myapp' })
    expect(other.message ?? '').not.toContain('別の操作')
    expect(h.calls.length).toBeGreaterThan(before)
    await held.finish()
  })

  it('同じフォルダの別の書き方（末尾の / ・ . を含む）でも、すり抜けられない', async () => {
    const dir = newProject()
    const held = await startHeld(() => handler('vercel:publish')(EVENT, dir, { token: TOKEN, name: 'myapp' }))
    const before = [...h.calls]

    for (const alias of [`${dir}/`, `${dir}/.`, path.join(dir, 'sub', '..')]) {
      const r = await handler('vercel:publish')(EVENT, alias, { token: TOKEN, name: 'myapp' })
      expect(r.ok, alias).toBe(false)
      expect(r.message, alias).toBe(projectBusyMessage('公開'))
    }
    expect(h.calls).toEqual(before)
    await held.finish()
  })
})

describe('hanamii:teardown: projectDir が無い呼び出しは鍵を掛けられないので、そのまま走る（保存場所には触れない）', () => {
  it('projectDir 無しでも落ちず、HANAMII の削除だけが出る', async () => {
    h.blockNext = false
    globalThis.fetch = (async (input: unknown, init: any) => {
      h.calls.push(`${init?.method ?? 'GET'} ${String(input)}`)
      return { ok: true, status: 204, async text() { return '' } }
    }) as unknown as typeof fetch
    const r = await handler('hanamii:teardown')({}, 'hnm-proj-1', TOKEN)
    expect(r).toEqual({ ok: true, appDeleted: true, executed: [] })
    expect(h.calls).toEqual(['DELETE https://hanamii.jp/api/v1/projects/hnm-proj-1'])
  })
})

// ── 定義は1か所（掟10: 複製しない）──────────────────────────────────────────────
describe('withProjectLock の定義は src/main/projectLock.ts の1か所だけ。使う側はそこから import している', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(p, out)
      else if (/\.ts$/.test(ent.name)) out.push(p)
    }
    return out
  }
  const codeOf = (f: string) => fs.readFileSync(f, 'utf-8').split('\n')
    .filter(l => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*')).join('\n')

  it('★ src/main の中で withProjectLock を定義しているファイルは projectLock.ts だけ', () => {
    const definers = walk(path.join(process.cwd(), 'src/main'))
      .filter(f => /(function|const|let)\s+withProjectLock\b/.test(codeOf(f)))
      .map(f => path.relative(process.cwd(), f))
    expect(definers).toEqual(['src/main/projectLock.ts'])
  })

  it('★ 使っているファイルは、専有型・共用型・HANAMII・Vercel の4つで、どれも ../projectLock から import している', () => {
    const users = walk(path.join(process.cwd(), 'src/main'))
      .filter(f => /withProjectLock\(/.test(codeOf(f)) && !f.endsWith('projectLock.ts'))
      .map(f => path.relative(process.cwd(), f))
      .sort()
    expect(users).toEqual([
      'src/main/ipc/apprunDedicated.ts',
      'src/main/ipc/cloud.ts',
      'src/main/ipc/hanamii.ts',
      'src/main/ipc/vercel.ts',
    ])
    for (const u of users) {
      expect(codeOf(path.join(process.cwd(), u)), u).toMatch(/import \{[^}]*withProjectLock[^}]*\} from '\.\.\/projectLock'/)
    }
  })
})
