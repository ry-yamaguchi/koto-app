// inFlightOutlet.ts — 途中で止まった回の記録（in-flight-ops.json）へ書く「口」の持ち主。設計書 10.13.4。
//
// projectOps.ts が自分のメモリからファイルの中身を丸ごと組み立て、ここへ渡す。ここは**口を1つ持ち、いつ書くか・書けなかったか**
// だけを決める。ファイルには触らない（書くのは inFlightOpsStore.ts が口の先で。stageTimingStore.ts と同じ分け方）。
// 口は起動の読み戻し（inFlightOpsArm.ts）がつなぐので、あとから起動して自分で終了するほうの Koto は一度も書かない。つながる前は何もしない。
//
// ・**書けないことで、操作の結果・鍵・記録を変えない**: 口が false を返しても投げても握りつぶし、「書けなかった」の印（dirty）だけ残す。
//   印が立っている間は間引かず、次の書く機会（別の操作の始まり・段の切り替わり・進み具合・終了の直前）に書き直す。
//   残ったままだと、ファイルに「走っている」が残り、次の起動で偽の「止まりました」が出るため。
// ・進み具合だけが来たとき（`onlyIfDue`）は、前に書いてから30秒たつまで書かない。**単調な時計で測る**（`Date` は戻ることがあり、
//   戻ったあとの30秒書かれない間ができる）。段の切り替わりは待たない。
import type { InFlightFile } from '../shared/inFlightOps'

/** 進み具合だけが来たとき、ファイルへ書く間隔（前に書いてから）。 */
export const IN_FLIGHT_PROGRESS_INTERVAL_MS = 30_000

export type InFlightSinkOptions = {
  /** Koto の版。走り始めた回の記録に写す（取れなければ ''）。 */
  version?: string
  /** 間引きに使う単調な時計（ミリ秒）。本番は performance.now()。テストで差し替える。 */
  monotonicNow?: () => number
}

const defaultMonotonicNow = (): number => performance.now()

let sink: ((file: InFlightFile) => boolean) | null = null
let version = ''
let monotonicNow: () => number = defaultMonotonicNow
/** 前に書いた（書こうとした）ときの単調な時計の値。まだ書いていなければ -Infinity。 */
let lastWriteAt = -Infinity
let dirty = false

/**
 * 口を1つだけ持つ。`fn` は中身を丸ごと受け取り、書けたら true を返す。null で外す。
 * つなぎ直すと、書いた時刻と「書けなかった」の印は初めに戻る。
 */
export function setInFlightSink(fn: ((file: InFlightFile) => boolean) | null, opts?: InFlightSinkOptions): void {
  sink = fn
  version = typeof opts?.version === 'string' ? opts.version : ''
  monotonicNow = opts?.monotonicNow ?? defaultMonotonicNow
  lastWriteAt = -Infinity
  dirty = false
}

export const isInFlightSinkConnected = (): boolean => sink !== null
/** 前の書き込みが失敗したままか。 */
export const isInFlightDirty = (): boolean => dirty
/** 走り始めた回に写す Koto の版。 */
export const inFlightVersionOf = (): string => version

/**
 * 口へ書く（**口を呼ぶのはここだけ**）。つながっていなければ何もしない。`build` は書くときに中身を組み立てる関数。
 * `onlyIfDue` のときは、前の書き込みが失敗していなければ、前に書いてから30秒たつまで書かない。
 */
export function writeInFlightThrough(build: () => InFlightFile, onlyIfDue = false): void {
  if (!sink) return
  try {
    const t = monotonicNow()
    if (onlyIfDue && !dirty && t - lastWriteAt < IN_FLIGHT_PROGRESS_INTERVAL_MS) return
    const written = sink(build()) === true
    dirty = !written
    lastWriteAt = t
  } catch {
    dirty = true
  }
}

/** テスト用: 口・版・時計・書いた時刻・印を初めに戻す。 */
export function resetInFlightOutletForTests(): void {
  setInFlightSink(null)
}
