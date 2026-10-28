import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

// ── cloud:recordTwins（0.6.24 I-3）: プロジェクトの削除の画面が、複製のある公開先を知るための口 ──────────────────────────────────
// 複製（同じ親フォルダの別のフォルダで、同じ公開の記録を持つもの）の判断は main に1つ。この口は「覆う」（`recordCoverFs`。R2-d）、3つの破棄の骨の `twinsOf` は「重なる」（`recordTwinsFs`）（U6）。
// この口は、画面にその答えを渡すだけ。**読むだけ**（フォルダの中身は1バイトも変わらない・外へ要求を出さない）・**投げない**・不正な引数は ok:false。
// ここで固定するもの:
//   ・本物の `registerCloudTeardownHandlers` が、IPC の名前（cloud:recordTwins）で登録している（守りの関数が正しくても、登録が無ければ画面は読めない）
//   ・3つの公開先それぞれ、同じ projectId／apprun-app の id／clusterID を持つ兄弟の名前が返る。**3つの破棄の骨の twinsOf と同じ答え**（判断を2つ書かない）
//   ・通す側（T-I5）: 識別子が違う／同じレジストリ名だけ／兄弟が読めない → 空
//   ・preload・global.d.ts・main の3点が揃っている（掟6）。巨大ファイル cloud.ts には何も足していない

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
import { readRecordTwins, recordCoverFs, TWIN_TARGETS } from '../src/main/cloud/recordTwins'
import { BAD_PROJECT_DIR_MESSAGE } from '../src/main/cloud/teardownShell'
import { TWIN_TARGETS as RENDERER_TWIN_TARGETS } from '../src/renderer/teardown/projectDeleteTwins'

const ROOT = path.join(__dirname, '..')
const src = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

let ws = ''
let self = ''
const call = async (...args: unknown[]) => m.handlers.get('cloud:recordTwins')!({}, ...args)
beforeEach(() => {
  m.handlers.clear()
  registerCloudTeardownHandlers()
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koto-twins-ipc-')))
  self = path.join(ws, 'myapp')
})
afterEach(() => {
  for (const e of fs.existsSync(ws) ? fs.readdirSync(ws) : []) try { fs.chmodSync(path.join(ws, e), 0o755) } catch { /* 片づけ */ }
  fs.rmSync(ws, { recursive: true, force: true })
})

type Files = { meta?: unknown; state?: unknown }
function make(dir: string, files: Files): string {
  fs.mkdirSync(dir, { recursive: true })
  const put = (file: string, v: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v)) }
  if (files.meta !== undefined) put(path.join(dir, '.sakuraide.json'), files.meta)
  if (files.state !== undefined) put(path.join(dir, '.sakura-cloud', 'state.json'), files.state)
  return dir
}
const hanamiiMeta = (projectId: string) => ({ publish: { hanamii: { projectId }, targets: { hanamii: { publishedAt: '2026-10-19T00:00:00.000Z' } } } })
const appState = (id: string, meta?: Record<string, unknown>) => ({ name: 'myapp', backend: 'apprun', resources: [{ kind: 'apprun-app', id, key: 'apprun-app:myapp', stateful: false }], ...(meta ? { meta } : {}) })
const dedicatedMeta = (rec: Record<string, unknown>) => ({ publish: { apprunDedicated: rec } })
const EMPTY = { hanamii: [], 'sakura-apprun': [], 'sakura-apprun-dedicated': [] }

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

describe('★★★ 登録の配線: IPC の名前 cloud:recordTwins から呼ぶ', () => {
  it('registerCloudTeardownHandlers が cloud:recordTwins を登録している（cloud:teardown・cloud:teardownRecord と並んで）', () => {
    for (const ch of ['cloud:teardown', 'cloud:teardownRecord', 'cloud:recordTwins']) expect(m.handlers.has(ch), ch).toBe(true)
  })

  it('★★★ 3つの公開先それぞれ: 同じ projectId・同じ apprun-app の id・同じ clusterID を持つ兄弟の名前が、公開先ごとに返る', async () => {
    make(self, { meta: { publish: { ...hanamiiMeta('prj-1').publish, apprunDedicated: { clusterID: 'cl-1' } } }, state: appState('app-1') })
    make(path.join(ws, 'hanamii copy'), { meta: hanamiiMeta('prj-1') })
    make(path.join(ws, 'shared copy'), { state: appState('app-1') })
    make(path.join(ws, 'dedicated copy'), { meta: dedicatedMeta({ clusterID: 'cl-1' }) })
    make(path.join(ws, 'other'), { meta: hanamiiMeta('prj-9'), state: appState('app-9') })
    expect(await call(self)).toEqual({
      ok: true,
      twins: { hanamii: ['hanamii copy'], 'sakura-apprun': ['shared copy'], 'sakura-apprun-dedicated': ['dedicated copy'] },
    })
  })

  it('★★★ 複製が無ければ、3つとも空の配列（ok:true）。キーは3つの公開先だけ', async () => {
    make(self, { meta: hanamiiMeta('prj-1'), state: appState('app-1') })
    make(path.join(ws, 'other'), { meta: hanamiiMeta('prj-2'), state: appState('app-2') })
    expect(await call(self)).toEqual({ ok: true, twins: EMPTY })
    expect(Object.keys((await call(self)).twins).sort()).toEqual(['hanamii', 'sakura-apprun', 'sakura-apprun-dedicated'])
  })
})

describe('★★★ 画面への答えは「覆う」（recordCoverFs）。破棄の骨の twinsOf（重なる・recordTwinsFs）とは、完全な複製では一致し、一部だけを持つ複製では違う（R2-d）', () => {
  it('完全な複製がいる世界で、cloud:recordTwins の答えは3つの破棄の骨の twinsOf と一致する（公開先ごと）。一部だけを持つ複製は twinsOf にだけ入る', async () => {
    make(self, { meta: { publish: { ...hanamiiMeta('prj-1').publish, apprunDedicated: { applicationID: 'ap-1', asgID: 'asg-1' } } }, state: appState('app-1') })
    make(path.join(ws, 'a'), { meta: hanamiiMeta('prj-1') })
    make(path.join(ws, 'b'), { state: appState('app-1') })
    make(path.join(ws, 'c'), { meta: dedicatedMeta({ applicationID: 'ap-1', asgID: 'asg-1' }) })
    make(path.join(ws, 'd'), { meta: { publish: { ...hanamiiMeta('prj-1').publish, apprunDedicated: { applicationID: 'ap-1', asgID: 'asg-1' } } }, state: appState('app-1') })
    const full = await call(self)
    expect(full.twins).toEqual({ hanamii: ['a', 'd'], 'sakura-apprun': ['b', 'd'], 'sakura-apprun-dedicated': ['c', 'd'] }) // 偽の一致（全部空どうし）ではないこと
    expect(full.twins.hanamii).toEqual(HANAMII_TEARDOWN_SHELL.twinsOf(self))
    expect(full.twins['sakura-apprun']).toEqual(SHARED_TEARDOWN_SHELL.twinsOf(self))
    expect(full.twins['sakura-apprun-dedicated']).toEqual(DEDICATED_TEARDOWN_SHELL.twinsOf(self))
    for (const t of TWIN_TARGETS) expect(full.twins[t], t).toEqual(recordCoverFs(self, t))

    // 専有型の ID の一部（asgID だけ）を持つ兄弟: 重なる（骨は断る）が、覆わない（画面は破棄を外さない）
    make(path.join(ws, 'e'), { meta: dedicatedMeta({ asgID: 'asg-1' }) })
    const withPartial = await call(self)
    expect(DEDICATED_TEARDOWN_SHELL.twinsOf(self)).toEqual(['c', 'd', 'e'])
    expect(withPartial.twins['sakura-apprun-dedicated']).toEqual(['c', 'd'])
  })

  it('複製を数える公開先は、main と画面で同じ3つ・同じ並び（書き下す）', () => {
    expect([...TWIN_TARGETS]).toEqual(['hanamii', 'sakura-apprun', 'sakura-apprun-dedicated'])
    expect([...RENDERER_TWIN_TARGETS]).toEqual([...TWIN_TARGETS])
  })
})

describe('★★ 通す側（T-I5）: 複製と数えないもの', () => {
  it('識別子が違う／同じレジストリ名・同じバケットだけ／兄弟が読めない → 空（ok:true）', async () => {
    make(self, { meta: { publish: { ...hanamiiMeta('prj-1').publish, apprunDedicated: { clusterID: 'cl-1' } } }, state: appState('app-1', { registryName: 'myreg' }) })
    make(path.join(ws, 'different'), { meta: { publish: { ...hanamiiMeta('prj-2').publish, apprunDedicated: { clusterID: 'cl-2' } } }, state: appState('app-2') })
    make(path.join(ws, 'same-registry-only'), { state: { name: 'x', backend: 'apprun', resources: [{ kind: 'bucket', id: 'koto-data-a', key: 'bucket:koto-data-a', stateful: true, prefix: 'projects/myapp/' }], meta: { registryName: 'myreg' } } })
    make(path.join(ws, 'broken'), { meta: '{ 壊れた', state: '{ 壊れた' })
    const locked = make(path.join(ws, 'locked'), { meta: hanamiiMeta('prj-1'), state: appState('app-1') })
    fs.chmodSync(locked, 0o000) // 読めない兄弟は数えない（K1。データの側は別の守り）
    try {
      expect(await call(self)).toEqual({ ok: true, twins: EMPTY })
    } finally {
      fs.chmodSync(locked, 0o755)
    }
  })

  it('自分の記録に識別子が無い（何も作っていない）→ 空', async () => {
    make(self, { meta: { publish: {} } })
    make(path.join(ws, 'copy'), { meta: hanamiiMeta('prj-1'), state: appState('app-1') })
    expect(await call(self)).toEqual({ ok: true, twins: EMPTY })
  })
})

describe('★★★ 読むだけ・投げない', () => {
  it('★★★ 複製がいる世界でも、フォルダの中身は1バイトも変わらない（何も書かない・何も消さない）', async () => {
    make(self, { meta: hanamiiMeta('prj-1'), state: appState('app-1') })
    make(path.join(ws, 'copy'), { meta: hanamiiMeta('prj-1'), state: appState('app-1') })
    const before = snapshot(ws)
    expect(Object.keys(before).length).toBeGreaterThan(4)
    expect((await call(self)).twins.hanamii).toEqual(['copy'])
    expect(snapshot(ws)).toEqual(before)
  })

  it.each([undefined, null, '', 5, {}, [], true])('★★ projectDir が不正（%j）: 投げずに ok:false。文は骨の「プロジェクトフォルダが不正です」と同じ', async (bad) => {
    expect(readRecordTwins(bad)).toEqual({ ok: false, message: BAD_PROJECT_DIR_MESSAGE })
    expect(await call(bad)).toEqual({ ok: false, message: BAD_PROJECT_DIR_MESSAGE })
  })

  it('★★ 存在しないフォルダ・親が読めないフォルダ: 投げずに、空の答え（見える兄弟がいない）', async () => {
    expect(await call(path.join(ws, 'no-such-dir'))).toEqual({ ok: true, twins: EMPTY })
  })
})

describe('★★ 3点セット（掟6）と、巨大ファイルに触らないこと', () => {
  it('preload が ipcRenderer.invoke(cloud:recordTwins) を呼ぶ形で cloud の節にあり、global.d.ts に型がある', () => {
    const preload = src('src/main/preload.ts')
    expect(preload).toContain("recordTwins: (projectDir: string) => ipcRenderer.invoke('cloud:recordTwins', projectDir),")
    expect(preload.split('cloud:recordTwins').length - 1, 'preload の呼び出しは1か所').toBe(1)
    // cloud の節（teardownRecord の隣）にある
    expect(preload.indexOf("ipcRenderer.invoke('cloud:recordTwins'")).toBeGreaterThan(preload.indexOf("ipcRenderer.invoke('cloud:teardownRecord'"))
    expect(preload.indexOf("ipcRenderer.invoke('cloud:recordTwins'")).toBeLessThan(preload.indexOf("ipcRenderer.invoke('cloud:registryName'"))
    const dts = src('src/renderer/global.d.ts')
    expect(dts).toContain('recordTwins(projectDir: string): Promise<')
    expect(dts).toContain("| { ok: true; twins: { hanamii: string[]; 'sakura-apprun': string[]; 'sakura-apprun-dedicated': string[] } }")
    expect(dts.indexOf('recordTwins(projectDir: string)')).toBeGreaterThan(dts.indexOf('teardownRecord(projectDir: string)'))
    expect(dts.indexOf('recordTwins(projectDir: string)')).toBeLessThan(dts.indexOf('registryName(projectDir: string)'))
  })

  it('main は cloudTeardown.ts の registerCloudTeardownHandlers の1か所で登録する。巨大ファイル cloud.ts には何も足していない。cloudTeardown.ts は400行以下', () => {
    const teardown = src('src/main/ipc/cloudTeardown.ts')
    expect(teardown).toContain("ipcMain.handle('cloud:recordTwins', (_event, projectDir: unknown) => readRecordTwins(projectDir))")
    expect(teardown.split("ipcMain.handle('cloud:recordTwins'").length - 1).toBe(1)
    expect(src('src/main/ipc/cloud.ts')).not.toContain('recordTwins')
    expect(teardown.split('\n').length).toBeLessThanOrEqual(400)
  })

  it('readRecordTwins は electron に依存しない recordTwins.ts にあり、判断は recordCoverFs を呼ぶだけ（自分で兄弟を歩かない）', () => {
    const code = src('src/main/cloud/recordTwins.ts')
    expect(code).not.toContain("from 'electron'")
    const body = code.slice(code.indexOf('export function readRecordTwins('))
    expect(body).toContain('const read = recordCoverFs(projectDir, t)')
    expect(body).not.toContain('readdirSync')
    expect(code.split('\n').length).toBeLessThanOrEqual(200)
  })
})
