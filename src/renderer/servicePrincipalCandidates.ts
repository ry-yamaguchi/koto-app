// servicePrincipalCandidates.ts（renderer）— ②で「前のプロジェクトで使った ID」を読み出す入口。
//
// 読むだけ（ファイルへは何も書かない）。プロジェクトを置くフォルダ（getWorkspaceDir・📡 公開したもの
// 一覧と同じ）の全プロジェクトの記録を、既存の `fs:publishedRecords`（main）で読み、
// 集めて・まとめて・並べる処理は純関数（src/shared/servicePrincipalCandidates.ts）に任せる。
//
// 掟11（環境の独立）との関係は純関数側の冒頭に書いた（サービスプリンシパルは「さくらのクラウドのプロジェクトの資源」で
// Koto のプロジェクトの中身ではない・作者の決定 2026-10-06・出すのは ID とプロジェクト名だけ）。

import {
  collectServicePrincipalCandidates,
  needsServicePrincipalCandidates,
  planServicePrincipalPrefill,
  type ServicePrincipalCandidate,
  type ServicePrincipalPrefillPlan,
} from '../shared/servicePrincipalCandidates'
import { getWorkspaceDir } from './workspace'

/** テストで差し替える入出力（既定は preload の window.electronAPI と localStorage）。 */
export interface CandidateIo {
  workspaceDir: () => Promise<string>
  publishedRecords: (workspaceDir: string) => Promise<{ ok: boolean; projects: unknown }>
}

const defaultIo: CandidateIo = {
  workspaceDir: getWorkspaceDir,
  publishedRecords: (dir) => window.electronAPI.fs.publishedRecords(dir),
}

/**
 * 現在のプロジェクト以外の全プロジェクトの記録から、サービスプリンシパルIDの候補を新しい順に返す。
 * 読めなかったとき（ワークスペースが読めない・IPC の失敗）は空配列＝候補なし（②はいまと同じ空の欄になる）。
 * 候補は便宜であって、②の入力そのものを止めてはならない。
 */
export async function loadServicePrincipalCandidates(
  projectDir: string,
  io: CandidateIo = defaultIo,
): Promise<ServicePrincipalCandidate[]> {
  try {
    const dir = await io.workspaceDir()
    const r = await io.publishedRecords(dir)
    if (!r.ok) return []
    return collectServicePrincipalCandidates(r.projects, projectDir)
  } catch {
    return []
  }
}

/**
 * ②を開いたときに、欄へ何を入れ、何を候補として出すかを決める。**読むだけ**（書き込みの口を持たない。
 * 開いただけでファイルへ書くと 'sakura-meta-changed' → 状態の取り直しが走る・2026-09-23 検分の指摘6）。
 *
 * `savedId` はこのプロジェクトの記録にある ID。**記録に ID があれば、ほかのプロジェクトの記録は読みにも行かず**、
 * 何も出さない・何も入れない（記録がこのプロジェクトの正）。無いときだけ探して、候補が
 * 0 件なら何もしない・1 件ならそれを入れる・複数なら一覧で選べるようにし先頭（いちばん新しい）を入れる。
 */
export async function resolveServicePrincipalPrefill(
  projectDir: string,
  savedId: string | null | undefined,
  io: CandidateIo = defaultIo,
): Promise<ServicePrincipalPrefillPlan> {
  if (!needsServicePrincipalCandidates(savedId)) return { candidates: [], fillId: null }
  return planServicePrincipalPrefill(savedId, await loadServicePrincipalCandidates(projectDir, io))
}
