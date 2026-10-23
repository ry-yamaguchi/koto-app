import { describe, it, expect, beforeEach } from 'vitest'
import { summarizeResult, getOps, stageReporter, resetProjectOpsForTests } from '../src/main/projectOps'
import { withProjectLock } from '../src/main/projectLock'
import { teardownRemainingWarnings } from '../src/shared/cloudCost'
import { STAGE } from '../src/shared/stageTiming'
import { hasWarnMark } from '../src/shared/opsText'
import type { PublishTargetKind } from '../src/shared/publishMeta'
import {
  toTeardownView, resumedTeardownView, teardownWarningsOf, reportedLinesOf,
  TEARDOWN_REMAINING_WARNING_HEAD, TEARDOWN_IN_PROGRESS_WARNING_HEAD, TEARDOWN_RESULT_UNREADABLE,
  type TeardownView, type TeardownLeftover,
} from '../src/shared/teardownResult'

// ── 結果の双子（段階0・0c）: 破棄の結果は、その場の返り値で読んでも、閉じて開き直した記録で読んでも同じ ──────────────────
//
// 画面は破棄の結果を2通りに読む。(1) 終わったその場の IPC の返り値（toTeardownView）、(2) 閉じて開き直したあとの main の記録
// （本物の summarizeResult を通ったもの。resumedTeardownView）。片方だけ文や見出しが変わると、月額が続く警告が、開き直した
// 画面からだけ消える（2026-09-30 検分の指摘6と同じ形）。ここでは**本物の summarizeResult** に同じ返り値を通して、2つの読み方が
// 同じ TeardownView になることを、公開先ごとの実際の返り値の形で固定する。
//
// 等しいことだけを見ると「どちらも空」でも通るので、各ケースで、見出し・残ったもの・警告の文を**別に書いた期待**でも確かめる。
// （この単位では、どの入口・IPC からもまだ呼ばれない。部品と単体テストだけ。）

const DEDICATED = 'sakura-apprun-dedicated' as const
const SHARED = 'sakura-apprun' as const
const HANAMII = 'hanamii' as const
const DIR = '/tmp/koto-teardown-result-common'

/** 同じ返り値を、その場で読む／記録（summarizeResult）から読む。 */
function twin(target: PublishTargetKind, raw: unknown) {
  return { live: toTeardownView(target, raw), resumed: resumedTeardownView(target, summarizeResult(raw)) }
}
/** 段ごとの時間は、記録側では finishOp が足すので（summarizeResult は足さない）、比べるときは外す。 */
const noTimings = (v: TeardownView): TeardownView => ({ ...v, stageTimings: null })
const labels = (list: TeardownLeftover[]) => list.map(l => l.label)

const STORAGE = (b: string): TeardownLeftover => ({ label: `保存場所『${b}』（月額が続きます）`, billing: true, kind: 'storage' })
const SERVICE = (label: string, billing: boolean): TeardownLeftover => ({ label, billing, kind: 'service' })

// 保存場所が入っているときは、削除する前の確かめを添える（保存場所はほかのプロジェクトも使っていることがある。Koto は中身を確かめていない）
const STORAGE_CHECK = '保存場所は、ほかのプロジェクトも使っていないか確かめてから削除してください。消すと、そのプロジェクトのデータも消えます。'
const REMAINING_SENTENCE = (names: string) =>
  `削除できずに残っているものがあります。残っている間は課金が続きます。コントロールパネルから直接削除することもできます: ${names}${names.includes('保存場所『') ? `。${STORAGE_CHECK}` : ''}`
const IN_PROGRESS_SENTENCE =
  '削除の途中で、待ち切れずに止まりました。しばらくしてから、もう一度削除を実行してください（続きから進みます）。'   // T203（V12）: 「記録は残してあるので、」を削った

const APP_LINE = 'アプリケーション『app1』を削除しました（消えたことを確認）'
const CLUSTER_LINE = "クラスタ『c1』を削除しました"
const STORAGE_DONE_LINE = '保存場所『koto-data-x』のデータを削除しました — 保存場所そのものは残します'
const SHARED_APP_LINE = "AppRun アプリ『myapp』を削除しました"
const SHARED_STORAGE_DONE = (b: string) => `保存場所『${b}』のデータを削除しました — 保存場所そのものも削除しました`
const SHARED_RETRY = 'もう一度 🗑 破棄を押すと、保存場所の削除だけをやり直します。'
const KEY_WARN = '⚠️ 保存場所のアクセスキーを無効にできませんでした。コントロールパネルから確認してください'
const NOTE_WARN = '※ このプロジェクトがどのコンテナレジストリを使っていたかの記録がないため、レジストリは削除していません'
const DONE_MSG = '削除の要求はすべて受け付けられ、一覧から消えたことを確認しました。コントロールパネルでもご確認ください。'
// 返り値が文のまま持っている知らせ（warnings・notice・verifyNote）。今の3つの IPC は返さないが、新しい知らせは warnings で返すのが main の決まり。
const NEW_WARN = '⚠️ 新しい知らせです（月額が続きます）'
const PLAIN_WARN = '保存場所のアクセスキーを、コントロールパネルで確かめてください'
const NOTICE = 'お知らせ: 消えたことを、あとでもう一度確かめてください'
const VERIFY_LINE = '消えたことを確かめました'
const VERIFY_WARN = '※ 確かめきれませんでした'

type Case = { name: string; target: PublishTargetKind; raw: Record<string, unknown>; check: (v: TeardownView) => void }

const CASES: Case[] = [
  // ── 専有型（apprunDedicated:teardown）5通り＋ ──
  {
    name: '専有型 1 全部消えた', target: DEDICATED,
    raw: { ok: true, appDeleted: true, executed: [APP_LINE, CLUSTER_LINE], message: DONE_MSG, remaining: {} },
    check: v => {
      expect(v).toMatchObject({ ok: true, state: 'done', appDeleted: true, executed: [APP_LINE, CLUSTER_LINE], message: DONE_MSG, remaining: [], inProgress: [], warnings: [] })
    },
  },
  {
    name: '専有型 2 保存場所だけ残った', target: DEDICATED,
    raw: { ok: false, appDeleted: true, executed: [APP_LINE, CLUSTER_LINE], message: "保存場所『koto-data-x』を削除できませんでした（消すまで月額が続きます）", remaining: { storageBucket: 'koto-data-x' } },
    check: v => {
      expect(v).toMatchObject({ ok: false, state: 'failed', appDeleted: true, remaining: [STORAGE('koto-data-x')], inProgress: [] })
      expect(v.warnings).toEqual([REMAINING_SENTENCE("保存場所『koto-data-x』（月額が続きます）")])
    },
  },
  {
    name: '専有型 3 途中で止まった', target: DEDICATED,
    raw: {
      ok: false, executed: [APP_LINE], message: 'ロードバランサの削除が終わるのを待ち切れませんでした',
      remaining: { loadBalancerID: 'lb1', asgID: 'asg1', clusterID: 'c1' }, inProgress: { loadBalancerID: 'lb1', asgID: 'asg1', clusterID: 'c1' },
    },
    check: v => {
      expect(v).toMatchObject({ ok: false, state: 'inProgress', appDeleted: null, executed: [APP_LINE] })
      expect(v.inProgress).toEqual([SERVICE("ロードバランサ『lb1』", false), SERVICE("オートスケーリンググループ『asg1』", false), SERVICE("クラスタ『c1』", false)])
      // 待ち切れて止まった回は「途中」の文だけ（「残っている」の文は重ねない）
      expect(v.warnings).toEqual([IN_PROGRESS_SENTENCE])
    },
  },
  {
    name: '専有型 4 残った（5つ全部・キーの並びは逆順で渡す）', target: DEDICATED,
    raw: {
      ok: false, executed: [], message: 'ロードバランサの削除に失敗しました',
      remaining: { storageBucket: 'koto-data-x', clusterID: 'c1', asgID: 'asg1', loadBalancerID: 'lb1', applicationID: 'app1' },
    },
    check: v => {
      expect(v.state).toBe('failed')
      // 並びは削除の順（アプリ → ロードバランサ → ASG → クラスタ → 保存場所）。渡したキーの並びには依らない
      expect(v.remaining).toEqual([
        SERVICE("アプリケーション『app1』", true), SERVICE("ロードバランサ『lb1』", true), SERVICE("オートスケーリンググループ『asg1』", true),
        SERVICE("クラスタ『c1』", true), STORAGE('koto-data-x'),
      ])
      expect(v.warnings).toEqual([REMAINING_SENTENCE("アプリケーション『app1』・ロードバランサ『lb1』・オートスケーリンググループ『asg1』・クラスタ『c1』・保存場所『koto-data-x』（月額が続きます）")])
    },
  },
  {
    name: '専有型 5 鍵の警告つき（⚠️ の行は起きたことから警告へ移る）', target: DEDICATED,
    raw: { ok: true, appDeleted: true, executed: [APP_LINE, KEY_WARN], message: DONE_MSG, remaining: {} },
    check: v => {
      expect(v.state).toBe('done')
      expect(v.executed).toEqual([APP_LINE])
      expect(v.warnings).toEqual([KEY_WARN])
    },
  },
  {
    name: '専有型 6 鍵の警告＋バケットごとは消さなかった保存場所2件（警告の並び: 行の警告 → 月額の警告）', target: DEDICATED,
    raw: {
      ok: true, appDeleted: true, executed: [APP_LINE, STORAGE_DONE_LINE, KEY_WARN, NOTE_WARN], message: DONE_MSG, remaining: {},
      keptBucketName: 'koto-data-x', keptBucketNames: ['koto-data-x', 'koto-data-y'],
    },
    check: v => {
      expect(v.executed).toEqual([APP_LINE, STORAGE_DONE_LINE])
      expect(v.remaining).toEqual([]) // 成功の回に残した保存場所は「残ったもの」ではなく、警告だけが言う
      expect(v.warnings.slice(0, 2)).toEqual([KEY_WARN, NOTE_WARN])
      expect(v.warnings).toHaveLength(3)
      expect(v.warnings[2]).toContain("『koto-data-x』")
      expect(v.warnings[2]).toContain("『koto-data-y』")
      expect(v.warnings[2]).toContain('課金は続きます')
    },
  },
  {
    name: '専有型 7 返り値の warnings・notice・verifyNote（行の警告 → verifyNote → warnings → notice → 事実の警告の並び）', target: DEDICATED,
    raw: {
      ok: false, appDeleted: true, executed: [APP_LINE, KEY_WARN], message: 'x', remaining: { clusterID: 'c1' },
      verifyNote: VERIFY_LINE, warnings: [NEW_WARN, PLAIN_WARN, NEW_WARN], notice: NOTICE,
    },
    check: v => {
      expect(v.executed).toEqual([APP_LINE, VERIFY_LINE]) // 印の無い verifyNote は起きたこと。印のある行は警告へ
      expect(v.warnings).toEqual([KEY_WARN, NEW_WARN, PLAIN_WARN, NOTICE, REMAINING_SENTENCE("クラスタ『c1』")]) // 同じ警告は1度
    },
  },
  {
    // 手本の断り方（ipc/apprunDedicated.ts: 鍵が無い・フォルダが不正・別の操作が走っている）は `remaining: {}`。何も始まっていない失敗に
    // 「残っている間は課金が続きます」と言うと、起きていない課金の話になる（手本 DedicatedTeardownView.tsx の teardownFailureHasLeftover の理由・2026-10-08 検分）。
    name: '専有型 8 断られた（何も始まっていない: ok:false・executed 空・remaining 空）— 「課金が続きます」とは言わない', target: DEDICATED,
    raw: { ok: false, executed: [], message: 'クラウドのAPIキーが未登録です', remaining: {} },
    check: v => {
      expect(v).toMatchObject({ ok: false, state: 'failed', appDeleted: null, executed: [], message: 'クラウドのAPIキーが未登録です', remaining: [], inProgress: [], warnings: [] })
    },
  },
  {
    // 実際の返り値の形（ipc/apprunDedicated.ts: `{ ...done, ok: false, executed, ...kept }`）。バケットごとは消さなかった保存場所(x)と、消せなかった保存場所(y)が同時にある。
    name: '専有型 9 保存場所が消せず、別の保存場所はバケットごとは消さなかった（警告の並び: 月額の警告 → 残ったものの警告）', target: DEDICATED,
    raw: {
      ok: false, appDeleted: true, executed: [APP_LINE, STORAGE_DONE_LINE], message: "保存場所『koto-data-y』を削除できませんでした（消すまで月額が続きます）",
      remaining: { storageBucket: 'koto-data-y' }, keptBucketName: 'koto-data-x', keptBucketNames: ['koto-data-x'],
    },
    check: v => {
      expect(v).toMatchObject({ ok: false, state: 'failed', appDeleted: true, remaining: [STORAGE('koto-data-y')], inProgress: [] })
      expect(v.warnings).toHaveLength(2)
      expect(v.warnings[0]).toContain("『koto-data-x』")
      expect(v.warnings[0]).toContain('課金は続きます')
      expect(v.warnings[0].startsWith(TEARDOWN_REMAINING_WARNING_HEAD)).toBe(false)
      expect(v.warnings[1]).toBe(REMAINING_SENTENCE("保存場所『koto-data-y』（月額が続きます）"))
    },
  },
  {
    // 実際の返り値の形（ipc/apprunDedicatedTeardown.ts・段階3B-2）: 保存場所が2件で1件目の一覧に失敗。止まった1件は remaining.storageBucket、残りの全件は remainingBuckets（V10）。
    name: '専有型 10 保存場所が2件・1件目で止まった（remainingBuckets つき。一覧にも警告にも2件とも出る）', target: DEDICATED,
    raw: {
      ok: false, appDeleted: true, executed: [APP_LINE, CLUSTER_LINE],
      message: "保存場所『koto-data-x』の中身を確認できないため、削除を中止しました: 一覧を取得できませんでした\n保存場所『koto-data-x』『koto-data-y』が残っています（消すまで月額が続きます）。",
      remaining: { storageBucket: 'koto-data-x' }, remainingBuckets: ['koto-data-x', 'koto-data-y'],
    },
    check: v => {
      expect(v).toMatchObject({ ok: false, state: 'failed', appDeleted: true, remaining: [STORAGE('koto-data-x'), STORAGE('koto-data-y')], inProgress: [] })
      expect(v.warnings).toEqual([REMAINING_SENTENCE("保存場所『koto-data-x』（月額が続きます）・保存場所『koto-data-y』（月額が続きます）")])
    },
  },
  // ── 共用型（cloud:teardown）4通り＋ ──
  {
    name: '共用型 1 成功', target: SHARED,
    raw: { ok: true, executed: ["AppRun アプリ『myapp』を削除しました"], skipped: [], keptBucketName: null, message: '保存場所にあった、このプロジェクトのデータを削除しました。' },
    check: v => {
      expect(v).toMatchObject({ ok: true, state: 'done', appDeleted: null, remaining: [], inProgress: [], warnings: [], message: '保存場所にあった、このプロジェクトのデータを削除しました。' })
    },
  },
  {
    name: '共用型 2 保存場所を残した（成功）', target: SHARED,
    raw: { ok: true, executed: ["AppRun アプリ『myapp』を削除しました"], skipped: [], keptBucketName: 'koto-myapp-data' },
    check: v => {
      expect(v.state).toBe('done')
      expect(v.remaining).toEqual([])
      expect(v.warnings).toEqual(teardownRemainingWarnings({ keptBucketName: 'koto-myapp-data' }))
      expect(v.warnings).toHaveLength(1)
      expect(v.warnings[0]).toContain("『koto-myapp-data』")
    },
  },
  {
    name: '共用型 3 名前の無いレジストリを残した', target: SHARED,
    raw: { ok: true, executed: ["AppRun アプリ『myapp』を削除しました"], skipped: [], keptBucketName: null, keptRegistryUnnamed: true },
    check: v => {
      expect(v.state).toBe('done')
      expect(v.warnings).toEqual(teardownRemainingWarnings({ keptRegistryUnnamed: true }))
      expect(v.warnings).toHaveLength(1)
    },
  },
  {
    name: '共用型 4 失敗（保存場所が残った）', target: SHARED,
    raw: { ok: false, executed: ["AppRun アプリ『myapp』を削除しました"], skipped: [], keptBucketName: 'koto-myapp-data', message: '保存場所を削除できませんでした（HTTP 403）' },
    check: v => {
      expect(v).toMatchObject({ ok: false, state: 'failed', remaining: [STORAGE('koto-myapp-data')], message: '保存場所を削除できませんでした（HTTP 403）' })
      expect(v.warnings).toEqual(teardownRemainingWarnings({ keptBucketName: 'koto-myapp-data' }))
    },
  },
  {
    name: '共用型 5 名前のあるレジストリを残した＋※の行', target: SHARED,
    raw: { ok: true, executed: ["AppRun アプリ『myapp』を削除しました", NOTE_WARN], skipped: [], keptBucketName: null, keptRegistryName: 'koto-reg' },
    check: v => {
      expect(v.executed).toEqual(["AppRun アプリ『myapp』を削除しました"])
      expect(v.warnings[0]).toBe(NOTE_WARN)
      expect(v.warnings[1]).toContain("『koto-reg』")
      expect(v.warnings).toHaveLength(2)
    },
  },
  {
    name: '共用型 7 返り値の warnings・notice と、印のある verifyNote（月額の警告の前に並ぶ）', target: SHARED,
    raw: { ok: true, executed: ["AppRun アプリ『myapp』を削除しました"], skipped: [], keptBucketName: 'koto-myapp-data', warnings: [NEW_WARN], notice: NOTICE, verifyNote: VERIFY_WARN },
    check: v => {
      expect(v.executed).toEqual(["AppRun アプリ『myapp』を削除しました"])
      expect(v.warnings).toEqual([VERIFY_WARN, NEW_WARN, NOTICE, ...teardownRemainingWarnings({ keptBucketName: 'koto-myapp-data' })])
    },
  },
  {
    name: '共用型 6 断られた・例外（ok と message だけ）', target: SHARED,
    raw: { ok: false, message: 'さくらのクラウドのAPIキーが未登録です' },
    check: v => {
      expect(v).toMatchObject({ ok: false, state: 'failed', executed: [], remaining: [], inProgress: [], warnings: [], message: 'さくらのクラウドのAPIキーが未登録です' })
    },
  },
  // ── 共用型の新しい返り値（段階2。cloud:teardown が appDeleted・remainingBuckets を返す）。本物の main が返した値との一致は tests/teardownResultSharedTwin.test.ts ──
  {
    name: '共用型 8 全部消えた（アプリと保存場所。appDeleted が読める）', target: SHARED,
    raw: {
      ok: true, appDeleted: true, executed: [SHARED_APP_LINE, SHARED_STORAGE_DONE('koto-data-a')], skipped: [], keptBucketName: null,
      message: '保存場所にあった、このプロジェクトのデータを削除しました。',
    },
    check: v => {
      expect(v).toMatchObject({ ok: true, state: 'done', appDeleted: true, remaining: [], inProgress: [], warnings: [] })
      expect(v.executed).toEqual([SHARED_APP_LINE, SHARED_STORAGE_DONE('koto-data-a')])
    },
  },
  {
    name: '共用型 9 アプリは消えて、保存場所が2件残った（remainingBuckets を全件。1件だけにしない）', target: SHARED,
    raw: {
      ok: false, appDeleted: true, executed: [SHARED_APP_LINE], skipped: [], keptBucketName: null,
      remainingBucket: 'koto-data-a', remainingBuckets: ['koto-data-a', 'koto-data-b'],
      message: `保存場所『koto-data-a』の一覧を取得できませんでした\n保存場所『koto-data-a』『koto-data-b』が残っています（消すまで月額が続きます）。${SHARED_RETRY}`,
    },
    check: v => {
      expect(v).toMatchObject({ ok: false, state: 'failed', appDeleted: true, inProgress: [] })
      expect(v.remaining).toEqual([STORAGE('koto-data-a'), STORAGE('koto-data-b')])
      expect(v.executed).toEqual([SHARED_APP_LINE])
      expect(v.warnings).toEqual([REMAINING_SENTENCE("保存場所『koto-data-a』（月額が続きます）・保存場所『koto-data-b』（月額が続きます）")])
    },
  },
  {
    name: '共用型 10 アプリを消せなかった（appDeleted は false。保存場所には触れていないので、残ったものは無い）', target: SHARED,
    raw: { ok: false, appDeleted: false, executed: [], skipped: [], message: 'AppRun アプリ『myapp』の削除に失敗しました（HTTP 500）' },
    check: v => {
      expect(v).toMatchObject({ ok: false, state: 'failed', appDeleted: false, executed: [], remaining: [], inProgress: [], warnings: [] })
    },
  },
  {
    name: '共用型 11 鍵の無効化に失敗（成功のまま ⚠️ の行。起きたことから警告へ移る）', target: SHARED,
    raw: {
      ok: true, appDeleted: true, executed: [SHARED_APP_LINE, SHARED_STORAGE_DONE('koto-data-a'), KEY_WARN], skipped: [], keptBucketName: null,
      message: '保存場所にあった、このプロジェクトのデータを削除しました。',
    },
    check: v => {
      expect(v).toMatchObject({ ok: true, state: 'done', appDeleted: true, remaining: [] })
      expect(v.executed).toEqual([SHARED_APP_LINE, SHARED_STORAGE_DONE('koto-data-a')])
      expect(v.warnings).toEqual([KEY_WARN])
    },
  },
  {
    name: '共用型 12 ほかのプロジェクトが使うので、保存場所そのものは残した（成功。残ったものには入れず、警告だけ）', target: SHARED,
    raw: {
      ok: true, appDeleted: true, executed: [SHARED_APP_LINE, STORAGE_DONE_LINE], skipped: [],
      keptBucketName: 'koto-data-x', keptBucketNames: ['koto-data-x'], message: '保存場所にあった、このプロジェクトのデータを削除しました。',
    },
    check: v => {
      expect(v).toMatchObject({ ok: true, state: 'done', appDeleted: true, remaining: [] })
      expect(v.warnings).toEqual(teardownRemainingWarnings({ keptBucketName: 'koto-data-x', keptBucketNames: ['koto-data-x'] }))
      expect(v.warnings).toHaveLength(1)
      expect(v.warnings[0]).toContain("『koto-data-x』")
    },
  },
  {
    name: '共用型 13 設定（env.json）から外した保存場所を、言って消した（state にだけあった分。成功で、⚠️ の行は出ない）', target: SHARED,
    raw: {
      ok: true, appDeleted: true, executed: [SHARED_APP_LINE, SHARED_STORAGE_DONE('koto-data-b')], skipped: [], keptBucketName: null,
      message: '保存場所にあった、このプロジェクトのデータを削除しました。',
    },
    check: v => {
      expect(v).toMatchObject({ ok: true, state: 'done', appDeleted: true, remaining: [], warnings: [] })
      expect(v.executed).toEqual([SHARED_APP_LINE, SHARED_STORAGE_DONE('koto-data-b')])
    },
  },
  {
    name: '共用型 14 1件は消せず残り、別の1件はほかが使うので残した（警告の並び: 行の警告 → 残した保存場所 → 消せずに残った保存場所）', target: SHARED,
    raw: {
      ok: false, appDeleted: true, executed: [SHARED_APP_LINE, STORAGE_DONE_LINE, KEY_WARN], skipped: [],
      keptBucketName: 'koto-data-x', keptBucketNames: ['koto-data-x'], remainingBucket: 'koto-data-y', remainingBuckets: ['koto-data-y'],
      message: `保存場所『koto-data-y』を削除できませんでした\n保存場所『koto-data-y』が残っています（消すまで月額が続きます）。${SHARED_RETRY}`,
    },
    check: v => {
      expect(v).toMatchObject({ ok: false, state: 'failed', appDeleted: true })
      expect(v.remaining).toEqual([STORAGE('koto-data-y')]) // 残した保存場所（x）は「消せずに残ったもの」に混ぜない
      expect(v.warnings).toHaveLength(3)
      expect(v.warnings[0]).toBe(KEY_WARN)
      expect(v.warnings[1]).toContain("『koto-data-x』")
      expect(v.warnings[1].startsWith(TEARDOWN_REMAINING_WARNING_HEAD)).toBe(false)
      expect(v.warnings[2]).toBe(REMAINING_SENTENCE("保存場所『koto-data-y』（月額が続きます）"))
    },
  },
  // ── HANAMII（hanamii:teardown）。残った保存場所・受付済みの警告つきの通りは tests/teardownResultHanamiiTwin.test.ts ──
  {
    name: 'HANAMII 1 全部消えた', target: HANAMII,
    raw: { ok: true, appDeleted: true, executed: ["HANAMII のプロジェクト『myapp』を削除しました"] },
    check: v => {
      expect(v).toMatchObject({ ok: true, state: 'done', appDeleted: true, remaining: [], warnings: [], message: '' })
    },
  },
  {
    name: 'HANAMII 2 保存場所が残った（複数・⚠️ つき）', target: HANAMII,
    raw: {
      ok: false, appDeleted: true, executed: ["HANAMII のプロジェクト『myapp』を削除しました", KEY_WARN],
      remainingBucket: 'koto-a', remainingBuckets: ['koto-a', 'koto-b'], message: '保存場所『koto-a』を削除できませんでした\n保存場所『koto-a』『koto-b』が残っています（消すまで月額が続きます）。',
    },
    check: v => {
      expect(v).toMatchObject({ ok: false, state: 'failed', appDeleted: true, inProgress: [] })
      expect(v.remaining).toEqual([STORAGE('koto-a'), STORAGE('koto-b')])
      expect(v.executed).toEqual(["HANAMII のプロジェクト『myapp』を削除しました"])
      // 行の警告 → 残った保存場所の警告（月額が続く。2件とも名指し）の並び
      expect(v.warnings).toEqual([KEY_WARN, REMAINING_SENTENCE("保存場所『koto-a』（月額が続きます）・保存場所『koto-b』（月額が続きます）")])
    },
  },
  {
    name: 'HANAMII 3 保存場所を残した（成功）', target: HANAMII,
    raw: { ok: true, appDeleted: true, executed: [STORAGE_DONE_LINE], keptBucketName: 'koto-a', keptBucketNames: ['koto-a', 'koto-b'] },
    check: v => {
      expect(v.state).toBe('done')
      expect(v.remaining).toEqual([])
      expect(v.warnings).toEqual(teardownRemainingWarnings({ keptBucketName: 'koto-a', keptBucketNames: ['koto-a', 'koto-b'] }))
      expect(v.warnings[0]).toContain("『koto-a』")
      expect(v.warnings[0]).toContain("『koto-b』")
    },
  },
  {
    name: 'HANAMII 4 鍵の警告つき', target: HANAMII,
    raw: { ok: true, appDeleted: true, executed: ["HANAMII のプロジェクト『myapp』を削除しました", KEY_WARN] },
    check: v => {
      expect(v.executed).toEqual(["HANAMII のプロジェクト『myapp』を削除しました"])
      expect(v.warnings).toEqual([KEY_WARN])
    },
  },
  {
    name: 'HANAMII 6 返り値の warnings（月額が続く警告を、その場の画面からも落とさない）', target: HANAMII,
    raw: { ok: true, appDeleted: true, executed: ["HANAMII のプロジェクト『myapp』を削除しました"], warnings: [NEW_WARN] },
    check: v => {
      expect(v).toMatchObject({ ok: true, state: 'done', appDeleted: true, remaining: [] })
      expect(v.warnings).toEqual([NEW_WARN])
    },
  },
  {
    name: 'HANAMII 5 プロジェクトを削除できなかった（appDeleted は false）', target: HANAMII,
    raw: { ok: false, appDeleted: false, executed: [], message: 'HANAMII のプロジェクトを削除できませんでした（HTTP 403）' },
    check: v => {
      expect(v).toMatchObject({ ok: false, state: 'failed', appDeleted: false, remaining: [], warnings: [] })
    },
  },
]

describe('結果の双子: その場の返り値と、summarizeResult を通した記録の読み戻しが一致する', () => {
  it.each(CASES.map(c => [c.name, c] as const))('★ %s', (_n, c) => {
    const { live, resumed } = twin(c.target, c.raw)
    expect(resumed).toEqual(live)
    c.check(live) // 「等しい」だけでは、どちらも空でも通る。別に書いた期待でも確かめる
    c.check(resumed)
  })

  it('専有型は10通り以上・共用型は14通り以上・HANAMII の通りがある（ケースの数が減っても気づく）', () => {
    const count = (t: PublishTargetKind) => CASES.filter(c => c.target === t).length
    expect(count(DEDICATED)).toBeGreaterThanOrEqual(10)
    expect(count(SHARED)).toBeGreaterThanOrEqual(14)
    expect(count(HANAMII)).toBeGreaterThanOrEqual(6)
  })

  it('★ 警告の文の作り手は1つ: reportedLinesOf（文で持っている行・警告）＋ teardownWarningsOf（事実から作る警告）＝ summarizeResult の警告と起きたこと（並びも同じ）', () => {
    for (const c of CASES) {
      const rec = summarizeResult(c.raw)
      const reported = reportedLinesOf(c.raw)
      expect(rec.lines, `${c.name}（起きたこと）`).toEqual(reported.executed)
      expect(rec.warnings, c.name).toEqual(Array.from(new Set([...reported.warnings, ...teardownWarningsOf(c.raw)])))
      // 別に書いた期待: executed の ⚠️・※ の行は、必ず警告の先頭側（teardownWarningsOf より前）に入る
      const marked = (c.raw.executed as string[] | undefined ?? []).filter(hasWarnMark)
      expect(rec.warnings.slice(0, marked.length), `${c.name}（印のある行）`).toEqual(marked)
    }
  })

  it('★ 返り値の warnings・notice・verifyNote は、その場でも記録からでも同じ警告・起きたことになる（公開先によらない）', () => {
    for (const t of [DEDICATED, SHARED, HANAMII] as const) {
      const raw = { ok: true, executed: ['a', KEY_WARN], verifyNote: VERIFY_LINE, warnings: [NEW_WARN, '', 7, PLAIN_WARN], notice: NOTICE }
      const { live, resumed } = twin(t, raw)
      expect(live.executed, t).toEqual(['a', VERIFY_LINE])
      expect(live.warnings, t).toEqual([KEY_WARN, NEW_WARN, PLAIN_WARN, NOTICE])
      expect(resumed, t).toEqual(live)
    }
  })

  it('warnings が配列でない・notice や verifyNote が文字列でない → 読まない（空に倒す。推測で埋めない）', () => {
    for (const t of [DEDICATED, SHARED, HANAMII] as const) {
      const raw = { ok: true, executed: [], warnings: NEW_WARN, notice: 5, verifyNote: { text: VERIFY_LINE } }
      const { live, resumed } = twin(t, raw)
      expect(live.warnings, t).toEqual([])
      expect(live.executed, t).toEqual([])
      expect(resumed, t).toEqual(live)
    }
  })

  it('★ 警告の書き出しの定数は、main の実際の文の書き出しと一致する', () => {
    expect(TEARDOWN_REMAINING_WARNING_HEAD).toBe('削除できずに残っているものがあります。残っている間は課金が続きます')
    expect(TEARDOWN_IN_PROGRESS_WARNING_HEAD).toBe('削除の途中で、待ち切れずに止まりました')
    const remaining = summarizeResult({ ok: false, remaining: { clusterID: 'c1' } }).warnings
    const stopped = summarizeResult({ ok: false, remaining: { clusterID: 'c1' }, inProgress: { clusterID: 'c1' } }).warnings
    expect(remaining).toHaveLength(1)
    expect(remaining[0].startsWith(TEARDOWN_REMAINING_WARNING_HEAD)).toBe(true)
    expect(stopped).toHaveLength(1)
    expect(stopped[0].startsWith(TEARDOWN_IN_PROGRESS_WARNING_HEAD)).toBe(true)
  })

  it('起きたことの行が空・文字列でない・同じ警告の2度書きでも、2つの読み方は同じ（空は捨て、同じ警告は1度）', () => {
    for (const t of [DEDICATED, SHARED, HANAMII] as const) {
      const raw = { ok: true, executed: ['a', '', 3, null, KEY_WARN, KEY_WARN, 'b'], message: 7 }
      const { live, resumed } = twin(t, raw)
      expect(resumed).toEqual(live)
      expect(live.executed).toEqual(['a', 'b'])
      expect(live.warnings).toEqual([KEY_WARN])
      expect(live.message).toBe('')
    }
  })
})

describe('不明な値は成功に倒さない（ok === true のときだけ成功）', () => {
  const BAD = ['true', 1, 'ok', {}, [], null, undefined]
  it.each(BAD.map(b => [JSON.stringify(b) ?? 'undefined', b] as const))('ok が %s → 失敗', (_n, bad) => {
    for (const t of [DEDICATED, SHARED, HANAMII] as const) {
      const live = toTeardownView(t, { ok: bad, executed: [], remaining: {} })
      const resumed = resumedTeardownView(t, { ok: bad as unknown as boolean, lines: [], warnings: [], extra: {} })
      expect(live).toMatchObject({ ok: false, state: 'failed' })
      expect(resumed).toMatchObject({ ok: false, state: 'failed' })
    }
  })

  // 見出しだけでなく**警告**も、不明な ok を肯定に戻さない（2026-10-09 検分の指摘。`!v.ok`・`v.ok === false` に変えても、上のテストは
  // remaining が空なので落ちなかった）。残ったものがあるのに ok が true でないなら、「残っている間は課金が続きます」を落とさない。
  it.each(BAD.map(b => [JSON.stringify(b) ?? 'undefined', b] as const))('ok が %s で残ったものがある → 「課金が続きます」の警告を落とさない（記録から読んでも同じ）', (_n, bad) => {
    const raw = { ok: bad, executed: [], remaining: { clusterID: 'c1' } }
    for (const t of [DEDICATED, SHARED, HANAMII] as const) {
      const { live, resumed } = twin(t, raw)
      expect(live.warnings, t).toEqual([REMAINING_SENTENCE("クラスタ『c1』")])
      expect(live.warnings[0].startsWith(TEARDOWN_REMAINING_WARNING_HEAD), t).toBe(true)
      expect(resumed.warnings, `${t}（記録）`).toEqual(live.warnings)
      expect(summarizeResult(raw).warnings, `${t}（main の記録）`).toEqual(live.warnings)
    }
  })
  // 残した印も同じ（2026-10-09 0c の仕上げ。`keptRegistryUnnamed: !!v.keptRegistryUnnamed` に変えても、上のテストは落ちなかった）。
  // 「true だけ」「文字列だけ」を読む。真に見える別の値を読むと、その場の画面にだけ「レジストリを残した」が出て、開き直した画面（summarizeResult）から消える。
  it.each(BAD.map(b => [JSON.stringify(b) ?? 'undefined', b] as const))('残した印が %s（true・文字列以外）→ 「残した」とは言わない（その場も記録からも）', (_n, bad) => {
    const raw = { ok: true, executed: [], keptBucketName: 5, keptBucketNames: 'koto-a', keptRegistryName: {}, keptRegistryUnnamed: bad }
    expect(teardownWarningsOf(raw)).toEqual([])
    expect(summarizeResult(raw).warnings).toEqual([])
    for (const t of [DEDICATED, SHARED, HANAMII] as const) {
      const { live, resumed } = twin(t, raw)
      expect(live.warnings, t).toEqual([])
      expect(live.remaining, t).toEqual([])
      expect(resumed, t).toEqual(live)
    }
  })
  it('ok が true のときだけ、残ったものがあっても「課金が続きます」とは言わない（summarizeResult と同じ）', () => {
    const raw = { ok: true, executed: [], remaining: { clusterID: 'c1' } }
    expect(teardownWarningsOf(raw)).toEqual([])
    expect(summarizeResult(raw).warnings).toEqual([])
    for (const t of [DEDICATED, SHARED, HANAMII] as const) expect(twin(t, raw).live.warnings, t).toEqual([])
  })
})

describe('読めない返り値・記録（推測で埋めない）', () => {
  const UNREADABLE: TeardownView = {
    ok: false, state: 'failed', appDeleted: null, executed: [], message: TEARDOWN_RESULT_UNREADABLE,
    remaining: [], inProgress: [], warnings: [], stageTimings: null,
  }
  it('オブジェクトでない返り値 → 「結果を読み取れませんでした」の失敗（成功や空の結果にしない）', () => {
    for (const t of [DEDICATED, SHARED, HANAMII] as const) {
      for (const raw of [null, undefined, 'ok', 42, true, []]) expect(toTeardownView(t, raw), `${t} ${JSON.stringify(raw)}`).toEqual(UNREADABLE)
    }
  })
  it('記録が無い・オブジェクトでない → 同じ失敗。その場の読み方と同じ形', () => {
    for (const t of [DEDICATED, SHARED, HANAMII] as const) {
      for (const rec of [null, undefined, 'x', 5]) expect(resumedTeardownView(t, rec as never), `${t} ${JSON.stringify(rec)}`).toEqual(UNREADABLE)
    }
    expect(TEARDOWN_RESULT_UNREADABLE).toBe('結果を読み取れませんでした。コントロールパネルで、実際の状態を確かめてください。')
  })
  it('記録は読み直さずそのまま使う: 警告は記録の warnings のまま（extra の事実から作り足さない）、起きたことは lines のまま', () => {
    const v = resumedTeardownView(HANAMII, { ok: true, lines: ['x'], warnings: ['⚠️ 記録の警告'], extra: { keptBucketName: 'koto-a' }, message: 'm' })
    expect(v.warnings).toEqual(['⚠️ 記録の警告'])
    expect(v.executed).toEqual(['x'])
    expect(v.message).toBe('m')
  })
  it('extra が無い記録でも落ちない（失敗・残ったもの空）', () => {
    expect(resumedTeardownView(DEDICATED, { ok: false })).toMatchObject({ ok: false, state: 'failed', executed: [], remaining: [], inProgress: [], warnings: [], appDeleted: null, message: '' })
  })
})

describe('見出し・残ったもの・appDeleted: 公開先ごとの読み方', () => {
  it('専有型: 成功が先。ok:true なら、inProgress があっても done（手本の結果欄と同じ優先）', () => {
    expect(toTeardownView(DEDICATED, { ok: true, inProgress: { clusterID: 'c1' } }).state).toBe('done')
    expect(toTeardownView(DEDICATED, { ok: false, inProgress: { clusterID: 'c1' } }).state).toBe('inProgress')
    expect(toTeardownView(DEDICATED, { ok: false, inProgress: 'c1' }).state).toBe('failed') // オブジェクトでなければ途中とは読まない
  })
  it('途中で止まった（inProgress）は専有型だけの意味。HANAMII・共用型では見出しにも一覧にも使わない', () => {
    for (const t of [SHARED, HANAMII] as const) {
      const v = toTeardownView(t, { ok: false, inProgress: { clusterID: 'c1' } })
      expect(v.state).toBe('failed')
      expect(v.inProgress).toEqual([])
    }
  })
  it('appDeleted: 3つの破棄とも真偽値のときだけ通す（それ以外は null）。共用型も読む（段階2。以前は常に null）', () => {
    for (const t of [DEDICATED, SHARED, HANAMII] as const) {
      expect(toTeardownView(t, { ok: false, appDeleted: true }).appDeleted, t).toBe(true)
      expect(toTeardownView(t, { ok: false, appDeleted: false }).appDeleted, t).toBe(false)
      expect(toTeardownView(t, { ok: false, appDeleted: 'yes' }).appDeleted, t).toBeNull()
      expect(toTeardownView(t, { ok: false, appDeleted: 1 }).appDeleted, t).toBeNull()
      expect(toTeardownView(t, { ok: false }).appDeleted, t).toBeNull()
      // 記録（開き直し）からも同じ値を読む。EXTRA_KEYS が appDeleted を通す
      expect(twin(t, { ok: false, appDeleted: false, executed: [] }).resumed.appDeleted, `${t}（記録）`).toBe(false)
    }
  })
  it('共用型: 残った保存場所を「残ったもの」に入れるのは失敗の回だけ。成功の回・名前が null の回は入れない（旧い返り値の読み方のまま）', () => {
    expect(toTeardownView(SHARED, { ok: false, keptBucketName: 'b' }).remaining).toEqual([STORAGE('b')])
    expect(toTeardownView(SHARED, { ok: true, keptBucketName: 'b' }).remaining).toEqual([])
    expect(toTeardownView(SHARED, { ok: false, keptBucketName: null }).remaining).toEqual([])
  })
  it('共用型（段階2）: 残った保存場所は remainingBuckets を全件。無ければ remainingBucket。同じ名前は1つ。成功の回には入れない', () => {
    expect(labels(toTeardownView(SHARED, { ok: false, remainingBucket: 'a', remainingBuckets: ['a', 'b', 'c'] }).remaining)).toEqual(["保存場所『a』（月額が続きます）", "保存場所『b』（月額が続きます）", "保存場所『c』（月額が続きます）"])
    expect(toTeardownView(SHARED, { ok: false, remainingBucket: 'a' }).remaining).toEqual([STORAGE('a')])
    expect(toTeardownView(SHARED, { ok: false, remainingBucket: 'a', remainingBuckets: [] }).remaining).toEqual([STORAGE('a')])
    expect(toTeardownView(SHARED, { ok: false, remainingBuckets: ['a', 'a'] }).remaining).toEqual([STORAGE('a')])
    expect(toTeardownView(SHARED, { ok: true, remainingBucket: 'a', remainingBuckets: ['a', 'b'] }).remaining).toEqual([]) // 成功は「残ったもの」を作らない
    expect(toTeardownView(SHARED, { ok: 'true', remainingBuckets: ['a'] }).remaining).toEqual([STORAGE('a')]) // 不明な ok は失敗（残ったものを落とさない）
  })
  it('共用型: remainingBuckets があれば keptBucketName は一覧に混ぜない（残した保存場所は警告だけが言う）。どちらも無い旧い返り値だけ keptBucketName を1件', () => {
    const both = { ok: false, keptBucketName: 'kept', keptBucketNames: ['kept'], remainingBucket: 'left', remainingBuckets: ['left'] }
    expect(toTeardownView(SHARED, both).remaining).toEqual([STORAGE('left')])
    expect(toTeardownView(SHARED, { ok: false, keptBucketName: 'kept', remainingBuckets: [] }).remaining).toEqual([STORAGE('kept')]) // 空の配列は「無い」
    expect(toTeardownView(SHARED, { ok: false, keptBucketName: 'kept', remainingBuckets: 'left' }).remaining).toEqual([STORAGE('kept')]) // 配列でなければ読まない
    // 旧い記録を開き直しても、新しい返り値と同じ読み方で同じ見出し・同じ警告の文になる
    const old = twin(SHARED, { ok: false, executed: [], skipped: [], keptBucketName: 'kept', message: '失敗' })
    expect(old.resumed).toEqual(old.live)
    expect(old.live.remaining).toEqual([STORAGE('kept')])
    expect(old.live.warnings).toEqual(teardownRemainingWarnings({ keptBucketName: 'kept' }))
  })
  it('HANAMII: 残った保存場所は remainingBuckets を全件（1件だけにしない）。無ければ remainingBucket。同じ名前は1つ', () => {
    expect(labels(toTeardownView(HANAMII, { ok: false, remainingBucket: 'a', remainingBuckets: ['a', 'b', 'c'] }).remaining)).toEqual(["保存場所『a』（月額が続きます）", "保存場所『b』（月額が続きます）", "保存場所『c』（月額が続きます）"])
    expect(toTeardownView(HANAMII, { ok: false, remainingBucket: 'a' }).remaining).toEqual([STORAGE('a')])
    expect(toTeardownView(HANAMII, { ok: false, remainingBucket: 'a', remainingBuckets: [] }).remaining).toEqual([STORAGE('a')])
    expect(toTeardownView(HANAMII, { ok: false, remainingBuckets: ['a', 'a'] }).remaining).toEqual([STORAGE('a')])
  })
  it('専有型の ID は文字列で空でないものだけ拾う', () => {
    const v = toTeardownView(DEDICATED, { ok: false, remaining: { applicationID: '', loadBalancerID: 5, asgID: 'asg1', clusterID: null, storageBucket: '' } })
    expect(v.remaining).toEqual([SERVICE("オートスケーリンググループ『asg1』", true)])
  })
})

describe('まだ警告にしていない事実は、ここでも警告にしない（足すときは teardownWarningsOf に足し、summarizeResult はそれを呼ぶだけ）', () => {
  // 文の作り手は teardownWarningsOf 1つ（summarizeResult はそれを呼ぶ）。足すと、その場の画面と記録の両方に同時に効く。
  it('共用型の skipped は警告にならない（段階2で決めた。鍵の無効化の失敗は main が executed の ⚠️ の行にして返し、reportedLinesOf が警告へ移す）', () => {
    const raw = { ok: true, executed: [], skipped: ['保存場所のアクセスキーの無効化'], keptBucketName: null }
    expect(teardownWarningsOf(raw)).toEqual([])
    expect(twin(SHARED, raw).live.warnings).toEqual([])
    expect(twin(SHARED, raw).resumed).toEqual(twin(SHARED, raw).live)
  })
  it('★ 公開（cloud:apply）の skipped も警告にならない: summarizeResult はすべての処理の記録で teardownWarningsOf を呼ぶので、足すと「段階3で対応」の行まで警告になる', () => {
    // apply.ts の実際の文の形（`${a.description}: 段階3で対応`・`…: この操作には対応していません`）。公開の返り値は skipped を持つ
    const publish = {
      ok: true, executed: ['AppRun アプリ『myapp』を作成しました'], url: 'https://myapp.example.test',
      skipped: ['コンテナレジストリを作成: 段階3で対応', 'イメージを登録: この操作には対応していません'],
    }
    expect(teardownWarningsOf(publish)).toEqual([])
    expect(summarizeResult(publish).warnings).toEqual([])
    for (const t of [DEDICATED, SHARED, HANAMII] as const) expect(twin(t, publish).live.warnings, t).toEqual([])
    // 同じ返り値に、文で持っている警告があるときは、それだけが警告になる（skipped は混ざらない）
    expect(summarizeResult({ ...publish, warnings: [NEW_WARN] }).warnings).toEqual([NEW_WARN])
  })
  // V10（設計書 10.6.2 の 5・10.11.6）: 専有型の保存場所が2件以上で1件目で止まった回は、main が残りの全件を remainingBuckets で返す。
  // 読み手（画面の一覧 buildView・警告 teardownWarningsOf）は同じ dedicatedRemaining を通るので、一覧と警告の名前が食い違わず、
  // 記録（summarizeResult）から読み戻しても同じになる。専有型は remaining も返すが、保存場所を二重に言わない（HANAMII の読みは通らない）。
  it('★★★ 専有型の remainingBuckets は全件を読む: 一覧にも警告にも2件とも出る。summarizeResult の警告の文と同じ。同じ保存場所は二重に言わない', () => {
    const raw = { ok: false, appDeleted: true, executed: [], remaining: { storageBucket: 'koto-a' }, remainingBucket: 'koto-a', remainingBuckets: ['koto-a', 'koto-b'] }
    const { live, resumed } = twin(DEDICATED, raw)
    expect(live.remaining).toEqual([STORAGE('koto-a'), STORAGE('koto-b')])
    expect(teardownWarningsOf(raw)).toEqual(summarizeResult(raw).warnings)
    expect(live.warnings).toEqual([REMAINING_SENTENCE("保存場所『koto-a』（月額が続きます）・保存場所『koto-b』（月額が続きます）")])
    expect(resumed).toEqual(live)
  })
  it('専有型の remainingBuckets: 4つの ID の後ろに保存場所（全件）が並ぶ。同じ名前は1つ。remainingBuckets が空・無いときは remaining.storageBucket の1件', () => {
    const ids = { applicationID: 'app1', clusterID: 'c1' }
    const withIds = twin(DEDICATED, { ok: false, executed: [], remaining: { ...ids, storageBucket: 'koto-a' }, remainingBuckets: ['koto-a', 'koto-b', 'koto-a'] })
    expect(labels(withIds.live.remaining)).toEqual(["アプリケーション『app1』", "クラスタ『c1』", "保存場所『koto-a』（月額が続きます）", "保存場所『koto-b』（月額が続きます）"])
    expect(withIds.resumed).toEqual(withIds.live)
    // remainingBuckets があれば、それが保存場所の全件（remaining.storageBucket は足さない。HANAMII の `remainingBuckets` ＞ `remainingBucket` と同じ「どちらか」）
    const either = twin(DEDICATED, { ok: false, executed: [], remaining: { storageBucket: 'koto-x' }, remainingBuckets: ['koto-a', 'koto-b'] })
    expect(labels(either.live.remaining)).toEqual(["保存場所『koto-a』（月額が続きます）", "保存場所『koto-b』（月額が続きます）"])
    for (const remainingBuckets of [[], undefined, ['', 5, null]] as const) {
      const old = twin(DEDICATED, { ok: false, executed: [], remaining: { storageBucket: 'koto-a' }, remainingBuckets })
      expect(old.live.remaining, JSON.stringify(remainingBuckets)).toEqual([STORAGE('koto-a')])
      expect(old.resumed).toEqual(old.live)
    }
  })
  it('専有型: remaining が無い返り値（remainingBuckets だけ）でも、保存場所は一覧に出る。残った保存場所の警告は ok でないときだけ', () => {
    const only = twin(DEDICATED, { ok: false, executed: [], remainingBuckets: ['koto-a', 'koto-b'] })
    expect(labels(only.live.remaining)).toEqual(["保存場所『koto-a』（月額が続きます）", "保存場所『koto-b』（月額が続きます）"])
    const okRun = twin(DEDICATED, { ok: true, appDeleted: true, executed: [], remaining: {}, remainingBuckets: ['koto-a'] })
    expect(okRun.live.warnings).toEqual([])   // ok:true の回に「残っています」と言わない（既存の読み方のまま）
  })
})

describe('段ごとの時間: 専有型の返り値（stageTimings）と、記録の extra.stageTimings（finishOp が足す）から同じ値を読む', () => {
  const TIMINGS = { totalMs: 5000, stages: [{ stage: STAGE.teardownApp, ms: 3000 }, { stage: STAGE.teardownLb, ms: 2000 }] }
  const RAW = { ok: true, appDeleted: true, executed: [APP_LINE], message: DONE_MSG, remaining: {}, stageTimings: TIMINGS }

  it('その場: 返り値の stageTimings を読む。summarizeResult は返り値から写さない（記録側は finishOp が足す）ので、比べるときは外す', () => {
    const { live, resumed } = twin(DEDICATED, RAW)
    expect(live.stageTimings).toEqual(TIMINGS)
    expect(resumed.stageTimings).toBeNull()
    expect(noTimings(live)).toEqual(resumed)
  })
  it('開き直し: finishOp と同じに extra.stageTimings を足した記録から、その場と同じ値を読む', () => {
    const rec = summarizeResult(RAW)
    rec.extra.stageTimings = TIMINGS
    expect(resumedTeardownView(DEDICATED, rec)).toEqual(toTeardownView(DEDICATED, RAW))
  })
  it('無い・形が合わないときは null（測っていないものを作らない）', () => {
    expect(toTeardownView(DEDICATED, { ok: true }).stageTimings).toBeNull()
    expect(toTeardownView(DEDICATED, { ok: true, stageTimings: { totalMs: 'x', stages: 3 } }).stageTimings).toBeNull()
    expect(toTeardownView(HANAMII, { ok: true }).stageTimings).toBeNull()
    expect(toTeardownView(SHARED, { ok: true }).stageTimings).toBeNull()
  })
})

describe('本物の記録（withProjectLock → getOps）を通しても、その場と開き直しは同じ', () => {
  beforeEach(() => { resetProjectOpsForTests() })

  async function viaRealRecord(target: PublishTargetKind, handler: string, raw: Record<string, unknown>, stages: string[] = []) {
    const done = await withProjectLock(DIR, '削除', async () => {
      for (const s of stages) { stageReporter(DIR)(s); await new Promise<void>(r => setTimeout(r, 3)) }
      return raw
    }, { target: target as 'hanamii', handler })
    if (done.busy) throw new Error('別の操作が走っていた')
    // 専有型のハンドラは、返り値に stageTimings を足して画面へ返す（withStageTimings）。その場の画面が読むのはこの形
    const liveRaw = { ...(done.value as Record<string, unknown>), ...(done.stageTimings ? { stageTimings: done.stageTimings } : {}) }
    const rec = getOps(DIR).last?.result
    expect(rec, '終わった操作の結果が記録に無い').toBeTruthy()
    return { live: toTeardownView(target, liveRaw), resumed: resumedTeardownView(target, rec), done }
  }

  it('専有型（段の時間つき）: 見出し・残ったもの・警告・段の時間まで一致する', async () => {
    const raw = { ok: false, appDeleted: true, executed: [APP_LINE, KEY_WARN], message: 'x', remaining: { storageBucket: 'koto-data-x' } }
    const { live, resumed, done } = await viaRealRecord(DEDICATED, 'apprunDedicated:teardown', raw, [STAGE.teardownApp, STAGE.teardownStorage])
    expect(done.stageTimings?.stages.map(s => s.stage)).toEqual([STAGE.teardownApp, STAGE.teardownStorage])
    expect(live.stageTimings).not.toBeNull()
    expect(resumed).toEqual(live)
    expect(resumed.warnings[0]).toBe(KEY_WARN)
    expect(resumed.remaining).toEqual([STORAGE('koto-data-x')])
  })
  it('共用型・HANAMII（段の時間なし）', async () => {
    const shared = await viaRealRecord(SHARED, 'cloud:teardown', { ok: false, executed: [], skipped: [], keptBucketName: 'koto-myapp-data', message: '失敗' })
    expect(shared.resumed).toEqual(shared.live)
    expect(shared.resumed.remaining).toEqual([STORAGE('koto-myapp-data')])
    resetProjectOpsForTests()
    const hanamii = await viaRealRecord(HANAMII, 'hanamii:teardown', { ok: true, appDeleted: true, executed: [STORAGE_DONE_LINE], keptBucketName: 'koto-a', keptBucketNames: ['koto-a'] })
    expect(hanamii.resumed).toEqual(hanamii.live)
    expect(hanamii.resumed.warnings).toHaveLength(1)
  })
})
