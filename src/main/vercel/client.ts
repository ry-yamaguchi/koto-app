// client.ts — Vercel Deployments API への HTTPクライアント。
//
// src/main/hanamii/client.ts と同じ構成を踏襲する: Electron メインプロセス（Node）専用で、
// グローバルの fetch / AbortSignal.timeout を用いる純粋ロジックのみ（electron や renderer 側の
// コードは一切 import しない＝esbuild で単体テスト可能な状態を保つ）。
//
// 認証: 全APIコールで `Authorization: Bearer <token>`。チーム所属トークンは全リクエストに
// `teamId` クエリを付ける（個人アカウントのトークンは不要・省略）。
//
// 流れ: (1) 各ファイルを sha1 と共に POST /v2/files でアップロード（冪等・既アップロード済みでも200）
//       (2) POST /v13/deployments でアップロード済みファイルを参照してデプロイを作成
//       (3) GET /v13/deployments/<id> で readyState をポーリング（QUEUED→INITIALIZING→BUILDING→READY/ERROR）

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

/** Vercel API のベースURL。 */
export const VERCEL_API_BASE = 'https://api.vercel.com'

// ── APIエンドポイント定数 ───────────────────────────────────────
export const VERCEL_FILES_PATH = '/v2/files'
export const VERCEL_DEPLOYMENTS_PATH = '/v13/deployments'
export function vercelDeploymentPath(id: string): string {
  return `/v13/deployments/${encodeURIComponent(id)}`
}
export const VERCEL_USER_PATH = '/v2/user'

// ── ファイル収集の除外ルール ─────────────────────────────────────
// HANAMII の zipProjectToBuffer（src/main/ipc/hanamii.ts）の除外リストと揃える。
// dist/build 等のビルド成果物は除外しない（Vercel が自身でビルドするため。
// 静的サイトを事前ビルドしてコミットしている構成でも取りこぼさないようにする）。
import { excludedDirNames, excludedFileNames, isSecretFile } from '../../shared/publishExclude'

const EXCLUDE_DIRS = excludedDirNames()
// .sakuraide.json は Koto 自身のメタ情報（公開設定等）で公開物ではないため、HANAMII と同様に除外する。
const EXCLUDE_FILES = excludedFileNames()

// 秘密ファイルの判定は publishExclude.ts の isSecretFile に一本化した（2026-08-09）。
// 以前はここと github/enumerate.ts が**それぞれ独自に** `.env` を判定しており、
// レンタルサーバ・HANAMII・AppRun の3経路では判定そのものが無かった。

/** バイト列の SHA1（16進40文字）を返す。 */
export function sha1Hex(buf: Buffer): string {
  return crypto.createHash('sha1').update(buf).digest('hex')
}

export interface DeployFile {
  /** POSIX形式の相対パス（Vercel API の `files[].file` に使う）。 */
  relPath: string
  /** ローカルの絶対パス（アップロード時に読み直すため）。 */
  absPath: string
  size: number
  sha: string
}

/**
 * projectDir 配下のファイルを再帰収集する（同期・IO有り）。
 * 除外: node_modules, .git, .env(および .env.*), .sakuraide, .sakuraide-backup, .sakura-cloud,
 *       .DS_Store, .sakuraide.json。dist/build 等は除外しない（Vercelがビルドするため）。
 * 各ファイルは内容を読み SHA1 とサイズを算出する（アップロード時のダイジェスト計算に必要）。
 */
export function collectDeployFiles(projectDir: string): DeployFile[] {
  const out: DeployFile[] = []
  function walk(dir: string, relDir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) {
        if (EXCLUDE_DIRS.has(e.name)) continue
        walk(path.join(dir, e.name), relDir ? `${relDir}/${e.name}` : e.name)
        continue
      }
      if (!e.isFile()) continue
      if (EXCLUDE_FILES.has(e.name)) continue
      if (isSecretFile(e.name)) continue
      const abs = path.join(dir, e.name)
      const rel = relDir ? `${relDir}/${e.name}` : e.name
      const buf = fs.readFileSync(abs)
      out.push({ relPath: rel, absPath: abs, size: buf.length, sha: sha1Hex(buf) })
    }
  }
  walk(projectDir, '')
  return out
}

/** POST /v13/deployments に送る files[] の1件（アップロード済みファイルの参照）。 */
export type DeploymentFileRef = { file: string; sha: string; size: number }

/** デプロイ作成リクエストボディ。 */
export type CreateDeploymentBody = {
  name: string
  files: DeploymentFileRef[]
  projectSettings: { framework: null }
  target: string
}

/**
 * buildDeploymentBody — POST /v13/deployments に送るボディを組み立てる純粋関数。
 * files は collectDeployFiles の結果（や同型のオブジェクト）を受け取り、
 * API が要求する { file, sha, size } の形へ変換する。framework は常に null（自動判定に任せる）。
 */
export function buildDeploymentBody(
  name: string,
  files: Array<{ relPath: string; sha: string; size: number }>,
  opts?: { target?: string },
): CreateDeploymentBody {
  return {
    name,
    files: files.map(f => ({ file: f.relPath, sha: f.sha, size: f.size })),
    projectSettings: { framework: null },
    target: opts?.target ?? 'production',
  }
}

/** デプロイ作成/取得応答から抽出した情報。 */
export type VercelDeploymentInfo = {
  id: string | null
  url: string | null
  readyState: string | null
  error: string | null
}

/** createDeployment / getDeployment 応答から id・url・readyState・エラーメッセージを取り出す（防御的）。 */
export function extractDeployment(data: unknown): VercelDeploymentInfo {
  const d = data as any
  const err = d?.error
  return {
    id: typeof d?.id === 'string' ? d.id : null,
    // Vercel の url はプロトコルなしのホスト名（例: my-app-abc.vercel.app）で返る。
    // UIの <a href> やブラウザ起動でそのまま使えるよう https:// を補う。
    url: typeof d?.url === 'string' && d.url ? `https://${d.url.replace(/^https?:\/\//, '')}` : null,
    readyState: typeof d?.readyState === 'string' ? d.readyState : (typeof d?.status === 'string' ? d.status : null),
    error: typeof err?.message === 'string' ? err.message : (typeof err === 'string' ? err : null),
  }
}

/**
 * vercelErrorMessage — Vercel APIのエラー応答（{ error: { code, message } }）から
 * 人間可読な日本語メッセージを取り出す。
 * - status 401/403 はトークン確認を案内する。
 * - さらに code/message に "team" を含む場合は、チームIDの指定漏れ・誤りの可能性を案内する。
 * - それ以外は message をそのまま（無ければJSON全文にフォールバック）。
 */
export function vercelErrorMessage(data: unknown, status?: number): string {
  const d = data as any
  const err = d && typeof d === 'object' && !Array.isArray(d) ? d.error : undefined
  const code = typeof err?.code === 'string' ? err.code : ''
  const message = typeof err?.message === 'string' ? err.message : ''
  const mentionsTeam = /team/i.test(code) || /team/i.test(message)

  if (status === 401 || status === 403) {
    if (mentionsTeam) {
      return `チームIDの指定が必要、または誤っている可能性があります。認証情報の「チームID」を確認してください${message ? `（${message}）` : ''}`
    }
    return `認証に失敗しました。Vercel のトークンを確認してください${message ? `（${message}）` : ''}`
  }
  if (message) return message.slice(0, 400)
  if (typeof d === 'string') return d.slice(0, 300)
  if (d == null) return ''
  return JSON.stringify(d).slice(0, 400)
}

/**
 * sanitizeProjectName — Vercel の name 制約（英小文字・数字・ハイフンのみ・最大100字程度）に正規化する。
 * main/cloud/spec.ts の normalizeSpecName と同じ発想（大文字→小文字・不正文字→ハイフン・
 * 連続/先頭末尾ハイフン整理）。空になった場合は 'app' にフォールバックする。
 */
export function sanitizeProjectName(raw: string): string {
  let s = (raw ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  if (s.length > 100) s = s.slice(0, 100).replace(/-+$/g, '')
  return s || 'app'
}

/** API呼び出しの汎用結果（成否・ステータス・生データ）。 */
export type VercelResult = { ok: boolean; status: number; data: unknown }

/** Vercel Deployments API クライアント。 */
export class VercelClient {
  private readonly token: string
  private readonly teamId?: string

  constructor(opts: { token: string; teamId?: string }) {
    this.token = opts.token
    this.teamId = opts.teamId?.trim() || undefined
  }

  /** チームIDのクエリ文字列（無ければ空文字）。prefix は先頭に使う記号（'?' または '&'）。 */
  private teamQuery(prefix: '?' | '&' = '?'): string {
    return this.teamId ? `${prefix}teamId=${encodeURIComponent(this.teamId)}` : ''
  }

  private async send(method: string, url: string, opts?: { headers?: Record<string, string>; body?: any; timeoutMs?: number }): Promise<VercelResult> {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
        ...(opts?.headers ?? {}),
      },
      ...(opts?.body !== undefined ? { body: opts.body } : {}),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 30000),
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

  /** ファイルを直接アップロードする（POST /v2/files）。成功で200・空ボディ（冪等）。 */
  async uploadFile(buf: Buffer): Promise<VercelResult> {
    const sha = sha1Hex(buf)
    return this.send('POST', VERCEL_API_BASE + VERCEL_FILES_PATH + this.teamQuery(), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-vercel-digest': sha,
        'Content-Length': String(buf.length),
      },
      body: buf,
      timeoutMs: 120000,
    })
  }

  /** デプロイを作成する（POST /v13/deployments）。 */
  async createDeployment(body: CreateDeploymentBody): Promise<VercelResult> {
    return this.send('POST', VERCEL_API_BASE + VERCEL_DEPLOYMENTS_PATH + '?skipAutoDetectionConfirmation=1' + this.teamQuery('&'), {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: 30000,
    })
  }

  /** デプロイの状態を取得する（GET /v13/deployments/<id>）。 */
  async getDeployment(id: string): Promise<VercelResult> {
    return this.send('GET', VERCEL_API_BASE + vercelDeploymentPath(id) + this.teamQuery(), { timeoutMs: 20000 })
  }

  /** 疎通テスト（GET /v2/user）。200ならトークン有効。 */
  async testConnection(): Promise<{ ok: boolean; status?: number; message?: string; username?: string }> {
    try {
      const r = await this.send('GET', VERCEL_API_BASE + VERCEL_USER_PATH + this.teamQuery(), { timeoutMs: 15000 })
      if (r.ok) {
        const u = (r.data as any)?.user
        const username = typeof u?.username === 'string' ? u.username : (typeof u?.email === 'string' ? u.email : undefined)
        return { ok: true, status: r.status, username }
      }
      return { ok: false, status: r.status, message: vercelErrorMessage(r.data, r.status) }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  }
}
