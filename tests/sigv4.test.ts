import { describe, it, expect } from 'vitest'
import { sigv4Authorization, canonicalQuery, sha256hex, amzDateOf } from '../src/shared/sigv4'

// 2026-08-12。さくらのオブジェクトストレージ（S3互換）を叩くための署名。
//
// **署名が違っても「403 SignatureDoesNotMatch」としか返らない。** キーが悪いのか、
// 権限が足りないのか、署名の組み立てが違うのか、実行した人には区別がつかない。
// 実キーが要る検証をユーザーに依頼する以上（掟4）、こちらで確かめられるところは
// 全部確かめてから渡す。
//
// 使うのは **AWS 公式ドキュメントのテストベクタ**（Signature Version 4 の
// "GET Object" の例）。既知の正解と一致すれば、組み立ては正しい。

const AWS_EXAMPLE = {
  accessKey: 'AKIAIOSFODNN7EXAMPLE',
  secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  amzDate: '20130524T000000Z',
  host: 'examplebucket.s3.amazonaws.com',
  emptyHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
}

describe('SigV4（AWS 公式のテストベクタと一致するか）', () => {
  it('x-amz-date の形式にできる', () => {
    expect(amzDateOf(new Date('2013-05-24T00:00:00.000Z'))).toBe('20130524T000000Z')
  })

  it('空文字の SHA256 が既知の値になる', () => {
    expect(sha256hex('')).toBe(AWS_EXAMPLE.emptyHash)
  })

  // AWS ドキュメント「Example: GET Object」の既知の正解
  it('GET Object の署名が公式の値と一致する', () => {
    const r = sigv4Authorization({
      method: 'GET',
      canonicalUri: '/test.txt',
      query: '',
      headers: {
        host: AWS_EXAMPLE.host,
        range: 'bytes=0-9',
        'x-amz-content-sha256': AWS_EXAMPLE.emptyHash,
        'x-amz-date': AWS_EXAMPLE.amzDate,
      },
      payloadHash: AWS_EXAMPLE.emptyHash,
      accessKey: AWS_EXAMPLE.accessKey,
      secretKey: AWS_EXAMPLE.secretKey,
      region: AWS_EXAMPLE.region,
      amzDate: AWS_EXAMPLE.amzDate,
    })
    expect(r.signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')
  })

  it('署名対象ヘッダは小文字・辞書順に並ぶ', () => {
    const r = sigv4Authorization({
      method: 'GET', canonicalUri: '/test.txt', headers: {
        'X-Amz-Date': AWS_EXAMPLE.amzDate, Host: AWS_EXAMPLE.host, Range: 'bytes=0-9',
        'x-amz-content-sha256': AWS_EXAMPLE.emptyHash,
      },
      payloadHash: AWS_EXAMPLE.emptyHash, accessKey: AWS_EXAMPLE.accessKey,
      secretKey: AWS_EXAMPLE.secretKey, region: AWS_EXAMPLE.region, amzDate: AWS_EXAMPLE.amzDate,
    })
    expect(r.signedHeaders).toBe('host;range;x-amz-content-sha256;x-amz-date')
    // 大文字で渡しても同じ署名になる（正規化できている証拠）
    expect(r.signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')
  })

  it('Authorization ヘッダの形が正しい', () => {
    const r = sigv4Authorization({
      method: 'GET', canonicalUri: '/test.txt',
      headers: { host: AWS_EXAMPLE.host, range: 'bytes=0-9', 'x-amz-content-sha256': AWS_EXAMPLE.emptyHash, 'x-amz-date': AWS_EXAMPLE.amzDate },
      payloadHash: AWS_EXAMPLE.emptyHash, accessKey: AWS_EXAMPLE.accessKey,
      secretKey: AWS_EXAMPLE.secretKey, region: AWS_EXAMPLE.region, amzDate: AWS_EXAMPLE.amzDate,
    })
    expect(r.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
      'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
      'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'
    )
  })

  // さくらは region が違う（jp-north-1）。scope に正しく入らないと弾かれる
  it('リージョンが変われば署名も変わる', () => {
    const base = {
      method: 'GET', canonicalUri: '/test.txt',
      headers: { host: AWS_EXAMPLE.host, range: 'bytes=0-9', 'x-amz-content-sha256': AWS_EXAMPLE.emptyHash, 'x-amz-date': AWS_EXAMPLE.amzDate },
      payloadHash: AWS_EXAMPLE.emptyHash, accessKey: AWS_EXAMPLE.accessKey,
      secretKey: AWS_EXAMPLE.secretKey, amzDate: AWS_EXAMPLE.amzDate,
    }
    const a = sigv4Authorization({ ...base, region: 'us-east-1' })
    const b = sigv4Authorization({ ...base, region: 'jp-north-1' })
    expect(b.signature).not.toBe(a.signature)
    expect(b.authorization).toContain('/jp-north-1/s3/aws4_request')
  })
})

// ── クエリの正規化（2026-08-14 実機で 403）─────────────────────────────
// 保存場所の中身を一覧できず「削除を中止しました（HTTP 403）」になった。
// 呼び出し側が URLSearchParams の結果をそのまま渡し、さらに末尾へ `=` を足していた。
//
// **署名が違っても 403 としか返らない**ので、ここで固定しておかないと、
// 次に壊れたときも原因の切り分けに実機と時間を使うことになる。
describe('クエリの正規化（SigV4 の canonical query string）', () => {
  it('名前で辞書順に並べる（URLSearchParams は並べ替えない）', () => {
    expect(canonicalQuery({ 'list-type': '2', 'max-keys': '1000', 'continuation-token': 'X' }))
      .toBe('continuation-token=X&list-type=2&max-keys=1000')
  })

  it('★ 末尾に余計な「=」を足さない（これが 403 の原因だった）', () => {
    expect(canonicalQuery({ 'list-type': '2' })).toBe('list-type=2')
    expect(canonicalQuery({ 'list-type': '2' })).not.toContain('2=')
  })

  it('値が空のときは「=」だけを付ける（acl のような旗）', () => {
    expect(canonicalQuery({ acl: '' })).toBe('acl=')
  })

  it('空白は + ではなく %20（RFC3986）', () => {
    expect(canonicalQuery({ prefix: 'my folder/' })).toBe('prefix=my%20folder%2F')
  })

  it("!'()* もエンコードする（encodeURIComponent は残す）", () => {
    expect(canonicalQuery({ k: "a!b'c(d)e*f" })).toBe('k=a%21b%27c%28d%29e%2Af')
  })

  it('日本語のプレフィックスも壊さない', () => {
    expect(canonicalQuery({ prefix: 'projects/日本語/' })).toBe('prefix=projects%2F%E6%97%A5%E6%9C%AC%E8%AA%9E%2F')
  })

  it('AWS 公式ベクタ get-vanilla-query-order-key-case と同じ並びになる', () => {
    // 同じ名前で値違いのときは値でも並べる（AWS の仕様）
    expect(canonicalQuery({ Param2: 'value2', Param1: 'value1' })).toBe('Param1=value1&Param2=value2')
  })

  it('空なら空文字（クエリ無しの呼び出しを壊さない）', () => {
    expect(canonicalQuery({})).toBe('')
  })
})
