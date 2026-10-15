// publishRecord.ts — 公開記録（.sakuraide.json の publish.targets）の読み書き。
//
// ── なぜ1箇所に集めるのか（2026-08-09）────────────────────────────────
// 「破棄したら公開記録も消す」処理が AppRunPanel と HanamiiPanel に別々に書かれていた。
// 破棄の導線を増やす（📡 公開したもの一覧・プロジェクト削除時）にあたって、
// 同じ処理が4箇所に増えるところだった。片方だけ直されて記録が残れば、
// **存在しない公開が一覧に出続ける**（v0.2.97 で直したのと同じ症状）。
//
// 判定そのもの（どの行を消すか）は shared/publishMeta.ts の純関数 withoutPublishTarget にある。
// **書き込みは main の1か所**（projectMeta.ts 経由。書く直前にディスクから読み直す）。
// ここは、消す依頼と、記録を読む側だけを受け持つ。

import type { PublishTargetKind } from './publishStatus'
import { forgetPublishTargetRecord } from './projectMeta'

/** プロジェクトの公開記録の置き場。 */
function metaPath(projectDir: string): string {
  return `${projectDir}/.sakuraide.json`
}

/**
 * 公開記録から、その公開先の行を消す（main が書く直前にディスクから読み直して消す・
 * src/renderer/projectMeta.ts。画面の古い写しで全体を書き戻さない）。
 *
 * 消すのは**その公開先の記録だけ**（判定は shared/publishMeta.ts の withoutPublishTarget）。
 * 専有型の資源ID（publish.apprunDedicated）・ほかの公開先・pending は残る。
 * ファイルが無い・壊れている場合は**何もしない**（消す記録が無いのと同じ・main 側で守る）。
 * 呼び出し側は破棄の成功後に呼ぶが、ここが失敗しても破棄自体は成功しているので、
 * 例外は投げずに握りつぶさない――呼び出し側で握ってもらう。
 */
export async function clearPublishRecord(projectDir: string, target: PublishTargetKind): Promise<void> {
  await forgetPublishTargetRecord(projectDir, target)
  // 開いている画面（③公開の一覧・ステータスバー）に反映させる
  window.dispatchEvent(new Event('sakura-meta-changed'))
}

/** 公開先の並び（定義順）。 */
const TARGET_ORDER: PublishTargetKind[] = ['hanamii', 'vercel', 'sakura-apprun', 'sakura-apprun-dedicated', 'sakura-rental']

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * 公開記録の中身（JSON.parse 済み）から、記録のある公開先を定義順で返す。**形が読めなければ `null`**（空配列とは別の意味）。
 *
 *   ・`[]`   … 読めた結果、公開先の記録が1つも無かった（`publish` や `publish.targets` が無い場合を含む）
 *   ・`null` … 読めなかった（ファイルの中身がオブジェクトでない・`publish`／`targets` が別の型だった）
 *
 * 2つの読み口（readPublishTargets＝読めなければ空・readPublishTargetsOrThrow＝読めなければ投げる）が、同じこの判断を使う（掟10）。
 */
function parsePublishTargets(meta: unknown): PublishTargetKind[] | null {
  if (!isPlainObject(meta)) return null
  const publish = meta.publish
  if (publish === undefined || publish === null) return []
  if (!isPlainObject(publish)) return null
  const targets = publish.targets
  if (targets === undefined || targets === null) return []
  if (!isPlainObject(targets)) return null
  return TARGET_ORDER.filter(t => !!targets[t])
}

/**
 * そのプロジェクトに残っている公開記録の公開先を返す（新しい順ではなく定義順）。
 * プロジェクトを削除する前に「何が公開されたままか」を見せるために使う。
 *
 * **読めなかったとき（ファイルが読めない・壊れた JSON・形が違う）は空配列に倒す**——表示の補助として使う呼び出し元
 * （プロジェクトの削除前の注意・Vercel パネルの「公開済み」）のため。**「読めなかった」と「記録が無い」を言い分けたいとき
 * （破壊の確認の材料）は `readPublishTargetsOrThrow`**。
 */
export async function readPublishTargets(projectDir: string): Promise<PublishTargetKind[]> {
  try {
    return await readPublishTargetsOrThrow(projectDir)
  } catch {
    return []
  }
}

/**
 * `readPublishTargets` の「読めなかったら投げる」版。**空配列に倒さない**（2026-10-08 検分）。
 *
 * 専有型の「すべて削除」の確認は、保存場所を巻き添えにされる**ほかの公開先**（HANAMII・共用型など）の名前を、この記録から読んで言う。
 * 読めなかったのを空配列に倒すと、確認の文は「ほかに公開先は無い」ように見えたまま、ほかの公開先が使う保存場所を消してしまう。
 * 投げれば、呼び出し側（dedicatedTeardownFlow の loadDedicatedTeardownFacts）が「読めなかった」事実を残し、確認の文が言える。
 *
 * 投げるのは次のとき: ファイルを読めない（無い・権限・IPC の失敗）／JSON として読めない／中身の形が違う（`parsePublishTargets` が null）。
 * 読めて、記録の公開先が無いだけなら空配列を返す（投げない）。
 */
export async function readPublishTargetsOrThrow(projectDir: string): Promise<PublishTargetKind[]> {
  const meta = JSON.parse(await window.electronAPI.fs.readFile(metaPath(projectDir)))
  const targets = parsePublishTargets(meta)
  if (targets === null) throw new Error('公開の記録の形を読めませんでした')
  return targets
}

/**
 * プロジェクトの削除の確認用に、公開記録の公開先を読む。**「読めなかった」と「記録が無い」を言い分ける**（2026-10-08 検分 A の双子）。
 *
 * プロジェクトの削除は、フォルダごとゴミ箱へ移す。公開記録（.sakuraide.json）が読めないまま「公開は残っていない」と見せると、
 * 公開が残っていてもそれを警告できず、記録ごとフォルダが移ってしまい、Koto から破棄できなくなる。だから読めなかったことを `unreadable` で返し、
 * 確認の画面が注意を出せるようにする。
 *
 * ・`.sakuraide.json` が**無い**（まだ何も公開していないプロジェクト・既存のフォルダを開いただけのもの）は、読めなかったのではなく
 *   「記録が無い」＝`{ targets: [], unreadable: false }`。無いたびに注意を出すと、公開していないプロジェクトの削除すべてに偽の警告が出る。
 * ・ファイルがあるのに読めない（権限・IPC の失敗）／JSON として読めない／中身の形が違う（`readPublishTargetsOrThrow` が投げる）は
 *   `{ targets: [], unreadable: true }`。
 * 存在確認そのものが失敗したときは、ファイルがあるとみなして読みにいく（読めなければ unreadable になる＝黙って「無い」にしない）。
 */
export async function readPublishTargetsChecked(projectDir: string): Promise<{ targets: PublishTargetKind[]; unreadable: boolean }> {
  try {
    if (!(await window.electronAPI.fs.exists(metaPath(projectDir)))) return { targets: [], unreadable: false }
  } catch { /* 存在を確かめられなかった。読みにいく（読めなければ unreadable） */ }
  try {
    return { targets: await readPublishTargetsOrThrow(projectDir), unreadable: false }
  } catch {
    return { targets: [], unreadable: true }
  }
}

/** HANAMII のプロジェクトID（破棄に必要）。無ければ null。 */
export async function readHanamiiProjectId(projectDir: string): Promise<string | null> {
  try {
    const meta = JSON.parse(await window.electronAPI.fs.readFile(metaPath(projectDir)))
    const id = meta?.publish?.hanamii?.projectId
    return typeof id === 'string' && id ? id : null
  } catch {
    return null
  }
}
