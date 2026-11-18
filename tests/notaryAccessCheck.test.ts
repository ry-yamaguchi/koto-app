import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// @ts-expect-error — ビルド用スクリプト（型定義は持たない）
import { notaryPreflight, classifyNotaryFailure, oneLineDetail, failureLines, realNotary, TIMEOUT_MS, DETAIL_MAX } from '../scripts/check-notary-access.mjs'

// 公証の窓口の事前確認（npm run check:build の最後）。本物の xcrun は呼ばない（実行の関数を差し替える）。
// 「実際に出た原文」は 2026-11-14（契約）と 2026-11-11（プロファイル）の署名ビルドで出たもの。
// 401・回線の文は notarytool の実際の出力を手元で確かめていないので、作った入力である。

const REAL_AGREEMENT =
  'Error: HTTP status code: 403. A required agreement is missing or has expired. This request requires an in-effect agreement that has not been signed or has expired. Ensure your team has signed the necessary legal agreements and that they are not expired.'
const REAL_PROFILE =
  "Error: No Keychain password item found for profile: koto\nRun 'notarytool store-credentials' to create another credential profile."
const HISTORY_BODY = 'Successfully received submission history.\n  history\n    --------\n    createdDate: 2026-11-10  id: SECRET-SUBMISSION-ID  name: SECRET-NAME.dmg  status: Accepted'

function fakeNotary(result: string | Error) {
  const calls: string[][] = []
  const run = (args: string[]) => {
    calls.push(args)
    if (result instanceof Error) throw result
    return result
  }
  return { run, calls }
}
const failing = (message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), extra)
const text = (r: { lines: string[] }) => r.lines.join('\n')
const SIGN = { KOTO_SIGN: '1', APPLE_KEYCHAIN_PROFILE: 'koto' }

describe('走る条件', () => {
  it('KOTO_SIGN が 1 でなく --always も無ければ、何も呼ばず1行で終了コード 0', () => {
    const f = fakeNotary(HISTORY_BODY)
    for (const env of [{}, { KOTO_SIGN: '0' }, { KOTO_SIGN: '', APPLE_KEYCHAIN_PROFILE: 'koto' }]) {
      const r = notaryPreflight({ env, argv: [], runNotary: f.run })
      expect(r.code).toBe(0)
      expect(r.lines).toEqual(['公証の事前確認: 署名しないビルドなので、飛ばします'])
    }
    expect(f.calls).toEqual([])
  })
  it('--always なら KOTO_SIGN が無くても呼ぶ。プロファイル未設定なら koto を使い、そう出す', () => {
    const f = fakeNotary(HISTORY_BODY)
    const r = notaryPreflight({ env: {}, argv: ['--always'], runNotary: f.run })
    expect(r.code).toBe(0)
    expect(f.calls).toEqual([['notarytool', 'history', '--keychain-profile', 'koto']])
    expect(text(r)).toContain('koto を使います')
  })
  it('Apple ID と App 用パスワードで署名する形（プロファイル無し）なら、呼ばずに飛ばす（終了コード 0）', () => {
    const f = fakeNotary(HISTORY_BODY)
    const env = { KOTO_SIGN: '1', APPLE_ID: 'a@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'pw', APPLE_TEAM_ID: 'T' }
    for (const argv of [[], ['--always']]) {
      const r = notaryPreflight({ env, argv, runNotary: f.run })
      expect(r.code).toBe(0)
      expect(text(r)).toContain('Apple ID と App 用パスワードで署名する形なので、飛ばします')
    }
    expect(f.calls).toEqual([])
  })
})

describe('呼ぶコマンド', () => {
  it('history だけを、引数の配列で（プロファイルの名前を含めて）呼ぶ。1回だけ', () => {
    const f = fakeNotary(HISTORY_BODY)
    notaryPreflight({ env: { KOTO_SIGN: '1', APPLE_KEYCHAIN_PROFILE: 'my profile; rm' }, runNotary: f.run })
    expect(f.calls).toEqual([['notarytool', 'history', '--keychain-profile', 'my profile; rm']])
  })
  it('通ったら1行（✅）だけ。一覧の中身（提出の名前や ID）は出さない', () => {
    const r = notaryPreflight({ env: SIGN, runNotary: fakeNotary(HISTORY_BODY).run })
    expect(r.code).toBe(0)
    expect(r.lines).toEqual(['✅ 公証の窓口に届きました（Apple の契約と、公証の資格情報は有効です）'])
    expect(text(r)).not.toContain('SECRET')
  })
  it('失敗の文にも、成功のときの一覧の中身は出ない（原文は失敗の出力だけ）', () => {
    const r = notaryPreflight({ env: SIGN, runNotary: fakeNotary(failing(REAL_AGREEMENT)).run })
    expect(text(r)).not.toContain('SECRET')
  })
})

describe('原因の見分け（実際に出た原文）', () => {
  it('契約: 2026-11-14 の 403 の原文', () => {
    expect(classifyNotaryFailure(REAL_AGREEMENT)).toBe('agreement')
    const r = notaryPreflight({ env: SIGN, runNotary: fakeNotary(failing(REAL_AGREEMENT)).run })
    expect(r.code).toBe(1)
    expect(r.lines[0]).toBe('❌ 公証に出せません: Apple の開発者の契約への同意が要ります。')
    expect(r.lines[1]).toBe(
      '   https://developer.apple.com/account を開き、契約の更新の知らせ（Review Agreement の類）から内容を読んで、同意してください（アカウントの持ち主だけができます）。'
    )
    expect(r.lines[2]).toBe('   同意のあと数分おいて、もう一度実行してください。')
    expect(r.lines[3]).toContain('詳細: ')
    expect(r.lines[3]).toContain('A required agreement is missing or has expired')
  })
  it('プロファイル: 2026-11-11 の原文。名前を差し込む', () => {
    expect(classifyNotaryFailure(REAL_PROFILE)).toBe('profile')
    const r = notaryPreflight({ env: SIGN, runNotary: fakeNotary(failing('Command failed', { stderr: REAL_PROFILE })).run })
    expect(r.code).toBe(1)
    expect(r.lines[0]).toBe('❌ 公証の資格情報（キーチェーンのプロファイル「koto」）を読めません。')
    expect(text(r)).toContain('docs/signing-plan.md の「公証が『No Keychain password item found』で止まる」')
    expect(text(r)).toContain('No Keychain password item found for profile: koto')
  })
  it('契約の文は 403 を含むが、ほかの 403 とは混ざらず契約に分かれる', () => {
    expect(classifyNotaryFailure('HTTP status code: 403. Forbidden')).toBe('other')
  })
})

describe('原因の見分け（作った入力。notarytool の実際の文は未確認）', () => {
  it('作った入力: 401 / Invalid credentials は資格情報', () => {
    expect(classifyNotaryFailure('Error: HTTP status code: 401. Invalid credentials.')).toBe('credentials')
    const r = notaryPreflight({ env: SIGN, runNotary: fakeNotary(failing('Error: Invalid credentials')).run })
    expect(r.code).toBe(1)
    expect(r.lines[0]).toBe('❌ 公証の資格情報が、Apple に受け付けられませんでした。')
    expect(text(r)).toContain('詳細: Error: Invalid credentials')
  })
  it('作った入力: 回線の文は届かない', () => {
    for (const s of ['NSURLErrorDomain Code=-1009 The Internet connection appears to be offline.', 'getaddrinfo ENOTFOUND appstoreconnect.apple.com', 'The request timed out.']) {
      expect(classifyNotaryFailure(s)).toBe('network')
    }
    const r = notaryPreflight({ env: SIGN, runNotary: fakeNotary(failing('The request timed out.')).run })
    expect(r.lines[0]).toBe('❌ 公証の窓口（Apple）に届きませんでした。')
    expect(r.lines[1]).toBe('   インターネットの接続を確かめて、もう一度実行してください。')
  })
  it('時間切れ（ETIMEDOUT / killed）は、文が空でも「届かない」', () => {
    for (const extra of [{ code: 'ETIMEDOUT' }, { killed: true, signal: 'SIGTERM' }]) {
      const r = notaryPreflight({ env: SIGN, runNotary: fakeNotary(failing('spawnSync xcrun', extra)).run })
      expect(r.code).toBe(1)
      expect(r.lines[0]).toBe('❌ 公証の窓口（Apple）に届きませんでした。')
    }
  })
  it('作った入力: 見分けられない失敗は「そのほか」。進めると公証で止まる見込みと出す', () => {
    const r = notaryPreflight({ env: SIGN, runNotary: fakeNotary(failing('something unexpected')).run })
    expect(r.code).toBe(1)
    expect(r.lines[0]).toBe('❌ 公証の窓口の確かめが失敗しました（原因を見分けられません）。')
    expect(r.lines[1]).toContain('公証で止まる見込みです')
    expect(text(r)).toContain('詳細: something unexpected')
  })
})

describe('詳細（原文を捨てない）', () => {
  it('1行にまとめる。長ければ 600 字で切る', () => {
    expect(oneLineDetail('a\n  b\n\nc')).toBe('a b c')
    expect(DETAIL_MAX).toBe(600)
    const long = oneLineDetail('x'.repeat(2000))
    expect(long.length).toBe(601)
    expect(long.endsWith('…')).toBe(true)
  })
  it('止める文は必ず最後が「   詳細: …」', () => {
    for (const k of ['agreement', 'profile', 'credentials', 'network', 'other']) {
      const l = failureLines(k, 'koto', 'ORIGINAL')
      expect(l[l.length - 1]).toBe('   詳細: ORIGINAL')
    }
  })
})

describe('配線', () => {
  const root = join(__dirname, '..')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const raw = readFileSync(join(root, 'scripts/check-notary-access.mjs'), 'utf8')

  it('check:build の最後がこの確かめ。check:notary は --always で単独に走る', () => {
    expect(pkg.scripts['check:build'].endsWith(' && node scripts/check-notary-access.mjs')).toBe(true)
    expect(pkg.scripts['check:notary']).toBe('node scripts/check-notary-access.mjs --always')
  })
  it('時間切れは 30 秒・シェルを通さない・何も提出しない（history だけ）', () => {
    expect(TIMEOUT_MS).toBe(30000)
    expect(typeof realNotary).toBe('function')
    expect(raw).toContain('execFileSync')
    // 時間切れが本物の実行に渡っていること（この行を消すと、30 秒で打ち切られなくなる）
    expect(raw).toMatch(/timeout:\s*TIMEOUT_MS/)
    expect(raw).not.toMatch(/\bexec\(|execSync|shell:\s*true/)
    expect(raw).not.toContain("'submit'")
  })
  it('公開されるスクリプトに、ローカルのパスを直書きしていない', () => {
    expect(raw).not.toMatch(/\/Users\//)
  })
})

describe('見分けの細部（検分で見つかった穴）', () => {
  it('契約の文が途中で折り返されていても、契約と見分ける', () => {
    expect(classifyNotaryFailure('Error: HTTP status code: 403. A required agreement\nis missing or has\n  expired. This request requires')).toBe('agreement')
    expect(classifyNotaryFailure('Error: No Keychain password\nitem found for profile: koto')).toBe('profile')
  })
  it('プロファイルの名前に timeout などの語があっても、Apple が返した文で見分ける', () => {
    const err = Object.assign(new Error('Command failed: xcrun notarytool history --keychain-profile my-timeout-profile'), {
      stderr: 'Error: HTTP status code: 403. A required agreement is missing or has expired. This request requires an in-effect agreement that has not been signed or has expired.',
      stdout: '',
    })
    const r = notaryPreflight({ env: { KOTO_SIGN: '1', APPLE_KEYCHAIN_PROFILE: 'my-timeout-profile' }, argv: [], runNotary: () => { throw err } })
    expect(r.code).toBe(1)
    expect(r.lines.join('\n')).toContain('Apple の開発者の契約への同意が要ります')
  })
  it('xcrun を実行できないとき（作った入力: ENOENT）は、黙って通らず、原文を詳細に出して止まる', () => {
    const err = Object.assign(new Error('spawnSync xcrun ENOENT'), { code: 'ENOENT' })
    const r = notaryPreflight({ env: { KOTO_SIGN: '1', APPLE_KEYCHAIN_PROFILE: 'koto' }, argv: [], runNotary: () => { throw err } })
    expect(r.code).toBe(1)
    expect(r.lines.join('\n')).toContain('詳細: spawnSync xcrun ENOENT')
  })
})
