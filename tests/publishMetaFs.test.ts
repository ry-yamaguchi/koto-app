import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  markPendingFs, clearPendingFs, writePublishRecordFs, writeHanamiiProjectIdFs,
  readApprunDedicatedFs, writeApprunDedicatedRecordFs,
} from '../src/main/publishMetaFs'

// roadmap #20: src/main/publishMetaFs.ts（publishMeta.ts の純関数を使って
// <projectDir>/.sakuraide.json を読み書きする main 側の薄い層）を、本物の一時フォルダで検証する。
// electron 非依存に切り出してあるので（projectCreateFs.test.ts と同じ方針）、実ファイルで確かめられる。

let projectDir = ''
const metaPath = () => path.join(projectDir, '.sakuraide.json')
const readMeta = (): any => JSON.parse(fs.readFileSync(metaPath(), 'utf-8'))

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-publishmetafs-'))
})
afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true })
})

describe('markPendingFs / clearPendingFs: 開始マーカーの読み書きの往復', () => {
  it('.sakuraide.json が無い状態から mark すると、ファイルが作られ pending が入る', () => {
    expect(fs.existsSync(metaPath())).toBe(false)
    markPendingFs(projectDir, 'hanamii')
    expect(fs.existsSync(metaPath())).toBe(true)
    const m = readMeta()
    expect(m.publish.pending.target).toBe('hanamii')
    expect(typeof m.publish.pending.startedAt).toBe('string')
    expect(isNaN(new Date(m.publish.pending.startedAt).getTime())).toBe(false)
  })

  it('clear すると pending が消える。他のキーは残る', () => {
    fs.writeFileSync(metaPath(), JSON.stringify({ name: 'my-app', publish: { targets: { vercel: { publishedAt: 't', url: 'u' } } } }, null, 2))
    markPendingFs(projectDir, 'vercel')
    expect(readMeta().publish.pending).toBeDefined()
    clearPendingFs(projectDir)
    const m = readMeta()
    expect('pending' in m.publish).toBe(false)
    expect(m.name).toBe('my-app')
    expect(m.publish.targets.vercel).toEqual({ publishedAt: 't', url: 'u' })
  })

  it('.sakuraide.json が無い状態で clear しても例外を投げない（何もしないだけ）', () => {
    expect(fs.existsSync(metaPath())).toBe(false)
    expect(() => clearPendingFs(projectDir)).not.toThrow()
  })
})

describe('writePublishRecordFs: 公開記録の読み書き往復', () => {
  it('publish.targets[target] に記録が書かれる。他ターゲットの記録は残る', () => {
    fs.writeFileSync(metaPath(), JSON.stringify({ publish: { targets: { vercel: { publishedAt: '2026-01-01T00:00:00.000Z', url: 'https://v.example.com' } } } }, null, 2))
    writePublishRecordFs(projectDir, 'hanamii', { publishedAt: '2026-02-02T00:00:00.000Z', url: null })
    const m = readMeta()
    expect(m.publish.targets.hanamii).toEqual({ publishedAt: '2026-02-02T00:00:00.000Z', url: null })
    expect(m.publish.targets.vercel).toEqual({ publishedAt: '2026-01-01T00:00:00.000Z', url: 'https://v.example.com' })
  })

  it('.sakuraide.json が無い状態からでも書ける（ファイルが新規に作られる）', () => {
    expect(fs.existsSync(metaPath())).toBe(false)
    writePublishRecordFs(projectDir, 'sakura-apprun', { publishedAt: '2026-03-03T00:00:00.000Z', url: 'https://app.example.com' })
    expect(readMeta().publish.targets['sakura-apprun']).toEqual({ publishedAt: '2026-03-03T00:00:00.000Z', url: 'https://app.example.com' })
  })
})

describe('writeHanamiiProjectIdFs: HANAMII projectId の読み書き往復', () => {
  it('projectId が publish.hanamii.projectId に書かれる。既存の workspaceId 等は保つ', () => {
    fs.writeFileSync(metaPath(), JSON.stringify({ publish: { hanamii: { workspaceId: 'ws-1' } } }, null, 2))
    writeHanamiiProjectIdFs(projectDir, 'proj-1')
    const m = readMeta()
    expect(m.publish.hanamii.projectId).toBe('proj-1')
    expect(m.publish.hanamii.workspaceId).toBe('ws-1')
  })
})

describe('壊れている/読めない .sakuraide.json でも例外を投げない（記録の失敗で公開を落とさない）', () => {
  it('壊れたJSON（パース不能）の状態から mark/clear/record すべて例外を投げず、空メタ扱いで書き直す', () => {
    fs.writeFileSync(metaPath(), '{ this is not valid json')
    expect(() => markPendingFs(projectDir, 'hanamii')).not.toThrow()
    expect(readMeta().publish.pending.target).toBe('hanamii')

    fs.writeFileSync(metaPath(), '{ still not valid')
    expect(() => clearPendingFs(projectDir)).not.toThrow()

    fs.writeFileSync(metaPath(), 'not json at all')
    expect(() => writePublishRecordFs(projectDir, 'vercel', { publishedAt: 't', url: null })).not.toThrow()
    expect(readMeta().publish.targets.vercel).toEqual({ publishedAt: 't', url: null })

    fs.writeFileSync(metaPath(), '[]')
    expect(() => writeHanamiiProjectIdFs(projectDir, 'proj-x')).not.toThrow()
    expect(readMeta().publish.hanamii.projectId).toBe('proj-x')

    fs.writeFileSync(metaPath(), '{ broken again')
    expect(() => writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1' })).not.toThrow()
    expect(readMeta().publish.apprunDedicated.clusterID).toBe('c1')
  })

  it('projectDir 自体が存在しない（読み込み時に ENOENT のディレクトリ）でも例外を投げない', () => {
    const missing = path.join(projectDir, 'does-not-exist')
    expect(() => markPendingFs(missing, 'hanamii')).not.toThrow()
    expect(() => clearPendingFs(missing)).not.toThrow()
    expect(() => writePublishRecordFs(missing, 'vercel', { publishedAt: 't', url: null })).not.toThrow()
    expect(() => writeHanamiiProjectIdFs(missing, 'proj-x')).not.toThrow()
    expect(() => writeApprunDedicatedRecordFs(missing, { clusterID: 'c1' })).not.toThrow()
    expect(() => readApprunDedicatedFs(missing)).not.toThrow()
    // 書き込み自体も失敗する（親フォルダが無い）ため、ファイルは作られない。
    // ここで確かめたいのは「例外で公開処理そのものが落ちないこと」であり、書けたかどうかではない。
  })
})

describe('readApprunDedicatedFs / writeApprunDedicatedRecordFs: AppRun専有型の記録の読み書き往復（roadmap #23 段階②）', () => {
  it('記録が無ければ空オブジェクトを返す（未同意・未作成として扱われる）', () => {
    expect(readApprunDedicatedFs(projectDir)).toEqual({})
  })

  it('書いたものが読み戻る。他の publish.* キーは保つ', () => {
    fs.writeFileSync(metaPath(), JSON.stringify({ publish: { targets: { vercel: { publishedAt: 't', url: 'u' } } } }, null, 2))
    writeApprunDedicatedRecordFs(projectDir, { consentedAt: '2026-09-01T00:00:00.000Z' })
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', name: 'myapp' })
    writeApprunDedicatedRecordFs(projectDir, { asgID: 'a1' })
    writeApprunDedicatedRecordFs(projectDir, { loadBalancerID: 'l1' })

    const rec = readApprunDedicatedFs(projectDir)
    expect(rec).toEqual({
      consentedAt: '2026-09-01T00:00:00.000Z',
      clusterID: 'c1',
      name: 'myapp',
      asgID: 'a1',
      loadBalancerID: 'l1',
    })
    expect(readMeta().publish.targets.vercel).toEqual({ publishedAt: 't', url: 'u' })
  })

  it('null で個別のIDを消せる（破棄で消せたIDをクリアする使い方）', () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })
    writeApprunDedicatedRecordFs(projectDir, { loadBalancerID: null })
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.loadBalancerID).toBeNull()
    expect(rec.asgID).toBe('a1')
    expect(rec.clusterID).toBe('c1')
  })
})

describe('writeApprunDedicatedRecordFs: 戻り値は書き込めたかどうかを表す（2026-09-10 レビューの修理・C）', () => {
  it('書き込みに成功すれば true を返す', () => {
    expect(writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1' })).toBe(true)
    expect(readApprunDedicatedFs(projectDir).clusterID).toBe('c1')
  })

  it('書き込めない（読み取り専用フォルダ）ときは例外を投げず false を返す。createClusterFlow はこれを見て止まる', () => {
    fs.chmodSync(projectDir, 0o500)
    try {
      expect(() => writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1' })).not.toThrow()
      expect(writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1' })).toBe(false)
    } finally {
      fs.chmodSync(projectDir, 0o700)
    }
  })
})
