// apprunDedicatedTeardown.ts — 専有型の削除（apprunDedicated:teardown）。ipc/apprunDedicated.ts（接続・作成・公開・状態）から切り出した
// （設計書 docs/teardown-unify-plan.md 10.11.4。0.6.22 段階3B-1）。
//
// ── 呼び形 ───────────────────────────────────────────────────────────────────
//   apprunDedicated:teardown (projectDir, { token, secret }, { confirmed })
// 順序は共通の骨（cloud/teardownShell.ts の runTeardownShell）が持つ: projectDir → 確認の印 → 認証の形 → 鍵（同時に1つだけ）→ run → 記録の片づけ。
// 断った回（確認の印が無い・projectDir が無い・キーが空・別の操作が走っている）は、さくらへも保存場所へも1本も要求を出さず、処理の記録も作らない
// （以前は鍵を取ってから teardownFlow の中で確認の印を断っていたので、印の無い呼び出しでも「削除」の記録が1件できた）。
//
// ── ここが持つもの（run の中身）────────────────────────────────────────────────
//   ・破棄の前の記録を先に読む（消すものが記録にあったか。保存場所に触れてよいかの材料）
//   ・teardownFlow（アプリ → LB → ASG → クラスタ。本体は cloud/apprunDedicatedApply.ts のまま変えない）
//   ・計算資源が消し切れたら、保存場所も片づける（teardownProjectStorage。手順と守りは cloud/storageTeardown.ts の1つ）
// 公開の記録（📡 の行）を消すかは規則 shouldForgetPublishRecord の1つ（保存場所まで片づいた回だけ。D1=1）で、消すのは骨の1か所。画面は消さない。
//
// 認証情報は renderer から引数で受け取るだけで、main には保存しない（掟4・方式B）。
// electron に依存するのは ipcMain だけ。
import { ipcMain } from 'electron'
import { teardownFlow, shouldForgetPublishRecord, type TeardownFlowResult } from '../cloud/apprunDedicatedApply'
import type { CloudCredentials } from '../cloud/auth'
import { storagePlacementsOf, storageProjectNameOf, teardownStorageForProject, forgetDeletedBuckets, keptBucketReasonFields } from '../cloud/storageForTarget'
import { keyWarningLines } from '../cloud/storageTeardown'
import { runTeardownShell, type TeardownShellSpec } from '../cloud/teardownShell'
import { readApprunDedicatedFs, writeApprunDedicatedRecordFs, forgetPublishTargetFs } from '../publishMetaFs'
import { STAGE, UNMEASURED, type StageMark } from '../../shared/stageTiming'
// 消すものが記録に無い（幽霊の行）なら、保存場所には触れない。判断は shared の1つ（画面の確認もこれを使う）。
import {
  dedicatedTeardownHasWork, dedicatedStorageLeftoverNames, bucketNamesText, STORAGE_TEARDOWN_PROGRESS, storageTeardownDoneLine,
} from '../../shared/teardownSupport'
import { keyRevokeGuide } from '../../shared/storageKeys'
import { isCreds, recordedZone } from './apprunDedicatedCommon'

/**
 * 印を書けなかった回に、結果へ足す知らせ（双子の HANAMII の withLeftoverMark と同じ役目）。印が無いと、行は残っても押し直しの 🗑 が
 * 「記録にありません」で止まり、月額が続く保存場所に辿れない。**押し直せるとは言わない**（押し直しの成否が、書けなかった印に懸かっているため）。
 */
const MARK_FAILED_WARNING = '⚠️ 残っている保存場所を公開の記録に書けませんでした。'
  + 'さくらのクラウドのコントロールパネル（オブジェクトストレージ）で、残っている保存場所を確かめて削除してください。'
/** 印を下ろせなかった回の知らせ。保存場所はもう残っていないのに、プロジェクトの削除が「保存場所だけが残っています」で止まり続ける。もう一度実行すれば下りる。 */
const CLEAR_FAILED_WARNING = '⚠️ 保存場所は残っていませんが、公開の記録の「保存場所が残っている」印を消せませんでした。'
  + 'フォルダの書き込み権限を確かめて、もう一度削除を実行してください。'

/**
 * 残っている保存場所の名前（全件）を、記録に印として書く（押し直したとき・名前を言う画面が読む）。
 * `storageLeftoverBucket` は先頭の1件（「消すものがあるか」の判断と旧い記録の読みが見続ける）、`storageLeftoverBuckets` は全件。
 * **必ず同じ回に両方を書く**（片方だけだと、🗄️ の行とプロジェクトの削除を止める文が、残っていない保存場所の名前を言い続ける）。
 * 返り値は、書けなかったときに結果へ足す知らせの行（書けたら空）。
 */
function markStorageLeftover(projectDir: string, remaining: readonly string[]): string[] {
  return writeApprunDedicatedRecordFs(projectDir, { storageLeftoverBucket: remaining[0] ?? null, storageLeftoverBuckets: [...remaining] })
    ? [] : [MARK_FAILED_WARNING]
}

/** 印を下ろす（もう残っていない）。2つを必ず一緒に。返り値は、下ろせなかったときの知らせの行（下ろせたら空）。 */
function clearStorageLeftover(projectDir: string): string[] {
  return writeApprunDedicatedRecordFs(projectDir, { storageLeftoverBucket: null, storageLeftoverBuckets: null })
    ? [] : [CLEAR_FAILED_WARNING]
}

/** 結果の message に足す、残っている保存場所の全件の行（共用型・HANAMII と同じ文。名前の並べ方は3つとも bucketNamesText の1つ）。 */
const leftoverLine = (names: readonly string[]): string => `\n保存場所${bucketNamesText(names)}が残っています（消すまで月額が続きます）。`

/**
 * 手順6「すべて削除する」の最後に、**保存場所も片づける**（2026-09-24 Ryosuke 決定「(1)は案2・
 * 一貫性が重要」＝共用型と同じにする）。
 *
 * ── なぜ手順6の最後なのか ────────────────────────────────────────────────
 * アプリ→LB→ASG→クラスタが消えてからにする。先に鍵とデータを消すと、**まだ動いている
 * アプリが 403 で落ちる**（2026-08-14 に共用型で実際に起きた形）。逆に、保存場所が
 * 片づかないことを理由に計算資源の削除を止めると、**月額の課金だけが残る**——だから
 * 計算資源を先に消し切り、保存場所はそのあとで片づける。
 *
 * ── ここに判断を書かないこと（掟10）──────────────────────────────────
 * 「一覧できなければ中止する」「バケットごと消してよいか（teardownPlanFor）」「鍵は
 * バケットのあと」は、すべて cloud/storageTeardown.ts の1つに集めてある。ここは
 * 「記録から鍵のIDを読んで渡し、結果を画面の言葉に直す」だけ。
 *
 * **📡 公開したもの一覧の「🗑 削除」も、手順6と同じこの道（apprunDedicated:teardown）を通る**
 * （2026-10-08 作者の決定: アプリだけを消す専用の口は廃止した）。だから、どちらの入口から押しても同じ。
 */
async function teardownProjectStorage(
  auth: CloudCredentials, projectDir: string, res: TeardownFlowResult,
  progress: (msg: string, extra?: { stage?: string }) => void,
  onStage: (stage: string, mark?: StageMark) => void,
): Promise<TeardownFlowResult> {
  // ここへ来た時点で計算資源は消し切れている（呼び出し側が res.ok のときだけ呼ぶ）。
  // 以降どう転んでも、**アプリは消えた**という事実は落とさない（検分の指摘4・9・13）。
  // 計算資源に何もしなかった回（保存場所だけが残った記録の押し直し）の message は、teardownFlow の「記録がありません（このプロジェクトでは
  // 何も作られていません）。」。保存場所を削除した事実の隣でそう言わない（結果欄は message が空でなければ枠を出す）。
  const done: TeardownFlowResult = { ...res, appDeleted: true, ...(res.executed.length === 0 ? { message: '' } : {}) }
  // ── env.json が壊れていても、計算資源の削除結果を例外で捨てない（検分の指摘12・14・15）───
  // storagePlacementsOf → loadCloudSpec は、JSON として読めない env.json でも、読めてもスペックの検証に通らない env.json でも throw する
  // （確認画面の storage:placement と同じ読み方・2026-10-08。検証に通らないものを「保存場所を使っていない」と読まない）。
  // IPC ハンドラにも withProjectLock にも catch が無いため、そのまま renderer まで飛び、画面は
  // 「⚠️ 削除できませんでした」＋空の executed に落とす——**全部消せているのに**。
  let placements: ReturnType<typeof storagePlacementsOf>
  try {
    placements = storagePlacementsOf(projectDir)
  } catch (e: any) {
    return {
      ...done, ok: false,
      // 双子の HANAMII（ipc/hanamii.ts）と同じ形にそろえる: 月額が続くことと、どこで確かめて消すか（2026-10-08 検分2巡目）
      message: `保存場所の設定を読めないため、保存場所は削除していません（消すまで月額が続きます）: ${e?.message ?? String(e)}`
        + '\nさくらのクラウドのコントロールパネル（オブジェクトストレージ）で、残っている保存場所を確かめて削除してください。',
    }
  }
  const record = readApprunDedicatedFs(projectDir)
  // 前回の破棄でバケットが残っていた印（1件・全件のどちらか）。立っていれば、片づいたときに下ろす。
  const hadMark = dedicatedStorageLeftoverNames(record).length > 0
  // 保存場所を使っていないプロジェクトでは、何も言わない・何も呼ばない。
  if (placements.length === 0) {
    // 印が立っていれば、もう残っていないので下ろす。下ろせなければ知らせる。
    return hadMark ? { ...done, executed: [...done.executed, ...clearStorageLeftover(projectDir)] } : done
  }
  // 鍵を無効にできなかった行に添える案内の名前は、**何も消す前に**読んでおく。バケットごと消すと forgetDeletedBuckets が
  // env.json を書き換えるので、あとで読み直すと名前を失いうる（HANAMII の hanamiiTeardown.ts と同じ）。読めなければ null（投げない）。
  const keyGuide = keyRevokeGuide(storageProjectNameOf(projectDir), 'apprun-dedicated')
  // 同意済みの保存場所の全件（同じ名前は1つ）。途中で止まったとき、残りを全件名指しするのに使う。
  const allBuckets = Array.from(new Set(placements.map(p => p.bucket)))
  // 記録が無い（2026-09-23 より前に公開した）ときは null＝**鍵の無効化だけ飛ばして片づけは続ける**。
  const permissionId = record.storagePermissionId ?? null
  // 保存場所の段（2026-10-07）: 文はこれまでどおり。段の内部名だけを添えて渡す。
  progress(STORAGE_TEARDOWN_PROGRESS, { stage: STAGE.teardownStorage })
  let st: Awaited<ReturnType<typeof teardownStorageForProject>>
  try {
    // 鍵は記録の1件だけでなく、**この公開先の名前の鍵を全部**無効にする（検分の指摘6）。
    // 手順6の時点でこのプロジェクトの専有型は全部消えている＝現役の鍵は存在しないので、
    // storageKeys.ts の「現役が分からないときは消さない」規則とは矛盾しない。
    st = await teardownStorageForProject({ creds: auth, projectDir, permissionId, sweepKeysFor: 'apprun-dedicated' })
  } catch (e: any) {
    // 片づいたものが分からない（投げたので done を持たない）ので、全件が残っている側に倒す。名前の印も全件で書く
    // （書かないと、行を残しても押し直しの 🗑 が資源の ID も印も無い記録を読んで「記録にありません」で止まる）。
    const markWarning = markStorageLeftover(projectDir, allBuckets)
    return {
      ...done, ok: false, executed: [...done.executed, ...markWarning],
      message: `保存場所を削除できませんでした: ${e?.message ?? String(e)}${leftoverLine(allBuckets)}`,
      remaining: { ...res.remaining, storageBucket: allBuckets[0] },
      remainingBuckets: allBuckets,
    }
  }
  if (st.reason === 'none') return done
  // 鍵の片づけなどで警告が出た（⚠️ の行になる）ときは、ふつうに片づいた回の測定ではない＝時間は結果に載せるが保存しない（2026-10-07 検分）。
  if (st.warnings.length > 0) onStage(STAGE.teardownStorage, UNMEASURED)
  // バケットごとは消さなかった保存場所（残れば月額も続く）。executed の1行だけでは警告にならないので、事実として返す。
  const keptBuckets = st.done.filter(b => !b.deletedBucket).map(b => b.bucket)
  // 残した理由（ほかのプロジェクトも使っている／利用者のファイルがある）も、事実として返す。警告が「後で消す場合は削除して」と言ってよいかを決める（共用型・HANAMII と同じ keptBucketReasonFields）。
  const kept: Pick<TeardownFlowResult, 'keptBucketName' | 'keptBucketNames' | 'keptBucketsUsedByOthers' | 'keptBucketsWithOwnFiles'> =
    keptBuckets.length > 0 ? { keptBucketName: keptBuckets[0], keptBucketNames: keptBuckets, ...keptBucketReasonFields(st.done) } : {}
  const executed = [
    ...res.executed,
    ...st.done.map(b => storageTeardownDoneLine(b.bucket, b.note)),
    // 鍵を無効にできなかった警告には、どこで何を削除すればよいかを添える（共用型・HANAMII と同じ。警告の文そのものは変えない）。
    ...keyWarningLines(st.warnings, keyGuide),
  ]
  // **バケットごと消したものは、env.json の記録からも外す**（検分の指摘3・8）。
  // 残すと画面は「用意済み」のまま、次の手順8の公開が**消えたバケット宛ての鍵**を渡して成功扱いになる。
  const deletedBuckets = st.done.filter(b => b.deletedBucket).map(b => b.bucket)
  if (deletedBuckets.length > 0 && !forgetDeletedBuckets(projectDir, deletedBuckets)) {
    // 外せなかったら**黙らない**。記録が残ったままだと、画面は保存場所を「用意済み」として
    // 出し続け、次の手順8の公開が消えたバケット宛ての鍵を渡して「成功」してしまう。
    executed.push('⚠️ 保存場所の記録（公開の設定）は残しています。次に公開する前に、【公開】の「保存場所を用意する」からやり直してください')
  }
  if (!st.ok) {
    // 計算資源は消えている（＝そのぶんの課金は止まった）が、保存場所は残った。**黙らない。**
    // (1)残っているバケット名を一覧に出す（指摘5） (2)記録に印を残して手順6・📡 の 🗑 を押し直せるようにする（指摘1）。
    // **残りは全件名指しする**（0.6.22 段階3B-2）。止まった1件だけだと、後ろにある保存場所（丸ごと残っている）の月額が黙って続く。
    // 先頭は止まった1件（st.remainingBucket）。接続できなかった回（done が空）も全件になる。
    const remainingBuckets = Array.from(new Set([st.remainingBucket, ...placements.slice(st.done.length).map(p => p.bucket)]))
    executed.push(...markStorageLeftover(projectDir, remainingBuckets))
    return {
      ...done, ok: false, executed, ...kept,
      message: `${st.message}${leftoverLine(remainingBuckets)}`,
      remaining: { ...res.remaining, storageBucket: st.remainingBucket },
      remainingBuckets,
    }
  }
  // 鍵を無効にできたときだけ、記録から外す。消せていないのに記録を消すと、
  // **どこにも辿れない鍵**が保存場所へ届き続ける。
  const cleared = writeApprunDedicatedRecordFs(projectDir, {
    ...(permissionId && st.warnings.length === 0 ? { storagePermissionId: null } : {}),
    storageLeftoverBucket: null,
    storageLeftoverBuckets: null,
  })
  // 下ろせず、印が残ったまま「すべて削除しました」と出ると、プロジェクトの削除が「保存場所だけが残っています」で止まり続ける。
  // 印が元から無い回は、下ろせなくても言わない（残っていない印を言い違えない）。
  if (!cleared && hadMark) executed.push(CLEAR_FAILED_WARNING)
  return { ...done, executed, ...kept }
}


// ── 骨に載せる ──────────────────────────────────────────────────────────────────

/**
 * 専有型の破棄を骨に載せる定義。
 *
 * 公開の記録を消す規則は shouldForgetPublishRecord の1つ（「破棄の前に行があった」かつ「保存場所まで片づいた（ok）」）。
 * 保存場所だけ残った回は行を残す＝📡 の行の「🗑 削除」を押し直せる（D1=1）。
 */
export const DEDICATED_TEARDOWN_SHELL: TeardownShellSpec<CloudCredentials, TeardownFlowResult> = {
  target: 'sakura-apprun-dedicated',
  handler: 'apprunDedicated:teardown',
  parseAuth: a => (isCreds(a) ? a : null),
  authMissingMessage: 'クラウドのAPIキーが未登録です',
  secretsOf: a => [a.token, a.secret],
  // **`zoneOf: recordedZone` と関数を値で渡さない**。main は CommonJS へ変換されるので、循環した require で undefined のまま
  // 受け取ると、ゾーンが黙って記録されなくなる（apprunDedicatedCommon.ts 冒頭。tests/dedicatedTeardownShell.test.ts の C-7 が振る舞いで固定する）。
  zoneOf: dir => recordedZone(dir),
  async run(ctx) {
    const { projectDir, auth, progress, onStage } = ctx
    // 破棄の前の記録を**先に**読む。アプリを消すと記録の applicationID も外れるため、あとからは「何があったか」が分からない。
    // 消すものが記録にあったか（dedicatedTeardownHasWork）が、保存場所に触れてよいかの材料。
    // 公開記録（📡 の行）があったかは骨が先に読む（hadPublishRecord）。
    const before = readApprunDedicatedFs(projectDir)
    // 確認の印は骨が見た（true だけが通る）。teardownFlow の中の印の検査は最後の砦として残してある。
    const res = await teardownFlow(auth, projectDir, { confirmed: true, progress, onStage })
    // 途中で止まったなら保存場所には触らない（アプリがまだ動いている可能性がある）。
    // **消すものが記録に無い（資源の記録が空・前回の保存場所の残りも無い＝幽霊の行）ときも触らない**（2026-10-08 検分）:
    // teardownFlow は「記録がありません」で ok:true を返すので、ここで止めないと、何を消すか名指しできないまま
    // プロジェクトの保存場所のデータ（ほかの公開先が使っているものを含む）が消える。行だけは骨が外す（旧 📡 と同じ救済）。
    return res.ok && dedicatedTeardownHasWork(before) ? await teardownProjectStorage(auth, projectDir, res, progress, onStage) : res
  },
  shouldForgetRecord: s => shouldForgetPublishRecord(s),
  // 消し損ねたら骨が ⚠️ の1行にする（破棄の結果は変えない）。
  forgetRecord: ctx => forgetPublishTargetFs(ctx.projectDir, 'sakura-apprun-dedicated'),
  refused: message => ({ ok: false, executed: [], message, remaining: {} }),
}

/**
 * apprunDedicated:teardown を登録する（registerApprunDedicatedHandlers から呼ぶ）。
 * #39: 各段は一覧から消えるまで待つため、進捗を 'apprunDedicated:teardown-progress' で逐次通知する（cloud:apply-progress と同じ形）。
 * 送り口は骨の progressReporter の1つ（処理の記録も更新するので、手順6のダイアログを閉じて開き直した画面も、いまの進み具合を続きから読める）。
 */
export function registerApprunDedicatedTeardownHandler(): void {
  ipcMain.handle('apprunDedicated:teardown', (event, projectDir: unknown, auth: unknown, opts: unknown) =>
    runTeardownShell(DEDICATED_TEARDOWN_SHELL, {
      projectDir, auth, opts,
      sendProgress: msg => event.sender.send('apprunDedicated:teardown-progress', msg),
    }))
}
