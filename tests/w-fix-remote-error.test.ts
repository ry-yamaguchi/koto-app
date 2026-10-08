import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { cleanRemoteError } from '../src/renderer/remoteError'

// ── W-59（2026-09-27決定・直し残り）: 接続テストの失敗に付く英語の頭を取る関数は「1つ」──────────
//
// ipcRenderer.invoke は、main が日本語で投げたエラーを「Error invoking remote method '<channel>':
// Error: <本文>」にくるんで返す。この頭を取る関数が、認証情報（cleanRemoteError）と初回案内
// （stripInvokeErrorPrefix）に**2つ**書かれていた（掟10: 一元化）。1つにして、5つの接続テストと
// 初回案内の**すべて**がそれを通ることを固定する。1つでも通らないと、その画面だけ英語の頭が出る。

const root = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf-8')

describe('W-59: cleanRemoteError（remoteError.ts）の振る舞い', () => {
  it('★ 頭「Error invoking remote method \'…\': Error: 」を取り、日本語の本文だけを返す', () => {
    const e = new Error("Error invoking remote method 'sakura:models': Error: APIキーが正しくないようです。コピーし直して貼り付けてください")
    expect(cleanRemoteError(e)).toBe('APIキーが正しくないようです。コピーし直して貼り付けてください')
  })

  it('文字列で渡されても同じに取れる（初回案内側の呼び方）', () => {
    const raw = "Error invoking remote method 'sakura:models': Error: インターネット接続を確認してください"
    expect(cleanRemoteError(raw)).toBe('インターネット接続を確認してください')
  })

  it('内側の「Error: 」が無い形の頭も取る', () => {
    expect(cleanRemoteError(new Error("Error invoking remote method 'github:test': 接続に失敗しました"))).toBe('接続に失敗しました')
  })

  it('頭が無い・形が違う文はそのまま返す（推測で削り過ぎない）', () => {
    expect(cleanRemoteError(new Error('インターネット接続を確認してください'))).toBe('インターネット接続を確認してください')
    // 途中に同じ語が出ても、先頭でなければ触らない
    expect(cleanRemoteError(new Error("本文の途中に Error invoking remote method 'x': Error: が出ても残す")))
      .toBe("本文の途中に Error invoking remote method 'x': Error: が出ても残す")
  })

  it('Error でない値でも壊れない', () => {
    expect(cleanRemoteError('プレーンな文字列')).toBe('プレーンな文字列')
    expect(cleanRemoteError(undefined)).toBe('undefined')
    expect(cleanRemoteError(null)).toBe('null')
  })
})

describe('W-59: 取る関数は1つだけで、接続テストの失敗表示はすべてそれを通る', () => {
  const cred = read('src/renderer/components/CredentialsModal.tsx')
  const onboard = read('src/renderer/components/OnboardingModal.tsx')

  it('★ 認証情報・初回案内のどちらも、自前で英語の頭を取る処理を持たず、remoteError.ts から import する', () => {
    for (const src of [cred, onboard]) {
      expect(src).toContain("import { cleanRemoteError } from '../remoteError'")
      expect(src).not.toMatch(/function\s+cleanRemoteError/)
      expect(src).not.toMatch(/function\s+stripInvokeErrorPrefix/)
      // 頭の文字列そのものを自分で正規表現に書いていない（書くと2つ目ができる）
      expect(src).not.toMatch(/Error invoking remote method '\[/)
    }
  })

  // 各テストボタン（関数の本体）を切り出す。次の「\nfunction」「\nexport」「\n// ─」までを1つとみなす。
  const bodyOf = (name: string): string => {
    const start = cred.indexOf(`function ${name}(`)
    expect(start, `${name} が見つからない`).toBeGreaterThanOrEqual(0)
    const rest = cred.slice(start + 10)
    const m = rest.search(/\n(?:export\s+)?(?:async\s+)?function\s|\n\/\/ ─/)
    return m < 0 ? cred.slice(start) : cred.slice(start, start + 10 + m)
  }

  for (const name of ['KeyTestButton', 'GithubTestButton', 'AnthropicTestButton', 'HanamiiTestButton', 'VercelTestButton']) {
    it(`★ ${name} の失敗（catch）は cleanRemoteError を通して表示する`, () => {
      const body = bodyOf(name)
      expect(body).toContain('catch (e')
      expect(body).toContain('setDetail(cleanRemoteError(e))')
      // 受け取った文をそのまま出す形に戻っていない
      expect(body).not.toMatch(/setDetail\(\s*e\??\.message/)
      expect(body).not.toMatch(/setDetail\(\s*String\(e\)/)
    })
  }

  it('★ 接続テストの失敗表示は5つ全部が cleanRemoteError を通る（数が減っていない）', () => {
    const n = (cred.match(/setDetail\(cleanRemoteError\(e\)\)/g) ?? []).length
    expect(n).toBe(5)
  })

  it('★ 初回案内の接続テストの失敗も cleanRemoteError を通り、「（キーをご確認ください）」を重ねない', () => {
    expect(onboard).toContain('const msg = cleanRemoteError(e)')
    expect(onboard).toContain('❌ ${msg}')
    expect(onboard).not.toContain('キーをご確認ください）:')
  })
})
