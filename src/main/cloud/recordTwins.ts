// recordTwins.ts — 同じ公開の記録を持つ、同じ親フォルダの別のフォルダ（複製）の名前を、記録から読む（読むだけ・外へ要求を出さない・何も書かない。electron に依存しない）。
// 0.6.24 I-2（作者の決定 K1）。破棄の骨（teardownShell.ts）の `twinsOf` が、3つの公開先の破棄の前に呼ぶ（重なる＝`recordTwinsFs`）。R2-d: 削除の画面・`fs:trashProject` は、より狭い「覆う」（`recordCoverFs`・事実は coverFacts.ts）。
//
// ── なぜ要るか（2026-10-25 の調査 H1〜H4）────────────────────────────────────────
// Finder でプロジェクトのフォルダを複製すると、複製は元と同じ公開の記録（HANAMII の projectId・共用型の apprun-app の id・専有型のリソース ID）を持つ。
// 複製から 🗑 破棄を押すと、**元が公開している動いているアプリが消える**（記録は同じものを指しているので、取り違えを見分けられない）。
// 保存場所のデータの守りは `teardownPlanFor` の samePrefix（I-1）が持つ。ここは**公開そのもの**の守り: 1件でもあれば、骨は外へ1本も出さず、記録も消さずに断る。
//
// ── 同じ記録とみなす識別子（書き下す。どれも、空でない文字列だけを数える）──────────────────
//   ・HANAMII（hanamii）… `.sakuraide.json` の `publish.hanamii.projectId`
//   ・共用型（sakura-apprun）… `.sakura-cloud/state.json` の `resources` のうち kind が `apprun-app` のものの `id`
//   ・専有型（sakura-apprun-dedicated）… `.sakuraide.json` の `publish.apprunDedicated` の `applicationID`・`clusterID`・`loadBalancerID`・`asgID`
//   ・それ以外の公開先（Vercel・レンタルサーバ・VPS など）は、骨に載っていないので空
// 値だけでなく**どの項目か**（`hanamii:` `apprun-app:` `clusterID:` …）も合わせて比べる（別の種類の資源の ID が偶然同じでも、同じ記録とは言わない）。
// **保存場所もレジストリ名も数えない**（保存場所は I-1 の samePrefix が扱う。レジストリを借りるのは正しい使い方）。
// 自分の記録に識別子が1つも無い（まだ何も作っていない・破棄が済んだ）ときは、比べる相手が無いので空を返す。
//
// ── どこまで見るか（bucketUsers.ts・registryUsers.ts と同じ歩き方）─────────────────────────
// そのプロジェクトと同じ親フォルダの、直下のフォルダだけ。隠しフォルダと自分は見ない。歩き方の部品は bucketUsers.ts の `entryKind`・`readRecord` と
// publishMetaFs.ts の `readMetaFs` の1つずつ（リンクの辿り方・ENOENT の見分けを複製しない）。
//   ・**読めない兄弟は数えない**（たどれないリンク・記録が ENOENT 以外で読めない・壊れている・形が違う）。壊れたリンク1つで、すべての破棄が止まらないようにするため（仕様 5章）。
//     データの側は別の守り（`teardownPlanFor` の `twinRiskOf`・K3）が、読めない兄弟がいればデータもバケットも消さない側に倒す
//   ・親フォルダの一覧を読めなかった回も空（見える兄弟がいない）
//   ・途中で例外になっても、それまでに見つけた複製は返す（見つかった事実は動かない）。**投げない**
//   ・別の親フォルダ・別の Mac の複製は見えない（H6。文書に残す）
import * as fs from 'fs'
import * as path from 'path'
import { CLOUD_DIR, CLOUD_ENV_FILE, CLOUD_STATE_FILE } from './specStore'
import { entryKind, readRecord, isSameDirFs, type RecordRead } from './bucketUsers'
import { coverFactsOf, covers, type CoverRecords } from './coverFacts'
import { readMetaFs } from '../publishMetaFs'
import { BAD_PROJECT_DIR_MESSAGE } from './teardownShell'
import type { PublishTargetKind } from '../../shared/publishMeta'

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== ''
const NOT_READ: RecordRead = { kind: 'missing' }

/** 専有型の記録（`publish.apprunDedicated`）で、同じ記録かどうかを比べる項目（書き下す）。 */
export const DEDICATED_IDENTITY_FIELDS = ['applicationID', 'clusterID', 'loadBalancerID', 'asgID'] as const

/** その公開先の識別子を読むのに、`.sakuraide.json` と `state.json` のどちらが要るか。 */
const NEEDS: Partial<Record<PublishTargetKind, { meta: boolean; state: boolean }>> = {
  hanamii: { meta: true, state: false },
  'sakura-apprun': { meta: false, state: true },
  'sakura-apprun-dedicated': { meta: true, state: false },
}

/**
 * 1つのフォルダの記録から、その公開先の識別子（`項目:値` の並び）を読む（純関数）。読めない・形が違う・空の値は数えない。
 * `meta` は `.sakuraide.json`、`state` は `.sakura-cloud/state.json` の読み結果。
 */
export function twinIdentitiesOf(target: PublishTargetKind, meta: RecordRead, state: RecordRead): string[] {
  if (target === 'hanamii') {
    const publish = meta.kind === 'ok' && isObject(meta.value) ? meta.value.publish : undefined
    const hanamii = isObject(publish) ? publish.hanamii : undefined
    const id = isObject(hanamii) ? hanamii.projectId : undefined
    return nonEmpty(id) ? [`hanamii:${id}`] : []
  }
  if (target === 'sakura-apprun') {
    const resources = state.kind === 'ok' && isObject(state.value) ? state.value.resources : undefined
    if (!Array.isArray(resources)) return []
    return resources.filter(r => isObject(r) && r.kind === 'apprun-app' && nonEmpty(r.id)).map(r => `apprun-app:${(r as { id: string }).id}`)
  }
  if (target === 'sakura-apprun-dedicated') {
    const publish = meta.kind === 'ok' && isObject(meta.value) ? meta.value.publish : undefined
    const rec = isObject(publish) ? publish.apprunDedicated : undefined
    if (!isObject(rec)) return []
    return DEDICATED_IDENTITY_FIELDS.filter(f => nonEmpty(rec[f])).map(f => `${f}:${rec[f] as string}`)
  }
  return []
}

/** 1つのフォルダの、その公開先の識別子。要る記録だけを読む（読むのは ENOENT を見分ける既存の口）。 */
function identitiesInDir(dir: string, target: PublishTargetKind): string[] {
  const needs = NEEDS[target]
  if (!needs) return []
  return twinIdentitiesOf(
    target,
    needs.meta ? readMetaFs(dir) : NOT_READ,
    needs.state ? readRecord(path.join(dir, CLOUD_DIR, CLOUD_STATE_FILE)) : NOT_READ,
  )
}

/** `recordTwinsFs` の答え。複製の名前の並びか、`'unknown'`（確かめられなかった）。 */
export type TwinsRead = string[] | 'unknown'

/** 同じ親フォルダの兄弟（自分・隠しフォルダ・ファイル・たどれないリンクを除いたフォルダ）。親フォルダの一覧を読めなかったら `'unknown'`。 */
function siblingDirs(self: string): Array<{ name: string; dir: string }> | 'unknown' {
  const workspace = path.dirname(self)
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(workspace, { withFileTypes: true }) } catch { return 'unknown' } // 親フォルダの一覧を読めない（兄弟がいるか分からない）
  const out: Array<{ name: string; dir: string }> = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const dir = path.join(workspace, e.name)
    if (dir === self || isSameDirFs(dir, self)) continue // 自分自身は数えない（文字列が違っても同じフォルダ〔リンク・大文字小文字・NFC/NFD〕は自分。R2-b）
    if (entryKind(workspace, e) !== 'dir') continue // ファイル・たどれないリンクは数えない
    out.push({ name: e.name, dir })
  }
  return out
}

/**
 * `projectDir` と**同じ公開の記録**（`target` の識別子が1つでも一致する）を持つ、同じ親フォルダの別のフォルダの名前（フォルダ名・文字コード順）を読む。**投げない。**
 * 1件でもあれば、呼び手（破棄の骨）はその公開先を破棄しない。読めない兄弟は数えない（ファイル冒頭）。
 *
 * **親フォルダの一覧を読めなかった回は `'unknown'`**（0.6.24 R2-f）。空（複製なし）と同じに返すと、複製がいるかもしれないのに破棄が進む。
 * 呼び手は `'unknown'` を断る側に倒す（骨は `TWINS_UNKNOWN_MESSAGE`・`cloud:recordTwins` は `ok:false`）。`projectDir` が文字列でない・空も確かめられない。
 * 途中で例外になっても、それまでに見つけた複製は返す（見つかった事実は動かない）。1件も無ければ `'unknown'`。
 */
export function recordTwinsFs(projectDir: string, target: PublishTargetKind): TwinsRead {
  const twins: string[] = []
  try {
    if (typeof projectDir !== 'string' || projectDir === '') return 'unknown'
    const self = path.resolve(projectDir)
    const own = new Set(identitiesInDir(self, target))
    if (own.size === 0) return [] // 比べる相手が無い（記録に何も無い）
    const siblings = siblingDirs(self)
    if (siblings === 'unknown') return 'unknown'
    for (const s of siblings) {
      if (identitiesInDir(s.dir, target).some(id => own.has(id))) twins.push(s.name)
    }
  } catch {
    return twins.length > 0 ? twins.sort() : 'unknown' // 途中で例外: 見つけた分があれば返す。無ければ確かめられていない
  }
  return twins.sort()
}

/** 1つのフォルダの3つの記録（env.json は保存場所の事実に要る）。読めない記録は `unreadable` の印つき（自分の記録なら確かめられない）。 */
function recordsInDir(dir: string, target: PublishTargetKind): { records: CoverRecords; unreadable: boolean } {
  const needs = NEEDS[target] ?? { meta: false, state: false }
  const records: CoverRecords = {
    meta: needs.meta ? readMetaFs(dir) : NOT_READ,
    state: needs.state ? readRecord(path.join(dir, CLOUD_DIR, CLOUD_STATE_FILE)) : NOT_READ,
    env: readRecord(path.join(dir, CLOUD_DIR, CLOUD_ENV_FILE)),
  }
  return { records, unreadable: records.meta.kind === 'unreadable' || records.state.kind === 'unreadable' || records.env.kind === 'unreadable' }
}

/**
 * `projectDir` の記録（その公開先の「破棄で消すものの事実」。`coverFacts.ts`）を**すべて含む**記録を持つ、同じ親フォルダの兄弟の名前（フォルダ名・文字コード順）を読む。**投げない。**
 * `recordTwinsFs`（重なる）より狭い: 識別子が1つ重なるだけでは足りない。**1つの兄弟**が、自分の事実をすべて持っているときだけ数える（0.6.24 R2-d）。
 * プロジェクトの削除（I-3）が、破棄を外す・専有型の止めを外す・移す直前に確かめ直す（R2-e）のに使う。一部だけを持つ複製（公開の前・保存場所を作る前に写したバックアップ）は覆わない。
 *   ・自分の記録に識別子が1つも無ければ空（比べる相手が無い。`recordTwinsFs` と同じ）
 *   ・**自分の記録が読めない・親フォルダの一覧を読めない・`projectDir` が不正は `'unknown'`**（自分の事実を数え切れないまま「覆う」と言わない）
 *   ・読めない兄弟は事実を持たない（読めた記録の分だけ。覆うとは言わない側）。たどれないリンク・ファイル・隠しフォルダ・自分は兄弟に数えない
 */
export function recordCoverFs(projectDir: string, target: PublishTargetKind): TwinsRead {
  const covering: string[] = []
  try {
    if (typeof projectDir !== 'string' || projectDir === '') return 'unknown'
    if (!NEEDS[target]) return []
    const self = path.resolve(projectDir)
    const identities = identitiesInDir(self, target)
    if (identities.length === 0) return [] // 比べる相手が無い（記録に何も無い）
    const mine = recordsInDir(self, target)
    if (mine.unreadable) return 'unknown' // 自分の事実を数え切れない
    const own = coverFactsOf(target, identities, mine.records)
    const siblings = siblingDirs(self)
    if (siblings === 'unknown') return 'unknown'
    for (const s of siblings) {
      const theirs = recordsInDir(s.dir, target)
      const their = coverFactsOf(target, identitiesInDir(s.dir, target), theirs.records)
      if (covers(own, their)) covering.push(s.name)
    }
  } catch {
    return covering.length > 0 ? covering.sort() : 'unknown'
  }
  return covering.sort()
}

// ── プロジェクトの削除の画面が読む口（cloud:recordTwins。0.6.24 I-3）──────────────────────────────────────
/** 複製を数える公開先（`NEEDS` の3つ。書き下す）。画面の `TWIN_TARGETS`（renderer/teardown/projectDeleteTwins.ts）と同じ並び（tests/recordTwinsHandler.test.ts が突き合わせる）。 */
export const TWIN_TARGETS = ['hanamii', 'sakura-apprun', 'sakura-apprun-dedicated'] as const

export type RecordTwinsByTarget = Record<(typeof TWIN_TARGETS)[number], string[]>

/** `cloud:recordTwins` が、複製の有無を確かめられなかった（親フォルダの一覧を読めない・記録を読めない）ときの文。画面は読めなかった扱い（破棄から外さない側）。 */
export const RECORD_TWINS_UNKNOWN_MESSAGE = '同じ公開の記録を持つフォルダがあるか確かめられませんでした。'

/**
 * `cloud:recordTwins` の本体。**読むだけ**（外へ要求を出さない・何も書かない）。**投げない**。
 * 3つの公開先それぞれで、自分の事実をすべて持つ兄弟（**覆う複製**）の名前を `recordCoverFs` で読む（0.6.24 R2-d。破棄の骨の `twinsOf` は、より広い「重なる」の `recordTwinsFs`）。
 * 画面（プロジェクトの削除）は、これで覆う複製のある公開先を破棄から外し、専有型の止めを外す。重なるが覆わない複製は、ここに入らない（plan はその公開先を破棄に入れ、
 * 骨が断って手順が failed になり、フォルダは移らない）。画面が外しても、`fs:trashProject` が `recordCoverFs` で移す直前に改めて確かめる（R2-e）。
 * `projectDir` が文字列でない・空なら `ok:false`（画面は読めなかった扱い＝破棄から外さない側）。
 * **3つのどれかが `'unknown'`（親フォルダの一覧を読めない・自分の記録を読めない）なら `ok:false`**（0.6.24 R2-f。空の答えと同じに返さない。画面の `twins` は null になり、plan は何も外さない）。
 */
export function readRecordTwins(projectDir: unknown): { ok: true; twins: RecordTwinsByTarget } | { ok: false; message: string } {
  if (typeof projectDir !== 'string' || projectDir === '') return { ok: false, message: BAD_PROJECT_DIR_MESSAGE }
  const twins = {} as RecordTwinsByTarget
  for (const t of TWIN_TARGETS) {
    const read = recordCoverFs(projectDir, t)
    if (read === 'unknown') return { ok: false, message: RECORD_TWINS_UNKNOWN_MESSAGE }
    twins[t] = read
  }
  return { ok: true, twins }
}
