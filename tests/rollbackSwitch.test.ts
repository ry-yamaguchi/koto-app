import { describe, it, expect, vi } from 'vitest'
import { runSwitch, buildSwitchConfirmMessage } from '../src/renderer/rollbackSwitch'

// rollbackSwitch.test.ts — RollbackSection.tsx の確認ゲートを、React/DOM から切り離して
// 振る舞いで固定する（2026-09-08 検分で指摘。★変異試験②に対応）。
//
// confirm・rollback を注入で受け取るので jsdom は要らない。「confirm が false（キャンセル）を
// 返したとき、rollback が一度も呼ばれないこと」を偽の関数で確かめる——文字列一致
// （`if (!window.confirm(` が残っているか等）ではなく、実際の呼び出し回数で見る。

describe('buildSwitchConfirmMessage: 確認文言', () => {
  it('特定バージョンへの切り替え文言に、表示名を含む', () => {
    const msg = buildSwitchConfirmMessage({ versionName: 'v2', label: 'v2', isSplit: false })
    expect(msg).toContain('『v2』に切り替わります')
  })

  it('最新に戻す（versionName: null）ときの文言', () => {
    const msg = buildSwitchConfirmMessage({ versionName: null, label: '最新のバージョン', isSplit: false })
    expect(msg).toContain('最新のバージョンに自動で追従する状態へ戻します')
  })

  // 3【中】: split のときは「いまの配分（複数バージョンへの分散）は失われます」を確認文に含める
  // （★変異試験④はこの文言をソースから削る形で当てる）。
  it('isSplit:true のときは「配分は失われます」を含む', () => {
    const msg = buildSwitchConfirmMessage({ versionName: 'v2', label: 'v2', isSplit: true })
    expect(msg).toContain('いまの配分（複数バージョンへの分散）は失われます')
  })

  it('isSplit:false のときは含まない（latest/pinned から切り替えるだけなら、この注記は不要）', () => {
    const msg = buildSwitchConfirmMessage({ versionName: 'v2', label: 'v2', isSplit: false })
    expect(msg).not.toContain('配分')
  })
})

describe('runSwitch: confirm を通らなければ rollback は一切呼ばれない（★変異試験②）', () => {
  it('confirm が false を返すと rollback は呼ばれず、proceeded:false を返す', async () => {
    const rollback = vi.fn()
    const outcome = await runSwitch(
      { versionName: 'v2', label: 'v2', isSplit: false },
      { confirm: () => false, rollback },
    )
    expect(rollback).not.toHaveBeenCalled()
    expect(outcome).toEqual({ proceeded: false })
  })

  it('confirm が true を返すと rollback を { confirmed: true } で1回だけ呼ぶ', async () => {
    const rollback = vi.fn().mockResolvedValue({ ok: true })
    const outcome = await runSwitch(
      { versionName: 'v2', label: 'v2', isSplit: false },
      { confirm: () => true, rollback },
    )
    expect(rollback).toHaveBeenCalledTimes(1)
    expect(rollback).toHaveBeenCalledWith('v2', { confirmed: true })
    expect(outcome).toEqual({ proceeded: true, result: { ok: true } })
  })

  it('confirm には buildSwitchConfirmMessage の文言が渡る（確認文と実行が同じリクエストに基づく）', async () => {
    const confirm = vi.fn().mockReturnValue(false)
    await runSwitch({ versionName: null, label: '最新のバージョン', isSplit: false }, { confirm, rollback: vi.fn() })
    expect(confirm).toHaveBeenCalledWith(buildSwitchConfirmMessage({ versionName: null, label: '最新のバージョン', isSplit: false }))
  })
})
