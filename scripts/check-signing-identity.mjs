#!/usr/bin/env node
// check-signing-identity.mjs — 署名ビルドの前に、署名に使う証明書を確かめる（`npm run check:build` の一部）。
//
// ── なぜ要るか ──────────────────────────────────────────────────────────
// 証明書が1枚も使えない（期限切れも「使えない」に数えられる）と、electron-builder は警告を出すだけで進み、
// 数分後の DMG の署名工程で初めて止まる。同じ名前の証明書が2枚あるとき（更新の前後）も、
// scripts/dmg-notarize.mjs が最後の最後に止まる。ここで先に、同じ条件で止める。
//
// 署名しないビルド（KOTO_SIGN=1 でない）では何もしない（1行出して終了コード 0）。
//
// ── 証明書を選ぶ規則は dmg-notarize.mjs のものをそのまま使う ──────────────
// `selectSigningIdentity`（同じ関数）を呼ぶので、DMG の工程が止まるところで、ここも止まる。
// 規則を二重に持たない。
//
// ── 期限の読み方 ────────────────────────────────────────────────────────
// `security find-certificate -a -c <名前> -Z -p` が返す PEM を node:crypto の X509Certificate で読む。
// 名前が同じ証明書は SHA-1 の指紋（証明書そのものから求める）で見分ける。
//
//   KOTO_SIGN=1 node scripts/check-signing-identity.mjs

import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { listSigningIdentities, selectSigningIdentity } from './dmg-notarize.mjs'

/** この日数を切ったら、目立つ警告を出す。 */
export const WARN_DAYS = 60

const DAY_MS = 24 * 60 * 60 * 1000

/** 出力から PEM を全部取り出し、{ sha1, validFrom, validTo, issuer } にする（純関数）。読めない塊は飛ばす。 */
export function parseCertificates(pemOutput) {
  const blocks = String(pemOutput || '').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || []
  const out = []
  for (const b of blocks) {
    try {
      const c = new X509Certificate(b)
      out.push({
        sha1: c.fingerprint.replace(/:/g, '').toUpperCase(),
        validFrom: new Date(c.validFrom),
        validTo: new Date(c.validTo),
        issuer: issuerLabel(c.issuer),
        issuerOu: issuerOu(c.issuer),
      })
    } catch {
      // 読めない塊は無かったことにする（呼び出し側が「情報なし」として扱う）
    }
  }
  return out
}

/** `CN=…\nOU=…\nO=…` から CN と OU だけを取る（純関数）。 */
export function issuerLabel(issuer) {
  const parts = []
  for (const key of ['CN', 'OU']) {
    const m = String(issuer || '').match(new RegExp(`^${key}=(.*)$`, 'm'))
    if (m) parts.push(`${key}=${m[1].trim()}`)
  }
  return parts.length ? parts.join(', ') : String(issuer || '').replace(/\n/g, ', ') || '（不明）'
}

/** 発行元の OU だけを取る（純関数）。無ければ空文字。 */
export function issuerOu(issuer) {
  const m = String(issuer || '').match(/^OU=(.*)$/m)
  return m ? m[1].trim() : ''
}

/**
 * 発行元の OU から、どちらの中間証明書で発行されたかを言葉にする（純関数）。
 * Apple のヘルプ「Replacing Developer ID certificates issued from the previous Sub-CA」の見分け方に従う:
 * OU が "Apple Certification Authority" なら旧い中間証明書（2027-02-01 に期限）、"G2" なら新しい中間証明書。
 * どちらでもなければ、決めつけずに発行元の表示（`label`）をそのまま返す。
 */
export function classifyIssuer(ou, label) {
  if (ou === 'Apple Certification Authority') return '旧い中間証明書（置き換える対象）'
  if (ou === 'G2') return '新しい中間証明書（G2）'
  return label
}

/** ローカル時刻の YYYY-MM-DD（純関数）。 */
export function localDate(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 期限までの日数（切り捨て。期限を過ぎていれば 0 以下）。 */
export function daysLeft(validTo, now) {
  return Math.floor((validTo.getTime() - now.getTime()) / DAY_MS)
}

const describeCert = (c) =>
  `期限 ${localDate(c.validTo)}（あと ${daysLeft(c.validTo, c.now)} 日）／発行元 ${classifyIssuer(c.issuerOu, c.issuer)}`

/**
 * 署名前の確認（副作用なし。`runSecurity` と `now` は差し替えられる）。
 *
 * - `env` … 環境変数（KOTO_SIGN・APPLE_TEAM_ID を見る）
 * - `runSecurity(args)` … `security` を実行して標準出力の文字列を返す（失敗は throw）
 * 戻り値: `{ code, lines }`（code が 0 以外なら署名ビルドを止める）
 */
export function signingPreflight({ env, runSecurity, now = new Date() }) {
  if (!env || env.KOTO_SIGN !== '1') {
    return { code: 0, lines: ['署名の事前確認: KOTO_SIGN=1 ではないので何もしません'] }
  }

  let findOut
  try {
    findOut = runSecurity(['find-identity', '-v', '-p', 'codesigning'])
  } catch (e) {
    return {
      code: 1,
      lines: [
        '❌ 署名用の証明書の一覧を取れませんでした（security find-identity が失敗）。',
        `   詳細: ${String((e && e.message) || e)}`,
      ],
    }
  }

  const sel = selectSigningIdentity(listSigningIdentities(findOut), env.APPLE_TEAM_ID)

  if (sel.problem === 'none') {
    return {
      code: 1,
      lines: [
        '❌ 署名に使える Developer ID Application の証明書が、キーチェーンに1枚もありません。',
        '   期限が切れた証明書は、この一覧に出ないことがあります。',
        '   確認: security find-identity -v -p codesigning',
        '   手順: docs/signing-plan.md',
      ],
    }
  }
  if (sel.problem === 'no-team') {
    return {
      code: 1,
      lines: [
        `❌ APPLE_TEAM_ID ${env.APPLE_TEAM_ID} の Developer ID Application がありません。見つかったのは:`,
        ...sel.found.map((f) => `   - ${f.name}`),
      ],
    }
  }

  // 証明書の詳細（指紋 → 期限・発行元）。名前ごとに1回だけ問い合わせる。
  const targets = sel.identity ? [sel.identity] : sel.candidates
  const certs = new Map()
  const readErrors = []
  for (const name of new Set(targets.map((t) => t.name))) {
    try {
      for (const c of parseCertificates(runSecurity(['find-certificate', '-a', '-c', name, '-Z', '-p']))) {
        certs.set(c.sha1, { ...c, now })
      }
    } catch (e) {
      readErrors.push(String((e && e.message) || e))
    }
  }

  if (sel.problem === 'ambiguous') {
    const lines = [
      '❌ Developer ID Application が複数あり、どれで署名すべきか決められません（DMG の署名工程でも止まる状態です）。',
    ]
    for (const t of sel.candidates) {
      const c = certs.get(t.hash.toUpperCase())
      lines.push(`   - ${t.name}`)
      lines.push(`       SHA-1: ${t.hash}`)
      lines.push(c ? `       ${describeCert(c)}` : '       （期限と発行元を読めませんでした）')
    }
    if (readErrors.length) lines.push(`   詳細: ${readErrors[0]}`)
    lines.push(
      sel.sameTeam
        ? '   どれも同じ Team ID なので APPLE_TEAM_ID では絞れません。'
        : '   APPLE_TEAM_ID を指定すると絞れます。'
    )
    lines.push('   発行元が旧い中間証明書の方が、置き換える対象です（Apple のヘルプ「Replacing Developer ID certificates issued from the previous Sub-CA」）。')
    lines.push(
      '   使わない方を、ログインキーチェーンから削除してください。' +
        'Apple の開発者サイトで「取り消し（revoke）」はしないでください' +
        '——取り消すと、その証明書で署名したアプリは新たにインストールできず、インストール済みでも起動できなくなります（Apple のヘルプ「Developer ID certificates」）。'
    )
    return { code: 1, lines }
  }

  // ここへ来たら 1 枚に決まっている
  const id = sel.identity
  const c = certs.get(id.hash.toUpperCase())
  const lines = [`署名に使う証明書: ${id.name}`, `   SHA-1: ${id.hash}`]
  if (!c) {
    lines.push('   ⚠️ 期限と発行元を読めませんでした（署名は続けられます）。')
    if (readErrors.length) lines.push(`   詳細: ${readErrors[0]}`)
    return { code: 0, lines }
  }
  const left = daysLeft(c.validTo, now)
  lines.push(`   ${describeCert({ ...c, now })}`)
  if (c.validTo.getTime() <= now.getTime()) {
    return {
      code: 1,
      lines: [
        ...lines,
        '❌ この証明書は期限が切れています。署名しても配れません。',
        '   手順: docs/signing-plan.md',
      ],
    }
  }
  if (left < WARN_DAYS) {
    lines.push('⚠️ 期限が近づいています。新しい証明書の用意を始めてください → docs/signing-plan.md')
  }
  return { code: 0, lines }
}

/** 本物の `security` を呼ぶ。 */
export function realSecurity(args) {
  return execFileSync('security', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 })
}

// 直接実行されたときだけ（import 時は何もしない）
if (process.argv[1] && process.argv[1].endsWith('check-signing-identity.mjs')) {
  const r = signingPreflight({ env: process.env, runSecurity: realSecurity })
  for (const l of r.lines) (r.code === 0 ? console.log : console.error)(l)
  process.exit(r.code)
}
