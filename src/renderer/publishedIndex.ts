// publishedIndex.ts — 「📡 公開したもの一覧」の純粋ロジック（electron/DOM非依存・Vitest対象）。
//
// 目的（2026-07-31 ユーザー要望）: HANAMII で障害が起きたとき「自分は HANAMII に何を公開していたか」を
// すぐ確認できるようにする。**各サービスの現在の状態ではなく、Koto がローカルに持つ公開の記録**を集めて出す。
//
// なぜ Koto に置くのが妥当か:
//  - 「向こう側の公開物」と「手元のどのプロジェクトから公開したか」の対応は Koto にしか無い
//    （サービスの管理画面には向こう側の名前しか出ない）
//  - APIキーもネットワークも使わないため、**サービス側が落ちているときでも参照できる**
// 逆に「いま実際に公開中か」の正解はサービス側にしかないので、UI では必ずその旨を明示し、
// 各サービスの管理画面へ誘導する（PublishedListModal.tsx）。
//
// 1プロジェクト分の行組み立ては ③公開の「公開状況」と同じ buildPublishStatusRows を再利用する
// （レガシー救済＝旧フィールドしか無いプロジェクトの拾い上げも同じ規則になる）。

import { buildPublishStatusRows, parseApprunLegacy, type PublishMeta, type PublishTargetKind } from './publishStatus'

/** main の fs:publishedRecords が返す1プロジェクト分（publish / apprunState は unknown のまま受ける）。 */
export interface PublishedProjectInput {
  dir: string
  name: string
  publish?: unknown
  apprunState?: unknown
}

/** 一覧の1行（プロジェクト×公開先）。 */
export interface PublishedEntry {
  /** プロジェクトの絶対パス（「開く」で使う）。 */
  dir: string
  projectName: string
  target: PublishTargetKind
  /** 公開先の表示名（buildPublishStatusRows と同じラベル）。 */
  label: string
  url: string | null
  /** ISO文字列。レガシー救済で日時が分からない場合は null。 */
  publishedAt: string | null
  /** 日時不明（「公開済み」としか分からない）行か。 */
  dateUnknown: boolean
  /**
   * HANAMII のプロジェクトID（`hanamii` の行だけ入る）。
   * 一覧から破棄するときに `hanamii:teardown` へ渡すために持ち回る。
   * AppRun は projectDir だけで破棄できるので、こういう持ち回りは要らない。
   */
  hanamiiProjectId: string | null
  /**
   * このプロジェクトが使っているコンテナレジストリ名（`sakura-apprun` の行だけ入る）。
   * 破棄の確認画面で名前を出すために持ち回る。**名前を見せることが安全装置になる**
   * （v0.2.94: 心当たりのない名前ならやめられるようにする）ので、一覧からの破棄でも
   * ③公開の破棄画面と同じ情報を出す。記録が無ければ null（＝Koto からは削除できない）。
   */
  registryName: string | null
  /**
   * その置き場を **Koto が作ったのではない**（引き継ぎで、もとからあったものを
   * 借りている）か。破棄の「置き場も削除する」の既定がこれで変わる（2026-08-25）。
   */
  registryAdopted: boolean
}

/** .sakura-cloud/state.json から、このプロジェクトのレジストリ名を取り出す（形が違えば null）。 */
function parseRegistryName(apprunState: unknown): string | null {
  const n = (apprunState as { meta?: { registryName?: unknown } } | null | undefined)?.meta?.registryName
  return typeof n === 'string' && n ? n : null
}

/** 借り物の置き場か（印が無ければ「Koto が作ったもの」＝これまでどおり）。 */
function parseRegistryAdopted(apprunState: unknown): boolean {
  return (apprunState as { meta?: { registryAdopted?: unknown } } | null | undefined)?.meta?.registryAdopted === true
}

/** publish メタから HANAMII のプロジェクトIDを取り出す（形が違えば null）。 */
function parseHanamiiProjectId(publish: unknown): string | null {
  const h = (publish as { hanamii?: { projectId?: unknown } } | null | undefined)?.hanamii
  return typeof h?.projectId === 'string' && h.projectId ? h.projectId : null
}

/**
 * 全プロジェクトの公開記録を1本の配列にする。新しい順に並べ、**日時不明の行は最後**に置く
 * （並びの中に混ぜると「いつのものか分からないもの」が新しいものより上に来てしまい誤解を生むため）。
 * 公開記録がまったく無いプロジェクトは行を持たない（結果に現れない）。
 */
export function buildPublishedIndex(projects: PublishedProjectInput[]): PublishedEntry[] {
  const entries: PublishedEntry[] = []
  for (const p of projects ?? []) {
    if (!p || typeof p.dir !== 'string') continue
    const rows = buildPublishStatusRows(p.publish as PublishMeta | null | undefined, {
      apprunLegacy: parseApprunLegacy(p.apprunState),
    })
    const hanamiiProjectId = parseHanamiiProjectId(p.publish)
    const registryName = parseRegistryName(p.apprunState)
    const registryAdopted = parseRegistryAdopted(p.apprunState)
    for (const r of rows) {
      entries.push({
        dir: p.dir,
        projectName: p.name || p.dir.split('/').pop() || p.dir,
        target: r.target,
        label: r.label,
        url: r.url,
        publishedAt: r.publishedAt,
        dateUnknown: r.dateUnknown,
        hanamiiProjectId: r.target === 'hanamii' ? hanamiiProjectId : null,
        registryName: r.target === 'sakura-apprun' ? registryName : null,
        registryAdopted: r.target === 'sakura-apprun' && registryAdopted,
      })
    }
  }
  return entries.sort((a, b) => {
    const at = a.publishedAt ? new Date(a.publishedAt).getTime() : NaN
    const bt = b.publishedAt ? new Date(b.publishedAt).getTime() : NaN
    const aOk = !isNaN(at)
    const bOk = !isNaN(bt)
    if (aOk && bOk) return bt - at // 新しい順
    if (aOk) return -1 // 日時不明は後ろへ
    if (bOk) return 1
    return a.projectName.localeCompare(b.projectName) // どちらも不明なら名前順で安定させる
  })
}

/** 公開先ごとのまとまり（「HANAMII に何を公開したか」を一目で見るための形）。 */
export interface PublishedGroup {
  target: PublishTargetKind
  label: string
  entries: PublishedEntry[]
}

/**
 * buildPublishedIndex の結果を公開先ごとにまとめる。グループの並びは
 * 「そのグループの最も新しい公開日時」の新しい順（＝直近で使った公開先が上に来る）。
 * 各グループ内の並びは元の配列（新しい順）を保つ。
 */
export function groupPublishedByTarget(entries: PublishedEntry[]): PublishedGroup[] {
  const map = new Map<PublishTargetKind, PublishedGroup>()
  for (const e of entries ?? []) {
    const g = map.get(e.target)
    if (g) g.entries.push(e)
    else map.set(e.target, { target: e.target, label: e.label, entries: [e] })
  }
  const newestOf = (g: PublishedGroup): number => {
    for (const e of g.entries) {
      const t = e.publishedAt ? new Date(e.publishedAt).getTime() : NaN
      if (!isNaN(t)) return t
    }
    return -Infinity // 日時が1つも分からないグループは最後へ
  }
  return [...map.values()].sort((a, b) => newestOf(b) - newestOf(a))
}
