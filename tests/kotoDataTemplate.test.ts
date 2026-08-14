import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sigv4Authorization, canonicalQuery, sha256hex, amzDateOf } from '../src/shared/sigv4'

// 2026-08-13。templates/koto-data.js は**利用者のプロジェクトに置かれる**ため、
// Koto 本体の src/shared/sigv4.ts を import できない。署名の実装が重複する。
//
// **重複を放置すると片方だけ直され、しかも署名の食い違いは 403 としか出ない**
// （掟10）。だからここで「両方が同じ署名を出すこと」を確かめる。
// 片方を直したらこのテストが落ちる。

const TEMPLATE = path.resolve(__dirname, '../templates/koto-data.js')

const ENV = {
  KOTO_STORAGE_BUCKET: 'koto-data-x',
  KOTO_STORAGE_ENDPOINT: 'https://s3.isk01.sakurastorage.jp',
  KOTO_STORAGE_REGION: 'jp-north-1',
  KOTO_STORAGE_PREFIX: 'projects/myapp/',
  KOTO_STORAGE_ACCESS_KEY: 'AKIAIOSFODNN7EXAMPLE',
  KOTO_STORAGE_SECRET_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
}

let saved: Record<string, string | undefined> = {}
function setEnv(env: Record<string, string>) {
  saved = {}
  for (const k of Object.keys(ENV)) { saved[k] = process.env[k]; delete process.env[k] }
  for (const [k, v] of Object.entries(env)) process.env[k] = v
}
function restoreEnv() {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
}

afterEach(() => { restoreEnv(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules() })

describe('署名が Koto 本体と一致する（食い違うと 403 しか出ない）', () => {
  it('保存のときの Authorization ヘッダが、本体の計算と同じになる', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-13T00:00:00.000Z'))
    setEnv(ENV)

    let captured: { url: string; headers: Record<string, string>; body: string } | null = null
    vi.stubGlobal('fetch', async (url: string, init: any) => {
      captured = { url, headers: init.headers, body: init.body }
      return { ok: true, status: 200, text: async () => '' }
    })

    vi.resetModules()
    const mod = await import(TEMPLATE)
    await mod.save('entries', { id: 'fixed-id', createdAt: '2026-08-13T00:00:00.000Z', name: '山田' })

    expect(captured).not.toBeNull()
    const c = captured as unknown as { url: string; headers: Record<string, string>; body: string }

    // 本体の実装で同じ署名を計算する
    const amzDate = amzDateOf(new Date('2026-08-13T00:00:00.000Z'))
    const payloadHash = sha256hex(c.body)
    const expected = sigv4Authorization({
      method: 'PUT',
      canonicalUri: '/koto-data-x/projects/myapp/entries/fixed-id.json',
      query: '',
      headers: {
        host: 's3.isk01.sakurastorage.jp',
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        'content-type': 'application/json',
      },
      payloadHash,
      accessKey: ENV.KOTO_STORAGE_ACCESS_KEY,
      secretKey: ENV.KOTO_STORAGE_SECRET_KEY,
      region: ENV.KOTO_STORAGE_REGION,
      amzDate,
    })

    expect(c.headers.Authorization).toBe(expected.authorization)
    expect(c.url).toBe('https://s3.isk01.sakurastorage.jp/koto-data-x/projects/myapp/entries/fixed-id.json')
  })
})

describe('手元で試すとき（環境変数が無い）', () => {
  let dir = ''
  let cwd = ''

  beforeEach(() => {
    cwd = process.cwd()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-data-test-'))
    process.chdir(dir)
    setEnv({})
  })
  afterEach(() => { process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true }) })

  // ★ 環境変数が無いと動かない、では「試す」が壊れる
  it('環境変数が無くても保存・読み出しができる', async () => {
    vi.resetModules()
    const mod = await import(TEMPLATE)
    expect(mod.storageMode()).toBe('local')

    const saved = await mod.save('entries', { name: '山田' })
    expect(saved.id).toBeTruthy()
    expect(await mod.get('entries', saved.id)).toMatchObject({ name: '山田' })
    expect(await mod.list('entries')).toHaveLength(1)

    await mod.remove('entries', saved.id)
    expect(await mod.list('entries')).toHaveLength(0)
    expect(await mod.get('entries', saved.id)).toBeNull()
  })

  // 1件1ファイルにしないと、2人同時の送信で片方が消える
  it('1件を1ファイルとして保存する', async () => {
    vi.resetModules()
    const mod = await import(TEMPLATE)
    await mod.save('entries', { name: 'A' })
    await mod.save('entries', { name: 'B' })
    const files = fs.readdirSync(path.join(dir, '.koto-data', 'entries'))
    expect(files).toHaveLength(2)
  })

  it('新しい順に返す', async () => {
    vi.resetModules()
    const mod = await import(TEMPLATE)
    await mod.save('entries', { name: '古い', createdAt: '2026-01-01T00:00:00.000Z' })
    await mod.save('entries', { name: '新しい', createdAt: '2026-08-01T00:00:00.000Z' })
    expect((await mod.list('entries')).map((r: any) => r.name)).toEqual(['新しい', '古い'])
  })

  it('まだ何も無いコレクションでも壊れない', async () => {
    vi.resetModules()
    const mod = await import(TEMPLATE)
    expect(await mod.list('nothing')).toEqual([])
    expect(await mod.get('nothing', 'x')).toBeNull()
    await mod.remove('nothing', 'x')
  })

  // 名前に / や .. を許すと、別の場所へ書けてしまう
  it('コレクション名やIDで別の場所へ書けない', async () => {
    vi.resetModules()
    const mod = await import(TEMPLATE)
    await expect(mod.save('../../etc', { a: 1 })).rejects.toThrow()
    await expect(mod.get('a/b', 'x')).rejects.toThrow()
    await expect(mod.save('', { a: 1 })).rejects.toThrow()
  })
})

// 2026-08-14。**クエリの正規化も重複している。** 本体側は今日 403 で直したが、
// テンプレートは `URLSearchParams.toString()` のままだった。
// 1ページ目はたまたま辞書順に並ぶので、少ないデータでは表に出ない
// ——**データが1000件を超えた日に、突然一覧が壊れる**形だった。
describe('テンプレートのクエリ正規化が、本体と一致する', () => {
  const source = fs.readFileSync(TEMPLATE, 'utf-8')
  const fn = (() => {
    const m = /function canonicalQuery\(params\) \{[\s\S]*?\n\}/.exec(source)
    if (!m) throw new Error('テンプレートに canonicalQuery がありません')
    return new Function(`${m[0]}; return canonicalQuery`)() as (p: Record<string, string>) => string
  })()

  const CASES: Record<string, string>[] = [
    { 'list-type': '2', 'max-keys': '1000', prefix: 'projects/x/' },
    // ★ 2ページ目。並べ替えないと、ここで初めて 403 になる
    { 'list-type': '2', 'max-keys': '1000', prefix: 'projects/x/', 'continuation-token': 'a b+c' },
    { acl: '' },
    { prefix: 'projects/日本語/' },
  ]

  for (const [i, c] of CASES.entries()) {
    it(`同じ文字列を作る（${i + 1}）`, () => {
      expect(fn(c)).toBe(canonicalQuery(c))
    })
  }

  it('URLSearchParams をそのまま使っていない（並べ替えないため）', () => {
    expect(source).not.toMatch(/new URLSearchParams\([^)]*\)[\s\S]{0,120}?\.toString\(\)/)
  })
})
