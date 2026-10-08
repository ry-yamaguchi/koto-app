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
  vercelEnvErrorMessage,
  sanitizeProjectName,
} from '../vercel/client'
import { issueStorageEnvFor, cleanUpOldKeysFor, revokeIssuedKey, storagePlacementOf, type StorageEnvResult } from '../cloud/storageForTarget'
import type { IpcDeps } from './types'
import { scanDataUsage, ensureDataLayer } from '../dataLayer'
// 差し替えを知らせる1行は StorageNotice と**同じ純関数**を使う（掟10。文言を二重に書かない）。
import { dataLayerUpdateLine } from '../../shared/storageNoticeText'
import { judgeVercelFit } from '../../shared/vercelFit'
import { summarizePreflight, sortChecks } from '../../shared/preflight'
import { resolvePublishRoot } from '../publishRootFs'
import { markPendingFs, clearPendingFs, writePublishRecordFs } from '../publishMetaFs'
import { withProjectLock, projectBusyMessage } from '../projectLock'
// 進捗の送り口は1つ（記録の更新と renderer への通知を兼ねる）。2026-09-29・projectOps.ts
import { progressReporter } from '../projectOps'

// デプロイ状態のポーリング設定。数秒間隔でREADY/ERRORまで待つ（タイムアウトあり）。
const POLL_INTERVAL_MS = 3000
const POLL_TIMEOUT_MS = 5 * 60 * 1000

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 公開が途中で止まったときに、**いま発行したばかりの鍵だけ**を取り消す
 * （2026-09-24 検分の指摘5・6・7。専有型の `revokeJustIssuedKey` と同じ形）。
 *
 * 片づけ（`cleanUpOldKeysFor`）は**成功した公開のときにしか走らない**ので、ここで取り消さないと
 * 「バケットへ読み書きできる本物の鍵」が、押した回数だけ溜まる（実機で5件・storageKeys.ts 冒頭）。
 * Vercel には破棄の口が無い（`teardownSupport('vercel')` は 'manual'）ので、
 * 一度も成功しなければ**誰も片づけない**。
 *
 * **消すのは引数の1件だけ。古い鍵には触れない**ので、動いているアプリが 403 で落ちる危険は無い。
 * **まだどの版にも載っていないと分かるときだけ呼ぶこと**——デプロイを作ったあとは、その版が
 * あとから READY になって**その鍵で動き出す**ことがある（確認が時間切れ・状態取得の失敗）。
 * 後始末の失敗で公開の結果を変えない（専有型・共用型・HANAMII と同じ扱い）。
 */
async function revokeJustIssuedKey(storage: StorageEnvResult): Promise<void> {
  if (!storage.ok) return
  try { await revokeIssuedKey({ permissionId: storage.permissionId }) } catch { /* 後始末の失敗で結果を変えない */ }
}

export function registerVercelHandlers(_deps: IpcDeps) {
  ipcMain.handle('vercel:testConnection', async (_, token: string, teamId?: string) => {
    if (!token) return { ok: false, message: 'Vercel のトークンが未登録です' }
    const r = await new VercelClient({ token, teamId }).testConnection()
    if (!r.ok) return r
    const who = r.username ? `（${r.username}）` : ''
    // **「接続できた」＝「公開できる」ではない**（2026-08-22 Ryosuke 指摘）。
    // 確かめたのは「公開先が見えること」までなので、そこまでの言い方に留める。
    if (r.dropTeamId) {
      // 範囲つき（Team / Project）のトークンは teamId を要らない。付いていると拒否される
      return {
        ok: true, warn: true, status: r.status,
        message: `接続できました${who}。ただし、チームIDは空欄にしてください。このトークンは範囲が決まっていて、チームIDを付けると拒否されます。`,
      }
    }
    const scope = typeof r.projects === 'number'
      ? (r.projects === 0 ? '（見えるプロジェクトはまだありません）' : `（プロジェクトが見えています）`)
      : ''
    return { ok: true, status: r.status, message: `接続できました${who}${scope}` }
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
      const scan = scanDataUsage(resolvePublishRoot(projectDir))
      let hasFiles = false
      try { hasFiles = collectDeployFiles(resolvePublishRoot(projectDir)).length > 0 } catch { hasFiles = false }
      // 保存場所を用意済みか（2026-09-24 検分の指摘1・4・12）。**これを見ないと
      // 「データは残ります」と嘘をつく**——用意していないプロジェクトでは環境変数が
      // 1件も渡らないまま公開が成功し、データは毎回消える。判断は既にある純関数
      // （storagePlacementOf＝同意済みの保存場所があるか）に任せ、ここで新しく書かない（掟10）。
      let hasStorage = false
      try { hasStorage = storagePlacementOf(projectDir) !== null } catch { hasStorage = false }
      const checks = sortChecks(judgeVercelFit({
        packageJson,
        listens: scan.listens,
        usesData: scan.usedBy,
        hasFiles,
        hasStorage,
        // **ファイル直書きの残りも渡す**（2026-09-25 検分の指摘18）。渡さないと
        // `judgeVercelFit` は「分からない」側に倒れ、`koto-data` を使わず
        // `fs.writeFileSync` だけのアプリが**データの行ごと ✅** で通ってしまう
        // （公開のたびに消えるのに「データの保存を使っていません」と出る）。
        // 走査は直前の `scanDataUsage` で既に手元にある——ここで数え直さない（掟10）。
        // **この1行を消すと tests/vercelPreflightWiring.test.ts が落ちる**（渡し忘れの検知）。
        //
        // ── 打ち切られた回は「分からない」側へ倒す（2026-09-25 検分の指摘V4）────────
        // `scanDataUsage` は 2000ファイル・512KB・深さ8 で**打ち切る**（scan.truncated）。
        // 打ち切られたのに空の配列を渡すと、`judgeVercelFit` の
        // `writesKnown = Array.isArray(scan.writesFiles)` が true になり、
        // **見ていないだけ**のものを「直書きは無いと確かめた」に倒す。その結果
        // 「データは残ります」と言い切るが、見ていない側に fs.writeFileSync が
        // 実在すれば、そのデータは公開のたびに消える（確かめられなかったことを断定する形）。
        // 隣の同じ判断（shared/storageNoticeText.ts の rewriteCheckDone）も
        // `scan.truncated === true` なら「済んだ」に倒さない。向きを揃える。
        //
        // **ただし「見つかったもの」までは捨てない。** 打ち切られていても、拾えた直書きは
        // 実在が確かめられた事実である。ここで undefined にすると、koto-data を使わず
        // 直書きだけのアプリが**データの行ごと ✅**（「データの保存を使っていません」）へ
        // 戻り、指摘18 の穴を打ち切りの回にだけ作り直すことになる。
        // 倒すのは**「無い」と言えるかどうか**だけ＝打ち切られていて1件も見つからなかった回。
        writesFiles: scan.truncated && scan.writesFiles.length === 0
          ? undefined
          : scan.writesFiles.map(w => w.file),
        // メモリだけに持つ形（2026-10-01 rc.5 の実機）。同じ走査の結果をそのまま渡す。
        // **打ち切りで「分からない」へ倒す処理は付けない**——この信号には「無い」と言い切る文が
        // 無く（見つかったときだけ警告する）、見ていない範囲を断定する形にならないため。
        // **この1行を消すと tests/memoryKeepWiring.test.ts が落ちる**（渡し忘れの検知）。
        keepsInMemory: scan.keepsInMemory.map(w => w.file),
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
    // 送り口は projectOps.ts の1つ（progressReporter）: 処理の記録も更新するので、公開ダイアログを
    // 閉じて開き直した画面も、いまの進み具合を続きから読める（2026-09-29）。
    const progress = progressReporter(projectDir, m => event.sender.send('vercel:progress', m))
    // 同じプロジェクトの公開を二重に走らせない（2026-09-29・src/main/projectLock.ts）。
    // 画面を閉じて開き直して、もう一度「公開」を押すと二重に走る。断ったときは**外部の API を
    // 1件も呼ばない**。**開始マーカー（markPendingFs）より外側で鍵を取る**——断られた側が、
    // 走っている公開の印を後始末の finally で消さないため。
    const locked = await withProjectLock(projectDir, '公開', async () => {
    // 公開開始マーカー（途中で中断・失敗しても後から検知できるようにする）。main の1 invoke は
    // 完走するが、記録（下の成功時の書き込み）が起きるのは最後なので、開始時点でも分かるように
    // 残す。API呼び出しが成功/失敗いずれで終わっても、最下部の finally で必ず消す（roadmap #20）。
    markPendingFs(projectDir, 'vercel')
    // koto-data を新しい版へ差し替えたときの1行（下の ensureDataLayer で入る。何もしていなければ空）。
    let dataLayerLine = ''
    /**
     * 公開の結果に「koto-data を差し替えた」の1行を**必ず**載せる（2026-09-25 検分）。
     *
     * `ensureDataLayer` は 2026-09-24 から「印があって版が古いもの」を**上書き**する。
     * 公開ボタンを押しただけで利用者のファイルが変わるのに、戻り値を捨てていたため
     * 画面にも 🕘 履歴にも何も出ず、**黙って書き換わっていた**（退避も通らないので戻せない）。
     * 成功したときは `notice`、失敗したときはメッセージの末尾に足す
     * （失敗の画面は message しか出さないため）。専有型の同じ守りと形を揃えてある。
     */
    const withDataLayerNote = <T extends { ok: boolean; message?: string; notice?: string }>(r: T): T => {
      if (!dataLayerLine) return r
      // **既にある知らせを先頭に保つ**（2026-09-25 検分の指摘35）。notice には
      // 「保存場所を用意していないので、このアプリのデータは残りません」という
      // **失うものの警告**が入る。片づけの報告（koto-data を差し替えました）を
      // その上に置くと、いちばん大事な行が2行目へ下がる。
      return r.ok
        ? { ...r, notice: [r.notice, dataLayerLine].filter(Boolean).join('\n') }
        : { ...r, message: [r.message, dataLayerLine].filter(Boolean).join('\n') }
    }
    try {
      const token = opts?.token
      if (!token) return { ok: false, message: 'Vercel のトークンが未登録です' }
      if (!projectDir || !fs.existsSync(projectDir)) return { ok: false, message: 'プロジェクトフォルダが見つかりません' }

      const teamId = opts?.teamId?.trim() || undefined
      const client = new VercelClient({ token, teamId })
      const name = sanitizeProjectName(opts.name || path.basename(projectDir))

      // **集める前に koto-data を置く**（2026-09-23 検分）。AI への指示
      // （aiContext.ts の DATA_RULE）は「Koto が用意します」と約束しているので、
      // 公開の直前にも約束を果たす。
      // **差し替えたときは黙らない**（2026-09-25 検分）——印があって版が古いものは
      // 上書きされる。利用者のファイルが変わるので、結果に必ず1行を載せる。
      try {
        const layer = ensureDataLayer(resolvePublishRoot(projectDir), projectDir)
        if (layer.replaced) dataLayerLine = dataLayerUpdateLine({ ok: true, file: layer.file, replaced: true })
      } catch { /* 置けなくても公開は続ける */ }

      // ── データの保存を持っていく（2026-09-24）──────────────────────────
      // データはさくらのオブジェクトストレージにあり、**計算（Vercel）とは別の場所**にある。
      // 鍵を発行して環境変数で渡せば、AppRun で作ったデータをそのまま読める。
      // 鍵と環境変数は HANAMII・AppRun 共用型／専有型と**同じ関数**（issueStorageEnvFor）で作る——
      // ここに新しい判断を書かない（掟10）。
      //
      // **シークレットはここ（main）で受け取り、そのまま Vercel へ渡し切る。**
      // renderer には渡さず、ディスクにも書かない（掟4）。
      const storage = await issueStorageEnvFor({ projectDir, target: 'vercel' })
      if (!storage.ok && storage.reason === 'error') {
        // reason:'none'（保存場所を用意していない）は失敗ではない＝何も足さずに公開を続ける
        // （勝手にバケットを作らない＝勝手に課金しない）。**止めるのは 'error' だけ。**
        // 用意してあるのに渡せないまま公開すると、利用者は「残る」と思ったままデータを失う。
        // **ここも withDataLayerNote を通す**（2026-09-25 検分の指摘12）。この return は
        // 上の ensureDataLayer より後ろにあるので、鍵を用意できずに止まった回でも
        // koto-data は**既に差し替わっている**。素の object のまま返すと、
        // 「公開ボタンを押しただけで黙って書き換わった」がこの道にだけ残る。
        return withDataLayerNote({
          ok: false,
          message: `${storage.message}\nこのまま公開すると、アプリに入力されたデータを読み書きできないため、公開を中止しました。`,
        })
      }
      // 保存場所を用意していないのに、データの保存を使っているアプリ（2026-09-24 検分の指摘1）。
      // 公開は止めない（勝手に課金しない）が、**黙って成功させない**——環境変数は1件も渡らず、
      // `koto-data` は手元のフォルダ（`.koto-data`）へ落ちる。Vercel では書いたものが残らないので、
      // 利用者は「保存したつもりのデータ」を毎回失う。公開前チェックも同じことを伝えるが、
      // あれは**画面を開いた時点の写し**なので、公開の結果にも必ず添える。
      let noStorageNotice: string | undefined
      if (!storage.ok && storage.reason === 'none') {
        let usesData = false
        try { usesData = scanDataUsage(resolvePublishRoot(projectDir)).usedBy.length > 0 } catch { usesData = false }
        if (usesData) {
          noStorageNotice = '保存場所をまだ用意していないため、このアプリのデータは残りません'
            + '（公開のたびに、アプリに入力されたデータが消えます）。'
            + '「保存場所を用意する」から用意してから、もう一度「公開する」を押してください。'
        }
      }

      // 環境変数は**デプロイを作る前**に置く（Vercel は作成時点の設定をそのデプロイに焼き付ける）。
      // ただし**初回の公開では、まだ Vercel 側にプロジェクトが無い**（作るのはこのあとのデプロイ）。
      // その1回だけは渡せないので、公開したあとに置き直し、**次の公開から効くことを正直に伝える**。
      let envDeferred = false
      if (storage.ok) {
        progress('🔑 保存場所の設定を Vercel へ渡しています…')
        const envRes = await client.createEnvVars(name, storage.envs)
        if (!envRes.ok) {
          if (envRes.status === 404) envDeferred = true
          // **生の応答を detail に載せない**（作ろうとした環境変数が載りうる・掟4）。
          else {
            // ここで止まると、いま発行した鍵を**誰も使わないまま**残す（検分の指摘5・6・7）。
            // デプロイはまだ作っていないので、取り消しても動いているアプリには触れない。
            await revokeJustIssuedKey(storage)
            return withDataLayerNote({ ok: false, message: vercelEnvErrorMessage(envRes.status) })
          }
        }
      }

      progress('ファイルを収集しています…')
      const files = collectDeployFiles(resolvePublishRoot(projectDir))
      if (files.length === 0) {
        // デプロイを作る前の中止。発行した鍵はどの版にも載っていない（検分の指摘5・6・7）。
        await revokeJustIssuedKey(storage)
        return withDataLayerNote({ ok: false, message: 'アップロードできるファイルが見つかりません（プロジェクトが空の可能性があります）。' })
      }

      // (1) 各ファイルを先にアップロード（冪等・既アップロード済みでも200）。
      for (let i = 0; i < files.length; i++) {
        const f = files[i]
        progress(`アップロード中… (${i + 1}/${files.length})`, { step: i + 1, total: files.length })
        let buf: Buffer
        try {
          buf = fs.readFileSync(f.absPath)
        } catch (e: any) {
          await revokeJustIssuedKey(storage)   // デプロイを作る前（検分の指摘5・6・7）
          return withDataLayerNote({ ok: false, message: `ファイル（${f.relPath}）の読み込みに失敗しました: ${e?.message ?? String(e)}` })
        }
        const up = await client.uploadFile(buf)
        if (!up.ok) {
          await revokeJustIssuedKey(storage)   // デプロイを作る前（検分の指摘5・6・7）
          return withDataLayerNote({
            ok: false,
            message: `ファイル（${f.relPath}）のアップロードに失敗しました（HTTP ${up.status}）: ${vercelErrorMessage(up.data, up.status)}`,
            detail: dbg(up.data),
          })
        }
      }

      // (2) デプロイを作成。
      progress('公開の準備をしています…')
      const body = buildDeploymentBody(name, files)
      const dep = await client.createDeployment(body)
      if (!dep.ok) {
        // 版が1つも作られていない（作成そのものが失敗した）ので、取り消して安全
        // （検分の指摘5・6・7）。**これより後は取り消さない**——作られた版は、
        // あとから READY になってこの鍵で動き出すことがある。
        await revokeJustIssuedKey(storage)
        return withDataLayerNote({
          ok: false,
          message: `公開に失敗しました（HTTP ${dep.status}）: ${vercelErrorMessage(dep.data, dep.status)}`,
          detail: dbg(dep.data),
        })
      }
      let info = extractDeployment(dep.data)
      if (!info.id) return withDataLayerNote({ ok: false, message: 'デプロイIDを取得できませんでした。', detail: dbg(dep.data) })
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
            return withDataLayerNote({
              ok: false,
              message: `公開（Vercel ではデプロイと呼びます）の状態確認に繰り返し失敗しました（HTTP ${st.status}）。Vercel の管理画面でご確認ください。`,
              detail: dbg(st.data),
              deploymentId,
            })
          }
        }
      }

      if (info.readyState === 'ERROR') {
        return withDataLayerNote({
          ok: false,
          message: `公開に失敗しました${info.error ? `: ${info.error}` : ''}`,
          deploymentId: info.id,
        })
      }
      if (info.readyState !== 'READY') {
        // 期限切れ（まだビルド中）。「成功」と誤表示せず、確認を促す。
        return withDataLayerNote({
          ok: false,
          message: `公開の完了確認が時間内（${Math.round(POLL_TIMEOUT_MS / 60000)}分）にできませんでした。まだビルド中の可能性があります。Vercel の管理画面でご確認ください。`,
          detail: lastError ? dbg(lastError.data) : undefined,
          deploymentId: info.id,
        })
      }
      // extractDeployment が既に https:// を付与済みなので、そのまま使う（二重付与しない）。
      // 公開記録を main 側で残す（renderer が閉じても失われない・roadmap #20）。
      writePublishRecordFs(projectDir, 'vercel', { publishedAt: new Date().toISOString(), url: info.url ?? null })

      let notice: string | undefined = noStorageNotice
      if (storage.ok) {
        // 設定が**実際に Vercel へ届いたか**（2026-09-24 検分の指摘10）。
        // 届いていなければ、いまのデプロイは鍵を1件も持っていない＝古い鍵を消してはいけない。
        let envDelivered = !envDeferred
        if (envDeferred) {
          // 初回の公開。プロジェクトができたので、ここで置き直す。**この版にはまだ効かない**ので、
          // 「もう一度公開してください」まで書く（黙っていると、データが保存できない理由が分からない）。
          const retry = await client.createEnvVars(name, storage.envs)
          if (retry.ok) {
            envDelivered = true
            notice = '公開できました。データの保存に使う設定を Vercel へ渡しました（今回の公開にはまだ反映されていません）。'
              + 'もう一度「公開する」を押すと、データの保存が使えるようになります。'
          } else {
            // **理由と直し方を落とさない**（2026-09-24 検分の指摘11・14）。
            // 403（トークンの範囲に公開先の設定変更が含まれていない）は何度押しても直らないので、
            // 「もう一度お試しください」だけでは、利用者は同じ操作を繰り返すだけになる。
            // 再公開のとき（上の createEnvVars の失敗）と**同じ関数**で文を決める（掟10）——
            // HTTP の状態だけを見るので、生の応答も秘密も載らない。
            notice = vercelEnvErrorMessage(retry.status, { alreadyPublished: true })
          }
        }
        // 古い鍵を片づける（**動いたと確かめてから**）。READY は Vercel が「配信を始めた」と
        // 言った状態なので、ここで初めて古い鍵を外せる（2026-08-14 の 403 事故と同じ守り）。
        // 消すのは Vercel の名前（`koto-<名前>_vercel`）の鍵だけで、
        // AppRun 共用型・専有型・HANAMII・他のプロジェクトの鍵には触れない（掟11）。
        //
        // **設定を渡せていないときは片づけない**（2026-09-24 検分の指摘10）。とくに公開名を
        // 変えて公開し直したときは 404→置き直し失敗になりうる。そこで古い鍵を消すと、
        // **前の名前で生き続けている Vercel のデプロイ**がデータの読み書きで 403 になり、
        // Koto から Vercel のプロジェクトは消せないので壊れたまま公開され続ける。
        // 残った古い鍵は、次に設定が渡せた公開で片づく。
        if (envDelivered) {
          try {
            await cleanUpOldKeysFor({ projectName: storage.projectName, target: 'vercel', keepId: storage.permissionId })
          } catch { /* 片づけに失敗しても公開は成立している（HANAMII・専有型と同じ） */ }
        }
      }
      return withDataLayerNote({ ok: true, deploymentId: info.id, url: info.url, readyState: info.readyState, ...(notice ? { notice } : {}) })
    } catch (e: any) {
      return withDataLayerNote({ ok: false, message: e?.message ?? String(e) })
    } finally {
      clearPendingFs(projectDir)
    }
    }, { target: 'vercel', handler: 'vercel:publish', secrets: [opts?.token] })
    return locked.busy ? { ok: false, message: projectBusyMessage(locked.running) } : locked.value
  })
}
