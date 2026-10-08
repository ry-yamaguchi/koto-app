import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// 判断2（2026-09-11）: 公開・破棄の失敗すべてに「🤖 AIに相談する」ボタンを出す。
// askAiAboutFailure 自体の正しさは tests/askAi.test.ts が固定している。ここでは
// 「実際に4つのパネル（AppRun 共用型・HANAMII・Vercel・AppRun 専有型）の失敗表示が
// 漏れなくそこを通っているか」を、ソースを読んで固定する（掟10: 呼び出し漏れの検知）。
//
// 完了条件の変異試験(a): 「失敗時の『AIに相談する』を成功時にも出す」変異を、
// 各パネルの「成功時には出さない」ガード（result.ok ? null : ... / ok ? null : ... /
// !xxxResult.ok && (...)）の実在で検知する。

const ROOT = path.join(__dirname, '..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8')

const appRunPanel = read('src/renderer/components/AppRunPanel.tsx')
const hanamiiPanel = read('src/renderer/components/HanamiiPanel.tsx')
const vercelPanel = read('src/renderer/components/VercelPanel.tsx')
const dedicatedPanel = read('src/renderer/components/AppRunDedicatedPanel.tsx')

describe('askAiAboutFailure の import（4パネルすべて）', () => {
  it.each([
    ['AppRunPanel.tsx', appRunPanel],
    ['HanamiiPanel.tsx', hanamiiPanel],
    ['VercelPanel.tsx', vercelPanel],
    ['AppRunDedicatedPanel.tsx', dedicatedPanel],
  ])('%s は askAiAboutFailure を shared/askAi から import している', (_name, src) => {
    expect(src).toContain("from '../../shared/askAi'")
    expect(src).toContain('askAiAboutFailure')
  })
})

describe('AppRunPanel.tsx / OpResultView: 失敗時のみ「🤖 AIに相談する」を出す（apply・teardown・cleanupImages 共通）', () => {
  it('OpResultView は kind/target を受け取り、成功時（result.ok）は askAiText を null にする', () => {
    expect(appRunPanel).toContain(
      "const askAiText = result.ok ? null : askAiAboutFailure(kind, target, result.message ?? '失敗しました', result.detail)"
    )
    expect(appRunPanel).toContain('{askAiText && (')
    expect(appRunPanel).toContain(
      "window.dispatchEvent(new CustomEvent('sakura:ask-ai', { detail: { text: askAiText } }))"
    )
  })

  it('OpResultView の呼び出しは kind（opKind）・target（さくらのAppRun）を渡している', () => {
    expect(appRunPanel).toContain(
      '<OpResultView result={opResult} demoted={conflictCardShown || limitCardShown} kind={opKind} target="さくらのAppRun" />'
    )
  })

  it('opKind は doApply（公開）・doTeardown（破棄）それぞれの先頭で立てる（共有 state の取り違え防止）', () => {
    const applyAt = appRunPanel.indexOf('const doApply = async (applyOpts')
    expect(applyAt).toBeGreaterThan(-1)
    expect(appRunPanel.slice(applyAt, applyAt + 160)).toContain("setOpKind('公開')")

    const teardownAt = appRunPanel.indexOf('const doTeardown = async () => {')
    expect(teardownAt).toBeGreaterThan(-1)
    expect(appRunPanel.slice(teardownAt, teardownAt + 160)).toContain("setOpKind('破棄')")
  })
})

describe('HanamiiPanel.tsx / ErrorMessageBlock: 失敗時のみ出す。🔄再起動の成功メッセージには出さない', () => {
  it('ErrorMessageBlock は ok（既定 false=失敗）を受け取り、ok のときは askAiText を null にする', () => {
    expect(hanamiiPanel).toContain('ok ? null : askAiAboutFailure(kind, target, msg, detail)')
  })

  it('publish（公開）は msgKind を「公開」、teardown（破棄）は「破棄」に立ててから msg を出す', () => {
    const publishAt = hanamiiPanel.indexOf('const publish = async (nameOverride?: string) => {')
    expect(publishAt).toBeGreaterThan(-1)
    expect(hanamiiPanel.slice(publishAt, publishAt + 150)).toContain("setMsgKind('公開')")

    const teardownAt = hanamiiPanel.indexOf('const teardown = async () => {')
    expect(teardownAt).toBeGreaterThan(-1)
    expect(hanamiiPanel.slice(teardownAt, teardownAt + 150)).toContain("setMsgKind('破棄')")
  })

  // ── msg は失敗と成功の**共有欄**である（2026-09-25 検分・3巡目の指摘2）─────────────
  // この欄には破棄の「✅ 破棄しました。…」と、公開で koto-data を差し替えたときの知らせも流れる。
  // だから restartMsg と同じく ok を**明示的に渡す**（渡し忘れると成功の知らせに
  // 「🤖 AIに相談する」が出る）。`ok={msgOk}` を足したときにこの期待を直し忘れて赤のままだったので、
  // **実物の行をそのまま**固定する。
  it('メインの欄（msg）は kind={msgKind} target="HANAMII" ok={msgOk} を渡す（成功の知らせにも流れる共有欄）', () => {
    expect(hanamiiPanel).toContain(
      '{msg && <ErrorMessageBlock msg={msg} detail={msgDetail} demoted={conflictCardShown} kind={msgKind} target="HANAMII" ok={msgOk} />}'
    )
    // 直す前の形（ok を渡さない＝成功の知らせに 🤖 が出る）が戻っていないか
    expect(
      hanamiiPanel,
      'ok={msgOk} を渡さない形が残っている（成功の知らせに 🤖 AIに相談する が出る）',
    ).not.toContain('kind={msgKind} target="HANAMII" />}')
  })

  it('msgOk は既定 false（失敗側）で、操作の先頭で必ず倒してから msg を出す', () => {
    expect(hanamiiPanel).toContain('const [msgOk, setMsgOk] = useState(false)')
    for (const [name, head] of [
      ['publish', 'const publish = async (nameOverride?: string) => {'],
      ['teardown', 'const teardown = async () => {'],
    ] as const) {
      const at = hanamiiPanel.indexOf(head)
      expect(at, `${name} が見つからない`).toBeGreaterThan(-1)
      expect(hanamiiPanel.slice(at, at + 150), `${name} の先頭で msgOk を倒していない`).toContain('setMsgOk(false)')
    }
  })

  // ── 公開が koto-data を差し替えたときの知らせ（指摘13 の HANAMII 経路）──────────────
  // main は差し替えた1行を executed で返す。**成功の知らせ**なので、失敗の欄（msg・🤖 AIに相談する）には
  // 入れない。立てないと「🤖 AIに相談する」が付き、成功したのに失敗に見える。
  // 2026-09-29: この知らせは msg 欄（msgOk を立てて共有）ではなく、main の処理の記録の lines から、
  // 成功の記録の枠（HanamiiOpResult）に出すようになった（閉じて開き直しても出る）。
  // 画面に出る様子（1回だけ出る・🤖 が付かない）は tests/ops-hanamiiVercel-hanamii.test.ts が動かして固定している。
  // ここは構造: 返り値の executed を msg 欄へ流す旧い形が戻っていないこと、成功の枝に失敗の枠が無いこと。
  it('公開の成功で差し替えの知らせを出すとき、msg 欄（失敗の欄）へ流さない。成功の記録の枠（lines）で出す', () => {
    expect(hanamiiPanel, '返り値の executed を失敗の欄へ流す旧い形が戻っている').not.toContain('setMsg((r.executed ?? []).join')
    const at = hanamiiPanel.indexOf('function HanamiiOpResult(')
    expect(at).toBeGreaterThan(-1)
    const body = hanamiiPanel.slice(at)
    // 失敗の枠（ErrorMessageBlock）を出すのは failure があるときだけ。lines は failure の有無に関わらず出る
    expect(body).toContain('failure !== null\n        ? <ErrorMessageBlock')
    expect(body).toContain('const lines = res.lines ?? []')
    expect(body).toContain('{lines.map((l, i) =>')
  })

  it('🔄再起動の欄（restartMsg）は成功メッセージも流れる共有欄のため、ok={restartOk} を明示的に渡す', () => {
    expect(hanamiiPanel).toContain(
      '{restartMsg && <ErrorMessageBlock msg={restartMsg} detail={restartMsgDetail} demoted={false} kind="再公開" target="HANAMII" ok={restartOk} />}'
    )
    // restartOk は成功パスで true、失敗パスで false に立てる（既定は true=安全側で「出さない」）
    const at = hanamiiPanel.indexOf('const doRestart = async () => {')
    expect(at).toBeGreaterThan(-1)
    const block = hanamiiPanel.slice(at, at + 900)
    expect(block).toContain('setRestartOk(false)')
    expect(block).toContain('setRestartOk(true)')
  })
})

describe('VercelPanel.tsx / ErrorMessageBlock: msg は常に失敗（teardown が無いため kind は固定で公開）', () => {
  it("askAiText は kind:'公開' target:'Vercel' で組み立てる", () => {
    expect(vercelPanel).toContain("const askAiText = askAiAboutFailure('公開', 'Vercel', msg, detail)")
  })

  it('Vercel には破棄操作（teardown 関数・electronAPI.vercel.teardown 呼び出し）が無い（kind を動的に切り替える必要が無いことの前提確認）', () => {
    expect(vercelPanel).not.toContain('const teardown =')
    expect(vercelPanel).not.toContain('electronAPI.vercel.teardown')
  })
})

describe('AppRunDedicatedPanel.tsx / ⑤⑥: createResult・teardownResult それぞれの失敗時のみ出す', () => {
  it('⑤ createResult は !createResult.ok のときだけボタンを出す（kind:公開）', () => {
    const at = dedicatedPanel.indexOf('<ErrorBlock msg={createResult.message} />')
    expect(at).toBeGreaterThan(-1)
    const block = dedicatedPanel.slice(at, at + 500)
    expect(block).toContain('{!createResult.ok && (')
    expect(block).toContain(
      "const text = askAiAboutFailure('公開', 'さくらのAppRun（専有型）', createResult.message ?? '失敗しました')"
    )
  })

  it('⑥ teardownResult は !teardownResult.ok のときだけボタンを出す（kind:破棄）', () => {
    const at = dedicatedPanel.indexOf('<ErrorBlock msg={teardownResult.message} />')
    expect(at).toBeGreaterThan(-1)
    const block = dedicatedPanel.slice(at, at + 500)
    expect(block).toContain('{!teardownResult.ok && (')
    expect(block).toContain(
      "const text = askAiAboutFailure('破棄', 'さくらのAppRun（専有型）', teardownResult.message ?? '失敗しました')"
    )
  })
})
