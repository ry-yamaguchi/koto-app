import { describe, it, expect } from 'vitest'
import {
  runOsvCheck, OSV_QUERYBATCH_URL, OSV_VULN_URL_PREFIX, type OsvRunOptions,
} from '../src/main/cloud/osvClient'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as LIMITS from '../src/shared/osvLimits'
import {
  OSV_DETAIL_CONCURRENCY, OSV_BATCH_REPLY_LIMIT_BYTES, OSV_DETAIL_REPLY_LIMIT_BYTES,
} from '../src/shared/osvLimits'

interface Call { url: string; init: RequestInit }
type Handler = (url: string, init: RequestInit, n: number) => Response | Promise<Response>

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function fake(handler: Handler): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return handler(String(url), init ?? {}, calls.length - 1)
  }) as typeof fetch
  return { fetchImpl, calls }
}

const depsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ name: 'pkg' + String(i).padStart(5, '0'), version: '1.0.0' }))
const queriesOf = (c: Call) => (JSON.parse(String(c.init.body)) as { queries: Array<Record<string, unknown>> }).queries
const posts = (calls: Call[]) => calls.filter((c) => c.url === OSV_QUERYBATCH_URL)
const gets = (calls: Call[]) => calls.filter((c) => c.url.startsWith(OSV_VULN_URL_PREFIX))
const emptyReply = (c: Call) => ({ results: queriesOf(c).map(() => ({})) })

const V1 = {
  id: 'GHSA-rv95-896h-c2vc',
  summary: 'SUMMARY-TEXT',
  details: 'DETAILS-TEXT',
  database_specific: { severity: 'MODERATE' },
  affected: [
    { package: { name: 'express', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.19.2' }] }] },
    { package: { name: 'express', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '5.0.0-alpha.1' }, { fixed: '5.0.0-beta.3' }] }] },
  ],
}
const detailFor = (id: string, fixed: string, extra: Record<string, unknown> = {}) => ({
  id,
  summary: 'SUMMARY-TEXT',
  details: 'DETAILS-TEXT',
  affected: [{ package: { name: 'express', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed }] }] }],
  ...extra,
})

/** 1件めだけに弱点がある照会の応答と、ID ごとの詳細を返す */
function vulnHandler(ids: string[], details: Record<string, unknown>): Handler {
  return (url, init) => {
    if (url === OSV_QUERYBATCH_URL) {
      const qs = (JSON.parse(String(init.body)) as { queries: unknown[] }).queries
      return json({ results: qs.map((_, i) => (i === 0 ? { vulns: ids.map((id) => ({ id })) } : {})) })
    }
    const id = url.slice(OSV_VULN_URL_PREFIX.length)
    return id in details ? json(details[id]) : json({ code: 5, message: 'Vulnerability not found' }, 404)
  }
}

const run = (o: Partial<OsvRunOptions> & Pick<OsvRunOptions, 'fetchImpl'>) =>
  runOsvCheck({ consented: true, deps: [{ name: 'express', version: '4.17.1' }], ...o })

describe('宛先と上限の値（文字列・数値そのもので固定）', () => {
  it('外へ出る宛先は api.osv.dev の2つだけ', () => {
    expect(OSV_QUERYBATCH_URL).toBe('https://api.osv.dev/v1/querybatch')
    expect(OSV_VULN_URL_PREFIX).toBe('https://api.osv.dev/v1/vulns/')
  })
  it('src の中で api.osv.dev を書くのは osvClient.ts だけ', () => {
    const hits: string[] = []
    const srcDir = path.join(__dirname, '..', 'src')
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name) && fs.readFileSync(p, 'utf8').includes('api.osv.dev')) hits.push(path.relative(srcDir, p))
      }
    }
    walk(srcDir)
    expect(hits).toEqual([path.join('main', 'cloud', 'osvClient.ts')])
  })
  it('上限の値', () => {
    expect(LIMITS.OSV_BATCH_REPLY_LIMIT_BYTES).toBe(8_000_000)
    expect(LIMITS.OSV_DETAIL_REPLY_LIMIT_BYTES).toBe(2_000_000)
    expect(LIMITS.OSV_DETAIL_CONCURRENCY).toBe(6)
    expect(LIMITS.OSV_BATCH_TIMEOUT_MS).toBe(20_000)
    expect(LIMITS.OSV_DETAIL_TIMEOUT_MS).toBe(10_000)
    expect(LIMITS.LOCKFILE_READ_LIMIT_BYTES).toBe(16_000_000)
    expect(LIMITS.MANIFEST_READ_LIMIT_BYTES).toBe(1_000_000)
  })
})

describe('sent は、要求が届いた回だけ数える', () => {
  it('時間切れは sent 0', async () => {
    const { fetchImpl } = fake(() => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }) })
    expect(await run({ fetchImpl })).toMatchObject({ sent: 0, stop: { reason: 'timeout' } })
  })
  it('HTTP エラーは応答があったので数える', async () => {
    const { fetchImpl } = fake(() => json({}, 500))
    expect(await run({ fetchImpl })).toMatchObject({ sent: 1, stop: { reason: 'http' } })
  })
})

describe('同意', () => {
  it.each([[false], [undefined], ['true'], [1]])('consented=%j なら通信しない', async (v) => {
    const { fetchImpl, calls } = fake(() => json({}))
    const r = await runOsvCheck({ consented: v as any, deps: depsOf(3), fetchImpl })
    expect(calls).toHaveLength(0)
    expect(r).toEqual({ kind: 'not-consented' })
  })
})

describe('照会の要求の形', () => {
  it('URL・メソッド・ヘッダ・転送・本文が決まったとおり', async () => {
    const { fetchImpl, calls } = fake((_u, _i) => json({ results: [{}, {}] }))
    await run({ fetchImpl, deps: [{ name: '@babel/traverse', version: '7.0.0' }, { name: 'express', version: '4.17.1' }] })
    expect(calls).toHaveLength(1)
    const c = calls[0]
    expect(c.url).toBe(OSV_QUERYBATCH_URL)
    expect(c.init.method).toBe('POST')
    expect(Object.keys(c.init.headers as Record<string, string>).sort()).toEqual(['accept', 'content-type'])
    expect(c.init.redirect).toBe('error')
    expect(c.init.signal).toBeTruthy()
    expect(JSON.parse(String(c.init.body))).toStrictEqual({
      queries: [
        { package: { name: '@babel/traverse', ecosystem: 'npm' }, version: '7.0.0' },
        { package: { name: 'express', ecosystem: 'npm' }, version: '4.17.1' },
      ],
    })
  })
  it('1,200 件は 500・500・200 の3回', async () => {
    const { fetchImpl, calls } = fake((_u, i) => json({ results: queriesOf({ url: '', init: i }).map(() => ({})) }))
    const deps = depsOf(1200)
    const r = await run({ fetchImpl, deps })
    expect(posts(calls).map((c) => queriesOf(c).length)).toEqual([500, 500, 200])
    expect(queriesOf(calls[1])[0]).toMatchObject({ package: { name: deps[500].name } })
    expect(r).toMatchObject({ kind: 'done', total: 1200, sent: 1200, checked: 1200, stop: null })
  })
  it('5,300 件は 10 回で sent 5,000・total 5,300', async () => {
    const { fetchImpl, calls } = fake((_u, i) => json({ results: queriesOf({ url: '', init: i }).map(() => ({})) }))
    const r = await run({ fetchImpl, deps: depsOf(5300) })
    expect(posts(calls)).toHaveLength(10)
    expect(r).toMatchObject({ total: 5300, sent: 5000, checked: 5000 })
  })
  it('応答の順序どおりにライブラリへ割り当たる', async () => {
    const { fetchImpl } = fake((u, i) => {
      if (u === OSV_QUERYBATCH_URL) return json({ results: [{}, { vulns: [{ id: 'GHSA-aaaa' }] }, {}] })
      return json({ id: 'GHSA-aaaa', affected: [] })
    })
    const deps = [{ name: 'a', version: '1.0.0' }, { name: 'b', version: '2.0.0' }, { name: 'c', version: '3.0.0' }]
    const r = await run({ fetchImpl, deps })
    expect(r.kind === 'done' && r.findings.map((f) => f.name)).toEqual(['b'])
  })
})

describe('続き', () => {
  it('next_page_token の項目だけが page_token つきで次に入り、ids が足される', async () => {
    const { fetchImpl, calls } = fake((u, init, n) => {
      if (u !== OSV_QUERYBATCH_URL) return json({ id: 'A-1', affected: [] })
      if (n === 0) return json({ results: [{ vulns: [{ id: 'A-1' }], next_page_token: 'tok1' }, {}, { vulns: [{ id: 'C-1' }] }] })
      return json({ results: [{ vulns: [{ id: 'A-2' }] }] })
    })
    const deps = [{ name: 'a', version: '1.0.0' }, { name: 'b', version: '1.0.0' }, { name: 'c', version: '1.0.0' }]
    const r = await run({ fetchImpl, deps })
    expect(queriesOf(calls[1])).toStrictEqual([{ package: { name: 'a', ecosystem: 'npm' }, version: '1.0.0', page_token: 'tok1' }])
    expect(r.kind === 'done' && r.findings.find((f) => f.name === 'a')?.vulns.map((v) => v.id)).toEqual(['A-1', 'A-2'])
    expect(r).toMatchObject({ checked: 3, stop: null })
  })
  it('3回使い切っても続きがある項目は checked に数えず、stop は null', async () => {
    const { fetchImpl, calls } = fake((u, _i, n) => {
      if (u !== OSV_QUERYBATCH_URL) return json({ id: 'A-1', affected: [] })
      return json({ results: [{ vulns: [{ id: 'A-' + n }], next_page_token: 't' + n }] })
    })
    const r = await run({ fetchImpl, deps: [{ name: 'a', version: '1.0.0' }] })
    expect(posts(calls)).toHaveLength(4)
    expect(r).toMatchObject({ kind: 'done', checked: 0, stop: null })
    expect(r.kind === 'done' && r.findings[0].vulns.map((v) => v.id)).toEqual(['A-0', 'A-1', 'A-2', 'A-3'])
  })
})

describe('失敗', () => {
  it('2組めの TypeError は offline・checked 500・3組めは送らず・1組めは残る・詳細は0回', async () => {
    const { fetchImpl, calls } = fake((u, init, n) => {
      if (n === 0) return json({ results: queriesOf({ url: '', init }).map((_, i) => (i === 0 ? { vulns: [{ id: 'GHSA-aaaa' }] } : {})) })
      throw new TypeError('fetch failed')
    })
    const r = await run({ fetchImpl, deps: depsOf(1200) })
    expect(posts(calls)).toHaveLength(2)
    expect(gets(calls)).toHaveLength(0)
    expect(r).toMatchObject({ kind: 'done', checked: 500, stop: { reason: 'offline' } })
    expect(r.kind === 'done' && r.findings).toHaveLength(1)
    expect(r.kind === 'done' && r.findings[0].vulns[0].detail).toBe('not-fetched')
  })
  it('TimeoutError は timeout', async () => {
    const { fetchImpl } = fake(() => { throw new DOMException('x', 'TimeoutError') })
    const r = await run({ fetchImpl })
    expect(r).toMatchObject({ stop: { reason: 'timeout' } })
  })
  it('400 は http で detail に HTTP 400', async () => {
    const { fetchImpl } = fake(() => json({ code: 3, message: 'error in query at index 0: rpc error: code = InvalidArgument desc = invalid ecosystem' }, 400))
    const r = await run({ fetchImpl })
    expect(r.kind === 'done' && r.stop?.reason).toBe('http')
    expect(r.kind === 'done' && r.stop?.detail).toContain('HTTP 400')
  })
  it('302 は http（転送を追わない）', async () => {
    const { fetchImpl } = fake(() => new Response(null, { status: 302, headers: { location: 'https://example.invalid/' } }))
    const r = await run({ fetchImpl })
    expect(r.kind === 'done' && r.stop?.reason).toBe('http')
  })
  it('results の長さ違いは shape', async () => {
    const { fetchImpl } = fake(() => json({ results: [{}, {}] }))
    expect((await run({ fetchImpl })).kind === 'done').toBe(true)
    const r = await run({ fetchImpl })
    expect(r).toMatchObject({ stop: { reason: 'shape' }, checked: 0 })
  })
  it('JSON でない応答は shape', async () => {
    const { fetchImpl } = fake(() => new Response('<html>', { status: 200 }))
    const r = await run({ fetchImpl })
    expect(r).toMatchObject({ stop: { reason: 'shape' } })
  })
  it('上限より大きい本文は全部読む前に打ち切る（too-large）', async () => {
    const chunk = new Uint8Array(1_000_000).fill(32)
    let pushed = 0
    let cancelled = false
    const { fetchImpl } = fake(() => new Response(new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (pushed >= 100) { ctrl.close(); return }
        pushed++
        ctrl.enqueue(chunk)
      },
      cancel() { cancelled = true },
    }), { status: 200 }))
    const r = await run({ fetchImpl })
    expect(r).toMatchObject({ stop: { reason: 'too-large' } })
    expect(cancelled).toBe(true)
    expect(pushed * chunk.byteLength).toBeLessThan(OSV_BATCH_REPLY_LIMIT_BYTES + 4 * chunk.byteLength)
  })
  it('fetch が何を投げても例外を外へ出さない', async () => {
    for (const thrown of [new Error('x'), 'str', null, undefined, 42]) {
      const { fetchImpl } = fake(() => { throw thrown })
      const r = await run({ fetchImpl })
      expect(r.kind).toBe('done')
    }
  })
})

describe('詳細', () => {
  const ids35 = Array.from({ length: 35 }, (_, i) => 'GHSA-' + String(i).padStart(4, '0'))
  it('35 種類なら GET は 30 回・残り5つは not-fetched・同時数と要求の形', async () => {
    let active = 0
    let maxActive = 0
    const base = vulnHandler(ids35, {})
    const { fetchImpl, calls } = fake(async (u, init, n) => {
      if (u === OSV_QUERYBATCH_URL) return base(u, init, n)
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((res) => setTimeout(res, 5))
      active--
      return json({ id: u.slice(OSV_VULN_URL_PREFIX.length), affected: [] })
    })
    const r = await run({ fetchImpl })
    expect(gets(calls)).toHaveLength(30)
    expect(gets(calls).map((c) => c.url)).toEqual(ids35.slice(0, 30).map((id) => OSV_VULN_URL_PREFIX + id))
    expect(maxActive).toBeLessThanOrEqual(OSV_DETAIL_CONCURRENCY)
    expect(maxActive).toBeGreaterThan(1)
    for (const c of gets(calls)) {
      expect(c.init.method).toBe('GET')
      expect(Object.keys(c.init.headers as Record<string, string>)).toEqual(['accept'])
      expect(c.init.redirect).toBe('error')
    }
    const states = r.kind === 'done' ? r.findings[0].vulns.map((v) => v.detail) : []
    expect(states.filter((s) => s === 'ok')).toHaveLength(30)
    expect(states.filter((s) => s === 'not-fetched')).toHaveLength(5)
  })
  it('isOsvId でない id が1つでもある応答は shape で止まり、弱点も詳細取得も出ない', async () => {
    const { fetchImpl, calls } = fake(vulnHandler(['GHSA-ok', '../../x'], {}))
    const r = await run({ fetchImpl })
    expect(gets(calls)).toHaveLength(0)
    expect(r).toMatchObject({ kind: 'done', checked: 0, findings: [], stop: { reason: 'shape' } })
  })
  it('1件だけ 500 ならその ID だけ unreadable', async () => {
    const h = vulnHandler(['A-1', 'A-2'], { 'A-1': detailFor('A-1', '4.19.2') })
    const { fetchImpl } = fake((u, i, n) => (u.endsWith('/A-2') ? json({}, 500) : h(u, i, n)))
    const r = await run({ fetchImpl })
    expect(r.kind === 'done' && r.findings[0].vulns.map((v) => v.detail)).toEqual(['ok', 'unreadable'])
    expect(r).toMatchObject({ stop: null })
  })
  it('withdrawn の弱点は一覧に出ず、withdrawn に数える', async () => {
    const { fetchImpl } = fake(vulnHandler(['A-1'], { 'A-1': detailFor('A-1', '4.19.2', { withdrawn: '2024-01-01T00:00:00Z' }) }))
    const r = await run({ fetchImpl })
    expect(r).toMatchObject({ kind: 'done', withdrawn: 1, findings: [] })
  })
  it('withdrawn が混ざっても、ほかの弱点は残る', async () => {
    const { fetchImpl } = fake(vulnHandler(['A-1', 'A-2'], {
      'A-1': detailFor('A-1', '4.19.2', { withdrawn: '2024-01-01T00:00:00Z' }),
      'A-2': detailFor('A-2', '4.19.2'),
    }))
    const r = await run({ fetchImpl })
    expect(r.kind === 'done' && r.findings[0].vulns.map((v) => v.id)).toEqual(['A-2'])
    expect(r).toMatchObject({ withdrawn: 1 })
  })
})

describe('直ったバージョン', () => {
  it('express 4.17.1 は 4.19.2・severityLabel・link', async () => {
    const { fetchImpl } = fake(vulnHandler(['GHSA-rv95-896h-c2vc'], { 'GHSA-rv95-896h-c2vc': V1 }))
    const r = await run({ fetchImpl })
    expect(r.kind === 'done' && r.findings).toEqual([{
      name: 'express',
      version: '4.17.1',
      fixedAll: '4.19.2',
      vulns: [{ id: 'GHSA-rv95-896h-c2vc', link: 'https://osv.dev/vulnerability/GHSA-rv95-896h-c2vc', fixed: '4.19.2', severityLabel: 'MODERATE', detail: 'ok' }],
    }])
  })
  it('弱点2つの fixed が 4.19.2 と 4.20.0 なら fixedAll は 4.20.0', async () => {
    const { fetchImpl } = fake(vulnHandler(['A-1', 'A-2'], { 'A-1': detailFor('A-1', '4.19.2'), 'A-2': detailFor('A-2', '4.20.0') }))
    const r = await run({ fetchImpl })
    expect(r.kind === 'done' && r.findings[0].fixedAll).toBe('4.20.0')
  })
  it('片方が null なら fixedAll は null', async () => {
    const { fetchImpl } = fake(vulnHandler(['A-1', 'A-2'], { 'A-1': detailFor('A-1', '4.19.2'), 'A-2': detailFor('A-2', '4.17.0') }))
    const r = await run({ fetchImpl })
    expect(r.kind === 'done' && r.findings[0].vulns.map((v) => v.fixed)).toEqual(['4.19.2', null])
    expect(r.kind === 'done' && r.findings[0].fixedAll).toBeNull()
  })
  it('結果の JSON に summary・details の文が入らない', async () => {
    const { fetchImpl } = fake(vulnHandler(['GHSA-rv95-896h-c2vc'], { 'GHSA-rv95-896h-c2vc': V1 }))
    const s = JSON.stringify(await run({ fetchImpl }))
    expect(s).not.toContain('SUMMARY-TEXT')
    expect(s).not.toContain('DETAILS-TEXT')
  })
})

describe('失敗の細部', () => {
  it('続きの要求（page_token つき）が失敗したら止まり、そこまでの ids は残る', async () => {
    const { fetchImpl, calls } = fake((u, _i, n) => {
      if (u !== OSV_QUERYBATCH_URL) return json({ id: 'A-1', affected: [] })
      if (n === 0) return json({ results: [{ vulns: [{ id: 'A-1' }], next_page_token: 'tok' }] })
      throw new TypeError('fetch failed')
    })
    const r = await run({ fetchImpl })
    expect(posts(calls)).toHaveLength(2)
    expect(gets(calls)).toHaveLength(0)
    expect(r).toMatchObject({ kind: 'done', checked: 0, stop: { reason: 'offline' } })
    expect(r.kind === 'done' && r.findings[0].vulns.map((v) => v.id)).toEqual(['A-1'])
  })
  it('続きの要求が 500 でも http で止まる', async () => {
    const { fetchImpl, calls } = fake((_u, _i, n) =>
      n === 0 ? json({ results: [{ vulns: [{ id: 'A-1' }], next_page_token: 'tok' }] }) : json({}, 500))
    const r = await run({ fetchImpl })
    expect(posts(calls)).toHaveLength(2)
    expect(r).toMatchObject({ stop: { reason: 'http' } })
  })
  it('届かなかった組は sent に数えない', async () => {
    const one = fake(() => { throw new TypeError('fetch failed') })
    expect(await run({ fetchImpl: one.fetchImpl })).toMatchObject({ sent: 0, checked: 0, stop: { reason: 'offline' } })
    const two = fake((_u, init, n) => {
      if (n === 0) return json({ results: queriesOf({ url: '', init }).map(() => ({})) })
      throw new TypeError('fetch failed')
    })
    expect(await run({ fetchImpl: two.fetchImpl, deps: depsOf(1200) })).toMatchObject({ sent: 500, checked: 500 })
  })
  it('AbortError も timeout', async () => {
    const { fetchImpl } = fake(() => { throw new DOMException('x', 'AbortError') })
    expect(await run({ fetchImpl })).toMatchObject({ stop: { reason: 'timeout' } })
  })
  it('200 以外は 2xx でも http', async () => {
    const { fetchImpl } = fake(() => json({ results: [{}] }, 201))
    const r = await run({ fetchImpl })
    expect(r).toMatchObject({ stop: { reason: 'http' } })
    expect(r.kind === 'done' && r.stop?.detail).toContain('HTTP 201')
  })
  it('HTTP の detail は本文の先頭 200 字まで', async () => {
    const { fetchImpl } = fake(() => new Response('x'.repeat(1000), { status: 500 }))
    const r = await run({ fetchImpl })
    const d = r.kind === 'done' && r.stop ? r.stop.detail : ''
    expect(d).toContain('x'.repeat(200))
    expect(d).not.toContain('x'.repeat(201))
  })
})

describe('詳細の要求の細部', () => {
  it('GET に signal（タイムアウト）が付く', async () => {
    const { fetchImpl, calls } = fake(vulnHandler(['A-1'], { 'A-1': detailFor('A-1', '4.19.2') }))
    await run({ fetchImpl })
    expect(gets(calls)).toHaveLength(1)
    expect(gets(calls)[0].init.signal).toBeInstanceOf(AbortSignal)
  })
  it('詳細が 200 以外なら 2xx でも unreadable', async () => {
    const h = vulnHandler(['A-1'], {})
    const { fetchImpl } = fake((u, i, n) => (u === OSV_QUERYBATCH_URL ? h(u, i, n) : json(detailFor('A-1', '4.19.2'), 201)))
    const r = await run({ fetchImpl })
    expect(r.kind === 'done' && r.findings[0].vulns[0].detail).toBe('unreadable')
  })
  it('上限より大きい詳細は全部読む前に打ち切り、その ID だけ unreadable', async () => {
    const chunk = new Uint8Array(1_000_000).fill(32)
    let pushed = 0
    let cancelled = false
    const base = vulnHandler(['A-1', 'A-2'], { 'A-2': detailFor('A-2', '4.19.2') })
    const { fetchImpl } = fake((u, i, n) => {
      if (u !== OSV_VULN_URL_PREFIX + 'A-1') return base(u, i, n)
      return new Response(new ReadableStream<Uint8Array>({
        pull(ctrl) {
          if (pushed >= 100) { ctrl.close(); return }
          pushed++
          ctrl.enqueue(chunk)
        },
        cancel() { cancelled = true },
      }), { status: 200 })
    })
    const r = await run({ fetchImpl })
    expect(r.kind === 'done' && r.findings[0].vulns.map((v) => v.detail)).toEqual(['unreadable', 'ok'])
    expect(r).toMatchObject({ stop: null })
    expect(cancelled).toBe(true)
    expect(pushed * chunk.byteLength).toBeLessThan(OSV_DETAIL_REPLY_LIMIT_BYTES + 4 * chunk.byteLength)
  })
})

describe('findings の並び', () => {
  it('名前、次にバージョンの順', async () => {
    const deps = [
      { name: 'zeta', version: '1.0.0' },
      { name: 'alpha', version: '2.0.0' },
      { name: 'alpha', version: '1.0.0' },
      { name: 'mid', version: '1.0.0' },
    ]
    const { fetchImpl } = fake((u, init) => {
      if (u === OSV_QUERYBATCH_URL) return json({ results: queriesOf({ url: '', init }).map(() => ({ vulns: [{ id: 'A-1' }] })) })
      return json({ id: 'A-1', affected: [] })
    })
    const r = await run({ fetchImpl, deps })
    expect(r.kind === 'done' && r.findings.map((f) => f.name + '@' + f.version)).toEqual(['alpha@1.0.0', 'alpha@2.0.0', 'mid@1.0.0', 'zeta@1.0.0'])
  })
})
