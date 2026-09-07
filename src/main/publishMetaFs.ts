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
  withApprunDedicatedRecord, type PublishTargetKind, type ApprunDedicatedRecord,
} from '../shared/publishMeta'

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

/** マージ済みの次の状態を書き込む。失敗しても投げず、console.warn にだけ残す（利用者には出さない）。 */
function writeMetaRaw(projectDir: string, next: Record<string, unknown>, what: string): void {
  try {
    fs.writeFileSync(metaFilePath(projectDir), JSON.stringify(next, null, 2))
  } catch (e) {
    console.warn(`[publishMetaFs] ${what}の書き込みに失敗しました（公開処理そのものは続行）:`, e)
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
 */
export function writeApprunDedicatedRecordFs(projectDir: string, patch: Partial<ApprunDedicatedRecord>): void {
  try {
    const next = withApprunDedicatedRecord(readMetaRaw(projectDir), patch)
    writeMetaRaw(projectDir, next, 'AppRun専有型の記録')
  } catch (e) {
    console.warn('[publishMetaFs] AppRun専有型の記録の書き込みに失敗しました（処理そのものは続行）:', e)
  }
}
