// publishRootRenderer.ts — `public/` があるかを見て、公開の根を返す（renderer 側）。
//
// 判断そのものは shared/publishRoot.ts。ここは**ディスクを見る**ところだけで、
// main 側の publishRootFs.ts と同じ役目を renderer で果たす。
// 公開・実行・検査の入口は、必ずここを通して根を得ること（掟10）。

import { PUBLISH_DIR, publishRoot } from '../shared/publishRoot'

/**
 * 公開の根（絶対パス）。
 * `<project>/public` があればその中、無ければプロジェクト直下（＝移行前）。
 */
export async function resolvePublishRoot(projectDir: string): Promise<string> {
  if (!projectDir) return ''
  let has = false
  try {
    has = await window.electronAPI.fs.exists(`${projectDir}/${PUBLISH_DIR}`)
  } catch { /* 見られなければ移行前として扱う */ }
  return publishRoot(projectDir, has)
}
