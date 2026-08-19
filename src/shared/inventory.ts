// inventory.ts — さくら側にあるものを棚卸しする（純ロジック）。
//
// ── なぜ要るか（改善案 1-3 / 1-4）────────────────────────────────────
// 2026-08-14、**Koto の記録に無いアプリとレジストリ**が残り、Ryosuke が
// コントロールパネルで消した。非エンジニアにはできない作業である。
// しかも**放置すると毎月お金がかかる**。
//
// 2026-08-18 の実測でも、レジストリが2つ（`data-test-65f6` と `express`）、
// 保存場所が1つ（`koto-data2`）動いていた。合計 935円/月。
// **Koto の画面のどこにも、この合計は出ていない。**
//
// ── いちばん大事な決めごと ──────────────────────────────────────────
// **名前が似ているだけで「これはあなたのです」と言わない。**
// 利用者が自分で作ったものを Koto のものとして扱い、削除させてしまう恐れがある。
// 突き合わせるのは**記録した値との完全一致**だけ（アプリID・レジストリ名・保存場所名）。
// 一致しないものは「心当たりがありません」として、**判断を利用者に返す**。

import { REGISTRY_MONTHLY_YEN, BUCKET_MONTHLY_YEN } from './cloudCost'

export type ResourceKind = 'apprun-app' | 'registry' | 'bucket'

/** さくら側に実在するもの（main が API から集める）。 */
export type ActualResource = {
  kind: ResourceKind
  /** 消すときに使う識別子（アプリはID、レジストリと保存場所は名前）。 */
  id: string
  /** 画面に出す名前。 */
  name: string
}

/** Koto がこのパソコンに持っている記録（1プロジェクト分）。 */
export type LocalRecord = {
  dir: string
  projectName: string
  appIds: string[]
  registryNames: string[]
  bucketNames: string[]
}

export type InventoryRow = {
  kind: ResourceKind
  id: string
  name: string
  /** どのプロジェクトのものか。**null は「心当たりがありません」**。 */
  project: string | null
  /** そのプロジェクトのフォルダ（Koto から破棄する導線に使う）。 */
  dir: string | null
  /** 月額（円・税込）。従量のものは 0 とし、note で説明する。 */
  monthlyYen: number
  note: string
}

/** 種類ごとの月額。**額は cloudCost.ts の一元定義を使う**（2箇所に書かない）。 */
export function monthlyYenFor(kind: ResourceKind): number {
  if (kind === 'registry') return REGISTRY_MONTHLY_YEN
  if (kind === 'bucket') return BUCKET_MONTHLY_YEN
  return 0 // AppRun は従量（最小スケール0なら待機中はほぼゼロ）
}

const KIND_LABEL: Record<ResourceKind, string> = {
  'apprun-app': '公開したアプリ',
  registry: 'イメージの置き場',
  bucket: 'データの保存場所',
}

export function kindLabel(kind: ResourceKind): string {
  return KIND_LABEL[kind]
}

/**
 * プロジェクトの記録から、突き合わせの材料を取り出す（純関数）。
 *
 * 形が違っても落ちない（古い記録・壊れた記録が混ざる）。
 */
export function parseLocalRecords(
  projects: ReadonlyArray<{ dir?: unknown; name?: unknown; apprunState?: unknown; publish?: unknown }>,
): LocalRecord[] {
  return (projects ?? []).map(p => {
    const st = (p.apprunState ?? {}) as { resources?: unknown; meta?: unknown }
    const resources = Array.isArray(st.resources) ? st.resources : []
    const meta = (st.meta ?? {}) as { registryName?: unknown }
    const idsOf = (kind: string): string[] =>
      resources
        .filter((r: any) => r && r.kind === kind && typeof r.id === 'string' && r.id)
        .map((r: any) => String(r.id))
    return {
      dir: typeof p.dir === 'string' ? p.dir : '',
      projectName: typeof p.name === 'string' ? p.name : '',
      appIds: idsOf('apprun-app'),
      bucketNames: idsOf('bucket'),
      registryNames: typeof meta.registryName === 'string' && meta.registryName ? [meta.registryName] : [],
    }
  })
}

/** その資源を記録しているプロジェクトを探す（**完全一致のみ**・純関数）。 */
function ownerOf(res: ActualResource, records: readonly LocalRecord[]): LocalRecord | null {
  for (const r of records) {
    const list = res.kind === 'apprun-app' ? r.appIds : res.kind === 'registry' ? r.registryNames : r.bucketNames
    if (list.some(v => v === res.id || v === res.name)) return r
  }
  return null
}

/**
 * さくら側の実物と、手元の記録を突き合わせて一覧を作る（純関数）。
 *
 * **心当たりの無いものも必ず出す。** 出さなければ、放置されて課金が続く。
 */
export function buildInventory(opts: {
  actual: readonly ActualResource[]
  records: readonly LocalRecord[]
}): InventoryRow[] {
  const order: ResourceKind[] = ['apprun-app', 'registry', 'bucket']
  return [...(opts.actual ?? [])]
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name))
    .map(res => {
      const owner = ownerOf(res, opts.records ?? [])
      const monthlyYen = monthlyYenFor(res.kind)
      return {
        kind: res.kind,
        id: res.id,
        name: res.name,
        project: owner ? owner.projectName : null,
        dir: owner ? owner.dir : null,
        monthlyYen,
        note: owner
          ? (monthlyYen > 0 ? `月額${monthlyYen}円` : '従量（待機中はほぼゼロ）')
          : (monthlyYen > 0
              ? `月額${monthlyYen}円。**このパソコンの Koto には心当たりがありません**`
              : '従量。**このパソコンの Koto には心当たりがありません**'),
      }
    })
}

/** 月額の合計（純関数）。従量のものは含まれない。 */
export function sumMonthly(rows: readonly InventoryRow[]): number {
  return (rows ?? []).reduce((n, r) => n + (Number.isFinite(r.monthlyYen) ? r.monthlyYen : 0), 0)
}

/** 心当たりの無いものの件数（純関数）。 */
export function unknownCount(rows: readonly InventoryRow[]): number {
  return (rows ?? []).filter(r => r.project === null).length
}

/**
 * 合計の伝え方（純関数）。
 *
 * **実額はコントロールパネルで確かめてもらう**（保存場所は容量で変わり、
 * 共有のバケットは按分できない。2026-08-14 の合意）。
 */
export function totalNotice(rows: readonly InventoryRow[]): string {
  const total = sumMonthly(rows)
  const unknown = unknownCount(rows)
  const head = total > 0
    ? `いま分かっているだけで、月額 ${total.toLocaleString()}円（税込）がかかり続けます。`
    : '月額でかかり続けるものは見つかりませんでした。'
  const tail = unknown > 0
    ? `${head}うち ${unknown}件は、このパソコンの Koto に心当たりがありません（別のパソコンで作ったか、手で作ったものかもしれません）。`
    : head
  return `${tail}アプリの実行料金は使った分だけなので、実際の請求はさくらのコントロールパネルでご確認ください。`
}
