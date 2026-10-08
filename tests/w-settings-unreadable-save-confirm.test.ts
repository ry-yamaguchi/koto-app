import { describe, it, expect, vi } from 'vitest'
import {
  runSaveWithUnreadableCheck, UNREADABLE_SAVE_CONFIRM_MESSAGE,
} from '../src/renderer/components/CredentialsModal'
import { cleanRemoteError } from '../src/renderer/remoteError'

// ── W-58（2026-09-27決定・案2）: 認証情報を読めなかったときの警告「署名の異なるビルド」が、
// 全カードに繰り返し出る ─────────────────────────────────────────────────
//
// 直す前は、カードごとに同じ長文の赤枠が繰り返され（専門用語も多かった）、しかも読めないまま
// 「保存」を押すと**確認なしで元のキーや設定が消えていた**（空欄に見える入力欄をそのまま保存
// してしまう）。直した後は①画面の上に1回だけ出す・平易な文にする、②読み取れなかったときは
// 「保存」の前に必ず確認する、の2つ。ここでは②（お金・データの歯止め）を振る舞いで固定する
// （掟10）。「保存されているキー」を確認なしに消す事故を防ぐのが目的なので、文字列一致ではなく
// 「confirm が false なら save に触れない」を偽関数で固定する。

describe('W-58: runSaveWithUnreadableCheck（読み取れなかったときは保存前に確認する）', () => {
  it('★ unreadable=true・confirm が false（キャンセル） → save は一度も呼ばれない（元のキーは消えない）', async () => {
    const save = vi.fn()
    const confirm = vi.fn(async () => false)
    const outcome = await runSaveWithUnreadableCheck(true, UNREADABLE_SAVE_CONFIRM_MESSAGE, { confirm, save })
    expect(outcome.cancelled).toBe(true)
    expect(save).not.toHaveBeenCalled()
  })

  it('★ unreadable=true・confirm が true → save がちょうど1回呼ばれる', async () => {
    const save = vi.fn()
    const confirm = vi.fn(async () => true)
    const outcome = await runSaveWithUnreadableCheck(true, UNREADABLE_SAVE_CONFIRM_MESSAGE, { confirm, save })
    expect(outcome.cancelled).toBe(false)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('★ unreadable=false → confirm を呼ばずに、そのまま save を呼ぶ（読み取れているときは従来どおり）', async () => {
    const save = vi.fn()
    const confirm = vi.fn(async () => false) // false を返しても素通りするはず
    const outcome = await runSaveWithUnreadableCheck(false, UNREADABLE_SAVE_CONFIRM_MESSAGE, { confirm, save })
    expect(outcome.cancelled).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
    expect(save).toHaveBeenCalledTimes(1)
  })
})

// ── W-59（2026-09-27決定）: 接続テストの失敗に、Electron の ipcRenderer.invoke が付ける英語の頭
// （Error invoking remote method '…': Error: ）がそのまま出ていた ──────────────────────
describe('W-59: cleanRemoteError（ipcRenderer.invoke の英語の頭を取り除く）', () => {
  it('★ "Error invoking remote method \'…\': Error: " の頭を取り除く', () => {
    const e = new Error("Error invoking remote method 'sakura:models': Error: APIキーが正しくないようです")
    expect(cleanRemoteError(e)).toBe('APIキーが正しくないようです')
  })

  it('頭が付いていないメッセージはそのまま返す', () => {
    const e = new Error('インターネット接続を確認してください')
    expect(cleanRemoteError(e)).toBe('インターネット接続を確認してください')
  })

  it('Error オブジェクトでなくても壊れない', () => {
    expect(cleanRemoteError('プレーンな文字列')).toBe('プレーンな文字列')
    expect(cleanRemoteError(undefined)).toBe('undefined')
  })
})
