import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// 委譲仕様: 起動のしかたが、さくら側と Koto の設定で食い違ったら、黙って上書きせず
// どちらにするか選んでもらう（Ryosuke さん決定・案②・2026-09-10）。
//
// React を実レンダリングするテストインフラが無いため、apprunDedicatedWiring.test.ts /
// appRunScaleChoice.test.ts と同じ「ソーステキストを固定する」流儀で確かめる。
// 呼び出しの形ごと一意に指す（掟10・2026-08-20 の戒め: 当て先が他の行にも出ないか必ず確認する）。

const panel = readFileSync(join(__dirname, '..', 'src/renderer/components/AppRunPanel.tsx'), 'utf-8')

describe('AppRunPanel.tsx: doApply の呼び出し口（ConfirmDialog）は event を applyOpts へ渡さない', () => {
  it("onApply={() => doApply()}（onApply={doApply} だと onClick の SyntheticEvent が applyOpts に化ける）", () => {
    expect(panel).toContain('onApply={() => doApply()}')
    expect(panel).not.toContain('onApply={doApply}')
  })
})

describe('AppRunPanel.tsx: doApply は needsScaleDecision を失敗にせず、選択カードの state へ積む', () => {
  const at = panel.indexOf('const doApply = async (applyOpts:')
  it('doApply の定義がある', () => { expect(at).toBeGreaterThan(0) })

  const end = panel.indexOf('\n  const doTeardown', at)
  const block = panel.slice(at, end)

  it('r.needsScaleDecision があれば setScaleAsk に積み、setOpResult より前に return する（失敗表示に落とさない）', () => {
    const needsAt = block.indexOf('if (r.needsScaleDecision)')
    expect(needsAt).toBeGreaterThan(0)
    const setOpResultAt = block.indexOf('setOpResult(r)')
    expect(setOpResultAt).toBeGreaterThan(needsAt) // needsScaleDecision の分岐が先
    const branch = block.slice(needsAt, setOpResultAt)
    expect(branch).toContain('setScaleAsk({ ...r.needsScaleDecision, confirmed: applyOpts.confirmed })')
    expect(branch).toContain('return')
  })

  it('adoptedScaleMin が返ったら env.json を読み直す（loadEnv）', () => {
    expect(block).toContain('if (r.adoptedScaleMin !== undefined) await loadEnv()')
  })
})

describe('AppRunPanel.tsx: 選択カード（scaleAsk）', () => {
  const at = panel.indexOf('if (scaleAsk) {')
  it('scaleAsk の分岐がある', () => { expect(at).toBeGreaterThan(0) })

  const end = panel.indexOf('\n  // region（ゾーン）は表示専用', at)
  const block = panel.slice(at, end)

  it('文言: 起動のしかたが違います。さくら側/Kotoの設定を scaleLabel で出す', () => {
    expect(block).toContain('起動のしかたが違います。さくら側:『{scaleLabel(scaleAsk.actual)}』／Koto の設定:『{scaleLabel(scaleAsk.recorded)}』')
  })

  it('① Koto の設定で公開する → scaleDecision:\'koto\' で doApply を呼び直す', () => {
    expect(block).toContain('① Koto の設定で公開する')
    expect(block).toContain("onClick={() => doApply(nextApplyOpts({ confirmed: scaleAsk.confirmed }, 'koto'))}")
  })

  it('② さくら側の設定を Koto に取り込んで公開する → scaleDecision:\'sakura\' で doApply を呼び直す', () => {
    expect(block).toContain('② さくら側の設定を Koto に取り込んで公開する')
    expect(block).toContain("onClick={() => doApply(nextApplyOpts({ confirmed: scaleAsk.confirmed }, 'sakura'))}")
  })

  it('やめる（選び直さず閉じられる）', () => {
    expect(block).toContain('>やめる</button>')
    expect(block).toContain('onClick={() => setScaleAsk(null)}')
  })
})
