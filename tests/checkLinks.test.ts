import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
// @ts-expect-error — ビルド用スクリプト（型定義は持たない）
import { extractServiceUrls, exitCodeForLinks } from '../scripts/lib/checkLinks.mjs'

// ── なぜ要るか（P-148）──────────────────────────────────────────────────
// 週次のリンク切れ検査（scripts/check-links.mjs）は、URL が1件も読めなくても exit 0 で緑に終わっていた。
// 読み先の形が変わると見張りが止まるのに誰も気づけない。0件は「読み先がずれた」として exit 1 にする。
// ネットワークには出ない。

const root = path.resolve(__dirname, '..')
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf-8')

describe('extractServiceUrls', () => {
  it('本物の読み先から1件以上、すべて https の URL を拾う', () => {
    const urls: string[] = extractServiceUrls(
      read('src/renderer/targetProfiles.ts'),
      read('src/renderer/ragPacks.ts'),
    )
    expect(urls.length).toBeGreaterThan(0)
    for (const u of urls) expect(u).toMatch(/^https:\/\//)
    expect(new Set(urls).size).toBe(urls.length)
  })

  it('targetProfiles の中身だけからも1件以上拾える', () => {
    expect(extractServiceUrls(read('src/renderer/targetProfiles.ts'), '').length).toBeGreaterThan(0)
  })
  it('ragPacks の中身だけからも1件以上拾える', () => {
    expect(extractServiceUrls('', read('src/renderer/ragPacks.ts')).length).toBeGreaterThan(0)
  })

  it('serviceUrl も url も無い偽の中身なら0件', () => {
    expect(extractServiceUrls('export const x = 1', 'const y = 2')).toEqual([])
  })
})

describe('exitCodeForLinks', () => {
  const ok = { url: 'https://a.example/', status: 200, ok: true }
  it('0件 → 1（読み先がずれた）', () => {
    expect(exitCodeForLinks({ urls: [], results: [] })).toBe(1)
  })
  it('全部 OK → 0', () => {
    expect(exitCodeForLinks({ urls: [ok.url], results: [ok] })).toBe(0)
  })
  it('1件 NG → 1', () => {
    const ng = { url: 'https://b.example/', status: 404, ok: false }
    expect(exitCodeForLinks({ urls: [ok.url, ng.url], results: [ok, ng] })).toBe(1)
  })
  it('結果の件数が urls より少ない・空 → 1（調べ切れていないのに成功にしない）', () => {
    const b = 'https://b.example/'
    expect(exitCodeForLinks({ urls: [ok.url, b], results: [ok] })).toBe(1)
    expect(exitCodeForLinks({ urls: [ok.url], results: [] })).toBe(1)
  })
  it('通信の失敗（status null）→ 1', () => {
    const fail = { url: 'https://c.example/', status: null, ok: false, error: 'timeout' }
    expect(exitCodeForLinks({ urls: [fail.url], results: [fail] })).toBe(1)
  })
})

describe('check-links.mjs の配線', () => {
  const src = read('scripts/check-links.mjs')
  it('新しい関数を呼び、0件のときに process.exit(0) しない', () => {
    expect(src).toMatch(/from '\.\/lib\/checkLinks\.mjs'/)
    expect(src).toMatch(/extractServiceUrls\(\s*readFileSync/)
    expect(src).toMatch(/exitCodeForLinks\(\{\s*urls/)
  })
  it('0件の分岐: exitCodeForLinks の値で process.exit する', () => {
    expect(src).toMatch(
      /if \(urls\.length === 0\) \{[\s\S]{0,200}?process\.exit\(exitCodeForLinks\(\{\s*urls,\s*results:\s*\[\]\s*\}\)\)/,
    )
  })
  it('本流: 全結果から code を決め、その code で終わる（前後ごと）', () => {
    expect(src).toMatch(
      /Promise\.all\(urls\.map\(checkUrl\)\)[\s\S]*?\n\s*const code = exitCodeForLinks\(\{\s*urls,\s*results\s*\}\)\n\s*if \(code !== 0\) \{[\s\S]*?process\.exit\(code\)\n\s*\}[\s\S]*?process\.exit\(code\)\n\} catch/,
    )
    expect(src).not.toMatch(/const code = 0/)
  })
  it('その他の配線', () => {
    // 直す前の形（0件のとき 0 で終わる）を禁じる
    expect(src).not.toMatch(/urls\.length === 0\)\s*\{[\s\S]{0,200}?process\.exit\(0\)/)
    // 判断を check-links.mjs に持ち直さない（hasFailure の自前判定）
    expect(src).not.toMatch(/hasFailure/)
  })
})
