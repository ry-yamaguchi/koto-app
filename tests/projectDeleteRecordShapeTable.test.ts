import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── 公開の記録（.sakuraide.json・.sakura-cloud/state.json）の読み方が、画面と main で同じか ────────────────────────────────────────
// 同じ実フォルダを、本物の readProjectDeleteFacts（画面の材料）と本物の trashProjectFs（main の fs:trashProject の本体）の両方へ流し、
// `facts.unreadable`（画面が「削除できません」と止める）と、main が記録の断りで ok:false を返すかが、**全部の組み合わせで一致する**ことを1つの表で固定する。
// 期待は表に書いた値（`bad`）で、実装の判断を借りない。形違い（配列・文字列・null・publish が数など）は、画面が止めるなら main も断る。
// 断る回は、移す口 `trashItem` が0回・フォルダも記録も動かない。対照: 公開先つき・`{}`・無い・読める state.json は移す（1回）。
// 偽は、electron（ipcMain の登録）・さくらの client・保存場所だけ。
// 下の2つ目の表は逆向き: 共用型の記録の問い合わせ（.sakura-cloud/env.json。本物の cloud:teardownRecord）だけが失敗する回。画面は止めず（`facts.unconfirmed`・`unreadable` は偽）、
// main も断らない（trashProjectFs は ok:true で1回移す）。この前提が崩れて main が断る側に変わると、画面は止めないまま押した利用者が行き止まりになる。

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { resetProjectOpsForTests } from '../src/main/projectOps'
import { trashProjectFs, FS_TRASH_MESSAGES } from '../src/main/ipc/fsTrash'
import { readProjectDeleteFacts } from '../src/renderer/teardown/projectDeleteFacts'
import { planProjectDeleteTeardown } from '../src/renderer/teardown/projectDeletePlan'
import { h, resetHarness, setup as setupProject } from './sharedTeardownHarness'

registerCloudHandlers({} as any)
const mainRecord = h.handlers.get('cloud:teardownRecord')!
const mainTwins = h.handlers.get('cloud:recordTwins')!

/** 入力の1行。`put` が置き場所（ファイルのパス）へ置く（null は置かない＝記録が無い）。`bad` は、その記録が読めない（画面も main も断る）。 */
type Slot = { label: string; bad: boolean; put: ((file: string) => void) | null; targets?: string[] }
const text = (content: string) => (file: string) => fs.writeFileSync(file, content, 'utf-8')
const folder = (file: string) => fs.mkdirSync(file, { recursive: true })

const HANAMII_RECORD = JSON.stringify({
  name: 'myapp',
  publish: { targets: { hanamii: { publishedAt: null, url: 'https://myapp.hanamii.test' } } },
})

/** `.sakuraide.json`。 */
const META: Slot[] = [
  { label: '公開先つき', bad: false, put: text(HANAMII_RECORD), targets: ['hanamii'] },
  { label: '{}', bad: false, put: text('{}') },
  { label: '壊れた JSON', bad: true, put: text('{"publish": {') },
  { label: '空のファイル', bad: true, put: text('') },
  { label: 'フォルダ', bad: true, put: folder },
  { label: '[]', bad: true, put: text('[]') },
  { label: '"x"', bad: true, put: text('"x"') },
  { label: 'null', bad: true, put: text('null') },
  { label: '{"publish":5}', bad: true, put: text('{"publish":5}') },
  { label: '{"publish":{"targets":5}}', bad: true, put: text('{"publish":{"targets":5}}') },
  { label: '無い', bad: false, put: null },
]
/** `.sakura-cloud/state.json`。 */
const STATE: Slot[] = [
  { label: '壊れた JSON', bad: true, put: text('{ 壊れた state') },
  { label: 'フォルダ', bad: true, put: folder },
  { label: '読める', bad: false, put: text(JSON.stringify({ name: 'myapp', backend: 'apprun', resources: [] })) },
  { label: '無い', bad: false, put: null },
]

let home = ''
let dir = ''
beforeEach(() => {
  resetProjectOpsForTests()
  resetHarness()
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koto-record-shape-')))
  dir = path.join(home, 'SAKURAIDE', 'p')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'index.html'), '<p>x</p>', 'utf-8')
  ;(globalThis as any).window = {
    electronAPI: {
      cloud: {
        teardownRecord: (d: string) => mainRecord({}, d),
        recordTwins: (d: string) => mainTwins({}, d),
      },
      // 本物の fs:readFile・fs:exists と同じ（readFileSync・existsSync）
      fs: { readFile: async (p: string) => fs.readFileSync(p, 'utf-8'), exists: async (p: string) => fs.existsSync(p) },
      storage: { placement: async () => ({ ok: true, placements: [] }) },
      apprunDedicated: { state: async () => null },
      publishMeta: { runningOp: async () => null },
    },
    dispatchEvent: () => true,
  }
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
  delete (globalThis as any).window
})

/** フォルダの中身の写し（相対パス → 中身。フォルダは末尾 `/`）。動いていないことを比べる。 */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name)
      const rel = path.relative(root, full)
      if (fs.statSync(full).isDirectory()) { out[`${rel}/`] = '(フォルダ)'; walk(full) } else out[rel] = fs.readFileSync(full, 'utf-8')
    }
  }
  walk(root)
  return out
}

const ROWS = META.flatMap(meta => STATE.map(state => ({ meta, state })))

describe('★★★ 画面（readProjectDeleteFacts）と main（trashProjectFs）が、同じフォルダの記録を同じに読む（全部の組み合わせ）', () => {
  it('表の大きさ: .sakuraide.json 11行 × state.json 4行 = 44行', () => {
    expect(META.map(m => m.label)).toEqual(['公開先つき', '{}', '壊れた JSON', '空のファイル', 'フォルダ', '[]', '"x"', 'null', '{"publish":5}', '{"publish":{"targets":5}}', '無い'])
    expect(STATE.map(s => s.label)).toEqual(['壊れた JSON', 'フォルダ', '読める', '無い'])
    expect(ROWS).toHaveLength(44)
  })

  it.each(ROWS.map(r => [`.sakuraide.json=${r.meta.label} / state.json=${r.state.label}`, r] as const))('★★★ %s', async (_name, { meta, state }) => {
    if (meta.put) meta.put(path.join(dir, '.sakuraide.json'))
    if (state.put) {
      fs.mkdirSync(path.join(dir, '.sakura-cloud'), { recursive: true })
      state.put(path.join(dir, '.sakura-cloud', 'state.json'))
    }
    const before = snapshot(dir)
    const mustRefuse = meta.bad || state.bad

    const facts = await readProjectDeleteFacts(dir)
    const trashItem = vi.fn(async (_p: string) => {})
    const result = await trashProjectFs(dir, { confirmed: true, skippedForTwins: [] }, { home, trashItem })

    const refusedByRecord = !result.ok && (result.message === FS_TRASH_MESSAGES.metaUnreadable || result.message === FS_TRASH_MESSAGES.stateUnreadable)
    // 画面と main が同じ判断（掟10）
    expect(facts.unreadable, '画面が止めるかと、main が記録の断りで断るかが食い違った').toBe(refusedByRecord)
    // 表に書いた期待（実装の判断を借りない）
    expect(refusedByRecord, '表の期待と違う').toBe(mustRefuse)
    expect(facts.targets, '読めない .sakuraide.json の公開先を数えない').toEqual(meta.bad ? [] : meta.targets ?? [])

    if (mustRefuse) {
      // .sakuraide.json の断りが先（両方が読めないときも）
      expect(result).toEqual({ ok: false, message: meta.bad ? FS_TRASH_MESSAGES.metaUnreadable : FS_TRASH_MESSAGES.stateUnreadable })
      expect(trashItem.mock.calls, '断る回に、移す操作が出た').toEqual([])
      expect(snapshot(dir), 'フォルダが動いた').toEqual(before)
    } else {
      expect(result).toEqual({ ok: true })
      expect(trashItem.mock.calls, '読める回は、1回だけ移す').toEqual([[dir]])
      expect(facts.unconfirmed, '読める回に、確かめられなかった注意を立てない').toBe(false)
    }
  })
})

// ── 共用型の記録の問い合わせ（env.json）だけが失敗する回: 画面は止めず、main も断らない ────────────────────────────────────────────
/** env.json の1行。`failsQuery` は、本物の cloud:teardownRecord が ok:false になる（画面は確かめられなかった注意だけを出す）。 */
type EnvRow = { label: string; failsQuery: boolean; put: (dir: string) => void }
const envFile = (dir: string) => path.join(dir, '.sakura-cloud', 'env.json')
const stateFile = (dir: string) => path.join(dir, '.sakura-cloud', 'state.json')
const cloudDir = (dir: string) => fs.mkdirSync(path.join(dir, '.sakura-cloud'), { recursive: true })
const BUCKET_STATE = JSON.stringify({ name: 'x', backend: 'apprun', resources: [{ kind: 'bucket', name: 'koto-a', id: 'b1' }] })
const ENV: EnvRow[] = [
  { label: '壊れた JSON（state.json 無し）', failsQuery: true, put: d => { cloudDir(d); fs.writeFileSync(envFile(d), '{ 壊れた env') } },
  { label: '壊れた JSON（state.json は読める）', failsQuery: true, put: d => { cloudDir(d); fs.writeFileSync(envFile(d), '{ 壊れた env'); fs.writeFileSync(stateFile(d), '{"name":"x","backend":"apprun","resources":[]}') } },
  { label: 'ファイルでなくフォルダ', failsQuery: true, put: d => { fs.mkdirSync(envFile(d), { recursive: true }) } },
  { label: '無い・state.json にバケットの資源がある', failsQuery: true, put: d => { cloudDir(d); fs.writeFileSync(stateFile(d), BUCKET_STATE) } },
  { label: '無い・state.json の資源が空（対照）', failsQuery: false, put: d => { cloudDir(d); fs.writeFileSync(stateFile(d), '{"name":"x","backend":"apprun","resources":[]}') } },
  { label: '無い・state.json も無い（対照）', failsQuery: false, put: () => {} },
  { label: '読める・消すものが無い（対照）', failsQuery: false, put: d => setupProject(d, { env: [], resources: [] }) },
]
/** `.sakuraide.json`: 無い（行が無い回）・HANAMII の行がある回。 */
const METAS: Array<{ label: string; put: (dir: string) => void; targets: string[] }> = [
  { label: '無い', put: () => {}, targets: [] },
  { label: 'HANAMII の行', put: d => fs.writeFileSync(path.join(d, '.sakuraide.json'), HANAMII_RECORD), targets: ['hanamii'] },
]
const ENV_ROWS = ENV.flatMap(env => METAS.map(meta => ({ env, meta })))

describe('★★★ 共用型の記録の問い合わせだけが失敗する回: 画面は止めず（unconfirmed）、main も断らない（trashProjectFs は移す）', () => {
  it('表の大きさ: env.json 7行 × .sakuraide.json 2行 = 14行。失敗する行は4つ', () => {
    expect(ENV_ROWS).toHaveLength(14)
    expect(ENV.filter(e => e.failsQuery).map(e => e.label)).toEqual([
      '壊れた JSON（state.json 無し）', '壊れた JSON（state.json は読める）', 'ファイルでなくフォルダ', '無い・state.json にバケットの資源がある',
    ])
  })

  it.each(ENV_ROWS.map(r => [`env.json=${r.env.label} / .sakuraide.json=${r.meta.label}`, r] as const))('★★★ %s', async (_name, { env, meta }) => {
    meta.put(dir)
    env.put(dir)

    const facts = await readProjectDeleteFacts(dir)
    const trashItem = vi.fn(async (_p: string) => {})
    const result = await trashProjectFs(dir, { confirmed: true, skippedForTwins: [] }, { home, trashItem })

    expect(facts.unconfirmed, '表の期待（問い合わせが失敗する行だけ、確かめられなかった注意を立てる）').toBe(env.failsQuery)
    expect(facts.unreadable, '記録の読み失敗ではない（止める文を出さない）').toBe(false)
    expect(facts.sharedLeftover, '問い合わせが失敗した回に、残りの材料は無い').toBeNull()
    expect(facts.targets).toEqual(meta.targets)
    const plan = planProjectDeleteTeardown(facts)
    expect(plan.block, '画面は止めない（ボタンは押せる）').toBeNull()
    expect(plan.teardown, '公開先の破棄は今までどおり').toEqual(meta.targets)
    // main も断らない（画面が止めない回は、main が通す）
    expect(result, 'main がこの回を断る側に変わった').toEqual({ ok: true })
    expect(trashItem.mock.calls, '1回だけ移す').toEqual([[dir]])
  })
})
