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

  it('メインの失敗欄（msg）は kind={msgKind} target="HANAMII" を渡す', () => {
    expect(hanamiiPanel).toContain(
      '{msg && <ErrorMessageBlock msg={msg} detail={msgDetail} demoted={conflictCardShown} kind={msgKind} target="HANAMII" />}'
    )
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
