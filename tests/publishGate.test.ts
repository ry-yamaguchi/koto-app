import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { shouldBlockPublish } from '../src/renderer/publishGate'

// 委譲仕様 UX-C・判断5（2026-09-11）: 「🚀 公開する」を押したら公開前チェック（preflight）を
// 自動で走らせ、ng があれば公開を始めずに止める。判断だけを shouldBlockPublish（純関数）に
// 切り出し、startApply からはこれを呼ぶだけにする（掟10）。

describe('shouldBlockPublish: ng があれば止める。それ以外は通す（迷ったら通す側・preflight.ts と同じ方針）', () => {
  it('★ ng があれば止める（canPublish: false）', () => {
    const r = shouldBlockPublish({ ok: true, canPublish: false, summary: 'このままでは公開できません（イメージの置き場）' })
    expect(r.block).toBe(true)
    expect(r.reason).toContain('公開できません')
  })

  it('warn だけ（canPublish: true）なら通す', () => {
    const r = shouldBlockPublish({ ok: true, canPublish: true, summary: '公開できます（気になる点が1件あります）' })
    expect(r.block).toBe(false)
  })

  it('checks が空（canPublish: true）でも通す', () => {
    const r = shouldBlockPublish({ ok: true, canPublish: true, summary: '公開できます' })
    expect(r.block).toBe(false)
  })

  it('★ preflight 自体が失敗した（ok: false）ときは通す。ただし理由を残す（黙って進めない）', () => {
    const r = shouldBlockPublish({ ok: false, canPublish: true, summary: '確認できませんでした', message: 'ネットワークエラー' })
    expect(r.block).toBe(false)
    expect(r.reason).toBe('ネットワークエラー')
  })

  it('ok: false で message も無いときは、summary か既定の理由が入る（reason が空にならない）', () => {
    const r = shouldBlockPublish({ ok: false, canPublish: true, summary: '' })
    expect(r.block).toBe(false)
    expect(r.reason).toBeTruthy()
  })

  it('ok: false のときは canPublish の値に関係なく止めない（確認できていないだけ）', () => {
    const r = shouldBlockPublish({ ok: false, canPublish: false, summary: 'x', message: 'm' })
    expect(r.block).toBe(false)
  })
})

// ── 配線: AppRunPanel.tsx の startApply が、実際に呼んでいるか（掟10） ───────────────
// 「実装を壊しても素通りしないか」は変異試験で別途確かめる（完了条件(b)）。
describe('配線: startApply（🚀 公開する）が cloud.preflight → shouldBlockPublish → （通れば）plan/apply の順で呼ぶ', () => {
  const panel = readFileSync(join(__dirname, '..', 'src', 'renderer', 'components', 'AppRunPanel.tsx'), 'utf-8')

  it('shouldBlockPublish を src/renderer/publishGate.ts から import している', () => {
    expect(panel).toContain("import { shouldBlockPublish } from '../publishGate'")
  })

  // startApply の関数本体だけを取り出す（tests/cloudApplyScaleWiring.test.ts の callBody と同じ考え方）。
  function callBody(source: string, openBraceAt: number): string {
    let depth = 0
    let i = openBraceAt
    const start = i
    for (; i < source.length; i++) {
      if (source[i] === '{') depth++
      else if (source[i] === '}') { depth--; if (depth === 0) break }
    }
    return source.slice(start, i + 1)
  }

  const startApplyAt = panel.indexOf('const startApply = async () => {')
  const startApplyBody = startApplyAt > 0 ? callBody(panel, panel.indexOf('{', startApplyAt)) : ''

  it('startApply が見つかる', () => {
    expect(startApplyAt).toBeGreaterThan(0)
  })

  it('startApply の中で window.electronAPI.cloud.preflight(projectDir) を呼んでいる', () => {
    expect(startApplyBody).toContain('window.electronAPI.cloud.preflight(projectDir)')
  })

  it('startApply の中で shouldBlockPublish(...).block なら return する（先へ進まない）', () => {
    expect(startApplyBody).toMatch(/shouldBlockPublish\([^)]*\)\.block\)\s*return/)
  })

  it('★ 呼ぶ順: preflight → shouldBlockPublish → block なら return → （通れば）doApply()', () => {
    const preflightAt = startApplyBody.indexOf('window.electronAPI.cloud.preflight(projectDir)')
    const gateAt = startApplyBody.indexOf('shouldBlockPublish(')
    const returnAt = startApplyBody.indexOf('.block) return')
    const doApplyCallAt = startApplyBody.indexOf('await doApply()')
    expect(preflightAt).toBeGreaterThan(-1)
    expect(gateAt).toBeGreaterThan(preflightAt)
    expect(returnAt).toBeGreaterThan(gateAt)
    expect(doApplyCallAt).toBeGreaterThan(returnAt)
  })

  // doApply（🚀 を最終的に実行する側）が cloud.apply を呼ぶこと・startApply より後ろに
  // 定義されていること（呼ぶ順が入れ替わっていない・前後の文字列ごと一意に指す）。
  // doApply の引数はオブジェクト型注釈つき（`applyOpts: { confirmed: boolean; … }`）なので、
  // 単純に「最初の { 」では引数の型の中に入ってしまう。`=> {` を目印に本体の開始を探す。
  const doApplyAt = panel.indexOf('const doApply = async (')
  const doApplyArrowAt = panel.indexOf('=> {', doApplyAt)
  it('doApply は startApply より後ろで定義されている', () => {
    expect(doApplyAt).toBeGreaterThan(startApplyAt)
  })

  it('doApply の中で window.electronAPI.cloud.apply(projectDir, applyOpts) を呼んでいる', () => {
    const doApplyBody = callBody(panel, doApplyArrowAt + 3)
    expect(doApplyBody).toContain('window.electronAPI.cloud.apply(projectDir, applyOpts)')
  })

  it('main 側（cloud:apply ハンドラ）に preflight を迂回する opts（skipPreflight 等）を作っていない（掟10「迂回は作らない」）', () => {
    const cloud = readFileSync(join(__dirname, '..', 'src', 'main', 'ipc', 'cloud.ts'), 'utf-8')
    expect(cloud).not.toMatch(/skipPreflight/)
  })
})
