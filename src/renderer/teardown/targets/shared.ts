// teardown/targets/shared.ts — 共用型（さくらのAppRun 共用型）の破棄の仕様書（TargetSpec）。公開先ごとの違いは、全部ここに置く。
//
// 段階2（2b-1）。設計書: docs/teardown-unify-plan.md の 10.7.8 と、10.7.16 末尾の親の判断（2026-10-10）。
// 流れ（確認 → 実行）・確認の文・結果の読み方は共通の部品（teardown/flow.ts・confirm.ts・shared/teardownResult.ts）が持つ。ここが持つのは共用型だけの事実:
//   ・記録（main の cloud:teardownRecord）から何を読むか
//   ・消すものの名前・消すものが無い（幽霊の行）かどうか（記録の保存場所は env.json の同意済み全件 + state にだけある保存場所）
//   ・コンテナレジストリを消すかどうかの選択（既定でオンなのは、Koto がこのプロジェクトのために作ったと分かっていて、ほかのプロジェクトが使っていないものだけ。借りたもの・分からないもの・使われているものは既定オフ）
//   ・main の cloud:teardown を呼ぶ1行（invoke）。**src 全体で、この IPC を呼ぶのはこのファイルの invoke だけ**にする（入口は流れ〔flow.ts〕を通す）
//
// 掟4（方式B）: さくらのクラウドのキーは main が持つ。ここは `{ heldByMain: true }` の印だけを渡し、キーを読まない・保存しない。
//
// ── 言うことの根拠（掟1）──────────────────────────────────────────────────────────
// `irreversibleNote: 'always'` と 🔗 の段落（公開URLが変わる）は、今の S1（AppRunPanel）・S3（📡 一覧）がどちらも言っている文を引き継いだもの。
// 2026-10-10 に AppRun 共用型 API の原本（https://manual.sakura.ad.jp/api/cloud/portal/openapis/apprun-shared-api.json・版 1.5.0）を読んだ。
// `DELETE /applications/{id}` は「アプリケーションを削除します」（成功は 204、無いと 404）としか書いておらず、削除が元に戻せないことも、
// 公開URL（`public_url` の例は `https://<ランダムな文字列>.apprun.sakura.ne.jp`）が何から決まるかも、原本には書いていない。
// 根拠が原本に無いので、**範囲を広げも狭めもせず**、今の画面の言い方のまま残す（原本で確かめた事実ではない）。親の判断待ち。

import type { TargetSpec, TeardownWords } from '../types'
import type { ConfirmChoice } from '../../useConfirmChoices'
import { toTeardownView } from '../../../shared/teardownResult'
import { bucketNamesText } from '../../../shared/teardownSupport'
import { isRegistryOrigin, registryChoiceNote, registryDeleteDefault, registryDeleteHelp, registryDeleteLabel, registryIsOnlyThisProjects, registryUnknownNotice, urlChangesOnTeardownNotice, type RegistryOrigin } from '../../../shared/cloudCost'

/** main の `cloud:teardownRecord` が返す、このプロジェクトの破棄の材料（src/main/ipc/cloudTeardown.ts の SharedTeardownRecord と同じ形）。 */
export type SharedTeardownRecord = {
  appNames: string[]
  registryName: string | null
  /** そのレジストリを、このプロジェクトのために Koto が作ったか（owned）・借りたか（adopted）・分からないか（unknown）。 */
  registryOrigin: RegistryOrigin
  /** このレジストリを使っている、ほかのプロジェクトの名前。1件でもあれば、作った側でも既定でレジストリを消さない。 */
  registryUsers: string[]
  /** 消す保存場所の全件 = env.json の同意済み + state にだけある保存場所（後ろ）。 */
  placements: Array<{ bucket: string; prefix: string; shared: boolean }>
  /** placements のうち、env.json に無く state にだけあるもの（利用者が設定から外した保存場所。確認が言い分ける）。 */
  stateOnlyBuckets: string[]
}

export type SharedTeardownReply = Awaited<ReturnType<Window['electronAPI']['cloud']['teardown']>>

/** main に渡す認証の印。キーそのものではない（main が持つ）。ちょうどこの形だけを main が通す。 */
export const SHARED_TEARDOWN_AUTH: { heldByMain: true } = Object.freeze({ heldByMain: true as const })

/** 入口の「キーが無いとき」の文。`loadAuth` が null を返さない（キー未登録は main が外へ出さずに断る）ので、画面の呼び間違いでしか出ない。 */
export const SHARED_KEY_MISSING_MESSAGE = 'さくらのクラウドのAPIキーが未登録です。「認証情報」で登録してから、もう一度お試しください。'

export const SHARED_TEARDOWN_WORDS: TeardownWords = {
  verb: '破棄',
  confirmTitle: 'さくらのAppRun の公開を破棄します',
  confirmLabel: '破棄する',
  activityLabel: 'さくらのAppRun の破棄',
  rowButton: '🗑 破棄',
  running: '破棄しています…',
  doneHeadline: '✅ 破棄しました',
  inProgressHeadline: '⏳ 破棄の途中です',
  failedHeadline: '⚠️ 破棄できませんでした',
  factsUnreadable: '破棄するものの記録を読めませんでした',
  nothingToDo: '公開されていないため、破棄するものはありません。',
  askAiTarget: 'さくらのAppRun',
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
const isStringArray = (x: unknown): x is string[] => Array.isArray(x) && x.every(v => typeof v === 'string')

/**
 * 記録を読む。**読めない・形が違うときは投げる**（確認を出さない）。形が違う応答を空の記録に倒すと「消すものが無い」と読んでしまい、
 * 実際にはあるものを「破棄するものはありません」と言ってしまう。
 */
export async function readSharedTeardownRecord(projectDir: string): Promise<SharedTeardownRecord> {
  const r = await window.electronAPI.cloud.teardownRecord(projectDir)
  if (!r || r.ok !== true) throw new Error((r as { message?: string } | undefined)?.message || '破棄するものの記録を読めませんでした')
  const rec: unknown = r.record
  if (!isObj(rec) || !isStringArray(rec.appNames) || !isStringArray(rec.stateOnlyBuckets) || !isStringArray(rec.registryUsers) || !isRegistryOrigin(rec.registryOrigin)
    || !(rec.registryName === null || typeof rec.registryName === 'string') || !Array.isArray(rec.placements)
    || !rec.placements.every(p => isObj(p) && typeof p.bucket === 'string' && typeof p.prefix === 'string' && typeof p.shared === 'boolean')) {
    throw new Error('破棄するものの記録の形を読めませんでした')
  }
  return {
    appNames: [...rec.appNames],
    registryName: rec.registryName === '' ? null : rec.registryName,
    registryOrigin: rec.registryOrigin,
    registryUsers: [...rec.registryUsers],
    placements: rec.placements.map(p => ({ bucket: String(p.bucket), prefix: String(p.prefix), shared: p.shared === true })),
    stateOnlyBuckets: [...rec.stateOnlyBuckets],
  }
}

/**
 * 記録に消すものがあるか（アプリ・コンテナレジストリ・保存場所のどれか）。仕様書の hasWork と、プロジェクト削除の材料（projectDeleteFacts.ts。
 * 共用型の行が無いのに記録に消すものが残るプロジェクトを見つける）が、同じ判断を使う（判断を2つ持たない）。
 */
export const sharedTeardownHasWork = (r: SharedTeardownRecord): boolean => r.appNames.length > 0 || !!r.registryName || r.placements.length > 0

export const sharedTeardownSpec: TargetSpec<SharedTeardownRecord, { heldByMain: true }, SharedTeardownReply> = {
  target: 'sakura-apprun',
  handler: 'cloud:teardown',
  words: SHARED_TEARDOWN_WORDS,
  // AppRun のアプリを消すと課金が止まるかは、原本で確かめていない。言う範囲を広げない。
  claimsComputeBillingStops: false,
  // 今の S1・S3 がどちらも無条件に言っている。範囲を広げも狭めもしない（原本に根拠は無い。ファイル冒頭）。
  irreversibleNote: 'always',
  readRecord: readSharedTeardownRecord,
  // 記録に無い残骸（レジストリだけ・保存場所だけ）でも確認を出す（P11）。保存場所は env.json の同意済み + state にだけあるもの
  // （親の判断・2026-10-10: state にだけある保存場所も「言って消す」ので、数える）。
  hasWork: sharedTeardownHasWork,
  targets: r => {
    // アプリが無く保存場所も無い回（レジストリだけ）は、一覧の先頭が空にならないよう、選択の欄が言うものをここでも1件挙げる。
    if (r.appNames.length === 0 && r.placements.length === 0 && r.registryName) {
      return [`コンテナレジストリ『${r.registryName}』（下のチェックで選んだとき）`]
    }
    return r.appNames.map(n => `AppRun アプリ『${n}』`)
  },
  choices: (r): ConfirmChoice[] => {
    if (!r.registryName) return []
    const note = registryChoiceNote({ origin: r.registryOrigin, registryName: r.registryName, users: r.registryUsers })
    const onlyThisProjects = registryIsOnlyThisProjects({ registryName: r.registryName, origin: r.registryOrigin, otherUsers: r.registryUsers.length })
    return [{
      id: 'deleteRegistry',
      label: registryDeleteLabel(r.registryName),
      // 既定でオンにするのは、Koto がこのプロジェクトのために作ったと分かっていて（owned）、ほかのプロジェクトが使っていないものだけ。
      // 借りたもの・作ったか分からないもの・ほかのプロジェクトが使っているものは既定オフで、外した理由を note で言う。ほかのアプリのイメージが入っている。
      defaultChecked: registryDeleteDefault({ registryName: r.registryName, origin: r.registryOrigin, otherUsers: r.registryUsers.length }),
      ...(note ? { note } : {}),
      // 外したときの月額と「後で消す場合は削除して」は、このプロジェクトだけのレジストリにだけ言う（借り物・ほかが使うものには言わない。残す理由は上の note が言う）。
      help: {
        checked: registryDeleteHelp(true, onlyThisProjects),
        unchecked: registryDeleteHelp(false, onlyThisProjects),
      },
    }]
  },
  notes: r => {
    const out: string[] = []
    if (r.appNames.length > 0) out.push(`🔗 ${urlChangesOnTeardownNotice()}`)
    // 記録が無いと言うのは、アプリがあるときだけ。押し直しの回（レジストリを消し終えて保存場所で止まった回）は記録にレジストリ名が無いが、
    // 公開した形跡の無い記録に「月額がかかり続けます」は言わない。
    if (!r.registryName && r.appNames.length > 0) out.push(`⚠️ ${registryUnknownNotice()}`)
    // 利用者が設定から外した保存場所。Koto が作ったもので、残すと月額が黙って続くので、確認で言って消す。
    if (r.stateOnlyBuckets.length > 0) out.push(`⚠️ 設定から外した保存場所${bucketNamesText(r.stateOnlyBuckets)}も削除します。`)
    return out
  },
  // main が返した、消す保存場所の全件を使う（共通の読み口の env.json だけの読みを上書きする。確認が言うものと main が消すものを同じ関数で決める）。
  placementsOf: r => r.placements.map(p => ({ bucket: p.bucket, prefix: p.prefix, shared: p.shared })),
  // 消すものが記録に無い（幽霊の行）のは失敗ではない。画面は中立の知らせで出し、プロジェクトの削除はそのまま進める。
  nothingToDoIsOk: true,
  // キー未登録は main が外へ出さずに断る。ここは null を返さない。
  loadAuth: async () => SHARED_TEARDOWN_AUTH,
  invoke: (projectDir, auth, opts, record) =>
    window.electronAPI.cloud.teardown(projectDir, auth, {
      confirmed: opts.confirmed,
      // 選んだときだけ消す（省略・boolean 以外は消さない）。既定でオンなのは、Koto が作ったと分かっているものだけ。
      deleteRegistry: opts.choices?.deleteRegistry === true,
      // 確認を出した時点の記録の名前。main は記録の名前と一致するときだけ消す（確認のあとで記録が変わったときに別のレジストリを消さない）。
      registryName: record.registryName,
    }),
  failure: message => ({ ok: false, message }),
  toView: raw => toTeardownView('sakura-apprun', raw),
}
