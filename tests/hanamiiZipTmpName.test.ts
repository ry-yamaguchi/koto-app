import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── なぜこのテストが要るか（2026-10-19・0.6.22 L-2a の関所で、HANAMII の公開の試験が 2 回、別の形で落ちた）──────────
//
// hanamii:publish は、プロジェクトを ZIP にするとき、一時フォルダに `hanamii-<ミリ秒>.zip` を作っていた。名前が**時刻だけ**だったので、
// 同じミリ秒に 2 つの公開が始まると同じファイルを取り合う（zip が既にあるファイルへ足す・片方が読み終えて消したファイルを、もう片方が
// 読もうとして ENOENT になる）。Koto の本番では鍵（withProjectLock）があるので同じプロジェクトでは起きないが、別のプロジェクトの公開が同じ
// ミリ秒に重なれば同じことが起きうる。試験では、試験ファイルが並列で走って一時フォルダを共有するため、全体の試験で数回に 1 回落ちた
// （projectOpsHandlers の「応答がトークンを含む文で失敗しても…」は ZIP 化に失敗して返り値に偽の HANAMII の文が載らず、
//  「A の HANAMII 公開が走っている間…」は偽の HANAMII に一度も着かないまま 30 秒待って落ちた）。
//
// 直し方: 一時ファイルの名前に、衝突しない部分（乱数）を足す。ここは**ソースの文字列を読まない**。時計を止めて（同じミリ秒を作って）
// 別のプロジェクトの公開を同時に走らせ、**偽の HANAMII へ実際に上がった ZIP の中身**で固定する。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  /** app.getPath('temp') が返す場所（試験ごとの空のフォルダ。ほかの試験ファイルと共有しない）。 */
  tmpRoot: '',
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => h.tmpRoot, getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {} },
  dialog: {},
}))

import { registerHanamiiHandlers } from '../src/main/ipc/hanamii'

registerHanamiiHandlers({} as any)

const TOKEN = 'tok-zip-test'
/** ZIP を偽の HANAMII へ上げ終え、検証の段で断られたときの返り値の文の頭（ZIP 化に失敗したときは、この文にならない）。 */
const CHECK_STAGE = 'アップロードの検証に失敗しました'
const BASE = 'https://hanamii.jp'

let projectDirs: string[] = []
let realFetch: typeof globalThis.fetch
/** 偽の HANAMII が受け取った ZIP（アップロード先の URL → 中身）。 */
let uploaded = new Map<string, Buffer>()

const jsonRes = (status: number, data: unknown) => ({ ok: status < 300, status, async text() { return JSON.stringify(data) } })

/** index.html（静的サイト）と、そのプロジェクトだけにあるファイル 1 つを持つプロジェクト。 */
function newProject(marker: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-hnm-zip-'))
  projectDirs.push(dir)
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>hi</body></html>', 'utf-8')
  fs.writeFileSync(path.join(dir, marker), marker, 'utf-8')
  return dir
}
const publish = (dir: string, name: string) =>
  h.handlers.get('hanamii:publish')!({}, dir, { token: TOKEN, workspaceId: 'ws-1', name })

beforeEach(() => {
  projectDirs = []
  uploaded = new Map()
  h.tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-hnm-zip-tmp-'))
  realFetch = globalThis.fetch
  // 偽の HANAMII。実ネットワークへは出ない。ZIP を受け取ったあと、検証の段で断って公開をそこで終える（待ちの段に入らない）。
  globalThis.fetch = (async (input: unknown, init: any) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (method === 'POST' && url === `${BASE}/api/v1/uploads`) {
      const fileName = JSON.parse(String(init?.body ?? '{}')).fileName as string
      return jsonRes(200, { upload: { uploadUrl: `https://upload.example/${fileName}`, id: `up-${fileName}` } })
    }
    if (method === 'PUT' && url.startsWith('https://upload.example/')) {
      uploaded.set(url, Buffer.from(init.body))
      return jsonRes(200, {})
    }
    if (method === 'POST' && /\/api\/v1\/uploads\/[^/]+\/check$/.test(url)) return jsonRes(400, { error: { message: '検証はここで止める（テスト）' } })
    return jsonRes(404, { error: { message: `想定外の要求: ${method} ${url}` } })
  }) as unknown as typeof fetch
})
afterEach(() => {
  vi.restoreAllMocks()
  globalThis.fetch = realFetch
  for (const d of [...projectDirs, h.tmpRoot]) fs.rmSync(d, { recursive: true, force: true })
})

describe('★★★ HANAMII の公開: 同じミリ秒に重なった別のプロジェクトの公開が、ZIP を取り合わない', () => {
  it('★★★ 時計を止めて 2 つのプロジェクトを同時に公開: それぞれの ZIP には、自分のファイルだけが入っている', async () => {
    const a = newProject('only-in-a.txt')
    const b = newProject('only-in-b.txt')
    // 同じミリ秒（zip の一時ファイル名が時刻だけだと、同じ名前になる）
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)

    const [ra, rb] = await Promise.all([publish(a, 'app-a'), publish(b, 'app-b')])

    // どちらも ZIP 化を終えて、偽の HANAMII の検証の段まで進んだ（ZIP 化で失敗していない）
    expect(ra.message ?? '', 'A が ZIP 化の段で落ちた').toContain(CHECK_STAGE)
    expect(rb.message ?? '', 'B が ZIP 化の段で落ちた').toContain(CHECK_STAGE)

    const zipA = uploaded.get('https://upload.example/app-a.zip')
    const zipB = uploaded.get('https://upload.example/app-b.zip')
    expect(zipA, 'A の ZIP が偽の HANAMII に着いていない').toBeTruthy()
    expect(zipB, 'B の ZIP が偽の HANAMII に着いていない').toBeTruthy()
    // ZIP のファイル名は平文で入っている
    expect(zipA!.includes('only-in-a.txt'), 'A の ZIP に A のファイルが無い').toBe(true)
    expect(zipA!.includes('only-in-b.txt'), 'A の ZIP に B のファイルが混ざった').toBe(false)
    expect(zipB!.includes('only-in-b.txt'), 'B の ZIP に B のファイルが無い').toBe(true)
    expect(zipB!.includes('only-in-a.txt'), 'B の ZIP に A のファイルが混ざった').toBe(false)
  })

  it('公開が終わったあと、一時フォルダに ZIP も同梱用のフォルダも残らない', async () => {
    const a = newProject('only-in-a.txt')
    const r = await publish(a, 'app-a')
    expect(r.message ?? '', 'ZIP 化の段で落ちた').toContain(CHECK_STAGE)
    expect(fs.readdirSync(h.tmpRoot), '一時フォルダに残り物がある').toEqual([])
  })
})
