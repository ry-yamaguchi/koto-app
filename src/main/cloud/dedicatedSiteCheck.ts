// dedicatedSiteCheck.ts — O-1（2026-09-17）「🔎 公開先と https を確かめる」の、実際に調べる側。
//
// ── なぜ要るか（2026-09-16〜17 の観測）──────────────────────────────────────
// 専有型で公開したところ、証明書が一度も発行されていなかった。公開された証明書の記録
// （CT ログ）に 0 件で、実際に返るのはロードバランサが持っている仮の証明書だった。
// ブラウザで開けば「この接続は安全ではありません」と出る状態である。
// **それでも Koto は「✅ 公開しました」と出していた。Koto は証明書を一度も見ていない。**
// さくらの API には証明書の状態を読む手段が無い（原本で確認済み。読めるのは「メールを
// 設定したか」だけ）ので、**Koto が自分で繋いで確かめる**しかない。
//
// ── ⑧の verify（公開直後の確認）には足さない ─────────────────────────────────
// ⑧の verify は **DNS を向ける前**に走る。宛先はロードバランサの IP で、ホスト名は SNI に
// 載せるだけ・証明書の検証は意図的に無効にしてある（apprunDedicatedAppApply.ts の
// probeMarkerOverHttps）。その時点で正式な証明書は存在し得ないので、そこに証明書の検査を
// 足すと必ず失敗し、意味のない警告が出続ける。**証明書は「DNS を向けたあと」のもので、
// 時間軸が違う。** だから押したときに1回だけ調べる別の口にする。
//
// ── probeMarkerOverHttps に引数を足さない ──────────────────────────────────
// あの関数のオプションのキーは tests/apprunDedicatedAppApply.test.ts が固定している。
// 証明書を読むのは**別の関数**（このファイルの readPeerCertificate）である。
//
// 判定は1つも書かない。**すべて src/shared/publishVerify.ts の純関数**（judgeDnsMatch /
// judgePeerCertificate / judgeHttpsOpenError / judgeDedicatedRootProbe / siteCheckLines）に
// 通す。ここは「繋いで読むだけ」（掟10）。
import { promises as dnsPromises } from 'node:dns'
import tls from 'node:tls'
import https from 'node:https'
import { readApprunDedicatedFs } from '../publishMetaFs'
import {
  judgeDnsMatch, judgeDnsLookupError, judgePeerCertificate, judgeHttpsOpenError, judgeDedicatedRootProbe,
  dedicatedProbePath, siteCheckLines, certIssuerName,
  type DnsCheck, type CertCheck, type HttpsOpenCheck, type PeerCertificateLike,
  type DedicatedProbe, type DedicatedVerifyOutcome,
} from '../../shared/publishVerify'

// ── 時間切れ（1つが固まっても全体が返る）────────────────────────────────────
// 4つの軸は**同時に**調べるので、この確認全体の上限はおよそ 10 秒である。
// 10 秒は⑧の verify 段（VERIFY_TIMEOUT_MS）と同じ値に揃えた——同じ相手（同じロードバランサ）
// への1本の問い合わせに、確かめ方ごとに違う我慢の長さを持たせる理由が無い（掟10）。
// DNS だけは手元（または近くの）リゾルバへの問い合わせで、これに 10 秒かかるなら引けないのと
// 同じなので 5 秒で切る。
const SITE_CHECK_TIMEOUT_MS = 10 * 1000
const DNS_TIMEOUT_MS = 5 * 1000

/** 4つの軸と、画面に出す行。 */
export type SiteCheckResult =
  | {
      ok: true
      host: string
      dns: DnsCheck
      cert: CertCheck
      httpsOpen: HttpsOpenCheck
      app: DedicatedVerifyOutcome | null
      /** 引けた IP（引けなければ null）。画面が「どこを向いているか」を添えるのに使う。 */
      resolved: string[] | null
      /** 記録しているロードバランサの IP。 */
      recorded: string[]
      /** 発行者の名前（読めなければ null）。**通す／通さないの判断には使わない。** */
      issuer: string | null
      /** 画面に並べる行（siteCheckLines の結果そのまま）。 */
      lines: string[]
    }
  | { ok: false; message: string }

/** 実際に外へ繋ぐ部分（テストでは偽物を渡す。**テストから本物のネットワークへ出さない**）。 */
export type SiteCheckDeps = {
  /**
   * 名前を引く。**引けたが0件（空配列）と、確かめられなかった（`null`・断られた）を分ける。**
   * 本物の `dns.promises.resolve4` は0件のとき空配列ではなく `ENOTFOUND` / `ENODATA` で**断る**ので、
   * 断りの理由は `judgeDnsLookupError` で振り分ける（runSiteCheck 側）。
   */
  resolve4?: (host: string) => Promise<string[] | null>
  readCert?: (host: string, timeoutMs: number) => Promise<PeerCertificateLike | null>
  openHttps?: (host: string, timeoutMs: number) => Promise<HttpsOpenCheck>
  probeRoot?: (host: string, path: string, timeoutMs: number) => Promise<DedicatedProbe>
  now?: () => number
  /**
   * 時間切れ（ミリ秒）。**既定を短くするためのものではない**——テストで「1つ固まっても全体が返る」を
   * 10 秒待たずに確かめるための差し込み口（apprunDedicatedAppApply.ts の sleep と同じ流儀）。
   */
  timeoutMs?: number
}

/** 約束が時間切れになったら、投げずに `fallback` を返す。 */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>(resolve => {
    let settled = false
    const done = (v: T) => { if (!settled) { settled = true; resolve(v) } }
    const timer = setTimeout(() => done(fallback), ms)
    if (typeof (timer as any).unref === 'function') (timer as any).unref()
    p.then(v => { clearTimeout(timer); done(v) }, () => { clearTimeout(timer); done(fallback) })
  })
}

/**
 * 名前を引く（**そのまま断りを投げる**。理由の振り分けは runSiteCheck 側の resolveAddresses が
 * 純関数 `judgeDnsLookupError` で行う）。
 *
 * ⚠️ `dns.promises.resolve4` は A レコードが無いとき**空配列を返さない**——名前そのものが無ければ
 * `ENOTFOUND`、名前はあるが A が無ければ `ENODATA` で**断る**（2026-09-17 実測）。だから
 * 「断り＝確かめられなかった」と潰してはいけない。潰すと `'not-found'` の枝が本番で一度も出ず、
 * **ドメインをまだ設定していない人に、次の一手（A レコードを向ける）が出なくなる。**
 */
export function resolve4(host: string): Promise<string[]> {
  return dnsPromises.resolve4(host)
}

/**
 * 名前を引いて、**「引けたが0件」（空配列）と「確かめられなかった」（null）を作り分ける**。
 * 判定は書かない——断りの理由の振り分けは純関数 `judgeDnsLookupError`（掟10）。
 */
export function resolveAddresses(
  doResolve: (host: string) => Promise<string[] | null>, host: string,
): Promise<string[] | null> {
  return Promise.resolve()
    .then(() => doResolve(host))
    .then(v => (Array.isArray(v) ? v : null))
    .catch((e: any) => (judgeDnsLookupError(e?.code) === 'not-found' ? [] : null))
}

/**
 * 相手の証明書を読む（**ホスト名で繋ぐ**。IP 直打ちではない）。
 * 検証は切って繋ぎ（切らないと仮証明書のときに1文字も読めない）、読んだら**すぐ閉じる**。
 * 送るのは TLS のハンドシェイクだけで、**秘密は1バイトも送らない**（HTTP の要求すら出さない）。
 */
export function readPeerCertificate(host: string, timeoutMs: number): Promise<PeerCertificateLike | null> {
  return new Promise<PeerCertificateLike | null>(resolve => {
    let settled = false
    const done = (v: PeerCertificateLike | null) => { if (!settled) { settled = true; resolve(v) } }
    let socket: tls.TLSSocket | null = null
    const close = () => { try { socket?.destroy() } catch { /* 閉じられなければ放っておく */ } }
    try {
      socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false }, () => {
        let cert: any = null
        try { cert = socket!.getPeerCertificate() } catch { cert = null }
        close()
        done(cert && typeof cert === 'object' && Object.keys(cert).length > 0 ? cert as PeerCertificateLike : null)
      })
      socket.setTimeout(timeoutMs, () => { close(); done(null) })
      socket.on('error', () => { close(); done(null) })
    } catch {
      close(); done(null)
    }
  })
}

/**
 * **ブラウザと同じ条件**（検証を有効）でもう1回繋ぐ。繋がれば `'ok'`、証明書の理由で
 * 切られたら `'rejected'`、それ以外の失敗は `'unknown'`（繋がらなかったことを
 * 「証明書が悪い」の証拠にしない・掟1）。理由の振り分けは純関数 judgeHttpsOpenError。
 */
export function openHttpsStrict(host: string, timeoutMs: number): Promise<HttpsOpenCheck> {
  return new Promise<HttpsOpenCheck>(resolve => {
    let settled = false
    const done = (v: HttpsOpenCheck) => { if (!settled) { settled = true; resolve(v) } }
    let socket: tls.TLSSocket | null = null
    const close = () => { try { socket?.destroy() } catch { /* 閉じられなければ放っておく */ } }
    try {
      socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: true }, () => {
        const authorized = socket!.authorized
        const err = (socket as any)?.authorizationError
        close()
        done(authorized ? 'ok' : judgeHttpsOpenError(err?.code ?? err))
      })
      socket.setTimeout(timeoutMs, () => { close(); done('unknown') })
      socket.on('error', (e: any) => { close(); done(judgeHttpsOpenError(e?.code)) })
    } catch (e: any) {
      close(); done(judgeHttpsOpenError(e?.code))
    }
  })
}

// 応答本文は使わないが、判定（judgeDedicatedRootProbe）は番号しか見ないので頭だけ読む。
const SITE_CHECK_BODY_LIMIT = 4096

/**
 * アプリが応答するかを、**ホスト名で**1回だけ問い合わせる。
 * 証明書の検証は切る——ここで見たいのは「アプリが応答するか」であって、証明書の良し悪しは
 * **別の軸**で既に見ている（混ぜると、証明書が出ていないだけで「アプリが落ちている」に見える）。
 */
export function probeRootOverHttps(host: string, path: string, timeoutMs: number): Promise<DedicatedProbe> {
  return new Promise<DedicatedProbe>(resolve => {
    let settled = false
    const done = (r: DedicatedProbe) => { if (!settled) { settled = true; resolve(r) } }
    try {
      const req = https.request({
        hostname: host, port: 443, path, method: 'GET',
        servername: host,
        rejectUnauthorized: false, // 証明書の良し悪しは別の軸で見る（ここはアプリの応答だけ）
        timeout: timeoutMs,
      }, res => {
        let body = ''
        res.setEncoding('utf-8')
        res.on('data', (c: string) => { if (body.length < SITE_CHECK_BODY_LIMIT) body += c })
        res.on('end', () => done({ reached: true, status: res.statusCode ?? 0, body }))
        res.on('error', () => done({ reached: false }))
      })
      req.on('timeout', () => { req.destroy(); done({ reached: false }) })
      req.on('error', () => done({ reached: false }))
      req.end()
    } catch {
      done({ reached: false })
    }
  })
}

/**
 * 4つの軸を**1回だけ**調べる（同時に走らせ、それぞれに時間切れを入れる）。
 * **例外を投げない。** 調べられなかった軸は `'unknown'`（または app は null）にして返す。
 */
export async function runSiteCheck(
  args: { host: string; recorded: readonly string[] }, deps: SiteCheckDeps = {},
): Promise<Omit<Extract<SiteCheckResult, { ok: true }>, 'ok'>> {
  const host = String(args.host ?? '').trim().toLowerCase()
  const recorded = (args.recorded ?? []).map(s => String(s ?? '').trim()).filter(Boolean)
  const doResolve = deps.resolve4 ?? resolve4
  const doCert = deps.readCert ?? readPeerCertificate
  const doOpen = deps.openHttps ?? openHttpsStrict
  const doProbe = deps.probeRoot ?? probeRootOverHttps
  const now = deps.now ?? Date.now
  const limit = deps.timeoutMs ?? SITE_CHECK_TIMEOUT_MS
  const dnsLimit = Math.min(deps.timeoutMs ?? DNS_TIMEOUT_MS, limit)

  const [resolved, cert, httpsOpen, probe] = await Promise.all([
    // 時間切れのときだけ null（＝本当に確かめられなかった）。断りの理由は resolveAddresses が
    // 空配列（0件）と null に作り分ける——ここで一律 null に潰すと `'not-found'` が出なくなる。
    withTimeout<string[] | null>(resolveAddresses(doResolve, host), dnsLimit, null),
    withTimeout<PeerCertificateLike | null>(doCert(host, limit), limit + 1000, null),
    withTimeout<HttpsOpenCheck>(doOpen(host, limit), limit + 1000, 'unknown'),
    withTimeout<DedicatedProbe | null>(doProbe(host, dedicatedProbePath('root', now()), limit), limit + 1000, null),
  ])

  const axes = {
    dns: judgeDnsMatch(resolved, recorded),
    cert: judgePeerCertificate(cert, host, now()),
    httpsOpen,
    // 根（`/`）の翻訳は⑧と同じ judgeDedicatedRootProbe を使う（新しい判定を書かない・掟10）。
    app: probe ? judgeDedicatedRootProbe(probe) : null,
  }
  return {
    host, ...axes, resolved, recorded,
    issuer: certIssuerName(cert),
    lines: siteCheckLines(axes),
  }
}

/**
 * 記録（.sakuraide.json）からホスト名とロードバランサの IP を読み、4つの軸を1回だけ調べる。
 * IPC `apprunDedicated:checkSite` がこれを呼ぶ。**何も作らず・何も変えない**（読むだけ）。
 */
export async function checkDedicatedSite(projectDir: string, deps: SiteCheckDeps = {}): Promise<SiteCheckResult> {
  const record = readApprunDedicatedFs(projectDir)
  const host = (record.hosts ?? []).map(h => String(h ?? '').trim()).find(Boolean) ?? ''
  if (!host) {
    return { ok: false, message: 'まだアプリを公開していません。⑧で公開してから、もう一度お試しください。' }
  }
  const recorded = (record.lbAddresses ?? []).map(s => String(s ?? '').trim()).filter(Boolean)
  return { ok: true, ...(await runSiteCheck({ host, recorded }, deps)) }
}
