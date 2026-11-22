import { publishScanViewOf, type ScanView } from './publishScanWords'
import { failureText } from '../shared/failureText'
import { scanFixItemsOf, type SecurityFixItem } from '../shared/aiCheckFindings'
import type { PublishScanReply, PublishScanScope } from '../shared/publishScanTypes'

/** 点検の結果の画面の行と、修正の依頼に渡す項目。 */
export interface PublishScanOutcome {
  view: ScanView
  fixItems: SecurityFixItem[]
}

// 点検を呼ぶ口はここだけ。例外は投げず、画面の行にして返す。
export async function runPublishScanResult(projectDir: string, scope: PublishScanScope): Promise<PublishScanOutcome> {
  let reply: PublishScanReply
  try {
    reply = await window.electronAPI.publishScan.run(projectDir, scope)
  } catch (e) {
    reply = { state: 'failed', message: failureText(e, { readOnly: true }) }
  }
  return {
    view: publishScanViewOf(reply),
    fixItems: reply.state === 'done' ? scanFixItemsOf(reply.findings) : [],
  }
}

export async function runPublishScanView(projectDir: string, scope: PublishScanScope): Promise<ScanView> {
  return (await runPublishScanResult(projectDir, scope)).view
}
