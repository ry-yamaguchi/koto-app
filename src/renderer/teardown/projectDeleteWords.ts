// teardown/projectDeleteWords.ts — プロジェクトの削除のダイアログが出す文のうち、plan・材料から決まるもの（純関数）。
//
// 0.6.24 A（U10）。projectDeletePlan.ts が 400 行を超えないよう、文だけをここへ出した（判断は projectDeletePlan.ts、ここは言い方）。
// window・React・IPC に触らない。ダイアログ（ProjectDeleteDialog）が呼ぶ。ここが決めるのは次の3つ:
//   ・チェック「…も一緒に破棄する」の文（projectDeleteCheckWords）。**公開していない回**は、公開と言わず残りの呼び名（保存場所・コンテナレジストリ）で言う
//   ・チェックがオンのときの 💾 の行のうち、公開先の行のもの（rowStorageNotesOf。残りの段は除く）と、残りの段のもの（leftoverStorageNoteLine）
//   ・チェックがオフのときの 💾 の行（keptStorageNoteOf。state にだけある保存場所とレジストリも落とさない）
//   ・破棄が済まなかった回の結果の尻（projectDeleteStoppedTail。0.6.24 A-7・U11。結果の欄は plan を持たないので、steps から決める）
//   ・Vercel の案内の最後の文（保存場所は残ります）を言わない回か（vercelStorageTornDown。0.6.24 A-9・U12）

import type { PublishTargetKind } from '../publishStatus'
import { teardownDataNoteForAll, teardownRemovesStorage } from '../../shared/teardownSupport'
import { sharedRegistryCounted, sharedRegistryDeleteDefault } from './targets/shared'
import {
  remainingPlacementsNote, sharedLeftoverNote, PROJECT_DELETE_STOPPED_TAIL, projectDeleteStoppedTailLeftover,
  type ProjectDeleteFacts, type ProjectDeletePlan, type ProjectDeleteStep,
} from './projectDeletePlan'

/** チェックの横の文と、オン・オフの説明と、実行中のボタンの文。 */
export type ProjectDeleteCheckWords = { label: string; on: string; off: string; running: string }

/**
 * **公開していない回**か。plan.teardown が共用型の段1つだけで、その段が記録の残りのための段（plan.leftover の noun が文字列）のとき。
 * Vercel・レンタルサーバの行は teardown に入らないので、「Vercel と保存場所」の回もここに入る（facts.targets が空かどうかでは決めない）。
 * アプリが残っている回（noun が null）・HANAMII の行がある回（teardown が2つ）は、公開のある回。
 */
export function isUnpublishedLeftoverPlan(plan: Pick<ProjectDeletePlan, 'teardown' | 'leftover'>): boolean {
  return plan.teardown.length === 1 && plan.teardown[0] === 'sakura-apprun' && typeof plan.leftover?.noun === 'string'
}

/**
 * チェックの文（0.6.24 A-3）。公開のある回の文は、1文字も変えない。
 *  ・公開あり → 「公開も一緒に破棄する」（今のまま）
 *  ・公開なし（isUnpublishedLeftoverPlan）→ 「{noun}も一緒に破棄する」。オフの説明は、公開の記録が無いので「記録」と言う。実行中のボタンは「破棄しています…」
 * 公開なしの回で、レジストリを数えていて（K2）、確認での既定がオフ（借りたもの・由来の分からないもの）のときは、オンの説明に、次の確認で選べることを足す
 * （チェックは「…破棄する」と言うが、レジストリは確認で選ばない限り消さない。何も言わないと、消えると読める）。facts を渡さない回は足さない。
 */
export function projectDeleteCheckWords(plan: Pick<ProjectDeletePlan, 'teardown' | 'leftover'>, facts?: Pick<ProjectDeleteFacts, 'sharedLeftover'> | null): ProjectDeleteCheckWords {
  if (!isUnpublishedLeftoverPlan(plan)) {
    return {
      label: '公開も一緒に破棄する',
      on: '先に公開を破棄してから、フォルダをゴミ箱へ移します。破棄に失敗したときは削除しません。',
      off: '公開はそのまま残ります。フォルダを消すと「どこに何を公開したか」の記録も消えるため、あとから Koto では破棄できなくなります。',
      running: '公開を破棄しています…',
    }
  }
  const left = facts?.sharedLeftover ?? null
  const choosesRegistry = left !== null && sharedRegistryCounted(left) && !sharedRegistryDeleteDefault(left)
  return {
    label: `${plan.leftover!.noun}も一緒に破棄する`,
    on: '先に破棄してから、フォルダをゴミ箱へ移します。破棄に失敗したときは削除しません。'
      + (choosesRegistry ? ` コンテナレジストリ『${left!.registryName}』を消すかは、次の確認で選べます。` : ''),
    off: 'フォルダを消すと記録も消えるため、あとから Koto では破棄できなくなります。',
    running: '破棄しています…',
  }
}

/**
 * チェックがオンのときの 💾 の行のうち、**公開先の行のもの**（0.6.24 A-4。ダイアログが公開先ごとに1行出す）。
 * 保存場所を消す公開先（teardownRemovesStorage）の段ごとに、`{ target, note }` を、段の並びで返す。note が空の公開先は返さない。
 *  ・文は facts.placements（env.json の同意済み。全件）で作る（HANAMII と、行のある共用型。今のまま）
 *  ・**残りの段（plan.leftover の 'sakura-apprun'）は返さない**。残りの段の行は leftoverStorageNoteLine が、記録の残り（facts.sharedLeftover.placements）で作る
 *    （両方で出すと「📦 さくらのAppRun:」を前に付けた行が env の保存場所で出てしまう）
 * `shownTeardown` は、いま画面が箱に出している段（既定は plan.teardown。破棄が済んだ段は外れている）。
 */
export function rowStorageNotesOf(
  plan: Pick<ProjectDeletePlan, 'teardown' | 'leftover'>, facts: Pick<ProjectDeleteFacts, 'placements'>,
  shownTeardown: readonly PublishTargetKind[] = plan.teardown,
): Array<{ target: PublishTargetKind; note: string }> {
  return shownTeardown
    .filter(t => teardownRemovesStorage(t) && !(t === 'sakura-apprun' && plan.leftover))
    .map(t => ({ target: t, note: teardownDataNoteForAll({ target: t, placements: facts.placements }) }))
    .filter(x => !!x.note)
}

/**
 * Vercel の案内の最後の文（「保存場所（バケット）自体は…残ります。」）を**言わない**回か（0.6.24 A-9。真なら ManualTeardownNote の storageTornDown に渡す）。
 * 真になるのは次の**すべて**を満たすとき。それ以外（📡・チェックが外れている回・残りの段が無い回）は偽＝今の文のまま。
 *  ・チェックがオン（`=== true`。渡し忘れ・形違いは偽）
 *  ・残りの段（plan.leftover）があり、いま箱に出ている（shownTeardown に 'sakura-apprun' がある）
 *  ・その残りの段が**保存場所を破棄する**（記録の残りに保存場所が1件以上ある）。仕様の文面は「チェックがオンかつ残りの段がある回」だが、残りがコンテナレジストリだけ・
 *    アプリだけの回は保存場所に触れず、保存場所は実際に残る。そこで「残ります」を消すと、月額が続くのに「残る」と言わなくなるので、安全側（言う側）に倒した。
 */
export function vercelStorageTornDown(
  plan: Pick<ProjectDeletePlan, 'teardown' | 'leftover'>, facts: Pick<ProjectDeleteFacts, 'sharedLeftover'>, teardownOnDelete: boolean,
  shownTeardown: readonly PublishTargetKind[] = plan.teardown,
): boolean {
  if (teardownOnDelete !== true || !plan.leftover || !shownTeardown.includes('sakura-apprun') || !teardownRemovesStorage('sakura-apprun')) return false
  const placements: unknown = facts.sharedLeftover?.placements
  return Array.isArray(placements) && placements.length > 0
}

/**
 * チェックがオンのときの 💾 の行のうち、**残りの段（plan.leftover）のもの**（0.6.24 A-4）。残りの段が無い回・出す保存場所が無い回は空。
 *  ・公開先の名前は前に付けない（共用型の行は無い。呼び手が付けない）
 *  ・前の行（HANAMII。teardown に HANAMII の段があり、facts.placements が名指しした保存場所）と同じ保存場所は除く（同じ保存場所を2回言わない）
 *  ・文は teardownDataNoteForAll({ target: 'sakura-apprun', placements: 残り }) で作る（確認の文と同じ作り手）
 * `shownTeardown` は、いま画面が箱に出している段（既定は plan.teardown）。HANAMII の破棄が済んで箱から外れた後は、HANAMII の行が無いので除かない。
 * 行のある共用型と HANAMII が並ぶ回（plan.leftover が無い）の2行は、今のまま（呼び手が facts.placements で作る）。
 */
export function leftoverStorageNoteLine(
  plan: Pick<ProjectDeletePlan, 'teardown' | 'leftover'>, facts: Pick<ProjectDeleteFacts, 'sharedLeftover' | 'placements'>,
  shownTeardown: readonly PublishTargetKind[] = plan.teardown,
): string {
  if (!plan.leftover || !shownTeardown.includes('sakura-apprun') || !teardownRemovesStorage('sakura-apprun')) return ''
  const left = facts.sharedLeftover
  if (!left) return ''
  const hanamiiLineShown = shownTeardown.includes('hanamii') && teardownRemovesStorage('hanamii')
  const named = new Set(hanamiiLineShown ? facts.placements.map(p => p.bucket) : [])
  // 文は保存場所の名前（バケット）で言うので、同じバケットを別の prefix で持つ分は1つにまとめる（『A』『A』と並べない）
  const rest = left.placements.filter((p, i, all) => !named.has(p.bucket) && all.findIndex(q => q.bucket === p.bucket) === i)
  return teardownDataNoteForAll({ target: 'sakura-apprun', placements: rest })
}

/**
 * チェックがオフのとき（破棄しないとき）の 💾 の行（0.6.24 A-4）。**state にだけある保存場所とレジストリを落とさない**。
 * 共用型の記録の残り（facts.sharedLeftover）があれば sharedLeftoverNote を言う。保存場所は、記録の全件（env.json の同意済み + state にだけあるもの）に、
 * 材料の facts.placements（env.json）を足して数える（どちらかにしか無い保存場所も言う）。同じ保存場所は名前の重複を除いて1回だけ言う。
 * 記録の残りが無い回は、今のまま facts.placements の文（remainingPlacementsNote）。何も残らない回は空。
 */
export function keptStorageNoteOf(facts: Pick<ProjectDeleteFacts, 'sharedLeftover' | 'placements'>): string {
  const left = facts.sharedLeftover
  if (left) {
    const key = (p: { bucket: string; prefix: string }) => `${p.bucket}|${p.prefix}`
    const have = new Set(left.placements.map(key))
    const extra = facts.placements.filter(p => !have.has(key(p)))
    return sharedLeftoverNote({ ...left, placements: [...left.placements, ...extra] })
  }
  return facts.placements.length > 0 ? remainingPlacementsNote(facts.placements) : ''
}

/**
 * 破棄が済まなかった回（stopped）の結果の尻（0.6.24 A-7）。**公開なしの回**は projectDeleteStoppedTailLeftover（後半を残りの呼び名で言う。R4-c）、それ以外は今のまま PROJECT_DELETE_STOPPED_TAIL。
 * 結果の欄（ProjectDeleteResults）は plan を持たず steps だけを受けるので、ここで steps から決める。
 * **公開なし**＝済んでいない step（failed・cancelled）が1つ以上あり、**そのすべてが残りの段**（teardownPublished が付ける leftover の印と名詞 label がある）のとき。
 *  ・HANAMII が済まなかった回（その step が failed・cancelled）は、公開が残っているので、公開の尻のまま。
 *  ・HANAMII が済んだあとに残りの段だけが済まなかった回（carried の HANAMII は done）は、公開が残っていないので、残りの尻。画面のチェックの文もこの回は
 *    「公開していない回」に読み替わる（読み直した材料から作り直すため）ので、尻とチェックの言い方が食い違わない。
 *  ・残りの段でも、アプリが残る回（名詞が null＝label が無い。公開の回）は、公開の尻のまま。
 *  ・済んでいない step が無い（チェックの値が真偽でないなど）は、公開の尻のまま（今の文を変えない）。
 * 尻の名詞は、済んでいない残りの段の呼び名（label）。残りの段は1つだけだが、複数あっても重ならないように「・」でつなぐ。
 */
export function projectDeleteStoppedTail(steps: readonly ProjectDeleteStep[]): string {
  const unfinished = steps.filter(s => s.kind === 'failed' || s.kind === 'cancelled')
  const unpublished = unfinished.length > 0 && unfinished.every(s => s.leftover === true && typeof s.label === 'string' && s.label !== '')
  if (!unpublished) return PROJECT_DELETE_STOPPED_TAIL
  return projectDeleteStoppedTailLeftover(Array.from(new Set(unfinished.map(s => s.label as string))).join('・'))
}
