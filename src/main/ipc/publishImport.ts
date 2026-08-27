// publishImport.ts — 公開されているものをインポートする IPC（import:*）。
//
// ── なぜ要るか（dev-plan ④・2026-08-22 Ryosuke 提案）─────────────────────
// PC の消失・プロジェクトの引き継ぎ・引っ越しでは**手元にファイルが無い**。
// 公開されているものから中身を取り戻し、新しいプロジェクトとして受け入れる。
//
// 判断（平坦化・包みの剥がし・Git 由来の判定など）は shared/publishImport.ts の
// 純関数に置いてある。ここは**取得と書き込み**だけを受け持つ。
//
// ⚠️ 読むだけ。**公開先には何も作らない・何も消さない。**
import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { VercelClient } from '../vercel/client'
import { SakuraCloudClient } from '../cloud/client'
import { loadCredentials } from '../cloud/auth'
import { loadRegistryCredentials } from '../cloud/registry-auth'
import { cranePath } from '../cloud/imageBuild'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { IpcDeps } from './types'
import {
  flattenVercelTree, stripSingleRoot, isGitBacked, gitSourceHint,
  vercelCandidates, appRunCandidates, appRunImageRef, appRunSettings,
  pickImageContentRoot, importedFilePath, importedRelPathsFromTar, historyOriginSkipReason,
  type ImportCandidate, type FlatFile,
} from '../../shared/publishImport'
import { PUBLISH_DIR } from '../../shared/publishRoot'
import { snapshotCurrentFiles } from '../backup/store'
import { adoptedFiles, adoptionPreview } from '../cloud/adopt'

const run = promisify(execFile)

/** 引き継ぎで書く設定の置き場所（cloud.ts と同じ場所・同じ名前）。 */
const CLOUD_DIR = '.sakura-cloud'

/**
 * インポート先の中に閉じ込めてパスを作る（プロジェクトの外へは書かない）。
 * `src/main/ipc/cloud.ts` の `cloudFilePath` と同じ守り方。
 */
function cloudFileIn(destDir: string, file: string): string {
  const base = path.normalize(path.join(destDir, CLOUD_DIR))
  const full = path.normalize(path.join(base, file))
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error('不正なパスです（プロジェクトの外は操作できません）')
  }
  return full
}

/**
 * **引き継ぐ**——いま公開されているアプリを、このプロジェクトから更新できるようにする
 * （dev-plan ④ 第4段階）。書くのは `.sakura-cloud/` の2つだけ。
 *
 * ⚠️ **さくら側には何も送らない。** ここで書くのは手元の控えで、
 * 実際に切り替わるのは**次に公開したとき**。
 *
 * 引き継げなくてもインポート自体は成功している。**止めずに、理由を伝える。**
 */
function adoptAppRunApp(
  destDir: string, appName: string, appId: string,
  settings: ReturnType<typeof appRunSettings>, imageServer: string | null,
): { adopted: boolean; adoptNote: string | null } {
  // 中身の判断（何を書き写すか・検証）は cloud/adopt.ts。ここは**書くだけ**。
  const built = adoptedFiles({ appName, appId, settings, imageServer })
  if (!built.ok) return { adopted: false, adoptNote: built.reason }
  try {
    for (const f of built.files) {
      const full = cloudFileIn(destDir, f.rel)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, f.content, 'utf-8')
    }
    return { adopted: true, adoptNote: null }
  } catch (e: any) {
    return { adopted: false, adoptNote: `引き継ぎの設定を書けませんでした（${e?.message ?? String(e)}）。` }
  }
}

/** 進み具合をレンダラへ流す（取り込みは数十秒かかることがある）。 */
function notify(event: Electron.IpcMainInvokeEvent, message: string): void {
  try { event.sender.send('import:progress', { message }) } catch { /* 画面が閉じていても続ける */ }
}


/**
 * インポートした直後の姿を 🕘 履歴の起点として残す（**戻れる状態にしてから触らせる**）。
 *
 * 起点づくりに失敗してもインポート自体は成功している。**止めずに、伝える**。
 */
function makeHistoryOrigin(destDir: string, rels: string[]): { historySnapshotId: string | null; historyNote: string | null } {
  const skip = historyOriginSkipReason(rels.length)
  if (skip) return { historySnapshotId: null, historyNote: skip }
  const r = snapshotCurrentFiles(destDir, rels, '公開されていたものをインポートした時点')
  if (!r.ok || !r.snapshotId) {
    return { historySnapshotId: null, historyNote: `🕘 履歴の起点は作れませんでした（${r.message ?? '理由は分かりません'}）。` }
  }
  return { historySnapshotId: r.snapshotId, historyNote: null }
}

export function registerPublishImportHandlers(_deps: IpcDeps) {
  // ── 候補の一覧（読み取りのみ）────────────────────────────────────────
  ipcMain.handle('import:list', async (_e, args: { target: 'vercel' | 'sakura-apprun'; token?: string; teamId?: string }) => {
    try {
      if (args.target === 'vercel') {
        if (!args.token) return { ok: false, message: 'Vercel のトークンが未登録です' }
        const r = await new VercelClient({ token: args.token, teamId: args.teamId }).listDeployments()
        if (!r.ok) return { ok: false, message: `一覧を取得できませんでした（HTTP ${r.status}）` }
        const list: ImportCandidate[] = vercelCandidates((r.data as any)?.deployments ?? [])
        return { ok: true, candidates: list }
      }
      const creds = loadCredentials()
      if (!creds) return { ok: false, message: 'さくらのクラウドの認証情報が未登録です' }
      const r = await new SakuraCloudClient({ credentials: creds, dryRun: false }).listApps()
      if (r.dryRun !== false || !r.ok) return { ok: false, message: '一覧を取得できませんでした' }
      const data = (r.data as any)
      const apps = data?.data ?? data?.applications ?? (Array.isArray(data) ? data : [])
      return { ok: true, candidates: appRunCandidates(apps) as ImportCandidate[] }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  // ── 引き取れるかの下調べ（**取り込む前に、何が起きるかを見せる**）──────
  ipcMain.handle('import:inspect', async (_e, args: { target: 'vercel' | 'sakura-apprun'; id: string; token?: string; teamId?: string }) => {
    try {
      if (args.target === 'vercel') {
        if (!args.token) return { ok: false, message: 'Vercel のトークンが未登録です' }
        const c = new VercelClient({ token: args.token, teamId: args.teamId })
        const detail = await c.getDeploymentDetail(args.id)
        if (!detail.ok) return { ok: false, message: `詳細を取得できませんでした（HTTP ${detail.status}）` }
        // Git 由来なら、Vercel には組み立て後のものしか無い。**元を取りに行かせる**
        if (isGitBacked(detail.data)) {
          return { ok: false, gitBacked: true, message: gitSourceHint(detail.data) ?? 'Git から公開されています。' }
        }
        const tree = await c.getDeploymentFiles(args.id)
        if (!tree.ok) {
          return { ok: false, message: `このデプロイからは中身を取り出せませんでした（HTTP ${tree.status}）。` }
        }
        const flat = flattenVercelTree(Array.isArray(tree.data) ? tree.data as any : (tree.data as any)?.files)
        const { files, stripped } = stripSingleRoot(flat)
        return { ok: true, fileCount: files.length, stripped, files: files.map(f => f.path) }
      }

      const creds = loadCredentials()
      if (!creds) return { ok: false, message: 'さくらのクラウドの認証情報が未登録です' }
      const d = await new SakuraCloudClient({ credentials: creds, dryRun: false }).getApp(args.id)
      if (d.dryRun !== false || !d.ok) return { ok: false, message: '詳細を取得できませんでした' }
      const ref = appRunImageRef(d.data)
      if (!ref) return { ok: false, message: 'このアプリのイメージが分かりませんでした（コンテナレジストリ以外で作られた可能性があります）。' }
      const settings = appRunSettings(d.data)
      const appName = typeof (d.data as any)?.name === 'string' && (d.data as any).name
        ? String((d.data as any).name)
        : args.id
      return {
        ok: true,
        image: ref.image,
        settings,
        // **秘密は返ってこない**（実測）。入れ直しが要ることを画面で伝えるための印
        secretKeys: settings.secretKeys,
        // 引き継ぎの見立て（**押す前に**、URL と月額がどうなるかを言うため）。
        adopt: adoptionPreview({ appName, settings, imageServer: ref.server }),
      }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  // ── 取り込む（ここで初めてディスクへ書く）──────────────────────────
  ipcMain.handle('import:run', async (e, args: {
    target: 'vercel' | 'sakura-apprun'
    id: string
    /** 取り込み先（**空か、存在しないフォルダ**であること）。 */
    destDir: string
    token?: string
    teamId?: string
    /**
     * このあと何をしたいか。**`'update'` のときだけ引き継ぐ**（dev-plan ④ 第4段階）。
     *
     * 引き継ぐと `.sakura-cloud/state.json` にアプリIDが入り、次の公開が
     * **いま動いているアプリそのもの**を書き換えるようになる（破棄も本物に効く）。
     * 中を見たいだけの人が持つには重すぎるので、**選んだときだけ**書く。
     */
    intent?: 'update' | 'fork' | 'undecided'
  }) => {
    try {
      if (fs.existsSync(args.destDir) && fs.readdirSync(args.destDir).length > 0) {
        return { ok: false, message: 'その場所には既にファイルがあります。空のフォルダを選んでください。' }
      }
      const publishRoot = path.join(args.destDir, PUBLISH_DIR)
      fs.mkdirSync(publishRoot, { recursive: true })

      if (args.target === 'vercel') {
        if (!args.token) return { ok: false, message: 'Vercel のトークンが未登録です' }
        const c = new VercelClient({ token: args.token, teamId: args.teamId })
        notify(e, '公開されているファイルの一覧を調べています…')
        const tree = await c.getDeploymentFiles(args.id)
        if (!tree.ok) return { ok: false, message: `中身を取り出せませんでした（HTTP ${tree.status}）` }
        const flat = flattenVercelTree(Array.isArray(tree.data) ? tree.data as any : (tree.data as any)?.files)
        const { files, stripped } = stripSingleRoot(flat)
        if (!files.length) return { ok: false, message: '取り出せるファイルがありませんでした。' }

        const failed: string[] = []
        const written: string[] = []
        for (let i = 0; i < files.length; i++) {
          const f: FlatFile = files[i]
          notify(e, `ファイルを取り出しています…（${i + 1}/${files.length}）${f.path}`)
          const r = await c.getDeploymentFile(args.id, f.uid)
          if (!r.ok) { failed.push(f.path); continue }
          const b64 = typeof r.data === 'string' ? r.data : (r.data as any)?.data
          if (typeof b64 !== 'string') { failed.push(f.path); continue }
          const rel = importedFilePath(PUBLISH_DIR, f.path)
          const abs = path.join(args.destDir, rel)
          fs.mkdirSync(path.dirname(abs), { recursive: true })
          fs.writeFileSync(abs, Buffer.from(b64, 'base64'))
          written.push(rel)
        }
        notify(e, '🕘 いつでも戻れるように、いまの状態を控えています…')
        const origin = makeHistoryOrigin(args.destDir, written)
        return { ok: true, fileCount: written.length, failed, stripped, ...origin }
      }

      // ── AppRun: イメージを取り出して、公開物だけを取り込む ────────────
      const creds = loadCredentials()
      if (!creds) return { ok: false, message: 'さくらのクラウドの認証情報が未登録です' }
      const d = await new SakuraCloudClient({ credentials: creds, dryRun: false }).getApp(args.id)
      if (d.dryRun !== false || !d.ok) return { ok: false, message: '詳細を取得できませんでした' }
      const ref = appRunImageRef(d.data)
      if (!ref) return { ok: false, message: 'このアプリのイメージが分かりませんでした。' }

      const reg = loadRegistryCredentials()
      if (!reg?.password) {
        return { ok: false, message: 'コンテナレジストリの認証情報が見つかりません（認証情報の画面でご確認ください）。' }
      }
      const crane = cranePath()
      if (!crane || !fs.existsSync(crane)) return { ok: false, message: 'イメージを取り出す道具（crane）が見つかりません。' }

      notify(e, 'コンテナレジストリへ接続しています…')
      await run(crane, ['auth', 'login', ref.server, '-u', reg.user, '-p', reg.password])

      notify(e, '公開されているイメージを取り出しています…（少々時間がかかります）')
      const tarPath = path.join(args.destDir, '.koto-import.tar')
      await run(crane, ['export', ref.image, tarPath], { maxBuffer: 1024 * 1024 * 64 })

      notify(e, '中身を調べています…')
      const listed = await run('tar', ['-tf', tarPath], { maxBuffer: 1024 * 1024 * 256 })
      const names = listed.stdout.split('\n').filter(Boolean)
      const root = pickImageContentRoot(names)
      if (!root) {
        fs.rmSync(tarPath, { force: true })
        return { ok: false, message: 'イメージの中に、公開されている中身の場所が見つかりませんでした。' }
      }

      notify(e, '取り込んでいます…')
      await run('tar', ['-xf', tarPath, '-C', publishRoot, '--strip-components', String(root.split('/').length), root], { maxBuffer: 1024 * 1024 * 64 })
      fs.rmSync(tarPath, { force: true })

      const rels = importedRelPathsFromTar(names, root, PUBLISH_DIR)
      notify(e, '🕘 いつでも戻れるように、いまの状態を控えています…')
      const origin = makeHistoryOrigin(args.destDir, rels)

      // ── 引き継ぐ（選んだときだけ）────────────────────────────────────
      const settings = appRunSettings(d.data)
      let adopt: { adopted: boolean; adoptNote: string | null } = { adopted: false, adoptNote: null }
      if (args.intent === 'update') {
        notify(e, 'このアプリを、ここから更新できるようにしています…')
        // 名前は**実物から**取る（画面のフォルダ名ではない）。state のキーと
        // env.json の name は同じ正規化を通すこと（adopt.ts）。
        const appName = typeof (d.data as any)?.name === 'string' && (d.data as any).name
          ? String((d.data as any).name)
          : args.id
        adopt = adoptAppRunApp(args.destDir, appName, args.id, settings, ref.server)
      }
      return { ok: true, fileCount: rels.length, stripped: root, settings, ...origin, ...adopt }
    } catch (e2: any) {
      return { ok: false, message: e2?.message ?? String(e2) }
    }
  })
}
