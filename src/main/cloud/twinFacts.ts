// twinFacts.ts — `cloud:twinFacts` の本体。破棄を押す前に、同じ親フォルダの別のフォルダ（複製）を記録から読む。
// 読むだけ（外へ要求を出さない・何も書かない・何も消さない）。投げない。electron に依存しない。
//
// 読むものは2つ。どちらも判断は新しく作らず、破棄の本体が実際に使う関数をそのまま呼ぶ
// （画面が先に言うことと、main が実行時に下す判断を、同じ関数で揃えるため。ここで条件を書き足さない）。
//   ・公開先の断り（`refusal`）… `recordTwinsFs`。3つの破棄の骨（teardownShell.ts）が破棄の前に呼ぶ `twinsOf` と同じ関数
//   ・保存場所ごとの「消さずに残す」（`keep`）… `bucketUsersFromRecords` の答えを `twinRiskOf` に通す。
//     保存場所の破棄（`teardownPlanFor`）と、記録の鍵に触れるかの判断（`placementsHaveTwinRisk`）が使うのと同じ関数
//
// 答えの読み方（型は shared/twinFactsTypes.ts）:
//   ・`refusal` … 複製がいれば `twin`（フォルダ名つき）。複製がいるか確かめられなければ `unknown`。いなければ `null`。
//     骨と同じく、配列でない答えも確かめられなかった扱い（`unknown`）
//   ・`keep` … `twin` は同じ保存場所の同じ prefix を持つフォルダ名。`unread` は複製かどうか確かめられなかったフォルダ名
//     （親フォルダの一覧を読めない回は名前を挙げられず、空）。複製がいないと確かめられたら `null`
//
// 引数が正しくないとき（projectDir が絶対パスの文字列でない・公開先が3つのどれでもない・保存場所の形が違う）は `{ ok: false }`。
// 呼び手は「読めなかった」として扱う。ここで読めなくても、破棄の本体は同じ判断を自分で下す（消さない側に倒す）。
import * as path from 'path'
import { recordTwinsFs, TWIN_TARGETS } from './recordTwins'
import { bucketUsersFromRecords } from './bucketUsers'
import { twinRiskOf } from '../../shared/objectStorage'
import type {
  PlacementKeep, TwinFactsArgs, TwinFactsPlacementInput, TwinFactsResult, TwinFactsTarget, TwinRefusal,
} from '../../shared/twinFactsTypes'

// 型の公開先と、複製を数える公開先（recordTwins.ts の TWIN_TARGETS）が同じ並びであること（食い違うと型で落ちる）
type TargetsMatch = [TwinFactsTarget] extends [(typeof TWIN_TARGETS)[number]]
  ? ([(typeof TWIN_TARGETS)[number]] extends [TwinFactsTarget] ? true : false)
  : false
const _targetsMatch: TargetsMatch = true

const bad = (): TwinFactsResult => ({ ok: false })

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isTarget = (v: unknown): v is TwinFactsTarget => (TWIN_TARGETS as readonly unknown[]).includes(v)

/** 第2引数を読む。形が違えば null（空き要素・文字列でない bucket と prefix も通さない）。余計な項目は運ばない。 */
function parseArgs(args: unknown): TwinFactsArgs | null {
  if (!isObject(args) || !isTarget(args.target) || !Array.isArray(args.placements)) return null
  const placements: TwinFactsPlacementInput[] = []
  for (let i = 0; i < args.placements.length; i++) {
    const p: unknown = args.placements[i]
    if (!isObject(p) || typeof p.bucket !== 'string' || typeof p.prefix !== 'string') return null
    placements.push({ bucket: p.bucket, prefix: p.prefix })
  }
  return { target: args.target, placements }
}

/** 公開先の断り。骨の `twinsOf` の読み方と同じ（配列でない答えは確かめられなかった）。 */
function refusalOf(projectDir: string, target: TwinFactsTarget): TwinRefusal | null {
  const twins = recordTwinsFs(projectDir, target)
  if (!Array.isArray(twins)) return { kind: 'unknown' }
  return twins.length > 0 ? { kind: 'twin', folders: [...twins] } : null
}

/** 保存場所1件を、消さずに残すか。判断は `twinRiskOf` の1つ。 */
function keepOf(projectDir: string, p: TwinFactsPlacementInput): PlacementKeep | null {
  const users = bucketUsersFromRecords(projectDir, p.bucket, p.prefix)
  const risk = twinRiskOf(users)
  if (risk === 'twin') return { risk, folders: [...users.samePrefix] }
  if (risk === 'unread') return { risk, folders: Array.isArray(users.samePrefixUnread) ? [...users.samePrefixUnread] : [] }
  return null
}

/**
 * `cloud:twinFacts(projectDir, { target, placements })` の本体。読むだけ。投げない。
 * `placements` は渡された順・同じ件数で返す（`bucket` と `prefix` を写し、`keep` を付ける）。
 */
export function readTwinFacts(projectDir: unknown, args: unknown): TwinFactsResult {
  try {
    if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) return bad()
    const parsed = parseArgs(args)
    if (!parsed) return bad()
    return {
      ok: true,
      refusal: refusalOf(projectDir, parsed.target),
      placements: parsed.placements.map(p => ({ bucket: p.bucket, prefix: p.prefix, keep: keepOf(projectDir, p) })),
    }
  } catch {
    return bad()
  }
}
