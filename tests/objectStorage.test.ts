import { describe, it, expect } from 'vitest'
import {
  isValidBucketName, sharedBucketName, prefixForProject, resolvePlacement,
  objectKeyFor, teardownPlanFor, publicUrlFor, storageCostNote,
  keepMarkerKey, projectPrefixesFromKeys, foreignKeys, parseListResponse, decodeXmlEntities,
  storageEnvVars, containsSecretEnv, usesDataLayer, writesFilesDirectly, consentedBuckets, keepStorageFromDisk,
  type StoragePlacement,
} from '../src/shared/objectStorage'

// 2026-08-13。公開したアプリに永続データを持たせる（S-1）。
//
// **課金がバケット単位**なので既定は1つのバケットを共有し、プレフィックスで分ける。
// その結果「共有バケットを消してはいけない」という制約が生まれ、ここが守りになる。
// 消すと**他のプロジェクトのデータが道連れ**で消える。2026-08-06 に別プロジェクトの
// レジストリを削除した事故と、まったく同じ構造である（掟10）。

describe('バケット名の検査', () => {
  // さくらの仕様は先頭が英字（^[a-zA-Z]…）。Koto 既存の NAME_PATTERN は
  // 数字始まりを許すため、そのままではAPIに弾かれる
  it('数字で始まる名前を通さない', () => {
    expect(isValidBucketName('1myapp')).toBe(false)
    expect(isValidBucketName('9')).toBe(false)
  })

  it('英字で始まる小文字の名前を通す', () => {
    expect(isValidBucketName('koto-data-abc')).toBe(true)
    expect(isValidBucketName('abc')).toBe(true)
  })

  // 公開URLに出るので、環境で扱いの揺れる大文字は使わない
  it('大文字を通さない', () => {
    expect(isValidBucketName('Koto-Data')).toBe(false)
  })

  it('短すぎる・長すぎるものを通さない', () => {
    expect(isValidBucketName('ab')).toBe(false)
    expect(isValidBucketName('a' + 'b'.repeat(63))).toBe(false)
  })

  it('末尾のハイフンや連続ハイフンを通さない', () => {
    expect(isValidBucketName('koto-')).toBe(false)
    expect(isValidBucketName('koto--data')).toBe(false)
  })

  it('文字列でないものを通さない', () => {
    expect(isValidBucketName(undefined as unknown as string)).toBe(false)
    expect(isValidBucketName('')).toBe(false)
  })
})

describe('共有バケットの名前', () => {
  it('同じ利用者なら毎回同じ名前になる', () => {
    expect(sharedBucketName('key-abc')).toBe(sharedBucketName('key-abc'))
  })

  it('利用者が違えば違う名前になる（さくら全体で一意にする必要がある）', () => {
    expect(sharedBucketName('key-abc')).not.toBe(sharedBucketName('key-xyz'))
  })

  it('作った名前は必ずバケット名として使える', () => {
    for (const seed of ['key-abc', 'x', '', '日本語のキー', '9999']) {
      expect(isValidBucketName(sharedBucketName(seed))).toBe(true)
    }
  })

  // キーIDが公開URLに出ると、鍵の一部が人目に触れる
  it('seed をそのまま名前に出さない', () => {
    expect(sharedBucketName('SECRETKEY123')).not.toContain('SECRETKEY123')
  })
})

describe('プロジェクトごとの置き場所', () => {
  it('必ず / で終わる（隣のプロジェクトに届かないように）', () => {
    expect(prefixForProject('myapp')).toBe('projects/myapp/')
    expect(prefixForProject('My App')).toMatch(/\/$/)
  })

  it('使えない文字を落とす', () => {
    expect(prefixForProject('My App!')).toBe('projects/my-app/')
    expect(prefixForProject('../etc')).not.toContain('..')
  })

  it('名前が空でも壊れない', () => {
    expect(prefixForProject('')).toBe('projects/default/')
    expect(prefixForProject('!!!')).toBe('projects/default/')
  })

  // projects/my と projects/myapp が混ざらないこと
  it('前方一致で別プロジェクトに被らない', () => {
    expect(prefixForProject('my')).not.toBe(prefixForProject('myapp'))
    expect(prefixForProject('myapp').startsWith(prefixForProject('my'))).toBe(false)
  })
})

describe('共有と専用の切り替え', () => {
  it('既定は共有（費用を増やさない）', () => {
    const p = resolvePlacement({ projectName: 'myapp', sharedBucket: 'koto-data-x' })
    expect(p).toEqual({ bucket: 'koto-data-x', prefix: 'projects/myapp/', shared: true })
  })

  it('専用にするとバケットが分かれ、プレフィックスは無くなる', () => {
    const p = resolvePlacement({ projectName: 'myapp', mode: 'dedicated', sharedBucket: 'koto-data-x' })
    expect(p.shared).toBe(false)
    // 専用でもプレフィックスは使う（Koto の場所を明確にし、利用者のデータを巻き込まないため）
    expect(p.prefix).toBe('projects/myapp/')
    expect(p.bucket).not.toBe('koto-data-x')
    expect(isValidBucketName(p.bucket)).toBe(true)
  })
})

describe('オブジェクトのキー（プレフィックスの外へ出さない）', () => {
  const PRE = 'projects/myapp/'

  it('普通のパスは繋がる', () => {
    expect(objectKeyFor(PRE, 'data/posts.json')).toBe('projects/myapp/data/posts.json')
    expect(objectKeyFor(PRE, '/data/posts.json')).toBe('projects/myapp/data/posts.json')
  })

  // ここを許すと、共有バケットで他プロジェクトのデータを読み書きできる
  it('上位へ抜けるパスを拒む', () => {
    expect(objectKeyFor(PRE, '../other/secrets.json')).toBeNull()
    expect(objectKeyFor(PRE, 'a/../../other/x')).toBeNull()
    expect(objectKeyFor(PRE, '..')).toBeNull()
  })

  it('空・ヌル文字・URL を拒む', () => {
    expect(objectKeyFor(PRE, '')).toBeNull()
    expect(objectKeyFor(PRE, '/')).toBeNull()
    expect(objectKeyFor(PRE, 'a\0b')).toBeNull()
    expect(objectKeyFor(PRE, 'https://example.com/x')).toBeNull()
  })

  // 区切りが無いと projects/myappOTHER のような隣に届く
  it('プレフィックスが / で終わっていなければ拒む', () => {
    expect(objectKeyFor('projects/myapp', 'x.json')).toBeNull()
  })

  it('専用バケット（プレフィックス無し）でも使える', () => {
    expect(objectKeyFor('', 'posts.json')).toBe('posts.json')
  })
})

describe('破棄で何を消すか（★いちばん危ない判断）', () => {
  const shared: StoragePlacement = { bucket: 'koto-data-x', prefix: 'projects/myapp/', shared: true }
  const dedicated: StoragePlacement = { bucket: 'koto-myapp', prefix: 'projects/myapp/', shared: false }
  const MINE = ['projects/myapp/.koto-keep', 'projects/myapp/data/posts.json']
  const OTHERS = ['projects/other/.koto-keep', 'projects/another/.koto-keep']

  // ★ Ryosuke 指摘（2026-08-13）。利用者が自分でファイルを置いていることがある。
  // それを Koto が消しては絶対にいけない
  it('Koto が作ったのではないファイルがあれば、バケットを消さない', () => {
    const t = teardownPlanFor(shared, [...MINE, 'わたしの大事な資料.pdf'])
    expect(t.deleteBucket).toBe(false)
    expect(t.note).toContain('Koto が作ったのではない')
  })

  it('専用バケットでも、利用者のファイルがあれば消さない', () => {
    const t = teardownPlanFor(dedicated, [...MINE, 'backup/2026.zip'])
    expect(t.deleteBucket).toBe(false)
  })

  // 既存のバケットを利用者が指定した場合、中身は全部「利用者のもの」になる
  it('Koto の場所の外しか無いバケットは消さない', () => {
    expect(teardownPlanFor(dedicated, ['a.txt', 'b/c.txt']).deleteBucket).toBe(false)
  })

  it('ほかに使っているプロジェクトがあれば、共有バケットは消さない', () => {
    const t = teardownPlanFor(shared, [...MINE, ...OTHERS])
    expect(t.deleteBucket).toBe(false)
    expect(t.deletePrefix).toBe('projects/myapp/')
    expect(t.note).toContain('2件')
  })

  // 誰も使っていない共有バケットを残すと、月495円がかかり続ける
  it('自分だけなら、共有バケットも消せる', () => {
    const t = teardownPlanFor(shared, MINE)
    expect(t.deleteBucket).toBe(true)
    expect(t.note).toContain('課金')
  })

  it('専用バケットは、Koto の分だけなら消してよい', () => {
    const t = teardownPlanFor(dedicated, MINE)
    expect(t.deleteBucket).toBe(true)
    expect(t.note).toContain('失われ')
  })

  // 「利用者のデータあり」は「ほかのプロジェクトあり」より優先して伝える
  it('利用者のファイルの判定を、ほかのプロジェクトより先に見る', () => {
    const t = teardownPlanFor(shared, [...MINE, ...OTHERS, 'メモ.txt'])
    expect(t.deleteBucket).toBe(false)
    expect(t.note).toContain('Koto が作ったのではない')
  })

  it('どの場合も、このプロジェクトのデータは消す', () => {
    for (const keys of [MINE, [...MINE, ...OTHERS], [...MINE, 'x.txt'], []]) {
      expect(teardownPlanFor(shared, keys).deletePrefix).toBe('projects/myapp/')
    }
  })

  it('説明に Markdown 記法を混ぜない', () => {
    for (const keys of [MINE, [...MINE, ...OTHERS], [...MINE, 'x.txt']]) {
      for (const p of [shared, dedicated]) {
        expect(teardownPlanFor(p, keys).note).not.toMatch(/\*\*|__|`/)
      }
    }
  })
})

describe('Koto の場所の外にあるもの', () => {
  it('projects/ の外だけを拾う', () => {
    expect(foreignKeys(['projects/a/x', 'readme.txt', 'backup/y.zip']))
      .toEqual(['readme.txt', 'backup/y.zip'])
  })

  it('空文字は数えない', () => {
    expect(foreignKeys(['', 'projects/a/x'])).toEqual([])
    expect(foreignKeys(undefined as unknown as string[])).toEqual([])
  })

  // projectsData/ のような紛らわしい名前を「Koto のもの」と誤認しない
  it('前方一致の紛れに引っかからない', () => {
    expect(foreignKeys(['projectsData/x'])).toEqual(['projectsData/x'])
  })
})

describe('「まだ何も書いていないプロジェクト」を見落とさない', () => {
  // 一覧に出るのはオブジェクトが1つ以上あるプレフィックスだけ。用意しただけで
  // 何も書いていないプロジェクトは見えず、巻き込んで消してしまう
  it('用意した時点で目印を置く', () => {
    expect(keepMarkerKey('projects/myapp/')).toBe('projects/myapp/.koto-keep')
  })

  it('一覧のキーからプロジェクトのプレフィックスを取り出す', () => {
    expect(projectPrefixesFromKeys([
      'projects/myapp/data/posts.json',
      'projects/myapp/.koto-keep',
      'projects/other/.koto-keep',
    ])).toEqual(['projects/myapp/', 'projects/other/'])
  })

  // 人が手で置いたものを「プロジェクト」と数えると、消せるはずのバケットが残り続ける
  it('決まりに合わないキーは数えない', () => {
    expect(projectPrefixesFromKeys(['README.txt', 'projects/', 'foo/bar/baz'])).toEqual([])
  })

  it('空でも壊れない', () => {
    expect(projectPrefixesFromKeys([])).toEqual([])
    expect(projectPrefixesFromKeys(undefined as unknown as string[])).toEqual([])
  })
})

describe('公開URL', () => {
  it('組み立てられる', () => {
    expect(publicUrlFor('s3.isk01.sakurastorage.jp', 'b', 'projects/myapp/x.json'))
      .toBe('https://s3.isk01.sakurastorage.jp/b/projects/myapp/x.json')
  })

  it('エンドポイントに http:// が付いていても正しくなる', () => {
    expect(publicUrlFor('https://s3.isk01.sakurastorage.jp/', 'b', 'x'))
      .toBe('https://s3.isk01.sakurastorage.jp/b/x')
  })
})

describe('費用の説明', () => {
  it('専用は追加費用がかかると言う', () => {
    expect(storageCostNote('dedicated', 495)).toContain('495')
    expect(storageCostNote('dedicated', 495)).toContain('追加')
  })

  // 共有の弱点（鍵が漏れると他プロジェクトに届く）を隠さない
  it('共有は費用が増えないことと、その弱点の両方を言う', () => {
    const s = storageCostNote('shared', 495)
    expect(s).toContain('追加の費用はかかりません')
    expect(s).toContain('ほかのプロジェクトのデータにも届きます')
  })

  it('Markdown 記法を混ぜない', () => {
    for (const m of ['shared', 'dedicated'] as const) {
      expect(storageCostNote(m, 495)).not.toMatch(/\*\*|__|`/)
    }
  })
})

describe('一覧の応答を読む（読み違えると利用者のデータを消す）', () => {
  const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>${body}</ListBucketResult>`

  it('キーを取り出す', () => {
    const r = parseListResponse(xml('<Contents><Key>projects/a/x.json</Key></Contents><Contents><Key>readme.txt</Key></Contents>'))
    expect(r.keys).toEqual(['projects/a/x.json', 'readme.txt'])
  })

  // ここを見落とすと「他に何も無い」と誤判断してバケットごと消す
  it('途中で打ち切られていることを見落とさない', () => {
    const r = parseListResponse(xml('<IsTruncated>true</IsTruncated><NextContinuationToken>abc123</NextContinuationToken><Contents><Key>a</Key></Contents>'))
    expect(r.truncated).toBe(true)
    expect(r.nextToken).toBe('abc123')
  })

  it('打ち切られていなければ続きは無い', () => {
    const r = parseListResponse(xml('<IsTruncated>false</IsTruncated><Contents><Key>a</Key></Contents>'))
    expect(r.truncated).toBe(false)
    expect(r.nextToken).toBeNull()
  })

  it('空の応答でも壊れない', () => {
    expect(parseListResponse(xml(''))).toEqual({ keys: [], truncated: false, nextToken: null })
    expect(parseListResponse('')).toEqual({ keys: [], truncated: false, nextToken: null })
    expect(parseListResponse(undefined as unknown as string).keys).toEqual([])
  })

  it('実体参照を含むキーを正しく戻す', () => {
    const r = parseListResponse(xml('<Contents><Key>projects/a/a&amp;b.json</Key></Contents>'))
    expect(r.keys).toEqual(['projects/a/a&b.json'])
  })

  // &amp;lt; が < になってしまうと、別のキーに化ける
  it('二重解釈しない', () => {
    expect(decodeXmlEntities('a&amp;lt;b')).toBe('a&lt;b')
  })
})

describe('公開したアプリへ渡す環境変数', () => {
  const base = { bucket: 'koto-data-x', prefix: 'projects/myapp/', s3Endpoint: 's3.isk01.sakurastorage.jp', region: 'jp-north-1', accessKey: 'AKIAEXAMPLE' }

  it('アプリが読む値をすべて渡す', () => {
    const names = storageEnvVars(base).map(v => v.name)
    expect(names).toEqual([
      'KOTO_STORAGE_BUCKET', 'KOTO_STORAGE_ENDPOINT', 'KOTO_STORAGE_REGION',
      'KOTO_STORAGE_PREFIX', 'KOTO_STORAGE_ACCESS_KEY',
    ])
  })

  // ★ ここにシークレットが混ざると env.json に平文で保存され、
  //    GitHub保存や公開の経路に乗ってしまう
  it('シークレットを含めない', () => {
    expect(containsSecretEnv(storageEnvVars(base))).toBe(false)
    expect(storageEnvVars(base).some(v => /secret/i.test(v.name))).toBe(false)
  })

  it('エンドポイントは https:// を付けて正規化する', () => {
    expect(storageEnvVars({ ...base, s3Endpoint: 'https://s3.isk01.sakurastorage.jp/' })
      .find(v => v.name === 'KOTO_STORAGE_ENDPOINT')?.value)
      .toBe('https://s3.isk01.sakurastorage.jp')
  })

  it('秘密の混入を検出できる', () => {
    expect(containsSecretEnv([{ name: 'KOTO_STORAGE_SECRET_KEY', value: 'x' }])).toBe(true)
    expect(containsSecretEnv([{ name: 'my_secret', value: 'x' }])).toBe(true)
    expect(containsSecretEnv([])).toBe(false)
    expect(containsSecretEnv(undefined as unknown as { name: string; value: string }[])).toBe(false)
  })
})

describe('データ層を使っているかの検出', () => {
  it('import / require / 動的 import を拾う', () => {
    expect(usesDataLayer("import { save } from './koto-data.js'")).toBe(true)
    expect(usesDataLayer("import {save} from '../koto-data'")).toBe(true)
    expect(usesDataLayer("const d = require('./koto-data.js')")).toBe(true)
    expect(usesDataLayer("const d = await import('./koto-data.js')")).toBe(true)
  })

  it('関係ないコードを拾わない', () => {
    expect(usesDataLayer("import fs from 'node:fs'")).toBe(false)
    expect(usesDataLayer('// koto-data のことを書いただけのコメント')).toBe(false)
    expect(usesDataLayer('')).toBe(false)
    expect(usesDataLayer(undefined as unknown as string)).toBe(false)
  })
})

describe('自分でファイルに保存していないかの検出（静かに壊れる形）', () => {
  it('書き込みを拾う', () => {
    expect(writesFilesDirectly("import fs from 'node:fs'\nfs.writeFileSync('d.json', x)")).toBe(true)
    expect(writesFilesDirectly("await fs.promises.writeFile('d.json', x)")).toBe(true)
    expect(writesFilesDirectly("fs.appendFile('log.txt', x)")).toBe(true)
    expect(writesFilesDirectly("open('data.json', 'w')")).toBe(true)
  })

  // 読み取りは普通のこと。止めすぎない
  it('読み取りだけなら拾わない', () => {
    expect(writesFilesDirectly("import fs from 'node:fs'\nfs.readFileSync('config.json')")).toBe(false)
    expect(writesFilesDirectly("open('data.json', 'r')")).toBe(false)
    expect(writesFilesDirectly('')).toBe(false)
  })
})

// ── 費用の同意（2026-08-14 発覚）─────────────────────────────────────
// `defaultSpec` は長らく、**すべてのプロジェクトの env.json** に
// `{ bucket: '<名前>-data' }` を書いていた。apply に保存場所の操作が繋がって
// いない間は無害だったが、繋いだ瞬間に「公開しただけで月額495円のバケットが
// できる」に変わる。**費用は同意したときにだけ発生してよい。**
describe('同意していない保存場所は用意しない', () => {
  it('consentedAt が無いものは対象外（古い env.json はここで止まる）', () => {
    expect(consentedBuckets([{ bucket: 'myapp-data' }])).toEqual([])
  })

  it('consentedAt があるものだけを返す', () => {
    const list = [
      { bucket: 'old-data' },
      { bucket: 'koto-data-x', prefix: 'projects/x/', shared: true, consentedAt: '2026-08-14T00:00:00.000Z' },
    ]
    expect(consentedBuckets(list).map(b => b.bucket)).toEqual(['koto-data-x'])
  })

  it('空文字や空白だけの consentedAt は同意とみなさない', () => {
    expect(consentedBuckets([{ bucket: 'b', consentedAt: '' }])).toEqual([])
    expect(consentedBuckets([{ bucket: 'b', consentedAt: '   ' }])).toEqual([])
  })

  it('文字列でない consentedAt は同意とみなさない（壊れた env.json で課金しない）', () => {
    expect(consentedBuckets([{ bucket: 'b', consentedAt: true as any }])).toEqual([])
    expect(consentedBuckets([{ bucket: 'b', consentedAt: 1 as any }])).toEqual([])
  })

  it('バケット名が無いものは、同意があっても対象外', () => {
    expect(consentedBuckets([{ bucket: '', consentedAt: '2026-08-14' }])).toEqual([])
    expect(consentedBuckets([{ consentedAt: '2026-08-14' } as any])).toEqual([])
  })

  it('未定義・null でも落ちない', () => {
    expect(consentedBuckets(undefined)).toEqual([])
    expect(consentedBuckets(null)).toEqual([])
    expect(consentedBuckets([])).toEqual([])
  })

  it('元の配列を書き換えない（判断は読むだけ）', () => {
    const list = [{ bucket: 'b', consentedAt: '2026-08-14' }]
    consentedBuckets(list)
    expect(list).toEqual([{ bucket: 'b', consentedAt: '2026-08-14' }])
  })
})

// ── 画面からの上書きで記録を消させない（2026-08-14 実機で発覚）─────────────
// ③公開の画面は env.json を丸ごと書き戻す。その材料は**画面を開いた時点の写し**なので、
// 開いたあとに保存場所を用意しても入っていない。次にキーを選んだ瞬間に記録が消え、
// 公開しても鍵も環境変数も渡らない。**課金だけが残る、いちばん悪い形。**
describe('保存場所の記録を、古い写しで消させない', () => {
  const CONSENTED = { bucket: 'koto-data-x', prefix: 'projects/x/', shared: true, consentedAt: '2026-08-14T00:00:00.000Z' }

  it('★ 画面の写しが空でも、ディスクの記録を残す（これが実機で起きた）', () => {
    const incoming = { name: 'x', persistence: { objectStorage: [] } }
    const disk = { persistence: { objectStorage: [CONSENTED] } }
    expect(keepStorageFromDisk(incoming, disk).persistence.objectStorage).toEqual([CONSENTED])
  })

  it('保存場所以外は、画面の写しをそのまま通す', () => {
    const incoming = { name: 'x', auth: { keyId: 'k1' }, persistence: { objectStorage: [] } }
    const out = keepStorageFromDisk(incoming, { persistence: { objectStorage: [CONSENTED] } })
    expect(out.name).toBe('x')
    expect(out.auth).toEqual({ keyId: 'k1' })
  })

  it('ディスクに記録が無ければ、画面の写しのまま', () => {
    const incoming = { persistence: { objectStorage: [] } }
    expect(keepStorageFromDisk(incoming, { persistence: { objectStorage: [] } })).toEqual(incoming)
    expect(keepStorageFromDisk(incoming, null)).toEqual(incoming)
    expect(keepStorageFromDisk(incoming, undefined)).toEqual(incoming)
  })

  it('同意していない記録は残さない（古い env.json の既定値を蘇らせない）', () => {
    const incoming = { persistence: { objectStorage: [] } }
    const disk = { persistence: { objectStorage: [{ bucket: 'myapp-data' }] } }
    expect(keepStorageFromDisk(incoming, disk).persistence.objectStorage).toEqual([])
  })

  it('元のオブジェクトを書き換えない', () => {
    const incoming = { persistence: { objectStorage: [] } }
    keepStorageFromDisk(incoming, { persistence: { objectStorage: [CONSENTED] } })
    expect(incoming.persistence.objectStorage).toEqual([])
  })
})
