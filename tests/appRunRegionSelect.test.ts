import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// roadmap #34（2026-09-08 実測で決着）。
//
// 一度は region（ゾーン）を選択式にしていたが、その根拠
// 「createContainerRegistry(spec.region, …) がレジストリの置き場所を決める」（＝
// レジストリはゾーンに属する）は実測していなかった。一方 src/main/ipc/cloud.ts の
// 棚卸し（cloud:inventory）は「レジストリは全ゾーン共通（グローバル資源）」という
// 正反対の前提で is1a だけを引いていた。2026-09-08、`scripts/probe-registry-zone.mjs`
// を4ゾーン（is1a/tk1a/tk1b/is1b）で実行し、**全ゾーン共通**であることが実測で決着した。
//
// これにより、選択式のために作った「レジストリの有無」判定の仕掛け（取り下げた選択式の
// 出し分けにしか使っていなかったもの）は根拠を失い削除した。region 欄の注意書きは
// 実測に基づく正しい内容に差し替えた。
//
// このファイルは実装をソーステキストとして固定する（apprunDedicatedWiring.test.ts と同じ
// 「wiring テスト」の流儀。React コンポーネントを実レンダリングするテストインフラが無いため）。

const panel = readFileSync(join(__dirname, '..', 'src/renderer/components/AppRunPanel.tsx'), 'utf-8')
const dedicated = readFileSync(join(__dirname, '..', 'src/renderer/components/AppRunDedicatedPanel.tsx'), 'utf-8')
const app = readFileSync(join(__dirname, '..', 'src/renderer/App.tsx'), 'utf-8')

describe('App.tsx: primeZonesCache() を起動時に呼んでいる', () => {
  it("import して、primeLearningMirror/primeUsageMirror と同じ useEffect で呼ぶ", () => {
    expect(app).toContain("import { primeZonesCache } from './zonesCache'")
    const at = app.indexOf('useEffect(() => { primeLearningMirror(); primeUsageMirror()')
    expect(at).toBeGreaterThan(0)
    expect(app.slice(at, at + 200)).toContain('primeZonesCache()')
  })
})

describe('AppRunPanel.tsx: region は表示専用（roadmap #34・2026-09-08 実測で決着。恒久的に選択式は出さない）', () => {
  it('zonesCache / AppRunDedicatedPanel の selectableZones への依存を消してある（選択のための仕掛けを残さない）', () => {
    expect(panel).not.toContain("from '../zonesCache'")
    expect(panel).not.toContain("from './AppRunDedicatedPanel'")
  })

  it('region を保存する setRegion・保存中フラグ savingRegion・選択肢 zoneOptions は無い', () => {
    expect(panel).not.toContain('const setRegion = ')
    expect(panel).not.toContain('savingRegion')
    expect(panel).not.toContain('zoneOptions')
  })

  it('根拠を失った「レジストリの有無」の3状態判定・その読み込み完了フラグはもう存在しない', () => {
    expect(panel).not.toContain('registryLockState')
    expect(panel).not.toContain('registryNameLoaded')
  })

  it('<SpecSummary> は registryLock / registryName / zoneOptions / savingRegion / onSetRegion のいずれも渡さない', () => {
    const at = panel.indexOf('<SpecSummary')
    expect(at).toBeGreaterThan(0)
    const end = panel.indexOf('/>', at)
    const block = panel.slice(at, end)
    expect(block).not.toContain('registryLock')
    expect(block).not.toContain('registryName')
    expect(block).not.toContain('onSetRegion')
    expect(block).not.toContain('savingRegion')
  })

  it('SpecSummary の関数定義も registryLock / registryName の props を受け取らない', () => {
    const at = panel.indexOf('function SpecSummary(')
    expect(at).toBeGreaterThan(0)
    const end = panel.indexOf(') {', at)
    const block = panel.slice(at, end)
    expect(block).not.toContain('registryLock')
    expect(block).not.toContain('registryName')
  })

  it('region の欄は常に spec.region を表示するだけで <select> を出さない。実測に基づく注記があり、誤った文言は無い', () => {
    const at = panel.indexOf('<dt className="text-ink-muted">region</dt>')
    expect(at).toBeGreaterThan(0)
    const end = panel.indexOf('</dd>', at)
    const block = panel.slice(at, end)
    expect(block).not.toContain('<select')
    expect(block).toContain('{spec.region}')
    // 実測に基づく正しい注記（全ゾーン共通・実測日）が入っていること。
    expect(block).toContain('全ゾーン共通')
    expect(block).toContain('2026-09-08')
    expect(block).toContain('どのゾーン経由でも同じ結果になります')
    // 取り下げた誤った文言・古い「確認中」文言がもう無いこと。
    expect(block).not.toContain('いまこのゾーンで動いています')
    expect(block).not.toContain('確認中')
    expect(block).not.toContain('ゾーンに属するか')
  })
})

describe('AppRunPanel.tsx: 公開が成功したら registryName を取り直す（doApply → refreshRegistryName・消しすぎの検出）', () => {
  it('doApply() は cloud.apply が ok を返したあと refreshRegistryName() を呼ぶ', () => {
    const at = panel.indexOf('const doApply = async () => {')
    expect(at).toBeGreaterThan(0)
    const end = panel.indexOf('\n  const doTeardown = async () => {', at)
    expect(end).toBeGreaterThan(at)
    const block = panel.slice(at, end)
    // 「成功したら」の分岐（if (r.ok) { ... }）の中に、refreshRegistryName() と
    // sakura-meta-changed の両方が入っていること（呼び出しの形ごと確かめる。掟10）。
    const okAt = block.indexOf('if (r.ok) {')
    expect(okAt).toBeGreaterThan(0)
    const okEnd = block.indexOf('\n      }', okAt)
    const okBlock = block.slice(okAt, okEnd)
    expect(okBlock).toContain('refreshRegistryName()')
    expect(okBlock).toContain("window.dispatchEvent(new Event('sakura-meta-changed'))")
  })
})

describe('AppRunPanel.tsx: refreshRegistryName() / registryName state 自体は健在（破棄画面・費用案内が使う）', () => {
  it('refreshRegistryName は cloud.registryName を読んで registryName / registryAdopted / deleteRegistry を更新する', () => {
    const at = panel.indexOf('const refreshRegistryName = () => {')
    expect(at).toBeGreaterThan(0)
    const end = panel.indexOf('\n  }', at)
    const block = panel.slice(at, end)
    expect(block).toContain('window.electronAPI.cloud.registryName(projectDir)')
    expect(block).toContain('setRegistryName(')
  })

  it('registryName state はマウント時／プロジェクト切替時にも取り直す（[projectDir] effect）', () => {
    const at = panel.indexOf('// マウント時／プロジェクト切替時に状態を初期化して読み込む\n  useEffect(() => {')
    expect(at).toBeGreaterThan(0)
    const end = panel.indexOf('}, [projectDir])', at)
    expect(end).toBeGreaterThan(at)
    const block = panel.slice(at, end)
    expect(block).toContain('refreshRegistryName()')
    // ほかの状態（conn/plan/confirm/progress/appUrl/limit*）と同じ並びでリセットしていること。
    expect(block).toContain("setConn('idle')")
    expect(block).toContain('setAppUrl(null)')
  })
})

describe('#28/#34 補足: どのゾーン経由でも同じ結果になるもの（請求・レジストリ一覧）は選択式にしていない', () => {
  const cloudIpc = readFileSync(join(__dirname, '..', 'src/main/ipc/cloud.ts'), 'utf-8')

  it("cloud:cost / cloud:testConnection の zone はアカウント単位（is1a 固定）のまま", () => {
    expect(cloudIpc).toContain("const zone = 'is1a' // 請求はアカウント単位（どのゾーン経由でも可）")
    expect(cloudIpc).toContain("const zone = 'is1a' // 請求はアカウント単位（どのゾーン経由でも可）。cost ハンドラと同じ。")
  })

  it('cloud:inventory のレジストリ一覧は is1a 固定のまま。断定には2026-09-08の実測の裏づけが加わっている', () => {
    expect(cloudIpc).toContain("const r = await client.listContainerRegistries('is1a')")
    expect(cloudIpc).toContain('レジストリは全ゾーン共通（グローバル資源）。既定のゾーンで引く')
    // 実測の裏づけ（roadmap #34・2026-09-08）が1行足されていること。
    expect(cloudIpc).toContain('2026-09-08 実測で裏づけ済み')
  })
})

describe('AppRunDedicatedPanel.tsx: 専有型のゾーン選択はそのまま残っている（roadmap #34 とは無関係）', () => {
  it('selectableZones / defaultZone は健在（ASG の作成先ゾーン選択。実測済み・5-9）', () => {
    expect(dedicated).toContain('export function selectableZones(')
    expect(dedicated).toContain('export function defaultZone(')
  })

  it('キーが切り替わったら、画面が持つ zones state を捨てて取り直す（事故の直し6・2026-09-08 検分で指摘）', () => {
    const at = dedicated.indexOf('const h = () => {')
    expect(at).toBeGreaterThan(0)
    const end = dedicated.indexOf('\n    }', at)
    const block = dedicated.slice(at, end)
    expect(block).toContain('setZones(null)')
    expect(block).toContain('loadZones()')
  })
})
