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
// ── 同じ prefix の兄弟（`samePrefix`・0.6.24 I-1）──────────────────────────────────────
// 「使っている」とは別に、兄弟のうち**同じバケットの同じ prefix を記録に持つ**もの（フォルダを複製したときにできる）の名前も返す。
// 複製のどちらかを破棄・削除すると、**もう一方のデータが prefix ごと消える**（元に戻せない）。`teardownPlanFor` は samePrefix が1件でもあれば、
// データにもバケットにも手を付けない。
//   ・**公開の記録の有無は問わない**（元が「用意しただけ」で公開していなくても、データは複製と同じ場所にある。上の「使っている」の条件とは別）
//   ・数えるのは: env.json の同意済みで、同じバケット・同じ prefix ／ state.json の bucket 資源で、同じ id・同じ prefix
//   ・prefix が空（`''`）のときは同じと数えない（専用バケットの中を丸ごと指す意味になり、複製かどうかを prefix からは言えない）
//   ・**読めた記録で確かめられたものだけ**を数える（読めない・壊れている・形が違う兄弟は `samePrefix` には数えない）
//   ・`known: false` の回も、見つかった分は返す（一部の兄弟を読めなくても、見つかった複製の事実は動かない）
//
// ── 複製かどうか確かめられなかった兄弟（`samePrefixUnread`・`samePrefixChecked`・0.6.24 R1-b・作者の決定 K3）─────────────
// 読めない兄弟は、複製かもしれない（複製なら、破棄が元のデータを prefix ごと消す）。そういう兄弟の名前を `samePrefixUnread` に返し、
// 呼び手（`twinRiskOf` → `teardownPlanFor`）が、データにもバケットにも鍵にも手を付けない側に倒す。
//   ・確かめられなかった兄弟 = たどれないリンク／env.json か state.json が ENOENT 以外で読めない・壊れている・形が違う（`envUse`・`stateUse` が `unknown` を返すもの）
//   ・**`.sakuraide.json` だけが読めない兄弟は入れない**（env と state が読めれば、複製かどうかは確かめられている。使っているかわからない＝`known: false` のまま）
//   ・`samePrefixChecked` … 確かめ自体ができたか。絶対パスでない・バケット名が空・prefix が文字列でない・親フォルダの一覧を読めない回は false
//   ・prefix が空の回は複製を言えない（確かめる対象が無い）ので、`samePrefixUnread` は空
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

/**
 * env.json の読み結果から: 同意済みの保存場所に、**同じバケット・同じ prefix**があるか。読めない・形が違うときは false（確かめられたものだけ数える）。
 * prefix が空なら常に false。比べるのは文字列の完全一致（prefix の読み方は `consentedPlacementsOf` の1つ）。
 */
function envSamePrefix(read: RecordRead, bucket: string, prefix: string): boolean {
  if (prefix === '' || read.kind !== 'ok') return false
  const v = read.value
  if (!isObject(v) || !isObject(v.persistence) || !Array.isArray(v.persistence.objectStorage)) return false
  return consentedPlacementsOf(v.persistence.objectStorage).some(p => p.bucket === bucket && p.prefix === prefix)
}

/** state.json の読み結果から: bucket 資源に、**同じ id・同じ prefix**があるか。読めない・形が違うときは false。prefix が空なら常に false。 */
function stateSamePrefix(read: RecordRead, bucket: string, prefix: string): boolean {
  if (prefix === '' || read.kind !== 'ok') return false
  const v = read.value
  if (!isObject(v) || !Array.isArray(v.resources)) return false
  return v.resources.some(r => isObject(r) && r.kind === 'bucket' && r.id === bucket && r.prefix === prefix)
}

/**
 * 兄弟1つの記録が、そのバケットの**同じ prefix**を持っているか（純関数）。公開の記録は見ない（元が「用意しただけ」でも数える）。
 * env.json と state.json のどちらか一方でも持っていれば true。
 */
export function siblingHasSamePrefix(env: RecordRead, state: RecordRead, bucket: string, prefix: string): boolean {
  return envSamePrefix(env, bucket, prefix) || stateSamePrefix(state, bucket, prefix)
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

/** 記録ファイル1つを読む（無い＝missing・読めない／壊れている＝unreadable。投げない）。複製の確かめ（`recordTwins.ts`）も、兄弟の記録をこれで読む。 */
export function readRecord(file: string): RecordRead {
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

/**
 * 2つのパスが**同じフォルダ**か（0.6.24 R2-b）。`dev` と `ino` で比べる（リンクは辿る。大文字小文字だけ違うパス・NFC/NFD の違いも、同じ実体なら同じ）。
 * **どちらかの stat が失敗したら false**（別と読む）。文字列の一致は呼び手が別に見る（`a === b || isSameDirFs(a, b)`）。投げない。
 * 兄弟を歩く3つ——`recordTwins.ts`・`bucketUsers.ts`（この下）・`registryUsers.ts`——が「自分」を除くのに、フォルダ名の文字列の比べ方だけだと、
 * 自分を指すリンク・APFS で大文字小文字だけ違うパスで、自分を複製・使用者と数える。
 */
export function isSameDirFs(a: string, b: string): boolean {
  try {
    return isSameDirStat(fs.statSync(a), fs.statSync(b))
  } catch {
    return false
  }
}

/** `isSameDirStat` が見る stat の部分（`fs.Stats` の一部。BigInt の stat も同じ形）。 */
export type DirStatLike = { dev: number | bigint; ino: number | bigint; isDirectory(): boolean }

/**
 * 2つの stat が**同じフォルダ**か（0.6.24 R3-f。`isSameDirFs` の比べる部分を、fs に触れない純関数に切り出した）。**両方がフォルダで、`dev` と `ino` がどちらも等しい**ときだけ true。
 * `dev` が違えば、`ino` が同じでも別のフォルダ（別のボリュームの inode 番号は重なりうる）。表で固定する（tests/isSameDirStat.test.ts）。
 */
export function isSameDirStat(x: DirStatLike, y: DirStatLike): boolean {
  return x.isDirectory() && y.isDirectory() && x.dev === y.dev && x.ino === y.ino
}

/** 親フォルダの直下の1つが、プロジェクトのフォルダか。`unknown` はリンクをたどれない（先が無い・権限・ループ）——プロジェクトではないと決めつけない。 */
export type EntryKind = 'dir' | 'other' | 'unknown'

/**
 * ディレクトリか。シンボリックリンクはリンク先を見る（リンクされたプロジェクトも兄弟）。
 * **たどれないリンクは `unknown`**（使っているプロジェクトが、外付けのドライブの外れた先・権限の無い先にあるかもしれない。以前は握りつぶして「プロジェクトではない」としていた）。
 * リンクそのものが無い（読み出しと確認のあいだに消えた）ときも、リンクが見えている以上は同じ `unknown`（消す側に倒さない）。
 */
export function entryKind(workspace: string, e: fs.Dirent): EntryKind {
  if (e.isDirectory()) return 'dir'
  if (!e.isSymbolicLink()) return 'other'
  try { return fs.statSync(path.join(workspace, e.name)).isDirectory() ? 'dir' : 'other' } catch { return 'unknown' }
}

/**
 * `projectDir` 以外のプロジェクトで、`bucket` を使っているものの名前（フォルダ名・文字コード順）を、記録から読む。**投げない。**
 * 読めなかったときは `{ known: false }`（理由を持たない。呼び手が「消さない」に倒す）。
 * 使っているプロジェクトが1つでも見つかれば、ほかの兄弟が読めなくても `known: true`（使っているという事実は動かない）。
 *
 * 複製の確かめ（0.6.24 R1-b）も、どちらの形にも返す: `samePrefix`（見つかった複製）・`samePrefixUnread`（複製かどうかを確かめられなかった兄弟）・
 * `samePrefixChecked`（確かめ自体ができたか）。「確かめられなかった」= たどれないリンク／env.json か state.json が ENOENT 以外で読めない・壊れている・形が違う
 * （`envUse`・`stateUse` が `unknown` を返すもの。`siblingUseOfBucket` の「わからない」より狭い: そちらは `.sakuraide.json` も見る）。**`.sakuraide.json` だけが読めない兄弟は入れない**。
 * prefix が空の回は複製を言えない（確かめる対象が無い）ので、`samePrefixUnread` は空・`samePrefixChecked` は親フォルダの一覧を読めたかのまま。
 */
export function bucketUsersFromRecords(projectDir: string, bucket: string, prefix: string): BucketRecordUsers {
  // 見つかった複製・確かめられなかった兄弟は、途中で例外になっても返す（見つかった事実は動かない）
  const samePrefix: string[] = []
  const samePrefixUnread: string[] = []
  try {
    // 絶対パスでなければ、親フォルダが決まらない（空文字は path.resolve で作業中のフォルダになる）。確かめられない
    if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) return { known: false, samePrefix, samePrefixUnread, samePrefixChecked: false }
    if (typeof bucket !== 'string' || bucket === '') return { known: false, samePrefix, samePrefixUnread, samePrefixChecked: false }
    // prefix の渡し忘れ（文字列でない）も確かめられない（複製の有無を言えない＝バケットを消さない側へ倒す）。空文字は「prefix なし」で、複製とは数えない
    if (typeof prefix !== 'string') return { known: false, samePrefix, samePrefixUnread, samePrefixChecked: false }
    const self = path.resolve(projectDir)
    const workspace = path.dirname(self)
    const entries = fs.readdirSync(workspace, { withFileTypes: true })
    const users: string[] = []
    let unknown = 0
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const dir = path.join(workspace, e.name)
      if (dir === self || isSameDirFs(dir, self)) continue // 自分自身の記録は数えない（文字列が違っても、同じフォルダ〔リンク・大文字小文字・NFC/NFD〕は自分。R2-b）
      const kind = entryKind(workspace, e)
      if (kind === 'other') continue
      if (kind === 'unknown') { unknown++; if (prefix !== '') samePrefixUnread.push(e.name); continue } // たどれないリンクは、使っているか・複製かわからない
      const env = readRecord(path.join(dir, CLOUD_DIR, CLOUD_ENV_FILE))
      const state = readRecord(path.join(dir, CLOUD_DIR, CLOUD_STATE_FILE))
      // 同じ prefix（複製）か。公開の記録は見ない。「使っている」の判断とは別に数える
      if (siblingHasSamePrefix(env, state, bucket, prefix)) samePrefix.push(e.name)
      // 複製かどうかを確かめられなかったか。env.json か state.json が読めない・壊れている・形が違う（`.sakuraide.json` は見ない）。prefix が空なら確かめる対象が無い
      if (prefix !== '' && (envUse(env, bucket) === 'unknown' || stateUse(state, bucket) === 'unknown')) samePrefixUnread.push(e.name)
      const use = siblingUseOfBucket(env, state, readMetaFs(dir), bucket)
      if (use === 'uses') users.push(e.name)
      else if (use === 'unknown') unknown++
    }
    samePrefix.sort() // 文字コード順（users と同じ）
    samePrefixUnread.sort()
    if (users.length > 0) return { known: true, users: users.sort(), samePrefix, samePrefixUnread, samePrefixChecked: true } // 文字コード順（実行する環境の言語設定で並びが変わらない）
    return unknown > 0
      ? { known: false, samePrefix, samePrefixUnread, samePrefixChecked: true }
      : { known: true, users: [], samePrefix, samePrefixUnread, samePrefixChecked: true }
  } catch {
    return { known: false, samePrefix, samePrefixUnread, samePrefixChecked: false } // 親フォルダの一覧を読めなかった
  }
}
