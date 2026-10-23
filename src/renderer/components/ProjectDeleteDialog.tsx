// ProjectDeleteDialog.tsx — プロジェクトの削除の確認ダイアログ（開いたときの読み込み・「🗑 ゴミ箱に移動」を押したあとの流れ・描画）。
//
// 段階3A（3A-5a で Sidebar.tsx から移し、3A-5b で振る舞いを替えた）。設計書: docs/teardown-unify-plan.md の 10.9.5。
// Sidebar.tsx（1,000 行を超える巨大ファイル）にあった削除の確認の状態・読み込み・押したとき・描画を、ここへ移した
// （触った節は 400 行以下のモジュールへ。CLAUDE.md「調査のしかた」）。
//
// ── 判断は持たない。材料を読み、純関数の答えを描き、押したときは pressProjectDelete に任せる ──────────────────────
//   ・材料 facts … 開いたときに readProjectDeleteFacts を 1 回だけ読む（null は読み込みの前）。読み込みの前は「🗑 ゴミ箱に移動」を押せない
//     （公開が無いものとして扱い、破棄も専有型の停止もせずにフォルダが移るのを防ぐ）
//   ・止めるか・先に破棄する公開先 … planProjectDeleteTeardown(facts)（plan.block・plan.teardown）。赤い箱・ボタン・押したときの先頭が、同じ plan.block を見る
//   ・押したとき … pressProjectDelete 1 つ（経路は前回の phase で決まる。ここに分岐を書かない）。結果は run に入れ、ProjectDeleteResults が描く。
//     フォルダを移してよいかの判断は projectDeleteVerdict（失敗・やめた・残りが始まっていない公開先があれば移さない）。
//     残ったものがある回は見せてから、もう一度押したときに移す。window.alert・window.confirm は使わない。
//   ・背景を押しても、押したあとの処理（破棄・フォルダを移す）が終わるまで閉じない。確認（ConfirmModal）の要素をこのダイアログが持つので、
//     閉じると答えを返せない確認が宙に浮き、破棄が進まなくなる。
//   ・赤い箱は開いたときの材料で描く。破棄が済んだ公開先（run の done）は、箱の一覧にもチェックの説明にも出さない（済んだ破棄を「これから消す」と言わない。
//     結果の欄が済んだと言う）。破棄が済まなかった回（stopped）は、pressProjectDelete が材料を読み直して返し、残った公開先だけの箱に更新する。
//   ・押し直しで、読み直した材料に見ていない注意（記録が読めなくなった・共用型の残り）が増えたら、移さずに箱を描き直す。見てからもう一度押す（seen）。
// コンテナレジストリの注記（これまで開いたときに読んだ写しで「残します」と言っていた）は無い。消すかどうかは、続く確認で選ぶ。
// ただし、チェックを外したときの「コンテナレジストリの月額が続きます」は、このプロジェクトのために Koto が作った・ほかが借りていないレジストリがあるときだけ
// 言う（判断は ownRegistryBillingNote。材料は開いたときに読む facts.sharedRegistry）。共用型の行があるだけでは言わない（0.6.22-rc.1 の実機）。
//
// 別のプロジェクトを開き直したときは、Sidebar が key で作り直す（前の結果・チェック・材料を持ち越さない。掟11）。
// 確認の要素 {element} は、背景の div の外（後ろの兄弟）に描く。確認の背景を押した click が、このダイアログの背景の onClick まで届いて両方閉じるのを防ぐ。
// プロジェクトのフォルダをゴミ箱へ移す口（deps.trash）は、この削除の流れではここの 1 か所だけ。ただし、ファイルツリーの deleteEntry（Sidebar.tsx）も
// 汎用の確認だけで fs.trash する。親フォルダを開いていると、子のプロジェクトのフォルダも、この判断（止める理由・破棄・走っている操作の確認）を通らずに移せる
// （3A の範囲外。docs/teardown-unify-plan.md の 10.9.18 の F の (ii) と同じ根で、扱いは親が決める）。公開の記録は、ここでも画面でも消さない（消すのは main の破棄の骨の 1 か所）。

import { useState, useEffect } from 'react'
import { PUBLISH_TARGET_LABEL } from '../publishStatus'
import { readRunningOp } from '../projectMeta'
import { teardownPublished, pressProjectDelete, type ProjectDeletePhase, type ProjectDeleteRunDeps } from '../teardown/projectDelete'
import { readProjectDeleteFacts } from '../teardown/projectDeleteFacts'
import {
  planProjectDeleteTeardown, projectDeleteBlockNote, sharedLeftoverNote, ownRegistryBillingNote, PUBLISH_RECORD_UNREADABLE_NOTE, remainingPlacementsNote, withoutDoneTargets,
  type ProjectDeleteFacts,
} from '../teardown/projectDeletePlan'
import { teardownDataNoteForAll, teardownRemovesStorage } from '../../shared/teardownSupport'
import { useConfirmChoices } from '../useConfirmChoices'
import ManualTeardownNote from './teardown/ManualTeardownNote'
import ProjectDeleteResults from './teardown/ProjectDeleteResults'

export default function ProjectDeleteDialog({ projectDir, onClose, onDeleted }: {
  projectDir: string
  onClose: () => void
  /** フォルダをゴミ箱へ移したあとの後始末（タブ・最近の一覧・ワークスペースの一覧）。 */
  onDeleted: (path: string) => void | Promise<void>
}) {
  /** 削除しようとしているプロジェクトの公開の記録・専有型の記録・保存場所・走っている操作（開いたときに 1 回読む。null は読み込みの前）。「何が公開されたままか」を見せないと、破棄の判断ができない。 */
  const [facts, setFacts] = useState<ProjectDeleteFacts | null>(null)
  /** 「公開も一緒に破棄する」（既定オン＝消し忘れによる課金を止める側を既定にする）。 */
  const [teardownOnDelete, setTeardownOnDelete] = useState(true)
  /** 押したあとの処理の実行中（ボタンと背景を止めて、二重実行と、確認の宙づりを防ぐ）。 */
  const [busy, setBusy] = useState(false)
  /** 「🗑 ゴミ箱に移動」を押したあとの状態（null は、まだ押していない）。 */
  const [run, setRun] = useState<ProjectDeletePhase | null>(null)
  /** 押したあとの処理が思いがけず投げたときの知らせ（フォルダは移していない）。 */
  const [crashed, setCrashed] = useState<string | null>(null)
  /** 公開先ごとの破棄の確認（confirm）と、共用型の「コンテナレジストリも削除する」つきの確認（confirmWithChoices）を、1 つの ConfirmModal で出す。 */
  const { confirm, confirmWithChoices, element } = useConfirmChoices()

  const plan = facts ? planProjectDeleteTeardown(facts) : null

  useEffect(() => {
    let cancelled = false
    // 読めなかった材料は、読む関数が安全な空の値に倒す（公開の記録が読めなかったことは facts.unreadable）。閉じたあとに届いた答えは捨てる。
    readProjectDeleteFacts(projectDir)
      .then(f => { if (!cancelled) setFacts(f) })
      .catch(() => { /* 読む関数は投げない作り。万一投げても、読み込みの前のまま（押せない側に倒れる） */ })
    return () => { cancelled = true }
  }, [projectDir])

  /** 押したときの口。破棄・フォルダの有無・ゴミ箱は、ここで渡す。 */
  const deps: ProjectDeleteRunDeps = {
    readFacts: readProjectDeleteFacts,
    teardown: (d, ts) => teardownPublished(d, ts, { confirm, confirmWithChoices }),
    runningOp: readRunningOp,
    exists: p => window.electronAPI.fs.exists(p),
    trash: p => window.electronAPI.fs.trash(p),
  }

  const press = async () => {
    // 先頭の守り（ボタンも同じ条件で止めてある。ここが最後の砦）。読み込みの前・止める理由があるときは何もしない。
    if (busy || facts === null || plan === null || plan.block !== null) return
    setBusy(true)
    setCrashed(null)
    try {
      const { run: next, facts: fresh } = await pressProjectDelete(projectDir, { plan, run, seen: facts }, teardownOnDelete, deps)
      if (fresh) setFacts(fresh) // 破棄が途中で止まった直後と押し直しで、一覧・チェック・赤い箱を最新にする（増えた注意はここで見せる）
      if (next.phase === 'trashed') {
        try { await onDeleted(projectDir) } finally { onClose() }
        return
      }
      setRun(next)
    } catch (e: any) {
      // 思いがけない失敗。フォルダは移していない（移すのは pressProjectDelete の最後の 1 回だけ）。もう一度押すと、前回の続きの経路で走り直す。
      setCrashed(`プロジェクトの削除の途中でエラーが発生しました: ${e?.message ?? String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const leftoverNote = facts && plan && facts.sharedLeftover !== null && plan.teardown.length === 0 ? sharedLeftoverNote(facts.sharedLeftover) : ''
  // 箱に出すのは、まだ破棄していない公開先だけ（済んだ公開先を「これから消す」と言わない。全部済んだ review・移せなかった回では、一覧もチェックも出ない）
  const doneSteps = run?.steps ?? []
  const shownTargets = facts ? withoutDoneTargets(facts.targets, doneSteps) : []
  const shownTeardown = plan ? withoutDoneTargets(plan.teardown, doneSteps) : []
  // チェックを外したときに言うレジストリの月額。このプロジェクトのために Koto が作った、ほかが使っていないレジストリがあるときだけ（判断は純関数）
  const registryBillingNote = facts ? ownRegistryBillingNote(facts, shownTeardown) : ''

  return (
    <>
      {/* プロジェクト削除の確認ダイアログ（掟5: 破壊操作は必ず確認）。ゴミ箱移動なので復元可能な旨と、
          公開済みのもの・GitHubのバックアップはローカル削除の対象外である旨を明記する。 */}
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
        onClick={() => { if (!busy) onClose() }}
      >
        <div
          className="bg-elevated border border-line rounded-xl p-4 w-[24rem] max-w-[92vw] max-h-[90vh] overflow-y-auto"
          onClick={e => e.stopPropagation()}
        >
          <div className="text-[13px] font-semibold text-ink mb-2">
            プロジェクト「{projectDir.split('/').pop()}」を削除しますか？
          </div>
          <div className="text-[11px] text-ink-secondary leading-relaxed space-y-1.5">
            <p>フォルダごと<b>ゴミ箱へ移動</b>します（Finderのゴミ箱から復元できます）。チャット履歴・🕘履歴もフォルダと一緒に移動します。</p>

            {/* ── 公開したものの後始末（2026-08-09 Ryosuke の指摘）──────────────
                フォルダを消すと .sakura-cloud/state.json（どのレジストリを使っているかの
                唯一の記録）も一緒に消える。消えた後は Koto から後片付けできず、
                月220円が黙って続く。だから削除の前にここで止められるようにする。 */}
            {facts && plan && (shownTargets.length > 0 || facts.unreadable || plan.block !== null || leftoverNote !== '') && (
              <div className="rounded-lg border border-brand-red/50 bg-surface p-2.5 space-y-1.5">
                {facts.unreadable && (
                  <p className="text-brand-red font-medium select-text">⚠️ {PUBLISH_RECORD_UNREADABLE_NOTE}</p>
                )}
                {shownTargets.length > 0 && (
                  <>
                    <p className="text-ink font-medium">このプロジェクトは公開されています</p>
                    <ul className="list-disc pl-4 text-ink-secondary">
                      {shownTargets.map(t => (
                        <li key={t}>
                          {PUBLISH_TARGET_LABEL[t]}
                          <ManualTeardownNote target={t} />
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {plan.block !== null ? (
                  // 止める文は、ここの 1 か所だけ（T094）。専有型の資源（クラスタ・ASG・LB）や保存場所が残っている間・公開や破棄が進んでいる間は、
                  // この画面から削除できない（記録はフォルダの中にしかなく、フォルダを先に消すと月額を二度と止められなくなる）。
                  // 公開先が空でも、クラスタだけ作っていれば同じく止めるので、「公開されています」の見出しが無くてもこの赤字は単独で出る。
                  // チェックの有無に関わらず、ここで完全に止める。
                  <p className="text-brand-red font-medium select-text">
                    ⚠️ {projectDeleteBlockNote(plan.block)}
                  </p>
                ) : shownTeardown.length > 0 && (
                  <>
                    <label className="flex items-start gap-1.5 cursor-pointer pt-0.5">
                      <input
                        type="checkbox"
                        checked={teardownOnDelete}
                        onChange={e => setTeardownOnDelete(e.target.checked)}
                        disabled={busy}
                        className="mt-0.5 accent-[rgb(var(--sakura-rgb))]"
                      />
                      <span className="text-ink font-medium">公開も一緒に破棄する</span>
                    </label>
                    <p className={`pl-5 ${teardownOnDelete ? 'text-ink-muted' : 'text-brand-red'}`}>
                      {teardownOnDelete
                        ? '先に公開を破棄してから、フォルダをゴミ箱へ移します。破棄に失敗したときは削除しません。'
                        : '公開はそのまま残ります。フォルダを消すと「どこに何を公開したか」の記録も消えるため、あとから Koto では破棄できなくなります。'
                          + (registryBillingNote ? ` ${registryBillingNote}` : '')}
                    </p>
                    {/* W-22（案1後半）: チェックを外して破棄しないときも、保存場所が残ることをその場で伝える（下の💾行は teardownOnDelete のときだけ
                        描くため、外したときはこちらが無いと保存場所の話が画面から消えてしまう）。同じ保存場所をプレフィックス違いで2件持つと
                        bucket 名が重複するので、名前の重複を除き、2件以上あるときは「1つにつき」と明記する（remainingPlacementsNote）。 */}
                    {!teardownOnDelete && facts.placements.length > 0 && (
                      <p className="pl-5 text-brand-red select-text">
                        💾 {remainingPlacementsNote(facts.placements)}
                      </p>
                    )}
                    {/* ── 保存場所のデータも消える（2026-09-25 検分の指摘2・3巡目の指摘3）──────
                        破棄はバケットの中のこのプロジェクトのデータと鍵まで片づけ、ほかに使っているプロジェクトが無ければ**バケットそのものも消す**。
                        チェックひとつで一気に進む操作なので、**消えるものを名指しで見せてから押させる**（掟5・掟10）。
                        ⚠️ **公開先を決め打ちで書かない。** 判定は一元定義（teardownRemovesStorage）に通し、**新しい公開先が増えても勝手に正しくなる**形にする。
                        先に破棄する公開先（plan.teardown）だけを回し、文の組み立ては shared/teardownSupport.ts の純関数に任せ、placements（全件）で
                        組み立てる。公開先ごとに1行出すので、HANAMII と共用型が両方ある案件でも取りこぼさない。 */}
                    {teardownOnDelete && shownTeardown
                      .filter(t => teardownRemovesStorage(t))
                      .map(t => ({ t, note: teardownDataNoteForAll({ target: t, placements: facts.placements }) }))
                      .filter(x => !!x.note)
                      .map(x => (
                        <p key={x.t} className="pl-5 text-brand-red select-text">
                          💾 {PUBLISH_TARGET_LABEL[x.t]}: {x.note}
                        </p>
                      ))}
                  </>
                )}
                {/* 共用型の公開先の行は無いのに、共用型の記録（保存場所・コンテナレジストリ）に消すものが残っているとき。
                    破棄はしない・止めない（利用者が決められる。フォルダはゴミ箱から戻せる）が、フォルダと一緒に記録が移り、月額が Koto から辿れなくなる。 */}
                {leftoverNote !== '' && (
                  <p className="text-brand-red select-text">💾 {leftoverNote}</p>
                )}
              </div>
            )}

            <p className="text-ink-muted">GitHub に保存したファイル（コード）は<b>そのまま残ります</b>。アプリに入っているデータは GitHub には入っていません。</p>
            <p className="font-mono text-[10px] text-ink-muted break-all">{projectDir}</p>
            {run !== null && <ProjectDeleteResults run={run} showBlockNote={plan === null || plan.block === null} />}
            {crashed !== null && <p className="text-brand-red select-text">⚠️ {crashed}</p>}
          </div>
          <div className="flex justify-end gap-2 mt-3">
            <button
              onClick={onClose}
              disabled={busy}
              className="px-3 py-1.5 rounded-md text-[12px] text-ink-secondary hover:bg-overlay transition-colors disabled:opacity-40"
            >{run?.phase === 'review' ? '移さずに閉じる' : 'キャンセル'}</button>
            <button
              onClick={press}
              disabled={busy || plan === null || plan.block !== null}
              className="px-3 py-1.5 rounded-md text-[12px] font-semibold text-white bg-brand-red-fill hover:opacity-90 transition-opacity disabled:opacity-40"
            >{busy ? '公開を破棄しています…' : '🗑 ゴミ箱に移動'}</button>
          </div>
        </div>
      </div>
      {element}
    </>
  )
}
