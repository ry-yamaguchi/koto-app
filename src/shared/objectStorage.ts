// objectStorage.ts — 公開したアプリに永続データを持たせる（さくらのオブジェクトストレージ）。
//
// ── なぜこのモジュールが「守り」なのか（掟10）──────────────────────────
// **課金はバケット単位**である（公式マニュアル「『バケット』ごとに料金が発生します」）。
// プロジェクトごとにバケットを作ると 3つで月1,485円になり、非エンジニア向けとして
// 成立しない。そこで**既定は1つのバケットを共有し、プレフィックスで分ける**。
//
// その結果、**共有バケットをプロジェクト破棄で消してはいけない**という制約が生まれる。
// 消すと**他のプロジェクトのデータが道連れで消える**。2026-08-06 に、共通の保存場所から
// レジストリ名を読んで**別プロジェクトのレジストリを削除した**のとまったく同じ構造である。
// だから「何を消してよいか」の判断はこの1箇所に集め、テストで固定する。
//
// ── 分離したい人のために（Ryosuke 判断 2026-08-13）────────────────────
// 既定は共有だが、**プロジェクト専用のバケットも選べる**。分離できる代わりに
// そのプロジェクト分の月額が増えるので、選ぶときは費用を必ず示すこと。

/** バケットの持ち方。 */
export type BucketMode = 'shared' | 'dedicated'

/** このプロジェクトがどこへ書くか。 */
export type StoragePlacement = {
  /** 実際のバケット名。 */
  bucket: string
  /** 共有バケットの中での置き場所（専用バケットなら空文字）。 */
  prefix: string
  /** 共有バケットか。**破棄の判断がこれで変わる。** */
  shared: boolean
}

/** 破棄のとき、何を消してよいか。 */
export type StorageTeardown = {
  /** バケットごと消してよいか。**共有バケットでは絶対に true にしない。** */
  deleteBucket: boolean
  /** 消すプレフィックス（バケットごと消す場合は null）。 */
  deletePrefix: string | null
  /** 利用者に見せる説明。 */
  note: string
}

/**
 * さくらのオブジェクトストレージのバケット名として使えるか（純関数）。
 *
 * 仕様（openapi.json の `BucketName`）は `^[a-zA-Z][a-zA-Z0-9\-]{2,}` で、
 * **先頭は英字でなければならない**。一方 Koto 既存の `NAME_PATTERN` は
 * `^[a-z0-9]…` で**数字始まりを許してしまう**ため、そのままでは
 * `1myapp` のような名前を作ってAPIに弾かれる。ここで両方を満たすものだけ通す。
 *
 * 公開URL（`https://s3.isk01.sakurastorage.jp/<bucket>/<key>`）に出るので、
 * 大文字は使わない（環境によって扱いが揺れるため）。
 */
export function isValidBucketName(name: string): boolean {
  if (typeof name !== 'string') return false
  if (name.length < 3 || name.length > 63) return false
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(name)) return false
  if (name.includes('--')) return false // 読み違えのもと。避ける
  return true
}

/**
 * 共有バケットの名前を作る（純関数）。
 *
 * バケット名はさくら全体で一意である必要があるため、利用者ごとに違う名前にする。
 * `seed` にはアカウントを識別できる文字列（キーのIDなど）を渡す。
 * **seed そのものは名前に出さない**（キーIDが公開URLに出るのを避ける）。
 */
export function sharedBucketName(seed: string): string {
  let h = 5381
  for (const ch of String(seed ?? '')) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0
  return `koto-data-${h.toString(36)}`
}

/** プロジェクト名から、共有バケット内の置き場所を作る（純関数）。 */
export function prefixForProject(projectName: string): string {
  const safe = String(projectName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `projects/${safe || 'default'}/`
}

/**
 * このプロジェクトの置き場所を決める（純関数）。
 *
 * 既定は共有。専用にすると分離できるが、そのぶん月額が増える。
 */
export function resolvePlacement(opts: {
  projectName: string
  mode?: BucketMode
  sharedBucket: string
  dedicatedBucket?: string
}): StoragePlacement {
  const mode = opts.mode ?? 'shared'
  if (mode === 'dedicated') {
    const bucket = opts.dedicatedBucket || `koto-${prefixForProject(opts.projectName).split('/')[1]}`
    // **専用バケットでもプレフィックスを使う。** こうしておくと「`projects/` の下は
    // Koto が作ったもの、それ以外は利用者のもの」と一目で分かり、破棄のときに
    // 利用者のデータを巻き込まずに済む（2026-08-13 Ryosuke 指摘）。
    return { bucket, prefix: prefixForProject(opts.projectName), shared: false }
  }
  return { bucket: opts.sharedBucket, prefix: prefixForProject(opts.projectName), shared: true }
}

/**
 * spec に書かれた保存場所の定義（`persistence.objectStorage` の各要素）。
 * shared/ から main/cloud/spec.ts を参照しないよう、必要な形だけをここに置く。
 */
export type BucketSpecLike = {
  bucket: string
  prefix?: string
  shared?: boolean
  /** **費用の同意を取った日時（ISO文字列）。これが無いものは用意しない。** */
  consentedAt?: string
}

/**
 * 実際に用意してよいバケットだけを返す（純関数）。
 *
 * ── なぜ要るか（2026-08-14 発覚）──────────────────────────────────────
 * `defaultSpec` は長らく、**すべてのプロジェクトの env.json に
 * `{ bucket: '<名前>-data' }` を書いていた**。データなど扱わないプロジェクトでも
 * 例外なく。これは apply 側に保存場所の操作が繋がっていない間は無害だったが、
 * 繋いだ瞬間に「公開しただけで月額495円のバケットが作られる」に変わる。
 *
 * **費用は、利用者が同意したときにだけ発生してよい。** そこで「同意を取った」
 * ことを `consentedAt` として記録に残し、それが無いものは要求しない、と決めた。
 * 古い env.json は当然 `consentedAt` を持たないので、自動的に対象外になる。
 */
export function consentedBuckets<T extends BucketSpecLike>(list: readonly T[] | undefined | null): T[] {
  return (list ?? []).filter(b => {
    if (!b || typeof b.bucket !== 'string' || b.bucket.length === 0) return false
    return typeof b.consentedAt === 'string' && b.consentedAt.trim().length > 0
  })
}

/** `persistence` を持つスペック（shared から main の型を参照しないための最小の形）。 */
export type SpecWithPersistence = { persistence?: { objectStorage?: BucketSpecLike[] } }

/**
 * 画面からの保存で、**保存場所の記録を消させない**（純関数）。
 *
 * ── なぜ要るか（2026-08-14 実機で発覚）────────────────────────────────
 * ③公開の画面は env.json を**丸ごと**書き戻す（キーのピン留め・期限・公開名の変更）。
 * その材料は**画面を開いた時点の写し**なので、開いたあとに「保存場所を用意する」を
 * 押しても、その写しには入っていない。次にキーを選んだ瞬間、
 * **用意したばかりの保存場所の記録が消える**。
 *
 * 実機ではこう進んだ:
 *   12:57:54 保存場所を用意（env.json に記録）
 *   12:58:52 キーを選ぶ → 古い写しで上書き → **記録が消える**
 *   12:59:21 公開 → planner は要求しない → 鍵も環境変数も渡らない
 * 画面は「用意しました」と出したまま、アプリはデータを保存できない。
 * **課金だけが残る、いちばん悪い形。**
 *
 * 保存場所を編集する画面は無い（用意するのは `storage:prepare` だけ）ので、
 * **ディスクにある記録を常に正とする**。
 */
export function keepStorageFromDisk<T extends SpecWithPersistence>(incoming: T, disk: SpecWithPersistence | null | undefined): T {
  const kept = consentedBuckets(disk?.persistence?.objectStorage)
  if (kept.length === 0) return incoming
  return {
    ...incoming,
    persistence: { ...(incoming.persistence ?? {}), objectStorage: kept },
  }
}

/**
 * オブジェクトのキーを組み立てる（純関数）。
 *
 * **プレフィックスの外へ出さない。** `../` を許すと、共有バケットで
 * 他プロジェクトのデータを読み書きできてしまう。
 * 返り値が null なら、そのパスは使ってはいけない。
 */
export function objectKeyFor(prefix: string, path: string): string | null {
  const p = String(path ?? '').replace(/^\/+/, '')
  if (!p) return null
  if (p.includes('..')) return null           // 上位へ抜ける
  if (p.includes('\0')) return null           // ヌル文字
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return null // URL を渡された
  const pre = String(prefix ?? '')
  if (pre && !pre.endsWith('/')) return null  // 区切りが無いと隣のプロジェクトに届く
  return pre + p
}

/** Koto が作ったものが置かれる場所。**この外は利用者のもの。** */
export const KOTO_ROOT = 'projects/'

/**
 * バケットの中に、**Koto が作ったのではないもの**が入っていないか（純関数）。
 *
 * ── なぜ要るか（2026-08-13 Ryosuke 指摘）────────────────────────────────
 * 利用者が、意図的にせよ誤ってにせよ、このバケットへ自分のファイルを置いている
 * ことがある（コントロールパネルや他のツールから）。**それを Koto が消しては
 * 絶対にいけない。** バケットを消す前に、`projects/` の外に何か無いかを見る。
 *
 * 既存のバケットを利用者が指定した場合も、中身はすべて「利用者のもの」に
 * なるので、結果としてバケットは消せない。**それでよい**（安全側に倒す）。
 */
export function foreignKeys(allKeys: string[]): string[] {
  return (allKeys ?? []).filter(k => {
    const key = String(k ?? '')
    return key.length > 0 && !key.startsWith(KOTO_ROOT)
  })
}

/**
 * 破棄のとき、何を消してよいかを決める（純関数）。
 *
 * **判断は2段構え。**
 *   1. `projects/` の外に何かあれば → **バケットは消さない**（利用者のデータ）
 *   2. ほかのプロジェクトが使っていれば → バケットは消さない（道連れになる）
 * どちらも無いときだけ、バケットごと消してよい（残すと課金が続くため）。
 *
 * @param allKeys バケットの中に実在するキーの一覧。
 *   **ローカルの記録ではなく、バケットを一覧して得たものを渡すこと。**
 *   利用者がプロジェクトのフォルダを手で消していると、記録は当てにならない。
 */
export function teardownPlanFor(placement: StoragePlacement, allKeys: string[] = []): StorageTeardown {
  const foreign = foreignKeys(allKeys)
  const others = projectPrefixesFromKeys(allKeys).filter(p => p !== placement.prefix)

  if (foreign.length > 0) {
    return {
      deleteBucket: false,
      deletePrefix: placement.prefix,
      note: `このプロジェクトのデータだけを削除します。保存場所には Koto が作ったのではないファイルが${foreign.length}件あるため、`
        + '保存場所そのものは残します（月額の課金は続きます）。不要であれば、さくらのコントロールパネルで中身を確認してから削除してください。',
    }
  }
  if (others.length > 0) {
    return {
      deleteBucket: false,
      deletePrefix: placement.prefix,
      note: `このプロジェクトのデータだけを削除します。保存場所はほかの${others.length}件のプロジェクトが使っているため残します。`,
    }
  }
  if (!placement.shared) {
    return {
      deleteBucket: true,
      deletePrefix: placement.prefix,
      note: 'このプロジェクト専用の保存場所ごと削除します。中のデータはすべて失われ、月額の課金も止まります。',
    }
  }
  return {
    deleteBucket: true,
    deletePrefix: placement.prefix,
    note: 'このプロジェクトのデータを削除します。保存場所を使っているプロジェクトはほかにありません。'
      + '保存場所を残すと月額の課金が続くため、あわせて削除できます。',
  }
}

/**
 * プロジェクトの保存場所に置く「目印」のキー（純関数）。
 *
 * ── なぜ要るか ────────────────────────────────────────────────────────
 * バケットの一覧に現れるのは**オブジェクトが1つ以上あるプレフィックスだけ**である。
 * 「保存場所は用意したが、まだ何も書いていない」プロジェクトは一覧に出てこない。
 * そのまま「ほかに誰も使っていない」と判断すると、**そのプロジェクトの保存場所を
 * 巻き込んで消してしまう**。用意した時点で目印を1つ置き、必ず一覧に出るようにする。
 */
export function keepMarkerKey(prefix: string): string {
  return `${prefix}.koto-keep`
}

/**
 * 一覧で得たキーから、プロジェクトのプレフィックスを取り出す（純関数）。
 *
 * `projects/myapp/data/x.json` → `projects/myapp/`
 * 共有バケットの決まりに合わないキーは無視する（人が手で置いたものを
 * 「プロジェクト」と数えて、消せるはずのバケットを残し続けないため）。
 */
export function projectPrefixesFromKeys(keys: string[]): string[] {
  const out = new Set<string>()
  for (const k of keys ?? []) {
    const m = /^(projects\/[^/]+\/)/.exec(String(k ?? ''))
    if (m) out.add(m[1])
  }
  return Array.from(out).sort()
}

/** 公開URL（Public read にしたオブジェクトを、キー無しで読むためのURL）。 */
export function publicUrlFor(s3Endpoint: string, bucket: string, key: string): string {
  const host = String(s3Endpoint ?? '').replace(/^https?:\/\//, '').replace(/\/+$/, '')
  return `https://${host}/${bucket}/${key}`
}

/**
 * 保存場所を用意するときに見せる費用の説明（純関数）。
 *
 * **画面には素のテキストとして出る。Markdown 記法は使わない**（v0.2.98 の教訓）。
 */
export function storageCostNote(mode: BucketMode, monthlyYen: number): string {
  if (mode === 'dedicated') {
    return `このプロジェクト専用の保存場所を作ります。月額${monthlyYen}円（税込）が追加でかかります。`
      + 'ほかのプロジェクトとデータが混ざらない代わりに、プロジェクトごとに費用がかかります。'
  }
  return `ほかのプロジェクトと共有の保存場所を使います。追加の費用はかかりません（保存場所ぜんぶで月額${monthlyYen}円）。`
    + 'ただし、公開したアプリの鍵が漏れると、同じ保存場所にあるほかのプロジェクトのデータにも届きます。'
}

/**
 * S3 の一覧応答（XML）を読む（純関数）。
 *
 * ── なぜ切り出すのか（掟10）────────────────────────────────────────────
 * **一覧を読み違えると、利用者のデータを消す。** 途中で打ち切られている
 * （IsTruncated=true）のに気づかず「他には何も無い」と判断すると、
 * バケットごと削除してしまう。ここは XML の読み取りだけを行い、テストで固定する。
 */
export function parseListResponse(xml: string): { keys: string[]; truncated: boolean; nextToken: string | null } {
  const text = String(xml ?? '')
  const keys: string[] = []
  const re = /<Key>([\s\S]*?)<\/Key>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) keys.push(decodeXmlEntities(m[1]))

  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(text)
  const t = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(text)
  return { keys, truncated, nextToken: t ? decodeXmlEntities(t[1]) : null }
}

/** XML の実体参照を戻す。**`&amp;` は最後**（先に戻すと二重解釈になる）。 */
export function decodeXmlEntities(s: string): string {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

// ── 公開したアプリへ渡す情報 ──────────────────────────────────────────

/** 環境変数の名前。アプリのコードから参照するので、**変えると既存アプリが壊れる。** */
export const STORAGE_ENV = {
  bucket: 'KOTO_STORAGE_BUCKET',
  endpoint: 'KOTO_STORAGE_ENDPOINT',
  region: 'KOTO_STORAGE_REGION',
  prefix: 'KOTO_STORAGE_PREFIX',
  accessKey: 'KOTO_STORAGE_ACCESS_KEY',
  /** **これだけが秘密。** env.json には絶対に書かず、公開のたびに発行して渡し切る。 */
  secretKey: 'KOTO_STORAGE_SECRET_KEY',
} as const

/**
 * 公開したアプリに渡す、**秘密でない**環境変数（純関数）。
 *
 * アクセスキーIDは利用者名に相当し、これ単体では何もできないので平文で渡す。
 * **シークレットはここに含めない。** 含めると env.json に書かれてしまう
 * （spec.ts が平文の秘密を禁じているのはそのため）。
 */
export function storageEnvVars(opts: {
  bucket: string
  prefix: string
  s3Endpoint: string
  region: string
  accessKey: string
}): { name: string; value: string }[] {
  return [
    { name: STORAGE_ENV.bucket, value: opts.bucket },
    { name: STORAGE_ENV.endpoint, value: `https://${String(opts.s3Endpoint).replace(/^https?:\/\//, '').replace(/\/+$/, '')}` },
    { name: STORAGE_ENV.region, value: opts.region },
    { name: STORAGE_ENV.prefix, value: opts.prefix },
    { name: STORAGE_ENV.accessKey, value: opts.accessKey },
  ]
}

/**
 * 秘密でない環境変数の中に、秘密が混ざっていないか（純関数）。
 *
 * **最後の砦。** ここを通ったものが env.json に書かれる。シークレットが1度でも
 * 紛れ込めば、プロジェクトのファイルとして保存され、GitHub保存や公開の経路に乗る。
 */
export function containsSecretEnv(vars: { name: string; value: string }[]): boolean {
  return (vars ?? []).some(v => String(v?.name ?? '').toUpperCase().includes('SECRET'))
}

// ── データ層（koto-data.js）の検出 ────────────────────────────────────

/** データ層のファイル名。**変えると既存プロジェクトの import が壊れる。** */
export const DATA_LAYER_FILE = 'koto-data.js'

/**
 * ソースがデータ層を使っているか（純関数）。
 *
 * ── なぜ import を見るのか ────────────────────────────────────────────
 * 環境変数（`KOTO_STORAGE_*`）を探すより**強い信号**である。環境変数は
 * データ層の中にしか出てこないので、アプリのコードを見ても分からない。
 * 「koto-data を使っているか」はアプリのコードにそのまま書いてある。
 */
export function usesDataLayer(sourceText: string): boolean {
  const t = String(sourceText ?? '')
  return /\bfrom\s+['"][^'"]*koto-data(\.js)?['"]/.test(t)
    || /\brequire\(\s*['"][^'"]*koto-data(\.js)?['"]\s*\)/.test(t)
    || /\bimport\(\s*['"][^'"]*koto-data(\.js)?['"]\s*\)/.test(t)
}

/**
 * AI が「自分でファイルに保存」してしまっていないか（純関数）。
 *
 * **これは静かに壊れる。** AppRun や HANAMII のコンテナでは書けてしまうので
 * 動作確認では正常に見え、再起動や再公開で消える。見つけたら知らせる。
 *
 * 読み取りだけ（`readFile`）は除く。設定ファイルを読むのは普通のこと。
 */
export function writesFilesDirectly(sourceText: string): boolean {
  const t = String(sourceText ?? '')
  return /\bfs\s*\.\s*(promises\s*\.\s*)?(writeFile|writeFileSync|appendFile|appendFileSync)\s*\(/.test(t)
    || /\bwriteFile(Sync)?\s*\(/.test(t) && /\bfrom\s+['"](node:)?fs/.test(t)
    || /\bopen\s*\(\s*[^)]*['"][wa]\+?['"]\s*\)/.test(t) // Python の open(..., 'w')
}
