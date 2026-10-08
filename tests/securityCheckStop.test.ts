import { describe, it, expect, beforeEach } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-25 検分の指摘6: preload の `sakura.chat(args, onStart?)` に足した「中断の口」の
// 呼び出し元は**2つ**あるのに、配線したのは 🗂 まとめ（useAiChat.ts）だけだった。
// もう片方＝公開前セキュリティチェック（src/renderer/securityCheck.ts）は onStart を渡さず、
// 1かたまりあたり最悪およそ600秒（NON_STREAM_TIMEOUT_MS × 再試行）×かたまりの数だけ、
// 利用者にはどうやっても止められなかった。
//
// ── このテストの流儀（掟10）──────────────────────────────────────────
// ソースの文字列を照合しない。**決して返事をしない偽 client** に実際に流し、
//   ・中止を呼んだら、待っている問い合わせが切れて promise が返ること
//   ・**残りのかたまりへ進まない**こと（＝出た要求の一覧と順序で見る）
//   ・押していなければ、かたまりの数だけ順に要求が出ること（対照）
// を固定する。onStart を渡し忘れれば、この promise は永久に解決せず時間切れで落ちる。
// ─────────────────────────────────────────────────────────────────────────────

/** 偽 window。securityCheck.ts / usage.ts が触るものだけを最小限で用意する。 */
type ChatArgs = { apiKey: string; model: string; messages: { role: string; content: any }[]; maxTokens?: number; temperature?: number }

const store = new Map<string, string>()
const g = globalThis as any
g.localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)) },
  removeItem: (k: string) => { store.delete(k) },
}

/** 出た要求の一覧（順序つき）。中身は「そのかたまりに入っていたファイル名」で見る。 */
let requests: string[][] = []
/** 要求が1件出るたびに解決する合図。 */
let onRequest: () => void = () => {}

/** そのかたまりの user プロンプトから、見出し行のファイル名を拾う（pieceHeader の形）。 */
function filesInPrompt(args: ChatArgs): string[] {
  const text = String(args.messages.map(m => m.content).join('\n'))
  // pieceHeader: `--- p0.html ---`／分割されていれば `--- p0.html（1/2）---`
  return [...text.matchAll(/^--- (.+?)(?:（\d+\/\d+）)?\s*---$/gm)].map(m => m[1])
}

/** 偽 electronAPI を作る。chat の振る舞い（返事をする／しない）だけを差し替える。 */
function setupWindow(chat: (args: ChatArgs, onStart?: (abort: () => void) => void) => Promise<any>) {
  const files = Array.from({ length: 6 }, (_, i) => `p${i}.html`)
  g.window = {
    dispatchEvent: () => true,
    electronAPI: {
      fs: {
        exists: async () => false, // public/ は無い（publishRoot はプロジェクト直下）
        projectFilesInfo: async () => ({ files, truncated: false }),
        readFile: async (p: string) => {
          if (p.endsWith('package.json')) throw new Error('無い') // 静的サイトとして検査される
          // 1ファイル5,000文字 → かたまり（24,000文字）は4ファイルで満ちる＝全部で2かたまり
          return `<!-- ${p} -->\n` + 'a'.repeat(5000)
        },
      },
      sakura: { chat },
    },
  }
  return files
}

beforeEach(() => {
  requests = []
  store.clear()
})

describe('公開前セキュリティチェックを中止できる（sakura.chat の onStart を繋いだか）', () => {
  it('★ 中止を呼ぶと、待っている問い合わせが切れ、残りのかたまりへ進まない', async () => {
    const arrived = new Promise<void>(resolve => { onRequest = resolve })
    // **決して返事をしない**偽 client。preload と同じ順番で、invoke の前に onStart を呼ぶ。
    setupWindow((args, onStart) => new Promise((_resolve, reject) => {
      onStart?.(() => {
        // 本物は main の abort → engine の APIUserAbortError → IPC 越しに文字列で届く
        reject(new Error("Error invoking remote method 'sakura:chat': Request was aborted."))
      })
      requests.push(filesInPrompt(args))
      onRequest()
    }))
    const { runSecurityCheck } = await import('../src/renderer/securityCheck')

    let stop: (() => void) | null = null
    const p = runSecurityCheck('/proj', 'key-1', undefined, fn => { stop = fn })

    await arrived
    // 中断関数は「まだ1文字も返ってきていない」時点で既に手に入っている
    expect(stop).not.toBeNull()
    expect(requests).toHaveLength(1)

    stop!()
    const r = await p // 配線が抜けていればここで永久に待ち、時間切れで落ちる

    // 残りのかたまりへ進んでいない（進むと最悪もう600秒待たされる）
    expect(requests).toHaveLength(1)
    // 途中までを「確認できた」ことにしない
    expect(r.verdict).toBe('skip')
    expect(r.report).toContain('中止')
    expect(r.report).toContain('最後まで確認していません')
    // 中止した本人に「失敗しました」とは言わない
    expect(r.report).not.toContain('チェックに失敗しました')
  }, 20_000)

  it('★ 返事が届いた直後に中止しても、次のかたまりへ進まない（止める相手がもう居ない場合）', async () => {
    // 1かたまり目が終わった直後に押すと、切るべき通信はもう無い（中断は空振りする）。
    // このとき残りのかたまりへ進んでしまうと、押したのにまた何分も待たされる。
    let release: () => void = () => {}
    const arrived = new Promise<void>(resolve => { onRequest = resolve })
    setupWindow((args, onStart) => new Promise(resolve => {
      onStart?.(() => { /* すでに答え終わった呼び出しの中断は、本物でも何も起きない */ })
      requests.push(filesInPrompt(args))
      release = () => resolve({ content: '判定: 問題なし\n- 特に問題は見つかりませんでした', usage: null })
      onRequest()
    }))
    const { runSecurityCheck } = await import('../src/renderer/securityCheck')

    let stop: (() => void) | null = null
    const p = runSecurityCheck('/proj', 'key-1', undefined, fn => { stop = fn })
    await arrived
    stop!()    // 押す（切る相手はもう居ない）
    release()  // 1かたまり目の返事が届く
    const r = await p

    expect(requests).toHaveLength(1) // 2かたまり目は出ていない
    expect(r.verdict).toBe('skip')
    expect(r.report).toContain('最後まで確認していません')
  }, 20_000)

  it('対照: 中止しなければ、かたまりの数だけ順に問い合わせる（副作用が無いこと）', async () => {
    setupWindow(async (args, onStart) => {
      onStart?.(() => {}) // 本物と同じく必ず呼ばれる（呼ばれなくても対照側は成立する）
      requests.push(filesInPrompt(args))
      return { content: '判定: 問題なし\n- 特に問題は見つかりませんでした', usage: { prompt_tokens: 1, completion_tokens: 1 } }
    })
    const { runSecurityCheck } = await import('../src/renderer/securityCheck')

    const r = await runSecurityCheck('/proj', 'key-1')
    // 6ファイル×5,000文字 → 24,000文字の上限で 4件＋2件の2かたまり。順序も固定する
    expect(requests).toEqual([
      ['p0.html', 'p1.html', 'p2.html', 'p3.html'],
      ['p4.html', 'p5.html'],
    ])
    expect(r.verdict).toBe('ok')
    expect(r.report).not.toContain('中止')
  }, 20_000)
})
