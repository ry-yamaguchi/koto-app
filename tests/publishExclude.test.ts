import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { publishExcludedDirNames, MATERIALS_DIR,
  KOTO_INTERNAL_DIRS, KOTO_INTERNAL_FILES, SECRET_FILE_PATTERNS,
  excludedDirNames, excludedFileNames, isSecretFile, rsyncExcludeArgs, zipExcludePatterns,
  isPublished, isPublishedTop, BUILD_CONFIG_FILES, servedExcludedFileNames } from '../src/shared/publishExclude'
import { PUBLISH_DIR } from '../src/shared/publishRoot'
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

// ── 素材の置き場（2026-08-19 Ryosuke と決定）────────────────────────────
// 画像などを「アプリでは使わないが手元に置いておきたい」ときの場所。
// **公開先へは出さない／GitHub保存（バックアップ）には含める。**
// Koto が作るリポジトリは private 固定なので、含めても外へは出ない。
// 含めないと「パソコンを替えたら素材が消える」ことになる。
describe('素材（公開しません）の扱い', () => {
  it('名前自体が説明になっている（自分で作ったフォルダと衝突しないように）', () => {
    expect(MATERIALS_DIR).toBe('素材（公開しません）')
  })

  it('★ 公開の全経路から外れる', () => {
    // 名前の集合を使う経路（AppRun の内蔵ビルダー・Vercel）
    expect(publishExcludedDirNames().has(MATERIALS_DIR)).toBe(true)
    // rsync を使う経路（レンタルサーバ）
    expect(rsyncExcludeArgs()).toContain(`--exclude='${MATERIALS_DIR}'`)
    // zip を使う経路（HANAMII）
    expect(zipExcludePatterns()).toContain(`${MATERIALS_DIR}/*`)
  })

  it('★ GitHub保存（バックアップ）には含める', () => {
    // GitHub 経路は excludedDirNames を使う。ここに入っていたら素材が失われる
    expect(excludedDirNames().has(MATERIALS_DIR)).toBe(false)
  })

  it('★ 公開経路が excludedDirNames を直接使っていないこと', () => {
    // 直接使うと素材が公開物へ入る（2026-08-05/08-09/08-14 と3回開いた穴と同じ形）
    const vercel = readFileSync(join(__dirname, '..', 'src/main/vercel/client.ts'), 'utf-8')
    const image = readFileSync(join(__dirname, '..', 'src/main/cloud/imageBuild.ts'), 'utf-8')
    expect(vercel).toContain('publishExcludedDirNames()')
    expect(vercel).not.toMatch(/=\s*excludedDirNames\(\)/)
    expect(image).toContain('publishExcludedDirNames()')
    expect(image).not.toMatch(/\.\.\.excludedDirNames\(\)/)
  })
})

// ── 画面の「公開されるもの／されないもの」の判定（2026-08-20）─────────────────
// ファイル一覧の見分け（Sidebar）はこの関数だけを使う。**画面側で名前を並べ直さない。**
// 手で組み直して穴が空いた事故が過去に3回あるため（掟10）。
describe('isPublished（一覧の見分け）', () => {
  it('アプリのファイルは公開される', () => {
    for (const n of ['index.html', 'style.css', 'script.js', 'README.md', 'Dockerfile', 'nginx.conf']) {
      expect(isPublished(n, false)).toBe(true)
    }
    expect(isPublished('images', true)).toBe(true)
  })

  it('素材（公開しません）は公開されない', () => {
    expect(isPublished(MATERIALS_DIR, true)).toBe(false)
  })

  it('Koto の内部フォルダ・重いフォルダは公開されない', () => {
    for (const d of [...KOTO_INTERNAL_DIRS, '.git', 'node_modules']) {
      expect(isPublished(d, true)).toBe(false)
    }
  })

  it('秘密ファイル・雑音ファイル・内部ファイルは公開されない', () => {
    for (const f of ['.env', '.env.local', 'id_rsa', 'server.pem', '.netrc', '.DS_Store', ...KOTO_INTERNAL_FILES]) {
      expect(isPublished(f, false)).toBe(false)
    }
  })

  it('判定が、実際に公開経路が使っている定義と一致する', () => {
    // ここがずれると「画面では公開されないのに、実際は公開される」が起きる。
    for (const name of publishExcludedDirNames()) expect(isPublished(name, true)).toBe(false)
    for (const name of excludedFileNames()) expect(isPublished(name, false)).toBe(false)
  })

  it('呼び出し側固有の追加分も効く', () => {
    expect(isPublished('dist', true)).toBe(true)
    expect(isPublished('dist', true, ['dist'])).toBe(false)
  })
})

// ── 配信されるものから、ビルド用の設定ファイルを外す（2026-08-20）─────────────
// 公開中のサイトで実測したところ、次がすべて HTTP 200 で読めていた:
//   /Dockerfile /nginx.conf /README.md /.dockerignore
// 標準の公開は `python -m http.server` で /app をまるごと配信するため。
// Dockerfile と nginx.conf は AI がビルドのために書いたもので、サイトの一部ではない。
describe('servedExcludedFileNames（配信されるものの除外）', () => {
  it('ビルド用の設定ファイルを外す', () => {
    // **名前を書き下す。** BUILD_CONFIG_FILES を回すだけでは、中身が減っても気づけない
    //（2026-08-20、ミューテーション試験で同語反復になっていたのを発見）。
    for (const f of ['Dockerfile', 'nginx.conf', '.dockerignore']) {
      expect(servedExcludedFileNames().has(f), `${f} が配信されてしまう`).toBe(true)
    }
  })

  it('通常の除外も引き継ぐ（一元定義を丸ごと使う・掟10）', () => {
    for (const f of excludedFileNames()) expect(servedExcludedFileNames().has(f)).toBe(true)
  })

  it('サイトの中身は外さない', () => {
    for (const f of ['index.html', 'style.css', 'main.js', 'README.md']) {
      expect(servedExcludedFileNames().has(f)).toBe(false)
    }
  })

  it('README.md は外さない（公開したい人がいる）', () => {
    expect(BUILD_CONFIG_FILES).not.toContain('README.md')
  })

  it('呼び出し側固有の追加分も効く', () => {
    expect(servedExcludedFileNames(['secret.txt']).has('secret.txt')).toBe(true)
  })
})

describe('ビルド設定を外してよい経路・いけない経路', () => {
  it('レンタルサーバ（そのまま配信）では外す', () => {
    const args = rsyncExcludeArgs()
    for (const f of ['Dockerfile', 'nginx.conf', '.dockerignore']) {
      expect(args, `${f} が置かれてしまう`).toContain(`--exclude='${f}'`)
    }
  })

  it('HANAMII（zipからコンテナをビルド）では外さない', () => {
    // zip から言語を判定してビルドするため、外して壊れないことを確かめられていない。
    // 確かめるまでは触らない（掟1: 推測で実装しない）。
    const pats = zipExcludePatterns()
    for (const f of BUILD_CONFIG_FILES) expect(pats).not.toContain(f)
  })

  it('GitHub保存では外さない（Dockerfile はリポジトリに入っているべきもの）', () => {
    for (const f of BUILD_CONFIG_FILES) expect(excludedFileNames().has(f)).toBe(false)
  })

  it('一覧の見分け（isPublished）はまだ変えない', () => {
    // HANAMII では配信されうるので、「公開されない」と言い切れない。
    // **「公開される」と多めに言うのは安全側**だが、逆は危ない（秘密を置かれてしまう）。
    for (const f of BUILD_CONFIG_FILES) expect(isPublished(f, false)).toBe(true)
  })
})

// 2026-08-27 発見の不具合: 一覧（Sidebar.tsx）のいちばん上の階層の振り分けが isPublished
// だけを見ており、public/ の有無を見ていなかった。public/ へ移行したプロジェクトでは、
// 直下の普通のファイルが「除外リストに無い＝公開される」と誤って表示されていた
// （実際に公開先へ行くのは public/ の中身だけ）。isPublished 自体の意味は変えず
// （掟10・公開経路の除外判定として全経路が使っている）、いちばん上の階層専用の
// 判定を別に置いて直した。
describe('isPublishedTop: ファイル一覧のいちばん上の階層の振り分け', () => {
  it('移行後（public/ がある）× public ディレクトリ自身 → 公開される', () => {
    expect(isPublishedTop(PUBLISH_DIR, true, true)).toBe(true)
  })

  it('移行後（public/ がある）× 直下の txt → 公開されない（public/ の中身しか公開先へ行かない）', () => {
    expect(isPublishedTop('test2.txt', false, true)).toBe(false)
  })

  it('移行前（public/ が無い）× index.html → 公開される（isPublished と同じ結果）', () => {
    expect(isPublishedTop('index.html', false, false)).toBe(true)
  })

  it('移行前（public/ が無い）× .env → 公開されない（isPublished と同じ結果）', () => {
    expect(isPublishedTop('.env', false, false)).toBe(false)
  })

  it('移行後でも、public/ 以外のディレクトリは公開されない', () => {
    expect(isPublishedTop('assets', true, true)).toBe(false)
  })
})
