import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  readTraffics, readVersions, trafficState, buildRollbackBody,
  pinnedNotice, pinnedAfterApplyNotice, servingVersionNames,
  type TrafficRow,
} from '../src/shared/apprunTraffic'

// roadmap #32（ロールバック）。原本 apprun-shared.json v1.5.0 で確認した応答の形が唯一の正
// （CLAUDE.md 掟1）。**形が違えば空配列を返す。よくあるキーを順に試す推測は書かない**
// （docs/apprun-dedicated-plan.md 5-8 の事故と同じ形を作らないため）。

describe('readTraffics: GET /applications/{id}/traffics は { data: [...] }（原本 v1.5.0）', () => {
  it('実物の形から読める', () => {
    const data = {
      data: [
        { is_latest_version: true, percent: 100, version_name: 'v3' },
      ],
      meta: {},
    }
    expect(readTraffics(data)).toEqual([
      { versionName: 'v3', percent: 100, isLatest: true },
    ])
  })

  it('複数行（A/Bテスト中のような形）も読める', () => {
    const data = { data: [
      { is_latest_version: false, percent: 70, version_name: 'v3' },
      { is_latest_version: false, percent: 30, version_name: 'v2' },
    ] }
    expect(readTraffics(data)).toEqual([
      { versionName: 'v3', percent: 70, isLatest: false },
      { versionName: 'v2', percent: 30, isLatest: false },
    ])
  })

  it('★事故の再現防止: 別のキー（traffics/items等）は拾わない。data が無ければ空配列', () => {
    expect(readTraffics({ traffics: [{ percent: 100, version_name: 'v3' }] })).toEqual([])
    expect(readTraffics({ items: [{ percent: 100 }] })).toEqual([])
    expect(readTraffics({})).toEqual([])
  })

  it('data が配列でない・応答が壊れていても落ちない（空配列）', () => {
    expect(readTraffics({ data: {} })).toEqual([])
    expect(readTraffics(null)).toEqual([])
    expect(readTraffics(undefined)).toEqual([])
    expect(readTraffics('not an object')).toEqual([])
  })

  it('percent が数値でない・version_name が無い行は、推測で補正せず既定値にする', () => {
    expect(readTraffics({ data: [{ percent: '100', is_latest_version: true }] }))
      .toEqual([{ versionName: null, percent: 0, isLatest: true }])
  })
})

describe('readVersions: GET /applications/{id}/versions は { data: [...] }（原本 v1.5.0）', () => {
  it('実物の形から読める', () => {
    const data = {
      data: [
        { created_at: '2026-09-01T00:00:00Z', id: 'ver-1', name: 'v3', status: 'Active' },
        { created_at: '2026-08-20T00:00:00Z', id: 'ver-0', name: 'v2', status: 'Inactive' },
      ],
      meta: {},
    }
    expect(readVersions(data)).toEqual([
      { id: 'ver-1', name: 'v3', status: 'Active', createdAt: '2026-09-01T00:00:00Z' },
      { id: 'ver-0', name: 'v2', status: 'Inactive', createdAt: '2026-08-20T00:00:00Z' },
    ])
  })

  it('★事故の再現防止: 別のキー（versions/items等）は拾わない。data が無ければ空配列', () => {
    expect(readVersions({ versions: [{ id: 'x' }] })).toEqual([])
    expect(readVersions({ items: [{ id: 'x' }] })).toEqual([])
    expect(readVersions({})).toEqual([])
  })

  it('data が配列でない・応答が壊れていても落ちない（空配列）', () => {
    expect(readVersions({ data: 'x' })).toEqual([])
    expect(readVersions(null)).toEqual([])
    expect(readVersions(undefined)).toEqual([])
  })
})

describe('trafficState: いまの配分を3つに分類する（latest / pinned / split）', () => {
  it('latest: is_latest_version の行だけが100%', () => {
    const rows: TrafficRow[] = [{ versionName: 'v3', percent: 100, isLatest: true }]
    expect(trafficState(rows)).toEqual({ kind: 'latest' })
  })

  it('pinned: 特定バージョン名の行だけが100%（is_latest ではない）', () => {
    const rows: TrafficRow[] = [{ versionName: 'v2', percent: 100, isLatest: false }]
    expect(trafficState(rows)).toEqual({ kind: 'pinned', versionName: 'v2' })
  })

  it('split: 複数行に分かれている（A/Bテスト中など）', () => {
    const rows: TrafficRow[] = [
      { versionName: 'v3', percent: 70, isLatest: false },
      { versionName: 'v2', percent: 30, isLatest: false },
    ]
    expect(trafficState(rows)).toEqual({ kind: 'split' })
  })

  it('★分からないものを「最新追従」に倒さない: 行が0件（読めない）は split', () => {
    expect(trafficState([])).toEqual({ kind: 'split' })
  })

  it('★分からないものを「最新追従」に倒さない: 単独100%でも is_latest でも名前でもない行は split', () => {
    const rows: TrafficRow[] = [{ versionName: null, percent: 100, isLatest: false }]
    expect(trafficState(rows)).toEqual({ kind: 'split' })
  })

  it('★分からないものを「最新追従」に倒さない: 単独行が100%に満たない（中途半端な形）は split', () => {
    const rows: TrafficRow[] = [{ versionName: 'v3', percent: 80, isLatest: true }]
    expect(trafficState(rows)).toEqual({ kind: 'split' })
  })

  it('percent が0の行は「配分されていない」として無視する（latestの判定に影響しない）', () => {
    const rows: TrafficRow[] = [
      { versionName: 'v3', percent: 100, isLatest: true },
      { versionName: 'v1', percent: 0, isLatest: false },
    ]
    expect(trafficState(rows)).toEqual({ kind: 'latest' })
  })
})

describe('buildRollbackBody: PUT /applications/{id}/traffics の本文', () => {
  it('バージョン名を渡すと、そのバージョンへ100%固定する本文になる', () => {
    expect(buildRollbackBody('v2')).toEqual([{ version_name: 'v2', percent: 100 }])
  })

  // ★変異試験⑤: null を渡すと version_name ではなく is_latest_version:true を送る本文になる
  // （★2026-09-08 検分で訂正: 固定は Koto の再公開で必ず解除される。「最新に追従」へ
  // 戻すこのボタンは、公開せずに固定だけ解除したい場面のために残している）。
  it('null を渡すと「最新に追従」へ戻す本文になる（version_name ではない）', () => {
    expect(buildRollbackBody(null)).toEqual([{ is_latest_version: true, percent: 100 }])
  })
})

// 画面に出す文言。★2026-09-08 検分で訂正: 以前は「戻したままだと公開しても反映されない」
// という誤った前提の文言だった（確かめずに断定していた）。事実（公開し直せば固定は
// 解除される）を伝える文言に直した。
describe('画面に出す文言（pinnedNotice・pinnedAfterApplyNotice）', () => {
  it('pinnedNotice: 訪問者に固定した版が見えていることと、公開し直せば最新に戻ることを必ず含む', () => {
    const msg = pinnedNotice('v2')
    expect(msg).toContain('v2')
    expect(msg).toContain('訪問者にはこのバージョンが見えています')
    expect(msg).toContain('公開し直すと')
    expect(msg).toContain('最新のバージョンに戻ります')
    // ★事故の再現防止: 「公開しても反映されない」という誤った断定を書かない
    expect(msg).not.toContain('公開しても反映されません')
  })

  it('pinnedAfterApplyNotice: 「想定と違う状態」であることと、最新に戻すボタンを押す案内を必ず含む', () => {
    const msg = pinnedAfterApplyNotice('v2')
    expect(msg).toContain('v2')
    expect(msg).toContain('想定と違う状態')
    expect(msg).toContain('最新に戻す')
    // ★事故の再現防止: あたかも通常運転であるかのような文言を書かない
    expect(msg).not.toContain('いま公開したものは反映されていません')
  })
})

describe('servingVersionNames: バージョン一覧に「配信中」を付けるための材料', () => {
  it('配分が乗っている（percent>0）行の名前だけを返す', () => {
    const rows: TrafficRow[] = [
      { versionName: 'v3', percent: 100, isLatest: true },
      { versionName: 'v1', percent: 0, isLatest: false },
    ]
    expect(servingVersionNames(rows)).toEqual(['v3'])
  })

  it('名前が無い行は含めない', () => {
    const rows: TrafficRow[] = [{ versionName: null, percent: 100, isLatest: true }]
    expect(servingVersionNames(rows)).toEqual([])
  })
})

// ── IPC 3点セット（掟6）: main / preload / global.d.ts が揃っている ──────────────
const cloudIpc = readFileSync(join(__dirname, '..', 'src/main/ipc/cloud.ts'), 'utf-8')
const preload = readFileSync(join(__dirname, '..', 'src/main/preload.ts'), 'utf-8')
const globalDts = readFileSync(join(__dirname, '..', 'src/renderer/global.d.ts'), 'utf-8')
const panel = readFileSync(join(__dirname, '..', 'src/renderer/components/AppRunPanel.tsx'), 'utf-8')
const rollbackSection = readFileSync(join(__dirname, '..', 'src/renderer/components/RollbackSection.tsx'), 'utf-8')

describe('IPC 3点セット（掟6）: cloud:listVersions / getTraffics / rollback', () => {
  it('main: 3つのハンドラを登録し、shared/apprunTraffic.ts の純関数（読み取り2つ）を呼んでいる', () => {
    expect(cloudIpc).toContain("ipcMain.handle('cloud:listVersions'")
    expect(cloudIpc).toContain("ipcMain.handle('cloud:getTraffics'")
    expect(cloudIpc).toContain("ipcMain.handle('cloud:rollback'")
    expect(cloudIpc).toContain("import { readTraffics, readVersions, trafficState } from '../../shared/apprunTraffic'")
    expect(cloudIpc).toContain('readVersions(r.data)')
    expect(cloudIpc).toContain('trafficState(rows)')
  })

  it('main: listVersions/getTraffics は client の listVersions/getTraffics（GET）を呼ぶ', () => {
    expect(cloudIpc).toContain('client.listVersions(app.id)')
    expect(cloudIpc).toContain('client.getTraffics(app.id)')
  })

  // 2【高】2026-09-08 検分で指摘: cloud:apply / cloud:teardown は main 側で
  // opts.confirmed === true を要求しているのに、cloud:rollback だけ「確認は画面側」と
  // 書いて素通ししていた。実行そのもの（confirmed ガード＋putTraffics）は
  // cloud/rollback.ts の performRollback へ一元化し、**その振る舞い**は
  // tests/rollback.test.ts が偽の client で固定する（ここは配線だけを見る）。
  it('main: rollback は cloud/rollback.ts の performRollback へ委譲し、opts.confirmed をそのまま渡す（true に固定しない）', () => {
    expect(cloudIpc).toContain("import { performRollback } from '../cloud/rollback'")
    expect(cloudIpc).toContain(
      "return await performRollback({ appId: app.id, versionName, confirmed: opts?.confirmed === true, client })",
    )
    // ★事故の再現防止: ここで confirmed を true 固定にしない（画面が何を渡しても常に実行されてしまう）
    expect(cloudIpc).not.toContain('confirmed: true, client })')
  })

  it('preload: electronAPI.cloud.{listVersions,getTraffics,rollback} を公開している。rollback は opts をそのまま invoke へ渡す', () => {
    expect(preload).toContain("listVersions: (projectDir: string) => ipcRenderer.invoke('cloud:listVersions', projectDir)")
    expect(preload).toContain("getTraffics: (projectDir: string) => ipcRenderer.invoke('cloud:getTraffics', projectDir)")
    expect(preload).toContain('rollback: (projectDir: string, versionName: string | null, opts?: { confirmed?: boolean }) =>')
    expect(preload).toContain("ipcRenderer.invoke('cloud:rollback', projectDir, versionName, opts)")
  })

  it('global.d.ts: Window.electronAPI.cloud の型に listVersions/getTraffics/rollback がある。rollback は opts.confirmed を持つ', () => {
    expect(globalDts).toContain('listVersions(projectDir: string): Promise<{ ok: boolean; versions?: CloudVersionRow[]; message?: string }>')
    expect(globalDts).toContain('getTraffics(projectDir: string): Promise<{ ok: boolean; rows?: CloudTrafficRow[]; state?: CloudTrafficState; message?: string }>')
    expect(globalDts).toContain('rollback(projectDir: string, versionName: string | null, opts?: { confirmed?: boolean }): Promise<{ ok: boolean; message?: string }>')
  })
})

// ── 画面: 固定されているときの警告・「最新に戻す」・確認ダイアログ（掟5） ──────────
describe('RollbackSection.tsx: 固定の警告・解除ボタン・確認ダイアログの配線', () => {
  it('固定中（pinned）のときだけ、常時警告を出す（呼び出しの形ごと見る。alreadyPinnedHere の判定とは別物）', () => {
    expect(rollbackSection).toContain("{state?.kind === 'pinned' && (")
    expect(rollbackSection).toContain('pinnedNotice(state.versionName)')
  })

  it('「最新に戻す」ボタンが、固定中の警告ブロックの中にある（doSwitch(null, ...) を呼ぶ）', () => {
    expect(rollbackSection).toContain("void doSwitch(null, '最新のバージョン')")
  })

  it('確認・実行のガードは rollbackSwitch.ts の runSwitch に委譲している（main 側の対の歯止めと同じ設計）', () => {
    expect(rollbackSection).toContain("import { runSwitch } from '../rollbackSwitch'")
    expect(rollbackSection).toContain('const outcome = await runSwitch(')
    expect(rollbackSection).toContain('if (!outcome.proceeded) return')
  })

  it('runSwitch へは本物の window.confirm・window.electronAPI.cloud.rollback を注入している', () => {
    expect(rollbackSection).toContain('confirm: (msg) => window.confirm(msg)')
    expect(rollbackSection).toContain('window.electronAPI.cloud.rollback(projectDir, v, opts)')
  })

  it('split のときの確認文には「配分は失われる」ことを伝える isSplit を渡している（3【中】）', () => {
    expect(rollbackSection).toContain("isSplit: state?.kind === 'split'")
  })

  it('split の見出しは断定せず「判断できませんでした」と伝える（4【低】）', () => {
    expect(rollbackSection).toContain('いまの配分を判断できませんでした（複数のバージョンに分かれている可能性があります）。')
    // ★事故の再現防止: 「A/Bテスト中」と断定する旧文言、「この機能では変更しません」という
    // 実際の挙動（行の「このバージョンに戻す」は押せる）と食い違う旧文言を書かない
    expect(rollbackSection).not.toContain('複数のバージョンに分かれています（A/Bテスト中など）')
    expect(rollbackSection).not.toContain('この機能では変更しません')
  })

  it('見出しは stepNo を受け取り、履歴（🕘）と混同しない絵文字を使う（5・6）', () => {
    expect(rollbackSection).toContain("{stepNo ? `${stepNo} ` : ''}⏪ 公開したものを前のバージョンに戻す")
  })
})

describe('AppRunPanel.tsx: ⑨ RollbackSection は公開済み（appUrl）のときだけ表示', () => {
  it('appUrl && <RollbackSection ... stepNo="⑨" /> の形で埋め込まれている', () => {
    expect(panel).toContain('{appUrl && <RollbackSection projectDir={projectDir} refreshSignal={trafficRefreshSignal} stepNo="⑨" />}')
  })

  // ★変異試験③: 「まだ固定されています」の分岐を消す（例: 条件の頭に `false &&` を足して
  // 死んだ分岐にする）と落ちること。分岐の頭だけを部分一致で見ると、`false && t.ok && …` も
  // 同じ部分文字列を含んでしまい素通りする（掟10「当て先が他の行にも出ないか」と同じ罠）。
  // なので if 文とその中身を、改行込みの1つづきの文字列として見る。
  it('doApply の成功時に配分を取り直し、まだ固定されていれば pinnedAfterApplyNotice を出す（断定せず、読み直した事実を見せる）', () => {
    expect(panel).toContain("import { pinnedAfterApplyNotice } from '../../shared/apprunTraffic'")
    expect(panel).toContain('const t = await window.electronAPI.cloud.getTraffics(projectDir)')
    expect(panel).toContain(
      "          if (t.ok && t.state?.kind === 'pinned') {\n"
      + "            const note = pinnedAfterApplyNotice(t.state.versionName)",
    )
    // ★事故の再現防止: 分岐の頭に false && 等を足して死んだ分岐にする変異を検知する
    expect(panel).not.toContain('false && t.ok')
  })
})
