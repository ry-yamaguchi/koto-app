import { describe, it, expect } from 'vitest'
import { makeSwitchDeps } from '../src/renderer/components/RollbackSection'
import { runSwitch } from '../src/renderer/rollbackSwitch'

// 2026-09-10 検分の直し: tests/apprunTraffic.test.ts の
// `toContain('confirm: (msg) => window.confirm(msg)')` は文字列一致でしか、
// 「本物の window.confirm・window.electronAPI.cloud.rollback を注入しているか」を
// 守れていなかった。DOM を実際にクリックして確かめるテスト基盤（jsdom 等）がこの
// プロジェクトには無いため、RollbackSection.tsx から deps の組み立てだけを
// `makeSwitchDeps(projectDir, onRollbackStart, confirmed)` として切り出し、ここで
// **実際に呼んで**振る舞いを固定する（掟10）。
//
// 2026-09-11（判断9）: window.confirm → ConfirmModal（useConfirm）。ConfirmModal は
// React の状態更新とクリック待ちを伴うため本質的に非同期で、makeSwitchDeps へ「確認関数」を
// 注入する形では固定できなくなった。かわりに doSwitch は ConfirmModal を**先に**待ち、
// 確定した答え（boolean）を makeSwitchDeps の第3引数 `confirmed` として渡す——
// ここでは「その boolean が SwitchDeps.confirm として一切いじられずにそのまま runSwitch へ
// 伝わる（＝ false なら rollback は一度も呼ばれない）」ことを固定する。window.electronAPI を
// 直接呼ぶのは deps.rollback だけなので、それだけ最小限の window スタブを用意する。
async function withWindow<T>(
  stub: { rollback: (...args: unknown[]) => Promise<{ ok: boolean; message?: string }> },
  fn: () => T | Promise<T>,
): Promise<T> {
  const original = (globalThis as any).window
  ;(globalThis as any).window = { electronAPI: { cloud: { rollback: stub.rollback } } }
  try {
    return await fn()
  } finally {
    (globalThis as any).window = original
  }
}

describe('makeSwitchDeps: ConfirmModal で確定済みの答え（confirmed）を confirm として注入し、rollback は本物の electronAPI.cloud.rollback を呼ぶ', () => {
  it('confirmed=true のとき、deps.confirm() は true を返す（message は無視してよい）', async () => {
    await withWindow({ rollback: async () => ({ ok: true }) }, () => {
      const deps = makeSwitchDeps('/proj', () => {}, true)
      expect(deps.confirm('どんな文言でも')).toBe(true)
    })
  })

  it('confirmed=false のとき、deps.confirm() は false を返す', async () => {
    await withWindow({ rollback: async () => { throw new Error('呼ばれてはいけない') } }, () => {
      const deps = makeSwitchDeps('/proj', () => {}, false)
      expect(deps.confirm('x')).toBe(false)
    })
  })

  it('deps.rollback は window.electronAPI.cloud.rollback へ projectDir・versionName・opts をそのまま渡す', async () => {
    let seenArgs: unknown[] = []
    await withWindow(
      { rollback: async (...args: unknown[]) => { seenArgs = args; return { ok: true } } },
      async () => {
        const deps = makeSwitchDeps('/proj-x', () => {}, true)
        const r = await deps.rollback('v2', { confirmed: true })
        expect(seenArgs).toEqual(['/proj-x', 'v2', { confirmed: true }])
        expect(r).toEqual({ ok: true })
      },
    )
  })

  it('deps.rollback を呼ぶ直前に onRollbackStart(versionName) を呼ぶ（busy 表示の配線）', async () => {
    const started: (string | null)[] = []
    await withWindow({ rollback: async () => ({ ok: true }) }, async () => {
      const deps = makeSwitchDeps('/proj', (v) => started.push(v), true)
      await deps.rollback('v9', { confirmed: true })
      expect(started).toEqual(['v9'])
    })
  })

  it('「最新に戻す」（versionName:null）でも onRollbackStart(null) がそのまま渡る', async () => {
    const started: (string | null)[] = []
    await withWindow({ rollback: async () => ({ ok: true }) }, async () => {
      const deps = makeSwitchDeps('/proj', (v) => started.push(v), true)
      await deps.rollback(null, { confirmed: true })
      expect(started).toEqual([null])
    })
  })

  // ══════════════════════════════════════════════════════════════════════
  // ★ ここが核心（2026-09-08 検分・確認ダイアログを無視する変異の対。2026-09-11に
  //   ConfirmModal 化しても同じ歯止めが効くことを固定し直す）。
  //   runSwitch 自体は tests/rollbackSwitch.test.ts で固定済みだが、ここでは
  //   RollbackSection.tsx が実際に組み立てる deps（makeSwitchDeps）を経由しても
  //   同じ歯止めが効くことを確かめる（「呼び出しの形」ではなく実際の呼び出しで）。
  // ══════════════════════════════════════════════════════════════════════
  it('★ confirmed=false（ConfirmModal でキャンセル）→ rollback は一度も呼ばれない（onRollbackStart も呼ばれない）', async () => {
    const started: (string | null)[] = []
    let rollbackCalled = false
    await withWindow(
      { rollback: async () => { rollbackCalled = true; return { ok: true } } },
      async () => {
        const deps = makeSwitchDeps('/proj', (v) => started.push(v), false)
        const outcome = await runSwitch({ versionName: 'v1', label: 'v1', isSplit: false }, deps)
        expect(outcome.proceeded).toBe(false)
        expect(started).toEqual([])
        expect(rollbackCalled).toBe(false)
      },
    )
  })

  it('confirmed=true（ConfirmModal で実行を選択）→ rollback が呼ばれる（対になる確認）', async () => {
    let rollbackCalled = false
    await withWindow(
      { rollback: async () => { rollbackCalled = true; return { ok: true } } },
      async () => {
        const deps = makeSwitchDeps('/proj', () => {}, true)
        const outcome = await runSwitch({ versionName: 'v1', label: 'v1', isSplit: false }, deps)
        expect(outcome.proceeded).toBe(true)
        expect(rollbackCalled).toBe(true)
      },
    )
  })
})
