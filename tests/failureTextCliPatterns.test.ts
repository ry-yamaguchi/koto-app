import { describe, it, expect } from 'vitest'
import { classifyFailure, failureText } from '../src/shared/failureText'
import { isConnectionFailureMessage } from '../src/shared/connectionFailure'

const kindOf = (m: string) => { const i = classifyFailure(new Error(m)); return `${i.kind}/${i.sent}` }

describe('英語の CLI の文の見分け', () => {
  const hits: Array<[string, string, string]> = [
    ['no such host（crane）', 'Error: GET https://index.docker.io/v2/: dial tcp: lookup index.docker.io on 192.168.0.1:53: no such host', 'offline/no'],
    ['no such host 単独', 'no such host', 'offline/no'],
    ['dial tcp i/o timeout', 'Get "https://x.example/v2/": dial tcp 203.0.113.5:443: i/o timeout', 'timeout/no'],
    ['TLS handshake timeout', 'net/http: TLS handshake timeout', 'timeout/no'],
    ['Client.Timeout', 'context deadline exceeded (Client.Timeout exceeded while awaiting headers)', 'timeout/maybe'],
    ['context deadline exceeded', 'Error: context deadline exceeded', 'timeout/maybe'],
    ['connection refused', 'dial tcp 127.0.0.1:5000: connect: connection refused', 'offline/no'],
    ['network is unreachable', 'dial tcp 203.0.113.5:443: connect: network is unreachable', 'offline/no'],
    ['connection reset', 'read tcp 10.0.0.1:5000->203.0.113.5:443: read: connection reset by peer', 'interrupted/maybe'],
    ['broken pipe', 'write tcp 10.0.0.1:5000->203.0.113.5:443: write: broken pipe', 'interrupted/maybe'],
    ['unexpected EOF', 'Error: unexpected EOF', 'interrupted/maybe'],
    ['GOAWAY', 'http2: server sent GOAWAY and closed the connection', 'interrupted/maybe'],
    ['x509', 'tls: failed to verify certificate: x509: certificate signed by unknown authority', 'tls/maybe'],
    ['Claude ENOTFOUND', 'API Error: Unable to connect to API (ENOTFOUND)', 'offline/no'],
    ['Claude ETIMEDOUT', 'API Error: Unable to connect to API (ETIMEDOUT)', 'timeout/maybe'],
    ['Claude SSL', 'API Error: Unable to connect to API (SSL certificate problem)', 'tls/maybe'],
    ['Claude Request timed out', 'API Error: Request timed out. Check your connection.', 'timeout/maybe'],
    ['npm ERR! ENOTFOUND', 'npm ERR! code ENOTFOUND\nnpm ERR! network request failed', 'offline/no'],
    ['npm error EAI_AGAIN', 'npm error code EAI_AGAIN', 'offline/no'],
    ['npm error ETIMEDOUT', 'npm error code ETIMEDOUT', 'timeout/maybe'],
    ['npm error ECONNREFUSED', 'npm ERR! code ECONNREFUSED', 'offline/no'],
  ]
  for (const [name, msg, want] of hits) {
    it(`${name} は ${want}`, () => {
      expect(kindOf(msg)).toBe(want)
      // 符号の無い時間切れは、回線断ではなく時間切れの文のままにする
      expect(isConnectionFailureMessage(msg)).toBe(!want.startsWith('timeout') || /Unable to connect|npm/.test(msg))
    })
  }

  const misses: Array<[string, string]> = [
    ['not found だけ', 'package not found'],
    ['404 Not Found', 'Error: 404 Not Found'],
    ['denied だけ', 'requested access to the resource is denied'],
    ['timeout を含む普通の文', 'set the timeout option to 30 seconds'],
    ['npm の別の符号', 'npm ERR! code E404'],
    ['Unable to connect でも別の文', 'Unable to connect the printer'],
    ['日本語を含む', 'no such host を調べてください'],
    ['状態番号つき', '502 dial tcp: lookup x: no such host'],
  ]
  for (const [name, msg] of misses) {
    it(`${name} は当たらない`, () => {
      expect(classifyFailure(new Error(msg)).kind).toBe('unknown')
      expect(isConnectionFailureMessage(msg)).toBe(false)
    })
  }

  it('npm の手元のファイルの符号は回線断にしない', () => {
    expect(classifyFailure(new Error('npm ERR! code EACCES')).kind).toBe('fs-denied')
    expect(isConnectionFailureMessage('npm ERR! code EACCES')).toBe(false)
  })

  it('当たった文は日本語の文＋詳細になり、ホスト名が詳細に残る', () => {
    const t = failureText('lookup index.docker.io on 10.0.0.1:53: no such host', { readOnly: true })
    expect(t).toMatch(/^インターネットに接続できませんでした/)
    expect(t.split('\n').pop()).toContain('index.docker.io')
  })

  it('当たらない文は原文のまま', () => {
    expect(failureText('package not found')).toBe('package not found')
  })
})
