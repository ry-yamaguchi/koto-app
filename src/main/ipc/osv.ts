// ライブラリの脆弱性の照会（osv:*）。
// 送る一覧は main がディスクから読んで作る（画面から一覧は受け取らない）。
// osv:preview は通信しない。osv:check は同意が true でなければ、ファイルも読まず通信もしない。
import { ipcMain } from 'electron'
import * as path from 'path'
import { runOsvCheck } from '../cloud/osvClient'
import { readOsvPlanFs } from '../osvProjectRead'
import { failureText } from '../../shared/failureText'
import { OSV_MAX_PACKAGES } from '../../shared/osvLimits'
import type { OsvPreview, OsvCheckReply } from '../../shared/osvTypes'

function isProjectDir(x: unknown): x is string {
  return typeof x === 'string' && x !== '' && path.isAbsolute(x)
}

/** 通信しない口。一覧そのものは返さない。 */
export function osvPreviewFs(projectDir: unknown): OsvPreview {
  try {
    if (!isProjectDir(projectDir)) return { state: 'bad-dir' }
    const plan = readOsvPlanFs(projectDir)
    if (plan.state !== 'ok') return { state: plan.state }
    return {
      state: 'ok',
      sendCount: Math.min(plan.deps.length, OSV_MAX_PACKAGES),
      total: plan.deps.length,
      examples: plan.examples,
      skipped: plan.skipped,
      manifest: plan.manifest,
    }
  } catch {
    return { state: 'unreadable' }
  }
}

/** 通信する口。同意が true でなければ何も読まず、何も送らない。 */
export async function osvCheckFs(projectDir: unknown, consented: unknown, fetchImpl: typeof fetch): Promise<OsvCheckReply> {
  if (consented !== true) return { state: 'not-consented' }
  try {
    if (!isProjectDir(projectDir)) return { state: 'bad-dir' }
    const plan = readOsvPlanFs(projectDir)
    if (plan.state !== 'ok') return { state: plan.state }
    if (plan.deps.length === 0) return { state: 'nothing-to-send', skipped: plan.skipped, manifest: plan.manifest }
    const r = await runOsvCheck({ consented, deps: plan.deps, fetchImpl })
    if (r.kind !== 'done') return { state: 'not-consented' }
    return { state: 'done', result: r, skipped: plan.skipped, manifest: plan.manifest }
  } catch (e) {
    return { state: 'failed', message: failureText(e, { readOnly: true }) }
  }
}

export function registerOsvHandlers(): void {
  ipcMain.handle('osv:preview', (_e, projectDir: unknown) => osvPreviewFs(projectDir))
  ipcMain.handle('osv:check', (_e, projectDir: unknown, consented: unknown) => osvCheckFs(projectDir, consented, fetch))
}
