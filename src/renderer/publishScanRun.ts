import { publishScanViewOf, type ScanView } from './publishScanWords'
import { failureText } from '../shared/failureText'
import type { PublishScanScope } from '../shared/publishScanTypes'

// 点検を呼ぶ口はここだけ。例外は投げず、画面の行にして返す。
export async function runPublishScanView(projectDir: string, scope: PublishScanScope): Promise<ScanView> {
  try {
    return publishScanViewOf(await window.electronAPI.publishScan.run(projectDir, scope))
  } catch (e) {
    return publishScanViewOf({ state: 'failed', message: failureText(e, { readOnly: true }) })
  }
}
