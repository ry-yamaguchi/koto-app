// teardown/targets/hanamii.ts — HANAMII の破棄の仕様書（TargetSpec）。公開先ごとの違いは、全部ここに置く。
//
// 段階1（1b）。設計書: docs/teardown-unify-plan.md の 10.4.3。流れ（確認 → 実行）・確認の文・結果の読み方は共通の部品
// （teardown/flow.ts・confirm.ts・shared/teardownResult.ts）が持つ。ここが持つのは HANAMII だけの事実:
//   ・記録（.sakuraide.json の publish.hanamii）から何を読むか
//   ・消すものの名前・消すものが無い（幽霊の行）かどうか
//   ・保存場所だけが残った回の言い分け（leftoverNote）
//   ・どのトークンで呼ぶか（D8）
//   ・main の hanamii:teardown を呼ぶ1行（invoke）。**src 全体で、この IPC を呼ぶのはこのファイルの invoke だけ**にする（入口は流れ〔flow.ts〕を通す）
//
// 作者の決定（2026-10-09）: D8=1。記録の tokenId のトークンだけで呼び、見つからなければ使用中・先頭の登録へ倒さずに止める
// （HANAMII の 404 は「存在しない」だけでなく「参照できない」も含む。別のアカウントのトークンで呼ぶと、実体があるのに
//  「もう無い」と読んで保存場所と記録を消しうる）。tokenId が記録に無い旧い記録だけ、使用中のトークン（無ければ先頭）を使う。
//
// 掟4（方式B）: トークンは使う瞬間に中央ストアから読み、引数で main へ渡す。ここでは保存しない。

import type { TargetSpec, TeardownWords } from '../types'
import { toTeardownView } from '../../../shared/teardownResult'
import { bucketNamesText } from '../../../shared/teardownSupport'
import { metaPath } from '../../publishRecord'
import { getHanamiiToken, getHanamiiTokenById } from '../../components/CredentialsModal'

/** `.sakuraide.json` の `publish.hanamii` から読む、破棄に要る項目。 */
export type HanamiiTeardownRecord = {
  projectId: string | null
  name: string | null
  /** 公開したときのトークンの id（中央ストアの登録）。旧い記録には無い。 */
  tokenId: string | null
  /**
   * 前回の破棄で保存場所だけが残った印（main が書く。1a-1）。
   * null＝印なし、[]＝プロジェクトは消えたが残りの名前は不明、1件以上＝その保存場所が残っている。
   */
  storageLeftoverBuckets: string[] | null
}

export type HanamiiTeardownReply = Awaited<ReturnType<Window['electronAPI']['hanamii']['teardown']>>

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
const nonEmptyString = (x: unknown): string | null => (typeof x === 'string' && x !== '' ? x : null)

/** 文字列の配列のときだけ読む（空の名前は数えない）。形が違えば null（確認の言い方だけに効く項目なので、投げない）。 */
function bucketList(x: unknown): string[] | null {
  if (!Array.isArray(x) || !x.every(v => typeof v === 'string')) return null
  return x.filter((v: string) => v !== '')
}

/**
 * 記録を読む。**読めない・壊れているときは投げる**（null に倒さない）。倒すと「消すものが無い」と「読めない」が区別できず、
 * 読めなかった回に「記録に無いので削除できません」と言ってしまう。投げれば、流れが確認も実行も出さずに「記録を読めませんでした」と言う。
 * 記録が読めて、HANAMII の項目が無いだけなら、全部 null（消すものが無い）。
 */
export async function readHanamiiTeardownRecord(projectDir: string): Promise<HanamiiTeardownRecord> {
  const meta: unknown = JSON.parse(await window.electronAPI.fs.readFile(metaPath(projectDir)))
  if (!isObj(meta)) throw new Error('公開の記録の形を読めませんでした')
  const publish = meta.publish
  if (publish !== undefined && publish !== null && !isObj(publish)) throw new Error('公開の記録の形を読めませんでした')
  const h = isObj(publish) ? publish.hanamii : undefined
  if (h !== undefined && h !== null && !isObj(h)) throw new Error('公開の記録の形を読めませんでした')
  const rec = isObj(h) ? h : {}
  return {
    projectId: nonEmptyString(rec.projectId),
    name: nonEmptyString(rec.name),
    tokenId: nonEmptyString(rec.tokenId),
    storageLeftoverBuckets: bucketList(rec.storageLeftoverBuckets),
  }
}

/**
 * トークンが見つからないとき（流れの keyMissingMessage）。入口は 📡 一覧・【公開】の節・プロジェクト削除の3つで、案内は同じ。
 * 公開に使ったトークンだけで呼ぶので（D8）、「別のトークンを登録し直す」案内はしない。記録の tokenId は登録の id との完全一致でしか引かれず、
 * 登録を消して足し直すと id が変わって二度と一致しない（CredentialsModal の addEntry は新しい id を振る）。
 * 通る道は2つだけ: (1) 同じ登録にトークンを入れ直す（登録は残っているが鍵が空のとき）、(2) 登録を消したなら HANAMII の管理画面で削除する。
 * 旧い記録（tokenId が無く、使用中のトークンも無いとき）は、同じ文で足りる（「公開に使った登録」を確かめ、無ければ登録する）。
 */
export const HANAMII_KEY_MISSING_MESSAGE = 'HANAMII のトークンが見つかりません。公開に使った登録を「認証情報」で確かめ、トークンを入れ直してから、もう一度お試しください。'
  + 'その登録を消した場合は、足し直しても使えません。HANAMII の管理画面でプロジェクトを削除し、保存場所が残っていないかコントロールパネルで確かめてください。'

export const HANAMII_TEARDOWN_WORDS: TeardownWords = {
  verb: '破棄',
  confirmTitle: 'HANAMII の公開を破棄します',
  confirmLabel: '破棄する',
  activityLabel: 'HANAMII の破棄',
  rowButton: '🗑 破棄',
  running: '破棄しています…',
  doneHeadline: '✅ 破棄しました',
  inProgressHeadline: '⏳ 破棄の途中です',
  failedHeadline: '⚠️ 破棄できませんでした',
  factsUnreadable: '破棄するものの記録を読めませんでした',
  nothingToDo: 'HANAMII のプロジェクトIDが記録に無いため、ここからは削除できません。HANAMII の管理画面から削除してください。',
  askAiTarget: 'HANAMII',
}

export const hanamiiTeardownSpec: TargetSpec<HanamiiTeardownRecord, { token: string }, HanamiiTeardownReply> = {
  target: 'hanamii',
  handler: 'hanamii:teardown',
  words: HANAMII_TEARDOWN_WORDS,
  // HANAMII のプロジェクトを消すと課金が止まるかは、原本で確かめていない。
  claimsComputeBillingStops: false,
  // 「元に戻せません」と言うのは、Koto が消す保存場所のデータだけ。プロジェクトそのものの削除が戻せるかは、原本に無いので言わない。
  irreversibleNote: 'storage-only',
  readRecord: readHanamiiTeardownRecord,
  hasWork: record => !!record.projectId,
  // 保存場所だけが残った回は、HANAMII のプロジェクトはもう無い。名前を挙げて「破棄します」と言わない。
  targets: record => (record.storageLeftoverBuckets === null
    ? [`HANAMII のプロジェクト『${record.name ?? record.projectId}』`]
    : []),
  leftoverNote: record => {
    const left = record.storageLeftoverBuckets
    if (left === null) return null
    // 印は 404 でも書かれる（原本の 404 は「存在しない、または参照できない」）。「すでに削除されています」とは言い切らない。
    return `前回の破棄で、HANAMII のプロジェクトは削除済みか見つからない状態でした。残っている保存場所${bucketNamesText(left)}を削除します。`
  },
  loadAuth: async record => {
    // 公開したときのトークンだけで呼ぶ。見つからなければ null（流れが、呼ばずに止めて案内を出す）。使用中・先頭の登録へは倒さない。
    const token = record.tokenId ? await getHanamiiTokenById(record.tokenId) : await getHanamiiToken()
    return token ? { token } : null
  },
  invoke: (projectDir, auth, opts, record) =>
    window.electronAPI.hanamii.teardown(projectDir, auth, { confirmed: opts.confirmed, projectId: record.projectId ?? '' }),
  failure: message => ({ ok: false, message }),
  toView: raw => toTeardownView('hanamii', raw),
}
