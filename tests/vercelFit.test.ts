import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serverListens, looksLikeFramework, judgeVercelFit } from '../src/shared/vercelFit'
import { summarizePreflight } from '../src/shared/preflight'

// ── なぜ要るか（2026-08-15）──────────────────────────────────────────
// Vercel の公開ボタンには確認が無く、注意書きは折りたたみの中にしか無かった。
// 常駐サーバのアプリを公開すると**デプロイは成功し、ソースが丸見えのページが出る**。
// 「成功と表示されながら壊れている」のがいちばん質の悪い失敗である（掟10）。

const dataTestServer = `
import http from 'node:http'
import { list, get, save, remove } from './koto-data.js'
http.createServer(async (req, res) => { res.end('hi') }).listen(process.env.PORT || 8080)
`

describe('常駐サーバかどうかを見分ける', () => {
  it('実機の data-test（http.createServer）を見分ける', () => {
    expect(serverListens(dataTestServer)).toBe(true)
  })

  it('express / fastify の定番も見分ける', () => {
    expect(serverListens("const app = express()\napp.listen(3000)")).toBe(true)
    expect(serverListens("fastify.listen({ port: 3000 })")).toBe(true)
  })

  it('ブラウザ側のコードを常駐サーバと誤解しない', () => {
    expect(serverListens("document.addEventListener('click', () => {})")).toBe(false)
    expect(serverListens("export function list() { return fetch('/api') }")).toBe(false)
  })
})

describe('Vercel が得意な作りかどうか', () => {
  it('Next.js を見分ける', () => {
    expect(looksLikeFramework({ dependencies: { next: '15.0.0' } })).toBe(true)
  })

  it('ビルドのあるプロジェクトを見分ける', () => {
    expect(looksLikeFramework({ scripts: { build: 'vite build' } })).toBe(true)
  })

  it('ただの package.json をフレームワークと決めつけない', () => {
    expect(looksLikeFramework({ name: 'x', scripts: { start: 'node server.js' } })).toBe(false)
    expect(looksLikeFramework(null)).toBe(false)
  })
})

describe('公開する前の確認（Vercel）', () => {
  it('★ 常駐サーバは止める — 公開先を変える道を示す', () => {
    const checks = judgeVercelFit({ packageJson: { name: 'data-test' }, listens: ['server.js'], usesData: [], hasFiles: true })
    const r = summarizePreflight(checks)
    expect(r.canPublish).toBe(false)
    const runtime = checks.find(c => c.id === 'runtime')!
    expect(runtime.status).toBe('ng')
    expect(runtime.note).toContain('AppRun')     // どうすればよいかまで書く
    expect(runtime.fix).toBe('ask-ai')
  })

  it('★ データの保存を使うアプリも止める — 渡す仕組みが無いのに公開すると黙って消える', () => {
    const checks = judgeVercelFit({ packageJson: null, listens: [], usesData: ['app.js'], hasFiles: true })
    expect(summarizePreflight(checks).canPublish).toBe(false)
    expect(checks.find(c => c.id === 'storage')!.note).toContain('読み書きできません')
  })

  it('静的サイトは通す', () => {
    const checks = judgeVercelFit({ packageJson: null, listens: [], usesData: [], hasFiles: true })
    expect(summarizePreflight(checks).canPublish).toBe(true)
    expect(checks.every(c => c.status === 'ok')).toBe(true)
  })

  it('Next.js も通す', () => {
    const checks = judgeVercelFit({ packageJson: { dependencies: { next: '15' } }, listens: [], usesData: [], hasFiles: true })
    expect(summarizePreflight(checks).canPublish).toBe(true)
  })

  it('判別できないものは止めない（warn どまり）', () => {
    const checks = judgeVercelFit({ packageJson: { name: 'x' }, listens: [], usesData: [], hasFiles: true })
    const r = summarizePreflight(checks)
    expect(r.canPublish).toBe(true)
    expect(checks.find(c => c.id === 'runtime')!.status).toBe('warn')
  })

  it('ファイルが無ければ止める', () => {
    const checks = judgeVercelFit({ packageJson: null, listens: [], usesData: [], hasFiles: false })
    expect(summarizePreflight(checks).canPublish).toBe(false)
  })
})

// ── 配線が外れていないか（掟6の3点セット＋UI）────────────────────────
// 判断だけ正しくても、画面に出ていなければ利用者は救われない。
describe('確認が画面まで届いている', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf-8')

  it('main / preload / 型 の3点が揃っている', () => {
    expect(read('src/main/ipc/vercel.ts')).toContain("ipcMain.handle('vercel:preflight'")
    expect(read('src/main/preload.ts')).toContain("ipcRenderer.invoke('vercel:preflight'")
    expect(read('src/renderer/global.d.ts')).toMatch(/preflight\(projectDir: string\)/)
  })

  it('★ 押さなくても確認が出る（Vercel の失敗は静かなので）', () => {
    const src = read('src/renderer/components/VercelPanel.tsx')
    expect(src).toMatch(/useEffect\(\(\) => \{ void runPreflight\(\) \}/)
  })

  it('★ 壊れると分かっているものを、一度の操作で公開しない', () => {
    const src = read('src/renderer/components/VercelPanel.tsx')
    expect(src).toContain('canPublish === false && !confirmBroken')
  })
})
