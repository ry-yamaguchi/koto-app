// publishRootFs.ts — `public/` があるかを実際に見て、公開の根を返す（main 側）。
//
// 判断そのものは shared/publishRoot.ts にある。ここは**ディスクを見る**ところだけ。
// 公開・実行・検査の入口は、必ずここを通して根を得ること
// （**呼ぶ側が部分的に使うと穴が空く**——この製品はその形で3回事故を起こしている。掟10）。

import * as fs from 'fs'
import * as path from 'path'
import { PUBLISH_DIR, publishRoot } from '../shared/publishRoot'

/**
 * 公開の根（絶対パス）。
 * `<project>/public` があればその中、無ければプロジェクト直下（＝移行前）。
 */
export function resolvePublishRoot(projectDir: string): string {
  if (typeof projectDir !== 'string' || !projectDir) return ''
  let has = false
  try {
    has = fs.statSync(path.join(projectDir, PUBLISH_DIR)).isDirectory()
  } catch { /* 無ければ移行前として扱う */ }
  return publishRoot(projectDir, has, path.sep)
}
