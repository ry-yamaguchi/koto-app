import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── なぜこのテストが要るか（2026-09-29 検分の指摘・HANAMII の二重作成）──────────────────
//
// main の鍵（withProjectLock）は「同時」の二重実行は止める。だが**鍵が外れたあと**の2回目は、
// 画面（HanamiiPanel）が渡す projectId しか見ていなかった。流れ:
//
//   ① 初回の公開が走っている最中に、公開ダイアログを閉じて開き直す
//   ② 新しい HanamiiPanel は、マウント時に読んだ記録にまだ projectId が無いので projectId=null
//   ③ 「公開」を押す → 鍵が断る（「いま別の操作（公開）を実行中です。終わってからもう一度お試しください。」）
//   ④ 言われたとおり、終わってからもう一度押す → **projectId 無しで createProject がもう一度走る**
//      （プロジェクトが二重に作られ、記録の projectId が上書きされて、1つ目は Koto から辿れなくなる）
//
// 直し方: main の hanamii:publish が、画面が projectId を渡さないとき**ディスクの記録**
// （publish.hanamii.projectId・main が公開の最後に書く）で補う。main が正（掟10）。
//
// ここは**ソースの文字列を読まない**。hanamii:publish を実際に呼び、偽の HANAMII（fetch）へ
// **実際に出た要求の一覧**で固定する。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  /** 次の要求で1回だけ止める（1回目を「走っている最中」にしておくため）。 */
  blockNext: false,
  entered: null as null | (() => void),
  release: (() => {}) as () => void,
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {} },
  dialog: {},
}))

import { registerHanamiiHandlers, PROJECT_MISMATCH_PUBLISH } from '../src/main/ipc/hanamii'
import { projectBusyMessage } from '../src/main/projectLock'

registerHanamiiHandlers({} as any)

const TOKEN = 'tok-test'
const BASE = 'https://hanamii.jp'
const UPLOAD_URL = 'https://upload.example/zip'

let projectDirs: string[] = []
let realFetch: typeof globalThis.fetch
/** 偽の HANAMII へ出た要求（順序込み）。 */
let reqs: string[] = []
/** 偽の HANAMII が発行したプロジェクトの数（createProject の回数と同じ）。 */
let created = 0

const jsonRes = (status: number, data: unknown) => ({ ok: status < 300, status, async text() { return JSON.stringify(data) } })

function newProject(meta?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-hnm-pid-'))
  projectDirs.push(dir)
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>hi</body></html>', 'utf-8')
  if (meta !== undefined) fs.writeFileSync(path.join(dir, '.sakuraide.json'), JSON.stringify(meta, null, 2), 'utf-8')
  return dir
}
const readMeta = (dir: string): any => JSON.parse(fs.readFileSync(path.join(dir, '.sakuraide.json'), 'utf-8'))
const publish = (dir: string, opts: Record<string, unknown> = {}) =>
  h.handlers.get('hanamii:publish')!({}, dir, { token: TOKEN, workspaceId: 'ws-1', name: 'myapp', ...opts })
const createCalls = () => reqs.filter(r => r === `POST ${BASE}/api/v1/projects`)
const deployCalls = () => reqs.filter(r => /^POST .*\/api\/v1\/projects\/[^/]+\/deploy$/.test(r))

beforeEach(() => {
  projectDirs = []
  reqs = []
  created = 0
  h.blockNext = false
  h.entered = null
  h.release = () => {}
  realFetch = globalThis.fetch
  // **偽の HANAMII。** 実ネットワークへは一切出さない。
  globalThis.fetch = (async (input: unknown, init: any) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    reqs.push(`${method} ${url}`)
    if (h.blockNext) {
      h.blockNext = false
      const gate = new Promise<void>(open => { h.release = open })
      h.entered?.()
      await gate
    }
    if (method === 'POST' && url === `${BASE}/api/v1/uploads`) return jsonRes(200, { upload: { uploadUrl: UPLOAD_URL, id: 'up-1' } })
    if (method === 'PUT' && url === UPLOAD_URL) return jsonRes(200, {})
    if (method === 'POST' && url === `${BASE}/api/v1/uploads/up-1/check`) return jsonRes(200, { result: { canDeploy: true, checkId: 'chk-1' } })
    if (method === 'POST' && url === `${BASE}/api/v1/projects`) { created += 1; return jsonRes(200, { project: { id: `proj-${created}` }, deployment: { id: `dep-${created}` } }) }
    const dep = /\/api\/v1\/projects\/([^/]+)\/deploy$/.exec(url)
    if (method === 'POST' && dep) return jsonRes(200, { deployment: { id: 'dep-redeploy' } })
    return jsonRes(404, { error: { message: `想定外の要求: ${method} ${url}` } })
  }) as unknown as typeof fetch
})
afterEach(() => {
  h.release()
  globalThis.fetch = realFetch
  for (const d of projectDirs) fs.rmSync(d, { recursive: true, force: true })
})

// ── 画面が別のプロジェクトの projectId を持ち越したとき（2026-09-30 検分・掟11）──────────────────
// 公開は最長およそ5分かかるようになり、その間に📡 一覧から別のプロジェクトへ切り替えると、画面が前のプロジェクトの
// projectId を持ち越したまま、いまのプロジェクトの projectDir で「公開する」を押せた。main は**画面の値を優先**していたので、
// 別のプロジェクトのコードを、前のプロジェクトの HANAMII の稼働中のアプリへ再デプロイして上書きした。
// 直し方（最後の砦）: 画面が渡した projectId は、**このプロジェクトの記録が指すものと一致するときだけ**使う。
// 食い違う・記録に無いときは、外部の API を1件も呼ばずに断る。
describe('★★★ HANAMII: 画面が渡した projectId が、このプロジェクトの記録と違うときは、何も送らずに断る（掟11）', () => {
  it('★★★ 記録は proj-B・画面が持ち越した proj-A: 断る。要求は1件も出ず、koto-data も置かず、記録は変わらない', async () => {
    const dir = newProject({ publish: { hanamii: { projectId: 'proj-B' } } })
    const r = await publish(dir, { projectId: 'proj-A' })
    expect(r.ok).toBe(false)
    expect(r.message).toBe(PROJECT_MISMATCH_PUBLISH)
    expect(reqs, '別のプロジェクトの HANAMII へ何かを送った').toEqual([])
    expect(createCalls()).toHaveLength(0)
    expect(deployCalls(), '別のプロジェクトの稼働中のアプリを再デプロイした').toEqual([])
    expect(fs.existsSync(path.join(dir, 'koto-data.js')), '断ったのに、プロジェクトのファイルを書き換えた').toBe(false)
    expect(readMeta(dir).publish.hanamii.projectId).toBe('proj-B')
  })

  it('★★★ 記録に projectId が無い（別のプロジェクトの画面から持ち越された値）でも断る。新しくも作らない', async () => {
    for (const meta of [undefined, {}, { publish: { hanamii: { projectId: null } } }, { publish: { hanamii: { projectId: '' } } }, { publish: { hanamii: 'broken' } }]) {
      reqs = []
      const dir = newProject(meta)
      const r = await publish(dir, { projectId: 'proj-A' })
      expect(r.ok, JSON.stringify(meta)).toBe(false)
      expect(r.message, JSON.stringify(meta)).toBe(PROJECT_MISMATCH_PUBLISH)
      expect(reqs, JSON.stringify(meta)).toEqual([])
    }
  })

  it('断ったあとも鍵は外れている（次の正しい公開が「実行中」で断られない）', async () => {
    const dir = newProject({ publish: { hanamii: { projectId: 'proj-B' } } })
    expect((await publish(dir, { projectId: 'proj-A' })).ok).toBe(false)
    const again = await publish(dir, { projectId: 'proj-B' })
    expect(again.ok).toBe(true)
    expect(deployCalls()).toEqual([`POST ${BASE}/api/v1/projects/proj-B/deploy`])
  })
})

describe('★★★ HANAMII: 1回目が終わったあと、古い画面（projectId 無し）から押しても、2つ目のプロジェクトは作られない', () => {
  it('公開中に閉じて開き直す → 断られる → 終わってから押す: createProject は全体で1回だけ・2回目は再公開（deploy）になる', async () => {
    const dir = newProject()

    // ① 初回の公開が走っている（HANAMII の最初の要求の手前で止めて、「走っている最中」にする）
    h.blockNext = true
    const entered = new Promise<void>(resolve => { h.entered = resolve })
    const first = publish(dir)
    await entered

    // ②③ 開き直した画面（projectId=null）から押す → 断られ、外部の要求は増えない
    const before = [...reqs]
    const refused = await publish(dir)
    expect(refused.ok).toBe(false)
    expect(refused.message).toBe(projectBusyMessage('公開'))
    expect(reqs).toEqual(before)

    // 1回目が終わる。プロジェクトが1つ作られ、main が記録へ projectId を書く
    h.release()
    const firstResult = await first
    expect(firstResult.ok).toBe(true)
    expect(firstResult.projectId).toBe('proj-1')
    expect(createCalls()).toHaveLength(1)
    expect(readMeta(dir).publish.hanamii.projectId).toBe('proj-1')

    // ④ 言われたとおり終わってから押す。画面はまだ projectId=null のまま（マウント時に読んだ写し）
    const third = await publish(dir, { projectId: undefined })
    expect(third.ok).toBe(true)
    // **2つ目は作られない**（直す前は、ここで createProject がもう一度走った）
    expect(createCalls()).toHaveLength(1)
    // 1つ目のプロジェクトへ再公開している
    expect(deployCalls()).toEqual([`POST ${BASE}/api/v1/projects/proj-1/deploy`])
    expect(third.projectId).toBe('proj-1')
    // 記録の projectId は上書きされない
    expect(readMeta(dir).publish.hanamii.projectId).toBe('proj-1')
  })

  it('記録に projectId があるのに画面が渡さないとき（null・空文字）も、その projectId へ再公開する', async () => {
    const dir = newProject({ publish: { hanamii: { projectId: 'proj-existing' } } })
    for (const stale of [undefined, null, '']) {
      reqs = []
      const r = await publish(dir, { projectId: stale })
      expect(r.ok, String(stale)).toBe(true)
      expect(createCalls(), String(stale)).toHaveLength(0)
      expect(deployCalls(), String(stale)).toEqual([`POST ${BASE}/api/v1/projects/proj-existing/deploy`])
      expect(r.projectId, String(stale)).toBe('proj-existing')
    }
  })

  it('画面が渡した projectId が記録と一致するときは、その projectId へ再公開する（ふだんの再公開）', async () => {
    const dir = newProject({ publish: { hanamii: { projectId: 'proj-on-disk' } } })
    const r = await publish(dir, { projectId: 'proj-on-disk' })
    expect(r.ok).toBe(true)
    expect(createCalls()).toHaveLength(0)
    expect(deployCalls()).toEqual([`POST ${BASE}/api/v1/projects/proj-on-disk/deploy`])
    expect(r.projectId).toBe('proj-on-disk')
  })

  it('記録に projectId が無い（まだ作っていない・破棄したあとの null）なら、新しく作れる（補いすぎない）', async () => {
    for (const meta of [undefined, {}, { publish: { hanamii: { projectId: null } } }, { publish: { hanamii: { projectId: '' } } }, { publish: { hanamii: 'broken' } }]) {
      reqs = []
      const dir = newProject(meta)
      const r = await publish(dir)
      expect(r.ok, JSON.stringify(meta)).toBe(true)
      expect(createCalls(), JSON.stringify(meta)).toHaveLength(1)
      expect(deployCalls(), JSON.stringify(meta)).toHaveLength(0)
    }
  })

  it('壊れた記録ファイルでも落ちない（新しく作る）', async () => {
    const dir = newProject()
    fs.writeFileSync(path.join(dir, '.sakuraide.json'), '{ broken', 'utf-8')
    const r = await publish(dir)
    expect(r.ok).toBe(true)
    expect(createCalls()).toHaveLength(1)
  })
})
