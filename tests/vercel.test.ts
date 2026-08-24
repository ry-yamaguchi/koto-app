import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  sha1Hex,
  collectDeployFiles,
  buildDeploymentBody,
  extractDeployment,
  vercelErrorMessage,
  sanitizeProjectName,
} from '../src/main/vercel/client'

describe('sha1Hex', () => {
  it('computes the known SHA1 of an empty buffer', () => {
    expect(sha1Hex(Buffer.from(''))).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709')
  })

  it('computes the known SHA1 of a simple string', () => {
    expect(sha1Hex(Buffer.from('hello'))).toBe('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d')
  })
})

describe('collectDeployFiles', () => {
  let dir: string

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vercel-collect-'))

    // 含めるべきファイル（dist/build 等のビルド成果物も除外しない）。
    fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>')
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'dist', 'bundle.js'), 'console.log(1)')
    fs.mkdirSync(path.join(dir, 'build'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'build', 'out.css'), 'body{}')
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'src', 'main.ts'), 'export {}')

    // 除外されるべきディレクトリ
    fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'module.exports={}')
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main')
    fs.mkdirSync(path.join(dir, '.sakuraide-backup', '2026'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.sakuraide-backup', '2026', 'x.txt'), 'x')
    fs.mkdirSync(path.join(dir, '.sakuraide'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.sakuraide', 'chat.json'), '{}')
    fs.mkdirSync(path.join(dir, '.sakura-cloud'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.sakura-cloud', 'state.json'), '{}')

    // 除外されるべきファイル
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'binary-ish')
    fs.writeFileSync(path.join(dir, '.sakuraide.json'), '{"target":"vercel"}')
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1')
    fs.writeFileSync(path.join(dir, '.env.local'), 'SECRET=2')
    fs.writeFileSync(path.join(dir, '.env.production'), 'SECRET=3')
  })

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('includes ordinary project files plus build output (dist/build are not excluded)', () => {
    const files = collectDeployFiles(dir)
    const rels = files.map(f => f.relPath).sort()
    expect(rels).toEqual(['dist/bundle.js', 'build/out.css', 'index.html', 'src/main.ts'].sort())
  })

  it('excludes node_modules, .git, .sakuraide*, .sakura-cloud, .DS_Store, .sakuraide.json, and .env files', () => {
    const files = collectDeployFiles(dir)
    const rels = files.map(f => f.relPath)
    expect(rels.some(r => r.includes('node_modules'))).toBe(false)
    expect(rels.some(r => r.includes('.git'))).toBe(false)
    expect(rels.some(r => r.includes('.sakuraide-backup'))).toBe(false)
    expect(rels.some(r => r.startsWith('.sakuraide/'))).toBe(false)
    expect(rels.some(r => r.includes('.sakura-cloud'))).toBe(false)
    expect(rels).not.toContain('.DS_Store')
    expect(rels).not.toContain('.sakuraide.json')
    expect(rels).not.toContain('.env')
    expect(rels).not.toContain('.env.local')
    expect(rels).not.toContain('.env.production')
  })

  it('computes size and sha1 for each collected file', () => {
    const files = collectDeployFiles(dir)
    const idx = files.find(f => f.relPath === 'index.html')!
    const buf = fs.readFileSync(path.join(dir, 'index.html'))
    expect(idx.size).toBe(buf.length)
    expect(idx.sha).toBe(sha1Hex(buf))
    expect(idx.absPath).toBe(path.join(dir, 'index.html'))
  })

  it('uses POSIX-style relative paths for nested files', () => {
    const files = collectDeployFiles(dir)
    const rels = files.map(f => f.relPath)
    expect(rels).toContain('src/main.ts')
    expect(rels.some(r => r.includes('\\'))).toBe(false)
  })
})

describe('buildDeploymentBody', () => {
  it('maps relPath/sha/size into files[] and defaults target to production', () => {
    const body = buildDeploymentBody('my-app', [
      { relPath: 'index.html', sha: 'abc', size: 10 },
      { relPath: 'src/main.js', sha: 'def', size: 20 },
    ])
    expect(body).toEqual({
      name: 'my-app',
      files: [
        { file: 'index.html', sha: 'abc', size: 10 },
        { file: 'src/main.js', sha: 'def', size: 20 },
      ],
      projectSettings: { framework: null },
      target: 'production',
    })
  })

  it('allows overriding the target', () => {
    const body = buildDeploymentBody('my-app', [], { target: 'preview' })
    expect(body.target).toBe('preview')
  })

  it('produces an empty files array for an empty input', () => {
    const body = buildDeploymentBody('my-app', [])
    expect(body.files).toEqual([])
  })
})

describe('extractDeployment', () => {
  it('extracts id, readyState and prepends https:// to the bare hostname url', () => {
    const result = extractDeployment({ id: 'dpl_1', url: 'my-app-abc123.vercel.app', readyState: 'READY' })
    expect(result).toEqual({ id: 'dpl_1', url: 'https://my-app-abc123.vercel.app', readyState: 'READY', error: null })
  })

  it('does not double-prefix a url that already has a protocol', () => {
    const result = extractDeployment({ id: 'dpl_1', url: 'https://my-app.vercel.app', readyState: 'READY' })
    expect(result.url).toBe('https://my-app.vercel.app')
  })

  it('falls back to status when readyState is absent', () => {
    const result = extractDeployment({ id: 'dpl_1', status: 'BUILDING' })
    expect(result.readyState).toBe('BUILDING')
  })

  it('extracts an error message from error.message', () => {
    const result = extractDeployment({ id: 'dpl_1', readyState: 'ERROR', error: { code: 'BUILD_FAILED', message: 'build failed' } })
    expect(result.error).toBe('build failed')
  })

  it('extracts an error message when error is a plain string', () => {
    const result = extractDeployment({ id: 'dpl_1', error: 'something went wrong' })
    expect(result.error).toBe('something went wrong')
  })

  it('returns all nulls for an empty object', () => {
    expect(extractDeployment({})).toEqual({ id: null, url: null, readyState: null, error: null })
  })

  it('returns all nulls for null/undefined', () => {
    expect(extractDeployment(null)).toEqual({ id: null, url: null, readyState: null, error: null })
    expect(extractDeployment(undefined)).toEqual({ id: null, url: null, readyState: null, error: null })
  })
})

describe('vercelErrorMessage', () => {
  it('returns a token-check message for a 401 without a team hint', () => {
    const msg = vercelErrorMessage({ error: { code: 'forbidden', message: 'Not authorized' } }, 401)
    expect(msg).toContain('トークン')
    expect(msg).toContain('Not authorized')
  })

  it('returns a token-check message for a 403 without a team hint', () => {
    const msg = vercelErrorMessage({ error: { code: 'forbidden', message: 'no access' } }, 403)
    expect(msg).toContain('トークン')
  })

  it('returns a team-hint message for a 403 whose message mentions team', () => {
    const msg = vercelErrorMessage({ error: { code: 'forbidden', message: 'Not authorized for this team' } }, 403)
    expect(msg).toContain('チームID')
  })

  it('returns a team-hint message for a 403 whose code mentions team', () => {
    const msg = vercelErrorMessage({ error: { code: 'team_not_found', message: 'no such team' } }, 403)
    expect(msg).toContain('チームID')
  })

  it('returns the plain error.message for a general (non-401/403) error', () => {
    const msg = vercelErrorMessage({ error: { code: 'bad_request', message: '名前が既に使われています' } }, 400)
    expect(msg).toBe('名前が既に使われています')
  })

  it('falls back to JSON.stringify when no message is present', () => {
    const data = { foo: 'bar' }
    expect(vercelErrorMessage(data)).toBe(JSON.stringify(data))
  })

  it('returns an empty string for null/undefined', () => {
    expect(vercelErrorMessage(null)).toBe('')
    expect(vercelErrorMessage(undefined)).toBe('')
  })

  it('returns a sliced string as-is for a plain string response', () => {
    expect(vercelErrorMessage('plain text error')).toBe('plain text error')
  })
})

describe('sanitizeProjectName', () => {
  it('lowercases and keeps alphanumeric/hyphen characters', () => {
    expect(sanitizeProjectName('My-App123')).toBe('my-app123')
  })

  it('replaces disallowed characters with hyphens and collapses repeats', () => {
    expect(sanitizeProjectName('my app_v2!!')).toBe('my-app-v2')
  })

  it('strips leading and trailing hyphens', () => {
    expect(sanitizeProjectName('--hello--')).toBe('hello')
  })

  it('falls back to "app" when the result would be empty', () => {
    expect(sanitizeProjectName('')).toBe('app')
    expect(sanitizeProjectName('!!!')).toBe('app')
  })

  it('truncates names longer than 100 characters and trims a trailing hyphen at the cut', () => {
    const long = 'a'.repeat(105)
    const result = sanitizeProjectName(long)
    expect(result.length).toBeLessThanOrEqual(100)
    expect(result.endsWith('-')).toBe(false)
  })

  it('handles Japanese folder names by hyphenating them away, falling back to app', () => {
    expect(sanitizeProjectName('日本語フォルダ')).toBe('app')
  })
})

// ── 資格情報まわりの配線（2026-08-22 Ryosuke 指摘）──────────────────────
// ① 接続テストが甘かった: `GET /v2/user` が 200 なら「接続OK」としていたが、
//    これは**トークンが有効**なことしか見ていない。範囲（スコープ）の外を
//    公開しようとすると落ちるのに、緑の ✅ が出ていた。
// ② トークンの先頭の形（`vercel_…`）を決めつけて案内していた。Vercel 側の
//    都合で変わりうるので、決めつけを画面に書かない。
// ③ レジストリのパスワードだけ利用者にも見えなかった。**Koto が自動生成した
//    値で、Koto の中にしか無い**のに取り出せなかった。
describe('資格情報まわりの配線', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')

  // 2026-08-22 実測＋公式明記: **Project 範囲のトークンはユーザー階層・チーム階層を拒否する**。
  // つまり `/v2/user` を関門にすると、正しいトークンでも 403 で弾いてしまう。
  it('接続テストの関門はプロジェクト一覧（ユーザー階層に依存しない）', () => {
    const s = read('src/main/vercel/client.ts')
    expect(s).toContain("VERCEL_API_BASE + VERCEL_PROJECTS_PATH + '?limit=1' + this.teamQuery('&')")
    // ユーザー情報の取得は「取れたら添える」だけ。失敗しても異常にしない
    expect(s).toContain('/* 取れなくてよい */')
    expect(s).not.toContain('const r = await this.send(\'GET\', VERCEL_API_BASE + VERCEL_USER_PATH')
  })

  it('範囲つきトークンに teamId が付いていたら、外すよう伝える', () => {
    const s = read('src/main/vercel/client.ts')
    // teamId を外して再試行し、通ったら印を返す。
    // **条件ごと固定する**（中の行だけ見ると、条件を false にされても素通りする。
    //  2026-08-22 のミューテーション試験で実際に素通りした・掟10）
    expect(s).toContain('if (!r.ok && this.teamId) {')
    expect(s).toContain("const retry = await this.send('GET', VERCEL_API_BASE + VERCEL_PROJECTS_PATH + '?limit=1', { timeoutMs: 15000 })")
    expect(s).toContain('if (retry.ok) { r = retry; dropTeamId = true }')
    const ipc = read('src/main/ipc/vercel.ts')
    expect(ipc).toContain('if (r.dropTeamId)')
    expect(ipc).toContain('warn: true')
    const ui = read('src/renderer/components/CredentialsModal.tsx')
    expect(ui).toContain("setState(r.warn ? 'warn' : 'ok')")
    expect(ui).toContain("{state === 'warn' &&")
  })

  it('接続テストは読み取りだけで、何も作らない', () => {
    const s = read('src/main/vercel/client.ts')
    const fn = s.slice(s.indexOf('async testConnection('), s.indexOf('async testConnection(') + 2000)
    expect(fn).not.toContain("'POST'")
    expect(fn).not.toContain("'DELETE'")
  })

  it('トークンの先頭の形を決めつけて案内しない', () => {
    const ui = read('src/renderer/components/CredentialsModal.tsx')
    expect(ui).not.toContain("placeholder: 'vercel_…'")
  })

  it('レジストリのパスワードは、表示とコピーができる（Koto の中にしか無い値なので）', () => {
    const ui = read('src/renderer/components/CredentialsModal.tsx')
    expect(ui).toContain('showRegPw ? regInfo.password : ')
    expect(ui).toContain('<CopyButton text={regInfo.password}')
    // 「実値は表示しない」の一点張りに戻ったら落とす
    expect(ui).not.toContain('（実値は表示しない）')
  })
})
