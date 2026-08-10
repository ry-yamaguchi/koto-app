// GitHub保存（バックアップ・共有）連携の IPC（github:*）。P3-⑬ G1。
// git 語彙はここでは普通に使う（GitHub API自体の語彙）。UI（renderer）には出さない（掟）。
// トークンは方式B（renderer が引数で渡す。main には保存しない）。
import { ipcMain } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import {
  GithubClient, splitRepoFullName, describeCreateRepoError, describeUserError,
  type GithubFileEntry,
} from '../github/client'
import { partitionEntries, isSkippedDirName, isSkippedFileName, type EnumerateEntry } from '../github/enumerate'
import type { IpcDeps } from './types'

// プロジェクト内のファイルを列挙する（node_modules 等の除外＋ .env系除外＋ 5MB超過除外は
// partitionEntries が担当。ここではディレクトリ走査のみを行う）。
// envDetect.ts / fs.ts の SKIP_DIRS 系と同じ上限（深さ8・最大2000ファイル）を踏襲する。
function walkProjectFiles(projectDir: string): EnumerateEntry[] {
  const MAX_FILES = 2000
  const entries: EnumerateEntry[] = []
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 8 || entries.length >= MAX_FILES) return
    let dirents: fs.Dirent[]
    try { dirents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of dirents) {
      if (entries.length >= MAX_FILES) return
      const full = path.join(dir, ent.name)
      const relPath = rel + ent.name
      if (ent.isDirectory()) {
        if (isSkippedDirName(ent.name)) continue
        walk(full, relPath + '/', depth + 1)
      } else if (ent.isFile()) {
        if (isSkippedFileName(ent.name)) continue
        let size = 0
        try { size = fs.statSync(full).size } catch { continue }
        entries.push({ rel: relPath, sizeBytes: size })
      }
    }
  }
  walk(projectDir, '', 0)
  return entries
}

// ファイルをバイト列のまま base64 化して読む（テキスト/バイナリ問わず安全。GithubFileEntry.content の形）。
function readFileAsBase64(full: string): string {
  return fs.readFileSync(full).toString('base64')
}

export function registerGithubHandlers(_deps: IpcDeps) {
  // 疎通テスト（GET /user）。login を返す。
  ipcMain.handle('github:test', async (_, token: string) => {
    if (!token) return { ok: false, message: 'GitHub のトークンが未登録です' }
    const r = await new GithubClient({ token }).testConnection()
    if (!r.ok) return { ok: false, message: r.message ?? describeUserError(r.status ?? 0) }
    return { ok: true, login: r.login }
  })

  // リポジトリ作成（POST /user/repos）。private固定・auto_init:true。422=名前衝突は区別して案内。
  ipcMain.handle('github:createRepo', async (_, token: string, name: string) => {
    if (!token) return { ok: false, message: 'GitHub のトークンが未登録です' }
    const trimmed = (name ?? '').trim()
    if (!trimmed) return { ok: false, message: '保管場所の名前を入力してください' }
    try {
      const client = new GithubClient({ token })
      const r = await client.createRepo(trimmed)
      if (!r.ok) return { ok: false, message: describeCreateRepoError(r.status, r.data) }
      const fullName = (r.data as any)?.full_name
      if (typeof fullName !== 'string' || !fullName) {
        return { ok: false, message: 'リポジトリは作成されましたが、応答から名前を取得できませんでした' }
      }
      return { ok: true, repoFullName: fullName }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  // 保存（＝1コミット）。ファイル列挙は main 側で実施。.env系除外・5MB超過除外は一覧で返す。
  ipcMain.handle('github:save', async (_, projectDir: string, token: string, repoFullName: string, message?: string) => {
    if (!token) return { ok: false, message: 'GitHub のトークンが未登録です' }
    if (!projectDir) return { ok: false, message: 'プロジェクトが開かれていません' }
    const parsed = splitRepoFullName(repoFullName)
    if (!parsed) return { ok: false, message: '保存先のリポジトリ（保管場所）が正しく設定されていません' }
    try {
      const rawEntries = walkProjectFiles(projectDir)
      const { included, excluded } = partitionEntries(rawEntries)
      if (included.length === 0) {
        return { ok: false, message: '保存できるファイルが見つかりませんでした', excluded }
      }
      const files: GithubFileEntry[] = included.map(rel => ({
        path: rel,
        content: readFileAsBase64(path.join(projectDir, rel)),
      }))
      const client = new GithubClient({ token })
      const r = await client.save(parsed.owner, parsed.repo, files, message || 'Koto から保存')
      if (!r.ok) return { ok: false, message: r.message ?? '保存に失敗しました', excluded }
      return { ok: true, commitSha: r.commitSha, savedCount: included.length, excluded }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  // 状態確認（現状は疎通テストと同義。将来的な拡張余地として独立エンドポイントにしておく）。
  ipcMain.handle('github:status', async (_, token: string, repoFullName: string) => {
    if (!token) return { ok: false, message: 'GitHub のトークンが未登録です' }
    const parsed = splitRepoFullName(repoFullName)
    if (!parsed) return { ok: false, message: '保存先のリポジトリ（保管場所）が正しく設定されていません' }
    const r = await new GithubClient({ token }).testConnection()
    if (!r.ok) return { ok: false, message: r.message ?? describeUserError(r.status ?? 0) }
    return { ok: true, login: r.login }
  })
}
