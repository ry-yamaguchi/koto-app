// TeardownResultView.tsx — 破棄（削除）の結果の見た目。公開先によらず、共通の1つ（TeardownView を描く）。
//
// 段階0で作った部品（いまは3つの公開先〔共用型・HANAMII・専有型〕の入口がすべてこれを通る）。設計書: docs/teardown-unify-plan.md の 10.3.2 (8)。
// 3つの公開先の結果欄は、これだけ（専有型の DedicatedTeardownView.tsx は 0.6.22 段階3B-7 で消した）。
// 専有型のパネルの手順5・8の結果欄は DedicatedOpsParts.tsx の ErrorBlock・ResumedNotesView を使い、共通の部品はそれを import しない（向きの決まり）。
// 描くだけの部品（判断を持たない）。何が起きたかの読み方は src/shared/teardownResult.ts の TeardownView が1つに決める。
//
// 入口ごとに違ってよいのは、押し直すボタンの呼び方（retryHint）・失敗のときの「AIに相談する」を出すか（onAskAi）・
// 保存場所だけが残ったときの案内（storageRetryHint・storageRetryAction）・管理画面の行き先（serviceConsoleUrl・storageConsoleUrl）だけ。
//
// 警告の書き出しの定数（TEARDOWN_REMAINING_WARNING_HEAD・TEARDOWN_IN_PROGRESS_WARNING_HEAD）は、警告の文を作る
// src/shared/teardownResult.ts から import する（ここに写さない）。画面の側に写した定数は誰も main と結ばず、
// 書き出しが食い違っても重複が出るだけで気づけない。
import { askAiAboutFailure } from '../../../shared/askAi'
import { warningLine, warningsNotRepeatedIn } from '../../../shared/opsText'
import { TEARDOWN_REMAINING_WARNING_HEAD, TEARDOWN_IN_PROGRESS_WARNING_HEAD, teardownRemainingHeadFor, type TeardownView } from '../../../shared/teardownResult'
import { teardownCallLine } from '../../../shared/teardownCall'
import { STORAGE_CHECK_BEFORE_DELETE, STORAGE_LISTED_CHECK } from '../../../shared/teardownSupport'
import type { TeardownWords } from '../../teardown/types'
import type { TeardownResumedNote } from '../../teardown/watch'
import StageTimingDetails from '../StageTimingDetails'

/**
 * 失敗の結果に、**残っているもの**（または、やりかけたこと）があるか。ある失敗にだけ、赤い「残っている間は課金が続きます」を出す。
 *
 * 何も始まっていない失敗——別の操作が走っていて断られた・キーが無い・消すものが記録に無い——は、`executed` も `remaining` も空。
 * そこで「削除できずに残っているものがあります。残っている間は課金が続きます」と出すと、中身の無い一覧つきで、
 * 起きていない課金の話をすることになる。理由は ErrorBlock（message）が言う。
 */
export function teardownFailureHasLeftover(view: Pick<TeardownView, 'executed' | 'remaining'>): boolean {
  return (view.executed?.length ?? 0) > 0 || (view.remaining?.length ?? 0) > 0
}

/** 結果の一言の色（shared の teardownCallLine の tone）。 */
const NOTE_TONE_CLASS = { ok: 'text-brand-green', wait: 'text-brand-yellow', fail: 'text-brand-red', plain: 'text-ink-secondary' } as const

// 閉じて開き直したあとの結果に添える知らせ（見出し＋見逃してはいけない知らせ）。警告は黄色で出す。
// 古い記録（最新でないもの）は結果欄が出さないので、結果の一言もここで出す。
// `shownInResult` は、結果欄がいま警告の欄に出している文（warningLine を通したあと）。最新の1件の警告のうち、
// これと同じ文は結果欄が出すので、ここでは出さない（その場の結果は1回なのに、開き直すと2回出る、にしない）。
// 古い記録の警告は結果欄が出さないので、全件ここで出す。結果欄が出さない文は、最新の1件でもここに残る（落とさない）。
function ResumedNotesView({ notes, shownInResult }: { notes: TeardownResumedNote[]; shownInResult: readonly string[] }) {
  if (notes.length === 0) return null
  return (
    <div className="space-y-1.5">
      {notes.map((n, i) => {
        // 最新の1件の結果の一言は、結果欄が出す。
        const isLatest = i === notes.length - 1
        const noteWarnings = isLatest ? n.warnings.filter(w => !shownInResult.includes(w)) : n.warnings
        // 結果の一言は、記録の呼び名（済んだ／途中／失敗）から作る（`ok` だけで失敗と言わない。受け付けただけの回は途中）。
        // 「Koto の終了で止まりました」の知らせは失敗ではない（見出しが言っている）。次の操作の案内だけを出す。
        const line = isLatest ? null : teardownCallLine(n.call, n.message)
        return (
          <div key={n.startedAt} className="rounded-lg border border-brand-yellow/70 bg-overlay p-3 space-y-1" data-teardown-note>
            <p className="text-xs font-semibold text-ink leading-relaxed">{n.headline}</p>
            {line && (
              <p className={`text-xs leading-relaxed select-text ${NOTE_TONE_CLASS[line.tone]}`}>{line.text}</p>
            )}
            {noteWarnings.map((w, j) => (
              <p key={j} className="text-xs text-brand-yellow leading-relaxed select-text whitespace-pre-wrap">{w}</p>
            ))}
          </div>
        )
      })}
    </div>
  )
}

// 失敗メッセージの表示ブロック（掟5: select-text＋コピーボタン）。
function ErrorBlock({ msg }: { msg: string }) {
  return (
    <div className="rounded-lg border border-line bg-overlay p-3 space-y-1">
      <div className="flex items-start gap-2">
        <p className="flex-1 text-xs text-ink-secondary leading-relaxed whitespace-pre-wrap break-all select-text">{msg}</p>
        <button
          onClick={() => { navigator.clipboard.writeText(msg).catch(() => {}) }}
          className="flex-none text-[11px] text-sakura hover:underline"
          title="メッセージをコピー"
        >コピー</button>
      </div>
    </div>
  )
}

/**
 * 結果。閉じて開き直したときの知らせ（警告）を上に、結果の本体をその下に出す。
 * `view` が無ければ知らせだけ（無ければ何も描かない）。結果を出すかの判断は `view !== null` の1つ
 * （専有型のパネルの shouldShowTeardownResult と同じ判断）。
 */
export default function TeardownResultView({ view, notes, words, retryHint, serviceConsoleUrl, storageConsoleUrl, onAskAi, storageRetryHint, storageRetryAction }: {
  view: TeardownView | null
  /** 閉じて開き直したあとの結果に添える知らせ（見逃してはいけない警告）。 */
  notes: TeardownResumedNote[]
  words: TeardownWords
  /** 「{動詞}中です。しばらくして○○をもう一度押してください」の ○○（入口ごとの押し直す場所）。 */
  retryHint: string
  /** 公開先の管理画面。入口が PUBLISH_TARGET_CONSOLE[target]（publishStatus.ts）から渡す（HANAMII は https://hanamii.jp/）。 */
  serviceConsoleUrl: string
  /** 保存場所を消せる管理画面。公開先によらず、さくらのクラウドのコントロールパネル。 */
  storageConsoleUrl: string
  /** 失敗のとき「AIに相談する」を出すなら、その文を受け取る関数。出さない入口は渡さない。 */
  onAskAi?: (text: string) => void
  /**
   * 保存場所だけが残ったときに添える、もう一度破棄できる場所の案内（入口ごとに違う）。押し直すボタンが同じ節の中にある入口は渡さない。
   * 一覧では、専有型・HANAMII の行は保存場所まで片づくまで残り（共用型は旧い形の記録の行だけ、公開先のものが消えた時点で消えうる）、
   * 結果は行の外（一覧の上）に出る。どの行のボタンで押し直すかを教える。
   */
  storageRetryHint?: string
  /** `storageRetryHint` の文に続けて出す、押し直せる場所へ行くボタン。`storageRetryHint` と同じ条件（保存場所が残った失敗）のときだけ出る。 */
  storageRetryAction?: { label: string; onClick: () => void }
}) {
  if (view === null) return <ResumedNotesView notes={notes} shownInResult={[]} />

  const inProgressListed = view.state === 'inProgress' && view.inProgress.length > 0
  const remainingListed = view.state === 'failed' && teardownFailureHasLeftover(view)
  const hasStorage = view.remaining.some(l => l.kind === 'storage')
  // 公開先のものが残っている（一覧にある）か、公開先のものが消えたと分からない失敗のとき、公開先の管理画面へ案内する。
  const hasService = view.remaining.some(l => l.kind === 'service') || view.inProgress.some(l => l.kind === 'service')
  const showStorageLink = hasStorage && storageConsoleUrl !== ''
  const showServiceLink = (hasService || (!view.ok && view.appDeleted !== true)) && serviceConsoleUrl !== ''
  // 2つの行き先が同じ（専有型）なら、リンクは1つにして「コントロールパネル」と言う。
  const sameConsole = serviceConsoleUrl === storageConsoleUrl

  // 一覧つきで出すものは、同じ知らせを警告に重ねない。message に含まれる文の警告も重ねない（message をそのまま出すので。本文と同じ文を2回言わない規則は warningsNotRepeatedIn の1つ）。
  const warnings = warningsNotRepeatedIn(view.message, view.warnings.filter(w => {
    if (remainingListed && w.startsWith(TEARDOWN_REMAINING_WARNING_HEAD)) return false
    if (inProgressListed && w.startsWith(TEARDOWN_IN_PROGRESS_WARNING_HEAD)) return false
    return true
  }))

  const headlineClass = view.state === 'done' ? 'text-xs font-semibold text-brand-green'
    : view.state === 'inProgress' ? 'text-xs font-semibold text-brand-yellow'
    : 'text-xs font-semibold text-brand-red'
  const headline = view.state === 'done' ? words.doneHeadline : view.state === 'inProgress' ? words.inProgressHeadline : words.failedHeadline

  return (
    <>
      <ResumedNotesView notes={notes} shownInResult={warnings.map(warningLine)} />
      <div className="space-y-1" data-teardown-result>
        <p className={headlineClass}>{headline}</p>
        {view.executed.map((e, i) => (
          <p key={i} className="text-xs text-brand-green leading-relaxed">✅ {e}</p>
        ))}
        {view.message !== '' && <ErrorBlock msg={view.message} />}
        {warnings.length > 0 && (
          <div className="rounded-lg border border-brand-yellow/70 bg-overlay p-3 space-y-1" data-teardown-warnings>
            {warnings.map((w, i) => (
              <p key={i} className="text-xs text-brand-yellow leading-relaxed select-text whitespace-pre-wrap">{warningLine(w)}</p>
            ))}
          </div>
        )}
        {/* 失敗にも「AIに相談する」を添える（成功時には出さない）。途中（HANAMII が受け付けただけ・待ち切れて止まった・「Koto の終了で止まりました」の知らせ）は
            失敗ではないので出さない（相談の文が「次の失敗が出ました」と言うため）。見出しと同じ呼び名（view.state）で決める。 */}
        {view.state === 'failed' && onAskAi && (
          <button
            onClick={() => onAskAi(askAiAboutFailure('破棄', words.askAiTarget, view.message || '失敗しました'))}
            className="bg-sakura text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90"
          >🤖 AIに相談する</button>
        )}
        {inProgressListed ? (
          // 待ち切れず止まっただけ。記録は残っている＝もう一度押せば再開できる
          // （赤い「残っている間は課金が続きます」＝失敗、とは区別する黄色い注意）。
          <div className="space-y-1 rounded-lg border border-brand-yellow/70 bg-overlay p-3">
            <p className="text-xs font-semibold text-brand-yellow leading-relaxed">
              {words.verb}中です。しばらくして{retryHint}をもう一度押してください。
            </p>
            <ul className="text-xs text-ink-secondary leading-relaxed list-disc pl-5">
              {view.inProgress.map((l, i) => <li key={i}>{l.label}</li>)}
            </ul>
          </div>
        ) : remainingListed && (
          <div className="space-y-1">
            <p className="text-xs font-semibold text-brand-red leading-relaxed">
              {teardownRemainingHeadFor(words.verb)}。コントロールパネルから直接削除することもできます。
            </p>
            <ul className="text-xs text-ink-secondary leading-relaxed list-disc pl-5">
              {/* 削除の順（アプリ → ロードバランサ → ASG → クラスタ → 保存場所）に並べてある。保存場所の片づけだけが失敗した回は、
                  公開先のものが1件も無い（全部消えている）。ここに出さないと「何かが残っているらしいが、何かは出ていない」状態になる。 */}
              {view.remaining.map((l, i) => <li key={i}>{l.label}</li>)}
            </ul>
            {/* 保存場所は、ほかのプロジェクトも使っていることがある。message が同じ確かめを言っているときは、重ねない。 */}
            {hasStorage && !view.message.includes(STORAGE_CHECK_BEFORE_DELETE) && (
              <p className="text-xs text-ink-secondary leading-relaxed select-text">{STORAGE_LISTED_CHECK}</p>
            )}
            {hasStorage && storageRetryHint && (
              <p className="text-xs text-ink-secondary leading-relaxed select-text">{storageRetryHint}</p>
            )}
            {hasStorage && storageRetryHint && storageRetryAction && (
              <button
                onClick={storageRetryAction.onClick}
                className="text-[11px] border border-line rounded-md px-1.5 py-0.5 text-ink-muted hover:text-ink hover:border-sakura whitespace-nowrap"
              >{storageRetryAction.label}</button>
            )}
          </div>
        )}
        {/* 管理画面への導線は2つ。保存場所はコントロールパネル、公開先のものはその公開先の管理画面。 */}
        {(showStorageLink || showServiceLink) && (
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {showStorageLink && (
              <a href={storageConsoleUrl} className="inline-block text-[11px] text-sakura hover:underline" data-teardown-storage-console>🔧 コントロールパネルを開く</a>
            )}
            {showServiceLink && !(showStorageLink && sameConsole) && (
              <a href={serviceConsoleUrl} className="inline-block text-[11px] text-sakura hover:underline" data-teardown-service-console>
                {sameConsole ? '🔧 コントロールパネルを開く' : '🔧 管理画面を開く'}
              </a>
            )}
          </div>
        )}
        <StageTimingDetails timings={view.stageTimings} />
      </div>
    </>
  )
}
