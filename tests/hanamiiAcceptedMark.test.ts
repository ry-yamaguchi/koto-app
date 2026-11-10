import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import {
  hanamiiDeletionAcceptedOf, withHanamiiDeletionAccepted, withHanamiiProjectId, withHanamiiStorageLeftover, withoutPublishTargetInMeta,
  type HanamiiDeletionAcceptedMark,
} from '../src/shared/publishMeta'
import { buildHanamiiAcceptedMark } from '../src/main/hanamii/acceptedMark'
import { writeHanamiiAcceptedMarkFs, readHanamiiAcceptedMarkFs, settleHanamiiTeardownFs, writeHanamiiProjectIdFs, writePublishRecordFs } from '../src/main/publishMetaFs'

// ── 受け付けの印（publish.hanamii.deletionAccepted）の形・作り手・書き手（掟10: 印の読み書きは1つの組）──────────────
// 続きの自動の確かめは、この印があり、projectId が記録と一致するプロジェクトにだけ走る。読み手は「形が違うものは印なし」に倒す。

const MARK: HanamiiDeletionAcceptedMark = {
  projectId: 'prj_1', acceptedAt: '2026-11-09T01:02:03.000Z',
  shownPlacements: [{ bucket: 'b1', prefix: 'p/' }, { bucket: 'b2', prefix: 'q/', keepData: true }],
  requiresReview: false, operationId: 'op_1',
}
const metaWith = (mark: unknown) => ({ publish: { hanamii: { projectId: 'prj_1', deletionAccepted: mark }, targets: { hanamii: { publishedAt: null, url: null } } } })

describe('hanamiiDeletionAcceptedOf（読み手）', () => {
  it('★★★ 正しい印は、そのまま読める。operationId が無い印も読める', () => {
    expect(hanamiiDeletionAcceptedOf(metaWith(MARK))).toEqual(MARK)
    const { operationId: _o, ...noOp } = MARK
    expect(hanamiiDeletionAcceptedOf(metaWith(noOp))).toEqual(noOp)
  })

  it.each([
    ['印が無い', undefined],
    ['null', null],
    ['文字列', 'x'],
    ['配列', []],
    ['projectId が空', { ...MARK, projectId: '' }],
    ['projectId が数値', { ...MARK, projectId: 3 }],
    ['acceptedAt が無い', { ...MARK, acceptedAt: undefined }],
    ['requiresReview が文字列', { ...MARK, requiresReview: 'false' }],
    ['shownPlacements が配列でない', { ...MARK, shownPlacements: {} }],
    ['保存場所の組が壊れている', { ...MARK, shownPlacements: [{ bucket: 'b', prefix: 3 }] }],
    ['keepData が真偽値でない', { ...MARK, shownPlacements: [{ bucket: 'b', prefix: 'p/', keepData: 'yes' }] }],
    ['operationId が数値', { ...MARK, operationId: 5 }],
  ])('★★★ %s → 印なし（null）', (_n, mark) => {
    expect(hanamiiDeletionAcceptedOf(metaWith(mark))).toBeNull()
  })

  it('★★ 記録が壊れていても落ちない', () => {
    for (const meta of [null, undefined, 'x', [], {}, { publish: null }, { publish: { hanamii: null } }]) expect(hanamiiDeletionAcceptedOf(meta)).toBeNull()
  })
})

describe('buildHanamiiAcceptedMark（作り手）', () => {
  it('★★★ 202 を受けた事実と、見せた保存場所から印を組む。見せた組は parseShownPlacements を通し、形が違えば空（1件も消さない側）', () => {
    const at = new Date('2026-11-09T01:02:03.000Z')
    expect(buildHanamiiAcceptedMark({ projectId: 'prj_1', acceptedAt: at, shown: MARK.shownPlacements, requiresReview: false, operationId: 'op_1' })).toEqual(MARK)
    expect(buildHanamiiAcceptedMark({ projectId: 'prj_1', acceptedAt: at, shown: 'all', requiresReview: true, operationId: null }))
      .toEqual({ projectId: 'prj_1', acceptedAt: '2026-11-09T01:02:03.000Z', shownPlacements: [], requiresReview: true })
    expect(buildHanamiiAcceptedMark({ projectId: 'p', acceptedAt: at, shown: [{ bucket: 'b', prefix: 'x', keepData: false }, { bucket: 'c', prefix: 'y', extra: 1 }], requiresReview: false, operationId: null }).shownPlacements)
      .toEqual([{ bucket: 'b', prefix: 'x' }, { bucket: 'c', prefix: 'y' }])
  })
})

describe('印が外れる・引き継がれる（純関数）', () => {
  it('★★★ withHanamiiDeletionAccepted: 書く・null で外す（キーごと消える）。publish.hanamii のほかの項目と他のキーは保つ', () => {
    const base = { other: 1, publish: { hanamii: { projectId: 'prj_1', workspaceId: 'ws' }, targets: { hanamii: { publishedAt: null, url: null } } } }
    const written: any = withHanamiiDeletionAccepted(base, MARK)
    expect(written.publish.hanamii).toEqual({ projectId: 'prj_1', workspaceId: 'ws', deletionAccepted: MARK })
    expect(written.other).toBe(1)
    const cleared: any = withHanamiiDeletionAccepted(written, null)
    expect(cleared).toEqual(base)
    expect('deletionAccepted' in cleared.publish.hanamii).toBe(false)
  })

  it('★★★ 「保存場所が残った」印を書くと、受け付けの印は外れる（引き継ぎ）。受け付けの印が無い記録には、キーを足さない', () => {
    const r: any = withHanamiiStorageLeftover(metaWith(MARK), ['b1'])
    expect(r.publish.hanamii).toEqual({ projectId: 'prj_1', storageLeftoverBuckets: ['b1'] })
    const plain: any = withHanamiiStorageLeftover({ publish: { hanamii: { projectId: 'prj_1' } } }, ['b1'])
    expect('deletionAccepted' in plain.publish.hanamii).toBe(false)
  })

  it('★★★ 行ごと片づけると（withoutPublishTarget）、受け付けの印も消える', () => {
    const r: any = withoutPublishTargetInMeta(metaWith(MARK), 'hanamii')
    expect(r.publish.hanamii).toEqual({ projectId: null, storageLeftoverBuckets: null })
    expect(r.publish.targets.hanamii).toBeUndefined()
  })

  it('★★★ 再公開で projectId が別のものに替わっても、同じ projectId への公開し直しでも、受け付けの印は外れる。null の書き込みでは保つ', () => {
    const replaced: any = withHanamiiProjectId(metaWith(MARK), 'prj_NEW')
    expect(replaced.publish.hanamii.projectId).toBe('prj_NEW')
    expect('deletionAccepted' in replaced.publish.hanamii, '別のプロジェクトの印が残った').toBe(false)
    const same: any = withHanamiiProjectId(metaWith(MARK), 'prj_1')
    expect('deletionAccepted' in same.publish.hanamii, '同じ projectId への公開し直しで印が残った').toBe(false)
    expect(same.publish.hanamii.projectId).toBe('prj_1')
    const nullWrite: any = withHanamiiProjectId(metaWith(MARK), null)
    expect(nullWrite.publish.hanamii.deletionAccepted).toEqual(MARK)
  })
})

describe('writeHanamiiAcceptedMarkFs / readHanamiiAcceptedMarkFs（書き手）', () => {
  const dirs: string[] = []
  const mk = (meta?: unknown | string): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-accepted-mark-'))
    dirs.push(d)
    if (typeof meta === 'string') fs.writeFileSync(path.join(d, '.sakuraide.json'), meta)
    else if (meta !== undefined) fs.writeFileSync(path.join(d, '.sakuraide.json'), JSON.stringify(meta))
    return d
  }
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
  const file = (d: string) => path.join(d, '.sakuraide.json')

  it('★★★ 記録の projectId が同じなら書く。読み直すと同じ印', () => {
    const d = mk({ publish: { hanamii: { projectId: 'prj_1' }, targets: { hanamii: { publishedAt: null, url: null } } } })
    expect(writeHanamiiAcceptedMarkFs(d, MARK)).toEqual({ ok: true, marked: true })
    expect(readHanamiiAcceptedMarkFs(d)).toEqual(MARK)
    expect(JSON.parse(fs.readFileSync(file(d), 'utf-8')).publish.hanamii.deletionAccepted).toEqual(MARK)
  })

  it('★★★ 記録の projectId が違う・無い → 書かない（別の公開の記録・書く先の行が無い）', () => {
    const other = mk({ publish: { hanamii: { projectId: 'prj_OTHER' } } })
    const before = fs.readFileSync(file(other), 'utf-8')
    expect(writeHanamiiAcceptedMarkFs(other, MARK)).toEqual({ ok: true, marked: false })
    expect(fs.readFileSync(file(other), 'utf-8')).toBe(before)
    const none = mk({ publish: {} })
    expect(writeHanamiiAcceptedMarkFs(none, MARK)).toEqual({ ok: true, marked: false })
  })

  it('★★★ 記録ファイルが無い → 作らない／壊れている → 上書きしない', () => {
    const missing = mk()
    expect(writeHanamiiAcceptedMarkFs(missing, MARK)).toEqual({ ok: true, marked: false })
    expect(fs.existsSync(file(missing))).toBe(false)
    const broken = mk('{ not json')
    expect(writeHanamiiAcceptedMarkFs(broken, MARK)).toEqual({ ok: true, marked: false })
    expect(fs.readFileSync(file(broken), 'utf-8')).toBe('{ not json')
    expect(readHanamiiAcceptedMarkFs(broken)).toBeNull()
    expect(readHanamiiAcceptedMarkFs(missing)).toBeNull()
  })

  it('★★★ 書けなければ ok:false（読み取り専用）', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return
    const d = mk({ publish: { hanamii: { projectId: 'prj_1' } } })
    fs.chmodSync(file(d), 0o444)
    try {
      const r = writeHanamiiAcceptedMarkFs(d, MARK)
      expect(r.ok).toBe(false)
    } finally { fs.chmodSync(file(d), 0o644) }
  })

  it('★★★ 印が残った状態で、同じ projectId のまま公開が成功する（公開の書き手の2つ）と、印は外れ、projectId と行は残る', () => {
    const d = mk(metaWith(MARK))
    writeHanamiiProjectIdFs(d, 'prj_1')
    writePublishRecordFs(d, 'hanamii', { publishedAt: '2026-11-09T00:00:00.000Z', url: null })
    expect(readHanamiiAcceptedMarkFs(d)).toBeNull()
    const meta = JSON.parse(fs.readFileSync(file(d), 'utf-8'))
    expect(meta.publish.hanamii.projectId).toBe('prj_1')
    expect(meta.publish.targets.hanamii.publishedAt).toBe('2026-11-09T00:00:00.000Z')
  })

  it('★★★ 全部片づいた回（settleHanamiiTeardownFs）は、行ごと印も消す', () => {
    const d = mk(metaWith(MARK))
    expect(settleHanamiiTeardownFs(d, 'prj_1')).toEqual({ ok: true, cleared: true })
    const meta = JSON.parse(fs.readFileSync(file(d), 'utf-8'))
    expect(meta.publish.targets.hanamii).toBeUndefined()
    expect(meta.publish.hanamii.deletionAccepted).toBeUndefined()
    expect(readHanamiiAcceptedMarkFs(d)).toBeNull()
  })
})

// ── 3点セット（掟6）: hanamii:resumeTeardown は main・preload・global.d.ts で同じ形 ──────────────────────────
const read = (rel: string) => readFileSync(path.join(__dirname, '..', rel), 'utf-8')
const code = (rel: string) => read(rel).split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

describe('★★ hanamii:resumeTeardown の3点セット（main・preload・global.d.ts）', () => {
  it('★★★ preload と global.d.ts は同じ引数（projectDir, { token }, { projectId }）。confirmed も shownPlacements も受け取らない。invoke は1か所', () => {
    const preload = code('src/main/preload.ts')
    expect(preload).toContain("resumeTeardown: (projectDir: string, auth: { token: string }, opts: { projectId: string }) =>\n      ipcRenderer.invoke('hanamii:resumeTeardown', projectDir, auth, opts),")
    expect(preload.match(/ipcRenderer\.invoke\('hanamii:resumeTeardown'/g) ?? []).toHaveLength(1)
    const dts = code('src/renderer/global.d.ts')
    expect(dts).toContain('resumeTeardown(projectDir: string, auth: { token: string }, opts: { projectId: string }): Promise<{')
    const block = dts.slice(dts.indexOf('resumeTeardown(projectDir'), dts.indexOf('detectEnvKeys(projectDir'))
    expect(block).not.toContain('confirmed')
    expect(block).not.toContain('shownPlacements')
    // 返り値の項目は、teardown と同じ（main の HanamiiTeardownResult の全項目）
    for (const k of ['ok', 'appDeleted', 'executed', 'remainingBucket', 'remainingBuckets', 'skippedBuckets', 'keptBucketName', 'keptBucketNames', 'keptBucketsUsedByOthers', 'keptBucketsWithOwnFiles', 'deletionAccepted', 'deletionReview', 'message']) {
      expect(block, `renderer の型に ${k} が無い`).toMatch(new RegExp(`\\b${k}\\??: `))
    }
  })

  it('★★★ main: ハンドラの登録は hanamiiResumeTeardown.ts の1か所。骨 runTeardownShell を、確認の印なし（requireConfirmed:false）で通る。hanamii.ts から登録を呼ぶ', () => {
    const src = code('src/main/ipc/hanamiiResumeTeardown.ts')
    expect(src.match(/ipcMain\.handle\('hanamii:resumeTeardown'/g) ?? []).toHaveLength(1)
    expect(src).toContain('runTeardownShell(HANAMII_RESUME_SHELL, { projectDir, auth, opts })')
    expect(src).toContain('requireConfirmed: false')
    expect(src).not.toContain('withProjectLock(')
    const hanamii = code('src/main/ipc/hanamii.ts')
    expect(hanamii.match(/registerHanamiiResumeHandler\(\)/g) ?? []).toHaveLength(1)
    expect(code('src/main/ipc/hanamiiTeardown.ts')).not.toContain("ipcMain.handle('hanamii:resumeTeardown'")
  })

  it('★★ 400行以下: hanamiiTeardown.ts・hanamiiResumeTeardown.ts・hanamiiDeletionFlow.ts・deletionWait.ts・teardownResult.ts', () => {
    for (const f of ['src/main/ipc/hanamiiTeardown.ts', 'src/main/ipc/hanamiiResumeTeardown.ts', 'src/main/ipc/hanamiiDeletionFlow.ts', 'src/main/hanamii/deletionWait.ts', 'src/shared/teardownResult.ts', 'src/main/publishMetaFs.ts']) {
      expect(read(f).split('\n').length, f).toBeLessThanOrEqual(400)
    }
    expect(read('src/main/projectOps.ts').split('\n').length, 'projectOps.ts は 700 行以下').toBeLessThanOrEqual(700)
  })
})
