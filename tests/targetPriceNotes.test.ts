import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appRunSharedCardNote, otherTargetPriceNote, registryNotFoundCostNote, REGISTRY_MONTHLY_YEN } from '../src/shared/cloudCost'

// 公開先を選ぶカード・HANAMII と Vercel のパネルの冒頭・「↻ 設定し直す」の下に出す、費用の文。
//   ・作り手（shared/cloudCost.ts の appRunSharedCardNote・otherTargetPriceNote）: 金額は定数から取り、HANAMII・Vercel の金額は書かない
//   ・選択カードを本物の PublishModal で描いて、作り手の文と一致することは tests/ops-modal-behavior.test.ts が固定している
//   ・ここでは作り手そのものと、描きにくい所（パネルの冒頭・設定し直すボタンの下・新規作成のヒント）の配線を固定する

const ROOT = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
const count = (s: string, part: string) => s.split(part).length - 1

/** 新しく足した画面の文に書いてはいけない言葉（Claude Code の名前・無償・無料・丸数字）。 */
const FORBIDDEN = /Claude Code|無償|無料|[①-⑳㉑-㊿]/

describe('appRunSharedCardNote（AppRun の選択カードの文）', () => {
  it('既定の文は、共用型の使った分の課金・レジストリの月額・専有型の常時課金を、この順に言う', () => {
    expect(appRunSharedCardNote()).toBe(
      'アプリを動かせる公開先です。準備は Koto がまとめて行います。'
      + `「共用型」はアプリの実行が使った分の課金で、ほかにコンテナレジストリの月額${REGISTRY_MONTHLY_YEN}円（税込）がかかります。`
      + '独自ドメインが使える「専有型」は上級者向けの常時課金です。',
    )
  })

  it('金額を引数で上書きすると、その金額が出る（定数を直書きに戻すと落ちる）', () => {
    const n = appRunSharedCardNote({ registryYen: 999 })
    expect(n).toContain('月額999円（税込）')
    expect(n).not.toContain(`${REGISTRY_MONTHLY_YEN}円`)
  })

  it('専有型の金額は書かない（プランを取得しないと分からない）。金額は1つだけ', () => {
    const n = appRunSharedCardNote({ registryYen: 999 })
    expect(count(n, '円')).toBe(1)
    expect(n).not.toMatch(/万円|20,000|22,000/)
  })

  it('記法・料金の言い換え・ブランドの禁句を混ぜない', () => {
    const n = appRunSharedCardNote()
    expect(n).not.toMatch(/\*\*|__|`|\[[^\]]+\]\([^)]+\)/)
    expect(n).not.toMatch(FORBIDDEN)
  })

  it('作り手の中に金額の数字を書かず、`opts.registryYen ?? REGISTRY_MONTHLY_YEN` で取る', () => {
    const src = read('src/shared/cloudCost.ts')
    const body = src.slice(src.indexOf('export function appRunSharedCardNote'), src.indexOf('/** 料金の案内を出す、さくら以外の公開先。 */'))
    expect(body.length).toBeGreaterThan(100)
    expect(body).toContain('const yen = opts.registryYen ?? REGISTRY_MONTHLY_YEN')
    expect(body).not.toMatch(/\b220\b/)
  })
})

describe('otherTargetPriceNote（HANAMII・Vercel の料金の案内）', () => {
  it('HANAMII と Vercel それぞれの名前で、公式サイトで確かめるよう言う', () => {
    expect(otherTargetPriceNote('hanamii')).toBe('料金は HANAMII の公式サイトでご確認ください。')
    expect(otherTargetPriceNote('vercel')).toBe('料金は Vercel の公式サイトでご確認ください。')
  })

  it('数字も円も書かない（原本で確かめていない金額を言わない）。禁句の検査も通る', () => {
    for (const t of ['hanamii', 'vercel'] as const) {
      const n = otherTargetPriceNote(t)
      expect(n, t).not.toMatch(/[0-9０-９]/)
      expect(n, t).not.toMatch(/円|月額|税込|万/)
      expect(n, t).not.toMatch(FORBIDDEN)
      expect(n, t).not.toMatch(/\*\*|__|`|\[[^\]]+\]\([^)]+\)/)
    }
  })

  it('文の中に URL を書かない（行き先は各パネルにある公式サイトのリンクだけ）', () => {
    for (const t of ['hanamii', 'vercel'] as const) expect(otherTargetPriceNote(t), t).not.toMatch(/https?:|\.com|\.jp/)
  })

  it('作り手の中にも、金額の数字と URL を書かない', () => {
    const src = read('src/shared/cloudCost.ts')
    const from = src.indexOf('/** 料金の案内を出す、さくら以外の公開先。 */')
    const body = src.slice(from, src.indexOf('\n}\n', src.indexOf('export function otherTargetPriceNote')) + 3)
    expect(body.length).toBeGreaterThan(200)
    expect(body.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/[0-9０-９]|https?:/)
  })
})

describe('選択カードの配線（PublishModal.tsx）', () => {
  const modal = read('src/renderer/components/PublishModal.tsx')

  it('AppRun のカードは作り手を呼ぶ。直す前の文は残さない', () => {
    expect(modal).toContain('<p className="text-xs text-ink-muted mt-0.5">{appRunSharedCardNote()}</p>')
    expect(modal).toContain("import { appRunSharedCardNote, otherTargetPriceNote } from '../../shared/cloudCost'")
    expect(modal).not.toContain('使った分だけ課金の「共用型」と')
    expect(modal).not.toContain('専有型（上級者向け・常時課金）を選べます')
  })

  it('HANAMII のカードと Vercel のカードは、それぞれ自分の名前で作り手を呼ぶ（取り違えない）', () => {
    expect(count(modal, "{otherTargetPriceNote('hanamii')}")).toBe(1)
    expect(count(modal, "{otherTargetPriceNote('vercel')}")).toBe(1)
    const hanamii = modal.slice(modal.indexOf("onClick={() => setTarget('hanamii')}"), modal.indexOf("onClick={() => setTarget('vercel')}"))
    const vercel = modal.slice(modal.indexOf("onClick={() => setTarget('vercel')}"), modal.indexOf("onClick={() => setTarget('sakura-vps')}"))
    expect(hanamii).toContain("{otherTargetPriceNote('hanamii')}")
    expect(hanamii).not.toContain("otherTargetPriceNote('vercel')")
    expect(vercel).toContain("{otherTargetPriceNote('vercel')}")
    expect(vercel).not.toContain("otherTargetPriceNote('hanamii')")
  })

  it('カードの中に料金ページの URL を書かない・円も書かない（リンクはパネルの公式サイトだけ）', () => {
    const start = modal.indexOf('// ── 公開先の選択（ローカルのみ／未設定のプロジェクト） ──')
    const end = modal.indexOf("target === 'sakura-rental' ? (")
    const cards = modal.slice(start, end).replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    expect(cards).not.toMatch(/https?:\/\//)
    expect(cards).not.toMatch(/\d円/)
  })

  it('PublishModal.tsx は足しても 1,000 行を超えない', () => {
    expect(modal.split('\n').length).toBeLessThan(1000)
  })
})

describe('パネル冒頭の配線（HanamiiPanel.tsx・VercelPanel.tsx）', () => {
  /** 冒頭のカード（見出しから、手順1の前まで）。 */
  const head = (src: string, title: string) => src.slice(src.indexOf(title), src.indexOf('手順1 ', src.indexOf(title)))

  it('HANAMII の冒頭は、自分の名前の文を、公式サイトのリンクの前に出す', () => {
    const src = read('src/renderer/components/HanamiiPanel.tsx')
    const h = head(src, '🌸 HANAMII（国産のクラウドサービス）で公開')
    expect(h).toContain("<p className=\"text-xs text-ink-muted leading-relaxed\">{otherTargetPriceNote('hanamii')}</p>")
    expect(h.indexOf("otherTargetPriceNote('hanamii')")).toBeLessThan(h.indexOf('公式サイトを見る'))
    expect(h).not.toContain("otherTargetPriceNote('vercel')")
    expect(src).toContain("import { otherTargetPriceNote } from '../../shared/cloudCost'")
  })

  it('Vercel の冒頭は、自分の名前の文を、公式サイトのリンクの前に出す', () => {
    const src = read('src/renderer/components/VercelPanel.tsx')
    const h = head(src, '▲ Vercel（海外のクラウドサービス）で公開')
    expect(h).toContain("<p className=\"text-xs text-ink-secondary leading-relaxed\">{otherTargetPriceNote('vercel')}</p>")
    expect(h.indexOf("otherTargetPriceNote('vercel')")).toBeLessThan(h.indexOf('公式サイトを見る'))
    expect(h).not.toContain("otherTargetPriceNote('hanamii')")
    expect(src).toContain("import { otherTargetPriceNote } from '../../shared/cloudCost'")
  })

  it('リンクは既存の serviceUrl だけ。冒頭に URL の直書きも、金額も無い', () => {
    for (const [file, title, id] of [
      ['src/renderer/components/HanamiiPanel.tsx', '🌸 HANAMII（国産のクラウドサービス）で公開', 'hanamii'],
      ['src/renderer/components/VercelPanel.tsx', '▲ Vercel（海外のクラウドサービス）で公開', 'vercel'],
    ] as const) {
      const h = head(read(file), title)
      expect(h, file).toContain(`<a href={getTargetProfile('${id}').serviceUrl} className="hover:underline">🌐 公式サイトを見る ↗</a>`)
      expect(h, file).not.toMatch(/https?:\/\//)
      expect(h, file).not.toMatch(/円|月額/)
    }
  })
})

describe('「↻ 設定し直す」の下の文（AppRunPanel.tsx）', () => {
  const panel = read('src/renderer/components/AppRunPanel.tsx')
  const at = panel.indexOf("c.fix === 'reset-registry' && (")
  const block = panel.slice(at, panel.indexOf("c.fix === 'ask-ai' && (", at))

  it('確認の結果の「↻ 設定し直す」ボタンの直下に、見つからないときは新しく作るので月額がかかる、と作り手の文で言う', () => {
    expect(at).toBeGreaterThan(0)
    const button = block.indexOf(">{regCreating ? '設定し直しています…' : '↻ 設定し直す'}</button>")
    const note = block.indexOf('{registryNotFoundCostNote()}')
    expect(button).toBeGreaterThan(0)
    expect(note).toBeGreaterThan(button)
    expect(registryNotFoundCostNote()).toBe(`見つからないときは新しく作るので、月額${REGISTRY_MONTHLY_YEN}円（税込）がかかります。`)
  })

  it('金額を直に組まない。「設定し直す」の2つの説明（確認の結果・失敗の hint）が同じ作り手を通る', () => {
    expect(block).not.toContain('REGISTRY_MONTHLY_YEN')
    expect(block).not.toMatch(/\d円/)
    expect(count(panel, '{registryNotFoundCostNote()}')).toBe(2)
  })

  it('ボタンを押す入口は増やさない（autoCreateRegistry を呼ぶ onClick は2つのまま）', () => {
    expect(count(panel, 'onClick={autoCreateRegistry}')).toBe(2)
  })
})

describe('新規作成の公開先のヒント（NewProjectModal.tsx）は、料金を言わない', () => {
  // 作った時点では費用は出ず、選択カードと前提チェックの行で言えば足りる。ヒントには足さない。
  const src = read('src/renderer/components/NewProjectModal.tsx')
  const targets = src.slice(src.indexOf('const TARGETS:'), src.indexOf('// 公開先のグループ表示順とタイトル'))

  it('AppRun・HANAMII・Vercel の行のヒントに、金額も料金の案内も無い', () => {
    for (const id of ['sakura-apprun', 'hanamii', 'vercel']) {
      const line = targets.split('\n').find(l => l.includes(`{ id: '${id}'`))
      expect(line, id).toBeTruthy()
      expect(line, id).not.toMatch(/円|月額|税込|料金|課金/)
    }
  })

  it('このファイルは作り手を使わない（選択カードの文を複製しない）', () => {
    expect(src).not.toContain('appRunSharedCardNote')
    expect(src).not.toContain('otherTargetPriceNote')
  })
})
