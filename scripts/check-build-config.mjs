#!/usr/bin/env node
// check-build-config.mjs — electron-builder の設定をスキーマ検証する。
//
// ── なぜ要るか（2026-08-09）──────────────────────────────────────────
// 署名つきの初回ビルドが、設定のスキーマ違反で失敗した（notarize の型と identity の扱い）。
// electron-builder は**ビルドを一通り走らせてから**設定を検証するため、気づくまでに
// レンダラのビルドまで完了してしまい、数分を無駄にする。
//
// このスクリプトは `app-builder-lib/scheme.json`（実物の定義）に対して、
// **署名あり・署名なしの両方**を数秒で検証する。設定を触ったら先にこれを通すこと。
//
//   node scripts/check-build-config.mjs

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Ajv = require('ajv')
const scheme = require('../node_modules/app-builder-lib/scheme.json')

const ajv = new Ajv({ allErrors: true, strict: false, verbose: true })
const validate = ajv.compile(scheme)

/** 環境変数を差し替えて設定を読み直す（require のキャッシュを毎回捨てる）。 */
function loadConfig(env) {
  const saved = { ...process.env }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  const p = require.resolve('../electron-builder.config.js')
  delete require.cache[p]
  try {
    return require(p)
  } finally {
    process.env = saved
  }
}

const CASES = [
  {
    name: '未署名（既定）',
    env: { KOTO_SIGN: undefined, APPLE_TEAM_ID: undefined, APPLE_ID: undefined, APPLE_APP_SPECIFIC_PASSWORD: undefined },
    expect: (c) => {
      if (c.mac.identity !== null) return 'mac.identity が null でない（未署名にならない）'
      if (c.mac.notarize !== undefined) return '未署名なのに notarize が設定されている'
      return null
    },
  },
  {
    name: '署名あり（キーチェーンのプロファイル）',
    env: {
      KOTO_SIGN: '1',
      APPLE_KEYCHAIN_PROFILE: 'koto',
      APPLE_TEAM_ID: undefined,
      APPLE_ID: undefined,
      APPLE_APP_SPECIFIC_PASSWORD: undefined,
    },
    expect: (c) => {
      if (Object.prototype.hasOwnProperty.call(c.mac, 'identity')) {
        return 'mac.identity のキーが残っている（自動検出されない）'
      }
      if (c.mac.notarize !== true) return 'mac.notarize が true でない（公証されない）'
      return null
    },
  },
  {
    name: '署名あり（Apple ID ＋ App用パスワード）',
    env: {
      KOTO_SIGN: '1',
      APPLE_KEYCHAIN_PROFILE: undefined,
      APPLE_TEAM_ID: 'XXXXXXXXXX',
      APPLE_ID: 'dummy@example.com',
      APPLE_APP_SPECIFIC_PASSWORD: 'dummy',
    },
    expect: (c) => {
      // identity は「キーごと無い」ことが必要。null だと署名が飛ばされ、undefined はスキーマ違反
      if (Object.prototype.hasOwnProperty.call(c.mac, 'identity')) {
        return 'mac.identity のキーが残っている（自動検出されない）'
      }
      if (c.mac.notarize !== true) return 'mac.notarize が true でない（公証されない）'
      if (c.mac.hardenedRuntime !== true) return 'hardenedRuntime が true でない（公証の必須条件）'
      if (!c.mac.entitlements) return 'entitlements が指定されていない'
      return null
    },
  },
]

let failed = 0
for (const c of CASES) {
  const cfg = loadConfig(c.env)
  const ok = validate(cfg)
  if (!ok) {
    failed++
    console.error(`❌ ${c.name}: スキーマ違反`)
    for (const e of validate.errors) console.error(`   ${e.instancePath || '(root)'} ${e.message}`)
    continue
  }
  const problem = c.expect(cfg)
  if (problem) {
    failed++
    console.error(`❌ ${c.name}: ${problem}`)
    continue
  }
  console.log(`✅ ${c.name}`)
}

process.exit(failed ? 1 : 0)
