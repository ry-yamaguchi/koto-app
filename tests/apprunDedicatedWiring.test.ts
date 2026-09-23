import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { priceSummary, priceUnselectedText, planKeyFromPath, monthlyYenForPlanPath, isValidResourceName, isReservedPort, pickCheapestWorkerPlan, pickCheapestLbPlan, cheapestMonthlyState, alwaysOnChargeText, minimumCostText, selectableZones, defaultZone, STAGE_LABEL, resourceIdLabel, type CreateClusterFlowStage, PUBLISH_STAGE_LABEL, type PublishAppStage, buildTeardownSummary, computePublishFormErrors } from '../src/renderer/components/AppRunDedicatedPanel'
import { readZones } from '../src/shared/apprunDedicatedShapes'
// D-14（2026-09-16 の検分）: 使い方ガイドの約束を、実装（見出しの出し分け・確認できる公開の条件）
// そのものと突き合わせる。文書だけが先に強い約束をする形を、振る舞いで禁じる。
import { publishHeadline } from '../src/shared/publishLabels'
// D-19b（同日の検分）: ⑧の確認は canVerify を通らなくなった（確かめ方の選択は dedicatedVerifyMode）。
// 見張りの当て先も、いま⑧が本当に使う関数へ張り替える。
import { canVerify, dedicatedVerifyMode, dedicatedProbePath } from '../src/shared/publishVerify'

// roadmap #23。段階①「下調べ画面」の配線に加え、段階②「作る」＋④「破棄」の配線を固定する
// （掟6: IPC 3点セット・掟10: 一元化した守りはテストで固定する）。実装をわざと壊すと落ちることを
// 変異試験で別途確かめてある（報告のみ・このファイルは元の形を固定する）。

/**
 * CHANGELOG の**いちばん新しい節**だけを切り出す（2026-09-23）。
 *
 * 以前は `## [未リリース]` から `## [0.6.18]` までを直接指していたが、
 * **リリースのたびに節名が変わって、この形のテストが一斉に落ちる**
 * （0.6.19 で実際に9件落ちた）。版に依らず「先頭の節」を見る。
 */
function newestChangelogSection(text: string): string {
  const first = text.indexOf('\n## [')
  if (first < 0) return ''
  const next = text.indexOf('\n## [', first + 1)
  return next < 0 ? text.slice(first) : text.slice(first, next)
}

const ipc = readFileSync(join(__dirname, '..', 'src/main/ipc/apprunDedicated.ts'), 'utf-8')
const index = readFileSync(join(__dirname, '..', 'src/main/ipc/index.ts'), 'utf-8')
const preload = readFileSync(join(__dirname, '..', 'src/main/preload.ts'), 'utf-8')
const globalDts = readFileSync(join(__dirname, '..', 'src/renderer/global.d.ts'), 'utf-8')
const client = readFileSync(join(__dirname, '..', 'src/main/cloud/apprunDedicated.ts'), 'utf-8')
const applyFile = readFileSync(join(__dirname, '..', 'src/main/cloud/apprunDedicatedApply.ts'), 'utf-8')
const panel = readFileSync(join(__dirname, '..', 'src/renderer/components/AppRunDedicatedPanel.tsx'), 'utf-8')
const publishModal = readFileSync(join(__dirname, '..', 'src/renderer/components/PublishModal.tsx'), 'utf-8')
// D-4: 📡 公開したもの一覧（専有型のアプリだけを消す口 apprunDedicated.teardownApp の配線）。
const publishedListModal = readFileSync(join(__dirname, '..', 'src/renderer/components/PublishedListModal.tsx'), 'utf-8')
const targetProfiles = readFileSync(join(__dirname, '..', 'src/renderer/targetProfiles.ts'), 'utf-8')
// 委譲仕様 UX-E（判断8）: ①「キー」節は AccessKeySection.tsx に一元化した。
// panel.tsx 側の配線（何を渡しているか）と、共通部品側の見た目の判断（どう見せるか）を
// 別々に固定する（掟10）。
const accessKeySection = readFileSync(join(__dirname, '..', 'src/renderer/components/AccessKeySection.tsx'), 'utf-8')

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

  it('main: apprunDedicated:zones を登録し、GETのみの getZones（src/main/cloud/zones.ts）を呼ぶ（roadmap #28）', () => {
    expect(ipc).toContain("ipcMain.handle('apprunDedicated:zones'")
    expect(ipc).toContain("import { getZones } from '../cloud/zones'")
    expect(ipc).toContain('getZones(auth)')
  })

  it('main: create/teardown ハンドラは apprunDedicatedApply.ts の createClusterFlow/teardownFlow を呼ぶ（opts.confirmed 付き・2026-09-10 レビューの修理A）', () => {
    expect(ipc).toContain("import { createClusterFlow, teardownFlow")
    expect(ipc).toContain('from \'../cloud/apprunDedicatedApply\'')
    expect(ipc).toContain('createClusterFlow(auth, projectDir, spec, { confirmed: isConfirmed(opts) })')
    // #39: 各段が一覧から消えるまで待つ間の進捗を画面へ流すため、progress を渡すようになった。
    expect(ipc).toContain('teardownFlow(auth, projectDir, { confirmed: isConfirmed(opts), progress })')
  })

  it('main: #39 teardown ハンドラは event.sender.send で apprunDedicated:teardown-progress を流す（cloud:apply-progress と同じ形）', () => {
    expect(ipc).toContain("event.sender.send('apprunDedicated:teardown-progress', msg)")
  })

  it('main: registerApprunDedicatedHandlers が index.ts から呼ばれている', () => {
    expect(index).toContain("import { registerApprunDedicatedHandlers } from './apprunDedicated'")
    expect(index).toContain('registerApprunDedicatedHandlers(deps)')
  })

  it('preload: electronAPI.apprunDedicated.{limits,plans,clusters,zones,create,teardown,state} を公開している（create/teardownはopts付き・2026-09-10 レビューの修理A）', () => {
    expect(preload).toContain("limits: (auth: { token: string; secret: string }) => ipcRenderer.invoke('apprunDedicated:limits', auth)")
    expect(preload).toContain("plans: (auth: { token: string; secret: string }) => ipcRenderer.invoke('apprunDedicated:plans', auth)")
    expect(preload).toContain("clusters: (auth: { token: string; secret: string }) => ipcRenderer.invoke('apprunDedicated:clusters', auth)")
    expect(preload).toContain("zones: (auth: { token: string; secret: string }) => ipcRenderer.invoke('apprunDedicated:zones', auth)")
    expect(preload).toContain("ipcRenderer.invoke('apprunDedicated:create', projectDir, auth, spec, opts)")
    expect(preload).toContain("ipcRenderer.invoke('apprunDedicated:teardown', projectDir, auth, opts)")
    expect(preload).toContain("state: (projectDir: string) => ipcRenderer.invoke('apprunDedicated:state', projectDir)")
  })

  it('preload: #39 onTeardownProgress は apprunDedicated:teardown-progress を購読し、解除用の関数を返す', () => {
    expect(preload).toContain("onTeardownProgress: (cb: (msg: string) => void) => {")
    expect(preload).toContain("ipcRenderer.on('apprunDedicated:teardown-progress', handler)")
    expect(preload).toContain("ipcRenderer.removeListener('apprunDedicated:teardown-progress', handler)")
  })

  it('global.d.ts: Window.electronAPI.apprunDedicated の型に zones/create/teardown/state がある（create/teardownはopts.confirmed付き）', () => {
    expect(globalDts).toContain('apprunDedicated: {')
    expect(globalDts).toContain('limits(auth: { token: string; secret: string })')
    expect(globalDts).toContain('plans(auth: { token: string; secret: string })')
    expect(globalDts).toContain('clusters(auth: { token: string; secret: string })')
    expect(globalDts).toContain('zones(auth: { token: string; secret: string })')
    expect(globalDts).toContain('create(projectDir: string, auth: { token: string; secret: string }, spec:')
    expect(globalDts).toContain('teardown(projectDir: string, auth: { token: string; secret: string }, opts?: { confirmed?: boolean })')
    expect(globalDts).toContain('state(projectDir: string)')
  })

  it('global.d.ts: #39 teardown の戻り値に inProgress があり、onTeardownProgress の型もある', () => {
    const at = globalDts.indexOf('teardown(projectDir: string, auth: { token: string; secret: string }, opts?: { confirmed?: boolean })')
    expect(at).toBeGreaterThan(0)
    const block = globalDts.slice(at, globalDts.indexOf('onTeardownProgress(cb: (msg: string) => void): () => void'))
    // B（2026-09-17）: アプリの削除で止まったときも画面が示せるよう applicationID を足した
    // （teardownApp と同じ形に揃える）。
    expect(block).toContain('inProgress?: { applicationID?: string; loadBalancerID?: string; asgID?: string; clusterID?: string }')
    expect(globalDts).toContain('onTeardownProgress(cb: (msg: string) => void): () => void')
  })

  // #38「⑦ ログ・メトリクス」: main/preload/global.d.ts の3点セット。判断・GET/POSTの
  // 実装は src/main/cloud/monitoring.ts に一元化してあり（tests/monitoring.test.ts が偽サーバで
  // 振る舞いを固定）、ここは配線（呼ぶだけになっているか）だけを固定する。
  it('main: apprunDedicated:telemetryStatus / enableTelemetry を登録し、monitoring.ts の関数を呼ぶだけ（#38）', () => {
    expect(ipc).toContain("ipcMain.handle('apprunDedicated:telemetryStatus'")
    expect(ipc).toContain("ipcMain.handle('apprunDedicated:enableTelemetry'")
    expect(ipc).toContain("import { fetchDedicatedTelemetryStatus, enableDedicatedTelemetry } from '../cloud/monitoring'")
    expect(ipc).toContain('return fetchDedicatedTelemetryStatus(auth)')
    expect(ipc).toContain('return enableDedicatedTelemetry(auth, kind, variants, { consented: isTelemetryConsented(opts) })')
  })

  it('main: apprunDedicated:enableTelemetry は isTelemetryKind で kind を検証してから呼ぶ（不正な kind では fetch しない）', () => {
    const at = ipc.indexOf("ipcMain.handle('apprunDedicated:enableTelemetry'")
    expect(at).toBeGreaterThan(0)
    const closeAt = ipc.indexOf('\n  })', at)
    expect(closeAt).toBeGreaterThan(at)
    const body = ipc.slice(at, closeAt)
    expect(body).toContain("if (!isTelemetryKind(kind)) return { ok: false, message: '種類が不正です' }")
    expect(ipc).toContain("import { isTelemetryKind, DEDICATED_VARIANTS } from '../../shared/appLog'")
  })

  it('preload: electronAPI.apprunDedicated.{telemetryStatus,enableTelemetry} を公開している（#38）', () => {
    expect(preload).toContain("telemetryStatus: (auth: { token: string; secret: string }) => ipcRenderer.invoke('apprunDedicated:telemetryStatus', auth)")
    expect(preload).toContain("ipcRenderer.invoke('apprunDedicated:enableTelemetry', auth, kind, opts)")
  })

  it('global.d.ts: Window.electronAPI.apprunDedicated の型に telemetryStatus/enableTelemetry がある（#38）', () => {
    expect(globalDts).toContain('telemetryStatus(auth: { token: string; secret: string })')
    expect(globalDts).toContain("enableTelemetry(auth: { token: string; secret: string }, kind: 'logs' | 'metrics', opts?: { consented?: boolean })")
  })
})

describe('破壊系メソッドは apprunDedicated.ts の1箇所（requestJson）に閉じ込めてある（段階②＋段階③⑤ D-1）', () => {
  it('fetch を直接呼ぶのは requestJson だけ。POST/DELETE/PUT/PATCH はすべて requestJson へ渡す引数', () => {
    expect((client.match(/await fetch\(/g) ?? []).length).toBe(1)
    const postCount = (client.match(/requestJson[\s\S]{0,40}'POST'/g) ?? []).length
    const deleteCount = (client.match(/requestJson[\s\S]{0,60}'DELETE'/g) ?? []).length
    const putCount = (client.match(/requestJson[\s\S]{0,40}'PUT'/g) ?? []).length
    const patchCount = (client.match(/requestJson[\s\S]{0,40}'PATCH'/g) ?? []).length
    expect(postCount).toBeGreaterThan(0)
    expect(deleteCount).toBeGreaterThan(0)
    // PUT は activeVersion の切替（updateApplication）だけ、PATCH は Let's Encrypt メール（patchClusterLoadBalancer）だけ。
    // 増えたら「何のために増やしたか」をここに書く（黙って増やさない）。
    expect(putCount).toBe(1)
    expect(patchCount).toBe(1)
    expect((client.match(/'PUT'/g) ?? []).length).toBe(1)
    expect((client.match(/'PATCH'/g) ?? []).length).toBe(1)
  })

  it('PATCH …/load_balancer だけ application/merge-patch+json（原本 v1.4.0）。他は application/json の既定', () => {
    expect((client.match(/'application\/merge-patch\+json'/g) ?? []).length).toBe(1)
    expect(client).toContain("contentType: string = 'application/json'")
  })

  it('applications / versions（段階③⑤ D-1・2026-09-12）は薄いクライアントとして実装済み。一覧は maxItems 必須', () => {
    expect(client).toContain("'/applications'")
    expect(client).toMatch(/\/applications\?clusterID=\$\{encodeURIComponent\(clusterID\)\}&maxItems=/)
    expect(client).toMatch(/\/versions\?maxItems=/)
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

  // ── 判断4（利用者目線レビュー・2026-09-11）: 費用の説明を1か所に一本化 ──────────────
  // 以前はここ（タブ直下）・AppRunDedicatedPanel.tsx のパネル冒頭・④冒頭の3か所に
  // ほぼ同文の注意（常時課金・月2万円〜・アプリの公開はまだ）が出ていた。
  // タブ直下の注意は削り、AppRunDedicatedPanel.tsx のパネル冒頭に一本化する。
  it('専有型タブ直下には、費用・提供範囲の注意を重複して出さない（パネル冒頭に一本化）', () => {
    const at = publishModal.indexOf("(target === 'sakura-apprun' || target === 'sakura-apprun-dedicated') ? (")
    const block = publishModal.slice(at, at + 2300)
    expect(block).not.toContain('常時課金')
    expect(block).not.toContain('アプリの公開（独自ドメイン）はまだできません')
    // ハードコードの金額も無い（cheapestMonthlyText で計算する・下のdescribeで固定）
    expect(block).not.toMatch(/2万円/)
    expect(block).not.toMatch(/20,000/)
    expect(block).not.toMatch(/22,000/)
  })

  it('「📦 さくらのAppRun」を選ぶ前のボタン説明文にも、金額をハードコードしていない', () => {
    expect(publishModal).not.toMatch(/2万円/)
    expect(publishModal).not.toMatch(/20,000/)
    expect(publishModal).not.toMatch(/22,000/)
  })

  it('タブに応じて AppRunPanel / AppRunDedicatedPanel を切り替えて表示する', () => {
    expect(publishModal).toContain("import AppRunDedicatedPanel from './AppRunDedicatedPanel'")
    const at = publishModal.indexOf("(target === 'sakura-apprun' || target === 'sakura-apprun-dedicated') ? (")
    const block = publishModal.slice(at, at + 3200)
    // 2026-09-23 検分の指摘5: 出し分けは三項演算子（＝タブを行き来するたびに再マウントし、
    // ③の調査結果が消えて⑦の GET 6本を取り直す）をやめ、一度開いたパネルは外さず
    // hidden で隠す形にした。タブの見た目の選択状態は aria-selected が持つ（上のテスト）。
    expect(block).toContain("<div className={target === 'sakura-apprun' ? undefined : 'hidden'}>")
    expect(block).toContain("<div className={target === 'sakura-apprun-dedicated' ? undefined : 'hidden'}>")
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

  // D-3（2026-09-11 Ryosuke 決定）: 専有型は公開記録の種別（PublishTargetKind）に入った。
  // 唯一の定義は src/renderer/publishStatus.ts（5種類の一覧・ラベル・コンパネ URL は
  // tests/publishStatus.test.ts が固定）。PublishModal.tsx にあった複製
  // （'hanamii' | 'sakura-apprun' | 'sakura-rental' | 'vercel'）は消し、import に切り替えた（掟10）。
  // 変異試験 (b)「PublishModal.tsx に複製した型を戻す」を、このテストが検知する。
  it('PublishTargetKind の複製は PublishModal.tsx に無く、publishStatus.ts から import している（掟10・D-3 で専有型を足した際に複製を消した）', () => {
    // 複製の不在（export の有無・空白の違いに関わらず、型の定義そのものを禁じる）
    expect(publishModal).not.toMatch(/type PublishTargetKind\s*=/)
    // import 文の実物（末尾を前後ごと指す。同じ文字列は他の行に無いことを確認済み）
    expect(publishModal).toContain("type PublishTargetKind } from '../publishStatus'")
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

  // D-3 残作業（2026-09-15）: StorageNotice（「データの保存」の案内）は、コンテナ系で
  // 状態が消えることを知らせる守りの表示。専有型 sakura-apprun-dedicated も共用型と同じく
  // ステートレス（storageNeed.ts の targetKeepsData=false）なので、専有型だけを除外する条件
  // （target !== 'sakura-apprun-dedicated'）を足してはいけない。除外条件は sakura-vps のみ。
  it('StorageNotice の表示条件は sakura-vps だけを除外する。専有型を個別に除外していない', () => {
    expect(publishModal).toContain("target && target !== 'sakura-vps' && (")
    // 2026-09-23: 以前はファイル全体に対する not.toContain だったが、それでは
    // StorageNotice と無関係の行（タブの出し分けなど）にも当たる（掟10「当て先が
    // 他の行に出ないか確認する」）。**StorageNotice を描いている節だけ**を見る。
    const at = publishModal.indexOf("target && target !== 'sakura-vps' && (")
    const block = publishModal.slice(at, publishModal.indexOf('<StorageNotice', at) + 200)
    expect(block).toContain('<StorageNotice projectDir={projectDir} target={target}')
    expect(block).not.toContain("'sakura-apprun-dedicated'")
  })
})

describe('targetProfiles.ts: sakura-apprun-dedicated の定義', () => {
  it("TargetId に含まれ、autoPublish:false（IDEからの自動公開にはまだ対応していない）", () => {
    expect(targetProfiles).toContain("'sakura-apprun-dedicated'")
    const at = targetProfiles.indexOf("'sakura-apprun-dedicated': {")
    expect(at).toBeGreaterThan(0)
    // 終端は固定の文字数ではなく次のキー（'sakura-vps'）までにする（2026-09-08、無関係の
    // 追記（roadmap #33・donts の追加）で固定900文字を超え、この既存テストが落ちた実例に
    // 遭遇したための修理。donts/recommended が増減しても崩れない境界にする）。
    const end = targetProfiles.indexOf("'sakura-vps': {", at)
    expect(end).toBeGreaterThan(at)
    const block = targetProfiles.slice(at, end)
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

  // ── 判断4（利用者目線レビュー・2026-09-11）─────────────────────────────
  // 「専有型は常時課金です」はパネル冒頭に一本化し、④からは削った（④は同意の本文だけにする）。
  it('④: 常時課金の注意はパネル冒頭に一本化されており、④では繰り返さない', () => {
    const at = panel.indexOf('④ 費用の確認と同意')
    const end = panel.indexOf('⑤ クラスタを作る', at)
    const block = panel.slice(at, end)
    expect(block).not.toContain('常時課金です')
  })

  // D-13 K（2026-09-16）: 以前は `cheapestMonthlyText(...)` の戻り値（文の断片）を
  // 「最小構成…でも、〈ここ〉かかります。」の**文の途中**にはめ込んでいた。金額が出せないときに
  // 「…月額はプランを取得すると表示されますかかります。」と壊れたため、文を丸ごと切り替える
  // 純関数 minimumCostText へ移した。
  it('④: 最小構成の月額は minimumCostText（文を丸ごと返す純関数）から出し、金額をハードコードしていない', () => {
    const at = panel.indexOf('④ 費用の確認と同意')
    const end = panel.indexOf('⑤ クラスタを作る', at)
    const block = panel.slice(at, end)
    expect(block).toContain('{minimumCostText({ workerPlans, lbPlans })}')
    // 直す前の形（断片を文の途中にはめ込む）に戻っていないこと
    expect(block).not.toContain('でも、<span className="text-brand-red">')
    expect(block).not.toContain('}</span>かかります。')
    expect(block).not.toMatch(/2万円/)
    expect(block).not.toMatch(/20,000/)
    expect(block).not.toMatch(/22,000/)
  })

  // 2026-09-08: zones はこのパネルから直接呼ばず、zonesCache.ts の loadZones() 経由に
  // 一元化した（起動時キャッシュの使い回し）。パネルからの直接呼び出しは6つに減り、
  // zones の実際の呼び出しは zonesCache.ts 側にあることを別途確かめる。
  // 2026-09-09（roadmap #35）: ①「🔌 接続テスト」が testConnection（チェックリストの形）を
  // 呼ぶようになり、7つに増えた。2026-09-10（#39）: ⑥の進捗購読 onTeardownProgress が増え、8つに。
  // #38: ⑦「ログ・メトリクス」が telemetryStatus/enableTelemetry を呼ぶようになり、10に増えた。
  // D-4（2026-09-15）: ⑧「アプリを公開する」が appStatus/publishApp/onPublishProgress を呼ぶようになり、13に。
  // D-5（2026-09-16）: ⑧「🔄 IP を取り直す」が lbAddresses を呼ぶようになり、14に。
  // O-1（2026-09-17）: ⑧「🔎 公開先と https を確かめる」が checkSite を呼ぶようになり、15に。
  // teardownApp（アプリだけ消す口）は 📡 公開したもの一覧（PublishedListModal.tsx）だけが呼び、
  // このパネルからは呼ばない（⑥は全部消す teardown のまま）。
  it('apprunDedicated への直接呼び出しは limits/plans/clusters/create/teardown/state/testConnection/onTeardownProgress/telemetryStatus/enableTelemetry/appStatus/publishApp/onPublishProgress/lbAddresses/checkSite の15（zonesはzonesCache.ts経由・teardownApp は📡一覧だけ）', () => {
    const calls = [...panel.matchAll(/electronAPI\.apprunDedicated\.(\w+)/g)].map(m => m[1])
    expect(calls.length).toBeGreaterThan(0)
    expect(new Set(calls)).toEqual(new Set([
      'limits', 'plans', 'clusters', 'create', 'teardown', 'state', 'testConnection', 'onTeardownProgress',
      'telemetryStatus', 'enableTelemetry',
      'appStatus', 'publishApp', 'onPublishProgress',
      'lbAddresses',
      'checkSite',
    ]))
    expect(calls).not.toContain('teardownApp')
  })

  it('zones の実際の呼び出しは zonesCache.ts にある（roadmap #28）', () => {
    const cache = readFileSync(join(__dirname, '..', 'src/renderer/zonesCache.ts'), 'utf-8')
    expect(cache).toContain('window.electronAPI.apprunDedicated.zones(auth)')
  })

  it('⑤: ネットワークは共有セグメント固定と明示し、スイッチ/IPプールの入力欄を出さない', () => {
    expect(panel).toContain('共有セグメントに繋ぎます')
    expect(panel).not.toMatch(/ipPool|netmaskLen|defaultGateway/i)
  })

  // #38: ⑦「ログ・メトリクス」（プロジェクト単位。共用型「⑧ ログ・メトリクス」とは番号が違う）。
  it('⑦ ログ・メトリクス（#38）', () => { expect(panel).toContain('⑦ ログ・メトリクス') })

  it('⑦: プロジェクト単位（クラスタごとではない）ことを注記している', () => {
    expect(panel).toContain('この設定はクラスタごとではなく、このプロジェクトの専有型全体に効きます（コントロールパネルの『ログ・メトリクス設定』と同じものです）。')
  })

  it('⑦: キーが無ければ①で登録するよう案内する', () => {
    const at = panel.indexOf('<p className="text-sm font-semibold text-ink">⑦ ログ・メトリクス</p>')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, at + 700)
    expect(block).toContain('①で登録してください。')
  })
})

// ── F-1 B（2026-09-16）: ⑦を1行に畳む（B-1）・破棄中はボタンを押せなくする（B-2） ──────────
describe('F-1 B-1: ⑦は全部繋がっていて行動が要らないときだけ <details>（閉じた状態）に畳む', () => {
  it('畳むかどうかは shouldCollapseTelemetrySection（shared/appLog.ts）の純関数で判定する（画面は描くだけ・掟10）', () => {
    expect(panel).toContain("import { shouldCollapseTelemetrySection } from '../../shared/appLog'")
    expect(panel).toContain('const collapseTelemetry = !!telemetryVariants && !!telemetryActions')
    expect(panel).toContain('shouldCollapseTelemetrySection(telemetryVariants, [telemetryActions.logs, telemetryActions.metrics])')
    expect(panel).toContain(') : collapseTelemetry ? (')
  })

  it('畳んだときの1行は summary に出し、既存の「詳細設定」と同じ <details> の書き方（独自の開閉を作らない）', () => {
    const at = panel.indexOf(') : collapseTelemetry ? (')
    expect(at).toBeGreaterThan(0)
    const end = panel.indexOf(') : (', at)
    const block = panel.slice(at, end)
    expect(block).toContain('<details className="rounded-lg border border-line bg-overlay p-3">')
    expect(block).toContain('<summary className="cursor-pointer select-none text-xs font-semibold text-ink-secondary hover:text-ink">✅ ログ・メトリクス 繋がっています</summary>')
    // 開けば6行（telemetryVariants の一覧）が見える。
    expect(block).toContain('{telemetryVariants.map(v => (')
  })

  it('取得中・エラー・キー未登録の表示はいまのまま（!keyReady / telemetryLoading / !telemetryVariants の分岐を変えていない）', () => {
    expect(panel).toContain('{!keyReady ? (')
    expect(panel).toContain(') : telemetryLoading ? (')
    expect(panel).toContain(') : !telemetryVariants || !telemetryActions ? (')
  })
})

describe('F-1 B-2: 破棄中（tearingDown）は⑦の操作ボタンを押せない。表示そのものは消さない', () => {
  it('⑦の4つのボタン（つなぐ・つなぐ〔ask初期〕・用意する・やめる）はどれも tearingDown で disabled になる', () => {
    const at = panel.indexOf('<p className="text-sm font-semibold text-ink">⑦ ログ・メトリクス</p>')
    const end = panel.indexOf('{/* ⑧ アプリを公開する', at)
    expect(at).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(at)
    const block = panel.slice(at, end)
    expect(block).toContain("disabled={telemetryBusyKind === kind || panelBusy({ creating, tearingDown, publishing, lbRefreshing })}")
    // 「用意する（費用に同意）」「やめる」の2つも同形（route の1つと合わせて計3か所、+ ask初期の1か所）。
    expect((block.match(/disabled=\{telemetryBusyKind === kind \|\| panelBusy\(\{ creating, tearingDown, publishing, lbRefreshing \}\)\}/g) ?? []).length).toBe(3)
    expect(block).toContain("onClick={() => { setTelemetryError(''); setTelemetryConfirmingKind(kind) }}")
    // 4つ目（ask初期のボタン）は busy 判定が無いので単独の disabled={tearingDown}。
    expect((block.match(/disabled=\{panelBusy\(\{ creating, tearingDown, publishing, lbRefreshing \}\)\}/g) ?? []).length).toBe(1)
    // 表示そのものは消していない（⑦の見出し・一覧は tearingDown を条件にしていない）。
    expect(block).not.toContain('{!tearingDown &&')
  })
})

// ── 判断4（利用者目線レビュー・2026-09-11）＋ D-13 K（2026-09-16）───────────────────
// 「月2万円〜」「22,000円」等のハードコードを、pickCheapestWorkerPlan / pickCheapestLbPlan と
// 料金表（monthlyYenForPlanPath）から計算する純関数に置き換えた（判断4）。
// D-13 K: そのとき金額を出せない場合に**文の断片**を返していたため、呼び出し側の文に
// はめ込まれて「…月額はプランを取得すると表示されますかかります。」と壊れた（実機で観測）。
// いまは状態（known / not-fetched / not-in-table）を返し、文は呼び出し向けの純関数が
// **丸ごと**切り替える。
describe('cheapestMonthlyState: 出せる／まだ調べていない／料金表に無い の3分岐（D-13 K）', () => {
  const worker = { name: 'ワーカ 1コア/2GB', path: 'cloud/apprun/dedicated/worker/1vcpu_2gb', nodeCount: null }
  const lb = { name: 'LB 1コア/2GB', path: 'cloud/apprun/dedicated/lb/1vcpu_2gb_1', nodeCount: 1 }

  it('★★ プラン未取得（null）なら not-fetched（金額を推測して埋めない）', () => {
    expect(cheapestMonthlyState({ workerPlans: null, lbPlans: null })).toEqual({ kind: 'not-fetched' })
  })

  it('★★ 取得できたが1件も無ければ、同じく not-fetched（推測しない）', () => {
    expect(cheapestMonthlyState({ workerPlans: [], lbPlans: [] })).toEqual({ kind: 'not-fetched' })
  })

  it('★★ 料金表で額を引ける最安プラン（ワーカ11,000円＋LB11,000円×1台）なら known・「月2万円〜」', () => {
    expect(cheapestMonthlyState({ workerPlans: [worker], lbPlans: [lb] })).toEqual({ kind: 'known', amountText: '月2万円〜' })
  })

  it('★★ 取得はできたが料金表に無い path しか無ければ not-in-table（「まだ調べていない」とは別の理由）', () => {
    const unknown = { name: '？', path: 'cloud/apprun/dedicated/worker/999vcpu_999gb', nodeCount: null }
    expect(cheapestMonthlyState({ workerPlans: [unknown], lbPlans: [lb] })).toEqual({ kind: 'not-in-table' })
  })

  it('万円未満に切り下げる（万の位まで。中途半端な端数は出さない）', () => {
    // 4コア/4GB=33,000円 × ワーカ + 1コア/2GB=11,000円 × LB1台 = 44,000円 → 月4万円〜
    const bigWorker = { name: 'ワーカ 4コア/4GB', path: 'cloud/apprun/dedicated/worker/4vcpu_4gb', nodeCount: null }
    expect(cheapestMonthlyState({ workerPlans: [bigWorker], lbPlans: [lb] })).toEqual({ kind: 'known', amountText: '月4万円〜' })
  })
})

// ── D-13 K: 画面に出る文は「丸ごと」切り替わる（断片を文にはめ込まない）─────────────────
// 2026-09-16 の実機（⑥の破棄直後）で、④に
//   「最小構成（…）でも、月額はプランを取得すると表示されますかかります。」
// と出た。金額が出せないときだけ壊れるので、ふだんの確認では見つからない。
describe('alwaysOnChargeText / minimumCostText: 3分岐とも、それ自体で文として読める（D-13 K）', () => {
  const worker = { name: 'ワーカ 1コア/2GB', path: 'cloud/apprun/dedicated/worker/1vcpu_2gb', nodeCount: null }
  const lb = { name: 'LB 1コア/2GB', path: 'cloud/apprun/dedicated/lb/1vcpu_2gb_1', nodeCount: 1 }
  const unknown = { name: '？', path: 'cloud/apprun/dedicated/worker/999vcpu_999gb', nodeCount: null }

  it('★★ 金額が出せるとき: 金額を入れた1文になる', () => {
    expect(alwaysOnChargeText({ workerPlans: [worker], lbPlans: [lb] }))
      .toBe('⚠️ 最小構成でも月2万円〜の常時課金です（動いていなくても請求されます）。')
    expect(minimumCostText({ workerPlans: [worker], lbPlans: [lb] }))
      .toBe('最小構成（ワーカ・ロードバランサとも最安プラン1台ずつ）でも、月2万円〜かかります。')
  })

  it('★★ まだ調べていないとき: 数字を推測で書かず、③の「🔍 調べる」を案内する', () => {
    expect(alwaysOnChargeText({ workerPlans: null, lbPlans: null }))
      .toBe('⚠️ 動いていなくても請求される固定料金がかかります。正確な金額は、③の「🔍 調べる」を押すと出せます。')
    expect(minimumCostText({ workerPlans: null, lbPlans: null }))
      .toBe('最小構成（ワーカ・ロードバランサとも最安プラン1台ずつ）の正確な金額は、③の「🔍 調べる」を押すと出せます。')
  })

  it('★★ 料金表に無いとき: 「調べれば出る」とは言わない（理由が違う）', () => {
    expect(alwaysOnChargeText({ workerPlans: [unknown], lbPlans: [lb] }))
      .toBe('⚠️ 動いていなくても請求される固定料金がかかります。ただし、取得したプランが料金表に無いため、正確な金額は出せません。')
    expect(minimumCostText({ workerPlans: [unknown], lbPlans: [lb] }))
      .toBe('最小構成（ワーカ・ロードバランサとも最安プラン1台ずつ）の金額は出せません（取得したプランが料金表にありません）。')
    // 「調べると出せます」を混ぜない（押しても出ないため）
    expect(minimumCostText({ workerPlans: [unknown], lbPlans: [lb] })).not.toContain('🔍 調べる')
  })

  it('★★ どの分岐でも、直す前の断片（文の途中にはめ込む形）を返さない', () => {
    const cases = [
      { workerPlans: null, lbPlans: null },
      { workerPlans: [], lbPlans: [] },
      { workerPlans: [unknown], lbPlans: [lb] },
      { workerPlans: [worker], lbPlans: [lb] },
    ]
    for (const c of cases) {
      for (const text of [alwaysOnChargeText(c), minimumCostText(c)]) {
        expect(text, `断片が戻っている: ${text}`).not.toContain('月額はプランを取得すると表示されます')
        // 文として終わっていること（途中で切れた断片を返していない）
        expect(text.endsWith('。'), `文として終わっていない: ${text}`).toBe(true)
      }
    }
  })
})

describe('専有型の費用・提供範囲の注意は、パネル冒頭の1か所だけ（判断4・重複の解消）', () => {
  it('パネル冒頭は alwaysOnChargeText(...) で1文を出す（文言も金額もここに直書きしない）', () => {
    const at = panel.indexOf('📦 さくらのAppRun 専有型')
    expect(at).toBeGreaterThan(0)
    const end = panel.indexOf('① APIキー', at)
    const block = panel.slice(at, end)
    expect(block).toContain('{alwaysOnChargeText({ workerPlans, lbPlans })}')
    // D-13 K: 文言は純関数の側に移した（画面は描くだけ・掟10）。断片をはめ込む形に戻っていないこと
    expect(block).not.toContain('最小構成でも{')
    // 文言そのものは alwaysOnChargeText が持っている
    expect(panel).toContain('常時課金です（動いていなくても請求されます）。')
    // D-4（2026-09-15）: ⑧でアプリの公開ができるようになった。旧「まだできません」は無く、提供範囲を⑤⑥⑧で示す。
    expect(block).toContain('クラスタの作成・破棄（⑤⑥）と、アプリケーションの公開（⑧・独自ドメインが必要）まで行えます。')
    expect(block).not.toContain('まだできません')
  })

  // 「常時課金です」という言い回しが、パネル全体を通じて1回しか出ないこと
  // （PublishModal のタブ直下・④冒頭にあった重複はここへ一本化して削った）。
  it('★「常時課金です」は AppRunDedicatedPanel.tsx に1回だけ出る（重複が復活していない）', () => {
    const matches = panel.match(/常時課金です/g) ?? []
    expect(matches.length).toBe(1)
  })

  // 選択前のボタン説明（「専有型（上級者向け・常時課金）」の一言）は残ってよい——
  // 重複していたのは「動いていなくても請求されます」等の詳しい注意（タブ直下）のほうで、
  // それを削って一本化した。
  it('★ PublishModal.tsx には、詳しい注意（動いていなくても請求されます）の重複がない', () => {
    expect(publishModal).not.toContain('動いていなくても請求されます')
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

  // 2026-09-11（判断7）: formError（1本の早期return文字列）を、欄ごとの
  // computeDedicatedFormErrors/hasErrors に分けた（visibleFormErrors は「表示するか」だけを
  // 判断し、「送信してよいか」は touched/submitted に関係なく常に全欄を見る＝doCreate を止める
  // 力は弱めていない）。
  it('doCreate はフォーム側の検証（hasErrors）を通ってからしか呼ばれない（disabled={hasErrors || creating}）', () => {
    expect(panel).toContain('disabled={hasErrors || panelBusy({ creating, tearingDown, publishing, lbRefreshing })}')
    const at = panel.indexOf('const doCreate = async () => {')
    expect(at).toBeGreaterThan(0)
    expect(panel.slice(at, at + 160)).toContain('if (hasErrors || panelBusy({ creating, tearingDown, publishing, lbRefreshing })) return')
  })
})

describe('⑤: 記録があるとき（hasAnyResource）は入力欄・作成ボタンを出さない（2026-09-10 レビューの修理・B）', () => {
  it('consentedAt ありでも hasAnyResource なら、作成フォームではなく「作られたものの記録があります」の案内を出す', () => {
    const at = panel.indexOf("{/* ⑤ クラスタを作る */}")
    expect(at).toBeGreaterThan(0)
    const end = panel.indexOf('{/* ⑥ 作ったものを壊す（破棄） */}')
    const block = panel.slice(at, end)
    expect(block).toContain('hasAnyResource ? (')
    expect(block).toContain('作られたものの記録があります。作り直すには、まず⑥で破棄してください。')
  })

  it('hasAnyResource の定義は⑤の描画より前にある（2箇所に複製していない）', () => {
    const defAt = panel.indexOf('const hasAnyResource = !!(apprunState?.clusterID || apprunState?.asgID || apprunState?.loadBalancerID)')
    const sectionAt = panel.indexOf("{/* ⑤ クラスタを作る */}")
    expect(defAt).toBeGreaterThan(0)
    expect(sectionAt).toBeGreaterThan(defAt)
    // 複製していないこと（同じ定義文がもう1箇所には無い）。
    expect(panel.indexOf('const hasAnyResource = !!(apprunState?.clusterID || apprunState?.asgID || apprunState?.loadBalancerID)', defAt + 1)).toBe(-1)
  })
})

describe('⑤: 押す前の確認ダイアログに月額（見積り）を出す（掟5）', () => {
  it('doCreate は price.text を含む確認文言を ConfirmModal（useConfirm）で先に確認し、その答えを runCreate の confirm へ注入する（判断9・2026-09-11）', () => {
    const at = panel.indexOf('const doCreate = async () => {')
    expect(at).toBeGreaterThan(0)
    const end = panel.indexOf('const doTeardown = async () => {')
    const block = panel.slice(at, end)
    expect(block).toContain('const confirmMessage = `${price.text}')
    expect(block).toContain('この費用が毎月かかります')
    // ConfirmModal（useConfirm の confirm）で先に確認してから、確定した答え（ok）を
    // runCreate の deps.confirm へ同期関数として渡す（apprunDedicatedActions.ts のロジックは
    // 触らない・掟10。歯止め自体は tests/apprunDedicatedActions.test.ts が固定する）。
    expect(block).toContain("const ok = await confirm({ title: '専有型クラスタを作成します', body: confirmMessage, confirmLabel: '作成する', danger: true })")
    expect(block).toContain('runCreate(')
    expect(block).toContain('{ confirmMessage, spec }')
    expect(block).toContain('confirm: () => ok,')
    // window.confirm へ退行していないこと（2026-09-11 CLAUDE.md 掟5改定）。
    expect(block).not.toContain('window.confirm(')
    // create実行そのもの（IPC呼び出し）は runCreate の deps.create の中——doCreate 自身は
    // 「確認が通ったら呼ばれる関数」を渡すだけで、呼ぶかどうかの判断は持たない。
    expect(block).toContain('window.electronAPI.apprunDedicated.create(projectDir, auth, s, opts)')
  })

  it('runCreate/runTeardown/shouldShowCreateResult/shouldShowTeardownResult は apprunDedicatedActions.ts から import している（振る舞いの固定はそちら・tests/apprunDedicatedActions.test.ts）', () => {
    expect(panel).toContain("import { runCreate, runTeardown, shouldShowCreateResult, shouldShowTeardownResult } from '../apprunDedicatedActions'")
  })

  it('price は priceSummary（表に無いプランは月額を出せません、と正直に返す関数）から作る', () => {
    expect(panel).toContain('const price = priceSummary(selectedWorkerPlan, selectedLbPlan, minNodes, maxNodes, { plansFetched })')
  })

  // 検分の指摘（2026-09-16）: ⑤の構成図の合計行だけが、プランを**取得済みで選んでいないだけ**の
  // ときにも「③の『🔍 調べる』でプランを取得すると出せます」と言っていた（プラン欄のすぐ下は
  // 「⚠️ プランを選んでください」）。**同じ画面の2か所が別の次の一手を指す**ので、非エンジニアは
  // 押しても結果の変わらない③を押し直す。plansFetched は**プラン欄が <select> を出す条件と
  // 同じ式**で作る（別の式にすると、欄は選べるのに合計行は「調べる」を促す、が再発する）。
  it('★★ plansFetched は、プラン欄の表示条件と同じ式（ワーカ・LB とも path のある行がある）で作る', () => {
    expect(panel).toContain('const plansFetched = (workerPlans ?? []).some(p => p.path) && (lbPlans ?? []).some(p => p.path)')
    // 直す前の形（一覧を見ずに ③ を促す）に戻っていないこと
    expect(panel).not.toContain('const price = priceSummary(selectedWorkerPlan, selectedLbPlan, minNodes, maxNodes)')
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
    expect(r.text).toContain('料金表に無いプランが含まれています')
  })

  // D-13 K（2026-09-16）: 「まだ調べていない」に「料金表に無い」という**違う理由**を告げていた。
  // 次の一手が変わる（前者は③の「🔍 調べる」を押せばよい・後者は押しても出ない）ので言い分ける。
  it('★★ path が無い（プラン未選択・まだ調べていない）なら、合計は null で「料金表に無い」とは言わない', () => {
    const r = priceSummary(null, null, 1)
    expect(r.totalYen).toBeNull()
    expect(r.text, '違う理由（料金表に無い）を告げている').not.toContain('料金表に無い')
    expect(r.text).toContain('③の「🔍 調べる」')
  })

  it('★★ 片方だけ選ばれていないときも「まだ出せません」（料金表のせいにしない）', () => {
    const r = priceSummary({ path: 'cloud/apprun/dedicated/worker/1vcpu_2gb' }, null, 1)
    expect(r.totalYen).toBeNull()
    expect(r.text).not.toContain('料金表に無い')
    const r2 = priceSummary({ path: null }, { path: 'cloud/apprun/dedicated/lb/1vcpu_2gb_1', nodeCount: 1 }, 1)
    expect(r2.totalYen).toBeNull()
    expect(r2.text).not.toContain('料金表に無い')
  })

  // ── 検分の指摘（2026-09-16）: 「取得済みだが未選択」を言い分ける ─────────────────────
  // K（cheapestMonthlyState）では「まだ調べていない／料金表に無い」を分けたのに、priceSummary 側は
  // **プランを取得済みで選んでいないだけ**のときも「③の『🔍 調べる』でプランを取得すると出せます」と
  // 言っていた。押しても結果は変わらない（一覧はもうある）。次の一手が違うものを同じ文にしない。
  it('★★ プラン取得済みで未選択なら、次の一手は「選ぶ」——③を押し直させない', () => {
    const r = priceSummary(null, null, 1, 1, { plansFetched: true })
    expect(r.totalYen).toBeNull()
    expect(r.text, '取得済みなのに③を押し直させている').not.toContain('🔍 調べる')
    expect(r.text).toContain('選ぶと出せます')
    expect(r.text).not.toContain('料金表に無い')
  })

  it('★★ プラン未取得なら、次の一手は③の「🔍 調べる」（理由も「まだ取得していない」と言う）', () => {
    const r = priceSummary(null, null, 1, 1, { plansFetched: false })
    expect(r.totalYen).toBeNull()
    expect(r.text).toContain('③の「🔍 調べる」')
    expect(r.text).toContain('プランをまだ取得していないため')
    expect(r.text).not.toContain('料金表に無い')
  })

  it('★★ 呼び出し側が知らせていない（5引数目を省略）なら、どちらとも断定せず両方を示す', () => {
    const r = priceSummary(null, null, 1)
    expect(r.totalYen).toBeNull()
    // 「取得済み」「未取得」のどちらかに倒さない（分からないことを断定しない・掟1）
    expect(r.text).toContain('③の「🔍 調べる」')
    expect(r.text).toContain('選ぶと出せます')
    expect(r.text).not.toContain('料金表に無い')
  })

  it('★★ 3分岐は priceUnselectedText（純関数）が持ち、画面はそれを使うだけ（掟10）', () => {
    expect(priceUnselectedText(true)).toBe(priceSummary(null, null, 1, 1, { plansFetched: true }).text)
    expect(priceUnselectedText(false)).toBe(priceSummary(null, null, 1, 1, { plansFetched: false }).text)
    expect(priceUnselectedText()).toBe(priceSummary(null, null, 1).text)
    // 3つとも別の文であること（どれか2つが同じなら、言い分けたことにならない）
    const all = [priceUnselectedText(true), priceUnselectedText(false), priceUnselectedText()]
    expect(new Set(all).size, '3分岐のうち同じ文がある').toBe(3)
  })

  it('★★ プランを選んだあとは、この3分岐の文が出ない（金額か「料金表に無い」に変わる）', () => {
    const r = priceSummary(
      { path: 'cloud/apprun/dedicated/worker/1vcpu_2gb' },
      { path: 'cloud/apprun/dedicated/lb/1vcpu_2gb_1', nodeCount: 1 },
      1, 1, { plansFetched: true },
    )
    expect(r.totalYen).toBe(22000)
    expect(r.text).not.toContain('まだ出せません')
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

describe('⑤: priceSummary の第4引数 maxNodes（2026-09-10 レビューの修理・G）', () => {
  const worker = { path: 'cloud/apprun/dedicated/worker/1vcpu_2gb' } // 月11,000円
  const lb = { path: 'cloud/apprun/dedicated/lb/1vcpu_2gb_1', nodeCount: 1 } // 月11,000円

  it('maxNodes > minNodes なら、最小構成の額に加えて最大構成の額も出す', () => {
    const r = priceSummary(worker, lb, 1, 3)
    expect(r.text).toContain('月額 22,000円')
    expect(r.text).toContain('最小構成')
    expect(r.text).toContain('最大 3台')
    expect(r.text).toContain('月額 44,000円')
    // totalYen は最小構成の額のまま（既定の見積り・掟10: 計算を複製しない呼び出し側の前提と一致させる）。
    expect(r.totalYen).toBe(22000)
  })

  it('maxNodes === minNodes なら、従来どおり最小構成の額だけを出す（最大構成の文言は出さない）', () => {
    const r = priceSummary(worker, lb, 2, 2)
    expect(r.text).not.toContain('最小構成')
    expect(r.text).not.toContain('最大')
  })

  it('maxNodes を省略（3引数呼び出し）した既存の呼び出し元は、従来どおりの挙動のまま（後方互換）', () => {
    const r = priceSummary(worker, lb, 1)
    expect(r.text).not.toContain('最大')
    expect(r.totalYen).toBe(11000 + 11000)
  })

  it('料金表に無いプランを含むときは、maxNodes があっても「月額を出せません」のまま（推測で埋めない）', () => {
    const r = priceSummary({ path: 'cloud/apprun/dedicated/worker/16vcpu_64gb' }, lb, 1, 5)
    expect(r.text).toContain('月額を出せません')
    expect(r.totalYen).toBeNull()
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

// roadmap #28。実測（docs/apprun-dedicated-plan.md 5-9）どおりの3ゾーン
// （tk1a=20021001, tk1b=20021002, is1a=20031001。ただしこの3件も「Total=6件中、先頭3件」
// までしか実測できていない――probe-zones.mjs の初版が生JSONを4000字で切っていたため。5-9参照）
// に、**作り物**のダミー1件（tk1v=Sandbox）を足して4件でテストする。
// ⚠️ tk1v の行（isDummy:true・displayOrder:20021006）は実測ではない。実際の tk1v の
// IsDummy/DisplayOrder は未実測（IaaS APIドキュメントにゾーン名として載っているだけ）。
// ここでは「isDummy:true（≠false）を除く」動作を確かめるための値として使っている
// （2026-09-08 検分・事故の直し6: 「実測」表記を正直にする）。
// 並び順に依存しないことを固定するため、4要素の全24通りを総当たりする
// （#26 で使っている permutations をそのまま使う。CLAUDE.md の指示どおり）。
const REAL_ZONES_PLUS_DUMMY: { name: string; description: string | null; isDummy: boolean; displayOrder: number | null }[] = [
  { name: 'tk1a', description: '東京第1ゾーン', isDummy: false, displayOrder: 20021001 },
  { name: 'tk1b', description: '東京第2ゾーン', isDummy: false, displayOrder: 20021002 },
  { name: 'is1a', description: '石狩第1ゾーン', isDummy: false, displayOrder: 20031001 },
  { name: 'tk1v', description: 'Sandbox', isDummy: true, displayOrder: 20021006 },
]

describe('#28: selectableZones / defaultZone（GET /zone の一覧からゾーンを選ぶ）', () => {
  it('selectableZones: isDummy:true（tk1v/Sandbox）を除き、displayOrder昇順（tk1a→tk1b→is1a）に並べる', () => {
    const rows = selectableZones(REAL_ZONES_PLUS_DUMMY)
    expect(rows.map(r => r.name)).toEqual(['tk1a', 'tk1b', 'is1a'])
  })

  it('defaultZone: 実測の並びでは tk1a になる（displayOrderが最小）', () => {
    expect(defaultZone(REAL_ZONES_PLUS_DUMMY)).toBe('tk1a')
  })

  it('defaultZone: 選べるゾーンが無ければ null（isDummyのみ・空配列とも）', () => {
    expect(defaultZone([{ name: 'tk1v', description: 'Sandbox', isDummy: true, displayOrder: 1 }])).toBeNull()
    expect(defaultZone([])).toBeNull()
  })

  it('selectableZones/defaultZone とも、並び順を変えても結果は同じ（4要素・全24通りの順列で固定する）', () => {
    const perms = permutations(REAL_ZONES_PLUS_DUMMY)
    expect(perms.length).toBe(24)
    for (const perm of perms) {
      expect(selectableZones(perm).map(r => r.name)).toEqual(['tk1a', 'tk1b', 'is1a'])
      expect(defaultZone(perm)).toBe('tk1a')
    }
  })

  it('displayOrder が同値・両方nullなら name の辞書順で安定させる', () => {
    const tie = [
      { name: 'zeta', description: null, isDummy: false, displayOrder: null },
      { name: 'alpha', description: null, isDummy: false, displayOrder: null },
      { name: 'mid', description: null, isDummy: false, displayOrder: 5 },
    ]
    // displayOrder が数値のものが先、null は最後。null同士は name 昇順。
    expect(selectableZones(tie).map(r => r.name)).toEqual(['mid', 'alpha', 'zeta'])
  })

  it('ソースに tk1a / tk1b が既定として焼き込まれていない（一覧から決める。CLAUDE.md #28 の指示）', () => {
    const at = panel.indexOf('export function selectableZones')
    expect(at).toBeGreaterThan(0)
    const defEnd = panel.indexOf('\n}', panel.indexOf('export function defaultZone', at))
    expect(defEnd).toBeGreaterThan(at)
    const block = panel.slice(at, defEnd + 2)
    expect(block).not.toContain('tk1a')
    expect(block).not.toContain('tk1b')
  })

  it('⑤: 一覧が取れているあいだは <select>、取れない（zoneSelectable===false）ときは自由入力の <input> に戻る', () => {
    const at = panel.indexOf('{zoneSelectable ? (')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, at + 1400)
    expect(block).toContain('<select')
    expect(block).toContain('<input')
    expect(block).toContain('value={zone}')
    // 2026-09-11（判断7）: onChange は touch('zone') も呼ぶようになった（visibleFormErrors の
    // 「触った欄だけ出す」判定のため）。setZone を呼んでいること自体は変わっていない。
    expect(block).toContain("setZone(e.target.value); touch('zone')")
  })

  it('⑤: 一覧が取得できなかったとき、正直なメッセージ「ゾーン一覧を取得できませんでした。手で入力してください。」を出す', () => {
    expect(panel).toContain('ゾーン一覧を取得できませんでした。手で入力してください。')
  })

  it('⑤: 選べるときの注記が、新しい文言（未確認・失敗しても何も作られない）に差し替わっている', () => {
    expect(panel).toContain('専有型がすべてのゾーンに対応しているかは未確認')
    expect(panel).toContain('失敗しても、その時点では何も作られません')
    // 旧文言（原本に許容値の一覧が無いため自由入力です）はもう無い。
    expect(panel).not.toContain('原本に許容値の一覧が無いため自由入力です')
  })

  // 2026-09-08 Ryosuke さん依頼（起動時キャッシュの使い回し）で、investigate() は生の IPC を
  // 直接叩くのをやめ、zonesCache.ts の loadZones(true) 経由に変わった（tests/zonesCache.test.ts
  // が loadZones 自体の振る舞いを固定する）。
  it('③「調べる」は loadZones(true) を並列で呼び直し、結果を zones/zonesError に反映する', () => {
    const at = panel.indexOf('const investigate = async () => {')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, panel.indexOf('const doCreate = async', at))
    expect(block).toContain('loadZones(true)')
    expect(block).toContain('setZones(zonesRes.rows)')
    expect(block).toContain('setZonesError(zonesRes.message ?? \'\')')
    // 生の IPC を直接叩く旧実装はもう無い（zonesCache.ts に一元化）。
    expect(block).not.toContain('window.electronAPI.apprunDedicated.zones(auth)')
  })

  it('起動時のキャッシュを使い、③を押さなくても選べる（mount 時に loadZones() を呼ぶ）', () => {
    const at = panel.indexOf('useEffect(() => {\n    let alive = true\n    const myGen = genRef.current\n    loadZones().then(r => { if (alive && genRef.current === myGen && r.ok) setZones(r.rows) })')
    expect(at).toBeGreaterThan(0)
    // investigate() の定義より前（＝mount 時の別 effect）にあること。
    const investigateAt = panel.indexOf('const investigate = async () => {')
    expect(investigateAt).toBeGreaterThan(at)
  })

  // 2026-09-23 検分の指摘4: zones だけ世代の守りが無く、A→B→C とキーを続けて切り替えると
  // B のぶんの応答が C のあとに戻って⑤のゾーン選択が B の一覧のままになっていた。
  // mount 側（alive と併用）と credentials-changed 側の両方を固定する。
  it('④ zones: mount 時の取得は alive だけでなく世代（genRef）でも捨てる', () => {
    const at = panel.indexOf('let alive = true')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, at + 260)
    expect(block).toContain('const myGen = genRef.current')
    expect(block).toContain('genRef.current === myGen')
    // 直す前の形（世代を見ずに入れていた）へ戻っていないこと。
    expect(panel).not.toContain('loadZones().then(r => { if (alive && r.ok) setZones(r.rows) })')
  })

  it('④ zones: キー切替で捨てたあと入れ直す経路も世代（genRef）で守る', () => {
    // `setZones(null); setZonesError(null)` は investigate() にも出るので、
    // credentials-changed のハンドラ（genRef.current++ の側）を起点に取る。
    const hAt = panel.lastIndexOf('const h = () => {', panel.indexOf("window.addEventListener('sakura:credentials-changed', h)"))
    expect(hAt).toBeGreaterThan(0)
    const at = panel.indexOf('setZones(null); setZonesError(null)', hAt)
    expect(at).toBeGreaterThan(hAt)
    const block = panel.slice(at, at + 400)
    expect(block).toContain('const zonesGen = genRef.current')
    expect(block).toContain('loadZones().then(r => { if (genRef.current === zonesGen && r.ok) setZones(r.rows) })')
    // 直す前の形（無条件に setZones）が残っていないこと。
    expect(panel).not.toContain('loadZones().then(r => { if (r.ok) setZones(r.rows) })')
  })

  it("import: loadZones を zonesCache.ts から取り込んでいる（readZones の直接呼び出しは無い）", () => {
    expect(panel).toContain("import { loadZones } from '../zonesCache'")
    expect(panel).not.toContain('readZones(')
  })

  it('⑤: 表示は「name — description」の形（例: tk1b — 東京第2ゾーン）', () => {
    const at = panel.indexOf('{zoneRows.map(z => (')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, at + 200)
    expect(block).toContain('{z.name}{z.description ? ` — ${z.description}` : \'\'}')
  })

  // 事故の直し4（2026-09-08 検分で発見）: 直す前は「一度選んだら上書きしない」ガードが
  // selectedZoneName の有無だけを見ており、③を押し直して一覧が変わっても選択中の名前が
  // 残っていた。option に無いので <select> は空欄に見えるのに送信値（selectedZoneName）は
  // 古い名前のまま――というずれが起きる。いまは「選択中の名前が新しい一覧に無ければ
  // defaultZone() に戻す」形にしてある。
  it('既定は defaultZone() から作り、選択中の名前が新しい一覧に「まだあれば」上書きしない（無くなれば戻す）', () => {
    const at = panel.indexOf('useEffect(() => {\n    const rows = selectableZones(zones ?? [])')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, at + 400)
    expect(block).toContain('if (selectedZoneName && rows.some(r => r.name === selectedZoneName)) return')
    expect(block).toContain('setSelectedZoneName(defaultZone(zones ?? []))')
  })
})

// 事故の直し1（2026-09-08 検分で発見）の再現テスト。CLAUDE.md 依頼文に載っている、
// 親が実際に呼んで確認したケースそのもの:
//   readZones({Zones:[{Name:'tk1a',IsDummy:false,DisplayOrder:20021001},
//                     {Name:'sandbox',IsDummy:'true',DisplayOrder:1}]})
//     → 直す前: selectable=['sandbox','tk1a'] / default='sandbox'
//     → 直した後: selectable=['tk1a'] / default='tk1a'
// （sandbox の IsDummy が文字列 'true' で返ってきた場合。boolean ではないので readZones は
// isDummy:null にし、selectableZones は isDummy===false だけを残すので sandbox は入らない）。
describe('事故の直し1: IsDummy が boolean でない行は「本物」に倒さず、selectableZones から除く', () => {
  it("readZones→selectableZones→defaultZone を通しで: IsDummy:'true' の sandbox は isDummy:null になり除かれる。['tk1a'] / 'tk1a'", () => {
    const rows = readZones({
      Zones: [
        { Name: 'tk1a', IsDummy: false, DisplayOrder: 20021001 },
        { Name: 'sandbox', IsDummy: 'true', DisplayOrder: 1 },
      ],
    })
    expect(rows.map(r => ({ name: r.name, isDummy: r.isDummy }))).toEqual([
      { name: 'tk1a', isDummy: false },
      { name: 'sandbox', isDummy: null },
    ])
    expect(selectableZones(rows).map(r => r.name)).toEqual(['tk1a'])
    expect(defaultZone(rows)).toBe('tk1a')
  })

  it('selectableZones: isDummy===null（分からない）も true と同じく除く。false だけが残る', () => {
    const rows = [
      { name: 'a', description: null, isDummy: false, displayOrder: 1 },
      { name: 'b', description: null, isDummy: true, displayOrder: 2 },
      { name: 'c', description: null, isDummy: null, displayOrder: 3 },
    ]
    expect(selectableZones(rows).map(r => r.name)).toEqual(['a'])
    expect(defaultZone(rows)).toBe('a')
  })
})

// 事故の直し2（2026-09-08 検分で発見）。zones===null（未実施）／取得失敗／取得できたが0件、
// の3つを画面文言で区別する。直す前は zonesError の有無しか見ておらず、③を押した後でも
// 「押すと選べます」という嘘の文言が出ていた。
describe('事故の直し2: ゾーン欄の3分岐（未実施／取得失敗／取得できたが0件）', () => {
  it('3つの文言がすべてソースにある', () => {
    expect(panel).toContain('自由入力です。③の「🔍 調べる」を押すと一覧から選べるようになります。')
    expect(panel).toContain('ゾーン一覧を取得できませんでした。手で入力してください。')
    expect(panel).toContain('一覧は取得できましたが、選べるゾーンがありませんでした。手で入力してください。')
  })

  it('分岐の条件が zones===null（未実施）→ zonesError（失敗）→ zoneSelectable（選べる）→ それ以外（0件）の順になっている', () => {
    const at = panel.indexOf('{zones === null && !zonesError ? (')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, panel.indexOf('</div>', at))
    // 出現順が「未実施」→「失敗」→「選べる」→「0件」になっていること（三項演算子の分岐順）。
    const iNone = block.indexOf('自由入力です。③の「🔍 調べる」')
    const iErr = block.indexOf('ゾーン一覧を取得できませんでした')
    const iOk = block.indexOf('さくらのクラウドのゾーン一覧から選びます')
    const iEmpty = block.indexOf('選べるゾーンがありませんでした')
    expect(iNone).toBeGreaterThan(-1)
    expect(iErr).toBeGreaterThan(iNone)
    expect(iOk).toBeGreaterThan(iErr)
    expect(iEmpty).toBeGreaterThan(iOk)
  })
})

// 事故の直し3（2026-09-08 検分で発見）。zones の IPC が reject すると、コードのコメントは
// 「⑤は自由入力に戻るだけ」と言っているのに、実装は Promise.all の巻き添えで limits/plans/
// clusters まで落ち、①が「通じませんでした」になっていた。
//
// 2026-09-08（同日）: 起動時キャッシュの導入で、zones の取得は zonesCache.ts の loadZones() に
// 一元化された。loadZones は内部で reject しない設計（tests/zonesCache.test.ts が固定）なので、
// investigate() 側に .catch() を書く必要が無くなった――**設計そのもので巻き添えを防ぐ**形に
// 変わったため、ここでは「loadZones の失敗が他の3本を落とさない」ことそのものを確かめる
// （.catch() という書き方の有無ではなく、実際に reject しないことを検証する）。
describe('事故の直し3: zones の失敗が limits/plans/clusters を巻き添えにしない', () => {
  it('investigate は loadZones(true) を Promise.all の中でそのまま await する（.catch は不要）', () => {
    const at = panel.indexOf('const investigate = async () => {')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, panel.indexOf('const doCreate = async', at))
    expect(block).toContain('loadZones(true)')
  })

  it('loadZones は失敗しても reject しない（Promise.all の巻き添えにならないことの実体）', async () => {
    const { loadZones, resetZonesCacheForTest } = await import('../src/renderer/zonesCache')
    resetZonesCacheForTest()
    ;(globalThis as any).window = {
      electronAPI: {
        cloud: { loadKey: async () => { throw new Error('boom') } },
        apprunDedicated: { zones: async () => ({ ok: false, message: 'boom' }) },
      },
    }
    await expect(Promise.all([Promise.resolve({ ok: true }), loadZones(true)])).resolves.toBeDefined()
    delete (globalThis as any).window
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

  // 委譲仕様 UX-E（判断8）: ①の説明文は AccessKeySection.tsx の1文
  // 「Koto が {serviceTitle} へ代わりにアクセスするための合言葉です。」に統一した
  // （旧: 共用型・専有型それぞれが別々の長い説明文を持っていた＝掟10違反）。
  // 専有型は serviceTitle="さくらのクラウド" を渡し、共用型と全く同じ部品・同じ文言を使う。
  it('説明文は AccessKeySection（共用型と全く同じ部品）が出す。旧来の専有型だけの長い説明文は複製していない', () => {
    expect(panel).not.toContain('さくらのクラウドのAPIキー（アクセストークン／トークンシークレット）は「認証情報」で登録・切替します。')
    const at = panel.indexOf('<AccessKeySection')
    expect(at).toBeGreaterThan(0)
    const end = panel.indexOf('</AccessKeySection>', at)
    const section = panel.slice(at, end)
    expect(section).toContain('serviceTitle="さくらのクラウド"')
    expect(section).toContain('keyLabel="APIキー"')
    // 専有型と共用型は同じキーを使う、という1文は専有型の①にだけ残す。
    expect(section).toContain('共用型と同じキーです。')
    expect(accessKeySection).toContain('Koto が {serviceTitle} へ代わりにアクセスするための合言葉です。')
  })

  it('この操作に使うキー（旧「この確認に使うキー」ではない）', () => {
    expect(panel).toContain('この操作に使うキー')
    expect(panel).not.toContain('この確認に使うキー')
  })

  // roadmap #35: ①「🔌 接続テスト」は共用型 cloud.testConnection と同じ「チェックリスト」の形
  // （apprunDedicated.testConnection）を呼ぶ。内訳（専有型API参照・請求参照）は main 側で組む。
  // UX-E（判断8）: 「🔌 接続テスト」ボタン自体は AccessKeySection.tsx が描く（①を一元化）。
  // ここでは (a) testConnection 自身が apprunDedicated.testConnection を呼ぶこと、
  // (b) パネルがそれを <AccessKeySection> の test.run として正しく渡していることを確かめる。
  it('apprunDedicated.testConnection を呼ぶ（GETのみ・何も作らない）testConnection を、<AccessKeySection> の test.run として渡している', () => {
    const at = panel.indexOf('const testConnection = async () => {')
    expect(at).toBeGreaterThan(0)
    const end = panel.indexOf('\n  }', at)
    expect(end).toBeGreaterThan(at)
    const block = panel.slice(at, end)
    expect(block).toContain('window.electronAPI.apprunDedicated.testConnection(auth)')

    const sectionAt = panel.indexOf('<AccessKeySection')
    const sectionEnd = panel.indexOf('</AccessKeySection>', sectionAt)
    expect(sectionAt).toBeGreaterThan(0)
    const section = panel.slice(sectionAt, sectionEnd)
    expect(section).toContain('run: testConnection,')
    expect(section).toContain('state: conn,')

    // 「🔌 接続テスト」ボタンの実体は AccessKeySection.tsx 側に1つだけある（複製していない）。
    expect(accessKeySection).toContain('>🔌 接続テスト</button>')
  })

  it('接続テストの状態は未実施(idle) / 確認中(testing) / OK(ok) / NG(ng) の4つ（共用型 AppRunPanel の conn/connMsg と同じ作法）', () => {
    expect(panel).toContain("useState<'idle' | 'testing' | 'ok' | 'ng'>('idle')")
  })

  it('チェックリスト（connChecks）を受け取り、ok/ngをその通りに conn へ反映する（roadmap #35）', () => {
    const at = panel.indexOf('const testConnection = async () => {')
    const end = panel.indexOf('\n  }', at)
    const block = panel.slice(at, end)
    expect(block).toContain('setConnChecks(r.checks)')
    expect(block).toContain("setConn(r.ok ? 'ok' : 'ng')")
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

    // 2026-09-08 検分でこのハンドラにゾーン一覧の取り直し（事故の直し6）が足された。
    // 呼び出しの形ごと見る（掟10）: h 本体の中に conn/connMsg のリセットが入っていること。
    const hAt = panel.indexOf('const h = () => {')
    expect(hAt).toBeGreaterThan(0)
    const hEnd = panel.indexOf('\n    }', hAt)
    expect(hEnd).toBeGreaterThan(hAt)
    const hBlock = panel.slice(hAt, hEnd)
    expect(hBlock).toContain('refreshKey(); refreshCloudKeys()')
    expect(hBlock).toContain("setConn('idle'); setConnMsg('')")
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

  // UX-E（判断8）: 専有型だけが持っていた「⚠️ このキーでは専有型APIに通じませんでした」＋
  // ErrorBlock という別仕立ての表示はやめ、共用型と同じ「全体エラーは test.message で出す」
  // 形に揃えた。connMsg は AccessKeySection の test.message にそのまま渡すだけでよい。
  it('NGのときの全体メッセージは、専有型だけの別文言ではなく AccessKeySection の test.message（connMsg）に一本化した', () => {
    expect(panel).not.toContain('このキーでは専有型APIに通じませんでした')
    expect(panel).not.toContain('<ErrorBlock msg={connMsg} />')
    const sectionAt = panel.indexOf('<AccessKeySection')
    const sectionEnd = panel.indexOf('</AccessKeySection>', sectionAt)
    expect(sectionAt).toBeGreaterThan(0)
    const section = panel.slice(sectionAt, sectionEnd)
    expect(section).toContain('message: connMsg,')
  })

  // roadmap #35 → UX-E: 「checksあり:すべて確認できました／checksなし:通じました」「全滅なら
  // すべての項目で・一部だけなら一部の権限が」という要約の判定は、共用型・専有型の両方が
  // 同じことを求めていたので AccessKeySection.tsx（ngSummary/okSummary 相当）に一元化した
  // （掟10）。ここでは判定式そのものを専有型パネルが複製していないことだけを確かめ、
  // 判定の中身（全滅/一部の言い分け）は tests/accessKeySection.test.ts が固定する。
  it('①の要約文言の判定（checksの有無・全滅かどうか）は AccessKeySection.tsx に一元化し、専有型パネルは複製していない', () => {
    expect(panel).not.toContain("'⚠️ すべての項目で確認できませんでした'")
    expect(panel).not.toContain("'✅ すべて確認できました'")
    expect(panel).not.toContain('!connChecks.api.ok && !connChecks.billing.ok')
    expect(accessKeySection).toContain('function ngSummary(')
    expect(accessKeySection).toContain('すべての項目で確認できませんでした')
    expect(accessKeySection).toContain('一部の権限が確認できませんでした')
  })

  it('③「🔍 調べる」（investigate）は、connChecks を null に戻すだけで、書き込みはしない（確認していないので）', () => {
    const at = panel.indexOf('const investigate = async () => {')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, panel.indexOf('const doCreate = async', at))
    // investigate() の中で connChecks への書き込みは setConnChecks(null) の1回だけ
    // （途中でチェックリストを作って書き込む処理を足していないこと）。
    const writes = [...block.matchAll(/setConnChecks\(([^)]*)\)/g)].map(m => m[1])
    expect(writes).toEqual(['null'])
  })

  // UX-E（判断8）: 「先に認証情報でAPIキーを登録してください」という単独の案内文は無くなった。
  // 未登録時は AccessKeySection が registered=false の大きな「🔑 認証情報を登録する」ボタンを
  // 出し、かつ「🔌 接続テスト」ボタン自体も自動で無効化する（disabled={... || !registered}）ため、
  // 同じ意味の案内を専有型パネル側にもう1つ持つ必要がなくなった（重複の解消）。
  it('未登録時の重複ヒントは無くなった。AccessKeySection 側が registered を渡されて自動で無効化する', () => {
    const sectionAt = panel.indexOf('<AccessKeySection')
    const sectionEnd = panel.indexOf('</AccessKeySection>', sectionAt)
    expect(sectionAt).toBeGreaterThan(0)
    const section = panel.slice(sectionAt, sectionEnd)
    expect(section).not.toContain('{!keyReady && (')
    expect(section).toContain('registered={keyReady}')
    expect(accessKeySection).toContain("disabled={test.state === 'testing' || !registered}")
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
    // 固定長の窓（旧 at + 700）は、②が「詳しい手順を見る」の <details> に入った分の
    // インデント増加（判断7・2026-09-11）で必要な内容の手前で切れてしまっていた。
    // 次の一意な目印（プリンシパル欄の注意書き）までを窓にする（掟10「固定長で切らない」）。
    const end = panel.indexOf('プリンシパル欄に「ロール名」を入れないでください', at)
    expect(end).toBeGreaterThan(at)
    const block = panel.slice(at, end)
    expect(block).toContain('IAMポリシー')
    expect(block).toContain('「プリンシパル」欄で、手順Aで作ったサービスプリンシパルを選ぶ')
    expect(block).toContain('「ロール」欄で「{ROLE_TEXT}」を選ぶ')
  })

  // 2026-09-07 Ryosuke さん指摘。以前ここは「実画面の4欄すべてを名指しする」ことを固定していたが、
  // **「リソース階層名」「リソース階層タイプ」は入力欄ではなく、選んだプロジェクトが表示されるだけの
  // 読み取り専用**だった。操作できないものを"確かめる"手順に立てるのは水増しでしかない。
  // 検分の「4欄を名指ししていない」という指摘を、**その欄が操作できるものかを確かめずに**
  // 受け入れたのが原因。手順は「利用者が実際に入力・選択するもの」だけにする。
  it('手順Bは、利用者が実際に操作するものだけを並べる（読み取り専用の欄を"確かめる"手順にしない）', () => {
    const at = panel.indexOf('手順B: そのサービスプリンシパルにロールを付ける')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, at + 900)
    // 操作するもの: プロジェクトの選択 → アクセス権の付与 → プリンシパル → ロール → 作成
    expect(block).toContain('画面右上で対象のプロジェクトを選ぶ')
    expect(block).toContain('「アクセス権の付与」を押す')
    expect(block).toContain('「プリンシパル」欄で、手順Aで作ったサービスプリンシパルを選ぶ')
    expect(block).toContain('「ロール」欄で「{ROLE_TEXT}」を選ぶ')
    expect(block).toContain('「作成」を押す')
    // 読み取り専用の欄を"確かめる"手順は、もう無い（水増しの再発防止）。
    expect(panel).not.toContain('「リソース階層名」に、対象のプロジェクトが入っていることを確かめる')
    expect(panel).not.toContain('「リソース階層タイプ」が「プロジェクト」になっていることを確かめる')
  })

  it('読み取り専用の欄については、手順ではなく注記で説明する（プロジェクト単位で付けるのが確実、も添える）', () => {
    expect(panel).toContain('選んだプロジェクトが表示されるだけの欄です')
    expect(panel).toContain('サービスプリンシパルにはプロジェクト単位で付けるのが確実')
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

  // UX-E（判断8）: ①の成功/失敗の要約は、投げ先（🔌 接続テスト／③調べる）に関わらず
  // investigate() が setConn/setConnMsg を書けば、AccessKeySection が conn（test.state）を
  // 見てそのまま出す。旧来の専有型だけの固定文言「✅ このキーで専有型APIに通じました」
  // 「⚠️ このキーでは専有型APIに通じませんでした」は、共用型と揃えるため無くなった
  // （AccessKeySection.tsx の okSummary/ngSummary 相当が代わりに出す。tests/accessKeySection.test.ts 参照）。
  it('①の成功/失敗は investigate() が書く conn/connMsg を、共用型と同じ AccessKeySection の要約表示に委ねる（専有型だけの固定文言は複製しない）', () => {
    expect(panel).not.toContain('このキーで専有型APIに通じました')
    expect(panel).not.toContain('このキーでは専有型APIに通じませんでした')
    const sectionAt = panel.indexOf('<AccessKeySection')
    const sectionEnd = panel.indexOf('</AccessKeySection>', sectionAt)
    const section = panel.slice(sectionAt, sectionEnd)
    expect(section).toContain('state: conn,')
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

describe('⑤: STAGE_LABEL / resourceIdLabel（2026-09-10 レビューの修理・D。英語のステージ名を画面に出さない・「未作成」と「作られたか未確認」を使い分ける）', () => {
  it('STAGE_LABEL は全ステージを日本語にする（英語のキー名そのものを画面に出さない）', () => {
    const expected: Record<CreateClusterFlowStage, string> = {
      consent: '確認',
      invalid: '入力の検証',
      existing: '既存の記録',
      record: '記録',
      limits: '上限の確認',
      'cluster-create': 'クラスタの作成',
      'cluster-verify': 'クラスタの実在確認',
      'asg-create': 'ASGの作成',
      'asg-verify': 'ASGの実在確認',
      'lb-create': 'ロードバランサの作成',
      'lb-verify': 'ロードバランサの実在確認',
      done: '完了',
    }
    expect(STAGE_LABEL).toEqual(expected)
  })

  it('resourceIdLabel: IDがあれば常にそのIDを返す', () => {
    expect(resourceIdLabel('cluster-x', 'clusterID', 'done')).toBe('cluster-x')
    expect(resourceIdLabel('cluster-x', 'clusterID', 'consent')).toBe('cluster-x')
  })

  it('resourceIdLabel: IDが無く、まだその資源の作成を試みていない段（stageがその資源の作成段より前）なら「（未作成）」', () => {
    expect(resourceIdLabel(null, 'clusterID', 'consent')).toBe('（未作成）')
    expect(resourceIdLabel(null, 'clusterID', 'existing')).toBe('（未作成）')
    expect(resourceIdLabel(null, 'clusterID', 'record')).toBe('（未作成）')
    expect(resourceIdLabel(null, 'clusterID', 'limits')).toBe('（未作成）')
    // ASG/LBは、まだクラスタ作成段にも達していなければ当然「（未作成）」。
    expect(resourceIdLabel(null, 'asgID', 'cluster-create')).toBe('（未作成）')
    expect(resourceIdLabel(null, 'loadBalancerID', 'asg-create')).toBe('（未作成）')
  })

  it('resourceIdLabel: IDが無く、その資源の作成を試みた段以降なら「（作られたか未確認）」（分からないものを「無い」と言い切らない）', () => {
    // POSTの応答が取れず、名前探しでも見つからなかった場合がこれに当たる（apprunDedicatedApply.ts D）。
    expect(resourceIdLabel(undefined, 'clusterID', 'cluster-create')).toBe('（作られたか未確認）')
    expect(resourceIdLabel(null, 'asgID', 'asg-create')).toBe('（作られたか未確認）')
    expect(resourceIdLabel(null, 'loadBalancerID', 'lb-create')).toBe('（作られたか未確認）')
    // M（2026-09-10 レビューの修理・バッチ3）: lb-verify は lb-create より後の段なので同様に扱う。
    expect(resourceIdLabel(null, 'loadBalancerID', 'lb-verify')).toBe('（作られたか未確認）')
  })

  it('画面の結果表示は STAGE_LABEL と resourceIdLabel を使い、英語ステージ名や旧来の`?? \'（未作成）\'`を直書きしていない', () => {
    const at = panel.indexOf('{shouldShowCreateResult(createResult, apprunState) && createResult && (')
    expect(at).toBeGreaterThan(0)
    const end = panel.indexOf('{/* ⑥ 作ったものを壊す（破棄）')
    expect(end).toBeGreaterThan(at)
    const block = panel.slice(at, end)
    expect(block).toContain('STAGE_LABEL[createResult.stage as CreateClusterFlowStage] ?? createResult.stage')
    expect(block).toContain("resourceIdLabel(createResult.clusterID, 'clusterID', createResult.stage as CreateClusterFlowStage)")
    expect(block).toContain("resourceIdLabel(createResult.asgID, 'asgID', createResult.stage as CreateClusterFlowStage)")
    expect(block).toContain("resourceIdLabel(createResult.loadBalancerID, 'loadBalancerID', createResult.stage as CreateClusterFlowStage)")
    // 直す前の形（未確認の可能性を無視して「未作成」と言い切る）が残っていないこと。
    expect(block).not.toContain('createResult.clusterID ?? ')
    expect(block).not.toContain('createResult.asgID ?? ')
    expect(block).not.toContain('createResult.loadBalancerID ?? ')
  })
})

describe('①③: testConnection/investigate の世代カウンタ（2026-09-10 レビューの修理・I。キー切替後に古い応答が戻る競合）', () => {
  it('genRef（useRef）を宣言し、selectKey と credentials-changed の両方で世代を進める', () => {
    expect(panel).toContain("import { useState, useEffect, useCallback, useRef } from 'react'")
    expect(panel).toContain('const genRef = useRef(0)')
    const selectKeyAt = panel.indexOf('const selectKey = async (id: string) => {')
    const selectKeyEnd = panel.indexOf('// ── ② サービスプリンシパル', selectKeyAt)
    expect(panel.slice(selectKeyAt, selectKeyEnd)).toContain('genRef.current++')

    const hAt = panel.lastIndexOf("const h = () => {", panel.indexOf("window.addEventListener('sakura:credentials-changed', h)"))
    const hEnd = panel.indexOf('}', hAt)
    expect(panel.slice(hAt, hEnd + 1)).toContain('genRef.current++')
  })

  it('testConnection: myGen を捕まえ、各awaitのあとで世代が進んでいたら抜ける（setConn等をしない）', () => {
    const at = panel.indexOf('const testConnection = async () => {')
    const end = panel.indexOf('const idFormat = resourceIdFormatOk')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, end)
    expect(block).toContain('const myGen = genRef.current')
    // loadKey の直後・testConnection API 呼び出しの直後・catch のそれぞれで世代を確認している。
    expect((block.match(/if \(genRef\.current !== myGen\) return/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })

  it('investigate: myGen を捕まえ、Promise.all の応答が返った直後に世代を確認してから setLimits 等へ反映する', () => {
    const at = panel.indexOf('const investigate = async () => {')
    const end = panel.indexOf('// ── ④ 費用の同意')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, end)
    expect(block).toContain('const myGen = genRef.current')
    const promiseAllEnd = block.indexOf('])', block.indexOf('await Promise.all(['))
    const guardAt = block.indexOf('if (genRef.current !== myGen) return', promiseAllEnd)
    const setLimitsAt = block.indexOf('if (limitsRes.ok) setLimits(')
    expect(guardAt).toBeGreaterThan(promiseAllEnd)
    expect(setLimitsAt).toBeGreaterThan(guardAt)
  })

  // 2026-09-23 検分の指摘3: ⑦だけ世代の守りが無く、キーA（ログ接続済み）で取得中に
  // キーB（未接続）へ切り替えると、Bの結果のあとにAの結果が戻って
  // 「繋がっています」が残った（キー切替ハンドラのコメントが否定している当のもの）。
  it('⑦ refreshTelemetry: myGen を捕まえ、loadKey と telemetryStatus の応答の直後に世代を確認する', () => {
    const at = panel.indexOf('const refreshTelemetry = useCallback(async () => {')
    const end = panel.indexOf('// consented は', at)
    expect(at).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(at)
    const block = panel.slice(at, end)
    expect(block).toContain('const myGen = genRef.current')
    // loadKey の直後・telemetryStatus の直後・catch の3か所。
    expect((block.match(/if \(genRef\.current !== myGen\) return/g) ?? []).length).toBeGreaterThanOrEqual(3)

    // 守りは「応答を反映する前」に置く（あとに置いても意味が無い）。
    const loadKeyAt = block.indexOf('await window.electronAPI.cloud.loadKey()')
    const statusAt = block.indexOf('await window.electronAPI.apprunDedicated.telemetryStatus(auth)')
    const setVariantsAt = block.indexOf('setTelemetryVariants(r.variants)')
    expect(block.indexOf('if (genRef.current !== myGen) return', loadKeyAt)).toBeLessThan(statusAt)
    expect(block.indexOf('if (genRef.current !== myGen) return', statusAt)).toBeLessThan(setVariantsAt)
  })

  it('⑦ refreshTelemetry: finally の setTelemetryLoading(false) は世代で止めない（切替後に「確認中…」で固まらせない）', () => {
    const at = panel.indexOf('const refreshTelemetry = useCallback(async () => {')
    const end = panel.indexOf('// consented は', at)
    const block = panel.slice(at, end)
    const finallyAt = block.indexOf('} finally {')
    expect(finallyAt).toBeGreaterThan(0)
    const finallyBlock = block.slice(finallyAt)
    expect(finallyBlock).toContain('setTelemetryLoading(false)')
    expect(finallyBlock).not.toContain('genRef.current !== myGen')
  })
})

// 2026-09-23 検分の指摘6: ⑧の記録の取り直しが、この画面自身の書き込みでも毎回走っていた。
// ②のリソースID欄は onBlur で毎回 saveMeta を呼ぶため、値を変えずに欄から抜けただけで
// ファイル書き込み → 'sakura-meta-changed' → refreshAppStatus → GET /clusters/{id} が1本飛び、
// ⑧「公開中: …」が触っていないのに一瞬消えて出し直されていた。
describe('②⑧: 自分の書き込みで無駄なクラウドGETを起こさない（2026-09-23 検分の指摘6）', () => {
  it('saveResourceId: 値が変わっていなければ saveMeta を呼ばない（保存済みの値を ref で覚える）', () => {
    expect(panel).toContain('const savedResourceIdRef = useRef(\'\')')
    const at = panel.indexOf('const saveResourceId = async (v: string) => {')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, panel.indexOf('// ── ③ プラン・制限', at))
    // 早期 return が saveMeta より前にあること（順序ごと固定する）。
    const guardAt = block.indexOf('if (v === savedResourceIdRef.current) return')
    const saveAt = block.indexOf('await saveMeta({ servicePrincipalId: v })')
    expect(guardAt).toBeGreaterThan(0)
    expect(saveAt).toBeGreaterThan(guardAt)
    // 直す前の形（無条件に書く1行）へ戻っていないこと。
    expect(panel).not.toContain('const saveResourceId = async (v: string) => { await saveMeta({ servicePrincipalId: v }) }')
  })

  it('初期化: ディスクから読んだリソースIDを savedResourceIdRef に入れる（開いた直後の空振り保存を防ぐ）', () => {
    const at = panel.indexOf('const savedId = ')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, at + 260)
    expect(block).toContain('setResourceId(savedId)')
    expect(block).toContain('savedResourceIdRef.current = savedId')
  })

  it('⑥破棄: 取り直しは await する側に寄せ、その間は sakura-meta-changed の購読を黙らせる', () => {
    expect(panel).toContain('const selfMetaRefreshRef = useRef(false)')
    // 購読側: 破棄の最中は何もしない（この守りが無いと GET が二重に飛ぶ）。
    const onMetaAt = panel.indexOf('const onMetaChanged = () => {')
    expect(onMetaAt).toBeGreaterThan(0)
    const onMetaBlock = panel.slice(onMetaAt, panel.indexOf('}', panel.indexOf('refreshAppStatus()', onMetaAt)))
    expect(onMetaBlock).toContain('if (selfMetaRefreshRef.current) return')
    // 直す前の形（無条件に2つ走らせる1行）へ戻っていないこと。
    expect(panel).not.toContain('const onMetaChanged = () => { refreshApprunState(); refreshAppStatus() }')

    // 破棄側: clearPublishRecord と明示の取り直しを、印を立てている間に閉じ込める。
    const flagAt = panel.indexOf('selfMetaRefreshRef.current = true')
    expect(flagAt).toBeGreaterThan(0)
    const teardownBlock = panel.slice(flagAt, panel.indexOf('selfMetaRefreshRef.current = false', flagAt))
    expect(teardownBlock).toContain("clearPublishRecord(projectDir, 'sakura-apprun-dedicated')")
    expect(teardownBlock).toContain('await refreshApprunState()')
    expect(teardownBlock).toContain('await refreshAppStatus()')
  })
})

describe('#28→D-4: 説明文が現状（クラスタの作成・破棄と、アプリの公開＝独自ドメインまでできる）に合っている', () => {
  it('AppRunDedicatedPanel: 「作成は行わず」「まだできません」のような、できないと読める文言が残っていない', () => {
    expect(panel).not.toContain('作成は行わず')
    expect(panel).not.toContain('作成はまだできません')
    // D-4（2026-09-15）: 旧「クラスタの作成・破棄までは行えます」（＝公開はまだ、の含み）は⑧の実装で差し替えた。
    expect(panel).not.toContain('クラスタの作成・破棄までは行えます')
    expect(panel).toContain('アプリケーションの公開（⑧・独自ドメインが必要）まで行えます')
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

describe('⑥: 記録があるとき、または破棄結果が残っているときに表示し、破棄は確認ダイアログを通る（B-2・2026-09-10実機修理）', () => {
  it('⑥のsectionは hasAnyResource か shouldShowTeardownResult(teardownResult) のどちらかがあれば描く（記録が空になっても破棄結果だけは残せる）', () => {
    expect(panel).toContain('{(hasAnyResource || shouldShowTeardownResult(teardownResult)) && (')
    expect(panel).toContain('const hasAnyResource = !!(apprunState?.clusterID || apprunState?.asgID || apprunState?.loadBalancerID)')
  })

  it('破棄フォーム（警告文・対象一覧・「すべて削除する」ボタン）は hasAnyResource のときだけ描く', () => {
    const at = panel.indexOf('{(hasAnyResource || shouldShowTeardownResult(teardownResult)) && (')
    expect(at).toBeGreaterThan(0)
    const end = panel.indexOf('{shouldShowTeardownResult(teardownResult) && teardownResult && (', at)
    expect(end).toBeGreaterThan(at)
    const block = panel.slice(at, end)
    expect(block).toContain('{hasAnyResource && (')
    expect(block).toContain('すべて削除する')
  })

  it('#39: ⑥の実行中は進捗（teardown-progress）を「削除しています…」の下に出す', () => {
    const at = panel.indexOf("{tearingDown ? '削除しています…' : 'すべて削除する'}")
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, at + 300)
    expect(block).toContain('{tearingDown && teardownProgress && (')
    expect(block).toContain('{teardownProgress}')
  })

  it('#39: teardownResult.inProgress が立っているときは黄色い注意（赤い「残っています」とは別）を出し、⑥のボタンは押せるまま', () => {
    const at = panel.indexOf('{shouldShowTeardownResult(teardownResult) && teardownResult && (')
    expect(at).toBeGreaterThan(0)
    const end = panel.indexOf('</section>', at)
    const block = panel.slice(at, end)
    expect(block).toContain('teardownResult.inProgress ?')
    expect(block).toContain('削除中です。しばらくして⑥をもう一度押してください。')
    expect(block).toContain('border-brand-yellow')
    // B（2026-09-17）: アプリの行を先頭に足した（削除順＝アプリ→LB→ASG→クラスタに揃える）。
    expect(block).toContain('teardownResult.inProgress.applicationID')
    expect(block).toContain('teardownResult.inProgress.loadBalancerID')
    expect(block).toContain('teardownResult.inProgress.asgID')
    expect(block).toContain('teardownResult.inProgress.clusterID')
    // ボタンの disabled は tearingDown だけを見ており、inProgress では止めない（再開できる）。
    expect(panel).toContain('disabled={panelBusy({ creating, tearingDown, publishing, lbRefreshing })}')
  })

  it('doTeardown は確認文言を ConfirmModal（useConfirm）で先に確認し、その答えを runTeardown の confirm へ注入する（判断9・2026-09-11）', () => {
    const at = panel.indexOf('const doTeardown = async () => {')
    expect(at).toBeGreaterThan(0)
    // 終端は固定の文字数（旧 at + 1400）ではなく、次の節（⑧のコメント見出し）までにする。
    // D-4 で targets の先頭にアプリの行が増え、固定1400字では IPC 呼び出しの行が途中で切れた
    // （L264-266 の targetProfiles と同じ形の修理。doTeardown 全体を見るので弱めてはいない）。
    const end = panel.indexOf('// ── ⑧ アプリを公開する', at)
    expect(end).toBeGreaterThan(at)
    const block = panel.slice(at, end)
    expect(block).toContain('runTeardown(')
    expect(block).toContain("const ok = await confirm({ title: '⚠️ 専有型クラスタを破棄します', body: confirmMessage, confirmLabel: '破棄する', danger: true })")
    expect(block).toContain('confirm: () => ok,')
    // window.confirm へ退行していないこと（2026-09-11 CLAUDE.md 掟5改定）。
    expect(block).not.toContain('window.confirm(')
    // teardown実行そのもの（IPC呼び出し）は runTeardown の deps.teardown の中。
    expect(block).toContain('window.electronAPI.apprunDedicated.teardown(projectDir, auth, opts)')
    expect(block).toContain('消さない限り課金が続きます')
  })

  it('失敗が残ったら、残った資源のIDとコントロールパネルへの導線を出す', () => {
    expect(panel).toContain('残っています＝課金が続きます')
    // B（2026-09-17）: アプリの行を先頭に足した（削除順＝アプリ→LB→ASG→クラスタに揃える）。
    expect(panel).toContain('teardownResult.remaining.applicationID')
    expect(panel).toContain('teardownResult.remaining.loadBalancerID')
    expect(panel).toContain('teardownResult.remaining.asgID')
    expect(panel).toContain('teardownResult.remaining.clusterID')
  })

  // D-4f: ⑥「すべて削除する」で⑧の公開記録（applicationID）が残ったままだと、破棄そのものは
  // 成功しても 📡 公開したもの一覧に「存在しないアプリ」の幽霊が残っていた（main はこの経路の
  // 公開記録を消さない・上のD-4のIPCコメント参照）。doTeardown 自身が clearPublishRecord を
  // 呼んで消す（📡 一覧・HanamiiPanel.doTeardown・AppRunPanel.doTeardown と同じ手）。
  it('doTeardown は破棄前の applicationID の有無を控え、破棄が ok ならそのときだけ clearPublishRecord(projectDir, \'sakura-apprun-dedicated\') を呼ぶ', () => {
    expect(panel).toContain("import { clearPublishRecord } from '../publishRecord'")
    const at = panel.indexOf('const doTeardown = async () => {')
    expect(at).toBeGreaterThan(0)
    const end = panel.indexOf('// ── ⑧ アプリを公開する', at)
    expect(end).toBeGreaterThan(at)
    const block = panel.slice(at, end)
    // 破棄前（confirm/await の前）に控える。破棄後は appRecord が更新されうるため。
    const hadAt = block.indexOf('const hadApplicationID = !!appRecord?.applicationID')
    expect(hadAt).toBeGreaterThan(0)
    const confirmAt = block.indexOf('const ok = await confirm(')
    expect(confirmAt).toBeGreaterThan(hadAt)
    // ok 後・hadApplicationID のときだけ呼ぶ（無条件でも、cancelled のときでもない）。
    const outcomeAt = block.indexOf('if (outcome.cancelled) return')
    expect(outcomeAt).toBeGreaterThan(confirmAt)
    const afterOutcome = block.slice(outcomeAt)
    expect(afterOutcome).toContain('if (outcome.result.ok && hadApplicationID) {')
    expect(afterOutcome).toContain("await clearPublishRecord(projectDir, 'sakura-apprun-dedicated')")
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

  it('teardownFlow は LB→ASG→クラスタ の順で呼ぶ（5-7の逆順。#39でattemptDeleteX関数に分割されたが順序は変わっていない）', () => {
    const flowAt = applyFile.indexOf('export async function teardownFlow')
    expect(flowAt).toBeGreaterThan(0)
    // teardownFlow の本体は attemptDeleteLoadBalancer → attemptDeleteAsg → attemptDeleteCluster の
    // 順で呼ぶ（#39: 各段は一覧から消えるまで待つ waitUntilGone を挟むため、実際の delete*(auth, …)
    // 呼び出しは各 attemptDeleteX 関数の中にある。下でそれぞれ確かめる）。
    const lbCallAt = applyFile.indexOf('attemptDeleteLoadBalancer(', flowAt)
    const asgCallAt = applyFile.indexOf('attemptDeleteAsg(', flowAt)
    const clusterCallAt = applyFile.indexOf('attemptDeleteCluster(', flowAt)
    expect(lbCallAt).toBeGreaterThan(flowAt)
    expect(asgCallAt).toBeGreaterThan(lbCallAt)
    expect(clusterCallAt).toBeGreaterThan(asgCallAt)

    // attemptDeleteLoadBalancer/Asg/Cluster 自体もこの順（LB→ASG→クラスタ）で定義されており、
    // それぞれが対応する delete*(auth, …) を実際に呼んでいる。
    const lbFnAt = applyFile.indexOf('async function attemptDeleteLoadBalancer')
    const asgFnAt = applyFile.indexOf('async function attemptDeleteAsg')
    const clusterFnAt = applyFile.indexOf('async function attemptDeleteCluster')
    expect(lbFnAt).toBeGreaterThan(0)
    expect(asgFnAt).toBeGreaterThan(lbFnAt)
    expect(clusterFnAt).toBeGreaterThan(asgFnAt)
    expect(flowAt).toBeGreaterThan(clusterFnAt) // teardownFlow 自体はこの3関数より後ろで定義されている
    expect(applyFile.slice(lbFnAt, asgFnAt)).toContain('deleteLoadBalancer(auth,')
    expect(applyFile.slice(asgFnAt, clusterFnAt)).toContain('deleteAsg(auth,')
    expect(applyFile.slice(clusterFnAt, flowAt)).toContain('deleteCluster(auth,')
  })
})

// ── D-4（2026-09-15）: ⑧「アプリを公開する」の配線 ──────────────────────────────────
// 歯止め（confirm が false なら publish を一度も呼ばない）そのものは tests/apprunDedicatedActions.test.ts の
// runPublishApp が固定する。ここは「画面が実際にそこを通っているか」を、ソースを読んで固定する（掟10）。
describe('⑧ アプリを公開する（D-4）: 節の位置・表示条件・確認→純関数ゲート→IPC の配線', () => {
  it('見出し「⑧ アプリを公開する」があり、⑦「ログ・メトリクス」の後ろ（番号は付け直さない）', () => {
    const at7 = panel.indexOf('<p className="text-sm font-semibold text-ink">⑦ ログ・メトリクス</p>')
    const at8 = panel.indexOf('<p className="text-sm font-semibold text-ink">⑧ アプリを公開する</p>')
    expect(at7).toBeGreaterThan(0)
    expect(at8).toBeGreaterThan(at7)
    // ⑦の見出しは動かしていない（既存の固定文字列がそのまま）。
    expect(panel).toContain('⑦ ログ・メトリクス')
  })

  it('節の表示条件は shouldShowPublishSection(apprunState)（apprunDedicatedActions.ts の純関数。画面で AND を複製しない）', () => {
    expect(panel).toContain("import { runPublishApp, shouldShowPublishSection } from '../apprunDedicatedActions'")
    expect(panel).toContain('{shouldShowPublishSection(apprunState) && (')
    // 既存の import 行（runCreate 等）はそのまま（別行で足した）。
    expect(panel).toContain("import { runCreate, runTeardown, shouldShowCreateResult, shouldShowTeardownResult } from '../apprunDedicatedActions'")
  })

  it('冒頭1文（自分のドメイン名で公開・DNS の A レコードの設定が要る〔IPが複数ならAレコードも複数〕）がある（D-4f）', () => {
    const at = panel.indexOf('⑧ アプリを公開する</p>')
    const block = panel.slice(at, at + 600)
    expect(block).toContain('自分のドメイン名')
    expect(block).toContain('公開のあと、DNS の A レコードの設定が要ります（ロードバランサの IP が複数なら A レコードも複数）')
  })

  it('envReady === false なら「公開の設定（env.json）がまだありません」＋「公開の設定を作る」（cloud.scaffoldEnv を呼ぶ）', () => {
    expect(panel).toContain('appStatus.envReady === false ?')
    expect(panel).toContain('公開の設定（env.json）がまだありません。')
    expect(panel).toContain("'公開の設定を作る'")
    const at = panel.indexOf('const doScaffoldEnv = async () => {')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, at + 500)
    expect(block).toContain('window.electronAPI.cloud.scaffoldEnv(projectDir, projName)')
    expect(block).toContain('if (r.ok) await refreshAppStatus()')
  })

  it('ホスト名は HOSTNAME_PATTERN（shared/apprunDedicatedApp.ts）で即時検査し、黙って小文字化しない', () => {
    expect(panel).toContain("import { APP_DEFAULTS, HOSTNAME_PATTERN } from '../../shared/apprunDedicatedApp'")
    expect(panel).toContain('const hostOk = HOSTNAME_PATTERN.test(hostTrimmed)')
    const at = panel.indexOf('const doPublish = async () => {')
    const end = panel.indexOf('// ── ⑦ ログ・メトリクス', at)
    expect(panel.slice(at, end)).not.toContain('toLowerCase()')
  })

  // F-1 A-2（2026-09-16）: 3状態（letsEncryptEmailFieldState・shared/apprunDedicatedApp.ts）に
  // 一元化した。false=必須で出す・null=任意で出す（確かめられなかっただけで公開を止めない）・
  // true=出さない。
  it('Let\'s Encrypt メール欄の出し分けは letsEncryptEmailFieldState（3状態）から。null でも欄は出すが必須にはしない', () => {
    expect(panel).toContain('const leEmailField = letsEncryptEmailFieldState(appStatus?.hasLetsEncryptEmail ?? null)')
    expect(panel).toContain('const showLeEmailField = leEmailField.show || leEmailConfirmedMissing')
    expect(panel).toContain('const needsLeEmail = leEmailField.required || leEmailConfirmedMissing')
    expect(panel).toContain('{showLeEmailField ? (')
    // ⑤の欄は削除済み（tests/apprunDedicatedFolding.test.ts が固定）。⑧のラベルは条件で必須/任意を出し分ける。
    expect(panel).toContain("Let&apos;s Encrypt のメールアドレス{needsLeEmail ? '（必須）' : '（任意）'}")
  })

  it('設定済み（hasLetsEncryptEmail === true）のときは欄を出さず、確認できた旨だけ出す（アドレスそのものは出せない）', () => {
    expect(panel).toContain('appStatus.hasLetsEncryptEmail === true && (')
    expect(panel).toContain('✅ Let&apos;s Encrypt のメールは設定済みです（アドレスそのものはここには表示できません）。')
  })

  it('⑧のメール欄の近くに、独自ドメインが要らないなら共用型で公開できる旨の案内がある（F-1 A-4）', () => {
    expect(panel).toContain('メールアドレスを入れたくない・独自ドメインが要らないときは、上のタブから「共用型」を選ぶと公開できます。さくらが用意する住所で、https も自動です。')
  })

  it('詳細設定（mCPU・メモリ・台数・ヘルスチェックのパス）は <details> に畳み、既定は APP_DEFAULTS。直下に1文', () => {
    const at = panel.indexOf('⑧ アプリを公開する</p>')
    const end = panel.indexOf('{confirmElement}', at)
    const block = panel.slice(at, end)
    expect(block).toContain('<details')
    expect(block).toContain('詳細設定（ふつうは変えなくてよい）')
    expect(block).toContain('既定のままで公開できます。1台構成でも更新できるよう、既定は小さめです。')
    expect(panel).toContain('useState<number>(APP_DEFAULTS.cpu)')
    expect(panel).toContain('useState<number>(APP_DEFAULTS.memory)')
    expect(panel).toContain('useState<number>(APP_DEFAULTS.fixedScale)')
    // ヘルスチェックのパスは空なら送らない（main が env.json の probePath を使う）。
    expect(panel).toContain("...(healthCheckPath.trim() ? { healthCheckPath: healthCheckPath.trim() } : {})")
  })

  it('ボタンの文言は publishButtonLabel（shared/publishLabels.ts）から取り、直書きしない', () => {
    // D-4f: 同じファイルから publishFailureHintText も足したため1行にまとまっている。
    expect(panel).toContain("import { publishButtonLabel, publishFailureHintText, dnsGuidanceLines } from '../../shared/publishLabels'")
    expect(panel).toContain("{publishing ? '公開しています…' : publishButtonLabel(appPublished)}")
    expect(panel).toContain('const appPublished = !!appRecord?.applicationID')
    expect(panel).not.toContain("'🚀 公開する'")
  })

  it('doPublish は ConfirmModal（useConfirm）で先に確認し、その答えを runPublishApp の confirm へ注入する（window.confirm 無し）', () => {
    const at = panel.indexOf('const doPublish = async () => {')
    expect(at).toBeGreaterThan(0)
    const end = panel.indexOf('// ── ⑦ ログ・メトリクス', at)
    expect(end).toBeGreaterThan(at)
    const block = panel.slice(at, end)
    expect(block).toContain("const ok = await confirm({ title: '専有型にアプリを公開します', body: confirmMessage, confirmLabel: '公開する', danger: false })")
    expect(block).toContain('runPublishApp(')
    expect(block).toContain('{ confirmMessage, input }')
    expect(block).toContain('confirm: () => ok,')
    expect(block).not.toContain('window.confirm(')
    // 確認文（ホスト名／イメージ→レジストリ→専有型／mCPU・メモリ・台数／DNS の A レコード）。
    expect(block).toContain('`ホスト名: ${input.host}`')
    expect(block).toContain('イメージを組み立ててレジストリへ反映してから、専有型に載せます')
    expect(block).toContain('`mCPU ${appCpu}・メモリ ${appMemory}MB・台数 ${appFixedScale}`')
    expect(block).toContain('公開のあと、DNS の A レコードをロードバランサの IP に向ける必要があります')
    // publish 実行そのもの（IPC）は runPublishApp の deps.publish の中。キーは方式B（使う瞬間に loadKey）。
    expect(block).toContain('const auth = await window.electronAPI.cloud.loadKey()')
    expect(block).toContain('window.electronAPI.apprunDedicated.publishApp(projectDir, auth, i, opts)')
    expect(block).toContain("beginActivity('専有型アプリの公開', { closeWarning: PUBLISH_CLOSE_WARNING })")
  })

  it('進捗は onPublishProgress を購読して1行出す（実行中だけ）', () => {
    expect(panel).toContain('window.electronAPI.apprunDedicated.onPublishProgress((msg) => setPublishProgress(msg))')
    expect(panel).toContain('{publishing && publishProgress && (')
  })

  it('成功時: URL（コピー）・DNS の A レコード用 IP（IP ごとにコピー／無ければ取得できなかった旨）・warnings', () => {
    const at = panel.indexOf('{publishResult && (')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, panel.indexOf('{confirmElement}', at))
    // D-7: 見出しは publishHeadline（純関数）から出す（下の「⑧の見出し」の項で固定する）。
    expect(block).toContain('publishHeadline(publishResult.verify).text')
    expect(block).toContain('<CopyButton text={publishResult.url} title="公開URLをコピー" />')
    expect(block).toContain('DNS の A レコードをこの IP に向けてください:')
    expect(block).toContain('<CopyButton text={ip} title="IPをコピー" />')
    expect(block).toContain('IP を取得できませんでした。コントロールパネルのロードバランサで確認してください。')
    expect(block).toContain('publishResult.warnings.map(')
  })

  // ── D-7（2026-09-16 実機・0.6.19-rc.1）: 「公開しました」と言う前に、応答を確かめる ──────
  //
  // 実機では、公開の手続きが全段通ったのに、ロードバランサが 503 `no available server` を
  // 返し続けていた（＝LB から見て健全なバックエンドが1つも登録されていない。コンテナ自体が
  // 起動していたかは未確認＝docs/apprun-dedicated-plan.md 5-13）。それでも画面は
  // 「✅ 公開しました」と出していた。
  // 見出しの判断は純関数 publishHeadline（src/shared/publishLabels.ts）に置き、画面は描くだけ（掟10）。

  it('⑧の見出しは publishHeadline(publishResult.verify) から出し、「公開しました」を直書きしない', () => {
    expect(panel).toContain("import { publishHeadline } from '../../shared/publishLabels'")
    const at = panel.indexOf('{publishResult && (')
    const block = panel.slice(at, panel.indexOf('{confirmElement}', at))
    expect(block).toContain('publishHeadline(publishResult.verify).text')
    expect(block).toContain("publishHeadline(publishResult.verify).tone === 'ok' ? 'text-xs font-semibold text-brand-green' : 'text-xs font-semibold text-brand-red'")
    // 直す前の形（成功なら無条件に「✅ 公開しました」）に戻っていないこと
    expect(block).not.toContain("'✅ 公開しました'")
    expect(panel).not.toContain('公開しました</')
  })

  it('⑧は確かめた結果の一文を dedicatedVerifyMessage（shared/publishVerify.ts）から添える（文言を直書きしない）', () => {
    expect(panel).toContain("import { dedicatedVerifyMessage, dedicatedVerifyNotServing } from '../../shared/publishVerify'")
    const at = panel.indexOf('{publishResult && (')
    const block = panel.slice(at, panel.indexOf('{confirmElement}', at))
    expect(block).toContain('{publishResult.verify && (')
    expect(block).toContain('{dedicatedVerifyMessage(publishResult.verify)}')
    // D-19b（検分）: 赤で目立たせる結果（503・失敗応答）の線引きは純関数に置き、画面は描くだけ（掟10）。
    // ここで結果の名前を直に比べる形に戻すと、新しい結果が増えたときに画面だけ取り残される。
    expect(block).toContain("dedicatedVerifyNotServing(publishResult.verify) ? 'text-xs text-brand-red leading-relaxed select-text'")
    expect(block).not.toContain("publishResult.verify === 'no-backend' ? 'text-xs text-brand-red")
    expect(block).not.toContain('アプリがまだ応答していません')
    expect(block).not.toContain('ランタイムログ')
  })

  // ── D-13 G（2026-09-16）: 応答しないときに、コントロールパネルへの入口を置く ─────────
  // 上の一文は「コントロールパネルの『アプリケーション → ランタイムログ』を見てください」と
  // 案内するのに、**その場にリンクが無かった**。直し方のある失敗を、直し方の分からない失敗として
  // 見せない（回復の導線は全経路に出す・2026-08-14 の教訓）。⑥の「残っています」と同じ形・
  // 同じ定数を使う（リンク先を2か所に書かない・掟10）。
  // D-19b（検分・2026-09-16）: 出す条件は「503 のときだけ」から
  // 「利用者から見て公開先が開けないとき」（dedicatedVerifyNotServing＝503・失敗応答）へ広げた。
  it('★★ ⑧の公開結果で公開先が開けないとき、⑥と同じ「🔧 コントロールパネルを開く」を出す', () => {
    const at = panel.indexOf('{publishResult && (')
    const block = panel.slice(at, panel.indexOf('{confirmElement}', at))
    expect(block).toContain('{dedicatedVerifyNotServing(publishResult.verify) && (')
    expect(block).not.toContain("{publishResult.verify === 'no-backend' && (")
    expect(block).toContain('<a href={CONTROL_PANEL_URL} className="inline-block text-[11px] text-sakura hover:underline">🔧 コントロールパネルを開く</a>')
    // URL は定数から（直書きしていないこと）
    expect(block).not.toContain('https://secure.sakura.ad.jp/cloud/')
  })

  it('main の IPC は verify 段の材料（buildTag・runtimeKind）を publishAppFlow へ渡す（渡し忘れると確認が黙ってとぶ）', () => {
    const at = ipc.indexOf('const result = await publishAppFlow(')
    expect(at).toBeGreaterThan(0)
    const block = ipc.slice(at, ipc.indexOf('}, { confirmed: isConfirmed(opts), progress })', at))
    expect(block).toContain('buildTag: img.tag,')
    expect(block).toContain('runtimeKind: img.runtimeKind,')
  })

  it('global.d.ts の publishApp の戻り値に verify が載っている（掟6の3点セット）', () => {
    expect(globalDts).toContain("verify?: import('../shared/publishVerify').DedicatedVerifyOutcome")
  })

  // D-4h（2026-09-16 実機で判明）: IP を直接開くと LB が 404 を返す・https は数分後、の案内。
  // 「公開中」の常時表示と、公開結果の2か所とも dnsGuidanceLines（shared/publishLabels.ts）から
  // 出し、404 の文言を JSX に直書きしない（掟10）ことをここで固定する。
  it('公開結果の IP 案内の下は dnsGuidanceLines(hostTrimmed) から出し、404 の文言を直書きしない', () => {
    expect(panel).toContain("import { publishButtonLabel, publishFailureHintText, dnsGuidanceLines } from '../../shared/publishLabels'")
    const at = panel.indexOf('{publishResult && (')
    const block = panel.slice(at, panel.indexOf('{confirmElement}', at))
    expect(block).toContain('{dnsGuidanceLines(hostTrimmed).map((line, i) => (')
    expect(block).not.toContain('404 page not found')
    expect(block).not.toContain('向けたあと数分で https で開けるようになります')
  })

  it('「公開中: …」の下の IP 表示にも dnsGuidanceLines(appRecord.hosts?.[0] …) を出し、404 の文言を直書きしない', () => {
    const at = panel.indexOf('appRecord?.applicationID && (')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, at + 1800)
    expect(block).toContain("{dnsGuidanceLines(appRecord.hosts?.[0] ?? '（ホスト名不明）').map((line, i) => (")
    expect(block).not.toContain('404 page not found')
  })

  // ── D-7b・C（検分の指摘・2026-09-16 実害「応答しないアプリのために DNS を設定しに行った」）──
  // no-backend（503）のときは、DNS の案内（IP・コピー・dnsGuidanceLines）より先に応答を確かめて
  // もらう。次の一手を1つに絞るため、DNS の案内は <details>（閉じた状態）に畳む。
  // 判断は純関数 showDnsGuidanceExpanded（shared/publishLabels.ts）に置き、画面は描くだけ（掟10）。
  it('C: no-backend のとき、DNS の案内は showDnsGuidanceExpanded(publishResult.verify) で <details> に畳む', () => {
    expect(panel).toContain("import { showDnsGuidanceExpanded } from '../../shared/publishLabels'")
    const at = panel.indexOf('{publishResult && (')
    const block = panel.slice(at, panel.indexOf('{confirmElement}', at))
    expect(block).toContain('showDnsGuidanceExpanded(publishResult.verify)')
    expect(block).toContain('アプリが応答したら、DNS の設定に進みます')
    expect(block).toContain('<details')
    // DNS の案内そのもの（見出し・IP一覧・dnsGuidanceLines）は開閉どちらの分岐でも同じ内容
    // （複製せず dnsBlock を共有する）。折りたたみに使う <details> の外にも中にも文言を
    // 直書きし直していないこと（既存の「成功時: …」テストが個々の文言の存在は別途固定する）。
    expect(block).toContain('const dnsBlock = (')
  })

  it('showDnsGuidanceExpanded: no-backend のときだけ false（畳む）。それ以外・未確認は true（開いたまま）', async () => {
    const { showDnsGuidanceExpanded } = await import('../src/shared/publishLabels')
    expect(showDnsGuidanceExpanded('no-backend')).toBe(false)
    expect(showDnsGuidanceExpanded('ok')).toBe(true)
    expect(showDnsGuidanceExpanded('stale')).toBe(true)
    expect(showDnsGuidanceExpanded('unreachable')).toBe(true)
    expect(showDnsGuidanceExpanded(undefined)).toBe(true)
    expect(showDnsGuidanceExpanded(null)).toBe(true)
    // D-19b（検分）: 失敗応答（404・502・504 …）は見出しこそ警告に倒すが、ここは畳まない。
    // 専有型の LB はホスト名の振り分けが効かないと 404 を返す（2026-09-16 実機）ので、
    // 404 のときに次に読むべきものが、まさにこの DNS・ホスト名の案内である。
    expect(showDnsGuidanceExpanded('error-status')).toBe(true)
  })

  // ── D-8（2026-09-16 実機・ランタイムログ）: 応答していないときは「いまのコンテナの様子」も出す ──
  //
  // 実機のログ: `EACCES: permission denied, mkdir '/app/data'` で1分ごとに再起動を繰り返していた
  // （docs/apprun-dedicated-plan.md 5-13）。verify が no-backend のとき、Koto は「ランタイムログを
  // 見てください」としか言えなかった。**状態の文字列は原本の値のまま出す**（勝手に日本語へ言い換えない・
  // 掟1。全ての値を実測していない）。1行にする判断は純関数 containerStateSummary（shared/publishLabels.ts）。
  it('D-8: ⑧は containerStates があれば containerStateSummary( から1行出し、状態の文字列を直書きしない', () => {
    expect(panel).toContain("import { containerStateSummary, ephemeralDataNote } from '../../shared/publishLabels'")
    const at = panel.indexOf('{publishResult && (')
    const block = panel.slice(at, panel.indexOf('{confirmElement}', at))
    expect(block).toContain('{publishResult.containerStates && (')
    expect(block).toContain('{containerStateSummary(publishResult.containerStates)}')
    // 状態の文字列・まとめ文を画面に直書きしていないこと（純関数の外に文言が漏れると片方だけ直る）
    expect(block).not.toContain('いまのコンテナの様子')
    expect(block).not.toContain('コンテナが1つも動いていません')
    expect(block).not.toContain('CrashLoopBackOff')
    expect(block).not.toContain('running')
  })

  it('D-8: ⑧の説明に ephemeralDataNote()（書いたデータは公開し直すと消える）を出し、文言を直書きしない', () => {
    const at = panel.indexOf('⑧ アプリを公開する</p>')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, at + 1500)
    expect(block).toContain('{ephemeralDataNote()}')
    expect(panel).not.toContain('公開し直すと消えます')
  })

  it('D-8: global.d.ts の publishApp の戻り値に containerStates が載っている（掟6の3点セット）', () => {
    expect(globalDts).toContain('containerStates?: { state: string; status: string }[]')
  })

  // 引くのは no-backend のときだけ（ok のときに引くと余計な GET が増える）。**振る舞いの検査は
  // tests/apprunDedicatedAppApply.test.ts の 16**（偽サーバに流して要求の一覧を見る）。ここは
  // 「GET だけ・引けなくても止めない」という形をソースで固定する。
  it('D-8: main は listApplicationContainers を verify が no-backend のときだけ呼び、失敗しても warnings で続ける', () => {
    const flow = readFileSync(join(__dirname, '..', 'src/main/cloud/apprunDedicatedAppApply.ts'), 'utf-8')
    const at = flow.indexOf("if (verify === 'no-backend') {")
    expect(at).toBeGreaterThan(0)
    const block = flow.slice(at, at + 1600)
    expect(block).toContain('await listApplicationContainers(auth, appID, baseUrl)')
    expect(block).toContain('const states = readContainerStates(containersRes.data)')
    expect(block).toContain('コンテナの様子を取得できませんでした')
    // 検分の指摘: 200 でも読めなかった（null）ときは containerStates を付けない＝0件に倒さない。
    // **振る舞いの検査は tests/apprunDedicatedAppApply.test.ts の 16-(e)**（偽サーバに
    // 原本と違う形を返させて containerStates が付かないことを見る）。ここは形だけ固定する。
    expect(block).toContain('if (states) {')
    expect(block).toContain('応答の形が原本と違うため読み取れませんでした')
    // 取得の失敗で公開そのものを止めない（fail( を呼ばない）
    expect(block).not.toContain("return fail('")
  })

  it('失敗時: PUBLISH_STAGE_LABEL の段の日本語＋message＋detail（ErrorBlock）＋「🤖 AIに相談する」（detail も渡す・成功時には出さない）', () => {
    const at = panel.indexOf('{publishResult && (')
    const block = panel.slice(at, panel.indexOf('{confirmElement}', at))
    expect(block).toContain('PUBLISH_STAGE_LABEL[publishResult.stage as PublishAppStage] ?? publishResult.stage')
    expect(block).toContain('<ErrorBlock msg={publishResult.message} />')
    expect(block).toContain('{publishResult.detail && <ErrorBlock msg={publishResult.detail} />}')
    expect(block).toContain("askAiAboutFailure('公開', 'さくらのAppRun（専有型）', publishResult.message ?? '失敗しました', publishResult.detail)")
    // 成功時には出さない: 🤖 ボタンは publishResult.ok ? (...) : (...) の失敗側にだけある。
    const okAt = block.indexOf('{publishResult.ok ? (')
    const aiAt = block.indexOf('🤖 AIに相談する', okAt)
    const elseAt = block.indexOf(') : (', okAt)
    expect(okAt).toBeGreaterThan(0)
    expect(elseAt).toBeGreaterThan(okAt)
    expect(aiAt).toBeGreaterThan(elseAt)
  })

  // D-4f: hint:'reset-registry'（main の imagePublish.ts が付ける「レジストリの接続情報が古い」の印）。
  // 専有型パネルには共用型のような「↻ レジストリを設定し直す」ボタン自体が無いため、判断を
  // publishFailureHintText（純関数・src/shared/publishLabels.ts）に一元化し、共用型タブへ誘導する
  // 案内文だけを出す（ボタンは複製しない）。純関数自体の値は tests/publishLabels.test.ts が固定する。
  it('失敗時: hint:\'reset-registry\' は publishFailureHintText（shared/publishLabels.ts）の案内文を出す', () => {
    expect(panel).toContain("import { publishButtonLabel, publishFailureHintText, dnsGuidanceLines } from '../../shared/publishLabels'")
    const at = panel.indexOf('{publishResult && (')
    const block = panel.slice(at, panel.indexOf('{confirmElement}', at))
    expect(block).toContain('{publishFailureHintText(publishResult.hint) && (')
    expect(block).toContain('{publishFailureHintText(publishResult.hint)}')
  })

  it('PUBLISH_STAGE_LABEL は全段を日本語にする（main の PublishAppStage＋IPC の image。英語のキー名を画面に出さない）', () => {
    const expected: Record<PublishAppStage, string> = {
      consent: '確認',
      'no-cluster': 'クラスタの記録',
      invalid: '入力の検証',
      record: '記録',
      'lets-encrypt': 'Let\'s Encrypt メールの設定',
      'cluster-ports': 'クラスタの公開ポートの確認',
      'app-lookup': 'アプリケーションの検索',
      'name-taken': 'アプリケーション名の重複',
      'app-create': 'アプリケーションの作成',
      'version-create': 'バージョンの作成',
      activate: 'バージョンの有効化',
      cleanup: '古いバージョンの掃除',
      'lb-address': 'ロードバランサのIP取得',
      image: 'イメージの組み立てと反映',
      // 2026-09-23 検分の指摘12: 鍵を渡せずに止めたときを「入力の検証」と言わない
      storage: '保存場所の鍵の用意',
      done: '完了',
    }
    expect(PUBLISH_STAGE_LABEL).toEqual(expected)
    // ⑤専用の STAGE_LABEL を流用していない（別の Record）。
    expect(Object.keys(STAGE_LABEL)).not.toContain('image')
  })

  // 掟10（複製しない）: PublishAppStage は main（apprunDedicatedAppApply.ts）が唯一の定義。
  // global.d.ts はそれを import(...) 型でそのまま使い（renderer の tsconfig で解決できることを
  // 実測済み）、パネルは Window['electronAPI'] の型から導出する（文字列リテラル union の手書きを
  // どちらにも残さない）。
  it('PublishAppStage は main → global.d.ts → パネルの順で1本の型（手書きの文字列リテラル union を複製していない）', () => {
    expect(globalDts).toContain("stage: import('../main/cloud/apprunDedicatedAppApply').PublishAppStage")
    expect(globalDts).not.toContain("stage: 'consent' | 'no-cluster'")
    expect(panel).toContain(
      "export type PublishAppStage = Awaited<ReturnType<Window['electronAPI']['apprunDedicated']['publishApp']>>['stage']",
    )
    expect(panel).not.toContain("'consent' | 'no-cluster' | 'invalid' | 'record' | 'lets-encrypt'")
  })

  // 掟10: ApprunDedicatedRecord（.sakuraide.json の記録の形）も同じ理由で shared/publishMeta.ts が
  // 唯一の定義。global.d.ts はフィールドを手書きせず import(...) 型で使う。
  it('ApprunDedicatedRecordShape（global.d.ts）は shared/publishMeta.ts の ApprunDedicatedRecord を import(...) 型でそのまま使う（フィールドの手書き複製をしていない）', () => {
    expect(globalDts).toContain("type ApprunDedicatedRecordShape = import('../shared/publishMeta').ApprunDedicatedRecord")
    expect(globalDts).not.toContain('applicationID?: string | null\n  applicationName?: string | null')
  })

  it('記録に applicationID があれば節の頭に「公開中: https://host/（バージョン n・日時）」を出す（appStatus.record から）', () => {
    expect(panel).toContain('const appRecord = appStatus?.record ?? null')
    expect(panel).toContain('公開中: https://{appRecord.hosts?.[0]')
    expect(panel).toContain('バージョン {appRecord.activeVersion')
    expect(panel).toContain("new Date(appRecord.appPublishedAt).toLocaleString('ja-JP')")
  })

  it('appStatus は方式B（loadKey→引数）で取り、初期化・キー切替・sakura-meta-changed・⑤⑥⑧の後に取り直す', () => {
    const at = panel.indexOf('const refreshAppStatus = useCallback(async () => {')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, at + 900)
    expect(block).toContain('const auth = await window.electronAPI.cloud.loadKey()')
    expect(block).toContain('window.electronAPI.apprunDedicated.appStatus(projectDir, auth)')
    expect(block).toContain('const myGen = genRef.current')
    expect(panel).toContain('refreshKey(); refreshCloudKeys(); refreshApprunState(); refreshTelemetry(); refreshAppStatus()')
    expect(panel).toContain("window.addEventListener('sakura-meta-changed', onMetaChanged)")
    expect((panel.match(/await refreshAppStatus\(\)/g) ?? []).length).toBeGreaterThanOrEqual(4)
  })
})

describe('⑥（D-4）: 破棄の対象・要約にアプリの行を足す', () => {
  it('buildTeardownSummary: applicationID があれば末尾に「アプリ『name』（バージョン n）→ 先に削除」。無ければ行数は変わらない', () => {
    const base = {
      name: 'myapp', zone: 'tk1a',
      workerServiceClassPath: 'cloud/apprun/dedicated/worker/1vcpu_2gb',
      lbServiceClassPath: 'cloud/apprun/dedicated/lb/1vcpu_2gb_1',
      createdAt: '2026-09-10T12:00:00.000Z',
    }
    const without = buildTeardownSummary(base, null).lines
    expect(without.length).toBe(6)
    expect(without.some(l => l.startsWith('アプリ『'))).toBe(false)

    const withApp = buildTeardownSummary({ ...base, applicationID: 'app-1', applicationName: 'myapp', activeVersion: 3 }, null).lines
    expect(withApp.length).toBe(7)
    expect(withApp[6]).toBe('アプリ『myapp』（バージョン 3）→ 先に削除')
    expect(withApp.slice(0, 6)).toEqual(without)

    // 名前が無ければ ID、バージョンが無ければ「不明」（推測で埋めない）。
    expect(buildTeardownSummary({ applicationID: 'app-1' }, null).lines.at(-1)).toBe('アプリ『app-1』（バージョン 不明）→ 先に削除')
    // applicationID が null なら足さない。
    expect(buildTeardownSummary({ ...base, applicationID: null, applicationName: 'x' }, null).lines.length).toBe(6)
  })

  it('doTeardown の対象一覧と⑥の <ul> にアプリの行がある（先頭・main の teardownFlow と同じ順）', () => {
    const at = panel.indexOf('const doTeardown = async () => {')
    const block = panel.slice(at, at + 900)
    expect(block).toContain("appRecord?.applicationID ? `アプリ『${appRecord.applicationName ?? appRecord.applicationID}』` : null,")
    expect(panel).toContain("{appRecord?.applicationID && <li>アプリ『{appRecord.applicationName ?? appRecord.applicationID}』（バージョン {appRecord.activeVersion ?? '不明'}）</li>}")
    expect(panel).toContain('buildTeardownSummary(teardownSummaryRecord, { worker: workerPlans, lb: lbPlans })')
  })
})

describe('computePublishFormErrors（⑧の入力チェック・純関数）', () => {
  const ok = { host: 'app.example.com', needsEmail: false, email: '', cpu: 500, memory: 512, fixedScale: 1, healthCheckPath: '' }
  it('既定（APP_DEFAULTS）＋正しいホスト名ならエラー無し', () => {
    expect(computePublishFormErrors(ok)).toEqual([])
  })
  it('ホスト名: 空・大文字混じり・不正な文字はエラー（黙って小文字化しない）', () => {
    expect(computePublishFormErrors({ ...ok, host: '' })).toHaveLength(1)
    expect(computePublishFormErrors({ ...ok, host: 'App.Example.com' })).toHaveLength(1)
    expect(computePublishFormErrors({ ...ok, host: 'app_example.com' })).toHaveLength(1)
    expect(computePublishFormErrors({ ...ok, host: ' app.example.com ' })).toEqual([]) // 前後の空白は trim
  })
  it('needsEmail のときだけメール必須', () => {
    expect(computePublishFormErrors({ ...ok, needsEmail: true, email: '' })).toHaveLength(1)
    expect(computePublishFormErrors({ ...ok, needsEmail: true, email: 'you@example.com' })).toEqual([])
    expect(computePublishFormErrors({ ...ok, needsEmail: false, email: '' })).toEqual([])
  })
  // F-1 A-3（2026-09-16）: 必須でなくても、値を入れたなら isLikelyEmail（ゆるい判定）で形を確かめる。
  it('★ メールの形式: 値があれば必須/任意に関係なく isLikelyEmail で確かめる', () => {
    expect(computePublishFormErrors({ ...ok, needsEmail: false, email: 'not-an-email' })).toHaveLength(1)
    expect(computePublishFormErrors({ ...ok, needsEmail: true, email: 'not-an-email' })).toHaveLength(1)
    // ゆるい判定: 日本語ドメイン・長い TLD は弾かない
    expect(computePublishFormErrors({ ...ok, needsEmail: true, email: '例え@日本語ドメイン.jp' })).toEqual([])
    expect(computePublishFormErrors({ ...ok, needsEmail: true, email: 'you@example.technology' })).toEqual([])
  })
  it('cpu 100〜64000・memory 128〜131072・fixedScale 1〜50・整数（validateAppSpec と同じ範囲）', () => {
    expect(computePublishFormErrors({ ...ok, cpu: 99 })).toHaveLength(1)
    expect(computePublishFormErrors({ ...ok, cpu: 64001 })).toHaveLength(1)
    expect(computePublishFormErrors({ ...ok, cpu: 500.5 })).toHaveLength(1)
    expect(computePublishFormErrors({ ...ok, memory: 127 })).toHaveLength(1)
    expect(computePublishFormErrors({ ...ok, memory: 131073 })).toHaveLength(1)
    expect(computePublishFormErrors({ ...ok, fixedScale: 0 })).toHaveLength(1)
    expect(computePublishFormErrors({ ...ok, fixedScale: 51 })).toHaveLength(1)
    expect(computePublishFormErrors({ ...ok, cpu: 100, memory: 128, fixedScale: 50 })).toEqual([])
  })
  it('ヘルスチェックのパス: 空は可、非空なら / 始まり', () => {
    expect(computePublishFormErrors({ ...ok, healthCheckPath: 'health' })).toHaveLength(1)
    expect(computePublishFormErrors({ ...ok, healthCheckPath: '/health' })).toEqual([])
  })
  it('複数の欄が同時に不正なら、それぞれ独立して返す（1本の早期returnにしない）', () => {
    expect(computePublishFormErrors({ ...ok, host: '', cpu: 1, healthCheckPath: 'x' })).toHaveLength(3)
  })
})

// ── D-4（2026-09-15）: 📡 公開したもの一覧（PublishedListModal.tsx）の専有型の破棄 ─────────────
describe('📡 公開したもの一覧: sakura-apprun-dedicated の破棄は loadKey → apprunDedicated.teardownApp（アプリだけ消す口）', () => {
  const at = publishedListModal.indexOf("} else if (e.target === 'sakura-apprun-dedicated') {")
  const end = publishedListModal.indexOf("} else if (e.target === 'hanamii') {", at)
  const block = publishedListModal.slice(at, end)

  it('分岐は runTeardown の中にあり、hanamii の分岐より前', () => {
    expect(at).toBeGreaterThan(publishedListModal.indexOf('const runTeardown = async (e: PublishedEntry) => {'))
    expect(end).toBeGreaterThan(at)
  })

  it('方式B: cloud.loadKey() で読んだキーを引数で渡す。未登録なら「さくらのクラウドの API キーが未登録です」で止める', () => {
    expect(block).toContain('const auth = await window.electronAPI.cloud.loadKey()')
    expect(block).toContain('if (!auth || !auth.token || !auth.secret) {')
    expect(block).toContain('さくらのクラウドの API キーが未登録です。「認証情報」で登録してから、もう一度お試しください。')
  })

  it('呼ぶのは teardownApp（confirmed: true＝確認オーバーレイを通った印）。全部消す teardown・共用型 cloud.teardown には相乗りしない', () => {
    expect(block).toContain("window.electronAPI.apprunDedicated.teardownApp(e.dir, auth, { confirmed: true })")
    expect(block).not.toContain('apprunDedicated.teardown(')
    expect(block).not.toContain('cloud.teardown(')
    // 暫定の「まだ行えません」は無い。
    expect(publishedListModal).not.toContain('まだ行えません')
  })

  it('待ち切れず（inProgress）に止まったときは記録を消さず、🗑 の押し直しを案内する（main の「⑥をもう一度」は専有型タブ向けの文言）', () => {
    const ipAt = block.indexOf("if (!r.ok && 'inProgress' in r && r.inProgress) {")
    expect(ipAt).toBeGreaterThan(0)
    const ipBlock = block.slice(ipAt, block.indexOf('if (r.ok) {', ipAt))
    expect(ipBlock).toContain('もう一度 🗑 を押してください')
    expect(ipBlock).not.toContain('clearPublishRecord(')
    expect(ipBlock).toContain('return')
  })

  it('成功したら公開記録を消して（clearPublishRecord）一覧を読み直し、クラスタ・LB・イメージが残る（課金が続く）ことを添える', () => {
    expect(block).toContain('if (r.ok) {')
    expect(block).toContain('await clearPublishRecord(e.dir, e.target)')
    expect(block).toContain('クラスタ・ロードバランサと、コンテナレジストリのイメージは残っています（消すまで課金が続きます）')
    expect(block).toContain('await reload()')
  })

  it('確認文は teardownScopeNote（shared/teardownSupport.ts）のまま（専有型の文を複製していない）', () => {
    expect(publishedListModal).toContain('{teardownScopeNote(confirm.target)}')
    expect(publishedListModal).not.toContain('専有型のアプリ（全バージョン）を削除します。クラスタ・ロードバランサは専有型タブの⑥で')
  })
})

// ── D-5（2026-09-16 実測）: ⑧の「DNS の A レコードに向ける IP」を確実に出す ─────────────────────
// 実測: LB ノードのアドレスは `IP/24`（ネットマスク付き）で、付くまで数分かかる。公開直後に空のまま
// 終わっても、記録（appStatus.record.lbAddresses）から常時出し、無ければ「🔄 IP を取り直す」で
// main の apprunDedicated:lbAddresses（GET 1回＋記録）を呼んで表示を更新する。
describe('⑧ DNS の A レコードの IP（D-5）: 記録から常時表示・無ければ「🔄 IP を取り直す」', () => {
  /** ⑧の「公開中: …」ブロック（applicationID があるときだけ出る部分）。 */
  function publishedBlock(): string {
    const at = panel.indexOf('{appRecord?.applicationID && (')
    expect(at).toBeGreaterThan(0)
    const end = panel.indexOf('{!keyReady ? (', at)
    expect(end).toBeGreaterThan(at)
    return panel.slice(at, end)
  }

  it('★ 「公開中: …」の下に、記録の lbAddresses があれば「DNS の A レコード: <IP>（コピー）」を常時出す', () => {
    const block = publishedBlock()
    expect(block).toContain('公開中: https://{appRecord.hosts?.[0]')
    expect(block).toContain('{appRecord.lbAddresses && appRecord.lbAddresses.length > 0 ? (')
    expect(block).toContain('<span>DNS の A レコード:</span>')
    expect(block).toContain('{appRecord.lbAddresses.map(ip => (')
    expect(block).toContain('<span className="font-mono select-text">{ip}</span><CopyButton text={ip} title="IPをコピー" />')
  })

  it('★ 記録に lbAddresses が無ければ「IP がまだ取れていません」＋「🔄 IP を取り直す」ボタンを出す', () => {
    const block = publishedBlock()
    expect(block).toContain('IP がまだ取れていません（ロードバランサに IP が付くまで数分かかることがあります）。')
    expect(block).toContain('{lbRefreshButton}')
    // ボタンの定義（1つを2か所で使い回す）
    expect(panel).toContain('const lbRefreshButton = (')
    expect(panel).toContain("{lbRefreshing ? 'IP を取り直しています…' : '🔄 IP を取り直す'}")
    expect(panel).toContain('onClick={() => { void doRefreshLbAddresses() }}')
    expect((panel.match(/\{lbRefreshButton\}/g) ?? []).length).toBe(2)
  })

  it('★ 公開結果の「IP を取得できませんでした。…」の下にも同じボタンを出す', () => {
    const at = panel.indexOf('{publishResult && (')
    const block = panel.slice(at, panel.indexOf('{confirmElement}', at))
    const failAt = block.indexOf('IP を取得できませんでした。コントロールパネルのロードバランサで確認してください。')
    expect(failAt).toBeGreaterThan(0)
    const btnAt = block.indexOf('{lbRefreshButton}', failAt)
    expect(btnAt).toBeGreaterThan(failAt)
    expect(btnAt - failAt).toBeLessThan(300) // すぐ下（同じ分岐の中）
  })

  it('★ doRefreshLbAddresses は方式B（loadKey→引数）で apprunDedicated.lbAddresses(projectDir, auth) を呼び、成功なら appStatus を取り直して公開結果の IP 欄も差し替える', () => {
    const at = panel.indexOf('const doRefreshLbAddresses = async () => {')
    expect(at).toBeGreaterThan(0)
    const end = panel.indexOf('const lbRefreshButton = (', at)
    const block = panel.slice(at, end)
    expect(block).toContain('const auth = await window.electronAPI.cloud.loadKey()')
    expect(block).toContain('const r = await window.electronAPI.apprunDedicated.lbAddresses(projectDir, auth)')
    expect(block).toContain('if (!r.ok) { setLbRefreshError(r.message); return }')
    expect(block).toContain('setPublishResult(prev => (prev && prev.ok ? { ...prev, lbAddresses: r.lbAddresses } : prev))')
    expect(block).toContain('await refreshAppStatus()')
    // 何も作らない: 公開（publishApp）や作成（create）はこの関数から呼ばない
    expect(block).not.toContain('publishApp(')
    expect(block).not.toContain('.create(')
    // キーが無ければ①へ案内
    expect(block).toContain("setLbRefreshError('さくらのクラウドAPIキーが未登録です。①で登録してください。')")
  })

  it('失敗の文言（lbRefreshError）はボタンの横に select-text で出す', () => {
    const at = panel.indexOf('const lbRefreshButton = (')
    const block = panel.slice(at, at + 700)
    expect(block).toContain('{lbRefreshError && <span className="text-xs text-brand-yellow leading-relaxed select-text">{lbRefreshError}</span>}')
    expect(block).toContain('disabled={panelBusy({ creating, tearingDown, publishing, lbRefreshing })}')
  })
})

// ── D-7 の記録は「観測した事実」と「未確認の推測」を分ける（掟9・正直さ）───────────────
//
// 2026-09-16 の実機で**観測できたのは、ロードバランサが 503 `no available server` を返し続けた
// ことだけ**である。同じ日のコンパネは同じアプリを「稼働コンテナ 1・アクティブ」と表示しており、
// **コンテナが1つも動いていなかったかどうかは切り分けていない**（plan 5-13 も「未確認」と書いている）。
// にもかかわらず、計画書・CHANGELOG・コメントが「コンテナが1つも応答していなかった」と
// **観測事実のように**書いていた（検分の指摘）。推測を事実に倒した文はここで落とす。
//
// ※ここで見るのは「断定が復活していないこと」であって、文章の良し悪しではない。

describe('D-7 の記録: 未確認のことを、確かめた事実のように書かない（掟9）', () => {
  const planDoc = readFileSync(join(__dirname, '..', 'docs/apprun-dedicated-plan.md'), 'utf-8')
  const changelog = readFileSync(join(__dirname, '..', 'CHANGELOG.md'), 'utf-8')
  const verifyLib = readFileSync(join(__dirname, '..', 'src/shared/publishVerify.ts'), 'utf-8')
  const labelsLib = readFileSync(join(__dirname, '..', 'src/shared/publishLabels.ts'), 'utf-8')
  const appApply = readFileSync(join(__dirname, '..', 'src/main/cloud/apprunDedicatedAppApply.ts'), 'utf-8')

  it('★★ 計画書 5-13 は、503（観測）と「コンテナが起動していたかは未確認」を分けて書く', () => {
    const at = planDoc.indexOf('**公開は通ったのに、アプリが応答していなかった（2026-09-16 実機・D-7 で追加）**')
    expect(at).toBeGreaterThan(0)
    const block = planDoc.slice(at, planDoc.indexOf('**直したこと（D-7・同日）**', at))
    // 観測: LB の応答（503）だけが実測である
    expect(block).toContain('**観測した事実**')
    expect(block).toContain('503 `no available server`')
    expect(block).toContain('LB から見て健全なバックエンドが1つも登録されていなかった')
    // D-7 の時点で未確認だったこと（コンテナ自体の状態と、コンパネの「稼働コンテナ 1・アクティブ」
    // との食い違い）について、後日**別の時刻（10:34〜10:57）のランタイムログ**を見た。
    // ⚠️ 2026-09-16 の検分（high）: ここは当初「当時は未確認 → 後日判明」「同日のランタイムログで
    // **確定**」と書いていた。だが問いは「**503 を見た時点**（08:35 前後）でコンテナが起動していたか」
    // であり、時刻の違うログはその答えにならない。**同じ節が自分に課した基準（同時刻の突き合わせを
    // していないので断定しない）を、この行だけが破っていた**ので、未確認のままだと書く形に直した。
    expect(block).toContain('**未確認のまま**（後日、別の時刻のログは見た）')
    expect(block).toContain('503 を見た時点でコンテナが起動していたかどうか**は、いまも未確認')
    expect(block).toContain('稼働コンテナ 1・アクティブ')
    expect(block).toContain('1分ごとに再起動を繰り返していた')
    expect(block).toContain('説明がつく')
    expect(block).toContain('**断定はしない**')
    // 直す前の形（時刻の違うログで「確定」と答える）に戻っていないこと
    expect(block).not.toContain('**当時は未確認 → 後日判明**')
    expect(block).not.toContain('同日のランタイムログで確定')
    // 直す前の形（コンテナの状態を観測事実のように書く）に戻っていないこと
    expect(block).not.toContain('コンテナが1つも応答')
  })

  // D-8（2026-09-16・同日のランタイムログ）: 「原因は未確認」と書いていた箇所に、**説明のつく筋**を足した。
  // ⚠️ 検分（high・2026-09-16）: 見出しだけが「503 の原因が判明した」と断定し、直下の本文
  // （「断定はしない」）と矛盾していたので、見出しを事実（ログで再起動ループが分かった）へ直した。
  it('★★ 計画書 5-13 は、再起動ループ（/app/data を作れない）をログの全文つきで記録する（見出しで原因を断定しない）', () => {
    expect(planDoc, '見出しが断定に戻っている').not.toContain('**503 の原因が判明した')
    const at = planDoc.indexOf('**ランタイムログで再起動ループが分かった（2026-09-16・コントロールパネル・D-8）**')
    expect(at).toBeGreaterThan(0)
    const block = planDoc.slice(at, planDoc.indexOf('## 6. 手動が残る部分', at))
    // ログの全文（実機の文字列をそのまま）
    expect(block).toContain("EACCES: permission denied, mkdir '/app/data'")
    expect(block).toContain('at Object.mkdirSync (node:fs:1370:26)')
    expect(block).toContain("errno: -13, code: 'EACCES', syscall: 'mkdir', path: '/app/data'")
    expect(block).toContain('Node.js v22.23.2')
    // 原因（uid 951 と像の権限）と直し方（フォルダに書き込み）
    expect(block).toContain('uid 951:gid 951')
    // 2026-09-16 Ryosuke さんの問いで `0o777` → **`0o1777`**（スティッキービット）にした。
    // `0o777` に戻ると、像に最初から入っているファイルを消して置き換えられる状態で配られる。
    expect(block).toContain('`0o555` → **`0o1777`**')
    expect(block).toContain('スティッキービット')
    // 残る制限を正直に書いていること。⚠️ 検分（medium・2026-09-16）: ここは当初
    // 「**上書きも削除もできない**」だったが、当時**上書きはコードが止めていなかった**
    // （`addPermission` は足すだけで w を奪わないので、手元が `0o666` のファイルは書けた）。
    // D-13 A で**実装のほうを直した**ので、いまは両方書いてよい——ただし
    // **実際のさくらのサーバーでは確かめていない**ことを併記する（掟1）。
    expect(block).toContain('**削除する・消して置き換える**ことはできない')
    expect(block).toContain('**その場の上書きも、D-13 A で止めた**')
    expect(block).toContain('fileModeForImage')
    expect(block).toContain('(mode | 0o444) & ~0o022')
    // 直す前の形（足すだけ・読み取り専用のまま）に戻っていないこと
    expect(block).not.toContain('ファイルは読み取り専用のまま（`0o444`）')
    expect(block).not.toContain('手元が `0o666`/`0o777` のファイルは w を持ったまま像に入り、アプリから上書きできる')
    // 確かめていない範囲（所有者の w・chmod の失敗・コンテナ側の権限・実サーバー）を残していること。
    // ⚠️ 検分の指摘（medium・2026-09-16）: ここは「**残る穴は所有者の w だけ**」と**列挙を閉じて**
    // いたが、UNIX の権限で検算すると閉じていなかった——①`chmod` が失敗したファイルは元の mode の
    // まま入る（`setImageFileMode` は黙って続行する） ②コンテナに `CAP_DAC_OVERRIDE` のような権限が
    // 残っていれば mode は素通りする（**確かめていない**） ③そもそも `node_modules` は copyTree を
    // 通らない（下の describe で固定）。**穴を数え切ったと書かない。**
    expect(block, '列挙を「所有者の w だけ」に閉じている').not.toContain('**残る穴は所有者の w だけ**')
    expect(block).toContain('「所有者の w だけ」ではない')
    expect(block).toContain('`chmod` が失敗したファイル')
    expect(block).toContain('CAP_DAC_OVERRIDE')
    expect(block).toContain('実際のさくらのサーバーでは未確認')
    expect(block).toContain('所有者（uid/gid）は変えない')
    expect(block).toContain('公開し直すと消える')
    // 共用型の uid は実測していない（推測で書かない）
    expect(block).toContain('**共用型のコンテナがどの uid で動くかは未確認**')
    // 「原因は未確認」と書いていた箇所が残っていないこと
    expect(planDoc).not.toContain('**原因（なぜ LB に健全なバックエンドが1つも登録されなかったか）は未確認。**')
  })

  it('★★ 計画書 12-1 に「コンテナは uid 951:gid 951 で動く」の行がある（像が読み取り専用だと自分のフォルダを作れない）', () => {
    const at = planDoc.indexOf('### 12-1.')
    expect(at).toBeGreaterThan(0)
    const block = planDoc.slice(at, planDoc.indexOf('### 12-2.', at))
    expect(block).toContain('**コンテナは uid 951:gid 951 で動く**')
    expect(block).toContain('アプリが自分のフォルダを作れない')
    expect(block).toContain('コンテナ実行環境仕様')
  })

  // D-7b（検分の指摘・A）: ⑧の verify 段は同じ 最新の節の**新機能**であり、
  // 既存機能の不具合を直したわけではない。「これまでは…でした」という不具合修正のような
  // 書き方をやめ、「⑧は公開のあと応答を確かめます」と機能の説明として書く（直す前の形に
  // 戻っていないことも、あわせて固定する）。
  it('★★ CHANGELOG の最新の節 は、⑧の verify 段を新機能として説明し、既存機能の不具合修正のような書き方（これまでは…でした）にしない。利用者向けにも「アプリが応答していなかった」までしか言わない', () => {
    const block = newestChangelogSection(changelog)
    expect(block).toContain('専有型の⑧は、公開のあとに**アプリが本当に応答しているかを確かめます**')
    expect(block).toContain('アプリがまだ応答していません')
    expect(block).not.toContain('これまでは、アプリが応答していなくても')
    expect(block).not.toContain('コンテナが1つも動いていなくても')
    expect(block).not.toContain('コンテナが1つも')
  })

  it('★★ 同じ断定が、コメントの複写（publishVerify／publishLabels／apprunDedicatedAppApply）にも残っていない', () => {
    for (const src of [verifyLib, appApply]) {
      expect(src).not.toContain('コンテナが1つも応答')
      expect(src).not.toContain('コンテナが1つも動')
    }
    // D-8: publishLabels.ts は「コンテナが1つも動いていません。」を**画面の文言として**持つ
    // （containerStateSummary。GET …/containers が **0件と答えた**ときの表示であって、
    // 503 の原因の断定ではない）。断定が戻っていないかは publishHeadline のコメントで見る。
    const headlineComment = labelsLib.slice(
      labelsLib.indexOf('// publishHeadline —'), labelsLib.indexOf('export function publishHeadline'),
    )
    expect(headlineComment.length).toBeGreaterThan(0)
    expect(headlineComment).not.toContain('コンテナが1つも応答')
    expect(headlineComment).not.toContain('コンテナが1つも動')
    // 3つとも「503＝健全なバックエンドが1つも登録されていない／コンテナ側は D-7 時点では未確認」の形で書く
    for (const src of [verifyLib, labelsLib, appApply]) {
      expect(src).toContain('健全なバックエンドが1つも')
      expect(src).toContain('未確認')
    }
  })

  // ⚠️ 検分の指摘（medium・2026-09-16）: D-13 H で publishLabels.ts から消した
  // 「**当時は未確認 → 後日判明**」の形が、publishVerify.ts と apprunDedicatedAppApply.ts の
  // コメントに**そのまま残っていた**。「コンテナ自体が起動していたかは未確認」の直後に
  // 「→ 同日のランタイムログで判明（D-8）」と続くため、**503 を観測した時点の状態がログで
  // 確定した**ように読める。実測はそうなっていない——ログは 10:34〜10:57、503 は 08:35 前後で、
  // **同時刻の突き合わせはしていない**。計画書 5-13・roadmap・publishLabels.ts と同じ基準に揃える。
  it('★★ コメントの複写（publishVerify／apprunDedicatedAppApply）も「説明はつくが断定しない」に揃っている', () => {
    for (const [name, src] of [['publishVerify', verifyLib], ['apprunDedicatedAppApply', appApply]] as const) {
      // 直す前の形（時刻の違うログで「判明」と答える）に戻っていないこと
      expect(src, `${name}: 「後日判明」の断定が残っている`).not.toContain('同日のランタイムログで判明')
      expect(src, `${name}: 「後日判明」の断定が残っている`).not.toContain('ランタイムログで確定')
      // 揃える先（publishLabels.ts と同じ言い方）
      expect(src, `${name}: ログの時刻を書いていない`).toContain('10:34〜10:57')
      expect(src, `${name}: 503 の観測時刻を書いていない`).toContain('08:35 前後')
      expect(src, `${name}: 突き合わせをしていないことを書いていない`).toContain('時刻の突き合わせはしていない')
      expect(src, `${name}: 断定しないと書いていない`).toContain('断定はしない')
      expect(src).toContain('説明はつく')
    }
    // publishLabels.ts（揃える先）も同じ基準のままであること（ここが緩むと3つとも意味を失う）
    expect(labelsLib).toContain('時刻の突き合わせはしていない')
  })
})

// ── 検分の指摘（2026-09-16）: 計画書の中で、実装・他の節と食い違っている行を直す ───────────
//
// 計画書は**次に直す人が読む**文書なので、古い断定が残っていると、そこを根拠に画面や実装が
// 巻き戻る。**実測に照らして正しいほう**（画面の文言・実装・5-13）へ揃え、
// **戻ってはいけない形**を not.toContain で固定する（掟10）。
describe('計画書: 実装・他の節と食い違う行を残さない（検分の指摘・2026-09-16）', () => {
  const planDoc = readFileSync(join(__dirname, '..', 'docs/apprun-dedicated-plan.md'), 'utf-8')

  // (1) 5-13 の「画面には…を案内する」の行だけが、D-13 B で画面から消した「数分」を残していた。
  //     同じ計画書の 427 行・publishLabels.ts・README・usage-guide・CHANGELOG のすべてと食い違う。
  //     **実測に照らして正しいのは「発行を一度も通しておらず、所要時間の根拠が無い」側**。
  it('★★ 5-13 の「画面が何を案内するか」の行が、Let\'s Encrypt の所要時間を断定していない', () => {
    const at = planDoc.indexOf('画面には、この2点')
    expect(at, '「画面には、この2点」の行が見つからない').toBeGreaterThan(0)
    const block = planDoc.slice(at, at + 600)
    // 直す前の形（画面は「数分」で案内する、と説明する）に戻っていないこと
    expect(block, '計画書が「数分」を書き戻す根拠に戻っている').not.toContain('A レコードを向けてから数分')
    expect(block).toContain('発行にかかる時間は、実際のさくらのサーバーでまだ確認できていない')
    expect(block).toContain('D-13 B')
  })

  // (2) 12-1 の表が「ファイルは 0o444 のまま」と書いており、実装（fileModeForImage）とも
  //     5-13 とも食い違っていた。**正しいのは実装と 5-13 のほう**（0o755 は 0o755 のまま）。
  it('★★ 12-1 の表のファイルの mode の説明が、実装（fileModeForImage）と一致している', () => {
    const at = planDoc.indexOf('### 12-1.')
    const block = planDoc.slice(at, planDoc.indexOf('### 12-2.', at))
    // 直す前の形（0o444 に揃うかのような書き方）に戻っていないこと
    expect(block, '表だけが「ファイルは 0o444 のまま」に戻っている').not.toContain('ファイルは `0o444` のまま')
    expect(block).toContain('fileModeForImage')
    expect(block).toContain('(mode \\| 0o444) & ~0o022')
    expect(block).toContain('実行ビットを奪わないのが要点')
  })

  // (3) 5-13 の「残る制限」は、守りが届く範囲（copyTree が通すのは手元から複製した分だけ）を書く。
  it('★★ 5-13 が、node_modules は copyTree を通らないこと・normalizeStageTree で揃えることを書いている', () => {
    const at = planDoc.indexOf('**守りが届く範囲**')
    expect(at, '「守りが届く範囲」の行が無い').toBeGreaterThan(0)
    const block = planDoc.slice(at, at + 900)
    expect(block).toContain('`node_modules` は複製の対象外')
    expect(block).toContain('npm とビルドした人の umask 任せ')
    expect(block).toContain('normalizeStageTree')
  })
})

// ── D-8 の記録: 利用者向けの文書で「未確認」を「できた」に倒さない（掟9・検分の指摘）──────
//
// 検分の指摘（2026-09-16・high）: README・usage-guide・CHANGELOG が
// 「公開したアプリは自分でフォルダやファイルを作れます」「作れるようになりました」と**断定**
// していた。一方で計画書 5-13 は『まだ確かめていないこと: この修正で実際に /app/data が
// 作れるようになるか』と書いている。**手元で確かめたのは copyTree の mode と layer.tar の
// mode だけで、uid 951 のコンテナが実際に mkdir できることは未確認**である。
// D-7 の反省（`unknown-read-as-ok`）を、いちばん多くの人が読む場所で繰り返していた。
// CHANGELOG 0.6.16 には『実装済み・実機未確認』と断った前例がある（掟1・掟9）。
//
// ── D-13 C（2026-09-16）: 利用者向けの文から「実機」を外す ────────────────────────
// 「実機」は開発側の言葉で、**非エンジニアには何を指すか分からない**（実物の機械？ 自分のPC？）。
// 断りの中身は変えず、言い方だけ「実際のさくらのサーバーでの確認はこれからです」に揃える。
describe('D-8 の記録: 「フォルダを作れる」はまだ確認できていないと断る（掟9・D-13 C）', () => {
  const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf-8')
  const guide = readFileSync(join(__dirname, '..', 'docs/usage-guide.html'), 'utf-8')
  const changelogAll = readFileSync(join(__dirname, '..', 'CHANGELOG.md'), 'utf-8')
  const unreleased = newestChangelogSection(changelogAll)
  const planDoc2 = readFileSync(join(__dirname, '..', 'docs/apprun-dedicated-plan.md'), 'utf-8')

  it('★★ 3つの文書とも「作れます／作れるようになりました」と断定しない（まだ確認できていないと書く）', () => {
    for (const [name, src] of [['README', readme], ['usage-guide', guide]] as const) {
      expect(src, `${name} が断定に戻っている`).not.toContain('自分でフォルダやファイルを作れます')
      expect(src, `${name} に未確認の断りが無い`).toContain('実際のさくらのサーバーでの確認はこれからです')
    }
    expect(unreleased).not.toContain('自分でフォルダやファイルを作れるようになりました')
    expect(unreleased).toContain('実装済み・実際のさくらのサーバーでの確認はこれから')
  })

  // D-13 C: 利用者向けの3文書に、開発側の言葉「実機」を残さない（最新の節・現行の説明だけを見る。
  // 過去の版の項は、そのとき出した文のまま残す）。
  it('★★ 利用者向けの文（README・使い方ガイド・CHANGELOG［最新の節］）に「実機」が出てこない', () => {
    for (const [name, src] of [['README', readme], ['usage-guide', guide], ['CHANGELOG［最新の節］', unreleased]] as const) {
      expect(src, `${name}: 非エンジニアに通じない「実機」が残っている`).not.toContain('実機')
    }
  })

  it('★★ 計画書 5-13 の「まだ確かめていないこと」と食い違っていない（文書だけ先に完了形にしない）', () => {
    // 計画書は未確認だと言い続けている（ここが消えたら、3つの文書の断りも見直すこと）
    expect(planDoc2).toContain('この修正で実際に `/app/data` が作れるようになるか')
    expect(planDoc2).toContain('uid 951 のコンテナが実際に `mkdir` できることは未確認**')
  })

  // 検分の指摘（medium）: 消える条件を「公開し直すと」だけに限ると、事実より弱い約束になる。
  // 実機でコンテナは**自分で再起動していた**ので、公開し直さなくてもデータは消える。
  // D-13 E（2026-09-16）: 「コンテナが再起動したときも作り直されます」は、非エンジニアには
  // **「自分が再起動しなければ残る」**と読める。実際は利用者が何もしなくても入れ替わる。
  it('★★ 3つの文書とも「あなたが何もしなくても入れ替わる」「台数2以上は別のデータ」まで書く', () => {
    for (const [name, src] of [['README', readme], ['usage-guide', guide], ['CHANGELOG', unreleased]] as const) {
      expect(src, `${name}: 利用者の操作なしに入れ替わることが書かれていない`).toContain('あなたが何もしなくても入れ替わることがあり')
      // 直す前の形（利用者の操作だと読める言い方）に戻っていないこと
      expect(src, `${name}: 「自分が再起動しなければ残る」と読める形に戻っている`).not.toContain('コンテナが再起動したときも作り直されます')
      expect(src, `${name}: 台数2以上の注意が無い`).toContain('台数を2以上にすると、コンテナごとに別のデータになります')
      // 直す前の弱い約束（これだけだと「公開し直さなければ残る」と読まれる）
      expect(src, `${name}: 弱い約束に戻っている`).not.toContain('書いたデータは、公開し直すと消えます')
    }
  })

  // 検分の指摘（medium）: CHANGELOG だけが Let's Encrypt の所要時間を断定していた
  // （README・計画書 5-13・10 章はいずれも「未確認」）。利用者が最初に読むのは CHANGELOG（掟9・掟1）。
  // D-13 B（2026-09-16）: 今度は**画面の案内（dnsGuidanceLines）だけ**が「数分で」と断定していた。
  // 3つの文書と画面で、同じ「まだ確認できていない」に揃える（掟9・掟1）。
  it('★★ CHANGELOG・README・画面のどれも Let\'s Encrypt の所要時間を断定しない', () => {
    const labels = readFileSync(join(__dirname, '..', 'src/shared/publishLabels.ts'), 'utf-8')
    expect(unreleased).not.toContain('向けたあと数分で https で開けるようになります')
    for (const [name, src] of [['CHANGELOG', unreleased], ['README', readme], ['usage-guide', guide]] as const) {
      expect(src, `${name}: 所要時間の断りが無い`).toContain('発行にかかる時間は、実際のさくらのサーバーでまだ確認できていません')
    }
    // 画面（publishLabels.ts の dnsGuidanceLines）だけが断定に戻っていないこと
    expect(labels, '画面の案内が所要時間を断定している').not.toContain('数分で使えるようになります')
  })
})

// ── roadmap の「🚧 いまここ」（いちばん読まれる場所）で、失敗を落とさない（検分の指摘）──────
//
// 検分の指摘（medium）: roadmap の「🚧 いまここ（2026-09-16）」が D-7（503・アプリが応答して
// いなかった）と D-8（EACCES で1分ごとに再起動）を1行も記録せず、「⑧が初めて実 API を通った…
// コンパネで稼働コンテナ 1 …を確認」で終わっていた。**⑧はほぼ成功・残りは軽微**と読める。
// しかも「稼働コンテナ 1」は、計画書 5-13 自身が**動いている根拠にならない**と結論づけた表示で、
// それが成功の証拠として残っていた。
// roadmap は動く文書なので、ここでは**戻ってはいけない形**だけを固定する（掟10 の「直す前の形を
// not.toContain で禁じる」）。
describe('roadmap: 「稼働コンテナ 1」を成功の証拠として残さない（D-7・D-8）', () => {
  const roadmap = readFileSync(join(__dirname, '..', 'docs/roadmap.md'), 'utf-8')

  it('★★ 直す前の形（稼働コンテナ 1 …を確認）に戻っていない', () => {
    expect(roadmap).not.toContain('稼働コンテナ 1・ホスト名')
  })

  // 2026-09-16 の是正: 以前ここは「動いている根拠にならなかった（実際は再起動ループ。5-13 でそう
  // 結論づけた）」だった。だが**計画書 5-13 はそう結論づけていない**——503 の観測（08:35 前後）と
  // ランタイムログの再起動ループ（10:34〜10:57）は時刻が違い、同時刻の突き合わせをしていないので
  // 「説明がつく」までしか書いていない。**計画書に無い結論を、計画書のものとして roadmap に書かない。**
  it('★★「稼働コンテナ 1」に触れるなら、それを動いている根拠にしてよいか分からなかったことを必ず併記する', () => {
    if (roadmap.includes('稼働コンテナ 1')) {
      expect(roadmap, '「稼働コンテナ 1」が根拠として独り歩きしている').toContain('動いている根拠にしてよいかは分からなかった')
      // 直す前の形（計画書に無い断定を、計画書の結論として書く）に戻っていないこと
      expect(roadmap, '計画書 5-13 が断定していないことを roadmap が断定している').not.toContain('実際は再起動ループ')
      expect(roadmap).not.toContain('5-13 でそう結論づけた')
    }
  })

  it('★★ 2026-09-16 の実機で出た欠陥（503・EACCES の再起動ループ）が記録されている', () => {
    expect(roadmap).toContain('no available server')
    expect(roadmap).toContain("EACCES: permission denied, mkdir '/app/data'")
    expect(roadmap).toContain('1分ごとに再起動を繰り返していた')
  })
})

// ── D-12（2026-09-16 の検分）: 直した4点を、戻らない形で固定する ─────────────────────
//
// 検分で出た欠陥のうち、文言・体裁にかかわるものをここでまとめて固定する。roadmap・README・
// usage-guide・CHANGELOG は動く文書なので、**戻ってはいけない形**（直す前の断定・抜け）を
// `not.toContain` で禁じ、要る断りだけを `toContain` で見る（掟10）。
describe('D-12: スティッキービットの説明と、消えるデータの注意（検分・2026-09-16）', () => {
  const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf-8')
  const guide = readFileSync(join(__dirname, '..', 'docs/usage-guide.html'), 'utf-8')
  const changelogAll = readFileSync(join(__dirname, '..', 'CHANGELOG.md'), 'utf-8')
  const unreleased = newestChangelogSection(changelogAll)
  const planDoc3 = readFileSync(join(__dirname, '..', 'docs/apprun-dedicated-plan.md'), 'utf-8')

  // high: 「像の中のファイルの所有者は root」は**未確認のうえ実測と食い違う**
  //（書庫に入るのはビルドした人の uid。実測 502・`uname=r-yamaguchi`）。
  // 同じ文書群が共用型については「未確認だから root だとは書かない」と決めているのに、
  // スティッキーの説明で未確認の root 因果を1つ新設していた（掟1）。
  it('★★ 計画書が「所有者は root」を理由に使っていない（書庫の uid はビルドした人のもの）', () => {
    expect(planDoc3, '未確認の root 因果が戻っている').not.toContain('像の中のファイルの所有者は')
    expect(planDoc3).not.toContain('ファイルの所有者は root')
    expect(planDoc3).not.toContain('所有者が root で、ファイルにはグループ・その他の書き込みが無く')
    expect(planDoc3).toContain('書庫のヘッダに入るのは「ビルドした人の uid」')
    expect(planDoc3).toContain('951 だったときにどうなるかは未確認')
  })

  // medium: 「グループ・その他の書き込みが無い」はコードが保証していない。
  // `addPermission` は足すだけで奪わないので、手元が 0o666 のファイルは w を持ったまま像に入る。
  // D-13 A: 当時は「上書きは手元次第」と正直に書くしかなかった（コードが止めていなかったため）。
  // いまは `fileModeForImage` が他人の w を落とすので、計画書も**止めた側**を書く。
  // ただし**実際のさくらのサーバーで上書きを試したわけではない**ので、そこは未確認のまま残す。
  it('★★ 計画書の「残る制限」が、上書きも止めたことと、まだ確かめていない範囲を書き分けている', () => {
    expect(planDoc3, '直す前の言い切りに戻っている').not.toContain('アプリ自身では**上書きも削除もできない**')
    expect(planDoc3, '足すだけだった頃の説明が残っている').not.toContain('手元が `0o666`/`0o777` のファイルは w を持ったまま像に入り、アプリから上書きできる')
    expect(planDoc3).toContain('**その場の上書きも、D-13 A で止めた**')
    expect(planDoc3).toContain('コンテナの中から実際に上書きを試したわけではない')
  })

  // ── D-13 J（2026-09-16）: 計画書に残る暗黙の因果 ────────────────────────────────
  // 「同じ像で共用型では動いていた（事実）」が「0o555 のフォルダには uid 951 では書けない」の
  // 隣の行にあると、**「共用型は root だった」と読める**。実際は、共用型に公開したアプリが
  // そもそも書き込みをしなかっただけかもしれない（未確認）。誤読されない書き方にする。
  it('★★ 「共用型では動いていた」が、uid の違い以外の理由（書き込みをしなかった）にも触れている', () => {
    expect(planDoc3).toContain('共用型に公開したアプリが、そもそも書き込みをしなかった')
    expect(planDoc3).toContain('「共用型は root だったから書けていた」と読めてしまう')
    // 未確認のまま残す（どちらの理由とも決めない）
    expect(planDoc3).toContain('理由は**どれとも決まっていない**')
  })

  // D-13 A/D（2026-09-16）: ここは以前「『書き換えも削除もできません』と約束しない」だった——
  // `addPermission` は足すだけで、手元が `0o666` のファイルは上書きできたため。
  // **実装のほうを直した**（`fileModeForImage` が他人の書き込みを落とす）ので、3つの文書も
  // 実装と一致する内容にする。ただし**実際のさくらのサーバーでは確かめていない**ので、
  // 断らずに書かない（掟1）——claim と断りを**同じ文の中**で固定する。
  it('★★ 利用者向けの2文書が、書き換えも削除もできないことと、その確認がまだであることを併記する', () => {
    // D-14（2026-09-16 の検分）: 「〜できないようにしました」は**書き手側の言い方**（誰が何をしたか）で、
    // 読み手が取れる行動になっていない。事実は同じまま「〜できません」に直した（README・ガイドの両方）。
    // CHANGELOG は「何が変わったか」を書く文書なので「ようにしました」のまま（ここでは見ない）。
    const claim = '最初から入っているファイル（あなたが書いたプログラムそのもの）は、公開したアプリからは書き換えも削除もできません'
    for (const [name, src] of [['README', readme], ['usage-guide', guide]] as const) {
      expect(src, `${name}: 配布物のファイルを守る制限が書かれていない`).toContain(claim)
      // 直す前の形（削除だけに限る）に戻っていないこと
      expect(src, `${name}: 上書きを止められなかった頃の言い方に戻っている`)
        .not.toContain('公開したアプリからは消せません')
      // D-14: 書き手側の言い方に戻っていないこと
      expect(src, `${name}: 書き手側の言い方（〜できないようにしました）に戻っている`)
        .not.toContain('書き換えも削除もできないようにしました')
      // 断り（実際のさくらのサーバーでの確認はこれから）が、その主張のすぐ後ろにあること
      const at = src.indexOf(claim)
      expect(src.slice(at, at + 200), `${name}: 未確認の断りが主張のそばに無い`).toContain('実際のさくらのサーバーでの確認はこれからです')
    }
    expect(unreleased, 'CHANGELOG に未確認の断りが無い').toContain('実際のさくらのサーバーでの確認はこれからです')
  })

  // medium: CHANGELOG は利用者向け（掟2「内部用語を並べない」）。
  it('★★ CHANGELOG［最新の節］に内部用語（EACCES・スティッキービット）を出さない', () => {
    expect(unreleased).not.toContain('EACCES')
    expect(unreleased).not.toContain('スティッキービット')
  })

  // medium: 既定で推奨される**共用型**にだけデータが消える注意が無かった（大多数が通る道）。
  it('★★ README・usage-guide とも、共用型の AppRun にもデータが消える注意がある', () => {
    for (const [name, src] of [['README', readme], ['usage-guide', guide]] as const) {
      expect(src, `${name}: 共用型にデータが消える注意が無い`).toContain('共用型も専有型も同じです')
    }
  })
})

// ── D-12: 「説明がつく」と「確定」の書き分け・⑥の合格の記録（検分・2026-09-16）──────────
describe('D-12: 5-13 の書き分けと、⑥の破棄が合格したことの記録（掟1・掟9）', () => {
  const roadmap2 = readFileSync(join(__dirname, '..', 'docs/roadmap.md'), 'utf-8')
  const planDoc4 = readFileSync(join(__dirname, '..', 'docs/apprun-dedicated-plan.md'), 'utf-8')

  // high: 見出しだけが「原因が判明した」と断定し、直下の本文（「断定はしない」）と矛盾していた。
  it('★★ 5-13 の見出しが「503 の原因が判明した」と断定していない', () => {
    expect(planDoc4).not.toContain('**503 の原因が判明した')
    expect(planDoc4).toContain('ランタイムログで再起動ループが分かった')
    // 直下の基準（同時刻の突き合わせをしていない）は残っていること
    expect(planDoc4).toContain('同時刻の突き合わせはしていない')
  })

  // high: 「503 を見た時点でコンテナが起動していたか」に、時刻の違うログで「確定」と答えていた。
  it('★★ D-7 の表が、503 の時点の状態を「確定」と書いていない', () => {
    expect(planDoc4).not.toContain('→ 同日のランタイムログで確定: **コンテナは起動しては落ち')
    expect(planDoc4).toContain('503 を見た時点でコンテナが起動していたかどうか**は、いまも未確認')
  })

  // high: ⑥の破棄が実機で合格（約9分・手動介入なし）したのに、roadmap と計画書 10/11 章が
  // 「直した後の実機確認はまだ」のままだった。**実測のほうが正**。
  it('★★ roadmap の「🚧 いまここ」に⑥の合格が書かれ、未確認・次からは外れている', () => {
    expect(roadmap2).toContain('約9分・手動介入なし')
    // 直す前の形（未確認として残す・次の一手に入れる）に戻っていないこと
    expect(roadmap2).not.toContain('⑥「すべて削除する」が人の待ちなしで アプリ→LB→ASG→クラスタ の順に消えるか')
    expect(roadmap2).not.toContain('③⑥の破棄確認')
  })

  it('★★ 計画書 10 章・11 章が「⑥は直した後の実機確認がまだ」と言い続けていない', () => {
    expect(planDoc4).not.toContain('- **直した後の実機確認はまだ**（次の「作る→壊す」で、人の待ちなしに通れば合格）')
    expect(planDoc4).not.toContain('#39「消えるまで待つ」の直した後の実機確認（前節）もまだ')
    expect(planDoc4).toContain('**✅ 直した後の実機確認は合格（2026-09-16）**')
  })

  // 合格しても、確かめた範囲とそうでない範囲は書き分ける（無効化の直後の DELETE は未確認のまま）。
  it('★★ 「無効化 → 再取得で確認 → DELETE」が通ったことと、確認を挟まない場合が未確認であることを書き分ける', () => {
    for (const [name, src] of [['roadmap', roadmap2], ['plan', planDoc4]] as const) {
      expect(src, `${name}: 確認を挟まない DELETE まで通ったことにしている`)
        .toContain('確認を挟まずに DELETE しても通るのか')
    }
    expect(roadmap2).not.toContain('**無効化の直後に DELETE できるのか、伝播待ちが要るのかは未確認**')
  })
})

// ── D-12: いちばん取り返しがつかない注意を、いちばん拾いにくい体裁に置かない（検分・2026-09-16）──
//
// medium: `ephemeralDataNote()`（データが消える）は `text-[11px] text-ink-muted` ＝**⑧のパネルで
// いちばん小さく薄い字**で描かれていた。本文は `text-xs text-ink-secondary`、独自ドメインや費用の
// 注意は太字である。あわせて、公開前の確認ダイアログは「mCPU・メモリ・**台数**」を読み上げるのに
// データが消えることには触れず、台数を2以上にした利用者が「コンテナごとに別のデータ」を
// 確認画面で見ないままだった。
describe('D-12: ⑧のデータが消える注意の置き方（画面と確認ダイアログ）', () => {
  it('★★ ⑧の本文と同じ大きさ・太字で出す（いちばん小さく薄い字に戻っていない）', () => {
    const at = panel.indexOf('⑧ アプリを公開する</p>')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, at + 2200)
    expect(block).toContain('<p className="text-xs font-semibold text-ink-secondary leading-relaxed">{ephemeralDataNote()}</p>')
    // 直す前の体裁（パネルで最小・最薄）に戻っていないこと
    expect(block).not.toContain('<p className="text-[11px] text-ink-muted leading-relaxed">{ephemeralDataNote()}</p>')
  })

  it('★★ 公開前の確認ダイアログの読み上げに ephemeralDataNote() が入っている（台数の直後）', () => {
    const at = panel.indexOf('const confirmMessage = [')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, panel.indexOf('].join(\'\\n\')', at))
    expect(block).toContain('`mCPU ${appCpu}・メモリ ${appMemory}MB・台数 ${appFixedScale}`')
    expect(block, '確認画面がデータの消えることに触れていない').toContain('ephemeralDataNote(),')
    // 文言は一元化（画面に直書きしない・掟10）
    expect(block).not.toContain('データは残りません')
  })
})

// ── D-13 F（2026-09-16）: 共用型の公開画面にも、データが消える注意を出す ────────────────
//
// README も使い方ガイドも「共用型も専有型も同じです」と書いているのに、`ephemeralDataNote()`
// を出していたのは**専有型の⑧だけ**だった。共用型は既定で推奨される側＝**大多数が通る道**で、
// そちらに注意が無いほうが害が大きい。**文言は複製せず、同じ純関数を呼ぶ**（掟10）。
// 置き場所は「公開する前に読める位置」——公開ボタンのすぐ下、保存場所の注意の隣。
describe('D-13 F: 共用型（AppRunPanel.tsx）にも ephemeralDataNote() を出す', () => {
  const sharedPanel = readFileSync(join(__dirname, '..', 'src/renderer/components/AppRunPanel.tsx'), 'utf-8')

  it('★★ shared/publishLabels.ts の ephemeralDataNote を import している（文言を複製しない）', () => {
    expect(sharedPanel).toContain("import { ephemeralDataNote } from '../../shared/publishLabels'")
    // 文言そのものを共用型パネルへ書き写していないこと
    expect(sharedPanel).not.toContain('入れもの（コンテナ）は使い捨て')
    expect(sharedPanel).not.toContain('コンテナごとに別のデータ')
  })

  it('★★ 公開ボタン（publishButtonLabel）と破棄ボタンの直後、保存場所の注意の隣に出す（公開の前に読める位置）', () => {
    const at = sharedPanel.indexOf('>{publishButtonLabel(published)}</button>')
    expect(at).toBeGreaterThan(0)
    const block = sharedPanel.slice(at, at + 1400)
    expect(block).toContain('「破棄する」はデータの保存場所も含めて削除する場合があります。')
    expect(block, '公開の前に読める位置に出ていない').toContain('{ephemeralDataNote()}')
  })

  it('★★ 体裁は専有型の⑧と同じ（本文と同じ大きさ・太字。いちばん小さく薄い字に置かない）', () => {
    expect(sharedPanel).toContain('<p className="text-xs font-semibold text-ink-secondary leading-relaxed">{ephemeralDataNote()}</p>')
    expect(sharedPanel).not.toContain('<p className="text-[11px] text-ink-muted leading-relaxed">{ephemeralDataNote()}</p>')
  })
})

// ── D-13 I（2026-09-16）: roadmap の中の食い違いを残さない ────────────────────────
//
// 同じ文書の中で、版の表の `v0.6.19-rc.1` の行だけが古い姿のまま残っていた
// （「そのとき出た欠陥2件…修理後の実機確認はまだ…テスト 4,493 件」）。
// 「🚧 いまここ」は同じ日に**欠陥4件**・**⑥は合格**まで書いており、**表と本文が食い違っていた**。
// あわせて「次」の行が、合格済みの⑥の破棄確認を**未了として**残していた。
// roadmap は動く文書なので、**戻ってはいけない形**を `not.toContain` で禁じる（掟10）。
describe('D-13 I: roadmap の版の表と「次」の行を、同じ文書の「🚧 いまここ」と食い違わせない', () => {
  const roadmap3 = readFileSync(join(__dirname, '..', 'docs/roadmap.md'), 'utf-8')
  const row = roadmap3.slice(roadmap3.indexOf('| **v0.6.19-rc.1** |'), roadmap3.indexOf('\n| 配布済み |'))

  it('★★ 版の表の行が「欠陥2件」のままになっていない（同じ日に4件出ている）', () => {
    expect(row.length).toBeGreaterThan(0)
    expect(row, '古い「欠陥2件」が残っている').not.toContain('そのとき出た欠陥2件')
    expect(row).toContain('欠陥は**4件**')
    // 4件の中身（D-5 の2件・D-7・D-8）がそれと分かること
    expect(row).toContain('D-7')
    expect(row).toContain('D-8')
  })

  it('★★ 版の表の行が「修理後の実機確認はまだ」で終わっていない（⑥は合格している）', () => {
    expect(row, '⑥の合格が抜けている').toContain('⑥「すべて削除する」は修理後の実機確認に合格')
    expect(row).toContain('⑧の修理後の確認はまだ')
  })

  it('★★ 版の表のテスト件数が、同じ文書の「🚧 いまここ」と同じ数になっている', () => {
    const inRow = row.match(/テスト \*\*([\d,]+) 件\*\*/)
    const hereAt = roadmap3.indexOf('> テストは **')
    const inHere = roadmap3.slice(hereAt, hereAt + 40).match(/\*\*([\d,]+) 件\*\*/)
    expect(inRow?.[1], '版の表にテスト件数が無い').toBeTruthy()
    expect(inHere?.[1], '「🚧 いまここ」にテスト件数が無い').toBeTruthy()
    expect(inRow?.[1], `版の表 ${inRow?.[1]} と いまここ ${inHere?.[1]} が食い違っている`).toBe(inHere?.[1])
  })

  it('★★「次」の行が、合格済みの⑥の破棄確認を未了として残していない', () => {
    const next = roadmap3.slice(roadmap3.indexOf('\n| 次 |'), roadmap3.indexOf('\n\n', roadmap3.indexOf('\n| 次 |')))
    expect(next.length).toBeGreaterThan(0)
    expect(next, '合格済みの⑥が「次」に残っている').not.toContain('②⑥の破棄確認')
    expect(next).toContain('⑥の破棄確認（#39）は 2026-09-16 に合格したのでここには残さない')
    // まだ確かめていないことは、確かめたことと分けて書く
    expect(next).toContain('確認を挟まずに DELETE しても通るか')
    // D-8・D-13 A の確認が「次」の先頭に来ている（いちばん先に確かめること）
    expect(next).toContain('D-8・D-13 A を直したあとの⑧の一巡')
  })
})

// ── D-14（2026-09-16 の検分）: 使い方ガイドの約束を、実装と突き合わせて固定する ──────────────
//
// 直前の作業で、使い方ガイド 212 行の「応答していないときは、そう言います」を**元に戻す変異**を
// 入れたが、**どのテストも検知しなかった**（ガイドを読む検査は「データが消える」「実機」など
// 別の話題しか見ていなかった）。ここでその穴をふさぐ。
//
// 固定するのは、検分で出た2種類の欠陥である。
//  (1) **文書だけが実装より強い約束をする**——ガイド・README・CHANGELOG が「応答が無いときは
//      『✅ 公開しました』とは表示せず」と書いていたが、`publishHeadline` が見出しを警告に倒すのは
//      `no-backend`（503）のときだけ。`unreachable`（つながらない）・`stale`（古い版）は
//      「✅ 公開しました」のまま、一文が添うだけである。
//  (2) **確認できる範囲の条件が落ちる**——`canVerify` は `runtime === 'static'` のときしか真に
//      ならないので、標準ビルドでも Node などサーバーで動くアプリは確認されない。ガイドは
//      例外を「エキスパート」と「IP が取れなかったとき」だけに読ませていた。
//
// **ガイドの文言そのものではなく、実装の振る舞い（publishHeadline / canVerify）を起点に見る。**
// 実装が変わればこのテストが先に落ちるので、文書の直し忘れがそこで分かる。
describe('D-14: 使い方ガイドの「応答の確認」が、実装より強い約束をしていない', () => {
  const guide = readFileSync(join(__dirname, '..', 'docs/usage-guide.html'), 'utf-8')
  const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf-8')
  const changelogAll = readFileSync(join(__dirname, '..', 'CHANGELOG.md'), 'utf-8')
  const unreleased = newestChangelogSection(changelogAll)
  const docs = [['usage-guide', guide], ['README', readme], ['CHANGELOG［最新の節］', unreleased]] as const

  // 実装の側（ここが変わったら、下の文書の約束も見直すこと）
  it('★★ 見出しを警告に倒すのは 503（no-backend）と失敗応答（error-status）で、unreachable・stale は「✅ 公開しました」のまま', () => {
    expect(publishHeadline('no-backend').tone).toBe('warn')
    // D-19b（検分・2026-09-16）: 404・502・504 のような失敗応答も警告に倒す。直す前はこれらが
    // `responding` に倒れており、**ページが開けないのに緑の「✅ 公開しました」**が出ていた。
    expect(publishHeadline('error-status').tone).toBe('warn')
    expect(publishHeadline('error-status').text).not.toContain('✅')
    // ただし「応答していません」とは書かない（応答は返っている。返ってきたのがエラー）
    expect(publishHeadline('error-status').text).not.toContain('応答していません')
    expect(publishHeadline('responding').tone).toBe('ok')
    expect(publishHeadline('unreachable').tone).toBe('ok')
    expect(publishHeadline('stale').tone).toBe('ok')
    expect(publishHeadline('ok').tone).toBe('ok')
    expect(publishHeadline(undefined).tone).toBe('ok')
  })

  // ── D-19b（2026-09-16 の検分）: この見張りが空振りになっていた ─────────────────────────
  // ここは元々 `canVerify` を見て「確認できるのは静的配信だけ」を固定し、コメントで
  // 「ここが true に緩むと、ガイドの『ファイルをそのまま配るサイトだけ』が嘘になる」と
  // 宣言していた。ところが D-19 で**専有型の⑧は canVerify を通らなくなった**（確かめ方の選択は
  // `dedicatedVerifyMode`）。実装が変わってもこのテストは緑のままで、**ガイドは実際に嘘になった**
  // （掟10「テストは緑・実装は違う」の形）。当て先を、いま⑧が本当に使う関数へ張り替える。
  // `canVerify` は共用型（cloud.ts の verifyPublished）の入口として残っているので、そちらとして見る。
  it('★★ 専有型の⑧は像の種類で確認をとばさない（Node でも根へ当てる・D-19b）', () => {
    // 静的配信＋版が分かるときだけ、目印で「中身が新しいか」まで見る
    expect(dedicatedVerifyMode('static', 'v20260916-083525')).toBe('marker')
    expect(dedicatedProbePath('marker', 1)).toBe('/.koto-build?t=1')
    // Node・Docker（エキスパート）は根（/）へ当てる。**とばさない**——ここが 'skip' のような
    // 値に戻ると、2026-09-16 の「このアプリは応答の確認の対象外のため、確認をとばしました」が戻る
    for (const runtime of ['node', 'docker', 'dockerfile', '', null, undefined]) {
      expect(dedicatedVerifyMode(runtime, 'v20260916-083525'), String(runtime)).toBe('root')
    }
    expect(dedicatedProbePath('root', 1)).toBe('/?t=1')
  })

  it('★★ とばす道は「当てに行く先が無いとき」だけ（⑧のフローの分岐そのものを見る・D-19b）', () => {
    const flow = readFileSync(join(__dirname, '..', 'src/main/cloud/apprunDedicatedAppApply.ts'), 'utf-8')
    // 確認するかどうかの条件は IP とホスト名だけ（像の種類は条件に入っていない）
    expect(flow).toContain('if (lbAddresses.length > 0 && spec.host) {')
    expect(flow).toContain('const mode = dedicatedVerifyMode(input.runtimeKind, markerTag)')
    // 共用型の入口（canVerify）は、専有型の⑧では使わない
    expect(flow, '専有型の⑧が canVerify で門を作る形に戻っている').not.toContain('canVerify(')
    // とばした理由の1行は、像の作りではなく IP・ホスト名の話であること
    expect(flow).toContain('ロードバランサの IP が取れなかったため、応答の確認をとばしました')
    expect(flow, '像の種類でとばす言い方が戻っている').not.toContain('応答の確認の対象外')
  })

  // 共用型（cloud.ts の verifyPublished）の入口は、いまも静的配信だけである
  it('★ canVerify は共用型の入口として、静的配信のときだけ true', () => {
    expect(canVerify('static', 'https://app.example.com/')).toBe(true)
    expect(canVerify('node', 'https://app.example.com/')).toBe(false)
    expect(canVerify('docker', 'https://app.example.com/')).toBe(false)
  })

  // (1) 3つの文書とも、無条件の約束に戻っていないこと
  it('★★ 3つの文書とも「応答が無いときは ✅ を出さない」と無条件に書いていない（503 に限る）', () => {
    for (const [name, src] of docs) {
      // 直す前の形（条件なしの約束）に戻っていないこと
      expect(src, `${name}: 無条件の約束に戻っている`).not.toContain('応答が無いときは「✅ 公開しました」とは表示せず')
      expect(src, `${name}: 無条件の約束に戻っている`).not.toContain('応答していないときは「✅ 公開しました」とは言わず')
      // 見出しを倒す条件（503）が書いてあること
      expect(src, `${name}: 見出しを警告に倒す条件（503）が書かれていない`).toContain('503')
    }
  })

  // ── D-19b（2026-09-16 の検分）: 失敗応答の扱いを、実装と文書の両方で固定する ──────────────
  // **使い方ガイドはここでは見ない。** ガイド 220 行は D-19 以前の約束
  // （「サーバーで動き続けるアプリ（Node.js など）や『エキスパート』で公開したものは、確認をとばします」）
  // のままで、別途直すことになっている（この作業では触らない指示）。**直っていない文書を
  // 「直っていること」にするテストは書かない**ので、いま正しい README・CHANGELOG だけを見る。
  // ガイドを直すときは、この2つと同じ2点（Node でも確かめる／エラー応答は成功にしない）を書くこと。
  it('★★ README・CHANGELOG とも、エラー応答（404 など）を「応答を確認」にしないと書いている', () => {
    for (const [name, src] of [['README', readme], ['CHANGELOG［最新の節］', unreleased]] as const) {
      expect(src, `${name}: エラー応答の扱いが書かれていない`).toContain('404')
      expect(src, `${name}: エラー応答でも成功に見せない約束が書かれていない`).toMatch(/404・502・504 のようなエラー/)
    }
  })

  it('★★ 3つの文書とも、つながらなかった・古い内容のときは「✅ 公開しました」のままだと書いている', () => {
    for (const [name, src] of docs) {
      expect(src, `${name}: ✅ のままになる場合が書かれていない`).toContain('古い内容が返ってきたとき')
      expect(src, `${name}: ✅ のままになる場合が書かれていない`).toContain('公開先につながらなかったとき')
    }
  })
})

// ── D-14: 使い方ガイドの日本語（検分で出た欠陥を、戻らない形で固定する）───────────────────
//
// ガイドは動く文書なので、**戻ってはいけない形**を `not.toContain` で禁じ、落としてはいけない
// 事実（金額・条件・画面に出る呼び名）だけを `toContain` で見る（掟10）。
// **文体そのもの（敬体・体言止め）はテストで固定しない**——書き換えのたびに落ちるだけで、
// 守りになっていないため。報告で触れるにとどめる。
describe('D-14: 使い方ガイドの日本語（検分・2026-09-16）', () => {
  const guide = readFileSync(join(__dirname, '..', 'docs/usage-guide.html'), 'utf-8')
  const credentialsModal = readFileSync(join(__dirname, '..', 'src/renderer/components/CredentialsModal.tsx'), 'utf-8')

  // high: 書き手側の言い方（誰が何をしたか）は、読み手が取れる行動になっていない。
  // 「そう言います」は Ryosuke さんが例として挙げた形そのもの。
  it('★★ 書き手側の言い方（そう言います／〜ようにしました）が残っていない', () => {
    expect(guide, '「そう言います」が戻っている').not.toContain('そう言います')
    expect(guide, '「〜できないようにしました」が戻っている').not.toContain('できないようにしました')
  })

  // high: 文が終わっていない断片（体言止めの「その旨）。」）
  it('★★ コンテナの様子の説明が、体言止めの断片で終わっていない', () => {
    expect(guide, '文が終わっていない断片が戻っている').not.toContain('1つも動いていなければ、その旨）')
    expect(guide).toContain('1つも動いていないときは、その旨をお伝えします')
  })

  // high: 「ではなく」が対比に読めて、理由が2つつながらなかった
  it('★★ コンテナレジストリを残す理由が、対比に読める「ではなく」でつながっていない', () => {
    expect(guide, '対比に読める形が戻っている').not.toContain('そこが Koto の作った場所ではなく')
    expect(guide).toContain('そこは Koto が作った場所ではないうえ')
  })

  // medium: 課金の事実（残したレジストリの月額220円）を、読みやすさのために落とさない
  it('★★ コンテナレジストリを残すと月額220円が続くことが、破棄の説明に書いてある', () => {
    const at = guide.indexOf('引き継いだコンテナレジストリを、Koto が勝手に消すことはありません')
    expect(at, '引き継いだレジストリの説明が見つからない').toBeGreaterThan(0)
    const block = guide.slice(at, at + 700)
    expect(block, '残したときに課金が続く事実が落ちている').toContain('月額220円（税込）が続きます')
  })

  // medium: 画面に無い呼び名を書かない（AppRun 専用のキーは無く、さくらのクラウドのキーで操作する）
  it('★★ キーの切り替え先が、認証情報の画面に実際にある項目名と一致している', () => {
    // 画面の項目名（CredentialsModal の SERVICES）と、画面の見出し
    expect(credentialsModal).toContain("title: 'さくらのクラウド'")
    expect(credentialsModal).toContain('認証情報（APIキー）')
    // ガイドは、その項目名で案内している（「さくらのAppRun のキー」という項目は画面に無い）
    expect(guide, '画面に無い呼び名で案内している').not.toContain('さくらのAppRun のキーは、')
    expect(guide).toContain('「認証情報（APIキー）」</b>の画面の<b>「さくらのクラウド」')
  })

  // medium: 「公開先は4種類（VPS は準備中）」が、VPS を4つの内と外どちらにも読めた
  it('★★ さくらのVPS が4種類の外だと読める書き方になっている', () => {
    expect(guide, '4種類の内か外か読めない形が戻っている').not.toContain('公開先は4種類です（「さくらのVPS」は')
    expect(guide).toContain('公開先は4種類です。このほかに「さくらのVPS」のタブがありますが')
  })
})

// ── D-14: 1つの箇条書き・1つの枠に話題を詰め込まない（検分・2026-09-16）─────────────────
//
// 検分の指摘（medium）: ③公開の節に、533字・13文で話題8つの箇条書きと、543字・10文で話題5つの
// 赤枠があった。**読み手が1つずつ確かめられる単位に割る**のがここでの直し。
// 文字数そのものが目的ではないので、上限は現状（最長341字）より広くとり、
// **「また1つの塊に戻した」ときだけ落ちる**高さにする。
describe('D-14: ③公開の節が、1つの塊に話題を詰め込んでいない（検分・2026-09-16）', () => {
  const guide = readFileSync(join(__dirname, '..', 'docs/usage-guide.html'), 'utf-8')
  const publishSection = (() => {
    const at = guide.indexOf('<section id="publish">')
    return guide.slice(at, guide.indexOf('</section>', at))
  })()

  it('★★ ③公開の節に、見える文字が400字を超える箇条書き・段落・枠が無い', () => {
    const tooLong: string[] = []
    for (const m of publishSection.matchAll(/<(li|p|div)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
      const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, '')
      if (text.length > 400) tooLong.push(`${text.length}字: ${text.slice(0, 40)}…`)
    }
    expect(tooLong, `長すぎる塊が戻っている:\n${tooLong.join('\n')}`).toEqual([])
  })

  // さくらのAppRun の箇条書きは、入れ子の箇条書きに割ってある（話題ごとに1つ）
  it('★★ さくらのAppRun の説明が、話題ごとの入れ子の箇条書きに割れている', () => {
    expect(publishSection).toContain('<li><b>記録を残す・前に戻す</b>：')
    expect(publishSection).toContain('<li><b>起動のしかた</b>：')
    expect(publishSection).toContain('<li><b>共用型と専有型</b>：')
  })

  // 赤枠は「データが残らない」と「ファイルの権限」の2つに割ってある
  it('★★ データが残らない話と、ファイルの権限・エキスパートの例外が別の枠になっている', () => {
    expect(publishSection).toContain('<b>アプリが書いたデータは残りません（共用型でも専有型でも変わりません）。</b>')
    expect(publishSection).toContain('<b>公開したアプリが、ファイルをどこまでさわれるか。</b>')
    // 1つの枠に戻っていないこと（データの話の枠に、権限の話が入っていない）
    const at = publishSection.indexOf('<b>アプリが書いたデータは残りません')
    const box = publishSection.slice(at, publishSection.indexOf('</div>', at))
    expect(box, 'データの枠に権限の話が戻っている').not.toContain('書き換えも削除もできません')
  })

  // 同じ説明を続けて2回言わない（リードと本文が同語反復になっていた）
  it('★★ 応答の確認のリードと本文が、同じことを2回言っていない', () => {
    expect(publishSection, '同語反復のリードが戻っている')
      .not.toContain('公開できたかどうかを、Koto が確かめます</b>：公開が終わると、Koto はアプリが本当に応答しているかを確認します')
  })

  // ③公開の節のリード（太字の見出し代わり）は名詞句にそろえてある。
  // **文体は網羅して固定しない**（書き換えのたびに落ちるだけなので）。D-14 で直した3つだけを、
  // 元の「文」の形に戻っていないことで見る。
  // D-15（2026-09-16）: 専有型だけの話（DNS の A レコードを向ける／アプリが応答しているかの確認）は
  // 独立した節「さくらのAppRun 専有型（上級者向け）」へ移した。見出しが名詞句のままであることを
  // 確かめたいのが趣旨なので、③に限らずガイド全体（guide）で見る（公開先の変更は③に残っている）。
  it('★★ D-14 で名詞句にそろえた3つのリードが、文の形に戻っていない', () => {
    expect(guide).not.toContain('<b>公開したら、DNS の A レコードを向けます</b>')
    expect(guide).not.toContain('<b>公開できたかどうかを、Koto が確かめます</b>')
    expect(guide).not.toContain('<b>公開先は後から変えられます</b>')
    expect(guide).toContain('<b>DNS の A レコードを向ける</b>')
    expect(guide).toContain('<b>アプリが応答しているかの確認</b>')
    expect(publishSection).toContain('<b>公開先の変更</b>')
  })
})

// ── D-14: 使い方ガイドの HTML が壊れていない（入れ子の箇条書き・枠を割ったので）─────────────
//
// 今回、箇条書きを入れ子にし、赤枠を2つに割った。**タグの対応を崩すと画面が崩れる**が、
// ガイドは誰も型検査にかけないので、ここで構造だけを見る（文言は上の describe が見る）。
describe('D-14: docs/usage-guide.html のタグの対応が崩れていない', () => {
  const guide = readFileSync(join(__dirname, '..', 'docs/usage-guide.html'), 'utf-8')

  it('★★ 入れ子を含めて、開始タグと終了タグが対応している（section・div・ul・ol・li・p）', () => {
    const VOID = new Set(['br', 'hr', 'img', 'meta', 'link', 'input'])
    const WATCH = new Set(['section', 'div', 'ul', 'ol', 'li', 'p', 'table', 'tr', 'td', 'th'])
    const stack: string[] = []
    const errors: string[] = []
    for (const m of guide.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g)) {
      const [, closing, rawName, selfClose] = m
      const name = rawName.toLowerCase()
      if (!WATCH.has(name)) continue
      if (VOID.has(name) || selfClose === '/') continue
      if (closing) {
        const top = stack.pop()
        if (top !== name) errors.push(`</${name}> の相手が ${top ?? '無い'}（${m.index}文字目）`)
      } else {
        stack.push(name)
      }
    }
    expect(errors, `タグの対応が崩れている:\n${errors.join('\n')}`).toEqual([])
    expect(stack, `閉じられていないタグが残っている: ${stack.join(', ')}`).toEqual([])
  })
})

// ── G-2/G-3（2026-09-16）: 証明書の確かめ方の案内と、「自動で発行します」という断定を
// 実測に合わせる。2026-09-16 の実測では、メールも設定済み・ポートも 80/443 の両方があった
// のに一度も証明書が発行されなかった（docs/apprun-dedicated-plan.md 10章「証明書が出なかった
// 件」）。にもかかわらず README・usage-guide・CHANGELOG は「Let's Encrypt が自動で発行します」
// と言い切っていた。掟1「確かめていないことは断定しない」にならい、
// 「仕組みとしてはそうなっているが、確認はこれから」という書き方に直した。
// あわせて、Koto は証明書を一度も見ていない（確認の段を足すかは未定・実装しない）ので、
// せめて「さくらのコントロールパネルの証明書情報で確かめる」案内を文書に足した。
describe('G-2/G-3: 証明書の確かめ方の案内と、「自動で発行します」という断定をやめる', () => {
  const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf-8')
  const guide = readFileSync(join(__dirname, '..', 'docs/usage-guide.html'), 'utf-8')
  const changelogAll = readFileSync(join(__dirname, '..', 'CHANGELOG.md'), 'utf-8')
  const unreleased = newestChangelogSection(changelogAll)

  it('★★ README と使い方ガイドに、コントロールパネルの「証明書情報」で確かめる案内がある', () => {
    for (const [name, src] of [['README', readme], ['usage-guide', guide]] as const) {
      expect(src, `${name}: 証明書情報の案内が無い`).toContain('証明書情報')
      expect(src, `${name}: https で開けないときの案内が無い`).toContain('https で開けないときは')
    }
  })

  it('★★ 「自動で発行します」という断定が、3つの文書のどれにも残っていない（直す前の形）', () => {
    for (const [name, src] of [['README', readme], ['usage-guide', guide], ['CHANGELOG［最新の節］', unreleased]] as const) {
      expect(src, `${name}: 断定に戻っている`).not.toContain('自動で発行します')
    }
  })

  it('★★ 3つの文書とも「実際に発行されるところは、まだ確認できていません」と書く（仕組みとしてはそうなっているが確認はこれから）', () => {
    for (const [name, src] of [['README', readme], ['usage-guide', guide], ['CHANGELOG', unreleased]] as const) {
      expect(src, `${name}: 実際に発行されるかの断りが無い`).toContain('実際に発行されるところは、まだ確認できていません')
    }
  })

  it('★★ 「発行されません」とも書いていない（それも確かめていない・掟1）', () => {
    for (const [name, src] of [['README', readme], ['usage-guide', guide], ['CHANGELOG', unreleased]] as const) {
      expect(src, `${name}: 「発行されません」と断定している`).not.toContain('発行されません')
    }
  })

  it('★★ 証明書詳細画面の中身（コモンネーム・SANs等）を非エンジニア向け文書に書いていない', () => {
    for (const [name, src] of [['README', readme], ['usage-guide', guide]] as const) {
      expect(src, `${name}: 内部用語が出ている`).not.toMatch(/コモンネーム|SANs?/)
    }
  })
})
