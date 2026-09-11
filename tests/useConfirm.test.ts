import { describe, it, expect } from 'vitest'
import { resolveConfirm } from '../src/renderer/useConfirm'

// useConfirm.tsx は React フックなので、このプロジェクトの vitest（environment: 'node'、
// React Testing Library 無し）では実際にモーダルを描画してクリックすることができない。
// そこで「ConfirmModal のどちらのボタンが押されたか → boolean」という判断だけを
// resolveConfirm という純関数に切り出し（掟10）、ここで直接固定する。
//
// 完了条件の変異試験(c): 「ConfirmModal の onConfirm を押さなくても resolve(true) する」
// という変異（例: 'cancel' でも true を返してしまう・choice を見ずに常に true を返す）を、
// 'cancel' → false を明示的に固定することで検知する。

describe('resolveConfirm: ConfirmModal の選択を boolean へ変換する（純関数）', () => {
  it("'confirm'（実行する側のボタン）は true", () => {
    expect(resolveConfirm('confirm')).toBe(true)
  })

  it("'cancel'（やめる側のボタン）は false — 押さなくても true にならないことの固定", () => {
    expect(resolveConfirm('cancel')).toBe(false)
  })

  it('confirm と cancel は必ず異なる結果を返す（常に true を返す変異の検知）', () => {
    expect(resolveConfirm('confirm')).not.toBe(resolveConfirm('cancel'))
  })
})
