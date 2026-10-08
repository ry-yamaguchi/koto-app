// teardownSupport.ts — 公開先ごとに「Koto から破棄できるか」を判定する（純粋ロジック）。
//
// ── なぜ一元化するのか（2026-08-09 Ryosuke の指摘）──────────────────────
// 破棄の導線を「③公開」の各パネル以外にも増やす（📡 公開したもの一覧・プロジェクト削除時）。
// 公開先は5つあるが**破棄の口があるのは3つだけ**（AppRun 共用型・専有型・HANAMII）なので、置き場所ごとに判定を書くと
// 「押しても何も起きないボタン」がどこかに生まれる。判定はここ1箇所に置く。
//
// 破棄できない2つは、サービス側で消してもらうしかない。**消す方法を必ず添える**こと。
// 「できません」だけでは、月額課金が続くものを放置させることになる。

import type { PublishTargetKind } from '../renderer/publishStatus'

/** Koto から破棄できるか。'manual' はサービス側で消してもらう。 */
export type TeardownSupport = 'supported' | 'manual'

/**
 * その公開先を Koto から破棄できるか。
 * - `sakura-apprun` … `cloud:teardown`（アプリ＋コンテナレジストリ）
 * - `sakura-apprun-dedicated` … 専有型のアプリ（全バージョン）だけ。クラスタ・ロードバランサは
 *   専有型タブの⑥で別に破棄する（2026-09-11 Ryosuke 決定。実際の削除呼び出しは D-4 でつなぐ）
 * - `hanamii`       … `hanamii:teardown`（プロジェクト削除＋保存場所の片づけ。2026-09-25〜）
 * - `vercel` / `sakura-rental` … 破棄の実装が無い
 */
export function teardownSupport(target: PublishTargetKind): TeardownSupport {
  return target === 'sakura-apprun' || target === 'sakura-apprun-dedicated' || target === 'hanamii'
    ? 'supported'
    : 'manual'
}

/**
 * 破棄できない公開先について、どこで消せばよいかを伝える文。
 * 画面には素のテキストとして出るので、Markdown 記法は使わない（v0.2.98 の教訓）。
 */
export function manualTeardownGuide(target: PublishTargetKind): string {
  switch (target) {
    case 'vercel':
      // **鍵のことを落とさない**（2026-09-24 検分の指摘13）。2026-09-24 から、Vercel への公開は
      // さくらのオブジェクトストレージへ読み書きできる鍵（`koto-<名前>_vercel`）を1本発行する。
      // Vercel のプロジェクトを消しても鍵は残り、Koto 側には Vercel 向けの片づけの口が無いので、
      // **案内どおり片づけたのに、消したはずのアプリの鍵が生き続ける。**
      // Koto に鍵を無効にする画面はまだ無いので、**どこで消せるかを正直に書く**（無い導線を案内しない）。
      return 'Koto からは消せません。次の2つを自分で消してください。'
        + '①Vercel のダッシュボード（vercel.com）で、Vercel のプロジェクトを削除。'
        + '②さくらのクラウドのコントロールパネルで、鍵「koto-<プロジェクト名>_vercel」を削除'
        + '（オブジェクトストレージのパーミッション）。'
        + '保存場所（バケット）自体は、ほかの公開先と共有していることがあるため残ります。'
    case 'sakura-rental':
      return 'Koto からは削除できません。さくらのレンタルサーバのファイルマネージャか FTP で、'
        + 'アップロードしたファイルを削除してください。'
    default:
      return ''
  }
}

/** 破棄したときに、その公開先で何が消えるかの一言（確認画面用）。 */
export function teardownScopeNote(target: PublishTargetKind): string {
  switch (target) {
    case 'sakura-apprun':
      return 'AppRun のアプリを削除します。'
    case 'sakura-apprun-dedicated':
      // クラスタ・LB は月額が続く資源なので、「アプリだけ消える」ことを必ず伝える
      return '専有型のアプリ（全バージョン）を削除します。クラスタ・ロードバランサは残ります（消すまで課金が続きます）。消すときは専有型タブの⑥から。'
    case 'hanamii':
      return 'HANAMII のプロジェクトを削除します。'
    default:
      return ''
  }
}

/**
 * 破棄したときに、保存場所のデータがどうなるかを伝える文（確認画面用）。
 *
 * ── なぜ別の文が要るのか（2026-08-14）────────────────────────────────
 * 破棄の確認画面は「アプリとレジストリを消します」としか言っていなかった。
 * だが永続データを使うプロジェクトでは、**利用者が入れたデータも消える**。
 * それを言わずに押させてはいけない。
 *
 * 実際に何が消えるかの判断は `src/shared/objectStorage.ts` の `teardownPlanFor`
 * が中身を一覧してから決める（ほかのプロジェクトや、利用者が自分で置いた
 * ファイルがあれば保存場所そのものは残す）。**ここはその約束を先に伝える**。
 *
 * 画面には素のテキストとして出るので、Markdown 記法は使わない（v0.2.98 の教訓）。
 */
export function teardownDataNote(placement: { bucket: string; prefix?: string; shared?: boolean } | null | undefined): string {
  if (!placement || typeof placement.bucket !== 'string' || placement.bucket.length === 0) return ''
  const head = `保存場所『${placement.bucket}』にある、このプロジェクトのデータも削除します。`
  const keep = 'ほかのプロジェクトのデータや、あなたが自分で置いたファイルは残します。'
  return placement.shared === false
    ? `${head}${keep}残るものが無ければ、保存場所そのものも削除して月額を止めます。`
    : `${head}${keep}この保存場所を使っているプロジェクトがほかに無ければ、保存場所そのものも削除して月額を止めます。`
}

/**
 * その破棄が、**保存場所（バケット・プレフィックス・データ）まで片づけるか**
 * （2026-09-24 検分の指摘7 ／ 2026-09-25 検分で HANAMII を実物に合わせた）。
 *
 * ── なぜ要るか ────────────────────────────────────────────────────
 * 📡 公開したもの一覧の「🗑 破棄」は、専有型では **`apprunDedicated:teardownApp`（appOnly）**
 * ＝**アプリだけ**を消す操作で、保存場所へは1件も要求を出さない
 * （tests/apprunDedicatedStorageTeardown.test.ts が固定している）。にもかかわらず確認画面は
 * 「保存場所のデータも削除します…保存場所そのものも削除して月額を止めます」と出していた。
 * **消えたと思って確認もしない＝いちばん気づけない形で、月額495円が残り続ける。**
 *
 * ここに判断を1つだけ置き、📡 の確認も専有型⑥の確認も**同じ関数を通す**（掟10）。
 *
 * - `scope: 'list'` … 📡 一覧の「🗑 破棄」ボタン（専有型はアプリだけ）
 * - `scope: 'full'` … 専有型タブの⑥「すべて削除する」（計算資源＋保存場所）
 *
 * ── ⚠️ ここが true でも、実物がそうしている保証にはならない（2026-09-25 検分）──────
 * 2026-09-25 まで HANAMII は**ここだけ true で、実物は保存場所へ1件も要求を出していなかった**
 * （`hanamii:teardown` は HANAMII のプロジェクトを消すだけだった）。確認画面が
 * 「保存場所そのものも削除して月額を止めます」と言い切るので利用者はコントロールパネルを
 * 見に行かず、**月額495円が止まらないまま、消したはずのアプリの鍵がバケットへ
 * 読み書きできるまま生き残っていた**——専有型で直したのとまったく同じ形。
 * いまは `hanamii:teardown` が共用型・専有型と同じ `teardownStorageForProject` を通る。
 *
 * **ここで true にする公開先は、実際に削除の要求を出すことを振る舞いのテストで固定してある**
 * （掟10「お金・破壊の歯止めは、振る舞いで固定する」）:
 *
 * - `sakura-apprun` … `cloud:teardown`（delete プラン）
 * - `hanamii` … `hanamii:teardown` → `teardownStorageForProject` ／ tests/hanamiiStorageTeardown.test.ts
 * - `sakura-apprun-dedicated`（`'full'` のみ）… ⑥ ／ tests/apprunDedicatedStorageTeardown.test.ts
 *
 * **新しい公開先をここで true にするときは、先に振る舞いのテストを書くこと。**
 */
export function teardownRemovesStorage(target: PublishTargetKind, scope: 'list' | 'full'): boolean {
  // `'full'` を持つのは専有型タブの⑥「すべて削除する」だけ（上のコメントの列挙どおり）。
  // **ここも書き下す**（2026-09-25 検分の指摘25）。`if (scope === 'full') return true` と書くと、
  // 公開先を見ずに全部 true ＝「保存場所そのものも削除して月額を止めます」と言い切ってしまう。
  // いま 'full' を渡すのが専有型だけなので実害は無かったが、**すぐ下の 'list' で閉じたはずの穴
  //（公開先を足すと黙って true に落ちる）が、直した行の隣にそのまま残っていた。**
  if (scope === 'full') return target === 'sakura-apprun-dedicated'
  // 📡 一覧からの破棄で保存場所まで片づけるのは、共用型 AppRun（cloud:teardown の delete プラン）と
  // HANAMII（hanamii:teardown が teardownStorageForProject を通る）。専有型は appOnly なので触らない。
  // **片づける側を書き下す。** `!== 'sakura-apprun-dedicated'` のような除外で書くと、
  // 破棄の口すら無い Vercel・レンタルサーバまで「片づけます」側に入り、
  // 公開先を足したときも黙って true に落ちる（掟10「名前の一覧は書き下す」）。
  return target === 'sakura-apprun' || target === 'hanamii'
}

/**
 * 破棄の確認画面に出す「保存場所はどうなるか」の一言（`teardownDataNote` の出し分け）。
 *
 * 片づけない破棄では、**残ることと、どこから消せるかを言う**。「言わない」では足りない——
 * 利用者は⑥の確認で見た文面を覚えていて、📡 からでも同じことが起きたと受け取る。
 */
export function teardownDataNoteFor(opts: {
  target: PublishTargetKind
  scope: 'list' | 'full'
  placement: { bucket: string; prefix?: string; shared?: boolean } | null | undefined
}): string {
  const p = opts.placement
  if (!p || typeof p.bucket !== 'string' || p.bucket.length === 0) return ''
  if (teardownRemovesStorage(opts.target, opts.scope)) return teardownDataNote(p)
  return `保存場所『${p.bucket}』とその中のデータは残ります（消すまで月額が続きます）。`
    + storageLeftoverGuide(opts.target)
}

/**
 * 破棄の確認画面に出す「保存場所はどうなるか」の一言を、**同意済みの保存場所の全件**で組み立てる
 * （2026-09-25 検分の指摘5）。
 *
 * ── なぜ全件なのか ────────────────────────────────────────────────
 * 破棄は `teardownStorageForProject` が `for (const placement of placements)` で**全件**を
 * 片づける。ところが確認画面は `storage:placement` の `placement`（**先頭1件**）だけで
 * 文を組み立てていたので、env.json に保存場所が2件ある状態では
 * 「保存場所『A』…のデータも削除します」としか出ないまま、**名前が一度も出なかった『B』と
 * その中のデータまで消えた**。元に戻せない削除を、名指ししないまま実行させてはいけない
 * （掟10「お金・破壊の歯止め」）。**確認で見せるものと、実際に消すものを一致させる。**
 *
 * 1件のときは `teardownDataNoteFor` とまったく同じ文を返す（文言を二重管理しない）。
 * 画面には素のテキストとして出るので、Markdown 記法は使わない（v0.2.98 の教訓）。
 */
export function teardownDataNoteForAll(opts: {
  target: PublishTargetKind
  scope: 'list' | 'full'
  placements: Array<{ bucket: string; prefix?: string; shared?: boolean }> | null | undefined
}): string {
  const list = (opts.placements ?? []).filter(p => p && typeof p.bucket === 'string' && p.bucket.length > 0)
  if (list.length === 0) return ''
  if (list.length === 1) return teardownDataNoteFor({ target: opts.target, scope: opts.scope, placement: list[0] })
  const names = list.map(p => `『${p.bucket}』`).join('')
  if (teardownRemovesStorage(opts.target, opts.scope)) {
    return `保存場所${names}にある、このプロジェクトのデータも削除します。`
      + 'ほかのプロジェクトのデータや、あなたが自分で置いたファイルは残します。'
      + 'それぞれの保存場所を使っているプロジェクトがほかに無ければ、保存場所そのものも削除して月額を止めます。'
  }
  return `保存場所${names}とその中のデータは残ります（消すまで月額が続きます）。`
    + storageLeftoverGuide(opts.target)
}

/**
 * 片づけない破棄で「どこから消せるか」を添える（**公開先ごとに出し分ける**）。
 *
 * 前は公開先を見ずに「専有型タブの⑥から」と言い切っていた。いまは専有型しかこの枝へ
 * 来ないので実害は無かったが、**無い導線を案内する形**（manualTeardownGuide の
 * Vercel と同じ轍）がいつでも起きうる。`teardownRemovesStorage` を false 側に足した
 * 公開先が、そのまま専有型の⑥へ案内されることが無いようにする。
 */
function storageLeftoverGuide(target: PublishTargetKind): string {
  return target === 'sakura-apprun-dedicated'
    ? '保存場所ごと消すには、専有型タブの⑥「すべて削除する」から破棄してください。'
    : 'さくらのクラウドのコントロールパネル（オブジェクトストレージ）から削除してください。'
}
