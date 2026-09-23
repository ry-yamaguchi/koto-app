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
//
// ── D-4（2026-09-15）: ⑧「アプリを公開する」も同じ形（runPublishApp）────────────────
// クラスタの上にアプリケーション（独自ドメイン）を載せる操作。イメージの組み立て・push・
// POST /applications・POST versions と、確認無しに走らせてはいけない段が続くため、
// ⑤⑥と同じく「confirm が false なら publish を一度も呼ばない」歯止めを純関数として持つ。
// ⑧の節を出すかどうか（shouldShowPublishSection: クラスタ・ASG・LB の3つが揃っているときだけ）も
// ここに置く（⑤の途中失敗でクラスタだけ作れた状態で⑧を出さない）。

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

// ── D-4（2026-09-15）: ⑧「アプリを公開する」の確認→IPC と、節の表示判定 ──────────────

export type PublishReq<Input> = {
  /** 確認ダイアログに出す文言（ホスト名・スペック・DNS の案内を含めて呼び出し側が組み立てる）。 */
  confirmMessage: string
  /**
   * publish に渡す入力そのもの（画面の入力: host/cpu/memory/fixedScale/healthCheckPath?/
   * letsEncryptEmail?）。main 側の PublishAppInput（spec/imageRef/registry）とは別物——
   * name/port/env は main が env.json から補う。
   */
  input: Input
}

export interface RunPublishAppDeps<Input, R> {
  confirm: ConfirmFn
  publish(input: Input, opts: { confirmed: boolean }): Promise<R>
  activity: ActivityDeps
}

/**
 * confirm を通ったときだけ publish を呼ぶ（runCreate と同じ形）。confirm が false（キャンセル）なら
 * publish には一切触れない（＝イメージの組み立ても push も API 呼び出しもゼロ件）。true なら
 * `activity.begin()` で「実行中」を立ててから `{ confirmed: true }` を付けて1回だけ呼び、
 * 成功・失敗を問わず必ず `end()` を呼んで「実行中」を解く。
 */
export async function runPublishApp<Input, R>(req: PublishReq<Input>, deps: RunPublishAppDeps<Input, R>): Promise<ActionOutcome<R>> {
  const confirmed = deps.confirm(req.confirmMessage)
  if (!confirmed) return { cancelled: true }
  const end = deps.activity.begin()
  try {
    const result = await deps.publish(req.input, { confirmed: true })
    return { cancelled: false, result }
  } finally {
    end()
  }
}

/**
 * ⑧「アプリを公開する」の節を出すか。**クラスタ・ASG・ロードバランサの3つが揃っているときだけ**
 * （AND。shouldShowCreateResult の「1つでもあれば」とは違う）。
 * - 記録が無い（null/undefined）→ false。
 * - ⑤が途中で止まってクラスタだけ作れた状態 → false（main の publishAppFlow は 'no-cluster' 相当で
 *   止まるので、押せるボタンを出しても意味が無い。先に⑥で破棄→⑤で作り直してもらう）。
 */
export function shouldShowPublishSection(record: ApprunResourceRecord): boolean {
  return !!(record?.clusterID && record?.asgID && record?.loadBalancerID)
}

// ── H-1（2026-09-17）: ⑤⑥⑦⑧ は同時に走らせない ──────────────────────────────────
// 横断点検（6視点）のうち4つが独立に同じ欠陥へ収束した: **⑥「すべて削除する」の
// 実行中でも⑧「公開する」が押せた**（逆も同じ）。⑥は実測で約9分かかるので、窓は広い。
//
// 何が壊れるか。破棄がロードバランサを消している最中に⑧を押すと、公開はその場で記録を
// 読み直すが clusterID 等がまだ残っているため通過し、消えかけのクラスタに新しいアプリを
// 作って applicationID を記録する。破棄は先頭で読んだ記録のまま進み、最後に clusterID だけを
// null にする。結果、**applicationID があるのに clusterID が無い**記録が残り、次に⑥を
// 押しても「クラスタのIDが記録にありません」で止まる＝**Koto からは二度と消せない**。
// アプリの段に割り込めば、破棄が無効にしたアプリを公開が作り直して有効化するので、
// 削除が 400 を繰り返して**破棄そのものが失敗する**（月額およそ2万2千円が止まらない）。
//
// 直す形: 「この節で何かが走っているか」を1つにまとめ、**⑤⑥⑦⑧の操作を全部止める**。
// 判定をここ（純関数）に置き、画面には条件を書き散らさない（掟10）。
// **画面のフラグだけでは足りない**（窓を再読み込みすると消える）ので、main 側にも
// プロジェクト単位の歯止めを置く（src/main/ipc/apprunDedicated.ts の withProjectLock）。

/** ⑤⑥⑦⑧ のどれかが走っているか。走っている間、この節の操作は全部止める。 */
export function panelBusy(s: {
  creating?: boolean
  tearingDown?: boolean
  publishing?: boolean
  lbRefreshing?: boolean
} | null | undefined): boolean {
  if (!s) return false
  return !!(s.creating || s.tearingDown || s.publishing || s.lbRefreshing)
}

/**
 * 押せない理由の一言（純関数）。**理由の分からない無効化は、壊れているのと区別がつかない。**
 * 走っているものが無ければ空文字（画面は何も出さない）。
 */
export function panelBusyReason(s: {
  creating?: boolean
  tearingDown?: boolean
  publishing?: boolean
  lbRefreshing?: boolean
} | null | undefined): string {
  if (!s) return ''
  if (s.tearingDown) return 'いま⑥の削除を実行中です。終わるまでお待ちください。'
  if (s.publishing) return 'いま⑧の公開を実行中です。終わるまでお待ちください。'
  if (s.creating) return 'いま⑤のクラスタ作成を実行中です。終わるまでお待ちください。'
  if (s.lbRefreshing) return 'いま IP を取り直しています。終わるまでお待ちください。'
  return ''
}
