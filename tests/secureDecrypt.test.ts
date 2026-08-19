import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── 2026-08-19 実機 ──────────────────────────────────────────────────
// 復号に失敗したとき '' を返していたため、**未登録と区別が付かなかった**。
// 画面は「未登録」と見せ、利用者はそこへ入力し直す → **元の設定が上書きされて消える**。
//
// これが起きる形が実際にあった: 署名の違うビルド（署名版と手元の未署名ビルド）は
// **キーチェーンの鍵が別**になる。実測で `Koto Safe Storage` の項目が2つできており、
// 一方で保存したものはもう一方から読めなかった（正式版では「未登録」に見えた）。
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf-8')

describe('「読めなかった」を「無かった」と混ぜない', () => {
  const secure = read('src/main/ipc/secure.ts')

  it('★ 復号できなければ null を返す（空文字と区別する）', () => {
    expect(secure).toMatch(/catch \{\s*return null/)
    expect(secure).toMatch(/if \(!b64\) return ''/)
  })

  it('暗号化できない環境も、空とは区別する', () => {
    expect(secure).toMatch(/isEncryptionAvailable\(\)\) return null/)
  })

  it('型でも区別されている', () => {
    expect(read('src/renderer/global.d.ts')).toMatch(/decrypt\(b64: string\): Promise<string \| null>/)
  })
})

describe('読めなかったことを、利用者に伝える', () => {
  const modal = read('src/renderer/components/CredentialsModal.tsx')

  it('★ 「未登録」と見せたまま黙って上書きさせない', () => {
    expect(modal).toContain('setUnreadable(true)')
    expect(modal).toContain('保存されている設定を読み取れませんでした')
    expect(modal).toContain('元の設定は失われます')
  })

  it('原因の見当（別の版で保存された）まで書く', () => {
    expect(modal).toContain('署名の異なるビルド')
  })
})
