// apprunDedicatedActions.ts — AppRunDedicatedPanel.tsx の「確認→IPC」を、React/DOM から
// 切り離した純関数として持つ（掟10・rollbackSwitch.ts と同型）。
//
// 専有型のクラスタ作成（手順5）・破棄（手順6）は、常時課金3資源を作る/壊す操作（docs/apprun-dedicated-plan.md
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
// ── D-4（2026-09-15）: 手順8「アプリを公開する」も同じ形（runPublishApp）────────────────
// クラスタの上にアプリケーション（独自ドメイン）を載せる操作。イメージの組み立て・push・
// POST /applications・POST versions と、確認無しに走らせてはいけない段が続くため、
// 手順5・6と同じく「confirm が false なら publish を一度も呼ばない」歯止めを純関数として持つ。
// 手順8の節を出すかどうか（shouldShowPublishSection: クラスタ・ASG・LB の3つが揃っているときだけ）も
// ここに置く（手順5の途中失敗でクラスタだけ作れた状態で手順8を出さない）。

import { PUBLISH_TARGET_LABEL, isKnownPublishTarget } from './publishStatus'
// 記録を読む・「見た」と伝える・持ち場を決める・警告と時刻の文にする、は**共通の1か所**を使う（掟10・2026-09-30 検分の指摘2）。
import {
  DEDICATED_TARGET, DEDICATED_PANEL_HANDLERS, isDedicatedPanelOp, unseenOf, ackUpToFor, sendAck, watchProjectOps,
  type ProjectOpsApi,
} from './projectOpsView'
import { warningLine, clockText } from '../shared/opsText'
// 段ごとの所要時間（記録の result.extra.stageTimings）を、その場の結果と同じ形に読み戻す（2026-10-07・「かかった時間を見る」の双子）。
import { readStageTimings } from '../shared/stageTiming'
// 「消すものが記録にあるか」は 📡 の 🗑（runDedicatedTeardown）と同じ1つの判断（掟10）。
import { dedicatedTeardownHasWork } from '../shared/teardownSupport'

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

// ── B-2（2026-09-10 実機・Ryosuke さん指摘「消した後の表示が変」）: 手順5・6の結果ブロックを
// いつ出すかの判定を、React/DOM から切り離した純関数として持つ（掟10）。
//
// 直したかった事故: 破棄（手順6）が成功して記録（apprunState）が空になると、手順5の節が
// 「hasAnyResource が false」の分岐へ切り替わり、そこに**古い createResult（手順5の前回の
// 『✅ 作成できました』）がそのまま出ていた**。加えて、手順6の結果表示は「記録に何かある間」
// だけ描く節の中に置いていたため、破棄が完了して記録が空になった瞬間に手順6の節ごと消え、
// 「✅ すべて削除しました」という肝心の結果も一緒に見えなくなっていた。
//
// tests/apprunDedicatedActions.test.ts が、実装を壊すと落ちる形（掟10）で固定する。

/** shouldShowCreateResult が見る最小限の形（apprunState の一部）。IDが1つでもあれば「何か作られている」。 */
export type ApprunResourceRecord = { clusterID?: string | null; asgID?: string | null; loadBalancerID?: string | null } | null | undefined

/**
 * 手順5「クラスタを作る」の結果ブロックを出すか。
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
 * 手順6「作ったものを削除する」の結果ブロックを出すか。teardownResult があるときは常に true——
 * **手順6の節（記録があるときだけ出る）の有無に関係なく**、破棄の結果（「✅ すべて削除しました」
 * を含む）を出す。破棄が完了して記録が空になっても、結果自体は隠さない。
 * 次の手順5の作成を始めたら teardownResult 自体を null に戻す（呼び出し側＝画面の責務。
 * doCreate の中で setTeardownResult(null) する）——ここは「今の値をそのまま出すか」だけを見る。
 */
export function shouldShowTeardownResult(teardownResult: unknown | null | undefined): boolean {
  return teardownResult != null
}

// ── D-4（2026-09-15）: 手順8「アプリを公開する」の確認→IPC と、節の表示判定 ──────────────

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
 * 手順8「アプリを公開する」の節を出すか。**クラスタ・ASG・ロードバランサの3つが揃っているときだけ**
 * （AND。shouldShowCreateResult の「1つでもあれば」とは違う）。
 * - 記録が無い（null/undefined）→ false。
 * - 手順5が途中で止まってクラスタだけ作れた状態 → false（main の publishAppFlow は 'no-cluster' 相当で
 *   止まるので、押せるボタンを出しても意味が無い。先に手順6で破棄→手順5で作り直してもらう）。
 */
export function shouldShowPublishSection(record: ApprunResourceRecord): boolean {
  return !!(record?.clusterID && record?.asgID && record?.loadBalancerID)
}

// ── H-1（2026-09-17）: 手順5・6・7・8 は同時に走らせない ──────────────────────────────────
// 横断点検（6視点）のうち4つが独立に同じ欠陥へ収束した: **手順6「すべて削除する」の
// 実行中でも手順8「公開する」が押せた**（逆も同じ）。手順6は実測で約9分かかるので、窓は広い。
//
// 何が壊れるか。破棄がロードバランサを消している最中に手順8を押すと、公開はその場で記録を
// 読み直すが clusterID 等がまだ残っているため通過し、消えかけのクラスタに新しいアプリを
// 作って applicationID を記録する。破棄は先頭で読んだ記録のまま進み、最後に clusterID だけを
// null にする。結果、**applicationID があるのに clusterID が無い**記録が残り、次に手順6を
// 押しても「クラスタのIDが記録にありません」で止まる＝**Koto からは二度と消せない**。
// アプリの段に割り込めば、破棄が無効にしたアプリを公開が作り直して有効化するので、
// 削除が 400 を繰り返して**破棄そのものが失敗する**（月額およそ2万2千円が止まらない）。
//
// 直す形: 「この節で何かが走っているか」を1つにまとめ、**手順5・6・7・8の操作を全部止める**。
// 判定をここ（純関数）に置き、画面には条件を書き散らさない（掟10）。
// **画面のフラグだけでは足りない**（窓を再読み込みすると消える）ので、main 側にも
// プロジェクト単位の歯止めを置く（src/main/ipc/apprunDedicated.ts の withProjectLock）。

/** 手順5・6・7・8 のどれかが走っているか。走っている間、この節の操作は全部止める。 */
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
  if (s.tearingDown) return 'いま手順6の削除を実行中です。終わるまでお待ちください。'
  if (s.publishing) return 'いま手順8の公開を実行中です。終わるまでお待ちください。'
  if (s.creating) return 'いま手順5のクラスタ作成を実行中です。終わるまでお待ちください。'
  if (s.lbRefreshing) return 'いま IP を再取得しています。終わるまでお待ちください。'
  return ''
}

// ── 手順6の確認ダイアログの文面（2026-09-24 Ryosuke 決定「(1)は案2・一貫性が重要」）────────────
//
// ── なぜ純関数として持つのか ──────────────────────────────────────────
// 案2 では手順6の破棄で**利用者のデータが実際に消える**。それを名指ししない確認は嘘になる
// （掟5「破壊操作は ConfirmModal」は、出すことだけでなく**何が消えるかを言うこと**まで含む）。
// 画面の中で文字列を組み立てていると、保存場所の行が落ちてもテストで捕まえられない。

/** 破棄の確認に出す保存場所（`storage:placement` が返す形と同じ）。使っていなければ null。 */
export type TeardownPlacement = { bucket: string; prefix?: string; shared?: boolean } | null | undefined

/**
 * 削除するものの**種類**だけを、一覧（`targets`）から取り出す（純関数）。
 * 「アプリ『tsukaisute』」→「アプリ」。一覧の順を保ち、同じ種類は1つにする。
 *
 * 種類は**実際に消すものの一覧から**引く（固定で「アプリ・ロードバランサ…」と書かない）——
 * 一覧に無い種類の課金停止を語ると、無い資源の話をする嘘になる。名前（『…』）が付いていない項目は
 * 全体を種類として扱い、種類が空になる項目は数えない。
 */
export function teardownKindsOf(targets: readonly string[]): string[] {
  const kinds: string[] = []
  for (const t of targets) {
    const kind = String(t ?? '').split('『')[0].trim()
    if (kind && !kinds.includes(kind)) kinds.push(kind)
  }
  return kinds
}

/**
 * 手順6「すべて削除する」の確認ダイアログの本文（純関数）。
 *
 * - `targets` は削除するものの名前（アプリ・ロードバランサ・ASG・クラスタ）。
 * - `placements` があるときだけ、一覧に**保存場所の名前**を足し、「中のデータも消えます」と
 *   明示し、`dataNote`（＝`shared/teardownSupport.ts` の `teardownDataNoteForAll`）を挟む。
 *   その説明が「ほかのプロジェクトのデータや、あなたが自分で置いたファイルは残す」こと、
 *   「ほかに使っているプロジェクトが無ければ保存場所ごと消して月額を止める」ことを伝える
 *   （実際の判断は破棄のときに `teardownPlanFor` が中身を一覧してから決める）。
 * - 最後の一言は**止まる側**の説明にする。以前は「消さない限り課金が続きます」だったが、
 *   これは押す前の警告として逆向き（押したら何が止まるのかを言う）。
 *
 * ── なぜ `placement`（1件）ではなく `placements`（全件）なのか（2026-09-25 検分の指摘15・V6）──
 * 手順6の破棄は `teardownStorageForProject` が `for (const placement of placements)` で
 * **env.json にある保存場所を全件**片づける。ところがこの文面は `storage:placement` の
 * 先頭1件だけで組み立てていたので、2件ある状態では確認に『A』しか出ないまま
 * **名前が一度も出なかった『B』とその中のデータまで消えた**。
 * **元に戻せない削除を、名指ししないまま実行させない**（掟10「お金・破壊の歯止め」）。
 * 📡一覧・HANAMII・サイドバーは既に全件を出しており、専有型手順6だけが取り残されていた。
 * 「ほか◯件」で省かない——名前が出ていないものは、利用者にとって存在しないのと同じ。
 * **1件のときの文面は従来と1文字も変えない**（文言を二重管理しないため）。
 */
export function teardownConfirmMessage(opts: {
  targets: string[]
  /**
   * 破棄で消える保存場所の**全件**（`storage:placement` の `placements`）。
   * 使っていなければ空配列（`null` / `undefined` も可）。
   */
  placements: TeardownPlacement[] | null | undefined
  /**
   * `teardownDataNoteForAll({ target, scope, placements })` の結果
   * （shared の一元定義をそのまま渡す。ここで文面を書き起こさない）。
   */
  dataNote: string
  /**
   * **この公開先以外に、いま生きている公開先の名前**（2026-09-24 検分の指摘2）。
   *
   * 保存場所は公開先ごとではなく**プロジェクト単位**で、HANAMII も共用型も同じ bucket/prefix を
   * 使う（`issueStorageEnvFor` を全員が通る）。「HANAMII で本番を公開したまま、専有型を試しに
   * 作って手順6で壊す」と、ほかに使っているプロジェクトが無い限り `teardownPlanFor` は
   * `deleteBucket:true` を返し、**稼働中の HANAMII のアプリのデータごと消える**。
   * 名前を挙げずに押させてはいけない（掟11「ほかの公開先の資源に触れない」）。
   */
  otherTargets?: string[]
  /**
   * 時間のかかる段の予告（2026-10-08・作者の決定）。「ロードバランサの削除におよそ9分」のような一文を、
   * 目安の仕組み（shared/stageEstimate.ts）の出力から作って呼び出し側が渡す（ここで数字を持たない）。
   * 渡さなければ（目安が無い・ロードバランサが無い）何も足さない——**測っていない段に目安を作らない**。
   */
  waitNote?: string
}): string {
  // 名前の無いもの（null・空の bucket）は数えない。`teardownDataNoteForAll` の選び方と揃える。
  const buckets = (opts.placements ?? [])
    .filter((p): p is { bucket: string; prefix?: string; shared?: boolean } => !!p && typeof p.bucket === 'string' && p.bucket.length > 0)
    .map(p => p.bucket)
  // 1件なら『A』、2件以上なら『A』『B』。**「ほか◯件」で省かない**（消えるものは全部名指しする）。
  const names = buckets.map(b => `『${b}』`).join('')
  // W-14（2026-09-27 決定）: 「保存場所『…』（中のデータも消えます）」は、保存場所そのものが
  // 丸ごと消えるように読めてしまい、すぐ下の💾の行（teardownDataNoteForAll。ほかのプロジェクトの
  // データや自分で置いたファイルは残す・ほかに使う人がいなければ保存場所ごと削除）と食い違っていた。
  // 保存場所が消えるかどうかは💾の行に任せ、ここでは「中にあるこのプロジェクトのデータ」とだけ言う。
  const list = buckets.length > 0 ? [...opts.targets, `保存場所${names}にある、このプロジェクトのデータ`] : [...opts.targets]
  // 一覧が空なら、空のまま「次を削除します: 」と出さない（何も名指ししていないのに「削除する」を押させない・掟10）。
  // 通常は呼び出し側（dedicatedTeardownFlow）が、消すものが記録に無いときは確認自体を出さない。ここは最後の砦。
  const paragraphs = [`次を削除します: ${list.length > 0 ? list.join('・') : '（記録に名前を挙げられるものがありません）'}`]
  if (buckets.length > 0 && opts.dataNote) paragraphs.push(`💾 ${opts.dataNote}`)
  const others = (opts.otherTargets ?? []).filter(t => !!t)
  if (buckets.length > 0 && others.length > 0) {
    // 2件以上あるときだけ「これらの」にする（1件のときの文面は従来と1文字も変えない）。
    paragraphs.push(`⚠️ ${buckets.length > 1 ? 'これらの保存場所' : 'この保存場所'}は ${others.join('・')} でも使っています。`
      + `${others.join('・')} で公開中のアプリのデータも消えます（アプリ自体は消えません）。`)
  }
  // W-14（2026-09-27 決定）: 「ここに挙げたものの月額の課金は止まります」は言い切りすぎで、
  // 共有の保存場所はほかのプロジェクトが使っていれば残る（月額495円は続く）。
  // **消すものの名前は固定で書かず、実際の一覧（opts.targets）から組み立てる**——保存場所だけが
  // 残った状態（opts.targets が空）で一覧が空になっても、無い費用の話をしないので嘘にならない。
  // 2026-09-29（作者の決定）: 課金の文は**種類だけ**（「アプリ・ロードバランサ・オートスケーリング
  // グループ・クラスタの課金は止まります」）。長い ID は1つ上の一覧で一度出しており、この文で
  // 2回目を並べると読みにくい。種類も固定で書かず、同じ一覧（teardownKindsOf）から引く。
  const kinds = teardownKindsOf(opts.targets)
  const computeCost = kinds.length > 0 ? `${kinds.join('・')}の課金は止まります。` : ''
  const storageCost = buckets.length > 0 ? '保存場所は、ほかに使っているプロジェクトが無いときだけ止まります。' : ''
  const costLine = [computeCost, storageCost].filter(Boolean).join('')
  // 時間のかかる段の予告は、最後の問いの直前に置く（押す前に読む位置）。
  if (opts.waitNote) paragraphs.push(opts.waitNote)
  // どちらも無い（消すものが無い）ときは、無い費用の話をしない——確認文自体はそのまま出す。
  paragraphs.push(costLine
    ? `この操作は元に戻せません。削除すると、${costLine}よろしいですか？`
    : 'この操作は元に戻せません。よろしいですか？')
  return paragraphs.join('\n\n')
}

// ── 手順6をもう一度押せるようにする（2026-09-24 検分の指摘1）────────────────────────────
//
// 手順6「すべて削除する」ボタンは、記録に clusterID/asgID/loadBalancerID が1つでもある間しか
// 画面に出ていなかった。ところが main 側は、**計算資源を消し切って記録を空にしたあとで**
// 保存場所を片づける。「アプリ→LB→ASG→クラスタは全部消えた。保存場所の一覧取得が 403 や
// 一時的な通信失敗で落ちた」という、まさに起こりうる並びで、**記録が空＝ボタンが消え、
// バケットだけが残る**。Koto には保存場所を消す口がほかに無いので、利用者はコントロールパネルへ
// 行くしかなく、月額495円が黙って続く。共用型は state.json にバケットが残って破棄をやり直せる＝
// 案2「共用型と同じにする」という決定とも食い違う。
//
// 判断を画面に書き散らさないよう、ここ（純関数）に置いてテストで固定する（掟10）。

/**
 * 手順6「すべて削除する」のボタンを出すか。
 * - 記録に**消すものがあれば**出す——その判断は `dedicatedTeardownHasWork`（shared/teardownSupport.ts）の1つで、
 *   📡 の 🗑（runDedicatedTeardown が破壊の確認を出すか）と**同じこれ**を使う。資源の ID（アプリ・ロードバランサ・
 *   オートスケーリンググループ・クラスタ）が1つでもある、または前回の削除で保存場所だけが残った印（`storageLeftoverBucket`）がある。
 *   以前はここだけが「クラスタ・ASG・LB」の3つで判断し（アプリだけの記録では出さず）、📡 とは判断が2か所に分かれていた
 *   （2026-10-08 検分 E）。
 * - 走っている間は出し続ける。
 *
 * ※ アプリのID だけで資源のIDが無い記録（本来は起きない）でもボタンが出る。押すと main は
 *   「削除に必要なクラスタのIDが記録にありません」で止め、さくらには何も要求しない（📡 の 🗑 と同じ結果）。
 *   そのとき、何を消すかの一覧（アプリ・ロードバランサ・オートスケーリンググループ・クラスタの行）も出すように、
 *   一覧を出すかの判断も同じ土台に揃えてある（`shouldShowTeardownList`・2026-10-08 検分）。
 */
export function shouldShowTeardownButton(s: {
  /** `apprunDedicated:state` が返す記録（資源のID・storageLeftoverBucket）。 */
  record?: Parameters<typeof dedicatedTeardownHasWork>[0]
  /**
   * 手順6がいま走っている（この画面が始めたものでも、閉じて開き直す前に始めたものでもよい）。
   * 走っている間は手順6の節を出し続ける——計算資源を消し切って保存場所を片づけている最中は、記録が空でも
   * 「いまどこまで進んでいるか」を出す場所が要る（2026-09-29）。
   */
  running?: boolean
}): boolean {
  return dedicatedTeardownHasWork(s.record) || !!s.running
}

/**
 * 手順6の「消すものの一覧」（アプリ・ロードバランサ・オートスケーリンググループ・クラスタの行）を出すか。
 * ボタン（`shouldShowTeardownButton`）と同じ `dedicatedTeardownHasWork` の判断から、**保存場所の残りの印だけを除いた**もの——
 * 保存場所だけが残っているときは、一覧に並べる行が無い（その一言は `storageLeftoverNote` が別に出す）。
 * 以前は一覧を「クラスタ・ASG・LB のどれか」（hasAnyResource）でガードし、ボタンはアプリのIDだけでも出るのに、
 * 何を消すかの一覧が無いボタンになった（2026-10-08 検分）。判断を2つに分けない。
 */
export function shouldShowTeardownList(record: Parameters<typeof dedicatedTeardownHasWork>[0]): boolean {
  return dedicatedTeardownHasWork({ ...record, storageLeftoverBucket: null })
}

/** 保存場所だけが残っているときに手順6へ出す一言（空文字なら出さない）。 */
export function storageLeftoverNote(bucket: string | null | undefined): string {
  if (!bucket) return ''
  return `保存場所『${bucket}』だけが残っています（消すまで月額が続きます）。もう一度押すと削除します。`
}

// 破棄のあと、公開記録（publish.targets）を片づけるかの判断は**画面には持たない**（2026-10-08）。
// main の `apprunDedicated:teardown`（src/main/ipc/apprunDedicated.ts）が、操作の鍵の中で1回だけ
// `shouldForgetPublishRecord`（src/main/cloud/apprunDedicatedApply.ts）の規則で片づける。
// 手順6からも 📡 の 🗑 からも同じこの1か所（画面の後始末は、閉じると走らず、再生されると新しい記録を消す穴だった）。

// ── 閉じて開き直したとき、続きと結果を出す（2026-09-29・作者の決定 (1)(2)）──────────────────────────
//
// 手順5の作成・手順6のすべて削除・手順8の公開の本体は main の1回の IPC で最後まで進み、記録も main が書く
// （withProjectLock）。だから**公開のダイアログを閉じても処理は止まらない**。失われていたのは画面の表示
// ——進み具合・結果・警告（「保存場所が残ったので月額が続きます」「まだ動いていません」など）——だけで、
// 開き直すと「終わったのか」「うまくいったのか」「何が残ったのか」が分からなかった。
// main は**プロジェクトごとの処理の記録**（window.electronAPI.projectOps・メモリ上）を持つので、
// 開いたとき読んで続きを出し、出したら ack（見た印）を返す。
//
// ── なぜ React の外に出すのか ─────────────────────────────────────────────────
// 「外して付け直したとき、走っていれば進み具合が出る／終わっていれば結果と警告が出る／ack のあとは出ない」は
// **お金の見え方に関わる約束**（月額が続くことを見逃させない）。React の中に埋め込むと文字列一致のテストでしか
// 固定できない（掟10）。ここでは偽の projectOps（get／ack／onChanged）を渡す**振る舞いのテスト**
// （tests/ops-dedicated-resume.test.ts）で固定する。画面（AppRunDedicatedPanel.tsx）は、これを付け外しして
// 届いたものを state に置くだけ。

/** このパネルが受け持つ操作（手順5・6・8）。 */
export type DedicatedOpKind = 'create' | 'teardown' | 'publish'

/** 専有型の公開先（記録の target）。定義は projectOpsView.ts（持ち場の表と同じ場所）。 */
export { DEDICATED_TARGET }

/** 見出しに使う名前（画面の節の番号と揃える）。 */
export const DEDICATED_OP_LABEL: Record<DedicatedOpKind, string> = {
  create: '手順5 クラスタの作成',
  teardown: '手順6 すべて削除',
  publish: '手順8 アプリの公開',
}

/**
 * 記録が、このパネルの手順5・6・8のどれかか（違えば null）。
 *
 * **見分けは target と handler の両方**。2026-10-08 から、手順6も 📡 一覧の「🗑 破棄」も同じ
 * `apprunDedicated:teardown` で、記録は1種類。どちらの画面から始めた削除でも、記録からは同じように読める。
 * 鍵はプロジェクト単位なので、走っている・終わった記録は**別の公開先の操作**のことがある——そういう記録の
 * 詳細をここで出さず（掟11）、ack でも巻き込まない。
 */
export function dedicatedOpKind(rec: { target?: string; handler?: string } | null | undefined): DedicatedOpKind | null {
  // 持ち場の表（DEDICATED_PANEL_HANDLERS）は projectOpsView.ts の1か所。ここへ IPC 名を書き写さない。
  return isDedicatedPanelOp(rec) ? DEDICATED_PANEL_HANDLERS[rec!.handler as string] : null
}

/** 別の持ち場の操作が走っているとき、1行に留めて出すための材料。 */
export type DedicatedOtherOp = { op: string; targetLabel: string | null }

/** 走っているものの見え方。`running` がこのパネルの操作、`other` が別の操作。どちらも無ければ何も走っていない。 */
export type DedicatedRunningView = {
  running: { kind: DedicatedOpKind; record: ProjectOpRecordShape } | null
  other: DedicatedOtherOp | null
}

/** 終わった操作（まだ見られていないもの）。 */
export type DedicatedFinished = { kind: DedicatedOpKind; record: ProjectOpRecordShape }

/** 別の操作が走っているときの1行（詳細は出さない）。 */
export function otherOpNote(other: DedicatedOtherOp): string {
  const what = other.targetLabel ? `${other.targetLabel}の${other.op}` : other.op
  return `このプロジェクトでは別の操作（${what}）が進んでいます。終わるまで、手順5 クラスタの作成・手順6 すべて削除・手順8 アプリの公開はできません。`
}

/** 進み具合の一文（記録の progress。main が秘密を伏せてある）。補足があれば続ける。 */
export function opProgressText(rec: { progress?: { label?: string; detail?: string } } | null | undefined): string {
  const label = String(rec?.progress?.label ?? '').trim()
  const detail = String(rec?.progress?.detail ?? '').trim()
  return detail ? `${label} ${detail}`.trim() : label
}

/** 「始まってから約N分」（1分未満は「1分未満」）。時計は呼び出し側が渡す（テストで固定する）。 */
export function opElapsedText(startedAt: number, nowMs: number): string {
  const min = Math.floor(Math.max(0, nowMs - startedAt) / 60000)
  return min < 1 ? '始まってから1分未満' : `始まってから約${min}分`
}

// ── 記録 → 画面の結果（手順5・6・8の既存の結果欄がそのまま描ける形）─────────────────────────────
// 記録の結果（OpResult）は main が各ハンドラの返り値から**許可した項目だけ**を写したもの。ここで
// 既存の返り値の形へ戻し、生きている操作の結果と**同じ結果欄**で見せる（同じ意味を2つの見せ方にしない）。
// **警告（warnings）は結果欄へ入れず、DedicatedResumedNote に集める**（同じ知らせを2か所に出さない・
// 結果欄が警告を描かない場合〔失敗・手順5〕でも落とさない）。

type CreateResultShape = Awaited<ReturnType<Window['electronAPI']['apprunDedicated']['create']>>
type TeardownResultShape = Awaited<ReturnType<Window['electronAPI']['apprunDedicated']['teardown']>>
type PublishResultShape = Awaited<ReturnType<Window['electronAPI']['apprunDedicated']['publishApp']>>

const RESULT_UNREADABLE = '結果を読み取れませんでした。コントロールパネルで、実際の状態を確かめてください。'
const asText = (x: unknown): string => (typeof x === 'string' ? x : '')
const asTextOrNull = (x: unknown): string | null => (typeof x === 'string' && x !== '' ? x : null)
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)

const CREATE_STAGES: readonly string[] = [
  'consent', 'invalid', 'existing', 'record', 'limits', 'cluster-create', 'cluster-verify', 'asg-create', 'asg-verify',
  'lb-create', 'lb-verify', 'done',
]
const PUBLISH_STAGES: readonly string[] = [
  'consent', 'no-cluster', 'invalid', 'record', 'lets-encrypt', 'cluster-ports', 'app-lookup', 'name-taken', 'app-create',
  'version-create', 'activate', 'cleanup', 'lb-address', 'image', 'storage', 'done',
]
const VERIFY_OUTCOMES: readonly string[] = ['ok', 'stale', 'responding', 'error-status', 'no-backend', 'unreachable']
const RESOURCE_KEYS = ['applicationID', 'loadBalancerID', 'asgID', 'clusterID'] as const

/** 消せずに残った／削除中のもの（IDの文字列だけを拾う）。 */
function pickIds(x: unknown, extraKeys: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {}
  if (!isObj(x)) return out
  for (const k of [...RESOURCE_KEYS, ...extraKeys]) if (typeof x[k] === 'string' && x[k] !== '') out[k] = x[k] as string
  return out
}

/**
 * 記録の extra から、段ごとの所要時間を読み戻す。**その場の結果（IPC の返り値の stageTimings）と同じ形**にして、
 * 結果欄の「かかった時間を見る」が、その場で終わったときも開き直したときも**同じ部品に同じ値**を渡す（双子）。
 * 無い・形が合わないときは何も足さない。
 */
function timingsPart(ex: Record<string, unknown>): { stageTimings?: NonNullable<ReturnType<typeof readStageTimings>> } {
  const t = readStageTimings(ex.stageTimings)
  return t ? { stageTimings: t } : {}
}

/** 手順5の結果（記録から）。 */
export function resumedCreateResult(rec: ProjectOpRecordShape): CreateResultShape {
  const r = rec.result
  if (!r) return { ok: false, stage: 'record', message: RESULT_UNREADABLE }
  const ex = r.extra ?? {}
  const stage = CREATE_STAGES.includes(asText(ex.stage)) ? asText(ex.stage) : (r.ok ? 'done' : 'record')
  return {
    ok: r.ok === true,
    stage: stage as CreateResultShape['stage'],
    message: r.message ?? '',
    clusterID: asTextOrNull(ex.clusterID),
    asgID: asTextOrNull(ex.asgID),
    loadBalancerID: asTextOrNull(ex.loadBalancerID),
    ...timingsPart(ex),
  }
}

/** 手順6の結果（記録から）。`executed` は起きたことの一覧（⚠️・※ の行は警告へ移してある）。 */
export function resumedTeardownResult(rec: ProjectOpRecordShape): TeardownResultShape {
  const r = rec.result
  if (!r) return { ok: false, executed: [], message: RESULT_UNREADABLE, remaining: {} }
  const ex = r.extra ?? {}
  const inProgress = isObj(ex.inProgress) ? pickIds(ex.inProgress) : null
  return {
    ok: r.ok === true,
    executed: [...(r.lines ?? [])],
    message: r.message ?? '',
    remaining: pickIds(ex.remaining, ['storageBucket']),
    ...(inProgress ? { inProgress } : {}),
    ...(typeof ex.appDeleted === 'boolean' ? { appDeleted: ex.appDeleted } : {}),
    ...timingsPart(ex),
  }
}

/** 手順8の結果（記録から）。DNS の案内（IP）・応答の確認・コンテナの様子まで、生きている結果と同じ欄で出せる。 */
export function resumedPublishResult(rec: ProjectOpRecordShape): PublishResultShape {
  const r = rec.result
  if (!r) return { ok: false, stage: 'invalid', message: RESULT_UNREADABLE }
  const ex = r.extra ?? {}
  const stage = PUBLISH_STAGES.includes(asText(ex.stage)) ? asText(ex.stage) : (r.ok ? 'done' : 'invalid')
  const containerStates = Array.isArray(ex.containerStates)
    ? ex.containerStates.filter((c): c is { state: string; status: string } => isObj(c) && typeof c.state === 'string' && typeof c.status === 'string')
    : null
  return {
    ok: r.ok === true,
    stage: stage as PublishResultShape['stage'],
    message: r.message ?? '',
    ...(asTextOrNull(ex.applicationID) ? { applicationID: asText(ex.applicationID) } : {}),
    ...(typeof ex.version === 'number' ? { version: ex.version } : {}),
    ...(r.url ? { url: r.url } : {}),
    ...(Array.isArray(ex.lbAddresses) ? { lbAddresses: ex.lbAddresses.filter((a): a is string => typeof a === 'string') } : {}),
    ...(VERIFY_OUTCOMES.includes(asText(ex.verify)) ? { verify: asText(ex.verify) as NonNullable<PublishResultShape['verify']> } : {}),
    ...(containerStates ? { containerStates } : {}),
    ...(r.detail ? { detail: r.detail } : {}),
    ...(ex.hint === 'reset-registry' ? { hint: 'reset-registry' as const } : {}),
    ...timingsPart(ex),
  }
}

// ── 見逃してはいけない知らせ（警告）────────────────────────────────────────────────────────
// 「保存場所が残ったので月額が続きます」のような結果の警告は、結果欄が描いても描かなくても**必ず出す**。
// 出す場所は手順5・6・8の各節の結果欄の上（黄色）。

// 手順6の結果欄は、消せずに残ったもの・削除中のものを**IDの一覧つき**で自分で描く。main が同じ事実から作る
// 警告の文（projectOps.ts の summarizeResult）と二重にならないよう、この2つの書き出しだけは警告から外す。
// 書き出しが main と食い違うと二重に出るだけで、知らせが消えることはない
// （tests/ops-dedicated-resume.test.ts が main の実際の文で一致を固定する）。
export const TEARDOWN_REMAINING_WARNING_HEAD = '削除できずに残っているものがあります。残っている間は課金が続きます'
export const TEARDOWN_IN_PROGRESS_WARNING_HEAD = '削除の途中で、待ち切れずに止まりました'

/** 開き直したあとの結果に添える、1件ぶんの知らせ。 */
export type DedicatedResumedNote = {
  kind: DedicatedOpKind
  /** 記録の識別子（同じプロジェクトで必ず増える）。 */
  startedAt: number
  finishedAt: number | null
  ok: boolean
  /** 一行の見出し（素のテキスト）。 */
  headline: string
  /** 結果の一言（失敗の理由など）。最新の1件は結果欄が同じ文を出すので、古い記録のときだけ出す。 */
  message: string
  /** 見逃してはいけない知らせ（そのまま日本語の文。⚠️ 付き）。 */
  warnings: string[]
}

/** 記録1件を、結果欄の上に出す知らせにする。 */
export function resumedNoteOf(finished: DedicatedFinished): DedicatedResumedNote {
  const { kind, record } = finished
  const r = record.result
  const ex = r?.extra ?? {}
  let warnings = (r?.warnings ?? []).map(String)
  if (kind === 'teardown') {
    // 結果欄が IDの一覧つきで出すものは、同じ知らせを重ねて出さない。
    if (Object.keys(pickIds(ex.remaining, ['storageBucket'])).length > 0) warnings = warnings.filter(w => !w.startsWith(TEARDOWN_REMAINING_WARNING_HEAD))
    if (isObj(ex.inProgress)) warnings = warnings.filter(w => !w.startsWith(TEARDOWN_IN_PROGRESS_WARNING_HEAD))
  }
  const when = record.finishedAt ? `（${clockText(record.finishedAt)} に終わりました）` : ''
  return {
    kind,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt ?? null,
    ok: r?.ok === true,
    headline: `🔔 ${DEDICATED_OP_LABEL[kind]}の結果です${when}。`,
    message: r ? (r.message ?? '') : RESULT_UNREADABLE,
    warnings: warnings.map(warningLine),
  }
}

/** 画面が持っている知らせ（操作ごと）へ、新しい知らせを足す（純関数）。古い順・同じ記録は足さない・各5件まで。 */
export function addResumedNotes(
  held: Record<DedicatedOpKind, DedicatedResumedNote[]>, incoming: DedicatedResumedNote[],
): Record<DedicatedOpKind, DedicatedResumedNote[]> {
  const next: Record<DedicatedOpKind, DedicatedResumedNote[]> = { create: [...held.create], teardown: [...held.teardown], publish: [...held.publish] }
  for (const n of incoming) {
    if (next[n.kind].some(h => h.startedAt === n.startedAt)) continue
    next[n.kind] = [...next[n.kind], n].sort((a, b) => a.startedAt - b.startedAt).slice(-5)
  }
  return next
}

// ── 記録を読む部品（React の外）──────────────────────────────────────────────────────────
// 読む・押し出しを受ける・古い応答を捨てる・別のプロジェクトを無視する・「どこまで見たと伝えてよいか」は、
// 共通の1か所（projectOpsView.ts の watchProjectOps／ackUpToFor）を通る。ここに書くのは、
// **専有型の持ち場に固有の判断だけ**（手順5・6・8の見分け・この画面が始めた操作の結果は自分で出す）。

/** window.electronAPI.projectOps と同じ形（テストでは偽物を渡す）。定義は projectOpsView.ts。 */
export type DedicatedOpsApi = ProjectOpsApi

export interface DedicatedOpsWatch {
  /**
   * **この画面が**手順5・6・8を始めるとき（IPC を呼ぶ直前）に呼ぶ。その操作の結果はこの画面が自分の返り値から出すので、
   * 記録のほうを**二重に出さない**（endLocal までは出さず・ack もしない）。
   */
  beginLocal(kind: DedicatedOpKind): void
  /**
   * その操作の結果を**画面に出し終えたら**呼ぶ。この画面が始めた記録を「見た」として ack する。
   * 出し終える前に窓が閉じたら呼ばれない＝ack されない＝開き直したときに記録から出せる（結果を失わない）。
   */
  endLocal(kind: DedicatedOpKind): void
  /**
   * いまの記録を聞き直す（押し出しが1つ届かなかったときの保険。走っている間、画面が数秒〜十数秒ごとに呼ぶ）。
   * 聞いている間により新しい押し出しが届いたら、その応答は使わない。
   */
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
 * 開いたとき記録を1回読み、開いている間は押し出しを受ける（読み方は watchProjectOps）。
 *
 * - 終わった結果は**1件につき1回だけ** `onFinished` へ渡す（古い順）。画面に渡したあとで ack する
 *   （**目の前に出ているとき**だけ。隠れているタブは、渡しても ack しない）。**警告つきの記録は ack しない**
 *   （ackUpToFor が止める。上部の「結果を確認しました」まで残す・2026-09-30 検分）。
 * - **ack は連続した先頭の「自分のもの」まで**（ackUpToFor）。別の公開先の結果（Vercel など）や、この画面が
 *   出している最中の結果を挟んだら、それより新しいものは自分のものでも ack せず残す
 *   （開き直すと重ねて見えるだけで、失わない）。
 */
export function watchDedicatedOps(deps: {
  api: DedicatedOpsApi
  projectDir: string
  onRunning: (view: DedicatedRunningView) => void
  onFinished: (finished: DedicatedFinished[]) => void
  now?: () => number
  /**
   * いま利用者の目の前に出ているか（既定は常に true）。専有型のタブは、共用型へ切り替えても**パネルを外さずに隠す**
   * （PublishModal）ので、隠れている間に届いた結果は、画面の状態には入っても**利用者は見ていない**。
   * 隠れている間は、渡した記録も「見た」に数えない（ack しない）。また出たとき（`visibilityChanged`）に、まとめて ack する。
   * 2026-09-30 検分: これが無く、隠れたまま ack して、月額が続く警告が閉じて開き直すと消えた。
   */
  isVisible?: () => boolean
  /**
   * この画面が受け持つ操作の種類（既定は手順5・6・8の3つ＝専有型のパネル）。📡 公開したもの一覧の行は `['teardown']` だけ
   * （削除の進み具合と結果を出す）。**受け持たない種類の記録は「別の持ち場の結果」として扱う**（出さない・ack にも巻き込まない・
   * 走っているときは1行の知らせ〔other〕になる）。
   */
  kinds?: readonly DedicatedOpKind[]
}): DedicatedOpsWatch {
  const { api, projectDir } = deps
  const now = deps.now ?? Date.now
  const isVisible = deps.isVisible ?? (() => true)
  /** 受け持つ種類の記録だけ種類を返す（それ以外は null）。`dedicatedOpKind` は3つ全部を見分けるだけ。 */
  const ownKind = (rec: { target?: string; handler?: string } | null | undefined): DedicatedOpKind | null => {
    const k = dedicatedOpKind(rec)
    return k && (!deps.kinds || deps.kinds.includes(k)) ? k : null
  }
  let stopped = false
  let latest: ProjectOpsSnapshotShape | null = null
  let ackedUpTo = -Infinity
  const delivered = new Set<number>()
  const locals: Partial<Record<DedicatedOpKind, { since: number; active: boolean }>> = {}

  /** この画面が始めた操作の記録か（結果は画面が自分の返り値から出す）。 */
  const isLocalRecord = (rec: ProjectOpRecordShape, kind: DedicatedOpKind): boolean => {
    const local = locals[kind]
    return !!local && rec.startedAt >= local.since
  }

  const apply = (s: ProjectOpsSnapshotShape) => {
    if (stopped) return
    latest = s

    // 走っているもの
    const run = s.running ?? null
    const runKind = ownKind(run)
    deps.onRunning(
      run && runKind ? { running: { kind: runKind, record: run }, other: null }
        : run ? { running: null, other: { op: run.op, targetLabel: isKnownPublishTarget(run.target) ? PUBLISH_TARGET_LABEL[run.target] : null } }
        : { running: null, other: null },
    )

    // 終わったもの（まだ見られていないもの）。古い順。
    const unseen = unseenOf(s)
    const fresh: DedicatedFinished[] = []
    for (const rec of unseen) {
      const kind = ownKind(rec)
      if (!kind) continue // 別の持ち場の結果。出さない（ack にも巻き込まれない・下の isShown が false）
      if (isLocalRecord(rec, kind) || delivered.has(rec.startedAt)) continue
      delivered.add(rec.startedAt)
      fresh.push({ kind, record: rec })
    }

    if (fresh.length > 0) deps.onFinished(fresh) // 画面に渡してから ack する（見せる前に「見た」にしない）
    const ackUpTo = ackUpToFor(unseen, rec => {
      const kind = ownKind(rec)
      if (!kind) return false // 別の持ち場の結果は、出していない
      if (!isVisible()) return false // 隠れているタブの画面は、結果を持っていても、利用者はまだ見ていない
      // この画面が始めた操作は、出し終えるまで「見た」ではない（出し終える前に閉じたら、開き直して記録から出す）。
      if (isLocalRecord(rec, kind)) return locals[kind]!.active === false
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
    beginLocal(kind) { locals[kind] = { since: now(), active: true } },
    endLocal(kind) {
      const l = locals[kind]
      if (!l) return
      l.active = false
      if (latest) apply(latest) // 出し終えたので、その記録を ack へ回す
    },
    visibilityChanged() { if (!stopped && latest) apply(latest) },
    stop() { stopped = true; watch.stop() },
  }
}
