#!/usr/bin/env node
// probe-koto-data.mjs — **公開したアプリと同じ koto-data.js を、同じ鍵で手元で動かす。**
//
// ── なぜ要るか（2026-08-14）────────────────────────────────────────────
// ここまでで分かったこと:
//   ・鍵も権限もバケットもエンドポイントも正しい
//   ・**同じ鍵を Koto の署名実装で使うと読める**（probe-app-s3.mjs で確認）
//   ・それでもアプリは 403 で落ちる
// 残る違いは **koto-data.js が持つ自前の署名実装**だけ。
//
// テンプレートと Koto 本体が同じ署名を出すことは単体テストで確かめてある。
// だが**利用者のプロジェクトに置かれた実物**は、テンプレートを直しても
// 上書きされない（`ensureDataLayer` は既存を触らない）。つまり
// **実物が何をしているかは、実物を動かすまで分からない。**
//
// ⚠️ 読み取りだけを行う（list / get）。書き込みはしない。
// ⚠️ シークレットは表示しない（子プロセスの環境変数として渡すだけ）。
//
// 使い方:
//   SAKURA_TOKEN='...' SAKURA_SECRET='...' APP_ID='...' PROJECT='/path/to/project' \
//     node scripts/probe-koto-data.mjs

import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

const APPRUN = 'https://secure.sakura.ad.jp/cloud/api/apprun/1.0/apprun/api'
const TOKEN = process.env.SAKURA_TOKEN || ''
const SECRET = process.env.SAKURA_SECRET || ''
const APP_ID = process.env.APP_ID || ''
const PROJECT = process.env.PROJECT || ''

const c = { g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, d: s => `\x1b[2m${s}\x1b[0m` }

async function main() {
  if (!TOKEN || !SECRET || !APP_ID || !PROJECT) {
    console.error("❌ SAKURA_TOKEN / SAKURA_SECRET / APP_ID / PROJECT を指定してください。")
    console.error("   例: … PROJECT='/Users/you/SAKURAIDE/data-test' node scripts/probe-koto-data.mjs")
    process.exit(1)
  }
  const file = path.join(PROJECT, 'koto-data.js')
  if (!fs.existsSync(file)) { console.error(`❌ ${file} がありません`); process.exit(1) }
  console.log(c.d('※ 読み取りだけを行います。シークレットは表示しません。'))
  console.log(`  動かすファイル: ${file}`)
  console.log(`  更新日時: ${fs.statSync(file).mtime.toLocaleString('ja-JP')}`)

  const res = await fetch(`${APPRUN}/applications/${APP_ID}`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${TOKEN}:${SECRET}`).toString('base64'), Accept: 'application/json' },
  })
  if (!res.ok) { console.error(`❌ アプリを取得できません（HTTP ${res.status}）`); process.exit(1) }
  const app = await res.json()
  const env = {}
  for (const comp of app.components ?? []) for (const e of comp.env ?? []) env[e.key] = e.value
  if (!env.KOTO_STORAGE_BUCKET) { console.error('❌ アプリに KOTO_STORAGE_* が渡っていません'); process.exit(1) }
  console.log(`  バケット: ${env.KOTO_STORAGE_BUCKET} / ${env.KOTO_STORAGE_PREFIX ?? ''}`)

  // **実物を、実物の環境変数で動かす。** 環境変数は読み込み時に評価されるので子プロセスで。
  const code = `
    const m = await import(${JSON.stringify('file://' + file)})
    for (const name of ['entries', 'items', 'data']) {
      try {
        const rows = await m.list(name)
        console.log('  ✅ list(' + name + ') → ' + rows.length + '件')
      } catch (e) {
        console.log('  ❌ list(' + name + ') → ' + (e && e.message ? e.message : e))
      }
    }
  `
  console.log('\n① アプリの koto-data.js で読み出す')
  await new Promise(resolve => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, ...env },
      stdio: 'inherit',
    })
    child.on('close', resolve)
  })

  console.log('\n② 手元のテンプレート（最新）で同じことをする')
  const tpl = path.join(process.cwd(), 'templates', 'koto-data.js')
  if (!fs.existsSync(tpl)) { console.log(c.d('   templates/koto-data.js が見つかりません（省略）')); }
  else {
    await new Promise(resolve => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code.replace(JSON.stringify('file://' + file), JSON.stringify('file://' + tpl))], {
        env: { ...process.env, ...env },
        stdio: 'inherit',
      })
      child.on('close', resolve)
    })
  }

  console.log('\n────────────────────────────────')
  console.log('①が失敗して②が成功するなら、**プロジェクトの koto-data.js が古い**のが原因です。')
  console.log('両方失敗するなら、テンプレート側にも同じ不具合が残っています。')
}

if (process.argv[1] && process.argv[1].endsWith('probe-koto-data.mjs')) {
  main().catch(e => { console.error('\n❌ 途中で落ちました:', e?.message ?? e); process.exit(1) })
}
