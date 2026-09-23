import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// D-4「⑧ アプリを公開する」の IPC 3点セット（掟6: main / preload / global.d.ts）と、
// handler の歯止め（掟10: confirmed は isConfirmed(opts) から渡し、固定 true を書かない）を固定する。
//
// electron に依存するファイルは import できないので、ソースを読んで配線を確かめる
// （tests/apprunDedicatedWiring.test.ts と同じ流儀）。当て先は**呼び出しの形そのもの**を書き、
// 「どこかに書いてある」では通らないようにする（2026-08-20 の教訓）。
// 変異(b)「handler が confirmed: true を固定で渡す」は、このファイルの
// `not.toContain('confirmed: true')` と呼び出し行の exact 一致の両方で捕まえる。

const ipc = readFileSync(join(__dirname, '..', 'src/main/ipc/apprunDedicated.ts'), 'utf-8')
const preload = readFileSync(join(__dirname, '..', 'src/main/preload.ts'), 'utf-8')
const globalDts = readFileSync(join(__dirname, '..', 'src/renderer/global.d.ts'), 'utf-8')
const appApply = readFileSync(join(__dirname, '..', 'src/main/cloud/apprunDedicatedAppApply.ts'), 'utf-8')
const publishMeta = readFileSync(join(__dirname, '..', 'src/shared/publishMeta.ts'), 'utf-8')

/**
 * コメント（// と ..) を取り除いた「コードだけ」を返す。
 *
 * ── なぜ要るか（2026-09-16・掟10 の罠にそのまま掛かった）──────────────
 * 下の「readLoadBalancerNodeAddresses を直接呼ばない」は、**ファイル冒頭の依存一覧コメント**に
 * 同じ名前が書いてあるだけで落ちた。当て先が本当にコードかどうかを確かめずに not.toContain を
 * 書くと、コメントの書き換えでテストが壊れ、逆に**コードの複製は見逃す**。
 * 他のテスト（appSessionsWiring / approvalWiring など）と同じ形で剥がしてから当てる。
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n')
}

/** `ipcMain.handle('<channel>'` から、その handler の閉じ `\n  })` までを切り出す。 */
function handlerBlock(channel: string): string {
  const at = ipc.indexOf(`ipcMain.handle('${channel}'`)
  expect(at, `${channel} の handler が無い`).toBeGreaterThan(0)
  const end = ipc.indexOf('\n  })', at)
  expect(end).toBeGreaterThan(at)
  return ipc.slice(at, end)
}

describe('main: apprunDedicated:appStatus / publishApp / teardownApp の3つを登録している（D-4）', () => {
  it('3つの ipcMain.handle がある', () => {
    expect(ipc).toContain("ipcMain.handle('apprunDedicated:appStatus'")
    expect(ipc).toContain("ipcMain.handle('apprunDedicated:publishApp'")
    expect(ipc).toContain("ipcMain.handle('apprunDedicated:teardownApp'")
  })

  it('publishApp の進捗は event.sender.send で apprunDedicated:publish-progress を流す（teardown-progress と同じ形）', () => {
    const block = handlerBlock('apprunDedicated:publishApp')
    expect(block).toContain("event.sender.send('apprunDedicated:publish-progress', msg)")
  })

  it('部品は複製せず import している（publishAppFlow / prepareAppImage / specStore / publishMetaFs）', () => {
    expect(ipc).toContain("import { publishAppFlow } from '../cloud/apprunDedicatedAppApply'")
    expect(ipc).toContain("import { prepareAppImage } from '../cloud/imagePublish'")
    expect(ipc).toContain("import { loadCloudSpec, loadCloudState } from '../cloud/specStore'")
    expect(ipc).toContain("import { readApprunDedicatedFs, markPendingFs, clearPendingFs, writePublishRecordFs } from '../publishMetaFs'")
    expect(ipc).toContain("import { readHasLetsEncryptEmail } from '../../shared/apprunDedicatedShapes'")
    expect(ipc).toContain("import { deriveApplicationName } from '../../shared/apprunDedicatedApp'")
  })
})

describe('main: publishApp の歯止め（掟10）', () => {
  const block = handlerBlock('apprunDedicated:publishApp')

  it('★ confirmed は isConfirmed(opts) から渡す（呼び出し行の exact 一致）。固定 true はファイル全体に無い（変異b）', () => {
    expect(block).toContain('const result = await publishAppFlow(auth, projectDir, {')
    expect(block).toContain('}, { confirmed: isConfirmed(opts), progress })')
    expect(ipc).not.toContain('confirmed: true')
  })

  it('★ 確認を通っていなければ、イメージの組み立て（レジストリへの push）にも入らない（早期の consent ゲート）', () => {
    const gate = block.indexOf("if (!isConfirmed(opts)) return { ok: false, stage: 'consent'")
    const image = block.indexOf('await prepareAppImage(')
    expect(gate).toBeGreaterThan(0)
    expect(image).toBeGreaterThan(gate)
  })

  it('★ prepareAppImage の失敗は stage:image で返し、publishAppFlow を呼ばない（return が先にある）', () => {
    const image = block.indexOf('const img = await prepareAppImage({ projectDir, spec, state, creds: auth, progress })')
    const fail = block.indexOf('if (!img.ok) {')
    const failReturn = block.indexOf("ok: false, stage: 'image', message: img.message,", fail)
    const flow = block.indexOf('await publishAppFlow(')
    expect(image).toBeGreaterThan(0)
    expect(fail).toBeGreaterThan(image)
    expect(failReturn).toBeGreaterThan(fail)
    expect(flow).toBeGreaterThan(failReturn)
    // 回復の導線（レジストリを設定し直す）の印を落とさない（2026-08-14 の教訓・全経路に出す）
    expect(block).toContain('...(img.hint ? { hint: img.hint } : {})')
  })

  it('creds は引数 auth（方式B・掟4）。main 保存の loadCredentials は使わない', () => {
    expect(block).toContain('creds: auth')
    expect(ipc).not.toContain('loadCredentials(')
  })

  it('★ 開始マーカー → try → 成功時に公開記録 → finally で後片づけ（roadmap #20・publishMetaWiring と同じ形）', () => {
    expect(block).toContain("markPendingFs(projectDir, 'sakura-apprun-dedicated')")
    expect(block).toContain("writePublishRecordFs(projectDir, 'sakura-apprun-dedicated', { publishedAt: new Date().toISOString(), url: result.url ?? null })")
    expect(block).toMatch(/finally\s*\{\s*(\/\/[^\n]*\n\s*)?clearPendingFs\(projectDir\)/)
    // 記録は ok のときだけ
    const okAt = block.indexOf('if (result.ok) {')
    expect(okAt).toBeGreaterThan(0)
    expect(block.indexOf("writePublishRecordFs(projectDir, 'sakura-apprun-dedicated'")).toBeGreaterThan(okAt)
  })

  it('env.json が無ければ stage:invalid で案内する（仕様書 D-4 1-3 の文言）', () => {
    expect(block).toContain("if (!spec) return { ok: false, stage: 'invalid', message: '公開の設定（env.json）がありません。⑧の「公開の設定を作る」を押してから、もう一度お試しください' }")
  })

  it('形の検査 isAppPublishInput は host: string／cpu・memory・fixedScale: 整数／任意の2項目は undefined か string', () => {
    expect(block).toContain("if (!isAppPublishInput(input)) return { ok: false, stage: 'invalid', message: '入力が不正です' }")
    expect(ipc).toContain("typeof s.host === 'string'")
    expect(ipc).toContain('Number.isInteger(s.cpu) && Number.isInteger(s.memory) && Number.isInteger(s.fixedScale)')
    expect(ipc).toContain("(s.healthCheckPath === undefined || typeof s.healthCheckPath === 'string')")
    expect(ipc).toContain("(s.letsEncryptEmail === undefined || typeof s.letsEncryptEmail === 'string')")
  })
})

describe('main: teardownApp は teardownFlow の appOnly を confirmed 付きで呼ぶ', () => {
  it('★ 呼び出し行の exact 一致（confirmed は isConfirmed(opts) から・appOnly: true）', () => {
    const block = handlerBlock('apprunDedicated:teardownApp')
    // H-1（2026-09-17）: 破棄と公開を同時に走らせないため、本体は withProjectLock に包まれた。
    expect(block).toContain("withProjectLock(projectDir, '削除', () =>")
    expect(block).toContain('teardownFlow(auth, projectDir, { confirmed: isConfirmed(opts), progress, appOnly: true })')
    // 既存の⑥（全部破棄）の呼び出しはそのまま（appOnly が付いていない）
    expect(ipc).toContain('teardownFlow(auth, projectDir, { confirmed: isConfirmed(opts), progress }))')
  })
})

describe('main: appStatus は GET のみ（clusterID と auth があるときだけ getCluster）', () => {
  it('getCluster を import し、記録に clusterID があり isCreds(auth) のときだけ呼ぶ。読めない env.json は ok:false', () => {
    const block = handlerBlock('apprunDedicated:appStatus')
    expect(ipc).toContain('getCluster, type ApprunDedicatedResult } from \'../cloud/apprunDedicated\'')
    expect(block).toContain('if (record.clusterID && isCreds(auth)) {')
    expect(block).toContain('const r = await getCluster(auth, record.clusterID)')
    expect(block).toContain('hasLetsEncryptEmail = r.ok ? readHasLetsEncryptEmail(r.data) : null')
    expect(block).toContain('spec = loadCloudSpec(projectDir)')
    expect(block).toContain('envReady: !!spec,')
    // 何も作らない・何も書かない
    for (const w of ['createApplication', 'markPendingFs', 'writePublishRecordFs', 'writeApprunDedicatedRecordFs']) {
      expect(block).not.toContain(w)
    }
  })
})

describe('preload: electronAPI.apprunDedicated.{appStatus,publishApp,teardownApp,onPublishProgress} を公開している', () => {
  it('4項目の行が exact にある', () => {
    expect(preload).toContain("appStatus: (projectDir: string, auth: { token: string; secret: string }) => ipcRenderer.invoke('apprunDedicated:appStatus', projectDir, auth)")
    expect(preload).toContain("publishApp: (projectDir: string, auth: { token: string; secret: string }, input: AppPublishInput, opts?: { confirmed?: boolean }) =>")
    expect(preload).toContain("ipcRenderer.invoke('apprunDedicated:publishApp', projectDir, auth, input, opts)")
    expect(preload).toContain("teardownApp: (projectDir: string, auth: { token: string; secret: string }, opts?: { confirmed?: boolean }) =>")
    expect(preload).toContain("ipcRenderer.invoke('apprunDedicated:teardownApp', projectDir, auth, opts)")
    expect(preload).toContain("onPublishProgress: (cb: (msg: string) => void) => {")
    expect(preload).toContain("ipcRenderer.on('apprunDedicated:publish-progress', handler)")
    expect(preload).toContain("ipcRenderer.removeListener('apprunDedicated:publish-progress', handler)")
  })

  it('AppPublishInput は main の ipc から type-only で import する（値の import で preload を膨らませない）', () => {
    expect(preload).toContain("import type { AppPublishInput } from './ipc/apprunDedicated'")
    expect(ipc).toContain('export type AppPublishInput = {')
  })
})

describe('global.d.ts: Window.electronAPI.apprunDedicated の型に4項目がある（import 0行のまま）', () => {
  it('4つのシグネチャ', () => {
    expect(globalDts).toContain('appStatus(projectDir: string, auth: { token: string; secret: string }): Promise<')
    expect(globalDts).toContain('| { ok: true; hasLetsEncryptEmail: boolean | null; envReady: boolean; port: number | null; envCount: number; record: ApprunDedicatedRecordShape }')
    expect(globalDts).toContain('publishApp(projectDir: string, auth: { token: string; secret: string }, input: {')
    expect(globalDts).toContain('teardownApp(projectDir: string, auth: { token: string; secret: string }, opts?: { confirmed?: boolean }): Promise<{')
    expect(globalDts).toContain('onPublishProgress(cb: (msg: string) => void): () => void')
  })

  // D-4f（掟10・複製しない）: 手書きの文字列リテラル union をやめ、main（apprunDedicatedAppApply.ts）の
  // PublishAppStage を import(...) 型でそのまま使う（renderer の tsconfig で解決できることを実測済み）。
  // 「全段（image を含む）と同じ並び」は、この import 経由で TypeScript が保証する
  // （画面の Record<PublishAppStage, string> の網羅チェックも同じ理由で型検査に委ねる）。
  it('publishApp の stage は main の PublishAppStage を import(...) 型でそのまま使う（手書きの union を複製していない）', () => {
    expect(globalDts).toContain("stage: import('../main/cloud/apprunDedicatedAppApply').PublishAppStage")
    expect(globalDts).not.toContain("stage: 'consent' | 'no-cluster'")
    expect(globalDts).toContain("hint?: 'reset-registry'")
    // import 先の main 側に 'image'・'storage' を含む全段が定義されている（唯一の定義）。
    expect(appApply).toContain(
      "export type PublishAppStage =\n  | 'consent' | 'no-cluster' | 'invalid' | 'record' | 'lets-encrypt' | 'cluster-ports' | 'app-lookup'\n  | 'name-taken' | 'app-create' | 'version-create' | 'activate' | 'cleanup' | 'lb-address' | 'image'",
    )
    // 2026-09-23 検分の指摘12: 鍵を渡せずに止めた段。'invalid'（画面では「入力の検証」）に混ぜない。
    expect(appApply).toContain("| 'storage' | 'done'")
  })

  it('teardownApp の remaining/inProgress に applicationID がある', () => {
    const at = globalDts.indexOf('teardownApp(projectDir: string')
    const block = globalDts.slice(at, globalDts.indexOf('onPublishProgress(cb:', at))
    expect(block).toContain('remaining: { applicationID?: string; loadBalancerID?: string; asgID?: string; clusterID?: string }')
    expect(block).toContain('inProgress?: { applicationID?: string; loadBalancerID?: string; asgID?: string; clusterID?: string }')
  })

  // D-4f（掟10・複製しない）: フィールドの手書きをやめ、shared/publishMeta.ts の
  // ApprunDedicatedRecord を import(...) 型でそのまま使う（D-1 の11項目はそちらの唯一の定義で持つ）。
  it('記録の形は shared/publishMeta.ts の ApprunDedicatedRecord を import(...) 型でそのまま使い、state() と appStatus().record の両方に使う', () => {
    expect(globalDts).toContain("type ApprunDedicatedRecordShape = import('../shared/publishMeta').ApprunDedicatedRecord")
    expect(globalDts).not.toContain('interface ApprunDedicatedRecordShape {')
    expect(globalDts).toContain('state(projectDir: string): Promise<ApprunDedicatedRecordShape>')
    for (const k of ['applicationID', 'applicationName', 'activeVersion', 'imageRef', 'hosts', 'appPort', 'appCpu', 'appMemory', 'appFixedScale', 'lbAddresses', 'appPublishedAt']) {
      expect(publishMeta).toContain(`  ${k}?: `)
    }
    // ambient 宣言のまま（トップレベル import を1行でも書くとモジュール扱いになり Window の拡張が壊れる。
    // 型位置のインライン import(...) はトップレベル import ではないため対象外）。
    expect(globalDts).not.toMatch(/^import /m)
  })
})

describe('PublishAppStage に image がある（画面の Record<PublishAppStage, string> が全段必須になる）', () => {
  it("apprunDedicatedAppApply.ts の union に 'image' と 'storage' が含まれる", () => {
    expect(appApply).toContain("| 'name-taken' | 'app-create' | 'version-create' | 'activate' | 'cleanup' | 'lb-address' | 'image'")
    expect(appApply).toContain("| 'storage' | 'done'")
  })
})

// ── D-5（2026-09-16）: ⑧「🔄 IP を取り直す」の IPC 3点セット apprunDedicated:lbAddresses ──────────
// 判断（記録の ID で GET 1回・素の IP を記録・空なら上書きしない）は cloud/apprunDedicatedAppApply.ts の
// refreshLbAddresses に一元化してあり、その振る舞いは tests/apprunDedicatedAppApply.test.ts が偽サーバで固定する。
// ここは「main / preload / global.d.ts の3点が揃い、handler が形の検査のあと refreshLbAddresses に委譲する」を固定する。
describe('IPC 3点セット（掟6）: apprunDedicated:lbAddresses（⑧「🔄 IP を取り直す」・D-5）', () => {
  it('main: ipcMain.handle があり、projectDir と auth の形を検査してから refreshLbAddresses(auth, projectDir) を返す', () => {
    const block = handlerBlock('apprunDedicated:lbAddresses')
    expect(block).toContain("ipcMain.handle('apprunDedicated:lbAddresses', async (_, projectDir: unknown, auth: unknown) => {")
    expect(block).toContain("if (typeof projectDir !== 'string' || !projectDir) return { ok: false, message: 'プロジェクトフォルダが不正です' }")
    expect(block).toContain("if (!isCreds(auth)) return { ok: false, message: 'クラウドのAPIキーが未登録です' }")
    expect(block).toContain('return refreshLbAddresses(auth, projectDir)')
    // 何も作らない・公開の段取りには入らない・独自に一覧を読まない（判断を複製しない）
    for (const w of ['publishAppFlow', 'prepareAppImage', 'createApplication', 'markPendingFs', 'writePublishRecordFs', 'listLoadBalancerNodes', 'readLoadBalancerNodeAddresses']) {
      expect(block).not.toContain(w)
    }
  })

  it('main: refreshLbAddresses は cloud/apprunDedicatedAppApply.ts から import する（publishAppFlow の import 行は据え置き）', () => {
    expect(ipc).toContain("import { refreshLbAddresses } from '../cloud/apprunDedicatedAppApply'")
    expect(ipc).toContain("import { publishAppFlow } from '../cloud/apprunDedicatedAppApply'")
    expect(appApply).toContain('export async function refreshLbAddresses(')
  })

  it('preload: electronAPI.apprunDedicated.lbAddresses(projectDir, auth) → invoke（exact）', () => {
    expect(preload).toContain("lbAddresses: (projectDir: string, auth: { token: string; secret: string }) => ipcRenderer.invoke('apprunDedicated:lbAddresses', projectDir, auth)")
  })

  it('global.d.ts: lbAddresses の型は { ok: true; lbAddresses: string[] } | { ok: false; message: string }', () => {
    expect(globalDts).toContain('lbAddresses(projectDir: string, auth: { token: string; secret: string }): Promise<')
    const at = globalDts.indexOf('lbAddresses(projectDir: string, auth: { token: string; secret: string }): Promise<')
    const block = globalDts.slice(at, at + 200)
    expect(block).toContain('| { ok: true; lbAddresses: string[] }')
    expect(block).toContain('| { ok: false; message: string }')
  })

  it('★ 素の IP への変換は shared の bareIp／collectBareLbAddresses が唯一の定義で、publishAppFlow と refreshLbAddresses の両方がそれを使う（`/24` を落とす処理を複製しない）', () => {
    const shared = readFileSync(join(__dirname, '..', 'src/shared/apprunDedicatedApp.ts'), 'utf-8')
    expect(shared).toContain('export function bareIp(address: string): string {')
    expect(shared).toContain('export function collectBareLbAddresses(data: unknown): string[] {')
    expect(appApply).toContain('collectBareLbAddresses, missingRequiredPorts,')
    expect((appApply.match(/collectBareLbAddresses\(lbNodesRes\.data\)/g) ?? []).length).toBe(2)
    // 直す前の形（ネットマスク付きのまま集める）を禁じる。
    // **コメントを剥がしたコードだけに当てる**（冒頭の依存一覧コメントに名前が出るため）。
    const appApplyCode = codeOnly(appApply)
    expect(appApplyCode).toContain('collectBareLbAddresses(lbNodesRes.data)')
    expect(appApplyCode).not.toContain('r.addresses.map(a => a.address)')
    expect(appApplyCode).not.toContain('readLoadBalancerNodeAddresses')
  })
})

// ── O-1（2026-09-17）: ⑧「🔎 公開先と https を確かめる」の IPC 3点セット apprunDedicated:checkSite ──
//
// 2026-09-16〜17 の観測: 証明書が一度も発行されていないのに「✅ 公開しました」と出していた
// （Koto は証明書を一度も見ていなかった）。さくらの API には証明書の状態を読む手段が無いので、
// main が実際に繋いで確かめる。**⑧の公開直後の確認（verify）には足せない**——あれは DNS を
// 向ける前に走り、その時点では仮の証明書しか存在し得ない（時間軸が違う）。別の口にしてある。
//
// 判断（4つの軸の決め方・画面に出す行）は shared/publishVerify.ts の純関数にあり、
// tests/publishVerify.test.ts が固定する。繋いで読む側は tests/dedicatedSiteCheck.test.ts が
// 偽物を差し込んで固定する。ここは「3点が揃い、handler が形の検査のあと委譲する」を固定する。
describe('IPC 3点セット（掟6）: apprunDedicated:checkSite（⑧「🔎 公開先と https を確かめる」・O-1）', () => {
  it('★★ main: ipcMain.handle があり、projectDir の形を検査してから checkDedicatedSite(projectDir) を返す', () => {
    const block = handlerBlock('apprunDedicated:checkSite')
    expect(block).toContain("ipcMain.handle('apprunDedicated:checkSite', async (_, projectDir: unknown) => {")
    expect(block).toContain("if (typeof projectDir !== 'string' || !projectDir) return { ok: false, message: 'プロジェクトフォルダが不正です' }")
    expect(block).toContain('return checkDedicatedSite(projectDir)')
    // 読むだけ・何も作らない・公開の段取りには入らない・判断を複製しない
    for (const w of ['publishAppFlow', 'prepareAppImage', 'markPendingFs', 'writePublishRecordFs', 'withProjectLock', 'judgePeerCertificate', 'tls.connect']) {
      expect(block, `checkSite の handler に ${w} が出ている`).not.toContain(w)
    }
  })

  it('★★ main: 鍵を受け取らない（さくらの API を呼ばない・読むだけ。要らない鍵を渡さない＝掟4）', () => {
    const block = handlerBlock('apprunDedicated:checkSite')
    expect(block).not.toContain('auth')
    expect(block).not.toContain('isCreds')
  })

  it('main: checkDedicatedSite は cloud/dedicatedSiteCheck.ts から import する', () => {
    expect(ipc).toContain("import { checkDedicatedSite } from '../cloud/dedicatedSiteCheck'")
    const siteCheck = readFileSync(join(__dirname, '..', 'src/main/cloud/dedicatedSiteCheck.ts'), 'utf-8')
    expect(siteCheck).toContain('export async function checkDedicatedSite(')
    expect(siteCheck).toContain('export async function runSiteCheck(')
  })

  it('★★ preload: electronAPI.apprunDedicated.checkSite(projectDir) → invoke（exact）', () => {
    expect(preload).toContain("checkSite: (projectDir: string) => ipcRenderer.invoke('apprunDedicated:checkSite', projectDir)")
  })

  it('★★ global.d.ts: checkSite の型がある（lines は画面にそのまま並べる行）', () => {
    expect(globalDts).toContain('checkSite(projectDir: string): Promise<')
    const at = globalDts.indexOf('checkSite(projectDir: string): Promise<')
    const block = globalDts.slice(at, at + 900)
    expect(block).toContain('lines: string[]')
    expect(block).toContain("dns: import('../shared/publishVerify').DnsCheck")
    expect(block).toContain("cert: import('../shared/publishVerify').CertCheck")
    expect(block).toContain("httpsOpen: import('../shared/publishVerify').HttpsOpenCheck")
    expect(block).toContain('| { ok: false; message: string }')
  })

  it('★★★ 既にある probeMarkerOverHttps のオプションのキーが増えていない（証明書の読み取りは別の関数である固定）', () => {
    // ⑧の verify 段は DNS を向ける前に走る＝正式な証明書は存在し得ない。そこへ証明書の検査を
    // 混ぜると、必ず失敗して意味のない警告が出続ける。**別の関数・別のボタンにしてある。**
    const appApplyCode = codeOnly(appApply)
    const at = appApplyCode.indexOf('export function probeMarkerOverHttps(')
    expect(at).toBeGreaterThan(0)
    const sig = appApplyCode.slice(at, appApplyCode.indexOf('{', appApplyCode.indexOf('Promise<DedicatedProbe>', at)))
    expect(sig).toContain('args: { ip: string; host: string; path: string; timeoutMs: number }')
    for (const w of ['rejectUnauthorized: true', 'getPeerCertificate', 'checkCert', 'cert:']) {
      expect(sig, `probeMarkerOverHttps の引数に ${w} が増えている`).not.toContain(w)
    }
    // opts.probeMarker の型（tests/apprunDedicatedAppApply.test.ts が固定している形）も据え置き
    expect(appApplyCode).toContain('probeMarker?: (args: { ip: string; host: string; path: string; timeoutMs: number }) => Promise<DedicatedProbe>')
    // 証明書を読むのは別のファイルの別の関数
    const siteCheck = readFileSync(join(__dirname, '..', 'src/main/cloud/dedicatedSiteCheck.ts'), 'utf-8')
    expect(siteCheck).toContain('export function readPeerCertificate(')
    expect(codeOnly(appApply)).not.toContain('getPeerCertificate')
  })

  it('★★ 画面: 確かめるボタンが panelBusy を通る（⑤⑥⑦⑧が走っている間は押せない）', () => {
    const panelSrc = readFileSync(join(__dirname, '..', 'src/renderer/components/AppRunDedicatedPanel.tsx'), 'utf-8')
    const panel = panelSrc
      .split('\n')
      .filter(l => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*') && !l.trimStart().startsWith('/*') && !l.trimStart().startsWith('{/*'))
      .join('\n')
    const BUSY = 'panelBusy({ creating, tearingDown, publishing, lbRefreshing })'
    expect(panel).toContain(`disabled={siteChecking || ${BUSY}}`)
    // 実行の入口（早期 return）も同じ判定を通る
    expect(panel).toContain(`if (siteChecking || ${BUSY}) return`)
    // 直す前の形（自分のフラグしか見ない）を禁じる
    expect(panel).not.toContain('disabled={siteChecking}')
  })

  it('★★ 画面: 文言と、押す時機の案内が出ている（DNS を設定したあと）', () => {
    const panel = readFileSync(join(__dirname, '..', 'src/renderer/components/AppRunDedicatedPanel.tsx'), 'utf-8')
    expect(panel).toContain('🔎 公開先と https を確かめる')
    expect(panel).toContain('DNS を設定したあとに押してください。')
    // 行の組み立ては純関数の結果をそのまま並べる（画面で文を作らない・掟10）
    expect(panel).toContain('window.electronAPI.apprunDedicated.checkSite(projectDir)')
    expect(panel).toContain('setSiteCheckResult(r.lines)')
  })
})
