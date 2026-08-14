import { describe, it, expect } from 'vitest'
import { buildS3Request } from '../src/main/cloud/objectStorage'
import { canonicalQuery } from '../src/shared/sigv4'

// 2026-08-14。「保存場所の中身を確認できないため、削除を中止しました（HTTP 403）」。
//
// 署名に使う文字列と、実際に投げる URL が食い違っていた。**別々に組み立てていたから。**
// ここでは「同じ材料から作られていること」を確かめる。

const HOST = 's3.isk01.sakurastorage.jp'

describe('S3 の呼び出しの組み立て', () => {
  it('キー無しの一覧は、バケットまでのパスになる', () => {
    const r = buildS3Request({ host: HOST, bucket: 'koto-data-x', query: { 'list-type': '2' } })
    expect(r.canonicalUri).toBe('/koto-data-x')
    expect(r.url).toBe(`https://${HOST}/koto-data-x?list-type=2`)
  })

  it('オブジェクトのキーはパスに繋がる', () => {
    const r = buildS3Request({ host: HOST, bucket: 'koto-data-x', key: 'projects/x/a.json' })
    expect(r.canonicalUri).toBe('/koto-data-x/projects/x/a.json')
    expect(r.query).toBe('')
    expect(r.url).toBe(`https://${HOST}/koto-data-x/projects/x/a.json`)
  })

  // ★ ここが本丸。URL と署名が同じ文字列を使っていること
  it('URL のクエリと、署名に使うクエリが一致する', () => {
    const query = { 'list-type': '2', 'max-keys': '1000', 'continuation-token': 'a b+c' }
    const r = buildS3Request({ host: HOST, bucket: 'b', query })
    expect(r.query).toBe(canonicalQuery(query))
    expect(r.url.endsWith('?' + r.query)).toBe(true)
    // 並べ替えとエンコードが効いていること
    expect(r.query).toBe('continuation-token=a%20b%2Bc&list-type=2&max-keys=1000')
  })

  it('クエリが無ければ ? を付けない', () => {
    expect(buildS3Request({ host: HOST, bucket: 'b', key: 'k' }).url).not.toContain('?')
  })

  it('先頭のスラッシュが重ならない', () => {
    expect(buildS3Request({ host: HOST, bucket: 'b', key: '/k' }).canonicalUri).toBe('/b/k')
  })
})
