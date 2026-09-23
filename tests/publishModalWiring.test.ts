import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// D-3（2026-09-11 Ryosuke 決定）: 公開先の種類 PublishTargetKind の**唯一の定義**は
// src/renderer/publishStatus.ts。PublishModal.tsx には同じ union の複製が置かれていた
// （'sakura-apprun-dedicated' を足したとき、複製側だけ古いまま残る穴）ので消して import に切り替えた。
//
// 複製は片方だけ直されても誰も気づかない（掟10）。electron に依存する tsx は import できないので、
// ソースを読んで配線を確かめる（publishMetaWiring.test.ts と同じ流儀）。
// 当て先が他の行に出ないかを確認済み: PublishModal.tsx のコメントは「公開先の種類（PublishTargetKind）」
// と書いており、`type PublishTargetKind =` の形は定義以外に現れない。

const ROOT = path.join(__dirname, '..')
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

/** 「PublishTargetKind を自前で定義している」形（type / interface / enum）。 */
const OWN_DEFINITION = /\b(type|interface|enum)\s+PublishTargetKind\b\s*[=<{]/

/**
 * `from '<spec>'` で終わる import 文をすべて集め、その { } の中身を返す。
 * `import { a, type B } from '...'` と `import type { B } from '...'` の両方を拾う。
 */
function importedNames(source: string, spec: string): { typeOnly: boolean; names: string }[] {
  const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`import\\s+(type\\s+)?\\{([^}]*)\\}\\s*from\\s*'${escaped}'`, 'g')
  const out: { typeOnly: boolean; names: string }[] = []
  for (const m of source.matchAll(re)) out.push({ typeOnly: !!m[1], names: m[2] })
  return out
}

function bringsPublishTargetKind(imports: { typeOnly: boolean; names: string }[]): boolean {
  return imports.some(i =>
    i.typeOnly ? /\bPublishTargetKind\b/.test(i.names) : /\btype\s+PublishTargetKind\b/.test(i.names),
  )
}

describe('PublishModal.tsx: PublishTargetKind を複製せず publishStatus.ts から import している（掟10）', () => {
  const FILE = 'src/renderer/components/PublishModal.tsx'

  it('★ `type PublishTargetKind =` の複製が無い（直す前の形を禁じる）', () => {
    const s = read(FILE)
    expect(s).not.toMatch(OWN_DEFINITION)
    // 直す前の形そのもの（4種類の union）も残っていない
    expect(s).not.toContain("type PublishTargetKind = 'hanamii' | 'sakura-apprun' | 'sakura-rental' | 'vercel'")
  })

  it("★ `type PublishTargetKind` を '../publishStatus' から import している", () => {
    const s = read(FILE)
    const imports = importedNames(s, '../publishStatus')
    expect(imports.length).toBeGreaterThan(0)
    expect(bringsPublishTargetKind(imports)).toBe(true)
  })

  it('消しすぎの検出: import した PublishTargetKind を実際に使っている（publish.targets の型・onForget の引数）', () => {
    const s = read(FILE)
    expect(s).toContain('targets?: Partial<Record<PublishTargetKind, PublishTargetRecord>>')
    expect(s).toContain('onForget: (t: PublishTargetKind) => Promise<void>')
  })

})

// 2026-09-15 検分の指摘: 中断検知バナー用に PUBLISH_TARGET_LABEL と同じ内容を5種類ぶん
// 書き写した表（PENDING_TARGET_LABELS）が PublishModal.tsx にあった。publishStatus.ts は
// 「ラベルを各画面で書き直すと表記が割れるので必ずここを参照すること」と明記している（掟10）。
// 表を消して PUBLISH_TARGET_LABEL を import する形に直し、ここで固定する。
//
// 当て先が他の行に出ないかを確認済み（2026-09-15）: PublishModal.tsx の公開先カードの見出しは
// 「🌸 HANAMII（国産PaaS）」のように**裸の文字列**で、`hanamii: '🌸 HANAMII'` の**キーと対にした形**は
// 表以外に現れない。`Record<PublishTargetKind, PublishTargetRecord>`（publish.targets の型）は
// `string` ではないので `Record<…, string>` には当たらない。
describe('PublishModal.tsx: 公開先ラベルを書き写さず PUBLISH_TARGET_LABEL を参照している（掟10）', () => {
  const FILE = 'src/renderer/components/PublishModal.tsx'

  it('★ ラベルの複製表（PENDING_TARGET_LABELS）が無い（直す前の形を禁じる）', () => {
    const s = read(FILE)
    expect(s).not.toContain('PENDING_TARGET_LABELS')
    // 「種類 → 表示名」の表を別名で作り直す形も禁じる
    expect(s).not.toMatch(/Record<(PendingPublish\['target'\]|PublishTargetKind),\s*string>/)
    // 直す前の表の中身（キーとラベルの対）が1つも残っていない
    for (const pair of [
      "hanamii: '🌸 HANAMII'",
      "'sakura-apprun': '📦 さくらのAppRun'",
      "'sakura-apprun-dedicated': '📦 さくらのAppRun（専有型）'",
      "'sakura-rental': '🌐 さくらのレンタルサーバ'",
      "vercel: '▲ Vercel'",
    ]) {
      expect(s).not.toContain(pair)
    }
  })

  it("★ `PUBLISH_TARGET_LABEL` を '../publishStatus' から値として import している", () => {
    const s = read(FILE)
    const imports = importedNames(s, '../publishStatus')
    expect(imports.length).toBeGreaterThan(0)
    // 値として使うので `type` 付き（型だけの import）では足りない
    expect(imports.some(i => !i.typeOnly && /(^|[,{\s])PUBLISH_TARGET_LABEL\s*[,}]/.test(i.names))).toBe(true)
    expect(imports.some(i => /\btype\s+PUBLISH_TARGET_LABEL\b/.test(i.names))).toBe(false)
  })

  it('消しすぎの検出: 中断検知バナーが import した PUBLISH_TARGET_LABEL を引いている', () => {
    const s = read(FILE)
    // 呼び出しの形ごと一意に指す（前後の文言つき）
    expect(s).toContain('{PUBLISH_TARGET_LABEL[interruptedPublish.target]}への公開が完了前に中断された可能性があります')
  })
})

describe('PublishTargetKind の自前定義は src 全体で publishStatus.ts の1箇所だけ（掟10）', () => {
  const SOLE = 'src/renderer/publishStatus.ts'

  function walk(dir: string, out: string[] = []): string[] {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(p, out)
      else if (/\.(ts|tsx)$/.test(ent.name) && !/\.d\.ts$/.test(ent.name)) out.push(p)
    }
    return out
  }

  it('唯一の定義が publishStatus.ts にある', () => {
    expect(read(SOLE)).toMatch(/^export type PublishTargetKind = /m)
  })

  it('★ 他のファイルに `type|interface|enum PublishTargetKind` の定義が無い', () => {
    const offenders = walk(path.join(ROOT, 'src'))
      .filter(p => path.relative(ROOT, p) !== SOLE)
      .filter(p => OWN_DEFINITION.test(fs.readFileSync(p, 'utf-8')))
      .map(p => path.relative(ROOT, p))
    expect(offenders).toEqual([])
  })
})

// 2026-09-23 検分の指摘5: 共用型／専有型のタブを三項演算子で出し分けていたため、
// タブを行き来するたびにパネルが丸ごとアンマウント・再マウントされ、初期化 effect が
// ⑦ログ・メトリクス（GET 6本）と⑧を取り直したうえ、③「🔍 調べる」の結果
// （limits/plans/clusters/conn/checkError）はすべて component の state なので全部消えていた。
// 「何度も取り直しているように見える」という申告の、いちばん素直な説明がこれ。
describe('共用型／専有型のタブ: 一度開いたパネルは外さず hidden で隠す（指摘5）', () => {
  const modal = read('src/renderer/components/PublishModal.tsx')

  it('★ 三項演算子での出し分け（＝再マウントを起こす形）へ戻っていない', () => {
    // 直す前の形そのもの。これが戻ると③の結果が消え、⑦を取り直すようになる。
    expect(modal).not.toContain("{target === 'sakura-apprun' ? (\n              <AppRunPanel")
    // どちらのパネルも、条件分岐の「else 側」に置かれていないこと。
    expect(modal).not.toContain('            ) : (\n              <AppRunDedicatedPanel')
  })

  it('一度でも開いたタブを覚える state があり、target が変わるたびに印を足す', () => {
    expect(modal).toContain("const [mountedApprunTabs, setMountedApprunTabs] = useState<Partial<Record<'sakura-apprun' | 'sakura-apprun-dedicated', true>>>({})")
    const at = modal.indexOf('setMountedApprunTabs(prev =>')
    expect(at).toBeGreaterThan(0)
    // 依存配列が [target] であること（ここが [] だと最初のタブしか記録されない）。
    const effectAt = modal.lastIndexOf('useEffect(() => {', at)
    const block = modal.slice(effectAt, modal.indexOf('}, [target])', at) + '}, [target])'.length)
    expect(block).toContain("if (target === 'sakura-apprun' || target === 'sakura-apprun-dedicated') {")
    expect(block).toContain('}, [target])')
  })

  it('両パネルとも、印が立っていれば描き、いま選ばれていない側だけを hidden で隠す', () => {
    // 共用型
    const sharedAt = modal.indexOf("{mountedApprunTabs['sakura-apprun'] && (")
    expect(sharedAt).toBeGreaterThan(0)
    const sharedBlock = modal.slice(sharedAt, sharedAt + 300)
    expect(sharedBlock).toContain("<div className={target === 'sakura-apprun' ? undefined : 'hidden'}>")
    expect(sharedBlock).toContain('<AppRunPanel projectDir={projectDir} apiKey={apiKey} onOpenCredentials={onOpenCredentials} />')

    // 専有型
    const dedicatedAt = modal.indexOf("{mountedApprunTabs['sakura-apprun-dedicated'] && (")
    expect(dedicatedAt).toBeGreaterThan(0)
    const dedicatedBlock = modal.slice(dedicatedAt, dedicatedAt + 300)
    expect(dedicatedBlock).toContain("<div className={target === 'sakura-apprun-dedicated' ? undefined : 'hidden'}>")
    expect(dedicatedBlock).toContain('<AppRunDedicatedPanel projectDir={projectDir} onOpenCredentials={onOpenCredentials} />')

    // 専有型が先に描かれない（タブの並びと同じ順序であること）。
    expect(sharedAt).toBeLessThan(dedicatedAt)
  })

  it('未訪問のタブは描かない（専有型は上級者向け。使わない利用者に⑦の GET 6本を払わせない）', () => {
    // 印を見ずに常時描く形になっていないこと＝どちらの JSX も mountedApprunTabs の中にある。
    const sharedPanelAt = modal.indexOf('<AppRunPanel projectDir={projectDir}')
    const dedicatedPanelAt = modal.indexOf('<AppRunDedicatedPanel projectDir={projectDir}')
    expect(modal.lastIndexOf("{mountedApprunTabs['sakura-apprun'] && (", sharedPanelAt)).toBeGreaterThan(0)
    expect(modal.lastIndexOf("{mountedApprunTabs['sakura-apprun-dedicated'] && (", dedicatedPanelAt)).toBeGreaterThan(0)
  })
})
