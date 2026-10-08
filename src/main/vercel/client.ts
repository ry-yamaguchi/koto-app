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
// 疎通テストで「公開する範囲が見えているか」を確かめるために読む（読み取りのみ）。
// **プロジェクト一覧を使う**（2026-08-22）。Vercel のトークンには3つの範囲があり、
//   Full Account … 個人＋所属する全チーム
//   Team         … 1つのチーム
//   Project      … 1つのプロジェクト
// で、**Project 範囲のトークンは「ユーザー階層・チーム階層の資源」を拒否する**
// （公式明記）。つまり `/v2/user` や `/v6/deployments` では**正しいトークンでも 403** になる。
// 公式が scoped token の例として挙げているのがこの `/v9/projects`。
export const VERCEL_PROJECTS_PATH = '/v9/projects'
// ── 引き取り（dev-plan ④）で読む経路。すべて**読み取りのみ**。実測 2026-08-23。
export const VERCEL_DEPLOYMENTS_PATH_V6 = '/v6/deployments'
export function vercelDeploymentFilesPath(id: string): string {
  return `/v6/deployments/${encodeURIComponent(id)}/files`
}
export function vercelDeploymentFilePath(id: string, fileId: string): string {
  return `/v8/deployments/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}`
}
// ── 環境変数（2026-09-24 に原本で確認。推測で足さないこと）───────────────
// https://vercel.com/docs/rest-api/reference/endpoints/projects/create-one-or-more-environment-variables
//   POST /v10/projects/{idOrName}/env ／ 必須は key・value・type
//   type は system / encrypted / plain / sensitive ／ target は production / preview / development
//   本文に**配列**を渡せば複数件を1回で作れる ／ 既存があるときは **upsert=true** が要る（無いと 403）
export function vercelProjectEnvPath(idOrName: string): string {
  return `/v10/projects/${encodeURIComponent(idOrName)}/env`
}

// ── ファイル収集の除外ルール ─────────────────────────────────────
// HANAMII の zipProjectToBuffer（src/main/ipc/hanamii.ts）の除外リストと揃える。
// dist/build 等のビルド成果物は除外しない（Vercel が自身でビルドするため。
// 静的サイトを事前ビルドしてコミットしている構成でも取りこぼさないようにする）。
import { publishExcludedDirNames, servedExcludedFileNames, isSecretFile } from '../../shared/publishExclude'

const EXCLUDE_DIRS = publishExcludedDirNames()
// .sakuraide.json は Koto 自身のメタ情報（公開設定等）で公開物ではないため、HANAMII と同様に除外する。
// Vercel は静的にそのまま配信するので、ビルド用の設定ファイルも外す（2026-08-20）。
const EXCLUDE_FILES = servedExcludedFileNames()

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

/**
 * Vercel の環境変数1件（POST /v10/projects/{idOrName}/env の本文）。
 *
 * `type` は原本の4種（system / encrypted / plain / sensitive）のうち2つだけを使う——
 * **秘密は `sensitive`、それ以外は `plain`**（掟4: 秘密はディスクにもログにも残さない）。
 */
export type VercelEnvVar = {
  key: string
  value: string
  type: 'plain' | 'sensitive'
  target: string[]
}

/**
 * 環境変数の本文を組み立てる（純関数）。
 *
 * `target` は **`production` だけ**にする（2026-09-24 の判断）。Koto が作るデプロイは
 * `buildDeploymentBody` が `target: 'production'` 固定で、preview は Koto からは作らない。
 * にもかかわらず preview を足すと、**Koto が関与していない preview デプロイ**
 * （利用者が Vercel 側で Git を繋いだ場合など）にまで、保存場所へ読み書きできる本物の鍵が
 * 配られる。渡す先は少ないほうが安全なので、いま作る production にだけ渡す。
 */
export function buildEnvVarsBody(
  envs: readonly { key: string; value: string; secret: boolean }[],
): VercelEnvVar[] {
  return (envs ?? []).map(e => ({
    key: e.key,
    value: e.value,
    type: e.secret ? 'sensitive' : 'plain',
    target: ['production'],
  }))
}

/**
 * 環境変数を渡せなかったときの、**利用者に分かる日本語**（純関数）。
 *
 * **Vercel の生のエラーを出さない。** 応答の本文には作ろうとした環境変数が載りうるので、
 * そのまま画面やログへ流すと秘密が漏れる（掟4）。ここは HTTP の状態だけを見て文を決める。
 */
export function vercelEnvErrorMessage(status: number, opts: { alreadyPublished?: boolean } = {}): string {
  const head = 'データの保存に使う設定を Vercel へ渡せませんでした'
  // **初回の公開では「中止しました」が嘘になる**（2026-09-24 検分の指摘14）。
  // 初回は Vercel 側にプロジェクトが無く、公開のあとに置き直す。その置き直しが失敗しても
  // 公開そのものは済んでいるので、末尾だけを差し替える（理由と直し方は共通で出す）。
  const tail = opts.alreadyPublished
    ? 'いまの公開ではデータを読み書きできません。上のとおり直してから、もう一度「公開する」を押してください。'
    : 'このまま公開すると、アプリに入力されたデータを読み書きできないため、公開を中止しました。'
  if (status === 401 || status === 403) {
    return `${head}——このトークンでは、公開先の設定を変更できないようです（HTTP ${status}）。`
      + '「認証情報」で、公開先が含まれるトークンか、チームIDが正しいかをご確認ください。\n' + tail
  }
  if (status === 429) {
    return `${head}——Vercel が混み合っています（HTTP ${status}）。少し時間をおいてから、もう一度お試しください。\n${tail}`
  }
  return `${head}（HTTP ${status}）。少し時間をおいてから、もう一度お試しください。`
    + '何度も続くときは、Vercel の管理画面で同じ名前の設定が編集できるかをご確認ください。\n' + tail
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

  /**
   * 環境変数を作る（POST /v10/projects/{idOrName}/env・**6件を1回で**）。
   *
   * **`upsert=true` を必ず付ける**（原本の記載）。付けないと、2回目の公開で
   * 「同じ名前が既にある」として **403** になり、再公開が通らなくなる。
   *
   * 秘密（`secret: true`）は `type: 'sensitive'` で送る。**応答は呼び出し側で
   * detail へ載せないこと**——作った環境変数が載りうる（掟4）。
   */
  async createEnvVars(idOrName: string, envs: readonly { key: string; value: string; secret: boolean }[]): Promise<VercelResult> {
    return this.send('POST', VERCEL_API_BASE + vercelProjectEnvPath(idOrName) + '?upsert=true' + this.teamQuery('&'), {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildEnvVarsBody(envs)),
      timeoutMs: 30000,
    })
  }

  /** デプロイの状態を取得する（GET /v13/deployments/<id>）。 */
  async getDeployment(id: string): Promise<VercelResult> {
    return this.send('GET', VERCEL_API_BASE + vercelDeploymentPath(id) + this.teamQuery(), { timeoutMs: 20000 })
  }

  // ── 引き取り（dev-plan ④）─────────────────────────────────────────────
  // 「公開済みのものから中身を取り戻す」ための読み取り。**何も作らない・何も消さない。**

  /** デプロイの一覧（引き取りの候補）。 */
  async listDeployments(limit = 50): Promise<VercelResult> {
    return this.send('GET', VERCEL_API_BASE + VERCEL_DEPLOYMENTS_PATH_V6 + `?limit=${limit}` + this.teamQuery('&'), { timeoutMs: 20000 })
  }

  /**
   * デプロイの詳細。**Git 由来かどうかを見るために `withGitRepoInfo=true` を付ける**
   * （付けないと `gitSource` が返らない）。
   */
  async getDeploymentDetail(id: string): Promise<VercelResult> {
    return this.send('GET', VERCEL_API_BASE + vercelDeploymentPath(id) + '?withGitRepoInfo=true' + this.teamQuery('&'), { timeoutMs: 20000 })
  }

  /** デプロイのファイルツリー。Git 由来のデプロイでは 404 になりうる。 */
  async getDeploymentFiles(id: string): Promise<VercelResult> {
    return this.send('GET', VERCEL_API_BASE + vercelDeploymentFilesPath(id) + this.teamQuery(), { timeoutMs: 20000 })
  }

  /**
   * ファイル1つの中身。実測では `{ data: <base64> }` が返る。
   * **base64 のまま返す**（画像もあるので、文字列に変換しない）。
   */
  async getDeploymentFile(id: string, fileId: string): Promise<VercelResult> {
    return this.send('GET', VERCEL_API_BASE + vercelDeploymentFilePath(id, fileId) + this.teamQuery(), { timeoutMs: 60000 })
  }

  /**
   * 疎通テスト。
   *
   * ── なぜ2段階なのか（2026-08-22 Ryosuke 指摘）─────────────────────────
   * 以前は `GET /v2/user` が 200 なら「接続OK」としていた。だがこれは
   * **トークンが有効であること**しか確かめていない。Vercel のトークンには
   * 範囲（スコープ）があり、**公開したい先が見えていないトークンでも
   * /v2/user は 200 を返す**。結果、「接続OK」と出したのに公開で落ちる。
   * そこで、**公開する範囲（個人／チーム）のデプロイ一覧が読めるか**まで見る。
   *
   * それでも**書き込みができる保証にはならない**（読めても作れないことはある）。
   * 確かめずに「公開できます」とは言わない——呼び出し側の文言もそう書くこと。
   */
  async testConnection(): Promise<{
    ok: boolean; status?: number; message?: string; username?: string
    /** 見えているプロジェクトの数（範囲の広さの目安）。 */
    projects?: number
    /** チームIDを付けると拒否されるが、外すと通る＝**範囲つきトークン**。 */
    dropTeamId?: boolean
  }> {
    try {
      // ① まず「公開先が見えるか」を見る。**ここが本題**（トークンが有効かだけでは足りない）
      let r = await this.send('GET', VERCEL_API_BASE + VERCEL_PROJECTS_PATH + '?limit=1' + this.teamQuery('&'), { timeoutMs: 15000 })
      let dropTeamId = false

      // 範囲つきトークンは teamId を要らない（公式: 「Team・Project 範囲のトークンは
      // teamId を必要としない」）。付けたまま拒否されたなら、外して確かめる。
      if (!r.ok && this.teamId) {
        const retry = await this.send('GET', VERCEL_API_BASE + VERCEL_PROJECTS_PATH + '?limit=1', { timeoutMs: 15000 })
        if (retry.ok) { r = retry; dropTeamId = true }
      }
      if (!r.ok) return { ok: false, status: r.status, message: vercelErrorMessage(r.data, r.status) }

      const projects = Array.isArray((r.data as any)?.projects) ? (r.data as any).projects.length : undefined

      // ② 誰として見えているかは**分かれば添える**程度に留める。
      // Project 範囲のトークンはユーザー階層を拒否するので、**失敗しても異常ではない**。
      let username: string | undefined
      try {
        const who = await this.send('GET', VERCEL_API_BASE + VERCEL_USER_PATH, { timeoutMs: 10000 })
        const u = (who.data as any)?.user
        if (who.ok) username = typeof u?.username === 'string' ? u.username : (typeof u?.email === 'string' ? u.email : undefined)
      } catch { /* 取れなくてよい */ }

      return { ok: true, status: r.status, username, projects, dropTeamId }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  }
}
