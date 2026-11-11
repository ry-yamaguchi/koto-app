// client.ts — HANAMII PaaS デプロイAPI への HTTPクライアント（段階1: 基盤）。
//
// src/main/cloud/client.ts（さくらのクラウド/AppRun 用クライアント）と同じ構成を踏襲する。
// Electron メインプロセス（Node）専用: グローバルの fetch / AbortSignal.timeout を用いる純粋ロジックのみで、
// electron や renderer 側のコードは一切 import しない（esbuild で単体テスト可能な状態を保つ）。
//
// 認証: 全APIコールで `Authorization: Bearer <token>`（トークンは `hnm_` で始まる）。
// アップロードは 2 段階: (1) createUpload でアップロード枠（uploadUrl）を取得し、
// (2) uploadZip で外部ストレージへ直接 PUT する（このPUTには Authorization を付けない）。

import { failureText } from '../../shared/failureText'
import { maskSecretShapes } from '../../shared/secretShapes'

/** 既定の時間切れ（本文の読み取りまで含む）。 */
export const HANAMII_REQUEST_TIMEOUT_MS = 30_000
/**
 * 時間のかかる4つ（検証 check・作成・再デプロイ deploy・restart）の時間切れ＝20 分。
 * 公式 CLI も、これらに 20 分を使っている（CLI は分割アップロードの検証にも 20 分を使うが、Koto はその経路を使わない）。
 * HANAMII は 1 秒を超えるとこれらを keepalive の空白を流す
 * ストリームで返し、本文が終わるまで続くので、30 秒では本文の読み取り中に切れてしまう。ほかの要求は 30 秒のまま。
 */
export const HANAMII_LONG_REQUEST_TIMEOUT_MS = 20 * 60 * 1000

/** HANAMII API のベースURL。 */
export const HANAMII_API_BASE = 'https://hanamii.jp'

// ── APIエンドポイント定数 ───────────────────────────────────────
export const HANAMII_WORKSPACES_PATH = '/api/v1/workspaces'
export const HANAMII_UPLOADS_PATH = '/api/v1/uploads'
export function hanamiiUploadCheckPath(uploadId: string): string {
  return `/api/v1/uploads/${encodeURIComponent(uploadId)}/check`
}
export const HANAMII_PROJECTS_PATH = '/api/v1/projects'
export function hanamiiProjectPath(id: string): string {
  return `/api/v1/projects/${encodeURIComponent(id)}`
}
export function hanamiiProjectDeployPath(id: string): string {
  return `/api/v1/projects/${encodeURIComponent(id)}/deploy`
}
export function hanamiiProjectEnvPath(id: string): string {
  return `/api/v1/projects/${encodeURIComponent(id)}/env`
}
export function hanamiiProjectHealthCheckPath(id: string): string {
  return `/api/v1/projects/${encodeURIComponent(id)}/health-check`
}
export function hanamiiProjectRestartPath(id: string): string {
  return `/api/v1/projects/${encodeURIComponent(id)}/restart`
}
export function hanamiiProjectLogsPath(id: string): string {
  return `/api/v1/projects/${encodeURIComponent(id)}/logs`
}

// ── 型 ─────────────────────────────────────────────────────────
/** API呼び出しの汎用結果（成否・ステータス・生データ）。 */
export type HanamiiResult = {
  ok: boolean
  status: number
  data: unknown
  /** 本文に {"error":{"code","message"}}（または error の文字列）があったとき、取り出した中身。HTTP の状態に関わらず付く。 */
  apiError?: { code: string | null; message: string | null }
}

/** 環境変数1件（type省略時はplain想定）。 */
export type HanamiiEnv = { key: string; value: string; type?: 'plain' | 'secret' }

/** ヘルスチェック設定。 */
export type HanamiiHealthCheck = { enabled: boolean; path: string; port: number | null }

/** ログ1行。 */
export type HanamiiLogEntry = { timestamp: string; message: string }

/** プロジェクト作成リクエストボディ。 */
export type CreateProjectBody = {
  name: string
  workspaceId: string
  source: { type: 'zip'; checkId: string; rootDirectory?: string }
  envs?: HanamiiEnv[]
  healthCheck?: HanamiiHealthCheck
}

/** envs を PATCH /env 用ボディへ変換する（空keyは除外・typeは既定 'plain'）。 */
export function buildPatchEnvBody(envs: HanamiiEnv[]): { envs: HanamiiEnv[] } {
  const list = (envs ?? [])
    .filter(e => e && typeof e.key === 'string' && e.key.trim())
    .map(e => ({ key: e.key.trim(), value: e.value ?? '', type: e.type ?? 'plain' as const }))
  return { envs: list }
}

/** ヘルスチェック設定を正規化する（path の先頭 `/` 補正・port は null/数値以外を null に）。 */
export function normalizeHealthCheck(hc: HanamiiHealthCheck): HanamiiHealthCheck {
  const rawPath = typeof hc?.path === 'string' ? hc.path.trim() : ''
  const path = rawPath ? (rawPath.startsWith('/') ? rawPath : `/${rawPath}`) : '/'
  const port = typeof hc?.port === 'number' && Number.isFinite(hc.port) ? hc.port : null
  return { enabled: !!hc?.enabled, path, port }
}

/** 本文（JSON）の error キーを読む。オブジェクトなら {code,message}、空でない文字列なら message、それ以外（無い・null・空）は null。 */
export function readBodyError(data: unknown): { code: string | null; message: string | null } | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const e = (data as { error?: unknown }).error
  if (typeof e === 'string') return e.trim() ? { code: null, message: e } : null
  if (e && typeof e === 'object' && !Array.isArray(e)) {
    const o = e as { code?: unknown; message?: unknown }
    return {
      code: typeof o.code === 'string' && o.code ? o.code : null,
      message: typeof o.message === 'string' && o.message ? o.message : null,
    }
  }
  return null
}

/** 主の文に添える理由の長さの上限。 */
const FAILURE_REASON_MAX = 200

/**
 * 失敗の主の文に添える HANAMII の理由。本文の error.message（apiError.message）だけを使う。
 * 秘密の形を伏せ、改行を詰めて1行にし、長ければ切る。無い・空・code と同じなら ''（HTML など文字列の本文は添えない。原文は呼び手が detail に残す）。
 */
export function hanamiiReasonOf(r: Pick<HanamiiResult, 'data' | 'apiError'>): string {
  const e = r.apiError ?? readBodyError(r.data)
  if (!e?.message) return ''
  const one = maskSecretShapes(e.message).replace(/\s+/g, ' ').trim()
  if (!one || one === e.code) return ''
  return one.length > FAILURE_REASON_MAX ? `${one.slice(0, FAILURE_REASON_MAX)}…` : one
}

/**
 * 失敗した応答の「どう失敗したか」の短い印。2xx なのに本文の error で失敗した回は「HTTP 200」と書かず code（無ければ「HANAMII の応答」）、
 * それ以外は「HTTP n」、状態が無い（通信エラー）は '通信エラー'。待ち・見守りの詳細の文が使う。
 */
export function hanamiiStatusTag(r: Pick<HanamiiResult, 'status' | 'apiError'>): string {
  if (!r.status) return '通信エラー'
  if (r.status >= 200 && r.status < 300 && r.apiError) return r.apiError.code ?? 'HANAMII の応答'
  return `HTTP ${r.status}`
}

/**
 * 失敗の主の文を作る: 「<何>に失敗しました（HTTP n）: <HANAMII の理由>」。
 * 2xx なのに本文の error で失敗した回は「HTTP 200」と書かず、code を添える（例: 再起動に失敗しました（health_check_failed））。
 * 理由は本文の error.message だけ（`hanamiiReasonOf`）。JSON 全文・HTML などの文字列は主の文に載せない（呼び手が元の本文を詳細として残す）。
 */
export function hanamiiFailureMessage(what: string, r: Pick<HanamiiResult, 'status' | 'data' | 'apiError'>): string {
  const bodyFailure = r.status >= 200 && r.status < 300
  const tag = bodyFailure ? (r.apiError?.code ?? 'HANAMII の応答') : `HTTP ${r.status}`
  const reason = hanamiiReasonOf(r)
  return `${what}に失敗しました（${tag}）${reason ? `: ${reason}` : ''}`
}

/** 再起動の応答の読み方。成功は noop、または新しい版が READY と応答が言うときだけ。文書が言わない形は成功と言わない。 */
export function readRestartReply(data: unknown): 'noop' | 'ready' | 'unconfirmed' {
  const d = data as { noop?: unknown; deployment?: { readyState?: unknown } | null } | null | undefined
  if (d && typeof d === 'object') {
    if (d.noop === true) return 'noop'
    if (d.deployment && typeof d.deployment === 'object' && d.deployment.readyState === 'READY') return 'ready'
  }
  return 'unconfirmed'
}

/** HANAMII PaaS デプロイAPI クライアント。 */
export class HanamiiClient {
  private readonly token: string

  constructor(opts: { token: string }) {
    this.token = opts.token
  }

  private async request(method: string, pathname: string, body?: unknown, timeoutMs: number = HANAMII_REQUEST_TIMEOUT_MS): Promise<HanamiiResult> {
    const res = await fetch(HANAMII_API_BASE + pathname, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    })
    let data: unknown = null
    const text = await res.text()
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }
    // ストリームが始まったあとの失敗は HTTP 200 のまま本文に {"error":{"code","message"}} で返る（公式文書・公式 CLI も同じ読み方）。
    // だから ok は HTTP の状態だけでは決めず、本文に error があれば失敗にする。状態コードはそのまま返す。
    const apiError = readBodyError(data)
    return { ok: res.ok && !apiError, status: res.status, data, ...(apiError ? { apiError } : {}) }
  }

  /** ワークスペース一覧を取得（GET）。 */
  async listWorkspaces(): Promise<HanamiiResult> {
    return this.request('GET', HANAMII_WORKSPACES_PATH)
  }

  /** アップロード枠を作成（POST）。uploadUrl を受け取る。 */
  async createUpload(workspaceId: string, fileName: string): Promise<HanamiiResult> {
    return this.request('POST', HANAMII_UPLOADS_PATH, {
      workspaceId,
      fileName,
      contentType: 'application/zip',
    })
  }

  /** ストレージへZIPを直PUT（外部URL・認証ヘッダ無し）。成否のみ返す。 */
  async uploadZip(uploadUrl: string, zip: Uint8Array): Promise<{ ok: boolean; status: number }> {
    // 注: tsconfig.main.json は lib に DOM を含まないため、fetch の BodyInit 型は
    // @types/node（undici）由来となる。Uint8Array をそのまま渡すと型不一致になる環境があるため
    // Buffer に変換して渡す（実行時のバイト列は同一）。
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/zip' },
      body: Buffer.from(zip),
      signal: AbortSignal.timeout(120000),
    })
    return { ok: res.ok, status: res.status }
  }

  /** アップロードの検証（POST）。checkId・canDeploy を得る。 */
  async checkUpload(uploadId: string): Promise<HanamiiResult> {
    return this.request('POST', hanamiiUploadCheckPath(uploadId), {}, HANAMII_LONG_REQUEST_TIMEOUT_MS)
  }

  /** プロジェクト作成＝初回公開（POST）。 */
  async createProject(body: CreateProjectBody): Promise<HanamiiResult> {
    return this.request('POST', HANAMII_PROJECTS_PATH, body, HANAMII_LONG_REQUEST_TIMEOUT_MS)
  }

  /** プロジェクト詳細（GET）。url / latestDeployment.readyState を含む。 */
  async getProject(id: string): Promise<HanamiiResult> {
    return this.request('GET', hanamiiProjectPath(id))
  }

  /** 再デプロイ（POST）。新しい checkId を渡す。
   *  注: envs は含めない（正規経路ではない）。環境変数の更新は先に patchEnv で行うこと。 */
  async redeploy(id: string, checkId: string): Promise<HanamiiResult> {
    return this.request('POST', hanamiiProjectDeployPath(id), { source: { type: 'zip', checkId } }, HANAMII_LONG_REQUEST_TIMEOUT_MS)
  }

  /** プロジェクト削除（DELETE）。 */
  async deleteProject(id: string): Promise<HanamiiResult> {
    return this.request('DELETE', hanamiiProjectPath(id))
  }

  /** 環境変数一覧を取得（GET）。decrypt=true で値も返る。 */
  async getEnv(id: string, decrypt?: boolean): Promise<HanamiiResult> {
    const q = decrypt ? '?decrypt=true' : ''
    return this.request('GET', hanamiiProjectEnvPath(id) + q)
  }

  /** 環境変数をkey単位でupsert（PATCH）。送っていないキーは消えない。 */
  async patchEnv(id: string, envs: HanamiiEnv[]): Promise<HanamiiResult> {
    return this.request('PATCH', hanamiiProjectEnvPath(id), buildPatchEnvBody(envs))
  }

  /** ヘルスチェック設定を取得（GET）。 */
  async getHealthCheck(id: string): Promise<HanamiiResult> {
    return this.request('GET', hanamiiProjectHealthCheckPath(id))
  }

  /** ヘルスチェック設定を保存（PUT）。enabled=false で削除。 */
  async putHealthCheck(id: string, hc: HanamiiHealthCheck): Promise<HanamiiResult> {
    return this.request('PUT', hanamiiProjectHealthCheckPath(id), normalizeHealthCheck(hc))
  }

  /** 保存済みの env / health-check を稼働中アプリへ反映（POST）。no-op 時は {noop:true} が返る。 */
  async restart(id: string): Promise<HanamiiResult> {
    return this.request('POST', hanamiiProjectRestartPath(id), {}, HANAMII_LONG_REQUEST_TIMEOUT_MS)
  }

  /** デプロイログを取得（GET・JSON形式）。limit 既定100・最大500、since は `-15m`/`-2h`/`-1d` または ISO8601。 */
  async getLogs(id: string, opts?: { limit?: number; since?: string }): Promise<HanamiiResult> {
    const q = new URLSearchParams()
    if (opts?.limit != null) q.set('limit', String(opts.limit))
    if (opts?.since) q.set('since', opts.since)
    const qs = q.toString()
    return this.request('GET', hanamiiProjectLogsPath(id) + (qs ? `?${qs}` : ''))
  }

  /** 疎通テスト: ワークスペース一覧の取得可否で判定。 */
  async testConnection(): Promise<{ ok: boolean; status?: number; message?: string }> {
    try {
      const r = await this.listWorkspaces()
      if (r.ok) return { ok: true, status: r.status }
      if (r.status === 401 || r.status === 403) {
        return { ok: false, status: r.status, message: '認証に失敗しました（HANAMII のトークンを確認してください）' }
      }
      return { ok: false, status: r.status, message: hanamiiFailureMessage('接続', r) }
    } catch (e: any) {
      // 回線断・時間切れ・安全な接続は共通の層（shared/failureText.ts）の読み取りの文。見分けられない失敗は原文のまま。
      return { ok: false, message: failureText(e, { readOnly: true }) }
    }
  }
}

/** createProject / redeploy 応答から projectId と deploymentId を取り出す（無ければ null）。 */
export function extractProjectIds(data: unknown): { projectId: string | null; deploymentId: string | null } {
  const d = data as any
  return {
    projectId: typeof d?.project?.id === 'string' ? d.project.id : null,
    deploymentId: typeof d?.deployment?.id === 'string' ? d.deployment.id : null,
  }
}

/** 実行中アプリの健康状態（runtimeStatus）。値の網羅はしない（healthy か否かのみ画面側で判定）。 */
export type HanamiiRuntimeStatus = { status: string | null; detail: string | null; syncedAt: string | null }

/**
 * getProject 応答の `project.latestDeployment.id`（無ければ null）。
 *
 * HANAMII 公式 API リファレンス（https://hanamii.jp/docs/api・2026-09-29 に原本を取得して確認）:
 * `latestDeployment` は `{ id, readyState, errorCode }`。**「現在稼働中の deployment ではなく、直近の
 * deployment 試行」を表す**——再デプロイ直後は前回の版が latest のことがあり、失敗しても稼働中の版は
 * 前回のまま。だから「新しい版が READY か」は readyState だけでなく **id が自分の deployment か**まで
 * 見ないと確かめられない（前回の版の READY を「新しい版が動いた」と読むと、古い保存場所の鍵を早く消す）。
 * 既存の `extractProjectStatus` は返す形をテストが固定しているので、別の関数にしてある。
 */
export function extractLatestDeploymentId(data: unknown): string | null {
  const id = (data as any)?.project?.latestDeployment?.id
  return typeof id === 'string' && id ? id : null
}

/** getProject 応答から 公開URL と readyState、実行中アプリの健康状態（runtime）を取り出す。 */
export function extractProjectStatus(data: unknown): { url: string | null; readyState: string | null; errorCode: string | null; runtime: HanamiiRuntimeStatus } {
  const p = (data as any)?.project
  const url = typeof p?.url === 'string' ? p.url : typeof p?.urls?.[0]?.url === 'string' ? p.urls[0].url : null
  const rs = p?.runtimeStatus
  return {
    url,
    readyState: typeof p?.latestDeployment?.readyState === 'string' ? p.latestDeployment.readyState : null,
    errorCode: typeof p?.latestDeployment?.errorCode === 'string' ? p.latestDeployment.errorCode : null,
    runtime: {
      status: typeof rs?.status === 'string' ? rs.status : null,
      detail: typeof rs?.detail === 'string' ? rs.detail : null,
      syncedAt: typeof rs?.syncedAt === 'string' ? rs.syncedAt : null,
    },
  }
}

/** getLogs 応答からログ配列を取り出す（防御的。logs が無い/配列でなければ空配列）。 */
export function extractLogs(data: unknown): HanamiiLogEntry[] {
  const raw = (data as any)?.logs
  if (!Array.isArray(raw)) return []
  return raw
    .filter((l: any) => l && typeof l === 'object')
    .map((l: any) => ({
      timestamp: typeof l.timestamp === 'string' ? l.timestamp : '',
      message: typeof l.message === 'string' ? l.message : '',
    }))
}

/** HANAMII APIのエラー応答から人間可読なメッセージを取り出す（診断用・所見11）。
 *  src/main/cloud/client.ts の apiErrorMessage と同じ発想: 既知のキー（message/error/detail/
 *  errors[0]）を優先して取り出し、無ければ最後の手段としてJSON全文を返す（呼び出し側の ipc/hanamii.ts が
 *  この戻り値を主表示に、生JSON全文は別途 detail フィールドへ渡して折りたたみ表示する）。 */
export function hanamiiErrorMessage(data: unknown): string {
  const d = data as any
  if (d == null) return ''
  if (typeof d === 'string') return d.slice(0, 300)

  const errArr = Array.isArray(d.errors) ? d.errors : null
  const first = errArr?.[0]
  const firstMsg = typeof first === 'string' ? first : (first?.message ?? first?.type)

  // 公式文書の形 {"error":{"code","message"}}: message が理由。message が無ければ code を見せる。
  const errObj = d.error && typeof d.error === 'object' && !Array.isArray(d.error) ? d.error : null
  const errMsg = errObj ? (typeof errObj.message === 'string' && errObj.message.trim() ? errObj.message : undefined) : undefined
  const errStr = typeof d.error === 'string' ? d.error : undefined
  const errCode = errObj && typeof errObj.code === 'string' ? errObj.code : undefined

  const msg = errMsg ?? d.message ?? errStr ?? d.detail ?? firstMsg ?? errCode
  if (typeof msg === 'string' && msg.trim()) return msg.slice(0, 400)
  return JSON.stringify(d).slice(0, 400)
}
