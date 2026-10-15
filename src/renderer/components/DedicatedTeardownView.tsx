// DedicatedTeardownView.tsx — 専有型の「すべて削除」の進み具合と結果の見た目。
//
// **手順6（専有型タブ）と 📡 公開したもの一覧の「🗑 破棄」が、同じこの部品を使う**（2026-10-08・作者の決定）。
// 入口が違っても、進み具合（段の名前・目安・始まってからの時間・閉じても進むこと）と結果
// （すべて削除しました／削除中です／残っているもの）は同じ見た目・同じ文になる。流れの本体は
// src/renderer/dedicatedTeardownFlow.ts。ここは描くだけ（判断を持たない）。
//
// 入口ごとに違ってよいのは、**押し直すボタンの呼び方**（`retryHint`。「手順6」／「一覧の 🗑 破棄」）と、
// 失敗のときの「🤖 AIに相談する」を出すか（`onAskAi`。📡 の一覧は画面全体を覆うので出さない）だけ。
import { opElapsedText, shouldShowTeardownResult, type DedicatedResumedNote } from '../apprunDedicatedActions'
import { PUBLISH_QUIT_STOPS } from '../activity'
import { askAiAboutFailure } from '../../shared/askAi'
import StageEstimate from './StageEstimate'
import StageTimingDetails from './StageTimingDetails'
import { ErrorBlock, ResumedNotesView } from './DedicatedOpsParts'
import { CONTROL_PANEL_URL } from './ServicePrincipalSection'
import type { DedicatedTeardownResult } from '../dedicatedTeardownFlow'

/**
 * 実行中の進み具合。**削除が走っている間だけ**置く（呼び出し側が tearingDown のときだけ描く）。
 * 段は記録の progress.stage（内部名）で見分ける——文では見分けない。目安が無い段には何も出さない（StageEstimate）。
 */
export function DedicatedTeardownProgress({ progress, runningKind, runningRecord, nowMs }: {
  /** 進み具合の文（teardownProgressText の結果）。 */
  progress: string | null
  /** 記録（projectOps）が「走っている」と言っている操作の種類。 */
  runningKind: string | null
  runningRecord: { startedAt: number; progress?: { stage?: string } } | null
  nowMs: number
}) {
  const recorded = runningKind === 'teardown' && !!runningRecord
  return (
    <>
      {/* #39: 各段が一覧から消えるまで待つ間の進捗（30秒ごとに1回、teardown-progress で届く）。 */}
      {progress && <p className="text-xs text-ink-secondary leading-relaxed select-text" data-teardown-progress>{progress}</p>}
      {/* 待っている段の目安（2026-10-07）。段は記録の progress.stage（内部名）で見分ける。文では見分けない。 */}
      {runningKind === 'teardown' && <StageEstimate stage={runningRecord?.progress?.stage} />}
      {/* 閉じて開き直したあとでも、いつから走っているか・閉じてよいかが分かるように（2026-09-29）。 */}
      {recorded && runningRecord && (
        <>
          <p className="text-[11px] text-ink-muted leading-relaxed">{opElapsedText(runningRecord.startedAt, nowMs)}</p>
          <p className="text-[11px] text-ink-muted leading-relaxed">この画面を閉じても、削除は最後まで進みます。{PUBLISH_QUIT_STOPS}</p>
        </>
      )}
    </>
  )
}

/**
 * 失敗の結果に、**残っているもの**（または、やりかけたこと）があるか。ある失敗にだけ、赤い「残っている間は課金が続きます」を出す。
 *
 * 何も始まっていない失敗——別の操作が走っていて断られた・キーが無い・消すものが記録に無い——は、`executed` も `remaining` も空。
 * そこで「削除できずに残っているものがあります。残っている間は課金が続きます」と出すと、中身の無い一覧つきで、
 * 起きていない課金の話をすることになる（2026-10-08 検分）。理由は上の ErrorBlock（message）が言う。
 */
export function teardownFailureHasLeftover(result: Pick<DedicatedTeardownResult, 'executed' | 'remaining'>): boolean {
  return (result.executed?.length ?? 0) > 0 || Object.values(result.remaining ?? {}).some(v => !!v)
}

/**
 * 結果。閉じて開き直したときの知らせ（警告）を上に、結果の本体をその下に出す。
 * `result` が無ければ知らせだけ（無ければ何も描かない）。
 */
export function DedicatedTeardownResultView({ result, notes, retryHint, onAskAi, storageRetryHint, storageRetryAction }: {
  result: DedicatedTeardownResult | null
  /** 閉じて開き直したあとの結果に添える知らせ（見逃してはいけない警告）。 */
  notes: DedicatedResumedNote[]
  /** 「削除中です。しばらくして○○をもう一度押してください」の ○○（入口ごとの押し直す場所）。 */
  retryHint: string
  /** 失敗のとき「🤖 AIに相談する」を出すなら、その文を受け取る関数。出さない入口は渡さない。 */
  onAskAi?: (text: string) => void
  /**
   * 保存場所だけが残ったときに添える、もう一度削除できる場所の案内（入口ごとに違う）。手順6は押し直すボタンが同じ節の中にある
   * （storageLeftoverNote）ので渡さない。📡 の一覧は、アプリが消えた時点で公開の記録（＝行）が消えるので、押し直す場所を教える。
   */
  storageRetryHint?: string
  /**
   * `storageRetryHint` の文に続けて出す、押し直せる場所へ行くボタン（📡 の一覧は「このプロジェクトを開く」）。
   * 文だけで「○○から開いて」と案内すると、案内した場所が画面に無い（行が消えている）ことがある——ボタンを添えて、その場で行けるようにする
   * （2026-10-08 検分）。`storageRetryHint` と同じ条件（保存場所だけが残った失敗）のときだけ出る。
   */
  storageRetryAction?: { label: string; onClick: () => void }
}) {
  return (
    <>
      <ResumedNotesView notes={notes} />
      {shouldShowTeardownResult(result) && result && (
        <div className="space-y-1" data-teardown-result>
          <p className={result.ok ? 'text-xs font-semibold text-brand-green' : result.inProgress ? 'text-xs font-semibold text-brand-yellow' : 'text-xs font-semibold text-brand-red'}>
            {result.ok ? '✅ すべて削除しました' : result.inProgress ? '⏳ 削除中です' : '⚠️ 削除できませんでした'}
          </p>
          {result.executed.map((e, i) => (
            <p key={i} className="text-xs text-brand-green leading-relaxed">✅ {e}</p>
          ))}
          <ErrorBlock msg={result.message} />
          {/* 判断2: 失敗にも「🤖 AIに相談する」を添える（成功時には出さない）。 */}
          {!result.ok && onAskAi && (
            <button
              onClick={() => onAskAi(askAiAboutFailure('破棄', 'さくらのAppRun（専有型）', result.message ?? '失敗しました'))}
              className="bg-sakura text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90"
            >🤖 AIに相談する</button>
          )}
          {result.inProgress ? (
            // #39: 待ち切れず(timeout)止まっただけ。記録は残っている＝もう一度押せば再開できる
            // （赤い「残っている間は課金が続きます」＝失敗、とは区別する黄色い注意）。
            <div className="space-y-1 rounded-lg border border-brand-yellow/70 bg-overlay p-3">
              <p className="text-xs font-semibold text-brand-yellow leading-relaxed">
                削除中です。しばらくして{retryHint}をもう一度押してください。
              </p>
              <ul className="text-xs text-ink-secondary leading-relaxed list-disc pl-5">
                {/* B（2026-09-17）: 削除順（アプリ→ロードバランサ→ASG→クラスタ）に揃える。 */}
                {result.inProgress.applicationID && <li>アプリケーション『{result.inProgress.applicationID}』</li>}
                {result.inProgress.loadBalancerID && <li>ロードバランサ『{result.inProgress.loadBalancerID}』</li>}
                {result.inProgress.asgID && <li>オートスケーリンググループ『{result.inProgress.asgID}』</li>}
                {result.inProgress.clusterID && <li>クラスタ『{result.inProgress.clusterID}』</li>}
              </ul>
            </div>
          ) : !result.ok && teardownFailureHasLeftover(result) && (
            <div className="space-y-1">
              <p className="text-xs font-semibold text-brand-red leading-relaxed">
                削除できずに残っているものがあります。残っている間は課金が続きます。コントロールパネルから直接削除することもできます。
              </p>
              <ul className="text-xs text-ink-secondary leading-relaxed list-disc pl-5">
                {/* B（2026-09-17）: 削除順（アプリ→ロードバランサ→ASG→クラスタ）に揃える。 */}
                {result.remaining.applicationID && <li>アプリケーション『{result.remaining.applicationID}』</li>}
                {result.remaining.loadBalancerID && <li>ロードバランサ『{result.remaining.loadBalancerID}』</li>}
                {result.remaining.asgID && <li>オートスケーリンググループ『{result.remaining.asgID}』</li>}
                {result.remaining.clusterID && <li>クラスタ『{result.remaining.clusterID}』</li>}
                {/* 2026-09-24 検分の指摘5: 保存場所の片づけだけが失敗した回は、計算資源のIDが
                    1件も無い（全部消えている）。ここに出さないと「何かが残っているらしいが、
                    何が残っているのか一覧には出ていない」状態になる。 */}
                {result.remaining.storageBucket && <li>保存場所『{result.remaining.storageBucket}』（月額が続きます）</li>}
              </ul>
              {result.remaining.storageBucket && storageRetryHint && (
                <p className="text-xs text-ink-secondary leading-relaxed select-text">{storageRetryHint}</p>
              )}
              {result.remaining.storageBucket && storageRetryHint && storageRetryAction && (
                <button
                  onClick={storageRetryAction.onClick}
                  className="text-[11px] border border-line rounded-md px-1.5 py-0.5 text-ink-muted hover:text-ink hover:border-sakura whitespace-nowrap"
                >{storageRetryAction.label}</button>
              )}
              <a href={CONTROL_PANEL_URL} className="inline-block text-[11px] text-sakura hover:underline">🔧 コントロールパネルを開く</a>
            </div>
          )}
          <StageTimingDetails timings={result.stageTimings} />
        </div>
      )}
    </>
  )
}
