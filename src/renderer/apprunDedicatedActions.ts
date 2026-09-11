// apprunDedicatedActions.ts — AppRunDedicatedPanel.tsx の「確認→IPC」を、React/DOM から
// 切り離した純関数として持つ（掟10・rollbackSwitch.ts と同型）。
//
// 専有型のクラスタ作成（⑤）・破棄（⑥）は、常時課金3資源を作る/壊す操作（docs/apprun-dedicated-plan.md
// 5-7）。main 側は `opts.confirmed !== true` なら fetch を一切呼ばない歯止めを持つ
// （src/main/cloud/apprunDedicatedApply.ts・2026-09-10 レビューの修理・A）が、その歯止めへ
// `confirmed: true` を渡す判断（＝確認ダイアログを通ったか）を画面の中に埋め込んだままだと、
// 文字列一致のテストでしか固定できない（2026-09-08〜09 の事故と同じ形）。
//
// ここでは confirm・create/teardown を「注入」で受け取り、**偽の confirm/create/teardown を
// 渡した振る舞いテスト**（tests/apprunDedicatedActions.test.ts）で
// 「confirm が false を返したら create/teardown は一度も呼ばれない」
// 「true を返したら { confirmed: true } を付けて1回だけ呼ばれる」ことを固定する。
//
// ── K（2026-09-10 レビューの修理・バッチ3）: 「実行中」レジストリへも伝える ─────────────
// 共用型 AppRunPanel.tsx の公開処理は beginActivity/endActivity（src/renderer/activity.ts）を
// 呼び、main の isBusy を立てて自動更新の「いますぐ再起動」を拒否させる。専有型のクラスタ
// 作成・破棄はこれを呼んでいなかった（クラスタ→ASG→LB の作成中／破棄中に再起動が走ると
// 途中で切れて記録が半端になりうる）。ここでも confirm と同じく「注入」で受け取り、
// 偽の activity（begin の呼び出し回数・end の呼び出し回数）でテストする——
// confirm が false（キャンセル）なら begin は一度も呼ばれない（＝実行中に数えない）。
// begin が呼ばれたら、create/teardown の成功・失敗を問わず必ず end を1回呼ぶ（finally）。

export type ConfirmFn = (message: string) => boolean

/** activity.ts の beginActivity と同じ形（呼ぶと終了用の関数が返る）。 */
export interface ActivityDeps {
  begin(): () => void
}

export type CreateReq<Spec> = {
  /** 確認ダイアログに出す文言（price.text 等を含めて呼び出し側が組み立てる）。 */
  confirmMessage: string
  /** create に渡す入力そのもの（createClusterFlow への spec）。 */
  spec: Spec
}

export type TeardownReq = {
  /** 確認ダイアログに出す文言。 */
  confirmMessage: string
}

export type ActionOutcome<R> = { cancelled: true } | { cancelled: false; result: R }

export interface RunCreateDeps<Spec, R> {
  confirm: ConfirmFn
  create(spec: Spec, opts: { confirmed: boolean }): Promise<R>
  activity: ActivityDeps
}

export interface RunTeardownDeps<R> {
  confirm: ConfirmFn
  teardown(opts: { confirmed: boolean }): Promise<R>
  activity: ActivityDeps
}

/**
 * confirm を通ったときだけ create を呼ぶ。confirm が false（キャンセル）なら
 * create には一切触れない（＝main 側 fetch もゼロ件）。true なら `activity.begin()` で
 * 「実行中」を立ててから `{ confirmed: true }` を付けて1回だけ呼び、成功・失敗を問わず
 * 必ず `end()` を呼んで「実行中」を解く。
 */
export async function runCreate<Spec, R>(req: CreateReq<Spec>, deps: RunCreateDeps<Spec, R>): Promise<ActionOutcome<R>> {
  const confirmed = deps.confirm(req.confirmMessage)
  if (!confirmed) return { cancelled: true }
  const end = deps.activity.begin()
  try {
    const result = await deps.create(req.spec, { confirmed: true })
    return { cancelled: false, result }
  } finally {
    end()
  }
}

/**
 * confirm を通ったときだけ teardown を呼ぶ。confirm が false（キャンセル）なら
 * teardown には一切触れない。true なら `activity.begin()` で「実行中」を立ててから
 * `{ confirmed: true }` を付けて1回だけ呼び、成功・失敗を問わず必ず `end()` を呼ぶ。
 */
export async function runTeardown<R>(req: TeardownReq, deps: RunTeardownDeps<R>): Promise<ActionOutcome<R>> {
  const confirmed = deps.confirm(req.confirmMessage)
  if (!confirmed) return { cancelled: true }
  const end = deps.activity.begin()
  try {
    const result = await deps.teardown({ confirmed: true })
    return { cancelled: false, result }
  } finally {
    end()
  }
}

// ── B-2（2026-09-10 実機・Ryosuke さん指摘「消した後の表示が変」）: ⑤⑥の結果ブロックを
// いつ出すかの判定を、React/DOM から切り離した純関数として持つ（掟10）。
//
// 直したかった事故: 破棄（⑥）が成功して記録（apprunState）が空になると、⑤の節が
// 「hasAnyResource が false」の分岐へ切り替わり、そこに**古い createResult（⑤の前回の
// 『✅ 作成できました』）がそのまま出ていた**。加えて、⑥の結果表示は「記録に何かある間」
// だけ描く節の中に置いていたため、破棄が完了して記録が空になった瞬間に⑥の節ごと消え、
// 「✅ すべて削除しました」という肝心の結果も一緒に見えなくなっていた。
//
// tests/apprunDedicatedActions.test.ts が、実装を壊すと落ちる形（掟10）で固定する。

/** shouldShowCreateResult が見る最小限の形（apprunState の一部）。IDが1つでもあれば「何か作られている」。 */
export type ApprunResourceRecord = { clusterID?: string | null; asgID?: string | null; loadBalancerID?: string | null } | null | undefined

/**
 * ⑤「クラスタを作る」の結果ブロックを出すか。
 * - createResult が無ければ出さない。
 * - createResult.ok が false（途中で止まった）なら、記録の状態に関わらず常に出す
 *   （失敗の内容・ここまで作られたIDは、破棄の判断に要る情報のため）。
 * - createResult.ok が true でも、**記録（apprunState）が空なら出さない**——
 *   その後の破棄で作ったものが消えているのに、「✅ 作成できました」という古い成功表示を
 *   見せ続けない（2026-09-10 実機で発見）。
 */
export function shouldShowCreateResult(createResult: { ok: boolean } | null | undefined, apprunState: ApprunResourceRecord): boolean {
  if (!createResult) return false
  if (!createResult.ok) return true
  return !!(apprunState?.clusterID || apprunState?.asgID || apprunState?.loadBalancerID)
}

/**
 * ⑥「作ったものを壊す」の結果ブロックを出すか。teardownResult があるときは常に true——
 * **⑥の節（記録があるときだけ出る）の有無に関係なく**、破棄の結果（「✅ すべて削除しました」
 * を含む）を出す。破棄が完了して記録が空になっても、結果自体は隠さない。
 * 次の⑤の作成を始めたら teardownResult 自体を null に戻す（呼び出し側＝画面の責務。
 * doCreate の中で setTeardownResult(null) する）——ここは「今の値をそのまま出すか」だけを見る。
 */
export function shouldShowTeardownResult(teardownResult: unknown | null | undefined): boolean {
  return teardownResult != null
}
