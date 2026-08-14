// cloudCost.ts — さくらのクラウドの「消し忘れると課金が続く資源」の説明（純粋ロジック）。
//
// ── 背景（2026-08-06 ユーザー指摘・公式情報で裏取り済み） ──────────────────
// AppRun で公開すると、Koto は裏で**コンテナレジストリ**を1つ用意する（イメージの置き場）。
//   ・AppRun共用型 … 時間額のみ。**アプリを削除すれば課金は止まる**
//     （課金対象は「インスタンスの作成が開始されたタイミングから削除が完了したタイミングまで」）
//   ・コンテナレジストリ … **月額220円（税込）の固定料金**・ストレージ5GiB込み・**無料枠なし**
//
// つまり **AppRunアプリを消してもレジストリが残れば月220円がかかり続ける**。
// Koto はこの費用をどこにも表示しておらず、「破棄」を押さずにプロジェクトを消した人は
// 気づかないまま課金され続ける状態だった。
//
// 一次情報:
//   https://cloud.sakura.ad.jp/products/container-registry/   （220円 ストレージ5GiB/1レジストリ）
//   https://cloud.sakura.ad.jp/products/apprun-shared/        （時間額のみ。月額設定なし）
//   https://manual.sakura.ad.jp/cloud/payment/server-charge.html（課金対象期間）
//
// 金額はサービス側の改定で変わり得るため、**1箇所だけに書く**（画面の文言はここを参照する）。

/** コンテナレジストリの月額（税込・円）。2026-08-06 時点の公表値。 */
export const REGISTRY_MONTHLY_YEN = 220

/**
 * オブジェクトストレージの基本料金（税込・**バケット1つあたり**・月額）。
 *
 * 公式マニュアルの原文: 「『バケット』ごとに料金が発生します」。
 * **サイト単位ではなくバケット単位**なので、プロジェクトごとにバケットを作ると
 * 積み上がる（3プロジェクトで月1,485円）。だから既定は1つを共有し、
 * プレフィックスで分ける（src/shared/objectStorage.ts）。
 *
 * 100GiB・10万リクエスト・転送10GiB を含む。**日割なし・無料枠なし**なので、
 * 1日だけ使っても満額かかる。レジストリと同じく**消し忘れると課金が続く**。
 *   https://cloud.sakura.ad.jp/products/object-storage/
 */
export const BUCKET_MONTHLY_YEN = 495

/** レジストリ料金に含まれるストレージ（GiB）。 */
export const REGISTRY_INCLUDED_STORAGE_GIB = 5

// ── 文言に Markdown 記法を書かないこと（2026-08-09 ユーザー指摘）───────────
// ここが返す文字列は、画面では素のテキストとして描画され、破棄の結果メッセージには
// そのまま連結される。**強調** と書いても太字にはならず、`**` が画面にそのまま出る。
// 強調が要る箇所は呼び出し側の CSS（色・太さ）で行い、文言では語順で優先度を示す。
// この決まりは tests/cloudCost.test.ts の「画面文言に Markdown 記法を混ぜない」で固定している。

/**
 * 公開の直後に出す、**止まらない費用**（2026-08-14 Ryosuke と設計を合意）。
 *
 * ── なぜ「合計」で言い切らないのか ────────────────────────────────────
 * 最初は保存場所の495円を足した合計を出そうとしたが、Ryosuke の指摘で改めた:
 *
 *   ① **共有の保存場所は、プロジェクト単位に割れない。** 3つのプロジェクトが
 *      1つの保存場所を共有していると、それぞれの画面で「＋495円」と出すことになり、
 *      合わせて1,485円に見える。実際は495円。**足すと嘘になる。**
 *   ② **月額は固定ではない。** 495円に含まれるのは 100GiB・10万リクエスト・
 *      転送10GiB まで。超えれば増える（レジストリの5GiBも同じ）。
 *
 * そこで「**このプロジェクトだけのものは合計に入れ、共有のものは別に書き、
 * 実額はコントロールパネルで確かめてもらう**」形にした。
 * 金額を文頭に置くのはこれまでどおり（小さな文字なので読み飛ばされる）。
 */
export function ongoingCostNotice(opts: {
  registryName: string | null
  /** このプロジェクトの保存場所（用意していなければ null）。 */
  bucket: { name: string; shared: boolean } | null
}): string {
  // 合計に入れるのは**このプロジェクトだけのもの**。共有のものは割れないので入れない
  const dedicated = opts.bucket && !opts.bucket.shared ? opts.bucket : null
  const total = REGISTRY_MONTHLY_YEN + (dedicated ? BUCKET_MONTHLY_YEN : 0)

  const items = [`イメージの置き場（コンテナレジストリ${opts.registryName ? `『${opts.registryName}』` : ''}）`]
  if (dedicated) items.push(`データの保存場所『${dedicated.name}』`)

  let out = `月額${total}円（税込）がかかり続けます。内訳: ${items.join('と')}。`

  if (opts.bucket && opts.bucket.shared) {
    out += `データの保存場所『${opts.bucket.name}』はほかのプロジェクトと共有のため、`
      + `このプロジェクト分としては出せません（保存場所1つにつき月額${BUCKET_MONTHLY_YEN}円・税込）。`
  }

  out += `保存した量や通信量によって変わるため、実際の請求額はさくらのクラウドのコントロールパネルでご確認ください。`
  out += opts.bucket
    ? `使い終わったら「🗑 破棄する」で削除してください（AppRunアプリを消すだけでは、どちらも止まりません）。`
    : `使い終わったら「🗑 破棄する」で削除してください（AppRunアプリを消すだけでは止まりません）。`
  return out
}

/** 公開の直後に出す、費用の一言（放置しても止まらない分だけを伝える）。 */
export function registryCostNotice(registryName: string | null): string {
  const name = registryName ? `『${registryName}』` : ''
  // 金額を文頭に置く。枠の中の小さな文字なので、読み飛ばされても最初の一行で額が目に入るようにする。
  return `月額${REGISTRY_MONTHLY_YEN}円（税込・ストレージ${REGISTRY_INCLUDED_STORAGE_GIB}GiBまで）がかかり続けます。`
    + `イメージの置き場としてコンテナレジストリ${name}を使っているためです。`
    + `使い終わったら「🗑 破棄する」で削除してください（AppRunアプリを消すだけでは止まりません）。`
}

/** 破棄の確認画面に出す、レジストリ削除チェックの説明。 */
export function registryDeleteLabel(registryName: string | null): string {
  return `コンテナレジストリ${registryName ? `『${registryName}』` : ''}も削除する`
}

export function registryDeleteHelp(deleteIt: boolean): string {
  return deleteIt
    ? `月額${REGISTRY_MONTHLY_YEN}円（税込）の課金が止まります。中の登録済みイメージも消えます。`
      + `心当たりのない名前のときはチェックを外してください。`
    : `レジストリは残ります。月額${REGISTRY_MONTHLY_YEN}円（税込）の課金は続きます。`
      + `後で消す場合は、さくらのクラウドのコントロールパネルから削除してください。`
}

/**
 * どのレジストリを使っているかの記録が無いときに、破棄の確認画面へ出す注意。
 *
 * 記録が無いと registryDeletionTarget が「対象不明」を返すので、**チェックを入れても
 * 削除されない**。「削除する」と書いてあるのに削除できないチェックは誤解しか生まないため、
 * チェック自体を出さずにこの文を出す（2026-08-09 の実機検証で発覚）。
 * v0.2.94 以前に公開した環境や、v0.2.99 以前の破棄で記録を失った環境が該当する。
 */
export function registryUnknownNotice(): string {
  return `このプロジェクトがどのコンテナレジストリを使っているかの記録がないため、`
    + `Koto からは削除できません。さくらのクラウドのコントロールパネルで確認し、`
    + `不要なら削除してください（残すと月額${REGISTRY_MONTHLY_YEN}円・税込がかかり続けます）。`
}

/**
 * 破棄すると公開URLが変わることを伝える一文。
 *
 * AppRun の公開URLはアプリIDから作られるため、破棄して公開し直すと**別のURLになる**。
 * 人に伝えたURLやブックマークは使えなくなり、元のURLには戻せない。
 * URLそのものは長くて読み取れないので出さない。「変わる」という事実だけを伝える
 * （2026-08-09 Ryosuke の指定）。
 */
export function urlChangesOnTeardownNotice(): string {
  return `公開URLは元に戻せません。破棄したあとに公開し直すと別のURLになるため、`
    + `いま公開しているURLを誰かに伝えている場合は、届かなくなります。`
}

/** 破棄で消えるものの一覧（画面表示用）。レジストリを外したときは並びから消える。 */
export function teardownTargets(opts: { hasBucket: boolean; deleteRegistry: boolean; registryName: string | null }): string[] {
  const out = ['AppRun アプリ']
  if (opts.deleteRegistry) {
    out.push(`コンテナレジストリ${opts.registryName ? `『${opts.registryName}』` : ''}（push用ユーザー・登録済みイメージごと）`)
  }
  if (opts.hasBucket) out.push('バケット（データ）')
  return out
}

/**
 * 破棄後に「まだ課金が続くもの」があるかの注意文。無ければ null。
 *
 * ── 保存場所を数に入れる理由（2026-08-14）──────────────────────────────
 * 保存場所は**破棄しても残ることがある**（ほかのプロジェクトが使っている・利用者が
 * 自分で置いたファイルがある場合。src/shared/objectStorage.ts の3段構え）。
 * つまり「破棄したのに月額495円が続く」が正常な結果として起こりうる。
 * **それを黙っていると、消したつもりの費用が請求書に出続ける。**
 */
export function remainingCostWarning(opts: {
  deleteRegistry: boolean
  registryName: string | null
  /** 破棄したのに保存場所が残ったか（残った場合のみ名前を渡す）。 */
  keptBucketName?: string | null
}): string | null {
  const parts: string[] = []
  let total = 0
  if (!opts.deleteRegistry) {
    total += REGISTRY_MONTHLY_YEN
    parts.push(`コンテナレジストリ${opts.registryName ? `『${opts.registryName}』` : ''}`)
  }
  if (opts.keptBucketName) {
    total += BUCKET_MONTHLY_YEN
    parts.push(`データの保存場所『${opts.keptBucketName}』`)
  }
  if (parts.length === 0) return null
  return `⚠️ ${parts.join('と')}は残るため、月額${total}円（税込）の課金は続きます。`
}
