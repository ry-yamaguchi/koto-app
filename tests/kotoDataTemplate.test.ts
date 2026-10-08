import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { sigv4Authorization, canonicalQuery, sha256hex, amzDateOf } from '../src/shared/sigv4'
// 保存先のフォルダ名は定数を参照する（文字列を2か所に書かない・掟10）。
import { DATA_LAYER_LOCAL_DIR } from '../src/shared/objectStorage'

// 2026-08-13。templates/koto-data.js は**利用者のプロジェクトに置かれる**ため、
// Koto 本体の src/shared/sigv4.ts を import できない。署名の実装が重複する。
//
// **重複を放置すると片方だけ直され、しかも署名の食い違いは 403 としか出ない**
// （掟10）。だからここで「両方が同じ署名を出すこと」を確かめる。
// 片方を直したらこのテストが落ちる。

const TEMPLATE = path.resolve(__dirname, '../templates/koto-data.js')

// ── require 版（2026-09-23 実機・アプリが起動しなくなった）────────────────
// koto-data.js は import だけを使う形で書かれている。require で動いている
// アプリはこれを読み込めないので、AI は読み込めるようにしようと
// package.json に "type": "module" を足し、**アプリ全体が起動しなくなった**。
// koto-data.cjs は、その require 版である。**振る舞いは同じでなければならない。**
// 片方だけ直されると、どちらのアプリで起きた不具合かで話が食い違う（掟10）。
const TEMPLATE_CJS = path.resolve(__dirname, '../templates/koto-data.cjs')

/**
 * 2つのテンプレートを同じ形で読み込む。
 *
 * **署名の計算は3つ目の写しになった**（本体 src/shared/sigv4.ts ／ import 版 ／
 * require 版）。一致を確かめるテストが import 版にしか無いと、将来この署名を
 * 直した人が2か所しか直さず、**require のアプリだけ公開後の保存が 403 で失敗する**
 * （403 は画面から原因が読めず、利用者には「保存できない」としか見えない）。
 * だから署名のテストは**両方に流す**（2026-09-23 検分）。
 */
const LOADERS: { label: string; load: () => Promise<Record<string, any>> }[] = [
  {
    label: 'import 版 koto-data.js',
    load: async () => { vi.resetModules(); return await import(TEMPLATE) as Record<string, any> },
  },
  {
    label: 'require 版 koto-data.cjs',
    load: async () => {
      const req = createRequire(import.meta.url)
      delete req.cache[TEMPLATE_CJS] // 毎回読み直す（env と cwd を見て決めるものがある）
      return req(TEMPLATE_CJS) as Record<string, any>
    },
  },
]

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

describe.each(LOADERS)('署名が Koto 本体と一致する（食い違うと 403 しか出ない）: $label', ({ load }) => {
  it('保存のときの Authorization ヘッダが、本体の計算と同じになる', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-13T00:00:00.000Z'))
    setEnv(ENV)

    let captured: { url: string; headers: Record<string, string>; body: string } | null = null
    vi.stubGlobal('fetch', async (url: string, init: any) => {
      captured = { url, headers: init.headers, body: init.body }
      return { ok: true, status: 200, text: async () => '' }
    })

    const mod = await load()
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
    const files = fs.readdirSync(path.join(dir, DATA_LAYER_LOCAL_DIR, 'entries'))
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
// **require 版にも同じ写しがある**ので、両方に流す（2026-09-23 検分。片方しか
// 縛られていないと、直した人が2か所しか直さず require 版だけ 403 になる）。
describe.each([
  { label: 'import 版 koto-data.js', file: TEMPLATE },
  { label: 'require 版 koto-data.cjs', file: TEMPLATE_CJS },
])('テンプレートのクエリ正規化が、本体と一致する: $label', ({ file }) => {
  const source = fs.readFileSync(file, 'utf-8')
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

// ── require を使うアプリ向けの版（2026-09-23 実機・アプリが起動しなくなった）──
// 読み込みの作法は上の LOADERS に一本化してある（二重定義を作らない）。
describe('require を使うアプリ向けの版（koto-data.cjs）', () => {
  const requireCjs = () => {
    const req = createRequire(import.meta.url)
    delete req.cache[TEMPLATE_CJS] // 毎回読み直す（env と cwd を見て決めるものがある）
    return req(TEMPLATE_CJS) as Record<string, unknown>
  }

  // ★ 実際に Node が読み込めること。読み込めなければ、置いても無意味
  it('Node が読み込める（require できる）', () => {
    expect(() => requireCjs()).not.toThrow()
  })

  // ★ 使う側の書き方が同じであること
  it('import 版と同じ関数を公開している', async () => {
    const cjs = requireCjs()
    const esm = await import(TEMPLATE)
    const names = ['list', 'get', 'save', 'remove', 'storageMode']
    for (const n of names) {
      expect(typeof cjs[n], `${n} が require 版に無い`).toBe('function')
      expect(typeof (esm as Record<string, unknown>)[n], `${n} が import 版に無い`).toBe('function')
    }
    // import 版が増えたのに require 版に足し忘れる、を捕まえる
    const exported = Object.keys(esm).filter(k => k !== 'default')
    expect([...exported].sort()).toEqual([...names].sort())
  })

  it('読み込み方の案内も require の形で書いてある（利用者が読む文）', () => {
    const source = fs.readFileSync(TEMPLATE_CJS, 'utf-8')
    expect(source).toContain("const { list, get, save, remove } = require('./koto-data.cjs')")
    // import の案内が残っていると、そのとおりに書いて動かない
    expect(source).not.toContain("import { list, get, save, remove } from './koto-data.js'")
    expect(source).toContain('module.exports')
  })

  // ★ 振る舞いが同じであること。手元では .koto-data/ に1件1ファイルで保存する
  it('手元での保存・一覧・取得・削除が、import 版と同じように動く', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-cjs-'))
    const spy = vi.spyOn(process, 'cwd').mockReturnValue(tmp)
    try {
      const { save, list, get, remove, storageMode } = requireCjs() as {
        save: (c: string, d: unknown) => Promise<{ id: string }>
        list: (c: string) => Promise<unknown[]>
        get: (c: string, id: string) => Promise<unknown>
        remove: (c: string, id: string) => Promise<void>
        storageMode: () => string
      }
      expect(storageMode()).toBe('local') // 鍵が無いので手元のフォルダ
      const saved = await save('entries', { name: '山田' })
      expect(saved.id).toBeTruthy()
      expect(fs.existsSync(path.join(tmp, DATA_LAYER_LOCAL_DIR, 'entries', `${saved.id}.json`))).toBe(true)
      expect(await list('entries')).toHaveLength(1)
      expect(await get('entries', saved.id)).toMatchObject({ name: '山田' })
      await remove('entries', saved.id)
      expect(await list('entries')).toEqual([])
      expect(await get('entries', saved.id)).toBeNull()
    } finally {
      spy.mockRestore()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  // ★ 保存先の名前の検査（`../../etc` を黙って書き換えない）も同じであること
  it('おかしな保存先の名前は、import 版と同じように断る', async () => {
    const { save } = requireCjs() as { save: (c: string, d: unknown) => Promise<unknown> }
    await expect(save('../../etc', { a: 1 })).rejects.toThrow('保存先の名前')
  })
})

// ── 説明文が事実と合っているか（2026-09-24）────────────────────────────────
// 2026-09-23、Koto が AI に「koto-data.js が無ければ用意します」と**守れない約束**をして
// いたために、AI が辻褄を合わせようとして利用者のアプリを起動不能にした。
// その教訓で `docs/storage-options.md` の調査を行ったところ、**このテンプレート自身にも
// 同じ形の記述が2つ**あった:
//
//   ①「数千件を超えると一覧の取得が遅くなります」… 約1桁楽観的（実際は数百件）
//   ②「検索や集計が必要になったらデータベースに変えたいと伝えてください」
//      … 公開している4つの口に絞り込み・並べ替え・件数の指定が**1つも無い**ので、
//        データベースに替えても list() は全件を返すまま。**検索はできない。**
//
// 直したうえで、**書き戻されないように**ここで固定する。
// このファイルは**利用者のプロジェクトへ置かれる**ので、嘘が一番遠くまで届く。
describe('テンプレートの説明文が、実物と食い違わない', () => {
  const bodies = () => [
    ['koto-data.js', fs.readFileSync(TEMPLATE, 'utf-8')],
    ['koto-data.cjs', fs.readFileSync(TEMPLATE.replace(/\.js$/, '.cjs'), 'utf-8')],
  ] as const

  // ★ 2026-09-25 まで、ここは `src.indexOf('import ')` で窓を切っていた。当て先は
  //   本物の import 文ではなく**冒頭の使い方の例**（11行目の
  //   `//   import { list, get, save, remove } from './koto-data.js'`）に当たり、
  //   .js 側は**先頭289文字＝冒頭11行**しか見ていなかった。説明文の本体（件数の目安・
  //   守れない約束）は一度も見ていない。.cjs には `import ` が無いので -1 になり、
  //   こちらだけ意図どおり4000文字を見ていた。**窓を当てずにファイル全体を見る。**
  it('★ 「数千件」と書かない（実際の境目は数百件）', () => {
    for (const [name, src] of bodies()) {
      expect(src, name).not.toMatch(/数千件/)
    }
  })

  it('★ 件数の目安を数字で書いてある（読んだ人が自分で判断できる）', () => {
    for (const [name, src] of bodies()) {
      expect(src, name).toContain('200件')
      expect(src, name).toContain('1,000件')
    }
  })

  // ★ 2026-09-25 まで、ここは `src.slice(0, 4000)` で窓を切っていた。**文字数で切った窓は、
  //   冒頭の説明が伸びるたびに効き目が縮む。** 実際、上の指摘を直して冒頭を約470文字
  //   伸ばしたところ、`（tests/kotoDataTemplate.test.ts が固定しています）。` の位置が
  //   3,632文字目から 4,102文字目（**窓の外**）へ動き、その行の直後に
  //   「検索や集計が必要になったらデータベースに変えたい」と書き足しても**30件すべて緑**に
  //   なった。**窓を切らず、ファイル全体を見る**（禁止語のチェックと同じ形にそろえた）。
  it('★ 「データベースに変えれば検索できる」と読める書き方をしない', () => {
    for (const [name, src] of bodies()) {
      // 「検索」と「データベースに変えたい」が同じ勧めとして並んでいないこと
      expect(src, name).not.toMatch(/検索や集計[^。]*データベースに変えたい/)
    }
  })

  // 2026-09-25 の検分。速い道の skip は「読み飛ばす分も実際に読む」形になり、
  // **通信の回数が skip に比例する**ようになった（`{ limit: 20, skip: 980 }` は 1,001回で
  // 全件読みと変わらない）。冒頭の説明が「limit と skip を指定すれば減る」のままだと、
  // このファイル自身が掲げる「守れない約束を書かないこと」に背く。
  // **回数そのものは tests/kotoDataOptions.test.ts が偽サーバで数えて固定している**ので、
  // ここで見るのは「利用者と AI が読む文に、その事実が書いてあるか」だけ。
  // ★ 説明は**2か所**にある（冒頭の「件数の目安」と、list() のすぐ上）。どちらも
  //   別々に当てる——片方だけを見る書き方にすると、もう片方が古いまま残っても緑になる
  //   （実際、当て先が2か所に出る書き方にしたせいで、冒頭を書き換える変異が素通りした）。
  it('★ skip を付けると読み飛ばす分も読みに行くことを、2か所とも回数つきで書いてある', () => {
    for (const [name, src] of bodies()) {
      // ① 冒頭の「件数の目安」（利用者が最初に読むところ）
      expect(src, `${name}: 冒頭`).toMatch(/skip を付けると、読み飛ばす分も実際に読みに行きます/)
      expect(src, `${name}: 冒頭の回数`).toMatch(/list\('entries', \{ limit: 20, skip: 980 \}\)[^\n]*1,001回/)
      expect(src, `${name}: 冒頭`).toMatch(/ページを送るほど遅くなります/)
      // ② list() の説明（アプリを作る AI が関数のそばで読むところ）
      expect(src, `${name}: list() の説明`).toMatch(/skip は、読み飛ばす分も実際に読みに行きます/)
      expect(src, `${name}: list() の説明の回数`).toMatch(/`\{ limit: 20, skip: 980 \}` は 1,001回/)
      // 読みに行く回数が skip に比例すること（回数そのものは kotoDataOptions が偽サーバで数える）
      expect(src, name).toMatch(/skip ＋ limit/)
      // ★ 直す前の約束（skip も通信を減らす）が戻ってきたら落ちる
      expect(src, name).not.toMatch(/skip も通信を減らします/)
      expect(src, name).not.toMatch(/skip を付けても速いまま/)
    }
  })

  // 2026-09-24。list() に limit / skip / where / sort を足したので、
  // 「絞り込みはできません」はもう事実ではなくなった。**だが通信は減らない。**
  // ここを曖昧にすると「絞り込めば速くなる」という、新しい守れない約束になる
  // （減るのは limit と skip のときだけで、しかも条件がある）。
  it('★ 絞り込み（where）と並べ替え（sort）が通信を減らさないことを、はっきり書いてある', () => {
    for (const [name, src] of bodies()) {
      expect(src, name).toContain('**通信の回数が減るのは、limit（と skip）を指定したときだけです。**')
      expect(src, name).toContain('**検索・絞り込み（where）と並べ替え（sort）は、通信を減らしません。**')
    }
  })

  // ★ 直す前の説明（もう事実でない）が戻ってきたら落ちる
  it('★ 「絞り込み・件数の指定はできません」という古い説明が残っていない', () => {
    for (const [name, src] of bodies()) {
      expect(src, name).not.toContain('絞り込み・並べ替えの指定・件数の指定はできません')
      expect(src, name).not.toContain('list() は毎回すべてを返します')
    }
  })

  // ★ 「同時に書いても壊れない」は守れない約束だった（版は検知であって防止ではない）
  it('★ 「同時に書いても壊れない」と書いていない', () => {
    for (const [name, src] of bodies()) {
      expect(src, name).not.toContain('同時に書いても壊れない')
      expect(src, name).toContain('防止ではありません')
    }
  })

  it('★ 約束を取り消した理由が残っている（次に読む人が戻さないように）', () => {
    for (const [name, src] of bodies()) {
      expect(src, name).toContain('守れない約束')
    }
  })

  // ★ 2026-09-25 まで、ここは `件数の目安 … 守れない約束` の**一部分だけ**を切り出して
  //   比べていた。切り出した外で説明が食い違っても、誰も気づかない。
  //   いまは**冒頭の説明を丸ごと**突き合わせ、食い違ってよいのは
  //   「読み込み方」（1行目のファイル名・使い方の1行・読み込みの3行）と、
  //   cjs にしかない「このファイルと koto-data.js の違い」の節だけにする。
  it('import 版と require 版で、説明文が食い違わない', () => {
    const [[, js], [, cjs]] = bodies()
    // 本体が始まる手前まで＝説明文の全部（文字数で窓を切らない）
    const headOf = (s: string, label: string) => {
      const end = s.indexOf('const BUCKET =')
      expect(end, `${label} に const BUCKET = がありません`).toBeGreaterThan(0)
      return s.slice(0, end)
    }
    const jsHead = headOf(js, 'koto-data.js')
    const cjsHeadRaw = headOf(cjs, 'koto-data.cjs')
    expect(cjsHeadRaw).toContain('── このファイルと koto-data.js の違い')
    const cjsHead = cjsHeadRaw.replace(/^\/\/ ── このファイルと koto-data\.js の違い[\s\S]*?\n\/\/\n/m, '')
    expect(cjsHead, 'cjs だけの節を取り除けていない').not.toContain('── このファイルと koto-data.js の違い')

    /** 読み込み方だけを落とす（ここだけは違ってよい）。 */
    const norm = (s: string) => s
      .replace(/^\/\/ koto-data\.(js|cjs) — [^\n]*\n/m, '')
      .replace(/^\/\/ {3}(import \{ list|const \{ list)[^\n]*\n/m, '')
      .replace(/^(import|const) (crypto|fs|path)[^\n]*\n/gm, '')
    expect(norm(cjsHead)).toBe(norm(jsHead))
    // 比べているものが本当に説明文であること（短い断片どうしを比べて緑、を防ぐ）
    expect(norm(jsHead).length).toBeGreaterThan(3000)
  })
})
