// client.ts — HANAMII PaaS デプロイAPI への HTTPクライアント（段階1: 基盤）。
//
// src/main/cloud/client.ts（さくらのクラウド/AppRun 用クライアント）と同じ構成を踏襲する。
// Electron メインプロセス（Node）専用: グローバルの fetch / AbortSignal.timeout を用いる純粋ロジックのみで、
// electron や renderer 側のコードは一切 import しない（esbuild で単体テスト可能な状態を保つ）。
//
// 認証: 全APIコールで `Authorization: Bearer <token>`（トークンは `hnm_` で始まる）。
// アップロードは 2 段階: (1) createUpload でアップロード枠（uploadUrl）を取得し、
// (2) uploadZip で外部ストレージへ直接 PUT する（このPUTには Authorization を付けない）。

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
export type HanamiiResult = { ok: boolean; status: number; data: unknown }

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

/** HANAMII PaaS デプロイAPI クライアント。 */
export class HanamiiClient {
  private readonly token: string

  constructor(opts: { token: string }) {
    this.token = opts.token
  }

  private async request(method: string, pathname: string, body?: unknown): Promise<HanamiiResult> {
    const res = await fetch(HANAMII_API_BASE + pathname, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    })
    let data: unknown = null
    const text = await res.text()
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }
    return { ok: res.ok, status: res.status, data }
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
    return this.request('POST', hanamiiUploadCheckPath(uploadId), {})
  }

  /** プロジェクト作成＝初回公開（POST）。 */
  async createProject(body: CreateProjectBody): Promise<HanamiiResult> {
    return this.request('POST', HANAMII_PROJECTS_PATH, body)
  }

  /** プロジェクト詳細（GET）。url / latestDeployment.readyState を含む。 */
  async getProject(id: string): Promise<HanamiiResult> {
    return this.request('GET', hanamiiProjectPath(id))
  }

  /** 再デプロイ（POST）。新しい checkId を渡す。
   *  注: envs は含めない（正規経路ではない）。環境変数の更新は先に patchEnv で行うこと。 */
  async redeploy(id: string, checkId: string): Promise<HanamiiResult> {
    return this.request('POST', hanamiiProjectDeployPath(id), { source: { type: 'zip', checkId } })
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
    return this.request('POST', hanamiiProjectRestartPath(id), {})
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
      return { ok: false, status: r.status, message: `接続に失敗しました（HTTP ${r.status}）` }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
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

  const msg = d.message ?? d.error ?? d.detail ?? firstMsg
  if (typeof msg === 'string' && msg.trim()) return msg.slice(0, 400)
  return JSON.stringify(d).slice(0, 400)
}

/** errorCode を非エンジニア向けの日本語説明に変換する（確実な既知コードのみ・未知はコードをそのまま見せる）。 */
export function describeErrorCode(code: string | null | undefined): string {
  if (!code) return ''
  const table: Record<string, string> = {
    BUILD_FAILED: 'ビルドに失敗しました。直前に追加したライブラリ名の誤りや、package.json の記述ミスが典型的な原因です。',
  }
  return table[code] ?? `エラーコード: ${code}`
}
