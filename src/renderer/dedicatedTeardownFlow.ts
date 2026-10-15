// dedicatedTeardownFlow.ts — 専有型の「すべて削除」の流れ（確認 → 実行 → 進み具合の読み方）を、
// **手順6「すべて削除する」と 📡 公開したもの一覧の「🗑 破棄」で共有する**唯一の部品（React に依存しない）。
//
// ── 作者の決定（2026-10-08・Ryosuke さん）────────────────────────────────────────
// 専有型の 📡 の「🗑 破棄」は、手順6「すべて削除する」と**同じ「すべて削除」**（アプリ → ロードバランサ →
// オートスケーリンググループ → クラスタ ＋ 保存場所の片づけ）にする。アプリだけを消す口は廃止した。
// **中身（処理と画面の流れ）は1つ**にして、**押せる場所はいまのまま**（専有型タブの手順6と、📡 の各行の 🗑）。
// どちらから押しても、同じ確認の文・同じ進み具合・同じ閉じるときの警告・同じ結果・同じ公開の記録の片づけになる。
//
// ── どこに何があるか（掟10: 定義は1か所）─────────────────────────────────────────
//   確認の文を作る        … buildDedicatedTeardownConfirm（ここ。2つの入口が同じ関数を呼ぶ）
//   確認の材料を読む      … loadDedicatedTeardownFacts（ここ。記録・保存場所・ほかの公開先・目安を、入口によらず main から読み直す）
//   確認 → 実行 → 結果    … runDedicatedTeardown（ここ。確認の答えが no なら IPC を1回も呼ばない・実行中は活動レジストリへ計上。
//                           消すものが記録に無い〔幽霊の行〕なら、破壊の確認は出さず IPC も呼ばない・dedicatedTeardownHasWork）
//   進み具合の文を選ぶ    … teardownProgressText（ここ）
//   公開の記録を消す      … **main の apprunDedicated:teardown の中の1か所**（shouldForgetPublishRecord）。画面は消さない
//   見た目（進み具合・結果）… components/DedicatedTeardownView.tsx（2つの入口が同じ部品）
//   📡 の行の状態         … hooks/useDedicatedTeardown.ts
//
// 掟4（方式B）: キーは使う瞬間に読んで引数で渡す。ここでは保存しない。
// 掟5: 確認は ConfirmModal（useConfirm）。window.confirm は使わない。

import type { ConfirmOptions } from './useConfirm'
import { PUBLISH_TARGET_LABEL } from './publishStatus'
import { readPublishTargetsOrThrow } from './publishRecord'
import { teardownConfirmMessage, runTeardown, opProgressText, type ActionOutcome } from './apprunDedicatedActions'
import { PUBLISH_CLOSE_WARNING, beginActivity } from './activity'
import { teardownDataNoteForAll, dedicatedTeardownHasWork } from '../shared/teardownSupport'
import { estimateLineFor } from '../shared/stageEstimate'
import { STAGE } from '../shared/stageTiming'

/** 専有型の公開先（publish.targets のキー）。 */
const DEDICATED: 'sakura-apprun-dedicated' = 'sakura-apprun-dedicated'

/** 削除の結果（IPC の返り値）。手順6の結果欄も 📡 の結果欄も、この形を描く。 */
export type DedicatedTeardownResult = Awaited<ReturnType<Window['electronAPI']['apprunDedicated']['teardown']>>

/** 確認に出す「消えるもの」の材料（記録の資源ID。アプリの名前があれば名前を出す）。 */
export type DedicatedTeardownRecord = {
  applicationID?: string | null
  applicationName?: string | null
  loadBalancerID?: string | null
  asgID?: string | null
  clusterID?: string | null
  /** 前回の削除で保存場所だけが残った印（main が記録する）。 */
  storageLeftoverBucket?: string | null
} | null | undefined

export type DedicatedPlacement = { bucket: string; prefix?: string; shared?: boolean }

/** 保存場所の設定を読めなかった理由（`DedicatedTeardownFacts.placementsUnreadableCause`）。 */
export type PlacementsUnreadableCause = 'settings' | 'call'

/** `storage:placement` が `ok:false` を返した（設定そのものを読めなかった）ときの失敗。問い合わせそのものの失敗（IPC の reject）とは別の事実として区別する印を付ける。 */
function placementSettingsUnreadable(message: string): Error {
  return Object.assign(new Error(message), { placementSettingsUnreadable: true as const })
}

/** `api.placements` が投げたものから、読めなかった理由を決める。印の付いた失敗だけが `'settings'`、ほかは問い合わせの失敗（`'call'`）。 */
function placementsFailureCause(e: unknown): PlacementsUnreadableCause {
  return (e as { placementSettingsUnreadable?: unknown } | null)?.placementSettingsUnreadable === true ? 'settings' : 'call'
}

/** 確認の文を作る材料。 */
export type DedicatedTeardownFacts = {
  /**
   * どのプロジェクトの削除か（フォルダ名）。確認の先頭に出す——全プロジェクトが並ぶ 📡 の一覧で、アプリが消えたあとのやり直し
   * （アプリ名が無く ID だけ）でも、どのプロジェクトのものを消すのか確かめられるように（2026-10-08 検分）。
   */
  projectName: string
  record: DedicatedTeardownRecord
  /** 消える保存場所の**全件**（先頭1件にしない・名前が出なかった保存場所のデータまで消えるため）。 */
  placements: DedicatedPlacement[]
  /**
   * 保存場所の設定を**読めなかった**（`storage:placement` が失敗した）。このとき main も保存場所の設定を読めず、保存場所に
   * **触れない**（`storagePlacementsOf` → `loadCloudSpec` が、JSON として読めない／スペックの検証に通らない env.json で投げる→
   `teardownProjectStorage` が「保存場所の設定を読めないため、保存場所は削除していません」で止まる。`storage:placement` と同じ読み方）。
   * つまり保存場所は**消えずに残る**——そのことを確認の文で言う（黙って空に倒さない・2026-10-08 検分。最初の版は「消えます」と
   * 逆のことを言っていた。原本 src/main/cloud/storageForTarget.ts・src/main/ipc/apprunDedicated.ts の teardownProjectStorage で確認）。
   */
  placementsUnreadable: boolean
  /**
   * 読めなかった理由（`placementsUnreadable` が true のときだけ意味がある。省略は `'call'` と同じ扱い）。
   *   ・`'settings'` … 設定そのものを読めなかった（`storage:placement` が `ok:false` を返した）。上の説明どおり main も保存場所に触れない＝残る。
   *   ・`'call'`     … 問い合わせそのものが失敗した（IPC が reject した）。main は env.json を問題なく読めて、保存場所を削除するかもしれない
   *                    ——**「削除は行われません」とは言えない**（2026-10-08 検分。IPC の失敗まで「行われません」と言うと、この狭い場合は事実と逆になる）。
   */
  placementsUnreadableCause?: PlacementsUnreadableCause | null
  /** この公開先以外に、いま生きている公開先の表示名（保存場所は公開先をまたいで同じプロジェクトのものを使う）。 */
  otherTargets: string[]
  /**
   * ほかの公開先の記録（.sakuraide.json）を読めなかった。巻き添えになる公開先の名前を出せない。
   * 立つのは `readPublishTargetsOrThrow` が投げたとき（ファイルを読めない・壊れた JSON・形が違う）。
   * 「記録が読めて、ほかの公開先が無かった」は立たない（空配列と読めなかったは別のこと）。
   */
  otherTargetsUnreadable: boolean
  /** ロードバランサの削除の目安の一文（shared/stageEstimate.ts の出力。目安が無ければ null）。 */
  lbEstimateLine: string | null
}

/** 活動レジストリに載せる名前（窓を閉じるときの警告に出る）。 */
export const DEDICATED_TEARDOWN_ACTIVITY_LABEL = '専有型クラスタの削除'

/**
 * 削除するものの名前（アプリ → ロードバランサ → オートスケーリンググループ → クラスタの順。main の teardownFlow と同じ順）。
 * 記録にあるものだけを並べる。
 */
export function dedicatedTeardownTargets(record: DedicatedTeardownRecord): string[] {
  return [
    record?.applicationID ? `アプリ『${record.applicationName ?? record.applicationID}』` : null,
    record?.loadBalancerID ? `ロードバランサ『${record.loadBalancerID}』` : null,
    record?.asgID ? `オートスケーリンググループ『${record.asgID}』` : null,
    record?.clusterID ? `クラスタ『${record.clusterID}』` : null,
  ].filter((x): x is string => !!x)
}

/**
 * 「ロードバランサの削除は時間がかかる」の予告の一文。**目安の数字はここで持たない**（shared/stageEstimate.ts の出力を使う）。
 * ロードバランサを消さないとき（記録に無い）・目安が無いときは null——無い段の話をしない・測っていない段に目安を作らない。
 */
export function lbWaitNote(record: DedicatedTeardownRecord, lbEstimateLine: string | null): string | null {
  if (!record?.loadBalancerID || !lbEstimateLine) return null
  return `⏳ ロードバランサの削除には時間がかかります。${lbEstimateLine}。`
}

/**
 * 確認の材料を読めなかったときの注意（読めた材料だけで確認を出すと、利用者が事実と違う理解で「削除する」を押すため）。
 *
 * ・ほかの公開先の記録を読めなかった: main は、確認で何が見えたかと無関係に、env.json の保存場所を全件・ほかの公開先が
 *   使っていても片づける。巻き添えになる公開先の名前を出せない。
 * ・保存場所の設定を読めなかった（`'settings'`・`storage:placement` が ok:false）: **逆に、main も保存場所に触れない**（保存場所の削除は行われず、残る）。
 *   「保存場所も消える」と言うと事実と逆になる（最初の版の誤り）。残る保存場所は月額が続くので、そう言う。
 * ・保存場所の設定を**問い合わせられなかった**（`'call'`・IPC の失敗）: main は env.json を読めて、保存場所を削除するかもしれない。
 *   「削除は行われません」とは言えない（言うと、この狭い場合に事実と逆になる）ので、名前を挙げられないこと・削除される場合があることを言う。
 */
export function unreadableCautions(facts: Pick<DedicatedTeardownFacts, 'placementsUnreadable' | 'placementsUnreadableCause' | 'otherTargetsUnreadable'>): string[] {
  const out: string[] = []
  if (facts.placementsUnreadable) {
    if (facts.placementsUnreadableCause === 'settings') {
      out.push('⚠️ 保存場所の設定を読めないため、保存場所の削除は行われません。'
        + 'このプロジェクトが保存場所を使っていれば、その保存場所は残り、月額が続きます。'
        + '保存場所も削除したいときは、この確認を閉じて、設定を直してからやり直してください。')
    } else {
      out.push('⚠️ 保存場所の設定を問い合わせられなかったため、ここに保存場所の名前を挙げられません。'
        + 'このプロジェクトが保存場所を使っていれば、その中のこのプロジェクトのデータも削除される場合があります。')
    }
  }
  if (facts.otherTargetsUnreadable) {
    out.push('⚠️ ほかの公開先の記録を読めなかったため、ここに挙げられません。'
      + '保存場所をほかの公開先（HANAMII・共用型など）が使っていれば、そちらのアプリのデータも消えます。')
  }
  return out
}

/**
 * 削除の確認ダイアログ（ConfirmModal に渡すもの）。**手順6も 📡 の 🗑 も、これだけが作る**（2つの入口で同じ入力なら同じ文）。
 *
 * 文の本体は teardownConfirmMessage（消えるもの・保存場所のデータ・ほかの公開先・課金が止まること）。
 * 保存場所の約束は shared/teardownSupport.ts の teardownDataNoteForAll（scope は常に 'full'＝専有型の削除は保存場所まで片づける）。
 * 2026-10-08: ロードバランサの削除にかかる時間（目安）を、押す前に伝える。
 */
export function buildDedicatedTeardownConfirm(facts: DedicatedTeardownFacts): Required<Pick<ConfirmOptions, 'title' | 'body' | 'confirmLabel' | 'danger'>> {
  const body = teardownConfirmMessage({
    targets: dedicatedTeardownTargets(facts.record),
    placements: facts.placements,
    dataNote: teardownDataNoteForAll({ target: DEDICATED, scope: 'full', placements: facts.placements }),
    otherTargets: facts.otherTargets,
    waitNote: lbWaitNote(facts.record, facts.lbEstimateLine) ?? undefined,
  })
  // 先頭: どのプロジェクトのものを消すか。続けて、材料を読めなかったときの注意（名指しできないものが消えうることを黙らない）。
  const head = [`対象のプロジェクト: 『${facts.projectName}』`, ...unreadableCautions(facts)].join('\n\n')
  // W-117: ConfirmModal は danger のとき自分で「⚠️ 」を title の前に付ける。ここでは付けない。
  // 0.6.21: 手順6の見出し・ボタン・確認・進み具合・結果は「削除」で揃える（1回の流れの中で名前を変えない）。
  return { title: '専有型クラスタを削除します', body: `${head}\n\n${body}`, confirmLabel: '削除する', danger: true }
}

/** 確認の材料を読む口（テストでは偽物を渡す）。 */
export interface DedicatedTeardownFactsApi {
  state(projectDir: string): Promise<DedicatedTeardownRecord>
  placements(projectDir: string): Promise<DedicatedPlacement[]>
  otherTargets(projectDir: string): Promise<string[]>
  estimates(): Promise<unknown>
}

/** 本物の口（window.electronAPI）。window は呼ぶ時に初めて触る。 */
export function electronFactsApi(): DedicatedTeardownFactsApi {
  return {
    state: dir => window.electronAPI.apprunDedicated.state(dir),
    placements: async dir => {
      const r = await window.electronAPI.storage.placement(dir)
      // 読めなかった（ok:false）は**空と区別して投げる**。空に倒すと、名前を出せないまま保存場所のデータが消える
      // （呼び出し側が「読めなかった」注意を確認の文に足す）。ok:false は「設定そのものを読めなかった」＝印を付ける
      // （問い合わせそのものの失敗〔IPC の reject〕とは、確認の文が言うことが違う）。
      if (!r.ok) throw placementSettingsUnreadable((r as { message?: string }).message ?? '保存場所の設定を読めませんでした')
      // placements（全件）が無い版の応答でも、先頭1件だけは必ず拾う（黙って空にしない）。
      return r.placements ?? (r.placement ? [r.placement] : [])
    },
    // 読めなかったら**投げる**（空に倒さない）——loadDedicatedTeardownFacts が「読めなかった」事実を残し、確認の文が言う。
    otherTargets: async dir => (await readPublishTargetsOrThrow(dir)).filter(t => t !== DEDICATED).map(t => PUBLISH_TARGET_LABEL[t]),
    estimates: () => window.electronAPI.stageTiming.estimates(),
  }
}

/**
 * 確認の材料を、**押した時点の main の記録から**読む（画面が持っている写しはいつでも古い・掟10）。
 * 手順6も 📡 も同じこの関数を使う。
 *
 * - 資源の記録（record）が読めなければ**投げる**（消すものが分からないまま確認を出さない）。
 * - 保存場所・ほかの公開先・目安は、読めなくても削除そのものはできるので、空に倒して続ける。ただし
 *   **保存場所・ほかの公開先が読めなかった事実は残し**（`placementsUnreadable`・`otherTargetsUnreadable`）、確認の文で言う。
 *   保存場所の設定そのものが読めないとき（`placementsUnreadableCause: 'settings'`）、main も保存場所に触れない（残る）。
 *   問い合わせそのものが失敗したとき（`'call'`）は、main がどうするかは分からない。ほかの公開先の記録が読めないとき、main は
 *   env.json の保存場所を全件片づける（巻き添えになる公開先を名指しできないだけ）。事実が別々なので、文も別々（unreadableCautions）。
 *   目安だけは、読めなくても確認の中身（何が消えるか）は変わらない。
 */
export async function loadDedicatedTeardownFacts(projectDir: string, api: DedicatedTeardownFactsApi): Promise<DedicatedTeardownFacts> {
  const record = await api.state(projectDir)
  const [placements, otherTargets, estimates] = await Promise.all([
    api.placements(projectDir).then(
      v => ({ v, unreadable: false, cause: null as PlacementsUnreadableCause | null }),
      (e: unknown) => ({ v: [] as DedicatedPlacement[], unreadable: true, cause: placementsFailureCause(e) as PlacementsUnreadableCause | null }),
    ),
    api.otherTargets(projectDir).then(v => ({ v, unreadable: false }), () => ({ v: [] as string[], unreadable: true })),
    api.estimates().catch((): unknown => null),
  ])
  return {
    projectName: projectNameOf(projectDir),
    record,
    placements: Array.isArray(placements.v) ? placements.v : [],
    placementsUnreadable: placements.unreadable,
    placementsUnreadableCause: placements.cause,
    otherTargets: Array.isArray(otherTargets.v) ? otherTargets.v : [],
    otherTargetsUnreadable: otherTargets.unreadable,
    lbEstimateLine: estimateLineFor(STAGE.teardownLb, estimates),
  }
}

/** プロジェクトのフォルダ名（確認の先頭に出す）。 */
function projectNameOf(projectDir: string): string {
  return projectDir.split('/').filter(Boolean).pop() ?? projectDir
}

/** 実行に要る口（テストでは偽物を渡す）。 */
export interface RunDedicatedTeardownDeps {
  loadFacts(): Promise<DedicatedTeardownFacts>
  /** ConfirmModal（useConfirm の confirm）。 */
  confirm(opts: ConfirmOptions): Promise<boolean>
  /** さくらのクラウドのキー（方式B）。無ければ null。 */
  loadKey(): Promise<{ token: string; secret: string } | null | undefined>
  /** IPC `apprunDedicated:teardown`。 */
  teardown(projectDir: string, auth: { token: string; secret: string }, opts: { confirmed: boolean }): Promise<DedicatedTeardownResult>
  /** 活動レジストリ（activity.ts の beginActivity と同じ形）。 */
  beginActivity(label: string, opts: { closeWarning: { detail: string; confirmLabel: string } }): () => void
  /** 確認が済んで、実行が始まる直前（画面が「削除しています…」にする）。キャンセルなら呼ばれない。 */
  onStart?(): void
  /** キーが無いときに結果欄へ出す文（入口ごとに、キーを登録する場所の案内が違う）。 */
  keyMissingMessage: string
}

const failure = (message: string): DedicatedTeardownResult => ({ ok: false, executed: [], message, remaining: {} })

/**
 * 消すものが記録に無いときの案内（幽霊の行の 🗑）。さくらのクラウドには何も要求していない。行を消すのは「一覧から削除」。
 *
 * 「一覧から削除」は Koto の記録の行を消すだけで、さくら側の実物には触れない。記録が失われただけで実物が残っていることもあるので
 * （Koto の記録に無いものは、Koto からは消せない）、押す前に、さくら側に残っていないかを確かめてもらう。
 * 確かめる場所は 📡 の「さくら側にあるものと、かかっている費用」（「調べる」を押したときだけ問い合わせる）か、コントロールパネル。
 * README・使い方ガイド（docs/usage-guide.html）にもこの文を引いている（掟9）。
 */
export const NOTHING_TO_DELETE_MESSAGE = '削除するもの（アプリ・ロードバランサ・オートスケーリンググループ・クラスタ）が、このプロジェクトの記録にありません。'
  + 'さくらのクラウドには何も要求していません。📡 公開したもの一覧に行だけが残っているときは、その行の「一覧から削除」で消せます。'
  + 'さくら側に残っていないかは、📡 の「さくら側にあるものと、かかっている費用」で「調べる」を押すか、コントロールパネルで確かめてから、「一覧から削除」してください。'

/**
 * 本物の口（window.electronAPI・活動レジストリ）につないだ deps。**手順6も 📡 の行も、これを使う**
 * （確認の材料の読み方・キーの読み方・IPC・窓を閉じる警告を、入口ごとに書き直さない）。
 * 入口が決めるのは、確認ダイアログの出し方（`confirm`）・キーが無いときの文・実行が始まる直前の画面の更新（`onStart`）だけ。
 */
export function electronTeardownDeps(projectDir: string, entry: {
  confirm: RunDedicatedTeardownDeps['confirm']
  keyMissingMessage: string
  onStart?: () => void
}): RunDedicatedTeardownDeps {
  return {
    loadFacts: () => loadDedicatedTeardownFacts(projectDir, electronFactsApi()),
    confirm: entry.confirm,
    loadKey: () => window.electronAPI.cloud.loadKey(),
    teardown: (dir, auth, opts) => window.electronAPI.apprunDedicated.teardown(dir, auth, opts),
    beginActivity,
    keyMissingMessage: entry.keyMissingMessage,
    ...(entry.onStart ? { onStart: entry.onStart } : {}),
  }
}

/**
 * 確認 → 実行。**手順6も 📡 の 🗑 も、これを通る。**
 *
 * - 確認の材料が読めなければ、確認も IPC も出さずに失敗の結果を返す（消すものが分からないまま消させない）。
 * - 確認の答えが no なら `cancelled`。**IPC は1回も呼ばれない**（活動レジストリにも載せない）。
 * - yes なら、活動レジストリに載せ（窓を閉じるときの警告 PUBLISH_CLOSE_WARNING）、キーを読み、
 *   `{ confirmed: true }` を付けて **IPC を1回だけ**呼ぶ。成功・失敗を問わず必ず活動レジストリから外す。
 * - 公開の記録（📡 の行）は**ここでも画面でも消さない**。main の IPC が、アプリが消えたと分かった時に1回だけ消す。
 */
export async function runDedicatedTeardown(projectDir: string, deps: RunDedicatedTeardownDeps): Promise<ActionOutcome<DedicatedTeardownResult>> {
  let facts: DedicatedTeardownFacts
  try {
    facts = await deps.loadFacts()
  } catch (e: any) {
    return { cancelled: false, result: failure(`削除するものの記録を読めませんでした: ${e?.message ?? String(e)}`) }
  }
  // 消すものが記録に無い（資源の記録が空で、前回の保存場所の残りも無い＝幽霊の行）。破壊の確認は出さない——
  // 「次を削除します: 」と何も名指ししないまま「削除する」を押させない。IPC も呼ばない（main も同じ判断で保存場所に触れない）。
  // 手順6はこのとき 🗑 のボタン自体が出ない（shouldShowTeardownButton）ので、2つの入口の行き着く先を揃える。
  if (!dedicatedTeardownHasWork(facts.record)) return { cancelled: false, result: failure(NOTHING_TO_DELETE_MESSAGE) }
  const confirmOpts = buildDedicatedTeardownConfirm(facts)
  // 確認そのものは先に済ませる（ConfirmModal は非同期）。runTeardown へは「もう確定した答え」を同期関数で渡す。
  const ok = await deps.confirm(confirmOpts)
  return runTeardown<DedicatedTeardownResult>(
    { confirmMessage: confirmOpts.body },
    {
      confirm: () => ok,
      activity: { begin: () => deps.beginActivity(DEDICATED_TEARDOWN_ACTIVITY_LABEL, { closeWarning: PUBLISH_CLOSE_WARNING }) },
      teardown: async (opts) => {
        deps.onStart?.()
        const auth = await deps.loadKey()
        if (!auth || !auth.token || !auth.secret) return failure(deps.keyMissingMessage)
        return deps.teardown(projectDir, auth, opts)
      },
    },
  )
}

/**
 * 進み具合の文。**記録（projectOps）が「削除が走っている」と言うなら記録の文**（別の窓で始めたものも、開き直したものも読める）、
 * そうでなければ、この画面が始めた処理に届いた最新の1行。手順6も 📡 の行も同じ選び方。
 */
export function teardownProgressText(s: {
  runningKind: string | null
  runningRecord: { progress?: { label?: string; detail?: string } } | null | undefined
  local: string | null
}): string | null {
  return s.runningKind === 'teardown' ? opProgressText(s.runningRecord) : s.local
}

/** 削除が済んだ（あるいは止まった）ことを、開いている画面（公開の一覧・ステータスバー）へ知らせる。読み直すだけで書かない。 */
export function notifyDedicatedTeardownFinished(): void {
  window.dispatchEvent(new Event('sakura-meta-changed'))
}
