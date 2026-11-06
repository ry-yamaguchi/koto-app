import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { newError, createHttpError, HttpError } from 'builder-util-runtime'
import {
  canApplyNow, shouldCheckOnStartup, updateStatusText, updateFailureText, shouldHighlight,
  type UpdateState,
} from '../src/shared/updatePolicy'
import { splitFailureDetail } from '../src/shared/failureDetail'

// 自動更新の事故は「勝手に再起動されて作業が消える」形で起きる。
// Koto の利用者は非エンジニアで、消えたものを自力で復旧できない。
// ここで守る不変条件は1つ:「作業中は絶対に再起動しない」。

// 文の比べは、詳細の行（原文）を除いた日本語の文で行う（詳細は別の describe で固める）
const sentence = (e: unknown): string => splitFailureDetail(updateFailureText(e)).text

const downloaded: UpdateState = { kind: 'downloaded', version: '0.4.0' }

// ── 更新の確認の失敗の文（完全一致）──
const T_OFFLINE = '更新を確認できませんでした。インターネットに接続してから、もう一度お試しください。'
const T_OTHER = '更新を確認できませんでした。しばらくしてから、もう一度お試しください。'

describe('いま再起動して適用してよいか', () => {
  it('準備ができていて、何もしていなければ適用してよい', () => {
    expect(canApplyNow({ state: downloaded, isBusy: false, hasUnsavedChanges: false })).toEqual({ ok: true })
  })

  // ここが本丸。更新は待てるが、失われた作業は戻らない
  it('処理を実行中なら断る', () => {
    const r = canApplyNow({ state: downloaded, isBusy: true, busyLabel: 'AIの応答', hasUnsavedChanges: false })
    expect(r.ok).toBe(false)
    expect(r).toHaveProperty('reason', 'busy')
    if (!r.ok) expect(r.message).toContain('AIの応答')
  })

  it('未保存の変更があれば断る', () => {
    const r = canApplyNow({ state: downloaded, isBusy: false, hasUnsavedChanges: true })
    expect(r.ok).toBe(false)
    expect(r).toHaveProperty('reason', 'unsaved')
  })

  // 実行中の中断の方が実害が大きいので、理由として先に出す
  it('実行中と未保存が重なったら「実行中」を理由にする', () => {
    const r = canApplyNow({ state: downloaded, isBusy: true, busyLabel: '公開処理', hasUnsavedChanges: true })
    expect(r).toHaveProperty('reason', 'busy')
  })

  it('ダウンロードが終わっていなければ適用しない', () => {
    for (const state of [
      { kind: 'idle' }, { kind: 'checking' }, { kind: 'none' },
      { kind: 'available', version: '0.4.0' },
      { kind: 'downloading', version: '0.4.0', percent: 50 },
      { kind: 'error', message: 'x' },
    ] as UpdateState[]) {
      const r = canApplyNow({ state, isBusy: false, hasUnsavedChanges: false })
      expect(r.ok).toBe(false)
      expect(r).toHaveProperty('reason', 'not-downloaded')
    }
  })

  it('断るときは必ず理由を伝える（黙って何も起きないようにしない）', () => {
    for (const opts of [
      { state: downloaded, isBusy: true, hasUnsavedChanges: false },
      { state: downloaded, isBusy: false, hasUnsavedChanges: true },
      { state: { kind: 'idle' } as UpdateState, isBusy: false, hasUnsavedChanges: false },
    ]) {
      const r = canApplyNow(opts)
      if (!r.ok) expect(r.message.length).toBeGreaterThan(0)
    }
  })
})

describe('起動時に自動で確認するか', () => {
  it('パッケージ版で、設定が有効なら確認する', () => {
    expect(shouldCheckOnStartup({ isPackaged: true, enabled: true })).toBe(true)
  })

  // 開発中は配信元に開発版が無く、毎回エラーになるだけ
  it('開発中は確認しない', () => {
    expect(shouldCheckOnStartup({ isPackaged: false, enabled: true })).toBe(false)
  })

  it('設定で切っていれば確認しない', () => {
    expect(shouldCheckOnStartup({ isPackaged: true, enabled: false })).toBe(false)
  })
})

describe('利用者に見せる文', () => {
  it('ダウンロード済みは「次回起動で切り替わる」と伝える（勝手に再起動しないことを明示）', () => {
    const t = updateStatusText(downloaded)
    expect(t).toContain('0.4.0')
    expect(t).toContain('次に Koto を起動したとき')
  })

  it('進行中は割合を出す', () => {
    expect(updateStatusText({ kind: 'downloading', version: '0.4.0', percent: 42.7 })).toContain('43%')
  })

  it('最新なら、そう伝える（無言で終わらせない）', () => {
    expect(updateStatusText({ kind: 'none' })).toContain('最新')
  })

  // 失敗の文は updateFailureText が作った1行をそのまま出す（頭に「更新を確認できませんでした: 」を重ねない）
  it('失敗したら、渡された1行をそのまま出す', () => {
    expect(updateStatusText({ kind: 'error', message: T_OTHER })).toBe(T_OTHER)
    expect(updateStatusText({ kind: 'error', message: '開発中は更新を確認できません（パッケージ版でのみ動作します）。' }))
      .toBe('開発中は更新を確認できません（パッケージ版でのみ動作します）。')
  })

  it('失敗の文の頭に「更新を確認できませんでした: 」を付ける古い形に戻っていない', () => {
    const src = readFileSync(join(__dirname, '..', 'src/shared/updatePolicy.ts'), 'utf-8')
    expect(src).toContain("case 'error': return state.message")
    expect(src).not.toContain('更新を確認できませんでした: ${state.message}')
  })

  it('待機中は何も言わない（常時何か出ていると読まれなくなる）', () => {
    expect(updateStatusText({ kind: 'idle' })).toBe('')
  })

  // v0.2.98 の教訓。画面には素のテキストとして描画される
  it('文言に Markdown 記法を混ぜない', () => {
    const states: UpdateState[] = [
      { kind: 'checking' }, { kind: 'none' },
      { kind: 'available', version: '0.4.0' },
      { kind: 'downloading', version: '0.4.0', percent: 10 },
      downloaded,
      { kind: 'error', message: 'x' },
    ]
    for (const s of states) expect(updateStatusText(s)).not.toMatch(/\*\*|__|`/)
  })
})

describe('画面で強調するか', () => {
  it('準備ができたときだけ強調する', () => {
    expect(shouldHighlight(downloaded)).toBe(true)
  })

  it('確認中や進行中は強調しない（利用者にできることが無い）', () => {
    expect(shouldHighlight({ kind: 'checking' })).toBe(false)
    expect(shouldHighlight({ kind: 'downloading', version: '0.4.0', percent: 10 })).toBe(false)
    expect(shouldHighlight({ kind: 'none' })).toBe(false)
    expect(shouldHighlight({ kind: 'idle' })).toBe(false)
  })
})

// ── 更新の確認の失敗を、画面の1行の日本語にする ──
// 例外は electron-updater と builder-util-runtime の本物（newError・createHttpError）で作り、
// 画面に出る文は2つのうちのどちらかを完全一致で見る。英語の原文・複数行の本文・ヘッダは画面に出ない。
describe('更新の確認の失敗の文（updateFailureText）', () => {
  const FEED = 'https://github.com/example-owner/example-repo/releases'
  // electron-updater が内側の失敗を包むときの本文は「…: ${e.stack}」の形（複数行）
  const stackOf = (inner: string) => `Error: ${inner}\n    at ClientRequest.<anonymous> (app.asar/node_modules/builder-util-runtime/out/httpExecutor.js:150:15)\n    at Object.onceWrapper (node:events:633:26)`
  // electron-updater の GitHubProvider が作る包みの形（GitHubProvider.js の getLatestTagName と getLatestVersion の文面そのまま）。
  // 最新の版の取得で投げられた失敗は、種類を問わず LATEST_VERSION_NOT_FOUND で包まれ、さらに FEED の外側の包みに入る。
  const latestWrap = (inner: Error) => newError(`Unable to find latest version on GitHub (${FEED}/latest), please ensure a production release exists: ${inner.stack || inner.message}`, 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND')
  // feed の XML は配信元の本文。日本語や通信の語（net::ERR_*）が書かれていても、判定には使わない
  const FEED_XML = '<feed><entry><title>0.6.26 通信が切れたとき net::ERR_INTERNET_DISCONNECTED と出る件</title></entry></feed>'
  const feedWrap = (inner: Error) => newError(`Cannot parse releases feed: ${inner.stack || inner.message},\nXML:\n${FEED_XML}`, 'ERR_UPDATER_INVALID_RELEASE_FEED')
  // 本物の応答の形（404 は本文付き・ヘッダ付きの複数行）
  const httpError = (statusCode: number, statusMessage: string) => createHttpError(
    { statusCode, statusMessage, headers: { server: 'GitHub.com', 'x-github-request-id': 'ABCD:1234' } } as never,
    `method: GET url: https://github.com/example-owner/example-repo/releases/download/v0.6.26/latest-mac.yml\n\nPlease double check that your authentication token is correct. Due to security reasons, actual status maybe not reported, but ${statusCode}.\n`,
  )

  describe('配信元の印（err.code）→ 「しばらくしてから」', () => {
    const coded: Array<[string, Error]> = [
      ['ERR_UPDATER_NO_PUBLISHED_VERSIONS', newError('No published versions on GitHub', 'ERR_UPDATER_NO_PUBLISHED_VERSIONS')],
      ['ERR_UPDATER_LATEST_VERSION_NOT_FOUND', latestWrap(httpError(404, 'Not Found'))],
      ['ERR_UPDATER_INVALID_RELEASE_FEED', feedWrap(latestWrap(httpError(404, 'Not Found')))],
      ['ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', newError(`Cannot find latest-mac.yml in the latest release artifacts (${FEED}/download/v0.6.26/latest-mac.yml): ${httpError(404, 'Not Found').stack}`, 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND')],
      ['ERR_UPDATER_RELEASE_NOT_FOUND', newError(`Unable to find release 123 on GitLab (${FEED})`, 'ERR_UPDATER_RELEASE_NOT_FOUND')],
      ['HTTP_ERROR_404', httpError(404, 'Not Found')],
      ['HTTP_ERROR_403', httpError(403, 'Forbidden')],
      ['HTTP_ERROR_429', httpError(429, 'Too Many Requests')],
      ['HTTP_ERROR_500', httpError(500, 'Internal Server Error')],
      ['HTTP_ERROR_502', httpError(502, 'Bad Gateway')],
      ['HTTP_ERROR_503', httpError(503, 'Service Unavailable')],
      ['HTTP_ERROR_504', httpError(504, 'Gateway Timeout')],
    ]
    for (const [code, err] of coded) {
      it(`${code} は「しばらくしてから」の1行で、原文の本文は出ない`, () => {
        expect((err as { code?: string }).code).toBe(code) // 例外が本物の印を持っている
        const text = sentence(err)
        expect(text).toBe(T_OTHER)
        expect(text).not.toContain('\n')
      })
    }

    it('ヘッダ付きの複数行の本文を持つ例外でも、画面の1行に出ない', () => {
      const err = httpError(404, 'Not Found')
      expect(err.message).toContain('\n') // 元の本文は複数行
      expect(err.message).toContain('Headers')
      expect(sentence(err)).toBe(T_OTHER)
    })

    // 順序: 印を先に見る。包みでない印（応答が返った失敗）は、本文に何が書かれていても「配信元が答えた失敗」
    it('★ 印が文面より先: 包みでない印は、本文に net::ERR_ が残っていても回線断と言わない', () => {
      const body = `Cannot find latest-mac.yml in the latest release artifacts (${FEED}/download/v0.6.26/latest-mac.yml): ${stackOf('net::ERR_INTERNET_DISCONNECTED')}`
      const err = newError(body, 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND')
      expect(err.message).toContain('net::ERR_INTERNET_DISCONNECTED')
      expect(sentence(err)).toBe(T_OTHER)
    })
  })

  // 包み: 最新の版の取得（/releases/latest）で投げられた失敗は、通信の層の失敗も含めて種類を問わず包まれる。
  // 包みの印は、中身の1行目を見る。応答が返った失敗・知らない失敗は「しばらくしてから」のまま。
  describe('包み（LATEST_VERSION_NOT_FOUND と、それを包む INVALID_RELEASE_FEED）→ 中身で決まる', () => {
    const wrapForms: Array<[string, (inner: Error) => Error]> = [
      ['LATEST_VERSION_NOT_FOUND', latestWrap],
      ['INVALID_RELEASE_FEED（二重の包み。後ろに feed の XML が続く）', inner => feedWrap(latestWrap(inner))],
    ]
    for (const [name, wrap] of wrapForms) {
      for (const net of ['INTERNET_DISCONNECTED', 'NAME_NOT_RESOLVED', 'CONNECTION_RESET', 'CONNECTION_TIMED_OUT', 'TIMED_OUT']) {
        it(`${name}: 中身が net::ERR_${net}（本物の Error の stack つき）→ 「接続してから」`, () => {
          const err = wrap(new Error(`net::ERR_${net}`))
          expect(err.message).toContain('production release exists')
          expect(sentence(err)).toBe(T_OFFLINE)
        })
      }

      it(`${name}: 中身が Node の errno の文面（getaddrinfo ENOTFOUND）→ 「接続してから」`, () => {
        expect(sentence(wrap(new Error('getaddrinfo ENOTFOUND github.com')))).toBe(T_OFFLINE)
      })

      it(`★ ${name}: 中身が証明書の失敗 → 「接続してから」とは言わない`, () => {
        expect(sentence(wrap(new Error('net::ERR_CERT_AUTHORITY_INVALID')))).toBe(T_OTHER)
      })

      it(`★ ${name}: 中身が応答の返った失敗（404・403・503）→ 本文に net::ERR_ や fetch failed があっても「しばらくしてから」`, () => {
        for (const status of [404, 403, 503]) {
          // プロキシの文などが応答の本文に混ざる
          const inner = createHttpError({ statusCode: status, statusMessage: 'X', headers: {} } as never, 'net::ERR_INTERNET_DISCONNECTED fetch failed')
          const err = wrap(inner)
          expect(err.message, String(status)).toContain('net::ERR_INTERNET_DISCONNECTED')
          expect(sentence(err), String(status)).toBe(T_OTHER)
        }
      })

      it(`★ ${name}: 中身が知らない失敗（JSON の読み取り失敗など）→ 「しばらくしてから」（知らないものを回線断にしない）`, () => {
        expect(sentence(wrap(new SyntaxError('Unexpected token < in JSON at position 0')))).toBe(T_OTHER)
        expect(sentence(wrap(new Error('boom')))).toBe(T_OTHER)
      })
    }

    it('★ 見るのは中身の1行目だけ。feed の XML（日本語・net::ERR_ を含む）や stack の行は判定に使わない', () => {
      // 中身が応答の返った失敗なら、XML に net::ERR_ があっても回線断にしない
      expect(sentence(feedWrap(latestWrap(httpError(404, 'Not Found'))))).toBe(T_OTHER)
      // 中身が回線断なら、XML に日本語があっても（文面全体を日本語ありとして見落とさず）回線断
      const offline = feedWrap(latestWrap(new Error('net::ERR_INTERNET_DISCONNECTED')))
      expect(offline.message).toContain('通信が切れたとき')
      expect(sentence(offline)).toBe(T_OFFLINE)
    })

    it('★ 中身が読めない包み（本物の feed の読み取り失敗・文面が変わった版）は「しばらくしてから」', () => {
      expect(sentence(newError(`Cannot parse releases feed: Error: Unexpected close tag,\nXML:\n${FEED_XML}`, 'ERR_UPDATER_INVALID_RELEASE_FEED'))).toBe(T_OTHER)
      expect(sentence(newError('net::ERR_INTERNET_DISCONNECTED', 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND'))).toBe(T_OTHER)
    })

    it('★ 包みでない印には、同じ文があっても中身を読まない（順序: 印の種類が先）', () => {
      const body = 'please ensure a production release exists: Error: net::ERR_INTERNET_DISCONNECTED'
      for (const code of ['ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', 'ERR_UPDATER_NO_PUBLISHED_VERSIONS', 'HTTP_ERROR_404']) {
        expect(sentence(newError(body, code)), code).toBe(T_OTHER)
      }
    })

    // 包みの文面は electron-updater の本文に依存する。版を上げて文面が変わると、ここで気づく
    it('★ 試験の包みは、入っている electron-updater の本物の文面と同じ（版が上がって文面が変わったら落ちる）', () => {
      const src = readFileSync(join(__dirname, '..', 'node_modules/electron-updater/out/providers/GitHubProvider.js'), 'utf-8')
      expect(src).toContain('`Unable to find latest version on GitHub (${url}), please ensure a production release exists: ${e.stack || e.message}`, "ERR_UPDATER_LATEST_VERSION_NOT_FOUND"')
      expect(src).toContain('`Cannot parse releases feed: ${e.stack || e.message},\\nXML:\\n${feedXml}`, "ERR_UPDATER_INVALID_RELEASE_FEED"')
      // 最新の版の取得は、feed の読み取りの try の中で呼ばれる（だから回線断は二重に包まれる）
      expect(src.indexOf('tag = await this.getLatestTagName(cancellationToken)')).toBeLessThan(src.indexOf('"ERR_UPDATER_INVALID_RELEASE_FEED"'))
    })
  })

  // HttpError は応答が返った失敗。本文（プロキシが付ける文など）に回線断に見える語があっても、応答の印を先に見る
  it('★ 印が文面より先: 応答が返った HttpError は、本文に net::ERR_ や fetch failed があっても回線断と言わない', () => {
    for (const body of ['net::ERR_CONNECTION_RESET', 'fetch failed', 'Connection error.']) {
      const err = new HttpError(503, `HTTP error: Service Unavailable (${body})`)
      expect(err.code).toBe('HTTP_ERROR_503')
      expect(sentence(err), body).toBe(T_OTHER)
    }
  })

  describe('通信の層の失敗 → 「接続してから」', () => {
    // Electron の通信の失敗は code を持たず、文面が net::ERR_* になる
    for (const name of ['INTERNET_DISCONNECTED', 'NAME_NOT_RESOLVED', 'ADDRESS_UNREACHABLE', 'CONNECTION_REFUSED', 'CONNECTION_RESET', 'CONNECTION_CLOSED', 'NETWORK_CHANGED', 'TIMED_OUT', 'CONNECTION_TIMED_OUT']) {
      it(`net::ERR_${name}（code なし）は「接続してから」の1行`, () => {
        expect(sentence(new Error(`net::ERR_${name}`))).toBe(T_OFFLINE)
      })
    }

    it('Node の errno の印（code）でも「接続してから」の1行', () => {
      for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'ECONNRESET', 'ETIMEDOUT']) {
        const err = Object.assign(new Error(`connect ${code} 140.82.112.4:443`), { code })
        expect(sentence(err), code).toBe(T_OFFLINE)
      }
    })

    it('安全な接続（証明書）の失敗には「接続してから」と言わない', () => {
      expect(sentence(new Error('net::ERR_CERT_AUTHORITY_INVALID'))).toBe(T_OTHER)
      expect(sentence(Object.assign(new Error('self signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }))).toBe(T_OTHER)
    })
  })

  describe('それ以外 → 「しばらくしてから」（原文は出さない）', () => {
    it('未知の英語・日本語の文・Error でない値は「しばらくしてから」の1行', () => {
      for (const v of [new Error('boom'), new Error('Cannot parse releases feed: SyntaxError'), new Error('ネットワークに接続できません'), 'a string', 42, null, undefined, {}]) {
        expect(sentence(v), String(v)).toBe(T_OTHER)
      }
    })

    it('どんな入力でも、返るのは「接続してから」か「しばらくしてから」の1行だけ（英語の原文・複数行・ヘッダを画面に出さない）', () => {
      const inputs: unknown[] = [
        httpError(404, 'Not Found'), httpError(503, 'Service Unavailable'),
        newError('No published versions on GitHub', 'ERR_UPDATER_NO_PUBLISHED_VERSIONS'),
        new Error('net::ERR_INTERNET_DISCONNECTED'), new Error('net::ERR_CERT_DATE_INVALID'),
        new Error('Headers: {\n  "server": "GitHub.com"\n}'), new Error('multi\nline\nbody'), 'x', undefined,
      ]
      for (const v of inputs) {
        const text = sentence(v)
        expect([T_OFFLINE, T_OTHER]).toContain(text)
        expect(text).not.toMatch(/\n|Headers|github|http/i)
      }
    })

    it('文の言い方は掟5に沿う（括弧を使わず・Markdown を混ぜず・2文）', () => {
      for (const t of [T_OFFLINE, T_OTHER]) {
        expect(t).not.toMatch(/[()（）*_`]/)
        expect(t.split('。').filter(Boolean)).toHaveLength(2)
      }
    })
  })
})

describe('更新の確認の失敗の詳細（原文を文の下に1行で添える）', () => {
  it('回線断: 文のすぐ下に「詳細: 原文」が付く', () => {
    const t = updateFailureText(new Error('net::ERR_INTERNET_DISCONNECTED'))
    expect(t).toBe(`${T_OFFLINE}\n詳細: net::ERR_INTERNET_DISCONNECTED`)
  })

  it('配信元の印: 原文と印（code）が詳細に残り、状態番号の語も残る', () => {
    const err = createHttpError(
      { statusCode: 404, statusMessage: 'Not Found', headers: { server: 'GitHub.com' } } as never,
      'method: GET url: https://github.com/example-owner/example-repo/releases/download/v1/latest-mac.yml\n\nPlease double check.\n',
    )
    const { text, detail } = splitFailureDetail(updateFailureText(err))
    expect(text).toBe(T_OTHER)
    expect(detail).toContain('latest-mac.yml')
    expect(detail).toContain('HTTP_ERROR_404')
    expect(detail).not.toContain('\n')
  })

  it('複数行の原文は1行にまとまり、長いものは切り詰められる', () => {
    const t = updateFailureText(newError(`first\nsecond\n${'x'.repeat(1000)}`, 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'))
    const { text, detail } = splitFailureDetail(t)
    expect(text).toBe(T_OTHER)
    expect(detail.startsWith('first second')).toBe(true)
    expect(detail.length).toBeLessThanOrEqual(241)
    expect(detail.endsWith('…')).toBe(true)
  })

  it('キーの形は伏せられる', () => {
    const t = updateFailureText(new Error('request failed Authorization: Bearer abcdef0123456789abcdef0123456789'))
    expect(t).not.toContain('abcdef0123456789abcdef0123456789')
  })

  it('原文が空の失敗には詳細の行を付けない', () => {
    expect(updateFailureText(new Error(''))).toBe(T_OTHER)
  })
})
