// teardown/facts.ts — 破棄（削除）の確認の材料を、押した時点の main の記録から読む。
//
// 段階0で作った部品（いまは3つの公開先〔共用型・HANAMII・専有型〕の入口がすべてこれを通る）。設計書: docs/teardown-unify-plan.md の 10.3.2 (2)。
// 3つの公開先の確認の材料は、ここだけが読む（専有型の手本 dedicatedTeardownFlow.ts は 0.6.22 段階3B-7 で消した）。
// 公開先ごとの違いは TargetSpec（readRecord・waitNote・target）から受け取る。
//
// 画面が持っている写しはいつでも古い（掟10）。材料は、入口によらず、押した時点で読み直す。

import type { PublishTargetKind } from '../../shared/publishMeta'
import { PUBLISH_TARGET_LABEL } from '../publishStatus'
import { PUBLISH_TARGETS_USING_STORAGE, readPublishTargetsWithLegacyOrThrow } from '../publishRecord'
import type { PlacementsUnreadableCause, TargetSpec, TeardownFacts, TeardownPlacement } from './types'

/** 確認の材料を読む口（テストでは偽物を渡す）。 */
export interface TeardownFactsApi {
  placements(projectDir: string): Promise<TeardownPlacement[]>
  /**
   * この公開先（self）以外に、いま生きていて**保存場所を使いうる**公開先の表示名。読めなかったら投げる（空に倒さない）。
   * 旧い記録（publish.targets に行が無い HANAMII・共用型・専有型）も数える（D9=2）。
   */
  otherTargets(projectDir: string, self: PublishTargetKind): Promise<string[]>
  estimates(): Promise<unknown>
}

/**
 * `storage:placement` が `ok:false` を返した（設定そのものを読めなかった）ときの失敗。
 * 問い合わせそのものの失敗（IPC の reject）とは別の事実として区別する印を付ける。
 */
export function placementSettingsUnreadable(message: string): Error {
  return Object.assign(new Error(message), { placementSettingsUnreadable: true as const })
}

/** `api.placements` が投げたものから、読めなかった理由を決める。印の付いた失敗だけが `'settings'`、ほかは問い合わせの失敗（`'call'`）。 */
export function placementsFailureCause(e: unknown): PlacementsUnreadableCause {
  return (e as { placementSettingsUnreadable?: unknown } | null)?.placementSettingsUnreadable === true ? 'settings' : 'call'
}

/** 本物の口（window.electronAPI）。window は呼ぶ時に初めて触る。 */
export function electronTeardownFactsApi(): TeardownFactsApi {
  return {
    placements: async dir => {
      const r = await window.electronAPI.storage.placement(dir)
      // 読めなかった（ok:false）は**空と区別して投げる**。空に倒すと、名前を出せないまま保存場所のデータが消える
      // （呼び出し側が「読めなかった」注意を確認の文に足す）。ok:false は「設定そのものを読めなかった」＝印を付ける。
      if (!r.ok) throw placementSettingsUnreadable((r as { message?: string }).message ?? '保存場所の設定を読めませんでした')
      // placements（全件）が無い版の応答でも、先頭1件だけは必ず拾う（黙って空にしない）。
      return r.placements ?? (r.placement ? [r.placement] : [])
    },
    // 読めなかったら**投げる**（空に倒さない）——loadTeardownFacts が「読めなかった」事実を残し、確認の文が言う。
    // 旧い記録の公開先も数え（D9=2）、保存場所を使わない公開先（レンタルサーバ）は挙げない（「この保存場所は〜でも使っているため」が事実と違う文になる）。
    otherTargets: async (dir, self) => (await readPublishTargetsWithLegacyOrThrow(dir))
      .filter(t => t !== self && PUBLISH_TARGETS_USING_STORAGE.includes(t))
      .map(t => PUBLISH_TARGET_LABEL[t]),
    estimates: () => window.electronAPI.stageTiming.estimates(),
  }
}

/** プロジェクトのフォルダ名（確認の先頭に出す）。 */
function projectNameOf(projectDir: string): string {
  return projectDir.split('/').filter(Boolean).pop() ?? projectDir
}

/**
 * 確認の材料を、**押した時点の main の記録から**読む。
 *
 * - 公開の記録（`spec.readRecord`）が読めなければ**投げる**（消すものが分からないまま確認を出さない。流れが「材料が読めない」として失敗を返す）。
 * - 保存場所・ほかの公開先・目安は、読めなくても破棄そのものはできるので、空に倒して続ける。ただし
 *   **保存場所・ほかの公開先が読めなかった事実は残し**（`placementsUnreadable`・`otherTargetsUnreadable`）、確認の文で言う。
 *   保存場所の設定そのものが読めないとき（`placementsUnreadableCause: 'settings'`）、main も保存場所に触れない（残る）。
 *   問い合わせそのものが失敗したとき（`'call'`）は、main がどうするかは分からない。
 *   目安だけは、読めなくても確認の中身（何が消えるか）は変わらない。
 * - 時間の予告（`waitNote`）は、公開先の仕様書が記録と目安から作る（無ければ null。測っていない段に目安を作らない）。
 */
export async function loadTeardownFacts<R>(
  projectDir: string,
  spec: Pick<TargetSpec<R, unknown, unknown>, 'readRecord' | 'waitNote' | 'target' | 'placementsOf'>,
  api: TeardownFactsApi,
): Promise<TeardownFacts<R>> {
  const record = await spec.readRecord(projectDir)
  // 保存場所: 仕様書が記録から決める公開先（共用型）は、その答えをそのまま使い、共通の読み口（env.json の同意済みだけ）は呼ばない
  // （確認が言うものと main が消すものを同じ関数で決める。P5）。決めた関数が投げたら、名前を挙げられない（'call'）。
  const readPlacements = (): Promise<TeardownPlacement[]> => {
    if (!spec.placementsOf) return api.placements(projectDir)
    try { return Promise.resolve(spec.placementsOf(record)) } catch (e) { return Promise.reject(e) }
  }
  const [placements, otherTargets, estimates] = await Promise.all([
    readPlacements().then(
      v => ({ v, unreadable: false, cause: null as PlacementsUnreadableCause | null }),
      (e: unknown) => ({ v: [] as TeardownPlacement[], unreadable: true, cause: placementsFailureCause(e) as PlacementsUnreadableCause | null }),
    ),
    api.otherTargets(projectDir, spec.target).then(v => ({ v, unreadable: false }), () => ({ v: [] as string[], unreadable: true })),
    api.estimates().catch((): unknown => null),
  ])
  return {
    projectName: projectNameOf(projectDir),
    record,
    placements: Array.isArray(placements.v) ? placements.v : [],
    placementsUnreadable: placements.unreadable,
    placementsUnreadableCause: placements.cause,
    otherTargets: Array.isArray(otherTargets.v) ? otherTargets.v : [],
    otherTargetsUnreadable: otherTargets.unreadable,
    waitNote: spec.waitNote?.(record, estimates) ?? null,
  }
}
