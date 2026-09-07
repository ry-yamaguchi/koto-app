import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { priceSummary, planKeyFromPath, monthlyYenForPlanPath, isValidResourceName, isReservedPort } from '../src/renderer/components/AppRunDedicatedPanel'

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

describe('PublishModal: 公開先の選択肢に「さくらのAppRun 専有型」がある', () => {
  it("Target 型に 'sakura-apprun-dedicated' がある", () => {
    expect(publishModal).toContain("type Target = 'sakura-rental' | 'sakura-apprun' | 'hanamii' | 'vercel' | 'sakura-vps' | 'sakura-apprun-dedicated'")
  })

  it('選択ボタンがある（ラベルと「上級者向け・準備中」の注記）', () => {
    expect(publishModal).toContain("onClick={() => setTarget('sakura-apprun-dedicated')}")
    expect(publishModal).toContain('📦 さくらのAppRun 専有型')
    expect(publishModal).toContain('上級者向け・準備中')
  })

  it('選ぶと AppRunDedicatedPanel を表示する', () => {
    expect(publishModal).toContain("import AppRunDedicatedPanel from './AppRunDedicatedPanel'")
    expect(publishModal).toContain("target === 'sakura-apprun-dedicated' ? (")
    const at = publishModal.indexOf("target === 'sakura-apprun-dedicated' ? (")
    expect(publishModal.slice(at, at + 500)).toContain('<AppRunDedicatedPanel projectDir={projectDir} onOpenCredentials={onOpenCredentials} />')
  })

  it('PublishTargetKind（公開記録の種別）には足していない（クラスタは作れても「公開」はまだ無いため。sakura-vps と同じ扱い）', () => {
    expect(publishModal).toContain("type PublishTargetKind = 'hanamii' | 'sakura-apprun' | 'sakura-rental' | 'vercel'")
    expect(publishModal).not.toMatch(/type PublishTargetKind[^\n]*sakura-apprun-dedicated/)
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

describe('AppRunDedicatedPanel: ①〜⑥の節がある', () => {
  it('① 認証情報', () => { expect(panel).toContain('① 認証情報') })
  it('② サービスプリンシパルの用意（手作業が必要）', () => { expect(panel).toContain('② サービスプリンシパルの用意（手作業が必要）') })
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
