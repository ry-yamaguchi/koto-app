import { describe, it, expect, beforeEach } from 'vitest'
import { splitFailureDetail } from '../src/shared/failureDetail'

// 公開前セキュリティチェックの失敗の report は「チェックに失敗しました（<文>）。」の形に埋め込まれる。
// 失敗の詳細（原文）は文の途中に挟まず、report の最後の行に残る。読めなかったファイルの注記があっても、その後ろに来る。
// 偽の client（必ず失敗する）に実際に流して、返った report を見る。

type ChatArgs = { apiKey: string; model: string; messages: { role: string; content: any }[] }

const store = new Map<string, string>()
const g = globalThis as any
g.localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)) },
  removeItem: (k: string) => { store.delete(k) },
}

function setupWindow(chat: (args: ChatArgs) => Promise<any>, unreadable: string[] = []) {
  const files = ['a.html', 'b.html']
  g.window = {
    dispatchEvent: () => true,
    electronAPI: {
      fs: {
        exists: async () => false,
        projectFilesInfo: async () => ({ files, truncated: false }),
        readFile: async (p: string) => {
          if (p.endsWith('package.json')) throw new Error('無い')
          if (unreadable.some(u => p.endsWith(u))) throw new Error('読めない')
          return `<!-- ${p} -->\nhello`
        },
      },
      sakura: { chat },
    },
  }
}

beforeEach(() => { store.clear() })

describe('セキュリティチェックの失敗の report に、原文が最後の行で付く', () => {
  it('回線断: 括弧の中は日本語の文だけで、詳細は最後の行', async () => {
    setupWindow(async () => { throw new Error("Error invoking remote method 'sakura:chat': Error: getaddrinfo ENOTFOUND api.ai.sakura.ad.jp") })
    const { runSecurityCheck } = await import('../src/renderer/securityCheck')
    const r = await runSecurityCheck('/proj', 'key-1')
    expect(r.verdict).toBe('skip')
    const { text, detail } = splitFailureDetail(r.report)
    expect(text).toBe('チェックに失敗しました（インターネットに接続できませんでした。接続を確かめてから、もう一度お試しください）。')
    expect(detail).toBe('getaddrinfo ENOTFOUND api.ai.sakura.ad.jp')
    expect(r.report.endsWith('\n詳細: getaddrinfo ENOTFOUND api.ai.sakura.ad.jp')).toBe(true)
  })

  it('読めなかったファイルの注記があっても、詳細は注記より後ろの最後の行', async () => {
    setupWindow(async () => { throw new Error('getaddrinfo ENOTFOUND api.ai.sakura.ad.jp') }, ['b.html'])
    const { runSecurityCheck } = await import('../src/renderer/securityCheck')
    const r = await runSecurityCheck('/proj', 'key-1')
    expect(r.verdict).toBe('skip')
    const lines = r.report.split('\n')
    expect(lines[lines.length - 1]).toBe('詳細: getaddrinfo ENOTFOUND api.ai.sakura.ad.jp')
    expect(r.report).toContain('※ 読み込めなかったため、次のファイルは確認していません')
    expect(r.report.indexOf('※ 読み込めなかった')).toBeLessThan(r.report.indexOf('詳細:'))
    // 括弧の中に詳細が入り込んでいない
    expect(splitFailureDetail(r.report).text).toMatch(/^チェックに失敗しました（[^\n]*）。\n※ /)
    // 画面に出す parts も同じ文（最後の part の最後の行が詳細）
    expect(r.parts?.map(p => p.text).join('\n')).toBe(r.report)
  })
})
