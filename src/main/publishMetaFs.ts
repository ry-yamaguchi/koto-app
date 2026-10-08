// publishMetaFs.ts — src/shared/publishMeta.ts の純関数を使って `<projectDir>/.sakuraide.json` を
// 読み書きする（fs アクセスは main 側だけ。掟10: 一元定義を main から使う側）。
//
// ── なぜ main に置くか（roadmap #20）─────────────────────────────────────
// 公開そのもの（hanamii:publish / cloud:apply / vercel:publish）は main の1 invoke で完走するので
// 窓を閉じても中断されないが、**公開の記録**（publish.targets への書き込み）と
// **開始マーカーの後片づけ**（publish.pending の削除）は従来 renderer 側にあったため、
// 公開中に閉じると「公開は完了しているのに記録が残らない」状態になっていた（特に HANAMII は
// projectId が保存されないと次回の公開が二重作成になりうる）。ここへ main 化する。
//
// **記録の失敗で公開そのものを落とさない。** 読めない/壊れている `.sakuraide.json` でも
// 例外を投げない（空メタ扱い）。書き込みに失敗しても投げない（利用者には出さず、
// console.warn で main のログにだけ残す）。
import * as fs from 'fs'
import * as path from 'path'
import {
  withPendingPublish, withoutPendingPublish, withPublishRecord, withHanamiiProjectId,
  withApprunDedicatedRecord, withMetaPatch, withoutPublishTargetInMeta,
  type PublishTargetKind, type ApprunDedicatedRecord,
} from '../shared/publishMeta'
import { runningOp } from './projectLock'

function metaFilePath(projectDir: string): string {
  return path.join(projectDir, '.sakuraide.json')
}

/** `.sakuraide.json` を読む。無い/壊れている（既存フォルダ等）場合は空メタ扱い。 */
function readMetaRaw(projectDir: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(metaFilePath(projectDir), 'utf-8'))
  } catch {
    return {}
  }
}

/**
 * マージ済みの次の状態を書き込む。失敗しても投げず、console.warn にだけ残す（利用者には出さない）。
 * **成功したら true・例外は false を返す**（2026-09-10 レビューの修理・C: 呼び出し元のうち
 * `writeApprunDedicatedRecordFs` だけが戻り値を見て「記録できなければ止まる」判断に使う。
 * 他の呼び出し元は従来どおり戻り値を無視してよい＝振る舞い不変）。
 */
function writeMetaRaw(projectDir: string, next: Record<string, unknown>, what: string): boolean {
  try {
    fs.writeFileSync(metaFilePath(projectDir), JSON.stringify(next, null, 2))
    return true
  } catch (e) {
    console.warn(`[publishMetaFs] ${what}の書き込みに失敗しました（公開処理そのものは続行）:`, e)
    return false
  }
}

/**
 * 公開開始マーカーを書く。公開処理の最初、実際の公開API呼び出しの直前に main 側から呼ぶこと。
 * 既存の `publish.*` の他のキー（targets 等）は消さない。
 */
export function markPendingFs(projectDir: string, target: PublishTargetKind): void {
  try {
    const next = withPendingPublish(readMetaRaw(projectDir), target, new Date().toISOString())
    writeMetaRaw(projectDir, next, '公開開始マーカー')
  } catch (e) {
    console.warn('[publishMetaFs] 公開開始マーカーの記録に失敗しました（公開処理そのものは続行）:', e)
  }
}

/**
 * 公開開始マーカーを消す。公開処理の終了時（成功/失敗どちらでも）、必ず finally で main 側から呼ぶこと。
 * 既存の `publish.*` の他のキーは消さない。
 */
export function clearPendingFs(projectDir: string): void {
  try {
    const next = withoutPendingPublish(readMetaRaw(projectDir))
    writeMetaRaw(projectDir, next, '公開開始マーカーの後片づけ')
  } catch (e) {
    console.warn('[publishMetaFs] 公開開始マーカーの後片づけに失敗しました（公開処理そのものは続行）:', e)
  }
}

/** `publish.targets[target]` に公開記録を書く（公開成功時に main 側から呼ぶ）。 */
export function writePublishRecordFs(
  projectDir: string,
  target: PublishTargetKind,
  rec: { publishedAt: string | null; url: string | null },
): void {
  try {
    const next = withPublishRecord(readMetaRaw(projectDir), target, rec)
    writeMetaRaw(projectDir, next, '公開記録')
  } catch (e) {
    console.warn('[publishMetaFs] 公開記録の書き込みに失敗しました（公開処理そのものは続行）:', e)
  }
}

/** HANAMII 固有: `publish.hanamii.projectId` を保つ/更新する（二重作成の防止に効く）。 */
export function writeHanamiiProjectIdFs(projectDir: string, projectId: string | null): void {
  try {
    const next = withHanamiiProjectId(readMetaRaw(projectDir), projectId)
    writeMetaRaw(projectDir, next, 'HANAMII の projectId')
  } catch (e) {
    console.warn('[publishMetaFs] HANAMII の projectId の記録に失敗しました（公開処理そのものは続行）:', e)
  }
}

/**
 * HANAMII 固有: ディスクの `publish.hanamii.projectId` を**この場で**読む（無い・壊れている・空なら null）。
 *
 * ここが「この公開先のプロジェクトを Koto が作ったか」の正。`hanamii:publish` は、画面（renderer）が
 * 渡した projectId が無いとき（公開ダイアログを開き直した直後は、画面はまだ読んでいない）にこれで補う。
 * 補わないと、初回の公開が終わったあとに古い画面から押した「公開」が**もう一度プロジェクトを作る**
 * （2026-09-29 検分。掟10「画面が持っている写しは、いつでも古い」）。
 */
export function readHanamiiProjectIdFs(projectDir: string): string | null {
  const m = readMetaRaw(projectDir) as any
  const id = m?.publish?.hanamii?.projectId
  return typeof id === 'string' && id ? id : null
}

/**
 * `publish.targets[target].publishedAt` を**この場で**読む（無い・壊れている・文字列でないなら null）。
 * HANAMII の公開の後段（動いたと確かめて url を書き足すとき）が、依頼を受け付けたときに書いた時刻を
 * 保つのに使う（書き足しで公開日時を「動いた時刻」へずらさない）。
 */
export function readPublishedAtFs(projectDir: string, target: PublishTargetKind): string | null {
  const m = readMetaRaw(projectDir) as any
  const at = m?.publish?.targets?.[target]?.publishedAt
  return typeof at === 'string' && at ? at : null
}

/**
 * さくらのAppRun 専有型（roadmap #23）: `publish.apprunDedicated` を読む。
 * 無い/壊れている場合は空オブジェクト（＝何も作られていない・同意していない扱い）。
 */
export function readApprunDedicatedFs(projectDir: string): ApprunDedicatedRecord {
  const m = readMetaRaw(projectDir) as any
  const rec = m?.publish?.apprunDedicated
  return rec && typeof rec === 'object' && !Array.isArray(rec) ? rec : {}
}

/**
 * さくらのAppRun 専有型（roadmap #23・段階②）: `publish.apprunDedicated` へパッチを書く。
 *
 * **ここが「実際に何が作られたか」の唯一の記録先。** apprunDedicatedApply.ts の
 * createClusterFlow/teardownFlow は、各段が成功した直後（＝クラウド側に資源ができた/消えた
 * 直後）に必ずここを呼ぶ。呼ばないと、途中で落ちたときに「作れたのに記録が無い」状態になり、
 * Koto から二度と消せないまま課金だけが残る（2026-08-14 の教訓と同じ形）。
 *
 * **成功したら true・書き込めなければ false を返す**（2026-09-10 レビューの修理・C）。
 * `createClusterFlow` は戻り値が false のとき、その場で処理を止める（記録なしで課金資源を
 * 増やさない）。他の呼び出し元（renderer の saveMeta 等はこの関数を直接は呼ばない）は
 * 戻り値を無視してもよい。
 */
export function writeApprunDedicatedRecordFs(projectDir: string, patch: Partial<ApprunDedicatedRecord>): boolean {
  try {
    const next = withApprunDedicatedRecord(readMetaRaw(projectDir), patch)
    return writeMetaRaw(projectDir, next, 'AppRun専有型の記録')
  } catch (e) {
    console.warn('[publishMetaFs] AppRun専有型の記録の書き込みに失敗しました（処理そのものは続行）:', e)
    return false
  }
}

// ── renderer からの書き込みの唯一の入口（2026-09-29・掟10の一元化）──────────────────────
//
// 以前は renderer の各画面が .sakuraide.json を**自分で読んで・マージして・全体を書き戻して**いた
// （PublishModal・HANAMII・Vercel・VPS・専有型・GitHub保存・資料設定・公開先の変更・記録の片づけ）。
// とくに PublishModal.saveMeta は、**画面を開いたときに一度だけ読んだ写し**を材料に全体を書き戻すので、
// ダイアログを開いている間に main が書いた記録（専有型の資源ID publish.apprunDedicated・
// publish.targets・HANAMII の projectId）を**消した**。専有型のクラスタの記録が消えると⑥で
// 破棄できず、月額22,000円が止められなくなる（掟10「画面が持っている写しは、いつでも古い」）。
//
// 読み直して当てて書く処理を**ここ1か所**に置き、renderer は差分（patch）だけを渡す
// （全体を渡す口が無いので、古い写しで書き戻すことがそもそもできない）。
// 読む→当てる→書くを**1回の同期処理**で行うので、ほかの main の書き込み
// （markPendingFs・writePublishRecordFs など＝どれも同期）とも交錯しない。

export type MetaUpdateResult =
  | { ok: true; meta: Record<string, unknown> }
  | { ok: false; message: string }

const WRITE_FAILED = '公開の記録を書き込めませんでした。フォルダの権限を確認してください。'

/**
 * ディスクの .sakuraide.json を**この場で読み直し**、`update` を当てて書き戻す。
 * 変わらなかったときは書かない（ファイルを作り直さない）。書けなければ `ok:false`
 * （renderer は例外として扱う。ほかの公開の記録の書き込みと違い、ここは利用者の操作の結果なので黙らない）。
 */
function updateMetaFs(
  projectDir: string,
  update: (disk: unknown) => Record<string, unknown>,
  what: string,
): MetaUpdateResult {
  try {
    const before = readMetaRaw(projectDir)
    const next = update(before)
    if (JSON.stringify(next) === JSON.stringify(before)) return { ok: true, meta: next }
    if (!writeMetaRaw(projectDir, next, what)) return { ok: false, message: WRITE_FAILED }
    return { ok: true, meta: next }
  } catch (e) {
    console.warn(`[publishMetaFs] ${what}に失敗しました:`, e)
    return { ok: false, message: WRITE_FAILED }
  }
}

/**
 * 差分（patch）を**書く直前にディスクから読み直した .sakuraide.json** へ当てて書く。
 * 当て方は `withMetaPatch`（shared/publishMeta.ts）。patch に無いキーはディスクのまま残る。
 */
export function mergeMetaPatchFs(projectDir: string, patch: unknown): MetaUpdateResult {
  return updateMetaFs(projectDir, disk => withMetaPatch(disk, patch), '公開の記録の更新')
}

/**
 * 「記録を片づける」: 1つの公開先の記録**だけ**を、書く直前にディスクから読み直したものから取り除く。
 * publish.apprunDedicated（専有型の資源ID）・publish.pending・ほかの公開先の記録は残る。
 */
export function forgetPublishTargetFs(projectDir: string, target: PublishTargetKind): MetaUpdateResult {
  // 記録が無い・読めない・壊れている＝消すものが無い。**ファイルを作らず、壊れたものを上書きもしない**
  // （renderer の clearPublishRecord が「ファイルが無い・壊れている場合は何もしない」としていた約束）。
  let existing: unknown
  try { existing = JSON.parse(fs.readFileSync(metaFilePath(projectDir), 'utf-8')) } catch { return { ok: true, meta: {} } }
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return { ok: true, meta: {} }
  return updateMetaFs(projectDir, disk => withoutPublishTargetInMeta(disk, target), '公開記録の片づけ')
}

/**
 * HANAMII の破棄が**成功したあと**の記録の片づけ（2026-09-30。破棄の後始末を main の1か所へ移した）。
 *
 * ── なぜ main か ────────────────────────────────────────────────────────
 * 以前は、この片づけ（設定の projectId を空に・公開記録を消す）を画面（HanamiiPanel）が
 * 「破棄の結果を初めて見たとき」に行っていた。画面は**記録を再生する**（閉じて開き直すと、
 * まだ見られていない古い結果をもう一度「初めて見た」として扱う）ので、次の流れで**新しい公開の記録を消した**:
 *   ①別の公開先の結果が、まだ見られていない → ②HANAMII の破棄 R1 が終わる（①より新しいので見たことにされない）
 *   → ③同じ画面で HANAMII にもう一度公開する（R2・新しい projectId）→ ④閉じて開き直す
 *   → R1 がもう一度「初めて見た」扱いになり、片づけが再び走って R2 の projectId と公開記録を消す
 *   → 次の公開で HANAMII のプロジェクトが二重に作られ、動いているほうは Koto から辿れなくなる。
 * 専有型の⑥は最初から main が記録を片づけており、この問題が起きない。HANAMII も同じ形にする。
 * main はロックの中で、**消したそのとき**に1回だけ行う（再生されない）。
 *
 * ── 何を消すか ─────────────────────────────────────────────────────────
 * 消してよいのは、**いま記録が指しているプロジェクトを消したとき**だけ。記録の projectId が
 * 消したものと違う（別のプロジェクトを指している）ときは何もしない——それは別の公開の記録である。
 * 記録に projectId が無い（空・未設定）ときは、片づけ残りの公開記録だけを消す
 * （`withoutPublishTarget` が projectId の空化と公開記録の削除を一緒に行う）。
 * 記録ファイルが無い・壊れているときは、**ファイルを作らず、壊れたものを上書きもしない**（何もしない）。
 *
 * 呼ぶのは**破棄が成功したとき**（保存場所まで片づいたとき）だけ。保存場所だけ残った回は、
 * 押し直せる入口（🗑）と記録を残す。
 */
export function settleHanamiiTeardownFs(
  projectDir: string, deletedProjectId: string,
): { ok: true; cleared: boolean } | { ok: false; message: string } {
  let existing: unknown
  try { existing = JSON.parse(fs.readFileSync(metaFilePath(projectDir), 'utf-8')) } catch { return { ok: true, cleared: false } }
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return { ok: true, cleared: false }
  const onDisk = (existing as any)?.publish?.hanamii?.projectId
  if (typeof onDisk === 'string' && onDisk !== '' && onDisk !== deletedProjectId) return { ok: true, cleared: false }
  const r = updateMetaFs(projectDir, disk => withoutPublishTargetInMeta(disk, 'hanamii'), 'HANAMII の破棄後の記録の片づけ')
  return r.ok ? { ok: true, cleared: true } : { ok: false, message: r.message }
}

/**
 * 「確認しました（この通知を消す）」: 中断の可能性の印（publish.pending）を消す。
 *
 * **いま公開が走っているプロジェクトでは消さない**（走っている公開自身が書いた印を消すと、
 * そのあと落ちたときに「中断された可能性」が出なくなる）。走っているかは main の鍵
 * （projectLock.ts）が知っている。
 */
export function dismissInterruptedPublishFs(
  projectDir: string,
): MetaUpdateResult | { ok: false; running: true; message: string } {
  if (runningOp(projectDir) === '公開') {
    return { ok: false, running: true, message: '公開が進んでいます。終わってからもう一度お試しください。' }
  }
  return updateMetaFs(projectDir, withoutPendingPublish, '公開開始マーカーの後片づけ')
}
