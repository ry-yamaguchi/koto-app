import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── 0.6.24 R2-d: 「重なる」と「覆う」を分ける。プロジェクトの削除（I-3）は、覆う複製があるときだけ破棄を外す ──────────────────────────
// 検分で実測: 公開の前・保存場所を作る前に Finder で写したバックアップ（記録の一部だけを持つ複製）でも「複製」と数え、元を削除すると、
// 元にしか無い専有型の applicationID・共用型の保存場所・レジストリ・鍵が、どの記録にも残らないまま残る。
//   重なる（recordTwinsFs）… 識別子が1つでも一致。I-2（破棄を断る）はこのまま（断るのは何も消さない側）
//   覆う（recordCoverFs）  … 自分の事実がすべて、**1つの兄弟**の事実に含まれる。I-3（画面の plan・cloud:recordTwins・main の fs:trashProject）はこちら
// ここは本物のフォルダの記録で、事実の書き下し（公開先ごと）・覆う/覆わないの境・画面の plan・移す口を固定する。
// 骨が断って手順が failed になりフォルダが移らない道は、本物の hanamii:teardown に流して見る（tests/recordCoverRun.test.ts）。
// 変異: 覆うを重なるに戻す（cloud:recordTwins・fs:trashProject それぞれ）／覆うの判定を some にする／事実を1種ずつ外す／自分の記録が読めない回を通す。
// R3-a（0.6.24）: 鍵の ID（`perm:`）は事実に入れない。再公開のたびに置き換わる値なので、鍵だけが違う A・B は互いに覆う（末尾の describe）。変異: `perm:` を事実に戻す（共用型・専有型それぞれ）。

const m = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  trashItem: vi.fn(async (_p: string) => {}),
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { m.handlers.set(channel, fn) } },
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test', on: () => {} },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {}, trashItem: m.trashItem },
  dialog: {},
}))

import { registerFsHandlers } from '../src/main/ipc/fs'
import { registerCloudTeardownHandlers, SHARED_TEARDOWN_SHELL } from '../src/main/ipc/cloudTeardown'
import { HANAMII_TEARDOWN_SHELL } from '../src/main/ipc/hanamiiTeardown'
import { DEDICATED_TEARDOWN_SHELL } from '../src/main/ipc/apprunDedicatedTeardown'
import { FS_TRASH_MESSAGES } from '../src/main/ipc/fsTrash'
import { recordCoverFs, recordTwinsFs, readRecordTwins, RECORD_TWINS_UNKNOWN_MESSAGE } from '../src/main/cloud/recordTwins'
import { coverFactsOf, covers } from '../src/main/cloud/coverFacts'
import { planProjectDeleteTeardown, type ProjectDeleteFacts } from '../src/renderer/teardown/projectDeletePlan'
import type { PublishTargetKind } from '../src/shared/publishMeta'

let home = ''
let ws = ''
let self = ''
let savedHome: string | undefined
beforeEach(() => {
  savedHome = process.env.HOME
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koto-r2d-')))
  process.env.HOME = home
  ws = path.join(home, 'SAKURAIDE')
  self = path.join(ws, 'myapp')
  fs.mkdirSync(self, { recursive: true })
  m.trashItem.mockClear()
  m.handlers.clear()
  registerFsHandlers({} as any)
  registerCloudTeardownHandlers()
})
afterEach(() => {
  try { fs.chmodSync(ws, 0o755) } catch { /* 片づけ */ }
  for (const e of fs.existsSync(ws) ? fs.readdirSync(ws) : []) { try { fs.chmodSync(path.join(ws, e), 0o755) } catch { /* 片づけ */ } }
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome
  fs.rmSync(home, { recursive: true, force: true })
})
const call = async (channel: string, ...args: unknown[]) => m.handlers.get(channel)!({}, ...args)
const rootIsMe = typeof process.getuid === 'function' && process.getuid() === 0

// ── 記録の作り方 ─────────────────────────────────────────────────────────────────────
type Rec = { meta?: unknown; state?: unknown; env?: unknown }
const put = (file: string, v: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v)) }
function write(dir: string, rec: Rec): string {
  fs.mkdirSync(dir, { recursive: true })
  if (rec.meta !== undefined) put(path.join(dir, '.sakuraide.json'), rec.meta)
  if (rec.state !== undefined) put(path.join(dir, '.sakura-cloud', 'state.json'), rec.state)
  if (rec.env !== undefined) put(path.join(dir, '.sakura-cloud', 'env.json'), rec.env)
  return dir
}
const sib = (name: string, rec: Rec) => write(path.join(ws, name), rec)
const CONSENTED = '2026-10-01T00:00:00Z'
const env = (...p: Array<[string, string] | [string, string, false]>) => ({
  persistence: { objectStorage: p.map(x => ({ bucket: x[0], prefix: x[1], shared: true, ...(x[2] === false ? {} : { consentedAt: CONSENTED }) })) },
})
const hanamii = (projectId: string, extra: Record<string, unknown> = {}) => ({ publish: { hanamii: { projectId, ...extra }, targets: { hanamii: { publishedAt: '2026-10-19T00:00:00.000Z' } } } })
const dedicated = (rec: Record<string, unknown>) => ({ publish: { apprunDedicated: rec, targets: { 'sakura-apprun-dedicated': { publishedAt: '2026-10-19T00:00:00.000Z' } } } })
const state = (opts: { apps?: string[]; buckets?: Array<[string, string]>; registry?: string; perm?: string } = {}) => ({
  name: 'myapp', backend: 'apprun',
  resources: [
    ...(opts.apps ?? []).map(id => ({ kind: 'apprun-app', id, key: `apprun-app:${id}`, stateful: false })),
    ...(opts.buckets ?? []).map(([id, prefix]) => ({ kind: 'bucket', id, key: `bucket:${id}`, stateful: true, prefix })),
  ],
  ...(opts.registry || opts.perm ? { meta: { ...(opts.registry ? { registryName: opts.registry } : {}), ...(opts.perm ? { storagePermissionId: opts.perm } : {}) } } : {}),
})
const P = 'projects/myapp/'

// ── 事実の書き下し ───────────────────────────────────────────────────────────────────
describe('★★★ coverFactsOf: 公開先ごとの「破棄で消すものの事実」を書き下す（純関数）', () => {
  const ok = (value: unknown) => ({ kind: 'ok' as const, value })
  const missing = { kind: 'missing' as const }
  const records = (r: { meta?: unknown; state?: unknown; env?: unknown }) => ({ meta: r.meta === undefined ? missing : ok(r.meta), state: r.state === undefined ? missing : ok(r.state), env: r.env === undefined ? missing : ok(r.env) })

  it('★★★ HANAMII: hanamii:<projectId>・placement:<bucket>/<prefix>（同意済みだけ）・leftover:<bucket>', () => {
    const r = records({ meta: hanamii('prj-1', { storageLeftoverBuckets: ['left-1', '', 5] }), env: env(['koto-a', P], ['koto-b', P, false]) })
    expect(coverFactsOf('hanamii', ['hanamii:prj-1'], r)).toEqual(['hanamii:prj-1', `placement:koto-a/${P}`, 'leftover:left-1'])
  })

  it('★★★ 共用型: apprun-app:<id>・bucket:<id>/<prefix>・placement:…・registry:<名前>。鍵（perm:）は事実に入れない（R3-a）', () => {
    const r = records({ state: state({ apps: ['a-1'], buckets: [['koto-a', P]], registry: 'reg-1', perm: 'perm-1' }), env: env(['koto-a', P]) })
    expect(coverFactsOf('sakura-apprun', ['apprun-app:a-1'], r)).toEqual(['apprun-app:a-1', `placement:koto-a/${P}`, `bucket:koto-a/${P}`, 'registry:reg-1'])
  })

  it('★★★ 専有型: 4つの ID・placement:…・leftover:<bucket>。鍵（perm:）は事実に入れない（R3-a）', () => {
    const rec = { applicationID: 'ap-1', clusterID: 'cl-1', loadBalancerID: 'lb-1', asgID: 'asg-1', storagePermissionId: 'perm-d', storageLeftoverBuckets: ['left-1'] }
    const ids = ['applicationID:ap-1', 'clusterID:cl-1', 'loadBalancerID:lb-1', 'asgID:asg-1']
    expect(coverFactsOf('sakura-apprun-dedicated', ids, records({ meta: dedicated(rec), env: env(['koto-a', P]) })))
      .toEqual([...ids, `placement:koto-a/${P}`, 'leftover:left-1'])
  })

  it('空・文字列でない値・読めない記録は事実に数えない。骨に載っていない公開先は識別子のまま', () => {
    const bad = records({ state: { resources: [{ kind: 'bucket', id: '' }, { kind: 'bucket', id: 5 }], meta: { registryName: '', storagePermissionId: 7 } }, env: { persistence: { objectStorage: 'x' } } })
    expect(coverFactsOf('sakura-apprun', [], bad)).toEqual([])
    expect(coverFactsOf('sakura-apprun', [], { meta: { kind: 'unreadable' }, state: { kind: 'unreadable' }, env: { kind: 'unreadable' } })).toEqual([])
    expect(coverFactsOf('vercel', ['x:1'], records({ env: env(['koto-a', P]) }))).toEqual(['x:1', `placement:koto-a/${P}`])
  })

  it('covers: 自分の事実がすべて含まれるときだけ true。自分が空なら false。1つでも欠ければ false（重なっていても）', () => {
    expect(covers(['a', 'b'], ['b', 'a', 'c'])).toBe(true)
    expect(covers(['a', 'b'], ['a'])).toBe(false)
    expect(covers(['a'], [])).toBe(false)
    expect(covers([], ['a'])).toBe(false)
  })
})

// ── 実フォルダ: 覆う/覆わない ─────────────────────────────────────────────────────────
describe('★★★ HANAMII: 同じ projectId だけでは覆わない。自分の保存場所・残りの印も持つ兄弟だけが覆う', () => {
  const own = () => write(self, { meta: hanamii('prj-1'), env: env(['koto-a', P]) })

  it('★★★ 完全な複製（同じ projectId・同じ保存場所）→ 覆う。重なるのでもある。互いに覆う', () => {
    own()
    sib('copy', { meta: hanamii('prj-1'), env: env(['koto-a', P]) })
    expect(recordCoverFs(self, 'hanamii')).toEqual(['copy'])
    expect(recordTwinsFs(self, 'hanamii')).toEqual(['copy'])
    expect(recordCoverFs(path.join(ws, 'copy'), 'hanamii')).toEqual(['myapp'])
  })

  it('★★★ 検分の再現: 保存場所を作る前に写したバックアップ（同じ projectId・保存場所なし）→ 重なるが覆わない。元（自分）は覆われない', () => {
    own()
    sib('backup', { meta: hanamii('prj-1') })
    expect(recordTwinsFs(self, 'hanamii')).toEqual(['backup'])
    expect(recordCoverFs(self, 'hanamii')).toEqual([])
  })

  it('★★★ 覆われるほう（部分のほう）からは覆う: バックアップの側から見ると、元が覆う', () => {
    own()
    sib('backup', { meta: hanamii('prj-1') })
    expect(recordCoverFs(path.join(ws, 'backup'), 'hanamii')).toEqual(['myapp'])
  })

  it('★★ 別の保存場所・別の prefix・同意が無い保存場所だけの兄弟は覆わない。より多く持つ兄弟（上位集合）は覆う', () => {
    own()
    sib('other-bucket', { meta: hanamii('prj-1'), env: env(['koto-b', P]) })
    sib('other-prefix', { meta: hanamii('prj-1'), env: env(['koto-a', 'projects/other/']) })
    sib('not-consented', { meta: hanamii('prj-1'), env: env(['koto-a', P, false]) })
    sib('superset', { meta: hanamii('prj-1'), env: env(['koto-a', P], ['koto-c', P]) })
    expect(recordCoverFs(self, 'hanamii')).toEqual(['superset'])
    expect(recordTwinsFs(self, 'hanamii')).toEqual(['not-consented', 'other-bucket', 'other-prefix', 'superset'])
  })

  it('★★ 自分に保存場所が無ければ、同じ projectId だけの兄弟が覆う。残りの印は兄弟にも要る', () => {
    write(self, { meta: hanamii('prj-1', { storageLeftoverBuckets: ['left-1'] }) })
    sib('bare', { meta: hanamii('prj-1') })
    expect(recordCoverFs(self, 'hanamii')).toEqual([])
    sib('with-left', { meta: hanamii('prj-1', { storageLeftoverBuckets: ['left-1', 'left-2'] }) })
    expect(recordCoverFs(self, 'hanamii')).toEqual(['with-left'])
  })

  it('★★★ 自分の事実が2つの兄弟に分かれていても、1つの兄弟がすべて持たなければ覆わない（足し合わせない）', () => {
    own()
    sib('has-id-only', { meta: hanamii('prj-1') })
    sib('has-place-only', { meta: hanamii('prj-9'), env: env(['koto-a', P]) })
    expect(recordCoverFs(self, 'hanamii')).toEqual([])
  })
})

describe('★★★ 共用型: apprun-app の id だけでは覆わない。保存場所・レジストリも持つ兄弟だけが覆う（鍵は数えない）', () => {
  const FULL = () => ({ state: state({ apps: ['a-1'], buckets: [['koto-a', P]], registry: 'reg-1', perm: 'perm-1' }), env: env(['koto-a', P]) })

  it('★★★ 完全な複製 → 覆う', () => {
    write(self, FULL())
    sib('copy', FULL())
    expect(recordCoverFs(self, 'sakura-apprun')).toEqual(['copy'])
  })

  // 3つ目は「バックアップの記録は、元の記録に覆われるか」（値が違うものは、どちらも相手を覆わない）
  it.each([
    ['公開の前に写した（アプリの id だけ）', { state: state({ apps: ['a-1'] }) }, true],
    ['保存場所の記録（bucket 資源・env）が無い', { state: state({ apps: ['a-1'], registry: 'reg-1', perm: 'perm-1' }) }, true],
    ['bucket 資源が無い（env だけ）', { state: state({ apps: ['a-1'], registry: 'reg-1', perm: 'perm-1' }), env: env(['koto-a', P]) }, true],
    ['env の同意済みの保存場所が無い（bucket 資源だけ）', { state: state({ apps: ['a-1'], buckets: [['koto-a', P]], registry: 'reg-1', perm: 'perm-1' }) }, true],
    ['レジストリが違う', { state: state({ apps: ['a-1'], buckets: [['koto-a', P]], registry: 'reg-2', perm: 'perm-1' }), env: env(['koto-a', P]) }, false],
    ['レジストリが無い', { state: state({ apps: ['a-1'], buckets: [['koto-a', P]], perm: 'perm-1' }), env: env(['koto-a', P]) }, true],
  ] as Array<[string, Rec, boolean]>)('★★★ 検分の再現（%s）→ 重なるが覆わない。元（自分）は覆われない', (_label, rec, coveredByOwn) => {
    write(self, FULL())
    sib('backup', rec)
    expect(recordTwinsFs(self, 'sakura-apprun')).toEqual(['backup'])
    expect(recordCoverFs(self, 'sakura-apprun')).toEqual([])
    expect(recordCoverFs(path.join(ws, 'backup'), 'sakura-apprun')).toEqual(coveredByOwn ? ['myapp'] : [])
  })

  it('★★ 自分に何も無い（アプリの id だけ）なら、同じアプリの id の兄弟は覆う（上位集合も）', () => {
    write(self, { state: state({ apps: ['a-1'] }) })
    sib('copy', FULL())
    expect(recordCoverFs(self, 'sakura-apprun')).toEqual(['copy'])
  })
})

describe('★★★ 専有型: 4つの ID・保存場所がすべてそろう兄弟だけが覆う（鍵は数えない）', () => {
  const IDS = { applicationID: 'ap-1', clusterID: 'cl-1', loadBalancerID: 'lb-1', asgID: 'asg-1' }

  it('★★★ 完全な複製 → 覆う', () => {
    write(self, { meta: dedicated({ ...IDS, storagePermissionId: 'perm-d' }), env: env(['koto-a', P]) })
    sib('copy', { meta: dedicated({ ...IDS, storagePermissionId: 'perm-d' }), env: env(['koto-a', P]) })
    expect(recordCoverFs(self, 'sakura-apprun-dedicated')).toEqual(['copy'])
  })

  it.each([
    ['applicationID を作る前に写した（クラスタだけ）', { meta: dedicated({ clusterID: 'cl-1' }) }, true],
    ['ID は3つまで（applicationID が無い）', { meta: dedicated({ clusterID: 'cl-1', loadBalancerID: 'lb-1', asgID: 'asg-1' }) }, true],
    ['ID はそろうが保存場所が無い', { meta: dedicated({ ...IDS, storagePermissionId: 'perm-d' }) }, true],
  ] as Array<[string, Rec, boolean]>)('★★★ 検分の再現（%s）→ 重なるが覆わない。元（自分）は覆われない', (_label, rec, coveredByOwn) => {
    write(self, { meta: dedicated({ ...IDS, storagePermissionId: 'perm-d' }), env: env(['koto-a', P]) })
    sib('backup', rec)
    expect(recordTwinsFs(self, 'sakura-apprun-dedicated')).toEqual(['backup'])
    expect(recordCoverFs(self, 'sakura-apprun-dedicated')).toEqual([])
    expect(recordCoverFs(path.join(ws, 'backup'), 'sakura-apprun-dedicated')).toEqual(coveredByOwn ? ['myapp'] : [])
  })

  it('★★ 残った保存場所の印（storageLeftoverBuckets・storageLeftoverBucket）も事実。兄弟に無ければ覆わない', () => {
    write(self, { meta: dedicated({ ...IDS, storageLeftoverBuckets: ['left-1', 'left-2'] }) })
    sib('no-left', { meta: dedicated({ ...IDS }) })
    sib('one-left', { meta: dedicated({ ...IDS, storageLeftoverBucket: 'left-1' }) })
    expect(recordCoverFs(self, 'sakura-apprun-dedicated')).toEqual([])
    sib('both-left', { meta: dedicated({ ...IDS, storageLeftoverBuckets: ['left-2', 'left-1'] }) })
    expect(recordCoverFs(self, 'sakura-apprun-dedicated')).toEqual(['both-left'])
  })
})

describe('★★★ 確かめられない・数えないもの', () => {
  it('★★★ 自分に識別子が無い公開先は空（比べる相手が無い）。公開先でないもの（Vercel）も空', () => {
    write(self, { meta: hanamii('prj-1') })
    sib('copy', { meta: hanamii('prj-1') })
    expect(recordCoverFs(self, 'sakura-apprun')).toEqual([])
    expect(recordCoverFs(self, 'sakura-apprun-dedicated')).toEqual([])
    expect(recordCoverFs(self, 'vercel')).toEqual([])
    expect(recordCoverFs(self, 'sakura-rental')).toEqual([])
  })

  it('★★★ 自分の記録が読めない（env.json が壊れている）→ \'unknown\'（自分の事実を数え切れない）。読める記録に直せば覆う', () => {
    write(self, { meta: hanamii('prj-1'), env: '{ 壊れた' })
    sib('copy', { meta: hanamii('prj-1') })
    expect(recordCoverFs(self, 'hanamii')).toBe('unknown')
    write(self, { env: env(['koto-a', P]) })
    expect(recordCoverFs(self, 'hanamii')).toEqual([])
    write(self, { env: {} })
    expect(recordCoverFs(self, 'hanamii')).toEqual(['copy'])
  })

  it.skipIf(rootIsMe)('★★★ 親フォルダの一覧を読めない（0o311）→ \'unknown\'。projectDir が不正も \'unknown\'', () => {
    write(self, { meta: hanamii('prj-1') })
    fs.chmodSync(ws, 0o311)
    expect(recordCoverFs(self, 'hanamii')).toBe('unknown')
    fs.chmodSync(ws, 0o755)
    expect(recordCoverFs(self, 'hanamii')).toEqual([])
    expect(recordCoverFs('', 'hanamii')).toBe('unknown')
    expect(recordCoverFs(undefined as unknown as string, 'hanamii')).toBe('unknown')
  })

  it('★★ 読めない兄弟（壊れた記録・たどれないリンク・ファイル）は数えない。自分・隠しフォルダ・自分を指すリンクも数えない', () => {
    write(self, { meta: hanamii('prj-1') })
    sib('broken', { meta: '{ 壊れた' })
    fs.symlinkSync(path.join(ws, 'nowhere'), path.join(ws, 'dead-link'))
    fs.writeFileSync(path.join(ws, 'file.txt'), 'x')
    write(path.join(ws, '.hidden'), { meta: hanamii('prj-1') })
    fs.symlinkSync(self, path.join(ws, 'link-to-self'))
    expect(recordCoverFs(self, 'hanamii')).toEqual([])
    sib('copy', { meta: hanamii('prj-1') })
    expect(recordCoverFs(self, 'hanamii')).toEqual(['copy'])
  })

  it('★★ 一部の記録が読めない兄弟は、読めた分だけが事実（覆うと言わない側）。自分に保存場所があれば覆わない', () => {
    write(self, { meta: hanamii('prj-1'), env: env(['koto-a', P]) })
    sib('env-broken', { meta: hanamii('prj-1'), env: '{ 壊れた' })
    expect(recordCoverFs(self, 'hanamii')).toEqual([])
    write(self, { env: {} })
    expect(recordCoverFs(self, 'hanamii')).toEqual(['env-broken']) // 自分に保存場所が無いので、同じ projectId の読めた分で足りる
  })
})

// ── 画面の答え（cloud:recordTwins）と plan ───────────────────────────────────────────────
describe('★★★ cloud:recordTwins は「覆う」を返す（重なるだけの兄弟は入らない）。3つの公開先ごと', () => {
  it('★★★ 完全な複製と部分の複製: 部分の複製（重なるだけ）は twins に入らず、完全な複製は入る', async () => {
    write(self, { meta: { publish: { ...hanamii('prj-1').publish, ...dedicated({ applicationID: 'ap-1', clusterID: 'cl-1' }).publish } }, state: state({ apps: ['a-1'], buckets: [['koto-a', P]] }), env: env(['koto-a', P]) })
    sib('full', { meta: { publish: { ...hanamii('prj-1').publish, ...dedicated({ applicationID: 'ap-1', clusterID: 'cl-1' }).publish } }, state: state({ apps: ['a-1'], buckets: [['koto-a', P]] }), env: env(['koto-a', P]) })
    sib('backup', { meta: { publish: { ...hanamii('prj-1').publish, ...dedicated({ applicationID: 'ap-1' }).publish } }, state: state({ apps: ['a-1'] }) })
    expect(await call('cloud:recordTwins', self)).toEqual({ ok: true, twins: { hanamii: ['full'], 'sakura-apprun': ['full'], 'sakura-apprun-dedicated': ['full'] } })
    expect(HANAMII_TEARDOWN_SHELL.twinsOf(self)).toEqual(['backup', 'full']) // 骨（I-2）は重なるのまま。両方を見つけて断る
    expect(SHARED_TEARDOWN_SHELL.twinsOf(self)).toEqual(['backup', 'full'])
    expect(DEDICATED_TEARDOWN_SHELL.twinsOf(self)).toEqual(['backup', 'full'])
  })

  it('★★★ 自分の記録が読めない公開先があれば、全体が ok:false（RECORD_TWINS_UNKNOWN_MESSAGE）', async () => {
    write(self, { meta: hanamii('prj-1'), env: '{ 壊れた' })
    sib('copy', { meta: hanamii('prj-1') })
    expect(await call('cloud:recordTwins', self)).toEqual({ ok: false, message: RECORD_TWINS_UNKNOWN_MESSAGE })
    expect(readRecordTwins(self)).toEqual({ ok: false, message: RECORD_TWINS_UNKNOWN_MESSAGE })
  })
})

describe('★★★ 画面の plan: 覆う複製だけが破棄を外し・専有型の止めを外す。覆わない複製は破棄に入れ・止める', () => {
  const FULL_HANAMII = { meta: hanamii('prj-1'), env: env(['koto-a', P]) }
  /** 本物の cloud:recordTwins の答えから plan を作る（画面の materials は、ここ以外は空）。 */
  async function planFor(targets: PublishTargetKind[], dedicatedIds: Record<string, string> | null) {
    const r = await call('cloud:recordTwins', self)
    expect(r.ok).toBe(true)
    const facts: ProjectDeleteFacts = {
      targets, unreadable: false, dedicated: dedicatedIds, placements: [], running: null, sharedLeftover: null, sharedRegistry: null, twins: r.twins,
    }
    return planProjectDeleteTeardown(facts)
  }

  it('★★★ 覆う複製あり → HANAMII は破棄から外れ twinned に入る', async () => {
    write(self, FULL_HANAMII)
    sib('copy', FULL_HANAMII)
    const plan = await planFor(['hanamii'], null)
    expect(plan.teardown).toEqual([])
    expect(plan.twinned).toEqual([{ target: 'hanamii', folders: ['copy'] }])
    expect(plan.block).toBeNull()
  })

  it('★★★ 検分の再現: 重なるが覆わない複製（保存場所を作る前のバックアップ）→ HANAMII は破棄に入ったまま。twinned は空', async () => {
    write(self, FULL_HANAMII)
    sib('backup', { meta: hanamii('prj-1') })
    const plan = await planFor(['hanamii'], null)
    expect(plan.teardown).toEqual(['hanamii'])
    expect(plan.twinned).toEqual([])
  })

  it('★★★ 専有型: 覆う複製あり → 止めを外す・twinned に入る。重なるだけの複製 → 止める（dedicated）。覆われるほう（部分）からは外れる', async () => {
    const IDS = { applicationID: 'ap-1', clusterID: 'cl-1', loadBalancerID: 'lb-1', asgID: 'asg-1' }
    write(self, { meta: dedicated({ ...IDS }), env: env(['koto-a', P]) })
    sib('backup', { meta: dedicated({ applicationID: 'ap-1' }) })
    const partial = await planFor(['sakura-apprun-dedicated'], IDS)
    expect(partial.block).toEqual({ reason: 'dedicated' })
    expect(partial.twinned).toEqual([])

    sib('full', { meta: dedicated({ ...IDS }), env: env(['koto-a', P]) })
    const full = await planFor(['sakura-apprun-dedicated'], IDS)
    expect(full.block).toBeNull()
    expect(full.twinned).toEqual([{ target: 'sakura-apprun-dedicated', folders: ['full'] }])

    // 覆われるほう（バックアップ）を削除する側から見ると、元が覆うので止めは外れる（行き止まりにならない）
    self = path.join(ws, 'backup')
    const covered = await planFor(['sakura-apprun-dedicated'], { applicationID: 'ap-1' })
    expect(covered.block).toBeNull()
    expect(covered.twinned.map(x => x.folders)).toEqual([['full', 'myapp']])
  })
})

// ── main の移す口（fs:trashProject）─────────────────────────────────────────────────
// 専有型の止めを外す条件は、画面が外したと言う（skippedForTwins）ことと、覆う複製がいまもあること。**両方がそろったときだけ**（R2-e。振る舞いは tests/trashSkippedForTwins.test.ts）。
describe('★★★ fs:trashProject の専有型の止め: 覆う複製があるときだけ外す。重なるだけでは断る。移す要求0件', () => {
  const IDS = { applicationID: 'ap-1', clusterID: 'cl-1', loadBalancerID: 'lb-1', asgID: 'asg-1' }
  const SKIP = { confirmed: true, skippedForTwins: ['sakura-apprun-dedicated'] }
  const NONE = { confirmed: true, skippedForTwins: [] }

  it('★★★ 部分だけを持つ複製（重なるが覆わない）→ 専有型が残っているので断る。shell.trashItem は0回', async () => {
    write(self, { meta: dedicated({ ...IDS }), env: env(['koto-a', P]) })
    sib('backup', { meta: dedicated({ applicationID: 'ap-1' }) })
    expect(await call('fs:trashProject', self, NONE)).toEqual({ ok: false, message: FS_TRASH_MESSAGES.dedicated })
    // 画面が外したと言っても、覆う複製が無いので移さない（読み直して見つからない）
    expect(await call('fs:trashProject', self, SKIP)).toEqual({ ok: false, message: FS_TRASH_MESSAGES.twinsGone, reason: 'twins-gone' })
    expect(m.trashItem.mock.calls).toEqual([])
  })

  it('★★★ 覆う複製 → 画面が外したと言えば移す（1回）。外したと言わなければ、複製がいても断る', async () => {
    write(self, { meta: dedicated({ ...IDS }), env: env(['koto-a', P]) })
    sib('full', { meta: dedicated({ ...IDS }), env: env(['koto-a', P]) })
    expect(await call('fs:trashProject', self, NONE)).toEqual({ ok: false, message: FS_TRASH_MESSAGES.dedicated })
    expect(m.trashItem.mock.calls).toEqual([])
    expect(await call('fs:trashProject', self, SKIP)).toEqual({ ok: true })
    expect(m.trashItem.mock.calls).toEqual([[self]])
  })

  it('★★★ 覆われるほう（バックアップ）を削除する → 元が覆うので移せる', async () => {
    write(self, { meta: dedicated({ ...IDS }), env: env(['koto-a', P]) })
    const backup = sib('backup', { meta: dedicated({ applicationID: 'ap-1' }) })
    expect(await call('fs:trashProject', backup, SKIP)).toEqual({ ok: true })
    expect(m.trashItem.mock.calls).toEqual([[backup]])
  })

  it.skipIf(rootIsMe)('★★ 親フォルダの一覧を読めない（0o311）→ 覆う複製を確かめられない。外したと言えば「確かめられない」（R3-e）、言わなければ専有型が残っているまま断る', async () => {
    write(self, { meta: dedicated({ ...IDS }) })
    sib('full', { meta: dedicated({ ...IDS }) })
    fs.chmodSync(ws, 0o311)
    expect(await call('fs:trashProject', self, SKIP)).toEqual({ ok: false, message: FS_TRASH_MESSAGES.twinsUnknown, reason: 'twins-gone' })
    expect(await call('fs:trashProject', self, NONE)).toEqual({ ok: false, message: FS_TRASH_MESSAGES.dedicated })
    expect(m.trashItem.mock.calls).toEqual([])
  })
})

// ── R3-a: 鍵の ID だけが違う A・B は、互いに覆う（再公開のたびに置き換わる値を事実に数えない）──────────────────────────────────────
// 検分で実測した形: 複製 B を写したあと、元 A を1回再公開した。A の鍵（storagePermissionId）は新しくなり、B は古いまま。4つの ID・保存場所・レジストリは同じ。
// 鍵を事実に数えると、どちらもどちらを覆わず、専有型では画面の止め・main の止め・骨の断りの3つに断られて、どちらのフォルダも破棄も削除もできなかった。
// 鍵は R2-i（permissionHeldByOthersFs）が ID そのもので別に守る。本物の cloud:recordTwins・fs:trashProject に流し、shell.trashItem の呼ばれた一覧で見る（掟10）。
describe('★★★ R3-a 検分の再現: 4つの ID が同じで鍵だけが違う A・B は、互いに覆う。どちらからも移せる（行き止まりにならない）', () => {
  const IDS = { applicationID: 'ap-1', clusterID: 'cl-1', loadBalancerID: 'lb-1', asgID: 'asg-1' }
  const DED = (perm?: string): Rec => ({ meta: dedicated({ ...IDS, ...(perm ? { storagePermissionId: perm } : {}) }), env: env(['koto-a', P]) })
  const SHARED = (perm?: string): Rec => ({ state: state({ apps: ['a-1'], buckets: [['koto-a', P]], registry: 'reg-1', ...(perm ? { perm } : {}) }), env: env(['koto-a', P]) })
  const SKIP_DED = { confirmed: true, skippedForTwins: ['sakura-apprun-dedicated'] }
  const SKIP_SHARED = { confirmed: true, skippedForTwins: ['sakura-apprun'] }

  it.each([
    ['新しい鍵（元を再公開した）と古い鍵', 'perm-new', 'perm-old'],
    ['鍵が無い（写したあとに鍵を発行した）と古い鍵', undefined, 'perm-old'],
    ['古い鍵と鍵が無い', 'perm-old', undefined],
  ] as Array<[string, string | undefined, string | undefined]>)('★★★ 専有型（%s）: recordCoverFs が互いを返す。画面の plan は止めを外し、main は両方から移す', async (_label, permA, permB) => {
    const a = write(self, DED(permA))
    const b = sib('copy', DED(permB))
    // 互いに覆う（どちらの側から見ても、もう一方が覆う）
    expect(recordCoverFs(a, 'sakura-apprun-dedicated')).toEqual(['copy'])
    expect(recordCoverFs(b, 'sakura-apprun-dedicated')).toEqual(['myapp'])
    // 画面: cloud:recordTwins の答えから plan。止め（dedicated）が外れ、twinned に入る
    const facts = (twins: unknown): ProjectDeleteFacts => ({
      targets: ['sakura-apprun-dedicated'], unreadable: false, dedicated: IDS, placements: [], running: null, sharedLeftover: null, sharedRegistry: null, twins: twins as ProjectDeleteFacts['twins'],
    })
    const ra = await call('cloud:recordTwins', a)
    expect(ra).toMatchObject({ ok: true, twins: { 'sakura-apprun-dedicated': ['copy'] } })
    const planA = planProjectDeleteTeardown(facts(ra.twins))
    expect(planA.block).toBeNull()
    expect(planA.twinned).toEqual([{ target: 'sakura-apprun-dedicated', folders: ['copy'] }])
    const rb = await call('cloud:recordTwins', b)
    expect(planProjectDeleteTeardown(facts(rb.twins)).block).toBeNull()
    // main: 画面が外したと言えば、A からも B からも移せる（外したと言わなければ、複製がいても専有型の文で断る）
    expect(await call('fs:trashProject', a, { confirmed: true, skippedForTwins: [] })).toEqual({ ok: false, message: FS_TRASH_MESSAGES.dedicated })
    expect(m.trashItem.mock.calls).toEqual([])
    expect(await call('fs:trashProject', b, SKIP_DED)).toEqual({ ok: true })
    expect(m.trashItem.mock.calls).toEqual([[b]])
    fs.rmSync(b, { recursive: true }) // 移した（偽の trashItem はフォルダを動かさないので、ここで無くす）
    expect(await call('fs:trashProject', a, SKIP_DED)).toMatchObject({ ok: false, reason: 'twins-gone' }) // A は最後の1つになるので、移さない
    expect(m.trashItem.mock.calls).toEqual([[b]])
  })

  it('★★★ 専有型: A を先に移せる（B が残るので、A の側の止めを外す）。要求は A の1回だけ', async () => {
    const a = write(self, DED('perm-new'))
    sib('copy', DED('perm-old'))
    expect(await call('fs:trashProject', a, SKIP_DED)).toEqual({ ok: true })
    expect(m.trashItem.mock.calls).toEqual([[a]])
  })

  it('★★★ 共用型（鍵 perm-new と perm-old）: recordCoverFs が互いを返す。cloud:recordTwins は覆う複製を返し、plan は共用型の破棄を外す。main は両方から移す', async () => {
    const a = write(self, SHARED('perm-new'))
    const b = sib('copy', SHARED('perm-old'))
    expect(recordCoverFs(a, 'sakura-apprun')).toEqual(['copy'])
    expect(recordCoverFs(b, 'sakura-apprun')).toEqual(['myapp'])
    const ra = await call('cloud:recordTwins', a)
    expect(ra).toMatchObject({ ok: true, twins: { 'sakura-apprun': ['copy'] } })
    const plan = planProjectDeleteTeardown({
      targets: ['sakura-apprun'], unreadable: false, dedicated: null, placements: [], running: null, sharedLeftover: null, sharedRegistry: null, twins: ra.twins,
    })
    expect(plan.teardown).toEqual([])
    expect(plan.twinned).toEqual([{ target: 'sakura-apprun', folders: ['copy'] }])
    expect(await call('fs:trashProject', b, SKIP_SHARED)).toEqual({ ok: true })
    fs.rmSync(b, { recursive: true }) // 移した（偽の trashItem はフォルダを動かさないので、ここで無くす）
    expect(await call('fs:trashProject', a, SKIP_SHARED)).toMatchObject({ ok: false, reason: 'twins-gone' }) // A は最後の1つ
    expect(m.trashItem.mock.calls).toEqual([[b]])
  })

  it('★★ 対照: 鍵以外が違えば、今までどおり覆わない（レジストリ違い・保存場所違い・ID 違い）', () => {
    write(self, DED('perm-new'))
    sib('other-place', { meta: dedicated({ ...IDS, storagePermissionId: 'perm-old' }), env: env(['koto-b', P]) })
    sib('other-id', { meta: dedicated({ ...IDS, asgID: 'asg-9', storagePermissionId: 'perm-old' }), env: env(['koto-a', P]) })
    expect(recordCoverFs(self, 'sakura-apprun-dedicated')).toEqual([])
    expect(recordTwinsFs(self, 'sakura-apprun-dedicated')).toEqual(['other-id', 'other-place']) // 重なるのは重なるまま（I-2）
  })
})
