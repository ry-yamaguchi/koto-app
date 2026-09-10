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

export type ResourceKind = 'apprun-app' | 'registry' | 'bucket' | 'dedicated-cluster'

/** さくら側に実在するもの（main が API から集める）。 */
export type ActualResource = {
  kind: ResourceKind
  /** 消すときに使う識別子（アプリはID、レジストリと保存場所は名前）。 */
  id: string
  /** 画面に出す名前。 */
  name: string
  /**
   * `apprun-app` のみ意味を持つ、実物の最小スケール（`min_scale`）。
   *
   * ── なぜ持たせたか（roadmap #31・2026-09-09 検分で修理）──────────────
   * 「最初のアクセスが遅くてもよい」以外（＝常時起動）を選べるようになったのに、
   * この棚卸しは**それを知らないまま** `monthlyYenFor('apprun-app')` の 0 だけを見て
   * 「かかり続けるものは無い」と言い切っていた。常時起動を選んだアプリでも
   * `monthlyYen=0` になるのは AppRun が従量課金だからで**正しい**が、
   * 待機中もほぼゼロという注記は min_scale=0 のときしか当たらない。
   *
   * 読み取れない（API から min_scale が返らない）ときは **null**。
   * **0 だと決めつけない**（0 に倒すと「常時課金」を「課金なし」に見せてしまう）。
   */
  scaleMin?: number | null
}

/** Koto がこのパソコンに持っている記録（1プロジェクト分）。 */
export type LocalRecord = {
  dir: string
  projectName: string
  appIds: string[]
  registryNames: string[]
  bucketNames: string[]
  /**
   * 専有型のクラスタID（`.sakuraide.json` の `publish.apprunDedicated.clusterID`）。
   * fs を読む必要があるため、ここ（純関数の parseLocalRecords）では埋められない。
   * 呼び出し側（main/ipc/cloud.ts）が `readApprunDedicatedFs` で読んでから足す
   * （既定は空配列＝突き合わせなし）。
   */
  clusterIds: string[]
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
  /** `apprun-app` のみ意味を持つ最小スケール。読み取れなければ null（0と決めつけない）。 */
  scaleMin: number | null
  note: string
}

/** 種類ごとの月額。**額は cloudCost.ts の一元定義を使う**（2箇所に書かない）。 */
export function monthlyYenFor(kind: ResourceKind): number {
  if (kind === 'registry') return REGISTRY_MONTHLY_YEN
  if (kind === 'bucket') return BUCKET_MONTHLY_YEN
  return 0 // AppRun は従量課金（固定の月額は無い。常時起動かどうかは costNote が scaleMin から判断する）
}

/**
 * 費用の状態を1行で表す（純関数）。**唯一の定義**（画面側で同じ判定を複製しない・掟10）。
 *
 * `apprun-app` は従量課金なので、いくら分かっても金額は書かない
 * （使い方によって変わる。確かめていない数字を書かない・掟1）。
 * その代わり、min_scale から「止まる／常時動く／分からない」だけを伝える。
 * **min_scale が読み取れないときは「不明」とし、0 に倒さない**
 * （倒すと、常時課金しているアプリを「課金なし」に見せてしまう。2026-09-09 検分で発見）。
 */
export function costNote(row: { kind: ResourceKind; monthlyYen: number; scaleMin?: number | null }): string {
  if (row.kind === 'apprun-app') {
    const min = row.scaleMin ?? null
    if (min === null) return '不明（常時動く設定かどうか判断できません）'
    if (min >= 1) return '常時動く設定（料金がかかり続けます）'
    return '従量（待機中はほぼゼロ）'
  }
  // 専有型のクラスタは常時課金（プラン契約）だが、金額はプラン次第で分からない。
  // 0円と決めつけない（棚卸しから外れていた穴の直し）。
  if (row.kind === 'dedicated-cluster') return '常時課金（金額はプラン次第・コントロールパネルで確認）'
  return row.monthlyYen > 0 ? `月額${row.monthlyYen}円` : '従量'
}

const KIND_LABEL: Record<ResourceKind, string> = {
  'apprun-app': '公開したアプリ',
  registry: 'イメージの置き場',
  bucket: 'データの保存場所',
  'dedicated-cluster': '専有型のクラスタ',
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
      // fs（.sakuraide.json）を読む必要があるため、ここでは埋められない（既定は空配列）。
      // main/ipc/cloud.ts が readApprunDedicatedFs で読んでから足す。
      clusterIds: [],
    }
  })
}

/** その資源を記録しているプロジェクトを探す（**完全一致のみ**・純関数）。 */
function ownerOf(res: ActualResource, records: readonly LocalRecord[]): LocalRecord | null {
  for (const r of records) {
    const list =
      res.kind === 'apprun-app' ? r.appIds
      : res.kind === 'registry' ? r.registryNames
      : res.kind === 'dedicated-cluster' ? r.clusterIds
      : r.bucketNames
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
  const order: ResourceKind[] = ['apprun-app', 'registry', 'bucket', 'dedicated-cluster']
  return [...(opts.actual ?? [])]
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name))
    .map(res => {
      const owner = ownerOf(res, opts.records ?? [])
      const monthlyYen = monthlyYenFor(res.kind)
      // apprun-app 以外は scaleMin に意味が無い（渡ってきても無視する）。
      const scaleMin = res.kind === 'apprun-app' ? (res.scaleMin ?? null) : null
      const status = costNote({ kind: res.kind, monthlyYen, scaleMin })
      return {
        kind: res.kind,
        id: res.id,
        name: res.name,
        project: owner ? owner.projectName : null,
        dir: owner ? owner.dir : null,
        monthlyYen,
        scaleMin,
        note: owner ? status : `${status}。**このパソコンの Koto には心当たりがありません**`,
      }
    })
}

/**
 * `apprun-app` のうち、**費用がかかり続けている／かかり続けていないと言い切れない**もの
 * があるか（純関数）。`dedicated-cluster`（専有型のクラスタ）は常時課金なので、
 * 1件でもあれば常に true（金額が分からなくても「無い」とは言い切れない）。
 *
 * 常時起動（min≥1）は従量課金でも確実に費用が発生し続ける。min が不明のときも、
 * 「無い」とは言い切れない（0 と決めつけない・掟1）。totalNotice が
 * 「かかり続けるものは見つかりませんでした」と誤って言い切らないための判定。
 */
function hasOngoingOrUnknownAppRunCost(rows: readonly InventoryRow[]): boolean {
  return (rows ?? []).some(r =>
    (r.kind === 'apprun-app' && (r.scaleMin === null || (r.scaleMin ?? 0) >= 1))
    || r.kind === 'dedicated-cluster',
  )
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
  // ⚠️ AppRun は従量課金なので sumMonthly には乗らない（monthlyYenFor が常に0を返す）。
  // だが常時起動（min≥1）や min不明のアプリは、金額こそ分からなくても「かかり続けるものは
  // 無い」とは言い切れない（2026-09-09 検分で発見: 常時起動を選んでもここが「見つかりません
  // でした」と断言していた）。total=0 でもこれが true なら、無いと言い切らない文にする。
  const ongoingUnknown = hasOngoingOrUnknownAppRunCost(rows)
  const head = total > 0
    ? `いま分かっているだけで、月額 ${total.toLocaleString()}円（税込）がかかり続けます。`
    : ongoingUnknown
      ? '月額として金額が分かるものはありませんが、常時動く設定のアプリなどがあり、費用がかかり続けている可能性があります。'
      : '月額でかかり続けるものは見つかりませんでした。'
  const tail = unknown > 0
    ? `${head}うち ${unknown}件は、このパソコンの Koto に心当たりがありません（別のパソコンで作ったか、手で作ったものかもしれません）。`
    : head
  return `${tail}アプリの実行料金は使った分だけなので、実際の請求はさくらのコントロールパネルでご確認ください。`
}
