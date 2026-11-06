import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { newError, createHttpError } from 'builder-util-runtime'
import { updateFailureText } from '../src/shared/updatePolicy'
import { splitFailureDetail } from '../src/shared/failureDetail'

// 更新の確認の失敗が、画面へ流れる状態（update:state）に「日本語の1行」で載ること。
// 入口は2つ（electron-updater の error イベント／手動の確認 checkForUpdatesNow の catch）。
// 偽の electron と偽の autoUpdater（本物と同じく、checkForUpdates の失敗では error イベントも出す）の上で
// 実際に動かし、画面へ送られた状態の一覧と、autoUpdater に残った設定を見る。
const h = vi.hoisted(() => ({
  app: { isPackaged: true, version: '0.6.26-rc.1' },
  auto: null as null | Record<string, any>,
}))

vi.mock('electron', () => ({
  app: {
    get isPackaged() { return h.app.isPackaged },
    getVersion: () => h.app.version,
  },
  shell: {},
}))

vi.mock('electron-updater', async () => {
  const { EventEmitter } = await import('events')
  // 版に -rc が付くと、本物の AppUpdater は allowPrerelease を真にして始まる
  const auto = Object.assign(new EventEmitter(), {
    logger: null as unknown,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    forceDevUpdateConfig: true,
    allowPrerelease: true,
    checkForUpdates: async (): Promise<unknown> => null,
    quitAndInstall: () => {},
  })
  h.auto = auto
  return { autoUpdater: auto }
})

// 更新の記録の書き込み（ファイル）は、この試験では要らない
vi.mock('../src/main/updateLog', () => ({
  updateLogger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  logUpdaterStart: () => {},
}))

import { initUpdater, checkForUpdatesNow, currentUpdateState, UPDATE_STATE_CHANNEL } from '../src/main/updater'

const auto = () => h.auto!

const T_OFFLINE = '更新を確認できませんでした。インターネットに接続してから、もう一度お試しください。'
const T_OTHER = '更新を確認できませんでした。しばらくしてから、もう一度お試しください。'
const T_DEV = '開発中は更新を確認できません（パッケージ版でのみ動作します）。'

/** 画面へ送られた (チャンネル, 状態) の一覧。 */
let sent: Array<[string, unknown]> = []
const fakeWindow = {
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, send: (channel: string, state: unknown) => { sent.push([channel, state]) } },
}

/** 本物の checkForUpdates と同じく、失敗では error イベントを出してから投げる。 */
const rejectingWithEvent = (err: Error) => async () => {
  auto().emit('error', err)
  throw err
}

beforeEach(() => {
  auto().removeAllListeners()
  auto().allowPrerelease = true
  auto().checkForUpdates = async () => null
  h.app.isPackaged = true
  sent = []
  initUpdater({ getMainWindow: () => fakeWindow as never, autoCheck: false })
})

// 本物の例外の形（electron-updater の newError・builder-util-runtime の HttpError）
const noPublished = () => newError('No published versions on GitHub', 'ERR_UPDATER_NO_PUBLISHED_VERSIONS')
const notFound404 = () => createHttpError(
  { statusCode: 404, statusMessage: 'Not Found', headers: { server: 'GitHub.com' } } as never,
  'method: GET url: https://github.com/example-owner/example-repo/releases/download/v0.6.26/latest-mac.yml\n\nPlease double check that your authentication token is correct.\n',
)
const offline = () => new Error('net::ERR_INTERNET_DISCONNECTED')
// 最新の版の取得（GitHubProvider.getLatestTagName）の失敗は、electron-updater が種類を問わず包み、さらに feed の読み取りの包みが包む
const FEED_URL = 'https://github.com/example-owner/example-repo/releases'
const doubleWrapped = (inner: Error) => {
  const latest = newError(`Unable to find latest version on GitHub (${FEED_URL}/latest), please ensure a production release exists: ${inner.stack || inner.message}`, 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND')
  return newError(`Cannot parse releases feed: ${latest.stack || latest.message},\nXML:\n<feed><entry><title>0.6.26</title></entry></feed>`, 'ERR_UPDATER_INVALID_RELEASE_FEED')
}

describe('rc の版でも、数字の版を探す（allowPrerelease を偽にする）', () => {
  it('初期化のあとの allowPrerelease は偽（本物は -rc の版で真にして始まる）', () => {
    expect(auto().allowPrerelease).toBe(false)
  })
})

describe('error イベントの入口', () => {
  const cases: Array<[string, () => Error, string]> = [
    ['配信元に公開された版が無い', noPublished, T_OTHER],
    ['404（本文・ヘッダ付きの複数行）', notFound404, T_OTHER],
    ['回線断（net::ERR_*）', offline, T_OFFLINE],
    ['feed を取ったあとで回線が落ちた（最新の版の取得を包む二重の包み）', () => doubleWrapped(offline()), T_OFFLINE],
    ['最新の版の取得に 404 が返った（二重の包み）', () => doubleWrapped(notFound404()), T_OTHER],
    ['未知の英語', () => new Error('boom'), T_OTHER],
  ]
  for (const [name, make, text] of cases) {
    it(`${name} → 画面へ送る状態の message は日本語の1行`, () => {
      const err = make()
      auto().emit('error', err)
      // 画面へ送る message は、文（日本語1行）と、その下の詳細（原文）。文は text、全体は updateFailureText の戻り
      const message = updateFailureText(err)
      expect(sent).toEqual([[UPDATE_STATE_CHANNEL, { kind: 'error', message }]])
      expect(currentUpdateState()).toEqual({ kind: 'error', message })
      expect(splitFailureDetail(message).text).toBe(text)
    })
  }
})

describe('手動の確認（checkForUpdatesNow）の入口', () => {
  it('失敗が error イベントなしで投げられても、同じ日本語の1行になる（catch が自分で変換する）', async () => {
    auto().checkForUpdates = async () => { throw offline() }
    const state = await checkForUpdatesNow()
    const message = `${T_OFFLINE}\n詳細: net::ERR_INTERNET_DISCONNECTED`
    expect(state).toEqual({ kind: 'error', message })
    expect(sent).toEqual([[UPDATE_STATE_CHANNEL, { kind: 'error', message }]])
  })

  it('失敗は error イベントも出すので両方走るが、2入口は同じ文で終わる（食い違わない）', async () => {
    for (const [make, text] of [[noPublished, T_OTHER], [notFound404, T_OTHER], [offline, T_OFFLINE], [() => doubleWrapped(offline()), T_OFFLINE]] as const) {
      sent = []
      auto().checkForUpdates = rejectingWithEvent(make())
      const state = await checkForUpdatesNow()
      const message = (state as { message: string }).message
      expect(splitFailureDetail(message).text).toBe(text)
      // イベント経由とcatch経由の2回、同じ状態が画面へ送られる
      expect(sent).toEqual([
        [UPDATE_STATE_CHANNEL, { kind: 'error', message }],
        [UPDATE_STATE_CHANNEL, { kind: 'error', message }],
      ])
    }
  })

  it('成功すれば error にならない（前の状態のまま・何も送らない）', async () => {
    auto().emit('update-not-available')
    sent = []
    auto().checkForUpdates = async () => null
    const state = await checkForUpdatesNow()
    expect(state).toEqual({ kind: 'none' })
    expect(sent).toEqual([])
  })

  it('開発版は確認に行かず、日本語の文のまま（変換を通さない）', async () => {
    h.app.isPackaged = false
    const check = vi.fn(async () => null)
    auto().checkForUpdates = check
    const state = await checkForUpdatesNow()
    expect(check).not.toHaveBeenCalled()
    expect(state).toEqual({ kind: 'error', message: T_DEV })
    expect(sent).toEqual([[UPDATE_STATE_CHANNEL, { kind: 'error', message: T_DEV }]])
  })
})

describe('2入口とも updateFailureText を通す（呼び出しの形）', () => {
  const src = readFileSync(join(__dirname, '..', 'src/main/updater.ts'), 'utf-8')

  it('error イベントと catch が、どちらも updateFailureText の戻りを message にする', () => {
    expect(src).toContain("autoUpdater.on('error', err => {")
    expect(src).toContain("setState({ kind: 'error', message: updateFailureText(err) })")
    expect(src).toContain("setState({ kind: 'error', message: updateFailureText(e) })")
  })

  it('例外の原文（err.message）をそのまま message に入れる古い形に戻っていない', () => {
    expect(src).not.toContain('message: err?.message ?? String(err)')
    expect(src).not.toContain('message: e?.message ?? String(e)')
    expect(src).not.toContain('String(err)')
  })

  it('allowPrerelease を偽にする1行が、初期化の中にある', () => {
    expect(src).toContain('autoUpdater.allowPrerelease = false')
  })
})
