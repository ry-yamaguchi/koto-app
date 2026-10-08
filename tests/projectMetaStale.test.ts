import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// ── なぜこのテストが要るか（2026-09-29・作者の問い「公開のダイアログを閉じると止まりますか」の調査で判明）──
//
// 公開そのものは main の1回の IPC で最後まで進み、記録も main が書く。ところが公開ダイアログ
// （PublishModal）の saveMeta は、**画面を開いたときに一度だけ読んだ写し**（state の meta）を材料に
//
//     { ...meta, ...patch, publish: { ...meta.publish, ...patch.publish } }
//
// で .sakuraide.json **全体を書き戻していた**（呼び出し: レンタル公開・「記録を片づける」）。
// 開いている間に main が書いた記録（専有型の資源ID publish.apprunDedicated・publish.targets・
// HANAMII の projectId）は写しに入っていないので、**書き戻すたびに消えた**。
// 専有型のクラスタの記録が消えると⑥で破棄できず、月額の課金が止められなくなる
// （CLAUDE.md 掟10「画面が持っている写しは、いつでも古い」と同じ形）。
//
// ここは**ソースの文字列を読まない**（掟10）。本物の一時フォルダの .sakuraide.json に実際に流し、
// 「main が書いた記録が残っているか」を**ファイルで**見る。renderer の入口（projectMeta.ts）は
// 本物の IPC ハンドラ（registerPublishMetaHandlers）へ繋いだ偽の window.electronAPI から呼ぶ。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
}))

import { registerPublishMetaHandlers } from '../src/main/ipc/publishMeta'
import {
  markPendingFs, writePublishRecordFs, writeHanamiiProjectIdFs, writeApprunDedicatedRecordFs,
  mergeMetaPatchFs, forgetPublishTargetFs,
} from '../src/main/publishMetaFs'
import { withProjectLock } from '../src/main/projectLock'
import { withMetaPatch, withoutPublishTarget } from '../src/shared/publishMeta'
import {
  mergeProjectMeta, forgetPublishTargetRecord, dismissInterruptedPublish, rentalPublishPatch,
} from '../src/renderer/projectMeta'
import { clearPublishRecord } from '../src/renderer/publishRecord'
import { saveRagSettings } from '../src/renderer/ragContext'

registerPublishMetaHandlers()
const call = (channel: string, ...args: any[]) => h.handlers.get(channel)!({}, ...args)

let projectDir = ''
let events: string[] = []
const metaPath = () => path.join(projectDir, '.sakuraide.json')
const readMeta = (): any => JSON.parse(fs.readFileSync(metaPath(), 'utf-8'))
const writeMeta = (m: unknown) => fs.writeFileSync(metaPath(), JSON.stringify(m, null, 2), 'utf-8')

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-metastale-'))
  events = []
  // 偽の preload。**本物の IPC ハンドラ**へ繋ぐ（main の検証・書き込みがそのまま動く）。
  ;(globalThis as any).window = {
    electronAPI: {
      publishMeta: {
        merge: (dir: string, patch: unknown) => call('publishMeta:merge', dir, patch),
        forgetTarget: (dir: string, target: string) => call('publishMeta:forgetTarget', dir, target),
        dismissInterrupted: (dir: string) => call('publishMeta:dismissInterrupted', dir),
        runningOp: (dir: string) => call('publishMeta:runningOp', dir),
      },
    },
    dispatchEvent: (e: { type: string }) => { events.push(e.type); return true },
  }
})
afterEach(() => {
  delete (globalThis as any).window
  fs.rmSync(projectDir, { recursive: true, force: true })
})

/** main が公開・破棄の最中に書く、お金に関わる記録（専有型のクラスタ・アプリ・保存場所の鍵）。 */
const MAIN_WRITTEN_IDS = {
  clusterID: 'cl-1', asgID: 'asg-1', loadBalancerID: 'lb-1',
  applicationID: 'app-1', applicationName: 'myapp', storagePermissionId: 'perm-1',
} as const

/**
 * 「ダイアログを開く → 開いている間に main が書く」を作る。
 * 戻り値は「開いたときの写し」（PublishModal が state に持っていたもの）。
 */
function openDialogThenMainWrites(): any {
  writeMeta({
    name: 'my-app',
    target: 'sakura-apprun-dedicated',
    publish: {
      apprunDedicated: { consentedAt: '2026-09-01T00:00:00.000Z', servicePrincipalId: 'sp-1' },
      targets: { vercel: { publishedAt: '2026-08-01T00:00:00.000Z', url: 'https://v.example.com' } },
    },
  })
  const openedCopy = readMeta() // ← 画面が開いたときに読んだ写し（以後、古くなる）
  // 開いている間に、main が書く（どれも main の同期書き込み。publishMetaFs.ts）
  writeApprunDedicatedRecordFs(projectDir, { ...MAIN_WRITTEN_IDS })
  writePublishRecordFs(projectDir, 'sakura-apprun-dedicated', { publishedAt: '2026-09-29T01:00:00.000Z', url: 'https://ded.example.com' })
  writeHanamiiProjectIdFs(projectDir, 'hp-1')
  return openedCopy
}

/** 直す前の PublishModal.saveMeta の式（古い写しで全体を書き戻す）。 */
const oldSaveMeta = (stale: any, patch: any) => ({ ...stale, ...patch, publish: { ...stale.publish, ...patch.publish } })

const ALL_MAIN_WRITTEN = () => {
  const m = readMeta()
  expect(m.publish.apprunDedicated).toMatchObject({ ...MAIN_WRITTEN_IDS, consentedAt: '2026-09-01T00:00:00.000Z', servicePrincipalId: 'sp-1' })
  expect(m.publish.targets['sakura-apprun-dedicated']).toEqual({ publishedAt: '2026-09-29T01:00:00.000Z', url: 'https://ded.example.com' })
  expect(m.publish.hanamii.projectId).toBe('hp-1')
  expect(m.publish.targets.vercel).toEqual({ publishedAt: '2026-08-01T00:00:00.000Z', url: 'https://v.example.com' })
}

describe('★★★ ダイアログを開いたあとに main が記録を書く → 画面の保存 → main の記録が残っている（実際のファイル）', () => {
  it('このテストは、直す前の式（古い写しで全体を書き戻す）が専有型の資源IDを消すことを再現できる', () => {
    const stale = openDialogThenMainWrites()
    const patch = rentalPublishPatch({ account: 'acct', host: 'acct.sakura.ne.jp', publishedAt: '2026-09-29T02:00:00.000Z' })
    const broken = oldSaveMeta(stale, patch)
    // 直す前の欠陥そのもの: main が書いた資源IDが、書き戻しで消える。
    expect(broken.publish.apprunDedicated.clusterID).toBeUndefined()
    expect(broken.publish.apprunDedicated.loadBalancerID).toBeUndefined()
    expect(broken.publish.apprunDedicated.applicationID).toBeUndefined()
    expect(broken.publish.hanamii).toBeUndefined()
    expect(broken.publish.targets['sakura-apprun-dedicated']).toBeUndefined()
  })

  it('★★★ レンタルサーバへの公開の記録（PublishModal の saveMeta）を書いても、専有型の資源ID・公開記録・projectId が残る', async () => {
    openDialogThenMainWrites()
    const next = await mergeProjectMeta(
      projectDir,
      rentalPublishPatch({ account: 'acct', host: 'acct.sakura.ne.jp', publishedAt: '2026-09-29T02:00:00.000Z' }),
    )
    // main が書いた記録は、すべてディスクに残っている
    ALL_MAIN_WRITTEN()
    // 画面が書きたかったものは書かれている
    const m = readMeta()
    expect(m.target).toBe('sakura-rental')
    expect(m.publish.account).toBe('acct')
    expect(m.publish.host).toBe('acct.sakura.ne.jp')
    expect(m.publish.url).toBe('https://acct.sakura.ne.jp/')
    expect(m.publish.lastPublishedAt).toBe('2026-09-29T02:00:00.000Z')
    expect(m.publish.targets['sakura-rental']).toEqual({ publishedAt: '2026-09-29T02:00:00.000Z', url: 'https://acct.sakura.ne.jp/' })
    // 戻り値は「書いた結果のディスクの中身」（画面の表示用の写しは、これで新しくなる）
    expect(next).toEqual(m)
    expect((next as any).publish.apprunDedicated.clusterID).toBe('cl-1')
  })

  it('★★★ 「記録を片づける」は、その公開先の記録だけを消す。専有型の資源ID・ほかの公開先・projectId は残る', async () => {
    openDialogThenMainWrites()
    // レンタルサーバの記録も書いておく（片づける対象）
    await mergeProjectMeta(projectDir, rentalPublishPatch({ account: 'acct', host: 'acct.sakura.ne.jp', publishedAt: '2026-09-29T02:00:00.000Z' }))
    const next = await forgetPublishTargetRecord(projectDir, 'sakura-rental')
    const m = readMeta()
    expect(m.publish.targets['sakura-rental']).toBeUndefined()
    // 消した結果は、既存の判定（withoutPublishTarget）と同じ（host / lastPublishedAt も片づく）
    expect(m.publish.host).toBeUndefined()
    expect(m.publish.lastPublishedAt).toBeUndefined()
    // main が書いた記録は全部残っている
    ALL_MAIN_WRITTEN()
    expect(next).toEqual(m)
  })

  it('★★★ 専有型の「記録を片づける」でも、消えるのは公開の一覧の行（publish.targets）だけ。資源ID（publish.apprunDedicated）は残る', async () => {
    openDialogThenMainWrites()
    await forgetPublishTargetRecord(projectDir, 'sakura-apprun-dedicated')
    const m = readMeta()
    expect(m.publish.targets['sakura-apprun-dedicated']).toBeUndefined()
    // 資源IDが残るので、⑥で破棄できる（課金を止められる）
    expect(m.publish.apprunDedicated).toMatchObject({ ...MAIN_WRITTEN_IDS })
    expect(m.publish.hanamii.projectId).toBe('hp-1')
    expect(m.publish.targets.vercel).toBeDefined()
  })

  it('HANAMII の「記録を片づける」は projectId を消す（既存の約束）が、専有型の資源IDは残る', async () => {
    openDialogThenMainWrites()
    await forgetPublishTargetRecord(projectDir, 'hanamii')
    const m = readMeta()
    expect(m.publish.hanamii.projectId).toBeNull()
    expect(m.publish.apprunDedicated).toMatchObject({ ...MAIN_WRITTEN_IDS })
  })

  it('📡 一覧・破棄の後始末（clearPublishRecord）も同じ経路: 資源IDは残り、画面へ「変わった」と知らせる', async () => {
    openDialogThenMainWrites()
    await clearPublishRecord(projectDir, 'sakura-apprun-dedicated')
    expect(readMeta().publish.targets['sakura-apprun-dedicated']).toBeUndefined()
    expect(readMeta().publish.apprunDedicated).toMatchObject({ ...MAIN_WRITTEN_IDS })
    expect(events).toContain('sakura-meta-changed')
  })

  it('資料の設定（saveRagSettings）を書いても、専有型の資源IDは残る', async () => {
    openDialogThenMainWrites()
    await saveRagSettings(projectDir, { enabled: true, tags: ['a'] })
    ALL_MAIN_WRITTEN()
    expect(readMeta().rag).toEqual({ enabled: true, tags: ['a'] })
  })

  it('専有型パネルの saveMeta（手作業の入力・同意）の差分を当てても、main が書いた資源IDは残る', async () => {
    openDialogThenMainWrites()
    // AppRunDedicatedPanel.saveMeta が渡す差分の形（consentedAt を取り消す）
    await mergeProjectMeta(projectDir, { target: 'sakura-apprun-dedicated', publish: { apprunDedicated: { consentedAt: null } } })
    const m = readMeta()
    expect(m.publish.apprunDedicated.consentedAt).toBeNull()
    expect(m.publish.apprunDedicated).toMatchObject({ ...MAIN_WRITTEN_IDS, servicePrincipalId: 'sp-1' })
  })

  it('HANAMII の保存（saveHanamiiMeta の差分）を当てても、main が書いた projectId・公開記録・資源IDは残る', async () => {
    openDialogThenMainWrites()
    await mergeProjectMeta(projectDir, {
      target: 'hanamii',
      publish: { hanamii: { workspaceId: 'ws-1', envs: [{ key: 'A', secret: false }] }, targets: { hanamii: { publishedAt: 't', url: null } } },
    })
    const m = readMeta()
    expect(m.publish.hanamii).toEqual({ projectId: 'hp-1', workspaceId: 'ws-1', envs: [{ key: 'A', secret: false }] })
    expect(m.publish.apprunDedicated).toMatchObject({ ...MAIN_WRITTEN_IDS })
    expect(m.publish.targets['sakura-apprun-dedicated']).toBeDefined()
    expect(m.publish.targets.hanamii).toEqual({ publishedAt: 't', url: null })
  })
})

describe('書き込みの失敗・不正な入力', () => {
  it('書き込めなければ、画面へ例外で返る（黙って成功にしない）', async () => {
    // 親フォルダが無い＝書けない
    const missing = path.join(projectDir, 'no-such-dir')
    await expect(mergeProjectMeta(missing, { target: 'x' })).rejects.toThrow('公開の記録を書き込めませんでした')
  })

  it('相対パス・空・文字列以外の projectDir は断る', async () => {
    expect(await call('publishMeta:merge', 'relative/dir', { target: 'x' })).toMatchObject({ ok: false })
    expect(await call('publishMeta:merge', '', { target: 'x' })).toMatchObject({ ok: false })
    expect(await call('publishMeta:merge', 42, { target: 'x' })).toMatchObject({ ok: false })
    expect(await call('publishMeta:forgetTarget', 'relative/dir', 'vercel')).toMatchObject({ ok: false })
    expect(fs.existsSync(metaPath())).toBe(false)
  })

  it('差分がオブジェクトでない（配列・文字列・null）なら書かない', async () => {
    writeMeta({ name: 'keep' })
    for (const bad of [[], 'x', null, 5]) {
      expect(await call('publishMeta:merge', projectDir, bad)).toMatchObject({ ok: false })
    }
    expect(readMeta()).toEqual({ name: 'keep' })
  })

  it('記録が無いプロジェクトで「片づける」を押しても、ファイルを作らない', () => {
    expect(fs.existsSync(metaPath())).toBe(false)
    expect(forgetPublishTargetFs(projectDir, 'vercel')).toEqual({ ok: true, meta: {} })
    expect(fs.existsSync(metaPath())).toBe(false)
  })

  it('壊れている記録は、「片づける」で上書きしない（消すものが無いのと同じ）', () => {
    fs.writeFileSync(metaPath(), '{ これは JSON ではない', 'utf-8')
    expect(forgetPublishTargetFs(projectDir, 'vercel').ok).toBe(true)
    expect(fs.readFileSync(metaPath(), 'utf-8')).toBe('{ これは JSON ではない')
  })

  it('変わらない差分は、ファイルを書き直さない', () => {
    writeMeta({ name: 'a', publish: { targets: { vercel: { publishedAt: 't', url: 'u' } } } })
    const before = fs.readFileSync(metaPath(), 'utf-8')
    const stat = fs.statSync(metaPath()).mtimeMs
    expect(mergeMetaPatchFs(projectDir, { name: 'a' }).ok).toBe(true)
    expect(fs.readFileSync(metaPath(), 'utf-8')).toBe(before)
    expect(fs.statSync(metaPath()).mtimeMs).toBe(stat)
  })
})

describe('「確認しました」（中断の可能性の通知を消す）: 走っている公開の印は消さない', () => {
  it('走っていなければ、pending だけが消える（ほかの記録は残る）', async () => {
    openDialogThenMainWrites()
    markPendingFs(projectDir, 'hanamii')
    expect(readMeta().publish.pending).toBeDefined()
    expect(await dismissInterruptedPublish(projectDir)).toEqual({ ok: true })
    expect('pending' in readMeta().publish).toBe(false)
    ALL_MAIN_WRITTEN()
  })

  it('★ いま公開が走っているプロジェクトでは、断る（pending は残る）', async () => {
    markPendingFs(projectDir, 'hanamii')
    let refused: unknown
    await withProjectLock(projectDir, '公開', async () => {
      refused = await dismissInterruptedPublish(projectDir)
    })
    expect(refused).toMatchObject({ ok: false, running: true })
    expect(readMeta().publish.pending.target).toBe('hanamii')
    // 終わったあとなら消せる
    expect(await dismissInterruptedPublish(projectDir)).toEqual({ ok: true })
    expect('pending' in readMeta().publish).toBe(false)
  })

  it('pending が無ければ何も書かない（ファイルも作らない）', async () => {
    expect(await dismissInterruptedPublish(projectDir)).toEqual({ ok: true })
    expect(fs.existsSync(metaPath())).toBe(false)
  })
})

describe('withMetaPatch（差分の当て方・純関数）', () => {
  it('プレーンオブジェクトは再帰でマージ。patch に無いキーはそのまま残る', () => {
    const base = { a: 1, publish: { x: 1, deep: { p: 1, q: 2 } }, keep: true }
    expect(withMetaPatch(base, { publish: { deep: { q: 9 }, y: 2 } })).toEqual({
      a: 1, publish: { x: 1, deep: { p: 1, q: 9 }, y: 2 }, keep: true,
    })
  })

  it('配列・文字列・null は置き換える（null は「null にする」。消さない）', () => {
    expect(withMetaPatch({ tags: ['a', 'b'], s: 'x', n: 1 }, { tags: ['c'], s: null })).toEqual({ tags: ['c'], s: null, n: 1 })
  })

  it('undefined のキーは取り除く（消す意図の明示）', () => {
    const out = withMetaPatch({ a: 1, b: 2 }, { a: undefined })
    expect(out).toEqual({ b: 2 })
    expect('a' in out).toBe(false)
  })

  it('base / patch が壊れた値（null・配列・文字列）でも落ちない', () => {
    expect(withMetaPatch(null, { a: 1 })).toEqual({ a: 1 })
    expect(withMetaPatch([1, 2], { a: 1 })).toEqual({ a: 1 })
    expect(withMetaPatch('x', { a: 1 })).toEqual({ a: 1 })
    expect(withMetaPatch({ a: 1 }, null)).toEqual({ a: 1 })
    expect(withMetaPatch({ a: 1 }, [1])).toEqual({ a: 1 })
  })

  it('入力を書き換えない（base も patch も）。patch 由来の枝は、patch と参照を共有しない', () => {
    const base = { publish: { targets: { v: { url: 'u' } } } }
    const patch = { publish: { targets: { h: { url: 'x' } } } }
    const b0 = JSON.stringify(base)
    const p0 = JSON.stringify(patch)
    const out: any = withMetaPatch(base, patch)
    expect(JSON.stringify(base)).toBe(b0)
    expect(JSON.stringify(patch)).toBe(p0)
    // 出力の patch 由来の枝を変えても、patch 側は変わらない
    out.publish.targets.h.url = 'changed'
    expect(JSON.stringify(patch)).toBe(p0)
  })

  it('__proto__ のキーは読み飛ばす（プロトタイプを汚さない）', () => {
    const patch = JSON.parse('{"__proto__":{"polluted":true},"ok":1}')
    const out: any = withMetaPatch({}, patch)
    expect(out.ok).toBe(1)
    expect(({} as any).polluted).toBeUndefined()
    expect(out.polluted).toBeUndefined()
  })
})

describe('withoutPublishTarget: 消すのは「その公開先の記録」だけ（shared へ移した唯一の定義）', () => {
  it('専有型の資源IDには触れない（publish.apprunDedicated は publish の中でそのまま残る）', () => {
    const publish: any = { targets: { 'sakura-apprun-dedicated': { publishedAt: 't', url: 'u' } }, apprunDedicated: { clusterID: 'c1' }, pending: { target: 'vercel', startedAt: 't' } }
    const next: any = withoutPublishTarget(publish, 'sakura-apprun-dedicated')
    expect(next.targets['sakura-apprun-dedicated']).toBeUndefined()
    expect(next.apprunDedicated).toEqual({ clusterID: 'c1' })
    expect(next.pending).toEqual({ target: 'vercel', startedAt: 't' })
  })
})
