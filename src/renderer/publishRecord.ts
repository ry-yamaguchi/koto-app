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

import { parseApprunLegacy, type PublishTargetKind } from './publishStatus'
import { forgetPublishTargetRecord } from './projectMeta'

/** プロジェクトの公開記録の置き場。 */
export function metaPath(projectDir: string): string {
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
 * 投げれば、呼び出し側（teardown/facts.ts の loadTeardownFacts）が「読めなかった」事実を残し、確認の文が言える。
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

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v !== ''

/**
 * 保存場所を使いうる公開先（HANAMII・共用型・専有型・Vercel）。レンタルサーバは保存場所を使わない
 * （`shared/storageKeys.ts` の `StorageTarget` に無い）。破棄の確認が「ほかの公開先」を挙げるときは、この表で絞る
 * （保存場所を使わない公開先を挙げると、「この保存場所は〜でも使っているため」が事実と違う文になる。親の判断・2026-10-10）。
 */
export const PUBLISH_TARGETS_USING_STORAGE: readonly PublishTargetKind[] = ['hanamii', 'vercel', 'sakura-apprun', 'sakura-apprun-dedicated']

/**
 * `publishTargetsWithLegacy`（D9=2）。公開記録（JSON.parse 済み）と、旧い共用型の記録（`.sakura-cloud/state.json`、無ければ null）から、
 * **いま生きている公開先**を定義順で返す。形が読めなければ `null`（`parsePublishTargets` と同じ意味）。
 *
 * 公開先 = `publish.targets`（`parsePublishTargets`）∪ HANAMII（`publish.hanamii.projectId` が空でない文字列。一覧の旧い行と同じ
 * `publishStatus.ts` のレガシー救済）∪ 共用型（state.json に apprun-app がある。`parseApprunLegacy`）∪ 専有型（`publish.apprunDedicated` の
 * `applicationID`・`clusterID`・`asgID`・`loadBalancerID` のどれかが空でない文字列）。重なりは1つ。
 *
 * なぜ要るか: `publish.targets` だけを読むと、targets に行が無い旧い記録の公開先（HANAMII・共用型・専有型）を「ほかの公開先」に数えず、
 * その公開先のアプリが使う保存場所のデータが消えることを確認が言わない。
 */
export function publishTargetsWithLegacy(meta: unknown, apprunState: unknown | null): PublishTargetKind[] | null {
  const recorded = parsePublishTargets(meta)
  if (recorded === null) return null
  const found = new Set<PublishTargetKind>(recorded)
  const publish = isPlainObject(meta) && isPlainObject(meta.publish) ? meta.publish : null
  if (publish) {
    const hanamii = publish.hanamii
    if (isPlainObject(hanamii) && isNonEmptyString(hanamii.projectId)) found.add('hanamii')
    const dedicated = publish.apprunDedicated
    if (isPlainObject(dedicated) && [dedicated.applicationID, dedicated.clusterID, dedicated.asgID, dedicated.loadBalancerID].some(isNonEmptyString)) {
      found.add('sakura-apprun-dedicated')
    }
  }
  if (apprunState !== null && parseApprunLegacy(apprunState) !== null) found.add('sakura-apprun')
  return TARGET_ORDER.filter(t => found.has(t))
}

/**
 * 公開の記録の2つのファイル（`.sakuraide.json`・`.sakura-cloud/state.json`）を読む。**旧い記録を足す読み口（下の2つ）が、どちらもこれを通る**
 * （同じ判断を2つ書かない）。投げない。
 *
 * ・`.sakuraide.json`: `fs.exists` が **false を返した**ときだけ「記録が無い」＝`meta = {}`（readFile は呼ばない。まだ何も公開していない
 *   プロジェクト・既存のフォルダを開いただけのもの。段階3A の G=1）。`exists` が投げた・true 以外を返したときは、あるとみなして読みにいく。
 *   あるのに読めない・JSON でない・中身の形が違う（`parsePublishTargets` が null）→ `ok: false`（state.json へは進まない）。
 * ・`state.json`: `fs.exists` が true でなければ「旧い共用型なし」（読めなかった印は立たない）。`exists` が投げたら、あるとみなして読みにいく。
 *   あるのに読めない・JSON でない → `state = null`・`stateUnreadable = true`（`.sakuraide.json` の分は残す）。
 */
type PublishRecordParts =
  | { ok: true; meta: unknown; state: unknown | null; stateUnreadable: boolean; stateError: unknown }
  | { ok: false; error: unknown }

async function readPublishRecordParts(projectDir: string): Promise<PublishRecordParts> {
  let meta: unknown
  try {
    let metaExists: unknown = true
    try { metaExists = await window.electronAPI.fs.exists(metaPath(projectDir)) } catch { /* 存在を確かめられなかった。あるとみなして読みにいく */ }
    meta = metaExists === false ? {} : JSON.parse(await window.electronAPI.fs.readFile(metaPath(projectDir)))
    // 形が違えば、旧い共用型の記録（state.json）へ進まない（`readPublishTargetsOrThrow` と同じ判断）。
    if (parsePublishTargets(meta) === null) return { ok: false, error: new Error('公開の記録の形を読めませんでした') }
  } catch (error) {
    return { ok: false, error }
  }
  const statePath = `${projectDir}/.sakura-cloud/state.json`
  let stateExists = true
  try { stateExists = (await window.electronAPI.fs.exists(statePath)) === true } catch { /* 存在を確かめられなかった。あるとみなして読みにいく */ }
  if (!stateExists) return { ok: true, meta, state: null, stateUnreadable: false, stateError: null }
  try {
    return { ok: true, meta, state: JSON.parse(await window.electronAPI.fs.readFile(statePath)), stateUnreadable: false, stateError: null }
  } catch (stateError) {
    return { ok: true, meta, state: null, stateUnreadable: true, stateError }
  }
}

const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)))

/**
 * `readPublishTargetsOrThrow` に旧い記録の分（D9=2）を足した読み口。**読めなかったら投げる**（空に倒さない）。
 *
 * ・`.sakuraide.json` が無い → 記録が無いだけ（投げない。state.json があれば旧い共用型だけが数えられる）。
 * ・`.sakuraide.json` が読めない・JSON でない・形が違う → 投げる（`readPublishTargetsOrThrow` と同じ）。
 * ・state.json は `fs.exists` が true でなければ「旧い共用型なし」。あるのに読めない・JSON でない → 投げる（読めなかった事実を確認が言う）。
 */
export async function readPublishTargetsWithLegacyOrThrow(projectDir: string): Promise<PublishTargetKind[]> {
  const parts = await readPublishRecordParts(projectDir)
  if (!parts.ok) throw asError(parts.error)
  if (parts.stateUnreadable) throw asError(parts.stateError)
  const targets = publishTargetsWithLegacy(parts.meta, parts.state)
  if (targets === null) throw new Error('公開の記録の形を読めませんでした')
  return targets
}

/**
 * プロジェクトの削除の確認用に、旧い記録の分も含めた公開先を読む。**投げない。「読めなかった」と「記録が無い」を言い分ける**
 * （段階3A の 3A-5b で、`publish.targets` だけを読んでいた旧い読み口の後継になった）。
 *
 * ・どちらのファイルも無い → `{ targets: [], unreadable: false }`（偽の警告を出さない）。
 * ・`.sakuraide.json` が読めない・JSON でない・形が違う → `{ targets: [], unreadable: true }`（state.json は読まない）。
 * ・state.json だけが読めない → **読めた分は数える**（`publish.targets`・HANAMII の projectId・専有型の ID）。落ちるのは旧い共用型だけで、
 *   `unreadable: true`。読めた分は破棄する、という約束を守る。
 */
export async function readPublishTargetsWithLegacyChecked(projectDir: string): Promise<{ targets: PublishTargetKind[]; unreadable: boolean }> {
  // 投げない: readPublishRecordParts は読みの失敗を全部 ok:false か stateUnreadable で返し、publishTargetsWithLegacy は形が違う値にも投げない。
  const parts = await readPublishRecordParts(projectDir)
  if (!parts.ok) return { targets: [], unreadable: true }
  return { targets: publishTargetsWithLegacy(parts.meta, parts.state) ?? [], unreadable: parts.stateUnreadable }
}
