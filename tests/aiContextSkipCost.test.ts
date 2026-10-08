import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { IDE_CONTEXT } from '../src/renderer/aiContext'

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-25 検分の指摘V7: **AI へ毎リクエスト送られる説明が、実物より先に古くなった。**
//
// 以前の速い道は「読み飛ばす分は読まない」形だったので、skip は本当に安かった。
// いまは templates/koto-data.js が `let cursor = 0` / `let left = skip` で
// **読み飛ばす分も実際に読みに行く**（そうしないと、消された直後の件・壊れた件を
// 「読み飛ばせた」と数えてしまい、同じ件が2ページに重なって出る）。
// ところが src/renderer/aiContext.ts の説明だけが「通信が減るのは limit（と skip）だけ」
// のまま残り、これを読んだ AI は「ページ送りは skip で安く済む」前提でページャを書く。
// 公開したアプリは後ろのページほど遅くなり、1バケット毎秒100アクセスの上限に近づく。
//
// ── このテストの流儀（掟10）──────────────────────────────────────────
// 文面を文字列で固定するだけでは、**また実物だけが変わったときに素通りする**
// （実際、旧文面を固定していた tests/dataLayerPromise.test.ts は26件すべて緑のままだった）。
// そこで **templates/koto-data.js を偽サーバに実際に流して読みに行った回数を数え**、
// その数が IDE_CONTEXT に書いてある数と一致することを見る。
// どちらを変えても、もう片方を直すまで落ちる＝「文と実物を離さない」。
//
// templates/ は読むだけ（書き換えない）。さくらへは一切通信しない。
// ─────────────────────────────────────────────────────────────────────────────

const TEMPLATE = path.resolve(__dirname, '../templates/koto-data.js')

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

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); vi.restoreAllMocks()
})

/** 偽のオブジェクトストレージ。**送られた要求を全部控える。** */
function fakeS3() {
  const objects = new Map<string, string>()
  const requests: { method: string; url: string }[] = []
  const reply = (status: number, text: string) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  })
  const fetchImpl = async (url: string, init: any) => {
    const method = String(init?.method ?? 'GET')
    requests.push({ method, url })
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
    install: () => vi.stubGlobal('fetch', fetchImpl),
    gets: () => requests.filter(r => r.method === 'GET').length,
    clear: () => { requests.length = 0 },
  }
}

/**
 * 待ち（かたまりの間の CHUNK_PAUSE_MS）は数えるだけで実際には待たない。
 * 実時間に依るテストにしないため（tests/kotoDataOptions.test.ts と同じ作法）。
 */
function noRealPauses() {
  const real = globalThis.setTimeout
  vi.stubGlobal('setTimeout', (fn: (...a: any[]) => void, _ms?: number, ...rest: any[]) => real(fn, 0, ...rest))
}

async function loadCloud(server: ReturnType<typeof fakeS3>) {
  setEnv(ENV)
  server.install()
  noRealPauses()
  vi.resetModules()
  const mod = await import(TEMPLATE) as Record<string, any>
  expect(mod.storageMode()).toBe('cloud')
  return mod
}

async function seed(mod: Record<string, any>, n: number) {
  vi.useFakeTimers()
  try {
    const base = Date.parse('2026-09-25T00:00:00.000Z')
    for (let i = 0; i < n; i++) {
      vi.setSystemTime(new Date(base + i))
      await mod.save('entries', { name: String(i).padStart(2, '0') })
    }
  } finally { vi.useRealTimers() }
}

describe('AI への説明文が、skip の代償について実物と同じことを言っている（指摘V7）', () => {
  it('★ 実物で数えた回数（1ページ目21回／2ページ目41回）が、そのまま説明文に書いてある', async () => {
    const server = fakeS3()
    const mod = await loadCloud(server)
    await seed(mod, 60)

    // 1ページ目: 一覧1回＋20件
    server.clear()
    const page1 = await mod.list('entries', { limit: 20, skip: 0 })
    expect(page1).toHaveLength(20)
    const firstPageReads = server.gets()
    expect(firstPageReads).toBe(21)

    // 2ページ目: **読み飛ばす20件も実際に読みに行く**ので 一覧1回＋40件
    server.clear()
    const page2 = await mod.list('entries', { limit: 20, skip: 20 })
    expect(page2).toHaveLength(20)
    const secondPageReads = server.gets()
    expect(secondPageReads).toBe(41)
    // 重なっていない（そもそも「読み飛ばす分も読む」に変えた理由がこれ）
    expect(page2.map((r: any) => r.name)).not.toContain(page1[19].name)

    // ★ 数えた回数が、AI へ送る説明文にそのまま書いてあること。
    //   実物を変えれば（41 が変われば）ここで落ちる＝説明だけ古くなれない
    expect(IDE_CONTEXT).toContain(`${firstPageReads}回`)
    expect(IDE_CONTEXT).toContain(`{ limit: 20, skip: 20 } は${secondPageReads}回`)
  })

  it('★ 「skip も通信を減らす」と読める書き方が戻ってきたら落ちる', () => {
    // 直す前の文面そのもの
    expect(IDE_CONTEXT).not.toContain('通信が減るのは limit（と skip）だけです')
    expect(IDE_CONTEXT).not.toContain('速くしたいとき（通信が減る）: await list(\'entries\', { limit: 20, skip: 0 })')
    // 代償は「回数つき」で書いてある（skip ＋ limit 件読む、という言い切り）
    expect(IDE_CONTEXT).toContain('skip は減らしません')
    expect(IDE_CONTEXT).toContain('skip ＋ limit')
    expect(IDE_CONTEXT).toContain('ページを送るほど遅くなります')
    // where / sort は従来どおり「減らない」と書いてある（ここは変えていない）
    expect(IDE_CONTEXT).toContain('where や sort を一緒に付けると、limit を付けていても全件を読みます')
  })

  it('★ テンプレート冒頭（利用者向け）と同じ事実・同じ数字である（文を2か所に離さない）', () => {
    const template = fs.readFileSync(TEMPLATE, 'utf8')
    for (const fact of [
      'skip を付けると、読み飛ばす分も実際に読みに行きます',
      'skip ＋ limit',
      'ページを送るほど遅くなります',
    ]) {
      expect(template, `テンプレート冒頭: ${fact}`).toContain(fact)
    }
    // 「全部読むのと同じ」になる例（1,001回）を、両方が挙げている
    expect(template).toContain('{ limit: 20, skip: 980 }')
    expect(IDE_CONTEXT).toContain('{ limit: 20, skip: 980 } は1,001回')
  })
})
