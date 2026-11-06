// useConfirm.tsx — window.confirm の代わりに ConfirmModal（Koto 様式）を出し、
// Promise<boolean> として答えを返す小さなフック（判断9・2026-09-11）。
//
// 使い方:
//   const { confirm, element } = useConfirm()
//   const ok = await confirm({ title: '…', body: '…', danger: true })
//   if (!ok) return
//   ...実行...
// `element` を呼び出し元コンポーネントの JSX に置くと、confirm() を呼んだときだけ
// ConfirmModal が現れる（open は内部状態で管理する）。
//
// ── 歯止めのロジックには触れない（掟10・2026-09-11 仕様）─────────────────────
// RollbackSection.tsx の runSwitch・AppRunDedicatedPanel.tsx の runCreate・
// main 側の performRollback は、いずれも「confirm が false を返したら実行しない」という
// 歯止めを**同期的な boolean を返す confirm 関数**への注入として持っている
// （2026-09-08〜09 の事故を受けた設計）。ここを非同期（Promise<boolean>）に書き換えると、
// 歯止め側の呼び出し形まで変える必要が出て、固定済みのテスト（tests/rollbackSwitch.test.ts・
// tests/apprunDedicatedActions.test.ts・tests/rollback.test.ts）の対象そのものを触ることになる。
// そこで呼び出し元（RollbackSection 等）は、**先に `await confirm(...)` でユーザーの答えを
// 得てから**、その確定済みの boolean をそのまま返すだけの同期関数（`() => ok`）を
// 各 runXxx の deps.confirm に渡す。runXxx 自身は「confirm は同期で boolean を返す」という
// 前提のまま、一切変更しない。
//
// ── RTL が無いためのテスト方針（掟10・完了条件の変異試験(c)）─────────────────────
// このプロジェクトの vitest は environment: 'node'（jsdom 無し）で、React の実描画・
// クリックを伴うテストが書けない。「ConfirmModal の onConfirm を押さなくても resolve(true)
// してしまう」というありがちな変異（例: onCancel のハンドラを誤って onConfirm と同じ処理に
// 結線する）を検知できるよう、判断そのもの（どちらのボタンが押されたかを boolean へ変換する
// だけの部分）を `resolveConfirm` という純関数に切り出す。tests/useConfirm.test.ts が
// 'confirm' → true・'cancel' → false を固定する。

import { useCallback, useState } from 'react'
import ConfirmModal, { type ConfirmInitialFocus } from './components/ConfirmModal'
import NotifyModal from './components/NotifyModal'
import { createNotifyQueue, type NotifyOptions } from './notifyQueue'

export type { NotifyOptions }

export interface ConfirmOptions {
  title: string
  body: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  /**
   * 最初にフォーカスするボタン。赤い確認（danger）は常にキャンセル。赤くなくてもお金に触れる確認は 'cancel' を渡す
   * （Claude の同意・前のバージョンへ戻す・専有型の公開）。無ければ実行。useConfirmChoices の confirm も同じ型を使う。
   */
  initialFocus?: ConfirmInitialFocus
}

type PendingConfirm = ConfirmOptions & { resolve: (value: boolean) => void }

/**
 * ConfirmModal のどちらのボタンが押されたか（'confirm' | 'cancel'）を、
 * Promise の解決値（boolean）へ変換する（純関数・DOM/React に依存しない）。
 * 「押さなくても true になる」「cancel でも true になる」ような変異を、
 * ここを直接呼ぶテストで検知できるようにする。
 */
export function resolveConfirm(choice: 'confirm' | 'cancel'): boolean {
  return choice === 'confirm'
}

// ── notify（OK が1つだけの通知。window.alert の代わり・0.6.26）──────────────────────────
// 確認（confirm）の `pending` は1つ（呼び手が答えを await してから次へ進む）。通知は続けて呼ばれうるので、
// 待ち行列（notifyQueue.ts）に積み、前の通知が閉じるまで次を出さない（先の Promise を取りこぼさない）。
// useConfirmChoices の `pending` も1つだが、そちらは notify を出さず、使い手（破棄とプロジェクトの削除）は
// 確認を await してから次へ進む直列の流れで、続けて2つ出さない。ここでは直さない。

export function useConfirm() {
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  const [notice, setNotice] = useState<NotifyOptions | null>(null)
  // 待ち行列は初回の1つを使い回す（useState の初期化関数で作る）
  const [queue] = useState(() => createNotifyQueue(setNotice))

  const notify = useCallback((opts: NotifyOptions): Promise<void> => queue.push(opts), [queue])
  const closeNotice = useCallback(() => queue.dismiss(), [queue])

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>(resolve => {
      setPending({ ...opts, resolve })
    })
  }, [])

  const answer = useCallback((choice: 'confirm' | 'cancel') => {
    setPending(current => {
      if (current) current.resolve(resolveConfirm(choice))
      return null
    })
  }, [])

  const element = (
    <>
    <ConfirmModal
      open={pending !== null}
      title={pending?.title ?? ''}
      body={pending?.body ?? ''}
      confirmLabel={pending?.confirmLabel}
      cancelLabel={pending?.cancelLabel}
      danger={pending?.danger}
      initialFocus={pending?.initialFocus}
      onConfirm={() => answer('confirm')}
      onCancel={() => answer('cancel')}
    />
    <NotifyModal
      open={notice !== null}
      title={notice?.title ?? ''}
      body={notice?.body ?? ''}
      okLabel={notice?.okLabel}
      onClose={closeNotice}
    />
    </>
  )

  return { confirm, notify, element }
}
