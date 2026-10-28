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
// HANAMII の確認で「キャンセル」と答えたのは、HANAMII のアプリとそのデータを残す、という選択。ところが共用型の破棄は、同じ保存場所の
// 同じ prefix のデータを消す（HANAMII も同じ env.json・同じ prefix を使う）ので、続けると、残すと決めた HANAMII のアプリのデータが消える。
// そのうえ画面は「やめた」とだけ言い、共用型を消したことを言わなかった。だから、やめたらそこで止める（break）。
//
// ── HANAMII が済んでいなければ、共用型の段（残りの段を含む）も始めない（0.6.24 A-5・作者の決定 D1「済むまで保存場所に触らない」）──────────
// HANAMII が受け付けただけ（202・deletionAccepted）・消せなかった・保存場所だけ残った（ok:false）・例外のとき、同じ押しの中で共用型の段は始めない。行の有無によらない
// （共用型の行がある回も、行が無いのに記録の残りだけを破棄する回〔plan.leftover〕も）。HANAMII の削除が済む前に保存場所の中身を消すと、まだ動いている HANAMII のアプリのデータが消えうる
// （main の hanamiiTeardown も、済むまで保存場所に触らない）。共用型の step は積まない（判断が「step が無い」として、フォルダを移さない）。
// 失敗の行の末尾に「…の破棄も始めていません」を足す（キャンセルと同じ形）。以前（親の判断 2026-10-10）は、HANAMII が失敗しても共用型へ進んでいた。
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
import { sharedTeardownSpec, SHARED_KEY_MISSING_MESSAGE, type SharedTeardownRecord } from './targets/shared'
import {
  planProjectDeleteTeardown, projectDeleteVerdict, keptLinesOf, noticesAddedSince, sharedLeftoverGateOf,
  type LeftoverStepMark, type ProjectDeleteBlock, type ProjectDeleteFacts, type ProjectDeletePlan, type ProjectDeleteStep, type RunningOpEntry,
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

/** teardownPublished の任意の引数。 */
export type TeardownPublishedOpts = {
  /**
   * plan.leftover。共用型の行が無いのに、記録の残りを破棄する段（'sakura-apprun'）を足した回だけ渡す（0.6.24 A-5）。
   * その段の step に leftover の印と、名詞（label。noun が文字列のとき。保存場所など）を付け、「…の破棄も始めていません」でも名詞で呼ぶ。渡さない回は今のまま。
   */
  leftover?: { noun: string | null }
}

/**
 * このプロジェクトの公開を破棄する。**公開先1つぶんの結果（ProjectDeleteStep）の配列を返す**。
 * 移してよいかは、呼び手が projectDeleteVerdict で決める（failed・cancelled があれば移さない）。
 * 破棄の口が無い公開先（Vercel・レンタルサーバ）は対象外（step を作らない）。消せないものを消せたことにしない。
 * 共用型の段は、HANAMII が済んでいなければ始めない（上の注）。やめた回も、残りの公開先は始めない。
 */
export async function teardownPublished(dir: string, targets: PublishTargetKind[], ctx: ProjectDeleteTeardownCtx, opts?: TeardownPublishedOpts): Promise<ProjectDeleteStep[]> {
  const steps: ProjectDeleteStep[] = []
  // 残りの段（共用型の行が無いのに、記録の残りを破棄する段）か。plan.leftover を渡された回の 'sakura-apprun' だけ。
  const isLeftoverStage = (t: PublishTargetKind): boolean => t === 'sakura-apprun' && opts?.leftover !== undefined
  const noun = typeof opts?.leftover?.noun === 'string' && opts.leftover.noun !== '' ? opts.leftover.noun : null
  /** 残りの段の step に付ける印（残りの段でなければ付けない）。名詞が null（アプリが残る回＝公開の回）は label を付けず、公開先の名前で言う。 */
  const markOf = (t: PublishTargetKind): LeftoverStepMark => isLeftoverStage(t) ? { leftover: true, ...(noun !== null ? { label: noun } : {}) } : {}
  /** 行・「始めていません」に出す呼び名。 */
  const nameOf = (t: PublishTargetKind): string => isLeftoverStage(t) && noun !== null ? noun : PUBLISH_TARGET_LABEL[t]
  /** i 番目のあとに並ぶ、破棄できる公開先（このあと始めない）を「・」でつないで「…の破棄も始めていません」にした文。無ければ空。 */
  const notStartedNote = (i: number): string => {
    const rest = targets.slice(i + 1).filter(x => teardownSupport(x) === 'supported')
    return rest.length > 0 ? `${rest.map(nameOf).join('・')}の破棄も始めていません` : ''
  }
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
          // 残りの段だけ、流れが読み直した記録に、plan と同じ門（sharedLeftoverGateOf）をかけ直す（0.6.24 R4-e）。HANAMII が保存場所を消し切ったあと、借り手のいる
          // コンテナレジストリだけが残った回は、門を通らない＝確認を出さず nothingToDo（何も消さない確認を、公開の見出しで出さない）。
          ...(isLeftoverStage(t) ? { hasWork: (record: SharedTeardownRecord) => sharedLeftoverGateOf(record) !== null } : {}),
        }))
        if (outcome.cancelled) {
          // やめたのに、フォルダだけ移すことはしない（cancelled の step があれば移さない）。残りの公開先の破棄も始めない（上の注）。
          const note = notStartedNote(i)
          steps.push({
            target: t, kind: 'cancelled',
            line: `${nameOf(t)}: 破棄をキャンセルしました` + (note ? `。${note}` : ''),
            ...markOf(t),
          })
          break
        }
        if (outcome.nothingToDo === true) {
          // 消すものが記録に無い行（幽霊の行）。破棄するものが無いのは失敗ではない（failed を積むとフォルダを移せない）。確認も出していない・何も消していない。
          // 残りの段なら、結果の欄は描かない（HANAMII が保存場所ごと消した回。0.6.24 A-5）。
          steps.push({ target: t, kind: 'nothingToDo', message: outcome.result.message ?? '', ...markOf(t) })
        } else if (!outcome.result.ok) {
          // ok:false は、消えなかった・保存場所だけ残った・断られた、のいずれも失敗に積む。公開の記録は main が片づける（ここでは消さない）。
          steps.push({
            target: t, kind: 'failed',
            line: `${nameOf(t)}: ${outcome.result.message ?? '原因不明'}`,
            view: sharedTeardownSpec.toView(outcome.result), words: sharedTeardownSpec.words,
            ...markOf(t),
          })
        } else {
          // 済んだが知らせがある回（残した保存場所・残したレジストリ・鍵の ⚠️）は view.warnings に入る。呼び手が移す前に見せる。
          steps.push({ target: t, kind: 'done', view: sharedTeardownSpec.toView(outcome.result), words: sharedTeardownSpec.words, ...markOf(t) })
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
          const note = notStartedNote(i)
          steps.push({
            target: t, kind: 'cancelled',
            line: `${PUBLISH_TARGET_LABEL[t]}: 破棄をキャンセルしました` + (note ? `。${note}` : ''),
          })
          break
        }
        if (!outcome.result.ok) {
          // ok:false は、消えなかった・受け付けただけ（202）・保存場所だけ残った、のいずれも失敗に積む。公開の記録は main が片づける（ここでは消さない）。
          // **HANAMII が済んでいないので、あとの公開先（共用型・残りの段）は始めない**（0.6.24 A-5。上の注）。step を積まないので、判断が「step が無い」として移さない。
          // 結果の部品（view）で出す回は line を描かないので、同じ文を notStarted にも持つ（結果の欄が別に出す）。
          const note = notStartedNote(i)
          const base = `${PUBLISH_TARGET_LABEL[t]}: ${outcome.result.message ?? '原因不明'}`
          steps.push({
            target: t, kind: 'failed',
            line: note ? `${base.replace(/。$/, '')}。${note}` : base,
            view: hanamiiTeardownSpec.toView(outcome.result), words: hanamiiTeardownSpec.words,
            ...(note ? { notStarted: note } : {}),
          })
          break
        }
        // 済んだが知らせがある回（残した保存場所・鍵の ⚠️）は view.warnings に入る。呼び手が移す前に見せる。
        steps.push({ target: t, kind: 'done', view: hanamiiTeardownSpec.toView(outcome.result), words: hanamiiTeardownSpec.words })
      } else {
        // teardownSupport が 'supported' と言うのに、ここに破棄の枝が無い種類。
        // 以前は「sakura-apprun でなければ HANAMII」の二値前提で、新しい種類が HANAMII の
        // 破棄へ流れて誤った失敗理由（プロジェクトIDが無い）になっていた。黙って通さず失敗に積む
        // （消せないものを消せたことにしない）。
        steps.push({ target: t, kind: 'failed', line: `${PUBLISH_TARGET_LABEL[t]}: この画面からは破棄できません`, view: null, words: null })
      }
    } catch (e: any) {
      // HANAMII の破棄が投げたときも、済んでいない。あとの公開先は始めない（上の注）。ほかの公開先は、今までどおり次へ進む。
      const note = t === 'hanamii' ? notStartedNote(i) : ''
      const base = `${nameOf(t)}: ${e?.message ?? String(e)}`
      steps.push({
        target: t, kind: 'failed',
        line: note ? `${base.replace(/。$/, '')}。${note}` : base,
        view: null, words: null,
        ...markOf(t),
        ...(note ? { notStarted: note } : {}),
      })
      if (t === 'hanamii') break
    }
  }
  return steps
}

// ── 走らせる関数（3A-4b）──────────────────────────────────────────────────────────────────

/** 「🗑 ゴミ箱に移動」を押したあとの状態。フォルダを移したのは 'trashed' だけ。 */
export type ProjectDeletePhase =
  | { phase: 'blocked'; block: Exclude<ProjectDeleteBlock, null>; steps: ProjectDeleteStep[] } // 止める理由がある。フォルダは移していない
  | { phase: 'twinsGone'; steps: ProjectDeleteStep[]; message: string } // 破棄を外した公開先の覆う複製が見つからなくなった（main の断り）。フォルダは移していない。材料を読み直して、押し直すと破棄から始める
  | { phase: 'stopped'; steps: ProjectDeleteStep[] }   // 破棄が済まなかった。フォルダは移していない
  | { phase: 'review'; steps: ProjectDeleteStep[] }    // 済んだが残ったものがある。フォルダはまだ移していない
  | { phase: 'trashed'; steps: ProjectDeleteStep[] }
  | { phase: 'trashFailed'; steps: ProjectDeleteStep[]; message: string }

/**
 * main の `fs:trashProject` が、覆う複製が見つからなくなったと断った（`reason: 'twins-gone'`）。`deps.trash` はこれを投げ、`moveProjectToTrash` が
 * `twinsGone` の phase にする（ほかの失敗は trashFailed。こちらは材料を読み直して plan を作り直す道に乗る）。message は main の文そのまま。
 */
export class TwinsGoneError extends Error {}

export type ProjectDeleteRunDeps = {
  readFacts: (dir: string) => Promise<ProjectDeleteFacts>
  /** 公開先の破棄（teardownPublished）。第3引数は plan.leftover を渡す口（残りの段を足した回だけ付く。0.6.24 A-5）。 */
  teardown: (dir: string, targets: PublishTargetKind[], opts?: TeardownPublishedOpts) => Promise<ProjectDeleteStep[]>
  /** いま走っている操作（readRunningOp）。フォルダを移す直前にもう一度聞く。 */
  runningOp: (dir: string) => Promise<RunningOpEntry | null>
  exists: (path: string) => Promise<boolean>
  /**
   * フォルダを移す（main の fs:trashProject）。`skippedForTwins` は、plan が覆う複製があるために破棄を外した公開先（`skippedForTwinsOf(plan)`）。
   * main は移す直前に、その公開先の覆う複製を読み直す。覆う複製が見つからなくなった断りは `TwinsGoneError` で投げ、それ以外の失敗は Error で投げる。
   */
  trash: (path: string, skippedForTwins: PublishTargetKind[]) => Promise<void>
}

/** plan が、覆う複製があるために破棄を外した公開先（main の `fs:trashProject` の `skippedForTwins`。main が移す直前に覆う複製を読み直す。R2-e）。 */
export const skippedForTwinsOf = (plan: ProjectDeletePlan): PublishTargetKind[] => plan.twinned.map(x => x.target)

/**
 * フォルダをゴミ箱へ移す。`skippedForTwins` は plan が覆う複製のために破棄を外した公開先（main が移す直前に覆う複製を読み直し、無くなっていれば断る。R2-e）。**まず走っている操作を聞き直す**（公開や破棄の最中にフォルダを移すと、走っている処理がそのあと古いパスへ記録を書き、
 * 作ったものが記録なしで課金され続けうる。開いたときの材料の running は古くなる）。聞けなければ（投げたら）走っていない扱い。
 * 聞いてから移すまでの間に始まる処理は防げない（窓は小さい）。もうフォルダが無ければ（一覧が古かった）成功扱い。
 */
export async function moveProjectToTrash(
  dir: string, steps: ProjectDeleteStep[], deps: Pick<ProjectDeleteRunDeps, 'runningOp' | 'exists' | 'trash'>, skippedForTwins: PublishTargetKind[],
): Promise<ProjectDeletePhase> {
  let running: RunningOpEntry | null = null
  try { running = await deps.runningOp(dir) } catch { running = null }
  if (running) return { phase: 'blocked', block: { reason: 'running', op: running.op, target: running.target }, steps }
  try {
    if (await deps.exists(dir)) await deps.trash(dir, skippedForTwins)
  } catch (e: any) {
    // 覆う複製が見つからなくなった断り: 材料を読み直して plan を作り直す道へ（走っている操作の聞き直しと同じ形。pressProjectDelete が読み直す）
    if (e instanceof TwinsGoneError) return { phase: 'twinsGone', steps, message: e.message }
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
  // 残りの段を足した回（plan.leftover）だけ、第3引数に渡す（足さない回は undefined）。teardownPublished が、その段の step に印と名詞を付ける。
  const steps = teardownOnDelete && plan.teardown.length > 0
    ? await deps.teardown(dir, plan.teardown, plan.leftover ? { leftover: plan.leftover } : undefined)
    : []
  const all = [...carried, ...steps]
  const verdict = projectDeleteVerdict(plan, teardownOnDelete, steps)
  if (!verdict.moveToTrash) return { phase: 'stopped', steps: all }
  if (verdict.hold || keptLinesOf(carried).length > 0) return { phase: 'review', steps: all }
  return moveProjectToTrash(dir, all, deps, skippedForTwinsOf(plan))
}

/**
 * 破棄が済まなかった回（stopped）と、覆う複製が見つからなくなった回（twinsGone）の直後に、材料を読み直して返す。済んだ公開先の記録は main が外すので、
 * 開いたときの材料のままだと、画面の赤い箱とチェックが、済んだ破棄を「これから消す」と言い続ける。複製が消えた回は、開いたときの材料が古い
 * （複製を覆う公開先として破棄から外していた）ので、読み直して plan を作り直す（R2-e）。読み直せなくても、結果（steps）は失わない。
 * それ以外は読み直さない（review・移せなかった回・止めた回は、画面が済んだ公開先を箱から外す。withoutDoneTargets）。
 */
async function withFreshFactsIfStopped(
  dir: string, next: ProjectDeletePhase, current: ProjectDeleteFacts | null, deps: ProjectDeleteRunDeps,
): Promise<{ run: ProjectDeletePhase; facts: ProjectDeleteFacts | null }> {
  if (next.phase !== 'stopped' && next.phase !== 'twinsGone') return { run: next, facts: current }
  try { return { run: next, facts: await deps.readFacts(dir) } } catch { return { run: next, facts: current } }
}

/**
 * 「🗑 ゴミ箱に移動」を押したとき。**経路はここで決める**（画面に分岐を書かない。押し直しで行き止まりにならないための、唯一の定義）。
 *  ・まだ押していない（run が null）→ 最初から走らせる。
 *  ・review・trashFailed → 移すだけをやり直す（破棄は済んでいる。破棄も材料の読み直しもしない）。
 *  ・stopped・blocked・twinsGone → 材料を読み直し、残った公開先の破棄だけをやり直す。最初の材料は古い（HANAMII の破棄が済むと main が projectId と行を
 *    外すので、古い plan のまま押し直すと「消すものが無い」を失敗として積み、何度押しても止まる）。済んだ公開先の step は carried で残す。
 *    読み直した材料（facts）を返す（画面が一覧・赤い箱を最新にする）。
 *    **読み直した材料に、利用者がまだ見ていない注意が増えていたら（noticesAddedSince。記録が読めなくなった・共用型の残りが出てきた）、
 *    破棄も移すこともせずに、新しい材料だけを返す**。画面が赤い箱を描き直し、見てからもう一度押させる（見せないまま移さない。
 *    `seen` は画面がいま見せている材料。見せたあとの押しでは増えていないので、行き止まりにならない）。
 *  ・trashed → 何もしない（ダイアログはもう閉じている）。
 * 破棄が済まなかった回（stopped）と、覆う複製が見つからなくなった回（twinsGone）は、材料を読み直して返す（withFreshFactsIfStopped）。
 */
export async function pressProjectDelete(
  dir: string, prev: { plan: ProjectDeletePlan; run: ProjectDeletePhase | null; seen: ProjectDeleteFacts }, teardownOnDelete: boolean, deps: ProjectDeleteRunDeps,
): Promise<{ run: ProjectDeletePhase; facts: ProjectDeleteFacts | null }> {
  const run = prev.run
  if (run === null) return withFreshFactsIfStopped(dir, await runProjectDelete(dir, prev.plan, teardownOnDelete, deps), null, deps)
  switch (run.phase) {
    case 'review':
    case 'trashFailed':
      // 移すだけをやり直す。覆う複製が見つからなくなっていたら（twinsGone）、材料を読み直して plan を作り直す
      return withFreshFactsIfStopped(dir, await moveProjectToTrash(dir, run.steps, deps, skippedForTwinsOf(prev.plan)), null, deps)
    case 'stopped':
    case 'blocked':
    case 'twinsGone': {
      const facts = await deps.readFacts(dir)
      if (noticesAddedSince(prev.seen, facts, teardownOnDelete)) return { run, facts }
      const plan = planProjectDeleteTeardown(facts)
      const carried = run.steps.filter(s => s.kind === 'done' && !plan.teardown.includes(s.target))
      return withFreshFactsIfStopped(dir, await runProjectDelete(dir, plan, teardownOnDelete, deps, carried), facts, deps)
    }
    default:
      return { run, facts: null } // 'trashed'、知らない phase。何もしない
  }
}
