import { describe, it, expect } from 'vitest'
import { isProtectedWritePath, protectedWriteMessage } from '../src/shared/protectedPaths'
import { validateDelegatePath } from '../src/main/claude/toolText'

// AI が書き換えてはいけない場所の判定（2026-08-05 追加）。
//
// それまでは「プロジェクト内ならどこでも書けた」ため、次がすべて素通りしていた:
//   .sakuraide-backup/… … 🕘 履歴そのもの。**AIの失敗を取り消す仕組みをAI自身が壊せる**
//   .sakura-cloud/env.json … 環境変数（秘密）
//   .git/hooks/pre-commit  … コミット時に実行される＝**危険コマンド判定を迂回できる**
//
// 書き込みだけを止める（読み取りは調査のため正当なので制限しない）。

describe('Koto と git の管理領域は書かせない', () => {
  it('🕘 履歴（.sakuraide-backup）— これを守れないと「元に戻す」が信用できなくなる', () => {
    expect(isProtectedWritePath('.sakuraide-backup/2026-08-05T12-00-00-000Z/_manifest.json')).toBe(true)
    expect(isProtectedWritePath('.sakuraide-backup')).toBe(true)
  })

  it('チャット履歴・クラウド設定・プロジェクト設定', () => {
    expect(isProtectedWritePath('.sakuraide/chat.json')).toBe(true)
    expect(isProtectedWritePath('.sakura-cloud/env.json')).toBe(true)
    expect(isProtectedWritePath('.sakuraide.json')).toBe(true)
  })

  it('.git 配下 — hooks へ書けると危険コマンド判定を迂回して任意のコードが動く', () => {
    expect(isProtectedWritePath('.git/hooks/pre-commit')).toBe(true)
    expect(isProtectedWritePath('.git/config')).toBe(true)
    expect(isProtectedWritePath('.git')).toBe(true)
  })

  it('秘密情報のファイル（.env 系）', () => {
    expect(isProtectedWritePath('.env')).toBe(true)
    expect(isProtectedWritePath('.env.local')).toBe(true)
    expect(isProtectedWritePath('config/.env.production')).toBe(true)
  })

  it('深い階層に隠れていても見つける', () => {
    expect(isProtectedWritePath('src/.sakuraide-backup/x.txt')).toBe(true)
    expect(isProtectedWritePath('a/b/.git/config')).toBe(true)
  })

  it('区切り文字や ./ で書き方を変えてもすり抜けない', () => {
    expect(isProtectedWritePath('./.sakuraide/chat.json')).toBe(true)
    expect(isProtectedWritePath('.sakuraide\\chat.json')).toBe(true)   // Windows風の区切り
    expect(isProtectedWritePath('  .git/config  ')).toBe(true)         // 前後の空白
  })
})

describe('ユーザーの作業ファイルは今までどおり書ける', () => {
  const ok = [
    'index.html', 'style.css', 'src/app.js', 'public/index.html',
    'images/logo.png', 'README.md', '.gitignore', '.htaccess',
    'deep/nested/dir/file.ts', 'package.json', 'Dockerfile',
    'my-sakuraide-notes.md',      // 名前が似ているだけのファイル
    'docs/sakuraide.md',
    'environment.js',             // .env で始まらない
  ]
  for (const p of ok) {
    it(p, () => expect(isProtectedWritePath(p)).toBe(false))
  }
})

describe('入力の端', () => {
  it('空・空白・null相当でも落ちず、保護対象にもしない（別の検証で弾かれる）', () => {
    expect(isProtectedWritePath('')).toBe(false)
    expect(isProtectedWritePath('   ')).toBe(false)
    expect(isProtectedWritePath(undefined as any)).toBe(false)
    expect(isProtectedWritePath(null as any)).toBe(false)
  })

  it('拒否の説明にはパスと理由が入る（AIが無駄に再試行しないように）', () => {
    const msg = protectedWriteMessage('.sakuraide/chat.json')
    expect(msg).toContain('.sakuraide/chat.json')
    expect(msg).toContain('書き込めません')
  })
})

// 委譲（delegate_implementation）の書き込みも同じ規則に従うことを確認する。
// AI Engine が返した内容をそのままファイルへ書く経路なので、ここが緩いと意味が無い。
describe('委譲の書き込みにも同じ保護がかかる', () => {
  it('管理領域は拒否する', () => {
    expect(validateDelegatePath('.sakuraide-backup/x/_manifest.json')).toBe(false)
    expect(validateDelegatePath('.sakura-cloud/env.json')).toBe(false)
    expect(validateDelegatePath('.git/hooks/pre-commit')).toBe(false)
    expect(validateDelegatePath('.sakuraide.json')).toBe(false)
    expect(validateDelegatePath('.env')).toBe(false)
  })

  it('従来どおり脱出パスも拒否する', () => {
    expect(validateDelegatePath('/etc/passwd')).toBe(false)
    expect(validateDelegatePath('../outside.ts')).toBe(false)
    expect(validateDelegatePath('')).toBe(false)
  })

  it('普通の作業ファイルは書ける', () => {
    expect(validateDelegatePath('src/App.tsx')).toBe(true)
    expect(validateDelegatePath('index.html')).toBe(true)
  })
})
