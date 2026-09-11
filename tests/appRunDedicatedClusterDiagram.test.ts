import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildClusterDiagram, priceSummary } from '../src/renderer/components/AppRunDedicatedPanel'

// Ryosuke さんの要望「クラスタを作成するボタンの上に、簡易的な構成を示せないか」への対応。
// 承認済みの方針は「自前の図形（箱と文字）で描く」——さくらの公式アイコンはガイドラインが
// 「アイコンそのものの再配布」を禁じており、非公式ツールが画面に埋め込むと公認と誤解させ
// うるため使わない。

describe('buildClusterDiagram: 「実物の既定」（ワーカ1vCPU/2GB×1台・LB 1vCPU/2GB非冗長・tk1a・80/443）を渡した結果', () => {
  // 月額は priceSummary（既存・実際に呼ぶ）から作る。計算を複製しない（掟10）。
  // path は apprunDedicatedWiring.test.ts の実測どおりの形式（cloud/apprun/dedicated/worker|lb/…）。
  const price = priceSummary(
    { path: 'cloud/apprun/dedicated/worker/1vcpu_2gb' },
    { path: 'cloud/apprun/dedicated/lb/1vcpu_2gb_1', nodeCount: 1 },
    1,
  )

  const result = buildClusterDiagram({
    clusterName: 'myapp',
    zone: 'tk1a',
    ports: [{ port: 80, protocol: 'http' }, { port: 443, protocol: 'https' }],
    workerPlanName: '1vCPU/2GB',
    minNodes: 1,
    lbPlanName: '1vCPU/2GB非冗長',
    priceText: price.text,
  })

  it('priceSummary は実額を返す（表にあるプランなので「月額を出せません」ではない）', () => {
    expect(price.totalYen).toBe(11000 + 11000)
    expect(price.text).not.toContain('出せません')
  })

  it('選んだ内容がそのまま行に出る', () => {
    expect(result.lines).toEqual([
      'クラスタ〈myapp〉',
      '└ オートスケーリンググループ　ワーカ〈1vCPU/2GB〉× 1台',
      '└ ロードバランサ　　　　　　　〈1vCPU/2GB非冗長〉',
      'ゾーン〈tk1a〉／ 共有セグメント ／ 公開ポート〈80/http, 443/https〉',
    ])
  })

  it('合計は priceSummary.text をそのまま使う（自前計算していない）', () => {
    expect(result.total).toBe(`合計 ${price.text}`)
    expect(result.total).toContain('月額 22,000円')
  })
})

describe('buildClusterDiagram: maxNodes > minNodes のとき、最大構成の額も合計に出る（2026-09-10 レビューの修理・G）', () => {
  it('priceSummary(..., minNodes, maxNodes) の text をそのまま total に使う（自前計算していない）', () => {
    const price = priceSummary(
      { path: 'cloud/apprun/dedicated/worker/1vcpu_2gb' },
      { path: 'cloud/apprun/dedicated/lb/1vcpu_2gb_1', nodeCount: 1 },
      1, 3,
    )
    const result = buildClusterDiagram({
      clusterName: 'myapp', zone: 'tk1a',
      ports: [{ port: 80, protocol: 'http' }, { port: 443, protocol: 'https' }],
      workerPlanName: '1vCPU/2GB', minNodes: 1, lbPlanName: '1vCPU/2GB非冗長',
      priceText: price.text,
    })
    expect(result.total).toContain('月額 22,000円')
    expect(result.total).toContain('最小構成')
    expect(result.total).toContain('最大 3台')
    expect(result.total).toContain('月額 44,000円')
  })
})

describe('buildClusterDiagram: 未入力のときは「（未入力）」と出す（推測で埋めない）', () => {
  const result = buildClusterDiagram({
    clusterName: '',
    zone: '',
    ports: [],
    workerPlanName: null,
    minNodes: NaN,
    lbPlanName: null,
    priceText: priceSummary(null, null, 1).text,
  })

  it('クラスタ名・ワーカプラン・LBプラン・ゾーン・ポート・台数のすべてが未入力表示になる', () => {
    expect(result.lines[0]).toBe('クラスタ〈（未入力）〉')
    expect(result.lines[1]).toBe('└ オートスケーリンググループ　ワーカ〈（未入力）〉× （未入力）')
    expect(result.lines[2]).toBe('└ ロードバランサ　　　　　　　〈（未入力）〉')
    expect(result.lines[3]).toBe('ゾーン〈（未入力）〉／ 共有セグメント ／ 公開ポート〈（未入力）〉')
  })

  it('推測で埋めた値（0台・空文字のプラン名等）は一切出さない', () => {
    const joined = result.lines.join('\n')
    expect(joined).not.toMatch(/×\s*0台/)
    expect(joined).not.toMatch(/〈〉/)
  })
})

// ── 2026-09-09 検分で見つかった【低】 ────────────────────────────────────
// 「+ ポートを追加」は {port:0, protocol:'http'} を積む（＝未入力の意味）。押した直後の
// 図に「公開ポート〈0/http〉」と出ると、利用者が入れていない 0 を設定値として見せてしまう。
// 同様に、プラン選択のオブジェクトが name:'' を持つ経路では workerPlanName/lbPlanName に
// 空文字が渡ることがあり、`?? DIAGRAM_UNSET` は null/undefined しか拾わないため「〈〉」と出る。
describe('buildClusterDiagram: 「入っているが未入力の意味」の値も（未入力）に倒す（2026-09-09 検分）', () => {
  it('★ 「+ ポートを追加」直後の port:0 は、そのポートだけ（未入力）にする（0/http と出さない）', () => {
    const result = buildClusterDiagram({
      clusterName: 'myapp', zone: 'tk1a',
      ports: [{ port: 0, protocol: 'http' }],
      workerPlanName: '1vCPU/2GB', minNodes: 1, lbPlanName: '1vCPU/2GB非冗長',
      priceText: priceSummary(null, null, 1).text,
    })
    expect(result.lines[3]).toContain('公開ポート〈（未入力）〉')
    expect(result.lines[3]).not.toContain('0/http')
  })

  it('複数ポートのうち一部だけ 0（未入力）なら、その1件だけ（未入力）にする', () => {
    const result = buildClusterDiagram({
      clusterName: 'myapp', zone: 'tk1a',
      ports: [{ port: 80, protocol: 'http' }, { port: 0, protocol: 'https' }],
      workerPlanName: '1vCPU/2GB', minNodes: 1, lbPlanName: '1vCPU/2GB非冗長',
      priceText: priceSummary(null, null, 1).text,
    })
    expect(result.lines[3]).toContain('公開ポート〈80/http, （未入力）〉')
  })

  it('★ プラン名が空文字のときは〈〉ではなく（未入力）にする', () => {
    const result = buildClusterDiagram({
      clusterName: 'myapp', zone: 'tk1a',
      ports: [{ port: 80, protocol: 'http' }],
      workerPlanName: '', minNodes: 1, lbPlanName: '',
      priceText: priceSummary(null, null, 1).text,
    })
    expect(result.lines[1]).toContain('ワーカ〈（未入力）〉')
    expect(result.lines[2]).toContain('ロードバランサ　　　　　　　〈（未入力）〉')
    expect(result.lines.join('\n')).not.toMatch(/〈〉/)
  })
})

describe('buildClusterDiagram: 料金表に無いプランなら「月額を出せません」をそのまま出す', () => {
  it('priceSummary が「月額を出せません」を返せば、total にそのまま含まれる', () => {
    const price = priceSummary(
      { path: 'cloud/apprun/dedicated/worker/16vcpu_64gb' }, // 料金表に無い（実測済みプラン外）
      { path: 'cloud/apprun/dedicated/lb/1vcpu_2gb_1', nodeCount: 1 },
      1,
    )
    expect(price.totalYen).toBeNull()
    const result = buildClusterDiagram({
      clusterName: 'myapp', zone: 'tk1a', ports: [{ port: 80, protocol: 'http' }],
      workerPlanName: '16vCPU/64GB', minNodes: 1, lbPlanName: '1vCPU/2GB非冗長',
      priceText: price.text,
    })
    expect(result.total).toContain('月額を出せません')
  })
})

// 画面側の配線（React 実レンダリングのテストインフラが無いため、ソーステキストを固定する
// apprunDedicatedWiring.test.ts と同じ流儀）。
const panel = readFileSync(join(__dirname, '..', 'src/renderer/components/AppRunDedicatedPanel.tsx'), 'utf-8')

describe('AppRunDedicatedPanel.tsx: 構成図は⑤「クラスタを作成する」ボタンのすぐ上にある', () => {
  it('diagram は buildClusterDiagram(...) から作り、priceSummary の text をそのまま渡している（自前計算していない）', () => {
    const at = panel.indexOf('const diagram = buildClusterDiagram({')
    expect(at).toBeGreaterThan(0)
    const end = panel.indexOf('})', at)
    const block = panel.slice(at, end)
    expect(block).toContain('priceText: price.text')
  })

  it('diagram の描画から「クラスタを作成する」ボタンまでの間に、他の入力欄を挟んでいない', () => {
    const diagramAt = panel.indexOf('{diagram.lines.join')
    const buttonAt = panel.indexOf(">{creating ? 'クラスタ→ASG→LB の順で作成しています…' : 'クラスタを作成する'}</button>")
    expect(diagramAt).toBeGreaterThan(0)
    expect(buttonAt).toBeGreaterThan(diagramAt)
    const between = panel.slice(diagramAt, buttonAt)
    // 挟んでよいのは generalErrors（条件つきの警告文。判断7・2026-09-11）だけ。新しい <input>/<select> は無い。
    expect(between).not.toContain('<input')
    expect(between).not.toContain('<select')
  })

  it('画像・SVGは使わない（CSSの枠と文字だけ）', () => {
    const at = panel.indexOf('{diagram.lines.join')
    const block = panel.slice(at - 300, at + 300)
    expect(block).not.toContain('<svg')
    expect(block).not.toContain('<img')
  })
})
