import { describe, it, expect } from 'vitest'
import {
  diagnoseImageFailure, builtinBuildFailure, dockerBuildFailure, dockerLoginFailure, dockerPushFailure,
} from '../src/main/cloud/imageFailure'
import { splitFailureDetail } from '../src/shared/failureDetail'

// ── 組み立て・push・ログインの失敗の見立て（回線断を「レジストリの不調」「記述ミス」と取り違えない）────────────
// 以前は crane の `dial tcp: lookup index.docker.io: no such host` が「レジストリが消えたかも」に当たり、
// レジストリを設定し直すボタンへ誘っていた。回線が切れているだけなのに。

const JAPANESE = /[぀-ヿ一-鿿]/
const online = (v: boolean) => ({ probeOnline: async () => v })

const DOCKER_IO = 'Error: fetching "docker.io/library/node:22-alpine": Get "https://index.docker.io/v2/": dial tcp: lookup index.docker.io on 192.168.1.1:53: no such host'
const SAKURA_REGISTRY = 'Error: pushing manifest: Get "https://myapp-1a2b.sakuracr.jp/v2/": dial tcp: lookup myapp-1a2b.sakuracr.jp: no such host'
const EACCES = "EACCES: permission denied, open '/Users/me/app/secret.txt'"

describe('diagnoseImageFailure', () => {
  it('レジストリ以外（docker.io）の回線断は、回線の文。つながっているかは確かめない', async () => {
    let probed = 0
    const v = await diagnoseImageFailure(DOCKER_IO, {}, { probeOnline: async () => { probed++; return true } })
    expect(v.handled).toBe(true)
    if (!v.handled) return
    expect(splitFailureDetail(v.message).text).toContain('インターネットに接続できませんでした')
    expect(splitFailureDetail(v.message).detail).toContain('index.docker.io')
    expect(probed).toBe(0)
  })

  it('さくらのレジストリへの no such host: 回線が切れているなら回線の文', async () => {
    const v = await diagnoseImageFailure(SAKURA_REGISTRY, {}, online(false))
    expect(v.handled).toBe(true)
    if (v.handled) expect(splitFailureDetail(v.message).detail).toContain('myapp-1a2b.sakuracr.jp')
  })

  it('さくらのレジストリへの no such host: つながっているなら、見立てはレジストリに任せる（回線系だった印つき）', async () => {
    expect(await diagnoseImageFailure(SAKURA_REGISTRY, {}, online(true))).toEqual({ handled: false, networkLike: true })
  })

  it('手元のファイルの失敗（権限・空き）は、レジストリを疑わずにその文にする', async () => {
    const denied = await diagnoseImageFailure(EACCES, {}, online(true))
    expect(denied.handled).toBe(true)
    if (denied.handled) {
      expect(splitFailureDetail(denied.message).text).toContain('書き込めません')
      expect(denied.message).not.toContain('レジストリ')
    }
    const full = await diagnoseImageFailure('ENOSPC: no space left on device, mkdtemp /tmp/sakura-img-x', {}, online(true))
    expect(full.handled).toBe(true)
    if (full.handled) expect(splitFailureDetail(full.message).text).toContain('ディスクの空きが足りません')
  })

  it('見分けられない失敗は、触らない（今までの見立てに任せる）', async () => {
    for (const raw of ['exit status 1', 'unknown service', 'denied: requested access to the resource is denied', '404 Not Found', '']) {
      expect(await diagnoseImageFailure(raw, {}, online(true)), raw).toEqual({ handled: false, networkLike: false })
    }
  })
})

describe('builtinBuildFailure（標準の組み立て・push）', () => {
  it('★ B1: docker.io への回線断は「レジストリの不調」と言わず、ボタンも出さない', async () => {
    const r = await builtinBuildFailure({ message: DOCKER_IO, log: '' }, online(true))
    expect(r.hint).toBeUndefined()
    expect(r.message).not.toContain('コンテナレジストリへプッシュできませんでした')
    expect(r.message).not.toContain('レジストリを設定し直す')
    expect(r.message).not.toContain('package.json')
    expect(splitFailureDetail(r.message).text).toContain('インターネットに接続できませんでした')
    expect(splitFailureDetail(r.message).detail).toContain('index.docker.io')
  })

  it('★ B1: レジストリ宛の no such host でも、回線が切れているなら回線の文', async () => {
    const r = await builtinBuildFailure({ message: SAKURA_REGISTRY, log: '' }, online(false))
    expect(r.hint).toBeUndefined()
    expect(r.message).not.toContain('レジストリを設定し直す')
    expect(splitFailureDetail(r.message).detail).toContain('sakuracr.jp')
  })

  it('★ つながっていて、レジストリ宛の no such host なら、今までのレジストリの見立て＋ボタン＋詳細', async () => {
    const r = await builtinBuildFailure({ message: SAKURA_REGISTRY, log: '' }, online(true))
    expect(r.hint).toBe('reset-registry')
    expect(splitFailureDetail(r.message).text).toContain('レジストリを設定し直す')
    expect(splitFailureDetail(r.message).detail).toContain('myapp-1a2b.sakuracr.jp')
  })

  it('★ B1: 手元のファイルの EACCES は、レジストリのせいにしない', async () => {
    const r = await builtinBuildFailure({ message: EACCES, log: '' }, online(true))
    expect(r.hint).toBeUndefined()
    expect(r.message).not.toContain('レジストリ')
    expect(splitFailureDetail(r.message).text).toContain('書き込めません')
  })

  it('★ B1: ENOSPC は「package.json の記述ミス」と言わない', async () => {
    const r = await builtinBuildFailure({ message: 'ENOSPC: no space left on device, write', log: '' }, online(true))
    expect(r.message).not.toContain('package.json')
    expect(splitFailureDetail(r.message).text).toContain('ディスクの空きが足りません')
  })

  it('npm が種類を見分けた文（diagnosed）は、そのまま見出し（別の見出しに置き換えない）', async () => {
    const message = 'インターネットに接続できませんでした。接続を確かめてから、もう一度お試しください。\n詳細: code ENOTFOUND'
    const r = await builtinBuildFailure({ message, log: '', diagnosed: true }, online(true))
    expect(r.message).toBe(message)
    expect(r.hint).toBeUndefined()
  })

  it('今までどおり: 認証の失敗はレジストリのボタン、ほかの失敗は記述ミスの見立て', async () => {
    const auth = await builtinBuildFailure({ message: 'unexpected status code 401 Unauthorized', log: '' }, online(true))
    expect(auth.hint).toBe('reset-registry')
    expect(auth.message).toContain('レジストリを設定し直す')
    const other = await builtinBuildFailure({ message: 'SyntaxError: Unexpected token', log: 'x' }, online(true))
    expect(other.hint).toBeUndefined()
    expect(other.message).toContain('package.json の記述ミス')
    expect(splitFailureDetail(other.message).detail).toBe('')
  })

  it('詳細（detail）には、原文と組み立てのログを今までどおり残す', async () => {
    const r = await builtinBuildFailure({ message: DOCKER_IO, log: 'stdout line' }, online(true))
    expect(r.detail).toBe(`${DOCKER_IO}\nstdout line`)
  })
})

describe('Docker（エキスパート）', () => {
  it('★ build の回線断は「Dockerfile の記述ミス」と言わない', async () => {
    const r = await dockerBuildFailure('failed to resolve source metadata for docker.io/library/node:22: dial tcp: lookup registry-1.docker.io: no such host', online(true))
    expect(r.message).not.toContain('Dockerfile の記述ミス')
    expect(splitFailureDetail(r.message).detail).toContain('registry-1.docker.io')
    expect(JAPANESE.test(splitFailureDetail(r.message).text)).toBe(true)
  })

  it('build の本当の記述ミスは今までの文', async () => {
    const r = await dockerBuildFailure('ERROR: failed to solve: dockerfile parse error on line 3: unknown instruction', online(true))
    expect(r.message).toContain('Dockerfile の記述ミス')
  })

  it('★ login の回線断は「パスワードを作り直して」と言わず、ボタンも出さない', async () => {
    const r = await dockerLoginFailure('Error response from daemon: Get "https://x.sakuracr.jp/v2/": dial tcp: lookup x.sakuracr.jp: no such host', online(false))
    expect(r.hint).toBeUndefined()
    expect(r.message).not.toContain('パスワードを作り直して')
  })

  it('login が拒否されたら、今までどおりボタンつき', async () => {
    const r = await dockerLoginFailure('Error response from daemon: login attempt failed with status: 401 Unauthorized', online(true))
    expect(r.hint).toBe('reset-registry')
    expect(r.message).toContain('パスワードを作り直して')
  })

  it('★ push の回線断は回線の文（途中で切れたなら済んだかは確かめられていないと言う）', async () => {
    const r = await dockerPushFailure('error from registry: read tcp 10.0.0.2:5555->1.2.3.4:443: connection reset by peer', online(true))
    expect(splitFailureDetail(r.message).text).toContain('操作が済んだかは確かめられていません')
    expect(splitFailureDetail(r.message).detail).toContain('connection reset by peer')
  })

  it('push のその他の失敗は今までの文', async () => {
    const r = await dockerPushFailure('denied: requested access to the resource is denied', online(true))
    expect(r.message).toContain('インターネット接続を確認して')
  })
})

describe('つながっていても、レジストリのせいではない回線系の失敗はレジストリに任せない', () => {
  const BROKEN_PIPE = 'Error: pushing layer: PATCH https://myapp-1a2b.sakuracr.jp/v2/app/blobs/uploads/x: write: broken pipe'
  const CLIENT_TIMEOUT = 'Error: Get "https://myapp-1a2b.sakuracr.jp/v2/": context deadline exceeded (Client.Timeout exceeded while awaiting headers)'
  const TLS_TIMEOUT = 'Error: Get "https://myapp-1a2b.sakuracr.jp/v2/": net/http: TLS handshake timeout'

  it.each([['途中の切断', BROKEN_PIPE], ['時間切れ', CLIENT_TIMEOUT], ['TLS の時間切れ', TLS_TIMEOUT]])('%s: probe がつながっていても、組み立てはビルドの記述ミス・レジストリの見立てにしない', async (_n, raw) => {
    const v = await diagnoseImageFailure(raw, {}, online(true))
    expect(v.handled).toBe(true)
    const built = await builtinBuildFailure({ message: raw, log: '' }, online(true))
    expect(built.message).not.toContain('package.json')
    expect(built.message).not.toContain('コンテナレジストリへプッシュできませんでした')
    expect(built.hint).toBeUndefined()
    const login = await dockerLoginFailure(raw, online(true))
    expect(login.message).not.toContain('パスワードを作り直して')
    expect(login.hint).toBeUndefined()
  })

  it('コンテナの中の npm の権限の失敗は、手元のフォルダのせいにしない（Dockerfile の見立てのまま）', async () => {
    const log = 'Step 4/6 : RUN npm install\nnpm ERR! code EACCES\nnpm ERR! syscall mkdir\nnpm ERR! path /app/node_modules'
    const r = await dockerBuildFailure(log, online(true))
    expect(r.message).toContain('Dockerfile の記述ミス')
    expect(r.message).not.toContain('書き込めません')
    // 回線の失敗は今までどおり回線の文
    const offline = await dockerBuildFailure(DOCKER_IO, online(true))
    expect(offline.message).not.toContain('Dockerfile の記述ミス')
  })
})
