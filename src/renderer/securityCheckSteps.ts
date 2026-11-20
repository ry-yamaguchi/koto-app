// 🛡 のボタンを押したあとの順番: 先に Koto の点検、続けて AI の確認。
// 点検の間に「中止」が押されていたら、AI の確認は始めない（AI の利用量を使わせない）。
export type SecurityStepsEnd = 'no-ai' | 'stopped-before-ai' | 'ai-done'

export async function runSecuritySteps(d: {
  scan: () => Promise<void>
  /** AI の確認。キーが無いときは null */
  ai: (() => Promise<void>) | null
  /** 「中止」が押されたか */
  stopRequested: () => boolean
}): Promise<SecurityStepsEnd> {
  await d.scan()
  if (!d.ai) return 'no-ai'
  if (d.stopRequested()) return 'stopped-before-ai'
  await d.ai()
  return 'ai-done'
}
