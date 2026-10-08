import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── ⑥「すべて削除する」の後始末（公開記録を消す）は main が済ませる（2026-09-29）──────────────────────
//
// 直す前は、破棄のあとに 📡 公開したもの一覧から存在しないアプリを消す（publish.targets の記録を片づける）
// のを**画面（doTeardown）だけ**が行っていた。⑥のダイアログを閉じても破棄は main が最後まで進めるので、
// 閉じた場合だけこの後始末が走らず、消したはずのアプリが一覧に公開中として出続けた（URL は 404）。
// 作者の決定（処理中でもダイアログを閉じてよい）と組み合わさる穴なので、main の破棄ハンドラの中で行う。
//
// ここは**実際に IPC ハンドラを呼ぶ**（画面は1度も出てこない）。teardownFlow だけを偽物にして、
// 「アプリが消えた／消えなかった」の返り方ごとに、実際の記録ファイル（.sakuraide.json）を読んで確かめる。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  /** teardownFlow の偽物。本物と同じく、アプリを消したら記録の applicationID を外す。 */
  teardown: null as null | ((projectDir: string) => Promise<any>),
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test', on: () => {} },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {} },
  dialog: {},
}))

vi.mock('../src/main/cloud/apprunDedicatedApply', async (importOriginal) => {
  const real = await importOriginal<any>()
  return { ...real, teardownFlow: async (_auth: unknown, projectDir: string) => h.teardown!(projectDir) }
})

import { registerApprunDedicatedHandlers } from '../src/main/ipc/apprunDedicated'
import { shouldForgetPublishRecord } from '../src/main/cloud/apprunDedicatedApply'
import { shouldClearPublishRecord } from '../src/renderer/apprunDedicatedActions'
import { writeApprunDedicatedRecordFs, writePublishRecordFs, readApprunDedicatedFs } from '../src/main/publishMetaFs'
import { resetProjectOpsForTests } from '../src/main/projectOps'

registerApprunDedicatedHandlers({} as any)

const AUTH = { token: 'dedicated-token-AAAA1111', secret: 'dedicated-secret-BBBB2222' }
const EVENT = { sender: { send: () => {} } }
const teardown = (dir: string) => h.handlers.get('apprunDedicated:teardown')!(EVENT, dir, AUTH, { confirmed: true })

let dirs: string[] = []
function newProject(opts: { app: boolean; brokenEnv?: boolean } = { app: true }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-ops-dedicated-td-'))
  dirs.push(dir)
  writeApprunDedicatedRecordFs(dir, {
    clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1',
    ...(opts.app ? { applicationID: 'app1', applicationName: 'myapp', activeVersion: 1 } : {}),
  })
  // 📡 一覧が読む公開記録。専有型のほかに Vercel もある（消してよいのは専有型だけ）。
  writePublishRecordFs(dir, 'sakura-apprun-dedicated', { publishedAt: '2026-09-28T00:00:00.000Z', url: 'https://app.example.com/' })
  writePublishRecordFs(dir, 'vercel', { publishedAt: '2026-09-27T00:00:00.000Z', url: 'https://myapp.vercel.app/' })
  if (opts.brokenEnv) {
    // 保存場所の設定が読めない＝計算資源は消えたが、保存場所の片づけには進めない（ok:false・appDeleted:true）
    fs.mkdirSync(path.join(dir, '.sakura-cloud'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.sakura-cloud', 'env.json'), '{ 壊れた', 'utf-8')
  }
  return dir
}
const targetsOf = (dir: string): string[] => {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, '.sakuraide.json'), 'utf-8'))
  return Object.keys(meta?.publish?.targets ?? {}).sort()
}
const metaOf = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, '.sakuraide.json'), 'utf-8'))

/** 本物の teardownFlow と同じく、アプリを消したあと記録の applicationID を外す。 */
const deletesApp = (result: any) => async (dir: string) => {
  writeApprunDedicatedRecordFs(dir, { applicationID: null, applicationName: null, activeVersion: null })
  return result
}

beforeEach(() => { resetProjectOpsForTests(); dirs = []; h.teardown = null })
afterEach(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })

describe('★★★ ⑥の破棄が済んだら、公開記録（📡 一覧）も main が消す（画面が無くても）', () => {
  it('アプリを公開していて、破棄が全部うまくいった: 専有型の公開記録だけが消える（Vercel の記録・専有型の資源ID欄は残る）', async () => {
    const dir = newProject()
    expect(targetsOf(dir)).toEqual(['sakura-apprun-dedicated', 'vercel'])
    h.teardown = deletesApp({ ok: true, executed: ['アプリケーション『app1』を削除しました（消えたことを確認）'], message: '', remaining: {} })

    const r = await teardown(dir) // 窓（renderer）は1度も出てこない
    expect(r.ok).toBe(true)
    expect(targetsOf(dir)).toEqual(['vercel'])
    expect(metaOf(dir).publish.targets.vercel.url).toBe('https://myapp.vercel.app/')
    // 専有型の資源ID欄（applicationID 等）には触れていない（それを外すのは破棄本体）
    expect(readApprunDedicatedFs(dir).clusterID).toBe('c1')
  })

  it('★★ アプリは消えたが、保存場所の片づけだけが失敗した（ok:false・appDeleted:true）: 公開記録は消す（存在しないアプリを一覧に残さない）', async () => {
    const dir = newProject({ app: true, brokenEnv: true })
    h.teardown = deletesApp({ ok: true, executed: ['アプリケーション『app1』を削除しました'], message: '', remaining: {} })

    const r = await teardown(dir)
    expect(r.ok).toBe(false) // 保存場所の設定を読めない
    expect(r.appDeleted).toBe(true)
    expect(targetsOf(dir)).toEqual(['vercel'])
  })

  it('★★ アプリの削除に失敗した（ok:false・アプリは残っている）: 公開記録は消さない（まだ公開中のものを一覧から隠さない）', async () => {
    const dir = newProject()
    h.teardown = async () => ({ ok: false, executed: [], message: 'アプリの削除に失敗しました', remaining: { applicationID: 'app1', loadBalancerID: 'l1', asgID: 'a1', clusterID: 'c1' } })

    const r = await teardown(dir)
    expect(r.ok).toBe(false)
    expect(targetsOf(dir)).toEqual(['sakura-apprun-dedicated', 'vercel'])
  })

  it('★★ ⑧で公開していなかった（記録に applicationID が無い）: 公開記録には触れない', async () => {
    const dir = newProject({ app: false })
    h.teardown = async () => ({ ok: true, executed: [], message: '', remaining: {} })

    const r = await teardown(dir)
    expect(r.ok).toBe(true)
    expect(targetsOf(dir)).toEqual(['sakura-apprun-dedicated', 'vercel'])
  })

  it('公開記録を消す途中で例外が出ても、破棄の結果は変えない', async () => {
    const dir = newProject()
    h.teardown = async (d: string) => {
      writeApprunDedicatedRecordFs(d, { applicationID: null })
      // .sakuraide.json を読めない形にして、後始末を失敗させる
      fs.writeFileSync(path.join(d, '.sakuraide.json'), '{ 壊れた', 'utf-8')
      return { ok: true, executed: ['x'], message: '', remaining: {} }
    }
    const r = await teardown(dir)
    expect(r.ok).toBe(true)
    expect(r.executed).toEqual(['x'])
  })
})

describe('画面の規則（shouldClearPublishRecord）と main の規則（shouldForgetPublishRecord）は食い違わない', () => {
  const cases: Array<{ hadApplicationID: boolean; result: { ok: boolean; appDeleted?: boolean } | null | undefined }> = []
  for (const hadApplicationID of [true, false]) {
    for (const result of [null, undefined, { ok: true }, { ok: false }, { ok: true, appDeleted: false }, { ok: false, appDeleted: true }, { ok: false, appDeleted: false }, { ok: true, appDeleted: true }]) {
      cases.push({ hadApplicationID, result })
    }
  }
  it('同じ入力なら同じ答え（16通り）', () => {
    expect(cases).toHaveLength(16)
    for (const c of cases) {
      expect(shouldForgetPublishRecord(c), JSON.stringify(c)).toBe(shouldClearPublishRecord(c))
    }
  })
})
