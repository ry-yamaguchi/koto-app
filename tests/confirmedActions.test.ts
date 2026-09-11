import { describe, it, expect, vi } from 'vitest'
import {
  runClearConversation,
  runDeleteConversation,
  runCloseUnsaved,
  runDiscardCredentialEdits,
  runEraseVpsKey,
} from '../src/renderer/confirmedActions'

// confirmedActions.test.ts — 元に戻せない5操作（会話の全削除／会話の削除／未保存タブを破棄して閉じる／
// 未保存の認証情報編集を破棄／VPSの鍵を消去）の confirm→実行ゲートを、React/DOM から切り離して
// 振る舞いで固定する（UX-B3・tests/rollbackSwitch.test.ts・tests/apprunDedicatedActions.test.ts と同型）。
//
// confirm・実行（clear/remove/close/discard/erase）を注入で受け取るので jsdom は要らない。
// 「confirm が false（キャンセル）を返したとき、実行が一度も呼ばれないこと」を偽の関数の
// 呼び出し回数で確かめる——文字列一致（`if (!ok) return` が残っているか等）ではない（掟10・
// 2026-09-11 担当の申告: `if (!ok) return` を `if (false && !ok) return` に変えても
// UX-B2 の文字列テストは素通りした）。

describe('runClearConversation: confirm を通らなければ clear は一切呼ばれない', () => {
  it('confirm が false を返すと clear は呼ばれず、{cancelled:true} を返す', async () => {
    const clear = vi.fn()
    const outcome = await runClearConversation('この会話をすべて削除します。よろしいですか？（元に戻せません）', {
      confirm: async () => false,
      clear,
    })
    expect(clear).not.toHaveBeenCalled()
    expect(outcome).toEqual({ cancelled: true })
  })

  it('confirm が true を返すと clear を1回だけ呼ぶ', async () => {
    const clear = vi.fn()
    const outcome = await runClearConversation('この会話をすべて削除します。よろしいですか？（元に戻せません）', {
      confirm: async () => true,
      clear,
    })
    expect(clear).toHaveBeenCalledTimes(1)
    expect(outcome).toEqual({ cancelled: false, result: undefined })
  })

  it('confirm には message がそのまま渡る', async () => {
    const confirm = vi.fn().mockResolvedValue(false)
    await runClearConversation('確認文言X', { confirm, clear: vi.fn() })
    expect(confirm).toHaveBeenCalledWith('確認文言X')
  })
})

describe('runDeleteConversation: confirm を通らなければ remove は一切呼ばれない', () => {
  it('confirm が false を返すと remove は呼ばれず、{cancelled:true} を返す', async () => {
    const remove = vi.fn()
    const outcome = await runDeleteConversation('sess-1', '「会話A」を削除します。よろしいですか？（元に戻せません）', {
      confirm: async () => false,
      remove,
    })
    expect(remove).not.toHaveBeenCalled()
    expect(outcome).toEqual({ cancelled: true })
  })

  it('confirm が true を返すと remove を id で1回だけ呼ぶ', async () => {
    const remove = vi.fn()
    const outcome = await runDeleteConversation('sess-1', '「会話A」を削除します。よろしいですか？（元に戻せません）', {
      confirm: async () => true,
      remove,
    })
    expect(remove).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith('sess-1')
    expect(outcome).toEqual({ cancelled: false, result: undefined })
  })

  it('confirm には message がそのまま渡る', async () => {
    const confirm = vi.fn().mockResolvedValue(false)
    await runDeleteConversation('sess-1', '確認文言Y', { confirm, remove: vi.fn() })
    expect(confirm).toHaveBeenCalledWith('確認文言Y')
  })
})

describe('runCloseUnsaved: confirm を通らなければ close は一切呼ばれない', () => {
  it('confirm が false を返すと close は呼ばれず、{cancelled:true} を返す', async () => {
    const close = vi.fn()
    const outcome = await runCloseUnsaved('/proj/a.txt', '「a.txt」には保存していない変更があります。保存せずに閉じますか？', {
      confirm: async () => false,
      close,
    })
    expect(close).not.toHaveBeenCalled()
    expect(outcome).toEqual({ cancelled: true })
  })

  it('confirm が true を返すと close を path で1回だけ呼ぶ', async () => {
    const close = vi.fn()
    const outcome = await runCloseUnsaved('/proj/a.txt', '「a.txt」には保存していない変更があります。保存せずに閉じますか？', {
      confirm: async () => true,
      close,
    })
    expect(close).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledWith('/proj/a.txt')
    expect(outcome).toEqual({ cancelled: false, result: undefined })
  })

  it('confirm には message がそのまま渡る', async () => {
    const confirm = vi.fn().mockResolvedValue(false)
    await runCloseUnsaved('/proj/a.txt', '確認文言Z', { confirm, close: vi.fn() })
    expect(confirm).toHaveBeenCalledWith('確認文言Z')
  })
})

describe('runDiscardCredentialEdits: confirm を通らなければ discard は一切呼ばれない', () => {
  it('confirm が false を返すと discard は呼ばれず、{cancelled:true} を返す', async () => {
    const discard = vi.fn()
    const outcome = await runDiscardCredentialEdits('保存していない変更があります。破棄して閉じますか？', {
      confirm: async () => false,
      discard,
    })
    expect(discard).not.toHaveBeenCalled()
    expect(outcome).toEqual({ cancelled: true })
  })

  it('confirm が true を返すと discard を1回だけ呼ぶ', async () => {
    const discard = vi.fn()
    const outcome = await runDiscardCredentialEdits('保存していない変更があります。破棄して閉じますか？', {
      confirm: async () => true,
      discard,
    })
    expect(discard).toHaveBeenCalledTimes(1)
    expect(outcome).toEqual({ cancelled: false, result: undefined })
  })

  it('confirm には message がそのまま渡る', async () => {
    const confirm = vi.fn().mockResolvedValue(false)
    await runDiscardCredentialEdits('確認文言W', { confirm, discard: vi.fn() })
    expect(confirm).toHaveBeenCalledWith('確認文言W')
  })
})

describe('runEraseVpsKey: confirm を通らなければ erase は一切呼ばれない（★変異試験(b)）', () => {
  it('confirm が false を返すと erase は呼ばれず、{cancelled:true} を返す', async () => {
    const erase = vi.fn()
    const outcome = await runEraseVpsKey('entry-1', '鍵を消去します（再生成が必要になります）。よろしいですか？', {
      confirm: async () => false,
      erase,
    })
    expect(erase).not.toHaveBeenCalled()
    expect(outcome).toEqual({ cancelled: true })
  })

  it('confirm が true を返すと erase を entryId で1回だけ呼ぶ', async () => {
    const erase = vi.fn()
    const outcome = await runEraseVpsKey('entry-1', '鍵を消去します（再生成が必要になります）。よろしいですか？', {
      confirm: async () => true,
      erase,
    })
    expect(erase).toHaveBeenCalledTimes(1)
    expect(erase).toHaveBeenCalledWith('entry-1')
    expect(outcome).toEqual({ cancelled: false, result: undefined })
  })

  it('confirm には message がそのまま渡る', async () => {
    const confirm = vi.fn().mockResolvedValue(false)
    await runEraseVpsKey('entry-1', '確認文言V', { confirm, erase: vi.fn() })
    expect(confirm).toHaveBeenCalledWith('確認文言V')
  })
})
