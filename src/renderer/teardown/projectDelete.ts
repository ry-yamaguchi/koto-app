// teardown/projectDelete.ts — プロジェクトの削除（ProjectDeleteDialog。もとは Sidebar）で、公開したものを先に破棄する処理。
//
// 段階1の1d（H3）・段階2の2d（S4）。設計書: docs/teardown-unify-plan.md の 10.4.4 の H3・10.7.9 の S4。Sidebar.tsx（1,000行を超える巨大ファイル）の
// teardownPublished だけを、ここへ切り出した（触った節は 400 行以下のモジュールへ。CLAUDE.md「調査のしかた」）。
// 専有型の枝は、文も順序もそのまま移した（段階3で載せ替える）。HANAMII（段階1）と共用型（段階2）の枝が、共通の破棄の流れを通る。
//
// ── HANAMII・共用型の枝（作者の決定 D4=1）─────────────────────────────────────────
// 公開先ごとに、共通の ConfirmModal（他の入口と同じ確認の文）を出してから実行する。確認は、プロジェクト削除のダイアログのあとにもう一度出る。
// 確認の答えが true でなければ、HANAMII へは1回も要求を出さない（掟10。確認の歯止めは流れ〔flow.ts〕の1か所）。
// **仕様書の invoke を直接呼ばない**（確認も窓を閉じる警告もキーなしの失敗も飛ばせてしまう。tests/hanamiiTeardownEntries.test.ts の F-2 が見張る）。
// トークンと projectId は、仕様書が公開の記録から読む（この関数は読まない。公開したときのトークンだけで呼ぶ。D8）。
// 公開の記録（📡 の行・projectId）は、**ここでも画面でも消さない**。消すのは main の hanamii:teardown／cloud:teardown の1か所だけ。
//
// 共用型は、確認に選択（コンテナレジストリも削除するか）が付く。借り物（引き継いだ置き場）の既定はオフで、利用者が選ぶ
// （前は確認が無く、置き場を残すかどうかをこの関数が決め打ちしていた）。既定は押した時点の main の記録（cloud:teardownRecord）から決まる。
// **消すものが記録に無い行（幽霊の行）**は、流れが破棄するものはありませんと返す（`nothingToDo`）。失敗ではないので、積まずに先へ進める
// （積むと、フォルダを移せなくなる）。
//
// ── 返り値 ──────────────────────────────────────────────────────────────────────────
// 公開先1つぶんの結果の配列（ProjectDeleteStep。型と、移してよいかの判断は projectDeletePlan.ts の純関数）。**フォルダをゴミ箱へ移してよいかは、
// 呼び手がこの配列を projectDeleteVerdict に通して決める**（失敗・やめた・残りが始まっていない公開先があれば移さない）。
// やめたとき・HANAMII が削除を受け付けただけのとき（deletionAccepted・ok:false）・保存場所だけ残ったときも、失敗として積む
// （フォルダごと消すと、公開の記録も保存場所の記録も消えて、Koto から破棄できなくなる）。

// ── やめたら、残りの公開先の破棄も始めない（2026-10-09 検分）────────────────────────────────────
// HANAMII の確認で「やめる」と答えたのは、HANAMII のアプリとそのデータを残す、という選択。ところが共用型の破棄は、同じ保存場所の
// 同じ prefix のデータを消す（HANAMII も同じ env.json・同じ prefix を使う）ので、続けると、残すと決めた HANAMII のアプリのデータが消える。
// そのうえ画面は「やめた」とだけ言い、共用型を消したことを言わなかった。だから、やめたらそこで止める（break）。
//
// ── 警告は、その場で見せる（2026-10-09 検分）────────────────────────────────────────────────────
// HANAMII の破棄が ok:true でも、バケットごとは消さずに残した保存場所（月額が続く）や、鍵を無効にできなかった ⚠️ の行を持つことがある。
// 直後にフォルダがゴミ箱へ移ると、保存場所と鍵の唯一の記録（.sakura-cloud/env.json）も消え、処理の記録はメモリ上にしか無いので、
// 開き直して見る場所も無い。そこで済んだ回（kind: 'done'）は view（文は共通の作り手 toView が作る）を持ち、呼び手が view.warnings を
// フォルダを移す前に見せる。共有の保存場所はふつうに残るので、止めはしない（見せてから、もう一度押してもらう。runProjectDelete の review）。
//
// ── 走らせる関数（段階3A の 3A-4b）───────────────────────────────────────────────────────────────
// runProjectDelete・moveProjectToTrash・pressProjectDelete は React を持たない。口（材料・破棄・走っている操作・フォルダの有無・ゴミ箱）は deps で渡す。
// どの経路を通るかは pressProjectDelete の1つ（前回の phase で決まる）。画面に分岐を書かない。

import { PUBLISH_TARGET_LABEL, type PublishTargetKind } from '../publishStatus'
import { teardownSupport } from '../../shared/teardownSupport'
import type { ConfirmOptions } from '../useConfirm'
import type { ConfirmWithChoicesAnswer, ConfirmWithChoicesOptions } from '../useConfirmChoices'
import { runTeardownFlow, electronFlowDeps } from './flow'
import { hanamiiTeardownSpec, HANAMII_KEY_MISSING_MESSAGE } from './targets/hanamii'
import { sharedTeardownSpec, SHARED_KEY_MISSING_MESSAGE } from './targets/shared'
import {
  planProjectDeleteTeardown, projectDeleteVerdict, keptLinesOf, noticesAddedSince,
  type ProjectDeleteBlock, type ProjectDeleteFacts, type ProjectDeletePlan, type ProjectDeleteStep, type RunningOpEntry,
} from './projectDeletePlan'

/** プロジェクト削除の破棄が使う、画面側の口。 */
export interface ProjectDeleteTeardownCtx {
  /** ConfirmModal（useConfirm の confirm）。公開先ごとの確認に使う。 */
  confirm: (opts: ConfirmOptions) => Promise<boolean>
  /**
   * 選択つきの確認（useConfirmChoices の confirmWithChoices）。共用型の「コンテナレジストリも削除する」を聞くのに使う。
   * 置き場を消すかどうかの既定は、押した時点の main の記録から決まる（この画面が開いたときの写しは使わない）。
   */
  confirmWithChoices: (opts: ConfirmWithChoicesOptions) => Promise<ConfirmWithChoicesAnswer>
}

/**
 * このプロジェクトの公開を破棄する。**公開先1つぶんの結果（ProjectDeleteStep）の配列を返す**。
 * 移してよいかは、呼び手が projectDeleteVerdict で決める（failed・cancelled があれば移さない）。
 * 破棄の口が無い公開先（Vercel・レンタルサーバ）は対象外（step を作らない）。消せないものを消せたことにしない。
 */
export async function teardownPublished(dir: string, targets: PublishTargetKind[], ctx: ProjectDeleteTeardownCtx): Promise<ProjectDeleteStep[]> {
  const steps: ProjectDeleteStep[] = []
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]
    if (teardownSupport(t) !== 'supported') continue
    try {
      if (t === 'sakura-apprun') {
        // 共通の破棄の流れ（確認 → 実行）。確認の文・選択（コンテナレジストリ）・窓を閉じる警告・キーなしの失敗は流れと仕様書が受け持つ。
        // **ここで置き場を消すかどうかを決めない**（前は決め打ちだった。借りている置き場は断る手段なく消されかねなかった）。
        const outcome = await runTeardownFlow(dir, sharedTeardownSpec, electronFlowDeps(dir, sharedTeardownSpec, {
          confirm: ctx.confirm,
          confirmWithChoices: ctx.confirmWithChoices,
          keyMissingMessage: SHARED_KEY_MISSING_MESSAGE,
        }))
        if (outcome.cancelled) {
          // やめたのに、フォルダだけ移すことはしない（cancelled の step があれば移さない）。残りの公開先の破棄も始めない（上の注）。
          const rest = targets.slice(i + 1).filter(x => teardownSupport(x) === 'supported')
          steps.push({
            target: t, kind: 'cancelled',
            line: `${PUBLISH_TARGET_LABEL[t]}: 破棄をやめました`
              + (rest.length > 0 ? `。${rest.map(x => PUBLISH_TARGET_LABEL[x]).join('・')}の破棄も始めていません` : ''),
          })
          break
        }
        if (outcome.nothingToDo === true) {
          // 消すものが記録に無い行（幽霊の行）。破棄するものが無いのは失敗ではない（failed を積むとフォルダを移せない）。確認も出していない・何も消していない。
          steps.push({ target: t, kind: 'nothingToDo', message: outcome.result.message ?? '' })
        } else if (!outcome.result.ok) {
          // ok:false は、消えなかった・保存場所だけ残った・断られた、のいずれも失敗に積む。公開の記録は main が片づける（ここでは消さない）。
          steps.push({
            target: t, kind: 'failed',
            line: `${PUBLISH_TARGET_LABEL[t]}: ${outcome.result.message ?? '原因不明'}`,
            view: sharedTeardownSpec.toView(outcome.result), words: sharedTeardownSpec.words,
          })
        } else {
          // 済んだが知らせがある回（残した保存場所・残したレジストリ・鍵の ⚠️）は view.warnings に入る。呼び手が移す前に見せる。
          steps.push({ target: t, kind: 'done', view: sharedTeardownSpec.toView(outcome.result), words: sharedTeardownSpec.words })
        }
      } else if (t === 'sakura-apprun-dedicated') {
        // ── 専有型（D-3・2026-09-11 Ryosuke 決定／2026-10-08 に文を直した）─────────────
        // 専有型の削除（アプリ → ロードバランサ → オートスケーリンググループ → クラスタ ＋ 保存場所）は、確認と進み具合
        // （ロードバランサだけで約9分）を持つ長い処理なので、**この画面の中では行わない**。ここでは**明示的に失敗に積む**
        // （failed の step があればフォルダは移らない＝記録を失わせない安全側）。
        // 実際には projectDeleteBlockOf が先に削除そのものを止めるので、ここは最後の砦。
        // 共用型の cloud.teardown へは流さない: 専有型が同じ IPC で消せるか・置き場を使うかは
        // ここからは分からず、推測で呼ぶと違うものを消しかねない（掟1）。
        steps.push({
          target: t, kind: 'failed',
          line: `${PUBLISH_TARGET_LABEL[t]}: 専有型は、この画面からは削除できません。`
            + '専有型タブの「手順6 作ったものを削除する」（または 📡 公開したもの一覧の「🗑 削除」）で削除してから、もう一度お試しください',
          view: null, words: null,
        })
      } else if (t === 'hanamii') {
        // 共通の破棄の流れ（確認 → 実行）。確認の文・窓を閉じる警告・キーなしの失敗・projectDir の受け渡しは流れと仕様書が受け持つ。
        const outcome = await runTeardownFlow(dir, hanamiiTeardownSpec, electronFlowDeps(dir, hanamiiTeardownSpec, {
          confirm: ctx.confirm,
          keyMissingMessage: HANAMII_KEY_MISSING_MESSAGE,
        }))
        if (outcome.cancelled) {
          // やめたのに、フォルダだけ移すことはしない（cancelled の step があれば移さない）。残りの公開先の破棄も始めない（上の注）。
          const rest = targets.slice(i + 1).filter(x => teardownSupport(x) === 'supported')
          steps.push({
            target: t, kind: 'cancelled',
            line: `${PUBLISH_TARGET_LABEL[t]}: 破棄をやめました`
              + (rest.length > 0 ? `。${rest.map(x => PUBLISH_TARGET_LABEL[x]).join('・')}の破棄も始めていません` : ''),
          })
          break
        }
        if (!outcome.result.ok) {
          // ok:false は、消えなかった・受け付けただけ・保存場所だけ残った、のいずれも失敗に積む。公開の記録は main が片づける（ここでは消さない）。
          steps.push({
            target: t, kind: 'failed',
            line: `${PUBLISH_TARGET_LABEL[t]}: ${outcome.result.message ?? '原因不明'}`,
            view: hanamiiTeardownSpec.toView(outcome.result), words: hanamiiTeardownSpec.words,
          })
        } else {
          // 済んだが知らせがある回（残した保存場所・鍵の ⚠️）は view.warnings に入る。呼び手が移す前に見せる。
          steps.push({ target: t, kind: 'done', view: hanamiiTeardownSpec.toView(outcome.result), words: hanamiiTeardownSpec.words })
        }
      } else {
        // teardownSupport が 'supported' と言うのに、ここに破棄の枝が無い種類。
        // 以前は「sakura-apprun でなければ HANAMII」の二値前提で、新しい種類が HANAMII の
        // 破棄へ流れて誤った失敗理由（プロジェクトIDが無い）になっていた。黙って通さず失敗に積む
        // （消せないものを消せたことにしない）。
        steps.push({ target: t, kind: 'failed', line: `${PUBLISH_TARGET_LABEL[t]}: この画面からは破棄できません`, view: null, words: null })
      }
    } catch (e: any) {
      steps.push({ target: t, kind: 'failed', line: `${PUBLISH_TARGET_LABEL[t]}: ${e?.message ?? String(e)}`, view: null, words: null })
    }
  }
  return steps
}

// ── 走らせる関数（3A-4b）──────────────────────────────────────────────────────────────────

/** 「🗑 ゴミ箱に移動」を押したあとの状態。フォルダを移したのは 'trashed' だけ。 */
export type ProjectDeletePhase =
  | { phase: 'blocked'; block: Exclude<ProjectDeleteBlock, null>; steps: ProjectDeleteStep[] } // 止める理由がある。フォルダは移していない
  | { phase: 'stopped'; steps: ProjectDeleteStep[] }   // 破棄が済まなかった。フォルダは移していない
  | { phase: 'review'; steps: ProjectDeleteStep[] }    // 済んだが残ったものがある。フォルダはまだ移していない
  | { phase: 'trashed'; steps: ProjectDeleteStep[] }
  | { phase: 'trashFailed'; steps: ProjectDeleteStep[]; message: string }

export type ProjectDeleteRunDeps = {
  readFacts: (dir: string) => Promise<ProjectDeleteFacts>
  teardown: (dir: string, targets: PublishTargetKind[]) => Promise<ProjectDeleteStep[]>
  /** いま走っている操作（readRunningOp）。フォルダを移す直前にもう一度聞く。 */
  runningOp: (dir: string) => Promise<RunningOpEntry | null>
  exists: (path: string) => Promise<boolean>
  trash: (path: string) => Promise<void>
}

/**
 * フォルダをゴミ箱へ移す。**まず走っている操作を聞き直す**（公開や破棄の最中にフォルダを移すと、走っている処理がそのあと古いパスへ記録を書き、
 * 作ったものが記録なしで課金され続けうる。開いたときの材料の running は古くなる）。聞けなければ（投げたら）走っていない扱い。
 * 聞いてから移すまでの間に始まる処理は防げない（窓は小さい）。もうフォルダが無ければ（一覧が古かった）成功扱い。
 */
export async function moveProjectToTrash(
  dir: string, steps: ProjectDeleteStep[], deps: Pick<ProjectDeleteRunDeps, 'runningOp' | 'exists' | 'trash'>,
): Promise<ProjectDeletePhase> {
  let running: RunningOpEntry | null = null
  try { running = await deps.runningOp(dir) } catch { running = null }
  if (running) return { phase: 'blocked', block: { reason: 'running', op: running.op, target: running.target }, steps }
  try {
    if (await deps.exists(dir)) await deps.trash(dir)
  } catch (e: any) {
    return { phase: 'trashFailed', steps, message: `プロジェクトを削除できませんでした: ${e?.message ?? e}` }
  }
  return { phase: 'trashed', steps }
}

/**
 * 公開先の破棄 → 移してよいかの判断 → フォルダを移す。止める理由があれば何もしない（破棄も移す操作も0回）。
 * `carried` は、前の押しで済んでいた公開先の step（材料を読み直したら出てこない）。移してよいかには効かず、結果の欄と「見せてから移すか」にだけ効く。
 */
export async function runProjectDelete(
  dir: string, plan: ProjectDeletePlan, teardownOnDelete: boolean, deps: ProjectDeleteRunDeps, carried: ProjectDeleteStep[] = [],
): Promise<ProjectDeletePhase> {
  if (plan.block !== null) return { phase: 'blocked', block: plan.block, steps: carried }
  const steps = teardownOnDelete && plan.teardown.length > 0 ? await deps.teardown(dir, plan.teardown) : []
  const all = [...carried, ...steps]
  const verdict = projectDeleteVerdict(plan, teardownOnDelete, steps)
  if (!verdict.moveToTrash) return { phase: 'stopped', steps: all }
  if (verdict.hold || keptLinesOf(carried).length > 0) return { phase: 'review', steps: all }
  return moveProjectToTrash(dir, all, deps)
}

/**
 * 破棄が済まなかった回（stopped）の直後に、材料を読み直して返す。済んだ公開先の記録は main が外すので、開いたときの材料のままだと、
 * 画面の赤い箱とチェックが、済んだ破棄を「これから消す」と言い続ける。読み直せなくても、結果（steps）は失わない。
 * stopped 以外は読み直さない（review・移せなかった回・止めた回は、画面が済んだ公開先を箱から外す。withoutDoneTargets）。
 */
async function withFreshFactsIfStopped(
  dir: string, next: ProjectDeletePhase, current: ProjectDeleteFacts | null, deps: ProjectDeleteRunDeps,
): Promise<{ run: ProjectDeletePhase; facts: ProjectDeleteFacts | null }> {
  if (next.phase !== 'stopped') return { run: next, facts: current }
  try { return { run: next, facts: await deps.readFacts(dir) } } catch { return { run: next, facts: current } }
}

/**
 * 「🗑 ゴミ箱に移動」を押したとき。**経路はここで決める**（画面に分岐を書かない。押し直しで行き止まりにならないための、唯一の定義）。
 *  ・まだ押していない（run が null）→ 最初から走らせる。
 *  ・review・trashFailed → 移すだけをやり直す（破棄は済んでいる。破棄も材料の読み直しもしない）。
 *  ・stopped・blocked → 材料を読み直し、残った公開先の破棄だけをやり直す。最初の材料は古い（HANAMII の破棄が済むと main が projectId と行を
 *    外すので、古い plan のまま押し直すと「消すものが無い」を失敗として積み、何度押しても止まる）。済んだ公開先の step は carried で残す。
 *    読み直した材料（facts）を返す（画面が一覧・赤い箱を最新にする）。
 *    **読み直した材料に、利用者がまだ見ていない注意が増えていたら（noticesAddedSince。記録が読めなくなった・共用型の残りが出てきた）、
 *    破棄も移すこともせずに、新しい材料だけを返す**。画面が赤い箱を描き直し、見てからもう一度押させる（見せないまま移さない。
 *    `seen` は画面がいま見せている材料。見せたあとの押しでは増えていないので、行き止まりにならない）。
 *  ・trashed → 何もしない（ダイアログはもう閉じている）。
 * 破棄が済まなかった回（stopped）は、材料を読み直して返す（withFreshFactsIfStopped）。
 */
export async function pressProjectDelete(
  dir: string, prev: { plan: ProjectDeletePlan; run: ProjectDeletePhase | null; seen: ProjectDeleteFacts }, teardownOnDelete: boolean, deps: ProjectDeleteRunDeps,
): Promise<{ run: ProjectDeletePhase; facts: ProjectDeleteFacts | null }> {
  const run = prev.run
  if (run === null) return withFreshFactsIfStopped(dir, await runProjectDelete(dir, prev.plan, teardownOnDelete, deps), null, deps)
  switch (run.phase) {
    case 'review':
    case 'trashFailed':
      return { run: await moveProjectToTrash(dir, run.steps, deps), facts: null }
    case 'stopped':
    case 'blocked': {
      const facts = await deps.readFacts(dir)
      if (noticesAddedSince(prev.seen, facts)) return { run, facts }
      const plan = planProjectDeleteTeardown(facts)
      const carried = run.steps.filter(s => s.kind === 'done' && !plan.teardown.includes(s.target))
      return withFreshFactsIfStopped(dir, await runProjectDelete(dir, plan, teardownOnDelete, deps, carried), facts, deps)
    }
    default:
      return { run, facts: null } // 'trashed'、知らない phase。何もしない
  }
}
