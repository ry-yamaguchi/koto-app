import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── なぜこのテストが要るか（2026-09-30 検分の指摘1・重大）────────────────────────────────
// HANAMII の破棄が成功したあとの記録の片づけ（設定の projectId を空に・公開記録を消す）は、以前は
// **画面（HanamiiPanel）が「破棄の結果を初めて見たとき」に行っていた**。画面は記録を再生する
// （閉じて開き直すと、まだ見られていない古い結果をもう一度「初めて見た」と扱う）ので、次の流れで
// **新しい公開の記録を消した**:
//   ①別の公開先の結果 F がまだ見られていない → ②HANAMII の破棄 R1 が終わる（F より新しいので見たことにされない）
//   → ③同じ画面で HANAMII に公開し直す（R2・新しい projectId）→ ④閉じて開き直す
//   → R1 がもう一度「初めて見た」扱いになり、片づけが再び走って R2 の projectId と公開記録を消す
//   → 次の公開で HANAMII のプロジェクトが二重に作られ、動いているほうは Koto から辿れなくなる（🗑 も押せない）。
// 直し方: 専有型の⑥と同じく、**main が（鍵の中で・消したそのときに1回だけ）記録を片づける**。
//
// ここは**ソースの文字列を読まない**。hanamii:teardown を実際に呼び、偽の HANAMII（fetch）へ流して、
// **ディスクの .sakuraide.json がどうなったか**で固定する（掟10）。
//   ・消してよいのは「いま記録が指しているプロジェクト」を消したときだけ（別のプロジェクトを指していたら触らない）
//   ・失敗した・保存場所が残った回は触らない（押し直せる入口を残す）
//   ・記録が無い・壊れているときは、ファイルを作らず・上書きもしない
//   ・記録を片づけ終えてから、処理の記録（projectOps）が「終わった」になる（画面が読むときには片づいている）

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  /** さくらのクラウドの認証情報が登録されているか（保存場所を片づけるのに要る）。 */
  hasCreds: true,
  /** HANAMII API が返す HTTP ステータス（DELETE /api/v1/projects/<id>）。 */
  hanamiiStatus: 204,
  hanamiiCalls: [] as string[],
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {} },
  dialog: {},
}))

vi.mock('../src/main/cloud/auth', async (importOriginal) => {
  const real = await importOriginal<any>()
  return { ...real, loadCredentials: () => (h.hasCreds ? { token: 'tok', secret: 'sec' } : null) }
})

import { registerHanamiiHandlers, PROJECT_MISMATCH_TEARDOWN } from '../src/main/ipc/hanamii'
import { settleHanamiiTeardownFs } from '../src/main/publishMetaFs'
import { setProjectOpsListener, resetProjectOpsForTests, getOps } from '../src/main/projectOps'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'

registerHanamiiHandlers({} as any)
const teardown = h.handlers.get('hanamii:teardown')!

const EVENT = {}
const TOKEN = 'hnm_test'
const P1 = 'hnm-proj-1'
const P2 = 'hnm-proj-2'

let projectDir = ''
const realFetch = globalThis.fetch

const metaFile = () => path.join(projectDir, '.sakuraide.json')
const readMeta = (): any => JSON.parse(fs.readFileSync(metaFile(), 'utf-8'))
const writeMeta = (m: unknown) => fs.writeFileSync(metaFile(), JSON.stringify(m, null, 2), 'utf-8')

/** 公開済みの記録（HANAMII のプロジェクト P1・公開記録・別の公開先の記録・専有型の資源ID・設定）。 */
function publishedMeta(projectId: string = P1): any {
  return {
    name: 'myapp',
    publish: {
      hanamii: { projectId, workspaceId: 'ws-1', name: 'myapp', envs: [{ key: 'A', value: '1', secret: false }] },
      targets: {
        hanamii: { publishedAt: '2026-09-29T00:00:00.000Z', url: 'https://myapp.example.test' },
        vercel: { publishedAt: '2026-09-28T00:00:00.000Z', url: 'https://myapp.vercel.test' },
      },
      apprunDedicated: { clusterID: 'cluster-1' },
    },
  }
}

/** 保存場所を使わない env.json（片づける保存場所が無い＝HANAMII のプロジェクトを消せば破棄は成功）。 */
function noStorageEnv() {
  const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: false })
  spec.persistence = { objectStorage: [] } as any
  fs.mkdirSync(path.join(projectDir, '.sakura-cloud'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), JSON.stringify(spec, null, 2), 'utf-8')
}

/** 同意済みの保存場所が1つある env.json（認証情報が無いと片づけられず、保存場所だけ残る形を作る）。 */
function withStorageEnv() {
  const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: false })
  spec.persistence = { objectStorage: [{ bucket: 'koto-data-x', prefix: 'projects/myapp/', shared: true, consentedAt: '2026-08-14T00:00:00.000Z' }] } as any
  fs.mkdirSync(path.join(projectDir, '.sakura-cloud'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), JSON.stringify(spec, null, 2), 'utf-8')
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-hnm-teardown-record-'))
  h.hasCreds = true
  h.hanamiiStatus = 204
  h.hanamiiCalls = []
  resetProjectOpsForTests()
  globalThis.fetch = (async (input: unknown, init: any) => {
    h.hanamiiCalls.push(`${init?.method ?? 'GET'} ${String(input)}`)
    const status = h.hanamiiStatus
    return { ok: status >= 200 && status < 300, status, async text() { return '' } }
  }) as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
  setProjectOpsListener(null)
  fs.rmSync(projectDir, { recursive: true, force: true })
})

const run = (projectId: string = P1) => teardown(EVENT, projectId, TOKEN, projectDir)

describe('★★★ HANAMII の破棄: 成功したら、main が記録（projectId・公開記録）を片づける', () => {
  it('★★★ projectId を空にし、HANAMII の公開記録を消す。ほかの設定・ほかの公開先・専有型の資源IDは残す', async () => {
    noStorageEnv()
    writeMeta(publishedMeta())
    const r = await run()
    expect(r.ok).toBe(true)
    expect(h.hanamiiCalls).toEqual([`DELETE https://hanamii.jp/api/v1/projects/${P1}`])

    const m = readMeta()
    expect(m.publish.hanamii.projectId).toBeNull()
    expect(m.publish.targets.hanamii, '破棄したのに、公開記録（📡 一覧の行）が残っている').toBeUndefined()
    // 消してはいけないもの
    expect(m.publish.hanamii.workspaceId).toBe('ws-1')
    expect(m.publish.hanamii.envs).toEqual([{ key: 'A', value: '1', secret: false }])
    expect(m.publish.targets.vercel, '別の公開先の記録まで消えている').toEqual({ publishedAt: '2026-09-28T00:00:00.000Z', url: 'https://myapp.vercel.test' })
    expect(m.publish.apprunDedicated, '専有型の資源IDまで消えている').toEqual({ clusterID: 'cluster-1' })
    expect(m.name).toBe('myapp')
  })

  it('★★★ 消そうとした projectId が、いま記録が指しているものと違うとき（新しい公開で作り直した・別のプロジェクトから持ち越した）は、何も消さず、記録にも触らない', async () => {
    // 記録は P2（新しい公開）。P1 を消せと言われても、HANAMII へは1件も要求を出さず、保存場所も片づけない
    // （2026-09-30 検分・掟11: 以前は P1 を消したうえで、いまのプロジェクトの保存場所まで片づけた。
    //  settleHanamiiTeardownFs の照合が守るのは記録だけで、消すことそのものは止めていなかった）。
    withStorageEnv()
    writeMeta(publishedMeta(P2))
    const before = fs.readFileSync(metaFile(), 'utf-8')
    const r = await run(P1)
    expect(r.ok).toBe(false)
    expect(r.message).toBe(PROJECT_MISMATCH_TEARDOWN)
    expect(h.hanamiiCalls, '別のプロジェクトの HANAMII のアプリを消した').toEqual([])
    expect(r.appDeleted, '消していないのに「消えた」と言っている').toBeUndefined()
    expect(fs.readFileSync(metaFile(), 'utf-8'), '別のプロジェクト（新しい公開）の記録を書き換えた').toBe(before)
    expect(readMeta().publish.hanamii.projectId).toBe(P2)
    expect(readMeta().publish.targets.hanamii).toBeDefined()
    // 処理の記録にも「うまくいかなかった」として残る（画面が理由を出せる）
    expect(getOps(projectDir).last?.result).toMatchObject({ ok: false, message: PROJECT_MISMATCH_TEARDOWN })
  })

  it('★★★ 記録に projectId が無い（HANAMII に公開していないプロジェクトへ、別のプロジェクトの projectId が持ち越された）ときも、何も消さない', async () => {
    withStorageEnv()
    for (const meta of [undefined, {}, { publish: { hanamii: { projectId: null } } }, { publish: { hanamii: { projectId: '' } } }, { publish: { hanamii: 'broken' } }, '{ 壊れた記録']) {
      h.hanamiiCalls = []
      if (meta === undefined) fs.rmSync(metaFile(), { force: true })
      else if (typeof meta === 'string') fs.writeFileSync(metaFile(), meta, 'utf-8')
      else writeMeta(meta)
      const before = fs.existsSync(metaFile()) ? fs.readFileSync(metaFile(), 'utf-8') : null
      const r = await run(P1)
      const label = JSON.stringify(meta)
      expect(r.ok, label).toBe(false)
      expect(r.message, label).toBe(PROJECT_MISMATCH_TEARDOWN)
      expect(h.hanamiiCalls, `${label}: 別のプロジェクトの HANAMII のアプリを消した`).toEqual([])
      expect(fs.existsSync(metaFile()) ? fs.readFileSync(metaFile(), 'utf-8') : null, `${label}: 記録を書き換えた`).toBe(before)
    }
  })

  it('★★ 一致する projectId なら消せる（断ったあとも鍵は外れている）', async () => {
    noStorageEnv()
    writeMeta(publishedMeta(P2))
    expect((await run(P1)).ok).toBe(false)
    const r = await run(P2)
    expect(r.ok).toBe(true)
    expect(h.hanamiiCalls).toEqual([`DELETE https://hanamii.jp/api/v1/projects/${P2}`])
  })

  it('★★★ HANAMII のプロジェクトを消せなかったときは、記録に触らない', async () => {
    noStorageEnv()
    writeMeta(publishedMeta())
    const before = fs.readFileSync(metaFile(), 'utf-8')
    h.hanamiiStatus = 500
    const r = await run()
    expect(r.ok).toBe(false)
    expect(fs.readFileSync(metaFile(), 'utf-8'), '消せていないのに、記録を書き換えた').toBe(before)
  })

  it('★★★ 保存場所だけ残った（プロジェクトは消えた・ok は false）ときは、記録も projectId も残す（🗑 を押し直せる入口）', async () => {
    withStorageEnv()
    writeMeta(publishedMeta())
    const before = fs.readFileSync(metaFile(), 'utf-8')
    h.hasCreds = false          // 保存場所を片づけられない
    const r = await run()
    expect(r.ok).toBe(false)
    expect(r.appDeleted).toBe(true)
    expect(fs.readFileSync(metaFile(), 'utf-8'), '保存場所が残ったのに、記録を消した（押し直す入口が無くなる）').toBe(before)
  })

  it('★★ 記録を書き換えられなかったときも、破棄は成功のまま。片づけられなかったことは黙らず知らせに載る', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return // root は書けてしまう
    noStorageEnv()
    writeMeta(publishedMeta())
    fs.chmodSync(metaFile(), 0o444)
    try {
      const r = await run()
      expect(r.ok, '記録が書けなかっただけで、消せた破棄を失敗にしない').toBe(true)
      expect((r.executed ?? []).some((l: string) => l.startsWith('⚠️') && l.includes('公開の記録')), '片づけられなかったことを言っていない').toBe(true)
      expect(readMeta().publish.hanamii.projectId, '前提: 書けていない').toBe(P1)
    } finally { fs.chmodSync(metaFile(), 0o644) }
  })
})

// ── 記録の片づけそのもの（settleHanamiiTeardownFs）────────────────────────────────────────
// ハンドラは、渡された projectId が記録と一致するときしか、ここへ来ない（上）。それでも、外から記録が書き換わるなど
// 想定外のときに「別のプロジェクトの記録を消さない・無い記録を作らない・壊れた記録を上書きしない」は、この関数自身が守る（二重の守り）。
describe('★★ settleHanamiiTeardownFs: 消した projectId が記録と一致するときだけ、記録を片づける', () => {
  it('★★★ 記録の projectId が違う（新しい公開）なら、触らない', () => {
    writeMeta(publishedMeta(P2))
    const before = fs.readFileSync(metaFile(), 'utf-8')
    expect(settleHanamiiTeardownFs(projectDir, P1)).toEqual({ ok: true, cleared: false })
    expect(fs.readFileSync(metaFile(), 'utf-8')).toBe(before)
  })

  it('★★ 記録の projectId がすでに空なら、残った公開記録だけを消す（何度呼んでも同じ結果）', () => {
    const m = publishedMeta()
    m.publish.hanamii.projectId = null
    writeMeta(m)
    expect(settleHanamiiTeardownFs(projectDir, P1)).toEqual({ ok: true, cleared: true })
    expect(readMeta().publish.targets.hanamii).toBeUndefined()
    expect(readMeta().publish.hanamii.projectId).toBeNull()
    expect(settleHanamiiTeardownFs(projectDir, P1).ok, '2回目（もう無い）でも落ちない').toBe(true)
    expect(readMeta().publish.targets.vercel).toBeDefined()
  })

  it('★ 記録ファイルが無いときは、作らない。壊れているときは、上書きしない', () => {
    expect(settleHanamiiTeardownFs(projectDir, P1)).toEqual({ ok: true, cleared: false })
    expect(fs.existsSync(metaFile()), '記録が無いのに、ファイルを作った').toBe(false)

    fs.writeFileSync(metaFile(), '{ 壊れた記録', 'utf-8')
    expect(settleHanamiiTeardownFs(projectDir, P1)).toEqual({ ok: true, cleared: false })
    expect(fs.readFileSync(metaFile(), 'utf-8'), '壊れた記録を上書きした').toBe('{ 壊れた記録')
  })
})

describe('★★ 記録の片づけは、処理の記録（projectOps）が「終わった」になる前に済んでいる', () => {
  it('★★★ 画面が終わった記録を読むときには、ディスクの projectId はもう空（画面が古い写しを見て戻さない）', async () => {
    noStorageEnv()
    writeMeta(publishedMeta())
    const seenAtFinish: unknown[] = []
    setProjectOpsListener((_dir, snap) => {
      if (snap.running === null && snap.last?.handler === 'hanamii:teardown') seenAtFinish.push(readMeta().publish.hanamii.projectId)
    })
    await run()
    expect(seenAtFinish.length).toBeGreaterThan(0)
    expect(seenAtFinish, '終わった記録が見えた時点で、まだ projectId が残っていた').toEqual(seenAtFinish.map(() => null))
    expect(getOps(projectDir).last?.result?.ok).toBe(true)
  })
})
