// publishStatus.ts — ③公開「公開状況」表示のための純粋ロジック。
// .sakuraide.json の publish.targets（統一公開記録）＋レガシー情報（旧フィールドのみのプロジェクト救済）から
// 表示行リストを作り、公開後にコードが変わっていないか（stale）を判定する。
// electron/DOM 非依存の純粋関数のみを置く（tests/publishStatus.test.ts の対象）。

export type PublishTargetKind = 'hanamii' | 'sakura-apprun' | 'sakura-rental' | 'vercel'

// 公開先ごとの表示ラベル（PublishModal・各パネルの表記に合わせる）。
// 破棄の導線が増えたため（📡 公開したもの一覧・プロジェクト削除）外へも出す。
// ラベルを各画面で書き直すと表記が割れるので、必ずここを参照すること。
export const PUBLISH_TARGET_LABEL: Record<PublishTargetKind, string> = {
  hanamii: '🌸 HANAMII',
  'sakura-apprun': '📦 さくらのAppRun',
  'sakura-rental': '🌐 さくらのレンタルサーバ',
  vercel: '▲ Vercel',
}

export interface PublishTargetRecord {
  publishedAt?: string | null
  url?: string | null
}

// 公開開始マーカー（publish.pending）。公開処理の開始時に書き、終了時（成功/失敗どちらでも）に消す
// （src/renderer/publishPending.ts）。これが残っている＝前回の公開が完了前に中断・失敗した可能性がある
// （detectInterruptedPublish の対象）。
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
  const order: PublishTargetKind[] = ['hanamii', 'vercel', 'sakura-apprun', 'sakura-rental']

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
  const validTargets: PublishTargetKind[] = ['hanamii', 'sakura-apprun', 'sakura-rental', 'vercel']
  if (!pending.target || !validTargets.includes(pending.target)) return null
  const started = new Date(pending.startedAt).getTime()
  if (isNaN(started)) return null
  if (nowMs - started < PENDING_RECENCY_THRESHOLD_MS) return null
  return pending
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
    const target = key as PublishTargetKind
    if (!PUBLISH_TARGET_LABEL[target]) continue // 未知のキー（将来の公開先・破損データ）は無視する
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

/**
 * 公開記録から1つの公開先を取り除く（破棄・削除に成功したとき用の純関数）。
 *
 * ── なぜ必要か（2026-08-06 の点検で判明） ──────────────────────────────────
 * 公開したときは publish.targets へ記録するのに、**Koto 自身で破棄しても記録が残っていた**。
 * その結果「📡 公開したもの一覧」に、もう存在しない公開が出続ける。
 * 外部（コントロールパネル）で消された分は Koto には分からないが、**自分で消したものは分かる**。
 * 分かることは記録に反映する。
 *
 * publish.lastPublishedAt / url は「最後に公開したときの情報」として残す（履歴としての意味がある）。
 * 消すのは targets の該当エントリだけ。
 */
export function withoutPublishTarget(
  publish: PublishMeta | null | undefined, target: PublishTargetKind
): PublishMeta {
  const base = publish ?? {}
  const targets = { ...(base.targets ?? {}) }
  delete targets[target]
  return { ...base, targets }
}
