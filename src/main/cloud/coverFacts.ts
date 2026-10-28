// coverFacts.ts — 1つのフォルダの記録から、その公開先の「破棄で消すものの事実」を書き下す（純関数・読まない・electron に依存しない）。
// 0.6.24 R2-d。`recordTwins.ts` の `recordCoverFs` が、自分の事実が1つの兄弟の事実にすべて含まれるか（覆うか）を見るのに使う。
//
// ── なぜ要るか ──────────────────────────────────────────────────────────────────────
// 「同じ公開の記録を持つ（重なる）」だけを複製と数えると、公開の前・保存場所を作る前に Finder で写したバックアップ（記録の一部だけを持つ複製）でも複製と数え、
// 元を削除すると、元にしか無い専有型の applicationID・共用型の保存場所・レジストリ・鍵が、どの記録にも残らないまま残る（検分で実測）。
// 「重なる」（識別子が1つでも一致）と「覆う」（自分の事実がすべて、1つの兄弟の事実に含まれる）を分ける。
//   ・I-2（破棄を断る）は「重なる」のまま（断るのは何も消さない側なので、広くてよい）
//   ・I-3（プロジェクトの削除が破棄を外す・`fs:trashProject` が専有型の止めを外す）は「覆う」だけ
//
// ── 事実（書き下す。どれも空でない文字列だけを数える。「項目:値」の形で、別の項目の同じ値を区別する）──────────────────
//   ・HANAMII … `hanamii:<projectId>`（`.sakuraide.json` の publish.hanamii.projectId）・`placement:<bucket>/<prefix>`（env.json の同意済みの保存場所）
//   ・共用型 … `apprun-app:<id>`（state.json の resources の apprun-app）・`bucket:<id>/<prefix>`（同 bucket 資源）・`placement:…`（env.json の同意済み）・
//             `registry:<state.meta.registryName>`
//   ・専有型 … `applicationID:…` `clusterID:…` `loadBalancerID:…` `asgID:…`（`.sakuraide.json` の publish.apprunDedicated）・`placement:…`
//   ・**鍵の ID（`state.meta.storagePermissionId`・専有型の記録の `storagePermissionId`）は事実に入れない**（0.6.24 R3-a）。再公開のたびに新しい鍵へ置き換わる値で、
//     入れると、複製を写したあと元を1回再公開しただけで、4つの ID が同じでも互いに覆わなくなる（専有型は画面の止め・main の止め・骨の断りの3つに断られ、どちらのフォルダも
//     破棄も削除もできない。検分で実測）。鍵は R2-i の `permissionHeldByOthersFs` が、鍵の ID そのもので別に守る。
//     `registry:`・`placement:`・`bucket:`・`leftover:` は置き換わらず、片方にだけ足される向きなので、覆う順序が付く。
//   ・（仕様の書き下しに足した安全側）残った保存場所の印 `leftover:<bucket>` … HANAMII の `publish.hanamii.storageLeftoverBuckets`・専有型の `storageLeftoverBucket(s)`。
//     これも破棄が消すもの。兄弟に無ければ覆わない（覆わない側＝破棄を外さない側に倒れる）
// 公開先ごとに別の事実の集合（比べるのは同じ公開先どうしだけ）。
// 読めない・形が違う記録は事実を持たない（読めた分だけ）。自分の記録が読めないときの扱いは呼び手（`recordCoverFs`）が決める。
import { consentedPlacementsOf } from '../../shared/objectStorage'
import { dedicatedStorageLeftoverNames } from '../../shared/teardownSupport'
import type { PublishTargetKind } from '../../shared/publishMeta'
import type { RecordRead } from './bucketUsers'

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== ''
const okValue = (r: RecordRead): unknown => (r.kind === 'ok' ? r.value : undefined)

/** 3つの記録の読み結果（`.sakuraide.json`・`.sakura-cloud/state.json`・`.sakura-cloud/env.json`）。 */
export type CoverRecords = { meta: RecordRead; state: RecordRead; env: RecordRead }

/** env.json の同意済みの保存場所 → `placement:<bucket>/<prefix>`（読み方は `consentedPlacementsOf` の1つ。破棄が消すものと同じ）。 */
function placementFacts(env: RecordRead): string[] {
  const v = okValue(env)
  const persistence = isObject(v) ? v.persistence : undefined
  const list = isObject(persistence) ? persistence.objectStorage : undefined
  if (!Array.isArray(list)) return []
  return consentedPlacementsOf(list).map(p => `placement:${p.bucket}/${p.prefix}`)
}

/** `.sakuraide.json` の `publish.<key>`（オブジェクトだけ）。 */
function publishOf(meta: RecordRead, key: string): Record<string, unknown> | undefined {
  const v = okValue(meta)
  const publish = isObject(v) ? v.publish : undefined
  const rec = isObject(publish) ? publish[key] : undefined
  return isObject(rec) ? rec : undefined
}

/** 残った保存場所の印（全件）。文字列でない・空は数えない。 */
function leftoverFacts(names: unknown): string[] {
  return Array.isArray(names) ? names.filter(nonEmpty).map(b => `leftover:${b}`) : []
}

/**
 * 識別子（`twinIdentitiesOf` の答え。その公開先の資源の ID）に、**ほかの事実**を足して返す。識別子の読み方は呼び手のもの（ここで二重に書かない）。
 * 公開先が骨に載っていないとき（Vercel・レンタルサーバなど）は、識別子のまま（足すものが無い）。
 */
export function coverFactsOf(target: PublishTargetKind, identities: readonly string[], r: CoverRecords): string[] {
  const facts = [...identities, ...placementFacts(r.env)]
  if (target === 'hanamii') {
    facts.push(...leftoverFacts(publishOf(r.meta, 'hanamii')?.storageLeftoverBuckets))
  } else if (target === 'sakura-apprun') {
    const st = okValue(r.state)
    const resources = isObject(st) && Array.isArray(st.resources) ? st.resources : []
    for (const x of resources) {
      if (isObject(x) && x.kind === 'bucket' && nonEmpty(x.id)) facts.push(`bucket:${x.id}/${typeof x.prefix === 'string' ? x.prefix : ''}`)
    }
    const meta = isObject(st) && isObject(st.meta) ? st.meta : undefined
    if (nonEmpty(meta?.registryName)) facts.push(`registry:${meta.registryName}`)
  } else if (target === 'sakura-apprun-dedicated') {
    const rec = publishOf(r.meta, 'apprunDedicated')
    if (rec) facts.push(...leftoverFacts(dedicatedStorageLeftoverNames(rec as Parameters<typeof dedicatedStorageLeftoverNames>[0])))
  }
  return facts
}

/** `own` の事実がすべて `sibling` の事実に含まれるか（覆う）。`own` が空なら false（比べる事実が無いものは、何も覆われていない）。 */
export function covers(own: readonly string[], sibling: readonly string[]): boolean {
  if (own.length === 0) return false
  const set = new Set(sibling)
  return own.every(f => set.has(f))
}
