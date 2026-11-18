// tests/fetchGuardIpv6.test.ts — 角括弧つきの IPv6（http://[::1]/）が、名前引きの失敗などではなく
// 内部アドレスの判定そのもので断られることを固定する（fetchUrlPage は両方の AI の経路で使う共通の部品）。
// URL の hostname は IPv6 だと角括弧つきで返り、そのままでは net.isIP が認識せず判定をすり抜けていた。
import { describe, it, expect, vi, afterEach } from 'vitest'
import http from 'node:http'

vi.mock('electron', () => ({ ipcMain: { handle: () => {} } }))
const lookupMock = vi.fn(async (_host: string) => [{ address: '93.184.216.34', family: 4 }])
vi.mock('dns/promises', () => ({ lookup: (host: string) => lookupMock(host), default: { lookup: (host: string) => lookupMock(host) } }))

import { fetchUrlPage } from '../src/main/ipc/web'

afterEach(() => { lookupMock.mockClear(); vi.restoreAllMocks() })

const BLOCKED = /内部ネットワークのアドレス/

describe('fetchUrlPage の角括弧つき IPv6', () => {
  for (const url of [
    'http://[::1]/',
    'http://[fe80::1]/',
    'http://[fd00::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::]/',
  ]) {
    it(`${url} は判定で断られ、名前引きにも通信にも進まない`, async () => {
      const req = vi.spyOn(http, 'request')
      await expect(fetchUrlPage(url)).rejects.toThrow(BLOCKED)
      expect(lookupMock).not.toHaveBeenCalled()
      expect(req).not.toHaveBeenCalled()
    })
  }

  it('文書用の範囲の外の IPv6（2001:db8::1）は、既存の決まりどおり内部扱いにならず通信へ進む', async () => {
    const marker = new Error('通信まで進んだ')
    const req = vi.spyOn(http, 'request').mockImplementation(() => { throw marker })
    await expect(fetchUrlPage('http://[2001:db8::1]/')).rejects.not.toThrow(BLOCKED)
    expect(lookupMock).not.toHaveBeenCalled()
    expect(req).toHaveBeenCalled()
  })
})
