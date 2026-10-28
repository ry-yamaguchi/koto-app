import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// ── 0.6.24 R2-a: 移動の口（project:moveFiles・project:moveToMaterials・project:migrate）が、E の判断（fs:trash と同じ verdictOf）を通る ──────────
// 作業場所などの親フォルダを開いた形（ws/ の下に子のプロジェクト）で、子のプロジェクトの記録・フォルダそのものを移せてはいけない。
// 本物の一時フォルダで、本物の登録（偽の ipcMain）を IPC 名から呼ぶ。見るのは「結果の文」と「ディスクが1つも動いていないこと」（ファイルの一覧と中身の前後比較）。
// 変異: ①moveFilesToFs の判断を外す ②'unknown' を通す ③migrate の check・④migrate の実行が計画に判断を当てない形へ戻す（3つ目・4つ目は別々に当てる）。

const m = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { m.handlers.set(channel, fn) } },
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test' },
  dialog: {},
  shell: {},
}))

import { moveFilesToFs, moveToMaterialsFs, registerUnusedHandlers } from '../src/main/ipc/unused'
import { registerMigrateHandlers, planMigrateFs } from '../src/main/ipc/migrate'
import { FS_MOVE_MESSAGES } from '../src/main/ipc/fsTrash'
import { withholdFromMove } from '../src/shared/migratePlan'
import { MATERIALS_DIR } from '../src/shared/publishExclude'
import { PUBLISH_DIR } from '../src/shared/publishRoot'

let ws = ''
const lockedDirs: string[] = []
beforeEach(() => {
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koto-r2a-')))
  m.handlers.clear()
  registerUnusedHandlers()
  registerMigrateHandlers()
})
afterEach(() => {
  for (const d of lockedDirs.splice(0)) { try { fs.chmodSync(d, 0o755) } catch { /* 無い */ } }
  fs.rmSync(ws, { recursive: true, force: true })
})

function put(rel: string, content = 'x'): void {
  const full = path.join(ws, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf-8')
}
/** ディスクの前後比較用。フォルダとファイル（中身つき）を全部書き出す。読めないフォルダはその旨を書く。 */
function tree(dir = ws, rel = ''): string[] {
  const out: string[] = []
  let names: string[]
  try { names = fs.readdirSync(path.join(dir, rel)).sort() } catch { return [`${rel || '.'}/ <読めない>`] }
  for (const n of names) {
    const r = rel ? `${rel}/${n}` : n
    const st = fs.lstatSync(path.join(dir, r))
    if (st.isDirectory()) { out.push(`${r}/`); out.push(...tree(dir, r)) } else out.push(`${r} = ${fs.readFileSync(path.join(dir, r), 'utf-8')}`)
  }
  return out
}
const call = async (channel: string, ...args: unknown[]) => m.handlers.get(channel)!({}, ...args)
const rootIsMe = typeof process.getuid === 'function' && process.getuid() === 0

/** 作業場所を開いた形: 子のプロジェクト proj・projB（記録は大文字小文字違い）・中に入れ子のプロジェクトがあるフォルダ clients、ふつうのファイル・フォルダ。 */
function workspace(): void {
  put('proj/.sakuraide.json', '{"target":"hanamii"}'); put('proj/index.html', '<p>proj</p>'); put('proj/.sakura-cloud/state.json', '{"s":1}')
  put('projB/.SAKURAIDE.JSON', '{"B":1}'); put('projB/index.html', '<p>B</p>')
  put('clients/acme/.sakuraide.json', '{"a":1}'); put('clients/acme/index.html', '<p>acme</p>')
  put('sub/deep/.sakuraide-backup/1/a.json', '{"b":1}')
  put('readme.txt', 'ふつうのファイル'); put('plainfolder/a.txt', 'ふつうのフォルダの中'); put('plainfolder/b.txt', 'b')
}

type Dest = 'materials' | 'publish'
const DESTS: Dest[] = ['materials', 'publish']
const PROJECT_REFUSED = `${FS_MOVE_MESSAGES.project}: proj`

describe('★★★ R2-a project:moveFiles（作業場所を開いた形）: 子のプロジェクトの記録・フォルダそのものは、どの移動先でも断られ、ディスクは1つも動かない', () => {
  it.each(DESTS)('★★★ [%s] 子の記録（.sakuraide.json・大文字小文字違い・.sakura-cloud の中・入れ子の .sakuraide-backup）は record の文で断る', async dest => {
    workspace()
    const before = tree()
    for (const rel of ['proj/.sakuraide.json', 'projB/.SAKURAIDE.JSON', 'proj/.sakura-cloud/state.json', 'proj/.sakura-cloud', 'sub/deep/.sakuraide-backup/1/a.json', 'sub/deep/.sakuraide-backup']) {
      const r = await call('project:moveFiles', ws, [rel], dest)
      expect(r, rel).toMatchObject({ ok: false, moved: [], message: `${FS_MOVE_MESSAGES.record}: ${rel}` })
      expect(tree(), rel).toEqual(before)
    }
  })

  it.each(DESTS)('★★★ [%s] 子のプロジェクトのフォルダそのもの（proj・projB）は project の文で断る', async dest => {
    workspace()
    const before = tree()
    for (const rel of ['proj', 'projB', 'proj/', './proj']) {
      const r = await call('project:moveFiles', ws, [rel], dest)
      expect(r, rel).toMatchObject({ ok: false, moved: [], message: `${FS_MOVE_MESSAGES.project}: ${rel}` })
      expect(tree(), rel).toEqual(before)
    }
  })

  it.each(DESTS)('★★★ [%s] 中にプロジェクトがあるフォルダ（clients）は workspace の文で断る', async dest => {
    workspace()
    const before = tree()
    const r = await call('project:moveFiles', ws, ['clients'], dest)
    expect(r).toMatchObject({ ok: false, moved: [], message: `${FS_MOVE_MESSAGES.workspace}: clients` })
    expect(tree()).toEqual(before)
  })

  it.each(DESTS)('★★★ [%s] 1件でも断れば全体を中止する（ふつうのファイルも動かない・履歴も作らない）', async dest => {
    workspace()
    const before = tree()
    const r = await call('project:moveFiles', ws, ['readme.txt', 'plainfolder', 'proj'], dest)
    expect(r).toMatchObject({ ok: false, moved: [], snapshotOk: false, message: PROJECT_REFUSED })
    expect(tree()).toEqual(before)
    expect(fs.existsSync(path.join(ws, '.sakuraide-backup'))).toBe(false)
    expect(fs.existsSync(path.join(ws, dest === 'publish' ? PUBLISH_DIR : MATERIALS_DIR))).toBe(false)
  })

  it.skipIf(rootIsMe)('★★★ 調べられないフォルダ（権限なし）は unknown の文で断る。通さない', async () => {
    workspace()
    fs.mkdirSync(path.join(ws, 'locked')); fs.writeFileSync(path.join(ws, 'locked', 'secret.txt'), 's')
    fs.chmodSync(path.join(ws, 'locked'), 0o000); lockedDirs.push(path.join(ws, 'locked'))
    const before = tree()
    for (const dest of DESTS) {
      const r = await call('project:moveFiles', ws, ['locked'], dest)
      expect(r, dest).toMatchObject({ ok: false, moved: [], message: `${FS_MOVE_MESSAGES.unknown}: locked` })
    }
    expect(tree()).toEqual(before)
  })

  it('★★ 対照: ふつうのファイル・ふつうのフォルダは、今までどおり動く（materials へも public へも）', async () => {
    workspace()
    const r1 = await call('project:moveFiles', ws, ['readme.txt'], 'materials')
    expect(r1).toMatchObject({ ok: true, moved: ['readme.txt'] })
    expect(fs.readFileSync(path.join(ws, MATERIALS_DIR, 'readme.txt'), 'utf-8')).toBe('ふつうのファイル')
    expect(fs.existsSync(path.join(ws, 'readme.txt'))).toBe(false)
    const r2 = await call('project:moveFiles', ws, ['plainfolder'], 'publish')
    expect(r2).toMatchObject({ ok: true, moved: ['plainfolder'] })
    expect(fs.readFileSync(path.join(ws, PUBLISH_DIR, 'plainfolder', 'a.txt'), 'utf-8')).toBe('ふつうのフォルダの中')
    // 子のプロジェクトは、どちらの移動でも1つも動いていない
    expect(fs.readFileSync(path.join(ws, 'proj', '.sakuraide.json'), 'utf-8')).toBe('{"target":"hanamii"}')
    expect(fs.existsSync(path.join(ws, 'proj', 'index.html'))).toBe(true)
  })
})

describe('★★★ R2-a project:moveToMaterials（公開の根からの相対パスで渡す口）も同じ判断を通る', () => {
  it('★★★ 子のプロジェクトのフォルダ・記録は、IPC 名からも moveToMaterialsFs 直呼びからも断られ、ディスクは動かない', async () => {
    workspace()
    const before = tree()
    for (const rel of ['proj', 'projB/.SAKURAIDE.JSON', 'clients']) {
      const viaIpc = await call('project:moveToMaterials', ws, [rel])
      expect(viaIpc, rel).toMatchObject({ ok: false, moved: [] })
      expect(viaIpc.message, rel).toMatch(new RegExp(`^(${Object.values(FS_MOVE_MESSAGES).join('|')}): ${rel.replace('.', '\\.')}$`))
      expect(moveToMaterialsFs(ws, [rel]), rel).toMatchObject({ ok: false, moved: [] })
      expect(tree(), rel).toEqual(before)
    }
  })

  it('★★ 対照: ふつうのファイルは今までどおり素材へ移る', async () => {
    workspace()
    const r = await call('project:moveToMaterials', ws, ['readme.txt'])
    expect(r).toMatchObject({ ok: true, moved: ['readme.txt'] })
    expect(fs.existsSync(path.join(ws, MATERIALS_DIR, 'readme.txt'))).toBe(true)
  })

  it('★★ moveFilesToFs の直呼びでも断る（IPC の登録に頼らない）', () => {
    workspace()
    const before = tree()
    expect(moveFilesToFs(ws, ['proj'], 'materials')).toMatchObject({ ok: false, message: PROJECT_REFUSED })
    expect(tree()).toEqual(before)
  })
})

describe('★★★ R2-a project:migrate（作業場所を開いてチャットを使うと、子のプロジェクトを public/ へ移す計画になる）', () => {
  it('★★★ 計画（planMigrateFs）: 子のプロジェクト・入れ子のあるフォルダは move に入らず、keep に回る。ふつうのものは move', () => {
    workspace()
    const entries = fs.readdirSync(ws, { withFileTypes: true }).map(e => ({ name: e.name, isDir: e.isDirectory() }))
    const plan = planMigrateFs(ws, entries)
    expect([...plan.move].sort()).toEqual(['plainfolder', 'readme.txt', 'sub'])
    for (const n of ['proj', 'projB', 'clients']) { expect(plan.move, n).not.toContain(n); expect(plan.keep, n).toContain(n) }
  })

  it('★★★ project:migrateCheck: 答えの plan に子のプロジェクトが入らない。移すものが無ければ needed:false', async () => {
    workspace()
    const r = await call('project:migrateCheck', ws)
    expect(r.needed).toBe(true)
    for (const n of ['proj', 'projB', 'clients']) { expect(r.plan.move, n).not.toContain(n); expect(r.plan.keep, n).toContain(n) }
    expect([...r.plan.move].sort()).toEqual(['plainfolder', 'readme.txt', 'sub'])
    // 子のプロジェクトしか無い作業場所は、案内そのものを出さない
    const only = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koto-r2a-only-')))
    try {
      fs.mkdirSync(path.join(only, 'p')); fs.writeFileSync(path.join(only, 'p', '.sakuraide.json'), '{}'); fs.writeFileSync(path.join(only, 'p', 'index.html'), 'x')
      const r2 = await call('project:migrateCheck', only)
      expect(r2.needed).toBe(false)
      expect(r2.plan.move).toEqual([])
    } finally { fs.rmSync(only, { recursive: true, force: true }) }
  })

  it('★★★ project:migrate: 実行しても子のプロジェクトは1つも動かない（renameSync の相手は、ふつうのものだけ）', async () => {
    workspace()
    const r = await call('project:migrate', ws, '2026-10-26T00-00-00')
    expect(r.ok).toBe(true)
    expect([...r.moved].sort()).toEqual(['plainfolder', 'readme.txt', 'sub'])
    for (const rel of ['proj/.sakuraide.json', 'proj/index.html', 'proj/.sakura-cloud/state.json', 'projB/.SAKURAIDE.JSON', 'clients/acme/.sakuraide.json']) {
      expect(fs.existsSync(path.join(ws, rel)), rel).toBe(true)
    }
    expect(fs.existsSync(path.join(ws, PUBLISH_DIR, 'proj'))).toBe(false)
    expect(fs.existsSync(path.join(ws, PUBLISH_DIR, 'clients'))).toBe(false)
    expect(fs.existsSync(path.join(ws, PUBLISH_DIR, 'plainfolder', 'a.txt'))).toBe(true)
    expect(fs.existsSync(path.join(ws, PUBLISH_DIR, 'readme.txt'))).toBe(true)
  })

  it.skipIf(rootIsMe)('★★★ 調べられないフォルダは、計画の move に入らず keep に回る（移さない）', async () => {
    workspace()
    fs.mkdirSync(path.join(ws, 'locked')); fs.writeFileSync(path.join(ws, 'locked', 'a.txt'), 'a')
    fs.chmodSync(path.join(ws, 'locked'), 0o000); lockedDirs.push(path.join(ws, 'locked'))
    const r = await call('project:migrateCheck', ws)
    expect(r.plan.move).not.toContain('locked')
    expect(r.plan.keep).toContain('locked')
    const run = await call('project:migrate', ws, '2026-10-26T00-00-01')
    expect(run.moved).not.toContain('locked')
    fs.chmodSync(path.join(ws, 'locked'), 0o755)
    expect(fs.existsSync(path.join(ws, 'locked', 'a.txt'))).toBe(true)
  })

  it('★★ 対照: ふつうのプロジェクト（直下に .sakuraide.json があるだけ・子のプロジェクトなし）は今までどおり public/ へ移す', async () => {
    put('.sakuraide.json', '{}'); put('index.html', '<p>x</p>'); put('css/app.css', 'a{}'); put('materials-note.txt', 'm')
    const r = await call('project:migrateCheck', ws)
    expect(r.needed).toBe(true)
    expect(r.plan.move).toContain('index.html')
    expect(r.plan.move).toContain('css')
    const run = await call('project:migrate', ws, '2026-10-26T00-00-02')
    expect(run.ok).toBe(true)
    expect(fs.existsSync(path.join(ws, PUBLISH_DIR, 'index.html'))).toBe(true)
    expect(fs.existsSync(path.join(ws, '.sakuraide.json'))).toBe(true)
  })
})

describe('withholdFromMove（純関数）: 移してはいけないものを keep の末尾へ回す', () => {
  it('canMove が偽の名前だけを move から外して keep の末尾へ足す。順序は保つ', () => {
    expect(withholdFromMove({ move: ['a', 'b', 'c'], keep: ['k'] }, n => n !== 'b')).toEqual({ move: ['a', 'c'], keep: ['k', 'b'] })
    expect(withholdFromMove({ move: ['a'], keep: [] }, () => true)).toEqual({ move: ['a'], keep: [] })
    expect(withholdFromMove({ move: ['a', 'b'], keep: ['k'] }, () => false)).toEqual({ move: [], keep: ['k', 'a', 'b'] })
  })
})
