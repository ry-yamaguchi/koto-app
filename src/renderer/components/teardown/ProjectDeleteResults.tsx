// ProjectDeleteResults.tsx — プロジェクトの削除の結果の欄（「🗑 ゴミ箱に移動」を押したあとに、ダイアログのボタンの上へ出す）。
//
// 段階3A（3A-5b）。設計書: docs/teardown-unify-plan.md の 10.9.5。**描くだけ**（判断を持たない）。何が起きたか・次に何をするかは
// ProjectDeletePhase（teardown/projectDelete.ts）が決め、公開先ごとの結果は TeardownResultView（【公開】・📡 の 🗑 と同じ部品）が描く。
// これまで小さな警告の窓（window.alert）に連ねていた文を、削除の画面の中に出す（window.alert・window.confirm はここにもダイアログにも書かない）。
//   stopped … 破棄を完了できなかった（フォルダは移していない）。押し直すと、残った公開先の破棄だけをやり直す。尻は、公開なしの回（済んでいない step がすべて残りの段）だけ
//             保存場所などの言い方にする（projectDeleteStoppedTail。0.6.24 A-7）
//   review  … 破棄は済んだが残ったものがある（フォルダはまだ移していない）。見てから、もう一度押すと移す
//   blocked … 止める理由がある（フォルダは移していない）。赤い箱が同じ文を出しているときは重ねない（showBlockNote）
//   twinsGone … 破棄を外した公開先の覆う複製が見つからなくなった（main の断りの文をそのまま出す。画面は材料を読み直して赤い箱を描き直し済み。押し直すと破棄から始める）
//   trashFailed … 破棄は済んだが、フォルダをゴミ箱へ移せなかった。押すと移すだけをやり直す
//   trashed … 移した（ダイアログはもう閉じている）。何も描かない
// 残りの段（共用型の行が無いのに記録の残りを破棄する段。step に leftover の印がある）は、見出しを名詞（label。保存場所など）で言い、
// 消すものが無かった（nothingToDo）ときは描かない（HANAMII が保存場所ごと消した回に、何も無い行を出さない。0.6.24 A-5）。
// 「AIに相談する」は出さない（Sidebar には AI へ渡す口が無い）。
import { PUBLISH_TARGET_CONSOLE } from '../../publishStatus'
import type { ProjectDeletePhase } from '../../teardown/projectDelete'
import {
  projectDeleteBlockNote, stepLabelOf, PROJECT_DELETE_STOPPED_HEAD, PROJECT_DELETE_REVIEW_HEAD, PROJECT_DELETE_REVIEW_TAIL,
  type ProjectDeleteStep,
} from '../../teardown/projectDeletePlan'
import { projectDeleteStoppedTail } from '../../teardown/projectDeleteWords'
import { CONTROL_PANEL_URL } from '../ServicePrincipalSection'
import TeardownResultView from './TeardownResultView'

/** 公開先1つぶん（残りの段は名詞で）。結果の部品で描けるもの（view と words がある）は部品へ、無いもの（やめた・専有型の砦・例外）は1行を選択できる形で出す。 */
function StepView({ step }: { step: ProjectDeleteStep }) {
  const label = stepLabelOf(step)
  if (step.kind === 'nothingToDo') {
    if (step.leftover === true) return null // 残りの段で、消すものが無かった（HANAMII が保存場所ごと消した回）。描かない
    return <p className="text-ink-secondary select-text">{label}: {step.message || '破棄するものはありません。'}</p>
  }
  if (step.kind === 'cancelled') return <p className="text-brand-red select-text">{step.line}</p>
  if (step.view !== null && step.words !== null) {
    return (
      <div className="space-y-1">
        <p className="text-ink font-medium">{label}</p>
        <TeardownResultView
          view={step.view} notes={[]} words={step.words}
          retryHint="「🗑 ゴミ箱に移動」"
          serviceConsoleUrl={PUBLISH_TARGET_CONSOLE[step.target]} storageConsoleUrl={CONTROL_PANEL_URL}
        />
        {step.kind === 'failed' && step.notStarted && <p className="text-ink-secondary select-text">{step.notStarted}。</p>}
      </div>
    )
  }
  return <p className="text-brand-red select-text">{step.kind === 'failed' ? step.line : label}</p>
}

/** フォルダを移せなかった理由。選択・コピーできる形（TeardownResultView の ErrorBlock と同じ見た目）。 */
function MessageBlock({ msg }: { msg: string }) {
  return (
    <div className="rounded-lg border border-line bg-overlay p-3">
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

export default function ProjectDeleteResults({ run, showBlockNote }: { run: ProjectDeletePhase; showBlockNote: boolean }) {
  if (run.phase === 'trashed') return null
  const head = run.phase === 'stopped' ? PROJECT_DELETE_STOPPED_HEAD : run.phase === 'review' ? PROJECT_DELETE_REVIEW_HEAD : null
  const tail = run.phase === 'stopped' ? projectDeleteStoppedTail(run.steps) : run.phase === 'review' ? PROJECT_DELETE_REVIEW_TAIL : null
  return (
    <div className="space-y-2 text-ink-secondary" data-project-delete-result={run.phase}>
      {head && <p className={`font-medium select-text ${run.phase === 'stopped' ? 'text-brand-red' : 'text-brand-yellow'}`}>{head}</p>}
      {run.steps.map((s, i) => <StepView key={`${s.target}:${i}`} step={s} />)}
      {run.phase === 'blocked' && showBlockNote && (
        <p className="text-brand-red font-medium select-text">⚠️ {projectDeleteBlockNote(run.block)}</p>
      )}
      {(run.phase === 'trashFailed' || run.phase === 'twinsGone') && <MessageBlock msg={run.message} />}
      {tail && <p className="select-text">{tail}</p>}
    </div>
  )
}
