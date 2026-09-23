import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSiteCheck, checkDedicatedSite } from '../src/main/cloud/dedicatedSiteCheck'

// ── O-1（2026-09-17）: 「🔎 公開先と https を確かめる」の、繋いで読む側 ──────────────
//
// **外へ実際に繋ぐテストは書かない。** 繋ぐ部分（DNS・証明書・検証つきの接続・根への問い合わせ）は
// すべて差し込み口（SiteCheckDeps）にしてあり、ここでは偽物を渡す。
// 判定そのものは tests/publishVerify.test.ts が純関数として固定しているので、ここで見るのは
// 「4つの軸が独立に組み上がるか」「1つ固まっても全体が返るか」「例外を投げないか」である。

const HOST = 'app.example.com'
const RECORDED = ['203.0.113.10']
const NOW = Date.parse('2026-09-17T00:00:00Z')

const GOOD_CERT = {
  subject: { CN: HOST },
  issuer: { CN: 'R11', O: "Let's Encrypt", C: 'US' },
  subjectaltname: `DNS:${HOST}`,
  valid_from: 'Sep  1 00:00:00 2026 GMT',
  valid_to: 'Dec  1 00:00:00 2026 GMT',
}

const TRAEFIK_CERT = {
  subject: { CN: 'TRAEFIK DEFAULT CERT' },
  issuer: { CN: 'TRAEFIK DEFAULT CERT' },
  valid_from: 'Sep 16 00:00:00 2026 GMT',
  valid_to: 'Sep 16 00:00:00 2027 GMT',
}

/** 本物の dns.promises.resolve4 が投げる形（`code` を持つ Error）を真似る。 */
function dnsError(code: string): Error & { code: string } {
  const e = new Error(`queryA ${code} ${HOST}`) as Error & { code: string }
  e.code = code
  return e
}

/** すべて「うまくいっている」偽物。個別に上書きして使う。 */
function deps(over: Parameters<typeof runSiteCheck>[1] = {}) {
  return {
    resolve4: async () => ['203.0.113.10'],
    readCert: async () => GOOD_CERT,
    openHttps: async () => 'ok' as const,
    probeRoot: async () => ({ reached: true as const, status: 200, body: 'hello' }),
    now: () => NOW,
    ...over,
  }
}

describe('runSiteCheck: 4つの軸を1回だけ調べる（偽物を差し込む）', () => {
  it('★ すべて整っていれば 4つとも良い側になる', async () => {
    const r = await runSiteCheck({ host: HOST, recorded: RECORDED }, deps())
    expect(r.dns).toBe('match')
    expect(r.cert).toBe('issued')
    expect(r.httpsOpen).toBe('ok')
    expect(r.app).toBe('responding')
    expect(r.lines).toHaveLength(4)
  })

  it('★★ 2026-09-16 に実際に起きた形（証明書が出ていない）を、他の軸と混ぜずに出す', async () => {
    const r = await runSiteCheck({ host: HOST, recorded: RECORDED }, deps({
      readCert: async () => TRAEFIK_CERT,
      openHttps: async () => 'rejected' as const,
    }))
    expect(r.dns).toBe('match')          // ドメインは向いている
    expect(r.cert).toBe('not-issued')    // 証明書はまだ出ていない
    expect(r.httpsOpen).toBe('rejected') // ブラウザは警告を出す
    expect(r.app).toBe('responding')     // アプリ自体は応答している
    expect(r.lines[1]).toContain('まだ発行されていません')
    expect(r.lines[3]).toContain('応答することを確認しました')
  })

  it('★★ 証明書は出ていて、アプリが応答していない——両方が読み取れる', async () => {
    const r = await runSiteCheck({ host: HOST, recorded: RECORDED }, deps({
      probeRoot: async () => ({ reached: true as const, status: 503, body: 'no available server' }),
    }))
    expect(r.cert).toBe('issued')
    expect(r.app).toBe('no-backend')
    expect(r.lines[1].startsWith('✅')).toBe(true)
    expect(r.lines[3].startsWith('❌')).toBe(true)
  })

  it('★★ 1つの軸が失敗（例外）しても、他の軸は返る・例外は投げない', async () => {
    const r = await runSiteCheck({ host: HOST, recorded: RECORDED }, deps({
      resolve4: async () => { throw dnsError('ESERVFAIL') },
      readCert: async () => { throw new Error('ECONNRESET') },
    }))
    expect(r.dns).toBe('unknown')   // 引けなかった＝「向いていない」とは言わない
    expect(r.cert).toBe('unknown')  // 読めなかった＝「出ていない」とは言わない
    expect(r.httpsOpen).toBe('ok')
    expect(r.app).toBe('responding')
  })

  // ── 検分（2026-09-17）: 本物の dns.promises.resolve4 は A レコードが無いとき**空配列を返さず断る** ──
  // （名前が無ければ ENOTFOUND、名前はあるが A が無ければ ENODATA）。断りを一律「確かめられなかった」に
  // 潰していたため、'not-found' の枝が本番で一度も出ず、**DNS をまだ設定していない人**——この確認を
  // いちばん必要とする人——に、次の一手（A レコードを向ける）が出ていなかった。
  it('★★ ENOTFOUND で断られたら not-found（❌ と A レコードの案内が出る）', async () => {
    const r = await runSiteCheck({ host: HOST, recorded: RECORDED }, deps({
      resolve4: async () => { throw dnsError('ENOTFOUND') },
    }))
    expect(r.dns).toBe('not-found')
    expect(r.resolved).toEqual([])          // 引けたが0件（＝確かめられなかった null とは別物）
    expect(r.lines[0].startsWith('❌')).toBe(true)
    expect(r.lines[0]).toContain('A レコード')
  })

  it('★★ ENODATA（名前はあるが A が無い）も not-found', async () => {
    const r = await runSiteCheck({ host: HOST, recorded: RECORDED }, deps({
      resolve4: async () => { throw dnsError('ENODATA') },
    }))
    expect(r.dns).toBe('not-found')
  })

  it('★★ EAI_AGAIN（答えが得られなかった）なら unknown のまま（「向き先が無い」と断定しない）', async () => {
    const r = await runSiteCheck({ host: HOST, recorded: RECORDED }, deps({
      resolve4: async () => { throw dnsError('EAI_AGAIN') },
    }))
    expect(r.dns).toBe('unknown')
    expect(r.resolved).toBe(null)
    expect(r.lines[0].startsWith('ℹ️')).toBe(true)
  })

  it('★★ 1つの軸が固まっても、全体は時間切れで返る（待ちは差し込み口で短くする）', async () => {
    const r = await runSiteCheck({ host: HOST, recorded: RECORDED }, deps({
      // 解決しない約束（本物なら永久に待つ）
      readCert: () => new Promise(() => {}),
      openHttps: () => new Promise(() => {}),
      probeRoot: () => new Promise(() => {}),
      resolve4: () => new Promise(() => {}),
      timeoutMs: 20,
    }))
    expect(r.cert).toBe('unknown')
    expect(r.dns).toBe('unknown')
    expect(r.httpsOpen).toBe('unknown')
    expect(r.app).toBe(null) // 調べられなかった＝「応答していない」とは言わない
  })

  it('★★ 記録の IP が空なら、DNS は no-record（mismatch にも、引けなかった unknown にも倒さない）', async () => {
    const r = await runSiteCheck({ host: HOST, recorded: [] }, deps())
    expect(r.dns).toBe('no-record')
    // 原因を「この端末」のせいにしない。次の一手（先に IP を取り直す）を書く（検分・2026-09-17）
    expect(r.lines[0]).not.toContain('この端末から調べられませんでした')
    expect(r.lines[0]).toContain('🔄 IP を取り直す')
  })

  it('★ 根（/）への問い合わせはキャッシュに騙されない形（毎回違う問い合わせ）', async () => {
    const seen: string[] = []
    await runSiteCheck({ host: HOST, recorded: RECORDED }, deps({
      probeRoot: async (_h: string, path: string) => { seen.push(path); return { reached: true as const, status: 200, body: '' } },
    }))
    expect(seen[0]).toContain('/?t=')
  })

  it('★ 繋ぐ先はホスト名（IP 直打ちではない。ドメインが向いているかも同時に効く）', async () => {
    const hosts: string[] = []
    await runSiteCheck({ host: 'APP.Example.com', recorded: RECORDED }, deps({
      readCert: async (h: string) => { hosts.push(h); return GOOD_CERT },
      openHttps: async (h: string) => { hosts.push(h); return 'ok' as const },
      probeRoot: async (h: string) => { hosts.push(h); return { reached: true as const, status: 200, body: '' } },
    }))
    expect(hosts).toEqual([HOST, HOST, HOST])
  })

  it('★ 発行者の名前は別に返す（通す／通さないの判断には使わない）', async () => {
    const own = await runSiteCheck({ host: HOST, recorded: RECORDED }, deps({
      readCert: async () => ({ ...GOOD_CERT, issuer: { CN: 'Acme Private CA', O: 'Acme' } }),
    }))
    expect(own.cert).toBe('issued')            // 発行者で弾かない
    expect(own.issuer).toContain('Acme')       // 名前は添えられる
  })
})

describe('checkDedicatedSite: 記録からホスト名と IP を読む', () => {
  it('★★ まだ公開していない（ホスト名が無い）なら、調べに行かずに理由を返す', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'koto-sitecheck-'))
    try {
      writeFileSync(join(dir, '.sakuraide.json'), JSON.stringify({ publish: { apprunDedicated: { clusterID: 'c1' } } }))
      const r = await checkDedicatedSite(dir, deps())
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.message).toContain('まだアプリを公開していません')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('★★ 記録のホスト名とロードバランサの IP を使う', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'koto-sitecheck-'))
    try {
      writeFileSync(join(dir, '.sakuraide.json'), JSON.stringify({
        publish: { apprunDedicated: { hosts: [HOST], lbAddresses: ['203.0.113.10'] } },
      }))
      const r = await checkDedicatedSite(dir, deps())
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.host).toBe(HOST)
        expect(r.recorded).toEqual(['203.0.113.10'])
        expect(r.dns).toBe('match')
        expect(r.lines).toHaveLength(4)
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('★★ 記録の IP と違うところを向いていれば mismatch（別の場所を指しているとはっきり言う）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'koto-sitecheck-'))
    try {
      writeFileSync(join(dir, '.sakuraide.json'), JSON.stringify({
        publish: { apprunDedicated: { hosts: [HOST], lbAddresses: ['203.0.113.10'] } },
      }))
      const r = await checkDedicatedSite(dir, deps({ resolve4: async () => ['198.51.100.7'] }))
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.dns).toBe('mismatch')
        expect(r.resolved).toEqual(['198.51.100.7'])
        expect(r.lines[0]).toContain('別の場所')
        // 残り3軸はホスト名で繋いで調べている＝見ているのは**いま向いている先**。✅ で並べない（検分）
        for (const line of r.lines.slice(1)) expect(line.startsWith('✅')).toBe(false)
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
