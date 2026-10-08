// HANAMII（国産PaaS）連携の IPC（hanamii:*）。staticServerFiles / zipProjectToBuffer もここに移動。
// deps は使わない（トークンは方式B＝renderer が引数で渡す）。
import { app, ipcMain } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { execFile } from 'child_process'
import { HanamiiClient, extractProjectIds, extractProjectStatus, extractLogs, normalizeHealthCheck, hanamiiErrorMessage, type HanamiiEnv, type HanamiiHealthCheck, type HanamiiResult } from '../hanamii/client'
import { detectEnvKeysInProject } from '../envDetect'
import { issueStorageEnvFor, cleanUpOldKeysFor } from '../cloud/storageForTarget'
// 2026-09-25 検分: HANAMII の破棄でも保存場所を片づける。手順と守りは共用型・専有型と
// まったく同じ1つ（cloud/storageForTarget.ts → cloud/storageTeardown.ts）を通る。
// ここには新しい判断を書かない（掟10「一元定義」）。上の import 行はテストが文字列で
// 固定しているため、別行で足す（apprunDedicated.ts と同じ理由）。
import { storagePlacementsOf, teardownStorageForProject, forgetDeletedBuckets, revokeIssuedKey } from '../cloud/storageForTarget'
import { loadCredentials } from '../cloud/auth'
import type { IpcDeps } from './types'
import { zipExcludePatterns, BUILD_CONFIG_FILES } from '../../shared/publishExclude'
import { resolvePublishRoot } from '../publishRootFs'
import { ensureDataLayer } from '../dataLayer'
// koto-data を差し替えたときの1行（文面は共用型・Vercel・専有型と同じ一元定義を通す・掟10）。
import { dataLayerUpdateLine } from '../../shared/storageNoticeText'
import { markPendingFs, clearPendingFs, writePublishRecordFs, writeHanamiiProjectIdFs, readHanamiiProjectIdFs } from '../publishMetaFs'
import { readPublishedAtFs } from '../publishMetaFs'
// 破棄が成功したあとの記録の片づけ（main の1か所）。上の import 行はテストが文字列で固定しているため、別行で足す。
import { settleHanamiiTeardownFs } from '../publishMetaFs'
import { withProjectLock, projectBusyMessage } from '../projectLock'
// 進捗の送り口は1つ（記録の更新を兼ねる）。公開のあと（動いたと確かめる）は hanamii/aftercare.ts。2026-09-29
import { progressReporter } from '../projectOps'
import { waitForNewVersion, type NewVersionOutcome } from '../hanamii/aftercare'

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

/**
 * HANAMII の破棄の結果（`hanamii:teardown` が返すもの）。
 *
 * **`appDeleted` を落とさないこと。** HANAMII のプロジェクトは消えたのに保存場所だけ
 * 片づかなかったとき、`ok:false` だけを返すと画面は「破棄できませんでした」と出し、
 * 公開の記録も残る＝**存在しない公開が一覧に並び続ける**（専有型の指摘4・9・13 と同じ形）。
 */
export type HanamiiTeardownResult = {
  ok: boolean
  /** HANAMII のプロジェクトを削除できたか（保存場所だけ失敗しても true）。 */
  appDeleted?: boolean
  /** 片づけたこと・片づけ切れなかったことの一覧（画面にそのまま出す・**黙らない**）。 */
  executed?: string[]
  /** まだ残っている保存場所の名前（**消すまで月額が続く**）。先頭の1件。 */
  remainingBucket?: string
  /**
   * まだ残っている保存場所の名前を**全部**（2026-09-25 検分の指摘5）。
   * 破棄は同意済みの保存場所を全件片づけるので、残りも全件言わないと
   * **名前が一度も出なかった保存場所の月額が、黙って続く**。
   */
  remainingBuckets?: string[]
  /**
   * **片づけたのに、バケットごとは消さなかった**保存場所（利用者が自分で置いたファイルがある・ほかのプロジェクトが
   * 使っている）の名前。先頭の1件。**残れば月額も続く**（共用型の `cloud:teardown` の `keptBucketName` と同じ事実）。
   * これが無いと、この回は `ok:true` のまま「片づけました — …残します」の1行が executed に入るだけで、警告にならなかった。
   */
  keptBucketName?: string
  /** 同じ事実の全件（複数の保存場所を片づけたとき、名前が出なかった分の月額が黙って続かないように）。 */
  keptBucketNames?: string[]
  message?: string
}

/** バケットごとは消さなかった保存場所の名前（片づけの結果 `done` から。事実だけを返す）。 */
function keptBucketFields(done: ReadonlyArray<{ bucket: string; deletedBucket: boolean }>): Pick<HanamiiTeardownResult, 'keptBucketName' | 'keptBucketNames'> {
  const kept = done.filter(b => !b.deletedBucket).map(b => b.bucket)
  return kept.length > 0 ? { keptBucketName: kept[0], keptBucketNames: kept } : {}
}

/** 保存場所の名前を画面の文に並べる（『A』『B』）。Markdown 記法は使わない（掟5）。 */
function bucketNames(buckets: string[]): string {
  return buckets.map(b => `『${b}』`).join('')
}

/**
 * 片づけ残りがあるときに、**どうすれば止められるか**を添える（2026-09-25 検分の指摘3）。
 *
 * 前は「もう一度 🗑 を押してください」とだけ案内していたのに、
 *   ・📡 公開したもの一覧は、押し直す 🗑 の行を消していた（記録を片づけていた）
 *   ・仮に行が残っても、2度目の破棄は HANAMII の DELETE が 404 で止まり、保存場所へ進めなかった
 * ＝**案内した導線がどこにも無かった**（manualTeardownGuide の Vercel と同じ轍）。
 *
 * いまは押し直せる: `hanamii:teardown` は「HANAMII のプロジェクトがもう無い（404）」なら
 * 保存場所の片づけだけを続け、📡 一覧は片づけ残りがある間は記録を残す。
 * それでも直らないとき（env.json が壊れている等）のために、**コントロールパネルの手順も添える。**
 */
const RETRY_GUIDE = 'もう一度 🗑 を押すと、保存場所の片づけだけをやり直します'
  + '（片づけ残りがあるあいだ、📡 公開したもの一覧にはこの行を残します）。'
  + 'やり直しても消えないときは、さくらのクラウドのコントロールパネル（オブジェクトストレージ）から削除してください。'

/**
 * HANAMII の破棄の最後に、**保存場所も片づける**（2026-09-25 検分）。
 *
 * ── なぜ要るか ────────────────────────────────────────────────────
 * 📡 公開したもの一覧の確認オーバーレイは、HANAMII でも
 * 「保存場所『X』にある、このプロジェクトのデータも削除します…この保存場所を使っている
 * プロジェクトがほかに無ければ、保存場所そのものも削除して月額を止めます」と言い切る
 * （`teardownDataNoteFor` ／ `teardownRemovesStorage('hanamii','list')` が true）。
 * ところが実物は HANAMII のプロジェクトを消すだけで、**バケットも、その中のデータも、
 * 鍵（`koto-<名前>-hanamii`）も1件も消していなかった。** 画面が「月額を止めます」と
 * 言い切った後なので利用者はコントロールパネルを確認せず、**月額495円が止まらないまま、
 * 消したはずのアプリの鍵がバケットへ読み書きできるまま生き残る**（共有バケットなら
 * ほかのプロジェクトのデータにも届く）。専有型の⑥で直したのとまったく同じ形である。
 *
 * ── 順序（専有型 `teardownProjectStorage` と同じ）────────────────────
 * **先に HANAMII のプロジェクトを消し、そのあとで保存場所を片づける。** 先に鍵とデータを
 * 消すと、**まだ動いているアプリが 403 で落ちる**（2026-08-14 に共用型で実際に起きた形）。
 * 逆に、保存場所が片づかないことを理由にプロジェクトの削除を止めると、**月額の課金だけが残る**。
 *
 * ── ここに判断を書かないこと（掟10）─────────────────────────────────
 * 「一覧できなければ中止する」「バケットごと消してよいか（`teardownPlanFor`）」「鍵は
 * バケットのあと」は、すべて cloud/storageTeardown.ts の1つに集めてある。ここは
 * 「置き場所を読んで渡し、結果を画面の言葉に直す」だけ。
 *
 * 鍵のIDは HANAMII の記録に残していない（共用型の `state.meta.storagePermissionId`・
 * 専有型の `storagePermissionId` に当たるものが無い）ので `permissionId` は null で渡し、
 * **`sweepKeysFor: 'hanamii'` で「この公開先の名前の鍵を全部」無効にする**（検分の指摘6 と
 * 同じ手）。この時点で HANAMII のプロジェクトは消えている＝現役の鍵は存在しないので、
 * storageKeys.ts の「現役が分からないときは消さない」規則とは矛盾しない。
 * 名前は完全一致で見るので、共用型・専有型・ほかのプロジェクトの鍵には触れない（掟11）。
 */
async function teardownHanamiiStorage(projectDir: string): Promise<HanamiiTeardownResult> {
  // ここへ来た時点で HANAMII のプロジェクトは消えている。以降どう転んでも、
  // **消えたという事実は落とさない**（呼び出し側が公開の記録を片づけられるように）。
  const done: HanamiiTeardownResult = { ok: true, appDeleted: true, executed: [] }
  // env.json が壊れていても、例外を IPC の外へ出さない（専有型の指摘12・14・15 と同じ）。
  // storagePlacementsOf → readSpec は JSON.parse を素で呼ぶので、壊れていれば throw する。
  let placements: ReturnType<typeof storagePlacementsOf>
  try {
    placements = storagePlacementsOf(projectDir)
  } catch (e: any) {
    return {
      ...done, ok: false,
      // ここだけはバケット名を出せない（名前の記録そのものが読めない）。**無い導線を案内しない**ので、
      // 押し直しではなくコントロールパネルで確かめてもらう（検分の指摘3）。
      message: `保存場所の設定を読めないため、保存場所は片づけていません（消すまで月額が続きます）: ${e?.message ?? String(e)}`
        + '\nさくらのクラウドのコントロールパネル（オブジェクトストレージ）で、残っている保存場所を確かめて削除してください。',
    }
  }
  // 保存場所を使っていないプロジェクトでは、何も言わない・何も呼ばない。
  if (placements.length === 0) return done
  // **残りは全件名指しする**（検分の指摘5）。1件だけ名指しすると、名前が出なかった保存場所の
  // 月額が黙って続く（確認画面も全件を名指ししている＝そこと揃える）。
  const allNames = bucketNames(placements.map(p => p.bucket))
  const allBuckets = placements.map(p => p.bucket)
  // さくらのクラウドの認証情報は main がファイルで持っている（cloud/auth.ts）。**公開のときに
  // `issueStorageEnvFor` が `loadCredentials()` で読んでいるのとまったく同じ経路**にする
  // ——鍵を発行した側と片づける側で出所を変えない。HANAMII のトークン（方式B・renderer が
  // 引数で渡すもの）とは別物なので、ここで renderer から受け取り直さない。
  const creds = loadCredentials()
  if (!creds) {
    return {
      ...done, ok: false, remainingBucket: placements[0].bucket, remainingBuckets: allBuckets,
      message: `さくらのクラウドのAPIキーが未登録のため、保存場所${allNames}は片づけていません（消すまで月額が続きます）。`
        + `「認証情報」でAPIキーを登録してから、${RETRY_GUIDE}`,
    }
  }
  let st: Awaited<ReturnType<typeof teardownStorageForProject>>
  try {
    st = await teardownStorageForProject({ creds, projectDir, permissionId: null, sweepKeysFor: 'hanamii' })
  } catch (e: any) {
    return {
      ...done, ok: false, remainingBucket: placements[0].bucket, remainingBuckets: allBuckets,
      message: `保存場所${allNames}を片づけられませんでした（消すまで月額が続きます）: ${e?.message ?? String(e)}`
        + `\n${RETRY_GUIDE}`,
    }
  }
  if (st.reason === 'none') return done
  const executed = [
    ...st.done.map(b => `保存場所『${b.bucket}』を片づけました — ${b.note}`),
    ...st.warnings.map(w => `⚠️ ${w}`),
  ]
  // **バケットごと消したものは、env.json の記録からも外す**（専有型の指摘3・8 と同じ）。
  // 残すと画面は「用意済み」のまま、次の公開が**消えたバケット宛ての鍵**を渡して成功扱いになる。
  const deletedBuckets = st.done.filter(b => b.deletedBucket).map(b => b.bucket)
  if (deletedBuckets.length > 0 && !forgetDeletedBuckets(projectDir, deletedBuckets)) {
    executed.push('⚠️ 保存場所の記録（公開の設定・env.json）は残しています。次に公開する前に、③「保存場所を用意する」からやり直してください')
  }
  if (!st.ok) {
    // HANAMII のプロジェクトは消えている（そのぶんは止まった）が、保存場所は残った。**黙らない。**
    // 途中で止まったので、**片づいた分の後ろにある保存場所も丸ごと残っている**。
    // 残りは全件名指しする（検分の指摘5。1件だけ名指しすると、出なかったぶんの月額が黙って続く）。
    const doneBuckets = new Set(st.done.map(b => b.bucket))
    const remaining = allBuckets.filter(b => !doneBuckets.has(b))
    return {
      ...done, ok: false, executed, remainingBucket: st.remainingBucket, remainingBuckets: remaining,
      ...keptBucketFields(st.done),
      message: st.message
        + (remaining.length > 0 ? `\n保存場所${bucketNames(remaining)}が残っています（消すまで月額が続きます）。${RETRY_GUIDE}` : ''),
    }
  }
  return { ...done, executed, ...keptBucketFields(st.done) }
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
  '画面が持っている HANAMII のプロジェクトが、このプロジェクトの記録と一致しません（別のプロジェクトの画面から引き継がれた可能性があります）。'
  + '何も公開していません。公開のダイアログを閉じて開き直してから、もう一度お試しください。'
export const PROJECT_MISMATCH_TEARDOWN =
  '破棄しようとした HANAMII のプロジェクトが、このプロジェクトの記録が指すものと一致しません（別のプロジェクトの画面から引き継がれた可能性があります）。'
  + '何も削除していません。公開のダイアログを閉じて開き直してから、もう一度お試しください。'

/** 待った時間を画面の文にする（90秒未満は秒、それ以上は約N分）。 */
function waitedText(sec: number): string {
  return sec < 90 ? `${Math.max(1, sec)}秒` : `約${Math.round(sec / 60)}分`
}

/**
 * HANAMII の公開の**後段**（2026-09-29）: 依頼が受け付けられたあと、**画面に依らずに**最後まで進める。
 *
 *   ① 新しい版が動いた（READY）と確かめる（aftercare.ts の waitForNewVersion。今回の deployment の id で見る）
 *   ② 確かめられたら、公開記録の url を書く
 *   ③ 確かめられたら、**そのあとで**古い保存場所の鍵を片づける
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
  const { storagePermissionId, storageProjectName, ...rest } = requested
  const hasKey = !!(storagePermissionId && storageProjectName)
  const keepNote = hasKey ? '保存場所の古い鍵は、動いたと確かめられるまで消さずに残しています。' : ''
  const keepKeys = hasKey ? { storagePermissionId, storageProjectName } : {}
  const client = new HanamiiClient({ token: args.token })

  progress('⏳ HANAMII が新しい版を起動するのを待っています…')
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
    const warnings: string[] = []
    let keysDone = !hasKey
    if (hasKey) {
      progress('🧹 保存場所の古い鍵を片づけています…')
      try {
        await cleanUpOldKeysFor({ projectName: storageProjectName!, target: 'hanamii', keepId: storagePermissionId! })
        keysDone = true
      } catch {
        warnings.push('保存場所の古い鍵を片づけられませんでした（新しい版が動いていることは確かめられています）。次に動いたと確かめられた公開で、もう一度片づけます。')
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
      message: `HANAMII が新しい版を起動できませんでした${outcome.errorCode ? `（エラーコード: ${outcome.errorCode}）` : ''}。`
        + (args.redeployed ? '前の版が動き続けている場合があります。' : '')
        + `HANAMII の管理画面でログを確かめてください。${keepNote}`,
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
          ? `HANAMII の新しい版が、待った時間（${waited}）のうちには動きませんでした（状態: ${outcome.readyState}）。まだ動いていません。HANAMII の管理画面で状態を確かめてください。${keepNote}`
          : `新しい版が動いたかを、待った時間（${waited}）のうちには確かめられませんでした。HANAMII の管理画面で状態を確かめてください。${keepNote}`,
      ],
      ...keepKeys,
    }
  }

  return {
    ...rest, deployState: 'unknown',
    warnings: [`新しい版が動いたかを確かめられませんでした（${outcome.message}）。HANAMII の管理画面で状態を確かめてください。${keepNote}`],
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
        return withDataLayerNote({ ok: false, message: 'HANAMII で公開できる形になっていません。静的サイトなら index.html を、アプリなら package.json 等（package.json / requirements.txt / pyproject.toml / composer.json）を用意してください。' })
      }
      progress('☁️ HANAMII へアップロードしています…')
      const up = await client.createUpload(opts.workspaceId, `${opts.name || 'app'}.zip`)
      if (!up.ok) return withDataLayerNote({ ok: false, message: `アップロード枠の作成に失敗しました（HTTP ${up.status}）${reason(up.data)}`, detail: dbg(up.data) })
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
        progress('🔑 保存場所の鍵を用意しています…')
        const st = await issueStorageEnvFor({ projectDir, target: 'hanamii' })
        if (!st.ok) {
          // 「保存場所が無い」だけなら黙って続ける（使っていないアプリもある）
          if (st.reason === 'error') return withDataLayerNote({ ok: false, message: st.message })
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
      })
    } catch (e: any) { return withDataLayerNote({ ok: false, message: e?.message ?? String(e) }) }
    finally { clearPendingFs(projectDir) }
    })()
    // 依頼が通らなかった（token 無し・ZIP 失敗・API 失敗…）／プロジェクトの番号が読めなかったときは、後段へ進まない。
    if (!requested.ok || !requested.projectId) return requested
    // ── 後段: 画面に依らず、新しい版が動いたと確かめるまで進める（古い鍵は READY を確かめてから消す）──
    return finishHanamiiPublish({ projectDir, token: opts.token, requested, redeployed, progress })
    }, { target: 'hanamii', handler: 'hanamii:publish', secrets: [opts?.token] })
    return locked.busy ? { ok: false, message: projectBusyMessage(locked.running) } : locked.value
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
  /**
   * HANAMII の破棄。**プロジェクトを消したあと、保存場所も片づける**（2026-09-25 検分）。
   *
   * `projectDir` は保存場所（`.sakura-cloud/env.json`）を読むために要る（掟6 の3点セットで
   * preload・global.d.ts にも足してある）。**渡らなかったときに「片づけたふり」をしない**：
   * 何も消さずに `ok:true` を返すのは、確認画面が「保存場所も削除します」と言った経路
   * （📡 公開したもの一覧）では嘘になる——なので 📡 からは必ず渡す
   * （tests/teardownSupport.test.ts が呼び出しの形を固定している）。
   *
   * 保存場所の片づけは `teardownHanamiiStorage`（上）。順序・守り・返す形の理由はそこに書いた。
   */
  ipcMain.handle('hanamii:teardown', async (_, projectId: string, token: string, projectDir?: unknown): Promise<HanamiiTeardownResult> => {
    if (!token) return { ok: false, message: 'HANAMII のトークンが未登録です' }
    // 進み具合は処理の記録へ通す（projectOps.ts の1つの送り口）。projectDir が無い呼び出しは記録の対象外。
    const progress = progressReporter(typeof projectDir === 'string' ? projectDir : '')
    // 破棄の本体。下で、プロジェクト単位の鍵（公開・ほかの破棄と同時に走らせない）の中で走らせる。
    const run = async (): Promise<HanamiiTeardownResult> => {
    // ── 渡された projectId は、このプロジェクトの記録が指すものと一致するときだけ消す（2026-09-30 検分・掟11）──
    // 画面が別のプロジェクトの projectId を持ち越したまま 🗑 を押すと、**別のプロジェクトの稼働中の HANAMII アプリを消し**、
    // しかもここは 404 でも「もう無い」として、いまの projectDir の保存場所まで片づけていた（settleHanamiiTeardownFs の
    // 照合が守るのは記録だけで、消すことそのものは止めなかった）。食い違うなら、何も呼ばずに断る。
    // すべての呼び出し（③公開の 🗑・📡 一覧・プロジェクト削除）は、この記録から projectId を読んで渡すので、正しい呼び出しは通る。
    // 鍵（withProjectLock）の中で読むので、同じプロジェクトの公開が記録を書き換えている最中には見ない。
    if (typeof projectDir === 'string' && projectDir && readHanamiiProjectIdFs(projectDir) !== projectId) {
      return { ok: false, message: PROJECT_MISMATCH_TEARDOWN }
    }
    // 通信そのものが失敗したら例外を IPC の外へ出さない（③公開の 🗑 は結果を待つだけで
    // catch を持たないので、投げると確認ダイアログが開いたまま固まる）。
    let r: HanamiiResult
    progress('🗑 HANAMII のプロジェクトを削除しています…')
    try {
      r = await new HanamiiClient({ token }).deleteProject(projectId)
    } catch (e: any) {
      return { ok: false, message: `削除に失敗しました: ${e?.message ?? String(e)}` }
    }
    // ── もう無いものは「消えている」として扱う（2026-09-25 検分の指摘3）────────────
    // 保存場所だけ片づかなかったとき、画面は「もう一度 🗑 を押してください」と案内する。
    // ところが2度目の破棄はここで 404 になり、**保存場所へは一生進めなかった**
    // ＝案内した導線がどこにも無い。HANAMII が「そんなプロジェクトは無い」と言っている以上、
    // **動いているアプリはもう無い**＝鍵を消しても 403 で落ちるものが無いので、片づけへ進めてよい
    // （共用型 apply.ts の削除も `res.status !== 404` で同じ扱いをしている）。
    const gone = r.ok || r.status === 404
    // **消せていないうちは保存場所に触らない**（アプリがまだ動いている＝鍵を消すと 403 で落ちる）。
    if (!gone) return { ok: false, message: `削除に失敗しました（HTTP ${r.status}）` }
    // プロジェクトフォルダが分からない呼び出しでは、保存場所には触れない（**片づけたふりをしない**）。
    // 2026-09-25 検分の指摘1・2: ③公開の HanamiiPanel・プロジェクト削除の Sidebar も
    // projectDir を渡すようになったので、いま `projectDir` 無しで呼ぶ画面は Koto に無い。
    // それでも**任意の引数**である以上、渡し忘れても型検査は通る。だからここは
    // 「何も消していない」と正直に返し、呼び出し側は tests/teardownSupport.test.ts が
    // 呼び出しの形（3つの入口すべてが渡していること）を固定している。
    if (typeof projectDir !== 'string' || !projectDir) return { ok: true, appDeleted: true, executed: [] }
    progress('🗄️ 保存場所を片づけています…')
    const res = await teardownHanamiiStorage(projectDir)
    // 保存場所まで片づいたら、**ここ（main・鍵の中）で**記録も片づける（2026-09-30）。
    // 以前は画面が「破棄の結果を初めて見たとき」に片づけていたが、画面は記録を再生する（閉じて開き直すと、
    // 見られていない古い破棄の結果をもう一度「初めて見た」と扱う）ので、その後に公開し直した
    // 新しいプロジェクトの記録まで消して、二重に作られた。消したそのときに1回だけ、main が行う。
    // 保存場所だけ残った回（ok:false）は、押し直せる入口（🗑）と記録を残す。
    if (!res.ok) return res
    const settled = settleHanamiiTeardownFs(projectDir, projectId)
    if (settled.ok) return res
    return {
      ...res,
      executed: [
        ...(res.executed ?? []),
        `⚠️ 公開の記録を片づけられませんでした。📡 公開したもの一覧に、もう無い公開が残っているときは「記録を片づける」で消してください: ${settled.message}`,
      ],
    }
    }
    // 同じプロジェクトの公開・ほかの破棄と同時に走らせない（2026-09-29・src/main/projectLock.ts）。
    // 断ったときは**外部の API を1件も呼ばない**（HANAMII の削除にも入らない）。
    // projectDir が無い呼び出し（いま Koto の画面には無い）は、鍵を掛ける相手が分からないので
    // そのまま走らせる（保存場所には触れない経路＝上の run の中で「片づけたふり」もしない）。
    if (typeof projectDir !== 'string' || !projectDir) return run()
    const locked = await withProjectLock(projectDir, '削除', run, { target: 'hanamii', handler: 'hanamii:teardown', secrets: [token] })
    return locked.busy ? { ok: false, message: projectBusyMessage(locked.running) } : locked.value
  })

  ipcMain.handle('hanamii:detectEnvKeys', async (_, projectDir: string) => {
    try {
      if (!projectDir) return { ok: false, keys: [] as string[] }
      // 送るのは`public/` の中身なので、キーもそこから探す。
      return { ok: true, keys: detectEnvKeysInProject(resolvePublishRoot(projectDir)) }
    } catch (e: any) { return { ok: false, keys: [] as string[], message: e?.message ?? String(e) } }
  })
}
