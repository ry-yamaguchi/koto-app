// apprunTraffic.ts — トラフィック配分（AppRun共用型）を読み・分類し、ロールバックの
// PUT本文を組み立てる、唯一の場所（roadmap #32・掟10）。
//
// ── なぜ要るか ────────────────────────────────────────────────────────
// さくらの開発者から「トラフィックの割り当てを変えることで、A/Bテストやロールバックが
// できる」と助言があった（docs/roadmap.md）。**A/Bテストは対象外。ロールバックだけ**を
// 入れる。「公開したら壊れた → 前に戻す」は、Koto の利用者（非エンジニア）の安心に直結する。
//
// ── 「罠」という誤った前提から始まっていた（2026-09-08 検分で訂正）────────────────
// 当初はここに「戻したままにすると、次に公開しても反映されない」という「罠」を書き、
// それを設計の前提にしていた。**これは確かめずに断定した誤りだった。**
//
// 事実（実物で確認・掟1）:
//   - Koto の再公開（PATCH /applications/{id}）は必ず all_traffic_available: true を送る
//     （src/main/cloud/client.ts の buildPatchBody。**Koto 自身のコード**で確認できる）
//   - 原本 apprun-shared.json v1.5.0 の定義: all_traffic_available は
//     「アプリケーションを最新のバージョンにすべてのトラフィックを割り当てるかどうか」
//   → **公開し直せば固定は解除され、最新のバージョンが配信される。**
//     「戻した → 直して公開した → 何も変わらない」は起きない。
//
// なぜ間違えたか: さくらの開発者の助言を読んだ時点で「固定は持続する」という仮説を立て、
// **原本の all_traffic_available の定義や、Koto 自身の buildPatchBody を確認しないまま**
// それを設計の前提にし、警告文を書き、テストでもその文言を固定してしまった。掟1
// （一次情報を見る・推測で実装しない）を、外部サービスだけでなく自分のコードに対しても
// 怠っていた、というのがこの失敗の形。
//
// ── いまの設計 ────────────────────────────────────────────────────────
//   1. 固定されている間は、画面に「訪問者には固定した版が見えていること」と
//      「Koto から公開し直せば最新に戻ること（固定は解除されること）」を伝え続ける
//      （`pinnedNotice`）
//   2. 公開せずに固定だけ解除したい場面のために、最新に追従する状態へ戻すボタンは残す
//      （`buildRollbackBody(null)`）
//   3. 公開が成功した直後は、**実際に配分を読み直す**。最新追従に戻っていれば何も出さない
//      （想定どおりの挙動）。もし読み直してもまだ固定されたままなら、その事実をそのまま出す
//      （`pinnedAfterApplyNotice`。断定せず、読んだ事実を見せる——想定が外れたときに
//      気づける形にする）
// の3つを必ず揃える（呼び出し側は AppRunPanel.tsx・RollbackSection.tsx）。
//
// ── さくらの契約（原本 apprun-shared.json v1.5.0・掟1）───────────────────
//   GET /applications/{id}/versions
//     応答: { data: [{ created_at, id, name, status }], meta }
//   GET /applications/{id}/traffics
//     応答: { data: [{ is_latest_version, percent, version_name }], meta }
//   PUT /applications/{id}/traffics
//     本文: 配列。各要素は {is_latest_version, percent} または {version_name, percent}
//
// **応答の形は原本どおりに読む。よくあるキーを順に試す推測を書かない**
// （docs/apprun-dedicated-plan.md 5-8 の事故と同じ形を作らないため）。
// data が配列でなければ空配列を返す。
//
// electron 非依存・DOM非依存の純関数のみ（renderer からも import されるため node の
// path/fs は禁止。apprunDedicatedShapes.ts と同じ理由）。

// ── GET /applications/{id}/traffics の1行 ────────────────────────────
export type TrafficRow = {
  versionName: string | null
  percent: number
  isLatest: boolean
}

/** 応答から配分の一覧を読む。形が違えば（data が配列でなければ）空配列。 */
export function readTraffics(data: unknown): TrafficRow[] {
  const list = (data as any)?.data
  if (!Array.isArray(list)) return []
  return list.map((item): TrafficRow => {
    const d = item as any
    return {
      versionName: typeof d?.version_name === 'string' ? d.version_name : null,
      // 原本の percent は数値（0-100）。文字列等が混じっても壊れないよう、
      // 数値でなければ 0 として扱う（推測で補正しない）。
      percent: typeof d?.percent === 'number' ? d.percent : 0,
      isLatest: d?.is_latest_version === true,
    }
  })
}

// ── GET /applications/{id}/versions の1行 ─────────────────────────────
export type VersionRow = {
  id: string | null
  name: string | null
  status: string | null
  createdAt: string | null
}

/** 応答からバージョン一覧を読む。形が違えば（data が配列でなければ）空配列。 */
export function readVersions(data: unknown): VersionRow[] {
  const list = (data as any)?.data
  if (!Array.isArray(list)) return []
  return list.map((item): VersionRow => {
    const d = item as any
    return {
      id: typeof d?.id === 'string' ? d.id : null,
      name: typeof d?.name === 'string' ? d.name : null,
      status: typeof d?.status === 'string' ? d.status : null,
      createdAt: typeof d?.created_at === 'string' ? d.created_at : null,
    }
  })
}

// ── いまの配分を、利用者に伝える形へ分類する ───────────────────────────────
export type TrafficState =
  /** 最新のバージョンへ自動で追従している（is_latest_version が 100%）。 */
  | { kind: 'latest' }
  /** 特定のバージョンに 100% 固定されている（＝ロールバック中）。 */
  | { kind: 'pinned'; versionName: string }
  /**
   * 複数のバージョンに分かれている可能性がある（A/Bテスト中など）——または、
   * 応答が読めず判断できなかった（readTraffics が空配列を返す場合を含む）。
   * どちらであるかは区別できないので、画面側は断定しない言い方をする（4【低】）。
   */
  | { kind: 'split' }

/**
 * 配分の行から状態を判断する（純関数）。
 *
 * **分からないものを「最新追従」に倒さない。** 単独の行が100%でも、バージョン名が
 * 読めない・is_latest_version でもない中途半端な形は `split`（＝分類として「分からない」
 * 状態。画面での操作自体は禁じない）として扱う。読めない・判断できないときに
 * 「大丈夫（最新に追従している）」と決めつけるのが、今日いちばん避けたい欠陥だから
 * （CLAUDE.md「分からないものを『大丈夫』に倒さない」の教訓）。
 */
export function trafficState(rows: TrafficRow[]): TrafficState {
  const active = rows.filter(r => r.percent > 0)
  if (active.length !== 1) return { kind: 'split' } // 0件（読めない）・複数件（分散）はどちらも split
  const only = active[0]
  if (only.percent !== 100) return { kind: 'split' } // 100%に満たない単独行は中途半端＝分からない
  if (only.isLatest) return { kind: 'latest' }
  if (only.versionName) return { kind: 'pinned', versionName: only.versionName }
  return { kind: 'split' } // is_latest でもなく、名前も読めない → 判断できない
}

// ── PUT /applications/{id}/traffics の本文 ────────────────────────────
/**
 * ロールバック（またはその解除）の本文を組み立てる。
 * `versionName` が文字列ならそのバージョンへ 100% 固定、
 * `null` なら「最新に追従」へ戻す（is_latest_version:true, percent:100）。
 */
export function buildRollbackBody(versionName: string | null): unknown[] {
  return versionName === null
    ? [{ is_latest_version: true, percent: 100 }]
    : [{ version_name: versionName, percent: 100 }]
}

// ── 画面に出す文言（ここに集約し、2箇所で表現がずれないようにする） ────────────
/**
 * 固定されている間、画面に出し続ける警告。
 *
 * ★2026-09-08 検分で訂正: 以前は「この状態では、公開しても反映されません」という
 * **誤った**（確かめずに断定した）文言だった。実際は公開し直せば固定は解除される
 * （ファイル冒頭のコメント参照）。事実——①訪問者には固定した版が見えていること、
 * ②公開し直せば最新に戻ること——を伝える文言にする。
 */
export function pinnedNotice(versionName: string): string {
  return `⚠️ いま『${versionName}』に固定されています。訪問者にはこのバージョンが見えています。Koto から公開し直すと、最新のバージョンに戻ります（固定は解除されます）。`
}

/**
 * 公開（apply）が成功した直後、**実際に配分を読み直して**それでもまだ固定されたままの
 * ときだけ出す警告（呼び出し側 AppRunPanel.tsx が getTraffics で読み直してから呼ぶ）。
 *
 * 公開し直せば固定は解除されるはずなので、通常このケースには入らない
 * （＝この関数はふだん呼ばれない）。それでも固定されたままなら、それは**想定と違う
 * 状態**なので、断定せず読んだ事実をそのまま伝える。
 *
 * ★2026-09-08 検分で訂正: 以前は「いま公開したものは反映されていません」という、
 * まるで通常運転であるかのような文言だった（この経路自体、誤った前提の上にあった）。
 */
export function pinnedAfterApplyNotice(versionName: string): string {
  return `⚠️ 公開しましたが、いまも『${versionName}』に固定されています（想定と違う状態です）。『最新に戻す』を押してください。`
}

/** バージョン一覧の各行に「いま配信中」を付けるための判定材料（配分が乗っている名前）。 */
export function servingVersionNames(rows: TrafficRow[]): string[] {
  return rows.filter(r => r.percent > 0 && r.versionName).map(r => r.versionName as string)
}
