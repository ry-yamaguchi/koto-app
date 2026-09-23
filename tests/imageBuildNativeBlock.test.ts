import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// ── 断る理由が、実際に利用者の画面まで届くか（検分の指摘・2026-09-17）──────────
//
// 配線を見ていた唯一の試験は `tests/deps.test.ts` の正規表現で、**理由（第2引数）を
// 見ていなかった**。そのため `nativeDepsMessage(r.nativePackages)` と理由を落としても
// 全部緑のまま、画面は「パソコンごとに組み立てが必要」という**当てはまらない文面**に
// 黙って戻る。ここでは `installDependencies` を偽物に差し替えて `stageAndTar` を実際に
// 走らせ、**投げられたメッセージそのもの**を固定する（掟10・振る舞いで固定する）。
//
// 偽物が返すのは `installDependencies` の戻り値の形（`nativeBlocked`）だけ。
// npm もネットワークも要らない。

/** 偽の `installDependencies` が返す「持っていけないライブラリ」。試験ごとに差し替える。 */
const blocked: { name: string; reason: string }[] = []

vi.mock('../src/main/cloud/npmInstall', () => ({
  installDependencies: async () => ({ ok: true, nativeBlocked: [...blocked], log: '' }),
}))

import { stageAndTar } from '../src/main/cloud/imageBuild'

let tmp = ''
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-imgnative-'))
  blocked.length = 0
})
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

/** 依存のあるプロジェクト（依存が無いと installDependencies は呼ばれない）。 */
function projectWithDeps(): string {
  const src = path.join(tmp, 'proj')
  fs.mkdirSync(src, { recursive: true })
  fs.writeFileSync(path.join(src, 'server.js'), 'console.log(1)')
  fs.writeFileSync(path.join(src, 'package.json'),
    JSON.stringify({ name: 'x', dependencies: { bcrypt: '5.0.0' } }))
  return src
}

describe('stageAndTar: 断る理由が、そのまま利用者への文面になる', () => {
  it('★★ お使いのパソコン用しか無いときは、その理由が出る（「組み立てが必要」ではない）', async () => {
    blocked.push({ name: 'bcrypt', reason: 'macho-only' })

    await expect(stageAndTar(projectWithDeps())).rejects.toThrow(
      /お使いのパソコン用の部品しか入っていません/)
    await expect(stageAndTar(projectWithDeps())).rejects.not.toThrow(/組み立てが必要/)
  })

  it('★★ 公開先とは別の種類の Linux 用のときは、その理由が出る', async () => {
    blocked.push({ name: '@img/sharp-linux-x64', reason: 'other-linux' })

    await expect(stageAndTar(projectWithDeps())).rejects.toThrow(
      /公開先とは別の種類の Linux 用の部品です/)
  })

  it('★★ 組み立てられていないときは、これまでどおりの文面が出る', async () => {
    blocked.push({ name: 'better-sqlite3', reason: 'needs-build' })

    await expect(stageAndTar(projectWithDeps())).rejects.toThrow(
      /パソコンごとに組み立てが必要な部品を含んでいます/)
  })

  it('★★ 理由が混ざっても、ライブラリごとに正しい理由が付く', async () => {
    blocked.push({ name: 'better-sqlite3', reason: 'needs-build' })
    blocked.push({ name: 'only-mac', reason: 'macho-only' })

    let message = ''
    try { await stageAndTar(projectWithDeps()) } catch (e) { message = (e as Error).message }

    const build = message.split('\n').find(l => l.includes('組み立てが必要')) ?? ''
    expect(build).toContain('better-sqlite3')
    expect(build, 'お使いのパソコン用しか無いライブラリに「組み立てが必要」と言っている')
      .not.toContain('only-mac')
    expect(message).toContain('お使いのパソコン用の部品しか入っていません')
  })

  it('★ 持っていけないものが無ければ、層はできる（止めすぎていない）', async () => {
    const layer = await stageAndTar(projectWithDeps())
    try {
      expect(fs.existsSync(layer)).toBe(true)
    } finally {
      fs.rmSync(path.dirname(layer), { recursive: true, force: true })
    }
  })
})
