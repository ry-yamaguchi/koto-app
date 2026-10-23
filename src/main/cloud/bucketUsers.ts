// bucketUsers.ts — あるバケット（保存場所）を、ほかのどのプロジェクトが使っているか。**プロジェクトの記録から読む**（読むだけ・外へ要求を出さない・何も書かない）。
//
// ── なぜ要るのか（2026-10-21 実機・0.6.22-rc.3）────────────────────────────────────
// バケットごと消してよいかは、これまで**バケットの中のキーの一覧だけ**で決めていた（teardownPlanFor）。一覧に出るのは、オブジェクトが1つ以上ある prefix だけ。
// 共用の保存場所を使う2つのプロジェクトのうち、片方（HANAMII の破棄が目印 .koto-keep ごと prefix を消した）が一覧から消えると、
// もう片方（共用型 AppRun で公開中・env.json に同意済みで残っている）を「ほかに使う人はいない」と読み、**別のプロジェクトの削除がバケットごと消した**。
// 保存場所は同じ名前を同じ月のうちは作り直せない（さくらの仕様）ので、公開中のアプリが使うデータが戻らない。
// 9/24 より前に用意したプロジェクトは目印も無く、一覧には最初から出ない（10/1 に koto-data-6luf0k が消えたのと同じ形）。
//
// ── どこまで見るか（registryUsers.ts と同じ歩き方）─────────────────────────────────────
// そのプロジェクトと同じ親フォルダの、直下のプロジェクトだけ（隠しフォルダは見ない・自分は数えない）。見るのは3つ:
//   ・`.sakura-cloud/env.json` の `persistence.objectStorage` … **同意済み**（consentedAt あり）で、バケット名が一致するもの
//     （読み方は `consentedPlacementsOf` の1つ。確認の材料・破棄が消すものと同じ）
//   ・`.sakura-cloud/state.json` の `resources` … kind が bucket で、id が一致するもの（env.json から外したあとも、公開が作ったバケットは state に残る）
//   ・公開の記録 … 兄弟が**まだ公開している**か（下）
// 「使っている」と数えるのは、**同じバケットを使う設定（上の2つのどちらか）があり、かつ公開の記録がまだある**ときだけ。
//
// ── なぜ設定だけでは数えないのか（2026-10-21 のうちに見つかった、直前の守りの回帰）──────────────────────
// 共用型・HANAMII・専有型の破棄は、ほかが使うので残したバケットを env.json と state.json に**残す**（設定から外さない作り）。
// 設定に書いてあるだけで数えると、同じ保存場所 S を使う A・B を順に破棄したとき、A の破棄は B を、B の破棄は**破棄済みの A** を使用者と読み、
// S は誰にも消せず月額が続く（結果は「ほかのプロジェクトも使っています」と言い続ける）。この守りの前は、最後の破棄で消えていた。
// 公開の記録（📡 の行）は、破棄が済むと消える。だから「公開の記録がまだある」を条件にする。
//   ・公開の記録 … `.sakuraide.json` の `publish.targets` に、保存場所を使う公開先（共用型 sakura-apprun・HANAMII hanamii・専有型 sakura-apprun-dedicated・
//     Vercel vercel）の行が1つ以上ある。旧い記録（targets が無かった頃）の救済も、📡 の一覧（buildPublishStatusRows）と同じに数える:
//     `publish.hanamii.projectId` がある・`state.json` の `resources` に apprun-app がある。
//     `.sakuraide.json` を読むのは `publishMetaFs.ts` の `readMetaFs`、行があるかの見方は `shared/publishMeta.ts` の `hasPublishRecordInMeta`（どちらも既存の1つ）。
//   ・公開していない「用意しただけ」の兄弟は、ここでは数えない。バケットの中の目印（`projects/<名前>/.koto-keep`）が、キーの一覧に出て数えられる
//     （`teardownPlanFor` の判断のまま）。
//   ・**残る穴**: 目印の無い古い「用意しただけ」（9/24 より前に用意して、一度も公開していない）は、ここでもキーの一覧でも見えない。
//
// ── 読めなかったら「わからない」（known:false）──────────────────────────────────────
// 「いない」に倒さない。親フォルダの一覧を読めなかった・兄弟の記録が JSON として読めない・形が想定と違う・たどれないシンボリックリンクがある、のどれでも、
// 使っているかどうかは確かめられていない。わからないときは、呼び手（teardownPlanFor）が**バケットを消さない**。
// 無いだけ（ENOENT）は、その兄弟が保存場所を使っていない（公開もしていない）ということなので、読めなかったことにはしない。
// **ENOENT 以外の例外は、すべて「わからない」**（権限・ディレクトリだった・たどれないリンク・壊れた JSON。握りつぶして「プロジェクトではない」としない）。
import * as fs from 'fs'
import * as path from 'path'
import { CLOUD_DIR, CLOUD_ENV_FILE, CLOUD_STATE_FILE } from './specStore'
import { consentedPlacementsOf, type BucketRecordUsers } from '../../shared/objectStorage'
import { hasPublishRecordInMeta, type PublishTargetKind } from '../../shared/publishMeta'
import { readMetaFs, type MetaRead } from '../publishMetaFs'

/** 記録ファイル1つの読み結果。`missing` はファイルが無いだけ（ENOENT。保存場所を使っていない・公開していない）、`unreadable` は読めない・壊れている。 */
export type RecordRead = MetaRead

/**
 * 公開の記録に行があれば「保存場所を使う公開をしている」と数える公開先（書き下す。掟10）: 共用型・HANAMII・専有型・Vercel。
 * レンタルサーバ（sakura-rental）は保存場所を使わないので入れない。
 */
export const STORAGE_PUBLISH_TARGETS: readonly PublishTargetKind[] = ['sakura-apprun', 'hanamii', 'sakura-apprun-dedicated', 'vercel']

/** 兄弟1つの記録が、そのバケットを使っているか。 */
export type SiblingUse = 'uses' | 'not' | 'unknown'

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** env.json の読み結果から: 同意済みの保存場所にそのバケットがあるか。 */
function envUse(read: RecordRead, bucket: string): SiblingUse {
  if (read.kind === 'missing') return 'not'
  if (read.kind === 'unreadable') return 'unknown'
  const v = read.value
  if (!isObject(v)) return 'unknown'
  if (v.persistence === undefined) return 'not'
  if (!isObject(v.persistence)) return 'unknown'
  const list = v.persistence.objectStorage
  if (list === undefined) return 'not'
  if (!Array.isArray(list)) return 'unknown'
  // 同意済みの読み方は共用型の破棄・確認の材料と同じ1つ（consentedPlacementsOf）
  return consentedPlacementsOf(list).some(p => p.bucket === bucket) ? 'uses' : 'not'
}

/** state.json の読み結果から: bucket 資源にそのバケットがあるか。 */
function stateUse(read: RecordRead, bucket: string): SiblingUse {
  if (read.kind === 'missing') return 'not'
  if (read.kind === 'unreadable') return 'unknown'
  const v = read.value
  if (!isObject(v)) return 'unknown'
  if (v.resources === undefined) return 'not'
  if (!Array.isArray(v.resources)) return 'unknown'
  return v.resources.some(r => isObject(r) && r.kind === 'bucket' && r.id === bucket) ? 'uses' : 'not'
}

/** 公開の記録がまだあるか。`unknown` は読めない・形が想定と違う（あるともないとも言えない）。 */
type Published = 'yes' | 'no' | 'unknown'

/** `.sakuraide.json` の読み結果から: 保存場所を使う公開先の行があるか（旧い記録の hanamii.projectId も、📡 の一覧と同じく行と数える）。 */
function metaPublished(read: RecordRead): Published {
  if (read.kind === 'missing') return 'no'
  if (read.kind === 'unreadable') return 'unknown'
  const v = read.value
  if (!isObject(v)) return 'unknown'
  if (v.publish === undefined) return 'no'
  if (!isObject(v.publish)) return 'unknown'
  if (v.publish.targets !== undefined && !isObject(v.publish.targets)) return 'unknown'
  if (STORAGE_PUBLISH_TARGETS.some(t => hasPublishRecordInMeta(v, t))) return 'yes'
  // targets が無かった頃の記録: HANAMII のプロジェクトを作った印（buildPublishStatusRows の救済 (a) と同じ）
  const projectId = isObject(v.publish.hanamii) ? v.publish.hanamii.projectId : undefined
  return typeof projectId === 'string' && projectId !== '' ? 'yes' : 'no'
}

/** `state.json` の読み結果から: 公開したアプリ（apprun-app 資源）があるか（旧い記録の救済。buildPublishStatusRows の (c) と同じ）。 */
function stateHasApp(read: RecordRead): Published {
  if (read.kind === 'missing') return 'no'
  if (read.kind === 'unreadable') return 'unknown'
  const v = read.value
  if (!isObject(v)) return 'unknown'
  if (v.resources === undefined) return 'no'
  if (!Array.isArray(v.resources)) return 'unknown'
  return v.resources.some(r => isObject(r) && r.kind === 'apprun-app') ? 'yes' : 'no'
}

/** 公開の記録がまだあるか: どちらかが「ある」ならある。ないとは言えず、どちらかが読めなければ「わからない」。 */
function publishedOf(meta: RecordRead, state: RecordRead): Published {
  const a = metaPublished(meta)
  const b = stateHasApp(state)
  if (a === 'yes' || b === 'yes') return 'yes'
  if (a === 'unknown' || b === 'unknown') return 'unknown'
  return 'no'
}

/**
 * 兄弟1つの3つの記録から、そのバケットを**いま使っている**かを決める（純関数）。
 *
 * 1. 同じバケットを使う設定があるか: env.json（同意済み）か state.json（bucket 資源）のどちらかが使っていれば「ある」（もう一方が読めなくても）。
 *    どちらも使っているとは言えず、どちらかが読めなければ `unknown`。どちらも使っていなければ `not`。
 * 2. 設定があれば、**公開の記録がまだあるときだけ** `uses`（`publishedOf`）。公開の記録が無い（破棄が済んだ・一度も公開していない）なら `not`
 *    （一度も公開していない「用意しただけ」の兄弟は、バケットの中の目印がキーの一覧に出て数えられる）。公開の記録を読めなければ `unknown`。
 *
 * @param meta 兄弟の `.sakuraide.json`（公開の記録）。**公開の記録を見ずに設定だけで数えると、破棄済みのプロジェクトを使用者と読み、最後の破棄でバケットが消えなくなる**。
 */
export function siblingUseOfBucket(env: RecordRead, state: RecordRead, meta: RecordRead, bucket: string): SiblingUse {
  const a = envUse(env, bucket)
  const b = stateUse(state, bucket)
  if (a !== 'uses' && b !== 'uses') return a === 'unknown' || b === 'unknown' ? 'unknown' : 'not'
  const published = publishedOf(meta, state)
  return published === 'yes' ? 'uses' : published === 'unknown' ? 'unknown' : 'not'
}

function readRecord(file: string): RecordRead {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf-8')
  } catch (e) {
    return (e as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable' }
  }
  try {
    return { kind: 'ok', value: JSON.parse(text) }
  } catch {
    return { kind: 'unreadable' } // 壊れている
  }
}

/** 親フォルダの直下の1つが、プロジェクトのフォルダか。`unknown` はリンクをたどれない（先が無い・権限・ループ）——プロジェクトではないと決めつけない。 */
type EntryKind = 'dir' | 'other' | 'unknown'

/**
 * ディレクトリか。シンボリックリンクはリンク先を見る（リンクされたプロジェクトも兄弟）。
 * **たどれないリンクは `unknown`**（使っているプロジェクトが、外付けのドライブの外れた先・権限の無い先にあるかもしれない。以前は握りつぶして「プロジェクトではない」としていた）。
 * リンクそのものが無い（読み出しと確認のあいだに消えた）ときも、リンクが見えている以上は同じ `unknown`（消す側に倒さない）。
 */
function entryKind(workspace: string, e: fs.Dirent): EntryKind {
  if (e.isDirectory()) return 'dir'
  if (!e.isSymbolicLink()) return 'other'
  try { return fs.statSync(path.join(workspace, e.name)).isDirectory() ? 'dir' : 'other' } catch { return 'unknown' }
}

/**
 * `projectDir` 以外のプロジェクトで、`bucket` を使っているものの名前（フォルダ名・文字コード順）を、記録から読む。**投げない。**
 * 読めなかったときは `{ known: false }`（理由を持たない。呼び手が「消さない」に倒す）。
 * 使っているプロジェクトが1つでも見つかれば、ほかの兄弟が読めなくても `known: true`（使っているという事実は動かない）。
 */
export function bucketUsersFromRecords(projectDir: string, bucket: string): BucketRecordUsers {
  try {
    // 絶対パスでなければ、親フォルダが決まらない（空文字は path.resolve で作業中のフォルダになる）。確かめられない
    if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) return { known: false }
    if (typeof bucket !== 'string' || bucket === '') return { known: false }
    const self = path.resolve(projectDir)
    const workspace = path.dirname(self)
    const entries = fs.readdirSync(workspace, { withFileTypes: true })
    const users: string[] = []
    let unknown = 0
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const dir = path.join(workspace, e.name)
      if (dir === self) continue // 自分自身の記録は数えない
      const kind = entryKind(workspace, e)
      if (kind === 'other') continue
      if (kind === 'unknown') { unknown++; continue } // たどれないリンクは、使っているかわからない
      const use = siblingUseOfBucket(
        readRecord(path.join(dir, CLOUD_DIR, CLOUD_ENV_FILE)),
        readRecord(path.join(dir, CLOUD_DIR, CLOUD_STATE_FILE)),
        readMetaFs(dir),
        bucket,
      )
      if (use === 'uses') users.push(e.name)
      else if (use === 'unknown') unknown++
    }
    if (users.length > 0) return { known: true, users: users.sort() } // 文字コード順（実行する環境の言語設定で並びが変わらない）
    return unknown > 0 ? { known: false } : { known: true, users: [] }
  } catch {
    return { known: false } // 親フォルダの一覧を読めなかった
  }
}
