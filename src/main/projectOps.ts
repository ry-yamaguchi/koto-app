// projectOps.ts — プロジェクトごとの「いま走っている操作」と「終わった操作」の記録（メモリ上）。
//
// ── なぜ要るか（2026-09-29・作者の決定 (1)(2)）────────────────────────────────
// 公開・破棄・作成の本体は main の1回の IPC で最後まで進み、記録（.sakuraide.json）も main が書く。
// だから**処理中にダイアログを閉じても処理は止まらない**。失われていたのは**画面の表示だけ**——
// 進み具合・結果・警告（「保存場所が残ったので月額が続きます」など）は、窓が持っている React の状態にしか
// 無く、閉じて開き直すと消えた。「終わったのか」「うまくいったのか」「何が残ったのか」が分からない。
// そこで main が**プロジェクトごとの処理の記録**を持ち、画面は開き直したときにそれを読んで続きを出す。
//
// ── どこに置くか（掟10: 定義は1か所）────────────────────────────────────────
// 「同じプロジェクトで同時に走らせない」鍵（projectLock.ts）と**同じ記録**である。走っている記録が
// あること＝鍵が掛かっていること。だから鍵を取る `withProjectLock`（1か所）が、取った時に始まりを・
// 抜ける時に終わりを**自動で**書く。9本のハンドラ（共用型 2・HANAMII 2・Vercel 1・専有型 4）が
// **同じ道**で記録され、「一部のハンドラだけ配線した」が起きない。
// 進み具合も、各ハンドラが renderer へ送っていた進捗の送り口を `progressReporter` 1つに通し、
// そこで記録も更新する。
//
// ── 段ごとの所要時間（2026-10-07・作者の問い「どこにどれくらいの時間がかかっているか」）──────────────
// 進み具合の送り口に、任意の `stage`（段の**内部名**。shared/stageTiming.ts の STAGE）を渡せる。ハンドラが段の切り替わりで渡すと、
// ここが段ごとの開始・終了の時刻をメモリに持ち、操作が終わったとき**段ごとの所要時間と合計**を結果の
// `extra.stageTimings` に載せる（画面は「かかった時間を見る」に出す）。**画面に出す文は変えない**（段は文とは別に渡す）。
// うまくいった操作の、終わった段の所要時間だけは、main が Koto の保存領域へ追記する（`setStageTimingSink`・
// main/stageTimingStore.ts。ここはファイルに触らない）。**ただし「ふつうにやったらこれだけかかる」の測定になっていない段
// （flow が `unmeasured` の印を付けたもの。IP が付かなかった・前回の続きだった・既に消えていた…）は、時間は結果に載せても保存しない**
// （`ok:true` は「時間を測れた」の証拠ではない）。**段を渡さないハンドラは、これまでどおり**（時間は載らない・保存しない）。
//
// ── 持たないもの ────────────────────────────────────────────────────────────
// ・**ファイルには書かない。** Koto を終了すると処理も止まる（main の1 invoke は窓では止まらないが、
//   プロセスが終われば止まる）ので、終了をまたいで「走っている」を持ち越す意味が無い
//   （持ち越すと、止まった処理を「走っている」と言い続ける）。
//   （例外は段の所要時間の保存だけ。上の sink を通って main の別の部品〔stageTimingStore.ts〕が書く。ここは書かない。）
// ・**秘密を入れない（掟4）。** 引数のトークン・キーは記録しない。結果は**許可した項目だけ**を写し
//   （下の EXTRA_KEYS）、文字列は必ず `scrub` を通す（呼び出し側が渡した秘密の完全一致＋
//   `redactSecrets` の形による除去）。秘密っぽい名前のキーは値ごと落とす。
// ・**別のプロジェクトの記録を混ぜない（掟11）。** すべて projectDir を正規化した鍵で分ける。

import * as path from 'path'
import { redactSecrets } from '../shared/updateLog'
import { teardownRemainingWarnings } from '../shared/cloudCost'
// ⚠️・※ で始まる行は「知らせ」として warnings へ移す（各ハンドラが executed の中で使っている印）。
// 印の定義は shared/opsText.ts の1か所（画面が「⚠️」を付け足すかの判断も同じ定義を使う）。
import { hasWarnMark } from '../shared/opsText'
import type { PublishTargetKind } from '../shared/publishMeta'
import { buildStageTimings, isStageIdShape, type StageMark, type StageTimings, type StageTimingRow } from '../shared/stageTiming'

/** いま走っている操作（画面に出す日本語そのもの）。 */
export type ProjectOp = '作成' | '削除' | '公開'

/**
 * どの公開先の操作か。`PublishTargetKind` と同じ値。
 * 'unknown' は鍵を取るときに meta を渡さなかった呼び出し（テストだけ）。Koto 本体の9本はすべて渡す。
 */
export type OpTarget = PublishTargetKind | 'unknown'

/** 鍵を取るとき呼び出し側が渡す、記録のための情報。 */
export type OpMeta = {
  /** どの公開先か。 */
  target: OpTarget
  /** どの IPC か（'cloud:apply' など）。同じ「削除」でも作成・公開と見分けるのに使う（専有型は手順6も📡の🗑も同じ apprunDedicated:teardown）。 */
  handler: string
  /**
   * この操作が引数で受け取った秘密（トークン・キー）。**記録に載る文字列から完全一致で伏せる。**
   * 記録には入れない（ここで渡すだけ）。
   */
  secrets?: ReadonlyArray<string | null | undefined>
  /**
   * この操作のゾーン（分かるとき）。段の所要時間を保存するとき、日付・Koto の版と一緒に記録する（目安はゾーンで分けない）。
   * 画面の記録（ProjectOpRecord）には入れない。
   */
  zone?: string | null
}

export type OpProgress = {
  /** いまやっていること（画面にそのまま出せる1文。各ハンドラが renderer へ送っている進捗と同じ文）。 */
  label: string
  /** 補足（経過時間・状態など）。無ければ空文字。 */
  detail: string
  /** 何個中の何個目か（分かるときだけ）。 */
  step?: number
  total?: number
  /** 更新した時刻（epoch ミリ秒）。 */
  at: number
  /**
   * いまの段の内部名（段を渡したハンドラだけ。shared/stageTiming.ts の STAGE）。画面は**文ではなくこれ**で
   * 「いま待っている段」を見分け、その段の目安を出す。
   */
  stage?: string
}

export type OpResult = {
  /** うまくいったか。 */
  ok: boolean
  /** 画面にそのまま出せる本文（失敗の理由・結果の一言）。 */
  message?: string
  /** 折りたたみで出す詳細（診断用）。 */
  detail?: string
  /** 公開した URL。 */
  url?: string
  /** 起きたことの一覧（各ハンドラの executed。⚠️・※ で始まる行は下の warnings へ移してある）。 */
  lines: string[]
  /**
   * **見逃してはいけない知らせ**（月額が続く・データが消える・まだ動いていない・確かめていない…）。
   * 画面にそのまま出せる文。返り値のうち文として持っていたもの（warnings・notice・⚠️ の行）と、
   * 返り値の事実から組み立てたもの（残った保存場所・残ったもの）をここに集めてある。
   */
  warnings: string[]
  /** 操作ごとの追加の材料（許可した項目だけ。秘密は入らない）。 */
  extra: Record<string, unknown>
}

export type ProjectOpRecord = {
  op: ProjectOp
  target: OpTarget
  handler: string
  /**
   * 始まった時刻（epoch ミリ秒）。**同じ記録の識別子も兼ねる**（同じプロジェクトでは必ず増える）。
   * `ackOps` の第2引数に使う。
   */
  startedAt: number
  running: boolean
  progress: OpProgress
  finishedAt?: number
  result?: OpResult
  /** 画面が結果を見たか。`ackOps` で true になる（true になった記録は `last` から消える）。 */
  seen: boolean
}

export type ProjectOpsSnapshot = {
  /** いま走っている操作。無ければ null。 */
  running: ProjectOpRecord | null
  /** 終わった直近の1件のうち、まだ画面が見ていないもの。無ければ null。 */
  last: ProjectOpRecord | null
  /**
   * `last` より前に終わって、まだ見られていないもの（古い順）。
   * 結果を見ないうちに次の操作が終わったとき、前の警告を**上書きで見逃さない**ための口。
   */
  earlier: ProjectOpRecord[]
}

// ── 記録の保管 ────────────────────────────────────────────────────────────

/** 段に入ってから出るまで。`endedAt` が無いものが「いまの段」。 */
type OpenSegment = { stage: string; startedAt: number; endedAt?: number }
type Live = {
  record: ProjectOpRecord; secrets: string[]; zone: string | null; segments: OpenSegment[]
  /** 時間は結果に載せるが、保存はしない段（`StageMark.unmeasured`。理由は shared/stageTiming.ts）。 */
  unmeasured: Set<string>
}

/** projectDir（正規化）→ いま走っている操作。**これが鍵そのもの**（1つ入っていれば、そのプロジェクトは使用中）。 */
const live = new Map<string, Live>()
/** projectDir（正規化）→ 終わったがまだ見られていない記録（古い順）。 */
const unseen = new Map<string, ProjectOpRecord[]>()
/**
 * 見られていない記録を持つ上限（超えたら捨てる。捨てる順は `capUnseen`）。
 * **警告つき・うまくいかなかった記録は、警告の無い成功の記録より後まで残す**（2026-09-30 検分）。
 */
const MAX_UNSEEN = 5
let lastStartedAt = 0
let listener: ((projectDir: string, snapshot: ProjectOpsSnapshot) => void) | null = null

/** うまくいった操作が終わったとき、段の所要時間を渡す先（1つだけ）。 */
export type StageTimingSinkEntry = {
  op: ProjectOp
  target: OpTarget
  handler: string
  /** 終わった時刻（epoch ミリ秒）。 */
  finishedAt: number
  zone: string | null
  stages: StageTimingRow[]
}
let stageSink: ((entry: StageTimingSinkEntry) => void) | null = null

/**
 * 段の所要時間を保存する口を1つだけ持つ（ipc/stageTiming.ts が main/stageTimingStore.ts へ配線する）。null で外す。
 * **呼ばれるのは、うまくいった（ok:true の）操作で、保存してよい段が1つ以上あるときだけ**。失敗した操作は保存しない。
 * 渡す段からは、flow が `unmeasured` の印を付けた段（IP が付かなかった・前回の続きだった・既に消えていた…。shared/stageTiming.ts の
 * `StageMark`）を除く。
 */
export function setStageTimingSink(fn: ((entry: StageTimingSinkEntry) => void) | null): void {
  stageSink = fn
}

/**
 * 同じフォルダを指す別の書き方（末尾の `/`・`..`）を同じ鍵にする。
 * 空・文字列以外はそのまま返す（呼び出し側の入力検査に任せる）。
 */
export function keyOf(projectDir: string): string {
  return typeof projectDir === 'string' && projectDir ? path.resolve(projectDir) : projectDir
}

/**
 * 記録が変わるたび呼ばれる口を1つだけ持つ（main → renderer の押し出し。ipc/projectOps.ts が登録する）。
 * `projectDir` は**正規化した形**。null で外す。
 */
export function setProjectOpsListener(fn: ((projectDir: string, snapshot: ProjectOpsSnapshot) => void) | null): void {
  listener = fn
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T
}

function snapshotOf(key: string): ProjectOpsSnapshot {
  const list = unseen.get(key) ?? []
  const running = live.get(key)?.record ?? null
  return clone({
    running,
    last: list.length > 0 ? list[list.length - 1] : null,
    earlier: list.slice(0, -1),
  })
}

function notify(key: string): void {
  if (!listener) return
  try { listener(key, snapshotOf(key)) } catch { /* 押し出しの失敗で操作を止めない */ }
}

/** いま走っている操作の名前（走っていなければ undefined）。`projectLock.runningOp` の答え。 */
export function runningOpName(projectDir: string): ProjectOp | undefined {
  return live.get(keyOf(projectDir))?.record.op
}

/** いま走っている操作 1 件の写し（終了の確認が読む。quitGuard.ts）。 */
export type RunningOpInfo = {
  /** 正規化した projectDir（`keyOf` の形）。 */
  projectDir: string
  op: ProjectOp
  target: OpTarget
}

/**
 * いま main の中で走っている操作の一覧（開始順）。**メモリの記録を読むだけで、何も書かない。**
 *
 * なぜ要るか（2026-10-10・0.6.21-rc.1 の実機）: Koto を終了すると処理は途中で止まる。終了の前に聞く判断は、
 * 以前は画面が `win:busy` で登録した印だけを見ていた。その印は、(1)「ウィンドウを閉じる」で消え、
 * (2) 開き直したウィンドウでは、その処理を映す画面を開くまで誰も登録せず、(3) ウィンドウが無いときの ⌘Q は
 * そもそもウィンドウの close を通らない——どの道でも、**main では処理が走っているのに警告なしで終了できた**。
 * 画面の登録を当てにせず、「走っているか」の正（鍵と同じ記録）を直接読む。
 */
export function listRunningOps(): RunningOpInfo[] {
  const out: RunningOpInfo[] = []
  for (const [projectDir, entry] of live) {
    out.push({ projectDir, op: entry.record.op, target: entry.record.target })
  }
  return out
}

/** 画面が読む答え（写し）。走っているもの・まだ見られていない結果。 */
export function getOps(projectDir: string): ProjectOpsSnapshot {
  return snapshotOf(keyOf(projectDir))
}

/**
 * 結果を見たと伝える。`upToStartedAt` を渡すと、**その記録まで**（startedAt がそれ以下）だけ見たことにする
 * ——画面が結果を見せている間に次の操作が終わったとき、**見ていない結果まで消さない**ため。
 * 省略すると、いま見られていない記録すべて。戻り値は見たことにした件数。
 */
export function ackOps(projectDir: string, upToStartedAt?: number): number {
  const key = keyOf(projectDir)
  const list = unseen.get(key) ?? []
  const keep = typeof upToStartedAt === 'number' && Number.isFinite(upToStartedAt)
    ? list.filter(r => r.startedAt > upToStartedAt)
    : []
  const acked = list.length - keep.length
  if (acked === 0) return 0
  for (const r of list) if (!keep.includes(r)) r.seen = true
  if (keep.length > 0) unseen.set(key, keep)
  else unseen.delete(key)
  notify(key)
  return acked
}

/** 鍵を取ったとき（withProjectLock）だけ呼ぶ。**すでに走っているかの確認は呼び出し側**。 */
export function beginOp(projectDir: string, op: ProjectOp, meta: OpMeta | undefined): void {
  const key = keyOf(projectDir)
  const now = Date.now()
  lastStartedAt = Math.max(now, lastStartedAt + 1)
  const secrets = (meta?.secrets ?? []).filter((s): s is string => typeof s === 'string' && s.length >= MIN_SECRET_LENGTH)
  live.set(key, {
    secrets,
    zone: typeof meta?.zone === 'string' && meta.zone ? meta.zone : null,
    segments: [],
    unmeasured: new Set<string>(),
    record: {
      op,
      target: meta?.target ?? 'unknown',
      handler: meta?.handler ?? '',
      startedAt: lastStartedAt,
      running: true,
      progress: { label: `${op}を始めています…`, detail: '', at: lastStartedAt },
      seen: false,
    },
  })
  notify(key)
}

/** 進み具合に添えるもの。`stage` は段の内部名（shared/stageTiming.ts の STAGE）。 */
export type ProgressExtra = { detail?: string; step?: number; total?: number; stage?: string }

/** いまの段（入っていて、まだ出ていない区間）。 */
function openSegment(entry: Live): OpenSegment | null {
  const last = entry.segments[entry.segments.length - 1]
  return last && last.endedAt === undefined ? last : null
}

/**
 * 段を切り替える（同じ段のままなら何もしない）。いまの段を閉じ、新しい段を開く。
 * **形の合わない名前は無視する**（記録に変な文字列を入れない）。戻り値は切り替えたか。
 */
function switchStage(entry: Live, stage: string, now: number): boolean {
  if (!isStageIdShape(stage)) return false
  const cur = openSegment(entry)
  if (cur?.stage === stage) return false
  if (cur) cur.endedAt = Math.max(now, cur.startedAt)
  entry.segments.push({ stage, startedAt: now })
  return true
}

/**
 * 進み具合を更新する。走っていなければ何もしない（鍵の外から呼ばれても、別の操作の記録を汚さない）。
 * ハンドラは直接これを呼ばず、`progressReporter` を通す。
 * `extra.stage` を渡すと、その段へ切り替わった時刻を記録する（文はこれまでどおり）。渡さなければ、いまの段のまま。
 */
export function reportProgress(
  projectDir: string, message: string, extra?: ProgressExtra,
): void {
  const key = keyOf(projectDir)
  const entry = live.get(key)
  if (!entry) return
  const now = Math.max(Date.now(), entry.record.startedAt)
  if (typeof extra?.stage === 'string') switchStage(entry, extra.stage, now)
  const cur = openSegment(entry)
  const progress: OpProgress = {
    label: scrub(message, entry.secrets),
    detail: extra?.detail ? scrub(extra.detail, entry.secrets) : '',
    at: now,
    ...(cur ? { stage: cur.stage } : {}),
  }
  if (Number.isFinite(extra?.step) && Number.isFinite(extra?.total) && (extra!.total as number) >= 1) {
    progress.step = extra!.step
    progress.total = extra!.total
  }
  entry.record.progress = progress
  notify(key)
}

/**
 * 段だけを切り替える（**画面に出す文は変えない**）。文を出さない段の切り替わり（待ちの前・API を順に呼ぶ区切り）に使う。
 * 走っていなければ何もしない。同じ段のままなら何もしない（通知も出さない）。
 * `mark.unmeasured` を渡すと、その段は**時間を結果に載せるが保存しない**（印は段の切り替えとは別に効く＝同じ段のままでも付く。
 * 理由と付ける場面は shared/stageTiming.ts の `StageMark`）。
 */
export function reportStage(projectDir: string, stage: string, mark?: StageMark): void {
  const key = keyOf(projectDir)
  const entry = live.get(key)
  if (!entry) return
  const now = Math.max(Date.now(), entry.record.startedAt)
  if (mark?.unmeasured === true && isStageIdShape(stage)) entry.unmeasured.add(stage)
  if (!switchStage(entry, stage, now)) return
  entry.record.progress = { ...entry.record.progress, stage }
  notify(key)
}

/**
 * 進捗の送り口（**各ハンドラの進捗はこの1つを通す**）。
 * 記録を更新し、`send` があればこれまでどおり renderer へも送る（ウィンドウが閉じていても落ちない）。
 * **送るのは文だけ**（段の内部名は画面へ送らない。画面は記録の progress.stage から読む）。
 */
export function progressReporter(
  projectDir: string, send?: (message: string) => void,
): (message: string, extra?: ProgressExtra) => void {
  return (message, extra) => {
    reportProgress(projectDir, message, extra)
    if (send) {
      try { send(message) } catch { /* ウィンドウ破棄時は無視 */ }
    }
  }
}

/** 段の切り替わりだけを記録する送り口（`reportStage` の束ね）。各 flow の `onStage` に渡す。 */
export function stageReporter(projectDir: string): (stage: string, mark?: StageMark) => void {
  return (stage, mark) => reportStage(projectDir, stage, mark)
}

/**
 * 鍵を手放すとき（withProjectLock の finally）だけ呼ぶ。**必ず先に鍵を外す**——記録の組み立てで
 * 何が起きても「二度と押せない」を作らない。
 */
export function finishOp(projectDir: string, outcome: { value: unknown } | { error: unknown }): StageTimings | undefined {
  const key = keyOf(projectDir)
  const entry = live.get(key)
  if (!entry) return undefined
  live.delete(key)
  const rec = entry.record
  rec.running = false
  // startedAt は同じ時刻に始まった操作でも増やしてある（識別子を兼ねる）ので、終わりがそれより前にならないよう揃える。
  const finishedAt = Math.max(Date.now(), rec.startedAt)
  rec.finishedAt = finishedAt
  rec.seen = false
  try {
    rec.result = 'value' in outcome
      ? summarizeResult(outcome.value, entry.secrets)
      : failedResult(outcome.error, entry.secrets)
  } catch {
    rec.result = { ok: false, message: '結果を記録できませんでした', lines: [], warnings: [], extra: {} }
  }
  // 段ごとの所要時間（段を渡したハンドラだけ）。いまの段は、ここで閉じる。結果の extra へ載せる。
  let timings: StageTimings | undefined
  try {
    const cur = openSegment(entry)
    if (cur) cur.endedAt = Math.max(finishedAt, cur.startedAt)
    const built = buildStageTimings(
      entry.segments.map(s => ({ stage: s.stage, startedAt: s.startedAt, endedAt: s.endedAt ?? finishedAt })),
      rec.startedAt, finishedAt,
    )
    if (built) { timings = built; rec.result.extra.stageTimings = built }
  } catch { /* 時間の計算で結果を落とさない */ }
  unseen.set(key, capUnseen([...(unseen.get(key) ?? []), rec]))
  notify(key)
  // うまくいった操作の、終わった段の所要時間だけを保存する（失敗した回は目安に混ぜない）。
  // **`ok:true` は「時間を測れた」の証拠ではない**（2026-10-07 検分）: IP が付かないまま待ち切った・応答を確かめられなかった・
  // 前回の続きで残りだけ待った・既に消えていた…でも ok:true で終わる。そうした段は flow が `unmeasured` の印を付けて
  // おり、**その段だけ**保存から外す（同じ操作のほかの段は保存する）。時間そのものは結果に載せたまま。
  if (timings && rec.result?.ok === true && stageSink) {
    const measured = timings.stages.filter(r => !entry.unmeasured.has(r.stage)).map(r => ({ stage: r.stage, ms: r.ms }))
    if (measured.length > 0) {
      try {
        stageSink({
          op: rec.op, target: rec.target, handler: rec.handler, finishedAt, zone: entry.zone,
          stages: measured,
        })
      } catch { /* 保存の失敗で操作の結果を変えない */ }
    }
  }
  return timings
}

/** 警告も失敗も無い、ただの成功の記録か（上限で押し出すとき、真っ先に捨ててよいもの）。 */
function isPlainSuccess(rec: ProjectOpRecord): boolean {
  return rec.result?.ok === true && (rec.result.warnings?.length ?? 0) === 0
}

/**
 * 見られていない記録が `MAX_UNSEEN` を超えたとき、**どれを捨てるか**（古い順に並んだ一覧を受け取り、上限以内にして返す。純関数）。
 *
 * 単純に古いものから捨てると、利用者がまだ「確認しました」を押していない警告（月額が続く・まだ動いていない…）が、
 * その後に別の公開先の操作が何度か終わっただけで、main から黙って消える（記録を読んで出す画面は、消えた警告を
 * 二度と出せない）。だから:
 *   (1) 新しく足した記録（末尾）は捨てない——いま終わった操作の結果を、その画面が読めなくなるため
 *   (2) それ以外のうち、**警告も失敗も無い成功の記録**を、古いものから先に捨てる
 *   (3) (2)が無いとき（全部が警告つき・失敗）だけ、いちばん古いものを捨てる（無限に溜めない）
 */
export function capUnseen(list: readonly ProjectOpRecord[]): ProjectOpRecord[] {
  const out = [...list]
  while (out.length > MAX_UNSEEN) {
    const older = out.slice(0, -1)
    const i = older.findIndex(isPlainSuccess)
    out.splice(i >= 0 ? i : 0, 1)
  }
  return out
}

/** テスト用: 記録をすべて空にする。 */
export function resetProjectOpsForTests(): void {
  live.clear()
  unseen.clear()
  listener = null
  stageSink = null
  lastStartedAt = 0
}

// ── 結果の写し（画面に出すものだけ・秘密は入れない）────────────────────────

/** これより短い秘密は伏せない（短い文字列を全置換すると、文がめちゃくちゃになる）。 */
const MIN_SECRET_LENGTH = 6
const MAX_TEXT = 4000

/**
 * 文字列から秘密を伏せる。(1)呼び出し側が渡した秘密の**完全一致** (2)`redactSecrets` の形（トークン・鍵・
 * URL の資格情報など）。長すぎるものは切る。
 */
export function scrub(text: string, secrets: readonly string[] = []): string {
  let t = String(text ?? '')
  for (const s of secrets) if (s.length >= MIN_SECRET_LENGTH) t = t.split(s).join('***')
  t = redactSecrets(t)
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}…` : t
}

/** 値ごと落とす名前（秘密の入れ物になりうるもの）。 */
const SECRET_KEY_NAME = /token|secret|password|passwd|api[-_]?key|access[-_]?key|authorization|credential/i

/** 数・真偽・文字列・それらの配列／小さな入れ子だけを写す（関数・巨大なもの・深すぎるものは落とす）。 */
function cleanValue(x: unknown, secrets: readonly string[], depth = 0): unknown {
  if (x === null) return null
  if (typeof x === 'string') return scrub(x, secrets)
  if (typeof x === 'number') return Number.isFinite(x) ? x : null
  if (typeof x === 'boolean') return x
  if (depth >= 3) return undefined
  if (Array.isArray(x)) {
    return x.slice(0, 100).map(v => cleanValue(v, secrets, depth + 1)).filter(v => v !== undefined)
  }
  if (typeof x === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(x as Record<string, unknown>).slice(0, 40)) {
      if (SECRET_KEY_NAME.test(k)) continue
      const c = cleanValue(v, secrets, depth + 1)
      if (c !== undefined) out[k] = c
    }
    return out
  }
  return undefined
}

/**
 * 結果の `extra` に写してよい項目（各ハンドラの返り値の、画面が判断に使う材料）。**ここに無い名前は写さない**
 * ——返り値に新しい項目が足されても、確かめずに記録へ流れ込まない（許可リスト方式）。
 * `storagePermissionId` は入れない（鍵の識別子であり、画面に出す理由が無い）。
 * `stageTimings`（段ごとの所要時間）もここには入れない——返り値から写すものではなく、**projectOps 自身が測って**
 * `finishOp` が載せる（返り値に同名の項目があっても写さない。測っていないものを記録に載せない）。
 */
const EXTRA_KEYS = [
  'stage', 'hint', 'pending', 'logUrl', 'askAi',
  'needsScaleDecision', 'adoptedScaleMin', 'staleImages', 'skipped',
  'keptBucketName', 'keptBucketNames', 'keptRegistryName', 'keptRegistryUnnamed',
  'remaining', 'inProgress', 'appDeleted', 'remainingBucket', 'remainingBuckets',
  'projectId', 'deploymentId', 'deployState', 'readyState', 'errorCode',
  'applicationID', 'version', 'lbAddresses', 'verify', 'containerStates',
  'clusterID', 'asgID', 'loadBalancerID',
] as const

const asStr = (x: unknown): string => (typeof x === 'string' ? x : '')
const asStrList = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string' && v !== '') : [])

/** 専有型の「消せずに残ったもの」を、画面の文に並べる（アプリ→ロードバランサ→ASG→クラスタ→保存場所の順）。 */
function remainingNames(remaining: Record<string, unknown>): string[] {
  const names: string[] = []
  if (asStr(remaining.applicationID)) names.push(`アプリケーション『${asStr(remaining.applicationID)}』`)
  if (asStr(remaining.loadBalancerID)) names.push(`ロードバランサ『${asStr(remaining.loadBalancerID)}』`)
  if (asStr(remaining.asgID)) names.push(`オートスケーリンググループ『${asStr(remaining.asgID)}』`)
  if (asStr(remaining.clusterID)) names.push(`クラスタ『${asStr(remaining.clusterID)}』`)
  if (asStr(remaining.storageBucket)) names.push(`保存場所『${asStr(remaining.storageBucket)}』（月額が続きます）`)
  return names
}

/**
 * 各ハンドラの返り値を、画面に出す形にする（純関数）。
 *
 * **ここで新しい判断を足さない。** 警告に変えるのは、返り値が**すでに持っている事実**だけ:
 *   ・`warnings`（文の配列）・`notice`（文）・executed／verifyNote の ⚠️・※ で始まる行
 *   ・`keptBucketName`（複数なら `keptBucketNames`）／`keptRegistryName`／`keptRegistryUnnamed`（破棄したのに残った）→ `teardownRemainingWarnings`（cloudCost.ts・画面の破棄の結果と同じ関数）
 *   ・`remaining`（消せずに残ったID）→ 専有型の画面が出している文と同じ言い方
 *   ・`inProgress`（削除を受け付けたが待ち切れなかった）
 * 「まだ動いていない」（HANAMII）は、各ハンドラが `warnings` に文で入れて返す。
 */
export function summarizeResult(value: unknown, secrets: readonly string[] = []): OpResult {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const s = (t: string) => scrub(t, secrets)
  const lines: string[] = []
  const warnings: string[] = []
  const addWarning = (t: string) => { const w = s(t); if (w && !warnings.includes(w)) warnings.push(w) }
  const addLine = (t: string) => { if (hasWarnMark(t)) addWarning(t); else lines.push(s(t)) }

  for (const t of asStrList(v.executed)) addLine(t)
  if (asStr(v.verifyNote)) addLine(asStr(v.verifyNote))
  for (const t of asStrList(v.warnings)) addWarning(t)
  if (asStr(v.notice)) addWarning(asStr(v.notice))

  // 破棄したのに残った（共用型）。残ったなら課金も続く。文は画面と同じ関数（cloudCost.ts）で作る。
  // 画面の破棄の結果（AppRunPanel）も、**同じこの事実から同じ関数で**警告を作る（その場と開き直しで食い違わない）。
  // 名前が記録に無いレジストリ（keptRegistryUnnamed）も、名前なしで「残る」と言う。
  // HANAMII・専有型の破棄も同じ事実で返す（keptBucketName＋複数のときの keptBucketNames）。利用者のファイルがあって
  // バケットごと消さなかった回は、executed に「保存場所『X』を片づけました — …残します（月額の課金は続きます）」と
  // 入るだけで ⚠️ が付かず、警告の枠にならない（共用型と扱いが食い違う）ので、事実として返してここで警告にする。
  const keptBucket = asStr(v.keptBucketName)
  const keptBuckets = asStrList(v.keptBucketNames)
  const keptRegistry = asStr(v.keptRegistryName)
  const keptRegistryUnnamed = v.keptRegistryUnnamed === true
  for (const w of teardownRemainingWarnings({ keptBucketName: keptBucket, keptBucketNames: keptBuckets, keptRegistryName: keptRegistry, keptRegistryUnnamed })) addWarning(w)

  // 専有型の破棄: 待ち切れなかった／消せずに残った。
  const inProgress = v.inProgress && typeof v.inProgress === 'object' ? v.inProgress as Record<string, unknown> : null
  if (inProgress) {
    addWarning('削除の途中で、待ち切れずに止まりました。しばらくしてから、もう一度削除を実行してください（記録は残してあるので、続きから進みます）。')
  } else if (v.ok !== true && v.remaining && typeof v.remaining === 'object') {
    const names = remainingNames(v.remaining as Record<string, unknown>)
    if (names.length > 0) {
      addWarning(`削除できずに残っているものがあります。残っている間は課金が続きます。コントロールパネルから直接削除することもできます: ${names.join('・')}`)
    }
  }

  const extra: Record<string, unknown> = {}
  for (const k of EXTRA_KEYS) {
    if (!(k in v)) continue
    const c = cleanValue(v[k], secrets)
    if (c !== undefined) extra[k] = c
  }

  const result: OpResult = {
    // HANAMII: 公開の依頼は受け付けられたが、新しい版が起動に失敗した（deployState:'error'）ときは、
    // IPC の ok は「依頼は受け付けた」の意味で true のまま返すので、ここで「うまくいっていない」に直す。
    ok: v.ok === true && v.deployState !== 'error',
    lines,
    warnings,
    extra,
  }
  if (asStr(v.message)) result.message = s(asStr(v.message))
  if (asStr(v.detail)) result.detail = s(asStr(v.detail))
  if (asStr(v.url)) result.url = s(asStr(v.url))
  return result
}

/** 例外で終わったとき（IPC 自体は例外を投げ続ける）。何が起きたかを、秘密を伏せて残す。 */
function failedResult(error: unknown, secrets: readonly string[]): OpResult {
  const msg = error instanceof Error ? error.message : String(error)
  return { ok: false, message: scrub(`予期しない失敗で止まりました: ${msg}`, secrets), lines: [], warnings: [], extra: {} }
}
