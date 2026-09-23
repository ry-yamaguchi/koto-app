import { describe, it, expect } from 'vitest'
import { runtimeSkipNoteFor } from '../src/main/ipc/cloud'
import { canVerify } from '../src/shared/publishVerify'

// ── 2026-09-17 の穴・B ───────────────────────────────────────────────
// 共用型（cloud:apply）で公開が成功し起動確認も通ったあと、内容確認のための公開URLが
// 取れないと（client.getApp が例外・応答の形が違って null）、内容の確認は実行されない。
// このとき「とばした理由の一言」（runtimeSkipNote）が設定されないと、画面には
// 「✅ 完了」だけが出て、利用者は確認が行われたと誤解したまま、古い内容が
// 配られている可能性を見逃す。判定を runtimeSkipNoteFor に一元化し、振る舞いで固定する（掟10）。

describe('cloud.ts: runtimeSkipNoteFor（確認をとばした理由・B）', () => {
  it('★★★ 公開URLが取れなかったとき、とばした理由の一言が入る（空にならない・今回の穴そのもの）', () => {
    const note = runtimeSkipNoteFor({ runtimeKind: 'static', publicUrl: null })
    expect(note).not.toBeNull()
    expect(note).not.toBe('')
    expect(note).toContain('URLを取得できなかった')
    // 内部用語（実機・検分・変異試験など）を使わない、利用者向けの日本語であること
    expect(note).not.toMatch(/実機|検分|変異試験/)
  })

  it('公開URLが空文字のときも同じ（取れなかった扱い）', () => {
    const note = runtimeSkipNoteFor({ runtimeKind: 'static', publicUrl: '' })
    expect(note).toContain('URLを取得できなかった')
  })

  it('★★ 静的配信でないときの文はこれまでのまま', () => {
    const note = runtimeSkipNoteFor({ runtimeKind: 'node', publicUrl: 'https://example.com' })
    expect(note).toContain('このビルド方式は公開物に版の目印を持たない')
  })

  it('★★ URLが取れて確認が走れるとき（canVerify が true）は、とばさない（null）', () => {
    expect(canVerify('static', 'https://example.com')).toBe(true)
    const note = runtimeSkipNoteFor({ runtimeKind: 'static', publicUrl: 'https://example.com' })
    expect(note).toBeNull()
  })

  it('URLが無く、かつ静的配信でもないときは「URLが取れなかった」を優先する', () => {
    // 理由が2つ重なっても、利用者が次にできること（公開先を自分で開く）は同じなので
    // どちらの文でも実害は無いが、より根本的な理由（URLが無い）を優先して伝える。
    const note = runtimeSkipNoteFor({ runtimeKind: 'node', publicUrl: null })
    expect(note).toContain('URLを取得できなかった')
  })

  it('canVerify(runtimeKind, publicUrl) と矛盾しない（true の入力では必ず null）', () => {
    for (const publicUrl of [null, '', 'not-a-url', 'https://a.example.com', 'http://b.example.com']) {
      for (const runtimeKind of ['static', 'node', 'docker']) {
        const canVerifyResult = canVerify(runtimeKind, publicUrl)
        const note = runtimeSkipNoteFor({ runtimeKind, publicUrl })
        if (canVerifyResult) expect(note).toBeNull()
        else expect(note).not.toBeNull()
      }
    }
  })
})
