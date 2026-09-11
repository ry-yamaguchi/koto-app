import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// 委譲仕様 UX-E（判断8）: 公開先パネル4つ（AppRun 共用型・専有型・HANAMII・Vercel）の
// 型を揃える。4パネル横断の配線テスト——①は AccessKeySection を使っていること・
// window.confirm 等の混入が無いこと・旧文言（「公開する（作成・更新）」「再公開する」）が
// 無いことを、1本のテストで4パネル分まとめて固定する（複製すると片方だけ直され、
// 抜けても誰も気づかない・掟10）。

const PANELS = [
  { name: 'AppRunPanel（共用型）', path: 'src/renderer/components/AppRunPanel.tsx' },
  { name: 'AppRunDedicatedPanel（専有型）', path: 'src/renderer/components/AppRunDedicatedPanel.tsx' },
  { name: 'HanamiiPanel', path: 'src/renderer/components/HanamiiPanel.tsx' },
  { name: 'VercelPanel', path: 'src/renderer/components/VercelPanel.tsx' },
] as const

const sources = PANELS.map(p => ({ ...p, src: readFileSync(join(__dirname, '..', p.path), 'utf-8') }))

describe.each(sources)('$name: ①は AccessKeySection を使い、旧文言・window.confirm が無い', ({ src }) => {
  it('<AccessKeySection を使っている', () => {
    expect(src).toContain('<AccessKeySection')
  })

  // 掟5「確認は ConfirmModal で出す。window.confirm は使わない」——ここで固定したいのは
  // *この委譲（①の統一・AccessKeySection 化）が window.confirm を持ち込んでいないこと*。
  // 2026-09-11（UX-B2）: AppRunPanel.tsx の画像の片づけ（cleanUnusedImages）も含め、
  // src/renderer 配下の window.confirm( はすべて ConfirmModal（useConfirm）へ置き換わった
  // （tests/confirmModalWiring.test.ts の全件走査テストが固定。実際にこの置き換えを
  // 固定していたのは tests/siteCheck.test.ts 側）。この it は「①の統一」というこのテストの
  // 主題に絞るため、ファイル全体ではなく①（AccessKeySection の呼び出しブロック）だけを見る。
  it('①（<AccessKeySection>…</AccessKeySection>）の中に window.confirm( が無い', () => {
    const at = src.indexOf('<AccessKeySection')
    expect(at).toBeGreaterThan(0)
    const end = src.indexOf('</AccessKeySection>', at)
    expect(end).toBeGreaterThan(at)
    expect(src.slice(at, end)).not.toContain('window.confirm(')
  })

  it('旧い公開ボタンの文言（「公開する（作成・更新）」「🚀 再公開する（最新の内容を反映）」）が残っていない', () => {
    expect(src).not.toContain('公開する（作成・更新）')
    // 「再公開する」という語そのものは、A-5高速経路の説明文（例:「その場合は既存の
    // 『再公開する』を使う」）に地の文として残ってよい——禁止したいのは旧ボタンの
    // 実際の表示文言（絵文字＋文言のセット）。
    expect(src).not.toContain('🚀 再公開する')
  })

  it('旧い認証情報ボタンの文言（「認証情報で登録・切替」「認証情報を開いて登録」）が残っていない', () => {
    expect(src).not.toContain('認証情報で登録・切替')
    expect(src).not.toContain('認証情報を開いて登録')
  })
})

// AppRunDedicatedPanel の⑤「クラスタを作成する」は公開（アプリケーションの公開）ではないため、
// publishButtonLabel の対象外——「公開する（作成・更新）」「再公開する」が無いことは上の
// describe.each で確かめる一方、「クラスタを作成する」自体は変えていないことも確かめる。
describe('AppRunDedicatedPanel: ⑤「クラスタを作成する」は公開ボタンの統一対象外のまま', () => {
  const dedicatedPanel = readFileSync(join(__dirname, '..', 'src/renderer/components/AppRunDedicatedPanel.tsx'), 'utf-8')
  it('⑤のボタンは「クラスタを作成する」のまま（🚀 公開する に置き換えていない）', () => {
    expect(dedicatedPanel).toContain("'クラスタを作成する'")
  })
})

// 4パネルの主ボタンが publishButtonLabel（1関数）を使っていることも合わせて固定する
// （AppRunDedicatedPanel は⑤が対象外のため、この配列には含めない）。
const PUBLISH_PANELS = [
  { name: 'AppRunPanel（共用型）', path: 'src/renderer/components/AppRunPanel.tsx' },
  { name: 'HanamiiPanel', path: 'src/renderer/components/HanamiiPanel.tsx' },
  { name: 'VercelPanel', path: 'src/renderer/components/VercelPanel.tsx' },
] as const

describe.each(PUBLISH_PANELS.map(p => ({ ...p, src: readFileSync(join(__dirname, '..', p.path), 'utf-8') })))(
  '$name: 主ボタンの文言は publishButtonLabel（src/shared/publishLabels.ts）から取る',
  ({ src }) => {
    it('publishButtonLabel を import し、呼んでいる', () => {
      expect(src).toContain("from '../../shared/publishLabels'")
      expect(src).toContain('publishButtonLabel(')
    })
  },
)
