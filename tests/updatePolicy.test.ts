import { describe, it, expect } from 'vitest'
import {
  canApplyNow, shouldCheckOnStartup, updateStatusText, shouldHighlight,
  type UpdateState,
} from '../src/shared/updatePolicy'

// 自動更新の事故は「勝手に再起動されて作業が消える」形で起きる。
// Koto の利用者は非エンジニアで、消えたものを自力で復旧できない。
// ここで守る不変条件は1つ:「作業中は絶対に再起動しない」。

const downloaded: UpdateState = { kind: 'downloaded', version: '0.4.0' }

describe('いま再起動して適用してよいか', () => {
  it('準備ができていて、何もしていなければ適用してよい', () => {
    expect(canApplyNow({ state: downloaded, isBusy: false, hasUnsavedChanges: false })).toEqual({ ok: true })
  })

  // ここが本丸。更新は待てるが、失われた作業は戻らない
  it('処理を実行中なら断る', () => {
    const r = canApplyNow({ state: downloaded, isBusy: true, busyLabel: 'AIの応答', hasUnsavedChanges: false })
    expect(r.ok).toBe(false)
    expect(r).toHaveProperty('reason', 'busy')
    if (!r.ok) expect(r.message).toContain('AIの応答')
  })

  it('未保存の変更があれば断る', () => {
    const r = canApplyNow({ state: downloaded, isBusy: false, hasUnsavedChanges: true })
    expect(r.ok).toBe(false)
    expect(r).toHaveProperty('reason', 'unsaved')
  })

  // 実行中の中断の方が実害が大きいので、理由として先に出す
  it('実行中と未保存が重なったら「実行中」を理由にする', () => {
    const r = canApplyNow({ state: downloaded, isBusy: true, busyLabel: '公開処理', hasUnsavedChanges: true })
    expect(r).toHaveProperty('reason', 'busy')
  })

  it('ダウンロードが終わっていなければ適用しない', () => {
    for (const state of [
      { kind: 'idle' }, { kind: 'checking' }, { kind: 'none' },
      { kind: 'available', version: '0.4.0' },
      { kind: 'downloading', version: '0.4.0', percent: 50 },
      { kind: 'error', message: 'x' },
    ] as UpdateState[]) {
      const r = canApplyNow({ state, isBusy: false, hasUnsavedChanges: false })
      expect(r.ok).toBe(false)
      expect(r).toHaveProperty('reason', 'not-downloaded')
    }
  })

  it('断るときは必ず理由を伝える（黙って何も起きないようにしない）', () => {
    for (const opts of [
      { state: downloaded, isBusy: true, hasUnsavedChanges: false },
      { state: downloaded, isBusy: false, hasUnsavedChanges: true },
      { state: { kind: 'idle' } as UpdateState, isBusy: false, hasUnsavedChanges: false },
    ]) {
      const r = canApplyNow(opts)
      if (!r.ok) expect(r.message.length).toBeGreaterThan(0)
    }
  })
})

describe('起動時に自動で確認するか', () => {
  it('パッケージ版で、設定が有効なら確認する', () => {
    expect(shouldCheckOnStartup({ isPackaged: true, enabled: true })).toBe(true)
  })

  // 開発中は配信元に開発版が無く、毎回エラーになるだけ
  it('開発中は確認しない', () => {
    expect(shouldCheckOnStartup({ isPackaged: false, enabled: true })).toBe(false)
  })

  it('設定で切っていれば確認しない', () => {
    expect(shouldCheckOnStartup({ isPackaged: true, enabled: false })).toBe(false)
  })
})

describe('利用者に見せる文', () => {
  it('ダウンロード済みは「次回起動で切り替わる」と伝える（勝手に再起動しないことを明示）', () => {
    const t = updateStatusText(downloaded)
    expect(t).toContain('0.4.0')
    expect(t).toContain('次に Koto を起動したとき')
  })

  it('進行中は割合を出す', () => {
    expect(updateStatusText({ kind: 'downloading', version: '0.4.0', percent: 42.7 })).toContain('43%')
  })

  it('最新なら、そう伝える（無言で終わらせない）', () => {
    expect(updateStatusText({ kind: 'none' })).toContain('最新')
  })

  it('失敗したら原因を添える', () => {
    expect(updateStatusText({ kind: 'error', message: 'ネットワークに接続できません' }))
      .toContain('ネットワークに接続できません')
  })

  it('待機中は何も言わない（常時何か出ていると読まれなくなる）', () => {
    expect(updateStatusText({ kind: 'idle' })).toBe('')
  })

  // v0.2.98 の教訓。画面には素のテキストとして描画される
  it('文言に Markdown 記法を混ぜない', () => {
    const states: UpdateState[] = [
      { kind: 'checking' }, { kind: 'none' },
      { kind: 'available', version: '0.4.0' },
      { kind: 'downloading', version: '0.4.0', percent: 10 },
      downloaded,
      { kind: 'error', message: 'x' },
    ]
    for (const s of states) expect(updateStatusText(s)).not.toMatch(/\*\*|__|`/)
  })
})

describe('画面で強調するか', () => {
  it('準備ができたときだけ強調する', () => {
    expect(shouldHighlight(downloaded)).toBe(true)
  })

  it('確認中や進行中は強調しない（利用者にできることが無い）', () => {
    expect(shouldHighlight({ kind: 'checking' })).toBe(false)
    expect(shouldHighlight({ kind: 'downloading', version: '0.4.0', percent: 10 })).toBe(false)
    expect(shouldHighlight({ kind: 'none' })).toBe(false)
    expect(shouldHighlight({ kind: 'idle' })).toBe(false)
  })
})
