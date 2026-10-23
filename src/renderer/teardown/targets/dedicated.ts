// teardown/targets/dedicated.ts — 専有型（さくらのAppRun 専有型）の削除の仕様書（TargetSpec）。公開先ごとの違いは、全部ここに置く。
//
// 段階3B（3B-4）。設計書: docs/teardown-unify-plan.md の 10.11.8。流れ（確認 → 実行）・確認の文・結果の読み方は共通の部品
// （teardown/flow.ts・confirm.ts・shared/teardownResult.ts）が持つ。ここが持つのは専有型だけの事実:
//   ・記録（main の apprunDedicated:state ＝ .sakuraide.json の publish.apprunDedicated）から何を読むか
//   ・消すものの名前（アプリ → ロードバランサ → オートスケーリンググループ → クラスタの順。main の teardownFlow と同じ）
//   ・ロードバランサの削除に時間がかかる予告（waitNote）・DNS の A レコードの案内（D10。notes）
//   ・キーの読み方（token と secret の両方がある）・入口ごとの「キーが無いとき」の文
//   ・main の apprunDedicated:teardown を呼ぶ1行（invoke）・進み具合の購読（subscribeProgress）。
//     **src 全体で、この IPC を呼ぶのも、進み具合を購読するのも、このファイルの1行ずつだけ**にする（入口は流れ〔flow.ts〕を通す）
//
// 共通の部品（teardown/・components/teardown/）は、専有型のパネルの部品（apprunDedicatedActions.ts・AppRunDedicatedPanel.tsx）を import しない。
// 手本だった dedicatedTeardownFlow.ts の文は、1文字も変えずにここへ移した（言葉・消すものの並び・時間の予告・幽霊の行の案内。
// 手本は 0.6.22 段階3B-7 で消した。0.6.21 の手本が返していた文とここの文が同じであることは、手本の出力を書き出した
// tests/fixtures/dedicated-teardown-golden.json と突き合わせる tests/dedicatedTeardownGolden.test.ts が固定する）。
//
// 掟4（方式B）: キーは使う瞬間に読んで引数で渡す。ここでは保存しない。

import type { ApprunDedicatedRecord } from '../../../shared/publishMeta'
import { estimateLineFor } from '../../../shared/stageEstimate'
import { STAGE } from '../../../shared/stageTiming'
import { dedicatedTeardownHasWork } from '../../../shared/teardownSupport'
import { toTeardownView } from '../../../shared/teardownResult'
import type { TargetSpec, TeardownWords } from '../types'

/** `apprunDedicated:state` の返り値と同じ（記録の資源の ID・ホスト名・保存場所だけ残った印）。 */
export type DedicatedTeardownRecord = ApprunDedicatedRecord

export type DedicatedTeardownReply = Awaited<ReturnType<Window['electronAPI']['apprunDedicated']['teardown']>>

/**
 * 消すものが記録に無いときの案内（幽霊の行の 🗑）。さくらのクラウドには何も要求していない。行を消すのは「一覧から削除」。
 *
 * 「一覧から削除」は Koto の記録の行を消すだけで、さくら側の実物には触れない。記録が失われただけで実物が残っていることもあるので
 * （Koto の記録に無いものは、Koto からは消せない）、押す前に、さくら側に残っていないかを確かめてもらう。
 * 確かめる場所は 📡 の「さくら側にあるものと、かかっている費用」（「調べる」を押したときだけ問い合わせる）か、コントロールパネル。
 * README・使い方ガイド（docs/usage-guide.html）にもこの文を引いている（掟9）。
 */
export const DEDICATED_NOTHING_TO_DELETE_MESSAGE = '削除するもの（アプリ・ロードバランサ・オートスケーリンググループ・クラスタ）が、このプロジェクトの記録にありません。'
  + 'さくらのクラウドには何も要求していません。📡 公開したもの一覧に行だけが残っているときは、その行の「一覧から削除」で消せます。'
  + 'さくら側に残っていないかは、📡 の「さくら側にあるものと、かかっている費用」で「調べる」を押すか、コントロールパネルで確かめてから、「一覧から削除」してください。'

/** 専有型は「削除」と言う（確認 → 進み具合 → 結果まで、1回の流れの中で名前を変えない。共用型・HANAMII は「破棄」）。 */
export const DEDICATED_TEARDOWN_WORDS: TeardownWords = {
  verb: '削除',
  confirmTitle: '専有型クラスタを削除します',
  confirmLabel: '削除する',
  activityLabel: '専有型クラスタの削除',
  rowButton: '🗑 削除',
  running: '削除しています…',
  doneHeadline: '✅ すべて削除しました',
  inProgressHeadline: '⏳ 削除中です',
  failedHeadline: '⚠️ 削除できませんでした',
  factsUnreadable: '削除するものの記録を読めませんでした',
  nothingToDo: DEDICATED_NOTHING_TO_DELETE_MESSAGE,
  askAiTarget: 'さくらのAppRun（専有型）',
}

/** 📡 の行で、さくらのクラウドのキーが無いとき（入口ごとに、キーを登録する場所の案内が違う）。 */
export const DEDICATED_LIST_KEY_MISSING_MESSAGE = 'さくらのクラウドの API キーが未登録です。「認証情報」で登録してから、もう一度お試しください。'

/** 手順6の節で、さくらのクラウドのキーが無いとき。 */
export const DEDICATED_PANEL_KEY_MISSING_MESSAGE = 'さくらのクラウドAPIキーが未登録です。手順1で登録してください。'

/**
 * 削除するものの名前（アプリ → ロードバランサ → オートスケーリンググループ → クラスタの順。main の teardownFlow と同じ順）。
 * 記録にあるものだけを並べる。
 */
export function dedicatedTeardownTargets(record: DedicatedTeardownRecord | null | undefined): string[] {
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
export function lbWaitNote(record: DedicatedTeardownRecord | null | undefined, lbEstimateLine: string | null): string | null {
  if (!record?.loadBalancerID || !lbEstimateLine) return null
  return `⏳ ロードバランサの削除には時間がかかります。${lbEstimateLine}。`
}

/**
 * D10（設計書 10.6.2 の0b・10.11.8）: ロードバランサを削除するとき、DNS の A レコードを消すよう案内する一文。
 *
 * 出すのは記録に `loadBalancerID` があるとき（この削除でロードバランサの IP がさくらに返る回）だけ。保存場所だけが残った押し直しでは出さない。
 * `hosts`（記録の独自ドメイン）が1件以上あればそのホスト名を、無ければ名前なしの文にする。
 * 「割り当てられることがあります」は一般論の言い方で、返した IP が別の利用者に割り当てられるかは確かめていない
 * （docs/dns-assist-plan.md 2-4・【未確認】19）。だから断定せず、いつ割り当てられるかも言わない。
 * Koto は DNS を読まず、書かない（記録の `hosts` を文に入れるだけ）。
 */
export function dnsRecordNote(record: DedicatedTeardownRecord | null | undefined): string | null {
  if (!record?.loadBalancerID) return null
  const hosts = Array.isArray(record.hosts) ? record.hosts.filter((h): h is string => typeof h === 'string' && h !== '') : []
  const where = hosts.length > 0 ? `DNS に ${hosts.join('・')} の A レコードがあれば` : '独自ドメインの DNS に、このロードバランサを指す A レコードがあれば'
  return `🌐 ${where}、DNS の管理画面で削除してください。削除するロードバランサの IP は、いずれ別の利用者に割り当てられることがあります。`
}

const nonEmpty = (x: unknown): x is string => typeof x === 'string' && x !== ''

export const dedicatedTeardownSpec: TargetSpec<DedicatedTeardownRecord, { token: string; secret: string }, DedicatedTeardownReply> = {
  target: 'sakura-apprun-dedicated',
  handler: 'apprunDedicated:teardown',
  words: DEDICATED_TEARDOWN_WORDS,
  claimsComputeBillingStops: true,
  irreversibleNote: 'always',
  // 投げたら投げる（流れが、確認も実行も出さずに「記録を読めませんでした」と言う）。
  readRecord: projectDir => window.electronAPI.apprunDedicated.state(projectDir),
  // main の `apprunDedicated:teardown` と同じ1つの判断（保存場所に触れるか）。
  hasWork: dedicatedTeardownHasWork,
  targets: dedicatedTeardownTargets,
  notes: record => {
    const dns = dnsRecordNote(record)
    return dns ? [dns] : []
  },
  waitNote: (record, estimates) => lbWaitNote(record, estimateLineFor(STAGE.teardownLb, estimates)),
  // token と secret のどちらかが空なら、キーが無いのと同じ（空の secret のまま IPC へ進むと、入口ごとのキーの案内が出なくなる）。
  loadAuth: async () => {
    const key = await window.electronAPI.cloud.loadKey()
    return key && nonEmpty(key.token) && nonEmpty(key.secret) ? { token: key.token, secret: key.secret } : null
  },
  // 確認の印は流れが付ける（`opts.confirmed` は true だけ）。選択の欄は無いので choices は渡さない。
  invoke: (projectDir, auth, opts) => window.electronAPI.apprunDedicated.teardown(projectDir, auth, { confirmed: opts.confirmed }),
  failure: message => ({ ok: false, executed: [], message, remaining: {} }),
  toView: raw => toTeardownView('sakura-apprun-dedicated', raw),
  subscribeProgress: cb => window.electronAPI.apprunDedicated.onTeardownProgress(cb),
}
