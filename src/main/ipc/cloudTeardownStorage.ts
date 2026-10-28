// cloudTeardownStorage.ts — 共用型の破棄（cloud:teardown）の「保存場所の段」と、その失敗の返り値の組み立て。
// cloudTeardown.ts から切り出した（0.6.24 R1-a。400 行の決まり。振る舞いは変えていない）。呼ぶのは cloudTeardown.ts の run の1か所だけ。
//
// ── 段の中身 ─────────────────────────────────────────────────────────────────
// ・保存場所が1件以上: `teardownStorageForProject` へ渡す。消すのは確認で見せた保存場所（名前と prefix の組）だけ。見せていないものは消さず、残りに数える（0.6.24 F）。
// ・保存場所が0件で記録の鍵がある: その鍵だけ無効にする（残すと、消えた保存場所へ読み書きできる鍵が辿れないまま生き残る）。
// 保存場所の判断は cloud/storageTeardown.ts → shared/objectStorage.ts の1つ。ここに条件を書かない（掟10）。
//
// ── 名前による鍵の一括の無効化（sweep）──────────────────────────────────────────
// 渡すのは「アプリがあった回」と「前の回が一括の無効化を果たさずに止まった回（印 `meta.keySweepPending`）」だけ。アプリが無い回（保存場所だけ・幽霊の行）には、
// 同じ名前で公開中の別プロジェクトの現役の鍵を無効にしうるので渡さない（docs/teardown-unify-plan.md 10.7.3 の「鍵」(b)）。
// 1回目にアプリが消え、この段が最後まで済まずに止まると、押し直しの回は state にアプリが無い＝一括の無効化が永久に走らない。
// そこで、**渡す条件が真なのに、この段が `ok:false`（見せていない分・途中の失敗）か例外で終わった回**は、印を記録へ立てる。
// 印は失敗の保存（`stateToSave({ ok:false })` は state をそのまま残す）に乗る。最後まで済んだ回は `stateAfterTeardown` が meta を作り直すので、印は自然に消える。
import type { CloudCredentials } from '../cloud/auth'
import { createStorageAdapter } from '../cloud/storageAdapter'
import { KEY_REVOKE_FAILED_WARNING, keyWarningLines, keyKeptWarning, recordedKeyRisk } from '../cloud/storageTeardown'
import { forgetDeletedBuckets, keptBucketReasonFields, teardownStorageForProject } from '../cloud/storageForTarget'
import type { EnvState } from '../cloud/state'
import type { StoragePlacement } from '../../shared/objectStorage'
import { STORAGE_TEARDOWN_PROGRESS, STORAGE_PANEL_DELETE_GUIDE, storageTeardownDoneLine, bucketNamesText } from '../../shared/teardownSupport'

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export const SAVE_FAILED_NOTE = '記録を保存できませんでした。もう一度 🗑 破棄を押すと続きからやり直せます。'
const ENV_KEPT_NOTE = '⚠️ 保存場所の記録（公開の設定・env.json）は残しています。次に公開する前に、【公開】の「保存場所を用意する」からやり直してください'
const PANEL_GUIDE = `消えないときは、${STORAGE_PANEL_DELETE_GUIDE}`

/** 保存場所の段が止まったときの事実（`storageFailureFields` が返り値の文にする）。 */
export type StorageStageFailure = { remaining: string[]; first: string; message: string; skipped?: string[] }

export type StorageStageIn = {
  creds: CloudCredentials
  projectDir: string
  /** 消す保存場所の候補の全件（`sharedTeardownRecordOf` の `placements`。実際に消すのは確認で見せたものだけ）と、そのうち env.json に無く state にだけあるバケット名。 */
  placements: StoragePlacement[]
  stateOnlyBuckets: string[]
  /** run の前の state にアプリがあったか（一括の無効化を渡す条件の1つ）。 */
  hadApp: boolean
  /** いまの記録（アプリ・レジストリの段を済ませたもの）。前の回が立てた印もここから読む。 */
  cur: EnvState
  /** 記録の鍵（`state.meta.storagePermissionId`）。 */
  recordedKey: string | null
  /** 鍵を無効にできなかった行に添える案内。 */
  keyGuide: string
  /** 画面が運んだ「確認で見せた保存場所」（形は信用しない。`teardownStorageForProject` が読む）。キーごと渡す。 */
  shown: unknown
  progress: (message: string) => void
}

export type StorageStageOut = {
  /** 段のあとの記録（消えたバケット・外せた鍵の ID を反映し、止まった回は一括の無効化の印を立てたもの）。 */
  cur: EnvState
  /** 結果の `executed` へ足す行（順序つき）。 */
  lines: string[]
  kept: string[]
  keptWhy: ReturnType<typeof keptBucketReasonFields>
  /** このプロジェクトのデータを実際に消した保存場所が1件でもあるか（複製が同じ prefix を持つため残した回〔keptData〕は数えない）。 */
  dataDeleted: boolean
  /** 記録に残す鍵の ID（無効にできて外した回は null）。 */
  keyKept: string | null
  failure: StorageStageFailure | null
}

/** 保存場所0件で記録の鍵だけがあるとき、その鍵を無効にする。失敗は文で返す（null＝無効にできた）。 */
async function revokeRecordedKey(creds: CloudCredentials, permissionId: string): Promise<string | null> {
  try {
    const storage = await createStorageAdapter(creds)
    try { await storage.deletePermission(permissionId) } finally { await storage.dispose() }
    return null
  } catch (e) {
    return `${KEY_REVOKE_FAILED_WARNING}: ${msgOf(e)}`
  }
}

/** 名前による鍵の一括の無効化を果たす責任がある回か（アプリがあった回、または前の回が果たさずに止まった印がある回）。 */
const sweepOwedBy = (hadApp: boolean, state: EnvState): boolean => hadApp || state.meta?.keySweepPending === 'apprun'

/** 3. 保存場所。候補は env.json の同意済み全件 + state にだけあるもの。そのうち確認で見せたものを、最後に消す。 */
export async function runStorageStage(i: StorageStageIn): Promise<StorageStageOut> {
  const { creds, projectDir, placements, hadApp, recordedKey, keyGuide } = i
  const owed = sweepOwedBy(hadApp, i.cur)
  const names = placements.map(p => p.bucket)
  const lines: string[] = []
  let cur = i.cur
  let kept: string[] = []
  let keptWhy: ReturnType<typeof keptBucketReasonFields> = {}
  let dataDeleted = false
  let keyKept: string | null = recordedKey
  let failure: StorageStageFailure | null = null
  if (placements.length > 0) {
    i.progress(STORAGE_TEARDOWN_PROGRESS)
    try {
      // 消すのは、確認で見せた保存場所（名前と prefix の組）だけ。見せていないものは main が消さず、残りに数える（0.6.24 F）。キーごと渡す（値が無くても「見せていない」扱い）
      const st = await teardownStorageForProject({ creds, projectDir, permissionId: recordedKey, sweepKeysFor: owed ? 'apprun' : null, placements, shown: i.shown })
      if (st.reason !== 'none') {
        dataDeleted = st.done.some(b => !b.keptData)
        lines.push(...st.done.map(b => storageTeardownDoneLine(b.bucket, b.note, b.keptData)), ...keyWarningLines(st.warnings, keyGuide))
        kept = st.done.filter(b => !b.deletedBucket).map(b => b.bucket)
        keptWhy = keptBucketReasonFields(st.done)
        const gone = st.done.filter(b => b.deletedBucket).map(b => b.bucket)
        cur = { ...cur, resources: cur.resources.filter(r => !(r.kind === 'bucket' && gone.includes(r.id))) }
        // 消したバケットの宛先は env.json からも外す（HANAMII・専有型と同じ）。env.json に無い（state にだけある）分は外すものが無い
        const inEnv = gone.filter(b => !i.stateOnlyBuckets.includes(b))
        if (inEnv.length > 0 && !forgetDeletedBuckets(projectDir, inEnv)) lines.push(ENV_KEPT_NOTE)
        // 記録の鍵は、実際に無効にできた（`permissionRevoked`）ときだけ記録から外す。複製（かもしれない）回は無効にしていないので残る（0.6.24 R1-c）
        if (recordedKey && st.permissionRevoked) {
          keyKept = null
          cur = { ...cur, meta: { ...cur.meta, storagePermissionId: undefined } }
        }
        if (!st.ok) failure = { remaining: st.remainingBuckets, first: st.remainingBucket, message: st.message, skipped: st.skippedBuckets }
      }
    } catch (e) {
      failure = { remaining: names, first: names[0], message: `保存場所${bucketNamesText(names)}を削除できませんでした: ${msgOf(e)}` }
    }
  } else if (recordedKey) {
    // 保存場所が0件でも、記録の鍵は無効にする（残すと、消えた保存場所へ読み書きできる鍵がどこからも辿れないまま生き残る）。
    // **ただし、同じ鍵の ID を記録に持つ兄弟がいる（または確かめられない）回は無効にしない**（複製が記録の鍵の ID だけを写した形。無効にすると元の現役の鍵が切れる。0.6.24 R2-i）。
    // 無効にしない回は、鍵の ID を記録に残し（keyKept のまま）、結果に警告を出す（黙って残さない。R3-c）
    const keyRisk = recordedKeyRisk(projectDir, recordedKey)
    if (keyRisk !== null) {
      lines.push(...keyWarningLines([keyKeptWarning(keyRisk)], keyGuide))
    } else {
      i.progress(STORAGE_TEARDOWN_PROGRESS)
      const why = await revokeRecordedKey(creds, recordedKey)
      if (why) lines.push(...keyWarningLines([why], keyGuide))
      else { keyKept = null; cur = { ...cur, meta: { ...cur.meta, storagePermissionId: undefined } } }
    }
  }
  // 一括の無効化を果たす責任がある回が、果たさずに止まった（見せていない分・途中の失敗・例外）。押し直しで果たせるよう、印を立てる（アプリが無く印も無い回には立てない）
  if (failure && owed) cur = { ...cur, meta: { ...cur.meta, keySweepPending: 'apprun' } }
  return { cur, lines, kept, keptWhy, dataDeleted, keyKept, failure }
}

/**
 * 保存場所の段が止まった回の返り値のうち、残った保存場所と文の部分（`ok`・`executed` などは呼び手が足す）。
 * `registryRemains`: 記録にコンテナレジストリが残っているか（残っていれば、押し直しでレジストリを消すかの選択も出る）。`saveFailed`: 記録を保存できなかったか。
 */
export function storageFailureFields(
  failure: StorageStageFailure,
  o: { registryRemains: boolean; saveFailed: boolean },
): { remainingBucket: string; remainingBuckets: string[]; skippedBuckets?: string[]; message: string } {
  const retry = o.registryRemains
    ? 'もう一度 🗑 破棄を押すと、保存場所の削除をやり直せます（コンテナレジストリを消すかどうかの選択も、もう一度出ます）。'
    : 'もう一度 🗑 破棄を押すと、保存場所の削除だけをやり直します。'
  return {
    remainingBucket: failure.first, remainingBuckets: failure.remaining, ...(failure.skipped ? { skippedBuckets: failure.skipped } : {}),
    message: `${failure.message}\n保存場所${bucketNamesText(failure.remaining)}が残っています（消すまで月額が続きます）。${retry}${PANEL_GUIDE}`
      + (o.saveFailed ? `\n${SAVE_FAILED_NOTE}` : ''),
  }
}
