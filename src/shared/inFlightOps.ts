// inFlightOps.ts — 「途中で止まった回」の記録（userData の in-flight-ops.json）の形・整え方・時間・文。設計書 10.13。
//
// ── なぜ要るか（2026-10-10・0.6.21-rc.1 の実機での作者の依頼）──────────────────────────────
// 専有型の削除の途中で Koto が終了して止まり、押し直して最後まで消したとき、「かかった時間を見る」は押し直した回の
// 分しか出さなかった（処理の記録はメモリだけで、終了で消えるため）。止まった回の段の時刻を userData に残し、
// 次に同じ削除が終わったとき、止まった回の段と時間も並べて出す。止まったことのお知らせにも使う。
//
// ── ここに置くもの（純関数・テスト対象。掟10: 定義は1か所）─────────────────────────────────
// ・ファイルの中身の形と、読んだ値の整え方（`sanitizeInFlightFile`）
// ・起動したときに、走っていた記録を「止まった回」へ移し、要らないものを捨てる決まり（`adoptAtStartup`）
// ・止まった回の段ごとの時間（`stoppedRunTimings`）
// ・「Koto の終了で止まりました」の判定と文（`isStoppedByQuit`・`stoppedNextStep`・`stoppedWhenText`）
// ファイルの読み書きは main の別の部品（inFlightOpsStore.ts）、記録は main/projectOps.ts。
//
// ── 入れないもの（掟4）──────────────────────────────────────────────────────────────────
// 進み具合の文・結果・メッセージ・URL・資源の ID・ゾーン・認証・秘密は**1つも入れない**。入れるのは決まった語（種類・公開先・
// ハンドラ名・版）と数（時刻）と段の内部名だけ。整える側（`sanitizeInFlightFile`）も、この形に合わないものは捨てる。
//
// ⚠️ node の path/fs/electron は import しない（画面からも import される shared。tests/appChatDirs.test.ts と
// tests/inFlightOpsWiring.test.ts が固定する）。そのため、鍵（プロジェクトの絶対パス）は `path` で正規化せず、
// 形（`/` で始まる・4096文字以下・NUL を含まない）だけを確かめる。正規化した鍵を作るのは main の `keyOf`。
import { clockText } from './opsText'
import type { PublishTargetKind } from './publishMeta'
import { isEpochMs, isStageIdShape, MAX_EARLIER_RUNS, type StageTimingRow, type StoppedEndedBy, type StoppedRunTimings } from './stageTiming'

export type InFlightOp = '作成' | '削除' | '公開'
export type InFlightTarget = PublishTargetKind | 'unknown'

/** 段の区間（段の内部名と時刻だけ）。`endedAt` が無いものが、そのとき入っていた段。 */
export type InFlightSegment = { stage: string; startedAt: number; endedAt?: number }

export type InFlightRun = {
  op: InFlightOp
  target: InFlightTarget
  /** 'apprunDedicated:teardown' など。 */
  handler: string
  /** その回の Koto の版（取れなければ ''）。 */
  version: string
  /** 処理の記録の startedAt（同じ回の識別子）。 */
  startedAt: number
  /** 最後に分かった時刻。 */
  lastSeenAt: number
  segments: InFlightSegment[]
}

/** 止まった回。'quit'＝Koto の終了で途中で止まった／'unfinished'＝待ち切れず、続きから進める形で終わった。 */
export type StoppedRun = InFlightRun & { endedBy: StoppedEndedBy }

export type StoppedEntry = {
  op: InFlightOp
  target: InFlightTarget
  handler: string
  /** 古い順・3回まで。 */
  runs: StoppedRun[]
  /** 「止まりました」の知らせを、画面が見たか。 */
  noticeSeen: boolean
}

export type InFlightFile = { v: 1; running: Record<string, InFlightRun>; stopped: Record<string, StoppedEntry> }

export const MAX_STOPPED_ENTRIES = 20
export const MAX_RUNNING_ENTRIES = 100
export const MAX_SEGMENTS = 50
export const MAX_TEXT_LENGTH = 64
export const MAX_KEY_LENGTH = 4096
/** 止まった回を持つ日数（いちばん新しい回の最後に分かった時刻から）。 */
export const STOPPED_KEEP_MS = 30 * 24 * 60 * 60 * 1000
/** 最後に分かった時刻が今よりこれ以上先なら、時計のずれとして捨てる。 */
export const CLOCK_SKEW_MS = 5 * 60 * 1000

/**
 * 止まった回を、種類ごとに持つか捨てるか（起動時に**最初に**当てる＝公開・作成の止まった回が、止まった削除を置き換えない）。
 * 削除＝持つ（知らせ・時間を合わせる）／作成＝捨てる（作られた分は手順5・6の節が記録から出す）／
 * 公開＝捨てる（`publish.pending` の知らせがある）。判断 C・D（設計書 10.15）。
 */
export const STOPPED_OP_POLICY: Readonly<Record<InFlightOp, 'keep' | 'drop'>> = { 削除: 'keep', 作成: 'drop', 公開: 'drop' }

export function emptyInFlightFile(): InFlightFile {
  return { v: 1, running: {}, stopped: {} }
}

// ── 読んだ値の整え方 ─────────────────────────────────────────────────────────

const OPS: readonly string[] = ['作成', '削除', '公開']
/** 公開先の一覧。`PublishTargetKind` が増えたら、ここに足さないと型エラーになる（Record は全キーを要求する）。 */
const TARGETS: Readonly<Record<InFlightTarget, true>> = {
  hanamii: true, 'sakura-apprun': true, 'sakura-apprun-dedicated': true, 'sakura-rental': true, vercel: true, unknown: true,
}
const HANDLER_SHAPE = /^[A-Za-z0-9:_.-]*$/
const VERSION_SHAPE = /^[A-Za-z0-9.+_-]*$/

/** 鍵（プロジェクトの絶対パス）の形。Koto は macOS 専用なので `/` で始まる。**切らない**（切ると別のプロジェクトと同じ鍵になりうる）。 */
export function isInFlightKey(k: unknown): k is string {
  return typeof k === 'string' && k.startsWith('/') && k.length <= MAX_KEY_LENGTH && !k.includes('\0')
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x)
}

function readSegments(x: unknown): InFlightSegment[] {
  if (!Array.isArray(x)) return []
  const out: InFlightSegment[] = []
  for (const s of x) {
    if (!isRecord(s) || !isStageIdShape(s.stage) || !isEpochMs(s.startedAt)) continue
    if (s.endedAt !== undefined && !isEpochMs(s.endedAt)) continue
    out.push(s.endedAt === undefined
      ? { stage: s.stage, startedAt: Math.round(s.startedAt) }
      : { stage: s.stage, startedAt: Math.round(s.startedAt), endedAt: Math.round(s.endedAt) })
  }
  return out.slice(-MAX_SEGMENTS)
}

/** 種類・公開先・ハンドラ名（回にも項目にも付いている決まった語）。形が違えば null。 */
function readHead(x: Record<string, unknown>): Pick<InFlightRun, 'op' | 'target' | 'handler'> | null {
  if (typeof x.op !== 'string' || !OPS.includes(x.op)) return null
  if (typeof x.target !== 'string' || !Object.prototype.hasOwnProperty.call(TARGETS, x.target)) return null
  if (typeof x.handler !== 'string') return null
  const handler = x.handler.slice(0, MAX_TEXT_LENGTH)
  if (!HANDLER_SHAPE.test(handler)) return null
  return { op: x.op as InFlightOp, target: x.target as InFlightTarget, handler }
}

function readRun(x: unknown): InFlightRun | null {
  if (!isRecord(x)) return null
  const head = readHead(x)
  if (!head || !isEpochMs(x.startedAt) || !isEpochMs(x.lastSeenAt)) return null
  const version = typeof x.version === 'string' ? x.version.slice(0, MAX_TEXT_LENGTH) : ''
  return {
    ...head, version: VERSION_SHAPE.test(version) ? version : '',
    startedAt: Math.round(x.startedAt), lastSeenAt: Math.round(x.lastSeenAt), segments: readSegments(x.segments),
  }
}

function readStoppedRun(x: unknown): StoppedRun | null {
  const run = readRun(x)
  const endedBy = isRecord(x) ? x.endedBy : undefined
  return run && (endedBy === 'quit' || endedBy === 'unfinished') ? { ...run, endedBy } : null
}

function readEntry(x: unknown): StoppedEntry | null {
  if (!isRecord(x) || !Array.isArray(x.runs)) return null
  const head = readHead(x)
  if (!head) return null
  const runs = x.runs.map(readStoppedRun)
    .filter((r): r is StoppedRun => r !== null && r.op === head.op && r.target === head.target)
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(-MAX_EARLIER_RUNS)
  return runs.length === 0 ? null : { ...head, runs, noticeSeen: x.noticeSeen === true }
}

/** その項目でいちばん新しい「最後に分かった時刻」。 */
function newestSeen(runs: readonly InFlightRun[]): number {
  return runs.reduce((n, r) => Math.max(n, r.lastSeenAt), 0)
}

/**
 * 読んだ JSON を、使える形にする（純関数・何が来ても落ちない）。形が合わないもの（`v` が 1 でない＝全部／鍵・種類・公開先・
 * ハンドラ名・段の名前・時刻の形が違うもの＝その項目か区間）は捨て、上限（止まった項目20・回3・区間50）で切る。
 * 文字列は `handler`・`version` の64文字だけ（切る）。**鍵は切らない**。
 */
export function sanitizeInFlightFile(x: unknown): InFlightFile {
  const out = emptyInFlightFile()
  if (!isRecord(x) || x.v !== 1) return out
  const running = isRecord(x.running) ? x.running : {}
  const runs: [string, InFlightRun][] = []
  for (const [key, v] of Object.entries(running)) {
    const run = isInFlightKey(key) ? readRun(v) : null
    if (run) runs.push([key, run])
  }
  runs.sort((a, b) => b[1].lastSeenAt - a[1].lastSeenAt)
  for (const [key, run] of runs.slice(0, MAX_RUNNING_ENTRIES)) out.running[key] = run
  const stopped = isRecord(x.stopped) ? x.stopped : {}
  const entries: [string, StoppedEntry][] = []
  for (const [key, v] of Object.entries(stopped)) {
    const entry = isInFlightKey(key) ? readEntry(v) : null
    if (entry) entries.push([key, entry])
  }
  entries.sort((a, b) => newestSeen(b[1].runs) - newestSeen(a[1].runs))
  for (const [key, entry] of entries.slice(0, MAX_STOPPED_ENTRIES)) out.stopped[key] = entry
  return out
}

// ── 起動したとき ─────────────────────────────────────────────────────────────

/** 起動時に、項目を残してよいか確かめる先（本物は main の `fs.existsSync` と、公開先ごとの「続ける物があるか」）。 */
export type StartupProbe = {
  exists: (key: string) => boolean
  hasWork: (key: string, target: InFlightTarget) => boolean
}

/** 確かめる先が投げたら、項目を残す側に倒す（想定外なので捨てない）。 */
function keepOnThrow(f: () => boolean): boolean {
  try { return f() } catch { return true }
}

/**
 * 起動したときの整理（純関数）。`running` に残っているものは全部「Koto の終了で途中で止まった回」なので `stopped` へ移し、
 * `running` は空にして返す。**順番が大事**:
 *  1. 種類の表 `STOPPED_OP_POLICY` を先に当てる（捨てる種類の回は、ここで落とす。止まった削除を置き換えさせない）
 *  2. 同じプロジェクトの `stopped` に、同じ公開先・同じ種類の項目があれば回を足す（3回まで・古い回から捨てる・
 *     同じ startedAt は1つ）。別の公開先なら置き換える。足したら `noticeSeen` は false に戻す
 *  3. いちばん新しい回の最後に分かった時刻が30日より前、または今より5分以上先なら捨てる
 *  4. フォルダがもう無い（`exists`）なら捨てる
 *  5. 続けるものが無い（`hasWork`）なら捨てる（同じパスに作り直したフォルダの古い記録・消し終わっていた回の知らせを出さない）
 *  6. 20件まで（いちばん新しい回が新しいものを残す）
 * 版が違う回もそのまま持つ（知らない段の名前は `stageLabelOf` が内部名のまま出す）。
 */
export function adoptAtStartup(file: unknown, now: number, probe: StartupProbe): InFlightFile {
  const f = sanitizeInFlightFile(file)
  const stopped: Record<string, StoppedEntry> = { ...f.stopped }
  for (const [key, run] of Object.entries(f.running)) {
    if (STOPPED_OP_POLICY[run.op] !== 'keep') continue
    const quit: StoppedRun = { ...run, endedBy: 'quit' }
    const cur = stopped[key]
    if (cur && cur.op === run.op && cur.target === run.target) {
      // 同じ startedAt の回は1つ（書き戻しに失敗して次の起動でもう一度読んでも二重にしない。そのときは知らせの「見た」も戻さない）。
      const dup = cur.runs.some(r => r.startedAt === quit.startedAt)
      const runs = dup ? cur.runs : [...cur.runs, quit].sort((a, b) => a.startedAt - b.startedAt).slice(-MAX_EARLIER_RUNS)
      stopped[key] = { ...cur, handler: run.handler, runs, noticeSeen: dup ? cur.noticeSeen : false }
    } else {
      stopped[key] = { op: run.op, target: run.target, handler: run.handler, runs: [quit], noticeSeen: false }
    }
  }
  const kept: [string, StoppedEntry][] = []
  for (const [key, e] of Object.entries(stopped)) {
    if (STOPPED_OP_POLICY[e.op] !== 'keep') continue
    const seen = newestSeen(e.runs)
    if (seen < now - STOPPED_KEEP_MS || seen >= now + CLOCK_SKEW_MS) continue
    if (!keepOnThrow(() => probe.exists(key))) continue
    if (!keepOnThrow(() => probe.hasWork(key, e.target))) continue
    kept.push([key, e])
  }
  kept.sort((a, b) => newestSeen(b[1].runs) - newestSeen(a[1].runs))
  const out = emptyInFlightFile()
  for (const [key, e] of kept.slice(0, MAX_STOPPED_ENTRIES)) out.stopped[key] = e
  return out
}

// ── 止まった回の時間 ─────────────────────────────────────────────────────────

/**
 * 止まった回の、段ごとの時間（純関数）。段が1つも無い回は null（何に使った時間か分からないものは足さない）。
 * ・閉じた区間は `endedAt − startedAt`、開いたままの区間は最後に分かった時刻まで。同じ段に何度か入ったら足す（`buildStageTimings` と同じ）
 * ・`partialLast`＝最後の段が終わっていない。'quit' は最後の区間が開いていて、1ミリ秒以上経っているとき（段の切り替えの直後に
 *   止まった回には付けない）。'unfinished' は最後の段が時間切れで終わったので、いつも true
 * ・`partialLast` のとき、その段（最後の区間の段）を `stages` の**最後の行**に置く（同じ段に戻っていても、画面が最後の行に「途中まで」を付けられる）
 * ・`knownMs` は始まりから最後に分かった時刻まで。負は 0
 */
export function stoppedRunTimings(run: StoppedRun): StoppedRunTimings | null {
  const segs = run.segments.filter(s => isStageIdShape(s.stage))
  if (segs.length === 0) return null
  const lastKnownAt = run.lastSeenAt
  const order: string[] = []
  const sums = new Map<string, number>()
  for (const s of segs) {
    const ms = Math.max(0, Math.round((s.endedAt ?? lastKnownAt) - s.startedAt))
    if (!sums.has(s.stage)) { sums.set(s.stage, 0); order.push(s.stage) }
    sums.set(s.stage, (sums.get(s.stage) ?? 0) + ms)
  }
  const last = segs[segs.length - 1]
  const lastIsOpen = last.endedAt === undefined && Math.round(lastKnownAt - last.startedAt) > 0
  const partialLast = run.endedBy === 'unfinished' || lastIsOpen
  const sequence = partialLast ? [...order.filter(id => id !== last.stage), last.stage] : order
  const stages: StageTimingRow[] = sequence.map(stage => ({ stage, ms: sums.get(stage) ?? 0 }))
  return {
    startedAt: run.startedAt, lastKnownAt, endedBy: run.endedBy,
    knownMs: Math.max(0, Math.round(lastKnownAt - run.startedAt)), stages, partialLast,
  }
}

// ── 「Koto の終了で止まりました」の判定と文 ──────────────────────────────────────

/** 処理の記録の結果が、起動の読み戻しが置いた「止まりました」の知らせか（`extra.stoppedByQuit === true`）。判定はここの1つ。 */
export function isStoppedByQuit(result: unknown): boolean {
  const extra = isRecord(result) ? result.extra : undefined
  return isRecord(extra) && extra.stoppedByQuit === true
}

/** 知らせの本文。専有型は押し直すと続きから進むことを確かめてある（2026-10-10 実機）。共用型・HANAMII は確かめていないので続きからとは言わない（判断 I）。 */
export function stoppedNextStep(target: string): string {
  // 押すボタンの名前で言う（専有型は「🗑 削除」、共用型・HANAMII は「🗑 破棄」。1回の流れの中で名前を変えない・
  // docs/wording-decisions.md の決め。2026-10-19 親: 共用型・HANAMII でも「削除を押して」と言っていた）
  return target === 'sakura-apprun-dedicated'
    ? 'もう一度削除を押すと、続きから進みます。'
    : 'どこまで済んだか管理画面で確かめてから、もう一度破棄を押してください。'
}

/** 「Koto の終了で止まりました」の言い回し（定義はここ1か所。見出しの文はこれから作る）。 */
const STOPPED_BY_QUIT_TEXT = 'Koto の終了で止まりました'

/** 「HH:MM ごろ、Koto の終了で止まりました」。時刻が読めなければ時刻なし。見出しに使う場所はこれを使う。 */
export function stoppedWhenText(finishedAt: unknown): string {
  const t = clockText(finishedAt)
  return t ? `${t} ごろ、${STOPPED_BY_QUIT_TEXT}` : STOPPED_BY_QUIT_TEXT
}

/** 知らせの見出し「〇〇は、Koto の終了で止まりました（HH:MM ごろ）」。時刻が読めなければ括弧ごと省く。「に終わりました」は言わない。 */
export function stoppedNoticeHeadline(subject: string, finishedAt?: unknown): string {
  const t = clockText(finishedAt)
  return `${subject}は、${STOPPED_BY_QUIT_TEXT}${t ? `（${t} ごろ）` : ''}`
}
