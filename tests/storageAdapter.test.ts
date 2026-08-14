import { describe, it, expect } from 'vitest'
import { makeStorageAdapter, type StorageApiLike, type S3Like } from '../src/main/cloud/storageAdapter'
import type { StorageSite } from '../src/main/cloud/objectStorage'

// 2026-08-14。**ここが繋がっていなかった配線**（apply が保存場所に触れる手足）。
//
// 判断は shared/objectStorage.ts、いつ消すかは apply.ts にあるので、ここで確かめるのは
// 「手足として正しく動くか」だけ:
//   ・S3操作のための一時キーを**必要なときだけ**発行する
//   ・使い終わったら**必ず無効にする**（残すと、消したはずの保存場所へ届く鍵が生き続ける）
//   ・バケットを消す前に、そのバケットの鍵を先に片づける

const SITE: StorageSite = {
  id: 'isk01', display_name: '石狩第1サイト',
  s3_endpoint: 's3.isk01.sakurastorage.jp', region: 'jp-north-1', plan_family: 'standard',
}

function fakes() {
  const calls = {
    issued: [] as string[], deletedPermissions: [] as string[],
    created: [] as string[], deletedBuckets: [] as string[],
    puts: [] as string[], deletes: [] as string[], lists: [] as string[],
    order: [] as string[],
  }
  let n = 0
  const api: StorageApiLike = {
    async isSiteReady() { return true },
    async createBucket(_s, b) { calls.created.push(b); return { status: 200, text: '' } },
    async listBuckets() { return calls.created.map(name => ({ name })) },
    async deleteBucket(b) { calls.deletedBuckets.push(b); calls.order.push(`deleteBucket:${b}`) },
    async issueKey(_s, b, name) {
      n += 1
      calls.issued.push(`${b}/${name}`)
      return { accessKey: `AK${n}`, secretKey: `SK${n}`, permissionId: `perm-${n}` }
    },
    async deletePermission(_s, id) { calls.deletedPermissions.push(id); calls.order.push(`deletePermission:${id}`) },
  }
  const s3: S3Like = {
    async putObject(_a, b, k) { calls.puts.push(`${b}/${k}`) },
    async deleteObject(_a, b, k) { calls.deletes.push(`${b}/${k}`) },
    async listAllKeys(_a, b) { calls.lists.push(b); return ['projects/x/.koto-keep'] },
  }
  return { api, s3, calls }
}

describe('保存場所の手足（storageAdapter）', () => {
  it('S3を使わない操作では、鍵を発行しない', async () => {
    const { api, s3, calls } = fakes()
    const a = makeStorageAdapter(api, SITE, s3)
    await a.isSiteReady()
    await a.ensureBucket('koto-data-x')
    expect(calls.issued).toEqual([])
    await a.dispose()
    expect(calls.deletedPermissions).toEqual([])
  })

  it('S3を使う操作で鍵を発行し、同じバケットでは使い回す', async () => {
    const { api, s3, calls } = fakes()
    const a = makeStorageAdapter(api, SITE, s3)
    await a.listAllKeys('koto-data-x')
    await a.putMarker('koto-data-x', 'projects/x/.koto-keep')
    await a.deleteKeys('koto-data-x', ['projects/x/a.json', 'projects/x/b.json'])
    // 発行は1回だけ（毎回発行すると権限が溜まり、片づけ漏れの元になる）
    expect(calls.issued.length).toBe(1)
    expect(calls.deletes).toEqual(['koto-data-x/projects/x/a.json', 'koto-data-x/projects/x/b.json'])
  })

  // ★ ここが本丸。残した鍵は、消したはずの保存場所へ届き続ける
  it('dispose で、発行した鍵をすべて無効にする', async () => {
    const { api, s3, calls } = fakes()
    const a = makeStorageAdapter(api, SITE, s3)
    await a.listAllKeys('bucket-a')
    await a.listAllKeys('bucket-b')
    expect(calls.issued.length).toBe(2)
    await a.dispose()
    expect(calls.deletedPermissions.sort()).toEqual(['perm-1', 'perm-2'])
  })

  it('dispose は二度呼んでも二重に消さない', async () => {
    const { api, s3, calls } = fakes()
    const a = makeStorageAdapter(api, SITE, s3)
    await a.listAllKeys('bucket-a')
    await a.dispose()
    await a.dispose()
    expect(calls.deletedPermissions).toEqual(['perm-1'])
  })

  it('バケットを消す前に、そのバケットの鍵を片づける', async () => {
    const { api, s3, calls } = fakes()
    const a = makeStorageAdapter(api, SITE, s3)
    await a.listAllKeys('bucket-a')
    await a.deleteBucket('bucket-a')
    expect(calls.order).toEqual(['deletePermission:perm-1', 'deleteBucket:bucket-a'])
    // 片づけ済みなので、dispose で二重に消さない
    await a.dispose()
    expect(calls.deletedPermissions).toEqual(['perm-1'])
  })

  it('鍵の片づけに失敗しても、公開や破棄は失敗にしない', async () => {
    const { api, s3, calls } = fakes()
    api.deletePermission = async () => { throw new Error('通信できません') }
    const a = makeStorageAdapter(api, SITE, s3)
    await a.listAllKeys('bucket-a')
    await expect(a.dispose()).resolves.toBeUndefined()
    expect(calls.lists).toEqual(['bucket-a'])
  })

  it('アプリに渡すエンドポイントは、選んだサイトのもの', () => {
    const { api, s3 } = fakes()
    const a = makeStorageAdapter(api, SITE, s3)
    expect(a.siteInfo()).toEqual({ s3Endpoint: 's3.isk01.sakurastorage.jp', region: 'jp-north-1' })
  })
})

// 2026-08-14 実機。バケットを作った直後に目印を書こうとして `403 AccessDenied`。
// **発行したばかりの鍵は、すぐには効かないことがある。**
describe('発行したての鍵が効くまで待つ', () => {
  /** 待ち時間は 0 にする（確かめたいのは回数と打ち切りであって、実時間ではない）。 */
  const quick = (api: StorageApiLike, s3: S3Like) => makeStorageAdapter(api, SITE, s3, [0, 0, 0])

  it('403 なら少し待って試し直す', async () => {
    const { api, s3, calls } = fakes()
    let attempts = 0
    s3.putObject = async () => {
      attempts++
      if (attempts < 3) throw new Error('保存できませんでした（HTTP 403）: AccessDenied')
    }
    const a = quick(api, s3)
    await a.putMarker('b', 'projects/x/.koto-keep')
    expect(attempts).toBe(3)
    // 鍵の発行は1回だけ（毎回発行すると権限が溜まる）
    expect(calls.issued.length).toBe(1)
  })

  // **何度でも粘るのは違う。** 本当に権限が無いときに、ただ遅くなるだけになる
  it('待っても直らなければ、あきらめて理由を伝える', async () => {
    const { api, s3 } = fakes()
    let attempts = 0
    s3.listAllKeys = async () => { attempts++; throw new Error('中身を確認できませんでした（HTTP 403）') }
    const a = quick(api, s3)
    await expect(a.listAllKeys('b')).rejects.toThrow('403')
    expect(attempts).toBeLessThanOrEqual(4) // 初回＋3回まで
    expect(attempts).toBeGreaterThan(1)
  })

  // 403 以外は待っても直らない。すぐ返す
  it('403 でなければ、待たずにそのまま返す', async () => {
    const { api, s3 } = fakes()
    let attempts = 0
    s3.putObject = async () => { attempts++; throw new Error('保存できませんでした（HTTP 500）') }
    const a = quick(api, s3)
    await expect(a.putMarker('b', 'k')).rejects.toThrow('500')
    expect(attempts).toBe(1)
  })
})

// 2026-08-14。同じ名前の保存場所を削除した直後に作り直すと、作成APIが 409 を返し、
// それを「もうあるので大丈夫」と読んでいた。**実際には作られておらず**、
// あとで書き込むと 403 AccessDenied。原因の分からないエラーだけが残る。
describe('作れたと決めつけない', () => {
  it('作ったあと、一覧に出ることを確かめる', async () => {
    const { api, s3, calls } = fakes()
    const a = makeStorageAdapter(api, SITE, s3)
    await a.ensureBucket('koto-data-x')
    expect(calls.created).toEqual(['koto-data-x'])
  })

  it('★ 一覧に出なければ、その場で止めて理由を伝える', async () => {
    const { api, s3 } = fakes()
    api.createBucket = async () => ({ status: 409, text: 'Conflict' }) // 409 を「成功」と読んだ状態を再現
    api.listBuckets = async () => []
    const a = makeStorageAdapter(api, SITE, s3)
    await expect(a.ensureBucket('koto-data-x')).rejects.toThrow('一覧に現れません')
    // 次に何をすればよいかを添える
    await expect(a.ensureBucket('koto-data-x')).rejects.toThrow('別の名前')
    // **応答をそのまま添える**（これが無いと次も原因が分からない）
    await expect(a.ensureBucket('koto-data-x')).rejects.toThrow('HTTP 409')
  })

  it('ほかの保存場所があっても、目的のものが無ければ止める', async () => {
    const { api, s3 } = fakes()
    api.createBucket = async () => ({ status: 409, text: '' })
    api.listBuckets = async () => [{ name: 'よその保存場所' }]
    const a = makeStorageAdapter(api, SITE, s3)
    await expect(a.ensureBucket('koto-data-x')).rejects.toThrow('一覧に現れません')
  })
})
