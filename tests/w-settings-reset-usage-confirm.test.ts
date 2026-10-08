import { describe, it, expect, vi } from 'vitest'
import { runResetUsageWithConfirm, RESET_USAGE_CONFIRM_MESSAGE } from '../src/renderer/components/SettingsModal'

// ── W-51（2026-09-27決定・案1）: 設定の「リセット」が、何を消すか書いていない（押すと上限の
// 停止も外れる）─────────────────────────────────────────────────────
//
// 直す前は、押すと確認なしで即座に resetThisMonth()（今月の全キーの記録を0に戻す＝上限で
// 止まっていた AI がまた動き出す）が呼ばれていた。直した後はボタン名を「今月の記録を0に戻す」に
// 変え、押す前に必ず確認する（ConfirmModal・掟5）。
//
// ここは useConfirm.tsx や confirmedActions.ts の gate と同型: 「confirm が false（キャンセル）なら
// reset には一切触れない」ことを、偽の confirm/reset 関数で固定する（文字列一致ではなく振る舞い・
// 掟10）。「if (false && !ok) return」のような変異（確認を無視して常に reset する）を検知できる。

describe('W-51: runResetUsageWithConfirm（今月の記録を0に戻す前の確認ゲート）', () => {
  it('★ confirm が false（キャンセル）なら reset は一度も呼ばれない', async () => {
    const reset = vi.fn()
    const confirm = vi.fn(async () => false)
    const outcome = await runResetUsageWithConfirm(RESET_USAGE_CONFIRM_MESSAGE, { confirm, reset })
    expect(outcome.cancelled).toBe(true)
    expect(reset).not.toHaveBeenCalled()
  })

  it('★ confirm が true なら reset がちょうど1回呼ばれる', async () => {
    const reset = vi.fn()
    const confirm = vi.fn(async () => true)
    const outcome = await runResetUsageWithConfirm(RESET_USAGE_CONFIRM_MESSAGE, { confirm, reset })
    expect(outcome.cancelled).toBe(false)
    expect(reset).toHaveBeenCalledTimes(1)
  })

  it('confirm には、何が起きるかを説明する文面が渡される', async () => {
    const seen: string[] = []
    await runResetUsageWithConfirm(RESET_USAGE_CONFIRM_MESSAGE, {
      confirm: async (msg) => { seen.push(msg); return false },
      reset: vi.fn(),
    })
    expect(seen[0]).toContain('0に戻')
    expect(seen[0]).toContain('上限') // 上限による停止も解除される、と伝える
  })
})
