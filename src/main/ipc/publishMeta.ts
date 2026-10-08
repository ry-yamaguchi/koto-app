// 公開の記録（<projectDir>/.sakuraide.json）を renderer から更新する IPC（publishMeta:*）。
//
// ── なぜ IPC にするか（2026-09-29・掟10の一元化）────────────────────────────
// 以前は renderer の各画面が .sakuraide.json を自分で読み、マージし、全体を書き戻していた。
// とくに PublishModal は**開いたときの写し**で全体を書き戻し、ダイアログを開いている間に main が
// 書いた記録（専有型の資源ID など）を消した（専有型のクラスタの記録が消えると⑥で破棄できず、
// 月額22,000円が止められない）。読み直して当てて書く処理は main の
// `mergeMetaPatchFs`（src/main/publishMetaFs.ts）1か所に置き、renderer は**差分だけ**を渡す。
// renderer 側の入口は src/renderer/projectMeta.ts（掟6: main／preload.ts／global.d.ts の3点セット）。
import { ipcMain } from 'electron'
import * as path from 'path'
import { mergeMetaPatchFs, forgetPublishTargetFs, dismissInterruptedPublishFs } from '../publishMetaFs'
import { runningOp } from '../projectLock'
import type { PublishTargetKind } from '../../shared/publishMeta'

const BAD_DIR = { ok: false as const, message: 'プロジェクトフォルダが不正です' }

function isProjectDir(x: unknown): x is string {
  return typeof x === 'string' && x !== '' && path.isAbsolute(x)
}

export function registerPublishMetaHandlers(): void {
  // 差分（patch）を、書く直前にディスクから読み直した記録へ当てて書く。
  // 戻り値の meta は書いた結果の全体（画面が自分の表示用の写しを更新するのに使う）。
  ipcMain.handle('publishMeta:merge', (_, projectDir: unknown, patch: unknown) => {
    if (!isProjectDir(projectDir)) return BAD_DIR
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false as const, message: '更新の内容が不正です' }
    return mergeMetaPatchFs(projectDir, patch)
  })

  // 「記録を片づける」: その公開先の記録だけを消す（専有型の資源ID・ほかの公開先・pending は残す）。
  ipcMain.handle('publishMeta:forgetTarget', (_, projectDir: unknown, target: unknown) => {
    if (!isProjectDir(projectDir)) return BAD_DIR
    if (typeof target !== 'string' || !target) return { ok: false as const, message: '公開先が不正です' }
    return forgetPublishTargetFs(projectDir, target as PublishTargetKind)
  })

  // 「確認しました」: 中断の可能性の印（publish.pending）を消す。公開が走っているあいだは消さない。
  ipcMain.handle('publishMeta:dismissInterrupted', (_, projectDir: unknown) => {
    if (!isProjectDir(projectDir)) return BAD_DIR
    return dismissInterruptedPublishFs(projectDir)
  })

  // いま main が走らせている操作（'作成' | '削除' | '公開'）。走っていなければ null。
  // 公開の画面が「中断された可能性」と「いま進んでいます」を出し分けるのに使う（main の鍵が唯一の答え）。
  //
  // ── projectOps:get との関係（2026-09-29）──────────────────────────────────
  // **同じ記録から答える**（`runningOp` は projectOps.ts の「走っている記録」の操作名を返すだけ。
  // 「走っているか」を2か所で持たない）。残してあるのは、公開の画面（projectMeta.ts の
  // loadPublishSnapshot・PublishModal）がこの名前で読んでいるため。画面が `projectOps:get` の
  // `running.op` へ移り終えたら、この IPC は3点セットごと消してよい（掟6）。
  ipcMain.handle('publishMeta:runningOp', (_, projectDir: unknown) => {
    if (!isProjectDir(projectDir)) return null
    return runningOp(projectDir) ?? null
  })
}
