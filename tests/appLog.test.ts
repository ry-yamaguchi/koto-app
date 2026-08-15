import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  decideLogAction, parseProvisioningState, pickLogStorageId, hasAppLogRouting,
  APPRUN_LOG_PUBLISHER, APPRUN_LOG_VARIANT,
} from '../src/shared/appLog'

// 2026-08-14 Ryosuke 指摘:「ログが既定では ON になっていない。作った時に ON にできないか」
//
// 値はすべて**実アカウントで実測**した（掟1・推測しない）。以下は実際の応答の形。

const STATE = { logs: { system_exist: false, user_exist: true }, metrics: { system_exist: false, user_exist: false } }
const STORAGES = {
  count: 1,
  results: [{
    id: '113801792528', name: 'デフォルト', description: 'ユーザーログ領域',
    expire_day: 40, is_system: false, classification: 'shared',
  }],
}
const ROUTINGS = {
  count: 2,
  results: [
    { id: 870240, resource_id: '113801820576', publisher: { code: 'apprun' }, variant: 'applicationlog' },
    { id: 780252, resource_id: '113801792527', publisher: { code: 'apprun' }, variant: 'applicationlog' },
  ],
}

describe('実測した応答を読める', () => {
  it('ログ領域があるかを読む', () => {
    expect(parseProvisioningState(STATE)).toBe(true)
    expect(parseProvisioningState({ logs: { user_exist: false } })).toBe(false)
    expect(parseProvisioningState(null)).toBe(false)
    expect(parseProvisioningState({})).toBe(false)
  })

  it('使うログストレージを選ぶ', () => {
    expect(pickLogStorageId(STORAGES)).toBe('113801792528')
    expect(pickLogStorageId({ results: [] })).toBe(null)
    expect(pickLogStorageId(null)).toBe(null)
  })

  // システム領域は利用者のものではない
  it('システム領域は選ばない', () => {
    expect(pickLogStorageId({ results: [{ id: '1', is_system: true }] })).toBe(null)
    expect(pickLogStorageId({ results: [{ id: '1', is_system: true }, { id: '2', is_system: false }] })).toBe('2')
  })

  it('このアプリのログが既に流れているか分かる', () => {
    expect(hasAppLogRouting(ROUTINGS, '113801820576')).toBe(true)
    expect(hasAppLogRouting(ROUTINGS, '999')).toBe(false)
  })

  // 別のアプリ・別の種類のルーティングを「自分のもの」と誤認しない
  it('publisher と variant が違えば別物として扱う', () => {
    const other = { results: [{ resource_id: '1', publisher: { code: 'other' }, variant: 'applicationlog' }] }
    expect(hasAppLogRouting(other, '1')).toBe(false)
    const metrics = { results: [{ resource_id: '1', publisher: { code: 'apprun' }, variant: 'applicationmetrics' }] }
    expect(hasAppLogRouting(metrics, '1')).toBe(false)
  })

  it('固定値は実測どおり', () => {
    expect(APPRUN_LOG_PUBLISHER).toBe('apprun')
    expect(APPRUN_LOG_VARIANT).toBe('applicationlog')
  })
})

describe('公開のときに何をするか', () => {
  it('すでに流れていれば何もしない', () => {
    const a = decideLogAction({ storageReady: true, storageId: '1', alreadyRouted: true })
    expect(a.kind).toBe('none')
  })

  // ★ 課金は**ログストレージ単位**。ルーティングを足すだけなら費用は増えない。
  //    ここで確認を出すと、意味の分からない同意を1つ増やすだけになる
  it('ログ領域があれば、確認せずに繋ぐ（追加費用が無いため）', () => {
    const a = decideLogAction({ storageReady: true, storageId: '113801792528', alreadyRouted: false })
    expect(a.kind).toBe('route')
    if (a.kind !== 'route') throw new Error('unreachable')
    expect(a.storageId).toBe('113801792528')
  })

  // ★ 領域が無い＝作ると月額が発生する。**勝手に作らない**
  it('ログ領域が無ければ、同意を取る', () => {
    const a = decideLogAction({ storageReady: false, storageId: null, alreadyRouted: false })
    expect(a.kind).toBe('ask')
    if (a.kind !== 'ask') throw new Error('unreachable')
    expect(a.note).toContain('ログ')
  })

  it('領域があると言われても、IDが取れなければ勝手に進めない', () => {
    const a = decideLogAction({ storageReady: true, storageId: null, alreadyRouted: false })
    expect(a.kind).toBe('ask')
  })

  it('画面文言に Markdown 記法を混ぜない', () => {
    const a = decideLogAction({ storageReady: false, storageId: null, alreadyRouted: false })
    if (a.kind === 'ask') expect(a.note).not.toMatch(/\*\*|`/)
  })
})

// 判断を一元化しても、呼ぶ側が通っていなければ意味がない（掟10。今日これで何度も刺された）
describe('公開の経路が、ログの設定を通っている', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'main', 'ipc', 'cloud.ts'), 'utf-8')

  it('公開のあとにログの設定を確かめている', () => {
    expect(src).toContain('ensureAppLogRouting')
    expect(src).toContain('decideLogAction')
  })

  it('固定値を手で書かず、一元定義を使っている', () => {
    expect(src).toContain('APPRUN_LOG_PUBLISHER')
    expect(src).toContain('APPRUN_LOG_VARIANT')
    expect(src).not.toMatch(/publisherCode: 'apprun'/)
  })

  // ★ 費用の発生する操作（ログ領域の作成）を、公開のついでにやってはいけない
  it('公開の流れでは、費用の発生する初期化を呼ばない', () => {
    const at = src.indexOf('async function ensureAppLogRouting')
    const body = src.slice(at, at + 2000)
    expect(body).not.toContain('initializeLogs')
    expect(body).toContain("action.kind !== 'route'")
  })

  // ★ ログの設定に失敗しても、公開そのものは失敗にしない
  it('ログの設定の失敗で、公開を巻き添えにしない', () => {
    expect(src).toMatch(/await ensureAppLogRouting\([^)]*\)[\s\S]{0,20}catch/)
  })
})
