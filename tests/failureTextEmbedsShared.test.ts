import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { h, resetHarness, newProjectDir, setup, A, PREFIX, workspaceOf } from './sharedTeardownHarness'
import { splitFailureDetail } from '../src/shared/failureDetail'

// ── 日本語の文に原文を埋め込んでいた所（保存場所・破棄・レジストリの使い手）が「文＋最後の行に詳細」になること ──────────
// 以前は `…できませんでした: fetch failed` のように、英語の原文が文末や括弧の中に入り、ホスト名も（回線断の）日本語の文も無かった。
// 日本語を含む文は renderer で判定できないので、main で作る。詳細は、あとに足す注意よりも後ろ（いつも最後の行）に置く。

const net = vi.hoisted(() => ({
  down: () => Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('getaddrinfo ENOTFOUND secure.sakura.ad.jp'), { code: 'ENOTFOUND' }),
  }),
  reset: () => Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  }),
}))

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
const adapter = vi.hoisted(() => ({ mode: 'down' as 'down' | 'marker-down' }))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createStorageAdapter: async () => {
    if (adapter.mode === 'down') throw net.down()
    return {
      siteInfo: () => ({ s3Endpoint: 's3.isk01.sakurastorage.jp', region: 'jp-north-1' }),
      async issueKey() { return { accessKey: 'AKIA-X', secretKey: 'S3CRET-X', permissionId: 'perm-1' } },
      async putMarker() { throw net.reset() },
      async dispose() {},
    }
  },
}))

import { issueStorageEnvFor } from '../src/main/cloud/storageForTarget'
import { teardownStorage, keyWarningLines, KEY_REVOKE_FAILED_WARNING } from '../src/main/cloud/storageTeardown'
import { teardownRegistry } from '../src/main/ipc/cloudTeardown'
import { otherProjectsUsingRegistry } from '../src/main/cloud/registryUsers'
import { registryCheckInPanelNote } from '../src/shared/cloudCost'

const JAPANESE = /[぀-ヿ一-鿿]/
function expectSentenceAndDetail(message: string, detailPart: string): void {
  const { text, detail } = splitFailureDetail(message)
  expect(JAPANESE.test(text)).toBe(true)
  expect(text).not.toContain('fetch failed')
  expect(detail).toContain(detailPart)
  // 詳細はいつも最後の行
  expect(message.endsWith(`詳細: ${detail}`)).toBe(true)
}

beforeEach(() => { resetHarness(); adapter.mode = 'down' })

describe('保存場所のアクセスキーの用意（HANAMII・Vercel・専有型の公開が通る）', () => {
  it('回線断: 前置きを残し、日本語の文＋詳細（ホスト名）', async () => {
    const dir = newProjectDir()
    setup(dir, { env: [A], resources: [] })
    const r = await issueStorageEnvFor({ projectDir: dir, target: 'vercel' })
    expect(r.ok).toBe(false)
    const message = (r as { message: string }).message
    expect(message.startsWith('保存場所のアクセスキーを用意できませんでした: ')).toBe(true)
    expectSentenceAndDetail(message, 'secure.sakura.ad.jp')
  })

  it('目印（.koto-keep）を置けなかった知らせ: 文は括弧の外に詳細が残る（途中で切れたなら済んだかは分からない）', async () => {
    adapter.mode = 'marker-down'
    const dir = newProjectDir()
    setup(dir, { env: [A], resources: [] })
    const r = await issueStorageEnvFor({ projectDir: dir, target: 'vercel' })
    expect(r.ok).toBe(true)
    const note = (r as { markerNote?: string }).markerNote ?? ''
    expect(note).toContain('.koto-keep')
    expect(note).toContain('公開は続けました')
    expectSentenceAndDetail(note, 'ECONNRESET')
  })
})

describe('保存場所の破棄（teardownStorage）', () => {
  const storage = (opts: { list?: unknown; del?: unknown }) => ({
    async listAllKeys() { if (opts.list) throw opts.list; return [`${PREFIX}data.json`] },
    async deleteKeys() { if (opts.del) throw opts.del },
    async deleteBucket() { if (opts.del) throw opts.del },
    async deletePermission() {},
  })

  it('中身を確かめる一覧が回線断: 日本語の文（もう一度と言える）＋詳細', async () => {
    const dir = newProjectDir()
    setup(dir, { env: [A], resources: [] })
    const r = await teardownStorage({ storage: storage({ list: net.down() }) as any, placement: { bucket: A, prefix: PREFIX, shared: true }, projectDir: dir })
    expect(r.ok).toBe(false)
    const message = (r as { message: string }).message
    expect(message).toContain(`保存場所『${A}』の中身を確認できないため、削除を中止しました`)
    expectSentenceAndDetail(message, 'secure.sakura.ad.jp')
    expect(splitFailureDetail(message).text).toContain('インターネットに接続できませんでした')
  })

  it('削除の途中で切れた: 済んだかは確かめられていないと言い、「もう一度」とは言わない', async () => {
    const dir = newProjectDir()
    setup(dir, { env: [A], resources: [] })
    const r = await teardownStorage({ storage: storage({ del: net.reset() }) as any, placement: { bucket: A, prefix: PREFIX, shared: true }, projectDir: dir })
    expect(r.ok).toBe(false)
    const message = (r as { message: string }).message
    expect(message).toContain(`保存場所『${A}』の削除に失敗しました`)
    expect(splitFailureDetail(message).text).toContain('操作が済んだかは確かめられていません')
    expectSentenceAndDetail(message, 'ECONNRESET')
  })
})

describe('鍵を無効にできなかった警告に案内を足す（keyWarningLines）', () => {
  it('警告が詳細の行を持つとき、案内は詳細の前に入り、詳細は最後の行', () => {
    const warning = `${KEY_REVOKE_FAILED_WARNING}: インターネットに接続できませんでした。\n詳細: getaddrinfo ENOTFOUND x`
    const [line] = keyWarningLines([warning], 'パネルで削除してください。')
    expect(line).toBe(`⚠️ ${KEY_REVOKE_FAILED_WARNING}: インターネットに接続できませんでした。パネルで削除してください。\n詳細: getaddrinfo ENOTFOUND x`)
  })
})

describe('レジストリの削除の確認（teardownRegistry）', () => {
  it('削除の要求を出したあとで切れた: 括弧の中は日本語の文、結びのあとに詳細', async () => {
    const client = {
      listContainerRegistries: async () => ({ dryRun: false as const, ok: true, status: 200, data: { CommonServiceItems: [{ ID: 'r1', Provider: { Class: 'containerregistry' }, Status: { registry_name: 'myreg' } }] } }),
      deleteContainerRegistry: async () => { throw net.reset() },
    }
    const r = await teardownRegistry(client as any, 'is1a', 'myreg')
    expect(r.deleteUnknown).toBe(true)
    const { text, detail } = splitFailureDetail(r.note!)
    expect(text.endsWith(registryCheckInPanelNote())).toBe(true)
    expect(text).toContain('削除できたか確認できませんでした')
    // 通信の失敗の文を括弧に入れない（同じことを2回言わない）。原文は詳細として最後の行に残る
    expect(text).toContain('一覧の取得または削除でエラーが発生')
    expect(text).not.toContain('操作が済んだかは確かめられていません')
    expect(detail).toContain('ECONNRESET')
  })

  it('一覧の取得で回線断: 削除は出していないので、読み取りの文（もう一度と言える）', async () => {
    const client = { listContainerRegistries: async () => { throw net.down() }, deleteContainerRegistry: async () => { throw new Error('呼ばれない') } }
    const r = await teardownRegistry(client as any, 'is1a', 'myreg')
    expect(r.deleteUnknown).toBeUndefined()
    expect(splitFailureDetail(r.note!).text).toContain('削除できたか確認できませんでした')
    expect(splitFailureDetail(r.note!).detail).toContain('secure.sakura.ad.jp')
  })
})

describe('ほかのプロジェクトが同じレジストリを使っているかの確認（親フォルダが読めない）', () => {
  it('EACCES: 日本語の文＋詳細。読めなかった親フォルダの原文が括弧の中に残らない', () => {
    const dir = newProjectDir()
    fs.mkdirSync(dir, { recursive: true })
    const ws = workspaceOf(dir)
    fs.chmodSync(ws, 0o311) // 開けるが一覧は読めない
    try {
      let thrown: Error | undefined
      try { otherProjectsUsingRegistry(dir, 'reg-1') } catch (e) { thrown = e as Error }
      expect(thrown).toBeDefined()
      const { text, detail } = splitFailureDetail(thrown!.message)
      expect(text).toContain('同じコンテナレジストリを使っていないか、確かめられませんでした')
      expect(text).not.toContain('EACCES')
      expect(detail).toContain('EACCES')
      expect(path.basename(ws).length).toBeGreaterThan(0)
    } finally {
      fs.chmodSync(ws, 0o755)
    }
  })
})
