// client.ts — さくらのクラウド/AppRun API への HTTPクライアント雛形。
//
// 認証: Basic 認証（アクセストークン:トークンシークレット を base64 化して Authorization ヘッダへ）。
// ドライラン: mutating（POST/PUT/DELETE）は dryRun=true のとき実行せず、要求内容のみを返す。
//             GET（一覧取得など）は dryRun でも実行する。
//
// ※APIのベースURL・エンドポイントは公式仕様
//   （https://manual.sakura.ad.jp/sakura-apprun-api/spec.html）に基づくが、
//   正確なURLは実APIキーでの疎通時に確定する前提。下記の定数を1箇所にまとめ、
//   「※実APIキーでの疎通時に要確認」とコメントしてある。

import type { CloudCredentials } from './auth'
import type { EnvSpec } from './spec'

// ── APIエンドポイント定数（※実APIキーでの疎通時に要確認） ───────────────
// AppRun API のベースURL。確定した実API仕様に合わせる。末尾スラッシュ付きのベース。
// ※実APIキーでの疎通時に要確認
export const APPRUN_API_BASE = 'https://secure.sakura.ad.jp/cloud/api/apprun/1.0/apprun/api/'
// AppRunユーザー作成のエンドポイント（初回のみ。冪等的に扱う）。※実APIキーでの疎通時に要確認
export const APPRUN_USER_PATH = '/user'
// AppRunアプリ一覧/作成のエンドポイント（ベースからの相対）。※実APIキーでの疎通時に要確認
export const APPRUN_APPS_PATH = '/applications'
// 単一アプリの取得/削除パスを組み立てる（ベースからの相対）。※実APIキーでの疎通時に要確認
export function apprunAppPath(id: string): string {
  return `/applications/${id}`
}
export function apprunStatusPath(id: string): string {
  return `/applications/${encodeURIComponent(id)}/status`
}
export function apprunTrafficsPath(id: string): string {
  return `/applications/${encodeURIComponent(id)}/traffics`
}
export function apprunVersionsPath(id: string): string {
  return `/applications/${encodeURIComponent(id)}/versions`
}
export function apprunVersionPath(id: string, versionId: string): string {
  return `/applications/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}`
}
export function apprunPacketFilterPath(id: string): string {
  return `/applications/${encodeURIComponent(id)}/packet_filter`
}
// 請求（コスト）API のベースURL。段階4のコスト表示で使用。※実APIキーでの疎通時に要確認
export const BILLING_API_BASE = 'https://secure.sakura.ad.jp/cloud/api/billing/1.0'
// 当月請求の取得パス（※実APIキーでの疎通時に要確認。実APIに合わせて修正する）。
export const BILLING_PATH = '/bill'

/** auth/status レスポンスから契約のアカウントID（請求の by-contract に使う）を取り出す。 */
export function extractAccountId(data: unknown): string | null {
  const d = data as any
  const cand =
    d?.Account?.ID ?? d?.account?.id ??
    d?.Account?.Code ?? d?.account?.code ??
    d?.Member?.Code ?? d?.member?.code
  return cand != null && String(cand).length ? String(cand) : null
}

/** 請求一覧レスポンスから「直近に確定した請求の金額（円）と請求日」を取り出す。
 *  by-contract は契約の請求配列(Bills)を返す。各 Bill は {BillID, Amount(int64,円), Date} を持つ。
 *  配列の並び順に依存しないよう Date が最も新しい請求を採用する（無ければ末尾）。 */
export function extractLatestBill(data: unknown): { amountYen: number; date: string | null } | null {
  const d = data as any
  const bills = d?.Bills ?? d?.bills
  if (Array.isArray(bills) && bills.length) {
    let best: { b: any; t: number } | null = null
    for (const b of bills) {
      const t = Date.parse(b?.Date ?? b?.date ?? '')
      if (!best || (isFinite(t) && (!isFinite(best.t) || t > best.t))) best = { b, t }
    }
    const chosen = best?.b ?? bills[bills.length - 1]
    const a = chosen?.Amount ?? chosen?.amount
    const n = typeof a === 'string' ? Number(a) : a
    if (typeof n === 'number' && isFinite(n)) {
      return { amountYen: n, date: chosen?.Date ?? chosen?.date ?? null }
    }
  }
  // フォールバック: トップレベルに金額が来た場合。
  const cand = d?.Amount ?? d?.amount ?? d?.total ?? d?.Bill?.Amount ?? d?.bill?.amount
  const n = typeof cand === 'string' ? Number(cand) : cand
  return typeof n === 'number' && isFinite(n) ? { amountYen: n, date: null } : null
}

// ── コンテナレジストリ（IaaS CommonServiceItem）用の定数（※実APIキーでの疎通時に要確認） ──
//   ここは「コンテナレジストリをIDEが自動作成する」機能で使う、さくらのクラウド IaaS API の
//   既知の形である。実APIキーでの疎通確認が済むまでは下記すべてに不確実性が残るため、
//   要確認の事項を【※実APIキーでの疎通時に要確認】として 1 箇所（この区画）に集約しておく。
//
//   【※実APIキーでの疎通時に要確認】まとめ:
//   (1) ゾーン付きベースURL: `https://secure.sakura.ad.jp/cloud/zone/{zone}/api/cloud/1.1/`
//       （{zone}=spec.region 例 is1a）。末尾スラッシュ付き。
//   (2) コンテナレジストリは CommonServiceItem（Provider.Class === 'containerregistry'）。
//       一覧: GET  {zoneBase}/commonserviceitem   → CommonServiceItems を Provider.Class で絞る。
//       作成: POST {zoneBase}/commonserviceitem   → 下記 buildCreateRegistryBody のボディ。
//   (3) 作成レスポンスからの ID 取り出し（CommonServiceItem.ID 等。extractId で堅牢化）。
//   (4) push 用ユーザー作成:
//       PUT {zoneBase}/commonserviceitem/{id}/containerregistry/users/{username}
//       ボディ { "ContainerRegistryUser": { "Password": "<pw>", "Permission": "all" } }
//   (5) FQDN は `<subdomainLabel>.sakuracr.jp`（registry-auth.ts の registryServer と一致）。
//       作成ボディの Status.RegistryName に <subdomainLabel> を入れる。

// ゾーン付き IaaS API のベースURL組み立て（末尾スラッシュ付きで返す）。※実APIキーでの疎通時に要確認
export function iaasZoneBase(zone: string): string {
  return `https://secure.sakura.ad.jp/cloud/zone/${encodeURIComponent(zone)}/api/cloud/1.1/`
}
// 請求(billing)系 API のゾーン付きベースURL。サフィックスが IaaS(api/cloud/1.1)と異なり
// **api/system/1.0** である点に注意（sacloud iaas-api-go: dsl.BillingAPISuffix）。末尾スラッシュ付き。
export function billingZoneBase(zone: string): string {
  return `https://secure.sakura.ad.jp/cloud/zone/${encodeURIComponent(zone)}/api/system/1.0/`
}
// CommonServiceItem のコレクションパス（ゾーンベースからの相対）。※実APIキーでの疎通時に要確認
export const COMMONSERVICEITEM_PATH = '/commonserviceitem'
// コンテナレジストリを表す Provider.Class の値。※実APIキーでの疎通時に要確認
export const CONTAINER_REGISTRY_CLASS = 'containerregistry'
// push 用ユーザーの「コレクション」パス（追加＝POST 先）。※sacloud AddUser に準拠
export function registryUsersPath(id: string): string {
  return `/commonserviceitem/${encodeURIComponent(id)}/containerregistry/users`
}
// 単一ユーザーのパス（更新/削除用）。
export function registryUserPath(id: string, username: string): string {
  return `/commonserviceitem/${encodeURIComponent(id)}/containerregistry/users/${encodeURIComponent(username)}`
}

/** HTTPメソッド。 */
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'

/** mutating（実行すると状態を変える）メソッドの集合。 */
const MUTATING: ReadonlySet<HttpMethod> = new Set<HttpMethod>(['POST', 'PUT', 'DELETE', 'PATCH'])

/** ドライラン時に mutating 要求が返す形。 */
export type DryRunResult = {
  dryRun: true
  request: { method: HttpMethod; url: string; body: unknown }
}

/** 実行結果（GET や非ドライランの mutating）。 */
export type ApiResult = {
  dryRun: false
  ok: boolean
  status: number
  data: unknown
}

export type RequestResult = DryRunResult | ApiResult

/** クライアント生成オプション。 */
export type ClientOptions = {
  credentials: CloudCredentials
  /** true のとき mutating 要求を実行しない（既定 true＝安全側）。 */
  dryRun?: boolean
  /** ベースURL（既定 APPRUN_API_BASE）。テスト差し替え用。 */
  baseUrl?: string
}

/**
 * Basic 認証ヘッダを組み立てる（token:secret を base64）。
 * 値が空の場合でもヘッダ自体は組むが、実APIでは 401 になる想定。
 */
function basicAuthHeader(creds: CloudCredentials): string {
  const raw = `${creds.token}:${creds.secret}`
  return 'Basic ' + Buffer.from(raw, 'utf-8').toString('base64')
}

/**
 * AppRunアプリ作成時に AppRun がプライベートレジストリから pull するための認証情報。
 * dockerfile ソースをビルド/プッシュした後、main 側から渡す（段階3b）。
 */
export type RegistryAuth = { server: string; username: string; password: string }

/** deploy_source.container_registry の型（image は必須・認証情報は任意）。 */
type ContainerRegistry = {
  image: string
  server?: string
  username?: string
  password?: string
}

/** AppRunアプリ作成リクエストボディの型（確定した実API仕様に基づく）。 */
export type CreateAppBody = {
  name: string
  timeout_seconds: number
  port: number
  min_scale: number
  max_scale: number
  components: Array<{
    name: string
    max_cpu: string
    max_memory: string
    deploy_source: { container_registry: ContainerRegistry }
    env: Array<{ key: string; value: string }>
    probe: { http_get: { path: string; port: number } }
  }>
}

/** EnvSpec から components 配列を組み立てる（create/patch 共通）。 */
function buildComponents(spec: EnvSpec, registryAuth?: RegistryAuth, runtimeEnv: Array<{ key: string; value: string }> = []): CreateAppBody['components'] {
  const image = spec.service.source.type === 'image' ? spec.service.source.ref : ''
  const container_registry: ContainerRegistry = registryAuth
    ? { image, server: registryAuth.server, username: registryAuth.username, password: registryAuth.password }
    : { image }
  return [
    {
      name: 'main',
      max_cpu: '1',
      max_memory: '1Gi',
      deploy_source: { container_registry },
      env: [...spec.service.env.map(e => ({ key: e.name, value: e.value })), ...runtimeEnv],
      probe: { http_get: { path: '/', port: spec.service.port } },
    },
  ]
}

/**
 * buildCreateBody — EnvSpec から AppRunアプリ作成リクエストボディを生成する純関数（IO無し）。
 *
 * - イメージ参照は `service.source.type==='image'` の ref を使う。
 *   （dockerfile の場合は段階3でビルド/プッシュ後に image ソースへ差し替える前提のため、
 *    呼び出し側 main 側が ref を解決してから渡す。）
 * - env は spec.service.env（{name,value}）を API 形式の {key,value} に変換する。
 *   秘密（secrets）は ref のみで値を持たないため spec からは来ない。
 *   **公開のたびに発行する秘密（オブジェクトストレージのシークレットキー等）は
 *   `runtimeEnv` で受け取り、ここでデプロイ本文へ直接載せる。** env.json には
 *   決して書かない（spec.ts が平文の秘密を禁じているのと同じ理由）。
 * - registryAuth が渡された場合は container_registry に server/username/password も載せる
 *   （AppRun がプライベートレジストリから pull できるようにする）。後方互換: 無ければ従来通り image のみ。
 */
export function buildCreateBody(spec: EnvSpec, registryAuth?: RegistryAuth, runtimeEnv: Array<{ key: string; value: string }> = []): CreateAppBody {
  return {
    name: spec.name,
    timeout_seconds: 60,
    port: spec.service.port,
    min_scale: spec.service.scale.min,
    max_scale: spec.service.scale.max,
    components: buildComponents(spec, registryAuth, runtimeEnv),
  }
}

/** AppRunアプリ部分更新（再デプロイ）リクエストボディの型。 */
export type PatchAppBody = {
  components: CreateAppBody['components']
  all_traffic_available: boolean
}

/**
 * buildPatchBody — 既存アプリへ新しいイメージを再デプロイ（PATCH）するためのボディ。
 * components を差し替え、all_traffic_available:true で新バージョンへ全トラフィックを向ける。
 * URLは固定のまま新バージョンが作られる（作り直さない）。
 */
export function buildPatchBody(spec: EnvSpec, registryAuth?: RegistryAuth, runtimeEnv: Array<{ key: string; value: string }> = []): PatchAppBody {
  return { components: buildComponents(spec, registryAuth, runtimeEnv), all_traffic_available: true }
}

/** さくらのクラウド/AppRun API クライアント。 */
export class SakuraCloudClient {
  private readonly creds: CloudCredentials
  /** ドライランか。apply.ts の CloudClientLike から参照するため public（読み取り専用）。 */
  readonly dryRun: boolean
  private readonly baseUrl: string

  constructor(opts: ClientOptions) {
    this.creds = opts.credentials
    // 既定はドライラン（安全側）。実行は明示的に dryRun:false を渡したときのみ。
    this.dryRun = opts.dryRun ?? true
    this.baseUrl = opts.baseUrl ?? APPRUN_API_BASE
  }

  /** baseUrl とパスを結合して絶対URLにする。 */
  private url(pathname: string): string {
    return this.baseUrl.replace(/\/$/, '') + (pathname.startsWith('/') ? pathname : '/' + pathname)
  }

  /**
   * 低レベルのリクエスト発行。
   * - mutating かつ dryRun のときは実行せず DryRunResult を返す。
   * - GET、または dryRun:false の mutating は実際に fetch する。
   */
  async request(method: HttpMethod, pathname: string, body?: unknown): Promise<RequestResult> {
    return this._send(method, this.url(pathname), body)
  }

  /** 絶対URLに対してリクエストを発行する内部実装（AppRunベース以外＝IaaS等にも使う）。 */
  private async _send(method: HttpMethod, url: string, body?: unknown): Promise<RequestResult> {
    if (MUTATING.has(method) && this.dryRun) {
      // ドライラン: 実行せず、何を送ろうとしたかだけを返す。
      return { dryRun: true, request: { method, url, body: body ?? null } }
    }
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: basicAuthHeader(this.creds),
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
    })
    let data: unknown = null
    const text = await res.text()
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text // JSONでなければ生テキストを返す
    }
    return { dryRun: false, ok: res.ok, status: res.status, data }
  }

  /**
   * AppRunユーザーを作成（初回のみ・冪等）。POST /user。
   * 既に存在する場合（409/422 等）はエラーとせず成功扱いで返す。
   * dryRun のときは mutating なので実行されず DryRunResult を返す。
   */
  async ensureUser(): Promise<RequestResult> {
    const r = await this.request('POST', APPRUN_USER_PATH, {})
    if (r.dryRun) return r
    // 既に存在する場合のステータス（実APIで要確認）は成功とみなす。
    // ※実APIキーでの疎通時に要確認: 「既存ユーザー」を表すステータスコード。
    if (!r.ok && (r.status === 409 || r.status === 422 || r.status === 400)) {
      return { dryRun: false, ok: true, status: r.status, data: r.data }
    }
    return r
  }

  /** AppRunアプリ一覧を取得（GET。dryRunでも実行）。 */
  async listApps(): Promise<RequestResult> {
    return this.request('GET', APPRUN_APPS_PATH)
  }

  /** 単一のAppRunアプリを取得（GET。dryRunでも実行）。 */
  async getApp(id: string): Promise<RequestResult> {
    return this.request('GET', apprunAppPath(id))
  }

  /** AppRunアプリを作成（POST。dryRunのときは実行せず要求内容を返す）。 */
  async createApp(body: unknown): Promise<RequestResult> {
    return this.request('POST', APPRUN_APPS_PATH, body)
  }

  /** AppRunアプリを削除（DELETE。dryRunのときは実行せず要求内容を返す）。 */
  async deleteApp(id: string): Promise<RequestResult> {
    return this.request('DELETE', apprunAppPath(id))
  }

  /** AppRunアプリを部分更新（再デプロイ）。PATCH。dryRunのときは実行せず要求内容を返す。 */
  async patchApp(id: string, body: unknown): Promise<RequestResult> {
    return this.request('PATCH', apprunAppPath(id), body)
  }

  /** アプリのステータスを取得（GET）。 */
  async getAppStatus(id: string): Promise<RequestResult> {
    return this.request('GET', apprunStatusPath(id))
  }

  /** バージョン一覧を取得（GET）。 */
  async listVersions(id: string): Promise<RequestResult> {
    return this.request('GET', apprunVersionsPath(id))
  }

  /** 単一バージョンを取得（GET）。 */
  async getVersion(id: string, versionId: string): Promise<RequestResult> {
    return this.request('GET', apprunVersionPath(id, versionId))
  }

  /** バージョンを削除（DELETE）。dryRunのときは実行せず要求内容を返す。 */
  async deleteVersion(id: string, versionId: string): Promise<RequestResult> {
    return this.request('DELETE', apprunVersionPath(id, versionId))
  }

  /** トラフィック分散を取得（GET）。 */
  async getTraffics(id: string): Promise<RequestResult> {
    return this.request('GET', apprunTrafficsPath(id))
  }

  /** トラフィック分散を変更（PUT）。body は [{is_latest_version|version_name, percent}] の配列。dryRunのときは実行せず要求内容を返す。 */
  async putTraffics(id: string, body: unknown): Promise<RequestResult> {
    return this.request('PUT', apprunTrafficsPath(id), body)
  }

  /** パケットフィルタを取得（GET）。 */
  async getPacketFilter(id: string): Promise<RequestResult> {
    return this.request('GET', apprunPacketFilterPath(id))
  }

  /** パケットフィルタを部分変更（PATCH）。body は {is_enabled, settings:[{from_ip, from_ip_prefix_length}]}。dryRunのときは実行せず要求内容を返す。 */
  async patchPacketFilter(id: string, body: unknown): Promise<RequestResult> {
    return this.request('PATCH', apprunPacketFilterPath(id), body)
  }

  /**
   * 疎通テスト。アプリ一覧の取得（GET）を試みて成否を返す。
   * ※実際の成功には有効な実APIキーが必要。本段階では疎通未確認で良い
   *   （ネットワーク到達・認証可否のみを判定する雛形）。
   */
  async testConnection(): Promise<{ ok: boolean; status?: number; message?: string }> {
    try {
      const r = await this.listApps()
      if (r.dryRun) {
        // GET はドライランでも実行されるため、ここには通常来ない。防御的に扱う。
        return { ok: false, message: 'GETがドライラン扱いになりました（想定外）' }
      }
      if (r.ok) return { ok: true, status: r.status }
      if (r.status === 401 || r.status === 403) {
        return { ok: false, status: r.status, message: '認証に失敗しました（アクセストークン/シークレットを確認してください）' }
      }
      return { ok: false, status: r.status, message: `APIエラー（HTTP ${r.status}）` }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  }

  // ── コンテナレジストリ（IaaS CommonServiceItem）。zone付きベースURLを使う。※実APIキーでの疎通時に要確認 ──
  private iaasUrl(zone: string, pathname: string): string {
    return iaasZoneBase(zone).replace(/\/$/, '') + (pathname.startsWith('/') ? pathname : '/' + pathname)
  }
  // 請求(billing)系 API 用。サフィックスが api/system/1.0 と異なるため iaasUrl とは別に組み立てる。
  private billingUrl(zone: string, pathname: string): string {
    return billingZoneBase(zone).replace(/\/$/, '') + (pathname.startsWith('/') ? pathname : '/' + pathname)
  }

  /** コンテナレジストリ（CommonServiceItem の containerregistry）を一覧。GET。 */
  async listContainerRegistries(zone: string): Promise<RequestResult> {
    return this._send('GET', this.iaasUrl(zone, COMMONSERVICEITEM_PATH))
  }

  /** コンテナレジストリを作成。POST。dryRun時は実行せず要求を返す。push用ユーザーは別途 addRegistryUser で追加。 */
  async createContainerRegistry(zone: string, opts: { name: string; subdomainLabel: string }): Promise<RequestResult> {
    return this._send('POST', this.iaasUrl(zone, COMMONSERVICEITEM_PATH), buildCreateRegistryBody(opts))
  }

  /** コンテナレジストリを削除（DELETE /commonserviceitem/{id}）。レジストリ・ユーザー・イメージごと消える。 */
  async deleteContainerRegistry(zone: string, id: string): Promise<RequestResult> {
    return this._send('DELETE', this.iaasUrl(zone, `${COMMONSERVICEITEM_PATH}/${encodeURIComponent(id)}`))
  }

  /** 認証状態（アカウント情報）を取得。billing の accountID を得るために使う。GET。
   *  sacloud の PathName は "auth-status"（ハイフン）。cloud/1.1 配下。 */
  async getAuthStatus(zone: string): Promise<RequestResult> {
    return this._send('GET', this.iaasUrl(zone, '/auth-status'))
  }

  /** 契約（accountID）の請求一覧を取得。GET /bill/by-contract/{accountID}。
   *  ※請求APIは IaaS と別サフィックス(api/system/1.0)なので billingUrl を使う。 */
  async getBillByContract(zone: string, accountId: string): Promise<RequestResult> {
    return this._send('GET', this.billingUrl(zone, `/bill/by-contract/${encodeURIComponent(accountId)}`))
  }

  /** push用ユーザーを作成する（sacloud AddUser＝コレクションへ POST）。
   *  POST /commonserviceitem/{id}/containerregistry/users
   *  公式の RequestEnvelope に従い、ユーザーは "ContainerRegistry" キーで包む。 */
  async addRegistryUser(zone: string, id: string, opts: { username: string; password: string; permission?: string }): Promise<RequestResult> {
    return this._send('POST', this.iaasUrl(zone, registryUsersPath(id)), {
      ContainerRegistry: { username: opts.username, password: opts.password, permission: opts.permission ?? 'readwrite' },
    })
  }

  /** 既存 push用ユーザーのパスワード/権限を更新する（PUT、ユーザー名はURL）。 */
  async updateRegistryUser(zone: string, id: string, opts: { username: string; password: string; permission?: string }): Promise<RequestResult> {
    return this._send('PUT', this.iaasUrl(zone, registryUserPath(id, opts.username)), {
      ContainerRegistry: { username: opts.username, password: opts.password, permission: opts.permission ?? 'readwrite' },
    })
  }
}

/** コンテナレジストリ作成リクエストボディ（※実APIキーでの疎通時に要確認）。
 *  さくらのクラウド API（CommonServiceItem）の形に合わせる。AccessLevel は
 *  'readwrite'|'readonly'|'none'（匿名アクセスの既定。push は別途ユーザー権限で行う）。 */
export function buildCreateRegistryBody(opts: { name: string; subdomainLabel: string }): unknown {
  // 実APIの検証より判明:
  //  - registry_name（サブドメインラベル）は Status.registry_name（小文字キー）。
  //  - public（公開範囲: none/readonly）は Settings.ContainerRegistry.public。
  //  push 用ユーザーは作成後に別途 addRegistryUser（POST .../users）で追加する。
  // public の置き場所はサーバ実装に揺れがあるため、両表記のキーで設定して取りこぼしを防ぐ。
  const cr = { public: 'none' }
  return {
    CommonServiceItem: {
      Name: opts.name,
      Status: { registry_name: opts.subdomainLabel },
      Provider: { Class: CONTAINER_REGISTRY_CLASS },
      Settings: { container_registry: cr, ContainerRegistry: cr },
    },
  }
}

/** さくらのクラウドAPIのエラー応答から人間可読なメッセージを取り出す（診断用）。
 *  実応答例（2026-07-12 ユーザー報告・AppRunアプリ作成上限）:
 *  {"error":{"code":400,"message":"Validation Error","errors":[{"reason":"violates application restriction",
 *   "message":"Creation limit reached.","location_type":"body"}]}} のようにネストした
 *  error.errors[0] に最も具体的な理由が入ることがあり、従来（トップレベルの message/error_msg/error_code
 *  のみ参照）はこの形を拾えず JSON.stringify の生JSONにフォールバックしてしまっていた。
 *  優先順: error.errors[0].message（具体的） → error.message → 既存のトップレベルキー → 最後の手段としてJSON全文。
 *  ※ 抽出結果は実文言をそのまま残すこと（renderer側 nameConflict.ts の isCreationLimitError が
 *    "Creation limit reached" 等の部分一致でパターンマッチするため、要約・書き換えをしない）。 */
export function apiErrorMessage(data: unknown): string {
  const d = data as any
  if (d == null) return ''
  if (typeof d === 'string') return d.slice(0, 300)

  const nestedError = d.error && typeof d.error === 'object' ? d.error : null
  const nestedDetail = nestedError?.errors?.[0]
  if (nestedDetail?.message) {
    // reason がmessageと異なる具体情報を持つ場合は「message（reason）」の形で併記する。
    const reason = nestedDetail.reason
    const detail = reason && reason !== nestedDetail.message ? `${nestedDetail.message}（${reason}）` : nestedDetail.message
    return String(detail).slice(0, 400)
  }
  if (nestedError?.message) return String(nestedError.message).slice(0, 400)

  const msg = d.error_msg ?? d.errorMsg ?? d.message ?? d.Message
  const code = d.error_code ?? d.errorCode
  const fatal = d.is_fatal ?? d.isFatal
  const parts = [code, msg].filter(Boolean).join(': ')
  return (parts || JSON.stringify(d)).slice(0, 400) + (fatal ? '' : '')
}

/** CommonServiceItem 配列からコンテナレジストリだけ取り出す（※レスポンス形は要確認）。 */
export function pickContainerRegistries(data: unknown): Array<{ id: string; subdomainLabel: string }> {
  const items = (data as any)?.CommonServiceItems ?? (data as any)?.commonserviceitems ?? []
  if (!Array.isArray(items)) return []
  return items
    .filter((it: any) => (it?.Provider?.Class ?? it?.provider?.class) === CONTAINER_REGISTRY_CLASS)
    .map((it: any) => ({
      id: String(it?.ID ?? it?.id ?? ''),
      // サブドメインラベルは Status.registry_name（小文字キー。作成時の検証で判明）。
      subdomainLabel: String(
        it?.Status?.registry_name ?? it?.status?.registry_name ??
        it?.Status?.RegistryName ?? it?.status?.registryName ?? '',
      ),
    }))
    .filter((r: { id: string }) => r.id)
}

/** AppRunアプリの取得レスポンスから公開URLを取り出す（※フィールド名は実APIで要確認）。
 *  候補: public_url / url / status.public_url / status.url / application.public_url など。 */
export function extractAppUrl(data: unknown): string | null {
  const d = data as any
  const cand =
    d?.public_url ?? d?.url ?? d?.publicUrl ??
    d?.status?.public_url ?? d?.status?.url ?? d?.status?.publicUrl ??
    d?.application?.public_url ?? d?.application?.url ??
    d?.data?.public_url ?? d?.data?.url
  if (typeof cand === 'string' && /^https?:\/\//.test(cand)) return cand
  return null
}

/** 作成レスポンスから CommonServiceItem の ID を取り出す（※レスポンス形は要確認）。 */
export function extractRegistryId(data: unknown): string | null {
  const d = data as any
  const id = d?.CommonServiceItem?.ID ?? d?.CommonServiceItem?.id ?? d?.ID ?? d?.id
  return id != null ? String(id) : null
}
