import { describe, it, expect } from 'vitest'
import {
  KOTO_INTERNAL_DIRS, KOTO_INTERNAL_FILES, SECRET_FILE_PATTERNS,
  excludedDirNames, excludedFileNames, isSecretFile, rsyncExcludeArgs, zipExcludePatterns,
} from '../src/shared/publishExclude'
import { SKIP_DIRS, isEnvFileName } from '../src/main/github/enumerate'

// 2026-08-05: レンタルサーバへの公開だけ Koto の内部フォルダの除外が抜けており、
// `.sakuraide`（チャット履歴の全文）と `.sakuraide-backup`（過去のソース）が
// 公開Webルートへアップロードされていた。テストは1件も無かった。
//
// ここで守る不変条件は1つ:「どの公開経路でも Koto の内部フォルダは必ず除外される」。
// 新しい公開先を足すときは、その形式の変換関数をこのテストへ追加すること。

describe('Koto の内部フォルダは、どの形式でも必ず除外される', () => {
  it('ディレクトリを歩く経路（Vercel / AppRun / GitHub保存）', () => {
    for (const d of KOTO_INTERNAL_DIRS) {
      expect(excludedDirNames().has(d)).toBe(true)
    }
  })

  it('rsync の経路（さくらのレンタルサーバ）', () => {
    const args = rsyncExcludeArgs()
    for (const d of KOTO_INTERNAL_DIRS) {
      expect(args).toContain(`--exclude='${d}'`)
    }
    for (const f of KOTO_INTERNAL_FILES) {
      expect(args).toContain(`--exclude='${f}'`)
    }
  })

  it('zip の経路（HANAMII）', () => {
    const patterns = zipExcludePatterns()
    for (const d of KOTO_INTERNAL_DIRS) {
      // ディレクトリは配下ごと除外する必要がある（`.sakuraide` だけでは中身が入ってしまう）
      expect(patterns).toContain(`${d}/*`)
    }
    for (const f of KOTO_INTERNAL_FILES) {
      expect(patterns).toContain(f)
    }
  })

  it('実際に使われている GitHub 保存の除外リストにも入っている（結線の確認）', () => {
    for (const d of KOTO_INTERNAL_DIRS) {
      expect(SKIP_DIRS.has(d)).toBe(true)
    }
  })
})

describe('呼び出し側の追加分', () => {
  it('rsync: 追加した名前も除外に並ぶ（deploy.sh など）', () => {
    expect(rsyncExcludeArgs(['deploy.sh'])).toContain("--exclude='deploy.sh'")
  })

  it('ディレクトリ: 追加分を足しても内部フォルダは残る（上書きしてしまわない）', () => {
    const s = excludedDirNames(['dist', 'build'])
    expect(s.has('dist')).toBe(true)
    expect(s.has('.sakuraide-backup')).toBe(true)
    expect(s.has('node_modules')).toBe(true)
  })

  it('zip: 追加分を足しても内部フォルダは残る', () => {
    const p = zipExcludePatterns(['*.log'])
    expect(p).toContain('*.log')
    expect(p).toContain('.sakuraide/*')
  })
})

describe('重い/雑音の除外（従来の挙動を維持）', () => {
  it('.git と node_modules は常に除外', () => {
    expect(excludedDirNames().has('.git')).toBe(true)
    expect(excludedDirNames().has('node_modules')).toBe(true)
    expect(zipExcludePatterns()).toContain('.git/*')
    expect(rsyncExcludeArgs()).toContain("--exclude='node_modules'")
  })

  it('.DS_Store は常に除外', () => {
    expect(excludedFileNames().has('.DS_Store')).toBe(true)
    expect(zipExcludePatterns()).toContain('.DS_Store')
  })

  it('GitHub 保存はビルド成果物も飛ばす（従来どおり）', () => {
    for (const d of ['dist', 'build', '.next', 'out', '.vscode', 'vendor', '__pycache__']) {
      expect(SKIP_DIRS.has(d)).toBe(true)
    }
  })
})

// ── 秘密ファイル（2026-08-09 の総点検で発覚）─────────────────────────────
// `.env` を除外していたのは Vercel と GitHub保存だけで、しかも**それぞれが独自に**
// 判定を実装していた。一元定義であるこのモジュールには入っておらず、
// **レンタルサーバ・HANAMII・AppRun の3経路では `.env` が公開物に入っていた**。
// レンタルサーバは ~/www/ 直下へ置くため、HTTP でそのまま読める状態だった。
//
// 2026-08-05 の `.sakuraide` 流出とまったく同じ構造（同じリストが複数箇所にあり
// 一部だけ抜けている）。ここで守る不変条件は「どの公開経路でも秘密ファイルは必ず除外される」。

describe('秘密ファイルは、どの形式でも必ず除外される', () => {
  const SECRETS = ['.env', '.env.local', '.env.production', 'id_rsa', 'id_ed25519', 'server.pem', 'cert.p12', '.netrc']

  it.each(SECRETS)('名前で判定できる: %s', (name) => {
    expect(isSecretFile(name)).toBe(true)
  })

  it('rsync（さくらのレンタルサーバ）で除外される', () => {
    const args = rsyncExcludeArgs()
    expect(args).toContain("--exclude='.env'")
    expect(args).toContain("--exclude='.env.*'")
    expect(args).toContain("--exclude='id_rsa'")
    expect(args).toContain("--exclude='*.pem'")
  })

  it('zip（HANAMII）で除外される。配下の階層も含む', () => {
    const pats = zipExcludePatterns()
    expect(pats).toContain('.env')
    expect(pats).toContain('.env.*')
    expect(pats).toContain('*/.env') // ルート直下だけでなく、どの階層でも
    expect(pats).toContain('*/.env.*')
  })

  it('GitHub保存の判定も同じ定義を使う', () => {
    for (const s of SECRETS) expect(isEnvFileName(s)).toBe(true)
  })

  // 止めすぎも害（掟10）。普通の作業ファイルを巻き込まないこと
  it.each(['index.html', 'style.css', 'script.js', 'environment.ts', 'env.json', 'id_rsa.pub', 'README.md', 'package.json'])(
    '普通のファイルは除外しない: %s',
    (name) => { expect(isSecretFile(name)).toBe(false) },
  )

  // 公開鍵は公開してよい。秘密鍵と取り違えて弾くと、意図した配布ができなくなる
  it('SSH公開鍵（.pub）は除外しない', () => {
    expect(isSecretFile('id_rsa.pub')).toBe(false)
    expect(isSecretFile('id_ed25519.pub')).toBe(false)
  })

  // 正規表現とグロブは別々に書いてあるので、片方だけ増やすと穴が空く
  it('正規表現の定義と、rsync/zip のパターンの数が食い違わない', () => {
    const args = rsyncExcludeArgs()
    const pats = zipExcludePatterns()
    // SECRET_FILE_PATTERNS を増やしたら SECRET_GLOBS も増やす、という対応を数で縛る
    expect(SECRET_FILE_PATTERNS.length).toBe(4)
    for (const g of ['.env', 'id_rsa', '*.pem', '.netrc']) {
      expect(args).toContain(`--exclude='${g}'`)
      expect(pats).toContain(g)
    }
  })
})
