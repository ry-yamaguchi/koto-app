import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { splitFailureDetail } from '../src/shared/failureDetail'

// サーバのファイル（ssh/scp）とさくらのVPS（ssh/ssh-keyscan）。回線が途中で切れた・経路が無い・時間切れの失敗が、
// 英語の stderr のままではなく日本語の文＋最後の行の詳細（stderr の原文）で返ること。
// 手元のファイルの失敗（取得先フォルダを作れない）も同じ。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  stderr: '',
  killed: false,
  spawnStderr: '',
  spawnTimeout: false,
  /** コマンドごとの出力（無ければ spawnStderr だけを返して失敗する）。 */
  script: null as null | ((cmd: string) => { stdout?: string; stderr?: string; code?: number } | null),
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
}))
vi.mock('child_process', () => ({
  execFile: (_c: string, _a: string[], _o: unknown, cb: (err: unknown, stdout: string, stderr: string) => void) => {
    cb(Object.assign(new Error('Command failed'), { code: 255, killed: h.killed }), '', h.stderr)
  },
  spawn: (cmd: string) => {
    const scripted = h.script?.(cmd) ?? null
    const child: any = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = { write() {}, end() {} }
    child.kill = () => { setImmediate(() => child.emit('close', null)) }
    setImmediate(() => {
      if (h.spawnTimeout) return
      const out = scripted ?? { stderr: h.spawnStderr, code: 255 }
      if (out.stdout) child.stdout.emit('data', Buffer.from(out.stdout))
      if (out.stderr) child.stderr.emit('data', Buffer.from(out.stderr))
      child.emit('close', out.code ?? 0)
    })
    return child
  },
}))

import { registerRemoteHandlers } from '../src/main/ipc/remote'
import { registerVpsHandlers } from '../src/main/ipc/vps'
registerRemoteHandlers({} as any)
registerVpsHandlers({} as any)

const call = (ch: string, ...a: any[]) => h.handlers.get(ch)!({}, ...a)
const ARGS = { host: 'example.sakura.ne.jp', account: 'user1' }

beforeEach(() => { h.stderr = ''; h.killed = false; h.spawnStderr = ''; h.spawnTimeout = false; h.script = null })

describe('サーバのファイル（remote:*）', () => {
  const NETWORK: Array<[string, string, string]> = [
    ['経路が無い', 'ssh: connect to host example.sakura.ne.jp port 22: Network is unreachable', 'インターネットに接続できませんでした'],
    ['ホストへの経路が無い', 'ssh: connect to host example.sakura.ne.jp port 22: No route to host', 'インターネットに接続できませんでした'],
    ['相手に切られた', 'Connection reset by 203.0.113.9 port 22', '時間内に返事がありませんでした'],
    ['相手が閉じた', 'Connection closed by 203.0.113.9 port 22', '時間内に返事がありませんでした'],
  ]
  for (const [name, stderr, head] of NETWORK) {
    it(`★ remote:test（読み取り）${name}: 日本語の文＋詳細に stderr`, async () => {
      h.stderr = stderr
      const r = await call('remote:test', ARGS)
      const { text, detail } = splitFailureDetail(r.message)
      expect(text).toContain(head)
      expect(detail).toContain(stderr)
      expect(r.message.endsWith(detail)).toBe(true)
    })
  }

  it('★ 時間切れで止めた（stderr が空）remote:list: 「操作に失敗しました。」ではなく時間切れの文', async () => {
    h.killed = true
    const r = await call('remote:list', ARGS)
    expect(splitFailureDetail(r.message).text).toContain('時間内に返事がありませんでした')
  })

  it('★ remote:upload（書き込み）の途中で切れたら「済んだかは確かめられていません」', async () => {
    const local = path.join(os.tmpdir(), `koto-up-${process.pid}.txt`)
    fs.writeFileSync(local, 'x')
    try {
      h.stderr = 'client_loop: send disconnect: Broken pipe'
      const r = await call('remote:upload', { ...ARGS, remotePath: '/home/user1/www/index.html', localPath: local })
      const { text, detail } = splitFailureDetail(r.message)
      expect(text).toContain('確かめられていません')
      expect(text).toContain('サーバのファイル一覧')
      expect(detail).toContain('Broken pipe')
    } finally { fs.rmSync(local, { force: true }) }
  })

  it('従来の個別の文（鍵認証・名前が引けない）は変わらない', async () => {
    h.stderr = 'user1@example.sakura.ne.jp: Permission denied (publickey).'
    expect(splitFailureDetail((await call('remote:test', ARGS)).message).text).toMatch(/^SSHで接続できませんでした。/)
    h.stderr = 'ssh: Could not resolve hostname x: nodename nor servname provided'
    expect(splitFailureDetail((await call('remote:test', ARGS)).message).text).toMatch(/^ホスト名を解決できませんでした。/)
  })

  it('見分けられない stderr は今までどおり原文のまま', async () => {
    h.stderr = 'something unexpected'
    expect((await call('remote:test', ARGS)).message).toBe('something unexpected')
  })

  it('★ remote:download: 取得先のフォルダを作れない手元の失敗は日本語の文＋詳細（EACCES を英語のまま出さない）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-dl-'))
    fs.chmodSync(root, 0o500)
    try {
      const r = await call('remote:download', { ...ARGS, remotePath: '/home/user1/www/a.html', localPath: path.join(root, 'sub', 'a.html') })
      const { text, detail } = splitFailureDetail(r.message)
      expect(text).not.toMatch(/^EACCES/)
      expect(text).toContain('書き込めません')
      expect(detail).toContain('EACCES')
    } finally { fs.chmodSync(root, 0o700); fs.rmSync(root, { recursive: true, force: true }) }
  })
})

describe('さくらのVPS（vps:*）', () => {
  const KEYLINE = 'vps.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'
  const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----"

  it('★ vps:scanHostKey: 経路が無い stderr は日本語の文＋詳細', async () => {
    h.spawnStderr = 'connect (vps.example.com): Network is unreachable'
    const r = await call('vps:scanHostKey', 'vps.example.com', 22)
    expect(r.ok).toBe(false)
    const { text, detail } = splitFailureDetail(r.message)
    expect(text).toContain('インターネットに接続できませんでした')
    expect(detail).toContain('Network is unreachable')
  })

  it('★ vps:scanHostKey: 回線以外の失敗は、今までの文に stderr を詳細として添える', async () => {
    h.spawnStderr = 'getaddrinfo vps.example.com: nodename nor servname provided, or not known'
    const r = await call('vps:scanHostKey', 'vps.example.com', 22)
    const { text, detail } = splitFailureDetail(r.message)
    expect(text).toMatch(/^ホスト鍵を取得できませんでした/)
    expect(detail).toContain('nodename nor servname')
  })

  const FP = 'SHA256:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN012'
  /** keyscan と ssh-keygen は成功し、最後の ssh だけが指定の stderr で失敗する。 */
  const sshFails = (stderr: string) => {
    h.script = cmd => cmd === 'ssh-keyscan' ? { stdout: `${KEYLINE}\n`, code: 0 }
      : cmd === 'ssh-keygen' ? { stdout: `256 ${FP} vps.example.com (ED25519)\n`, code: 0 }
        : { stderr, code: 255 }
  }

  it('★ vps:testConnection（読み取り）: 途中で切れた ssh は時間内に返事がなかった文＋詳細', async () => {
    sshFails('Connection reset by 203.0.113.9 port 22')
    const r = await call('vps:testConnection', 'vps.example.com', 22, 'deploy', key, FP)
    expect(r.ok).toBe(false)
    const { text, detail } = splitFailureDetail(r.message)
    expect(text).toContain('時間内に返事がありませんでした')
    expect(detail).toContain('Connection reset by')
    expect(r.message.endsWith(detail)).toBe(true)
  })

  it('★ vps:hardenSshd（書き込み）: 同じ切れ方でも「済んだかは確かめられていません」', async () => {
    sshFails('Connection closed by 203.0.113.9 port 22')
    const r = await call('vps:hardenSshd', 'vps.example.com', 22, 'deploy', key, FP)
    expect(splitFailureDetail(r.message).text).toContain('確かめられていません')
    expect(splitFailureDetail(r.message).detail).toContain('Connection closed by')
  })

  it('従来の個別の文（接続拒否）にも詳細が付く', async () => {
    sshFails('ssh: connect to host vps.example.com port 22: Connection refused')
    const r = await call('vps:testConnection', 'vps.example.com', 22, 'deploy', key, FP)
    const { text, detail } = splitFailureDetail(r.message)
    expect(text).toMatch(/^接続を拒否されました/)
    expect(detail).toContain('Connection refused')
  })

  it('見分けられない ssh の stderr は今までどおり原文のまま', async () => {
    sshFails('something unexpected')
    expect((await call('vps:testConnection', 'vps.example.com', 22, 'deploy', key, FP)).message).toBe('something unexpected')
  })
})
