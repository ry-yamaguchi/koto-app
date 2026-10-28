import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── 0.6.24 R2-e: `fs:trashProject` は、画面の「複製のために破棄を外した」という判断を、移す直前に読み直す（掟10・main を最後の砦にする）──────────────
// 検分で実測: 開いたときの複製の判断を、最初の押下まで使い回す。開いたあとに複製を消すと、HANAMII・共用型を破棄しないまま元が移る
// （専有型だけは main が確かめ直していた）。複製が消えた時点で、元は「最後の1つ」になり、破棄しないと公開が残って月額が続く。
// 直し方: opts に**必須**の `skippedForTwins`（plan が覆う複製のために破棄を外した公開先）。main は移す直前に、その公開先それぞれで覆う複製（`recordCoverFs`）を読み直し、
// 1つでも無くなっていれば（確かめられない 'unknown' を含む）移さずに断る（`reason: 'twins-gone'`）。配列でない・知らない公開先の名前を含むときも断る。
// 専有型の止めを外す条件も、`skippedForTwins` に専有型があり、かつ覆う複製がいまもあるとき**だけ**。
// 本物の登録を IPC 名から呼び、実フォルダと「shell.trashItem の呼ばれた一覧」で見る（掟10）。
// 変異: main の読み直しを外す／`skippedForTwins` が無くても通す／配列でも中身を見ない（知らない名前を通す）／専有型の止めを `skippedForTwins` だけで外す（覆う複製を見ない）／覆う複製だけで外す（skippedForTwins を見ない）。
// R3-b: 専有型の止めの門の片方（skippedForTwins に専有型が入っていること）は、別の公開先だけを外したと言う回（`['hanamii']`）で固定する。変異: `!skipped.includes(専有型)` を `skipped.length === 0` にする。

const m = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  trashItem: vi.fn(async (_p: string) => {}),
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { m.handlers.set(channel, fn) } },
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test' },
  dialog: {},
  shell: { trashItem: m.trashItem },
}))

import { registerFsHandlers } from '../src/main/ipc/fs'
import { FS_TRASH_MESSAGES, trashProjectFs } from '../src/main/ipc/fsTrash'

let home = ''
let ws = ''
let savedHome: string | undefined
beforeEach(() => {
  savedHome = process.env.HOME
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koto-r2e-')))
  process.env.HOME = home
  ws = path.join(home, 'SAKURAIDE')
  m.trashItem.mockClear()
  m.handlers.clear()
  registerFsHandlers({} as any)
})
afterEach(() => {
  try { fs.chmodSync(ws, 0o755) } catch { /* 片づけ */ }
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome
  fs.rmSync(home, { recursive: true, force: true })
})
const call = async (channel: string, ...args: unknown[]) => m.handlers.get(channel)!({}, ...args)
const rootIsMe = typeof process.getuid === 'function' && process.getuid() === 0

const put = (file: string, v: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v)) }
const HANAMII = { publish: { hanamii: { projectId: 'prj-1' }, targets: { hanamii: { publishedAt: '2026-10-19T00:00:00.000Z' } } } }
const APP_STATE = { name: 'p', backend: 'apprun', resources: [{ kind: 'apprun-app', id: 'a-1', key: 'apprun-app:p', stateful: false }] }
const IDS = { applicationID: 'ap-1', clusterID: 'cl-1', loadBalancerID: 'lb-1', asgID: 'asg-1' }
const DEDICATED = { publish: { apprunDedicated: IDS } }
const BOTH = { publish: { ...HANAMII.publish, ...DEDICATED.publish } }
/** 公開先の記録を持つプロジェクト（state は渡したときだけ置く）。 */
const project = (name: string, meta: unknown, state: unknown = null): string => {
  const dir = path.join(ws, name)
  put(path.join(dir, '.sakuraide.json'), meta)
  if (state !== null) put(path.join(dir, '.sakura-cloud', 'state.json'), state)
  put(path.join(dir, 'index.html'), '<p/>')
  return dir
}
const GONE = { ok: false, message: FS_TRASH_MESSAGES.twinsGone, reason: 'twins-gone' }
/** 確かめられなかった（'unknown'）回の断り（R3-e）。reason は GONE と同じ（画面は材料を読み直す）。文は別。 */
const UNKNOWN = { ok: false, message: FS_TRASH_MESSAGES.twinsUnknown, reason: 'twins-gone' }
const INVALID = { ok: false, message: FS_TRASH_MESSAGES.skippedInvalid }

describe('★★★ 断りの文は作者の決めた文のとおり', () => {
  it('twinsGone・twinsUnknown・skippedInvalid', () => {
    expect(FS_TRASH_MESSAGES.twinsGone).toBe('同じ公開の記録を持つフォルダが見つからなくなったため、移していません。もう一度「ゴミ箱に移動」を押すと、破棄から始めます。')
    expect(FS_TRASH_MESSAGES.twinsUnknown).toBe('同じ公開の記録を持つフォルダを確かめられないため、移していません。')
    expect(FS_TRASH_MESSAGES.skippedInvalid).toBe('削除の指定が正しくないため、移していません。')
  })
})

describe('★★★ skippedForTwins は必須。配列でない・知らない公開先の名前を含むときは断る。移す要求0件', () => {
  it.each([
    ['無い', { confirmed: true }],
    ['null', { confirmed: true, skippedForTwins: null }],
    ['文字列', { confirmed: true, skippedForTwins: 'hanamii' }],
    ['オブジェクト', { confirmed: true, skippedForTwins: { hanamii: true } }],
    ['数', { confirmed: true, skippedForTwins: 1 }],
    ['知らない名前', { confirmed: true, skippedForTwins: ['nope'] }],
    ['文字列でない要素', { confirmed: true, skippedForTwins: ['hanamii', 5] }],
    ['複製を数えない公開先（vercel）', { confirmed: true, skippedForTwins: ['vercel'] }],
    ['空の名前', { confirmed: true, skippedForTwins: [''] }],
  ])('★★★ %s → 断る（%j）。ふつうのフォルダでも通さない', async (_label, opts) => {
    const dir = path.join(ws, 'plain'); put(path.join(dir, 'a.txt'), 'a')
    expect(await call('fs:trashProject', dir, opts)).toEqual(INVALID)
    expect(await trashProjectFs(dir, opts, { home, trashItem: async () => { throw new Error('呼ばれてはいけない') } })).toEqual(INVALID)
    expect(m.trashItem.mock.calls).toEqual([])
    expect(fs.existsSync(path.join(dir, 'a.txt'))).toBe(true)
  })

  it('★★★ 空の配列は通る（複製を外した公開先が無い通常の回）。確認の印が無ければ、確認の文が先', async () => {
    const dir = path.join(ws, 'plain'); put(path.join(dir, 'a.txt'), 'a')
    expect(await call('fs:trashProject', dir, { skippedForTwins: [] })).toEqual({ ok: false, message: '確認ダイアログを通っていません' })
    expect(await call('fs:trashProject', dir, { confirmed: true, skippedForTwins: [] })).toEqual({ ok: true })
    expect(m.trashItem.mock.calls).toEqual([[dir]])
  })
})

describe('★★★ 移す直前に、外した公開先の覆う複製を読み直す。無くなっていれば断る（reason: twins-gone）。移す要求0件', () => {
  it.each([
    ['hanamii', HANAMII, null],
    ['sakura-apprun', {}, APP_STATE],
    ['sakura-apprun-dedicated', DEDICATED, null],
  ] as const)('★★★ %s: 画面が開いたときは複製がいた → 押す前に複製を消した → 断る。複製が居れば移す', async (target, meta, state) => {
    const dir = project('myapp', meta, state)
    const copy = project('myapp copy', meta, state)
    const opts = { confirmed: true, skippedForTwins: [target] }
    // 開いたとき（複製あり）は通る状態。ここで消して、押す
    expect(fs.existsSync(copy)).toBe(true)
    fs.rmSync(copy, { recursive: true })
    const before = fs.readdirSync(dir).sort()
    expect(await call('fs:trashProject', dir, opts)).toEqual(GONE)
    expect(m.trashItem.mock.calls, '複製が消えたのに、破棄せずに元を移した（公開が残って月額が続く）').toEqual([])
    expect(fs.readdirSync(dir).sort()).toEqual(before)
    // 対照: 複製が居れば移す
    project('myapp copy', meta, state)
    expect(await call('fs:trashProject', dir, opts)).toEqual({ ok: true })
    expect(m.trashItem.mock.calls).toEqual([[dir]])
  })

  it('★★★ 複製が覆わなくなった（部分だけを持つ複製に変わった）→ 断る', async () => {
    const dir = project('myapp', HANAMII)
    put(path.join(dir, '.sakura-cloud', 'env.json'), { persistence: { objectStorage: [{ bucket: 'koto-a', prefix: 'projects/myapp/', consentedAt: '2026-10-01T00:00:00Z' }] } })
    const copy = project('myapp copy', HANAMII) // 保存場所の記録を持たない（重なるが覆わない）
    const opts = { confirmed: true, skippedForTwins: ['hanamii'] }
    expect(await call('fs:trashProject', dir, opts)).toEqual(GONE)
    expect(m.trashItem.mock.calls).toEqual([])
    put(path.join(copy, '.sakura-cloud', 'env.json'), { persistence: { objectStorage: [{ bucket: 'koto-a', prefix: 'projects/myapp/', consentedAt: '2026-10-01T00:00:00Z' }] } })
    expect(await call('fs:trashProject', dir, opts)).toEqual({ ok: true })
  })

  it('★★★ 複数の公開先: 1つでも覆う複製が無くなっていれば断る（残りは居ても）', async () => {
    const dir = project('myapp', HANAMII, APP_STATE)
    project('hanamii only', HANAMII) // HANAMII は覆う（同じ projectId だけ）。共用型の複製は居ない
    expect(await call('fs:trashProject', dir, { confirmed: true, skippedForTwins: ['hanamii'] })).toEqual({ ok: true })
    m.trashItem.mockClear()
    expect(await call('fs:trashProject', dir, { confirmed: true, skippedForTwins: ['hanamii', 'sakura-apprun'] })).toEqual(GONE)
    expect(await call('fs:trashProject', dir, { confirmed: true, skippedForTwins: ['sakura-apprun', 'hanamii'] })).toEqual(GONE)
    expect(m.trashItem.mock.calls).toEqual([])
  })

  it.skipIf(rootIsMe)('★★★ 親フォルダの一覧を読めない（0o311）→ 確かめられないので断る（R3-e: 「見つからなくなった」とは言わず、確かめられない文）', async () => {
    const dir = project('myapp', HANAMII)
    project('myapp copy', HANAMII)
    fs.chmodSync(ws, 0o311)
    const r = await call('fs:trashProject', dir, { confirmed: true, skippedForTwins: ['hanamii'] })
    expect(r).toEqual(UNKNOWN)
    expect(r.message, '確かめられないのに「見つからなくなった」と断定する').not.toContain('見つからなくなった')
    expect(r.message, '「破棄から始めます」とも言わない').not.toContain('破棄から始めます')
    expect(m.trashItem.mock.calls).toEqual([])
  })

  it('★★ 自分の記録が読めない（env.json が壊れている）→ 確かめられないので断る（R3-e: 確かめられない文）', async () => {
    const dir = project('myapp', HANAMII)
    put(path.join(dir, '.sakura-cloud', 'env.json'), '{ 壊れた')
    project('myapp copy', HANAMII)
    expect(await call('fs:trashProject', dir, { confirmed: true, skippedForTwins: ['hanamii'] })).toEqual(UNKNOWN)
    expect(m.trashItem.mock.calls).toEqual([])
  })

  // R3-e: 「見つからなくなった」は、確かめられて無かったときだけ言う。1つでも確かめられなかったなら、確かめられない文（言い切れない側）。
  it('★★★ R3-e: 複製が本当に無くなった（確かめられた）→ 「見つからなくなった」。複製を消した直後と、まだ居る回の対照', async () => {
    const dir = project('myapp', HANAMII)
    const copy = project('myapp copy', HANAMII)
    expect(await call('fs:trashProject', dir, { confirmed: true, skippedForTwins: ['hanamii'] })).toEqual({ ok: true })
    m.trashItem.mockClear()
    fs.rmSync(copy, { recursive: true })
    const r = await call('fs:trashProject', dir, { confirmed: true, skippedForTwins: ['hanamii'] })
    expect(r).toEqual(GONE)
    expect(r.message).toContain('見つからなくなった')
    expect(m.trashItem.mock.calls).toEqual([])
  })

  it.skipIf(rootIsMe)('★★★ R3-e: 1つが確かめられず（親フォルダの一覧を読めない）、1つは自分に記録が無くて「覆う複製なし」のとき → 確かめられない文（並びによらない）。移す要求0件', async () => {
    const dir = project('myapp', HANAMII) // HANAMII の記録だけ。共用型の記録は無い（共用型は、自分に識別子が無く、親を読まずに「覆う複製なし」と返る）
    project('myapp copy', HANAMII)
    fs.chmodSync(ws, 0o311)
    expect(await call('fs:trashProject', dir, { confirmed: true, skippedForTwins: ['hanamii', 'sakura-apprun'] })).toEqual(UNKNOWN)
    expect(await call('fs:trashProject', dir, { confirmed: true, skippedForTwins: ['sakura-apprun', 'hanamii'] })).toEqual(UNKNOWN)
    expect(m.trashItem.mock.calls).toEqual([])
  })

  it('★★ 外した公開先が無い（skippedForTwins が空）なら、複製を見ない: 複製が居なくても今までどおり移す', async () => {
    const dir = project('myapp', HANAMII)
    expect(await call('fs:trashProject', dir, { confirmed: true, skippedForTwins: [] })).toEqual({ ok: true })
    expect(m.trashItem.mock.calls).toEqual([[dir]])
  })

  it('★★ 重複した名前も読み直せる（同じ公開先が2回）', async () => {
    const dir = project('myapp', HANAMII)
    project('myapp copy', HANAMII)
    expect(await call('fs:trashProject', dir, { confirmed: true, skippedForTwins: ['hanamii', 'hanamii'] })).toEqual({ ok: true })
  })
})

describe('★★★ 専有型の止めを外すのは、skippedForTwins に専有型があり、かつ覆う複製がいまもあるときだけ', () => {
  const DEDICATED_ONLY = { publish: { apprunDedicated: IDS } }

  it('★★★ 覆う複製がある・skippedForTwins に専有型が無い → 専有型が残っているので断る（複製がいるだけでは外さない）', async () => {
    const dir = project('myapp', DEDICATED_ONLY)
    project('myapp copy', DEDICATED_ONLY)
    expect(await call('fs:trashProject', dir, { confirmed: true, skippedForTwins: [] })).toEqual({ ok: false, message: FS_TRASH_MESSAGES.dedicated })
    expect(await call('fs:trashProject', dir, { confirmed: true, skippedForTwins: ['hanamii'] })).toMatchObject({ ok: false }) // hanamii の覆う複製は無い
    expect(m.trashItem.mock.calls).toEqual([])
  })

  // R3-b: 門の片方（skippedForTwins に専有型が入っていること）を固定する。`!skipped.includes(専有型)` を `skipped.length === 0` に変えても全件緑だった
  // （上の試験は skippedForTwins が空か、覆う複製が無い `['hanamii']` だけで、「別の公開先を外したと言っているだけ」の回が無かった）。
  it('★★★ R3-b: HANAMII を覆う複製あり・専有型の仕事あり・専有型の複製なし・skippedForTwins [\'hanamii\'] → 専有型の文で断る。移す要求0件', async () => {
    const dir = project('myapp', BOTH)
    project('myapp copy', HANAMII) // HANAMII は覆う（同じ projectId）。専有型の記録は持たないので、専有型は覆わない
    const refused = await call('fs:trashProject', dir, { confirmed: true, skippedForTwins: ['hanamii'] })
    expect(refused).toEqual({ ok: false, message: FS_TRASH_MESSAGES.dedicated })
    expect(m.trashItem.mock.calls).toEqual([])
    expect(fs.existsSync(path.join(dir, 'index.html'))).toBe(true)
  })

  it('★★★ R3-b: 専有型も覆う複製があるのに skippedForTwins が専有型を挙げていない → 専有型の文で断る。挙げれば移す（門は skippedForTwins の側にもある）', async () => {
    const dir = project('myapp', BOTH)
    project('myapp copy', BOTH) // HANAMII も専有型も覆う
    expect(await call('fs:trashProject', dir, { confirmed: true, skippedForTwins: ['hanamii'] })).toEqual({ ok: false, message: FS_TRASH_MESSAGES.dedicated })
    expect(m.trashItem.mock.calls).toEqual([])
    expect(await call('fs:trashProject', dir, { confirmed: true, skippedForTwins: ['hanamii', 'sakura-apprun-dedicated'] })).toEqual({ ok: true })
    expect(m.trashItem.mock.calls).toEqual([[dir]])
  })

  it('★★★ skippedForTwins に専有型がある・覆う複製が無い → 「見つからなくなった」で断る（専有型の文ではなく。画面が材料を読み直す）', async () => {
    const dir = project('myapp', DEDICATED_ONLY)
    expect(await call('fs:trashProject', dir, { confirmed: true, skippedForTwins: ['sakura-apprun-dedicated'] })).toEqual(GONE)
    expect(m.trashItem.mock.calls).toEqual([])
  })

  it('★★★ 両方そろう（skippedForTwins に専有型・覆う複製あり）→ 移す（1回）', async () => {
    const dir = project('myapp', DEDICATED_ONLY)
    project('myapp copy', DEDICATED_ONLY)
    expect(await call('fs:trashProject', dir, { confirmed: true, skippedForTwins: ['sakura-apprun-dedicated'] })).toEqual({ ok: true })
    expect(m.trashItem.mock.calls).toEqual([[dir]])
  })

  it('★★ 専有型の残りが無いプロジェクトは、専有型を外したと言わなくても移せる（止めは残りがあるときだけ）', async () => {
    const dir = project('myapp', HANAMII)
    expect(await call('fs:trashProject', dir, { confirmed: true, skippedForTwins: [] })).toEqual({ ok: true })
  })
})

describe('★★ 順序: 確認 → 場所 → 走っている操作・記録 → skippedForTwins の形 → 複製の読み直し → 専有型。先の断りが先に出る', () => {
  it('確認の印が無ければ確認の文。場所が合わなければ場所の文（skippedForTwins が不正でも）', async () => {
    const dir = project('myapp', HANAMII)
    expect(await call('fs:trashProject', dir, { skippedForTwins: ['nope'] })).toEqual({ ok: false, message: '確認ダイアログを通っていません' })
    expect(await call('fs:trashProject', path.join(home, 'Library'), { confirmed: true, skippedForTwins: ['nope'] })).toMatchObject({ ok: false })
    expect((await call('fs:trashProject', path.join(home, 'Library'), { confirmed: true, skippedForTwins: ['nope'] })).message).not.toBe(FS_TRASH_MESSAGES.skippedInvalid)
    expect(m.trashItem.mock.calls).toEqual([])
  })

  it('読めない `.sakuraide.json`（R2-h）は、skippedForTwins の形・複製の読み直しより先に断る', async () => {
    const dir = path.join(ws, 'broken'); put(path.join(dir, '.sakuraide.json'), '{ 壊れた')
    expect(await call('fs:trashProject', dir, { confirmed: true, skippedForTwins: ['nope'] })).toEqual({ ok: false, message: FS_TRASH_MESSAGES.metaUnreadable })
    expect(await call('fs:trashProject', dir, { confirmed: true, skippedForTwins: ['hanamii'] })).toEqual({ ok: false, message: FS_TRASH_MESSAGES.metaUnreadable })
  })
})
