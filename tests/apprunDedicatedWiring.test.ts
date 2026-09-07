import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { priceSummary, planKeyFromPath, monthlyYenForPlanPath, isValidResourceName, isReservedPort, pickCheapestWorkerPlan, pickCheapestLbPlan } from '../src/renderer/components/AppRunDedicatedPanel'

// roadmap #23。段階①「下調べ画面」の配線に加え、段階②「作る」＋④「破棄」の配線を固定する
// （掟6: IPC 3点セット・掟10: 一元化した守りはテストで固定する）。実装をわざと壊すと落ちることを
// 変異試験で別途確かめてある（報告のみ・このファイルは元の形を固定する）。

const ipc = readFileSync(join(__dirname, '..', 'src/main/ipc/apprunDedicated.ts'), 'utf-8')
const index = readFileSync(join(__dirname, '..', 'src/main/ipc/index.ts'), 'utf-8')
const preload = readFileSync(join(__dirname, '..', 'src/main/preload.ts'), 'utf-8')
const globalDts = readFileSync(join(__dirname, '..', 'src/renderer/global.d.ts'), 'utf-8')
const client = readFileSync(join(__dirname, '..', 'src/main/cloud/apprunDedicated.ts'), 'utf-8')
const applyFile = readFileSync(join(__dirname, '..', 'src/main/cloud/apprunDedicatedApply.ts'), 'utf-8')
const panel = readFileSync(join(__dirname, '..', 'src/renderer/components/AppRunDedicatedPanel.tsx'), 'utf-8')
const publishModal = readFileSync(join(__dirname, '..', 'src/renderer/components/PublishModal.tsx'), 'utf-8')
const targetProfiles = readFileSync(join(__dirname, '..', 'src/renderer/targetProfiles.ts'), 'utf-8')

describe('IPC 3点セット（掟6）: main / preload / global.d.ts が揃っている', () => {
  it('main: apprunDedicated:limits / plans / clusters の3つを登録している（段階①）', () => {
    expect(ipc).toContain("ipcMain.handle('apprunDedicated:limits'")
    expect(ipc).toContain("ipcMain.handle('apprunDedicated:plans'")
    expect(ipc).toContain("ipcMain.handle('apprunDedicated:clusters'")
  })

  it('main: apprunDedicated:create / teardown / state の3つを登録している（段階②・④）', () => {
    expect(ipc).toContain("ipcMain.handle('apprunDedicated:create'")
    expect(ipc).toContain("ipcMain.handle('apprunDedicated:teardown'")
    expect(ipc).toContain("ipcMain.handle('apprunDedicated:state'")
  })

  it('main: create/teardown ハンドラは apprunDedicatedApply.ts の createClusterFlow/teardownFlow を呼ぶ', () => {
    expect(ipc).toContain("import { createClusterFlow, teardownFlow")
    expect(ipc).toContain('from \'../cloud/apprunDedicatedApply\'')
    expect(ipc).toContain('createClusterFlow(auth, projectDir, spec)')
    expect(ipc).toContain('teardownFlow(auth, projectDir)')
  })

  it('main: registerApprunDedicatedHandlers が index.ts から呼ばれている', () => {
    expect(index).toContain("import { registerApprunDedicatedHandlers } from './apprunDedicated'")
    expect(index).toContain('registerApprunDedicatedHandlers(deps)')
  })

  it('preload: electronAPI.apprunDedicated.{limits,plans,clusters,create,teardown,state} を公開している', () => {
    expect(preload).toContain("limits: (auth: { token: string; secret: string }) => ipcRenderer.invoke('apprunDedicated:limits', auth)")
    expect(preload).toContain("plans: (auth: { token: string; secret: string }) => ipcRenderer.invoke('apprunDedicated:plans', auth)")
    expect(preload).toContain("clusters: (auth: { token: string; secret: string }) => ipcRenderer.invoke('apprunDedicated:clusters', auth)")
    expect(preload).toContain("ipcRenderer.invoke('apprunDedicated:create', projectDir, auth, spec)")
    expect(preload).toContain("ipcRenderer.invoke('apprunDedicated:teardown', projectDir, auth)")
    expect(preload).toContain("state: (projectDir: string) => ipcRenderer.invoke('apprunDedicated:state', projectDir)")
  })

  it('global.d.ts: Window.electronAPI.apprunDedicated の型に create/teardown/state がある', () => {
    expect(globalDts).toContain('apprunDedicated: {')
    expect(globalDts).toContain('limits(auth: { token: string; secret: string })')
    expect(globalDts).toContain('plans(auth: { token: string; secret: string })')
    expect(globalDts).toContain('clusters(auth: { token: string; secret: string })')
    expect(globalDts).toContain('create(projectDir: string, auth: { token: string; secret: string }, spec:')
    expect(globalDts).toContain('teardown(projectDir: string, auth: { token: string; secret: string })')
    expect(globalDts).toContain('state(projectDir: string)')
  })
})

describe('段階②で追加した破壊系メソッドは apprunDedicated.ts の1箇所（requestJson）に閉じ込めてある', () => {
  it('fetch を直接呼ぶのは requestJson だけ。POST/DELETE は requestJson へ渡す引数として1箇所ずつ以上ある', () => {
    expect((client.match(/await fetch\(/g) ?? []).length).toBe(1)
    const postCount = (client.match(/requestJson[\s\S]{0,40}'POST'/g) ?? []).length
    const deleteCount = (client.match(/requestJson[\s\S]{0,60}'DELETE'/g) ?? []).length
    const putCount = (client.match(/'PUT'/g) ?? []).length
    const patchCount = (client.match(/'PATCH'/g) ?? []).length
    // 段階②が実際に使うのは POST と DELETE のみ（PUT/PATCH はこの範囲では使わない）。
    expect(putCount).toBe(0)
    expect(patchCount).toBe(0)
    expect(postCount).toBeGreaterThan(0)
    expect(deleteCount).toBeGreaterThan(0)
  })

  it('applications / versions（roadmap #23の⑤独自ドメイン相当）はこの段では実装していない', () => {
    expect(client).not.toContain("'/applications'")
    expect(client).not.toContain('/applications/')
  })
})

describe('PublishModal: AppRun は一覧で1行にまとめ、タブで共用型／専有型を切り替える（roadmap #24）', () => {
  it("Target 型の値は変わっていない（'sakura-apprun' / 'sakura-apprun-dedicated' とも既存のまま。互換性のため）", () => {
    expect(publishModal).toContain("type Target = 'sakura-rental' | 'sakura-apprun' | 'hanamii' | 'vercel' | 'sakura-vps' | 'sakura-apprun-dedicated'")
  })

  it('選択画面（公開先を選ぶ一覧）に「📦 さくらのAppRun」の行は1つだけ。専有型への別行・別ボタンは無い', () => {
    const start = publishModal.indexOf('// ── 公開先の選択（ローカルのみ／未設定のプロジェクト） ──')
    const end = publishModal.indexOf("target === 'sakura-rental' ? (")
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const block = publishModal.slice(start, end)
    const appRunButtons = [...block.matchAll(/onClick=\{\(\) => setTarget\('sakura-apprun(-dedicated)?'\)\}/g)]
    expect(appRunButtons.length).toBe(1)
    expect(appRunButtons[0][1]).toBeUndefined() // 'sakura-apprun-dedicated' への直行ボタンは無い（'sakura-apprun' のみ）
    expect(block).not.toContain('📦 さくらのAppRun 専有型')
    expect(block).toContain('📦 さくらのAppRun')
  })

  it('選んだ後、パネルの上にタブ「共用型」「専有型（上級者向け）」を出して切り替える', () => {
    const at = publishModal.indexOf("(target === 'sakura-apprun' || target === 'sakura-apprun-dedicated') ? (")
    expect(at).toBeGreaterThan(0)
    const block = publishModal.slice(at, at + 2300)
    expect(block).toContain('role="tablist"')
    expect(block).toContain('>共用型</button>')
    expect(block).toContain('>専有型（上級者向け）</button>')
    expect(block).toContain("onClick={() => setTarget('sakura-apprun')}")
    expect(block).toContain("onClick={() => setTarget('sakura-apprun-dedicated')}")
  })

  it('専有型タブには常時課金であることを出す', () => {
    const at = publishModal.indexOf("(target === 'sakura-apprun' || target === 'sakura-apprun-dedicated') ? (")
    const block = publishModal.slice(at, at + 2300)
    expect(block).toContain('月2万円〜の常時課金')
  })

  it('レビュー指摘5の直し: 専有型タブには「アプリの公開（独自ドメイン）はまだできません」も出す（旧UIのボタン名にあった「準備中」注記が、タブになって消えていたため）。金額の警告はそのまま残す', () => {
    const at = publishModal.indexOf("(target === 'sakura-apprun' || target === 'sakura-apprun-dedicated') ? (")
    const block = publishModal.slice(at, at + 2300)
    expect(block).toContain('月2万円〜の常時課金') // 金額の警告は変えていない
    expect(block).toContain('アプリの公開（独自ドメイン）はまだできません')
  })

  it('タブに応じて AppRunPanel / AppRunDedicatedPanel を切り替えて表示する', () => {
    expect(publishModal).toContain("import AppRunDedicatedPanel from './AppRunDedicatedPanel'")
    const at = publishModal.indexOf("(target === 'sakura-apprun' || target === 'sakura-apprun-dedicated') ? (")
    const block = publishModal.slice(at, at + 2300)
    expect(block).toContain("target === 'sakura-apprun' ? (")
    expect(block).toContain('<AppRunPanel projectDir={projectDir} apiKey={apiKey} onOpenCredentials={onOpenCredentials} />')
    expect(block).toContain('<AppRunDedicatedPanel projectDir={projectDir} onOpenCredentials={onOpenCredentials} />')
  })

  it('保存された meta.target が sakura-apprun-dedicated なら、専有型タブが開いた状態になる（初期化ロジックが target を直接使う）', () => {
    // 公開実績が無ければ、読み込んだ meta.target をそのまま target state に使う（既存ロジック・変更なし）。
    expect(publishModal).toContain("else if (m.target === 'sakura-rental' || m.target === 'sakura-apprun' || m.target === 'hanamii' || m.target === 'vercel' || m.target === 'sakura-vps' || m.target === 'sakura-apprun-dedicated') setTarget(m.target)")
    // タブの選択状態は target の値そのもので判定しており、別の状態変数を持たない
    // （＝ target が 'sakura-apprun-dedicated' になった時点で専有型タブが必ず選択状態になる）。
    expect(publishModal).toContain("aria-selected={target === 'sakura-apprun-dedicated'}")
  })

  it('PublishTargetKind（公開記録の種別）には足していない（クラスタは作れても「公開」はまだ無いため。sakura-vps と同じ扱い）', () => {
    expect(publishModal).toContain("type PublishTargetKind = 'hanamii' | 'sakura-apprun' | 'sakura-rental' | 'vercel'")
    expect(publishModal).not.toMatch(/type PublishTargetKind[^\n]*sakura-apprun-dedicated/)
  })

  it('レビュー指摘6の直し: 「さくら以外の公開先」の見出しの下に🖥さくらのVPS（さくら自身のサービス）が残っていた不整合を直す。見出しを中身に合わせ、VPSを「さくら以外」と呼ばない', () => {
    expect(publishModal).not.toContain('さくら以外の公開先')
    expect(publishModal).toContain('その他の公開先')
    // 見出しのすぐ後に HANAMII・Vercel・VPS の3つが続くこと（中身は変えていない）。
    const at = publishModal.indexOf('その他の公開先')
    const block = publishModal.slice(at, at + 1300)
    expect(block).toContain('🌸 HANAMII')
    expect(block).toContain('▲ Vercel')
    expect(block).toContain('🖥 さくらのVPS')
  })
})

describe('targetProfiles.ts: sakura-apprun-dedicated の定義', () => {
  it("TargetId に含まれ、autoPublish:false（IDEからの自動公開にはまだ対応していない）", () => {
    expect(targetProfiles).toContain("'sakura-apprun-dedicated'")
    const at = targetProfiles.indexOf("'sakura-apprun-dedicated': {")
    expect(at).toBeGreaterThan(0)
    const block = targetProfiles.slice(at, at + 900)
    expect(block).toContain('autoPublish: false')
    expect(block).toContain('serviceUrl:')
  })
})

describe('レビュー指摘8: COMING_SOON_TARGETS に sakura-apprun-dedicated を残す意図がコメントで明示されている', () => {
  it('「クラスタは作れるが公開まではできないので隠す」「公開先の一覧には出さずAppRunのタブからだけ到達する」ことがコメントに書いてある。方針（残す）自体は変えていない', () => {
    expect(targetProfiles).toContain("const COMING_SOON_TARGETS = new Set<TargetId>(['sakura-vps', 'sakura-cloud', 'sakura-apprun-dedicated'])")
    const at = targetProfiles.indexOf('sakura-apprun-dedicated は方針が違う')
    expect(at).toBeGreaterThan(0)
    const setAt = targetProfiles.indexOf("const COMING_SOON_TARGETS = new Set<TargetId>", at)
    expect(setAt).toBeGreaterThan(at)
    const block = targetProfiles.slice(at, setAt)
    expect(block).toContain('公開先の一覧には出さない')
    expect(block).toContain('タブからだけ')
  })
})

describe('AppRunDedicatedPanel: ①〜⑥の節がある', () => {
  it('① APIキー', () => { expect(panel).toContain('① APIキー') })
  it('② サービスプリンシパルの用意（最初の一度だけ手作業）', () => { expect(panel).toContain('② サービスプリンシパルの用意（最初の一度だけ手作業）') })
  it('③ 使えるプランと制限', () => { expect(panel).toContain('③ 使えるプランと制限') })
  it('④ 費用の確認と同意', () => { expect(panel).toContain('④ 費用の確認と同意') })
  it('⑤ クラスタを作る', () => { expect(panel).toContain('⑤ クラスタを作る') })
  it('⑥ 作ったものを壊す（破棄）', () => { expect(panel).toContain('⑥ 作ったものを壊す（破棄）') })

  it('②: これは Koto からは作れません、と正直に書いている', () => {
    expect(panel).toContain('これは Koto からは作れません')
  })

  it('②: 必要なロールをコピーできる形で明示している（既存 CopyButton を使用）', () => {
    expect(panel).toContain("const ROLE_TEXT = 'さくらのクラウド > 作成・削除'")
    expect(panel).toContain('<CopyButton text={ROLE_TEXT}')
  })

  it('②: コントロールパネルを開くリンクがある', () => {
    expect(panel).toContain("const CONTROL_PANEL_URL = 'https://secure.sakura.ad.jp/cloud/'")
    expect(panel).toContain('href={CONTROL_PANEL_URL}')
  })

  it('②: リソースIDの実在確認はできないと正直に書いている', () => {
    expect(panel).toContain('実在するかどうかはここでは確認できません')
  })

  it('④: 常時課金であることを最初に大きく書いている', () => {
    expect(panel).toContain('専有型は常時課金です')
  })

  it('④: 最小構成でも月2万円を超えると明示している', () => {
    expect(panel).toContain('2万円を超えます')
  })

  it('apprunDedicated への呼び出しは limits/plans/clusters/create/teardown/state の6つ', () => {
    const calls = [...panel.matchAll(/electronAPI\.apprunDedicated\.(\w+)/g)].map(m => m[1])
    expect(calls.length).toBeGreaterThan(0)
    expect(new Set(calls)).toEqual(new Set(['limits', 'plans', 'clusters', 'create', 'teardown', 'state']))
  })

  it('⑤: ネットワークは共有セグメント固定と明示し、スイッチ/IPプールの入力欄を出さない', () => {
    expect(panel).toContain('共有セグメントに繋ぎます')
    expect(panel).not.toMatch(/ipPool|netmaskLen|defaultGateway/i)
  })
})

describe('⑤: 同意（consentedAt）が無ければ作成ボタンを出さない', () => {
  it('!consentedAt の分岐では作成フォーム（doCreate ボタン）を描かず、④への案内文だけを出す', () => {
    const at = panel.indexOf("{/* ⑤ クラスタを作る */}")
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, at + 600)
    expect(block).toContain('!consentedAt ?')
    expect(block).toContain('④で費用に同意すると')
  })

  it('doCreate はフォーム側の formError を通ってからしか呼ばれない（disabled={!!formError || creating}）', () => {
    expect(panel).toContain('disabled={!!formError || creating}')
  })
})

describe('⑤: 押す前の確認ダイアログに月額（見積り）を出す（掟5）', () => {
  it('doCreate は window.confirm に price.text（見積り文）を渡してから作成する', () => {
    const at = panel.indexOf('const doCreate = async () => {')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, at + 400)
    expect(block).toContain('window.confirm(`${price.text}')
    expect(block).toContain('この費用が毎月かかります')
  })

  it('price は priceSummary（表に無いプランは月額を出せません、と正直に返す関数）から作る', () => {
    expect(panel).toContain('const price = priceSummary(selectedWorkerPlan, selectedLbPlan, minNodes)')
  })
})

describe('⑤: 単価表に無いプランのときは金額を捏造しない（priceSummary）', () => {
  it('ワーカ・LBとも既知のプランなら合計を返す', () => {
    const r = priceSummary({ path: 'cloud/apprun/dedicated/worker/1vcpu_2gb' }, { path: 'cloud/apprun/dedicated/lb/1vcpu_2gb_1', nodeCount: 1 }, 2)
    expect(r.totalYen).toBe(11000 * 2 + 11000 * 1)
    expect(r.text).toContain('月額')
    expect(r.text).not.toContain('出せません')
  })

  it('表に無いプラン（path が未知の形）なら合計は null で「月額を出せません」と正直に言う（推測で埋めない）', () => {
    const r = priceSummary({ path: 'cloud/apprun/dedicated/worker/16vcpu_64gb' }, { path: 'cloud/apprun/dedicated/lb/1vcpu_2gb_1', nodeCount: 1 }, 1)
    expect(r.totalYen).toBeNull()
    expect(r.text).toContain('月額を出せません')
  })

  it('path が無い（プラン未選択）なら合計は null', () => {
    const r = priceSummary(null, null, 1)
    expect(r.totalYen).toBeNull()
  })

  it('planKeyFromPath: worker/lb どちらの path 形式からも「Nコア/MGB」を作る', () => {
    expect(planKeyFromPath('cloud/apprun/dedicated/worker/1vcpu_2gb')).toBe('1コア/2GB')
    expect(planKeyFromPath('cloud/apprun/dedicated/lb/2vcpu_2gb_2')).toBe('2コア/2GB')
    expect(planKeyFromPath('cloud/apprun/dedicated/worker/16vcpu_64gb')).toBe('16コア/64GB')
    expect(planKeyFromPath(null)).toBeNull()
  })

  it('monthlyYenForPlanPath: 料金表にある4プランは値を返し、無いものは null', () => {
    expect(monthlyYenForPlanPath('cloud/apprun/dedicated/worker/1vcpu_2gb')).toBe(11000)
    expect(monthlyYenForPlanPath('cloud/apprun/dedicated/worker/2vcpu_2gb')).toBe(16940)
    expect(monthlyYenForPlanPath('cloud/apprun/dedicated/worker/4vcpu_4gb')).toBe(33000)
    expect(monthlyYenForPlanPath('cloud/apprun/dedicated/worker/8vcpu_8gb')).toBe(64020)
    expect(monthlyYenForPlanPath('cloud/apprun/dedicated/worker/16vcpu_64gb')).toBeNull()
  })
})

// 実物の値（roadmap #26・2026-09-07 実機確認。GET /service_classes/worker・/lb は高い順で返る）。
// テストの偽データは実物の値をそのまま使う（2026-09-07 の事故: 偽サーバが実物と違う形を
// 返していたためテストが素通りした。docs/apprun-dedicated-plan.md 5-8）。
const REAL_WORKER_PLANS_HIGH_TO_LOW = [
  { name: 'AppRun専有型 ワーカ 8vCPU / 8GBメモリ', nodeCount: null, path: 'cloud/apprun/dedicated/worker/8vcpu_8gb' },
  { name: 'AppRun専有型 ワーカ 4vCPU / 4GBメモリ', nodeCount: null, path: 'cloud/apprun/dedicated/worker/4vcpu_4gb' },
  { name: 'AppRun専有型 ワーカ 2vCPU / 2GBメモリ', nodeCount: null, path: 'cloud/apprun/dedicated/worker/2vcpu_2gb' },
  { name: 'AppRun専有型 ワーカ 1vCPU / 2GBメモリ', nodeCount: null, path: 'cloud/apprun/dedicated/worker/1vcpu_2gb' },
]
const REAL_LB_PLANS_HIGH_TO_LOW = [
  { name: 'AppRun専有型 ロードバランサ 2vCPU / 2GBメモリ（冗長構成）', nodeCount: 2, path: 'cloud/apprun/dedicated/lb/2vcpu_2gb_2' },
  { name: 'AppRun専有型 ロードバランサ 2vCPU / 2GBメモリ（非冗長構成）', nodeCount: 1, path: 'cloud/apprun/dedicated/lb/2vcpu_2gb_1' },
  { name: 'AppRun専有型 ロードバランサ 1vCPU / 2GBメモリ（冗長構成）', nodeCount: 2, path: 'cloud/apprun/dedicated/lb/1vcpu_2gb_2' },
  { name: 'AppRun専有型 ロードバランサ 1vCPU / 2GBメモリ（非冗長構成）', nodeCount: 1, path: 'cloud/apprun/dedicated/lb/1vcpu_2gb_1' },
]

// 配列の全順列を返す（n要素なら n! 通り。4要素なら24通り）。
// レビュー指摘2の直し: 以前ここにあった `shuffled()`（j = (i*2654435761) % (i+1) による
// 疑似シャッフル）は、4要素では常に j===i（自己交換のみ）になり、**何も並べ替えていなかった**
// （2026-09-07 実際に動かして確認: i=3→j=3, i=2→j=2, i=1→j=1）。同じ並びを5回試すだけの空の
// テストになっていた。#26 の事故の本質は「一覧の順序に依存した実装」であり、その再発を止める
// 唯一のテストが機能していなかった。Math.random() も使わない（再現性のため）——
// 4要素の**全24通り**を漏れなく総当たりする。
function permutations<T>(arr: readonly T[]): T[][] {
  if (arr.length <= 1) return [[...arr]]
  const result: T[][] = []
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)]
    for (const perm of permutations(rest)) result.push([arr[i], ...perm])
  }
  return result
}

describe('⑤: 既定で選ぶプランは「料金表で引ける中の最安」（roadmap #26・2026-09-07 実機で発覚した既定=最高額プランのバグの修理）', () => {
  it('pickCheapestWorkerPlan: 実物の4プラン（高い順そのまま）を渡すと、最安の 1vcpu_2gb が選ばれる（月11,000円。先頭＝8vcpu_8gb＝月64,020円を選ばない）', () => {
    const picked = pickCheapestWorkerPlan(REAL_WORKER_PLANS_HIGH_TO_LOW)
    expect(picked?.path).toBe('cloud/apprun/dedicated/worker/1vcpu_2gb')
    expect(monthlyYenForPlanPath(picked?.path)).toBe(11000)
  })

  it('pickCheapestLbPlan: 実物の4プランを渡すと、非冗長かつ最安の 1vcpu_2gb_1 が選ばれる（月11,000円）', () => {
    const picked = pickCheapestLbPlan(REAL_LB_PLANS_HIGH_TO_LOW)
    expect(picked?.path).toBe('cloud/apprun/dedicated/lb/1vcpu_2gb_1')
    expect(picked?.nodeCount).toBe(1)
    expect(monthlyYenForPlanPath(picked?.path)).toBe(11000)
  })

  it('並び順を変えても結果は同じ（4要素・全24通りの順列すべてで固定する。#26は「一覧の順序に依存した実装」が事故の本質だったため、抜け漏れのない総当たりにする）', () => {
    const workerPerms = permutations(REAL_WORKER_PLANS_HIGH_TO_LOW)
    expect(workerPerms.length).toBe(24)
    for (const perm of workerPerms) {
      expect(pickCheapestWorkerPlan(perm)?.path).toBe('cloud/apprun/dedicated/worker/1vcpu_2gb')
    }

    const lbPerms = permutations(REAL_LB_PLANS_HIGH_TO_LOW)
    expect(lbPerms.length).toBe(24)
    for (const perm of lbPerms) {
      expect(pickCheapestLbPlan(perm)?.path).toBe('cloud/apprun/dedicated/lb/1vcpu_2gb_1')
    }
  })

  // 親（Opus）の変異試験で見つかった穴（2026-09-07）: `pickCheapestLbPlan` から
  // 「非冗長（nodeCount===1）を優先する」を外しても、**どのテストも落ちなかった**。
  // 実物の8プランでは、総額で比べれば非冗長のほうが必ず安くなるため、優先の有無で答えが変わらない。
  // つまり「まず非冗長を勧める」という**方針そのものが試験されていなかった**（黙って消えうる）。
  //
  // ⚠️ このとき、**その入力で差が出るのか**を先に確かめること（playbook: ミューテーションで
  // 落ちなかったら、テストの書き方より先に「その入力で差が出るのか」を疑う）。
  // 総額では冗長のほうが安く、かつ非冗長も存在する入力でなければ、方針は試験できない。
  it('pickCheapestLbPlan: 総額では冗長のほうが安くても、非冗長を優先する（方針を固定する）', () => {
    const plans = [
      // 冗長: 1コア/2GB（11,000円）× 2ノード = 総額 22,000円 ← 総額ではこちらが安い
      { name: 'LB 1vCPU/2GB（冗長構成）', nodeCount: 2, path: 'cloud/apprun/dedicated/lb/1vcpu_2gb_2' },
      // 非冗長: 4コア/4GB（33,000円）× 1ノード = 総額 33,000円
      { name: 'LB 4vCPU/4GB（非冗長構成）', nodeCount: 1, path: 'cloud/apprun/dedicated/lb/4vcpu_4gb_1' },
    ]
    // 総額だけで選ぶと冗長（22,000円）が勝つ。**それでも非冗長を選ぶ**のが方針。
    expect(pickCheapestLbPlan(plans)?.path).toBe('cloud/apprun/dedicated/lb/4vcpu_4gb_1')
    expect(pickCheapestLbPlan(plans)?.nodeCount).toBe(1)
  })

  it('pickCheapestLbPlan: 非冗長が1つも無ければ、冗長からの最安（総額）にフォールバックする', () => {
    const onlyRedundant = [
      { name: 'LB 2vCPU/2GB（冗長構成）', nodeCount: 2, path: 'cloud/apprun/dedicated/lb/2vcpu_2gb_2' },
      { name: 'LB 1vCPU/2GB（冗長構成）', nodeCount: 2, path: 'cloud/apprun/dedicated/lb/1vcpu_2gb_2' },
    ]
    expect(pickCheapestLbPlan(onlyRedundant)?.path).toBe('cloud/apprun/dedicated/lb/1vcpu_2gb_2')
  })

  it('料金表に無い path しか無ければ null（既定を選ばない。分からない額を既定にしない）', () => {
    const unknown = [{ name: '謎の巨大プラン', nodeCount: null, path: 'cloud/apprun/dedicated/worker/16vcpu_64gb' }]
    expect(pickCheapestWorkerPlan(unknown)).toBeNull()
    const unknownLb = [{ name: '謎のLB', nodeCount: 1, path: 'cloud/apprun/dedicated/lb/16vcpu_64gb_1' }]
    expect(pickCheapestLbPlan(unknownLb)).toBeNull()
  })

  it('プランが1つも無い（空配列・null・undefined）なら null', () => {
    expect(pickCheapestWorkerPlan([])).toBeNull()
    expect(pickCheapestWorkerPlan(null)).toBeNull()
    expect(pickCheapestWorkerPlan(undefined)).toBeNull()
    expect(pickCheapestLbPlan([])).toBeNull()
  })

  it('LB: 非冗長（nodeCount===1）が1つも無ければ、全体（冗長を含む）からの最安にフォールバックする', () => {
    const onlyRedundant = [
      { name: '2コア（冗長）', nodeCount: 2, path: 'cloud/apprun/dedicated/lb/2vcpu_2gb_2' },
      { name: '1コア（冗長）', nodeCount: 2, path: 'cloud/apprun/dedicated/lb/1vcpu_2gb_2' },
    ]
    const picked = pickCheapestLbPlan(onlyRedundant)
    expect(picked?.path).toBe('cloud/apprun/dedicated/lb/1vcpu_2gb_2') // 冗長の中でも最安（1コア/2GB=11,000円 < 2コア/2GB=16,940円）
  })

  it('LB: 額を引けない非冗長プランより、額を引ける冗長プランを優先する（額を引けないものは非冗長でも候補にしない）', () => {
    const mixed = [
      { name: '謎の非冗長', nodeCount: 1, path: 'cloud/apprun/dedicated/lb/16vcpu_64gb_1' }, // 料金表に無い
      { name: '1コア（冗長）', nodeCount: 2, path: 'cloud/apprun/dedicated/lb/1vcpu_2gb_2' }, // 料金表にある
    ]
    const picked = pickCheapestLbPlan(mixed)
    expect(picked?.path).toBe('cloud/apprun/dedicated/lb/1vcpu_2gb_2')
  })

  it('LB: 非冗長が料金表に無いフォールバックでは、単価ではなく総額（単価×nodeCount）で最安を選ぶ（レビュー指摘3の直し）', () => {
    // monthlyYenForPlanPath は path 末尾の _1/_2（ノード数）を無視して1ノードあたりの単価を返すため、
    // 単価だけで比べると「実際に払う額」の比較にならない。nodeCount が違うプラン同士が混ざる
    // フォールバックで、単価が安い方≠総額が安い方、となるケースを作って固定する。
    const pool = [
      // 2コア/2GB・2ノード: 単価16,940円 × 2ノード = 総額33,880円
      { name: '2コア/2GB（2ノード）', nodeCount: 2, path: 'cloud/apprun/dedicated/lb/2vcpu_2gb_2' },
      // 1コア/2GB・4ノード（テスト用の合成データ。実物のLBにこの構成は無い）:
      // 単価11,000円 × 4ノード = 総額44,000円。単価だけ見ると最安に見えるが、総額は上より高い。
      { name: '1コア/2GB（4ノード・テスト用）', nodeCount: 4, path: 'cloud/apprun/dedicated/lb/1vcpu_2gb_2' },
    ]
    const picked = pickCheapestLbPlan(pool)
    // 単価比較（旧実装）なら「1コア/2GB（4ノード）」（11,000 < 16,940）が選ばれてしまうが、
    // 総額比較（直した実装）では「2コア/2GB（2ノード）」の方が安い（33,880円 < 44,000円）。
    expect(picked?.path).toBe('cloud/apprun/dedicated/lb/2vcpu_2gb_2')
    expect(picked?.nodeCount).toBe(2)
  })

  it('ワーカ側の useEffect は pickCheapestWorkerPlan を呼ぶだけ（一度選んだら上書きしないガードは維持）', () => {
    const at = panel.indexOf('useEffect(() => {\n    if (selectedWorkerPath) return')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, at + 300)
    expect(block).toContain('const cheapest = pickCheapestWorkerPlan(workerPlans)')
    expect(block).toContain('if (cheapest) setSelectedWorkerPath(cheapest.path)')
    // 「一覧の先頭」を既定にする旧実装（#26のバグそのもの）が残っていないこと。
    expect(panel).not.toContain('(workerPlans ?? []).find(p => p.path)')
  })

  it('LB側の useEffect も pickCheapestLbPlan を呼ぶだけ', () => {
    const at = panel.indexOf('useEffect(() => {\n    if (selectedLbPath) return')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, at + 300)
    expect(block).toContain('const cheapest = pickCheapestLbPlan(lbPlans)')
    expect(block).toContain('if (cheapest) setSelectedLbPath(cheapest.path)')
  })

  it('⑤: 既定が選べなかったとき（プラン取得済みだが selectedWorkerPath/selectedLbPath が null）は、選ばせる注記を出す', () => {
    expect(panel).toContain('⚠️ プランを選んでください（既定は選んでいません')
  })
})

describe('#27: ロードバランサのプラン名に「（冗長構成）（冗長）」のような二重の注記を付けない', () => {
  it('③の一覧では API の name をそのまま出し、nodeCount 由来の（冗長）（非冗長）を付け足さない', () => {
    const at = panel.indexOf('<p className="text-[11px] font-semibold text-ink-secondary">ロードバランサプラン</p>')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, at + 500)
    // 表示行そのもの（<li>）が name だけで終わっており、nodeCount 由来の付け足しが無いこと。
    // （このセクションの説明コメント自体に「（冗長）」という語が出るため、コメントは対象から除く）
    const liLine = block.split('\n').find(l => l.includes('<li key={i}>・{p.name'))
    expect(liLine).toBe("                  <li key={i}>・{p.name ?? '（名前を取得できませんでした）'}</li>")
    expect(block).not.toContain('p.nodeCount === 1 &&')
    expect(block).not.toContain('p.nodeCount === 2 &&')
  })

  it('⑤のプラン選択（select）でも同様に name をそのまま出す', () => {
    const at = panel.indexOf('<label className="text-[11px] font-medium text-ink-secondary">ロードバランサプラン</label>')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, at + 900)
    expect(block).not.toContain("nodeCount === 1 ? '（非冗長）'")
    expect(block).not.toContain("nodeCount === 2 ? '（冗長）'")
    expect(block).toContain('<option key={p.path as string} value={p.path as string}>{p.name ?? p.path}</option>')
  })
})

describe('事故の直し1: ①APIキーの見出し・説明文・接続テスト（共用型 AppRunPanel と同じ形に揃える）', () => {
  it('見出しが「① APIキー」（旧「① 認証情報」ではない）', () => {
    expect(panel).toContain('① APIキー')
    expect(panel).not.toContain('① 認証情報')
  })

  it('説明文が共用型と同じ趣旨（「認証情報」で登録・切替／専有型に専用のAPIキーはない）', () => {
    expect(panel).toContain('さくらのクラウドのAPIキー（アクセストークン／トークンシークレット）は「認証情報」で登録・切替します。')
    expect(panel).toContain('AppRun 専有型に専用のAPIキーはなく、このキーで操作します。')
  })

  it('この操作に使うキー（旧「この確認に使うキー」ではない）', () => {
    expect(panel).toContain('この操作に使うキー')
    expect(panel).not.toContain('この確認に使うキー')
  })

  it('🔌 接続テストのボタンがあり、apprunDedicated.limits を呼ぶ（GETのみ・何も作らない）', () => {
    const at = panel.indexOf('const testConnection = async () => {')
    expect(at).toBeGreaterThan(0)
    const end = panel.indexOf('\n  }', at)
    expect(end).toBeGreaterThan(at)
    const block = panel.slice(at, end)
    expect(block).toContain('window.electronAPI.apprunDedicated.limits(auth)')
    expect(panel).toContain('>🔌 接続テスト</button>')
    // ボタンは「🔑 認証情報で登録・切替」の隣（同じ行の flex コンテナ内）にある。
    const rowAt = panel.indexOf('>🔑 認証情報で登録・切替</button>')
    const rowEnd = panel.indexOf('</div>', rowAt)
    expect(rowAt).toBeGreaterThan(0)
    const row = panel.slice(rowAt, rowEnd)
    expect(row).toContain('onClick={testConnection}')
  })

  it('接続テストの状態は未実施(idle) / 確認中(testing) / OK(ok) / NG(ng) の4つ（共用型 AppRunPanel の conn/connMsg と同じ作法）', () => {
    expect(panel).toContain("useState<'idle' | 'testing' | 'ok' | 'ng'>('idle')")
  })

  it('OK なら「✅ このキーで専有型APIに通じました」、NG なら生の応答（connMsg）を ErrorBlock でそのまま出す（掟10: select-text＋コピー）', () => {
    const at = panel.indexOf('const testConnection = async () => {')
    const end = panel.indexOf('\n  }', at)
    const block = panel.slice(at, end)
    expect(block).toContain("setConn('ok')")
    expect(block).toContain("setConn('ng'); setConnMsg(r.message)")
  })

  it('旧文言「疎通の確認は、下の「③ 調べる」で行います。」はもう無い（①で確かめられるようになったため）', () => {
    expect(panel).not.toContain('疎通の確認は、下の「③ 調べる」で行います。')
  })

  it('キーを切り替えたら結果を消す: selectKey / sakura:credentials-changed の両方で conn・connMsg をリセットする', () => {
    const selAt = panel.indexOf('const selectKey = async (id: string) => {')
    const selEnd = panel.indexOf('// 🔌 接続テスト', selAt)
    expect(selAt).toBeGreaterThan(0)
    expect(selEnd).toBeGreaterThan(selAt)
    const selBlock = panel.slice(selAt, selEnd)
    expect(selBlock).toContain("setConn('idle'); setConnMsg('')")

    const hAt = panel.indexOf("const h = () => { refreshKey(); refreshCloudKeys(); setConn('idle')")
    expect(hAt).toBeGreaterThan(0)
    expect(panel.slice(hAt, hAt + 200)).toContain("setConn('idle'); setConnMsg('')")
  })
})

describe('事故の直し1: apiReachable を廃止し、conn/connMsg の1組に統一している（同じ意味の状態を2つ持たない）', () => {
  it('apiReachable という状態はもう存在しない', () => {
    expect(panel).not.toContain('apiReachable')
    expect(panel).not.toContain('setApiReachable')
  })

  it('①の疎通表示は conn だけを見る。conn===idle のときに apiReachable へフォールバックする分岐はもう無い', () => {
    expect(panel).not.toContain("conn === 'idle' && apiReachable")
  })

  it('NGのとき、平易な判定文（⚠️ このキーでは専有型APIに通じませんでした）と ErrorBlock の両方を出す（三項ではない）', () => {
    const at = panel.indexOf("{/* ① APIキー")
    const end = panel.indexOf("{/* ② サービスプリンシパル", at)
    expect(at).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(at)
    const block = panel.slice(at, end)
    // 三項（connMsg ? ErrorBlock : 平易な文）ではなく、conn === 'ng' のとき両方を描く形になっていること。
    expect(block).not.toMatch(/connMsg\s*\?\s*<ErrorBlock/)
    const ngAt = block.indexOf("conn === 'ng' && (")
    expect(ngAt).toBeGreaterThan(0)
    const ngBlock = block.slice(ngAt, ngAt + 400)
    expect(ngBlock).toContain('⚠️ このキーでは専有型APIに通じませんでした。')
    expect(ngBlock).toContain('<ErrorBlock msg={connMsg} />')
  })

  it('ボタン横の span に、conn===ok で「✅ 通じました」、conn===ng で「⚠️ 通じませんでした」を出す（共用型 AppRunPanel と同じ作法）', () => {
    const rowAt = panel.indexOf('>🔌 接続テスト</button>')
    expect(rowAt).toBeGreaterThan(0)
    const spanEnd = panel.indexOf('</span>\n        </div>', rowAt)
    expect(spanEnd).toBeGreaterThan(rowAt)
    const block = panel.slice(rowAt, spanEnd)
    expect(block).toContain("conn === 'ok' && <span className=\"text-brand-green font-semibold\">✅ 通じました</span>")
    expect(block).toContain("conn === 'ng' && <span className=\"text-brand-yellow font-semibold\">⚠️ 通じませんでした</span>")
  })

  it('未登録（!keyReady）のときの案内文がある（共用型 AppRunPanel 849-853 行あたりと同じ）', () => {
    const rowAt = panel.indexOf('>🔌 接続テスト</button>')
    expect(rowAt).toBeGreaterThan(0)
    const block = panel.slice(rowAt, rowAt + 700)
    expect(block).toContain('{!keyReady && (')
    expect(block).toContain('先に認証情報でAPIキーを登録してください。')
  })
})

describe('②: 手順A/Bの2段階（公式マニュアルどおり）と、プリンシパル欄の取り違え防止', () => {
  it('見出しが「② サービスプリンシパルの用意（最初の一度だけ手作業）」', () => {
    expect(panel).toContain('② サービスプリンシパルの用意（最初の一度だけ手作業）')
  })

  it('Koto からは作れない理由（IAM APIは通常のAPIキーでは使えない設計）を書いている', () => {
    expect(panel).toContain('これは Koto からは作れません')
    expect(panel).toContain('作成に使う IAM API は、通常のAPIキーでは使えない設計のためです（実測で権限エラー）。')
  })

  it('手順A（サービスプリンシパルを作る）・手順B（ロールを付ける）の見出しがある', () => {
    expect(panel).toContain('手順A: サービスプリンシパルを作る')
    expect(panel).toContain('手順B: そのサービスプリンシパルにロールを付ける')
  })

  it('手順Aは「サービスプリンシパル」メニューを開き、リソースIDを控える手順', () => {
    const at = panel.indexOf('手順A: サービスプリンシパルを作る')
    const end = panel.indexOf('手順B: そのサービスプリンシパルにロールを付ける', at)
    expect(at).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(at)
    const block = panel.slice(at, end)
    expect(block).toContain('左メニュー「サービスプリンシパル」を開く')
    expect(block).toContain('リソースID')
  })

  it('手順Bは「IAMポリシー」で、プリンシパル欄にサービスプリンシパルを・ロール欄にロールを選ぶ手順', () => {
    const at = panel.indexOf('手順B: そのサービスプリンシパルにロールを付ける')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, at + 700)
    expect(block).toContain('IAMポリシー')
    expect(block).toContain('「プリンシパル」欄で、手順Aで作ったサービスプリンシパルを選ぶ')
    expect(block).toContain('「ロール」欄で「{ROLE_TEXT}」を選ぶ')
  })

  it('事故の直し3: 実画面の4欄（リソース階層名／リソース階層タイプ／プリンシパル／ロール）すべてを名指ししている（前2欄が「対象のプロジェクトを選ぶ」だけになっていた取り違えの穴を塞ぐ）', () => {
    const at = panel.indexOf('手順B: そのサービスプリンシパルにロールを付ける')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, at + 700)
    expect(block).toContain('「リソース階層名」に、対象のプロジェクトが入っていることを確かめる')
    expect(block).toContain('「リソース階層タイプ」が「プロジェクト」になっていることを確かめる')
    expect(block).toContain('「プリンシパル」欄で、手順Aで作ったサービスプリンシパルを選ぶ')
    expect(block).toContain('「ロール」欄で「{ROLE_TEXT}」を選ぶ')
    // 旧文言「対象のプロジェクトを選ぶ」だけで済ませていた形（前2欄が名指しされていない）はもう無い。
    expect(panel).not.toContain('→ 対象のプロジェクトを選ぶ')
  })

  it('プリンシパル欄にロール名を入れないでください、という注意書きがある', () => {
    expect(panel).toContain('プリンシパル欄に「ロール名」を入れないでください。')
    expect(panel).toContain('プリンシパル欄で選ぶのは、手順Aで作った')
    expect(panel).toContain('サービスプリンシパル')
    expect(panel).toContain('ロールの名前')
    expect(panel).toContain('ロール欄</b>で選びます。')
  })

  it('コピーボタンのラベルは「ロール欄で選ぶもの」（旧「付与するロール」ではない）', () => {
    expect(panel).toContain('ロール欄で選ぶもの')
    expect(panel).not.toContain('付与するロール')
  })

  it('コピーボタンの title は、プリンシパル欄ではなくロール欄で使う旨を明示している', () => {
    expect(panel).toContain('title="ロール名をコピー（プリンシパル欄ではなくロール欄で使います）"')
  })

  it('ROLE_TEXT の定義は1箇所のまま（複製していない）', () => {
    const defs = [...panel.matchAll(/const ROLE_TEXT = /g)]
    expect(defs.length).toBe(1)
  })
})

describe('#25/事故の直し1: ①APIキーに、③「調べる」の疎通結果を出す（conn/connMsg に一本化）', () => {
  it('investigate() は limits/worker/lb/clusters のいずれか1つでも成功すれば setConn(\'ok\') する', () => {
    const at = panel.indexOf('const investigate = async () => {')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, panel.indexOf('const doCreate = async', at))
    expect(block).toContain("if (limitsRes.ok || plansRes.worker.ok || plansRes.lb.ok || clustersRes.ok) {")
    expect(block).toContain("setConn('ok'); setConnMsg('')")
  })

  it('investigate() は setConn を呼ぶ（③の結果が①に反映される）。全滅なら setConn(\'ng\') とし、代表的な失敗の生の応答を connMsg に入れる', () => {
    const at = panel.indexOf('const investigate = async () => {')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, panel.indexOf('const doCreate = async', at))
    expect(block).toContain("setConn('ng'); setConnMsg(rep)")
    // 想定外の例外（catchブロック）でも setConn を呼ぶ（成功の余韻を残さない）。
    const catchAt = block.indexOf('} catch (e: any) {')
    expect(catchAt).toBeGreaterThan(0)
    const catchBlock = block.slice(catchAt, block.indexOf('} finally {', catchAt))
    expect(catchBlock).toContain("setConn('ng')")
  })

  it('レビュー指摘4の直し: 未登録（authが無い）の早期returnでは setConn を呼ばない（conn は idle のまま）。何も試していないので「通じなかった」と偽らない（①の「⚠️ APIキーが未登録です」と役割が重複・混同しないように）', () => {
    const at = panel.indexOf('const investigate = async () => {')
    expect(at).toBeGreaterThan(0)
    const guardAt = panel.indexOf('if (!auth || !auth.token || !auth.secret) {', at)
    const afterGuard = panel.indexOf('setLimits(null); setLimitsError(null)', guardAt)
    expect(guardAt).toBeGreaterThan(at)
    expect(afterGuard).toBeGreaterThan(guardAt)
    const block = panel.slice(guardAt, afterGuard)
    expect(block).toContain("setCheckError('さくらのクラウドAPIキーが未登録です。①で登録してください。')")
    // 直す前は setApiReachable(false) がここにあった。この早期return分岐からは setConn 呼び出しも
    // 消えていること（'ng' はもちろん、いかなる setConn(...) も呼ばない）。
    expect(block).not.toContain('setConn(')
  })

  it('①に成功時「✅ このキーで専有型APIに通じました」、失敗時「⚠️ このキーでは専有型APIに通じませんでした」を出す', () => {
    const at = panel.indexOf('{/* ① APIキー')
    const end = panel.indexOf('{/* ② サービスプリンシパル', at)
    expect(at).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(at)
    const block = panel.slice(at, end)
    expect(block).toContain('✅ このキーで専有型APIに通じました')
    expect(block).toContain('⚠️ このキーでは専有型APIに通じませんでした。')
  })
})

describe('#1/#7: キーを切り替えたら、古い疎通結果（conn/connMsg）を残さない', () => {
  // レビュー指摘7で認めた限界: ここは「ソースの文字列を grep する」形のテストであり、
  // 1のような穴（listenerが状態の一部だけ更新して、別の状態を更新し忘れる）を
  // 構造的に防げるわけではない——同じ形の直し忘れを別の箇所でまたやれば、この2本は素通りする。
  // せめて「1の再発（この2箇所からの conn/connMsg リセットの消失）」だけは検知できるようにする。
  it("①のセレクトで別のキーを選んだとき（selectKey）、setConn('idle'); setConnMsg('') する", () => {
    const at = panel.indexOf('const selectKey = async (id: string) => {')
    expect(at).toBeGreaterThan(0)
    const end = panel.indexOf('// ── ② サービスプリンシパル', at)
    expect(end).toBeGreaterThan(at)
    const block = panel.slice(at, end)
    expect(block).toContain("setConn('idle'); setConnMsg('')")
  })

  it("'sakura:credentials-changed'（①「🔑 認証情報で登録・切替」からの切替）の listener が conn/connMsg をリセットする。これが無いと、切り替え後も直前のキーで得た「✅ 通じました」が真下に残る", () => {
    const at = panel.indexOf("window.addEventListener('sakura:credentials-changed', h)")
    expect(at).toBeGreaterThan(0)
    const hAt = panel.lastIndexOf('const h = () => {', at)
    expect(hAt).toBeGreaterThan(0)
    const hEnd = panel.indexOf('}', hAt)
    expect(hEnd).toBeGreaterThan(hAt)
    const block = panel.slice(hAt, hEnd + 1)
    expect(block).toContain('refreshKey()')
    expect(block).toContain('refreshCloudKeys()')
    expect(block).toContain("setConn('idle'); setConnMsg('')")
  })
})

describe('#28: 説明文が現状（クラスタの作成・破棄はできる。公開＝独自ドメインはまだ）に合っている', () => {
  it('AppRunDedicatedPanel: 「作成は行わず」のような、作成できないと読める文言が残っていない', () => {
    expect(panel).not.toContain('作成は行わず')
    expect(panel).not.toContain('作成はまだできません')
    expect(panel).toContain('クラスタの作成・破棄までは行えます')
  })

  it('PublishModal: 専有型の説明に「作成はまだできません」が残っていない', () => {
    expect(publishModal).not.toContain('作成はまだできません')
    expect(publishModal).not.toContain('下調べのみ')
  })
})

describe('⑤: 入力チェックの純関数', () => {
  it('isValidResourceName: 1〜20文字の英数字・_・- のみ', () => {
    expect(isValidResourceName('myapp')).toBe(true)
    expect(isValidResourceName('my-app_1')).toBe(true)
    expect(isValidResourceName('')).toBe(false)
    expect(isValidResourceName('a'.repeat(21))).toBe(false)
    expect(isValidResourceName('my app')).toBe(false)
    expect(isValidResourceName('日本語')).toBe(false)
  })

  it('isReservedPort: 5950-5959 のみ予約', () => {
    expect(isReservedPort(5950)).toBe(true)
    expect(isReservedPort(5959)).toBe(true)
    expect(isReservedPort(80)).toBe(false)
    expect(isReservedPort(443)).toBe(false)
  })
})

describe('⑥: 記録があるときだけ表示し、破棄は確認ダイアログを通る', () => {
  it('hasAnyResource（clusterID/asgID/loadBalancerIDのいずれか）が無ければ⑥のsectionを描かない', () => {
    expect(panel).toContain('{hasAnyResource && (')
    expect(panel).toContain('const hasAnyResource = !!(apprunState?.clusterID || apprunState?.asgID || apprunState?.loadBalancerID)')
  })

  it('doTeardown は window.confirm を通ってから apprunDedicated.teardown を呼ぶ', () => {
    const at = panel.indexOf('const doTeardown = async () => {')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, at + 1000)
    const confirmAt = block.indexOf('window.confirm(')
    const callAt = block.indexOf('window.electronAPI.apprunDedicated.teardown(')
    expect(confirmAt).toBeGreaterThan(0)
    expect(callAt).toBeGreaterThan(confirmAt)
    expect(block).toContain('消さない限り課金が続きます')
  })

  it('失敗が残ったら、残った資源のIDとコントロールパネルへの導線を出す', () => {
    expect(panel).toContain('残っています＝課金が続きます')
    expect(panel).toContain('teardownResult.remaining.loadBalancerID')
    expect(panel).toContain('teardownResult.remaining.asgID')
    expect(panel).toContain('teardownResult.remaining.clusterID')
  })
})

describe('同意（consentedAt）を記録する形になっている（2026-08-14の教訓: 同意した事実を記録してから）', () => {
  it('チェックボックス＋「同意して次へ進む」ボタンがある', () => {
    expect(panel).toContain('費用が発生することを理解しました')
    expect(panel).toContain('同意して次へ進む')
  })

  it('giveConsent が consentedAt（ISO文字列）を saveMeta で記録している', () => {
    const at = panel.indexOf('const giveConsent = async () => {')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, at + 400)
    expect(block).toContain('const iso = new Date().toISOString()')
    expect(block).toContain('await saveMeta({ consentedAt: iso })')
  })

  it('saveMeta は shared/publishMeta.ts の withApprunDedicatedRecord を通して publish.apprunDedicated へ書く（掟10: 一元化。main側 apprunDedicatedApply.ts と同じ関数を使う）', () => {
    expect(panel).toContain("const metaPath = `${projectDir}/.sakuraide.json`")
    expect(panel).toContain("import { withApprunDedicatedRecord } from '../../shared/publishMeta'")
    expect(panel).toContain('const merged = withApprunDedicatedRecord(m, patch)')
    // 同じ形のマージをここで再度手書きしていない（旧・段階①の書き方が残っていないこと）。
    expect(panel).not.toContain('apprunDedicated: { ...(m.publish?.apprunDedicated ?? {}), ...patch }')
  })

  it('同意済みなら日時を表示し、取り消せる', () => {
    expect(panel).toContain('✅ 同意済み（')
    expect(panel).toContain('同意を取り消す')
    expect(panel).toContain('const revokeConsent = async () => {')
  })
})

describe('apprunDedicatedApply.ts: 作る順・壊す順がコード上で明示されている（掟10「作る順番は機能の一部」）', () => {
  it('createClusterFlow は クラスタ→ASG→LB の順で呼ぶ', () => {
    const at = applyFile.indexOf('export async function createClusterFlow')
    expect(at).toBeGreaterThan(0)
    const clusterAt = applyFile.indexOf('createCluster(auth,', at)
    const asgAt = applyFile.indexOf('createAsg(auth,', at)
    const lbAt = applyFile.indexOf('createLoadBalancer(auth,', at)
    expect(clusterAt).toBeGreaterThan(at)
    expect(asgAt).toBeGreaterThan(clusterAt)
    expect(lbAt).toBeGreaterThan(asgAt)
  })

  it('teardownFlow は LB→ASG→クラスタ の順で呼ぶ（5-7の逆順）', () => {
    const at = applyFile.indexOf('export async function teardownFlow')
    expect(at).toBeGreaterThan(0)
    const lbAt = applyFile.indexOf('deleteLoadBalancer(auth,', at)
    const asgAt = applyFile.indexOf('deleteAsg(auth,', at)
    const clusterAt = applyFile.indexOf('deleteCluster(auth,', at)
    expect(lbAt).toBeGreaterThan(at)
    expect(asgAt).toBeGreaterThan(lbAt)
    expect(clusterAt).toBeGreaterThan(asgAt)
  })
})
