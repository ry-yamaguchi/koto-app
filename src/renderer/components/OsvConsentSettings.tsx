import React, { useState } from 'react'
import { OSV_SEND_NOTE } from '../../shared/dataDestinationNotes'
import { hasOsvConsent, revokeOsvConsent } from '../osvConsent'
import {
  OSV_SETTINGS_TITLE, OSV_SETTINGS_CONSENTED, OSV_SETTINGS_NOT_CONSENTED, OSV_SETTINGS_REVOKE,
} from '../osvCheckWords'

// 設定の「セキュリティ」カード。同意の取り消し専用（同意するのは、調べるときの確認だけ）。
export default function OsvConsentSettings() {
  // 同意の有無は、描くたびに保存先から読む（覚えた写しを使わない）
  const [, bump] = useState(0)
  const consented = hasOsvConsent()
  return (
    <div className="bg-surface border border-line rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-semibold text-ink-secondary">{OSV_SETTINGS_TITLE}</div>
        {consented && (
          <button
            onClick={() => { revokeOsvConsent(); bump(n => n + 1) }}
            className="text-[11px] border border-line rounded-md px-2 py-0.5 text-ink-secondary hover:border-sakura hover:text-sakura"
          >{OSV_SETTINGS_REVOKE}</button>
        )}
      </div>
      <p className="text-sm text-ink">{consented ? OSV_SETTINGS_CONSENTED : OSV_SETTINGS_NOT_CONSENTED}</p>
      <p className="mt-1.5 text-[11px] text-ink-muted leading-relaxed">{OSV_SEND_NOTE}</p>
    </div>
  )
}
