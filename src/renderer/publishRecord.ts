// publishRecord.ts — 公開記録（.sakuraide.json の publish.targets）の読み書き。
//
// ── なぜ1箇所に集めるのか（2026-08-09）────────────────────────────────
// 「破棄したら公開記録も消す」処理が AppRunPanel と HanamiiPanel に別々に書かれていた。
// 破棄の導線を増やす（📡 公開したもの一覧・プロジェクト削除時）にあたって、
// 同じ処理が4箇所に増えるところだった。片方だけ直されて記録が残れば、
// **存在しない公開が一覧に出続ける**（v0.2.97 で直したのと同じ症状）。
//
// 判定そのもの（どの行を消すか）は shared/publishMeta.ts の純関数 withoutPublishTarget にある。
// **書き込みは main の1か所**（projectMeta.ts 経由。書く直前にディスクから読み直す）。
// ここは、消す依頼と、記録を読む側だけを受け持つ。

import type { PublishTargetKind } from './publishStatus'
import { forgetPublishTargetRecord } from './projectMeta'

/** プロジェクトの公開記録の置き場。 */
function metaPath(projectDir: string): string {
  return `${projectDir}/.sakuraide.json`
}

/**
 * 公開記録から、その公開先の行を消す（main が書く直前にディスクから読み直して消す・
 * src/renderer/projectMeta.ts。画面の古い写しで全体を書き戻さない）。
 *
 * 消すのは**その公開先の記録だけ**（判定は shared/publishMeta.ts の withoutPublishTarget）。
 * 専有型の資源ID（publish.apprunDedicated）・ほかの公開先・pending は残る。
 * ファイルが無い・壊れている場合は**何もしない**（消す記録が無いのと同じ・main 側で守る）。
 * 呼び出し側は破棄の成功後に呼ぶが、ここが失敗しても破棄自体は成功しているので、
 * 例外は投げずに握りつぶさない――呼び出し側で握ってもらう。
 */
export async function clearPublishRecord(projectDir: string, target: PublishTargetKind): Promise<void> {
  await forgetPublishTargetRecord(projectDir, target)
  // 開いている画面（③公開の一覧・ステータスバー）に反映させる
  window.dispatchEvent(new Event('sakura-meta-changed'))
}

/**
 * そのプロジェクトに残っている公開記録の公開先を返す（新しい順ではなく定義順）。
 * プロジェクトを削除する前に「何が公開されたままか」を見せるために使う。
 */
export async function readPublishTargets(projectDir: string): Promise<PublishTargetKind[]> {
  try {
    const meta = JSON.parse(await window.electronAPI.fs.readFile(metaPath(projectDir)))
    const targets = meta?.publish?.targets
    if (!targets || typeof targets !== 'object') return []
    const order: PublishTargetKind[] = ['hanamii', 'vercel', 'sakura-apprun', 'sakura-apprun-dedicated', 'sakura-rental']
    return order.filter(t => !!targets[t])
  } catch {
    return []
  }
}

/** HANAMII のプロジェクトID（破棄に必要）。無ければ null。 */
export async function readHanamiiProjectId(projectDir: string): Promise<string | null> {
  try {
    const meta = JSON.parse(await window.electronAPI.fs.readFile(metaPath(projectDir)))
    const id = meta?.publish?.hanamii?.projectId
    return typeof id === 'string' && id ? id : null
  } catch {
    return null
  }
}
