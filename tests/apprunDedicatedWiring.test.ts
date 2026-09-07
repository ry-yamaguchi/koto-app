import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// roadmap #23 段階①「下調べ画面」の配線を固定する（掟6: IPC 3点セット・掟10: 一元化した
// 守りはテストで固定する）。実装をわざと壊すと落ちることを、変異試験で別途確かめてある
// （報告のみ・このファイルは元の形を固定する）。

const ipc = readFileSync(join(__dirname, '..', 'src/main/ipc/apprunDedicated.ts'), 'utf-8')
const index = readFileSync(join(__dirname, '..', 'src/main/ipc/index.ts'), 'utf-8')
const preload = readFileSync(join(__dirname, '..', 'src/main/preload.ts'), 'utf-8')
const globalDts = readFileSync(join(__dirname, '..', 'src/renderer/global.d.ts'), 'utf-8')
const client = readFileSync(join(__dirname, '..', 'src/main/cloud/apprunDedicated.ts'), 'utf-8')
const panel = readFileSync(join(__dirname, '..', 'src/renderer/components/AppRunDedicatedPanel.tsx'), 'utf-8')
const publishModal = readFileSync(join(__dirname, '..', 'src/renderer/components/PublishModal.tsx'), 'utf-8')
const targetProfiles = readFileSync(join(__dirname, '..', 'src/renderer/targetProfiles.ts'), 'utf-8')

describe('IPC 3点セット（掟6）: main / preload / global.d.ts が揃っている', () => {
  it('main: apprunDedicated:limits / plans / clusters の3つを登録している', () => {
    expect(ipc).toContain("ipcMain.handle('apprunDedicated:limits'")
    expect(ipc).toContain("ipcMain.handle('apprunDedicated:plans'")
    expect(ipc).toContain("ipcMain.handle('apprunDedicated:clusters'")
  })

  it('main: registerApprunDedicatedHandlers が index.ts から呼ばれている', () => {
    expect(index).toContain("import { registerApprunDedicatedHandlers } from './apprunDedicated'")
    expect(index).toContain('registerApprunDedicatedHandlers(deps)')
  })

  it('preload: electronAPI.apprunDedicated.{limits,plans,clusters} を公開している', () => {
    expect(preload).toContain("limits: (auth: { token: string; secret: string }) => ipcRenderer.invoke('apprunDedicated:limits', auth)")
    expect(preload).toContain("plans: (auth: { token: string; secret: string }) => ipcRenderer.invoke('apprunDedicated:plans', auth)")
    expect(preload).toContain("clusters: (auth: { token: string; secret: string }) => ipcRenderer.invoke('apprunDedicated:clusters', auth)")
  })

  it('global.d.ts: Window.electronAPI.apprunDedicated の型がある', () => {
    expect(globalDts).toContain('apprunDedicated: {')
    expect(globalDts).toContain('limits(auth: { token: string; secret: string })')
    expect(globalDts).toContain('plans(auth: { token: string; secret: string })')
    expect(globalDts).toContain('clusters(auth: { token: string; secret: string })')
  })
})

describe('破壊系メソッドが1つも無いこと（この段階ではクラスタもアプリも作らない）', () => {
  it('src/main/cloud/apprunDedicated.ts に POST/PUT/PATCH/DELETE が無い', () => {
    expect(client).not.toContain("method: 'POST'")
    expect(client).not.toContain("method: 'PUT'")
    expect(client).not.toContain("method: 'PATCH'")
    expect(client).not.toContain("method: 'DELETE'")
  })

  it('src/main/ipc/apprunDedicated.ts も同様（IPCハンドラ側にも足していない）', () => {
    expect(ipc).not.toContain("method: 'POST'")
    expect(ipc).not.toContain("method: 'PUT'")
    expect(ipc).not.toContain("method: 'PATCH'")
    expect(ipc).not.toContain("method: 'DELETE'")
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

  it('PublishTargetKind（公開記録の種別）には足していない（sakura-vps と同じ扱い）', () => {
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

describe('AppRunDedicatedPanel: ①〜⑤の節がある', () => {
  it('① 認証情報', () => { expect(panel).toContain('① 認証情報') })
  it('② サービスプリンシパルの用意（手作業が必要）', () => { expect(panel).toContain('② サービスプリンシパルの用意（手作業が必要）') })
  it('③ 使えるプランと制限', () => { expect(panel).toContain('③ 使えるプランと制限') })
  it('④ 費用の確認と同意', () => { expect(panel).toContain('④ 費用の確認と同意') })
  it('⑤ ここから先はまだ作れません', () => { expect(panel).toContain('⑤ ここから先はまだ作れません') })

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

  it('⑤: 作成ボタンを置いていない（apprunDedicated への呼び出しは limits/plans/clusters の3つだけ）', () => {
    const calls = [...panel.matchAll(/electronAPI\.apprunDedicated\.(\w+)/g)].map(m => m[1])
    expect(calls.length).toBeGreaterThan(0)
    expect(new Set(calls)).toEqual(new Set(['limits', 'plans', 'clusters']))
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

  it('saveMeta は .sakuraide.json の publish.apprunDedicated へ書く', () => {
    expect(panel).toContain("const metaPath = `${projectDir}/.sakuraide.json`")
    expect(panel).toContain('apprunDedicated: { ...(m.publish?.apprunDedicated ?? {}), ...patch }')
  })

  it('同意済みなら日時を表示し、取り消せる', () => {
    expect(panel).toContain('✅ 同意済み（')
    expect(panel).toContain('同意を取り消す')
    expect(panel).toContain('const revokeConsent = async () => {')
  })
})
