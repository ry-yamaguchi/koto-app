// フォルダの整理（移行）を始める前の確認と、整理のあとの後始末の順序（0.6.26）。
// 整理が終わるとタブはすべて閉じる（古い場所を指したまま保存で復活させないため）。
// 画面の中だけにある編集（保存を止めたタブのもの）はそのとき消えるので、
// 動かす前に、プロジェクトを切り替えるときと同じ口（保存 → 確認）を通す。断られたら何も動かさない。

export interface MigrateOutcome { ok: boolean; moved: string[]; restored: boolean; message?: string }

export interface GuardedMigrateDeps {
  /** 動かす前の口。App の leaveProject（保存 → 確認）。false なら整理しない。 */
  beforeMove(): Promise<boolean>
  /** main の整理を呼ぶ。 */
  migrate(): Promise<MigrateOutcome>
  /** 整理が済んだあとの後始末（タブを閉じる・根を取り直す）。ok のときだけ呼ぶ。 */
  afterMoved(): Promise<void> | void
}

/** 断られたら { cancelled: true }（何も動かしていない）。進めたら main の結果をそのまま返す。 */
export async function runGuardedMigrate(deps: GuardedMigrateDeps): Promise<MigrateOutcome | { cancelled: true }> {
  if (!(await deps.beforeMove())) return { cancelled: true }
  const r = await deps.migrate()
  if (r.ok) await deps.afterMoved()
  return r
}
