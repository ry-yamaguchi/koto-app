import { describe, it, expect, vi, beforeEach } from 'vitest'

// ssh/scp の失敗は、stderr を見て日本語の文（friendlySshError）にする。
// 文のすぐ下に stderr の原文を「詳細: …」で添えること（問い合わせで原因を見分けるため）を、
// 入口（remote:test・remote:list）を実際に登録して呼び、偽の ssh の出力で確かめる。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  stderr: '',
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
}))

vi.mock('child_process', () => ({
  execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (err: unknown, stdout: string, stderr: string) => void) => {
    cb(Object.assign(new Error('Command failed'), { code: 255 }), '', h.stderr)
  },
}))

import { registerRemoteHandlers } from '../src/main/ipc/remote'
import { splitFailureDetail } from '../src/shared/failureDetail'

registerRemoteHandlers({} as any)

const test = async (stderr: string): Promise<string> => {
  h.stderr = stderr
  const r = await h.handlers.get('remote:test')!({}, { host: 'example.sakura.ne.jp', account: 'user1' })
  expect(r.ok).toBe(false)
  return r.message as string
}

beforeEach(() => { h.stderr = '' })

describe('friendlySshError: 日本語の文のすぐ下に、stderr の原文を詳細として添える', () => {
  const CASES: Array<[string, string, string]> = [
    ['鍵認証', 'user1@example.sakura.ne.jp: Permission denied (publickey,password).', 'SSHで接続できませんでした。'],
    ['鍵情報', 'Host key verification failed.', 'サーバの鍵情報の確認でエラーになりました。'],
    ['ホスト名', 'ssh: Could not resolve hostname example.sakura.ne.jp: nodename nor servname provided', 'ホスト名を解決できませんでした。'],
    ['接続拒否', 'ssh: connect to host example.sakura.ne.jp port 22: Connection refused', 'サーバに接続できませんでした（タイムアウト/接続拒否）。'],
    ['ファイル', 'ls: /home/user1/www: No such file or directory', '指定したファイルまたはフォルダが見つかりませんでした。'],
  ]
  for (const [name, stderr, head] of CASES) {
    it(`${name}: 文のあとに「詳細: stderr」が最後の1行で付く`, async () => {
      const m = await test(stderr)
      const { text, detail } = splitFailureDetail(m)
      expect(text.startsWith(head)).toBe(true)
      expect(detail).toBe(stderr)
      expect(m.endsWith(detail)).toBe(true)
      expect(m.split('\n')).toHaveLength(text.split('\n').length + 1)
    })
  }

  it('複数行の stderr は1行にまとまる', async () => {
    const m = await test('Warning: Permanently added x\nuser1@example.sakura.ne.jp: Permission denied (publickey).\n')
    const { detail } = splitFailureDetail(m)
    expect(detail).toContain('Warning: Permanently added x user1@example.sakura.ne.jp: Permission denied')
    expect(detail).not.toContain('\n')
  })

  it('見分けられない stderr は、これまでどおり原文だけ（詳細を重ねない）', async () => {
    const m = await test('something odd happened')
    expect(m).toBe('something odd happened')
  })

  it('stderr が空なら固定の文だけ', async () => {
    expect(await test('')).toBe('操作に失敗しました。')
  })

  it('一覧の失敗（remote:list）も同じ形で詳細が付く', async () => {
    h.stderr = 'ssh: connect to host example.sakura.ne.jp port 22: Connection refused'
    const r = await h.handlers.get('remote:list')!({}, { host: 'example.sakura.ne.jp', account: 'user1' })
    expect(splitFailureDetail(r.message).detail).toContain('Connection refused')
  })
})
