#!/usr/bin/env node
/*
 * リンク切れ自動検査:
 *  - src/renderer/targetProfiles.ts の serviceUrl（公開先の公式サイトURL）
 *  - src/renderer/ragPacks.ts の url（さくらの資料パックの取り込み対象ページ）
 * それぞれ GET リクエストを送り、到達可能か（HTTP 400未満）を確認する。
 * URLは各ファイルを唯一の情報源として抽出する（本スクリプトにURLを複製しない）。
 *
 * 使い方:
 *   npm run check:links
 *
 * 1件でも 400以上 or 通信失敗があれば終了コード 1（週次GitHub Actionsで検知）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const TARGET_PROFILES_PATH = resolve(here, '../src/renderer/targetProfiles.ts')
const RAG_PACKS_PATH = resolve(here, '../src/renderer/ragPacks.ts')

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

function extractServiceUrls() {
  const src = readFileSync(TARGET_PROFILES_PATH, 'utf-8')
  const urls = [...src.matchAll(/serviceUrl:\s*'([^']+)'/g)].map((m) => m[1])
  const ragSrc = readFileSync(RAG_PACKS_PATH, 'utf-8')
  const ragUrls = [...ragSrc.matchAll(/url:\s*'([^']+)'/g)].map((m) => m[1])
  return [...new Set([...urls, ...ragUrls])]
}

async function checkUrl(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': UA },
    })
    return { url, status: res.status, ok: res.status < 400 }
  } catch (e) {
    return { url, status: null, ok: false, error: e?.message ?? String(e) }
  }
}

try {
  const urls = extractServiceUrls()
  if (urls.length === 0) {
    console.log('serviceUrl が見つかりませんでした（targetProfiles.ts を確認してください）。')
    process.exit(0)
  }

  console.log(`=== リンク切れ検査（${urls.length}件） ===`)
  const results = await Promise.all(urls.map(checkUrl))

  let hasFailure = false
  for (const r of results) {
    const mark = r.ok ? 'OK' : 'NG'
    if (!r.ok) hasFailure = true
    const statusText = r.status ?? `通信失敗: ${r.error}`
    console.log(`[${mark}] ${r.url} → ${statusText}`)
  }

  if (hasFailure) {
    console.log('\n❌ リンク切れ、または通信失敗のURLがあります。')
    process.exit(1)
  }
  console.log('\n✅ すべてのURLにアクセスできました。')
  process.exit(0)
} catch (e) {
  console.error(`\n❌ ${e?.message ?? e}`)
  process.exit(2)
}
