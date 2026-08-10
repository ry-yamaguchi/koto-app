// publishPending.ts — 公開開始マーカー（.sakuraide.json の publish.pending）の読み書き。
// 公開が途中で中断・失敗すると、Koto側は「未公開」のままなのに、さくら側では公開が完了している
// 可能性がある（実害が出るのは公開だけ。AIは書き込み済みファイルが残り、VPSはスクリプトが冪等なので
// 対象外）。これを後から検知できるよう、公開処理の開始時にマーカーを書き、終了時（成功/失敗いずれも）
// に消す。判定ロジック本体（detectInterruptedPublish）は publishStatus.ts の純粋関数側にある。
//
// 各公開パネル（AppRunPanel/HanamiiPanel/VercelPanel）の saveXxxMeta ヘルパーと同じ
// 「.sakuraide.json をマージ書き込みする」流儀を踏襲し、既存キーを消さないマージで
// publish.pending だけを読み書きする共通ヘルパーとしてここに1箇所で持つ。

import type { PublishTargetKind } from './publishStatus'

async function readMetaRaw(projectDir: string): Promise<any> {
  try {
    return JSON.parse(await window.electronAPI.fs.readFile(`${projectDir}/.sakuraide.json`))
  } catch {
    return {} // メタ無し（既存フォルダ等）
  }
}

/**
 * 公開開始マーカーを書く。公開処理の最初、実際の公開API呼び出しの直前に呼ぶこと。
 * 既存の publish.* の他のキー（targets 等）は消さない（マージ書き込み）。
 */
export async function markPublishPending(projectDir: string, target: PublishTargetKind): Promise<void> {
  const m = await readMetaRaw(projectDir)
  const next = {
    ...m,
    publish: {
      ...(m.publish ?? {}),
      pending: { target, startedAt: new Date().toISOString() },
    },
  }
  await window.electronAPI.fs.writeFile(`${projectDir}/.sakuraide.json`, JSON.stringify(next, null, 2))
}

/**
 * 公開開始マーカーを消す。公開処理の終了時（成功/失敗どちらでも）、必ず finally で呼ぶこと。
 * 既存の publish.* の他のキーは消さない（pending だけを取り除くマージ書き込み）。
 */
export async function clearPublishPending(projectDir: string): Promise<void> {
  const m = await readMetaRaw(projectDir)
  if (!m.publish || !('pending' in m.publish)) return // 既に無ければ何もしない
  const { pending: _pending, ...restPublish } = m.publish
  const next = { ...m, publish: restPublish }
  await window.electronAPI.fs.writeFile(`${projectDir}/.sakuraide.json`, JSON.stringify(next, null, 2))
}
