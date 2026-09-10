import { describe, it, expect } from 'vitest'
import { makeSwitchDeps } from '../src/renderer/components/RollbackSection'
import { runSwitch } from '../src/renderer/rollbackSwitch'

// 2026-09-10 検分の直し: tests/apprunTraffic.test.ts の
// `toContain('confirm: (msg) => window.confirm(msg)')` は文字列一致でしか、
// 「本物の window.confirm・window.electronAPI.cloud.rollback を注入しているか」を
// 守れていなかった。DOM を実際にクリックして確かめるテスト基盤（jsdom 等）がこの
// プロジェクトには無いため、RollbackSection.tsx から deps の組み立てだけを
// `makeSwitchDeps(projectDir, onRollbackStart)` として切り出し（RollbackSection.tsx への
// 変更はこの切り出しだけ）、ここで**実際に呼んで**振る舞いを固定する（掟10）。
//
// environment が 'node'（jsdom 無し）のため、`window` を最小限のオブジェクトとして
// 差し替える。差し替え・復元は必ず対にする（他のテストへ漏らさない）。
async function withWindow<T>(
  stub: { confirm: (msg: string) => boolean; rollback: (...args: unknown[]) => Promise<{ ok: boolean; message?: string }> },
  fn: () => T | Promise<T>,
): Promise<T> {
  const original = (globalThis as any).window
  ;(globalThis as any).window = { confirm: stub.confirm, electronAPI: { cloud: { rollback: stub.rollback } } }
  try {
    return await fn()
  } finally {
    (globalThis as any).window = original
  }
}

describe('makeSwitchDeps: 本物の window.confirm・window.electronAPI.cloud.rollback を注入する', () => {
  it('deps.confirm は window.confirm をそのまま呼び、結果もそのまま返す', async () => {
    const seen: string[] = []
    await withWindow({ confirm: (msg) => { seen.push(msg); return true }, rollback: async () => ({ ok: true }) }, () => {
      const deps = makeSwitchDeps('/proj', () => {})
      expect(deps.confirm('本当に戻しますか？')).toBe(true)
      expect(seen).toEqual(['本当に戻しますか？'])
    })
  })

  it('window.confirm が false を返す設定なら、deps.confirm もそのまま false を返す', async () => {
    await withWindow({ confirm: () => false, rollback: async () => { throw new Error('呼ばれてはいけない') } }, () => {
      const deps = makeSwitchDeps('/proj', () => {})
      expect(deps.confirm('x')).toBe(false)
    })
  })

  it('deps.rollback は window.electronAPI.cloud.rollback へ projectDir・versionName・opts をそのまま渡す', async () => {
    let seenArgs: unknown[] = []
    await withWindow(
      { confirm: () => true, rollback: async (...args: unknown[]) => { seenArgs = args; return { ok: true } } },
      async () => {
        const deps = makeSwitchDeps('/proj-x', () => {})
        const r = await deps.rollback('v2', { confirmed: true })
        expect(seenArgs).toEqual(['/proj-x', 'v2', { confirmed: true }])
        expect(r).toEqual({ ok: true })
      },
    )
  })

  it('deps.rollback を呼ぶ直前に onRollbackStart(versionName) を呼ぶ（busy 表示の配線）', async () => {
    const started: (string | null)[] = []
    await withWindow({ confirm: () => true, rollback: async () => ({ ok: true }) }, async () => {
      const deps = makeSwitchDeps('/proj', (v) => started.push(v))
      await deps.rollback('v9', { confirmed: true })
      expect(started).toEqual(['v9'])
    })
  })

  it('「最新に戻す」（versionName:null）でも onRollbackStart(null) がそのまま渡る', async () => {
    const started: (string | null)[] = []
    await withWindow({ confirm: () => true, rollback: async () => ({ ok: true }) }, async () => {
      const deps = makeSwitchDeps('/proj', (v) => started.push(v))
      await deps.rollback(null, { confirmed: true })
      expect(started).toEqual([null])
    })
  })

  // ══════════════════════════════════════════════════════════════════════
  // ★ ここが核心（2026-09-08 検分・確認ダイアログを無視する変異の対）。
  //   runSwitch 自体は tests/rollbackSwitch.test.ts で固定済みだが、ここでは
  //   RollbackSection.tsx が実際に組み立てる deps（makeSwitchDeps）を経由しても
  //   同じ歯止めが効くことを確かめる（「呼び出しの形」ではなく実際の呼び出しで）。
  // ══════════════════════════════════════════════════════════════════════
  it('★ confirm がキャンセル（false）→ rollback は一度も呼ばれない（onRollbackStart も呼ばれない）', async () => {
    const started: (string | null)[] = []
    let rollbackCalled = false
    await withWindow(
      { confirm: () => false, rollback: async () => { rollbackCalled = true; return { ok: true } } },
      async () => {
        const deps = makeSwitchDeps('/proj', (v) => started.push(v))
        const outcome = await runSwitch({ versionName: 'v1', label: 'v1', isSplit: false }, deps)
        expect(outcome.proceeded).toBe(false)
        expect(started).toEqual([])
        expect(rollbackCalled).toBe(false)
      },
    )
  })

  it('confirm を通れば rollback が呼ばれる（対になる確認）', async () => {
    let rollbackCalled = false
    await withWindow(
      { confirm: () => true, rollback: async () => { rollbackCalled = true; return { ok: true } } },
      async () => {
        const deps = makeSwitchDeps('/proj', () => {})
        const outcome = await runSwitch({ versionName: 'v1', label: 'v1', isSplit: false }, deps)
        expect(outcome.proceeded).toBe(true)
        expect(rollbackCalled).toBe(true)
      },
    )
  })
})
