// HANAMII（国産PaaS）連携の IPC（hanamii:*）。staticServerFiles / zipProjectToBuffer もここに移動。
// deps は使わない（トークンは方式B＝renderer が引数で渡す）。
import { app, ipcMain } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { HanamiiClient, extractProjectIds, extractProjectStatus, extractLogs, normalizeHealthCheck, hanamiiErrorMessage, type HanamiiEnv, type HanamiiHealthCheck, type HanamiiResult } from '../hanamii/client'
import { detectEnvKeysInProject } from '../envDetect'
import { issueStorageEnvFor, cleanUpOldKeysFor } from '../cloud/storageForTarget'
// 公開が途中で止まったとき、いま発行した鍵を取り消す（公開の側の守り）。破棄の保存場所の片づけは hanamiiTeardown.ts に移した。
import { revokeIssuedKey } from '../cloud/storageForTarget'
import type { IpcDeps } from './types'
import { zipExcludePatterns, BUILD_CONFIG_FILES } from '../../shared/publishExclude'
import { resolvePublishRoot } from '../publishRootFs'
import { ensureDataLayer } from '../dataLayer'
// koto-data を差し替えたときの1行（文面は共用型・Vercel・専有型と同じ一元定義を通す・掟10）。
import { dataLayerUpdateLine } from '../../shared/storageNoticeText'
import { markPendingFs, clearPendingFs, writePublishRecordFs, writeHanamiiProjectIdFs, readHanamiiProjectIdFs } from '../publishMetaFs'
import { readPublishedAtFs } from '../publishMetaFs'
import { withProjectLock, projectBusyMessage } from '../projectLock'
// 進捗の送り口は1つ（記録の更新を兼ねる）。公開のあと（動いたと確かめる）は hanamii/aftercare.ts。2026-09-29
import { progressReporter } from '../projectOps'
import { waitForNewVersion, type NewVersionOutcome } from '../hanamii/aftercare'
// 破棄（hanamii:teardown）は hanamiiTeardown.ts に切り出した（共通の骨 teardownShell の上）。テストが registerHanamiiHandlers 経由でハンドラを取り出すので、
// 登録はここから呼び、PROJECT_MISMATCH_TEARDOWN と結果の型はここからも読めるようにしておく。
import { registerHanamiiTeardownHandler } from './hanamiiTeardown'
export { PROJECT_MISMATCH_TEARDOWN } from './hanamiiTeardown'
export type { HanamiiTeardownResult } from './hanamiiTeardown'

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
    // 名前は**乱数**で決める。時刻だけだと、同じミリ秒に始まった別のプロジェクトの公開と同じファイルを取り合い、
    // zip が既にあるファイルへ足して**別のプロジェクトのファイルが ZIP に混ざる**（tests/hanamiiZipTmpName.test.ts）。
    const tmp = path.join(app.getPath('temp'), `hanamii-${randomUUID()}.zip`)
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

/** hanamii:publish が返す形（画面が読む項目だけ型にし、あとは読み流す）。 */
type HanamiiPublishReply = {
  ok: boolean
  message?: string
  detail?: string
  projectId?: string | null
  deploymentId?: string | null
  /** 互換のため（画面の旧い片づけ用）。**main が古い鍵を片づけ切れなかったときだけ**入る。 */
  storagePermissionId?: string
  storageProjectName?: string
  executed?: string[]
  /** 見逃してはいけない知らせ（まだ動いていない・確かめられなかった・鍵を片づけられなかった）。 */
  warnings?: string[]
  /** 新しい版が動いたと確かめられたか。'ready' 以外は古い保存場所の鍵を消していない。 */
  deployState?: 'ready' | 'error' | 'pending' | 'unknown'
  readyState?: string
  errorCode?: string
  url?: string
  [k: string]: unknown
}

/**
 * 画面が持っている HANAMII の projectId が、このプロジェクトの記録（.sakuraide.json）が指すものと違うとき、
 * **何もせずに断る**文（2026-09-30 検分・掟11）。画面が別のプロジェクトの projectId を持ち越したまま呼ぶと、
 * 別のプロジェクトの稼働中のアプリを上書き（公開）・削除（破棄）してしまう。最後の砦は main の側に置く。
 */
export const PROJECT_MISMATCH_PUBLISH =
  '公開しようとした HANAMII のプロジェクトが、このプロジェクトの記録と一致しません。'
  + '何も公開していません。公開のダイアログを閉じて開き直してから、もう一度お試しください。'

/** 待った時間を画面の文にする（90秒未満は秒、それ以上は約N分）。 */
function waitedText(sec: number): string {
  return sec < 90 ? `${Math.max(1, sec)}秒` : `約${Math.round(sec / 60)}分`
}

/**
 * HANAMII の公開の**後段**（2026-09-29）: 依頼が受け付けられたあと、**画面に依らずに**最後まで進める。
 *
 *   (1) 新しい版が動いた（READY）と確かめる（aftercare.ts の waitForNewVersion。今回の deployment の id で見る）
 *   (2) 確かめられたら、公開記録の url を書く
 *   (3) 確かめられたら、**そのあとで**古い保存場所の鍵を片づける
 *
 * **古い鍵を消すのは、新しい版が READY になったと確かめてから**（CLAUDE.md 掟10「切り替わる前に、古いほうの
 * 足元を外さない」・2026-08-14 の 403 事故）。READY にならなかった（ERROR・時間切れ・状態を取れない・
 * どの deployment か分からない）ときは**消さず**、結果に「まだ動いていない／確かめられなかった」を正直に載せる。
 *
 * これまでは HanamiiPanel の setInterval がこれを担い、**ダイアログを閉じると行われなかった**
 * （古い鍵が残る・記録の url が null のまま）。**鍵（withProjectLock）の中で行う**——待っている間に
 * 次の公開が始まると、その公開が新しく発行した鍵を、こちらの片づけが「古い鍵」として消しかねない。
 *
 * `ok` は「依頼が受け付けられた」の意味のまま（画面が設定を保存する条件に使っている）。
 * 動いたかどうかは `deployState` で伝える。
 */
async function finishHanamiiPublish(args: {
  projectDir: string
  token: string
  requested: HanamiiPublishReply
  /** 既存のプロジェクトへの再公開か（失敗しても前の版が動き続けている場合があるため、文を分ける）。 */
  redeployed: boolean
  progress: (message: string, extra?: { detail?: string }) => void
}): Promise<HanamiiPublishReply> {
  const { projectDir, requested, progress } = args
  // 依頼の段で載った知らせ（目印を置けなかった）は、後段の知らせと**重ねて**返す（後段の warnings で上書きしない）
  const { storagePermissionId, storageProjectName, warnings: carriedWarnings, ...rest } = requested
  const carried = carriedWarnings ?? []
  const hasKey = !!(storagePermissionId && storageProjectName)
  const keepNote = hasKey ? '保存場所の古いアクセスキーは、新しいバージョンの起動を確認できるまで削除せずに残しています。' : ''
  const keepKeys = hasKey ? { storagePermissionId, storageProjectName } : {}
  const client = new HanamiiClient({ token: args.token })

  progress('⏳ HANAMII が新しいバージョンを起動するのを待っています…')
  const outcome: NewVersionOutcome = await waitForNewVersion({
    getProject: () => client.getProject(String(requested.projectId)),
    deploymentId: typeof requested.deploymentId === 'string' ? requested.deploymentId : null,
    onProgress: (label, detail) => progress(label, { detail }),
  })

  if (outcome.kind === 'ready') {
    // 公開記録の url は、READY になった応答から（HANAMII 公式 API リファレンスの案内どおり）。
    // 依頼を受け付けたときに書いた公開日時は保つ（url だけを足す）。
    if (outcome.url) {
      writePublishRecordFs(projectDir, 'hanamii', { publishedAt: readPublishedAtFs(projectDir, 'hanamii') ?? new Date().toISOString(), url: outcome.url })
    }
    const warnings: string[] = [...carried]
    let keysDone = !hasKey
    if (hasKey) {
      progress('🧹 保存場所の古いアクセスキーを削除しています…')
      try {
        await cleanUpOldKeysFor({ projectName: storageProjectName!, target: 'hanamii', keepId: storagePermissionId! })
        keysDone = true
      } catch {
        warnings.push('保存場所の古いアクセスキーを削除できませんでした（新しいバージョンの起動は確認できています）。次に起動を確認できた公開のときに、もう一度削除します。')
      }
    }
    return {
      ...rest, deployState: 'ready', readyState: 'READY',
      ...(outcome.url ? { url: outcome.url } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(keysDone ? {} : keepKeys),
    }
  }

  if (outcome.kind === 'error') {
    return {
      ...rest, deployState: 'error', readyState: 'ERROR',
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      message: `HANAMII が新しいバージョンを起動できませんでした${outcome.errorCode ? `（エラーコード: ${outcome.errorCode}）` : ''}。`
        + (args.redeployed ? '前のバージョンが動き続けている場合があります。' : '')
        + `HANAMII の管理画面でログを確かめてください。${keepNote}`,
      ...(carried.length > 0 ? { warnings: carried } : {}),
      ...keepKeys,
    }
  }

  if (outcome.kind === 'pending') {
    const waited = waitedText(outcome.waitedSec)
    return {
      ...rest, deployState: 'pending',
      ...(outcome.readyState ? { readyState: outcome.readyState } : {}),
      warnings: [
        outcome.readyState
          ? `HANAMII の新しいバージョンが、待った時間（${waited}）のうちには起動しませんでした（状態: ${outcome.readyState}）。まだ起動していません。HANAMII の管理画面で状態を確かめてください。${keepNote}`
          : `新しいバージョンが起動したかを、待った時間（${waited}）のうちには確かめられませんでした。HANAMII の管理画面で状態を確かめてください。${keepNote}`,
        ...carried,
      ],
      ...keepKeys,
    }
  }

  return {
    ...rest, deployState: 'unknown',
    warnings: [`新しいバージョンが起動したかを確かめられませんでした（${outcome.message}）。HANAMII の管理画面で状態を確かめてください。${keepNote}`, ...carried],
    ...keepKeys,
  }
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
    // 同じプロジェクトの公開・破棄を二重に走らせない（2026-09-29・src/main/projectLock.ts）。
    // 画面を閉じて開き直して、もう一度「公開」を押すと二重に走る。とくに**projectId を保存する前
    // （初回の公開の最中）に二重に走ると、HANAMII のプロジェクトが二重に作られる**。
    // 断ったときは**外部の API を1件も呼ばない**。**開始マーカー（markPendingFs）より外側で
    // 鍵を取る**——断られた側が、走っている公開の印を後始末の finally で消さないため。
    // 進み具合は処理の記録へ通す（projectOps.ts の1つの送り口。この公開は renderer へ進捗を送っていない）。
    // 公開ダイアログを閉じて開き直した画面が、いまの段（アップロード・起動待ち…）を続きから読める。
    const progress = progressReporter(projectDir)
    const locked = await withProjectLock(projectDir, '公開', async () => {
    // 公開開始マーカー（途中で中断・失敗しても後から検知できるようにする）。main の1 invoke は
    // 完走するが、記録（下の成功時の書き込み）が起きるのは最後なので、開始時点でも分かるように
    // 残す。API呼び出しが成功/失敗いずれで終わっても、最下部の finally で必ず消す（roadmap #20）。
    markPendingFs(projectDir, 'hanamii')
    // koto-data を新しい版へ差し替えたときの1行（下の ensureDataLayer で入る。何もしていなければ空）。
    let dataLayerLine = ''
    // 再公開かどうか（失敗したとき、前の版が動き続けている場合があるかで文を分ける）。
    let redeployed = false
    /**
     * 公開の結果に「koto-data を差し替えた」の1行を**必ず**載せる（2026-09-25 検分の指摘13）。
     *
     * `ensureDataLayer` は 2026-09-24 から「印があって版が古いもの」を**上書き**する。
     * ここは戻り値を捨てていたので、公開ボタンを押しただけで利用者のファイルが書き換わるのに
     * 画面にも 🕘 履歴にも何も出なかった（退避も通らないので戻せない）。
     * 成功したときは `executed`（隣の `hanamii:teardown` と同じ形で、画面がそのまま並べる）、
     * 失敗したときはメッセージの末尾に足す（失敗の画面は message しか出さないため）。
     * 共用型（executed）・Vercel（notice）・専有型（warnings）の同じ守りと形を揃えてある。
     */
    const withDataLayerNote = <T extends { ok: boolean; message?: string; executed?: string[] }>(r: T): T => {
      if (!dataLayerLine) return r
      return r.ok
        ? { ...r, executed: [...(r.executed ?? []), dataLayerLine] }
        : { ...r, message: [r.message, dataLayerLine].filter(Boolean).join('\n') }
    }
    // ── 依頼が受け付けられるところまで（開始マーカーはここで外す）────────────────────
    // 「動いたと確かめる」後段は、開始マーカーの外で行う（依頼が通り projectId を記録した時点で、
    // 公開の途中で止まったとは言えない。後段は下の finishHanamiiPublish）。
    const requested = await (async (): Promise<HanamiiPublishReply> => {
    try {
      const token = opts?.token
      if (!token) return { ok: false, message: 'HANAMII のトークンが未登録です' }
      if (!opts?.workspaceId) return { ok: false, message: 'ワークスペースが選択されていません' }
      const client = new HanamiiClient({ token })
      // **プロジェクトが既にあるなら、必ずそれへ再公開する**（新しく作らない）。
      // 画面が渡した projectId が第一。無ければ**ディスクの記録**（main が公開の最後に書く）で補う。
      // 公開ダイアログを閉じて開き直した画面は、記録を読む前に「公開」を押せてしまう。初回の公開が
      // 終わったあとにそこから押されると、projectId 無しで createProject がもう一度走り、
      // プロジェクトが二重に作られて記録の projectId が上書きされる（1つ目は Koto から辿れなくなる）。
      // 鍵（withProjectLock）の中で読むので、「1回目が終わったあと」の記録を必ず見る。
      //
      // ⚠️ ただし、**画面が渡した projectId は、このプロジェクトの記録が指すものと一致するときだけ**使う（2026-09-30 検分・掟11）。
      // 公開は最長およそ5分かかるようになり、その間に📡 一覧から別のプロジェクトへ切り替えると、画面が前のプロジェクトの
      // projectId を持ち越したまま、いまのプロジェクトの projectDir で「公開する」を押せた。画面の値を優先していたので、
      // **別のプロジェクトのコードを、前のプロジェクトの HANAMII の稼働中のアプリへ再デプロイして上書きした**。
      // 食い違うときは、何も送らずに断る（外部の API は1件も呼ばない・koto-data にも触らない）。ディスクが正。
      const recordedProjectId = readHanamiiProjectIdFs(projectDir)
      if (opts.projectId && opts.projectId !== recordedProjectId) {
        return { ok: false, message: PROJECT_MISMATCH_PUBLISH }
      }
      const knownProjectId: string | undefined = recordedProjectId || undefined
      redeployed = !!knownProjectId
      // 静的サイト(マニフェスト無し + index.html)は HANAMII が言語を検出できず拒否するため、最小の静的サーバを同梱する。
      // 送るのは`public/` の中身（無ければプロジェクト直下＝移行前）。
      // HANAMII は **ZIPのルート直下**の言語マニフェストを見るので、根がずれると公開が拒否される。
      const root = resolvePublishRoot(projectDir)
      // **ZIP に詰める前に、koto-data を置く**（2026-09-23 検分）。AI への指示は
      // 「Koto が用意します」と約束しているので、公開の直前にも約束を果たす。
      //
      // **「既にあれば触らない」ではない**（2026-09-24 以降）。印（`// koto-data-template:`）が
      // 付いていて版が古いものは**上書きされる**ので、ここに「何度呼んでも安全」と書くのは嘘になる。
      // 書き換えたことは withDataLayerNote で公開の結果に必ず載せる（指摘13）。
      try {
        const layer = ensureDataLayer(root, projectDir)
        if (layer.replaced) dataLayerLine = dataLayerUpdateLine({ ok: true, file: layer.file, replaced: true })
      } catch { /* 置けなくても公開は続ける */ }
      const hasManifest = ['package.json', 'requirements.txt', 'pyproject.toml', 'composer.json'].some(f => fs.existsSync(path.join(root, f)))
      const hasIndex = fs.existsSync(path.join(root, 'index.html'))
      const extra = (!hasManifest && hasIndex) ? staticServerFiles(opts.name || 'app') : undefined
      // extra が付く＝Koto が Dockerfile を同梱する＝プロジェクト側のものは外す（上記）。
      progress('📦 公開するファイルをまとめています…')
      const zip = await zipProjectToBuffer(root, extra, !!extra)
      if (!zip.length) return withDataLayerNote({ ok: false, message: 'ZIPが空です（公開できるファイルが見つかりません）' })
      // マニフェストも index.html も無い＝HANAMIIが公開形態を判定できない。分かりやすく案内する。
      if (!hasManifest && !hasIndex) {
        return withDataLayerNote({ ok: false, message: 'HANAMII で公開できる形になっていません。静的サイトなら index.html を、アプリなら package.json・requirements.txt・pyproject.toml・composer.json のいずれかを用意してください。' })
      }
      progress('☁️ HANAMII へアップロードしています…')
      const up = await client.createUpload(opts.workspaceId, `${opts.name || 'app'}.zip`)
      if (!up.ok) return withDataLayerNote({ ok: false, message: `アップロードの準備に失敗しました（HTTP ${up.status}）${reason(up.data)}`, detail: dbg(up.data) })
      // 応答形の揺れに強く: { upload: {...} } でも {...} 直下でも拾う。
      const upload = (up.data as any)?.upload ?? (up.data as any)
      const uploadUrl = upload?.uploadUrl
      const uploadId = upload?.id
      if (!uploadUrl || !uploadId) return withDataLayerNote({ ok: false, message: 'アップロードURLを取得できませんでした。', detail: dbg(up.data) })
      const put = await client.uploadZip(uploadUrl, zip)
      if (!put.ok) return withDataLayerNote({ ok: false, message: `ZIP(${zip.length}バイト)のアップロードに失敗しました（HTTP ${put.status}）` })
      progress('🔎 アップロードした内容を HANAMII が検証しています…')
      const chk = await client.checkUpload(uploadId)
      if (!chk.ok) return withDataLayerNote({ ok: false, message: `アップロードの検証に失敗しました（HTTP ${chk.status}）${reason(chk.data)}`, detail: dbg(chk.data) })
      // 応答の揺れに強く: result は直下/トップレベル どちらでも拾う。
      const result = (chk.data as any)?.result ?? (chk.data as any)
      // 「公開できない」判定を先に（HANAMIIの errors を分かりやすく表示）。checkId は canDeploy:true のときだけ返る。
      if (result?.canDeploy === false) {
        const errs = Array.isArray(result.errors)
          ? result.errors.map((e: any) => e?.message ?? e?.type ?? '').filter(Boolean).join('\n')
          : ''
        return withDataLayerNote({
          ok: false,
          message: `HANAMII が公開を受け付けませんでした:\n${errs || `${result.errorCount ?? 0}件のエラー`}`,
          ...(errs ? {} : { detail: dbg(result.errors ?? chk.data) }),
        })
      }
      const checkId = result?.checkId ?? (chk.data as any)?.checkId
      if (!checkId) return withDataLayerNote({ ok: false, message: '検証結果(checkId)を取得できませんでした。', detail: dbg(chk.data) })
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
      // 目印（.koto-keep）を置けなかったときの知らせ（issueStorageEnvFor が置き直す。公開が受け付けられた回の結果に載せる）
      let storageMarkerNote: string | undefined
      /**
       * 公開が途中で止まったときに、**いま発行したばかりの鍵だけ**を取り消す
       * （2026-09-25 検分の指摘14。専有型・Vercel・共用型 apply.ts の `revokeJustIssuedKey` と同じ形）。
       *
       * 片づけ（`cleanUpOldKeysFor`＝下の `hanamii:cleanUpKeys`）は**公開が成功して、READY まで
       * 確かめられたときにしか走らない**。だから途中で止まった回の鍵は誰も片づけず、
       * ビルドが直らない間に押した回数だけ「バケットへ読み書きできる本物の鍵」が溜まる
       * （実機で5件・src/shared/storageKeys.ts 冒頭）。
       *
       * **呼んでよいのは createProject / redeploy が通る前だけ。** 版（デプロイ）が作られたあとは、
       * その版があとから立ち上がって**この鍵で動き出す**ので、取り消すと 403 で落ちる
       * （2026-08-14 の事故と同じ形）。**消すのは引数の1件だけ**なので、古い鍵には触れない。
       * 後始末の失敗で公開の結果を変えない（ほかの3経路と同じ扱い）。
       */
      const revokeJustIssuedKey = async (): Promise<void> => {
        if (!storagePermissionId) return
        try { await revokeIssuedKey({ permissionId: storagePermissionId }) } catch { /* 後始末の失敗で結果を変えない */ }
        storagePermissionId = null
      }
      if (opts.withStorage) {
        progress('🔑 保存場所のアクセスキーを用意しています…')
        const st = await issueStorageEnvFor({ projectDir, target: 'hanamii' })
        if (!st.ok) {
          // 「保存場所が無い」だけなら黙って続ける（使っていないアプリもある）
          if (st.reason === 'error') return withDataLayerNote({ ok: false, message: st.message })
        } else {
          storagePermissionId = st.permissionId
          storageProjectName = st.projectName
          storageMarkerNote = st.markerNote
          const storageEnvs = st.envs.map(e => ({ key: e.key, value: e.value, type: (e.secret ? 'secret' : 'plain') as 'plain' | 'secret' }))
          // 利用者が同じ名前を手で入れていたら、**そちらを優先しない**
          // （こちらは今この瞬間に発行した鍵で、手入力は古い可能性がある）
          const names = new Set(storageEnvs.map(e => e.key))
          envs = [...(envs ?? []).filter(e => !names.has(e.key)), ...storageEnvs]
        }
      }
      const healthCheck = opts.healthCheck ? normalizeHealthCheck(opts.healthCheck) : undefined
      progress('🚀 HANAMII へ公開を依頼しています…')
      let dep: HanamiiResult
      if (knownProjectId) {
        // 既存プロジェクトの再公開: envs/healthCheck は正規経路（PATCH /env・PUT /health-check）で先に保存し、
        // その後 redeploy する（redeploy 自体が保存済みの設定を反映する。restart は不要）。
        if (envs && envs.length) {
          const envRes = await client.patchEnv(knownProjectId, envs)
          if (!envRes.ok) {
            await revokeJustIssuedKey()   // 版はまだ作られていない（検分の指摘14）
            return withDataLayerNote({ ok: false, message: `環境変数の保存に失敗しました（HTTP ${envRes.status}）${reason(envRes.data)}`, detail: dbg(envRes.data) })
          }
        }
        if (healthCheck) {
          const hcRes = await client.putHealthCheck(knownProjectId, healthCheck)
          if (!hcRes.ok) {
            await revokeJustIssuedKey()   // 版はまだ作られていない（検分の指摘14）
            return withDataLayerNote({ ok: false, message: `ヘルスチェック設定の保存に失敗しました（HTTP ${hcRes.status}）${reason(hcRes.data)}`, detail: dbg(hcRes.data) })
          }
        }
        dep = await client.redeploy(knownProjectId, checkId)
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
      if (!dep.ok) {
        // createProject / redeploy が**通らなかった**＝この鍵を載せた版はどこにも無い（検分の指摘14）
        await revokeJustIssuedKey()
        return withDataLayerNote({ ok: false, message: `公開に失敗しました（HTTP ${dep.status}）${reason(dep.data)}`, detail: dbg(dep.data) })
      }
      const ids = extractProjectIds(dep.data)
      const projectId = knownProjectId ?? ids.projectId
      // 公開記録を main 側で残す（renderer が閉じても失われない・roadmap #20）。
      // projectId を保存しないと、次回公開が新規プロジェクトとして二重作成されうる。
      // URL は READY まで分からないため null（renderer のポーリングが後から更新する・従来どおり）。
      writeHanamiiProjectIdFs(projectDir, projectId ?? null)
      writePublishRecordFs(projectDir, 'hanamii', { publishedAt: new Date().toISOString(), url: null })
      return withDataLayerNote({
        ok: true,
        projectId,
        deploymentId: ids.deploymentId,
        // 片づけは**動いたと確かめてから**なので、ここではまだ消さない（下の finishHanamiiPublish が
        // READY を確かめたあとに片づける。片づけ切れなかったときだけ、この2つが返り値に残る）
        ...(storagePermissionId ? { storagePermissionId, storageProjectName } : {}),
        ...(storageMarkerNote ? { warnings: [storageMarkerNote] } : {}),
      })
    } catch (e: any) { return withDataLayerNote({ ok: false, message: e?.message ?? String(e) }) }
    finally { clearPendingFs(projectDir) }
    })()
    // 依頼が通らなかった（token 無し・ZIP 失敗・API 失敗…）／プロジェクトの番号が読めなかったときは、後段へ進まない。
    if (!requested.ok || !requested.projectId) return requested
    // ── 後段: 画面に依らず、新しい版が動いたと確かめるまで進める（古い鍵は READY を確かめてから消す）──
    return finishHanamiiPublish({ projectDir, token: opts.token, requested, redeployed, progress })
    }, { target: 'hanamii', handler: 'hanamii:publish', secrets: [opts?.token] })
    return locked.busy ? { ok: false, message: projectBusyMessage(locked.running, locked.runningTarget) } : locked.value
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
  // HANAMII の破棄（hanamii:teardown）は ipc/hanamiiTeardown.ts（共通の骨 teardownShell の上）。呼び形は (projectDir, { token }, { confirmed, projectId })。
  registerHanamiiTeardownHandler()

  ipcMain.handle('hanamii:detectEnvKeys', async (_, projectDir: string) => {
    try {
      if (!projectDir) return { ok: false, keys: [] as string[] }
      // 送るのは`public/` の中身なので、キーもそこから探す。
      return { ok: true, keys: detectEnvKeysInProject(resolvePublishRoot(projectDir)) }
    } catch (e: any) { return { ok: false, keys: [] as string[], message: e?.message ?? String(e) } }
  })
}
