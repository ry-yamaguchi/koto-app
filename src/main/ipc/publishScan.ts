// 公開されるファイルの点検（publishScan:*）。読んで点検するのは main で、画面へ返すのは指摘だけ。
// プロジェクトの鍵・活動の記録は使わない（読むだけ）。通信しない。
import { ipcMain } from 'electron'
import * as path from 'path'
import { runPublishScanFs } from '../publishScan'
import { failureText } from '../../shared/failureText'
import type { PublishScanReply } from '../../shared/publishScanTypes'

export async function publishScanFs(projectDir: unknown, scope: unknown): Promise<PublishScanReply> {
  if (typeof projectDir !== 'string' || projectDir === '' || !path.isAbsolute(projectDir) || (scope !== 'publish' && scope !== 'github')) return { state: 'bad-dir' }
  try {
    return await runPublishScanFs(projectDir, scope)
  } catch (e) {
    return { state: 'failed', message: failureText(e, { readOnly: true }) }
  }
}

export function registerPublishScanHandlers(): void {
  ipcMain.handle('publishScan:run', (_e, projectDir: unknown, scope: unknown) => publishScanFs(projectDir, scope))
}
