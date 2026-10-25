import { describe, it, expect } from 'vitest'
import { isProtectedWritePath, protectedWriteMessage } from '../src/shared/protectedPaths'
import { validateDelegatePath } from '../src/main/claude/toolText'
import { resolveForWrite } from '../src/shared/toolExecCore'
import { writeDelegatedFiles } from '../src/main/claude/tools'
import { DATA_LAYER_LOCAL_DIR } from '../src/shared/objectStorage'

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

  it('手元のデータ置き場（.koto-data）— アプリが動いて貯めた利用者のデータ（2026-09-23）', () => {
    // 公開の除外（KOTO_INTERNAL_DIRS）へ入れた結果、ここも保護対象になる。
    // AI が書き換える正当な理由が無い場所で、書き換えられると**利用者のデータが壊れる**
    // （アプリ自身は Koto を通さず直接書くので、この保護で困ることはない）。
    expect(isProtectedWritePath('.koto-data/dates/dates.json')).toBe(true)
    expect(isProtectedWritePath('public/.koto-data/config/join.json')).toBe(true)
    // 名前が似ているだけのものは巻き込まない（アプリが読み込む部品・利用者のフォルダ）
    expect(isProtectedWritePath('koto-data.cjs')).toBe(false)
    expect(isProtectedWritePath('public/koto-data.js')).toBe(false)
    expect(isProtectedWritePath('koto-data/memo.txt')).toBe(false)
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

// macOS の既定（APFS）は大文字小文字を区別しない。`.GIT/hooks/pre-commit` は `.git/hooks/pre-commit` と同じ実体なのに、
// 区別して比べていたため守りから漏れた（2026-10-23 検分の実測）。
describe('大文字小文字を変えても守りから漏れない', () => {
  const casing = [
    '.GIT/hooks/pre-commit', '.Git/config', 'a/b/.GIT/config',
    '.Sakuraide.json', '.SAKURAIDE.JSON',
    '.SAKURAIDE-BACKUP/x', '.Sakuraide-Backup/2026/_manifest.json',
    '.SAKURAIDE/chat.json', '.Sakura-Cloud/env.json', '.SAKURA-CLOUD/env.json',
    '.KOTO-DATA/dates/dates.json', 'public/.Koto-Data/config/join.json',
    '.ENV', '.Env.local', 'config/.ENV.PRODUCTION',
    './.GIT/config', '.GIT\\hooks\\pre-commit',
  ]
  for (const p of casing) {
    it(`守る: ${p}`, () => expect(isProtectedWritePath(p)).toBe(true))
  }

  it('元の綴りのものは、いままでどおり守る', () => {
    for (const p of ['.git/hooks/pre-commit', '.sakuraide.json', '.sakuraide-backup/x', '.env']) {
      expect(isProtectedWritePath(p), p).toBe(true)
    }
  })

  it('普通の名前は、大文字が混じっていても守らない（巻き込まない）', () => {
    for (const p of [
      'Readme.md', 'README.md', 'src/Env.ts', 'src/ENV.ts', 'Environment.js', 'Dockerfile', 'Makefile',
      'Src/App.tsx', 'GitHub.md', 'docs/Git.md', 'Sakuraide-notes.md', 'MY-SAKURAIDE.JSON', 'public/Index.html',
      'KOTO-DATA.cjs', 'koto-data/Memo.txt',
    ]) {
      expect(isProtectedWritePath(p), p).toBe(false)
    }
  })

  it('拒否の説明には、書かれた綴りのままのパスが入る', () => {
    expect(protectedWriteMessage('.GIT/hooks/pre-commit')).toContain('.GIT/hooks/pre-commit')
    expect(protectedWriteMessage('.KOTO-DATA/x.json')).toContain('アプリの画面')
  })

  it('さくらのAI Engine の write_file / edit_file（resolveForWrite）も、大文字違いを断る', () => {
    for (const p of ['.GIT/hooks/pre-commit', '.Sakuraide.json', '.SAKURAIDE-BACKUP/x', '.ENV']) {
      const r = resolveForWrite('/p/public', p)
      expect('error' in r, p).toBe(true)
    }
    expect(resolveForWrite('/p/public', 'Readme.md')).toEqual({ full: '/p/public/Readme.md' })
    expect(resolveForWrite('/p/public', 'src/Env.ts')).toEqual({ full: '/p/public/src/Env.ts' })
  })

  it('委譲の書き込み本体（writeDelegatedFiles）も、大文字違いを聞かず・書かずに断る', async () => {
    for (const p of ['.GIT/hooks/pre-commit', '.Sakuraide.json', '.SAKURAIDE-BACKUP/x', '.ENV']) {
      const r = await writeDelegatedFiles([{ path: p, content: 'x' }], {
        projectDir: '/nonexistent/proj', writeRoot: '/nonexistent/proj', snapshotId: 's', snapshotLabel: 'l',
        onFileWritten: () => { throw new Error('書いてはいけない') }, writeMode: 'auto', turnId: 't', isStopped: () => false,
      } as any)
      expect(r.written, p).toEqual([])
      expect(r.denied?.path, p).toBe(p)
      expect(r.denied?.message, p).toBe(protectedWriteMessage(p))
    }
  })

  it('委譲の書き込み（validateDelegatePath）も、大文字違いを断る', () => {
    for (const p of ['.GIT/hooks/pre-commit', '.Sakuraide.json', '.SAKURAIDE-BACKUP/x', '.ENV']) {
      expect(validateDelegatePath(p), p).toBe(false)
    }
    expect(validateDelegatePath('Readme.md')).toBe(true)
    expect(validateDelegatePath('src/Env.ts')).toBe(true)
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

  it('★ 手元のデータ（.koto-data）は、利用者のデータに当てはまる説明で断る', () => {
    // 断られる中身は**利用者自身のアプリのデータ**（予定・連絡先）であって、
    // 「Koto の履歴・設定・秘密」ではない。「テスト用のデータを入れて」と頼んだ
    // 利用者に理由が伝わらず、AI も別の場所へ書こうとして空回りする（2026-09-23 検分）。
    const msg = protectedWriteMessage(`${DATA_LAYER_LOCAL_DIR}/entries/1.json`)
    expect(msg).toContain(`${DATA_LAYER_LOCAL_DIR}/entries/1.json`)
    expect(msg).toContain('アプリの画面')
    expect(msg, '履歴・設定・秘密という説明は、このフォルダには当てはまらない').not.toContain('履歴・設定')
    // 書き込みが止まること自体は従来どおり
    expect(isProtectedWritePath(`${DATA_LAYER_LOCAL_DIR}/entries/1.json`)).toBe(true)
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
