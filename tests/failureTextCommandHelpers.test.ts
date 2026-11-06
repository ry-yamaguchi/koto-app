import { describe, it, expect, beforeEach } from 'vitest'
import { commandFailureOf } from '../src/main/ipc/commandFailure'
import { sshFailureOf, sshNetworkFailureText } from '../src/main/sshFailure'
import { classifyFailure } from '../src/shared/failureText'
import { splitFailureDetail } from '../src/shared/failureDetail'
import * as ops from '../src/main/projectOps'

describe('commandFailureOf（外部コマンドの失敗を画面に出せる形にする）', () => {
  it('★ execFile の message（コマンドと引数すべて）は捨て、stderr だけを原文にする', () => {
    const e = Object.assign(new Error('Command failed: crane auth login s -u u -p SECRET-ARG\nError: unauthorized'), { stderr: 'Error: unauthorized\n', code: 1 })
    const out = commandFailureOf(e)
    expect(out.message).toBe('Error: unauthorized')
    expect(out.message).not.toContain('SECRET-ARG')
  })

  it('stderr が空で errno の符号があれば、その符号を原文にして code も残す（権限・空きの分類に使える）', () => {
    const out = commandFailureOf(Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT', stderr: '' }))
    expect(out.message).toBe('ENOENT')
    expect(classifyFailure(out).kind).toBe('fs-missing')
  })

  it('Go の no such host は回線断と見分けられる', () => {
    const out = commandFailureOf({ stderr: 'Error: Get "https://r.sakuracr.jp/v2/": dial tcp: lookup r.sakuracr.jp: no such host', code: 1 })
    expect(classifyFailure(out).kind).toBe('offline')
  })

  it('tar の stderr: 空き不足・権限は符号にして、手元のファイルの失敗と見分ける（レジストリや記述ミスと取り違えない）', () => {
    expect(classifyFailure(commandFailureOf({ stderr: 'tar: layer.tar: Cannot write: No space left on device', code: 2 })).kind).toBe('fs-full')
    expect(classifyFailure(commandFailureOf({ stderr: 'tar: app/x: Cannot open: Permission denied', code: 2 })).kind).toBe('fs-denied')
    expect(classifyFailure(commandFailureOf({ stderr: 'tar: something else', code: 2 })).kind).toBe('unknown')
  })

  it('時間切れで止めた（killed）ときは時間切れと分かる文にする', () => {
    expect(commandFailureOf({ killed: true, stderr: '' }).message).toMatch(/timed out/)
  })
})

describe('sshFailureOf / sshNetworkFailureText', () => {
  it.each([
    ['ssh: connect to host h port 22: Network is unreachable', 'offline'],
    ['ssh: connect to host h port 22: No route to host', 'offline'],
    ['Connection reset by 1.2.3.4 port 22', 'interrupted'],
    ['Connection closed by 1.2.3.4 port 22', 'interrupted'],
    ['client_loop: send disconnect: Broken pipe', 'interrupted'],
  ])('%s → %s', (stderr, kind) => {
    expect(classifyFailure(sshFailureOf(stderr)).kind).toBe(kind)
  })

  it('当たらない文・日本語の文は回線の失敗にしない（null）', () => {
    for (const s of ['', 'something unexpected', 'ls: /x: No such file or directory', 'Permission denied (publickey).', 'scp: /x: Permission denied']) {
      expect(sshNetworkFailureText(s), s).toBeNull()
    }
  })

  it('時間切れで止めた（stderr が空）ときは時間切れの文。読み取りと書き込みで文が違う', () => {
    const read = sshNetworkFailureText('', { timedOut: true, readOnly: true })!
    const write = sshNetworkFailureText('', { timedOut: true, checkAt: 'サーバのファイル一覧' })!
    expect(read).toContain('時間内に返事がありませんでした')
    expect(write).toContain('確かめられていません')
    expect(write).toContain('サーバのファイル一覧')
  })

  it('詳細は stderr の原文', () => {
    const t = sshNetworkFailureText('Connection reset by 1.2.3.4 port 22', { readOnly: true })!
    expect(splitFailureDetail(t).detail).toContain('Connection reset by')
  })
})

describe('記録の「予期しない失敗」（projectOps）', () => {
  beforeEach(() => { ops.resetProjectOpsForTests() })

  it('★ 投げられた回線断は日本語の文＋最後の行に詳細。英語の原文だけを埋め込まない', () => {
    const dir = '/tmp/koto-failed-result'
    ops.beginOp(dir, '公開', { target: 'vercel', handler: 'vercel:publish' })
    ops.finishOp(dir, { error: Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.vercel.com'), { code: 'ENOTFOUND' }) }) })
    const message = ops.getOps(dir).last!.result!.message!
    const { text, detail } = splitFailureDetail(message)
    expect(text).toMatch(/^予期しない失敗で止まりました: インターネットに接続できませんでした/)
    expect(detail).toContain('api.vercel.com')
  })

  it('見分けられない失敗は、今までどおり原文を後ろにつなぐ', () => {
    const dir = '/tmp/koto-failed-result2'
    ops.beginOp(dir, '公開', { target: 'vercel', handler: 'vercel:publish' })
    ops.finishOp(dir, { error: new Error('boom') })
    expect(ops.getOps(dir).last!.result!.message).toBe('予期しない失敗で止まりました: boom')
  })
})
