import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// 専有型の通信の失敗（回線断・時間切れ）が、英語の原文（fetch failed）のまま画面に出ないことを、
// 返る message で確かめる。fetch は本物の回線断と同じ形の値（cause に errno つき）で失敗させる。
// 日本語の文＋詳細（最後の1行・ホスト名つき）になっていること、読み取りと書き込みで文が違うことを固める。

const h = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => '/tmp', getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {} },
  dialog: {},
}))

import { getLimits, createCluster, listClusters } from '../src/main/cloud/apprunDedicated'
import { publishAppFlow, refreshLbAddresses } from '../src/main/cloud/apprunDedicatedAppApply'
import { createClusterFlow, teardownFlow } from '../src/main/cloud/apprunDedicatedApply'
import { registerApprunDedicatedHandlers } from '../src/main/ipc/apprunDedicated'
import { writeApprunDedicatedRecordFs } from '../src/main/publishMetaFs'
import { splitFailureDetail } from '../src/shared/failureDetail'
import { ResumedNotesView, ErrorBlock } from '../src/renderer/components/DedicatedOpsParts'

const HOST = 'secure.sakura.ad.jp'
const AUTH = { token: 'tok', secret: 'sec' }

/** 回線が切れているときの fetch の失敗（Node の fetch と同じ形）。 */
const offline = () => Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${HOST}`), { code: 'ENOTFOUND' }),
})
/** 時間切れ（AbortSignal.timeout の形）。要求が出たかは分からない。 */
const timedOut = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })

const realFetch = globalThis.fetch
let fetchError: () => unknown = offline
beforeEach(() => { fetchError = offline; vi.stubGlobal('fetch', async () => { throw fetchError() }) })
afterEach(() => { vi.stubGlobal('fetch', realFetch); vi.unstubAllGlobals() })

let projectDir = ''
beforeEach(() => { projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-dedicated-offline-')) })
afterEach(() => { fs.rmSync(projectDir, { recursive: true, force: true }) })

function expectJapaneseOffline(message: string) {
  const { text, detail } = splitFailureDetail(message)
  expect(text).toContain('インターネットに接続できませんでした')
  expect(text).not.toContain('fetch failed')
  expect(detail).toContain(HOST)
}

describe('専有型クライアント: 通信の失敗は日本語の文＋詳細', () => {
  it('読み取り（readOnly）: 回線断は「もう一度お試しください」・詳細にホスト名', async () => {
    const r = await getLimits(AUTH, undefined, { readOnly: true })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expectJapaneseOffline(r.message)
      expect(r.message).toContain('もう一度お試しください')
    }
  })

  it('読み取りの時間切れは「時間内に返事がありませんでした」', async () => {
    fetchError = timedOut
    const r = await listClusters(AUTH, undefined, { readOnly: true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(splitFailureDetail(r.message).text).toContain('時間内に返事がありませんでした')
  })

  it('書き込み（作る）の時間切れは「操作が済んだかは確かめられていません」（二重に作らせない）', async () => {
    fetchError = timedOut
    const r = await createCluster(AUTH, { name: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      const { text } = splitFailureDetail(r.message)
      expect(text).toContain('操作が済んだかは確かめられていません')
      expect(text).not.toContain('もう一度お試しください')
    }
  })

  it('見分けられない失敗は原文のまま（日本語の文に置き換えない）', async () => {
    fetchError = () => new Error('something odd happened')
    const r = await getLimits(AUTH, undefined, { readOnly: true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toBe('something odd happened')
  })
})

describe('専有型の IPC: 手順3「調べる」・手順8の状態・IP 再取得', () => {
  registerApprunDedicatedHandlers({} as any)
  const call = (channel: string, ...args: unknown[]) => h.handlers.get(channel)!({}, ...args)

  it('limits / clusters: 回線断が日本語の文＋ホスト名の詳細で返る', async () => {
    for (const channel of ['apprunDedicated:limits', 'apprunDedicated:clusters']) {
      const r = await call(channel, AUTH)
      expect(r.ok, channel).toBe(false)
      expectJapaneseOffline(r.message)
    }
  })

  it('時間切れは読み取りの文（「時間内に返事がありませんでした」）で返る。書き込みの文にしない', async () => {
    fetchError = timedOut
    for (const channel of ['apprunDedicated:limits', 'apprunDedicated:clusters']) {
      const r = await call(channel, AUTH)
      expect(splitFailureDetail(r.message).text, channel).toContain('時間内に返事がありませんでした')
    }
    const p = await call('apprunDedicated:plans', AUTH)
    expect(splitFailureDetail(p.worker.message).text).toContain('時間内に返事がありませんでした')
    expect(splitFailureDetail(p.lb.message).text).toContain('時間内に返事がありませんでした')
  })

  it('plans: ワーカ・LB どちらも日本語の文', async () => {
    const r = await call('apprunDedicated:plans', AUTH)
    expectJapaneseOffline(r.worker.message)
    expectJapaneseOffline(r.lb.message)
  })

  it('appStatus: 記録のクラスタを引けなくても止めず（null）、IP 再取得は日本語の文＋詳細', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })
    const st = await call('apprunDedicated:appStatus', projectDir, AUTH)
    expect(st.ok).toBe(true)
    expect(st.hasLetsEncryptEmail).toBeNull()
    const r = await call('apprunDedicated:lbAddresses', projectDir, AUTH)
    expect(r.ok).toBe(false)
    expect(splitFailureDetail(r.message).text).toContain('ロードバランサノードのアドレスを取得できませんでした: インターネットに接続できませんでした')
    expectJapaneseOffline(r.message)
  })
})

describe('専有型の IP 再取得: 時間切れは読み取りの文', () => {
  it('手順8「🔄 IP を再取得」: 時間切れは「時間内に返事がありませんでした」', async () => {
    fetchError = timedOut
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })
    const r = await refreshLbAddresses(AUTH, projectDir)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(splitFailureDetail(r.message).text).toContain('ロードバランサノードのアドレスを取得できませんでした: 時間内に返事がありませんでした')
  })
})

describe('専有型の流れ: 流れの文に埋め込んでも日本語の文＋最後に詳細', () => {
  it('手順5 クラスタを作る: 最初の上限の確認で回線断 → 前置き＋日本語の文、詳細は最後', async () => {
    writeApprunDedicatedRecordFs(projectDir, { consentedAt: '2026-09-01T00:00:00.000Z' })
    const r = await createClusterFlow(AUTH, projectDir, {
      name: 'myapp', ports: [{ port: 80, protocol: 'http' }, { port: 443, protocol: 'https' }], servicePrincipalID: '111111111111', zone: 'tk1b',
      workerServiceClassPath: 'cloud/apprun/dedicated/worker/1vcpu_2gb', minNodes: 1, maxNodes: 1, lbServiceClassPath: 'cloud/apprun/dedicated/lb/1vcpu_2gb_1',
    }, { confirmed: true })
    expect(r.ok).toBe(false)
    expect(splitFailureDetail(r.message!).text).toContain('上限を確認できませんでした: インターネットに接続できませんでした')
    expectJapaneseOffline(r.message!)
  })

  it('手順5 クラスタを作る: 上限の確認（まだ何も作っていない読み取り）の時間切れは、「済んだか」を言わない', async () => {
    fetchError = timedOut
    writeApprunDedicatedRecordFs(projectDir, { consentedAt: '2026-09-01T00:00:00.000Z' })
    const r = await createClusterFlow(AUTH, projectDir, {
      name: 'myapp', ports: [{ port: 80, protocol: 'http' }, { port: 443, protocol: 'https' }], servicePrincipalID: '111111111111', zone: 'tk1b',
      workerServiceClassPath: 'cloud/apprun/dedicated/worker/1vcpu_2gb', minNodes: 1, maxNodes: 1, lbServiceClassPath: 'cloud/apprun/dedicated/lb/1vcpu_2gb_1',
    }, { confirmed: true })
    expect(r.ok).toBe(false)
    const { text } = splitFailureDetail(r.message!)
    expect(text).toContain('上限を確認できませんでした: 時間内に返事がありませんでした')
    expect(text).not.toContain('操作が済んだかは確かめられていません')
  })

  it('手順6 削除: アプリの無効化で時間切れ → 「済んだかは確かめられていません」の文。課金が続く案内は残り、詳細は最後の1行', async () => {
    fetchError = timedOut
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app-1' })
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep: async () => {} })
    expect(r.ok).toBe(false)
    const { text, detail } = splitFailureDetail(r.message)
    expect(text).not.toMatch(/aborted due to timeout/)
    expect(text).toMatch(/確かめられていません|時間内に返事/)
    expect(detail).toContain('timeout')
    expect(r.message.endsWith(detail)).toBe(true)
  })

  it('手順8 公開: 公開のあとの IP 取得で回線が切れても公開は成功のまま、警告は日本語の文＋詳細', async () => {
    // 公開本体の通信は本物の応答で通し、LB ノードの取得だけ回線断にする
    const { default: http } = await import('node:http')
    const routes: Record<string, unknown> = {
      'GET /clusters/cluster-x': { cluster: { clusterID: 'cluster-x', hasLetsEncryptEmail: true, ports: [{ port: 80, protocol: 'http' }, { port: 443, protocol: 'https' }] } },
      'GET /applications?clusterID=cluster-x&maxItems=20': { applications: [] },
      'POST /applications': { application: { applicationID: 'app-1' } },
      'POST /applications/app-1/versions': { applicationVersion: { version: 1 } },
      'GET /applications/app-1': { application: { applicationID: 'app-1', name: 'myapp2', clusterID: 'cluster-x', activeVersion: 1 } },
      'GET /applications/app-1/versions?maxItems=20': { versions: [{ version: 1, image: 'x', activeNodeCount: 1, created: 1 }] },
    }
    const server = http.createServer((req, res) => {
      const body = routes[`${req.method} ${req.url}`]
      req.on('data', () => {})
      req.on('end', () => { res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body ?? {})) })
    })
    await new Promise<void>(resolve => server.listen(0, resolve))
    const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/`
    vi.stubGlobal('fetch', (url: any, init: any) => {
      if (String(url).includes('load_balancer_nodes')) return Promise.reject(offline())
      return realFetch(url, init)
    })
    try {
      writeApprunDedicatedRecordFs(projectDir, { clusterID: 'cluster-x', asgID: 'asg-y', loadBalancerID: 'lb-z' })
      const r = await publishAppFlow(AUTH, projectDir, {
        spec: { name: 'myapp2', host: 'app.example.com', port: 8080, cpu: 500, memory: 512, fixedScale: 1, env: [] },
        imageRef: 'jp1.sakuracr.jp/example/myapp2:v1', registry: { username: 'u', password: 'p' },
      }, { confirmed: true, probeMarker: async () => ({ reached: true, status: 200, body: '' }), sleep: async () => {} } as any, baseUrl)
      expect(r.ok).toBe(true)
      const w = r.warnings!.find(x => x.includes('ロードバランサノードのアドレスを取得できませんでした'))!
      expect(w).toBeTruthy()
      expect(splitFailureDetail(w).text).toContain('インターネットに接続できませんでした')
      expect(splitFailureDetail(w).detail).toContain(HOST)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })
})

describe('専有型の画面部品: 詳細は文の下の小さな行に分けて描く', () => {
  const msg = 'インターネットに接続できませんでした。接続を確かめてから、もう一度お試しください。\n詳細: getaddrinfo ENOTFOUND secure.sakura.ad.jp'

  it('警告の行（再開した結果の知らせ）に詳細が分かれて出る（素の文字列に「詳細:」が混ざらない）', () => {
    const html = renderToStaticMarkup(React.createElement(ResumedNotesView, {
      notes: [{ startedAt: 1, headline: '前回の公開', call: 'done', message: '', warnings: [`ロードバランサノードのアドレスを取得できませんでした: ${msg}`] } as any],
    }))
    expect(html).toContain('select-text')
    expect(html).toMatch(/<span class="[^"]*">詳細: getaddrinfo ENOTFOUND secure\.sakura\.ad\.jp<\/span>/)
  })

  it('結果の一言（失敗）の詳細も分かれて出る', () => {
    const html = renderToStaticMarkup(React.createElement(ResumedNotesView, {
      notes: [
        { startedAt: 1, headline: '前回の削除', call: 'failed', message: msg, warnings: [] } as any,
        { startedAt: 2, headline: '今回', call: 'failed', message: '', warnings: [] } as any,
      ],
    }))
    expect(html).toMatch(/<span class="[^"]*">詳細: getaddrinfo ENOTFOUND/)
  })

  it('ErrorBlock: 前置き＋日本語の文のあとに詳細の行', () => {
    const html = renderToStaticMarkup(React.createElement(ErrorBlock, { msg: `取得できませんでした: ${msg}` }))
    expect(html).toContain('取得できませんでした: インターネットに接続できませんでした')
    expect(html).toMatch(/<span class="[^"]*">詳細: getaddrinfo ENOTFOUND/)
  })
})
