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
import { writeApprunDedicatedRecordFs, writePublishRecordFs, readApprunDedicatedFs } from '../src/main/publishMetaFs'
import { resetProjectOpsForTests } from '../src/main/projectOps'

registerApprunDedicatedHandlers({} as any)

const AUTH = { token: 'dedicated-token-AAAA1111', secret: 'dedicated-secret-BBBB2222' }
const EVENT = { sender: { send: () => {} } }
const teardown = (dir: string) => h.handlers.get('apprunDedicated:teardown')!(EVENT, dir, AUTH, { confirmed: true })

let dirs: string[] = []
function newProject(opts: { app: boolean; brokenEnv?: boolean; row?: boolean } = { app: true }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-ops-dedicated-td-'))
  dirs.push(dir)
  writeApprunDedicatedRecordFs(dir, {
    clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1',
    ...(opts.app ? { applicationID: 'app1', applicationName: 'myapp', activeVersion: 1 } : {}),
  })
  // 📡 一覧が読む公開記録。専有型のほかに Vercel もある（消してよいのは専有型だけ）。`row:false` は専有型の行が無いプロジェクト。
  if (opts.row !== false) writePublishRecordFs(dir, 'sakura-apprun-dedicated', { publishedAt: '2026-09-28T00:00:00.000Z', url: 'https://app.example.com/' })
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

  // V9（D1=1・0.6.22 段階3B-1）: 以前は「アプリが消えたら行を外す」（appDeleted ?? ok）で、保存場所だけ残っても行が消え、
  // 残った保存場所は手順6から消すしかなかった。いまは保存場所まで片づく（ok）まで行を残す＝📡 の行の 🗑 を押し直せる。
  it('★★ アプリは消えたが、保存場所の片づけだけが失敗した（ok:false・appDeleted:true）: 公開記録は残す（V9。押し直せる）。押し直して全部片づくと消える', async () => {
    const dir = newProject({ app: true, brokenEnv: true })
    h.teardown = deletesApp({ ok: true, executed: ['アプリケーション『app1』を削除しました'], message: '', remaining: {} })

    const r = await teardown(dir)
    expect(r.ok).toBe(false) // 保存場所の設定を読めない
    expect(r.appDeleted).toBe(true)
    expect(targetsOf(dir)).toEqual(['sakura-apprun-dedicated', 'vercel']) // 直す前: ['vercel']（行が消えていた）

    // 保存場所の設定を直して（ここでは env.json を外して「保存場所を使っていない」にして）押し直すと、全部片づいて行が消える
    fs.rmSync(path.join(dir, '.sakura-cloud', 'env.json'))
    h.teardown = async () => ({ ok: true, executed: [], message: '', remaining: {} })
    const again = await teardown(dir)
    expect(again.ok).toBe(true)
    expect(targetsOf(dir)).toEqual(['vercel'])
  })

  it('★★ アプリの削除に失敗した（ok:false・アプリは残っている）: 公開記録は消さない（まだ公開中のものを一覧から隠さない）', async () => {
    const dir = newProject()
    h.teardown = async () => ({ ok: false, executed: [], message: 'アプリの削除に失敗しました', remaining: { applicationID: 'app1', loadBalancerID: 'l1', asgID: 'a1', clusterID: 'c1' } })

    const r = await teardown(dir)
    expect(r.ok).toBe(false)
    expect(targetsOf(dir)).toEqual(['sakura-apprun-dedicated', 'vercel'])
  })

  it('★★ 専有型の行（公開記録）が無かった: 触れない（行を作りも、ほかの公開先を消しもしない）', async () => {
    const dir = newProject({ app: false, row: false })
    h.teardown = async () => ({ ok: true, executed: [], message: '', remaining: {} })

    const r = await teardown(dir)
    expect(r.ok).toBe(true)
    expect(targetsOf(dir)).toEqual(['vercel'])
  })

  // 2026-10-08 検分: 「破棄前に applicationID があったか」で決めていたため、途中で止まった削除を押し直して全部消せても、
  // 2回目は applicationID が無く（1回目でアプリが消えて記録から外れた）、行が永久に残った（幽霊の行）。
  // 今は「破棄前に行（公開記録）があったか」で決める。次の2つは、その幽霊の行が消えること。
  it('★★★ 幽霊の行（公開記録はあるが、記録に applicationID が無い）を、全部消せた回に消す（途中で止まった削除の押し直し）', async () => {
    const dir = newProject({ app: false }) // 行あり・applicationID なし＝1回目でアプリが消えたあとの記録
    h.teardown = async () => ({ ok: true, executed: ['クラスタ『c1』を削除しました'], message: '', remaining: {} })

    const r = await teardown(dir)
    expect(r.ok).toBe(true)
    expect(targetsOf(dir)).toEqual(['vercel'])
  })

  // 2026-10-08 検分 D: 行（publish.targets の専有型の記録）に日時（publishedAt）が無い——{ url } だけ——のときも、一覧は
  // 「公開済み（日時不明）」の行を出す。main が「行があったか」を publishedAt で見ると、日時の無い行は永久に外れない。
  // 偽 client（teardownFlow の偽物）に流して、実際の .sakuraide.json で見る。
  const rowWithoutDate = (d: string) => {
    const meta = metaOf(d)
    meta.publish.targets['sakura-apprun-dedicated'] = { url: 'https://app.example.com/' } // publishedAt なし
    fs.writeFileSync(path.join(d, '.sakuraide.json'), JSON.stringify(meta, null, 2), 'utf-8')
  }

  it('★★★ 日時の無い行（{ url } だけ）も、全部消せた回に main が外す。ほかの公開先の行は残る', async () => {
    const dir = newProject({ app: true })
    rowWithoutDate(dir)
    expect(metaOf(dir).publish.targets['sakura-apprun-dedicated'].publishedAt).toBeUndefined()
    h.teardown = deletesApp({ ok: true, executed: ['アプリケーション『app1』を削除しました（消えたことを確認）'], message: '', remaining: {} })

    const r = await teardown(dir)
    expect(r.ok).toBe(true)
    expect(targetsOf(dir), '日時の無い行が残っている（幽霊の行になる）').toEqual(['vercel'])
    expect(metaOf(dir).publish.targets.vercel.url).toBe('https://myapp.vercel.app/')
  })

  it('★★ 日時の無い行でも、途中で止まったなら残す（押し直す 🗑 を残す）。アプリが消えて保存場所だけ失敗した回も残す（V9）', async () => {
    const stopped = newProject({ app: true })
    rowWithoutDate(stopped)
    h.teardown = async () => ({ ok: false, executed: [], message: 'ロードバランサの削除に失敗しました', remaining: { applicationID: 'app1', loadBalancerID: 'l1' } })
    expect((await teardown(stopped)).ok).toBe(false)
    expect(targetsOf(stopped)).toEqual(['sakura-apprun-dedicated', 'vercel'])

    const storageOnly = newProject({ app: true, brokenEnv: true })
    rowWithoutDate(storageOnly)
    h.teardown = deletesApp({ ok: true, executed: ['アプリケーション『app1』を削除しました'], message: '', remaining: {} })
    const r = await teardown(storageOnly)
    expect(r.ok).toBe(false)
    expect(r.appDeleted).toBe(true)
    expect(targetsOf(storageOnly)).toEqual(['sakura-apprun-dedicated', 'vercel']) // 直す前: ['vercel']
  })

  it('★★ 押し直しでもまた途中で止まったなら、行は残す（押し直す 🗑 を残す）', async () => {
    const dir = newProject({ app: false })
    h.teardown = async () => ({ ok: false, executed: [], message: 'ロードバランサの削除に失敗しました', remaining: { loadBalancerID: 'l1', asgID: 'a1', clusterID: 'c1' } })

    const r = await teardown(dir)
    expect(r.ok).toBe(false)
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

// ── 2026-10-08 検分: env.json が JSON としては読めるが、スペックの検証に通らないとき ───────────────────────────────
// 確認画面の `storage:placement`（loadCloudSpec）は投げて「保存場所の設定を読めない」と言うのに、破棄の本体は readSpec
// （検証に通らないと null＝「保存場所を使っていない」）で読んでいたため、保存場所に触れないまま成功を返し、前回の削除で立てた
// 「保存場所が残っている」印（storageLeftoverBucket）まで下ろしていた。資源の記録は空になるので手順6のボタンも出ず、Koto から
// 押し直せないまま保存場所の月額が続く。いまは画面と main が同じ読み方（loadCloudSpec）なので、どちらも「読めない」と言い、印は残る。
describe('★★★ 検証に通らない env.json: 「保存場所を使っていない」と読まない。印を下ろさず、削除していないことを言う', () => {
  const brokenSpec = (d: string, text: string) => {
    fs.mkdirSync(path.join(d, '.sakura-cloud'), { recursive: true })
    fs.writeFileSync(path.join(d, '.sakura-cloud', 'env.json'), text, 'utf-8')
  }

  it.each([
    ['空のオブジェクト', '{}'],
    ['name だけ', JSON.stringify({ name: 'myapp' })],
    ['version が 0', JSON.stringify({ version: 0, name: 'myapp' })],
  ])('%s: 全部消せた回でも ok:false・appDeleted:true。「保存場所は削除していません」と言い、残った印は下ろさない', async (_label, text) => {
    const dir = newProject({ app: false })
    writeApprunDedicatedRecordFs(dir, { storageLeftoverBucket: 'koto-data-x' })
    brokenSpec(dir, text)
    h.teardown = async () => ({ ok: true, executed: ['クラスタ『c1』を削除しました'], message: '', remaining: {} })

    const r = await teardown(dir)
    expect(r.ok).toBe(false)
    expect(r.appDeleted).toBe(true)
    expect(r.message).toContain('保存場所の設定を読めないため、保存場所は削除していません')
    // HANAMII と同じく、月額が続くことと、どこで確かめて消すかを添える（検分2巡目）
    expect(r.message).toContain('消すまで月額が続きます')
    expect(r.message).toContain('コントロールパネル（オブジェクトストレージ）で、残っている保存場所を確かめて削除してください')
    expect(readApprunDedicatedFs(dir).storageLeftoverBucket).toBe('koto-data-x') // 直す前: 下ろして ok:true
  })

  it('対照: env.json が無い（保存場所を使っていない）なら、これまでどおり成功し、残った印は下ろす', async () => {
    const dir = newProject({ app: false })
    writeApprunDedicatedRecordFs(dir, { storageLeftoverBucket: 'koto-data-x' })
    h.teardown = async () => ({ ok: true, executed: ['クラスタ『c1』を削除しました'], message: '', remaining: {} })

    const r = await teardown(dir)
    expect(r.ok).toBe(true)
    expect(readApprunDedicatedFs(dir).storageLeftoverBucket).toBeFalsy()
  })
})

describe('公開記録を片づける規則は main の shouldForgetPublishRecord の1つだけ（2026-10-08: 画面の同じ規則は消した）', () => {
  // 以前は画面（shouldClearPublishRecord）にも同じ規則があり、真理値表で一致を固定していた。画面は消さなくなったので、
  // 規則そのものを書き下して固定する（手順6からも 📡 の 🗑 からも、この規則だけが働く）。
  // 2026-10-08 検分: 第1項は「破棄前に applicationID があったか」ではなく「破棄前に公開記録（行）があったか」。
  const TABLE: Array<[boolean, { ok: boolean; appDeleted?: boolean } | null | undefined, boolean]> = [
    // 行があった: 保存場所まで片づいたか（ok）だけで決める。appDeleted は見ない（V9・D1=1。以前は appDeleted ?? ok）
    [true, null, false], [true, undefined, false],
    [true, { ok: true }, true], [true, { ok: false }, false],
    [true, { ok: true, appDeleted: false }, true], [true, { ok: false, appDeleted: true }, false],
    [true, { ok: false, appDeleted: false }, false], [true, { ok: true, appDeleted: true }, true],
    // 行が無かった: 消す公開記録が無いので何もしない
    [false, null, false], [false, undefined, false], [false, { ok: true }, false], [false, { ok: false }, false],
    [false, { ok: true, appDeleted: false }, false], [false, { ok: false, appDeleted: true }, false],
    [false, { ok: false, appDeleted: false }, false], [false, { ok: true, appDeleted: true }, false],
  ]
  it('16通りの答えを書き下して固定する', () => {
    expect(TABLE).toHaveLength(16)
    for (const [hadPublishRecord, result, expected] of TABLE) {
      expect(shouldForgetPublishRecord({ hadPublishRecord, result }), JSON.stringify({ hadPublishRecord, result })).toBe(expected)
    }
  })

  it('画面側の同じ規則（shouldClearPublishRecord）は無い', async () => {
    const actions = await import('../src/renderer/apprunDedicatedActions')
    expect((actions as Record<string, unknown>).shouldClearPublishRecord).toBeUndefined()
  })
})
