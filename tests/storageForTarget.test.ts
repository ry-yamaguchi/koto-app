import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── 公開先を変えてもデータが残る（2026-08-15）──────────────────────────
// データはオブジェクトストレージにあり、**計算（AppRun / HANAMII）とは別の場所**に
// ある。ところが鍵を発行して環境変数で渡す処理は AppRun の公開の中にしか無く、
// 同じアプリを HANAMII へ公開すると**データだけが付いてこなかった**。
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf-8')

describe('保存場所を公開先へ渡す', () => {
  const svc = read('src/main/cloud/storageForTarget.ts')

  it('同意済みの保存場所が無ければ、何もしない（勝手に課金しない）', () => {
    expect(svc).toContain('consentedBuckets')
    expect(svc).toMatch(/reason: 'none'/)
  })

  it('秘密が「秘密でない側」に紛れていないか、渡す前に確かめる', () => {
    expect(svc).toContain('containsSecretEnv')
  })

  it('★ シークレットは main の中で完結する（renderer に渡さない）', () => {
    // 渡すのは main → HANAMII。preload に鍵そのものを運ぶ口を作らない
    expect(read('src/main/preload.ts')).not.toContain('KOTO_STORAGE_SECRET_KEY')
    expect(read('src/renderer/global.d.ts')).not.toContain('KOTO_STORAGE_SECRET_KEY')
  })
})

describe('HANAMII への配線', () => {
  it('main / preload / 型 の3点が揃っている（掟6）', () => {
    expect(read('src/main/ipc/hanamii.ts')).toContain("ipcMain.handle('hanamii:cleanUpKeys'")
    expect(read('src/main/preload.ts')).toContain("ipcRenderer.invoke('hanamii:cleanUpKeys'")
    expect(read('src/renderer/global.d.ts')).toContain('cleanUpKeys(opts:')
    expect(read('src/main/ipc/hanamii.ts')).toContain('withStorage')
    expect(read('src/renderer/global.d.ts')).toContain('withStorage')
  })

  it('★ 片づけは「動いたと確かめてから」（先に消すと動いているアプリが落ちる）', () => {
    const panel = read('src/renderer/components/HanamiiPanel.tsx')
    // READY を見てから cleanUpKeys を呼ぶ
    expect(panel).toMatch(/readyState === 'READY'[\s\S]{0,300}cleanUpKeys/)
    // 公開の直後には呼ばない
    expect(panel).not.toMatch(/hanamii\.publish\([\s\S]{0,200}cleanUpKeys/)
  })

  it('何が持っていかれるかを画面に出す（黙って鍵を配らない）', () => {
    const panel = read('src/renderer/components/HanamiiPanel.tsx')
    expect(panel).toContain('データの保存を持っていく')
    expect(panel).toContain('もう片方からも消えます')  // 同じデータを見ることを隠さない
  })
})
