// Vercel（海外PaaS）連携の IPC（vercel:*）。
// deps は使わない（トークンは方式B＝renderer が引数で渡す。main には保存しない）。
import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import {
  VercelClient,
  collectDeployFiles,
  buildDeploymentBody,
  extractDeployment,
  vercelErrorMessage,
  sanitizeProjectName,
} from '../vercel/client'
import type { IpcDeps } from './types'
import { scanDataUsage } from '../dataLayer'
import { judgeVercelFit } from '../../shared/vercelFit'
import { summarizePreflight, sortChecks } from '../../shared/preflight'

// デプロイ状態のポーリング設定。数秒間隔でREADY/ERRORまで待つ（タイムアウトあり）。
const POLL_INTERVAL_MS = 3000
const POLL_TIMEOUT_MS = 5 * 60 * 1000

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function registerVercelHandlers(_deps: IpcDeps) {
  ipcMain.handle('vercel:testConnection', async (_, token: string, teamId?: string) => {
    if (!token) return { ok: false, message: 'Vercel のトークンが未登録です' }
    const r = await new VercelClient({ token, teamId }).testConnection()
    if (!r.ok) return r
    return { ok: true, status: r.status, message: r.username ? `接続できました（${r.username}）` : '接続できました' }
  })

  /**
   * 公開する前の確認（2026-08-15）。**何も作らず、何も送りません。**
   *
   * Vercel の画面には折りたたみの注意書きしか無く、押すと**デプロイは成功する**。
   * だが常駐サーバは起動しないので、**ソースが丸見えのページ**が公開される。
   * 「成功と表示されながら壊れている」を防ぐ（AppRun の cloud:preflight と同じ考え）。
   */
  ipcMain.handle('vercel:preflight', async (_, projectDir: string) => {
    try {
      if (!projectDir) return { ok: false, message: 'プロジェクトが選ばれていません' }
      let packageJson: unknown = null
      try {
        const p = path.join(projectDir, 'package.json')
        if (fs.existsSync(p)) packageJson = JSON.parse(fs.readFileSync(p, 'utf-8'))
      } catch {
        // 壊れた package.json は「無い」として扱う（静的として通る）。
        // ここで止めるほどの根拠が無く、Vercel 側のビルドで分かる
        packageJson = null
      }
      const scan = scanDataUsage(projectDir)
      let hasFiles = false
      try { hasFiles = collectDeployFiles(projectDir).length > 0 } catch { hasFiles = false }
      const checks = sortChecks(judgeVercelFit({
        packageJson,
        listens: scan.listens,
        usesData: scan.usedBy,
        hasFiles,
      }))
      const result = summarizePreflight(checks)
      return { ok: true, canPublish: result.canPublish, summary: result.summary, checks }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle('vercel:publish', async (event, projectDir: string, opts: { token: string; teamId?: string; name: string }) => {
    // 失敗時の生応答（JSON短縮・診断用）。HANAMII と同じ流儀: message に連結せず detail で返し、
    // renderer 側が折りたたみ（詳細を見る）で表示する。
    const dbg = (x: unknown) => { try { const s = JSON.stringify(x); return s ? s.slice(0, 400) : String(x) } catch { return String(x) } }
    // 進捗を renderer へ通知（cloud:apply-progress と同じ流儀）。アップロード〜ビルドは
    // 数十秒〜数分かかるため、無反応に見えないよう各段階を送る。
    const progress = (m: string) => { try { event.sender.send('vercel:progress', m) } catch { /* ウィンドウ破棄時は無視 */ } }
    try {
      const token = opts?.token
      if (!token) return { ok: false, message: 'Vercel のトークンが未登録です' }
      if (!projectDir || !fs.existsSync(projectDir)) return { ok: false, message: 'プロジェクトフォルダが見つかりません' }

      const teamId = opts?.teamId?.trim() || undefined
      const client = new VercelClient({ token, teamId })
      const name = sanitizeProjectName(opts.name || path.basename(projectDir))

      progress('ファイルを収集しています…')
      const files = collectDeployFiles(projectDir)
      if (files.length === 0) {
        return { ok: false, message: 'アップロードできるファイルが見つかりません（プロジェクトが空の可能性があります）。' }
      }

      // (1) 各ファイルを先にアップロード（冪等・既アップロード済みでも200）。
      for (let i = 0; i < files.length; i++) {
        const f = files[i]
        progress(`アップロード中… (${i + 1}/${files.length})`)
        let buf: Buffer
        try {
          buf = fs.readFileSync(f.absPath)
        } catch (e: any) {
          return { ok: false, message: `ファイル（${f.relPath}）の読み込みに失敗しました: ${e?.message ?? String(e)}` }
        }
        const up = await client.uploadFile(buf)
        if (!up.ok) {
          return {
            ok: false,
            message: `ファイル（${f.relPath}）のアップロードに失敗しました（HTTP ${up.status}）: ${vercelErrorMessage(up.data, up.status)}`,
            detail: dbg(up.data),
          }
        }
      }

      // (2) デプロイを作成。
      progress('デプロイを作成しています…')
      const body = buildDeploymentBody(name, files)
      const dep = await client.createDeployment(body)
      if (!dep.ok) {
        return {
          ok: false,
          message: `デプロイの作成に失敗しました（HTTP ${dep.status}）: ${vercelErrorMessage(dep.data, dep.status)}`,
          detail: dbg(dep.data),
        }
      }
      let info = extractDeployment(dep.data)
      if (!info.id) return { ok: false, message: 'デプロイIDを取得できませんでした。', detail: dbg(dep.data) }
      const deploymentId = info.id

      // (3) READY/ERROR になるまでポーリング（既にどちらかならスキップ）。
      // 状態取得が連続で失敗し続ける場合は、5分待たずに打ち切ってエラーを返す
      // （黙って回り続けて「応答がない」ように見えるのを防ぐ）。
      const deadline = Date.now() + POLL_TIMEOUT_MS
      const startedAt = Date.now()
      let consecutiveFailures = 0
      let lastError: { status: number; data: unknown } | null = null
      while (info.readyState !== 'READY' && info.readyState !== 'ERROR' && Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS)
        progress(`Vercel でビルド中… (${Math.round((Date.now() - startedAt) / 1000)}秒)`)
        const st = await client.getDeployment(deploymentId)
        if (st.ok) {
          info = extractDeployment(st.data)
          consecutiveFailures = 0
        } else {
          consecutiveFailures++
          lastError = { status: st.status, data: st.data }
          if (consecutiveFailures >= 5) {
            return {
              ok: false,
              message: `デプロイ状態の確認に繰り返し失敗しました（HTTP ${st.status}）。Vercel の管理画面でデプロイ状況をご確認ください。`,
              detail: dbg(st.data),
              deploymentId,
            }
          }
        }
      }

      if (info.readyState === 'ERROR') {
        return {
          ok: false,
          message: `デプロイに失敗しました${info.error ? `: ${info.error}` : ''}`,
          deploymentId: info.id,
        }
      }
      if (info.readyState !== 'READY') {
        // 期限切れ（まだビルド中）。「成功」と誤表示せず、確認を促す。
        return {
          ok: false,
          message: `公開の完了確認が時間内（${Math.round(POLL_TIMEOUT_MS / 60000)}分）にできませんでした。まだビルド中の可能性があります。Vercel の管理画面でご確認ください。`,
          detail: lastError ? dbg(lastError.data) : undefined,
          deploymentId: info.id,
        }
      }
      // extractDeployment が既に https:// を付与済みなので、そのまま使う（二重付与しない）。
      return { ok: true, deploymentId: info.id, url: info.url, readyState: info.readyState }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })
}
