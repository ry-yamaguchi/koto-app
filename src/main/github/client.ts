// client.ts — GitHub REST API（Git Data API）への HTTPクライアント。P3-⑬ GitHub保存 G1。
//
// src/main/hanamii/client.ts と同じ構成を踏襲する。
// Electron メインプロセス（Node）専用: グローバルの fetch / AbortSignal.timeout を用いる純粋ロジックのみで、
// electron や renderer 側のコードは一切 import しない（esbuild/vitest で単体テスト可能な状態を保つ）。
//
// 認証: 全APIコールで `Authorization: Bearer <PAT>`。
// git 語彙はここでは普通に使う（GitHub API 自体の語彙）が、renderer 側 UI には出さない（掟）。
//
// 保存（＝1コミット）の流れ（dev-plan P3-⑬ 記載の5段階）:
//   ① GET  /repos/{o}/{r}/git/ref/heads/main        … 親コミットのsha取得
//   ② POST /repos/{o}/{r}/git/blobs                 … 各ファイルをblob化（content base64）
//   ③ POST /repos/{o}/{r}/git/trees                 … tree作成（{tree:[{path,mode:'100644',sha}]}）
//   ④ POST /repos/{o}/{r}/git/commits               … commit作成（{message, tree, parents:[親]}）
//   ⑤ PATCH /repos/{o}/{r}/git/refs/heads/main       … refをcommitへ更新

/** GitHub API のベースURL。 */
export const GITHUB_API_BASE = 'https://api.github.com'

/** API バージョンヘッダ（GitHub の日付スキームの安定版。2026-07時点でも 2022-11-28 が最新の安定版として有効）。 */
export const GITHUB_API_VERSION = '2022-11-28'

/** User-Agent（GitHub API はUA必須）。 */
export const GITHUB_USER_AGENT = 'Sakura-IDE'

// ── APIエンドポイント定数 ───────────────────────────────────────
export const GITHUB_USER_PATH = '/user'
export const GITHUB_CREATE_REPO_PATH = '/user/repos'
export function githubRefPath(owner: string, repo: string, ref: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/${ref}`
}
export function githubUpdateRefPath(owner: string, repo: string, ref: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/${ref}`
}
export function githubBlobsPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs`
}
export function githubTreesPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees`
}
export function githubCommitsPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`
}

// ── 型 ─────────────────────────────────────────────────────────
/** API呼び出しの汎用結果（成否・ステータス・生データ）。 */
export type GithubResult = { ok: boolean; status: number; data: unknown }

/** 保存対象の1ファイル（プロジェクトルートからの相対パス＋内容）。
 *  content は base64 エンコード済みのバイト列（テキスト/バイナリ問わず安全に扱うため）。 */
export type GithubFileEntry = { path: string; content: string }

/** owner/repo 文字列を分解する（不正な形なら null）。 */
export function splitRepoFullName(repoFullName: string): { owner: string; repo: string } | null {
  const s = (repoFullName ?? '').trim()
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(s)
  if (!m) return null
  return { owner: m[1], repo: m[2] }
}

/** GitHub API クライアント。 */
export class GithubClient {
  private readonly token: string

  constructor(opts: { token: string }) {
    this.token = opts.token
  }

  private async request(method: string, pathname: string, body?: unknown): Promise<GithubResult> {
    const res = await fetch(GITHUB_API_BASE + pathname, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': GITHUB_USER_AGENT,
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

  /** 疎通/ユーザー名の取得（GET /user）。 */
  async getUser(): Promise<GithubResult> {
    return this.request('GET', GITHUB_USER_PATH)
  }

  /** リポジトリ作成（POST /user/repos）。private固定・auto_init:true（空リポジトリへの Git Data API 409 回避）。 */
  async createRepo(name: string): Promise<GithubResult> {
    return this.request('POST', GITHUB_CREATE_REPO_PATH, { name, private: true, auto_init: true })
  }

  /** ブランチ参照の取得（GET /repos/{o}/{r}/git/ref/heads/{branch}）。親コミットのsha取得用。 */
  async getRef(owner: string, repo: string, branch = 'main'): Promise<GithubResult> {
    return this.request('GET', githubRefPath(owner, repo, `heads/${branch}`))
  }

  /** blob作成（POST /repos/{o}/{r}/git/blobs）。content は base64。 */
  async createBlob(owner: string, repo: string, content: string, encoding: 'utf-8' | 'base64' = 'base64'): Promise<GithubResult> {
    return this.request('POST', githubBlobsPath(owner, repo), { content, encoding })
  }

  /** tree作成（POST /repos/{o}/{r}/git/trees）。base_tree を指定すると差分マージされる。 */
  async createTree(owner: string, repo: string, tree: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string }>, baseTree?: string): Promise<GithubResult> {
    return this.request('POST', githubTreesPath(owner, repo), { tree, ...(baseTree ? { base_tree: baseTree } : {}) })
  }

  /** commit作成（POST /repos/{o}/{r}/git/commits）。 */
  async createCommit(owner: string, repo: string, message: string, tree: string, parents: string[]): Promise<GithubResult> {
    return this.request('POST', githubCommitsPath(owner, repo), { message, tree, parents })
  }

  /** ref更新（PATCH /repos/{o}/{r}/git/refs/heads/{branch}）。 */
  async updateRef(owner: string, repo: string, sha: string, branch = 'main'): Promise<GithubResult> {
    return this.request('PATCH', githubUpdateRefPath(owner, repo, `heads/${branch}`), { sha })
  }

  /** 疎通テスト: GET /user の成否で判定。login を返す。 */
  async testConnection(): Promise<{ ok: boolean; login?: string; status?: number; message?: string }> {
    try {
      const r = await this.getUser()
      if (r.ok) {
        const login = typeof (r.data as any)?.login === 'string' ? (r.data as any).login : undefined
        return { ok: true, login, status: r.status }
      }
      if (r.status === 401 || r.status === 403) {
        return { ok: false, status: r.status, message: '認証に失敗しました（GitHub のトークンを確認してください）' }
      }
      return { ok: false, status: r.status, message: `接続に失敗しました（HTTP ${r.status}）` }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  }

  /**
   * 保存（＝1コミット）の Git Data フロー一式を実行する。
   * ① ref取得 → ② blobs作成 → ③ tree作成 → ④ commit作成 → ⑤ ref更新。
   * 途中で失敗した場合は日本語メッセージ付きで { ok:false } を返す（GitHub側に中途半端な状態が残っても
   * ref は更新されないため、mainブランチの履歴には影響しない＝再実行で回復可能）。
   */
  async save(owner: string, repo: string, files: GithubFileEntry[], message: string, branch = 'main'): Promise<{ ok: boolean; commitSha?: string; message?: string }> {
    try {
      // ① 親コミットのsha取得
      const refRes = await this.getRef(owner, repo, branch)
      if (!refRes.ok) {
        if (refRes.status === 404) {
          return { ok: false, message: `保存先のブランチ（${branch}）が見つかりませんでした。リポジトリが空か、初期化されていない可能性があります。` }
        }
        return { ok: false, message: `保存先の情報取得に失敗しました（HTTP ${refRes.status}）` }
      }
      const parentSha = (refRes.data as any)?.object?.sha
      if (typeof parentSha !== 'string' || !parentSha) {
        return { ok: false, message: '保存先の情報取得に失敗しました（親情報が取得できません）' }
      }

      // ② 各ファイルをblob化（content は既に base64 エンコード済み）
      const treeEntries: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string }> = []
      for (const f of files) {
        const blobRes = await this.createBlob(owner, repo, f.content, 'base64')
        if (!blobRes.ok) {
          return { ok: false, message: `ファイルの保存に失敗しました（${f.path}・HTTP ${blobRes.status}）` }
        }
        const sha = (blobRes.data as any)?.sha
        if (typeof sha !== 'string' || !sha) {
          return { ok: false, message: `ファイルの保存に失敗しました（${f.path}・応答が不正です）` }
        }
        treeEntries.push({ path: f.path, mode: '100644', type: 'blob', sha })
      }

      // ③ tree作成（base_treeに親コミットのtreeを指定して差分マージ）
      const treeRes = await this.createTree(owner, repo, treeEntries, await this.resolveParentTreeSha(owner, repo, parentSha))
      if (!treeRes.ok) {
        return { ok: false, message: `保存内容のまとめ（tree作成）に失敗しました（HTTP ${treeRes.status}）` }
      }
      const treeSha = (treeRes.data as any)?.sha
      if (typeof treeSha !== 'string' || !treeSha) {
        return { ok: false, message: '保存内容のまとめ（tree作成）に失敗しました（応答が不正です）' }
      }

      // ④ commit作成
      const commitRes = await this.createCommit(owner, repo, message || 'Koto から保存', treeSha, [parentSha])
      if (!commitRes.ok) {
        return { ok: false, message: `保存の記録（commit作成）に失敗しました（HTTP ${commitRes.status}）` }
      }
      const commitSha = (commitRes.data as any)?.sha
      if (typeof commitSha !== 'string' || !commitSha) {
        return { ok: false, message: '保存の記録（commit作成）に失敗しました（応答が不正です）' }
      }

      // ⑤ ref更新
      const updateRes = await this.updateRef(owner, repo, commitSha, branch)
      if (!updateRes.ok) {
        return { ok: false, message: `保存の反映に失敗しました（HTTP ${updateRes.status}）` }
      }

      return { ok: true, commitSha }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  }

  /** 親コミットのtree shaを取得する（base_tree用。取得できなければ undefined＝tree全体を作り直す）。 */
  private async resolveParentTreeSha(owner: string, repo: string, commitSha: string): Promise<string | undefined> {
    try {
      const r = await this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${commitSha}`)
      const sha = (r.data as any)?.tree?.sha
      return typeof sha === 'string' && sha ? sha : undefined
    } catch {
      return undefined
    }
  }
}

/** createRepo の422応答から「名前衝突」かどうかを判定する（既知の形のみ確実に・未知は false）。 */
export function isRepoNameConflict(status: number, data: unknown): boolean {
  if (status !== 422) return false
  const errors = (data as any)?.errors
  if (Array.isArray(errors)) {
    return errors.some((e: any) => (typeof e?.message === 'string' && /already exists/i.test(e.message)) || e?.code === 'already_exists')
  }
  const msg = (data as any)?.message
  return typeof msg === 'string' && /already exists/i.test(msg)
}

/** createRepo の応答から日本語のエラーメッセージを組み立てる（422=名前衝突は区別して案内）。 */
export function describeCreateRepoError(status: number, data: unknown): string {
  if (status === 422 && isRepoNameConflict(status, data)) {
    return 'その名前の保管場所は既に存在します。別の名前を試してください。'
  }
  if (status === 401 || status === 403) {
    return '認証に失敗しました（GitHub のトークンと権限を確認してください）。'
  }
  if (status === 422) {
    return `リポジトリを作成できませんでした（入力内容を確認してください・HTTP ${status}）`
  }
  return `リポジトリの作成に失敗しました（HTTP ${status}）`
}

/** GET /user のエラー応答から日本語メッセージを組み立てる。 */
export function describeUserError(status: number): string {
  if (status === 401 || status === 403) return '認証に失敗しました（GitHub のトークンを確認してください）'
  return `接続に失敗しました（HTTP ${status}）`
}
