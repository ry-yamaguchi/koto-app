import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// ── W-51／W-58（2026-09-27決定・検分で指摘）: お金・データの歯止めは「ゲート関数がある」だけでは
// 足りない。呼び出し側（コンポーネント）が実際にそのゲートを通しているかを、ソースを読んで固定する
// （掟10: 「一元化した」と「全経路が実際にそこを通っている」は別。tests/confirmModalWiring.test.ts と
// 同じ作法）。
//
// ミューテーション試験で確かめた実際の抜け道:
//   - SettingsModal.tsx の onClick を `resetThisMonth(); refresh(); return;` に変異させても、
//     runResetUsageWithConfirm 自体のテスト（w-settings-reset-usage-confirm.test.ts）は無関係のまま緑だった
//     （ゲート関数を経由しない直接呼び出しは、ゲート関数のテストでは検知できない）。
//   - CredentialsModal.tsx の保存ボタンを `onClick={save}` に変異させても、
//     runSaveWithUnreadableCheck 自体のテスト（w-settings-unreadable-save-confirm.test.ts）は無関係のまま緑だった。
// このファイルはその「呼び出しの形」自体をソース走査で固定する。

const ROOT = path.join(__dirname, '..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8')

const settingsModal = read('src/renderer/components/SettingsModal.tsx')
const credentialsModal = read('src/renderer/components/CredentialsModal.tsx')

describe('W-51: SettingsModal.tsx の「今月の記録を0に戻す」は resetThisMonth を直呼びしない', () => {
  it('resetThisMonth( の呼び出しは、runResetUsageWithConfirm の reset コールバックの中にだけ存在する', () => {
        // ファイル全体で resetThisMonth( を呼んでいる箇所をすべて拾い、それぞれが
    // 「reset: () => { resetThisMonth(); ... }」の形（runResetUsageWithConfirm への受け渡し）に
    // 収まっていることを確認する。件数がゼロなら退行を見逃すので、まず1件以上あることも確認する。
    const calls: number[] = []
    const re = /resetThisMonth\(/g
    let m: RegExpExecArray | null
    while ((m = re.exec(settingsModal)) !== null) calls.push(m.index)
    expect(calls.length).toBeGreaterThan(0)

    for (const idx of calls) {
      // 直前80文字に `reset: () => {` があること（＝ゲートの reset コールバックの中）。
      const before = settingsModal.slice(Math.max(0, idx - 80), idx)
      expect(before).toContain('reset: () => {')
    }
  })

  it('「今月の記録を0に戻す」ボタンの onClick は runResetUsageWithConfirm( を呼ぶ', () => {
    // ファイル冒頭のコメント（W-51 の説明）にも同じ文言があるため、ボタン本体（最後の出現）を見る。
    const at = settingsModal.lastIndexOf('今月の記録を0に戻す')
    expect(at).toBeGreaterThan(-1)
    // ボタンの開始位置（直前の <button）から見出しテキストまでを1ブロックとして見る。
    const btnStart = settingsModal.lastIndexOf('<button', at)
    expect(btnStart).toBeGreaterThan(-1)
    const block = settingsModal.slice(btnStart, at)
    expect(block).toContain('await runResetUsageWithConfirm(')
    // 変異で戻されがちな「素通し」の形が無いこと。
    expect(block).not.toContain('onClick={() => { resetThisMonth(); refresh() }}')
    expect(block).not.toContain('onClick={() => { resetThisMonth(); refresh(); return }}')
  })
})

describe('W-58: CredentialsModal.tsx の保存ボタンは save を直呼びしない', () => {
  it('保存ボタンの onClick は onSaveClick（save ではない）', () => {
    expect(credentialsModal).toContain('<button onClick={onSaveClick}')
    expect(credentialsModal).not.toContain('<button onClick={save}')
  })

  it('onSaveClick は runSaveWithUnreadableCheck( を経由して save を呼ぶ', () => {
    const at = credentialsModal.indexOf('const onSaveClick = async () => {')
    expect(at).toBeGreaterThan(-1)
    const end = credentialsModal.indexOf('\n  }\n', at)
    expect(end).toBeGreaterThan(at)
    const block = credentialsModal.slice(at, end)
    expect(block).toContain('await runSaveWithUnreadableCheck(')
    expect(block).toContain('save,')
    // ゲートを飛ばして直接 save() する変異が戻っていないこと。
    expect(block).not.toMatch(/^\s*save\(\)/m)
  })
})

// ── W-58（検分の指摘・2026-09-27）: unreadable は setUnreadable(true) で立つだけで、保存が
// 成功したあとも下ろされず、事実と違う赤枠・2回目の確認が出続けていた ──────────────────────
describe('W-58: 保存できたら unreadable を下ろす（読める状態で上書き済みなのに警告が残らない）', () => {
  it('onSaveClick は outcome.cancelled が false のときだけ setUnreadable(false) を呼ぶ', () => {
    const at = credentialsModal.indexOf('const onSaveClick = async () => {')
    expect(at).toBeGreaterThan(-1)
    const end = credentialsModal.indexOf('\n  }\n', at)
    expect(end).toBeGreaterThan(at)
    const block = credentialsModal.slice(at, end)
    expect(block).toContain('const outcome = await runSaveWithUnreadableCheck(')
    expect(block).toContain('if (!outcome.cancelled) setUnreadable(false)')
  })
})
