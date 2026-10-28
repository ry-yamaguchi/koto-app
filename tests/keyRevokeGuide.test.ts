import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 鍵（パーミッション）を無効にできなかった回の案内（設計書 10.9.8・10.9.13 の C。段階3A-2）──────────────────
// 共用型と HANAMII の破棄で、鍵の無効化に失敗した ⚠️ の行に「どこで何を削除すればよいか」を1回だけ添える。
//   ・純関数: keyRevokeGuide（storageKeys.ts）・keyWarningLines（storageTeardown.ts）
//   ・本物の main（偽の保存場所・偽の client。tests/sharedTeardownHarness.ts）で、その場の結果（executed）と、
//     開き直した画面が読む警告（summarizeResult・toTeardownView）の両方に同じ行が出ること
//   ・不変の約束: teardownStorageForProject の warnings は鍵の行だけ（足す人がここで気づく）。生の warnings・定数の文は変えない
// 専有型（ipc/apprunDedicatedTeardown.ts）は 3B-2 から同じ案内を出す（本物の main での振る舞いは tests/dedicatedTeardownStorageAll.test.ts の C-5）。
// 文は書き下す（関数を通すと同語反復になる）。
import { A, h, resetHarness, newProjectDir, setup, APP, bucketRef, OK_AUTH, stateMeta } from './sharedTeardownHarness'
import { shownTeardown, shownFromEnv } from './shownFromEnv'
import { deleteProjectReply } from './hanamiiTeardownFixtures'

/** 保存場所へ最初の deleteKeys が入った直後に呼ぶ関数（env.json が読めなくなる回を作る）。 */
const hook = vi.hoisted(() => ({ afterDeleteKeys: null as null | (() => void) }))

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => {
  const base = (await import('./sharedTeardownHarness')).storageAdapterMock(await orig())
  return {
    ...base,
    createStorageAdapter: async (...args: unknown[]) => {
      const adapter = await (base.createStorageAdapter as (...a: unknown[]) => Promise<any>)(...args)
      const deleteKeys = adapter.deleteKeys.bind(adapter)
      adapter.deleteKeys = async (bucket: string, keys: string[]) => { await deleteKeys(bucket, keys); hook.afterDeleteKeys?.() }
      return adapter
    },
  }
})
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))

import { keyRevokeGuide, permissionNameFor } from '../src/shared/storageKeys'
import { KEY_REVOKE_FAILED_WARNING, keyWarningLines } from '../src/main/cloud/storageTeardown'
import { storageProjectNameOf, teardownStorageForProject } from '../src/main/cloud/storageForTarget'
import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { registerHanamiiHandlers } from '../src/main/ipc/hanamii'
import { summarizeResult, resetProjectOpsForTests } from '../src/main/projectOps'
import { toTeardownView } from '../src/shared/teardownResult'

registerCloudHandlers({} as any)
registerHanamiiHandlers({} as any)
// 画面の代わりに、確認で見せた保存場所（記録から作る）を足して渡す（0.6.24 F。main は見せたものだけを消す）
const sharedTeardown = shownTeardown(h.handlers.get('cloud:teardown')!)
const hanamiiTeardown = shownTeardown(h.handlers.get('hanamii:teardown')!) // 画面の代わりに、確認で見せた保存場所（env.json の記録）を渡す
const EVENT = {}
const GO = { confirmed: true, deleteRegistry: false, registryName: null }
const PROJECT_ID = 'hnm-proj-1'

// 案内の文（書き下す）。共用型は koto-myapp、HANAMII は koto-myapp-hanamii（permissionNameFor）。
const guideFor = (name: string) => `さくらのクラウドのコントロールパネルで、オブジェクトストレージのパーミッション「${name}」を削除してください（アクセスキーも一緒に無効になります）。`
const SHARED_GUIDE = guideFor('koto-myapp')
const HANAMII_GUIDE = guideFor('koto-myapp-hanamii')
const NO_NAME_GUIDE = 'さくらのクラウドのコントロールパネル（オブジェクトストレージのパーミッション）で確かめてください。'
const KEY_LINE = `⚠️ ${KEY_REVOKE_FAILED_WARNING}`
const count = (lines: readonly string[], needle: string) => lines.join('\n').split(needle).length - 1

let dir = ''
const realFetch = globalThis.fetch
beforeEach(() => {
  resetProjectOpsForTests(); resetHarness(); hook.afterDeleteKeys = null; dir = newProjectDir()
  // 偽の HANAMII API（実物の HanamiiClient をそのまま動かす）。DELETE は 200（削除済み）。
  globalThis.fetch = (async () => deleteProjectReply(200, PROJECT_ID)) as unknown as typeof fetch
})
afterEach(() => { globalThis.fetch = realFetch; fs.rmSync(dir, { recursive: true, force: true }) })

function recordHanamiiProjectId() {
  fs.writeFileSync(path.join(dir, '.sakuraide.json'), JSON.stringify({ publish: { hanamii: { projectId: PROJECT_ID } } }, null, 2), 'utf-8')
}
const runHanamii = () => { recordHanamiiProjectId(); return hanamiiTeardown(EVENT, dir, { token: 'hnm_test' }, { confirmed: true, projectId: PROJECT_ID }) }

describe('keyRevokeGuide: 名前つき・画面の名前「パーミッション」。名前が無いときは言い切らない', () => {
  it('共用型は koto-<名前>、HANAMII は koto-<名前>-hanamii を名指しする', () => {
    expect(keyRevokeGuide('myapp', 'apprun')).toBe(SHARED_GUIDE)
    expect(keyRevokeGuide('myapp', 'hanamii')).toBe(HANAMII_GUIDE)
    expect(SHARED_GUIDE).toContain('「koto-myapp」')
    expect(HANAMII_GUIDE).toContain('「koto-myapp-hanamii」')
  })

  it('名前は permissionNameFor と同じ（公開先ごとに別の名前。専有型・Vercel も同じ規則）', () => {
    for (const target of ['apprun', 'apprun-dedicated', 'hanamii', 'vercel'] as const) {
      expect(keyRevokeGuide('myapp', target)).toContain(`「${permissionNameFor('myapp', target)}」`)
    }
    expect(keyRevokeGuide('myapp', 'vercel')).toContain('「koto-myapp_vercel」')
  })

  it('名前が null・空 → 確かめてもらう文。名前の分からない「削除してください」は言わない', () => {
    for (const name of [null, '']) {
      expect(keyRevokeGuide(name, 'apprun')).toBe(NO_NAME_GUIDE)
      expect(keyRevokeGuide(name, 'hanamii')).toBe(NO_NAME_GUIDE)
    }
    expect(NO_NAME_GUIDE).not.toContain('削除してください')
    expect(NO_NAME_GUIDE).not.toContain('「koto-')
  })
})

describe('keyWarningLines: 各行は ⚠️ で始まり、案内は最後の1行にだけ付く（全体で1回）', () => {
  const GUIDE = 'ここで削除してください。'

  it('空 → 空', () => {
    expect(keyWarningLines([], GUIDE)).toEqual([])
  })

  it('1行 → 案内つきの1行（行末が「。」でなければ「。」を足してから案内）', () => {
    expect(keyWarningLines(['保存場所のアクセスキーを無効にできませんでした'], GUIDE)).toEqual([`⚠️ 保存場所のアクセスキーを無効にできませんでした。${GUIDE}`])
  })

  it('行末がすでに「。」なら二重にしない', () => {
    expect(keyWarningLines(['無効にできませんでした。'], GUIDE)).toEqual([`⚠️ 無効にできませんでした。${GUIDE}`])
  })

  it('2行 → 案内は最後の1行だけ。全体で1回', () => {
    const lines = keyWarningLines(['一つ目', '二つ目'], GUIDE)
    expect(lines).toEqual(['⚠️ 一つ目', `⚠️ 二つ目。${GUIDE}`])
    expect(count(lines, GUIDE)).toBe(1)
    expect(lines.every(l => l.startsWith('⚠️ '))).toBe(true)
  })

  it('3行でも、案内は最後の1行だけ', () => {
    const lines = keyWarningLines(['a', 'b', 'c'], GUIDE)
    expect(lines.slice(0, 2).some(l => l.includes(GUIDE))).toBe(false)
    expect(lines[2]).toBe(`⚠️ c。${GUIDE}`)
  })
})

describe('共用型の破棄（本物の main）: 鍵の無効化の失敗の行に案内が1回だけ付き、その場にも開き直しの警告にも出る', () => {
  const LINE = `${KEY_LINE}。${SHARED_GUIDE}`

  it('記録の鍵の無効化が投げる → executed・summarizeResult・toTeardownView の警告に同じ1行。案内は1回。meta に ID が残る', async () => {
    setup(dir, { env: [A], resources: [APP, bucketRef(A)], meta: { storagePermissionId: 'perm-1' } })
    h.fail['deletePermission perm-1'] = 'throw'
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect(reply.executed).toContain(LINE)
    expect(summarizeResult(reply).warnings).toContain(LINE)
    expect(toTeardownView('sakura-apprun', reply).warnings).toContain(LINE)
    expect(count(reply.executed, SHARED_GUIDE)).toBe(1)
    expect(stateMeta(dir)).toMatchObject({ storagePermissionId: 'perm-1' })   // 案内を足しても、記録の鍵を残す判断は変わらない
  })

  it('保存場所が0件で、記録の鍵だけの無効化が失敗する → 理由の後ろに案内が1回。その場にも開き直しにも出る', async () => {
    setup(dir, { env: [], resources: [APP], meta: { storagePermissionId: 'perm-1' } })
    h.fail['deletePermission perm-1'] = 'throw'
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    const line = reply.executed.find((l: string) => l.startsWith(KEY_LINE))
    expect(line).toBe(`${KEY_LINE}: テスト用の失敗（deletePermission perm-1）。${SHARED_GUIDE}`)
    expect(count(reply.executed, SHARED_GUIDE)).toBe(1)
    expect(summarizeResult(reply).warnings).toContain(line)
    expect(toTeardownView('sakura-apprun', reply).warnings).toContain(line)
  })

  it('保存場所0件・接続できずに失敗する回も、案内が1回', async () => {
    setup(dir, { env: [], resources: [APP], meta: { storagePermissionId: 'perm-1' } })
    h.fail.connect = 'throw'
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)
    expect(count(reply.executed, SHARED_GUIDE)).toBe(1)
    expect(reply.executed.some((l: string) => l.startsWith(KEY_LINE))).toBe(true)
  })

  it('警告が2行（記録の鍵の失敗 + 一括の無効化の失敗）→ 案内は最後の1行だけ', async () => {
    setup(dir, { env: [A], resources: [APP, bucketRef(A)], meta: { storagePermissionId: 'perm-1' } })
    h.permissions = [{ id: 'perm-x', displayName: 'koto-myapp' }]
    h.fail['deletePermission perm-1'] = 'throw'
    h.fail['deletePermission perm-x'] = 'throw'
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)
    const warned = reply.executed.filter((l: string) => l.startsWith('⚠️'))
    expect(warned).toEqual([KEY_LINE, `⚠️ 保存場所のアクセスキーを1件、無効にできませんでした。${SHARED_GUIDE}`])
    expect(count(reply.executed, SHARED_GUIDE)).toBe(1)
    expect(summarizeResult(reply).warnings).toEqual(expect.arrayContaining(warned))
  })

  it('鍵を無効にできた回・鍵が無い回 → 案内は出ない', async () => {
    setup(dir, { env: [A], resources: [APP, bucketRef(A)], meta: { storagePermissionId: 'perm-1' } })
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)
    expect(h.calls).toContain('deletePermission perm-1')
    expect(count(reply.executed, 'パーミッション「')).toBe(0)
    expect(summarizeResult(reply).warnings.join('\n')).not.toContain('パーミッション「')
  })
})

describe('HANAMII の破棄（本物の main）: 一括の無効化の失敗の行に案内が1回だけ付き、その場にも開き直しの警告にも出る', () => {
  const LINE = `⚠️ 保存場所のアクセスキーを1件、無効にできませんでした。${HANAMII_GUIDE}`

  it('名前が一致する鍵の無効化が投げる → executed・summarizeResult・toTeardownView の警告に同じ1行。案内は1回', async () => {
    setup(dir, { env: [A], resources: [] })
    h.permissions = [{ id: 'perm-h', displayName: 'koto-myapp-hanamii' }]
    h.fail['deletePermission perm-h'] = 'throw'
    const reply = await runHanamii()
    expect(reply.ok).toBe(true)
    expect(reply.executed).toContain(LINE)
    expect(summarizeResult(reply).warnings).toContain(LINE)
    expect(toTeardownView('hanamii', reply).warnings).toContain(LINE)
    expect(count(reply.executed, HANAMII_GUIDE)).toBe(1)
    expect(count(reply.executed, SHARED_GUIDE)).toBe(0)   // 共用型の鍵の名前を言わない
  })

  it('鍵の一覧が取れない回も、案内が1回（最後の1行に）', async () => {
    setup(dir, { env: [A], resources: [] })
    h.fail.listPermissions = 'throw'
    const reply = await runHanamii()
    const warned = reply.executed.filter((l: string) => l.startsWith('⚠️'))
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('パーミッション（アクセスキー）の一覧を取得できなかったため')
    expect(warned[0].endsWith(HANAMII_GUIDE)).toBe(true)
    expect(count(reply.executed, HANAMII_GUIDE)).toBe(1)
  })

  it('★ 保存場所の削除が済んだあとに env.json が読めなくなっても、結果（executed・ok）を失わず、案内の名前も保つ（名前は何も消す前に読む）', async () => {
    setup(dir, { env: [A], resources: [] })
    h.permissions = [{ id: 'perm-h', displayName: 'koto-myapp-hanamii' }]
    h.fail['deletePermission perm-h'] = 'throw'
    hook.afterDeleteKeys = () => fs.writeFileSync(path.join(dir, '.sakura-cloud', 'env.json'), '{ 壊れた JSON', 'utf-8')
    const reply = await runHanamii()
    expect(h.calls).toContain(`deleteKeys ${A}`)
    expect(reply).toMatchObject({ ok: true, appDeleted: true })
    expect(reply.executed).toContain(LINE)                 // 読み直していれば、名前を失って「確かめてください」の文になる
    expect(count(reply.executed, NO_NAME_GUIDE)).toBe(0)
  })
})

describe('不変の約束: teardownStorageForProject の warnings は鍵の行だけ。生の warnings と定数の文は変えない', () => {
  const creds = () => h.creds as { token: string; secret: string }

  it('KEY_REVOKE_FAILED_WARNING の文は変えない（共用型が includes で「記録の鍵を外すか」を決める・専有型も同じ文）', () => {
    expect(KEY_REVOKE_FAILED_WARNING).toBe('保存場所のアクセスキーを無効にできませんでした')
  })

  it('warnings の全行が「アクセスキー」を含む。案内は生の warnings に入っていない（鍵ではない警告を足すと、鍵の案内が付くので、足す人はここで気づく）', async () => {
    const lines: string[] = []
    // (1) 記録の鍵の無効化が失敗
    setup(dir, { env: [A], resources: [], meta: { storagePermissionId: 'perm-1' } })
    h.fail['deletePermission perm-1'] = 'throw'
    const one = await teardownStorageForProject({ creds: creds(), projectDir: dir, permissionId: 'perm-1', shown: shownFromEnv(dir) })
    expect(one).toMatchObject({ ok: true, reason: 'done' })
    expect((one as { warnings: string[] }).warnings).toEqual([KEY_REVOKE_FAILED_WARNING])
    lines.push(...(one as { warnings: string[] }).warnings)
    // (2) 一括の無効化が失敗
    resetHarness(); setup(dir, { env: [A], resources: [] })
    h.permissions = [{ id: 'perm-x', displayName: 'koto-myapp' }]
    h.fail['deletePermission perm-x'] = 'throw'
    const two = await teardownStorageForProject({ creds: creds(), projectDir: dir, permissionId: null, sweepKeysFor: 'apprun', shown: shownFromEnv(dir) })
    lines.push(...(two as { warnings: string[] }).warnings)
    // (3) 鍵の一覧が取れない
    resetHarness(); setup(dir, { env: [A], resources: [] })
    h.fail.listPermissions = 'throw'
    const three = await teardownStorageForProject({ creds: creds(), projectDir: dir, permissionId: null, sweepKeysFor: 'hanamii', shown: shownFromEnv(dir) })
    lines.push(...(three as { warnings: string[] }).warnings)
    expect(lines).toHaveLength(3)
    expect(lines.every(l => l.includes('アクセスキー'))).toBe(true)
    expect(lines.some(l => l.includes('パーミッション「'))).toBe(false)   // 案内は表示の行を作る所で足す
  })
})

describe('storageProjectNameOf: プロジェクトの名前（env.json）。読めなければ null で、投げない', () => {
  const envFile = () => path.join(dir, '.sakura-cloud', 'env.json')

  it('読める → 名前', () => {
    setup(dir, { env: [A], resources: [] })
    expect(storageProjectNameOf(dir)).toBe('myapp')
  })

  it('env.json が無い → null', () => {
    expect(storageProjectNameOf(dir)).toBeNull()
  })

  it('★ env.json が壊れた JSON → null（投げない）', () => {
    setup(dir, { env: [A], resources: [] })
    fs.writeFileSync(envFile(), '{ 壊れた JSON', 'utf-8')
    expect(() => storageProjectNameOf(dir)).not.toThrow()
    expect(storageProjectNameOf(dir)).toBeNull()
  })

  it('スペックの検証に通らない env.json → null', () => {
    setup(dir, { env: [A], resources: [] })
    fs.writeFileSync(envFile(), JSON.stringify({ name: 123 }), 'utf-8')
    expect(storageProjectNameOf(dir)).toBeNull()
  })

  it('読めないファイル（ディレクトリになっている）→ null（投げない）', () => {
    fs.mkdirSync(envFile(), { recursive: true })
    expect(() => storageProjectNameOf(dir)).not.toThrow()
    expect(storageProjectNameOf(dir)).toBeNull()
  })
})

// 鍵の案内を出す所は5つ（設計書 10.11.15）: cloudTeardownStorage.ts の2か所（記録の鍵・一括。保存場所の段は 0.6.24 R1-a で cloudTeardown.ts から切り出した）・hanamiiTeardown.ts・apprunDedicatedTeardown.ts・cloud/apply.ts。
// どこも keyWarningLines に案内を渡して行を作る（⚠️ の行を自分で作らない）。専有型は 3B-2 から。呼び形ごと数える（コメントは除く）。
describe('鍵の警告の行を作る所は keyWarningLines を通る（5か所）', () => {
  const src = (f: string) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf-8').replace(/^\s*\/\/.*$/gm, '')
  const times = (text: string, needle: string) => text.split(needle).length - 1
  it.each([
    ['main/ipc/cloudTeardownStorage.ts', 'keyWarningLines(st.warnings, keyGuide)', 1],
    ['main/ipc/cloudTeardownStorage.ts', 'keyWarningLines([why], keyGuide)', 1],
    // 切り出したあとの元のファイルには、鍵の行を作る所が残っていない（コピーが戻れば数が合わなくなる）
    ['main/ipc/cloudTeardown.ts', 'keyWarningLines(', 0],
    ['main/ipc/hanamiiTeardown.ts', 'keyWarningLines(st.warnings, keyGuide)', 1],
    ['main/ipc/apprunDedicatedTeardown.ts', 'keyWarningLines(st.warnings, keyGuide)', 1],
    ['main/cloud/apply.ts', "keyWarningLines(outcome.warnings, keyRevokeGuide(spec.name || null, 'apprun'))", 1],
  ] as const)('%s は %s を呼ぶ（%i か所）', (file, call, n) => {
    expect(times(src(file), call)).toBe(n)
  })
  it("専有型は、名前を何も消す前に読んだ案内 keyRevokeGuide(storageProjectNameOf(projectDir), 'apprun-dedicated') を渡す。直す前の素の ⚠️ の行（st.warnings.map）は無い", () => {
    const text = src('main/ipc/apprunDedicatedTeardown.ts')
    expect(text).toContain("const keyGuide = keyRevokeGuide(storageProjectNameOf(projectDir), 'apprun-dedicated')")
    expect(text).not.toContain('st.warnings.map(')
  })
})
