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

  it('★ 片づけは「動いたと確かめてから」＝main がやる。画面は READY を待たず、鍵を片づけない', () => {
    // 2026-09-29: 以前は HanamiiPanel の setInterval（startPolling）が READY を見て cleanUpKeys を呼んでいたが、
    // ダイアログを閉じると止まって古い鍵が残った。いまは main の hanamii:publish が新しい版の READY を
    // 確かめるまで返らず、確かめてから片づける（tests/hanamiiAftercare.test.ts が main の振る舞いで固定）。
    // 画面がやると二重に片づける。画面がやっていないことは、画面を動かして
    // tests/ops-hanamiiVercel-hanamii.test.ts が固定している（setInterval・cleanUpKeys を呼ばない）。
    const panel = read('src/renderer/components/HanamiiPanel.tsx')
    expect(panel).not.toContain('cleanUpKeys')
    expect(panel).not.toContain('startPolling')
    expect(panel).not.toContain('pendingKeyCleanup')
    // 口そのもの（main／preload／型）は互換のために残してある（上の it が固定）
  })

  it('何が持っていかれるかを画面に出す（黙って鍵を配らない）', () => {
    const panel = read('src/renderer/components/HanamiiPanel.tsx')
    expect(panel).toContain('データの保存を持っていく')
    // W-34（2026-09-27 決定・案1）: 「AppRun と同じデータを見る」を
    // 「このプロジェクトのほかの公開先と同じデータを使います」に言い換えた
    expect(panel).toContain('このプロジェクトのほかの公開先（AppRun など）')
    expect(panel).toContain('もう一方からも消えます')  // 同じデータを見ることを隠さない
  })
})
