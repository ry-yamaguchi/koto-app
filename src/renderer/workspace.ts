// ワークスペース（単独チャット/ChatAppの保存先、NewProjectModal の既定作成先）の決定規則。
// localStorage の sakura_workspace があればそれを使う。
// 無ければ、すでに ~/SAKURAIDE（旧称「Sakura IDE」由来。2026-09-27 以前の既定）があれば
// それを使い（既存の人が作ったものを見失わせないため）、無ければ新しい既定 ~/Koto を使う
// （W-121・2026-09-27 作者決定：新しく入れた人だけ ~/Koto。~/SAKURAIDE がある人はそのまま）。
// NewProjectModal.tsx と ChatApp（chatStorage.ts 経由）の両方からこのヘルパを使う。
export const WORKSPACE_KEY = 'sakura_workspace'
/** 旧称由来の既定フォルダ名（もう新規には使わない。すでにある人を見つけるためだけに残す）。 */
export const LEGACY_WORKSPACE_DIRNAME = 'SAKURAIDE'
/** 新しい既定フォルダ名（2026-09-27〜）。 */
export const WORKSPACE_DIRNAME = 'Koto'

/** 現在のワークスペースディレクトリを返す（NewProjectModal で選び直されていればそれ、無ければ既定）。 */
export async function getWorkspaceDir(): Promise<string> {
  const saved = localStorage.getItem(WORKSPACE_KEY)
  if (saved) return saved
  const home = await window.electronAPI.fs.homeDir()
  const legacy = `${home}/${LEGACY_WORKSPACE_DIRNAME}`
  // すでに ~/SAKURAIDE を使っている人は、新規作成のたびに新しい ~/Koto へ迷い込まないよう
  // そのまま使う（既存のフォルダは動かさない・作り直さない）。
  if (await window.electronAPI.fs.exists(legacy)) return legacy
  return `${home}/${WORKSPACE_DIRNAME}`
}
