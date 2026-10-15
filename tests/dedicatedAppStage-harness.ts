import { attemptDeleteApplication, type TeardownFlowOpts, type TeardownFlowResult } from '../src/main/cloud/apprunDedicatedApply'
import { readApprunDedicatedFs } from '../src/main/publishMetaFs'

/**
 * **アプリの段だけ**を取り出して実行する（アプリ → LB → ASG → クラスタの流れのうち、先頭の段）。テスト専用。
 *
 * 2026-10-08 までは `teardownFlow(..., { appOnly: true })` がこの役目だった（📡 の🗑がアプリだけを消す口）。
 * その口は廃止した（手順6も📡の🗑も、アプリ → LB → ASG → クラスタ ＋ 保存場所の同じ流れ）が、アプリの段そのものの
 * 振る舞い（無効化・コンテナの待ち・400の待ち直し・404の確かめ・段の切り替わり）は変わらない。それを LB/ASG/クラスタの
 * ルートを足さずに確かめるため、段の関数を直接呼ぶ。成功したときの返り値は、旧 appOnly の成功時と同じ形。
 *
 * 記録にアプリ（applicationID）とクラスタ（clusterID）がある前提（無ければ段の関数に undefined を渡してしまうので、
 * テストの準備が足りない——ここで落とす）。
 */
export async function appStageOnly(
  auth: { token: string; secret: string }, projectDir: string, opts: TeardownFlowOpts, baseUrl: string,
): Promise<TeardownFlowResult> {
  const record = readApprunDedicatedFs(projectDir)
  if (!record.applicationID || !record.clusterID) throw new Error('appStageOnly: 記録に applicationID と clusterID が要ります')
  const executed: string[] = []
  const stop = await attemptDeleteApplication(auth, projectDir, record.clusterID, record.applicationID, opts, baseUrl, executed)
  return stop ?? { ok: true, executed, message: 'アプリケーションの削除の要求は受け付けられ、一覧から消えたことを確認しました。', remaining: {} }
}
