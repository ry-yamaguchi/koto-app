import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  decideTelemetryAction, decideEnableTelemetry, parseProvisioningState, pickStorageId, hasAppRouting,
  APPRUN_PUBLISHER, APPRUN_VARIANT,
  // 後方互換の薄い皮（kind: 'logs' 固定）も、生きたまま同じ判断を返すことを確かめる
  decideLogAction, pickLogStorageId, hasAppLogRouting, APPRUN_LOG_PUBLISHER, APPRUN_LOG_VARIANT,
  type TelemetryKind,
} from '../src/shared/appLog'

// 2026-08-14 Ryosuke 指摘:「ログが既定では ON になっていない。作った時に ON にできないか」
// 2026-09-08 #30: さくらの開発者の助言「ログとメトリクスは有効にしてて欲しい」でメトリクスへ拡張。
//
// 値はすべて**実アカウントで実測**した（掟1・推測しない）。以下は実際の応答の形。

// `management/provisioning/state/` は logs と metrics を同じ形で並べて返す（実測）
const STATE = { logs: { system_exist: false, user_exist: true }, metrics: { system_exist: false, user_exist: false } }

const LOG_STORAGES = {
  count: 1,
  results: [{
    id: '113801792528', name: 'デフォルト', description: 'ユーザーログ領域',
    expire_day: 40, is_system: false, classification: 'shared',
  }],
}
// 実測: 2026-09-08 GET /metrics/storages/（Ryosuke さんの実アカウント。docs/roadmap.md #30 に
// 生の応答を記録済み。'm-1'・'999000111' のような手作りの値は使わない・掟1）
const METRICS_STORAGES = {
  count: 1, from: 0, total: 1, is_ok: true,
  results: [{
    id: '113802075468', name: 'デフォルト', description: 'ユーザーメトリクス領域',
    is_system: false, resource_id: '113802075468',
    usage: { metrics_routings: 1, alert_rules: 0, log_measure_rules: 0 },
  }],
}

const LOG_ROUTINGS = {
  count: 2,
  results: [
    { id: 870240, resource_id: '113801820576', publisher: { code: 'apprun' }, variant: 'applicationlog' },
    { id: 780252, resource_id: '113801792527', publisher: { code: 'apprun' }, variant: 'applicationlog' },
  ],
}
// 実測: 2026-09-08 GET /metrics/routings/（docs/roadmap.md #30）
const METRICS_ROUTINGS = {
  count: 1, total: 1, is_ok: true,
  results: [
    { id: 720190, resource_id: '113802075566', publisher: { code: 'apprun' }, variant: 'applicationmetrics' },
  ],
}

describe('固定値は実測どおり', () => {
  it('publisher はログ・メトリクス共通', () => {
    expect(APPRUN_PUBLISHER).toBe('apprun')
    expect(APPRUN_LOG_PUBLISHER).toBe('apprun') // 後方互換の薄い皮
  })

  // ★ 変異試験①が壊す想定の値。ログとメトリクスの variant を取り違えると
  //   意図しない方に接続してしまう（掟1・GET /publishers/apprun/ で実測）。
  it('variant は種類ごとに違う（実測: GET /publishers/apprun/）', () => {
    expect(APPRUN_VARIANT.logs).toBe('applicationlog')
    expect(APPRUN_VARIANT.metrics).toBe('applicationmetrics')
    expect(APPRUN_VARIANT.logs).not.toBe(APPRUN_VARIANT.metrics)
    expect(APPRUN_LOG_VARIANT).toBe('applicationlog') // 後方互換の薄い皮
  })
})

describe('実測した応答を読める（generalize: kind で分岐）', () => {
  it('provisioning/state から、指定した種類のユーザー領域があるかを読む', () => {
    expect(parseProvisioningState(STATE, 'logs')).toBe(true)
    expect(parseProvisioningState(STATE, 'metrics')).toBe(false)
    expect(parseProvisioningState({ logs: { user_exist: false } }, 'logs')).toBe(false)
    expect(parseProvisioningState(null, 'logs')).toBe(false)
    expect(parseProvisioningState({}, 'metrics')).toBe(false)
  })

  it('使うストレージを選ぶ（ログ・メトリクス共通の形）', () => {
    expect(pickStorageId(LOG_STORAGES)).toBe('113801792528')
    expect(pickStorageId(METRICS_STORAGES)).toBe('113802075468')
    expect(pickStorageId({ results: [] })).toBe(null)
    expect(pickStorageId(null)).toBe(null)
    expect(pickLogStorageId(LOG_STORAGES)).toBe('113801792528') // 後方互換の薄い皮
  })

  // システム領域は利用者のものではない
  it('システム領域は選ばない', () => {
    expect(pickStorageId({ results: [{ id: '1', is_system: true }] })).toBe(null)
    expect(pickStorageId({ results: [{ id: '1', is_system: true }, { id: '2', is_system: false }] })).toBe('2')
  })

  it('このアプリのルーティングが既にあるかを、種類ごとに正しく判定する', () => {
    expect(hasAppRouting(LOG_ROUTINGS, '113801820576', 'logs')).toBe(true)
    expect(hasAppRouting(LOG_ROUTINGS, '999', 'logs')).toBe(false)
    expect(hasAppRouting(METRICS_ROUTINGS, '113802075566', 'metrics')).toBe(true)
    expect(hasAppRouting(METRICS_ROUTINGS, '113802075566', 'logs')).toBe(false) // ログ扱いにしない
    expect(hasAppLogRouting(LOG_ROUTINGS, '113801820576')).toBe(true) // 後方互換の薄い皮
  })

  // 別のアプリ・別の種類のルーティングを「自分のもの」と誤認しない
  it('publisher と variant が違えば別物として扱う', () => {
    const other = { results: [{ resource_id: '1', publisher: { code: 'other' }, variant: 'applicationlog' }] }
    expect(hasAppRouting(other, '1', 'logs')).toBe(false)
    const metricsAsLog = { results: [{ resource_id: '1', publisher: { code: 'apprun' }, variant: 'applicationmetrics' }] }
    expect(hasAppRouting(metricsAsLog, '1', 'logs')).toBe(false)
  })
})

describe.each<TelemetryKind>(['logs', 'metrics'])('公開のときに何をするか（kind=%s）', (kind) => {
  it('すでに流れていれば何もしない', () => {
    const a = decideTelemetryAction({ storageReady: true, storageId: '1', alreadyRouted: true }, kind)
    expect(a.kind).toBe('none')
  })

  // ★ 課金は**ストレージ単位**。ルーティングを足すだけなら費用は増えない。
  //    ここで確認を出すと、意味の分からない同意を1つ増やすだけになる
  it('領域があれば、確認せずに繋ぐ（追加費用が無いため）', () => {
    const a = decideTelemetryAction({ storageReady: true, storageId: '113801792528', alreadyRouted: false }, kind)
    expect(a.kind).toBe('route')
    if (a.kind !== 'route') throw new Error('unreachable')
    expect(a.storageId).toBe('113801792528')
  })

  // ★ 領域が無い＝作ると月額が発生する。**勝手に作らない**
  it('領域が無ければ、同意を取る', () => {
    const a = decideTelemetryAction({ storageReady: false, storageId: null, alreadyRouted: false }, kind)
    expect(a.kind).toBe('ask')
    if (a.kind !== 'ask') throw new Error('unreachable')
    expect(a.note).toContain(kind === 'logs' ? 'ログ' : 'メトリクス')
  })

  it('領域があると言われても、IDが取れなければ勝手に進めない', () => {
    const a = decideTelemetryAction({ storageReady: true, storageId: null, alreadyRouted: false }, kind)
    expect(a.kind).toBe('ask')
  })

  it('画面文言に Markdown 記法を混ぜない', () => {
    const a = decideTelemetryAction({ storageReady: false, storageId: null, alreadyRouted: false }, kind)
    if (a.kind === 'ask') expect(a.note).not.toMatch(/\*\*|`/)
  })
})

// #30 検分（2026-09-08）: `cloud:enableTelemetry` が `decideTelemetryAction` を一度も
// 参照せず、無条件で課金の始まる `initializeProvisioning` から始まっていた（同意なしに
// 課金される経路）。直しは `decideEnableTelemetry` に判断を一元化すること。
// ここでは**実際にこの関数を呼んで**4状態を確かめる（文字列一致ではなく振る舞いで守る）。
describe('decideEnableTelemetry: cloud:enableTelemetry が実際に何をすべきか（#30 検分の直し）', () => {
  it('置き場あり × 同意なし → route（追加費用が無いので同意は要らない）', () => {
    const d = decideEnableTelemetry({ storageReady: true, storageId: '113801792528', alreadyRouted: false }, { consented: false })
    expect(d.do).toBe('route')
    if (d.do !== 'route') throw new Error('unreachable')
    expect(d.storageId).toBe('113801792528')
  })

  it('置き場なし × 同意なし → need-consent（初期化を呼ばせない）', () => {
    const d = decideEnableTelemetry({ storageReady: false, storageId: null, alreadyRouted: false }, { consented: false })
    expect(d.do).toBe('need-consent')
  })

  it('置き場なし × 同意あり → initialize-then-route（このときだけ初期化してよい）', () => {
    const d = decideEnableTelemetry({ storageReady: false, storageId: null, alreadyRouted: false }, { consented: true })
    expect(d.do).toBe('initialize-then-route')
  })

  it('すでに繋がっている → nothing（同意の有無に関わらず何もしない）', () => {
    expect(decideEnableTelemetry({ storageReady: true, storageId: '1', alreadyRouted: true }, { consented: false }).do).toBe('nothing')
    expect(decideEnableTelemetry({ storageReady: true, storageId: '1', alreadyRouted: true }, { consented: true }).do).toBe('nothing')
  })

  // ★ 変異試験①が壊す想定: 同意なしでも initialize-then-route を返すようにする
  it('置き場が無いとき、同意なしでは絶対に initialize-then-route を返さない', () => {
    expect(decideEnableTelemetry({ storageReady: false, storageId: null, alreadyRouted: false }, { consented: false }).do)
      .not.toBe('initialize-then-route')
  })

  // ★ 変異試験②が壊す想定: 置き場があるときも初期化を呼ぶようにする（元の穴に戻す）
  it('置き場があるとき（追加費用が無い）は、同意していても initialize-then-route を返さない', () => {
    expect(decideEnableTelemetry({ storageReady: true, storageId: '1', alreadyRouted: false }, { consented: true }).do)
      .toBe('route')
  })

  it('置き場ありと言われてもIDが取れなければ、繋げないので「置き場なし」と同じに扱う', () => {
    expect(decideEnableTelemetry({ storageReady: true, storageId: null, alreadyRouted: false }, { consented: false }).do).toBe('need-consent')
    expect(decideEnableTelemetry({ storageReady: true, storageId: null, alreadyRouted: false }, { consented: true }).do).toBe('initialize-then-route')
  })
})

describe('後方互換の薄い皮（decideLogAction）は kind: logs と同じ判断を返す', () => {
  it('すでに流れていれば何もしない', () => {
    expect(decideLogAction({ storageReady: true, storageId: '1', alreadyRouted: true }))
      .toEqual(decideTelemetryAction({ storageReady: true, storageId: '1', alreadyRouted: true }, 'logs'))
  })
  it('領域が無ければ同意を取る', () => {
    expect(decideLogAction({ storageReady: false, storageId: null, alreadyRouted: false }))
      .toEqual(decideTelemetryAction({ storageReady: false, storageId: null, alreadyRouted: false }, 'logs'))
  })
})

// 判断を一元化しても、呼ぶ側が通っていなければ意味がない（掟10。今日これで何度も刺された）
describe('公開の経路が、ログ・メトリクスの設定を通っている（#30）', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'main', 'ipc', 'cloud.ts'), 'utf-8')

  it('公開のあとにログの設定を確かめている', () => {
    expect(src).toContain("await ensureTelemetryRouting('logs', creds, resourceId, progress)")
    expect(src).toContain('async function ensureTelemetryRouting')
  })

  it('公開のあとにメトリクスの設定も確かめている（ログだけに留まらない）', () => {
    expect(src).toContain("await ensureTelemetryRouting('metrics', creds, resourceId, progress)")
  })

  // ★ #30 検分の指摘6: resource_id はログ・メトリクスで同じものを使うので、公開のたびに
  //   1回だけ引く（以前は ensureAppLogRouting/ensureAppMetricsRouting がそれぞれ
  //   resolveAppResourceId を呼んでおり、公開1回につき同じ GET を2回引いていた）。
  it('公開の流れでは resolveAppResourceId を1回だけ呼んでいる（ログ・メトリクスで使い回す）', () => {
    const matches = src.match(/await resolveAppResourceId\(creds, appId\)/g) ?? []
    expect(matches.length).toBe(1)
  })

  it('固定値を手で書かず、一元定義を使っている', () => {
    expect(src).toContain('APPRUN_PUBLISHER')
    expect(src).toContain('APPRUN_VARIANT')
    expect(src).not.toMatch(/publisherCode: 'apprun'/)
    expect(src).not.toMatch(/variant: 'applicationlog'/)
    expect(src).not.toMatch(/variant: 'applicationmetrics'/)
  })

  // ★ 費用の発生する操作（領域の作成）を、公開のついでにやってはいけない
  it('公開の流れでは、費用の発生する初期化を呼ばない', () => {
    const at = src.indexOf('async function ensureTelemetryRouting')
    const body = src.slice(at, at + 2000)
    expect(body).not.toContain('initializeProvisioning')
    expect(body).toContain("action.kind !== 'route'")
  })

  // ★ ログの設定に失敗しても、公開そのものは失敗にしない（メトリクスも同様）
  it('ログ・メトリクスの設定の失敗で、公開を巻き添えにしない', () => {
    expect(src).toMatch(/await ensureTelemetryRouting\('logs'[^)]*\)[\s\S]{0,20}catch/)
    expect(src).toMatch(/await ensureTelemetryRouting\('metrics'[^)]*\)[\s\S]{0,20}catch/)
  })

  // ★ #30 検分の指摘1: cloud:enableTelemetry が decideTelemetryAction（実質
  //   decideEnableTelemetry）を無視し、無条件で初期化していた穴の直し。
  //   判断・分岐は main/cloud/monitoring.ts の enableTelemetry に一元化し、
  //   IPCハンドラはそれを呼ぶだけになっているか（振る舞いは tests/monitoring.test.ts が
  //   偽サーバで直接確かめる。ここは「複製した判断ロジックを持っていないか」の配線確認）。
  // ハンドラ本体だけを切り出す。**次の `ipcMain.handle(` までではなく、このハンドラ自身の
  // 閉じ `  })`（2字下げ）までで止める。** 次のハンドラの直前の JSDoc コメントまで
  // スイープしてしまうと、そこに `initializeProvisioning` という語を含む説明文
  // （このファイル自身のコメント）があるだけで `not.toContain` が誤って落ちる
  // （掟10: ソースを読んで確かめるテストは、当て先が他の行に出ないか必ず確認する）。
  function handlerBody(handleCallPrefix: string): string {
    const at = src.indexOf(handleCallPrefix)
    expect(at).toBeGreaterThan(-1)
    const closeAt = src.indexOf('\n  })', at)
    expect(closeAt).toBeGreaterThan(at)
    return src.slice(at, closeAt)
  }

  it('cloud:enableTelemetry は判断ロジックを持たず、main/cloud/monitoring.ts の enableTelemetry を呼ぶだけ', () => {
    expect(src).toContain("import { MonitoringClient, fetchTelemetryStatus, enableTelemetry } from '../cloud/monitoring'")
    const body = handlerBody("ipcMain.handle('cloud:enableTelemetry'")
    // ハンドラ自身は initializeProvisioning を直接呼ばない（呼ぶのは monitoring.ts 側だけ）
    expect(body).not.toContain('initializeProvisioning')
    expect(body).toContain('return await enableTelemetry(mon, kind, resourceId, { consented: opts?.consented === true })')
  })

  // ★ #30 検分の指摘3: telemetryStatus は「何も作らない」はずなのに、テストが1件も無かった
  //   （grep 0件）。ここでは配線（初期化を直接呼んでいないこと）を固定し、
  //   実際にGET以外が飛ばないことは tests/monitoring.test.ts が偽サーバで確かめる。
  it('cloud:telemetryStatus は初期化を呼ばず、fetchTelemetryStatus を呼ぶだけ', () => {
    const body = handlerBody("ipcMain.handle('cloud:telemetryStatus'")
    expect(body).not.toContain('initializeProvisioning')
    expect(body).toContain('return await fetchTelemetryStatus(mon, kind, resourceId)')
  })
})

// 画面（AppRunPanel・TelemetryNotice）の配線・同意の歯止めは tests/telemetryNotice.test.ts に
// 寄せてある（#30 検分の指摘5: 同じ主張を2ファイルへ複製しない・掟10）。
