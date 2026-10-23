import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── 受け付けただけの破棄を、画面は「途中」と言う。「失敗しました」と言わない（0.6.22-rc.3 の実機・2026-10-21・10.18.15 の d1・d2）────────
// 記録は、**本物の main（registerHanamiiHandlers が登録する hanamii:teardown）を、偽の HANAMII サーバ（202）に流して**作る。
// 偽の記録の形を手で書かない（返り値の形・記録の形が main から離れても気づけなくなる）。
// 描く部品は本物の react-dom/server で HTML にする。見ること:
//   ・【公開】の結果カード（OpFinishedCard）の見出し: 受け付けただけ → 「途中です」・本当の失敗 → 「失敗しました」のまま
//   ・同じ文が、カードの本文と警告で2回出ない（d2）。違う警告は残る
//   ・📡 の結果（TeardownResultView）: 【公開】から始めた回の記録（開き直した知らせ）も、📡 から始めた回（その場の返り値）も「途中」
//   ・専有型のパネルの知らせ（DedicatedOpsParts の ResumedNotesView）も、同じ呼び名
//   ・「🤖 AIに相談する」は失敗のときだけ（相談の文が「次の失敗が出ました」と言うため）
// 呼び名の定義そのものは tests/teardownCall.test.ts。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  status: 202,
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
  return { ...real, loadCredentials: () => ({ token: 'tok', secret: 'sec' }) }
})
// 受け付けただけの回は保存場所へ進まないので、保存場所の偽は「呼ばれたら落ちる」だけにする（呼ばれないことも固定する）。
vi.mock('../src/main/cloud/storageAdapter', async (importOriginal) => {
  const real = await importOriginal<any>()
  return { ...real, createStorageAdapter: async () => { throw new Error('受け付けただけの回に、保存場所へ進んだ') } }
})
// 子のパネルは本題ではないので空の部品に差し替える（公開ダイアログの結果カードだけを描く。tests/opWord.test.ts と同じ）。
vi.mock('../src/renderer/components/StorageNotice', () => ({ default: () => null }))
vi.mock('../src/renderer/components/SecurityCheckSection', () => ({ default: () => null }))
vi.mock('../src/renderer/components/UnusedFilesSection', () => ({ default: () => null }))
vi.mock('../src/renderer/components/AppRunPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/components/HanamiiPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/components/VercelPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/components/VpsPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/components/AppRunDedicatedPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/publishRootRenderer', () => ({ resolvePublishRoot: async () => '' }))

import { registerHanamiiHandlers } from '../src/main/ipc/hanamii'
import * as ops from '../src/main/projectOps'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'
import { HANAMII_DELETION_ACCEPTED_WARNING } from '../src/shared/teardownResult'
import { OpFinishedCard } from '../src/renderer/components/PublishModal'
import TeardownResultView from '../src/renderer/components/teardown/TeardownResultView'
import { ResumedNotesView as DedicatedNotesView } from '../src/renderer/components/DedicatedOpsParts'
import { HanamiiTeardownResult } from '../src/renderer/components/HanamiiTeardownSection'
import { resumedTeardownNote } from '../src/renderer/teardown/watch'
import { resumedNoteOf } from '../src/renderer/apprunDedicatedActions'
import { HANAMII_TEARDOWN_WORDS, hanamiiTeardownSpec } from '../src/renderer/teardown/targets/hanamii'
import { DEDICATED_TEARDOWN_WORDS } from '../src/renderer/teardown/targets/dedicated'
import { resumedTeardownView } from '../src/shared/teardownResult'
import { PUBLISH_TARGET_LABEL } from '../src/renderer/publishStatus'
import { stoppedNotice } from './stoppedNoticeHarness'
import { deleteProjectReplyText } from './hanamiiTeardownFixtures'

registerHanamiiHandlers({} as any)
const teardown = h.handlers.get('hanamii:teardown')!

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el)
const text = (s: string) => s.replace(/<[^>]*>/g, '')
const count = (s: string, part: string) => s.split(part).length - 1

const PROJECT_ID = 'hnm-proj-1'
const DIR = '/tmp/koto-teardown-call-render'
const realFetch = globalThis.fetch
let projectDir = ''

beforeEach(() => {
  ops.resetProjectOpsForTests()
  h.status = 202
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-teardown-call-'))
  globalThis.fetch = (async () => {
    const status = h.status
    return { ok: status >= 200 && status < 300, status, async text() { return deleteProjectReplyText(status, PROJECT_ID) } }
  }) as unknown as typeof fetch
  const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: false })
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

/** 本物の hanamii:teardown を1回呼ぶ。その場の返り値と、main が置いた処理の記録（写し）を返す。 */
async function pressTeardown(): Promise<{ reply: any; rec: ProjectOpRecordShape }> {
  const reply = await teardown({}, projectDir, { token: 'hnm_test' }, { confirmed: true, projectId: PROJECT_ID })
  const last = ops.getOps(projectDir).last
  if (!last) throw new Error('記録が置かれなかった')
  return { reply, rec: JSON.parse(JSON.stringify(last)) as ProjectOpRecordShape }
}

/** 手で作る記録（本物の projectOps に、渡した返り値を通して置かせる。opWord.test.ts と同じ）。 */
function finished(target: 'hanamii' | 'sakura-apprun-dedicated' | 'sakura-apprun', value: Record<string, unknown>): ProjectOpRecordShape {
  ops.resetProjectOpsForTests()
  const handler = { hanamii: 'hanamii:teardown', 'sakura-apprun-dedicated': 'apprunDedicated:teardown', 'sakura-apprun': 'cloud:teardown' }[target]
  ops.beginOp(DIR, '削除', { target, handler })
  ops.finishOp(DIR, { value })
  return JSON.parse(JSON.stringify(ops.getOps(DIR).last!)) as ProjectOpRecordShape
}

const LABEL = PUBLISH_TARGET_LABEL.hanamii

describe('前提: 実機の記録の形（本物の main が、202 のとき置くもの）', () => {
  it('★★★ 202 の記録は ok:false・deletionAccepted・本文と警告が同じ文（d2 の元）。保存場所へは進まない', async () => {
    const { reply, rec } = await pressTeardown()
    expect(reply).toEqual({ ok: false, appDeleted: false, deletionAccepted: true, message: HANAMII_DELETION_ACCEPTED_WARNING })
    expect(rec.result?.ok).toBe(false)
    expect(rec.result?.extra?.deletionAccepted).toBe(true)
    expect(rec.result?.message).toBe(HANAMII_DELETION_ACCEPTED_WARNING)
    expect(rec.result?.warnings).toContain(HANAMII_DELETION_ACCEPTED_WARNING)
  })
})

describe('【公開】の結果カード（OpFinishedCard）: d1・d2', () => {
  it('★★★ 受け付けただけの破棄: 見出しは「⏳ …の破棄は途中です」。「失敗」と言わない。押し直す案内は本文のまま', async () => {
    const { rec } = await pressTeardown()
    const t = text(html(createElement(OpFinishedCard, { rec })))
    expect(t).toContain(`⏳ ${LABEL}の破棄は途中です`)
    expect(t, '受け付けただけの回を失敗と言っている').not.toContain('失敗')
    expect(t).toContain('しばらくしてから、もう一度破棄を押してください')
    expect(t).not.toContain('の削除は途中です') // 言葉は opWordFor（HANAMII は「破棄」）
  })

  it('★★★ 本文と警告に同じ文があっても、1回だけ描かれる（d2）。黄色の枠のまま（途中は見逃させない）', async () => {
    const { rec } = await pressTeardown()
    const h1 = html(createElement(OpFinishedCard, { rec }))
    expect(count(text(h1), HANAMII_DELETION_ACCEPTED_WARNING), '同じ文が2回以上出ている').toBe(1)
    expect(h1).toContain('border-brand-yellow')
  })

  it('★★★ 本当の失敗（HTTP 500 で断られた）は「失敗しました」のまま。途中とは言わない', async () => {
    h.status = 500
    const { rec } = await pressTeardown()
    const t = text(html(createElement(OpFinishedCard, { rec })))
    expect(t).toContain(`⚠️ ${LABEL}の破棄に失敗しました`)
    expect(t).not.toContain('途中です')
    expect(t).toContain('削除に失敗しました（HTTP 500）')
  })

  it('★★ 本文と違う警告は残る。同じ文の警告だけが落ちる（受け付けただけの回に、別の知らせが付いた場合）', () => {
    const rec = finished('hanamii', { ok: false, appDeleted: false, deletionAccepted: true, message: HANAMII_DELETION_ACCEPTED_WARNING, notice: '別の知らせです。月額が続きます' })
    const t = text(html(createElement(OpFinishedCard, { rec })))
    expect(count(t, HANAMII_DELETION_ACCEPTED_WARNING)).toBe(1)
    expect(count(t, '別の知らせです。月額が続きます')).toBe(1)
    expect(t).toContain(`⏳ ${LABEL}の破棄は途中です`)
  })

  it('★★ 警告が本文と別の文だけなら、そのまま出る（成功のあとの確認が必要な知らせ）', () => {
    const rec = finished('hanamii', { ok: true, appDeleted: true, executed: ['✅ 破棄しました'], keptBucketName: 'koto-data-bucket' })
    const t = text(html(createElement(OpFinishedCard, { rec })))
    expect(t).toContain(`⚠️ ${LABEL}の破棄は終わりましたが、確認が必要なことがあります`)
    expect(t).toContain('koto-data-bucket')
  })

  it('★★ 専有型が待ち切れて止まった記録（失敗でなく途中）も、見出しは「削除は途中です」。成功・失敗は今までどおり', () => {
    const label = PUBLISH_TARGET_LABEL['sakura-apprun-dedicated']
    const stopped = finished('sakura-apprun-dedicated', { ok: false, inProgress: { applicationID: 'app-1' }, message: '待ち切れませんでした' })
    const t = text(html(createElement(OpFinishedCard, { rec: stopped })))
    expect(t).toContain(`⏳ ${label}の削除は途中です`)
    expect(t).not.toContain('に失敗しました')
    const failed = finished('sakura-apprun-dedicated', { ok: false, remaining: { applicationID: 'app1' }, message: 'アプリの削除に失敗しました' })
    expect(text(html(createElement(OpFinishedCard, { rec: failed })))).toContain(`⚠️ ${label}の削除に失敗しました`)
    const done = finished('sakura-apprun-dedicated', { ok: true, executed: ['✅ 削除しました'] })
    expect(text(html(createElement(OpFinishedCard, { rec: done })))).toContain(`✅ ${label}の削除が終わりました`)
  })
})

describe('📡 の結果（TeardownResultView）: 【公開】から始めた回の記録も、📡 から始めた回も「途中」', () => {
  const render = (over: Partial<Parameters<typeof TeardownResultView>[0]>) => html(createElement(TeardownResultView, {
    view: null, notes: [], words: HANAMII_TEARDOWN_WORDS, retryHint: 'この一覧の 🗑 破棄',
    serviceConsoleUrl: 'https://hanamii.jp/', storageConsoleUrl: 'https://secure.sakura.ad.jp/cloud/', ...over,
  }))

  it('★★★ 📡 から始めた回（その場の返り値）: 「⏳ 破棄の途中です」。「失敗」と言わない', async () => {
    const { reply } = await pressTeardown()
    const t = text(render({ view: hanamiiTeardownSpec.toView(reply) }))
    expect(t).toContain(HANAMII_TEARDOWN_WORDS.inProgressHeadline)
    expect(t).not.toContain('失敗')
    expect(count(t, HANAMII_DELETION_ACCEPTED_WARNING), '同じ文が2回出ている').toBe(1)
  })

  it('★★★ 【公開】から始めた回（記録を開き直した知らせ）: 前の回の一言は「⏳ 途中です。」。「⚠️ 失敗しました。」と言わない。最新の見出しも「途中」', async () => {
    const first = await pressTeardown()
    const second = await pressTeardown()
    const notes = [first.rec, second.rec].map(r => resumedTeardownNote(HANAMII_TEARDOWN_WORDS, r))
    const t = text(render({ view: resumedTeardownView('hanamii', second.rec.result), notes }))
    expect(t).toContain('⏳ 途中です。')
    expect(t, '同じ記録を、📡 で失敗と言っている').not.toContain('失敗しました')
    expect(t).toContain(HANAMII_TEARDOWN_WORDS.inProgressHeadline)
    expect(t).not.toContain('AIに相談する')
    // 2回押したので、押した回ごとに1回ずつ（前の回の一言の中・最新の結果欄の本文）。警告の欄・知らせの警告には重ねて出ない（d2）。
    expect(count(t, HANAMII_DELETION_ACCEPTED_WARNING), '同じ文を、警告の欄や知らせの警告が重ねて出している').toBe(2)
  })

  it('★★ 前の回が本当の失敗なら、その一言は「⚠️ 失敗しました。」のまま（最新が途中でも）', async () => {
    h.status = 500
    const first = await pressTeardown()
    h.status = 202
    const second = await pressTeardown()
    const notes = [first.rec, second.rec].map(r => resumedTeardownNote(HANAMII_TEARDOWN_WORDS, r))
    const t = text(render({ view: resumedTeardownView('hanamii', second.rec.result), notes }))
    expect(t).toContain('⚠️ 失敗しました。 削除に失敗しました（HTTP 500）')
    expect(t).toContain(HANAMII_TEARDOWN_WORDS.inProgressHeadline)
  })

  it('★★★ 「🤖 AIに相談する」は失敗のときだけ。受け付けただけ・待ち切れて止まった回には出さない（相談の文が「次の失敗が出ました」と言う）', async () => {
    const onAskAi = () => {}
    const accepted = (await pressTeardown())
    expect(text(render({ view: hanamiiTeardownSpec.toView(accepted.reply), onAskAi }))).not.toContain('AIに相談する')
    expect(text(render({ view: resumedTeardownView('hanamii', accepted.rec.result), onAskAi }))).not.toContain('AIに相談する')
    const stopped = finished('sakura-apprun-dedicated', { ok: false, inProgress: { applicationID: 'app-1' }, message: '待ち切れませんでした' })
    expect(text(render({ view: resumedTeardownView('sakura-apprun-dedicated', stopped.result), words: DEDICATED_TEARDOWN_WORDS, onAskAi }))).not.toContain('AIに相談する')
    h.status = 500
    const failed = await pressTeardown()
    expect(text(render({ view: hanamiiTeardownSpec.toView(failed.reply), onAskAi }))).toContain('AIに相談する')
    expect(text(render({ view: resumedTeardownView('hanamii', failed.rec.result), onAskAi }))).toContain('AIに相談する')
  })

  it('★★ HANAMII の欄（記録から描く HanamiiTeardownResult）: 途中の見出しで、同じ文は1回だけ', async () => {
    const { rec } = await pressTeardown()
    const t = text(html(createElement(HanamiiTeardownResult, { rec })))
    expect(t).toContain(HANAMII_TEARDOWN_WORDS.inProgressHeadline)
    expect(t).not.toContain('失敗')
    expect(count(t, HANAMII_DELETION_ACCEPTED_WARNING)).toBe(1)
  })
})

describe('専有型のパネルの知らせ（DedicatedOpsParts の ResumedNotesView）も、同じ呼び名', () => {
  const NOW = new Date(2026, 9, 21, 17, 54).getTime()
  const later = (rec: ProjectOpRecordShape): ProjectOpRecordShape => ({ ...rec, startedAt: rec.startedAt + 1, finishedAt: NOW + 60_000 })
  const notesOf = (recs: ProjectOpRecordShape[]) => recs.map(r => resumedNoteOf({ kind: 'teardown', record: r }))

  it('★★★ 前の回が「待ち切れて止まった」（途中）なら「⏳ 途中です。」。「失敗しました」と言わない', () => {
    const stopped = finished('sakura-apprun-dedicated', { ok: false, inProgress: { applicationID: 'app-1' }, message: '待ち切れませんでした' })
    const done = finished('sakura-apprun-dedicated', { ok: true, executed: ['✅ 削除しました'] })
    const t = text(html(createElement(DedicatedNotesView, { notes: notesOf([stopped, later(done)]) })))
    expect(t).toContain('⏳ 途中です。 待ち切れませんでした')
    expect(t).not.toContain('失敗しました')
  })

  it('★★★ 前の回が「Koto の終了で止まりました」の知らせでも、失敗と言わず、次の操作の案内だけを出す', () => {
    const notice = stoppedNotice(DIR, 'sakura-apprun-dedicated', NOW)
    const done = finished('sakura-apprun-dedicated', { ok: true, executed: ['✅ 削除しました'] })
    const t = text(html(createElement(DedicatedNotesView, { notes: notesOf([notice, later(done)]) })))
    expect(t).not.toContain('失敗しました')
    expect(t).toContain('Koto の終了で止まりました')
    expect(t).toContain('もう一度削除を押すと、続きから進みます。')
  })

  it('★★ 本当の失敗は「⚠️ 失敗しました。」、成功は「✅ 成功しました。」のまま', () => {
    const failed = finished('sakura-apprun-dedicated', { ok: false, remaining: { applicationID: 'app1' }, message: 'アプリの削除に失敗しました' })
    const done = finished('sakura-apprun-dedicated', { ok: true, executed: ['✅ 削除しました'] })
    const t1 = text(html(createElement(DedicatedNotesView, { notes: notesOf([failed, later(done)]) })))
    expect(t1).toContain('⚠️ 失敗しました。 アプリの削除に失敗しました')
    const t2 = text(html(createElement(DedicatedNotesView, { notes: notesOf([done, later(failed)]) })))
    expect(t2).toContain('✅ 成功しました。')
  })

  it('★★ 専有型の手順5・8の知らせ（作成・公開の記録）は、これまでどおり ok で成功・失敗を言う', () => {
    ops.resetProjectOpsForTests()
    ops.beginOp(DIR, '作成', { target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:create' })
    ops.finishOp(DIR, { value: { ok: false, message: 'クラスタを作れませんでした' } })
    const failed = JSON.parse(JSON.stringify(ops.getOps(DIR).last!)) as ProjectOpRecordShape
    const okRec = { ...failed, startedAt: failed.startedAt + 1, result: { ok: true, message: '', lines: [], warnings: [], extra: {} } } as ProjectOpRecordShape
    const notes = [failed, okRec].map(r => resumedNoteOf({ kind: 'create', record: r }))
    const t = text(html(createElement(DedicatedNotesView, { notes })))
    expect(t).toContain('⚠️ 失敗しました。 クラスタを作れませんでした')
  })
})
