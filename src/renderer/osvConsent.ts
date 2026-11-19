// osvConsent.ts — 「ライブラリの脆弱性」を OSV.dev へ照会することへの同意の保存と読み出し。
//
// 利用者ごとの設定（キーにプロジェクトを含めない）。値が OSV_CONSENT_VERSION と同じときだけ同意済み。
// 読み出しに失敗したときは未同意に倒す（黙って送らない）。
// 書き込みは recordOsvConsent と revokeOsvConsent の2つだけ（同じキーへの setItem・removeItem をほかへ置かない）。

export const OSV_CONSENT_KEY = 'koto_osv_consent'

/** 確認の文で言う「送るもの」が増えたら上げる（同意済みの人にも、もう一度確認が出る）。 */
export const OSV_CONSENT_VERSION = '1'

/** いまの版に同意済みか。読めないときは未同意。 */
export function hasOsvConsent(): boolean {
  try {
    return localStorage.getItem(OSV_CONSENT_KEY) === OSV_CONSENT_VERSION
  } catch {
    return false
  }
}

/** 同意を記録する。保存できたら true、できなければ false（例外にしない）。 */
export function recordOsvConsent(): boolean {
  try {
    localStorage.setItem(OSV_CONSENT_KEY, OSV_CONSENT_VERSION)
    return true
  } catch {
    return false
  }
}

/** 同意を取り消す。消せたら true、できなければ false（例外にしない）。 */
export function revokeOsvConsent(): boolean {
  try {
    localStorage.removeItem(OSV_CONSENT_KEY)
    return true
  } catch {
    return false
  }
}
