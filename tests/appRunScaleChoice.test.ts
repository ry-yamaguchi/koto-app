import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { scaleChoice, scaleMinFor, scaleDisplay } from '../src/renderer/components/AppRunPanel'
import { scaleLabel } from '../src/shared/scaleDecision'

// roadmap #31（共用型 AppRun の最小スケール選択）。
//
// 原本 apprun-shared.json v1.5.0 の POST /applications で確認済み:
//   min_scale: integer / minimum 0 / maximum 10 / 既定 0
//   max_scale: integer / minimum 1 / maximum 10 / 既定 10（この機能では触らない）
//
// さくらの開発者の助言「コールドスタートが許容できなければ最小スケールを1以上に」を
// 受けた機能だが、**既定は 0（cold）のまま**——「新しいプロジェクトを作ったら課金が
// 始まることがあってはならない」という Koto の方針（defaultSpec）を優先する。

describe('scaleChoice: 0 は cold、1以上は warm（実際に呼ぶ）', () => {
  it('0 → cold', () => { expect(scaleChoice(0)).toBe('cold') })
  it('1 → warm', () => { expect(scaleChoice(1)).toBe('warm') })
  it('10（原本の最大） → warm', () => { expect(scaleChoice(10)).toBe('warm') })
  it('5 → warm', () => { expect(scaleChoice(5)).toBe('warm') })
})

describe('scaleChoice: 原本の範囲（0〜10）から外れる値は安全側（cold）に倒す', () => {
  it('負の値 → cold', () => { expect(scaleChoice(-1)).toBe('cold') })
  it('11（原本の最大を超える） → cold', () => { expect(scaleChoice(11)).toBe('cold') })
  it('非整数 → cold', () => { expect(scaleChoice(1.5)).toBe('cold') })
  it('NaN → cold', () => { expect(scaleChoice(NaN)).toBe('cold') })
})

describe('scaleMinFor: 選択状態から保存する min を決める（実際に呼ぶ）', () => {
  it("cold → 0", () => { expect(scaleMinFor('cold')).toBe(0) })
  it("warm → 1", () => { expect(scaleMinFor('warm')).toBe(1) })
})

// ── #31 の検分（2026-09-09）で見つかった【低】 ──────────────────────────
// scaleChoice は範囲外（例: min=11）を安全側の cold に倒す。**保存する値としては正しい**が、
// その cold をそのまま画面の文言に使うと「アクセスが無い間は止まり、課金されません」と
// 言い切ってしまう。min=11 は実際には常時11インスタンスが動いており、これは嘘になる。
// 表示用は3値（cold/warm/unknown）にし、unknown のときは断定しない。
describe('scaleDisplay: 表示用は3値。範囲外は unknown（cold と決めつけない・実際に呼ぶ）', () => {
  it('0 → cold、1〜10 → warm（scaleChoice と同じ）', () => {
    expect(scaleDisplay(0)).toBe('cold')
    expect(scaleDisplay(1)).toBe('warm')
    expect(scaleDisplay(10)).toBe('warm')
  })

  it('★ 範囲外（例: min=11）は unknown ── scaleChoice なら cold になる値', () => {
    expect(scaleChoice(11)).toBe('cold') // 保存用はこれまでどおり安全側
    expect(scaleDisplay(11)).toBe('unknown') // だが表示は「分からない」であって「cold」ではない
  })

  it('負の値・非整数・NaN も unknown', () => {
    expect(scaleDisplay(-1)).toBe('unknown')
    expect(scaleDisplay(1.5)).toBe('unknown')
    expect(scaleDisplay(NaN)).toBe('unknown')
  })
})

// 画面側の配線は、React を実レンダリングするテストインフラが無いため、
// apprunDedicatedWiring.test.ts / appRunRegionSelect.test.ts と同じ「ソーステキストを
// 固定する」流儀で確かめる。
const panel = readFileSync(join(__dirname, '..', 'src/renderer/components/AppRunPanel.tsx'), 'utf-8')

describe('AppRunPanel.tsx: ②公開の設定に、最小スケールを選べる2択が出ている', () => {
  it('2つの選択肢の文言がある（ボタンは名前だけ。scaleLabel と同じ言葉）', () => {
    expect(panel).toContain('>最初のアクセスが遅くてもよい</button>')
    expect(panel).toContain('>常時起動</button>')
    expect(panel).toContain(`>${scaleLabel(0)}</button>`)
    expect(panel).toContain(`>${scaleLabel(1)}</button>`)
    expect(panel).not.toContain('すぐ返す（常時動かす）') // 0.6.21: 直す前の言い方は戻さない
    // 0.6.22: 括弧の説明をボタンに付けない（狭い列で「（既定・安 / い）」と語の途中で折れていた。2026-10-12 作者の指摘）
    expect(panel).not.toContain('（既定・安い）')
    expect(panel).not.toContain('（すぐ応答する）')
  })

  // 0.6.22（2026-10-12 作者の指摘）: 狭い列でボタンの文字が語の途中で折れていた。
  // 折れ方はソースの形（Tailwind のクラス）で決まるので、形を固定する。
  it('★ 折り返し: ボタンの文字は語の途中で折れず（whitespace-nowrap）、足りなければボタンごと次の行へ（flex-wrap）', () => {
    const at = panel.indexOf("onClick={() => onSetScale('cold')}")
    expect(at).toBeGreaterThan(0)
    const rowAt = panel.lastIndexOf('<div className="', at)
    const row = panel.slice(rowAt, panel.indexOf('{savingScale &&', at))
    expect(row).toContain('<div className="flex flex-wrap gap-2 text-xs">')
    // 2つのボタンの両方に whitespace-nowrap
    const buttons = row.split('<button').slice(1)
    expect(buttons).toHaveLength(2)
    for (const b of buttons) expect(b).toContain('whitespace-nowrap')
    // 色は既存のトークンだけ（ライト・ダークの両方で読めるもの）。生の色や新しい色を足していない
    for (const b of buttons) {
      expect(b).toContain("'border-sakura text-sakura bg-sakura/10'")
      expect(b).toContain("'border-line text-ink-muted hover:text-ink'")
      expect(b).not.toMatch(/#[0-9a-fA-F]{3,8}\b|text-(white|black)\b|bg-(white|black)\b/)
    }
  })

  it('★ 名前は短い（狭い列でも1行に収まる）: 14文字以内', () => {
    expect(scaleLabel(0).length).toBeLessThanOrEqual(14)
    expect(scaleLabel(1).length).toBeLessThanOrEqual(14)
  })

  it('onSetScale は cold/warm の2値のみで呼ばれる（保存する値は今までどおり2値）', () => {
    expect(panel).toContain("onClick={() => onSetScale('cold')}")
    expect(panel).toContain("onClick={() => onSetScale('warm')}")
  })

  // お金の経路: 名前と保存する値の結びつき。入れ替わると、安いほうの名前を選んだ人に常時起動（min≥1）が保存され、
  // 料金がかかり続ける。「ファイルのどこかに名前がある」だけでは入れ替えを見逃すので（2026-10-13 の変異で実証）、
  // onClick から次の </button> までを切り出して、その中の名前を見る。
  it('★ 名前と値の結びつき: cold を保存するボタンの名前は scaleLabel(0)、warm を保存するボタンは scaleLabel(1)', () => {
    expect(scaleLabel(0)).toBe('最初のアクセスが遅くてもよい')
    expect(scaleLabel(1)).toBe('常時起動')
    const countOf = (s: string): number => panel.split(s).length - 1
    const buttonOf = (choice: 'cold' | 'warm'): string => {
      const click = `onClick={() => onSetScale('${choice}')}`
      expect(countOf(click), `${click} はちょうど1か所`).toBe(1)
      const start = panel.indexOf(click)
      return panel.slice(start, panel.indexOf('</button>', start) + '</button>'.length)
    }
    const cold = buttonOf('cold')
    const warm = buttonOf('warm')
    expect(cold.endsWith(`>${scaleLabel(0)}</button>`)).toBe(true)
    expect(warm.endsWith(`>${scaleLabel(1)}</button>`)).toBe(true)
    // 取り違え（安いボタンに常時起動の名前、またはその逆）が無いこと
    expect(cold).not.toContain(scaleLabel(1))
    expect(warm).not.toContain(scaleLabel(0))
  })

  // 表示（ボタンのハイライト・説明文）は scaleDisplay（3値）の判定を使う。
  // scaleChoice のまま使うと、範囲外の値で「課金されません」と嘘をつく（下のdescribeで確認）。
  it('表示は const display = scaleDisplay(spec.service.scale.min) から作る', () => {
    expect(panel).toContain('const display = scaleDisplay(spec.service.scale.min)')
    expect(panel).toContain("display === 'cold'")
    expect(panel).toContain("display === 'warm'")
  })

  it('保存は既存の env.json 保存経路（cloud.saveEnv）を使い、新設していない', () => {
    const at = panel.indexOf('const setScale = async (choice: ScaleChoice) => {')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, at + 500)
    expect(block).toContain('window.electronAPI.cloud.saveEnv(projectDir, next)')
    expect(block).toContain('scaleMinFor(choice)')
    // max は触らない（既存の scale.max をそのまま展開で引き継ぐ）
    expect(block).toContain('...spec.service.scale')
  })

  it('「すぐ返す」を選ぶと、何が変わるかを1行で伝える（料金がかかることの明示）', () => {
    expect(panel).toContain('その分の料金がかかります')
    expect(panel).toContain('インスタンスが動き続けるため')
  })

  it('⚠️ 金額を書いていない（確かめていない数字を書かない・掟1）: warm選択時の説明ブロックに円建ての数字が無い', () => {
    const at = panel.indexOf("const display = scaleDisplay(spec.service.scale.min)")
    expect(at).toBeGreaterThan(0)
    const end = panel.indexOf('})()', at)
    expect(end).toBeGreaterThan(at)
    const block = panel.slice(at, end)
    expect(block).toContain('その分の料金がかかります')
    expect(block).not.toMatch(/[\d,]+\s*円/)
  })

  it('既定は0のまま変えていない（defaultSpec の scale.min は 0）', () => {
    const spec = readFileSync(join(__dirname, '..', 'src/main/cloud/spec.ts'), 'utf-8')
    expect(spec).toContain('scale: { min: 0, max: 1 }')
  })

  // ── #31 の検分（2026-09-09）で見つかった【低】: 範囲外の値を cold と言い切らない ──
  it('★ 範囲外（unknown）のときは「判断できません」と出し、断定しない', () => {
    const at = panel.indexOf("const display = scaleDisplay(spec.service.scale.min)")
    const end = panel.indexOf('})()', at)
    const block = panel.slice(at, end)
    // 3値の判定（cold/warm/unknown のどれかで文言を分けている）になっていること
    expect(block).toContain("display === 'warm'")
    expect(block).toContain("display === 'cold'")
    expect(block).toContain('いまの設定を判断できません')
    // cold の文言と unknown の文言は、同じ三項演算子の別の枝として出ていること
    const coldAt = block.indexOf(": display === 'cold'") // 説明の枝（ボタンの色の分岐ではなく）
    const coldBranch = block.slice(coldAt, block.indexOf('いまの設定を判断できません'))
    expect(coldBranch).toContain('アクセスが無い間は止まるので、安く済みます（既定）。')
  })

  // ── 判断4（利用者目線レビュー・2026-09-11）: 「起動のしかた」の説明を scaleLabel と揃える ──
  // 以前は cold のとき「課金されません」と言い切っていたが、止まっている間の実額を
  // 確かめたわけではないため、料金がかからないとは言い切らない。
  // 2026-10-09 画面の文を短くする: ボタン名（scaleLabel(0)＝「最初のアクセスが遅くてもよい」）の
  // 言い直しは説明から外した。「安い」はボタン側の名前が言い、説明は止まることと起動待ちだけを言う。
  it('★ cold の説明は料金がかからないとは言い切らず、ボタン名の言い直しも戻さない', () => {
    const at = panel.indexOf("const display = scaleDisplay(spec.service.scale.min)")
    const end = panel.indexOf('})()', at)
    const block = panel.slice(at, end)
    const coldAt = block.indexOf(": display === 'cold'") // 説明の枝（ボタンの色の分岐ではなく）
    const coldBranch = block.slice(coldAt, block.indexOf('いまの設定を判断できません'))
    expect(coldBranch).not.toContain('scaleLabel(0)')
    expect(coldBranch).not.toContain('課金されません')
    expect(coldBranch).not.toContain('料金がかかりません')
    expect(scaleLabel(0)).toBe('最初のアクセスが遅くてもよい')
    // 0.6.22: 説明がボタンの名前（「最初のアクセスが遅くてもよい」）を言い直していない。説明は止まることと安いことだけ言う
    const coldCode = coldBranch.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n') // コメントを除く
    expect(coldCode).not.toContain('最初のアクセス')
    expect(coldCode).not.toContain('起動を待ちます')
  })

  // ── 期限（TTL）の選択と説明（0.6.22・2026-10-12 作者の指摘）──
  // 選択肢「期限なし（継続運用）」の下で「期限なし。破棄するまで動き続けます（課金も継続）。」と同じことを言い直していた。
  // 選択肢は「期限なし」だけにし、説明は破棄するまで動くことと、課金が続くこと（お金の文）だけを言う。
  it('★ 期限なし: 選択肢は「期限なし」だけ。説明は言い直さず、課金が続くことは削らない', () => {
    expect(panel).toContain("{ hours: 0, label: '期限なし' },")
    expect(panel).not.toContain('期限なし（継続運用）')
    expect(panel).toContain("'破棄するまで動き続け、課金も続きます。'")
    expect(panel).not.toContain("'期限なし。")
  })

  // ── #31 の検分（2026-09-09）で見つかった【低】: リンク先とラベルの不一致 ──
  // targetProfiles の serviceUrl は AppRun の公式サイト（製品ページ）であって、料金だけの
  // ページではない。同じ URL を、この画面の別の場所では「公式サイトを見る」と呼んでいる。
  // ラベルと行き先を合わせる（推測で料金ページのURLを作らない・掟1）。
  it('★ 「すぐ返す」の説明にあるリンクは、行き先と同じ呼び方（公式サイトを見る）にする', () => {
    expect(panel).not.toContain('料金ページ ↗')
    const at = panel.indexOf("const display = scaleDisplay(spec.service.scale.min)")
    const end = panel.indexOf('})()', at)
    const block = panel.slice(at, end)
    expect(block).toContain('公式サイトを見る ↗')
  })
})

// ── 掟9: README・使い方ガイドの最小スケールの書き方は、画面のボタンの名前と同じ（0.6.22）──
// ボタンは名前だけ（scaleLabel と同じ言葉）。文書が古い形（名前に「（既定・安い）」を付ける）へ戻ると、画面とずれる。
describe('README・使い方ガイド: 最小スケールの2つの名前を、画面と同じ言葉で鉤括弧つきで書く', () => {
  const docs: [string, string][] = [
    ['README.md', readFileSync(join(__dirname, '..', 'README.md'), 'utf-8')],
    ['docs/usage-guide.html', readFileSync(join(__dirname, '..', 'docs/usage-guide.html'), 'utf-8')],
  ]
  for (const [name, text] of docs) {
    it(`${name}: 「${scaleLabel(0)}」と「${scaleLabel(1)}」が出ていて、旧い形は戻していない`, () => {
      expect(text).toContain(`「${scaleLabel(0)}」`)
      expect(text).toContain(`「${scaleLabel(1)}」`)
      expect(text).not.toContain('（既定・安い）')
      expect(text).not.toContain('（すぐ応答する）')
      expect(text).not.toContain('すぐ返す（常時動かす）')
    })
  }
})
