#!/usr/bin/env node
// check-notary-access.mjs — 署名ビルドの最初に、公証の窓口（Apple）を読み取りだけで確かめる（`npm run check:build` の一部）。
//
// ── なぜ要るか ──────────────────────────────────────────────────────────
// 公証は、アプリの署名が済んだあと（ビルドを始めて数分後）に初めて Apple へ届く。そこで止まると数分が無駄になる。
//   - 2026-11-11: 画面が消えたあと、キーチェーンのプロファイルを読めず「No Keychain password item found for profile」で止まった
//   - 2026-11-14: Apple の開発者の契約が更新され、同意が要る状態で「HTTP status code: 403. A required agreement is missing or has expired」で止まった
// ここで先に、過去の提出の一覧を取るだけの問い合わせ（`xcrun notarytool history`。何も提出しない）をして、数秒で止める。
//
// 署名しないビルド（KOTO_SIGN=1 でない）では何も呼ばない。`--always` を付けると、KOTO_SIGN に関わらず確かめる（単独で試すとき）。
// プロファイルでなく Apple ID と App 用パスワードで署名する形のときは、パスワードを引数に載せないため、飛ばす。
//
// ── 限界 ────────────────────────────────────────────────────────────────
// `history` が、契約の同意が要る状態でも公証と同じ 403 を返すかは【未実測】。返すなら数秒で止まる。返さないなら、これまでどおり公証で止まる。
// 401 や回線の文は、notarytool の実際の出力を手元で確かめていない【未実測】ので、広めの見分け方にしている。
//
//   KOTO_SIGN=1 APPLE_KEYCHAIN_PROFILE=<名前> node scripts/check-notary-access.mjs
//   npm run check:notary

import { execFileSync } from 'node:child_process'

/** 問い合わせの時間切れ（ミリ秒）。 */
export const TIMEOUT_MS = 30000
/** 「詳細:」に残す原文の最大の長さ。 */
export const DETAIL_MAX = 600

/**
 * 失敗の原文から、原因を見分ける（純関数）。
 * 'agreement' | 'profile' | 'credentials' | 'network' | 'other'
 * 契約の文（2026-11-14）とプロファイルの文（2026-11-11）は実際に出た原文。
 * 資格情報（401 など）と回線の見分けは【未実測】で、広めにしてある。
 */
export function classifyNotaryFailure(text) {
  const t = String(text || '')
  // 文の途中で折り返されても見分けられるよう、語のあいだは空白（改行を含む）なら何でもよい形にする
  if (/A\s+required\s+agreement\s+is\s+missing\s+or\s+has\s+expired/i.test(t)) return 'agreement'
  if (/No\s+Keychain\s+password\s+item\s+found\s+for\s+profile/i.test(t)) return 'profile'
  if (/HTTP status code:\s*401|Invalid credentials|unauthori[sz]ed|could not authenticate|invalid (?:apple id|password|app-specific)/i.test(t)) {
    return 'credentials'
  }
  if (
    /ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|NSURLErrorDomain|timed out|timeout|offline|network connection|internet connection|could not connect|nodename nor servname|connection (?:was )?lost/i.test(t)
  ) {
    return 'network'
  }
  return 'other'
}

/** 原文を1行にまとめ、長ければ切る（純関数）。 */
export function oneLineDetail(text, max = DETAIL_MAX) {
  const s = String(text || '').replace(/\s+/g, ' ').trim() || '（出力なし）'
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** 見分けた原因ごとの、止めるときの文（純関数）。 */
export function failureLines(kind, profile, detail) {
  const tail = `   詳細: ${detail}`
  switch (kind) {
    case 'agreement':
      return [
        '❌ 公証に出せません: Apple の開発者の契約への同意が要ります。',
        '   https://developer.apple.com/account を開き、契約の更新の知らせ（Review Agreement の類）から内容を読んで、同意してください（アカウントの持ち主だけができます）。',
        '   同意のあと数分おいて、もう一度実行してください。',
        tail,
      ]
    case 'profile':
      return [
        `❌ 公証の資格情報（キーチェーンのプロファイル「${profile}」）を読めません。`,
        '   画面やキーチェーンがロックされていると、読めないことがあります。画面を点けたまま、もう一度実行してください。',
        '   それでも同じなら、docs/signing-plan.md の「公証が『No Keychain password item found』で止まる」を見てください。',
        tail,
      ]
    case 'credentials':
      return [
        '❌ 公証の資格情報が、Apple に受け付けられませんでした。',
        '   App 用パスワードが無効になった可能性があります。docs/signing-plan.md の手順で、キーチェーンのプロファイルを作り直してください。',
        tail,
      ]
    case 'network':
      return [
        '❌ 公証の窓口（Apple）に届きませんでした。',
        '   インターネットの接続を確かめて、もう一度実行してください。',
        tail,
      ]
    default:
      return [
        '❌ 公証の窓口の確かめが失敗しました（原因を見分けられません）。',
        '   このまま進めると、アプリの署名のあとの公証で止まる見込みです。下の詳細を確かめてください。',
        tail,
      ]
  }
}

/**
 * 公証の窓口の事前確認（副作用なし。`runNotary` は差し替えられる）。
 *
 * - `env` … 環境変数（KOTO_SIGN・APPLE_KEYCHAIN_PROFILE などを見る）
 * - `argv` … 引数（`--always`）
 * - `runNotary(args)` … `xcrun` に渡す引数の配列を受け取り、成功なら標準出力の文字列を返す。
 *   失敗は throw する（error の message・stderr・stdout・code・killed が原文の材料）
 * 戻り値: `{ code, lines }`（code が 0 以外なら署名ビルドを止める）。一覧の中身は返さない。
 */
export function notaryPreflight({ env, argv = [], runNotary }) {
  const e = env || {}
  const always = argv.includes('--always')
  if (e.KOTO_SIGN !== '1' && !always) {
    return { code: 0, lines: ['公証の事前確認: 署名しないビルドなので、飛ばします'] }
  }

  const lines = []
  let profile = e.APPLE_KEYCHAIN_PROFILE
  if (!profile) {
    if (always && !e.APPLE_ID && !e.APPLE_APP_SPECIFIC_PASSWORD && !e.APPLE_API_KEY) {
      profile = 'koto'
      lines.push('公証の事前確認: APPLE_KEYCHAIN_PROFILE が未設定なので、koto を使います')
    } else {
      return {
        code: 0,
        lines: [
          '公証の事前確認: Apple ID と App 用パスワードで署名する形なので、飛ばします（キーチェーンのプロファイルのときだけ確かめます）',
        ],
      }
    }
  }

  try {
    runNotary(['notarytool', 'history', '--keychain-profile', profile])
  } catch (err) {
    const raw = [err && err.message, err && err.stderr, err && err.stdout].filter(Boolean).map(String).join('\n')
    const timedOut = !!err && (err.code === 'ETIMEDOUT' || err.killed === true || err.signal === 'SIGTERM')
    // 見分けは、Apple が返した文（stderr・stdout）で行う。message には「Command failed: xcrun … <プロファイルの名前>」の行が入るので、
    // 名前の中の語（timeout など）で取り違えないよう、返した文が何も無いとき（xcrun を実行できなかった、など）だけ使う。
    const said = [err && err.stderr, err && err.stdout].filter(Boolean).map(String).join('\n')
    const kind = timedOut ? 'network' : classifyNotaryFailure(said.trim() ? said : raw)
    return { code: 1, lines: [...lines, ...failureLines(kind, profile, oneLineDetail(raw))] }
  }
  return { code: 0, lines: [...lines, '✅ 公証の窓口に届きました（Apple の契約と、公証の資格情報は有効です）'] }
}

/** 本物の `xcrun` を呼ぶ（シェルを通さない・30 秒で打ち切る）。 */
export function realNotary(args) {
  return execFileSync('xcrun', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  })
}

// 直接実行されたときだけ（import 時は何もしない）
if (process.argv[1] && process.argv[1].endsWith('check-notary-access.mjs')) {
  const r = notaryPreflight({ env: process.env, argv: process.argv.slice(2), runNotary: realNotary })
  for (const l of r.lines) (r.code === 0 ? console.log : console.error)(l)
  process.exit(r.code)
}
