// publishStatus.ts — ③公開「公開状況」表示のための純粋ロジック。
// .sakuraide.json の publish.targets（統一公開記録）＋レガシー情報（旧フィールドのみのプロジェクト救済）から
// 表示行リストを作り、公開後にコードが変わっていないか（stale）を判定する。
// electron/DOM 非依存の純粋関数のみを置く（tests/publishStatus.test.ts の対象）。

// 'sakura-apprun-dedicated' は さくらのAppRun 専有型（roadmap #23・D-3、2026-09-11 Ryosuke 決定）。
// 表示・一覧・破棄・費用は共用型（'sakura-apprun'）と同じ扱いを基本にし、専有型固有の違い
// （破棄の範囲＝アプリのみ・クラスタは専有型タブの⑥）は src/shared/teardownSupport.ts に書く。
export type PublishTargetKind = 'hanamii' | 'sakura-apprun' | 'sakura-apprun-dedicated' | 'sakura-rental' | 'vercel'

// 公開先ごとの表示ラベル（PublishModal・各パネルの表記に合わせる）。
// 破棄の導線が増えたため（📡 公開したもの一覧・プロジェクト削除）外へも出す。
// ラベルを各画面で書き直すと表記が割れるので、必ずここを参照すること。
export const PUBLISH_TARGET_LABEL: Record<PublishTargetKind, string> = {
  hanamii: '🌸 HANAMII',
  'sakura-apprun': '📦 さくらのAppRun',
  'sakura-apprun-dedicated': '📦 さくらのAppRun（専有型）',
  'sakura-rental': '🌐 さくらのレンタルサーバ',
  vercel: '▲ Vercel',
}

/**
 * 公開先の管理画面（2026-08-15 Ryosuke 指摘）。
 *
 * **キーが無くても、外に生きているものへ辿り着けるようにする。** キーを失くす／
 * 作り直す／別のマシンへ移ると、Koto からは操作できなくなる。そのとき
 * 「公開済み」とだけ表示して行き先を示さないと、**放置され、課金が続く**。
 * URL はコード内で既に使っているものを流用する（推測しない・掟1）。
 */
export const PUBLISH_TARGET_CONSOLE: Record<PublishTargetKind, string> = {
  hanamii: 'https://hanamii.jp/',
  'sakura-apprun': 'https://secure.sakura.ad.jp/cloud/apprun/',
  // 専有型の専用ページ URL は未確認なので推測しない（掟1）。専有型パネルが既に入口として
  // 使っているクラウドのコントロールパネルを指す。
  'sakura-apprun-dedicated': 'https://secure.sakura.ad.jp/cloud/',
  'sakura-rental': 'https://secure.sakura.ad.jp/rs/cp/',
  vercel: 'https://vercel.com/dashboard',
}

/**
 * 既知の公開先の種類か（純関数）。PUBLISH_TARGET_LABEL の**自前のキー**だけを既知とみなす。
 * 種類の一覧をここへ書き下すと二重管理になる（掟10）ので、ラベル表のキーで判定する。
 * `PUBLISH_TARGET_LABEL[key]` の真偽で見ると、'constructor' や 'toString' のような
 * Object.prototype 由来のキー（破損データ）まで既知と読んでしまうため、own property で見る。
 */
export function isKnownPublishTarget(key: string | null | undefined): key is PublishTargetKind {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(PUBLISH_TARGET_LABEL, key)
}

export interface PublishTargetRecord {
  publishedAt?: string | null
  url?: string | null
}

// 公開開始マーカー（publish.pending）。公開処理の開始時に main が書き、終了時（成功/失敗どちらでも）に
// 消す（src/main/publishMetaFs.ts の markPendingFs / clearPendingFs）。**走っていないのに残っている**＝
// 前回の公開が完了前に中断・失敗した可能性がある（detectInterruptedPublish・judgePendingPublish の対象）。
export interface PendingPublish { target: PublishTargetKind; startedAt: string }

// .sakuraide.json の publish 部分（このモジュールが読む範囲のみ・実際の型はより広い）。
export interface PublishMeta {
  targets?: Partial<Record<PublishTargetKind, PublishTargetRecord>>
  hanamii?: { projectId?: string | null }
  lastPublishedAt?: string
  host?: string
  pending?: PendingPublish | null
}

export interface PublishStatusRow {
  target: PublishTargetKind
  label: string
  publishedAt: string | null // ISO文字列。日時不明（レガシー救済）は null
  url: string | null
  /** publishedAt が不明で「公開済み」としか分からない（レガシー救済）行かどうか */
  dateUnknown: boolean
}

/**
 * publish.targets とレガシー情報（旧フィールドのみのプロジェクト救済）から表示行リストを作る。
 * - targets に記録があればそれを優先する。
 * - targets に無い場合のみレガシー救済:
 *   (a) hanamii.projectId があれば hanamii 行を「公開済み（日時不明）」で追加
 *   (b) lastPublishedAt かつ host があれば sakura-rental 行を追加
 *   (c) AppRun は .sakura-cloud/state.json の構築記録（呼び出し側が parseApprunLegacy で読んで opts で渡す）から追加
 * - 何も無ければ空配列を返す（呼び出し側はこの場合セクション自体を表示しない）。
 */
export function buildPublishStatusRows(
  publish: PublishMeta | undefined | null,
  opts?: { apprunLegacy?: { createdAt: string | null } | null },
): PublishStatusRow[] {
  const rows: PublishStatusRow[] = []
  if (!publish && !opts?.apprunLegacy) return rows
  publish = publish ?? {}

  const targets = publish.targets ?? {}
  const order: PublishTargetKind[] = ['hanamii', 'vercel', 'sakura-apprun', 'sakura-apprun-dedicated', 'sakura-rental']

  for (const t of order) {
    const rec = targets[t]
    if (rec) {
      rows.push({
        target: t,
        label: PUBLISH_TARGET_LABEL[t],
        publishedAt: rec.publishedAt ?? null,
        url: rec.url ?? null,
        dateUnknown: !rec.publishedAt,
      })
    }
  }

  // ── レガシー救済（targets に記録が無い既存プロジェクトのみ） ──
  if (!targets.hanamii && publish.hanamii?.projectId) {
    rows.push({ target: 'hanamii', label: PUBLISH_TARGET_LABEL.hanamii, publishedAt: null, url: null, dateUnknown: true })
  }
  // AppRun: publish.targets 導入前の構築は .sakura-cloud/state.json から救済（呼び出し側が parseApprunLegacy で渡す）
  if (!targets['sakura-apprun'] && opts?.apprunLegacy) {
    rows.push({
      target: 'sakura-apprun',
      label: PUBLISH_TARGET_LABEL['sakura-apprun'],
      publishedAt: opts.apprunLegacy.createdAt,
      url: null,
      dateUnknown: !opts.apprunLegacy.createdAt,
    })
  }
  if (!targets['sakura-rental'] && publish.lastPublishedAt && publish.host) {
    rows.push({
      target: 'sakura-rental',
      label: PUBLISH_TARGET_LABEL['sakura-rental'],
      publishedAt: publish.lastPublishedAt,
      url: `https://${publish.host}/`,
      dateUnknown: false,
    })
  }

  return rows
}

/**
 * 公開日時（publishedAt）より後にプロジェクトが変更されているか（stale）を判定する。
 * 1分のマージンを設け、誤差程度の差分では stale としない。
 * publishedAt か latest のどちらかが無い/パース不能なら判定不能として false を返す。
 */
export function isStale(publishedAt: string | null | undefined, latest: string | null | undefined, marginMs = 60_000): boolean {
  if (!publishedAt || !latest) return false
  const p = new Date(publishedAt).getTime()
  const l = new Date(latest).getTime()
  if (isNaN(p) || isNaN(l)) return false
  return l > p + marginMs
}

/** ISO日時を「M/D HH:mm」の平易な形式にする（パース不能なら null）。 */
export function formatPublishedAt(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  const month = d.getMonth() + 1
  const day = d.getDate()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${month}/${day} ${hh}:${mm}`
}


// pending マーカーが「まだ実行中の可能性がある」とみなす直近しきい値（ミリ秒）。
// これより新しい pending は、いままさに進行中の公開処理が自分で書いたものである可能性が高いため、
// 中断とは判定しない（PublishModal を開いた瞬間に自分自身の公開処理を誤検知しないようにするため）。
const PENDING_RECENCY_THRESHOLD_MS = 5_000

/**
 * 前回の公開が完了前に中断された可能性があるか判定する（純粋関数）。
 * publish.pending マーカーが残っていて、かつ一定時間（既定5秒）以上前に開始されていれば
 * （＝正常に完了していれば finally で消えているはず＝ごく直近のものはまだ実行中の可能性があるため除外）、
 * その pending を返す。マーカーが無い／target が既知の公開先でない／startedAt がパース不能なら null。
 */
export function detectInterruptedPublish(meta: PublishMeta, nowMs: number): PendingPublish | null {
  const pending = meta?.pending
  if (!pending) return null
  // 既知の公開先かどうかは isKnownPublishTarget（PUBLISH_TARGET_LABEL の自前キー）で判定する
  // （種類の一覧をここに複製しない・掟10。latestPublishedTarget と同じ判定）。
  if (!isKnownPublishTarget(pending.target)) return null
  const started = new Date(pending.startedAt).getTime()
  if (isNaN(started)) return null
  if (nowMs - started < PENDING_RECENCY_THRESHOLD_MS) return null
  return pending
}

// ── 公開開始マーカーの見せ方（2026-09-29）────────────────────────────────────
// 公開の本体は main の1回の IPC で最後まで進む。**画面（公開ダイアログ）を閉じて開き直しても、公開は
// 走り続けている**。ところが以前は、pending が5秒より古ければ何でも「中断された可能性があります」と
// 出していたので、**中断していないのに**、公開の最中に開き直すとその警告が出た。
// 「いま走っているか」を知っているのは main の鍵（src/main/projectLock.ts）だけなので、
// それを聞いて（`publishMeta:runningOp`）3通りに出し分ける。
export type PendingPublishView =
  /** マーカーが無い（または公開先が読めない）。何も出さない。 */
  | { kind: 'none' }
  /** マーカーがあり、いま main が公開を走らせている。中断ではない。 */
  | { kind: 'running'; pending: PendingPublish }
  /** マーカーがあり、いま走っていない。前回の公開が完了前に止まった可能性がある。 */
  | { kind: 'interrupted'; pending: PendingPublish }

/**
 * publish.pending を、いま走っているか（main の鍵）と合わせて3通りに分ける（純粋関数）。
 *
 * ・pending が無い／公開先が既知でない → none
 * ・pending があり、main が**公開**を走らせている → running（中断ではない）
 * ・pending があり、走っていない → 従来どおり detectInterruptedPublish（5秒以内の直近は none）
 *
 * `runningOp` は main の鍵が返す操作名（'作成' | '削除' | '公開'）。**'公開' のときだけ**走っている扱い
 * （破棄や作成が走っているあいだに残っている pending は、前の公開の名残であって、いまの公開ではない）。
 * 聞けなかったとき（null）は「走っていない」と同じに扱う＝従来の判定に戻る。
 */
export function judgePendingPublish(
  meta: PublishMeta | null | undefined, runningOp: string | null | undefined, nowMs: number,
): PendingPublishView {
  const pending = meta?.pending
  if (!pending || !isKnownPublishTarget(pending.target)) return { kind: 'none' }
  if (runningOp === '公開') return { kind: 'running', pending }
  const interrupted = detectInterruptedPublish(meta ?? {}, nowMs)
  return interrupted ? { kind: 'interrupted', pending: interrupted } : { kind: 'none' }
}

/**
 * 公開ダイアログの上部に出す1文（純粋関数・掟5: 素のテキスト）。何も出さないなら null。
 * running の文は「閉じても最後まで進む」ことと、**Koto を終了したら止まる**ことの両方を言う
 * （窓を閉じただけなら main の処理は続く。終了すると途中で止まる・src/renderer/activity.ts の
 * PUBLISH_CLOSE_WARNING と同じ事実）。
 *
 * 「公開状況に記録される」は**成功したときだけ**（main は成功の最後に publish.targets を書く。
 * 失敗すると書かれず、pending も finally で消えるので、公開状況にも「中断」の通知にも何も出ない）。
 * 「終わると出ます」と言い切ると、失敗したときに嘘になる（2026-09-29 検分）。
 */
export function pendingPublishMessage(view: PendingPublishView): string | null {
  if (view.kind === 'running') {
    return `⏳ ${PUBLISH_TARGET_LABEL[view.pending.target]}への公開が進んでいます。この画面を閉じても、公開は最後まで進みます（Koto を終了すると途中で止まります）。公開に成功すると、公開状況に記録されます（失敗したときは記録されません）。`
  }
  if (view.kind === 'interrupted') {
    return `⚠️ 前回、${PUBLISH_TARGET_LABEL[view.pending.target]}への公開が完了前に中断された可能性があります。実際に公開されたか、下の公開状況や公開先の管理画面でご確認ください。`
  }
  return null
}

/**
 * 「最後に公開した公開先」を publish.targets の publishedAt から求める（純粋関数・2026-07-31 ユーザー要望）。
 * ③公開を開いたときに、最後に使った公開先の画面を最初に出すために使う。
 *
 * **各パネルが書く meta.target に頼らない**理由: 公開成功時に meta.target を更新するかはパネルごとに
 * 実装がばらけており、実際に AppRun だけが更新していなかった（そのため AppRun で公開しても次回は
 * 元の公開先の画面が開いていた）。公開の事実そのもの（publish.targets の日時）から計算すれば、
 * 新しい公開先を足したときも書き忘れで壊れない。
 *
 * publishedAt が無い・パースできない記録は候補にしない。該当が無ければ null（呼び出し側が meta.target へ）。
 */
export function latestPublishedTarget(meta: PublishMeta | undefined | null): PublishTargetKind | null {
  const targets = meta?.targets
  if (!targets) return null
  let best: { target: PublishTargetKind; at: number } | null = null
  for (const [key, rec] of Object.entries(targets)) {
    if (!isKnownPublishTarget(key)) continue // 未知のキー（将来の公開先・破損データ）は無視する
    const target = key
    const at = new Date(rec?.publishedAt ?? '').getTime()
    if (isNaN(at)) continue
    if (!best || at > best.at) best = { target, at }
  }
  return best?.target ?? null
}

/**
 * .sakura-cloud/state.json（AppRun構築状態）から「AppRunに公開済み」のレガシー実績を取り出す（純粋関数）。
 * publish.targets 導入前に AppRun 公開したプロジェクトの救済用。
 * apprun-app リソースが1つ以上あれば { createdAt } を返し、無ければ null。
 */
export function parseApprunLegacy(stateJson: unknown): { createdAt: string | null } | null {
  const s = stateJson as any
  const resources = Array.isArray(s?.resources) ? s.resources : []
  const hasApp = resources.some((r: any) => r && r.kind === 'apprun-app')
  if (!hasApp) return null
  const createdAt = typeof s?.meta?.createdAt === 'string' ? s.meta.createdAt : null
  return { createdAt }
}

// 公開記録から1つの公開先を取り除く純関数は src/shared/publishMeta.ts が唯一の定義
// （2026-09-29: 書き戻しを main の1か所へ集めたため移した。呼び出し側は変わらない）。
export { withoutPublishTarget } from '../shared/publishMeta'

/**
 * その行を「片づける」ことができるか（純関数）。
 *
 * AppRun の日時不明の行は `.sakura-cloud/state.json`（構築の記録）から作られており、
 * **ここを消しても消えない**。あちらは「破棄」で扱うものなので、片づけの対象にしない
 * （押しても何も起きないボタンを出さない）。
 * 専有型（'sakura-apprun-dedicated'）には state.json からの救済が無い（publish.targets の記録だけ）ので、
 * 日時不明でも片づけられる。
 */
export function canForgetRow(row: Pick<PublishStatusRow, 'target' | 'dateUnknown'>): boolean {
  return !(row.target === 'sakura-apprun' && row.dateUnknown)
}
