import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 段階1（1d）E の H3: プロジェクト削除（Sidebar）の「公開も一緒に破棄する」を、本物の流れ・本物の main・偽の HANAMII/偽の保存場所に通す ─────
// 設計書: docs/teardown-unify-plan.md の 10.4.4 の H3・10.4.9 の E（H3）。作者の決定 D4=1: 公開先ごとに共通の ConfirmModal を出してから実行する。
// teardown/projectDelete.ts の teardownPublished（Sidebar から切り出した関数）を、偽の confirm と偽の window.electronAPI で呼ぶ。
//   ・戻り値は公開先ごとの結果（ProjectDeleteStep）。失敗の説明は failureLinesOf で取り出す（空のときだけ、移してよい。判断は projectDeletePlan.ts の
//     projectDeleteVerdict と tests/projectDeleteRun.test.ts。呼び出し側の守りは tests/hanamiiTeardownEntries.test.ts の F-5）
//   ・確認の答えが true でなければ、HANAMII へも保存場所へも要求は0件（偽の HANAMII サーバに出た要求の一覧で見る。ソースの文字列は読まない・掟10）
//   ・画面は公開の記録を一度も消さない（publishMeta の口が0回）。消すのは main の1か所
// 偽の応答は原本から写す（tests/hanamiiTeardownFixtures.ts）。
// 共用型（さくらのAppRun）の枝は段階2の2d で同じ流れに載った。その振る舞い（本物の main に通す）は tests/sharedProjectDelete.test.ts。
// ここに残る共用型の話は、HANAMII をやめたら共用型へ進まないこと（取り消したあとも破壊が続かない）だけ。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  hasCreds: true,
  /** 偽の HANAMII の DELETE が返す HTTP ステータス。 */
  status: 200,
  /** HANAMII へ出た要求と、保存場所へ出た要求を、1本の並びで積む。 */
  calls: [] as string[],
  auths: [] as string[],
  listThrows: false,
  /** 保存場所が返すキーの一覧。null なら、このプロジェクトの prefix の中の1件だけ（全部消せる）。 */
  keys: null as string[] | null,
  /** 鍵の無効化（deletePermission）を失敗させる。 */
  permissionThrows: false,
  /** 中央ストアの登録（id → トークン）と、使用中のトークン。 */
  byId: new Map<string, string>(),
  active: null as string | null,
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
          return h.keys ?? ['projects/myapp/a.txt']
        },
        async deleteKeys(bucket: string) { h.calls.push(`deleteKeys ${bucket}`) },
        async deleteBucket(bucket: string) { h.calls.push(`deleteBucket ${bucket}`) },
        async deletePermission(id: string) {
          h.calls.push(`deletePermission ${id}`)
          if (h.permissionThrows) throw new Error('無効にできませんでした（テスト）')
        },
        async issueKey() { return { accessKey: 'AKIA-X', secretKey: 'S3CRET-X', permissionId: 'perm-tmp' } },
        async listPermissions() { return [{ id: 'perm-hanamii', displayName: 'koto-myapp-hanamii' }] },
        async dispose() {},
      }
    },
  }
})

vi.mock('../src/renderer/components/CredentialsModal', () => ({
  getHanamiiToken: async () => h.active,
  getHanamiiTokenById: async (id: string) => h.byId.get(id) ?? null,
}))

import { registerHanamiiHandlers } from '../src/main/ipc/hanamii'
import { resetProjectOpsForTests } from '../src/main/projectOps'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'
import { teardownPublished } from '../src/renderer/teardown/projectDelete'
import { HANAMII_KEY_MISSING_MESSAGE, hanamiiTeardownSpec } from '../src/renderer/teardown/targets/hanamii'
import { PUBLISH_CLOSE_WARNING } from '../src/renderer/activity'
import { HANAMII_DELETION_ACCEPTED_WARNING } from '../src/shared/teardownResult'
import { teardownRemainingWarnings } from '../src/shared/cloudCost'
import { PUBLISH_TARGET_LABEL, type PublishTargetKind } from '../src/renderer/publishStatus'
import { failureLinesOf, type ProjectDeleteStep } from '../src/renderer/teardown/projectDeletePlan'
import type { ConfirmOptions } from '../src/renderer/useConfirm'
import { deleteProjectReply } from './hanamiiTeardownFixtures'
import { isolatedProjectDir } from './isolatedProject'

const PROJECT_ID = 'hnm-proj-1'
const BUCKET = 'koto-data-x'
const TOKEN_ID = 'tk-recorded'
const DELETE_CALL = `DELETE https://hanamii.jp/api/v1/projects/${PROJECT_ID}`
const HANAMII = PUBLISH_TARGET_LABEL.hanamii

let dir = ''
let win: { busy: unknown[][]; publishMetaCalls: unknown[][]; writes: string[]; cloudCalls: unknown[][]; cloudReply: { ok: boolean; message?: string }; ipc: unknown[][] }
let realFetch: typeof fetch
const mainTeardown = (() => { registerHanamiiHandlers({} as any); return h.handlers.get('hanamii:teardown')! })()

const metaFile = () => path.join(dir, '.sakuraide.json')
const readMeta = (): any => JSON.parse(fs.readFileSync(metaFile(), 'utf-8'))

function writeRecord(hanamii: Record<string, unknown> | null, targets: Record<string, unknown> = { hanamii: { publishedAt: '2026-09-29T00:00:00.000Z', url: 'https://myapp.example.test' }, vercel: { publishedAt: '2026-09-28T00:00:00.000Z', url: 'https://myapp.vercel.test' } }) {
  fs.writeFileSync(metaFile(), JSON.stringify({ name: 'myapp', publish: { ...(hanamii ? { hanamii: { workspaceId: 'ws-1', ...hanamii } } : {}), targets } }, null, 2), 'utf-8')
}

beforeEach(() => {
  resetProjectOpsForTests()
  dir = isolatedProjectDir('koto-hanamii-projdel-')
  h.hasCreds = true; h.status = 200; h.calls = []; h.auths = []; h.listThrows = false; h.keys = null; h.permissionThrows = false
  h.byId = new Map([[TOKEN_ID, 'tok-of-recorded']]); h.active = 'tok-active'
  realFetch = globalThis.fetch
  // 偽の HANAMII サーバ（実物の HanamiiClient をそのまま動かし、出た要求だけを記録する）。
  globalThis.fetch = (async (input: unknown, init: any) => {
    h.calls.push(`${init?.method ?? 'GET'} ${String(input)}`)
    h.auths.push(String(init?.headers?.Authorization ?? ''))
    return deleteProjectReply(h.status, PROJECT_ID)
  }) as unknown as typeof fetch
  writeRecord({ projectId: PROJECT_ID, name: 'myapp', tokenId: TOKEN_ID })
  const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: false })
  spec.persistence = { objectStorage: [{ bucket: BUCKET, prefix: 'projects/myapp/', shared: true, consentedAt: '2026-08-14T00:00:00.000Z' }] } as any
  fs.mkdirSync(path.join(dir, '.sakura-cloud'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.sakura-cloud', 'env.json'), JSON.stringify(spec, null, 2), 'utf-8')

  win = { busy: [], publishMetaCalls: [], writes: [], cloudCalls: [], cloudReply: { ok: true }, ipc: [] }
  ;(globalThis as any).window = {
    electronAPI: {
      fs: {
        readFile: async (p: string) => fs.readFileSync(p, 'utf-8'),
        // 確認の「ほかの公開先」が旧い共用型の記録（state.json）の有無を見る（D9=2）。実ファイルの有無をそのまま返す。
        exists: async (p: string) => fs.existsSync(p),
        writeFile: async (p: string) => { win.writes.push(p) }, // 画面が書いたら数える（書いてはいけない）
      },
      storage: {
        placement: async (d: string) => {
          try {
            const s = JSON.parse(fs.readFileSync(path.join(d, '.sakura-cloud', 'env.json'), 'utf-8'))
            const list = (s?.persistence?.objectStorage ?? []) as Array<{ bucket: string; prefix: string; shared: boolean }>
            return { ok: true, placements: list.map(p => ({ bucket: p.bucket, prefix: p.prefix, shared: p.shared })) }
          } catch { return { ok: true, placements: [] } }
        },
      },
      stageTiming: { estimates: async () => null },
      win: { setBusy: (...a: unknown[]) => { win.busy.push(a) } },
      // 本物の main のハンドラ（preload の素通しと同じ形）。
      hanamii: { teardown: (d: string, auth: unknown, opts: unknown) => { win.ipc.push([d, auth, opts]); return mainTeardown({}, d, auth, opts) } },
      // 共用型の口。やめたあとに共用型へ進んでいないことを見る（流れが進めば、まず記録を読みに来る）。
      cloud: {
        teardownRecord: async (...a: unknown[]) => { win.cloudCalls.push(['teardownRecord', ...a]); return { ok: true, record: { appNames: ['myapp'], registryName: null, registryOrigin: 'owned', registryUsers: [], placements: [], stateOnlyBuckets: [] } } },
        teardown: async (...a: unknown[]) => { win.cloudCalls.push(a); return win.cloudReply },
      },
      publishMeta: new Proxy({}, { get: (_t, key) => (...a: unknown[]) => { win.publishMetaCalls.push([String(key), ...a]); return Promise.resolve({ ok: true, meta: {} }) } }),
    },
    dispatchEvent: () => true,
  }
})

afterEach(() => {
  globalThis.fetch = realFetch
  fs.rmSync(dir, { recursive: true, force: true })
  delete (globalThis as any).window
})

/** 確認の答えを決めて、開いた確認の中身を残す偽の confirm。 */
function fakeConfirm(answer: unknown) {
  const opened: ConfirmOptions[] = []
  const confirm = async (opts: ConfirmOptions) => { opened.push(opts); return answer as boolean }
  return { confirm, opened }
}
const runSteps = (targets: PublishTargetKind[], confirm: (o: ConfirmOptions) => Promise<boolean>) => teardownPublished(dir, targets, {
  confirm,
  // 共用型の確認（選択つき）。このファイルでは共用型へ進まないことだけを見るので、呼ばれたら答えずに積む。
  confirmWithChoices: async () => ({ confirmed: false, choices: {} }),
})
/** 失敗の説明の配列（もとの teardownPublished の返り値）。 */
const run = async (targets: PublishTargetKind[], confirm: (o: ConfirmOptions) => Promise<boolean>) => failureLinesOf(await runSteps(targets, confirm))
/** 済んだ回（done）の知らせ。もとの onWarnings が渡していたもの（警告が1件以上の回だけ）。 */
const warningsOf = (steps: ProjectDeleteStep[]) => steps.flatMap(s => (s.kind === 'done' && s.view.warnings.length > 0 ? [{ target: s.target, warnings: s.view.warnings }] : []))

describe('H3 プロジェクト削除の HANAMII: 確認の答えが true のときだけ実行する', () => {
  it('★★★ やめた: 「HANAMII: 破棄をやめました」が失敗に積まれ、HANAMII へも保存場所へも要求0件。記録はそのまま', async () => {
    const c = fakeConfirm(false)
    const failed = await run(['hanamii'], c.confirm)
    expect(failed).toEqual([`${HANAMII}: 破棄をやめました`])
    expect(c.opened).toHaveLength(1)
    expect(win.ipc).toEqual([]) // hanamii:teardown の IPC 自体を呼ばない
    expect(h.calls).toEqual([])
    expect(h.auths).toEqual([])
    expect(win.busy).toEqual([]) // 窓を閉じる警告も立てない（実行が始まっていない）
    expect(win.publishMetaCalls).toEqual([])
    expect(readMeta().publish.hanamii.projectId).toBe(PROJECT_ID)
    expect(readMeta().publish.targets.hanamii).toBeTruthy()
  })

  it.each([undefined, null, 'yes', 1, {}])('★★★ 確認の答えが true でない値（%j）は、やめたと同じ。要求0件（不明値を肯定に戻さない）', async (answer) => {
    const c = fakeConfirm(answer)
    const failed = await run(['hanamii'], c.confirm)
    expect(failed).toEqual([`${HANAMII}: 破棄をやめました`])
    expect(win.ipc).toEqual([])
    expect(h.calls).toEqual([])
  })

  it('★★★ 確認の文は共通の文の作り手が作る（他の入口と同じ）: 名前・保存場所・「元に戻せません」は言い、共用型の URL の文は言わない。danger', async () => {
    const c = fakeConfirm(false)
    await run(['hanamii'], c.confirm)
    const o = c.opened[0]
    expect(o.danger).toBe(true)
    expect(o.title).toBe('HANAMII の公開を破棄します')
    expect(o.confirmLabel).toBe('破棄する')
    expect(o.body).toContain(`対象のプロジェクト: 『${path.basename(dir)}』`)
    expect(o.body).toContain("次を破棄します: HANAMII のプロジェクト『myapp』・保存場所『koto-data-x』にある、このプロジェクトのデータ")
    expect(o.body).toContain('保存場所にあるデータの削除は元に戻せません')
    expect(o.body).toContain('▲ Vercel でも使っているため、そちらで公開中のアプリのデータも消えます')
    expect(o.body).not.toContain('URL')
    expect(o.body).not.toContain('課金は止まります')
  })

  it('★★★ 破棄する（全部片づく回）: 失敗は0件（Sidebar がフォルダを移してよい）。要求は DELETE → 保存場所の順。公開したときのトークンで呼ぶ。画面は記録に触れず、消したのは main', async () => {
    const c = fakeConfirm(true)
    const failed = await run(['hanamii'], c.confirm)
    expect(failed).toEqual([])
    expect(h.calls).toEqual([DELETE_CALL, 'storage connect', `list ${BUCKET}`, `deleteKeys ${BUCKET}`, `deleteBucket ${BUCKET}`, 'deletePermission perm-hanamii'])
    expect(h.auths).toEqual(['Bearer tok-of-recorded']) // 公開したときのトークン（tokenId）。使用中のトークンではない
    expect(win.ipc).toEqual([[dir, { token: 'tok-of-recorded' }, { confirmed: true, projectId: PROJECT_ID }]]) // 呼びは1回。projectDir を渡す
    expect(win.publishMetaCalls).toEqual([]) // 画面は公開の記録を消さない
    expect(win.writes).toEqual([])
    const after = readMeta()
    expect(after.publish.hanamii?.projectId ?? null).toBeNull() // main が鍵の中で片づけた
    expect(after.publish.targets.hanamii).toBeUndefined()
    expect(after.publish.targets.vercel).toBeTruthy()
  })

  it('★★ 実行中だけ窓を閉じる警告が立つ（共通の流れの1か所）。終われば外れる', async () => {
    const c = fakeConfirm(true)
    await run(['hanamii'], c.confirm)
    expect(win.busy[0]).toEqual([true, 'HANAMII の破棄', true, 'HANAMII の破棄', PUBLISH_CLOSE_WARNING.detail, PUBLISH_CLOSE_WARNING.confirmLabel])
    expect(win.busy[win.busy.length - 1]).toEqual([false, '', false, '', '', ''])
  })
})

describe('H3 プロジェクト削除の HANAMII: 破棄できなかった回は失敗に積む（積まれた回は、フォルダを移さない）', () => {
  it('★★★ 受付済み（HANAMII の応答が 202）: 失敗に「受け付けました…」が積まれる。保存場所にも記録にも触れない', async () => {
    h.status = 202
    const failed = await run(['hanamii'], fakeConfirm(true).confirm)
    expect(failed).toEqual([`${HANAMII}: ${HANAMII_DELETION_ACCEPTED_WARNING}`])
    expect(h.calls).toEqual([DELETE_CALL])
    expect(readMeta().publish.hanamii.projectId).toBe(PROJECT_ID)
    expect(readMeta().publish.targets.hanamii).toBeTruthy()
  })

  it('★★★ 保存場所の一覧を取れなかった: プロジェクトは消えたが、失敗に積まれる。記録と projectId は残り（押し直せる）、残りの印が書かれる', async () => {
    h.listThrows = true
    const failed = await run(['hanamii'], fakeConfirm(true).confirm)
    expect(failed).toHaveLength(1)
    expect(failed[0]).toContain(`${HANAMII}: `)
    expect(failed[0]).toContain('一覧を取得できませんでした（テスト）')
    expect(h.calls).not.toContain(`deleteBucket ${BUCKET}`)
    const after = readMeta()
    expect(after.publish.hanamii.projectId).toBe(PROJECT_ID)
    expect(after.publish.targets.hanamii).toBeTruthy()
    expect(after.publish.hanamii.storageLeftoverBuckets).toEqual([BUCKET])
  })

  it('★★★ 公開に使ったトークンが認証情報に無い: 呼ばずに止める（使用中のトークンへ倒さない）。失敗に案内が積まれる', async () => {
    h.byId = new Map()
    const failed = await run(['hanamii'], fakeConfirm(true).confirm)
    expect(failed).toEqual([`${HANAMII}: ${HANAMII_KEY_MISSING_MESSAGE}`])
    expect(win.ipc).toEqual([])
    expect(h.calls).toEqual([])
    expect(h.auths).toEqual([])
  })

  it('★★★ 記録に projectId が無い（幽霊の行）: 確認を出さず、要求0件。失敗に積まれる', async () => {
    writeRecord({ name: 'myapp', tokenId: TOKEN_ID })
    const c = fakeConfirm(true)
    const failed = await run(['hanamii'], c.confirm)
    expect(failed).toHaveLength(1)
    expect(failed[0]).toContain('HANAMII のプロジェクトIDが記録に無いため')
    expect(c.opened).toEqual([])
    expect(h.calls).toEqual([])
  })

  it('★★★ 公開の記録を読めない（壊れている）: 確認を出さず、要求0件。失敗に「読めませんでした」が積まれる', async () => {
    fs.writeFileSync(metaFile(), '{ 壊れた', 'utf-8')
    const c = fakeConfirm(true)
    const failed = await run(['hanamii'], c.confirm)
    expect(failed).toHaveLength(1)
    expect(failed[0]).toContain('破棄するものの記録を読めませんでした')
    expect(c.opened).toEqual([])
    expect(h.calls).toEqual([])
  })

  it('★★ 呼び出しが例外を投げた: 失敗に積まれる（握りつぶさない）', async () => {
    ;(globalThis as any).window.electronAPI.hanamii.teardown = async () => { throw new Error('接続が切れました（テスト）') }
    const failed = await run(['hanamii'], fakeConfirm(true).confirm)
    expect(failed).toEqual([`${HANAMII}: 接続が切れました（テスト）`])
    expect(win.busy[win.busy.length - 1]).toEqual([false, '', false, '', '', '']) // 例外でも窓を閉じる警告は外れる
  })
})

describe('H3 公開先ごとに順に扱う（専有型の枝は、移しただけで変わらない）', () => {
  it('★★ 破棄の口が無い公開先（Vercel・レンタルサーバ）だけなら、何もしない（確認も出さない）', async () => {
    const c = fakeConfirm(true)
    expect(await run(['vercel', 'sakura-rental'], c.confirm)).toEqual([])
    expect(c.opened).toEqual([])
    expect(h.calls).toEqual([])
    expect(win.cloudCalls).toEqual([])
  })

  it('★★ 専有型は、この画面からは削除できない（必ず失敗に積む）。確認も出さず、要求0件', async () => {
    const c = fakeConfirm(true)
    const failed = await run(['sakura-apprun-dedicated'], c.confirm)
    expect(failed).toHaveLength(1)
    expect(failed[0]).toContain('専有型は、この画面からは削除できません。')
    expect(failed[0]).toContain('専有型タブの「手順6 作ったものを削除する」（または 📡 公開したもの一覧の「🗑 削除」）') // V1（3B-7）: 専有型の行のボタンの名前で案内する
    expect(c.opened).toEqual([])
    expect(h.calls).toEqual([])
    expect(win.cloudCalls).toEqual([])
  })

  it('★★★ 取り消したあとも破壊が続かない: HANAMII の確認で「やめる」と答えたら、共用型の破棄（同じ保存場所の同じ prefix のデータを消す）へ進まない。失敗は「やめた」の1件で、あとの公開先の名前を挙げる', async () => {
    // 並びは publishRecord.ts の TARGET_ORDER どおり（hanamii が sakura-apprun より前）。
    const c = fakeConfirm(false)
    const failed = await run(['hanamii', 'sakura-apprun', 'sakura-apprun-dedicated'], c.confirm)
    expect(failed).toEqual([`${HANAMII}: 破棄をやめました。${PUBLISH_TARGET_LABEL['sakura-apprun']}・${PUBLISH_TARGET_LABEL['sakura-apprun-dedicated']}の破棄も始めていません`])
    expect(win.cloudCalls, 'やめたのに、同じ保存場所のデータを消す共用型の破棄が走った').toEqual([])
    expect(h.calls).toEqual([])
    expect(win.ipc).toEqual([])
    expect(c.opened).toHaveLength(1) // 確認は HANAMII の1回だけ（あとの公開先の確認は出ない）
    expect(win.publishMetaCalls, '共用型の記録を消している').toEqual([])
  })

  it('★★ やめた HANAMII のあとに続く公開先が無い（破棄の口が無いものだけ）なら、「始めていません」は付けない', async () => {
    const failed = await run(['hanamii', 'vercel', 'sakura-rental'], fakeConfirm(false).confirm)
    expect(failed).toEqual([`${HANAMII}: 破棄をやめました`])
  })
})

describe('H3 プロジェクト削除の HANAMII: 済んだ回（ok:true）の知らせは、フォルダを移す前に呼び手へ渡す（捨てない）', () => {
  // フォルダをゴミ箱へ移すと、保存場所と鍵の唯一の記録（.sakura-cloud/env.json）も消え、処理の記録はメモリ上にしか無い。
  // その場で見せないと、月額が続く保存場所があることを、利用者は二度と知れない。知らせは 'done' の step の view.warnings にある。

  it('★★★ 利用者のファイルがあってバケットごとは消さなかった回: 失敗は空（移してよい）だが、月額が続く警告が1回渡る', async () => {
    h.keys = ['projects/myapp/a.txt', 'わたしの大事な資料.pdf']
    const steps = await runSteps(['hanamii'], fakeConfirm(true).confirm)
    expect(failureLinesOf(steps)).toEqual([])
    expect(h.calls, '前提: バケットは残した').not.toContain(`deleteBucket ${BUCKET}`)
    const got = warningsOf(steps)
    expect(got).toHaveLength(1)
    expect(got[0].target).toBe('hanamii')
    // 共用型と同じ関数の文（画面によって言い方が食い違わない）
    expect(got[0].warnings).toEqual(teardownRemainingWarnings({ keptBucketName: BUCKET, keptBucketNames: [BUCKET], keptBucketsWithOwnFiles: [BUCKET] }))
    expect(got[0].warnings.join(''), '利用者のファイルが入った保存場所に、言われたとおり消してよいとは言わない').not.toContain('後で消す場合は')
    expect(got[0].warnings.join('')).toContain(`『${BUCKET}』`)
  })

  it('★★★ 鍵を無効にできなかった ⚠️ の行（ok:true のまま）も渡る', async () => {
    h.permissionThrows = true
    const steps = await runSteps(['hanamii'], fakeConfirm(true).confirm)
    expect(failureLinesOf(steps)).toEqual([])
    const got = warningsOf(steps)
    expect(got).toHaveLength(1)
    expect(got[0].warnings.join('\n')).toContain('保存場所のアクセスキーを1件、無効にできませんでした')
  })

  it('★★ 全部きれいに片づいた回・やめた回・失敗した回は、渡さない（失敗は message が言う。二重に言わない）', async () => {
    const got: ReturnType<typeof warningsOf> = []
    const collect = (steps: ProjectDeleteStep[]) => { got.push(...warningsOf(steps)); return failureLinesOf(steps) }
    expect(collect(await runSteps(['hanamii'], fakeConfirm(true).confirm))).toEqual([])
    // 全部片づいた回は main が記録を消すので、次の回のために記録を書き直す
    writeRecord({ projectId: PROJECT_ID, name: 'myapp', tokenId: TOKEN_ID })
    expect(collect(await runSteps(['hanamii'], fakeConfirm(false).confirm))).toEqual([`${HANAMII}: 破棄をやめました`])
    h.status = 202
    expect(collect(await runSteps(['hanamii'], fakeConfirm(true).confirm))).toEqual([`${HANAMII}: ${HANAMII_DELETION_ACCEPTED_WARNING}`])
    expect(got).toEqual([])
  })

  it('★★★ step の形（返り値。移してよいかの判断 projectDeleteVerdict が読む）: やめた→cancelled・済んだ→done（words と view つき）・受付済み→failed（view つき）・専有型→failed（view・words なし）・破棄の口が無い公開先→step なし', async () => {
    expect(await runSteps(['hanamii'], fakeConfirm(false).confirm)).toEqual([{ target: 'hanamii', kind: 'cancelled', line: `${HANAMII}: 破棄をやめました` }])
    const done = await runSteps(['hanamii'], fakeConfirm(true).confirm)
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({ target: 'hanamii', kind: 'done', words: hanamiiTeardownSpec.words, view: { ok: true, state: 'done' } })
    writeRecord({ projectId: PROJECT_ID, name: 'myapp', tokenId: TOKEN_ID }) // 全部片づいた回は main が記録を消した
    h.status = 202
    const accepted = await runSteps(['hanamii'], fakeConfirm(true).confirm)
    expect(accepted).toHaveLength(1)
    expect(accepted[0]).toMatchObject({ target: 'hanamii', kind: 'failed', line: `${HANAMII}: ${HANAMII_DELETION_ACCEPTED_WARNING}`, words: hanamiiTeardownSpec.words, view: { ok: false, state: 'inProgress' } })
    expect(await runSteps(['sakura-apprun-dedicated'], fakeConfirm(true).confirm)).toEqual([{ target: 'sakura-apprun-dedicated', kind: 'failed', line: expect.stringContaining('専有型は、この画面からは削除できません。'), view: null, words: null }])
    expect(await runSteps(['vercel', 'sakura-rental'], fakeConfirm(true).confirm)).toEqual([])
  })
})
