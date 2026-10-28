import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── このテストが固定すること（設計書 docs/teardown-unify-plan.md 10.4.9 の C。2026-10-09 段階1の1a-1）──────────────
// HANAMII の破棄は、共通の骨（cloud/teardownShell.ts）の上に載った。**本物の main（registerHanamiiHandlers が登録するハンドラ）**を呼び、
// 偽の HANAMII サーバ（fetch）と偽の保存場所に実際に流して、**どんな要求が・どの順で出たか**を見る（ソースの文字列は読まない・掟10）。
//
//   ・確認の印が true でない／projectDir が無い／認証の形が違う／鍵が埋まっている → HANAMII へも保存場所へも**要求0件**
//     （P1。以前は確認の印の引数そのものが無く、画面のボタンの確認だけが歯止めだった）
//   ・順序は 1本の並びで固定する: プロジェクト削除 → 一覧 → データ削除 → バケット削除 → 鍵の無効化
//   ・一覧できなければ、1件も消さない（「たぶん空」で消さない）
//   ・DELETE の応答の読み方（D7）: `deleted === true` と 404 だけが「消えた」。202（`deleted=false`）などは保存場所にも記録にも触れない
//
// 偽の応答は原本から写す（tests/hanamiiTeardownFixtures.ts）。保存場所の細かい振る舞いは tests/hanamiiStorageTeardown.test.ts、
// 記録の片づけは tests/hanamiiTeardownRecord.test.ts、保存場所だけ残った回の印は tests/hanamiiTeardownLeftover.test.ts。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  hasCreds: true,
  /** HANAMII の DELETE が返す HTTP ステータスと、本文を差し替えたいときの文字列。 */
  status: 200,
  bodyOverride: null as string | null,
  /** HANAMII へ出た要求と、保存場所へ出た要求を、**1本の並び**で積む（順序を1つの配列で固定するため）。 */
  calls: [] as string[],
  listThrows: false,
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => '/tmp', getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {} },
  dialog: {},
}))

vi.mock('../src/main/cloud/auth', async (importOriginal) => {
  const real = await importOriginal<any>()
  return { ...real, loadCredentials: () => (h.hasCreds ? { token: 'tok', secret: 'sec' } : null) }
})

// 偽の保存場所クライアント。**実物の判断（storageTeardown.ts → teardownPlanFor）はそのまま動かす。**
vi.mock('../src/main/cloud/storageAdapter', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    createStorageAdapter: async () => {
      h.calls.push('storage connect')
      return {
        siteInfo: () => ({ s3Endpoint: 's3.isk01.sakurastorage.jp', region: 'jp-north-1' }),
        async isSiteReady() { return true },
        async ensureBucket() {},
        async putMarker() {},
        async listAllKeys(bucket: string) {
          h.calls.push(`list ${bucket}`)
          if (h.listThrows) throw new Error('一覧を取得できませんでした（テスト）')
          return [`${PREFIX}a.txt`]
        },
        async deleteKeys(bucket: string) { h.calls.push(`deleteKeys ${bucket}`) },
        async deleteBucket(bucket: string) { h.calls.push(`deleteBucket ${bucket}`) },
        async deletePermission(id: string) { h.calls.push(`deletePermission ${id}`) },
        async issueKey() { return { accessKey: 'AKIA-X', secretKey: 'S3CRET-X', permissionId: 'perm-tmp' } },
        async listPermissions() { h.calls.push('listPermissions'); return [{ id: 'perm-hanamii', displayName: 'koto-myapp-hanamii' }] },
        async dispose() {},
      }
    },
  }
})

import { registerHanamiiHandlers } from '../src/main/ipc/hanamii'
import { readHanamiiDeleteReply } from '../src/main/ipc/hanamiiTeardown'
import { withProjectLock, projectBusyMessage } from '../src/main/projectLock'
import { getOps, resetProjectOpsForTests, setProjectOpsListener } from '../src/main/projectOps'
import { STORAGE_TEARDOWN_PROGRESS } from '../src/shared/teardownSupport'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'
import { HANAMII_DELETION_ACCEPTED_WARNING } from '../src/shared/teardownResult'
import { NOT_CONFIRMED_MESSAGE, BAD_PROJECT_DIR_MESSAGE } from '../src/main/cloud/teardownShell'
import { deleteProjectReplyText } from './hanamiiTeardownFixtures'
import { isolatedProjectDir } from './isolatedProject'
import { shownTeardown } from './shownFromEnv'

registerHanamiiHandlers({} as any)
const teardown = shownTeardown(h.handlers.get('hanamii:teardown')!) // 画面の代わりに、確認で見せた保存場所（env.json の記録）を渡す

const EVENT = {}
const TOKEN = 'hnm_test'
const PROJECT_ID = 'hnm-proj-1'
const BUCKET = 'koto-data-x'
const PREFIX = 'projects/myapp/'
const DELETE_CALL = `DELETE https://hanamii.jp/api/v1/projects/${PROJECT_ID}`

let projectDir = ''
const realFetch = globalThis.fetch

beforeEach(() => {
  resetProjectOpsForTests()
  projectDir = isolatedProjectDir('koto-hanamii-shell-')
  h.hasCreds = true
  h.status = 200
  h.bodyOverride = null
  h.calls = []
  h.listThrows = false
  // 偽の HANAMII サーバ（実物の HanamiiClient をそのまま動かし、出た要求だけを記録する）。
  globalThis.fetch = (async (input: unknown, init: any) => {
    h.calls.push(`${init?.method ?? 'GET'} ${String(input)}`)
    const status = h.status
    return { ok: status >= 200 && status < 300, status, async text() { return h.bodyOverride ?? deleteProjectReplyText(status, PROJECT_ID) } }
  }) as unknown as typeof fetch
  // 保存場所（同意済み 1 件）と、このプロジェクトの記録（HANAMII の projectId）。
  const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: false })
  spec.persistence = { objectStorage: [{ bucket: BUCKET, prefix: PREFIX, shared: true, consentedAt: '2026-08-14T00:00:00.000Z' }] } as any
  fs.mkdirSync(path.join(projectDir, '.sakura-cloud'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), JSON.stringify(spec, null, 2), 'utf-8')
  fs.writeFileSync(path.join(projectDir, '.sakuraide.json'), JSON.stringify({
    publish: { hanamii: { projectId: PROJECT_ID }, targets: { hanamii: { publishedAt: '2026-09-29T00:00:00.000Z', url: null } } },
  }, null, 2), 'utf-8')
})
afterEach(() => {
  globalThis.fetch = realFetch
  fs.rmSync(projectDir, { recursive: true, force: true })
})

const OK_OPTS = { confirmed: true, projectId: PROJECT_ID }
const call = (over: { projectDir?: unknown; auth?: unknown; opts?: unknown } = {}) =>
  teardown(EVENT, 'projectDir' in over ? over.projectDir : projectDir, 'auth' in over ? over.auth : { token: TOKEN }, 'opts' in over ? over.opts : OK_OPTS)
const diskState = () => ({
  meta: fs.readFileSync(path.join(projectDir, '.sakuraide.json'), 'utf-8'),
  env: fs.readFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), 'utf-8'),
})

describe('★★★ 歯止め: 確認の印・projectDir・認証が揃わない呼び出しは、HANAMII へも保存場所へも要求を1件も出さない', () => {
  it('★★★ 確認の印が true でない → 要求0件。処理の記録も作らない（不明値を肯定に戻さない）', async () => {
    const before = diskState()
    const unconfirmed: unknown[] = [
      undefined, null, {}, { projectId: PROJECT_ID },
      { confirmed: false, projectId: PROJECT_ID }, { confirmed: 'true', projectId: PROJECT_ID }, { confirmed: 1, projectId: PROJECT_ID },
      { confirmed: {}, projectId: PROJECT_ID }, { confirmed: undefined, projectId: PROJECT_ID }, 'confirmed', true,
    ]
    for (const opts of unconfirmed) {
      const r = await call({ opts })
      expect(r.ok, JSON.stringify(opts)).toBe(false)
      expect(r.message, JSON.stringify(opts)).toBe(NOT_CONFIRMED_MESSAGE)
    }
    expect(h.calls, '確認の印が無いのに外部へ要求が出た').toEqual([])
    expect(getOps(projectDir).last, '断った回に処理の記録が残っている').toBeNull()
    expect(diskState()).toEqual(before)
  })

  it('★★★ projectDir が無い（空・文字列でない）→ 要求0件。以前は projectDir 無しだと鍵も掛けずに HANAMII のプロジェクトだけを消して ok:true を返した', async () => {
    for (const dir of [undefined, null, '', 0, {}, ['x']]) {
      const r = await call({ projectDir: dir })
      expect(r.ok, String(dir)).toBe(false)
      expect(r.message, String(dir)).toBe(BAD_PROJECT_DIR_MESSAGE)
      expect(r.appDeleted, String(dir)).toBeUndefined()
    }
    expect(h.calls).toEqual([])
  })

  it('★★ 認証の形が違う（トークンが空・無い・文字列でない）→ 要求0件', async () => {
    for (const auth of [undefined, null, '', 'hnm_test', 42, [], {}, { token: '' }, { token: null }, { token: 7 }, { secret: TOKEN }]) {
      const r = await call({ auth })
      expect(r.ok, JSON.stringify(auth)).toBe(false)
      expect(r.message, JSON.stringify(auth)).toBe('HANAMII のトークンが未登録です')
    }
    expect(h.calls).toEqual([])
  })

  it('★★★ 同じプロジェクトで別の操作（公開）が走っている → 要求0件で断り、終わればそのあと通る（鍵が外れている）', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(open => { release = open })
    const held = withProjectLock(projectDir, '公開', () => gate, { target: 'hanamii', handler: 'hanamii:publish' })
    try {
      const r = await call()
      expect(r.ok).toBe(false)
      expect(r.message).toBe(projectBusyMessage('公開', 'hanamii'))
      expect(h.calls, '別の操作が走っているのに外部へ要求が出た').toEqual([])
    } finally {
      release()
      await held
    }
    const after = await call()
    expect(after.ok).toBe(true)
    expect(h.calls[0]).toBe(DELETE_CALL)
  })

  it('★★ 渡された projectId が空・記録と違う → HANAMII へ要求0件（鍵の中の照合は tests/hanamiiTeardownRecord.test.ts が詳しく）', async () => {
    for (const projectId of [undefined, '', 'hnm-proj-other', 7]) {
      const r = await call({ opts: { confirmed: true, projectId } })
      expect(r.ok, String(projectId)).toBe(false)
    }
    expect(h.calls).toEqual([])
  })
})

describe('★★★ 順序と中止: プロジェクト削除 → 一覧 → データ削除 → バケット削除 → 鍵の無効化', () => {
  it('★★★ 全部を1本の並びで固定する（先に鍵を消すと、まだ動いているアプリが 403 で落ち、中身も消せない）', async () => {
    const r = await call()
    expect(r.ok).toBe(true)
    expect(h.calls.filter(c => c !== 'storage connect')).toEqual([
      DELETE_CALL,
      `list ${BUCKET}`,
      `deleteKeys ${BUCKET}`,
      `deleteBucket ${BUCKET}`,
      'listPermissions',
      'deletePermission perm-hanamii',
    ])
  })

  it('★★★ 一覧できなければ、データも、バケットも、鍵も1件も消さない（プロジェクトの削除は済んでいるので appDeleted は true）', async () => {
    h.listThrows = true
    const r = await call()
    expect(r.ok).toBe(false)
    expect(r.appDeleted).toBe(true)
    expect(r.remainingBuckets).toEqual([BUCKET])
    expect(h.calls.filter(c => c !== 'storage connect')).toEqual([DELETE_CALL, `list ${BUCKET}`])
  })

  it('★★ HANAMII の削除が失敗（403・429・500）したら、保存場所へ1件も要求を出さない（まだ動いているかもしれない）', async () => {
    for (const status of [403, 429, 500]) {
      h.status = status
      h.calls = []
      const r = await call()
      expect(r.ok, String(status)).toBe(false)
      expect(r.message, String(status)).toBe(`削除に失敗しました（HTTP ${status}）`)
      expect(r.deletionAccepted, String(status)).toBeUndefined()
      expect(h.calls, String(status)).toEqual([DELETE_CALL])
    }
  })

  it('★★★ HANAMII への通信が例外で終わった（切断・AbortSignal の時間切れ）→ 保存場所へ1件も要求を出さず、記録も env.json も変えず、残りの印も書かない', async () => {
    // 時間切れは「HANAMII 側で削除が進んだか分からない」回。ここで鍵とデータを消すと、まだ動いているアプリが 403 で落ちる。
    // 例外の枝は HTTP の失敗（上のテスト）とは別の枝なので、別に固定する。
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    for (const error of [new Error('fetch failed'), timeout]) {
      globalThis.fetch = (async (input: unknown, init: any) => {
        h.calls.push(`${init?.method ?? 'GET'} ${String(input)}`)
        throw error
      }) as unknown as typeof fetch
      h.calls = []
      const before = diskState()
      const r = await call()
      expect(r.ok, error.message).toBe(false)
      expect(r.message, error.message).toBe(`削除に失敗しました: ${error.message}`)
      expect(r.appDeleted, '消えたかどうか分からないのに、消えたと言っている').toBeUndefined()
      expect(r.deletionAccepted, error.message).toBeUndefined()
      expect(r, '保存場所の残りを言っている（保存場所へ進んでいない）').not.toHaveProperty('remainingBuckets')
      expect(h.calls, `${error.message}: 例外のあとに保存場所へ進んだ`).toEqual([DELETE_CALL])
      expect(diskState(), `${error.message}: 記録（行・projectId・印）か env.json を書き換えた`).toEqual(before)
      expect(JSON.parse(diskState().meta).publish.hanamii.storageLeftoverBuckets, '消えていないのに「保存場所だけ残った」印を書いた').toBeUndefined()
    }
  })
})

// ── 進み具合の動詞（0.6.22 の決定 D3: HANAMII は確認・進み具合・結果まで「破棄」）──────────────────────────────
// 進み具合の文だけ「🗑 HANAMII のプロジェクトを削除しています…」と言っていた（0.6.22-rc.3 の実機のあとの確かめで見つかった）。
describe('W3 進み具合の動詞: HANAMII の破棄の進み具合は「破棄しています」と言い、プロジェクトを「削除しています」と言わない', () => {
  it('★★ 実物の流れ: プロジェクトの段は「🗑 HANAMII のプロジェクトを破棄しています…」。保存場所のデータを直接消す段だけは、そのものを名指しする文のまま', async () => {
    const labels: string[] = []
    setProjectOpsListener((_dir, snap) => {
      const label = (snap.running ?? snap.last)?.progress?.label
      if (typeof label === 'string' && labels[labels.length - 1] !== label) labels.push(label)
    })
    const r = await call()
    expect(r.ok).toBe(true)
    expect(labels).toContain('🗑 HANAMII のプロジェクトを破棄しています…')
    expect(labels).not.toContain('🗑 HANAMII のプロジェクトを削除しています…')
    expect(labels.filter(l => l.includes('削除しています')), JSON.stringify(labels)).toEqual([STORAGE_TEARDOWN_PROGRESS])
    // 記録が最初に置く1行も「破棄」
    expect(labels[0]).toContain('破棄')
  })
})

describe('★★★ D7: DELETE の応答の読み方。`deleted === true` と 404 だけが「消えた」で、受け付けただけ（202 など）は保存場所にも記録にも触れない', () => {
  const ACCEPTED = { ok: false, appDeleted: false, deletionAccepted: true, message: HANAMII_DELETION_ACCEPTED_WARNING }

  it('★★★ 202（deleted=false・deletion=accepted）→ 保存場所への要求0件・記録も env.json もそのまま。結果は deletionAccepted（inProgress ではない）', async () => {
    h.status = 202
    const before = diskState()
    const r = await call()
    expect(r).toEqual(ACCEPTED)
    expect(r).not.toHaveProperty('inProgress')
    expect(h.calls, '受け付けただけなのに保存場所へ進んだ').toEqual([DELETE_CALL])
    expect(diskState(), '受け付けただけなのに記録（行・projectId）を書き換えた').toEqual(before)
  })

  it('★★★ 2xx でも deleted が true でない（false・無い・文字列の "true"・本文が空・JSON でない）→ 同じく「受け付けただけ」', async () => {
    const bodies: [number, string | null][] = [
      [200, JSON.stringify({ project: { id: PROJECT_ID, deleted: false, deletion: 'accepted' } })],
      [200, JSON.stringify({ project: { id: PROJECT_ID } })],
      [200, JSON.stringify({ project: { id: PROJECT_ID, deleted: 'true' } })],
      [200, JSON.stringify({ deleted: true })],
      [200, ''],
      [200, 'OK'],
      [204, ''],
    ]
    for (const [status, body] of bodies) {
      h.status = status
      h.bodyOverride = body
      h.calls = []
      const r = await call()
      expect(r, `${status} ${body}`).toEqual(ACCEPTED)
      expect(h.calls, `${status} ${body}`).toEqual([DELETE_CALL])
    }
    expect(diskState().meta).toContain(PROJECT_ID)
  })

  it('★★★ 200（deleted=true・deletion=completed。原本の応答例）→ 保存場所へ進み、全部片づけば ok', async () => {
    h.status = 200
    const r = await call()
    expect(r.ok).toBe(true)
    expect(r.appDeleted).toBe(true)
    expect(r.deletionAccepted).toBeUndefined()
    expect(h.calls).toContain(`deleteBucket ${BUCKET}`)
  })

  it('★★★ 404（存在しない、または参照できない）→ 「もう無い」として保存場所へ進む（押し直しが効く）', async () => {
    h.status = 404
    const r = await call()
    expect(r.ok).toBe(true)
    expect(r.appDeleted).toBe(true)
    expect(h.calls).toContain(`deleteBucket ${BUCKET}`)
  })

  it('★★ 受け付けたあとの押し直し: 削除が済んでいれば（404）先へ進み、まだなら（202）また何にも触れない', async () => {
    h.status = 202
    expect((await call()).deletionAccepted).toBe(true)
    h.status = 202
    expect((await call()).deletionAccepted).toBe(true)
    expect(h.calls.filter(c => c !== DELETE_CALL), '受け付けただけの回に保存場所へ触れた').toEqual([])
    h.status = 404
    expect((await call()).ok).toBe(true)
  })

  it('★★ readHanamiiDeleteReply は純関数として同じ表を返す', () => {
    const r = (status: number, data: unknown) => readHanamiiDeleteReply({ ok: status >= 200 && status < 300, status, data })
    expect(r(200, { project: { id: 'prj_123', deleted: true, deletion: 'completed' } })).toBe('deleted')
    expect(r(202, { project: { id: 'prj_123', deleted: false, deletion: 'accepted' } })).toBe('accepted')
    expect(r(200, null)).toBe('accepted')
    expect(r(200, { project: null })).toBe('accepted')
    expect(r(404, null)).toBe('not-found')
    expect(r(404, { project: { deleted: true } }), '404 は本文を見ない').toBe('not-found')
    for (const status of [400, 401, 403, 409, 429, 500, 503]) expect(r(status, { project: { deleted: true } }), String(status)).toBe('failed')
  })
})
