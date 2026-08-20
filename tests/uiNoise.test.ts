import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { retentionNotice, shouldNoticeStale, NOTICE_THRESHOLD } from '../src/shared/imageRetention'

// ── 2026-08-20 Ryosuke 指示: 冗長な確認・毎回の警告を減らす ────────────
// 「不必要に冗長だと思われる確認処理や、ユーザーが認識していないのに
//   警告だけされているようなケースがないかを再確認しましょう」

const panel = readFileSync(join(__dirname, '..', 'src/renderer/components/AppRunPanel.tsx'), 'utf-8')
const cloud = readFileSync(join(__dirname, '..', 'src/main/ipc/cloud.ts'), 'utf-8')

describe('① 公開の確認は「増える・消える」ときだけ', () => {
  it('★★ 更新だけなら確認を出さずに実行する', () => {
    const at = panel.indexOf('const needsConfirm')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, at + 400)
    expect(block).toContain("a.type === 'create'")
    expect(block).toContain("a.type === 'delete'")
    expect(block).toContain('hasDestructive')
    expect(block).toContain('else await doApply()')
  })

  it('★★ 作る・消すときは必ず確認する（費用と、取り返しのつかない操作）', () => {
    const at = panel.indexOf('const needsConfirm')
    expect(panel.slice(at, at + 400)).toContain("if (needsConfirm) setConfirm({ kind: 'apply'")
  })
})

describe('② 古いイメージの案内は溜まってから', () => {
  it('★★ 10件から（毎回は言わない）', () => {
    expect(NOTICE_THRESHOLD).toBe(10)
    expect(shouldNoticeStale(9)).toBe(false)
    expect(shouldNoticeStale(10)).toBe(true)
    expect(retentionNotice({ removable: 9, keep: 5 })).toBe('')
    expect(retentionNotice({ removable: 10, keep: 5 })).toContain('10 件')
  })

  it('★★ 公開のたびの案内も、同じ目安を通る', () => {
    expect(panel).toContain('shouldNoticeStale(opResult.staleImages.removable)')
  })

  it('★★ 料金の内訳は、実際に片づける画面で見せる', () => {
    // 公開のたびのカードからは外し、確認ダイアログへ移した
    const card = panel.slice(panel.indexOf('🧹 古いイメージが残っています'), panel.indexOf('🧹 古いイメージが残っています') + 600)
    expect(card).not.toContain('REGISTRY_MONTHLY_YEN')
    const dialog = panel.slice(panel.indexOf('過去の公開のイメージを消します'), panel.indexOf('過去の公開のイメージを消します') + 600)
    expect(dialog).toContain('REGISTRY_MONTHLY_YEN')
  })
})

describe('③ 事前チェックは、気になる点だけ見せる', () => {
  it('★★ 全部 ✅ なら1行に畳む', () => {
    expect(panel).toContain("preflight.checks.every(c => c.status === 'ok')")
    expect(panel).toContain('項目すべて確認しました（内訳を見る）')
  })

  it('★ 見たい人は開ける（隠しきらない）', () => {
    const at = panel.indexOf('項目すべて確認しました')
    expect(panel.slice(Math.max(0, at - 400), at)).toContain('<details')
  })
})

describe('④ 内部の話（権限）を実況しない', () => {
  it('★★ 進行表示から権限の話を外す', () => {
    expect(cloud).not.toContain('🔑 消すあいだだけ権限を上げています')
    expect(cloud).not.toContain('🔑 権限を元に戻しています')
  })

  it('★★ ただし戻せなかったときは伝える（普段と違う状態が残るため）', () => {
    expect(cloud).toContain('権限を元（Push & Pull）に戻せませんでした')
  })
})
