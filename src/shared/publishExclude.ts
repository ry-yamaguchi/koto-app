// publishExclude.ts — 公開・配布のときにプロジェクトから必ず除外するものの唯一の定義。
//
// ── なぜ一元化したか（2026-08-05） ──────────────────────────────────────────
// 同じ除外リストが5箇所（Vercel / HANAMII / AppRun / GitHub保存 / レンタルサーバ）に
// 複製されており、**レンタルサーバへの公開だけ Koto の内部フォルダの除外が抜けていた**。
// その結果、`public/` を持たない構成で公開すると `.sakuraide`（チャット履歴の全文）と
// `.sakuraide-backup`（過去のソースの全文）が**公開Webルートへアップロードされていた**。
// 気づいたのは偶然で、テストは1件も無かった。
//
// **新しい公開先を足すときは、必ずこのモジュールを使うこと。** 手で並べ直さない。
// 各形式（rsync / zip / 名前の集合）への変換もここに置いてあるので、呼び出し側は選ぶだけでよい。
//
// このモジュールは fs/electron/DOM に依存しない純粋な定義のみ（renderer からも main からも使える）。

/**
 * Koto が自分のためにプロジェクト内へ作るフォルダ。**公開物・配布物へ絶対に含めない。**
 * - `.sakuraide`        … チャット履歴（会話の全文。貼り付けたものが何であれ残る）
 * - `.sakuraide-backup` … 🕘 履歴のスナップショット（過去のソースの全文）
 * - `.sakura-cloud`     … クラウド連携の状態と環境変数（秘密が入り得る）
 *
 * 名前は互換性のため変更しない（掟8）。
 */
export const KOTO_INTERNAL_DIRS = ['.sakuraide', '.sakuraide-backup', '.sakura-cloud'] as const

/** Koto のメタ情報ファイル（公開設定などを持つ。公開物ではない）。 */
export const KOTO_INTERNAL_FILES = ['.sakuraide.json'] as const

/** 公開に含める意味が無い重い／環境依存のフォルダ。 */
export const HEAVY_DIRS = ['.git', 'node_modules'] as const

/**
 * 素材の置き場（2026-08-19 Ryosuke と決定）。
 *
 * 画像などを「アプリでは使わないが手元に置いておきたい」ときの場所。
 * **公開先（Webに出る場所）へは出さない**が、**GitHub保存（バックアップ）には含める**
 * ——Koto が作るリポジトリは private 固定なので、外へ出るわけではない。
 * 含めないと「パソコンを替えたら素材が消える」ことになる。
 *
 * **名前で判定する。** だから名前自体が説明になっているものを選んだ
 * （利用者が自分で作ったフォルダを勝手に除外しないため。今日の
 * 「名前が似ているだけで引き取らない」と同じ考え）。
 */
export const MATERIALS_DIR = '素材（公開しません）'

/**
 * **公開先にだけ出さない**もの（バックアップには含める）。
 *
 * ここに足したものは `publishExcludedDirNames` / `rsyncExcludeArgs` /
 * `zipExcludePatterns` の全部に効く。**公開経路が1つでも直接
 * `excludedDirNames()` を使っていると漏れる**ので、テストで縛ってある
 * （2026-08-05・08-09・08-14 と3回、同じ形で穴が空いた）。
 */
export const PUBLISH_ONLY_DIRS = [MATERIALS_DIR] as const

/** OS が勝手に作る雑音ファイル。 */
export const NOISE_FILES = ['.DS_Store'] as const

/**
 * **秘密が入るファイル。公開物・配布物へ絶対に含めない。**
 *
 * ── なぜ後から足したか（2026-08-09 の総点検で発覚）──────────────────────
 * `.env` を除外していたのは Vercel と GitHub保存だけで、**それぞれが独自に判定を
 * 実装していた**。一元定義であるこのモジュールには入っていなかったため、
 * **レンタルサーバ・HANAMII・AppRun の3経路では `.env` が公開物に入っていた**。
 * レンタルサーバは `~/www/` 直下へ置くので、`https://<アカウント>.sakura.ne.jp/.env` が
 * そのまま読める状態だった。
 *
 * これは 2026-08-05 の `.sakuraide` 流出（同じリストが5箇所にあり1つだけ抜けていた）と
 * **まったく同じ構造**である。そのとき作ったのがこのモジュールなのに、`.env` については
 * 同じ穴が残っていた。しかも protectedPaths.ts は `.env` を「AIに書かせない秘密」と判定し、
 * securityCheck.ts は「公開NGの可能性が高い」と判定していた。**コードベース自身が危険を
 * 知っていて、実際の除外だけが無かった。**
 *
 * ここに足すときの基準: **入っていたら秘密が漏れるもの**だけにする。広げすぎると
 * 利用者のアプリが動かなくなる（止めすぎも害である・掟10）。
 */
export const SECRET_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env(\..*)?$/i,                    // .env / .env.local / .env.production …
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,      // SSH秘密鍵（.pub は公開鍵なので対象外）
  /\.(pem|p12|pfx)$/i,                  // 証明書・秘密鍵
  /^\.(netrc|pgpass)$/i,                // 認証情報を平文で持つ設定
]

/**
 * そのファイル名が「秘密が入るので公開してはいけない」ものか。
 * 引数はファイル名（パスではない）。判定は SECRET_FILE_PATTERNS の唯一の定義に従う。
 */
export function isSecretFile(name: string): boolean {
  return SECRET_FILE_PATTERNS.some(re => re.test(name))
}

/** ディレクトリを歩くときに丸ごと飛ばす名前（Set で名前一致に使う）。 */
/**
 * **公開先へ出さないフォルダ名**（GitHub保存では使わない）。
 * 公開の経路（レンタルサーバ・AppRun・HANAMII・Vercel）は必ずこちらを使う。
 */
export function publishExcludedDirNames(extra: readonly string[] = []): Set<string> {
  return new Set<string>([...excludedDirNames(extra), ...PUBLISH_ONLY_DIRS])
}

export function excludedDirNames(extra: readonly string[] = []): Set<string> {
  return new Set<string>([...HEAVY_DIRS, ...KOTO_INTERNAL_DIRS, ...extra])
}

/**
 * ビルドのための設定ファイル。**そのまま配信される公開先には入れない。**
 *
 * ── なぜ（2026-08-20 実測）────────────────────────────────────────────
 * 標準の公開は `python -m http.server` で `/app` を**まるごと配信**する。
 * 公開中のサイトで実際に測ったところ、次がすべて **HTTP 200** で読めていた:
 *   `/Dockerfile` `/nginx.conf` `/README.md` `/.dockerignore`
 * このうち Dockerfile と nginx.conf は **AI がビルドのために書いたもの**で、
 * サイトの一部ではない。配信する意味が無く、構成が読めるのも避けたい。
 *
 * ⚠️ **適用してよいのは「静的に配信される公開先」だけ**（AppRun標準 / Vercel / レンタルサーバ）。
 *   ・Docker（エキスパート）経路の**ビルドコンテキストからは外さない**——そこでは入力そのもの。
 *     その経路は `copyTree` を通らないので、ここを使う限り触れない。
 *   ・**HANAMII は対象外**。zip からコンテナをビルドし、マニフェストの有無で挙動が変わる。
 *     外して壊れないことを確かめられていないので、`zipExcludePatterns` には足していない。
 *   ・**GitHub保存も対象外**。Dockerfile はリポジトリに入っているべきもの。
 *
 * `README.md` は外さない（**公開したい人がいる**ため。サイトの一部になりうる）。
 */
export const BUILD_CONFIG_FILES = ['Dockerfile', '.dockerignore', 'nginx.conf'] as const

/**
 * **そのまま配信される公開先**で除外するファイル名。
 * 通常の除外に、上のビルド設定を足したもの。
 */
export function servedExcludedFileNames(extra: readonly string[] = []): Set<string> {
  return new Set<string>([...excludedFileNames(extra), ...BUILD_CONFIG_FILES])
}

/** 除外すべきファイル名（Set で名前一致に使う）。 */
export function excludedFileNames(extra: readonly string[] = []): Set<string> {
  return new Set<string>([...NOISE_FILES, ...KOTO_INTERNAL_FILES, ...extra])
}

/**
 * その名前のものが **公開物に入るか**。
 *
 * ── なぜ一元定義に置くか（2026-08-20 Ryosuke 要望）──────────────────────
 * ファイル一覧を「公開されるもの／公開されないもの」に分けて見せるための判定。
 * **画面の表示と、実際に公開されるものが食い違ってはいけない。**
 * だから4経路（AppRun / Vercel / HANAMII / レンタルサーバ）が使っているのと
 * まったく同じ定義から導く。**画面側で名前を並べ直さないこと**
 * （手で組み直して穴が空いた事故が過去に3回ある。CLAUDE.md 掟10）。
 */
export function isPublished(name: string, isDir: boolean, extra: readonly string[] = []): boolean {
  if (isDir) return !publishExcludedDirNames(extra).has(name)
  return !excludedFileNames(extra).has(name) && !isSecretFile(name)
}

/**
 * 秘密ファイルを rsync / zip の「名前パターン」で表したもの。
 * どちらもワイルドカードは `*` なので、SECRET_FILE_PATTERNS と同じ範囲を
 * この2つの形式で書き下す（正規表現をそのまま渡せないため）。
 * **SECRET_FILE_PATTERNS を増やしたらここも必ず足すこと**（tests/publishExclude.test.ts で対応を固定している）。
 */
const SECRET_GLOBS = [
  '.env', '.env.*',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
  '*.pem', '*.p12', '*.pfx',
  '.netrc', '.pgpass',
] as const

/** rsync の `--exclude='x'` を並べた文字列（先頭に空白1つ付く）。extra は呼び出し側固有の追加分。 */
export function rsyncExcludeArgs(extra: readonly string[] = []): string {
  // レンタルサーバは `~/www/` へそのまま置く＝**静的に配信される**ので、ビルド設定も外す。
  const names = [...HEAVY_DIRS, ...KOTO_INTERNAL_DIRS, ...PUBLISH_ONLY_DIRS, ...KOTO_INTERNAL_FILES, ...NOISE_FILES, ...BUILD_CONFIG_FILES, ...SECRET_GLOBS, ...extra]
  return names.map(n => ` --exclude='${n}'`).join('')
}

/** zip の `-x` に渡すパターン配列（ディレクトリは配下ごと除外するため `/*` を付ける）。 */
export function zipExcludePatterns(extra: readonly string[] = []): string[] {
  return [
    ...HEAVY_DIRS.map(d => `${d}/*`),
    ...KOTO_INTERNAL_DIRS.map(d => `${d}/*`),
    ...PUBLISH_ONLY_DIRS.map(d => `${d}/*`),
    ...NOISE_FILES,
    ...KOTO_INTERNAL_FILES,
    // zip の -x はパスに対して照合するので、配下のどの階層でも効くよう */ を前置する
    ...SECRET_GLOBS.flatMap(g => [g, `*/${g}`]),
    ...extra,
  ]
}
