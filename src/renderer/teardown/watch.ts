// teardown/watch.ts — 破棄（削除）の記録（main の projectOps）を、画面が読む部品。React に依存しない。
//
// 段階0で作った部品（いまは3つの公開先〔共用型・HANAMII・専有型〕の入口がすべてこれを通る）。設計書: docs/teardown-unify-plan.md の 10.3.2 (5)。
// 専有型のパネルの見張り watchDedicatedOps（apprunDedicatedActions.ts。手順5・6・8を受け持つ）と、「この画面が始めた操作の窓」の判断（localOpsWindow）を共有する。
//
// ── 何のための部品か ───────────────────────────────────────────────────────────────
// 破棄の本体は main の1回の IPC で最後まで進み、記録も main が書く（withProjectLock）。だから画面を閉じても処理は止まらない。
// 失われるのは画面の表示（進み具合・結果・「保存場所が残ったので月額が続きます」のような警告）だけなので、開いたとき記録を読んで続きを出す。
// 「外して付け直したとき、走っていれば進み具合が出る／終わっていれば結果と警告が出る／ack のあとは出ない」は
// お金の見え方に関わる約束なので、React の外に出して、偽の projectOps に流す振る舞いのテストで固定する（掟10）。
//
// 記録を読む・押し出しを受ける・古い応答を捨てる・別のプロジェクトを無視する・「どこまで見たと伝えてよいか」は、
// 共通の1か所（projectOpsView.ts の watchProjectOps／ackUpToFor）を通る。ここに書くのは破棄に固有の判断だけ
// （どの記録が自分の公開先の破棄か・この画面が始めた破棄の結果は自分で出す）。

import type { PublishTargetKind } from '../../shared/publishMeta'
import { warningLine, warningsNotRepeatedIn, clockText } from '../../shared/opsText'
import { opWordFor } from '../../shared/opWord'
import {
  TEARDOWN_REMAINING_WARNING_HEAD, TEARDOWN_IN_PROGRESS_WARNING_HEAD, resumedTeardownView, resultCallOf,
} from '../../shared/teardownResult'
import type { TeardownCall } from '../../shared/teardownCall'
import { isStoppedByQuit, stoppedNoticeHeadline } from '../../shared/inFlightOps'
import { isKnownPublishTarget, PUBLISH_TARGET_LABEL } from '../publishStatus'
import { unseenOf, ackUpToFor, sendAck, watchProjectOps, localOpsWindow, type ProjectOpsApi } from '../projectOpsView'
import type { TeardownWords } from './types'

/**
 * 破棄の IPC と公開先の表（設計書 3.7）。**破棄の記録を見分ける表はこの1つ**。
 * projectOpsView.ts の DEDICATED_PANEL_HANDLERS（専有型のパネルが受け持つ作成・削除・公開）は変えない。
 */
export const TEARDOWN_HANDLER_TARGET: Readonly<Record<string, PublishTargetKind>> = Object.freeze({
  'cloud:teardown': 'sakura-apprun',
  'hanamii:teardown': 'hanamii',
  'apprunDedicated:teardown': 'sakura-apprun-dedicated',
})

/**
 * 記録が、この公開先の破棄か。**見分けは target と handler の両方**。
 * 鍵はプロジェクト単位なので、走っている・終わった記録は別の公開先の操作や、同じ公開先の公開・作成のことがある——
 * そういう記録の詳細はここで出さず（掟11）、ack でも巻き込まない。
 */
export function isTeardownRecordOf(target: PublishTargetKind, rec: { target?: string; handler?: string } | null | undefined): boolean {
  if (!rec || rec.target !== target || typeof rec.handler !== 'string') return false
  // 表に無い名前（constructor など Object.prototype 由来のものを含む）は、公開先の文字列と等しくならないので false になる。
  return TEARDOWN_HANDLER_TARGET[rec.handler] === target
}

/** 走っているものの見え方。`running` がこの公開先の破棄、`other` が別の操作。どちらも無ければ何も走っていない。 */
export type TeardownRunningView = {
  running: ProjectOpRecordShape | null
  other: { op: string; targetLabel: string | null } | null
}

/** 開き直したあとの結果に添える、1件ぶんの知らせ。 */
export type TeardownResumedNote = {
  /** 記録の識別子（同じプロジェクトで必ず増える）。 */
  startedAt: number
  finishedAt: number | null
  ok: boolean
  /**
   * 結果をどう呼ぶか（済んだ／途中／失敗）。**`ok` だけで失敗と言わない**: HANAMII が受け付けただけの回は ok:false でも失敗ではなく途中。
   * 呼び名の定義は shared の `resultCallOf` の1つ（結果欄の見出し〔TeardownView.state〕・【公開】の結果カードと同じ答え）。
   */
  call: TeardownCall
  /** 一行の見出し（素のテキスト）。 */
  headline: string
  /** 結果の一言（失敗の理由など）。最新の1件は結果欄が同じ文を出すので、古い記録のときだけ出す。 */
  message: string
  /** 見逃してはいけない知らせ（そのまま日本語の文。⚠️ 付き）。 */
  warnings: string[]
  /** 起動の読み戻しが置いた「Koto の終了で止まりました」の知らせ。true のときだけ付ける（失敗ではないので、結果欄は「失敗しました」と言わない）。 */
  stoppedByQuit?: true
}

const RESULT_UNREADABLE = '結果を読み取れませんでした。コントロールパネルで、実際の状態を確かめてください。'

/**
 * 記録1件を、結果欄の上に出す知らせにする。写し元: resumedNoteOf（見出しは `🔔 ${words.verb}の結果（HH:MM に終わりました）`。
 * 0.6.22 段階3B-3 で、文の削減 T162（「です」と句点をやめる）を反映した。専有型のパネルの resumedNoteOf も、削除の枝はこの関数を呼ぶだけ＝手順6のパネルも同じ見出し）。
 *
 * 結果欄が一覧つきで出すものは、同じ知らせを警告に重ねない:
 *   ・残ったものの一覧を出す回 … 「削除できずに残っているものがあります」で始まる警告
 *   ・待ち切れず止まったものの一覧を出す回 … 「削除の途中で、待ち切れずに止まりました」で始まる警告
 *   ・message に含まれる文の警告（結果欄が message をそのまま出すので、同じ文を2度言わない。HANAMII の受付済みが当たる）
 * 一覧が出せない回（残ったものの名前が1件も無い等）は、同じ書き出しの知らせでも落とさない。
 * 中身の無い警告（空の文）は出さない（「⚠️ 」だけの行になる）。
 * この判断は TeardownResultView の警告の欄と同じ（2か所で同じ警告を言わない・どちらにも出ないことも無い。tests/teardownViewCommon.test.ts が突き合わせる）。
 * ここで残した警告のうち、**最新の1件**で結果欄の警告の欄も出す文は、TeardownResultView が描くときに知らせの側から外す
 * （その場の結果は1回なのに、開き直すと知らせと結果欄で2回出る、にしない）。古い記録の警告は結果欄に無いので、全件知らせが出す。
 */
export function resumedTeardownNote(words: TeardownWords, rec: ProjectOpRecordShape): TeardownResumedNote {
  const r = rec.result
  const view = r ? resumedTeardownView(rec.target as PublishTargetKind, r) : null
  const remainingListed = !!view && view.state === 'failed' && view.remaining.length > 0
  const inProgressListed = !!view && view.state === 'inProgress' && view.inProgress.length > 0
  const message = r ? (r.message ?? '') : RESULT_UNREADABLE
  const warnings = warningsNotRepeatedIn(message, (r?.warnings ?? []).map(String).filter(w => {
    if (remainingListed && w.startsWith(TEARDOWN_REMAINING_WARNING_HEAD)) return false
    if (inProgressListed && w.startsWith(TEARDOWN_IN_PROGRESS_WARNING_HEAD)) return false
    return true
  }))
  const when = rec.finishedAt ? `（${clockText(rec.finishedAt)} に終わりました）` : ''
  // 「Koto の終了で止まりました」の知らせは、終わっていない（時刻は最後に分かった時刻）。「に終わりました」とは言わない。判定は shared の1つ。
  const quitStopped = isStoppedByQuit(r)
  return {
    startedAt: rec.startedAt,
    finishedAt: rec.finishedAt ?? null,
    ok: r?.ok === true,
    call: resultCallOf(rec.target, r),
    headline: quitStopped ? `🔔 ${stoppedNoticeHeadline(words.verb, rec.finishedAt)}` : `🔔 ${words.verb}の結果${when}`,
    message,
    warnings: warnings.map(warningLine),
    ...(quitStopped ? { stoppedByQuit: true as const } : {}),
  }
}

export interface TeardownOpsWatch {
  /**
   * **この画面が**破棄を始めるとき（IPC を呼ぶ直前）に呼ぶ。その破棄の結果はこの画面が自分の返り値から出すので、
   * 記録のほうを**二重に出さない**（endLocal までは出さず・ack もしない）。
   */
  beginLocal(): void
  /**
   * その結果を**画面に出し終えたら**呼ぶ。この画面が始めた記録を「見た」として ack する。
   * 出し終える前に窓が閉じたら呼ばれない＝ack されない＝開き直したときに記録から出せる（結果を失わない）。
   */
  endLocal(): void
  /** いまの記録を聞き直す（押し出しが1つ届かなかったときの保険）。聞いている間により新しい押し出しが届いたら、その応答は使わない。 */
  refresh(): void
  /**
   * 目の前に出ているかが変わったとき（タブが隠れた・また出た）に呼ぶ。出た側へ変わったら、隠れている間に画面へ渡した記録を、
   * ここで「見た」として ack へ回す（隠れている間は、渡していても「見た」に数えない）。
   */
  visibilityChanged(): void
  /** 外す（アンマウント）。以降は何も届けず、ack もしない。 */
  stop(): void
}

/**
 * 開いたとき記録を1回読み、開いている間は押し出しを受ける（読み方は watchProjectOps）。写し元: watchDedicatedOps。
 *
 * - 終わった結果は**1件につき1回だけ** `onFinished` へ渡す（古い順）。画面に渡したあとで ack する
 *   （**目の前に出ているとき**だけ。隠れているタブは、渡しても ack しない）。**警告つきの記録は ack しない**
 *   （ackUpToFor が止める。上部の「結果を確認しました」まで残す）。
 * - **ack は連続した先頭の「自分のもの」まで**（ackUpToFor）。別の公開先の結果や、この画面が出している最中の結果を
 *   挟んだら、それより新しいものは自分のものでも ack せず残す（開き直すと重ねて見えるだけで、失わない）。
 * - 受け持つのは `target` の破棄だけ（種類は破棄1つ）。
 */
export function watchTeardownOps(deps: {
  api: ProjectOpsApi
  projectDir: string
  target: PublishTargetKind
  onRunning: (view: TeardownRunningView) => void
  onFinished: (finished: ProjectOpRecordShape[]) => void
  now?: () => number
  /** いま利用者の目の前に出ているか（既定は常に true）。隠れている間は、渡した記録も「見た」に数えない。 */
  isVisible?: () => boolean
}): TeardownOpsWatch {
  const { api, projectDir, target } = deps
  const now = deps.now ?? Date.now
  const isVisible = deps.isVisible ?? (() => true)
  let stopped = false
  let latest: ProjectOpsSnapshotShape | null = null
  let ackedUpTo = -Infinity
  const delivered = new Set<number>()
  /**
   * この画面が始めた破棄（since 以降、until 以前に始まった記録）。出し終えるまで ack しない。窓の判断は `localOpsWindow`（projectOpsView.ts）の1つで、
   * 専有型のパネルの見張り（`watchDedicatedOps`。手順5・6・8）も同じものを通る（0.6.22 段階3B-3。10.6.2 の 7）。
   * **出し終えたあとに別の入口が始めた同じ公開先の破棄は、この画面のものではない**
   * （窓を閉じないと、その結果が onFinished へ渡らないまま ack されて、誰にも見せないまま「見た」になる）。
   */
  const win = localOpsWindow(now)

  const apply = (s: ProjectOpsSnapshotShape) => {
    if (stopped) return
    latest = s

    // 走っているもの
    const run = s.running ?? null
    deps.onRunning(
      run && isTeardownRecordOf(target, run) ? { running: run, other: null }
        : run ? { running: null, other: { op: opWordFor(run.op, run.target), targetLabel: isKnownPublishTarget(run.target) ? PUBLISH_TARGET_LABEL[run.target] : null } }
        : { running: null, other: null },
    )

    // 終わったもの（まだ見られていないもの）。古い順。
    const unseen = unseenOf(s)
    const fresh: ProjectOpRecordShape[] = []
    for (const rec of unseen) {
      if (!isTeardownRecordOf(target, rec)) continue // 別の持ち場の結果。出さない（ack にも巻き込まれない・下の isShown が false）
      if (win.stateOf(rec) !== 'outside') {
        // この画面が自分の返り値から出す結果。**渡したことにする**——警告つきの記録は ack されず残るので、同じ画面がもう一度始めて
        // beginLocal で窓を張り直したとき、前の結果が「閉じている間に終わった記録」として重ねて出てしまう（HANAMII の受付済みを押し直すと起きる）。
        delivered.add(rec.startedAt)
        continue
      }
      if (delivered.has(rec.startedAt)) continue
      delivered.add(rec.startedAt)
      fresh.push(rec)
    }

    if (fresh.length > 0) deps.onFinished(fresh) // 画面に渡してから ack する（見せる前に「見た」にしない）
    const ackUpTo = ackUpToFor(unseen, rec => {
      if (!isTeardownRecordOf(target, rec)) return false // 別の持ち場の結果は、出していない
      if (!isVisible()) return false // 隠れているタブの画面は、結果を持っていても、利用者はまだ見ていない
      // この画面が始めた破棄は、出し終えるまで「見た」ではない（出し終える前に閉じたら、開き直して記録から出す）。
      const st = win.stateOf(rec)
      if (st !== 'outside') return st === 'done'
      return true // 上で渡した（あるいは、すでに渡している）
    })
    if (ackUpTo !== null && ackUpTo > ackedUpTo) {
      ackedUpTo = ackUpTo
      sendAck(api, projectDir, ackUpTo)
    }
  }

  const watch = watchProjectOps(api, projectDir, apply)

  return {
    refresh() { if (!stopped) void watch.refresh() },
    beginLocal() { win.begin() },
    endLocal() {
      if (!win.end()) return
      if (latest) apply(latest) // 出し終えたので、その記録を ack へ回す
    },
    visibilityChanged() { if (!stopped && latest) apply(latest) },
    stop() { stopped = true; watch.stop() },
  }
}
