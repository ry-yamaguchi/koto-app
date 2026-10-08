import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
// 保存先のフォルダ名は定数を参照する（文字列を2か所に書かない・掟10）。
import { DATA_LAYER_LOCAL_DIR } from '../src/shared/objectStorage'

// koto-data の「保存の口」を直したときのテスト（2026-09-24）。
//
// ── なぜ偽サーバに実際に流すのか（掟10）────────────────────────────────
// 2026-09-08〜09、文字列一致のテストが変異を素通りした。ここで確かめたいのは
// 「そう書いてあるか」ではなく「**実際に何回読みに行ったか**」「**429 が返ったとき
// やり直すか**」「**版が違うとき断るか**」なので、偽のサーバ（fetch の差し替え）と
// 手元のフォルダに実際に流して、**要求の一覧を数える**。
//
// さくらへは一切通信しない。

const TEMPLATE = path.resolve(__dirname, '../templates/koto-data.js')
const TEMPLATE_CJS = path.resolve(__dirname, '../templates/koto-data.cjs')

const ENV = {
  KOTO_STORAGE_BUCKET: 'koto-data-x',
  KOTO_STORAGE_ENDPOINT: 'https://s3.isk01.sakurastorage.jp',
  KOTO_STORAGE_REGION: 'jp-north-1',
  KOTO_STORAGE_PREFIX: 'projects/myapp/',
  KOTO_STORAGE_ACCESS_KEY: 'AKIAIOSFODNN7EXAMPLE',
  KOTO_STORAGE_SECRET_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
}

let savedEnv: Record<string, string | undefined> = {}
function setEnv(env: Record<string, string>) {
  savedEnv = {}
  for (const k of Object.keys(ENV)) { savedEnv[k] = process.env[k]; delete process.env[k] }
  for (const [k, v] of Object.entries(env)) process.env[k] = v
}
function restoreEnv() {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
}

afterEach(() => { restoreEnv(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); vi.restoreAllMocks() })

type Mod = Record<string, any>

/** 偽のオブジェクトストレージ。**送られた要求を全部控える。** */
function fakeS3() {
  const objects = new Map<string, string>()
  const requests: { method: string; url: string }[] = []
  /** 次の n 回だけ、条件に合う要求へこの状態を返す（混雑の再現） */
  const scripted: { method: string; status: number; times: number; headers?: Record<string, string> }[] = []

  const reply = (status: number, text: string, headers?: Record<string, string>) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: headers ? { get: (n: string) => headers[n.toLowerCase()] ?? null } : undefined,
    text: async () => text,
  })

  const fetchImpl = async (url: string, init: any) => {
    const method = String(init?.method ?? 'GET')
    requests.push({ method, url })
    const s = scripted.find(x => x.times > 0 && (x.method === '*' || x.method === method))
    if (s) { s.times -= 1; return reply(s.status, '', s.headers) }

    const u = new URL(url)
    if (u.searchParams.get('list-type') === '2') {
      const prefix = u.searchParams.get('prefix') ?? ''
      const keys = [...objects.keys()].filter(k => k.startsWith(prefix)).sort()
      const xml = `<ListBucketResult>${keys.map(k => `<Contents><Key>${k}</Key></Contents>`).join('')}`
        + '<IsTruncated>false</IsTruncated></ListBucketResult>'
      return reply(200, xml)
    }
    const key = decodeURIComponent(u.pathname.replace(`/${ENV.KOTO_STORAGE_BUCKET}/`, ''))
    if (method === 'PUT') { objects.set(key, String(init?.body ?? '')); return reply(200, '') }
    if (method === 'DELETE') { objects.delete(key); return reply(204, '') }
    const body = objects.get(key)
    return body === undefined ? reply(404, '') : reply(200, body)
  }

  return {
    objects,
    requests,
    fail: (method: string, status: number, times: number, headers?: Record<string, string>) =>
      scripted.push({ method, status, times, headers }),
    install: () => vi.stubGlobal('fetch', fetchImpl),
    gets: () => requests.filter(r => r.method === 'GET').length,
    clear: () => { requests.length = 0 },
  }
}

/**
 * 待つ処理（sleep）を偽物に差し替えて、**何ミリ秒の待ちを何回頼んだか**だけを控える。
 *
 * 実時間（`Date.now()` の差）で見ると、混んでいる機械で落ちる時限式のテストになる。
 * 逆に機械が速ければ、待ちを入れてしまう変異を見逃す。**どちらも起きた**（2026-09-24）。
 * 返した配列に、呼ばれた待ち時間がそのまま積まれる。`vi.unstubAllGlobals()`（afterEach）で戻る。
 */
function countPauses(): number[] {
  const waited: number[] = []
  const real = globalThis.setTimeout
  vi.stubGlobal('setTimeout', (fn: (...a: any[]) => void, ms?: number, ...rest: any[]) => {
    waited.push(Number(ms ?? 0))
    return real(fn, 0, ...rest) // 実際には待たない（数えるだけ）
  })
  return waited
}

async function loadCloud(server: ReturnType<typeof fakeS3>): Promise<Mod> {
  setEnv(ENV)
  server.install()
  vi.resetModules()
  const mod = await import(TEMPLATE) as Mod
  expect(mod.storageMode()).toBe('cloud')
  return mod
}

/** 手元のフォルダで動かす（環境変数なし）。 */
async function loadLocal(): Promise<{ mod: Mod; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-data-opt-'))
  vi.spyOn(process, 'cwd').mockReturnValue(dir)
  setEnv({})
  vi.resetModules()
  const mod = await import(TEMPLATE) as Mod
  expect(mod.storageMode()).toBe('local')
  return { mod, dir }
}

// ── ① 今までどおりの呼び方が、今までどおり動く ───────────────────────────
// このファイルは**利用者のプロジェクトへ複製される**。公開中のアプリが現に使っている。
// 引数を足したせいで既存の呼び方が変わったら、動いているアプリが止まる。
describe('★ 今までどおりの呼び方が、今までどおり動く', () => {
  it('list(コレクション) と save(コレクション, データ) だけで動く（手元のフォルダ）', async () => {
    const { mod, dir } = await loadLocal()
    try {
      const a = await mod.save('entries', { name: 'A', createdAt: '2026-01-01T00:00:00.000Z' })
      const b = await mod.save('entries', { name: 'B', createdAt: '2026-08-01T00:00:00.000Z' })
      expect(a.id).toBeTruthy()
      // 引数なしの list は「全部・新しい順」のまま
      expect((await mod.list('entries')).map((r: any) => r.name)).toEqual(['B', 'A'])
      expect(await mod.get('entries', a.id)).toMatchObject({ name: 'A' })
      await mod.remove('entries', b.id)
      expect((await mod.list('entries')).map((r: any) => r.name)).toEqual(['A'])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('list(コレクション) と save(コレクション, データ) だけで動く（偽のサーバ）', async () => {
    const server = fakeS3()
    const mod = await loadCloud(server)
    await mod.save('entries', { name: 'A', createdAt: '2026-01-01T00:00:00.000Z' })
    await mod.save('entries', { name: 'B', createdAt: '2026-08-01T00:00:00.000Z' })
    expect((await mod.list('entries')).map((r: any) => r.name)).toEqual(['B', 'A'])
  })

  // ★ 版を足したせいで保存のたびに読みに行く、では通信が倍になる
  it('版を渡さない保存は、今までどおり1回の書き込みだけで済む（読みに行かない）', async () => {
    const server = fakeS3()
    const mod = await loadCloud(server)
    server.clear()
    await mod.save('entries', { name: 'A' })
    expect(server.requests.map(r => r.method)).toEqual(['PUT'])
  })
})

// ── ② 429 / 503 は待ってやり直す。それ以外は今までどおり ────────────────
describe('★ 混み合っているとき（429・503）は、待ってやり直す', () => {
  it('429 が1回返っても、やり直して成功する', async () => {
    const server = fakeS3()
    const mod = await loadCloud(server)
    server.fail('PUT', 429, 1)
    server.clear()
    const saved = await mod.save('entries', { name: 'A' })
    expect(saved.name).toBe('A')
    expect(server.requests.map(r => r.method)).toEqual(['PUT', 'PUT']) // 1回目は 429、2回目で成功
  })

  it('503 でもやり直す', async () => {
    const server = fakeS3()
    const mod = await loadCloud(server)
    await mod.save('entries', { id: 'aaaaaaaaaa-0000000000000000', name: 'A' })
    server.fail('GET', 503, 1)
    server.clear()
    expect(await mod.get('entries', 'aaaaaaaaaa-0000000000000000')).toMatchObject({ name: 'A' })
    expect(server.gets()).toBe(2)
  })

  it('Retry-After が付いていても、やり直して成功する（あれば従う・無ければ既定）', async () => {
    const server = fakeS3()
    const mod = await loadCloud(server)
    server.fail('PUT', 429, 1, { 'retry-after': '0' })
    server.clear()
    await mod.save('entries', { name: 'A' })
    expect(server.requests).toHaveLength(2)
  })

  // ★ 何度やっても駄目なら、**数字だけでない**言葉で失敗する
  it('やり直しても駄目なら、利用者に分かる言葉で失敗する', async () => {
    const server = fakeS3()
    const mod = await loadCloud(server)
    server.fail('*', 429, 99)
    server.clear()
    const err = await mod.list('entries').then(() => null, (e: Error) => e)
    expect(err, '429 が続いているのに成功してしまった').not.toBeNull()
    const message = String((err as Error).message)
    expect(message).toContain('立て込んでいます')
    expect(message).toContain('429')
    expect(message).toContain('もう一度お試しください')
    // 「読み込めませんでした（429）」では、何をすればよいか分からない
    expect(message.length).toBeGreaterThan(40)
    // 1回目＋やり直し3回＝4回でやめる（無限に撃たない）
    expect(server.requests).toHaveLength(4)
  })
})

describe('★ 404 と、それ以外の失敗は今までどおり', () => {
  it('404 は get が null を返す（やり直さない）', async () => {
    const server = fakeS3()
    const mod = await loadCloud(server)
    server.clear()
    expect(await mod.get('entries', 'nosuchid')).toBeNull()
    expect(server.gets()).toBe(1)
  })

  it('404 は remove が黙って何もしない', async () => {
    const server = fakeS3()
    const mod = await loadCloud(server)
    server.fail('DELETE', 404, 1)
    await expect(mod.remove('entries', 'nosuchid')).resolves.toBeUndefined()
  })

  // ★ 500 でやり直すと、直らない失敗を4回撃つことになる
  it('500 は1回で失敗する（やり直さない）', async () => {
    const server = fakeS3()
    const mod = await loadCloud(server)
    server.fail('GET', 500, 99)
    server.clear()
    await expect(mod.get('entries', 'x')).rejects.toThrow(/500/)
    expect(server.gets()).toBe(1)
  })

  it('403 は、鍵の設定を見直せると分かる言葉で失敗する', async () => {
    const server = fakeS3()
    const mod = await loadCloud(server)
    server.fail('PUT', 403, 99)
    await expect(mod.save('entries', { name: 'A' })).rejects.toThrow(/保存場所の設定/)
  })
})

// ── ③ 同じ1件を同時に書いたとき、黙って消さない ─────────────────────────
// **検知であって防止ではない**（読んでから書くまでの間に他が書けば、すり抜ける）。
// ここで固定するのは「よくある取りこぼし＝読んだ版のまま書き戻す」を断ること。
describe('★ 同じ1件を同時に書き換えたとき', () => {
  it('保存すると版が付き、読み直して書き戻すと版が増える', async () => {
    const { mod, dir } = await loadLocal()
    try {
      const a = await mod.save('entries', { name: 'A' })
      expect(a._kotoVersion).toBe(1)
      const again = await mod.save('entries', { ...(await mod.get('entries', a.id)), name: 'A2' })
      expect(again._kotoVersion).toBe(2)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('★ 版が違うと断る（先に書いた変更を黙って消さない）', async () => {
    const { mod, dir } = await loadLocal()
    try {
      const a = await mod.save('entries', { name: 'A' })
      const mine = await mod.get('entries', a.id) // 私が読んだ写し（版 1）
      await mod.save('entries', { ...mine, name: '他の人の変更' }) // 別のところが先に書いた（版 2）

      const err = await mod.save('entries', { ...mine, name: '私の変更' }).then(() => null, (e: Error) => e)
      expect(err, '版が違うのに上書きしてしまった').not.toBeNull()
      const message = String((err as Error).message)
      expect(message).toContain('読み込んだあとに別のところで書き換えられました')
      expect(message).toContain('get()') // 何をすればよいかまで書く
      expect(message).toContain('overwrite')
      // 先に書かれた変更が、消えずに残っていること
      expect(await mod.get('entries', a.id)).toMatchObject({ name: '他の人の変更' })
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('★ overwrite: true なら、版を見ずに上書きする', async () => {
    const { mod, dir } = await loadLocal()
    try {
      const a = await mod.save('entries', { name: 'A' })
      const mine = await mod.get('entries', a.id)
      await mod.save('entries', { ...mine, name: '他の人の変更' })
      await mod.save('entries', { ...mine, name: '私の変更' }, { overwrite: true })
      expect(await mod.get('entries', a.id)).toMatchObject({ name: '私の変更' })
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  // ★ ここが守られないと、いま動いているアプリが全部止まる
  it('★ 版を持たない既存のレコードは断らない（保存されている側に版が無い）', async () => {
    const { mod, dir } = await loadLocal()
    try {
      // 版という考えが無かった頃に保存されたもの（版がどこにも入っていない）
      const legacyDir = path.join(dir, DATA_LAYER_LOCAL_DIR, 'entries')
      fs.mkdirSync(legacyDir, { recursive: true })
      fs.writeFileSync(path.join(legacyDir, 'old1.json'), JSON.stringify({ id: 'old1', name: '昔の1件' }), 'utf8')

      const read = await mod.get('entries', 'old1')
      expect(read._kotoVersion).toBeUndefined()
      // 版を付けて書き戻しても断られない
      const out = await mod.save('entries', { ...read, _kotoVersion: 7, name: '書き戻し' })
      expect(out._kotoVersion).toBe(8)
      expect(await mod.get('entries', 'old1')).toMatchObject({ name: '書き戻し' })
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('★ 版を渡さない呼び方は、今までどおり後勝ちで上書きする', async () => {
    const { mod, dir } = await loadLocal()
    try {
      await mod.save('entries', { id: 'fixed', name: '1回目' })
      await mod.save('entries', { id: 'fixed', name: '2回目' })
      await mod.save('entries', { id: 'fixed', name: '3回目' })
      expect(await mod.get('entries', 'fixed')).toMatchObject({ name: '3回目' })
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

// ── ④ limit / skip / where / sort ───────────────────────────────────────
// ★ ここが**このテストの中心**。「絞り込めば速くなる」と謳っていないことまで固定する。
describe('★ list の件数・開始位置・絞り込み・並び', () => {
  const BASE = Date.parse('2026-09-24T00:00:00.000Z')

  /** 保存した順が id の順になるように、時刻を1ミリ秒ずつ進めて保存する。 */
  async function seed(mod: Mod, n: number) {
    vi.useFakeTimers()
    try {
      for (let i = 0; i < n; i++) {
        vi.setSystemTime(new Date(BASE + i))
        await mod.save('entries', { name: String(i).padStart(2, '0') })
      }
    } finally { vi.useRealTimers() }
  }

  it('★ limit を指定すると、読みに行く回数が実際に減る（偽サーバで数える）', async () => {
    const server = fakeS3()
    const mod = await loadCloud(server)
    await seed(mod, 30)

    server.clear()
    const all = await mod.list('entries')
    expect(all).toHaveLength(30)
    expect(server.gets(), '指定なしは 一覧1回＋30件').toBe(31)

    server.clear()
    const few = await mod.list('entries', { limit: 5 })
    expect(few.map((r: any) => r.name)).toEqual(['29', '28', '27', '26', '25'])
    expect(server.gets(), 'limit 5 は 一覧1回＋5件').toBe(6)
  })

  it('★ skip で「次の5件」が取れる（こちらも読む回数は増えない）', async () => {
    const server = fakeS3()
    const mod = await loadCloud(server)
    await seed(mod, 30)
    server.clear()
    const next = await mod.list('entries', { limit: 5, skip: 5 })
    expect(next.map((r: any) => r.name)).toEqual(['24', '23', '22', '21', '20'])
    // 一覧1回＋10件（読み飛ばす5件も**実際に読む**——読んでみるまで読めるか分からず、
    // id の並びで数えると消された件まで1件に数えて**ページが重なる**。2026-09-25）
    expect(server.gets(), '全件読みへ落ちている').toBe(11)
  })

  // ★ ここで嘘をつかない。where と sort は「読んだあと」に効く
  it('★ where は通信を減らさない（減ると謳っていないことの確認）', async () => {
    const server = fakeS3()
    const mod = await loadCloud(server)
    await seed(mod, 30)
    server.clear()
    const hit = await mod.list('entries', { limit: 5, where: (r: any) => r.name === '07' })
    expect(hit.map((r: any) => r.name)).toEqual(['07'])
    expect(server.gets(), 'where を付けても全件読む').toBe(31)
  })

  it('★ sort は通信を減らさない', async () => {
    const server = fakeS3()
    const mod = await loadCloud(server)
    await seed(mod, 30)
    server.clear()
    const sorted = await mod.list('entries', { limit: 3, sort: 'name', order: 'asc' })
    expect(sorted.map((r: any) => r.name)).toEqual(['00', '01', '02'])
    expect(server.gets(), 'sort を付けても全件読む').toBe(31)
  })

  it('order: desc で逆順に並ぶ', async () => {
    const { mod, dir } = await loadLocal()
    try {
      await mod.save('entries', { name: '山田' })
      await mod.save('entries', { name: '佐藤' })
      const desc = await mod.list('entries', { sort: 'name', order: 'desc' })
      const asc = await mod.list('entries', { sort: 'name' })
      expect(desc.map((r: any) => r.name)).toEqual([...asc.map((r: any) => r.name)].reverse())
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  // ★ 速い道を使うと、並び順が狂って**間違った5件**を返す
  it('★ 古い形の id が混ざっていたら、速い道を使わず正しい結果を返す', async () => {
    const server = fakeS3()
    const mod = await loadCloud(server)
    await seed(mod, 30)
    // アプリが自分で決めた id（Koto が付けた形ではない）
    await mod.save('entries', { id: 'legacy1', name: 'むかしの1件', createdAt: '2026-01-01T00:00:00.000Z' })

    server.clear()
    const few = await mod.list('entries', { limit: 5 })
    // 速い道を使うと 'legacy1' が先頭に来てしまう（英字は数字より後ろに並ぶため）
    expect(few.map((r: any) => r.name)).toEqual(['29', '28', '27', '26', '25'])
    expect(server.gets(), '正しさを優先して全件読む').toBe(32)
  })
})

// ── ⑤ 新しい id は、並べれば保存順になる ────────────────────────────────
describe('★ 新しい id の形', () => {
  it('★ 辞書順に並べると、保存した順になる', async () => {
    const { mod, dir } = await loadLocal()
    try {
      const ids: string[] = []
      vi.useFakeTimers()
      try {
        for (let i = 0; i < 40; i++) {
          vi.setSystemTime(new Date(Date.parse('2026-09-24T00:00:00.000Z') + i * 37))
          ids.push((await mod.save('entries', { n: i })).id)
        }
      } finally { vi.useRealTimers() }
      expect([...ids].sort()).toEqual(ids)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('★ 同じミリ秒に何件保存しても、id がぶつからない', async () => {
    const { mod, dir } = await loadLocal()
    try {
      const ids: string[] = []
      vi.useFakeTimers()
      try {
        vi.setSystemTime(new Date('2026-09-24T00:00:00.000Z')) // 時刻を止める
        for (let i = 0; i < 50; i++) ids.push((await mod.save('entries', { n: i })).id)
      } finally { vi.useRealTimers() }
      expect(new Set(ids).size).toBe(50)
      // 時刻の部分は全部同じ（桁が揃っている＝並べれば順番になる）
      expect(new Set(ids.map(v => v.slice(0, 10))).size).toBe(1)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('id に使う文字は、保存先の名前として通るものだけ（英数字と _ -）', async () => {
    const { mod, dir } = await loadLocal()
    try {
      const { id } = await mod.save('entries', { n: 1 })
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(await mod.get('entries', id)).toMatchObject({ n: 1 }) // 名前の検査を通る
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

// ── ⑥ 判定は純関数1か所（掟10）。両方のテンプレートで同じであること ───────
const TEMPLATES = [
  { label: 'import 版 koto-data.js', file: TEMPLATE },
  { label: 'require 版 koto-data.cjs', file: TEMPLATE_CJS },
]

function extract(file: string, names: string[], consts: string[]) {
  const src = fs.readFileSync(file, 'utf-8')
  const parts: string[] = []
  for (const c of consts) {
    const m = new RegExp(`^const ${c} = .*$`, 'm').exec(src)
    if (!m) throw new Error(`${file} に ${c} がありません`)
    parts.push(m[0])
  }
  for (const n of names) {
    const m = new RegExp(`^function ${n}\\([\\s\\S]*?\\n\\}`, 'm').exec(src)
    if (!m) throw new Error(`${file} に ${n} がありません`)
    parts.push(m[0])
  }
  return new Function(`${parts.join('\n')}\nreturn { ${names.join(', ')} }`)() as Record<string, any>
}

describe.each(TEMPLATES)('判定の純関数: $label', ({ file }) => {
  const fns = () => extract(file, ['isSortableId', 'canNarrowByKey'], [])

  it('Koto が付けた id だけを「並べれば順番になる」と見なす', () => {
    const { isSortableId } = fns()
    expect(isSortableId('00muepzeeg-5752bb5a16e67fb2')).toBe(true)
    // ★ 古い形（乱数だけの UUID）
    expect(isSortableId('3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe(false)
    // ★ アプリが自分で決めた id（実際に事故になったもの）
    expect(isSortableId('dates')).toBe(false)
    expect(isSortableId('legacy1')).toBe(false)
    expect(isSortableId('')).toBe(false)
    expect(isSortableId(null)).toBe(false)
    expect(isSortableId('00muepzeeg-5752bb5a16e67fb')).toBe(false)  // 短い
    expect(isSortableId('00muepzee-5752bb5a16e67fb2')).toBe(false)  // 時刻の桁が足りない
    expect(isSortableId('00MUEPZEEG-5752bb5a16e67fb2')).toBe(false) // 大文字は作らない
  })

  it('速い道を使ってよいのは、limit があり where も sort も無く、id が揃っているときだけ', () => {
    const { canNarrowByKey } = fns()
    const ok = ['00muepzeeg-5752bb5a16e67fb2', '00muepzeen-cf6437b87a3a4c58']
    const mixed = [...ok, 'dates']
    expect(canNarrowByKey({ limit: 5 }, ok)).toBe(true)
    expect(canNarrowByKey({ limit: 5, skip: 5 }, ok)).toBe(true)
    expect(canNarrowByKey({}, ok)).toBe(false)                          // limit が無い
    expect(canNarrowByKey({ limit: 5, where: () => true }, ok)).toBe(false)
    expect(canNarrowByKey({ limit: 5, sort: 'name' }, ok)).toBe(false)
    expect(canNarrowByKey({ limit: 5 }, mixed)).toBe(false)             // 1件でも違えば使わない
    expect(canNarrowByKey({ limit: 5 }, [])).toBe(true)
    expect(canNarrowByKey(undefined, ok)).toBe(false)
    // ★ 古い順（order: 'asc'）は、読む前に選べない（選べるのは新しい側からだけ）
    expect(canNarrowByKey({ limit: 5, order: 'asc' }, ok)).toBe(false)
    expect(canNarrowByKey({ limit: 5, order: 'desc' }, ok)).toBe(true)
  })

  it('Retry-After は、あれば従い、無ければ少しずつ伸びる待ち時間を使う', () => {
    const { retryWaitMs, parseRetryAfter } = extract(
      file, ['retryWaitMs', 'parseRetryAfter'], ['RETRY_WAITS_MS', 'RETRY_AFTER_MAX_MS'],
    )
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter('')).toBeNull()
    expect(parseRetryAfter('わからない')).toBeNull()
    expect(parseRetryAfter('2')).toBe(2000)
    // 待ち時間は少しずつ伸びる（ばらつきを足すので、base 以上 base×2 未満）
    for (const [i, base] of [[0, 200], [1, 400], [2, 800]] as const) {
      const waits = [...Array(30)].map(() => retryWaitMs(null, i))
      for (const w of waits) {
        expect(w, `${base} 以上であること`).toBeGreaterThanOrEqual(base)
        expect(w, `${base * 2} 未満であること`).toBeLessThan(base * 2)
      }
      // ★ ばらつきが**実際に**ある（無いと、429 を受けた20件が同じ時刻に一斉にやり直す）
      expect(new Set(waits).size, 'すべて同じ待ち時間になっている').toBeGreaterThan(1)
    }
    expect(retryWaitMs('2', 0)).toBe(2000)        // サーバの言い分に従う
    expect(retryWaitMs('0', 0)).toBeGreaterThanOrEqual(200) // ただし既定より短くはしない
    expect(retryWaitMs('99999', 0)).toBe(10000)   // 長すぎるときは頭打ち
  })
})

// ── ⑦ 2本のテンプレートが、読み込み方以外まったく同じであること ───────────
// 片方だけ直されると、どちらのアプリで起きた不具合かで話が食い違う（掟10）。
// 既存の kotoDataTemplate.test.ts は「同じ関数を公開しているか」までを見ている。
// ここは**中身が1文字も違わない**ところまで見る。
describe('★ import 版と require 版が、読み込み方以外まったく同じ', () => {
  const bodyOf = (s: string) => s.slice(s.indexOf('const BUCKET ='))

  it('本体（const BUCKET 以降）が、export / module.exports を除いて一致する', () => {
    const raw = bodyOf(fs.readFileSync(TEMPLATE, 'utf-8'))
    // 比べているものが本当に中身であること（空文字どうしを比べて緑、を防ぐ）
    expect(raw.length).toBeGreaterThan(5000)
    expect((raw.match(/^export /gm) ?? []).length, '公開している5つ').toBe(5)

    const js = raw.replace(/^export /gm, '')
    const cjs = bodyOf(fs.readFileSync(TEMPLATE_CJS, 'utf-8'))
      .replace(/\n\/\/ ── 使う側へ公開する[\s\S]*$/, '')
    expect(cjs.trimEnd()).toBe(js.trimEnd())
  })
})

// ── ⑧ require 版でも、足した引数が同じように動く ─────────────────────────
// 上で「中身が同じ」ことは確かめているが、**実際に Node が読み込んで動くか**は別。
describe('★ require 版（koto-data.cjs）でも、足した引数が同じように動く', () => {
  it('Node が読み込めて、limit・version・remove が同じように働く', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-data-cjs-opt-'))
    const spy = vi.spyOn(process, 'cwd').mockReturnValue(dir)
    setEnv({})
    try {
      const req = createRequire(import.meta.url)
      delete req.cache[TEMPLATE_CJS]
      const mod = req(TEMPLATE_CJS) as Mod
      expect(mod.storageMode()).toBe('local')

      vi.useFakeTimers()
      try {
        for (let i = 0; i < 5; i++) {
          vi.setSystemTime(new Date(Date.parse('2026-09-24T00:00:00.000Z') + i))
          await mod.save('entries', { name: String(i) })
        }
      } finally { vi.useRealTimers() }

      expect((await mod.list('entries', { limit: 2 })).map((r: any) => r.name)).toEqual(['4', '3'])
      expect((await mod.list('entries')).map((r: any) => r.name)).toEqual(['4', '3', '2', '1', '0'])

      const one = (await mod.list('entries', { limit: 1 }))[0]
      await mod.save('entries', { ...one, name: '他の人の変更' })
      await expect(mod.save('entries', { ...one, name: '私の変更' })).rejects.toThrow(/書き換えられました/)

      await mod.remove('entries', one.id)
      expect(await mod.get('entries', one.id)).toBeNull()
    } finally {
      spy.mockRestore()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── ⑨ 検分で見つかった取りこぼし（2026-09-24）─────────────────────────
// ここは**すべて、公開中のアプリで実際に起きる形**を振る舞いで固定する。
// 文字列一致ではなく、手元のフォルダ・偽サーバに実際に流して確かめる（掟10）。
describe('★ 読んだレコードを、そのまま繰り返し保存できる', () => {
  // ★ ScheduleAPP の saveData がこの形（一覧を読む → 変更のたび全件を保存し直す）。
  //   save が呼び出し側の写しに新しい版を書き戻さないと、**2件目以降が保存されない**
  it('★ 一覧を読んで全件を保存し直す形が、何周しても通る', async () => {
    const { mod, dir } = await loadLocal()
    try {
      for (let i = 0; i < 5; i++) await mod.save('entries', { name: `${i}` })
      // ★ 一覧は**一度だけ**読んで、そのオブジェクトを持ち回す（ScheduleAPP の形）。
      //   保存のたびに読み直す書き方では、この不具合は出ない
      const rows = await mod.list('entries')
      expect(rows).toHaveLength(5)
      for (let round = 0; round < 3; round++) {
        for (const row of rows) {
          row.note = `${round}周目`
          await mod.save('entries', row) // ★ 断られたら、ここで止まって以降が保存されない
        }
      }
      const after = await mod.list('entries')
      expect(after.map((r: any) => r.note)).toEqual(['2周目', '2周目', '2周目', '2周目', '2周目'])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('★ 保存に成功したら、渡したオブジェクトの版も新しくなる', async () => {
    const { mod, dir } = await loadLocal()
    try {
      const mine: any = { id: 'fixed', name: 'A' }
      const first = await mod.save('entries', mine)
      expect(mine._kotoVersion).toBe(first._kotoVersion)
      const second = await mod.save('entries', mine) // 同じ入れ物のまま、もう一度
      expect(second._kotoVersion).toBe(first._kotoVersion + 1)
      expect(mine._kotoVersion).toBe(second._kotoVersion)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  // ★ 書き戻しで検知が外れていないこと。**別のところが割り込んだら、やはり断る**
  it('★ 別のところが割り込んだときは、これまでどおり断る', async () => {
    const { mod, dir } = await loadLocal()
    try {
      const mine = await mod.save('entries', { id: 'fixed', name: 'A' })
      await mod.save('entries', { ...mine, name: '別のところの変更' }) // 割り込み
      await expect(mod.save('entries', { ...mine, name: '私の変更' })).rejects.toThrow(/書き換えられました/)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  // ★ 新しい1件を作るときは、確かめに行かない（保存のたびに通信が倍にならない）
  it('★ 新しい1件の保存は、これまでどおり書き込み1回だけ', async () => {
    const server = fakeS3()
    const mod = await loadCloud(server)
    server.clear()
    await mod.save('entries', { name: 'A' })
    expect(server.requests.map(r => r.method)).toEqual(['PUT'])
  })
})

describe('★ 版は巻き戻らない（巻き戻ると、検知が黙って外れる）', () => {
  it('★ overwrite で上書きしても、版は増える', async () => {
    const { mod, dir } = await loadLocal()
    try {
      let rec = await mod.save('entries', { name: 'A' })
      for (let i = 0; i < 4; i++) rec = await mod.save('entries', { ...(await mod.get('entries', rec.id)) })
      expect(rec._kotoVersion).toBe(5)
      const forced = await mod.save('entries', { id: rec.id, name: '上書き' }, { overwrite: true })
      expect(forced._kotoVersion).toBe(6)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('★ 版を持たないデータを保存しても、版は増える', async () => {
    const { mod, dir } = await loadLocal()
    try {
      let rec = await mod.save('entries', { id: 'fixed', name: 'A' })
      for (let i = 0; i < 4; i++) rec = await mod.save('entries', { ...(await mod.get('entries', 'fixed')) })
      expect(rec._kotoVersion).toBe(5)
      const plain = await mod.save('entries', { id: 'fixed', name: '版なし' })
      expect(plain._kotoVersion).toBe(6)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  // ★ ここが今回いちばん危ない形。巻き戻ると、**古い写しの版とたまたま一致して黙って通る**
  it('★ overwrite のあと、ずっと前に読んだ写しを保存すると断られる', async () => {
    const { mod, dir } = await loadLocal()
    try {
      const first = await mod.save('entries', { name: 'A' })
      const old = await mod.get('entries', first.id) // 版 1 の写し
      await mod.save('entries', { ...old, name: '2回目' })
      await mod.save('entries', { id: first.id, name: 'overwrite' }, { overwrite: true })
      await expect(mod.save('entries', { ...old, name: '古い写し' })).rejects.toThrow(/書き換えられました/)
      expect(await mod.get('entries', first.id)).toMatchObject({ name: 'overwrite' })
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

// ★ 入力フォームを通ると、数値は必ず文字列になる（FormData も <input value> も）
describe('★ 版が文字列で渡ってきても、正しく比べる', () => {
  it('★ _kotoVersion: "2"（合っている）は通り、"1"（古い）は断る', async () => {
    const { mod, dir } = await loadLocal()
    try {
      const first = await mod.save('entries', { id: 'fixed', name: 'A' })
      await mod.save('entries', { ...first, name: 'B' }) // 保存側は版 2
      await expect(mod.save('entries', { id: 'fixed', name: '古い', _kotoVersion: '1' }))
        .rejects.toThrow(/書き換えられました/)
      const ok = await mod.save('entries', { id: 'fixed', name: '合っている', _kotoVersion: '2' })
      expect(ok._kotoVersion).toBe(3)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('★ _kotoVersion: "" は「版なし」として扱う（断らず、版は増える）', async () => {
    const { mod, dir } = await loadLocal()
    try {
      const first = await mod.save('entries', { id: 'fixed', name: 'A' })
      const out = await mod.save('entries', { id: 'fixed', name: '版なし', _kotoVersion: '' })
      expect(out._kotoVersion).toBe(first._kotoVersion + 1)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('★ 同じミリ秒に保存しても、limit が「保存した順」を返す', () => {
  it('★ 時刻を止めて10件保存し、新しい3件を取る', async () => {
    const { mod, dir } = await loadLocal()
    try {
      vi.useFakeTimers()
      try {
        vi.setSystemTime(new Date('2026-09-24T00:00:00.000Z')) // 全件が同じミリ秒
        for (let i = 0; i < 10; i++) await mod.save('para', { seq: i })
      } finally { vi.useRealTimers() }
      expect((await mod.list('para', { limit: 3 })).map((r: any) => r.seq)).toEqual([9, 8, 7])
      expect((await mod.list('para')).map((r: any) => r.seq)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('★ createdAt が同じでも、limit の有無で順番が変わらない', () => {
  it('★ list() と list({ limit }) が同じ並びを返す', async () => {
    const { mod, dir } = await loadLocal()
    try {
      const same = '2026-09-24T00:00:00.000Z'
      for (let i = 0; i < 8; i++) await mod.save('entries', { seq: i, createdAt: same })
      const all = (await mod.list('entries')).map((r: any) => r.seq)
      const few = (await mod.list('entries', { limit: 3 })).map((r: any) => r.seq)
      expect(all).toEqual([7, 6, 5, 4, 3, 2, 1, 0]) // 約束どおり「全部・新しい順」
      expect(few).toEqual(all.slice(0, 3))
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('★ order は sort が無くても効く（説明文どおり）', () => {
  it('★ { order: "asc" } は古い順。limit を付けても同じ', async () => {
    const { mod, dir } = await loadLocal()
    try {
      for (const [name, at] of [['a', '2026-01-01'], ['b', '2026-02-01'], ['c', '2026-03-01']]) {
        await mod.save('entries', { name, createdAt: `${at}T00:00:00.000Z` })
      }
      expect((await mod.list('entries', { order: 'asc' })).map((r: any) => r.name)).toEqual(['a', 'b', 'c'])
      expect((await mod.list('entries', { order: 'desc' })).map((r: any) => r.name)).toEqual(['c', 'b', 'a'])
      expect((await mod.list('entries')).map((r: any) => r.name)).toEqual(['c', 'b', 'a']) // 既定は今までどおり
      expect((await mod.list('entries', { limit: 2, order: 'asc' })).map((r: any) => r.name)).toEqual(['a', 'b'])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  // ★ 古い順は読む前に選べないので、正しさを優先して全件読む（速さより正しさ）
  it('★ 古い順を頼まれたら全件読む（間違った件を返さない）', async () => {
    const server = fakeS3()
    const mod = await loadCloud(server)
    vi.useFakeTimers()
    try {
      for (let i = 0; i < 30; i++) {
        vi.setSystemTime(new Date(Date.parse('2026-09-24T00:00:00.000Z') + i))
        await mod.save('entries', { name: String(i).padStart(2, '0') })
      }
    } finally { vi.useRealTimers() }
    server.clear()
    const oldest = await mod.list('entries', { limit: 3, order: 'asc' })
    expect(oldest.map((r: any) => r.name)).toEqual(['00', '01', '02'])
    expect(server.gets(), '古い順は全件読む').toBe(31)
  })
})

describe('★ 数値と文字列が混ざっても、数として並べる', () => {
  it('★ price に 9 と "10" が混ざっていても、小さい順になる', async () => {
    const { mod, dir } = await loadLocal()
    try {
      for (const price of [9, '10', 100, '2', 30]) await mod.save('items', { price })
      const asc = (await mod.list('items', { sort: 'price', order: 'asc' })).map((r: any) => Number(r.price))
      expect(asc).toEqual([2, 9, 10, 30, 100])
      const desc = (await mod.list('items', { sort: 'price', order: 'desc' })).map((r: any) => Number(r.price))
      expect(desc).toEqual([100, 30, 10, 9, 2])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('★ 数として読めないものは、今までどおり文字で並べる', async () => {
    const { mod, dir } = await loadLocal()
    try {
      for (const name of ['さくら', 'apple', 'Banana']) await mod.save('items', { name })
      const asc = (await mod.list('items', { sort: 'name', order: 'asc' })).map((r: any) => r.name)
      expect(asc).toEqual([...asc].sort((a, b) => String(a).localeCompare(String(b))))
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('★ 速い道でも、頼んだ件数を揃えて返す', () => {
  it('★ 読めない件があったら、その先から読み足す', async () => {
    const { mod, dir } = await loadLocal()
    try {
      const saved: any[] = []
      vi.useFakeTimers()
      try {
        for (let i = 0; i < 10; i++) {
          vi.setSystemTime(new Date(Date.parse('2026-09-24T00:00:00.000Z') + i))
          saved.push(await mod.save('entries', { seq: i }))
        }
      } finally { vi.useRealTimers() }
      // 新しいほうの2件が「一覧には出るが読めない」状態（消された直後・中身が壊れている）
      for (const r of [saved[9], saved[8]]) {
        fs.writeFileSync(path.join(dir, DATA_LAYER_LOCAL_DIR, 'entries', `${r.id}.json`), '{壊れた', 'utf8')
      }
      const few = await mod.list('entries', { limit: 5 })
      expect(few, '頼んだ件数より少なく返っている').toHaveLength(5)
      expect(few.map((r: any) => r.seq)).toEqual([7, 6, 5, 4, 3])
      // 遅い道（全件読み）と同じ結果になること
      const slow = await mod.list('entries', { limit: 5, where: () => true })
      expect(slow.map((r: any) => r.seq)).toEqual(few.map((r: any) => r.seq))
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

// ★ 429 が返ったとき、20件が同じ時刻に一斉にやり直すと混雑がほどけない。
//   ばらつき（retryWaitMs）に加えて、**塊と塊の間に間隔を置く**ことも固定する。
//
// ── ここは時計を見ない（2026-09-25 に直した）────────────────────────────
// 2026-09-24 まで、この2件は `Date.now()` の差で判定していた。`npm test` の全走で
// **この1件だけが 716ms で落ち**（単独で回せば緑）、結果が機械の混み具合で変わった。
// 赤が信用できなくなると、同じ全走に混じった**本物の失敗まで押し直しで流される**（掟2）。
// いま見るのは「**待つ処理を、何ミリ秒で何回呼んだか**」だけ。機械の速さと切り離す。
describe('★ まとめ読みは、毎秒の上限に当たりにくい形で流す', () => {
  it('★ 公開先では、20件を超える一覧の塊の間に待ち時間が入る', async () => {
    const server = fakeS3()
    const mod = await loadCloud(server)
    for (let i = 0; i < 25; i++) await mod.save('entries', { i })
    const waited = countPauses()
    expect(await mod.list('entries')).toHaveLength(25)
    // 25件＝20件＋5件の2つの塊。間に1回だけ、毎秒の上限のための間隔（200ms）が入る
    expect(waited, '塊の間に間隔を置いていない').toEqual([200])
  })

  it('★ 件数が増えると、塊の数だけ間隔が増える（45件＝3つの塊で2回）', async () => {
    const server = fakeS3()
    const mod = await loadCloud(server)
    for (let i = 0; i < 45; i++) await mod.save('entries', { i })
    const waited = countPauses()
    expect(await mod.list('entries')).toHaveLength(45)
    expect(waited, '塊の数だけ間隔を置いていない').toEqual([200, 200])
  })

  // ★ 間隔を置くのは**公開先の毎秒の上限**（1バケット100アクセス）のため。
  //   手元のフォルダには上限が無いので、待つと「② 試す」が件数に比例して遅くなるだけ。
  it('★ 手元のフォルダでは、何件あっても間隔を置かない', async () => {
    const { mod, dir } = await loadLocal()
    try {
      for (let i = 0; i < 45; i++) await mod.save('entries', { i })
      const waited = countPauses()
      expect(await mod.list('entries')).toHaveLength(45)
      // 45件＝3つの塊。公開先なら2回待つところ（上のテスト）を、**1回も待たない**
      expect(waited, '手元のフォルダなのに間隔を置いている').toEqual([])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  // ★ list() には待ちが**2か所**ある（読む前に選ぶ「速い道」と、全件読みの「遅い道」）。
  //   上の3件は `list('entries')`（limit なし）しか流していないので、**遅い道の待ちしか
  //   通らない**。2026-09-25 の検分で、速い道の待ちから `useCloud &&` を外しても、
  //   逆に待ちを殺しても、**96件すべて緑**だと実証された。
  //   速い道を通す呼び方（limit ＋ Koto が付けた id だけ）で、同じことを固定する。
  it('★ 速い道（limit あり）でも、公開先では塊の間に待ち時間が入る', async () => {
    const server = fakeS3()
    const mod = await loadCloud(server)
    await seedEntries(mod, 25)
    server.clear()
    const waited = countPauses()
    expect(await mod.list('entries', { limit: 25 })).toHaveLength(25)
    // 速い道に入っていること（入っていなければ、この数は一覧1回＋25件にならない）
    expect(server.gets(), '速い道に入っていない（全件読みへ落ちている）').toBe(26)
    // 25件＝20件＋5件の2つの塊。間に1回だけ、毎秒の上限のための間隔が入る
    expect(waited, '速い道で塊の間に間隔を置いていない').toEqual([200])
  })

  it('★ 速い道でも、手元のフォルダでは何件あっても間隔を置かない', async () => {
    const { mod, dir } = await loadLocal()
    try {
      await seedEntries(mod, 25)
      const waited = countPauses()
      expect(await mod.list('entries', { limit: 25 })).toHaveLength(25)
      expect(waited, '手元のフォルダなのに速い道で間隔を置いている').toEqual([])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

// ── ⑩ 2026-09-25 の検分で見つかった取りこぼし ─────────────────────────────
// ここはすべて**公開したアプリの中で実際に起きる形**を、手元のフォルダ・偽サーバに
// 流して固定する（掟10）。ソースの文字列一致では、どれ1つ捕まらない。

/** 保存した順が id の順になるように、時刻を1ミリ秒ずつ進めて n 件保存する。 */
async function seedEntries(mod: Mod, n: number, collection = 'entries') {
  const saved: any[] = []
  vi.useFakeTimers()
  try {
    for (let i = 0; i < n; i++) {
      vi.setSystemTime(new Date(Date.parse('2026-09-24T00:00:00.000Z') + i))
      saved.push(await mod.save(collection, { name: String(i).padStart(2, '0'), seq: i }))
    }
  } finally { vi.useRealTimers() }
  return saved
}

/**
 * 説明文の一節を切り出す。**文字数で窓を切らない**（2026-09-25 の検分）。
 *
 * `src.slice(0, 4000)` のような窓は、**冒頭の説明が伸びるたびに効き目が縮む**。
 * 実際、説明を約470文字足しただけで、それまで窓の中にあった行が外へ出て、
 * 禁じたはずの文言を書き足しても全件緑になった。目印が見つからないときも、
 * `indexOf` が返す -1 のまま slice すると**見ているつもりで見ていない**ので、その場で落とす。
 */
function sectionOf(src: string, from: string, to: string, label: string) {
  const start = src.indexOf(from)
  const end = src.indexOf(to)
  expect(start, `${label} に「${from}」がありません`).toBeGreaterThanOrEqual(0)
  expect(end, `${label} に「${to}」がありません`).toBeGreaterThan(start)
  return src.slice(start, end)
}

// ★ version は仕様書の版・見積書の版・スキーマの版と、アプリがごく普通に使う名前。
//   実機: save('docs', { version: '1.0' }) の '1.0' が黙って 2 に潰され、読み直して
//   版を上げて保存すると**永久に断られた**（get で読み直せと言われるが、アプリがまた
//   自分の version を入れるので終わらない）。**名前を分ければ、どちらも壊れない。**
describe('★ アプリ自身が version という項目を持っていても、壊れない', () => {
  it('★ 渡した version が潰されない（Koto の版は別の名前に入る）', async () => {
    const { mod, dir } = await loadLocal()
    try {
      const saved = await mod.save('docs', { id: 'doc1', title: '仕様書', version: '1.0' })
      expect(saved.version, "アプリの version が Koto の連番に潰されている").toBe('1.0')
      expect((await mod.get('docs', 'doc1')).version, '保存された中身でも潰されている').toBe('1.0')
      expect(saved._kotoVersion, 'Koto の版が付いていない').toBe(1)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  // ★ 実機で「何度やっても断られる」になった形をそのまま流す
  it('★ 読み直して自分の版を上げて保存する、を何周しても通る', async () => {
    const { mod, dir } = await loadLocal()
    try {
      await mod.save('docs', { id: 'doc1', title: '仕様書', version: '1.0' })
      for (const v of ['1.1', '1.2', '1.3']) {
        const read = await mod.get('docs', 'doc1')
        const out = await mod.save('docs', { ...read, version: v }) // ★ ここで断られていた
        expect(out.version).toBe(v)
      }
      const last = await mod.get('docs', 'doc1')
      expect(last.version, 'アプリの版が残っていない').toBe('1.3')
      expect(last._kotoVersion, 'Koto の版が増えていない').toBe(4)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  // ★ 名前を分けても、同時に書き換えたときの検知は外れないこと
  it('★ version を持つアプリでも、割り込まれたらこれまでどおり断る', async () => {
    const { mod, dir } = await loadLocal()
    try {
      const mine = await mod.save('docs', { id: 'doc1', title: '見積書', version: '1.0' })
      await mod.save('docs', { ...mine, title: '別のところの変更' })
      await expect(mod.save('docs', { ...mine, title: '私の変更' })).rejects.toThrow(/書き換えられました/)
      expect((await mod.get('docs', 'doc1')).title).toBe('別のところの変更')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  // ★ 冒頭の案内は、**利用者と、アプリを作る AI の両方が読む**。実物と食い違うと遠くまで届く。
  //   2026-09-25 まで『この3つと同じ名前をアプリのデータに使うと、入れた値が消えたり、
  //   保存を断られたりします』と3つまとめて断定していたが、**実測では id も createdAt も
  //   渡した値がそのまま残る**（消えるのは _kotoVersion だけ）。しかも同じファイルの
  //   save() の説明は「同じ id で呼ぶと上書き（更新）になる」と id を渡す前提で書いてある。
  //   読んだ人が**更新のために id を渡すのをやめかねない**ので、3つを分けて書く。
  //   ここは文で、下の1件は振る舞いで——**両方そろって初めて「実物と合っている」と言える**。
  it('★ 冒頭の説明が、Koto が使う3つの項目の扱いを実物どおりに書いている（利用者が読む文）', () => {
    for (const file of [TEMPLATE, TEMPLATE_CJS]) {
      const src = fs.readFileSync(file, 'utf-8')
      const notice = sectionOf(src, 'Koto が使う項目名', '一覧は、件数', file)
      expect(notice.length, file).toBeGreaterThan(200)
      // 画面に出る文と同じ作法（掟5）。この案内に Markdown の太字を混ぜない
      expect(notice, file).not.toContain('**')
      // ★ 必ず Koto のものになるのは _kotoVersion だけ、と書いてある
      expect(notice, file).toMatch(/_kotoVersion[\s\S]*この名前を使わないでください/)
      expect(notice, file).toMatch(/Koto が必ず書き換えるのは _kotoVersion だけ/)
      // ★ id と createdAt は渡せる、と書いてある（実物がそうなっている）
      expect(notice, file).toMatch(/id {2,}…[\s\S]*渡した値がそのまま残ります/)
      expect(notice, file).toMatch(/createdAt {2,}…[\s\S]*渡した値がそのまま残ります/)
      // ★ 直す前の断定（3つまとめて「消える・断られる」）が戻ってきたら落ちる
      expect(notice, file).not.toMatch(/この3つと同じ名前/)
      expect(notice, file).not.toMatch(/入れた値が消えたり/)
    }
  })

  // ★ 上の説明が言っていることを、**実物で**固定する（文だけ直しても実物がずれたら同じこと）
  it('★ 実物: id と createdAt は渡した値が残り、_kotoVersion だけが必ず付け替わる', async () => {
    const { mod, dir } = await loadLocal()
    try {
      const saved = await mod.save('docs', {
        id: 'myid', createdAt: '2020-01-01T00:00:00.000Z', _kotoVersion: 'アプリが入れた値', title: 'A',
      })
      expect(saved.id, '渡した id が差し替えられた').toBe('myid')
      expect(saved.createdAt, '渡した createdAt が差し替えられた').toBe('2020-01-01T00:00:00.000Z')
      expect(saved._kotoVersion, '_kotoVersion が Koto の数に置き換わっていない').toBe(1)

      const read = await mod.get('docs', 'myid')
      expect(read.id, '保存された中身でも id が差し替えられている').toBe('myid')
      expect(read.createdAt, '保存された中身でも createdAt が差し替えられている').toBe('2020-01-01T00:00:00.000Z')
      expect(read._kotoVersion).toBe(1)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

// ★ 既に保存されている古いレコード（Koto の版が version に入っている）を壊さない
describe('★ 2026-09-24 以前に保存した1件を、壊さない', () => {
  const writeLegacy = (dir: string, record: Record<string, unknown>) => {
    const d = path.join(dir, DATA_LAYER_LOCAL_DIR, 'entries')
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, `${record.id}.json`), JSON.stringify(record), 'utf8')
  }

  it('★ version に版が入っている古い1件を読んで保存でき、版が巻き戻らない', async () => {
    const { mod, dir } = await loadLocal()
    try {
      // 古い koto-data が保存した形（Koto の版が version に入っている）
      writeLegacy(dir, { id: 'old1', name: '昔の1件', createdAt: '2026-01-01T00:00:00.000Z', version: 5 })

      const read = await mod.get('entries', 'old1')
      const out = await mod.save('entries', { ...read, name: '書き戻し' })
      // ★ 版が 1 から数え直しになると、ずっと前に読んだ写しとたまたま一致して、
      //   断るべき上書きが黙って通る（この仕組みが防ぎたかった事故そのもの）
      expect(out._kotoVersion, '古い1件の版が巻き戻っている').toBe(6)
      expect(await mod.get('entries', 'old1')).toMatchObject({ name: '書き戻し' })

      // ★ 2回目からは、これまでどおり割り込みを検知できる
      const stale = await mod.get('entries', 'old1')
      await mod.save('entries', { ...stale, name: '別のところの変更' })
      await expect(mod.save('entries', { ...stale, name: '私の変更' })).rejects.toThrow(/書き換えられました/)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

// ★ URL のクエリ（?limit=20）も入力フォームも、数値は必ず文字列で届く。
//   黙って無視していたので「次の20件」が1ページ目のまま動かなかった（エラーも出ない）。
describe('★ limit / skip は文字列で渡しても効く', () => {
  it('★ limit: "3" で3件だけ返り、読みに行く回数も減る', async () => {
    const server = fakeS3()
    const mod = await loadCloud(server)
    await seedEntries(mod, 10)
    server.clear()
    const few = await mod.list('entries', { limit: '3' })
    expect(few.map((r: any) => r.name), 'limit が黙って無視されている').toEqual(['09', '08', '07'])
    expect(server.gets(), '文字列の limit でも、読みに行く回数が減る').toBe(4)
  })

  it('★ skip: "5" は5件読み飛ばす（「次の5件」が1ページ目のままにならない）', async () => {
    const { mod, dir } = await loadLocal()
    try {
      await seedEntries(mod, 10)
      const page1 = await mod.list('entries', { limit: '5' })
      const page2 = await mod.list('entries', { limit: '5', skip: '5' })
      expect(page1.map((r: any) => r.seq)).toEqual([9, 8, 7, 6, 5])
      expect(page2.map((r: any) => r.seq), 'skip が黙って無視されている').toEqual([4, 3, 2, 1, 0])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('★ 数として読めない limit / skip は、黙って無視せず断る', async () => {
    const { mod, dir } = await loadLocal()
    try {
      await seedEntries(mod, 3)
      await expect(mod.list('entries', { limit: 'たくさん' })).rejects.toThrow(/limit には数を指定/)
      await expect(mod.list('entries', { skip: {} })).rejects.toThrow(/skip には数を指定/)
      await expect(mod.list('entries', { limit: true })).rejects.toThrow(/limit には数を指定/)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('★ 渡していないとき（undefined・null・空文字）は、今までどおり全部・新しい順', async () => {
    const { mod, dir } = await loadLocal()
    try {
      await seedEntries(mod, 3)
      const expected = [2, 1, 0]
      expect((await mod.list('entries')).map((r: any) => r.seq)).toEqual(expected)
      expect((await mod.list('entries', { limit: undefined, skip: undefined })).map((r: any) => r.seq)).toEqual(expected)
      expect((await mod.list('entries', { limit: null, skip: null })).map((r: any) => r.seq)).toEqual(expected)
      expect((await mod.list('entries', { limit: '', skip: '' })).map((r: any) => r.seq)).toEqual(expected)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  // ★ 黙って無視すると、「自分の投稿だけ」のつもりの一覧に**全員の投稿が出る**
  it('★ where にオブジェクトを渡すと断る（絞り込まないまま全件を返さない）', async () => {
    const { mod, dir } = await loadLocal()
    try {
      await seedEntries(mod, 5)
      const err = await mod.list('entries', { where: { seq: 1 } }).then(() => null, (e: Error) => e)
      expect(err, 'where が黙って無視され、全件が返っている').not.toBeNull()
      expect(String((err as Error).message)).toContain('where には関数を指定してください')
      // 関数なら、今までどおり効く
      expect((await mod.list('entries', { where: (r: any) => r.seq === 1 })).map((r: any) => r.seq)).toEqual([1])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

// ★ 予定表アプリが曜日や時刻を id にするのは普通の書き方（日曜=0、0時=0）。
//   0 を「id が無い」と見なしていたので、保存は成功するのに読み直すと null で、
//   入れ直すたびに同じ内容が別の id で増え続けた（エラーは一度も出ない）。
describe('★ id に 0 を渡しても、その id で保存する', () => {
  it('★ save({ id: 0 }) は 0 のままで、get(0) で読み直せる', async () => {
    const { mod, dir } = await loadLocal()
    try {
      const sunday = await mod.save('slots', { id: 0, name: '日曜の予定' })
      expect(sunday.id, '0 が「id が無い」と見なされて差し替えられた').toBe(0)
      expect(await mod.get('slots', 0), '保存できたのに読み直せない').toMatchObject({ name: '日曜の予定' })

      // ★ 同じ id で入れ直しても「更新」になる（同じ内容が増え続けない）
      const read = await mod.get('slots', 0)
      await mod.save('slots', { ...read, name: '日曜の予定（変更）' })
      expect(await mod.list('slots'), '同じ内容のレコードが増えている').toHaveLength(1)
      expect(await mod.get('slots', 0)).toMatchObject({ name: '日曜の予定（変更）' })
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('★ id を渡さない・null・空文字のときは、今までどおり Koto が付ける', async () => {
    const { mod, dir } = await loadLocal()
    try {
      const made = [
        await mod.save('entries', { n: 1 }),
        await mod.save('entries', { id: null, n: 2 }),
        await mod.save('entries', { id: '', n: 3 }),
      ]
      for (const r of made) expect(r.id, 'Koto が id を付けていない').toMatch(/^[0-9a-z]{10}-[0-9a-f]{16}$/)
      expect(await mod.list('entries')).toHaveLength(3)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

// ★ 一覧の1ページ目を見ている間に、別の人が新しい2件を消す → 「次へ」を押すと
//   1ページ目と同じ件がもう一度出ていた（速い道は id の並びで skip を数えており、
//   遅い道は読めた件で数えていたので、道によって答えが違った）。
describe('★ skip を付けたページ送りで、同じ件が2ページに出ない', () => {
  it('★ 読めない件があっても、速い道と遅い道が同じ答えを返す', async () => {
    const { mod, dir } = await loadLocal()
    try {
      const saved = await seedEntries(mod, 10)
      // 新しいほうの2件が「一覧には出るが読めない」（消された直後・中身が壊れている）
      for (const r of [saved[9], saved[8]]) {
        fs.writeFileSync(path.join(dir, DATA_LAYER_LOCAL_DIR, 'entries', `${r.id}.json`), '{壊れた', 'utf8')
      }
      const page1 = await mod.list('entries', { limit: 3 })
      const page2 = await mod.list('entries', { limit: 3, skip: 3 })
      expect(page1.map((r: any) => r.seq)).toEqual([7, 6, 5])
      expect(page2.map((r: any) => r.seq), '1ページ目と重なっている').toEqual([4, 3, 2])

      // 遅い道（where を付けた全件読み）と、同じ答えであること
      const slow = await mod.list('entries', { limit: 3, skip: 3, where: () => true })
      expect(page2.map((r: any) => r.seq)).toEqual(slow.map((r: any) => r.seq))

      // ★ 利用者が「次へ」を押して、同じ件をもう一度見ないこと
      const again = page1.filter((r: any) => page2.some((p: any) => p.id === r.id))
      expect(again.map((r: any) => r.seq), '同じ件が2ページに出ている').toEqual([])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('★ 読めない件が無いときは、これまでどおりページが続く', async () => {
    const { mod, dir } = await loadLocal()
    try {
      await seedEntries(mod, 10)
      expect((await mod.list('entries', { limit: 4 })).map((r: any) => r.seq)).toEqual([9, 8, 7, 6])
      expect((await mod.list('entries', { limit: 4, skip: 4 })).map((r: any) => r.seq)).toEqual([5, 4, 3, 2])
      expect((await mod.list('entries', { limit: 4, skip: 8 })).map((r: any) => r.seq)).toEqual([1, 0])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

// ── ⑪ 2巡目の検分で見つかった取りこぼし（2026-09-25）──────────────────────
// 1巡目で直したものの**隣**に、同じ形が残っていた。ここも全部、手元のフォルダと
// 偽サーバに実際に流して固定する（掟10。ソースの文字列一致では1つも捕まらない）。

// ★ 1巡目は limit / skip / where だけを「黙って無視せず断る」にして、**同じ options の
//   隣にある order と sort は従来どおり黙って捨てていた**。実測では `{ order: 'ASC' }` が
//   `c,b,a`（頼んだのと逆の並び）で返り、エラーも出なかった——「次の20件が1ページ目の
//   まま動かない」とまったく同じ形。`?order=ASC` や <select> の値は大文字で届くのが普通。
describe('★ order / sort も、黙って捨てずに断る（limit・skip・where と同じ入口）', () => {
  /** a（古い）→ b → c（新しい）の3件。並びが逆になれば name で分かる。 */
  async function seedThree(mod: Mod) {
    for (const [name, at] of [['a', '2026-01-01'], ['b', '2026-02-01'], ['c', '2026-03-01']]) {
      await mod.save('s', { name, createdAt: `${at}T00:00:00.000Z` })
    }
  }
  const names = (rows: any[]) => rows.map((r: any) => r.name)

  it('★ { order: "ASC" } は断る（黙って逆の並びを返さない）', async () => {
    const { mod, dir } = await loadLocal()
    try {
      await seedThree(mod)
      const err = await mod.list('s', { order: 'ASC' }).then(() => null, (e: Error) => e)
      expect(err, 'order が黙って捨てられ、頼んだのと逆の並びが返っている').not.toBeNull()
      const message = String((err as Error).message)
      expect(message).toContain("order には 'asc' か 'desc'")
      expect(message).toContain('ASC') // 何を直せばよいか分かること
      // 大文字以外の書き間違いも同じく断る
      await expect(mod.list('s', { order: 'ascending' })).rejects.toThrow(/order には/)
      await expect(mod.list('s', { order: 1 })).rejects.toThrow(/order には/)
      await expect(mod.list('s', { sort: 'name', order: 'DESC' })).rejects.toThrow(/order には/)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('★ { sort: 123 } は断る（並べ替えが効かないまま新しい順で返さない）', async () => {
    const { mod, dir } = await loadLocal()
    try {
      await seedThree(mod)
      await expect(mod.list('s', { sort: 123 })).rejects.toThrow(/sort には/)
      await expect(mod.list('s', { sort: { name: 1 } })).rejects.toThrow(/sort には/)
      await expect(mod.list('s', { sort: true })).rejects.toThrow(/sort には/)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('★ 今までどおりの呼び方は、今までどおり効く（断りすぎていない）', async () => {
    const { mod, dir } = await loadLocal()
    try {
      await seedThree(mod)
      expect(names(await mod.list('s', { order: 'asc' }))).toEqual(['a', 'b', 'c'])
      expect(names(await mod.list('s', { order: 'desc' }))).toEqual(['c', 'b', 'a'])
      expect(names(await mod.list('s', { sort: 'name', order: 'desc' }))).toEqual(['c', 'b', 'a'])
      // 渡していないとき（undefined・null・空文字）は、今までどおり「全部・新しい順」
      expect(names(await mod.list('s'))).toEqual(['c', 'b', 'a'])
      expect(names(await mod.list('s', { order: undefined, sort: undefined }))).toEqual(['c', 'b', 'a'])
      expect(names(await mod.list('s', { order: null, sort: null }))).toEqual(['c', 'b', 'a'])
      expect(names(await mod.list('s', { order: '', sort: '' }))).toEqual(['c', 'b', 'a'])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  // ★ 断る判定を足したせいで、速い道（読む前に選ぶ）へ入れなくなっていないこと
  it('★ 確かめたあとの order / sort でも、速い道は今までどおり使える', async () => {
    const server = fakeS3()
    const mod = await loadCloud(server)
    await seedEntries(mod, 10)
    server.clear()
    const few = await mod.list('entries', { limit: 3, order: 'desc' })
    expect(few.map((r: any) => r.name)).toEqual(['09', '08', '07'])
    expect(server.gets(), 'order: desc を付けただけで全件読みへ落ちている').toBe(4)
  })
})

// ★ `!record.id` を直したすぐ次の行に、まったく同じ偽値判定（`!record.createdAt`）が
//   残っていた。実測: save('c', { id:'a', createdAt: 0 }) で createdAt が現在時刻へ
//   差し替わる。`Number(form.createdAt)` は空欄で 0 になるので、普通に踏む。
describe('★ createdAt に 0 や空文字を渡しても、id と同じ見分け方をする', () => {
  it('★ save({ createdAt: 0 }) は 0 のまま残る', async () => {
    const { mod, dir } = await loadLocal()
    try {
      const saved = await mod.save('c', { id: 'a', createdAt: 0, name: 'A' })
      expect(saved.createdAt, '渡した createdAt が現在時刻へ差し替わっている').toBe(0)
      expect((await mod.get('c', 'a')).createdAt, '保存された中身でも差し替わっている').toBe(0)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('★ 渡していないとき（undefined・null・空文字）は、今までどおり Koto が入れる', async () => {
    const { mod, dir } = await loadLocal()
    try {
      const made = [
        await mod.save('c', { id: 'x1', name: 'A' }),
        await mod.save('c', { id: 'x2', createdAt: null }),
        await mod.save('c', { id: 'x3', createdAt: '' }),
      ]
      for (const r of made) {
        expect(r.createdAt, 'Koto が保存した日時を入れていない').toMatch(/^\d{4}-\d{2}-\d{2}T/)
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

// ★ `isNew` を「渡されていない」判定に変えた副作用。**偽値だが id として不適切な値が、
//   そのまま id として保存される**ようになっていた。実測: save('c', { id: NaN }) は
//   safeName が String(NaN)='NaN' を通すので NaN.json に保存され、返り値と中身の id は
//   null（JSON にすると NaN は null）。`id: Number(params.id)` がパラメータを数として
//   読めないとき、**そのコレクションの全員が NaN.json を上書きし合う**。
describe('★ id に、ファイル名にできない値を渡したら断る', () => {
  it('★ save({ id: NaN }) は断る（全員が NaN.json を上書きし合わない）', async () => {
    const { mod, dir } = await loadLocal()
    try {
      const err = await mod.save('c', { id: NaN, name: 'A' }).then(() => null, (e: Error) => e)
      expect(err, 'NaN が id として保存された').not.toBeNull()
      const message = String((err as Error).message)
      expect(message).toContain('id には')
      // ★ JSON.stringify(NaN) は "null" になる。null は「渡していない」として受け入れる値
      //   なので、そう出ると何を直せばよいか分からない
      expect(message, '断る言葉が null と言っている').not.toContain('null')
      expect(message).toContain('NaN')
      // 保存されていないこと（NaN.json ができていない）
      expect(fs.existsSync(path.join(dir, DATA_LAYER_LOCAL_DIR, 'c')), 'NaN で保存されている').toBe(false)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('★ 真偽値の id も断る（false.json に入れない）', async () => {
    const { mod, dir } = await loadLocal()
    try {
      await expect(mod.save('c', { id: false, name: 'A' })).rejects.toThrow(/id には/)
      await expect(mod.save('c', { id: true, name: 'A' })).rejects.toThrow(/id には/)
      await expect(mod.save('c', { id: { a: 1 } })).rejects.toThrow(/id には/)
      expect(fs.existsSync(path.join(dir, DATA_LAYER_LOCAL_DIR, 'c'))).toBe(false)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  // ★ 断りすぎていないこと。0 は通し続ける（日曜＝0・0時＝0 は普通の書き方）
  it('★ save({ id: 0 }) は今までどおり通り、get(0) で読み直せる', async () => {
    const { mod, dir } = await loadLocal()
    try {
      const sunday = await mod.save('slots', { id: 0, name: '日曜の予定' })
      expect(sunday.id).toBe(0)
      expect(await mod.get('slots', 0)).toMatchObject({ name: '日曜の予定' })
      // 文字列の id も、これまでどおり
      expect((await mod.save('slots', { id: 'dates', name: '一覧' })).id).toBe('dates')
      // おかしな文字は、これまでどおり「保存先の名前」で断る
      await expect(mod.save('slots', { id: '../x' })).rejects.toThrow(/保存先の名前/)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

// ★ NaN を断るときのメッセージが、**受け入れる値と同じ文字**（null）を表示していた。
//   加えて `list('entries', { limit: Number(req.query.limit) })` はクエリが無ければ
//   必ず NaN になるので、断ると**版の差し替えが届いた瞬間に、いま動いている公開済み
//   アプリの一覧が例外で落ちる**。NaN は「渡していない」と同じ既定に倒す。
describe('★ Number(クエリ) が作る NaN で、動いているアプリを止めない', () => {
  it('★ { limit: Number(undefined) } は、渡していないのと同じ（全部・新しい順）', async () => {
    const { mod, dir } = await loadLocal()
    try {
      await seedEntries(mod, 3)
      const expected = [2, 1, 0]
      const query: Record<string, string> = {} // クエリが付いていない要求
      expect((await mod.list('entries', { limit: Number(query.limit) })).map((r: any) => r.seq)).toEqual(expected)
      expect((await mod.list('entries', { skip: Number(query.skip) })).map((r: any) => r.seq)).toEqual(expected)
      expect((await mod.list('entries', { limit: NaN, skip: NaN })).map((r: any) => r.seq)).toEqual(expected)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('★ 数として読めないものは、これまでどおり断る（NaN だけを通したのではない）', async () => {
    const { mod, dir } = await loadLocal()
    try {
      await seedEntries(mod, 3)
      await expect(mod.list('entries', { limit: 'たくさん' })).rejects.toThrow(/limit には数を指定/)
      await expect(mod.list('entries', { skip: {} })).rejects.toThrow(/skip には数を指定/)
      await expect(mod.list('entries', { limit: true })).rejects.toThrow(/limit には数を指定/)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('★ 断る言葉が、受け入れる値（null）と同じ文字にならない', async () => {
    const { mod, dir } = await loadLocal()
    try {
      await seedEntries(mod, 3)
      // Infinity も JSON.stringify では "null" になる（NaN と同じ罠）
      const err = await mod.list('entries', { limit: Infinity }).then(() => null, (e: Error) => e)
      expect(err, 'Infinity が件数として通っている').not.toBeNull()
      const message = String((err as Error).message)
      expect(message, '断る言葉が null と言っている').not.toContain('null')
      expect(message).toContain('Infinity')
      // null は「渡していない」として受け入れる値のままであること
      expect((await mod.list('entries', { limit: null })).length).toBe(3)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  // ★ where の断り文は、実測で文字列を渡したときにも出る。「オブジェクトでは」は嘘だった
  it('★ where の断り文が、渡した形に関わらず正しい（文字列でも「オブジェクト」と言わない）', async () => {
    const { mod, dir } = await loadLocal()
    try {
      await seedEntries(mod, 3)
      for (const bad of ['x', 123, { seq: 1 }]) {
        const err = await mod.list('entries', { where: bad }).then(() => null, (e: Error) => e)
        expect(err, `where: ${JSON.stringify(bad)} が黙って無視されている`).not.toBeNull()
        const message = String((err as Error).message)
        expect(message).toContain('where には関数を指定してください')
        expect(message, '文字列や数を渡したのに「オブジェクトでは」と言っている').not.toContain('オブジェクトでは')
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

// ★ 速い道の skip は「読み飛ばす分も実際に読む」ので、**読みに行く回数が skip に比例する**。
//   冒頭の説明はこれを書いていなかった（tests/kotoDataTemplate.test.ts が文を固定する）。
//   ここでは**偽サーバに流して回数そのもの**を固定する——文だけ直しても、実物が
//   これと違えば同じ嘘になる。
describe('★ skip を付けると、読みに行く回数が skip に比例する', () => {
  it('★ 後ろのページほど読む件数が増える（skip ＋ limit 件）', async () => {
    const server = fakeS3()
    const mod = await loadCloud(server)
    await seedEntries(mod, 30)

    const countFor = async (options: Record<string, unknown>) => {
      server.clear()
      await mod.list('entries', options)
      return server.gets()
    }
    expect(await countFor({ limit: 5 }), '一覧1回＋5件').toBe(6)
    expect(await countFor({ limit: 5, skip: 5 }), '一覧1回＋10件').toBe(11)
    expect(await countFor({ limit: 5, skip: 20 }), '一覧1回＋25件').toBe(26)
    // 最後のページは、全件読みとほとんど変わらない
    expect(await countFor({ limit: 5, skip: 25 }), '一覧1回＋30件').toBe(31)
    expect(await countFor({}), '全件読み').toBe(31)
  })
})
