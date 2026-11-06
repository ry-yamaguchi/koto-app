// 本当にインターネットへ出られるかを調べる（main 専用）。
// レジストリの不調と回線断は、どちらも Go の道具では同じ 'no such host' になり、文面では見分けられない。
// そこで、無関係な名前（さくらの公開の窓口）が引けるかを別に確かめて、原因の見立てに使う。
// 例外は外へ出さない（調べられなかったときは false）。
import dns from 'node:dns'

export interface OnlineProbeDeps {
  isOnline?: () => boolean
  lookup?: (host: string) => Promise<unknown>
  timeoutMs?: number
}

const PROBE_HOST = 'secure.sakura.ad.jp'
const DEFAULT_TIMEOUT_MS = 3000

async function electronIsOnline(): Promise<boolean> {
  try {
    const { net } = await import('electron')
    // electron の外（テストなど）では net が無い。判断材料が無いので名前引きに進む
    return typeof net?.isOnline === 'function' ? net.isOnline() : true
  } catch {
    return true
  }
}

export async function probeOnline(deps: OnlineProbeDeps = {}): Promise<boolean> {
  try {
    const online = deps.isOnline ? deps.isOnline() : await electronIsOnline()
    if (!online) return false
    const lookup = deps.lookup ?? ((host: string) => dns.promises.lookup(host))
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    })
    try {
      await Promise.race([lookup(PROBE_HOST), timeout])
      return true
    } finally {
      if (timer) clearTimeout(timer)
    }
  } catch {
    return false
  }
}
