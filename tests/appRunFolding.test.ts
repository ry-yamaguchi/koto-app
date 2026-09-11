import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { foldSecurity, foldUnused, foldBuildMode, specSummaryPrimaryKeys } from '../src/renderer/appRunFolding'

// 委譲仕様 UX-D・判断6: 共用型 AppRunPanel.tsx の折りたたみ判断を一元化する。
// 既存の型は③「事前チェック」の `preflight.checks.every(c => c.status === 'ok')`
// （全部✅なら <details> で1行に畳む）。これと同じ型を④セキュリティチェック・
// ⑤未使用ファイル・ビルド方式のトグル・②公開の設定の要約へ横展開した（新しいUI部品は作らない）。
// 判断そのものは src/renderer/appRunFolding.ts に集約してあり（掟10）、ここで固定する。

describe('foldSecurity: ④セキュリティチェックを1行に畳んでよいか', () => {
  it('全部✅（verdict: ok）→ 畳む', () => {
    expect(foldSecurity({ verdict: 'ok' })).toBe(true)
  })
  it('1つでも要確認（verdict: warn）→ 畳まない', () => {
    expect(foldSecurity({ verdict: 'warn' })).toBe(false)
  })
  it('実施できなかった（verdict: skip）→ 畳まない（確認できていないものを畳まない）', () => {
    expect(foldSecurity({ verdict: 'skip' })).toBe(false)
  })
  it('未実行（null/undefined）→ 畳まない（従来どおり）', () => {
    expect(foldSecurity(null)).toBe(false)
    expect(foldSecurity(undefined)).toBe(false)
  })
})

describe('foldUnused: ⑤未使用ファイルの節を1行に畳んでよいか', () => {
  it('全部✅（0件）→ 畳む', () => {
    expect(foldUnused({ supported: true, unused: [] })).toBe(true)
  })
  it('1つでも要確認（1件以上）→ 畳まない', () => {
    expect(foldUnused({ supported: true, unused: ['a.png'] })).toBe(false)
  })
  it('対象外（supported: false）→ 畳まない（未実行と同様、従来どおり理由を出す）', () => {
    expect(foldUnused({ supported: false, unused: [] })).toBe(false)
  })
  it('未実行（null/undefined）→ 畳まない', () => {
    expect(foldUnused(null)).toBe(false)
    expect(foldUnused(undefined)).toBe(false)
  })
})

describe('foldBuildMode: ビルド方式の節を畳んでよいか', () => {
  it('標準（builtin）→ 畳む', () => {
    expect(foldBuildMode('builtin')).toBe(true)
  })
  it('Docker を選んでいる → 畳まない（展開したまま）', () => {
    expect(foldBuildMode('docker')).toBe(false)
  })
  it('分からない（null/undefined）→ 既定（標準）と同じ扱いで畳む', () => {
    expect(foldBuildMode(null)).toBe(true)
    expect(foldBuildMode(undefined)).toBe(true)
  })
})

describe('specSummaryPrimaryKeys: ②公開の設定で常時表示する項目とその順序', () => {
  it('公開名・起動のしかた・保存場所・期限の4項目を、この順で返す', () => {
    expect(specSummaryPrimaryKeys()).toEqual(['公開名', '起動のしかた', '保存場所', '期限'])
  })
})

// ── 配線（ソースを読んで固定）──────────────────────────────────────────
// electron に依存するコンポーネントは import できないため、ソースを読んで確かめる
// （tests/securityCheck.test.ts・tests/unusedWiring.test.ts と同じ流儀）。
const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf-8')
const securitySection = () => read('src/renderer/components/SecurityCheckSection.tsx')
const unusedSection = () => read('src/renderer/components/UnusedFilesSection.tsx')
const panel = () => read('src/renderer/components/AppRunPanel.tsx')

describe('配線: 各コンポーネントは appRunFolding.ts の純関数を呼ぶだけ（判断を複製しない・掟10）', () => {
  it('SecurityCheckSection.tsx は foldSecurity を import して使い、全部✅のときだけ <details> に畳む', () => {
    const s = securitySection()
    expect(s).toContain("import { foldSecurity } from '../appRunFolding'")
    expect(s).toContain('foldSecurity(result)')
    expect(s).toContain('✅ 問題なし（内訳を見る）')
    // 要確認（warn）のときは <details> に畳まず、生の判定文言をそのまま出す（従来どおり）。
    expect(s).toContain("result.verdict === 'warn' ? '⚠️ 要確認'")
  })

  it('UnusedFilesSection.tsx は foldUnused を import して使い、0件のときだけ <details> に畳む', () => {
    const s = unusedSection()
    expect(s).toContain("import { foldUnused } from '../appRunFolding'")
    expect(s).toContain('foldUnused({ supported, unused })')
    expect(s).toContain('✅ 問題なし（内訳を見る）')
  })

  it('AppRunPanel.tsx は foldBuildMode / specSummaryPrimaryKeys を import して使う', () => {
    const p = panel()
    expect(p).toContain("import { foldBuildMode, specSummaryPrimaryKeys } from '../appRunFolding'")
    expect(p).toContain('foldBuildMode(prereqs?.builderMode)')
    expect(p).toContain('specSummaryPrimaryKeys()')
  })

  it('ビルド方式の節は <details> で、既定（標準）のときは畳み、Docker のときは open にする', () => {
    const p = panel()
    const at = p.indexOf('{needsPrereqs && (\n          <details')
    expect(at).toBeGreaterThan(0)
    const end = p.indexOf('</details>', at)
    const block = p.slice(at, end)
    expect(block).toContain('open={!foldBuildMode(prereqs?.builderMode)}')
    expect(block).toContain('詳細: ビルド方式（標準）')
  })

  it('②公開の設定（SpecSummary）: 常時表示は4項目、残り（実行環境・地域・サービス設定）は「詳細を見る」の <details> に入れる', () => {
    const p = panel()
    const fnAt = p.indexOf('function SpecSummary(')
    expect(fnAt).toBeGreaterThan(0)
    // 常時表示の最後の項目（期限）より後にある最初の <details> が、詳細を見る、の折りたたみ。
    // （fnAt 直後のコメントにも文字列として "<details>" が出るため、そこは飛ばす）
    const ttlAt = p.indexOf('{ttlLabel}', fnAt)
    expect(ttlAt).toBeGreaterThan(fnAt)
    const detailsAt = p.indexOf('<details>', ttlAt)
    expect(detailsAt).toBeGreaterThan(ttlAt)
    const always = p.slice(fnAt, detailsAt)
    const rest = p.slice(detailsAt, p.indexOf('\n}', detailsAt))

    // 常時表示の4項目が、この順で現れる（specSummaryPrimaryKeys の並びと一致）。
    const idxName = always.indexOf('{primaryLabel}')
    const idxScale = always.indexOf('{scaleLabelText}')
    const idxStorage = always.indexOf('{storageLabel}')
    const idxTtl = always.indexOf('{ttlLabel}')
    expect(idxName).toBeGreaterThan(-1)
    expect(idxScale).toBeGreaterThan(idxName)
    expect(idxStorage).toBeGreaterThan(idxScale)
    expect(idxTtl).toBeGreaterThan(idxStorage)
    // 常時表示側には、詳細に回した3項目のdt見出し（<dt>...</dt>そのもの）が出てこない
    // （直前のコメントに語として登場するのは許容し、実際のJSX要素だけを見る）。
    expect(always).not.toContain('<dt className="text-ink-muted">実行環境</dt>')
    expect(always).not.toContain('<dt className="text-ink-muted">地域</dt>')
    expect(always).not.toContain('<dt className="text-ink-muted">サービス設定</dt>')

    // 詳細を見る、の中に3項目がある。
    expect(rest).toContain('詳細を見る')
    expect(rest).toContain('実行環境')
    expect(rest).toContain('>地域<')
    expect(rest).toContain('サービス設定')
  })

  it('番号外の節（🌐 公開URL・💰 コスト）は、見出しの色を text-ink-secondary・枠を border-line-soft にする（番号付きの節の見た目は変えない）', () => {
    const p = panel()
    const urlAt = p.indexOf('🌐 公開URL')
    expect(urlAt).toBeGreaterThan(0)
    const urlSectionAt = p.lastIndexOf('<section', urlAt)
    expect(p.slice(urlSectionAt, urlAt)).toContain('border-line-soft')
    expect(p.slice(urlAt - 80, urlAt + 20)).toContain('text-ink-secondary')

    const costAt = p.lastIndexOf('💰 コスト')
    expect(costAt).toBeGreaterThan(0)
    const costSectionAt = p.lastIndexOf('<section', costAt)
    expect(p.slice(costSectionAt, costAt)).toContain('border-line-soft')
    expect(p.slice(costAt - 80, costAt + 20)).toContain('text-ink-secondary')

    // 番号付きの節（例: ③事前チェック）の見た目は変えていない。
    const step3At = p.indexOf('③ 事前チェック')
    expect(step3At).toBeGreaterThan(0)
    const step3SectionAt = p.lastIndexOf('<section', step3At)
    expect(p.slice(step3SectionAt, step3At)).toContain('border-line')
    expect(p.slice(step3SectionAt, step3At)).not.toContain('border-line-soft')
  })
})
