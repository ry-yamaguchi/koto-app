// stoppedOps.ts — 途中で止まった回（Koto の終了で止まった／待ち切れて止まった）をメモリで持つ部品。設計書 10.13.5・10.13.6・10.13.9。
//
// projectOps.ts から出した（projectOps.ts は 700 行以下の決まり。10.13.15 の 4）。ここが決めるのは次の3つだけ:
//   ・起動の読み戻しが渡した止まった回を持ち、「Koto の終了で止まりました」の知らせ（処理の記録の「終わった結果」）を作る（`adoptStopped`）
//   ・知らせを画面が見た／同じ操作が始まったら、「見た」の印を付ける（`markNoticeSeen`・`markNoticeSeenByBegin`・`withoutStoppedNotice`）
//   ・次に同じ操作が終わったとき、止まった回の時間を今回に合わせ、要らなくなった回を消す（`settleStopped`。消したら `cleared` で知らせる＝
//     呼び出し側が見られていない知らせも外す）
//   ・ファイルに書く run の組み立て（`inFlightRunOf`）。走っている回も待ち切れて止まった回も、この1つを通る
// 走っている記録（live）と見られていない結果（unseen）の持ち主は projectOps.ts で、ここは持たない。**ファイルにも触らない**
// （書くのは projectOps が口を通して inFlightOpsStore.ts に頼む）。持つのは InFlightRun の形（決まった語・数・段の内部名）だけで、
// 進み具合の文・結果・URL・資源の ID・秘密は入れない（掟4）。fs・electron は import しない。
import {
  isInFlightKey, isStoppedByQuit, MAX_SEGMENTS, MAX_STOPPED_ENTRIES, stoppedNextStep, stoppedRunTimings,
  type InFlightRun, type InFlightSegment, type StoppedEntry, type StoppedRun,
} from '../shared/inFlightOps'
import { MAX_EARLIER_RUNS, type StoppedRunTimings } from '../shared/stageTiming'
import { resumedTeardownView } from '../shared/teardownResult'
import type { ProjectOp, OpTarget, ProjectOpRecord } from './projectOps'

/** プロジェクトの鍵（`keyOf` の形）→ 止まった回。 */
const memory = new Map<string, StoppedEntry>()

const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T
const newestRun = (e: StoppedEntry): StoppedRun => e.runs[e.runs.length - 1]

/** ファイルに書く分（ファイルの中身の `stopped`）。写しを返す（呼び出し側が書き換えても、ここは変わらない）。 */
export function stoppedSnapshot(): Record<string, StoppedEntry> {
  return copy(Object.fromEntries(memory))
}

/** テスト用: 空にする。 */
export function resetStoppedForTests(): void {
  memory.clear()
}

// ── 起動の読み戻し ───────────────────────────────────────────────────────────

/** 「Koto の終了で止まりました」の知らせ。`startedAt` は識別子（`ackOps` が比べる）、`finishedAt` は最後に分かった時刻。 */
function noticeRecord(e: StoppedEntry, run: StoppedRun, id: number): ProjectOpRecord {
  return {
    op: e.op, target: e.target, handler: e.handler, startedAt: id, running: false, seen: false,
    progress: { label: '', detail: '', at: run.lastSeenAt }, finishedAt: run.lastSeenAt,
    // warnings は空（1回だけ: 警告の無い結果は、出した画面が「見た」と伝えれば消える）。stoppedByQuit は EXTRA_KEYS に足さない。
    result: { ok: false, message: stoppedNextStep(e.target), lines: [], warnings: [], extra: { stoppedByQuit: true } },
  }
}

/**
 * 起動の読み戻しが整えた止まった回（`adoptAtStartup` の `stopped`）を持つ。知らせは、まだ見られていなくて、いちばん新しい回が
 * 'quit' のものにだけ作る（'unfinished' の回は、その回の結果そのものが画面に出た知らせ）。
 * 知らせの識別子は `min(いちばん新しい回の startedAt, 起動時の now − 1)`（複数あるときは古い順に、前より必ず大きくする）。
 * **起動時の実時刻を超えては上げない**: 止まった回の startedAt は時計のずれで未来でありうる。そのまま使うと、この起動で始まる
 * 操作の startedAt が未来になり、最初の段の時間が 0 に潰れる。返す `maxId` は、projectOps が `lastStartedAt` の下限に使う。
 * 途中で投げても何も持たない（持つのは最後にまとめて）。
 */
export function adoptStopped(
  entries: Record<string, StoppedEntry>, now: number,
): { notices: [string, ProjectOpRecord][]; maxId: number } {
  const next = new Map<string, StoppedEntry>()
  for (const [key, e] of Object.entries(entries)) {
    if (isInFlightKey(key) && e.runs.length > 0) next.set(key, copy(e))
  }
  const due = [...next].filter(([, e]) => !e.noticeSeen && newestRun(e).endedBy === 'quit')
    .sort((a, b) => newestRun(a[1]).startedAt - newestRun(b[1]).startedAt)
  const notices: [string, ProjectOpRecord][] = []
  let maxId = -Infinity
  for (const [key, e] of due) {
    const run = newestRun(e)
    const base = Number.isFinite(now) ? Math.min(run.startedAt, now - 1) : run.startedAt
    const id = Math.max(base, maxId + 1)
    notices.push([key, noticeRecord(e, run, id)])
    maxId = id
  }
  memory.clear()
  for (const [key, e] of next) memory.set(key, e)
  return { notices, maxId }
}

// ── 知らせを見た・同じ操作が始まった ─────────────────────────────────────────────

/** 画面が知らせを見たと伝えた。そのプロジェクトの「見た」の印を付ける。変えたら true（ファイルへ書き直す）。 */
export function markNoticeSeen(key: string): boolean {
  const e = memory.get(key)
  if (!e || e.noticeSeen) return false
  e.noticeSeen = true
  return true
}

/** 同じ公開先・同じ種類の操作が始まった（押し直した人に「止まりました」を出し続けない）。 */
export function markNoticeSeenByBegin(key: string, op: ProjectOp, target: OpTarget): boolean {
  const e = memory.get(key)
  return !!e && e.op === op && e.target === target && markNoticeSeen(key)
}

/** 見られていない記録から、その公開先・種類の「止まりました」の知らせを外す。 */
export function withoutStoppedNotice(list: readonly ProjectOpRecord[], op: ProjectOp, target: OpTarget): ProjectOpRecord[] {
  return list.filter(r => !(isStoppedByQuit(r.result) && r.op === op && r.target === target))
}

// ── 次に終わったとき ─────────────────────────────────────────────────────────────

/** `settleStopped` が見る、終わった回の材料（projectOps の Live の一部）。 */
export type SettlingOp = {
  record: ProjectOpRecord
  version: string
  lastSeenAt: number
  /** 区間（いまの段は finishOp が閉じてから渡す）。 */
  segments: readonly InFlightSegment[]
}

/**
 * ファイルに書く run の組み立て（**走っている回も待ち切れて止まった回も、この1つを通る**）。入れるのは決まった語と数と段の内部名だけで、
 * キーを書き下してある（進み具合の文・結果・URL・資源の ID・ゾーン・秘密は、ここで足さない限り入らない）。
 */
export function inFlightRunOf(
  r: Pick<ProjectOpRecord, 'op' | 'target' | 'handler' | 'startedAt'>, version: string, lastSeenAt: number, segments: readonly InFlightSegment[],
): InFlightRun {
  return {
    op: r.op, target: r.target, handler: r.handler, version, startedAt: r.startedAt, lastSeenAt,
    segments: segments.slice(-MAX_SEGMENTS).map(s => (s.endedAt === undefined
      ? { stage: s.stage, startedAt: s.startedAt }
      : { stage: s.stage, startedAt: s.startedAt, endedAt: s.endedAt })),
  }
}

/** 待ち切れて止まった今回を、止まった回にする（'unfinished'）。判定の材料は `settleStopped` が整える。 */
function unfinishedRun(op: SettlingOp, finishedAt: number): StoppedRun {
  return { ...inFlightRunOf(op.record, op.version, Math.max(op.lastSeenAt, finishedAt), op.segments), endedBy: 'unfinished' }
}

/** 持つ項目は20件まで（いちばん新しい回の最後に分かった時刻が古いものから捨てる）。 */
function capMemory(): void {
  while (memory.size > MAX_STOPPED_ENTRIES) {
    const oldest = [...memory].reduce((a, b) => (newestRun(b[1]).lastSeenAt < newestRun(a[1]).lastSeenAt ? b : a))
    memory.delete(oldest[0])
  }
}

/**
 * `finishOp` が、今回の結果を作ったあと（見られていない記録へ足す前）に1回呼ぶ。止まった回と今回を合わせる。
 *  ・`earlier`＝今回に並べる止まった回の時間（古い順）。同じプロジェクト・**同じ公開先・同じ種類**（handler は見ない）の止まった回があり、
 *    今回に段の時間があるときだけ（無ければ undefined）。止まった回の段は、今回の段（`timings.stages`）には混ぜない
 *  ・消すのは **`ok:true` のときだけ**: 同じ公開先・種類の操作／同じ公開先の作成・公開（作り直した＝別の一生）が成功したとき。
 *    失敗したときは残す（押し直すたびに失敗して、最後に成功した回の合計から古い回が落ちるのは、作者の不満と同じ形）
 *  ・`cleared`＝**消した止まった回の（種類・公開先）**。消さなかったら undefined。呼び出し側（finishOp）は、これで見られていない
 *    「止まりました」の知らせも外す——main に回が無いのに、画面が「もう一度破棄を押してください」と言い続けないため（定義を2つにしない）
 *  ・削除が、待ち切れて続きから進める形で終わった（`resumedTeardownView(…).state === 'inProgress'`）ときは、今回も止まった回として
 *    足す（判断 J。段の時間があるときだけ。公開先が分からない 'unknown' は足さない）。別の公開先の削除なら置き換える
 *  ・違う公開先・違う種類の操作は、止まった回に触れない
 */
export function settleStopped(
  key: string, op: SettlingOp, finishedAt: number, hasTimings: boolean,
): { earlier: StoppedRunTimings[] | undefined; cleared: { op: ProjectOp; target: OpTarget } | undefined } {
  const rec = op.record
  const ok = rec.result?.ok === true
  const cur = memory.get(key)
  const same = !!cur && cur.op === rec.op && cur.target === rec.target
  let earlier: StoppedRunTimings[] | undefined
  let cleared: { op: ProjectOp; target: OpTarget } | undefined
  if (cur && same && hasTimings) {
    const list = cur.runs.map(stoppedRunTimings).filter((r): r is StoppedRunTimings => r !== null)
    if (list.length > 0) earlier = list
  }
  if (ok) {
    if (cur && (same || (rec.op !== '削除' && rec.target === cur.target))) {
      memory.delete(key)
      cleared = { op: cur.op, target: cur.target }
    }
  } else if (rec.op === '削除' && rec.target !== 'unknown' && hasTimings
    && resumedTeardownView(rec.target, rec.result).state === 'inProgress') {
    const runs = [...(cur && same ? cur.runs : []), unfinishedRun(op, finishedAt)].slice(-MAX_EARLIER_RUNS)
    memory.set(key, { op: rec.op, target: rec.target, handler: rec.handler, runs, noticeSeen: true })
    capMemory()
  }
  return { earlier, cleared }
}
