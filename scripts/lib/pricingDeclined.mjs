// pricingDeclined.mjs — 「公式の料金表にはあるが、Koto には入れない」と決めたモデルの一覧（1か所）。
// scripts/check-pricing.mjs（npm run check:pricing）が読む。これに載せると、料金が一致している間は
// 毎週の照合で「新顔」として失敗しない。
//
// 決めごと（2026-11-25）:
// - 確かめた日（checkedAt）が古くなっても知らせない。見直したいときは作者が自分で見る。
// - 載せたモデルの料金が公式で変わったとき、公式の料金表から消えたときは、これまでどおり失敗にする
//   （入れるか・一覧から外すかを決め直すため）。
// - PRICING や MODELS に同じ id があると矛盾として失敗にする（入れたなら一覧から外す）。
// - アプリの提供モデルの一覧を絞る NON_CHAT（appConfig.mjs）にはこの手のモデルを足さない
//   （Koto が出すモデルの一覧まで絞ってしまう）。
//
// 1件の形: { id, name, reason, checkedAt, price: { in, out } }
//   id        … apiIdCandidate と同じ（通常 → 表の名前そのまま、プレビュー → 'preview/'＋表の名前）
//   checkedAt … 入れないと確かめた日（YYYY-MM-DD・未来は不可）
//   price     … 公式の料金表の値。PRICING と同じ単位（円/100万トークン）

export const DECLINED = [
  {
    id: 'preview/Kimi-K2.6',
    name: 'Kimi-K2.6',
    reason: '公式の料金表にはあるが、提供モデルの一覧（API）に無い',
    checkedAt: '2026-11-20',
    // id と料金は 2026-11-25 に公式の料金表（プレビューの区分）で確かめた。
    // checkedAt（2026-11-20）は「提供モデルの一覧（API）に無い」を確かめた日。
    price: { in: 60, out: 300 }, // 0.6 / 3 円（1万トークン）
  },
]
