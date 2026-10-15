import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { readFileSync } from 'fs'
import { join } from 'path'
import { publishedRecordsFs } from '../src/main/ipc/fs'
import { collectServicePrincipalCandidates } from '../src/shared/servicePrincipalCandidates'

// fs:publishedRecords の実体（publishedRecordsFs）を、実際のフォルダで駆動して固定する（2026-10-06）。
//
// 専有型②が「前のプロジェクトで使ったサービスプリンシパルID」を新しい順に並べるには、各プロジェクトの
// .sakuraide.json の更新時刻が要る（記録に時刻の項目が無いプロジェクトでも並べられるように）。
// 既存の fs:publishedRecords が全プロジェクトの記録をすでに読んでいるので、それに `metaUpdatedAtMs` を
// 足して再利用する（同じ歩き方の IPC を1本増やさない）。ここでは、
//   ・既存の読み方（公開に関係しないフォルダを載せない・ドット始まりを歩かない・壊れた記録で落ちない）は変わらない
//   ・metaUpdatedAtMs が .sakuraide.json の更新時刻になる
//   ・実際のフォルダから ② の候補まで通る
// を固定する。

let ws = ''

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-pubrec-'))
})
afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true })
})

function writeMeta(name: string, meta: unknown, mtimeMs?: number): string {
  const dir = path.join(ws, name)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, '.sakuraide.json')
  fs.writeFileSync(file, typeof meta === 'string' ? meta : JSON.stringify(meta))
  if (mtimeMs !== undefined) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000)
  return dir
}

const T1 = Date.UTC(2026, 8, 1, 0, 0, 0) // 2026-09-01
const T2 = Date.UTC(2026, 9, 5, 0, 0, 0) // 2026-10-05

describe('publishedRecordsFs: 既存の読み方は変わらない', () => {
  it('存在しない・空のワークスペースは ok:true で空', () => {
    expect(publishedRecordsFs('')).toEqual({ ok: true, projects: [] })
    expect(publishedRecordsFs(path.join(ws, 'nope'))).toEqual({ ok: true, projects: [] })
    expect(publishedRecordsFs(ws)).toEqual({ ok: true, projects: [] })
  })

  it('.sakuraide.json の name と publish を返す。name が無ければフォルダ名', () => {
    const a = writeMeta('alpha', { name: 'Alpha', publish: { apprunDedicated: { servicePrincipalId: '111111111111' } } })
    const b = writeMeta('beta', { publish: { targets: {} } })
    const r = publishedRecordsFs(ws)
    expect(r.ok).toBe(true)
    const byName = Object.fromEntries(r.projects.map(p => [p.name, p]))
    expect(byName['Alpha'].dir).toBe(a)
    expect(byName['Alpha'].publish).toEqual({ apprunDedicated: { servicePrincipalId: '111111111111' } })
    expect(byName['beta'].dir).toBe(b)
    expect(byName['beta'].apprunState).toBeNull()
  })

  it('公開に関係しないフォルダ（メタも state.json も無い）・ドット始まり・ファイルは載せない', () => {
    fs.mkdirSync(path.join(ws, 'plain'), { recursive: true })
    writeMeta('.hidden', { name: 'Hidden', publish: {} })
    fs.writeFileSync(path.join(ws, 'file.txt'), 'x')
    writeMeta('real', { name: 'Real' })
    expect(publishedRecordsFs(ws).projects.map(p => p.name)).toEqual(['Real'])
  })

  it('.sakuraide.json が壊れていても落ちない。.sakura-cloud/state.json があればその記録として載る（name はフォルダ名・publish は null）', () => {
    const dir = writeMeta('broken', '{ not json')
    fs.mkdirSync(path.join(dir, '.sakura-cloud'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.sakura-cloud', 'state.json'), JSON.stringify({ meta: { x: 1 } }))
    writeMeta('broken-only', '{ not json') // 壊れたメタだけ（state も無い）→ 載せない
    const r = publishedRecordsFs(ws)
    expect(r.projects.map(p => p.name)).toEqual(['broken'])
    expect(r.projects[0].publish).toBeNull()
    expect(r.projects[0].apprunState).toEqual({ meta: { x: 1 } })
  })
})

describe('publishedRecordsFs: metaUpdatedAtMs（.sakuraide.json の更新時刻）', () => {
  it('.sakuraide.json の更新時刻（ミリ秒）を返す', () => {
    writeMeta('old', { name: 'old' }, T1)
    writeMeta('new', { name: 'new' }, T2)
    const r = publishedRecordsFs(ws)
    const at = Object.fromEntries(r.projects.map(p => [p.name, p.metaUpdatedAtMs]))
    expect(at['old']).toBe(T1)
    expect(at['new']).toBe(T2)
  })

  it('.sakuraide.json が無く state.json だけのプロジェクトは null（時刻を推測で作らない）', () => {
    const dir = path.join(ws, 'state-only')
    fs.mkdirSync(path.join(dir, '.sakura-cloud'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.sakura-cloud', 'state.json'), '{}')
    const r = publishedRecordsFs(ws)
    expect(r.projects).toHaveLength(1)
    expect(r.projects[0].metaUpdatedAtMs).toBeNull()
  })

  it('読むだけ: 呼んでも .sakuraide.json の更新時刻・中身は変わらない', () => {
    const dir = writeMeta('keep', { name: 'keep', publish: {} }, T1)
    const before = fs.readFileSync(path.join(dir, '.sakuraide.json'), 'utf-8')
    publishedRecordsFs(ws)
    expect(fs.readFileSync(path.join(dir, '.sakuraide.json'), 'utf-8')).toBe(before)
    expect(fs.statSync(path.join(dir, '.sakuraide.json')).mtimeMs).toBe(T1)
  })
})

describe('実際のフォルダから ② の候補まで（歩く → 集める → 新しい順）', () => {
  const sp = (id: string) => ({ publish: { apprunDedicated: { servicePrincipalId: id } } })

  it('自分を除き、同じ ID を束ね、更新時刻の新しい順に並ぶ（記録に時刻の項目が無くても）', () => {
    writeMeta('Landingtest', { name: 'Landingtest' }, T2) // ID なし・新しい
    const cur = writeMeta('current', { name: 'current', ...sp('999999999999') }, T2 + 1000)
    writeMeta('blog', { name: 'blog', ...sp('111111111111') }, T1)
    writeMeta('shop', { name: 'shop', ...sp('222222222222') }, T2)
    writeMeta('lp', { name: 'lp', ...sp('111111111111') }, T1 + 1000)
    writeMeta('bad', { name: 'bad', ...sp('12345') }, T2 + 5000) // 12桁の数字でない
    writeMeta('broken', '{ nope', T2 + 9000)
    const r = publishedRecordsFs(ws)
    const out = collectServicePrincipalCandidates(r.projects, cur)
    expect(out).toEqual([
      { id: '222222222222', projectNames: ['shop'], updatedAtMs: T2 },
      { id: '111111111111', projectNames: ['lp', 'blog'], updatedAtMs: T1 + 1000 },
    ])
  })
})

// ── 配線（ソースを読んで固定）: 新しい IPC を足さず、既存の fs:publishedRecords を再利用している ─────────
const root = join(__dirname, '..')
const fsSrc = readFileSync(join(root, 'src/main/ipc/fs.ts'), 'utf-8')
const preload = readFileSync(join(root, 'src/main/preload.ts'), 'utf-8')
const globalDts = readFileSync(join(root, 'src/renderer/global.d.ts'), 'utf-8')
const loader = readFileSync(join(root, 'src/renderer/servicePrincipalCandidates.ts'), 'utf-8')

describe('配線: fs:publishedRecords を再利用する（同じ歩き方の IPC を増やさない）', () => {
  it('ハンドラは publishedRecordsFs を呼ぶだけの薄い形で、登録は1か所だけ', () => {
    expect(fsSrc).toContain("ipcMain.handle('fs:publishedRecords', async (_, workspaceDir: string) => publishedRecordsFs(workspaceDir))")
    expect((fsSrc.match(/ipcMain\.handle\('fs:publishedRecords'/g) ?? []).length).toBe(1)
    // 直す前の形（ハンドラの中に歩き方を直書き）へ戻っていない
    expect(fsSrc).not.toContain("ipcMain.handle('fs:publishedRecords', async (_, workspaceDir: string) => {")
    expect(fsSrc).toContain('metaUpdatedAtMs')
  })

  it('preload・global.d.ts: 同じチャンネルのまま。型に metaUpdatedAtMs が加わっている（新しい IPC は無い）', () => {
    expect(preload).toContain("publishedRecords: (workspaceDir: string) => ipcRenderer.invoke('fs:publishedRecords', workspaceDir),")
    const at = globalDts.indexOf('publishedRecords(workspaceDir: string): Promise<{')
    expect(at).toBeGreaterThan(0)
    const block = globalDts.slice(at, globalDts.indexOf('}>', at))
    expect(block).toContain('metaUpdatedAtMs?: number | null')
    // 候補を集めるための専用 IPC は足していない（ワークスペースを歩く道が2本にならない）
    expect(fsSrc).not.toContain('servicePrincipal')
    expect(preload).not.toContain('servicePrincipal')
    expect(globalDts).not.toMatch(/servicePrincipalCandidates\s*\(/)
  })

  it('renderer の入口は window.electronAPI.fs.publishedRecords を呼ぶ（読むだけ）', () => {
    expect(loader).toContain('publishedRecords: (dir) => window.electronAPI.fs.publishedRecords(dir),')
    expect(loader).toContain('workspaceDir: getWorkspaceDir,')
  })
})
