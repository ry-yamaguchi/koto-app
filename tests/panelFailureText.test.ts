import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { failureText } from '../src/shared/failureText'
import { splitFailureDetail } from '../src/shared/failureDetail'

// 公開まわりのパネルが、失敗の文を failureText(e) で作ることを固める。
// 読み取り（接続テスト・一覧・状態の確認）は readOnly: true、書き込み（作る・公開する・切り替える）は既定の慎重な文。
// 公開の操作は確かめる場所（📡 公開したもの一覧）を渡す。呼び出しの形ごと書き、直す前の形は not.toContain で禁じる。

const read = (rel: string): string => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8')
const COMP = 'src/renderer/components/'
const OLD = 'e?.message ?? String(e)'
const CK = "{ checkAt: '📡 公開したもの一覧' }"

const SHAPES: Array<[string, string[]]> = [
  ['AppRunDedicatedPanel.tsx', [
    'setConnMsg(failureText(e, { readOnly: true }))',
    'const msg = failureText(e, { readOnly: true })\n      setCheckError(msg)',
    'setAppStatusError(failureText(e, { readOnly: true }))',
    `setCreateResult({ ok: false, stage: 'consent', message: failureText(e, ${CK}) } as any)`,
    'setScaffoldError(failureText(e))',
    `setPublishResult({ ok: false, stage: 'consent', message: failureText(e, ${CK}) } as any)`,
    'setLbRefreshError(failureText(e, { readOnly: true }))',
    'setSiteCheckError(failureText(e, { readOnly: true }))',
    'setTelemetryError(failureText(e, { readOnly: true }))',
  ]],
  ['HanamiiPanel.tsx', [
    '保存できませんでした: ${failureText(e)}',
    `公開処理でエラーが発生しました: \${failureText(e, ${CK})}`,
  ]],
  ['VercelPanel.tsx', [
    "message: failureText(e, { readOnly: true }) }) }",
    '保存できませんでした: ${failureText(e)}',
    `公開処理でエラーが発生しました: \${failureText(e, ${CK})}`,
  ]],
  ['RollbackSection.tsx', [
    'errMsg = failureText(e, { readOnly: true })',
    'setActionMsg(wrapFailureText(failureText(e), t => `⚠️ ${t}`))',
  ]],
  ['ImportFromPublishedPanel.tsx', [
    "setError(failureText(e, { readOnly: true }))\n    } finally {",
    "setError(failureText(e, { readOnly: true })); setLoading(false)",
    "setError(failureText(e, { readOnly: true })); setSelected(null)",
    "setError(failureText(e, { checkAt: 'ファイル一覧' })); setStep('confirm')",
  ]],
]

describe('公開まわりのパネルの失敗の文', () => {
  for (const [file, shapes] of SHAPES) {
    it(`${file}: 失敗の文は failureText を通し、生の書き方は残さない`, () => {
      const src = read(COMP + file)
      expect(src).toContain("import { failureText } from '../../shared/failureText'")
      for (const shape of shapes) expect(src).toContain(shape)
      expect(src).not.toContain(OLD)
    })
  }

  it('書き込みの途中で切れたら「もう一度」とは言わず、確かめる場所を言う', () => {
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    const shown = splitFailureDetail(failureText(reset, { checkAt: '📡 公開したもの一覧' }))
    expect(shown.text).toBe(
      '通信が途中で切れました。操作が済んだかは確かめられていません。少し待ってから、📡 公開したもの一覧で状態を確かめてください。')
    expect(shown.detail).toContain('ECONNRESET')
    expect(failureText(reset)).toContain('この画面を開き直して')
  })

  it('読み取りは時間切れを「少し待ってから、もう一度」と言い、IPC の頭は落ちる', () => {
    const e = new Error("Error invoking remote method 'cloud:x': TimeoutError: The operation was aborted due to timeout")
    e.name = 'TimeoutError'
    const t = failureText(e, { readOnly: true })
    expect(t).toContain('時間内に返事がありませんでした')
    expect(t).not.toContain('Error invoking')
    expect(failureText(new Error("Error invoking remote method 'a:b': Error: boom"), { readOnly: true })).toBe('boom')
  })
})
