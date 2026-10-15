// stageTiming.ts — 「どこにどれくらい時間がかかったか」を測るための段の名前（内部名）と、記録の形・時間の文。
//
// ── なぜ要るか（2026-10-07・作者の問い）──────────────────────────────────────────
// 「AppRun 専有型で公開と削除それぞれで結構時間がかかった。どこにどれくらいの時間がかかっているか」。
// それまで Koto は段ごとの時刻を持たず、進み具合は**画面に出す文**だけだった（画面は文の書き出しで段を見分けていた:
// AppRunDedicatedPanel.tsx の publishProgressStep）。文を直すたびに段の見分けが外れる作りでは、記録がつながらない。
// そこで段には**内部の名前（ID）**を付け、記録はその名前で持つ（画面の言葉を直しても、過去の記録とつながる）。
//
// ── どこが持つか（掟10: 定義は1か所）────────────────────────────────────────────
// 専有型の 作成（手順5）・公開（手順8）・削除（手順6）の段の ID と、画面に出す名前の表は**このファイルだけ**。
// 各ハンドラ（main/cloud/apprunDedicated*.ts・main/ipc/apprunDedicated.ts）は `STAGE.xxx` を渡し、
// projectOps.ts が段ごとの開始・終了の時刻を持つ。保存・目安は stageEstimate.ts と main/stageTimingStore.ts。
// ほかの公開先（共用型・HANAMII・Vercel）は今回は付けないが、仕組みは共通（どのハンドラも stage を渡せば記録される）。
//
// ── 段の区切り（実際のハンドラの進み具合の出し方を読んで決めた・2026-10-07）──────────────────
// ・作成（createClusterFlow）: 進み具合の文は1つだけ（「…を作っています」）。内部は クラスタ → ASG → LB の順に
//   POST して、そのつど存在を確かめる。区切りは**作る資源ごと**（確かめる時間は作った段に含める）。
// ・公開（apprunDedicated:publishApp）: 保存場所のアクセスキーの用意・koto-data の置き直し → prepareAppImage
//   （イメージのビルドとレジストリへのプッシュ。内蔵ビルダー crane は**ビルドとプッシュを1つのプロセスで行う**ので、
//   外からは分けられない＝1段にする）→ publishAppFlow の13段（確認・アプリ・古いバージョンの削除・LB の IP 待ち・
//   応答の確認・コンテナの確認）→ 古いアクセスキーの削除。短い API 呼び出しだけの段（アプリの確認・作成・
//   バージョンの作成・有効化）は、1秒前後の行を並べても読みにくいので「アプリとバージョンの作成・有効化」に束ねた。
// ・削除（teardownFlow）: アプリ → LB → ASG → クラスタ → 保存場所。各段は「DELETE → 一覧から消えるまで待つ」で、
//   待ちがほとんどの時間を占める。途中で下位の資源が残っていて待ち直す（409 の回復）ときは、その資源の段へ移って戻る
//   （同じ段に戻ったときは時間を足し合わせる）。

/** 段の内部名。画面の言葉を直しても変えない（記録はこの名前でつながる）。 */
export const STAGE = {
  // 手順5 クラスタを作る
  createCluster: 'create.cluster',
  createAsg: 'create.asg',
  createLb: 'create.lb',
  // 手順8 アプリを公開する
  publishPrepare: 'publish.prepare',
  publishImage: 'publish.image',
  publishCheck: 'publish.check',
  publishApp: 'publish.app',
  publishCleanup: 'publish.cleanup',
  publishLbAddress: 'publish.lb-address',
  publishVerify: 'publish.verify',
  publishContainers: 'publish.containers',
  publishKeyCleanup: 'publish.key-cleanup',
  // 手順6 作ったものを削除する（📡 一覧の「🗑 破棄」も同じ流れ。アプリ → LB → ASG → クラスタ → 保存場所の順に通る）
  teardownApp: 'teardown.app',
  teardownLb: 'teardown.lb',
  teardownAsg: 'teardown.asg',
  teardownCluster: 'teardown.cluster',
  teardownStorage: 'teardown.storage',
} as const

export type StageId = (typeof STAGE)[keyof typeof STAGE]

export type StageDef = { id: StageId; label: string }

/** 操作ごとの、段の並び（通る順）と画面に出す名前。**画面の名前はここだけ**（wording-decisions.md の言い方に従う）。 */
export const DEDICATED_STAGES: Readonly<Record<'create' | 'publish' | 'teardown', readonly StageDef[]>> = {
  create: [
    { id: STAGE.createCluster, label: 'クラスタの作成' },
    { id: STAGE.createAsg, label: 'オートスケーリンググループの作成' },
    { id: STAGE.createLb, label: 'ロードバランサの作成' },
  ],
  publish: [
    { id: STAGE.publishPrepare, label: '公開の準備（保存場所のアクセスキーなど）' },
    { id: STAGE.publishImage, label: 'イメージのビルドとプッシュ' },
    { id: STAGE.publishCheck, label: '公開前の確認' },
    { id: STAGE.publishApp, label: 'アプリとバージョンの作成・有効化' },
    { id: STAGE.publishCleanup, label: '古いバージョンの削除' },
    { id: STAGE.publishLbAddress, label: 'ロードバランサの IP 待ち' },
    { id: STAGE.publishVerify, label: 'アプリの起動と応答の確認' },
    { id: STAGE.publishContainers, label: 'コンテナの状態の確認' },
    { id: STAGE.publishKeyCleanup, label: '保存場所の古いアクセスキーの削除' },
  ],
  teardown: [
    { id: STAGE.teardownApp, label: 'アプリケーションの削除' },
    { id: STAGE.teardownLb, label: 'ロードバランサの削除' },
    { id: STAGE.teardownAsg, label: 'オートスケーリンググループの削除' },
    { id: STAGE.teardownCluster, label: 'クラスタの削除' },
    { id: STAGE.teardownStorage, label: '保存場所の削除' },
  ],
}

/** 全部の段（画面が目安を引くときの一覧）。 */
export const ALL_STAGES: readonly StageDef[] = [
  ...DEDICATED_STAGES.create, ...DEDICATED_STAGES.publish, ...DEDICATED_STAGES.teardown,
]

const LABELS: Readonly<Record<string, string>> = Object.fromEntries(ALL_STAGES.map(s => [s.id, s.label]))

/** 段の内部名の形（記録・IPC から来た値を信用しないための検査）。 */
export const STAGE_ID_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/

export function isStageIdShape(x: unknown): x is string {
  return typeof x === 'string' && STAGE_ID_PATTERN.test(x)
}

/** 画面に出す段の名前。表に無い（新しい版・古い版が記録した）段は、内部名のまま出す。 */
export function stageLabelOf(id: string): string {
  return LABELS[id] ?? id
}

// ── 段ごとの所要時間 ─────────────────────────────────────────────────────────

/** 結果に載せる1行（段の内部名と、かかった時間）。 */
export type StageTimingRow = { stage: string; ms: number }

/**
 * 段の切り替わりに添える印（各 flow の `onStage` の第2引数。定義はここ1か所）。
 *
 * `unmeasured: true` は、**その段の時間が「ふつうにやったらこれだけかかる」の測定になっていない**という印
 * （2026-10-07 検分の指摘）。時間は「かかった時間を見る」には出す（実際にかかった時間なので）が、**保存しない**
 * ——保存すると、この Mac の記録（最近5回の中央値）が開発時の実測を押しのけて、目安を誤らせる。印を付ける場面:
 *   ・IP が付かないまま待ち切った・取得に失敗した・最初の問い合わせで付いていて待たなかった（publish.lb-address）／応答を確かめられなかった（publish.verify・containers）
 *   ・古いバージョンの掃除や古いアクセスキーの削除が失敗した（publish.cleanup・key-cleanup）
 *   ・前回の続き（削除を受け付けたが待ち切れず、やり直したときの「残りの待ち」）・既に消えていた（teardown.*）
 *   ・コンテナが止まるのを待ち切れず、時間切れでそのまま進んだ（teardown.app）
 *   ・アプリがさくら側にすでに無かった（teardown.app。取得・無効化・削除がどれも 404 で、一覧にも無い）
 *   ・ASG・クラスタの削除を 409 で断られ、下位の一覧が空のまま反映されるのを待った（teardown.asg・teardown.cluster。反映のずれの待ち）
 *   ・アプリの削除の待ち直しの途中で、DELETE が 5xx・通信の切れになり、障害が直るのを待った（teardown.app）
 *   （付けない場面: アプリの削除を 400 で断られて、コンテナが止まるのを待ってやり直した回。待つのは削除にふつうに含まれる時間。
 *    上限まで待っても削除できなかった回は失敗なので、そもそも保存されない）
 * 印は段ごとに持つ（同じ段に何度か入って1回でも印が付けば、その段はその操作では保存しない。安全側）。
 */
export type StageMark = { unmeasured?: boolean }

/** 「この段の時間は測定になっていない」の印（定義はここ1か所。各 flow と IPC はこれを使う）。 */
export const UNMEASURED: StageMark = Object.freeze({ unmeasured: true })

/** 1回の操作の、段ごとの所要時間と合計（始まってから終わるまで）。 */
export type StageTimings = { totalMs: number; stages: StageTimingRow[] }

/** 段に入ってから出るまで（epoch ミリ秒）。同じ段に何度か入ったときは複数ある。 */
export type StageSegment = { stage: string; startedAt: number; endedAt: number }

const MAX_ROWS = 50
const MAX_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 段ごとの区間から、段ごとの所要時間と合計を作る（純関数）。
 * ・同じ段に何度か入ったときは足し合わせる（並びは最初に入った順）
 * ・区間が無ければ null（段を渡さなかった操作には、時間を出さない）
 * ・合計は操作の始まりから終わりまで（段の外の短い時間も含む）
 */
export function buildStageTimings(
  segments: readonly StageSegment[], startedAt: number, finishedAt: number,
): StageTimings | null {
  const order: string[] = []
  const sums = new Map<string, number>()
  for (const s of segments) {
    if (!isStageIdShape(s.stage)) continue
    const ms = Math.max(0, Math.round(s.endedAt - s.startedAt))
    if (!sums.has(s.stage)) { sums.set(s.stage, 0); order.push(s.stage) }
    sums.set(s.stage, (sums.get(s.stage) ?? 0) + ms)
  }
  if (order.length === 0) return null
  return {
    totalMs: Math.max(0, Math.round(finishedAt - startedAt)),
    stages: order.map(stage => ({ stage, ms: sums.get(stage) ?? 0 })),
  }
}

/**
 * 結果の extra（記録）や IPC の返り値から来た値を、画面が使える形にする（純関数）。
 * 形が合わないもの・負や巨大な値は捨てる。使える行が1つも無ければ null。
 */
export function readStageTimings(x: unknown): StageTimings | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null
  const raw = x as Record<string, unknown>
  if (!Array.isArray(raw.stages)) return null
  const stages: StageTimingRow[] = []
  for (const r of raw.stages.slice(0, MAX_ROWS)) {
    if (!r || typeof r !== 'object') continue
    const row = r as Record<string, unknown>
    if (!isStageIdShape(row.stage)) continue
    if (typeof row.ms !== 'number' || !Number.isFinite(row.ms) || row.ms < 0 || row.ms > MAX_MS) continue
    stages.push({ stage: row.stage, ms: Math.round(row.ms) })
  }
  if (stages.length === 0) return null
  const total = typeof raw.totalMs === 'number' && Number.isFinite(raw.totalMs) && raw.totalMs >= 0 && raw.totalMs <= MAX_MS
    ? Math.round(raw.totalMs)
    : stages.reduce((n, r) => n + r.ms, 0)
  return { totalMs: total, stages }
}

// ── 時間の文 ─────────────────────────────────────────────────────────────────

/**
 * かかった時間を「分と秒」で言う（純関数）。1秒未満は「1秒未満」、1分未満は「N秒」、
 * 1時間未満は「N分M秒」、それ以上は「N時間M分S秒」。**四捨五入で秒に丸める**。
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return '1秒未満'
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}時間${m}分${s}秒`
  if (m > 0) return `${m}分${s}秒`
  return `${s}秒`
}

/** 「かかった時間を見る」を開いたときに並べる行（純関数）。段の並びは通った順。 */
export type StageTimingView = {
  summary: string
  rows: { stage: string; label: string; text: string }[]
  total: { label: string; text: string }
}

/** 折りたたみの見出し（画面の言葉はここだけ）。 */
export const STAGE_TIMING_SUMMARY = 'かかった時間を見る'

export function stageTimingView(t: StageTimings): StageTimingView {
  return {
    summary: STAGE_TIMING_SUMMARY,
    rows: t.stages.map(r => ({ stage: r.stage, label: stageLabelOf(r.stage), text: formatDuration(r.ms) })),
    total: { label: '合計', text: formatDuration(t.totalMs) },
  }
}
