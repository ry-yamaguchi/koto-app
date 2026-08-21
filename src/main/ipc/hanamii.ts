// HANAMII（国産PaaS）連携の IPC（hanamii:*）。staticServerFiles / zipProjectToBuffer もここに移動。
// deps は使わない（トークンは方式B＝renderer が引数で渡す）。
import { app, ipcMain } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { execFile } from 'child_process'
import { HanamiiClient, extractProjectIds, extractProjectStatus, extractLogs, normalizeHealthCheck, hanamiiErrorMessage, type HanamiiEnv, type HanamiiHealthCheck, type HanamiiResult } from '../hanamii/client'
import { detectEnvKeysInProject } from '../envDetect'
import { issueStorageEnvFor, cleanUpOldKeysFor } from '../cloud/storageForTarget'
import type { IpcDeps } from './types'
import { zipExcludePatterns, BUILD_CONFIG_FILES } from '../../shared/publishExclude'
import { resolvePublishRoot } from '../publishRootFs'

// ── HANAMII（国産PaaS）連携 ──────────────────────────────────────────
// HANAMII は言語マニフェスト(package.json 等)が無いと「対応言語を検出できない」と拒否する。
// 静的サイト(index.html のみ)でも公開できるよう、依存なしの最小静的サーバを同梱するためのファイルを返す。
function staticServerFiles(name: string): { name: string; content: string }[] {
  const pkg = {
    name: (name.replace(/[^A-Za-z0-9._-]/g, '-').toLowerCase() || 'app'),
    version: '1.0.0',
    private: true,
    scripts: { start: 'node .hanamii-static.js' },
  }
  const server = `// .hanamii-static.js — 静的ファイルを配信する最小サーバ（依存なし・HANAMII/AppRun 用）。
// Koto が「静的サイトを HANAMII で公開」する際に自動同梱します。ポートは環境変数 PORT。
const http = require('http'), fs = require('fs'), path = require('path');
const port = process.env.PORT || 8080, root = __dirname;
const TYPES = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.ico':'image/x-icon', '.woff':'font/woff', '.woff2':'font/woff2', '.txt':'text/plain; charset=utf-8' };
http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.normalize(path.join(root, p));
  if (!f.startsWith(root)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(f, (err, data) => {
    if (err) {
      fs.readFile(path.join(root, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404); return res.end('Not Found'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(idx);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(port, () => console.log('static server listening on ' + port));
`
  // HANAMII(AppRun基盤)はコンテナをビルドし、待受ポートを EXPOSE から判定する。
  // 自動生成 Dockerfile には EXPOSE が付かないため、EXPOSE 付きの Dockerfile を明示的に同梱する。
  const dockerfile = `FROM node:20-alpine
WORKDIR /app
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["node", ".hanamii-static.js"]
`
  return [
    { name: 'package.json', content: JSON.stringify(pkg, null, 2) + '\n' },
    { name: '.hanamii-static.js', content: server },
    { name: 'Dockerfile', content: dockerfile },
  ]
}

// プロジェクトをZIP化する（macOS 同梱の zip を使用。node_modules 等は除外）。
// extraFiles があればアーカイブ直下へ追加同梱する（静的サイト用の最小サーバ等）。
//
// ── dropBuildConfig（2026-08-20）────────────────────────────────────────
// **Koto が Dockerfile を同梱するとき（静的サイト）だけ**、プロジェクト側の
// ビルド設定（Dockerfile / nginx.conf / .dockerignore）を外す。理由は2つ:
//   ・同じ `Dockerfile` が2つ入り、**どちらが使われるか決まらない**。
//     HANAMII は**待受ポートを Dockerfile の EXPOSE から判定する**ので（2026-07-03 実測）、
//     AI が AppRun 向けに書いた Dockerfile が拾われると公開が失敗しうる。
//   ・同梱する最小サーバは**カレントの中身をそのまま配る**ので、
//     Dockerfile や nginx.conf が公開URLから読めてしまう。
//
// **マニフェストがある場合（Nodeアプリ等）は外さない。** そのときは Koto は
// Dockerfile を同梱せず、HANAMII がプロジェクトのものを使う可能性がある。
// 外して壊れないことを確かめられていないので触らない（掟1）。
function zipProjectToBuffer(
  projectDir: string,
  extraFiles?: { name: string; content: string }[],
  dropBuildConfig = false,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const tmp = path.join(app.getPath('temp'), `hanamii-${Date.now()}.zip`)
    const args = ['-r', '-q', '-X', tmp, '.', '-x', ...zipExcludePatterns(dropBuildConfig ? [...BUILD_CONFIG_FILES] : [])]
    execFile('zip', args, { cwd: projectDir, timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, (err) => {
      if (err) { try { fs.rmSync(tmp) } catch {}; reject(new Error(`ZIP化に失敗しました（zip コマンドが必要です）: ${err.message}`)); return }
      if (!extraFiles?.length) {
        try { const buf = fs.readFileSync(tmp); resolve(buf) } catch (e: any) { reject(e) } finally { try { fs.rmSync(tmp) } catch {} }
        return
      }
      // 追加ファイルを一時ディレクトリに書き、-j でパスを落としてアーカイブ直下へ追加する。
      let tmpDir = ''
      try {
        tmpDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'hanamii-inject-'))
        const names = extraFiles.map(f => { const p = path.join(tmpDir, f.name); fs.writeFileSync(p, f.content); return p })
        execFile('zip', ['-jgq', tmp, ...names], { timeout: 30000 }, (err2) => {
          try {
            if (err2) { reject(new Error(`静的サーバの同梱に失敗しました: ${err2.message}`)); return }
            resolve(fs.readFileSync(tmp))
          } catch (e: any) { reject(e) }
          finally { try { fs.rmSync(tmp) } catch {}; try { fs.rmSync(tmpDir, { recursive: true }) } catch {} }
        })
      } catch (e: any) {
        try { fs.rmSync(tmp) } catch {}; try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true }) } catch {}
        reject(e)
      }
    })
  })
}

export function registerHanamiiHandlers(_deps: IpcDeps) {
  // 方式B（中央ストア一元・都度参照）: トークンは renderer が引数で渡す。main には保存しない。
  ipcMain.handle('hanamii:testConnection', async (_, token: string) => {
    if (!token) return { ok: false, message: 'HANAMII のトークンが未登録です' }
    return new HanamiiClient({ token }).testConnection()
  })
  ipcMain.handle('hanamii:listWorkspaces', async (_, token: string) => {
    if (!token) return { ok: false, message: 'HANAMII のトークンが未登録です' }
    const r = await new HanamiiClient({ token }).listWorkspaces()
    if (!r.ok) return { ok: false, message: (r.status === 401 || r.status === 403) ? '認証に失敗しました（HANAMII のトークンを確認してください）' : `取得に失敗しました（HTTP ${r.status}）` }
    const raw = (r.data as any)?.workspaces
    const workspaces = Array.isArray(raw) ? raw.map((w: any) => ({ id: String(w.id), name: String(w.name ?? w.id), role: String(w.role ?? '') })) : []
    return { ok: true, workspaces }
  })
  ipcMain.handle('hanamii:publish', async (_, projectDir: string, opts: { token: string; workspaceId: string; projectId?: string; name: string; envs?: Array<{ key: string; value: string; type?: 'plain' | 'secret' }>; healthCheck?: HanamiiHealthCheck; withStorage?: boolean }) => {
    // 失敗時の生応答（JSON短縮・診断用）。message には連結せず detail フィールドで返し、renderer 側が
    // 折りたたみ（詳細を見る）で表示する（所見11: 生JSON連結の修正。生JSONは過去に原因究明で
    // 役立った実績があるため、捨てずに折りたたみとして残す）。
    const dbg = (x: unknown) => { try { const s = JSON.stringify(x); return s ? s.slice(0, 400) : String(x) } catch { return String(x) } }
    // 応答から人間可読な理由を取り出して「: <理由>」として message に添える。
    // hanamiiErrorMessage がJSON全文へフォールバックした場合は detail と重複するため添えない。
    const reason = (data: unknown) => {
      const m = hanamiiErrorMessage(data)
      return m && !/^[[{]/.test(m) ? `: ${m}` : ''
    }
    try {
      const token = opts?.token
      if (!token) return { ok: false, message: 'HANAMII のトークンが未登録です' }
      if (!opts?.workspaceId) return { ok: false, message: 'ワークスペースが選択されていません' }
      const client = new HanamiiClient({ token })
      // 静的サイト(マニフェスト無し + index.html)は HANAMII が言語を検出できず拒否するため、最小の静的サーバを同梱する。
      // 送るのは`public/` の中身（無ければプロジェクト直下＝移行前）。
      // HANAMII は **ZIPのルート直下**の言語マニフェストを見るので、根がずれると公開が拒否される。
      const root = resolvePublishRoot(projectDir)
      const hasManifest = ['package.json', 'requirements.txt', 'pyproject.toml', 'composer.json'].some(f => fs.existsSync(path.join(root, f)))
      const hasIndex = fs.existsSync(path.join(root, 'index.html'))
      const extra = (!hasManifest && hasIndex) ? staticServerFiles(opts.name || 'app') : undefined
      // extra が付く＝Koto が Dockerfile を同梱する＝プロジェクト側のものは外す（上記）。
      const zip = await zipProjectToBuffer(root, extra, !!extra)
      if (!zip.length) return { ok: false, message: 'ZIPが空です（公開できるファイルが見つかりません）' }
      // マニフェストも index.html も無い＝HANAMIIが公開形態を判定できない。分かりやすく案内する。
      if (!hasManifest && !hasIndex) {
        return { ok: false, message: 'HANAMII で公開できる形になっていません。静的サイトなら index.html を、アプリなら package.json 等（package.json / requirements.txt / pyproject.toml / composer.json）を用意してください。' }
      }
      const up = await client.createUpload(opts.workspaceId, `${opts.name || 'app'}.zip`)
      if (!up.ok) return { ok: false, message: `アップロード枠の作成に失敗しました（HTTP ${up.status}）${reason(up.data)}`, detail: dbg(up.data) }
      // 応答形の揺れに強く: { upload: {...} } でも {...} 直下でも拾う。
      const upload = (up.data as any)?.upload ?? (up.data as any)
      const uploadUrl = upload?.uploadUrl
      const uploadId = upload?.id
      if (!uploadUrl || !uploadId) return { ok: false, message: 'アップロードURLを取得できませんでした。', detail: dbg(up.data) }
      const put = await client.uploadZip(uploadUrl, zip)
      if (!put.ok) return { ok: false, message: `ZIP(${zip.length}バイト)のアップロードに失敗しました（HTTP ${put.status}）` }
      const chk = await client.checkUpload(uploadId)
      if (!chk.ok) return { ok: false, message: `アップロードの検証に失敗しました（HTTP ${chk.status}）${reason(chk.data)}`, detail: dbg(chk.data) }
      // 応答の揺れに強く: result は直下/トップレベル どちらでも拾う。
      const result = (chk.data as any)?.result ?? (chk.data as any)
      // 「公開できない」判定を先に（HANAMIIの errors を分かりやすく表示）。checkId は canDeploy:true のときだけ返る。
      if (result?.canDeploy === false) {
        const errs = Array.isArray(result.errors)
          ? result.errors.map((e: any) => e?.message ?? e?.type ?? '').filter(Boolean).join('\n')
          : ''
        return {
          ok: false,
          message: `HANAMII が公開を受け付けませんでした:\n${errs || `${result.errorCount ?? 0}件のエラー`}`,
          ...(errs ? {} : { detail: dbg(result.errors ?? chk.data) }),
        }
      }
      const checkId = result?.checkId ?? (chk.data as any)?.checkId
      if (!checkId) return { ok: false, message: '検証結果(checkId)を取得できませんでした。', detail: dbg(chk.data) }
      let envs = Array.isArray(opts.envs)
        ? opts.envs.filter(e => e && typeof e.key === 'string' && e.key.trim()).map(e => ({ key: e.key.trim(), value: e.value ?? '', type: e.type ?? 'plain' as const }))
        : undefined
      // ── データの保存を持っていく（2026-08-15）────────────────────────
      // データはオブジェクトストレージにあり、**計算とは別の場所**にある。
      // 鍵を発行して環境変数で渡せば、AppRun で作ったデータをそのまま読める。
      // **シークレットはここ（main）で受け取り、そのまま HANAMII へ渡し切る。**
      // renderer には渡さず、ディスクにも書かない（掟4）。
      let storagePermissionId: string | null = null
      let storageProjectName = ''
      if (opts.withStorage) {
        const st = await issueStorageEnvFor({ projectDir, target: 'hanamii' })
        if (!st.ok) {
          // 「保存場所が無い」だけなら黙って続ける（使っていないアプリもある）
          if (st.reason === 'error') return { ok: false, message: st.message }
        } else {
          storagePermissionId = st.permissionId
          storageProjectName = st.projectName
          const storageEnvs = st.envs.map(e => ({ key: e.key, value: e.value, type: (e.secret ? 'secret' : 'plain') as 'plain' | 'secret' }))
          // 利用者が同じ名前を手で入れていたら、**そちらを優先しない**
          // （こちらは今この瞬間に発行した鍵で、手入力は古い可能性がある）
          const names = new Set(storageEnvs.map(e => e.key))
          envs = [...(envs ?? []).filter(e => !names.has(e.key)), ...storageEnvs]
        }
      }
      const healthCheck = opts.healthCheck ? normalizeHealthCheck(opts.healthCheck) : undefined
      let dep: HanamiiResult
      if (opts.projectId) {
        // 既存プロジェクトの再公開: envs/healthCheck は正規経路（PATCH /env・PUT /health-check）で先に保存し、
        // その後 redeploy する（redeploy 自体が保存済みの設定を反映する。restart は不要）。
        if (envs && envs.length) {
          const envRes = await client.patchEnv(opts.projectId, envs)
          if (!envRes.ok) return { ok: false, message: `環境変数の保存に失敗しました（HTTP ${envRes.status}）${reason(envRes.data)}`, detail: dbg(envRes.data) }
        }
        if (healthCheck) {
          const hcRes = await client.putHealthCheck(opts.projectId, healthCheck)
          if (!hcRes.ok) return { ok: false, message: `ヘルスチェック設定の保存に失敗しました（HTTP ${hcRes.status}）${reason(hcRes.data)}`, detail: dbg(hcRes.data) }
        }
        dep = await client.redeploy(opts.projectId, checkId)
      } else {
        dep = await client.createProject({
          name: opts.name || 'app',
          workspaceId: opts.workspaceId,
          source: { type: 'zip', checkId },
          ...(envs && envs.length ? { envs } : {}),
          // 新規作成で enabled:false を送る意味はない（無効=未設定）。有効時のみボディに含める
          ...(healthCheck && healthCheck.enabled ? { healthCheck } : {}),
        })
      }
      if (!dep.ok) return { ok: false, message: `公開に失敗しました（HTTP ${dep.status}）${reason(dep.data)}`, detail: dbg(dep.data) }
      const ids = extractProjectIds(dep.data)
      return {
        ok: true,
        projectId: opts.projectId ?? ids.projectId,
        deploymentId: ids.deploymentId,
        // 片づけは**動いたと確かめてから**なので、ここではまだ消さない（下の hanamii:cleanUpKeys）
        ...(storagePermissionId ? { storagePermissionId, storageProjectName } : {}),
      }
    } catch (e: any) { return { ok: false, message: e?.message ?? String(e) } }
  })
  ipcMain.handle('hanamii:status', async (_, projectId: string, token: string) => {
    if (!token) return { ok: false, message: 'HANAMII のトークンが未登録です' }
    if (!projectId) return { ok: false, message: 'プロジェクトIDがありません' }
    const r = await new HanamiiClient({ token }).getProject(projectId)
    if (!r.ok) return { ok: false, message: `状態の取得に失敗しました（HTTP ${r.status}）` }
    const s = extractProjectStatus(r.data)
    return { ok: true, url: s.url, readyState: s.readyState, errorCode: s.errorCode, runtime: s.runtime }
  })
  /**
   * この公開先の古い鍵を片づける（2026-08-15）。
   *
   * **動いたと確かめてから呼ぶこと。** デプロイの応答が返っても新しいコンテナは
   * まだ立ち上がっておらず、その間に古い鍵を消すと**動いているアプリが 403 で落ちる**
   * （2026-08-14 に AppRun で実際に起きた）。
   * ほかの公開先（AppRun）の鍵には触れない（名前で分けてある）。
   */
  ipcMain.handle('hanamii:cleanUpKeys', async (_, opts: { projectName: string; keepId: string }) => {
    try {
      if (!opts?.projectName || !opts?.keepId) return { ok: true, deleted: 0 }
      const r = await cleanUpOldKeysFor({ projectName: opts.projectName, target: 'hanamii', keepId: opts.keepId })
      return { ok: true, deleted: r.deleted }
    } catch (e: any) {
      // 片づけに失敗しても公開は成立している
      return { ok: false, deleted: 0, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle('hanamii:logs', async (_, token: string, projectId: string, opts?: { limit?: number; since?: string }) => {
    if (!token) return { ok: false, message: 'HANAMII のトークンが未登録です' }
    if (!projectId) return { ok: false, message: 'プロジェクトIDがありません' }
    const r = await new HanamiiClient({ token }).getLogs(projectId, opts)
    if (!r.ok) return { ok: false, message: `ログの取得に失敗しました（HTTP ${r.status}）` }
    return { ok: true, logs: extractLogs(r.data) }
  })
  // A-5: env/ヘルスチェックの変更を「再公開（ビルドし直し）」なしで反映する高速経路。
  // 正規の形（dev-plan P2-⑥）: PATCH /env・PUT /health-check は保存のみで、実行中アプリへの反映には
  // POST /restart が必要。envs/healthCheck が渡されたときだけ先に保存してから restart する
  // （renderer の HanamiiPanel が現在のフォーム内容を毎回渡す想定）。restart 自体が no-op のときは
  // HANAMII 側が { noop:true } を返すのでそのまま伝える。
  ipcMain.handle('hanamii:restart', async (_, projectId: string, opts: { token: string; envs?: HanamiiEnv[]; healthCheck?: HanamiiHealthCheck }) => {
    const dbg = (x: unknown) => { try { const s = JSON.stringify(x); return s ? s.slice(0, 400) : String(x) } catch { return String(x) } }
    const reason = (data: unknown) => {
      const m = hanamiiErrorMessage(data)
      return m && !/^[[{]/.test(m) ? `: ${m}` : ''
    }
    try {
      const token = opts?.token
      if (!token) return { ok: false, message: 'HANAMII のトークンが未登録です' }
      if (!projectId) return { ok: false, message: 'プロジェクトIDがありません（先に公開してください）' }
      const client = new HanamiiClient({ token })
      const envs = Array.isArray(opts?.envs)
        ? opts.envs.filter(e => e && typeof e.key === 'string' && e.key.trim())
        : undefined
      if (envs && envs.length) {
        const envRes = await client.patchEnv(projectId, envs)
        if (!envRes.ok) return { ok: false, message: `環境変数の保存に失敗しました（HTTP ${envRes.status}）${reason(envRes.data)}`, detail: dbg(envRes.data) }
      }
      if (opts?.healthCheck) {
        const hcRes = await client.putHealthCheck(projectId, opts.healthCheck)
        if (!hcRes.ok) return { ok: false, message: `ヘルスチェック設定の保存に失敗しました（HTTP ${hcRes.status}）${reason(hcRes.data)}`, detail: dbg(hcRes.data) }
      }
      const r = await client.restart(projectId)
      if (!r.ok) return { ok: false, message: `再起動に失敗しました（HTTP ${r.status}）${reason(r.data)}`, detail: dbg(r.data) }
      const noop = !!(r.data as any)?.noop
      return { ok: true, noop }
    } catch (e: any) { return { ok: false, message: e?.message ?? String(e) } }
  })
  ipcMain.handle('hanamii:teardown', async (_, projectId: string, token: string) => {
    if (!token) return { ok: false, message: 'HANAMII のトークンが未登録です' }
    const r = await new HanamiiClient({ token }).deleteProject(projectId)
    if (!r.ok) return { ok: false, message: `削除に失敗しました（HTTP ${r.status}）` }
    return { ok: true }
  })

  ipcMain.handle('hanamii:detectEnvKeys', async (_, projectDir: string) => {
    try {
      if (!projectDir) return { ok: false, keys: [] as string[] }
      // 送るのは`public/` の中身なので、キーもそこから探す。
      return { ok: true, keys: detectEnvKeysInProject(resolvePublishRoot(projectDir)) }
    } catch (e: any) { return { ok: false, keys: [] as string[], message: e?.message ?? String(e) } }
  })
}
