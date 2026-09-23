// apprunDedicatedApp.ts — さくらのAppRun 専有型「アプリを公開する」（roadmap #23 ⑤・段階③、
// docs/apprun-dedicated-plan.md 12-1〜12-3）の純粋ロジック。申請本文の組み立て・入力検証・
// 世代管理（古いバージョンの掃除）だけを持つ。
//
// electron/DOM 非依存・node 組み込み（fs/path等）は import しない（apprunDedicatedShapes.ts と
// 同じ理由。shared は renderer からも import され、vite が node 組み込みを空 shim にするため
// 実行時に壊れる。tests/appChatDirs.test.ts が src/shared 全体に対してこれを固定している）。
// imageRetention.ts からの DEFAULT_KEEP の import は shared 内の別モジュールなので問題ない。
//
// **依存の順序・実在確認・記録**（createClusterFlow 相当の publishAppFlow）はここには置かない。
// ここは spec→本文の組み立てと検証だけの純関数集合（apprunDedicatedApply.ts の
// validateClusterSpec・build*Body と同じ役割分担）。
//
// 原本（OpenAPI v1.4.0）の該当スキーマ:
//   POST /applications                  → CreateApplicationRequest（name・clusterID のみ必須）
//   POST /applications/{id}/versions    → CreateApplicationVersionRequest（9キー必須。5-4・12-1）
//   PATCH /clusters/{id}/load_balancer  → PatchClusterLoadBalancerRequest（letsEncryptEmail・ports、どちらも任意）

import { DEFAULT_KEEP } from './imageRetention'
import { readLoadBalancerNodeAddresses } from './apprunDedicatedShapes'

/**
 * ネットマスク付きのアドレスから、DNS の A レコードに書く**素の IP** だけを取り出す（D-5・5-13）。
 *
 * 2026-09-16 の実測で、`GET .../load_balancer_nodes` の `addresses[].address` は `59.106.222.212/24` の
 * ように**ネットマスク付き**だと分かった（原本 OpenAPI と同じ形）。A レコードに書くのは `/` より前だけ。
 * - `/` が無ければそのまま返す（`203.0.113.10` → `203.0.113.10`）
 * - 空文字・`/` 始まり（IP 部分が無い）は `''`（呼び出し側が捨てる。`/24` を IP として案内しない）
 * 読み取り（readLoadBalancerNodeAddresses）は原本の形をそのまま返し、ここで初めて素の IP にする。
 */
export function bareIp(address: string): string {
  if (typeof address !== 'string') return ''
  const s = address.trim()
  if (s.length === 0 || s.startsWith('/')) return ''
  const slash = s.indexOf('/')
  return slash < 0 ? s : s.slice(0, slash)
}

/**
 * `GET .../load_balancer_nodes` の応答から、DNS の A レコードに書く素の IP の配列を作る
 * （readLoadBalancerNodeAddresses → 全ノード・全インターフェースのアドレス → bareIp。空になったものは捨てる）。
 * lb-address 段（publishAppFlow）と「IP を取り直す」（refreshLbAddresses）の両方がこれを使う（同じ変換を2か所に書かない・掟10）。
 */
export function collectBareLbAddresses(data: unknown): string[] {
  return readLoadBalancerNodeAddresses(data)
    .flatMap(r => r.addresses.map(a => bareIp(a.address)))
    .filter(ip => ip.length > 0)
}

/** ⑤の入力欄そのまま（12-2）。 */
export type ApprunDedicatedAppSpec = {
  name: string
  host: string
  port: number
  cpu: number
  memory: number
  fixedScale: number
  env: { key: string; value: string; secret: boolean }[]
  healthCheckPath?: string
}

/**
 * 既定スペック（決定 B-2・12-3・2026-09-11 Ryosuke さん決定）。
 *
 * 既定ワーカ（1vCPU/2GB）に置ける最大は 1000mCPU/1248MiB（予約800MiB。マニュアル技術概要
 * 「デプロイ可能スペック」・docs/apprun-dedicated-plan.md 12-1）。**ローリングアップデートは
 * 新旧2つ分の空きが要る**ため、1ノード構成ではアプリを最大の半分以下にしないと更新で詰まる。
 * cpu 500 / memory 512 はその半分以下（500≤500・512≤624）に収まる。
 */
export const APP_DEFAULTS = { cpu: 500, memory: 512, fixedScale: 1 } as const

/** POST /applications の name と同じ制約（原本 CreateApplicationRequest: pattern・minLength1・maxLength20）。 */
export const APPLICATION_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,20}$/

/**
 * exposedPorts[].host の要素の制約（原本 Hostname スキーマの pattern をそのまま）。
 * RFC1123 DNS subdomain names・小文字のみ。
 */
export const HOSTNAME_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/

/**
 * base からアプリケーション名を作る（原本の制約に収める）。
 * 許されない文字（英数字・`_`・`-` 以外）は `-` に、連続する `-` は1つに、両端の `-`/`_` を落とし、
 * 20文字に切る。結果が空になれば `'app'`。
 */
export function deriveApplicationName(base: string): string {
  let s = (base ?? '').replace(/[^a-zA-Z0-9_-]/g, '-')
  s = s.replace(/-{2,}/g, '-')
  s = s.replace(/^[-_]+/, '').replace(/[-_]+$/, '')
  s = s.slice(0, 20)
  return s.length > 0 ? s : 'app'
}

/**
 * 1つのバージョンに載せられる環境変数の上限（validateAppSpec が最後の砦として見ている数）。
 *
 * **定数にした理由（2026-09-23）。** 専有型にも保存場所の鍵を渡すようになり、
 * 宣言済みの環境変数に `KOTO_STORAGE_*` の6件が**足される**。足した結果ここを超えると、
 * 公開は「環境変数が多すぎます」で落ちる。利用者に「保存場所の分で6件増える」と
 * 説明するには、上限を見る側（ipc/apprunDedicated.ts）と弾く側が**同じ数**を見る必要がある。
 */
export const MAX_ENV_COUNT = 50

export type AppSpecValidation = { ok: true } | { ok: false; message: string }

/**
 * ⑤の入力を検証する（createClusterFlow の validateClusterSpec と同じ役割・同じ型）。
 * 違反があれば**最初の1件だけ**を返す（同じ方針。apprunDedicatedApply.ts の validateClusterSpec 参照）。
 */
export function validateAppSpec(spec: ApprunDedicatedAppSpec): AppSpecValidation {
  if (typeof spec.name !== 'string' || !APPLICATION_NAME_PATTERN.test(spec.name)) {
    return { ok: false, message: `アプリ名は1〜20文字の英数字・_・- で指定してください（受け取った値: ${JSON.stringify(spec.name)}）` }
  }
  // host は小文字化しない（入力をそのまま検証する。大文字が混じっていればここで弾く）。
  if (typeof spec.host !== 'string' || !HOSTNAME_PATTERN.test(spec.host)) {
    return { ok: false, message: `ホスト名は小文字の英数字・ハイフン・ドットで指定してください（受け取った値: ${JSON.stringify(spec.host)}）` }
  }
  if (!Number.isInteger(spec.port) || spec.port < 1 || spec.port > 65535) {
    return { ok: false, message: `ポート番号は1〜65535の整数で指定してください（受け取った値: ${JSON.stringify(spec.port)}）` }
  }
  if (!Number.isInteger(spec.cpu) || spec.cpu < 100 || spec.cpu > 64000) {
    return { ok: false, message: `cpu は100〜64000（mCPU）の整数で指定してください（受け取った値: ${JSON.stringify(spec.cpu)}）` }
  }
  if (!Number.isInteger(spec.memory) || spec.memory < 128 || spec.memory > 131072) {
    return { ok: false, message: `memory は128〜131072（MB）の整数で指定してください（受け取った値: ${JSON.stringify(spec.memory)}）` }
  }
  if (!Number.isInteger(spec.fixedScale) || spec.fixedScale < 1 || spec.fixedScale > 50) {
    return { ok: false, message: `fixedScale は1〜50の整数で指定してください（受け取った値: ${JSON.stringify(spec.fixedScale)}）` }
  }
  if (!Array.isArray(spec.env) || spec.env.length > MAX_ENV_COUNT) {
    return { ok: false, message: `環境変数は${MAX_ENV_COUNT}件以下で指定してください（受け取った件数: ${Array.isArray(spec.env) ? spec.env.length : JSON.stringify(spec.env)}）` }
  }
  for (const e of spec.env) {
    if (!e || typeof e.key !== 'string' || e.key.length === 0) {
      return { ok: false, message: '環境変数のキーを指定してください（空のキーは不可）' }
    }
  }
  if (spec.healthCheckPath !== undefined && !spec.healthCheckPath.startsWith('/')) {
    return { ok: false, message: `ヘルスチェックのパスは / から始めてください（受け取った値: ${JSON.stringify(spec.healthCheckPath)}）` }
  }
  return { ok: true }
}

/** POST /applications の本文（原本 CreateApplicationRequest: name・clusterID のみ必須）。 */
export function buildApplicationCreateBody(input: { name: string; clusterID: string }): { name: string; clusterID: string } {
  return { name: input.name, clusterID: input.clusterID }
}

/**
 * POST /applications/{id}/versions の本文（原本 CreateApplicationVersionRequest の必須9キーすべてを持つ・5-4）。
 *
 * - `scalingMode` は常に `'manual'`（最小構成の方針・12-3決定2）。`minScale`/`maxScale`/
 *   `scaleInThreshold`/`scaleOutThreshold`/`cmd` は原本では任意のため送らない。
 * - `loadBalancerPort` は常に443固定（独自ドメイン＝https のみを扱う方針。12-3決定1「お試し公開は出さない」）。
 * - `useLetsEncrypt: true` 固定（独自ドメインのTLSはここで有効化。12-1）。
 * - `host` は `exposedPorts[].host` が「HTTP/HTTPSのLBポートを使うなら必須」（原本 ExposedPort）
 *   なので常に `[spec.host]` を渡す。
 * - `healthCheck` は `spec.healthCheckPath` があるときだけ設定し、無ければ `null`
 *   （原本の healthCheck 自体は必須キーだが null 可）。
 *   `intervalSeconds: 30`・`timeoutSeconds: 5` は原本 HealthCheck スキーマの既定値に合わせた
 *   （2026-09-12。担当は 10 を置いていたが、原本に既定があるので原本を優先＝掟1）。
 *   HealthCheck の3キー（path/intervalSeconds/timeoutSeconds）は原本でも必須のため、
 *   healthCheck を送る以上どのみち明示が要る——原本の default はあくまで
 *   「未指定時にサーバが使う値」の参考情報で、request としては必須。この食い違いは報告に明記する。
 */
export function buildVersionCreateBody(
  spec: ApprunDedicatedAppSpec,
  image: string,
  registry: { username: string | null; password: string | null; action: 'keep' | 'remove' | 'new' },
): Record<string, unknown> {
  return {
    image,
    cpu: spec.cpu,
    memory: spec.memory,
    scalingMode: 'manual',
    fixedScale: spec.fixedScale,
    env: spec.env.map(e => ({ key: e.key, value: e.value, secret: e.secret })),
    exposedPorts: [
      {
        targetPort: spec.port,
        loadBalancerPort: 443,
        useLetsEncrypt: true,
        healthCheck: spec.healthCheckPath
          ? { path: spec.healthCheckPath, intervalSeconds: 30, timeoutSeconds: 5 }
          : null,
        host: [spec.host],
      },
    ],
    registryUsername: registry.username,
    registryPassword: registry.password,
    registryPasswordAction: registry.action,
  }
}

/** PUT /applications/{id} の本文（原本 UpdateApplicationRequest: activeVersion のみ・null可）。 */
export function buildActiveVersionBody(version: number | null): { activeVersion: number | null } {
  return { activeVersion: version }
}

/**
 * PATCH /clusters/{id}/load_balancer の本文（原本 PatchClusterLoadBalancerRequest）。
 * `ports` は送らない——merge patch（RFC7396）なので無変更のはず。**未確認**（実 API でまだ確かめていない）。
 */
export function buildLetsEncryptPatchBody(email: string): { letsEncryptEmail: string } {
  return { letsEncryptEmail: email }
}

// ── G-1（2026-09-16）: ⑤の待ち受けポートに、必ず要る2つが揃っているか ───────────────────
// さくらの公式マニュアル「AppRun 専有型 コントロールパネル操作ガイド」に、ロードバランサと
// Let's Encrypt を同時に使う場合は HTTP-01 のために 80/http を開けておく必要があると明記がある。
// Koto の専有型は必ず loadBalancerPort: 443・useLetsEncrypt: true で公開する作り（上の
// buildVersionCreateBody）なので、**80/http が無ければ証明書は永久に出ず、443/https が無ければ
// アプリを載せる先そのものが無い**。どちらも⑤の詳細設定で消せてしまうため、消えていないかを
// ここ1か所（純関数）で判定する（掟10）。

/** 専有型のクラスタが必ず持っていなければならない待ち受けポート。 */
export const REQUIRED_CLUSTER_PORTS = [
  { port: 80, protocol: 'http' },
  { port: 443, protocol: 'https' },
] as const

/**
 * 待ち受けポートに、足りないものがあるか（純関数）。足りないものの一覧を返す（無ければ空配列）。
 * ポート番号とプロトコルの**両方**が一致していないと「ある」とは見なさない（`80/https` は
 * `80/http` の代わりにならない——HTTP-01 は http で待ち受けている必要がある）。
 * 入力が壊れていても落ちない（配列でなければ「1件もポートが無い」として扱う）。
 */
export function missingRequiredPorts(
  ports: readonly { port: number; protocol: string }[] | null | undefined,
): { port: number; protocol: string }[] {
  const given = Array.isArray(ports) ? ports : []
  return REQUIRED_CLUSTER_PORTS.filter(
    req => !given.some(p => p && p.port === req.port && p.protocol === req.protocol),
  )
}

// ── F-1（2026-09-16）: ⑧の Let's Encrypt メール欄・メールの形の検査 ──────────────────
// メールアドレスの入力欄を⑧「アプリを公開する」に一本化した（⑤クラスタ作成にあった欄は削除）。
// 理由: メールが要るのは独自ドメインの証明書のためで、ドメイン名を入れるのは⑧。⑧の経路だけが
// 「設定できたか」を読み直して確かめている（main の apprunDedicatedAppApply.ts の
// 'lets-encrypt' 段）。⑤で入れた値は記録にも残らず、さくらの API も値そのものは返さない
// （返るのは hasLetsEncryptEmail という真偽値だけ）ため、⑤→⑧へ値を引き継ぐことは原理的にできない。

/** ⑧の Let's Encrypt メール欄をどう出すか（`show`＝欄自体を出すか・`required`＝空で公開を止めるか）。 */
export type LetsEncryptEmailFieldState = { show: boolean; required: boolean }

/**
 * `hasLetsEncryptEmail`（`GET /clusters/{id}` を読んだ3状態。
 * src/shared/apprunDedicatedShapes.ts の `readHasLetsEncryptEmail` が返す）から、
 * ⑧のメール欄をどう出すかを決める（純関数）。
 *
 * - `false`（未設定と分かっている） → 欄を出し、**必須**にする
 * - `null`（確かめられなかった。通信が一時的に失敗した等） → 欄は出すが**任意**にする。
 *   ここを必須にすると、実際は設定済みの人が一時的な通信失敗だけで公開できなくなる。
 *   main 側は `hasLetsEncryptEmail` が true なら送られた値を使わないので、空のまま
 *   進んでも害は無い
 * - `true`（設定済み） → 欄は出さない（アドレスそのものは API が返さないので出せない）
 */
export function letsEncryptEmailFieldState(hasLetsEncryptEmail: boolean | null): LetsEncryptEmailFieldState {
  if (hasLetsEncryptEmail === false) return { show: true, required: true }
  if (hasLetsEncryptEmail === true) return { show: false, required: false }
  return { show: true, required: false }
}

/**
 * メールアドレスの**最低限の**形を確かめる（画面 ⑧ の入力検査用）。
 *
 * ⚠️ これは Koto 側の最低限の確認であって、さくらが受け付ける形の完全な再現ではない
 * （この判定の根拠になる pattern を、このリポジトリの中では確認できていない。原本にこう
 * 書いてある、という主張はしない）。
 *
 * 判定は**ゆるく**する——`@` がちょうど1つあり、その前後に空でない文字があり、空白を
 * 含まない、だけを見る。日本語ドメインや長い TLD のような、正しいアドレスを誤って
 * 弾かないため（厳しくしすぎない）。
 */
export function isLikelyEmail(s: string): boolean {
  if (typeof s !== 'string') return false
  const trimmed = s.trim()
  if (trimmed.length === 0 || /\s/.test(trimmed)) return false
  const at = trimmed.indexOf('@')
  if (at <= 0 || at === trimmed.length - 1) return false // '@' が無い／先頭／末尾
  return trimmed.indexOf('@', at + 1) === -1 // '@' が2つ以上は不可
}

/**
 * 古いバージョンのうち、消してよい version 番号を決める（世代管理・12-3決定5「共用型と同じ数」）。
 *
 * `created` の新しい順に `keep` 件を残し、加えて `active`（現在有効なバージョン）は
 * **必ず残す**（keep件のうちに入っていなくても別枠で残す）。それ以外を version の昇順で返す
 * （imageRetention.ts の「古い順に消す」digestsToDelete とは向きが逆——versionは若いほど古いため、
 * 昇順＝古い順のまま呼び出し側が使える）。
 *
 * @param keep 残す件数（既定は共用型と同じ DEFAULT_KEEP=5）。
 */
export function versionsToDelete(
  rows: { version: number; created: number }[],
  active: number | null,
  keep: number = DEFAULT_KEEP,
): number[] {
  const sorted = [...rows].sort((a, b) => b.created - a.created) // 新しい順
  const keepSet = new Set<number>()
  if (active !== null) keepSet.add(active)
  let kept = 0
  for (const r of sorted) {
    if (keepSet.has(r.version)) continue
    if (kept >= keep) continue
    keepSet.add(r.version)
    kept++
  }
  return rows.map(r => r.version).filter(v => !keepSet.has(v)).sort((a, b) => a - b)
}

// ── D-10（2026-09-16 実機実測）: アプリ削除の 400 は「やり直せば解ける理由」が2つある ─────────
//
// さくらの AppRun 専有型は、アプリの削除を2つの理由で断ってくる（2026-09-16 実機で両方観測）:
//   ・`Cannot delete application because it has active version`  … 有効なバージョンが残っている
//   ・`Cannot delete application because it is currently running` … コンテナがまだ動いている
// どちらも**こちらの手当て（無効化・待ち）で解ける**ので、やり直す価値がある。それ以外の 400 は
// やり直しても同じなので即座に止める（課金が続くことを隠さないため）。
//
// **文言の条件をここ1か所に固める。** 呼び出し側に `includes('...')` を書き散らすと、3つ目の
// 文言が出たときに直し忘れる（2026-09-16、実際に2つ目で直し忘れた）。加えて、比較は配列の
// `.some()` 経由にする——`title.` に文字列リテラルをそのまま繋げた呼び出しの形をソース中に
// 直書きしないため（`tests/apprunDedicatedApp.test.ts` が `grep` 相当でこの形の散らばりを禁じる）。
const APP_DELETE_RETRYABLE_NEEDLES = ['active version', 'currently running'] as const

/**
 * アプリの削除が 400 で断られたとき、**待てば消える見込みがあるか**（純関数）。
 * 小文字化した title にいずれかの文言が含まれれば true。それ以外・null・空文字は false。
 */
export function appDeleteRetryable(title: string | null | undefined): boolean {
  if (!title) return false
  const lower = title.toLowerCase()
  return APP_DELETE_RETRYABLE_NEEDLES.some(needle => lower.includes(needle))
}

/**
 * やり直しの上限（3回）に達してもアプリの削除が 400 のままだったときの、画面向けメッセージ（純関数）。
 * `title` からどちらの理由で止まったかを判定し、**その理由に合った文面**を返す——理由を決め打ちで
 * 「有効なバージョンが解消しません」と書くと、`currently running` で止まったときに嘘になる
 * （2026-09-16 実機実測）。判定に使う文言は `appDeleteRetryable` と同じ配列（掟10・1か所）。
 * どの理由にも当たらなければ（想定外・呼び出し側のガードが緩んだとき）汎用の文面にする。
 */
export function appDeleteExhaustedMessage(title: string | null | undefined, rawMessage: string): string {
  const lower = (title ?? '').toLowerCase()
  if (lower.includes(APP_DELETE_RETRYABLE_NEEDLES[0])) {
    return `アプリケーションの削除に失敗しました。有効なバージョンが解消しません＝課金が続きます: ${rawMessage}`
  }
  if (lower.includes(APP_DELETE_RETRYABLE_NEEDLES[1])) {
    return `アプリケーションの削除に失敗しました。コンテナの停止が終わりません＝課金が続きます: ${rawMessage}`
  }
  return `アプリケーションの削除に失敗しました。残っています＝課金が続きます: ${rawMessage}`
}
