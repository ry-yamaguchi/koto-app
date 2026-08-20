import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── 2026-08-19 実機（Ryosuke）────────────────────────────────────────
// S1 の答え: **`readwrite`（Push & Pull）では削除できない**。
//
// はじめは「失敗したら【権限を上げる】ボタンを出す」形にしたが、こう指摘された:
//   「権限が不足していることを認識しておきながら、あえて失敗させてその後
//     ボタンを押させるのは不条理だ」
//
// そのとおりなので、**押した1回の中で**上げる→消す→**必ず戻す**形にした。

const cloud = readFileSync(join(__dirname, '..', 'src/main/ipc/cloud.ts'), 'utf-8')
const panel = readFileSync(join(__dirname, '..', 'src/renderer/components/AppRunPanel.tsx'), 'utf-8')
const preload = readFileSync(join(__dirname, '..', 'src/main/preload.ts'), 'utf-8')

describe('消すあいだだけ権限を上げる', () => {
  const at = cloud.indexOf('async function withDeletePermission')
  const block = cloud.slice(at, at + 3000)

  it('★★ 上げてから消す', () => {
    expect(at).toBeGreaterThan(0)
    expect(block).toContain("setPermission('all')")
    expect(cloud).toContain('const guarded = await withDeletePermission(')
  })

  it('★★ 終わったら必ず戻す（失敗しても戻す）', () => {
    expect(block).toContain('} finally {')
    const fin = block.slice(block.indexOf('} finally {'))
    expect(fin).toContain("setPermission('readwrite')")
  })

  it('★★ 戻せなかったら黙らない', () => {
    expect(block).toContain('restoreFailed = true')
    expect(cloud).toContain('権限を元（Push & Pull）に戻せませんでした')
  })

  it('★★ パスワードは変えない（動いている公開の認証を切らない）', () => {
    expect(block).toContain('password: opts.password')
  })

  it('★ 触るレジストリは、公開・片づけと同じ決め方（別プロジェクトを触らない）', () => {
    expect(cloud).toContain('registryLabel: push.use')
  })

  it('★ 作成時は最小の権限のまま（普段は上げっぱなしにしない）', () => {
    expect(cloud).toContain("permission: 'readwrite'")
  })
})

describe('失敗させてから押させる形は残っていない', () => {
  it('★★ 単独の「権限を上げる」ボタンも口も無い', () => {
    expect(cloud).not.toContain('cloud:raiseRegistryPermission')
    expect(preload).not.toContain('raiseRegistryPermission')
    expect(panel).not.toContain('🔑 削除できるようにする')
  })

  // ── 権限の上げ下げは内部の話（2026-08-19 Ryosuke 指摘）────────────────
  // 「そもそも IDE には APIキーを入れているので、むしろ権限を押さえて普段は
  //   動いていること自体がユーザーに知らされていない」。
  // 普段伝えていないことを、消すときだけ説明するのは筋が通らない。
  // **やること（最小の権限で動く）は続け、断りは書かない。**
  it('★★ 確認ダイアログで権限の話をしない', () => {
    expect(panel).not.toContain('消すあいだだけレジストリの権限を上げ')
  })

  it('★ ただし、戻せなかったときだけは伝える（残った状態は知らせる必要がある）', () => {
    expect(cloud).toContain('権限を元（Push & Pull）に戻せませんでした')
  })
})
