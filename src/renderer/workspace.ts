// ワークスペース（単独チャット/ChatAppの保存先、NewProjectModal の既定作成先）の決定規則。
// localStorage の sakura_workspace があればそれを使い、無ければ既定の ~/SAKURAIDE を使う。
// NewProjectModal.tsx と ChatApp（chatStorage.ts 経由）の両方からこのヘルパを使う。
export const WORKSPACE_KEY = 'sakura_workspace'
export const WORKSPACE_DIRNAME = 'SAKURAIDE'

/** 現在のワークスペースディレクトリを返す（NewProjectModal で選び直されていればそれ、無ければ既定）。 */
export async function getWorkspaceDir(): Promise<string> {
  const saved = localStorage.getItem(WORKSPACE_KEY)
  if (saved) return saved
  const home = await window.electronAPI.fs.homeDir()
  return `${home}/${WORKSPACE_DIRNAME}`
}
