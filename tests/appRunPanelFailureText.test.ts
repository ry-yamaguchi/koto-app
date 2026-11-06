import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { failureText } from '../src/shared/failureText'
import { isNameConflictError, isCreationLimitError } from '../src/renderer/nameConflict'

// AppRunPanel（共用型の公開画面）の失敗の文を failureText(e) で作ることを固める。
// 読み取り（確認・一覧・計画）は readOnly: true、書き込み（保存・作る・公開・削除）は既定の慎重な文。
// 呼び出しの形ごと書き、直す前の形は not.toContain で禁じる。

const src = fs.readFileSync(path.resolve(__dirname, '..', 'src/renderer/components/AppRunPanel.tsx'), 'utf-8')
const RO = '{ readOnly: true }'

// [形, 出現数]。同じ形が複数ある行（setEnvError など）は、1か所だけ readOnly にしたり戻したりしても数が変わるので検出できる。
const SHAPES: Array<[string, number]> = [
  [`summary: '確認できませんでした', checks: [], message: failureText(e, ${RO}) }) }`, 1],
  [`pf = { ok: false, canPublish: true, summary: '確認できませんでした', checks: [], message: failureText(e, ${RO}) } }`, 1],
  [`setSpec(null); setEnvError(failureText(e, ${RO}))`, 1],
  [`setRecheck({ healthy: false, note: failureText(e, ${RO}) })`, 1],
  [`setLimitMsg(failureText(e, ${RO}))`, 1],
  [`setCost({ message: failureText(e, ${RO}) })`, 1],
  [`setPlanError(failureText(e, ${RO}))`, 2],
  [`setOpResult({ ok: false, message: failureText(e, ${RO}) })`, 1],
  ['自動作成に失敗しました: ${failureText(e)}', 1],
  ['setOpResult({ ok: false, message: failureText(e) })', 1],
  // 古いイメージの削除（書き込み）。main の記録に載らず開き直しても分からないので、確かめる先を画面名で言う
  ["shown = { ok: false, message: failureText(e, { checkAt: '「🧹 古いイメージを削除する」の一覧' }) }", 1],
  ['setLimitMsg(failureText(e))', 1],
  ['setEnvError(failureText(e))', 5],
]
const countOf = (shape: string): number => src.split(shape).length - 1

describe('AppRunPanel の失敗の文', () => {
  it('失敗の文は failureText を通し、生の書き方は残さない', () => {
    expect(src).toContain("import { failureText } from '../../shared/failureText'")
    for (const [shape, n] of SHAPES) expect(countOf(shape), shape).toBe(n)
    expect(src).not.toContain('shown = { ok: false, message: failureText(e) }')
    expect(src).not.toContain('e?.message ?? String(e)')
  })

  it('衝突カード・上限カードの判定は failureText を通した文でも出続ける（IPC の頭は落ちる）', () => {
    const head = "Error invoking remote method 'cloud:apply': Error: "
    const conflict = failureText(new Error(`${head}公開に失敗しました（HTTP 409）: {"message":"x"}`))
    expect(conflict).not.toContain('Error invoking remote method')
    expect(isNameConflictError(conflict)).toBe(true)
    const limit = failureText(new Error(`${head}{"reason":"violates application restriction","message":"Creation limit reached."}`))
    expect(isCreationLimitError(limit)).toBe(true)
    expect(isCreationLimitError(failureText(new Error('Creation limit reached.'), { readOnly: true }))).toBe(true)
    expect(isNameConflictError(failureText(new Error('公開に失敗しました（HTTP 409）')))).toBe(true)
  })

  it('カードの判定は opResult.message をそのまま当てている', () => {
    // 詳細の行（原文）が付いても判定が変わらないよう、文の部分だけを当てる
    expect(src).toContain("isNameConflictError(splitFailureDetail(opResult.message ?? '').text)")
    expect(src).toContain("isCreationLimitError(splitFailureDetail(opResult.message ?? '').text)")
  })
})
