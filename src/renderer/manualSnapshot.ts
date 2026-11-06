// manualSnapshot.ts — 自分で編集して保存したときの履歴（🕘）の退避（renderer。React には依存しない）。
//
// AI の変更だけでなく、エディタで自分が書き換えた内容も「前の状態に戻す」の対象にする（これが無いと、時点復元のときに
// 自分の編集だけが退避されず消える）。オートセーブが1.5秒ごとに走るため1回ずつ履歴に積むと一覧が埋まる。
// 一定時間内の保存は同じ時点（スナップショット）にまとめる（同一ファイルの2回目以降は退避しない＝「編集を始める前」が残る）。
//
// そのため、外で書き換わったファイルを「自分の編集を保存する」で上書きするときは、先にグループを空にする。
// 空にしないと、外の版が同じ時点の2回目の退避になって残らない。

/** 保存をまとめる時間。この間の保存は同じ時点に入る。 */
export const MANUAL_SNAPSHOT_GROUP_MS = 5 * 60 * 1000

/** いまの時点（スナップショット）の印。dir は作った時のプロジェクト、at は最後に使った時刻。 */
export interface ManualSnapshotGroup { dir: string; id: string; at: number }

export interface ManualSnapshotDeps {
  /** いま開いているプロジェクト。無ければ退避しない。 */
  currentDir: string | null
  now(): number
  /** 書く前の中身を退避する口（`backup:snapshotBeforeWrite`）。 */
  snapshot(projectDir: string, id: string, rel: string, content: string, label: string): Promise<unknown>
}

/**
 * 保存の直前に、いまディスクにある中身を履歴へ退避する。プロジェクトの外のファイルは対象外。
 * 履歴の失敗で保存を止めない（投げない）。
 */
export async function snapshotBeforeManualSave(
  ref: { current: ManualSnapshotGroup | null },
  deps: ManualSnapshotDeps,
  filePath: string,
  content: string,
): Promise<void> {
  const { currentDir } = deps
  if (!currentDir || !filePath.startsWith(currentDir + '/')) return
  const rel = filePath.slice(currentDir.length + 1)
  const now = deps.now()
  const g = ref.current
  const id = g && g.dir === currentDir && now - g.at < MANUAL_SNAPSHOT_GROUP_MS
    ? g.id
    : new Date(now).toISOString().replace(/[:.]/g, '-')
  ref.current = { dir: currentDir, id, at: now }
  try {
    await deps.snapshot(currentDir, id, rel, content, '自分で編集して保存')
  } catch { /* 履歴の失敗で保存を止めない */ }
}
