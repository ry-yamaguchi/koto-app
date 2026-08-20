// state.ts — 作成済みリソースの状態（.sakura-cloud/state.json）の型と純ヘルパー。
//
// ※重要: このモジュールは electron に依存しない純ロジックである。
//   load/save（IO）はここでは行わず、main.ts 側で fs を直叩きする。ここは型と純ヘルパーのみ。
//
// state.json はユーザー非編集（IDEが作成済みリソースの対応関係を記録するための内部ファイル）。

/** リソースの種別。 */
export type ResourceKind = 'registry' | 'image' | 'apprun-app' | 'bucket'

/**
 * 作成済みリソースへの参照。
 * - kind: 種別
 * - id: クラウド側のリソースID（API応答などから記録）
 * - stateful: ステートフル資源か（バケット等、削除でデータが失われるもの）
 * - key: spec 側の要求リソースと突き合わせるための論理キー（例 'apprun-app:myapp-test', 'bucket:myapp-test-data'）
 */
export type ResourceRef = {
  kind: ResourceKind
  id: string
  stateful: boolean
  key: string
  /**
   * バケットのときの置き場所（`projects/<名前>/`）。
   *
   * **破棄のときに要る。** そのころには spec からこのプロジェクトの記述が
   * 消えているため、spec からは引けない。ここに控えておかないと
   * 「どこを消せばよいか」が分からなくなる。
   */
  prefix?: string
}

/**
 * 環境メタ情報（TTLガードレール用）。
 * - createdAt: 環境を最初にプロビジョニングした時刻（ISO 8601 文字列）。
 * - ttlHours: 作成からの有効時間（時間）。createdAt + ttlHours を過ぎたら期限切れとみなす。
 * いずれも任意。古い state.json（meta 無し）との後方互換のため optional にしている。
 */
export type EnvMeta = {
  createdAt?: string
  ttlHours?: number
  /**
   * 永続データの読み書きに使っている権限のID。
   *
   * **シークレットは控えない**（発行時にしか読めず、控える必要も無い）。
   * 控えるのはIDだけで、次の公開で新しい鍵を発行したあと、**これを頼りに
   * 古い鍵を無効にする**。控えないと古い鍵が使えるまま溜まり続ける。
   */
  storagePermissionId?: string
  /**
   * このプロジェクトが使っているコンテナレジストリ名（subdomainLabel）。
   *
   * ── なぜ state に持つのか（2026-08-06 の実害から） ──────────────────────
   * push用の資格情報（registry-credentials.enc）は **アプリ共通に1つだけ** 保存されており、
   * 最後に公開したプロジェクトの内容で上書きされる。破棄はそこからレジストリ名を読んでいたため、
   * **別のプロジェクトのレジストリを削除してしまう**事故が起きた
   * （NewProject-2 を破棄したら、直前に触っていた yamada プロジェクトのレジストリが消えた）。
   * レジストリ名はプロジェクトごとに state.json へ記録し、破棄はこれだけを見る。
   */
  registryName?: string
  /**
   * いま公開しているイメージのタグ（例 `v20260819-182300`）。
   *
   * ── なぜ控えるのか（2026-08-19）──────────────────────────────────────
   * 公開のたびに新しいタグを打つようになったので、レジストリに古いタグが溜まる。
   * 片づけるときに**いま動いているアプリが使っているタグを消してはいけない**が、
   * それは spec からは分からない（spec の tag は `latest` のままで、実際に打った
   * タグはその場で作る）。控えておかないと、**足元を外す**ことになる。
   */
  imageTag?: string
}

/**
 * 既存のコンテナレジストリを探すときに、どの名前をどの順で試すか（純関数）。
 *
 * ── なぜ記録名を先に見るのか（2026-08-06 の実害から） ──────────────────────
 * 以前は「公開名から作った基本ラベル」だけで探していた。ところがレジストリを削除すると
 * さくら側で**その名前がしばらく予約状態**になり、同名で作り直せない。そのため実装は
 * サフィックス付き（例 `yamada-c198`）で作成するのだが、**次に探すときはまた基本ラベル
 * （`yamada`）で探して見つけられず、また新しいサフィックス付きを作ってしまう**。
 * 結果、公開や「ユーザー再設定」を押すたびにレジストリが増え、1つにつき月220円が積み上がる。
 *
 * 記録済みの名前（state.json の meta.registryName）を先に試せば、この増殖が止まる。
 */
export function registryLookupNames(state: { meta?: EnvMeta }, baseLabel: string): string[] {
  const recorded = state.meta?.registryName
  const names: string[] = []
  if (typeof recorded === 'string' && recorded) names.push(recorded)
  if (baseLabel && !names.includes(baseLabel)) names.push(baseLabel)
  return names
}

/**
 * 破棄のときに削除してよいコンテナレジストリを決める（純関数）。
 *
 * **このプロジェクトが記録している名前しか対象にしない。** 共通の資格情報
 * （registry-credentials.enc＝最後に公開したプロジェクトのもの）を見てはいけない。
 * 2026-08-06 に、それが原因で NewProject-2 の破棄が別プロジェクト yamada の
 * レジストリを削除する事故が起きた。
 */
export function registryDeletionTarget(
  state: { meta?: EnvMeta }, deleteRegistry: boolean
): { name: string } | { skipped: 'not-requested' | 'unknown' } {
  if (!deleteRegistry) return { skipped: 'not-requested' }
  const name = state.meta?.registryName
  if (typeof name !== 'string' || !name) return { skipped: 'unknown' }
  return { name }
}

/**
 * 初回プロビジョニングのときだけ作成メタ（createdAt / ttlHours）を付ける（純関数）。
 * 既に createdAt があれば state をそのまま返す。
 *
 * ── なぜ「差し替え」ではなく「マージ」なのか（2026-08-09 の実害から）──────────
 * 以前は呼び出し側で meta を丸ごと新しい object に差し替えていた。この処理が走るのは
 * 「createdAt が無いとき」＝**初回の公開**だが、初回とはまさに直前の ensureRegistry が
 * meta.registryName を書き込んだ直後である。そのため **公開のたびに registryName が消え**、
 * v0.2.95 の「破棄は記録した名前だけを消す」も v0.2.96 の「既存レジストリを再利用する」も
 * 両方とも実機では一度も効いていなかった。
 *
 * 実際に起きていたこと:
 *   - 破棄しても registryDeletionTarget が「対象不明」になり、**レジストリが消えない**（月220円が残る）
 *   - registryLookupNames が基本ラベルしか返さず、実物（yamada-2fdb 等）を見つけられず**増殖する**
 *
 * meta に項目を足すときは、必ずここを通して既存の項目を残すこと。
 */
export function withCreationMeta(state: EnvState, ttlHours: number, now: Date): EnvState {
  if (state.meta?.createdAt) return state
  return { ...state, meta: { ...state.meta, createdAt: now.toISOString(), ttlHours } }
}

/**
 * 公開（push）に使うコンテナレジストリを決める（純関数）。
 *
 * ── なぜ突き合わせるのか（2026-08-09 の実機検証で発覚）───────────────────
 * push 用の接続情報（registry-credentials.enc）は**アプリ共通に1つだけ**で、
 * 最後に「↻ ユーザー再設定」を押したプロジェクトのもので上書きされる。
 * 公開処理はそれをそのまま使っていたため、**別のプロジェクトのレジストリへ
 * イメージを push していた**（例: yamada のイメージが
 * newproject-2-1b9c.sakuracr.jp/yamada:latest として B のレジストリに入った）。
 * その状態で B を破棄してレジストリを消すと、**A が参照するイメージが消えて A が動かなくなる**。
 * プロジェクトを2つ行き来していれば、誤操作なしで起きる。
 *
 * v0.2.95 が直したのは「破棄」側だけで、「公開」側はここまで手つかずだった。
 *
 * 判定:
 * - 接続情報が無い          → 'no-credentials'（先にレジストリを用意させる）
 * - 記録が無い              → 接続情報の名前を採用する。**エラーにはしない**。
 *   記録は v0.2.99 以前に失われている場合があり、そこで公開を止めると
 *   「↻ ユーザー再設定」を押させることになるが、それは記録が無い状態では
 *   実物を見つけられず**新しいレジストリを作る**（月220円が増える）。
 *   いま使っているものを引き継ぎ、呼び出し側で記録し直すのが安全。
 * - 記録と一致              → そのまま使う
 * - 記録と食い違う          → 'mismatch'。別プロジェクトの接続情報が入っている
 */
export function resolvePushRegistry(
  recorded: string | null | undefined, credentialName: string | null | undefined
): { use: string; adopt: boolean } | { error: 'no-credentials' } | { error: 'mismatch'; recorded: string; credential: string } {
  const cred = typeof credentialName === 'string' && credentialName ? credentialName : null
  if (!cred) return { error: 'no-credentials' }
  const rec = typeof recorded === 'string' && recorded ? recorded : null
  if (!rec) return { use: cred, adopt: true }
  if (rec !== cred) return { error: 'mismatch', recorded: rec, credential: cred }
  return { use: rec, adopt: false }
}

/**
 * 破棄したあとの state を組み立てる（純関数）。
 * リソースを空にし、作成メタ（createdAt/ttlHours）も落とす。ただし
 * **レジストリを残したときは registryName だけは残す**。
 *
 * ── なぜ残すのか（2026-08-09 の実機検証で発覚）───────────────────────────
 * 以前は meta を丸ごと捨てていた。ユーザーが「コンテナレジストリも削除する」の
 * チェックを外した場合（＝レジストリは残す）も同じく registryName が消えていたため、
 * **残したレジストリを Koto が二度と管理できなくなっていた**。
 *
 *   1. 次に「↻ ユーザー再設定」を押すと、記録が無いので基本ラベルで探し、
 *      実物（yamada-2fdb など）を見つけられずに新しいレジストリを作る（月220円が増える）
 *   2. 次に破棄しようとすると registryDeletionTarget が「対象不明」を返し、
 *      「記録がないため削除していません」となる（コンパネで手動削除するしかない）
 *
 * つまり「残す」という選択肢そのものが、そのレジストリを管理不能にする罠だった。
 * 逆に**削除に成功したときは記録を消す**こと。残すと、存在しないレジストリを
 * 指した記録が次の公開で再利用されてしまう。
 */
export function stateAfterTeardown(state: EnvState, registryDeleted: boolean): EnvState {
  const name = state.meta?.registryName
  const keep = !registryDeleted && typeof name === 'string' && name.length > 0
  return {
    name: state.name,
    backend: state.backend,
    resources: state.resources,
    ...(keep ? { meta: { registryName: name as string } } : {}),
  }
}

/** 環境の状態。 */
export type EnvState = {
  name: string
  backend: string
  resources: ResourceRef[]
  /** TTL等の環境メタ情報（任意）。作成時に付与する。 */
  meta?: EnvMeta
}

/**
 * ステートフルな種別の集合。ここに含まれる kind の資源は、
 * spec に残っている限り削除しない（＝ステートフル維持）保証の根拠になる。
 */
export const STATEFUL_KINDS: ReadonlySet<ResourceKind> = new Set<ResourceKind>(['bucket'])

/** kind がステートフルかを判定する純ヘルパー。 */
export function isStateful(kind: ResourceKind): boolean {
  return STATEFUL_KINDS.has(kind)
}

/** 空の状態を生成する純ヘルパー（state.json が無いときに使う）。 */
export function emptyState(name: string, backend: string): EnvState {
  return { name, backend, resources: [] }
}

/**
 * isExpired — state の meta（createdAt + ttlHours）から TTL 超過かを判定する純関数。
 * - meta が無い、createdAt が無い、ttlHours が無い/0以下、createdAt が不正な場合は期限なしとして false。
 * - createdAt + ttlHours（ミリ秒換算）を now が過ぎていれば true。
 */
export function isExpired(state: EnvState, now: Date): boolean {
  const meta = state.meta
  if (!meta || typeof meta.createdAt !== 'string' || typeof meta.ttlHours !== 'number') {
    return false
  }
  if (!(meta.ttlHours > 0)) return false
  const created = Date.parse(meta.createdAt)
  if (Number.isNaN(created)) return false
  const expiresAt = created + meta.ttlHours * 60 * 60 * 1000
  return now.getTime() > expiresAt
}

/**
 * 実行のあとで**記録に残す state** を決める（純関数）。
 *
 * ── なぜ要るか（2026-08-14 実機で発覚）────────────────────────────────
 * 保存場所の破棄が 403 で落ちたとき、**AppRunアプリは既に削除されていた**のに
 * `if (result.ok)` の中でしか記録を保存していなかったため、state.json は
 * 「アプリはまだある」と言い続けた。次に公開すると、消えたアプリへ再デプロイを
 * 試みて **HTTP 404**。利用者は公開も破棄もできない袋小路に入った。
 *
 * **途中まで実行された分は、失敗しても必ず記録する。** applyPlan が返す state は
 * 「実際に何が起きたか」であって「成功したか」ではない。捨ててよいものではない。
 *
 * 公開（apply）で同じことが起きると、もっと悪い。**作られたアプリが記録に残らず、
 * Koto から見つけられないまま課金が続く。**
 */
/**
 * 公開に使ったイメージのタグを記録する（**既存の meta は必ず残す**）。
 *
 * meta を丸ごと差し替えると registryName が消える（2026-08-09 に実害が出た形）ので、
 * 追加は必ずここを通す。タグが空のときは何も変えない。
 */
export function withImageTag(state: EnvState, tag: string | null | undefined): EnvState {
  const t = String(tag ?? '').trim()
  if (!t) return state
  return { ...state, meta: { ...state.meta, imageTag: t } }
}

export function stateToSave(opts: {
  ok: boolean
  state: EnvState
  kind: 'apply' | 'teardown'
  /** apply の初回構築で付ける期限（kind='apply' のときだけ使う）。 */
  ttlHours?: number
  now?: Date
  /** teardown でレジストリを消せたか（kind='teardown' のときだけ使う）。 */
  registryDeleted?: boolean
  /** 今回の公開に使ったイメージのタグ（kind='apply' のときだけ使う）。 */
  imageTag?: string
}): EnvState {
  // 失敗したときは、起きたことをそのまま残す。**成功時だけの仕上げは行わない**
  // （作成メタを付けたり、レジストリの記録を落としたりしない）
  if (!opts.ok) return opts.state
  if (opts.kind === 'apply') {
    // **タグは毎回書き換える**（createdAt と違い「初回だけ」ではない。
    // 記録が古いと、いま動いているタグを消してしまう）。
    return withImageTag(
      withCreationMeta(opts.state, opts.ttlHours ?? 0, opts.now ?? new Date()),
      opts.imageTag
    )
  }
  return stateAfterTeardown(opts.state, opts.registryDeleted === true)
}
