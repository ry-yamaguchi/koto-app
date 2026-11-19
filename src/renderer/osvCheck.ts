// osvCheck.ts — 「ライブラリの脆弱性を調べる」を押してからの流れ（純関数＋ports）。
//
// 順番: 通信しない下調べ → 画面で言い切れる回はそこで終わり → 同意をこの時点で読む →
// 未同意なら確認 → 通信する口。確認で「やめる」なら通信する口は呼ばない。

import { failureText } from '../shared/failureText'
import type { OsvCheckReply, OsvPreview } from '../shared/osvTypes'
import {
  OSV_CONFIRM_CANCEL, OSV_CONFIRM_OK, OSV_CONFIRM_TITLE, osvConfirmBody, osvViewOfPreview, osvViewOfReply,
  type OsvView,
} from './osvCheckWords'

export interface OsvFlowPorts {
  preview(projectDir: string): Promise<OsvPreview>
  check(projectDir: string, consented: boolean): Promise<OsvCheckReply>
  hasConsent(): boolean
  recordConsent(): void
  confirm(opts: { title: string; body: string; confirmLabel: string; cancelLabel: string; danger: boolean; initialFocus: 'cancel' }): Promise<boolean>
}

export type OsvFlowOutcome = { kind: 'cancelled' } | { kind: 'view'; view: OsvView }

export async function runOsvFlow(ports: OsvFlowPorts, projectDir: string): Promise<OsvFlowOutcome> {
  try {
    const p = await ports.preview(projectDir)
    const early = osvViewOfPreview(p)
    if (early) return { kind: 'view', view: early }
    // p は state 'ok' で sendCount > 0
    if (p.state !== 'ok') return { kind: 'view', view: osvViewOfReply({ state: p.state }) }
    // 同意は押された時点で読む（設定で取り消した直後でも、次の押しで確認が出る）
    if (!ports.hasConsent()) {
      const ok = await ports.confirm({
        title: OSV_CONFIRM_TITLE,
        body: osvConfirmBody(p.sendCount, p.examples),
        confirmLabel: OSV_CONFIRM_OK,
        cancelLabel: OSV_CONFIRM_CANCEL,
        danger: false,
        initialFocus: 'cancel',
      })
      if (ok !== true) return { kind: 'cancelled' }
      // 保存の成否には頼らない（保存できなくても、この回は送る。次回また確認が出る）
      ports.recordConsent()
    }
    const reply = await ports.check(projectDir, true)
    return { kind: 'view', view: osvViewOfReply(reply) }
  } catch (e) {
    return { kind: 'view', view: osvViewOfReply({ state: 'failed', message: failureText(e, { readOnly: true }) }) }
  }
}
