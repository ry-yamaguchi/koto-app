// hanamiiTeardown.ts — HANAMII の破棄（hanamii:teardown）。hanamii.ts（公開・状態・ログ）から切り出した（設計書 docs/teardown-unify-plan.md 10.4.1）。
//
// ── 呼び形 ───────────────────────────────────────────────────────────────────
//   hanamii:teardown (projectDir, { token }, { confirmed, projectId })
// 順序は共通の骨（cloud/teardownShell.ts の runTeardownShell）が持つ: projectDir → 確認の印 → 認証の形 → 鍵（同時に1つだけ）→ run → 記録の片づけ。
// 断った回（確認の印が無い・projectDir が無い・トークンが無い・別の操作が走っている）は、HANAMII へも保存場所へも1本も要求を出さない
// （P1。以前は確認の印の引数そのものが無く、画面のボタンの確認だけが歯止めだった・掟10）。
//
// ── ここが持つもの（run の中身）────────────────────────────────────────────────
//   ・渡された projectId が記録（.sakuraide.json）が指すものと一致するときだけ消す（掟11）。**鍵の中**で読むので、断った回も処理の記録に残る
//   ・DELETE の応答の読み方（D7）: `project.deleted === true` か 404 のときだけ「消えた」。202（`deleted=false`）などは「受け付けただけ」で、
//     保存場所にも記録にも触れずに `deletionAccepted` で返す（記録を消したあとに HANAMII 側の削除が終わらないと、Koto から辿れなくなる）
//   ・消えたあとに保存場所を片づける（teardownHanamiiStorage。手順と守りは cloud/storageTeardown.ts の1つ）
//   ・保存場所だけが残った回は、`publish.hanamii.storageLeftoverBuckets` に印を書く（押し直したときの確認が、消えたプロジェクトの名前を挙げない）
// 公開の記録（📡 の行・projectId）は、全部片づいた回だけ骨が消す（settleHanamiiTeardownFs）。画面は消さない。
//
// ── トークン（D8）──────────────────────────────────────────────────────────────
// main は渡されたトークンだけを使う（使用中・先頭の登録へ倒さない）。どのトークンを渡すかは renderer の仕様書（targets/hanamii.ts）が、
// 公開したときのトークンの tokenId で決め、見つからなければ呼ばずに止める。404 は「存在しない」だけでなく「参照できない」も含む（原本）ので、
// 別のアカウントのトークンで呼ぶと、実体があるのに「もう無い」と読んで保存場所と記録を消しうる。
//
// 公開の記録の読み書き・保存場所の片づけは、ここに新しく書かない（掟10。publishMetaFs.ts と cloud/storageForTarget.ts の1つを通る）。
// electron に依存するのは ipcMain だけ。
import { ipcMain } from 'electron'
import { HanamiiClient, type HanamiiResult } from '../hanamii/client'
import { storagePlacementsOf, storageProjectNameOf, teardownStorageForProject, forgetDeletedBuckets, keptBucketReasonFields, type TorndownBucket } from '../cloud/storageForTarget'
import { keyWarningLines } from '../cloud/storageTeardown'
import { loadCredentials } from '../cloud/auth'
import { runTeardownShell, type TeardownShellCtx, type TeardownShellSpec } from '../cloud/teardownShell'
import { STORAGE_TEARDOWN_PROGRESS, STORAGE_PANEL_DELETE_GUIDE, storageTeardownDoneLine, bucketNamesText } from '../../shared/teardownSupport'
import { keyRevokeGuide } from '../../shared/storageKeys'
import { HANAMII_DELETION_ACCEPTED_WARNING } from '../../shared/teardownResult'
import { readHanamiiProjectIdFs, settleHanamiiTeardownFs, markHanamiiStorageLeftoverFs } from '../publishMetaFs'

/**
 * HANAMII の破棄の結果（`hanamii:teardown` が返すもの）。
 *
 * **`appDeleted` を落とさないこと。** HANAMII のプロジェクトは消えたのに保存場所だけ
 * 片づかなかったとき、`ok:false` だけを返すと画面は「破棄できませんでした」と出し、
 * 公開の記録も残る＝**存在しない公開が一覧に並び続ける**（専有型の指摘4・9・13 と同じ形）。
 */
export type HanamiiTeardownResult = {
  ok: boolean
  /** HANAMII のプロジェクトを削除できたか（保存場所だけ失敗しても true）。 */
  appDeleted?: boolean
  /** 片づけたこと・片づけ切れなかったことの一覧（画面にそのまま出す・**黙らない**）。 */
  executed?: string[]
  /** まだ残っている保存場所の名前（**消すまで月額が続く**）。先頭の1件。 */
  remainingBucket?: string
  /**
   * まだ残っている保存場所の名前を**全部**（2026-09-25 検分の指摘5）。
   * 破棄は同意済みの保存場所を全件片づけるので、残りも全件言わないと
   * **名前が一度も出なかった保存場所の月額が、黙って続く**。
   */
  remainingBuckets?: string[]
  /**
   * **片づけたのに、バケットごとは消さなかった**保存場所（利用者が自分で置いたファイルがある・ほかのプロジェクトが
   * 使っている）の名前。先頭の1件。**残れば月額も続く**（共用型の `cloud:teardown` の `keptBucketName` と同じ事実）。
   * これが無いと、この回は `ok:true` のまま「片づけました — …残します」の1行が executed に入るだけで、警告にならなかった。
   */
  keptBucketName?: string
  /** 同じ事実の全件（複数の保存場所を片づけたとき、名前が出なかった分の月額が黙って続かないように）。 */
  keptBucketNames?: string[]
  /** 残した保存場所のうち、ほかのプロジェクトも使っているため残したもの（`teardownPlanFor` の `keptReasons`）。結果の警告が「消すと、そのプロジェクトのデータも消える」と言う材料。 */
  keptBucketsUsedByOthers?: string[]
  /** 残した保存場所のうち、Koto が作ったのではないファイルがあるため残したもの。 */
  keptBucketsWithOwnFiles?: string[]
  /**
   * HANAMII が削除を**受け付けただけで、まだ終わっていない**回（原本: 202・`deleted=false`・`deletion=accepted`。設計書 10.4.7・D7）。
   * このとき `ok:false`・`appDeleted:false` で、保存場所にも公開の記録にも触れていない（押し直すと、削除が済んでいれば先へ進む）。
   * 専有型の `inProgress`（Koto が待ち切れずに止まった）とは別の事実なので、同じ名前にしない。
   */
  deletionAccepted?: boolean
  message?: string
}

/** バケットごとは消さなかった保存場所の名前と、残した理由（片づけの結果 `done` から。事実だけを返す。理由は共用型・専有型と同じ `keptBucketReasonFields`）。 */
function keptBucketFields(done: ReadonlyArray<TorndownBucket>): Pick<HanamiiTeardownResult, 'keptBucketName' | 'keptBucketNames' | 'keptBucketsUsedByOthers' | 'keptBucketsWithOwnFiles'> {
  const kept = done.filter(b => !b.deletedBucket).map(b => b.bucket)
  return kept.length > 0 ? { keptBucketName: kept[0], keptBucketNames: kept, ...keptBucketReasonFields(done) } : {}
}

/**
 * 片づけ残りがあるときに、**どうすれば止められるか**を添える（2026-09-25 検分の指摘3）。
 *
 * 前は「もう一度 🗑 を押してください」とだけ案内していたのに、
 *   ・📡 公開したもの一覧は、押し直す 🗑 の行を消していた（記録を片づけていた）
 *   ・仮に行が残っても、2度目の破棄は HANAMII の DELETE が 404 で止まり、保存場所へ進めなかった
 * ＝**案内した導線がどこにも無かった**（manualTeardownGuide の Vercel と同じ轍）。
 *
 * いまは押し直せる: `hanamii:teardown` は「HANAMII のプロジェクトがもう無い（404）」なら
 * 保存場所の片づけだけを続け、📡 一覧は片づけ残りがある間は記録を残す。
 * それでも直らないとき（env.json が壊れている等）のために、**コントロールパネルの手順も添える。**
 */
const RETRY_GUIDE = '📡 公開したもの一覧で、もう一度 🗑 を押すと、保存場所の削除だけをやり直します。'
  + `やり直しても消えないときは、${STORAGE_PANEL_DELETE_GUIDE}`

/**
 * HANAMII の破棄の最後に、**保存場所も片づける**（2026-09-25 検分）。
 *
 * ── なぜ要るか ────────────────────────────────────────────────────
 * 📡 公開したもの一覧の確認オーバーレイは、HANAMII でも
 * 「保存場所『X』にある、このプロジェクトのデータも削除します…この保存場所を使っている
 * プロジェクトがほかに無ければ、保存場所そのものも削除して月額を止めます」と言い切る
 * （`teardownDataNoteFor` ／ `teardownRemovesStorage('hanamii')` が true）。
 * ところが実物は HANAMII のプロジェクトを消すだけで、**バケットも、その中のデータも、
 * 鍵（`koto-<名前>-hanamii`）も1件も消していなかった。** 画面が「月額を止めます」と
 * 言い切った後なので利用者はコントロールパネルを確認せず、**月額495円が止まらないまま、
 * 消したはずのアプリの鍵がバケットへ読み書きできるまま生き残る**（共有バケットなら
 * ほかのプロジェクトのデータにも届く）。専有型の手順6で直したのとまったく同じ形である。
 *
 * ── 順序（専有型 `teardownProjectStorage` と同じ）────────────────────
 * **先に HANAMII のプロジェクトを消し、そのあとで保存場所を片づける。** 先に鍵とデータを
 * 消すと、**まだ動いているアプリが 403 で落ちる**（2026-08-14 に共用型で実際に起きた形）。
 * 逆に、保存場所が片づかないことを理由にプロジェクトの削除を止めると、**月額の課金だけが残る**。
 *
 * ── ここに判断を書かないこと（掟10）─────────────────────────────────
 * 「一覧できなければ中止する」「バケットごと消してよいか（`teardownPlanFor`）」「鍵は
 * バケットのあと」は、すべて cloud/storageTeardown.ts の1つに集めてある。ここは
 * 「置き場所を読んで渡し、結果を画面の言葉に直す」だけ。
 *
 * 鍵のIDは HANAMII の記録に残していない（共用型の `state.meta.storagePermissionId`・
 * 専有型の `storagePermissionId` に当たるものが無い）ので `permissionId` は null で渡し、
 * **`sweepKeysFor: 'hanamii'` で「この公開先の名前の鍵を全部」無効にする**（検分の指摘6 と
 * 同じ手）。この時点で HANAMII のプロジェクトは消えている＝現役の鍵は存在しないので、
 * storageKeys.ts の「現役が分からないときは消さない」規則とは矛盾しない。
 * 名前は完全一致で見るので、共用型・専有型・ほかのプロジェクトの鍵には触れない（掟11）。
 */
async function teardownHanamiiStorage(projectDir: string): Promise<HanamiiTeardownResult> {
  // ここへ来た時点で HANAMII のプロジェクトは消えている。以降どう転んでも、
  // **消えたという事実は落とさない**（呼び出し側が公開の記録を片づけられるように）。
  const done: HanamiiTeardownResult = { ok: true, appDeleted: true, executed: [] }
  // env.json が壊れていても、例外を IPC の外へ出さない（専有型の指摘12・14・15 と同じ）。
  // storagePlacementsOf → loadCloudSpec は、JSON として読めない env.json でも、読めてもスペックの検証に通らない env.json でも throw する
  // （確認画面の storage:placement と同じ読み方・2026-10-08）。
  let placements: ReturnType<typeof storagePlacementsOf>
  try {
    placements = storagePlacementsOf(projectDir)
  } catch (e: any) {
    return {
      ...done, ok: false,
      // ここだけはバケット名を出せない（名前の記録そのものが読めない）。**無い導線を案内しない**ので、
      // 押し直しではなくコントロールパネルで確かめてもらう（検分の指摘3）。
      message: `保存場所の設定を読めないため、保存場所は削除していません（消すまで月額が続きます）: ${e?.message ?? String(e)}`
        + '\nさくらのクラウドのコントロールパネル（オブジェクトストレージ）で、残っている保存場所を確かめて削除してください。',
    }
  }
  // 保存場所を使っていないプロジェクトでは、何も言わない・何も呼ばない。
  if (placements.length === 0) return done
  // 鍵を無効にできなかった行に添える案内の名前は、**何も消す前に**読んでおく。保存場所を消したあとは forgetDeletedBuckets が
  // env.json を書き換える（読み直すと名前を失うか、読めずに結果を失う）ので、あとで読み直さない。読めなければ null（投げない）。
  const keyGuide = keyRevokeGuide(storageProjectNameOf(projectDir), 'hanamii')
  // **残りは全件名指しする**（検分の指摘5）。1件だけ名指しすると、名前が出なかった保存場所の
  // 月額が黙って続く（確認画面も全件を名指ししている＝そこと揃える）。
  const allNames = bucketNamesText(placements.map(p => p.bucket))
  const allBuckets = placements.map(p => p.bucket)
  // さくらのクラウドの認証情報は main がファイルで持っている（cloud/auth.ts）。**公開のときに
  // `issueStorageEnvFor` が `loadCredentials()` で読んでいるのとまったく同じ経路**にする
  // ——鍵を発行した側と片づける側で出所を変えない。HANAMII のトークン（方式B・renderer が
  // 引数で渡すもの）とは別物なので、ここで renderer から受け取り直さない。
  const creds = loadCredentials()
  if (!creds) {
    return {
      ...done, ok: false, remainingBucket: placements[0].bucket, remainingBuckets: allBuckets,
      message: `さくらのクラウドのAPIキーが未登録のため、保存場所${allNames}は削除していません（消すまで月額が続きます）。`
        + `「認証情報」でAPIキーを登録してから、${RETRY_GUIDE}`,
    }
  }
  let st: Awaited<ReturnType<typeof teardownStorageForProject>>
  try {
    st = await teardownStorageForProject({ creds, projectDir, permissionId: null, sweepKeysFor: 'hanamii' })
  } catch (e: any) {
    return {
      ...done, ok: false, remainingBucket: placements[0].bucket, remainingBuckets: allBuckets,
      message: `保存場所${allNames}を削除できませんでした（消すまで月額が続きます）: ${e?.message ?? String(e)}`
        + `\n${RETRY_GUIDE}`,
    }
  }
  if (st.reason === 'none') return done
  const executed = [
    ...st.done.map(b => storageTeardownDoneLine(b.bucket, b.note)),
    ...keyWarningLines(st.warnings, keyGuide),
  ]
  // **バケットごと消したものは、env.json の記録からも外す**（専有型の指摘3・8 と同じ）。
  // 残すと画面は「用意済み」のまま、次の公開が**消えたバケット宛ての鍵**を渡して成功扱いになる。
  const deletedBuckets = st.done.filter(b => b.deletedBucket).map(b => b.bucket)
  if (deletedBuckets.length > 0 && !forgetDeletedBuckets(projectDir, deletedBuckets)) {
    executed.push('⚠️ 保存場所の記録（公開の設定・env.json）は残しています。次に公開する前に、【公開】の「保存場所を用意する」からやり直してください')
  }
  if (!st.ok) {
    // HANAMII のプロジェクトは消えている（そのぶんは止まった）が、保存場所は残った。**黙らない。**
    // 途中で止まったので、**片づいた分の後ろにある保存場所も丸ごと残っている**。
    // 残りは全件名指しする（検分の指摘5。1件だけ名指しすると、出なかったぶんの月額が黙って続く）。
    const doneBuckets = new Set(st.done.map(b => b.bucket))
    const remaining = allBuckets.filter(b => !doneBuckets.has(b))
    return {
      ...done, ok: false, executed, remainingBucket: st.remainingBucket, remainingBuckets: remaining,
      ...keptBucketFields(st.done),
      message: st.message
        + (remaining.length > 0 ? `\n保存場所${bucketNamesText(remaining)}が残っています（消すまで月額が続きます）。${RETRY_GUIDE}` : ''),
    }
  }
  return { ...done, executed, ...keptBucketFields(st.done) }
}

/**
 * 画面が持っている HANAMII の projectId が、このプロジェクトの記録（.sakuraide.json）が指すものと違うとき、
 * **何もせずに断る**文（2026-09-30 検分・掟11）。画面が別のプロジェクトの projectId を持ち越したまま呼ぶと、
 * 別のプロジェクトの稼働中のアプリを削除してしまう。最後の砦は main の側に置く。
 * （公開の側の同じ文 PROJECT_MISMATCH_PUBLISH は hanamii.ts に残る。）
 */
export const PROJECT_MISMATCH_TEARDOWN =
  '破棄しようとした HANAMII のプロジェクトが、このプロジェクトの記録が指すものと一致しません。'
  + '何も削除していません。公開のダイアログを閉じて開き直してから、もう一度お試しください。'

// ── DELETE の応答の読み方（D7）──────────────────────────────────────────────────
// 原本（https://hanamii.jp/docs/api の「プロジェクトを削除」）: 200＝物理削除済み（`deleted=true`・`deletion=completed`）、
// 202＝削除受付済み（`deleted=false`・`deletion=accepted`。外部リソースの削除が続くとき）、403＝権限不足、
// 404＝プロジェクトが存在しない**または参照できない**、429＝レート制限。202 の本文の例・削除の途中に押し直したときの応答は原本に無い。
// 以前はハンドラが `r.ok || r.status === 404` だけを見て、202 も「消えた」と読んでいた。
export type HanamiiDeleteReading = 'deleted' | 'not-found' | 'accepted' | 'failed'

/** DELETE の応答を読む（純関数）。`deleted === true` と 404 だけが「消えた」側（呼び手が保存場所へ進んでよい）。 */
export function readHanamiiDeleteReply(r: Pick<HanamiiResult, 'ok' | 'status' | 'data'>): HanamiiDeleteReading {
  if (r.status === 404) return 'not-found'
  if (!r.ok) return 'failed'
  const project = (r.data as { project?: unknown } | null | undefined)?.project
  const deleted = project && typeof project === 'object' ? (project as { deleted?: unknown }).deleted : undefined
  return deleted === true ? 'deleted' : 'accepted'
}

// ── 骨に載せる ──────────────────────────────────────────────────────────────────

type HanamiiAuth = { token: string }

function projectIdOf(opts: Record<string, unknown>): string | null {
  const id = opts.projectId
  return typeof id === 'string' && id !== '' ? id : null
}

/** プロジェクトは消えたのに保存場所が残った回に、押し直したときの確認のための印を書く。書けなくても結果は変えず、知らせの行を足す。 */
function withLeftoverMark(projectDir: string, projectId: string, res: HanamiiTeardownResult): HanamiiTeardownResult {
  // 残っている保存場所の名前は全件。設定を読めない回など名前が分からないときは [] （プロジェクトは消えた・残りの名前は不明）。
  const buckets = res.remainingBuckets ?? (res.remainingBucket ? [res.remainingBucket] : [])
  let failure: string | null = null
  try {
    const marked = markHanamiiStorageLeftoverFs(projectDir, projectId, buckets)
    if (!marked.ok) failure = marked.message
  } catch (e: any) {
    failure = e?.message ?? String(e)
  }
  if (failure === null) return res
  return {
    ...res,
    executed: [
      ...(res.executed ?? []),
      `⚠️ 保存場所が残っていることを、公開の記録に書けませんでした。もう一度破棄を押すと、残りの保存場所を削除します: ${failure}`,
    ],
  }
}

async function runHanamiiTeardown(ctx: TeardownShellCtx<HanamiiAuth>): Promise<HanamiiTeardownResult> {
  const { projectDir, auth, progress } = ctx
  // ── 渡された projectId は、このプロジェクトの記録が指すものと一致するときだけ消す（2026-09-30 検分・掟11）──
  // 画面が別のプロジェクトの projectId を持ち越したまま 🗑 を押すと、**別のプロジェクトの稼働中の HANAMII アプリを消し**、
  // しかもここは 404 でも「もう無い」として、いまの projectDir の保存場所まで片づけていた。食い違うなら、何も呼ばずに断る。
  // すべての呼び出し（【公開】の 🗑・📡 一覧・プロジェクト削除）は、この記録から projectId を読んで渡すので、正しい呼び出しは通る。
  // 鍵（withProjectLock）の中で読むので、同じプロジェクトの公開が記録を書き換えている最中には見ない。
  const projectId = projectIdOf(ctx.opts)
  if (!projectId || readHanamiiProjectIdFs(projectDir) !== projectId) {
    return { ok: false, message: PROJECT_MISMATCH_TEARDOWN }
  }
  // 通信そのものが失敗したら例外を IPC の外へ出さない（【公開】の 🗑 は結果を待つだけで catch を持たないので、
  // 投げると確認ダイアログが開いたまま固まる）。
  let r: HanamiiResult
  progress('🗑 HANAMII のプロジェクトを破棄しています…')
  try {
    r = await new HanamiiClient({ token: auth.token }).deleteProject(projectId)
  } catch (e: any) {
    return { ok: false, message: `削除に失敗しました: ${e?.message ?? String(e)}` }
  }
  const reading = readHanamiiDeleteReply(r)
  // **消せていないうちは保存場所に触らない**（アプリがまだ動いている＝鍵を消すと 403 で落ちる）。
  if (reading === 'failed') return { ok: false, message: `削除に失敗しました（HTTP ${r.status}）` }
  // 受け付けただけ（202 など）: 保存場所にも記録にも触れない（D7）。結果は `deletionAccepted`（`inProgress` ではない）。
  if (reading === 'accepted') {
    return { ok: false, appDeleted: false, deletionAccepted: true, message: HANAMII_DELETION_ACCEPTED_WARNING }
  }
  // 'deleted' も 'not-found' も「動いているアプリはもう無い」＝鍵を消しても 403 で落ちるものが無いので、保存場所へ進んでよい
  // （2026-09-25 検分の指摘3。2度目の破棄は 404 になる。共用型 apply.ts の削除も 404 を同じ扱いにしている）。
  progress(STORAGE_TEARDOWN_PROGRESS)
  const res = await teardownHanamiiStorage(projectDir)
  // 全部片づいた回は、公開の記録を骨が消す（settleHanamiiTeardownFs）。保存場所だけ残った回は、行も projectId も残し、印を書く。
  return res.ok ? res : withLeftoverMark(projectDir, projectId, res)
}

/** HANAMII の破棄を骨に載せる定義。公開の記録を消す規則は「全部片づいた（ok）回だけ」。 */
export const HANAMII_TEARDOWN_SHELL: TeardownShellSpec<HanamiiAuth, HanamiiTeardownResult> = {
  target: 'hanamii',
  handler: 'hanamii:teardown',
  parseAuth(auth) {
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return null
    const token = (auth as { token?: unknown }).token
    return typeof token === 'string' && token !== '' ? { token } : null
  },
  authMissingMessage: 'HANAMII のトークンが未登録です',
  secretsOf: auth => [auth.token],
  run: runHanamiiTeardown,
  // 以前の hanamii.ts と同じ（`if (!res.ok) return res`）。`hadPublishRecord` は見ない: targets.hanamii が無く hanamii.projectId だけの旧い記録も
  // 片づける必要があり、その判断は settleHanamiiTeardownFs の中にある。
  shouldForgetRecord: ({ result }) => result.ok === true,
  forgetRecord: ctx => settleHanamiiTeardownFs(ctx.projectDir, projectIdOf(ctx.opts) ?? ''),
  refused: message => ({ ok: false, message }),
}

/** hanamii:teardown を登録する（registerHanamiiHandlers から呼ぶ）。 */
export function registerHanamiiTeardownHandler(): void {
  ipcMain.handle('hanamii:teardown', (_event, projectDir: unknown, auth: unknown, opts: unknown): Promise<HanamiiTeardownResult> =>
    runTeardownShell(HANAMII_TEARDOWN_SHELL, { projectDir, auth, opts }))
}
