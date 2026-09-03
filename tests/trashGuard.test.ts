import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { canTrash } from '../src/shared/trashGuard'

// ── 2026-08-20 セキュリティ点検 ──────────────────────────────────────
// `fs:trash` は**どんな絶対パスでも**ゴミ箱へ送れる作りだった。
// いまは画面側の守り（contextIsolation / sandbox / dangerouslySetInnerHTML なし /
// eval なし）で到達する道は無いが、1枚目の守りに頼り切らない。

const HOME = '/Users/taro'

describe('ゴミ箱へ送ってよい場所', () => {
  it('★★ ホームの外は送れない', () => {
    for (const p of ['/', '/Applications', '/System/Library', '/etc/passwd', '/Users/hanako/x/y']) {
      expect(canTrash(HOME, p).ok).toBe(false)
    }
  })

  it('★★ ホーム直下は送れない（Library・作業フォルダ自体を守る）', () => {
    for (const p of [HOME, `${HOME}/Library`, `${HOME}/SAKURAIDE`, `${HOME}/Documents`]) {
      expect(canTrash(HOME, p).ok).toBe(false)
    }
  })

  it('★★ プロジェクトとその中身は送れる（狭めすぎない）', () => {
    // プロジェクトごと削除する機能があるので、プロジェクト自体も送れる必要がある
    expect(canTrash(HOME, `${HOME}/SAKURAIDE/landingTEST`).ok).toBe(true)
    expect(canTrash(HOME, `${HOME}/SAKURAIDE/landingTEST/images/a.jpg`).ok).toBe(true)
    // 作業フォルダを変えている人もいる
    expect(canTrash(HOME, `${HOME}/Documents/koto/myapp`).ok).toBe(true)
  })

  it('★★ `..` を含む道は受けない', () => {
    expect(canTrash(HOME, `${HOME}/SAKURAIDE/../../etc/passwd`).ok).toBe(false)
  })

  it('★ 断るときは理由をそのまま出せる文にする', () => {
    const r = canTrash(HOME, '/etc/passwd')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('ホームフォルダの中')
  })
})

describe('配線', () => {
  const fsIpc = readFileSync(join(__dirname, '..', 'src/main/ipc/fs.ts'), 'utf-8')

  it('★★ fs:trash がこの判断を通っている', () => {
    // home は os.homedir()（$HOME を尊重）。app.getPath('home') は macOS で $HOME を
    // 見ないため、e2e の HOME 隔離時に fs:homeDir 側の home とズレる（2026-09-02 実測）
    expect(fsIpc).toContain('canTrash(os.homedir()')
    expect(fsIpc).toContain('if (!check.ok) throw new Error(check.reason)')
  })

  it('★★ fs:homeDir は $HOME を尊重する os.homedir() を返す', () => {
    expect(fsIpc).toContain("ipcMain.handle('fs:homeDir', () => os.homedir())")
    expect(fsIpc).not.toContain("ipcMain.handle('fs:homeDir', () => app.getPath('home'))")
  })
})

// ── 強制終了で権限が上がったまま残らないようにする（2026-08-20 点検）────────
describe('権限の上げっぱなしを残さない', () => {
  const cloud = readFileSync(join(__dirname, '..', 'src/main/ipc/cloud.ts'), 'utf-8')

  it('★★ 上げる前に印を残す（途中で落ちても分かるように）', () => {
    const at = cloud.indexOf('async function withDeletePermission')
    const block = cloud.slice(at, at + 3000)
    expect(block).toContain('opts.markElevated(true)')
    expect(block).toContain('if (restored) opts.markElevated(false)')
  })

  it('★★ 印は state に残す（アプリを閉じても消えない）', () => {
    expect(cloud).toContain('meta.registryElevatedAt = new Date().toISOString()')
    expect(cloud).toContain('delete meta.registryElevatedAt')
  })

  it('★★ 次に片づけを始めるとき、まず戻す', () => {
    const at = cloud.indexOf('if (state.meta?.registryElevatedAt)')
    expect(at).toBeGreaterThan(0)
    expect(cloud.slice(at, at + 900)).toContain("permission: 'readwrite'")
  })

  it('★ 上げられなかったときは印を残さない', () => {
    const at = cloud.indexOf('削除のための権限に変更できませんでした')
    expect(cloud.slice(Math.max(0, at - 300), at)).toContain('opts.markElevated(false)')
  })
})
