// 失敗の文を 📋 コピーするときの文（文・詳細・Koto の版・日時）。形と伏せ字は shared/failureDetail.ts の failureCopyText。
// 版は main に聞いて覚える（聞けなければ「不明」。聞けなかった結果は覚えず、次のコピーで聞き直す）。

import { failureCopyText } from '../shared/failureDetail'

let versionOnce: Promise<string> | null = null

function appVersion(): Promise<string> {
  if (!versionOnce) {
    versionOnce = Promise.resolve()
      .then(() => window.electronAPI?.app?.getVersion?.())
      .then(v => (typeof v === 'string' ? v : ''))
      .catch(() => '')
      .then(v => {
        // 起動直後で聞けなかったとき「不明」を確定させない（次のコピーで聞き直す）
        if (!v) versionOnce = null
        return v
      })
  }
  return versionOnce
}

/** いま押されたコピーの文。 */
export async function failureCopyNow(shown: string): Promise<string> {
  return failureCopyText(shown, { version: await appVersion(), at: new Date() })
}

// コピーに足す文（API の応答など、failureCopyNow を通らない部分）を伏せる
export { maskForCopy } from '../shared/failureText'
