import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

// ── cloud:twinFacts: 破棄を押す前に、複製（同じ親フォルダの別のフォルダ）を記録から読む口 ──────────────────────────────────
// 返すのは2つ。公開先の断り（refusal）は3つの破棄の骨の `twinsOf`（recordTwinsFs）と同じ答え、保存場所ごとの「消さずに残す」（keep）は
// 保存場所の破棄（teardownPlanFor）・記録の鍵に触れるかの判断（placementsHaveTwinRisk）と同じ `twinRiskOf` の答え。判断を2つ書かない。
// 実フォルダに記録を置き、本物の `registerCloudTeardownHandlers` の IPC を呼んで固定する。**読むだけ**（フォルダの中身は1バイトも変わらない）・**投げない**・
// 正しくない引数は `{ ok: false }`。
// 変異: refusal を recordTwinsFs と別の判定にする／unknown を空（null）にする／keep を twinRiskOf と別の判定にする。

const m = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { m.handlers.set(channel, fn) } },
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test', on: () => {} },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {} },
  dialog: {},
}))

import { registerCloudTeardownHandlers, SHARED_TEARDOWN_SHELL } from '../src/main/ipc/cloudTeardown'
import { HANAMII_TEARDOWN_SHELL } from '../src/main/ipc/hanamiiTeardown'
import { DEDICATED_TEARDOWN_SHELL } from '../src/main/ipc/apprunDedicatedTeardown'
import { readTwinFacts } from '../src/main/cloud/twinFacts'
import { recordTwinsFs, TWIN_TARGETS } from '../src/main/cloud/recordTwins'
import { bucketUsersFromRecords } from '../src/main/cloud/bucketUsers'
import { placementsHaveTwinRisk } from '../src/main/cloud/storageTeardown'
import { twinRiskOf, teardownPlanFor, folderNamesText } from '../src/shared/objectStorage'

const ROOT = path.join(__dirname, '..')
const src = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
const rootIsMe = typeof process.getuid === 'function' && process.getuid() === 0
const skipIfRoot = rootIsMe ? it.skip : it

const CONSENTED_AT = '2026-10-19T00:00:00.000Z'
const B = 'koto-twin-facts'
const PFX = 'projects/myapp/'

let ws = ''
let self = ''
const call = async (...args: unknown[]) => m.handlers.get('cloud:twinFacts')!({}, ...args)
const facts = (target: string, placements: Array<{ bucket: string; prefix: string }> = []) => call(self, { target, placements })
beforeEach(() => {
  m.handlers.clear()
  registerCloudTeardownHandlers()
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koto-twin-facts-')))
  self = path.join(ws, 'myapp')
})
afterEach(() => {
  try { fs.chmodSync(ws, 0o755) } catch { /* 片づけ */ }
  for (const e of fs.existsSync(ws) ? fs.readdirSync(ws) : []) try { fs.chmodSync(path.join(ws, e), 0o755) } catch { /* 片づけ */ }
  fs.rmSync(ws, { recursive: true, force: true })
})

type Files = { meta?: unknown; state?: unknown; env?: unknown }
/** `dir` にフォルダを作り、記録を置く（文字列はそのまま書く＝壊れた記録も作れる。`undefined` は置かない）。 */
function make(dir: string, files: Files = {}): string {
  fs.mkdirSync(dir, { recursive: true })
  const put = (file: string, v: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v)) }
  if (files.meta !== undefined) put(path.join(dir, '.sakuraide.json'), files.meta)
  if (files.state !== undefined) put(path.join(dir, '.sakura-cloud', 'state.json'), files.state)
  if (files.env !== undefined) put(path.join(dir, '.sakura-cloud', 'env.json'), files.env)
  return dir
}
const hanamiiMeta = (projectId: string) => ({ publish: { hanamii: { projectId }, targets: { hanamii: { publishedAt: CONSENTED_AT } } } })
const appState = (id: string) => ({ name: 'myapp', backend: 'apprun', resources: [{ kind: 'apprun-app', id, key: 'apprun-app:myapp', stateful: false }] })
const dedicatedMeta = (rec: Record<string, unknown>) => ({ publish: { apprunDedicated: rec } })
/** 同意済みの保存場所を1つ持つ env.json（公開の記録は付けない＝「用意しただけ」の形）。 */
const envWith = (bucket: string, prefix: string) => ({ persistence: { objectStorage: [{ bucket, prefix, shared: true, consentedAt: CONSENTED_AT }] } })
const bucketState = (bucket: string, prefix: string) => ({ name: 'x', backend: 'apprun', resources: [{ kind: 'bucket', id: bucket, key: `bucket:${bucket}`, stateful: true, prefix }] })

/** フォルダの全中身（パス → 内容の sha256）。読むだけの口が何も書かないことを見る。 */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      out[path.relative(ws, p)] = e.isDirectory() ? 'dir' : crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
      if (e.isDirectory()) walk(p)
    }
  }
  walk(dir)
  return out
}

const SHELL_TWINS_OF: Record<string, (dir: string) => string[] | 'unknown'> = {
  hanamii: d => HANAMII_TEARDOWN_SHELL.twinsOf(d),
  'sakura-apprun': d => SHARED_TEARDOWN_SHELL.twinsOf(d),
  'sakura-apprun-dedicated': d => DEDICATED_TEARDOWN_SHELL.twinsOf(d),
}

describe('★★★ 登録の配線: IPC の名前 cloud:twinFacts から本物の関数を呼ぶ', () => {
  it('registerCloudTeardownHandlers が cloud:twinFacts を登録している（cloud:teardown・cloud:teardownRecord・cloud:recordTwins と並んで）', () => {
    for (const ch of ['cloud:teardown', 'cloud:teardownRecord', 'cloud:recordTwins', 'cloud:twinFacts']) expect(m.handlers.has(ch), ch).toBe(true)
  })

  it('★★★ IPC の答えは readTwinFacts の答えと同じ（引数をそのまま渡している）', async () => {
    make(self, { meta: hanamiiMeta('prj-1') })
    make(path.join(ws, 'copy'), { meta: hanamiiMeta('prj-1'), env: envWith(B, PFX) })
    const args = { target: 'hanamii', placements: [{ bucket: B, prefix: PFX }] }
    const viaIpc = await call(self, args)
    expect(viaIpc).toEqual(readTwinFacts(self, args))
    expect(viaIpc.ok).toBe(true)
    expect(viaIpc.refusal).toEqual({ kind: 'twin', folders: ['copy'] }) // 偽の一致（どちらも ok:false）ではないこと
  })
})

describe('★★★ refusal: 3つの破棄の骨の twinsOf（recordTwinsFs）と同じ答え', () => {
  it('★★★ 同じ projectId・同じ apprun-app の id・同じ clusterID の兄弟 → twin とフォルダ名。3つの骨の twinsOf と突き合わせる', async () => {
    make(self, { meta: { publish: { ...hanamiiMeta('prj-1').publish, apprunDedicated: { clusterID: 'cl-1' } } }, state: appState('app-1') })
    make(path.join(ws, 'hanamii copy'), { meta: hanamiiMeta('prj-1') })
    make(path.join(ws, 'shared copy'), { state: appState('app-1') })
    make(path.join(ws, 'dedicated copy'), { meta: dedicatedMeta({ clusterID: 'cl-1' }) })
    make(path.join(ws, 'other'), { meta: hanamiiMeta('prj-9'), state: appState('app-9') })
    const expected: Record<string, string[]> = { hanamii: ['hanamii copy'], 'sakura-apprun': ['shared copy'], 'sakura-apprun-dedicated': ['dedicated copy'] }
    for (const t of TWIN_TARGETS) {
      const r = await facts(t)
      expect(r, t).toEqual({ ok: true, refusal: { kind: 'twin', folders: expected[t] }, placements: [] })
      expect(SHELL_TWINS_OF[t](self), t).toEqual(expected[t]) // 骨の twinsOf と同じ名前
      expect(r.refusal.folders, t).toEqual(SHELL_TWINS_OF[t](self))
      expect(r.refusal.folders, t).toEqual(recordTwinsFs(self, t))
    }
  })

  it('★★★ 識別子の一部だけを持つ兄弟（専有型の asgID だけ）も断る側＝「覆う」ではなく「重なる」の判断（recordTwinsFs）', async () => {
    make(self, { meta: dedicatedMeta({ applicationID: 'ap-1', asgID: 'asg-1' }) })
    make(path.join(ws, 'full'), { meta: dedicatedMeta({ applicationID: 'ap-1', asgID: 'asg-1' }) })
    make(path.join(ws, 'partial'), { meta: dedicatedMeta({ asgID: 'asg-1' }) })
    const r = await facts('sakura-apprun-dedicated')
    expect(r.refusal).toEqual({ kind: 'twin', folders: ['full', 'partial'] })
    expect(r.refusal.folders).toEqual(DEDICATED_TEARDOWN_SHELL.twinsOf(self))
  })

  it('複製がいない → refusal は null（3つの公開先とも）。自分の記録に識別子が無い → null。公開先ごとに別々に判断する', async () => {
    make(self, { meta: hanamiiMeta('prj-1'), state: appState('app-1') })
    make(path.join(ws, 'other'), { meta: hanamiiMeta('prj-2'), state: appState('app-2') })
    for (const t of TWIN_TARGETS) expect((await facts(t)).refusal, t).toBeNull()
    // HANAMII の記録だけが重なる兄弟は、HANAMII でだけ断る（共用型・専有型は null）
    make(path.join(ws, 'h only'), { meta: hanamiiMeta('prj-1') })
    expect((await facts('hanamii')).refusal).toEqual({ kind: 'twin', folders: ['h only'] })
    expect((await facts('sakura-apprun')).refusal).toBeNull()
    expect((await facts('sakura-apprun-dedicated')).refusal).toBeNull()
    fs.rmSync(self, { recursive: true, force: true })
    make(self, { meta: { publish: {} } })
    for (const t of TWIN_TARGETS) expect((await facts(t)).refusal, t).toBeNull()
  })

  it('★★★ 読めない兄弟だけの公開先 → refusal は null（骨と同じ。読めない兄弟は数えない）。keep の側は別の守りで unread になる', async () => {
    make(self, { meta: hanamiiMeta('prj-1') })
    make(path.join(ws, 'broken'), { meta: '{ 壊れた', env: '{ 壊れた' })
    const r = await facts('hanamii', [{ bucket: B, prefix: PFX }])
    expect(r.refusal).toBeNull()
    expect(HANAMII_TEARDOWN_SHELL.twinsOf(self)).toEqual([])
    expect(r.placements).toEqual([{ bucket: B, prefix: PFX, keep: { risk: 'unread', folders: ['broken'] } }])
  })

  skipIfRoot('★★★ 親フォルダの一覧を読めない → refusal は unknown（空にしない）。骨の twinsOf も unknown。keep は unread で、名前は挙げられない', async () => {
    make(self, { meta: { publish: { ...hanamiiMeta('prj-1').publish, apprunDedicated: { clusterID: 'cl-1' } } }, state: appState('app-1'), env: envWith(B, PFX) })
    make(path.join(ws, 'copy'), { meta: hanamiiMeta('prj-1'), state: appState('app-1') })
    fs.chmodSync(ws, 0o311) // 所有者は辿れるが、一覧は読めない
    try {
      for (const t of TWIN_TARGETS) {
        const r = await facts(t, [{ bucket: B, prefix: PFX }])
        expect(r, t).toEqual({ ok: true, refusal: { kind: 'unknown' }, placements: [{ bucket: B, prefix: PFX, keep: { risk: 'unread', folders: [] } }] })
        expect(SHELL_TWINS_OF[t](self), t).toBe('unknown')
      }
    } finally {
      fs.chmodSync(ws, 0o755)
    }
  })
})

describe('★★★ keep: 保存場所の破棄と同じ twinRiskOf の答え', () => {
  it('★★★ 同じバケット・同じ prefix で公開の記録なし（用意しただけ）→ twin とフォルダ名。env.json でも state.json の bucket 資源でも', async () => {
    make(self, { env: envWith(B, PFX) })
    make(path.join(ws, 'a-copy'), { env: envWith(B, PFX) })
    make(path.join(ws, 'b-state-copy'), { state: bucketState(B, PFX) })
    make(path.join(ws, 'other-prefix'), { env: envWith(B, 'projects/other/') })
    make(path.join(ws, 'other-bucket'), { env: envWith('koto-other', PFX) })
    const r = await facts('sakura-apprun', [{ bucket: B, prefix: PFX }])
    expect(r.ok).toBe(true)
    expect(r.placements).toEqual([{ bucket: B, prefix: PFX, keep: { risk: 'twin', folders: ['a-copy', 'b-state-copy'] } }])
  })

  it('★★★ 複製がいない保存場所は keep が null。渡した並び・同じ件数で、保存場所ごとに答える（twin と null の混在）', async () => {
    make(self, { env: envWith(B, PFX) })
    make(path.join(ws, 'copy'), { env: envWith(B, PFX) })
    const asked = [
      { bucket: 'koto-clear', prefix: PFX },
      { bucket: B, prefix: PFX },
      { bucket: B, prefix: 'projects/nobody/' },
      { bucket: B, prefix: '' },
    ]
    const r = await facts('hanamii', asked)
    expect(r.placements).toEqual([
      { bucket: 'koto-clear', prefix: PFX, keep: null },
      { bucket: B, prefix: PFX, keep: { risk: 'twin', folders: ['copy'] } },
      { bucket: B, prefix: 'projects/nobody/', keep: null },
      { bucket: B, prefix: '', keep: null }, // prefix が空なら複製とは数えない（破棄の本体と同じ）
    ])
  })

  it('★★★ 兄弟の env.json が壊れている → unread とそのフォルダ名。state.json が壊れていても同じ。.sakuraide.json だけが壊れた兄弟は unread にしない', async () => {
    make(self, {})
    make(path.join(ws, 'broken-env'), { env: '{ 壊れた' })
    expect((await facts('hanamii', [{ bucket: B, prefix: PFX }])).placements)
      .toEqual([{ bucket: B, prefix: PFX, keep: { risk: 'unread', folders: ['broken-env'] } }])
    fs.rmSync(path.join(ws, 'broken-env'), { recursive: true, force: true })
    make(path.join(ws, 'broken-state'), { state: '{ 壊れた' })
    expect((await facts('hanamii', [{ bucket: B, prefix: PFX }])).placements)
      .toEqual([{ bucket: B, prefix: PFX, keep: { risk: 'unread', folders: ['broken-state'] } }])
    fs.rmSync(path.join(ws, 'broken-state'), { recursive: true, force: true })
    make(path.join(ws, 'broken-meta-only'), { meta: '{ 壊れた', env: envWith('koto-other', 'projects/z/') })
    expect((await facts('hanamii', [{ bucket: B, prefix: PFX }])).placements)
      .toEqual([{ bucket: B, prefix: PFX, keep: null }])
  })

  it('★★★ twin と unread が両方いる → twin（名前は複製のフォルダ。読めない兄弟の名前は混ぜない）', async () => {
    make(self, {})
    make(path.join(ws, 'copy'), { env: envWith(B, PFX) })
    make(path.join(ws, 'broken'), { env: '{ 壊れた' })
    const r = await facts('hanamii', [{ bucket: B, prefix: PFX }])
    expect(r.placements[0].keep).toEqual({ risk: 'twin', folders: ['copy'] })
  })

  it('★★★ 判断は破棄の本体と同じ1つ: keep の有無は twinRiskOf・placementsHaveTwinRisk と一致し、名前は teardownPlanFor の note が言う名前と同じ', async () => {
    make(self, { env: envWith(B, PFX) })
    make(path.join(ws, 'copy'), { env: envWith(B, PFX) })
    make(path.join(ws, 'broken'), { env: '{ 壊れた' })
    const worlds: Array<{ bucket: string; prefix: string }> = [
      { bucket: B, prefix: PFX },
      { bucket: B, prefix: 'projects/nobody/' },
      { bucket: 'koto-clear', prefix: PFX },
      { bucket: B, prefix: '' },
    ]
    const r = await facts('hanamii', worlds)
    expect(r.placements.some((p: any) => p.keep?.risk === 'twin')).toBe(true) // 偽の一致（全部 null どうし）ではないこと
    for (const [i, p] of worlds.entries()) {
      const users = bucketUsersFromRecords(self, p.bucket, p.prefix)
      const risk = twinRiskOf(users)
      const keep = r.placements[i].keep
      expect(keep?.risk ?? null, `${p.bucket} ${p.prefix}`).toBe(risk)
      expect(keep !== null, `${p.bucket} ${p.prefix}`).toBe(placementsHaveTwinRisk(self, [p]))
      const plan = teardownPlanFor({ ...p, shared: true, consentedAt: CONSENTED_AT } as any, [], users)
      expect(plan.keptData === true, `${p.bucket} ${p.prefix}`).toBe(keep !== null)
      if (keep?.risk === 'twin') expect(plan.note).toContain(folderNamesText(keep.folders))
    }
  })
})

describe('★★★ 読むだけ・投げない', () => {
  it('★★★ 複製・読めない兄弟がいる世界でも、フォルダの中身は1バイトも変わらない（何も書かない・何も消さない）', async () => {
    const both = { publish: { ...hanamiiMeta('prj-1').publish, apprunDedicated: { clusterID: 'cl-1' } } }
    make(self, { meta: both, state: appState('app-1'), env: envWith(B, PFX) })
    make(path.join(ws, 'copy'), { meta: both, state: appState('app-1'), env: envWith(B, PFX) })
    make(path.join(ws, 'broken'), { env: '{ 壊れた' })
    const before = snapshot(ws)
    expect(Object.keys(before).length).toBeGreaterThan(6)
    for (const t of TWIN_TARGETS) {
      const r = await facts(t, [{ bucket: B, prefix: PFX }])
      expect(r.ok, t).toBe(true)
      expect(r.refusal, t).toEqual({ kind: 'twin', folders: ['copy'] })
    }
    expect(snapshot(ws)).toEqual(before)
  })

  it('存在しないフォルダ・自分の記録が無いフォルダ: 投げずに答える（refusal は null）', async () => {
    make(path.join(ws, 'other'), { meta: hanamiiMeta('prj-1') })
    expect(await call(path.join(ws, 'no-such-dir'), { target: 'hanamii', placements: [] })).toEqual({ ok: true, refusal: null, placements: [] })
    make(self, {})
    expect(await facts('hanamii')).toEqual({ ok: true, refusal: null, placements: [] })
  })

  it('返す保存場所は bucket・prefix・keep だけ（渡した項目のうち余計なものは写さない）。空の一覧は空で返す', async () => {
    make(self, {})
    const r = await call(self, { target: 'hanamii', placements: [{ bucket: B, prefix: PFX, keepData: true, extra: 'x' }] })
    expect(Object.keys(r.placements[0]).sort()).toEqual(['bucket', 'keep', 'prefix'])
    expect((await facts('hanamii', [])).placements).toEqual([])
  })
})

describe('★★★ 正しくない引数は { ok: false }（投げない）', () => {
  const GOOD = { target: 'hanamii', placements: [{ bucket: B, prefix: PFX }] }
  const NG = { ok: false }

  it.each([undefined, null, '', 5, {}, [], true, 'relative/dir'])('★★ projectDir が正しくない（%j）', async (bad) => {
    expect(readTwinFacts(bad, GOOD)).toEqual(NG)
    expect(await call(bad, GOOD)).toEqual(NG)
  })

  it.each<[string, unknown]>([
    ['未指定', undefined],
    ['null', null],
    ['配列', []],
    ['文字列', 'hanamii'],
    ['項目なし', {}],
    ['公開先が3つのどれでもない（vercel）', { target: 'vercel', placements: [] }],
    ['公開先が文字列でない', { target: 5, placements: [] }],
    ['公開先なし', { placements: [] }],
    ['保存場所なし', { target: 'hanamii' }],
    ['保存場所が配列でない', { target: 'hanamii', placements: 'x' }],
    ['保存場所に null', { target: 'hanamii', placements: [null] }],
    ['保存場所が文字列', { target: 'hanamii', placements: ['b'] }],
    ['bucket が文字列でない', { target: 'hanamii', placements: [{ bucket: 1, prefix: '' }] }],
    ['prefix なし', { target: 'hanamii', placements: [{ bucket: 'b' }] }],
    ['prefix が文字列でない', { target: 'hanamii', placements: [{ bucket: 'b', prefix: null }] }],
    ['良い保存場所の後ろに悪いもの', { target: 'hanamii', placements: [{ bucket: B, prefix: PFX }, { bucket: 'b' }] }],
    ['空き要素', { target: 'hanamii', placements: new Array(2) }],
  ])('★★ 第2引数が正しくない: %s', async (_name, bad) => {
    make(self, {})
    expect(readTwinFacts(self, bad)).toEqual(NG)
    expect(await call(self, bad)).toEqual(NG)
  })

  it('引数が足りない呼び出し（第2引数なし）も投げずに ok:false', async () => {
    make(self, {})
    expect(await call(self)).toEqual(NG)
  })
})

describe('★★ 3点セット（掟6）と、型の置き場所が1つであること', () => {
  it('main・preload・global.d.ts の3点が揃い、cloud の節の recordTwins の隣にある', () => {
    const teardown = src('src/main/ipc/cloudTeardown.ts')
    expect(teardown).toContain("ipcMain.handle('cloud:twinFacts', (_event, projectDir: unknown, args: unknown) => readTwinFacts(projectDir, args))")
    expect(teardown.split("ipcMain.handle('cloud:twinFacts'").length - 1, 'main の登録は1か所').toBe(1)
    expect(teardown.indexOf("ipcMain.handle('cloud:twinFacts'")).toBeGreaterThan(teardown.indexOf("ipcMain.handle('cloud:recordTwins'"))
    expect(src('src/main/ipc/cloud.ts')).not.toContain('twinFacts')

    const preload = src('src/main/preload.ts')
    expect(preload).toContain("twinFacts: (projectDir: string, args: TwinFactsArgs) => ipcRenderer.invoke('cloud:twinFacts', projectDir, args),")
    expect(preload.split("ipcRenderer.invoke('cloud:twinFacts'").length - 1, 'preload の呼び出しは1か所').toBe(1)
    expect(preload.indexOf("ipcRenderer.invoke('cloud:twinFacts'")).toBeGreaterThan(preload.indexOf("ipcRenderer.invoke('cloud:recordTwins'"))
    expect(preload.indexOf("ipcRenderer.invoke('cloud:twinFacts'")).toBeLessThan(preload.indexOf("ipcRenderer.invoke('cloud:registryName'"))

    const dts = src('src/renderer/global.d.ts')
    expect(dts).toContain('twinFacts(projectDir: string, args: TwinFactsArgsShape): Promise<TwinFactsResultShape>')
    expect(dts.split('twinFacts(projectDir: string').length - 1, 'global.d.ts の宣言は1か所').toBe(1)
    expect(dts.indexOf('twinFacts(projectDir: string')).toBeGreaterThan(dts.indexOf('recordTwins(projectDir: string)'))
    expect(dts.indexOf('twinFacts(projectDir: string')).toBeLessThan(dts.indexOf('registryName(projectDir: string)'))
  })

  it('★★ 型は src/shared/twinFactsTypes.ts の1か所だけ。global.d.ts・twinFacts.ts・preload はそれを引くだけで、形を書き直さない', () => {
    const dts = src('src/renderer/global.d.ts')
    expect(dts).toContain("type TwinFactsArgsShape = import('../shared/twinFactsTypes').TwinFactsArgs")
    expect(dts).toContain("type TwinFactsResultShape = import('../shared/twinFactsTypes').TwinFactsResult")
    expect(dts).not.toContain("risk: 'twin'")
    const code = src('src/main/cloud/twinFacts.ts')
    expect(code).toContain("from '../../shared/twinFactsTypes'")
    expect(code).not.toContain("risk: 'twin'")
    expect(src('src/main/preload.ts')).toContain("import type { TwinFactsArgs } from '../shared/twinFactsTypes'")
    // 保存場所ごとの keep の形（risk の2値）を書くのは、型のファイルだけ
    const holders: string[] = []
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(e.name) && fs.readFileSync(p, 'utf-8').includes("risk: 'twin' | 'unread'")) holders.push(path.relative(ROOT, p))
      }
    }
    walk(path.join(ROOT, 'src'))
    expect(holders).toEqual(['src/shared/twinFactsTypes.ts'])
  })

  it('twinFacts.ts は electron に依存せず200行以内。判断は recordTwinsFs・bucketUsersFromRecords・twinRiskOf を呼ぶだけ（自分で兄弟を歩かない）', () => {
    const code = src('src/main/cloud/twinFacts.ts')
    expect(code).not.toContain("from 'electron'")
    expect(code).not.toContain('readdirSync')
    expect(code).toContain('const twins = recordTwinsFs(projectDir, target)')
    expect(code).toContain('const users = bucketUsersFromRecords(projectDir, p.bucket, p.prefix)')
    expect(code).toContain('const risk = twinRiskOf(users)')
    expect(code.split('\n').length).toBeLessThanOrEqual(200)
    expect(src('src/shared/twinFactsTypes.ts')).not.toMatch(/^import /m)
  })
})
