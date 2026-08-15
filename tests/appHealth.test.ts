import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseAppStatus, judgeAppHealth, judgeRecheck, foldRecheck, appLogUrl, askAiAboutFailure } from '../src/shared/appHealth'

// 2026-08-14 実機。Koto は「✅ 完了しました」と出したが、**アプリは起動に失敗していた**。
// 見ていたのは「デプロイのAPIが 200 を返したか」だけだった。
// 利用者は公開URLを開いて初めて気づき、原因はコントロールパネルのログにしかない。
//
// さくらの契約（公式ライブラリで確認・掟1）:
//   GET /applications/{id}/status → { status, message }
//   status は Healthy / UnHealthy / Deploying

describe('状態の読み取り', () => {
  it('実機で返ってきた形を読める', () => {
    expect(parseAppStatus({ status: 'UnHealthy', message: 'Component is exited: ExitCode1' }))
      .toEqual({ status: 'UnHealthy', message: 'Component is exited: ExitCode1' })
  })

  it('知らない値・壊れた応答でも落ちない', () => {
    expect(parseAppStatus({ status: 'なにか' }).status).toBe('Unknown')
    expect(parseAppStatus(null).status).toBe('Unknown')
    expect(parseAppStatus(undefined).message).toBe('')
    expect(parseAppStatus({ status: 123 } as any).status).toBe('Unknown')
  })
})

describe('公開の結果を、利用者に伝える形にする', () => {
  it('Healthy なら成功', () => {
    const h = judgeAppHealth({ status: 'Healthy' })
    expect(h.ok).toBe(true)
    expect(h.pending).toBe(false)
  })

  // ★ 今日の欠陥そのもの。ここで ok:true を返すと「完了しました」に戻る
  it('UnHealthy を成功と言わない', () => {
    const h = judgeAppHealth({ status: 'UnHealthy', message: 'Component is exited: ExitCode1' })
    expect(h.ok).toBe(false)
    expect(h.note).toContain('起動できませんでした')
    // さくらが返した理由をそのまま添える（これが無いと原因に辿り着けない）
    expect(h.detail).toBe('Component is exited: ExitCode1')
  })

  it('準備中はまだ成功と言わない', () => {
    const h = judgeAppHealth({ status: 'Deploying' })
    expect(h.ok).toBe(false)
    expect(h.pending).toBe(true)
  })

  it('待っても準備中のままなら、次にやることを伝える', () => {
    const h = judgeAppHealth({ status: 'Deploying', timedOut: true })
    expect(h.ok).toBe(false)
    expect(h.pending).toBe(true)
    expect(h.note).toContain('しばらくしてから')
  })

  // **分からないときは成功と言わない。** ただし失敗とも言い切らない
  it('状態を取れなかったときは、確かめてもらう', () => {
    const h = judgeAppHealth({ status: 'Unknown' })
    expect(h.ok).toBe(false)
    expect(h.pending).toBe(false)
    expect(h.note).toContain('確認できませんでした')
    expect(h.note).toContain('公開URLを開いて')
  })

  it('画面文言に Markdown 記法を混ぜない', () => {
    for (const s of ['Healthy', 'UnHealthy', 'Deploying', 'Unknown'] as const) {
      expect(judgeAppHealth({ status: s, message: 'x' }).note).not.toMatch(/\*\*|`/)
    }
  })
})

describe('ログの場所への案内', () => {
  it('アプリのIDからログ画面のURLを作る', () => {
    expect(appLogUrl('11111111-2222-3333-4444-555555555555'))
      .toContain('11111111-2222-3333-4444-555555555555')
    expect(appLogUrl('x')).toMatch(/^https:\/\/secure\.sakura\.ad\.jp\//)
  })

  it('IDをそのまま埋め込まない（URLとして壊れない）', () => {
    expect(appLogUrl('a/b?c')).not.toContain('a/b?c')
  })
})

describe('AIへの相談文', () => {
  it('状態と理由を含める', () => {
    const t = askAiAboutFailure({ note: '起動できませんでした。', detail: 'Component is exited: ExitCode1', entry: 'server.js' })
    expect(t).toContain('Component is exited: ExitCode1')
    expect(t).toContain('server.js')
    // 調べる観点を添える（丸投げにしない）
    expect(t).toContain('PORT')
  })

  // 2026-08-14 Ryosuke 指摘: 私が渡したログはコンパネから取ったもの。
  // **Koto はログを読めない**のに「原因を調べて」とだけ頼む文面だった。
  // AI に渡せる材料が無く、当てずっぽうの修正を促す形になっていた。
  it('ログを貼ってもらうよう頼む（Koto はログを読めないため）', () => {
    const t = askAiAboutFailure({ note: 'n' })
    expect(t).toContain('ログを貼ってください')
    expect(t).toContain('コントロールパネル')
    // 貼れなくても止まらないことを添える（貼り方が分からない人を突き放さない）
    expect(t).toContain('ログが無くても')
  })

  it('理由が無くても文になる', () => {
    expect(askAiAboutFailure({ note: '確認できませんでした。' }).length).toBeGreaterThan(20)
  })

  // **秘密を入れない。** チャットは外部のAIへ送られる
  it('鍵や環境変数の値を入れる余地を作らない', () => {
    const t = askAiAboutFailure({ note: 'n', detail: 'd', entry: 'e' })
    expect(t).not.toMatch(/KOTO_STORAGE_SECRET|ACCESS_KEY|token|secret/i)
  })
})

// 判断を一元化しても、呼ぶ側が通っていなければ意味がない（掟10）。
// 今日の10件のうち複数が「実装はあるが繋がっていない」形だった。
describe('公開の経路が、状態の確認を通っている', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'main', 'ipc', 'cloud.ts'), 'utf-8')

  it('公開のあとに状態を確かめている', () => {
    expect(src).toContain('waitForHealthy')
    expect(src).toContain('getAppStatus')
  })

  // ★ ここが戻ると「起動していないのに完了しました」に戻る
  it('デプロイの成否だけで ok を返していない', () => {
    expect(src).toContain('const finallyOk = result.ok && (health ? health.ok : true)')
    expect(src).toContain('ok: finallyOk,')
  })

  it('起動できなかったときは、ログの場所と相談の文面を返す', () => {
    expect(src).toContain("hint: 'app-unhealthy'")
    expect(src).toContain('appLogUrl(appId)')
    expect(src).toContain('askAiAboutFailure')
  })
})

// ── 手で押し直す（2026-08-14 Ryosuke 指摘・実機）──────────────────────────
// 「時間がかかりすぎてエラーになったようです。実際のサイトは表示できるのですが、
//   警告文がいつまで経っても消えない」
// 48秒の打ち切りを超えて起動したアプリを、公開し直さずに確かめ直せること。
describe('状態を見直す（手で押したとき）', () => {
  it('動き出していれば、成功に変わる', () => {
    const h = judgeRecheck({ status: 'Healthy' })
    expect(h.ok).toBe(true)
    expect(h.pending).toBe(false)
  })

  it('まだ準備中なら、成功とは言わず「もう一度」と伝える', () => {
    const h = judgeRecheck({ status: 'Deploying' })
    expect(h.ok).toBe(false)
    expect(h.pending).toBe(true)
    // **自動の待機中の文面（「準備しています…」）を出さない。**
    // 手で押した人に必要なのは「次にどうすればよいか」である
    expect(h.note).toContain('もう一度')
  })

  it('起動に失敗していれば、理由をそのまま残す', () => {
    const h = judgeRecheck({ status: 'UnHealthy', message: 'Component is exited: ExitCode1' })
    expect(h.ok).toBe(false)
    expect(h.pending).toBe(false)
    expect(h.detail).toBe('Component is exited: ExitCode1')
  })

  it('状態が読めなくても、失敗と決めつけない', () => {
    const h = judgeRecheck({ status: 'Unknown' })
    expect(h.ok).toBe(false)
    expect(h.note).toContain('確認できませんでした')
  })
})

// ── 矛盾する表示を残さない（2026-08-14 Ryosuke 指摘・実機）────────────────
// 「更新をして『アプリが動いています』が表示されたのに
//  『起動を確認できていません』が表示されたままです」
describe('見直しの結果を公開の結果へ畳み込む', () => {
  const unhealthy = { ok: false, hint: 'app-unhealthy', pending: true, message: 'まだ準備中です。', executed: ['再デプロイ'] }

  it('動いていると分かったら、起動待ちの失敗は成功に変わる', () => {
    const r = foldRecheck(unhealthy, judgeRecheck({ status: 'Healthy' }))
    expect(r!.ok).toBe(true)
    expect(r!.pending).toBe(false)
    expect(r!.message).toContain('動いています')
    // 何をしたかの記録は捨てない
    expect(r!.executed).toEqual(['再デプロイ'])
  })

  it('まだ動いていなければ、何も変えない', () => {
    expect(foldRecheck(unhealthy, judgeRecheck({ status: 'Deploying' }))).toBe(unhealthy)
    expect(foldRecheck(unhealthy, judgeRecheck({ status: 'UnHealthy' }))).toBe(unhealthy)
  })

  it('別の理由で失敗したものは、アプリが動いていても失敗のまま', () => {
    // 例: レジストリへ push できなかった。アプリが動いているのは「前の版」である
    const other = { ok: false, hint: 'reset-registry', message: 'push に失敗しました' }
    expect(foldRecheck(other, judgeRecheck({ status: 'Healthy' }))).toBe(other)
  })

  it('結果が無ければ、作り出さない', () => {
    expect(foldRecheck(null, judgeRecheck({ status: 'Healthy' }))).toBe(null)
    expect(foldRecheck(undefined, judgeRecheck({ status: 'Healthy' }))).toBe(null)
  })

  it('すでに成功しているものには触らない', () => {
    const ok = { ok: true, message: '公開しました' }
    expect(foldRecheck(ok, judgeRecheck({ status: 'Healthy' }))).toBe(ok)
  })
})
